// packages/builder/src/vector/vault-read.ts
// Reads of vaults (Part 2 Section 5.3): the outputs at the vault address (Live and Returned) by output reference, by owner key hash or
// by delegation, with the limit of the delegation and what its period still allows for a Live output that can pay, and the check
// whether an escrow was paid from a vault under a given delegation. A vault output changes its reference with each payment, so a read
// by owner key hash or by delegation is the stable form. Anyone can write an output at the vault address, with any datum, so a read
// shows the outputs whose owner is the delegator of their delegation first (the one with the most AP3X first), confirms the outputs of a
// page on the node, reads the delegation only of the outputs that a page shows, and gives an allowance only for an output that can pay.
// Reads only: nothing is built, signed or submitted.
import { calculateMinLovelaceFromUTxO } from '@lucid-evolution/lucid';
import type { ProtocolParameters, UTxO } from '@lucid-evolution/lucid';
import { decodeDelegationDatum, decodeVaultDatum, encodeVaultDatum, plutusAddressFromBech32, sameDelegator, vaultDatumFromData } from './identity-codec.js';
import type { Delegator, ValueLimit, VaultDatum } from './identity-codec.js';
import type { IdentityContext } from './identity-build.js';
import { HIRE_ACTION, delegationUseProblems, escrowResource } from './delegation-build.js';
import { readChainRecords, readDelegation } from './delegation-read.js';
import type { DelegationView } from './delegation-read.js';
import { recordsById, windowAt } from './identity-chain.js';
import type { Window } from './identity-chain.js';
import { BudgetSpent, KOIOS_ANSWER_BYTES, TooManyMatches, checkPage, credentialOutputs, dataOfKoiosJson, pageOf, soleTokenName, withinBudget } from './ledger-read.js';
import type { CredentialFilter, LedgerEnv, Page, ReadSession } from './ledger-read.js';
import { DELIVER_BY_BUFFER_MS } from './marketplace-constants.js';
import { encodeIdentityEscrowDatum, formatOutRef, identityEscrowLockFloor, parseOutRef } from './marketplace-datum.js';
import type { IdentityEscrowDatum } from './marketplace-datum.js';
import { koiosPostList } from './marketplace-indexer.js';
import { readVault } from './vault-build.js';

/** A vault output: its reference, its output and its datum. */
export interface VaultOutput { ref: string; utxo: UTxO; vault: VaultDatum }

/** What the period of a Live vault allows (Part 2 Section 5.3), at a time. */
export interface PeriodAllowance {
  limit: ValueLimit;
  /** What the vault has paid in the period that started at `periodStart`. */
  spent: bigint;
  periodStart: number;
  /** `periodStart` plus `period_ms`. From then on a payment starts a new period. */
  periodEnd: number;
  /** Does a payment built now count the period that started at `periodStart`? When false, it starts a new period and `spent` restarts with its amount. */
  periodRunning: boolean;
  /** What payments may still add up to in the period that the next payment falls in: `total` minus `spent` while the period runs, else `total`. */
  remaining: bigint;
  /**
   * The most that the next payment may lock: the smallest of `per_tx`, `remaining`, and what the vault holds above the ledger minimum of
   * its next output (never below 0). The minimum is that of the largest next datum that a payment can write, so the amount is never
   * above what a payment can take.
   */
  nextMax: bigint;
}

/**
 * The allowance of a Live vault output under `limit`. The contract starts a new period when the start of the validity window of a
 * payment is at or after `period_start + period_ms`. The builders open the window a minute before the build, so `lowerBoundMs` is that
 * start for a payment built now (`windowAt(now).lo`): for a minute after a period ends, the contract still counts the old period.
 * `room` is what the vault holds above the ledger minimum of its next output.
 */
