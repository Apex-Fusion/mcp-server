// packages/builder/src/vector/marketplace.ts
// The marketplace family, as registerVectorTools sees it: one entry that registers every marketplace tool. Four files, one per
// family: the read tools (marketplace-read-tools.ts: indexer and Koios, plus the advert's manifest), the keyless build tools
// (marketplace-build-tools.ts: escrow post, accept, reclaim, release and refund of a revoked agent, and the identity-marketplace
// advert), the transport tools (marketplace-transport-tools.ts: send a job, poll it, check its receipt; the only ones that call a
// supplier) and the supplier's legacy advert tools (marketplace-advert-tools.ts: advert post and retire). Same conventions as
// agent-network.ts.
// What the families share lives in marketplace-shared.ts. What is decided here is what they share at registration: the caller's
// rate limiter (one budget of calls per minute for all marketplace tools of an identity), the node the build and transport tools
// talk to, and the identity deployment (Part 2 Section 9.6: the tools read and spend both escrow layouts; without a deployment they
// serve the legacy layout and refuse an identity-marketplace one with the words that say how to configure the server).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import type { RateLimiter } from './rate-limiter.js';
import { rateGate } from './marketplace-shared.js';
import { registerMarketplaceReadTools } from './marketplace-read-tools.js';
import { registerMarketplaceBuildTools } from './marketplace-build-tools.js';
import type { MaybeDeploymentFor } from './marketplace-build-tools.js';
import { registerMarketplaceTransportTools } from './marketplace-transport-tools.js';
import { registerMarketplaceAdvertTools } from './marketplace-advert-tools.js';
import { serverIdentityDeployment } from './identity-deployment.js';

function newProvider() { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }

/**
 * Registers every marketplace tool. The server passes only `server` and `identity`; `provider` (the node the build and transport
 * tools read), `limiter` and `deploymentFor` (the identity deployment: the server's environment, null before it has one) are for
 * tests, which hand in a fixture node, a limiter and a deployment of their own instead of registering under a second identity.
 */
export function registerMarketplaceTools(
  server: McpServer, identity: string,
  provider: () => Provider = newProvider, limiter: Pick<RateLimiter, 'check'> = limiterFor(identity),
  deploymentFor: MaybeDeploymentFor = () => serverIdentityDeployment(),
) {
  const gate = rateGate(limiter);
  registerMarketplaceReadTools(server, gate, deploymentFor);
  registerMarketplaceBuildTools(server, gate, provider, deploymentFor);
  registerMarketplaceTransportTools(server, gate, provider, deploymentFor);
  registerMarketplaceAdvertTools(server, gate, provider);
}
