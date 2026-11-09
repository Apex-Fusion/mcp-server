// packages/builder/src/vector/jury-deployment.ts
// The Module-1 deployment and the jury deployments that the jury tools build against (Module-1/jury/SPEC.md Sections 3, 12.1 and
// 16): their manifests named by the environment, the checks of their values, and the check of each reference script on chain.
//
// - VECTOR_MODULE1_MANIFEST: a file path or an https URL of the Module-1 manifest (`vector-module-deploy/1`, module `module1`, as
//   Module-1/scripts/identity_deploy.py writes it). The claim and challenge tools need it.
// - VECTOR_JURY_MANIFESTS: file paths or https URLs of jury manifests (`vector-module1-jury-deployment/1`, as the jury deploy tool
//   writes it), comma-separated. These are the followed deployments; the first one is the default for new registrations. The juror
//   and case tools need at least one.
//
// No value has a default: an address derived from a guessed value would lock funds where no script accepts them. The environment is
// parsed when the server starts (a malformed value stops the start); the manifests are read, checked against each other and against
// the reference scripts on chain at the first call of a tool that needs them, and kept for the life of the process. A failed load is
// tried again at the next call.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { credentialToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { safeFetch } from './safe-fetch.js';
import { plutusAddressFromBech32, plutusAddressToBech32 } from './identity-codec.js';
import { JURY_PARAM_FIELDS, decodeJuryParams, juryParamsProblems } from './jury-codec.js';
import type { JuryParams } from './jury-codec.js';
import { isObject } from './jury-document.js';

export interface OutRef { txHash: string; outputIndex: number }

/** A script of a deployment: its hash, its enterprise address and the UTxO that holds it as a reference script. */
export interface ScriptRefSpec { hash: string; address: string; ref: OutRef }

export interface Module1Deployment {
  /** The file path or URL of the manifest. */
  source: string;
  network: string;
  /** The identity registry script hash and policy (AuditingConfig.identity_hash). */
  identityHash: string;
  /** The oracle key hash: the relay signs OracleResolve with it (SPEC Section 12.1). */
  oracleVkh: string;
  /** The policy of the token that marks the CrossValidatorRefs output. */
  refsTokenPolicy: string;
  claim: ScriptRefSpec;
  challenge: ScriptRefSpec;
  /** The CrossValidatorRefs output and the ProtocolParams output, which every Module-1 build reads (as the Python builders do). */
  crossRefs: OutRef;
  params: OutRef;
  /** The protocol parameters of the deployment (applied to the scripts). */
  protocol: { minClaimStake: bigint; minChallengeWindow: number; maxChallengeWindow: number; resolutionDeadline: number };
}

export interface JuryDeployment extends ScriptRefSpec {
  source: string;
  network: string;
  /** A test deployment (manifest `test: true`), with values other than the mainnet ones. */
  test: boolean;
  params: JuryParams;
  /** The applied parameter, as the manifest gives it. */
  paramsCbor: string;
  /** The deployment time of the manifest (ISO 8601), when it gives one. */
  time: string | null;
}

export interface JuryConfig { module1: Module1Deployment | null; juries: JuryDeployment[] }

export const MODULE1_MANIFEST_ENV = 'VECTOR_MODULE1_MANIFEST';
export const JURY_MANIFESTS_ENV = 'VECTOR_JURY_MANIFESTS';
export const MODULE1_MANIFEST_FORMAT = 'vector-module-deploy/1';
export const JURY_MANIFEST_FORMAT = 'vector-module1-jury-deployment/1';

/** What a jury tool says when the server follows no jury deployment. */
export const JURY_NOT_CONFIGURED =
  `The Module-1 jury is not configured on this server: set ${JURY_MANIFESTS_ENV} to the jury deployment manifest (a file path or an ` +
  'https URL; several are comma-separated, the default deployment first). The manifest is published with the jury deployment ' +
  '(Module-1/jury/SPEC.md Section 16).';
/** What a Module-1 tool says when the server has no Module-1 manifest. */
export const MODULE1_NOT_CONFIGURED =
  `Module-1 is not configured on this server: set ${MODULE1_MANIFEST_ENV} to the Module-1 deployment manifest (a file path or an https ` +
  'URL; on mainnet Module-1/deploy/identity/mainnet/manifest.json of vector-agent-modules).';

