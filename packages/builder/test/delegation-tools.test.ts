// packages/builder/test/delegation-tools.test.ts
// Handler-level tests of the delegation tools: registerIdentityFamily with a minimal fake server that validates the arguments with
// each tool's zod schema (as the MCP server does) and calls the handler. The node is the offline identity world (identity-world.ts);
// the real delegation script runs on every build. The tools take the time from the clock, so the records count from now. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import type { UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIdentityFamily } from '../src/vector/identity-family.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { encodeDelegationDatum, utf8Hex } from '../src/vector/identity-codec.ts';
import type { DelegationDatum, IdentityDatum } from '../src/vector/identity-codec.ts';
import { HIRE_ACTION, escrowResource } from '../src/vector/delegation-build.ts';
import { DEPLOYMENT, DAY, CONTROLLER, CONTROLLER_ACCOUNTABLE, LISTED, OWN_ADDRESS, identityWorld, recordUtxo, rootRecord, testKey } from './fixtures/identity-world.ts';
import type { FixtureProvider } from './fixtures/fixture-provider.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
type Tool = { shape: z.ZodRawShape; handler: Handler };
const serverOf = (into: Map<string, Tool>) => ({
  tool: (name: string, _description: string, shape: z.ZodRawShape, handler: Handler) => { into.set(name, { shape, handler }); },
}) as unknown as McpServer;

/** The tools of the identity family on `world`; a call checks the arguments against the tool's schema first, as the MCP server does. */
function tools(world: () => FixtureProvider) {
  const registered = new Map<string, Tool>();
  registerIdentityFamily(serverOf(registered), 'delegation-tools-test', world, new RateLimiter(100_000), () => DEPLOYMENT);
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = registered.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const parsed = z.object(tool.shape).safeParse(args);
    if (!parsed.success) return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    return (await tool.handler(parsed.data as Record<string, unknown>)).content[0].text;
  };
}
/** The JSON block of a tool answer. */
const jsonOf = (answer: string): Record<string, unknown> => JSON.parse(answer.slice(answer.lastIndexOf('```json\n') + 8, answer.lastIndexOf('\n```')));
const signersOf = (answer: string): string[] => (jsonOf(answer).required_signers as Array<{ key_hash: string }>).map((s) => s.key_hash);

const T0 = Date.now() - 30 * DAY;
const AGENT_A_ID = 'a1'.repeat(32); // controller CONTROLLER; LISTED has the delegation purpose
const DELEGATE_ID = 'c3'.repeat(32);
const DKEY1 = testKey(11);
const DKEY2 = testKey(12);
const PRINCIPAL = testKey(14);
const PARENT_ID = '9a'.repeat(32);
const DELEGATION_ID = '9c'.repeat(32);
const ESCROW = escrowResource(DEPLOYMENT.escrow.hash);

/** A record that is Active now: its Accountable Party starts 30 days ago. */
const live = (overrides: Partial<IdentityDatum> = {}): IdentityDatum => rootRecord({ parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: T0 }], createdAt: T0, ...overrides });
const AGENT_A = recordUtxo(AGENT_A_ID, live());
const DELEGATE = recordUtxo(DELEGATE_ID, live({
  controller: testKey(10).publicKey, keys: [DKEY1, DKEY2].map((k) => ({ keyType: 'Ed25519' as const, key: k.publicKey, purposes: 16, pop: null })),
}));

