// packages/builder/src/vector/marketplace-datum.ts
// Marketplace datum codecs. Field order is the on-chain order (agents-marketplace
// packages/shared/src/cbor/{AdvertDatum,EscrowDatum}.ts). Decoding is lenient and runs on
// Lucid's Data.from. encodeEscrowDatum is a hand-rolled writer whose output is byte-identical
// to the marketplace's cbor-x encoder (pinned against the live datum by
// test/marketplace-datum.test.ts), because escrowLockFloor sizes the Submitted datum from
// these bytes and Lucid's Data.to frames lists and integers more compactly, which under-sizes the lock.
import { Data, Constr, fromText, toText } from '@lucid-evolution/lucid';
import { createHash } from 'node:crypto';

export type AdvertStatus = 'Active' | 'Retired';
export type EscrowState = 'Open' | 'Claimed' | 'Submitted' | 'Accepted' | 'Reclaimed' | 'Released';
export interface OutRef { txHash: string; index: number }

export interface AdvertDatum {
  supplier_pkh: string; capability_id: string; model: string;
  max_output_tokens: number; max_processing_ms: number;
  price_lovelace: bigint; supplier_bond_lovelace: bigint; buyer_bond_lovelace: bigint;
  endpoint_url: string; detail_uri: string; detail_hash: string;
  advertised_at: number; status: AdvertStatus;
}
export interface EscrowDatum {
  buyer_pkh: string; supplier_pkh: string; advert_ref: OutRef; capability_id: string;
  request_spec_hash: string; prompt_hash: string;
  payment_lovelace: bigint; buyer_bond_lovelace: bigint; supplier_bond_lovelace: bigint;
  deliver_by: number; posted_at: number;
  submitted_at: number | null; result_receipt_hash: string | null; state: EscrowState;
}

const STATES: EscrowState[] = ['Open', 'Claimed', 'Submitted', 'Accepted', 'Reclaimed', 'Released'];
const HEX = /^[0-9a-fA-F]+$/;

export function parseOutRef(ref: string): { txHash: string; outputIndex: number } {
  const m = /^([0-9a-fA-F]{64})#(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`Invalid out ref "${ref}": expected <64-hex txid>#<index>`);
  return { txHash: m[1].toLowerCase(), outputIndex: Number(m[2]) };
}
export function formatOutRef(txHash: string, index: number): string { return `${txHash}#${index}`; }

function asConstr(x: unknown, where: string): Constr<Data> {
  if (!(x instanceof Constr)) throw new Error(`${where}: expected constructor`);
  return x;
}
function asBytes(x: unknown, where: string): string {
  if (typeof x !== 'string' || !HEX.test(x) && x !== '') throw new Error(`${where}: expected bytes`);
  return x.toLowerCase();
}
function asInt(x: unknown, where: string): bigint {
  if (typeof x !== 'bigint') throw new Error(`${where}: expected integer`);
  return x;
}
function optionInt(x: unknown, where: string): number | null {
  const c = asConstr(x, where);
  if (c.index === 1) return null;
  if (c.index === 0 && c.fields.length === 1) return Number(asInt(c.fields[0], where));
  throw new Error(`${where}: malformed option`);
}
function optionBytes(x: unknown, where: string): string | null {
  const c = asConstr(x, where);
  if (c.index === 1) return null;
  if (c.index === 0 && c.fields.length === 1) return asBytes(c.fields[0], where);
  throw new Error(`${where}: malformed option`);
}

export function decodeAdvertDatum(hex: string): AdvertDatum {
  const c = asConstr(Data.from(hex), 'advert');
  if (c.index !== 0 || c.fields.length !== 13) throw new Error(`advert: expected Constr 0 with 13 fields, got ${c.index}/${c.fields.length}`);
  const f = c.fields;
  const status = asConstr(f[12], 'advert.status').index;
  if (status !== 0 && status !== 1) throw new Error(`advert.status: unknown tag ${status}`);
  return {
    supplier_pkh: asBytes(f[0], 'advert.supplier_pkh'),
    capability_id: toText(asBytes(f[1], 'advert.capability_id')),
    model: toText(asBytes(f[2], 'advert.model')),
    max_output_tokens: Number(asInt(f[3], 'advert.max_output_tokens')),
    max_processing_ms: Number(asInt(f[4], 'advert.max_processing_ms')),
    price_lovelace: asInt(f[5], 'advert.price'),
    supplier_bond_lovelace: asInt(f[6], 'advert.supplier_bond'),
    buyer_bond_lovelace: asInt(f[7], 'advert.buyer_bond'),
    endpoint_url: toText(asBytes(f[8], 'advert.endpoint_url')),
    detail_uri: toText(asBytes(f[9], 'advert.detail_uri')),
    detail_hash: asBytes(f[10], 'advert.detail_hash'),
    advertised_at: Number(asInt(f[11], 'advert.advertised_at')),
    status: status === 0 ? 'Active' : 'Retired',
  };
}

