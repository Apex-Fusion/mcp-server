// packages/builder/src/vector/gov-deployment.ts
// The Module-6 (self-improvement) deployment on the identity registry (Part 2 Section 7): its values from the GOV_* environment
// variables, the values of the previous deployment that only the read tools use, the reference scripts, and the outputs that the
// validators read: the GovernanceParams record, the CrossRefs output, the activity list and the proposals. Reads only.
//
// The deployment values come only from the environment (or a test), never from a default: the new deployment exists only after the
// identity registry and Module-1 and Module-3 are deployed (Part 2 Section 7, deployment order), and an address derived from a guessed
// value would lock funds where no script accepts them. The values are those of the deploy state that the Module-6 deploy script
// writes (vector-agent-modules Module-6/scripts/deploy.py): the applied validator hashes, the record token policy, the CrossRefs token
// policy, the params holder address, the CrossRefs address (the oracle holder), the treasury holder address and the reference-script
// outputs. The params record, the CrossRefs output and the head of the activity list are found by their tokens, because each of them
// moves when it is spent (a parameter update, a CrossRefs move, an insertion after the head).
import { credentialToAddress, getAddressDetails, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import {
  ACTIVITY_HEAD_TOKEN, PARAMS_TOKEN, TOKEN_PREFIX, decodeActivityDatum, decodeCrossRefs, decodeGovernanceParams, decodeProposalDatum,
  deriveActivityTokenName, deriveProposalTokenName,
} from './gov-codec.js';
import type { ActivityDatum, CrossRefs, GovernanceParams, ProposalDatum } from './gov-codec.js';
import { koiosTxInputRefs } from './marketplace-indexer.js';

export interface OutRef { txHash: string; outputIndex: number }

/** The validators of the deployment that the builders spend or mint through reference scripts. */
export type GovRefName = 'proposalSpend' | 'proposalMint' | 'critiqueSpend' | 'critiqueMint' | 'endorsementSpend';

export interface GovDeployment {
  /** Hash of the applied proposal spend validator (proposals and the activity list sit at its address). */
  readonly proposalSpend: string;
  /** Policy of the proposal and activity tokens (prop_, pact_). */
  readonly proposalMint: string;
  readonly critiqueSpend: string;
  /** Policy of the critique and endorsement tokens (crit_, gend_). */
  readonly critiqueMint: string;
  readonly endorsementSpend: string;
  /** The one-shot record token policy: the `params` token of the GovernanceParams record and the `activity` token of the list head. */
  readonly recordTokenPolicy: string;
  /** The policy of the token that authenticates the CrossRefs output. */
  readonly refsTokenPolicy: string;
  /** The params holder address: the GovernanceParams record sits there. */
  readonly paramsAddress: string;
  /** The address of the CrossRefs output (the oracle holder). */
  readonly crossRefsAddress: string;
  readonly treasuryAddress: string;
  readonly proposalAddress: string;
  readonly critiqueAddress: string;
  readonly endorsementAddress: string;
  /** Reference-script UTxOs, as configured. A builder that needs one that is not set refuses and names its variable. */
  readonly refs: Readonly<Partial<Record<GovRefName, OutRef>>>;
}

/** The enterprise address of a script (no stake credential), as the Module-6 deploy script writes it. */
export const scriptAddress = (hash: string): string => credentialToAddress('Mainnet', { type: 'Script', hash });

/**
 * The Module-6 deployment before the identity registry: its validators read the legacy agent registry. Its positions stay there under
 * the old rules until their owners exit (Part 2 Section 7, "Old positions"). Only the read tools use these values; no tool builds a
 * transaction for that deployment.
 */
export const PREVIOUS_GOV_DEPLOYMENT = {
  proposalSpend: 'f815f51a76002d6a973e83fecf60f45473e040acee85c631fcce134d',
  proposalMint: 'e8f38052352a3d20c5fe025e2a02d615826a154b26f2239286b8d565',
  critiqueSpend: 'ced52074861af95e2082004d6061b0fc4bb30fded61f9605bfc20e55',
  critiqueMint: '2e252a89894d379ce5c0023a57de4627056e4a96da72bd8fedba04bd',
  endorsementSpend: '5fc449848d85f30287e5bc0bd2b3e95d872ef97be27f1480c12f1a9d',
  treasuryAddress: 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8',
} as const;

// ─── Environment ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type HashName = 'proposalSpend' | 'proposalMint' | 'critiqueSpend' | 'critiqueMint' | 'endorsementSpend' | 'recordTokenPolicy' | 'refsTokenPolicy';
type AddressName = 'paramsAddress' | 'crossRefsAddress' | 'treasuryAddress';

/** The environment variable of each required value. */
export const GOV_ENV: Readonly<Record<HashName | AddressName, string>> = {
  proposalSpend: 'GOV_PROPOSAL_SPEND_HASH',
  proposalMint: 'GOV_PROPOSAL_MINT_HASH',
  critiqueSpend: 'GOV_CRITIQUE_SPEND_HASH',
  critiqueMint: 'GOV_CRITIQUE_MINT_HASH',
  endorsementSpend: 'GOV_ENDORSEMENT_SPEND_HASH',
  recordTokenPolicy: 'GOV_RECORD_TOKEN_POLICY',
  refsTokenPolicy: 'GOV_REFS_TOKEN_POLICY',
  paramsAddress: 'GOV_PARAMS_ADDRESS',
  crossRefsAddress: 'GOV_CROSSREFS_ADDRESS',
  treasuryAddress: 'GOV_TREASURY_ADDRESS',
};
/** The environment variable of each reference-script UTxO. */
export const GOV_REF_ENV: Readonly<Record<GovRefName, string>> = {
  proposalSpend: 'GOV_PROPOSAL_SPEND_REF',
  proposalMint: 'GOV_PROPOSAL_MINT_REF',
  critiqueSpend: 'GOV_CRITIQUE_SPEND_REF',
  critiqueMint: 'GOV_CRITIQUE_MINT_REF',
  endorsementSpend: 'GOV_ENDORSEMENT_SPEND_REF',
};
const REQUIRED = Object.keys(GOV_ENV) as Array<HashName | AddressName>;

/** The server has no Module-6 deployment, or lacks a value that one call needs. Its message names the environment variable. */
export class GovConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'GovConfigError'; }
}

