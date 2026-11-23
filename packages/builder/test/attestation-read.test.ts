// packages/builder/test/attestation-read.test.ts
// The reads of attestations (attestation-read.ts) on the attestations that mainnet holds (the capture of capture-ledger-read.mjs) and on
// synthetic ones where mainnet has no example (a start time, an envelope, an invalid-from time, a decoy). The node is an offline
// world and Koios is a fake: no network. Each refusal of the check has its accepted twin.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML, Constr, Data, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { envelopeSigStructure } from '../src/vector/attestation-build.ts';
import { attestationState, checkAttestation, issuerMatches, listAttestations, parseIssuer, readAttestation, readAttestationDatum } from '../src/vector/attestation-read.ts';
import type { AttestationCheck, AttestationExpectations, CheckLine } from '../src/vector/attestation-read.ts';
import { decodeAttestationDatum, encodeAttestationDatum } from '../src/vector/identity-codec.ts';
import type { AttestationDatum, IdentityDatum } from '../src/vector/identity-codec.ts';
import { keyHashOf } from '../src/vector/identity-rules.ts';
import { credentialOutputs, MAX_PAGE } from '../src/vector/ledger-read.ts';
import { CAPTURE, CAPTURE_MS, DAY, ISSUER_KEY, MAINNET, attestation, attestationIdOf, attestationUtxo, callsTo, capturedUtxos, koiosRow, ledgerWorld, liveRecord, recordUtxo, revokedWithReason, revokedWithStatus } from './fixtures/ledger-read-world.ts';
import type { LedgerWorld } from './fixtures/ledger-read-world.ts';
import { IDENTITY_POINT_HEX, UNIVERSAL_SIGNATURE_HEX, signatureWithIdentityR } from './fixtures/small-order.ts';

// ─── The attestations of mainnet ──────────────────────────────────────────────────────────────────────────────────────────────

const CAPTURED = CAPTURE.attestations.map((row) => ({ id: attestationIdOf(row), row, datum: decodeAttestationDatum(row.inline_datum!.bytes) }));
const REVOKED = CAPTURED.find((a) => a.datum.status.type === 'AttRevoked')!;
const ENVIRONMENT = CAPTURED.filter((a) => a.datum.attType === 3);
const KEY_ONLY = CAPTURED.filter((a) => a.datum.issuerId === null);
const REGISTERED_ISSUERS = [...new Set(CAPTURED.flatMap((a) => (a.datum.issuerId === null ? [] : [a.datum.issuerId])))];
/** The subject of the first environment attestation: it has three attestations, by two issuers. */
const SUBJECT = ENVIRONMENT[0].datum.subject;
const ISSUER_ID = ENVIRONMENT[0].datum.issuerId!;
const iso = (ms: number): string => new Date(ms).toISOString();

/** The captured outputs, a record for each registered issuer (Active, unless `records` gives one), and `extra`. */
function world(extra: UTxO[] = [], records: Record<string, IdentityDatum> = {}): LedgerWorld {
  const issuers = REGISTERED_ISSUERS.filter((id) => records[id] === undefined).map((id) => recordUtxo(id, liveRecord()));
  return ledgerWorld([...capturedUtxos(), ...issuers, ...Object.entries(records).map(([id, r]) => recordUtxo(id, r)), ...extra]);
}
/** The attestations of `list`, in the order of the lists: newest issued_at first, then identifier. */
const newest = (list: typeof CAPTURED): string[] => [...list].sort((a, b) => b.datum.issuedAt - a.datum.issuedAt || (a.id < b.id ? -1 : 1)).map((a) => a.id);
/** What the last credential_utxos request of the world asked Koios to filter on: the datum, the token of the attestation policy, or neither. */
const filtersOf = (w: LedgerWorld): { datum: string | null; token: string | null } => {
  const calls = callsTo(w.koios, 'credential_utxos');
  const q = new URL(calls[calls.length - 1].url).searchParams;
  return { datum: q.get('inline_datum->>bytes'), token: q.get('asset_list') };
};
/** The token filter of a list: Koios keeps the outputs that hold a token of the attestation policy. */
const TOKEN_FILTER = `cs.[{"policy_id":"${MAINNET.attestation.hash}"}]`;
/** The datum filter of a list that names a 32-byte value: Koios keeps the outputs whose datum holds its bytes. */
const like = (hex: string): string => `like.*${hex}*`;

describe('the capture', () => {
  test('holds the 27 attestations of mainnet: types 0, 3 and 15, one revoked, the issuers with and without a record', () => {
    assert.equal(CAPTURED.length, 27);
    assert.deepEqual([...new Set(CAPTURED.map((a) => a.datum.attType))].sort((a, b) => a - b), [0, 3, 15]);
    assert.equal(CAPTURED.filter((a) => a.datum.attType === 0).length, 1);
    assert.equal(ENVIRONMENT.length, 2);
    assert.equal(CAPTURED.filter((a) => a.datum.status.type === 'AttRevoked').length, 1);
    assert.equal(REVOKED.datum.attType, 0);
    assert.equal(REVOKED.id, '8a4af9dbe4c2a356da2279391d3ed6a5717ca542bdbc86da0c5a0b3b361f1cb4');
    assert.ok(KEY_ONLY.length > 0 && KEY_ONLY.length < CAPTURED.length, 'issuers without a record and with one are both there');
  });
});

// ─── readAttestation ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('readAttestation', () => {
  const w = world();
  test('the revoked identity attestation: every field, its status, its output and the time from which its deposit can be withdrawn', async () => {
    const v = (await readAttestation(w.env, REVOKED.id))!;
    assert.equal(v.id, REVOKED.id);
    assert.equal(v.ref, `${REVOKED.row.tx_hash}#${REVOKED.row.tx_index}`);
    assert.equal(v.lovelace, 5_000_000n);
    assert.deepEqual(v.attestation, REVOKED.datum);
    assert.equal(v.attestation.status.type, 'AttRevoked');
    assert.equal(v.withdrawableFrom, (v.attestation.status as { at: number }).at + 90 * DAY, 'revoked: 90 days after the revocation');
  });
  test('an environment attestation can be withdrawn 90 days after valid_until; an active one without valid_until, not before it is revoked', async () => {
    const env = (await readAttestation(w.env, ENVIRONMENT[0].id))!;
    assert.equal(env.withdrawableFrom, env.attestation.validUntil! + 90 * DAY);
    const other = CAPTURED.find((a) => a.datum.attType === 15 && a.datum.validUntil === null)!;
    assert.equal((await readAttestation(w.env, other.id))!.withdrawableFrom, null);
  });
  test('an identifier that no output holds is null, a capital letter in it does not matter, and a malformed one is an error', async () => {
    assert.equal(await readAttestation(w.env, 'ee'.repeat(32)), null);
    assert.equal((await readAttestation(w.env, REVOKED.id.toUpperCase()))!.id, REVOKED.id);
    await assert.rejects(() => readAttestation(w.env, 'abc'), /not an identifier/);
  });
  test('every captured attestation reads as the output that the capture holds', async () => {
    for (const a of CAPTURED) assert.equal((await readAttestation(w.env, a.id))!.utxo.datum, a.row.inline_datum!.bytes, a.id);
  });
  test('a revoked attestation whose reason is above 2^53 is read: the reason is exact, the number of the datum is NaN, and every other field is read', async () => {
    const id = 'f6'.repeat(32);
    const reason = 2n ** 60n + 7n;
    const v = (await readAttestation(ledgerWorld([attestationUtxo(id, attestation(), { datum: revokedWithReason(reason) })]).env, id))!;
    assert.equal(v.revokeReason, reason);
    const status = v.attestation.status;
    assert.equal(status.type, 'AttRevoked');
    if (status.type === 'AttRevoked') { assert.ok(Number.isNaN(status.reason)); assert.equal(status.at, CAPTURE_MS - DAY); }
    assert.equal(v.attestation.subject, attestation().subject);
    assert.throws(() => decodeAttestationDatum(revokedWithReason(reason)), /outside the safe range/, 'the codec of the builders refuses this datum');
  });
  test('the reason of a revocation is a bigint, and an active attestation has none', async () => {
    const status = REVOKED.datum.status;
    assert.equal(status.type, 'AttRevoked');
    if (status.type === 'AttRevoked') assert.equal((await readAttestation(w.env, REVOKED.id))!.revokeReason, BigInt(status.reason));
    assert.equal((await readAttestation(w.env, ENVIRONMENT[0].id))!.revokeReason, null);
  });
});

