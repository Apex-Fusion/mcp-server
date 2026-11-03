// packages/builder/src/vector/identity-build.ts
// Keyless builders of the identity registry (Part 2 Section 3): Register (also subagents), Adopt of a legacy record, the machinery
// that every action on a record shares (buildRecordSpend), and every action on a record: Update, ChangeController, Suspend,
// Unsuspend, Revoke, Retire, Reclaim, SetSuccessor, BumpEpoch and the three recovery steps. Each builder checks the rules it can
// check before it builds (identity-rules.ts), so that a refusal names the rule, then assembles the transaction, lets Lucid run the
// identity script on it (local evaluation of the applied script that the reference input holds), and returns the unsigned CBOR with
// every key hash that must sign. Nothing is signed or submitted.
import { CML, Constr, Data, calculateMinLovelaceFromUTxO, credentialToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { decodeLegacyDatum, encodeIdentityDatum, encodeIdentityMint, encodeIdentitySpend, sameSigner, textOf } from './identity-codec.js';
import type { Actor, Hold, IdentityDatum, IdentitySpend, Key, LegacyDatum, Party, Role, Signer, Status } from './identity-codec.js';
import { readRefScript } from './identity-deployment.js';
import type { ConfigRecord, IdentityDeployment } from './identity-deployment.js';
import {
  ancestorsOf, chainClock, didOf, findRecord, findTokenOutput, identifierFromSeed, module1Consent, namesModule1, recordsById,
  requireConfigRecord, requireRecord, seedFrom, signedByResult, uniqueUtxos, walletOf, windowAt, SignerList,
} from './identity-chain.js';
import type { RecordUtxo, SignedByBuild, Window } from './identity-chain.js';
import {
  DAY_MS, DAYS_7_MS, DAYS_30_MS, MAX_CAPABILITIES, MAX_DEPTH, MAX_RANGE_MS, MIN_RECORD_LOVELACE, REASON_DISPUTE_VERDICT, REASON_KEY_COMPROMISE,
  REASON_NAMES, REVOKE_REASONS, RIGHT, ROLE_MAX_RIGHTS, SUSPEND_REASONS, accountable, allowlistProof, covers, datumProblems,
  effectiveStatus, eligibleGuardian, guardianBound, hasRight, holdsOf, keptHolds, keyHashOf, purposeNames, rightNames, signerText,
  terminal, tombstone, verifyAllowlistProof,
} from './identity-rules.js';
import { LEGACY_REGISTRY_POLICY_ID, legacyDid, legacyRegistryAddress, legacyRegistryScript } from './legacy-registry.js';
import { paymentKeyHashOf } from './gov-build.js';
import { safeFetch } from './safe-fetch.js';

/** What every identity builder works with: Lucid bound to the wallet, the node, and the deployment. */
export interface IdentityContext { lucid: LucidEvolution; provider: Provider; deployment: IdentityDeployment }

/** What every identity build takes besides its own inputs. */
export interface BuildCommon {
  /** The wallet: it pays the fee and any deposit, gives the collateral, and receives the change. */
  changeAddress: string;
  /** POSIX ms; default now. Tests fix it. */
  nowMs?: number;
  /** Minutes from now until the transaction expires (windowAt). */
  validMinutes?: number;
}

/** A party as a register or update takes it: `notBefore` defaults to the start of the window. */
export type PartySpec = Omit<Party, 'notBefore'> & { notBefore?: number };

/** The index of the output at `address` holding `unit`, in the built transaction. */
export function outputIndexOf(txCbor: string, address: string, unit: string): number {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  for (let i = 0; i < outputs.len(); i++) {
    const output = outputs.get(i);
    if (output.address().to_bech32() !== address) continue;
    const assets = output.amount().multi_asset();
    const policies = assets.keys();
    for (let j = 0; j < policies.len(); j++) {
      const policy = policies.get(j);
      const names = assets.get_assets(policy)?.keys();
      for (let k = 0; names && k < names.len(); k++) if (`${policy.to_hex()}${names.get(k).to_hex()}` === unit) return i;
    }
  }
  throw new Error('The built transaction has no output that holds the record token; nothing is returned.');
}

/** The problems of `record` as one refusal, or nothing. */
function refuseInvalid(record: IdentityDatum, m1: string | null, what: string): void {
  const problems = datumProblems(record, m1);
  if (problems.length > 0) throw new Error(`The ${what} would not be a valid record: ${problems.join('; ')}.`);
}

/**
 * The ledger minimum (min-UTxO) of a record output at `address` with the inline `datum` and the token `unit`, from the protocol
 * parameters that Lucid read from the node. A live record holds the larger of this and 10 AP3X: the largest valid record needs
 * about 18 AP3X.
 */
function recordOutputMinimum(lucid: LucidEvolution, address: string, unit: string, datum: string): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of the record output is unknown.');
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address, assets: { lovelace: 0n, [unit]: 1n }, datum });
}
/** `lovelace`, raised to `minimum` when it is below. */
const atLeastMinimum = (lovelace: bigint, minimum: bigint): bigint => (lovelace > minimum ? lovelace : minimum);

