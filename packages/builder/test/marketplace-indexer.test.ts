// packages/builder/test/marketplace-indexer.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Constr, Data, credentialToAddress } from '@lucid-evolution/lucid';
import { fetchSuppliers, fetchCapabilities, fetchSupplier, koiosUtxoInfo, koiosTxInputCreds, koiosTxInputRefs, koiosCredentialUtxos, readAdvert, withJson } from '../src/vector/marketplace-indexer.ts';
import { ADVERT_ADDRESS, ESCROW_ADDRESS, ESCROW_SCRIPT_HASH, INDEXER_URL, indexerUrlFrom } from '../src/vector/marketplace-constants.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';

const fakeFetch = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('indexer client', () => {
  test('fetchCapabilities returns rows', async () => {
    const rows = await fetchCapabilities({ fetchImpl: fakeFetch([{ capability_id: 'x.y.v1', supplier_count: 2 }]) });
    assert.deepEqual(rows, [{ capability_id: 'x.y.v1', supplier_count: 2 }]);
  });
  test('fetchSuppliers normalises bigint fields and filters', async () => {
    const row = { utxo_ref: 'a'.repeat(64) + '#0', supplier_pkh: 'b'.repeat(56), capability_id: 'x.y.v1', model: 'm', max_output_tokens: 1, max_processing_ms: 300000, price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', endpoint_url: 'https://s.example', detail_uri: '', detail_hash: '', advertised_at: 1, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: '2026-10-13T09:00:00.000Z', created_slot: 1 };
    const rows = await fetchSuppliers({ fetchImpl: fakeFetch([row, { ...row, status: 'offline' }]), capability_id: 'x.y.v1', onlyFree: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].price_lovelace, 200_000n);
  });
  test('non-200 becomes a readable error', async () => {
    await assert.rejects(() => fetchCapabilities({ fetchImpl: fakeFetch({}, 503) }), /indexer .*503/);
  });
  test('koiosUtxoInfo posts refs and returns datum bytes', async () => {
    const seen: any[] = [];
    const f = (async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify([{ tx_hash: 'a'.repeat(64), tx_index: 0, value: '1', is_spent: false, inline_datum: { bytes: 'd87980' } }]), { status: 200 }); }) as unknown as typeof fetch;
    const out = await koiosUtxoInfo('https://koios.example/', ['a'.repeat(64) + '#0'], f);
    assert.deepEqual(seen[0], { _utxo_refs: ['a'.repeat(64) + '#0'], _extended: true });
    assert.equal(out[0].inline_datum?.bytes, 'd87980');
  });
  test('withJson appends a fenced json block', () => {
    const s = withJson('# T', { a: 1n });
    assert.ok(s.endsWith('```json\n{"a":"1"}\n```'));
  });
});

