// packages/builder/src/vector/gov-codec.ts
// Plutus Data codecs of the Module-6 (self-improvement) contracts, on Lucid's Data, and the token names that the contracts derive.
// Field and constructor order are the on-chain order of the Aiken types in vector-agent-modules
// Module-6/contracts/governance-suggestion/lib/governance_suggestion/types.ak (feat/identity-registry 91e3823). Every ByteArray is
// lowercase hex (also storage URIs, which are UTF-8 text on chain). Lovelace amounts and the parameters are bigints; times and
// counts are numbers. Decoders check the shape (constructor indices, field counts, fixed byte lengths); the builders check the
// rules of the contracts (gov-build.ts).
//
// The token names follow utils.ak: a prefix and the first 27 bytes of blake2b-256 of the data. An output reference is hashed in its
// Plutus serialisation (builtin serialise_data: constructor 0 with the transaction id and the index, as an indefinite-length list),
// which Lucid's Data.to writes byte for byte (gov-build.test.ts pins a token name that the deployed policy minted).
import { Constr, Data } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import {
  bigintOf, boolData, boolOf, bytesOf, constrFields, constrIndex, hexData, intData, intOf, listOf, outRefData, outRefOf, timeOf,
} from './identity-codec.js';
import type { OutputReference } from './identity-codec.js';

const HEX = /^(?:[0-9a-f]{2})*$/;

