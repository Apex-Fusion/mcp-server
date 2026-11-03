// packages/builder/src/vector/identity-codec.ts
// Plutus Data codecs of the identity registry and its contracts, on Lucid's Data: the record (did:vector method specification
// Section 5), the legacy record, the identity redeemers (Part 2 Section 3.1), attestations (Section 4), delegations and vaults
// (Section 5), and Plutus addresses. Field and constructor order are the on-chain order of the Aiken types in agents-marketplace
// contracts/identity-marketplace (lib/vector_identity/*.ak, lib/identity_marketplace/types.ak). Lucid's Data.to writes the bytes
// that Aiken's cbor.serialise writes; identity-codec.test.ts checks every Aiken CBOR fixture both ways.
//
// Every ByteArray is lowercase hex, also the UTF-8 text fields: a record can hold bytes that are not valid UTF-8, and a builder
// that changed them by a round trip through text would change fields that its action must keep. utf8Hex and textOf convert at the
// edges. Times and small integers are numbers; a value above 2^53 - 1 is refused with the field named, because a record that the
// contract accepts cannot hold one.
//
// Decoders check the shape: constructor indices, field counts, fixed byte lengths and integer ranges. They do not check the limits
// of a valid record (Part 2 Section 3.3); identity-rules.ts does. Every error is `<what>: <field path>: <problem>`.
import { Constr, Data, credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import type { AddressDetails } from '@lucid-evolution/lucid';

// ─── Shared readers and writers ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The last millisecond of the year 9999: every record time is in [0, MAX_TIME_MS] (Part 1 Section 5). */
export const MAX_TIME_MS = 253_402_300_799_999;
/** Every other record integer is in [0, 2^63). */
export const MAX_RECORD_INT = (1n << 63n) - 1n;

const HEX = /^(?:[0-9a-f]{2})*$/;

class CodecError extends Error {
  constructor(path: string, problem: string) { super(`${path}: ${problem}`); this.name = 'CodecError'; }
}
const fail = (path: string, problem: string): never => { throw new CodecError(path, problem); };

/** Runs `body` and prefixes an error with the name of the codec. */
function codec<T>(name: string, body: () => T): T {
  try { return body(); } catch (err) { throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
}

function parse(hex: string): Data {
  if (typeof hex !== 'string' || !HEX.test(hex.toLowerCase())) fail('cbor', 'expected hex');
  try { return Data.from(hex.toLowerCase()); } catch { return fail('cbor', 'not Plutus Data'); }
}

export function constrFields(x: Data, path: string, index: number, count: number): Data[] {
  if (!(x instanceof Constr)) return fail(path, 'expected a constructor');
  if (x.index !== index) return fail(path, `expected constructor ${index}, got ${x.index}`);
  if (x.fields.length !== count) return fail(path, `expected ${count} fields, got ${x.fields.length}`);
  return x.fields;
}

/** The constructor index of `x` among `count` constructors. */
export function constrIndex(x: Data, path: string, count: number): number {
  if (!(x instanceof Constr)) return fail(path, 'expected a constructor');
  if (x.index < 0 || x.index >= count) return fail(path, `unknown constructor ${x.index} (expected 0..${count - 1})`);
  return x.index;
}

/** Bytes as lowercase hex; `length` fixes the byte length, `[min, max]` bounds it. */
export function bytesOf(x: Data, path: string, length?: number | [number, number]): string {
  if (typeof x !== 'string' || !HEX.test(x.toLowerCase())) return fail(path, 'expected bytes');
  const n = x.length / 2;
  if (typeof length === 'number' && n !== length) fail(path, `expected ${length} bytes, got ${n}`);
  if (Array.isArray(length) && (n < length[0] || n > length[1])) fail(path, `expected ${length[0]}..${length[1]} bytes, got ${n}`);
  return x.toLowerCase();
}

/** An integer in [min, max] as a number; past 2^53 - 1 it is refused, naming the field. */
export function intOf(x: Data, path: string, min = 0n, max = MAX_RECORD_INT): number {
  if (typeof x !== 'bigint') return fail(path, 'expected an integer');
  if (x < min || x > max) fail(path, `integer ${x} outside [${min}, ${max}]`);
  if (x > BigInt(Number.MAX_SAFE_INTEGER) || x < -BigInt(Number.MAX_SAFE_INTEGER)) fail(path, 'integer outside the safe range of this tool');
  return Number(x);
}
export const timeOf = (x: Data, path: string): number => intOf(x, path, 0n, BigInt(MAX_TIME_MS));

export function bigintOf(x: Data, path: string, min = 0n, max = MAX_RECORD_INT): bigint {
  if (typeof x !== 'bigint') return fail(path, 'expected an integer');
  if (x < min || x > max) fail(path, `integer ${x} outside [${min}, ${max}]`);
  return x;
}

export function listOf<T>(x: Data, path: string, item: (d: Data, p: string) => T): T[] {
  if (!Array.isArray(x)) return fail(path, 'expected a list');
  return x.map((d, i) => item(d, `${path}[${i}]`));
}

export function optionOf<T>(x: Data, path: string, inner: (d: Data, p: string) => T): T | null {
  const index = constrIndex(x, path, 2);
  if (index === 1) { constrFields(x, path, 1, 0); return null; }
  return inner(constrFields(x, path, 0, 1)[0], path);
}

export function boolOf(x: Data, path: string): boolean {
  const index = constrIndex(x, path, 2);
  constrFields(x, path, index, 0);
  return index === 1;
}

const some = (x: Data): Data => new Constr(0, [x]);
const none = (): Data => new Constr(1, []);
export const optionData = <T>(value: T | null, f: (v: T) => Data): Data => (value === null ? none() : some(f(value)));
export const boolData = (value: boolean): Data => new Constr(value ? 1 : 0, []);
const tag = (index: number): Data => new Constr(index, []);

/** A number field as a Plutus integer. Refuses a value that is not a safe whole number. */
export function intData(value: number, path: string): bigint {
  if (!Number.isSafeInteger(value)) fail(path, 'expected a whole number');
  return BigInt(value);
}
/** A bytes field from hex; `length` fixes the byte length. */
export function hexData(value: string, path: string, length?: number): string {
  if (typeof value !== 'string' || !HEX.test(value.toLowerCase())) return fail(path, 'expected hex');
  if (length !== undefined && value.length !== length * 2) fail(path, `expected ${length} bytes, got ${value.length / 2}`);
  return value.toLowerCase();
}

/** UTF-8 text as lowercase hex, for the text fields of a record. */
export const utf8Hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
/** The UTF-8 text of hex bytes, or null when the bytes are not valid UTF-8. */
export function textOf(hex: string): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex')); } catch { return null; }
}

// ─── Output references ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OutputReference { txHash: string; outputIndex: number }

export const outRefData = (ref: OutputReference, path = 'output_reference'): Data =>
  new Constr(0, [hexData(ref.txHash, `${path}.transaction_id`, 32), intData(ref.outputIndex, `${path}.output_index`)]);

export function outRefOf(x: Data, path: string): OutputReference {
  const [id, index] = constrFields(x, path, 0, 2);
  return { txHash: bytesOf(id, `${path}.transaction_id`, 32), outputIndex: intOf(index, `${path}.output_index`) };
}

// ─── Identity record (Part 1 Section 5) ─────────────────────────────────────────────────────────────────────────────────────────

export const KEY_TYPES = ['Ed25519', 'P256'] as const;
export type KeyType = typeof KEY_TYPES[number];
export const ROLES = ['Accountable', 'Responsible', 'Provider', 'Distributor', 'Guardian'] as const;
export type Role = typeof ROLES[number];

export interface Key { keyType: KeyType; key: string; purposes: number; pop: string | null }
export type Signer = { type: 'KeyHash'; hash: string } | { type: 'Script'; hash: string } | { type: 'ControllerSet' };
export interface Party {
  role: Role; signer: Signer;
  /** UTF-8 bytes as hex. */
  organisation: string | null;
  notBefore: number; notAfter: number | null; rights: number; removalAfter: number | null;
}
export type Lineage = { type: 'Root' } | { type: 'Subagent'; parent: string; parentEpoch: number; depth: number };
export interface Hold { by: Signer; reason: number; since: number; until: number }
export type Status =
  | { type: 'Active' }
  | { type: 'Suspended'; holds: Hold[] }
  | { type: 'Revoked'; by: Signer; reason: number; at: number; invalidFrom: number | null; successor: string | null }
  | { type: 'Retired'; at: number; successor: string | null };
export interface PendingRecovery { newController: string; effectiveAfter: number }
export interface IdentityDatum {
  /** Ed25519 public key, 32 bytes. */
  controller: string;
  keys: Key[];
  parties: Party[];
  guardianThreshold: number;
  pendingRecovery: PendingRecovery | null;
  lineage: Lineage;
  subagentEpoch: number;
  /** UTF-8 bytes as hex, as are description, framework, endpoint and each capability. */
  name: string;
  description: string;
  framework: string;
  endpoint: string;
  capabilities: string[];
  createdAt: number;
  status: Status;
}

const SIGNERS = ['KeyHash', 'Script', 'ControllerSet'] as const;
const STATUSES = ['Active', 'Suspended', 'Revoked', 'Retired'] as const;

export function signerData(s: Signer, path = 'signer'): Data {
  if (s.type === 'KeyHash') return new Constr(0, [hexData(s.hash, `${path}.hash`, 28)]);
  if (s.type === 'Script') return new Constr(1, [hexData(s.hash, `${path}.hash`, 28)]);
  if (s.type === 'ControllerSet') return new Constr(2, []);
  return fail(path, 'unknown signer');
}
export function signerOf(x: Data, path: string): Signer {
  const type = SIGNERS[constrIndex(x, path, SIGNERS.length)];
  if (type === 'ControllerSet') { constrFields(x, path, 2, 0); return { type }; }
  const [hash] = constrFields(x, path, type === 'KeyHash' ? 0 : 1, 1);
  return { type, hash: bytesOf(hash, `${path}.hash`, 28) };
}
/** Signers compare by kind and hash (Aiken's structural equality of `Signer`). */
export function sameSigner(a: Signer, b: Signer): boolean {
  if (a.type === 'ControllerSet' || b.type === 'ControllerSet') return a.type === b.type;
  return a.type === b.type && a.hash === b.hash;
}

function keyData(k: Key, path: string): Data {
  const type = KEY_TYPES.indexOf(k.keyType);
  if (type < 0) fail(`${path}.key_type`, 'unknown key type');
  return new Constr(0, [tag(type), hexData(k.key, `${path}.key`), intData(k.purposes, `${path}.purposes`), optionData(k.pop, (p) => hexData(p, `${path}.pop`))]);
}
function keyOf(x: Data, path: string): Key {
  const [type, key, purposes, pop] = constrFields(x, path, 0, 4);
  const keyType = KEY_TYPES[constrIndex(type, `${path}.key_type`, 2)];
  constrFields(type, `${path}.key_type`, KEY_TYPES.indexOf(keyType), 0);
  return { keyType, key: bytesOf(key, `${path}.key`), purposes: intOf(purposes, `${path}.purposes`), pop: optionOf(pop, `${path}.pop`, (d, p) => bytesOf(d, p)) };
}

export function partyData(p: Party, path = 'party'): Data {
  const role = ROLES.indexOf(p.role);
  if (role < 0) fail(`${path}.role`, 'unknown role');
  return new Constr(0, [
    tag(role), signerData(p.signer, `${path}.signer`), optionData(p.organisation, (o) => hexData(o, `${path}.organisation`)),
    intData(p.notBefore, `${path}.not_before`), optionData(p.notAfter, (t) => intData(t, `${path}.not_after`)),
    intData(p.rights, `${path}.rights`), optionData(p.removalAfter, (t) => intData(t, `${path}.removal_after`)),
  ]);
}
export function partyOf(x: Data, path: string): Party {
  const [role, signer, organisation, notBefore, notAfter, rights, removalAfter] = constrFields(x, path, 0, 7);
  const roleIndex = constrIndex(role, `${path}.role`, ROLES.length);
  constrFields(role, `${path}.role`, roleIndex, 0);
  return {
    role: ROLES[roleIndex], signer: signerOf(signer, `${path}.signer`),
    organisation: optionOf(organisation, `${path}.organisation`, (d, p) => bytesOf(d, p)),
    notBefore: timeOf(notBefore, `${path}.not_before`), notAfter: optionOf(notAfter, `${path}.not_after`, timeOf),
    rights: intOf(rights, `${path}.rights`), removalAfter: optionOf(removalAfter, `${path}.removal_after`, timeOf),
  };
}

function lineageData(l: Lineage, path: string): Data {
  if (l.type === 'Root') return tag(0);
  return new Constr(1, [hexData(l.parent, `${path}.parent`, 32), intData(l.parentEpoch, `${path}.parent_epoch`), intData(l.depth, `${path}.depth`)]);
}
function lineageOf(x: Data, path: string): Lineage {
  if (constrIndex(x, path, 2) === 0) { constrFields(x, path, 0, 0); return { type: 'Root' }; }
  const [parent, epoch, depth] = constrFields(x, path, 1, 3);
  return { type: 'Subagent', parent: bytesOf(parent, `${path}.parent`, 32), parentEpoch: intOf(epoch, `${path}.parent_epoch`), depth: intOf(depth, `${path}.depth`) };
}

export function holdData(h: Hold, path = 'hold'): Data {
  return new Constr(0, [signerData(h.by, `${path}.by`), intData(h.reason, `${path}.reason`), intData(h.since, `${path}.since`), intData(h.until, `${path}.until`)]);
}
function holdOf(x: Data, path: string): Hold {
  const [by, reason, since, until] = constrFields(x, path, 0, 4);
  return { by: signerOf(by, `${path}.by`), reason: intOf(reason, `${path}.reason`), since: timeOf(since, `${path}.since`), until: timeOf(until, `${path}.until`) };
}

export function statusData(s: Status, path = 'status'): Data {
  switch (s.type) {
    case 'Active': return tag(0);
    case 'Suspended': return new Constr(1, [s.holds.map((h, i) => holdData(h, `${path}.holds[${i}]`))]);
    case 'Revoked': return new Constr(2, [
      signerData(s.by, `${path}.by`), intData(s.reason, `${path}.reason`), intData(s.at, `${path}.at`),
      optionData(s.invalidFrom, (t) => intData(t, `${path}.invalid_from`)), optionData(s.successor, (id) => hexData(id, `${path}.successor`, 32)),
    ]);
    case 'Retired': return new Constr(3, [intData(s.at, `${path}.at`), optionData(s.successor, (id) => hexData(id, `${path}.successor`, 32))]);
    default: return fail(path, 'unknown status');
  }
}
function statusOf(x: Data, path: string): Status {
  const type = STATUSES[constrIndex(x, path, STATUSES.length)];
  if (type === 'Active') { constrFields(x, path, 0, 0); return { type }; }
  if (type === 'Suspended') return { type, holds: listOf(constrFields(x, path, 1, 1)[0], `${path}.holds`, holdOf) };
  if (type === 'Revoked') {
    const [by, reason, at, invalidFrom, successor] = constrFields(x, path, 2, 5);
    return {
      type, by: signerOf(by, `${path}.by`), reason: intOf(reason, `${path}.reason`), at: timeOf(at, `${path}.at`),
      invalidFrom: optionOf(invalidFrom, `${path}.invalid_from`, timeOf), successor: optionOf(successor, `${path}.successor`, (d, p) => bytesOf(d, p, 32)),
    };
  }
  const [at, successor] = constrFields(x, path, 3, 2);
  return { type, at: timeOf(at, `${path}.at`), successor: optionOf(successor, `${path}.successor`, (d, p) => bytesOf(d, p, 32)) };
}

export function identityDatumToData(d: IdentityDatum): Data {
  const path = 'record';
  return new Constr(0, [
    hexData(d.controller, `${path}.controller`, 32),
    d.keys.map((k, i) => keyData(k, `${path}.keys[${i}]`)),
    d.parties.map((p, i) => partyData(p, `${path}.parties[${i}]`)),
    intData(d.guardianThreshold, `${path}.guardian_threshold`),
    optionData(d.pendingRecovery, (r) => new Constr(0, [hexData(r.newController, `${path}.pending_recovery.new_controller`, 32), intData(r.effectiveAfter, `${path}.pending_recovery.effective_after`)])),
    lineageData(d.lineage, `${path}.lineage`),
    intData(d.subagentEpoch, `${path}.subagent_epoch`),
    hexData(d.name, `${path}.name`), hexData(d.description, `${path}.description`), hexData(d.framework, `${path}.framework`), hexData(d.endpoint, `${path}.endpoint`),
    d.capabilities.map((c, i) => hexData(c, `${path}.capabilities[${i}]`)),
    intData(d.createdAt, `${path}.created_at`),
    statusData(d.status, `${path}.status`),
  ]);
}

export function identityDatumFromData(x: Data, path = 'record'): IdentityDatum {
  const f = constrFields(x, path, 0, 14);
  return {
    controller: bytesOf(f[0], `${path}.controller`, 32),
    keys: listOf(f[1], `${path}.keys`, keyOf),
    parties: listOf(f[2], `${path}.parties`, partyOf),
    guardianThreshold: intOf(f[3], `${path}.guardian_threshold`),
    pendingRecovery: optionOf(f[4], `${path}.pending_recovery`, (d, p) => {
      const [newController, effectiveAfter] = constrFields(d, p, 0, 2);
      return { newController: bytesOf(newController, `${p}.new_controller`, 32), effectiveAfter: timeOf(effectiveAfter, `${p}.effective_after`) };
    }),
    lineage: lineageOf(f[5], `${path}.lineage`),
    subagentEpoch: intOf(f[6], `${path}.subagent_epoch`),
    name: bytesOf(f[7], `${path}.name`), description: bytesOf(f[8], `${path}.description`),
    framework: bytesOf(f[9], `${path}.framework`), endpoint: bytesOf(f[10], `${path}.endpoint`),
    capabilities: listOf(f[11], `${path}.capabilities`, (d, p) => bytesOf(d, p)),
    createdAt: timeOf(f[12], `${path}.created_at`),
    status: statusOf(f[13], `${path}.status`),
  };
}

export const encodeIdentityDatum = (d: IdentityDatum): string => codec('encodeIdentityDatum', () => Data.to(identityDatumToData(d)));
export const decodeIdentityDatum = (hex: string): IdentityDatum => codec('decodeIdentityDatum', () => identityDatumFromData(parse(hex)));

// ─── Legacy record (Part 1 Section 5, LegacyDatum) ─────────────────────────────────────────────────────────────────────────────

export type Credential = { type: 'VerificationKey'; hash: string } | { type: 'Script'; hash: string };
export interface LegacyDatum {
  owner: Credential;
  /** UTF-8 bytes as hex, as are description, framework, endpoint and each capability. */
  name: string; description: string; capabilities: string[]; framework: string; endpoint: string;
  /** Self-declared; not used. Kept as it is so that the datum encodes back to the same bytes. */
  registeredAt: bigint;
}

function credentialOf(x: Data, path: string): Credential {
  const index = constrIndex(x, path, 2);
  const [hash] = constrFields(x, path, index, 1);
  return { type: index === 0 ? 'VerificationKey' : 'Script', hash: bytesOf(hash, `${path}.hash`, 28) };
}
function credentialData(c: Credential, path: string): Data {
  return new Constr(c.type === 'VerificationKey' ? 0 : 1, [hexData(c.hash, `${path}.hash`, 28)]);
}

export function decodeLegacyDatum(hex: string): LegacyDatum {
  return codec('decodeLegacyDatum', () => {
    const path = 'legacy';
    const [owner, name, description, capabilities, framework, endpoint, registeredAt] = constrFields(parse(hex), path, 0, 7);
    return {
      owner: credentialOf(owner, `${path}.owner`), name: bytesOf(name, `${path}.name`), description: bytesOf(description, `${path}.description`),
      capabilities: listOf(capabilities, `${path}.capabilities`, (d, p) => bytesOf(d, p)), framework: bytesOf(framework, `${path}.framework`),
      endpoint: bytesOf(endpoint, `${path}.endpoint`), registeredAt: bigintOf(registeredAt, `${path}.registered_at`, -(1n << 64n), 1n << 64n),
    };
  });
}

export function encodeLegacyDatum(d: LegacyDatum): string {
  return codec('encodeLegacyDatum', () => Data.to(new Constr(0, [
    credentialData(d.owner, 'legacy.owner'), hexData(d.name, 'legacy.name'), hexData(d.description, 'legacy.description'),
    d.capabilities.map((c, i) => hexData(c, `legacy.capabilities[${i}]`)), hexData(d.framework, 'legacy.framework'),
    hexData(d.endpoint, 'legacy.endpoint'), d.registeredAt,
  ])));
}

// ─── Identity redeemers (Part 2 Section 3.1) ────────────────────────────────────────────────────────────────────────────────────

export type IdentityMint = { type: 'Register'; seed: OutputReference } | { type: 'Adopt'; proof: string[] };
export type Actor = { type: 'ByController' } | { type: 'ByParty'; index: number };
export type IdentitySpend =
  | { type: 'Update' } | { type: 'ChangeController' }
  | { type: 'Suspend'; actor: Actor } | { type: 'Unsuspend'; author: Signer } | { type: 'Revoke'; actor: Actor }
  | { type: 'Retire' } | { type: 'Reclaim' } | { type: 'SetSuccessor' } | { type: 'BumpEpoch' }
  | { type: 'RecoverInit'; guardians: number[] } | { type: 'RecoverCancel'; guardians: number[] } | { type: 'RecoverFinalize' };
const SPENDS = ['Update', 'ChangeController', 'Suspend', 'Unsuspend', 'Revoke', 'Retire', 'Reclaim', 'SetSuccessor', 'BumpEpoch', 'RecoverInit', 'RecoverCancel', 'RecoverFinalize'] as const;

export function encodeIdentityMint(r: IdentityMint): string {
  return codec('encodeIdentityMint', () => Data.to(r.type === 'Register'
    ? new Constr(0, [outRefData(r.seed, 'seed')])
    : new Constr(1, [r.proof.map((s, i) => hexData(s, `proof[${i}]`, 32))])));
}
export function decodeIdentityMint(hex: string): IdentityMint {
  return codec('decodeIdentityMint', () => {
    const x = parse(hex);
    if (constrIndex(x, 'mint', 2) === 0) return { type: 'Register', seed: outRefOf(constrFields(x, 'mint', 0, 1)[0], 'seed') };
    return { type: 'Adopt', proof: listOf(constrFields(x, 'mint', 1, 1)[0], 'proof', (d, p) => bytesOf(d, p, 32)) };
  });
}

const actorData = (a: Actor): Data => (a.type === 'ByController' ? tag(0) : new Constr(1, [intData(a.index, 'actor.index')]));
function actorOf(x: Data, path: string): Actor {
  if (constrIndex(x, path, 2) === 0) { constrFields(x, path, 0, 0); return { type: 'ByController' }; }
  return { type: 'ByParty', index: intOf(constrFields(x, path, 1, 1)[0], `${path}.index`) };
}

export function encodeIdentitySpend(r: IdentitySpend): string {
  return codec('encodeIdentitySpend', () => {
    const index = SPENDS.indexOf(r.type);
    if (index < 0) fail('spend', 'unknown action');
    switch (r.type) {
      case 'Suspend': case 'Revoke': return Data.to(new Constr(index, [actorData(r.actor)]));
      case 'Unsuspend': return Data.to(new Constr(index, [signerData(r.author, 'author')]));
      case 'RecoverInit': case 'RecoverCancel': return Data.to(new Constr(index, [r.guardians.map((g, i) => intData(g, `guardians[${i}]`))]));
      default: return Data.to(new Constr(index, []));
    }
  });
}
export function decodeIdentitySpend(hex: string): IdentitySpend {
  return codec('decodeIdentitySpend', () => {
    const x = parse(hex);
    const index = constrIndex(x, 'spend', SPENDS.length);
    const type = SPENDS[index];
    switch (type) {
      case 'Suspend': case 'Revoke': return { type, actor: actorOf(constrFields(x, 'spend', index, 1)[0], 'actor') };
      case 'Unsuspend': return { type, author: signerOf(constrFields(x, 'spend', index, 1)[0], 'author') };
      case 'RecoverInit': case 'RecoverCancel': return { type, guardians: listOf(constrFields(x, 'spend', index, 1)[0], 'guardians', (d, p) => intOf(d, p)) };
      default: constrFields(x, 'spend', index, 0); return { type } as IdentitySpend;
    }
  });
}

// ─── Attestations (Part 2 Section 4) ────────────────────────────────────────────────────────────────────────────────────────────

export type AttStatus = { type: 'AttActive' } | { type: 'AttRevoked'; at: number; reason: number };
/** `uri`: 1..256 bytes (hex); `sha256`: 32 bytes. */
export interface Anchor { uri: string; sha256: string }
/** `rel`: 0 supersedes, 1 depends_on, 2 corroborates, 3 disputes; `target`: the token name of another attestation (32 bytes). */
export interface Link { rel: number; target: string }
export interface AttestationDatum {
  subject: string; issuer: string; issuerId: string | null; attType: number; format: number | null; profile: string | null;
  digest: string; locator: string | null; envelopeSig: string | null; issuedAt: number; validFrom: number | null; validUntil: number | null;
  solicited: boolean; status: AttStatus; contested: Anchor | null; links: Link[];
}
export type AttestationMint = { type: 'Attest'; seed: OutputReference } | { type: 'Burn' };
export type AttestationSpend = { type: 'RevokeAtt'; reason: number } | { type: 'Contest' } | { type: 'Withdraw' };

export function attestationDatumToData(d: AttestationDatum): Data {
  const p = 'attestation';
  return new Constr(0, [
    hexData(d.subject, `${p}.subject`, 32), hexData(d.issuer, `${p}.issuer`, 32), optionData(d.issuerId, (id) => hexData(id, `${p}.issuer_id`, 32)),
    intData(d.attType, `${p}.att_type`), optionData(d.format, (n) => intData(n, `${p}.format`)), optionData(d.profile, (h) => hexData(h, `${p}.profile`, 32)),
    hexData(d.digest, `${p}.digest`, 32), optionData(d.locator, (l) => hexData(l, `${p}.locator`)), optionData(d.envelopeSig, (s) => hexData(s, `${p}.envelope_sig`, 64)),
    intData(d.issuedAt, `${p}.issued_at`), optionData(d.validFrom, (t) => intData(t, `${p}.valid_from`)), optionData(d.validUntil, (t) => intData(t, `${p}.valid_until`)),
    boolData(d.solicited),
    d.status.type === 'AttActive' ? tag(0) : new Constr(1, [intData(d.status.at, `${p}.status.at`), intData(d.status.reason, `${p}.status.reason`)]),
    optionData(d.contested, (a) => new Constr(0, [hexData(a.uri, `${p}.contested.uri`), hexData(a.sha256, `${p}.contested.sha256`, 32)])),
    d.links.map((l, i) => new Constr(0, [intData(l.rel, `${p}.links[${i}].rel`), hexData(l.target, `${p}.links[${i}].target`, 32)])),
  ]);
}

export function attestationDatumFromData(x: Data, path = 'attestation'): AttestationDatum {
  const f = constrFields(x, path, 0, 16);
  const statusIndex = constrIndex(f[13], `${path}.status`, 2);
  let status: AttStatus;
  if (statusIndex === 0) { constrFields(f[13], `${path}.status`, 0, 0); status = { type: 'AttActive' }; } else {
    const [at, reason] = constrFields(f[13], `${path}.status`, 1, 2);
    status = { type: 'AttRevoked', at: timeOf(at, `${path}.status.at`), reason: intOf(reason, `${path}.status.reason`) };
  }
  return {
    subject: bytesOf(f[0], `${path}.subject`, 32), issuer: bytesOf(f[1], `${path}.issuer`, 32),
    issuerId: optionOf(f[2], `${path}.issuer_id`, (d, p) => bytesOf(d, p, 32)), attType: intOf(f[3], `${path}.att_type`),
    format: optionOf(f[4], `${path}.format`, (d, p) => intOf(d, p)), profile: optionOf(f[5], `${path}.profile`, (d, p) => bytesOf(d, p, 32)),
    digest: bytesOf(f[6], `${path}.digest`, 32), locator: optionOf(f[7], `${path}.locator`, (d, p) => bytesOf(d, p)),
    envelopeSig: optionOf(f[8], `${path}.envelope_sig`, (d, p) => bytesOf(d, p, 64)), issuedAt: timeOf(f[9], `${path}.issued_at`),
    validFrom: optionOf(f[10], `${path}.valid_from`, timeOf), validUntil: optionOf(f[11], `${path}.valid_until`, timeOf),
    solicited: boolOf(f[12], `${path}.solicited`), status,
    contested: optionOf(f[14], `${path}.contested`, (d, p) => {
      const [uri, sha] = constrFields(d, p, 0, 2);
      return { uri: bytesOf(uri, `${p}.uri`), sha256: bytesOf(sha, `${p}.sha256`, 32) };
    }),
    links: listOf(f[15], `${path}.links`, (d, p) => {
      const [rel, target] = constrFields(d, p, 0, 2);
      return { rel: intOf(rel, `${p}.rel`), target: bytesOf(target, `${p}.target`, 32) };
    }),
  };
}

export const encodeAttestationDatum = (d: AttestationDatum): string => codec('encodeAttestationDatum', () => Data.to(attestationDatumToData(d)));
export const decodeAttestationDatum = (hex: string): AttestationDatum => codec('decodeAttestationDatum', () => attestationDatumFromData(parse(hex)));

export function encodeAttestationMint(r: AttestationMint): string {
  return codec('encodeAttestationMint', () => Data.to(r.type === 'Attest' ? new Constr(0, [outRefData(r.seed, 'seed')]) : tag(1)));
}
export function encodeAttestationSpend(r: AttestationSpend): string {
  return codec('encodeAttestationSpend', () => Data.to(r.type === 'RevokeAtt' ? new Constr(0, [intData(r.reason, 'reason')]) : tag(r.type === 'Contest' ? 1 : 2)));
}

// ─── Delegations and vaults (Part 2 Sections 5.2 and 5.3) ───────────────────────────────────────────────────────────────────────

export type Delegator = { type: 'PrincipalKey'; hash: string; organisation: string | null } | { type: 'Agent'; id: string };
export interface ValueLimit { perTx: bigint; total: bigint; periodMs: number }
export interface DelegationDatum {
  delegator: Delegator; parent: string | null; delegate: string; delegateKey: string;
  /** UTF-8 bytes as hex. */
  actions: string[];
  /** UTF-8 bytes as hex. */
  resources: string[];
  notBefore: number; notAfter: number; depth: number; remaining: number; purpose: string | null; value: ValueLimit | null;
}
export type DelegationMint = { type: 'Delegate'; seed: OutputReference } | { type: 'Undelegate' };
export type VaultDatum =
  | { type: 'Live'; owner: Delegator; delegation: string; spent: bigint; periodStart: number }
  | { type: 'Returned'; owner: Delegator };
export type VaultSpend = { type: 'Pay' } | { type: 'Close' };

export function delegatorData(d: Delegator, path = 'delegator'): Data {
  if (d.type === 'PrincipalKey') return new Constr(0, [hexData(d.hash, `${path}.hash`, 28), optionData(d.organisation, (o) => hexData(o, `${path}.organisation`))]);
  return new Constr(1, [hexData(d.id, `${path}.id`, 32)]);
}
export function delegatorOf(x: Data, path: string): Delegator {
  if (constrIndex(x, path, 2) === 0) {
    const [hash, organisation] = constrFields(x, path, 0, 2);
    return { type: 'PrincipalKey', hash: bytesOf(hash, `${path}.hash`, 28), organisation: optionOf(organisation, `${path}.organisation`, (d, p) => bytesOf(d, p)) };
  }
  return { type: 'Agent', id: bytesOf(constrFields(x, path, 1, 1)[0], `${path}.id`, 32) };
}
export const sameDelegator = (a: Delegator, b: Delegator): boolean =>
  a.type === 'Agent' ? b.type === 'Agent' && a.id === b.id : b.type === 'PrincipalKey' && a.hash === b.hash && a.organisation === b.organisation;

export function delegationDatumToData(d: DelegationDatum): Data {
  const p = 'delegation';
  return new Constr(0, [
    delegatorData(d.delegator, `${p}.delegator`), optionData(d.parent, (id) => hexData(id, `${p}.parent`, 32)),
    hexData(d.delegate, `${p}.delegate`, 32), hexData(d.delegateKey, `${p}.delegate_key`, 28),
    d.actions.map((a, i) => hexData(a, `${p}.actions[${i}]`)), d.resources.map((r, i) => hexData(r, `${p}.resources[${i}]`)),
    intData(d.notBefore, `${p}.not_before`), intData(d.notAfter, `${p}.not_after`), intData(d.depth, `${p}.depth`), intData(d.remaining, `${p}.remaining`),
    optionData(d.purpose, (h) => hexData(h, `${p}.purpose`, 32)),
    optionData(d.value, (v) => new Constr(0, [v.perTx, v.total, intData(v.periodMs, `${p}.value.period_ms`)])),
  ]);
}

export function delegationDatumFromData(x: Data, path = 'delegation'): DelegationDatum {
  const f = constrFields(x, path, 0, 12);
  return {
    delegator: delegatorOf(f[0], `${path}.delegator`), parent: optionOf(f[1], `${path}.parent`, (d, p) => bytesOf(d, p, 32)),
    delegate: bytesOf(f[2], `${path}.delegate`, 32), delegateKey: bytesOf(f[3], `${path}.delegate_key`, 28),
    actions: listOf(f[4], `${path}.actions`, (d, p) => bytesOf(d, p)), resources: listOf(f[5], `${path}.resources`, (d, p) => bytesOf(d, p)),
    notBefore: timeOf(f[6], `${path}.not_before`), notAfter: timeOf(f[7], `${path}.not_after`),
    depth: intOf(f[8], `${path}.depth`), remaining: intOf(f[9], `${path}.remaining`),
    purpose: optionOf(f[10], `${path}.purpose`, (d, p) => bytesOf(d, p, 32)),
    value: optionOf(f[11], `${path}.value`, (d, p) => {
      const [perTx, total, periodMs] = constrFields(d, p, 0, 3);
      return { perTx: bigintOf(perTx, `${p}.per_tx`), total: bigintOf(total, `${p}.total`), periodMs: intOf(periodMs, `${p}.period_ms`) };
    }),
  };
}

export const encodeDelegationDatum = (d: DelegationDatum): string => codec('encodeDelegationDatum', () => Data.to(delegationDatumToData(d)));
export const decodeDelegationDatum = (hex: string): DelegationDatum => codec('decodeDelegationDatum', () => delegationDatumFromData(parse(hex)));
export function encodeDelegationMint(r: DelegationMint): string {
  return codec('encodeDelegationMint', () => Data.to(r.type === 'Delegate' ? new Constr(0, [outRefData(r.seed, 'seed')]) : tag(1)));
}

export function vaultDatumToData(d: VaultDatum): Data {
  if (d.type === 'Returned') return new Constr(1, [delegatorData(d.owner, 'vault.owner')]);
  return new Constr(0, [delegatorData(d.owner, 'vault.owner'), hexData(d.delegation, 'vault.delegation', 32), d.spent, intData(d.periodStart, 'vault.period_start')]);
}
export function vaultDatumFromData(x: Data, path = 'vault'): VaultDatum {
  if (constrIndex(x, path, 2) === 1) return { type: 'Returned', owner: delegatorOf(constrFields(x, path, 1, 1)[0], `${path}.owner`) };
  const [owner, delegation, spent, periodStart] = constrFields(x, path, 0, 4);
  return {
    type: 'Live', owner: delegatorOf(owner, `${path}.owner`), delegation: bytesOf(delegation, `${path}.delegation`, 32),
    spent: bigintOf(spent, `${path}.spent`), periodStart: timeOf(periodStart, `${path}.period_start`),
  };
}
export const encodeVaultDatum = (d: VaultDatum): string => codec('encodeVaultDatum', () => Data.to(vaultDatumToData(d)));
export const decodeVaultDatum = (hex: string): VaultDatum => codec('decodeVaultDatum', () => vaultDatumFromData(parse(hex)));
export const encodeVaultSpend = (r: VaultSpend): string => codec('encodeVaultSpend', () => Data.to(tag(r.type === 'Pay' ? 0 : 1)));

// ─── Plutus addresses ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type StakeCredential =
  | { type: 'Inline'; credential: Credential }
  | { type: 'Pointer'; slotNumber: bigint; transactionIndex: bigint; certificateIndex: bigint };
export interface PlutusAddress { paymentCredential: Credential; stakeCredential: StakeCredential | null }

export function plutusAddressToData(a: PlutusAddress, path = 'address'): Data {
  const stake = a.stakeCredential;
  return new Constr(0, [
    credentialData(a.paymentCredential, `${path}.payment_credential`),
    stake === null ? none() : some(stake.type === 'Inline'
      ? new Constr(0, [credentialData(stake.credential, `${path}.stake_credential`)])
      : new Constr(1, [stake.slotNumber, stake.transactionIndex, stake.certificateIndex])),
  ]);
}

export function plutusAddressOf(x: Data, path = 'address'): PlutusAddress {
  const [payment, stake] = constrFields(x, path, 0, 2);
  return {
    paymentCredential: credentialOf(payment, `${path}.payment_credential`),
    stakeCredential: optionOf(stake, `${path}.stake_credential`, (d, p) => {
      if (constrIndex(d, p, 2) === 0) return { type: 'Inline', credential: credentialOf(constrFields(d, p, 0, 1)[0], p) };
      const [slot, tx, cert] = constrFields(d, p, 1, 3);
      return { type: 'Pointer', slotNumber: bigintOf(slot, `${p}.slot_number`), transactionIndex: bigintOf(tx, `${p}.transaction_index`), certificateIndex: bigintOf(cert, `${p}.certificate_index`) };
    }),
  };
}

/** The Plutus form of a bech32 address with a key or script payment credential; pointer and Byron addresses are refused. */
export function plutusAddressFromBech32(address: string): PlutusAddress {
  let details: AddressDetails;
  try { details = getAddressDetails(address); } catch { return fail('address', 'not a valid address'); }
  const cred = (c: { type: 'Key' | 'Script'; hash: string }): Credential => ({ type: c.type === 'Key' ? 'VerificationKey' : 'Script', hash: c.hash.toLowerCase() });
  if (!details.paymentCredential || (details.type !== 'Base' && details.type !== 'Enterprise')) fail('address', `a ${details.type} address cannot be used here`);
  return {
    paymentCredential: cred(details.paymentCredential!),
    stakeCredential: details.stakeCredential ? { type: 'Inline', credential: cred(details.stakeCredential) } : null,
  };
}

/** The bech32 form of a Plutus address on Vector mainnet, or null for a pointer address (no payout is built to one). */
export function plutusAddressToBech32(a: PlutusAddress): string | null {
  const cred = (c: Credential) => ({ type: c.type === 'VerificationKey' ? 'Key' as const : 'Script' as const, hash: c.hash });
  if (a.stakeCredential?.type === 'Pointer') return null;
  return credentialToAddress('Mainnet', cred(a.paymentCredential), a.stakeCredential ? cred(a.stakeCredential.credential) : undefined);
}
