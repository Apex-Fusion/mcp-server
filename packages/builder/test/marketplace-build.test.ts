// packages/builder/test/marketplace-build.test.ts
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CML, Constr, Data, getAddressDetails, credentialToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FIXTURE_TXHASH } from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE, ESCROW_OPEN_DATUM_HEX,
} from './fixtures/marketplace.fixture.ts';
import {
  ADVERT_ADDRESS, ESCROW_ADDRESS, DELIVER_BY_BUFFER_MS, ACCEPT_WINDOW_MS, MARKETPLACE_MIN_FEE,
} from '../src/vector/marketplace-constants.ts';
import { decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, promptHashForPayload } from '../src/vector/marketplace-datum.ts';
import {
  planPostEscrow, buildPostEscrow, reserveCollateralInputs, planAccept, planReclaim, paymentKeyHashOf, enterpriseAddressOf,
} from '../src/vector/marketplace-build.ts';

const OWN_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
const NOW = 1_786_529_974_711;
const ADVERT_TX = ADVERT_REF.slice(0, 64);
// Enterprise address of ADVERT_EXPECTED.supplier_pkh, as Koios reports it for the advert's funding input (live capture, 2026-10-13).
const SUPPLIER_ADDRESS = 'addr1v9qp4aqc5ln0kyrzwu5j3q0um64pes2mtvgja8ytmvk5djgfj3cl6';

function outputs(cborHex: string) {
  const outs = CML.Transaction.from_cbor_hex(cborHex).body().outputs();
  const r: Array<{ address: string; lovelace: bigint; datum: string | null }> = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    r.push({ address: o.address().to_bech32(), lovelace: BigInt(o.amount().coin().toString()), datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null });
  }
  return r;
}

function inputRefs(cborHex: string): string[] {
  const ins = CML.Transaction.from_cbor_hex(cborHex).body().inputs();
  const r: string[] = [];
  for (let i = 0; i < ins.len(); i++) r.push(`${ins.get(i).transaction_id().to_hex()}#${ins.get(i).index()}`);
  return r.sort();
}

describe('paymentKeyHashOf / enterpriseAddressOf', () => {
  test('a key address gives its payment key hash and that hash maps back to the live enterprise address', () => {
    assert.equal(paymentKeyHashOf(OWN_ADDRESS), OWN_PKH);
    assert.equal(paymentKeyHashOf(SUPPLIER_ADDRESS), ADVERT_EXPECTED.supplier_pkh);
    assert.equal(enterpriseAddressOf(ADVERT_EXPECTED.supplier_pkh), SUPPLIER_ADDRESS);
  });
  test('a script address or garbage is refused with a readable error', () => {
    assert.throws(() => paymentKeyHashOf(ESCROW_ADDRESS), /verification key/);
    assert.throws(() => paymentKeyHashOf('not-an-address'), /Invalid address/);
  });
});