describe('readAttestationDatum', () => {
  const revoked = (reason: number) => attestation({ status: { type: 'AttRevoked', at: CAPTURE_MS - DAY, reason } });
  test('a datum that the codec reads is read as the codec reads it, with its reason as a bigint', () => {
    const read = readAttestationDatum(encodeAttestationDatum(revoked(3)));
    assert.deepEqual(read.datum, revoked(3));
    assert.equal(read.revokeReason, 3n);
    assert.deepEqual(readAttestationDatum(encodeAttestationDatum(attestation())), { datum: attestation(), revokeReason: null });
    const edge = readAttestationDatum(encodeAttestationDatum(revoked(Number.MAX_SAFE_INTEGER)));
    assert.equal(edge.revokeReason, BigInt(Number.MAX_SAFE_INTEGER), 'the largest reason that a number holds is read by the codec');
  });
  test('a reason that a number cannot hold is read exactly: 2^53, 2^63 - 1, more than that, and below 0', () => {
    for (const reason of [2n ** 53n, 2n ** 63n - 1n, 2n ** 70n, -5n]) {
      const read = readAttestationDatum(revokedWithReason(reason));
      assert.equal(read.revokeReason, reason, String(reason));
      assert.equal(read.datum.status.type, 'AttRevoked');
      assert.deepEqual({ ...read.datum, status: attestation().status }, attestation(), 'every other field is as it was');
    }
  });
  test('a datum that fails for another reason fails too, with a reason that a number cannot hold or without; so does what is not Plutus Data', () => {
    const short = (hex: string) => hex.replace(`5820${attestation().subject}`, `581f${attestation().subject.slice(0, 62)}`);
    const wide = revokedWithReason(2n ** 60n);
    assert.notEqual(short(wide), wide, 'the subject was made shorter');
    assert.throws(() => readAttestationDatum(short(wide)), /subject/);
    assert.throws(() => readAttestationDatum(short(encodeAttestationDatum(attestation()))), /subject/);
    assert.throws(() => readAttestationDatum(short(encodeAttestationDatum(revoked(3)))), /subject/);
    assert.throws(() => readAttestationDatum('zz'));
    assert.throws(() => readAttestationDatum('00'));
  });
  test('a revocation that is not an instant and one integer is not read wide: a third field, a missing reason, no field, a reason of bytes', () => {
    const at = BigInt(CAPTURE_MS - DAY);
    for (const [what, status] of [['a third field', [at, 2n ** 60n, 7n]], ['a missing reason', [at]], ['no field', []], ['a reason of bytes', [at, 'ab']]] as Array<[string, Data[]]>) {
      assert.throws(() => readAttestationDatum(revokedWithStatus(status)), Error, what);
    }
    assert.equal(readAttestationDatum(revokedWithStatus([at, 2n ** 60n])).revokeReason, 2n ** 60n, 'the twin: an instant and one integer');
  });
  test('a datum whose outer constructor is not 0 is not read wide: the twin with constructor 0 is', () => {
    const wide = Data.from(revokedWithReason(2n ** 60n));
    assert.ok(wide instanceof Constr && wide.index === 0 && wide.fields.length === 16);
    assert.equal(readAttestationDatum(Data.to(wide)).revokeReason, 2n ** 60n);
    assert.throws(() => readAttestationDatum(Data.to(new Constr(1, wide.fields))), Error);
  });
});

// ─── States, issuers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('attestationState', () => {
  const HOUR = 3_600_000;
  test('revoked beats everything; the bounds are inclusive', () => {
    const t = CAPTURE_MS;
    assert.equal(attestationState(attestation(), t), 'active');
    assert.equal(attestationState(attestation({ status: { type: 'AttRevoked', at: t - 1, reason: 0 }, validUntil: t - 5 }), t), 'revoked');
    assert.equal(attestationState(attestation({ validUntil: t }), t), 'active', 'at valid_until it is still inside');
    assert.equal(attestationState(attestation({ validUntil: t - 1 }), t), 'expired');
    assert.equal(attestationState(attestation({ validFrom: t }), t), 'active', 'at valid_from it is already inside');
    assert.equal(attestationState(attestation({ validFrom: t + 1 }), t), 'not_yet_valid');
    assert.equal(attestationState(attestation({ validFrom: t - DAY, validUntil: t + DAY }), t), 'active');
  });
  test('a time more than one hour before issued_at is before the attestation existed; an hour before is not', () => {
    const issued = CAPTURE_MS;
    assert.equal(attestationState(attestation({ issuedAt: issued }), issued - HOUR), 'active', 'the validity window of the transaction can have started then');
    assert.equal(attestationState(attestation({ issuedAt: issued }), issued - HOUR - 1), 'not_yet_valid');
    assert.equal(attestationState(attestation({ issuedAt: issued }), 0), 'not_yet_valid', 'the epoch is before any attestation');
    assert.equal(attestationState(attestation({ issuedAt: issued }), issued + 5 * DAY), 'active', 'a time after issued_at is fine');
    assert.equal(attestationState(attestation({ issuedAt: issued, validFrom: issued - 10 * DAY }), issued - 2 * HOUR), 'not_yet_valid', 'a valid_from in the past does not make it exist earlier');
    assert.equal(attestationState(attestation({ issuedAt: issued, status: { type: 'AttRevoked', at: issued, reason: 1 } }), issued - 2 * HOUR), 'revoked');
    assert.equal(attestationState(attestation({ issuedAt: issued, validUntil: issued + DAY }), issued + DAY + 1), 'expired');
  });
});

describe('parseIssuer and issuerMatches', () => {
  const key = ISSUER_KEY.publicKey;
  test('a DID, a key hash, and 64 hex that can be an issuer identifier or a public key', () => {
    assert.deepEqual(parseIssuer(`did:vector:${'ab'.repeat(32)}`), { type: 'did', id: 'ab'.repeat(32) });
    assert.deepEqual(parseIssuer(`  ${ISSUER_KEY.keyHash.toUpperCase()} `), { type: 'key_hash', hash: ISSUER_KEY.keyHash });
    assert.deepEqual(parseIssuer(key.toUpperCase()), { type: 'id_or_key', value: key });
    assert.deepEqual(parseIssuer(`did:vector:agent:${'cd'.repeat(28)}:${'ef'.repeat(32)}`), { type: 'did', id: 'ef'.repeat(32) });
  });
  test('refuses what is none of these', () => {
    for (const bad of ['', 'abc', 'ab'.repeat(29), 'did:vector:abc', 'did:other:x', `${key}00`]) assert.throws(() => parseIssuer(bad), /issuer|did:vector/i, JSON.stringify(bad));
  });
  test('a DID matches issuer_id, a key and a key hash match the issuer key by its key hash', () => {
    const registered = attestation({ issuerId: 'ab'.repeat(32) });
    const keyOnly = attestation();
    assert.equal(issuerMatches(registered, { type: 'did', id: 'ab'.repeat(32) }), true);
    assert.equal(issuerMatches(registered, { type: 'did', id: 'ac'.repeat(32) }), false);
    assert.equal(issuerMatches(keyOnly, { type: 'did', id: 'ab'.repeat(32) }), false, 'a key without a record has no issuer_id');
    for (const a of [registered, keyOnly]) {
      assert.equal(issuerMatches(a, { type: 'key', publicKey: key }), true);
      assert.equal(issuerMatches(a, { type: 'key_hash', hash: ISSUER_KEY.keyHash }), true);
      assert.equal(issuerMatches(a, { type: 'key_hash', hash: '00'.repeat(28) }), false);
      assert.equal(issuerMatches(a, { type: 'key', publicKey: 'ab'.repeat(32) }), false);
    }
  });
  test('64 hex match by either reading: the identifier of the issuer, or its public key', () => {
    const registered = attestation({ issuerId: 'ab'.repeat(32) });
    assert.equal(issuerMatches(registered, { type: 'id_or_key', value: 'ab'.repeat(32) }), true, 'as the identifier of the issuer');
    assert.equal(issuerMatches(registered, { type: 'id_or_key', value: key }), true, 'as the public key of the issuer');
    assert.equal(issuerMatches(registered, { type: 'id_or_key', value: 'cd'.repeat(32) }), false, 'as neither');
    assert.equal(issuerMatches(attestation(), { type: 'id_or_key', value: key }), true, 'a key without a record matches as a key');
    assert.equal(issuerMatches(attestation(), { type: 'id_or_key', value: 'ab'.repeat(32) }), false, 'a key without a record has no identifier');
  });
  test('issuer_id is compared with a DID only, and the issuer key only as a key', () => {
    assert.equal(issuerMatches(attestation({ issuerId: key }), { type: 'did', id: key }), true);
    assert.equal(issuerMatches(attestation({ issuerId: key, issuer: 'ab'.repeat(32) }), { type: 'key', publicKey: key }), false, 'issuer_id equal to a key is not that key');
  });
});

