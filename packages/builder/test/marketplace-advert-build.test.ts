// packages/builder/test/marketplace-advert-build.test.ts
// The identity-marketplace advert builders (Part 2 Section 6.2) offline: post, update and retire, against the real applied advert
// script (identity-world's deployment, local evaluation), with the listing rule checked on the agent's record. The terms rules of both
// layouts (checkAdvertTerms, detailHashFor) apply to the identity builders as they apply to the legacy Post (marketplace-advert.test.ts
// covers each rule through planPostAdvert); and advertLayoutAt sends a Retire to the builder of the advert's layout.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { DEPLOYMENT, NOW, OWN_ADDRESS, identityWorld, lucidOn } from './fixtures/identity-world.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import { ADVERT_REF, AGENT_ID, IDENTITY_ADVERT, OWN_PKH, SUPPLIER_PKH, advertUtxo, agentRecord, supplierEnterprise } from './fixtures/escrow-identity.fixture.ts';
import { ADVERT_DATUM_HEX } from './fixtures/marketplace.fixture.ts';
import { buildAdvertPost, buildAdvertUpdate, buildAdvertRetire, advertTermsOf, advertLayoutAt, detailHashFor } from '../src/vector/marketplace-advert-build.ts';
import { ADVERT_ADDRESS, EMPTY_DETAIL_HASH, MIN_PROCESSING_MS_FLOOR } from '../src/vector/marketplace-constants.ts';
import { decodeIdentityAdvertDatum } from '../src/vector/marketplace-datum.ts';
import type { IdentityAdvertDatum } from '../src/vector/marketplace-datum.ts';

const outputs = (txCbor: string) => {
  const outs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  return Array.from({ length: outs.len() }, (_, i) => ({ address: outs.get(i).address().to_bech32(), lovelace: BigInt(outs.get(i).amount().coin().toString()), datum: outs.get(i).datum()?.as_datum()?.to_cbor_hex() ?? null }));
};
const requiredSigners = (txCbor: string): string[] => { const s = CML.Transaction.from_cbor_hex(txCbor).body().required_signers(); return s ? Array.from({ length: s.len() }, (_, i) => s.get(i).to_hex()) : []; };
const redeemerData = (txCbor: string): string[] => {
  const r = CML.Transaction.from_cbor_hex(txCbor).witness_set().redeemers()?.as_arr_legacy_redeemer();
  return r ? Array.from({ length: r.len() }, (_, i) => r.get(i).data().to_cbor_hex()) : [];
};
const supplierWallet: UTxO = { txHash: '08'.repeat(32), outputIndex: 0, address: supplierEnterprise, assets: { lovelace: 100_000_000n } };
// The shared fixture advert has a 60,000 ms window, which escrows can name but a supplier template cannot serve (MIN_PROCESSING_MS_FLOOR):
// the advert builders write the template default instead, and an update starts from an advert they could have written.
const HIREABLE: IdentityAdvertDatum = { ...IDENTITY_ADVERT, max_processing_ms: 180_000 };
const terms = advertTermsOf(HIREABLE);
const datumOf = (txCbor: string) => decodeIdentityAdvertDatum(outputs(txCbor).find((o) => o.address === DEPLOYMENT.advert.address)!.datum!);

