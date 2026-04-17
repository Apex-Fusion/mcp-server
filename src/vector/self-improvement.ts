// @ts-nocheck
// Self-Improvement Module tools: submit proposal, critique, endorse, browse, analyze metrics
// Game 6 of the Vector game theory ecosystem

import { z } from "zod";
import { Lucid, fromText, toText, Data, Constr, credentialToAddress, getAddressDetails, SLOT_CONFIG_NETWORK } from '@lucid-evolution/lucid';

// Vector slot config — resolved from chain via Ogmios queryNetwork/startTime
// Cached after first query so SLOT_CONFIG_NETWORK is set before Lucid needs it
let vectorZeroTime: number | null = null;

async function ensureSlotConfig(provider: OgmiosProvider): Promise<number> {
  if (vectorZeroTime === null) {
    vectorZeroTime = await provider.getSystemStartMs();
    SLOT_CONFIG_NETWORK.Mainnet = { zeroTime: vectorZeroTime, zeroSlot: 0, slotLength: 1000 };
  }
  return vectorZeroTime;
}
import { blake2b } from '@noble/hashes/blake2b';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { OgmiosProvider } from './ogmios-provider.js';
import { safetyLayer } from './safety.js';
import { rateLimiter } from './rate-limiter.js';

// Env config
const VECTOR_OGMIOS_URL = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const VECTOR_SUBMIT_URL = process.env.VECTOR_SUBMIT_URL || 'https://submit.vector.testnet.apexfusion.org/api/submit/tx';
const VECTOR_KOIOS_URL = process.env.VECTOR_KOIOS_URL || 'https://koios.vector.testnet.apexfusion.org/';
const VECTOR_EXPLORER_URL = process.env.VECTOR_EXPLORER_URL || 'https://vector.testnet.apexscan.org';

// Agent Registry policy ID (shared across all modules)
const AGENT_REGISTRY_POLICY = process.env.AGENT_REGISTRY_POLICY || 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01';

// Governance contract hashes (from deploy_state.json)
// These should be set via env vars in production
const GOV_PROPOSAL_SPEND_HASH = process.env.GOV_PROPOSAL_SPEND_HASH || 'f815f51a76002d6a973e83fecf60f45473e040acee85c631fcce134d';
const GOV_PROPOSAL_MINT_HASH = process.env.GOV_PROPOSAL_MINT_HASH || 'e8f38052352a3d20c5fe025e2a02d615826a154b26f2239286b8d565';
const GOV_CRITIQUE_SPEND_HASH = process.env.GOV_CRITIQUE_SPEND_HASH || 'ced52074861af95e2082004d6061b0fc4bb30fded61f9605bfc20e55';
const GOV_CRITIQUE_MINT_HASH = process.env.GOV_CRITIQUE_MINT_HASH || '2e252a89894d379ce5c0023a57de4627056e4a96da72bd8fedba04bd';
const GOV_ENDORSEMENT_SPEND_HASH = process.env.GOV_ENDORSEMENT_SPEND_HASH || '5fc449848d85f30287e5bc0bd2b3e95d872ef97be27f1480c12f1a9d';
const GOV_TREASURY_ADDRESS = process.env.GOV_TREASURY_ADDRESS || 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8';

// Reference script UTxOs (CIP-33) — for validated submit
const GOV_PROPOSAL_SPEND_REF = process.env.GOV_PROPOSAL_SPEND_REF || 'c70a410c9c0c543a0a1103049680b89cbf6fd2277e8469c4d52632dc52b80996#0';
const GOV_PROPOSAL_MINT_REF = process.env.GOV_PROPOSAL_MINT_REF || 'c40b64fff5c4056689354076aa3d06431d786a4f8f0c1e492e70261d2309e50a#0';

// Infrastructure UTxOs (governance reference inputs)
const GOV_PARAMS_UTXO = process.env.GOV_PARAMS_UTXO || '2c082e833649175b4a543a5a0cf61f9b736acdfa0d315d1184645185e9a52796#0';
const GOV_ORACLE_UTXO = process.env.GOV_ORACLE_UTXO || '7a23dfdf9468dd35cee3cad03008f2538c86834d4e5140e0ffaf2ff93e7c04a7#0';
const GOV_CROSSREFS_UTXO = process.env.GOV_CROSSREFS_UTXO || '96a4acff8be0fb96b3839ee6c9c1fa75809b94f4967218eaf813ac56b939c4b2#0';

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

