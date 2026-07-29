// packages/builder/test/fixtures/fixture-provider.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Lucid } from '@lucid-evolution/lucid';
import { FixtureProvider, fixtureProtocolParameters, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS } from './fixture-provider.ts';

describe('FixtureProvider', () => {
  test('serves the captured protocol parameters with bigints revived', () => {
    const p = fixtureProtocolParameters();
    assert.equal(p.minFeeA, 45);
    assert.equal(p.minFeeB, 156253);
    assert.equal(typeof p.coinsPerUtxoByte, 'bigint');
    assert.ok(p.costModels.PlutusV2, 'PlutusV2 cost model missing from fixture');
  });

  test('getUtxos filters by address and returns nothing for a foreign address', async () => {
    const provider = new FixtureProvider(FIXTURE_UTXOS);
    assert.equal((await provider.getUtxos(OWN_ADDRESS)).length, 3);
    assert.equal((await provider.getUtxos(FOREIGN_ADDRESS)).length, 0);
  });

  test('network-only methods throw loudly instead of hanging', async () => {
    const provider = new FixtureProvider(FIXTURE_UTXOS);
    await assert.rejects(() => provider.submitTx('84'), /offline/);
    await assert.rejects(() => provider.getDelegation('stake1xyz'), /offline/);
  });

  // The offline replication of the PR-4 spike: a REAL unsigned transaction,
  // built with no key and no network. If this test passes, every later build
  // test has a working foundation.
  test('Lucid + FixtureProvider builds a real unsigned tx via fromAddress', async () => {
    const lucid = await Lucid(new FixtureProvider(FIXTURE_UTXOS), 'Mainnet');
    const utxos = await lucid.utxosAt(OWN_ADDRESS);
    lucid.selectWallet.fromAddress(OWN_ADDRESS, utxos);
    const tx = await lucid.newTx().pay.ToAddress(FOREIGN_ADDRESS, { lovelace: 3_000_000n }).complete();
    const cbor = tx.toCBOR();
    assert.ok(cbor.length > 200, `unsigned tx CBOR suspiciously short: ${cbor.length} hex chars`);
    assert.match(cbor, /^84/, 'Conway-era tx CBOR must start with array header 0x84');
  });
});