/** The configuration record when some signer of `parties` is Module-1, else null. */
async function configFor(ctx: IdentityContext, signers: Signer[]): Promise<ConfigRecord | null> {
  return namesModule1(signers) ? requireConfigRecord(ctx.provider, ctx.deployment) : null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** A party (or a reference to one) as text: its role and its signer. */
export const partyText = (p: { role: Role; signer: Signer }): string => `${p.role} Party (${signerText(p.signer)})`;
/** A reason code as text: its name of Part 2 Appendix A and its number. */
export const reasonText = (code: number): string => `${REASON_NAMES[code] ?? 'unnamed reason'} (${code})`;
const rightsText = (rights: number): string => rightNames(rights).join(' and ') || 'no rights';
const ada = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} AP3X`;
const CONTROLLER_SET: Signer = { type: 'ControllerSet' };

/** Do two parties have the same fields? */
function sameParty(a: Party, b: Party): boolean {
  return a.role === b.role && sameSigner(a.signer, b.signer) && a.organisation === b.organisation && a.notBefore === b.notBefore
    && a.notAfter === b.notAfter && a.rights === b.rights && a.removalAfter === b.removalAfter;
}

/** The profile fields of a record, as record bytes (UTF-8 text as hex). */
export interface Profile { name: string; description: string; framework: string; endpoint: string; capabilities: string[] }
/** New values for some profile fields (UTF-8 text as hex); a field that is not given stays. */
export type ProfilePatch = Partial<Profile>;

/**
 * D0 of a Register or an Adopt (Part 2 Section 3.4, rules 4 to 8) at `window`, checked as the contract checks it: a valid datum, an
 * Accountable Party that covers the window, and the guardian bound. Adds the keys that must sign to `signers`: the controller, each
 * listed Ed25519 key, and each party (a key-hash party by its key, the controller party by the controller key; Module-1 consents by
 * its withdrawal, which the builder adds).
 */
function newRecord(
  spec: { controller: string; keys: Key[]; parties: PartySpec[]; guardianThreshold?: number; profile: Profile },
  lineage: IdentityDatum['lineage'], window: Window, m1: string | null, signers: SignerList,
): IdentityDatum {
  const record: IdentityDatum = {
    controller: spec.controller.toLowerCase(), keys: spec.keys,
    parties: spec.parties.map((party) => ({ ...party, notBefore: party.notBefore ?? window.lo })),
    guardianThreshold: spec.guardianThreshold ?? 0, pendingRecovery: null, lineage, subagentEpoch: 0,
    ...spec.profile, createdAt: window.hi, status: { type: 'Active' },
  };
  refuseInvalid(record, m1, 'new record');
  if (!accountable(record, window.lo, window.hi)) throw new Error('A new record needs an Accountable Party that covers the validity window (not_before at or before its start, no not_after before its end).');
  if (!guardianBound(record, window.hi)) throw new Error('The guardian threshold is above the number of guardians with the recover right.');
  signers.addKey(record.controller, 'controller');
  record.keys.forEach((k, i) => { if (k.keyType === 'Ed25519') signers.addKey(k.key, `listed key ${i + 1}`); });
  record.parties.forEach((party, i) => signers.addSigner(party.signer, record.controller, `party ${i + 1} (${party.role})`));
  return record;
}

/**
 * What Module-1's withdraw handler requires before it consents to an appointment (Part 2 Section 3.8, Consent), in words; empty when
 * every new Module-1 party of `next` meets it. Each new Module-1 party is an Accountable or Responsible Party with the highest rights
 * of its role, `not_before` at or before the start of the window, no `not_after` and no `removal_after`; every Module-1 party of
 * `old` stays unchanged. The test deployment's Module-1 accepts everything, so the builders check this themselves.
 */
export function module1ConsentProblems(old: Party[], next: Party[], lo: number): string[] {
  const problems: string[] = [];
  for (const party of next) {
    if (party.signer.type !== 'Script' || old.some((o) => o.role === party.role && sameSigner(o.signer, party.signer))) continue;
    if (party.role !== 'Accountable' && party.role !== 'Responsible') problems.push(`Module-1 can be only an Accountable or Responsible Party, not a ${party.role} Party`);
    else if (party.rights !== ROLE_MAX_RIGHTS[party.role]) problems.push(`a Module-1 ${party.role} Party has the highest rights of its role (${rightsText(ROLE_MAX_RIGHTS[party.role])})`);
    if (party.notBefore > lo) problems.push('its not_before must be at or before the start of the validity window');
    if (party.notAfter !== null) problems.push('it takes no not_after');
    if (party.removalAfter !== null) problems.push('it takes no removal_after');
  }
  for (const party of old) {
    if (party.signer.type === 'Script' && !next.some((n) => sameParty(n, party))) problems.push(`the ${partyText(party)} that the record already has must stay unchanged in the same transaction`);
  }
  return problems;
}

// ─── Register (Part 2 Section 3.4) ──────────────────────────────────────────────────────────────────────────────────────────────

export interface RegisterParams extends BuildCommon {
  /** The controller's Ed25519 public key (32 bytes, hex). */
  controller: string;
  keys: Key[];
  parties: PartySpec[];
  guardianThreshold?: number;
  /** UTF-8 bytes as hex (identity-codec utf8Hex). */
  name: string; description?: string; framework?: string; endpoint?: string; capabilities?: string[];
  /** The identifier of the parent, for a subagent. */
  parent?: string;
  /** The AP3X that the record locks; at least 10 AP3X (the default). */
  depositLovelace?: bigint;
}

export interface RegisterBuild extends SignedByBuild {
  id: string; did: string;
  /** The wallet output that the transaction spends as the seed; it gives the identifier. */
  seed: string;
  recordOutputIndex: number;
  depositLovelace: bigint;
  /** `created_at`: the upper bound of the window. */
  createdAt: number;
  record: IdentityDatum;
}

/**
 * Builds the unsigned Register of a new record (Part 2 Section 3.4; a subagent when `parent` is set). The wallet's largest pure-AP3X
 * output is the seed, so the identifier is known before signing. Signers: the controller, each listed Ed25519 key, each party (a
 * key-hash party by its key, the controller party by the controller key, Module-1 by its consent withdrawal), and for a subagent the
 * parent's controller. Refuses a record that would be invalid, one without an Accountable Party that covers the window, a guardian
 * threshold above the guardians, an appointment that Module-1 would not consent to (module1ConsentProblems, as Adopt and Update
 * check it), a deposit below 10 AP3X, and a parent that is not Active or already at depth 4.
 */
export async function buildRegister(ctx: IdentityContext, p: RegisterParams): Promise<RegisterBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const requested = p.depositLovelace ?? MIN_RECORD_LOVELACE;
  if (requested < MIN_RECORD_LOVELACE) throw new Error('A live record locks at least 10 AP3X.');

  const config = await configFor(ctx, p.parties.map((party) => party.signer));
  const m1 = config?.m1 ?? null;
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'identity', deployment.identity.hash)];

  let lineage: IdentityDatum['lineage'] = { type: 'Root' };
  let parent: RecordUtxo | null = null;
  if (p.parent !== undefined) {
    parent = await requireRecord(provider, deployment, p.parent, 'parent record');
    const ancestors = await ancestorsOf(provider, deployment, parent.record);
    const status = effectiveStatus(parent.record, recordsById(ancestors), window.lo, window.hi);
    if (status !== 'Active') throw new Error(`The parent ${didOf(parent.id)} is ${status}; only an Active parent can start a subagent.`);
    const depth = parent.record.lineage.type === 'Root' ? 0 : parent.record.lineage.depth;
    if (depth >= MAX_DEPTH) throw new Error(`The parent ${didOf(parent.id)} is at depth ${depth}; a subagent can be at most ${MAX_DEPTH} levels deep.`);
    lineage = { type: 'Subagent', parent: parent.id, parentEpoch: parent.record.subagentEpoch, depth: depth + 1 };
    refs.push(parent.utxo, ...ancestors.map((a) => a.utxo));
  }

  const seed = seedFrom(wallet.utxos);
  const id = identifierFromSeed(seed);
  const signers = new SignerList();
  const record = newRecord({
    controller: p.controller, keys: p.keys, parties: p.parties, guardianThreshold: p.guardianThreshold,
    profile: { name: p.name, description: p.description ?? '', framework: p.framework ?? '', endpoint: p.endpoint ?? '', capabilities: p.capabilities ?? [] },
  }, lineage, window, m1, signers);
  const consentProblems = module1ConsentProblems([], record.parties, window.lo);
  if (consentProblems.length > 0) throw new Error(`Module-1 would not consent to this appointment: ${consentProblems.join('; ')} (Part 2 Section 3.8).`);
  if (parent) signers.addKey(parent.record.controller, `controller of the parent ${didOf(parent.id)}`);

  const unit = `${deployment.identity.hash}${id}`;
  const datum = encodeIdentityDatum(record);
  const deposit = atLeastMinimum(requested, recordOutputMinimum(lucid, deployment.identity.address, unit, datum));
  let tx = lucid.newTx()
    .collectFrom([seed])
    .mintAssets({ [unit]: 1n }, encodeIdentityMint({ type: 'Register', seed: { txHash: seed.txHash, outputIndex: seed.outputIndex } }))
    .pay.ToContract(deployment.identity.address, { kind: 'inline', value: datum }, { lovelace: deposit, [unit]: 1n })
    .validFrom(window.lo)
    .validTo(window.hi);
  if (config) {
    const consent = await module1Consent(provider, deployment, config);
    refs.push(...consent.refs);
    tx = tx.withdraw(consent.rewardAddress, consent.amount, consent.redeemer);
  }
  tx = tx.readFrom(uniqueUtxos(refs));
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  return {
    ...result, id, did: didOf(id), seed: `${seed.txHash}#${seed.outputIndex}`,
    recordOutputIndex: outputIndexOf(result.txCbor, deployment.identity.address, unit), depositLovelace: deposit, createdAt: window.hi, record,
  };
}

// ─── Adopt (Part 2 Sections 3.4 and 9.1) ───────────────────────────────────────────────────────────────────────────────────────

/** The legacy registry's Deregister (spend) and Burn (mint) redeemers: each is constructor 1 without fields. */
export const LEGACY_DEREGISTER_REDEEMER = Data.to(new Constr(1, []));
export const LEGACY_BURN_REDEEMER = Data.to(new Constr(1, []));
/**
 * The output that the legacy Deregister requires (measured against the deployed script, Part 2 Section 9.1): at least 10 AP3X in one
 * output whose payment credential is the owner's key hash, with any stake credential. Two outputs of 5 AP3X fail. The legacy deposit
 * itself need not return.
 */
export const LEGACY_OWNER_OUTPUT_LOVELACE = 10_000_000n;
/** The largest allowlist file that an adoption reads: 1 MiB, room for about 15,000 identifiers. */
export const ALLOWLIST_MAX_BYTES = 1_048_576;
const ALLOWLIST_TIMEOUT_MS = 20_000;

/** A record of the legacy registry: its UTxO at the legacy address, its decoded datum, and its owner's key hash. */
export interface LegacyRecord { id: string; utxo: UTxO; datum: LegacyDatum; owner: string }

/**
 * The legacy record of `id`: the output at the exact legacy address whose only token of the legacy policy is the token of `id`, with a
 * datum that decodes as a legacy record and a key owner. Refuses, saying why, an identifier without a legacy record, one that the
 * identity registry already holds, a token that shares its output with another legacy token (locked for ever), a datum that does not
 * decode, and a script owner.
 */
export async function requireLegacyRecord(provider: Provider, deployment: IdentityDeployment, id: string): Promise<LegacyRecord> {
  const address = legacyRegistryAddress();
  const utxo = await findTokenOutput(provider, address, LEGACY_REGISTRY_POLICY_ID, id);
  if (!utxo) {
    if (await findRecord(provider, deployment, id)) throw new Error(`${legacyDid(id)} is already in the identity registry as ${didOf(id)}; there is nothing to adopt.`);
    const shared = (await provider.getUtxos(address)).find((u) => (u.assets[`${LEGACY_REGISTRY_POLICY_ID}${id}`] ?? 0n) > 0n);
    if (shared) {
      throw new Error(`The legacy token of ${legacyDid(id)} shares the output ${shared.txHash}#${shared.outputIndex} with another legacy token. The legacy script never spends such an output, so the record can neither adopt nor deregister (Part 2 Section 9.4).`);
    }
    throw new Error(`No legacy record holds the token of ${legacyDid(id)}: it was never registered, or it has been deregistered.`);
  }
  const where = `The legacy record of ${legacyDid(id)} (${utxo.txHash}#${utxo.outputIndex})`;
  const datumHex = utxo.datum ?? (utxo.datumHash ? await provider.getDatum(utxo.datumHash) : undefined);
  if (!datumHex) throw new Error(`${where} has no datum, so it cannot adopt (Part 2 Section 9.1).`);
  let datum: LegacyDatum;
  try { datum = decodeLegacyDatum(datumHex); } catch (err) {
    throw new Error(`${where} has a datum that does not decode as a legacy record (${errorText(err)}), so it cannot adopt (Part 2 Section 9.1).`);
  }
  if (datum.owner.type === 'Script') {
    throw new Error(`${where} is owned by the script ${datum.owner.hash}. Adoption needs the signature of the owner key, so a record with a script owner cannot adopt (Part 2 Section 9.1).`);
  }
  return { id, utxo, datum, owner: datum.owner.hash };
}

/**
 * The identifiers of the allowlist file at `url` (Part 2 Sections 3.4 and 9.1: a JSON list of 64-hex identifiers), read through
 * safeFetch (https only, no private hosts, no redirects) with a cap of ALLOWLIST_MAX_BYTES. `fetchImpl` stands in for fetch (tests).
 */
export async function readAllowlist(url: string, fetchImpl?: typeof fetch): Promise<string[]> {
  const refuse = (problem: string) => new Error(`The adoption allowlist at ${url} ${problem}. Pass the proof instead.`);
  const res = await safeFetch(url, { headers: { accept: 'application/json' } }, {
    maxResponseBytes: ALLOWLIST_MAX_BYTES, timeoutMs: ALLOWLIST_TIMEOUT_MS, ...(fetchImpl ? { fetchImpl } : {}),
  }).catch((err: unknown) => { throw refuse(`could not be read (${errorText(err)})`); });
  if (res.status !== 200) throw refuse(`answered HTTP ${res.status}`);
  let ids: unknown;
  try { ids = JSON.parse(res.text); } catch { throw refuse('is not JSON'); }
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && /^[0-9a-fA-F]{64}$/.test(x))) throw refuse('is not a JSON list of identifiers (64 hex characters each)');
  return ids.map((x: string) => x.toLowerCase());
}