const supplierRow = (over: Record<string, unknown> = {}) => ({ utxo_ref: 'a'.repeat(64) + '#0', supplier_pkh: 'b'.repeat(56), capability_id: 'x.y.v1', model: 'm', max_output_tokens: 1, max_processing_ms: 300000, price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', endpoint_url: 'https://s.example', detail_uri: '', detail_hash: '', advertised_at: 1, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: '2026-10-13T09:00:00.000Z', created_slot: 1, ...over });
const htmlFetch = (async () => new Response('<html><body>502 Bad Gateway from internal-proxy.example</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;

// Tool output goes to anonymous callers, so what the clients throw must be safe to show: the operation and
// the status, never the (operator-configurable) endpoint URL or a snippet of a response body.
const LEAKS = ['http://', 'https://', 'Bad Gateway', 'internal-proxy', '<html'];
const safeMessage = (re: RegExp) => (err: Error) => {
  assert.match(err.message, re);
  assert.ok(!err.message.includes(INDEXER_URL), 'the indexer URL must not reach the caller');
  for (const leak of LEAKS) assert.ok(!err.message.includes(leak), `"${leak}" leaked into: ${err.message}`);
  return true;
};

describe('indexer client failure surfaces', () => {
  test('an HTTP failure names the operation and status but not the endpoint URL', async () => {
    await assert.rejects(() => fetchCapabilities({ fetchImpl: fakeFetch({}, 503) }), safeMessage(/^list capabilities: indexer answered 503$/));
    await assert.rejects(() => fetchSuppliers({ fetchImpl: fakeFetch({}, 502) }), safeMessage(/^list suppliers: indexer answered 502$/));
  });
  test('a 200 with a non-JSON body becomes a readable error without a body snippet', async () => {
    await assert.rejects(() => fetchCapabilities({ fetchImpl: htmlFetch }), safeMessage(/^list capabilities: .*not valid JSON/));
    await assert.rejects(() => fetchSupplier('b'.repeat(56), { fetchImpl: htmlFetch }), safeMessage(/^get supplier: .*not valid JSON/));
    await assert.rejects(() => koiosUtxoInfo('https://koios.example', ['a'.repeat(64) + '#0'], htmlFetch), safeMessage(/^Koios utxo_info: .*not valid JSON/));
  });
  test('koiosUtxoInfo reports the status of a failed call', async () => {
    await assert.rejects(() => koiosUtxoInfo('https://koios.example', ['a'.repeat(64) + '#0'], fakeFetch({}, 500)), safeMessage(/^Koios utxo_info answered 500$/));
  });
});

describe('indexer base URL', () => {
  test('is the configured URL without trailing slashes, so no request path starts with a double slash', () => {
    assert.equal(indexerUrlFrom('https://idx.example'), 'https://idx.example');
    assert.equal(indexerUrlFrom('https://idx.example/'), 'https://idx.example');
    assert.equal(indexerUrlFrom('https://idx.example///'), 'https://idx.example');
    assert.equal(indexerUrlFrom('https://idx.example/base/'), 'https://idx.example/base');
    assert.ok(!INDEXER_URL.endsWith('/'));
  });
  test('is the public indexer when nothing is configured', () => {
    for (const unset of [undefined, '']) assert.equal(indexerUrlFrom(unset), 'https://mp-indexer.vector.apexfusion.org');
  });
});

describe('fetchSupplier', () => {
  test('requests /suppliers/<pkh> and normalises the row', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify(supplierRow()), { status: 200 }); }) as unknown as typeof fetch;
    const s = await fetchSupplier('b'.repeat(56), { fetchImpl: f });
    assert.deepEqual(urls, [`${INDEXER_URL}/suppliers/${'b'.repeat(56)}`]);
    assert.equal(s?.price_lovelace, 200_000n);
    assert.equal(s?.status, 'free');
  });
  test('404 means not indexed, other failures throw', async () => {
    assert.equal(await fetchSupplier('c'.repeat(56), { fetchImpl: fakeFetch({}, 404) }), null);
    await assert.rejects(() => fetchSupplier('c'.repeat(56), { fetchImpl: fakeFetch({}, 500) }), safeMessage(/^get supplier: indexer answered 500$/));
  });
});

describe('fetchSuppliers ordering', () => {
  test('sorts by price, then most recently seen first; onlyFree off keeps every status', async () => {
    const rows = [
      supplierRow({ utxo_ref: 'a'.repeat(64) + '#1', price_lovelace: '300000', last_seen_iso: '2026-10-13T10:00:00.000Z' }),
      supplierRow({ utxo_ref: 'a'.repeat(64) + '#2', price_lovelace: '200000', last_seen_iso: '2026-10-13T08:00:00.000Z' }),
      supplierRow({ utxo_ref: 'a'.repeat(64) + '#3', price_lovelace: '200000', last_seen_iso: '2026-10-13T09:00:00.000Z', status: 'offline' }),
      supplierRow({ utxo_ref: 'a'.repeat(64) + '#4', price_lovelace: '200000', last_seen_iso: null }),
    ];
    const all = await fetchSuppliers({ fetchImpl: fakeFetch(rows) });
    assert.deepEqual(all.map((s) => s.utxo_ref.slice(65)), ['3', '2', '4', '1']);
    const free = await fetchSuppliers({ fetchImpl: fakeFetch(rows), onlyFree: true });
    assert.deepEqual(free.map((s) => s.utxo_ref.slice(65)), ['2', '4', '1']);
  });
});

describe('non-list and non-object bodies', () => {
  test('a list endpoint answering with a non-list body becomes a clear error, not a TypeError', async () => {
    for (const body of [{}, { error: 'x' }, null, 'oops', 7]) {
      await assert.rejects(() => fetchCapabilities({ fetchImpl: fakeFetch(body) }), safeMessage(/^list capabilities: indexer returned a non-list response$/));
      await assert.rejects(() => fetchSuppliers({ fetchImpl: fakeFetch(body) }), safeMessage(/^list suppliers: indexer returned a non-list response$/));
      await assert.rejects(() => koiosUtxoInfo('https://koios.example', ['a'.repeat(64) + '#0'], fakeFetch(body)), safeMessage(/^Koios utxo_info: Koios returned a non-list response$/));
    }
  });
  test('the single-supplier endpoint answering with a list or null becomes a clear error', async () => {
    for (const body of [[], [supplierRow()], null, 'oops']) {
      await assert.rejects(() => fetchSupplier('b'.repeat(56), { fetchImpl: fakeFetch(body) }), safeMessage(/^get supplier: indexer returned a non-object response$/));
    }
  });
});

