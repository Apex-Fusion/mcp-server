// packages/builder/test/identity-tools.test.ts
// Handler-level tests of the identity registry tools: a minimal fake server captures the handlers, the node is the offline identity
// world (identity-world.ts), and the real identity script runs on every build. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIdentityFamily } from '../src/vector/identity-family.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { IdentityConfigError, NOT_CONFIGURED } from '../src/vector/identity-deployment.ts';
import {
  DEPLOYMENT, CONTROLLER, LISTED, PARTY_KEY, GUARDIAN_A, GUARDIAN_B, NEW_CONTROLLER, OTHER, OWN_ADDRESS, NOW, DAY, LEGACY_IDS, M1,
  identityWorld, recordUtxo, rootRecord,
} from './fixtures/identity-world.ts';
import { legacyAgentDatum } from './fixtures/legacy-datum.ts';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import type { IdentityDatum, Party } from '../src/vector/identity-codec.ts';
import { allowlistProof, tombstone } from '../src/vector/identity-rules.ts';
import { LEGACY_REGISTRY_POLICY_ID, legacyRegistryAddress } from '../src/vector/legacy-registry.ts';
import type { FixtureProvider } from './fixtures/fixture-provider.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const serverOf = (into: Map<string, Handler>) => ({ tool: (name: string, _d: string, _s: unknown, handler: Handler) => { into.set(name, handler); } }) as unknown as McpServer;

export function identityTools(provider: () => FixtureProvider = () => identityWorld(), deployment = () => DEPLOYMENT) {
  const handlers = new Map<string, Handler>();
  registerIdentityFamily(serverOf(handlers), 'identity-tools-test', provider, new RateLimiter(100_000), deployment);
  return async (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name);
    assert.ok(handler, `tool ${name} is registered`);
    return (await handler(args)).content[0].text;
  };
}

/** The JSON block of a tool answer. */
export const jsonOf = (answer: string): Record<string, unknown> => JSON.parse(answer.slice(answer.lastIndexOf('```json\n') + 8, answer.lastIndexOf('\n```')));