/** What a build tool says when the server has no Module-6 deployment. */
export const GOV_NOT_CONFIGURED =
  `The Module-6 deployment on the identity registry is not configured on this server: set ${REQUIRED.map((n) => GOV_ENV[n]).join(', ')} ` +
  'to the values of its deploy state (Part 2 Section 7). The positions of the previous deployment stay readable with ' +
  "vector_self_improvement_browse and vector_self_improvement_analyze_metrics { deployment: 'previous' }.";

const HEX56 = /^[0-9a-f]{56}$/;
const PREVIOUS_HASHES: readonly string[] = [
  PREVIOUS_GOV_DEPLOYMENT.proposalSpend, PREVIOUS_GOV_DEPLOYMENT.proposalMint, PREVIOUS_GOV_DEPLOYMENT.critiqueSpend,
  PREVIOUS_GOV_DEPLOYMENT.critiqueMint, PREVIOUS_GOV_DEPLOYMENT.endorsementSpend,
];

function hashValue(name: HashName, value: string): string {
  const hash = value.trim().toLowerCase();
  if (!HEX56.test(hash)) throw new GovConfigError(`${GOV_ENV[name]} must be 56 hex characters (a 28-byte hash).`);
  if (hash === '00'.repeat(28)) throw new GovConfigError(`${GOV_ENV[name]} is all zero.`);
  if (PREVIOUS_HASHES.includes(hash)) {
    throw new GovConfigError(`${GOV_ENV[name]} is a hash of the previous Module-6 deployment, whose validators read the legacy agent registry: set the values of the new deployment (Part 2 Section 7).`);
  }
  return hash;
}

