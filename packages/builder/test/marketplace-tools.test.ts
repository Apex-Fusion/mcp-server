// packages/builder/test/marketplace-tools.test.ts
// Handler-level tests for the three read tools: a minimal fake server captures the handlers and global fetch is
// stubbed, so no network is touched. (Registration and schemas are covered by the smoke suite.)
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Constr, Data, fromText } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMarketplaceTools } from '../src/vector/marketplace.ts';
import { ADVERT_ADDRESS, INDEXER_URL } from '../src/vector/marketplace-constants.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF } from './fixtures/marketplace.fixture.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const handlers = new Map<string, Handler>();
registerMarketplaceTools({ tool: (name: string, _description: string, _shape: unknown, handler: Handler) => { handlers.set(name, handler); } } as unknown as McpServer, 'marketplace-tools-test');
const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const h = handlers.get(name);
  assert.ok(h, `${name} is registered`);
  const out = await h(args);
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'text');
  return out.content[0].text;
};
const JSON_FENCE = '\n```json\n';
const jsonOf = (t: string) => JSON.parse(t.slice(t.lastIndexOf(JSON_FENCE) + JSON_FENCE.length, t.lastIndexOf('\n```')));
const markdownOf = (t: string) => t.slice(0, t.lastIndexOf('\n\n' + JSON_FENCE.slice(1)));

// --- stubbed network -------------------------------------------------------------------------------------------
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const supplierRow = (over: Record<string, unknown> = {}) => ({ utxo_ref: ADVERT_REF, supplier_pkh: ADVERT_EXPECTED.supplier_pkh, capability_id: ADVERT_EXPECTED.capability_id, model: 'm', max_output_tokens: 1, max_processing_ms: 300000, price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', endpoint_url: 'https://s.example', detail_uri: '', detail_hash: '', advertised_at: 1, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: '2026-10-13T09:00:00.000Z', created_slot: 1, ...over });
const advertUtxo = (datumHex: string, over: Record<string, unknown> = {}) => ({ tx_hash: ADVERT_REF.slice(0, 64), tx_index: 0, address: ADVERT_ADDRESS, value: '2000000', is_spent: false, inline_datum: { bytes: datumHex }, ...over });
interface Net { utxos?: unknown[]; capabilities?: unknown[]; suppliers?: unknown[]; supplier?: { status: number; body?: unknown }; koiosStatus?: number }
let requested: string[] = [];
const realFetch = globalThis.fetch;
const stub = (net: Net) => {
  requested = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/api/v1/utxo_info')) return reply(net.utxos ?? [], net.koiosStatus ?? 200);
    if (url === `${INDEXER_URL}/capabilities`) return reply(net.capabilities ?? []);
    if (url === `${INDEXER_URL}/suppliers`) return reply(net.suppliers ?? []);
    if (url.startsWith(`${INDEXER_URL}/suppliers/`)) return net.supplier ? reply(net.supplier.body ?? {}, net.supplier.status) : reply({}, 404);
    return reply({ unexpected: url }, 500);
  }) as typeof fetch;
};
beforeEach(() => { requested = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// A real advert datum with chosen supplier-controlled fields (indexes follow AdvertDatum's on-chain field order).
const advertDatumWith = (fields: { model?: string; endpoint_url?: string; advertised_at?: bigint }): string => {
  const c = Data.from(ADVERT_DATUM_HEX) as Constr<Data>;
  if (fields.model !== undefined) c.fields[2] = fromText(fields.model);
  if (fields.endpoint_url !== undefined) c.fields[8] = fromText(fields.endpoint_url);
  if (fields.advertised_at !== undefined) c.fields[11] = fields.advertised_at;
  return Data.to(c);
};

describe('vector_marketplace_get_supplier', () => {
  test('echoes the canonical ref and shows the indexer status when the indexer lists this very advert', async () => {
    stub({ utxos: [advertUtxo(ADVERT_DATUM_HEX)], supplier: { status: 200, body: supplierRow() } });
    const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF.slice(0, 64).toUpperCase() + '#0' });
    assert.ok(t.startsWith(`# Advert ${ADVERT_REF}\n`), 'heading carries the canonical lowercase ref');
    assert.match(t, /- \*\*Indexer status:\*\* free, last seen 2026-10-13T09:00:00\.000Z/);
    const j = jsonOf(t);
    assert.equal(j.advert_ref, ADVERT_REF);
    assert.equal(j.indexer_status, 'free');
    assert.equal(j.is_spent, false);
    assert.equal(j.capability_id, ADVERT_EXPECTED.capability_id);
    assert.equal(j.price_lovelace, '200000');
  });
  test('does not lend the supplier\'s indexer status to an advert the indexer does not list', async () => {
    const lists = [
      { status: 200, body: supplierRow({ utxo_ref: 'f'.repeat(64) + '#3' }) }, // the supplier moved on to a newer advert
      { status: 404 },
      { status: 500 },
    ];
    for (const supplier of lists) {
      stub({ utxos: [advertUtxo(ADVERT_DATUM_HEX)], supplier });
      const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
      assert.match(t, /- \*\*Indexer status:\*\* not confirmed by the indexer for this advert$/m, `indexer answered ${supplier.status}`);
      assert.ok(!t.includes('last seen'), 'no status borrowed from the other row');
      const j = jsonOf(t);
      assert.equal(j.indexer_status, null);
      assert.equal(j.last_seen_iso, null);
    }
  });
  test('refuses a forged advert before consulting the indexer', async () => {
    stub({ utxos: [advertUtxo(ADVERT_DATUM_HEX, { address: 'addr1' + 'q'.repeat(54) })], supplier: { status: 200, body: supplierRow() } });
    const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
    assert.equal(t, `UTxO ${ADVERT_REF} is not at the advert script address.`);
    assert.ok(!requested.some((u) => u.startsWith(`${INDEXER_URL}/suppliers`)), 'the genuine supplier\'s status must not be looked up for a forgery');
  });
  test('says so when the advert UTxO has been spent', async () => {
    stub({ utxos: [advertUtxo(ADVERT_DATUM_HEX, { is_spent: true })] });
    const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
    assert.match(t, /Status on chain:\*\* Active \(UTxO spent: retired or updated\)/);
    assert.equal(jsonOf(t).is_spent, true);
  });
  test('prints a raw advertised_at that is not a valid date instead of throwing', async () => {
    stub({ utxos: [advertUtxo(advertDatumWith({ advertised_at: 10n ** 30n }))] });
    const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
    assert.match(t, /- \*\*Advertised at:\*\* 1e\+30 /);
    assert.ok(!t.startsWith('Failed'));
  });
  test('keeps supplier-controlled text on its own bullet in the markdown and verbatim in the JSON', async () => {
    const model = 'evil | model\n## injected `x`\r\n- **Fake:** line';
    const endpoint = 'https://x.example/' + 'a'.repeat(200);
    stub({ utxos: [advertUtxo(advertDatumWith({ model, endpoint_url: endpoint }))] });
    const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
    const md = markdownOf(t);
    assert.ok(md.includes("- **Model:** evil ¦ model ## injected 'x' - **Fake:** line\n"), md);
    assert.equal(md.split('\n').filter((l) => l.startsWith('- **')).length, 9, 'exactly the nine advert bullets, nothing smuggled in');
    const endpointLine = md.split('\n').find((l) => l.startsWith('- **Endpoint:**'))!;
    assert.ok(endpointLine.endsWith('…') && endpointLine.length < 120, endpointLine);
    const j = jsonOf(t);
    assert.equal(j.model, model);
    assert.equal(j.endpoint_url, endpoint);
  });
  test('a Koios failure becomes a text error without any endpoint detail', async () => {
    stub({ koiosStatus: 502 });
    const t = await call('vector_marketplace_get_supplier', { advert_ref: ADVERT_REF });
    assert.match(t, /^Failed to read advert: Koios utxo_info answered 502\n/);
    assert.ok(!/https?:/.test(t));
  });
});

