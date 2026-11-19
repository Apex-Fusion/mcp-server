// packages/builder/test/cbor-guard-chain.test.ts
// The CBOR check for chain data. Each read below holds an output with a datum that is nested past 64 levels beside normal outputs, also at
// the address of the wallet that a caller names. The read goes on, the other outputs are as they were, the output with the deep datum is
// not taken for anything that it is not, and a normal read in the same process works after it. The outputs reach the readers through OgmiosProvider (its mapping to Lucid's UTxO), through the rows of Koios, and
// through a provider that does no mapping (the second line: the codecs refuse the datum).
import { afterEach, describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { buildSendApex, lucidForAddress } from '../src/vector/build.ts';
import { koiosCredentialUtxos, koiosUtxoInfo, readAdvert } from '../src/vector/marketplace-indexer.ts';
import { resolveEscrowLineage, readEscrowOutput } from '../src/vector/marketplace-lineage.ts';
import { decodeEscrowDatum } from '../src/vector/marketplace-datum.ts';
import { ADVERT_ADDRESS, ESCROW_ADDRESS } from '../src/vector/marketplace-constants.ts';
import { caseDocumentUris, readJuryOutputs } from '../src/vector/jury-read.ts';
import type { CaseDatum } from '../src/vector/jury-codec.ts';
import { claimUtxo, JURY, juryWorld } from './fixtures/jury-world.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { CLAIM_TX, ESCROW_TX, escrowAt, world } from './fixtures/escrow-koios.fixture.ts';
import { FOREIGN_ADDRESS, OWN_ADDRESS, fixtureProtocolParameters } from './fixtures/fixture-provider.ts';
import { watchAllDecoders } from './fixtures/decoder-watch.ts';

const nested = (levels: number): string => `${'81'.repeat(levels)}00`;
const DEEP = nested(5000);
const KOIOS = 'https://koios.example';

afterEach(() => { mock.restoreAll(); });

// ─── OgmiosProvider and Lucid ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An Ogmios v6 output of `address` with the given lovelace, and the datum (inline) or datum hash when they are given. */
const ogmiosOutput = (id: string, index: number, address: string, lovelace: number, more: Record<string, unknown> = {}) =>
  ({ transaction: { id }, index, address, value: { ada: { lovelace } }, ...more });

/** An OgmiosProvider whose fetch answers `queryLedgerState/utxo` with `outputs` (by address or by output reference). */
function nodeAnswering(outputs: unknown[]): OgmiosProvider {
  class TestNode extends OgmiosProvider {
    async getProtocolParameters() { return fixtureProtocolParameters(); }
  }
  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body?: string }) => {
    const { method } = JSON.parse(String(init.body));
    assert.equal(method, 'queryLedgerState/utxo');
    return new Response(JSON.stringify({ jsonrpc: '2.0', method, result: outputs, id: null }), { status: 200 });
  });
  return new TestNode({ ogmiosUrl: 'https://ogmios.test', submitUrl: 'https://submit.test' });
}