/**
 * The allowlist proof of `id`: `given` when the caller passes one, else computed from the deployment's allowlist file. Either way it
 * must lead from `id` to the deployment's legacy root (Adopt rule 4), or the build stops here.
 */
async function adoptionProof(deployment: IdentityDeployment, id: string, given: string[] | undefined, fetchImpl?: typeof fetch): Promise<{ proof: string[]; from: 'given' | 'allowlist' }> {
  if (given !== undefined) {
    const proof = given.map((node) => node.toLowerCase());
    if (!verifyAllowlistProof(deployment.legacyRoot, id, proof)) {
      throw new Error(`The proof does not show that ${id} is on the adoption allowlist: it does not lead to the deployment's root ${deployment.legacyRoot}.`);
    }
    return { proof, from: 'given' };
  }
  const url = deployment.allowlistUrl;
  if (!url) throw new Error('This server has no allowlist URL (VECTOR_IDENTITY_ALLOWLIST_URL), so it cannot compute the proof: pass `proof`, the Merkle proof of the identifier from the published allowlist.');
  const ids = await readAllowlist(url, fetchImpl);
  if (!ids.includes(id)) throw new Error(`${legacyDid(id)} is not on the adoption allowlist: only legacy records minted before the cutoff slot can adopt (Part 2 Section 9.1).`);
  let proof: string[];
  try { proof = allowlistProof(ids, id); } catch (err) { throw new Error(`The adoption allowlist at ${url} gives no proof: ${errorText(err)}.`); }
  if (!verifyAllowlistProof(deployment.legacyRoot, id, proof)) throw new Error(`The allowlist at ${url} does not give the deployment's root ${deployment.legacyRoot}, so it is not the published list.`);
  return { proof, from: 'allowlist' };
}

/**
 * The profile of an adopted record (Part 2 Section 9.1, Profile copy): each field from `given`, else the legacy field when it obeys
 * the limits of the did:vector method specification (Section 5). Refuses with the list of fields that break a limit and have no new
 * value. Returns where each field comes from.
 */
export function adoptedProfile(legacy: LegacyDatum, given: ProfilePatch): { profile: Profile; from: Record<keyof Profile, 'legacy' | 'given'> } {
  const bytes = (hex: string): number => hex.length / 2;
  const missing: string[] = [];
  const check = (field: keyof Profile, fits: boolean, limit: string): void => { if (given[field] === undefined && !fits) missing.push(`${field} (${limit})`); };
  check('name', bytes(legacy.name) >= 1 && bytes(legacy.name) <= 64, `1 to 64 bytes; the legacy name has ${bytes(legacy.name)}`);
  check('description', bytes(legacy.description) <= 256, `up to 256 bytes; the legacy description has ${bytes(legacy.description)}`);
  check('framework', bytes(legacy.framework) <= 64, `up to 64 bytes; the legacy framework has ${bytes(legacy.framework)}`);
  check('endpoint', bytes(legacy.endpoint) <= 256, `up to 256 bytes; the legacy endpoint has ${bytes(legacy.endpoint)}`);
  const caps = legacy.capabilities;
  check('capabilities', caps.length <= MAX_CAPABILITIES && caps.every((c) => bytes(c) >= 1 && bytes(c) <= 64) && new Set(caps).size === caps.length,
    `up to ${MAX_CAPABILITIES} capabilities of 1 to 64 bytes without duplicates; the legacy list has ${plural(caps.length, 'item')}`);
  if (missing.length > 0) {
    throw new Error(`The legacy record has fields that break the limits of the identity registry (did:vector method specification, Section 5); give a new value for each: ${missing.join('; ')}.`);
  }
  const profile: Profile = {
    name: given.name ?? legacy.name, description: given.description ?? legacy.description, framework: given.framework ?? legacy.framework,
    endpoint: given.endpoint ?? legacy.endpoint, capabilities: given.capabilities ?? legacy.capabilities,
  };
  const fields = Object.keys(profile) as Array<keyof Profile>;
  return { profile, from: Object.fromEntries(fields.map((f) => [f, given[f] === undefined ? 'legacy' : 'given'])) as Record<keyof Profile, 'legacy' | 'given'> };
}

/** The index of the first output at `address` that holds exactly `lovelace` and no token, in the built transaction. */
function paymentIndexOf(txCbor: string, address: string, lovelace: bigint): number {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  for (let i = 0; i < outputs.len(); i++) {
    const output = outputs.get(i);
    if (output.address().to_bech32() === address && output.amount().coin() === lovelace && !output.amount().has_multiassets()) return i;
  }
  throw new Error(`The built transaction has no output of ${ada(lovelace)} to ${address}; nothing is returned.`);
}

export interface AdoptParams extends BuildCommon {
  /** The identifier of the legacy record: the name of its legacy token, which the new record keeps. */
  id: string;
  /** The controller's Ed25519 public key (32 bytes, hex). */
  controller: string;
  keys: Key[];
  parties: PartySpec[];
  guardianThreshold?: number;
  /** New values for profile fields; every other field is copied from the legacy record when it obeys the limits. */
  profile?: ProfilePatch;
  /** The Merkle proof of `id` on the allowlist (32-byte nodes, hex). Without it the builder reads the deployment's allowlist file. */
  proof?: string[];
  /** The AP3X that the new record locks; at least 10 AP3X (the default). */
  depositLovelace?: bigint;
  /** Stands in for fetch when the allowlist file is read (tests). */
  fetchImpl?: typeof fetch;
}

export interface AdoptBuild extends SignedByBuild {
  id: string; did: string; legacyDid: string;
  /** The spent legacy record output, its owner's key hash and its AP3X. */
  legacyInput: string; legacyOwner: string; legacyLovelace: bigint;
  proof: string[]; proofFrom: 'given' | 'allowlist';
  /** Where each profile field of the new record comes from. */
  profileFrom: Record<keyof Profile, 'legacy' | 'given'>;
  recordOutputIndex: number; depositLovelace: bigint;
  /** The output of LEGACY_OWNER_OUTPUT_LOVELACE to the owner's key that the legacy Deregister requires. */
  ownerOutputIndex: number; ownerAddress: string;
  /** `created_at`: the upper bound of the window. */
  createdAt: number;
  record: IdentityDatum;
}

/**
 * Builds the unsigned Adopt of a legacy record (Part 2 Sections 3.4 and 9.1). The transaction spends the legacy record with the legacy
 * Deregister redeemer and burns its token with the legacy Burn redeemer (the legacy script is attached, so its rules run here too),
 * and mints the identity token of the same identifier with Adopt{proof} into a new record: lineage Root, created_at = hi, Active,
 * epoch 0. It pays 10 AP3X to the owner's key, the output that the legacy Deregister requires: to the wallet when the wallet is the
 * owner, else to the owner's enterprise address. Signers: the legacy owner, the controller, each listed Ed25519 key and each party
 * (Module-1 by its consent withdrawal). Refuses a legacy record that cannot adopt, a proof that does not lead to the deployment's
 * root, a legacy profile field that breaks a limit without a new value, an appointment that Module-1 would refuse, and every
 * Register refusal.
 */
export async function buildAdopt(ctx: IdentityContext, p: AdoptParams): Promise<AdoptBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const requested = p.depositLovelace ?? MIN_RECORD_LOVELACE;
  if (requested < MIN_RECORD_LOVELACE) throw new Error('A live record locks at least 10 AP3X.');

  const id = p.id.toLowerCase();
  const legacy = await requireLegacyRecord(provider, deployment, id);
  const { proof, from: proofFrom } = await adoptionProof(deployment, id, p.proof, p.fetchImpl);
  const { profile, from: profileFrom } = adoptedProfile(legacy.datum, p.profile ?? {});

  const config = await configFor(ctx, p.parties.map((party) => party.signer));
  const signers = new SignerList().add(legacy.owner, 'legacy owner');
  const record = newRecord({ controller: p.controller, keys: p.keys, parties: p.parties, guardianThreshold: p.guardianThreshold, profile }, { type: 'Root' }, window, config?.m1 ?? null, signers);
  const consentProblems = module1ConsentProblems([], record.parties, window.lo);
  if (consentProblems.length > 0) throw new Error(`Module-1 would not consent to this appointment: ${consentProblems.join('; ')} (Part 2 Section 3.8).`);

  const network = lucid.config().network;
  if (!network) throw new Error('Lucid has no network, so the address of the owner key is unknown.');
  const ownerAddress = paymentKeyHashOf(p.changeAddress) === legacy.owner ? p.changeAddress : credentialToAddress(network, { type: 'Key', hash: legacy.owner });
  const unit = `${deployment.identity.hash}${id}`;
  const datum = encodeIdentityDatum(record);
  const deposit = atLeastMinimum(requested, recordOutputMinimum(lucid, deployment.identity.address, unit, datum));
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'identity', deployment.identity.hash)];
  let tx = lucid.newTx()
    .collectFrom([legacy.utxo], LEGACY_DEREGISTER_REDEEMER)
    .attach.SpendingValidator(legacyRegistryScript())
    .mintAssets({ [`${LEGACY_REGISTRY_POLICY_ID}${id}`]: -1n }, LEGACY_BURN_REDEEMER)
    .attach.MintingPolicy(legacyRegistryScript())
    .mintAssets({ [unit]: 1n }, encodeIdentityMint({ type: 'Adopt', proof }))
    .pay.ToContract(deployment.identity.address, { kind: 'inline', value: datum }, { lovelace: deposit, [unit]: 1n })
    .pay.ToAddress(ownerAddress, { lovelace: LEGACY_OWNER_OUTPUT_LOVELACE })
    .validFrom(window.lo)
    .validTo(window.hi);
  if (config) {
    const consent = await module1Consent(provider, deployment, config);
    refs.push(...consent.refs);
    tx = tx.withdraw(consent.rewardAddress, consent.amount, consent.redeemer);
  }
  tx = tx.readFrom(uniqueUtxos(refs));
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  return {
    ...result, id, did: didOf(id), legacyDid: legacyDid(id),
    legacyInput: `${legacy.utxo.txHash}#${legacy.utxo.outputIndex}`, legacyOwner: legacy.owner, legacyLovelace: legacy.utxo.assets.lovelace,
    proof, proofFrom, profileFrom,
    recordOutputIndex: outputIndexOf(result.txCbor, deployment.identity.address, unit), depositLovelace: deposit,
    ownerOutputIndex: paymentIndexOf(result.txCbor, ownerAddress, LEGACY_OWNER_OUTPUT_LOVELACE), ownerAddress,
    createdAt: window.hi, record,
  };
}