export function periodAllowance(vault: Extract<VaultDatum, { type: 'Live' }>, limit: ValueLimit, lowerBoundMs: number, room: bigint): PeriodAllowance {
  const periodEnd = vault.periodStart + limit.periodMs;
  const periodRunning = lowerBoundMs < periodEnd;
  const left = limit.total - vault.spent;
  const remaining = periodRunning ? (left > 0n ? left : 0n) : limit.total;
  const cap = remaining < limit.perTx ? remaining : limit.perTx;
  return { limit, spent: vault.spent, periodStart: vault.periodStart, periodEnd, periodRunning, remaining, nextMax: cap < room ? cap : room };
}

/**
 * The smallest escrow that a payment of a vault output can make: an output at the escrow address with an Open datum that has the delegate
 * key as the buyer and the refund to the vault (the datum Returned { owner }), an empty capability, a payment that equals the output, no
 * bonds, and the other fields at their usual size. A real advert has a longer capability and its own price and bonds, so a real escrow
 * is larger.
 */
export interface SmallestEscrow {
  /** The ledger minimum of that output, in lovelace. A payment that locks less cannot leave the vault: the ledger refuses its escrow output. */
  minimum: bigint;
  /**
   * What vector_build_vault_pay locks at least: the lock floor of the builder (identityEscrowLockFloor) for the same datum. It sizes the
   * lock for the widest datum that the escrow can take later, so it is above `minimum`, and an advert with a longer datum locks more.
   */
  buildFloor: bigint;
}

/** What a Live vault output adds to its datum: the delegation it names, read now, and whether it can pay. */
export interface LiveVault {
  /** The delegation with its chain; null when it could not be read (see `error`). */
  delegation: DelegationView | null;
  /** Why the delegation could not be read (its datum does not decode, or the node failed), or null. Nothing else about this output is known then. */
  error: string | null;
  /** The value limit of the delegation in use, or null when the delegation does not exist or has none (a vault pays only under a limit). */
  limit: ValueLimit | null;
  /** Is the owner of the output the delegator of the delegation? A vault pays only then. Null when the delegation does not exist or could not be read. */
  ownerIsDelegator: boolean | null;
  /**
   * Why this output cannot pay a marketplace escrow now, in words. Empty when it can, and empty when `error` is set. The checks are those
   * of the vault builder: the output holds AP3X only, the delegation exists with every link up to its root, its delegator is the owner,
   * it has a value limit, delegationUseProblems for marketplace.hire.v1 on the escrow script finds nothing for a payment built now with
   * the shortest validity window, and a payment can lock at least the ledger minimum of the smallest escrow output: each of the limit per
   * payment, what the period still allows, and the AP3X that the vault holds above the ledger minimum of its next output must reach it.
   * An output that the node does not hold has the one problem NOT_ON_NODE.
   */
  problems: string[];
  /** Can a payment built now spend this output? True only for a delegation that was read, with no problem (that is, when `allowance` is set). */
  canPay: boolean;
  /** What the period allows: set only when `canPay`. */
  allowance: PeriodAllowance | null;
  /** The smallest escrow that a payment can make, and what the builder locks at least. Set when the checks before the allowance found no problem, whether or not the output can pay. */
  escrow: SmallestEscrow | null;
}

/** The problem of an output that Koios lists and the node does not hold. */
export const NOT_ON_NODE = 'the node does not hold this output: it is spent, or the indexer is ahead';

export interface VaultReading {
  output: VaultOutput;
  /**
   * Does the node hold this output? A page that Koios listed is confirmed on the node, and a row that the node does not hold is spent, or
   * the indexer is ahead of the node. Always true for a read by output reference, which reads the node.
   */
  onNode: boolean;
  /** For a Live output; null for a Returned output (an escrow refund, which only its owner can close). */
  live: LiveVault | null;
}

/** A page of vault outputs. */
export interface VaultPage extends Page<VaultReading> {
  /**
   * True when the order puts the outputs whose owner is the delegator of their delegation first. False when the delegations could not be
   * read for the order: it is by output reference only (Live before Returned), and each row still says whether its owner is the delegator.
   */
  byDelegator: boolean;
}

/** One vault output by its reference, or the outputs of an owner key or of a delegation. */
export type VaultSelector = { vaultRef: string } | { ownerKeyHash: string } | { delegation: string };

