// packages/builder/src/vector/guarded-decode.ts
//
// The function through which this package reads an address. No other file of this package calls Lucid's `getAddressDetails`:
// decoder-sites.test.ts reads the sources to check that.
import { getAddressDetails } from '@lucid-evolution/lucid';
import type { AddressDetails } from '@lucid-evolution/lucid';

/**
 * The details of an address, as Lucid's `getAddressDetails` gives them. Every address that a tool, a datum or a setting gives is read
 * through this function. The empty string is refused here, with the message that Lucid gives for any text that is not an address, so
 * that the decoder does not see it.
 */
export function addressDetails(address: string): AddressDetails {
  if (address === '') throw new Error('No address type matched for: ');
  return getAddressDetails(address);
}
