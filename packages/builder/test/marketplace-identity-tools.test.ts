// packages/builder/test/marketplace-identity-tools.test.ts
// Handler-level tests of the marketplace tools in the identity layout (Part 2 Sections 6 and 10): a fake server captures the handlers,
// the node is identity-world's FixtureProvider (the real applied scripts run), and global fetch is the one fake of Koios and the
// indexer (escrow-identity.fixture.ts). The tools build against the clock, so every escrow here is stated relative to Date.now().
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMarketplaceTools } from '../src/vector/marketplace.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { canonicalize, sha256Utf8Hex } from '../src/vector/marketplace-datum.ts';
import { getJob } from '../src/vector/marketplace-transport.ts';
import { DEPLOYMENT, LISTED, OWN_ADDRESS, identityWorld } from './fixtures/identity-world.ts';
import {
  ADVERT_REF, AGENT_ID, AGENT_DID, CHAIN_TXS, CLAIM_TX, ESCROW_LOCK, ESCROW_REF, IDENTITY_ADVERT, OWN_PKH, PAYLOAD, POST_TX, SUBMIT_TX, SUPPLIER_PKH,
  advertUtxo, agentRecord, chainFake, escrowUtxo, identityEscrow, listedRow, submitted, supplierEnterprise,
} from './fixtures/escrow-identity.fixture.ts';
import type { IdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const serverOf = (into: Map<string, Handler>) => ({ tool: (name: string, _d: string, _s: unknown, handler: Handler) => { into.set(name, handler); } }) as unknown as McpServer;
let node: Provider | undefined;
function tools(deployment: typeof DEPLOYMENT | null = DEPLOYMENT) {
  const handlers = new Map<string, Handler>();
  registerMarketplaceTools(serverOf(handlers), 'marketplace-identity-tools-test', () => { if (!node) throw new Error('no node'); return node; }, new RateLimiter(100_000), () => deployment);
  return async (name: string, args: Record<string, unknown>) => (await handlers.get(name)!(args)).content[0].text;
}
const call = tools();
const jsonOf = (t: string) => JSON.parse(t.slice(t.lastIndexOf('```json\n') + 8, t.lastIndexOf('\n```')));
const lineOf = (t: string, label: string) => t.split('\n').find((l) => l.startsWith(label));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; node = undefined; });
const supplierWallet: UTxO = { txHash: '08'.repeat(32), outputIndex: 0, address: supplierEnterprise, assets: { lovelace: 100_000_000n } };

