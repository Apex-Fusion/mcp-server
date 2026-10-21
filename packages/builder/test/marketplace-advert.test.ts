// packages/builder/test/marketplace-advert.test.ts
// The supplier side of an advert: the datum writer, the Post and the Retire. Parity is held against the supplier template's own
// transactions on mainnet (advert-stake-golden.fixture.ts): the same datum bytes, deposit and validity range for each of the service
// agents' Posts, and for the Retire the same output to the supplier, validity range and reference script, with the deployed advert
// validator evaluating the built transaction (uplc-node.fixture.ts). No network is touched: Koios and the manifest host are stubbed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CML, Constr, Data, getAddressDetails, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { lucidForAddress } from '../src/vector/build.ts';
import { ensureSlotConfig } from '../src/vector/gov-build.ts';
import {
  ADVERT_ADDRESS, ADVERT_REF_UTXO, ADVERT_SCRIPT_HASH, ADVERT_DEPOSIT_FLOOR_LOVELACE, EMPTY_DETAIL_HASH, MARKETPLACE_MIN_FEE,
  MAX_PROCESSING_MS_CEILING, DELIVER_BY_BUFFER_MS,
} from '../src/vector/marketplace-constants.ts';
import { decodeAdvertDatum, encodeAdvertDatum, formatOutRef } from '../src/vector/marketplace-datum.ts';
import type { AdvertDatum } from '../src/vector/marketplace-datum.ts';
import { planPostAdvert, buildPostAdvert, advertOutputZero, planRetireAdvert, buildRetireAdvert } from '../src/vector/marketplace-advert.ts';
import type { AdvertTerms } from '../src/vector/marketplace-advert.ts';
import { planPostEscrow } from '../src/vector/marketplace-build.ts';
import { ADVERT_DATUM_HEX } from './fixtures/marketplace.fixture.ts';
import { ADVERT_POSTS, ADVERT_RETIRE, ADVERT_REF_UTXO_BARE, ADVERT_SCRIPT_CBOR, STAKE_A } from './fixtures/advert-stake-golden.fixture.ts';
import { uplcEvaluatingProvider } from './fixtures/uplc-node.fixture.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';

const ZERO = 1_756_485_600_000;
const slotOf = (ms: number) => Math.floor((ms - ZERO) / 1000);
const ADVERT_SCRIPT_UTXO: UTxO = { ...ADVERT_REF_UTXO_BARE, scriptRef: { type: 'PlutusV3', script: ADVERT_SCRIPT_CBOR } };
const termsOf = (d: AdvertDatum): AdvertTerms => ({
  capabilityId: d.capability_id, model: d.model, maxOutputTokens: d.max_output_tokens, maxProcessingMs: d.max_processing_ms,
  priceLovelace: d.price_lovelace, supplierBondLovelace: d.supplier_bond_lovelace, buyerBondLovelace: d.buyer_bond_lovelace,
  endpointUrl: d.endpoint_url, detailUri: d.detail_uri, detailHash: d.detail_hash,
});
const ADVOCATE = decodeAdvertDatum(ADVERT_POSTS[4].datumHex);
const SUPPLIER = ADVOCATE.supplier_pkh;
const SUPPLIER_ADDRESS = ADVERT_POSTS[4].tx.outputs[1].address;
const OTHER_PKH = 'ab'.repeat(28);
const NOW = ADVOCATE.advertised_at;
const TERMS = termsOf(ADVOCATE);

const txOf = (cbor: string) => CML.Transaction.from_cbor_hex(cbor);
const requiredSigners = (cbor: string): string[] => {
  const s = txOf(cbor).body().required_signers();
  const out: string[] = [];
  for (let i = 0; s && i < s.len(); i++) out.push(s.get(i).to_hex());
  return out;
};
const refInputs = (cbor: string): string[] => {
  const r = txOf(cbor).body().reference_inputs();
  const out: string[] = [];
  for (let i = 0; r && i < r.len(); i++) out.push(`${r.get(i).transaction_id().to_hex()}#${r.get(i).index()}`);
  return out.sort();
};
const unsigned = (cbor: string) => { const v = txOf(cbor).witness_set().vkeywitnesses(); return v === undefined || v.len() === 0; };