// ─── listAttestations ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('listAttestations on the capture', () => {
  const ids = (page: { items: Array<{ id: string }> }): string[] => page.items.map((v) => v.id);

  test('by subject: the three attestations about one agent, newest first; Koios narrows the read to the outputs that hold the token and the bytes of the subject', async () => {
    const w = world();
    const page = await listAttestations(w.env, { subject: `did:vector:${SUBJECT}` });
    const expected = newest(CAPTURED.filter((a) => a.datum.subject === SUBJECT));
    assert.equal(expected.length, 3);
    assert.deepEqual(ids(page), expected);
    assert.deepEqual([page.total, page.nextOffset], [3, null]);
    assert.deepEqual(filtersOf(w), { datum: like(SUBJECT), token: TOKEN_FILTER });
  });
  test('by issuer DID: the attestations that name the issuer; the read is narrowed by the bytes of the identifier', async () => {
    const w = world();
    const page = await listAttestations(w.env, { issuer: { type: 'did', id: ISSUER_ID } });
    assert.deepEqual(ids(page), newest(CAPTURED.filter((a) => a.datum.issuerId === ISSUER_ID)));
    assert.ok(page.total! >= 2);
    assert.deepEqual(filtersOf(w), { datum: like(ISSUER_ID), token: TOKEN_FILTER });
  });
  test('by issuer public key and by its key hash: the same attestations; the key narrows the read on the server, and the key hash cannot', async () => {
    const issuerKey = ENVIRONMENT[0].datum.issuer;
    const expected = newest(CAPTURED.filter((a) => a.datum.issuer === issuerKey));
    assert.ok(expected.length >= 2);
    const byKey = world();
    assert.deepEqual(ids(await listAttestations(byKey.env, { issuer: { type: 'key', publicKey: issuerKey } })), expected);
    assert.deepEqual(filtersOf(byKey), { datum: like(issuerKey), token: TOKEN_FILTER });
    const byHash = world();
    assert.deepEqual(ids(await listAttestations(byHash.env, { issuer: { type: 'key_hash', hash: keyHashOf(issuerKey) } })), expected);
    assert.deepEqual(filtersOf(byHash), { datum: null, token: TOKEN_FILTER }, 'a datum holds the key and not its hash: there is nothing to filter by');
  });
  test('by the key of an issuer without a record, which signed many attestations', async () => {
    const key = KEY_ONLY[0].datum.issuer;
    const page = await listAttestations(world().env, { issuer: { type: 'key_hash', hash: keyHashOf(key) }, limit: MAX_PAGE });
    assert.deepEqual(ids(page), newest(CAPTURED.filter((a) => a.datum.issuer === key)));
    assert.ok(page.items.every((v) => v.attestation.issuerId === null));
  });
  test('by subject and issuer: both must hold; the read is narrowed by the bytes of the subject, and the issuer is compared on the decoded datum', async () => {
    const w = world();
    assert.deepEqual(ids(await listAttestations(w.env, { subject: SUBJECT, issuer: { type: 'did', id: ISSUER_ID } })), newest(CAPTURED.filter((a) => a.datum.subject === SUBJECT && a.datum.issuerId === ISSUER_ID)));
    assert.equal((await listAttestations(w.env, { subject: SUBJECT, issuer: { type: 'did', id: 'ab'.repeat(32) } })).total, 0);
    assert.deepEqual(filtersOf(w), { datum: like(SUBJECT), token: TOKEN_FILTER });
  });
  test('by type: the environment attestation of the subject, and none of another type', async () => {
    const w = world();
    assert.deepEqual(ids(await listAttestations(w.env, { subject: SUBJECT, attType: 3 })), [ENVIRONMENT[0].id]);
    assert.equal((await listAttestations(w.env, { subject: SUBJECT, attType: 5 })).total, 0);
  });
  test('pages: a limit and an offset, the pages join up, and the total and the next offset tell the rest', async () => {
    const key = KEY_ONLY[0].datum.issuer;
    const all = newest(CAPTURED.filter((a) => a.datum.issuer === key));
    assert.ok(all.length > 4);
    const w = world();
    const first = await listAttestations(w.env, { issuer: { type: 'key', publicKey: key }, limit: 4 });
    assert.deepEqual([ids(first), first.total, first.offset, first.limit, first.nextOffset], [all.slice(0, 4), all.length, 0, 4, 4]);
    const joined: string[] = [];
    let next: number | null = 0;
    // The bound makes a next offset that never ends fail the test, and not hang it.
    for (let pages = 0; next !== null && pages < 10; pages++) {
      const p = await listAttestations(w.env, { issuer: { type: 'key', publicKey: key }, limit: 4, offset: next });
      joined.push(...ids(p));
      next = p.nextOffset;
    }
    assert.equal(next, null, 'the pages end');
    assert.deepEqual(joined, all);
  });
  test('refuses a type with neither a subject nor an issuer, a subject that is not an identifier and a page that is not one, before Koios is asked', async () => {
    const w = world();
    await assert.rejects(() => listAttestations(w.env, { attType: 3 }), /A type narrows a list by subject or by issuer: name one of them/);
    await assert.rejects(() => listAttestations(w.env, { subject: 'abc' }), /not a did:vector DID/);
    await assert.rejects(() => listAttestations(w.env, { subject: SUBJECT, limit: 0 }), /limit must be/);
    await assert.rejects(() => listAttestations(w.env, { subject: SUBJECT, offset: -1 }), /offset must be/);
    await assert.rejects(() => listAttestations(w.env, { limit: 51 }), /limit must be/);
    assert.equal(callsTo(w.koios, 'credential_utxos').length, 0, 'every refusal comes before the first request to Koios');
  });
  test('an unknown subject has no attestation', async () => {
    const page = await listAttestations(world().env, { subject: 'ee'.repeat(32) });
    assert.deepEqual([page.items.length, page.total, page.nextOffset], [0, 0, null]);
  });
});