const KEY_HASH = /^[0-9a-f]{56}$/;
const ID = /^[0-9a-f]{64}$/;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The vault outputs that Koios lists at the vault credential for a datum filter, decoded; `keep` compares the decoded datum, since the
 * filter is coarse. An output whose datum cannot be read as a vault datum is not listed (readVault says why for one output).
 */
async function listed(env: LedgerEnv, filter: CredentialFilter, narrow: string, keep: (vault: VaultDatum) => boolean): Promise<VaultOutput[]> {
  const found: VaultOutput[] = [];
  for (const utxo of await credentialOutputs(env, env.deployment.vault.hash, filter, narrow)) {
    if (!utxo.datum) continue;
    let vault: VaultDatum;
    try { vault = decodeVaultDatum(utxo.datum); } catch { continue; }
    if (keep(vault)) found.push({ ref: formatOutRef(utxo.txHash, utxo.outputIndex), utxo, vault });
  }
  return found;
}

/**
 * The delegator of every delegation that exists, by identifier: one read of the outputs at the delegation credential that hold a
 * delegation token, with no filter on the datum. A read by owner key hash uses it to find the vault outputs whose owner is the
 * delegator of their delegation, without reading each delegation. A delegation whose datum does not decode is left out. The read
 * refuses (TooManyMatches) when 5,000 or more delegation outputs exist.
 */
async function delegatorsOf(env: LedgerEnv): Promise<Map<string, Delegator>> {
  const { delegation } = env.deployment;
  const found = new Map<string, Delegator>();
  for (const utxo of await credentialOutputs(env, delegation.hash, { assetPolicy: delegation.hash }, 'Give the delegation to narrow the read.')) {
    const id = soleTokenName(utxo, delegation.address, delegation.hash);
    if (id === null || !utxo.datum) continue;
    try { found.set(id, decodeDelegationDatum(utxo.datum).delegator); } catch { /* the outputs that name it show why it cannot be read */ }
  }
  return found;
}

/**
 * The ledger minimum of the output that a payment leaves at the vault (`next` is its datum), as `vaultMinimum` of vault-build.ts finds
 * it. The AP3X of the output do not change it: Lucid measures the output with its largest coin (checked for 0 to 2^40 lovelace).
 */
function minimumOf(coinsPerUtxoByte: bigint, env: LedgerEnv, next: VaultDatum): bigint {
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address: env.deployment.vault.address, assets: { lovelace: 0n }, datum: encodeVaultDatum(next) });
}

/** An amount from 65,536 to below 2^32 lovelace takes the same 5 bytes in a datum, whatever its value (smallestEscrow). */
const FIVE_BYTE_AMOUNT = 0xffff_ffffn;

/**
 * The smallest escrow that a payment of a vault output of `owner` can make, for the delegate key hash `delegateKey` (SmallestEscrow): the
 * Open escrow datum that the builder of a payment writes (planVaultEscrow), with an empty capability, no bonds and a payment that equals
 * the output. `minimum` is the ledger minimum of its output at the escrow address, and `buildFloor` is the lock floor of the builder for
 * the same datum (identityEscrowLockFloor). The ledger minimum of an escrow output is from 65,536 to below 2^32 lovelace, so its payment
 * takes the 5 bytes of FIVE_BYTE_AMOUNT in the datum, and a payment of exactly `minimum` has the same datum, and the same minimum.
 */
