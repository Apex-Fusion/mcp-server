// packages/builder/src/vector/self-improvement.ts
// The self-improvement (Module-6) tools: 2 read-only tools (browse, analyze_metrics) and 6 keyless build tools on the Module-6
// deployment of the identity registry (Part 2 Section 7). A proposal, a critique and an endorsement each take two build tools: step 1
// locks the stake with the datum (vector_build_self_improvement_proposal_lock, _critique, _endorse), step 2 spends the confirmed lock
// through the module validator and mints the position's token (_proposal_spend, _critique_spend, _endorse_spend). The agent is a
// did:vector agent whose record is Active; its declared credential (the controller key or a listed transaction key) signs step 2. No
// tool takes key material. The read tools also read the previous deployment, whose positions stay until their owners exit. The node,
// the deployments, Koios, the clock and the rate limiter come from `deps`, so a test can hand in its own.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { limiterFor } from './rate-limiter.js';
import type { RateLimiter } from './rate-limiter.js';
import { lucidForAddress } from './build.js';
import { cell, fail, isoOrRaw, rateGate, text } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { didOf, identifierOf } from './identity-chain.js';
import { textOf } from './identity-codec.js';
import { buildText, zKeyHash, zValidMinutes } from './identity-shared.js';
import {
  CRITIQUE_TYPES, PROPOSAL_TYPES, TOKEN_PREFIX, decodeCritiqueDatum, decodeEndorsementDatum, decodeProposalDatum,
  deriveProposalTokenName,
} from './gov-codec.js';
import type { CritiqueDatum, EndorsementDatum, ProposalDatum } from './gov-codec.js';
import { PREVIOUS_GOV_DEPLOYMENT, policyTokens, proposalTokenOf, requireGovDeployment, scriptAddress } from './gov-deployment.js';
import type { GovDeployment, KoiosAccess } from './gov-deployment.js';
import {
  MIN_CRITIQUE_STAKE_APEX, MIN_ENDORSE_STAKE_APEX, MIN_PROPOSAL_STAKE_APEX, buildCritiqueLock, buildCritiqueSpend, buildEndorseLock,
  buildEndorseSpend, buildProposalLock, buildProposalSpend,
} from './gov-tx.js';
import type { CreationBuild, GovContext, LockBuild } from './gov-tx.js';

function newProvider(): Provider {
  return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
}

/** What the tools read from outside: each has the server's default, and a test hands in its own. */
export interface SelfImprovementDeps {
  provider?: () => Provider;
  limiter?: Pick<RateLimiter, 'check'>;
  gov?: () => GovDeployment;
  identity?: () => IdentityDeployment;
  koios?: KoiosAccess;
  /** POSIX ms of a build; default now. */
  now?: () => number;
}

// ─── Read side: the current or the previous deployment ──────────────────────────────────────────────────────────────────────────

type DeploymentName = 'current' | 'previous';

/** The addresses and token policies that the read tools need. */
interface ReadDeployment {
  label: string; proposalAddress: string; critiqueAddress: string; endorsementAddress: string; treasuryAddress: string; proposalMint: string; critiqueMint: string;
  /** The current deployment lists only created positions (they hold their token); the previous one lists every datum, as before. */
  createdOnly: boolean;
}

function readDeployment(which: DeploymentName, gov: () => GovDeployment): ReadDeployment {
  if (which === 'previous') {
    const p = PREVIOUS_GOV_DEPLOYMENT;
    return {
      label: 'previous deployment (read-only; its positions stay until their owners exit)', proposalAddress: scriptAddress(p.proposalSpend),
      critiqueAddress: scriptAddress(p.critiqueSpend), endorsementAddress: scriptAddress(p.endorsementSpend), treasuryAddress: p.treasuryAddress,
      proposalMint: p.proposalMint, critiqueMint: p.critiqueMint, createdOnly: false,
    };
  }
  const g = gov();
  return {
    label: 'current deployment', proposalAddress: g.proposalAddress, critiqueAddress: g.critiqueAddress, endorsementAddress: g.endorsementAddress,
    treasuryAddress: g.treasuryAddress, proposalMint: g.proposalMint, critiqueMint: g.critiqueMint, createdOnly: true,
  };
}

const zDeployment = z.enum(['current', 'previous']).optional()
  .describe("Which Module-6 deployment to read: 'current' (default; the deployment on the identity registry that this server is configured for) or 'previous' (the deployment before the identity registry; its positions stay there until their owners exit)");

const ref = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;
/** An agent identifier as a DID when it is one (32 bytes), else as hex. */
const agentText = (id: string): string => (id.length === 64 ? didOf(id) : id || '(none)');
const uriText = (hex: string): string => cell(textOf(hex) ?? `0x${hex}`, 200);
const days = (ms: number): string => `${(ms / 86_400_000).toFixed(1)} days`;

