// packages/builder/test/marketplace-build.test.ts
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CML, Constr, Data, getAddressDetails, credentialToAddress, unixTimeToSlot, slotToUnixTime, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS, FIXTURE_TXHASH, FIXTURE_TOKEN_UNIT } from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE, ESCROW_OPEN_DATUM_HEX, ESCROW_REF,
} from './fixtures/marketplace.fixture.ts';
import { ESCROW_SCRIPT_CBOR } from './fixtures/escrow-script.fixture.ts';
import {
  ADVERT_ADDRESS, ESCROW_ADDRESS, ESCROW_REF_UTXO, ESCROW_SCRIPT_HASH, DELIVER_BY_BUFFER_MS, ACCEPT_WINDOW_MS, MARKETPLACE_MIN_FEE,
  MAX_PROCESSING_MS_CEILING, COLLATERAL_MIN_LOVELACE,
} from '../src/vector/marketplace-constants.ts';
import { ensureSlotConfig, paymentKeyHashOf as govPaymentKeyHashOf } from '../src/vector/gov-build.ts';
import { decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, formatOutRef, promptHashForPayload } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../src/vector/marketplace-datum.ts';
import {
  planPostEscrow, buildPostEscrow, reserveCollateralInputs, planAccept, planReclaim, paymentKeyHashOf, enterpriseAddressOf,
  assertEscrowIsOutputZero, resolveEscrowLineage, buildAccept, buildReclaim,
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
  test('paymentKeyHashOf is the gov-build function, re-exported: one definition', () => {
    assert.equal(paymentKeyHashOf, govPaymentKeyHashOf);
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
  test('refuses an advert whose processing window is longer than 24 h, and lets exactly 24 h through', () => {
    assert.equal(MAX_PROCESSING_MS_CEILING, 86_400_000);
    const plan = (max_processing_ms: number) => planPostEscrow({ ...advert, max_processing_ms }, ADVERT_REF, OWN_PKH, 'x', NOW);
    assert.equal(plan(MAX_PROCESSING_MS_CEILING).deliverBy, NOW + MAX_PROCESSING_MS_CEILING + DELIVER_BY_BUFFER_MS);
    assert.throws(() => plan(MAX_PROCESSING_MS_CEILING + 1), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(`^Advert ${ADVERT_REF} advertises a processing window of ${MAX_PROCESSING_MS_CEILING + 1} ms, longer than`));
      return true;
    });
  });
  test('refuses a caller deliver_by more than 24 h plus the buffer from now, and lets exactly that limit through', () => {
    const limit = NOW + MAX_PROCESSING_MS_CEILING + DELIVER_BY_BUFFER_MS;
    assert.equal(planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, limit).deliverBy, limit);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, limit + 1), /deliver_by is \d+ ms from now/);
  });
  test('catches a deliver_by given in microseconds (too far away) or in seconds (inside the supplier\'s window)', () => {
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, NOW * 1000), /deliver_by is .* POSIX milliseconds/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'x', NOW, Math.floor(NOW / 1000) + 3600), /deliver_by must leave the supplier its full window/);
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
    const datumFit = 'cannot be posted: its terms do not fit an escrow datum';
    const unusable = 'has an unusable processing window';
    const hostile: Array<[string, Partial<typeof advert>, string]> = [
      ['negative price', { price_lovelace: -1n }, datumFit],
      ['price past uint64', { price_lovelace: 2n ** 64n }, datumFit],
      ['supplier bond past uint64', { supplier_bond_lovelace: 2n ** 70n }, datumFit],
      ['negative buyer bond', { buyer_bond_lovelace: -5n }, datumFit],
      ['infinite window', { max_processing_ms: Number.POSITIVE_INFINITY }, unusable],
      ['negative window', { max_processing_ms: -1_000_000 }, unusable],
      ['fractional window', { max_processing_ms: 1.5 }, unusable],
      ['window past the safe-integer range', { max_processing_ms: 1e30 }, 'advertises a processing window of'],
    ];
    for (const [name, over, message] of hostile) {
      assert.throws(() => planPostEscrow({ ...advert, ...over }, ADVERT_REF, OWN_PKH, 'x', NOW), (err: unknown) => {
        assert.ok(err instanceof Error, `${name}: an Error`);
        assert.match(err.message, new RegExp(`^Advert ${ADVERT_REF} ${message}`), `${name}: ${err.message}`);
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
  test('removes the reserved output by outref, so a structural copy of it in the list cannot slip into the inputs', () => {
    const utxo = (i: number, assets: UTxO['assets']): UTxO => ({ ...FIXTURE_UTXOS[0], outputIndex: i, assets });
    const collateral = utxo(1, { lovelace: 5_000_000n });
    const big = utxo(2, { lovelace: 900_000_000n });
    const copy: UTxO = { ...collateral, assets: { ...collateral.assets } };
    assert.notEqual(copy, collateral);
    assert.deepEqual(reserveCollateralInputs([big, collateral, copy], 2_300_000n), [big]);
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
function koiosFake(opts: { advertDatum?: string; address?: string; spent?: boolean | undefined; inputCreds?: unknown[]; utxoInfoStatus?: number; txInfoStatus?: number } = {}): KoiosFake {
  const calls: KoiosFake['calls'] = [];
  const f = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const path = '/' + new URL(url).pathname.split('/').slice(-3).join('/'); // /api/v1/<route>, whatever prefix VECTOR_KOIOS_URL carries
    calls.push({ path, body });
    if (path === '/api/v1/utxo_info') {
      if (opts.utxoInfoStatus) return new Response('{}', { status: opts.utxoInfoStatus });
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
    assert.equal(r.collateralKept, true, 'the default wallet has a 5-unit output to spare and the rest funds the lock');
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
  test('a wallet whose only pure output is needed for the lock still builds, reports collateralKept false, and the change replaces it', async () => {
    const single = new FixtureProvider([{ ...FIXTURE_UTXOS[0], assets: { lovelace: 800_000_000n } }]);
    const singleLucid = await lucidForAddress(single, OWN_ADDRESS);
    const r = await buildPostEscrow(singleLucid, single, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, koiosFake().f);
    const outs = outputs(r.txCbor);
    assert.equal(outs[0].address, ESCROW_ADDRESS);
    assert.equal(r.collateralKept, false);
    assert.ok(outs.slice(1).some((o) => o.address === OWN_ADDRESS && o.lovelace >= 5_000_000n), 'the change output is at least 5 units here, but nothing guarantees that in general');
  });
  test('a wallet with no pure 5-unit output at all builds and reports collateralKept false', async () => {
    const at = (outputIndex: number): UTxO => ({ txHash: FIXTURE_TXHASH, outputIndex, address: OWN_ADDRESS, assets: { lovelace: 4_000_000n } });
    const small = new FixtureProvider([at(0), at(1), at(2)]);
    const smallLucid = await lucidForAddress(small, OWN_ADDRESS);
    const r = await buildPostEscrow(smallLucid, small, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, koiosFake().f);
    assert.equal(outputs(r.txCbor)[0].address, ESCROW_ADDRESS);
    assert.equal(r.collateralKept, false);
  });
  test('when the reserved selection cannot complete (change with a token needs more lovelace), it retries with the whole wallet and says the collateral was not kept', async () => {
    // The reservation's arithmetic is lovelace only: 3.8 units clears lock + fee + 1 for change, but the change carries a token and needs more.
    const wallet: UTxO[] = [
      { txHash: FIXTURE_TXHASH, outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 5_000_000n } },
      { txHash: FIXTURE_TXHASH, outputIndex: 1, address: OWN_ADDRESS, assets: { lovelace: 3_800_000n, ['11'.repeat(28) + '54']: 1n } },
    ];
    assert.ok(reserveCollateralInputs(wallet, ESCROW_LOCKED_LOVELACE) !== undefined, 'the reservation believes the rest is enough');
    const tight = new FixtureProvider(wallet);
    const tightLucid = await lucidForAddress(tight, OWN_ADDRESS);
    const r = await buildPostEscrow(tightLucid, tight, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, koiosFake().f);
    assert.equal(r.collateralKept, false);
    assert.ok(inputRefs(r.txCbor).includes(`${FIXTURE_TXHASH}#0`), 'the held-back output was needed after all');
    assert.equal(outputs(r.txCbor)[0].address, ESCROW_ADDRESS);
  });
  test('when the whole-wallet retry fails too, its error keeps the reason the first attempt failed as its cause', async () => {
    // Both attempts fail, each in its own words: first the selection that holds the collateral output back, then the whole wallet.
    const failing = {
      ...lucid,
      newTx: () => {
        const tx = lucid.newTx();
        tx.complete = (async (options?: { presetWalletInputs?: UTxO[] }) => {
          throw new Error(options?.presetWalletInputs ? 'reserved selection failed' : 'whole wallet failed');
        }) as unknown as typeof tx.complete;
        return tx;
      },
    } as LucidEvolution;
    await assert.rejects(() => buildPostEscrow(failing, provider, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, koiosFake().f), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'whole wallet failed');
      const { cause } = err as Error & { cause?: unknown };
      assert.ok(cause instanceof Error, 'the first attempt failure is attached');
      assert.equal(cause.message, 'reserved selection failed');
      return true;
    });
  });
  test('a Koios failure while reading the advert names the advert and the step', async () => {
    await assert.rejects(() => post(koiosFake({ utxoInfoStatus: 502 })), new RegExp(`Could not read advert ${ADVERT_REF}: Koios utxo_info answered 502$`));
  });
  test('checks that the escrow really is output 0 before returning the transaction (escrow_ref assumes it)', async () => {
    // A lucid whose builder puts another payment first, so the escrow lands at output 1 and escrow_ref would point at the wrong output.
    const rogue = { ...lucid, newTx: () => lucid.newTx().pay.ToAddress(OWN_ADDRESS, { lovelace: 1_500_000n }) } as LucidEvolution;
    await assert.rejects(() => buildPostEscrow(rogue, provider, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: NOW }, koiosFake().f), /output 0/);
  });
});

describe('assertEscrowIsOutputZero', () => {
  const provider = new FixtureProvider(FIXTURE_UTXOS);
  let lucid: LucidEvolution;
  const plan = planPostEscrow(decodeAdvertDatum(ADVERT_DATUM_HEX), ADVERT_REF, OWN_PKH, 'hello', NOW);
  const expected = { datumHex: encodeEscrowDatum(plan.datum), lockLovelace: plan.lockLovelace };
  type Tx = ReturnType<LucidEvolution['newTx']>;
  const cbor = async (build: (tx: Tx) => Tx) => (await build(lucid.newTx()).complete()).toCBOR();
  const escrow = (tx: Tx, over: { lovelace?: bigint; datum?: string; kind?: 'inline' | 'asHash' } = {}) =>
    tx.pay.ToAddressWithData(ESCROW_ADDRESS, { kind: over.kind ?? 'inline', value: over.datum ?? expected.datumHex }, { lovelace: over.lovelace ?? expected.lockLovelace });
  before(async () => { lucid = await lucidForAddress(provider, OWN_ADDRESS); });

  test('accepts a transaction whose output 0 is the escrow with the planned datum and lock', async () => {
    assertEscrowIsOutputZero(await cbor((tx) => escrow(tx)), expected);
  });
  test('refuses an output 0 that is not at the escrow address', async () => {
    const tx = await cbor((t) => t.pay.ToAddress(OWN_ADDRESS, { lovelace: expected.lockLovelace }));
    assert.throws(() => assertEscrowIsOutputZero(tx, expected), /output 0/);
  });
  test('refuses the planned datum and lock paid to another address', async () => {
    const tx = await cbor((t) => t.pay.ToAddressWithData(OWN_ADDRESS, { kind: 'inline', value: expected.datumHex }, { lovelace: expected.lockLovelace }));
    assert.throws(() => assertEscrowIsOutputZero(tx, expected), /output 0/);
  });
  test('refuses a transaction with no outputs at all', () => {
    // body {inputs: [], outputs: [], fee: 0}, empty witness set, valid, no auxiliary data: the smallest thing CML parses
    assert.throws(() => assertEscrowIsOutputZero('84a3008001800200a0f5f6', expected), /output 0/);
  });
  test('refuses an escrow that is output 1 behind another payment', async () => {
    const tx = await cbor((t) => escrow(t.pay.ToAddress(OWN_ADDRESS, { lovelace: 1_500_000n })));
    assert.throws(() => assertEscrowIsOutputZero(tx, expected), /output 0/);
  });
  test('refuses another lock amount', async () => {
    const tx = await cbor((t) => escrow(t, { lovelace: expected.lockLovelace + 1n }));
    assert.throws(() => assertEscrowIsOutputZero(tx, expected), /output 0/);
  });
  test('refuses another datum', async () => {
    const tx = await cbor((t) => escrow(t, { datum: encodeEscrowDatum({ ...plan.datum, prompt_hash: 'ab'.repeat(32) }) }));
    assert.throws(() => assertEscrowIsOutputZero(tx, expected), /output 0/);
  });
  test('refuses a datum hash in place of the inline datum', async () => {
    const tx = await cbor((t) => escrow(t, { kind: 'asHash' }));
    assert.throws(() => assertEscrowIsOutputZero(tx, expected), /output 0/);
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
  test('reclaim also covers a Claimed escrow, and only for the buyer', () => {
    const claimed = { ...ESCROW_EXPECTED, state: 'Claimed' as const };
    const opensAt = Math.ceil((claimed.deliver_by + 1) / 1000) * 1000;
    assert.equal(planReclaim(claimed, ESCROW_EXPECTED.buyer_pkh, opensAt).redeemerHex, 'd87c80');
    assert.throws(() => planReclaim(claimed, 'cc'.repeat(28), opensAt), /not the buyer/);
  });
});

// escrow.ak handle_reclaim requires after_or_at(validity_range, deliver_by): the lower bound as the script sees it must be
// >= deliver_by (common.ak after_or_at, inclusive branch). Lucid turns validFrom into the slot that CONTAINS it (floor) and the
// script sees that slot's start, so a validFrom taken straight from an unaligned deliver_by lands up to 999 ms before it and the
// validator would reject the transaction. The plan therefore opens at the first whole second strictly after deliver_by.
describe('planReclaim validity range', () => {
  before(async () => { await ensureSlotConfig(new FixtureProvider([])); });
  const lowerBoundMs = (validFrom: number) => slotToUnixTime('Mainnet', unixTimeToSlot('Mainnet', validFrom));
  const buyer = ESCROW_EXPECTED.buyer_pkh;
  const open = { ...ESCROW_EXPECTED }; // deliver_by 1786530304711: not a whole second
  const opens = Math.ceil((open.deliver_by + 1) / 1000) * 1000; // 1786530305000

  test('the fixture deliver_by is not second-aligned, which is what makes a validFrom of deliver_by itself wrong', () => {
    assert.notEqual(open.deliver_by % 1000, 0);
    assert.ok(lowerBoundMs(open.deliver_by) < open.deliver_by, 'the slot Lucid picks for deliver_by starts before it');
  });
  test('is refused at deliver_by itself and until the next whole second, with an error that names deliver_by and when it opens', () => {
    for (const now of [open.deliver_by, open.deliver_by + 1, opens - 1]) {
      assert.throws(() => planReclaim(open, buyer, now), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /deliver_by/);
        assert.match(err.message, /opens/);
        assert.ok(err.message.includes(new Date(open.deliver_by).toISOString()), err.message);
        assert.ok(err.message.includes(new Date(opens).toISOString()), err.message);
        return true;
      }, `now = ${now}`);
    }
  });
  test('at the opening second the validity start, as the slot Lucid picks, is not before deliver_by', () => {
    const p = planReclaim(open, buyer, opens);
    assert.equal(p.validFrom, opens);
    assert.ok(lowerBoundMs(p.validFrom) >= open.deliver_by, `lower bound ${lowerBoundMs(p.validFrom)} is before deliver_by ${open.deliver_by}`);
  });
  test('later reclaims keep the lower bound at or after the opening second and leave ten minutes to sign', () => {
    for (const later of [1, 59_999, 60_000, 60_001, 3_600_000 + 123]) {
      const now = opens + later;
      const p = planReclaim(open, buyer, now);
      assert.equal(p.validFrom, Math.max(opens, now - 60_000), `later = ${later}`);
      assert.ok(lowerBoundMs(p.validFrom) >= open.deliver_by, `later = ${later}`);
      assert.equal(p.validTo, now + 600_000, `later = ${later}`);
    }
  });
  test('an aligned deliver_by opens one whole second after it: strictly after, never at', () => {
    const aligned = { ...open, deliver_by: 1_786_530_304_000 };
    assert.throws(() => planReclaim(aligned, buyer, aligned.deliver_by), /opens/);
    assert.throws(() => planReclaim(aligned, buyer, aligned.deliver_by + 999), /opens/);
    assert.equal(planReclaim(aligned, buyer, aligned.deliver_by + 1000).validFrom, aligned.deliver_by + 1000);
  });
  test('for any deliver_by the first accepted reclaim has a lower bound the validator accepts, and the buyer waits at most one extra second', () => {
    let x = 20260; // a fixed LCG, so a failure reproduces
    for (let i = 0; i < 400; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const d = { ...open, deliver_by: 1_786_530_000_000 + (x % 5_000_000) };
      const opensAt = Math.ceil((d.deliver_by + 1) / 1000) * 1000;
      assert.throws(() => planReclaim(d, buyer, opensAt - 1), /opens/, `deliver_by ${d.deliver_by}`);
      const p = planReclaim(d, buyer, opensAt);
      assert.ok(lowerBoundMs(p.validFrom) >= d.deliver_by, `deliver_by ${d.deliver_by}`);
      assert.ok(opensAt - d.deliver_by <= 1000, `deliver_by ${d.deliver_by}`);
    }
  });
});

// ─── Escrow lineage ──────────────────────────────────────────────────────────
// Koios utxo_info for the Post output of the live escrow fixture. A `null` option leaves that field out, as Koios does when it
// does not know it. `status` answers with an error whose body carries things a caller must never see; `raw` is the response text.
const ESCROW_TX = ESCROW_REF.slice(0, 64);
function escrowKoios(o: { datumHex?: string | null; address?: string | null; spent?: boolean | null; rows?: unknown[]; status?: number; raw?: string } = {}): KoiosFake {
  const calls: KoiosFake['calls'] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ path: '/' + new URL(url).pathname.split('/').slice(-3).join('/'), body: JSON.parse(init.body) });
    if (o.status) return new Response('{"error":"db password=hunter2 at https://internal.koios.example"}', { status: o.status });
    if (o.raw !== undefined) return new Response(o.raw, { status: 200 });
    const row = {
      tx_hash: ESCROW_TX, tx_index: 0, value: '2261030',
      ...(o.address === null ? {} : { address: o.address ?? ESCROW_ADDRESS }),
      ...(o.spent === null ? {} : { is_spent: o.spent ?? true }),
      inline_datum: o.datumHex === null ? null : { bytes: o.datumHex ?? ESCROW_OPEN_DATUM_HEX },
    };
    return new Response(JSON.stringify(o.rows ?? [row]), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** An output at the escrow address holding the live escrow's lock and the given datum. */
const escrowAt = (txHash: string, datum: EscrowDatum, over: Partial<UTxO> = {}): UTxO =>
  ({ txHash, outputIndex: 0, address: ESCROW_ADDRESS, assets: { lovelace: ESCROW_LOCKED_LOVELACE }, datum: encodeEscrowDatum(datum), ...over });

describe('resolveEscrowLineage', () => {
  const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
  const submitted = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' as const };
  const at = escrowAt;
  const current = at('ee'.repeat(32), submitted);
  const stranger = at('ff'.repeat(32), { ...submitted, posted_at: 1 });
  const postOutput = at(ESCROW_TX, posted); // the Post output itself, as the node lists it while it is unspent
  const koios = escrowKoios().f;
  const lineage = (utxos: UTxO[], k: KoiosFake = escrowKoios()) => resolveEscrowLineage(new FixtureProvider(utxos), 'https://koios.example', ESCROW_REF, k.f);
  /** The error names the escrow it was asked about, in the words of `message`. */
  const refusal = (message: RegExp) => (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, message);
    assert.ok(err.message.includes(ESCROW_REF), `the escrow ref is missing from: ${err.message}`);
    return true;
  };

  test('finds the current UTxO by advert_ref, buyer, posted_at and prompt_hash', async () => {
    const r = await resolveEscrowLineage(new FixtureProvider([current, stranger]), 'https://koios.example', ESCROW_REF, koios);
    assert.equal(r.spent, true);
    assert.equal(r.current?.utxo.txHash, 'ee'.repeat(32));
    assert.equal(r.current?.datum.state, 'Submitted');
    assert.deepEqual(r.posted, posted, 'posted stays the datum of the output the ref names');
  });
  test('every field of the lineage rule matters: a UTxO that differs in any one of them belongs to another escrow', async () => {
    const differing: Array<[string, Partial<EscrowDatum>]> = [
      ['advert_ref.txHash', { advert_ref: { ...submitted.advert_ref, txHash: 'aa'.repeat(32) } }],
      ['advert_ref.index', { advert_ref: { ...submitted.advert_ref, index: submitted.advert_ref.index + 1 } }],
      ['buyer_pkh', { buyer_pkh: 'aa'.repeat(28) }],
      ['posted_at', { posted_at: submitted.posted_at + 1 }],
      ['prompt_hash', { prompt_hash: 'aa'.repeat(32) }],
    ];
    for (const [field, change] of differing) {
      assert.equal((await lineage([at('dd'.repeat(32), { ...submitted, ...change })])).current, null, field);
    }
    // what Claim and Submit do change (state, submitted_at, the receipt hash) does not make it another escrow
    assert.equal((await lineage([at('dd'.repeat(32), { ...submitted, state: 'Claimed', submitted_at: null, result_receipt_hash: null })])).current?.datum.state, 'Claimed');
  });
  test('returns current = null when the lineage is finished', async () => {
    const r = await resolveEscrowLineage(new FixtureProvider([stranger]), 'https://koios.example', ESCROW_REF, koios);
    assert.equal(r.current, null);
    assert.equal(r.spent, true);
  });
  test('while the Post output is unspent it is the live escrow: the node\'s copy of it is current', async () => {
    const r = await lineage([postOutput], escrowKoios({ spent: false }));
    assert.equal(r.spent, false);
    assert.equal(r.current?.utxo, postOutput);
    assert.equal(r.current?.datum.state, 'Open');
  });
  test('asks Koios for the canonical lowercase ref, and a malformed ref is refused without calling Koios', async () => {
    const k = escrowKoios({ spent: false });
    await resolveEscrowLineage(new FixtureProvider([postOutput]), 'https://koios.example', `  ${ESCROW_TX.toUpperCase()}#0 `, k.f);
    assert.deepEqual(k.calls.map((c) => c.body), [{ _utxo_refs: [ESCROW_REF], _extended: true }]);
    const unused = escrowKoios();
    await assert.rejects(() => resolveEscrowLineage(new FixtureProvider([]), 'https://koios.example', 'nope#1', unused.f), /Invalid out ref/);
    assert.equal(unused.calls.length, 0);
  });
  test('UTxOs at the escrow address that hold no datum or one that is not an escrow are ignored', async () => {
    const noDatum = at('aa'.repeat(32), submitted, { datum: undefined });
    const junk = at('bb'.repeat(32), submitted, { datum: 'ff' });
    const r = await lineage([noDatum, junk, current]);
    assert.equal(r.current?.utxo.txHash, 'ee'.repeat(32));
  });

  // Fail closed. Tool output goes to anonymous callers: a Koios failure names the escrow and the failure, never the
  // (operator-configured) endpoint or a snippet of a response body.
  test('a Koios failure is an Error that names the escrow and carries neither the endpoint nor a response body', async () => {
    const LEAKS = ['http://', 'https://', 'koios.example', 'internal', 'hunter2', 'Bad Gateway', '<html', 'ECONNREFUSED'];
    const rejecting = (error: Error) => (async () => { throw error; }) as unknown as typeof fetch;
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const cases: Array<[string, typeof fetch, RegExp]> = [
      ['an HTTP error whose body names internals', escrowKoios({ status: 503 }).f, /: Koios utxo_info answered 503$/],
      ['a 200 that is not JSON', escrowKoios({ raw: '<html>502 Bad Gateway from internal.koios.example</html>' }).f, /: Koios utxo_info: response was not valid JSON$/],
      ['a 200 that is not a list', escrowKoios({ raw: '{"error":"internal.koios.example is down"}' }).f, /: Koios utxo_info: Koios returned a non-list response$/],
      ['a transport error that names the endpoint', rejecting(new TypeError('connect ECONNREFUSED https://koios.example:8443/api/v1/utxo_info')), /: Koios request failed \(network error or timeout\)$/],
      ['a timeout', rejecting(timeout), /: Koios request failed \(network error or timeout\)$/],
    ];
    for (const [name, f, message] of cases) {
      await assert.rejects(() => resolveEscrowLineage(new FixtureProvider([current]), 'https://koios.example', ESCROW_REF, f), (err: unknown) => {
        assert.ok(err instanceof Error, name);
        assert.ok(err.message.startsWith(`Could not read escrow ${ESCROW_REF}: `), `${name}: ${err.message}`);
        assert.match(err.message, message, name);
        for (const leak of LEAKS) assert.ok(!err.message.includes(leak), `${name}: "${leak}" leaked into: ${err.message}`);
        return true;
      }, name);
    }
  });
  test('an output Koios does not know, or answers for a different output, is not found', async () => {
    const other = [{ tx_hash: 'ab'.repeat(32), tx_index: 0, address: ESCROW_ADDRESS, value: '1', is_spent: false, inline_datum: { bytes: ESCROW_OPEN_DATUM_HEX } }];
    for (const rows of [[], other]) await assert.rejects(() => lineage([current], escrowKoios({ rows })), refusal(/not found on the ledger/));
  });
  test('refuses a Post output that is not at the escrow script address, or whose address Koios leaves out', async () => {
    for (const address of [ADVERT_ADDRESS, OWN_ADDRESS, null]) {
      await assert.rejects(() => lineage([current], escrowKoios({ address })), refusal(/^UTxO .* is not at the escrow script address\.$/), String(address));
    }
  });
  test('refuses an output that holds no escrow datum', async () => {
    for (const datumHex of [null, ADVERT_DATUM_HEX, 'ff', 'zz']) {
      await assert.rejects(() => lineage([current], escrowKoios({ datumHex })), refusal(/^UTxO .* does not hold an escrow datum\.$/), String(datumHex).slice(0, 8));
    }
  });
  test('fails closed when Koios does not say whether the Post output is spent, whatever the node holds', async () => {
    for (const held of [[], [postOutput], [current], [postOutput, current]]) {
      await assert.rejects(() => lineage(held, escrowKoios({ spent: null })), refusal(/did not report whether escrow .* is spent/));
    }
  });
  test('fails closed when Koios says the Post output is unspent but the node does not list it as an escrow output', async () => {
    const noDatum = at(ESCROW_TX, posted, { datum: undefined });
    const elsewhere = at(ESCROW_TX, posted, { address: OWN_ADDRESS });
    for (const held of [[], [noDatum], [elsewhere], [current]]) {
      await assert.rejects(() => lineage(held, escrowKoios({ spent: false })), refusal(/unspent, but the node does not list it as a live escrow output/));
    }
  });

  // Anyone can lock a UTxO at the escrow address with any datum. Accept pays the datum's amounts, and the wallet makes up what
  // the escrow output does not cover, so an output that holds less than its datum owes must never count as an escrow.
  test('skips a copy of the escrow that holds less than its datum says it owes, wherever it is listed', async () => {
    const inflated = at('dd'.repeat(32), { ...submitted, payment_lovelace: 500_000_000n });
    assert.equal((await lineage([inflated])).current, null, 'only the decoy: nothing live');
    assert.equal((await lineage([inflated, current])).current?.utxo.txHash, 'ee'.repeat(32));
    assert.equal((await lineage([current, inflated])).current?.utxo.txHash, 'ee'.repeat(32));
  });
  test('holding exactly what it owes is enough, one lovelace short is not', async () => {
    const owed = posted.payment_lovelace + posted.buyer_bond_lovelace + posted.supplier_bond_lovelace;
    assert.equal(owed, 2_200_000n);
    assert.equal((await lineage([{ ...current, assets: { lovelace: owed } }])).current?.utxo.txHash, 'ee'.repeat(32));
    assert.equal((await lineage([{ ...current, assets: { lovelace: owed - 1n } }])).current, null);
  });
  test('refuses an unspent Post output that holds less than its datum owes', async () => {
    const thin = at(ESCROW_TX, posted, { assets: { lovelace: 1_000_000n } });
    await assert.rejects(() => lineage([thin], escrowKoios({ spent: false })), refusal(/is not funded: its datum owes 2200000 lovelace but the output holds 1000000/));
  });
  test('refuses to choose between two funded UTxOs that both claim to continue the escrow', async () => {
    const twin = at('dd'.repeat(32), submitted);
    await assert.rejects(() => lineage([current, twin]), refusal(/More than one live UTxO at the escrow address continues escrow/));
  });
  test('the Post output is not its own continuation when a node that lags Koios still lists it', async () => {
    assert.equal((await lineage([postOutput])).current, null);
  });
});