describe('vector_build_identity_register', () => {
  const call = identityTools();

  test('builds a registration: the DID, the record output and every signer, with the multi-signer flow', async () => {
    const answer = await call('vector_build_identity_register', {
      changeAddress: OWN_ADDRESS, controller: CONTROLLER.publicKey, name: 'Tool Agent', capabilities: ['demo.text.stats.v1'],
      keys: [{ key: LISTED.publicKey, purposes: ['authentication', 'transaction'] }],
      parties: [{ role: 'Accountable', signer: 'controller' }, { role: 'Provider', signer: PARTY_KEY.keyHash }],
    });
    assert.match(answer, /# Identity Registration Built \(Unsigned, Not Submitted\)/);
    const json = jsonOf(answer);
    assert.match(String(json.did), /^did:vector:[0-9a-f]{64}$/);
    const signers = (json.required_signers as Array<{ key_hash: string }>).map((s) => s.key_hash);
    assert.ok([CONTROLLER.keyHash, LISTED.keyHash, PARTY_KEY.keyHash].every((h) => signers.includes(h)));
    assert.match(answer, /Each key holder in the list signs in turn with vector_signer_sign/);
  });

  test('a refusal names the rule and the tips', async () => {
    const answer = await call('vector_build_identity_register', {
      changeAddress: OWN_ADDRESS, controller: CONTROLLER.publicKey, name: 'Tool Agent', parties: [{ role: 'Provider', signer: PARTY_KEY.keyHash }],
    });
    assert.match(answer, /^Failed to build identity registration: .*Accountable Party that covers/);
  });

  test('without a deployment the tool says which variables to set', async () => {
    const unconfigured = identityTools(() => identityWorld(), () => { throw new IdentityConfigError(NOT_CONFIGURED); });
    const answer = await unconfigured('vector_build_identity_register', {
      changeAddress: OWN_ADDRESS, controller: CONTROLLER.publicKey, name: 'x', parties: [{ role: 'Accountable', signer: 'controller' }],
    });
    assert.match(answer, /VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/);
  });
});


describe('vector_build_identity_end_subagents (the buildRecordSpend example)', () => {
  const id = 'a7'.repeat(32);
  const world = () => identityWorld([recordUtxo(id, rootRecord({ subagentEpoch: 2 }))]);

  test('raises the epoch, keeps the value, the controller signs', async () => {
    const answer = await identityTools(world)('vector_build_identity_end_subagents', { changeAddress: OWN_ADDRESS, did: `did:vector:${id}` });
    const json = jsonOf(answer);
    assert.equal(json.action, 'BumpEpoch');
    assert.equal(json.record_lovelace, '10000000');
    assert.deepEqual((json.required_signers as Array<{ key_hash: string; roles: string[] }>)[0], { key_hash: CONTROLLER.keyHash, roles: ['controller'] });
    assert.match(answer, /subagent epoch 2 to 3/);
  });

  test('a tombstone or a missing record is refused with the reason', async () => {
    const ended = identityWorld([recordUtxo(id, rootRecord({ keys: [], parties: [], description: '', framework: '', endpoint: '', capabilities: [], status: { type: 'Retired', at: NOW - DAY, successor: null } }))]);
    assert.match(await identityTools(() => ended)('vector_build_identity_end_subagents', { changeAddress: OWN_ADDRESS, did: id }), /has ended \(Retired\)/);
    assert.match(await identityTools()('vector_build_identity_end_subagents', { changeAddress: OWN_ADDRESS, did: id }), /No record for did:vector:a7a7/);
    assert.match(await identityTools()('vector_build_identity_end_subagents', { changeAddress: OWN_ADDRESS, did: 'did:vector:XYZ' }), /is not a did:vector DID/);
  });
});

// ─── The actions on a record and the adoption, through their handlers ─────────────────────────────────────────────────────────
// The tools build at the real time, so the records here are dated from it.

const T = Date.now();
const OWN_KEY_HASH = CML.Address.from_bech32(OWN_ADDRESS).payment_cred()!.as_pub_key()!.to_hex();
const ACTION_ID = 'c3'.repeat(32);
const SUCCESSOR_ID = 'd4'.repeat(32);
const party = (role: Party['role'], signer: Party['signer'], rights: number, extra: Partial<Party> = {}): Party => ({
  role, signer, organisation: null, notBefore: T - 30 * DAY, notAfter: null, rights, removalAfter: null, ...extra,
});
const CONTROLLER_PARTY = party('Accountable', { type: 'ControllerSet' }, 3);
const KEY_PARTY = party('Accountable', { type: 'KeyHash', hash: PARTY_KEY.keyHash }, 3);
const live = (overrides: Partial<IdentityDatum> = {}) => rootRecord({ parties: [CONTROLLER_PARTY, KEY_PARTY], createdAt: T - 30 * DAY, ...overrides });
const ended = (status: IdentityDatum['status']) => tombstone(live(), status);
const actionTools = (record: IdentityDatum, more: UTxO[] = []) => identityTools(() => identityWorld([recordUtxo(ACTION_ID, record), ...more]));
const did = `did:vector:${ACTION_ID}`;
const signersOf = (answer: string): string[] => (jsonOf(answer).required_signers as Array<{ key_hash: string }>).map((s) => s.key_hash);
const successorUtxo = () => recordUtxo(SUCCESSOR_ID, rootRecord({ controller: OTHER.publicKey, parties: [CONTROLLER_PARTY], createdAt: T - 30 * DAY }));

describe('vector_build_identity_adopt', () => {
  const legacyId = LEGACY_IDS[0];
  const legacy = (owner = OWN_KEY_HASH, assets: Record<string, bigint> = { [`${LEGACY_REGISTRY_POLICY_ID}${legacyId}`]: 1n }): UTxO => ({
    txHash: '1e'.repeat(32), outputIndex: 0, address: legacyRegistryAddress(), assets: { lovelace: 10_000_000n, ...assets },
    datum: legacyAgentDatum(owner, 'Legacy Agent', 'A legacy agent', ['demo.text.stats.v1'], 'custom', 'https://legacy.example'),
  });
  const args = (extra: Record<string, unknown> = {}) => ({
    changeAddress: OWN_ADDRESS, did: `did:vector:agent:${LEGACY_REGISTRY_POLICY_ID}:${legacyId}`, controller: CONTROLLER.publicKey,
    keys: [{ key: LISTED.publicKey, purposes: ['authentication', 'transaction'] }], parties: [{ role: 'Accountable', signer: 'controller' }], ...extra,
  });

  test('with a proof: the DID stays, the legacy owner signs, 10 AP3X return to the owner, the profile is copied', async () => {
    const answer = await identityTools(() => identityWorld([legacy()]))('vector_build_identity_adopt', args({ proof: allowlistProof(LEGACY_IDS, legacyId), name: 'Adopted Agent' }));
    assert.match(answer, /# Identity Adoption Built \(Unsigned, Not Submitted\)/);
    const json = jsonOf(answer);
    assert.equal(json.did, `did:vector:${legacyId}`);
    assert.equal(json.legacy_did, `did:vector:agent:${LEGACY_REGISTRY_POLICY_ID}:${legacyId}`);
    assert.equal(json.owner_address, OWN_ADDRESS);
    assert.equal(json.proof_from, 'given');
    assert.deepEqual(json.profile_from, { name: 'given', description: 'legacy', framework: 'legacy', endpoint: 'legacy', capabilities: 'legacy' });
    assert.match(answer, /\*\*Profile:\*\* copied from the legacy record: description, framework, endpoint, capabilities; given: name/);
    assert.deepEqual(new Set(signersOf(answer)), new Set([OWN_KEY_HASH, CONTROLLER.keyHash, LISTED.keyHash]));
  });

  test('without a proof: the allowlist comes from the deployment URL (fetch stubbed)', async () => {
    const url = 'https://203.0.113.10/allowlist.json';
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: unknown) => { asked.push(String(input)); return new Response(JSON.stringify(LEGACY_IDS)); }) as typeof fetch;
    try {
      const answer = await identityTools(() => identityWorld([legacy()]), () => ({ ...DEPLOYMENT, allowlistUrl: url }))('vector_build_identity_adopt', args());
      const json = jsonOf(answer);
      assert.equal(json.proof_from, 'allowlist');
      assert.deepEqual(json.proof, allowlistProof(LEGACY_IDS, legacyId));
      assert.deepEqual(asked, [url]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('refusals name the reason', async () => {
    const call = identityTools(() => identityWorld([legacy()]));
    assert.match(await call('vector_build_identity_adopt', args({ did: `did:vector:agent:${'ab'.repeat(28)}:${legacyId}` })), /^Failed to build identity adoption: The DID names the policy abab/);
    assert.match(await call('vector_build_identity_adopt', args()), /no allowlist URL/);
    assert.match(await identityTools()('vector_build_identity_adopt', args({ proof: allowlistProof(LEGACY_IDS, legacyId) })), /No legacy record holds the token/);
  });
});

describe('vector_build_identity_update and vector_build_identity_change_controller', () => {
  test('update: profile, a new party that signs, a removal notice without a signature; each change is a fact', async () => {
    const answer = await actionTools(live())('vector_build_identity_update', {
      changeAddress: OWN_ADDRESS, did, name: 'Updated Agent', capabilities: ['llm.chat.v1'],
      add_parties: [{ role: 'Provider', signer: OTHER.keyHash }], announce_party_removal: [{ role: 'Accountable', signer: PARTY_KEY.keyHash }],
    });
    assert.match(answer, /# Identity Update Built/);
    const json = jsonOf(answer);
    assert.equal(json.action, 'Update');
    assert.ok(Array.isArray(json.changes) && json.changes.length === 4, 'four changes');
    assert.match(answer, /\*\*Change:\*\* name "Test Agent" to "Updated Agent"/);
    assert.match(answer, /\*\*Change:\*\* the removal of the Accountable Party \(key hash [0-9a-f]{56}\) is announced/);
    assert.deepEqual(new Set(signersOf(answer)), new Set([CONTROLLER.keyHash, OTHER.keyHash, OWN_KEY_HASH]));
  });

  test('update: Module-1 joins through its consent; a change of a Module-1 party is refused', async () => {
    const answer = await actionTools(live())('vector_build_identity_update', { changeAddress: OWN_ADDRESS, did, add_parties: [{ role: 'Responsible', signer: 'module1' }] });
    assert.match(answer, /Module-1 consents through its withdrawal/);
    const cbor = /\*\*Unsigned TX CBOR:\*\*\n```\n([0-9a-f]+)\n```/.exec(answer);
    assert.ok(cbor, 'the answer carries the unsigned CBOR');
    assert.equal(CML.Transaction.from_cbor_hex(cbor[1]).body().withdrawals()?.len(), 1);
    const withM1 = live({ parties: [CONTROLLER_PARTY, party('Responsible', { type: 'Script', hash: M1 }, 1)] });
    assert.match(await actionTools(withM1)('vector_build_identity_update', { changeAddress: OWN_ADDRESS, did, change_parties: [{ role: 'Responsible', signer: 'module1', rights: [] }] }),
      /consents only to its own appointment/);
    assert.match(await actionTools(live())('vector_build_identity_update', { changeAddress: OWN_ADDRESS, did }), /changes nothing/);
  });

  test('change controller: both keys sign, the epoch rises', async () => {
    const answer = await actionTools(live())('vector_build_identity_change_controller', { changeAddress: OWN_ADDRESS, did, new_controller: NEW_CONTROLLER.publicKey });
    const json = jsonOf(answer);
    assert.equal(json.new_controller_key_hash, NEW_CONTROLLER.keyHash);
    assert.equal(json.subagent_epoch, 1);
    assert.deepEqual(signersOf(answer).slice(0, 2), [CONTROLLER.keyHash, NEW_CONTROLLER.keyHash]);
    assert.match(await actionTools(live())('vector_build_identity_change_controller', { changeAddress: OWN_ADDRESS, did, new_controller: CONTROLLER.publicKey }), /is the current controller key/);
  });
});

describe('vector_build_identity_suspend and vector_build_identity_unsuspend', () => {
  test('suspend by a party named by role and signer, a reason by name, a length in days: the facts name the holds', async () => {
    const controllerHold = { by: { type: 'ControllerSet' as const }, reason: 6, since: T - DAY, until: T + 5 * DAY };
    const answer = await actionTools(live({ status: { type: 'Suspended', holds: [controllerHold] } }))('vector_build_identity_suspend', {
      changeAddress: OWN_ADDRESS, did, actor: { role: 'Accountable', signer: PARTY_KEY.keyHash }, reason: 'securityInvestigation', days: 3,
    });
    const json = jsonOf(answer);
    assert.match(JSON.stringify(json.hold), new RegExp(`^\\{"by":"${PARTY_KEY.keyHash}","reason":68,"reason_name":"securityInvestigation"`));
    assert.ok(Array.isArray(json.holds) && json.holds.length === 2, 'the kept hold and the new hold');
    assert.match(answer, /\*\*Holds kept:\*\* the controller, hold \(6\)/);
    assert.match(answer, /\*\*New status:\*\* Suspended/);
    assert.deepEqual(signersOf(answer), [PARTY_KEY.keyHash, OWN_KEY_HASH]);
  });

  test('suspend refusals: Module-1, reason 64, an unknown reason', async () => {
    const call = actionTools(live());
    assert.match(await call('vector_build_identity_suspend', { changeAddress: OWN_ADDRESS, did, actor: { role: 'Accountable', signer: 'module1' } }), /Module-1 acts only through its dispute verdicts/);
    assert.match(await call('vector_build_identity_suspend', { changeAddress: OWN_ADDRESS, did, reason: 'disputeVerdict' }), /Reason 64 \(disputeVerdict\) belongs to Module-1/);
    assert.match(await call('vector_build_identity_suspend', { changeAddress: OWN_ADDRESS, did, reason: 'nap' }), /Unknown reason "nap"/);
  });

  test('unsuspend by the author key: the status becomes Active; Module-1 is refused', async () => {
    const keyHold = { by: { type: 'KeyHash' as const, hash: PARTY_KEY.keyHash }, reason: 9, since: T - DAY, until: T + 5 * DAY };
    const call = actionTools(live({ status: { type: 'Suspended', holds: [keyHold] } }));
    const answer = await call('vector_build_identity_unsuspend', { changeAddress: OWN_ADDRESS, did, author: PARTY_KEY.keyHash });
    const json = jsonOf(answer);
    assert.equal(json.status, 'Active');
    assert.equal(json.author, PARTY_KEY.keyHash);
    assert.match(answer, /\*\*Holds dropped:\*\* key hash [0-9a-f]{56}, privilegeWithdrawn \(9\).*its author lifts it/);
    assert.match(answer, /\*\*New status:\*\* Active/);
    assert.match(await call('vector_build_identity_unsuspend', { changeAddress: OWN_ADDRESS, did, author: 'module1' }), /Module-1 never lifts its holds/);
    assert.match(await call('vector_build_identity_unsuspend', { changeAddress: OWN_ADDRESS, did }), /has no hold by the controller/);
  });
});

describe('vector_build_identity_revoke, _retire, _reclaim and _set_successor', () => {
  test('revoke by a party for keyCompromise; a party names no successor', async () => {
    const call = actionTools(live(), [successorUtxo()]);
    const answer = await call('vector_build_identity_revoke', { changeAddress: OWN_ADDRESS, did, actor: { party_index: 1 }, reason: 'keyCompromise', invalid_from: T - 10 * DAY });
    const json = jsonOf(answer);
    assert.deepEqual([json.status, json.by, json.reason, json.invalid_from, json.successor], ['Revoked', PARTY_KEY.keyHash, 1, T - 10 * DAY, null]);
    assert.match(answer, /A revocation is final/);
    assert.match(await call('vector_build_identity_revoke', { changeAddress: OWN_ADDRESS, did, actor: { party_index: 1 }, reason: 3, successor: `did:vector:${SUCCESSOR_ID}` }),
      /Only the controller names a successor/);
    assert.match(await call('vector_build_identity_revoke', { changeAddress: OWN_ADDRESS, did, reason: 1 }), /needs invalid_from/);
  });

  test('revoke by the controller with a successor: both controllers sign', async () => {
    const answer = await actionTools(live(), [successorUtxo()])('vector_build_identity_revoke', { changeAddress: OWN_ADDRESS, did, reason: 4, successor: SUCCESSOR_ID });
    assert.equal(jsonOf(answer).successor, `did:vector:${SUCCESSOR_ID}`);
    assert.deepEqual(new Set(signersOf(answer)), new Set([CONTROLLER.keyHash, OTHER.keyHash, OWN_KEY_HASH]));
  });

  test('retire with take_deposit returns the deposit above the ledger minimum; reclaim and set successor act on the tombstone', async () => {
    const retired = jsonOf(await actionTools(live())('vector_build_identity_retire', { changeAddress: OWN_ADDRESS, did, take_deposit: true }));
    assert.equal(retired.status, 'Retired');
    assert.ok(BigInt(String(retired.returned_lovelace)) > 8_000_000n);

    const tomb = ended({ type: 'Revoked', by: { type: 'KeyHash', hash: PARTY_KEY.keyHash }, reason: 3, at: T - DAY, invalidFrom: null, successor: null });
    const reclaimed = await actionTools(tomb)('vector_build_identity_reclaim', { changeAddress: OWN_ADDRESS, did });
    assert.equal(BigInt(String(jsonOf(reclaimed).returned_lovelace)) + BigInt(String(jsonOf(reclaimed).record_lovelace)), 10_000_000n);
    const named = await actionTools(tomb, [successorUtxo()])('vector_build_identity_set_successor', { changeAddress: OWN_ADDRESS, did, successor: SUCCESSOR_ID });
    assert.deepEqual([jsonOf(named).successor, jsonOf(named).status], [`did:vector:${SUCCESSOR_ID}`, 'Revoked']);
    assert.match(await actionTools(live())('vector_build_identity_reclaim', { changeAddress: OWN_ADDRESS, did }), /Reclaim applies only to a record that has ended/);
    assert.match(await actionTools(tomb)('vector_build_identity_retire', { changeAddress: OWN_ADDRESS, did }), /has ended \(Revoked\)/);
  });
});

describe('vector_build_identity_recovery_start, _cancel and _complete', () => {
  const guardian = (key: { keyHash: string }) => party('Guardian', { type: 'KeyHash', hash: key.keyHash }, 4);
  const guarded = (pendingRecovery: IdentityDatum['pendingRecovery'] = null) => live({ parties: [CONTROLLER_PARTY, guardian(GUARDIAN_A), guardian(GUARDIAN_B)], guardianThreshold: 2, pendingRecovery });

  test('start: the guardians and the new key sign; it can complete 7 days after the window ends', async () => {
    const answer = await actionTools(guarded())('vector_build_identity_recovery_start', { changeAddress: OWN_ADDRESS, did, new_controller: NEW_CONTROLLER.publicKey, guardians: [GUARDIAN_A.keyHash, 2] });
    const json = jsonOf(answer);
    assert.deepEqual(json.guardians, [1, 2]);
    assert.equal(Number(json.effective_after) - Number(json.valid_to), 7 * DAY);
    assert.deepEqual(new Set(signersOf(answer)), new Set([GUARDIAN_A.keyHash, GUARDIAN_B.keyHash, NEW_CONTROLLER.keyHash, OWN_KEY_HASH]));
    assert.match(await actionTools(guarded())('vector_build_identity_recovery_start', { changeAddress: OWN_ADDRESS, did, new_controller: NEW_CONTROLLER.publicKey, guardians: [1] }), /needs 2 guardians/);
  });

  test('cancel and complete', async () => {
    const pending = (effectiveAfter: number) => guarded({ newController: NEW_CONTROLLER.publicKey, effectiveAfter });
    const cancelled = jsonOf(await actionTools(pending(T + DAY))('vector_build_identity_recovery_cancel', { changeAddress: OWN_ADDRESS, did, guardians: [1, 2] }));
    assert.equal(cancelled.action, 'RecoverCancel');
    const completed = await actionTools(pending(T - 2 * DAY))('vector_build_identity_recovery_complete', { changeAddress: OWN_ADDRESS, did });
    assert.equal(jsonOf(completed).new_controller_key_hash, NEW_CONTROLLER.keyHash);
    assert.deepEqual(signersOf(completed), [OWN_KEY_HASH]);
    assert.match(await actionTools(pending(T + DAY))('vector_build_identity_recovery_complete', { changeAddress: OWN_ADDRESS, did }), /opens at/);
  });
});