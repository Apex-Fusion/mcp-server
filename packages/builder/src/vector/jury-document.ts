// packages/builder/src/vector/jury-document.ts
// Documents on chain (Module-1/jury/SPEC.md Section 10): a UTF-8 document as transaction metadata under label 22084
// ({ v: 1, t: type, m: media type, d: [text chunks] }), its blake2b-256 hash, the `vector-tx:` URI of the transaction that carries
// it, and the reader of a document behind a URI: a `vector-tx:` document from Koios tx_metadata (from the CBOR form of the metadata
// when Koios gives no JSON for it), an https document through safeFetch (the only fetch of URLs that come from chain data). The
// validators do not read metadata; a reader checks the hash.
import { CML } from '@lucid-evolution/lucid';
import { koiosPostList } from './marketplace-indexer.js';
import { safeFetch } from './safe-fetch.js';
import type { SafeFetchOpts } from './safe-fetch.js';
import { blake2b256Hex } from './jury-codec.js';

/** The metadata label of a document (SPEC Section 10.1). */
export const DOCUMENT_LABEL = 22084;
/** The ledger's limit for a metadata text string, in bytes. */
export const CHUNK_MAX_BYTES = 64;
/** The document types of SPEC Section 10.1. Other types are allowed; these are the ones the jury reads. */
export const DOCUMENT_TYPES = ['claim', 'evidence', 'juror-prompt', 'juror-record', 'resolution'] as const;
/** The default media type of a document. */
export const DEFAULT_MEDIA_TYPE = 'application/json';
/**
 * The largest document that one publish transaction carries: the rest of the 16,384-byte transaction holds the body and witnesses. A
 * juror record that does not fit in its reveal is published on its own (SPEC Section 10.4, overflow), so this is also the record limit
 * (SPEC Section 10.4: a record is never larger than 15,000 bytes).
 */
export const MAX_DOCUMENT_BYTES = 15_000;
/** The largest https document that the reader fetches. */
export const MAX_FETCH_BYTES = 262_144;
/** The URI scheme of a document in transaction metadata (SPEC Section 10.2). */
export const URI_PREFIX = 'vector-tx:';
/** Vector mainnet Blockfrost: it gives the CBOR form of the metadata of a transaction (SPEC Section 10.1). */
export const DEFAULT_BLOCKFROST_URL = 'https://blockfrost.vector.mainnet.apexfusion.org';

/**
 * The Blockfrost base URL without trailing slashes: every request appends `/txs/<hash>/metadata/cbor`. Read at call time, not at module
 * load, so a value from the server's .env file applies too.
 */
export function blockfrostUrl(configured: string | undefined = process.env.VECTOR_BLOCKFROST_URL): string {
  return (configured || DEFAULT_BLOCKFROST_URL).replace(/\/+$/, '');
}

/** blake2b-256 of the exact document bytes, as lowercase hex. */
export const documentHash = (bytes: Uint8Array): string => blake2b256Hex(bytes);

/** The text of `bytes`, or an error when they are not valid UTF-8 (a document is a UTF-8 byte string). */
export function utf8Text(bytes: Uint8Array, what = 'The document'): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
    throw new Error(`${what} is not valid UTF-8 text: a document on chain is a UTF-8 byte string (SPEC Section 10.1).`);
  }
}

/** The document bytes of a tool input: exactly one of `text` (UTF-8) and `base64` (the exact bytes). */
export function documentBytes(input: { text?: string; base64?: string }, what = 'document'): Buffer {
  if ((input.text === undefined) === (input.base64 === undefined)) throw new Error(`Give the ${what} once: as text or as base64, not both and not neither.`);
  if (input.text !== undefined) return Buffer.from(input.text, 'utf8');
  const b64 = input.base64!.trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new Error(`The ${what} base64 is not valid base64.`);
  return Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64');
}

