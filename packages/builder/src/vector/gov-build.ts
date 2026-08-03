// Keyless build core for the self-improvement family (spec PR 8).
// Constructs UNSIGNED transactions only. The user's key never enters this
// package: signing happens on the local signer (packages/signer), submission
// via vector_submit_transaction. Constants, datum parsers, token-name
// derivation, and helpers here are transcribed from the (still custodial,
// pending Task 5) packages/builder/src/vector/self-improvement.ts, typed and
// with instanceof Constr guards added to the parsers - datum field indices
// and Data.to/Constr layouts are otherwise unchanged, since the deployed
// module validators parse these exact bytes.
import {
  fromText, toText, Data, Constr, credentialToAddress, getAddressDetails, SLOT_CONFIG_NETWORK,
} from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { apexToLovelace } from '@apexfusion/vector-mcp-shared/tx';
import type {
  VectorBuildStakeResult, VectorBuildProposalLockResult, VectorBuildProposalSpendResult,
} from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { getRegistryAddress } from './registry-build.js';

// ─── Module constants (env-overridable exactly as the custodial module) ────

// Agent Registry policy ID - this module's own copy (self-improvement.ts has
// always declared this independently of registry-build.ts's REGISTRY_POLICY_ID;
// preserved as-is, not unified, since that's a separate, out-of-scope change).
export const AGENT_REGISTRY_POLICY = process.env.AGENT_REGISTRY_POLICY || 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01';

// Module contract hashes (from deploy_state.json). GOV_* names are pre-existing
// deployed config keys - kept as-is (renaming them is a separate, out-of-scope
// change; see the PR body's env-var exemption note).
export const GOV_PROPOSAL_SPEND_HASH = process.env.GOV_PROPOSAL_SPEND_HASH || 'f815f51a76002d6a973e83fecf60f45473e040acee85c631fcce134d';
export const GOV_PROPOSAL_MINT_HASH = process.env.GOV_PROPOSAL_MINT_HASH || 'e8f38052352a3d20c5fe025e2a02d615826a154b26f2239286b8d565';
export const GOV_CRITIQUE_SPEND_HASH = process.env.GOV_CRITIQUE_SPEND_HASH || 'ced52074861af95e2082004d6061b0fc4bb30fded61f9605bfc20e55';
export const GOV_CRITIQUE_MINT_HASH = process.env.GOV_CRITIQUE_MINT_HASH || '2e252a89894d379ce5c0023a57de4627056e4a96da72bd8fedba04bd';
export const GOV_ENDORSEMENT_SPEND_HASH = process.env.GOV_ENDORSEMENT_SPEND_HASH || '5fc449848d85f30287e5bc0bd2b3e95d872ef97be27f1480c12f1a9d';
export const GOV_TREASURY_ADDRESS = process.env.GOV_TREASURY_ADDRESS || 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8';

// Reference script UTxOs (CIP-33) - for the validated proposal spend+mint (Task 4).
export const GOV_PROPOSAL_SPEND_REF = process.env.GOV_PROPOSAL_SPEND_REF || 'c70a410c9c0c543a0a1103049680b89cbf6fd2277e8469c4d52632dc52b80996#0';
export const GOV_PROPOSAL_MINT_REF = process.env.GOV_PROPOSAL_MINT_REF || 'c40b64fff5c4056689354076aa3d06431d786a4f8f0c1e492e70261d2309e50a#0';

// Infrastructure UTxOs (module reference inputs).
export const GOV_PARAMS_UTXO = process.env.GOV_PARAMS_UTXO || '2c082e833649175b4a543a5a0cf61f9b736acdfa0d315d1184645185e9a52796#0';
export const GOV_ORACLE_UTXO = process.env.GOV_ORACLE_UTXO || '7a23dfdf9468dd35cee3cad03008f2538c86834d4e5140e0ffaf2ff93e7c04a7#0';
export const GOV_CROSSREFS_UTXO = process.env.GOV_CROSSREFS_UTXO || '96a4acff8be0fb96b3839ee6c9c1fa75809b94f4967218eaf813ac56b939c4b2#0';

// Proposal state CBOR constructor tags.
export const STATE_NAMES: Record<number, string> = {
  0: 'Open',
  1: 'Amended',
  2: 'Adopted',
  3: 'Rejected',
  4: 'Expired',
  5: 'Withdrawn',
};

export const TYPE_NAMES: Record<number, string> = {
  0: 'ParameterChange',
  1: 'TreasurySpend',
  2: 'ProtocolUpgrade',
  3: 'GameActivation',
  4: 'GeneralSuggestion',
};

