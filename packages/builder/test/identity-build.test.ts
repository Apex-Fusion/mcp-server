// packages/builder/test/identity-build.test.ts
// Builder tests of every action on a record (Part 2 Sections 3.5 to 3.7): each positive build completes against the real applied
// identity script of identity-world.ts (Lucid's local evaluation), and the test decodes the transaction to check the new datum, the
// value, the redeemer and the required signers. Each refusal has a negative test. Offline: no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import {
  DEPLOYMENT, NOW, WINDOW, DAY, CONTROLLER, LISTED, PARTY_KEY, GUARDIAN_A, GUARDIAN_B, NEW_CONTROLLER, OTHER, CONTROLLER_ACCOUNTABLE, M1,
  CONFIG_UTXO, REF_UTXOS, OWN_ADDRESS, identityWorld, lucidOn, rootRecord, recordUtxo,
} from './fixtures/identity-world.ts';
import {
  buildChangeController, buildEndSubagents, buildReclaim, buildRecoveryCancel, buildRecoveryComplete, buildRecoveryStart, buildRetire, buildRevoke,
  buildSetSuccessor, buildSuspend, buildUnsuspend, buildUpdate,
} from '../src/vector/identity-build.ts';
import type { IdentityContext, RecordSpendBuild } from '../src/vector/identity-build.ts';
import { decodeIdentityDatum, decodeIdentitySpend, utf8Hex } from '../src/vector/identity-codec.ts';
import type { Hold, IdentityDatum, IdentitySpend, Party, Role, Status } from '../src/vector/identity-codec.ts';
import { DAYS_7_MS, DAYS_30_MS, tombstone } from '../src/vector/identity-rules.ts';
import { module1RewardAddress } from '../src/vector/identity-deployment.ts';

const ID = 'a1'.repeat(32);
const SUCCESSOR = 'b2'.repeat(32);
const OWN_KEY_HASH = CML.Address.from_bech32(OWN_ADDRESS).payment_cred()!.as_pub_key()!.to_hex();
const { lo, hi } = WINDOW;
const common = { changeAddress: OWN_ADDRESS, nowMs: NOW, id: ID };

const keyParty = (key: { keyHash: string }, role: Role, rights: number, extra: Partial<Party> = {}): Party => ({
  role, signer: { type: 'KeyHash', hash: key.keyHash }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: null, rights, removalAfter: null, ...extra,
});
const ACCOUNTABLE_KEY = keyParty(PARTY_KEY, 'Accountable', 3);
const GUARDIAN_A_PARTY = keyParty(GUARDIAN_A, 'Guardian', 4);
const GUARDIAN_B_PARTY = keyParty(GUARDIAN_B, 'Guardian', 4);
const M1_ACCOUNTABLE: Party = { role: 'Accountable', signer: { type: 'Script', hash: M1 }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: null, rights: 3, removalAfter: null };
const RETIRED: IdentityDatum = tombstone(rootRecord(), { type: 'Retired', at: NOW - DAY, successor: null });

async function on(records: UTxO[], opts: { rewards?: bigint | null } = {}): Promise<IdentityContext> {
  const provider = identityWorld(records, opts);
  return { lucid: await lucidOn(provider), provider, deployment: DEPLOYMENT };
}
/** A world with the record of ID (and other records). */
const withRecord = (record: IdentityDatum, more: UTxO[] = [], lovelace?: bigint) => on([recordUtxo(ID, record, lovelace), ...more]);
const successorUtxo = (record: IdentityDatum = rootRecord({ controller: OTHER.publicKey })) => recordUtxo(SUCCESSOR, record);

/** What the test reads back from a built transaction. */
function inspect(r: RecordSpendBuild) {
  const tx = CML.Transaction.from_cbor_hex(r.txCbor);
  const body = tx.body();
  const out = body.outputs().get(r.recordOutputIndex);
  const required = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; required && i < required.len(); i++) signers.push(required.get(i).to_hex());
  const redeemers = tx.witness_set().redeemers()!.to_flat_format();
  const spends: string[] = [];
  for (let i = 0; i < redeemers.len(); i++) if (redeemers.get(i).tag() === CML.RedeemerTag.Spend) spends.push(redeemers.get(i).data().to_cbor_hex());
  assert.equal(spends.length, 1, 'the record is the only script input');
  const refs: string[] = [];
  const refInputs = body.reference_inputs();
  for (let i = 0; refInputs && i < refInputs.len(); i++) refs.push(`${refInputs.get(i).transaction_id().to_hex()}#${refInputs.get(i).index()}`);
  const withdrawals: Array<[string, bigint]> = [];
  const w = body.withdrawals();
  for (let i = 0; w && i < w.keys().len(); i++) withdrawals.push([w.keys().get(i).to_address().to_bech32(), w.get(w.keys().get(i))!]);
  assert.equal(out.address().to_bech32(), DEPLOYMENT.identity.address);
  assert.equal(out.amount().coin(), r.outputLovelace);
  const datum = decodeIdentityDatum(out.datum()!.as_datum()!.to_cbor_hex());
  assert.deepEqual(datum, r.record, 'the result names the datum that the transaction carries');
  return { datum, lovelace: out.amount().coin(), spend: decodeIdentitySpend(spends[0]) as IdentitySpend, signers: new Set(signers), refs, withdrawals };
}
const refOf = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;
const hold = (by: Hold['by'], reason: number, since: number, until: number): Hold => ({ by, reason, since, until });
const suspended = (holds: Hold[]): Status => ({ type: 'Suspended', holds });

