// packages/builder/src/vector/identity-rules.ts
// The rules of the identity registry that the builders check before they build, so that a refusal names the rule instead of ending
// in a script failure: the constants and the functions of the Aiken library vector_identity (Part 2 Section 3.10), the definitions
// of Part 2 Section 3.2, the valid datum of Section 3.3 and the reason codes of Appendix A. Pure functions over the decoded record
// (identity-codec.ts). The contract decides; these checks only explain.
import { blake2b } from '@noble/hashes/blake2b';
import { sameSigner, textOf } from './identity-codec.js';
import type { Hold, IdentityDatum, Key, Party, Role, Signer, Status } from './identity-codec.js';

// ─── Constants (vector_identity, Part 1 Section 5, Part 2 Appendix A) ──────────────────────────────────────────────────────────

export const PURPOSE = { authentication: 1, assertion: 2, transaction: 8, delegation: 16 } as const;
export type PurposeName = keyof typeof PURPOSE;
export const PURPOSE_NAMES = Object.keys(PURPOSE) as PurposeName[];
export const RIGHT = { suspend: 1, revoke: 2, recover: 4 } as const;
export type RightName = keyof typeof RIGHT;
export const RIGHT_NAMES = Object.keys(RIGHT) as RightName[];
/** The highest rights of each role (Part 1 Section 5). */
export const ROLE_MAX_RIGHTS: Readonly<Record<Role, number>> = { Accountable: 3, Responsible: 1, Provider: 1, Distributor: 0, Guardian: 4 };

/** The longest validity range of an identity, attestation, delegation, vault or escrow transaction: one hour. */
export const MAX_RANGE_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const DAYS_7_MS = 7 * DAY_MS;
export const DAYS_30_MS = 30 * DAY_MS;
export const DAYS_90_MS = 90 * DAY_MS;
export const DAYS_366_MS = 366 * DAY_MS;
export const MAX_DEPTH = 4;
export const MAX_KEYS = 8;
export const MAX_PARTIES = 8;
export const MAX_HOLDS = 10;
export const MAX_CAPABILITIES = 16;
/** The least AP3X (base units) of a live record output: 10 AP3X. */
export const MIN_RECORD_LOVELACE = 10_000_000n;
/** The least AP3X of an attestation output: 5 AP3X. */
export const MIN_ATTESTATION_LOVELACE = 5_000_000n;

/** Reason codes (Part 2 Appendix A) that a new hold may carry. */
export const SUSPEND_REASONS = [0, 6, 9, 64, 65, 67, 68] as const;
/** Reason codes that a revocation may carry. */
export const REVOKE_REASONS = [0, 1, 3, 4, 5, 9, 64, 65] as const;
export const REASON_KEY_COMPROMISE = 1;
/** Only Module-1 may use this code (its verdicts). */
export const REASON_DISPUTE_VERDICT = 64;
/** The names of the reason codes (Part 2 Appendix A). */
export const REASON_NAMES: Readonly<Record<number, string>> = {
  0: 'unspecified', 1: 'keyCompromise', 3: 'affiliationChanged', 4: 'superseded', 5: 'cessationOfOperation', 6: 'hold',
  9: 'privilegeWithdrawn', 64: 'disputeVerdict', 65: 'legalOrder', 67: 'providerWithdrawn', 68: 'securityInvestigation',
};

// ─── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** blake2b-224 of a public key (32-byte Ed25519 or 33-byte compressed P-256), lowercase hex: the key hash of Part 1 Section 2. */
export function keyHashOf(publicKeyHex: string): string {
  return Buffer.from(blake2b(Buffer.from(publicKeyHex, 'hex'), { dkLen: 28 })).toString('hex');
}

/** `key_has_purpose`: the transaction and delegation purposes count only for Ed25519 keys. */
export function keyHasPurpose(key: Key, purpose: number): boolean {
  const allowed = purpose === PURPOSE.authentication || purpose === PURPOSE.assertion
    || ((purpose === PURPOSE.transaction || purpose === PURPOSE.delegation) && key.keyType === 'Ed25519');
  return allowed && Math.floor(key.purposes / purpose) % 2 === 1;
}

/** `active_key`: the record lists a key whose hash is `keyHash` with the purpose. */
export const activeKey = (record: IdentityDatum, keyHash: string, purpose: number): boolean =>
  record.keys.some((k) => keyHasPurpose(k, purpose) && keyHashOf(k.key) === keyHash.toLowerCase());

/** `has_capability`: `capabilityHex` (UTF-8 bytes as hex) is one of the record's capabilities. */
export const hasCapability = (record: IdentityDatum, capabilityHex: string): boolean => record.capabilities.includes(capabilityHex.toLowerCase());

