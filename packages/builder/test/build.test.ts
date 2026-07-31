// packages/builder/test/build.test.ts
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { LucidEvolution } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS, FIXTURE_TOKEN_UNIT } from './fixtures/fixture-provider.ts';
import { lucidForAddress, buildSendApex, buildSendTokens } from '../src/vector/build.ts';

// Decode helpers — CML is re-exported by @lucid-evolution/lucid, no extra dep.
// If a CML method name below is off (from_cbor_hex / body / outputs / amount /
// multi_asset traversal), cross-check against the mutation-tested reference:
// `git show feat/signer-package:packages/signer/src/decode.ts` — fix toward
// that, do not guess at the wasm API.
function decodeOutputs(cborHex: string): Array<{ address: string; lovelace: bigint; units: Record<string, bigint> }> {
  const tx = CML.Transaction.from_cbor_hex(cborHex);
  const outs = tx.body().outputs();
  const result = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    const amount = o.amount();
    const units: Record<string, bigint> = {};
    const ma = amount.multi_asset();
    if (ma) {
      const policies = ma.keys();
      for (let p = 0; p < policies.len(); p++) {
        const policy = policies.get(p);
        const assets = ma.get_assets(policy);
        if (!assets) continue;
        const names = assets.keys();
        for (let n = 0; n < names.len(); n++) {
          const name = names.get(n);
          units[policy.to_hex() + name.to_hex()] = BigInt(assets.get(name)!.toString());
        }
      }
    }
    result.push({ address: o.address().to_bech32(), lovelace: BigInt(amount.coin().toString()), units });
  }
  return result;
}
function decodeFee(cborHex: string): bigint {
  return BigInt(CML.Transaction.from_cbor_hex(cborHex).body().fee().toString());
}
function decodeMetadataLabels(cborHex: string): string[] {
  const aux = CML.Transaction.from_cbor_hex(cborHex).auxiliary_data();
  if (!aux) return [];
  const metadata = aux.metadata();
  if (!metadata) return [];
  const labels = metadata.labels();
  const out: string[] = [];
  for (let i = 0; i < labels.len(); i++) out.push(labels.get(i).toString());
  return out;
}

let lucid: LucidEvolution;
before(async () => {
  lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
});

describe('lucidForAddress', () => {
  test('rejects a malformed change address before any provider call', async () => {
    // A provider whose every method throws 'network' — if validation is
    // ordered correctly the error is about the address, not the network.
    const boobyTrapped = new FixtureProvider([]);
    (boobyTrapped as any).getProtocolParameters = () => { throw new Error('network hit'); };
    await assert.rejects(
      () => lucidForAddress(boobyTrapped, 'not-an-address'),
      /Invalid change address/,
    );
  });

  test('refuses an address with no UTxOs (nothing to build from)', async () => {
    await assert.rejects(
      () => lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), FOREIGN_ADDRESS),
      /No UTxOs found/,
    );
  });
});

describe('buildSendApex', () => {
  test('builds an unsigned tx paying the recipient with change to the own address', async () => {
    const r = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 });
    const outs = decodeOutputs(r.txCbor);
    const toRecipient = outs.filter((o) => o.address === FOREIGN_ADDRESS);
    assert.equal(toRecipient.length, 1);
    assert.equal(toRecipient[0].lovelace, 3_000_000n);
    const change = outs.filter((o) => o.address === OWN_ADDRESS);
    assert.ok(change.length >= 1, 'no change output back to the own address');
  });

  test('value is conserved: inputs = outputs + fee', async () => {
    const r = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 });
    const outs = decodeOutputs(r.txCbor);
    const totalOut = outs.reduce((s, o) => s + o.lovelace, 0n);
    const fee = decodeFee(r.txCbor);
    const tx = CML.Transaction.from_cbor_hex(r.txCbor);
    const inputs = tx.body().inputs();
    let totalIn = 0n;
    for (let i = 0; i < inputs.len(); i++) {
      const input = inputs.get(i);
      const match = FIXTURE_UTXOS.find(
        (u) => u.txHash === input.transaction_id().to_hex() && u.outputIndex === Number(input.index()),
      );
      assert.ok(match, 'tx consumed an input that is not in the fixture set');
      totalIn += BigInt(match.assets.lovelace);
    }
    assert.equal(totalIn, totalOut + fee, 'lovelace not conserved');
    assert.equal(r.fee, fee.toString(), 'reported fee differs from CBOR fee');
  });

  test('the result is UNSIGNED and the hash matches the body', async () => {
    const r = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 });
    const tx = CML.Transaction.from_cbor_hex(r.txCbor);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'built tx must carry no vkey witnesses');
    assert.equal(CML.hash_transaction(tx.body()).to_hex(), r.txHash);
  });

  test('attaches JSON metadata under label 674', async () => {
    const r = await buildSendApex(lucid, {
      recipientAddress: FOREIGN_ADDRESS, amountApex: 3, metadataJson: '{"msg":"hi"}',
    });
    assert.deepEqual(decodeMetadataLabels(r.txCbor), ['674']);
  });

  test('rejects a malformed recipient before building', async () => {
    await assert.rejects(
      () => buildSendApex(lucid, { recipientAddress: 'addr1garbage', amountApex: 3 }),
      /Invalid recipient address/,
    );
  });

  test('rejects a non-positive amount', async () => {
    await assert.rejects(() => buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 0 }), /positive/);
    await assert.rejects(() => buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: -5 }), /positive/);
  });

  test('pins exact lovelace at the call site for a fractional amount float math gets wrong', async () => {
    // 1.005 * 1_000_000 === 1004999.9999999999 in IEEE-754 (node -e
    // "console.log(Math.floor(1.005*1e6))" -> 1004999, one lovelace short of
    // the correct 1005000; see packages/shared/test/tx.test.ts for the full
    // empirical proof). apexToLovelace itself is already proven exact there -
    // this test instead pins that buildSendApex's call site actually invokes
    // it, so a future edit reverting to Math.floor(amountApex * 1_000_000)
    // fails HERE, not just in an untouched helper's own unit tests.
    const r = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 1.005 });
    const outs = decodeOutputs(r.txCbor);
    const toRecipient = outs.filter((o) => o.address === FOREIGN_ADDRESS);
    assert.equal(toRecipient.length, 1);
    assert.equal(
      toRecipient[0].lovelace, 1_005_000n,
      'lost a lovelace - buildSendApex must call apexToLovelace, not Math.floor(amountApex * 1_000_000)',
    );
  });
});