/** A configuration value is malformed or inconsistent. Its message names the variable or the manifest. */
export class JuryConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'JuryConfigError'; }
}

const HEX56 = /^[0-9a-f]{56}$/;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const refText = (ref: OutRef): string => `${ref.txHash}#${ref.outputIndex}`;
/** The enterprise address of a script (no stake credential): where Module-1 and the jury keep their outputs. */
export const scriptAddress = (hash: string): string => credentialToAddress('Mainnet', { type: 'Script', hash });

// ─── Environment ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The manifests that the environment names: file paths or https URLs. */
export interface JurySources { module1: string | null; juries: string[] }

function sourceValue(value: string, variable: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('https://') && !/^[a-z]:[\\/]/i.test(value)) {
    throw new JuryConfigError(`${variable}: ${JSON.stringify(value.slice(0, 120))} is a URL that is not https; give an https URL or a file path.`);
  }
  return value;
}

/** The manifests of the environment. Throws a JuryConfigError for an empty entry, a repeated entry or a URL that is not https. */
export function jurySourcesFrom(env: Record<string, string | undefined>): JurySources {
  const module1 = env[MODULE1_MANIFEST_ENV]?.trim() || null;
  const list = env[JURY_MANIFESTS_ENV]?.trim() || '';
  const juries = list === '' ? [] : list.split(',').map((s) => s.trim());
  if (juries.some((s) => s === '')) throw new JuryConfigError(`${JURY_MANIFESTS_ENV} has an empty entry: give file paths or https URLs, separated by commas.`);
  if (new Set(juries).size !== juries.length) throw new JuryConfigError(`${JURY_MANIFESTS_ENV} names one manifest twice.`);
  return {
    module1: module1 === null ? null : sourceValue(module1, MODULE1_MANIFEST_ENV),
    juries: juries.map((s) => sourceValue(s, JURY_MANIFESTS_ENV)),
  };
}

let cachedSources: JurySources | null = null;

/** The manifests of this server's environment, parsed once. The server calls it at startup, so a malformed value stops the start. */
export function serverJurySources(env: Record<string, string | undefined> = process.env): JurySources {
  if (cachedSources === null) cachedSources = jurySourcesFrom(env);
  return cachedSources;
}

/** One line for the startup log: the manifests that are set, or what is not configured. */
export function describeJurySources(s: JurySources): string {
  const module1 = s.module1 === null ? `Module-1 not configured (set ${MODULE1_MANIFEST_ENV} to enable the claim and challenge tools)` : `Module-1 manifest ${s.module1}`;
  const juries = s.juries.length === 0
    ? `jury not configured (set ${JURY_MANIFESTS_ENV} to enable the juror and case tools)`
    : `jury manifests ${s.juries.join(', ')} (read and checked against the chain at the first call)`;
  return `${module1}; ${juries}`;
}

// ─── Manifests ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The largest manifest that is read. */
const MANIFEST_MAX_BYTES = 1_048_576;

