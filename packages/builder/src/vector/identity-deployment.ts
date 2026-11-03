// packages/builder/src/vector/identity-deployment.ts
// The identity registry deployment (did:vector, Part 2 Sections 2, 3.8 and 11): the deployment values from the environment, the
// scripts of the identity-marketplace blueprint with their parameters applied, the script addresses, and the reference-script UTxOs
// that the builders spend through. Nothing here signs or submits.
//
// Parameters are applied with apply_params_to_script of @lucid-evolution/uplc, the uplc crate of Aiken compiled to WebAssembly. It
// writes the same bytes as `aiken blueprint apply` (identity-deployment.test.ts pins hashes that the Aiken CLI computed). Lucid's own
// applyParamsToScript does not: it re-encodes the Data constants of the program, which changes the bytes and so the script hash.
//
// The deployment values come only from the environment (or from a test), never from a default: an address derived from a guessed value
// would send funds to a script nobody can spend.
import { Constr, Data, credentialToRewardAddress, validatorToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { Provider, Script, UTxO } from '@lucid-evolution/lucid';
import { apply_params_to_script } from '@lucid-evolution/uplc';
import { IDENTITY_SCRIPTS } from './identity-scripts.generated.js';
import type { IdentityScriptName } from './identity-scripts.generated.js';
import { LEGACY_REGISTRY_POLICY_ID } from './legacy-registry.js';

export interface OutRef { txHash: string; outputIndex: number }

/** One script of the deployment with its parameters applied. */
export interface DeployedScript {
  readonly name: IdentityScriptName;
  /** The script hash: also the policy ID for a minting script. */
  readonly hash: string;
  /** The enterprise address of the script (Part 2 Section 2: the script as payment credential, no stake credential). */
  readonly address: string;
  /** The applied script, as Lucid takes it. */
  readonly script: Script;
}

/** The reference-script UTxOs that a deployment publishes, by the script they hold. */
export type RefName = 'identity' | 'attestation' | 'delegation' | 'vault' | 'escrow' | 'advert' | 'module1';

export interface IdentityDeployment {
  /** The Merkle root of the adoption allowlist (Part 2 Section 3.4), 64 lowercase hex. */
  readonly legacyRoot: string;
  /** The seed of the configuration seal (Part 2 Section 3.8). */
  readonly configSeed: OutRef;
  readonly identity: DeployedScript;
  readonly configHolder: DeployedScript;
  readonly configSeal: DeployedScript;
  readonly attestation: DeployedScript;
  readonly delegation: DeployedScript;
  readonly vault: DeployedScript;
  readonly escrow: DeployedScript;
  readonly advert: DeployedScript;
  /** Reference-script UTxOs, as configured. A builder that needs one that is not set refuses (refScriptUtxo). */
  readonly refs: Readonly<Partial<Record<RefName, OutRef>>>;
  /** The allowlist file (a JSON list of identifiers) that adoption may read its Merkle proof from, when configured. */
  readonly allowlistUrl: string | null;
}

/** The asset name of the configuration token: UTF-8 `identity-config` (Part 2 Section 3.8). */
export const CONFIG_TOKEN_NAME = '6964656e746974792d636f6e666967';

/** The environment variable of each reference-script UTxO. */
export const REF_ENV: Readonly<Record<RefName, string>> = {
  identity: 'VECTOR_IDENTITY_REF_UTXO',
  attestation: 'VECTOR_IDENTITY_ATTESTATION_REF_UTXO',
  delegation: 'VECTOR_IDENTITY_DELEGATION_REF_UTXO',
  vault: 'VECTOR_IDENTITY_VAULT_REF_UTXO',
  escrow: 'VECTOR_IDENTITY_ESCROW_REF_UTXO',
  advert: 'VECTOR_IDENTITY_ADVERT_REF_UTXO',
  module1: 'VECTOR_IDENTITY_MODULE1_REF_UTXO',
};
const ROOT_ENV = 'VECTOR_IDENTITY_LEGACY_ROOT';
const SEED_ENV = 'VECTOR_IDENTITY_CONFIG_SEED';
const POLICY_ENV = 'VECTOR_IDENTITY_POLICY_ID';
const ALLOWLIST_ENV = 'VECTOR_IDENTITY_ALLOWLIST_URL';
/** Every environment variable of the identity deployment. */
export const IDENTITY_ENV = [ROOT_ENV, SEED_ENV, POLICY_ENV, ALLOWLIST_ENV, ...Object.values(REF_ENV)] as const;

/** What a refusal says when the server has no identity deployment. */
export const NOT_CONFIGURED =
  `The identity registry is not configured on this server: set ${ROOT_ENV} and ${SEED_ENV} to the values published with the identity ` +
  'registry deployment (did:vector method specification, Section 4).';

/** The server has no identity deployment, or lacks the value that one call needs. Its message names the environment variable. */
export class IdentityConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'IdentityConfigError'; }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX56 = /^[0-9a-f]{56}$/;

