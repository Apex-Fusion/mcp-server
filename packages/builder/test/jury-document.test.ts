// packages/builder/test/jury-document.test.ts
// Documents on chain (Module-1 jury SPEC Section 10): the chunks against the Python library (fixtures/jury-python-vectors.json), the
// chunk rules over many documents, the metadata both ways, the vector-tx URI, and the reader with a fake Koios, a fake Blockfrost and a
// fake host: the JSON form of the metadata, the CBOR form for a transaction for which Koios gives no JSON (real answers of Vector
// mainnet in fixtures/jury-document-mainnet.json), and the refusals. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CML } from '@lucid-evolution/lucid';
import { lucidForAddress } from '../src/vector/build.ts';
import { buildDocumentPublish } from '../src/vector/jury-build.ts';
import {
  CHUNK_MAX_BYTES, DEFAULT_BLOCKFROST_URL, blockfrostUrl, chunkDocument, documentBytes, documentFromMetadata, documentHash, documentMetadata, documentUri,
  readDocument, txHashOfUri,
} from '../src/vector/jury-document.ts';
import type { DocumentReadOpts } from '../src/vector/jury-document.ts';
import { NOW, WALLET_ADDRESS, juryWorld } from './fixtures/jury-world.ts';

const V = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/jury-python-vectors.json'), 'utf8'));

/** A deterministic text of `n` characters from a set with ASCII, 2-, 3- and 4-byte characters, and many `0` and `x`. */
function textOf(seed: number, n: number): string {
  const set = ['0', 'x', '0', 'x', 'a', ' ', '{', '"', 'é', '€', '😀', '\n', 'ß', '0x'];
  let s = seed;
  let out = '';
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) % 2147483648; out += set[s % set.length]; }
  return out;
}

describe('chunks (SPEC Section 10.1)', () => {
  test('the chunks are those of the Python library (vector_jury.documents.chunk)', () => {
    for (const [name, input] of Object.entries(V.chunk_inputs as Record<string, string>)) {
      assert.deepEqual(chunkDocument(Buffer.from(input, 'utf8')), V.chunks[name], name);
    }
  });

  test('over many documents: at most 64 bytes, whole characters, no chunk starts with 0x, and the chunks join to the document', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const text = textOf(seed, 1 + (seed * 37) % 400);
      const chunks = chunkDocument(Buffer.from(text, 'utf8'));
      assert.equal(chunks.join(''), text);
      for (const c of chunks) {
        assert.ok(Buffer.byteLength(c, 'utf8') <= CHUNK_MAX_BYTES && c.length > 0, `chunk ${JSON.stringify(c)} of seed ${seed}`);
        assert.ok(!c.startsWith('0x'), `chunk ${JSON.stringify(c)} of seed ${seed} starts with 0x`);
        assert.equal(Buffer.from(Buffer.from(c, 'utf8').toString('utf8'), 'utf8').toString('utf8'), c);
      }
    }
  });

  test('bytes that are not UTF-8 are refused', () => {
    assert.throws(() => chunkDocument(Buffer.from([0x61, 0xff, 0x62])), /not valid UTF-8 text/);
  });
});

