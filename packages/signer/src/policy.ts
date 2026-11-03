// Spend policy. Pure function of its arguments - the caller supplies today's
// spend from the audit log and the resolved inputs from resolve.ts, so this
// module needs no I/O and is fully testable.
import type { DecodedInput, DecodedTx } from './decode.js';

export interface AssetMovement {
  unit: string;
  quantity: bigint;
  toAddress: string;
}

/**
 * `own-inputs`: the value that this signer's own inputs fund (needs resolved inputs).
 * `all-outputs`: the fallback - every output not to this signer's address, plus the fee.
 */
export type OutflowRule = 'own-inputs' | 'all-outputs';

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  netOutflowLovelace: bigint;
  assetMovements: AssetMovement[];
  rule: OutflowRule;
  /** Which rule counted the outflow, in words for the caller; for the fallback, also why. */
  ruleNote: string;
}

export interface SpendLimits {
  perTxLovelace: bigint;
  dailyLovelace: bigint;
}

/** An output that the transaction spends, as the input resolver reports it. */
export interface ResolvedOutput {
  address: string;
  lovelace: bigint;
  /** The payment credential of `address` when it is a key hash (lowercase hex); null for a script or Byron address. */
  paymentKeyHash: string | null;
}

/** What the policy knows about the outputs that the transaction spends. */
export type InputResolution =
  | { resolved: true; signerKeyHash: string; outputs: ReadonlyMap<string, ResolvedOutput> }
  | { resolved: false; why: string };

export const RESOLUTION_OFF: InputResolution = {
  resolved: false,
  why: 'input resolution is off (VECTOR_SIGNER_OGMIOS_URL is not set)',
};

/** The key of an output reference in `InputResolution.outputs`: `<tx hash>#<index>`. */
export const outRefKey = (input: DecodedInput): string => `${input.txHash}#${input.index}`;

const OWN_INPUTS_NOTE =
  "counted from this signer's own inputs (resolved through Ogmios): their value less the change back to this signer, and at least the whole fee";
const ALL_OUTPUTS_NOTE = 'counted as every output not to this signer\'s address, plus the fee (fallback rule)';

function ada(lovelace: bigint): string {
  return (Number(lovelace) / 1_000_000).toFixed(6);
}

// A blank entry is not a usable address - and neither is one built entirely
// from characters that merely look blank. `''.split(',')` on an empty string
// yields `['']`, not `[]`, a realistic way an upstream config/env-parsing bug
// could hand this module a non-empty array that names no real address; a
// literal '' is the obvious case, but `.trim()` alone does not generalise
// past it, since it only strips the ECMAScript WhiteSpace set (which
// includes NBSP U+00A0 and BOM U+FEFF). Plenty of other invisible characters
// survive it: U+200B ZERO WIDTH SPACE and U+2060 WORD JOINER are Unicode
// category Cf (format), not Zs (space separator), so `.trim()` leaves them
// untouched. A denylist of "invisible" codepoints is not a fix - there are
// dozens of Cf/Cc codepoints and more get added - so this checks positively
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
// downstream - "known" but functionally invisible, silently misclassifying
// every one of its own change outputs as outflow. `.map` before `.filter`
// keeps the check and the stored value in agreement.
//
// Residual, deliberately not chased further: a *trailing* invisible
// character (e.g. U+200B) is not stripped by `.trim()`, so an address padded
// that way still will not match its own outputs. Same safe direction as
// everything else here - it over-refuses, never under-refuses - and closing
// it would mean reaching for the denylist-of-codepoints approach this
// function exists to avoid.
function knownAddresses(ownAddresses: string[]): string[] {
  return ownAddresses.map((address) => address.trim()).filter((address) => address.startsWith('addr'));
}

/**
 * Net outflow under one of two rules (the signer's README, "What net outflow
 * means", is the full statement):
 *
 * - own-inputs, when every spent input and collateral input is resolved:
 *     max(0, the whole fee if this signer's key funds any spent or collateral input,
 *         own spent inputs + withdrawals from this key's reward account - outputs to an own address,
 *         own collateral inputs - the collateral return when it goes to an own address)
 *   "Own" input means: the payment credential of the spent output is this
 *   signer's key hash. The two last terms are the two outcomes a signature
 *   covers: is_valid is outside the signed body, so a node takes the
 *   collateral instead of the inputs when a script fails.
 * - all-outputs (the fallback): every output that does NOT return to us, plus
 *   the fee. Used when resolution is off or failed, when an input or a
 *   collateral input was not found unspent, and when a certificate returns a
 *   deposit to this signer's key (the body does not always say how much).
 *
 * Under both rules an output counts as returned only when its address is one
 * of `ownAddresses` exactly. An output to a wallet address at a different
 * derivation index counts as outflow - that over-counts, which refuses too
 * much rather than too little.
 */
