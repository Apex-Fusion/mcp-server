import { afterEach, describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '../src/provider.ts';

// The datums that OgmiosProvider hands to Lucid, and the datum that it looks up by hash. An output with an inline datum that is nested past
// 64 levels stays in the list without its datum; a datum that is looked up by its hash and is nested past the limit is refused. The same
// calls then work as before.

const OGMIOS_URL = 'https://ogmios-internal.example.cluster.local:1337';
const SUBMIT_URL = 'https://submit-internal.example.cluster.local:1338/api/submit/tx';
const KOIOS_URL = 'https://koios-internal.example.cluster.local:1339';
const ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
const nested = (levels: number): string => `${'81'.repeat(levels)}00`;
const DEEP = nested(5000);

afterEach(() => { mock.restoreAll(); });

const provider = () => new OgmiosProvider({ ogmiosUrl: OGMIOS_URL, submitUrl: SUBMIT_URL, koiosUrl: KOIOS_URL });
/** Answers each call of the global fetch with the JSON that `answer` gives for its URL. */
function answering(answer: (url: string, body: { method?: string }) => unknown): void {
  mock.method(globalThis, 'fetch', async (url: unknown, init?: { body?: unknown }) => new Response(JSON.stringify(answer(String(url), JSON.parse(String(init?.body ?? 'null')))), { status: 200 }));
}
const ogmios = (outputs: unknown[]) => (url: string, body: { method?: string }) => (url === OGMIOS_URL ? { jsonrpc: '2.0', method: body.method, result: outputs, id: null } : []);
const output = (id: string, index: number, more: Record<string, unknown> = {}) =>
  ({ transaction: { id }, index, address: ADDRESS, value: { ada: { lovelace: 2_000_000 } }, ...more });

describe('OgmiosProvider outputs: the inline datum', () => {
  test('an output with a datum that is nested past the limit keeps its value, its address and its other fields, and has no datum', async () => {
    mock.method(console, 'error', () => {});
    const script = { language: 'plutus:v3', cbor: '450101002499' };
    answering(ogmios([
      output('aa'.repeat(32), 0, { datum: 'd87980' }),
      output('bb'.repeat(32), 1, { datum: DEEP, script, value: { ada: { lovelace: 7_000_000 }, ['cc'.repeat(28)]: { '': 3 } } }),
      output('dd'.repeat(32), 2, { datumHash: 'ee'.repeat(32) }),
    ]));
    const [ok, deepDatum, byHash] = await provider().getUtxos(ADDRESS);
    assert.equal(ok.datum, 'd87980');
    assert.equal(deepDatum.datum, null, 'the datum is withheld');
    assert.deepEqual([deepDatum.txHash, deepDatum.outputIndex, deepDatum.address], ['bb'.repeat(32), 1, ADDRESS]);
    assert.deepEqual(deepDatum.assets, { lovelace: 7_000_000n, ['cc'.repeat(28)]: 3n });
    assert.deepEqual(deepDatum.scriptRef, { type: 'PlutusV3', script: '450101002499' });
    assert.deepEqual([byHash.datum, byHash.datumHash], [null, 'ee'.repeat(32)]);
    // The same call, with a normal list, gives what it always gave.
    answering(ogmios([output('aa'.repeat(32), 0, { datum: 'd87980' })]));
    assert.equal((await provider().getUtxos(ADDRESS))[0].datum, 'd87980');
    assert.equal(CML.PlutusData.from_cbor_hex('d87980').to_cbor_hex(), 'd87980');
  });

  test('a datum at the limit is kept, and one level more is withheld, in each of the forms that Ogmios gives a datum in', async () => {
    mock.method(console, 'error', () => {});
    answering(ogmios([
      output('a1'.repeat(32), 0, { datum: nested(64) }), output('a2'.repeat(32), 0, { datum: nested(65) }),
      output('a3'.repeat(32), 0, { datum: { bytes: nested(64) } }), output('a4'.repeat(32), 0, { datum: { bytes: nested(65) } }),
      output('a5'.repeat(32), 0, { datum: { value: nested(64) } }), output('a6'.repeat(32), 0, { datum: { value: DEEP } }),
    ]));
    const datums = (await provider().getUtxos(ADDRESS)).map((u) => u.datum);
    assert.deepEqual(datums, [nested(64), null, nested(64), null, nested(64), null]);
  });

  test('text that is not CBOR is withheld as well, and the output stays', async () => {
    mock.method(console, 'error', () => {});
    answering(ogmios([output('a1'.repeat(32), 0, { datum: 'not hex' }), output('a2'.repeat(32), 0, { datum: 'ff' })]));
    const utxos = await provider().getUtxos(ADDRESS);
    assert.deepEqual(utxos.map((u) => u.datum), [null, null]);
    assert.equal(utxos.length, 2);
  });

  test('the outputs that are read by their references and by a unit are mapped the same way', async () => {
    mock.method(console, 'error', () => {});
    answering(ogmios([output('bb'.repeat(32), 3, { datum: DEEP })]));
    const [byRef] = await provider().getUtxosByOutRef([{ txHash: 'bb'.repeat(32), outputIndex: 3 }]);
    assert.deepEqual([byRef.outputIndex, byRef.assets.lovelace, byRef.datum], [3, 2_000_000n, null]);
    const unit = `${'cc'.repeat(28)}`;
    const koiosRow = (datum: string) => ({ tx_hash: 'dd'.repeat(32), tx_index: 1, address: ADDRESS, value: '3000000', asset_list: [{ policy_id: unit, asset_name: '', quantity: '1' }], datum_hash: null, inline_datum: { bytes: datum } });
    answering((url) => (url.endsWith('/asset_utxos') ? [koiosRow(DEEP)] : []));
    const byUnit = await provider().getUtxoByUnit(unit);
    assert.deepEqual([byUnit.txHash, byUnit.outputIndex, byUnit.assets.lovelace, byUnit.assets[unit], byUnit.datum], ['dd'.repeat(32), 1, 3_000_000n, 1n, null]);
    answering((url) => (url.endsWith('/asset_utxos') ? [koiosRow('d87980')] : []));
    assert.equal((await provider().getUtxoByUnit(unit)).datum, 'd87980');
  });
});

describe('OgmiosProvider.getDatum', () => {
  const HASH = 'ab'.repeat(32);
  const koiosDatum = (bytes: string) => (url: string) => (url.endsWith('/datum_info') ? [{ datum_hash: HASH, bytes }] : []);

  test('a datum that is nested past the limit is refused, naming the hash, and a normal datum is read after it', async () => {
    answering(koiosDatum(DEEP));
    await assert.rejects(provider().getDatum(HASH), (err: Error) => {
      assert.equal(err.message, `The datum of the hash ${HASH} is nested deeper than 64 levels.`);
      return true;
    });
    answering(koiosDatum('d87980'));
    assert.equal(await provider().getDatum(HASH), 'd87980');
    assert.equal(CML.PlutusData.from_cbor_hex('d87980').to_cbor_hex(), 'd87980');
  });

  test('a datum at the limit is given', async () => {
    answering(koiosDatum(nested(64)));
    assert.equal(await provider().getDatum(HASH), nested(64));
  });

  test('a hash that Koios does not know is still not found', async () => {
    answering(() => []);
    await assert.rejects(provider().getDatum(HASH), /^Error: Datum not found for hash: /);
  });
});
