// Self-improvement family: 2 read-only tools (browse, analyze_metrics) + 4
// keyless build_* tools (proposal lock, proposal spend, critique, endorse).
// KEYLESS since spec PR 8: no tool here takes key material. Proposal
// submission is two build_* calls because the deployed module validator
// needs a confirmed lock before the spend+mint step can reference it - the
// agent orchestrates both transactions through the 4-call flow. Constants,
// parsers, and build logic live in gov-build.ts.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UTxO } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import { lucidForAddress } from './build.js';
import {
  GOV_TREASURY_ADDRESS, GOV_PROPOSAL_SPEND_HASH, GOV_CRITIQUE_SPEND_HASH, GOV_ENDORSEMENT_SPEND_HASH,
  scriptHashToAddress, lovelaceToApex,
  parseProposalDatum, parseCritiqueDatum, parseEndorsementDatum,
  MIN_PROPOSAL_STAKE_APEX, MIN_CRITIQUE_STAKE_APEX, MIN_ENDORSE_STAKE_APEX,
  buildProposalLock, buildProposalSpend, buildCritique, buildEndorse,
} from './gov-build.js';
import type { GovProposal } from './gov-build.js';

function newProvider() {
  return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
}

const SIGN_AND_SUBMIT_COPY =
  'Sign it locally with vector_signer_sign { txCbor }, broadcast with vector_submit_transaction { signedTxCbor }, then confirm with vector_await_transaction { txHash }.';

