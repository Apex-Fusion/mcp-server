// packages/builder/test/advert-stake-tools.test.ts
// Handler-level tests for the four supplier-side tools: the advert Post and Retire (registered with the marketplace family) and the two
// reputation stake steps. A minimal fake server captures the handlers, Koios is a stubbed global fetch, and the node is a fixture handed
// in as the provider argument, as in marketplace-tools.test.ts; the stake and Retire nodes evaluate the deployed validators
// (uplc-node.fixture.ts). No network is touched. (Schemas and descriptions are covered by the smoke suite.)
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMarketplaceTools } from '../src/vector/marketplace.ts';
import { registerReputationTools } from '../src/vector/reputation-tools.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { ADVERT_ADDRESS } from '../src/vector/marketplace-constants.ts';
import { decodeAdvertDatum } from '../src/vector/marketplace-datum.ts';
import { stakeTokenUnit, VECTOR_MAINNET_ZERO_TIME_MS } from '../src/vector/reputation-build.ts';
import { SIGN_COPY } from '../src/vector/marketplace-shared.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';
import { uplcEvaluatingProvider } from './fixtures/uplc-node.fixture.ts';
import {
  ADVERT_POSTS, ADVERT_RETIRE, ADVERT_REF_UTXO_BARE, ADVERT_SCRIPT_CBOR, STAKE_A, PARAMS_UTXO, CROSS_REFS_UTXO, REPUTATION_REF_UTXO_BARE,
  REPUTATION_SCRIPT_CBOR,
} from './fixtures/advert-stake-golden.fixture.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const serverOf = (into: Map<string, Handler>) => ({ tool: (name: string, _description: string, _shape: unknown, handler: Handler) => { into.set(name, handler); } }) as unknown as McpServer;
let node: Provider | undefined;
const nodeOfTheTest = (): Provider => { if (!node) throw new Error('this test set no node'); return node; };
const handlers = new Map<string, Handler>();
registerMarketplaceTools(serverOf(handlers), 'advert-stake-tools-test', nodeOfTheTest, new RateLimiter(100_000));
registerReputationTools(serverOf(handlers), 'advert-stake-tools-test', nodeOfTheTest, new RateLimiter(100_000));
const callOn = (registered: Map<string, Handler>) => async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const h = registered.get(name);
  assert.ok(h, `${name} is registered`);
  const out = await h(args);
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'text');
  return out.content[0].text;
};
const call = callOn(handlers);
const JSON_FENCE = '\n```json\n';
const jsonOf = (t: string) => JSON.parse(t.slice(t.lastIndexOf(JSON_FENCE) + JSON_FENCE.length, t.lastIndexOf('\n```')));