/**
 * The text chunks of a document (SPEC Section 10.1): valid UTF-8 of at most 64 bytes each, split only at character boundaries, and no
 * chunk starts with the two characters `0x` (some indexers show byte strings as `0x…` text). Where a chunk would start with `0x`, the
 * chunk before it ends one character earlier; at the start of the document, `0` is a chunk of its own. The chunks joined are the
 * document bytes. The split is the one of the Python library (vector_jury.documents.chunk), so both write the same metadata.
 */
export function chunkDocument(bytes: Uint8Array): string[] {
  const chars = Array.from(utf8Text(bytes));
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    if (chars[start] === '0' && chars[start + 1] === 'x') {
      if (chunks.length === 0) { chunks.push('0'); start += 1; continue; }
      chunks[chunks.length - 1] = Array.from(chunks[chunks.length - 1]).slice(0, -1).join('');
      start -= 1;
    }
    let end = start;
    let size = 0;
    while (end < chars.length) {
      const width = Buffer.byteLength(chars[end], 'utf8');
      if (size + width > CHUNK_MAX_BYTES) break;
      size += width;
      end += 1;
    }
    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

/** The label 22084 value of a document, as Lucid's attachMetadata takes it (a type alias, so that it is a metadata record). */
export type DocumentMetadata = { v: 1; t: string; m: string; d: string[] };

/** Checks a type or media type: 1 to 64 bytes of UTF-8 text (one metadata text string) that does not start with `0x`. */
function shortText(value: string, what: string): string {
  const size = Buffer.byteLength(value, 'utf8');
  if (size < 1 || size > CHUNK_MAX_BYTES) throw new Error(`The ${what} must be 1 to 64 bytes of text.`);
  if (value.startsWith('0x')) throw new Error(`The ${what} must not start with 0x (SPEC Section 10.1).`);
  return value;
}

/**
 * The metadata of a document of `type` and `mediaType`. Refuses an empty document, one over MAX_DOCUMENT_BYTES, text that is not
 * UTF-8, and a document with the character U+0000 or the JSON escape `\u0000` (some indexers drop such metadata, SPEC Section 10.1).
 */
export function documentMetadata(bytes: Uint8Array, type: string, mediaType: string = DEFAULT_MEDIA_TYPE): DocumentMetadata {
  if (bytes.length === 0) throw new Error('The document is empty.');
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`The document has ${bytes.length} bytes; one transaction carries at most ${MAX_DOCUMENT_BYTES}. Publish it elsewhere (an https URI) and give its URI and hash instead.`);
  const text = utf8Text(bytes);
  if (text.includes('\u0000') || text.includes('\\u0000')) throw new Error('The document contains U+0000 or the JSON escape \\u0000, which some chain indexers drop (SPEC Section 10.1); remove it.');
  return { v: 1, t: shortText(type, 'document type'), m: shortText(mediaType, 'media type'), d: chunkDocument(bytes) };
}

/** A document read back from the metadata of a transaction. */
export interface MetadataDocument { type: string; mediaType: string; bytes: Buffer; chunks: number }

/** Is `value` a JSON object (not null, not a list)? */
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The document of a label 22084 value as Koios (db-sync) shows it: JSON without schema. Each chunk must be text of at most 64 bytes
 * that does not start with `0x`: such a chunk is a byte string in that JSON, which a writer of SPEC Section 10.1 never writes. The
 * checks are those of the Python reader (vector_jury.documents.parse_metadata), so both read the same documents.
 */