describe('buildUpdate (Part 2 Section 3.6)', () => {
  test('profile and keys: the given fields change, a new Ed25519 key signs, a key leaves by its key hash, the rest stays', async () => {
    const r = await buildUpdate(await withRecord(rootRecord()), {
      ...common, profile: { name: utf8Hex('Renamed Agent'), capabilities: [utf8Hex('demo.text.stats.v1'), utf8Hex('llm.chat.v1')] },
      addKeys: [{ keyType: 'Ed25519', key: OTHER.publicKey, purposes: 1, pop: null }], removeKeys: [LISTED.keyHash],
    });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'Update' });
    assert.deepEqual(b.datum, rootRecord({
      name: utf8Hex('Renamed Agent'), capabilities: [utf8Hex('demo.text.stats.v1'), utf8Hex('llm.chat.v1')],
      keys: [{ keyType: 'Ed25519', key: OTHER.publicKey, purposes: 1, pop: null }],
    }));
    assert.equal(b.lovelace, 10_000_000n);
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, OTHER.keyHash]));
    assert.equal(r.changes.length, 4);
    assert.match(r.summary, /the profile, the keys: 4 changes/);
    assert.equal(r.requiredSigners[r.requiredSigners.length - 1].keyHash, OWN_KEY_HASH);
  });

  test('parties: a notice needs no signature, a passed notice removes without one, a change and a new party sign, new parties come last', async () => {
    const responsible = keyParty(PARTY_KEY, 'Responsible', 1);
    const provider = keyParty(OTHER, 'Provider', 1, { removalAfter: NOW - DAY });
    const distributor = keyParty(GUARDIAN_B, 'Distributor', 0);
    const r = await buildUpdate(await withRecord(rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, responsible, provider, distributor] })), {
      ...common,
      announcePartyRemoval: [{ role: 'Responsible', signer: responsible.signer }],
      removeParties: [{ role: 'Provider', signer: provider.signer }],
      changeParties: [{ role: 'Distributor', signer: distributor.signer, organisation: utf8Hex('example.org') }],
      addParties: [{ role: 'Provider', signer: { type: 'KeyHash', hash: NEW_CONTROLLER.keyHash }, organisation: null, notAfter: null, rights: 1, removalAfter: null }],
    });
    const b = inspect(r);
    assert.deepEqual(b.datum.parties, [
      CONTROLLER_ACCOUNTABLE,
      { ...responsible, removalAfter: hi + DAYS_7_MS },
      { ...distributor, organisation: utf8Hex('example.org') },
      { role: 'Provider', signer: { type: 'KeyHash', hash: NEW_CONTROLLER.keyHash }, organisation: null, notBefore: lo, notAfter: null, rights: 1, removalAfter: null },
    ]);
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, GUARDIAN_B.keyHash, NEW_CONTROLLER.keyHash]));
    assert.ok(r.changes.some((c) => /removal of the Responsible Party .* announced .*does not sign/.test(c)));
    assert.ok(r.changes.some((c) => /Provider Party .* leaves \(its removal notice ended/.test(c)));
  });

  test('a party removed before its notice ends signs', async () => {
    const responsible = keyParty(PARTY_KEY, 'Responsible', 1, { removalAfter: NOW + DAY });
    const r = await buildUpdate(await withRecord(rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, responsible] })), {
      ...common, removeParties: [{ role: 'Responsible', signer: responsible.signer }],
    });
    const b = inspect(r);
    assert.deepEqual(b.datum.parties, [CONTROLLER_ACCOUNTABLE]);
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, PARTY_KEY.keyHash]));
  });

  test('guardians and threshold: the guardian bound holds; a threshold of 0 cancels a pending recovery', async () => {
    const guardian = (key: { keyHash: string }) => ({ role: 'Guardian' as const, signer: { type: 'KeyHash' as const, hash: key.keyHash }, organisation: null, notAfter: null, rights: 4, removalAfter: null });
    const r = await buildUpdate(await withRecord(rootRecord()), { ...common, addParties: [guardian(GUARDIAN_A), guardian(GUARDIAN_B)], guardianThreshold: 2 });
    const b = inspect(r);
    assert.equal(b.datum.guardianThreshold, 2);
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, GUARDIAN_A.keyHash, GUARDIAN_B.keyHash]));
    await assert.rejects(buildUpdate(await withRecord(rootRecord()), { ...common, addParties: [guardian(GUARDIAN_A), guardian(GUARDIAN_B)], guardianThreshold: 3 }),
      /guardian threshold 3 is above the 2 Guardian Parties/);

    const pending = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, GUARDIAN_A_PARTY], guardianThreshold: 1, pendingRecovery: { newController: NEW_CONTROLLER.publicKey, effectiveAfter: NOW + 3 * DAY } });
    const cleared = inspect(await buildUpdate(await withRecord(pending), { ...common, guardianThreshold: 0 }));
    assert.deepEqual(cleared.datum, { ...pending, guardianThreshold: 0, pendingRecovery: null });
    assert.deepEqual(cleared.signers, new Set([CONTROLLER.keyHash]));
    await assert.rejects(buildUpdate(await withRecord(pending), { ...common, removeParties: [{ role: 'Guardian', signer: GUARDIAN_A_PARTY.signer }] }),
      /guardian threshold 1 is above the 0 Guardian Parties .*lower guardian_threshold in the same update/);
  });

  test('Module-1 joins by its consent withdrawal of its whole reward balance, with the configuration record as a reference input', async () => {
    const r = await buildUpdate(await on([recordUtxo(ID, rootRecord())], { rewards: 1_234_567n }), {
      ...common, addParties: [{ role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, notAfter: null, rights: 1, removalAfter: null }],
    });
    const b = inspect(r);
    assert.deepEqual(b.datum.parties[1], { role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, notBefore: lo, notAfter: null, rights: 1, removalAfter: null });
    assert.deepEqual(b.withdrawals, [[module1RewardAddress(M1), 1_234_567n]]);
    assert.ok(b.refs.includes(refOf(CONFIG_UTXO)) && b.refs.includes(refOf(REF_UTXOS[6])));
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash]));
  });

  test('Module-1\'s consent reads its reward account with no default: an account that is not registered, or that cannot be read, is refused', async () => {
    const appoint = { ...common, addParties: [{ role: 'Responsible' as const, signer: { type: 'Script' as const, hash: M1 }, organisation: null, notAfter: null, rights: 1, removalAfter: null }] };
    await assert.rejects(buildUpdate(await on([recordUtxo(ID, rootRecord())], { rewards: null }), appoint),
      new RegExp(`Module-1's stake credential \\(${module1RewardAddress(M1)}\\) is not registered on the ledger, so the withdrawal by which Module-1 consents cannot be built`));
    const unreadable = await on([recordUtxo(ID, rootRecord())]);
    Object.assign(unreadable.provider, { getRewardAccount: async () => { throw new Error('Koios request failed (account_info): 503 Service Unavailable'); } });
    await assert.rejects(buildUpdate(unreadable, appoint), /Could not read the reward account of Module-1's stake credential \(stake[0-9a-z]+\), which its consent must withdraw in full: Koios request failed \(account_info\): 503/);
    const noReader = await on([recordUtxo(ID, rootRecord())]);
    Object.assign(noReader.provider, { getRewardAccount: undefined });
    await assert.rejects(buildUpdate(noReader, appoint), /node provider cannot read a reward account/);
  });

  test('the deposit changes the AP3X of the record, not below 10 AP3X', async () => {
    const b = inspect(await buildUpdate(await withRecord(rootRecord()), { ...common, depositLovelace: 15_000_000n }));
    assert.equal(b.lovelace, 15_000_000n);
    await assert.rejects(buildUpdate(await withRecord(rootRecord()), { ...common, depositLovelace: 9_000_000n }), /at least 10 AP3X/);
  });

  test('refusals name the rule', async () => {
    const world = () => withRecord(rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, M1_ACCOUNTABLE, keyParty(PARTY_KEY, 'Responsible', 1, { removalAfter: NOW + 8 * DAY })] }));
    const m1Ref = { role: 'Accountable' as const, signer: M1_ACCOUNTABLE.signer };
    await assert.rejects(buildUpdate(await withRecord(RETIRED), { ...common, profile: { name: utf8Hex('x') } }), /has ended \(Retired\); only Reclaim and SetSuccessor/);
    await assert.rejects(buildUpdate(await withRecord(rootRecord()), { ...common, profile: { name: rootRecord().name } }), /changes nothing/);
    await assert.rejects(buildUpdate(await withRecord(rootRecord()), { ...common, addKeys: [{ keyType: 'Ed25519', key: LISTED.publicKey, purposes: 1, pop: null }] }), /already listed/);
    await assert.rejects(buildUpdate(await withRecord(rootRecord()), { ...common, removeKeys: [OTHER.keyHash] }), /lists no key/);
    await assert.rejects(buildUpdate(await withRecord(rootRecord()), { ...common, addKeys: [{ keyType: 'P256', key: `02${'11'.repeat(32)}`, purposes: 1, pop: null }] }),
      /a P-256 key is a 33-byte compressed point with a 64-byte proof of possession/);
    await assert.rejects(buildUpdate(await world(), { ...common, changeParties: [{ ...m1Ref, rights: 1 }] }), /consents only to its own appointment/);
    await assert.rejects(buildUpdate(await world(), { ...common, removeParties: [m1Ref] }), /never consents to its own early removal/);
    await assert.rejects(buildUpdate(await withRecord(rootRecord()), {
      ...common, addParties: [{ role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, notAfter: null, rights: 0, removalAfter: null }],
    }), /Module-1 would not consent to this appointment: a Module-1 Responsible Party has the highest rights of its role/);
    await assert.rejects(buildUpdate(await world(), { ...common, announcePartyRemoval: [{ ...m1Ref, removalAfter: hi + DAYS_7_MS - 1 }] }), /at least 7 days/);
    await assert.rejects(buildUpdate(await world(), { ...common, announcePartyRemoval: [{ role: 'Responsible', signer: { type: 'KeyHash', hash: PARTY_KEY.keyHash } }] }), /already announced/);
    await assert.rejects(buildUpdate(await world(), { ...common, addParties: [{ ...CONTROLLER_ACCOUNTABLE }] }), /already a party/);
    await assert.rejects(buildUpdate(await world(), { ...common, announcePartyRemoval: [m1Ref], removeParties: [m1Ref] }), /named twice/);
    await assert.rejects(buildUpdate(await world(), { ...common, removeParties: [{ role: 'Provider', signer: { type: 'KeyHash', hash: OTHER.keyHash } }] }), /has no Provider Party/);
    await assert.rejects(buildUpdate(await world(), { ...common, changeParties: [{ ...CONTROLLER_ACCOUNTABLE, rights: 3 }] }), /The change of the Accountable Party \(the controller\) changes nothing/);
  });
});