describe('OgmiosProvider: an output whose datum is nested past the limit', () => {
  const DEEP_OUTPUT = 'ab'.repeat(32);

  test('stays in the list without its datum, and the wallet that holds it can still spend it', async () => {
    mock.method(console, 'error', () => {});
    const guard = watchAllDecoders();
    const node = nodeAnswering([
      ogmiosOutput('cd'.repeat(32), 0, OWN_ADDRESS, 6_000_000),
      ogmiosOutput(DEEP_OUTPUT, 0, OWN_ADDRESS, 500_000_000, { datum: DEEP }),
      ogmiosOutput('ef'.repeat(32), 1, OWN_ADDRESS, 7_000_000, { datum: 'd87980' }),
    ]);
    const utxos = await node.getUtxos(OWN_ADDRESS);
    assert.equal(utxos.length, 3);
    const [plain, deepDatum, withDatum] = utxos;
    assert.equal(deepDatum.datum, null, 'the datum is withheld');
    assert.equal(deepDatum.assets.lovelace, 500_000_000n, 'the value is kept: a balance counts it');
    assert.equal(deepDatum.address, OWN_ADDRESS);
    assert.equal(withDatum.datum, 'd87980', 'a normal datum is kept');
    assert.equal(plain.datum, null);
    // Lucid takes the wallet's outputs as the provider gave them, and the build spends the large one.
    const lucid = await lucidForAddress(node, OWN_ADDRESS);
    const built = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 100 });
    assert.equal(guard.reached(), 0);
    const inputs = CML.Transaction.from_cbor_hex(built.txCbor).body().inputs();
    const spent = Array.from({ length: inputs.len() }, (_, i) => `${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`);
    assert.ok(spent.includes(`${DEEP_OUTPUT}#0`), `the output with the deep datum is an input: ${spent.join(', ')}`);
    assert.equal(CML.PlutusData.from_cbor_hex('d87980').to_cbor_hex(), 'd87980');
  });

  test('one line of the operator log tells how many outputs were read without a datum, and it holds no datum', async () => {
    const logged: string[] = [];
    mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const node = nodeAnswering(Array.from({ length: 50 }, (_, i) => ogmiosOutput(DEEP_OUTPUT, i, OWN_ADDRESS, 2_000_000, { datum: DEEP })));
    const utxos = await node.getUtxos(OWN_ADDRESS);
    assert.equal(utxos.length, 50);
    assert.ok(utxos.every((u) => u.datum === null));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /50 output\(s\) of an Ogmios answer carry a datum that is not read; first: (?:ab)+#0/);
    assert.ok(logged[0].length < 300);
  });

  test('a datum at the limit is kept, and one level more is withheld', async () => {
    mock.method(console, 'error', () => {});
    const node = nodeAnswering([
      ogmiosOutput('a1'.repeat(32), 0, OWN_ADDRESS, 2_000_000, { datum: nested(64) }),
      ogmiosOutput('a2'.repeat(32), 0, OWN_ADDRESS, 2_000_000, { datum: nested(65) }),
    ]);
    const [atLimit, past] = await node.getUtxos(OWN_ADDRESS);
    assert.equal(atLimit.datum, nested(64));
    assert.equal(past.datum, null);
  });

  test('the outputs that are read by their references are mapped the same way', async () => {
    mock.method(console, 'error', () => {});
    const node = nodeAnswering([ogmiosOutput(DEEP_OUTPUT, 3, OWN_ADDRESS, 9_000_000, { datum: DEEP })]);
    const [utxo] = await node.getUtxosByOutRef([{ txHash: DEEP_OUTPUT, outputIndex: 3 }]);
    assert.deepEqual([utxo.txHash, utxo.outputIndex, utxo.assets.lovelace, utxo.datum], [DEEP_OUTPUT, 3, 9_000_000n, null]);
  });
});