describe('the supplier list and the advert show the agent DID', () => {
  test('vector_marketplace_list_suppliers: a DID column and agent_id/did in the JSON; a legacy row has none', async () => {
    const legacyRow = listedRow(`${'0b'.repeat(32)}#0`, null, { price_lovelace: '3000000' });
    globalThis.fetch = chainFake({ listed: [listedRow(), legacyRow, listedRow(`${'0c'.repeat(32)}#0`, 'NOT-AN-ID', { price_lovelace: '4000000' })] }).f;
    const t = await call('vector_marketplace_list_suppliers', { only_free: true, limit: 20 });
    const rows = t.split('\n').filter((l) => l.startsWith('| `'));
    assert.equal(rows.length, 3);
    assert.ok(rows[0].includes(`| ${AGENT_DID} |`));
    assert.ok(rows[1].includes(' | - | ') && rows[2].includes(' | - | '), 'no DID for a legacy row, nor for an agent_id that is not an identifier');
    for (const r of rows) assert.equal(r.split(' | ').length, 10);
    const j = jsonOf(t);
    assert.deepEqual(j.map((s: { agent_id: string | null; did: string | null }) => [s.agent_id, s.did]), [[AGENT_ID, AGENT_DID], [null, null], [null, null]]);
  });
  test('vector_marketplace_get_supplier reads an identity advert at the deployment\'s advert address and shows its agent DID', async () => {
    globalThis.fetch = chainFake({ live: [advertUtxo()] }).f;
    const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
    assert.equal(lineOf(t, '- **Agent DID:**'), `- **Agent DID:** ${AGENT_DID} (identity-marketplace advert: its agent's record lists the supplier key and the capability)`);
    assert.deepEqual([jsonOf(t).layout, jsonOf(t).agent_id, jsonOf(t).did], ['identity', AGENT_ID, AGENT_DID]);
    const unconfigured = await tools(null)('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
    assert.match(unconfigured, /holds an identity-marketplace advert\. The identity registry is not configured/);
  });
});

describe('the escrow tools in the identity layout', () => {
  test('vector_build_marketplace_post_escrow: the identity escrow with the agent line, the layout, the DID and the signers', async () => {
    node = identityWorld([agentRecord()]);
    globalThis.fetch = chainFake({ live: [advertUtxo()], listed: [listedRow()] }).f;
    const t = await call('vector_build_marketplace_post_escrow', { changeAddress: OWN_ADDRESS, advert_ref: ADVERT_REF, payload: PAYLOAD });
    assert.ok(t.startsWith('# Unsigned Escrow Post Built (Not Submitted)\n'), t.slice(0, 300));
    assert.equal(lineOf(t, '**Agent:**'), `**Agent:** ${AGENT_DID} (the escrow names it; its receipt must name it too)`);
    assert.match(t, /anybody may Reclaim after .*, and everything returns to your address; if the agent's record is revoked or retired first, anybody may return everything at once with vector_build_marketplace_refund_revoked\./);
    const j = jsonOf(t);
    assert.deepEqual([j.layout, j.agent_id, j.did], ['identity', AGENT_ID, AGENT_DID]);
    assert.deepEqual(j.required_signers, [{ key_hash: OWN_PKH, roles: ['buyer (wallet: inputs, fee and collateral)'] }]);
  });
  test('vector_build_marketplace_reclaim: anybody, a full refund to the escrow\'s refund address', async () => {
    const posted = identityEscrow(Date.now() - 3_600_000);
    const live = escrowUtxo(POST_TX, posted);
    node = identityWorld([live, supplierWallet]);
    globalThis.fetch = chainFake({ live: [live] }).f;
    const t = await call('vector_build_marketplace_reclaim', { changeAddress: supplierEnterprise, escrow_ref: ESCROW_REF });
    assert.equal(lineOf(t, '**Returned:**'), `**Returned:** ${(Number(ESCROW_LOCK) / 1e6).toFixed(6)}: everything the escrow holds, to its refund address ${OWN_ADDRESS}; anybody may submit this Reclaim`);
    assert.deepEqual([jsonOf(t).full_refund, jsonOf(t).layout, jsonOf(t).agent_did], [true, 'identity', AGENT_DID]);
    assert.deepEqual(jsonOf(t).required_signers.map((s: { key_hash: string }) => s.key_hash), [SUPPLIER_PKH], 'only the wallet, for its inputs');
  });
  const afterSubmit = (submittedAt: number, extra: UTxO[] = [], over: Partial<IdentityEscrowDatum> = {}) => {
    const posted = identityEscrow(submittedAt - 300_000);
    const d = { ...submitted(posted, submittedAt), ...over };
    const live = escrowUtxo(SUBMIT_TX, d);
    node = identityWorld([live, agentRecord(), ...extra]);
    globalThis.fetch = chainFake({ live: [live], spent: [escrowUtxo(POST_TX, posted), escrowUtxo(CLAIM_TX, { ...posted, state: 'Claimed' })], txs: CHAIN_TXS }).f;
    return d;
  };
  test('vector_build_marketplace_accept of an identity escrow names the agent and lists the buyer as signer', async () => {
    afterSubmit(Date.now() - 60_000);
    const t = await call('vector_build_marketplace_accept', { changeAddress: OWN_ADDRESS, escrow_ref: ESCROW_REF });
    assert.ok(t.startsWith('# Unsigned Accept Built (Not Submitted)\n'), t.slice(0, 400));
    assert.equal(lineOf(t, '**Agent:**'), `**Agent:** ${AGENT_DID} (the escrow names it; its receipt must name it too)`);
    assert.equal(lineOf(t, '**Your bond back:**'), '**Your bond back:** 1.000000');
    assert.deepEqual(jsonOf(t).required_signers, [{ key_hash: OWN_PKH, roles: ['buyer', 'wallet (inputs, fee and collateral)'] }]);
  });
  test('vector_build_marketplace_release: the supplier releases after the accept window (buildText answer)', async () => {
    afterSubmit(Date.now() - 20 * 60_000, [supplierWallet]);
    const t = await call('vector_build_marketplace_release', { changeAddress: supplierEnterprise, escrow_ref: ESCROW_REF });
    assert.ok(t.startsWith('# Escrow Release Built (Unsigned, Not Submitted)\n'), t.slice(0, 400));
    const j = jsonOf(t);
    assert.deepEqual([j.layout, j.agent_did, j.supplier_lovelace], ['identity', AGENT_DID, '4000000']);
    assert.deepEqual(j.required_signers.map((s: { key_hash: string }) => s.key_hash), [SUPPLIER_PKH]);
    assert.match(await call('vector_build_marketplace_release', { changeAddress: OWN_ADDRESS, escrow_ref: ESCROW_REF }), /^Failed to build release: This escrow was posted for another supplier key/);
  });
  test('vector_build_marketplace_refund_revoked: refuses an Active agent; builds for a revoked one; needs the deployment', async () => {
    const posted = identityEscrow(Date.now() - 600_000);
    const live = escrowUtxo(POST_TX, posted);
    globalThis.fetch = chainFake({ live: [live] }).f;
    node = identityWorld([live, agentRecord()]);
    assert.match(await call('vector_build_marketplace_refund_revoked', { changeAddress: OWN_ADDRESS, escrow_ref: ESCROW_REF }), /^Failed to build refund of a revoked agent: RefundRevoked is not allowed: the escrow is Open and the agent's record is Active/);
    const revoked = agentRecord({ keys: [], parties: [], description: '', framework: '', endpoint: '', capabilities: [], status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: Date.now() - 1000, invalidFrom: Date.now() - 1000, successor: null } });
    node = identityWorld([live, revoked]);
    const t = await call('vector_build_marketplace_refund_revoked', { changeAddress: OWN_ADDRESS, escrow_ref: ESCROW_REF });
    assert.ok(t.startsWith('# RefundRevoked Built (Unsigned, Not Submitted)\n'), t.slice(0, 400));
    assert.deepEqual([jsonOf(t).record_status, jsonOf(t).buyer_address, jsonOf(t).buyer_lovelace], ['Revoked', OWN_ADDRESS, String(ESCROW_LOCK)]);
    assert.match(await tools(null)('vector_build_marketplace_refund_revoked', { changeAddress: OWN_ADDRESS, escrow_ref: ESCROW_REF }), /The identity registry is not configured on this server/);
  });
  test('vector_marketplace_verify_receipt of an identity escrow: the 9-field receipt with the agent DID passes every row', async () => {
    const sk = CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, 2)); // LISTED, the supplier key of identity-world
    const receipt = {
      prompt_hash: identityEscrow(0).prompt_hash, response_hash: sha256Utf8Hex('42 words'), model: 'echo-v1', prompt_tokens: 1, completion_tokens: 1, wallclock_ms: 5,
      supplier_pkh: SUPPLIER_PKH, escrow_ref: ESCROW_REF, agent_did: AGENT_DID,
    };
    const signature = sk.sign(Buffer.from(canonicalize(receipt), 'utf8')).to_hex();
    afterSubmit(Date.now() - 60_000, [], { result_receipt_hash: sha256Utf8Hex(canonicalize({ receipt, signature })) });
    const t = await call('vector_marketplace_verify_receipt', { escrow_ref: ESCROW_REF, receipt, receipt_signature: signature, result: '42 words', supplier_pub_key_hex: LISTED.publicKey });
    const j = jsonOf(t);
    assert.equal(j.verdict, 'verified', t);
    assert.deepEqual([j.layout, j.agent_did, j.checks.fields_match], ['identity', AGENT_DID, 'pass']);
    assert.equal(lineOf(t, '**Agent (from the escrow):**'), `**Agent (from the escrow):** ${AGENT_DID}`);
    const { agent_did: _dropped, ...eight } = receipt;
    const eightSig = sk.sign(Buffer.from(canonicalize(eight), 'utf8')).to_hex();
    const failedEight = jsonOf(await call('vector_marketplace_verify_receipt', { escrow_ref: ESCROW_REF, receipt: eight, receipt_signature: eightSig, result: '42 words', supplier_pub_key_hex: LISTED.publicKey }));
    assert.equal(failedEight.checks.fields_match, 'fail');
  });
});