describe('encodeAdvertDatum', () => {
  test('writes every live advert in the fixtures back byte for byte (the four service agents and ChandraOCR)', () => {
    for (const hex of [...ADVERT_POSTS.map((p) => p.datumHex), ADVERT_DATUM_HEX]) assert.equal(encodeAdvertDatum(decodeAdvertDatum(hex)), hex);
  });
  test('frames like the marketplace: every integer as 1b + 8 bytes, the status as a nullary constructor', () => {
    const hex = encodeAdvertDatum({ ...ADVOCATE, max_output_tokens: 1, price_lovelace: 0n });
    assert.ok(hex.startsWith('d8798d'), 'constructor 0, a definite array of 13 fields');
    assert.ok(hex.includes('1b0000000000000001'), 'a small integer still takes nine bytes');
    assert.ok(hex.endsWith('d87980'), 'Active');
    assert.ok(encodeAdvertDatum({ ...ADVOCATE, status: 'Retired' }).endsWith('d87a80'), 'Retired');
    assert.equal(decodeAdvertDatum(encodeAdvertDatum({ ...ADVOCATE, status: 'Retired' })).status, 'Retired');
  });
  test('refuses what it cannot frame', () => {
    assert.throws(() => encodeAdvertDatum({ ...ADVOCATE, status: 'Paused' as never }), /unknown status/);
    assert.throws(() => encodeAdvertDatum({ ...ADVOCATE, price_lovelace: -1n }), RangeError);
  });
});

