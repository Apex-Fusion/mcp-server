// packages/builder/src/vector/jury-family.ts
// The Module-1 dispute family, as registerVectorTools sees it: one entry that registers the document, Module-1 claim and challenge,
// juror and jury read tools (jury-tools.ts), with the caller's rate limiter, the node they build against, the deployments of the
// server's manifests and Koios. The tools read the deployments when they are called, so the server starts without them and the tools
// then say how to configure them.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import type { RateLimiter } from './rate-limiter.js';
import { rateGate } from './marketplace-shared.js';
import { INDEXER_URL } from './marketplace-constants.js';
import { serverIdentityDeployment } from './identity-deployment.js';
import { serverJuryConfig } from './jury-deployment.js';
import { registerJuryTools } from './jury-tools.js';
import type { JuryConfigFor, JuryReadAccess } from './jury-tools.js';

function newProvider(): Provider { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }

/** The deployments of the server's manifests, checked against the server's identity deployment when it has one. */
const serverConfig: JuryConfigFor = (provider) => serverJuryConfig(provider, serverIdentityDeployment()?.identity.hash ?? null);

/** Registers every Module-1 dispute tool. `provider`, `limiter`, `configFor` and `access` are for tests. */
export function registerJuryFamily(
  server: McpServer, identity: string,
  provider: () => Provider = newProvider, limiter: Pick<RateLimiter, 'check'> = limiterFor(identity),
  configFor: JuryConfigFor = serverConfig, access: JuryReadAccess = { koiosUrl: VECTOR_KOIOS_URL, indexerUrl: INDEXER_URL, fetchImpl: fetch },
) {
  registerJuryTools(server, rateGate(limiter), provider, configFor, access);
}