function parse(hex: string, what: string): Data {
  if (typeof hex !== 'string' || !HEX.test(hex.toLowerCase())) throw new Error(`${what}: cbor: expected hex`);
  try { return Data.from(hex.toLowerCase()); } catch { throw new Error(`${what}: cbor: not Plutus Data`); }
}
function codec<T>(name: string, body: () => T): T {
  try { return body(); } catch (err) { throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
}
/** Any Plutus integer (the contracts do not bound the values of a ParameterChange). */
function anyIntOf(x: Data, path: string): bigint {
  if (typeof x !== 'bigint') throw new Error(`${path}: expected an integer`);
  return x;
}
const tag = (index: number, fields: Data[] = []): Data => new Constr(index, fields);

// ─── Credentials ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Aiken `Credential`: VerificationKey (constructor 0) or Script (constructor 1), with a 28-byte hash. */
export type GovCredential = { type: 'VerificationKey'; hash: string } | { type: 'Script'; hash: string };

export const credentialData = (c: GovCredential, path = 'credential'): Data =>
  tag(c.type === 'VerificationKey' ? 0 : 1, [hexData(c.hash, `${path}.hash`, 28)]);
export function credentialOf(x: Data, path: string): GovCredential {
  const index = constrIndex(x, path, 2);
  const [hash] = constrFields(x, path, index, 1);
  return { type: index === 0 ? 'VerificationKey' : 'Script', hash: bytesOf(hash, `${path}.hash`, 28) };
}
export const sameCredential = (a: GovCredential, b: GovCredential): boolean => a.type === b.type && a.hash === b.hash;

// ─── ProposalDatum (12 fields) ──────────────────────────────────────────────────────────────────────────────────────────────────

export const PROPOSAL_TYPES = ['ParameterChange', 'TreasurySpend', 'ProtocolUpgrade', 'GameActivation', 'GeneralSuggestion'] as const;
export type ProposalTypeName = typeof PROPOSAL_TYPES[number];
export type ProposalType =
  | { type: 'ParameterChange'; paramName: string; currentValue: bigint; proposedValue: bigint }
  | { type: 'TreasurySpend'; amount: bigint; recipientDescription: string }
  | { type: 'ProtocolUpgrade'; upgradeDescriptionHash: string }
  | { type: 'GameActivation'; gameId: bigint }
  | { type: 'GeneralSuggestion' };
export type ProposalPriority = 'Standard' | 'Emergency';
export const PROPOSAL_STATES = ['Open', 'Amended', 'Adopted', 'Rejected', 'Expired', 'Withdrawn'] as const;
export type ProposalStateName = typeof PROPOSAL_STATES[number];
export type ProposalState =
  | { type: 'Open' } | { type: 'Amended'; hash: string } | { type: 'Adopted'; hash: string } | { type: 'Rejected'; hash: string }
  | { type: 'Expired' } | { type: 'Withdrawn' };

export interface ProposalDatum {
  /** The identifier of the proposer's identity record (32 bytes). */
  proposerDid: string;
  /** The declared credential: stakes and rewards return to it, and its key signs the submission and the amendments. */
  proposerCredential: GovCredential;
  proposalHash: string;
  proposalType: ProposalType;
  /** UTF-8 bytes as hex. */
  storageUri: string;
  stakeAmount: bigint;
  /** POSIX ms: the lower bound of the submission's validity range. */
  submittedAt: number;
  /** Milliseconds. */
  reviewWindow: number;
  priority: ProposalPriority;
  amendmentCount: number;
  incorporatedCritiques: OutputReference[];
  state: ProposalState;
}

function proposalTypeData(t: ProposalType): Data {
  switch (t.type) {
    case 'ParameterChange': return tag(0, [hexData(t.paramName, 'proposal_type.param_name'), t.currentValue, t.proposedValue]);
    case 'TreasurySpend': return tag(1, [t.amount, hexData(t.recipientDescription, 'proposal_type.recipient_description')]);
    case 'ProtocolUpgrade': return tag(2, [hexData(t.upgradeDescriptionHash, 'proposal_type.upgrade_description_hash')]);
    case 'GameActivation': return tag(3, [t.gameId]);
    case 'GeneralSuggestion': return tag(4);
  }
}
function proposalTypeOf(x: Data, path: string): ProposalType {
  const index = constrIndex(x, path, 5);
  if (index === 0) {
    const [name, current, proposed] = constrFields(x, path, 0, 3);
    return { type: 'ParameterChange', paramName: bytesOf(name, `${path}.param_name`), currentValue: anyIntOf(current, `${path}.current_value`), proposedValue: anyIntOf(proposed, `${path}.proposed_value`) };
  }
  if (index === 1) {
    const [amount, description] = constrFields(x, path, 1, 2);
    return { type: 'TreasurySpend', amount: anyIntOf(amount, `${path}.amount`), recipientDescription: bytesOf(description, `${path}.recipient_description`) };
  }
  if (index === 2) return { type: 'ProtocolUpgrade', upgradeDescriptionHash: bytesOf(constrFields(x, path, 2, 1)[0], `${path}.upgrade_description_hash`) };
  if (index === 3) return { type: 'GameActivation', gameId: anyIntOf(constrFields(x, path, 3, 1)[0], `${path}.game_id`) };
  constrFields(x, path, 4, 0);
  return { type: 'GeneralSuggestion' };
}

function proposalStateData(s: ProposalState): Data {
  const index = PROPOSAL_STATES.indexOf(s.type);
  return 'hash' in s ? tag(index, [hexData(s.hash, 'state.hash')]) : tag(index);
}
function proposalStateOf(x: Data, path: string): ProposalState {
  const index = constrIndex(x, path, 6);
  const type = PROPOSAL_STATES[index];
  if (type === 'Amended' || type === 'Adopted' || type === 'Rejected') return { type, hash: bytesOf(constrFields(x, path, index, 1)[0], `${path}.hash`) };
  constrFields(x, path, index, 0);
  return { type } as ProposalState;
}

export function proposalDatumToData(d: ProposalDatum): Data {
  return new Constr(0, [
    hexData(d.proposerDid, 'proposer_did'),
    credentialData(d.proposerCredential, 'proposer_credential'),
    hexData(d.proposalHash, 'proposal_hash'),
    proposalTypeData(d.proposalType),
    hexData(d.storageUri, 'storage_uri'),
    d.stakeAmount,
    intData(d.submittedAt, 'submitted_at'),
    intData(d.reviewWindow, 'review_window'),
    tag(d.priority === 'Emergency' ? 1 : 0),
    intData(d.amendmentCount, 'amendment_count'),
    d.incorporatedCritiques.map((r, i) => outRefData(r, `incorporated_critiques[${i}]`)),
    proposalStateData(d.state),
  ]);
}
export function proposalDatumFromData(x: Data, path = 'proposal'): ProposalDatum {
  const f = constrFields(x, path, 0, 12);
  const priority = constrIndex(f[8], `${path}.priority`, 2);
  constrFields(f[8], `${path}.priority`, priority, 0);
  return {
    proposerDid: bytesOf(f[0], `${path}.proposer_did`),
    proposerCredential: credentialOf(f[1], `${path}.proposer_credential`),
    proposalHash: bytesOf(f[2], `${path}.proposal_hash`),
    proposalType: proposalTypeOf(f[3], `${path}.proposal_type`),
    storageUri: bytesOf(f[4], `${path}.storage_uri`),
    stakeAmount: bigintOf(f[5], `${path}.stake_amount`),
    submittedAt: timeOf(f[6], `${path}.submitted_at`),
    reviewWindow: intOf(f[7], `${path}.review_window`),
    priority: priority === 1 ? 'Emergency' : 'Standard',
    amendmentCount: intOf(f[9], `${path}.amendment_count`),
    incorporatedCritiques: listOf(f[10], `${path}.incorporated_critiques`, outRefOf),
    state: proposalStateOf(f[11], `${path}.state`),
  };
}
export const encodeProposalDatum = (d: ProposalDatum): string => codec('encodeProposalDatum', () => Data.to(proposalDatumToData(d)));
export const decodeProposalDatum = (hex: string): ProposalDatum => codec('decodeProposalDatum', () => proposalDatumFromData(parse(hex, 'proposal')));

// ─── CritiqueDatum (9 fields) ───────────────────────────────────────────────────────────────────────────────────────────────────

export const CRITIQUE_TYPES = ['Supportive', 'Opposing', 'Amendment'] as const;
export type CritiqueTypeName = typeof CRITIQUE_TYPES[number];
export type CritiqueType = { type: 'Supportive' } | { type: 'Opposing' } | { type: 'Amendment'; suggestedChangeHash: string };

export interface CritiqueDatum {
  criticDid: string;
  criticCredential: GovCredential;
  /** The seed of the proposal: the output that its SubmitProposal spent. The proposal holds the token proposal_token_name(seed). */
  proposalRef: OutputReference;
  critiqueHash: string;
  storageUri: string;
  critiqueType: CritiqueType;
  stakeAmount: bigint;
  submittedAt: number;
  incorporated: boolean;
}

function critiqueTypeData(t: CritiqueType): Data {
  return t.type === 'Amendment' ? tag(2, [hexData(t.suggestedChangeHash, 'critique_type.suggested_change_hash')]) : tag(t.type === 'Supportive' ? 0 : 1);
}
function critiqueTypeOf(x: Data, path: string): CritiqueType {
  const index = constrIndex(x, path, 3);
  if (index === 2) return { type: 'Amendment', suggestedChangeHash: bytesOf(constrFields(x, path, 2, 1)[0], `${path}.suggested_change_hash`) };
  constrFields(x, path, index, 0);
  return { type: index === 0 ? 'Supportive' : 'Opposing' };
}

export function critiqueDatumToData(d: CritiqueDatum): Data {
  return new Constr(0, [
    hexData(d.criticDid, 'critic_did'),
    credentialData(d.criticCredential, 'critic_credential'),
    outRefData(d.proposalRef, 'proposal_ref'),
    hexData(d.critiqueHash, 'critique_hash'),
    hexData(d.storageUri, 'storage_uri'),
    critiqueTypeData(d.critiqueType),
    d.stakeAmount,
    intData(d.submittedAt, 'submitted_at'),
    boolData(d.incorporated),
  ]);
}
export function critiqueDatumFromData(x: Data, path = 'critique'): CritiqueDatum {
  const f = constrFields(x, path, 0, 9);
  return {
    criticDid: bytesOf(f[0], `${path}.critic_did`),
    criticCredential: credentialOf(f[1], `${path}.critic_credential`),
    proposalRef: outRefOf(f[2], `${path}.proposal_ref`),
    critiqueHash: bytesOf(f[3], `${path}.critique_hash`),
    storageUri: bytesOf(f[4], `${path}.storage_uri`),
    critiqueType: critiqueTypeOf(f[5], `${path}.critique_type`),
    stakeAmount: bigintOf(f[6], `${path}.stake_amount`),
    submittedAt: timeOf(f[7], `${path}.submitted_at`),
    incorporated: boolOf(f[8], `${path}.incorporated`),
  };
}
export const encodeCritiqueDatum = (d: CritiqueDatum): string => codec('encodeCritiqueDatum', () => Data.to(critiqueDatumToData(d)));
export const decodeCritiqueDatum = (hex: string): CritiqueDatum => codec('decodeCritiqueDatum', () => critiqueDatumFromData(parse(hex, 'critique')));

// ─── GovernanceEndorsementDatum (5 fields) ──────────────────────────────────────────────────────────────────────────────────────

export interface EndorsementDatum {
  endorserDid: string;
  endorserCredential: GovCredential;
  /** The seed of the proposal (see CritiqueDatum.proposalRef). */
  proposalRef: OutputReference;
  stakeAmount: bigint;
  /** POSIX ms: the lower bound of the creation's validity range. */
  createdAt: number;
}

export function endorsementDatumToData(d: EndorsementDatum): Data {
  return new Constr(0, [
    hexData(d.endorserDid, 'endorser_did'),
    credentialData(d.endorserCredential, 'endorser_credential'),
    outRefData(d.proposalRef, 'proposal_ref'),
    d.stakeAmount,
    intData(d.createdAt, 'created_at'),
  ]);
}
export function endorsementDatumFromData(x: Data, path = 'endorsement'): EndorsementDatum {
  const f = constrFields(x, path, 0, 5);
  return {
    endorserDid: bytesOf(f[0], `${path}.endorser_did`),
    endorserCredential: credentialOf(f[1], `${path}.endorser_credential`),
    proposalRef: outRefOf(f[2], `${path}.proposal_ref`),
    stakeAmount: bigintOf(f[3], `${path}.stake_amount`),
    createdAt: timeOf(f[4], `${path}.created_at`),
  };
}
export const encodeEndorsementDatum = (d: EndorsementDatum): string => codec('encodeEndorsementDatum', () => Data.to(endorsementDatumToData(d)));
export const decodeEndorsementDatum = (hex: string): EndorsementDatum => codec('decodeEndorsementDatum', () => endorsementDatumFromData(parse(hex, 'endorsement')));

// ─── ProposerActivityDatum (5 fields): an entry of the activity list ────────────────────────────────────────────────────────────

export interface ActivityDatum {
  /** The agent of the node, or empty for the head of the list. */
  agentDid: string;
  agentCredential: GovCredential;
  activeProposalCount: number;
  /** POSIX ms: the lower bound of the agent's last submission. */
  lastProposalSlot: number;
  /** The agent of the next node in ascending byte order, or empty for the last entry. */
  nextDid: string;
}

export function activityDatumToData(d: ActivityDatum): Data {
  return new Constr(0, [
    hexData(d.agentDid, 'agent_did'),
    credentialData(d.agentCredential, 'agent_credential'),
    intData(d.activeProposalCount, 'active_proposal_count'),
    intData(d.lastProposalSlot, 'last_proposal_slot'),
    hexData(d.nextDid, 'next_did'),
  ]);
}
export function activityDatumFromData(x: Data, path = 'activity'): ActivityDatum {
  const f = constrFields(x, path, 0, 5);
  return {
    agentDid: bytesOf(f[0], `${path}.agent_did`),
    agentCredential: credentialOf(f[1], `${path}.agent_credential`),
    activeProposalCount: intOf(f[2], `${path}.active_proposal_count`),
    lastProposalSlot: timeOf(f[3], `${path}.last_proposal_slot`),
    nextDid: bytesOf(f[4], `${path}.next_did`),
  };
}
export const encodeActivityDatum = (d: ActivityDatum): string => codec('encodeActivityDatum', () => Data.to(activityDatumToData(d)));
export const decodeActivityDatum = (hex: string): ActivityDatum => codec('decodeActivityDatum', () => activityDatumFromData(parse(hex, 'activity')));

// ─── GovernanceParams (21 fields) ───────────────────────────────────────────────────────────────────────────────────────────────

/** The field names of GovernanceParams, in the on-chain order. Times and windows are POSIX milliseconds, amounts lovelace. */
export const GOVERNANCE_PARAM_FIELDS = [
  'minProposalStake', 'minCritiqueStake', 'minGovernanceEndorsement', 'minReviewWindow', 'maxReviewWindow', 'maxAmendments',
  'maxActiveProposals', 'proposalCooldown', 'proposerRewardShare', 'criticRewardShare', 'protocolFeeRate', 'minAdoptionReward',
  'maxAdoptionReward', 'maxIncorporatedCritiques', 'maxTreasuryRequest', 'emergencyStakeMultiplier', 'emergencyReviewWindow',
  'paramExecutionDelay', 'minPredictionPool', 'credibilityPoolLowThreshold', 'credibilityPoolCriticalThreshold',
] as const;
export type GovernanceParams = Record<typeof GOVERNANCE_PARAM_FIELDS[number], bigint>;

export const governanceParamsToData = (p: GovernanceParams): Data => new Constr(0, GOVERNANCE_PARAM_FIELDS.map((name) => p[name]));
export function governanceParamsFromData(x: Data, path = 'params'): GovernanceParams {
  const f = constrFields(x, path, 0, GOVERNANCE_PARAM_FIELDS.length);
  return Object.fromEntries(GOVERNANCE_PARAM_FIELDS.map((name, i) => [name, anyIntOf(f[i], `${path}.${name}`)])) as GovernanceParams;
}
export const encodeGovernanceParams = (p: GovernanceParams): string => codec('encodeGovernanceParams', () => Data.to(governanceParamsToData(p)));
export const decodeGovernanceParams = (hex: string): GovernanceParams => codec('decodeGovernanceParams', () => governanceParamsFromData(parse(hex, 'params')));

// ─── GovernanceCrossRefs (5 fields) ─────────────────────────────────────────────────────────────────────────────────────────────

/** The hashes that the validators read at run time; endorsementValidatorHash (last) lets the critique mint policy find endorsements. */
export interface CrossRefs {
  proposalValidatorHash: string;
  critiqueValidatorHash: string;
  proposalMintHash: string;
  critiqueMintHash: string;
  endorsementValidatorHash: string;
}
const CROSS_REFS_FIELDS = ['proposalValidatorHash', 'critiqueValidatorHash', 'proposalMintHash', 'critiqueMintHash', 'endorsementValidatorHash'] as const;

export const crossRefsToData = (r: CrossRefs): Data => new Constr(0, CROSS_REFS_FIELDS.map((name) => hexData(r[name], name, 28)));
/** The 5-field datum. A 4-field datum (no endorsement_validator_hash) comes from an older deployment and is refused. */
export function crossRefsFromData(x: Data, path = 'cross_refs'): CrossRefs {
  const f = constrFields(x, path, 0, CROSS_REFS_FIELDS.length);
  return Object.fromEntries(CROSS_REFS_FIELDS.map((name, i) => [name, bytesOf(f[i], `${path}.${name}`, 28)])) as unknown as CrossRefs;
}
export const encodeCrossRefs = (r: CrossRefs): string => codec('encodeCrossRefs', () => Data.to(crossRefsToData(r)));
export const decodeCrossRefs = (hex: string): CrossRefs => codec('decodeCrossRefs', () => crossRefsFromData(parse(hex, 'cross_refs')));

// ─── Redeemers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** ProposalAction.SubmitProposal (constructor 0): the lock spend and the proposal mint of a submission. */
export const SUBMIT_PROPOSAL_REDEEMER = Data.to(tag(0));
/** ProposalAction.SpendActivity (constructor 8): the spend of an entry of the activity list. */
export const SPEND_ACTIVITY_REDEEMER = Data.to(tag(8));
/** CritiqueAction.MintCritiqueToken (constructor 0): the lock spend of a critique creation. The critique mint takes it too. */
export const MINT_CRITIQUE_TOKEN_REDEEMER = Data.to(tag(0));
/** GovernanceEndorsementAction.MintEndorsementToken (constructor 0): the lock spend of an endorsement creation, and its mint. */
export const MINT_ENDORSEMENT_TOKEN_REDEEMER = Data.to(tag(0));

// ─── Token names (utils.ak) ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** UTF-8 `prefix` and the first 27 bytes of blake2b-256 of the bytes `dataHex`, as hex. */
export function deriveTokenName(prefix: string, dataHex: string): string {
  const hash = Buffer.from(blake2b(Buffer.from(dataHex, 'hex'), { dkLen: 32 })).toString('hex');
  return Buffer.from(prefix, 'utf-8').toString('hex') + hash.slice(0, 54);
}
const outRefCbor = (txHash: string, outputIndex: number): string => Data.to(outRefData({ txHash, outputIndex }));

/** `prop_`: the token of the proposal whose seed (the output that its SubmitProposal spent) is `txHash#outputIndex`. */
export const deriveProposalTokenName = (txHash: string, outputIndex: number): string => deriveTokenName('prop_', outRefCbor(txHash, outputIndex));
/** `crit_`: the token of the critique created from the lock `txHash#outputIndex`. */
export const deriveCritiqueTokenName = (txHash: string, outputIndex: number): string => deriveTokenName('crit_', outRefCbor(txHash, outputIndex));
/** `gend_`: the token of the endorsement of the agent `endorserId` (32 bytes) for the proposal with the seed `seed`. */
export const deriveEndorsementTokenName = (endorserId: string, seed: OutputReference): string =>
  deriveTokenName('gend_', hexData(endorserId, 'endorser_did') + outRefCbor(seed.txHash, seed.outputIndex));
/** `pact_`: the token of the node of the agent `agentId` (its 32-byte identifier) in the activity list. */
export const deriveActivityTokenName = (agentId: string): string => deriveTokenName('pact_', hexData(agentId, 'agent_did'));

/** UTF-8 `activity`: the record token of the head of the activity list (utils.activity_head_token). */
export const ACTIVITY_HEAD_TOKEN = Buffer.from('activity', 'utf-8').toString('hex');
/** UTF-8 `params`: the record token of the GovernanceParams record (shared/record_auth). */
export const PARAMS_TOKEN = Buffer.from('params', 'utf-8').toString('hex');
/** The hex prefixes of the four token kinds. */
export const TOKEN_PREFIX = {
  proposal: Buffer.from('prop_').toString('hex'), critique: Buffer.from('crit_').toString('hex'),
  endorsement: Buffer.from('gend_').toString('hex'), activity: Buffer.from('pact_').toString('hex'),
} as const;