function scriptAddressValue(name: AddressName, value: string): string {
  const address = value.trim();
  let credential: { type: string; hash: string } | undefined;
  try { credential = getAddressDetails(address).paymentCredential; } catch { /* refused below */ }
  if (!credential) throw new GovConfigError(`${GOV_ENV[name]} is not a valid address.`);
  if (credential.type !== 'Script') throw new GovConfigError(`${GOV_ENV[name]} must be a script address (a holder script of the deployment).`);
  if (name === 'treasuryAddress' && address === PREVIOUS_GOV_DEPLOYMENT.treasuryAddress) {
    throw new GovConfigError(`${GOV_ENV[name]} is the treasury of the previous Module-6 deployment: set the treasury holder address of the new deployment.`);
  }
  return address;
}

function refValue(name: GovRefName, value: string): OutRef {
  const m = /^([0-9a-fA-F]{64})#(0|[1-9][0-9]{0,5})$/.exec(value.trim());
  if (!m) throw new GovConfigError(`${GOV_REF_ENV[name]} must be <64 hex characters>#<output index>.`);
  return { txHash: m[1].toLowerCase(), outputIndex: Number(m[2]) };
}

/** The values of a deployment (hashes and policies as hex, addresses as bech32), as the environment or a test gives them. */
export type GovValues = Record<HashName | AddressName, string> & { refs?: Partial<Record<GovRefName, OutRef>> };

/** The deployment for these values, checked. Pure. */
export function makeGovDeployment(v: GovValues): GovDeployment {
  const hashes = Object.fromEntries((['proposalSpend', 'proposalMint', 'critiqueSpend', 'critiqueMint', 'endorsementSpend', 'recordTokenPolicy', 'refsTokenPolicy'] as HashName[])
    .map((name) => [name, hashValue(name, v[name])])) as Record<HashName, string>;
  return {
    ...hashes,
    paramsAddress: scriptAddressValue('paramsAddress', v.paramsAddress),
    crossRefsAddress: scriptAddressValue('crossRefsAddress', v.crossRefsAddress),
    treasuryAddress: scriptAddressValue('treasuryAddress', v.treasuryAddress),
    proposalAddress: scriptAddress(hashes.proposalSpend),
    critiqueAddress: scriptAddress(hashes.critiqueSpend),
    endorsementAddress: scriptAddress(hashes.endorsementSpend),
    refs: { ...(v.refs ?? {}) },
  };
}

/**
 * The deployment that the environment describes: null when no GOV_* variable is set (the state before the deployment), else the
 * deployment. Throws a GovConfigError, naming the variable, for a malformed value, for a value of the previous deployment, and for a
 * set of values without one of the required ones.
 */
export function govDeploymentFrom(env: Record<string, string | undefined>): GovDeployment | null {
  const set = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };
  const present = [...REQUIRED.map((n) => GOV_ENV[n]), ...Object.values(GOV_REF_ENV)].filter((name) => set(name) !== undefined);
  if (present.length === 0) return null;
  const missing = REQUIRED.filter((n) => set(GOV_ENV[n]) === undefined).map((n) => GOV_ENV[n]);
  if (missing.length > 0) {
    throw new GovConfigError(`${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not: set every value of the Module-6 deployment, or no GOV_* variable.`);
  }
  const refs: Partial<Record<GovRefName, OutRef>> = {};
  for (const name of Object.keys(GOV_REF_ENV) as GovRefName[]) {
    const value = set(GOV_REF_ENV[name]);
    if (value !== undefined) refs[name] = refValue(name, value);
  }
  return makeGovDeployment({ ...(Object.fromEntries(REQUIRED.map((n) => [n, set(GOV_ENV[n])!])) as Record<HashName | AddressName, string>), refs });
}

let cached: { deployment: GovDeployment | null } | null = null;

/** The deployment of this server's environment, read once. The server calls it at startup, so a malformed value stops the start. */
export function serverGovDeployment(env: Record<string, string | undefined> = process.env): GovDeployment | null {
  if (cached === null) cached = { deployment: govDeploymentFrom(env) };
  return cached.deployment;
}