// ─── Accept and Reclaim (offline) ────────────────────────────────────────────
// In production the node (Ogmios) evaluates the script while the transaction is completed: the builders tell Lucid not to do it
// locally. This provider answers that call with a fixed budget per redeemer and counts the calls. It lets Lucid finish assembling
// the transaction and says nothing about whether the validator would accept it; that is for the first-party E2E before any deploy.
// What these tests do check is what the validator reads off the transaction: the redeemer, the signer, the outputs to each key and
// the validity range, plus the shape of a script spend (reference script, collateral, fee).
const REF_SCRIPT_UTXO: UTxO = {
  txHash: ESCROW_REF_UTXO.txHash, outputIndex: ESCROW_REF_UTXO.outputIndex, address: FOREIGN_ADDRESS,
  assets: { lovelace: 60_000_000n }, scriptRef: { type: 'PlutusV3', script: ESCROW_SCRIPT_CBOR },
};
function evaluatingProvider(utxos: UTxO[]) {
  const evaluations: string[] = [];
  const evaluateTx = async (txCborHex: string) => {
    evaluations.push(txCborHex);
    const legacy = CML.Transaction.from_cbor_hex(txCborHex).witness_set().redeemers()?.as_arr_legacy_redeemer();
    const out: Array<{ ex_units: { mem: number; steps: number }; redeemer_index: number; redeemer_tag: 'spend' }> = [];
    for (let i = 0; legacy && i < legacy.len(); i++) out.push({ ex_units: { mem: 2_000_000, steps: 500_000_000 }, redeemer_index: Number(legacy.get(i).index()), redeemer_tag: 'spend' });
    return out;
  };
  return Object.assign(new FixtureProvider(utxos), { evaluateTx, evaluations });
}
function redeemersOf(cborHex: string) {
  const legacy = CML.Transaction.from_cbor_hex(cborHex).witness_set().redeemers()?.as_arr_legacy_redeemer();
  const out: Array<{ tag: number; index: number; data: string; mem: bigint }> = [];
  for (let i = 0; legacy && i < legacy.len(); i++) {
    const r = legacy.get(i);
    out.push({ tag: Number(r.tag()), index: Number(r.index()), data: r.data().to_cbor_hex(), mem: r.ex_units().mem() });
  }
  return out;
}
const refsOf = (list: CML.TransactionInputList | undefined): string[] => {
  const r: string[] = [];
  for (let i = 0; list && i < list.len(); i++) r.push(`${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`);
  return r.sort();
};
/** escrow.ak lovelace_paid_to_pkh: every output whose payment credential is that key hash, whatever its stake part. */
const lovelacePaidTo = (cborHex: string, pkh: string): bigint =>
  outputs(cborHex).filter((o) => getAddressDetails(o.address).paymentCredential?.hash === pkh).reduce((sum, o) => sum + o.lovelace, 0n);