// ─── Actions on a record (Part 2 Sections 3.5 to 3.7) ───────────────────────────────────────────────────────────────────────────

/** What an action decides, given the record it spends and the window. */
export interface SpendPlan {
  redeemer: IdentitySpend;
  /** D': the datum of the new record output. */
  next: IdentityDatum;
  /** The AP3X of the new record output; default the AP3X of the spent record. `'minimum'` is the ledger minimum (Retire, Reclaim). */
  outputLovelace?: bigint | 'minimum';
  /** Who must sign, and why. The wallet is added by the builder. */
  signers: SignerList;
  /** Reference inputs beyond the identity script, the configuration record and Module-1 (a successor's record, ancestors). */
  refs?: UTxO[];
  /** Module-1 consents (its withdrawal), when the action makes it a party. */
  module1Consent?: boolean;
  /** What the text says the action does. */
  summary: string;
}

/** The context that a plan receives: the record, the window, and M1 when the record or the action needs the configuration record. */
export interface SpendState { current: RecordUtxo; window: Window; m1: string | null }

export interface RecordSpendBuild extends SignedByBuild {
  id: string; did: string; action: IdentitySpend['type']; summary: string;
  recordOutputIndex: number; outputLovelace: bigint; record: IdentityDatum;
}

/**
 * Builds the unsigned spend of the record of `id` for one action. `plan` decides the redeemer, the new datum, the signers and the
 * value; this function does what every action shares (Part 2 Section 3.5): the window, the wallet, the record, the configuration
 * record when the record or the new datum names Module-1 (`needsConfig` lets a plan ask for it too), the valid-datum check of D', and
 * a transaction with the identity script as a reference input, the record as the only identity input, exactly one record output, the
 * required signers, and the window.
 */
export async function buildRecordSpend(
  ctx: IdentityContext, p: BuildCommon & { id: string },
  plan: (state: SpendState) => Promise<SpendPlan> | SpendPlan,
  needsConfig = false,
): Promise<RecordSpendBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const current = await requireRecord(provider, deployment, p.id);
  let config = needsConfig || namesModule1(current.record.parties.map((party) => party.signer)) ? await requireConfigRecord(provider, deployment) : null;
  const decided = await plan({ current, window, m1: config?.m1 ?? null });
  if (!config && namesModule1(decided.next.parties.map((party) => party.signer))) config = await requireConfigRecord(provider, deployment);
  const m1 = config?.m1 ?? null;
  refuseInvalid(decided.next, m1, 'new record');
  if (!terminal(decided.next.status) && decided.outputLovelace !== 'minimum' && (decided.outputLovelace ?? current.utxo.assets.lovelace) < MIN_RECORD_LOVELACE) {
    throw new Error('A live record keeps at least 10 AP3X.');
  }

  const unit = `${deployment.identity.hash}${current.id}`;
  const datum = encodeIdentityDatum(decided.next);
  // Every record output holds at least its ledger minimum: a kept-value action may raise the output above the input (value kept means
  // at least the input), and an Update that grows the datum raises it too.
  const minimum = recordOutputMinimum(lucid, deployment.identity.address, unit, datum);
  const lovelace = decided.outputLovelace === 'minimum' ? minimum : atLeastMinimum(decided.outputLovelace ?? current.utxo.assets.lovelace, minimum);
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'identity', deployment.identity.hash), ...(decided.refs ?? [])];
  let tx = lucid.newTx()
    .collectFrom([current.utxo], encodeIdentitySpend(decided.redeemer))
    .pay.ToContract(deployment.identity.address, { kind: 'inline', value: datum }, { lovelace, [unit]: 1n })
    .validFrom(window.lo)
    .validTo(window.hi);
  if (decided.module1Consent) {
    if (!config) throw new Error('Module-1 consent needs the configuration record.');
    const consent = await module1Consent(provider, deployment, config);
    refs.push(...consent.refs);
    tx = tx.withdraw(consent.rewardAddress, consent.amount, consent.redeemer);
  } else if (config) {
    refs.push(config.utxo);
  }
  tx = tx.readFrom(uniqueUtxos(refs));
  for (const hash of decided.signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, decided.signers, wallet.keyHash);
  return {
    ...result, id: current.id, did: didOf(current.id), action: decided.redeemer.type, summary: decided.summary,
    recordOutputIndex: outputIndexOf(result.txCbor, deployment.identity.address, unit), outputLovelace: lovelace, record: decided.next,
  };
}

/** Does the new party list add a Module-1 party that the old list does not have (an appointment that needs Module-1's consent)? */
export function appointsModule1(oldParties: Party[], newParties: Party[]): boolean {
  return newParties.some((party) => party.signer.type === 'Script' && !oldParties.some((o) => o.role === party.role && sameSigner(o.signer, party.signer)));
}

/** Refuses an action on a terminal record: only Reclaim and SetSuccessor apply to it (Part 2 Section 3.5, rule 4). */
function requireLive(current: RecordUtxo): void {
  const status = current.record.status;
  if (terminal(status)) throw new Error(`${didOf(current.id)} has ended (${status.type}); only Reclaim and SetSuccessor apply to it.`);
}

/** buildRecordSpend with a plan that also returns what the answer shows. Returns the build, that detail and the spent record. */
async function spendWith<T>(
  ctx: IdentityContext, p: BuildCommon & { id: string },
  plan: (state: SpendState) => Promise<{ spend: SpendPlan; detail: T }> | { spend: SpendPlan; detail: T },
): Promise<{ build: RecordSpendBuild; detail: T; current: RecordUtxo }> {
  let planned = null as { detail: T; current: RecordUtxo } | null;
  const build = await buildRecordSpend(ctx, p, async (state) => {
    const { spend, detail } = await plan(state);
    planned = { detail, current: state.current };
    return spend;
  });
  if (planned === null) throw new Error('The plan of the action did not run.');
  return { build, ...planned };
}

/** Why `party` does not cover the window, in words. */
const notCovering = (party: Party, window: Window): string =>
  `does not cover the validity window ${iso(window.lo)} to ${iso(window.hi)} (not_before ${iso(party.notBefore)}, not_after ${party.notAfter === null ? 'none' : iso(party.notAfter)})`;

// ─── End subagents (BumpEpoch, Part 2 Section 3.5) ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the unsigned BumpEpoch of a live record: `subagent_epoch` + 1, which ends every subagent created under an older epoch.
 * The controller signs. The record keeps its value. A worked example of buildRecordSpend.
 */
export async function buildEndSubagents(ctx: IdentityContext, p: BuildCommon & { id: string }): Promise<RecordSpendBuild> {
  return buildRecordSpend(ctx, p, ({ current }) => {
    const record = current.record;
    requireLive(current);
    return {
      redeemer: { type: 'BumpEpoch' },
      next: { ...record, subagentEpoch: record.subagentEpoch + 1 },
      signers: new SignerList().addKey(record.controller, 'controller'),
      summary: `subagent epoch ${record.subagentEpoch} to ${record.subagentEpoch + 1}: every subagent created under epoch ${record.subagentEpoch} or earlier ends`,
    };
  });
}

// ─── Update (Part 2 Section 3.6) ───────────────────────────────────────────────────────────────────────────────────────────────

/** A party of the record, named by its role and its signer. */
export interface PartyRef { role: Role; signer: Signer }
/** New values for the fields of a party; a field that is not given stays. The party signs the change. */
export interface PartyChange extends PartyRef {
  /** UTF-8 bytes as hex; null clears it. */
  organisation?: string | null; notBefore?: number; notAfter?: number | null; rights?: number; removalAfter?: number | null;
}
/** A removal notice: the party can be removed without its signature from `removalAfter`, at least 7 days after the window (the default). */
export interface RemovalNotice extends PartyRef { removalAfter?: number }

export interface UpdateParams extends BuildCommon {
  id: string;
  /** New profile fields (UTF-8 text as hex); `capabilities` replaces the whole list. */
  profile?: ProfilePatch;
  /** New keys; each new Ed25519 key signs, each new P-256 key carries its proof of possession. */
  addKeys?: Key[];
  /** Keys that leave the record: each a public key or a key hash (hex). */
  removeKeys?: string[];
  /** New parties (they come last); each signs. `notBefore` defaults to the start of the window. */
  addParties?: PartySpec[];
  /** Changes of parties (same role and signer); each changed party signs. */
  changeParties?: PartyChange[];
  /** Parties that leave; each signs unless its removal notice has passed. */
  removeParties?: PartyRef[];
  /** Removal notices; the party does not sign. */
  announcePartyRemoval?: RemovalNotice[];
  guardianThreshold?: number;
  /** The AP3X of the record after the update, at least 10 AP3X; default unchanged. The difference comes from or goes to the wallet. */
  depositLovelace?: bigint;
}

