// packages/signer/test/sign-script-tx.test.ts
//
// Hermetic pin: proves the SIGNER's own signTransaction (src/sign.ts) signs a
// script-bearing transaction without dropping its plutus_v3_scripts,
// redeemers, or plutus_datums. Standing follow-up closed here: sign.test.ts's
// FIXTURE_CBOR carries no script witnesses at all, so the signer suite never
// exercised this path before this file - "the signer suite never signs a
// script tx".
//
// Mirrors packages/builder/test/sign-helper.test.ts's synthetic
// script-bearing tx construction (same shape: one input, one output, one
// PlutusV3 script, one redeemer, one datum in the witness set) so the two
// "does signing preserve a script witness set" pins - builder's
// signWithMnemonic path and the signer's own signTransaction(cbor, bech32Key)
// path - stay directly comparable, even though the two packages sign through
// different call surfaces (a mnemonic vs. a raw bech32 private key).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { signTransaction } from '../src/sign.ts';
import { MnemonicKeySource } from '../src/keysource.ts';

// Public BIP39 test vector: 23x "abandon" + the checksum word "art" (the
// 24-word encoding of all-zero, 256-bit entropy - verified directly against
// the `bip39` package's own entropyToMnemonic(), not transcribed from
// memory: `bip39.entropyToMnemonic('00'.repeat(32))`). Same constant
// sign-helper.test.ts uses on the builder side. This is the canonical
// example mnemonic used throughout the crypto tooling ecosystem specifically
// because it is universally known, was never funded, and holds nothing on
// any network. TEST-ONLY - used here purely to exercise signing logic
// offline; never use it, or any mnemonic like it, for anything that touches
// real funds.
const TEST_ONLY_PUBLIC_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

/**
 * Builds a synthetic, offline, script-bearing unsigned transaction: one
 * input, one output, and a witness set carrying one PlutusV3 script, one
 * redeemer, and one datum - enough to exercise every witness-set category
 * signTransaction must preserve, without a live network, a real validator,
 * or Lucid's TransactionBuilder. Identical shape to
 * sign-helper.test.ts's buildSyntheticScriptBearingTx, parameterised on the
 * output address so the caller can supply one derived via the signer's own
 * MnemonicKeySource rather than a second, separate walletFromSeed call.
 */
function buildSyntheticScriptBearingTx(address: string): string {
  const addr = CML.Address.from_bech32(address);

  const inputs = CML.TransactionInputList.new();
  inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex('00'.repeat(32)), 0n));

  const outputs = CML.TransactionOutputList.new();
  outputs.add(CML.TransactionOutput.new(addr, CML.Value.from_coin(2_000_000n)));

  const body = CML.TransactionBody.new(inputs, outputs, 200_000n);

  const witnessSet = CML.TransactionWitnessSet.new();

  const scripts = CML.PlutusV3ScriptList.new();
  scripts.add(CML.PlutusV3Script.from_hex('4e4d01000033222220051200120011'));
  witnessSet.set_plutus_v3_scripts(scripts);

  const redeemerMap = CML.MapRedeemerKeyToRedeemerVal.new();
  redeemerMap.insert(
    CML.RedeemerKey.new(CML.RedeemerTag.Mint, 0n),
    CML.RedeemerVal.new(CML.PlutusData.new_bytes(new Uint8Array([1, 2, 3])), CML.ExUnits.new(1_000n, 1_000n)),
  );
  witnessSet.set_redeemers(CML.Redeemers.new_map_redeemer_key_to_redeemer_val(redeemerMap));

  const datums = CML.PlutusDataList.new();
  datums.add(CML.PlutusData.new_bytes(new Uint8Array([9, 9, 9])));
  witnessSet.set_plutus_datums(datums);

  return CML.Transaction.new(body, witnessSet, true).to_cbor_hex();
}

describe('signTransaction preserves an existing script witness set (hermetic pin, signer side)', () => {
  test('signing a script-bearing tx keeps the vkey witness AND the original scripts/redeemers/datums, and leaves the body hash unchanged', () => {
    // Same canonical derivation MnemonicKeySource.load() uses elsewhere in
    // this package (walletFromSeed under Mainnet, account index 0) - reused
    // here rather than a second, separate call, so this fixture's output
    // address and its signing key come from one source of truth.
    const { privateKeyBech32, address } = new MnemonicKeySource(TEST_ONLY_PUBLIC_MNEMONIC).load();

    const unsignedCborHex = buildSyntheticScriptBearingTx(address);
    const unsignedBodyHashHex = CML.hash_transaction(CML.Transaction.from_cbor_hex(unsignedCborHex).body()).to_hex();
    const redeemersBefore = CML.Transaction.from_cbor_hex(unsignedCborHex).witness_set().redeemers()!.to_cbor_hex();

    const { signedCborHex, txHashHex } = signTransaction(unsignedCborHex, privateKeyBech32);

    assert.equal(txHashHex, unsignedBodyHashHex, 'signing must not change the transaction body hash');

    const signed = CML.Transaction.from_cbor_hex(signedCborHex);
    assert.equal(
      CML.hash_transaction(signed.body()).to_hex(), unsignedBodyHashHex,
      'the signed tx body hash must still match the unsigned one',
    );

    const ws = signed.witness_set();

    const vkeys = ws.vkeywitnesses();
    assert.ok(vkeys && vkeys.len() === 1, `expected exactly 1 vkey witness after signing, got ${vkeys?.len() ?? 0}`);

    const scripts = ws.plutus_v3_scripts();
    assert.ok(scripts && scripts.len() === 1, `expected the original plutus_v3 script to survive signing, got ${scripts?.len() ?? 0}`);

    const redeemers = ws.redeemers();
    assert.ok(redeemers, 'expected the original redeemers to survive signing (got none)');
    assert.equal(
      redeemers!.as_map_redeemer_key_to_redeemer_val()?.len(), 1,
      'expected exactly 1 redeemer to survive signing',
    );
    assert.equal(
      redeemers!.to_cbor_hex(), redeemersBefore,
      'redeemer CBOR must survive signing byte-identically',
    );

    const datums = ws.plutus_datums();
    assert.ok(datums && datums.len() === 1, `expected the original plutus datum to survive signing, got ${datums?.len() ?? 0}`);
  });
});
