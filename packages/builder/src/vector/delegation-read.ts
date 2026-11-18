// packages/builder/src/vector/delegation-read.ts
// Reads of delegations (Part 2 Section 5.2): a delegation with its chain of parents up to the root, and the check whether a delegation
// can be used for an action on a resource at a time. The check runs the use checks that the vault builder runs (delegationUseProblems
// over the chain and the records that readChainRecords reads), and it adds what a read can see that a builder cannot: a delegation that
// does not exist or was undelegated, and the confirmations of each link. Reads only: nothing is built, signed or submitted.
import { delegationUseProblems } from './delegation-build.js';
import { findDelegation, recordsById, requireRecord, uniqueRecords } from './identity-chain.js';
import type { DelegationUtxo, RecordUtxo } from './identity-chain.js';
import { MAX_DEPTH } from './identity-rules.js';
import { KOIOS_ANSWER_BYTES, koiosTipHeight, withinBudget } from './ledger-read.js';
import type { LedgerEnv, ReadSession } from './ledger-read.js';
import { koiosUtxoInfo } from './marketplace-indexer.js';

/** A delegation and its parents. */
export interface DelegationView {
  /** The identifier that was asked for. */
  id: string;
  /** The delegation first, then its parent, up to the root: every link that exists. Empty when the delegation is not live. */
  chain: DelegationUtxo[];
  /** The first parent that does not exist (it was undelegated), or null when the chain ends at a root. Delegations below an undelegated one cannot be used. */
  missingParent: string | null;
}

/** The delegation link `id`, read once for the whole call (`session`). */
function linkOf(env: LedgerEnv, session: ReadSession, id: string): Promise<DelegationUtxo | null> {
  let read = session.links.get(id);
  if (read === undefined) { read = findDelegation(env.provider, env.deployment, id); session.links.set(id, read); }
  return read;
}

/** The record of the identity `id`, read once for the whole call (`session`); a missing record is an error that names `what`. */
function recordOf(env: LedgerEnv, session: ReadSession, id: string, what: string): Promise<RecordUtxo> {
  let read = session.records.get(id);
  if (read === undefined) { read = requireRecord(env.provider, env.deployment, id, what); session.records.set(id, read); }
  return read;
}

/**
 * The delegation `id` and its chain of parents (Part 2 Section 5.2: at most 4 links). A delegation is live while its token sits at the
 * delegation address; an undelegated one is gone. A missing parent does not stop the read: the links that exist are returned and
 * `missingParent` names the one that does not. Each link is read once for the call (`session`), so that a call that reads many
 * delegations of one family reads their shared parents once. Without a `session` the read opens a budget of its own (withinBudget); a
 * read that is part of a larger call passes the session of that call.
 */
export async function readDelegation(env: LedgerEnv, id: string, session?: ReadSession): Promise<DelegationView> {
  if (session === undefined) return withinBudget(env, (inside, own) => readDelegation(inside, id, own));
  const wanted = id.toLowerCase();
  const chain: DelegationUtxo[] = [];
  let missingParent: string | null = null;
  for (let next: string | null = wanted; next !== null;) {
    if (chain.length >= MAX_DEPTH) throw new Error('The delegation chain is longer than 4 links (Part 2 Section 5.2).');
    session.check();
    const link = await linkOf(env, session, next);
    if (link === null) {
      if (chain.length > 0) missingParent = next;
      break;
    }
    chain.push(link);
    next = link.delegation.parent;
  }
  return { id: wanted, chain, missingParent };
}

/**
 * The records that the use check of a delegation chain reads (`links_active`, Part 2 Section 5.2), as chainRecords reads them: the
 * delegate of every link, the root delegator when it is an agent, and the ancestors of each, once each. Each record is also read once
 * for the call (`session`): the delegates of a chain share their ancestors, and chainRecords reads those again for each link. Without
 * a `session` the read opens a budget of its own (withinBudget).
 */
export async function readChainRecords(env: LedgerEnv, chain: readonly DelegationUtxo[], session?: ReadSession): Promise<RecordUtxo[]> {
  if (session === undefined) return withinBudget(env, (inside, own) => readChainRecords(inside, chain, own));
  const records: RecordUtxo[] = [];
  const withAncestors = async (id: string, what: string): Promise<void> => {
    session.check();
    let current = await recordOf(env, session, id, what);
    records.push(current);
    for (let ancestors = 0; current.record.lineage.type === 'Subagent'; ancestors++) {
      if (ancestors >= MAX_DEPTH) throw new Error('The lineage is deeper than 4 levels.');
      session.check();
      current = await recordOf(env, session, current.record.lineage.parent, 'parent record');
      records.push(current);
    }
  };
  for (const link of chain) await withAncestors(link.delegation.delegate, 'record of the delegate');
  const root = chain[chain.length - 1].delegation.delegator;
  if (root.type === 'Agent') await withAncestors(root.id, 'record of the delegator');
  return uniqueRecords(records);
}

// ─── Actions and resources ────────────────────────────────────────────────────────────────────────────────────────────────────────

const EXTERNAL = '(?:oauth:|mcp:|https://)[\\x21-\\x7e]+';
/** An action (Part 2 Section 5.1): an internal name of lowercase letters, digits and `-` in dotted segments, or an external. A pattern such as `*` or `x.*` is not an action. */
const ACTION = new RegExp(`^(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*|${EXTERNAL})$`);
/** A resource (Part 2 Section 5.1): `script:` and 56 lowercase hex, or an external. */
const RESOURCE = new RegExp(`^(?:script:[0-9a-f]{56}|${EXTERNAL})$`);

