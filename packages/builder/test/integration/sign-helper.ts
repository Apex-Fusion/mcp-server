// packages/builder/test/integration/sign-helper.ts
//
// Shared local-signing helper for the integration suites. Stands in for the
// in-tree local signer (packages/signer) — same CML primitives (hash ->
// make_vkey_witness -> witness-set attach), without the signer's own
// decode/policy/audit path. Extracted verbatim (Task 5, spec PR 7) from the
// inline signing block keyless-e2e.test.ts proved against the live testnet in
// PR #9's E2E, so registry-e2e.test.ts and run.test.ts's registry section can
// share it instead of re-inlining the same sequence.
import { CML, walletFromSeed } from '@lucid-evolution/lucid';

/**
 * Sign an unsigned transaction (CBOR hex) with the payment key derived from a
 * mnemonic. Takes the mnemonic directly (not a pre-derived key) so every
 * caller can go straight from `getMnemonic()` to a signed transaction in one
 * call.
 *
 * CORRECTION vs. the original inline block this was extracted from: that
 * block built the signed tx's witness set from scratch
 * (`CML.TransactionWitnessSet.new()`, only ever given the new vkey witness),
 * which is lossless only when the unsigned tx's own witness set is empty -
 * true for a plain payment (keyless-e2e.test.ts's proven case: no script, no
 * redeemer). The agent-registry build_* tools attach a minting policy and/or
 * spending validator, so their unsigned CBOR already carries
 * plutus_v3_scripts/redeemers in `tx.witness_set()`, matched to a
 * script_data_hash baked into the tx BODY at build time. Replacing the
 * witness set outright silently drops that content; the ledger then rejects
 * the resigned tx with `MissingScriptWitnessesUTXOW` (script witness gone)
 * and `PPViewHashesDontMatch` (the body's script_data_hash no longer matches
 * a witness set the ledger now sees as script-free) - reproduced live via
 * registry-e2e.test.ts's register step, see task-5-report.md. Fixed by
 * merging the new vkey witness into the tx's EXISTING witness set with
 * `add_all_witnesses` (CML's documented primitive for exactly this "add a
 * signature to an already-witnessed tx" composition) instead of discarding
 * it. Strictly more correct and a no-op behavior change for the script-less
 * case, since there's nothing else to preserve there.
 */
export function signWithMnemonic(unsignedCborHex: string, mnemonic: string): { signedCborHex: string; txHash: string } {
  const { paymentKey } = walletFromSeed(mnemonic, { network: 'Mainnet', accountIndex: 0 });
  const tx = CML.Transaction.from_cbor_hex(unsignedCborHex);
  const txHash = CML.hash_transaction(tx.body());
  const sk = CML.PrivateKey.from_bech32(paymentKey);
  const vkeyWitness = CML.make_vkey_witness(txHash, sk);

  const witnessSet = tx.witness_set();
  const newWitnesses = CML.TransactionWitnessSet.new();
  const vkeys = CML.VkeywitnessList.new();
  vkeys.add(vkeyWitness);
  newWitnesses.set_vkeywitnesses(vkeys);
  witnessSet.add_all_witnesses(newWitnesses);

  const signed = CML.Transaction.new(tx.body(), witnessSet, tx.is_valid(), tx.auxiliary_data());
  return { signedCborHex: signed.to_cbor_hex(), txHash: txHash.to_hex() };
}
