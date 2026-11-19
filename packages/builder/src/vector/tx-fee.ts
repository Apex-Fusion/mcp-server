// packages/builder/src/vector/tx-fee.ts
// The fee of a transaction, read from its bytes without a decoder library: key 2 of the body, the first item of the transaction.
// The reader goes over the keys of the body one after the other, and skips the items that it does not need with a loop and a list of
// its own (cborReader, which tx-body.ts uses too). The time is linear in the size of the input. The caller checks the bytes first
// (cbor-depth.ts).

/** The count of an array or a map that has none: it ends at a break code. */
export const INDEFINITE = -1;
export const BREAK = 0xff;
/** The key of the fee in the body of a transaction. */
const FEE_KEY = 2;
/** The major types of CBOR that the readers tell apart. */
export const UNSIGNED = 0;
const BYTES = 2;
const TEXT = 3;
export const ARRAY = 4;
export const MAP = 5;
const TAG = 6;

/** What a reader of the bytes gives: the position, the header that it read last, and the two moves that the readers of a transaction share. */
export interface CborReader {
  /** The next byte to read. A reader moves it back to the start of an item when it has read only the header of the item. */
  pos: number;
  /** The additional information of the header that `header` read last, and its argument (INDEFINITE for a string, an array or a map that has no length). */
  readonly info: number;
  readonly argument: number;
  /** Reads the header at `pos` and moves `pos` past it. Returns its major type, or -1 when the header is cut or is not one that CBOR has. */
  header(): number;
  /** Moves `pos` past the item that starts there. False when the bytes end inside the item. */
  skip(): boolean;
}

/**
 * A reader over `bytes`, at the start of the bytes. Its `header` and `skip` use a loop and a list of their own, no recursion and no decoder
 * library, so the time is linear in the size of the input, and nothing is allocated for a length or a count that the bytes declare.
 */
export function cborReader(bytes: Uint8Array): CborReader {
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
            pos += argument; // the check at the top of the loop stops a chunk that goes past the bytes
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

  return {
    get pos() { return pos; },
    set pos(value: number) { pos = value; },
    get info() { return info; },
    get argument() { return argument; },
    header,
    skip,
  };
}

/**
 * The unsigned integer under key 2 of the body of the transaction `bytes`, or undefined when the bytes hold none: the first item is not
 * an array, the first item of the array is not a map, the map has no key 2, or the value of key 2 is not an unsigned integer. The reader
 * takes the first key 2 that it finds, reads no more of the bytes than it needs, and does not read the rest of the transaction.
 */
export function readTransactionFee(bytes: Uint8Array): bigint | undefined {
  const reader = cborReader(bytes);
  // The transaction is an array, and its first item is the body, a map.
  if (reader.header() !== ARRAY || reader.argument === 0) return undefined;
  if (reader.argument === INDEFINITE && bytes[reader.pos] === BREAK) return undefined;
  if (reader.header() !== MAP) return undefined;
  let entries = reader.argument;
  while (entries !== 0) {
    if (entries === INDEFINITE) {
      if (reader.pos >= bytes.length || bytes[reader.pos] === BREAK) return undefined;
    } else {
      entries -= 1;
    }
    const keyStart = reader.pos;
    const keyType = reader.header();
    if (keyType < 0) return undefined;
    if (keyType === UNSIGNED && reader.argument === FEE_KEY) {
      if (reader.header() !== UNSIGNED) return undefined;
      const size = reader.info < 24 ? 0 : 2 ** (reader.info - 24);
      return size === 0 ? BigInt(reader.info) : BigInt(`0x${Buffer.from(bytes.subarray(reader.pos - size, reader.pos)).toString('hex')}`);
    }
    reader.pos = keyStart;
    if (!reader.skip() || !reader.skip()) return undefined;
  }
  return undefined;
}
