// packages/builder/src/vector/gov-tx.ts
// Keyless builders of the Module-6 (self-improvement) contracts on the identity registry (Part 2 Section 7, Module-6 row). A
// proposal, a critique and an endorsement each take two transactions: a lock (the datum at the validator address, paid by the wallet,
// no script) and a creation (the validator spends the lock and its token is minted). The creation checks the agent: its identity record
// and the ancestor records are reference inputs, its effective status is Active over the whole validity window, the window is at most
// one hour, and the credential in the datum is a declared credential (the record's controller key or a listed Ed25519 key with the
// transaction purpose) whose key signs. submitted_at (created_at) is the lower bound of the creation's window. A first submission
// inserts the agent's node into the activity list; critiques and endorsements name their proposal by its seed.
//
// A lock runs no script, and a proposal lock can only leave the validator through its submission, so every builder checks the rules
// of the creation before it builds the lock. The builders follow the reference client of the module (vector-agent-modules
// Module-6/scripts/governance_identity.py at 91e3823). Lucid runs the applied validators of the reference scripts on every creation
// (local evaluation), so a creation that builds passes the contracts, minus the signatures. Nothing is signed or submitted.
import { CML, calculateMinLovelaceFromUTxO } from '@lucid-evolution/lucid';
import type { Assets, LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { apexToLovelace, lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { paymentKeyHashOf } from './gov-build.js';
import {
  SignerList, ancestorsOf, chainClock, didOf, findRecord, identifierOf, recordsById, requireRecord, signedByResult, uniqueUtxos,
  walletOf, windowAt,
} from './identity-chain.js';
import type { RecordUtxo, SignedByBuild, Window } from './identity-chain.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { textOf, utf8Hex } from './identity-codec.js';
import type { IdentityDatum, OutputReference } from './identity-codec.js';
import { DAYS_7_MS, PURPOSE, activeKey, effectiveStatus, keyHashOf } from './identity-rules.js';
import {
  MINT_CRITIQUE_TOKEN_REDEEMER, MINT_ENDORSEMENT_TOKEN_REDEEMER, SPEND_ACTIVITY_REDEEMER, SUBMIT_PROPOSAL_REDEEMER,
  decodeCritiqueDatum, decodeEndorsementDatum, decodeProposalDatum, deriveActivityTokenName, deriveCritiqueTokenName,
  deriveEndorsementTokenName, deriveProposalTokenName, encodeActivityDatum, encodeCritiqueDatum, encodeEndorsementDatum,
  encodeProposalDatum, sameCredential,
} from './gov-codec.js';
import type {
  ActivityDatum, CritiqueDatum, CritiqueType, CritiqueTypeName, EndorsementDatum, GovCredential, GovernanceParams, ProposalDatum,
  ProposalPriority, ProposalType, ProposalTypeName,
} from './gov-codec.js';
import {
  activityListFrom, activityNode, activityPredecessor, findCrossRefs, findParamsRecord, readGovRefScript, refText,
  requireProposalBySeed, resolveProposal,
} from './gov-deployment.js';
import type { ActivityEntry, GovDeployment, KoiosAccess, OutRef, ProposalTarget } from './gov-deployment.js';

// ─── Constants ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Wire-level stake minimums of the tools (the tool schemas carry them too, so a direct caller cannot go below them). The contract's
// own minimums come from the GovernanceParams record, and the builders check those as well.
export const MIN_PROPOSAL_STAKE_APEX = 25;
export const MIN_CRITIQUE_STAKE_APEX = 10;
export const MIN_ENDORSE_STAKE_APEX = 5;
/** AP3X on top of the stake in a proposal, critique or endorsement lock: 2 AP3X, as before. */
export const POSITION_DEPOSIT_LOVELACE = 2_000_000n;
/** AP3X of a new node of the activity list (raised to the ledger minimum when that is more). */
export const ACTIVITY_LOVELACE = 2_000_000n;
/** The review window of a Standard proposal: 7 days. An Emergency proposal takes the emergency window of the parameters. */
export const DEFAULT_REVIEW_WINDOW_MS = DAYS_7_MS;
/** The parameter names that a ParameterChange proposal can name (params.is_governable_param). Read as own properties only. */
export const GOVERNABLE_PARAMS: Readonly<Record<string, true>> = Object.freeze(Object.fromEntries([
  'MIN_CLAIM_STAKE', 'MIN_CHALLENGE_WINDOW', 'JURY_SIZE', 'JURY_FEE_RATE', 'MIN_SELF_STAKE', 'MIN_ENDORSEMENT', 'DECAY_RATE',
  'MAX_ENDORSEMENT_MULTIPLIER', 'MIN_PROPOSAL_STAKE', 'MIN_CRITIQUE_STAKE', 'MIN_GOVERNANCE_ENDORSEMENT', 'MIN_REVIEW_WINDOW',
  'MAX_REVIEW_WINDOW', 'MAX_AMENDMENTS', 'MAX_ACTIVE_PROPOSALS', 'COOLDOWN_BETWEEN_PROPOSALS', 'PROPOSER_REWARD_SHARE',
  'CRITIC_REWARD_SHARE', 'PROTOCOL_FEE_RATE', 'MIN_ADOPTION_REWARD', 'MAX_ADOPTION_REWARD', 'MAX_INCORPORATED_CRITIQUES',
  'MAX_TREASURY_REQUEST', 'EMERGENCY_STAKE_MULTIPLIER', 'EMERGENCY_REVIEW_WINDOW', 'TREASURY_BATCH_SIZE', 'MIN_TREASURY_BATCHES',
  'ADOPTION_REWARD_BASE', 'GAME_ACTIVATION',
].map((name) => [name, true] as const)));

const iso = (ms: number): string => new Date(ms).toISOString();
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX56 = /^[0-9a-fA-F]{56}$/;

// ─── Documents (Filebase IPFS upload) ───────────────────────────────────────────────────────────────────────────────────────────

const FILEBASE_ACCESS_KEY = process.env.FILEBASE_ACCESS_KEY || '';
const FILEBASE_SECRET_KEY = process.env.FILEBASE_SECRET_KEY || '';
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET || '';

/**
 * Uploads a JSON document (canonical: parsed and written again) to the Filebase IPFS bucket and returns its CID and its blake2b-256
 * hash. A network side effect of the hosted builder by design; it only ever sees the document text, never key material.
 */
export async function uploadToFilebase(document: string, namePrefix: string): Promise<{ cid: string; hash: string }> {
  if (!FILEBASE_ACCESS_KEY || !FILEBASE_SECRET_KEY || !FILEBASE_BUCKET) {
    throw new Error('Filebase not configured. Set FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY, and FILEBASE_BUCKET env vars.');
  }
  const canonical = JSON.stringify(JSON.parse(document));
  const hashHex = Buffer.from(blake2b(new TextEncoder().encode(canonical), { dkLen: 32 })).toString('hex');
  const key = `${namePrefix}-${hashHex.slice(0, 16)}.json`;
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'https://s3.filebase.com',
    credentials: { accessKeyId: FILEBASE_ACCESS_KEY, secretAccessKey: FILEBASE_SECRET_KEY },
    forcePathStyle: true,
  });
  const resp = await s3.send(new PutObjectCommand({ Bucket: FILEBASE_BUCKET, Key: key, Body: canonical, ContentType: 'application/json' }));
  // Filebase returns the CID as the version id of the response, else in the x-amz-meta-cid metadata of the object.
  let cid = resp.$metadata?.httpStatusCode === 200 ? resp.VersionId || '' : '';
  if (!cid) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: FILEBASE_BUCKET, Key: key }));
    cid = head.Metadata?.cid || '';
  }
  if (!cid) throw new Error('Filebase upload succeeded but CID not returned. Check bucket is IPFS-enabled.');
  return { cid, hash: hashHex };
}