/** `<64 hex>#<index>` as an output reference, or an error that names `what`. */
export function parseRef(value: string, what: string): OutRef {
  const m = /^([0-9a-fA-F]{64})#(0|[1-9][0-9]{0,5})$/.exec(value.trim());
  if (!m) throw new IdentityConfigError(`${what} must be <64 hex characters>#<output index>.`);
  return { txHash: m[1].toLowerCase(), outputIndex: Number(m[2]) };
}

/** Applies `params` (Plutus Data, in order) to the compiled code of a blueprint validator, as `aiken blueprint apply` does. */
export function applyParams(compiledCode: string, params: Data[]): string {
  if (params.length === 0) return compiledCode;
  const applied = apply_params_to_script(Buffer.from(Data.to(params), 'hex'), Buffer.from(compiledCode, 'hex'));
  return Buffer.from(applied).toString('hex');
}

function deployed(name: IdentityScriptName, params: Data[]): DeployedScript {
  const unapplied = IDENTITY_SCRIPTS[name];
  if (unapplied.parameters.length !== params.length) {
    throw new Error(`${unapplied.validator} takes ${unapplied.parameters.length} parameters, got ${params.length}`);
  }
  const script: Script = { type: 'PlutusV3', script: applyParams(unapplied.compiledCode, params) };
  return { name, hash: validatorToScriptHash(script), address: validatorToAddress('Mainnet', script), script };
}

/**
 * The deployment for these values: every script with its parameters applied, in the order of Part 2 Section 3.8 (config_holder,
 * config_seal, identity) and Section 2 (the scripts that take the identity hash, then the vault, which also takes the delegation and
 * escrow hashes). Pure.
 */
export function makeIdentityDeployment(p: {
  legacyRoot: string; configSeed: OutRef; refs?: Partial<Record<RefName, OutRef>>; allowlistUrl?: string | null;
}): IdentityDeployment {
  const legacyRoot = p.legacyRoot.toLowerCase();
  if (!HEX64.test(legacyRoot)) throw new IdentityConfigError(`${ROOT_ENV} must be 64 hex characters (the 32-byte Merkle root).`);
  const configHolder = deployed('config_holder', []);
  const configSeal = deployed('config_seal', [new Constr(0, [p.configSeed.txHash, BigInt(p.configSeed.outputIndex)]), configHolder.hash]);
  const identity = deployed('identity', [LEGACY_REGISTRY_POLICY_ID, legacyRoot, configSeal.hash, configHolder.hash]);
  const attestation = deployed('attestation', [identity.hash]);
  const delegation = deployed('delegation', [identity.hash]);
  const escrow = deployed('escrow', [identity.hash]);
  const vault = deployed('vault', [identity.hash, delegation.hash, escrow.hash]);
  const advert = deployed('advert', []);
  return {
    legacyRoot, configSeed: p.configSeed, identity, configHolder, configSeal, attestation, delegation, vault, escrow, advert,
    refs: { ...(p.refs ?? {}) }, allowlistUrl: p.allowlistUrl ?? null,
  };
}

/**
 * The deployment that the environment describes: null when no identity variable is set (the state before the deployment), else
 * the deployment. Throws an IdentityConfigError, naming the variable, for a value that is malformed, for one of the two required
 * values without the other, and for a VECTOR_IDENTITY_POLICY_ID that is not the policy that the values give.
 */
export function identityDeploymentFrom(env: Record<string, string | undefined>): IdentityDeployment | null {
  const set = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };
  const present = IDENTITY_ENV.filter((name) => set(name) !== undefined);
  if (present.length === 0) return null;
  const root = set(ROOT_ENV);
  const seed = set(SEED_ENV);
  if (root === undefined || seed === undefined) {
    throw new IdentityConfigError(`${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set, but ${root === undefined ? ROOT_ENV : SEED_ENV} is not: set both ${ROOT_ENV} and ${SEED_ENV}, or no VECTOR_IDENTITY_* variable.`);
  }
  if (!HEX64.test(root.toLowerCase())) throw new IdentityConfigError(`${ROOT_ENV} must be 64 hex characters (the 32-byte Merkle root).`);
  const refs: Partial<Record<RefName, OutRef>> = {};
  for (const [name, variable] of Object.entries(REF_ENV) as Array<[RefName, string]>) {
    const value = set(variable);
    if (value !== undefined) refs[name] = parseRef(value, variable);
  }
  const allowlistUrl = set(ALLOWLIST_ENV) ?? null;
  if (allowlistUrl !== null) {
    let protocol = '';
    try { protocol = new URL(allowlistUrl).protocol; } catch { /* refused below */ }
    if (protocol !== 'https:') throw new IdentityConfigError(`${ALLOWLIST_ENV} must be an https URL.`);
  }
  const deployment = makeIdentityDeployment({ legacyRoot: root, configSeed: parseRef(seed, SEED_ENV), refs, allowlistUrl });
  const policy = set(POLICY_ENV)?.toLowerCase();
  if (policy !== undefined) {
    if (!HEX56.test(policy)) throw new IdentityConfigError(`${POLICY_ENV} must be 56 hex characters.`);
    if (policy !== deployment.identity.hash) {
      throw new IdentityConfigError(`${POLICY_ENV} is ${policy}, but ${ROOT_ENV} and ${SEED_ENV} give the identity policy ${deployment.identity.hash}: one of the three values is wrong.`);
    }
  }
  return deployment;
}