// Positions of the four bytestring fields decodeAdvertDatum turns into text: capability_id, model, endpoint_url, detail_uri.
const ADVERT_TEXT_FIELDS = [1, 2, 8, 9];

/**
 * True when the advert's four text fields are valid UTF-8 exactly as stored. decodeAdvertDatum reads them with toText,
 * which replaces invalid sequences with U+FFFD and drops a leading BOM, so for such an advert re-encoding the decoded
 * text would not reproduce the on-chain bytes. Takes the raw datum; one that is not a well-formed advert is false.
 */
export function advertTextFieldsRoundTrip(datumHex: string): boolean {
  let parsed: Data;
  try { parsed = Data.from(datumHex); } catch { return false; }
  if (!(parsed instanceof Constr) || parsed.fields.length !== 13) return false;
  const fields = parsed.fields;
  return ADVERT_TEXT_FIELDS.every((i) => {
    const hex = fields[i];
    return typeof hex === 'string' && fromText(toText(hex)) === hex.toLowerCase();
  });
}

export function decodeEscrowDatum(hex: string): EscrowDatum {
  const c = asConstr(Data.from(hex), 'escrow');
  if (c.index !== 0 || c.fields.length !== 14) throw new Error(`escrow: expected Constr 0 with 14 fields, got ${c.index}/${c.fields.length}`);
  const f = c.fields;
  const ref = asConstr(f[2], 'escrow.advert_ref');
  if (ref.index !== 0 || ref.fields.length !== 2) throw new Error('escrow.advert_ref: malformed');
  const stateIdx = asConstr(f[13], 'escrow.state').index;
  const state = STATES[stateIdx];
  if (!state) throw new Error(`escrow.state: unknown tag ${stateIdx}`);
  return {
    buyer_pkh: asBytes(f[0], 'escrow.buyer_pkh'),
    supplier_pkh: asBytes(f[1], 'escrow.supplier_pkh'),
    advert_ref: { txHash: asBytes(ref.fields[0], 'escrow.advert_ref.txHash'), index: Number(asInt(ref.fields[1], 'escrow.advert_ref.index')) },
    capability_id: toText(asBytes(f[3], 'escrow.capability_id')),
    request_spec_hash: asBytes(f[4], 'escrow.request_spec_hash'),
    prompt_hash: asBytes(f[5], 'escrow.prompt_hash'),
    payment_lovelace: asInt(f[6], 'escrow.payment'),
    buyer_bond_lovelace: asInt(f[7], 'escrow.buyer_bond'),
    supplier_bond_lovelace: asInt(f[8], 'escrow.supplier_bond'),
    deliver_by: Number(asInt(f[9], 'escrow.deliver_by')),
    posted_at: Number(asInt(f[10], 'escrow.posted_at')),
    submitted_at: optionInt(f[11], 'escrow.submitted_at'),
    result_receipt_hash: optionBytes(f[12], 'escrow.result_receipt_hash'),
    state,
  };
}