/** Without a document, the hash must be 64 hex characters and the URI must be given: checked before any chain read. */
function manualDocument(kind: 'proposal' | 'critique', hash: string | undefined, uri: string | undefined): void {
  if (!hash || !HEX64.test(hash)) throw new Error(`${kind}Hash must be 64 hex characters (32 bytes). Provide ${kind}Document for automatic hashing or ${kind}Hash manually.`);
  if (!uri) throw new Error(`storageUri is required. Provide ${kind}Document for automatic upload or storageUri manually.`);
}

/** The hash and URI of a document: uploaded when one is given (the last step before the build), else the given ones. */
async function documentOf(kind: 'proposal' | 'critique', document: string | undefined, hash: string | undefined, uri: string | undefined): Promise<{ hash: string; uri: string; ipfsCid?: string }> {
  if (!document) return { hash: hash!.toLowerCase(), uri: uri! };
  const uploaded = await uploadToFilebase(document, kind);
  return { hash: uploaded.hash, uri: `ipfs://${uploaded.cid}`, ipfsCid: uploaded.cid };
}

// ─── Contract rules (checked before a build, so that a refusal names the rule) ──────────────────────────────────────────────────

const ap3x = (lovelace: bigint): string => lovelaceToAda(lovelace);

/** The proposal type from its tool form. */
export interface ProposalTypeInput {
  paramName?: string; currentValue?: number; proposedValue?: number; amount?: number; recipientDescription?: string; upgradeHash?: string; gameId?: number;
}

export function proposalTypeFrom(name: ProposalTypeName, p: ProposalTypeInput = {}): ProposalType {
  const whole = (n: number | undefined): n is number => typeof n === 'number' && Number.isSafeInteger(n);
  switch (name) {
    case 'ParameterChange':
      if (!p.paramName || !whole(p.currentValue) || !whole(p.proposedValue)) throw new Error('ParameterChange requires paramName, currentValue, proposedValue (whole numbers).');
      return { type: 'ParameterChange', paramName: utf8Hex(p.paramName), currentValue: BigInt(p.currentValue), proposedValue: BigInt(p.proposedValue) };
    case 'TreasurySpend':
      if (!whole(p.amount) || !p.recipientDescription) throw new Error('TreasurySpend requires amount (lovelace, a whole number), recipientDescription.');
      return { type: 'TreasurySpend', amount: BigInt(p.amount), recipientDescription: utf8Hex(p.recipientDescription) };
    case 'ProtocolUpgrade':
      if (!p.upgradeHash || !HEX64.test(p.upgradeHash)) throw new Error('ProtocolUpgrade requires upgradeHash: the blake2b-256 hash of the upgrade description, 64 hex characters.');
      return { type: 'ProtocolUpgrade', upgradeDescriptionHash: p.upgradeHash.toLowerCase() };
    case 'GameActivation':
      if (!whole(p.gameId)) throw new Error('GameActivation requires gameId, a positive whole number.');
      return { type: 'GameActivation', gameId: BigInt(p.gameId) };
    case 'GeneralSuggestion':
      return { type: 'GeneralSuggestion' };
  }
}

function proposalTypeProblem(t: ProposalType, params: GovernanceParams): string | null {
  switch (t.type) {
    case 'ParameterChange': {
      const name = textOf(t.paramName);
      return name !== null && Object.prototype.hasOwnProperty.call(GOVERNABLE_PARAMS, name) ? null : `${JSON.stringify(name ?? t.paramName)} is not a governable parameter`;
    }
    case 'TreasurySpend':
      return t.amount > 0n && t.amount <= params.maxTreasuryRequest ? null : `the treasury amount must be more than 0 and at most ${params.maxTreasuryRequest} lovelace`;
    case 'ProtocolUpgrade': return t.upgradeDescriptionHash.length === 64 ? null : 'the upgrade description hash is not 32 bytes';
    case 'GameActivation': return t.gameId > 0n ? null : 'the game id must be positive';
    case 'GeneralSuggestion': return null;
  }
}

