// packages/builder/test/build-contracts.test.ts
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CML, applyDoubleCborEncoding, validatorToAddress, validatorToScriptHash, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS, FIXTURE_TXHASH } from './fixtures/fixture-provider.ts';
import { lucidForAddress, buildMultiOutput, buildDeployContract, buildInteractContract } from '../src/vector/build.ts';

const ALWAYS_SUCCEEDS_V2 = '49480100002221200101';
const validator: SpendingValidator = { type: 'PlutusV2', script: applyDoubleCborEncoding(ALWAYS_SUCCEEDS_V2) };
const SCRIPT_ADDRESS = validatorToAddress('Mainnet', validator);

function outputsOf(cborHex: string): Array<{ address: string; lovelace: bigint }> {
  const outs = CML.Transaction.from_cbor_hex(cborHex).body().outputs();
  const result = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    result.push({ address: o.address().to_bech32(), lovelace: BigInt(o.amount().coin().toString()) });
  }
  return result;
}

let lucid: LucidEvolution;
before(async () => {
  lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
});

describe('buildMultiOutput', () => {
  test('pays every output and conserves value', async () => {
    const r = await buildMultiOutput(lucid, {
      outputs: [
        { address: FOREIGN_ADDRESS, lovelace: 2_000_000 },
        { address: FOREIGN_ADDRESS, lovelace: 3_000_000 },
      ],
    });
    const outs = outputsOf(r.txCbor);
    const foreign = outs.filter((o) => o.address === FOREIGN_ADDRESS);
    assert.equal(foreign.length, 2);
    assert.deepEqual(foreign.map((o) => o.lovelace).sort(), [2_000_000n, 3_000_000n]);
  });

  test('rejects an empty output list', async () => {
    await assert.rejects(() => buildMultiOutput(lucid, { outputs: [] }), /At least one output/);
  });

  test('rejects an invalid recipient address among the outputs', async () => {
    await assert.rejects(
      () => buildMultiOutput(lucid, { outputs: [{ address: 'addr1garbage', lovelace: 2_000_000 }] }),
      /Invalid recipient address/,
    );
  });
});

describe('buildDeployContract', () => {
  test('locks funds at the derived script address with an inline datum', async () => {
    const r = await buildDeployContract(lucid, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', lovelaceAmount: 2_000_000,
    });
    assert.equal(r.scriptAddress, SCRIPT_ADDRESS);
    assert.equal(r.scriptHash, validatorToScriptHash(validator));
    const outs = outputsOf(r.txCbor);
    const toScript = outs.find((o) => o.address === SCRIPT_ADDRESS);
    assert.ok(toScript, 'no output to script address');
    assert.equal(toScript.lovelace, 2_000_000n);
    // unsigned, as always
    const vkeys = CML.Transaction.from_cbor_hex(r.txCbor).witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0);
  });

  test("deploy with initialDatum '' fails loudly instead of silently voiding", async () => {
    // '' is falsy but caller-supplied; ?? must let it flow through and fail
    // loudly downstream rather than defaulting to Data.void().
    await assert.rejects(buildDeployContract(lucid, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', initialDatum: '',
    }));
  });
});