let cached: { deployment: IdentityDeployment | null } | null = null;

/**
 * The deployment of this server's environment, read once. The server calls it at startup, so a malformed value stops the start; a
 * tool calls requireIdentityDeployment. Throws as identityDeploymentFrom does.
 */
export function serverIdentityDeployment(env: Record<string, string | undefined> = process.env): IdentityDeployment | null {
  if (cached === null) cached = { deployment: identityDeploymentFrom(env) };
  return cached.deployment;
}

/** The deployment of this server, or an IdentityConfigError that says which variables to set. */
export function requireIdentityDeployment(): IdentityDeployment {
  const deployment = serverIdentityDeployment();
  if (!deployment) throw new IdentityConfigError(NOT_CONFIGURED);
  return deployment;
}

/** One line for the startup log: the identity policy and the reference scripts that are set, or that the registry is not configured. */
export function describeDeployment(deployment: IdentityDeployment | null): string {
  if (!deployment) return `not configured (set ${ROOT_ENV} and ${SEED_ENV} to enable the identity tools)`;
  const refs = (Object.keys(REF_ENV) as RefName[]).map((name) => `${name} ${deployment.refs[name] ? 'set' : 'unset'}`).join(', ');
  return `policy ${deployment.identity.hash}, address ${deployment.identity.address}; reference scripts: ${refs}`;
}

/** The reference-script UTxO `name` of the deployment, or an IdentityConfigError that names its variable. */
export function refOf(deployment: IdentityDeployment, name: RefName): OutRef {
  const ref = deployment.refs[name];
  if (!ref) throw new IdentityConfigError(`${REF_ENV[name]} is not set: it names the UTxO that holds the ${name} reference script, a value published with the deployment.`);
  return ref;
}

const refText = (ref: OutRef): string => `${ref.txHash}#${ref.outputIndex}`;

/**
 * Reads the reference-script UTxO `name` from the node and checks that its script is the one the deployment expects (`expectedHash`;
 * for the deployment's own scripts their hash, for Module-1 the M1 of the configuration record). A UTxO that is gone, holds no
 * script, or holds another script is an error that names the UTxO and the variable.
 */
export async function readRefScript(provider: Pick<Provider, 'getUtxosByOutRef'>, deployment: IdentityDeployment, name: RefName, expectedHash: string): Promise<UTxO> {
  const ref = refOf(deployment, name);
  const [utxo] = await provider.getUtxosByOutRef([ref]);
  if (!utxo) throw new Error(`The ${name} reference script ${refText(ref)} (${REF_ENV[name]}) is not an unspent output on the node.`);
  if (!utxo.scriptRef) throw new Error(`The ${name} reference script ${refText(ref)} (${REF_ENV[name]}) holds no script.`);
  const hash = validatorToScriptHash(utxo.scriptRef);
  if (hash !== expectedHash) throw new Error(`The ${name} reference script ${refText(ref)} (${REF_ENV[name]}) holds script ${hash}, not ${expectedHash}.`);
  return utxo;
}

/** The configuration record (Part 2 Section 3.8): its UTxO at the config_holder address and M1, the 28-byte Module-1 hash in its datum. */
export interface ConfigRecord { utxo: UTxO; m1: string }

/**
 * The configuration record of the deployment, or null before the seal. It is the output at the exact config_holder address that holds
 * the configuration token; nobody can move it. A token output without an inline 28-byte datum cannot exist under the seal policy and
 * is an error.
 */
export async function findConfigRecord(provider: Pick<Provider, 'getUtxos'>, deployment: IdentityDeployment): Promise<ConfigRecord | null> {
  const unit = `${deployment.configSeal.hash}${CONFIG_TOKEN_NAME}`;
  const utxo = (await provider.getUtxos(deployment.configHolder.address)).find((u) => u.assets[unit] === 1n);
  if (!utxo) return null;
  let m1: unknown;
  try { m1 = utxo.datum ? Data.from(utxo.datum) : undefined; } catch { /* refused below */ }
  if (typeof m1 !== 'string' || !HEX56.test(m1.toLowerCase())) throw new Error(`The configuration record ${utxo.txHash}#${utxo.outputIndex} has no 28-byte Module-1 hash as its inline datum.`);
  return { utxo, m1: m1.toLowerCase() };
}

/** The reward address of Module-1's stake credential, which a transaction withdraws from when Module-1 acts as a party (Part 2 Section 3.2, `ok`). */
export function module1RewardAddress(m1: string): string {
  return credentialToRewardAddress('Mainnet', { type: 'Script', hash: m1 });
}