describe('koiosUtxoInfo URL', () => {
  test('POSTs to <base>/api/v1/utxo_info however many slashes end the base', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return new Response('[]', { status: 200 }); }) as unknown as typeof fetch;
    for (const base of ['https://koios.example/', 'https://koios.example', 'https://koios.example//']) await koiosUtxoInfo(base, [], f);
    assert.deepEqual(urls, Array(3).fill('https://koios.example/api/v1/utxo_info'));
  });
});

// readAdvert: the authenticity gate in front of every advert read. A UTxO is only an advert when it sits at the
// advert script address and holds an advert datum; anyone can lock a UTxO elsewhere with a datum that merely
// parses as one (and copies a real supplier_pkh).
const utxoAt = (ref: string, address: string | undefined, datumHex: string | null, over: Record<string, unknown> = {}) => ({
  tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)), address, value: '2000000', is_spent: false,
  inline_datum: datumHex === null ? null : { bytes: datumHex }, ...over,
});
const koiosReturning = (entries: unknown[]) => {
  const calls: { url: string; body: any }[] = [];
  const f = (async (u: string, init: any) => { calls.push({ url: u, body: JSON.parse(init.body) }); return new Response(JSON.stringify(entries), { status: 200 }); }) as unknown as typeof fetch;
  return { f, calls };
};
const errorOf = (r: Awaited<ReturnType<typeof readAdvert>>): string => {
  if (!('error' in r)) throw new assert.AssertionError({ message: 'expected a refusal, got an advert' });
  return r.error;
};

describe('readAdvert', () => {
  test('returns the decoded advert, the UTxO and the spent flag for an advert at the advert script address', async () => {
    const { f, calls } = koiosReturning([utxoAt(ADVERT_REF, ADVERT_ADDRESS, ADVERT_DATUM_HEX)]);
    const r = await readAdvert(ADVERT_REF, f);
    if ('error' in r) throw new assert.AssertionError({ message: `expected an advert, got: ${r.error}` });
    assert.deepEqual(r.advert, ADVERT_EXPECTED);
    assert.equal(r.spent, false);
    assert.equal(r.utxo.address, ADVERT_ADDRESS);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/v1/utxo_info'));
    assert.deepEqual(calls[0].body, { _utxo_refs: [ADVERT_REF], _extended: true });
  });
  test('flags a spent advert (Koios still returns its datum) without refusing it', async () => {
    const r = await readAdvert(ADVERT_REF, koiosReturning([utxoAt(ADVERT_REF, ADVERT_ADDRESS, ADVERT_DATUM_HEX, { is_spent: true })]).f);
    if ('error' in r) throw new assert.AssertionError({ message: `expected an advert, got: ${r.error}` });
    assert.equal(r.spent, true);
    assert.deepEqual(r.advert, ADVERT_EXPECTED);
  });
  test('asks Koios for the canonical lowercase ref and reports that ref', async () => {
    const upper = ADVERT_REF.slice(0, 64).toUpperCase() + '#0';
    const { f, calls } = koiosReturning([]);
    assert.equal(errorOf(await readAdvert(upper, f)), `No UTxO at ${ADVERT_REF}.`);
    assert.deepEqual(calls[0].body._utxo_refs, [ADVERT_REF]);
  });
  test('no UTxO at the ref: an empty answer, or an answer for some other output', async () => {
    for (const entries of [[], [utxoAt(ESCROW_REF, ADVERT_ADDRESS, ADVERT_DATUM_HEX)]]) {
      assert.equal(errorOf(await readAdvert(ADVERT_REF, koiosReturning(entries).f)), `No UTxO at ${ADVERT_REF}.`);
    }
  });
  test('refuses a forged advert: the right datum shape at the wrong address (or with no address at all)', async () => {
    const forged = 'addr1' + 'q'.repeat(54);
    for (const address of [forged, ESCROW_ADDRESS, undefined]) {
      const r = await readAdvert(ADVERT_REF, koiosReturning([utxoAt(ADVERT_REF, address, ADVERT_DATUM_HEX)]).f);
      assert.equal(errorOf(r), `UTxO ${ADVERT_REF} is not at the advert script address.`);
    }
  });
  test('refuses the live escrow UTxO: the escrow datum at the escrow address', async () => {
    const r = await readAdvert(ESCROW_REF, koiosReturning([utxoAt(ESCROW_REF, ESCROW_ADDRESS, ESCROW_OPEN_DATUM_HEX)]).f);
    assert.equal(errorOf(r), `UTxO ${ESCROW_REF} is not at the advert script address.`);
  });
  test('refuses a UTxO at the advert address that does not hold an advert datum', async () => {
    for (const datum of [ESCROW_OPEN_DATUM_HEX, null, 'ff', 'zz']) {
      const r = await readAdvert(ESCROW_REF, koiosReturning([utxoAt(ESCROW_REF, ADVERT_ADDRESS, datum)]).f);
      assert.equal(errorOf(r), `UTxO ${ESCROW_REF} does not hold an advert datum.`, `datum ${String(datum).slice(0, 12)}`);
    }
  });
  test('a refused advert says why when the decoder names the field that is out of range, and only then', async () => {
    const advertWith = (change: (c: Constr<Data>) => void) => { const c = Data.from(ADVERT_DATUM_HEX) as Constr<Data>; change(c); return Data.to(c); };
    const refusal = async (datum: string) => errorOf(await readAdvert(ESCROW_REF, koiosReturning([utxoAt(ESCROW_REF, ADVERT_ADDRESS, datum)]).f));
    const plain = `UTxO ${ESCROW_REF} does not hold an advert datum.`;
    assert.equal(await refusal(advertWith((c) => { c.fields[3] = 2n ** 60n; })), `${plain} advert.max_output_tokens: integer outside the safe range.`);
    assert.equal(await refusal(advertWith((c) => { c.fields[4] = -(2n ** 60n); })), `${plain} advert.max_processing_ms: integer outside the safe range.`);
    // Field-named decoder messages are fixed text; anything else the decoder says (shape, CBOR) stays out of the caller's text.
    assert.equal(await refusal(ESCROW_OPEN_DATUM_HEX), plain);
    assert.equal(await refusal('ff'), plain);
  });
  test('a malformed ref is refused without calling Koios', async () => {
    const { f, calls } = koiosReturning([]);
    assert.match(errorOf(await readAdvert('nope#1', f)), /^Invalid out ref/);
    assert.equal(calls.length, 0);
  });
  test('Koios failures still throw, with the safe messages', async () => {
    await assert.rejects(() => readAdvert(ADVERT_REF, fakeFetch({}, 500)), safeMessage(/^Koios utxo_info answered 500$/));
    await assert.rejects(() => readAdvert(ADVERT_REF, fakeFetch({ not: 'a list' })), safeMessage(/^Koios utxo_info: Koios returned a non-list response$/));
  });
});