describe('planPostAdvert', () => {
  test('the service agents\' Posts: the same datum bytes, deposit and validity range as the template wrote, from the same terms and time', () => {
    for (const post of ADVERT_POSTS) {
      const d = decodeAdvertDatum(post.datumHex);
      const plan = planPostAdvert(termsOf(d), d.supplier_pkh, d.advertised_at);
      assert.equal(plan.datumHex, post.datumHex, post.advertRef);
      assert.equal(slotOf(plan.validFrom), Number(post.tx.invalidBefore), `${post.advertRef} lower bound`);
      assert.equal(slotOf(plan.validTo), Number(post.tx.invalidAfter), `${post.advertRef} upper bound`);
      assert.ok(BigInt(post.tx.outputs[0].lovelace) >= plan.depositLovelace, `${post.advertRef}: the live lock is the planned deposit or the ledger minimum above it`);
    }
  });
  test('names the signing key as supplier, stamps the time, starts Active; valid from 60 s before to 5 min after', () => {
    const plan = planPostAdvert(TERMS, OTHER_PKH, NOW + 1);
    assert.equal(plan.datum.supplier_pkh, OTHER_PKH);
    assert.equal(plan.datum.advertised_at, NOW + 1);
    assert.equal(plan.datum.status, 'Active');
    assert.equal(plan.validFrom, NOW + 1 - 60_000);
    assert.equal(plan.validTo, NOW + 1 + 300_000);
    assert.equal(plan.endpointHost, 'mp-suppliers-advocate.hal8.ai');
  });
  test('the deposit is the supplier bond, raised to the template\'s 2-unit floor', () => {
    assert.equal(planPostAdvert({ ...TERMS, supplierBondLovelace: 1_000_000n }, SUPPLIER, NOW).depositLovelace, ADVERT_DEPOSIT_FLOOR_LOVELACE);
    assert.equal(planPostAdvert({ ...TERMS, supplierBondLovelace: 0n }, SUPPLIER, NOW).depositLovelace, ADVERT_DEPOSIT_FLOOR_LOVELACE);
    assert.equal(planPostAdvert({ ...TERMS, supplierBondLovelace: 7_500_000n }, SUPPLIER, NOW).depositLovelace, 7_500_000n);
  });
  describe('refuses an advert the ledger would refuse or a buyer could not hire', () => {
    const refuses = (over: Partial<AdvertTerms>, re: RegExp, pkh = SUPPLIER) => assert.throws(() => planPostAdvert({ ...TERMS, ...over }, pkh, NOW), re);
    test('a text field over 64 bytes of UTF-8, counted in bytes and not characters', () => {
      refuses({ capabilityId: 'a'.repeat(65) }, /capability_id is 65 bytes as UTF-8; an advert field holds at most 64/);
      refuses({ model: 'é'.repeat(33) }, /model is 66 bytes/);
      refuses({ endpointUrl: `https://${'a'.repeat(50)}.example` }, /endpoint_url is 66 bytes/);
      refuses({ detailUri: `https://h.example/${'p'.repeat(50)}` }, /detail_uri is 68 bytes/);
      assert.doesNotThrow(() => planPostAdvert({ ...TERMS, capabilityId: 'a'.repeat(64) }, SUPPLIER, NOW), 'exactly 64 is fine');
    });
    test('text UTF-8 does not carry unchanged, control characters and line breaks', () => {
      refuses({ model: 'a\ud800b' }, /model is not text that UTF-8 carries unchanged/);
      refuses({ model: '\ufeffmodel' }, /model is not text that UTF-8 carries unchanged/);
      refuses({ model: 'a\nb' }, /model must not contain control characters/);
      refuses({ capabilityId: 'x\u2028y' }, /capability_id must not contain control characters/);
    });
    test('empty required fields', () => {
      refuses({ capabilityId: '' }, /capability_id must not be empty/);
      refuses({ model: '' }, /model must not be empty/);
      refuses({ endpointUrl: '' }, /endpoint_url must not be empty/);
    });
    test('an endpoint or detail URI the marketplace tools would not call: not https, credentials, a private literal, not a URL', () => {
      refuses({ endpointUrl: 'http://mp.example' }, /endpoint_url must be an https URL/);
      refuses({ endpointUrl: 'https://u:p@mp.example' }, /endpoint_url must not carry credentials/);
      refuses({ endpointUrl: 'https://10.1.2.3' }, /endpoint_url points at a private or reserved address/);
      refuses({ endpointUrl: 'https://[::1]:8443' }, /endpoint_url points at a private or reserved address/);
      refuses({ endpointUrl: 'mp.example' }, /endpoint_url is not a URL/);
      refuses({ detailUri: 'http://mp.example/agent.json' }, /detail_uri must be an https URL/);
      assert.doesNotThrow(() => planPostAdvert({ ...TERMS, detailUri: '' }, SUPPLIER, NOW), 'no detail URI at all is fine');
    });
    test('a fleet capability id, which vector_build_marketplace_post_escrow refuses to hire', () => {
      for (const id of ['llm.text.generate.qwen.v1', 'llm.chat.v1', 'ocr.page.extract.chandra-ocr-2.v1', 'audio.synthesize.kokoro.v1']) refuses({ capabilityId: id }, /fleet namespace/);
    });
    test('a processing window over 24 h, and numbers that are not whole lovelace or milliseconds', () => {
      refuses({ maxProcessingMs: MAX_PROCESSING_MS_CEILING + 1 }, /max_processing_ms is 86400001, more than 86400000 \(24 h\)/);
      refuses({ maxProcessingMs: 1.5 }, /max_processing_ms must be a whole number from 0/);
      refuses({ maxOutputTokens: -1 }, /max_output_tokens must be a whole number from 0/);
      refuses({ priceLovelace: -1n }, /price_lovelace must be a whole number of lovelace from 0/);
      refuses({ buyerBondLovelace: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, /check the unit/);
    });
    test('a detail hash that is not 32 bytes of hex, and a supplier key that is not one', () => {
      refuses({ detailHash: 'ab' }, /detail_hash must be 64 hex characters/);
      refuses({}, /56 lower-case hex/, 'not-a-key');
    });
  });
  test('an advert it accepts is one vector_build_marketplace_post_escrow hires, at every window and price it allows', () => {
    for (const maxProcessingMs of [0, 1, 300_000, MAX_PROCESSING_MS_CEILING]) {
      for (const [price, sBond, bBond] of [[0n, 0n, 0n], [200_000n, 1_000_000n, 1_000_000n], [BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER)]]) {
        const plan = planPostAdvert({ ...TERMS, maxProcessingMs, priceLovelace: price, supplierBondLovelace: sBond, buyerBondLovelace: bBond }, SUPPLIER, NOW);
        const hire = planPostEscrow(plan.datum, `${'cd'.repeat(32)}#0`, OTHER_PKH, 'a payload', NOW + 1_000);
        assert.equal(hire.deliverBy, NOW + 1_000 + maxProcessingMs + DELIVER_BY_BUFFER_MS, `window ${maxProcessingMs}, price ${price}`);
        assert.equal(hire.endpointHost, plan.endpointHost);
      }
    }
  });
});

