// packages/builder/src/vector/marketplace-indexer.ts
// Read-only clients for the public marketplace indexer and Koios utxo_info.
// No supplier URLs are contacted here (that is PR 3's safeFetch).
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { ADVERT_ADDRESS, INDEXER_URL } from './marketplace-constants.js';
import { decodeAdvertDatum, formatOutRef, parseOutRef } from './marketplace-datum.js';
import type { AdvertDatum } from './marketplace-datum.js';

export interface CapabilityRow { capability_id: string; supplier_count: number }
export interface SupplierRow {
  utxo_ref: string; supplier_pkh: string; capability_id: string; model: string;
  max_output_tokens: number; max_processing_ms: number;
  price_lovelace: bigint; supplier_bond_lovelace: bigint; buyer_bond_lovelace: bigint;
  endpoint_url: string; detail_uri: string; detail_hash: string; advertised_at: number;
  status: string; advert_status: string; current_escrow_ref: string | null; last_seen_iso: string | null; created_slot: number;
}
export interface KoiosUtxo {
  tx_hash: string; tx_index: number; address?: string; value: string; is_spent?: boolean;
  inline_datum?: { bytes: string; value?: unknown } | null; datum_hash?: string | null;
  reference_script?: { hash: string; bytes: string; type: string } | null; block_height?: number; block_time?: number;
}
interface Opts { fetchImpl?: typeof fetch; timeoutMs?: number }

// These errors reach tool callers, so they name the operation and the status only: the endpoint URLs are
// operator configuration and a JSON parse failure quotes the start of the response body (same rule as
// formatServiceError in shared/provider.ts).
async function readJson<T>(res: Response, what: string): Promise<T> {
  try { return (await res.json()) as T; } catch { throw new Error(`${what}: response was not valid JSON`); }
}

async function getJson<T>(url: string, opts: Opts, what: string): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, { headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  if (!res.ok) throw new Error(`${what}: indexer answered ${res.status}`);
  return readJson<T>(res, what);
}

async function getList<T>(url: string, opts: Opts, what: string): Promise<T[]> {
  const body = await getJson<unknown>(url, opts, what);
  if (!Array.isArray(body)) throw new Error(`${what}: indexer returned a non-list response`);
  return body as T[];
}

export async function fetchCapabilities(opts: Opts = {}): Promise<CapabilityRow[]> {
  return getList<CapabilityRow>(`${INDEXER_URL}/capabilities`, opts, 'list capabilities');
}

function normaliseSupplier(r: Record<string, unknown>): SupplierRow {
  return {
    ...(r as unknown as SupplierRow),
    price_lovelace: BigInt(String(r.price_lovelace ?? 0)),
    supplier_bond_lovelace: BigInt(String(r.supplier_bond_lovelace ?? 0)),
    buyer_bond_lovelace: BigInt(String(r.buyer_bond_lovelace ?? 0)),
  };
}

export async function fetchSuppliers(opts: Opts & { capability_id?: string; onlyFree?: boolean } = {}): Promise<SupplierRow[]> {
  const raw = await getList<Record<string, unknown>>(`${INDEXER_URL}/suppliers`, opts, 'list suppliers');
  return raw.map(normaliseSupplier)
    .filter((s) => !opts.capability_id || s.capability_id === opts.capability_id)
    .filter((s) => !opts.onlyFree || s.status === 'free')
    .sort((a, b) => (a.price_lovelace < b.price_lovelace ? -1 : a.price_lovelace > b.price_lovelace ? 1 : (b.last_seen_iso ?? '').localeCompare(a.last_seen_iso ?? '')));
}

export async function fetchSupplier(pkh: string, opts: Opts = {}): Promise<SupplierRow | null> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${INDEXER_URL}/suppliers/${pkh}`, { headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get supplier: indexer answered ${res.status}`);
  const body = await readJson<unknown>(res, 'get supplier');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('get supplier: indexer returned a non-object response');
  return normaliseSupplier(body as Record<string, unknown>);
}