describe('listAttestations: decoys and the exact filter', () => {
  const S = 'a1'.repeat(32);
  const id = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
  const about = attestationUtxo(id(1), attestation({ subject: S }));

  test('a 32-byte value in other fields of a datum is not the subject: Koios matches the bytes, the decoded field decides', async () => {
    const decoys = [
      attestationUtxo(id(2), attestation({ subject: 'b2'.repeat(32), digest: S })),
      attestationUtxo(id(3), attestation({ subject: 'b3'.repeat(32), issuerId: S })),
      attestationUtxo(id(4), attestation({ subject: 'b4'.repeat(32), links: [{ rel: 1, target: S }] })),
      attestationUtxo(id(5), attestation({ subject: 'b5'.repeat(32), profile: S })),
    ];
    const w = ledgerWorld([about, ...decoys]);
    assert.equal((await credentialOutputs(w.env, MAINNET.attestation.hash, { datumContains: S }, 'narrow')).length, 5, 'a datum filter sends the decoys too');
    assert.deepEqual((await listAttestations(w.env, { subject: S })).items.map((v) => v.id), [id(1)]);
    const noFilter = ledgerWorld([about, ...decoys], { ignoreAssetFilter: true });
    assert.deepEqual((await listAttestations(noFilter.env, { subject: S })).items.map((v) => v.id), [id(1)], 'a Koios that ignores the token filter changes nothing');
  });
  test('the issuer filter is exact too: a DID is the issuer_id and never a digest, a subject or a link target', async () => {
    const issued = attestationUtxo(id(6), attestation({ subject: 'b6'.repeat(32), issuerId: S }));
    const asSubject = attestationUtxo(id(7), attestation({ subject: S }));
    const asDigest = attestationUtxo(id(8), attestation({ subject: 'b8'.repeat(32), digest: S }));
    const asLink = attestationUtxo(id(9), attestation({ subject: 'b9'.repeat(32), links: [{ rel: 0, target: S }] }));
    const w = ledgerWorld([issued, asSubject, asDigest, asLink]);
    assert.deepEqual((await listAttestations(w.env, { issuer: { type: 'did', id: S } })).items.map((v) => v.id), [id(6)]);
  });
  test('a key that is the digest of another attestation does not make it an attestation by that key', async () => {
    const decoy = attestationUtxo(id(10), attestation({ digest: ISSUER_KEY.publicKey, issuer: 'ee'.repeat(32), subject: 'b0'.repeat(32) }));
    const w = ledgerWorld([attestationUtxo(id(11), attestation({ subject: 'b1'.repeat(32) })), decoy]);
    assert.equal((await credentialOutputs(w.env, MAINNET.attestation.hash, { datumContains: ISSUER_KEY.publicKey }, 'narrow')).length, 2);
    assert.deepEqual((await listAttestations(w.env, { issuer: { type: 'key', publicKey: ISSUER_KEY.publicKey } })).items.map((v) => v.id), [id(11)]);
  });
  test('an output counts only when it is authentic: at exactly the attestation address, with exactly one attestation token', async () => {
    const staked = credentialToAddress('Mainnet', { type: 'Script', hash: MAINNET.attestation.hash }, { type: 'Key', hash: 'ee'.repeat(28) });
    const twoTokens = attestationUtxo(id(12), attestation({ subject: S }));
    twoTokens.assets[`${MAINNET.attestation.hash}${id(13)}`] = 1n;
    const noToken = attestationUtxo(id(14), attestation({ subject: S }), { assets: { lovelace: 5_000_000n } });
    const twice = attestationUtxo(id(15), attestation({ subject: S }));
    twice.assets[`${MAINNET.attestation.hash}${id(15)}`] = 2n;
    const decoys = [attestationUtxo(id(16), attestation({ subject: S }), { address: staked }), twoTokens, noToken, twice];
    assert.equal((await listAttestations(ledgerWorld(decoys).env, { subject: S })).total, 0, 'every decoy is refused');
    const withGenuine = await listAttestations(ledgerWorld([...decoys, about]).env, { subject: S });
    assert.deepEqual(withGenuine.items.map((v) => v.id), [id(1)], 'the genuine attestation among them is listed');
  });
  test('a datum that does not decode is left out', async () => {
    const junk = attestationUtxo(id(17), attestation({ subject: S }), { datum: `d8799f5820${S}ff` });
    assert.deepEqual((await listAttestations(ledgerWorld([junk, about]).env, { subject: S })).items.map((v) => v.id), [id(1)]);
    assert.equal((await listAttestations(ledgerWorld([attestationUtxo(id(18), attestation({ subject: S }), { datum: null })]).env, { subject: S })).total, 0);
  });
  test('the order is newest issued_at first, then identifier, whatever order Koios lists them in', async () => {
    const a = attestationUtxo(id(0x30), attestation({ subject: S, issuedAt: CAPTURE_MS }));
    const b = attestationUtxo(id(0x20), attestation({ subject: S, issuedAt: CAPTURE_MS }));
    const c = attestationUtxo(id(0x40), attestation({ subject: S, issuedAt: CAPTURE_MS + 1 }));
    const d = attestationUtxo(id(0x10), attestation({ subject: S, issuedAt: CAPTURE_MS - 1 }));
    for (const order of [[a, b, c, d], [d, c, b, a], [b, d, a, c]]) {
      assert.deepEqual((await listAttestations(ledgerWorld(order).env, { subject: S })).items.map((v) => v.id), [id(0x40), id(0x20), id(0x30), id(0x10)]);
    }
  });
  test('a revoked attestation with a reason above 2^53 is listed: it does not drop out of the list', async () => {
    const wide = attestationUtxo(id(0x50), attestation({ subject: S }), { datum: revokedWithReason(2n ** 60n, { subject: S }) });
    const page = await listAttestations(ledgerWorld([wide, about]).env, { subject: S });
    assert.deepEqual(page.items.map((v) => v.id), [id(1), id(0x50)]);
    assert.equal(page.items[1].revokeReason, 2n ** 60n);
    assert.equal(page.items[0].revokeReason, null);
  });
  test('a 32-byte subject that a datum writes as chunks of bytes is not listed: a filter on its hex does not find the row, and the attestation is read by its identifier', async () => {
    const canonical = encodeAttestationDatum(attestation({ subject: S }));
    const chunked = canonical.replace(`5820${S}`, `5f5810${S.slice(0, 32)}5810${S.slice(32)}ff`);
    assert.notEqual(chunked, canonical, 'the datum was rewritten');
    assert.equal(decodeAttestationDatum(chunked).subject, S, 'the codec reads the chunks as the subject');
    const w = ledgerWorld([attestationUtxo(id(0x51), attestation({ subject: S }), { datum: chunked })]);
    assert.equal((await listAttestations(w.env, { subject: S })).total, 0, 'the list does not find it');
    assert.equal((await credentialOutputs(w.env, MAINNET.attestation.hash, { datumContains: S }, 'narrow')).length, 0, 'the filter on hex misses it');
    assert.equal((await readAttestation(w.env, id(0x51)))!.attestation.subject, S, 'the read by identifier finds it');
    const twin = ledgerWorld([attestationUtxo(id(0x52), attestation({ subject: S }))]);
    assert.deepEqual((await listAttestations(twin.env, { subject: S })).items.map((v) => v.id), [id(0x52)], 'the twin: the standard form is listed');
  });
  test('outputs without a token do not count toward the limit of 5,000 outputs: 5,001 of them and one attestation are listed as one', async () => {
    const template = koiosRow(about);
    const junk = Array.from({ length: 5_001 }, (_, i) => ({ ...template, tx_hash: (i + 1).toString(16).padStart(8, '0').repeat(8), asset_list: [] }));
    const w = ledgerWorld([about], { rows: [...junk, template] });
    assert.deepEqual((await listAttestations(w.env, { subject: S })).items.map((v) => v.id), [id(1)]);
  });
  test('5,000 attestation outputs end the read: the call fails and says to read one attestation by its identifier', async () => {
    const template = koiosRow(about);
    const many = Array.from({ length: 5_000 }, (_, i) => ({ ...template, tx_hash: (i + 1).toString(16).padStart(8, '0').repeat(8), asset_list: [{ policy_id: MAINNET.attestation.hash, asset_name: (i + 1).toString(16).padStart(64, '0'), quantity: '1' }] }));
    await assert.rejects(() => listAttestations(ledgerWorld([], { rows: many }).env, { subject: S }), /5000 or more outputs match at the script f07c644e.*read one attestation by its identifier \(vector_get_attestation\)/);
  });
  test('a row that Koios sends without an asset list fails the list: the answer is incomplete', async () => {
    const bad = { ...koiosRow(about), asset_list: null as unknown as unknown[] };
    await assert.rejects(() => listAttestations(ledgerWorld([], { rows: [bad], ignoreAssetFilter: true }).env, { subject: S }), /no asset list: the answer is incomplete/);
    assert.deepEqual((await listAttestations(ledgerWorld([], { rows: [koiosRow(about)], ignoreAssetFilter: true }).env, { subject: S })).items.map((v) => v.id), [id(1)]);
  });
});