describe('buildInteractContract', () => {
  test('lock: sends funds to the script address', async () => {
    const r = await buildInteractContract(lucid, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'lock',
      changeAddress: OWN_ADDRESS, lovelaceAmount: 2_000_000,
    });
    assert.equal(r.action, 'lock');
    const toScript = outputsOf(r.txCbor).find((o) => o.address === SCRIPT_ADDRESS);
    assert.ok(toScript && toScript.lovelace === 2_000_000n);
  });

  test('lock: rejects an empty-string datum instead of silently treating it as void', async () => {
    // '' is falsy but caller-supplied; ?? must let it flow through and fail
    // loudly downstream rather than defaulting to Data.void() (locking funds
    // under a datum the caller never asked for).
    await assert.rejects(() => buildInteractContract(lucid, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'lock',
      changeAddress: OWN_ADDRESS, lovelaceAmount: 2_000_000, datum: '',
    }));
  });

  test('lock datum is inline (kind), not a hash reference', async () => {
    const r = await buildInteractContract(lucid, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'lock',
      changeAddress: OWN_ADDRESS, lovelaceAmount: 2_000_000, datum: 'd87980',
    });
    const tx = CML.Transaction.from_cbor_hex(r.txCbor);
    const outs = tx.body().outputs();
    let inlineSeen = false;
    for (let i = 0; i < outs.len(); i++) {
      const d = outs.get(i).datum();
      // CML DatumOptionKind: Hash = 0, Datum = 1 (verified against the
      // package's own .d.ts) - kind() === 1 is an inline datum.
      if (d && d.kind() === 1) inlineSeen = true;
      if (d && d.kind() === 0) assert.fail('lock produced a datum HASH output - must be inline');
    }
    assert.ok(inlineSeen, 'no inline-datum output found on the lock tx');
  });

  test('rejects an invalid action', async () => {
    await assert.rejects(
      () => buildInteractContract(lucid, {
        scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'steal' as any,
        changeAddress: OWN_ADDRESS, lovelaceAmount: 2_000_000,
      }),
      /Invalid action/,
    );
  });

  test('spend: collects a script UTxO back to the wallet (offline, native eval)', async () => {
    const scriptUtxo: UTxO = {
      txHash: FIXTURE_TXHASH, outputIndex: 7, address: SCRIPT_ADDRESS,
      assets: { lovelace: 2_000_000n }, datum: 'd87980',
    };
    const withScript = new FixtureProvider([...FIXTURE_UTXOS, scriptUtxo]);
    const l = await lucidForAddress(withScript, OWN_ADDRESS);
    const r = await buildInteractContract(l, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'spend',
      changeAddress: OWN_ADDRESS, redeemer: 'd87980',
    });
    assert.equal(r.action, 'spend');
    const tx = CML.Transaction.from_cbor_hex(r.txCbor);
    // the script input must be among the consumed inputs
    const inputs = tx.body().inputs();
    let consumedScriptInput = false;
    for (let i = 0; i < inputs.len(); i++) {
      const inp = inputs.get(i);
      if (inp.transaction_id().to_hex() === FIXTURE_TXHASH && Number(inp.index()) === 7) consumedScriptInput = true;
    }
    assert.ok(consumedScriptInput, 'script UTxO was not consumed');
    // addSigner(changeAddress) must land in the tx body as a required signer,
    // keyed by the wallet's payment key hash (not the script, not some other key).
    const requiredSigners = tx.body().required_signers();
    assert.ok(requiredSigners && requiredSigners.len() > 0, 'no required_signers on the built tx');
    const signerHashes: string[] = [];
    for (let i = 0; i < requiredSigners!.len(); i++) signerHashes.push(requiredSigners!.get(i).to_hex());
    const expectedHash = getAddressDetails(OWN_ADDRESS).paymentCredential?.hash;
    assert.ok(expectedHash, 'OWN_ADDRESS has no payment credential to compare against');
    assert.deepEqual(signerHashes, [expectedHash]);
  });

  test('spend: succeeds via native UPLC eval without ever calling the provider fallback', async () => {
    const scriptUtxo: UTxO = {
      txHash: FIXTURE_TXHASH, outputIndex: 7, address: SCRIPT_ADDRESS,
      assets: { lovelace: 2_000_000n }, datum: 'd87980',
    };
    const withScript = new FixtureProvider([...FIXTURE_UTXOS, scriptUtxo]);
    let evalCalls = 0;
    (withScript as any).evaluateTx = async () => {
      evalCalls++;
      throw new Error('provider evaluateTx should not be reached for a natively-evaluable script');
    };
    const l = await lucidForAddress(withScript, OWN_ADDRESS);
    await buildInteractContract(l, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'spend',
      changeAddress: OWN_ADDRESS, redeemer: 'd87980',
    });
    // pins the ordering: native eval must succeed on its own; the catch-block
    // fallback to the provider's evaluateTx must stay unreached here.
    assert.equal(evalCalls, 0, 'native UPLC evaluator should have succeeded without a provider fallback');
  });

  test('spend: refuses when the script address holds nothing', async () => {
    await assert.rejects(
      () => buildInteractContract(lucid, {
        scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'spend',
        changeAddress: OWN_ADDRESS, redeemer: 'd87980',
      }),
      /No UTxOs found at script address/,
    );
  });

  test('spend: refuses a utxoRef that does not point at the script address', async () => {
    await assert.rejects(
      () => buildInteractContract(lucid, {
        scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'spend',
        changeAddress: OWN_ADDRESS, redeemer: 'd87980',
        utxoRef: { txHash: FIXTURE_TXHASH, outputIndex: 0 }, // a real wallet UTxO, not at SCRIPT_ADDRESS
      }),
      /not at script address/,
    );
  });

  test("spend: rejects an empty-string redeemer instead of silently treating it as void", async () => {
    // '' is falsy but caller-supplied; ?? must let it flow through and fail
    // loudly downstream rather than defaulting to Data.void().
    const scriptUtxo: UTxO = {
      txHash: FIXTURE_TXHASH, outputIndex: 7, address: SCRIPT_ADDRESS,
      assets: { lovelace: 2_000_000n }, datum: 'd87980',
    };
    const withScript = new FixtureProvider([...FIXTURE_UTXOS, scriptUtxo]);
    const l = await lucidForAddress(withScript, OWN_ADDRESS);
    await assert.rejects(buildInteractContract(l, {
      scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2', action: 'spend',
      changeAddress: OWN_ADDRESS, redeemer: '',
    }));
  });
});
