// packages/builder/src/vector/ed25519-rules.ts
// The signature rules of the ledger, for each check of an Ed25519 signature that another party made: the witnesses of a transaction
// (delegation-cosign.ts), the envelope of an attestation (attestation-build.ts), the receipt of a supplier (marketplace-verify.ts) and a
// signature at a time (signature-at.ts). The library of the node refuses a public key of a small order, a signature whose R has a small
// order, and a signature whose S is not below the group order. The check of CML does not refuse the first two. A verifier that calls CML
// alone takes a forged signature for a key of a small order, so every verifier of this server calls signatureVerifies.
import { CML } from '@lucid-evolution/lucid';

/**
 * The encodings of the points of order 1, 2, 4 and 8 (the y of each, as the library of the node lists them), with the two other spellings
 * of 0 and 1 (p and p + 1). The sign bit is not compared. A public key or a signature start that is in this list is refused. Any other
 * non-canonical spelling is of a point that nobody can sign for, so it needs no rule of its own.
 */
export const SMALL_ORDER_ENCODINGS: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];
/** Has the point that `bytes` spells, without its sign bit, a small order? */
export const hasSmallOrder = (bytes: Uint8Array): boolean => {
  const point = Buffer.from(bytes);
  point[31] &= 0x7f;
  return SMALL_ORDER_ENCODINGS.includes(point.toString('hex'));
};

/**
 * Does `signature` verify over `message` for `publicKey`, by the rules of the ledger? The library of the node refuses a public key with a
 * small order, a signature whose R has a small order, and a signature whose S is not below the group order. The check of CML is lax for
 * a small order: for many public keys of small order, a signature of R = the identity point and S = 0 verifies over some messages (over
 * every message when the key is the identity point, with R = the base point and S = 1 as well), and a signature with R = the identity point
 * and a good S verifies for a key that the signer holds. So the first two rules are checked here, and CML checks the encoding of R, S below
 * the group order, and the equation. CML does not throw for a key of 32 bytes or a signature of 64 bytes, so only the lengths are checked.
 */
export function signatureVerifies(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (hasSmallOrder(publicKey) || hasSmallOrder(signature.subarray(0, 32))) return false;
  return CML.PublicKey.from_bytes(publicKey).verify(message, CML.Ed25519Signature.from_raw_bytes(signature));
}