function smallestEscrow(coinsPerUtxoByte: bigint, env: LedgerEnv, owner: Delegator, delegateKey: string, window: Window): SmallestEscrow {
  const open: IdentityEscrowDatum = {
    buyer_pkh: delegateKey, supplier_pkh: '00'.repeat(28), advert_ref: { txHash: '00'.repeat(32), index: 0 }, capability_id: '',
    request_spec_hash: '00'.repeat(32), prompt_hash: '00'.repeat(32), payment_lovelace: FIVE_BYTE_AMOUNT, buyer_bond_lovelace: 0n, supplier_bond_lovelace: 0n,
    // As planVaultEscrow writes them: a minute after the start of the window, and the end of the window plus the buffer (a processing window of 0).
    deliver_by: window.hi + DELIVER_BY_BUFFER_MS, posted_at: window.lo + 60_000, submitted_at: null, result_receipt_hash: null, state: 'Open', agent_id: '00'.repeat(32),
    refund: { address: plutusAddressFromBech32(env.deployment.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) },
  };
  const output = { txHash: '00'.repeat(32), outputIndex: 0, address: env.deployment.escrow.address, assets: { lovelace: 0n }, datum: encodeIdentityEscrowDatum(open) };
  return { minimum: calculateMinLovelaceFromUTxO(coinsPerUtxoByte, output), buildFloor: identityEscrowLockFloor(open, 0n) };
}

/** The outputs of `outputs` that the node holds, by reference, from one request (a page has 50 outputs at most). */
async function heldOnNode(env: LedgerEnv, outputs: VaultOutput[]): Promise<Map<string, UTxO>> {
  const held = new Map<string, UTxO>();
  if (outputs.length === 0) return held;
  for (const utxo of await env.provider.getUtxosByOutRef(outputs.map((o) => ({ txHash: o.utxo.txHash, outputIndex: o.utxo.outputIndex })))) {
    held.set(formatOutRef(utxo.txHash.toLowerCase(), utxo.outputIndex), utxo);
  }
  return held;
}

/**
 * The vault outputs that `selector` names, at `atMs`, one page (`offset`, `limit`). By output reference: the unspent output on the node
 * (readVault). By owner key hash: every Live and Returned output whose owner is that principal key. By delegation: every Live output
 * that names it (a Returned output names only its owner, so read it by owner key hash). Koios reads the vault credential with a datum
 * filter, and each row is decoded and compared on the decoded field. An output whose datum cannot be read as a vault datum is not listed:
 * a read by output reference says why.
 *
 * Anyone can write a vault output with any datum, so the order puts the outputs that can pay first: the Live outputs whose owner is the
 * delegator of their delegation (found without reading each delegation: for an owner key hash from one read of the delegations, for a
 * delegation from that delegation), the one with the most AP3X first, then the other Live outputs, then the Returned ones; the outputs
 * of equal AP3X, and the last two groups, by output reference. The read of the delegations only sets the order: it is not made when no
 * output is Live, and when 5,000 or more delegations exist it is dropped, the order is by output reference only (Live before Returned),
 * and `byDelegator` is false. Only the outputs of the page are read further. The page is confirmed on the node with one request: a row
 * that the node does not hold has `onNode` false and cannot pay. For each Live output that the node holds the delegation is read, and a
 * read that fails (its datum does not decode) is reported on that output and does not stop the others. Each delegation and each record
 * is read once for the call. The whole call, the listing of the outputs included, ends with an error once its budget is spent
 * (withinBudget).
 */
export async function readVaults(env: LedgerEnv, selector: VaultSelector, atMs: number, paging: { offset?: number; limit?: number } = {}): Promise<VaultPage> {
  checkPage(paging.offset, paging.limit);
  return withinBudget(env, (inside, session) => readVaultsIn(inside, session, selector, atMs, paging));
}

