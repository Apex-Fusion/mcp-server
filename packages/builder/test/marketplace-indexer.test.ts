// packages/builder/test/marketplace-indexer.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Constr, Data } from '@lucid-evolution/lucid';
import { fetchSuppliers, fetchCapabilities, fetchSupplier, koiosUtxoInfo, koiosTxInputCreds, koiosTxInputRefs, readAdvert, withJson } from '../src/vector/marketplace-indexer.ts';
import { ADVERT_ADDRESS, ESCROW_ADDRESS, INDEXER_URL } from '../src/vector/marketplace-constants.ts';
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
  const input = (ref: string, bech32: unknown = WALLET) => ({ tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)), payment_addr: { bech32, cred: 'dd'.repeat(28) }, stake_addr: null });
  const row = (tx_hash: string, inputs: unknown) => ({ tx_hash, inputs });
  const KOIOS = 'https://koios.example';

  test('asks tx_info once for every transaction, inputs and assets included, and maps each to the refs of its inputs', async () => {
    const { f, calls } = koiosReturning([row(TX_A, [input(`${TX_C}#0`, ESCROW_ADDRESS), input(`${TX_C}#1`)]), row(TX_B, [input(`${TX_A}#2`)])]);
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
  test('given an address, keeps only the inputs held there (case ignored); a transaction that spent nothing there maps to an empty list', async () => {
    const rows = [row(TX_A, [input(`${TX_C}#0`, ESCROW_ADDRESS), input(`${TX_C}#1`, WALLET)]), row(TX_B, [input(`${TX_C}#1`, WALLET)])];
    const refs = await koiosTxInputRefs(KOIOS, [TX_A, TX_B], koiosReturning(rows).f, ESCROW_ADDRESS.toUpperCase());
    assert.deepEqual([...refs], [[TX_A, [`${TX_C}#0`]], [TX_B, []]]);
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
