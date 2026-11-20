// packages/builder/src/vector/signature-at.ts
// The check behind vector_verify_signature_at: was an Ed25519 signature valid at a time that the caller names?
//
// The check asks the identity gateway for the DID as it was at that time (DID Resolution `versionTime`, Part 1 Section 7.1) and decides from
// that one answer. The answer is VALID only when every check passes: the time is at least 10 minutes before now and before the tip block of the
// node, the DID has a version at the time, the version has a DID document (the DID is not deactivated or invalidated at the time), the
// gateway is current (the tip of the node is at most 10 minutes old, and the ledger tip of the gateway is at most 30 blocks behind it), the time
// lies inside the version (it started at or before the time, and its next update, when there is one, is after the time), the effective status of
// the version is active, no invalid-from time lies at or before the time, the version lists the key for the purpose, the listed key is the key
// that the caller gave, and the signature verifies.
//
// A refusal never turns into a pass. A DID that did not exist, a deactivated DID, a status that is not active, a key that is not listed and
// a signature that does not verify give INVALID, with the first check that failed. A time that is too recent, a node tip that is stale, a
// gateway that is behind the node, a tip that the check cannot read, an answer that the check cannot read or trust, an error of the gateway
// and a key type that the check does not know give NOT CHECKED. Text from the gateway is cleaned with `cell` before it is kept. A decision
// reads the text as the gateway wrote it, not the cleaned text.
//
// The time is the claim of the caller. The check cannot prove when the signature was made (TIME_CLAIM_NOTE).
import { createHash } from 'node:crypto';
import { isJsonObject, resolveDid } from './identity-gateway.js';
import type { GatewayAnswer, ResolutionOptions } from './identity-gateway.js';
import { keyHashOf } from './identity-rules.js';
import { signatureVerifies } from './delegation-cosign.js';
import { cell } from './marketplace-shared.js';

/**
 * A time that is less than this long before now is too recent. It must also be at least this long before the tip block of the node, so that
 * its age is measured on the chain as well as on the clock of the server. A change after the time can still have fewer than 30 confirmations,
 * and the gateway does not show it. A time in the future is too recent.
 */
export const MIN_AGE_MS = 10 * 60 * 1000;
/** The gateway is current when its ledger tip is at most this many blocks behind the tip of the node. 30 blocks are its confirmation depth. */
export const MAX_GATEWAY_LAG_BLOCKS = 30;
/**
 * The tip of the node is the reference for the tip of the chain. A node whose tip block is older than this has stopped (or runs on a clock
 * that is wrong), and a gateway that is as far behind as the node would pass the check of the lag. So the check does not decide then.
 */
export const MAX_NODE_TIP_AGE_MS = 10 * 60 * 1000;
/** The longest time that the read of the tip of the node takes. */
export const NODE_READ_MS = 10_000;
/** The deepest nesting of a gateway answer that the check reads. A resolution result of the gateway nests about six levels. */
export const MAX_JSON_DEPTH = 64;