export function documentFromMetadata(value: unknown): MetadataDocument {
  if (!isObject(value)) throw new Error('The label 22084 metadata is not an object { v, t, m, d }.');
  if (value.v !== 1) throw new Error(`The label 22084 metadata has version ${JSON.stringify(value.v)}; this reader knows version 1 (SPEC Section 10.1).`);
  if (typeof value.t !== 'string' || typeof value.m !== 'string') throw new Error('The label 22084 metadata has no text type (t) or media type (m).');
  if (value.t.startsWith('0x') || value.m.startsWith('0x')) throw new Error('The type (t) or the media type (m) of the label 22084 metadata starts with 0x, so the transaction carries no document (SPEC Section 10.1).');
  if (!Array.isArray(value.d)) throw new Error('The label 22084 metadata has no list of chunks (d).');
  const parts = value.d.map((chunk: unknown, i: number) => {
    if (typeof chunk !== 'string') throw new Error(`Chunk ${i} of the label 22084 metadata is not text.`);
    const raw = Buffer.from(chunk, 'utf8');
    if (raw.length > CHUNK_MAX_BYTES) throw new Error(`Chunk ${i} of the label 22084 metadata has ${raw.length} bytes, more than ${CHUNK_MAX_BYTES}.`);
    if (chunk.startsWith('0x')) throw new Error(`Chunk ${i} of the label 22084 metadata starts with 0x: it is a byte string or ambiguous, and SPEC Section 10.1 allows only text chunks that do not start with 0x.`);
    return raw;
  });
  return { type: value.t, mediaType: value.m, bytes: Buffer.concat(parts), chunks: parts.length };
}

// ─── URI (SPEC Section 10.2) ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `vector-tx:` and the unpadded base64url of the 32-byte transaction id: 53 bytes. */
export function documentUri(txHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(txHash)) throw new Error('A transaction id is 64 lowercase hex characters.');
  return `${URI_PREFIX}${Buffer.from(txHash, 'hex').toString('base64url')}`;
}

/** The transaction id of a `vector-tx:` URI, or null for another scheme. A `vector-tx:` URI that does not hold 32 bytes is an error. */
export function txHashOfUri(uri: string): string | null {
  if (!uri.startsWith(URI_PREFIX)) return null;
  const body = uri.slice(URI_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(body)) throw new Error(`${JSON.stringify(uri.slice(0, 80))} is not a vector-tx URI: expected vector-tx: and 43 base64url characters (a 32-byte transaction id).`);
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== body) throw new Error(`${JSON.stringify(uri.slice(0, 80))} does not encode a 32-byte transaction id.`);
  return bytes.toString('hex');
}

// ─── Reader ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FetchedDocument {
  uri: string;
  source: 'metadata' | 'https';
  /** The transaction that carries the document (vector-tx only). */
  txHash: string | null;
  type: string | null;
  mediaType: string | null;
  bytes: Buffer;
  hash: string;
  warnings: string[];
}

export interface DocumentReadOpts { koiosUrl: string; blockfrostUrl?: string; fetchImpl?: typeof fetch; safeFetchOpts?: SafeFetchOpts }

// ─── CBOR form (SPEC Section 10.1: "When an indexer gives no JSON for the metadata, readers use the CBOR form") ──────────────────

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A label 22084 metadatum as Koios (db-sync) shows it: JSON without schema, in which a byte string is the text `0x…`. A document read
 * from CBOR then goes through documentFromMetadata like one read from a Koios answer: the same checks, the same refusals.
 */
function koiosJson(metadatum: CML.TransactionMetadatum, txHash: string): unknown {
  try { return JSON.parse(CML.decode_metadatum_to_json_str(metadatum, CML.MetadataJsonSchema.BasicConversions)); } catch (err) {
    throw new Error(`The label ${DOCUMENT_LABEL} metadata in the CBOR of the transaction ${txHash} cannot be read (${errorText(err)}).`);
  }
}

/** The label 22084 value in the CBOR of a whole transaction (hex), as Koios shows it; undefined when the transaction has no such label. */
function labelOfTransaction(cborHex: string, txHash: string): unknown {
  let metadatum: CML.TransactionMetadatum | undefined;
  try { metadatum = CML.Transaction.from_cbor_hex(cborHex).auxiliary_data()?.metadata()?.get(BigInt(DOCUMENT_LABEL)); } catch (err) {
    throw new Error(`The CBOR of the transaction ${txHash} does not decode (${errorText(err)}).`);
  }
  return metadatum === undefined ? undefined : koiosJson(metadatum, txHash);
}