describe('the transport reads an identity escrow and its advert', () => {
  test('getJob polls the endpoint of the identity advert that names the escrow\'s agent', async () => {
    const posted = identityEscrow(Date.now() - 600_000);
    const live = escrowUtxo(POST_TX, posted);
    const endpoint = 'https://203.0.113.9';
    const advert = advertUtxo({ ...IDENTITY_ADVERT, endpoint_url: endpoint });
    const chain = chainFake({ live: [live, advert], txs: { [POST_TX]: [[`${'0a'.repeat(32)}#0`, OWN_ADDRESS]] } });
    const asked: string[] = [];
    const f = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(endpoint)) { asked.push(url); return new Response(JSON.stringify({ status: 'working' }), { status: 202 }); }
      return chain.f(input as string, init);
    }) as typeof fetch;
    const r = await getJob('https://koios.example', { escrowRef: ESCROW_REF, jobId: 'job-1', buyerAddress: OWN_ADDRESS, deployment: DEPLOYMENT }, f);
    assert.equal(r.view.state, 'pending');
    assert.deepEqual(asked, [`${endpoint}/v1/job/job-1`]);
    const otherAgent = advertUtxo({ ...IDENTITY_ADVERT, endpoint_url: endpoint, agent_id: 'bf'.repeat(32) });
    const wrong = chainFake({ live: [live, otherAgent], txs: { [POST_TX]: [[`${'0a'.repeat(32)}#0`, OWN_ADDRESS]] } });
    await assert.rejects(getJob('https://koios.example', { escrowRef: ESCROW_REF, jobId: 'job-1', buyerAddress: OWN_ADDRESS, deployment: DEPLOYMENT }, wrong.f), /names another agent than the escrow/);
  });
});

