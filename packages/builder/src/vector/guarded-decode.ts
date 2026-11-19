// packages/builder/src/vector/guarded-decode.ts
//
// The function through which this package reads an address. No other file of this package calls Lucid's `getAddressDetails`:
// decoder-sites.test.ts reads the sources to check that.
import { getAddressDetails } from '@lucid-evolution/lucid';
import type { AddressDetails } from '@lucid-evolution/lucid';

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