/** Reads a manifest file or https URL as JSON. */
export async function readManifest(source: string, what: string, fetchImpl?: typeof fetch): Promise<unknown> {
  let text: string;
  if (source.startsWith('https://')) {
    let res: { status: number; text: string };
    try { res = await safeFetch(source, { headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' } }, { maxResponseBytes: MANIFEST_MAX_BYTES, timeoutMs: 20_000, fetchImpl }); } catch (err) {
      throw new Error(`${what} ${source} cannot be fetched: ${errorText(err)}`);
    }
    if (res.status !== 200) throw new Error(`${what} ${source} cannot be fetched: the host answered HTTP ${res.status}.`);
    text = res.text;
  } else {
    try { text = await readFile(resolve(source), 'utf8'); } catch (err) { throw new Error(`${what} ${source} cannot be read: ${errorText(err)}`); }
  }
  try { return JSON.parse(text); } catch { throw new JuryConfigError(`${what} ${source} is not JSON.`); }
}

function objectAt(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw new JuryConfigError(`${what} is not a JSON object.`);
  return value;
}
function hashAt(value: unknown, what: string): string {
  const hash = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!HEX56.test(hash)) throw new JuryConfigError(`${what} must be 56 hex characters (a 28-byte hash).`);
  return hash;
}
function refAt(value: unknown, what: string): OutRef {
  const m = typeof value === 'string' ? /^([0-9a-fA-F]{64})#(0|[1-9][0-9]{0,5})$/.exec(value.trim()) : null;
  if (!m) throw new JuryConfigError(`${what} must be <64 hex characters>#<output index>.`);
  return { txHash: m[1].toLowerCase(), outputIndex: Number(m[2]) };
}
function intAt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new JuryConfigError(`${what} must be a positive whole number.`);
  return value;
}
function scriptAt(hashValue: unknown, addressValue: unknown, ref: unknown, what: string): ScriptRefSpec {
  const hash = hashAt(hashValue, `${what} hash`);
  const address = scriptAddress(hash);
  if (addressValue !== address) throw new JuryConfigError(`${what} address ${JSON.stringify(addressValue)} is not ${address}, the address of the script ${hash}.`);
  return { hash, address, ref: refAt(ref, `${what} reference script`) };
}

/** The Module-1 deployment of a manifest, checked. Pure. */
export function module1FromManifest(json: unknown, source: string): Module1Deployment {
  const what = `The Module-1 manifest ${source} (${MODULE1_MANIFEST_ENV})`;
  const m = objectAt(json, what);
  if (m.format !== MODULE1_MANIFEST_FORMAT || m.module !== 'module1') throw new JuryConfigError(`${what} is not a Module-1 deployment manifest (format ${MODULE1_MANIFEST_FORMAT}, module module1).`);
  if (m.not_for_deployment === true || (Array.isArray(m.placeholders) && m.placeholders.length > 0)) throw new JuryConfigError(`${what} is a plan with placeholders, not a deployment.`);
  if (m.mode !== 'oracle') throw new JuryConfigError(`${what} runs in mode ${JSON.stringify(m.mode)}: the jury tools work only with a Module-1 deployment in oracle mode (SPEC Section 1).`);
  const identity = objectAt(m.identity, `${what}: identity`);
  const module1 = objectAt(m.module1, `${what}: module1`);
  const hashes = objectAt(m.hashes, `${what}: hashes`);
  const addresses = objectAt(m.addresses, `${what}: addresses`);
  const pp = objectAt(m.protocol_params, `${what}: protocol_params`);
  if (pp.oracle_active !== true) throw new JuryConfigError(`${what}: protocol_params.oracle_active is not true, so its challenges do not wait for the oracle.`);
  const minChallengeWindow = intAt(pp.min_challenge_window, `${what}: protocol_params.min_challenge_window`);
  const maxChallengeWindow = intAt(pp.max_challenge_window, `${what}: protocol_params.max_challenge_window`);
  if (minChallengeWindow > maxChallengeWindow) throw new JuryConfigError(`${what}: min_challenge_window is above max_challenge_window.`);
  return {
    source, network: typeof m.network === 'string' ? m.network : 'unknown',
    identityHash: hashAt(identity.identity_hash, `${what}: identity.identity_hash`),
    oracleVkh: hashAt(module1.oracle_vkh, `${what}: module1.oracle_vkh`),
    refsTokenPolicy: hashAt(module1.refs_token_policy, `${what}: module1.refs_token_policy`),
    claim: scriptAt(hashes.claim, addresses.claim, m.claim_ref, `${what}: the claim script`),
    challenge: scriptAt(hashes.challenge, addresses.challenge, m.challenge_ref, `${what}: the challenge script`),
    crossRefs: refAt(m.cross_refs_utxo, `${what}: cross_refs_utxo`),
    params: refAt(m.params_utxo, `${what}: params_utxo`),
    protocol: {
      minClaimStake: BigInt(intAt(pp.min_claim_stake, `${what}: protocol_params.min_claim_stake`)), minChallengeWindow, maxChallengeWindow,
      resolutionDeadline: intAt(pp.resolution_deadline, `${what}: protocol_params.resolution_deadline`),
    },
  };
}