/** The rules of validate_submit_proposal that read only the new datum and the parameters (stake, hash, type, URI, review window, state). */
export function proposalProblems(d: ProposalDatum, params: GovernanceParams): string[] {
  const problems: string[] = [];
  if (d.proposalHash.length !== 64) problems.push('proposal_hash is not 32 bytes');
  if (d.storageUri.length === 0) problems.push('storage_uri is empty');
  const typeProblem = proposalTypeProblem(d.proposalType, params);
  if (typeProblem) problems.push(typeProblem);
  const reviewWindow = BigInt(d.reviewWindow);
  if (d.priority === 'Standard') {
    if (d.stakeAmount < params.minProposalStake) problems.push(`the stake is below the minimum of ${ap3x(params.minProposalStake)} AP3X`);
    if (reviewWindow < params.minReviewWindow || reviewWindow > params.maxReviewWindow) {
      problems.push(`the review window must be from ${params.minReviewWindow} to ${params.maxReviewWindow} ms`);
    }
  } else {
    if (d.proposalType.type !== 'ParameterChange' && d.proposalType.type !== 'ProtocolUpgrade') problems.push('an Emergency proposal must be a ParameterChange or a ProtocolUpgrade');
    const emergencyStake = (params.minProposalStake * params.emergencyStakeMultiplier) / 1000n;
    if (d.stakeAmount < emergencyStake) problems.push(`the stake of an Emergency proposal is below the minimum of ${ap3x(emergencyStake)} AP3X`);
    if (reviewWindow !== params.emergencyReviewWindow) problems.push(`the review window of an Emergency proposal must be ${params.emergencyReviewWindow} ms`);
  }
  if (d.state.type !== 'Open') problems.push('a new proposal must be Open');
  if (d.amendmentCount !== 0 || d.incorporatedCritiques.length > 0) problems.push('a new proposal has no amendments and no incorporated critiques');
  return problems;
}

/** validate_submit_rate_limit: the active proposals and the cooldown, from the agent's node (none before its first proposal). */
export function rateLimitProblem(node: ActivityEntry | null, params: GovernanceParams, lo: number): string | null {
  if (!node) return null;
  const d = node.datum;
  if (BigInt(d.activeProposalCount) >= params.maxActiveProposals) return `${didOf(d.agentDid)} has ${d.activeProposalCount} active proposals; the limit is ${params.maxActiveProposals}`;
  const allowed = BigInt(d.lastProposalSlot) + params.proposalCooldown;
  if (BigInt(lo) < allowed) return `the proposal cooldown of ${didOf(d.agentDid)} ends at ${iso(Number(allowed))}; the validity window starts at ${iso(lo)}`;
  return null;
}

const isActiveState = (d: ProposalDatum): boolean => d.state.type === 'Open' || d.state.type === 'Amended';

/** validate_submit_critique besides identity, signature and the rule of different parties. */
export function critiqueProblems(d: CritiqueDatum, proposal: ProposalDatum, params: GovernanceParams): string[] {
  const problems: string[] = [];
  if (!isActiveState(proposal)) problems.push(`the proposal is ${proposal.state.type}, not Open or Amended`);
  if (d.stakeAmount < params.minCritiqueStake) problems.push(`the stake is below the minimum of ${ap3x(params.minCritiqueStake)} AP3X`);
  if (d.critiqueHash.length !== 64) problems.push('critique_hash is not 32 bytes');
  if (d.incorporated) problems.push('a new critique is not incorporated');
  if (d.criticDid === proposal.proposerDid && d.critiqueType.type !== 'Amendment') problems.push('the proposer can only write an Amendment critique of its own proposal');
  return problems;
}

/** validate_submit_endorsement besides identity, signature and the rule of different parties. */
export function endorsementProblems(d: EndorsementDatum, proposal: ProposalDatum, params: GovernanceParams): string[] {
  const problems: string[] = [];
  if (!isActiveState(proposal)) problems.push(`the proposal is ${proposal.state.type}, not Open or Amended`);
  if (d.stakeAmount < params.minGovernanceEndorsement) problems.push(`the stake is below the minimum of ${ap3x(params.minGovernanceEndorsement)} AP3X`);
  if (d.endorserDid === proposal.proposerDid) problems.push('an agent cannot endorse its own proposal');
  return problems;
}

const parentOf = (record: IdentityDatum): string | null => (record.lineage.type === 'Subagent' ? record.lineage.parent : null);

/**
 * critique_validation.distinct_parties: the agent (its record and its declared credential) and the proposer (its record, any status)
 * are different parties. It fails when the identifiers are equal, the controller keys are equal, the credential is the proposer
 * credential, one record is a direct subagent of the other, or both are subagents of the same parent.
 */
export function distinctPartyProblems(agentId: string, agent: IdentityDatum, credential: GovCredential, proposal: ProposalDatum, proposer: IdentityDatum): string[] {
  const problems: string[] = [];
  const agentParent = parentOf(agent);
  const proposerParent = parentOf(proposer);
  if (agentId === proposal.proposerDid) problems.push('the agent is the proposer');
  if (agent.controller === proposer.controller) problems.push('the agent and the proposer have the same controller key');
  if (sameCredential(credential, proposal.proposerCredential)) problems.push('the credential of the agent is the proposer credential');
  if (agentParent === proposal.proposerDid) problems.push('the agent is a subagent of the proposer');
  if (proposerParent === agentId) problems.push('the proposer is a subagent of the agent');
  if (agentParent !== null && agentParent === proposerParent) problems.push('the agent and the proposer are subagents of the same parent');
  return problems;
}

function refuse(what: string, problems: string[]): void {
  if (problems.length > 0) throw new Error(`The ${what} does not meet the contract rules: ${problems.join('; ')}.`);
}

// ─── The agent ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What every Module-6 builder works with: Lucid bound to the wallet, the node, both deployments and Koios (for proposal seeds). */
export interface GovContext {
  lucid: LucidEvolution;
  provider: Provider;
  identity: IdentityDeployment;
  gov: GovDeployment;
  koios: KoiosAccess;
}

/** What every Module-6 build takes besides its own inputs. */
export interface GovBuildCommon {
  /** The wallet: it pays the fee, the stake and the deposits, gives the collateral, and receives the change. */
  changeAddress: string;
  /** POSIX ms; default now. Tests fix it. */
  nowMs?: number;
  /** Minutes from now until the transaction expires (windowAt; default 30, at most 59). */
  validMinutes?: number;
}

/** An agent that passed the identity check: its record and ancestors (the reference inputs), and its declared key with the key's role. */
interface Agent { id: string; did: string; record: RecordUtxo; ancestors: RecordUtxo[]; keyHash: string; role: string }

/**
 * The identity check of Part 2 Section 7 (utils.agent_record): the record of `id` and its ancestors exist, its effective status is
 * Active over the whole window, and `keyHash` is a declared credential: the hash of the controller key or of a listed Ed25519 key with
 * the transaction purpose.
 */