/** The purpose names of a purpose sum. */
export const purposeNames = (purposes: number): PurposeName[] => PURPOSE_NAMES.filter((n) => Math.floor(purposes / PURPOSE[n]) % 2 === 1);
/** The right names of a rights sum. */
export const rightNames = (rights: number): RightName[] => RIGHT_NAMES.filter((n) => Math.floor(rights / RIGHT[n]) % 2 === 1);
export const hasRight = (rights: number, right: number): boolean => Math.floor(rights / right) % 2 === 1;

// ─── Parties and holds (Part 2 Section 3.2) ────────────────────────────────────────────────────────────────────────────────────

/** `covers(p)`: `not_before <= lo`, and `not_after` is empty or `>= hi`. */
export const covers = (p: Party, lo: number, hi: number): boolean => p.notBefore <= lo && (p.notAfter === null || p.notAfter >= hi);
/** `accountable(D)`: some Accountable Party covers `[lo, hi]`. */
export const accountable = (record: IdentityDatum, lo: number, hi: number): boolean => record.parties.some((p) => p.role === 'Accountable' && covers(p, lo, hi));
/** An eligible guardian: role Guardian, the recover right, and `covers`. */
export const eligibleGuardian = (p: Party, lo: number, hi: number): boolean => p.role === 'Guardian' && hasRight(p.rights, RIGHT.recover) && covers(p, lo, hi);

/** The guardian bound: the threshold is at most the guardians with the recover right whose `not_after` is empty or `>= hi`. */
export function guardianBound(record: IdentityDatum, hi: number): boolean {
  const guardians = record.parties.filter((p) => p.role === 'Guardian' && hasRight(p.rights, RIGHT.recover) && (p.notAfter === null || p.notAfter >= hi));
  return record.guardianThreshold <= guardians.length;
}

/** A current author: ControllerSet, the signer of a party, or any Script signer. */
export const currentAuthor = (signer: Signer, parties: Party[]): boolean =>
  signer.type !== 'KeyHash' || parties.some((p) => sameSigner(p.signer, signer));

export const holdsOf = (status: Status): Hold[] => (status.type === 'Suspended' ? status.holds : []);

/** The holds that a Suspend or an Unsuspend by `author` keeps: in force (`until > lo`), by a current author other than `author`, in order. */
export const keptHolds = (holds: Hold[], parties: Party[], lo: number, author: Signer): Hold[] =>
  holds.filter((h) => h.until > lo && !sameSigner(h.by, author) && currentAuthor(h.by, parties));

export const terminal = (status: Status): boolean => status.type === 'Revoked' || status.type === 'Retired';

/** The tombstone of `record` with `status` (Part 2 Section 3.7). */
export function tombstone(record: IdentityDatum, status: Status): IdentityDatum {
  return { ...record, keys: [], parties: [], guardianThreshold: 0, pendingRecovery: null, description: '', framework: '', endpoint: '', capabilities: [], status };
}

// ─── Effective status (vector_identity.effective) ──────────────────────────────────────────────────────────────────────────────

export type Effective = 'Active' | 'Suspended' | 'Revoked' | 'Retired';

/**
 * `effective(record, refs, identity_hash, lo, hi)` over the record and its ancestors (`ancestors` by identifier): Revoked or Retired
 * for a tombstone, or when an ancestor ended or ended its subagents; Suspended when a hold is in force, an ancestor is suspended,
 * or no Accountable Party covers `[lo, hi]`; else Active. Throws when an ancestor is missing, as the contract fails.
 */
export function effectiveStatus(record: IdentityDatum, ancestors: ReadonlyMap<string, IdentityDatum>, lo: number, hi: number, left = MAX_DEPTH): Effective {
  if (record.status.type === 'Revoked') return 'Revoked';
  if (record.status.type === 'Retired') return 'Retired';
  let inherited: Effective = 'Active';
  if (record.lineage.type === 'Subagent') {
    if (left <= 0) throw new Error('the lineage is deeper than 4 levels');
    const parent = ancestors.get(record.lineage.parent);
    if (!parent) throw new Error(`the record of the parent ${record.lineage.parent} is missing`);
    inherited = parent.subagentEpoch > record.lineage.parentEpoch ? 'Revoked' : effectiveStatus(parent, ancestors, lo, hi, left - 1);
  }
  if (inherited !== 'Active') return inherited;
  if (holdsOf(record.status).some((h) => h.until > lo)) return 'Suspended';
  return accountable(record, lo, hi) ? 'Active' : 'Suspended';
}

