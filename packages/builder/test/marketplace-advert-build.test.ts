// packages/builder/test/marketplace-advert-build.test.ts
// The identity-marketplace advert builders (Part 2 Section 6.2) offline: post, update and retire, against the real applied advert
// script (identity-world's deployment, local evaluation), with the listing rule checked on the agent's record.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { DEPLOYMENT, NOW, OWN_ADDRESS, identityWorld, lucidOn } from './fixtures/identity-world.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import { ADVERT_REF, AGENT_ID, AGENT_DID, IDENTITY_ADVERT, OWN_PKH, SUPPLIER_PKH, advertUtxo, agentRecord, supplierEnterprise } from './fixtures/escrow-identity.fixture.ts';
import { buildAdvertPost, buildAdvertUpdate, buildAdvertRetire, advertTermsOf, EMPTY_DETAIL_HASH } from '../src/vector/marketplace-advert-build.ts';
import { decodeIdentityAdvertDatum } from '../src/vector/marketplace-datum.ts';

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
const terms = advertTermsOf(IDENTITY_ADVERT);

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
  });
  test('refuses an agent that fails the listing rule, and terms buyers could not hire', async () => {
    await assert.rejects(post([agentRecord({ capabilities: [] })]), /does not list the capability/);
    await assert.rejects(post([agentRecord({ keys: [] })]), /does not list the supplier key/);
    await assert.rejects(post([agentRecord()], { endpointUrl: 'http://agent.example' }), /endpoint_url must be an https URL/);
    await assert.rejects(post([agentRecord()], { priceLovelace: 10_000_000_000n }), /at most 10,000 AP3X/);
    await assert.rejects(post([agentRecord()], { maxProcessingMs: 86_400_001 }), /max_processing_ms must be 1 to 86400000/);
  });
});

describe('advert update and retirement (the real advert script)', () => {
  const ctx = async (records: UTxO[], wallet: string = OWN_ADDRESS, extra: UTxO[] = []) => {
    const world = identityWorld([advertUtxo(), ...records, ...extra]);
    return { lucid: wallet === OWN_ADDRESS ? await lucidOn(world) : await lucidForAddress(world, wallet), provider: world, deployment: DEPLOYMENT };
  };
  test('UpdateAdvert keeps the supplier and the agent, raises advertised_at to now, and writes the new terms', async () => {
    const r = await buildAdvertUpdate(await ctx([agentRecord()]), { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { priceLovelace: 3_000_000n } });
    const out = outputs(r.txCbor).find((o) => o.address === DEPLOYMENT.advert.address)!;
    const advert = decodeIdentityAdvertDatum(out.datum!);
    assert.deepEqual([advert.price_lovelace, advert.agent_id, advert.supplier_pkh, advert.advertised_at], [3_000_000n, AGENT_ID, SUPPLIER_PKH, NOW]);
    assert.deepEqual(redeemerData(r.txCbor), ['d87a80'], 'UpdateAdvert');
    assert.deepEqual(requiredSigners(r.txCbor), [SUPPLIER_PKH]);
  });
  test('an update that keeps the advert Active needs the listing rule; one that retires it in place does not', async () => {
    const off = await ctx([agentRecord({ capabilities: [] })]);
    await assert.rejects(buildAdvertUpdate(off, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { model: 'echo-v2' } }), /does not list the capability/);
    const r = await buildAdvertUpdate(off, { changeAddress: OWN_ADDRESS, nowMs: NOW, advertRef: ADVERT_REF, changes: { status: 'Retired' } });
    assert.equal(decodeIdentityAdvertDatum(outputs(r.txCbor).find((o) => o.address === DEPLOYMENT.advert.address)!.datum!).status, 'Retired');
  });
  test('RetireAdvert pays the deposit to the supplier key: to the wallet when it is the supplier\'s, else to its enterprise address', async () => {
    const own = await buildAdvertRetire(await ctx([], supplierEnterprise, [supplierWallet]), { changeAddress: supplierEnterprise, nowMs: NOW, advertRef: ADVERT_REF });
    assert.equal(own.paidTo, supplierEnterprise);
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