describe('buildChangeController', () => {
  test('the new key, epoch + 1, no pending recovery, holds stay; the old and the new controller sign', async () => {
    const record = rootRecord({
      parties: [CONTROLLER_ACCOUNTABLE, GUARDIAN_A_PARTY], guardianThreshold: 1, subagentEpoch: 2,
      pendingRecovery: { newController: NEW_CONTROLLER.publicKey, effectiveAfter: NOW + DAY },
      status: suspended([hold({ type: 'ControllerSet' }, 6, NOW - DAY, NOW + DAY)]),
    });
    const r = await buildChangeController(await withRecord(record), { ...common, newController: OTHER.publicKey });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'ChangeController' });
    assert.deepEqual(b.datum, { ...record, controller: OTHER.publicKey, subagentEpoch: 3, pendingRecovery: null });
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, OTHER.keyHash]));
    assert.equal(b.lovelace, 10_000_000n);
  });

  test('refuses the current key and an ended record', async () => {
    await assert.rejects(buildChangeController(await withRecord(rootRecord()), { ...common, newController: CONTROLLER.publicKey }), /is the current controller key/);
    await assert.rejects(buildChangeController(await withRecord(RETIRED), { ...common, newController: OTHER.publicKey }), /has ended/);
  });
});

describe('buildSuspend', () => {
  test('by the controller: one hold {ControllerSet, 6, lo, lo + 30 days}, status Suspended, value kept; Module-1 parties keep the configuration input', async () => {
    const r = await buildSuspend(await withRecord(rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, M1_ACCOUNTABLE] })), common);
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'Suspend', actor: { type: 'ByController' } });
    assert.deepEqual(b.datum.status, suspended([hold({ type: 'ControllerSet' }, 6, lo, lo + DAYS_30_MS)]));
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash]));
    assert.equal(b.lovelace, 10_000_000n);
    assert.ok(b.refs.includes(refOf(CONFIG_UTXO)));
  });

  test('by a party: its older hold, holds of removed key parties and ended holds drop; other holds stay in order, the new one last', async () => {
    const responsible = keyParty(GUARDIAN_B, 'Responsible', 1);
    const own = hold({ type: 'KeyHash', hash: PARTY_KEY.keyHash }, 6, NOW - 2 * DAY, NOW + 5 * DAY);
    const controller = hold({ type: 'ControllerSet' }, 0, NOW - DAY, NOW + 10 * DAY);
    const removed = hold({ type: 'KeyHash', hash: OTHER.keyHash }, 9, NOW - DAY, NOW + 3 * DAY);
    const module1 = hold({ type: 'Script', hash: M1 }, 64, NOW - DAY, NOW + 20 * DAY);
    const ended = hold({ type: 'KeyHash', hash: GUARDIAN_B.keyHash }, 68, NOW - 3 * DAY, NOW - 2 * 3_600_000);
    const record = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, ACCOUNTABLE_KEY, responsible], status: suspended([own, controller, removed, module1, ended]) });
    const r = await buildSuspend(await withRecord(record), { ...common, actor: { type: 'party', index: 1 }, reason: 68, days: 3 });
    const b = inspect(r);
    const fresh = hold({ type: 'KeyHash', hash: PARTY_KEY.keyHash }, 68, lo, lo + 3 * DAY);
    assert.deepEqual(b.spend, { type: 'Suspend', actor: { type: 'ByParty', index: 1 } });
    assert.deepEqual(b.datum, { ...record, status: suspended([controller, module1, fresh]) });
    assert.deepEqual(b.signers, new Set([PARTY_KEY.keyHash]));
    assert.deepEqual(r.kept, [controller, module1]);
    assert.deepEqual(r.dropped.map((d) => d.why), ['the new hold of the same author replaces it', 'its author is no longer a party of the record', `it ended at ${new Date(ended.until).toISOString()}`]);
    const byRole = inspect(await buildSuspend(await withRecord(record), { ...common, actor: { type: 'party', role: 'Accountable', signer: ACCOUNTABLE_KEY.signer }, until: hi + 1000 }));
    assert.deepEqual(byRole.spend, { type: 'Suspend', actor: { type: 'ByParty', index: 1 } });
  });

  test('refusals name the rule', async () => {
    const record = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, keyParty(OTHER, 'Distributor', 0), keyParty(PARTY_KEY, 'Accountable', 3, { notBefore: NOW + DAY }), M1_ACCOUNTABLE] });
    const world = () => withRecord(record);
    await assert.rejects(buildSuspend(await world(), { ...common, reason: 64 }), /Reason 64 \(disputeVerdict\) belongs to Module-1/);
    await assert.rejects(buildSuspend(await world(), { ...common, reason: 1 }), /Reason 1 is not allowed in a Suspend: use unspecified \(0\), hold \(6\)/);
    await assert.rejects(buildSuspend(await world(), { ...common, until: hi }), /ends after the validity window/);
    await assert.rejects(buildSuspend(await world(), { ...common, until: lo + DAYS_30_MS + 1000 }), /at most 30 days/);
    await assert.rejects(buildSuspend(await world(), { ...common, until: hi + DAY, days: 2 }), /not both/);
    await assert.rejects(buildSuspend(await world(), { ...common, actor: { type: 'party', index: 1 } }), /Distributor Party .* has no suspend right/);
    await assert.rejects(buildSuspend(await world(), { ...common, actor: { type: 'party', index: 2 } }), /does not cover the validity window/);
    await assert.rejects(buildSuspend(await world(), { ...common, actor: { type: 'party', index: 3 } }), /at index 3 is Module-1\. Module-1 acts only through its dispute verdicts/);
    await assert.rejects(buildSuspend(await world(), { ...common, actor: { type: 'party', index: 5 } }), /has 4 parties; there is no party at index 5/);
    await assert.rejects(buildSuspend(await world(), { ...common, actor: { type: 'party', index: 1, role: 'Guardian' } }), /not the party named/);
    await assert.rejects(buildSuspend(await world(), { ...common, actor: { type: 'party', role: 'Provider', signer: { type: 'KeyHash', hash: OTHER.keyHash } } }), /has no Provider Party/);
    await assert.rejects(buildSuspend(await world(), { ...common, actor: { type: 'party', role: 'Provider' } }), /by its index, or by its role and its signer/);
    await assert.rejects(buildSuspend(await withRecord(RETIRED), common), /has ended/);
  });
});