// ─── Valid datum (Part 2 Section 3.3) ───────────────────────────────────────────────────────────────────────────────────────────

const byteLength = (hex: string): number => hex.length / 2;
const validTime = (t: number): boolean => Number.isSafeInteger(t) && t >= 0 && t <= 253_402_300_799_999;

/** `rights_within_role`. */
export function rightsWithinRole(role: Role, rights: number): boolean {
  switch (role) {
    case 'Accountable': return rights >= 0 && rights <= 3;
    case 'Responsible': case 'Provider': return rights === 0 || rights === 1;
    case 'Distributor': return rights === 0;
    case 'Guardian': return rights === 0 || rights === 4;
    default: return false;
  }
}

/** `signer_allowed`: a key hash for every role; Module-1 (`m1`) and the controller only for Accountable and Responsible. */
export function signerAllowed(role: Role, signer: Signer, m1: string | null): boolean {
  if (signer.type === 'KeyHash') return byteLength(signer.hash) === 28;
  const accountableOrResponsible = role === 'Accountable' || role === 'Responsible';
  if (signer.type === 'Script') return accountableOrResponsible && m1 !== null && signer.hash === m1;
  return accountableOrResponsible;
}

/** A short name of a signer, for messages. */
export function signerText(s: Signer): string {
  return s.type === 'ControllerSet' ? 'the controller' : s.type === 'Script' ? `Module-1 (${s.hash})` : `key hash ${s.hash}`;
}

/**
 * The problems that make `record` an invalid datum (`valid_datum` of Part 2 Section 3.3), in words; empty when it is valid. `m1` is
 * the Module-1 hash of the configuration record when the transaction reads it: a Script party is valid only with that hash.
 */
export function datumProblems(record: IdentityDatum, m1: string | null): string[] {
  const problems: string[] = [];
  const say = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  say(byteLength(record.controller) === 32, 'the controller must be a 32-byte Ed25519 public key');
  say(record.keys.length <= MAX_KEYS, `at most ${MAX_KEYS} keys`);
  record.keys.forEach((k, i) => {
    const what = `key ${i + 1}`;
    if (k.keyType === 'Ed25519') {
      say(byteLength(k.key) === 32 && k.pop === null, `${what}: an Ed25519 key is 32 bytes without a proof`);
      say(k.purposes >= 1 && k.purposes <= 27 && Math.floor(k.purposes / 4) % 2 === 0, `${what}: purposes must be a non-empty sum of authentication, assertion, transaction and delegation`);
    } else {
      say(byteLength(k.key) === 33 && k.pop !== null && byteLength(k.pop) === 64, `${what}: a P-256 key is a 33-byte compressed point with a 64-byte proof of possession`);
      say(k.purposes >= 1 && k.purposes <= 3, `${what}: a P-256 key may have only the authentication and assertion purposes`);
    }
    say(!record.keys.slice(i + 1).some((o) => o.key === k.key), `${what} is listed twice`);
  });
  say(record.parties.length <= MAX_PARTIES, `at most ${MAX_PARTIES} parties`);
  record.parties.forEach((p, i) => {
    const what = `party ${i + 1} (${p.role}, ${signerText(p.signer)})`;
    say(rightsWithinRole(p.role, p.rights), `${what}: rights above the highest rights of the role`);
    say(signerAllowed(p.role, p.signer, m1), p.signer.type === 'Script' ? `${what}: Module-1 can be only an Accountable or Responsible Party, with the hash of the configuration record` : `${what}: the role does not allow this signer`);
    say(p.organisation === null || (byteLength(p.organisation) >= 1 && byteLength(p.organisation) <= 64), `${what}: the organisation must be 1 to 64 bytes`);
    say(validTime(p.notBefore), `${what}: not_before is not a valid time`);
    say(p.notAfter === null || (validTime(p.notAfter) && p.notAfter > p.notBefore), `${what}: not_after must be after not_before`);
    say(p.removalAfter === null || validTime(p.removalAfter), `${what}: removal_after is not a valid time`);
    say(!record.parties.slice(i + 1).some((o) => o.role === p.role && sameSigner(o.signer, p.signer)), `${what} is listed twice with the same role and signer`);
  });
  say(record.guardianThreshold >= 0, 'the guardian threshold cannot be negative');
  if (record.pendingRecovery !== null) say(record.guardianThreshold >= 1, 'a pending recovery needs a guardian threshold of at least 1');
  if (record.lineage.type === 'Subagent') {
    say(record.lineage.depth >= 1 && record.lineage.depth <= MAX_DEPTH, `a subagent's depth is 1 to ${MAX_DEPTH}`);
    say(record.endpoint === '', 'a subagent has no endpoint');
  }
  say(byteLength(record.name) >= 1 && byteLength(record.name) <= 64, 'the name must be 1 to 64 bytes');
  say(byteLength(record.description) <= 256, 'the description must be at most 256 bytes');
  say(byteLength(record.framework) <= 64, 'the framework must be at most 64 bytes');
  say(byteLength(record.endpoint) <= 256, 'the endpoint must be at most 256 bytes');
  say(record.capabilities.length <= MAX_CAPABILITIES, `at most ${MAX_CAPABILITIES} capabilities`);
  record.capabilities.forEach((c, i) => {
    say(byteLength(c) >= 1 && byteLength(c) <= 64, `capability ${JSON.stringify(textOf(c) ?? c)} must be 1 to 64 bytes`);
    say(!record.capabilities.slice(i + 1).includes(c), `capability ${JSON.stringify(textOf(c) ?? c)} is listed twice`);
  });
  say(validTime(record.createdAt), 'created_at is not a valid time');
  const status = record.status;
  if (status.type === 'Suspended') {
    say(status.holds.length >= 1 && status.holds.length <= MAX_HOLDS, `a suspended record has 1 to ${MAX_HOLDS} holds`);
    status.holds.forEach((h, i) => {
      say(h.since < h.until && h.until - h.since <= DAYS_30_MS, `hold ${i + 1}: since < until, at most 30 days`);
      say(!status.holds.slice(i + 1).some((o) => sameSigner(o.by, h.by)), `hold ${i + 1}: one hold per author`);
    });
  }
  if (terminal(status)) {
    say(record.keys.length === 0 && record.parties.length === 0 && record.guardianThreshold === 0 && record.pendingRecovery === null
      && record.description === '' && record.framework === '' && record.endpoint === '' && record.capabilities.length === 0,
    'a tombstone has no keys, parties, threshold, pending recovery, description, framework, endpoint or capabilities');
  }
  return problems;
}