// A supplier wallet of 30 units plus a 5-unit output, at the Advocate supplier's address (the advert's key is the address's key).
const supplierWallet = (address = SUPPLIER_ADDRESS): UTxO[] => [
  { txHash: 'aa'.repeat(32), outputIndex: 0, address, assets: { lovelace: 30_000_000n } },
  { txHash: 'aa'.repeat(32), outputIndex: 1, address, assets: { lovelace: 5_000_000n } },
];
const noFetch = (async () => { throw new Error('the network was touched'); }) as typeof fetch;

describe('buildPostAdvert', () => {
  test('the service agents\' Posts, built here: output 0 holds the same datum and lock, in the same validity range, signed by the supplier', async () => {
    for (const post of ADVERT_POSTS) {
      const d = decodeAdvertDatum(post.datumHex);
      const address = post.tx.outputs[1].address;
      assert.equal(getAddressDetails(address).paymentCredential!.hash, d.supplier_pkh, 'the template posted from the supplier key');
      const node = new FixtureProvider(supplierWallet(address));
      const r = await buildPostAdvert(await lucidForAddress(node, address), node, { changeAddress: address, terms: termsOf(d), nowMs: d.advertised_at }, noFetch);
      const out0 = txOf(r.txCbor).body().outputs().get(0);
      assert.equal(out0.address().to_bech32(), ADVERT_ADDRESS);
      assert.equal(out0.datum()?.as_datum()?.to_cbor_hex(), post.datumHex, `${post.advertRef} datum`);
      assert.equal(out0.amount().coin().toString(), post.tx.outputs[0].lovelace, `${post.advertRef}: the same lock, the ledger minimum included`);
      assert.equal(r.depositLovelace, BigInt(post.tx.outputs[0].lovelace));
      assert.equal(txOf(r.txCbor).body().validity_interval_start()?.toString(), post.tx.invalidBefore);
      assert.equal(txOf(r.txCbor).body().ttl()?.toString(), post.tx.invalidAfter);
      assert.deepEqual(requiredSigners(r.txCbor), [d.supplier_pkh]);
      assert.ok(BigInt(r.fee) >= MARKETPLACE_MIN_FEE);
      assert.ok(unsigned(r.txCbor), 'unsigned');
      assert.equal(r.advertRef, `${r.txHash}#0`);
      assert.equal(r.detailHashSource, 'given');
      assert.equal(r.collateralKept, true);
    }
  });
  test('when detail_hash is not given and detail_uri is, the bytes the URI serves are hashed, once', async () => {
    const manifest = '{"name":"Advocate","capability":"research.advocate.onesided.v1"}\n';
    const fetched: string[] = [];
    const host = (async (input: unknown) => { fetched.push(String(input)); return new Response(manifest, { status: 200 }); }) as typeof fetch;
    const node = new FixtureProvider(supplierWallet());
    const r = await buildPostAdvert(await lucidForAddress(node, SUPPLIER_ADDRESS), node, {
      changeAddress: SUPPLIER_ADDRESS, nowMs: NOW, terms: { ...TERMS, detailUri: 'https://203.0.113.9/agent.json', detailHash: undefined },
    }, host);
    assert.deepEqual(fetched, ['https://203.0.113.9/agent.json']);
    assert.equal(r.datum.detail_hash, createHash('sha256').update(manifest, 'utf8').digest('hex'));
    assert.equal(r.detailHashSource, 'served');
  });
  test('with neither, the hash of no bytes and no fetch; with a URI that cannot be read, a refusal that asks for the hash and nothing built', async () => {
    const node = new FixtureProvider(supplierWallet());
    const lucid = await lucidForAddress(node, SUPPLIER_ADDRESS);
    const r = await buildPostAdvert(lucid, node, { changeAddress: SUPPLIER_ADDRESS, nowMs: NOW, terms: { ...TERMS, detailUri: '', detailHash: undefined } }, noFetch);
    assert.equal(r.datum.detail_hash, EMPTY_DETAIL_HASH);
    assert.equal(r.detailHashSource, 'empty');
    const down = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await assert.rejects(buildPostAdvert(lucid, node, { changeAddress: SUPPLIER_ADDRESS, nowMs: NOW, terms: { ...TERMS, detailUri: 'https://203.0.113.9/agent.json', detailHash: undefined } }, down),
      /Could not read the manifest at detail_uri to hash it \(the supplier answered 404\); serve it first, or pass detail_hash/);
  });
  test('terms that are wrong anyway are refused before the manifest is fetched', async () => {
    const node = new FixtureProvider(supplierWallet());
    await assert.rejects(buildPostAdvert(await lucidForAddress(node, SUPPLIER_ADDRESS), node, {
      changeAddress: SUPPLIER_ADDRESS, nowMs: NOW, terms: { ...TERMS, capabilityId: 'llm.chat.v1', detailUri: 'https://203.0.113.9/agent.json', detailHash: undefined },
    }, noFetch), /fleet namespace/);
  });
  test('a wallet with no 5-unit output to spare is used whole, and says so', async () => {
    const node = new FixtureProvider([{ txHash: 'aa'.repeat(32), outputIndex: 0, address: SUPPLIER_ADDRESS, assets: { lovelace: 6_000_000n } }]);
    const r = await buildPostAdvert(await lucidForAddress(node, SUPPLIER_ADDRESS), node, { changeAddress: SUPPLIER_ADDRESS, terms: TERMS, nowMs: NOW }, noFetch);
    assert.equal(r.collateralKept, false);
  });
  test('a script address cannot be a supplier', async () => {
    const node = new FixtureProvider([{ txHash: 'aa'.repeat(32), outputIndex: 0, address: ADVERT_ADDRESS, assets: { lovelace: 30_000_000n } }]);
    await assert.rejects(buildPostAdvert(await lucidForAddress(node, ADVERT_ADDRESS), node, { changeAddress: ADVERT_ADDRESS, terms: TERMS, nowMs: NOW }, noFetch), /verification key/);
  });
  test('advertOutputZero refuses a transaction whose output 0 is not the planned advert', async () => {
    const node = new FixtureProvider(supplierWallet());
    const r = await buildPostAdvert(await lucidForAddress(node, SUPPLIER_ADDRESS), node, { changeAddress: SUPPLIER_ADDRESS, terms: TERMS, nowMs: NOW }, noFetch);
    const plan = planPostAdvert(TERMS, SUPPLIER, NOW);
    assert.equal(advertOutputZero(r.txCbor, plan), r.depositLovelace);
    assert.throws(() => advertOutputZero(r.txCbor, { ...plan, datumHex: encodeAdvertDatum({ ...plan.datum, model: 'other' }) }), /not have the planned advert as output 0/);
    assert.throws(() => advertOutputZero(r.txCbor, { ...plan, depositLovelace: r.depositLovelace + 1n }), /not have the planned advert as output 0/);
  });
});