let counter = 0;
function delegationUtxo(id: string, overrides: Partial<DelegationDatum> = {}): UTxO {
  counter += 1;
  const datum: DelegationDatum = {
    delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash, organisation: null }, parent: null, delegate: AGENT_A_ID, delegateKey: LISTED.keyHash,
    actions: [utf8Hex('oc.*'), utf8Hex(HIRE_ACTION)], resources: [utf8Hex('*')], notBefore: Date.now() - 10 * DAY, notAfter: Date.now() + 60 * DAY,
    depth: 1, remaining: 2, purpose: null, value: null, ...overrides,
  };
  return { txHash: 'dd'.repeat(32), outputIndex: counter, address: DEPLOYMENT.delegation.address, assets: { lovelace: 1_500_000n, [`${DEPLOYMENT.delegation.hash}${id}`]: 1n }, datum: encodeDelegationDatum(datum) };
}
const PARENT = delegationUtxo(PARENT_ID);
const world = (...extra: UTxO[]) => () => identityWorld([AGENT_A, DELEGATE, ...extra]);
const NOT_AFTER = Date.now() + 30 * DAY;

describe('vector_build_delegation_delegate', () => {
  const call = tools(world(PARENT));

  test('a principal delegates a vault payment right: keys as public keys or key hashes, the datum in the JSON, the signers', async () => {
    const answer = await call('vector_build_delegation_delegate', {
      changeAddress: OWN_ADDRESS, delegate: `did:vector:${DELEGATE_ID}`, delegate_key: DKEY1.publicKey, principal_key: PRINCIPAL.publicKey, organisation: 'example.org',
      actions: [HIRE_ACTION], resources: [ESCROW], not_after: NOT_AFTER, value_limit: { per_tx: 50, total: 500, period_ms: DAY }, purpose: 'ee'.repeat(32),
    });
    assert.match(answer, /# Delegation Built \(Unsigned, Not Submitted\)/);
    const json = jsonOf(answer);
    assert.match(String(json.delegation), /^[0-9a-f]{64}$/);
    assert.deepEqual(json.delegator, { principal_key_hash: PRINCIPAL.keyHash, organisation: 'example.org' });
    assert.equal(json.delegate_did, `did:vector:${DELEGATE_ID}`);
    assert.equal(json.delegate_key_hash, DKEY1.keyHash);
    assert.deepEqual(json.actions, [HIRE_ACTION]);
    assert.deepEqual(json.resources, [ESCROW]);
    assert.deepEqual(json.value_limit, { per_tx_lovelace: '50000000', total_lovelace: '500000000', period_ms: DAY });
    assert.equal(json.depth, 1);
    assert.equal(json.remaining, 0);
    assert.deepEqual(signersOf(answer).slice(0, 2), [PRINCIPAL.keyHash, DKEY1.keyHash]);
    assert.match(answer, /the ledger minimum; undelegate returns it/);
  });

  test('an agent delegator with a delegation key as signer, and a sub-delegation of the parent', async () => {
    const byAgent = await call('vector_build_delegation_delegate', {
      changeAddress: OWN_ADDRESS, delegate: DELEGATE_ID, delegate_key: DKEY1.keyHash, delegator: AGENT_A_ID, delegator_signer: LISTED.publicKey,
      actions: ['ocr.*'], not_after: NOT_AFTER,
    });
    assert.deepEqual(jsonOf(byAgent).delegator, { agent_did: `did:vector:${AGENT_A_ID}` });
    assert.equal(signersOf(byAgent)[0], LISTED.keyHash);
    const sub = await call('vector_build_delegation_delegate', {
      changeAddress: OWN_ADDRESS, delegate: DELEGATE_ID, delegate_key: DKEY2.keyHash, parent: PARENT_ID, actions: ['oc.extract'], resources: [ESCROW], not_after: NOT_AFTER,
    });
    const json = jsonOf(sub);
    assert.equal(json.parent, PARENT_ID);
    assert.equal(json.depth, 2);
    assert.deepEqual(json.delegator, { agent_did: `did:vector:${AGENT_A_ID}` });
    assert.deepEqual(signersOf(sub).slice(0, 2), [LISTED.keyHash, DKEY2.keyHash]);
    assert.match(sub, /sub-delegation of 9a9a/);
  });

  test('input combinations that cannot work are refused before any build', async () => {
    const base = { changeAddress: OWN_ADDRESS, delegate: DELEGATE_ID, delegate_key: DKEY1.keyHash, actions: ['ocr.*'], not_after: NOT_AFTER };
    assert.match(await call('vector_build_delegation_delegate', { ...base, principal_key: PRINCIPAL.keyHash, delegator: AGENT_A_ID }), /Give principal_key or delegator, not both/);
    assert.match(await call('vector_build_delegation_delegate', { ...base, delegator: AGENT_A_ID, organisation: 'example.org' }), /organisation goes only with principal_key/);
    assert.match(await call('vector_build_delegation_delegate', { ...base, parent: PARENT_ID, principal_key: PRINCIPAL.keyHash }), /never a principal key/);
    assert.match(await call('vector_build_delegation_delegate', { ...base, parent: PARENT_ID, delegator: AGENT_A_ID, delegator_signer: 'controller' }), /leave out delegator_signer/);
    assert.match(await call('vector_build_delegation_delegate', { ...base, delegator: AGENT_A_ID, delegator_signer: 'somebody' }), /delegator_signer must be 'controller'/);
    assert.match(await call('vector_build_delegation_delegate', base), /Name the delegator/);
    assert.match(await call('vector_build_delegation_delegate', { ...base, principal_key: 'xyz' }), /^Invalid arguments: principal_key/);
  });

  test('refusals of the contract rules: a narrower child (oc.* does not cover ocr.*) and fresh keys', async () => {
    const wider = await call('vector_build_delegation_delegate', {
      changeAddress: OWN_ADDRESS, delegate: DELEGATE_ID, delegate_key: DKEY1.keyHash, parent: PARENT_ID, actions: ['ocr.*'], not_after: NOT_AFTER,
    });
    assert.match(wider, /^Failed to build delegation: The sub-delegation is wider than its parent .*covers "ocr\.\*"/);
    const used = tools(world(PARENT, delegationUtxo(DELEGATION_ID, { delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash })));
    const reused = await used('vector_build_delegation_delegate', {
      changeAddress: OWN_ADDRESS, delegate: DELEGATE_ID, delegate_key: DKEY1.keyHash, principal_key: PRINCIPAL.keyHash, actions: ['ocr.*'], not_after: NOT_AFTER,
    });
    assert.match(reused, new RegExp(`already uses the delegate key ${DKEY1.keyHash}.*Free delegation keys of did:vector:c3c3[0-9a-f]*: ${DKEY2.keyHash}`));
  });
});

describe('vector_build_delegation_undelegate', () => {
  test("the delegator's key by default; the root principal of an ancestor by signer; a stranger is refused", async () => {
    const target = delegationUtxo(DELEGATION_ID, { delegator: { type: 'Agent', id: AGENT_A_ID }, parent: PARENT_ID, delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash, depth: 2, remaining: 0 });
    const call = tools(world(PARENT, target));
    const own = await call('vector_build_delegation_undelegate', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID });
    assert.match(own, /# Undelegation Built \(Unsigned, Not Submitted\)/);
    assert.equal(jsonOf(own).authority_link, 0);
    assert.equal(jsonOf(own).released_lovelace, '1500000');
    assert.equal(signersOf(own)[0], CONTROLLER.keyHash);
    const byRoot = await call('vector_build_delegation_undelegate', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, signer: PRINCIPAL.publicKey });
    assert.equal(jsonOf(byRoot).authority_link, 1);
    assert.equal(signersOf(byRoot)[0], PRINCIPAL.keyHash);
    assert.match(byRoot, /an ancestor 1 level up/);
    const stranger = await call('vector_build_delegation_undelegate', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, signer: testKey(30).keyHash });
    assert.match(stranger, /^Failed to build undelegation: The key [0-9a-f]{56} is not a delegator's key/);
    assert.match(await call('vector_build_delegation_undelegate', { changeAddress: OWN_ADDRESS, delegation: '9d'.repeat(32) }), /No live delegation 9d9d/);
  });
});