// koiosTxInputCreds: who funded a transaction. Koios tx_info answers with an EMPTY inputs list unless the request asks
// for inputs (verified live 2026-10-13), and an empty list would read as "nobody signed", so the flags are pinned here.
describe('koiosTxInputCreds', () => {
  const TX = ADVERT_REF.slice(0, 64);
  const SUPPLIER_ADDR = 'addr1v9qp4aqc5ln0kyrzwu5j3q0um64pes2mtvgja8ytmvk5djgfj3cl6'; // enterprise address of ADVERT_EXPECTED.supplier_pkh
  const input = (cred: unknown, bech32 = SUPPLIER_ADDR) => ({ tx_hash: 'cc'.repeat(32), tx_index: 2, payment_addr: { bech32, cred }, stake_addr: null });
  const row = (over: Record<string, unknown> = {}) => ({ tx_hash: TX, inputs: [input(ADVERT_EXPECTED.supplier_pkh)], ...over });

  test('asks tx_info for the inputs and assets and returns the input payment credentials', async () => {
    const { f, calls } = koiosReturning([row()]);
    assert.deepEqual(await koiosTxInputCreds('https://koios.example/', TX, f), [ADVERT_EXPECTED.supplier_pkh]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://koios.example/api/v1/tx_info');
    assert.deepEqual(calls[0].body, { _tx_hashes: [TX], _inputs: true, _assets: true });
  });
  test('keeps every input credential, lowercased, and skips inputs that have none (Byron addresses)', async () => {
    const entries = [row({ inputs: [input(ADVERT_EXPECTED.supplier_pkh.toUpperCase()), input(null, 'Ae2tdPwUPEZ'), input('bb'.repeat(28)), { tx_hash: 'dd'.repeat(32), tx_index: 0 }] })];
    assert.deepEqual(await koiosTxInputCreds('https://koios.example', TX, koiosReturning(entries).f), [ADVERT_EXPECTED.supplier_pkh, 'bb'.repeat(28)]);
  });
  test('inputs that all lack a payment credential give an empty list (the caller refuses on that)', async () => {
    assert.deepEqual(await koiosTxInputCreds('https://koios.example', TX, koiosReturning([row({ inputs: [input(null, 'Ae2tdPwUPEZ')] })]).f), []);
  });
  test('asks for, and matches, the lowercase hash', async () => {
    const { f, calls } = koiosReturning([row()]);
    assert.deepEqual(await koiosTxInputCreds('https://koios.example', TX.toUpperCase(), f), [ADVERT_EXPECTED.supplier_pkh]);
    assert.deepEqual(calls[0].body._tx_hashes, [TX]);
  });
  test('POSTs to <base>/api/v1/tx_info however many slashes end the base', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify([row()]), { status: 200 }); }) as unknown as typeof fetch;
    for (const base of ['https://koios.example/', 'https://koios.example', 'https://koios.example//']) await koiosTxInputCreds(base, TX, f);
    assert.deepEqual(urls, Array(3).fill('https://koios.example/api/v1/tx_info'));
  });
  test('failures name the operation and the status, never the URL or a body snippet', async () => {
    const run = (f: typeof fetch) => koiosTxInputCreds('https://koios.example', TX, f);
    await assert.rejects(() => run(fakeFetch({}, 500)), safeMessage(/^Koios tx_info answered 500$/));
    await assert.rejects(() => run(htmlFetch), safeMessage(/^Koios tx_info: .*not valid JSON/));
    for (const body of [{}, { error: 'x' }, null, 'oops', 7]) await assert.rejects(() => run(fakeFetch(body)), safeMessage(/^Koios tx_info: Koios returned a non-list response$/));
  });
  test('a transaction Koios does not know is a clear error, not an empty list that would read as "nobody signed"', async () => {
    const run = (entries: unknown[]) => koiosTxInputCreds('https://koios.example', TX, koiosReturning(entries).f);
    await assert.rejects(() => run([]), safeMessage(/^Koios tx_info: transaction not found$/));
    await assert.rejects(() => run([row({ tx_hash: 'ee'.repeat(32) })]), safeMessage(/^Koios tx_info: transaction not found$/));
  });
  test('a row without inputs is a clear error: a ledger transaction always has one, so an empty list is Koios misbehaving', async () => {
    for (const inputs of [undefined, null, 'x', {}, []]) {
      await assert.rejects(() => koiosTxInputCreds('https://koios.example', TX, koiosReturning([row({ inputs })]).f), safeMessage(/^Koios tx_info: response has no inputs$/));
    }
  });
});