async function readVaultsIn(env: LedgerEnv, session: ReadSession, selector: VaultSelector, atMs: number, paging: { offset?: number; limit?: number }): Promise<VaultPage> {
  // The delegator of each delegation that is known before a page is read: what the order of the outputs rests on.
  let delegators = new Map<string, Delegator>();
  let byDelegator = true;
  let outputs: VaultOutput[];
  if ('vaultRef' in selector) {
    // readVault reads only the node and the deployment: a read has no wallet, so the context has no Lucid.
    outputs = [await readVault({ provider: env.provider, deployment: env.deployment } as IdentityContext, selector.vaultRef)];
  } else if ('ownerKeyHash' in selector) {
    const hash = selector.ownerKeyHash.toLowerCase();
    if (!KEY_HASH.test(hash)) throw new Error('The owner key hash must be 56 hex characters.');
    outputs = await listed(env, { datumContains: hash }, 'Give the delegation to narrow the read.', (v) => v.owner.type === 'PrincipalKey' && v.owner.hash === hash);
    // The delegators only set the order, so a set too big to read does not end the call: the page reads the delegation of each of its own outputs.
    if (outputs.some((o) => o.vault.type === 'Live')) {
      try { delegators = await delegatorsOf(env); } catch (err) {
        if (!(err instanceof TooManyMatches)) throw err;
        byDelegator = false;
      }
    }
  } else {
    const id = selector.delegation.toLowerCase();
    if (!ID.test(id)) throw new Error('The delegation must be 64 hex characters.');
    outputs = await listed(env, { datumContains: id }, 'Give the owner key hash to narrow the read.', (v) => v.type === 'Live' && v.delegation === id);
    if (outputs.length > 0) {
      try {
        const delegator = (await readDelegation(env, id, session)).chain[0]?.delegation.delegator;
        if (delegator !== undefined) delegators.set(id, delegator);
      } catch (err) {
        if (err instanceof BudgetSpent) throw err;
        byDelegator = false; // each output that names it reports the error
      }
    }
  }

  const ownerIsDelegator = (o: VaultOutput): boolean => {
    if (o.vault.type !== 'Live') return false;
    const delegator = delegators.get(o.vault.delegation);
    return delegator !== undefined && sameDelegator(delegator, o.vault.owner);
  };
  const rank = (o: VaultOutput): number => (o.vault.type === 'Returned' ? 2 : ownerIsDelegator(o) ? 0 : 1);
  const byRef = (a: VaultOutput, b: VaultOutput): number => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  // The funded vault of an owner comes first among the outputs that can pay: it is not hidden behind small ones.
  const byFunds = (a: VaultOutput, b: VaultOutput): number => (a.utxo.assets.lovelace > b.utxo.assets.lovelace ? -1 : a.utxo.assets.lovelace < b.utxo.assets.lovelace ? 1 : 0);
  outputs.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? byFunds(a, b) : 0) || byRef(a, b));
  const page = pageOf(outputs, paging.offset, paging.limit);
  // Koios is a witness. The page is confirmed on the node in one request; a read by output reference has read the node already.
  const held = 'vaultRef' in selector ? null : await heldOnNode(env, page.items);

  // A payment built now has the shortest window that the builders make: it opens a minute before now, and it ends a minute after.
  const payWindow = windowAt(atMs, 1);
  let protocolParameters: Promise<ProtocolParameters> | undefined;

  const readings: VaultReading[] = [];
  for (const listedOutput of page.items) {
    const vault = listedOutput.vault;
    const node = held?.get(listedOutput.ref);
    // A row that the node does not hold is spent, or the indexer is ahead: nothing more is read for it, and it cannot pay.
    if (held !== null && node === undefined) {
      const gone: LiveVault = { delegation: null, error: null, limit: null, ownerIsDelegator: null, problems: [NOT_ON_NODE], canPay: false, allowance: null, escrow: null };
      readings.push({ output: listedOutput, onNode: false, live: vault.type === 'Live' ? gone : null });
      continue;
    }
    // The node says what the output holds.
    const output: VaultOutput = node === undefined ? listedOutput : { ...listedOutput, utxo: node };
    if (vault.type === 'Returned') { readings.push({ output, onNode: true, live: null }); continue; }
    session.check();
    let delegation: DelegationView;
    try { delegation = await readDelegation(env, vault.delegation, session); } catch (err) {
      if (err instanceof BudgetSpent) throw err;
      readings.push({ output, onNode: true, live: { delegation: null, error: errorText(err), limit: null, ownerIsDelegator: null, problems: [], canPay: false, allowance: null, escrow: null } });
      continue;
    }
    const leaf = delegation.chain[0]?.delegation;
    const limit = leaf?.value ?? null;
    const isDelegator = leaf === undefined ? null : sameDelegator(leaf.delegator, vault.owner);
    const problems: string[] = [];
    if (Object.keys(output.utxo.assets).some((unit) => unit !== 'lovelace')) problems.push('the output holds assets other than AP3X, so it cannot pay (vault decision 5); its owner can close it');
    if (leaf === undefined) problems.push(`the delegation ${vault.delegation} does not exist: it was never made, or it was undelegated and its token is burned; the owner can still close this output`);
    else {
      if (isDelegator === false) problems.push('the owner of this output is not the delegator of the delegation, so it cannot pay (Part 2 Section 5.3)');
      if (limit === null) problems.push('the delegation has no value limit, and a vault pays only under one (Part 2 Section 5.3)');
      try {
        const records = await readChainRecords(env, delegation.chain, session);
        problems.push(...delegationUseProblems(delegation.chain, recordsById(records), HIRE_ACTION, escrowResource(env.deployment.escrow.hash), payWindow));
      } catch (err) {
        if (err instanceof BudgetSpent) throw err;
        problems.push(`the records that the use checks read cannot be read (${errorText(err)})`);
      }
    }
    let allowance: PeriodAllowance | null = null;
    let escrow: SmallestEscrow | null = null;
    if (problems.length === 0 && leaf !== undefined && limit !== null) {
      // The next vault output is as large as it can be: the whole total spent, and the latest start that a payment can write.
      const next: VaultDatum = { type: 'Live', owner: vault.owner, delegation: vault.delegation, spent: limit.total, periodStart: Math.max(vault.periodStart, payWindow.hi) };
      if (protocolParameters === undefined) protocolParameters = env.provider.getProtocolParameters();
      const { coinsPerUtxoByte } = await protocolParameters;
      const kept = minimumOf(coinsPerUtxoByte, env, next);
      escrow = smallestEscrow(coinsPerUtxoByte, env, vault.owner, leaf.delegateKey, payWindow);
      const lovelace = output.utxo.assets.lovelace;
      const room = lovelace > kept ? lovelace - kept : 0n;
      const period = periodAllowance(vault, limit, payWindow.lo, room);
      // A payment leaves the vault only when its escrow output reaches the ledger minimum: each of the three limits of the next payment must reach it.
      const needs = `and the smallest escrow output needs ${escrow.minimum} lovelace (its ledger minimum): no payment can leave this output`;
      if (room < escrow.minimum) problems.push(`the vault holds ${lovelace} lovelace and its next output needs ${kept}, so a payment may lock at most ${room}, ${needs}`);
      if (period.remaining < escrow.minimum) problems.push(`the delegation allows ${period.remaining} more lovelace in the period that a payment built now falls in, ${needs}`);
      if (limit.perTx < escrow.minimum) problems.push(`the delegation allows ${limit.perTx} lovelace for one payment, ${needs}`);
      if (problems.length === 0) allowance = period;
    }
    readings.push({ output, onNode: true, live: { delegation, error: null, limit, ownerIsDelegator: isDelegator, problems, canPay: allowance !== null, allowance, escrow } });
  }
  return { ...page, items: readings, byDelegator };
}