describe('buildUnsuspend', () => {
  const byController = hold({ type: 'ControllerSet' }, 6, NOW - DAY, NOW + 5 * DAY);
  const byParty = hold({ type: 'KeyHash', hash: PARTY_KEY.keyHash }, 9, NOW - DAY, NOW + 5 * DAY);

  test("a party lifts its own hold; the controller's hold stays and the status stays Suspended", async () => {
    const record = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, ACCOUNTABLE_KEY], status: suspended([byController, byParty]) });
    const r = await buildUnsuspend(await withRecord(record), { ...common, author: { type: 'KeyHash', hash: PARTY_KEY.keyHash } });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'Unsuspend', author: { type: 'KeyHash', hash: PARTY_KEY.keyHash } });
    assert.deepEqual(b.datum, { ...record, status: suspended([byController]) });
    assert.deepEqual(b.signers, new Set([PARTY_KEY.keyHash]));
    assert.equal(b.lovelace, 10_000_000n);
  });

  test('the controller lifts the last hold: status Active', async () => {
    const b = inspect(await buildUnsuspend(await withRecord(rootRecord({ status: suspended([byController]) })), common));
    assert.deepEqual(b.datum.status, { type: 'Active' });
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash]));
  });

  test('refusals name the rule', async () => {
    const record = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, M1_ACCOUNTABLE], status: suspended([hold({ type: 'Script', hash: M1 }, 64, NOW - DAY, NOW + DAY)]) });
    await assert.rejects(buildUnsuspend(await withRecord(record), common), /has no hold by the controller; its holds are by Module-1/);
    await assert.rejects(buildUnsuspend(await withRecord(record), { ...common, author: { type: 'Script', hash: M1 } }), /Module-1 never lifts its holds/);
    await assert.rejects(buildUnsuspend(await withRecord(rootRecord()), common), /has no holds \(status Active\)/);
    await assert.rejects(buildUnsuspend(await withRecord(RETIRED), common), /has ended/);
  });
});