export const PRIORITY_NAMES: Record<number, string> = {
  0: 'Standard',
  1: 'Emergency',
};

export const CRITIQUE_TYPE_NAMES: Record<number, string> = {
  0: 'Supportive',
  1: 'Opposing',
  2: 'Amendment',
};

// Wire-level stake minimums (mirrored in the future tool schemas, Task 5) -
// enforced here too so a direct caller of buildCritique/buildEndorse cannot
// bypass them.
export const MIN_CRITIQUE_STAKE_APEX = 10;
export const MIN_ENDORSE_STAKE_APEX = 5;
export const MIN_PROPOSAL_STAKE_APEX = 25;

// ─── Slot/time config ───────────────────────────────────────────────────────

// Minimal provider surface needed for slot/time queries. OgmiosProvider
// satisfies this at runtime; the base Lucid `Provider` interface does not
// declare either method (they are OgmiosProvider-specific additions), so
// build functions that only take a `lucid` recover this surface via
// slotClockOf() below rather than taking a redundant provider parameter.
export interface SlotClockProvider {
  getSystemStartMs(): Promise<number>;
  getNetworkTip?(): Promise<{ slot: number; hash?: string }>;
}

// Recovers the provider a LucidEvolution instance was built with (Lucid()'s
// own config closure returns the exact same reference it was constructed
// with - see @lucid-evolution/lucid's Lucid() factory). Lets build functions
// that only take `lucid` still reach slot/tip queries: callers (including
// offline tests) supply the extended provider once, at lucidForAddress() time.
export function slotClockOf(lucid: LucidEvolution): SlotClockProvider {
  const provider = lucid.config().provider;
  if (!provider) throw new Error('Lucid instance has no provider configured - build it via lucidForAddress first.');
  return provider as unknown as SlotClockProvider;
}

// Vector slot config - resolved from chain via Ogmios queryNetwork/startTime.
// Cached after first query so SLOT_CONFIG_NETWORK is set before Lucid needs
// it. Module-global cache, same as the custodial original: callers (tests
// included) must use a consistent zeroTime across calls in one process.
let vectorZeroTime: number | null = null;