// ─── Was an escrow paid from a vault? ────────────────────────────────────────────────────────────────────────────────────────────

/** Why an escrow is not shown to be paid from a vault of the delegation. */
export type EscrowVaultReason =
  | 'transaction_not_found'
  | 'contract_failed'
  | 'not_an_escrow_output'
  | 'continuation'
  | 'no_vault_input'
  | 'not_a_payment'
  | 'unreadable_vault_datum'
  | 'other_delegation';

export type EscrowVaultResult =
  | { paid: true; vaultRef: string; escrowRef: string; delegation: string; payTx: string }
  | { paid: false; reason: EscrowVaultReason; detail: string };

/** The parts of a Koios `tx_info` row that this read uses. Koios is a witness, so every part is checked before it is used. */
interface TxIo { tx_hash?: unknown; tx_index?: unknown; payment_addr?: { cred?: unknown } | null; inline_datum?: { value?: unknown } | null }
interface TxContract {
  script_hash?: unknown; spends_input?: { tx_hash?: unknown; tx_index?: unknown } | null; valid_contract?: unknown;
  input?: { redeemer?: { purpose?: unknown; datum?: { value?: unknown } | null } | null } | null;
}
interface TxInfo { tx_hash?: unknown; inputs?: unknown; outputs?: unknown; plutus_contracts?: unknown; valid_contract?: unknown }