export function computeOutflow(
  tx: DecodedTx,
  ownAddresses: string[],
  resolution: InputResolution = RESOLUTION_OFF
): { netOutflowLovelace: bigint; assetMovements: AssetMovement[]; rule: OutflowRule; ruleNote: string } {
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

  const ownInputs = resolution.resolved ? ownInputsOutflow(tx, own, resolution) : resolution.why;
  if (typeof ownInputs === 'bigint') {
    return { netOutflowLovelace: ownInputs, assetMovements, rule: 'own-inputs', ruleNote: OWN_INPUTS_NOTE };
  }
  return {
    netOutflowLovelace: leaving + tx.fee,
    assetMovements,
    rule: 'all-outputs',
    ruleNote: `${ALL_OUTPUTS_NOTE}, because ${ownInputs}`,
  };
}

// The own-inputs rule of computeOutflow(). Returns the outflow, or the reason
// why the fallback rule must count instead.
function ownInputsOutflow(
  tx: DecodedTx,
  ownAddresses: ReadonlySet<string>,
  resolution: Extract<InputResolution, { resolved: true }>
): bigint | string {
  const key = resolution.signerKeyHash.toLowerCase();
  const missing = [...tx.inputs, ...tx.collateralInputs].find((input) => !resolution.outputs.has(outRefKey(input)));
  if (missing) return `input ${outRefKey(missing)} was not found unspent`;
  if (tx.depositRefundKeyHashes.includes(key)) return "a certificate returns a deposit to this signer's key";

  // One sum for the spent inputs, one for the collateral inputs: the two outcomes that one signature covers.
  const own = { spent: 0n, collateral: 0n, fundsAnInput: false };
  for (const [inputs, kind] of [[tx.inputs, 'spent'], [tx.collateralInputs, 'collateral']] as const) {
    for (const input of inputs) {
      const output = resolution.outputs.get(outRefKey(input))!;
      if (output.paymentKeyHash !== key) continue;
      own[kind] += output.lovelace;
      own.fundsAnInput = true;
    }
  }
  const withdrawn = tx.withdrawals.reduce((sum, w) => (w.keyHash === key ? sum + w.lovelace : sum), 0n);
  const returned = tx.outputs.reduce((sum, o) => (ownAddresses.has(o.address) ? sum + o.lovelace : sum), 0n);
  const collateralBack =
    tx.collateralReturn && ownAddresses.has(tx.collateralReturn.address) ? tx.collateralReturn.lovelace : 0n;

  const ifScriptsPass = own.spent + withdrawn - returned;
  const ifScriptFails = own.collateral - collateralBack;
  const feeShare = own.fundsAnInput ? tx.fee : 0n;
  return [ifScriptsPass, ifScriptFails, feeShare].reduce((max, value) => (value > max ? value : max), 0n);
}

/**
 * Decides whether to sign `tx`, bounding lovelace outflow only.
 *
 * `SpendLimits` has no asset-value dimension: `assetMovements` (native
 * assets leaving to a foreign address, e.g. NFTs or token balances) is
 * computed and reported on the returned `PolicyDecision` for visibility, but
 * it never gates `allowed`. A transaction can move an entire native-asset
 * balance out of the wallet and still receive `allowed: true` as long as the
 * lovelace side of that same transaction stays under both limits - e.g. an
 * NFT sent with only the minimum UTxO deposit attached. This is a deliberate
 * v1 scope boundary, not an oversight: adding asset-value limits is future
 * work, and would need `SpendLimits` itself to grow a corresponding field.
 * A caller must not read `allowed: true` from this function as approval of
 * whatever `assetMovements` contains - only as approval of the lovelace
 * amount in `netOutflowLovelace`.
 */
export function evaluate(
  tx: DecodedTx,
  ownAddresses: string[],
  limits: SpendLimits,
  alreadySpentTodayLovelace: bigint,
  resolution: InputResolution = RESOLUTION_OFF
): PolicyDecision {
  const outflow = computeOutflow(tx, ownAddresses, resolution);
  const { netOutflowLovelace } = outflow;

  // Fail closed: with no own address, every output looks foreign and change
  // cannot be identified, so any decision would be meaningless. A list
  // containing only blank entries counts as no own address too - see
  // knownAddresses().
  if (knownAddresses(ownAddresses).length === 0) {
    return {
      ...outflow,
      allowed: false,
      reason: 'No own address available, so change cannot be distinguished from outflow. Refusing.',
    };
  }

  if (netOutflowLovelace > limits.perTxLovelace) {
    return {
      ...outflow,
      allowed: false,
      reason: `Net outflow ${ada(netOutflowLovelace)} AP3X exceeds the per-transaction limit of ${ada(limits.perTxLovelace)} AP3X.`,
    };
  }

  if (alreadySpentTodayLovelace + netOutflowLovelace > limits.dailyLovelace) {
    const remaining = limits.dailyLovelace - alreadySpentTodayLovelace;
    return {
      ...outflow,
      allowed: false,
      reason: `Net outflow ${ada(netOutflowLovelace)} AP3X exceeds the remaining daily budget of ${ada(remaining > 0n ? remaining : 0n)} AP3X (limit ${ada(limits.dailyLovelace)} AP3X, already committed ${ada(alreadySpentTodayLovelace)} AP3X).`,
    };
  }

  return { ...outflow, allowed: true };
}