// koiosTxInputRefs: which outputs a set of transactions spent, in one tx_info call. The escrow lineage is read off that: the
// transaction that created an escrow output spent the previous one. Same request and same guards as koiosTxInputCreds.
describe('koiosTxInputRefs', () => {
  const [TX_A, TX_B, TX_C] = ['aa', 'bb', 'cc'].map((b) => b.repeat(32));
  const WALLET = 'addr1v9qp4aqc5ln0kyrzwu5j3q0um64pes2mtvgja8ytmvk5djgfj3cl6';
  const WALLET_CRED = 'dd'.repeat(28);
  /** An input as tx_info reports it: the ref of the output it spends, and the address and payment credential that output sits at. */
  const input = (ref: string, cred: unknown = WALLET_CRED, bech32: unknown = WALLET) => ({ tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)), payment_addr: { bech32, cred }, stake_addr: null });
  const row = (tx_hash: string, inputs: unknown) => ({ tx_hash, inputs });
  const KOIOS = 'https://koios.example';

  test('asks tx_info once for every transaction, inputs and assets included, and maps each to the refs of its inputs', async () => {
    const { f, calls } = koiosReturning([row(TX_A, [input(`${TX_C}#0`, ESCROW_SCRIPT_HASH, ESCROW_ADDRESS), input(`${TX_C}#1`)]), row(TX_B, [input(`${TX_A}#2`)])]);
    const refs = await koiosTxInputRefs('https://koios.example/', [TX_A, TX_B], f);
    assert.deepEqual([...refs], [[TX_A, [`${TX_C}#0`, `${TX_C}#1`]], [TX_B, [`${TX_A}#2`]]]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://koios.example/api/v1/tx_info');
    assert.deepEqual(calls[0].body, { _tx_hashes: [TX_A, TX_B], _inputs: true, _assets: true });
  });
  test('asks for the distinct lowercase hashes and keys the map, and the refs, by lowercase', async () => {
    const { f, calls } = koiosReturning([row(TX_A.toUpperCase(), [input(`${TX_B.toUpperCase()}#0`)])]);
    const refs = await koiosTxInputRefs(KOIOS, [TX_A.toUpperCase(), TX_A], f);
    assert.deepEqual(calls[0].body._tx_hashes, [TX_A]);
    assert.deepEqual([...refs], [[TX_A, [`${TX_B}#0`]]]);
  });
  test('given a payment credential, keeps only the inputs held at addresses with it, whatever their stake part (case ignored); a transaction that spent nothing there maps to an empty list', async () => {
    const staked = credentialToAddress('Mainnet', { type: 'Script', hash: ESCROW_SCRIPT_HASH }, { type: 'Key', hash: 'ee'.repeat(28) });
    const rows = [
      row(TX_A, [input(`${TX_C}#0`, ESCROW_SCRIPT_HASH, ESCROW_ADDRESS), input(`${TX_C}#1`, ESCROW_SCRIPT_HASH, staked), input(`${TX_C}#2`)]),
      row(TX_B, [input(`${TX_C}#3`)]),
    ];
    const refs = await koiosTxInputRefs(KOIOS, [TX_A, TX_B], koiosReturning(rows).f, ESCROW_SCRIPT_HASH.toUpperCase());
    assert.deepEqual([...refs], [[TX_A, [`${TX_C}#0`, `${TX_C}#1`]], [TX_B, []]]);
  });
  test('the filter reads the payment credential Koios reports, not the address text', async () => {
    const rows = [row(TX_A, [input(`${TX_C}#0`, WALLET_CRED, ESCROW_ADDRESS), input(`${TX_C}#1`, ESCROW_SCRIPT_HASH, WALLET), input(`${TX_C}#2`, undefined, ESCROW_ADDRESS)])];
    const refs = await koiosTxInputRefs(KOIOS, [TX_A], koiosReturning(rows).f, ESCROW_SCRIPT_HASH);
    assert.deepEqual(refs.get(TX_A), [`${TX_C}#1`]);
  });
  test('a transaction Koios does not know is absent from the map, and rows nobody asked about are ignored', async () => {
    const refs = await koiosTxInputRefs(KOIOS, [TX_A, TX_B], koiosReturning([row(TX_A, [input(`${TX_C}#0`)]), row(TX_C, [input(`${TX_A}#0`)])]).f);
    assert.deepEqual([...refs.keys()], [TX_A]);
    assert.equal(refs.has(TX_B), false);
    assert.equal((await koiosTxInputRefs(KOIOS, [TX_B], koiosReturning([]).f)).size, 0);
  });
  test('no hashes: nothing is asked and nothing comes back', async () => {
    const { f, calls } = koiosReturning([]);
    assert.equal((await koiosTxInputRefs(KOIOS, [], f)).size, 0);
    assert.equal(calls.length, 0);
  });
  test('inputs without a usable ref are skipped', async () => {
    const odd = [input(`${TX_C}#0`), { payment_addr: { bech32: WALLET } }, { tx_hash: 7, tx_index: 0 }, { tx_hash: TX_B, tx_index: 'x' }, { tx_hash: TX_B, tx_index: 1.5 }, null];
    assert.deepEqual((await koiosTxInputRefs(KOIOS, [TX_A], koiosReturning([row(TX_A, odd)]).f)).get(TX_A), [`${TX_C}#0`]);
  });
  test('a known transaction whose inputs are missing or empty is an error: a ledger transaction always has one, so that is Koios misbehaving', async () => {
    for (const inputs of [undefined, null, 'x', {}, []]) {
      await assert.rejects(() => koiosTxInputRefs(KOIOS, [TX_A], koiosReturning([row(TX_A, inputs)]).f), safeMessage(/^Koios tx_info: response has no inputs$/));
    }
  });
  test('POSTs to <base>/api/v1/tx_info however many slashes end the base', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify([row(TX_A, [input(`${TX_C}#0`)])]), { status: 200 }); }) as unknown as typeof fetch;
    for (const base of ['https://koios.example/', 'https://koios.example', 'https://koios.example//']) await koiosTxInputRefs(base, [TX_A], f);
    assert.deepEqual(urls, Array(3).fill('https://koios.example/api/v1/tx_info'));
  });
  test('failures name the operation and the status, never the URL or a body snippet', async () => {
    const run = (f: typeof fetch) => koiosTxInputRefs(KOIOS, [TX_A], f);
    await assert.rejects(() => run(fakeFetch({}, 500)), safeMessage(/^Koios tx_info answered 500$/));
    await assert.rejects(() => run(htmlFetch), safeMessage(/^Koios tx_info: .*not valid JSON/));
    for (const body of [{}, { error: 'x' }, null, 'oops', 7]) await assert.rejects(() => run(fakeFetch(body)), safeMessage(/^Koios tx_info: Koios returned a non-list response$/));
  });
});