describe('listAttestations: the limit of 5,000 outputs is the limit of one subject or one issuer, and a list of every attestation is paged by Koios', () => {
  const S = 'a1'.repeat(32);
  const OTHER = 'b7'.repeat(32);
  const id = (n: number): string => n.toString(16).padStart(64, '0');
  const hash = (n: number): string => n.toString(16).padStart(8, '0').repeat(8);
  const about = attestationUtxo(id(1), attestation({ subject: S }));
  const token = (n: number) => [{ policy_id: MAINNET.attestation.hash, asset_name: id(n), quantity: '1' }];
  /** `count` rows of the attestation `template` with other references, each holding its own token, or none when `tokens` is false. */
  const rowsLike = (template: UTxO, count: number, first: number, tokens = true) => Array.from({ length: count }, (_, i) => ({ ...koiosRow(template), tx_hash: hash(first + i), asset_list: tokens ? token(first + i) : [] }));
  const questions = (w: LedgerWorld) => callsTo(w.koios, 'credential_utxos');

  test('5,000 attestation outputs of other subjects do not make the list of one subject fail', async () => {
    const others = rowsLike(attestationUtxo(id(2), attestation({ subject: OTHER })), 5_001, 0x1000);
    const w = ledgerWorld([about], { rows: [...others, koiosRow(about)] });
    const page = await listAttestations(w.env, { subject: S });
    assert.deepEqual([page.items.map((v) => v.id), page.total], [[id(1)], 1]);
    assert.equal(questions(w).length, 1, 'one request: the others do not come over the wire');
    // The twin: the same 5,000 outputs name the subject, and then the call fails.
    const named = rowsLike(attestationUtxo(id(2), attestation({ subject: S })), 5_000, 0x1000);
    await assert.rejects(() => listAttestations(ledgerWorld([], { rows: named }).env, { subject: S }), /5000 or more outputs match/);
  });
  test('5,000 attestation outputs of other issuers do not make the list of one issuer fail, by DID, by public key and by 64 hex', async () => {
    const others = rowsLike(attestationUtxo(id(2), attestation({ subject: OTHER, issuer: 'dd'.repeat(32), issuerId: 'ee'.repeat(32) })), 5_001, 0x1000);
    const mine = attestationUtxo(id(3), attestation({ issuer: ISSUER_KEY.publicKey, issuerId: S, subject: 'c1'.repeat(32) }));
    for (const issuer of [{ type: 'did', id: S }, { type: 'key', publicKey: ISSUER_KEY.publicKey }, { type: 'id_or_key', value: S }] as const) {
      const w = ledgerWorld([mine], { rows: [...others, koiosRow(mine)] });
      assert.deepEqual((await listAttestations(w.env, { issuer })).items.map((v) => v.id), [id(3)], issuer.type);
      assert.equal(questions(w).length, 1, issuer.type);
    }
  });
  test('a look-alike output without the token is not listed and does not count: 5,001 of them and one attestation are listed as one', async () => {
    const lookAlikes = rowsLike(about, 5_001, 0x1000, false);
    const w = ledgerWorld([about], { rows: [...lookAlikes, koiosRow(about)] });
    assert.deepEqual((await listAttestations(w.env, { subject: S })).items.map((v) => v.id), [id(1)]);
    assert.equal(questions(w).length, 1);
    // The twin: a Koios that ignores the token filter sends them, and then they count.
    await assert.rejects(() => listAttestations(ledgerWorld([], { rows: lookAlikes, ignoreAssetFilter: true }).env, { subject: S }), /5000 or more outputs match/);
  });
  test('an issuer named by its key hash alone cannot narrow the read: the call reads every attestation output, and the failure at 5,000 says to name more', async () => {
    const mine = attestationUtxo(id(3), attestation({ issuer: 'dd'.repeat(32), subject: 'c1'.repeat(32) }));
    const issuer = { type: 'key_hash', hash: keyHashOf('dd'.repeat(32)) } as const;
    const w = ledgerWorld([mine, about]);
    assert.deepEqual((await listAttestations(w.env, { issuer })).items.map((v) => v.id), [id(3)]);
    assert.equal(new URL(questions(w)[0].url).searchParams.has('inline_datum->>bytes'), false);
    const many = rowsLike(attestationUtxo(id(2), attestation({ subject: OTHER })), 5_000, 0x1000);
    await assert.rejects(() => listAttestations(ledgerWorld([], { rows: many }).env, { issuer }), /5000 or more outputs match.*A key hash alone cannot narrow the read.*Give the public key, the issuer DID or a subject/);
    assert.equal((await listAttestations(ledgerWorld([], { rows: many }).env, { issuer: { type: 'did', id: S } })).total, 0, 'the twin: a DID narrows the read, and these outputs do not name it');
  });
  test('the datum filter holds the bytes of the subject when both are named, and those of the issuer otherwise', async () => {
    const w = ledgerWorld([about]);
    await listAttestations(w.env, { subject: S, issuer: { type: 'did', id: OTHER } });
    assert.equal(new URL(questions(w)[0].url).searchParams.get('inline_datum->>bytes'), like(S));
    await listAttestations(w.env, { issuer: { type: 'id_or_key', value: OTHER } });
    assert.equal(new URL(questions(w)[1].url).searchParams.get('inline_datum->>bytes'), like(OTHER));
  });

  describe('the list of every attestation', () => {
    /** Seven attestations, issued from the oldest to the newest in the order of their output references. */
    const seven = Array.from({ length: 7 }, (_, i) => attestationUtxo(id(0x20 + i), attestation({ subject: `${(0xc0 + i).toString(16)}`.repeat(32), issuedAt: CAPTURE_MS + i * 1000 })));
    const byRef = seven.map((u) => `${u.txHash}#${u.outputIndex}`);
    const refsOf = (page: { items: Array<{ ref: string }> }): string[] => page.items.map((v) => v.ref);

    test('Koios pages it: the token filter only, the order of the output reference (not newest first), one row more than the limit, and no total', async () => {
      const w = ledgerWorld(seven);
      const page = await listAttestations(w.env, { limit: 3 });
      assert.deepEqual(refsOf(page), byRef.slice(0, 3));
      assert.deepEqual([page.total, page.offset, page.limit, page.nextOffset], [null, 0, 3, 3]);
      const q = new URL(questions(w)[0].url).searchParams;
      assert.deepEqual([q.get('offset'), q.get('limit'), q.get('order'), q.get('asset_list'), q.has('inline_datum->>bytes')], ['0', '4', 'tx_hash.asc,tx_index.asc', TOKEN_FILTER, false]);
      assert.ok(page.items[0].attestation.issuedAt < page.items[2].attestation.issuedAt, 'the oldest comes first: the order is not newest first');
    });
    test('the pages join up with no gap and no overlap, and the last page has no next offset even when it is full', async () => {
      const w = ledgerWorld(seven);
      const joined: string[] = [];
      let next: number | null = 0;
      // The bound makes a next offset that never ends fail the test, and not hang it.
      for (let pages = 0; next !== null && pages < 10; pages++) {
        const p = await listAttestations(w.env, { limit: 3, offset: next });
        joined.push(...refsOf(p));
        next = p.nextOffset;
      }
      assert.equal(next, null, 'the pages end');
      assert.deepEqual(joined, byRef);
      const six = ledgerWorld(seven.slice(0, 6));
      assert.equal((await listAttestations(six.env, { limit: 3, offset: 3 })).nextOffset, null, 'three rows are left, and the limit is three');
      assert.equal((await listAttestations(six.env, { limit: 3, offset: 2 })).nextOffset, 5, 'four rows are left');
      const past = await listAttestations(six.env, { limit: 3, offset: 6 });
      assert.deepEqual([past.items, past.total, past.nextOffset], [[], null, null]);
    });
    test('it reads the page and no more: 5,001 attestation outputs do not make it fail', async () => {
      const many = rowsLike(attestationUtxo(id(2), attestation({ subject: OTHER })), 5_001, 0x1000);
      const w = ledgerWorld([], { rows: many });
      const page = await listAttestations(w.env, { offset: 4_990, limit: 20 });
      assert.deepEqual([page.items.length, page.nextOffset], [11, null], 'the end of the list');
      assert.equal(questions(w).length, 1);
      assert.equal(new URL(questions(w)[0].url).searchParams.get('offset'), '4990');
      assert.equal((await listAttestations(w.env, { limit: 20 })).nextOffset, 20);
    });
    test('a row that is not an attestation counts in the offset, and is not listed: the pages still join up', async () => {
      const twoTokens = { ...seven[1], assets: { ...seven[1].assets, [`${MAINNET.attestation.hash}${id(0x99)}`]: 1n } };
      const w = ledgerWorld([seven[0], twoTokens, seven[2], seven[3]]);
      const first = await listAttestations(w.env, { limit: 2 });
      assert.deepEqual([refsOf(first), first.nextOffset], [[byRef[0]], 2], 'the second row of Koios is no attestation: the page has one');
      assert.deepEqual(refsOf(await listAttestations(w.env, { limit: 2, offset: 2 })), [byRef[2], byRef[3]]);
    });
    test('a type with neither a subject nor an issuer is refused, and so is a page that is not one, before Koios is asked', async () => {
      const w = ledgerWorld(seven);
      await assert.rejects(() => listAttestations(w.env, { attType: 15, limit: 3 }), /name one of them/);
      await assert.rejects(() => listAttestations(w.env, { limit: 0 }), /limit must be/);
      await assert.rejects(() => listAttestations(w.env, { offset: -1 }), /offset must be/);
      assert.equal(questions(w).length, 0);
    });
  });
});

