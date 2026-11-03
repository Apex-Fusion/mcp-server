// packages/builder/test/vault-tools.test.ts
// Handler-level tests of the vault tools (Part 2 Sections 5.3 and 10): open, pay and close through a fake server, on identity-world's
// node (the real applied vault script runs) with global fetch as the fake of Koios and the indexer. The tools build against the clock,
// so the delegation's period is stated relative to Date.now().
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { registerVaultTools } from '../src/vector/vault-tools.ts';
import { rateGate } from '../src/vector/marketplace-shared.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { IdentityConfigError, NOT_CONFIGURED } from '../src/vector/identity-deployment.ts';
import { DEPLOYMENT, DAY, OWN_ADDRESS, identityWorld } from './fixtures/identity-world.ts';
import {
  ADVERT_REF, AGENT_DID, DELEGATE_KEY, DELEGATION_ID, OWN_PKH, PAYLOAD, advertUtxo, agentRecord, chainFake, delegateRecord, delegation, delegationUtxo,
  listedRow, liveVault, vaultUtxo,
} from './fixtures/escrow-identity.fixture.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
let node: Provider | undefined;
function tools(deployment: () => typeof DEPLOYMENT = () => DEPLOYMENT) {
  const handlers = new Map<string, Handler>();
  const server = { tool: (name: string, _d: string, _s: unknown, handler: Handler) => { handlers.set(name, handler); } } as unknown as McpServer;
  registerVaultTools(server, rateGate(new RateLimiter(100_000)), () => { if (!node) throw new Error('no node'); return node; }, deployment);
  return async (name: string, args: Record<string, unknown>) => (await handlers.get(name)!(args)).content[0].text;
}
const call = tools();
const jsonOf = (t: string) => JSON.parse(t.slice(t.lastIndexOf('```json\n') + 8, t.lastIndexOf('\n```')));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; node = undefined; });
/** A delegation that runs now. */
const current = () => delegationUtxo(delegation({ notBefore: Date.now() - DAY, notAfter: Date.now() + 30 * DAY }));
const VAULT_REF = `${'fa'.repeat(32)}#0`;

describe('the vault tools', () => {
  test('vector_build_vault_open: the wallet key owns the vault for its delegation', async () => {
    node = identityWorld([current()]);
    const t = await call('vector_build_vault_open', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, amount: 40 });
    assert.ok(t.startsWith('# Vault Opening Built (Unsigned, Not Submitted)\n'), t.slice(0, 400));
    const j = jsonOf(t);
    assert.deepEqual([j.vault_ref, j.amount_lovelace, j.per_tx, j.total], [`${j.tx_hash}#0`, '40000000', '50000000', '100000000']);
    assert.match(t, /\*\*Owner:\*\* principal key [0-9a-f]{56}/);
    assert.match(await call('vector_build_vault_open', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, amount: 40, owner_did: AGENT_DID }), /^Failed to build vault opening: The delegator of delegation .* not the owner agent/);
  });
  test('vector_build_vault_pay: the delegate key signs, the escrow is output 0 and the vault output 1', async () => {
    node = identityWorld([vaultUtxo(liveVault()), current(), delegateRecord(), agentRecord()]);
    globalThis.fetch = chainFake({ live: [advertUtxo()], listed: [listedRow()] }).f;
    const t = await call('vector_build_vault_pay', { changeAddress: OWN_ADDRESS, vault_ref: VAULT_REF, advert_ref: ADVERT_REF, payload: PAYLOAD });
    assert.ok(t.startsWith('# Vault Payment Built (Unsigned, Not Submitted)\n'), t.slice(0, 600));
    const j = jsonOf(t);
    assert.deepEqual([j.escrow_ref, j.vault_ref, j.did, j.new_period, j.payload], [`${j.tx_hash}#0`, `${j.tx_hash}#1`, AGENT_DID, true, PAYLOAD]);
    assert.deepEqual(j.required_signers.map((s: { key_hash: string }) => s.key_hash), [DELEGATE_KEY.keyHash, OWN_PKH]);
    assert.match(t, /Each key holder in the list signs in turn/);
  });
  test('vector_build_vault_close: the owner closes; a wrong ref is a text refusal', async () => {
    node = identityWorld([vaultUtxo({ type: 'Returned', owner: { type: 'PrincipalKey', hash: OWN_PKH, organisation: null } }, 3_000_000n)]);
    const t = await call('vector_build_vault_close', { changeAddress: OWN_ADDRESS, vault_refs: [VAULT_REF] });
    assert.ok(t.startsWith('# Vault Close Built (Unsigned, Not Submitted)\n'), t.slice(0, 400));
    assert.deepEqual(jsonOf(t).vaults, [{ vault_ref: VAULT_REF, kind: 'Returned', lovelace: '3000000' }]);
    assert.match(await call('vector_build_vault_close', { changeAddress: OWN_ADDRESS, vault_refs: [`${'fb'.repeat(32)}#0`] }), /^Failed to build vault close: Vault .* is not an unspent output on the node/);
  });
  test('without a deployment every vault tool says which variables to set', async () => {
    const unconfigured = tools(() => { throw new IdentityConfigError(NOT_CONFIGURED); });
    node = identityWorld([]);
    for (const [name, args] of [
      ['vector_build_vault_open', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, amount: 40 }],
      ['vector_build_vault_pay', { changeAddress: OWN_ADDRESS, vault_ref: VAULT_REF, advert_ref: ADVERT_REF, payload: PAYLOAD }],
      ['vector_build_vault_close', { changeAddress: OWN_ADDRESS, vault_refs: [VAULT_REF] }],
    ] as const) assert.match(await unconfigured(name, args), /VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/, name);
  });
});

describe('the vault script address of the deployment', () => {
  test('is the applied vault script\'s enterprise address', () => {
    assert.match(DEPLOYMENT.vault.address, /^addr1w/);
    assert.equal(liveVault().type, 'Live');
  });
});
