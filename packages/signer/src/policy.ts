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

// A blank entry is not a usable address — and neither is one built entirely
// from characters that merely look blank. `''.split(',')` on an empty string
// yields `['']`, not `[]`, a realistic way an upstream config/env-parsing bug
// could hand this module a non-empty array that names no real address; a
// literal '' is the obvious case, but `.trim()` alone does not generalise
// past it, since it only strips the ECMAScript WhiteSpace set (which
// includes NBSP U+00A0 and BOM U+FEFF). Plenty of other invisible characters
// survive it: U+200B ZERO WIDTH SPACE and U+2060 WORD JOINER are Unicode
// category Cf (format), not Zs (space separator), so `.trim()` leaves them
// untouched. A denylist of "invisible" codepoints is not a fix — there are
// dozens of Cf/Cc codepoints and more get added — so this checks positively
// instead: an entry only counts as a known own address if, after trimming,
// it starts with the 'addr' prefix every Cardano/Vector payment address
// actually uses. Nothing built purely from blank or invisible characters can
// satisfy that, without needing to enumerate any of them.
//
// The trimmed value is what gets kept, not the original: this array feeds
// straight into a `Set` that real output addresses (always clean, never
// padded) are matched against by exact string equality. An entry that only
// passes the `startsWith('addr')` check after trimming but is stored with
// its padding intact would pass this gate yet never match anything
// downstream — "known" but functionally invisible, silently misclassifying
// every one of its own change outputs as outflow. `.map` before `.filter`
// keeps the check and the stored value in agreement.
//
// Residual, deliberately not chased further: a *trailing* invisible
// character (e.g. U+200B) is not stripped by `.trim()`, so an address padded
// that way still will not match its own outputs. Same safe direction as
// everything else here — it over-refuses, never under-refuses — and closing
// it would mean reaching for the denylist-of-codepoints approach this
// function exists to avoid.
function knownAddresses(ownAddresses: string[]): string[] {
  return ownAddresses.map((address) => address.trim()).filter((address) => address.startsWith('addr'));
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
  const own = new Set(knownAddresses(ownAddresses));
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

/**
 * Decides whether to sign `tx`, bounding lovelace outflow only.
 *
 * `SpendLimits` has no asset-value dimension: `assetMovements` (native
 * assets leaving to a foreign address, e.g. NFTs or token balances) is
 * computed and reported on the returned `PolicyDecision` for visibility, but
 * it never gates `allowed`. A transaction can move an entire native-asset
 * balance out of the wallet and still receive `allowed: true` as long as the
 * lovelace side of that same transaction stays under both limits — e.g. an
 * NFT sent with only the minimum UTxO deposit attached. This is a deliberate
 * v1 scope boundary, not an oversight: adding asset-value limits is future
 * work, and would need `SpendLimits` itself to grow a corresponding field.
 * A caller must not read `allowed: true` from this function as approval of
 * whatever `assetMovements` contains — only as approval of the lovelace
 * amount in `netOutflowLovelace`.
 */
export function evaluate(
  tx: DecodedTx,
  ownAddresses: string[],
  limits: SpendLimits,
  alreadySpentTodayLovelace: bigint
): PolicyDecision {
  const { netOutflowLovelace, assetMovements } = computeOutflow(tx, ownAddresses);

  // Fail closed: with no own address, every output looks foreign and change
  // cannot be identified, so any decision would be meaningless. A list
  // containing only blank entries counts as no own address too — see
  // knownAddresses().
  if (knownAddresses(ownAddresses).length === 0) {
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
