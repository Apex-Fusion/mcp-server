// Agent identity family: 3 read-only tools (resolve a DID, an agent's profile, discovery through the marketplace indexer)
// + the keyless deregistration of a legacy record (Part 2 Section 10: the legacy registry writes are retired, and a legacy record
// that does not adopt can still deregister). The identity registry build tools live in identity-tools.ts.
// KEYLESS since spec PR 7: no tool here takes key material. Builds are
// unsigned; the 4-call flow is get_address -> build_* -> signer sign -> submit.
// The legacy registry's script, policy, address and deposit live in legacy-registry.ts, its build logic in registry-build.ts,
// and the identity gateway client in identity-gateway.ts.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import {
  VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL,
} from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import type { RateLimiter } from './rate-limiter.js';
import { lucidForAddress } from './build.js';
import { resolveAgentUtxo, buildDeregisterAgent } from './registry-build.js';
import {
  resolveDid, resolutionError, isJsonObject, CANONICAL_DID, LEGACY_DID_PREFIX,
} from './identity-gateway.js';
import type { GatewayAnswer, ResolutionResult } from './identity-gateway.js';
import { fetchSuppliers, withJson } from './marketplace-indexer.js';
import { text, fail, cell, host } from './marketplace-shared.js';

function newProvider(): Provider {
  return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
}

const SIGN_AND_SUBMIT_COPY =
  'Sign it locally with vector_signer_sign { txCbor }, broadcast with vector_submit_transaction { signedTxCbor }, then confirm with vector_await_transaction { txHash }.';

const DID_FORMS = 'did:vector:<64 hex> (canonical) or did:vector:agent:<policyId>:<nftAssetName> (legacy)';
const VECTOR_ID = /^[0-9a-f]{64}$/;

/** A fenced block that the text inside cannot close: its fence is longer than any run of backticks in the text. */
function fenced(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${body}\n${fence}`;
}

/** `effective (reason)` from the vectorStatus metadata, or null without one. */
function effectiveStatusOf(meta: Record<string, unknown>): string | null {
  const status = meta.vectorStatus;
  if (!isJsonObject(status) || typeof status.effective !== 'string') return null;
  return typeof status.effectiveReason === 'string' ? `${status.effective} (${status.effectiveReason})` : status.effective;
}

/** What the HTTP status line of vector_resolve_did says about a result. */
function summaryOf(answer: GatewayAnswer): string {
  const error = resolutionError(answer.result);
  if (error) return error;
  const effective = effectiveStatusOf(answer.result.didDocumentMetadata);
  const deactivated = answer.result.didDocumentMetadata.deactivated === true ? 'deactivated; ' : '';
  return `${deactivated}effective status ${effective ?? 'not given'}`;
}

interface ProfileKey {
  /** `#<key hash>` */
  id: string;
  /** `Ed25519` or `P-256` for a listed key; null for a controller key that is not listed. */
  type: string | null;
  purposes: string[];
  controller: boolean;
  /** Absent when the result has no document (a deactivated DID). */
  publicKeyMultibase: string | null;
}

/**
 * The keys of a resolution result (Part 1 Section 8): each verification method of the document, marked as the controller
 * key when capabilityInvocation names it, with its type and purposes from the vectorKeys metadata. Without a document (a DID
 * deactivated at the requested time) the listed keys still show, without their public keys.
 */
function keysOf(result: ResolutionResult): ProfileKey[] {
  const fragment = (id: unknown): string | null => (typeof id === 'string' && id.includes('#') ? id.slice(id.indexOf('#')) : null);
  const listed = Array.isArray(result.didDocumentMetadata.vectorKeys) ? result.didDocumentMetadata.vectorKeys.filter(isJsonObject) : [];
  const doc = result.didDocument;
  const controllerRef = doc && Array.isArray(doc.capabilityInvocation) ? fragment(doc.capabilityInvocation[0]) : null;
  const methods = doc && Array.isArray(doc.verificationMethod) ? doc.verificationMethod.filter(isJsonObject) : [];
  const keyOf = (id: string, publicKeyMultibase: unknown): ProfileKey => {
    const entry = listed.find((k) => k.id === id);
    return {
      id,
      type: typeof entry?.type === 'string' ? entry.type : null,
      purposes: Array.isArray(entry?.purposes) ? entry.purposes.filter((p): p is string => typeof p === 'string') : [],
      controller: id === controllerRef,
      publicKeyMultibase: typeof publicKeyMultibase === 'string' ? publicKeyMultibase : null,
    };
  };
  const keys = methods.flatMap((vm) => {
    const id = fragment(vm.id);
    return id ? [keyOf(id, vm.publicKeyMultibase)] : [];
  });
  for (const entry of listed) {
    if (typeof entry.id === 'string' && !keys.some((k) => k.id === entry.id)) keys.push(keyOf(entry.id, null));
  }
  return keys;
}

