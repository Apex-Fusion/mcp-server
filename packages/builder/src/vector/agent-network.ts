// Agent-registry family: 2 read-only tools + 5 keyless build_* tools.
// KEYLESS since spec PR 7: no tool here takes key material. Builds are
// unsigned; the 4-call flow is get_address -> build_* -> signer sign -> submit.
// Registry constants and build logic live in registry-build.ts.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import {
  VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL,
} from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import { lucidForAddress } from './build.js';
import {
  MIN_AP3X_DEPOSIT, getRegistryAddress, resolveAgentUtxo, parseAgentDatum,
  buildRegisterAgent, buildUpdateAgent, buildTransferAgent, buildDeregisterAgent, buildMessageAgent,
} from './registry-build.js';

function newProvider() {
  return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
}

const SIGN_AND_SUBMIT_COPY =
  'Sign it locally with vector_signer_sign { txCbor }, broadcast with vector_submit_transaction { signedTxCbor }, then confirm with vector_await_transaction { txHash }.';

export function registerAgentNetworkTools(server: McpServer, identity: string) {
  const rateLimiter = limiterFor(identity);

  // Rate limit wrapper - defined inside the register function (not at module
  // scope) so this closes over the per-identity `rateLimiter` above rather
  // than a module-wide global.
  function checkRateLimit() {
    const rateCheck = rateLimiter.check();
    if (!rateCheck.allowed) {
      return { content: [{ type: "text" as const, text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
    }
    return null;
  }

  // vector_get_agent_profile (read-only)  — UNCHANGED behavior; body moves to typed helpers
  server.tool(
    "vector_get_agent_profile",
    "Get a registered agent's profile from the on-chain registry by DID (did:vector:agent:...)",
    {
      agent_id: z.string().describe("Agent DID: did:vector:agent:{policyId}:{nftAssetName}"),
    },
    async ({ agent_id }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const { profile } = await resolveAgentUtxo(provider, agent_id);
        const capList = profile.capabilities.length > 0
          ? profile.capabilities.map((c) => `- ${c}`).join('\n')
          : '- (none listed)';
        return {
          content: [{
            type: "text" as const,
            text: `# Agent Profile

**DID:** ${profile.agentId}
**Name:** ${profile.name}
**Description:** ${profile.description}

**Capabilities:**
${capList}

**Framework:** ${profile.framework || '(not specified)'}
**Endpoint:** ${profile.endpoint || '(not specified)'}
**Registered:** ${new Date(profile.registeredAt).toISOString()}
**Registry UTxO:** ${profile.utxoRef}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to get agent profile: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Verify the DID format: did:vector:agent:{policyId}:{nftAssetName}
2. The agent may not be registered or may have deregistered
3. Check that Koios is reachable at ${VECTOR_KOIOS_URL}`,
          }],
        };
      }
    }
  );

  // vector_discover_agents (read-only) — UNCHANGED behavior
  server.tool(
    "vector_discover_agents",
    "Discover registered agents in the Vector on-chain registry, optionally filtered by capability or framework",
    {
      capability: z.string().optional().describe("Filter by capability tag (e.g. 'investing', 'research')"),
      framework: z.string().optional().describe("Filter by framework (e.g. 'OpenClaw', 'LangChain', 'CrewAI')"),
      limit: z.number().optional().default(20).describe("Maximum number of agents to return (default: 20)"),
    },
    async ({ capability, framework, limit }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const utxos = await provider.getUtxos(getRegistryAddress());
        const profiles = [];
        for (const utxo of utxos) {
          if (!utxo.datum) continue;
          const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
          if (!profile) continue;
          if (capability && !profile.capabilities.some((c) => c.toLowerCase().includes(capability.toLowerCase()))) continue;
          if (framework && profile.framework.toLowerCase() !== framework.toLowerCase()) continue;
          profiles.push(profile);
          if (profiles.length >= (limit ?? 20)) break;
        }
        if (profiles.length === 0) {
          const filterDesc = [capability ? `capability="${capability}"` : '', framework ? `framework="${framework}"` : ''].filter(Boolean).join(', ');
          return { content: [{ type: "text" as const, text: `No agents found${filterDesc ? ` matching ${filterDesc}` : ''} in the registry.\n\nTotal UTxOs at registry: ${utxos.length}` }] };
        }
        const agentList = profiles.map((p, i) =>
          `### ${i + 1}. ${p.name}\n**DID:** ${p.agentId}\n**Description:** ${p.description}\n**Capabilities:** ${p.capabilities.join(', ') || '(none)'}\n**Framework:** ${p.framework || '(not specified)'}\n**Endpoint:** ${p.endpoint || '(not specified)'}\n**Registered:** ${new Date(p.registeredAt).toISOString()}`
        ).join('\n\n');
        return {
          content: [{
            type: "text" as const,
            text: `# Agent Discovery Results\n\nFound **${profiles.length}** agent${profiles.length !== 1 ? 's' : ''}${capability ? ` with capability "${capability}"` : ''}${framework ? ` using framework "${framework}"` : ''}:\n\n${agentList}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to discover agents: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Check that Ogmios is reachable at ${VECTOR_OGMIOS_URL}
2. The registry may be empty - no agents have registered yet
3. Try without filters to list all agents`,
          }],
        };
      }
    }
  );

  // vector_build_register_agent — KEYLESS
  server.tool(
    "vector_build_register_agent",
    "Build an UNSIGNED transaction that registers an agent in the Vector on-chain registry (mints a soulbound identity NFT, locks a 10 AP3X deposit). Takes no key material. Sign locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction.",
    {
      changeAddress: z.string().describe("Your wallet address (source of the deposit and change). Get it from vector_signer_get_address."),
      name: z.string().min(1).max(64).describe("Agent name (e.g. 'TradingBot', 'ResearchAgent')"),
      description: z.string().max(256).describe("Short description of the agent's purpose"),
      capabilities: z.array(z.string()).describe("List of capability tags (e.g. ['investing', 'research', 'environmental'])"),
      framework: z.string().describe("Framework used (e.g. 'OpenClaw', 'LangChain', 'CrewAI', 'custom')"),
      endpoint: z.string().describe("A2A communication endpoint URL (or empty string if not applicable)"),
    },
    async ({ changeAddress, name, description, capabilities, framework, endpoint }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const lucid = await lucidForAddress(newProvider(), changeAddress);
        const r = await buildRegisterAgent(lucid, { changeAddress, name, description, capabilities, framework, endpoint });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Registration Built (Not Submitted)

**Agent DID:** ${r.agentId}
**Name:** ${name}
**NFT Asset Name:** ${r.nftAssetName}
**Registry Address:** ${r.registryAddress}
**Deposit:** ${lovelaceToAda(r.depositLovelace)} AP3X (returned on deregistration)
**Estimated Fee:** ${r.feeAda} AP3X

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

The DID above is bound to the exact wallet UTxO this build consumed - if that UTxO is spent by another transaction first, rebuild to get a new DID. Your signer must allow ~${lovelaceToAda((MIN_AP3X_DEPOSIT + 500_000n).toString())} AP3X net outflow (deposit + fee). ${SIGN_AND_SUBMIT_COPY}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build agent registration: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Ensure the changeAddress wallet holds at least 12 AP3X (10 deposit + fees)
2. Each wallet can register multiple agents (different one-shot UTxOs)
3. Verify Ogmios endpoint is reachable at ${VECTOR_OGMIOS_URL}`,
          }],
        };
      }
    }
  );

  // vector_build_update_agent — KEYLESS
  server.tool(
    "vector_build_update_agent",
    "Build an UNSIGNED transaction that updates a registered agent's profile fields. Only the specified fields change; others are preserved. Takes no key material - the on-chain validator requires the owner's signature, which you add locally with vector_signer_sign before vector_submit_transaction, then confirm with vector_await_transaction.",
    {
      changeAddress: z.string().describe("The agent OWNER's wallet address. Get it from vector_signer_get_address."),
      agent_id: z.string().describe("Agent DID to update: did:vector:agent:{policyId}:{nftAssetName}"),
      name: z.string().min(1).max(64).optional().describe("New agent name"),
      description: z.string().max(256).optional().describe("New description"),
      capabilities: z.array(z.string()).optional().describe("New capability tags (replaces existing list)"),
      framework: z.string().optional().describe("New framework identifier"),
      endpoint: z.string().optional().describe("New A2A endpoint URL (or empty string to clear)"),
    },
    async ({ changeAddress, agent_id, name, description, capabilities, framework, endpoint }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildUpdateAgent(lucid, provider, { changeAddress, agentId: agent_id, name, description, capabilities, framework, endpoint });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Update Built (Not Submitted)

**Agent DID:** ${agent_id}
**Fields to update:** ${r.detail}
**Estimated Fee:** ${r.feeAda} AP3X

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

The identity NFT and deposit are unchanged by this update. ${SIGN_AND_SUBMIT_COPY}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build agent update: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Verify the agent DID is correct
2. The changeAddress must be the agent's current owner wallet
3. Use vector_get_agent_profile to check the agent's current state`,
          }],
        };
      }
    }
  );

  // vector_build_transfer_agent — KEYLESS
  server.tool(
    "vector_build_transfer_agent",
    "Build an UNSIGNED transaction that transfers agent ownership to a new address (must be a verification-key address, not a script). Takes no key material. Sign locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction.",
    {
      changeAddress: z.string().describe("The CURRENT owner's wallet address. Get it from vector_signer_get_address."),
      agent_id: z.string().describe("Agent DID to transfer: did:vector:agent:{policyId}:{nftAssetName}"),
      new_owner_address: z.string().describe("Bech32 address of the new owner (must be a verification key address, not a script address)"),
    },
    async ({ changeAddress, agent_id, new_owner_address }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildTransferAgent(lucid, provider, { changeAddress, agentId: agent_id, newOwnerAddress: new_owner_address });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Transfer Built (Not Submitted)

**Agent DID:** ${agent_id}
**Name:** ${r.agentName}
**Current owner (changeAddress):** ${changeAddress}
**New owner:** ${new_owner_address}
**Estimated Fee:** ${r.feeAda} AP3X

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

After this transaction confirms, only the new owner can update, transfer, or deregister the agent. ${SIGN_AND_SUBMIT_COPY}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build agent transfer: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Verify the agent DID is correct
2. The changeAddress must be the agent's current owner wallet
3. The new owner address must be a verification key address (not a script)`,
          }],
        };
      }
    }
  );

  // vector_build_deregister_agent — KEYLESS
  server.tool(
    "vector_build_deregister_agent",
    "Build an UNSIGNED transaction that deregisters an agent (burns the identity NFT, returns the 10 AP3X deposit to the owner wallet). Takes no key material. Sign locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction.",
    {
      changeAddress: z.string().describe("The agent OWNER's wallet address (receives the returned deposit). Get it from vector_signer_get_address."),
      agent_id: z.string().describe("Agent DID to deregister: did:vector:agent:{policyId}:{nftAssetName}"),
    },
    async ({ changeAddress, agent_id }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildDeregisterAgent(lucid, provider, { changeAddress, agentId: agent_id });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Deregistration Built (Not Submitted)

**Agent DID:** ${agent_id}
**Name:** ${r.agentName}
**Deposit returned on confirmation:** ${lovelaceToAda(r.detail)} AP3X
**Estimated Fee:** ${r.feeAda} AP3X

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

The identity NFT is burned by this transaction; the deposit returns to the changeAddress as change. ${SIGN_AND_SUBMIT_COPY}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build agent deregistration: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Verify the agent DID is correct
2. The changeAddress must be the agent's current owner wallet
3. Use vector_get_agent_profile to check the agent's current state
4. If the error mentions needing a plain AP3X-only UTxO: the wallet must hold at least one token-free UTxO; send yourself a small AP3X payment first.`,
          }],
        };
      }
    }
  );

  // vector_build_message_agent — KEYLESS
  server.tool(
    "vector_build_message_agent",
    "Build an UNSIGNED transaction that sends an on-chain message to a registered agent via TX metadata (label 674), delivering 2 AP3X to the agent's owner address. Takes no key material. Sign locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction.",
    {
      changeAddress: z.string().describe("Your wallet address (pays the 2 AP3X delivery and fee; recorded as the sender). Get it from vector_signer_get_address."),
      agent_id: z.string().describe("Recipient agent DID: did:vector:agent:{policyId}:{nftAssetName}"),
      message_type: z.enum(["inquiry", "proposal", "result"]).describe("Type of message"),
      payload: z.string().max(512).describe("Message payload (string, max 512 chars)"),
    },
    async ({ changeAddress, agent_id, message_type, payload }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildMessageAgent(lucid, provider, { changeAddress, agentId: agent_id, messageType: message_type, payload });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Message Built (Not Submitted)

**To:** ${r.agentName} (${agent_id})
**Type:** ${message_type}
**Payload:** ${payload}
**Recipient Address:** ${r.recipientAddress}
**Delivery:** 2 AP3X + ${r.feeAda} AP3X fee

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

The message will be recorded on-chain in TX metadata label 674 once submitted. ${SIGN_AND_SUBMIT_COPY}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build agent message: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Verify the agent DID is correct: did:vector:agent:{policyId}:{nftAssetName}
2. Ensure the changeAddress wallet holds at least 3 AP3X (2 AP3X delivery + fees)
3. Use vector_get_agent_profile to verify the agent exists first`,
          }],
        };
      }
    }
  );
}
