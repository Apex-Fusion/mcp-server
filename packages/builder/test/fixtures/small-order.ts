// packages/builder/test/fixtures/small-order.ts
// Points of a small order, and the signatures that forge with them, for the tests of the signature rules of the ledger (ed25519-rules.ts).
// The check of CML does not refuse a public key of a small order, and it does not refuse an R of a small order. For the identity point as
// the key, R = the identity point and S = 0 verifies over every message. For the other points of a small order it verifies over some of
// them. A signature with R = the identity point and S = k * a verifies for the key that the holder of a also has.
import { createHash } from 'node:crypto';
import { CML } from '@lucid-evolution/lucid';
import { SMALL_ORDER_ENCODINGS } from '../../src/vector/ed25519-rules.ts';

/** The order of the group of the points of the prime order: S must be below it. */
export const L = 2n ** 252n + 27742317777372353535851937790883648493n;
export const fromLE = (bytes: Uint8Array): bigint => bytes.reduce((acc, byte, i) => acc + (BigInt(byte) << BigInt(8 * i)), 0n);
export const toLE = (n: bigint, length: number): Buffer => {
  const out = Buffer.alloc(length);
  for (let i = 0, rest = n; i < length; i++, rest >>= 8n) out[i] = Number(rest & 0xffn);
  return out;
};
const sha512 = (...parts: Uint8Array[]): Buffer => createHash('sha512').update(Buffer.concat(parts)).digest();

/** The identity point: a public key for which every message verifies with the universal signature. */
export const IDENTITY_POINT_HEX = `01${'00'.repeat(31)}`;
/** R = the identity point and S = 0: the signature that forges a message for a public key of a small order. */
export const UNIVERSAL_SIGNATURE_HEX = `${IDENTITY_POINT_HEX}${'00'.repeat(32)}`;
/** R = the base point and S = 1: for the identity point as the key, [S]B = R holds over every message, and R has no small order. Only the rule for the key refuses it. */
export const BASE_POINT_SIGNATURE_HEX = `5866${'66'.repeat(30)}01${'00'.repeat(31)}`;

/** Spellings of the points of a small order, as a public key. */
export const SMALL_ORDER_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['y = 0 (order 4)', '00'.repeat(32)], ['y = 0 with the sign bit', `${'00'.repeat(31)}80`], ['the identity point (order 1)', IDENTITY_POINT_HEX],
  ['the identity point with the sign bit', `01${'00'.repeat(30)}80`], ['order 8', SMALL_ORDER_ENCODINGS[2]], ['order 8, the other y', SMALL_ORDER_ENCODINGS[3]],
  ['y = p - 1 (order 2)', SMALL_ORDER_ENCODINGS[4]], ['p, another spelling of 0', SMALL_ORDER_ENCODINGS[5]], ['p + 1, another spelling of 1', SMALL_ORDER_ENCODINGS[6]],
];

/**
 * The first `i` below `limit` for which CML alone takes the universal signature over `messageAt(i)` for the public key `keyHex`, or null.
 * For the identity point it is the first message. For the other keys of a small order it is some message, and the search finds it.
 */
export function forgedIndex(keyHex: string, messageAt: (i: number) => Uint8Array, limit = 2_000): number | null {
  const key = CML.PublicKey.from_bytes(Buffer.from(keyHex, 'hex'));
  const signature = CML.Ed25519Signature.from_raw_bytes(Buffer.from(UNIVERSAL_SIGNATURE_HEX, 'hex'));
  for (let i = 0; i < limit; i++) if (key.verify(messageAt(i), signature)) return i;
  return null;
}

/**
 * The signature that the holder of `seed` makes over `message` with R = the identity point and S = k * a (a is the secret scalar, k the
 * hash of R, the key and the message, mod L). The equation holds, so CML takes it. The node does not, because R has a small order.
 */
export function signatureWithIdentityR(seed: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Buffer {
  const point = Buffer.from(IDENTITY_POINT_HEX, 'hex');
  const scalar = Buffer.from(sha512(seed).subarray(0, 32));
  scalar[0] &= 248; scalar[31] &= 127; scalar[31] |= 64;
  const k = fromLE(sha512(point, publicKey, message)) % L;
  return Buffer.concat([point, toLE((k * fromLE(scalar)) % L, 32)]);
}

/** `signature` with S raised by `times` times the group order: S + L is the same point for the equation, and it is not below L. */
export function withScalarRaised(signature: Uint8Array, times: bigint): Buffer {
  return Buffer.concat([signature.subarray(0, 32), toLE(fromLE(signature.subarray(32)) + times * L, 32)]);
}