// ─── checkAttestation ────────────────────────────────────────────────────────────────────────────────────────────────────────

const lineOf = (lines: CheckLine[], id: string): CheckLine => lines.find((l) => l.id === id)!;
const failing = (c: AttestationCheck): string[] => [...c.conditions, ...c.expectations].filter((l) => l.result === 'fail').map((l) => l.id);

describe('checkAttestation: what each expectation refuses, on mainnet data', () => {
  const w = world();
  const ENV = ENVIRONMENT[0];
  const expectAll: AttestationExpectations = { attType: 3, subject: `did:vector:${ENV.datum.subject}`, issuer: { type: 'did', id: ENV.datum.issuerId! }, digest: ENV.datum.digest };
  const check = (over: AttestationExpectations = {}, atMs = CAPTURE_MS, id = ENV.id) => checkAttestation(w.env, { id, atMs, expect: { ...expectAll, ...over } });

  test('an environment attestation at the capture time meets the rule and every expectation: each condition and each expectation is listed', async () => {
    const c = await check();
    assert.equal(c.valid, true);
    assert.equal(c.ruleValid, true);
    assert.deepEqual(c.conditions.map((l) => l.id), ['authentic', 'active', 'time_window', 'envelope', 'issuer_not_invalidated', 'issuer_key_listed']);
    assert.deepEqual(c.conditions.map((l) => l.result), ['pass', 'pass', 'pass', 'not_applicable', 'pass', 'pass']);
    assert.deepEqual(c.expectations.map((l) => [l.id, l.result]), [['type', 'pass'], ['subject', 'pass'], ['issuer', 'pass'], ['digest', 'pass']]);
    assert.equal(c.attestation!.id, ENV.id);
    assert.equal(c.atMs, CAPTURE_MS);
  });
  test('without expectations only the rule is checked', async () => {
    const c = await checkAttestation(w.env, { id: ENV.id, atMs: CAPTURE_MS });
    assert.equal(c.valid, true);
    assert.deepEqual(c.expectations, []);
  });
  test('the wrong type is not valid, and its twin is', async () => {
    const wrong = await check({ attType: 0 });
    assert.equal(wrong.valid, false);
    assert.equal(wrong.ruleValid, true, 'the rule holds: the attestation is fine, it is not what was expected');
    assert.deepEqual(failing(wrong), ['type']);
    assert.match(lineOf(wrong.expectations, 'type').detail, /has the type environment \(3\)/);
    assert.equal((await check({ attType: 3 })).valid, true);
  });
  test('the wrong subject is not valid, and its twin is', async () => {
    const wrong = await check({ subject: `did:vector:${'ee'.repeat(32)}` });
    assert.equal(wrong.valid, false);
    assert.deepEqual(failing(wrong), ['subject']);
    assert.match(lineOf(wrong.expectations, 'subject').detail, new RegExp(ENV.datum.subject));
    assert.equal((await check({ subject: ENV.datum.subject })).valid, true, 'a bare identifier is the same subject');
  });
  test('the wrong issuer is not valid, whether it is named by DID, by key hash or by public key; the right one is, in each form', async () => {
    const hash = keyHashOf(ENV.datum.issuer);
    for (const wrong of [{ type: 'did', id: 'ee'.repeat(32) }, { type: 'key_hash', hash: '00'.repeat(28) }, { type: 'key', publicKey: 'ee'.repeat(32) }] as const) {
      const c = await check({ issuer: wrong });
      assert.equal(c.valid, false, JSON.stringify(wrong));
      assert.deepEqual(failing(c), ['issuer']);
    }
    for (const right of [{ type: 'did', id: ENV.datum.issuerId! }, { type: 'key_hash', hash }, { type: 'key', publicKey: ENV.datum.issuer }] as const) {
      assert.equal((await check({ issuer: right })).valid, true, JSON.stringify(right));
    }
    assert.match(lineOf((await check({ issuer: { type: 'did', id: 'ee'.repeat(32) } })).expectations, 'issuer').detail, new RegExp(hash));
  });
  test('64 hex as the issuer are the identifier or the key: either one is valid, another is not', async () => {
    const bare = (value: string) => check({ issuer: { type: 'id_or_key', value } });
    assert.equal((await bare(ENV.datum.issuerId!)).valid, true, 'as the identifier of the issuer');
    assert.equal((await bare(ENV.datum.issuer)).valid, true, 'as the public key of the issuer');
    const wrong = await bare('ee'.repeat(32));
    assert.equal(wrong.valid, false);
    assert.deepEqual(failing(wrong), ['issuer']);
    assert.match(lineOf(wrong.expectations, 'issuer').label, new RegExp(`The issuer is did:vector:${'ee'.repeat(32)}, or the issuer key is ${'ee'.repeat(32)}`));
  });
  test('a key without a record is compared by its key hash; a DID names no such issuer', async () => {
    const keyOnly = KEY_ONLY[0];
    const ok = await checkAttestation(w.env, { id: keyOnly.id, atMs: CAPTURE_MS, expect: { issuer: { type: 'key_hash', hash: keyHashOf(keyOnly.datum.issuer) } } });
    assert.equal(ok.valid, true);
    const asDid = await checkAttestation(w.env, { id: keyOnly.id, atMs: CAPTURE_MS, expect: { issuer: { type: 'did', id: ENV.datum.issuerId! } } });
    assert.equal(asDid.valid, false);
    assert.match(lineOf(asDid.expectations, 'issuer').detail, /no issuer record/);
  });
  test('the wrong digest is not valid, and its twin is', async () => {
    const wrong = await check({ digest: 'ee'.repeat(32) });
    assert.equal(wrong.valid, false);
    assert.deepEqual(failing(wrong), ['digest']);
    assert.equal((await check({ digest: ENV.datum.digest.toUpperCase() })).valid, true, 'the capitals of a hex digest do not matter');
  });
  test('every expectation that fails is reported, each on its own line', async () => {
    const c = await check({ attType: 0, subject: 'ee'.repeat(32), issuer: { type: 'key_hash', hash: '00'.repeat(28) }, digest: 'ee'.repeat(32) });
    assert.deepEqual(failing(c), ['type', 'subject', 'issuer', 'digest']);
    assert.equal(c.ruleValid, true);
  });
});