export interface UpdateBuild extends RecordSpendBuild {
  /** Each change, in words. */
  changes: string[];
  /** What follows from the changes, for example that no Accountable Party covers the window any more. */
  notes: string[];
}

/** Record bytes as quoted text, or as hex when they are not UTF-8. */
const shown = (hex: string): string => JSON.stringify(textOf(hex) ?? `0x${hex}`);

/** The fields in which `after` differs from `before`, in words. */
function partyDiff(before: Party, after: Party): string {
  const time = (t: number | null): string => (t === null ? 'none' : iso(t));
  const diffs: string[] = [];
  if (before.organisation !== after.organisation) diffs.push(`organisation ${before.organisation === null ? 'none' : shown(before.organisation)} to ${after.organisation === null ? 'none' : shown(after.organisation)}`);
  if (before.notBefore !== after.notBefore) diffs.push(`not_before ${iso(before.notBefore)} to ${iso(after.notBefore)}`);
  if (before.notAfter !== after.notAfter) diffs.push(`not_after ${time(before.notAfter)} to ${time(after.notAfter)}`);
  if (before.rights !== after.rights) diffs.push(`rights ${rightsText(before.rights)} to ${rightsText(after.rights)}`);
  if (before.removalAfter !== after.removalAfter) diffs.push(`removal_after ${time(before.removalAfter)} to ${time(after.removalAfter)}`);
  return diffs.join(', ');
}

/**
 * The Update of `current` (Part 2 Section 3.6) as a plan: the profile fields given replace the old ones; keys leave and join (a kept
 * key stays as it is; each new Ed25519 key signs; a P-256 key carries its proof); parties are announced for removal (no signature,
 * removal_after at least hi + 7 days), changed (the party signs), removed (the party signs unless its notice has passed) and
 * appointed (last, each signs; Module-1 by its consent withdrawal); the guardian bound holds when the parties or the threshold
 * change; a threshold of 0 cancels a pending recovery. The controller, lineage, epoch, created_at and status stay.
 */
function planUpdate(current: RecordUtxo, window: Window, p: UpdateParams): { spend: SpendPlan; detail: { changes: string[]; notes: string[] } } {
  const record = current.record;
  requireLive(current);
  const { lo, hi } = window;
  const changes: string[] = [];
  const signers = new SignerList().addKey(record.controller, 'controller');

  const profile: Profile = { name: record.name, description: record.description, framework: record.framework, endpoint: record.endpoint, capabilities: record.capabilities };
  const patch = p.profile ?? {};
  for (const field of ['name', 'description', 'framework', 'endpoint'] as const) {
    const value = patch[field];
    if (value === undefined || value === record[field]) continue;
    profile[field] = value;
    changes.push(field === 'description' ? `description replaced (${value.length / 2} bytes)` : `${field} ${shown(record[field])} to ${shown(value)}`);
  }
  if (patch.capabilities !== undefined && patch.capabilities.join() !== record.capabilities.join()) {
    profile.capabilities = patch.capabilities;
    changes.push(`capabilities [${record.capabilities.map(shown).join(', ')}] to [${patch.capabilities.map(shown).join(', ')}]`);
  }
  const profileChanged = changes.length > 0;

  const keys = [...record.keys];
  for (const ref of p.removeKeys ?? []) {
    const target = ref.trim().toLowerCase();
    const at = keys.findIndex((k) => k.key === target || keyHashOf(k.key) === target);
    if (at < 0) throw new Error(`The record lists no key ${target} (a public key or a key hash), so it cannot leave.`);
    changes.push(`key ${keyHashOf(keys[at].key)} leaves`);
    keys.splice(at, 1);
  }
  for (const key of p.addKeys ?? []) {
    const hash = keyHashOf(key.key);
    if (record.keys.some((k) => k.key === key.key)) {
      throw new Error(`Key ${hash} is already listed. A kept key keeps its type, purposes and proof: to change them, remove the key in one update and add it again in a later one.`);
    }
    keys.push(key);
    if (key.keyType === 'Ed25519') signers.addKey(key.key, `new key ${hash}`);
    changes.push(`key ${hash} joins (${key.keyType}: ${purposeNames(key.purposes).join(', ') || 'no purpose'})`);
  }
  const keysChanged = keys.length !== record.keys.length || keys.some((key, i) => key !== record.keys[i]);

  const parties = record.parties.map((party) => ({ ...party }));
  const named = new Set<number>();
  const removed = new Set<number>();
  const indexOf = (ref: PartyRef, action: string): number => {
    const index = record.parties.findIndex((q) => q.role === ref.role && sameSigner(q.signer, ref.signer));
    if (index < 0) throw new Error(`The record has no ${partyText(ref)}, so this update cannot ${action} it.`);
    if (named.has(index)) throw new Error(`The ${partyText(ref)} is named twice in this update; name each party once.`);
    named.add(index);
    return index;
  };
  for (const notice of p.announcePartyRemoval ?? []) {
    const index = indexOf(notice, 'announce the removal of');
    const party = record.parties[index];
    if (party.removalAfter !== null) throw new Error(`The removal of the ${partyText(party)} is already announced for ${iso(party.removalAfter)}: remove it after that time, or let the party sign a change.`);
    const removalAfter = notice.removalAfter ?? hi + DAYS_7_MS;
    if (removalAfter < hi + DAYS_7_MS) throw new Error(`A removal notice gives the party at least 7 days from the end of the validity window: removal_after must be at or after ${iso(hi + DAYS_7_MS)}.`);
    parties[index] = { ...party, removalAfter };
    changes.push(`the removal of the ${partyText(party)} is announced for ${iso(removalAfter)} (the party does not sign)`);
  }
  for (const change of p.changeParties ?? []) {
    const index = indexOf(change, 'change');
    const party = record.parties[index];
    if (party.signer.type === 'Script') {
      throw new Error(`The ${partyText(party)} is Module-1, which consents only to its own appointment, never to a change (Part 2 Section 3.8). Announce its removal, remove it after 7 days, and appoint it again.`);
    }
    const changed: Party = {
      ...party,
      organisation: change.organisation === undefined ? party.organisation : change.organisation,
      notBefore: change.notBefore ?? party.notBefore,
      notAfter: change.notAfter === undefined ? party.notAfter : change.notAfter,
      rights: change.rights ?? party.rights,
      removalAfter: change.removalAfter === undefined ? party.removalAfter : change.removalAfter,
    };
    if (sameParty(changed, party)) throw new Error(`The change of the ${partyText(party)} changes nothing.`);
    parties[index] = changed;
    signers.addSigner(party.signer, record.controller, `changed party (${party.role})`);
    changes.push(`the ${partyText(party)} changes: ${partyDiff(party, changed)} (the party signs)`);
  }
  for (const ref of p.removeParties ?? []) {
    const index = indexOf(ref, 'remove');
    const party = record.parties[index];
    const noticeEnd = party.removalAfter;
    if (noticeEnd !== null && noticeEnd <= lo) {
      changes.push(`the ${partyText(party)} leaves (its removal notice ended at ${iso(noticeEnd)})`);
    } else {
      if (party.signer.type === 'Script') {
        throw new Error(`Module-1 never consents to its own early removal (Part 2 Section 3.8): ${noticeEnd === null
          ? 'announce the removal of the Module-1 party first, then remove it after 7 days'
          : `its removal notice ends at ${iso(noticeEnd)}; remove it once the validity window starts at or after that time`}.`);
      }
      signers.addSigner(party.signer, record.controller, `removed party (${party.role})`);
      changes.push(`the ${partyText(party)} leaves (the party signs)`);
    }
    removed.add(index);
  }
  const nextParties = parties.filter((_, i) => !removed.has(i));
  for (const spec of p.addParties ?? []) {
    if (record.parties.some((q) => q.role === spec.role && sameSigner(q.signer, spec.signer))) {
      throw new Error(`The ${partyText(spec)} is already a party of the record; change it with a party change instead.`);
    }
    const party: Party = { ...spec, notBefore: spec.notBefore ?? lo };
    nextParties.push(party);
    signers.addSigner(party.signer, record.controller, `new party (${party.role})`);
    changes.push(`the ${partyText(party)} joins with ${rightsText(party.rights)} (${party.signer.type === 'Script' ? 'Module-1 consents through its withdrawal' : 'the party signs'})`);
  }
  const appoints = appointsModule1(record.parties, nextParties);
  if (appoints) {
    const problems = module1ConsentProblems(record.parties, nextParties, lo);
    if (problems.length > 0) throw new Error(`Module-1 would not consent to this appointment: ${problems.join('; ')} (Part 2 Section 3.8).`);
  }
  const partiesChanged = nextParties.length !== record.parties.length || nextParties.some((party, i) => !sameParty(party, record.parties[i]));

  const threshold = p.guardianThreshold ?? record.guardianThreshold;
  const pendingRecovery = threshold === 0 ? null : record.pendingRecovery;
  if (threshold !== record.guardianThreshold) changes.push(`guardian threshold ${record.guardianThreshold} to ${threshold}`);
  if (record.pendingRecovery !== null && pendingRecovery === null) {
    changes.push(`the pending recovery to the controller key ${keyHashOf(record.pendingRecovery.newController)} is cancelled (threshold 0)`);
  }
  const thresholdChanged = threshold !== record.guardianThreshold;

  const next: IdentityDatum = { ...record, ...profile, keys, parties: nextParties, guardianThreshold: threshold, pendingRecovery };
  if ((partiesChanged || thresholdChanged) && !guardianBound(next, hi)) {
    const guardians = nextParties.filter((q) => q.role === 'Guardian' && hasRight(q.rights, RIGHT.recover) && (q.notAfter === null || q.notAfter >= hi)).length;
    throw new Error(`The guardian threshold ${threshold} is above the ${plural(guardians, 'Guardian Party', 'Guardian Parties')} with the recover right whose period has not ended by the end of the window (Part 2 Section 3.6): ${threshold === record.guardianThreshold ? 'lower guardian_threshold in the same update' : 'choose a lower threshold or appoint more guardians'}.`);
  }

  const lovelace = current.utxo.assets.lovelace;
  const lovelaceChanged = p.depositLovelace !== undefined && p.depositLovelace !== lovelace;
  if (p.depositLovelace !== undefined && lovelaceChanged) {
    if (p.depositLovelace < MIN_RECORD_LOVELACE) throw new Error('A live record keeps at least 10 AP3X.');
    changes.push(`the record holds ${ada(p.depositLovelace)} instead of ${ada(lovelace)}`);
  }
  if (changes.length === 0) throw new Error('The update changes nothing: give at least one field to change.');
  const areas = ([
    [profileChanged, 'the profile'], [keysChanged, 'the keys'], [partiesChanged, 'the parties'], [thresholdChanged, 'the guardian threshold'],
    [lovelaceChanged, 'the AP3X of the record'],
  ] as const).filter(([changed]) => changed).map(([, area]) => area);
  const notes = accountable(next, lo, hi) ? [] : ['no Accountable Party covers the validity window after this update, so the agent counts as suspended (unaccountable) until one does'];
  return {
    spend: { redeemer: { type: 'Update' }, next, outputLovelace: p.depositLovelace, signers, module1Consent: appoints, summary: `the controller updates ${areas.join(', ')}: ${plural(changes.length, 'change')}` },
    detail: { changes, notes },
  };
}

