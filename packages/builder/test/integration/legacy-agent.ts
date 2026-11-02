// packages/builder/test/integration/legacy-agent.ts
// A live legacy agent for the integration suites: vector_discover_agents reads the marketplace indexer now, so the suites that
// need a legacy DID read one from the legacy registry address directly. LIVE network (the configured Ogmios), read-only.
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { legacyRegistryAddress } from '../../src/vector/legacy-registry.ts';
import { parseAgentDatum } from '../../src/vector/registry-build.ts';

/** The legacy DID (did:vector:agent:<policy>:<asset name>) of the first parseable record at the legacy registry, or null. */
export async function liveLegacyAgentDid(): Promise<string | null> {
  const provider = new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
  for (const utxo of await provider.getUtxos(legacyRegistryAddress())) {
    const profile = utxo.datum ? parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets) : null;
    if (profile && /:[0-9a-f]{64}$/.test(profile.agentId)) return profile.agentId;
  }
  return null;
}
