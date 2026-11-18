// packages/builder/test/capture-neutral.test.ts
// What the capture of mainnet rows changes (fixtures/capture-neutral.ts) so that the checked-in file holds no text of another party, and
// the guard of its output path. No network: the script is run only with an output path that it must refuse before it asks Koios, and
// with one that it must accept, against a Koios address that nothing listens at.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  decodeAttestationDatum, decodeDelegationDatum, decodeVaultDatum, encodeAttestationDatum, utf8Hex,
} from '../src/vector/identity-codec.ts';
import type { Delegator } from '../src/vector/identity-codec.ts';
import { testKey } from './fixtures/identity-world.ts';
import { FOUNDATION_ATTESTATIONS, NEUTRAL_ORGANISATION, neutralAttestation, neutralDelegationRow, neutralVaultJson, neutralVaultRow, outputInside } from './fixtures/capture-neutral.ts';
import { CAPTURE_MS, attestation, attestationUtxo, delegation, delegationUtxo, koiosRow, vaultUtxo } from './fixtures/ledger-read-world.ts';
import type { Row } from './fixtures/ledger-read-world.ts';

const FIXTURES = resolve(import.meta.dirname!, 'fixtures');
const ID = 'a1b2c3d4'.padEnd(64, 'e');
const text = 'https://agent.example/records/7.json';
const reply = 'https://subject.example/reply';

/** An attestation row as Koios gives it for a datum: with the hash and the JSON value of the datum, which no longer match once it changes. */
const attestationRow = (over = {}): Row => ({
  ...koiosRow(attestationUtxo(ID, attestation({ locator: utf8Hex(text), contested: { uri: utf8Hex(reply), sha256: 'ab'.repeat(32) }, ...over }))),
  datum_hash: 'cd'.repeat(32),
});
const withValue = (row: Row): Row => ({ ...row, inline_datum: { bytes: row.inline_datum!.bytes, value: { constructor: 0, fields: [] } } });

describe('neutralAttestation', () => {
  test('replaces the locator and the contest reply by a value of the same form, and changes nothing else in the datum', () => {
    const row = withValue(attestationRow());
    const { row: next, changed } = neutralAttestation(row, ID);
    assert.equal(changed, true);
    const before = decodeAttestationDatum(row.inline_datum!.bytes);
    const after = decodeAttestationDatum(next.inline_datum!.bytes);
    assert.deepEqual(after, {
      ...before, locator: utf8Hex('https://example.invalid/a/a1b2c3d4'), contested: { ...before.contested, uri: utf8Hex('https://example.invalid/c/a1b2c3d4') },
    });
    assert.equal(after.contested!.sha256, 'ab'.repeat(32), 'the hash of the reply stays');
    assert.deepEqual({ ...next, inline_datum: null, datum_hash: undefined }, { ...row, inline_datum: null, datum_hash: undefined }, 'the other fields of the row stay');
  });
  test('the row carries no hash and no JSON value of the datum that was replaced', () => {
    const { row } = neutralAttestation(withValue(attestationRow()), ID);
    assert.equal(row.datum_hash, null);
    assert.deepEqual(Object.keys(row.inline_datum!), ['bytes']);
  });
  test('the same attestation gets the same text each time, and another one gets its own', () => {
    const a = neutralAttestation(attestationRow(), ID).row.inline_datum!.bytes;
    assert.equal(neutralAttestation(attestationRow(), ID).row.inline_datum!.bytes, a);
    const other = `ffff0000${ID.slice(8)}`;
    assert.notEqual(neutralAttestation(attestationRow(), other).row.inline_datum!.bytes, a);
    assert.equal(decodeAttestationDatum(neutralAttestation(attestationRow(), other).row.inline_datum!.bytes).locator, utf8Hex('https://example.invalid/a/ffff0000'));
  });
  test('a locator alone is replaced, and no reply is made up where there is none', () => {
    const { row } = neutralAttestation(attestationRow({ contested: null }), ID);
    const after = decodeAttestationDatum(row.inline_datum!.bytes);
    assert.deepEqual([after.locator, after.contested], [utf8Hex('https://example.invalid/a/a1b2c3d4'), null]);
    const replyOnly = decodeAttestationDatum(neutralAttestation(attestationRow({ locator: null }), ID).row.inline_datum!.bytes);
    assert.deepEqual([replyOnly.locator, replyOnly.contested!.uri], [null, utf8Hex('https://example.invalid/c/a1b2c3d4')]);
  });
  test('the attestation of the Foundation smoke test is written as read, with its hash', () => {
    const [id] = Object.keys(FOUNDATION_ATTESTATIONS);
    const row = withValue(attestationRow());
    const kept = neutralAttestation(row, id);
    assert.equal(kept.changed, false);
    assert.equal(kept.row, row, 'the row itself');
    assert.equal(neutralAttestation(row, ID).changed, true, 'the twin: another attestation with the same text');
  });
  test('a row without any text stays, and so does a row without a datum', () => {
    const plain = attestationRow({ locator: null, contested: null });
    assert.deepEqual([neutralAttestation(plain, ID).changed, neutralAttestation(plain, ID).row === plain], [false, true]);
    const none = { ...plain, inline_datum: null };
    assert.equal(neutralAttestation(none, ID).changed, false);
  });
  test('a datum that the codec does not write back as it was read is refused, and the same datum in canonical form is replaced', () => {
    const canonical = attestationRow();
    const bytes = canonical.inline_datum!.bytes;
    const subject = decodeAttestationDatum(bytes).subject;
    const chunked = bytes.replace(`5820${subject}`, `5f5810${subject.slice(0, 32)}5810${subject.slice(32)}ff`);
    assert.notEqual(chunked, bytes);
    assert.equal(decodeAttestationDatum(chunked).subject, subject, 'the codec reads it');
    assert.notEqual(encodeAttestationDatum(decodeAttestationDatum(chunked)), chunked, 'and writes it another way');
    assert.throws(() => neutralAttestation({ ...canonical, inline_datum: { bytes: chunked } }, ID), /capture refused: the datum of the attestation a1b2c3d4.* does not encode back to the bytes that were read/);
    assert.equal(neutralAttestation(canonical, ID).changed, true);
  });
});

