// packages/builder/test/marketplace-template-receipt.test.ts
// Our receipt check against a receipt the TEMPLATE made (fixtures/template-receipt.fixture.ts, produced by the template's own
// buildReceipt, signReceipt and receiptResultHash). Every other receipt in these tests is made by our own helpers, so they can only show
// that our check agrees with our idea of the template. This one is the cross-implementation vector: it pins canonicalize(), the sha256
// of the signed receipt and the hash of the result to the bytes the template produced.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Utf8Hex } from '../src/vector/marketplace-datum.ts';
import { verifyReceipt } from '../src/vector/marketplace-transport.ts';
import type { ReceiptChecks, VerifyInput } from '../src/vector/marketplace-transport.ts';
import { TEMPLATE_RECEIPT as T } from './fixtures/template-receipt.fixture.ts';

/** The vector as verifyReceipt is given it, with the escrow it was made for. */
const input = (over: Partial<VerifyInput> = {}): VerifyInput => ({
  receipt: T.receipt, signature: T.signature, escrowRef: T.receipt.escrow_ref, result: T.result, supplierPubKeyHex: T.publicKeyHex,
  escrowSupplierPkh: T.supplierPkh, escrowPromptHash: T.receipt.prompt_hash, resultReceiptHashOnChain: T.resultReceiptHash, ...over,
});
/** `hex` with the low bit of the byte at `index` flipped: one byte changed and nothing else. */
const flipByte = (hex: string, index: number): string => {
  const at = index * 2;
  const flipped = (parseInt(hex.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, '0');
  return hex.slice(0, at) + flipped + hex.slice(at + 2);
};
const states = (checks: ReceiptChecks) => Object.fromEntries(Object.entries(checks).map(([name, c]) => [name, c.state]));
const ALL_PASS = {
  escrow_ref_matches: 'pass', response_hash_matches: 'pass', supplier_key_matches: 'pass', signature_valid: 'pass',
  on_chain_hash_matches: 'pass', prompt_hash_matches: 'pass',
};
/** A canonicaliser that sorts the keys and nothing else: what it takes to see that the vector is not satisfied by an easy one. */
const sortedOnly = (o: Record<string, unknown>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

describe('a receipt made by the template\'s own code', () => {
  test('is built to catch a canonicaliser that differs: its fields are not in key order and its model is not in NFC', () => {
    const keys = Object.keys(T.receipt);
    assert.notDeepEqual(keys, [...keys].sort(), 'the fields are not in key order');
    assert.notEqual(T.receipt.model, T.receipt.model.normalize('NFC'), 'the model is in the decomposed spelling');
    assert.notEqual(T.result, T.result.normalize('NFC'), 'so is a character of the result, which is hashed as it is');
    assert.notEqual(JSON.stringify(T.receipt), T.canonicalReceipt, 'the receipt as written is not its canonical form');
    assert.notEqual(sortedOnly(T.receipt), T.canonicalReceipt, 'sorting the keys is not enough either: the normalisation counts');
  });

  test('canonicalize gives, byte for byte, what the template signed and what it hashed for the chain', () => {
    assert.equal(canonicalize(T.receipt), T.canonicalReceipt);
    assert.equal(canonicalize({ receipt: T.receipt, signature: T.signature }), T.canonicalSigned);
    assert.equal(sha256Utf8Hex(T.canonicalSigned), T.resultReceiptHash);
    assert.equal(sha256Utf8Hex(T.result), T.receipt.response_hash);
  });

  test('passes every row and is verified', () => {
    const v = verifyReceipt(input());
    assert.deepEqual(states(v.checks), ALL_PASS);
    assert.equal(v.verdict, 'verified');
  });

  describe('with one byte flipped it fails', () => {
    // The full row map: the rows named fail and every other row still passes, so a change that makes more rows fail than it should is seen too.
    const fails = (what: string, over: Partial<VerifyInput>, rows: Array<keyof ReceiptChecks>) => {
      const v = verifyReceipt(input(over));
      assert.equal(v.verdict, 'failed', what);
      assert.deepEqual(states(v.checks), { ...ALL_PASS, ...Object.fromEntries(rows.map((row) => [row, 'fail'])) }, what);
    };

    test('in the signature: the signature does not verify, and the hash on chain is no longer the hash of what was signed', () => {
      for (const index of [0, 1, 31, 32, 62, 63]) {
        fails(`signature byte ${index}`, { signature: flipByte(T.signature, index) }, ['signature_valid', 'on_chain_hash_matches']);
      }
    });
    test('in the hash on chain: that row alone', () => {
      for (const index of [0, 15, 31]) {
        const v = verifyReceipt(input({ resultReceiptHashOnChain: flipByte(T.resultReceiptHash, index) }));
        assert.deepEqual(states(v.checks), { ...ALL_PASS, on_chain_hash_matches: 'fail' }, `hash byte ${index}`);
        assert.equal(v.verdict, 'failed');
      }
    });
    test('in the public key: it is no longer the supplier\'s, and the signature does not verify under it', () => {
      for (const index of [0, 16, 31]) {
        fails(`public key byte ${index}`, { supplierPubKeyHex: flipByte(T.publicKeyHex, index) }, ['supplier_key_matches', 'signature_valid']);
      }
    });
    test('in the receipt: the signature and the hash on chain, and the row of the field that changed', () => {
      const fields: Array<[keyof typeof T.receipt, keyof ReceiptChecks]> = [
        ['prompt_hash', 'prompt_hash_matches'], ['response_hash', 'response_hash_matches'], ['supplier_pkh', 'supplier_key_matches'], ['escrow_ref', 'escrow_ref_matches'],
      ];
      for (const [field, row] of fields) {
        const changed = { ...T.receipt, [field]: flipByte(String(T.receipt[field]).split('#')[0], 0) + (field === 'escrow_ref' ? '#0' : '') };
        fails(`receipt.${field}`, { receipt: changed }, ['signature_valid', 'on_chain_hash_matches', row]);
      }
      // a field that is not a hash: the model and the counts
      for (const changed of [
        { ...T.receipt, model: T.receipt.model.replace('8b', '9b') },
        { ...T.receipt, wallclock_ms: T.receipt.wallclock_ms + 1 },
        { ...T.receipt, completion_tokens: T.receipt.completion_tokens + 1 },
      ]) {
        fails(JSON.stringify(changed), { receipt: changed }, ['signature_valid', 'on_chain_hash_matches']);
      }
    });
    test('in the result text: the response hash alone', () => {
      const changed = T.result.replace('Zagreb', 'Zagrec');
      assert.equal(changed.length, T.result.length);
      const v = verifyReceipt(input({ result: changed }));
      assert.deepEqual(states(v.checks), { ...ALL_PASS, response_hash_matches: 'fail' });
      assert.equal(v.verdict, 'failed');
    });
  });

  test('is for its escrow and its request alone', () => {
    const otherEscrow = `${flipByte(T.receipt.escrow_ref.split('#')[0], 0)}#0`;
    assert.equal(verifyReceipt(input({ escrowRef: otherEscrow })).checks.escrow_ref_matches.state, 'fail');
    assert.equal(verifyReceipt(input({ escrowPromptHash: flipByte(T.receipt.prompt_hash, 0) })).checks.prompt_hash_matches.state, 'fail');
    assert.equal(verifyReceipt(input({ escrowSupplierPkh: flipByte(T.supplierPkh, 0) })).checks.supplier_key_matches.state, 'fail');
  });
});
