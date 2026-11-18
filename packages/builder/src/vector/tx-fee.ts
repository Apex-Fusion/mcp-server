// packages/builder/src/vector/tx-fee.ts
// The fee of a transaction, read from its bytes without a decoder library: key 2 of the body, the first item of the transaction.
// The reader goes over the keys of the body one after the other, and skips the items that it does not need with a loop and a list of
// its own. The time is linear in the size of the input.

/** The count of an array or a map that has none: it ends at a break code. */
const INDEFINITE = -1;
const BREAK = 0xff;
/** The key of the fee in the body of a transaction. */
const FEE_KEY = 2;
/** The major types of CBOR that the reader tells apart. */
const UNSIGNED = 0;
const BYTES = 2;
const TEXT = 3;
const ARRAY = 4;
const MAP = 5;
const TAG = 6;

/**
 * The unsigned integer under key 2 of the body of the transaction `bytes`, or undefined when the bytes hold none: the first item is not
 * an array, the first item of the array is not a map, the map has no key 2, or the value of key 2 is not an unsigned integer. The reader
 * takes the first key 2 that it finds, reads no more of the bytes than it needs, and does not read the rest of the transaction.
 */
export function readTransactionFee(bytes: Uint8Array): bigint | undefined {
  let pos = 0;
  let info = 0;
  let argument = 0;

  /**
   * Reads the header at `pos` and moves `pos` past it. Returns its major type, or -1 when the bytes end inside the header or the header is
   * not one that CBOR has. Sets `info`, and `argument` (INDEFINITE for a string, an array or a map that has no length).
   */
  const header = (): number => {
    if (pos >= bytes.length) return -1;
    const initial = bytes[pos];
    pos += 1;
    const major = initial >> 5;
    info = initial & 31;
    if (info < 24) {
      argument = info;
      return major;
    }
    if (info === 31) {
      argument = INDEFINITE;
      return major >= BYTES && major <= MAP ? major : -1;
    }
    if (info > 27) return -1;
    const size = 2 ** (info - 24);
    if (bytes.length - pos < size) return -1;
    argument = 0;
    for (let i = 0; i < size; i += 1) argument = argument * 256 + bytes[pos + i];
    pos += size;
    return major;
  };

  /** Moves `pos` past the item that starts there. False when the bytes end inside the item. */
  const skip = (): boolean => {
    const outer: number[] = []; // for each array or map that is open: the items that it still has to read
    let left = 1; // the items still to read at this level, or INDEFINITE
    for (;;) {
      if (left === 0) {
        if (outer.length === 0) return true;
        left = outer.pop() as number;
        continue;
      }
      if (pos >= bytes.length) return false;
      if (bytes[pos] === BREAK) {
        if (left !== INDEFINITE) return false;
        pos += 1;
        left = 0;
        continue;
      }
      const major = header();
      if (major < 0) return false;
      if (left !== INDEFINITE) left -= 1;
      if (major === BYTES || major === TEXT) {
        if (argument === INDEFINITE) {
          for (;;) {
            if (pos >= bytes.length) return false;
            if (bytes[pos] === BREAK) {
              pos += 1;
              break;
            }
            if (header() < 0 || argument === INDEFINITE) return false;
            pos += argument;
            if (pos > bytes.length) return false;
          }
        } else {
          pos += argument;
          if (pos > bytes.length) return false;
        }
      } else if (major === ARRAY || major === MAP) {
        const count = argument === INDEFINITE ? INDEFINITE : major === ARRAY ? argument : argument * 2;
        if (count !== 0) {
          outer.push(left);
          left = count;
        }
      } else if (major === TAG && left !== INDEFINITE) {
        left += 1; // a tag and the item under it are one item of the level
      }
    }
  };

  // The transaction is an array, and its first item is the body, a map.
  if (header() !== ARRAY || argument === 0) return undefined;
  if (argument === INDEFINITE && bytes[pos] === BREAK) return undefined;
  if (header() !== MAP) return undefined;
  let entries = argument;
  while (entries !== 0) {
    if (entries === INDEFINITE) {
      if (pos >= bytes.length || bytes[pos] === BREAK) return undefined;
    } else {
      entries -= 1;
    }
    const keyStart = pos;
    const keyType = header();
    if (keyType < 0) return undefined;
    if (keyType === UNSIGNED && argument === FEE_KEY) {
      if (header() !== UNSIGNED) return undefined;
      const size = info < 24 ? 0 : 2 ** (info - 24);
      return size === 0 ? BigInt(info) : BigInt(`0x${Buffer.from(bytes.subarray(pos - size, pos)).toString('hex')}`);
    }
    pos = keyStart;
    if (!skip() || !skip()) return undefined;
  }
  return undefined;
}
