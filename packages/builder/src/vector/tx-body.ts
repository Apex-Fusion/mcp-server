// packages/builder/src/vector/tx-body.ts
// The body of a transaction, read from its bytes without a decoder library: the keys of the body map, and the bytes that the body takes.
// The reader goes over the entries of the body one after the other, and skips each key and each value with the loop and the list of
// cborReader (tx-fee.ts). The time is linear in the size of the input, no recursion is used, and nothing is allocated for a length or a
// count that the bytes declare. A caller that gets a transaction from another party reads the keys of the body here first, and gives the
// bytes to a decoder library only when the keys are the ones that it accepts.
import { ARRAY, BREAK, INDEFINITE, MAP, UNSIGNED, cborReader } from './tx-fee.js';

/** What the bytes of a transaction say about its body. */
export interface TransactionBody {
  /** The keys of the body map that are unsigned integers, in the order of the bytes. A key that the bytes repeat is listed each time. */
  keys: number[];
  /** The bytes of the body are the bytes `start` up to `end` of the transaction: the map from its header to its last byte. */
  start: number;
  end: number;
}

/**
 * The keys and the bytes of the body of the transaction `bytes`, or undefined when the bytes are not one that this reader can read: the first
 * item is not an array, the first item of the array is not a map, or the map is not well-formed CBOR up to its end (a header that is cut or
 * that CBOR does not have, a length or a count that goes past the bytes, a map of indefinite length with no break code). A key that is not
 * an unsigned integer is skipped and is not listed. The reader reads the body and no more of the bytes.
 */
export function readTransactionBody(bytes: Uint8Array): TransactionBody | undefined {
  const reader = cborReader(bytes);
  // The transaction is an array, and its first item is the body, a map.
  if (reader.header() !== ARRAY || reader.argument === 0) return undefined;
  const start = reader.pos;
  if (reader.header() !== MAP) return undefined;
  const keys: number[] = [];
  let entries = reader.argument;
  while (entries !== 0) {
    if (entries === INDEFINITE) {
      if (bytes[reader.pos] === BREAK) {
        reader.pos += 1;
        break;
      }
    } else {
      entries -= 1;
    }
    const keyStart = reader.pos;
    if (reader.header() === UNSIGNED) {
      keys.push(reader.argument);
    } else {
      // Not an unsigned integer, or no header that CBOR has: skip reads the whole key, and gives false when the bytes end or are not CBOR.
      reader.pos = keyStart;
      if (!reader.skip()) return undefined;
    }
    if (!reader.skip()) return undefined;
  }
  return { keys, start, end: reader.pos };
}
