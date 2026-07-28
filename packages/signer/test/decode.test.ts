import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
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

  // CML's from_cbor_hex only requires that a *prefix* of the input parse as a
  // valid transaction — it does not check that parsing consumed the whole
  // string. Left unchecked, appending arbitrary bytes to a real transaction
  // would silently decode as if those bytes did not exist: a confident,
  // fully-populated result over less data than was actually supplied. That is
  // the opposite failure mode from the tests above (which all fail to parse
  // at all) and is exactly the kind of partial understanding this module must
  // never hand to policy.
  describe('unconsumed input (trailing bytes)', () => {
    test('rejects a transaction with trailing bytes appended', () => {
      assert.throws(() => decodeTransaction(FIXTURE_CBOR + 'deadbeef'), /could not be decoded/i);
    });

    test('still accepts the clean fixture (no false positive on legitimate input)', () => {
      assert.doesNotThrow(() => decodeTransaction(FIXTURE_CBOR));
    });

    test('still accepts a signed transaction (fixture + a real vkey witness)', () => {
      const unsigned = CML.Transaction.from_cbor_hex(FIXTURE_CBOR);
      const body = unsigned.body();
      const hash = CML.hash_transaction(body);
      const privateKey = CML.PrivateKey.generate_ed25519();
      const signature = privateKey.sign(hash.to_raw_bytes());

      const vkeywitnesses = CML.VkeywitnessList.new();
      vkeywitnesses.add(CML.Vkeywitness.new(privateKey.to_public(), signature));
      const witnessSet = CML.TransactionWitnessSet.new();
      witnessSet.set_vkeywitnesses(vkeywitnesses);

      // The same shape sign.ts will produce: original body, a witness set, no
      // auxiliary data.
      const signed = CML.Transaction.new(body, witnessSet, true, undefined);

      const decoded = decodeTransaction(signed.to_cbor_hex());
      assert.equal(decoded.fee, 168223n);
      assert.equal(decoded.outputs.length, 2);
    });
  });
});

// Fix, verified once by a throwaway probe and never pinned by a permanent
// test until now (see the task report): readAssets() builds each asset's
// `unit` string as `policy.to_hex() + name.to_hex()`, specifically NOT
// `name.to_cbor_hex().slice(2)`. name.to_cbor_hex() carries a CBOR
// byte-string header that is 1 byte for names up to 23 bytes long but grows
// to 2 bytes at 24 (Cardano asset names run up to 32 bytes) — a fixed
// slice(2) strips only the first form correctly and leaves the second
// header byte glued onto the front of the "unit" for every 24-32 byte name,
// silently corrupting it. to_hex() returns the raw bytes with no CBOR
// envelope at all, so it is correct at every length. Nothing in the rest of
// this suite constructs a real multi-asset output, so this was previously
// completely unexercised.
describe('native asset units — asset names at and beyond the 24-byte CBOR-header boundary', () => {
  // Deterministic, not random: sequential bytes offset by a per-fixture seed
  // so the three names never collide and a failure is reproducible from
  // this description alone. 28 bytes for the policy ID because ScriptHash
  // (a Cardano policy ID) is always exactly 28 bytes, never variable.
  function hexOfLength(byteLen: number, seed: number): string {
    return Array.from({ length: byteLen }, (_, i) => ((i + seed) % 256).toString(16).padStart(2, '0')).join('');
  }

  const POLICY_HEX = hexOfLength(28, 0);
  // Just under the boundary (1-byte CBOR header either way) — confirms the
  // fix is not merely coincidentally right only at 24+ while accidentally
  // still being right below it for some other reason.
  const NAME_23 = hexOfLength(23, 1);
  // Exactly the length at which CBOR's byte-string header grows from 1 byte
  // to 2 — the precise boundary the reverted `to_cbor_hex().slice(2)` form
  // corrupts.
  const NAME_24 = hexOfLength(24, 50);
  // The maximum asset name length Cardano allows.
  const NAME_32 = hexOfLength(32, 100);

  // Real CML MultiAsset construction, not a hand-rolled CBOR fixture: builds
  // one output on top of FIXTURE_CBOR's own body/inputs/fee carrying all
  // three asset names under one policy, then re-serialises through
  // Transaction.new(...).to_cbor_hex() so this exercises decodeTransaction's
  // full parse path, including its trailing-bytes consumption check, not
  // just readAssets() in isolation.
  function fixtureWithAssets(): string {
    const unsigned = CML.Transaction.from_cbor_hex(FIXTURE_CBOR);
    const body = unsigned.body();
    const existingOutput = body.outputs().get(0);

    const policy = CML.ScriptHash.from_hex(POLICY_HEX);
    const assets = CML.MapAssetNameToCoin.new();
    assets.insert(CML.AssetName.from_hex(NAME_23), 1_000n);
    assets.insert(CML.AssetName.from_hex(NAME_24), 2_000n);
    assets.insert(CML.AssetName.from_hex(NAME_32), 3_000n);
    const multiasset = CML.MultiAsset.new();
    multiasset.insert_assets(policy, assets);
    const value = CML.Value.new(3_000_000n, multiasset);

    const outputWithAssets = CML.TransactionOutput.new(existingOutput.address(), value, undefined, undefined);
    const outputs = CML.TransactionOutputList.new();
    outputs.add(outputWithAssets);
    const newBody = CML.TransactionBody.new(body.inputs(), outputs, body.fee());
    const tx = CML.Transaction.new(newBody, CML.TransactionWitnessSet.new(), true, undefined);
    return tx.to_cbor_hex();
  }

  test('a 23-byte name (just under the boundary) decodes to policyHex + assetNameHex exactly', () => {
    const { outputs } = decodeTransaction(fixtureWithAssets());
    const unit = outputs[0].assets.find((a) => a.quantity === 1_000n)?.unit;
    assert.equal(unit, `${POLICY_HEX}${NAME_23}`);
  });

  test('a 24-byte name (exactly at the boundary) decodes to policyHex + assetNameHex exactly, not with a stray leading CBOR header byte', () => {
    const { outputs } = decodeTransaction(fixtureWithAssets());
    const unit = outputs[0].assets.find((a) => a.quantity === 2_000n)?.unit;
    assert.equal(unit, `${POLICY_HEX}${NAME_24}`);
  });

  test('a 32-byte name (the maximum Cardano allows) decodes to policyHex + assetNameHex exactly', () => {
    const { outputs } = decodeTransaction(fixtureWithAssets());
    const unit = outputs[0].assets.find((a) => a.quantity === 3_000n)?.unit;
    assert.equal(unit, `${POLICY_HEX}${NAME_32}`);
  });

  test('all three assets are reported on the one output that carries them, with their quantities intact', () => {
    const { outputs } = decodeTransaction(fixtureWithAssets());
    assert.equal(outputs[0].assets.length, 3);
    const quantities = outputs[0].assets.map((a) => a.quantity).sort();
    assert.deepEqual(quantities, [1_000n, 2_000n, 3_000n]);
  });
});