export function registerSelfImprovementTools(server: McpServer, identity: string) {
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

  // ─── vector_self_improvement_browse (read-only) ───────────────────────────

  server.tool(
    "vector_self_improvement_browse",
    "Browse improvement proposals, critiques, and endorsements. Query on-chain UTxOs at the module's script addresses and decode datums into human-readable format.",
    {
      entity: z.enum(["proposals", "critiques", "endorsements", "treasury"]).describe("What to browse"),
      state: z.string().optional().describe("Filter proposals by state: Open, Amended, Adopted, Rejected, Expired, Withdrawn"),
      proposalType: z.string().optional().describe("Filter proposals by type: ParameterChange, TreasurySpend, ProtocolUpgrade, GameActivation, GeneralSuggestion"),
      proposerDid: z.string().optional().describe("Filter by proposer DID (hex)"),
      proposalTxHash: z.string().optional().describe("Filter critiques/endorsements by the proposal they reference"),
    },
    async ({ entity, state, proposalType, proposerDid, proposalTxHash }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;

      try {
        const provider = newProvider();

        if (entity === "treasury") {
          const utxos = await provider.getUtxos(GOV_TREASURY_ADDRESS);
          let total = 0n;
          for (const u of utxos) {
            total += BigInt(u.assets?.lovelace || 0);
          }
          return {
            content: [{
              type: "text" as const,
              text: `# Treasury Balance

**Total:** ${lovelaceToApex(total)} AP3X
**UTxO Count:** ${utxos.length}
**Address:** ${GOV_TREASURY_ADDRESS}

Each batch UTxO holds ~30 AP3X for adoption rewards.`,
            }],
          };
        }

        // Determine script address
        let scriptHash: string;
        let parseFunc: (datum: string) => any;

        if (entity === "proposals") {
          scriptHash = GOV_PROPOSAL_SPEND_HASH;
          parseFunc = parseProposalDatum;
        } else if (entity === "critiques") {
          scriptHash = GOV_CRITIQUE_SPEND_HASH;
          parseFunc = parseCritiqueDatum;
        } else {
          scriptHash = GOV_ENDORSEMENT_SPEND_HASH;
          parseFunc = parseEndorsementDatum;
        }

        const scriptAddress = scriptHashToAddress(scriptHash);

        let utxos: UTxO[];
        try {
          utxos = await provider.getUtxos(scriptAddress);
        } catch {
          // Fallback: address query may fail if no UTxOs exist yet
          utxos = [];
        }

        if (!utxos || utxos.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No ${entity} found on-chain.`,
            }],
          };
        }

        // Parse and filter
        const items: any[] = [];
        for (const u of utxos) {
          if (!u.datum) continue;
          const parsed = parseFunc(u.datum);
          if (!parsed) continue;

          // Apply filters
          if (entity === "proposals") {
            if (state && parsed.state !== state) continue;
            if (proposalType && parsed.proposalType !== proposalType) continue;
            if (proposerDid && parsed.proposerDid !== proposerDid) continue;
          }
          if ((entity === "critiques" || entity === "endorsements") && proposalTxHash) {
            // Filter by proposal reference
            const ref = parsed.proposalRef;
            if (ref && ref.fields?.[0] !== proposalTxHash) continue;
          }

          items.push({
            ...parsed,
            utxoRef: `${u.txHash}#${u.outputIndex}`,
            lovelace: Number(u.assets?.lovelace || 0),
          });
        }

        // Format output
        if (entity === "proposals") {
          const lines = items.map((p, i) => {
            return `## ${i + 1}. ${p.proposalType} Proposal (${p.state})
- **Proposer:** ${p.proposerDid}
- **Priority:** ${p.priority}
- **Stake:** ${lovelaceToApex(p.stakeAmount)} AP3X
- **Submitted:** slot ${p.submittedAt}
- **Review Window:** ${p.reviewWindow} slots
- **Amendments:** ${p.amendmentCount}
- **Storage:** ${p.storageUri}
- **UTxO:** ${p.utxoRef}`;
          });
          return {
            content: [{
              type: "text" as const,
              text: `# Improvement Proposals (${items.length} found)\n\n${lines.join('\n\n') || 'No proposals match the filters.'}`,
            }],
          };
        } else if (entity === "critiques") {
          const lines = items.map((c, i) => {
            return `## ${i + 1}. ${c.critiqueType} Critique
- **Critic:** ${c.criticDid}
- **Stake:** ${lovelaceToApex(c.stakeAmount)} AP3X
- **Incorporated:** ${c.incorporated ? 'Yes' : 'No'}
- **Storage:** ${c.storageUri}
- **UTxO:** ${c.utxoRef}`;
          });
          return {
            content: [{
              type: "text" as const,
              text: `# Critiques (${items.length} found)\n\n${lines.join('\n\n') || 'No critiques match the filters.'}`,
            }],
          };
        } else {
          const lines = items.map((e, i) => {
            return `## ${i + 1}. Endorsement
- **Endorser:** ${e.endorserDid}
- **Stake:** ${lovelaceToApex(e.stakeAmount)} AP3X
- **UTxO:** ${e.utxoRef}`;
          });
          return {
            content: [{
              type: "text" as const,
              text: `# Endorsements (${items.length} found)\n\n${lines.join('\n\n') || 'No endorsements match the filters.'}`,
            }],
          };
        }
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to browse proposal data: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Verify the module contracts are deployed on this network
2. Check that Ogmios is reachable at ${VECTOR_OGMIOS_URL}
3. The script addresses may not have any UTxOs yet`,
          }],
        };
      }
    }
  );

  // ─── vector_self_improvement_analyze_metrics (read-only) ──────────────────

  server.tool(
    "vector_self_improvement_analyze_metrics",
    "Analyze proposal metrics: proposal activity, adoption rate, treasury health, and engagement statistics. Read-only, takes no key material.",
    {
      focus: z.enum(["overview", "adoption", "treasury", "activity"]).default("overview").describe("Analysis focus area"),
    },
    async ({ focus }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;

      try {
        const provider = newProvider();

        // Query treasury
        const treasuryUtxos = await provider.getUtxos(GOV_TREASURY_ADDRESS);
        let treasuryTotal = 0n;
        for (const u of treasuryUtxos) {
          treasuryTotal += BigInt(u.assets?.lovelace || 0);
        }

        // Query proposals at spend address
        let proposalUtxos: UTxO[] = [];
        try {
          const proposalSpendAddress = scriptHashToAddress(GOV_PROPOSAL_SPEND_HASH);
          proposalUtxos = await provider.getUtxos(proposalSpendAddress);
        } catch {
          // Address query may fail if no UTxOs exist
        }

        // Parse proposal datums
        const proposals: GovProposal[] = [];
        for (const u of proposalUtxos) {
          if (!u.datum) continue;
          const parsed = parseProposalDatum(u.datum);
          if (parsed) proposals.push(parsed);
        }

        const byState: Record<string, number> = {};
        const byType: Record<string, number> = {};
        let totalStake = 0;
        for (const p of proposals) {
          byState[p.state] = (byState[p.state] || 0) + 1;
          byType[p.proposalType] = (byType[p.proposalType] || 0) + 1;
          totalStake += p.stakeAmount;
        }

        const adoptedCount = byState['Adopted'] || 0;
        const totalCount = proposals.length;
        const adoptionRate = totalCount > 0 ? ((adoptedCount / totalCount) * 100).toFixed(1) : '0.0';

        const stateLines = Object.entries(byState).map(([s, c]) => `  - ${s}: ${c}`).join('\n');
        const typeLines = Object.entries(byType).map(([t, c]) => `  - ${t}: ${c}`).join('\n');

        if (focus === "treasury") {
          return {
            content: [{
              type: "text" as const,
              text: `# Treasury Health

**Balance:** ${lovelaceToApex(treasuryTotal)} AP3X
**Batch UTxOs:** ${treasuryUtxos.length}
**Address:** ${GOV_TREASURY_ADDRESS}

${Number(treasuryTotal) < 2_500_000_000 ? '**WARNING:** Treasury below 2,500 AP3X threshold' : 'Treasury health: OK'}`,
            }],
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `# Proposal Metrics${focus !== 'overview' ? ` (${focus})` : ''}

## Proposals
- **Total on-chain:** ${totalCount}
- **By state:**
${stateLines || '  (none)'}
- **By type:**
${typeLines || '  (none)'}
- **Total stake committed:** ${lovelaceToApex(totalStake)} AP3X

## Adoption
- **Adopted:** ${adoptedCount}
- **Adoption rate:** ${adoptionRate}%

## Treasury
- **Balance:** ${lovelaceToApex(treasuryTotal)} AP3X
- **Batch UTxOs:** ${treasuryUtxos.length}
${Number(treasuryTotal) < 2_500_000_000 ? '\n**WARNING:** Treasury below alert threshold (2,500 AP3X)' : ''}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to analyze proposal metrics: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Verify Ogmios endpoint is reachable
2. The module contracts may not be deployed yet`,
          }],
        };
      }
    }
  );

  // ─── vector_build_self_improvement_proposal_lock - KEYLESS (step 1 of 2) ──

  server.tool(
    "vector_build_self_improvement_proposal_lock",
    "Build an UNSIGNED transaction that locks an improvement-proposal stake (step 1 of 2). Requires staking at least 25 AP3X. Provide proposalDocument for automatic IPFS upload, or proposalHash and storageUri manually. Takes no key material. Sign it locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction. After this confirms, call this tool's counterpart, vector_build_self_improvement_proposal_spend, with the lock transaction hash to complete the submission.",
    {
      changeAddress: z.string().describe("Your wallet address (holds the stake AP3X; receives change). Get it from vector_signer_get_address."),
      agentDid: z.string().describe("Agent DID (hex) - the asset name from Agent Registry NFT"),
      proposalType: z.enum(["ParameterChange", "TreasurySpend", "ProtocolUpgrade", "GameActivation", "GeneralSuggestion"]).describe("Category of the proposal"),
      stakeApex: z.number().min(MIN_PROPOSAL_STAKE_APEX).describe(`AP3X to stake (minimum ${MIN_PROPOSAL_STAKE_APEX})`),
      typeParams: z.object({
        paramName: z.string().optional(),
        currentValue: z.number().optional(),
        proposedValue: z.number().optional(),
        amount: z.number().optional(),
        recipientDescription: z.string().optional(),
        upgradeHash: z.string().optional(),
        gameId: z.number().optional(),
      }).optional().describe("Type-specific parameters (required for ParameterChange and TreasurySpend)"),
      priority: z.enum(["Standard", "Emergency"]).default("Standard").describe("Priority level (Emergency requires higher stake and reputation)"),
      proposalDocument: z.string().optional().describe("Full proposal document as JSON string. Uploaded to IPFS via Filebase; hash and CID computed automatically. If provided, proposalHash and storageUri are ignored."),
      proposalHash: z.string().optional().describe("blake2b_256 hash of proposal document (64 hex chars). Required if proposalDocument is not provided."),
      storageUri: z.string().optional().describe("Off-chain storage URI for the full proposal (IPFS CID or OriginTrail UAL). Required if proposalDocument is not provided."),
    },
    async ({ changeAddress, agentDid, proposalType, stakeApex, typeParams, priority, proposalDocument, proposalHash, storageUri }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const lucid = await lucidForAddress(newProvider(), changeAddress);
        const r = await buildProposalLock(lucid, {
          agentDid, proposalType, stakeApex, typeParams, priority, proposalDocument, proposalHash, storageUri,
        });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Proposal Lock Built (Not Submitted) (step 1 of 2)

**Stake:** ${stakeApex} AP3X
**Type:** ${proposalType}
**Priority:** ${priority}
**Storage:** ${r.storageUri}
**Hash:** ${r.proposalHash}
**Script Address:** ${r.scriptAddress}
**Estimated Fee:** ${r.feeAda} AP3X
${r.ipfsCid ? `**IPFS CID:** ${r.ipfsCid}\n` : ''}
**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

${SIGN_AND_SUBMIT_COPY} After it confirms, call vector_build_self_improvement_proposal_spend { changeAddress, agentDid, lockTxHash: <the confirmed hash> } to complete the submission.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build proposal lock: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Ensure the changeAddress wallet holds at least ${stakeApex + 3} AP3X (stake + module minimum + fees).
2. For Emergency priority, the agent needs Established reputation (100+ AP3X staked elsewhere in the network).
3. proposalHash must be 64 hex characters (blake2b_256 of the proposal document).
4. Your local signer's per-transaction limit must allow the stake plus fees.`,
          }],
        };
      }
    }
  );

  // ─── vector_build_self_improvement_proposal_spend - KEYLESS (step 2 of 2) ─

  server.tool(
    "vector_build_self_improvement_proposal_spend",
    "Build an UNSIGNED transaction that completes an improvement-proposal submission (step 2 of 2): spends the locked stake through the module validator and mints the proposal and activity tokens. Requires the confirmed lock transaction hash from vector_build_self_improvement_proposal_lock. Takes no key material. Sign it locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction.",
    {
      changeAddress: z.string().describe("The SAME wallet address used to build the proposal lock. Get it from vector_signer_get_address."),
      agentDid: z.string().describe("Agent DID (hex) - must match the proposer DID in the locked proposal"),
      lockTxHash: z.string().describe("The CONFIRMED transaction hash from the proposal lock step"),
      lockOutputIndex: z.number().default(0).describe("Output index of the locked proposal UTxO (default: 0)"),
    },
    async ({ changeAddress, agentDid, lockTxHash, lockOutputIndex }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildProposalSpend(lucid, provider, { agentDid, lockTxHash, lockOutputIndex });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Proposal Submission Built (Not Submitted) (step 2 of 2)

**Proposal Token:** ${r.proposalTokenName}
**Activity Token:** ${r.activityTokenName}
**Script Address:** ${r.scriptAddress}
**Estimated Fee:** ${r.feeAda} AP3X

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

This transaction is valid until ${new Date(r.validToMs).toISOString()} (about 6 minutes). Sign and submit it before then, or rebuild. ${SIGN_AND_SUBMIT_COPY} Once this confirms, use THIS transaction's hash as proposalTxHash for critiques and endorsements.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build proposal submission: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Confirm the lock transaction first with vector_await_transaction { txHash } before calling this tool.
2. The changeAddress must be the same wallet that built the proposal lock.
3. Ensure the changeAddress wallet holds a few AP3X beyond the locked stake, to cover the activity-token output (2 AP3X) and fees.`,
          }],
        };
      }
    }
  );

  // ─── vector_build_self_improvement_critique - KEYLESS ─────────────────────

  server.tool(
    "vector_build_self_improvement_critique",
    "Build an UNSIGNED transaction that submits a critique on an improvement proposal (Supportive, Opposing, or Amendment). Requires staking at least 10 AP3X. Provide critiqueDocument for automatic IPFS upload, or critiqueHash and storageUri manually. Takes no key material. Sign it locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction. Find a proposalTxHash to critique with vector_self_improvement_browse.",
    {
      changeAddress: z.string().describe("Your wallet address (holds the stake AP3X; receives change). Get it from vector_signer_get_address."),
      agentDid: z.string().describe("Agent DID (hex)"),
      proposalTxHash: z.string().describe("TX hash of the proposal UTxO to critique"),
      // Note: a bare .default() without .optional() is reported as *required* by the
      // SDK's isSchemaOptional() under zod/v4 (it returned optional under v3). That
      // helper is only used for server.prompt() argument listing, which this codebase
      // does not use - harmless for server.tool(), but relevant if prompts are added.
      proposalOutputIndex: z.number().default(0).describe("Output index of the proposal UTxO"),
      critiqueDocument: z.string().optional().describe("Full critique document as JSON string. Uploaded to IPFS via Filebase; hash and CID computed automatically."),
      critiqueHash: z.string().optional().describe("blake2b_256 hash of critique document (64 hex chars). Required if critiqueDocument is not provided."),
      critiqueType: z.enum(["Supportive", "Opposing", "Amendment"]).describe("Type of critique"),
      storageUri: z.string().optional().describe("Off-chain storage URI for the critique document. Required if critiqueDocument is not provided."),
      stakeApex: z.number().min(MIN_CRITIQUE_STAKE_APEX).describe(`AP3X to stake (minimum ${MIN_CRITIQUE_STAKE_APEX})`),
    },
    async ({ changeAddress, agentDid, proposalTxHash, proposalOutputIndex, critiqueDocument, critiqueHash, critiqueType, storageUri, stakeApex }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const lucid = await lucidForAddress(newProvider(), changeAddress);
        const r = await buildCritique(lucid, {
          agentDid, proposalTxHash, proposalOutputIndex, critiqueType, stakeApex, critiqueDocument, critiqueHash, storageUri,
        });
        const storageDisplay = r.ipfsCid ? `ipfs://${r.ipfsCid}` : storageUri;
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Critique Built (Not Submitted)

**Type:** ${critiqueType}
**Stake:** ${stakeApex} AP3X
**Proposal:** ${proposalTxHash}#${proposalOutputIndex}
**Storage:** ${storageDisplay}
${r.ipfsCid ? `**IPFS CID:** ${r.ipfsCid}\n**Hash (auto-computed):** ${r.documentHash}\n` : ''}
**Script Address:** ${r.scriptAddress}
**Estimated Fee:** ${r.feeAda} AP3X

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

${SIGN_AND_SUBMIT_COPY}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build critique: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Ensure the changeAddress wallet holds at least ${stakeApex + 3} AP3X (stake + fees).
2. Verify the proposal UTxO exists with vector_self_improvement_browse.
3. critiqueHash must be 64 hex characters (blake2b_256 of the critique document).
4. Your local signer's per-transaction limit must allow the stake plus fees.`,
          }],
        };
      }
    }
  );

  // ─── vector_build_self_improvement_endorse - KEYLESS ──────────────────────

  server.tool(
    "vector_build_self_improvement_endorse",
    "Build an UNSIGNED transaction that endorses an improvement proposal by staking at least 5 AP3X. Endorsements signal support to the Foundation Council and are weighted by stake amount. Takes no key material. Sign it locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction. Find a proposalTxHash to endorse with vector_self_improvement_browse.",
    {
      changeAddress: z.string().describe("Your wallet address (holds the stake AP3X; receives change). Get it from vector_signer_get_address."),
      agentDid: z.string().describe("Agent DID (hex)"),
      proposalTxHash: z.string().describe("TX hash of the proposal UTxO to endorse"),
      proposalOutputIndex: z.number().default(0).describe("Output index of the proposal UTxO"),
      stakeApex: z.number().min(MIN_ENDORSE_STAKE_APEX).describe(`AP3X to stake as endorsement (minimum ${MIN_ENDORSE_STAKE_APEX})`),
    },
    async ({ changeAddress, agentDid, proposalTxHash, proposalOutputIndex, stakeApex }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const lucid = await lucidForAddress(newProvider(), changeAddress);
        const r = await buildEndorse(lucid, { agentDid, proposalTxHash, proposalOutputIndex, stakeApex });
        return {
          content: [{
            type: "text" as const,
            text: `# Unsigned Endorsement Built (Not Submitted)

**Stake:** ${stakeApex} AP3X
**Proposal:** ${proposalTxHash}#${proposalOutputIndex}
**Script Address:** ${r.scriptAddress}
**Estimated Fee:** ${r.feeAda} AP3X

**Unsigned TX CBOR:**
\`\`\`
${r.txCbor}
\`\`\`

${SIGN_AND_SUBMIT_COPY}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to build endorsement: ${err instanceof Error ? err.message : String(err)}

**Troubleshooting Tips:**
1. Ensure the changeAddress wallet holds at least ${stakeApex + 3} AP3X (stake + fees).
2. Verify the proposal UTxO exists and is in Open state (use vector_self_improvement_browse).
3. Your local signer's per-transaction limit must allow the stake plus fees.`,
          }],
        };
      }
    }
  );
}