// ─── Koios rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the Koios rows of marketplace-indexer.ts', () => {
  const row = (txHash: string, datum: string | null, over: Record<string, unknown> = {}) => ({
    tx_hash: txHash, tx_index: 0, address: ADVERT_ADDRESS, value: '2000000', is_spent: false, inline_datum: datum === null ? null : { bytes: datum, value: { fields: [] } },
    datum_hash: null, ...over,
  });
  const fetchOf = (rows: unknown[]) => (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;

  test('utxo_info: a row with a datum that is nested past the limit has no datum, and the other rows are as they came', async () => {
    const good = row('aa'.repeat(32), 'd87980');
    const deep = row('bb'.repeat(32), DEEP, { value: '7000000' });
    const atLimit = row('cc'.repeat(32), nested(64));
    const rows = await koiosUtxoInfo(KOIOS, ['x#0'], fetchOf([good, deep, null, atLimit, { tx_hash: 'dd'.repeat(32) }]));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], good);
    assert.deepEqual(rows[1], { ...deep, inline_datum: null });
    assert.equal(rows[1].value, '7000000', 'the other fields are kept');
    assert.equal(rows[2], null);
    assert.deepEqual(rows[3], atLimit);
    assert.deepEqual(rows[4], { tx_hash: 'dd'.repeat(32) });
  });

  test('credential_utxos: the same, and the read goes on to the end', async () => {
    const deep = row('bb'.repeat(32), DEEP);
    const good = row('cc'.repeat(32), 'd87980');
    const rows = await koiosCredentialUtxos(KOIOS, 'ab'.repeat(28), fetchOf([deep, good]));
    assert.deepEqual(rows.map((r) => [r.tx_hash, r.inline_datum?.bytes ?? null]), [['bb'.repeat(32), null], ['cc'.repeat(32), 'd87980']]);
  });

  test('readAdvert: an output with a datum that is nested past the limit holds no advert, and an advert is read after it', async () => {
    const guard = watchAllDecoders();
    const read = (datum: string) => readAdvert(ADVERT_REF, fetchOf([row(ADVERT_REF.slice(0, 64), datum)]));
    const refused = await read(DEEP);
    assert.ok('error' in refused && /does not hold an advert datum\.$/.test(refused.error), JSON.stringify(refused));
    assert.equal(guard.reached(), 0);
    const advert = await read(ADVERT_DATUM_HEX);
    assert.ok(!('error' in advert));
    assert.equal(advert.advert.supplier_pkh, ADVERT_EXPECTED.supplier_pkh);
  });

  test('readEscrowOutput: an output with a datum that is nested past the limit holds no escrow, and an escrow is read after it', async () => {
    const guard = watchAllDecoders();
    const f = (datum: string) => (async () => new Response(JSON.stringify([row(ESCROW_TX, datum, { address: ESCROW_ADDRESS, value: '2261030' })]), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(readEscrowOutput(KOIOS, ESCROW_REF, f(DEEP)), /does not hold an escrow datum\./);
    assert.equal(guard.reached(), 0);
    assert.equal((await readEscrowOutput(KOIOS, ESCROW_REF, f(ESCROW_OPEN_DATUM_HEX))).datum.state, 'Open');
  });

  test('the lineage of an escrow is found with outputs that hold a deep datum listed beside its continuation', async () => {
    const guard = watchAllDecoders();
    const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    const claimed = escrowAt(CLAIM_TX, { ...posted, state: 'Claimed' });
    const decoys = [0, 1, 2].map((i) => ({
      tx_hash: `${'d0'.repeat(31)}0${i}`, tx_index: 0, address: ESCROW_ADDRESS, value: '2261030', is_spent: false, inline_datum: { bytes: DEEP }, datum_hash: null, reference_script: null, asset_list: [],
    }));
    const w = world([claimed], { extraCredentialRows: decoys, ignoreDatumFilter: true });
    const lineage = await resolveEscrowLineage(w.node, KOIOS, ESCROW_REF, w.koios.f);
    assert.equal(guard.reached(), 0);
    assert.equal(lineage.current?.utxo.txHash, CLAIM_TX);
    assert.equal(lineage.current?.datum.state, 'Claimed');
  });

  test('the document URIs of a case: an output with a datum that is nested past the limit gives none, and the others give theirs', async () => {
    const guard = watchAllDecoders();
    const ref = (n: string) => ({ txHash: n.repeat(32), outputIndex: 0 });
    // Only the two output references of a case are read.
    const cases = [{ claimOut: ref('11'), challengeOut: ref('22') }, { claimOut: ref('33'), challengeOut: ref('44') }] as unknown as CaseDatum[];
    const claim = claimUtxo('cc'.repeat(32)).datum!;
    const rows = [row('11'.repeat(32), DEEP), row('22'.repeat(32), DEEP), row('33'.repeat(32), claim), row('44'.repeat(32), 'ff')];
    const uris = await caseDocumentUris(KOIOS, cases, fetchOf(rows));
    assert.equal(guard.reached(), 0);
    assert.deepEqual([...uris.keys()], [`${'33'.repeat(32)}#0`]);
  });
});

// ─── A provider that does no mapping: the second line ──────────────────────────────────────────────────────────────────────────

describe('a datum that is nested past the limit at a script address, from a provider that gives it as it is', () => {
  test('the jury outputs: the output is counted as another output, and the jurors and cases are read as before', async () => {
    const guard = watchAllDecoders();
    const deepOutput: UTxO = { txHash: 'ee'.repeat(32), outputIndex: 0, address: JURY.address, assets: { lovelace: 2_000_000n }, datum: DEEP };
    const before = await readJuryOutputs(juryWorld(), JURY);
    const after = await readJuryOutputs(juryWorld([deepOutput, { ...deepOutput, outputIndex: 1, datum: nested(64) }]), JURY);
    assert.equal(guard.reached(), 0);
    assert.deepEqual([after.jurors.length, after.cases.length], [before.jurors.length, before.cases.length]);
    assert.equal(after.other, before.other + 2);
  });
});