/** The profile of a canonical DID, from its resolution result, as markdown plus a JSON block. */
function canonicalProfile(did: string, answer: GatewayAnswer): string {
  const meta = answer.result.didDocumentMetadata;
  const profile = isJsonObject(meta.vectorProfile) ? meta.vectorProfile : {};
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities.filter((c): c is string => typeof c === 'string') : [];
  const keys = keysOf(answer.result);
  const ledger = isJsonObject(meta.vectorLedger) ? meta.vectorLedger : null;
  const deactivated = meta.deactivated === true;

  const keyLines = keys.map((k) => {
    const what = [k.type ?? 'key', k.controller ? 'controller key' : null].filter(Boolean).join(', ');
    const purposes = k.purposes.length ? `: ${k.purposes.join(', ')}` : '';
    return `- \`${cell(k.id, 80)}\` ${what}${purposes}${k.publicKeyMultibase ? ` (${cell(k.publicKeyMultibase, 80)})` : ''}`;
  });
  const recordOutput = ledger
    ? `${cell(ledger.txId)}${typeof ledger.outputIndex === 'number' ? `#${ledger.outputIndex}` : ''} (${cell(ledger.confirmations)} confirmations)`
    : '(not given)';
  // Part 1 Section 8.2: `created` is the block time of the transaction that first minted the identifier. The profile's createdAt is the
  // record's created_at, which is the end of the validity window of the creating transaction (up to an hour after its block), or the
  // block time of the mint for a legacy version.
  const created = cell(str(meta.created));
  const recordCreatedAt = cell(str(profile.createdAt));
  const md = `# Agent Profile

**DID:** ${did}
**Origin:** ${cell(str(meta.vectorOrigin)) || '(not given)'}
**Effective status:** ${cell(effectiveStatusOf(meta) ?? '(not given)')}${deactivated ? ' - the DID is deactivated' : ''}
**Name:** ${cell(str(profile.name), 120) || '(not given)'}
**Description:** ${cell(str(profile.description), 400) || '(not given)'}

**Capabilities:**
${capabilities.length ? capabilities.map((c) => `- ${cell(c)}`).join('\n') : '- (none listed)'}

**Framework:** ${cell(str(profile.framework)) || '(not specified)'}
**Endpoint:** ${cell(str(profile.endpoint), 200) || '(not specified)'}
**Registered:** ${created ? `${created} (block time of the transaction that first minted the identifier)` : '(not given)'}
**Record created_at:** ${recordCreatedAt ? `${recordCreatedAt} (the time that the record stores: the end of the validity window of the transaction that created it, or the block time of the mint for a legacy record)` : '(not given)'}

**Keys:**
${keyLines.length ? keyLines.join('\n') : '- (none)'}

**Record output:** ${recordOutput}

The full resolution result: vector_resolve_did { did }.`;
  return withJson(md, {
    did,
    canonical_id: meta.canonicalId ?? null,
    created: meta.created ?? null,
    origin: meta.vectorOrigin ?? null,
    version_id: meta.versionId ?? null,
    deactivated,
    status: meta.vectorStatus ?? null,
    profile: meta.vectorProfile ?? null,
    keys,
    record_output: ledger,
  });
}

interface DiscoveredAgent {
  did: string | null;
  agent_id: string | null;
  supplier_pkhs: string[];
  capabilities: string[];
  adverts: Array<{ advert_ref: string; capability_id: string; model: string; status: string; endpoint_url: string }>;
}

/**
 * Registers the agent identity read tools and the legacy deregistration. The server passes only `server` and `identity`;
 * `provider` (the node the legacy reads and the build tool use) and `limiter` are for tests.
 */
