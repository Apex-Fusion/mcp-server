// packages/builder/test/fixtures/uplc-node.fixture.ts
// A node that evaluates scripts for real, offline. The builders complete with `localUPLCEval: false`, so Lucid asks the provider to
// evaluate the transaction's scripts, as the node (Ogmios) does in production. This provider answers with the evaluator Lucid itself
// ships (@lucid-evolution/uplc, the one `localUPLCEval: true` runs, a dependency of @lucid-evolution/lucid), over the UTxOs Lucid hands
// it, so a script that rejects the transaction fails the build exactly as the node's evaluation would. With the deployed validators
// attached to the reference-script UTxOs (advert-stake-golden.fixture.ts), a build that completes is one the deployed validator accepts
// under this ledger state; the cost models are the protocol-params fixture's. Unlike escrow-node.fixture.ts's evaluatingProvider, which
// answers a fixed budget and says nothing about acceptance, this one is a verdict.
import * as UPLC from '@lucid-evolution/uplc';
import { CML, SLOT_CONFIG_NETWORK, createCostModels, utxoToTransactionInput, utxoToTransactionOutput } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, fixtureProtocolParameters } from './fixture-provider.ts';

const TAGS = ['spend', 'mint', 'publish', 'withdraw', 'vote', 'propose'] as const;

/** A FixtureProvider over `utxos` whose tip is `tipSlot` and whose evaluateTx runs the scripts; `evaluations` lists what it was asked. */
export function uplcEvaluatingProvider(utxos: UTxO[], tipSlot: number) {
  const params = fixtureProtocolParameters();
  const costModels = createCostModels(params.costModels).to_cbor_bytes();
  const evaluations: string[] = [];
  const evaluateTx = async (txCborHex: string, additional: UTxO[] = []) => {
    evaluations.push(txCborHex);
    const slot = SLOT_CONFIG_NETWORK.Mainnet;
    const results = UPLC.eval_phase_two_raw(
      Buffer.from(txCborHex, 'hex'),
      additional.map((u) => utxoToTransactionInput(u).to_cbor_bytes()),
      additional.map((u) => utxoToTransactionOutput(u).to_cbor_bytes()),
      costModels, BigInt(params.maxTxExSteps), BigInt(params.maxTxExMem),
      BigInt(slot.zeroTime), BigInt(slot.zeroSlot), slot.slotLength,
    );
    return results.map((bytes) => {
      const r = CML.LegacyRedeemer.from_cbor_bytes(bytes);
      return { ex_units: { mem: Number(r.ex_units().mem()), steps: Number(r.ex_units().steps()) }, redeemer_index: Number(r.index()), redeemer_tag: TAGS[r.tag()] };
    });
  };
  const node = Object.assign(new FixtureProvider(utxos), { evaluateTx, evaluations });
  node.getNetworkTip = async () => ({ slot: tipSlot, hash: '' });
  return node;
}