describe('buildRevoke', () => {
  test('by the controller with a successor: the tombstone, the successor record as a reference input, both controllers sign', async () => {
    const successor = successorUtxo();
    const r = await buildRevoke(await withRecord(rootRecord(), [successor]), { ...common, reason: 4, successor: SUCCESSOR });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'Revoke', actor: { type: 'ByController' } });
    assert.deepEqual(b.datum, tombstone(rootRecord(), { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 4, at: lo, invalidFrom: null, successor: SUCCESSOR }));
    assert.ok(b.refs.includes(refOf(successor)));
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, OTHER.keyHash]));
    assert.equal(b.lovelace, 10_000_000n);
  });

  test('by a party for keyCompromise with invalid_from: by = its signer', async () => {
    const record = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, ACCOUNTABLE_KEY] });
    const r = await buildRevoke(await withRecord(record), { ...common, actor: { type: 'party', index: 1 }, reason: 1, invalidFrom: NOW - 10 * DAY });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'Revoke', actor: { type: 'ByParty', index: 1 } });
    assert.deepEqual(b.datum.status, { type: 'Revoked', by: { type: 'KeyHash', hash: PARTY_KEY.keyHash }, reason: 1, at: lo, invalidFrom: NOW - 10 * DAY, successor: null });
    assert.deepEqual(b.signers, new Set([PARTY_KEY.keyHash]));
  });

  test('reason 1 at once after the creation: invalid_from = lo, before created_at, by the controller and by a party', async () => {
    // The record of a Register built at NOW (created_at = hi), revoked at once with the same window, so lo < created_at. The identity
    // script takes invalid_from in [created_at - 3,600,000, lo] (Part 2 Section 3.7).
    const created = rootRecord({ parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: lo }, { ...ACCOUNTABLE_KEY, notBefore: lo }], createdAt: hi });
    const byController = inspect(await buildRevoke(await withRecord(created), { ...common, reason: 1, invalidFrom: lo }));
    assert.deepEqual(byController.spend, { type: 'Revoke', actor: { type: 'ByController' } });
    assert.deepEqual(byController.datum, tombstone(created, { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: lo, invalidFrom: lo, successor: null }));
    const byParty = inspect(await buildRevoke(await withRecord(created), { ...common, actor: { type: 'party', index: 1 }, reason: 1, invalidFrom: lo }));
    assert.deepEqual(byParty.datum.status, { type: 'Revoked', by: { type: 'KeyHash', hash: PARTY_KEY.keyHash }, reason: 1, at: lo, invalidFrom: lo, successor: null });
    assert.deepEqual(byParty.signers, new Set([PARTY_KEY.keyHash]));
    // The lower bound: exactly one hour before created_at passes; one millisecond earlier is refused before the build.
    const lowest = hi - 3_600_000;
    assert.equal(inspect(await buildRevoke(await withRecord(created), { ...common, reason: 1, invalidFrom: lowest })).datum.status.type, 'Revoked');
    await assert.rejects(buildRevoke(await withRecord(created), { ...common, reason: 1, invalidFrom: lowest - 1 }), /invalid_from must lie between .*, one hour before created_at/);
  });

  test('refusals name the rule', async () => {
    const record = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, ACCOUNTABLE_KEY, keyParty(OTHER, 'Responsible', 1)] });
    const world = () => withRecord(record, [successorUtxo()]);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 64 }), /belongs to Module-1/);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 6 }), /Reason 6 is not allowed in a Revoke/);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 1 }), /needs invalid_from/);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 0, invalidFrom: record.createdAt - 3_600_001 }), /invalid_from must lie between .*, one hour before created_at/);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 0, invalidFrom: lo + 1000 }), /invalid_from must lie between .*, and the start of the validity window/);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 3, actor: { type: 'party', index: 1 }, successor: SUCCESSOR }), /Only the controller names a successor/);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 9, actor: { type: 'party', index: 2 } }), /has no revoke right/);
    await assert.rejects(buildRevoke(await world(), { ...common, reason: 4, successor: ID }), /cannot name itself/);
    await assert.rejects(buildRevoke(await withRecord(record, [successorUtxo(RETIRED)]), { ...common, reason: 4, successor: SUCCESSOR }), /successor .* has ended \(Retired\)/);
    await assert.rejects(buildRevoke(await withRecord(record, [successorUtxo(rootRecord({ endpoint: '', lineage: { type: 'Subagent', parent: 'cc'.repeat(32), parentEpoch: 0, depth: 1 } }))]), {
      ...common, reason: 4, successor: SUCCESSOR,
    }), /is a subagent/);
    await assert.rejects(buildRevoke(await withRecord(record), { ...common, reason: 4, successor: SUCCESSOR }), /No successor record/);
    await assert.rejects(buildRevoke(await withRecord(RETIRED), { ...common, reason: 0 }), /has ended/);
  });
});

