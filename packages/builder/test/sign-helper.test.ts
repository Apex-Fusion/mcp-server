// packages/builder/test/sign-helper.test.ts
//
// Hermetic pin for signWithMnemonic's witness-preservation fix
// (test/integration/sign-helper.ts). Proves offline, with zero network
// access and zero real secrets, that signing a script-bearing transaction
// preserves its existing plutus_v3_scripts/redeemers/plutus_datums instead
// of discarding them - the defect found live during Task 5's gated E2E run
// (see task-5-report.md, "Bug #1").
//
// Why this needs its own test: none of the existing gates catch this
// mutant. sign-helper.ts lives under test/integration/, outside every unit
// test glob (packages/*/test/*.test.ts is non-recursive). run.test.ts's
// assertSuccessOrKnownError treats the resulting "Failed to submit
// transaction" as a tolerated known error (indistinguishable from an
// unfunded wallet) rather than a hard failure. And registry-e2e.test.ts's
// hash-equality check (`assert.equal(submittedHash, txHash, ...)`) cannot
// catch it either: dropping witnesses never changes the transaction BODY,
// so the mutant computes the exact same body hash as the fix - only the
// ledger, which this test never talks to, rejects the mutant's CBOR. This
// file is the only gate that would fail if the fix regressed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML, walletFromSeed } from '@lucid-evolution/lucid';
import { signWithMnemonic } from './integration/sign-helper.ts';

// Public BIP39 test vector: 23x "abandon" + the checksum word "art" (the
// 24-word encoding of all-zero, 256-bit entropy - verified directly against
// the `bip39` package's own entropyToMnemonic(), not transcribed from
// memory: `bip39.entropyToMnemonic('00'.repeat(32))`). This is the
// canonical example mnemonic used throughout the crypto tooling ecosystem
// specifically because it is universally known, was never funded, and
// holds nothing on any network. TEST-ONLY - used here purely to exercise
// signing logic offline; never use it, or any mnemonic like it, for
// anything that touches real funds.
const TEST_ONLY_PUBLIC_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

/**
 * Builds a synthetic, offline, script-bearing unsigned transaction: one
 * input, one output, and a witness set carrying one PlutusV3 script, one
 * redeemer, and one datum - enough to exercise every witness-set category
 * signWithMnemonic must preserve, without a live network, a real validator,
 * or Lucid's TransactionBuilder (whose min-UTxO/fee rules this probe has no
 * reason to satisfy: these are raw CML data containers, hashed and
 * re-serialized, never evaluated or submitted anywhere).
 */
function buildSyntheticScriptBearingTx(): string {
  const { address } = walletFromSeed(TEST_ONLY_PUBLIC_MNEMONIC, { network: 'Mainnet', accountIndex: 0 });
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

describe('signWithMnemonic preserves an existing script witness set (hermetic pin, task-5-report.md Bug #1)', () => {
  test('signing a script-bearing tx keeps the vkey witness AND the original scripts/redeemers/datums, and leaves the body hash unchanged', () => {
    const unsignedCborHex = buildSyntheticScriptBearingTx();
    const unsignedBodyHashHex = CML.hash_transaction(CML.Transaction.from_cbor_hex(unsignedCborHex).body()).to_hex();

    const { signedCborHex, txHash } = signWithMnemonic(unsignedCborHex, TEST_ONLY_PUBLIC_MNEMONIC);

    assert.equal(txHash, unsignedBodyHashHex, 'signing must not change the transaction body hash');

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

    const datums = ws.plutus_datums();
    assert.ok(datums && datums.len() === 1, `expected the original plutus datum to survive signing, got ${datums?.len() ?? 0}`);
  });
});
