// @ts-nocheck
// Governance Suggestion Engine tools: submit proposal, critique, endorse, browse, analyze metrics
// Game 6 of the Vector game theory ecosystem

import { z } from "zod";
import { Lucid, fromText, toText, Data, Constr, credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { OgmiosProvider } from './ogmios-provider.js';
import { safetyLayer } from './safety.js';
import { rateLimiter } from './rate-limiter.js';

// Env config
const VECTOR_OGMIOS_URL = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const VECTOR_SUBMIT_URL = process.env.VECTOR_SUBMIT_URL || 'https://submit.vector.testnet.apexfusion.org/api/submit/tx';
const VECTOR_KOIOS_URL = process.env.VECTOR_KOIOS_URL || 'https://koios.vector.testnet.apexfusion.org/';
const VECTOR_EXPLORER_URL = process.env.VECTOR_EXPLORER_URL || 'https://vector.testnet.apexscan.org';

// Governance contract hashes (from deploy_state.json)
// These should be set via env vars in production
const GOV_PROPOSAL_SPEND_HASH = process.env.GOV_PROPOSAL_SPEND_HASH || 'a74fc555e9b045695be1a26bdc9131681efa6b61738413ab9b2c7ea4';
const GOV_PROPOSAL_MINT_HASH = process.env.GOV_PROPOSAL_MINT_HASH || 'e8f38052352a3d20c5fe025e2a02d615826a154b26f2239286b8d565';
const GOV_CRITIQUE_SPEND_HASH = process.env.GOV_CRITIQUE_SPEND_HASH || 'ced52074861af95e2082004d6061b0fc4bb30fded61f9605bfc20e55';
const GOV_CRITIQUE_MINT_HASH = process.env.GOV_CRITIQUE_MINT_HASH || '2e252a89894d379ce5c0023a57de4627056e4a96da72bd8fedba04bd';
const GOV_ENDORSEMENT_SPEND_HASH = process.env.GOV_ENDORSEMENT_SPEND_HASH || '5fc449848d85f30287e5bc0bd2b3e95d872ef97be27f1480c12f1a9d';
const GOV_TREASURY_ADDRESS = process.env.GOV_TREASURY_ADDRESS || 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8';

// Proposal state CBOR constructor tags
const STATE_NAMES: Record<number, string> = {
  0: 'Open',
  1: 'Amended',
  2: 'Adopted',
  3: 'Rejected',
  4: 'Expired',
  5: 'Withdrawn',
};

const TYPE_NAMES: Record<number, string> = {
  0: 'ParameterChange',
  1: 'TreasurySpend',
  2: 'ProtocolUpgrade',
  3: 'GameActivation',
  4: 'GeneralSuggestion',
};

const PRIORITY_NAMES: Record<number, string> = {
  0: 'Standard',
  1: 'Emergency',
};

const CRITIQUE_TYPE_NAMES: Record<number, string> = {
  0: 'Supportive',
  1: 'Opposing',
  2: 'Amendment',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function newProvider() {
  return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
}

function explorerTxLink(txHash: string) {
  return `${VECTOR_EXPLORER_URL}/transaction/${txHash}`;
}

function lovelaceToApex(lovelace: number | bigint): string {
  return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
}

function checkRateLimit() {
  const rateCheck = rateLimiter.check();
  if (!rateCheck.allowed) {
    return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
  }
  return null;
}

function scriptHashToAddress(hash: string): string {
  return credentialToAddress('Mainnet', { type: 'Script', hash });
}

// Derive token name: prefix + blake2b_256(CBOR(data))[0..27]
function deriveTokenName(prefix: string, cborHex: string): string {
  const hashBytes = blake2b(Buffer.from(cborHex, 'hex'), { dkLen: 32 });
  const prefixHex = Buffer.from(prefix, 'utf-8').toString('hex');
  const hashSlice = Buffer.from(hashBytes).toString('hex').slice(0, 54); // 27 bytes = 54 hex chars
  return prefixHex + hashSlice;
}

function deriveProposalTokenName(txHash: string, outputIndex: number): string {
  const outRefCbor = Data.to(new Constr(0, [txHash, BigInt(outputIndex)]));
  return deriveTokenName('prop_', outRefCbor);
}

function deriveActivityTokenName(agentDid: string): string {
  const didBytes = Buffer.from(agentDid, 'hex');
  const hashBytes = blake2b(didBytes, { dkLen: 32 });
  const prefixHex = Buffer.from('pact_', 'utf-8').toString('hex');
  const hashSlice = Buffer.from(hashBytes).toString('hex').slice(0, 54);
  return prefixHex + hashSlice;
}

// Parse ProposalDatum from CBOR
function parseProposalDatum(datumCbor: string): any | null {
  try {
    const c = Data.from(datumCbor);
    if (c.fields.length < 12) return null;

    const stateField = c.fields[11];
    const typeField = c.fields[3];
    const priorityField = c.fields[8];

    return {
      proposerDid: c.fields[0],
      proposalHash: c.fields[2],
      proposalType: TYPE_NAMES[Number(typeField.index)] || 'Unknown',
      storageUri: toText(c.fields[4]),
      stakeAmount: Number(c.fields[5]),
      submittedAt: Number(c.fields[6]),
      reviewWindow: Number(c.fields[7]),
      priority: PRIORITY_NAMES[Number(priorityField.index)] || 'Standard',
      amendmentCount: Number(c.fields[9]),
      incorporatedCritiques: c.fields[10]?.length || 0,
      state: STATE_NAMES[Number(stateField.index)] || 'Unknown',
    };
  } catch {
    return null;
  }
}

// Parse CritiqueDatum from CBOR
function parseCritiqueDatum(datumCbor: string): any | null {
  try {
    const c = Data.from(datumCbor);
    if (c.fields.length < 9) return null;

    const critiqueTypeField = c.fields[5];
    const incorporatedField = c.fields[8];

    return {
      criticDid: c.fields[0],
      proposalRef: c.fields[2],
      critiqueHash: c.fields[3],
      storageUri: toText(c.fields[4]),
      critiqueType: CRITIQUE_TYPE_NAMES[Number(critiqueTypeField.index)] || 'Unknown',
      stakeAmount: Number(c.fields[6]),
      submittedAt: Number(c.fields[7]),
      incorporated: Number(incorporatedField.index) === 1,
    };
  } catch {
    return null;
  }
}

// Parse EndorsementDatum from CBOR
function parseEndorsementDatum(datumCbor: string): any | null {
  try {
    const c = Data.from(datumCbor);
    if (c.fields.length < 5) return null;

    return {
      endorserDid: c.fields[0],
      proposalRef: c.fields[2],
      stakeAmount: Number(c.fields[3]),
      createdAt: Number(c.fields[4]),
    };
  } catch {
    return null;
  }
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function registerGovernanceTools(server) {

  // ─── vector_governance_browse (read-only) ───────────────────────────────

  server.tool(
    "vector_governance_browse",
    "Browse governance proposals, critiques, and endorsements. Query on-chain UTxOs at governance script addresses and decode datums into human-readable format.",
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
              type: "text",
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

        // Get script address from hash
        const scriptAddress = credentialToAddress('Mainnet', { type: 'Script', hash: scriptHash });

        let utxos;
        try {
          utxos = await provider.getUtxos(scriptAddress);
        } catch {
          // Fallback: try Koios address lookup
          utxos = [];
        }

        if (!utxos || utxos.length === 0) {
          return {
            content: [{
              type: "text",
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
              type: "text",
              text: `# Governance Proposals (${items.length} found)\n\n${lines.join('\n\n') || 'No proposals match the filters.'}`,
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
              type: "text",
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
              type: "text",
              text: `# Endorsements (${items.length} found)\n\n${lines.join('\n\n') || 'No endorsements match the filters.'}`,
            }],
          };
        }
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to browse governance data: ${err.message}

**Troubleshooting Tips:**
1. Verify the governance contracts are deployed on testnet
2. Check that Ogmios is reachable at ${VECTOR_OGMIOS_URL}
3. The script addresses may not have any UTxOs yet`,
          }],
        };
      }
    }
  );

  // ─── vector_governance_submit_proposal ──────────────────────────────────

  server.tool(
    "vector_governance_submit_proposal",
    "Submit a governance proposal to the Vector Governance Suggestion Engine. Requires staking AP3X. The proposal document should be stored off-chain (IPFS/OriginTrail) and its blake2b_256 hash provided.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the wallet"),
      agentDid: z.string().describe("Agent DID (hex) — the asset name from Agent Registry NFT"),
      proposalHash: z.string().describe("blake2b_256 hash of proposal document (64 hex chars)"),
      proposalType: z.enum(["ParameterChange", "TreasurySpend", "ProtocolUpgrade", "GameActivation", "GeneralSuggestion"]).describe("Category of the proposal"),
      storageUri: z.string().describe("Off-chain storage URI for the full proposal (IPFS CID or OriginTrail UAL)"),
      stakeApex: z.number().min(25).describe("AP3X to stake (minimum 25)"),
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
    },
    async ({ mnemonic, agentDid, proposalHash, proposalType, storageUri, stakeApex, typeParams, priority }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;

      const stakeLovelace = stakeApex * 1_000_000;
      const safetyCheck = safetyLayer.checkTransaction(stakeLovelace + 4_000_000);
      if (!safetyCheck.allowed) {
        return { content: [{ type: "text", text: `Safety limit exceeded: ${safetyCheck.reason}. Check limits with vector_get_spend_limits.` }] };
      }

      try {
        if (proposalHash.length !== 64) throw new Error('proposalHash must be 64 hex characters (32 bytes)');

        const provider = newProvider();
        const lucid = await Lucid(provider, 'Mainnet');
        lucid.selectWallet.fromSeed(mnemonic.trim());
        const walletAddress = await lucid.wallet().address();

        // Build proposal type datum
        let typeDatum;
        switch (proposalType) {
          case 'ParameterChange':
            if (!typeParams?.paramName || typeParams?.currentValue == null || typeParams?.proposedValue == null) {
              throw new Error('ParameterChange requires paramName, currentValue, proposedValue');
            }
            typeDatum = new Constr(0, [fromText(typeParams.paramName), BigInt(typeParams.currentValue), BigInt(typeParams.proposedValue)]);
            break;
          case 'TreasurySpend':
            if (!typeParams?.amount || !typeParams?.recipientDescription) {
              throw new Error('TreasurySpend requires amount, recipientDescription');
            }
            typeDatum = new Constr(1, [BigInt(typeParams.amount), fromText(typeParams.recipientDescription)]);
            break;
          case 'ProtocolUpgrade':
            typeDatum = new Constr(2, [typeParams?.upgradeHash || '']);
            break;
          case 'GameActivation':
            typeDatum = new Constr(3, [BigInt(typeParams?.gameId || 0)]);
            break;
          default:
            typeDatum = new Constr(4, []);
        }

        // Get current slot
        const tip = await provider.getNetworkTip?.() || { slot: 0 };
        const currentSlot = tip.slot || 0;

        // Priority datum
        const priorityDatum = priority === 'Emergency' ? new Constr(1, []) : new Constr(0, []);

        // Build ProposalDatum
        const walletAddr = await lucid.wallet().address();
        const addrDetails = getAddressDetails(walletAddr);
        const vkeyHash = addrDetails.paymentCredential?.hash || '';

        const proposalDatum = Data.to(new Constr(0, [
          agentDid,                          // proposer_did
          new Constr(0, [vkeyHash]),         // proposer_credential (VerificationKey)
          proposalHash,                       // proposal_hash
          typeDatum,                          // proposal_type
          fromText(storageUri),              // storage_uri
          BigInt(stakeLovelace),             // stake_amount
          BigInt(currentSlot),               // submitted_at
          BigInt(604_800_000),               // review_window (~7 days in ms)
          priorityDatum,                     // priority
          0n,                                 // amendment_count
          [],                                 // incorporated_critiques
          new Constr(0, []),                 // state = Open
        ]));

        // Lock ProposalDatum at proposal_spend address
        const proposalSpendAddress = credentialToAddress('Mainnet', { type: 'Script', hash: GOV_PROPOSAL_SPEND_HASH });

        const lockTx = await lucid.newTx()
          .pay.ToAddressWithData(
            proposalSpendAddress,
            { kind: "inline", value: proposalDatum },
            { lovelace: BigInt(stakeLovelace + 2_000_000) }
          )
          .complete();

        const signedLockTx = await lockTx.sign.withWallet().complete();
        const lockTxHash = await signedLockTx.submit();

        safetyLayer.recordTransaction(lockTxHash, stakeLovelace + 2_000_000, proposalSpendAddress);

        return {
          content: [{
            type: "text",
            text: `# Proposal Submitted

**Transaction:** ${lockTxHash}
**Stake:** ${stakeApex} AP3X
**Type:** ${proposalType}
**Priority:** ${priority}
**Storage:** ${storageUri}
**Script Address:** ${proposalSpendAddress}

The proposal datum is now locked at the governance script address.

[View on Explorer](${explorerTxLink(lockTxHash)})

**Note:** This is a lock-only submission. Full validated submission with
proposal token minting requires the multi-validator flow (coming soon).`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to submit proposal: ${err.message}

**Troubleshooting Tips:**
1. Ensure wallet has at least ${stakeApex + 5} AP3X (stake + fees)
2. For Emergency proposals, your agent needs Established reputation (100+ AP3X staked in Game 3)
3. proposalHash must be 64 hex characters (blake2b_256 of your proposal document)
4. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );

  // ─── vector_governance_critique ─────────────────────────────────────────

  server.tool(
    "vector_governance_critique",
    "Submit a critique on a governance proposal. Critiques can support, oppose, or propose amendments. Requires staking AP3X.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the wallet"),
      agentDid: z.string().describe("Agent DID (hex)"),
      proposalTxHash: z.string().describe("TX hash of the proposal UTxO to critique"),
      proposalOutputIndex: z.number().default(0).describe("Output index of the proposal UTxO"),
      critiqueHash: z.string().describe("blake2b_256 hash of critique document (64 hex chars)"),
      critiqueType: z.enum(["Supportive", "Opposing", "Amendment"]).describe("Type of critique"),
      storageUri: z.string().describe("Off-chain storage URI for the critique document"),
      stakeApex: z.number().min(10).describe("AP3X to stake (minimum 10)"),
    },
    async ({ mnemonic, agentDid, proposalTxHash, proposalOutputIndex, critiqueHash, critiqueType, storageUri, stakeApex }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;

      const stakeLovelace = stakeApex * 1_000_000;
      const safetyCheck = safetyLayer.checkTransaction(stakeLovelace + 2_000_000);
      if (!safetyCheck.allowed) {
        return { content: [{ type: "text", text: `Safety limit exceeded: ${safetyCheck.reason}` }] };
      }

      try {
        if (critiqueHash.length !== 64) throw new Error('critiqueHash must be 64 hex characters');

        const provider = newProvider();
        const lucid = await Lucid(provider, 'Mainnet');
        lucid.selectWallet.fromSeed(mnemonic.trim());
        const walletAddress = await lucid.wallet().address();

        // Build CritiqueType datum
        let critiqueTypeDatum;
        switch (critiqueType) {
          case 'Supportive': critiqueTypeDatum = new Constr(0, []); break;
          case 'Opposing': critiqueTypeDatum = new Constr(1, []); break;
          case 'Amendment': critiqueTypeDatum = new Constr(2, [critiqueHash]); break;
        }

        const tip = await provider.getNetworkTip?.() || { slot: 0 };
        const currentSlot = tip.slot || 0;

        const walletAddr = await lucid.wallet().address();
        const addrDetails = getAddressDetails(walletAddr);
        const vkeyHash = addrDetails.paymentCredential?.hash || '';

        // Build CritiqueDatum
        const critiqueDatum = Data.to(new Constr(0, [
          agentDid,                                                    // critic_did
          new Constr(0, [vkeyHash]),                                  // critic_credential
          new Constr(0, [proposalTxHash, BigInt(proposalOutputIndex)]), // proposal_ref
          critiqueHash,                                                // critique_hash
          fromText(storageUri),                                       // storage_uri
          critiqueTypeDatum,                                          // critique_type
          BigInt(stakeLovelace),                                      // stake_amount
          BigInt(currentSlot),                                        // submitted_at
          new Constr(0, []),                                          // incorporated = False
        ]));

        const critiqueSpendAddress = credentialToAddress('Mainnet', { type: 'Script', hash: GOV_CRITIQUE_SPEND_HASH });

        const tx = await lucid.newTx()
          .pay.ToAddressWithData(
            critiqueSpendAddress,
            { kind: "inline", value: critiqueDatum },
            { lovelace: BigInt(stakeLovelace + 2_000_000) }
          )
          .complete();

        const signedTx = await tx.sign.withWallet().complete();
        const txHash = await signedTx.submit();

        safetyLayer.recordTransaction(txHash, stakeLovelace + 2_000_000, critiqueSpendAddress);

        return {
          content: [{
            type: "text",
            text: `# Critique Submitted

**Transaction:** ${txHash}
**Type:** ${critiqueType}
**Stake:** ${stakeApex} AP3X
**Proposal:** ${proposalTxHash}#${proposalOutputIndex}
**Storage:** ${storageUri}

[View on Explorer](${explorerTxLink(txHash)})`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to submit critique: ${err.message}

**Troubleshooting Tips:**
1. Ensure wallet has at least ${stakeApex + 3} AP3X
2. Verify the proposal UTxO exists (use vector_governance_browse)
3. critiqueHash must be 64 hex characters (blake2b_256)`,
          }],
        };
      }
    }
  );

  // ─── vector_governance_endorse ──────────────────────────────────────────

  server.tool(
    "vector_governance_endorse",
    "Endorse a governance proposal by staking AP3X. Endorsements signal support to the Foundation Council and are weighted by stake amount.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the wallet"),
      agentDid: z.string().describe("Agent DID (hex)"),
      proposalTxHash: z.string().describe("TX hash of the proposal UTxO to endorse"),
      proposalOutputIndex: z.number().default(0).describe("Output index of the proposal UTxO"),
      stakeApex: z.number().min(5).describe("AP3X to stake as endorsement (minimum 5)"),
    },
    async ({ mnemonic, agentDid, proposalTxHash, proposalOutputIndex, stakeApex }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;

      const stakeLovelace = stakeApex * 1_000_000;
      const safetyCheck = safetyLayer.checkTransaction(stakeLovelace + 2_000_000);
      if (!safetyCheck.allowed) {
        return { content: [{ type: "text", text: `Safety limit exceeded: ${safetyCheck.reason}` }] };
      }

      try {
        const provider = newProvider();
        const lucid = await Lucid(provider, 'Mainnet');
        lucid.selectWallet.fromSeed(mnemonic.trim());

        const walletAddr = await lucid.wallet().address();
        const addrDetails = getAddressDetails(walletAddr);
        const vkeyHash = addrDetails.paymentCredential?.hash || '';

        const tip = await provider.getNetworkTip?.() || { slot: 0 };
        const currentSlot = tip.slot || 0;

        // Build GovernanceEndorsementDatum
        const endorsementDatum = Data.to(new Constr(0, [
          agentDid,                                                     // endorser_did
          new Constr(0, [vkeyHash]),                                   // endorser_credential
          new Constr(0, [proposalTxHash, BigInt(proposalOutputIndex)]), // proposal_ref
          BigInt(stakeLovelace),                                       // stake_amount
          BigInt(currentSlot),                                         // created_at
        ]));

        const endorsementSpendAddress = credentialToAddress('Mainnet', { type: 'Script', hash: GOV_ENDORSEMENT_SPEND_HASH });

        const tx = await lucid.newTx()
          .pay.ToAddressWithData(
            endorsementSpendAddress,
            { kind: "inline", value: endorsementDatum },
            { lovelace: BigInt(stakeLovelace + 2_000_000) }
          )
          .complete();

        const signedTx = await tx.sign.withWallet().complete();
        const txHash = await signedTx.submit();

        safetyLayer.recordTransaction(txHash, stakeLovelace + 2_000_000, endorsementSpendAddress);

        return {
          content: [{
            type: "text",
            text: `# Endorsement Submitted

**Transaction:** ${txHash}
**Stake:** ${stakeApex} AP3X
**Proposal:** ${proposalTxHash}#${proposalOutputIndex}

[View on Explorer](${explorerTxLink(txHash)})`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to submit endorsement: ${err.message}

**Troubleshooting Tips:**
1. Ensure wallet has at least ${stakeApex + 3} AP3X
2. Verify the proposal UTxO exists and is in Open state`,
          }],
        };
      }
    }
  );

  // ─── vector_governance_analyze_metrics ──────────────────────────────────

  server.tool(
    "vector_governance_analyze_metrics",
    "Analyze governance metrics: proposal activity, adoption rate, treasury health, and engagement statistics. Read-only — no mnemonic needed.",
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
        let proposalUtxos = [];
        try {
          const proposalSpendAddress = credentialToAddress('Mainnet', { type: 'Script', hash: GOV_PROPOSAL_SPEND_HASH });
          proposalUtxos = await provider.getUtxos(proposalSpendAddress);
        } catch {
          // Address query may fail if no UTxOs exist
        }

        // Parse proposal datums
        const proposals: any[] = [];
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
              type: "text",
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
            type: "text",
            text: `# Governance Metrics${focus !== 'overview' ? ` (${focus})` : ''}

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
            type: "text",
            text: `Failed to analyze governance metrics: ${err.message}

**Troubleshooting Tips:**
1. Verify Ogmios endpoint is reachable
2. The governance contracts may not be deployed yet`,
          }],
        };
      }
    }
  );
}