/** Builds the unsigned Update of a live record (Part 2 Section 3.6); planUpdate states the rules it checks. */
export async function buildUpdate(ctx: IdentityContext, p: UpdateParams): Promise<UpdateBuild> {
  const { build, detail } = await spendWith(ctx, p, ({ current, window }) => planUpdate(current, window, p));
  return { ...build, ...detail };
}

// ─── Change controller (Part 2 Section 3.5) ────────────────────────────────────────────────────────────────────────────────────

/**
 * Builds the unsigned ChangeController of a live record: the new controller key, `subagent_epoch` + 1 (every subagent ends), no
 * pending recovery. Holds stay. The old and the new controller sign. The record keeps its value.
 */
export async function buildChangeController(ctx: IdentityContext, p: BuildCommon & { id: string; newController: string }): Promise<RecordSpendBuild> {
  const { build } = await spendWith(ctx, p, ({ current }) => {
    const record = current.record;
    requireLive(current);
    const controller = p.newController.toLowerCase();
    if (controller === record.controller) throw new Error('The new controller key is the current controller key, so nothing changes.');
    return {
      spend: {
        redeemer: { type: 'ChangeController' },
        next: { ...record, controller, subagentEpoch: record.subagentEpoch + 1, pendingRecovery: null },
        signers: new SignerList().addKey(record.controller, 'controller').addKey(controller, 'new controller'),
        summary: `controller key ${keyHashOf(record.controller)} to ${keyHashOf(controller)}; subagent epoch ${record.subagentEpoch} to ${record.subagentEpoch + 1}, so every subagent created under epoch ${record.subagentEpoch} or earlier ends${record.pendingRecovery ? '; the pending recovery is cancelled' : ''}; holds stay`,
      },
      detail: null,
    };
  });
  return build;
}

// ─── Suspend and Unsuspend (Part 2 Section 3.5) ────────────────────────────────────────────────────────────────────────────────

/** Who acts in a Suspend or a Revoke: the controller, or a party of the record named by its index or by its role and signer. */
export type ActorSpec = { type: 'controller' } | { type: 'party'; index?: number; role?: Role; signer?: Signer };

/** Why no tool acts for Module-1. */
export const MODULE1_VERDICTS_ONLY = 'Module-1 acts only through its dispute verdicts, which anybody applies with the verdict token (Part 2 Section 3.8); no tool acts in its name';

/** The default reason of a new hold: 6 (hold). */
export const DEFAULT_SUSPEND_REASON = 6;

interface Acting { actor: Actor; author: Signer; text: string }

/**
 * The actor of a Suspend or a Revoke and its author (Part 2 Section 3.5): the controller (author ControllerSet), or a party that has
 * `right`, covers the window and signs (author: its signer). Adds the key that must sign to `signers`. Refuses Module-1.
 */
function actingAs(record: IdentityDatum, spec: ActorSpec | undefined, right: 'suspend' | 'revoke', window: Window, signers: SignerList): Acting {
  if (spec === undefined || spec.type === 'controller') {
    signers.addKey(record.controller, 'controller');
    return { actor: { type: 'ByController' }, author: CONTROLLER_SET, text: 'the controller' };
  }
  let index = spec.index;
  if (index === undefined) {
    if (spec.role === undefined || spec.signer === undefined) throw new Error('Name the acting party by its index, or by its role and its signer.');
    const ref: PartyRef = { role: spec.role, signer: spec.signer };
    index = record.parties.findIndex((q) => q.role === ref.role && sameSigner(q.signer, ref.signer));
    if (index < 0) throw new Error(`The record has no ${partyText(ref)}.`);
  } else if (!Number.isInteger(index) || index < 0 || index >= record.parties.length) {
    throw new Error(`The record has ${plural(record.parties.length, 'party', 'parties')}; there is no party at index ${index}.`);
  }
  const party = record.parties[index];
  if ((spec.role !== undefined && spec.role !== party.role) || (spec.signer !== undefined && !sameSigner(spec.signer, party.signer))) {
    throw new Error(`The party at index ${index} is the ${partyText(party)}, not the party named.`);
  }
  const which = `The ${partyText(party)} at index ${index}`;
  if (party.signer.type === 'Script') throw new Error(`${which} is Module-1. ${MODULE1_VERDICTS_ONLY}.`);
  if (!hasRight(party.rights, RIGHT[right])) throw new Error(`${which} has no ${right} right (it has ${rightsText(party.rights)}).`);
  if (!covers(party, window.lo, window.hi)) throw new Error(`${which} ${notCovering(party, window)}.`);
  signers.addSigner(party.signer, record.controller, `acting party ${index} (${party.role})`);
  return { actor: { type: 'ByParty', index }, author: party.signer, text: `the ${partyText(party)} at index ${index}` };
}

/** Refuses a reason code that `action` does not allow (Part 2 Appendix A); 64 belongs to Module-1's verdicts. */
function checkReason(reason: number, allowed: readonly number[], action: 'Suspend' | 'Revoke'): void {
  if (reason === REASON_DISPUTE_VERDICT) throw new Error(`Reason 64 (disputeVerdict) belongs to Module-1. ${MODULE1_VERDICTS_ONLY}.`);
  if (!allowed.includes(reason)) {
    throw new Error(`Reason ${reason} is not allowed in a ${action}: use ${allowed.filter((r) => r !== REASON_DISPUTE_VERDICT).map(reasonText).join(', ')} (Part 2 Appendix A).`);
  }
}

/** A hold that a Suspend or an Unsuspend drops, and why. */
export interface DroppedHold { hold: Hold; why: string }

function droppedHolds(holds: Hold[], kept: Hold[], lo: number, author: Signer, replaced: boolean): DroppedHold[] {
  return holds.filter((h) => !kept.includes(h)).map((hold) => ({
    hold,
    why: sameSigner(hold.by, author) ? (replaced ? 'the new hold of the same author replaces it' : 'its author lifts it')
      : hold.until <= lo ? `it ended at ${iso(hold.until)}` : 'its author is no longer a party of the record',
  }));
}

export interface SuspendParams extends BuildCommon {
  id: string;
  /** Who acts; default the controller. */
  actor?: ActorSpec;
  /** A reason code that a Suspend allows (Part 2 Appendix A; not 64); default 6 (hold). */
  reason?: number;
  /** The end of the hold (POSIX ms): after the end of the window, at most 30 days after its start. Default 30 days after the start. */
  until?: number;
  /** The length of the hold in whole days from the start of the window, instead of `until`. */
  days?: number;
}

export interface SuspendBuild extends RecordSpendBuild {
  /** The new hold, last in the list. */
  hold: Hold;
  /** The holds that stay, in their order. */
  kept: Hold[];
  dropped: DroppedHold[];
}

/**
 * Builds the unsigned Suspend of a live record (Part 2 Section 3.5) by the controller or by a party with the suspend right that covers
 * the window and signs. The status becomes Suspended: the holds in force of other current authors in their order, then the new hold
 * {by: author, reason, since: lo, until} with hi < until <= lo + 30 days. The author's older hold, ended holds and the holds of removed
 * key parties drop. The record keeps its value. Refuses Module-1 as the actor and reason 64.
 */