describe('vector advert post (identity layout)', () => {
  const post = async (records: UTxO[], over: Partial<typeof terms> = {}) => {
    const world = identityWorld(records);
    return buildAdvertPost({ lucid: await lucidOn(world), provider: world, deployment: DEPLOYMENT }, { changeAddress: OWN_ADDRESS, nowMs: NOW, agentId: AGENT_ID, supplierPkh: SUPPLIER_PKH, terms: { ...terms, ...over } });
  };
  test('writes the advert at the identity advert address with the agent, Active, advertised now; the supplier key signs', async () => {
    const r = await post([agentRecord()]);
    const outs = outputs(r.txCbor);
    const at = outs.findIndex((o) => o.address === DEPLOYMENT.advert.address);
    const out = outs[at];
    const advert = decodeIdentityAdvertDatum(out.datum!);
    assert.deepEqual([advert.agent_id, advert.status, advert.supplier_pkh, advert.advertised_at, advert.detail_hash], [AGENT_ID, 'Active', SUPPLIER_PKH, NOW, EMPTY_DETAIL_HASH]);
    assert.ok(out.lovelace >= 2_000_000n);
    assert.deepEqual(requiredSigners(r.txCbor), [SUPPLIER_PKH]);
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [SUPPLIER_PKH, OWN_PKH]);
    assert.equal(r.advertRef, `${r.txHash}#${at}`);
    assert.equal(r.spentRef, null);
  });
  test('refuses an agent that fails the listing rule', async () => {
    await assert.rejects(post([agentRecord({ capabilities: [] })]), /does not list the capability/);
    await assert.rejects(post([agentRecord({ keys: [] })]), /does not list the supplier key/);
  });
  test('the terms rules of both layouts: endpoint, field limits, fleet capability ids, window and value cap', async () => {
    const refused: Array<[Partial<typeof terms>, RegExp]> = [
      [{ endpointUrl: 'http://agent.example' }, /endpoint_url must be an https URL/],
      [{ endpointUrl: 'https://agent.example ' }, /endpoint_url must not contain whitespace/],
      [{ endpointUrl: 'https://agent.example/api?key=1' }, /endpoint_url must not contain a query \(\?\)/],
      [{ endpointUrl: 'https://agent.example#a' }, /endpoint_url must not contain a fragment \(#\)/],
      [{ endpointUrl: 'https://u:p@agent.example' }, /endpoint_url must not carry credentials/],
      [{ endpointUrl: 'https://10.1.2.3' }, /endpoint_url points at a private or reserved address/],
      [{ capabilityId: `demo.${'c'.repeat(60)}` }, /capability_id is 65 bytes as UTF-8; an advert field holds at most 64/],
      [{ detailUri: 'http://agent.example/agent.json', detailHash: 'ab'.repeat(32) }, /detail_uri must be an https URL/],
      [{ model: 'echo\nv1' }, /model must not contain control characters or line breaks/],
      [{ capabilityId: 'llm.chat.v1' }, /capability_id llm\.chat\.v1 is in a fleet namespace/],
      [{ maxProcessingMs: 60_000 }, /max_processing_ms must be a whole number from 60001: a supplier template needs at least its SERVICE_TIMEOUT_MS \+ 60000 ms/],
      [{ maxProcessingMs: 86_400_001 }, /max_processing_ms is 86400001, more than 86400000 \(24 h\)/],
      [{ priceLovelace: 9_998_000_001n }, /above the 10000000000 lovelace \(10,000 AP3X\) value cap of an escrow \(F-29\)/],
    ];
    for (const [over, why] of refused) await assert.rejects(post([agentRecord()], over), why, JSON.stringify(over, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(datumOf((await post([agentRecord()], { maxProcessingMs: MIN_PROCESSING_MS_FLOOR })).txCbor).max_processing_ms, 60_001, 'the floor itself');
    assert.equal(datumOf((await post([agentRecord()], { priceLovelace: 9_998_000_000n })).txCbor).price_lovelace, 9_998_000_000n, 'the cap itself');
  });
  test('endpoint_url and detail_uri hold 256 bytes in the identity layout (its encoder splits longer bytestrings): 256 is written, 257 refused', async () => {
    const url = (bytes: number) => `https://agent.example/${'a'.repeat(bytes - 22)}`;
    assert.equal(Buffer.byteLength(url(256)), 256);
    const endpoint = datumOf((await post([agentRecord()], { endpointUrl: url(256) })).txCbor);
    assert.equal(endpoint.endpoint_url, url(256), 'the 256-byte endpoint is in the datum, read back whole');
    await assert.rejects(post([agentRecord()], { endpointUrl: url(257) }), /endpoint_url is 257 bytes as UTF-8; an identity-layout advert holds at most 256 in it/);
    const detail = datumOf((await post([agentRecord()], { detailUri: url(256), detailHash: 'ab'.repeat(32) })).txCbor);
    assert.equal(detail.detail_uri, url(256));
    await assert.rejects(post([agentRecord()], { detailUri: url(257), detailHash: 'ab'.repeat(32) }), /detail_uri is 257 bytes as UTF-8; an identity-layout advert holds at most 256 in it/);
  });
  test('a detail_uri needs its detail_hash ("" counts as not given); without one the hash is that of no bytes; nothing is fetched', async () => {
    for (const detailHash of [undefined, '']) {
      await assert.rejects(post([agentRecord()], { detailUri: 'https://agent.example/agent.json', detailHash }), /detail_hash is required with a detail_uri: pass the sha256 \(64 hex\) of the exact bytes detail_uri serves\. This server does not fetch it/);
    }
    const given = 'AB'.repeat(32);
    const withUri = datumOf((await post([agentRecord()], { detailUri: 'https://agent.example/agent.json', detailHash: given })).txCbor);
    assert.deepEqual([withUri.detail_uri, withUri.detail_hash], ['https://agent.example/agent.json', given.toLowerCase()]);
    assert.equal(datumOf((await post([agentRecord()], { detailUri: '', detailHash: '' })).txCbor).detail_hash, EMPTY_DETAIL_HASH);
    assert.deepEqual(detailHashFor('', undefined), { detailHash: EMPTY_DETAIL_HASH, source: 'empty' });
    assert.deepEqual(detailHashFor('https://agent.example/agent.json', given), { detailHash: given, source: 'given' });
  });
});

describe('advert update and retirement (the real advert script)', () => {
  const ctx = async (records: UTxO[], wallet: string = OWN_ADDRESS, extra: UTxO[] = [], advert: IdentityAdvertDatum = HIREABLE) => {
    const world = identityWorld([advertUtxo(advert), ...records, ...extra]);
    return { lucid: wallet === OWN_ADDRESS ? await lucidOn(world) : await lucidForAddress(world, wallet), provider: world, deployment: DEPLOYMENT };
  };
  test('UpdateAdvert keeps the supplier and the agent, raises advertised_at to now, and writes the new terms', async () => {
    const r = await buildAdvertUpdate(await ctx([agentRecord()]), { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { priceLovelace: 3_000_000n } });
    const advert = datumOf(r.txCbor);
    assert.deepEqual([advert.price_lovelace, advert.agent_id, advert.supplier_pkh, advert.advertised_at], [3_000_000n, AGENT_ID, SUPPLIER_PKH, NOW]);
    assert.deepEqual(redeemerData(r.txCbor), ['d87a80'], 'UpdateAdvert');
    assert.deepEqual(requiredSigners(r.txCbor), [SUPPLIER_PKH]);
    assert.equal(r.spentRef, ADVERT_REF);
  });
  test('an update that keeps the advert Active needs the listing rule; one that retires it in place does not', async () => {
    const off = await ctx([agentRecord({ capabilities: [] })]);
    await assert.rejects(buildAdvertUpdate(off, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { model: 'echo-v2' } }), /does not list the capability/);
    const r = await buildAdvertUpdate(off, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { status: 'Retired' } });
    assert.equal(datumOf(r.txCbor).status, 'Retired');
  });
  test('the new terms follow the rules of a post, the terms the update keeps included', async () => {
    const live = await ctx([agentRecord()]);
    await assert.rejects(buildAdvertUpdate(live, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { endpointUrl: 'https://agent.example/?x=1' } }), /endpoint_url must not contain a query/);
    await assert.rejects(buildAdvertUpdate(live, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { maxProcessingMs: 60_000 } }), /max_processing_ms must be a whole number from 60001/);
    // The fixture advert's 60,000 ms window is kept unless the update changes it, so the update is refused until it does.
    const short = await ctx([agentRecord()], OWN_ADDRESS, [], IDENTITY_ADVERT);
    await assert.rejects(buildAdvertUpdate(short, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { priceLovelace: 3_000_000n } }), /max_processing_ms must be a whole number from 60001/);
    const fixed = await buildAdvertUpdate(short, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { priceLovelace: 3_000_000n, maxProcessingMs: 180_000 } });
    assert.equal(datumOf(fixed.txCbor).max_processing_ms, 180_000);
  });
  test('a new detail_uri needs its detail_hash; detail_uri "" goes back to the hash of no bytes', async () => {
    const live = await ctx([agentRecord()]);
    await assert.rejects(buildAdvertUpdate(live, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { detailUri: 'https://agent.example/agent.json' } }), /detail_hash is required with a detail_uri/);
    const given = 'cd'.repeat(32);
    const withUri = await buildAdvertUpdate(live, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { detailUri: 'https://agent.example/agent.json', detailHash: given } });
    assert.deepEqual([datumOf(withUri.txCbor).detail_uri, datumOf(withUri.txCbor).detail_hash], ['https://agent.example/agent.json', given]);
    const withManifest = await ctx([agentRecord()], OWN_ADDRESS, [], { ...HIREABLE, detail_uri: 'https://agent.example/agent.json', detail_hash: given });
    const cleared = await buildAdvertUpdate(withManifest, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { detailUri: '' } });
    assert.deepEqual([datumOf(cleared.txCbor).detail_uri, datumOf(cleared.txCbor).detail_hash], ['', EMPTY_DETAIL_HASH]);
    const kept = await buildAdvertUpdate(withManifest, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { model: 'echo-v2', detailHash: '' } });
    assert.equal(datumOf(kept.txCbor).detail_hash, given, 'a detail_hash of "" changes nothing');
  });
  test('RetireAdvert pays the deposit to the supplier key: to the wallet when it is the supplier\'s, else to its enterprise address', async () => {
    const own = await buildAdvertRetire(await ctx([], supplierEnterprise, [supplierWallet]), { changeAddress: supplierEnterprise, nowMs: NOW, advertRef: ADVERT_REF });
    assert.equal(own.paidTo, supplierEnterprise);
    assert.equal(own.spentRef, ADVERT_REF);
    assert.deepEqual(redeemerData(own.txCbor), ['d87b80'], 'RetireAdvert');
    const other = await buildAdvertRetire(await ctx([]), { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF });
    assert.ok(outputs(other.txCbor).some((o) => o.address === supplierEnterprise && o.lovelace === 2_000_000n));
    assert.deepEqual(requiredSigners(other.txCbor), [SUPPLIER_PKH]);
  });
  test('an advert that is not on the node, or not at the identity advert address, is refused', async () => {
    const empty = identityWorld([]);
    await assert.rejects(buildAdvertRetire({ lucid: await lucidOn(empty), provider: empty, deployment: DEPLOYMENT }, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF }), /is not an unspent output on the node/);
    const misplaced = identityWorld([advertUtxo(IDENTITY_ADVERT, { address: DEPLOYMENT.escrow.address })]);
    await assert.rejects(buildAdvertRetire({ lucid: await lucidOn(misplaced), provider: misplaced, deployment: DEPLOYMENT }, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF }), /not at the identity-marketplace advert address/);
  });
});