describe('vector_marketplace_list_suppliers', () => {
  test('keeps every table row on one line with nine cells; the JSON keeps the raw values', async () => {
    const evil = supplierRow({ utxo_ref: 'e'.repeat(64) + '#0', model: 'a|b\nc`d', capability_id: 'x.'.repeat(60), endpoint_url: 'not a url | with\nnewline', status: 'free|\nfake' });
    stub({ suppliers: [evil, supplierRow({ utxo_ref: 'a'.repeat(64) + '#0', price_lovelace: '100000' })] });
    const t = await call('vector_marketplace_list_suppliers', { only_free: false, limit: 20 });
    const rows = markdownOf(t).split('\n').filter((l) => l.startsWith('| `'));
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.split(' | ').length, 9, r);
    assert.ok(rows[1].includes("a¦b c'd"), rows[1]);
    assert.ok(rows[1].includes('…'), 'the 120-character capability id is capped');
    const j = jsonOf(t);
    assert.deepEqual(j.map((s: { advert_ref: string }) => s.advert_ref.slice(0, 1)), ['a', 'e']);
    assert.equal(j[1].model, 'a|b\nc`d');
    assert.equal(j[1].capability_id, 'x.'.repeat(60));
  });
  test('echoes a capability filter that matched nothing as one clean line', async () => {
    stub({ suppliers: [supplierRow()] });
    const t = await call('vector_marketplace_list_suppliers', { capability_id: 'zz`|\nq', only_free: true, limit: 20 });
    assert.equal(t, "No suppliers found for zz'¦ q with status free.");
  });
  test('a non-list indexer answer becomes a text error', async () => {
    stub({ suppliers: { rows: [] } as unknown as unknown[] });
    const t = await call('vector_marketplace_list_suppliers', { only_free: true, limit: 20 });
    assert.match(t, /^Failed to list suppliers: list suppliers: indexer returned a non-list response\n/);
  });
});

describe('vector_marketplace_list_capabilities', () => {
  test('escapes the capability id in the table and keeps the rows verbatim in the JSON', async () => {
    stub({ capabilities: [{ capability_id: 'a|b`c\nd', supplier_count: 2 }, { capability_id: 'llm.chat.v1', supplier_count: 12 }] });
    const t = await call('vector_marketplace_list_capabilities');
    const rows = markdownOf(t).split('\n').filter((l) => l.startsWith('| `'));
    assert.deepEqual(rows, ["| `a¦b'c d` | 2 |", '| `llm.chat.v1` | 12 |']);
    assert.deepEqual(jsonOf(t), [{ capability_id: 'a|b`c\nd', supplier_count: 2 }, { capability_id: 'llm.chat.v1', supplier_count: 12 }]);
  });
});

describe('registration', () => {
  test('registers exactly the three read tools', () => {
    assert.deepEqual([...handlers.keys()].sort(), ['vector_marketplace_get_supplier', 'vector_marketplace_list_capabilities', 'vector_marketplace_list_suppliers']);
  });
});
