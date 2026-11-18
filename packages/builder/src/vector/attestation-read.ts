// packages/builder/src/vector/attestation-read.ts
// Reads of attestations (Part 2 Section 4): one attestation by its identifier, the attestations about a subject or from an issuer, and
// the check of one attestation against the validity rule of Section 4.3. The lists come from Koios (the outputs at the script credential
// that hold an attestation token), and every row is decoded and filtered on the decoded field. The check gives each condition of the
// rule with its result, then each expectation of the caller. Reads only: nothing is built, signed or submitted.
import { Constr, Data } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { attTypeName, envelopeVerifies, withdrawableFrom } from './attestation-build.js';
import type { AttestationUtxo } from './attestation-build.js';
import { attestationDatumFromData, decodeAttestationDatum } from './identity-codec.js';
import type { AttestationDatum } from './identity-codec.js';
import { didOf, findRecord, findTokenOutput, identifierOf } from './identity-chain.js';
import type { RecordUtxo } from './identity-chain.js';
import { MAX_DEPTH, MAX_RANGE_MS, PURPOSE, activeKey, keyHashOf } from './identity-rules.js';
import { DEFAULT_PAGE, checkPage, credentialOutputs, credentialPage, pageOf, soleTokenName, withinBudget } from './ledger-read.js';
import type { LedgerEnv, Page, ReadSession } from './ledger-read.js';
import { isoOrRaw } from './marketplace-shared.js';

/** An attestation with what its readers show beside the datum. */
export interface AttestationView extends AttestationUtxo {
  /** `<tx hash>#<index>` of its output at the attestation address. */
  ref: string;
  lovelace: bigint;
  /** The earliest time from which the issuer can withdraw the deposit (Part 2 Section 4.1), or null while it cannot (an active attestation without valid_until). */
  withdrawableFrom: number | null;
  /**
   * The reason of the revocation, exact; null while the attestation is active. A reason can be any integer on chain, and a number holds
   * only the ones below 2^53: for a larger reason `attestation.status.reason` is NaN, so a reader always takes the reason from here.
   */
  revokeReason: bigint | null;
}

const viewOf = ({ id, utxo, attestation }: AttestationUtxo, revokeReason: bigint | null): AttestationView => ({
  id, utxo, attestation, ref: `${utxo.txHash}#${utxo.outputIndex}`, lovelace: utxo.assets.lovelace, withdrawableFrom: withdrawableFrom(attestation), revokeReason,
});

/** A datum with the reason of its revocation taken out, and that reason. */
interface DatumWithoutReason { data: Data; reason: bigint }

/** An attestation datum as a read holds it, and the exact reason of its revocation (null while it is active). */
export interface ReadDatum { datum: AttestationDatum; revokeReason: bigint | null }

/**
 * The datum `hex` with the reason of its revocation replaced by 0, and that reason; null when the datum has no revocation reason that
 * is a whole number. The codec holds a reason as a number, and refuses one that a number cannot hold.
 */
function withoutReason(hex: string): DatumWithoutReason | null {
  const data = Data.from(hex);
  if (!(data instanceof Constr) || data.index !== 0 || data.fields.length !== 16) return null;
  const status = data.fields[13];
  if (!(status instanceof Constr) || status.index !== 1 || status.fields.length !== 2 || typeof status.fields[1] !== 'bigint') return null;
  return { data: new Constr(0, data.fields.map((field, i) => (i === 13 ? new Constr(1, [status.fields[0], 0n]) : field))), reason: status.fields[1] };
}

/**
 * The datum of an attestation, for a read. The reason of a revocation is any integer on chain (the contract bounds it by 2^63), and
 * the codec of the builders refuses a reason above 2^53, because it holds one as a number. A read must not lose such an attestation, so
 * it reads that one field as a bigint: `revokeReason` is exact, and `datum.status.reason` is NaN when a number cannot hold it. Every
 * other field is read as the codec reads it, and a datum that fails for another reason fails here too.
 */
