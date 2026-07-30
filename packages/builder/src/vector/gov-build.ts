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
import type { LucidEvolution } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { VectorBuildStakeResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';

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
  const stakeLovelace = BigInt(Math.floor(p.stakeApex * 1_000_000));

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
  const stakeLovelace = BigInt(Math.floor(p.stakeApex * 1_000_000));

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