/** The deployment of this server, or a GovConfigError that says which variables to set. */
export function requireGovDeployment(): GovDeployment {
  const deployment = serverGovDeployment();
  if (!deployment) throw new GovConfigError(GOV_NOT_CONFIGURED);
  return deployment;
}

/** One line for the startup log: the proposal validator and the reference scripts that are set, or that Module-6 is not configured. */
export function describeGovDeployment(deployment: GovDeployment | null): string {
  if (!deployment) return 'not configured (set the GOV_* values of the new deployment to enable the self-improvement build tools; the read tools can read the previous deployment)';
  const refs = (Object.keys(GOV_REF_ENV) as GovRefName[]).map((name) => `${name} ${deployment.refs[name] ? 'set' : 'unset'}`).join(', ');
  return `proposal validator ${deployment.proposalSpend}, address ${deployment.proposalAddress}; reference scripts: ${refs}`;
}

// ─── Reference scripts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const refText = (ref: OutRef): string => `${ref.txHash}#${ref.outputIndex}`;

/**
 * Reads the reference-script UTxO `name` from the node and checks that it holds the deployment's script of that name. A UTxO that is
 * not set, is gone, holds no script or holds another script is an error that names the UTxO and the variable.
 */
export async function readGovRefScript(provider: Pick<Provider, 'getUtxosByOutRef'>, gov: GovDeployment, name: GovRefName): Promise<UTxO> {
  const ref = gov.refs[name];
  const variable = GOV_REF_ENV[name];
  if (!ref) throw new GovConfigError(`${variable} is not set: it names the UTxO that holds the ${name} reference script, a value of the Module-6 deploy state.`);
  const [utxo] = await provider.getUtxosByOutRef([ref]);
  if (!utxo) throw new Error(`The ${name} reference script ${refText(ref)} (${variable}) is not an unspent output on the node.`);
  if (!utxo.scriptRef) throw new Error(`The ${name} reference script ${refText(ref)} (${variable}) holds no script.`);
  const hash = validatorToScriptHash(utxo.scriptRef);
  if (hash !== gov[name]) throw new Error(`The ${name} reference script ${refText(ref)} (${variable}) holds script ${hash}, not ${gov[name]}.`);
  return utxo;
}

// ─── Records that the validators read ───────────────────────────────────────────────────────────────────────────────────────────

const utxoRef = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The tokens of `policy` in `utxo`: { asset name (hex): quantity }. */
export function policyTokens(utxo: UTxO, policy: string): Record<string, bigint> {
  const tokens: Record<string, bigint> = {};
  for (const [unit, quantity] of Object.entries(utxo.assets)) if (unit.length >= 56 && unit.slice(0, 56) === policy) tokens[unit.slice(56)] = quantity;
  return tokens;
}

export interface ParamsRecord { utxo: UTxO; params: GovernanceParams }

/** The GovernanceParams record: the output at the params holder address with the `params` record token (quantity 1) and an inline datum. */
export async function findParamsRecord(provider: Pick<Provider, 'getUtxos'>, gov: GovDeployment): Promise<ParamsRecord> {
  const unit = `${gov.recordTokenPolicy}${PARAMS_TOKEN}`;
  const utxo = (await provider.getUtxos(gov.paramsAddress)).find((u) => u.assets[unit] === 1n && u.datum);
  if (!utxo) {
    throw new Error(`No GovernanceParams record at ${gov.paramsAddress} (${GOV_ENV.paramsAddress}): no output there holds the record token ${gov.recordTokenPolicy}.params (${GOV_ENV.recordTokenPolicy}). The validators read the parameters only from this record.`);
  }
  try { return { utxo, params: decodeGovernanceParams(utxo.datum!) }; } catch (err) { throw new Error(`The GovernanceParams record ${utxoRef(utxo)} does not decode: ${errorText(err)}`); }
}

export interface CrossRefsRecord { utxo: UTxO; refs: CrossRefs }