async function utxosAt(provider: Provider, address: string): Promise<UTxO[]> {
  try { return await provider.getUtxos(address); } catch { return []; } // an address without outputs can fail the query
}

/** The decoded datum of each output that decodes; for the current deployment only outputs that hold a token with `prefix`. */
function positions<T>(utxos: UTxO[], decode: (hex: string) => T, d: ReadDeployment, policy: string, prefix: string): Array<{ utxo: UTxO; datum: T }> {
  const found: Array<{ utxo: UTxO; datum: T }> = [];
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    if (d.createdOnly && !Object.entries(policyTokens(utxo, policy)).some(([name, q]) => name.startsWith(prefix) && q === 1n)) continue;
    try { found.push({ utxo, datum: decode(utxo.datum) }); } catch { /* another kind of output at the address */ }
  }
  return found;
}

function proposalsAt(utxos: UTxO[], d: ReadDeployment): Array<{ utxo: UTxO; datum: ProposalDatum }> {
  const found = positions(utxos, decodeProposalDatum, d, d.proposalMint, TOKEN_PREFIX.proposal);
  return d.createdOnly ? found.filter((p) => proposalTokenOf(p.utxo, d) !== null) : found;
}

const SIGN_STEP2_TIP = 'Step 2 runs the module validator: the wallet needs about 1 AP3X for the fee and one pure AP3X output of at least 5 AP3X as collateral';
const IDENTITY_TIP = 'The agent needs an identity record (vector_build_identity_register) whose effective status is Active; vector_resolve_did { did } shows it';
const CREDENTIAL_TIP = 'The declared credential is the record\'s controller key or a listed Ed25519 key with the transaction purpose; pass credentialKeyHash when it is not the key of changeAddress';