describe('the identity advert tools', () => {
  const advertArgs = {
    changeAddress: supplierEnterprise, did: AGENT_DID, capability_id: IDENTITY_ADVERT.capability_id, model: 'echo-v1', max_output_tokens: 256,
    max_processing_ms: 180_000, price_lovelace: 2_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, endpoint_url: 'https://agent.example',
  };
  // The shared fixture advert's 60,000 ms window is below what a supplier template serves; an update starts from an advert the tools could post.
  const hireable = () => advertUtxo({ ...IDENTITY_ADVERT, max_processing_ms: 180_000 });
  test('advert post, update and retire build with the supplier key as a signer (buildText answers)', async () => {
    node = identityWorld([agentRecord(), supplierWallet, hireable()]);
    const posted = await call('vector_build_marketplace_advert_post', advertArgs);
    assert.ok(posted.startsWith('# Advert Post Built (Unsigned, Not Submitted)\n\n**Layout:** identity (the advert names its agent)\n'), posted.slice(0, 400));
    assert.match(posted, /\*\*Supplier runtime:\*\* once this confirms, set your supplier runtime's ADVERT_REF to this advert_ref and restart it/);
    assert.deepEqual([jsonOf(posted).layout, jsonOf(posted).did, jsonOf(posted).status, jsonOf(posted).required_signers[0].key_hash], ['identity', AGENT_DID, 'Active', SUPPLIER_PKH]);
    const updated = await call('vector_build_marketplace_advert_update', { changeAddress: supplierEnterprise, advert_ref: ADVERT_REF, price_lovelace: 2_500_000 });
    assert.ok(updated.startsWith('# Advert Update Built (Unsigned, Not Submitted)\n'), updated.slice(0, 400));
    assert.ok(updated.includes(`**Replaces:** \`${ADVERT_REF}\`\n`));
    assert.equal(jsonOf(updated).spent_ref, ADVERT_REF);
    const retired = await call('vector_build_marketplace_advert_retire', { changeAddress: supplierEnterprise, advert_ref: ADVERT_REF });
    assert.ok(retired.startsWith('# Advert Retirement Built (Unsigned, Not Submitted)\n\n**Layout:** identity (the advert names its agent)\n'), retired.slice(0, 400));
    assert.deepEqual([jsonOf(retired).layout, jsonOf(retired).spent_ref, jsonOf(retired).paid_to], ['identity', ADVERT_REF, supplierEnterprise]);
  });
  test('the terms rules of both layouts apply: a window a supplier template cannot serve and an endpoint with a query are refused', async () => {
    node = identityWorld([agentRecord(), supplierWallet, hireable()]);
    assert.match(await call('vector_build_marketplace_advert_post', { ...advertArgs, max_processing_ms: 60_000 }), /^Failed to build advert post: max_processing_ms must be a whole number from 60001/);
    assert.match(await call('vector_build_marketplace_advert_post', { ...advertArgs, endpoint_url: 'https://agent.example/?k=1' }), /^Failed to build advert post: endpoint_url must not contain a query/);
    assert.match(await call('vector_build_marketplace_advert_update', { changeAddress: supplierEnterprise, advert_ref: ADVERT_REF, max_processing_ms: 60_000 }), /^Failed to build advert update: max_processing_ms must be a whole number from 60001/);
  });
  test('a detail_uri needs its detail_hash, and the post and the update need the deployment; the retire of an identity advert too', async () => {
    node = identityWorld([agentRecord(), supplierWallet, hireable()]);
    assert.match(await call('vector_build_marketplace_advert_post', { ...advertArgs, detail_uri: 'https://agent.example/manifest.json' }), /^Failed to build advert post: detail_hash is required with a detail_uri/);
    assert.match(await tools(null)('vector_build_marketplace_advert_post', advertArgs), /The identity registry is not configured on this server/);
    assert.match(await tools(null)('vector_build_marketplace_advert_update', { changeAddress: supplierEnterprise, advert_ref: ADVERT_REF, price_lovelace: 2_500_000 }), /The identity registry is not configured on this server/);
    assert.match(await tools(null)('vector_build_marketplace_advert_retire', { changeAddress: supplierEnterprise, advert_ref: ADVERT_REF }), /^Failed to build advert retirement: UTxO [0-9a-f]{64}#0 is not at the legacy advert address, and this server cannot read an identity-marketplace advert\. The identity registry is not configured on this server/);
  });
});
