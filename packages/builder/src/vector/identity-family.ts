// packages/builder/src/vector/identity-family.ts
// The identity family, as registerVectorTools sees it: one entry that registers the identity registry, attestation, delegation and
// vault tools (Part 2 Section 10), with the caller's rate limiter and the node they build against. The tools read the deployment from
// the server's environment when they are called, so the server starts without one and the tools then say how to configure it.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import type { RateLimiter } from './rate-limiter.js';
import { rateGate } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { registerIdentityRegistryTools } from './identity-tools.js';
import { registerAttestationTools } from './attestation-tools.js';
import { registerDelegationTools } from './delegation-tools.js';
import { registerVaultTools } from './vault-tools.js';

function newProvider(): Provider { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }

/** Registers every identity family tool. `provider`, `limiter` and `deployment` are for tests. */
export function registerIdentityFamily(
  server: McpServer, identity: string,
  provider: () => Provider = newProvider, limiter: Pick<RateLimiter, 'check'> = limiterFor(identity),
  deployment: () => IdentityDeployment = requireIdentityDeployment,
) {
  const gate = rateGate(limiter);
  registerIdentityRegistryTools(server, gate, provider, deployment);
  registerAttestationTools(server, gate, provider, deployment);
  registerDelegationTools(server, gate, provider, deployment);
  registerVaultTools(server, gate, provider, deployment);
}