// ─── Validated Submit Helpers ─────────────────────────────────────────────────

function parseUtxoRef(ref: string): { txHash: string; outputIndex: number } {
  const [txHash, idx] = ref.split('#');
  return { txHash, outputIndex: parseInt(idx) };
}

async function waitForTx(provider: any, txHash: string, maxAttempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const utxos = await provider.getUtxosByOutRef([{ txHash, outputIndex: 0 }]);
      if (utxos && utxos.length > 0) return;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`TX ${txHash} not confirmed after ${maxAttempts * delayMs / 1000}s`);
}

// ─── Filebase IPFS Upload ────────────────────────────────────────────────────

const FILEBASE_ACCESS_KEY = process.env.FILEBASE_ACCESS_KEY || '';
const FILEBASE_SECRET_KEY = process.env.FILEBASE_SECRET_KEY || '';
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET || '';

async function uploadToFilebase(document: string, namePrefix: string): Promise<{ cid: string; hash: string }> {
  if (!FILEBASE_ACCESS_KEY || !FILEBASE_SECRET_KEY || !FILEBASE_BUCKET) {
    throw new Error('Filebase not configured. Set FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY, and FILEBASE_BUCKET env vars.');
  }

  // Canonical JSON: parse then re-stringify for deterministic bytes
  const parsed = JSON.parse(document);
  const canonical = JSON.stringify(parsed);
  const docBytes = new TextEncoder().encode(canonical);

  // blake2b_256 hash
  const hashBytes = blake2b(docBytes, { dkLen: 32 });
  const hashHex = Buffer.from(hashBytes).toString('hex');

  const key = `${namePrefix}-${hashHex.slice(0, 16)}.json`;

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'https://s3.filebase.com',
    credentials: { accessKeyId: FILEBASE_ACCESS_KEY, secretAccessKey: FILEBASE_SECRET_KEY },
    forcePathStyle: true,
  });

  const resp = await s3.send(new PutObjectCommand({
    Bucket: FILEBASE_BUCKET,
    Key: key,
    Body: canonical,
    ContentType: 'application/json',
  }));

  // Filebase returns the CID in response metadata
  const cid = resp.$metadata?.httpStatusCode === 200
    ? (resp as any).VersionId || ''
    : '';

  // If CID not in response, try HeadObject to get it from x-amz-meta-cid
  let finalCid = cid;
  if (!finalCid) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const head = await s3.send(new HeadObjectCommand({ Bucket: FILEBASE_BUCKET, Key: key }));
    finalCid = head.Metadata?.cid || '';
  }

  if (!finalCid) {
    throw new Error('Filebase upload succeeded but CID not returned. Check bucket is IPFS-enabled.');
  }

  return { cid: finalCid, hash: hashHex };
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