async function activeAgent(ctx: GovContext, id: string, keyHash: string, window: Window, what: string): Promise<Agent> {
  if (!HEX56.test(keyHash)) throw new Error(`The credential key hash must be 56 hex characters, got ${JSON.stringify(keyHash.slice(0, 80))}.`);
  const record = await requireRecord(ctx.provider, ctx.identity, id, `identity record of the ${what}`);
  const ancestors = await ancestorsOf(ctx.provider, ctx.identity, record.record);
  const status = effectiveStatus(record.record, recordsById(ancestors), window.lo, window.hi);
  const did = didOf(id);
  if (status !== 'Active') throw new Error(`The ${what} ${did} is ${status} over the validity window; Module-6 accepts an agent only while its effective status is Active (Part 2 Section 7).`);
  const hash = keyHash.toLowerCase();
  const role = hash === keyHashOf(record.record.controller) ? `controller key of ${did}`
    : activeKey(record.record, hash, PURPOSE.transaction) ? `listed transaction key of ${did}` : null;
  if (!role) {
    throw new Error(`The key hash ${hash} is not a declared credential of ${did}: Module-6 takes the controller key or a listed Ed25519 key with the transaction purpose (Part 2 Section 7). Pass credentialKeyHash, or list the key with vector_build_identity_update.`);
  }
  return { id, did, record, ancestors, keyHash: hash, role };
}

/** The key hash of a declared credential in a lock: Module-6 accepts only a verification key. */
function keyOf(credential: GovCredential, whose: string): string {
  if (credential.type !== 'VerificationKey') throw new Error(`The ${whose} credential of the lock is a script credential; Module-6 accepts only a verification key (the controller key or a listed transaction key).`);
  return credential.hash;
}

/** The record of the proposer (any status, also a tombstone), which the rule of different parties reads as a reference input. */
async function proposerRecord(ctx: GovContext, proposal: ProposalDatum): Promise<RecordUtxo> {
  const record = await findRecord(ctx.provider, ctx.identity, proposal.proposerDid);
  if (!record) throw new Error(`No identity record of the proposer ${didOf(proposal.proposerDid)}: the rule of different parties reads it (Part 2 Section 7).`);
  return record;
}

/** The wallet of a lock (no script runs, so no collateral): Lucid must be bound to `changeAddress`, which has a key credential. */
async function lockWallet(lucid: LucidEvolution, changeAddress: string): Promise<string> {
  const keyHash = paymentKeyHashOf(changeAddress);
  if ((await lucid.wallet().address()) !== changeAddress) throw new Error('changeAddress is not the address this wallet is bound to; nothing was built.');
  return keyHash;
}

const agentRefs = (agent: Agent): UTxO[] => [agent.record.utxo, ...agent.ancestors.map((a) => a.utxo)];

// ─── Outputs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The ledger minimum of an output at `address` with `assets` and the inline `datum`. The coin is sized as the largest one (9 bytes of
 * CBOR), so the result is never below the real minimum.
 */
function minimumLovelace(lucid: LucidEvolution, address: string, assets: Assets, datum: string): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of an output is unknown.');
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address, assets: { ...assets, lovelace: 18_000_000_000_000_000n }, datum });
}

/** The value of an output that continues `utxo` with `datum`: the same tokens and at least its AP3X (raised to the ledger minimum). */
function continuedValue(lucid: LucidEvolution, utxo: UTxO, datum: string): Assets {
  const minimum = minimumLovelace(lucid, utxo.address, utxo.assets, datum);
  return { ...utxo.assets, lovelace: utxo.assets.lovelace > minimum ? utxo.assets.lovelace : minimum };
}

/** The index of the first output of the built transaction that passes `test`. */
function outputIndexWhere(txCbor: string, test: (o: CML.TransactionOutput) => boolean, what: string): number {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  for (let i = 0; i < outputs.len(); i++) if (test(outputs.get(i))) return i;
  throw new Error(`The built transaction has no ${what}; nothing is returned.`);
}
const hasDatum = (o: CML.TransactionOutput, address: string, datum: string): boolean =>
  o.address().to_bech32() === address && o.datum()?.as_datum()?.to_cbor_hex().toLowerCase() === datum;
function holdsUnit(o: CML.TransactionOutput, address: string, unit: string): boolean {
  if (o.address().to_bech32() !== address) return false;
  const assets = o.amount().multi_asset();
  const policies = assets.keys();
  for (let j = 0; j < policies.len(); j++) {
    const policy = policies.get(j);
    const names = assets.get_assets(policy)?.keys();
    for (let k = 0; names && k < names.len(); k++) if (`${policy.to_hex()}${names.get(k).to_hex()}` === unit) return true;
  }
  return false;
}

// ─── Locks (step 1) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What every lock returns: the build (the wallet signs), the lock output, and the agent with its declared credential. */
export interface LockBuild extends SignedByBuild {
  id: string;
  did: string;
  /** The index of the lock output: step 2 spends `<txHash>#<lockOutputIndex>`. */
  lockOutputIndex: number;
  scriptAddress: string;
  stakeLovelace: bigint;
  lockLovelace: bigint;
  /** The declared credential in the datum; its key signs step 2, and stakes and rewards return to it. */
  credentialKeyHash: string;
  credentialRole: string;
}