/** Koios utxo_info: returns inline datum bytes even for spent outputs. */
export async function koiosUtxoInfo(koiosUrl: string, refs: string[], fetchImpl: typeof fetch = fetch): Promise<KoiosUtxo[]> {
  const base = koiosUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/api/v1/utxo_info`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-mcp-builder' },
    body: JSON.stringify({ _utxo_refs: refs, _extended: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Koios utxo_info answered ${res.status}`);
  const body = await readJson<unknown>(res, 'Koios utxo_info');
  if (!Array.isArray(body)) throw new Error('Koios utxo_info: Koios returned a non-list response');
  return body as KoiosUtxo[];
}

/**
 * Koios tx_info: the payment credentials of a transaction's inputs, lowercase hex. Spending an input at a key address
 * needs that key's witness, so a credential equal to a key hash means that key signed the transaction. The request must
 * set `_inputs`: without it Koios answers with an empty inputs list, which would read as "nobody signed". A ledger
 * transaction always has an input, so an empty or missing list, like a transaction Koios does not know, is an error and
 * never an answer.
 */
export async function koiosTxInputCreds(koiosUrl: string, txHash: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const hash = txHash.toLowerCase();
  const base = koiosUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/api/v1/tx_info`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-mcp-builder' },
    body: JSON.stringify({ _tx_hashes: [hash], _inputs: true, _assets: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Koios tx_info answered ${res.status}`);
  const body = await readJson<unknown>(res, 'Koios tx_info');
  if (!Array.isArray(body)) throw new Error('Koios tx_info: Koios returned a non-list response');
  const tx = body.find((t) => String(t?.tx_hash).toLowerCase() === hash);
  if (!tx) throw new Error('Koios tx_info: transaction not found');
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) throw new Error('Koios tx_info: response has no inputs');
  return tx.inputs.flatMap((i: { payment_addr?: { cred?: unknown } } | null) => {
    const cred = i?.payment_addr?.cred;
    return typeof cred === 'string' ? [cred.toLowerCase()] : [];
  });
}

/** Markdown for the human plus a fenced JSON block the assistant can pass between tools. */
export function withJson(markdown: string, obj: unknown): string {
  const json = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return `${markdown}\n\n\`\`\`json\n${json}\n\`\`\``;
}

export type AdvertRead = { error: string } | { utxo: KoiosUtxo; advert: AdvertDatum; spent: boolean };

// Anyone can lock a UTxO anywhere with a datum that merely parses as an advert (and copies a real supplier_pkh), so an
// advert is genuine only at the advert script address. Problems with the ref come back as text-ready `{ error }`; Koios failures throw.
/** Reads one advert from the ledger and refuses anything that is not genuine; PR 2's post builder reuses it and additionally requires `utxo.is_spent === false`. */
export async function readAdvert(ref: string, fetchImpl: typeof fetch = fetch): Promise<AdvertRead> {
  let parsed: { txHash: string; outputIndex: number };
  try { parsed = parseOutRef(ref); } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  const canonical = formatOutRef(parsed.txHash, parsed.outputIndex);
  const utxos = await koiosUtxoInfo(VECTOR_KOIOS_URL, [canonical], fetchImpl);
  const utxo = utxos.find((u) => String(u?.tx_hash).toLowerCase() === parsed.txHash && u?.tx_index === parsed.outputIndex);
  if (!utxo) return { error: `No UTxO at ${canonical}.` };
  if (utxo.address?.toLowerCase() !== ADVERT_ADDRESS) return { error: `UTxO ${canonical} is not at the advert script address.` };
  const datum = utxo.inline_datum?.bytes;
  let advert: AdvertDatum | null = null;
  let why = '';
  if (datum) {
    try { advert = decodeAdvertDatum(datum); } catch (err) {
      // Refused below. When the decoder names the field it refused (`advert.max_output_tokens: integer outside the safe range`)
      // the caller is told which; those messages are fixed text, whereas anything else it says (CBOR, shape) stays out.
      const message = err instanceof Error ? err.message : '';
      if (/^advert\.\w+: /.test(message)) why = ` ${message}.`;
    }
  }
  if (!advert) return { error: `UTxO ${canonical} does not hold an advert datum.${why}` };
  return { utxo, advert, spent: utxo.is_spent === true };
}
