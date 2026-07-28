import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTransaction } from '../src/decode.ts';

// Real unsigned transaction from Vector testnet. 1 input, 2 outputs
// (one foreign, one change back to OWN), fee 168223.
const FIXTURE_CBOR =
  '84a300d9010281825820e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c3200018282581d71ab1aad52c4774e5da9f2c0fa1a4d07220a0bdd57ee3dce9be860dac61a002dc6c0825839013fd872a48d71872cf76528bb41dd2a5775e2c532c21662a47c6cebf44b6be5f33456f28523ed04d1aaad158541176425378d8ed8fce53f881a3b6a7221021a0002911fa0f5f6';

const OWN_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
const FOREIGN_ADDRESS = 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8';

describe('decodeTransaction', () => {
  test('extracts the fee', () => {
    assert.equal(decodeTransaction(FIXTURE_CBOR).fee, 168223n);
  });

  test('extracts both outputs with bech32 addresses and lovelace', () => {
    const { outputs } = decodeTransaction(FIXTURE_CBOR);
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].address, FOREIGN_ADDRESS);
    assert.equal(outputs[0].lovelace, 3_000_000n);
    assert.equal(outputs[1].address, OWN_ADDRESS);
    assert.equal(outputs[1].lovelace, 996_831_777n);
  });

  test('reports the input count', () => {
    assert.equal(decodeTransaction(FIXTURE_CBOR).inputCount, 1);
  });

  test('reports no minted assets for a plain payment', () => {
    assert.equal(decodeTransaction(FIXTURE_CBOR).mintedAssetCount, 0);
  });

  test('reports no native assets on either output', () => {
    const { outputs } = decodeTransaction(FIXTURE_CBOR);
    assert.deepStrictEqual(outputs[0].assets, []);
    assert.deepStrictEqual(outputs[1].assets, []);
  });

  test('computes a 64-hex transaction hash', () => {
    const { txHashHex } = decodeTransaction(FIXTURE_CBOR);
    assert.match(txHashHex, /^[0-9a-f]{64}$/);
  });

  // Fail closed: anything unparseable must throw, never yield a partial result
  // that policy might then evaluate against incomplete data.
  test('rejects non-hex input', () => {
    assert.throws(() => decodeTransaction('not-hex'), /could not be decoded/i);
  });

  test('rejects truncated CBOR', () => {
    assert.throws(() => decodeTransaction(FIXTURE_CBOR.slice(0, 40)), /could not be decoded/i);
  });

  test('rejects an empty string', () => {
    assert.throws(() => decodeTransaction(''), /could not be decoded/i);
  });
});