const credOf = (io: TxIo | null | undefined): string => String(io?.payment_addr?.cred).toLowerCase();
const refOf = (io: TxIo): string => `${String(io.tx_hash).toLowerCase()}#${io.tx_index}`;
const join = (list: readonly string[]): string => list.join(', ');

/** Is `c` a run of the vault script that spends an input with the redeemer `Pay` (constructor 0 with no fields)? */
function isVaultPay(c: TxContract | null | undefined, vaultHash: string): boolean {
  const redeemer = c?.input?.redeemer;
  const value = redeemer?.datum?.value as Record<string, unknown> | null | undefined;
  // `constructor` is also a property of every object, so the redeemer must carry its own.
  const constructor0 = value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(value, 'constructor') && Number(value.constructor) === 0;
  return String(c?.script_hash).toLowerCase() === vaultHash && redeemer?.purpose === 'spend' && constructor0 && Array.isArray(value?.fields) && value.fields.length === 0;
}

/**
 * Was the escrow at `escrowRef` paid from a vault under the delegation `delegationId`? It reads the transaction that made the escrow
 * (Koios `tx_info` with its inputs and scripts) and looks for an input at the vault address that the vault script spent with the
 * Pay redeemer, whose datum is Live with that delegation. A Close of a vault can also sit in a transaction that makes an escrow
 * output, so the redeemer decides, not the presence of a vault input. The vault script ran on that input, so the payment passed
 * the use checks and the limits of the delegation. The answer is typed: the vault output that paid, or the reason that none did.
 * The ref must be the first output of the escrow: a later output (a claim, a submit or an accept) was made by a transaction that
 * spent the earlier one, and the answer says so.
 *
 * `paid` needs Pay runs whose scripts passed. Each script run of a Koios row (`plutus_contracts`) has a `valid_contract`, and the top
 * level of a row of the Vector Koios has none (checked on 2026-11-18: a Koios that gives one, and says false, is believed too). A Pay
 * run of the vault script with `valid_contract` false is `contract_failed`: a transaction that failed script validation took its
 * collateral and made no output. A Pay run with no `valid_contract`, or with a value that is not true or false, is an incomplete
 * answer: it is an error, never `paid` and never `not_a_payment`. Only a Pay run with `valid_contract` true counts. A transaction with
 * a vault input that lists no script run is an incomplete answer too (Koios gives an empty list when the scripts were not asked for).
 * The answer says nothing about how deep the transaction is: a caller waits for confirmations before it trusts `paid`, because a
 * transaction that is not deep can still be rolled back.
 */