describe('metadata', () => {
  test('a document becomes { v: 1, t, m, d } and reads back to the same bytes', () => {
    const doc = Buffer.from(JSON.stringify({ claim: 'x'.repeat(150), note: '0x00 é€😀' }), 'utf8');
    const meta = documentMetadata(doc, 'claim');
    assert.deepEqual({ v: meta.v, t: meta.t, m: meta.m }, { v: 1, t: 'claim', m: 'application/json' });
    const back = documentFromMetadata(JSON.parse(JSON.stringify(meta)));
    assert.deepEqual(back.bytes, doc);
    assert.equal(documentHash(back.bytes), documentHash(doc));
    assert.equal(back.chunks, meta.d.length);
  });

  test('the writer refuses an empty document, one that is too large, and a type or media type that the rules forbid', () => {
    assert.throws(() => documentMetadata(Buffer.alloc(0), 'claim'), /The document is empty/);
    assert.throws(() => documentMetadata(Buffer.alloc(15_001, 0x61), 'claim'), /has 15001 bytes; one transaction carries at most 15000/);
    assert.throws(() => documentMetadata(Buffer.from('{}'), '0xclaim'), /document type must not start with 0x/);
    assert.throws(() => documentMetadata(Buffer.from('{}'), 'claim', 'm'.repeat(65)), /media type must be 1 to 64 bytes/);
  });

  test('the reader refuses what the Python reader refuses', () => {
    const ok = { v: 1, t: 'claim', m: 'application/json', d: ['{"a":', '1}'] };
    assert.equal(documentFromMetadata(ok).bytes.toString(), '{"a":1}');
    assert.equal(documentFromMetadata({ ...ok, d: [] }).bytes.length, 0);
    assert.throws(() => documentFromMetadata({ ...ok, d: ['0xab'] }), /Chunk 0 of the label 22084 metadata starts with 0x/);
    assert.throws(() => documentFromMetadata({ ...ok, d: ['é'.repeat(33)] }), /has 66 bytes, more than 64/);
    assert.throws(() => documentFromMetadata({ ...ok, v: true }), /has version true/);
    assert.throws(() => documentFromMetadata({ ...ok, d: 'abc' }), /no list of chunks/);
    assert.throws(() => documentFromMetadata({ ...ok, t: 7 }), /no text type/);
  });
});