// koiosCredentialUtxos: every unspent output at an address with a given payment credential, stake part and all. The escrow
// validator finds the continuation of a Claim or Submit by payment credential alone, so the live escrow can sit at an address
// the enterprise address does not cover; only a credential query sees it. Koios pages at 1,000 rows, so it is read page by page.
describe('koiosCredentialUtxos', () => {
  const CRED = ESCROW_SCRIPT_HASH;
  const KOIOS = 'https://koios.example';
  const rowN = (i: number) => ({ tx_hash: i.toString(16).padStart(64, '0'), tx_index: 0, address: ESCROW_ADDRESS, value: '2261030', payment_cred: CRED, inline_datum: { bytes: 'd87980' }, is_spent: false });
  /** A Koios that pages the way PostgREST does: offset and limit from the query string, rows from `all`, never more than `cap` at once. */
  const paging = (all: unknown[], cap = 1000) => {
    const calls: Array<{ url: string; body: any; offset: number; limit: number }> = [];
    const f = (async (u: string, init: any) => {
      const q = new URL(u).searchParams;
      const offset = Number(q.get('offset') ?? 0);
      const limit = Math.min(Number(q.get('limit') ?? cap), cap);
      calls.push({ url: u, body: JSON.parse(init.body), offset, limit });
      return new Response(JSON.stringify(all.slice(offset, offset + limit)), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  test('asks credential_utxos for the credential with extended rows, in a fixed order, and returns the rows', async () => {
    const { f, calls } = paging([rowN(1), rowN(2)]);
    const rows = await koiosCredentialUtxos('https://koios.example/', CRED.toUpperCase(), f);
    assert.deepEqual(rows.map((r) => r.tx_hash), [rowN(1).tx_hash, rowN(2).tx_hash]);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(`${url.origin}${url.pathname}`, 'https://koios.example/api/v1/credential_utxos');
    assert.equal(url.searchParams.get('order'), 'tx_hash.asc,tx_index.asc');
    assert.deepEqual([calls[0].offset, calls[0].limit], [0, 100]);
    assert.deepEqual(calls[0].body, { _payment_credentials: [CRED], _extended: true });
  });
  test('reads page after page until a short one, and the pages join up', async () => {
    const all = [1, 2, 3, 4, 5].map(rowN);
    const { f, calls } = paging(all);
    const rows = await koiosCredentialUtxos(KOIOS, CRED, f, { pageSize: 2 });
    assert.deepEqual(calls.map((c) => [c.offset, c.limit]), [[0, 2], [2, 2], [4, 2]]);
    assert.deepEqual(rows, all);
  });
  test('a page that is exactly full costs one more request, which comes back empty', async () => {
    const { f, calls } = paging([1, 2, 3, 4].map(rowN));
    assert.equal((await koiosCredentialUtxos(KOIOS, CRED, f, { pageSize: 2 })).length, 4);
    assert.deepEqual(calls.map((c) => c.offset), [0, 2, 4]);
  });
  test('a datum slice narrows the read on the server (hex only); what Koios sends is returned as it comes', async () => {
    const { f, calls } = paging([rowN(1)]);
    await koiosCredentialUtxos(KOIOS, CRED, f, { datumContains: 'ABCD01' });
    assert.equal(new URL(calls[0].url).searchParams.get('inline_datum->>bytes'), 'like.*abcd01*');
    const none = paging([]);
    for (const slice of ['', 'xyz', 'ab cd', 'ab*', '%', 'ab'.repeat(200)]) {
      await assert.rejects(() => koiosCredentialUtxos(KOIOS, CRED, none.f, { datumContains: slice }), /hex/, JSON.stringify(slice.slice(0, 12)));
    }
    assert.equal(none.calls.length, 0, 'nothing was asked for a slice that is not hex');
  });
  test('refuses to read without end: maxRows caps what one call collects', async () => {
    const { f, calls } = paging(Array.from({ length: 10 }, (_, i) => rowN(i + 1)));
    await assert.rejects(() => koiosCredentialUtxos(KOIOS, CRED, f, { pageSize: 2, maxRows: 4 }), safeMessage(/^Koios credential_utxos: 4 or more outputs matched; refusing to read them all$/));
    assert.equal(calls.length, 2);
  });
  test('the credential must be 28 bytes of hex, checked before anything is asked', async () => {
    const { f, calls } = paging([]);
    for (const bad of ['', 'zz', 'ab'.repeat(27), 'ab'.repeat(29)]) await assert.rejects(() => koiosCredentialUtxos(KOIOS, bad, f), /payment credential/, JSON.stringify(bad.slice(0, 8)));
    assert.equal(calls.length, 0);
  });
  test('entries that are not rows are dropped', async () => {
    const { f } = paging([rowN(1), null, 'x', {}, { tx_hash: 'ab', tx_index: 'x' }, { tx_hash: rowN(2).tx_hash, tx_index: 1.5 }, rowN(3)]);
    assert.deepEqual((await koiosCredentialUtxos(KOIOS, CRED, f)).map((r) => r.tx_hash), [rowN(1).tx_hash, rowN(3).tx_hash]);
  });
  // The loop ends on a short page or on maxRows. maxRows counts everything Koios sent, not only the well-formed rows: a Koios that
  // sends full pages of junk (or the same page again and again) would otherwise never reach it. The fakes below give up after 50
  // requests so that a loop that does not end fails the test instead of hanging it.
  const runaway = (page: (call: number) => unknown[]) => {
    let calls = 0;
    const f = (async () => {
      if (++calls > 50) throw new Error('runaway: still paging after 50 requests');
      return new Response(JSON.stringify(page(calls)), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls: () => calls };
  };
  test('full pages of entries that are not rows still count toward maxRows: the read is refused, not run for ever', async () => {
    const junk = runaway(() => [null, 'x']);
    await assert.rejects(() => koiosCredentialUtxos(KOIOS, CRED, junk.f, { pageSize: 2, maxRows: 6 }), safeMessage(/^Koios credential_utxos: 6 or more outputs matched; refusing to read them all$/));
    assert.equal(junk.calls(), 3);
  });
  test('the same page sent again and again (an offset that is ignored) is stopped by maxRows too', async () => {
    const same = runaway(() => [rowN(1), rowN(2)]);
    await assert.rejects(() => koiosCredentialUtxos(KOIOS, CRED, same.f, { pageSize: 2, maxRows: 6 }), safeMessage(/^Koios credential_utxos: 6 or more outputs matched/));
    assert.equal(same.calls(), 3);
  });
  test('a row that is listed on two pages (the set shifted while it was read) comes back once, in the order it first appeared', async () => {
    const { f } = paging([1, 2, 3, 2, 4].map(rowN)); // pages of two: [1, 2] [3, 2] [4]
    assert.deepEqual((await koiosCredentialUtxos(KOIOS, CRED, f, { pageSize: 2 })).map((r) => r.tx_hash), [1, 2, 3, 4].map((i) => rowN(i).tx_hash));
  });
  test('a ref is the same ref whatever the case of its hash, and an output index tells two rows of one transaction apart', async () => {
    const lower = rowN(0xab); // a hash with letters in it
    const upper = { ...lower, tx_hash: lower.tx_hash.toUpperCase() };
    const sibling = { ...lower, tx_index: 1 };
    assert.notEqual(upper.tx_hash, lower.tx_hash);
    const { f } = paging([lower, upper, sibling]);
    assert.deepEqual((await koiosCredentialUtxos(KOIOS, CRED, f)).map((r) => [r.tx_hash, r.tx_index]), [[lower.tx_hash, 0], [lower.tx_hash, 1]]);
  });
  test('a page size that is not a positive whole number is refused before anything is asked', async () => {
    const none = runaway(() => []);
    for (const pageSize of [0, -1, 1.5, Number.NaN]) await assert.rejects(() => koiosCredentialUtxos(KOIOS, CRED, none.f, { pageSize }), /page size/, String(pageSize));
    assert.equal(none.calls(), 0);
  });
  test('POSTs to <base>/api/v1/credential_utxos however many slashes end the base', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return new Response('[]', { status: 200 }); }) as unknown as typeof fetch;
    for (const base of ['https://koios.example/', 'https://koios.example', 'https://koios.example//']) await koiosCredentialUtxos(base, CRED, f);
    assert.deepEqual(urls.map((u) => u.split('?')[0]), Array(3).fill('https://koios.example/api/v1/credential_utxos'));
  });
  test('failures name the operation and the status, never the URL or a body snippet', async () => {
    const run = (f: typeof fetch) => koiosCredentialUtxos(KOIOS, CRED, f);
    await assert.rejects(() => run(fakeFetch({}, 500)), safeMessage(/^Koios credential_utxos answered 500$/));
    await assert.rejects(() => run(htmlFetch), safeMessage(/^Koios credential_utxos: .*not valid JSON/));
    for (const body of [{}, { error: 'x' }, null, 'oops', 7]) await assert.rejects(() => run(fakeFetch(body)), safeMessage(/^Koios credential_utxos: Koios returned a non-list response$/));
  });
});