/** The jury deployment of a manifest, checked: its parameter CBOR must give the `params` that it lists, and the rules of SPEC Section 3 must hold. Pure. */
export function juryFromManifest(json: unknown, source: string): JuryDeployment {
  const what = `The jury manifest ${source} (${JURY_MANIFESTS_ENV})`;
  const m = objectAt(json, what);
  if (m.format !== JURY_MANIFEST_FORMAT) throw new JuryConfigError(`${what} is not a jury deployment manifest (format ${JURY_MANIFEST_FORMAT}).`);
  const listed = objectAt(m.params, `${what}: params`);
  const extra = Object.keys(listed).filter((k) => !(JURY_PARAM_FIELDS as readonly string[]).includes(k));
  const missing = JURY_PARAM_FIELDS.filter((k) => !(k in listed));
  if (extra.length > 0 || missing.length > 0) throw new JuryConfigError(`${what}: params must have exactly the 16 JuryParams fields (missing: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'}).`);
  const paramsCbor = typeof m.params_cbor === 'string' ? m.params_cbor.trim().toLowerCase() : '';
  let params: JuryParams;
  try { params = decodeJuryParams(paramsCbor); } catch (err) { throw new JuryConfigError(`${what}: params_cbor does not decode as JuryParams: ${errorText(err)}`); }
  const decoded: Record<string, string | bigint | number | null> = {
    identity_hash: params.identityHash, m1_claim: params.m1Claim, m1_challenge: params.m1Challenge, treasury: plutusAddressToBech32(params.treasury),
    bond_min: params.bondMin, slash: params.slash, juror_floor: params.jurorFloor, eligibility_delay: params.eligibilityDelay,
    exit_notice: params.exitNotice, commit_window: params.commitWindow, reveal_window: params.revealWindow, resolve_margin: params.resolveMargin,
    claim_period: params.claimPeriod, quorum: params.quorum, majority_num: params.majorityNum, majority_den: params.majorityDen,
  };
  for (const field of JURY_PARAM_FIELDS) {
    const given = listed[field];
    const value = decoded[field];
    const same = field === 'treasury'
      ? typeof given === 'string' && sameAddress(given, params)
      : typeof value === 'string' ? typeof given === 'string' && given.toLowerCase() === value
        : typeof given === 'number' && Number.isSafeInteger(given) && value !== null && BigInt(given) === BigInt(value);
    if (!same) throw new JuryConfigError(`${what}: params.${field} is ${JSON.stringify(given)}, but params_cbor gives ${String(value)}.`);
  }
  const problems = juryParamsProblems(params);
  if (problems.length > 0) throw new JuryConfigError(`${what}: the parameters break the rules of SPEC Section 3: ${problems.join('; ')}.`);
  const script = scriptAt(m.script_hash, m.address, m.reference_script, `${what}: the jury script`);
  return {
    ...script, source, network: typeof m.network === 'string' ? m.network : 'unknown', test: m.test === true, params, paramsCbor,
    time: typeof m.time === 'string' ? m.time : null,
  };
}

/** Does the bech32 `address` name the treasury of `params`? */
function sameAddress(address: string, params: JuryParams): boolean {
  try { return JSON.stringify(plutusAddressFromBech32(address.trim())) === JSON.stringify(params.treasury); } catch { return false; }
}

// ─── Reference scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Reads the reference-script UTxO of `spec` from the node and checks that its script is `spec.hash`. A UTxO that is gone, holds no
 * script or holds another script is an error that names it (`what` says whose it is).
 */
export async function readScriptRef(provider: Pick<Provider, 'getUtxosByOutRef'>, spec: ScriptRefSpec, what: string): Promise<UTxO> {
  const [utxo] = await provider.getUtxosByOutRef([spec.ref]);
  if (!utxo) throw new Error(`The ${what} reference script ${refText(spec.ref)} is not an unspent output on the node.`);
  if (!utxo.scriptRef) throw new Error(`The ${what} reference script ${refText(spec.ref)} holds no script.`);
  const hash = validatorToScriptHash(utxo.scriptRef);
  if (hash !== spec.hash) throw new Error(`The ${what} reference script ${refText(spec.ref)} holds script ${hash}, not ${spec.hash}.`);
  return utxo;
}