export function registerSelfImprovementTools(server: McpServer, identity: string, deps: SelfImprovementDeps = {}) {
  const gate = rateGate(deps.limiter ?? limiterFor(identity));
  const providerFor = deps.provider ?? newProvider;
  const govFor = deps.gov ?? requireGovDeployment;
  const identityFor = deps.identity ?? requireIdentityDeployment;
  const koios: KoiosAccess = deps.koios ?? { url: VECTOR_KOIOS_URL, fetchImpl: fetch };
  const now = deps.now ?? Date.now;

  /** Both deployments (a missing one names its variables), the node and Lucid bound to the wallet. */
  async function contextFor(changeAddress: string): Promise<GovContext> {
    const gov = govFor();
    const identityDeployment = identityFor();
    const provider = providerFor();
    return { lucid: await lucidForAddress(provider, changeAddress), provider, identity: identityDeployment, gov, koios };
  }

  // ─── vector_self_improvement_browse (read-only) ───────────────────────────

  server.tool(
    "vector_self_improvement_browse",
    "Browse improvement proposals, critiques, endorsements and the treasury of the Module-6 (self-improvement) module: reads the outputs at the module's script addresses and decodes their datums. The current deployment lists created positions only (each holds its token). Read-only.",
    {
      entity: z.enum(["proposals", "critiques", "endorsements", "treasury"]).describe("What to browse"),
      state: z.string().optional().describe("Filter proposals by state: Open, Amended, Adopted, Rejected, Expired, Withdrawn"),
      proposalType: z.string().optional().describe("Filter proposals by type: ParameterChange, TreasurySpend, ProtocolUpgrade, GameActivation, GeneralSuggestion"),
      proposerDid: z.string().optional().describe("Filter proposals by proposer: did:vector:<64 hex> (the legacy form and the bare 64-hex identifier also work)"),
      proposalTxHash: z.string().optional().describe("Filter critiques/endorsements by their proposal: the transaction hash of the proposal's seed (the lock that its submission spent) or of its current output"),
      deployment: zDeployment,
    },
    async ({ entity, state, proposalType, proposerDid, proposalTxHash, deployment }) => {
      const limited = gate(); if (limited) return limited;
      try {
        const d = readDeployment(deployment ?? 'current', govFor);
        const provider = providerFor();
        if (entity === "treasury") {
          const utxos = await utxosAt(provider, d.treasuryAddress);
          const total = utxos.reduce((sum, u) => sum + BigInt(u.assets?.lovelace ?? 0n), 0n);
          return text(`# Treasury Balance (${d.label})\n\n**Total:** ${lovelaceToAda(total)} AP3X\n**UTxO Count:** ${utxos.length}\n**Address:** ${d.treasuryAddress}\n\nEach batch UTxO holds ~30 AP3X for adoption rewards.`);
        }

        if (entity === "proposals") {
          const proposer = proposerDid === undefined ? undefined : identifierOf(proposerDid);
          const items = proposalsAt(await utxosAt(provider, d.proposalAddress), d).filter(({ datum }) =>
            (!state || datum.state.type === state) && (!proposalType || datum.proposalType.type === proposalType) && (!proposer || datum.proposerDid === proposer));
          if (items.length === 0) return text(`No proposals found on-chain (${d.label}).`);
          const lines = items.map(({ utxo, datum: p }, i) => `## ${i + 1}. ${p.proposalType.type} Proposal (${p.state.type})
- **Proposer:** ${agentText(p.proposerDid)}
- **Priority:** ${p.priority}
- **Stake:** ${lovelaceToAda(p.stakeAmount)} AP3X
- **Submitted:** ${d.createdOnly ? isoOrRaw(p.submittedAt) : p.submittedAt}
- **Review Window:** ${days(p.reviewWindow)}
- **Amendments:** ${p.amendmentCount}
- **Storage:** ${uriText(p.storageUri)}
- **UTxO:** ${ref(utxo)}`);
          return text(`# Improvement Proposals (${items.length} found, ${d.label})\n\n${lines.join('\n\n')}\n\nA critique or an endorsement names a proposal by its current UTxO or by its seed (the lock that its submission spent).`);
        }

        // Critiques and endorsements name their proposal by the seed (the current deployment) or by the proposal output (the previous
        // one), so the filter matches either: the transaction of the reference, or the token of a proposal output of that transaction.
        let matches: (seedRef: { txHash: string; outputIndex: number }) => boolean = () => true;
        if (proposalTxHash) {
          const hash = proposalTxHash.trim().toLowerCase();
          const tokens = new Set((await utxosAt(provider, d.proposalAddress)).filter((u) => u.txHash === hash).map((u) => proposalTokenOf(u, d)).filter((t): t is string => t !== null));
          matches = (r) => r.txHash === hash || tokens.has(deriveProposalTokenName(r.txHash, r.outputIndex));
        }
        if (entity === "critiques") {
          const items = positions(await utxosAt(provider, d.critiqueAddress), decodeCritiqueDatum, d, d.critiqueMint, TOKEN_PREFIX.critique)
            .filter(({ datum }) => matches(datum.proposalRef));
          if (items.length === 0) return text(`No critiques found on-chain (${d.label}).`);
          const lines = items.map(({ utxo, datum: c }: { utxo: UTxO; datum: CritiqueDatum }, i) => `## ${i + 1}. ${c.critiqueType.type} Critique
- **Critic:** ${agentText(c.criticDid)}
- **Proposal:** ${c.proposalRef.txHash}#${c.proposalRef.outputIndex}
- **Stake:** ${lovelaceToAda(c.stakeAmount)} AP3X
- **Incorporated:** ${c.incorporated ? 'Yes' : 'No'}
- **Storage:** ${uriText(c.storageUri)}
- **UTxO:** ${ref(utxo)}`);
          return text(`# Critiques (${items.length} found, ${d.label})\n\n${lines.join('\n\n')}`);
        }
        const items = positions(await utxosAt(provider, d.endorsementAddress), decodeEndorsementDatum, d, d.critiqueMint, TOKEN_PREFIX.endorsement)
          .filter(({ datum }) => matches(datum.proposalRef));
        if (items.length === 0) return text(`No endorsements found on-chain (${d.label}).`);
        const lines = items.map(({ utxo, datum: e }: { utxo: UTxO; datum: EndorsementDatum }, i) => `## ${i + 1}. Endorsement
- **Endorser:** ${agentText(e.endorserDid)}
- **Proposal:** ${e.proposalRef.txHash}#${e.proposalRef.outputIndex}
- **Stake:** ${lovelaceToAda(e.stakeAmount)} AP3X
- **UTxO:** ${ref(utxo)}`);
        return text(`# Endorsements (${items.length} found, ${d.label})\n\n${lines.join('\n\n')}`);
      } catch (err) {
        return fail('browse proposal data', err, [
          "The current deployment needs the GOV_* settings of this server; deployment: 'previous' reads the deployment before the identity registry",
          'Verify the configured Ogmios endpoint is reachable',
          'The script addresses may not have any UTxOs yet',
        ]);
      }
    }
  );

  // ─── vector_self_improvement_analyze_metrics (read-only) ──────────────────

  server.tool(
    "vector_self_improvement_analyze_metrics",
    "Analyze proposal metrics of the Module-6 (self-improvement) module: proposal activity, adoption rate, treasury health, and engagement statistics. Read-only, takes no key material.",
    {
      focus: z.enum(["overview", "adoption", "treasury", "activity"]).default("overview").describe("Analysis focus area"),
      deployment: zDeployment,
    },
    async ({ focus, deployment }) => {
      const limited = gate(); if (limited) return limited;
      try {
        const d = readDeployment(deployment ?? 'current', govFor);
        const provider = providerFor();
        const treasuryUtxos = await utxosAt(provider, d.treasuryAddress);
        const treasuryTotal = treasuryUtxos.reduce((sum, u) => sum + BigInt(u.assets?.lovelace ?? 0n), 0n);
        const lowTreasury = treasuryTotal < 2_500_000_000n;
        if (focus === "treasury") {
          return text(`# Treasury Health (${d.label})\n\n**Balance:** ${lovelaceToAda(treasuryTotal)} AP3X\n**Batch UTxOs:** ${treasuryUtxos.length}\n**Address:** ${d.treasuryAddress}\n\n${lowTreasury ? '**WARNING:** Treasury below 2,500 AP3X threshold' : 'Treasury health: OK'}`);
        }
        const proposals = proposalsAt(await utxosAt(provider, d.proposalAddress), d).map((p) => p.datum);
        const byState: Record<string, number> = {};
        const byType: Record<string, number> = {};
        let totalStake = 0n;
        for (const p of proposals) {
          byState[p.state.type] = (byState[p.state.type] ?? 0) + 1;
          byType[p.proposalType.type] = (byType[p.proposalType.type] ?? 0) + 1;
          totalStake += p.stakeAmount;
        }
        const adopted = byState.Adopted ?? 0;
        const adoptionRate = proposals.length > 0 ? ((adopted / proposals.length) * 100).toFixed(1) : '0.0';
        const list = (counts: Record<string, number>): string => Object.entries(counts).map(([k, c]) => `  - ${k}: ${c}`).join('\n') || '  (none)';
        return text(`# Proposal Metrics${focus !== 'overview' ? ` (${focus})` : ''}, ${d.label}

## Proposals
- **Total on-chain:** ${proposals.length}
- **By state:**
${list(byState)}
- **By type:**
${list(byType)}
- **Total stake committed:** ${lovelaceToAda(totalStake)} AP3X

## Adoption
- **Adopted:** ${adopted}
- **Adoption rate:** ${adoptionRate}%

## Treasury
- **Balance:** ${lovelaceToAda(treasuryTotal)} AP3X
- **Batch UTxOs:** ${treasuryUtxos.length}
${lowTreasury ? '\n**WARNING:** Treasury below alert threshold (2,500 AP3X)' : ''}`);
      } catch (err) {
        return fail('analyze proposal metrics', err, [
          "The current deployment needs the GOV_* settings of this server; deployment: 'previous' reads the deployment before the identity registry",
          'Verify Ogmios endpoint is reachable',
        ]);
      }
    }
  );

  // ─── Shared schema pieces of the build tools ──────────────────────────────

  const zChange = z.string().describe("Your wallet address: it pays the stake, the fee and the deposits, gives the collateral of step 2, and receives the change. Get it from vector_signer_get_address.");
  const zAgent = (role: string) => z.string().min(1).max(256)
    .describe(`The DID of the ${role}: did:vector:<64 hex> (the legacy form did:vector:agent:<policy>:<64 hex> and the bare 64-hex identifier also work). Its identity record must be Active.`);
  const zCredential = zKeyHash("The declared credential of the agent: the key hash of its record's controller key or of a listed Ed25519 key with the transaction purpose. Default: the key of changeAddress. Stakes and rewards return to it, and its key signs step 2").optional();
  const zLockTx = (step1: string) => z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters').describe(`The CONFIRMED transaction hash of the lock (${step1})`);
  const zLockIndex = z.number().int().min(0).default(0).describe("Output index of the lock in that transaction (default: 0; step 1 shows it)");
  const zProposalTx = z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters').describe("The proposal: the transaction hash of its seed (the lock that its submission spent; vector_build_self_improvement_proposal_spend shows it) or of its current output (vector_self_improvement_browse shows it)");
  const zProposalIndex = z.number().int().min(0).default(0).describe("Output index of the proposal's seed or current output (default: 0)");

  const lockFacts = (r: LockBuild, extra: Array<[string, string]>): Array<[string, string]> => [
    ['Agent', r.did],
    ['Declared credential', `${r.credentialKeyHash} (${r.credentialRole})`],
    ...extra,
    ['Stake', `${lovelaceToAda(r.stakeLovelace)} AP3X (the lock holds ${lovelaceToAda(r.lockLovelace)} AP3X)`],
    ['Lock output', `${r.txHash}#${r.lockOutputIndex} at ${r.scriptAddress}`],
  ];
  const lockJson = (r: LockBuild): Record<string, unknown> => ({
    step: 1, agent_did: r.did, lock_tx_hash: r.txHash, lock_output_index: r.lockOutputIndex, credential_key_hash: r.credentialKeyHash,
    stake_lovelace: r.stakeLovelace, lock_lovelace: r.lockLovelace, script_address: r.scriptAddress,
  });
  const step2 = (tool: string, r: LockBuild): string =>
    `After this confirms (vector_await_transaction { txHash: "${r.txHash}" }), call ${tool} { changeAddress, agentDid: "${r.did}", lockTxHash: "${r.txHash}", lockOutputIndex: ${r.lockOutputIndex} }. Step 2 needs the signature of the declared credential ${r.credentialKeyHash}.`;
  const creationJson = (r: CreationBuild): Record<string, unknown> => ({ step: 2, agent_did: r.did, seed: r.seed, position: r.position, token_name: r.tokenName });

  // ─── vector_build_self_improvement_proposal_lock - KEYLESS (step 1 of 2) ──

  server.tool(
    "vector_build_self_improvement_proposal_lock",
    `Build an UNSIGNED transaction that locks an improvement proposal with its stake at the Module-6 proposal validator (step 1 of 2). The proposer is a did:vector agent whose identity record is Active; the datum names its declared credential (the controller key or a listed transaction key; default the wallet key). Requires staking at least ${MIN_PROPOSAL_STAKE_APEX} AP3X (the module parameters may ask more). A proposal lock can leave the validator only through its submission, so the tool checks every submission rule first: the identity record, the module parameters, the rate limit and the activity list. Provide proposalDocument for automatic IPFS upload, or proposalHash and storageUri manually. Takes no key material. Sign it locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction. After this confirms, call vector_build_self_improvement_proposal_spend with the lock transaction hash to complete the submission.`,
    {
      changeAddress: zChange,
      agentDid: zAgent('proposing agent'),
      credentialKeyHash: zCredential,
      proposalType: z.enum(PROPOSAL_TYPES).describe("Category of the proposal"),
      stakeApex: z.number().min(MIN_PROPOSAL_STAKE_APEX).describe(`AP3X to stake (minimum ${MIN_PROPOSAL_STAKE_APEX}; an Emergency proposal needs the emergency stake of the module parameters)`),
      typeParams: z.object({
        paramName: z.string().optional(),
        currentValue: z.number().optional(),
        proposedValue: z.number().optional(),
        amount: z.number().optional(),
        recipientDescription: z.string().optional(),
        upgradeHash: z.string().optional(),
        gameId: z.number().optional(),
      }).optional().describe("Type-specific parameters: ParameterChange needs paramName (a governable parameter name), currentValue and proposedValue; TreasurySpend needs amount (lovelace) and recipientDescription; ProtocolUpgrade needs upgradeHash (64 hex characters); GameActivation needs gameId (a positive whole number)"),
      priority: z.enum(["Standard", "Emergency"]).default("Standard").describe("Priority level: Standard (7-day review window) or Emergency (a ParameterChange or ProtocolUpgrade with the emergency stake and the emergency review window of the module parameters)"),
      proposalDocument: z.string().optional().describe("Full proposal document as JSON string. Uploaded to IPFS via Filebase; hash and CID computed automatically. If provided, proposalHash and storageUri are ignored."),
      proposalHash: z.string().optional().describe("blake2b_256 hash of proposal document (64 hex chars). Required if proposalDocument is not provided."),
      storageUri: z.string().optional().describe("Off-chain storage URI for the full proposal (IPFS CID or OriginTrail UAL). Required if proposalDocument is not provided."),
      validMinutes: zValidMinutes,
    },
    async (args) => {
      const limited = gate(); if (limited) return limited;
      try {
        const r = await buildProposalLock(await contextFor(args.changeAddress), {
          changeAddress: args.changeAddress, agentDid: args.agentDid, credentialKeyHash: args.credentialKeyHash, proposalType: args.proposalType,
          stakeApex: args.stakeApex, typeParams: args.typeParams, priority: args.priority, proposalDocument: args.proposalDocument,
          proposalHash: args.proposalHash, storageUri: args.storageUri, nowMs: now(), validMinutes: args.validMinutes,
        });
        const facts = lockFacts(r, [
          ['Type', `${args.proposalType}, ${r.priority}`],
          ['Review window', days(r.reviewWindow)],
          ['Storage', cell(r.storageUri, 200)],
          ['Hash', r.proposalHash],
          ...(r.ipfsCid ? [['IPFS CID', r.ipfsCid] as [string, string]] : []),
          ['Activity list', r.firstProposal ? "first proposal of the agent: step 2 inserts the agent's node" : "step 2 continues the agent's node"],
        ]);
        return text(buildText('Proposal Lock Built, Step 1 of 2', facts, r, {
          ...lockJson(r), proposal_hash: r.proposalHash, storage_uri: r.storageUri, ...(r.ipfsCid ? { ipfs_cid: r.ipfsCid } : {}),
          review_window_ms: r.reviewWindow, priority: r.priority, first_proposal: r.firstProposal,
        }, `${step2('vector_build_self_improvement_proposal_spend', r)} The locked stake leaves the validator only through that submission.`));
      } catch (err) {
        return fail('build proposal lock', err, [
          `Ensure the changeAddress wallet holds at least ${args.stakeApex + 3} AP3X (stake + module minimum + fees).`,
          IDENTITY_TIP, CREDENTIAL_TIP,
          'proposalHash must be 64 hex characters (blake2b_256 of the proposal document).',
          "Your local signer's per-transaction limit must allow the stake plus fees.",
        ]);
      }
    }
  );

  // ─── vector_build_self_improvement_proposal_spend - KEYLESS (step 2 of 2) ─

  server.tool(
    "vector_build_self_improvement_proposal_spend",
    "Build an UNSIGNED transaction that completes an improvement-proposal submission (step 2 of 2): spends the confirmed lock through the Module-6 proposal validator, mints the proposal token, and records the agent in the activity list (its first proposal inserts the agent's node and mints its activity token). The agent's identity record and its ancestors are reference inputs; the record must be Active over the validity window (at most 1 hour). The declared credential of the lock and the wallet sign. Takes no key material. Each key holder signs in turn with vector_signer_sign, then broadcast with vector_submit_transaction and confirm with vector_await_transaction.",
    {
      changeAddress: zChange,
      agentDid: zAgent('proposing agent (the proposer of the lock)'),
      lockTxHash: zLockTx('vector_build_self_improvement_proposal_lock'),
      lockOutputIndex: zLockIndex,
      validMinutes: zValidMinutes,
    },
    async (args) => {
      const limited = gate(); if (limited) return limited;
      try {
        const r = await buildProposalSpend(await contextFor(args.changeAddress), {
          changeAddress: args.changeAddress, agentDid: args.agentDid, lockTxHash: args.lockTxHash, lockOutputIndex: args.lockOutputIndex,
          nowMs: now(), validMinutes: args.validMinutes,
        });
        const facts: Array<[string, string]> = [
          ['Agent', r.did],
          ['Proposal seed', `${r.seed} (critiques and endorsements name the proposal by it)`],
          ['Proposal output', r.position],
          ['Proposal token', r.tokenName],
          ['Activity list', r.inserted ? `first proposal: inserts the agent's node after ${r.predecessor} and mints ${r.activityTokenName}` : `the agent's node continues with ${r.activeProposals} active proposals`],
        ];
        return text(buildText('Proposal Submission Built, Step 2 of 2', facts, r, {
          ...creationJson(r), proposal_token_name: r.tokenName, activity_token_name: r.activityTokenName, inserted: r.inserted,
          predecessor: r.predecessor, active_proposals: r.activeProposals,
        }, 'Once this confirms, the proposal is Open. Critiques and endorsements name it by its seed or its current output.'));
      } catch (err) {
        return fail('build proposal submission', err, [
          'Confirm the lock transaction first with vector_await_transaction { txHash } before calling this tool.',
          IDENTITY_TIP, SIGN_STEP2_TIP,
          'A first proposal also funds the new node of the activity list (2 AP3X).',
        ]);
      }
    }
  );

  // ─── vector_build_self_improvement_critique - KEYLESS (step 1 of 2) ───────

  server.tool(
    "vector_build_self_improvement_critique",
    `Build an UNSIGNED transaction that locks a critique of an improvement proposal (Supportive, Opposing, or Amendment) with its stake at the Module-6 critique validator (step 1 of 2). The critic is a did:vector agent whose identity record is Active; except for an Amendment critique, the critic and the proposer must be different parties (different identifiers, controller keys and credentials, and no direct subagent relation). Requires staking at least ${MIN_CRITIQUE_STAKE_APEX} AP3X. The datum names the proposal by its seed. Provide critiqueDocument for automatic IPFS upload, or critiqueHash and storageUri manually. Takes no key material. Sign it locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction. After this confirms, call vector_build_self_improvement_critique_spend with the lock transaction hash to create the critique. Find a proposal with vector_self_improvement_browse.`,
    {
      changeAddress: zChange,
      agentDid: zAgent('critic'),
      credentialKeyHash: zCredential,
      proposalTxHash: zProposalTx,
      // Note: a bare .default() without .optional() is reported as *required* by the
      // SDK's isSchemaOptional() under zod/v4 (it returned optional under v3). That
      // helper is only used for server.prompt() argument listing, which this codebase
      // does not use - harmless for server.tool(), but relevant if prompts are added.
      proposalOutputIndex: zProposalIndex,
      critiqueDocument: z.string().optional().describe("Full critique document as JSON string. Uploaded to IPFS via Filebase; hash and CID computed automatically."),
      critiqueHash: z.string().optional().describe("blake2b_256 hash of critique document (64 hex chars). Required if critiqueDocument is not provided."),
      critiqueType: z.enum(CRITIQUE_TYPES).describe("Type of critique (the proposer can write only an Amendment critique of its own proposal)"),
      storageUri: z.string().optional().describe("Off-chain storage URI for the critique document. Required if critiqueDocument is not provided."),
      stakeApex: z.number().min(MIN_CRITIQUE_STAKE_APEX).describe(`AP3X to stake (minimum ${MIN_CRITIQUE_STAKE_APEX})`),
      validMinutes: zValidMinutes,
    },
    async (args) => {
      const limited = gate(); if (limited) return limited;
      try {
        const r = await buildCritiqueLock(await contextFor(args.changeAddress), {
          changeAddress: args.changeAddress, agentDid: args.agentDid, credentialKeyHash: args.credentialKeyHash, proposalTxHash: args.proposalTxHash,
          proposalOutputIndex: args.proposalOutputIndex, critiqueType: args.critiqueType, stakeApex: args.stakeApex, critiqueDocument: args.critiqueDocument,
          critiqueHash: args.critiqueHash, storageUri: args.storageUri, nowMs: now(), validMinutes: args.validMinutes,
        });
        const facts = lockFacts(r, [
          ['Type', r.critiqueType],
          ['Proposal', `${r.proposal} (seed ${r.seed}), by ${r.proposerDid}`],
          ['Storage', cell(r.storageUri, 200)],
          [r.ipfsCid ? 'Hash (auto-computed)' : 'Hash', r.critiqueHash],
          ...(r.ipfsCid ? [['IPFS CID', r.ipfsCid] as [string, string]] : []),
        ]);
        return text(buildText('Critique Lock Built, Step 1 of 2', facts, r, {
          ...lockJson(r), seed: r.seed, proposal: r.proposal, proposer_did: r.proposerDid, critique_type: r.critiqueType, critique_hash: r.critiqueHash,
          storage_uri: r.storageUri, ...(r.ipfsCid ? { ipfs_cid: r.ipfsCid } : {}),
        }, step2('vector_build_self_improvement_critique_spend', r)));
      } catch (err) {
        return fail('build critique', err, [
          `Ensure the changeAddress wallet holds at least ${args.stakeApex + 3} AP3X (stake + fees).`,
          'Verify the proposal with vector_self_improvement_browse: it must be submitted and Open or Amended.',
          IDENTITY_TIP, CREDENTIAL_TIP,
          'critiqueHash must be 64 hex characters (blake2b_256 of the critique document).',
        ]);
      }
    }
  );

  // ─── vector_build_self_improvement_critique_spend - KEYLESS (step 2 of 2) ─

  server.tool(
    "vector_build_self_improvement_critique_spend",
    "Build an UNSIGNED transaction that creates a critique (step 2 of 2): spends the confirmed critique lock through the Module-6 critique validator and mints its critique token. The critic's identity record and its ancestors, the proposal and (except for an Amendment critique) the proposer's record are reference inputs; the critic's record must be Active over the validity window (at most 1 hour). The declared credential of the lock and the wallet sign. Takes no key material. Each key holder signs in turn with vector_signer_sign, then broadcast with vector_submit_transaction and confirm with vector_await_transaction.",
    {
      changeAddress: zChange,
      agentDid: zAgent('critic (the critic of the lock)'),
      lockTxHash: zLockTx('vector_build_self_improvement_critique'),
      lockOutputIndex: zLockIndex,
      validMinutes: zValidMinutes,
    },
    async (args) => {
      const limited = gate(); if (limited) return limited;
      try {
        const r = await buildCritiqueSpend(await contextFor(args.changeAddress), {
          changeAddress: args.changeAddress, agentDid: args.agentDid, lockTxHash: args.lockTxHash, lockOutputIndex: args.lockOutputIndex,
          nowMs: now(), validMinutes: args.validMinutes,
        });
        const facts: Array<[string, string]> = [
          ['Agent', r.did],
          ['Critique type', r.datum.critiqueType.type],
          ['Proposal', `${r.proposal} (seed ${r.seed})`],
          ['Critique output', r.position],
          ['Critique token', r.tokenName],
        ];
        return text(buildText('Critique Built, Step 2 of 2', facts, r, { ...creationJson(r), proposal: r.proposal, critique_type: r.datum.critiqueType.type }));
      } catch (err) {
        return fail('build critique creation', err, [
          'Confirm the lock transaction first with vector_await_transaction { txHash } before calling this tool.',
          IDENTITY_TIP, SIGN_STEP2_TIP,
          'The proposal must still be Open or Amended.',
        ]);
      }
    }
  );

  // ─── vector_build_self_improvement_endorse - KEYLESS (step 1 of 2) ────────

  server.tool(
    "vector_build_self_improvement_endorse",
    `Build an UNSIGNED transaction that locks an endorsement of an improvement proposal with its stake at the Module-6 endorsement validator (step 1 of 2). Endorsements signal support to the Foundation Council and are weighted by stake amount. The endorser is a did:vector agent whose identity record is Active, and a different party from the proposer (different identifiers, controller keys and credentials, and no direct subagent relation). Requires staking at least ${MIN_ENDORSE_STAKE_APEX} AP3X. The datum names the proposal by its seed. Takes no key material. Sign it locally with vector_signer_sign, broadcast with vector_submit_transaction, then confirm with vector_await_transaction. After this confirms, call vector_build_self_improvement_endorse_spend with the lock transaction hash to create the endorsement. Find a proposal with vector_self_improvement_browse.`,
    {
      changeAddress: zChange,
      agentDid: zAgent('endorser'),
      credentialKeyHash: zCredential,
      proposalTxHash: zProposalTx,
      proposalOutputIndex: zProposalIndex,
      stakeApex: z.number().min(MIN_ENDORSE_STAKE_APEX).describe(`AP3X to stake as endorsement (minimum ${MIN_ENDORSE_STAKE_APEX})`),
      validMinutes: zValidMinutes,
    },
    async (args) => {
      const limited = gate(); if (limited) return limited;
      try {
        const r = await buildEndorseLock(await contextFor(args.changeAddress), {
          changeAddress: args.changeAddress, agentDid: args.agentDid, credentialKeyHash: args.credentialKeyHash, proposalTxHash: args.proposalTxHash,
          proposalOutputIndex: args.proposalOutputIndex, stakeApex: args.stakeApex, nowMs: now(), validMinutes: args.validMinutes,
        });
        const facts = lockFacts(r, [['Proposal', `${r.proposal} (seed ${r.seed}), by ${r.proposerDid}`]]);
        return text(buildText('Endorsement Lock Built, Step 1 of 2', facts, r, {
          ...lockJson(r), seed: r.seed, proposal: r.proposal, proposer_did: r.proposerDid,
        }, step2('vector_build_self_improvement_endorse_spend', r)));
      } catch (err) {
        return fail('build endorsement', err, [
          `Ensure the changeAddress wallet holds at least ${args.stakeApex + 3} AP3X (stake + fees).`,
          'Verify the proposal exists and is Open or Amended (use vector_self_improvement_browse).',
          IDENTITY_TIP, CREDENTIAL_TIP,
          "Your local signer's per-transaction limit must allow the stake plus fees.",
        ]);
      }
    }
  );

  // ─── vector_build_self_improvement_endorse_spend - KEYLESS (step 2 of 2) ──

  server.tool(
    "vector_build_self_improvement_endorse_spend",
    "Build an UNSIGNED transaction that creates an endorsement (step 2 of 2): spends the confirmed endorsement lock through the Module-6 endorsement validator and mints its endorsement token (gend_). The endorser's identity record and its ancestors, the proposal and the proposer's record are reference inputs; the endorser's record must be Active over the validity window (at most 1 hour). The declared credential of the lock and the wallet sign. Takes no key material. Each key holder signs in turn with vector_signer_sign, then broadcast with vector_submit_transaction and confirm with vector_await_transaction.",
    {
      changeAddress: zChange,
      agentDid: zAgent('endorser (the endorser of the lock)'),
      lockTxHash: zLockTx('vector_build_self_improvement_endorse'),
      lockOutputIndex: zLockIndex,
      validMinutes: zValidMinutes,
    },
    async (args) => {
      const limited = gate(); if (limited) return limited;
      try {
        const r = await buildEndorseSpend(await contextFor(args.changeAddress), {
          changeAddress: args.changeAddress, agentDid: args.agentDid, lockTxHash: args.lockTxHash, lockOutputIndex: args.lockOutputIndex,
          nowMs: now(), validMinutes: args.validMinutes,
        });
        const facts: Array<[string, string]> = [
          ['Agent', r.did],
          ['Proposal', `${r.proposal} (seed ${r.seed})`],
          ['Endorsement output', r.position],
          ['Endorsement token', r.tokenName],
        ];
        return text(buildText('Endorsement Built, Step 2 of 2', facts, r, { ...creationJson(r), proposal: r.proposal }));
      } catch (err) {
        return fail('build endorsement creation', err, [
          'Confirm the lock transaction first with vector_await_transaction { txHash } before calling this tool.',
          IDENTITY_TIP, SIGN_STEP2_TIP,
          'The proposal must still be Open or Amended.',
        ]);
      }
    }
  );
}
