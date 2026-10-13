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
  test('request_spec_hash of that advert matches the live escrow datum', () => {
    assert.equal(requestSpecHash(decodeAdvertDatum(ADVERT_DATUM_HEX)), ESCROW_EXPECTED.request_spec_hash);
  });
});

describe('escrow datum', () => {
  test('decodes the live Open escrow field by field', () => {
    assert.deepEqual(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), ESCROW_EXPECTED);
  });
  test('re-encoding is semantically identical to the on-chain bytes', () => {
    const ours = encodeEscrowDatum(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX));
    assert.deepEqual(Data.from(ours), Data.from(ESCROW_OPEN_DATUM_HEX));
  });
  test('round-trips Submitted state with both options present', () => {
    const d = { ...ESCROW_EXPECTED, submitted_at: 1786530100000, result_receipt_hash: 'ab'.repeat(32), state: 'Submitted' as const };
    assert.deepEqual(decodeEscrowDatum(encodeEscrowDatum(d)), d);
  });
  test('lock floor never goes below the economic total and covers the live lock', () => {
    const open = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    const economic = open.payment_lovelace + open.buyer_bond_lovelace + open.supplier_bond_lovelace;
    const floor = escrowLockFloor(open, economic);
    assert.ok(floor >= economic);
    assert.ok(floor >= ESCROW_LOCKED_LOVELACE - 100_000n, `floor ${floor} is far below the live lock ${ESCROW_LOCKED_LOVELACE}`);
    assert.ok(floor <= ESCROW_LOCKED_LOVELACE + 200_000n, `floor ${floor} over-locks against the live lock ${ESCROW_LOCKED_LOVELACE}`);
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
