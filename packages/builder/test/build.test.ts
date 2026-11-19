// packages/builder/test/build.test.ts
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { LucidEvolution } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS, FIXTURE_TOKEN_UNIT } from './fixtures/fixture-provider.ts';
import { lucidForAddress, buildMultiOutput, buildSendApex, buildSendTokens } from '../src/vector/build.ts';

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

  const listsIn = (levels: number): string => `${'['.repeat(levels)}1${']'.repeat(levels)}`;
  const sendWith = (metadataJson: string) => buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3, metadataJson });
  const payWith = (metadataJson: string) => buildMultiOutput(lucid, { outputs: [{ address: FOREIGN_ADDRESS, lovelace: 2_000_000 }], metadataJson });

  test('builds with metadata at the limits: 63 levels of lists, a text of 64 characters, and a JSON text of 63,601 characters that fits in a transaction', async () => {
    const numbers = JSON.stringify(Array(15_900).fill(-24));
    assert.equal(numbers.length, 63_601);
    for (const metadataJson of [listsIn(63), JSON.stringify({ ['k'.repeat(64)]: 'x'.repeat(64) }), numbers]) {
      for (const build of [sendWith, payWith]) {
        const { txCbor } = await build(metadataJson);
        assert.deepEqual(decodeMetadataLabels(txCbor), ['674']);
        assert.ok(txCbor.length / 2 <= 16_384, 'the transaction is inside the limit of the ledger');
      }
    }
  });

  test('refuses metadata that no transaction can hold, with a short message, before Lucid reads it', async () => {
    const levels = 'The metadata has more than 63 levels of lists and maps.';
    const text = 'The metadata has a text of 65 characters, and a text of metadata has at most 64.';
    const refused: Array<[string, string]> = [
      [listsIn(64), levels],
      [listsIn(2_000), levels],
      [`${'{"a":'.repeat(64)}1${'}'.repeat(64)}`, levels],
      [JSON.stringify(Array(16_384).fill(1)), 'The metadata needs more than 16384 bytes, and a transaction has at most 16384.'],
      [JSON.stringify({ msg: 'x'.repeat(65) }), text],
      [JSON.stringify({ ['k'.repeat(65)]: 1 }), text],
      ['[1,[2,null]]', 'The metadata has the value null, and a value of metadata is a text, a number, a list or a map.'],
      ['{"a":true}', 'The metadata has the value true, and a value of metadata is a text, a number, a list or a map.'],
    ];
    for (const [metadataJson, message] of refused) {
      await assert.rejects(() => sendWith(metadataJson), { message });
      await assert.rejects(() => payWith(metadataJson), { message });
    }
  });

  test('does not refuse a list of 16,383 numbers for its size: one value fewer than the list that it refuses', async () => {
    const outcome = await sendWith(JSON.stringify(Array(16_383).fill(1))).then(() => 'built', (error: Error) => error.message);
    assert.doesNotMatch(outcome, /^The metadata needs more than/);
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

  test('builds a sub-1-AP3X send at the new schema floor (audit D: the dust floor)', async () => {
    // vector.ts's amount schema used to be z.number().min(1), which forbade
    // this send outright. Task 3 moved the schema floor to 0.000001 AP3X (one
    // lovelace) and left the ledger's own min-UTxO rule - a function of
    // coinsPerUtxoByte (4310 in this fixture's captured protocol params) and
    // the output's serialized size - to be the real, size-dependent
    // constraint, surfaced by Lucid when an output is actually too small.
    //
    // Empirically (this fixture, this Lucid version): a plain single-address,
    // no-asset, no-datum output bottoms out at 849,070 lovelace (~0.84907
    // AP3X) - close to the plan's own 0.85-1.0 AP3X estimate. Lucid does NOT
    // throw below that floor; .complete() silently bumps the coin value up to
    // it instead, which would make a smaller test amount here measure Lucid's
    // rounding-up behavior instead of the schema-floor change this test
    // exists to pin. 0.9 AP3X clears that floor with margin, stays under 1
    // AP3X (the old, now-removed schema minimum) to prove the point, and sits
    // in the same CBOR uint32 size class as the floor itself (both encode as
    // 5 bytes), so the floor does not shift between the two values.
    const r = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 0.9 });
    const outs = decodeOutputs(r.txCbor);
    const toRecipient = outs.filter((o) => o.address === FOREIGN_ADDRESS);
    assert.equal(toRecipient.length, 1);
    assert.equal(
      toRecipient[0].lovelace, 900_000n,
      'sub-1-AP3X send must build offline and carry the exact requested lovelace amount',
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