// ─── Inputs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The verification relationships that a key can have for a signature (DID Core). */
export const PURPOSES = ['assertionMethod', 'authentication'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const DEFAULT_PURPOSE: Purpose = 'assertionMethod';

/** The most bytes of a message that the check takes. */
export const MAX_MESSAGE_BYTES = 16_384;

/** The shapes of the inputs. The tool schema and the check of the inputs use the same patterns. */
export const DID_INPUT = /^did:vector:[0-9a-f]{64}$/;
export const SIGNATURE_HEX = /^[0-9a-fA-F]{128}$/;
export const MESSAGE_HEX = /^(?:[0-9a-fA-F]{2})+$/;
export const KEY_INPUT = /^(?:did:vector:[0-9a-f]{64}#[0-9a-f]{56}|[0-9a-fA-F]{56}|[0-9a-fA-F]{64})$/;
/** The time that the gateway takes for `versionTime`: UTC, whole seconds. */
export const TIME_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** A version id as the gateway writes it: a whole number without leading zeros. */
const VERSION_ID = /^(?:0|[1-9][0-9]{0,15})$/;

/** The inputs of the tool, as a caller gives them. A caller that skips the schema can give any value, so every field is checked. */
export interface RawSignatureAtInput {
  did?: unknown; message?: unknown; message_hex?: unknown; signature_hex?: unknown; key?: unknown; purpose?: unknown; at?: unknown;
}

/** How the caller named the key. */
export interface KeyRef {
  form: 'verification_method' | 'key_hash' | 'public_key';
  /** blake2b-224 of the public key: 56 lowercase hex characters. */
  keyHash: string;
  /** The Ed25519 public key as 64 lowercase hex characters, when the caller gave it. */
  publicKey: string | null;
}

/** Inputs that passed every check. */
export interface SignatureAtRequest {
  did: string;
  message: Buffer;
  signature: Buffer;
  key: KeyRef;
  purpose: Purpose;
  /** `YYYY-MM-DDThh:mm:ssZ`, as the caller wrote it. */
  at: string;
  atMs: number;
}

export type ParsedInput = { ok: true; request: SignatureAtRequest } | { ok: false; refusal: string };

const refuse = (input: string, reason: string): ParsedInput => ({ ok: false, refusal: `${input}: ${reason}` });

/** POSIX milliseconds of `YYYY-MM-DDThh:mm:ssZ` when it is a real date and time, else null. */
export function parseUtcSeconds(value: string): number | null {
  if (!TIME_INPUT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== `${value.slice(0, 19)}.000Z` ? null : ms;
}

/** A key that the caller gave, in one of the three forms. `did` is the DID of the check: a verification method id must name it. */
function parseKey(value: unknown, did: string): { ok: true; key: KeyRef } | { ok: false; refusal: string } {
  const forms = 'a verification method id (did:vector:<64 hex>#<56 hex>), a key hash (56 hex) or an Ed25519 public key (64 hex)';
  if (typeof value !== 'string' || !KEY_INPUT.test(value)) return { ok: false, refusal: `key: expected ${forms}` };
  if (value.startsWith('did:vector:')) {
    const hash = value.slice(value.indexOf('#') + 1);
    if (value.slice(0, value.indexOf('#')) !== did) return { ok: false, refusal: 'key: the verification method id names another DID than did' };
    return { ok: true, key: { form: 'verification_method', keyHash: hash, publicKey: null } };
  }
  const hex = value.toLowerCase();
  if (hex.length === 56) return { ok: true, key: { form: 'key_hash', keyHash: hex, publicKey: null } };
  return { ok: true, key: { form: 'public_key', keyHash: keyHashOf(hex), publicKey: hex } };
}

/**
 * Checks the inputs of the tool. Gives the request, or the first refusal as one sentence that names the input. A time that is too recent or
 * in the future is not refused here: the check gives NOT CHECKED (`too_recent`) for it, and asks nobody.
 */
export function parseSignatureAtInput(raw: RawSignatureAtInput): ParsedInput {
  if (typeof raw.did !== 'string' || !DID_INPUT.test(raw.did)) {
    return refuse('did', 'expected the canonical DID did:vector:<64 lowercase hex>. A legacy DID or a bare identifier is not accepted');
  }
  const did = raw.did;

  const hasText = raw.message !== undefined;
  const hasHex = raw.message_hex !== undefined;
  if (hasText && hasHex) return refuse('message', 'give message or message_hex, not both');
  if (!hasText && !hasHex) return refuse('message', 'give the signed message as message (UTF-8 text) or as message_hex');
  const input = hasText ? 'message' : 'message_hex';
  const tooLong = `the message is over ${MAX_MESSAGE_BYTES} bytes`;
  let message: Buffer;
  if (hasText) {
    if (typeof raw.message !== 'string') return refuse(input, 'expected text');
    // A text has at least one byte for each of its characters, so a text of more characters is too long before any byte is written.
    if (raw.message.length > MAX_MESSAGE_BYTES) return refuse(input, tooLong);
    message = Buffer.from(raw.message, 'utf8');
    // A text with a lone surrogate has no UTF-8 form: Buffer writes U+FFFD in its place, and the signature would cover other bytes.
    if (message.toString('utf8') !== raw.message) return refuse(input, 'the text is not valid Unicode. Give the bytes as message_hex');
  } else {
    if (typeof raw.message_hex !== 'string') return refuse(input, 'expected hex characters');
    if (raw.message_hex.length > 2 * MAX_MESSAGE_BYTES) return refuse(input, tooLong);
    if (!MESSAGE_HEX.test(raw.message_hex)) return refuse(input, 'expected an even number of hex characters');
    message = Buffer.from(raw.message_hex, 'hex');
  }
  if (message.length === 0) return refuse(input, 'the message is empty');
  if (message.length > MAX_MESSAGE_BYTES) return refuse(input, tooLong);

  if (typeof raw.signature_hex !== 'string' || !SIGNATURE_HEX.test(raw.signature_hex)) return refuse('signature_hex', 'expected 128 hex characters: an Ed25519 signature of 64 bytes');
  const signature = Buffer.from(raw.signature_hex, 'hex');

  const key = parseKey(raw.key, did);
  if (!key.ok) return { ok: false, refusal: key.refusal };

  const purpose = raw.purpose === undefined ? DEFAULT_PURPOSE : PURPOSES.find((p) => p === raw.purpose);
  if (purpose === undefined) return refuse('purpose', `expected ${PURPOSES.join(' or ')}`);

  if (typeof raw.at !== 'string') return refuse('at', 'expected a time as YYYY-MM-DDThh:mm:ssZ (UTC, whole seconds)');
  const atMs = parseUtcSeconds(raw.at);
  if (atMs === null) return refuse('at', 'expected a real date and time as YYYY-MM-DDThh:mm:ssZ (UTC, whole seconds). The gateway cannot resolve a finer time');

  return { ok: true, request: { did, message, signature, key: key.key, purpose, at: raw.at, atMs } };
}

// ─── The text of an answer ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type MemberScan = 'ok' | 'duplicate' | 'too_deep' | 'invalid';

/**
 * Reads the text of a JSON answer one time, and finds an object that names a member twice. `JSON.parse` keeps the last of two members with one
 * name, so a parsed answer can say what a person does not read in the text. Names are compared after their escapes are read: `"a"` and
 * `"\u0061"` are one name. The text is JSON that has been parsed already, so the scan does not check the syntax of the values: it follows the
 * strings and the brackets, and it never throws. A closing bracket must close an open container of its kind, and nothing but white space
 * follows the top-level container. A text that nests deeper than MAX_JSON_DEPTH, or that the scan cannot follow, is not `ok`. One pass, no
 * recursion, and the memory is bounded by the depth and the text.
 */
export function scanMemberNames(json: string): MemberScan {
  /** One entry for each open object or array: the names of an object, null for an array. */
  const open: Array<Set<string> | null> = [];
  let expectName = false;
  let closed = false;
  for (let i = 0; i < json.length; i += 1) {
    const char = json.charCodeAt(i);
    if (closed && char !== 0x20 && char !== 0x0a && char !== 0x0d && char !== 0x09) return 'invalid';
    if (char === 0x22) {
      let end = i + 1;
      let escaped = false;
      for (; end < json.length; end += 1) {
        const inner = json.charCodeAt(end);
        if (inner === 0x5c) { escaped = true; end += 1; } else if (inner === 0x22) break;
      }
      if (end >= json.length) return 'invalid';
      if (expectName) {
        const names = open[open.length - 1];
        if (names === null || names === undefined) return 'invalid';
        let name: string;
        if (escaped) {
          try { name = JSON.parse(json.slice(i, end + 1)) as string; } catch { return 'invalid'; }
        } else {
          name = json.slice(i + 1, end);
        }
        if (names.has(name)) return 'duplicate';
        names.add(name);
        expectName = false;
      }
      i = end;
    } else if (char === 0x7b) {
      if (open.length >= MAX_JSON_DEPTH) return 'too_deep';
      open.push(new Set());
      expectName = true;
    } else if (char === 0x5b) {
      if (open.length >= MAX_JSON_DEPTH) return 'too_deep';
      open.push(null);
      expectName = false;
    } else if (char === 0x7d || char === 0x5d) {
      const top = open.pop();
      if (top === undefined || (char === 0x7d) !== (top !== null)) return 'invalid';
      closed = open.length === 0;
      expectName = false;
    } else if (char === 0x2c) {
      expectName = open.length > 0 && open[open.length - 1] !== null;
    }
  }
  return open.length === 0 ? 'ok' : 'invalid';
}

// ─── Keys in the document ──────────────────────────────────────────────────────────────────────────────────────────────────────

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_VALUE = new Map<string, bigint>([...BASE58].map((c, i) => [c, BigInt(i)]));
/** The longest base58btc text that the check decodes. A key is 34 or 35 bytes: 47 or 48 characters. */
const MAX_BASE58_CHARS = 64;

/** The bytes that a base58btc text writes, or null when the text is empty, longer than MAX_BASE58_CHARS, or has a character outside the alphabet. */
export function decodeBase58btc(value: string): Buffer | null {
  if (value.length === 0 || value.length > MAX_BASE58_CHARS) return null;
  let n = 0n;
  for (const char of value) {
    const digit = BASE58_VALUE.get(char);
    if (digit === undefined) return null;
    n = n * 58n + digit;
  }
  const zeros = value.length - value.replace(/^1+/, '').length;
  const body = n === 0n ? '' : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0');
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(body, 'hex')]);
}

export type KeyReading = { type: 'Ed25519'; key: Buffer } | { type: 'P-256' } | { type: 'unknown' };

/**
 * A `publicKeyMultibase` of the DID document: `z` and the base58btc text of a multicodec header and the key. The header 0xed 0x01 and 32
 * bytes is an Ed25519 key. The header 0x80 0x24 and 33 bytes is a compressed P-256 key. Anything else is unknown.
 */
export function readMultikey(multibase: string | null): KeyReading {
  if (multibase === null || multibase.length > MAX_BASE58_CHARS + 1 || !multibase.startsWith('z')) return { type: 'unknown' };
  const bytes = decodeBase58btc(multibase.slice(1));
  if (bytes === null) return { type: 'unknown' };
  if (bytes.length === 34 && bytes[0] === 0xed && bytes[1] === 0x01) return { type: 'Ed25519', key: bytes.subarray(2) };
  if (bytes.length === 35 && bytes[0] === 0x80 && bytes[1] === 0x24) return { type: 'P-256' };
  return { type: 'unknown' };
}

/** The verification relationships of a DID document that the answer lists keys for. */
const RELATIONSHIPS = ['authentication', 'assertionMethod', 'capabilityInvocation', 'capabilityDelegation'] as const;
/** The most keys that an answer shows. A record has at most 9. */
const MAX_LISTED_KEYS = 16;

/** A verification method of the document. `controller` and `type` are as the gateway wrote them: the check reads them for the listed key. */
interface Method { id: string; multibase: string | null; controller: unknown; type: unknown }

/** The verification methods of a document: each member of `verificationMethod` that is an object with a text `id`. Any other member is left out. */
function methodsOf(doc: Record<string, unknown>): Method[] {
  const list = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : [];
  return list.flatMap((m): Method[] => (isJsonObject(m) && typeof m.id === 'string'
    ? [{ id: m.id, multibase: typeof m.publicKeyMultibase === 'string' ? m.publicKeyMultibase : null, controller: m.controller, type: m.type }]
    : []));
}

/**
 * The ids that one relationship of the document names. A member that is a text counts: `#<hash>` is the id of this DID, and any other text
 * is an id as it stands. A member that is not a text (an embedded method) does not count: the gateway never writes one.
 */
function relatedIds(doc: Record<string, unknown>, relationship: string, did: string): Set<string> {
  const list = Array.isArray(doc[relationship]) ? (doc[relationship] as unknown[]) : [];
  return new Set(list.flatMap((entry): string[] => (typeof entry === 'string' ? [entry.startsWith('#') ? `${did}${entry}` : entry] : [])));
}

// ─── The answer ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Verdict = 'valid' | 'invalid' | 'not_checked';

/**
 * Why a check did not pass. A check that fails gives INVALID: `did_not_found`, `deactivated`, `version_not_started`, `ambiguous_second`,
 * `version_superseded`, `status_not_active`, `invalid_from`, `key_not_listed`, `purpose_missing`, `key_differs` and `signature_mismatch`. A check
 * that cannot decide gives NOT CHECKED: `too_recent`, `gateway_behind`, `tip_stale`, `tip_unreadable`, `gateway_error`, `answer_unreadable`,
 * `next_update_missing` and `key_type_unsupported`.
 */
export type Reason =
  | 'did_not_found' | 'deactivated' | 'version_not_started' | 'ambiguous_second' | 'version_superseded' | 'status_not_active' | 'invalid_from'
  | 'key_not_listed' | 'purpose_missing' | 'key_differs' | 'signature_mismatch'
  | 'too_recent' | 'gateway_behind' | 'tip_stale' | 'tip_unreadable' | 'gateway_error' | 'answer_unreadable' | 'next_update_missing' | 'key_type_unsupported';

export type CheckId =
  | 'time_age' | 'version' | 'document' | 'gateway_current' | 'version_window' | 'status' | 'invalid_from' | 'key_listed' | 'key_matches' | 'signature';
/** `unknown`: the check cannot decide. `not_applicable`: an earlier check did not pass, so this one did not run. */
export type CheckResult = 'pass' | 'fail' | 'unknown' | 'not_applicable';
export interface CheckLine { id: CheckId; label: string; result: CheckResult; reason: Reason | null; detail: string }

const CHECK_ORDER: CheckId[] = [
  'time_age', 'version', 'document', 'gateway_current', 'version_window', 'status', 'invalid_from', 'key_listed', 'key_matches', 'signature',
];
const CHECK_LABEL: Record<CheckId, string> = {
  time_age: 'The time is at least 10 minutes before now and before the tip block of the node',
  version: 'The DID has a version at the time',
  document: 'The version has a DID document: the DID is not deactivated or invalidated at the time',
  gateway_current: 'The tip of the node is at most 10 minutes old, and the ledger tip of the gateway is at most 30 blocks behind it',
  version_window: 'The time lies inside the version: the version started at or before the time, and the next update, when there is one, is after the time',
  status: 'The effective status of the version is active',
  invalid_from: 'No invalid-from time lies at or before the time',
  key_listed: 'The version lists the key for the purpose',
  key_matches: 'The key in the document is the key that was given',
  signature: 'The Ed25519 signature verifies over the message with that key',
};

export interface VersionFacts { versionId: string | null; nextVersionId: string | null; created: string | null; updated: string | null; nextUpdate: string | null }
/** The status of a version, from `vectorStatus`. Every text is cleaned. */
export interface StatusFacts { status: string | null; effective: string | null; effectiveReason: string | null; reason: string | null; at: string | null; invalidFrom: string | null }
/** The state of the DID now. `details` is the record status from a second read of the gateway. It is for the reader and never changes the verdict. */
export interface NowFacts {
  effective: string | null;
  effectiveReason: string | null;
  deactivated: boolean;
  invalidFrom: string | null;
  details: StatusFacts | null;
  detailsRead: 'not_needed' | 'second_read' | 'not_available';
}
export interface ListedKey {
  /** `#<key hash>` */
  id: string;
  type: 'Ed25519' | 'P-256' | 'unknown';
  purposes: string[];
  /** The key that the caller gave. */
  given: boolean;
}

export interface SignatureAtResult {
  verdict: Verdict;
  /** The first check that failed, else the first that could not decide; null for VALID. */
  reason: Reason | null;
  /** One sentence: why the verdict is what it is. */
  summary: string;
  did: string;
  at: string;
  purpose: Purpose;
  key: KeyRef;
  /** The public key of the listed key, when the version lists it and the document gives an Ed25519 key. */
  listedPublicKey: string | null;
  message: { bytes: number; sha256: string };
  /** The check asked the gateway. It does not for a time that is too recent. */
  asked: boolean;
  httpStatus: number | null;
  /** The answer had a DID document. */
  hasDocument: boolean;
  /** The ledger tips, as block heights: the gateway (from its answer) and the node (from the chain provider). Null when the check has none. */
  tips: { gateway: number | null; node: number | null };
  checks: CheckLine[];
  version: VersionFacts | null;
  statusAtTime: StatusFacts | null;
  now: NowFacts;
  listedKeys: ListedKey[];
  /** Keys that the version lists beyond the ones in `listedKeys`. */
  moreKeys: number;
}

/** The sentence that every answer carries. */
export const TIME_CLAIM_NOTE = 'The time is the claim of the caller. The tool cannot prove when the signature was made. An auditor needs a time anchor, for example a transaction.';

/** A text of the gateway, cleaned for one line and cut to `max` characters; null for a value that is not a text, and for a text with nothing left after the cleaning. */
const clean = (value: unknown, max = 80): string | null => {
  const cleaned = typeof value === 'string' ? cell(value.slice(0, max * 4), max) : '';
  return cleaned === '' ? null : cleaned;
};

function versionFacts(meta: Record<string, unknown>): VersionFacts {
  return { versionId: clean(meta.versionId, 32), nextVersionId: clean(meta.nextVersionId, 32), created: clean(meta.created, 32), updated: clean(meta.updated, 32), nextUpdate: clean(meta.nextUpdate, 32) };
}

function statusFacts(value: unknown): StatusFacts | null {
  if (!isJsonObject(value)) return null;
  return {
    status: clean(value.status, 32), effective: clean(value.effective, 32), effectiveReason: clean(value.effectiveReason, 64),
    reason: clean(value.reason, 64), at: clean(value.at, 32), invalidFrom: clean(value.invalidFrom, 32),
  };
}

const NOT_FOUND = 'https://www.w3.org/ns/did#NOT_FOUND';
const ERROR_TYPE_PREFIX = 'https://www.w3.org/ns/did#';

/** The error of a resolution result as `NAME: title`, cleaned. */
function errorText(error: Record<string, unknown>): string {
  const type = typeof error.type === 'string' ? error.type.replace(ERROR_TYPE_PREFIX, '') : 'unknown error';
  const text = typeof error.title === 'string' && error.title !== '' ? `${type}: ${error.title}` : type;
  return cell(text, 160);
}

const line = (id: CheckId, result: CheckResult, reason: Reason | null, detail: string): CheckLine => ({ id, label: CHECK_LABEL[id], result, reason, detail });

/** The ordered checks: the lines that ran, and the others as `not_applicable` with `because`. */
function ordered(ran: CheckLine[], because: string): CheckLine[] {
  return CHECK_ORDER.map((id) => ran.find((l) => l.id === id) ?? line(id, 'not_applicable', null, `Not checked: ${because}.`));
}

/** A time of the gateway (`YYYY-MM-DDThh:mm:ssZ`) as POSIX milliseconds, or null when the value is not a text of that form. */
const timeOf = (value: unknown): number | null => (typeof value === 'string' ? parseUtcSeconds(value) : null);

/**
 * The validity of the version against the time of the signature (DID Core, "Revocation in Trustless Systems"). The version started at `updated`
 * (at `created` for version 0, which has no `updated`): that time must be at or before the time of the signature. The version ended at
 * `nextUpdate`, the time of the next version: that time, when there is one, must be after the time of the signature. A signature in the second
 * of an update could come before the update or after it, so it does not pass.
 *
 * The two times hold no invalid-from time (the check of `invalid_from` does that), and two updates in one block share one time, so this check
 * does not compare the two times with each other.
 *
 * A gateway that names a later version (`nextVersionId`) and gives no `nextUpdate` does not give the time of the later version. The check cannot
 * rule out that the later version was made in the second of the signature, so it does not decide. Without `nextVersionId` the gateway shows no
 * later version: a later version with fewer than 30 confirmations is not visible.
 */
function versionWindow(req: SignatureAtRequest, meta: Record<string, unknown>, version: VersionFacts): CheckLine {
  const hasUpdated = (meta.updated ?? null) !== null;
  const start = timeOf(hasUpdated ? meta.updated : meta.versionId === '0' ? meta.created : null);
  if (start === null) {
    return line('version_window', 'unknown', 'answer_unreadable', 'The gateway answer gives no time at which the version started (updated, or created for version 0) that the tool can read, so the tool cannot decide.');
  }
  const startShown = hasUpdated ? version.updated : version.created;
  if (start > req.atMs) return line('version_window', 'fail', 'version_not_started', `The version started at ${startShown}, after the time of the signature.`);

  if ((meta.nextUpdate ?? null) === null) {
    if ((meta.nextVersionId ?? null) === null) {
      return line('version_window', 'pass', null, `The version started at ${startShown}, at or before the time. The gateway shows no later version. A later version with fewer than 30 confirmations is not visible.`);
    }
    const named = version.nextVersionId === null ? '' : ` (version ${version.nextVersionId})`;
    return line('version_window', 'unknown', 'next_update_missing', `The gateway did not give nextUpdate, so the tool cannot apply the nextUpdate check. The DID has a later version${named}, and the gateway did not give its time. The tool cannot rule out that the later version was made in the same second as the signature, so it cannot decide.`);
  }
  const next = timeOf(meta.nextUpdate);
  if (next === null) return line('version_window', 'unknown', 'answer_unreadable', 'The gateway answer gives a next update that the tool cannot read, so the tool cannot decide.');
  if (next > req.atMs) return line('version_window', 'pass', null, `The version started at ${startShown}, at or before the time, and the next update ${version.nextUpdate} is after the time.`);
  if (next === req.atMs) {
    return line('version_window', 'fail', 'ambiguous_second', `The DID changed at ${version.nextUpdate}, in the same second as the signature (the next update equals the time). The tool cannot tell whether the signature came before or after the change, so the signature does not pass.`);
  }
  return line('version_window', 'fail', 'version_superseded', `A later version of the DID started at ${version.nextUpdate}, before the time of the signature, so this version was not the one in force.`);
}

/** The tip of the node as the server reads it: the block height, and the time of the block in POSIX milliseconds. */
export interface NodeTipRead { height: number; timeMs: number }

/** What the check knows of the tip of the node: its block height and block time, or why it has none. */
export type NodeTip = NodeTipRead | { height: null; why: string };

/** What the decision needs besides the answer: the clock, and the tip of the node. */
export interface JudgeContext { nowMs: number; node: NodeTip }

/**
 * The ledger tip of the gateway as a block height, from the answer: `vectorLedger.blockHeight` and `vectorLedger.confirmations` add up to
 * the tip of the gateway (the gateway counts the confirmations of a transaction from its tip). Null when the answer does not give two whole
 * numbers that are not negative.
 */
function gatewayTipOf(meta: Record<string, unknown>): number | null {
  const ledger = isJsonObject(meta.vectorLedger) ? meta.vectorLedger : null;
  if (ledger === null) return null;
  const { blockHeight, confirmations } = ledger;
  if (typeof blockHeight !== 'number' || typeof confirmations !== 'number') return null;
  const tip = blockHeight + confirmations;
  return Number.isSafeInteger(blockHeight) && Number.isSafeInteger(confirmations) && blockHeight >= 0 && confirmations >= 0 && Number.isSafeInteger(tip) ? tip : null;
}

/**
 * The gateway reads its tip from Koios. When Koios is behind the chain, the gateway answers a time after its tip with the state at its tip, and
 * gives no error: a change between its tip and the time is not in the answer. So the check compares the tip of the gateway with the tip of the
 * node. The node is the reference, so its tip must be fresh: a node that has stopped would let a gateway that is as stale pass. A gateway that
 * is more than MAX_GATEWAY_LAG_BLOCKS behind the node, a tip of the node that is older than MAX_NODE_TIP_AGE_MS, and a tip that the check
 * cannot read, do not decide.
 */
function gatewayCurrent(gatewayTip: number | null, node: NodeTip, nowMs: number): CheckLine {
  if (gatewayTip === null) {
    return line('gateway_current', 'unknown', 'tip_unreadable', 'The gateway answer does not give the ledger tip of the gateway (blockHeight and confirmations of vectorLedger), so the tool cannot tell whether the gateway is current. The tool cannot decide.');
  }
  if (node.height === null) {
    return line('gateway_current', 'unknown', 'tip_unreadable', `The tool could not read the tip of the node (${node.why}), so it cannot tell whether the gateway is current. The tool cannot decide.`);
  }
  const age = nowMs - node.timeMs;
  if (age > MAX_NODE_TIP_AGE_MS) {
    return line('gateway_current', 'unknown', 'tip_stale', `The tip of the node (block ${node.height}) is ${Math.ceil(age / 1000)} seconds old. The limit is ${MAX_NODE_TIP_AGE_MS / 1000} seconds. A node that is behind is no reference for the tip of the chain, so the tool cannot tell whether the gateway is current. The tool cannot decide.`);
  }
  const behind = node.height - gatewayTip;
  if (behind > MAX_GATEWAY_LAG_BLOCKS) {
    return line('gateway_current', 'unknown', 'gateway_behind', `The gateway is ${behind} blocks behind the node: the tip of the gateway is block ${gatewayTip}, and the tip of the node is block ${node.height}. A change after the tip of the gateway is not in its answer, so the tool cannot decide.`);
  }
  return line('gateway_current', 'pass', null, `The tip of the node (block ${node.height}) is at most ${MAX_NODE_TIP_AGE_MS / 60_000} minutes old, and the ledger tip of the gateway (block ${gatewayTip}) is at most ${MAX_GATEWAY_LAG_BLOCKS} blocks behind it.`);
}

interface Judgement {
  result: SignatureAtResult;
  /** The DID is deactivated now and the answer has a document for the time: a second read can show why. */
  wantsCurrentRead: boolean;
}

/**
 * Decides from one answer of the gateway for the time of the request. Nothing here reads the network: the clock and the tip of the node are
 * in `context`. A time that is too recent gives NOT CHECKED before the answer is read, so `answer` can be null then. `answer` can hold
 * anything that a gateway sends below the three members of a resolution result (the client checks those), so every member is read with a check.
 */
export function judge(req: SignatureAtRequest, answer: GatewayAnswer | null, context: JudgeContext): Judgement {
  const resolution = isJsonObject(answer?.result) ? answer.result : null;
  const status = typeof answer?.status === 'number' ? answer.status : null;
  const resolutionMeta = resolution !== null && isJsonObject(resolution.didResolutionMetadata) ? resolution.didResolutionMetadata : {};
  const meta = resolution !== null && isJsonObject(resolution.didDocumentMetadata) ? resolution.didDocumentMetadata : {};
  const doc = resolution !== null && isJsonObject(resolution.didDocument) ? resolution.didDocument : null;

  const version = versionFacts(meta);
  const atTime = statusFacts(meta.vectorStatus);
  // A decision reads the text as the gateway wrote it. The cleaned text is for the reader: it drops invisible characters, so a text that
  // looks like `active` after the cleaning can be another text.
  const recordStatus = isJsonObject(meta.vectorStatus) ? meta.vectorStatus : {};
  const effectiveRaw = recordStatus.effective;
  const effectiveReasonRaw = recordStatus.effectiveReason;
  /** The effective status for the reader, with a note when the cleaning took characters out of it. */
  const effectiveShown = atTime === null || atTime.effective === null
    ? null
    : `${atTime.effective}${atTime.effective === effectiveRaw ? '' : ' (the text has characters that are not shown)'}${atTime.effectiveReason ? ` (${atTime.effectiveReason})` : ''}`;
  const cur = isJsonObject(meta.vectorCurrent) ? meta.vectorCurrent : null;
  const deactivatedNow = meta.deactivated === true;
  const now: NowFacts = {
    effective: clean(cur?.effective, 32), effectiveReason: clean(cur?.effectiveReason, 64), deactivated: deactivatedNow,
    invalidFrom: atTime?.invalidFrom ?? null, details: null, detailsRead: 'not_needed',
  };
  const message = { bytes: req.message.length, sha256: createHash('sha256').update(req.message).digest('hex') };
  const gatewayTip = gatewayTipOf(meta);
  const timeLine = line('time_age', 'pass', null, context.node.height === null
    ? 'The time is at least 10 minutes before now.'
    : 'The time is at least 10 minutes before now, and at least 10 minutes before the tip block of the node.');

  const finish = (ran: CheckLine[], because: string, extra: { listedKeys?: ListedKey[]; moreKeys?: number; listedPublicKey?: string | null; wantsCurrentRead?: boolean } = {}): Judgement => {
    const checks = ordered(ran.some((l) => l.id === 'time_age') ? ran : [timeLine, ...ran], because);
    const failed = checks.find((c) => c.result === 'fail');
    const unknown = checks.find((c) => c.result === 'unknown');
    const primary = failed ?? unknown;
    const verdict: Verdict = failed ? 'invalid' : unknown ? 'not_checked' : 'valid';
    const keyId = `#${req.key.keyHash}`;
    return {
      result: {
        verdict, reason: primary?.reason ?? null,
        summary: primary ? primary.detail : `The signature verifies with the key ${keyId}. Version ${version.versionId ?? '(not given)'} of the DID listed the key for ${req.purpose}, and the DID was active at ${req.at}.`,
        did: req.did, at: req.at, purpose: req.purpose, key: req.key, listedPublicKey: extra.listedPublicKey ?? null, message,
        asked: answer !== null, httpStatus: status, hasDocument: doc !== null, tips: { gateway: gatewayTip, node: context.node.height },
        checks, version: resolution === null || status === null ? null : version, statusAtTime: atTime, now,
        listedKeys: extra.listedKeys ?? [], moreKeys: extra.moreKeys ?? 0,
      },
      wantsCurrentRead: extra.wantsCurrentRead ?? false,
    };
  };

  // A time that is too recent gives no verdict: a change after the time can still have fewer than 30 confirmations, and the gateway does not show
  // it. The age is measured on the clock of the server, and on the chain when the tip of the node is known. The tip block of the node can be old
  // (the node lags, the chain stopped for a short time, or the clock of the server is ahead), and a gateway that is 30 blocks behind such a tip
  // can have its own tip before the time. The clock of the server decides first: then nobody is asked.
  const recentOnClock = req.atMs > context.nowMs - MIN_AGE_MS;
  if (recentOnClock || (context.node.height !== null && req.atMs > context.node.timeMs - MIN_AGE_MS)) {
    const detail = req.atMs > context.nowMs
      ? 'The time is in the future. A signature cannot be made in the future, so the tool cannot decide.'
      : recentOnClock
        ? 'The time is less than 10 minutes before now. A change after the time can still have fewer than 30 confirmations, and the gateway does not show it, so the tool cannot decide.'
        : 'The time is less than 10 minutes before the tip block of the node, or after it. A change after the time can still have fewer than 30 confirmations, and the gateway does not show it, so the tool cannot decide.';
    return finish([line('time_age', 'unknown', 'too_recent', detail)], 'the time is too recent');
  }

  // An answer that is not a resolution result at all (a client that was given a wrong object): nothing to read.
  if (resolution === null || status === null) {
    return finish([line('version', 'unknown', 'answer_unreadable', 'The gateway answer is not a DID resolution result, so the tool cannot decide.')], 'the gateway answer cannot be read');
  }

  // The text of the body must be JSON that the tool can trust: no object names a member twice (the parse keeps the last one), and it does not nest
  // deeper than the limit. A body that the tool has no text of cannot be checked.
  const scan = typeof answer?.body === 'string' ? scanMemberNames(answer.body) : 'no_body';
  if (scan !== 'ok') {
    const why = scan === 'duplicate' ? 'names a member twice in one object'
      : scan === 'too_deep' ? `nests deeper than ${MAX_JSON_DEPTH} levels`
        : scan === 'invalid' ? 'is not JSON that the tool can scan'
          : 'has no body text that the tool can check';
    return finish([line('version', 'unknown', 'answer_unreadable', `The gateway answer ${why}, so the tool cannot trust it. The tool cannot decide.`)], 'the gateway answer cannot be trusted');
  }

  // An error result. NOT_FOUND with the HTTP status 404 says that the DID has no confirmed version at the time. Any other error says nothing about
  // the signature. The gateway writes the error as an object. A value of another kind is an error all the same, and gives no verdict.
  const errorMember = resolutionMeta.error ?? null;
  if (errorMember !== null) {
    const gatewayText = isJsonObject(errorMember) ? errorText(errorMember) : 'unknown error';
    if (isJsonObject(errorMember) && errorMember.type === NOT_FOUND && status === 404) {
      return finish([line('version', 'fail', 'did_not_found', `The DID did not exist at that time: the gateway has no confirmed version of it then (${gatewayText}).`)], 'the DID has no version at that time');
    }
    return finish([line('version', 'unknown', 'gateway_error', `The gateway answered HTTP ${status} with an error (${gatewayText}), so the tool cannot decide.`)], 'the gateway answered with an error');
  }

  // The version id is a whole number as the gateway writes it. Any other value is a type that the tool does not read.
  const versionLine = typeof meta.versionId === 'string' && VERSION_ID.test(meta.versionId)
    ? line('version', 'pass', null, `The gateway has version ${version.versionId} of the DID at that time.`)
    : line('version', 'unknown', 'answer_unreadable', 'The gateway answer gives no version id that is a whole number, so the tool cannot decide.');

  // No document: the DID is deactivated or invalidated at the time. The status and the invalid-from time of the answer say which.
  if (doc === null) {
    const ended = effectiveRaw === 'revoked' || effectiveRaw === 'retired';
    if (status !== 410 && !deactivatedNow && !ended) {
      return finish([versionLine, line('document', 'unknown', 'answer_unreadable', 'The gateway answer has no DID document and does not say why, so the tool cannot decide.')], 'the gateway answer has no DID document');
    }
    const invalidated = effectiveReasonRaw === 'invalidated';
    const why = invalidated
      ? `An invalid-from time${atTime?.invalidFrom ? ` (${atTime.invalidFrom})` : ''} at or before the time ended the DID, so it has no DID document then.`
      : `The DID was ${effectiveRaw === 'retired' ? 'retired' : 'deactivated'} at that time, so it has no DID document then.`;
    const statusLine = atTime?.effective && effectiveRaw !== 'active'
      ? line('status', 'fail', 'deactivated', `The effective status of the version is ${effectiveShown}, not active.`)
      : null;
    return finish([versionLine, line('document', 'fail', 'deactivated', why), ...(statusLine ? [statusLine] : [])], 'the DID has no DID document at that time');
  }

  // A document. Only the HTTP statuses 200 and 410 carry one (410: the DID is deactivated now; the document is the one for the time).
  if (status !== 200 && status !== 410) {
    return finish([line('version', 'unknown', 'answer_unreadable', `The gateway answered HTTP ${status} with a DID document, so the tool cannot decide.`)], 'the gateway answer is not consistent');
  }
  if (doc.id !== req.did) {
    return finish([line('version', 'unknown', 'answer_unreadable', 'The DID document names another DID than the one that was asked for, so the tool cannot decide.')], 'the gateway answer is not consistent');
  }
  const documentLine = line('document', 'pass', null, `Version ${version.versionId ?? '(not given)'} has a DID document: the DID was not deactivated at that time.`);
  const currentLine = gatewayCurrent(gatewayTip, context.node, context.nowMs);
  const windowLine = versionWindow(req, meta, version);

  const wantsCurrentRead = deactivatedNow;
  if (atTime === null || atTime.effective === null) {
    return finish([versionLine, documentLine, currentLine, windowLine, line('status', 'unknown', 'answer_unreadable', 'The gateway answer does not give the effective status of the version, so the tool cannot decide.')], 'the effective status is not known', { wantsCurrentRead });
  }
  const ran: CheckLine[] = [versionLine, documentLine, currentLine, windowLine];

  // The effective status of the version must be active, and the record status must agree with it: an active DID has a record that is active, or a
  // record that is suspended with holds that have ended, and it has no reason for a status that is not active.
  if (effectiveRaw === 'active') {
    const agrees = (recordStatus.status === 'active' || recordStatus.status === 'suspended') && (effectiveReasonRaw ?? null) === null;
    ran.push(agrees
      ? line('status', 'pass', null, 'The effective status of the version is active.')
      : line('status', 'unknown', 'answer_unreadable', 'The status and the effective status of the version do not agree (a record that is revoked or retired, or a reason for a status that is active), so the tool cannot decide.'));
  } else {
    ran.push(line('status', 'fail', 'status_not_active', `The effective status of the version is ${effectiveShown}, not active.`));
  }

  // An invalid-from time at or before the time ends every signature from then on. The resolver applies it already (it gives no document then);
  // this check applies it again. The time of the answer has whole seconds, rounded down: a time that equals it is refused, as the safe side.
  const invalidFromRaw = recordStatus.invalidFrom;
  if (invalidFromRaw === undefined || invalidFromRaw === null) {
    ran.push(line('invalid_from', 'pass', null, 'The DID has no invalid-from time.'));
  } else {
    const invalidFromMs = typeof invalidFromRaw === 'string' ? parseUtcSeconds(invalidFromRaw) : null;
    if (invalidFromMs === null) {
      ran.push(line('invalid_from', 'unknown', 'answer_unreadable', 'The gateway answer gives an invalid-from time that the tool cannot read, so the tool cannot decide.'));
    } else if (invalidFromMs <= req.atMs) {
      ran.push(line('invalid_from', 'fail', 'invalid_from', `The invalid-from time ${atTime.invalidFrom} is at or before the time of the signature. A signature at or after it is invalid.`));
    } else {
      ran.push(line('invalid_from', 'pass', null, `The invalid-from time ${atTime.invalidFrom} is after the time of the signature. A signature before it stays valid.`));
    }
  }

  // The keys that the version lists, for the answer and for the checks.
  const methods = methodsOf(doc);
  const wantedId = `${req.did}#${req.key.keyHash}`;
  const related = new Map(RELATIONSHIPS.map((name) => [name, relatedIds(doc, name, req.did)] as const));
  const listedKeys: ListedKey[] = methods.slice(0, MAX_LISTED_KEYS).map((m) => ({
    id: clean(m.id.startsWith(`${req.did}#`) ? m.id.slice(req.did.length) : m.id, 80) ?? '',
    type: readMultikey(m.multibase).type,
    purposes: RELATIONSHIPS.filter((name) => related.get(name)!.has(m.id)),
    given: m.id === wantedId,
  }));
  const moreKeys = Math.max(0, methods.length - MAX_LISTED_KEYS);
  const extra = { listedKeys, moreKeys, wantsCurrentRead };

  // The version must list the key, and for the purpose.
  const found = methods.filter((m) => m.id === wantedId);
  if (found.length === 0) {
    ran.push(line('key_listed', 'fail', 'key_not_listed', `The version lists no key ${req.key.keyHash}.`));
    return finish(ran, 'the version does not list the key', extra);
  }
  if (found.length > 1) {
    ran.push(line('key_listed', 'unknown', 'answer_unreadable', `The version lists the key ${req.key.keyHash} more than once, so the tool cannot decide.`));
    return finish(ran, 'the gateway answer lists the key twice', extra);
  }
  const method = found[0];
  if (!related.get(req.purpose)!.has(method.id)) {
    const listedFor = RELATIONSHIPS.filter((name) => related.get(name)!.has(method.id));
    ran.push(line('key_listed', 'fail', 'purpose_missing', `The version lists the key, but not for ${req.purpose}. It lists the key for: ${listedFor.length ? listedFor.join(', ') : 'no purpose'}.`));
    return finish(ran, 'the key is not listed for the purpose', extra);
  }
  // The listed method must be a method of this DID that the tool reads: a Multikey method with the DID as its controller (W3C Controlled
  // Identifiers 1.0, Section 3.3, refuses a method that is not).
  if (method.type !== 'Multikey' || method.controller !== req.did) {
    ran.push(line('key_listed', 'unknown', 'answer_unreadable', 'The method that the version lists for the key is not a Multikey method of this DID (its type is not Multikey, or its controller is missing or is not the DID), so the tool cannot decide.'));
    return finish(ran, 'the listed method is not a method that the tool reads', extra);
  }
  ran.push(line('key_listed', 'pass', null, `The version lists the key #${req.key.keyHash} for ${req.purpose}.`));

  // The listed key must be an Ed25519 key. When the caller gave the public key, the listed key must be that key: a document that lists
  // another key under the id of the key of the caller does not list the key of the caller. The listed key must also hash to the id that
  // lists it: when it does not, the document is not consistent, and the tool cannot decide.
  const reading = readMultikey(method.multibase);
  if (reading.type === 'P-256') {
    ran.push(line('key_matches', 'unknown', 'key_type_unsupported', 'The listed key is a P-256 key. The tool checks Ed25519 signatures only, so it cannot decide.'));
    return finish(ran, 'the listed key is not an Ed25519 key', extra);
  }
  if (reading.type === 'unknown') {
    ran.push(line('key_matches', 'unknown', 'answer_unreadable', 'The document gives a public key that the tool cannot read, so the tool cannot decide.'));
    return finish(ran, 'the listed key cannot be read', extra);
  }
  const listedHex = reading.key.toString('hex');
  if (req.key.publicKey !== null && req.key.publicKey !== listedHex) {
    ran.push(line('key_matches', 'fail', 'key_differs', 'The version lists another public key under the id of the key that you gave. It does not list the public key that you gave.'));
    return finish(ran, 'the listed key is not the given key', { ...extra, listedPublicKey: listedHex });
  }
  if (keyHashOf(listedHex) !== req.key.keyHash) {
    ran.push(line('key_matches', 'unknown', 'answer_unreadable', 'The public key in the document does not match the key hash in its id, so the tool cannot decide.'));
    return finish(ran, 'the gateway answer is not consistent', extra);
  }
  ran.push(line('key_matches', 'pass', null, req.key.publicKey === null ? 'The public key in the document hashes to the key hash that you gave.' : 'The public key in the document is the public key that you gave.'));

  // The signature, by the rules of the ledger (small-order keys and signatures are refused). A throw is no pass.
  let verifies = false;
  try {
    verifies = signatureVerifies(reading.key, req.signature, req.message);
  } catch {
    verifies = false;
  }
  ran.push(verifies
    ? line('signature', 'pass', null, 'The Ed25519 signature verifies over the message with the listed key.')
    : line('signature', 'fail', 'signature_mismatch', 'The Ed25519 signature does not verify over the message with the listed key.'));
  return finish(ran, 'an earlier check did not pass', { ...extra, listedPublicKey: listedHex });
}

// ─── The check ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The gateway, the node and the clock of the check. The server's own unless a test hands in its own. */
export interface SignatureAtAccess {
  resolve?: (did: string, options: ResolutionOptions) => Promise<GatewayAnswer>;
  /** The tip of the node (the chain provider of the server): the block height, and the time of the block. Without it, the check has no tip of the node. */
  nodeTip?: () => Promise<NodeTipRead>;
  /** POSIX milliseconds. */
  now?: () => number;
}

/**
 * Reads the tip of the node. It never throws, and it gives up after NODE_READ_MS: a node that does not answer gives no tip. A tip that is not a
 * whole block height and a time is no tip.
 */
async function readNodeTip(access: SignatureAtAccess): Promise<NodeTip> {
  if (access.nodeTip === undefined) return { height: null, why: 'the server has no chain provider for it' };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), NODE_READ_MS); });
    const tip: unknown = await Promise.race([access.nodeTip(), timeout]);
    const { height, timeMs } = isJsonObject(tip) ? tip : { height: undefined, timeMs: undefined };
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) return { height: null, why: 'the node gave a block height that is not a whole number' };
    if (typeof timeMs !== 'number' || !Number.isSafeInteger(timeMs) || timeMs <= 0) return { height: null, why: 'the node gave a tip time that is not a time' };
    return { height, timeMs };
  } catch {
    return { height: null, why: 'the read of the node failed or took too long' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the gateway for the DID at the time, and decides (`judge`). A time that is too recent on the clock of the server gives NOT CHECKED at
 * once: nobody is asked. A time that is too recent on the chain (less than 10 minutes before the tip block of the node) is found after the two
 * reads, in `judge`. The tip of the node is read at the same time as the gateway, and it is read only for the checks of the tip: the age of the
 * time on the chain, its own age, and the comparison with the tip of the gateway. When the DID is deactivated now and has a document at the
 * time, the check reads the gateway a second time without a time, to show the revocation: its reason, its time and its invalid-from time. That
 * read is for the reader. It never changes the verdict, and when it fails the answer says so.
 *
 * Throws what the client of the gateway throws (the gateway cannot be reached, or its answer is too large or is not a resolution result):
 * then there is no answer to decide from, and no verdict.
 */
export async function verifySignatureAt(req: SignatureAtRequest, access: SignatureAtAccess = {}): Promise<SignatureAtResult> {
  const resolve = access.resolve ?? resolveDid;
  const nowMs = (access.now ?? Date.now)();
  if (req.atMs > nowMs - MIN_AGE_MS) return judge(req, null, { nowMs, node: { height: null, why: 'not read' } }).result;
  const nodeRead = readNodeTip(access);
  const { result, wantsCurrentRead } = judge(req, await resolve(req.did, { versionTime: req.at }), { nowMs, node: await nodeRead });
  if (!wantsCurrentRead) return result;
  try {
    const current = await resolve(req.did, {});
    const meta = isJsonObject(current?.result?.didDocumentMetadata) ? current.result.didDocumentMetadata : {};
    const details = statusFacts(meta.vectorStatus);
    return { ...result, now: { ...result.now, details, detailsRead: details === null ? 'not_available' : 'second_read' } };
  } catch {
    return { ...result, now: { ...result.now, detailsRead: 'not_available' } };
  }
}
