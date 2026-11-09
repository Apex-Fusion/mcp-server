// packages/builder/src/vector/jury-chain.ts
// What the Module-1 and jury builders share on the chain side: the identity records of an agent by the identity hash that a manifest
// names, the identity check that Module-1 (identity_ok) and the jury (SPEC Section 5.8) make, a validity window inside the time
// bounds of an action, the ledger minimum of an output, the first input of a built transaction, the wallet inputs of a Module-1
// build, and the lookup of a Module-1 claim or challenge by its token at any address of its script. Reads only; the builders assemble.
import { CML, calculateMinLovelaceFromUTxO, getAddressDetails } from '@lucid-evolution/lucid';
import type { Assets, LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import { decodeIdentityDatum } from './identity-codec.js';
import { didOf, findTokenOutput, recordsById, windowAt, COLLATERAL_MIN_LOVELACE } from './identity-chain.js';
import type { RecordUtxo, Window } from './identity-chain.js';
import { MAX_DEPTH, PURPOSE, activeKey, effectiveStatus, keyHashOf } from './identity-rules.js';
import { scriptAddress } from './jury-deployment.js';
import type { OutRef } from './jury-deployment.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const iso = (ms: number): string => new Date(ms).toISOString();

// ─── Identity records ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The record of `id` in the identity registry `identityHash` and its ancestors, the record first: what the identity check of
 * Module-1 and of the jury reads as reference inputs. A missing record or ancestor is an error (`what` says whose record it is).
 */
export async function agentRecords(provider: Provider, identityHash: string, id: string, what: string): Promise<RecordUtxo[]> {
  const address = scriptAddress(identityHash);
  const chain: RecordUtxo[] = [];
  for (let next: string | null = id; next !== null;) {
    if (chain.length > MAX_DEPTH) throw new Error(`The lineage of ${didOf(id)} is deeper than ${MAX_DEPTH} levels.`);
    const utxo = await findTokenOutput(provider, address, identityHash, next);
    if (!utxo) {
      throw new Error(chain.length === 0
        ? `No record for ${didOf(next)} (the ${what}) in the identity registry: the identifier is not registered, or the record is not confirmed yet.`
        : `The record of ${didOf(next)}, an ancestor of ${didOf(id)}, is missing.`);
    }
    if (!utxo.datum) throw new Error(`The record of ${didOf(next)} (${utxo.txHash}#${utxo.outputIndex}) has no inline datum.`);
    let record;
    try { record = decodeIdentityDatum(utxo.datum); } catch (err) { throw new Error(`The record of ${didOf(next)} does not decode: ${errorText(err)}`); }
    chain.push({ id: next, utxo, record });
    next = record.lineage.type === 'Subagent' ? record.lineage.parent : null;
  }
  return chain;
}

/**
 * Why the identity check of the agent of `chain` with the key `keyHash` fails over `window`, or null when it passes: Module-1's
 * identity_ok (effective Active, the key is the controller or a listed key with the transaction purpose) and, with `independent`, the
 * lineage rule of the jury (SPEC Section 5.8: not a subagent).
 */
export function identityRefusal(chain: RecordUtxo[], keyHash: string, window: Window, independent: boolean): string | null {
  const [self, ...ancestors] = chain;
  const did = didOf(self.id);
  if (independent && self.record.lineage.type !== 'Root') return `${did} is a subagent; the jury takes only independent agents (lineage roots)`;
  let status: string;
  try { status = effectiveStatus(self.record, recordsById(ancestors), window.lo, window.hi); } catch (err) { return `the status of ${did} cannot be found: ${errorText(err)}`; }
  if (status !== 'Active') return `${did} is ${status} over the validity window (the record must be Active, with an Accountable Party that covers the window)`;
  if (keyHash !== keyHashOf(self.record.controller) && !activeKey(self.record, keyHash, PURPOSE.transaction)) {
    return `the key ${keyHash} is neither the controller of ${did} nor a listed key of it with the transaction purpose`;
  }
  return null;
}

// ─── Windows and outputs ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A time bound of an action and the words that say what it is (for the refusal when the bound is not met). */
export interface Bound { at: number; why: string }

/**
 * The window of windowAt at `nowMs`, moved inside the bounds of the action: its start at `notBefore` or later, its end at `notAfter`
 * or earlier, both on whole seconds. Refuses a bound that is not met now: an action that cannot start yet, or one whose time is over.
 */
export function windowWithin(nowMs: number, validMinutes: number | undefined, notBefore: Bound | null, notAfter: Bound | null): Window {
  const base = windowAt(nowMs, validMinutes);
  const second = Math.floor(nowMs / 1000) * 1000;
  let { lo, hi } = base;
  if (notBefore) {
    const at = Math.ceil(notBefore.at / 1000) * 1000;
    if (at > second) throw new Error(`Too early: ${notBefore.why} (${iso(at)}). Build again after that time.`);
    lo = Math.max(lo, at);
  }
  if (notAfter) {
    const at = Math.floor(notAfter.at / 1000) * 1000;
    if (at <= second) throw new Error(`Too late: ${notAfter.why} (${iso(at)}).`);
    hi = Math.min(hi, at);
  }
  return { lo, hi };
}

/** The ledger minimum of an output at `address` with `assets` (lovelace aside) and the inline `datum`. */
export function minLovelace(lucid: LucidEvolution, address: string, assets: Assets, datum: string): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of an output is unknown.');
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address, assets: { ...assets, lovelace: 0n }, datum });
}

