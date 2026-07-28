// Sign with CML directly. No Lucid instance and no Provider — Lucid's
// constructor requires a Provider, which would put a network object inside the
// signer. This path was verified to produce a byte-identical result.
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';

export function signTransaction(
  unsignedCborHex: string,
  privateKeyBech32: string
): { signedCborHex: string; txHashHex: string } {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(unsignedCborHex);
  } catch (err) {
    throw new Error(
      `Transaction could not be decoded: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // from_cbor_hex only requires that a *prefix* of unsignedCborHex parse as a
  // valid transaction — it does not check that parsing consumed the whole
  // string. This is the same gap decode.ts closes (see its comment for the
  // full reasoning) and the check here is deliberately identical. sign.ts
  // calls from_cbor_hex independently and does NOT inherit decode.ts's guard
  // automatically just because the two modules share a package: confirmed
  // empirically that, without this check, signing FIXTURE_CBOR with
  // 'deadbeef' appended did not throw — it silently signed the shorter,
  // valid prefix and returned a confident, fully-formed signature, with the
  // appended bytes dropped and no indication anything was wrong. That is
  // worse here than in decode.ts: the caller would receive a cryptographic
  // signature over DIFFERENT, FEWER bytes than it actually asked to sign,
  // with nothing to reveal the discrepancy. Compared case-insensitively:
  // valid uppercase-hex input round-trips through CML as lowercase, which
  // would otherwise read as a false-positive mismatch.
  if (tx.to_cbor_hex().toLowerCase() !== unsignedCborHex.toLowerCase()) {
    throw new Error(
      'Transaction could not be decoded: input was not fully consumed (unrecognised trailing data)'
    );
  }

  let sk: CML.PrivateKey;
  try {
    sk = CML.PrivateKey.from_bech32(privateKeyBech32);
  } catch {
    // Never echo the key value into the message.
    throw new Error('Invalid private key: could not parse the bech32 signing key.');
  }

  const body = tx.body();
  const txHash = CML.hash_transaction(body);
  const signature = sk.sign(txHash.to_raw_bytes());

  const witnessSet = tx.witness_set();
  const vkeys = CML.VkeywitnessList.new();
  const existing = witnessSet.vkeywitnesses();
  if (existing) {
    for (let i = 0; i < existing.len(); i++) vkeys.add(existing.get(i));
  }
  vkeys.add(CML.Vkeywitness.new(sk.to_public(), signature));
  witnessSet.set_vkeywitnesses(vkeys);

  const signed = CML.Transaction.new(body, witnessSet, true, tx.auxiliary_data());

  return { signedCborHex: signed.to_cbor_hex(), txHashHex: txHash.to_hex() };
}
