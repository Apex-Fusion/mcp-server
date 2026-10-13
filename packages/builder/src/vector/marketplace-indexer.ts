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
  tx_hash: string; tx_index: number; address?: string; value: string; is_spent?: boolean; payment_cred?: string;
  inline_datum?: { bytes: string; value?: unknown } | null; datum_hash?: string | null; asset_list?: unknown[];
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

/**
 * POST a JSON payload to a Koios route that answers with a list, and return the list. The failures name the operation and the
 * status only (see readJson): an HTTP error, a body that is not JSON, a body that is not a list.
 */
async function koiosPostList(koiosUrl: string, route: string, payload: unknown, fetchImpl: typeof fetch, query = ''): Promise<unknown[]> {
  const base = koiosUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/api/v1/${route}${query}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-mcp-builder' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Koios ${route} answered ${res.status}`);
  const body = await readJson<unknown>(res, `Koios ${route}`);
  if (!Array.isArray(body)) throw new Error(`Koios ${route}: Koios returned a non-list response`);
  return body;
}

/** Koios utxo_info: returns inline datum bytes even for spent outputs. */
export async function koiosUtxoInfo(koiosUrl: string, refs: string[], fetchImpl: typeof fetch = fetch): Promise<KoiosUtxo[]> {
  return (await koiosPostList(koiosUrl, 'utxo_info', { _utxo_refs: refs, _extended: true }, fetchImpl)) as KoiosUtxo[];
}

/**
 * Koios credential_utxos: the unspent outputs at every address whose payment credential is `paymentCredential` (28 bytes, hex),
 * whatever its stake part. The escrow validator finds the continuation of a Claim or Submit by payment credential alone, so the
 * live escrow can sit at an address that the enterprise address does not cover; only a credential query sees it. Koios pages at
 * 1,000 rows, so the rows are read `pageSize` at a time in a fixed order (tx hash, index) until a short page; keep pageSize below
 * the server's own cap or a capped page would be taken for the last one. `datumContains` (hex) narrows the read on the server to
 * outputs whose inline datum contains it, which keeps a call small however many outputs the credential holds; the caller still
 * checks every row it gets. A row listed on two pages (the set can shift while it is read) is returned once. At most `maxRows`
 * entries are read, counting everything Koios sent whether or not it is a usable row: the last page asked for is cut to what the
 * cap leaves, and a full page that reaches the cap is refused, as it cannot say there is no more. A Koios that sends full pages
 * of junk, or the same page again and again, cannot keep the read going. `pageSize` and `maxRows` must be positive whole numbers.
 * Errors name the operation and the status only.
 */
export async function koiosCredentialUtxos(
  koiosUrl: string, paymentCredential: string, fetchImpl: typeof fetch = fetch,
  opts: { datumContains?: string; pageSize?: number; maxRows?: number } = {},
): Promise<KoiosUtxo[]> {
  const credential = paymentCredential.toLowerCase();
  if (!/^[0-9a-f]{56}$/.test(credential)) throw new Error('The payment credential must be 28 bytes of hex (56 characters).');
  let filter = '';
  if (opts.datumContains !== undefined) {
    if (!/^[0-9a-f]{2,256}$/i.test(opts.datumContains)) throw new Error('The datum slice to look for must be 1 to 128 bytes of hex.');
    filter = `&inline_datum->>bytes=like.*${opts.datumContains.toLowerCase()}*`;
  }
  const pageSize = opts.pageSize ?? 100;
  const maxRows = opts.maxRows ?? 5_000;
  // With a page size below one every page would count as full and add nothing to `read`: the loop below could not end. A cap
  // that is not a finite whole number of at least one is no cap.
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('The page size must be a positive whole number.');
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error('The row limit must be a positive whole number.');
  const rows = new Map<string, KoiosUtxo>(); // by ref, in the order first seen
  let read = 0; // entries Koios has sent so far, which is also where the next page starts
  for (;;) {
    const limit = Math.min(pageSize, maxRows - read); // never ask for more than the cap leaves
    const page = await koiosPostList(koiosUrl, 'credential_utxos', { _payment_credentials: [credential], _extended: true }, fetchImpl, `?order=tx_hash.asc,tx_index.asc&offset=${read}&limit=${limit}${filter}`);
    read += page.length;
    for (const entry of page) {
      const row = entry as Partial<KoiosUtxo> | null;
      if (row === null || typeof row !== 'object' || typeof row.tx_hash !== 'string' || !Number.isInteger(row.tx_index)) continue;
      const ref = `${row.tx_hash.toLowerCase()}#${row.tx_index}`;
      if (!rows.has(ref)) rows.set(ref, row as KoiosUtxo);
    }
    if (page.length < limit) return [...rows.values()];
    if (read >= maxRows) throw new Error(`Koios credential_utxos: ${maxRows} or more outputs matched; refusing to read them all`);
  }
}