describe('neutralDelegationRow and neutralVaultRow', () => {
  const key = testKey(30).keyHash;
  const org = (organisation: string | null): Delegator => ({ type: 'PrincipalKey', hash: key, organisation });
  const delegationRow = (delegator: Delegator): Row => ({ ...koiosRow(delegationUtxo(ID, delegation({ delegator }))), datum_hash: 'cd'.repeat(32) });
  const vaultRow = (owner: Delegator, kind: 'Live' | 'Returned' = 'Live'): Row => ({
    ...koiosRow(vaultUtxo(kind === 'Live' ? { type: 'Live', owner, delegation: ID, spent: 7n, periodStart: CAPTURE_MS } : { type: 'Returned', owner }, 5_000_000n)), datum_hash: 'cd'.repeat(32),
  });

  test('the organisation of a delegator is replaced by the neutral text, and the rest of the datum stays', () => {
    const row = delegationRow(org(utf8Hex('Acme Corporation')));
    const { row: next, changed } = neutralDelegationRow(row);
    assert.equal(changed, true);
    const before = decodeDelegationDatum(row.inline_datum!.bytes);
    assert.deepEqual(decodeDelegationDatum(next.inline_datum!.bytes), { ...before, delegator: org(NEUTRAL_ORGANISATION) });
    assert.equal(next.datum_hash, null);
    assert.deepEqual(Object.keys(next.inline_datum!), ['bytes']);
    assert.equal(NEUTRAL_ORGANISATION.length / 2 >= 1 && NEUTRAL_ORGANISATION.length / 2 <= 64, true, 'a delegation allows 1 to 64 bytes');
  });
  test('a delegation without an organisation, with an agent as delegator, or with the neutral text already, stays as it is', () => {
    for (const delegator of [org(null), { type: 'Agent', id: 'c3'.repeat(32) } as const, org(NEUTRAL_ORGANISATION)]) {
      const row = delegationRow(delegator);
      const next = neutralDelegationRow(row);
      assert.deepEqual([next.changed, next.row === row], [false, true], JSON.stringify(delegator));
    }
  });
  test('the organisation of the owner of a Live output and of a Returned output is replaced, and the rest of the datum stays', () => {
    for (const kind of ['Live', 'Returned'] as const) {
      const row = vaultRow(org(utf8Hex('Acme Corporation')), kind);
      const { row: next, changed } = neutralVaultRow(row);
      assert.equal(changed, true, kind);
      assert.deepEqual(decodeVaultDatum(next.inline_datum!.bytes), { ...decodeVaultDatum(row.inline_datum!.bytes), owner: org(NEUTRAL_ORGANISATION) }, kind);
      assert.equal(next.datum_hash, null, kind);
    }
  });
  test('an owner without an organisation, an agent, and the neutral text stay as they are', () => {
    for (const owner of [org(null), { type: 'Agent', id: 'c3'.repeat(32) } as const, org(NEUTRAL_ORGANISATION)]) {
      const row = vaultRow(owner);
      assert.deepEqual([neutralVaultRow(row).changed, neutralVaultRow(row).row === row], [false, true], JSON.stringify(owner));
    }
  });
  test('a row without a datum stays', () => {
    const none = { ...vaultRow(org(null)), inline_datum: null };
    assert.equal(neutralVaultRow(none).changed, false);
    assert.equal(neutralDelegationRow({ ...none }).changed, false);
  });
});

