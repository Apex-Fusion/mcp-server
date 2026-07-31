import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveNftAssetName, lovelaceToAda, formatAssetName, metadataStr, apexToLovelace } from '../src/tx.ts';

const VECTORS: Array<{ tx: string; idx: number; expected: string }> = [
  { tx: '00'.repeat(32), idx: 0, expected: 'a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9' },
  { tx: '2703182e4d1151a32b7bcfc2362c91278bcac66a49a840d217ae5cb49f8b3649', idx: 0, expected: '24ed834d88890ce35e81a6b9c4f988fad3d8a0284db6f3e641416f44f5e95d75' },
  { tx: 'ff'.repeat(32), idx: 23, expected: 'df229a221c5a84f48c06d5b28a98deb6ea678c369ab166400e88dd3d2bdc7b9f' },
  { tx: 'ab'.repeat(32), idx: 24, expected: '3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b' },
  { tx: '01'.repeat(32), idx: 256, expected: 'e626a305779e4c1e74b7719d302d0fbc1b722ab33bd52da4c23e6b8cd1bd04ec' },
];

describe('deriveNftAssetName — Conway indefinite-CBOR parity', () => {
  for (const { tx, idx, expected } of VECTORS) {
    test(`tx=${tx.slice(0, 8)}… idx=${idx}`, () => {
      assert.equal(deriveNftAssetName(tx, idx), expected);
    });
  }
});

describe('lovelaceToAda', () => {
  test('converts whole ada', () => assert.equal(lovelaceToAda(2_000_000n), '2.000000'));
  test('converts fractional ada', () => assert.equal(lovelaceToAda('1234567'), '1.234567'));
  test('returns zero for null', () => assert.equal(lovelaceToAda(null as unknown as bigint), '0.000000'));
  test('returns zero for garbage', () => assert.equal(lovelaceToAda('not-a-number'), '0.000000'));
});

describe('formatAssetName', () => {
  test('decodes hex to utf8', () => assert.equal(formatAssetName('74657374'), 'test'));
  test('passes through non-hex unchanged', () => assert.equal(formatAssetName('plain'), 'plain'));
  test('passes through empty string', () => assert.equal(formatAssetName(''), ''));
});

describe('metadataStr', () => {
  test('leaves short strings intact', () => assert.equal(metadataStr('short'), 'short'));
  test('chunks strings longer than 64 bytes', () => {
    const out = metadataStr('a'.repeat(150));
    assert.ok(Array.isArray(out));
    assert.deepEqual((out as string[]).map(s => s.length), [64, 64, 22]);
  });
});

describe('apexToLovelace', () => {
  test('converts whole and fractional amounts exactly', () => {
    assert.equal(apexToLovelace(1), 1_000_000n);
    assert.equal(apexToLovelace(0.000001), 1n);
    assert.equal(apexToLovelace(25), 25_000_000n);
    assert.equal(apexToLovelace(3.14), 3_140_000n);
    // 4.35 and 8.87 happen to be bit-exact under Math.floor(x * 1e6) on this
    // Node/V8 build (verified empirically - see below for values that are
    // NOT exact), but a string-exact helper must get them right regardless
    // of platform, so they stay as correctness checks.
    assert.equal(apexToLovelace(4.35), 4_350_000n);
    assert.equal(apexToLovelace(8.87), 8_870_000n);
  });

  test('is exact where float math is not', () => {
    // Empirically confirmed on this codebase's Node runtime (node -e):
    //   2.05 * 1e6 === 2049999.9999999998  -> Math.floor === 2049999 (want 2050000)
    //   8.11 * 1e6 === 8109999.999999999   -> Math.floor === 8109999 (want 8110000)
    //   1.005 * 1e6 === 1004999.9999999999 -> Math.floor === 1004999 (want 1005000)
    // Each of these silently drops exactly 1 lovelace under the old
    // Math.floor(amountApex * 1_000_000) path. The string-exact helper must not.
    assert.equal(apexToLovelace(2.05), 2_050_000n);
    assert.equal(apexToLovelace(8.11), 8_110_000n);
    assert.equal(apexToLovelace(1.005), 1_005_000n);
  });

  test('rejects more than 6 decimal places instead of truncating', () => {
    assert.throws(() => apexToLovelace(1.0000001), /decimal/i);
  });

  test('rejects negative, NaN, and Infinity', () => {
    assert.throws(() => apexToLovelace(-1), /positive|negative/i);
    assert.throws(() => apexToLovelace(NaN), /finite|number/i);
    assert.throws(() => apexToLovelace(Infinity), /finite|number/i);
  });

  test('handles large amounts without precision loss', () => {
    assert.equal(apexToLovelace(1_000_000), 1_000_000_000_000n);
  });
});