export async function ensureSlotConfig(provider: Pick<SlotClockProvider, 'getSystemStartMs'>): Promise<number> {
  if (vectorZeroTime === null) {
    vectorZeroTime = await provider.getSystemStartMs();
    SLOT_CONFIG_NETWORK.Mainnet = { zeroTime: vectorZeroTime, zeroSlot: 0, slotLength: 1000 };
  }
  return vectorZeroTime;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

export function lovelaceToApex(lovelace: number | bigint): string {
  return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
}

export function scriptHashToAddress(hash: string): string {
  return credentialToAddress('Mainnet', { type: 'Script', hash });
}

export function parseUtxoRef(ref: string): { txHash: string; outputIndex: number } {
  const [txHash, idx] = ref.split('#');
  return { txHash, outputIndex: parseInt(idx, 10) };
}

// Address helper local to this family (mirrors registry-build.ts's
// paymentKeyHashOf exactly, kept as an independent copy rather than a
// cross-family import - each build-core file depends only on build.ts, not
// on a sibling family file; see task-3-report.md for the reasoning).
//
// Deliberate exception to that rule (Task 4): buildProposalSpend below DOES
// import getRegistryAddress from registry-build.ts - the self-improvement
// family's NFT-resolution fallback needs the registry's own script address
// to scan, and that address is derived from registry-build.ts's own
// REGISTRY_SCRIPT_CBOR constant, not something this file could reasonably
// duplicate without risking the two copies drifting apart. One-directional
// (gov-build.ts -> registry-build.ts only, never the reverse), so it does
// not introduce a cycle.
export function paymentKeyHashOf(address: string): string {
  let details;
  try {
    details = getAddressDetails(address);
  } catch (e) {
    throw new Error(`Invalid address: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (details.paymentCredential?.type !== 'Key' || !details.paymentCredential.hash) {
    throw new Error('Address must have a verification key payment credential, not a script credential.');
  }
  return details.paymentCredential.hash;
}

// Derive token name: prefix + blake2b_256(CBOR(data))[0..27]
export function deriveTokenName(prefix: string, cborHex: string): string {
  const hashBytes = blake2b(Buffer.from(cborHex, 'hex'), { dkLen: 32 });
  const prefixHex = Buffer.from(prefix, 'utf-8').toString('hex');
  const hashSlice = Buffer.from(hashBytes).toString('hex').slice(0, 54); // 27 bytes = 54 hex chars
  return prefixHex + hashSlice;
}

// AS-IS, audit-#10-verified: this flat Constr(0, [txHash, idx]) through
// Lucid's own Data.to (indefinite-length CBOR arrays) reproduces the token
// name actually minted by the deployed bytecode - see
// packages/builder/test/gov-build.test.ts's golden-pin test and
// packages/builder/test/fixtures/gov-state.fixture.json's goldenTokenPin,
// both captured live 2026-07-30. Do not "fix" the encoding.
export function deriveProposalTokenName(txHash: string, outputIndex: number): string {
  const outRefCbor = Data.to(new Constr(0, [txHash, BigInt(outputIndex)]));
  return deriveTokenName('prop_', outRefCbor);
}

export function deriveActivityTokenName(agentDid: string): string {
  const didBytes = Buffer.from(agentDid, 'hex');
  const hashBytes = blake2b(didBytes, { dkLen: 32 });
  const prefixHex = Buffer.from('pact_', 'utf-8').toString('hex');
  const hashSlice = Buffer.from(hashBytes).toString('hex').slice(0, 54);
  return prefixHex + hashSlice;
}

// ─── Filebase IPFS upload ────────────────────────────────────────────────────

const FILEBASE_ACCESS_KEY = process.env.FILEBASE_ACCESS_KEY || '';
const FILEBASE_SECRET_KEY = process.env.FILEBASE_SECRET_KEY || '';
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET || '';

// A network side effect that lives in the hosted builder by design (moved
// verbatim from the custodial module): no wallet key material ever enters
// this function, it only ever sees the already-resolved document text.
export async function uploadToFilebase(document: string, namePrefix: string): Promise<{ cid: string; hash: string }> {
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
    ? (resp as unknown as { VersionId?: string }).VersionId || ''
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

// ─── Datum parsers ───────────────────────────────────────────────────────────

export interface GovProposal {
  proposerDid: string;
  proposalHash: string;
  proposalType: string;
  storageUri: string;
  stakeAmount: number;
  submittedAt: number;
  reviewWindow: number;
  priority: string;
  amendmentCount: number;
  incorporatedCritiques: number;
  state: string;
}

export interface GovCritique {
  criticDid: string;
  proposalRef: Constr<Data>;
  critiqueHash: string;
  storageUri: string;
  critiqueType: string;
  stakeAmount: number;
  submittedAt: number;
  incorporated: boolean;
}

export interface GovEndorsement {
  endorserDid: string;
  proposalRef: Constr<Data>;
  stakeAmount: number;
  createdAt: number;
}

// Parse ProposalDatum from CBOR. Field indices kept exactly as the custodial
// module (0-11); instanceof Constr guards added around the indexed-Constr
// fields, matching registry-build.ts's parseAgentDatum pattern.
export function parseProposalDatum(datumCbor: string): GovProposal | null {
  try {
    const c = Data.from(datumCbor);
    if (!(c instanceof Constr) || c.fields.length < 12) return null;

    const proposerDid = c.fields[0];
    const proposalHash = c.fields[2];
    const typeField = c.fields[3];
    const priorityField = c.fields[8];
    const stateField = c.fields[11];
    const incorporatedCritiques = c.fields[10];
    if (typeof proposerDid !== 'string' || typeof proposalHash !== 'string') return null;
    if (!(typeField instanceof Constr) || !(priorityField instanceof Constr) || !(stateField instanceof Constr)) return null;

    return {
      proposerDid,
      proposalHash,
      proposalType: TYPE_NAMES[Number(typeField.index)] || 'Unknown',
      storageUri: toText(c.fields[4] as string),
      stakeAmount: Number(c.fields[5]),
      submittedAt: Number(c.fields[6]),
      reviewWindow: Number(c.fields[7]),
      priority: PRIORITY_NAMES[Number(priorityField.index)] || 'Standard',
      amendmentCount: Number(c.fields[9]),
      incorporatedCritiques: Array.isArray(incorporatedCritiques) ? incorporatedCritiques.length : 0,
      state: STATE_NAMES[Number(stateField.index)] || 'Unknown',
    };
  } catch {
    return null;
  }
}

// Parse CritiqueDatum from CBOR. Field indices kept exactly as the custodial
// module (0-8).
export function parseCritiqueDatum(datumCbor: string): GovCritique | null {
  try {
    const c = Data.from(datumCbor);
    if (!(c instanceof Constr) || c.fields.length < 9) return null;

    const criticDid = c.fields[0];
    const proposalRef = c.fields[2];
    const critiqueHash = c.fields[3];
    const critiqueTypeField = c.fields[5];
    const incorporatedField = c.fields[8];
    if (typeof criticDid !== 'string' || typeof critiqueHash !== 'string') return null;
    if (!(proposalRef instanceof Constr) || !(critiqueTypeField instanceof Constr) || !(incorporatedField instanceof Constr)) return null;

    return {
      criticDid,
      proposalRef,
      critiqueHash,
      storageUri: toText(c.fields[4] as string),
      critiqueType: CRITIQUE_TYPE_NAMES[Number(critiqueTypeField.index)] || 'Unknown',
      stakeAmount: Number(c.fields[6]),
      submittedAt: Number(c.fields[7]),
      incorporated: Number(incorporatedField.index) === 1,
    };
  } catch {
    return null;
  }
}

// Parse EndorsementDatum from CBOR. Field indices kept exactly as the
// custodial module (0-4).
export function parseEndorsementDatum(datumCbor: string): GovEndorsement | null {
  try {
    const c = Data.from(datumCbor);
    if (!(c instanceof Constr) || c.fields.length < 5) return null;

    const endorserDid = c.fields[0];
    const proposalRef = c.fields[2];
    if (typeof endorserDid !== 'string') return null;
    if (!(proposalRef instanceof Constr)) return null;

    return {
      endorserDid,
      proposalRef,
      stakeAmount: Number(c.fields[3]),
      createdAt: Number(c.fields[4]),
    };
  } catch {
    return null;
  }
}

// ─── Build: critique ─────────────────────────────────────────────────────────

export async function buildCritique(lucid: LucidEvolution, p: {
  agentDid: string;
  proposalTxHash: string;
  proposalOutputIndex: number;
  critiqueType: 'Supportive' | 'Opposing' | 'Amendment';
  stakeApex: number;
  critiqueDocument?: string;
  critiqueHash?: string;
  storageUri?: string;
}): Promise<VectorBuildStakeResult> {
  const changeAddress = await lucid.wallet().address();

  // Validation order: stake minimum -> document/hash resolution (Filebase
  // upload if a document was given) -> datum build -> lock build.
  if (!(p.stakeApex >= MIN_CRITIQUE_STAKE_APEX)) {
    throw new Error(`Critique stake must be at least ${MIN_CRITIQUE_STAKE_APEX} AP3X.`);
  }
  const stakeLovelace = apexToLovelace(p.stakeApex);

  let finalHash = p.critiqueHash;
  let finalUri = p.storageUri;
  let ipfsCid: string | undefined;
  let documentHash: string | undefined;

  if (p.critiqueDocument) {
    const uploaded = await uploadToFilebase(p.critiqueDocument, 'critique');
    finalHash = uploaded.hash;
    finalUri = `ipfs://${uploaded.cid}`;
    ipfsCid = uploaded.cid;
    documentHash = uploaded.hash;
  }

  if (!finalHash || finalHash.length !== 64) {
    throw new Error('critiqueHash must be 64 hex characters (32 bytes). Provide critiqueDocument for automatic hashing or critiqueHash manually.');
  }
  if (!finalUri) {
    throw new Error('storageUri is required. Provide critiqueDocument for automatic upload or storageUri manually.');
  }

  const vkeyHash = paymentKeyHashOf(changeAddress);

  let critiqueTypeDatum: Constr<Data>;
  switch (p.critiqueType) {
    case 'Supportive': critiqueTypeDatum = new Constr(0, []); break;
    case 'Opposing': critiqueTypeDatum = new Constr(1, []); break;
    case 'Amendment': critiqueTypeDatum = new Constr(2, [finalHash]); break;
    default: {
      const exhaustive: never = p.critiqueType;
      throw new Error(`Unknown critiqueType: ${String(exhaustive)}`);
    }
  }

  const provider = slotClockOf(lucid);
  await ensureSlotConfig(provider);
  const tip = (await provider.getNetworkTip?.()) ?? { slot: 0 };
  const currentSlot = tip.slot || 0;

  const critiqueDatum = Data.to(new Constr(0, [
    p.agentDid,                                                          // critic_did
    new Constr(0, [vkeyHash]),                                           // critic_credential
    new Constr(0, [p.proposalTxHash, BigInt(p.proposalOutputIndex)]),    // proposal_ref
    finalHash,                                                           // critique_hash
    fromText(finalUri),                                                  // storage_uri
    critiqueTypeDatum,                                                   // critique_type
    stakeLovelace,                                                       // stake_amount
    BigInt(currentSlot),                                                 // submitted_at
    new Constr(0, []),                                                   // incorporated = False
  ]));

  const critiqueSpendAddress = scriptHashToAddress(GOV_CRITIQUE_SPEND_HASH);

  const completed = await lucid.newTx()
    .pay.ToAddressWithData(
      critiqueSpendAddress,
      { kind: 'inline', value: critiqueDatum },
      { lovelace: stakeLovelace + 2_000_000n },
    )
    .complete({ localUPLCEval: false });

  return {
    ...toBuildResult(completed),
    op: 'critique',
    proposalRef: `${p.proposalTxHash}#${p.proposalOutputIndex}`,
    stakeLovelace: stakeLovelace.toString(),
    scriptAddress: critiqueSpendAddress,
    storageUri: finalUri,
    ...(ipfsCid ? { ipfsCid, documentHash } : {}),
  };
}

// ─── Build: endorse ──────────────────────────────────────────────────────────

export async function buildEndorse(lucid: LucidEvolution, p: {
  agentDid: string;
  proposalTxHash: string;
  proposalOutputIndex: number;
  stakeApex: number;
}): Promise<VectorBuildStakeResult> {
  const changeAddress = await lucid.wallet().address();

  if (!(p.stakeApex >= MIN_ENDORSE_STAKE_APEX)) {
    throw new Error(`Endorsement stake must be at least ${MIN_ENDORSE_STAKE_APEX} AP3X.`);
  }
  const stakeLovelace = apexToLovelace(p.stakeApex);

  const vkeyHash = paymentKeyHashOf(changeAddress);

  const provider = slotClockOf(lucid);
  await ensureSlotConfig(provider);
  const tip = (await provider.getNetworkTip?.()) ?? { slot: 0 };
  const currentSlot = tip.slot || 0;

  const endorsementDatum = Data.to(new Constr(0, [
    p.agentDid,                                                          // endorser_did
    new Constr(0, [vkeyHash]),                                           // endorser_credential
    new Constr(0, [p.proposalTxHash, BigInt(p.proposalOutputIndex)]),    // proposal_ref
    stakeLovelace,                                                       // stake_amount
    BigInt(currentSlot),                                                 // created_at
  ]));

  const endorsementSpendAddress = scriptHashToAddress(GOV_ENDORSEMENT_SPEND_HASH);

  const completed = await lucid.newTx()
    .pay.ToAddressWithData(
      endorsementSpendAddress,
      { kind: 'inline', value: endorsementDatum },
      { lovelace: stakeLovelace + 2_000_000n },
    )
    .complete({ localUPLCEval: false });

  return {
    ...toBuildResult(completed),
    op: 'endorse',
    proposalRef: `${p.proposalTxHash}#${p.proposalOutputIndex}`,
    stakeLovelace: stakeLovelace.toString(),
    scriptAddress: endorsementSpendAddress,
  };
}

// ─── Build: proposal lock (step 1 of 2) ─────────────────────────────────────

export async function buildProposalLock(lucid: LucidEvolution, p: {
  agentDid: string;
  proposalType: 'ParameterChange' | 'TreasurySpend' | 'ProtocolUpgrade' | 'GameActivation' | 'GeneralSuggestion';
  stakeApex: number;
  typeParams?: {
    paramName?: string; currentValue?: number; proposedValue?: number;
    amount?: number; recipientDescription?: string; upgradeHash?: string; gameId?: number;
  };
  priority?: 'Standard' | 'Emergency';
  proposalDocument?: string;
  proposalHash?: string;
  storageUri?: string;
}): Promise<VectorBuildProposalLockResult> {
  const changeAddress = await lucid.wallet().address();

  // Validation order: stake minimum -> type-specific params (cheap,
  // synchronous) -> document/hash/URI resolution (the one network side
  // effect, a Filebase upload, is deliberately validated last).
  if (!(p.stakeApex >= MIN_PROPOSAL_STAKE_APEX)) {
    throw new Error(`Proposal stake must be at least ${MIN_PROPOSAL_STAKE_APEX} AP3X.`);
  }
  const stakeLovelace = apexToLovelace(p.stakeApex);

  // Proposal-type datum. Same Constr indices as the custodial switch - the
  // deployed module validator parses these exact bytes.
  let typeDatum: Constr<Data>;
  switch (p.proposalType) {
    case 'ParameterChange':
      if (!p.typeParams?.paramName || p.typeParams?.currentValue == null || p.typeParams?.proposedValue == null) {
        throw new Error('ParameterChange requires paramName, currentValue, proposedValue');
      }
      typeDatum = new Constr(0, [fromText(p.typeParams.paramName), BigInt(p.typeParams.currentValue), BigInt(p.typeParams.proposedValue)]);
      break;
    case 'TreasurySpend':
      if (!p.typeParams?.amount || !p.typeParams?.recipientDescription) {
        throw new Error('TreasurySpend requires amount, recipientDescription');
      }
      typeDatum = new Constr(1, [BigInt(p.typeParams.amount), fromText(p.typeParams.recipientDescription)]);
      break;
    case 'ProtocolUpgrade':
      typeDatum = new Constr(2, [p.typeParams?.upgradeHash || '']);
      break;
    case 'GameActivation':
      typeDatum = new Constr(3, [BigInt(p.typeParams?.gameId || 0)]);
      break;
    case 'GeneralSuggestion':
      typeDatum = new Constr(4, []);
      break;
    default: {
      const exhaustive: never = p.proposalType;
      throw new Error(`Unknown proposalType: ${String(exhaustive)}`);
    }
  }

  // Document/hash/URI resolution: Filebase upload if a document was given,
  // else the caller-supplied hash + URI must already be valid.
  let finalHash = p.proposalHash;
  let finalUri = p.storageUri;
  let ipfsCid: string | undefined;

  if (p.proposalDocument) {
    const uploaded = await uploadToFilebase(p.proposalDocument, 'proposal');
    finalHash = uploaded.hash;
    finalUri = `ipfs://${uploaded.cid}`;
    ipfsCid = uploaded.cid;
  }

  if (!finalHash || finalHash.length !== 64) {
    throw new Error('proposalHash must be 64 hex characters (32 bytes). Provide proposalDocument for automatic hashing or proposalHash manually.');
  }
  if (!finalUri) {
    throw new Error('storageUri is required. Provide proposalDocument for automatic upload or storageUri manually.');
  }

  const vkeyHash = paymentKeyHashOf(changeAddress);

  const provider = slotClockOf(lucid);
  const zeroTime = await ensureSlotConfig(provider);
  const tip = (await provider.getNetworkTip?.()) ?? { slot: 0 };
  const submittedAtMs = zeroTime + (tip.slot || 0) * 1000; // POSIX ms - the validity-range unit, not slots

  const priorityDatum = p.priority === 'Emergency' ? new Constr(1, []) : new Constr(0, []);

  const proposalDatum = Data.to(new Constr(0, [
    p.agentDid,                          // proposer_did
    new Constr(0, [vkeyHash]),           // proposer_credential
    finalHash,                           // proposal_hash
    typeDatum,                           // proposal_type
    fromText(finalUri),                  // storage_uri
    stakeLovelace,                       // stake_amount
    BigInt(submittedAtMs),               // submitted_at
    604_800_000n,                        // review_window (~7 days in ms)
    priorityDatum,                       // priority
    0n,                                  // amendment_count
    [],                                  // incorporated_critiques
    new Constr(0, []),                   // state = Open
  ]));

  const proposalSpendAddress = scriptHashToAddress(GOV_PROPOSAL_SPEND_HASH);

  const completed = await lucid.newTx()
    .pay.ToAddressWithData(
      proposalSpendAddress,
      { kind: 'inline', value: proposalDatum },
      { lovelace: stakeLovelace + 2_000_000n },
    )
    .complete({ localUPLCEval: false });

  return {
    ...toBuildResult(completed),
    scriptAddress: proposalSpendAddress,
    stakeLovelace: stakeLovelace.toString(),
    storageUri: finalUri,
    proposalHash: finalHash,
    ...(ipfsCid ? { ipfsCid } : {}),
  };
}

// ─── Build: proposal spend (step 2 of 2 - validated spend + mint) ──────────

export async function buildProposalSpend(
  lucid: LucidEvolution,
  // Assumed to be the same provider instance `lucid` was constructed with
  // (lucidForAddress(provider, changeAddress)) - passed explicitly (unlike
  // buildCritique/buildEndorse's slotClockOf recovery) because this build
  // resolves UTxOs by outref/unit directly against it, not through lucid's
  // own UTxO cache. SlotClockProvider (not OgmiosProvider's own stricter
  // getNetworkTip) supplies the slot/tip surface, same as slotClockOf's
  // callers elsewhere in this file - keeps the (optional) hash field out of
  // this build's contract, since it never uses it.
  provider: Pick<OgmiosProvider, 'getUtxos' | 'getUtxoByUnit' | 'getUtxosByOutRef'> & SlotClockProvider,
  p: { agentDid: string; lockTxHash: string; lockOutputIndex?: number },
  // Test-only escape hatch, not part of the documented call contract: every
  // production caller (Task 5's tool handler included) omits this and gets
  // parity with the custodial module (provider-side eval). Only
  // gov-build.test.ts's dedicated native-eval-attempt test passes
  // { localUPLCEval: true }, to ask the REAL deployed validators a question
  // FixtureProvider's missing evaluateTx would otherwise make impossible to
  // ask at all.
  opts?: { localUPLCEval?: boolean },
): Promise<VectorBuildProposalSpendResult> {
  const changeAddress = await lucid.wallet().address();
  const lockOutputIndex = p.lockOutputIndex ?? 0;
  const proposalSpendAddress = scriptHashToAddress(GOV_PROPOSAL_SPEND_HASH);

  // 1. Resolve the locked UTxO. Its datum is reused VERBATIM below as the
  // continuing datum - the chain's own bytes are the truth, not a
  // reconstruction.
  const lockedUtxos = await provider.getUtxosByOutRef([{ txHash: p.lockTxHash, outputIndex: lockOutputIndex }]);
  const lockedUtxo = lockedUtxos[0];
  if (!lockedUtxo) {
    throw new Error('Locked proposal UTxO not found - has the lock transaction confirmed? Run vector_await_transaction { txHash } first.');
  }
  // Fail fast on a caller passing an unrelated txHash that happens to
  // resolve to a real UTxO elsewhere (same defensive pattern as
  // build.ts's buildInteractContract spend-action address check) - a
  // datum-parse failure two lines below would eventually catch most cases
  // of this, but this gives a specific, actionable error instead of a
  // generic "malformed data" one.
  if (lockedUtxo.address !== proposalSpendAddress) {
    throw new Error(
      `Locked UTxO ${p.lockTxHash}#${lockOutputIndex} is not at the proposal script address ` +
      `(found ${lockedUtxo.address}) - pass the lock transaction hash returned by ` +
      `vector_build_self_improvement_proposal_lock.`,
    );
  }
  if (!lockedUtxo.datum) {
    throw new Error('Locked proposal UTxO has no inline datum - the lock transaction may be malformed.');
  }

  // 2. Sanity-parse + cross-check the proposer DID before spending anything.
  const proposal = parseProposalDatum(lockedUtxo.datum);
  if (!proposal) {
    throw new Error('Could not parse the locked proposal datum. The on-chain data may be malformed.');
  }
  if (proposal.proposerDid !== p.agentDid) {
    throw new Error(`Proposer DID mismatch: the locked proposal belongs to ${proposal.proposerDid}, not ${p.agentDid}.`);
  }

  // 3. Reference-script UTxOs (CIP-33) - availability errors transcribed
  // verbatim from the custodial module (these can be accidentally consumed
  // by an unrelated transaction).
  const refScriptUtxos = await provider.getUtxosByOutRef([
    parseUtxoRef(GOV_PROPOSAL_SPEND_REF),
    parseUtxoRef(GOV_PROPOSAL_MINT_REF),
  ]);
  if (refScriptUtxos.length < 2) {
    throw new Error(
      `Reference script UTxOs missing: found ${refScriptUtxos.length}/2. ` +
      `spend_ref=${GOV_PROPOSAL_SPEND_REF}, mint_ref=${GOV_PROPOSAL_MINT_REF}. ` +
      `These UTxOs may have been consumed - redeploy with scripts/redeploy_ref_scripts.py ` +
      `and update GOV_PROPOSAL_SPEND_REF / GOV_PROPOSAL_MINT_REF env vars.`,
    );
  }
  const missingScriptRef = refScriptUtxos.filter((u) => !u.scriptRef);
  if (missingScriptRef.length > 0) {
    throw new Error(
      `Reference script UTxOs found but missing scriptRef field for ${missingScriptRef.length} UTxO(s). ` +
      `The UTxOs at ${missingScriptRef.map((u) => u.txHash).join(', ')} exist but don't contain scripts. ` +
      `Redeploy reference scripts and update env vars.`,
    );
  }

  // Module infrastructure reference inputs - resolved the same way the
  // custodial module did (not individually validated here; the deployed
  // validator itself rejects the spend if one is missing from the tx).
  const govRefUtxos = await provider.getUtxosByOutRef([
    parseUtxoRef(GOV_PARAMS_UTXO),
    parseUtxoRef(GOV_ORACLE_UTXO),
    parseUtxoRef(GOV_CROSSREFS_UTXO),
  ]);

  // 4. The agent's registry NFT (CIP-31 reference input, proves the DID).
  // Same try-getUtxoByUnit-catch-scan-getUtxos(registryAddress) fallback as
  // registry-build.ts's resolveAgentUtxo: getUtxoByUnit needs a live indexer
  // (FixtureProvider always throws), so offline building depends on the
  // scan fallback actually running.
  const nftUnit = AGENT_REGISTRY_POLICY + p.agentDid;
  let nftUtxo: UTxO | undefined;
  try {
    nftUtxo = await provider.getUtxoByUnit(nftUnit);
  } catch {
    // Koios unavailable, asset not found, or an offline provider - fall through to the address scan.
  }
  if (!nftUtxo) {
    const registryUtxos = await provider.getUtxos(getRegistryAddress());
    nftUtxo = registryUtxos.find((u) => u.assets[nftUnit] && u.assets[nftUnit] > 0n);
  }
  if (!nftUtxo) {
    throw new Error(
      `Agent registry NFT not found on-chain. Expected token: ${AGENT_REGISTRY_POLICY.slice(0, 12)}...${p.agentDid.slice(0, 12)}... ` +
      `The agent may need to re-register with vector_build_register_agent.`,
    );
  }

  // 5. Token names, validity window, activity datum.
  const propTokenName = deriveProposalTokenName(p.lockTxHash, lockOutputIndex);
  const actTokenName = deriveActivityTokenName(p.agentDid);
  const propTokenUnit = GOV_PROPOSAL_MINT_HASH + propTokenName;
  const actTokenUnit = GOV_PROPOSAL_MINT_HASH + actTokenName;

  const zeroTime = await ensureSlotConfig(provider);
  const tip = (await provider.getNetworkTip?.()) ?? { slot: 0 };
  // The validator checks activity.last_proposal_slot == tx validity lower bound.
  const validFromMs = zeroTime + (tip.slot || 0) * 1000;
  const validToMs = validFromMs + 360_000; // 6 minutes - the agent's signing deadline

  const vkeyHash = paymentKeyHashOf(changeAddress);

  // First proposal from this agent: activity count starts at 1.
  // TODO: for a subsequent proposal, find the existing pact_ UTxO and
  // increment count instead of always minting a fresh one - the custodial
  // module carried the same simplification; not fixed here.
  const activityDatum = Data.to(new Constr(0, [
    p.agentDid,                          // agent_did
    new Constr(0, [vkeyHash]),           // agent_credential
    1n,                                  // active_proposal_count
    BigInt(validFromMs),                 // last_proposal_slot (POSIX ms, matches tx validity lower bound)
  ]));

  const submitRedeemer = Data.to(new Constr(0, []));

  const completed = await lucid.newTx()
    .collectFrom([lockedUtxo], submitRedeemer)
    .readFrom(refScriptUtxos)
    .readFrom(govRefUtxos)
    .readFrom([nftUtxo])
    .mintAssets({ [propTokenUnit]: 1n, [actTokenUnit]: 1n }, submitRedeemer)
    .pay.ToAddressWithData(
      proposalSpendAddress,
      { kind: 'inline', value: lockedUtxo.datum },
      // Value-preservation (registry-family lesson): carry the locked
      // UTxO's OWN coin through rather than recomputing stake+2 AP3X - that
      // constant only happens to equal it today.
      { ...lockedUtxo.assets, [propTokenUnit]: 1n },
    )
    .pay.ToAddressWithData(
      proposalSpendAddress,
      { kind: 'inline', value: activityDatum },
      { lovelace: 2_000_000n, [actTokenUnit]: 1n },
    )
    .addSigner(changeAddress)
    .validFrom(validFromMs)
    .validTo(validToMs)
    .complete({ localUPLCEval: opts?.localUPLCEval ?? false });

  return {
    ...toBuildResult(completed),
    proposalTokenName: propTokenName,
    activityTokenName: actTokenName,
    scriptAddress: proposalSpendAddress,
    validToMs,
  };
}