// ─── Retire ─────────────────────────────────────────────────────────────────

const RETIRED_REF = formatOutRef(ADVERT_RETIRE.advert.txHash, 0);
const RETIRED_ADVERT = decodeAdvertDatum(ADVERT_RETIRE.advert.datum!);
const RETIRE_LB = Number(ADVERT_RETIRE.tx.invalidBefore);
const RETIRE_NOW = ZERO + (RETIRE_LB + 60) * 1000;
const RETIRE_WALLET_ADDRESS = ADVERT_RETIRE.wallet.address;
/** Koios as the retire sees it: the advert at the advert address, its datum, and whether it is spent. */
const koiosFor = (o: { spent?: boolean | null; address?: string; datum?: string } = {}) => (async (input: unknown) => {
  if (!String(input).endsWith('/api/v1/utxo_info')) return new Response('{}', { status: 500 });
  const row: Record<string, unknown> = { tx_hash: ADVERT_RETIRE.advert.txHash, tx_index: 0, address: o.address ?? ADVERT_ADDRESS, value: String(ADVERT_RETIRE.advert.assets.lovelace), inline_datum: { bytes: o.datum ?? ADVERT_RETIRE.advert.datum } };
  if (o.spent !== null) row.is_spent = o.spent ?? false;
  return new Response(JSON.stringify([row]));
}) as typeof fetch;
const retireNode = (utxos: UTxO[] = [ADVERT_RETIRE.wallet, ADVERT_RETIRE.advert, ADVERT_SCRIPT_UTXO]) => uplcEvaluatingProvider(utxos, RETIRE_LB);