export async function escrowPaidFromVault(env: Pick<LedgerEnv, 'deployment' | 'koiosUrl' | 'fetchImpl'>, escrowRef: string, delegationId: string): Promise<EscrowVaultResult> {
  const { txHash, outputIndex } = parseOutRef(escrowRef);
  const delegation = delegationId.toLowerCase();
  if (!ID.test(delegation)) throw new Error('The delegation must be 64 hex characters.');
  const ref = formatOutRef(txHash, outputIndex);
  const { escrow, vault } = env.deployment;
  const not = (reason: EscrowVaultReason, detail: string): EscrowVaultResult => ({ paid: false, reason, detail });

  const rows = await koiosPostList(env.koiosUrl, 'tx_info', { _tx_hashes: [txHash], _inputs: true, _scripts: true, _assets: false, _metadata: false, _certs: false, _withdrawals: false, _bytecode: false }, env.fetchImpl, '', KOIOS_ANSWER_BYTES) as TxInfo[];
  const tx = rows.find((row) => String(row?.tx_hash).toLowerCase() === txHash);
  if (tx === undefined) return not('transaction_not_found', `Koios does not know the transaction ${txHash}: it does not exist, or it is not indexed yet`);
  if (tx.valid_contract === false) return not('contract_failed', `the transaction ${txHash} failed script validation: it took the collateral and made no output, so ${ref} does not exist`);
  // Only a Pay makes an escrow under the limits of a delegation: a Close of the same vault output can sit in a transaction that makes an escrow output too.
  // The flag of each Pay run is read before anything else: a failed transaction made no output, and a run with no flag cannot be believed.
  const payRuns = (Array.isArray(tx.plutus_contracts) ? tx.plutus_contracts as TxContract[] : []).filter((c) => isVaultPay(c, vault.hash));
  if (payRuns.some((c) => c.valid_contract === false)) return not('contract_failed', `the transaction ${txHash} failed script validation (its Pay run of the vault script has valid_contract false): it took the collateral and made no output, so ${ref} does not exist`);
  if (payRuns.some((c) => c.valid_contract !== true)) throw new Error('Koios tx_info: a Pay run of the vault script has no valid_contract that is true or false: the answer is incomplete');
  // A ledger transaction always has an input, so a missing or empty list means that Koios did not honour `_inputs`: an error, never an answer.
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) throw new Error('Koios tx_info: response has no inputs');
  const inputs = tx.inputs as TxIo[];
  const output = (Array.isArray(tx.outputs) ? tx.outputs as TxIo[] : []).find((o) => o?.tx_index === outputIndex);
  if (output === undefined || credOf(output) !== escrow.hash) return not('not_an_escrow_output', `output ${ref} is not an output at the escrow script ${escrow.hash}`);

  const earlier = inputs.filter((i) => credOf(i) === escrow.hash).map(refOf);
  if (earlier.length > 0) return not('continuation', `the transaction spent the escrow output ${join(earlier)}, so ${ref} is a later state of an escrow (a claim, a submit or an accept): give the first output of the escrow`);
  const vaultInputs = inputs.filter((i) => credOf(i) === vault.hash);
  if (vaultInputs.length === 0) return not('no_vault_input', `no input of the transaction ${txHash} is at the vault script ${vault.hash}`);

  // A script input needs a redeemer, so a transaction with a vault input ran the vault script: an empty list is an answer that did not ask for the scripts.
  if (!Array.isArray(tx.plutus_contracts) || tx.plutus_contracts.length === 0) throw new Error('Koios tx_info: response has no script list');
  const paid = vaultInputs.filter((i) => payRuns.some((c) => (c.spends_input ? `${String(c.spends_input.tx_hash).toLowerCase()}#${c.spends_input.tx_index}` === refOf(i) : vaultInputs.length === 1)));
  if (paid.length === 0) return not('not_a_payment', `the vault output ${join(vaultInputs.map(refOf))} was not spent with the Pay redeemer, so the vault did not pay this escrow`);

  const datums: Array<{ input: TxIo; datum: VaultDatum }> = [];
  for (const input of paid) {
    try { datums.push({ input, datum: vaultDatumFromData(dataOfKoiosJson(input.inline_datum?.value)) }); } catch (err) {
      return not('unreadable_vault_datum', `the datum of the vault output ${refOf(input)} cannot be read (${errorText(err)})`);
    }
  }
  const match = datums.find((d) => d.datum.type === 'Live' && d.datum.delegation === delegation);
  if (match === undefined) {
    const named = datums.map((d) => (d.datum.type === 'Live' ? `the delegation ${d.datum.delegation}` : 'no delegation (Returned)'));
    return not('other_delegation', `the vault output ${join(paid.map(refOf))} that paid names ${join(named)}, not the delegation ${delegation}`);
  }
  // The transaction passed script validation, or Koios does not say that it did not: see the comment of the function.
  return { paid: true, vaultRef: refOf(match.input), escrowRef: ref, delegation, payTx: txHash };
}
