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

function toBuildResult(completed: TxSignBuilder): VectorUnsignedBuildResult {
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
