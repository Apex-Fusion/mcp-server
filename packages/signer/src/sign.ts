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