// The tx_info call behind koiosTxInputCreds and koiosTxInputRefs. It asks for the inputs and the assets: without `_inputs` Koios
// answers with an empty inputs list, which would read as "spent nothing".
type TxInput = { tx_hash?: unknown; tx_index?: unknown; payment_addr?: { bech32?: unknown; cred?: unknown } } | null;
interface TxInfoRow { tx_hash?: unknown; inputs?: unknown }
async function koiosTxInfo(koiosUrl: string, txHashes: string[], fetchImpl: typeof fetch): Promise<TxInfoRow[]> {
  return (await koiosPostList(koiosUrl, 'tx_info', { _tx_hashes: txHashes, _inputs: true, _assets: true }, fetchImpl)) as TxInfoRow[];
}
/** A ledger transaction always has an input, so a missing or empty list means Koios did not honour `_inputs`: an error, never an answer. */
function inputsOf(tx: TxInfoRow): TxInput[] {
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) throw new Error('Koios tx_info: response has no inputs');
  return tx.inputs as TxInput[];
}

/**
 * Koios tx_info: the payment credentials of a transaction's inputs, lowercase hex. Spending an input at a key address needs that
 * key's witness, so a credential equal to a key hash means that key signed the transaction. A transaction Koios does not know is
 * an error, and never an answer.
 */
export async function koiosTxInputCreds(koiosUrl: string, txHash: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const hash = txHash.toLowerCase();
  const tx = (await koiosTxInfo(koiosUrl, [hash], fetchImpl)).find((t) => String(t?.tx_hash).toLowerCase() === hash);
  if (!tx) throw new Error('Koios tx_info: transaction not found');
  return inputsOf(tx).flatMap((i) => {
    const cred = i?.payment_addr?.cred;
    return typeof cred === 'string' ? [cred.toLowerCase()] : [];
  });
}

/**
 * Koios tx_info for several transactions in ONE request: for each one Koios knows, the refs (`txHash#index`, lowercase) of the
 * outputs it spent. An input's payment credential is the credential of the output it spends, so `atCredential` (hex) narrows the
 * list to the outputs spent at addresses with that credential, whatever their stake part; for a script credential those are the
 * script outputs the transaction consumed, which is how the escrow lineage is read off the chain (the transaction that created
 * an escrow output spent the previous one). A transaction Koios does not know is absent from the map (its answer is unknown, not
 * "spent nothing"); a known one that spent nothing at `atCredential` maps to an empty list. Errors name the operation and the
 * status only.
 */
export async function koiosTxInputRefs(koiosUrl: string, txHashes: string[], fetchImpl: typeof fetch = fetch, atCredential?: string): Promise<Map<string, string[]>> {
  const wanted = new Set(txHashes.map((h) => h.toLowerCase()));
  const refs = new Map<string, string[]>();
  if (wanted.size === 0) return refs;
  const credential = atCredential?.toLowerCase();
  for (const tx of await koiosTxInfo(koiosUrl, [...wanted], fetchImpl)) {
    const hash = String(tx?.tx_hash).toLowerCase();
    if (!wanted.has(hash)) continue;
    refs.set(hash, inputsOf(tx).flatMap((i) => {
      if (credential !== undefined && String(i?.payment_addr?.cred).toLowerCase() !== credential) return [];
      return typeof i?.tx_hash === 'string' && Number.isInteger(i?.tx_index) ? [`${i.tx_hash.toLowerCase()}#${i.tx_index}`] : [];
    }));
  }
  return refs;
}

/** Markdown for the human plus a fenced JSON block the assistant can pass between tools. */
export function withJson(markdown: string, obj: unknown): string {
  const json = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return `${markdown}\n\n\`\`\`json\n${json}\n\`\`\``;
}

export type AdvertRead = { error: string } | { utxo: KoiosUtxo; advert: AdvertDatum; spent: boolean };

// Anyone can lock a UTxO anywhere with a datum that merely parses as an advert (and copies a real supplier_pkh), so a UTxO is
// taken for an advert only at the advert script address. Problems with the ref come back as text-ready `{ error }`; Koios failures throw.
/**
 * Reads one advert from the ledger. It refuses UTxOs that are not at the advert script address or hold no advert datum. That does
 * not make an advert genuine (the advert validator does not check who creates one, so buildPostEscrow also proves authorship) or
 * live: a spent or retired advert is returned too, flagged by `spent` and `advert.status`, and buildPostEscrow requires it unspent.
 * `koiosUrl` is the Koios it asks (the configured one unless a caller that has read other things from a Koios of its own passes that
 * one, so that one decision draws on one source).
 */
export async function readAdvert(ref: string, fetchImpl: typeof fetch = fetch, koiosUrl: string = VECTOR_KOIOS_URL): Promise<AdvertRead> {
  let parsed: { txHash: string; outputIndex: number };
  try { parsed = parseOutRef(ref); } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  const canonical = formatOutRef(parsed.txHash, parsed.outputIndex);
  const utxos = await koiosUtxoInfo(koiosUrl, [canonical], fetchImpl);
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