/**
 * The label 22084 value in the CBOR metadata that Blockfrost gives for the label (hex): the metadata map `{ 22084: value }`, as Vector's
 * Blockfrost writes it, or the value alone (the Python reader takes both).
 */
function labelOfMetadata(cborHex: string, txHash: string): unknown {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(cborHex)) throw new Error(`The CBOR metadata of the transaction ${txHash} is not hex.`);
  let metadatum: CML.TransactionMetadatum;
  try {
    const decoded = CML.TransactionMetadatum.from_cbor_bytes(Buffer.from(cborHex, 'hex'));
    const labelled = decoded.kind() === CML.TransactionMetadatumKind.Map
      ? decoded.as_map()?.get(CML.TransactionMetadatum.new_int(CML.Int.new(BigInt(DOCUMENT_LABEL))))
      : undefined;
    metadatum = labelled ?? decoded;
  } catch (err) {
    throw new Error(`The CBOR metadata of the transaction ${txHash} does not decode (${errorText(err)}).`);
  }
  return koiosJson(metadatum, txHash);
}

/** The CBOR (hex) of a whole transaction from Koios tx_cbor. Vector's Koios keeps none: it answers `cbor: null`. */
async function koiosTransactionCbor(txHash: string, opts: DocumentReadOpts): Promise<string> {
  const rows = await koiosPostList(opts.koiosUrl, 'tx_cbor', { _tx_hashes: [txHash] }, opts.fetchImpl ?? fetch);
  const row = rows.find((r) => isObject(r) && typeof r.tx_hash === 'string' && r.tx_hash.toLowerCase() === txHash);
  if (!isObject(row) || typeof row.cbor !== 'string' || row.cbor === '') throw new Error('Koios keeps no CBOR of the transaction');
  return row.cbor;
}

/**
 * The CBOR (hex) of the label 22084 metadata from Blockfrost `/txs/{hash}/metadata/cbor`: a list of `{ label, metadata, cbor_metadata }`,
 * where `cbor_metadata` holds the same hex behind the prefix `\x`. Null when Blockfrost lists no such label for the transaction. The
 * errors do not name the URL: it is operator configuration.
 */