// ─── Adoption allowlist (Part 2 Section 3.4) ───────────────────────────────────────────────────────────────────────────────────
// The leaves are blake2b-256 of each allowlisted identifier, sorted in ascending byte order. Each level pairs the nodes from the
// left; a node is blake2b-256(min(l, r) ++ max(l, r)); a last node without a pair moves up unchanged. A proof lists the paired nodes
// from the leaf upward. The same tree as agents-marketplace packages/shared/src/identity/allowlist.ts and the contract's allowlist.ak.

const blake256 = (hex: string): string => Buffer.from(blake2b(Buffer.from(hex, 'hex'), { dkLen: 32 })).toString('hex');
const pairNode = (a: string, b: string): string => blake256(a < b ? a + b : b + a);
const NODE = /^[0-9a-f]{64}$/;

/** The levels of the allowlist tree of `ids`, leaves first. Refuses an empty list, a malformed identifier and a duplicate. */
function allowlistLevels(ids: readonly string[]): string[][] {
  if (ids.length === 0) throw new Error('the allowlist holds no identifier');
  if (ids.some((id) => !NODE.test(id))) throw new Error('the allowlist holds an entry that is not an identifier (64 lowercase hex characters)');
  if (new Set(ids).size !== ids.length) throw new Error('the allowlist holds an identifier twice');
  const levels = [ids.map(blake256).sort()];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pairNode(level[i], level[i + 1]) : level[i]);
    levels.push(next);
  }
  return levels;
}

/** The root of the allowlist tree of `ids`. */
export function allowlistRoot(ids: readonly string[]): string {
  const levels = allowlistLevels(ids);
  return levels[levels.length - 1][0];
}

/** The proof that `id` is in the allowlist `ids`: the paired nodes from its leaf upward. Throws when `id` is not in the list. */
export function allowlistProof(ids: readonly string[], id: string): string[] {
  const levels = allowlistLevels(ids);
  let position = levels[0].indexOf(blake256(id));
  if (position < 0) throw new Error(`${id} is not on the adoption allowlist`);
  const proof: string[] = [];
  for (const level of levels.slice(0, -1)) {
    if ((position ^ 1) < level.length) proof.push(level[position ^ 1]);
    position >>= 1;
  }
  return proof;
}

/** Adopt rule 4: true when `proof` shows that `id` is in the tree with `root`. */
export function verifyAllowlistProof(root: string, id: string, proof: readonly string[]): boolean {
  if (!NODE.test(root) || !NODE.test(id) || proof.some((s) => !NODE.test(s))) return false;
  return proof.reduce((node, sibling) => pairNode(node, sibling), blake256(id)) === root;
}