describe('vector-tx URI (SPEC Section 10.2)', () => {
  test('the URI is the unpadded base64url of the transaction id, as the Python library writes it', () => {
    assert.equal(documentUri(`72ef1290${'00'.repeat(28)}`), 'vector-tx:cu8SkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const id = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('hex');
    assert.equal(documentUri(id), 'vector-tx:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    assert.equal(documentUri(id).length, 53);
    assert.equal(txHashOfUri(documentUri(id)), id);
  });

  test('a URI that is not canonical or not 32 bytes is refused; another scheme is not a vector-tx URI', () => {
    assert.throws(() => txHashOfUri('vector-tx:cu8SkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB'), /does not encode a 32-byte transaction id/);
    assert.throws(() => txHashOfUri('vector-tx:cu8Sk'), /is not a vector-tx URI/);
    assert.equal(txHashOfUri('https://example.org/doc.json'), null);
  });
});

describe('document input', () => {
  test('text or base64, exactly one', () => {
    assert.deepEqual(documentBytes({ text: 'héllo' }), Buffer.from('héllo', 'utf8'));
    assert.deepEqual(documentBytes({ base64: Buffer.from('a\r\nb').toString('base64') }), Buffer.from('a\r\nb'));
    assert.throws(() => documentBytes({ text: 'a', base64: 'YQ==' }), /not both and not neither/);
    assert.throws(() => documentBytes({}), /not both and not neither/);
    assert.throws(() => documentBytes({ base64: 'not base64!' }), /not valid base64/);
  });
});

describe('readDocument', () => {
  const doc = Buffer.from('{"type":"claim","text":"The agent ran 10 audits."}', 'utf8');
  const txHash = 'ab'.repeat(32);
  const koios = (rows: unknown[]) => (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://koios.test/api/v1/tx_metadata');
    assert.deepEqual(JSON.parse(String(init?.body)), { _tx_hashes: [txHash] });
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  test('a vector-tx document comes from the label 22084 metadata of its transaction', async () => {
    const fetched = await readDocument(documentUri(txHash), { koiosUrl: 'https://koios.test', fetchImpl: koios([{ tx_hash: txHash, metadata: { 22084: documentMetadata(doc, 'claim') } }]) });
    assert.deepEqual(fetched.bytes, doc);
    assert.equal(fetched.hash, documentHash(doc));
    assert.equal(fetched.type, 'claim');
    assert.equal(fetched.txHash, txHash);
  });

  test('a transaction that Koios does not know is an error', async () => {
    await assert.rejects(readDocument(documentUri(txHash), { koiosUrl: 'https://koios.test', fetchImpl: koios([]) }), /Koios does not know the transaction/);
  });

  test('an https document is fetched through safeFetch; other schemes are refused', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const host = (status: number) => (async () => new Response(doc, { status })) as unknown as typeof fetch;
    const fetched = await readDocument('https://docs.example/claim.json', { koiosUrl: 'https://koios.test', safeFetchOpts: { lookup, fetchImpl: host(200) } });
    assert.equal(fetched.hash, documentHash(doc));
    assert.equal(fetched.source, 'https');
    await assert.rejects(readDocument('https://docs.example/claim.json', { koiosUrl: 'https://koios.test', safeFetchOpts: { lookup, fetchImpl: host(404) } }), /answered HTTP 404/);
    await assert.rejects(readDocument('http://docs.example/claim.json', { koiosUrl: 'https://koios.test' }), /is not a vector-tx: or https:\/\/ URI/);
    await assert.rejects(readDocument('https://127.0.0.1/claim.json', { koiosUrl: 'https://koios.test' }), /private or reserved address/);
  });
});

/** The CBOR metadatum of a JSON-like value: a number is an int, a string text, a Uint8Array a byte string, an array a list, an object a map with text keys. */
function metadatumOf(value: unknown): CML.TransactionMetadatum {
  if (typeof value === 'number') return CML.TransactionMetadatum.new_int(CML.Int.new(BigInt(value)));
  if (typeof value === 'string') return CML.TransactionMetadatum.new_text(value);
  if (value instanceof Uint8Array) return CML.TransactionMetadatum.new_bytes(value);
  if (Array.isArray(value)) {
    const list = CML.MetadatumList.new();
    for (const item of value) list.add(metadatumOf(item));
    return CML.TransactionMetadatum.new_list(list);
  }
  const map = CML.MetadatumMap.new();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) map.set(CML.TransactionMetadatum.new_text(key), metadatumOf(item));
  return CML.TransactionMetadatum.new_map(map);
}
/** The CBOR (hex) of the metadata map `{ 22084: value }`, the form that Vector's Blockfrost gives for the label. */
function labelMapCbor(value: unknown): string {
  const map = CML.MetadatumMap.new();
  map.set(CML.TransactionMetadatum.new_int(CML.Int.new(22084n)), metadatumOf(value));
  return Buffer.from(CML.TransactionMetadatum.new_map(map).to_cbor_bytes()).toString('hex');
}

describe('readDocument: the CBOR form, for a transaction for which Koios gives no JSON (SPEC Section 10.1)', () => {
  // Real answers of Vector mainnet for one claim document: Koios tx_metadata (JSON) and Blockfrost /txs/{hash}/metadata/cbor (CBOR).
  const REAL = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/jury-document-mainnet.json'), 'utf8'));
  const KOIOS = 'https://koios.test/api/v1';
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  interface Indexers {
    /** The rows of Koios tx_metadata. Default: the transaction is known and Koios gives no metadata for it. */
    metadata?: unknown[];
    /** Koios tx_cbor: its rows, or an HTTP status. Default: the row of Vector's Koios, which keeps no CBOR (`cbor: null`). */
    cbor?: unknown[] | number;
    /** Blockfrost: its list of labels, an HTTP status, or 'refused' for a connection that fails. Default: a transaction with no label. */
    blockfrost?: unknown[] | number | 'refused';
  }

  /** A fake Koios and a fake Blockfrost for one transaction. `calls` lists the URLs that were asked, in order. */
  function indexers(txHash: string, o: Indexers = {}) {
    const calls: string[] = [];
    const answer = (x: unknown[] | number) => (typeof x === 'number' ? new Response('error', { status: x }) : new Response(JSON.stringify(x), { status: 200 }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u === `${KOIOS}/tx_metadata`) return answer(o.metadata ?? [{ tx_hash: txHash, metadata: null }]);
      if (u === `${KOIOS}/tx_cbor`) return answer(o.cbor ?? [{ tx_hash: txHash, cbor: null }]);
      if (u.endsWith(`/txs/${txHash}/metadata/cbor`)) {
        if (o.blockfrost === 'refused') throw new Error('connect ECONNREFUSED 10.0.0.7:443');
        return answer(o.blockfrost ?? []);
      }
      throw new Error(`unexpected request to ${u}`);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const blockfrostAt = (txHash: string, base = 'https://blockfrost.test') => `${base}/txs/${txHash}/metadata/cbor`;
  const read = (txHash: string, f: typeof fetch, extra: Partial<DocumentReadOpts> = {}) => readDocument(documentUri(txHash), {
    koiosUrl: 'https://koios.test', blockfrostUrl: 'https://blockfrost.test/', fetchImpl: f, safeFetchOpts: { lookup, fetchImpl: f }, ...extra,
  });

  test('the CBOR of Blockfrost gives the document that the JSON of Koios gives (real answers of Vector mainnet)', async () => {
    const tx: string = REAL.txHash;
    const viaJson = await read(tx, indexers(tx, { metadata: REAL.koios }).fetchImpl);
    assert.equal(viaJson.hash, REAL.documentHash);
    assert.equal(viaJson.type, 'claim');
    assert.equal(viaJson.bytes.length, 385);
    const cases: Array<[string, unknown]> = [['no metadata', null], ['no label 22084', { 674: { msg: ['x'] } }], ['label 22084 without JSON', { 22084: null }]];
    for (const [why, metadata] of cases) {
      const f = indexers(tx, { metadata: [{ tx_hash: tx, metadata }], blockfrost: REAL.blockfrost });
      const viaCbor = await read(tx, f.fetchImpl);
      assert.deepEqual(viaCbor.bytes, viaJson.bytes, why);
      assert.equal(viaCbor.hash, REAL.documentHash, why);
      assert.deepEqual([viaCbor.type, viaCbor.mediaType, viaCbor.source, viaCbor.txHash], ['claim', 'application/json', 'metadata', tx], why);
      assert.deepEqual(f.calls, [`${KOIOS}/tx_metadata`, `${KOIOS}/tx_cbor`, blockfrostAt(tx)], why);
    }
  });

  test('Blockfrost gives the hex as `metadata`, and behind the prefix \\x as `cbor_metadata`: either is read', async () => {
    const tx: string = REAL.txHash;
    const [row] = REAL.blockfrost;
    assert.equal(row.cbor_metadata, `\\x${row.metadata}`);
    const other = { label: '674', metadata: 'a0' };
    for (const mine of [{ label: '22084', metadata: row.metadata }, { label: '22084', cbor_metadata: row.cbor_metadata }, { label: 22084, metadata: null, cbor_metadata: row.cbor_metadata }]) {
      const fetched = await read(tx, indexers(tx, { blockfrost: [other, mine] }).fetchImpl);
      assert.equal(fetched.hash, REAL.documentHash);
    }
  });

  test('the CBOR of the label value alone is read as well (the Python reader takes both forms)', async () => {
    const tx = 'cd'.repeat(32);
    const doc = Buffer.from('{"type":"evidence","text":"ok"}', 'utf8');
    const alone = Buffer.from(metadatumOf(documentMetadata(doc, 'evidence')).to_cbor_bytes()).toString('hex');
    const fetched = await read(tx, indexers(tx, { blockfrost: [{ label: '22084', metadata: alone }] }).fetchImpl);
    assert.deepEqual(fetched.bytes, doc);
    assert.equal(fetched.type, 'evidence');
  });

  test('Koios tx_cbor gives the whole transaction: its label 22084 metadata is the document, and Blockfrost is not asked', async () => {
    const provider = juryWorld();
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const doc = Buffer.from(JSON.stringify({ type: 'evidence', text: 'The run took 12 s. '.repeat(20), hex: '0xab00' }), 'utf8');
    const built = await buildDocumentPublish(lucid, provider, { changeAddress: WALLET_ADDRESS, bytes: doc, type: 'evidence', nowMs: NOW });
    const f = indexers(built.txHash, { cbor: [{ tx_hash: built.txHash, cbor: built.txCbor }] });
    const fetched = await read(built.txHash, f.fetchImpl);
    assert.deepEqual(fetched.bytes, doc);
    assert.equal(fetched.hash, documentHash(doc));
    assert.equal(fetched.type, 'evidence');
    assert.deepEqual(f.calls, [`${KOIOS}/tx_metadata`, `${KOIOS}/tx_cbor`]);
  });

  test('a transaction without label 22084 metadata carries no document, whichever CBOR says so', async () => {
    const provider = juryWorld();
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const withOther = await lucid.newTx().attachMetadata(674, { msg: ['no document here'] }).pay.ToAddress(WALLET_ADDRESS, { lovelace: 2_000_000n }).complete();
    const withNone = await lucid.newTx().pay.ToAddress(WALLET_ADDRESS, { lovelace: 2_000_000n }).complete();
    const noLabel = /has no label 22084 metadata, so it carries no document/;
    // The whole transaction from Koios tx_cbor: with other metadata, and with none.
    for (const built of [withOther, withNone]) {
      const tx = built.toHash();
      const f = indexers(tx, { cbor: [{ tx_hash: tx, cbor: built.toCBOR() }] });
      await assert.rejects(read(tx, f.fetchImpl), noLabel);
      assert.deepEqual(f.calls, [`${KOIOS}/tx_metadata`, `${KOIOS}/tx_cbor`]);
    }
    // Vector's Koios keeps no CBOR; Blockfrost lists no label 22084: an empty list, or other labels only.
    const tx = 'ab'.repeat(32);
    for (const blockfrost of [[], [{ label: '674', metadata: 'a0' }]]) {
      const f = indexers(tx, { metadata: [{ tx_hash: tx, metadata: { 674: { msg: ['x'] } } }], blockfrost });
      await assert.rejects(read(tx, f.fetchImpl), noLabel);
      assert.deepEqual(f.calls, [`${KOIOS}/tx_metadata`, `${KOIOS}/tx_cbor`, blockfrostAt(tx)]);
    }
  });

  test('when neither source gives the CBOR, the error says why, and it names no URL and no answer', async () => {
    const tx = 'ab'.repeat(32);
    const refusals: Array<[Indexers, RegExp]> = [
      [{ cbor: 404, blockfrost: 503 }, /its CBOR form cannot be read \(Koios tx_cbor answered 404; Blockfrost answered 503\)/],
      [{ blockfrost: 404 }, /its CBOR form cannot be read \(Koios keeps no CBOR of the transaction; Blockfrost answered 404\)/],
      [{ blockfrost: 'refused' }, /its CBOR form cannot be read \(Koios keeps no CBOR of the transaction; Blockfrost could not be read \(network error, timeout or a refused answer\)\)/],
      [{ blockfrost: [{ label: '22084', metadata: null, cbor_metadata: null }] }, /Blockfrost lists the label 22084 without its CBOR/],
    ];
    for (const [o, expected] of refusals) {
      await assert.rejects(read(tx, indexers(tx, o).fetchImpl), (err: Error) => {
        assert.match(err.message, expected);
        assert.match(err.message, /^Koios gives no JSON for the label 22084 metadata of the transaction /);
        assert.doesNotMatch(err.message, /blockfrost\.test|koios\.test|10\.0\.0\.7|ECONNREFUSED/);
        return true;
      });
    }
  });

  test('a CBOR that does not decode, and a label value that is not a document, are errors', async () => {
    const tx = 'ab'.repeat(32);
    const good = { v: 1, t: 'claim', m: 'application/json', d: ['{"a":', '1}'] };
    const chunks = (d: unknown) => ({ ...good, d });
    const cases: Array<[string, string, RegExp]> = [
      ['a byte string chunk', labelMapCbor(chunks(['ok', new Uint8Array([0xab, 0xcd])])), /Chunk 1 of the label 22084 metadata starts with 0x/],
      ['a chunk that starts with 0x', labelMapCbor(chunks(['0xab'])), /Chunk 0 of the label 22084 metadata starts with 0x/],
      // CML refuses to build a text of more than 64 bytes (and to decode one), so the CBOR is written by hand: { 22084: { v: 1, t: "claim", m: "application/json", d: ["a" x 65] } }.
      ['a chunk of 65 bytes', `a1195644a4617601617465636c61696d616d706170706c69636174696f6e2f6a736f6e6164817841${'61'.repeat(65)}`, /does not decode/],
      ['a chunk that is not text', labelMapCbor(chunks([7])), /Chunk 0 of the label 22084 metadata is not text/],
      ['chunks that are not a list', labelMapCbor(chunks('abc')), /has no list of chunks/],
      ['version 2', labelMapCbor({ ...good, v: 2 }), /has version 2/],
      ['a text version', labelMapCbor({ ...good, v: '1' }), /has version "1"/],
      ['a type that starts with 0x', labelMapCbor({ ...good, t: '0xclaim' }), /starts with 0x, so the transaction carries no document/],
      ['a media type that is not text', labelMapCbor({ ...good, m: 5 }), /has no text type \(t\) or media type \(m\)/],
      ['a value that is not a map', labelMapCbor(['v', 1]), /is not an object/],
      // The map key `__proto__` must not put a document in the prototype of the value (JSON.parse makes it an own property).
      ['a document under the key __proto__', labelMapCbor(JSON.parse(`{"__proto__":${JSON.stringify(good)}}`)), /has version undefined/],
      ['hex that is not hex', 'zz', /is not hex/],
      ['CBOR that stops', 'a1195644a4', /does not decode/],
      ['a break code', 'ff', /does not decode/],
    ];
    for (const [why, metadata, expected] of cases) {
      await assert.rejects(read(tx, indexers(tx, { blockfrost: [{ label: '22084', metadata }] }).fetchImpl), expected, why);
    }
  });

  test('a bad value ends the read at the first source that has it, and a bad JSON value is not replaced by the CBOR', async () => {
    const tx = 'ab'.repeat(32);
    const koiosCbor = indexers(tx, { cbor: [{ tx_hash: tx, cbor: '00' }], blockfrost: REAL.blockfrost });
    await assert.rejects(read(tx, koiosCbor.fetchImpl), /The CBOR of the transaction (?:ab)+ does not decode/);
    assert.deepEqual(koiosCbor.calls, [`${KOIOS}/tx_metadata`, `${KOIOS}/tx_cbor`]);
    const badJson = indexers(tx, { metadata: [{ tx_hash: tx, metadata: { 22084: { v: 2, t: 'claim', m: 'application/json', d: ['x'] } } }], blockfrost: REAL.blockfrost });
    await assert.rejects(read(tx, badJson.fetchImpl), /has version 2/);
    assert.deepEqual(badJson.calls, [`${KOIOS}/tx_metadata`]);
  });

  test('Blockfrost is the mainnet host unless VECTOR_BLOCKFROST_URL or the option says otherwise; trailing slashes are ignored', async () => {
    assert.equal(DEFAULT_BLOCKFROST_URL, 'https://blockfrost.vector.mainnet.apexfusion.org');
    assert.equal(blockfrostUrl(''), DEFAULT_BLOCKFROST_URL);
    assert.equal(blockfrostUrl('https://bf.example///'), 'https://bf.example');
    const saved = process.env.VECTOR_BLOCKFROST_URL;
    try {
      delete process.env.VECTOR_BLOCKFROST_URL;
      assert.equal(blockfrostUrl(), DEFAULT_BLOCKFROST_URL);
      const tx: string = REAL.txHash;
      const byDefault = indexers(tx, { blockfrost: REAL.blockfrost });
      assert.equal((await read(tx, byDefault.fetchImpl, { blockfrostUrl: undefined })).hash, REAL.documentHash);
      assert.equal(byDefault.calls[2], blockfrostAt(tx, DEFAULT_BLOCKFROST_URL));
      process.env.VECTOR_BLOCKFROST_URL = 'https://bf.example/';
      assert.equal(blockfrostUrl(), 'https://bf.example');
      const byEnv = indexers(tx, { blockfrost: REAL.blockfrost });
      await read(tx, byEnv.fetchImpl, { blockfrostUrl: undefined });
      assert.equal(byEnv.calls[2], blockfrostAt(tx, 'https://bf.example'));
    } finally {
      if (saved === undefined) delete process.env.VECTOR_BLOCKFROST_URL; else process.env.VECTOR_BLOCKFROST_URL = saved;
    }
  });
});