export function registerSelfImprovementTools(server) {

  // ─── vector_self_improvement_browse (read-only) ───────────────────────────────

  server.tool(
    "vector_self_improvement_browse",
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

  // ─── vector_self_improvement_submit_proposal ──────────────────────────────────

  server.tool(
    "vector_self_improvement_submit_proposal",
    "Submit a governance proposal to the Vector Self-Improvement Module. Requires staking AP3X. Provide proposalDocument (JSON string) for automatic IPFS upload via Filebase and blake2b_256 hashing, OR provide proposalHash and storageUri manually.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the wallet"),
      agentDid: z.string().describe("Agent DID (hex) — the asset name from Agent Registry NFT"),
      proposalDocument: z.string().optional().describe("Full proposal document as JSON string. Uploaded to IPFS via Filebase; hash and CID computed automatically. If provided, proposalHash and storageUri are ignored."),
      proposalHash: z.string().optional().describe("blake2b_256 hash of proposal document (64 hex chars). Required if proposalDocument is not provided."),
      proposalType: z.enum(["ParameterChange", "TreasurySpend", "ProtocolUpgrade", "GameActivation", "GeneralSuggestion"]).describe("Category of the proposal"),
      storageUri: z.string().optional().describe("Off-chain storage URI for the full proposal (IPFS CID or OriginTrail UAL). Required if proposalDocument is not provided."),
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
    async ({ mnemonic, agentDid, proposalDocument, proposalHash, proposalType, storageUri, stakeApex, typeParams, priority }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;

      const stakeLovelace = stakeApex * 1_000_000;
      const safetyCheck = safetyLayer.checkTransaction(stakeLovelace + 4_000_000);
      if (!safetyCheck.allowed) {
        return { content: [{ type: "text", text: `Safety limit exceeded: ${safetyCheck.reason}. Check limits with vector_get_spend_limits.` }] };
      }

      try {
        // IPFS upload: if proposalDocument provided, upload to Filebase and derive hash + URI
        let finalHash = proposalHash;
        let finalUri = storageUri;
        let ipfsCid = '';

        if (proposalDocument) {
          const uploaded = await uploadToFilebase(proposalDocument, 'proposal');
          finalHash = uploaded.hash;
          finalUri = `ipfs://${uploaded.cid}`;
          ipfsCid = uploaded.cid;
        }

        if (!finalHash || finalHash.length !== 64) throw new Error('proposalHash must be 64 hex characters (32 bytes). Provide proposalDocument for auto-hashing or proposalHash manually.');
        if (!finalUri) throw new Error('storageUri is required. Provide proposalDocument for auto-upload or storageUri manually.');

        const provider = newProvider();
        const zeroTime = await ensureSlotConfig(provider);
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

        // Get current POSIX time for datum (Plutus validity range uses POSIX ms, not slots)
        const tip = await provider.getNetworkTip?.() || { slot: 0 };
        const currentSlot = zeroTime + (tip.slot || 0) * 1000; // POSIX ms

        // Priority datum
        const priorityDatum = priority === 'Emergency' ? new Constr(1, []) : new Constr(0, []);

        // Build ProposalDatum
        const walletAddr = await lucid.wallet().address();
        const addrDetails = getAddressDetails(walletAddr);
        const vkeyHash = addrDetails.paymentCredential?.hash || '';

        const proposalDatum = Data.to(new Constr(0, [
          agentDid,                          // proposer_did
          new Constr(0, [vkeyHash]),         // proposer_credential (VerificationKey)
          finalHash,                            // proposal_hash
          typeDatum,                          // proposal_type
          fromText(finalUri),                // storage_uri
          BigInt(stakeLovelace),             // stake_amount
          BigInt(currentSlot),               // submitted_at
          BigInt(604_800_000),               // review_window (~7 days in ms)
          priorityDatum,                     // priority
          0n,                                 // amendment_count
          [],                                 // incorporated_critiques
          new Constr(0, []),                 // state = Open
        ]));

        // === Step 1: Lock ProposalDatum at proposal_spend address ===
        const proposalSpendAddress = credentialToAddress('Mainnet', { type: 'Script', hash: GOV_PROPOSAL_SPEND_HASH });

        const lockTx = await lucid.newTx()
          .pay.ToAddressWithData(
            proposalSpendAddress,
            { kind: "inline", value: proposalDatum },
            { lovelace: BigInt(stakeLovelace + 2_000_000) }
          )
          .complete({ localUPLCEval: false });

        const signedLockTx = await lockTx.sign.withWallet().complete();
        const lockTxHash = await signedLockTx.submit();

        // === Step 2: Spend + Mint (validated submit) ===
        await waitForTx(provider, lockTxHash);

        // Derive token names
        const propTokenName = deriveProposalTokenName(lockTxHash, 0);
        const actTokenName = deriveActivityTokenName(agentDid);
        const propTokenUnit = GOV_PROPOSAL_MINT_HASH + propTokenName;
        const actTokenUnit = GOV_PROPOSAL_MINT_HASH + actTokenName;

        // Get current slot and derive POSIX times for validity range
        // The validator checks: activity.last_proposal_slot == tx_validity_lower_bound
        const tip2 = await provider.getNetworkTip();
        const spendSlot = tip2.slot;
        const validFromMs = zeroTime + spendSlot * 1000;
        const validToMs = validFromMs + 360_000;  // 6 minutes from spendSlot

        // Activity datum (first proposal: count=1)
        // TODO: For subsequent proposals, find existing pact_ UTxO and increment count
        const activityDatum = Data.to(new Constr(0, [
          agentDid,                          // agent_did
          new Constr(0, [vkeyHash]),         // agent_credential
          1n,                                 // active_proposal_count
          BigInt(validFromMs),                 // last_proposal_slot (POSIX ms, matches tx validity lower bound)
        ]));

        // Redeemer: SubmitProposal = Constructor 0
        const submitRedeemer = Data.to(new Constr(0, []));

        // Get the locked UTxO
        const lockedUtxos = await lucid.utxosByOutRef([{ txHash: lockTxHash, outputIndex: 0 }]);
        if (!lockedUtxos.length) throw new Error('Locked UTxO not found after confirmation');

        // Get reference script UTxOs (CIP-33)
        const refScriptUtxos = await lucid.utxosByOutRef([
          parseUtxoRef(GOV_PROPOSAL_SPEND_REF),
          parseUtxoRef(GOV_PROPOSAL_MINT_REF),
        ]);

        // Validate reference scripts are available (they can be accidentally consumed)
        if (refScriptUtxos.length < 2) {
          throw new Error(
            `Reference script UTxOs missing: found ${refScriptUtxos.length}/2. ` +
            `spend_ref=${GOV_PROPOSAL_SPEND_REF}, mint_ref=${GOV_PROPOSAL_MINT_REF}. ` +
            `These UTxOs may have been consumed — redeploy with scripts/redeploy_ref_scripts.py ` +
            `and update GOV_PROPOSAL_SPEND_REF / GOV_PROPOSAL_MINT_REF env vars.`
          );
        }
        const missingScriptRef = refScriptUtxos.filter(u => !u.scriptRef);
        if (missingScriptRef.length > 0) {
          throw new Error(
            `Reference script UTxOs found but missing scriptRef field for ${missingScriptRef.length} UTxO(s). ` +
            `The UTxOs at ${missingScriptRef.map(u => u.txHash).join(', ')} exist but don't contain scripts. ` +
            `Redeploy reference scripts and update env vars.`
          );
        }

        // Get governance infrastructure reference inputs
        const govRefUtxos = await lucid.utxosByOutRef([
          parseUtxoRef(GOV_PARAMS_UTXO),
          parseUtxoRef(GOV_ORACLE_UTXO),
          parseUtxoRef(GOV_CROSSREFS_UTXO),
        ]);

        // Find agent's registry NFT UTxO for DID validation (CIP-31 reference input)
        // The NFT lives at the registry script address (locked with deposit), not the wallet
        const nftUnit = AGENT_REGISTRY_POLICY + agentDid;
        let nftUtxo;
        try {
          nftUtxo = await provider.getUtxoByUnit(nftUnit);
        } catch {
          throw new Error(
            `Agent registry NFT not found on-chain. Expected token: ${AGENT_REGISTRY_POLICY.slice(0, 12)}...${agentDid.slice(0, 12)}... ` +
            `The agent may need to re-register with vector_register_agent.`
          );
        }

        // Build Step 2 transaction: spend locked UTxO + mint tokens
        const spendTx = await lucid.newTx()
          .collectFrom(lockedUtxos, submitRedeemer)
          .readFrom(refScriptUtxos)
          .readFrom(govRefUtxos)
          .readFrom([nftUtxo])
          .mintAssets(
            { [propTokenUnit]: 1n, [actTokenUnit]: 1n },
            submitRedeemer
          )
          .pay.ToAddressWithData(
            proposalSpendAddress,
            { kind: "inline", value: proposalDatum },
            { lovelace: BigInt(stakeLovelace + 2_000_000), [propTokenUnit]: 1n }
          )
          .pay.ToAddressWithData(
            proposalSpendAddress,
            { kind: "inline", value: activityDatum },
            { lovelace: 2_000_000n, [actTokenUnit]: 1n }
          )
          .addSigner(walletAddr)
          .validFrom(validFromMs)
          .validTo(validToMs)
          .complete({ localUPLCEval: false });

        const signedSpendTx = await spendTx.sign.withWallet().complete();
        const spendTxHash = await signedSpendTx.submit();

        safetyLayer.recordTransaction(spendTxHash, stakeLovelace + 4_000_000, proposalSpendAddress);

        return {
          content: [{
            type: "text",
            text: `# Proposal Submitted (Validated)

**Proposal TX (use this for critiques/endorsements):** ${spendTxHash}
**Stake:** ${stakeApex} AP3X
**Type:** ${proposalType}
**Priority:** ${priority}
**Storage:** ${finalUri}
**Proposal Token:** ${propTokenName}
**Activity Token:** ${actTokenName}
**Script Address:** ${proposalSpendAddress}
${ipfsCid ? `**IPFS CID:** ${ipfsCid}\n**Hash (auto-computed):** ${finalHash}` : ''}

Proposal submitted with on-chain validation. Proposal token (\`prop_\`) and
activity tracking token (\`pact_\`) minted. Visible on the Foundation dashboard.

> **Note:** When submitting critiques or endorsements, use the Proposal TX hash above as the \`proposalTxHash\`.

[View on Explorer](${explorerTxLink(spendTxHash)})`,
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

  // ─── vector_self_improvement_critique ─────────────────────────────────────────

  server.tool(
    "vector_self_improvement_critique",
    "Submit a critique on a governance proposal. Critiques can support, oppose, or propose amendments. Requires staking AP3X. Provide critiqueDocument (JSON string) for automatic IPFS upload, or critiqueHash + storageUri manually.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the wallet"),
      agentDid: z.string().describe("Agent DID (hex)"),
      proposalTxHash: z.string().describe("TX hash of the proposal UTxO to critique"),
      proposalOutputIndex: z.number().default(0).describe("Output index of the proposal UTxO"),
      critiqueDocument: z.string().optional().describe("Full critique document as JSON string. Uploaded to IPFS via Filebase; hash and CID computed automatically."),
      critiqueHash: z.string().optional().describe("blake2b_256 hash of critique document (64 hex chars). Required if critiqueDocument is not provided."),
      critiqueType: z.enum(["Supportive", "Opposing", "Amendment"]).describe("Type of critique"),
      storageUri: z.string().optional().describe("Off-chain storage URI for the critique document. Required if critiqueDocument is not provided."),
      stakeApex: z.number().min(10).describe("AP3X to stake (minimum 10)"),
    },
    async ({ mnemonic, agentDid, proposalTxHash, proposalOutputIndex, critiqueDocument, critiqueHash, critiqueType, storageUri, stakeApex }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;

      const stakeLovelace = stakeApex * 1_000_000;
      const safetyCheck = safetyLayer.checkTransaction(stakeLovelace + 2_000_000);
      if (!safetyCheck.allowed) {
        return { content: [{ type: "text", text: `Safety limit exceeded: ${safetyCheck.reason}` }] };
      }

      try {
        // IPFS upload: if critiqueDocument provided, upload to Filebase
        let finalHash = critiqueHash;
        let finalUri = storageUri;
        let ipfsCid = '';

        if (critiqueDocument) {
          const uploaded = await uploadToFilebase(critiqueDocument, 'critique');
          finalHash = uploaded.hash;
          finalUri = `ipfs://${uploaded.cid}`;
          ipfsCid = uploaded.cid;
        }

        if (!finalHash || finalHash.length !== 64) throw new Error('critiqueHash must be 64 hex characters. Provide critiqueDocument or critiqueHash manually.');
        if (!finalUri) throw new Error('storageUri is required. Provide critiqueDocument or storageUri manually.');

        const provider = newProvider();
        await ensureSlotConfig(provider);
        const lucid = await Lucid(provider, 'Mainnet');
        lucid.selectWallet.fromSeed(mnemonic.trim());
        const walletAddress = await lucid.wallet().address();

        // Build CritiqueType datum
        let critiqueTypeDatum;
        switch (critiqueType) {
          case 'Supportive': critiqueTypeDatum = new Constr(0, []); break;
          case 'Opposing': critiqueTypeDatum = new Constr(1, []); break;
          case 'Amendment': critiqueTypeDatum = new Constr(2, [finalHash]); break;
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
          finalHash,                                                   // critique_hash
          fromText(finalUri),                                         // storage_uri
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
          .complete({ localUPLCEval: false });

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
**Storage:** ${finalUri}
${ipfsCid ? `**IPFS CID:** ${ipfsCid}\n**Hash (auto-computed):** ${finalHash}` : ''}

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
2. Verify the proposal UTxO exists (use vector_self_improvement_browse)
3. critiqueHash must be 64 hex characters (blake2b_256)`,
          }],
        };
      }
    }
  );

  // ─── vector_self_improvement_endorse ──────────────────────────────────────────

  server.tool(
    "vector_self_improvement_endorse",
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
        await ensureSlotConfig(provider);
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
          .complete({ localUPLCEval: false });

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

  // ─── vector_self_improvement_analyze_metrics ──────────────────────────────────

  server.tool(
    "vector_self_improvement_analyze_metrics",
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