// ─── Loading ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Reads and checks the manifests of `sources`: each on its own, then against each other (the identity hash of Module-1 and of each
 * jury, the Module-1 hashes in each jury's parameters, and `identityHash` of the server's identity deployment when it has one), then
 * each reference script against the chain.
 */
export async function loadJuryConfig(
  sources: JurySources, provider: Pick<Provider, 'getUtxosByOutRef'>, identityHash: string | null, fetchImpl?: typeof fetch,
): Promise<JuryConfig> {
  const module1 = sources.module1 === null ? null : module1FromManifest(await readManifest(sources.module1, `The Module-1 manifest (${MODULE1_MANIFEST_ENV})`, fetchImpl), sources.module1);
  const juries: JuryDeployment[] = [];
  for (const source of sources.juries) juries.push(juryFromManifest(await readManifest(source, `The jury manifest (${JURY_MANIFESTS_ENV})`, fetchImpl), source));
  if (identityHash !== null && module1 && module1.identityHash !== identityHash) {
    throw new JuryConfigError(`The Module-1 manifest ${module1.source} names the identity registry ${module1.identityHash}, but this server's identity deployment is ${identityHash}.`);
  }
  for (const jury of juries) {
    if (identityHash !== null && jury.params.identityHash !== identityHash) {
      throw new JuryConfigError(`The jury manifest ${jury.source} names the identity registry ${jury.params.identityHash}, but this server's identity deployment is ${identityHash}.`);
    }
    if (module1 && (jury.params.m1Claim !== module1.claim.hash || jury.params.m1Challenge !== module1.challenge.hash || jury.params.identityHash !== module1.identityHash)) {
      throw new JuryConfigError(`The jury manifest ${jury.source} reads another Module-1 deployment (claim ${jury.params.m1Claim}, challenge ${jury.params.m1Challenge}) than ${module1.source} (claim ${module1.claim.hash}, challenge ${module1.challenge.hash}).`);
    }
  }
  if (new Set(juries.map((j) => j.hash)).size !== juries.length) throw new JuryConfigError(`${JURY_MANIFESTS_ENV} names one jury deployment twice.`);
  if (module1) {
    await readScriptRef(provider, module1.claim, `Module-1 claim (${module1.source})`);
    await readScriptRef(provider, module1.challenge, `Module-1 challenge (${module1.source})`);
  }
  for (const jury of juries) await readScriptRef(provider, jury, `jury (${jury.source})`);
  return { module1, juries };
}

let loading: Promise<JuryConfig> | null = null;

/** The configuration of this server, loaded once (loadJuryConfig) and kept; a failed load is tried again at the next call. */
export function serverJuryConfig(provider: Pick<Provider, 'getUtxosByOutRef'>, identityHash: string | null): Promise<JuryConfig> {
  if (loading === null) {
    const attempt = loadJuryConfig(serverJurySources(), provider, identityHash);
    loading = attempt;
    attempt.catch(() => { if (loading === attempt) loading = null; });
  }
  return loading;
}

/** The Module-1 deployment of `config`, or the error that says how to configure it. */
export function requireModule1(config: JuryConfig): Module1Deployment {
  if (!config.module1) throw new JuryConfigError(MODULE1_NOT_CONFIGURED);
  return config.module1;
}

/**
 * The jury deployment that `selector` names (its script hash or its address), or the first one without a selector; the error says how
 * to configure the jury when the server follows none.
 */
export function juryOf(config: JuryConfig, selector?: string): JuryDeployment {
  if (config.juries.length === 0) throw new JuryConfigError(JURY_NOT_CONFIGURED);
  if (selector === undefined || selector.trim() === '') return config.juries[0];
  const value = selector.trim();
  const found = config.juries.find((j) => j.hash === value.toLowerCase() || j.address === value);
  if (!found) throw new Error(`This server follows no jury deployment ${JSON.stringify(value.slice(0, 120))}: it follows ${config.juries.map((j) => j.hash).join(', ')}.`);
  return found;
}
