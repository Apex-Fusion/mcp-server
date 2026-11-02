// packages/builder/src/vector/identity-chain.ts
// What the identity, attestation, delegation and vault builders share on the chain side: the validity window of Part 2 Section
// 3.2, the lookup of a record by its identifier, the record's ancestors, the configuration record and Module-1's consent, the
// reference scripts, the wallet checks, and the list of key hashes that must sign. Reads only; the builders assemble.
import type { LucidEvolution, Provider, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { Constr, Data } from '@lucid-evolution/lucid';
import { deriveNftAssetName } from '@apexfusion/vector-mcp-shared/tx';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { ensureSlotConfig, paymentKeyHashOf, ChainClockError } from './gov-build.js';
import type { SlotClockProvider } from './gov-build.js';
import { decodeDelegationDatum, decodeIdentityDatum } from './identity-codec.js';
import type { DelegationDatum, IdentityDatum, Signer } from './identity-codec.js';
import { findConfigRecord, module1RewardAddress, readRefScript } from './identity-deployment.js';
import type { ConfigRecord, IdentityDeployment } from './identity-deployment.js';
import { MAX_DEPTH, MAX_RANGE_MS, keyHashOf, signerText } from './identity-rules.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ─── Identifiers and DIDs ───────────────────────────────────────────────────────────────────────────────────────────────────────

const VECTOR_ID = /^[0-9a-f]{64}$/;
const LEGACY_DID = /^did:vector:agent:([0-9a-f]{56}):([0-9a-f]{64})$/;

/** The identifier of a DID in either form (did:vector:<id>, did:vector:agent:<policy>:<id>) or of a bare identifier. Lowercase only, as Part 1 Section 3 requires. */
export function identifierOf(did: string): string {
  const value = did.trim();
  if (VECTOR_ID.test(value)) return value;
  if (value.startsWith('did:vector:') && VECTOR_ID.test(value.slice('did:vector:'.length))) return value.slice('did:vector:'.length);
  const legacy = LEGACY_DID.exec(value);
  if (legacy) return legacy[2];
  throw new Error(`${JSON.stringify(value.slice(0, 120))} is not a did:vector DID: expected did:vector:<64 lowercase hex> or did:vector:agent:<policy>:<64 lowercase hex>.`);
}

/** The canonical DID of an identifier. */
export const didOf = (id: string): string => `did:vector:${id}`;

/** The identifier that a seed gives (Part 1 Section 3.1): blake2b-256 of the Plutus Data CBOR of the output reference. */
export const identifierFromSeed = (seed: { txHash: string; outputIndex: number }): string => deriveNftAssetName(seed.txHash, seed.outputIndex);

// ─── Validity window (Part 2 Section 3.2) ──────────────────────────────────────────────────────────────────────────────────────

export interface Window {
  /** POSIX ms of the lower bound, on a whole second. Elapsed-time checks use it, and status times are set from it. */
  lo: number;
  /** POSIX ms of the upper bound, on a whole second. `created_at` and `issued_at` are set from it; delays that protect others count from it. */
  hi: number;
}

/** How long a build stays valid by default, so that every key holder can sign in turn. */
export const DEFAULT_VALID_MINUTES = 30;
/** The longest a build can stay valid: the window opens a minute before now and is at most one hour long. */
export const MAX_VALID_MINUTES = 59;

/**
 * The validity window of a build at `nowMs`: from the whole second a minute before now (a node a little behind still accepts it) to
 * `validMinutes` after now, so `hi - lo <= 3,600,000` (Part 2 Section 3.2). Both bounds are whole seconds: on a chain whose slots
 * start on whole seconds (chainClock checks it) the script sees exactly these values.
 */
export function windowAt(nowMs: number, validMinutes: number = DEFAULT_VALID_MINUTES): Window {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  if (!Number.isInteger(validMinutes) || validMinutes < 1 || validMinutes > MAX_VALID_MINUTES) throw new Error(`valid_minutes must be a whole number from 1 to ${MAX_VALID_MINUTES}`);
  const second = Math.floor(nowMs / 1000) * 1000;
  const window = { lo: second - 60_000, hi: second + validMinutes * 60_000 };
  if (window.hi - window.lo > MAX_RANGE_MS) throw new Error('the validity window is over one hour');
  return window;
}

/**
 * Sets Lucid's slot clock from the node and checks that slots start on whole seconds, which the windows of windowAt need: Lucid turns
 * a bound into the slot that contains it, and the script sees that slot's start.
 */
export async function chainClock(provider: Provider): Promise<void> {
  let zeroTime: number;
  try { zeroTime = await ensureSlotConfig(provider as unknown as SlotClockProvider); } catch (err) {
    throw err instanceof ChainClockError ? err : new Error(`Could not read the chain clock from the node: ${errorText(err)}`);
  }
  if (zeroTime % 1000 !== 0) throw new Error(`The chain's slot zero time (${zeroTime} ms) is not a whole number of seconds, so the validity window cannot be placed on slot boundaries; nothing was built.`);
}

// ─── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A live record or tombstone: its UTxO at the identity address, its identifier and its decoded datum. */
export interface RecordUtxo { id: string; utxo: UTxO; record: IdentityDatum }

/**
 * Is `utxo` an authentic output of the token `name` of `policy` at `address` (Part 1 Section 4, Part 2 Sections 4.1 and 5.2): at exactly
 * that address, with exactly one token of the policy, named `name`, quantity 1?
 */
export function holdsSoleToken(utxo: UTxO, address: string, policy: string, name: string): boolean {
  if (utxo.address !== address) return false;
  const tokens = Object.entries(utxo.assets).filter(([unit]) => unit.startsWith(policy));
  return tokens.length === 1 && tokens[0][0] === `${policy}${name}` && tokens[0][1] === 1n;
}

/** Is `utxo` the authentic record output of `id`: at exactly the identity address, with exactly one token of the policy, named `id`? */
export const isRecordOutput = (utxo: UTxO, deployment: IdentityDeployment, id: string): boolean =>
  holdsSoleToken(utxo, deployment.identity.address, deployment.identity.hash, id);

/**
 * The authentic output of the token `name` of `policy` at `address` (holdsSoleToken), or null. Koios names the UTxO that holds the
 * token (fast), and the node must list that UTxO; when Koios has no answer, or one the node does not confirm (it lags), the node's
 * list of the address decides.
 */
export async function findTokenOutput(provider: Provider, address: string, policy: string, name: string): Promise<UTxO | null> {
  if (!VECTOR_ID.test(name)) throw new Error(`${JSON.stringify(name)} is not an identifier (64 lowercase hex characters).`);
  let hint: UTxO | undefined;
  try { hint = await provider.getUtxoByUnit(`${policy}${name}`); } catch { /* no Koios answer: the address scan below decides */ }
  if (hint) {
    const [onNode] = await provider.getUtxosByOutRef([{ txHash: hint.txHash, outputIndex: hint.outputIndex }]);
    if (onNode && holdsSoleToken(onNode, address, policy, name)) return onNode;
  }
  return (await provider.getUtxos(address)).find((u) => holdsSoleToken(u, address, policy, name)) ?? null;
}

function decoded(utxo: UTxO, id: string): RecordUtxo {
  if (!utxo.datum) throw new Error(`The record of ${didOf(id)} (${utxo.txHash}#${utxo.outputIndex}) has no inline datum.`);
  let record: IdentityDatum;
  try { record = decodeIdentityDatum(utxo.datum); } catch (err) { throw new Error(`The record of ${didOf(id)} (${utxo.txHash}#${utxo.outputIndex}) does not decode: ${errorText(err)}`); }
  return { id, utxo, record };
}

/** The record of `id` (live or tombstone), or null when the identity registry has none. Its datum must decode. */
export async function findRecord(provider: Provider, deployment: IdentityDeployment, id: string): Promise<RecordUtxo | null> {
  const utxo = await findTokenOutput(provider, deployment.identity.address, deployment.identity.hash, id);
  return utxo ? decoded(utxo, id) : null;
}

/** The record of `id`, or an error that says whose record (`what`) is missing. */
export async function requireRecord(provider: Provider, deployment: IdentityDeployment, id: string, what = 'record'): Promise<RecordUtxo> {
  const found = await findRecord(provider, deployment, id);
  if (!found) throw new Error(`No ${what} for ${didOf(id)} in the identity registry: the identifier is not registered (or the record is not confirmed yet).`);
  return found;
}

/**
 * The ancestors of a record, parent first, as the contract reads them for `effective` (at most 4). Missing ancestors are an error:
 * the contract fails without them.
 */
export async function ancestorsOf(provider: Provider, deployment: IdentityDeployment, record: IdentityDatum): Promise<RecordUtxo[]> {
  const ancestors: RecordUtxo[] = [];
  let current = record;
  while (current.lineage.type === 'Subagent') {
    if (ancestors.length >= MAX_DEPTH) throw new Error('The lineage is deeper than 4 levels.');
    const parent = await requireRecord(provider, deployment, current.lineage.parent, 'parent record');
    ancestors.push(parent);
    current = parent.record;
  }
  return ancestors;
}

/** The records by identifier, for effectiveStatus. */
export const recordsById = (records: RecordUtxo[]): Map<string, IdentityDatum> => new Map(records.map((r) => [r.id, r.record]));

/** The record of `id` and its ancestors (the record first): what a reference to an agent needs for `effective`. */
export async function recordWithAncestors(provider: Provider, deployment: IdentityDeployment, id: string, what = 'record'): Promise<RecordUtxo[]> {
  const record = await requireRecord(provider, deployment, id, what);
  return [record, ...await ancestorsOf(provider, deployment, record.record)];
}

/** Records and UTxOs once each, by identifier or output reference, in the order first seen. */
export function uniqueRecords(records: RecordUtxo[]): RecordUtxo[] {
  const seen = new Set<string>();
  return records.filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
}
export function uniqueUtxos(utxos: UTxO[]): UTxO[] {
  const seen = new Set<string>();
  return utxos.filter((u) => { const ref = `${u.txHash}#${u.outputIndex}`; if (seen.has(ref)) return false; seen.add(ref); return true; });
}

// ─── Delegations (Part 2 Section 5.2) ──────────────────────────────────────────────────────────────────────────────────────────

/** A delegation output: its token name, its UTxO at the delegation address, and its decoded datum. */
export interface DelegationUtxo { id: string; utxo: UTxO; delegation: DelegationDatum }

/** The authentic delegation `id` (one token of the delegation policy at exactly the delegation address), or null. Its datum must decode. */
export async function findDelegation(provider: Provider, deployment: IdentityDeployment, id: string): Promise<DelegationUtxo | null> {
  const utxo = await findTokenOutput(provider, deployment.delegation.address, deployment.delegation.hash, id);
  if (!utxo) return null;
  if (!utxo.datum) throw new Error(`The delegation ${id} (${utxo.txHash}#${utxo.outputIndex}) has no inline datum.`);
  try { return { id, utxo, delegation: decodeDelegationDatum(utxo.datum) }; } catch (err) {
    throw new Error(`The delegation ${id} (${utxo.txHash}#${utxo.outputIndex}) does not decode: ${errorText(err)}`);
  }
}

/** The delegation `id` and its ancestors, the delegation first (at most 4 links, Part 2 Section 5.2). A missing link is an error: it has been undelegated. */
export async function delegationChain(provider: Provider, deployment: IdentityDeployment, id: string): Promise<DelegationUtxo[]> {
  const chain: DelegationUtxo[] = [];
  for (let next: string | null = id; next !== null;) {
    if (chain.length >= MAX_DEPTH) throw new Error('The delegation chain is longer than 4 links.');
    const link = await findDelegation(provider, deployment, next);
    if (!link) throw new Error(chain.length === 0 ? `No live delegation ${next}: it does not exist or has been undelegated.` : `The parent delegation ${next} of ${chain[chain.length - 1].id} no longer exists (undelegated), so the chain cannot be used.`);
    chain.push(link);
    next = link.delegation.parent;
  }
  return chain;
}

/**
 * The records that the use check of a delegation chain reads (`links_active`, Part 2 Section 5.2): the delegate of every link, the
 * root delegator when it is an agent, and the ancestors of each, once each.
 */
export async function chainRecords(provider: Provider, deployment: IdentityDeployment, chain: DelegationUtxo[]): Promise<RecordUtxo[]> {
  const records: RecordUtxo[] = [];
  for (const link of chain) records.push(...await recordWithAncestors(provider, deployment, link.delegation.delegate, 'record of the delegate'));
  const root = chain[chain.length - 1].delegation.delegator;
  if (root.type === 'Agent') records.push(...await recordWithAncestors(provider, deployment, root.id, 'record of the delegator'));
  return uniqueRecords(records);
}

// ─── Configuration record and Module-1 (Part 2 Section 3.8) ────────────────────────────────────────────────────────────────────

/** The withdraw redeemer of Module-1's identity_party for a consent: `PartyApproval.Consent`. */
export const MODULE1_CONSENT_REDEEMER = Data.to(new Constr(0, []));

/** The configuration record, or an error that says Module-1 is not sealed yet. */
export async function requireConfigRecord(provider: Provider, deployment: IdentityDeployment): Promise<ConfigRecord> {
  const config = await findConfigRecord(provider, deployment);
  if (!config) throw new Error(`The identity registry has no configuration record yet (no configuration token at ${deployment.configHolder.address}): Module-1 cannot be a party before the seal (Part 2 Section 3.8).`);
  return config;
}

/**
 * What a transaction needs so that Module-1 consents to becoming a party (`ok(Script{M1})`, Part 2 Sections 3.2 and 3.8): the
 * configuration record as a reference input, the reference script of identity_party, and a withdrawal from Module-1's stake
 * credential with the Consent redeemer. The ledger accepts a withdrawal only of the WHOLE reward balance, and anybody can add to that
 * account, so the balance is read from the chain (Provider.getDelegation) and withdrawn in full. The withdraw handler of Module-1 then
 * checks the consent rules.
 */
export async function module1Consent(provider: Provider, deployment: IdentityDeployment, config: ConfigRecord): Promise<{ refs: UTxO[]; rewardAddress: string; redeemer: string; amount: bigint }> {
  const script = await readRefScript(provider, deployment, 'module1', config.m1);
  const rewardAddress = module1RewardAddress(config.m1);
  let amount: bigint;
  try { amount = (await provider.getDelegation(rewardAddress)).rewards; } catch (err) {
    throw new Error(`Could not read the reward balance of Module-1's stake credential, which its consent must withdraw in full: ${errorText(err)}`);
  }
  if (typeof amount !== 'bigint' || amount < 0n) throw new Error("The node did not report a usable reward balance of Module-1's stake credential.");
  return { refs: [config.utxo, script], rewardAddress, redeemer: MODULE1_CONSENT_REDEEMER, amount };
}

/** Does any of these signers name Module-1? */
export const namesModule1 = (signers: Signer[]): boolean => signers.some((s) => s.type === 'Script');

// ─── Wallet ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Collateral: a script transaction needs a pure-AP3X output of at least 5 AP3X in the wallet. */
export const COLLATERAL_MIN_LOVELACE = 5_000_000n;

/**
 * The wallet of a build: Lucid must be bound to `changeAddress` (the payouts and the change go to one address), the address must have a
 * key payment credential, and the wallet must hold a collateral output. Returns the wallet's key hash and its UTxOs.
 */
export async function walletOf(lucid: LucidEvolution, changeAddress: string): Promise<{ keyHash: string; utxos: UTxO[] }> {
  const keyHash = paymentKeyHashOf(changeAddress);
  if ((await lucid.wallet().address()) !== changeAddress) throw new Error('changeAddress is not the address this wallet is bound to; nothing was built.');
  const utxos = await lucid.wallet().getUtxos();
  if (!utxos.some((u) => Object.keys(u.assets).every((k) => k === 'lovelace') && u.assets.lovelace >= COLLATERAL_MIN_LOVELACE)) {
    throw new Error('Collateral required: the wallet must hold one pure AP3X output of at least 5 AP3X.');
  }
  return { keyHash, utxos };
}

/**
 * The seed of a new identifier: a wallet output that the transaction spends (Part 1 Section 3.1). The largest pure-AP3X output is
 * taken, so that the seed also funds the deposit.
 */
export function seedFrom(utxos: UTxO[]): UTxO {
  const pure = utxos.filter((u) => Object.keys(u.assets).every((k) => k === 'lovelace'));
  const seed = (pure.length > 0 ? pure : utxos).reduce<UTxO | undefined>((best, u) => (!best || u.assets.lovelace > best.assets.lovelace ? u : best), undefined);
  if (!seed) throw new Error('The wallet has no output to spend as the seed of the new identifier.');
  return seed;
}

// ─── Required signers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A key that must sign the transaction, and why. */
export interface RequiredSigner { keyHash: string; roles: string[] }

/** The keys that must sign a build, in the order they were named. A key named twice (the wallet is also the controller) is listed once with both roles. */
export class SignerList {
  private readonly byHash = new Map<string, string[]>();
  /** Adds the key hash `keyHash` (28 bytes, hex) with `role`. */
  add(keyHash: string, role: string): this {
    const hash = keyHash.toLowerCase();
    const roles = this.byHash.get(hash) ?? [];
    if (!roles.includes(role)) roles.push(role);
    this.byHash.set(hash, roles);
    return this;
  }
  /** Adds the key of an Ed25519 public key. */
  addKey(publicKeyHex: string, role: string): this { return this.add(keyHashOf(publicKeyHex), role); }
  /** Adds what `ok(signer)` needs (Part 2 Section 3.2): its key hash, or the controller key for ControllerSet. Module-1 signs by its withdrawal, not by a key. */
  addSigner(signer: Signer, controller: string, role: string): this {
    if (signer.type === 'KeyHash') return this.add(signer.hash, role);
    if (signer.type === 'ControllerSet') return this.addKey(controller, `${role} (${signerText(signer)})`);
    return this;
  }
  /** The key hashes that the transaction lists as required signers (every one but the wallet's, unless the wallet has a role too). */
  hashes(): string[] { return [...this.byHash.keys()]; }
  list(): RequiredSigner[] { return [...this.byHash].map(([keyHash, roles]) => ({ keyHash, roles: [...roles] })); }
}

/** What every build of these families returns: the unsigned transaction, its validity window, and every key that must sign it. */
export interface SignedByBuild extends VectorUnsignedBuildResult {
  /** POSIX ms. */
  validFrom: number;
  /** POSIX ms. */
  validTo: number;
  /** Every key that must sign, the wallet included (its inputs, the fee and the collateral). */
  requiredSigners: RequiredSigner[];
}

/** The role of the wallet key in every build. */
export const WALLET_ROLE = 'wallet (inputs, fee and collateral)';

/** The result of a completed build: its CBOR, hash and fee, the window, and the signers with the wallet added last. */
export function signedByResult(completed: TxSignBuilder, window: Window, signers: SignerList, walletKeyHash: string): SignedByBuild {
  signers.add(walletKeyHash, WALLET_ROLE);
  return { ...toBuildResult(completed), validFrom: window.lo, validTo: window.hi, requiredSigners: signers.list() };
}
