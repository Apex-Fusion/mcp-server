// Spend policy. Pure function of its arguments — the caller supplies today's
// spend from the audit log, so this module needs no I/O and is fully testable.
import type { DecodedTx } from './decode.js';

export interface AssetMovement {
  unit: string;
  quantity: bigint;
  toAddress: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  netOutflowLovelace: bigint;
  assetMovements: AssetMovement[];
}

export interface SpendLimits {
  perTxLovelace: bigint;
  dailyLovelace: bigint;
}

function ada(lovelace: bigint): string {
  return (Number(lovelace) / 1_000_000).toFixed(6);
}

/**
 * Net outflow = every output that does NOT return to us, plus the fee.
 *
 * Computable from the body alone, so no chain access is needed. An output to a
 * wallet address at a different derivation index counts as outflow — that
 * over-counts, which refuses too much rather than too little.
 */
export function computeOutflow(
  tx: DecodedTx,
  ownAddresses: string[]
): { netOutflowLovelace: bigint; assetMovements: AssetMovement[] } {
  const own = new Set(ownAddresses);
  let leaving = 0n;
  const assetMovements: AssetMovement[] = [];

  for (const output of tx.outputs) {
    if (own.has(output.address)) continue;
    leaving += output.lovelace;
    for (const asset of output.assets) {
      assetMovements.push({ unit: asset.unit, quantity: asset.quantity, toAddress: output.address });
    }
  }

  return { netOutflowLovelace: leaving + tx.fee, assetMovements };
}

export function evaluate(
  tx: DecodedTx,
  ownAddresses: string[],
  limits: SpendLimits,
  alreadySpentTodayLovelace: bigint
): PolicyDecision {
  const { netOutflowLovelace, assetMovements } = computeOutflow(tx, ownAddresses);

  // Fail closed: with no own address, every output looks foreign and change
  // cannot be identified, so any decision would be meaningless.
  if (ownAddresses.length === 0) {
    return {
      allowed: false,
      reason: 'No own address available, so change cannot be distinguished from outflow. Refusing.',
      netOutflowLovelace,
      assetMovements,
    };
  }

  if (netOutflowLovelace > limits.perTxLovelace) {
    return {
      allowed: false,
      reason: `Net outflow ${ada(netOutflowLovelace)} AP3X exceeds the per-transaction limit of ${ada(limits.perTxLovelace)} AP3X.`,
      netOutflowLovelace,
      assetMovements,
    };
  }

  if (alreadySpentTodayLovelace + netOutflowLovelace > limits.dailyLovelace) {
    const remaining = limits.dailyLovelace - alreadySpentTodayLovelace;
    return {
      allowed: false,
      reason: `Net outflow ${ada(netOutflowLovelace)} AP3X exceeds the remaining daily budget of ${ada(remaining > 0n ? remaining : 0n)} AP3X (limit ${ada(limits.dailyLovelace)} AP3X, already committed ${ada(alreadySpentTodayLovelace)} AP3X).`,
      netOutflowLovelace,
      assetMovements,
    };
  }

  return { allowed: true, netOutflowLovelace, assetMovements };
}