/** The common part of the three locks: the window, the wallet and the agent (with the credential, default the wallet key). */
async function lockStart(ctx: GovContext, p: GovBuildCommon & { agentDid: string; credentialKeyHash?: string }, what: string): Promise<{ window: Window; walletKeyHash: string; agent: Agent }> {
  await chainClock(ctx.provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const walletKeyHash = await lockWallet(ctx.lucid, p.changeAddress);
  const agent = await activeAgent(ctx, identifierOf(p.agentDid), p.credentialKeyHash ?? walletKeyHash, window, what);
  return { window, walletKeyHash, agent };
}

/** Pays the lock and returns the common result. */
async function payLock(ctx: GovContext, start: { window: Window; walletKeyHash: string; agent: Agent }, address: string, datum: string, stake: bigint): Promise<LockBuild> {
  const lockLovelace = stake + POSITION_DEPOSIT_LOVELACE;
  const completed = await ctx.lucid.newTx()
    .pay.ToContract(address, { kind: 'inline', value: datum }, { lovelace: lockLovelace })
    .validFrom(start.window.lo)
    .validTo(start.window.hi)
    .complete();
  const result = signedByResult(completed, start.window, new SignerList(), start.walletKeyHash);
  return {
    ...result, id: start.agent.id, did: start.agent.did,
    lockOutputIndex: outputIndexWhere(result.txCbor, (o) => hasDatum(o, address, datum), 'lock output'),
    scriptAddress: address, stakeLovelace: stake, lockLovelace, credentialKeyHash: start.agent.keyHash, credentialRole: start.agent.role,
  };
}

export interface ProposalLockParams extends GovBuildCommon {
  agentDid: string;
  /** The declared credential (56 hex); default the wallet key. */
  credentialKeyHash?: string;
  proposalType: ProposalTypeName;
  stakeApex: number;
  typeParams?: ProposalTypeInput;
  priority?: ProposalPriority;
  proposalDocument?: string;
  proposalHash?: string;
  storageUri?: string;
}
export interface ProposalLockBuild extends LockBuild {
  proposalHash: string; storageUri: string; ipfsCid?: string; reviewWindow: number; priority: ProposalPriority;
  /** True when the agent has no node in the activity list yet: step 2 inserts it. */
  firstProposal: boolean;
  datum: ProposalDatum;
}

/**
 * Step 1 of a proposal: locks the ProposalDatum (stake + 2 AP3X) at the proposal validator. A proposal lock can only leave the
 * validator through its submission, so every rule of SubmitProposal is checked first: the identity check, the GovernanceParams rules
 * (stake, hash, type, URI, review window; an Emergency proposal takes the emergency window), the rate limit of the agent's node, a
 * predecessor in the activity list for a first proposal, and the CrossRefs output. A document is uploaded last.
 */
export async function buildProposalLock(ctx: GovContext, p: ProposalLockParams): Promise<ProposalLockBuild> {
  if (!(p.stakeApex >= MIN_PROPOSAL_STAKE_APEX)) throw new Error(`Proposal stake must be at least ${MIN_PROPOSAL_STAKE_APEX} AP3X.`);
  const stake = apexToLovelace(p.stakeApex);
  const proposalType = proposalTypeFrom(p.proposalType, p.typeParams);
  const priority = p.priority ?? 'Standard';
  if (!p.proposalDocument) manualDocument('proposal', p.proposalHash, p.storageUri);
  const { gov, provider } = ctx;
  const start = await lockStart(ctx, p, 'proposer');
  const { params } = await findParamsRecord(provider, gov);
  await findCrossRefs(provider, gov);
  const list = activityListFrom(await provider.getUtxos(gov.proposalAddress), gov);
  const node = activityNode(list, start.agent.id);
  if (!node) activityPredecessor(list, start.agent.id);
  const rate = rateLimitProblem(node, params, start.window.lo);
  if (rate) throw new Error(`The proposal would break the rate limit: ${rate}.`);
  const reviewWindow = priority === 'Emergency' ? Number(params.emergencyReviewWindow) : DEFAULT_REVIEW_WINDOW_MS;
  const draft: ProposalDatum = {
    proposerDid: start.agent.id, proposerCredential: { type: 'VerificationKey', hash: start.agent.keyHash },
    proposalHash: p.proposalHash?.toLowerCase() ?? '00'.repeat(32), proposalType, storageUri: utf8Hex(p.storageUri ?? 'ipfs://'),
    stakeAmount: stake, submittedAt: start.window.lo, reviewWindow, priority, amendmentCount: 0, incorporatedCritiques: [], state: { type: 'Open' },
  };
  refuse('proposal', proposalProblems(draft, params));
  const doc = await documentOf('proposal', p.proposalDocument, p.proposalHash, p.storageUri);
  const datum: ProposalDatum = { ...draft, proposalHash: doc.hash, storageUri: utf8Hex(doc.uri) };
  const lock = await payLock(ctx, start, gov.proposalAddress, encodeProposalDatum(datum), stake);
  return { ...lock, proposalHash: doc.hash, storageUri: doc.uri, ...(doc.ipfsCid ? { ipfsCid: doc.ipfsCid } : {}), reviewWindow, priority, firstProposal: node === null, datum };
}

/** A critique or an endorsement names its proposal by the seed or by the current output (`proposalTxHash#proposalOutputIndex`). */
interface ProposalNamed { proposalTxHash: string; proposalOutputIndex?: number }
const namedRef = (p: ProposalNamed): OutRef => ({ txHash: p.proposalTxHash.trim().toLowerCase(), outputIndex: p.proposalOutputIndex ?? 0 });

export interface CritiqueLockParams extends GovBuildCommon, ProposalNamed {
  agentDid: string;
  credentialKeyHash?: string;
  critiqueType: CritiqueTypeName;
  stakeApex: number;
  critiqueDocument?: string;
  critiqueHash?: string;
  storageUri?: string;
}
export interface CritiqueLockBuild extends LockBuild {
  /** The seed of the proposal, which the datum names (proposal_ref). */
  seed: string;
  /** The current output of the proposal. */
  proposal: string;
  proposerDid: string;
  critiqueType: CritiqueTypeName; critiqueHash: string; storageUri: string; ipfsCid?: string; documentHash?: string;
  datum: CritiqueDatum;
}

/**
 * Step 1 of a critique: locks the CritiqueDatum (stake + 2 AP3X) at the critique validator, with proposal_ref = the seed of the
 * proposal. The rules of MintCritiqueToken are checked first: the identity check, the proposal is submitted and Open or Amended, the
 * stake, and (except for an Amendment critique) the rule of different parties against the proposer's record.
 */
export async function buildCritiqueLock(ctx: GovContext, p: CritiqueLockParams): Promise<CritiqueLockBuild> {
  if (!(p.stakeApex >= MIN_CRITIQUE_STAKE_APEX)) throw new Error(`Critique stake must be at least ${MIN_CRITIQUE_STAKE_APEX} AP3X.`);
  const stake = apexToLovelace(p.stakeApex);
  if (!p.critiqueDocument) manualDocument('critique', p.critiqueHash, p.storageUri);
  const { gov, provider } = ctx;
  const start = await lockStart(ctx, p, 'critic');
  const target = await resolveProposal(provider, gov, namedRef(p), ctx.koios);
  const { params } = await findParamsRecord(provider, gov);
  await findCrossRefs(provider, gov);
  const critiqueType = (hash: string): CritiqueType => (p.critiqueType === 'Amendment' ? { type: 'Amendment', suggestedChangeHash: hash } : { type: p.critiqueType });
  const draftHash = p.critiqueHash?.toLowerCase() ?? '00'.repeat(32);
  const draft: CritiqueDatum = {
    criticDid: start.agent.id, criticCredential: { type: 'VerificationKey', hash: start.agent.keyHash }, proposalRef: target.seed,
    critiqueHash: draftHash, storageUri: utf8Hex(p.storageUri ?? 'ipfs://'), critiqueType: critiqueType(draftHash), stakeAmount: stake,
    submittedAt: start.window.lo, incorporated: false,
  };
  const problems = critiqueProblems(draft, target.datum, params);
  if (p.critiqueType !== 'Amendment') {
    problems.push(...distinctPartyProblems(start.agent.id, start.agent.record.record, draft.criticCredential, target.datum, (await proposerRecord(ctx, target.datum)).record));
  }
  refuse('critique', problems);
  const doc = await documentOf('critique', p.critiqueDocument, p.critiqueHash, p.storageUri);
  const datum: CritiqueDatum = { ...draft, critiqueHash: doc.hash, storageUri: utf8Hex(doc.uri), critiqueType: critiqueType(doc.hash) };
  const lock = await payLock(ctx, start, gov.critiqueAddress, encodeCritiqueDatum(datum), stake);
  return {
    ...lock, seed: refText(target.seed), proposal: `${target.utxo.txHash}#${target.utxo.outputIndex}`, proposerDid: didOf(target.datum.proposerDid),
    critiqueType: p.critiqueType, critiqueHash: doc.hash, storageUri: doc.uri, ...(doc.ipfsCid ? { ipfsCid: doc.ipfsCid, documentHash: doc.hash } : {}), datum,
  };
}

export interface EndorseLockParams extends GovBuildCommon, ProposalNamed {
  agentDid: string;
  credentialKeyHash?: string;
  stakeApex: number;
}
export interface EndorseLockBuild extends LockBuild { seed: string; proposal: string; proposerDid: string; datum: EndorsementDatum }

/**
 * Step 1 of an endorsement: locks the endorsement datum (stake + 2 AP3X) at the endorsement validator, with proposal_ref = the seed of
 * the proposal. The rules of MintEndorsementToken are checked first: the identity check, the proposal is submitted and Open or Amended,
 * the stake, and the rule of different parties against the proposer's record.
 */
export async function buildEndorseLock(ctx: GovContext, p: EndorseLockParams): Promise<EndorseLockBuild> {
  if (!(p.stakeApex >= MIN_ENDORSE_STAKE_APEX)) throw new Error(`Endorsement stake must be at least ${MIN_ENDORSE_STAKE_APEX} AP3X.`);
  const stake = apexToLovelace(p.stakeApex);
  const { gov, provider } = ctx;
  const start = await lockStart(ctx, p, 'endorser');
  const target = await resolveProposal(provider, gov, namedRef(p), ctx.koios);
  const { params } = await findParamsRecord(provider, gov);
  await findCrossRefs(provider, gov);
  const datum: EndorsementDatum = {
    endorserDid: start.agent.id, endorserCredential: { type: 'VerificationKey', hash: start.agent.keyHash }, proposalRef: target.seed,
    stakeAmount: stake, createdAt: start.window.lo,
  };
  refuse('endorsement', [
    ...endorsementProblems(datum, target.datum, params),
    ...distinctPartyProblems(start.agent.id, start.agent.record.record, datum.endorserCredential, target.datum, (await proposerRecord(ctx, target.datum)).record),
  ]);
  const lock = await payLock(ctx, start, gov.endorsementAddress, encodeEndorsementDatum(datum), stake);
  return { ...lock, seed: refText(target.seed), proposal: `${target.utxo.txHash}#${target.utxo.outputIndex}`, proposerDid: didOf(target.datum.proposerDid), datum };
}

// ─── Creations (step 2) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Step 2 takes the confirmed lock of step 1. */
export interface LockSpendParams extends GovBuildCommon {
  /** The acting agent; it must be the agent of the locked datum. */
  agentDid: string;
  lockTxHash: string;
  lockOutputIndex?: number;
}

/** The lock of step 1 on the node: unspent, at `address`, with an inline datum and AP3X only (a created position holds its token). */
async function readLock(provider: Provider, p: LockSpendParams, address: string, what: string): Promise<{ ref: OutRef; utxo: UTxO; datum: string }> {
  const ref = { txHash: p.lockTxHash.trim().toLowerCase(), outputIndex: p.lockOutputIndex ?? 0 };
  const [utxo] = await provider.getUtxosByOutRef([ref]);
  if (!utxo) {
    throw new Error(`The ${what} lock ${refText(ref)} is not an unspent output: has the lock transaction confirmed? Run vector_await_transaction { txHash } first. A lock that step 2 has spent is gone too.`);
  }
  if (utxo.address !== address) throw new Error(`${refText(ref)} is not at the ${what} validator address ${address} (found ${utxo.address}): pass the lock transaction that step 1 returned.`);
  if (!utxo.datum) throw new Error(`${refText(ref)} has no inline datum: the lock transaction may be malformed.`);
  if (Object.keys(utxo.assets).some((unit) => unit !== 'lovelace')) throw new Error(`${refText(ref)} holds tokens: it is not a ${what} lock (a created ${what} holds its token).`);
  return { ref, utxo, datum: utxo.datum };
}

function decodedLock<T>(decode: (hex: string) => T, lock: { ref: OutRef; datum: string }, what: string): T {
  try { return decode(lock.datum); } catch (err) { throw new Error(`The datum of ${refText(lock.ref)} is not a ${what} datum: ${errorText(err)}`); }
}

/** The common part of the three creations: the window and the wallet (with collateral). */
async function creationStart(ctx: GovContext, p: LockSpendParams): Promise<{ window: Window; walletKeyHash: string; agentId: string }> {
  await chainClock(ctx.provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(ctx.lucid, p.changeAddress);
  return { window, walletKeyHash: wallet.keyHash, agentId: identifierOf(p.agentDid) };
}

function sameAgent(found: string, given: string, what: string): void {
  if (found !== given) throw new Error(`${what} mismatch: the lock belongs to ${didOf(found)}, not ${didOf(given)}.`);
}

/** What every creation returns besides the build. */
export interface CreationBuild extends SignedByBuild {
  id: string;
  did: string;
  /** The seed of the proposal: for a proposal the lock that it spent, for a critique or endorsement the proposal it names. */
  seed: string;
  /** The created position, `<txHash>#<index>` of this transaction. */
  position: string;
  tokenName: string;
}

export interface ProposalSpendBuild extends CreationBuild {
  activityTokenName: string;
  /** True when this first submission inserts the agent's node into the activity list. */
  inserted: boolean;
  /** The entry after which the node is inserted: 'head' or a DID; null for a later submission. */
  predecessor: string | null;
  /** The active proposals of the agent after this submission. */
  activeProposals: number;
  datum: ProposalDatum;
}

/**
 * Step 2 of a proposal (SubmitProposal). Spends the lock with SubmitProposal and exactly one entry of the activity list with
 * SpendActivity: the agent's node, or for its first proposal its predecessor in the list. Mints the proposal token of the seed (the
 * lock) and, for the first proposal, the agent's activity token. Outputs: the proposal at the lock's address with the lock's AP3X and
 * the token, submitted_at = lo; the node continued with the count plus one and last_proposal_slot = lo, or the new node with the
 * predecessor's next_did; for an insertion, the predecessor continued with next_did = the agent. Reference inputs: the record chain,
 * the GovernanceParams record, CrossRefs and the two reference scripts. The proposer credential signs.
 */
export async function buildProposalSpend(ctx: GovContext, p: LockSpendParams): Promise<ProposalSpendBuild> {
  const { lucid, provider, gov } = ctx;
  const { window, walletKeyHash, agentId } = await creationStart(ctx, p);
  const lock = await readLock(provider, p, gov.proposalAddress, 'proposal');
  const locked = decodedLock(decodeProposalDatum, lock, 'proposal');
  sameAgent(locked.proposerDid, agentId, 'Proposer DID');
  const agent = await activeAgent(ctx, agentId, keyOf(locked.proposerCredential, 'proposer'), window, 'proposer');
  const params = await findParamsRecord(provider, gov);
  const crossRefs = await findCrossRefs(provider, gov);
  const datum: ProposalDatum = { ...locked, submittedAt: window.lo };
  refuse('proposal', proposalProblems(datum, params.params));
  const list = activityListFrom(await provider.getUtxos(gov.proposalAddress), gov);
  const node = activityNode(list, agentId);
  const rate = rateLimitProblem(node, params.params, window.lo);
  if (rate) throw new Error(`The submission breaks the rate limit: ${rate}.`);
  const entry = node ?? activityPredecessor(list, agentId);
  const scripts = [await readGovRefScript(provider, gov, 'proposalSpend'), await readGovRefScript(provider, gov, 'proposalMint')];

  const tokenName = deriveProposalTokenName(lock.ref.txHash, lock.ref.outputIndex);
  const activityTokenName = deriveActivityTokenName(agentId);
  const proposalUnit = `${gov.proposalMint}${tokenName}`;
  const activityUnit = `${gov.proposalMint}${activityTokenName}`;
  let tx = lucid.newTx()
    .collectFrom([lock.utxo], SUBMIT_PROPOSAL_REDEEMER)
    .collectFrom([entry.utxo], SPEND_ACTIVITY_REDEEMER)
    .mintAssets(node ? { [proposalUnit]: 1n } : { [activityUnit]: 1n, [proposalUnit]: 1n }, SUBMIT_PROPOSAL_REDEEMER)
    .pay.ToContract(lock.utxo.address, { kind: 'inline', value: encodeProposalDatum(datum) }, { lovelace: lock.utxo.assets.lovelace, [proposalUnit]: 1n });
  let activeProposals = 1;
  if (node) {
    activeProposals = node.datum.activeProposalCount + 1;
    const continued = encodeActivityDatum({ ...node.datum, activeProposalCount: activeProposals, lastProposalSlot: window.lo });
    tx = tx.pay.ToContract(node.utxo.address, { kind: 'inline', value: continued }, continuedValue(lucid, node.utxo, continued));
  } else {
    const fresh: ActivityDatum = { agentDid: agentId, agentCredential: datum.proposerCredential, activeProposalCount: 1, lastProposalSlot: window.lo, nextDid: entry.datum.nextDid };
    const freshHex = encodeActivityDatum(fresh);
    const minimum = minimumLovelace(lucid, lock.utxo.address, { [activityUnit]: 1n }, freshHex);
    tx = tx.pay.ToContract(lock.utxo.address, { kind: 'inline', value: freshHex }, { lovelace: ACTIVITY_LOVELACE > minimum ? ACTIVITY_LOVELACE : minimum, [activityUnit]: 1n });
    const predecessor = encodeActivityDatum({ ...entry.datum, nextDid: agentId });
    tx = tx.pay.ToContract(entry.utxo.address, { kind: 'inline', value: predecessor }, continuedValue(lucid, entry.utxo, predecessor));
  }
  const completed = await tx
    .readFrom(uniqueUtxos([...scripts, ...agentRefs(agent), params.utxo, crossRefs.utxo]))
    .addSignerKey(agent.keyHash)
    .validFrom(window.lo)
    .validTo(window.hi)
    .complete();
  const result = signedByResult(completed, window, new SignerList().add(agent.keyHash, `proposer credential (${agent.role})`), walletKeyHash);
  const index = outputIndexWhere(result.txCbor, (o) => holdsUnit(o, lock.utxo.address, proposalUnit), 'proposal output');
  return {
    ...result, id: agentId, did: agent.did, seed: refText(lock.ref), position: `${result.txHash}#${index}`, tokenName, activityTokenName,
    inserted: node === null, predecessor: node ? null : entry === list.head ? 'head' : didOf(entry.datum.agentDid), activeProposals, datum,
  };
}

export interface CritiqueSpendBuild extends CreationBuild { proposal: string; datum: CritiqueDatum }

/**
 * Step 2 of a critique (MintCritiqueToken). Spends the lock and mints its critique token through critique_mint. Output: the critique at
 * the lock's address with the lock's AP3X and the token, submitted_at = lo. Reference inputs: the record chain, the GovernanceParams
 * record, CrossRefs, the proposal (it holds the token of the seed) and, except for an Amendment critique, the proposer's record. The
 * critic credential signs.
 */
export async function buildCritiqueSpend(ctx: GovContext, p: LockSpendParams): Promise<CritiqueSpendBuild> {
  const { lucid, provider, gov } = ctx;
  const { window, walletKeyHash, agentId } = await creationStart(ctx, p);
  const lock = await readLock(provider, p, gov.critiqueAddress, 'critique');
  const locked = decodedLock(decodeCritiqueDatum, lock, 'critique');
  sameAgent(locked.criticDid, agentId, 'Critic DID');
  const agent = await activeAgent(ctx, agentId, keyOf(locked.criticCredential, 'critic'), window, 'critic');
  const params = await findParamsRecord(provider, gov);
  const crossRefs = await findCrossRefs(provider, gov);
  const target = await requireProposalBySeed(provider, gov, locked.proposalRef);
  const datum: CritiqueDatum = { ...locked, submittedAt: window.lo };
  const problems = critiqueProblems(datum, target.datum, params.params);
  const refs = [...agentRefs(agent), params.utxo, crossRefs.utxo, target.utxo];
  if (datum.critiqueType.type !== 'Amendment') {
    const proposer = await proposerRecord(ctx, target.datum);
    problems.push(...distinctPartyProblems(agentId, agent.record.record, datum.criticCredential, target.datum, proposer.record));
    refs.push(proposer.utxo);
  }
  refuse('critique', problems);
  const scripts = [await readGovRefScript(provider, gov, 'critiqueSpend'), await readGovRefScript(provider, gov, 'critiqueMint')];
  const tokenName = deriveCritiqueTokenName(lock.ref.txHash, lock.ref.outputIndex);
  return createPosition(ctx, { window, walletKeyHash, agent, lock, refs: [...scripts, ...refs], redeemer: MINT_CRITIQUE_TOKEN_REDEEMER, tokenName, datum: encodeCritiqueDatum(datum), role: 'critic', target }, { datum });
}

export interface EndorseSpendBuild extends CreationBuild { proposal: string; datum: EndorsementDatum }

/**
 * Step 2 of an endorsement (MintEndorsementToken). Spends the lock and mints the endorsement token gend_(endorser, seed) through
 * critique_mint, which finds the endorsement input with the endorsement validator hash of CrossRefs. Output: the endorsement at the
 * lock's address with the lock's AP3X and the token, created_at = lo. Reference inputs: the record chain, the GovernanceParams record,
 * CrossRefs, the proposal and the proposer's record. The endorser credential signs.
 */
export async function buildEndorseSpend(ctx: GovContext, p: LockSpendParams): Promise<EndorseSpendBuild> {
  const { provider, gov } = ctx;
  const { window, walletKeyHash, agentId } = await creationStart(ctx, p);
  const lock = await readLock(provider, p, gov.endorsementAddress, 'endorsement');
  const locked = decodedLock(decodeEndorsementDatum, lock, 'endorsement');
  sameAgent(locked.endorserDid, agentId, 'Endorser DID');
  const agent = await activeAgent(ctx, agentId, keyOf(locked.endorserCredential, 'endorser'), window, 'endorser');
  const params = await findParamsRecord(provider, gov);
  const crossRefs = await findCrossRefs(provider, gov);
  const target = await requireProposalBySeed(provider, gov, locked.proposalRef);
  const proposer = await proposerRecord(ctx, target.datum);
  const datum: EndorsementDatum = { ...locked, createdAt: window.lo };
  refuse('endorsement', [
    ...endorsementProblems(datum, target.datum, params.params),
    ...distinctPartyProblems(agentId, agent.record.record, datum.endorserCredential, target.datum, proposer.record),
  ]);
  const scripts = [await readGovRefScript(provider, gov, 'endorsementSpend'), await readGovRefScript(provider, gov, 'critiqueMint')];
  const tokenName = deriveEndorsementTokenName(locked.endorserDid, locked.proposalRef);
  const refs = [...scripts, ...agentRefs(agent), params.utxo, crossRefs.utxo, target.utxo, proposer.utxo];
  return createPosition(ctx, { window, walletKeyHash, agent, lock, refs, redeemer: MINT_ENDORSEMENT_TOKEN_REDEEMER, tokenName, datum: encodeEndorsementDatum(datum), role: 'endorser', target }, { datum });
}

/** The creation of a critique or an endorsement: one lock spent and one token of critique_mint minted into the new position. */
async function createPosition<T extends object>(
  ctx: GovContext,
  c: { window: Window; walletKeyHash: string; agent: Agent; lock: { ref: OutRef; utxo: UTxO }; refs: UTxO[]; redeemer: string; tokenName: string; datum: string; role: string; target: ProposalTarget },
  extra: T,
): Promise<CreationBuild & { proposal: string } & T> {
  const unit = `${ctx.gov.critiqueMint}${c.tokenName}`;
  const completed = await ctx.lucid.newTx()
    .collectFrom([c.lock.utxo], c.redeemer)
    .mintAssets({ [unit]: 1n }, c.redeemer)
    .pay.ToContract(c.lock.utxo.address, { kind: 'inline', value: c.datum }, { lovelace: c.lock.utxo.assets.lovelace, [unit]: 1n })
    .readFrom(uniqueUtxos(c.refs))
    .addSignerKey(c.agent.keyHash)
    .validFrom(c.window.lo)
    .validTo(c.window.hi)
    .complete();
  const result = signedByResult(completed, c.window, new SignerList().add(c.agent.keyHash, `${c.role} credential (${c.agent.role})`), c.walletKeyHash);
  const index = outputIndexWhere(result.txCbor, (o) => holdsUnit(o, c.lock.utxo.address, unit), `${c.role} output`);
  return {
    ...result, id: c.agent.id, did: c.agent.did, seed: refText(c.target.seed), position: `${result.txHash}#${index}`, tokenName: c.tokenName,
    proposal: `${c.target.utxo.txHash}#${c.target.utxo.outputIndex}`, ...extra,
  };
}

export type { OutputReference };