async function blockfrostLabelCbor(txHash: string, opts: DocumentReadOpts): Promise<string | null> {
  let res: { status: number; text: string };
  try {
    res = await safeFetch(`${blockfrostUrl(opts.blockfrostUrl)}/txs/${txHash}/metadata/cbor`, { headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' } },
      { maxResponseBytes: MAX_FETCH_BYTES, timeoutMs: 15_000, ...opts.safeFetchOpts });
  } catch { throw new Error('Blockfrost could not be read (network error, timeout or a refused answer)'); }
  if (res.status !== 200) throw new Error(`Blockfrost answered ${res.status}`);
  let rows: unknown;
  try { rows = JSON.parse(res.text); } catch { throw new Error('Blockfrost answered something that is not JSON'); }
  if (!Array.isArray(rows)) throw new Error('Blockfrost answered something that is not a list');
  const row = rows.find((r) => isObject(r) && String(r.label) === String(DOCUMENT_LABEL));
  if (!isObject(row)) return null;
  const hex = [row.metadata, row.cbor_metadata].find((v): v is string => typeof v === 'string' && v !== '');
  if (hex === undefined) throw new Error(`Blockfrost lists the label ${DOCUMENT_LABEL} without its CBOR`);
  return hex.replace(/^\\x/, '');
}

/**
 * The label 22084 value of a transaction for which Koios gives no JSON, as Koios would show it; undefined when the CBOR says that the
 * transaction has no such label. Koios tx_cbor comes first, then Blockfrost, as in the Python reader (vector_jury.documents.read_document).
 * A CBOR that does not decode is an error, and so is a transaction whose CBOR neither source gives.
 */
async function labelFromCbor(txHash: string, opts: DocumentReadOpts): Promise<unknown> {
  const failures: string[] = [];
  let transaction: string | undefined;
  try { transaction = await koiosTransactionCbor(txHash, opts); } catch (err) { failures.push(errorText(err)); }
  if (transaction !== undefined) return labelOfTransaction(transaction, txHash);
  let metadata: string | null | undefined;
  try { metadata = await blockfrostLabelCbor(txHash, opts); } catch (err) { failures.push(errorText(err)); }
  if (metadata === null) return undefined;
  if (metadata !== undefined) return labelOfMetadata(metadata, txHash);
  throw new Error(`Koios gives no JSON for the label ${DOCUMENT_LABEL} metadata of the transaction ${txHash}, and its CBOR form cannot be read (${failures.join('; ')}). Retry later: the transaction may carry a document that the indexers do not give now.`);
}

/**
 * Reads the document behind `uri`: a `vector-tx:` URI from the label 22084 metadata of its transaction (Koios tx_metadata; when Koios
 * gives no JSON for the label, from its CBOR form: Koios tx_cbor, then Blockfrost), an https URI by fetch (no redirects, private hosts
 * refused, at most MAX_FETCH_BYTES). Other schemes are refused.
 */
export async function readDocument(uri: string, opts: DocumentReadOpts): Promise<FetchedDocument> {
  const value = uri.trim();
  const txHash = txHashOfUri(value);
  if (txHash !== null) {
    const rows = await koiosPostList(opts.koiosUrl, 'tx_metadata', { _tx_hashes: [txHash] }, opts.fetchImpl ?? fetch);
    const row = rows.find((r) => isObject(r) && typeof r.tx_hash === 'string' && r.tx_hash.toLowerCase() === txHash);
    if (!isObject(row)) throw new Error(`Koios does not know the transaction ${txHash}: it is not confirmed yet, or it does not exist.`);
    let label: unknown = isObject(row.metadata) ? row.metadata[String(DOCUMENT_LABEL)] : undefined;
    // No JSON for the label: db-sync leaves out the metadata of some transactions (a document with U+0000 is one). The CBOR form says what the transaction carries.
    if (label === undefined || label === null) label = await labelFromCbor(txHash, opts);
    if (label === undefined) throw new Error(`The transaction ${txHash} has no label ${DOCUMENT_LABEL} metadata, so it carries no document.`);
    const doc = documentFromMetadata(label);
    return { uri: value, source: 'metadata', txHash, type: doc.type, mediaType: doc.mediaType, bytes: doc.bytes, hash: documentHash(doc.bytes), warnings: [] };
  }
  if (!value.startsWith('https://')) throw new Error(`${JSON.stringify(value.slice(0, 80))} is not a vector-tx: or https:// URI; this reader reads only those.`);
  const res = await safeFetch(value, { headers: { accept: '*/*', 'user-agent': 'vector-mcp-builder' } }, { maxResponseBytes: MAX_FETCH_BYTES, timeoutMs: 20_000, ...opts.safeFetchOpts });
  if (res.status !== 200) throw new Error(`The document host answered HTTP ${res.status}.`);
  // safeFetch decodes the body as UTF-8; a document is UTF-8 text, so its bytes come back exactly. A body that is not UTF-8 shows as a mismatch.
  const bytes = Buffer.from(res.text, 'utf8');
  const warnings = res.text.includes('\ufffd') ? ['the body holds U+FFFD: if the document is not UTF-8, its hash differs from the hash of the bytes on the host'] : [];
  return { uri: value, source: 'https', txHash: null, type: null, mediaType: res.headers.get('content-type'), bytes, hash: documentHash(bytes), warnings };
}