describe('planPostEscrow', () => {
  const advert = decodeAdvertDatum(ADVERT_DATUM_HEX);
  test('locks price + both bonds (floored) and commits the payload hash', () => {
    const plan = planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'hello', NOW);
    assert.equal(plan.datum.buyer_pkh, OWN_PKH);
    assert.equal(plan.datum.supplier_pkh, ADVERT_EXPECTED.supplier_pkh);
    assert.equal(plan.datum.prompt_hash, promptHashForPayload('hello'));
    assert.equal(plan.datum.request_spec_hash, ESCROW_EXPECTED.request_spec_hash);
    assert.equal(plan.datum.deliver_by, NOW + advert.max_processing_ms + DELIVER_BY_BUFFER_MS);
    assert.ok(plan.lockLovelace >= 2_200_000n);
    assert.equal(plan.datum.state, 'Open');
  });
  test('locks exactly what the marketplace locked for the same terms', () => {
    assert.equal(planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'hello', NOW).lockLovelace, ESCROW_LOCKED_LOVELACE);
  });
  test('maps the advert onto the live escrow datum field for field (only the payload hash is the buyer\'s own)', () => {
    const live = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    const plan = planPostEscrow(advert, ADVERT_REF, live.buyer_pkh, 'any payload', live.posted_at, live.deliver_by);
    assert.deepEqual({ ...plan.datum, prompt_hash: live.prompt_hash }, live);
    assert.equal(encodeEscrowDatum({ ...plan.datum, prompt_hash: live.prompt_hash }), ESCROW_OPEN_DATUM_HEX);
  });
  test('shows the signer who is paid and what: supplier key, endpoint host, capability, amounts, deadline, lock', () => {
    const plan = planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'hello', NOW);
    assert.equal(plan.supplierPkh, ADVERT_EXPECTED.supplier_pkh);
    assert.equal(plan.endpointHost, 'mp-suppliers-chandra.hal8.ai');
    assert.equal(plan.capabilityId, ADVERT_EXPECTED.capability_id);
    assert.equal(plan.priceLovelace, 200_000n);
    assert.equal(plan.supplierBondLovelace, 1_000_000n);
    assert.equal(plan.buyerBondLovelace, 1_000_000n);
    assert.equal(plan.deliverBy, plan.datum.deliver_by);
    assert.equal(plan.lockLovelace, ESCROW_LOCKED_LOVELACE);
  });
  test('the endpoint host is the host the URL really connects to, port included, IDN in punycode', () => {
    const host = (endpoint_url: string) => planPostEscrow({ ...advert, endpoint_url }, ADVERT_REF, OWN_PKH, 'x', NOW).endpointHost;
    assert.equal(host('https://Supplier.Example:8443/jobs?x=1'), 'supplier.example:8443');
    assert.equal(host('https://trusted.example@evil.example/'), 'evil.example');
    assert.equal(host('https://bücher.example'), 'xn--bcher-kva.example');
  });
  test('an explicit deliver_by is honoured when it leaves the supplier its full window', () => {
    assert.equal(planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, NOW + advert.max_processing_ms + 1).deliverBy, NOW + advert.max_processing_ms + 1);
  });
  test('refuses a retired advert and a buyer who is the supplier', () => {
    assert.throws(() => planPostEscrow({ ...advert, status: 'Retired' }, ADVERT_REF, OWN_PKH, 'x', 1), /retired/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, advert.supplier_pkh, 'x', 1), /cannot be the supplier/);
  });
  test('refuses an empty or non-string payload and a malformed advert ref', () => {
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, '', NOW), /payload/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 5 as never, NOW), /payload/);
    assert.throws(() => planPostEscrow(advert, 'nope#1', OWN_PKH, 'x', NOW), /Invalid out ref/);
  });
  test('refuses a deliver_by that does not leave the supplier its full window, or is not a whole number of ms', () => {
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, NOW + advert.max_processing_ms), /deliver_by/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, NOW - 1), /deliver_by/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, NOW + 1e6 + 0.5), /deliver_by/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, Number.NaN), /deliver_by/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', Number.NaN), /nowMs/);
  });
  test('refuses an endpoint that has no host to show the signer', () => {
    for (const endpoint_url of ['', 'not a url', 'mp-suppliers.example', 'mailto:a@b.example', 'file:///etc/passwd']) {
      assert.throws(() => planPostEscrow({ ...advert, endpoint_url }, ADVERT_REF, OWN_PKH, 'x', NOW), /endpoint/, JSON.stringify(endpoint_url));
    }
  });
  test('hostile numbers in an advert come back as a clear Error instead of a corrupt datum or a bare RangeError', () => {
    const hostile: Array<[string, Partial<typeof advert>]> = [
      ['negative price', { price_lovelace: -1n }],
      ['price past uint64', { price_lovelace: 2n ** 64n }],
      ['supplier bond past uint64', { supplier_bond_lovelace: 2n ** 70n }],
      ['negative buyer bond', { buyer_bond_lovelace: -5n }],
      ['infinite window', { max_processing_ms: Number.POSITIVE_INFINITY }],
      ['negative window', { max_processing_ms: -1_000_000 }],
      ['window past the safe-integer range', { max_processing_ms: 1e30 }],
    ];
    for (const [name, over] of hostile) {
      assert.throws(() => planPostEscrow({ ...advert, ...over }, ADVERT_REF, OWN_PKH, 'x', NOW), (err: unknown) => {
        assert.ok(err instanceof Error, `${name}: an Error`);
        assert.match(err.message, new RegExp(`^Advert ${ADVERT_REF} (cannot be posted: its terms do not fit an escrow datum|has an unusable processing window)`), `${name}: ${err.message}`);
        return true;
      }, name);
    }
  });
});