describe('advertLayoutAt: which builder retires an advert', () => {
  const LEGACY_REF = `${'1e'.repeat(32)}#0`;
  const legacyAdvert: UTxO = { txHash: '1e'.repeat(32), outputIndex: 0, address: ADVERT_ADDRESS, assets: { lovelace: 2_000_000n }, datum: ADVERT_DATUM_HEX };
  test('the legacy advert script is the legacy layout, with or without a deployment; the deployment\'s advert script is the identity layout', async () => {
    const world = identityWorld([legacyAdvert, advertUtxo(HIREABLE)]);
    assert.equal(await advertLayoutAt(world, LEGACY_REF, DEPLOYMENT), 'legacy');
    assert.equal(await advertLayoutAt(world, LEGACY_REF, null), 'legacy', 'suppliers retire legacy adverts on a server without the identity deployment too');
    assert.equal(await advertLayoutAt(world, ADVERT_REF, DEPLOYMENT), 'identity');
  });
  test('refuses an output that is not on the node, one at neither advert script, and an identity advert without a deployment', async () => {
    const world = identityWorld([advertUtxo(HIREABLE, { address: DEPLOYMENT.escrow.address })]);
    await assert.rejects(advertLayoutAt(world, LEGACY_REF, DEPLOYMENT), /is not an unspent output on the node/);
    await assert.rejects(advertLayoutAt(world, ADVERT_REF, DEPLOYMENT), /is not at an advert script address/);
    await assert.rejects(advertLayoutAt(identityWorld([advertUtxo(HIREABLE)]), ADVERT_REF, null), /is not at the legacy advert address, and this server cannot read an identity-marketplace advert\. The identity registry is not configured on this server/);
  });
});