export function registerAgentNetworkTools(
  server: McpServer, identity: string,
  provider: () => Provider = newProvider, limiter: Pick<RateLimiter, 'check'> = limiterFor(identity),
) {
  // Rate limit wrapper - defined inside the register function (not at module
  // scope) so this closes over the per-identity `limiter` above rather
  // than a module-wide global.
  function checkRateLimit() {
    const rateCheck = limiter.check();
    if (!rateCheck.allowed) {
      return { content: [{ type: "text" as const, text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
    }
    return null;
  }

  // vector_resolve_did (read-only): the identity gateway's DID resolution result, unchanged.
  server.tool(
    "vector_resolve_did",
    "Resolve a did:vector DID through the identity gateway (DID Resolution v1.0: GET /1.0/identifiers/{did}). Accepts the canonical form did:vector:<64 hex> and the legacy form did:vector:agent:<policyId>:<64 hex>. Returns the HTTP status and the DID resolution result unchanged: the DID document and its metadata (effective status, keys, parties, profile, record output). Optional versionId or versionTime resolve an earlier version. Read-only, no wallet needed.",
    {
      did: z.string().min(1).max(256).describe(`The DID to resolve: ${DID_FORMS}`),
      versionId: z.string().max(32).optional().describe("Resolve this version: '0', or a decimal number without leading zeros. Do not combine with versionTime."),
      versionTime: z.string().max(32).optional().describe("Resolve the DID as it was at this time: YYYY-MM-DDThh:mm:ssZ (UTC, whole seconds). Do not combine with versionId."),
    },
    async ({ did, versionId, versionTime }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const answer = await resolveDid(did, { versionId, versionTime });
        return text(
          `# DID resolution\n\n**DID:** ${cell(did, 200)}\n**HTTP status:** ${answer.status} (${cell(summaryOf(answer), 200)})\n\n` +
            `The resolution result from the identity gateway, unchanged:\n\n${fenced(answer.body)}`
        );
      } catch (err) {
        return fail('resolve DID', err, [
          'The identity gateway may be unreachable; retry in a minute',
          `Check the DID: ${DID_FORMS}`,
        ]);
      }
    }
  );

  // vector_get_agent_profile (read-only): a canonical DID through the gateway, a legacy DID from the legacy registry.
  server.tool(
    "vector_get_agent_profile",
    "Get an agent's profile by DID. A canonical DID (did:vector:<64 hex>) is resolved through the identity gateway: profile, effective status, keys and record output. A legacy DID (did:vector:agent:<policyId>:<nftAssetName>) is read from the legacy registry on-chain. Read-only, no wallet needed.",
    {
      agent_id: z.string().describe(`Agent DID: ${DID_FORMS}`),
    },
    async ({ agent_id }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      if (CANONICAL_DID.test(agent_id)) {
        try {
          const answer = await resolveDid(agent_id);
          const error = resolutionError(answer.result);
          if (answer.status === 404) return text(`Agent not found: ${cell(error ?? 'NOT_FOUND', 200)}. The DID names no record in the identity registry or the legacy registry.`);
          if (error) throw new Error(`the identity gateway answered HTTP ${answer.status} (${error})`);
          return text(canonicalProfile(agent_id, answer));
        } catch (err) {
          return fail('get agent profile', err, [
            'The identity gateway may be unreachable; retry in a minute',
            'vector_resolve_did { did } shows the full resolution result',
          ]);
        }
      }
      if (!agent_id.startsWith(LEGACY_DID_PREFIX)) {
        return text(`Failed to get agent profile: ${cell(agent_id, 120)} is not a did:vector DID. Expected ${DID_FORMS}.`);
      }
      try {
        const { profile } = await resolveAgentUtxo(provider(), agent_id);
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
1. Verify the DID format: ${DID_FORMS}
2. The agent may not be registered or may have deregistered
3. Verify the configured Koios endpoint is reachable`,
          }],
        };
      }
    }
  );

  // vector_discover_agents (read-only): the agents of the listed adverts, from the marketplace indexer.
  server.tool(
    "vector_discover_agents",
    "Discover agents that have a listed advert on the Vector agents marketplace, read from the marketplace indexer (which applies the listing rule), optionally filtered by capability. Each result names the agent's DID (did:vector:<64 hex>) when its adverts name one; a legacy advert names none. Read-only, no wallet needed. For an agent's profile, call vector_get_agent_profile with its DID.",
    {
      capability: z.string().optional().describe("Filter by capability id, case-insensitive substring (e.g. 'llm.chat', 'identity.history')"),
      limit: z.number().int().min(1).max(100).optional().default(20).describe("Maximum number of agents to return (default: 20)"),
    },
    async ({ capability, limit }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const wanted = capability?.toLowerCase();
        const max = limit ?? 20; // the schema's default, for a caller that bypasses the schema
        const agents = new Map<string, DiscoveredAgent>();
        for (const row of await fetchSuppliers()) {
          if (wanted && !String(row.capability_id).toLowerCase().includes(wanted)) continue;
          const agentId = typeof row.agent_id === 'string' && VECTOR_ID.test(row.agent_id) ? row.agent_id : null;
          const key = agentId ?? `key:${row.supplier_pkh}`;
          let agent = agents.get(key);
          if (!agent) {
            if (agents.size >= max) continue;
            agent = { did: agentId ? `did:vector:${agentId}` : null, agent_id: agentId, supplier_pkhs: [], capabilities: [], adverts: [] };
            agents.set(key, agent);
          }
          if (!agent.supplier_pkhs.includes(row.supplier_pkh)) agent.supplier_pkhs.push(row.supplier_pkh);
          if (!agent.capabilities.includes(row.capability_id)) agent.capabilities.push(row.capability_id);
          agent.adverts.push({ advert_ref: row.utxo_ref, capability_id: row.capability_id, model: row.model, status: row.status, endpoint_url: row.endpoint_url });
        }
        const found = [...agents.values()];
        const filterDesc = capability ? ` with a capability matching "${cell(capability)}"` : '';
        if (found.length === 0) return text(withJson(`No listed agents found${filterDesc}.`, []));
        const list = found.map((a, i) => {
          const heading = a.did ?? `No DID (legacy advert of key ${cell(a.supplier_pkhs[0])})`;
          const adverts = a.adverts.map((ad) => `\`${cell(ad.advert_ref)}\` (${cell(ad.capability_id)}, ${cell(ad.model)}, ${cell(ad.status)})`).join('; ');
          const endpoints = [...new Set(a.adverts.map((ad) => cell(host(ad.endpoint_url))))].join(', ');
          return `### ${i + 1}. ${heading}\n**Capabilities:** ${a.capabilities.map((c) => cell(c)).join(', ')}\n**Supplier key hash:** ${a.supplier_pkhs.map((p) => cell(p)).join(', ')}\n**Adverts:** ${adverts}\n**Endpoint:** ${endpoints || '(not specified)'}`;
        }).join('\n\n');
        const md = `# Agent Discovery Results\n\nFound **${found.length}** agent${found.length !== 1 ? 's' : ''}${filterDesc} among the listed adverts of the marketplace indexer:\n\n${list}\n\nNext: vector_get_agent_profile { agent_id } with a DID for the agent's record; vector_marketplace_get_supplier { advert_ref } for one advert.`;
        return text(withJson(md, found));
      } catch (err) {
        return fail('discover agents', err, ['The marketplace indexer may be unreachable; retry in a minute', 'Try without capability to see every listed agent']);
      }
    }
  );

  // vector_build_deregister_agent - KEYLESS. Stays for legacy records that do not adopt (Part 2 Section 10).
  server.tool(
    "vector_build_deregister_agent",
    "Build an UNSIGNED transaction that deregisters a LEGACY registry record (did:vector:agent:...) that will not adopt into the identity registry: burns its token and returns the deposit to the owner wallet; its DID then resolves as deactivated. To move a legacy record into the identity registry instead, use vector_build_identity_adopt. Takes no key material. Sign locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction.",
    {
      changeAddress: z.string().describe("The legacy record OWNER's wallet address (receives the returned deposit). Get it from vector_signer_get_address."),
      agent_id: z.string().describe("Legacy agent DID to deregister: did:vector:agent:{policyId}:{nftAssetName}"),
    },
    async ({ changeAddress, agent_id }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const node = provider();
        const lucid = await lucidForAddress(node, changeAddress);
        const r = await buildDeregisterAgent(lucid, node, { agentId: agent_id });
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
4. If the error mentions needing a plain AP3X-only UTxO: the wallet must hold at least one token-free UTxO; send yourself a small AP3X transfer first.`,
          }],
        };
      }
    }
  );
}