describe('reserveCollateralInputs', () => {
  test('keeps the smallest pure 5-unit UTxO out of the inputs', () => {
    const reserved = reserveCollateralInputs(FIXTURE_UTXOS, 2_300_000n)!;
    assert.ok(reserved.every((u) => !(u.outputIndex === 1 && u.txHash === FIXTURE_TXHASH)), 'the 5 AP3X output must stay untouched');
  });
  test('returns undefined when no collateral candidate exists', () => {
    assert.equal(reserveCollateralInputs([{ ...FIXTURE_UTXOS[0], assets: { lovelace: 3_000_000n } }], 2_300_000n), undefined);
  });
  test('reserves the smallest of several candidates and leaves the rest, in order, without mutating the input', () => {
    const utxo = (i: number, assets: UTxO['assets']): UTxO => ({ ...FIXTURE_UTXOS[0], outputIndex: i, assets });
    const wallet = [utxo(0, { lovelace: 90_000_000n }), utxo(1, { lovelace: 7_000_000n }), utxo(2, { lovelace: 5_000_000n }), utxo(3, { lovelace: 5_000_000n }), utxo(4, { lovelace: 400_000_000n })];
    const snapshot = [...wallet];
    const reserved = reserveCollateralInputs(wallet, 2_300_000n)!;
    assert.deepEqual(reserved, [wallet[0], wallet[1], wallet[3], wallet[4]], 'of the two equal 5-unit outputs the first is held back');
    assert.deepEqual(wallet, snapshot);
  });
  test('a UTxO that carries tokens is never the collateral, however small', () => {
    const utxo = (i: number, assets: UTxO['assets']): UTxO => ({ ...FIXTURE_UTXOS[0], outputIndex: i, assets });
    const token = utxo(5, { lovelace: 5_000_000n, ['11'.repeat(28) + '54']: 1n });
    const pure = utxo(6, { lovelace: 7_000_000n });
    const big = utxo(7, { lovelace: 900_000_000n });
    assert.deepEqual(reserveCollateralInputs([token, pure, big], 2_300_000n), [token, big], 'the smallest PURE output is reserved, not the smaller one with a token');
    assert.equal(reserveCollateralInputs([token, utxo(8, { lovelace: 50_000_000n, ['22'.repeat(28) + '54']: 3n })], 2_300_000n), undefined, 'no pure output at all');
  });
  test('returns undefined when what is left cannot pay the lock, the minimum fee and one change output', () => {
    const wallet = [FIXTURE_UTXOS[1], { ...FIXTURE_UTXOS[1], outputIndex: 9, assets: { lovelace: 6_000_000n } }]; // reserve 5, keep 6
    assert.ok(reserveCollateralInputs(wallet, 6_000_000n - MARKETPLACE_MIN_FEE - 1_000_000n) !== undefined);
    assert.equal(reserveCollateralInputs(wallet, 6_000_000n - MARKETPLACE_MIN_FEE - 1_000_000n + 1n), undefined);
  });
});

