// packages/builder/src/vector/guarded-decode.ts
//
// The decoders for CBOR that this package did not build itself: a transaction, Plutus data and transaction metadata. Each one runs the
// check of @apexfusion/vector-mcp-shared/cbor-depth before CML or Lucid reads the bytes. CBOR that is nested deeper than
// MAX_CBOR_DEPTH levels, that is not well-formed, or that holds a float or a simple value where the decoder reads none is refused
// with an ordinary Error (a CborGuardError), and the decoder does not see it.
//
// The second part of the file checks the hex that a caller gives for a part of a transaction (a datum, a redeemer, a script) before a
// library reads it. No other file of this package calls the decoders of CML or Lucid's `Data.from` on such bytes, or Lucid's
// `getAddressDetails` on an address: cbor-guard-sites.test.ts reads the sources to check that.
import { CML, Data, getAddressDetails } from '@lucid-evolution/lucid';
import type { AddressDetails } from '@lucid-evolution/lucid';
import { assertCborDepth, assertCborHexDepth } from '@apexfusion/vector-mcp-shared/cbor-depth';

/** A transaction (hex CBOR) as CML decodes it. `what` names the value in a refusal. */
export function decodeTransaction(cborHex: string, what = 'The transaction'): CML.Transaction {
  assertCborHexDepth(cborHex, { what, kind: 'transaction' });
  return CML.Transaction.from_cbor_hex(cborHex);
}

/** The check of decodePlutusData, for hex that Lucid decodes itself: a datum or a redeemer that a builder hands to Lucid. */
export function assertPlutusDataHex(hex: string, what = 'The datum'): void {
  assertCborHexDepth(hex, { what });
}

/** Plutus data (hex CBOR) as Lucid's `Data.from` reads it. `what` names the value in a refusal. */
export function decodePlutusData(hex: string, what = 'The datum'): Data {
  assertPlutusDataHex(hex, what);
  return Data.from(hex);
}

/**
 * The most hex characters of a datum, a redeemer or a script that a caller gives: 32,768. Each one is a part of a transaction, and a
 * transaction has at most 16,384 bytes (the protocol parameter `max_tx_size`). A longer text is refused before a library reads it.
 */
const MAX_PART_HEX_CHARS = 32_768;

function assertPartSize(hex: string, what: string): void {
  if (hex.length > MAX_PART_HEX_CHARS) {
    throw new Error(`${what} has ${hex.length} hex characters, and the most is ${MAX_PART_HEX_CHARS} (a transaction has at most 16,384 bytes).`);
  }
}

/** A datum or a redeemer that a caller gives, before a builder hands it to Lucid: its size, then the check of decodePlutusData. */
export function assertDatumInput(hex: string, what: string): void {
  assertPartSize(hex, what);
  assertPlutusDataHex(hex, what);
}

/** The number of bytes that follow the first byte of a CBOR head, by its additional information (24 to 27). */
const LENGTH_BYTES: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };

/**
 * The script that a caller gives, before `applyDoubleCborEncoding` reads it (that function decodes the text in JavaScript). The
 * text must be hex of one CBOR byte string, of definite length, whose length is the number of bytes after its head: a script in one
 * encoding, or in two (a byte string inside a byte string). Only the first bytes are read, so the check takes the same short time for
 * any size. The bytes inside the string are the script itself, not CBOR: they must not start like an array, a map or a tag.
 */
export function assertScriptInput(hex: string, what = 'scriptCbor'): void {
  assertPartSize(hex, what);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`${what} is not hex of whole bytes.`);
  const total = hex.length / 2;
  const head = parseInt(hex.slice(0, 2), 16);
  const info = head & 31;
  const lengthBytes = info < 24 ? 0 : LENGTH_BYTES[info];
  const notOneByteString = `${what} is not one CBOR byte string: the text must be the head of a byte string of definite length and then exactly that many bytes.`;
  if (head >> 5 !== 2 || lengthBytes === undefined || total < 1 + lengthBytes) throw new Error(notOneByteString);
  const declared = info < 24 ? BigInt(info) : BigInt(`0x${hex.slice(2, 2 + 2 * lengthBytes)}`);
  if (declared !== BigInt(total - 1 - lengthBytes)) throw new Error(notOneByteString);
  if (declared === 0n) throw new Error(`${what} holds no script bytes.`);
  const inner = parseInt(hex.slice(2 + 2 * lengthBytes, 4 + 2 * lengthBytes), 16) >> 5;
  if (inner >= 4 && inner <= 6) throw new Error(`${what} holds script bytes that start like an array, a map or a tag.`);
}

/** Transaction metadata (CBOR bytes) as CML decodes it. `what` names the value in a refusal. */
export function decodeMetadatum(cbor: Uint8Array, what = 'The metadata'): CML.TransactionMetadatum {
  assertCborDepth(cbor, { what });
  return CML.TransactionMetadatum.from_cbor_bytes(cbor);
}

/**
 * The most characters that the text of an address has here: 1,024. No valid address is that long. Lucid reads a Shelley address as hex
 * or bech32: 29 or 57 bytes, and a pointer address adds three numbers of at most 64 bits each. Lucid reads a Byron address as hex or
 * base58, and the ledger limits the attributes of a Byron address to 64 bytes. So the longest text of an address has a few hundred
 * characters. A longer text is not read, and the refusal does not repeat it.
 */
const MAX_ADDRESS_CHARS = 1_024;

/**
 * The details of an address, as Lucid's `getAddressDetails` gives them. Every address that a tool, a datum or a setting gives is read
 * through this function. The empty string is refused here, with the message that Lucid gives for any text that is not an address, so
 * that the decoder does not see it. A text of more than MAX_ADDRESS_CHARS characters is refused here too, before Lucid reads it, with
 * a message that names its length and its first 40 characters, not the whole text.
 */
export function addressDetails(address: string): AddressDetails {
  if (address === '') throw new Error('No address type matched for: ');
  if (address.length > MAX_ADDRESS_CHARS) {
    throw new Error(`The text has ${address.length} characters, and an address has at most ${MAX_ADDRESS_CHARS}. It starts with: ${address.slice(0, 40)}`);
  }
  return getAddressDetails(address);
}
