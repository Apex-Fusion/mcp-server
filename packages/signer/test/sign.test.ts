import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { signTransaction } from '../src/sign.ts';
import { MnemonicKeySource } from '../src/keysource.ts';
import { decodeTransaction } from '../src/decode.ts';

const TEST_MNEMONIC =
  'test walk nut penalty hip pave soap entry language right filter choice';

const FIXTURE_CBOR =
  '84a300d9010281825820e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c3200018282581d71ab1aad52c4774e5da9f2c0fa1a4d07220a0bdd57ee3dce9be860dac61a002dc6c0825839013fd872a48d71872cf76528bb41dd2a5775e2c532c21662a47c6cebf44b6be5f33456f28523ed04d1aaad158541176425378d8ed8fce53f881a3b6a7221021a0002911fa0f5f6';

const KEY = new MnemonicKeySource(TEST_MNEMONIC).load().privateKeyBech32;

describe('signTransaction', () => {
  test('attaches exactly one vkey witness', () => {
    const { signedCborHex } = signTransaction(FIXTURE_CBOR, KEY);
    const ws = CML.Transaction.from_cbor_hex(signedCborHex).witness_set().vkeywitnesses();
    assert.ok(ws);
    assert.equal(ws!.len(), 1);
  });

  test('does not alter the transaction body — hash is unchanged', () => {
    const { signedCborHex, txHashHex } = signTransaction(FIXTURE_CBOR, KEY);
    assert.equal(txHashHex, decodeTransaction(FIXTURE_CBOR).txHashHex, 'signing must not change the body');
    assert.equal(decodeTransaction(signedCborHex).txHashHex, txHashHex);
  });

  test('the signature verifies against the signing public key', () => {
    const { signedCborHex, txHashHex } = signTransaction(FIXTURE_CBOR, KEY);
    const w = CML.Transaction.from_cbor_hex(signedCborHex).witness_set().vkeywitnesses()!.get(0);
    const hashBytes = CML.TransactionHash.from_hex(txHashHex).to_raw_bytes();
    assert.equal(w.vkey().verify(hashBytes, w.ed25519_signature()), true);
  });

  test('output is longer than input — witnesses were added', () => {
    const { signedCborHex } = signTransaction(FIXTURE_CBOR, KEY);
    assert.ok(signedCborHex.length > FIXTURE_CBOR.length);
  });

  test('signing is deterministic for the same key and transaction', () => {
    assert.equal(
      signTransaction(FIXTURE_CBOR, KEY).signedCborHex,
      signTransaction(FIXTURE_CBOR, KEY).signedCborHex
    );
  });

  test('rejects undecodable CBOR rather than producing garbage', () => {
    assert.throws(() => signTransaction('not-hex', KEY), /could not be decoded/i);
  });

  test('rejects an invalid private key', () => {
    assert.throws(() => signTransaction(FIXTURE_CBOR, 'nonsense'), /private key/i);
  });
});