export async function buildSuspend(ctx: IdentityContext, p: SuspendParams): Promise<SuspendBuild> {
  const { build, detail } = await spendWith(ctx, p, ({ current, window }) => {
    const record = current.record;
    requireLive(current);
    const reason = p.reason ?? DEFAULT_SUSPEND_REASON;
    checkReason(reason, SUSPEND_REASONS, 'Suspend');
    if (p.until !== undefined && p.days !== undefined) throw new Error('Give the end of the hold as until or as days, not both.');
    if (p.days !== undefined && (!Number.isInteger(p.days) || p.days < 1)) throw new Error('days must be a whole number of days, from 1 to 30.');
    const until = p.until ?? window.lo + (p.days ?? 30) * DAY_MS;
    if (until <= window.hi) throw new Error(`A hold ends after the validity window, which ends at ${iso(window.hi)}; ${iso(until)} is too early.`);
    if (until > window.lo + DAYS_30_MS) throw new Error(`A hold lasts at most 30 days from the start of the validity window: it must end at or before ${iso(window.lo + DAYS_30_MS)}.`);
    const signers = new SignerList();
    const acting = actingAs(record, p.actor, 'suspend', window, signers);
    const holds = holdsOf(record.status);
    const kept = keptHolds(holds, record.parties, window.lo, acting.author);
    const hold: Hold = { by: acting.author, reason, since: window.lo, until };
    return {
      spend: {
        redeemer: { type: 'Suspend', actor: acting.actor }, next: { ...record, status: { type: 'Suspended', holds: [...kept, hold] } }, signers,
        summary: `${acting.text} puts a hold (${reasonText(reason)}) until ${iso(until)}; ${kept.length === 1 ? 'the hold of 1 other author stays' : `the holds of ${kept.length} other authors stay`}; status Suspended`,
      },
      detail: { hold, kept, dropped: droppedHolds(holds, kept, window.lo, acting.author, true) },
    };
  });
  return { ...build, ...detail };
}

export interface UnsuspendParams extends BuildCommon {
  id: string;
  /** The author whose hold ends: the controller (ControllerSet, the default) or a key hash. */
  author?: Signer;
}

export interface UnsuspendBuild extends RecordSpendBuild {
  author: Signer;
  /** The holds that stay, in their order. */
  kept: Hold[];
  dropped: DroppedHold[];
}

/**
 * Builds the unsigned Unsuspend of a live record (Part 2 Section 3.5): the author of a hold lifts it (ok(author) signs). The holds in
 * force of other current authors stay in their order; the status is Active when none remains. The record keeps its value. Refuses
 * Module-1 as the author: its holds end only at their until.
 */
export async function buildUnsuspend(ctx: IdentityContext, p: UnsuspendParams): Promise<UnsuspendBuild> {
  const { build, detail } = await spendWith(ctx, p, ({ current, window }) => {
    const record = current.record;
    requireLive(current);
    const author = p.author ?? CONTROLLER_SET;
    if (author.type === 'Script') throw new Error(`Module-1 never lifts its holds: a Module-1 hold ends only at its until (Part 2 Section 3.8). ${MODULE1_VERDICTS_ONLY}.`);
    const holds = holdsOf(record.status);
    if (!holds.some((h) => sameSigner(h.by, author))) {
      throw new Error(holds.length === 0
        ? `${didOf(current.id)} has no holds (status ${record.status.type}), so there is nothing to lift.`
        : `${didOf(current.id)} has no hold by ${signerText(author)}; its holds are by ${holds.map((h) => signerText(h.by)).join(', ')}.`);
    }
    const kept = keptHolds(holds, record.parties, window.lo, author);
    const status: Status = kept.length === 0 ? { type: 'Active' } : { type: 'Suspended', holds: kept };
    return {
      spend: {
        redeemer: { type: 'Unsuspend', author }, next: { ...record, status }, signers: new SignerList().addSigner(author, record.controller, 'author of the hold'),
        summary: `the hold by ${signerText(author)} ends; ${kept.length === 0 ? 'no hold remains, so the status is Active' : `${kept.length === 1 ? 'the hold of 1 other author stays' : `the holds of ${kept.length} other authors stay`}, so the status stays Suspended`}`,
      },
      detail: { author, kept, dropped: droppedHolds(holds, kept, window.lo, author, false) },
    };
  });
  return { ...build, ...detail };
}

// ─── Revoke, Retire, Reclaim and SetSuccessor (Part 2 Sections 3.5 and 3.7) ────────────────────────────────────────────────────

/**
 * The successor record of `id` (Part 2 Section 3.7): another identifier whose record is live (Active or Suspended) with lineage Root.
 * Adds its controller to `signers`; the plan reads the record as a reference input.
 */
async function successorFor(ctx: IdentityContext, id: string, successor: string, signers: SignerList): Promise<RecordUtxo> {
  const s = successor.toLowerCase();
  if (s === id) throw new Error('A record cannot name itself as its successor.');
  const found = await requireRecord(ctx.provider, ctx.deployment, s, 'successor record');
  if (terminal(found.record.status)) throw new Error(`The successor ${didOf(s)} has ended (${found.record.status.type}); a successor is a live record.`);
  if (found.record.lineage.type !== 'Root') throw new Error(`The successor ${didOf(s)} is a subagent; a successor is an independent agent (lineage Root).`);
  signers.addKey(found.record.controller, `controller of the successor ${didOf(s)}`);
  return found;
}

export interface RevokeParams extends BuildCommon {
  id: string;
  /** Who acts; default the controller. */
  actor?: ActorSpec;
  /** A reason code that a Revoke allows (Part 2 Appendix A; not 64). */
  reason: number;
  /**
   * POSIX ms from which signatures by the keys of the record are invalid, in [created_at − 3,600,000, the start of the window]; reason
   * 1 needs it.
   */
  invalidFrom?: number;
  /** The identifier of the successor; only the controller names one. */
  successor?: string;
}

/**
 * Builds the unsigned Revoke of a live record (Part 2 Sections 3.5 and 3.7) by the controller or by a party with the revoke right that
 * covers the window and signs. D' is the tombstone with Revoked{by, reason, at: lo, invalid_from, successor}. Only the controller names
 * a successor (its live Root record is a reference input, and its controller signs). The record keeps its value. Refuses Module-1 as
 * the actor, reason 64, a keyCompromise without invalid_from, and an invalid_from outside [created_at − 3,600,000, lo].
 */
export async function buildRevoke(ctx: IdentityContext, p: RevokeParams): Promise<RecordSpendBuild> {
  const { build } = await spendWith(ctx, p, async ({ current, window }) => {
    const record = current.record;
    requireLive(current);
    checkReason(p.reason, REVOKE_REASONS, 'Revoke');
    const invalidFrom = p.invalidFrom ?? null;
    if (invalidFrom === null && p.reason === REASON_KEY_COMPROMISE) {
      throw new Error('A keyCompromise revocation (reason 1) needs invalid_from: the time from which signatures by the keys of the record are invalid.');
    }
    // Part 2 Section 3.7: invalid_from is in [created_at − 3,600,000, lo]. created_at is the upper bound of the range of the transaction
    // that created the record, so the lower bound reaches the block that created it, and a keyCompromise revocation is possible at once
    // after the creation (invalid_from = lo can then be before created_at).
    const lowest = record.createdAt - MAX_RANGE_MS;
    if (invalidFrom !== null && (invalidFrom < lowest || invalidFrom > window.lo)) {
      throw new Error(`invalid_from must lie between ${iso(lowest)}, one hour before created_at (${iso(record.createdAt)}, the end of the validity window of the transaction that created the record), and the start of the validity window (${iso(window.lo)}).`);
    }
    const signers = new SignerList();
    const acting = actingAs(record, p.actor, 'revoke', window, signers);
    let successor: RecordUtxo | null = null;
    if (p.successor !== undefined) {
      if (acting.actor.type !== 'ByController') throw new Error('Only the controller names a successor: a party revokes without one, and the controller can name one later with SetSuccessor.');
      successor = await successorFor(ctx, current.id, p.successor, signers);
    }
    const status: Status = { type: 'Revoked', by: acting.author, reason: p.reason, at: window.lo, invalidFrom, successor: successor?.id ?? null };
    return {
      spend: {
        redeemer: { type: 'Revoke', actor: acting.actor }, next: tombstone(record, status), signers, refs: successor ? [successor.utxo] : [],
        summary: `${acting.text} revokes the record for good (${reasonText(p.reason)})${invalidFrom === null ? '' : `; signatures from ${iso(invalidFrom)} on are invalid`}${successor ? `; successor ${didOf(successor.id)}` : ''}; the record becomes a tombstone`,
      },
      detail: null,
    };
  });
  return build;
}

/** The build of an action that can return AP3X of the record to the wallet. */
export interface ReturningBuild extends RecordSpendBuild {
  /** The AP3X that leave the record for the wallet (0 when the record keeps its value). */
  returnedLovelace: bigint;
}

export interface RetireParams extends BuildCommon {
  id: string;
  /** The identifier of the successor. */
  successor?: string;
  /** Keep only the ledger minimum in the tombstone; the rest returns to the wallet. Default false: the tombstone keeps its value. */
  takeDeposit?: boolean;
}

/**
 * Builds the unsigned Retire of a live record (Part 2 Sections 3.5 and 3.7): the controller signs; D' is the tombstone with
 * Retired{at: lo, successor}. A successor's live Root record is a reference input, and its controller signs. The tombstone keeps its
 * value, or with `takeDeposit` only the ledger minimum.
 */
export async function buildRetire(ctx: IdentityContext, p: RetireParams): Promise<ReturningBuild> {
  const { build, current } = await spendWith(ctx, p, async ({ current, window }) => {
    const record = current.record;
    requireLive(current);
    const signers = new SignerList().addKey(record.controller, 'controller');
    const successor = p.successor === undefined ? null : await successorFor(ctx, current.id, p.successor, signers);
    return {
      spend: {
        redeemer: { type: 'Retire' }, next: tombstone(record, { type: 'Retired', at: window.lo, successor: successor?.id ?? null }), signers,
        refs: successor ? [successor.utxo] : [], outputLovelace: p.takeDeposit ? 'minimum' : undefined,
        summary: `the controller retires the record for good${successor ? `; successor ${didOf(successor.id)}` : ''}; the record becomes a tombstone${p.takeDeposit ? ' that keeps only the ledger minimum' : ''}`,
      },
      detail: null,
    };
  });
  return { ...build, returnedLovelace: current.utxo.assets.lovelace - build.outputLovelace };
}

