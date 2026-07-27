import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveNftAssetName, lovelaceToAda, formatAssetName, metadataStr } from '../src/tx.ts';

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