describe('neutralVaultJson', () => {
  const some = (hex: string) => ({ constructor: 0, fields: [{ bytes: hex }] });
  const none = { constructor: 1, fields: [] };
  const principal = (organisation: unknown) => ({ constructor: 0, fields: [{ bytes: '38'.repeat(28) }, organisation] });
  const agent = { constructor: 1, fields: [{ bytes: 'c3'.repeat(32) }] };
  const live = (owner: unknown) => ({ constructor: 0, fields: [owner, { bytes: 'dd'.repeat(32) }, { int: 20800000 }, { int: 1794846798000 }] });
  const returned = (owner: unknown) => ({ constructor: 1, fields: [owner] });

  test('replaces the organisation of the owner of a Live and of a Returned datum, and keeps every other field', () => {
    const original = live(principal(some(utf8Hex('Acme Corporation'))));
    const next = neutralVaultJson(original);
    assert.equal(next.changed, true);
    assert.deepEqual(next.row, live(principal(some(NEUTRAL_ORGANISATION))));
    assert.deepEqual(original, live(principal(some(utf8Hex('Acme Corporation')))), 'the value that was given is not changed');
    assert.deepEqual(neutralVaultJson(returned(principal(some(utf8Hex('x'))))).row, returned(principal(some(NEUTRAL_ORGANISATION))));
  });
  test('an owner without an organisation, an agent, the neutral text, and what is not a vault datum stay', () => {
    for (const value of [live(principal(none)), live(agent), returned(principal(none)), live(principal(some(NEUTRAL_ORGANISATION))), null, 7, 'x', [], {}, { constructor: 5, fields: [] }, { int: 1 }]) {
      const next = neutralVaultJson(value);
      assert.deepEqual([next.changed, next.row === value], [false, true], JSON.stringify(value));
    }
  });
  test('the constructor that every object has is not a constructor of Plutus Data', () => {
    const inherited = Object.create({ constructor: 0, fields: [principal(some(utf8Hex('x')))] });
    assert.equal(neutralVaultJson(inherited).changed, false);
  });
});

describe('outputInside', () => {
  test('a path inside the folder is accepted, as an absolute path', () => {
    assert.equal(outputInside(FIXTURES, resolve(FIXTURES, 'ledger-read-mainnet.json')), resolve(FIXTURES, 'ledger-read-mainnet.json'));
    assert.equal(outputInside(FIXTURES, resolve(FIXTURES, 'sub', 'a.json')), resolve(FIXTURES, 'sub', 'a.json'));
    assert.equal(outputInside(FIXTURES, resolve(FIXTURES, '..foo.json')), resolve(FIXTURES, '..foo.json'), 'a name that starts with two dots is a name');
    assert.equal(outputInside(FIXTURES, resolve(FIXTURES, 'sub', '..', 'a.json')), resolve(FIXTURES, 'a.json'), 'a path that goes up and comes back');
  });
  test('a path outside the folder is refused: another folder, its parent, a sibling with the same prefix, and the folder itself', () => {
    for (const path of ['/tmp/x.json', resolve(FIXTURES, '..', 'x.json'), resolve(FIXTURES, '..'), resolve(FIXTURES, '..', 'fixtures-other', 'x.json'), `${FIXTURES}-other/x.json`, resolve(FIXTURES, 'sub', '..', '..', 'x.json'), FIXTURES, '/']) {
      assert.throws(() => outputInside(FIXTURES, path), /capture refused: .* is outside the fixtures folder/, path);
    }
  });
});

describe('the capture script', () => {
  const SCRIPT = resolve(FIXTURES, 'capture-ledger-read.mjs');
  /** Runs the script with Koios at an address that nothing listens at: it can reach no data. */
  const run = (output: string) => spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, output], {
    cwd: resolve(import.meta.dirname!, '..'), encoding: 'utf8', timeout: 120_000, env: { ...process.env, VECTOR_MAINNET_KOIOS_URL: 'http://127.0.0.1:9' },
  });

  test('refuses an output path outside the fixtures folder before it asks Koios, and writes nothing', () => {
    const outside = resolve(FIXTURES, '..', 'zz-capture-outside.json');
    const r = run(outside);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /capture refused: .*zz-capture-outside\.json is outside the fixtures folder/);
    assert.doesNotMatch(r.stderr, /fetch failed|ECONNREFUSED/, 'it did not get as far as the network');
    assert.equal(existsSync(outside), false);
  });
  test('accepts an output path inside the folder: it goes on to Koios, which is not there, and writes nothing', () => {
    const inside = resolve(FIXTURES, 'zz-capture-inside.json');
    const r = run(inside);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /outside the fixtures folder/);
    assert.match(r.stderr, /fetch failed|ECONNREFUSED|Koios answered/);
    assert.equal(existsSync(inside), false);
  });
});