describe('buildRetire, buildReclaim and buildSetSuccessor', () => {
  test('retire keeps the value by default', async () => {
    const r = await buildRetire(await withRecord(rootRecord()), common);
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'Retire' });
    assert.deepEqual(b.datum, tombstone(rootRecord(), { type: 'Retired', at: lo, successor: null }));
    assert.equal(b.lovelace, 10_000_000n);
    assert.equal(r.returnedLovelace, 0n);
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash]));
  });

  test('retire with take_deposit and a successor: the tombstone keeps the ledger minimum, the rest returns', async () => {
    const r = await buildRetire(await withRecord(rootRecord(), [successorUtxo()]), { ...common, successor: SUCCESSOR, takeDeposit: true });
    const b = inspect(r);
    assert.deepEqual(b.datum.status, { type: 'Retired', at: lo, successor: SUCCESSOR });
    assert.ok(b.lovelace > 0n && b.lovelace < 2_000_000n, `ledger minimum ${b.lovelace}`);
    assert.equal(r.returnedLovelace, 10_000_000n - b.lovelace);
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, OTHER.keyHash]));
    await assert.rejects(buildRetire(await withRecord(RETIRED), common), /has ended/);
  });

  test('reclaim: D stays, the output keeps the ledger minimum, the rest returns; nothing to reclaim is refused', async () => {
    const r = await buildReclaim(await withRecord(RETIRED), common);
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'Reclaim' });
    assert.deepEqual(b.datum, RETIRED);
    assert.equal(r.returnedLovelace, 10_000_000n - b.lovelace);
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash]));
    await assert.rejects(buildReclaim(await withRecord(RETIRED, [], b.lovelace), common), /nothing to reclaim/);
    await assert.rejects(buildReclaim(await withRecord(rootRecord()), common), /is live \(Active\): Reclaim applies only to a record that has ended/);
  });

  test('set successor after a party revocation: only the successor changes; both controllers sign', async () => {
    const revoked = tombstone(rootRecord(), { type: 'Revoked', by: { type: 'KeyHash', hash: PARTY_KEY.keyHash }, reason: 3, at: NOW - DAY, invalidFrom: null, successor: null });
    const r = await buildSetSuccessor(await withRecord(revoked, [successorUtxo()]), { ...common, successor: SUCCESSOR });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'SetSuccessor' });
    assert.deepEqual(b.datum, { ...revoked, status: { ...revoked.status, successor: SUCCESSOR } as Status });
    assert.deepEqual(b.signers, new Set([CONTROLLER.keyHash, OTHER.keyHash]));
    assert.equal(b.lovelace, 10_000_000n);
    const named = tombstone(rootRecord(), { type: 'Retired', at: NOW - DAY, successor: 'cc'.repeat(32) });
    await assert.rejects(buildSetSuccessor(await withRecord(named, [successorUtxo()]), { ...common, successor: SUCCESSOR }), /already names the successor/);
    await assert.rejects(buildSetSuccessor(await withRecord(rootRecord(), [successorUtxo()]), { ...common, successor: SUCCESSOR }), /is live \(Active\): SetSuccessor applies only/);
  });
});

