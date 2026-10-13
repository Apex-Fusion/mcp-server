// packages/builder/test/fixtures/escrow-node.fixture.ts
// The node side of Accept and Reclaim, shared by marketplace-build.test.ts, marketplace-build-clock.test.ts and
// marketplace-tools.test.ts: the UTxO the builders read the escrow validator from, and a provider that stands in for the node's
// script evaluation.
//
// In production the node (Ogmios) evaluates the script while the transaction is completed: the builders tell Lucid not to do it
// locally. evaluatingProvider answers that call with a fixed budget per redeemer and counts the calls. It lets Lucid finish
// assembling the transaction and says nothing about whether the validator would accept it; that is for the first-party E2E before
// any deploy.
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { ESCROW_REF_UTXO } from '../../src/vector/marketplace-constants.ts';
import { ESCROW_SCRIPT_CBOR } from './escrow-script.fixture.ts';
import { FixtureProvider, FOREIGN_ADDRESS } from './fixture-provider.ts';

/** The reference-script UTxO the builders read the escrow validator from (ESCROW_REF_UTXO), holding the deployed script. */
export const REF_SCRIPT_UTXO: UTxO = {
  txHash: ESCROW_REF_UTXO.txHash, outputIndex: ESCROW_REF_UTXO.outputIndex, address: FOREIGN_ADDRESS,
  assets: { lovelace: 60_000_000n }, scriptRef: { type: 'PlutusV3', script: ESCROW_SCRIPT_CBOR },
};

/** A node holding `utxos` that answers script evaluation with a fixed budget per redeemer; `evaluations` lists the transactions it was asked about. */
export function evaluatingProvider(utxos: UTxO[]) {
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