describe('buildSendTokens', () => {
  test('moves the token with the requested AP3X and returns change', async () => {
    const r = await buildSendTokens(lucid, {
      recipientAddress: FOREIGN_ADDRESS,
      policyId: FIXTURE_TOKEN_UNIT.slice(0, 56),
      assetName: FIXTURE_TOKEN_UNIT.slice(56),
      amount: '200',
    });
    const outs = decodeOutputs(r.txCbor);
    const toRecipient = outs.find((o) => o.address === FOREIGN_ADDRESS);
    assert.ok(toRecipient, 'no output to recipient');
    assert.equal(toRecipient.units[FIXTURE_TOKEN_UNIT], 200n);
    assert.equal(toRecipient.lovelace, 2_000_000n, 'default min-ADA accompaniment expected');
    // the remaining 300 tokens must come back as change
    const change = outs.filter((o) => o.address === OWN_ADDRESS);
    const changeTokens = change.reduce((s, o) => s + (o.units[FIXTURE_TOKEN_UNIT] ?? 0n), 0n);
    assert.equal(changeTokens, 300n, 'token change not conserved');
  });

  test('converts a human-readable asset name to hex', async () => {
    const r = await buildSendTokens(lucid, {
      recipientAddress: FOREIGN_ADDRESS,
      policyId: FIXTURE_TOKEN_UNIT.slice(0, 56),
      assetName: 'TestToken',            // text, not hex — must become 54657374546f6b656e
      amount: '10',
    });
    const outs = decodeOutputs(r.txCbor);
    const toRecipient = outs.find((o) => o.address === FOREIGN_ADDRESS)!;
    assert.equal(toRecipient.units[FIXTURE_TOKEN_UNIT], 10n);
  });

  test('rejects a malformed policy id (not 56 hex chars)', async () => {
    await assert.rejects(
      () => buildSendTokens(lucid, { recipientAddress: FOREIGN_ADDRESS, policyId: 'beef', assetName: '', amount: '1' }),
      /policy id/i,
    );
  });

  test('rejects a non-positive token amount', async () => {
    await assert.rejects(
      () => buildSendTokens(lucid, {
        recipientAddress: FOREIGN_ADDRESS, policyId: FIXTURE_TOKEN_UNIT.slice(0, 56), assetName: '', amount: '0',
      }),
      /positive/,
    );
  });

  test('pins exact lovelace at the call site on the apexAmount path for a fractional amount float math gets wrong', async () => {
    // Same defect class as buildSendApex's pin above, but 1.005 AP3X
    // (1,005,000 lovelace) turned out to be BELOW this output's actual
    // min-UTxO once it carries a native asset - Lucid silently bumped it to
    // 1,043,020 during .complete(), which would have made this test measure
    // ledger dust-floor behavior instead of the float-conversion bug it
    // exists to pin (confirmed empirically: that bump reproduces regardless
    // of amountApex's exactness, so it is not this defect). Reused the
    // endorse test's already-verified defect value instead - comfortably
    // above min-UTxO here too, since the existing 2,000,000n default (see
    // 'moves the token...' above) is already sufficient for this same
    // single-token output shape:
    // 8.03 * 1_000_000 === 8029999.999999999 in IEEE-754 (node -e
    // "console.log(Math.floor(8.03*1e6))" -> 8029999, one lovelace short of
    // the correct 8030000). This is the apexAmount branch's OWN call site
    // (build.ts's buildSendTokens, not buildSendApex), so it needs its own
    // pin; a shared helper test cannot prove either caller wires it up.
    const r = await buildSendTokens(lucid, {
      recipientAddress: FOREIGN_ADDRESS,
      policyId: FIXTURE_TOKEN_UNIT.slice(0, 56),
      assetName: FIXTURE_TOKEN_UNIT.slice(56),
      amount: '50',
      apexAmount: 8.03,
    });
    const outs = decodeOutputs(r.txCbor);
    const toRecipient = outs.find((o) => o.address === FOREIGN_ADDRESS);
    assert.ok(toRecipient, 'no output to recipient');
    assert.equal(
      toRecipient.lovelace, 8_030_000n,
      'lost a lovelace - buildSendTokens apexAmount path must call apexToLovelace, not Math.floor(apexAmount * 1_000_000)',
    );
  });
});