describe('checkAttestation: the rule', () => {
  const HOUR = 3_600_000;
  const w = world();
  const ENV = ENVIRONMENT[0];
  const until = ENV.datum.validUntil!;
  const at = (atMs: number, id = ENV.id) => checkAttestation(w.env, { id, atMs });

  test('a revoked attestation is not valid, with the time and the reason; the active ones of mainnet are valid', async () => {
    const c = await at(CAPTURE_MS, REVOKED.id);
    assert.equal(c.valid, false);
    assert.equal(c.ruleValid, false);
    assert.deepEqual(failing(c), ['active']);
    const status = REVOKED.datum.status as { at: number; reason: number };
    assert.match(lineOf(c.conditions, 'active').detail, new RegExp(`revoked at ${iso(status.at).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} with reason ${status.reason}`));
    for (const a of CAPTURED.filter((x) => x.datum.status.type === 'AttActive')) assert.equal((await at(CAPTURE_MS, a.id)).valid, true, a.id);
  });
  test('an expired attestation is not valid, and one at valid_until is: the bound is inclusive', async () => {
    const late = await at(until + 1);
    assert.equal(late.valid, false);
    assert.deepEqual(failing(late), ['time_window']);
    assert.match(lineOf(late.conditions, 'time_window').detail, new RegExp(`after valid_until ${iso(until).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.equal((await at(until)).valid, true);
    assert.equal((await at(CAPTURE_MS)).valid, true);
  });
  test('an attestation that is not yet valid is not valid, and one at valid_from is', async () => {
    const id = 'f1'.repeat(32);
    const wf = world([attestationUtxo(id, attestation({ validFrom: CAPTURE_MS + DAY, validUntil: CAPTURE_MS + 2 * DAY }))]);
    const early = await checkAttestation(wf.env, { id, atMs: CAPTURE_MS });
    assert.equal(early.valid, false);
    assert.deepEqual(failing(early), ['time_window']);
    assert.match(lineOf(early.conditions, 'time_window').detail, /before valid_from/);
    assert.equal((await checkAttestation(wf.env, { id, atMs: CAPTURE_MS + DAY - 1 })).valid, false);
    assert.equal((await checkAttestation(wf.env, { id, atMs: CAPTURE_MS + DAY })).valid, true);
    assert.equal((await checkAttestation(wf.env, { id, atMs: CAPTURE_MS + 2 * DAY })).valid, true);
    assert.equal((await checkAttestation(wf.env, { id, atMs: CAPTURE_MS + 2 * DAY + 1 })).valid, false);
  });
  test('an attestation without valid_until never expires; without valid_from it holds from one hour before issued_at, and not before', async () => {
    const id = 'f2'.repeat(32);
    const wo = world([attestationUtxo(id, attestation())]);
    for (const t of [CAPTURE_MS - HOUR, CAPTURE_MS, CAPTURE_MS + 3650 * DAY]) assert.equal((await checkAttestation(wo.env, { id, atMs: t })).valid, true, String(t));
    for (const t of [0, CAPTURE_MS - 365 * DAY, CAPTURE_MS - HOUR - 1]) {
      const c = await checkAttestation(wo.env, { id, atMs: t });
      assert.equal(c.valid, false, String(t));
      assert.deepEqual(failing(c), ['time_window'], String(t));
      assert.match(lineOf(c.conditions, 'time_window').detail, /more than one hour before issued_at .* so the attestation did not exist yet/);
    }
  });
  test('issued_at after the time of the check is not a reason to refuse: it is the end of the validity window of the transaction', async () => {
    const id = 'f3'.repeat(32);
    const issuedAt = CAPTURE_MS + 59 * 60_000;
    const w3 = world([attestationUtxo(id, attestation({ issuedAt, validUntil: CAPTURE_MS + DAY }))]);
    const c = await checkAttestation(w3.env, { id, atMs: CAPTURE_MS });
    assert.equal(c.valid, true);
    assert.deepEqual(c.conditions.map((l) => l.result), ['pass', 'pass', 'pass', 'not_applicable', 'not_applicable', 'not_applicable']);
    assert.equal((await checkAttestation(w3.env, { id, atMs: issuedAt - HOUR })).valid, true, 'an hour before issued_at');
    assert.equal((await checkAttestation(w3.env, { id, atMs: issuedAt - HOUR - 1 })).valid, false, 'more than an hour before issued_at');
  });
  test('a revoked attestation whose reason is above 2^53 is not valid, and the reason is told exactly', async () => {
    const id = 'f7'.repeat(32);
    const reason = 2n ** 60n + 7n;
    const c = await checkAttestation(world([attestationUtxo(id, attestation(), { datum: revokedWithReason(reason) })]).env, { id, atMs: CAPTURE_MS });
    assert.equal(c.valid, false);
    assert.deepEqual(failing(c), ['active']);
    assert.match(lineOf(c.conditions, 'active').detail, new RegExp(`with reason ${reason}$`));
    assert.equal(c.attestation!.revokeReason, reason);
  });
  test('an attestation that no output holds is not valid, and every expectation fails with it', async () => {
    const c = await checkAttestation(w.env, { id: 'ee'.repeat(32), atMs: CAPTURE_MS, expect: { attType: 3, digest: 'ab'.repeat(32) } });
    assert.equal(c.attestation, null);
    assert.equal(c.valid, false);
    assert.equal(c.ruleValid, false);
    assert.deepEqual(c.conditions.map((l) => l.result), ['fail', 'not_applicable', 'not_applicable', 'not_applicable', 'not_applicable', 'not_applicable']);
    assert.deepEqual(c.expectations.map((l) => [l.id, l.result]), [['type', 'fail'], ['digest', 'fail']]);
    assert.match(c.conditions[0].detail, /does not exist, it was withdrawn, or it is not confirmed yet/);
  });
  test('a capital letter in the identifier does not matter', async () => {
    const capitals = await at(CAPTURE_MS, ENV.id.toUpperCase());
    assert.equal(capitals.valid, true);
    assert.equal(capitals.id, ENV.id, 'the answer names the attestation in lowercase');
  });
});

describe('checkAttestation: the envelope', () => {
  const sign = (a: AttestationDatum, keyByte = 21): string => Buffer.from(
    CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, keyByte)).sign(Buffer.from(envelopeSigStructure({ issuer: a.issuer, issuerId: a.issuerId, subject: a.subject, issuedAt: a.issuedAt, format: a.format, digest: a.digest }), 'hex')).to_raw_bytes(),
  ).toString('hex');
  const id = 'e1'.repeat(32);
  const unsigned = attestation({ format: 50, issuedAt: CAPTURE_MS + 1_000 });
  const check = (datum: AttestationDatum, records: Record<string, IdentityDatum> = {}) => checkAttestation(ledgerWorld([attestationUtxo(id, datum), ...Object.entries(records).map(([rid, r]) => recordUtxo(rid, r))]).env, { id, atMs: CAPTURE_MS });

  test('a signature of the issuer key over the Sig_structure verifies: valid', async () => {
    const c = await check({ ...unsigned, envelopeSig: sign(unsigned) });
    assert.equal(c.valid, true);
    assert.equal(lineOf(c.conditions, 'envelope').result, 'pass');
  });
  test('a signature of another key, one over other fields, and 64 bytes of nothing do not verify: not valid', async () => {
    for (const [what, sig] of [['another key', sign(unsigned, 22)], ['another issued_at', sign({ ...unsigned, issuedAt: unsigned.issuedAt + 1000 })], ['zeros', '00'.repeat(64)]] as const) {
      const c = await check({ ...unsigned, envelopeSig: sig });
      assert.equal(c.valid, false, what);
      assert.deepEqual(failing(c), ['envelope'], what);
    }
  });
  test('the signature covers the digest, the subject, the format and the issuer identity: a change of each one breaks it', async () => {
    const sig = sign(unsigned);
    for (const change of [{ digest: 'aa'.repeat(32) }, { subject: 'bb'.repeat(32) }, { format: 51 }, { format: null }] as Array<Partial<AttestationDatum>>) {
      assert.equal((await check({ ...unsigned, ...change, envelopeSig: sig })).valid, false, JSON.stringify(change));
    }
    const registered = { ...unsigned, issuerId: 'ab'.repeat(32) };
    const record = { [registered.issuerId]: liveRecord() };
    assert.equal((await check({ ...registered, envelopeSig: sign(registered) }, record)).valid, true, 'with an issuer record the DID of the issuer is in the signed header');
    assert.equal((await check({ ...registered, envelopeSig: sign(unsigned) }, record)).valid, false, 'a signature made without it does not verify');
  });
  test('an issuer key of a small order with a forged signature, and a signature that starts with the identity point, are not valid', async () => {
    const structure = Buffer.from(envelopeSigStructure({ issuer: unsigned.issuer, issuerId: null, subject: unsigned.subject, issuedAt: unsigned.issuedAt, format: unsigned.format, digest: unsigned.digest }), 'hex');
    // The identity point as the key: CML takes the universal signature over every message.
    assert.ok(CML.PublicKey.from_bytes(Buffer.from(IDENTITY_POINT_HEX, 'hex')).verify(structure, CML.Ed25519Signature.from_hex(UNIVERSAL_SIGNATURE_HEX)), 'CML alone takes the forged signature');
    const forged = await check({ ...unsigned, issuer: IDENTITY_POINT_HEX, envelopeSig: UNIVERSAL_SIGNATURE_HEX });
    assert.equal(forged.valid, false);
    assert.deepEqual(failing(forged), ['envelope']);
    // The holder of the issuer key, with R = the identity point: CML takes it, the node does not.
    const odd = signatureWithIdentityR(Buffer.alloc(32, 21), Buffer.from(unsigned.issuer, 'hex'), structure);
    assert.ok(CML.PublicKey.from_bytes(Buffer.from(unsigned.issuer, 'hex')).verify(structure, CML.Ed25519Signature.from_raw_bytes(odd)), 'CML alone takes the signature of the holder');
    const own = await check({ ...unsigned, envelopeSig: odd.toString('hex') });
    assert.equal(own.valid, false);
    assert.deepEqual(failing(own), ['envelope']);
    assert.equal((await check({ ...unsigned, envelopeSig: sign(unsigned) })).valid, true, 'the twin: the signature of the issuer key');
  });
});

describe('checkAttestation: the issuer identity', () => {
  const id = 'c1'.repeat(32);
  const ISSUER = 'ab'.repeat(32);
  const PARENT = 'ac'.repeat(32);
  const ISSUED = CAPTURE_MS + 600_000;
  const datum = attestation({ issuerId: ISSUER, issuedAt: ISSUED });
  const revoked = (invalidFrom: number | null): IdentityDatum => liveRecord({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: CAPTURE_MS - 1000, invalidFrom, successor: null } });
  const run = (records: Record<string, IdentityDatum>, d: AttestationDatum = datum, atMs = CAPTURE_MS) => {
    const utxos = [attestationUtxo(id, d), ...Object.entries(records).map(([rid, r]) => recordUtxo(rid, r))];
    return checkAttestation(ledgerWorld(utxos).env, { id, atMs });
  };
  const verdict = async (records: Record<string, IdentityDatum>) => {
    const c = await run(records);
    return { valid: c.valid, line: lineOf(c.conditions, 'issuer_not_invalidated') };
  };
  const child = liveRecord({ lineage: { type: 'Subagent', parent: PARENT, parentEpoch: 0, depth: 1 } });

  test('an issuer that is Active, with no invalid-from time, passes; a key without a record has no identity to check', async () => {
    const ok = await verdict({ [ISSUER]: liveRecord() });
    assert.deepEqual([ok.valid, ok.line.result], [true, 'pass']);
    assert.match(ok.line.detail, /has no invalid-from time/);
    const keyOnly = await run({}, attestation({ issuedAt: ISSUED }));
    assert.equal(keyOnly.valid, true);
    assert.equal(lineOf(keyOnly.conditions, 'issuer_not_invalidated').result, 'not_applicable');
    assert.equal(lineOf(keyOnly.conditions, 'issuer_key_listed').result, 'not_applicable');
  });
  test('an invalid-from time before or at issued_at is not valid; one after issued_at, and a revocation with none, are valid', async () => {
    for (const from of [ISSUED - 1, ISSUED, ISSUED - DAY, 0]) {
      const v = await verdict({ [ISSUER]: revoked(from) });
      assert.deepEqual([v.valid, v.line.result], [false, 'fail'], String(from));
      assert.match(v.line.detail, /at or before issued_at/);
    }
    for (const from of [ISSUED + 1, ISSUED + DAY]) {
      const v = await verdict({ [ISSUER]: revoked(from) });
      assert.deepEqual([v.valid, v.line.result], [true, 'pass'], String(from));
      assert.match(v.line.detail, /after issued_at/);
    }
    assert.equal((await verdict({ [ISSUER]: revoked(null) })).valid, true, 'a revocation without an invalid-from time leaves earlier attestations valid');
  });
  test('the invalid-from time is compared with issued_at and not with the time of the check', async () => {
    assert.equal((await run({ [ISSUER]: revoked(ISSUED + 1000) }, datum, ISSUED + 5000)).valid, true);
  });
  test('an ancestor of the issuer with an invalid-from time at or before issued_at makes it not valid, and the ancestor is named', async () => {
    const bad = await verdict({ [ISSUER]: child, [PARENT]: revoked(ISSUED - 1) });
    assert.deepEqual([bad.valid, bad.line.result], [false, 'fail']);
    assert.match(bad.line.detail, new RegExp(PARENT));
    const good = await verdict({ [ISSUER]: child, [PARENT]: liveRecord() });
    assert.deepEqual([good.valid, good.line.result], [true, 'pass']);
    assert.match(good.line.detail, /and its 1 ancestor\b/);
    const after = await verdict({ [ISSUER]: child, [PARENT]: revoked(ISSUED + 1) });
    assert.equal(after.valid, true);
    assert.match(after.line.detail, /earliest invalid-from time/);
  });
  test('the earliest invalid-from time of the identity and its ancestors counts', async () => {
    const later = liveRecord({ lineage: child.lineage, status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: CAPTURE_MS, invalidFrom: ISSUED + DAY, successor: null } });
    const v = await verdict({ [ISSUER]: later, [PARENT]: revoked(ISSUED - 5) });
    assert.equal(v.valid, false);
    assert.match(v.line.detail, new RegExp(PARENT));
  });
  test('an issuer record that the registry does not hold is not valid: its invalid-from time is unknown', async () => {
    const v = await verdict({});
    assert.deepEqual([v.valid, v.line.result], [false, 'fail']);
    assert.match(v.line.detail, new RegExp(`${ISSUER}.*cannot be read`));
    const orphan = await verdict({ [ISSUER]: child });
    assert.equal(orphan.valid, false);
    assert.match(orphan.line.detail, new RegExp(PARENT));
  });
  test('a key that the issuer record no longer lists does not undo the signature: valid, with a note', async () => {
    const listed = await run({ [ISSUER]: liveRecord({}, [ISSUER_KEY.publicKey]) });
    assert.equal(listed.valid, true);
    assert.doesNotMatch(lineOf(listed.conditions, 'issuer_key_listed').detail, /does not list/);
    const removed = await run({ [ISSUER]: liveRecord() });
    assert.equal(removed.valid, true);
    assert.match(lineOf(removed.conditions, 'issuer_key_listed').detail, new RegExp(`does not list the key ${ISSUER_KEY.keyHash} now`));
  });
  test('a retired issuer is not what the rule looks at: only the invalid-from time', async () => {
    assert.equal((await verdict({ [ISSUER]: liveRecord({ status: { type: 'Retired', at: CAPTURE_MS - 1000, successor: null } }) })).valid, true);
  });
  test('the capture: every active attestation of a registered issuer of mainnet, with an Active record, is valid', async () => {
    const w = world();
    const registered = CAPTURED.filter((x) => x.datum.issuerId !== null && x.datum.status.type === 'AttActive');
    assert.ok(registered.length > 0);
    for (const a of registered) assert.equal((await checkAttestation(w.env, { id: a.id, atMs: CAPTURE_MS })).valid, true, a.id);
  });
});