/** The CrossRefs that this deployment's validators must read: its five hashes. */
export const expectedCrossRefs = (gov: GovDeployment): CrossRefs => ({
  proposalValidatorHash: gov.proposalSpend, critiqueValidatorHash: gov.critiqueSpend, proposalMintHash: gov.proposalMint,
  critiqueMintHash: gov.critiqueMint, endorsementValidatorHash: gov.endorsementSpend,
});

/**
 * The CrossRefs output of this deployment: an output at the CrossRefs address with a token of the refs policy whose 5-field datum names
 * the five validators of the deployment. A 4-field datum of an older deployment, or one that names other validators, never matches.
 */
export async function findCrossRefs(provider: Pick<Provider, 'getUtxos'>, gov: GovDeployment): Promise<CrossRefsRecord> {
  const expected = expectedCrossRefs(gov);
  for (const utxo of await provider.getUtxos(gov.crossRefsAddress)) {
    if (!utxo.datum || Object.keys(policyTokens(utxo, gov.refsTokenPolicy)).length === 0) continue;
    let refs: CrossRefs;
    try { refs = decodeCrossRefs(utxo.datum); } catch { continue; }
    if ((Object.keys(expected) as Array<keyof CrossRefs>).every((k) => refs[k] === expected[k])) return { utxo, refs };
  }
  throw new Error(
    `No CrossRefs output of this deployment at ${gov.crossRefsAddress} (${GOV_ENV.crossRefsAddress}): no output with a ${gov.refsTokenPolicy} token names ` +
    `proposal_spend ${expected.proposalValidatorHash}, critique_spend ${expected.critiqueValidatorHash}, proposal_mint ${expected.proposalMintHash}, ` +
    `critique_mint ${expected.critiqueMintHash} and endorsement_spend ${expected.endorsementValidatorHash} (the 5-field GovernanceCrossRefs).`,
  );
}

// ─── The activity list (activity_tracking.ak) ───────────────────────────────────────────────────────────────────────────────────

export interface ActivityEntry { utxo: UTxO; datum: ActivityDatum }
/** The head and the nodes in list order, which is ascending byte order of the agent identifiers. */
export interface ActivityList { head: ActivityEntry; nodes: ActivityEntry[] }

/**
 * The activity list from the outputs at the proposal validator. The head holds the `activity` record token (quantity 1), no token of
 * the proposal policy and an empty agent; a node holds exactly the activity token of the agent of its datum. The list is walked from
 * the head through next_did: each named node must exist, the order must be strictly ascending, and every node must be on the walk.
 * Refuses a missing head and a list that breaks these rules (the contract rules cannot produce one).
 */
export function activityListFrom(utxos: UTxO[], gov: GovDeployment): ActivityList {
  const headUnit = `${gov.recordTokenPolicy}${ACTIVITY_HEAD_TOKEN}`;
  const heads: ActivityEntry[] = [];
  const nodes = new Map<string, ActivityEntry>();
  for (const utxo of utxos) {
    if (utxo.address !== gov.proposalAddress) continue;
    const headTokens = utxo.assets[headUnit] ?? 0n;
    const tokens = policyTokens(utxo, gov.proposalMint);
    const names = Object.keys(tokens);
    if (headTokens === 0n && !names.some((n) => n.startsWith(TOKEN_PREFIX.activity))) continue; // proposals, locks and other outputs
    if (!utxo.datum) throw new Error(`The activity list entry ${utxoRef(utxo)} has no inline datum.`);
    let datum: ActivityDatum;
    try { datum = decodeActivityDatum(utxo.datum); } catch (err) { throw new Error(`The activity list entry ${utxoRef(utxo)} does not decode: ${errorText(err)}`); }
    if (headTokens > 0n) {
      if (headTokens !== 1n || names.length > 0 || datum.agentDid !== '') throw new Error(`${utxoRef(utxo)} holds the activity record token but is not a valid head of the activity list.`);
      heads.push({ utxo, datum });
      continue;
    }
    if (datum.agentDid === '' || names.length !== 1 || tokens[deriveActivityTokenName(datum.agentDid)] !== 1n) {
      throw new Error(`${utxoRef(utxo)} holds an activity token but is not the node of its agent.`);
    }
    if (nodes.has(datum.agentDid)) throw new Error(`did:vector:${datum.agentDid} has several nodes in the activity list.`);
    nodes.set(datum.agentDid, { utxo, datum });
  }
  if (heads.length === 0) {
    throw new Error(`No head of the activity list at ${gov.proposalAddress}: no output there holds the record token ${gov.recordTokenPolicy}.activity, which the record step of the Module-6 deployment creates.`);
  }
  if (heads.length > 1) throw new Error('Several outputs hold the activity record token.');
  const ordered: ActivityEntry[] = [];
  let previous = heads[0].datum.agentDid;
  let next = heads[0].datum.nextDid;
  while (next !== '') {
    const node = nodes.get(next);
    if (!node) throw new Error(`The activity list names did:vector:${next}, which has no node.`);
    if (!(previous < next) || ordered.length >= nodes.size) throw new Error('The activity list is not in ascending order.');
    ordered.push(node);
    previous = next;
    next = node.datum.nextDid;
  }
  if (ordered.length !== nodes.size) throw new Error('Some activity nodes are not in the list that starts at the head.');
  return { head: heads[0], nodes: ordered };
}