/**
 * Builds the unsigned Reclaim of a tombstone (Part 2 Section 3.5): the controller signs, D' = D, and the output keeps only the ledger
 * minimum; the rest returns to the wallet. Refuses a live record and a tombstone that holds no more than its ledger minimum.
 */
export async function buildReclaim(ctx: IdentityContext, p: BuildCommon & { id: string }): Promise<ReturningBuild> {
  const { build, current } = await spendWith(ctx, p, ({ current }) => {
    const record = current.record;
    if (!terminal(record.status)) {
      throw new Error(`${didOf(current.id)} is live (${record.status.type}): Reclaim applies only to a record that has ended (Revoked or Retired). A Retire with take_deposit ends the record and returns the deposit in one transaction.`);
    }
    return {
      spend: {
        redeemer: { type: 'Reclaim' }, next: record, signers: new SignerList().addKey(record.controller, 'controller'), outputLovelace: 'minimum',
        summary: 'the controller takes back the AP3X of the tombstone above the ledger minimum; the tombstone stays',
      },
      detail: null,
    };
  });
  const returned = current.utxo.assets.lovelace - build.outputLovelace;
  if (returned <= 0n) throw new Error(`The tombstone of ${build.did} holds ${ada(current.utxo.assets.lovelace)}, not more than its ledger minimum of ${ada(build.outputLovelace)}, so there is nothing to reclaim.`);
  return { ...build, returnedLovelace: returned };
}

/**
 * Builds the unsigned SetSuccessor of a tombstone without a successor (Part 2 Sections 3.5 and 3.7), also after a party revocation:
 * the controller signs, the successor's live Root record is a reference input, and its controller signs. Only the successor changes;
 * the record keeps its value.
 */
export async function buildSetSuccessor(ctx: IdentityContext, p: BuildCommon & { id: string; successor: string }): Promise<RecordSpendBuild> {
  const { build } = await spendWith(ctx, p, async ({ current }) => {
    const record = current.record;
    const status = record.status;
    if (status.type !== 'Revoked' && status.type !== 'Retired') {
      throw new Error(`${didOf(current.id)} is live (${status.type}): SetSuccessor applies only to a record that has ended. Name the successor in the Revoke or the Retire.`);
    }
    if (status.successor !== null) throw new Error(`${didOf(current.id)} already names the successor ${didOf(status.successor)}; a record names its successor once.`);
    const signers = new SignerList().addKey(record.controller, 'controller');
    const successor = await successorFor(ctx, current.id, p.successor, signers);
    return {
      spend: {
        redeemer: { type: 'SetSuccessor' }, next: { ...record, status: { ...status, successor: successor.id } }, signers, refs: [successor.utxo],
        summary: `the ${status.type} record names ${didOf(successor.id)} as its successor`,
      },
      detail: null,
    };
  });
  return build;
}

// ─── Recovery (Part 2 Section 3.5) ─────────────────────────────────────────────────────────────────────────────────────────────

/** A guardian as a recovery step names it: its index in the party list, or its key hash. */
export type GuardianRef = number | string;

/**
 * The guardians that act in a RecoverInit or a RecoverCancel (Part 2 Section 3.5): eligible guardians (role Guardian, the recover
 * right, covering the window) with distinct signers, at least the guardian threshold of them. Adds each to `signers`; returns their
 * indices in the order given.
 */
function actingGuardians(record: IdentityDatum, refs: GuardianRef[], window: Window, signers: SignerList): number[] {
  const indices: number[] = [];
  for (const ref of refs) {
    let index: number;
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref >= record.parties.length) throw new Error(`The record has ${plural(record.parties.length, 'party', 'parties')}; there is no party at index ${ref}.`);
      index = ref;
    } else {
      const hash = ref.trim().toLowerCase();
      index = record.parties.findIndex((q) => q.role === 'Guardian' && q.signer.type === 'KeyHash' && q.signer.hash === hash);
      if (index < 0) throw new Error(`The record has no Guardian Party with the key hash ${hash}.`);
    }
    const party = record.parties[index];
    const which = `The ${partyText(party)} at index ${index}`;
    if (party.role !== 'Guardian') throw new Error(`${which} is not a guardian.`);
    if (!hasRight(party.rights, RIGHT.recover)) throw new Error(`${which} has no recover right.`);
    if (!covers(party, window.lo, window.hi)) throw new Error(`${which} ${notCovering(party, window)}.`);
    if (indices.some((i) => sameSigner(record.parties[i].signer, party.signer))) throw new Error(`${which} is named twice; each guardian counts once.`);
    indices.push(index);
    signers.addSigner(party.signer, record.controller, `guardian (party index ${index})`);
  }
  if (indices.length < record.guardianThreshold) {
    const eligible = record.parties.filter((q) => eligibleGuardian(q, window.lo, window.hi)).length;
    throw new Error(`The record needs ${plural(record.guardianThreshold, 'guardian')} to act together; ${indices.length} named, and ${eligible} of its guardians cover the validity window.`);
  }
  return indices;
}

export interface RecoveryParams extends BuildCommon {
  id: string;
  /** The guardians that act and sign: at least the guardian threshold of them. */
  guardians: GuardianRef[];
}

export interface RecoveryBuild extends RecordSpendBuild {
  /** The party indices of the guardians that act. */
  guardians: number[];
}

/**
 * Builds the unsigned RecoverInit of a live record (Part 2 Section 3.5): with a guardian threshold of at least 1 and no pending
 * recovery, enough eligible guardians sign, and so does the new controller key. pending_recovery = {new_controller, effective_after:
 * hi + 7 days}. The record keeps its value.
 */
export async function buildRecoveryStart(ctx: IdentityContext, p: RecoveryParams & { newController: string }): Promise<RecoveryBuild> {
  const { build, detail } = await spendWith(ctx, p, ({ current, window }) => {
    const record = current.record;
    requireLive(current);
    if (record.guardianThreshold < 1) throw new Error(`${didOf(current.id)} has a guardian threshold of 0, so recovery is off; the controller sets a threshold with an update first.`);
    const pending = record.pendingRecovery;
    if (pending) throw new Error(`A recovery to the controller key ${keyHashOf(pending.newController)} is already pending (it can complete from ${iso(pending.effectiveAfter)}); cancel or complete it first.`);
    const newController = p.newController.toLowerCase();
    const signers = new SignerList();
    const guardians = actingGuardians(record, p.guardians, window, signers);
    signers.addKey(newController, 'new controller');
    const effectiveAfter = window.hi + DAYS_7_MS;
    return {
      spend: {
        redeemer: { type: 'RecoverInit', guardians }, next: { ...record, pendingRecovery: { newController, effectiveAfter } }, signers,
        summary: `${plural(guardians.length, 'guardian')} start a recovery to the controller key ${keyHashOf(newController)}; anybody can complete it from ${iso(effectiveAfter)}. Until then the guardians can cancel it, and the controller ends it with a controller change or a guardian threshold of 0`,
      },
      detail: { guardians },
    };
  });
  return { ...build, ...detail };
}

/** Builds the unsigned RecoverCancel of a live record with a pending recovery (Part 2 Section 3.5): enough eligible guardians sign. */
export async function buildRecoveryCancel(ctx: IdentityContext, p: RecoveryParams): Promise<RecoveryBuild> {
  const { build, detail } = await spendWith(ctx, p, ({ current, window }) => {
    const record = current.record;
    requireLive(current);
    const pending = record.pendingRecovery;
    if (!pending) throw new Error(`${didOf(current.id)} has no pending recovery to cancel.`);
    const signers = new SignerList();
    const guardians = actingGuardians(record, p.guardians, window, signers);
    return {
      spend: {
        redeemer: { type: 'RecoverCancel', guardians }, next: { ...record, pendingRecovery: null }, signers,
        summary: `${plural(guardians.length, 'guardian')} cancel the recovery to the controller key ${keyHashOf(pending.newController)}`,
      },
      detail: { guardians },
    };
  });
  return { ...build, ...detail };
}

/**
 * Builds the unsigned RecoverFinalize of a live record (Part 2 Section 3.5) once effective_after <= lo: controller = new_controller, no
 * pending recovery, `subagent_epoch` + 1. Anybody may submit it, so only the wallet signs. The record keeps its value. Refuses an early
 * build with the time the recovery opens.
 */
export async function buildRecoveryComplete(ctx: IdentityContext, p: BuildCommon & { id: string }): Promise<RecordSpendBuild> {
  const { build } = await spendWith(ctx, p, ({ current, window }) => {
    const record = current.record;
    requireLive(current);
    const pending = record.pendingRecovery;
    if (!pending) throw new Error(`${didOf(current.id)} has no pending recovery to complete.`);
    if (pending.effectiveAfter > window.lo) {
      throw new Error(`The recovery to the controller key ${keyHashOf(pending.newController)} opens at ${iso(pending.effectiveAfter)}. The validity window must start at or after that time, so build it at or after ${iso(pending.effectiveAfter + 60_000)}.`);
    }
    return {
      spend: {
        redeemer: { type: 'RecoverFinalize' },
        next: { ...record, controller: pending.newController, pendingRecovery: null, subagentEpoch: record.subagentEpoch + 1 },
        signers: new SignerList(),
        summary: `the controller key becomes ${keyHashOf(pending.newController)}; subagent epoch ${record.subagentEpoch} to ${record.subagentEpoch + 1}, so every subagent created under epoch ${record.subagentEpoch} or earlier ends`,
      },
      detail: null,
    };
  });
  return build;
}