const slotOf = (ms: number) => BigInt(unixTimeToSlot('Mainnet', ms));
const msOfSlot = (slot: bigint | undefined) => slotToUnixTime('Mainnet', Number(slot));

describe('buildAccept / buildReclaim (offline)', () => {
  before(async () => { await ensureSlotConfig(new FixtureProvider([])); });
  const POSTED: EscrowDatum = { ...decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), buyer_pkh: OWN_PKH }; // the live escrow, as the test wallet posted it
  const SUBMITTED_AT = POSTED.posted_at + 60_000;
  const SUBMITTED: EscrowDatum = { ...POSTED, submitted_at: SUBMITTED_AT, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
  const CLAIMED: EscrowDatum = { ...POSTED, state: 'Claimed' };
  const LIVE_TX = 'ee'.repeat(32);
  const ACCEPT_NOW = SUBMITTED_AT + 120_000;
  const OPENS = Math.ceil((POSTED.deliver_by + 1) / 1000) * 1000; // the first moment a Reclaim of POSTED is accepted
  const KOIOS = 'https://koios.example';
  const keyAddress = (pkh: string) => credentialToAddress('Mainnet', { type: 'Key', hash: pkh });

  async function setup(chain: UTxO[], wallet: UTxO[] = FIXTURE_UTXOS) {
    const provider = evaluatingProvider([...wallet, ...chain]);
    return { provider, lucid: await lucidForAddress(provider, OWN_ADDRESS) };
  }
  type World = Awaited<ReturnType<typeof setup>>;
  /** The Post output is spent and the escrow lives on at LIVE_TX in the given state. */
  const afterSubmit = (datum: EscrowDatum = SUBMITTED, wallet?: UTxO[]) => setup([REF_SCRIPT_UTXO, escrowAt(LIVE_TX, datum)], wallet);
  /** Nobody has touched the Post output: it is still Open. */
  const untouched = (wallet?: UTxO[]) => setup([REF_SCRIPT_UTXO, escrowAt(ESCROW_TX, POSTED)], wallet);
  const postedOn = (spent: boolean) => escrowKoios({ datumHex: encodeEscrowDatum(POSTED), spent });
  type Over = Partial<{ changeAddress: string; escrowRef: string; nowMs: number }>;
  const accept = (w: World, over: Over = {}, k: KoiosFake = postedOn(true)) =>
    buildAccept(w.lucid, w.provider, KOIOS, { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: ACCEPT_NOW, ...over }, k.f);
  const reclaim = (w: World, over: Over = {}, k: KoiosFake = postedOn(false)) =>
    buildReclaim(w.lucid, w.provider, KOIOS, { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: OPENS + 3_600_123, ...over }, k.f);
  /** A refusal that comes before anything is built: the node was never asked to evaluate a script. */
  const refused = (w: World) => assert.equal(w.provider.evaluations.length, 0, 'nothing was built');

  test('the reference-script fixture is the deployed escrow validator: its hash is the escrow script hash', () => {
    assert.equal(validatorToScriptHash({ type: 'PlutusV3', script: ESCROW_SCRIPT_CBOR }), ESCROW_SCRIPT_HASH);
  });

  describe('Accept', () => {
    test('spends the live Submitted UTxO with the Accept redeemer and reads the validator from the reference script', async () => {
      const w = await afterSubmit();
      const r = await accept(w);
      const t = CML.Transaction.from_cbor_hex(r.txCbor);
      const inputs = inputRefs(r.txCbor);
      assert.ok(inputs.includes(`${LIVE_TX}#0`), 'the live escrow output is spent');
      assert.deepEqual(refsOf(t.body().reference_inputs()), [formatOutRef(ESCROW_REF_UTXO.txHash, ESCROW_REF_UTXO.outputIndex)]);
      assert.equal(t.witness_set().plutus_v3_scripts()?.len() ?? 0, 0, 'the validator is read from the reference input, not carried in the witness set');
      const reds = redeemersOf(r.txCbor);
      assert.equal(reds.length, 1);
      assert.equal(reds[0].tag, 0, 'a spend');
      assert.equal(reds[0].data, 'd87b80', 'Accept');
      assert.equal(inputs[reds[0].index], `${LIVE_TX}#0`, 'the redeemer points at the escrow input');
      assert.ok(reds[0].mem > 0n, 'the budget the node answered is on the redeemer');
      assert.equal(w.provider.evaluations.length > 0, true, 'the node, not Lucid, evaluates the script');
    });
    test('pays the supplier price + supplier bond at its key address and the buyer bond back to the buyer', async () => {
      const r = await accept(await afterSubmit());
      const outs = outputs(r.txCbor);
      assert.ok(outs.some((o) => o.address === SUPPLIER_ADDRESS && o.lovelace === 1_200_000n), 'supplier: price 0.2 + supplier bond 1');
      assert.ok(outs.some((o) => o.address === OWN_ADDRESS && o.lovelace === 1_000_000n), 'buyer: the bond');
      // what escrow.ak handle_accept adds up
      assert.ok(lovelacePaidTo(r.txCbor, SUBMITTED.supplier_pkh) >= SUBMITTED.payment_lovelace + SUBMITTED.supplier_bond_lovelace);
      assert.ok(lovelacePaidTo(r.txCbor, OWN_PKH) >= SUBMITTED.buyer_bond_lovelace);
      assert.deepEqual([r.supplierLovelace, r.buyerLovelace], [1_200_000n, 1_000_000n]);
      assert.equal(r.secondsLeft, Math.floor((SUBMITTED_AT + ACCEPT_WINDOW_MS - ACCEPT_NOW) / 1000));
    });
    test('needs the buyer key, and its validity range is the plan\'s, which ends inside the accept window', async () => {
      const r = await accept(await afterSubmit());
      const body = CML.Transaction.from_cbor_hex(r.txCbor).body();
      const signers = body.required_signers();
      assert.ok(signers && signers.len() === 1 && signers.get(0).to_hex() === OWN_PKH);
      const plan = planAccept(SUBMITTED, OWN_PKH, ACCEPT_NOW);
      assert.equal(body.validity_interval_start(), slotOf(plan.validFrom));
      assert.equal(body.ttl(), slotOf(plan.validTo));
      assert.ok(msOfSlot(body.ttl()) <= SUBMITTED_AT + ACCEPT_WINDOW_MS, 'as the script sees it, the range ends within 600 s of Submit');
    });
    test('is a script spend: collateral comes from the wallet, and the fee is at least the minimum', async () => {
      const r = await accept(await afterSubmit());
      const body = CML.Transaction.from_cbor_hex(r.txCbor).body();
      const collateral = refsOf(body.collateral_inputs());
      assert.ok(collateral.length >= 1 && collateral.every((c) => FIXTURE_UTXOS.some((u) => c === `${u.txHash}#${u.outputIndex}`)), `collateral ${collateral} is a wallet output`);
      assert.ok(body.collateral_return() !== undefined, 'what the collateral holds beyond the required amount comes back');
      assert.ok(BigInt(String(body.total_collateral())) >= COLLATERAL_MIN_LOVELACE);
      assert.ok(BigInt(r.fee) >= MARKETPLACE_MIN_FEE, `fee ${r.fee} is below the marketplace minimum`);
    });

    test('refuses a caller who is not the buyer', async () => {
      const w = await afterSubmit();
      await assert.rejects(() => accept(w, { changeAddress: keyAddress('cc'.repeat(28)) }), /not the buyer/);
      refused(w);
    });
    test('refuses an escrow that is not Submitted, and one whose accept window has closed', async () => {
      const claimed = await afterSubmit(CLAIMED);
      await assert.rejects(() => accept(claimed), /Escrow state is Claimed; Accept needs Submitted/);
      refused(claimed);
      const w = await afterSubmit();
      await assert.rejects(() => accept(w, { nowMs: SUBMITTED_AT + ACCEPT_WINDOW_MS + 1 }), /Accept window closed/);
      refused(w);
      // with no nowMs the clock decides, and the window of this August escrow closed long ago
      const { nowMs: _omitted, ...withoutNow } = { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: 0 };
      await assert.rejects(() => buildAccept(w.lucid, w.provider, KOIOS, withoutNow, postedOn(true).f), /Accept window closed/);
      refused(w);
    });
    test('refuses an escrow with no live UTxO, saying so and naming it', async () => {
      const w = await setup([REF_SCRIPT_UTXO]);
      await assert.rejects(() => accept(w), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /has no live UTxO: it was already accepted, released or reclaimed/);
        assert.ok(err.message.includes(ESCROW_REF));
        return true;
      });
      refused(w);
    });
    test('a script change address or a malformed ref is refused before Koios is asked', async () => {
      const w = await afterSubmit();
      const k = postedOn(true);
      await assert.rejects(() => accept(w, { changeAddress: ESCROW_ADDRESS }, k), /verification key/);
      await assert.rejects(() => accept(w, { escrowRef: 'nope#1' }, k), /Invalid out ref/);
      assert.equal(k.calls.length, 0);
      refused(w);
    });
    test('a Koios failure surfaces as an error that names the escrow; nothing is built', async () => {
      const w = await afterSubmit();
      await assert.rejects(() => accept(w, {}, escrowKoios({ status: 502 })), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, `Could not read escrow ${ESCROW_REF}: Koios utxo_info answered 502`);
        return true;
      });
      refused(w);
    });
    test('refuses a wallet without a pure output of at least 5 units, before building', async () => {
      const at = (outputIndex: number, assets: UTxO['assets']): UTxO => ({ txHash: FIXTURE_TXHASH, outputIndex, address: OWN_ADDRESS, assets });
      for (const wallet of [
        [at(0, { lovelace: 4_900_000n }), at(1, { lovelace: 4_000_000n })],
        [at(0, { lovelace: 900_000_000n, [FIXTURE_TOKEN_UNIT]: 5n })], // plenty of funds, but nothing pure to be the collateral
      ]) {
        const w = await afterSubmit(SUBMITTED, wallet);
        await assert.rejects(() => accept(w), /Collateral required: the wallet must hold one pure output of at least 5 units/);
        refused(w);
      }
    });
    test('refuses when the reference script cannot be read, saying the marketplace has to republish it', async () => {
      const bare = { ...REF_SCRIPT_UTXO, scriptRef: undefined };
      for (const chain of [[escrowAt(LIVE_TX, SUBMITTED)], [bare, escrowAt(LIVE_TX, SUBMITTED)]]) {
        const w = await setup(chain);
        await assert.rejects(() => accept(w), new RegExp(`Escrow reference script ${ESCROW_REF_UTXO.txHash}#0 not found; the marketplace needs to republish it`));
        refused(w);
      }
    });
  });

  describe('Reclaim', () => {
    test('spends the Open Post output with the Reclaim redeemer and gives payment and both bonds back to the buyer', async () => {
      const w = await untouched();
      const r = await reclaim(w);
      const inputs = inputRefs(r.txCbor);
      assert.ok(inputs.includes(`${ESCROW_TX}#0`), 'the Post output is spent');
      const reds = redeemersOf(r.txCbor);
      assert.equal(reds.length, 1);
      assert.deepEqual([reds[0].tag, reds[0].data, inputs[reds[0].index]], [0, 'd87c80', `${ESCROW_TX}#0`]);
      assert.deepEqual(refsOf(CML.Transaction.from_cbor_hex(r.txCbor).body().reference_inputs()), [formatOutRef(ESCROW_REF_UTXO.txHash, ESCROW_REF_UTXO.outputIndex)]);
      assert.ok(outputs(r.txCbor).some((o) => o.address === OWN_ADDRESS && o.lovelace === 2_200_000n), 'payment 0.2 + both bonds, to the buyer');
      assert.ok(lovelacePaidTo(r.txCbor, OWN_PKH) >= POSTED.payment_lovelace + POSTED.buyer_bond_lovelace + POSTED.supplier_bond_lovelace, 'what escrow.ak handle_reclaim adds up');
      assert.equal(r.buyerLovelace, 2_200_000n);
      assert.ok(w.provider.evaluations.length > 0);
      assert.ok(BigInt(r.fee) >= MARKETPLACE_MIN_FEE);
    });
    test('needs the buyer key and names collateral from the wallet', async () => {
      const r = await reclaim(await untouched());
      const body = CML.Transaction.from_cbor_hex(r.txCbor).body();
      const signers = body.required_signers();
      assert.ok(signers && signers.len() === 1 && signers.get(0).to_hex() === OWN_PKH);
      assert.ok(refsOf(body.collateral_inputs()).length >= 1);
      assert.ok(BigInt(String(body.total_collateral())) >= COLLATERAL_MIN_LOVELACE);
    });
    test('the transaction\'s lower bound is the plan\'s and, as the script sees it, is not before deliver_by - from the first accepted second on', async () => {
      for (const later of [0, 1, 30_000, 59_999, 60_000, 60_001, 3_600_123]) {
        const nowMs = OPENS + later;
        const r = await reclaim(await untouched(), { nowMs });
        const body = CML.Transaction.from_cbor_hex(r.txCbor).body();
        const plan = planReclaim(POSTED, OWN_PKH, nowMs);
        assert.equal(body.validity_interval_start(), slotOf(plan.validFrom), `later = ${later}`);
        assert.equal(body.ttl(), slotOf(plan.validTo), `later = ${later}`);
        assert.ok(msOfSlot(body.validity_interval_start()) >= POSTED.deliver_by, `later = ${later}: the lower bound is before deliver_by`);
        assert.ok(msOfSlot(body.validity_interval_start()) >= OPENS, `later = ${later}`);
      }
    });
    test('reclaims a Claimed escrow too, after the supplier took it and went quiet', async () => {
      const w = await afterSubmit(CLAIMED);
      const r = await reclaim(w, {}, postedOn(true));
      assert.ok(inputRefs(r.txCbor).includes(`${LIVE_TX}#0`));
      assert.equal(redeemersOf(r.txCbor)[0].data, 'd87c80');
    });
    test('stamps the validity range from the clock when nowMs is not given', async () => {
      const before = Date.now();
      const w = await untouched();
      const { nowMs: _omitted, ...withoutNow } = { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: 0 };
      const r = await buildReclaim(w.lucid, w.provider, KOIOS, withoutNow, postedOn(false).f);
      const after = Date.now();
      const ttl = msOfSlot(CML.Transaction.from_cbor_hex(r.txCbor).body().ttl());
      assert.ok(ttl >= before + 600_000 - 1000 && ttl <= after + 600_000, `ttl ${ttl} is not about ten minutes after ${before}..${after}`);
    });

    test('refuses before deliver_by has passed on a whole second, naming when it opens', async () => {
      const w = await untouched();
      await assert.rejects(() => reclaim(w, { nowMs: OPENS - 1 }), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Reclaim opens at/);
        assert.ok(err.message.includes(new Date(OPENS).toISOString()));
        return true;
      });
      refused(w);
    });
    test('refuses a Submitted escrow, a caller who is not the buyer, and an escrow with no live UTxO', async () => {
      const submitted = await afterSubmit();
      await assert.rejects(() => reclaim(submitted, {}, postedOn(true)), /Escrow state is Submitted; Reclaim needs Open or Claimed/);
      refused(submitted);
      const w = await untouched();
      await assert.rejects(() => reclaim(w, { changeAddress: keyAddress('cc'.repeat(28)) }), /not the buyer/);
      refused(w);
      const finished = await setup([REF_SCRIPT_UTXO]);
      await assert.rejects(() => reclaim(finished, {}, postedOn(true)), new RegExp(`Escrow ${ESCROW_REF} has no live UTxO: nothing to reclaim`));
      refused(finished);
    });
    test('refuses a wallet without a pure output of at least 5 units, and an unreadable reference script, before building', async () => {
      const lean = await untouched([{ txHash: FIXTURE_TXHASH, outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 4_000_000n } }]);
      await assert.rejects(() => reclaim(lean), /Collateral required/);
      refused(lean);
      const noScript = await setup([escrowAt(ESCROW_TX, POSTED)]);
      await assert.rejects(() => reclaim(noScript), /Escrow reference script .* not found/);
      refused(noScript);
    });
  });
});