// ─── The offline Post build ──────────────────────────────────────────────────
// The advert comes from Koios utxo_info (readAdvert) and its author from Koios tx_info; both are answered by this fake.
type KoiosFake = { f: typeof fetch; calls: Array<{ path: string; body: any }> };
function koiosFake(opts: { advertDatum?: string; address?: string; spent?: boolean | undefined; inputCreds?: unknown[]; txInfoStatus?: number } = {}): KoiosFake {
  const calls: KoiosFake['calls'] = [];
  const f = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const path = '/' + new URL(url).pathname.split('/').slice(-3).join('/'); // /api/v1/<route>, whatever prefix VECTOR_KOIOS_URL carries
    calls.push({ path, body });
    if (path === '/api/v1/utxo_info') {
      return new Response(JSON.stringify([{
        tx_hash: ADVERT_TX, tx_index: 0, address: opts.address ?? ADVERT_ADDRESS, value: '2000000',
        ...('spent' in opts ? { is_spent: opts.spent } : { is_spent: false }),
        inline_datum: { bytes: opts.advertDatum ?? ADVERT_DATUM_HEX },
      }]), { status: 200 });
    }
    if (path === '/api/v1/tx_info') {
      if (opts.txInfoStatus) return new Response('{}', { status: opts.txInfoStatus });
      const creds = opts.inputCreds ?? [ADVERT_EXPECTED.supplier_pkh];
      return new Response(JSON.stringify([{ tx_hash: ADVERT_TX, inputs: creds.map((cred, i) => ({ tx_hash: 'cc'.repeat(32), tx_index: i, payment_addr: { bech32: SUPPLIER_ADDRESS, cred }, stake_addr: null })) }]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
/** The live advert with one thing changed, re-encoded (Lucid-compact framing, which readAdvert decodes too). */
function advertWith(change: (c: Constr<Data>) => void): string {
  const c = Data.from(ADVERT_DATUM_HEX) as Constr<Data>;
  change(c);
  return Data.to(c);
}
const utxoInfoCalls = (k: KoiosFake) => k.calls.filter((c) => c.path === '/api/v1/utxo_info').length;
const txInfoCalls = (k: KoiosFake) => k.calls.filter((c) => c.path === '/api/v1/tx_info').length;

describe('buildPostEscrow (offline)', () => {
  const provider = new FixtureProvider(FIXTURE_UTXOS);
  let lucid: LucidEvolution;
  before(async () => { lucid = await lucidForAddress(provider, OWN_ADDRESS); });
  const post = (k: KoiosFake, over: Partial<Parameters<typeof buildPostEscrow>[2]> = {}) =>
    buildPostEscrow(lucid, provider, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW, ...over }, k.f);

  test('escrow output is index 0 at the escrow address with the planned datum', async () => {
    const k = koiosFake();
    const r = await post(k);
    const outs = outputs(r.txCbor);
    assert.equal(outs[0].address, ESCROW_ADDRESS);
    assert.equal(outs[0].lovelace, r.lockLovelace);
    const d = decodeEscrowDatum(outs[0].datum!);
    assert.equal(d.prompt_hash, promptHashForPayload('hello'));
    assert.equal(r.escrowRef, `${r.txHash}#0`);
    assert.equal(r.promptHash, promptHashForPayload('hello'));
  });
  test('the datum in the transaction is the marketplace-identical encoding of the plan, byte for byte', async () => {
    const r = await post(koiosFake());
    const plan = planPostEscrow(decodeAdvertDatum(ADVERT_DATUM_HEX), ADVERT_REF, OWN_PKH, 'hello', NOW);
    assert.equal(outputs(r.txCbor)[0].datum, encodeEscrowDatum(plan.datum));
    assert.equal(r.lockLovelace, plan.lockLovelace);
    assert.equal(r.deliverBy, plan.deliverBy);
  });
  test('returns what the signer needs to see: supplier key, endpoint host, capability, price and bonds, deadline, lock', async () => {
    const r = await post(koiosFake());
    assert.equal(r.supplierPkh, ADVERT_EXPECTED.supplier_pkh);
    assert.equal(r.endpointHost, 'mp-suppliers-chandra.hal8.ai');
    assert.equal(r.capabilityId, ADVERT_EXPECTED.capability_id);
    assert.deepEqual([r.priceLovelace, r.supplierBondLovelace, r.buyerBondLovelace], [200_000n, 1_000_000n, 1_000_000n]);
    assert.equal(r.deliverBy, NOW + ADVERT_EXPECTED.max_processing_ms + DELIVER_BY_BUFFER_MS);
    assert.equal(r.lockLovelace, ESCROW_LOCKED_LOVELACE);
    assert.match(r.fee, /^\d+$/);
  });
  test('reads the advert from Koios once and proves its author with tx_info asking for inputs', async () => {
    const k = koiosFake();
    await post(k);
    assert.equal(utxoInfoCalls(k), 1);
    assert.deepEqual(k.calls.find((c) => c.path === '/api/v1/utxo_info')!.body, { _utxo_refs: [ADVERT_REF], _extended: true });
    assert.equal(txInfoCalls(k), 1);
    assert.deepEqual(k.calls.find((c) => c.path === '/api/v1/tx_info')!.body, { _tx_hashes: [ADVERT_TX], _inputs: true, _assets: true });
  });
  test('holds the smallest pure 5-unit output back even when coin selection would reach for it, so Accept and Reclaim keep their collateral', async () => {
    // Lucid selects largest first: for a 6-unit lock out of [5, 4, 4] it would take the 5 and one 4.
    const at = (outputIndex: number, lovelace: bigint): UTxO => ({ txHash: FIXTURE_TXHASH, outputIndex, address: OWN_ADDRESS, assets: { lovelace } });
    const tight = new FixtureProvider([at(0, 5_000_000n), at(1, 4_000_000n), at(2, 4_000_000n)]);
    const tightLucid = await lucidForAddress(tight, OWN_ADDRESS);
    const dear = koiosFake({ advertDatum: advertWith((c) => { c.fields[5] = 4_000_000n; }) }); // price 4 + two bonds of 1
    const r = await buildPostEscrow(tightLucid, tight, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, dear.f);
    assert.equal(r.lockLovelace, 6_000_000n);
    assert.deepEqual(inputRefs(r.txCbor), [`${FIXTURE_TXHASH}#1`, `${FIXTURE_TXHASH}#2`], 'both 4-unit outputs are spent and the 5-unit one is not');
  });
  test('when the wallet cannot fund the lock without its 5-unit output, that output is spent and the change becomes the collateral', async () => {
    const at = (outputIndex: number, lovelace: bigint): UTxO => ({ txHash: FIXTURE_TXHASH, outputIndex, address: OWN_ADDRESS, assets: { lovelace } });
    const tight = new FixtureProvider([at(0, 5_000_000n), at(1, 4_000_000n), at(2, 4_000_000n)]);
    const tightLucid = await lucidForAddress(tight, OWN_ADDRESS);
    const dearer = koiosFake({ advertDatum: advertWith((c) => { c.fields[5] = 5_000_000n; }) }); // a 7-unit lock: 8 left after the reservation is short of 7 + fee + change
    const r = await buildPostEscrow(tightLucid, tight, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, dearer.f);
    assert.equal(r.lockLovelace, 7_000_000n);
    assert.ok(inputRefs(r.txCbor).includes(`${FIXTURE_TXHASH}#0`), 'the 5-unit output funds the lock');
  });
  test('requires the buyer key to sign and carries the validity window [now - 60 s, deliver_by] in slots of the Vector clock', async () => {
    const r = await post(koiosFake());
    const body = CML.Transaction.from_cbor_hex(r.txCbor).body();
    const signers = body.required_signers();
    assert.ok(signers && signers.len() === 1 && signers.get(0).to_hex() === OWN_PKH);
    const ZERO_TIME_MS = 1_756_485_600_000; // FixtureProvider.getSystemStartMs
    assert.equal(body.validity_interval_start(), BigInt(Math.floor((NOW - 60_000 - ZERO_TIME_MS) / 1000)));
    assert.equal(body.ttl(), BigInt(Math.floor((r.deliverBy - ZERO_TIME_MS) / 1000)));
    assert.ok(BigInt(r.fee) >= MARKETPLACE_MIN_FEE, `fee ${r.fee} is below the marketplace minimum`);
  });
  test('stamps posted_at from the clock when nowMs is not given', async () => {
    const before = Date.now();
    const { nowMs: _omitted, ...withoutNow } = { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW };
    const r = await buildPostEscrow(lucid, provider, withoutNow, koiosFake().f);
    const after = Date.now();
    const d = decodeEscrowDatum(outputs(r.txCbor)[0].datum!);
    assert.ok(d.posted_at >= before && d.posted_at <= after, `posted_at ${d.posted_at} not in [${before}, ${after}]`);
    assert.equal(d.deliver_by, d.posted_at + ADVERT_EXPECTED.max_processing_ms + DELIVER_BY_BUFFER_MS);
  });
  test('an explicit deliver_by flows into the datum, the validity end and the result', async () => {
    const deliverByMs = NOW + ADVERT_EXPECTED.max_processing_ms + 3_600_000;
    const r = await post(koiosFake(), { deliverByMs });
    assert.equal(r.deliverBy, deliverByMs);
    assert.equal(decodeEscrowDatum(outputs(r.txCbor)[0].datum!).deliver_by, deliverByMs);
  });

  // The advert is checked in this order: Koios read (existence, address, datum) → spent → text → plan → author.
  // Each refusal below also pins that nothing later was asked of Koios.
  test('refuses an advert Koios reports as spent (retired or replaced), without asking who made it', async () => {
    const k = koiosFake({ spent: true });
    await assert.rejects(() => post(k), new RegExp(`Advert ${ADVERT_REF} has been spent`));
    assert.equal(txInfoCalls(k), 0);
  });
  test('refuses an advert when Koios does not say whether it is spent', async () => {
    const k = koiosFake({ spent: undefined });
    await assert.rejects(() => post(k), new RegExp(`Koios did not report whether advert ${ADVERT_REF} is unspent`));
    assert.equal(txInfoCalls(k), 0);
  });
  test('refuses a retired advert', async () => {
    const k = koiosFake({ advertDatum: advertWith((c) => { c.fields[12] = new Constr(1, []); }) });
    await assert.rejects(() => post(k), /retired/);
    assert.equal(txInfoCalls(k), 0);
  });
  test('refuses an advert whose text is not valid UTF-8 (the escrow would not carry the advert\'s own bytes)', async () => {
    for (const [index, name] of [[1, 'capability_id'], [2, 'model'], [8, 'endpoint_url'], [9, 'detail_uri']] as const) {
      const k = koiosFake({ advertDatum: advertWith((c) => { c.fields[index] = '6161ff'; }) });
      await assert.rejects(() => post(k), /UTF-8/, name);
      assert.equal(txInfoCalls(k), 0, name);
    }
  });
  test('refuses what readAdvert refuses: a UTxO at the wrong address', async () => {
    const k = koiosFake({ address: ESCROW_ADDRESS });
    await assert.rejects(() => post(k), /not at the advert script address/);
    assert.equal(txInfoCalls(k), 0);
  });
  test('refuses a malformed advert ref without calling Koios', async () => {
    const k = koiosFake();
    await assert.rejects(() => post(k, { advertRef: 'nope#1' }), /Invalid out ref/);
    assert.equal(k.calls.length, 0);
  });
  test('refuses when the buyer is the supplier', async () => {
    const supplierAsBuyer = credentialToAddress('Mainnet', { type: 'Key', hash: ADVERT_EXPECTED.supplier_pkh });
    const k = koiosFake();
    await assert.rejects(() => post(k, { changeAddress: supplierAsBuyer }), /cannot be the supplier/);
    assert.equal(txInfoCalls(k), 0);
  });
  test('refuses a script change address', async () => {
    await assert.rejects(() => post(koiosFake(), { changeAddress: ESCROW_ADDRESS }), /verification key/);
  });
  test('refuses a hostile advert before building anything', async () => {
    const k = koiosFake({ advertDatum: advertWith((c) => { c.fields[5] = -1n; }) });
    await assert.rejects(() => post(k), new RegExp(`Advert ${ADVERT_REF} cannot be posted: its terms do not fit an escrow datum`));
    assert.equal(txInfoCalls(k), 0);
  });

  test('refuses an advert that its supplier key did not create: no input of the creating transaction is the supplier\'s', async () => {
    for (const inputCreds of [[OWN_PKH], ['bb'.repeat(28), 'cc'.repeat(28)], [null, 42]]) {
      await assert.rejects(() => post(koiosFake({ inputCreds })), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(`^Advert ${ADVERT_REF} was not created by its supplier key`));
        assert.ok(err.message.includes(ADVERT_EXPECTED.supplier_pkh), 'names the key it expected');
        return true;
      }, JSON.stringify(inputCreds));
    }
  });
  test('accepts an advert funded by several inputs when one of them is the supplier\'s (credential case ignored)', async () => {
    const r = await post(koiosFake({ inputCreds: ['bb'.repeat(28), ADVERT_EXPECTED.supplier_pkh.toUpperCase()] }));
    assert.equal(outputs(r.txCbor)[0].address, ESCROW_ADDRESS);
  });
  test('a Koios failure while proving the author fails closed with a message that says which step it was', async () => {
    await assert.rejects(() => post(koiosFake({ txInfoStatus: 503 })), new RegExp(`Could not check who created advert ${ADVERT_REF}: Koios tx_info answered 503$`));
  });

  test('a wallet too small for the lock is a rejection, never a partial transaction', async () => {
    const small = new FixtureProvider([{ ...FIXTURE_UTXOS[0], assets: { lovelace: 2_000_000n } }]);
    const smallLucid = await lucidForAddress(small, OWN_ADDRESS);
    await assert.rejects(() => buildPostEscrow(smallLucid, small, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, koiosFake().f), /does not have enough funds/);
  });
  test('a wallet with no pure 5-unit output still builds (the change becomes the next collateral)', async () => {
    const single = new FixtureProvider([{ ...FIXTURE_UTXOS[0], assets: { lovelace: 800_000_000n } }]);
    const singleLucid = await lucidForAddress(single, OWN_ADDRESS);
    const r = await buildPostEscrow(singleLucid, single, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, koiosFake().f);
    const outs = outputs(r.txCbor);
    assert.equal(outs[0].address, ESCROW_ADDRESS);
    assert.ok(outs.slice(1).some((o) => o.address === OWN_ADDRESS && o.lovelace >= 5_000_000n), 'a change output of at least 5 units');
  });
});

describe('planAccept / planReclaim', () => {
  const base = { ...ESCROW_EXPECTED, submitted_at: 1_786_530_100_000, result_receipt_hash: 'ab'.repeat(32), state: 'Submitted' as const };
  test('accept pays supplier price + supplier bond and returns the buyer bond', () => {
    const p = planAccept(base, ESCROW_EXPECTED.buyer_pkh, 1_786_530_200_000);
    assert.equal(p.supplierLovelace, 1_200_000n);
    assert.equal(p.buyerLovelace, 1_000_000n);
    assert.equal(p.validTo, base.submitted_at + ACCEPT_WINDOW_MS);
    assert.equal(p.redeemerHex, 'd87b80');
  });
  test('accept pays the supplier at the enterprise address of its key and reports the seconds left in the window', () => {
    const p = planAccept(base, ESCROW_EXPECTED.buyer_pkh, 1_786_530_200_000);
    assert.equal(p.supplierAddress, SUPPLIER_ADDRESS);
    assert.equal(p.validFrom, 1_786_530_200_000 - 60_000);
    assert.equal(p.secondsLeft, Math.floor((base.submitted_at + ACCEPT_WINDOW_MS - 1_786_530_200_000) / 1000));
  });
  test('accept lifts a payout below the minimum output to the minimum', () => {
    const p = planAccept({ ...base, payment_lovelace: 1n, supplier_bond_lovelace: 1n, buyer_bond_lovelace: 1n }, ESCROW_EXPECTED.buyer_pkh, base.submitted_at);
    assert.equal(p.supplierLovelace, 1_000_000n);
    assert.equal(p.buyerLovelace, 1_000_000n);
  });
  test('accept refuses the wrong buyer, the wrong state and a closed window', () => {
    assert.throws(() => planAccept(base, 'cc'.repeat(28), 1_786_530_200_000), /not the buyer/);
    assert.throws(() => planAccept({ ...base, state: 'Open' }, ESCROW_EXPECTED.buyer_pkh, 1), /Submitted/);
    assert.throws(() => planAccept(base, ESCROW_EXPECTED.buyer_pkh, base.submitted_at + ACCEPT_WINDOW_MS + 1), /window/);
  });
  test('accept is still open on the last millisecond of the window', () => {
    assert.equal(planAccept(base, ESCROW_EXPECTED.buyer_pkh, base.submitted_at + ACCEPT_WINDOW_MS).secondsLeft, 0);
  });
  test('reclaim returns everything after deliver_by for Open or Claimed only', () => {
    const open = { ...ESCROW_EXPECTED };
    const p = planReclaim(open, ESCROW_EXPECTED.buyer_pkh, open.deliver_by + 1000);
    assert.equal(p.buyerLovelace, 2_200_000n);
    assert.equal(p.redeemerHex, 'd87c80');
    assert.throws(() => planReclaim(open, ESCROW_EXPECTED.buyer_pkh, open.deliver_by - 1), /deliver_by/);
    assert.throws(() => planReclaim(base, ESCROW_EXPECTED.buyer_pkh, base.deliver_by + 1), /Open or Claimed/);
  });
  test('reclaim also covers a Claimed escrow, opens exactly at deliver_by, and only for the buyer', () => {
    const claimed = { ...ESCROW_EXPECTED, state: 'Claimed' as const };
    const p = planReclaim(claimed, ESCROW_EXPECTED.buyer_pkh, claimed.deliver_by);
    assert.equal(p.validFrom, claimed.deliver_by, 'the validity window starts at deliver_by, not before');
    assert.ok(p.validTo > p.validFrom);
    assert.throws(() => planReclaim(claimed, 'cc'.repeat(28), claimed.deliver_by + 1), /not the buyer/);
  });
});