describe('recovery: start, cancel, complete', () => {
  const guarded = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, GUARDIAN_A_PARTY, GUARDIAN_B_PARTY], guardianThreshold: 2 });
  const pending = (effectiveAfter: number): IdentityDatum => ({ ...guarded, pendingRecovery: { newController: NEW_CONTROLLER.publicKey, effectiveAfter } });

  test('start: the guardians (by key hash or index) and the new controller sign; pending until hi + 7 days', async () => {
    const r = await buildRecoveryStart(await withRecord(guarded), { ...common, newController: NEW_CONTROLLER.publicKey, guardians: [GUARDIAN_A.keyHash, 2] });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'RecoverInit', guardians: [1, 2] });
    assert.deepEqual(b.datum, pending(hi + DAYS_7_MS));
    assert.deepEqual(b.signers, new Set([GUARDIAN_A.keyHash, GUARDIAN_B.keyHash, NEW_CONTROLLER.keyHash]));
    assert.deepEqual(r.guardians, [1, 2]);
    assert.equal(b.lovelace, 10_000_000n);
  });

  test('start refusals name the rule', async () => {
    const start = (guardians: Array<number | string>) => ({ ...common, newController: NEW_CONTROLLER.publicKey, guardians });
    await assert.rejects(buildRecoveryStart(await withRecord(rootRecord()), start([0])), /guardian threshold of 0, so recovery is off/);
    await assert.rejects(buildRecoveryStart(await withRecord(pending(NOW + DAY)), start([1, 2])), /is already pending/);
    await assert.rejects(buildRecoveryStart(await withRecord(guarded), start([1])), /needs 2 guardians to act together; 1 named/);
    await assert.rejects(buildRecoveryStart(await withRecord(guarded), start([0, 1])), /Accountable Party \(the controller\) at index 0 is not a guardian/);
    await assert.rejects(buildRecoveryStart(await withRecord(guarded), start([1, GUARDIAN_A.keyHash])), /is named twice/);
    await assert.rejects(buildRecoveryStart(await withRecord(guarded), start([OTHER.keyHash, 1])), /no Guardian Party with the key hash/);
    await assert.rejects(buildRecoveryStart(await withRecord(guarded), start([1, 7])), /has 3 parties; there is no party at index 7/);
    const ending = rootRecord({ parties: [CONTROLLER_ACCOUNTABLE, GUARDIAN_A_PARTY, { ...GUARDIAN_B_PARTY, notAfter: NOW }], guardianThreshold: 2 });
    await assert.rejects(buildRecoveryStart(await withRecord(ending), start([1, 2])), /does not cover the validity window/);
  });

  test('cancel: the guardians sign; the pending recovery ends', async () => {
    const r = await buildRecoveryCancel(await withRecord(pending(NOW + DAY)), { ...common, guardians: [1, 2] });
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'RecoverCancel', guardians: [1, 2] });
    assert.deepEqual(b.datum, guarded);
    assert.deepEqual(b.signers, new Set([GUARDIAN_A.keyHash, GUARDIAN_B.keyHash]));
    await assert.rejects(buildRecoveryCancel(await withRecord(guarded), { ...common, guardians: [1, 2] }), /no pending recovery to cancel/);
  });

  test('complete: anybody once effective_after <= lo; the new controller, epoch + 1; an early build says when it opens', async () => {
    const r = await buildRecoveryComplete(await withRecord(pending(lo)), common);
    const b = inspect(r);
    assert.deepEqual(b.spend, { type: 'RecoverFinalize' });
    assert.deepEqual(b.datum, { ...guarded, controller: NEW_CONTROLLER.publicKey, subagentEpoch: 1 });
    assert.deepEqual(b.signers, new Set());
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [OWN_KEY_HASH]);
    await assert.rejects(buildRecoveryComplete(await withRecord(pending(lo + 1000)), common),
      new RegExp(`opens at ${new Date(lo + 1000).toISOString()}.*build it at or after ${new Date(lo + 61_000).toISOString()}`));
    await assert.rejects(buildRecoveryComplete(await withRecord(guarded), common), /no pending recovery to complete/);
  });
});

describe('every action but Reclaim and SetSuccessor refuses an ended record', () => {
  test('each refusal says the record has ended and which actions remain', async () => {
    const ctx = () => withRecord(RETIRED, [successorUtxo()]);
    const guardians = { guardians: [1] };
    for (const build of [
      async () => buildUpdate(await ctx(), { ...common, guardianThreshold: 1 }),
      async () => buildChangeController(await ctx(), { ...common, newController: OTHER.publicKey }),
      async () => buildSuspend(await ctx(), common),
      async () => buildUnsuspend(await ctx(), common),
      async () => buildRevoke(await ctx(), { ...common, reason: 0 }),
      async () => buildRetire(await ctx(), common),
      async () => buildEndSubagents(await ctx(), common),
      async () => buildRecoveryStart(await ctx(), { ...common, ...guardians, newController: NEW_CONTROLLER.publicKey }),
      async () => buildRecoveryCancel(await ctx(), { ...common, ...guardians }),
      async () => buildRecoveryComplete(await ctx(), common),
    ]) await assert.rejects(build(), /has ended \(Retired\); only Reclaim and SetSuccessor apply to it/);
  });
});