/** Ledger order of inputs: by transaction id, then by output index. */
export const ledgerOrder = (a: OutRef, b: OutRef): number => (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : a.outputIndex - b.outputIndex);

/** The first input of a built transaction in ledger order: the input that a Module-1 token name is derived from. */
export function firstInput(txCbor: string): OutRef {
  const inputs = CML.Transaction.from_cbor_hex(txCbor).body().inputs();
  const refs: OutRef[] = [];
  for (let i = 0; i < inputs.len(); i++) refs.push({ txHash: inputs.get(i).transaction_id().to_hex(), outputIndex: Number(inputs.get(i).index()) });
  const [first] = refs.sort(ledgerOrder);
  if (!first) throw new Error('The built transaction has no input.');
  return first;
}

/**
 * The wallet inputs of a Module-1 build, chosen as the Python builders choose them (get_wallet_utxos_no_collateral): every wallet output
 * but one kept for the collateral (the smallest pure-AP3X output of at least 5 AP3X). The build then spends exactly these, with no
 * coin selection, so its first input in ledger order (which names the new token) is known before the build. When the other outputs
 * hold less than `need`, or there is no other output, the collateral output is spent too (the collateral may also be an input).
 */
export function module1Inputs(utxos: UTxO[], need: bigint): UTxO[] {
  const collateral = utxos
    .filter((u) => Object.keys(u.assets).every((unit) => unit === 'lovelace') && u.assets.lovelace >= COLLATERAL_MIN_LOVELACE)
    .sort((a, b) => (a.assets.lovelace < b.assets.lovelace ? -1 : a.assets.lovelace > b.assets.lovelace ? 1 : 0))[0];
  const others = utxos.filter((u) => u !== collateral);
  const total = others.reduce((sum, u) => sum + u.assets.lovelace, 0n);
  return [...(others.length === 0 || total < need ? utxos : others)].sort(ledgerOrder);
}

// ─── Outputs at a script credential (Module-1 claims and challenges) ──────────────────────────────────────────────────────────

/** The payment credential of `address` when it is a script's, whatever its stake part; else null (a key address, or no address). */
function scriptCredentialOf(address: string): string | null {
  try {
    const credential = getAddressDetails(address).paymentCredential;
    return credential?.type === 'Script' ? credential.hash : null;
  } catch { return null; }
}

/**
 * The name of the token of an output of the script `hash`, or null for any other output. Module-1 finds its claim and challenge outputs
 * by the payment credential alone (SPEC Section 5.7: "the claim address" is any address with the payment credential Script(m1_claim),
 * with any stake credential), so the output can sit at an address with a stake part. The token is the one token of the policy `hash`
 * (which is also the script hash: Module-1 mints its tokens under the script that holds them) that the output holds, in quantity 1.
 */
export function tokenAtScript(utxo: UTxO, hash: string): string | null {
  if (scriptCredentialOf(utxo.address) !== hash) return null;
  const tokens = Object.entries(utxo.assets).filter(([unit]) => unit.startsWith(hash));
  return tokens.length === 1 && tokens[0][1] === 1n ? tokens[0][0].slice(hash.length) : null;
}

/**
 * The output that holds the token `name` of the script `hash` (tokenAtScript), or null: the Module-1 lookup of a claim or a challenge by its
 * token. The node lists outputs by exact address only (Ogmios has no query by payment credential), so the address scan below sees the
 * outputs at the enterprise address of the script and no others. Koios names the UTxO that holds the token wherever it is, and the node
 * must list that UTxO (it decides what the output holds and whether it is spent): this finds an output at an address with a stake part.
 * When Koios has no answer, or one that the node does not confirm (it lags), the scan decides.
 */
export async function findTokenOutputAtScript(provider: Provider, hash: string, name: string): Promise<UTxO | null> {
  if (!/^[0-9a-f]{64}$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a token name (64 lowercase hex characters).`);
  let hint: UTxO | undefined;
  try { hint = await provider.getUtxoByUnit(`${hash}${name}`); } catch { /* no Koios answer: the address scan below decides */ }
  if (hint) {
    const [onNode] = await provider.getUtxosByOutRef([{ txHash: hint.txHash, outputIndex: hint.outputIndex }]);
    if (onNode && tokenAtScript(onNode, hash) === name) return onNode;
  }
  return (await provider.getUtxos(scriptAddress(hash))).find((u) => tokenAtScript(u, hash) === name) ?? null;
}