export function readAttestationDatum(hex: string): ReadDatum {
  try {
    const datum = decodeAttestationDatum(hex);
    return { datum, revokeReason: datum.status.type === 'AttRevoked' ? BigInt(datum.status.reason) : null };
  } catch (strict) {
    let wide: DatumWithoutReason | null = null;
    try { wide = withoutReason(hex); } catch { /* not Plutus Data: the codec's error says so */ }
    if (wide === null) throw strict;
    const datum = attestationDatumFromData(wide.data);
    if (datum.status.type !== 'AttRevoked') throw strict;
    return { datum: { ...datum, status: { type: 'AttRevoked', at: datum.status.at, reason: Number.NaN } }, revokeReason: wide.reason };
  }
}

/**
 * The attestation `id` (an authentic output at the attestation address, read through Koios and confirmed on the node), or null. Without a
 * `session` the read opens a budget of its own (withinBudget); a read that is part of a larger call passes the session of that call.
 */
export async function readAttestation(env: LedgerEnv, id: string, session?: ReadSession): Promise<AttestationView | null> {
  if (session === undefined) return withinBudget(env, (inside, own) => readAttestation(inside, id, own));
  const wanted = id.toLowerCase();
  const utxo = await findTokenOutput(env.provider, env.deployment.attestation.address, env.deployment.attestation.hash, wanted);
  if (utxo === null) return null;
  const ref = `${utxo.txHash}#${utxo.outputIndex}`;
  if (!utxo.datum) throw new Error(`The attestation ${wanted} (${ref}) has no inline datum.`);
  try {
    const { datum, revokeReason } = readAttestationDatum(utxo.datum);
    return viewOf({ id: wanted, utxo, attestation: datum }, revokeReason);
  } catch (err) {
    throw new Error(`The attestation ${wanted} (${ref}) does not decode: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── States ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where an attestation stands at a time: revoked, past valid_until, before valid_from or before it existed, or none of these. */
export type AttestationState = 'active' | 'revoked' | 'expired' | 'not_yet_valid';

/**
 * The state of `a` at `atMs`. The bounds are inclusive: the time `valid_from` and the time `valid_until` are inside the range. A time
 * more than one hour before `issued_at` is before the attestation existed, whatever `valid_from` says: `issued_at` is the end of the
 * validity window of the transaction that made it, and that window is at most one hour long.
 */
export function attestationState(a: AttestationDatum, atMs: number): AttestationState {
  if (a.status.type === 'AttRevoked') return 'revoked';
  if (a.validUntil !== null && atMs > a.validUntil) return 'expired';
  if ((a.validFrom !== null && atMs < a.validFrom) || atMs < a.issuedAt - MAX_RANGE_MS) return 'not_yet_valid';
  return 'active';
}

// ─── Issuers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An issuer as a caller names it: a registered issuer by its DID (it matches `issuer_id`), the issuer key by its key hash or its
 * public key (both match the key by its key hash), or a bare 64-hex value that can be either an issuer identifier or a public key
 * (it matches by either reading).
 */
export type IssuerRef = { type: 'did'; id: string } | { type: 'key'; publicKey: string } | { type: 'key_hash'; hash: string } | { type: 'id_or_key'; value: string };

/**
 * An issuer from text: a DID (`did:vector:<64 hex>`), a key hash (56 hex), or 64 hex that name an issuer identifier or an Ed25519
 * public key: both are 32 bytes, so the text does not tell which one it is.
 */
export function parseIssuer(text: string): IssuerRef {
  const value = text.trim();
  if (/^did:/i.test(value)) return { type: 'did', id: identifierOf(value) };
  if (/^[0-9a-fA-F]{56}$/.test(value)) return { type: 'key_hash', hash: value.toLowerCase() };
  if (/^[0-9a-fA-F]{64}$/.test(value)) return { type: 'id_or_key', value: value.toLowerCase() };
  throw new Error('The issuer must be a DID (did:vector:<64 hex>), a key hash (56 hex), or 64 hex that name an issuer identifier or an Ed25519 public key.');
}

/** Does `a` name `issuer`? A DID matches `issuer_id`; a key or a key hash matches the issuer key by its key hash; 64 hex match by either. */
export function issuerMatches(a: AttestationDatum, issuer: IssuerRef): boolean {
  if (issuer.type === 'did') return a.issuerId === issuer.id;
  if (issuer.type === 'id_or_key') return a.issuerId === issuer.value || keyHashOf(a.issuer) === keyHashOf(issuer.value);
  return keyHashOf(a.issuer) === (issuer.type === 'key' ? keyHashOf(issuer.publicKey) : issuer.hash);
}

// ─── List ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AttestationQuery {
  /** The subject: a DID or an identifier. */
  subject?: string;
  issuer?: IssuerRef;
  /** The type code (0 to 5, or 15). A type narrows a list by subject or by issuer, so it needs one of them. */
  attType?: number;
  offset?: number;
  limit?: number;
}

/**
 * A page of attestations. `total` is how many attestations match when the list names a subject or an issuer. It is null for the list of
 * every attestation, which Koios pages and does not count: `nextOffset` then says whether more rows follow.
 */
export interface AttestationPage extends Omit<Page<AttestationView>, 'total'> { total: number | null }

/** Newest first by `issued_at`, then by identifier: the order is the same on every call while the set does not change. */
const newestFirst = (a: AttestationView, b: AttestationView): number =>
  b.attestation.issuedAt - a.attestation.issuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** What a list says when 5,000 or more attestation outputs name its subject or its issuer: the read cannot take them all. */
const TOO_MANY_FOR_BYTES = 'The list cannot read them all: read one attestation by its identifier (vector_get_attestation).';
/** What a list by an issuer key hash alone says when 5,000 or more attestation outputs exist. */
const TOO_MANY_FOR_KEY_HASH = 'A key hash alone cannot narrow the read, because a datum holds the public key and not its hash. Give the public key, the issuer DID or a subject, or read one attestation by its identifier (vector_get_attestation).';

/** The bytes that a datum holds for `issuer`, to narrow a read by them. Null for a key hash: no datum holds it. */
function issuerBytes(issuer: IssuerRef): string | null {
  if (issuer.type === 'did') return issuer.id;
  if (issuer.type === 'key') return issuer.publicKey;
  return issuer.type === 'id_or_key' ? issuer.value : null;
}

/**
 * The attestations among `outputs`. Each must be authentic (exactly at the attestation address, with exactly one token of the attestation
 * policy), and its datum must decode (readAttestationDatum). An output that is not, or that does not decode, is left out.
 */
function attestationsIn(env: LedgerEnv, outputs: UTxO[]): AttestationView[] {
  const { attestation } = env.deployment;
  const views: AttestationView[] = [];
  for (const utxo of outputs) {
    const id = soleTokenName(utxo, attestation.address, attestation.hash);
    if (id === null || !utxo.datum) continue;
    // A token of the policy is minted only with a datum that passes the content rules, so a datum that does not decode is no attestation.
    let read: ReadDatum;
    try { read = readAttestationDatum(utxo.datum); } catch { continue; }
    views.push(viewOf({ id, utxo, attestation: read.datum }, read.revokeReason));
  }
  return views;
}

/** The attestations about `subject` or from `q.issuer`, of the type `q.attType` when it is set: newest first, one page. */
async function listNamed(env: LedgerEnv, q: AttestationQuery, subject: string | undefined): Promise<AttestationPage> {
  const { attestation } = env.deployment;
  // One filter on the datum narrows the read: the bytes of the subject when there is a subject, else those of the issuer. The decoded fields decide.
  const bytes = subject ?? (q.issuer === undefined ? null : issuerBytes(q.issuer));
  const filter = bytes === null ? { assetPolicy: attestation.hash } : { assetPolicy: attestation.hash, datumContains: bytes };
  const outputs = await credentialOutputs(env, attestation.hash, filter, bytes === null ? TOO_MANY_FOR_KEY_HASH : TOO_MANY_FOR_BYTES);
  const found = attestationsIn(env, outputs).filter(({ attestation: a }) =>
    (subject === undefined || a.subject === subject) && (q.issuer === undefined || issuerMatches(a, q.issuer)) && (q.attType === undefined || a.attType === q.attType));
  return pageOf(found.sort(newestFirst), q.offset, q.limit);
}

/** One page of every attestation, in the order of the output reference: Koios pages it, and the call reads no more than the page. */
async function listAll(env: LedgerEnv, offset = 0, limit = DEFAULT_PAGE): Promise<AttestationPage> {
  const { attestation } = env.deployment;
  const { outputs, more } = await credentialPage(env, attestation.hash, { assetPolicy: attestation.hash }, offset, limit);
  return { items: attestationsIn(env, outputs), total: null, offset, limit, nextOffset: more ? offset + limit : null };
}

/**
 * The attestations about `subject` or from `issuer`, newest first, one page. Koios lists the outputs at the attestation credential that
 * hold a token of the attestation policy and whose inline datum holds the bytes of the subject (or, with no subject, of the issuer), in
 * one read. The limit of 5,000 or more outputs that makes a read fail is then the limit of one subject or one issuer, and not of all
 * attestations. The filter on the datum is coarse: a 32-byte value is also a digest or a link target. So each row must be authentic
 * (exactly at the attestation address, with exactly one token of the policy), its datum must decode (readAttestationDatum), and then the
 * subject, the issuer and the type are compared on the decoded fields. An output without the token is not listed and does not count. An
 * attestation whose datum writes those bytes in a non-standard form (a byte string in chunks) is not listed: readAttestation finds it by
 * its identifier. An issuer that is given by its key hash alone has no bytes in a datum to filter by: the read then takes every attestation
 * output, and it fails when 5,000 or more exist.
 *
 * With neither a subject nor an issuer, Koios pages the list on the server, with the token filter only, in the order of the output
 * reference (not newest first). The call reads no more than the page, `total` is null, and a type cannot narrow the list.
 *
 * Rows are as Koios lists them: no node read confirms them (readAttestation confirms one attestation on the node). A set that changes
 * between two calls can repeat or skip a row at a page boundary. The whole call runs inside one budget (withinBudget).
 */
export async function listAttestations(env: LedgerEnv, q: AttestationQuery): Promise<AttestationPage> {
  checkPage(q.offset, q.limit);
  const subject = q.subject === undefined ? undefined : identifierOf(q.subject);
  const named = subject !== undefined || q.issuer !== undefined;
  if (!named && q.attType !== undefined) throw new Error('A type narrows a list by subject or by issuer: name one of them.');
  return withinBudget(env, (inside) => (named ? listNamed(inside, q, subject) : listAll(inside, q.offset, q.limit)));
}

// ─── Check ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `pass` and `fail` are verdicts; `not_applicable` means that the condition does not apply to this attestation (it has no envelope, or no issuer record). */
export type CheckResult = 'pass' | 'fail' | 'not_applicable';
/** One condition of the rule, or one expectation of the caller, with its result and the facts behind it. */
export interface CheckLine { id: string; label: string; result: CheckResult; detail: string }

/** What a relying party expects of the attestation. Each field that is set must match. */
export interface AttestationExpectations {
  attType?: number;
  /** A DID or an identifier. */
  subject?: string;
  issuer?: IssuerRef;
  /** The SHA-256 of the document (64 hex). */
  digest?: string;
}

export interface AttestationCheck {
  id: string;
  /** The time the check used: the time of the caller, or now. */
  atMs: number;
  /** The attestation, or null when no authentic output holds its token. */
  attestation: AttestationView | null;
  /** The conditions of Part 2 Section 4.3, in the order of the rule. */
  conditions: CheckLine[];
  /** The expectations of the caller, in the order type, subject, issuer, digest. */
  expectations: CheckLine[];
  /** Every condition of the rule passes or does not apply. */
  ruleValid: boolean;
  /** The rule holds and every expectation that was given passes. */
  valid: boolean;
}

/** The conditions of Part 2 Section 4.3, by the id that a check line carries. */
const RULE = {
  authentic: 'The attestation is authentic: one output at the attestation address holds its token (Section 4.1)',
  active: 'The status is AttActive',
  time_window: 'The time is inside valid_from and valid_until, and not more than one hour before issued_at',
  envelope: 'The envelope signature verifies, if there is one (Section 4.2)',
  issuer_not_invalidated: 'The issuer identity and its ancestors have no invalid-from time at or before issued_at',
  issuer_key_listed: 'A registered issuer listed the issuer key with the assertion purpose when it issued the attestation',
} as const;
type RuleId = keyof typeof RULE;

const iso = isoOrRaw;
const rule = (id: RuleId, result: CheckResult, detail: string): CheckLine => ({ id, label: RULE[id], result, detail });

/** The record of an issuer identity and its ancestors, the record first. `missing` names the first record that the registry does not hold. */
async function issuerIdentity(env: LedgerEnv, issuerId: string): Promise<{ records: RecordUtxo[]; missing: string | null }> {
  const records: RecordUtxo[] = [];
  for (let next: string | null = issuerId; next !== null;) {
    if (records.length > MAX_DEPTH) throw new Error('The lineage of the issuer is deeper than 4 levels.');
    const record = await findRecord(env.provider, env.deployment, next);
    if (record === null) return { records, missing: next };
    records.push(record);
    next = record.record.lineage.type === 'Subagent' ? record.record.lineage.parent : null;
  }
  return { records, missing: null };
}

/** The conditions of Part 2 Section 4.3 for an attestation that exists, at `atMs`. */
async function ruleConditions(env: LedgerEnv, view: AttestationView, atMs: number): Promise<CheckLine[]> {
  const a = view.attestation;
  const lines: CheckLine[] = [rule('authentic', 'pass', `output ${view.ref} holds the token ${view.id}`)];
  lines.push(a.status.type === 'AttActive'
    ? rule('active', 'pass', 'the attestation is not revoked')
    : rule('active', 'fail', `the attestation was revoked at ${iso(a.status.at)} with reason ${view.revokeReason}`));

  const from = a.validFrom === null ? 'no start' : iso(a.validFrom);
  const until = a.validUntil === null ? 'no end' : iso(a.validUntil);
  const existed = a.issuedAt - MAX_RANGE_MS;
  if (atMs < existed) lines.push(rule('time_window', 'fail', `the time ${iso(atMs)} is more than one hour before issued_at ${iso(a.issuedAt)}, so the attestation did not exist yet`));
  else if (a.validFrom !== null && atMs < a.validFrom) lines.push(rule('time_window', 'fail', `the time ${iso(atMs)} is before valid_from ${from}`));
  else if (a.validUntil !== null && atMs > a.validUntil) lines.push(rule('time_window', 'fail', `the time ${iso(atMs)} is after valid_until ${until}`));
  else lines.push(rule('time_window', 'pass', `the time ${iso(atMs)} is inside ${from} to ${until} (the bounds are inclusive), and not before ${iso(existed)}, one hour before issued_at`));

  if (a.envelopeSig === null) lines.push(rule('envelope', 'not_applicable', 'the attestation has no envelope signature'));
  else {
    const verified = envelopeVerifies({ issuer: a.issuer, issuerId: a.issuerId, subject: a.subject, issuedAt: a.issuedAt, format: a.format, digest: a.digest }, a.envelopeSig);
    lines.push(verified ? rule('envelope', 'pass', 'envelope_sig verifies with the issuer key') : rule('envelope', 'fail', 'envelope_sig does not verify with the issuer key over the Sig_structure'));
  }

  if (a.issuerId === null) {
    lines.push(rule('issuer_not_invalidated', 'not_applicable', 'the issuer is a key without a record: there is no identity to check'));
    lines.push(rule('issuer_key_listed', 'not_applicable', 'the issuer is a key without a record'));
    return lines;
  }
  const { records, missing } = await issuerIdentity(env, a.issuerId);
  if (missing !== null) {
    lines.push(rule('issuer_not_invalidated', 'fail', `the record of ${didOf(missing)} cannot be read, so its invalid-from time is unknown`));
  } else {
    let earliest: { id: string; at: number } | null = null;
    for (const r of records) {
      const status = r.record.status;
      if (status.type === 'Revoked' && status.invalidFrom !== null && (earliest === null || status.invalidFrom < earliest.at)) earliest = { id: r.id, at: status.invalidFrom };
    }
    const scope = records.length > 1 ? `${didOf(a.issuerId)} and its ${records.length - 1} ancestor${records.length > 2 ? 's' : ''}` : didOf(a.issuerId);
    if (earliest !== null && earliest.at <= a.issuedAt) {
      lines.push(rule('issuer_not_invalidated', 'fail', `${didOf(earliest.id)} is revoked with the invalid-from time ${iso(earliest.at)}, at or before issued_at ${iso(a.issuedAt)}`));
    } else {
      lines.push(rule('issuer_not_invalidated', 'pass', earliest === null ? `${scope} has no invalid-from time` : `the earliest invalid-from time of ${scope} is ${iso(earliest.at)}, after issued_at ${iso(a.issuedAt)}`));
    }
  }
  const keyHash = keyHashOf(a.issuer);
  const removed = records.length > 0 && !activeKey(records[0].record, keyHash, PURPOSE.assertion);
  lines.push(rule('issuer_key_listed', 'pass',
    `the contract checked it when the attestation was made; a later key removal does not undo an earlier signature, so it is not checked again${removed ? ` (the record does not list the key ${keyHash} now)` : ''}`));
  return lines;
}

/** The expectations of the caller against `a` (null: there is no attestation, so none can hold). */
function expectationLines(a: AttestationDatum | null, expected: AttestationExpectations): CheckLine[] {
  const lines: CheckLine[] = [];
  const add = (id: string, label: string, holds: boolean | null, found: string) =>
    lines.push({ id, label, result: holds === true ? 'pass' : 'fail', detail: holds === null ? 'no attestation to compare' : found });
  if (expected.attType !== undefined) {
    add('type', `The type is ${attTypeName(expected.attType)} (${expected.attType})`, a && a.attType === expected.attType, `the attestation has the type ${a ? `${attTypeName(a.attType)} (${a.attType})` : ''}`);
  }
  if (expected.subject !== undefined) {
    const subject = identifierOf(expected.subject);
    add('subject', `The subject is ${didOf(subject)}`, a && a.subject === subject, `the attestation is about ${a ? didOf(a.subject) : ''}`);
  }
  if (expected.issuer !== undefined) {
    const issuer = expected.issuer;
    const label = issuer.type === 'did' ? `The issuer is ${didOf(issuer.id)}`
      : issuer.type === 'id_or_key' ? `The issuer is ${didOf(issuer.value)}, or the issuer key is ${issuer.value}`
        : `The issuer key has the key hash ${issuer.type === 'key' ? keyHashOf(issuer.publicKey) : issuer.hash}`;
    const found = a === null ? '' : a.issuerId === null ? `the issuer key has the key hash ${keyHashOf(a.issuer)} and no issuer record` : `the issuer is ${didOf(a.issuerId)}, with the key hash ${keyHashOf(a.issuer)}`;
    add('issuer', label, a && issuerMatches(a, issuer), found);
  }
  if (expected.digest !== undefined) {
    const digest = expected.digest.toLowerCase();
    add('digest', `The digest is ${digest}`, a && a.digest === digest, `the attestation has the digest ${a ? a.digest : ''}`);
  }
  return lines;
}

/**
 * Checks the attestation `id` at `atMs` against the validity rule of Part 2 Section 4.3 and against what the caller expects. The
 * rule holds when the attestation is authentic and active, the time is inside `valid_from` and `valid_until`, its envelope
 * signature verifies (if it has one), and no invalid-from time of the issuer identity or of an ancestor is at or before `issued_at`.
 * `issued_at` is the end of the validity window of the transaction that made the attestation, so it can lie after the block time and
 * after the time of the check: a time up to one hour before `issued_at` can still be a time at which the attestation existed. A time
 * more than one hour before it is before the attestation existed, and the time condition fails. An attestation that does not exist is
 * not valid. A revoked one is not valid, whatever its reason (the reason is read as an exact integer).
 * The whole call runs inside one budget (withinBudget).
 */
export async function checkAttestation(env: LedgerEnv, p: { id: string; atMs: number; expect?: AttestationExpectations }): Promise<AttestationCheck> {
  const id = p.id.toLowerCase();
  return withinBudget(env, async (inside, session) => {
    const view = await readAttestation(inside, id, session);
    const expectations = expectationLines(view === null ? null : view.attestation, p.expect ?? {});
    if (view === null) {
      const conditions = [
        rule('authentic', 'fail', `no output at ${inside.deployment.attestation.address} holds the token ${id}: it does not exist, it was withdrawn, or it is not confirmed yet`),
        ...(['active', 'time_window', 'envelope', 'issuer_not_invalidated', 'issuer_key_listed'] as const).map((r) => rule(r, 'not_applicable', 'no attestation to check')),
      ];
      return { id, atMs: p.atMs, attestation: null, conditions, expectations, ruleValid: false, valid: false };
    }
    const conditions = await ruleConditions(inside, view, p.atMs);
    const ruleValid = conditions.every((c) => c.result !== 'fail');
    return { id, atMs: p.atMs, attestation: view, conditions, expectations, ruleValid, valid: ruleValid && expectations.every((e) => e.result !== 'fail') };
  });
}