const realFetch = globalThis.fetch;
let requested: string[] = [];
/** Koios answers utxo_info with `rows`; any other URL is unexpected. */
const stubKoios = (rows: unknown[]) => {
  requested = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/api/v1/utxo_info')) return new Response(JSON.stringify(rows));
    return new Response(JSON.stringify({ unexpected: url }), { status: 500 });
  }) as typeof fetch;
};
// Every test starts with a fetch that reaches nothing and records what was asked, so a change that makes a tool fetch fails here
// instead of calling the live network; a test that needs Koios replaces it with stubKoios.
beforeEach(() => {
  requested = [];
  globalThis.fetch = (async (input: unknown) => { requested.push(String(input)); throw new Error('the network was touched'); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; node = undefined; });

const ADVOCATE = decodeAdvertDatum(ADVERT_POSTS[4].datumHex);
const SUPPLIER_ADDRESS = ADVERT_POSTS[4].tx.outputs[1].address;
const supplierWallet: UTxO[] = [
  { txHash: 'aa'.repeat(32), outputIndex: 0, address: SUPPLIER_ADDRESS, assets: { lovelace: 30_000_000n } },
  { txHash: 'aa'.repeat(32), outputIndex: 1, address: SUPPLIER_ADDRESS, assets: { lovelace: 5_000_000n } },
];
const postArgs = (over: Record<string, unknown> = {}) => ({
  changeAddress: SUPPLIER_ADDRESS, capability_id: ADVOCATE.capability_id, model: ADVOCATE.model, max_output_tokens: ADVOCATE.max_output_tokens,
  max_processing_ms: ADVOCATE.max_processing_ms, price_lovelace: Number(ADVOCATE.price_lovelace), supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000,
  endpoint_url: ADVOCATE.endpoint_url, detail_uri: ADVOCATE.detail_uri, detail_hash: ADVOCATE.detail_hash, ...over,
});

describe('vector_build_marketplace_post_advert', () => {
  test('shows who the supplier is, what a job locks, the deposit and the deadline, and returns the unsigned transaction and its JSON', async () => {
    stubKoios([]);
    node = new FixtureProvider(supplierWallet);
    const t = await call('vector_build_marketplace_post_advert', postArgs());
    assert.ok(t.startsWith('# Unsigned Advert Post Built (Not Submitted)\n'), t.slice(0, 200));
    const j = jsonOf(t);
    assert.match(t, new RegExp(`\\*\\*Advert ref \\(after submit\\):\\*\\* \`${j.tx_hash}#0\``));
    assert.match(t, new RegExp(`\\*\\*Supplier key:\\*\\* \`${ADVOCATE.supplier_pkh}\` \\(the key of changeAddress; only it can retire the advert\\)`));
    assert.match(t, /\*\*Per job:\*\* a buyer locks price 3\.000000 \+ supplier bond 1\.000000 \+ buyer bond 1\.000000; on Accept the supplier receives price \+ supplier bond and the buyer bond returns to the buyer/);
    assert.match(t, /\*\*Deposit locked:\*\* 2\.000000 \(returns to you when you retire the advert with vector_build_marketplace_retire_advert\)/);
    assert.match(t, /\(as given\)/);
    assert.match(t, /\*\*Supplier runtime:\*\* once this confirms, set your supplier runtime's ADVERT_REF to this advert_ref and restart it: the supplier template serves only the advert ADVERT_REF names \(after a Retire and a new Post, ADVERT_REF must change to the new ref\)\./);
    assert.ok(t.includes(SIGN_COPY));
    assert.equal(j.advert_ref, `${j.tx_hash}#0`);
    assert.equal(j.supplier_pkh, ADVOCATE.supplier_pkh);
    assert.equal(j.deposit_lovelace, '2000000');
    assert.equal(j.detail_hash_source, 'given');
    assert.equal(j.collateral_kept, true);
    assert.deepEqual(requested, [], 'nothing is fetched');
  });
  test('text that comes back from the caller is escaped in the markdown and verbatim in the JSON', async () => {
    node = new FixtureProvider(supplierWallet);
    const t = await call('vector_build_marketplace_post_advert', postArgs({ capability_id: 'research.a|b.v1', model: 'm`x' }));
    assert.match(t, /\*\*Capability:\*\* `research\.a¦b\.v1`, model `m'x`/);
    assert.equal(jsonOf(t).capability_id, 'research.a|b.v1');
    assert.deepEqual(requested, []);
  });
  test('a refusal says what to fix and builds nothing', async () => {
    node = new FixtureProvider(supplierWallet);
    const t = await call('vector_build_marketplace_post_advert', postArgs({ capability_id: 'llm.chat.v1' }));
    assert.match(t, /^Failed to build advert post: capability_id llm\.chat\.v1 is in a fleet namespace/);
    assert.match(t, /\*\*Troubleshooting Tips:\*\*\n1\. capability_id, model, endpoint_url and detail_uri each hold at most 64 bytes of UTF-8; endpoint_url and detail_uri must be https URLs, and endpoint_url has no whitespace, query or fragment\n2\. The wallet needs the deposit/);
    assert.ok(!t.includes('Unsigned TX CBOR'));
    assert.deepEqual(requested, []);
  });
  test('a detail_uri without its hash is refused, "" included, and nothing is fetched', async () => {
    node = new FixtureProvider(supplierWallet);
    for (const detail_hash of [undefined, '']) {
      const t = await call('vector_build_marketplace_post_advert', postArgs({ detail_hash }));
      assert.match(t, /^Failed to build advert post: detail_hash is required with a detail_uri/);
    }
    const none = jsonOf(await call('vector_build_marketplace_post_advert', postArgs({ detail_uri: '', detail_hash: '' })));
    assert.equal(none.detail_hash_source, 'empty');
    assert.deepEqual(requested, []);
  });
});

const ZERO = VECTOR_MAINNET_ZERO_TIME_MS;
const RETIRE_REF = `${ADVERT_RETIRE.advert.txHash}#0`;
const advertRow = () => ({ tx_hash: ADVERT_RETIRE.advert.txHash, tx_index: 0, address: ADVERT_ADDRESS, value: '2017080', is_spent: false, inline_datum: { bytes: ADVERT_RETIRE.advert.datum } });
const advertScript: UTxO = { ...ADVERT_REF_UTXO_BARE, scriptRef: { type: 'PlutusV3', script: ADVERT_SCRIPT_CBOR } };
const nowSlot = () => Math.floor((Date.now() - ZERO) / 1000);

describe('vector_build_marketplace_retire_advert', () => {
  test('shows the advert and the deposit that returns; the deployed validator accepts the transaction', async () => {
    stubKoios([advertRow()]);
    const n = uplcEvaluatingProvider([ADVERT_RETIRE.wallet, ADVERT_RETIRE.advert, advertScript], nowSlot());
    node = n;
    const t = await call('vector_build_marketplace_retire_advert', { changeAddress: ADVERT_RETIRE.wallet.address, advert_ref: RETIRE_REF });
    assert.ok(t.startsWith('# Unsigned Advert Retire Built (Not Submitted)\n'), t.slice(0, 300));
    assert.match(t, new RegExp(`\\*\\*Advert:\\*\\* \`${RETIRE_REF}\` \\(\`audio\\.transcript\\.snippets\\.v1\`\\)`));
    assert.match(t, /\*\*Deposit returned to you:\*\* 2\.017080/);
    assert.match(t, /\*\*Supplier runtime:\*\* after this confirms, its ADVERT_REF names a consumed advert; to list the supplier again, post a new advert with vector_build_marketplace_post_advert and set ADVERT_REF to the new advert_ref\./);
    const j = jsonOf(t);
    assert.equal(j.advert_ref, RETIRE_REF);
    assert.equal(j.return_lovelace, '2017080');
    assert.equal(n.evaluations.length, 1);
  });
  test('another key is refused with the supplier key named', async () => {
    stubKoios([advertRow()]);
    node = uplcEvaluatingProvider([{ ...ADVERT_RETIRE.wallet, address: STAKE_A.ownerAddress }, ADVERT_RETIRE.advert, advertScript], nowSlot());
    const t = await call('vector_build_marketplace_retire_advert', { changeAddress: STAKE_A.ownerAddress, advert_ref: RETIRE_REF });
    assert.match(t, /^Failed to build advert retire: This advert names supplier key [0-9a-f]{56}, not the key of changeAddress; only its supplier can retire it\./);
  });
});

const refScript: UTxO = { ...REPUTATION_REF_UTXO_BARE, scriptRef: { type: 'PlutusV3', script: REPUTATION_SCRIPT_CBOR } };
const stakeNode = (extra: UTxO[] = []) => uplcEvaluatingProvider([STAKE_A.wallet, STAKE_A.registry, PARAMS_UTXO, CROSS_REFS_UTXO, refScript, ...extra], nowSlot());

describe('vector_build_reputation_stake_open and vector_build_reputation_stake', () => {
  test('step 1 shows the opening ref and what step 2 needs', async () => {
    const wallet: UTxO[] = [{ ...STAKE_A.wallet, txHash: 'ab'.repeat(32) }, { ...STAKE_A.wallet, txHash: 'ab'.repeat(32), outputIndex: 2, assets: { lovelace: 5_000_000n } }];
    node = uplcEvaluatingProvider([...wallet, STAKE_A.registry, PARAMS_UTXO, CROSS_REFS_UTXO, refScript], nowSlot());
    const t = await call('vector_build_reputation_stake_open', { changeAddress: STAKE_A.ownerAddress, agent_id: STAKE_A.agentId, capabilities: STAKE_A.capabilities });
    assert.ok(t.startsWith('# Unsigned Stake Opening Built (Not Submitted), step 1 of 2\n\n**Hold:** Do not use on mainnet until the Module-3 reputation module is fixed and redeployed.\n'), t.slice(0, 300));
    const j = jsonOf(t);
    assert.equal(j.opening_ref, `${j.tx_hash}#0`);
    assert.deepEqual(j.capabilities, STAKE_A.capabilities);
    assert.match(t, /\*\*Locked:\*\* 2\.000000 \(returns as change when step 2 consumes it\)/);
    assert.ok(t.includes(`Once it confirms, call vector_build_reputation_stake with opening_ref \`${j.opening_ref}\` and the same agent_id and capabilities.\n\n${JSON_FENCE.slice(1)}`));
  });
  test('step 2 shows the stake, its token and what locked means; the deployed validator accepts the transaction', async () => {
    const n = stakeNode([STAKE_A.opening]);
    node = n;
    const t = await call('vector_build_reputation_stake', { changeAddress: STAKE_A.ownerAddress, agent_id: STAKE_A.agentId, capabilities: STAKE_A.capabilities, opening_ref: `${STAKE_A.opening.txHash}#0` });
    assert.ok(t.startsWith('# Unsigned Reputation Stake Built (Not Submitted), step 2 of 2\n\n**Hold:** Do not use on mainnet until the Module-3 reputation module is fixed and redeployed.\n'), t.slice(0, 300));
    assert.ok(t.includes(`**Stake locked:** 10.000000 with stake token \`${stakeTokenUnit(STAKE_A.agentDidHex)}\`. As deployed, the owner cannot withdraw a stake at the module's minimum; the module's oracle key can consume all of it through ClaimDecayRefund about 163 s after its last update; and a falsified capability slashes 1/N of it, where N is the number of staked capabilities (all of it when N = 1).\n`));
    assert.match(t, /\*\*Valid until:\*\* \S+ \(sign and submit before then, or build it again\)/);
    const j = jsonOf(t);
    assert.equal(j.stake_ref, `${j.tx_hash}#0`);
    assert.equal(j.stake_lovelace, '10000000');
    assert.equal(j.opening_ref, `${STAKE_A.opening.txHash}#0`);
    assert.equal(n.evaluations.length, 1);
  });
  test('refusals name the rule: a capability the registry record does not list', async () => {
    node = stakeNode([STAKE_A.opening]);
    const t = await call('vector_build_reputation_stake', { changeAddress: STAKE_A.ownerAddress, agent_id: STAKE_A.agentId, capabilities: ['data_analysis'], opening_ref: `${STAKE_A.opening.txHash}#0` });
    assert.match(t, /^Failed to build reputation stake: Capability data_analysis is not in the registry record of did:vector:agent:/);
    assert.match(t, /\*\*Troubleshooting Tips:\*\*\n1\. opening_ref must be the confirmed output/);
  });
});

describe('the rate limit covers the new tools', () => {
  test('a spent limiter answers each of the four with the rate-limit text and touches nothing', async () => {
    const spent = new RateLimiter(1);
    spent.check();
    const limited = new Map<string, Handler>();
    registerMarketplaceTools(serverOf(limited), 'limited', () => { throw new Error('the node was touched'); }, spent);
    registerReputationTools(serverOf(limited), 'limited', () => { throw new Error('the node was touched'); }, spent);
    for (const name of ['vector_build_marketplace_post_advert', 'vector_build_marketplace_retire_advert', 'vector_build_reputation_stake_open', 'vector_build_reputation_stake']) {
      assert.match(await callOn(limited)(name, {}), /^Rate limit exceeded\. Retry after \d+ms\.$/, name);
    }
  });
});