/** The node of `agentId` in the list, or null before its first proposal. */
export const activityNode = (list: ActivityList, agentId: string): ActivityEntry | null =>
  list.nodes.find((n) => n.datum.agentDid === agentId) ?? null;

/**
 * The entry after which the first submission of `agentId` (X) inserts its node: P with P.agent_did < X and (P.next_did empty or
 * X < P.next_did). The head has the empty identifier, which comes first. Refuses an agent that has a node.
 */
export function activityPredecessor(list: ActivityList, agentId: string): ActivityEntry {
  if (activityNode(list, agentId)) throw new Error(`did:vector:${agentId} already has a node in the activity list; its next submission spends that node.`);
  const entry = [list.head, ...list.nodes].find((e) => e.datum.agentDid < agentId && (e.datum.nextDid === '' || agentId < e.datum.nextDid));
  if (!entry) throw new Error(`The activity list has no predecessor for did:vector:${agentId}.`);
  return entry;
}

// ─── Proposals ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The proposal token of a submitted proposal: its only token of the proposal policy, a `prop_` name with quantity 1. Null for a lock. */
export function proposalTokenOf(utxo: UTxO, gov: Pick<GovDeployment, 'proposalMint'>): string | null {
  const tokens = Object.entries(policyTokens(utxo, gov.proposalMint));
  return tokens.length === 1 && tokens[0][1] === 1n && tokens[0][0].startsWith(TOKEN_PREFIX.proposal) ? tokens[0][0] : null;
}

/** The current output of the proposal whose seed is `seed`: the output at the proposal address that holds proposal_token_name(seed). */
export function proposalBySeed(utxos: UTxO[], gov: GovDeployment, seed: OutRef): UTxO | null {
  const unit = `${gov.proposalMint}${deriveProposalTokenName(seed.txHash, seed.outputIndex)}`;
  return utxos.find((u) => u.address === gov.proposalAddress && u.assets[unit] === 1n) ?? null;
}

/** A proposal that a critique or an endorsement can name: its seed, its current output, its datum and its token. */
export interface ProposalTarget { seed: OutRef; utxo: UTxO; datum: ProposalDatum; token: string }

/** Koios, for the seed of a proposal that is named by its current output. */
export interface KoiosAccess { url: string; fetchImpl: typeof fetch }

/** The most transactions that seedOf follows back from a proposal output: its submission, then one per amendment or review extension. */
export const MAX_SEED_STEPS = 32;

/**
 * The seed of the proposal output `utxo` (it holds the proposal token `token`): the input at the proposal validator, of the
 * transaction that made the output or of one before it, whose proposal_token_name is `token`. The transactions come from Koios tx_info;
 * the seed is proved by the token name, which nothing else can match.
 */