describe('planRetireAdvert', () => {
  test('only the advert\'s supplier key; the deposit returns whole; RetireAdvert is constructor 2', () => {
    const plan = planRetireAdvert(RETIRED_ADVERT, RETIRED_ADVERT.supplier_pkh, 2_017_080n, RETIRE_NOW);
    assert.equal(plan.returnLovelace, 2_017_080n);
    assert.equal(plan.redeemerHex, 'd87b80');
    assert.deepEqual(ADVERT_RETIRE.tx.redeemers.map((r) => (r.data as { constructor: number }).constructor), [2], 'the template\'s Retire used constructor 2 too');
    assert.equal(slotOf(plan.validFrom), RETIRE_LB);
    assert.equal(slotOf(plan.validTo), Number(ADVERT_RETIRE.tx.invalidAfter));
    assert.throws(() => planRetireAdvert(RETIRED_ADVERT, OTHER_PKH, 2_017_080n, RETIRE_NOW), /only its supplier can retire it/);
  });
});

describe('buildRetireAdvert', () => {
  test('the template\'s Retire, built here: the deployed advert validator accepts it, and it returns the same deposit to the supplier in the same range', async () => {
    const node = retireNode();
    await ensureSlotConfig(node);
    const r = await buildRetireAdvert(await lucidForAddress(node, RETIRE_WALLET_ADDRESS), node, { changeAddress: RETIRE_WALLET_ADDRESS, advertRef: RETIRED_REF, nowMs: RETIRE_NOW }, koiosFor());
    assert.equal(node.evaluations.length, 1, 'the validator was evaluated');
    const body = txOf(r.txCbor).body();
    const out0 = body.outputs().get(0);
    assert.equal(out0.address().to_bech32(), ADVERT_RETIRE.tx.outputs[0].address);
    assert.equal(out0.amount().coin().toString(), ADVERT_RETIRE.tx.outputs[0].lovelace);
    assert.equal(body.validity_interval_start()?.toString(), ADVERT_RETIRE.tx.invalidBefore);
    assert.equal(body.ttl()?.toString(), ADVERT_RETIRE.tx.invalidAfter);
    assert.deepEqual(refInputs(r.txCbor), ADVERT_RETIRE.tx.referenceInputs);
    assert.deepEqual(requiredSigners(r.txCbor), [RETIRED_ADVERT.supplier_pkh]);
    assert.ok(unsigned(r.txCbor));
    assert.equal(r.advertRef, RETIRED_REF);
    assert.equal(r.returnLovelace, 2_017_080n);
    assert.equal(validatorToScriptHash(ADVERT_SCRIPT_UTXO.scriptRef!), ADVERT_SCRIPT_HASH);
    assert.deepEqual({ txHash: ADVERT_SCRIPT_UTXO.txHash, outputIndex: ADVERT_SCRIPT_UTXO.outputIndex }, ADVERT_REF_UTXO);
  });
  test('the evaluator is a verdict: the same Retire without the supplier\'s signature is rejected by the deployed validator', async () => {
    const node = retireNode();
    await ensureSlotConfig(node);
    const lucid = await lucidForAddress(node, RETIRE_WALLET_ADDRESS);
    await assert.rejects(lucid.newTx().readFrom([ADVERT_SCRIPT_UTXO]).collectFrom([ADVERT_RETIRE.advert], Data.to(new Constr(2, [])))
      .pay.ToAddress(RETIRE_WALLET_ADDRESS, { lovelace: 2_017_080n }).validFrom(RETIRE_NOW - 60_000).validTo(RETIRE_NOW + 300_000)
      .complete({ localUPLCEval: false }), /failed script execution/);
  });
  test('refuses a key that is not the advert\'s supplier, naming the supplier key, before anything is built', async () => {
    const other = STAKE_A.ownerAddress;
    const node = retireNode([{ ...ADVERT_RETIRE.wallet, address: other }, ADVERT_RETIRE.advert, ADVERT_SCRIPT_UTXO]);
    await assert.rejects(buildRetireAdvert(await lucidForAddress(node, other), node, { changeAddress: other, advertRef: RETIRED_REF, nowMs: RETIRE_NOW }, koiosFor()),
      new RegExp(`names supplier key ${RETIRED_ADVERT.supplier_pkh}, not the key of changeAddress; only its supplier can retire it`));
    assert.equal(node.evaluations.length, 0);
  });
  test('refuses an advert that is spent, of a spent state Koios does not report, not at the advert address, or not listed by the node', async () => {
    const node = retireNode();
    const lucid = await lucidForAddress(node, RETIRE_WALLET_ADDRESS);
    const retire = (koios: typeof fetch, n = node) => buildRetireAdvert(lucid, n, { changeAddress: RETIRE_WALLET_ADDRESS, advertRef: RETIRED_REF, nowMs: RETIRE_NOW }, koios);
    await assert.rejects(retire(koiosFor({ spent: true })), /has already been consumed \(retired or replaced\)/);
    await assert.rejects(retire(koiosFor({ spent: null })), /Koios did not report whether advert .* is unspent/);
    await assert.rejects(retire(koiosFor({ address: STAKE_A.ownerAddress })), /is not at the advert script address/);
    await assert.rejects(retire(koiosFor(), retireNode([ADVERT_RETIRE.wallet, ADVERT_SCRIPT_UTXO])), /The node does not list advert .* as unspent/);
    await assert.rejects(retire(koiosFor({ datum: encodeAdvertDatum({ ...RETIRED_ADVERT, model: 'other' }) })), /The node and Koios disagree about advert/);
  });
  test('refuses when the reference script is not the advert validator, and when the wallet has no collateral', async () => {
    const wrongScript = { ...ADVERT_SCRIPT_UTXO, scriptRef: { type: 'PlutusV3' as const, script: '4e4d01000033222220051200120011' } };
    const node = retireNode([ADVERT_RETIRE.wallet, ADVERT_RETIRE.advert, wrongScript]);
    await assert.rejects(buildRetireAdvert(await lucidForAddress(node, RETIRE_WALLET_ADDRESS), node, { changeAddress: RETIRE_WALLET_ADDRESS, advertRef: RETIRED_REF, nowMs: RETIRE_NOW }, koiosFor()),
      /is not the advert validator; nothing was built/);
    const poor = retireNode([{ ...ADVERT_RETIRE.wallet, assets: { lovelace: 3_000_000n } }, ADVERT_RETIRE.advert, ADVERT_SCRIPT_UTXO]);
    await assert.rejects(buildRetireAdvert(await lucidForAddress(poor, RETIRE_WALLET_ADDRESS), poor, { changeAddress: RETIRE_WALLET_ADDRESS, advertRef: RETIRED_REF, nowMs: RETIRE_NOW }, koiosFor()),
      /Collateral required/);
  });
});
