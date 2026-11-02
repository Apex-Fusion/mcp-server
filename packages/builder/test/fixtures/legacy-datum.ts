// packages/builder/test/fixtures/legacy-datum.ts
// The datum of a legacy registry record (did:vector method specification Section 5, LegacyDatum), for test fixtures. The legacy
// register builder is retired, so the tests write the datum with the identity codec.
import { encodeLegacyDatum, utf8Hex } from '../../src/vector/identity-codec.ts';

/** A legacy record datum owned by the key hash `ownerHash`, with the profile as text. */
export function legacyAgentDatum(
  ownerHash: string, name: string, description: string, capabilities: string[], framework: string, endpoint: string,
  registeredAt = 1_750_000_000_000,
): string {
  return encodeLegacyDatum({
    owner: { type: 'VerificationKey', hash: ownerHash }, name: utf8Hex(name), description: utf8Hex(description),
    capabilities: capabilities.map(utf8Hex), framework: utf8Hex(framework), endpoint: utf8Hex(endpoint), registeredAt: BigInt(registeredAt),
  });
}