/** Is `value` an action that a dependent contract can name (Part 2 Section 5.1)? */
export const isAction = (value: string): boolean => ACTION.test(value);
/** Is `value` a resource that a dependent contract can name (Part 2 Section 5.1)? */
export const isResource = (value: string): boolean => RESOURCE.test(value);

// ─── Use ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DelegationUseParams {
  id: string;
  action: string;
  resource: string;
  /** The time that the use is checked at. */
  atMs: number;
  /** Each link must have at least this many blocks on top of the block of its mint. Default 0: no wait. */
  minConfirmations?: number;
}

/** How deep a link is: the blocks on top of the block that holds its mint. */
export interface LinkConfirmations { id: string; blockHeight: number | null; confirmations: number | null }

export interface DelegationUseCheck {
  view: DelegationView;
  action: string;
  resource: string;
  atMs: number;
  minConfirmations: number;
  /** Why the delegation cannot be used; empty when it can. */
  problems: string[];
  usable: boolean;
  /** The tip and the depth of each link, when `minConfirmations` asked for them. */
  confirmations: { tipHeight: number; links: LinkConfirmations[] } | null;
}

/**
 * Checks whether the delegation `id` can be used for `action` on `resource` at `atMs` (Part 2 Section 5.2, as a dependent contract
 * uses it). The problems are those of delegationUseProblems over the chain and the records that readChainRecords reads, for the
 * instant `atMs` (the validity window starts and ends there): the delegation and every ancestor exist, each delegate is Active and
 * still lists its delegation key with the delegation purpose, a root delegator that is an agent is Active, the period holds the time,
 * and the action patterns and resource patterns cover `action` and `resource` by the pattern rule of Section 5.1. A delegation
 * that does not exist, or whose parent was undelegated, is a problem, not an error. Signatures are not checked. With
 * `minConfirmations` above 0 each link must also be that deep (the rule of the gateway's token path); an undelegation counts at once.
 * The result is for the one instant `atMs`. A transaction needs its whole validity window inside the period, with each delegate Active
 * over the window, so a use that passes here can still fail in a build. Each delegation link and each record is read once for the call.
 * The whole call, the reads of the confirmations included, runs inside one budget (withinBudget).
 */
export async function checkDelegationUse(env: LedgerEnv, p: DelegationUseParams): Promise<DelegationUseCheck> {
  if (!isAction(p.action)) throw new Error('The action must follow Part 2 Section 5.1: an internal name such as marketplace.hire.v1, or an external that starts with oauth:, mcp: or https://. A pattern is not an action.');
  if (!isResource(p.resource)) throw new Error('The resource must follow Part 2 Section 5.1: script: and the 56 hex characters of a script hash, or an external that starts with oauth:, mcp: or https://.');
  const minConfirmations = p.minConfirmations ?? 0;
  if (!Number.isInteger(minConfirmations) || minConfirmations < 0) throw new Error('min_confirmations must be a whole number of at least 0');
  return withinBudget(env, async (inside, session) => {
    const view = await readDelegation(inside, p.id, session);
    const result: DelegationUseCheck = { view, action: p.action, resource: p.resource, atMs: p.atMs, minConfirmations, problems: [], usable: false, confirmations: null };
    if (view.chain.length === 0) {
      result.problems.push(`the delegation ${view.id} is not live: it does not exist, or it was undelegated and its token is burned`);
      return result;
    }
    const records = await readChainRecords(inside, view.chain, session);
    result.problems.push(...delegationUseProblems(view.chain, recordsById(records), p.action, p.resource, { lo: p.atMs, hi: p.atMs }));
    if (minConfirmations > 0) {
      const confirmations = await linkConfirmations(inside, view.chain);
      result.confirmations = confirmations;
      for (const link of confirmations.links) {
        if (link.confirmations === null) result.problems.push(`Koios gives no block height for the output of the delegation ${link.id}, so its confirmations are unknown`);
        else if (link.confirmations < minConfirmations) result.problems.push(`the delegation ${link.id} has ${link.confirmations} confirmations, fewer than the ${minConfirmations} that are asked for`);
      }
    }
    result.usable = result.problems.length === 0;
    return result;
  });
}

/** The depth of each link of `chain` below the tip: the tip height minus the height of the block that holds its output (its mint: a delegation output never changes). */
async function linkConfirmations(env: LedgerEnv, chain: readonly DelegationUtxo[]): Promise<{ tipHeight: number; links: LinkConfirmations[] }> {
  const tipHeight = await koiosTipHeight(env.koiosUrl, env.fetchImpl);
  const rows = await koiosUtxoInfo(env.koiosUrl, chain.map((l) => `${l.utxo.txHash}#${l.utxo.outputIndex}`), env.fetchImpl, KOIOS_ANSWER_BYTES);
  const heights = new Map(rows.map((r) => [`${String(r?.tx_hash).toLowerCase()}#${r?.tx_index}`, r?.block_height]));
  return {
    tipHeight,
    links: chain.map((l) => {
      const height = heights.get(`${l.utxo.txHash}#${l.utxo.outputIndex}`);
      return typeof height === 'number' && Number.isSafeInteger(height) && height >= 0
        ? { id: l.id, blockHeight: height, confirmations: tipHeight - height }
        : { id: l.id, blockHeight: null, confirmations: null };
    }),
  };
}