// Hand-rolled writer for the escrow datum, byte-identical to the marketplace's cbor-x encoder:
// definite-length arrays, every integer as 1b + 8 bytes big-endian whatever its magnitude,
// definite bytestrings, Plutus constructors as tag 121 + alternative. Only the shapes an
// escrow datum needs (arrays here always have fewer than 24 fields).
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/;
const byteHex = (n: number): string => n.toString(16).padStart(2, '0');
function cborUint(n: bigint): string {
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError(`datum integer out of uint64 range: ${n}`);
  return '1b' + n.toString(16).padStart(16, '0');
}
function cborBytes(hex: string): string {
  if (!HEX_BYTES.test(hex)) throw new Error('datum bytes: expected even-length hex');
  const n = hex.length / 2;
  if (n >= 65536) throw new RangeError(`datum bytestring too long: ${n} bytes`);
  const head = n < 24 ? byteHex(0x40 + n) : n < 256 ? '58' + byteHex(n) : '59' + byteHex(n >> 8) + byteHex(n & 0xff);
  return head + hex.toLowerCase();
}
const cborConstr = (alt: number, fields: string[]): string => 'd8' + byteHex(0x79 + alt) + byteHex(0x80 + fields.length) + fields.join('');
const some = (field: string): string => cborConstr(0, [field]);
const none = (): string => cborConstr(1, []);

export function encodeEscrowDatum(d: EscrowDatum): string {
  const stateAlt = STATES.indexOf(d.state);
  if (stateAlt < 0) throw new Error(`escrow.state: unknown state "${String(d.state)}"`);
  return cborConstr(0, [
    cborBytes(d.buyer_pkh), cborBytes(d.supplier_pkh),
    cborConstr(0, [cborBytes(d.advert_ref.txHash), cborUint(BigInt(d.advert_ref.index))]),
    cborBytes(fromText(d.capability_id)),
    cborBytes(d.request_spec_hash), cborBytes(d.prompt_hash),
    cborUint(d.payment_lovelace), cborUint(d.buyer_bond_lovelace), cborUint(d.supplier_bond_lovelace),
    cborUint(BigInt(d.deliver_by)), cborUint(BigInt(d.posted_at)),
    d.submitted_at === null ? none() : some(cborUint(BigInt(d.submitted_at))),
    d.result_receipt_hash === null ? none() : some(cborBytes(d.result_receipt_hash)),
    cborConstr(stateAlt, []),
  ]);
}

/** RFC 8785 subset used by the marketplace: sorted keys, NFC strings, no whitespace. */
export function canonicalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' ? v.normalize('NFC') : v;
    if (Array.isArray(v)) return v.map(sort);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[k.normalize('NFC')] = sort(x);
    }
    return out;
  };
  return JSON.stringify(sort(value));
}
export function sha256Utf8Hex(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
export function requestSpecHash(a: Pick<AdvertDatum, 'capability_id' | 'max_output_tokens' | 'model'>): string {
  return sha256Utf8Hex(canonicalize({ capability_id: a.capability_id, max_output_tokens: a.max_output_tokens, model: a.model }));
}
/** The exact bytes a template supplier receives and hashes: the one-element message array. */
export function wirePayloadFor(payload: string): string { return canonicalize([{ content: payload, role: 'user' }]); }
export function promptHashForPayload(payload: string): string { return sha256Utf8Hex(wirePayloadFor(payload)); }

// The min-UTxO floor for the escrow's largest future datum (Submitted). Port of the marketplace's floor (agents-marketplace packages/shared).
// Sized from encodeEscrowDatum, which is byte-identical to the marketplace's encoder, so it matches the marketplace's floor exactly.
const UTXO_COST_PER_BYTE = 4310n;
const OUTPUT_OVERHEAD_BYTES = 160n;
const SAFETY_MARGIN_LOVELACE = 50_000n;
function estimateOutputBytes(datumBytes: number, lovelace: bigint): bigint {
  const addr = 1n + 29n;
  const coin = 1n + (lovelace > 0xffffffffn ? 8n : 4n);
  const datumField = 1n + 2n + 3n + BigInt(datumBytes);
  return addr + coin + datumField + 3n;
}
export function escrowLockFloor(openDatum: EscrowDatum, economicTotal: bigint): bigint {
  const submitted: EscrowDatum = { ...openDatum, submitted_at: openDatum.deliver_by, result_receipt_hash: 'ff'.repeat(32), state: 'Submitted' };
  const datumBytes = encodeEscrowDatum(submitted).length / 2;
  const floor = (OUTPUT_OVERHEAD_BYTES + estimateOutputBytes(datumBytes, economicTotal)) * UTXO_COST_PER_BYTE + SAFETY_MARGIN_LOVELACE;
  return floor > economicTotal ? floor : economicTotal;
}
