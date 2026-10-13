// packages/builder/test/marketplace-datum.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Data } from '@lucid-evolution/lucid';
import {
  decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, canonicalize,
  requestSpecHash, wirePayloadFor, promptHashForPayload, escrowLockFloor, parseOutRef, formatOutRef,
} from '../src/vector/marketplace-datum.ts';
import {
  ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_OPEN_DATUM_HEX, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE, ESCROW_REF,
} from './fixtures/marketplace.fixture.ts';

describe('advert datum', () => {
  test('decodes the live ChandraOCR advert field by field', () => {
    assert.deepEqual(decodeAdvertDatum(ADVERT_DATUM_HEX), ADVERT_EXPECTED);
  });
  test('decodes Lucid-compact framing too (third-party suppliers using Lucid or Mesh emit d8799f…ff)', () => {
    const compact = Data.to(Data.from(ADVERT_DATUM_HEX));
    assert.ok(compact.startsWith('d8799f'), 'indefinite-length framing, not the on-chain definite one');
    assert.deepEqual(decodeAdvertDatum(compact), ADVERT_EXPECTED);
  });
  test('request_spec_hash of that advert matches the live escrow datum', () => {
    assert.equal(requestSpecHash(decodeAdvertDatum(ADVERT_DATUM_HEX)), ESCROW_EXPECTED.request_spec_hash);
  });
});

describe('escrow datum', () => {
  test('decodes the live Open escrow field by field', () => {
    assert.deepEqual(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), ESCROW_EXPECTED);
  });
  test('re-encoding reproduces the on-chain bytes exactly', () => {
    assert.equal(encodeEscrowDatum(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX)), ESCROW_OPEN_DATUM_HEX);
    // the case of hex input never leaks into the output
    assert.equal(encodeEscrowDatum({ ...ESCROW_EXPECTED, buyer_pkh: ESCROW_EXPECTED.buyer_pkh.toUpperCase() }), ESCROW_OPEN_DATUM_HEX);
  });
  test('decodes Lucid-compact framing too (third-party suppliers using Lucid or Mesh emit d8799f…ff)', () => {
    const compact = Data.to(Data.from(ESCROW_OPEN_DATUM_HEX));
    assert.ok(compact.startsWith('d8799f'), 'indefinite-length framing, not the on-chain definite one');
    assert.deepEqual(decodeEscrowDatum(compact), ESCROW_EXPECTED);
  });
  test('round-trips Submitted state with both options present', () => {
    const d = { ...ESCROW_EXPECTED, submitted_at: 1786530100000, result_receipt_hash: 'ab'.repeat(32), state: 'Submitted' as const };
    assert.deepEqual(decodeEscrowDatum(encodeEscrowDatum(d)), d);
  });
  test('encodes Option Some fields and the Submitted tag byte-for-byte', () => {
    const submittedAt = 1786530100000;
    const receipt = 'ab'.repeat(32);
    const tail = 'd87a80d87a80d87980'; // submitted_at None, result_receipt_hash None, state Open
    assert.ok(ESCROW_OPEN_DATUM_HEX.endsWith(tail));
    const expected = ESCROW_OPEN_DATUM_HEX.slice(0, -tail.length)
      + 'd87981' + '1b' + submittedAt.toString(16).padStart(16, '0') // Some(submitted_at)
      + 'd87981' + '5820' + receipt // Some(result_receipt_hash)
      + 'd87b80'; // Submitted
    const d = { ...ESCROW_EXPECTED, submitted_at: submittedAt, result_receipt_hash: receipt, state: 'Submitted' as const };
    assert.equal(encodeEscrowDatum(d), expected);
  });
  test('bytestring headers use the shortest definite form across the 24 / 256 / 65,536 boundaries', () => {
    const capHex = '5821' + Buffer.from(ESCROW_EXPECTED.capability_id, 'utf8').toString('hex');
    const at = ESCROW_OPEN_DATUM_HEX.indexOf(capHex);
    assert.ok(at > 0);
    const head = ESCROW_OPEN_DATUM_HEX.slice(0, at);
    const tail = ESCROW_OPEN_DATUM_HEX.slice(at + capHex.length);
    for (const [len, header] of [[0, '40'], [23, '57'], [24, '5818'], [255, '58ff'], [256, '590100'], [65_535, '59ffff']] as const) {
      const d = { ...ESCROW_EXPECTED, capability_id: 'a'.repeat(len) };
      assert.equal(encodeEscrowDatum(d), head + header + '61'.repeat(len) + tail, `${len}-byte capability_id`);
    }
  });
  test('refuses values it cannot frame instead of emitting a corrupt datum', () => {
    assert.throws(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, payment_lovelace: -1n }), /uint64/);
    assert.throws(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, payment_lovelace: 2n ** 64n }), /uint64/);
    assert.throws(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, prompt_hash: 'abc' }), /even-length hex/);
    assert.throws(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, state: 'Bogus' as never }), /unknown state/);
    // the 64 KiB bytestring guard: 65,535 bytes is the last that fits the 59 xx xx header (covered above)
    assert.throws(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, capability_id: 'a'.repeat(65_536) }), /too long/);
  });
  test('lock floor never goes below the economic total and covers the live lock', () => {
    const open = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    const economic = open.payment_lovelace + open.buyer_bond_lovelace + open.supplier_bond_lovelace;
    const floor = escrowLockFloor(open, economic);
    assert.ok(floor >= economic);
    assert.equal(floor, ESCROW_LOCKED_LOVELACE, 'the floor must equal the lovelace the marketplace actually locked for this datum');
  });
});

describe('hashing', () => {
  test('canonicalize sorts keys and drops undefined', () => {
    assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: undefined }] }), '{"a":[{"d":2}],"b":1}');
  });
  test('wire payload is the one-element message array and prompt hash is sha256 of it', () => {
    assert.equal(wirePayloadFor('hello'), '[{"content":"hello","role":"user"}]');
    const expected = createHash('sha256').update('[{"content":"hello","role":"user"}]', 'utf8').digest('hex');
    assert.equal(promptHashForPayload('hello'), expected);
  });
  test('out refs parse and format', () => {
    assert.deepEqual(parseOutRef(ESCROW_REF), { txHash: ESCROW_REF.slice(0, 64), outputIndex: 0 });
    assert.equal(formatOutRef(ESCROW_REF.slice(0, 64), 0), ESCROW_REF);
    assert.throws(() => parseOutRef('nope#1'), /out ref/);
  });
});
