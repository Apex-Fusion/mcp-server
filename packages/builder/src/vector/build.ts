// packages/builder/src/vector/build.ts
//
// Keyless transaction building — the core of the non-custodial split's
// builder side. Every function here takes an already-initialized Lucid
// instance whose wallet was selected with selectWallet.fromAddress (no key
// material anywhere in this package) and returns UNSIGNED CBOR. Signing
// happens on the user's local signer; submission via vector_submit_transaction.
import {
  Lucid, fromText, Data, applyDoubleCborEncoding, validatorToAddress,
  validatorToScriptHash, getAddressDetails,
} from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, SpendingValidator, TxSignBuilder } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import type {
  TxOutput, VectorUnsignedBuildResult, VectorBuildDeployResult, VectorBuildInteractResult,
} from '@apexfusion/vector-mcp-shared/types';

/**
 * Initialize Lucid for keyless building: validate the change address, fetch
 * its UTxOs, and select an address-only wallet (spike-proven: PR-4 spike (a)).
 * Validation happens BEFORE any provider call so a bad address fails fast
 * and cheap.
 */
export async function lucidForAddress(provider: Provider, changeAddress: string): Promise<LucidEvolution> {
  try {
    getAddressDetails(changeAddress);
  } catch (err) {
    throw new Error(`Invalid change address: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lucid = await Lucid(provider, 'Mainnet');
  const utxos = await lucid.utxosAt(changeAddress);
  if (utxos.length === 0) {
    throw new Error(`No UTxOs found at ${changeAddress} — the wallet is empty or the address is wrong`);
  }
  lucid.selectWallet.fromAddress(changeAddress, utxos);
  return lucid;
}

export function toBuildResult(completed: TxSignBuilder): VectorUnsignedBuildResult {
  const txJson = (completed as any).toJSON?.() ?? {};
  const fee = String(txJson?.body?.fee ?? '0');
  return {
    txCbor: completed.toCBOR(),
    txHash: completed.toHash(),
    fee,
    feeAda: lovelaceToAda(fee),
  };
}

function requireValidRecipient(address: string): void {
  try {
    getAddressDetails(address);
  } catch (err) {
    throw new Error(`Invalid recipient address: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function buildSendApex(
  lucid: LucidEvolution,
  p: { recipientAddress: string; amountApex: number; metadataJson?: string },
): Promise<VectorUnsignedBuildResult> {
  requireValidRecipient(p.recipientAddress);
  if (typeof p.amountApex !== 'number' || !Number.isFinite(p.amountApex) || p.amountApex <= 0) {
    throw new Error('Amount must be a positive number');
  }
  const lovelace = BigInt(Math.floor(p.amountApex * 1_000_000));
  let tx = lucid.newTx().pay.ToAddress(p.recipientAddress, { lovelace });
  if (p.metadataJson) {
    tx = tx.attachMetadata(674, JSON.parse(p.metadataJson));
  }
  return toBuildResult(await tx.complete());
}

export async function buildSendTokens(
  lucid: LucidEvolution,
  p: { recipientAddress: string; policyId: string; assetName: string; amount: string; apexAmount?: number },
): Promise<VectorUnsignedBuildResult> {
  requireValidRecipient(p.recipientAddress);
  if (!/^[0-9a-fA-F]{56}$/.test(p.policyId)) {
    throw new Error('Invalid policy id: expected 56 hex characters');
  }
  if (!p.amount || isNaN(Number(p.amount)) || Number(p.amount) <= 0) {
    throw new Error('Amount must be a positive number');
  }
  let assetNameHex = p.assetName;
  if (p.assetName && !/^[0-9a-fA-F]+$/.test(p.assetName)) {
    assetNameHex = fromText(p.assetName);
  }
  const unit = `${p.policyId}${assetNameHex}`;
  const outputLovelace = p.apexAmount ? BigInt(Math.floor(p.apexAmount * 1_000_000)) : 2_000_000n;
  const tx = lucid.newTx().pay.ToAddress(p.recipientAddress, {
    lovelace: outputLovelace,
    [unit]: BigInt(p.amount),
  });
  return toBuildResult(await tx.complete());
}

export async function buildMultiOutput(
  lucid: LucidEvolution,
  p: { outputs: TxOutput[]; metadataJson?: string },
): Promise<VectorUnsignedBuildResult> {
  if (!p.outputs || p.outputs.length === 0) {
    throw new Error('At least one output is required');
  }
  for (const o of p.outputs) requireValidRecipient(o.address);
  let tx = lucid.newTx();
  for (const output of p.outputs) {
    const assets: Record<string, bigint> = { lovelace: BigInt(output.lovelace) };
    if (output.assets) {
      for (const [unit, qty] of Object.entries(output.assets)) assets[unit] = BigInt(qty);
    }
    tx = tx.pay.ToAddress(output.address, assets);
  }
  if (p.metadataJson) {
    tx = tx.attachMetadata(674, JSON.parse(p.metadataJson));
  }
  return toBuildResult(await tx.complete());
}

export async function buildDeployContract(
  lucid: LucidEvolution,
  p: { scriptCbor: string; scriptType: 'PlutusV1' | 'PlutusV2' | 'PlutusV3'; initialDatum?: string; lovelaceAmount?: number },
): Promise<VectorBuildDeployResult> {
  const validator: SpendingValidator = {
    type: p.scriptType,
    script: applyDoubleCborEncoding(p.scriptCbor),
  };
  const scriptAddress = validatorToAddress('Mainnet', validator);
  const scriptHash = validatorToScriptHash(validator);
  const datum = p.initialDatum ?? Data.void();
  const lovelace = BigInt(p.lovelaceAmount ?? 2_000_000);
  const tx = lucid.newTx()
    .pay.ToAddressWithData(scriptAddress, { kind: 'inline', value: datum }, { lovelace });
  return { ...toBuildResult(await tx.complete()), scriptAddress, scriptHash, scriptType: p.scriptType };
}

export async function buildInteractContract(
  lucid: LucidEvolution,
  p: {
    scriptCbor: string; scriptType: 'PlutusV1' | 'PlutusV2' | 'PlutusV3'; action: 'lock' | 'spend';
    changeAddress: string; redeemer?: string; datum?: string; lovelaceAmount?: number;
    utxoRef?: { txHash: string; outputIndex: number }; assets?: Record<string, string>;
  },
): Promise<VectorBuildInteractResult> {
  const validator: SpendingValidator = {
    type: p.scriptType,
    script: applyDoubleCborEncoding(p.scriptCbor),
  };
  const scriptAddress = validatorToAddress('Mainnet', validator);

  if (p.action === 'lock') {
    // '' must NOT silently become void - ?? lets a caller bug fail loudly downstream
    const datumData = p.datum ?? Data.void();
    const outputAssets: Record<string, bigint> = { lovelace: BigInt(p.lovelaceAmount ?? 2_000_000) };
    if (p.assets) {
      for (const [unit, qty] of Object.entries(p.assets)) outputAssets[unit] = BigInt(qty);
    }
    const tx = lucid.newTx()
      .pay.ToAddressWithData(scriptAddress, { kind: 'inline', value: datumData }, outputAssets);
    return { ...toBuildResult(await tx.complete()), scriptAddress, action: 'lock' };
  } else if (p.action === 'spend') {
    // SPEND: collect from the script back to the wallet.
    // no utxoRef: sweep ALL UTxOs at the script address - old tool's documented
    // semantic ("otherwise spends all UTxOs at script address"), preserved here
    // for behavior parity; this is not a gap, do not "fix" it.
    const scriptUtxos = p.utxoRef
      ? await lucid.utxosByOutRef([p.utxoRef])
      : await lucid.utxosAt(scriptAddress);
    if (!scriptUtxos || scriptUtxos.length === 0) {
      throw new Error(`No UTxOs found at script address ${scriptAddress}`);
    }
    if (p.utxoRef && scriptUtxos.some((u) => u.address !== scriptAddress)) {
      throw new Error(`UTxO ${p.utxoRef.txHash}#${p.utxoRef.outputIndex} is not at script address ${scriptAddress}`);
    }
    const redeemerData = p.redeemer ?? Data.void();
    let completed;
    try {
      completed = await lucid.newTx()
        .collectFrom(scriptUtxos, redeemerData)
        .attach.SpendingValidator(validator)
        .addSigner(p.changeAddress)
        .complete();
    } catch {
      // Retry without the native UPLC evaluator — falls back to the provider's
      // evaluateTx (network); mirrors the pre-split behaviour for chain quirks.
      completed = await lucid.newTx()
        .collectFrom(scriptUtxos, redeemerData)
        .attach.SpendingValidator(validator)
        .addSigner(p.changeAddress)
        .complete({ localUPLCEval: false });
    }
    return { ...toBuildResult(completed), scriptAddress, action: 'spend' };
  } else {
    throw new Error(`Invalid action: ${String(p.action)} - expected 'lock' or 'spend'`);
  }
}