async function seedOf(koios: KoiosAccess, gov: GovDeployment, utxo: UTxO, token: string): Promise<OutRef> {
  const named = utxoRef(utxo);
  const seen = new Set<string>();
  let frontier = [utxo.txHash];
  for (let step = 0; step < MAX_SEED_STEPS && frontier.length > 0; step++) {
    for (const hash of frontier) seen.add(hash);
    let inputs: Map<string, string[]>;
    try { inputs = await koiosTxInputRefs(koios.url, frontier, koios.fetchImpl, gov.proposalSpend); } catch (err) {
      throw new Error(`Could not find the seed of the proposal ${named}: ${errorText(err)}. Name the proposal by its seed instead.`);
    }
    const unknown = frontier.find((hash) => !inputs.has(hash));
    if (unknown) throw new Error(`Koios does not know the transaction ${unknown} yet, so the seed of the proposal ${named} cannot be found; retry later or name the proposal by its seed.`);
    const refs = [...new Set([...inputs.values()].flat())];
    const seed = refs.find((r) => deriveProposalTokenName(r.slice(0, 64), Number(r.slice(65))) === token);
    if (seed) return { txHash: seed.slice(0, 64), outputIndex: Number(seed.slice(65)) };
    frontier = [...new Set(refs.map((r) => r.slice(0, 64)))].filter((hash) => !seen.has(hash));
  }
  throw new Error(`Could not find the seed of the proposal ${named} within ${MAX_SEED_STEPS} transactions; name the proposal by its seed instead.`);
}

function proposalDatumOf(utxo: UTxO): ProposalDatum {
  if (!utxo.datum) throw new Error(`The proposal ${utxoRef(utxo)} has no inline datum.`);
  try { return decodeProposalDatum(utxo.datum); } catch (err) { throw new Error(`The proposal ${utxoRef(utxo)} does not decode: ${errorText(err)}`); }
}

/**
 * The proposal that `ref` names: either its seed (the output that its SubmitProposal spent, which critiques and endorsements write as
 * proposal_ref) or its current output at the proposal validator. For a current output the seed is found through Koios (seedOf).
 */
export async function resolveProposal(provider: Pick<Provider, 'getUtxos'>, gov: GovDeployment, ref: OutRef, koios: KoiosAccess): Promise<ProposalTarget> {
  const utxos = await provider.getUtxos(gov.proposalAddress);
  const bySeed = proposalBySeed(utxos, gov, ref);
  if (bySeed) return { seed: ref, utxo: bySeed, datum: proposalDatumOf(bySeed), token: deriveProposalTokenName(ref.txHash, ref.outputIndex) };
  const own = utxos.find((u) => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
  if (!own) {
    throw new Error(`${refText(ref)} is neither a proposal of this Module-6 deployment nor the seed of one: no output at ${gov.proposalAddress} is ${refText(ref)}, and none holds the proposal token of that seed.`);
  }
  const token = proposalTokenOf(own, gov);
  if (!token) throw new Error(`${refText(ref)} holds no proposal token: it is a proposal lock whose submission (step 2) has not happened, not a submitted proposal.`);
  return { seed: await seedOf(koios, gov, own, token), utxo: own, datum: proposalDatumOf(own), token };
}

/** The proposal whose seed is `seed`, or an error that says it ended (a critique or endorsement lock names it by its seed). */
export async function requireProposalBySeed(provider: Pick<Provider, 'getUtxos'>, gov: GovDeployment, seed: OutRef): Promise<ProposalTarget> {
  const utxo = proposalBySeed(await provider.getUtxos(gov.proposalAddress), gov, seed);
  if (!utxo) throw new Error(`No proposal at ${gov.proposalAddress} holds the proposal token of the seed ${refText(seed)}: the proposal has ended, or the seed names no proposal of this deployment.`);
  return { seed, utxo, datum: proposalDatumOf(utxo), token: deriveProposalTokenName(seed.txHash, seed.outputIndex) };
}
