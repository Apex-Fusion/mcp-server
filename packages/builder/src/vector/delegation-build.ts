// packages/builder/src/vector/delegation-build.ts
// Keyless builders of the delegation contract (Part 2 Section 5.2): Delegate (also sub-delegations) and Undelegate, with the action
// and resource patterns of Section 5.1 and the use checks of Section 5.2 that the vault builders share. Each builder checks the rules
// it can check before it builds, so that a refusal names the rule. Then it assembles the transaction, lets Lucid run the applied
// delegation script on it (local evaluation through the reference script), and returns the unsigned CBOR with every key hash that
// must sign. Nothing is signed or submitted.
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import {
  MAX_TIME_MS, decodeDelegationDatum, encodeDelegationDatum, encodeDelegationMint, textOf, utf8Hex,
} from './identity-codec.js';
import type { DelegationDatum, Delegator, IdentityDatum, ValueLimit } from './identity-codec.js';
import { readRefScript } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import {
  chainClock, chainRecords, delegationChain, didOf, findDelegation, findRecord, identifierFromSeed, recordWithAncestors, recordsById,
  seedFrom, signedByResult, uniqueUtxos, walletOf, windowAt, SignerList,
} from './identity-chain.js';
import type { DelegationUtxo, RecordUtxo, SignedByBuild, Window } from './identity-chain.js';
import { MAX_DEPTH, PURPOSE, activeKey, effectiveStatus, keyHashOf, keyHasPurpose } from './identity-rules.js';
import { outputIndexOf } from './identity-build.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';
import { isoOrRaw } from './marketplace-shared.js';
import { ledgerMinLovelace } from './attestation-build.js';

const byteLength = (hex: string): number => hex.length / 2;
const validTime = (t: number): boolean => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME_MS;

// ─── Patterns (Part 2 Section 5.1; port of delegation/pattern.ak) ──────────────────────────────────────────────────────────────
// The functions take UTF-8 text and work on its bytes, as the contract does. A datum holds the patterns as hex: patternsOf decodes them.

/** The action of vault payments (Part 2 Section 5.1). */
export const HIRE_ACTION = 'marketplace.hire.v1';
/** The resource of vault payments to the escrow script `escrowHash`: `script:<56 lowercase hex>`. */
export const escrowResource = (escrowHash: string): string => `script:${escrowHash.toLowerCase()}`;

const STAR = Buffer.from('*');
const DOT = 0x2e;
const ASTERISK = 0x2a;
const MCP = Buffer.from('mcp:');
const OAUTH = Buffer.from('oauth:');
const HTTPS = Buffer.from('https://');
const SCRIPT = Buffer.from('script:');

const startsWith = (bytes: Buffer, prefix: Buffer): boolean => bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
/** The length of the scheme of an `external` (`mcp:`, `oauth:` or `https://`), or 0. */
const schemeLength = (p: Buffer): number => (startsWith(p, MCP) ? 4 : startsWith(p, OAUTH) ? 6 : startsWith(p, HTTPS) ? 8 : 0);
/** The pattern ends with `.*` after at least one other byte. */
const endsWithDotStar = (p: Buffer): boolean => p.length >= 3 && p[p.length - 2] === DOT && p[p.length - 1] === ASTERISK;

/** The bytes `[0, end)` are `seg *( "." seg )`, with `seg = 1*( %x61-7A / DIGIT / "-" )`. */
function internalSpan(p: Buffer, end: number): boolean {
  let segment = 0;
  for (let i = 0; i < end; i++) {
    const byte = p[i];
    if (byte === DOT) {
      if (segment === 0) return false;
      segment = 0;
    } else if ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d) {
      segment += 1;
    } else {
      return false;
    }
  }
  return segment > 0;
}

/** The bytes from `start` to the end are `1*VCHAR` (`%x21-7E`). */
const visibleFrom = (p: Buffer, start: number): boolean => start < p.length && p.subarray(start).every((b) => b >= 0x21 && b <= 0x7e);

/** Is `pattern` an `action-pattern`: `*`, an internal name, a prefix `x.*`, or an external (`oauth:`, `mcp:`, `https://` and visible characters)? */
export function validActionPattern(pattern: string): boolean {
  const p = Buffer.from(pattern, 'utf8');
  if (p.equals(STAR)) return true;
  const scheme = schemeLength(p);
  if (scheme > 0) return visibleFrom(p, scheme);
  return internalSpan(p, endsWithDotStar(p) ? p.length - 2 : p.length);
}

/** Is `pattern` a `resource-pattern`: `*`, `script:<56 lowercase hex>`, or an external? */
export function validResourcePattern(pattern: string): boolean {
  const p = Buffer.from(pattern, 'utf8');
  if (p.equals(STAR)) return true;
  const scheme = schemeLength(p);
  if (scheme > 0) return visibleFrom(p, scheme);
  return p.length === 63 && startsWith(p, SCRIPT) && p.subarray(7).every((b) => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66));
}

/**
 * Does `pattern` cover `value` (an action, a resource, or a child pattern)? Yes when `pattern` is `*`, equals `value`, or is a prefix
 * `x.*` and `value` starts with `x.`. External and script patterns match only exactly. Thus a child `x.*` is covered only by `*`, by
 * itself, or by a parent `y.*` where `x` starts with `y.`: `oc.*` does not cover `ocr.*`. Trusts that `pattern` follows the grammar,
 * as the contract does.
 */
export function patternCovers(pattern: string, value: string): boolean {
  const p = Buffer.from(pattern, 'utf8');
  const v = Buffer.from(value, 'utf8');
  if (p.equals(STAR) || p.equals(v)) return true;
  return endsWithDotStar(p) && startsWith(v, p.subarray(0, p.length - 1)) && schemeLength(p) === 0 && !startsWith(p, SCRIPT);
}

/** Does a pattern of `patterns` cover `value` (`covered`)? An empty list covers nothing (decision 3 of tests/delegation.md). */
export const patternsCover = (patterns: readonly string[], value: string): boolean => patterns.some((pattern) => patternCovers(pattern, value));

/** Is the `child` list narrower than the `parent` list: does a parent pattern cover each child pattern? */
export const narrower = (child: readonly string[], parent: readonly string[]): boolean => child.every((pattern) => patternsCover(parent, pattern));

/** The patterns of a datum (UTF-8 bytes as hex) as text. Bytes that are not UTF-8 cannot follow the grammar; they become '', which covers nothing. */
export const patternsOf = (hexes: readonly string[]): string[] => hexes.map((hex) => textOf(hex) ?? '');

// ─── Datum rules (port of delegation/handlers.ak) ──────────────────────────────────────────────────────────────────────────────

export const MAX_ACTIONS = 16;
export const MAX_RESOURCES = 8;
/** The highest `total` (and so `per_tx`) of a value limit: 10,000 AP3X in base units. */
export const MAX_LIMIT_LOVELACE = 10_000_000_000n;
const MAX_UINT = (1n << 63n) - 1n;

/** The problems of a value limit (`valid_limit`): `1 <= period_ms < 2^63` and `0 <= per_tx <= total <= 10,000 AP3X`. */
export function valueLimitProblems(v: ValueLimit): string[] {
  const problems: string[] = [];
  if (v.perTx < 0n) problems.push('per_tx cannot be negative');
  if (v.perTx > v.total) problems.push(`per_tx (${v.perTx}) must be at most total (${v.total})`);
  if (v.total > MAX_LIMIT_LOVELACE) problems.push(`total (${v.total}) must be at most 10,000 AP3X (${MAX_LIMIT_LOVELACE})`);
  if (!Number.isSafeInteger(v.periodMs) || v.periodMs < 1 || BigInt(v.periodMs) > MAX_UINT) problems.push('period_ms must be a whole number of at least 1');
  return problems;
}

/**
 * The problems that make `d` an invalid delegation datum (`valid_delegation`), in words; empty when it is valid: a principal key hash of
 * 28 bytes with an organisation of 1 to 64 bytes, or a 32-byte agent; a 32-byte parent and delegate; a 28-byte delegate key; 1 to 16
 * action patterns and 0 to 8 resource patterns that follow the grammar; valid times with `not_before < not_after`; depth 1 to 4,
 * `remaining >= 0`, `depth + remaining <= 4`; a 32-byte purpose; and a valid value limit.
 */
export function delegationProblems(d: DelegationDatum): string[] {
  const problems: string[] = [];
  const say = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  if (d.delegator.type === 'PrincipalKey') {
    say(byteLength(d.delegator.hash) === 28, 'the principal key hash must be 28 bytes');
    const organisation = d.delegator.organisation;
    say(organisation === null || (byteLength(organisation) >= 1 && byteLength(organisation) <= 64), 'the organisation must be 1 to 64 bytes');
  } else {
    say(byteLength(d.delegator.id) === 32, 'the delegator agent must be a 32-byte identifier');
  }
  say(d.parent === null || byteLength(d.parent) === 32, 'the parent must be a 32-byte delegation identifier');
  say(byteLength(d.delegate) === 32, 'the delegate must be a 32-byte identifier');
  say(byteLength(d.delegateKey) === 28, 'the delegate key must be a 28-byte key hash');
  const actions = patternsOf(d.actions);
  const resources = patternsOf(d.resources);
  say(actions.length >= 1 && actions.length <= MAX_ACTIONS, `1 to ${MAX_ACTIONS} action patterns, got ${actions.length}`);
  for (const action of actions) {
    say(validActionPattern(action), `${JSON.stringify(action)} is not an action pattern ("*", a name such as ocr.extract.v1, a prefix such as ocr.*, or oauth:, mcp: or https:// with visible characters after it)`);
  }
  say(resources.length <= MAX_RESOURCES, `at most ${MAX_RESOURCES} resource patterns, got ${resources.length}`);
  for (const resource of resources) {
    say(validResourcePattern(resource), `${JSON.stringify(resource)} is not a resource pattern ("*", script:<56 lowercase hex>, or oauth:, mcp: or https:// with visible characters after it)`);
  }
  say(validTime(d.notBefore), 'not_before is not a valid time');
  say(validTime(d.notAfter), 'not_after is not a valid time');
  say(d.notBefore < d.notAfter, `not_before (${isoOrRaw(d.notBefore)}) must be before not_after (${isoOrRaw(d.notAfter)})`);
  say(Number.isInteger(d.depth) && d.depth >= 1, 'the depth must be at least 1');
  say(Number.isInteger(d.remaining) && d.remaining >= 0, 'remaining cannot be negative');
  say(d.depth + d.remaining <= MAX_DEPTH, `depth ${d.depth} plus remaining ${d.remaining} must be at most ${MAX_DEPTH}`);
  say(d.purpose === null || byteLength(d.purpose) === 32, 'the purpose must be 32 bytes (the hash of a purpose text or mandate)');
  if (d.value !== null) problems.push(...valueLimitProblems(d.value));
  return problems;
}

/**
 * The problems that make `child` wider than its `parent` (Part 2 Section 5.2, `sub_authorised`): a parent pattern covers each child
 * action and resource; the period is inside the parent's; the depth is the parent's plus one; `remaining` is at most the parent's
 * minus one; and under a parent with a value limit, the child has one with `per_tx` and `total` at most the parent's and `period_ms`
 * at least the parent's.
 */
export function narrowingProblems(child: DelegationDatum, parent: DelegationDatum): string[] {
  const problems: string[] = [];
  const list = (patterns: string[]) => (patterns.length === 0 ? 'none' : patterns.map((x) => JSON.stringify(x)).join(', '));
  const parentActions = patternsOf(parent.actions);
  const parentResources = patternsOf(parent.resources);
  const wideActions = patternsOf(child.actions).filter((a) => !patternsCover(parentActions, a));
  const wideResources = patternsOf(child.resources).filter((r) => !patternsCover(parentResources, r));
  if (wideActions.length > 0) problems.push(`no action pattern of the parent (${list(parentActions)}) covers ${list(wideActions)}`);
  if (wideResources.length > 0) problems.push(`no resource pattern of the parent (${list(parentResources)}) covers ${list(wideResources)}`);
  if (child.notBefore < parent.notBefore || child.notAfter > parent.notAfter) {
    problems.push(`the period (${isoOrRaw(child.notBefore)} to ${isoOrRaw(child.notAfter)}) must be inside the parent's (${isoOrRaw(parent.notBefore)} to ${isoOrRaw(parent.notAfter)})`);
  }
  if (child.depth !== parent.depth + 1) problems.push(`the depth must be the parent's plus one (${parent.depth + 1})`);
  if (child.remaining > parent.remaining - 1) problems.push(`remaining (${child.remaining}) must be at most the parent's minus one (${parent.remaining - 1})`);
  if (parent.value !== null) {
    const p = parent.value;
    const c = child.value;
    if (c === null) problems.push(`the parent has a value limit (per_tx ${p.perTx}, total ${p.total}, period_ms ${p.periodMs}), so the child needs one within it`);
    else {
      if (c.perTx > p.perTx) problems.push(`per_tx (${c.perTx}) must be at most the parent's (${p.perTx})`);
      if (c.total > p.total) problems.push(`total (${c.total}) must be at most the parent's (${p.total})`);
      if (c.periodMs < p.periodMs) problems.push(`period_ms (${c.periodMs}) must be at least the parent's (${p.periodMs})`);
    }
  }
  return problems;
}

// ─── Use checks (Part 2 Section 5.2; port of chain.use_delegation) ─────────────────────────────────────────────────────────────

/**
 * The problems that stop a dependent contract (the vault) from using `chain` for `action` and `resource` in `window`, in words; empty
 * when it can. `chain` is delegationChain's (the delegation in use first, then its ancestors up to the root); `records` holds the
 * records that chainRecords returns (the delegate of every link, a root delegator agent, and their ancestors). The checks: the period
 * of the delegation in use contains `[lo, hi]`; one of its action patterns covers `action` and one of its resource patterns covers
 * `resource`; every link's delegate is Active and still lists the link's delegate key with the delegation purpose (decision 1 of
 * tests/delegation.md); a root delegator agent is Active; and the links form one chain that ends at a root. The caller adds the delegate
 * key of the delegation in use as a required signer: this function does not check signatures.
 */
export function delegationUseProblems(
  chain: readonly DelegationUtxo[], records: ReadonlyMap<string, IdentityDatum>, action: string, resource: string, window: Window,
): string[] {
  if (chain.length === 0) return ['no delegation is given'];
  const problems: string[] = [];
  const statusOf = (record: IdentityDatum): string => {
    try { return effectiveStatus(record, records, window.lo, window.hi); } catch (err) { return `unknown (${err instanceof Error ? err.message : String(err)})`; }
  };
  const used = chain[0];
  if (!patternsCover(patternsOf(used.delegation.actions), action)) problems.push(`no action pattern of the delegation ${used.id} covers ${JSON.stringify(action)}`);
  if (!patternsCover(patternsOf(used.delegation.resources), resource)) {
    problems.push(`no resource pattern of the delegation ${used.id} covers ${JSON.stringify(resource)}${used.delegation.resources.length === 0 ? ' (an empty resource list covers nothing)' : ''}`);
  }
  if (used.delegation.notBefore > window.lo) problems.push(`the delegation ${used.id} starts at ${isoOrRaw(used.delegation.notBefore)}, after the start of the validity window`);
  if (window.hi > used.delegation.notAfter) problems.push(`the delegation ${used.id} ends at ${isoOrRaw(used.delegation.notAfter)}, before the end of the validity window`);
  if (chain.length > MAX_DEPTH) problems.push(`the chain has ${chain.length} links, more than ${MAX_DEPTH}`);
  chain.forEach((link, i) => {
    const parent = chain[i + 1];
    if (link.delegation.parent !== (parent?.id ?? null)) {
      problems.push(parent === undefined ? `the parent delegation ${link.delegation.parent} of ${link.id} is missing` : `${parent.id} is not the parent of ${link.id}`);
    }
    const delegate = records.get(link.delegation.delegate);
    if (!delegate) { problems.push(`the record of the delegate ${didOf(link.delegation.delegate)} of ${link.id} is missing`); return; }
    const status = statusOf(delegate);
    if (status !== 'Active') problems.push(`the delegate ${didOf(link.delegation.delegate)} of ${link.id} is ${status}`);
    if (!activeKey(delegate, link.delegation.delegateKey, PURPOSE.delegation)) {
      problems.push(`${didOf(link.delegation.delegate)} no longer lists the delegate key ${link.delegation.delegateKey} of ${link.id} with the delegation purpose`);
    }
  });
  const root = chain[chain.length - 1];
  if (root.delegation.delegator.type === 'Agent') {
    const id = root.delegation.delegator.id;
    const record = records.get(id);
    const status = record ? statusOf(record) : 'missing';
    if (status !== 'Active') problems.push(status === 'missing' ? `the record of the root delegator ${didOf(id)} is missing` : `the root delegator ${didOf(id)} is ${status}`);
  }
  return problems;
}

// ─── Lookup ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every live delegation: each output at exactly the delegation address that holds exactly one token of the delegation policy, with a
 * datum that decodes. The fresh-key rule of Part 2 Section 5.2 reads them.
 */
export async function liveDelegations(provider: Provider, deployment: IdentityDeployment): Promise<DelegationUtxo[]> {
  const policy = deployment.delegation.hash;
  const live: DelegationUtxo[] = [];
  for (const utxo of await provider.getUtxos(deployment.delegation.address)) {
    const tokens = Object.entries(utxo.assets).filter(([unit]) => unit.startsWith(policy));
    if (utxo.address !== deployment.delegation.address || tokens.length !== 1 || tokens[0][1] !== 1n || !utxo.datum) continue;
    try { live.push({ id: tokens[0][0].slice(policy.length), utxo, delegation: decodeDelegationDatum(utxo.datum) }); } catch { /* not a delegation datum: not live */ }
  }
  return live;
}

/** The key hashes that `record` lists with the delegation purpose. */
const delegationKeysOf = (record: IdentityDatum): string[] => record.keys.filter((k) => keyHasPurpose(k, PURPOSE.delegation)).map((k) => keyHashOf(k.key));

function requireActive(record: IdentityDatum, byId: ReadonlyMap<string, IdentityDatum>, window: Window, who: string): void {
  const status = effectiveStatus(record, byId, window.lo, window.hi);
  if (status !== 'Active') throw new Error(`${who} is ${status}; it must be Active (Part 2 Section 5.2).`);
}

// ─── Delegate (Part 2 Section 5.2) ─────────────────────────────────────────────────────────────────────────────────────────────

/** The delegator of a new delegation: a principal key (its hash signs), or a registered agent with the key that signs for it. */
export type DelegatorInput =
  | { type: 'PrincipalKey'; hash: string; /** UTF-8 bytes as hex. */ organisation?: string | null }
  | { type: 'Agent'; id: string; /** 'controller' (default), or the key hash of a key that the record lists with the delegation purpose. */ signer?: string };

export interface DelegateParams extends BuildCommon {
  /** Without `parent`: required. With `parent`: optional, and then it must be the parent's delegate agent. */
  delegator?: DelegatorInput;
  /** The token name of the parent delegation, for a sub-delegation. */
  parent?: string;
  /** The identifier of the delegate agent. */
  delegate: string;
  /** The key hash of the delegate's Ed25519 delegation key. */
  delegateKey: string;
  /** Action patterns as text (Part 2 Section 5.1). */
  actions: string[];
  /** Resource patterns as text; default none. */
  resources?: string[];
  /** POSIX ms; default the start of the window, or the parent's `not_before` when that is later. */
  notBefore?: number;
  notAfter: number;
  /** Further hops allowed below this delegation; default 0. */
  remaining?: number;
  /** 32 bytes, hex. */
  purpose?: string;
  value?: ValueLimit;
}

export interface DelegateBuild extends SignedByBuild {
  /** The token name of the delegation: its identifier. */
  id: string;
  /** The wallet output that the transaction spends as the seed; it gives the identifier. */
  seed: string;
  outputIndex: number;
  /** The AP3X of the delegation output: the ledger minimum. Undelegate returns it. */
  outputLovelace: bigint;
  delegation: DelegationDatum;
}

/**
 * Builds the unsigned Delegate of a new delegation (Part 2 Section 5.2). The wallet's largest pure-AP3X output is the seed, so the
 * identifier is known before signing. The output at the delegation address holds the token and the ledger minimum of AP3X.
 * - Without `parent` (depth 1): a principal key signs, or for an agent delegator (Active) its controller or a listed key with the
 *   delegation purpose (`signer`). The agent's record and ancestors are reference inputs.
 * - With `parent` (a sub-delegation): the delegator is the parent's delegate agent, which must be Active and still list the parent's
 *   delegate key with the delegation purpose; that key signs; the parent must allow another hop; the child must be narrower
 *   (narrowingProblems). The parent's chain and the records that its use check reads are reference inputs, so a broken chain is
 *   refused.
 * - The delegate is Active, lists `delegateKey` with the delegation purpose, and that key signs. No other live delegation may use the
 *   same key (fresh keys).
 */
export async function buildDelegate(ctx: IdentityContext, p: DelegateParams): Promise<DelegateBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const signers = new SignerList();
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'delegation', deployment.delegation.hash)];

  let delegator: Delegator;
  let parent: DelegationUtxo | null = null;
  if (p.parent !== undefined) {
    const chain = await delegationChain(provider, deployment, p.parent.toLowerCase());
    parent = chain[0];
    const agentId = parent.delegation.delegate;
    if (p.delegator !== undefined && !(p.delegator.type === 'Agent' && p.delegator.id.toLowerCase() === agentId)) {
      throw new Error(`The delegator of a sub-delegation is the delegate of its parent: ${didOf(agentId)} for the parent ${parent.id} (Part 2 Section 5.2).`);
    }
    if (parent.delegation.remaining < 1) throw new Error(`The parent delegation ${parent.id} allows no further hop (remaining 0), so it cannot have a sub-delegation.`);
    const records = await chainRecords(provider, deployment, chain);
    const byId = recordsById(records);
    const agent = byId.get(agentId);
    if (!agent) throw new Error(`The record of the delegator ${didOf(agentId)} is missing.`);
    requireActive(agent, byId, window, `The delegator ${didOf(agentId)}`);
    if (!activeKey(agent, parent.delegation.delegateKey, PURPOSE.delegation)) {
      throw new Error(`${didOf(agentId)} no longer lists the delegate key ${parent.delegation.delegateKey} of the parent delegation ${parent.id} with the delegation purpose, so that key cannot sign a sub-delegation (Part 2 Section 5.2).`);
    }
    delegator = { type: 'Agent', id: agentId };
    signers.add(parent.delegation.delegateKey, `delegate key of the parent delegation ${parent.id} (${didOf(agentId)})`);
    refs.push(...chain.map((link) => link.utxo), ...records.map((r) => r.utxo));
  } else if (p.delegator === undefined) {
    throw new Error('Name the delegator: a principal key or a registered agent (or a parent delegation, for a sub-delegation).');
  } else if (p.delegator.type === 'PrincipalKey') {
    delegator = { type: 'PrincipalKey', hash: p.delegator.hash.toLowerCase(), organisation: p.delegator.organisation?.toLowerCase() ?? null };
    signers.add(delegator.hash, 'principal key (delegator)');
  } else {
    const records = await recordWithAncestors(provider, deployment, p.delegator.id.toLowerCase(), 'record of the delegator');
    const agent = records[0];
    requireActive(agent.record, recordsById(records), window, `The delegator ${didOf(agent.id)}`);
    const signer = (p.delegator.signer ?? 'controller').toLowerCase();
    if (signer === 'controller' || signer === keyHashOf(agent.record.controller)) {
      signers.addKey(agent.record.controller, `controller of the delegator ${didOf(agent.id)}`);
    } else if (activeKey(agent.record, signer, PURPOSE.delegation)) {
      signers.add(signer, `delegation key of the delegator ${didOf(agent.id)}`);
    } else {
      throw new Error(`${signer} is neither the controller of ${didOf(agent.id)} nor a key that it lists with the delegation purpose (its delegation keys: ${delegationKeysOf(agent.record).join(', ') || 'none'}). One of them signs for an agent delegator (Part 2 Section 5.2).`);
    }
    delegator = { type: 'Agent', id: agent.id };
    refs.push(...records.map((r) => r.utxo));
  }

  const delegateKey = p.delegateKey.toLowerCase();
  const delegation: DelegationDatum = {
    delegator, parent: parent?.id ?? null, delegate: p.delegate.toLowerCase(), delegateKey,
    actions: p.actions.map(utf8Hex), resources: (p.resources ?? []).map(utf8Hex),
    notBefore: p.notBefore ?? Math.max(window.lo, parent?.delegation.notBefore ?? window.lo), notAfter: p.notAfter,
    depth: parent === null ? 1 : parent.delegation.depth + 1, remaining: p.remaining ?? 0,
    purpose: p.purpose?.toLowerCase() ?? null, value: p.value ?? null,
  };
  const problems = delegationProblems(delegation);
  if (problems.length > 0) throw new Error(`The delegation breaks the rules of Part 2 Sections 5.1 and 5.2: ${problems.join('; ')}.`);
  if (parent !== null) {
    const wider = narrowingProblems(delegation, parent.delegation);
    if (wider.length > 0) throw new Error(`The sub-delegation is wider than its parent ${parent.id} (Part 2 Section 5.2): ${wider.join('; ')}.`);
  }

  const delegateRecords = await recordWithAncestors(provider, deployment, delegation.delegate, 'record of the delegate');
  const delegate = delegateRecords[0].record;
  requireActive(delegate, recordsById(delegateRecords), window, `The delegate ${didOf(delegation.delegate)}`);
  if (!activeKey(delegate, delegateKey, PURPOSE.delegation)) {
    throw new Error(`${didOf(delegation.delegate)} does not list the key ${delegateKey} with the delegation purpose (active_key, Part 2 Section 5.2). Its delegation keys: ${delegationKeysOf(delegate).join(', ') || 'none'}.`);
  }
  const live = await liveDelegations(provider, deployment);
  const reused = live.find((d) => d.delegation.delegateKey === delegateKey);
  if (reused) {
    const used = new Set(live.map((d) => d.delegation.delegateKey));
    const free = delegationKeysOf(delegate).filter((k) => !used.has(k));
    throw new Error(`The live delegation ${reused.id} already uses the delegate key ${delegateKey}: each delegation needs a fresh key (Part 2 Section 5.2). Free delegation keys of ${didOf(delegation.delegate)}: ${free.join(', ') || 'none; list another key with the delegation purpose, or undelegate first'}.`);
  }
  refs.push(...delegateRecords.map((r) => r.utxo));
  signers.add(delegateKey, `delegate key (${didOf(delegation.delegate)})`);

  const seed = seedFrom(wallet.utxos);
  const id = identifierFromSeed(seed);
  const unit = `${deployment.delegation.hash}${id}`;
  const datum = encodeDelegationDatum(delegation);
  const outputLovelace = ledgerMinLovelace(lucid, deployment.delegation.address, unit, datum);
  let tx = lucid.newTx()
    .collectFrom([seed])
    .mintAssets({ [unit]: 1n }, encodeDelegationMint({ type: 'Delegate', seed: { txHash: seed.txHash, outputIndex: seed.outputIndex } }))
    .pay.ToContract(deployment.delegation.address, { kind: 'inline', value: datum }, { lovelace: outputLovelace, [unit]: 1n })
    .validFrom(window.lo)
    .validTo(window.hi)
    .readFrom(uniqueUtxos(refs));
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  const outputIndex = outputIndexOf(result.txCbor, deployment.delegation.address, unit);
  return { ...result, id, seed: `${seed.txHash}#${seed.outputIndex}`, outputIndex, outputLovelace, delegation };
}

// ─── Undelegate (Part 2 Section 5.2) ───────────────────────────────────────────────────────────────────────────────────────────

/** A delegator's key that may sign an Undelegate, or the words that say who may. */
type Authority = { ok: true; keyHash: string; role: string; record: RecordUtxo | null } | { ok: false; who: string };

/**
 * Can `signer` sign for the delegator of `link` (`delegator_signed`)? A principal key by its hash; an agent by its controller or a key
 * that its record lists with the delegation purpose (the record becomes a reference input; its status does not matter, decision 7).
 * Without `signer`: the principal key, or the agent's controller.
 */
async function delegatorAuthority(provider: Provider, deployment: IdentityDeployment, link: DelegationUtxo, signer: string | undefined): Promise<Authority> {
  const d = link.delegation.delegator;
  if (d.type === 'PrincipalKey') {
    if (signer === undefined || signer === d.hash) return { ok: true, keyHash: d.hash, role: `principal key, delegator of ${link.id}`, record: null };
    return { ok: false, who: `the principal key ${d.hash} (delegator of ${link.id})` };
  }
  const record = await findRecord(provider, deployment, d.id);
  if (!record) return { ok: false, who: `nobody for ${didOf(d.id)} (delegator of ${link.id}): its record is missing` };
  const controller = keyHashOf(record.record.controller);
  if (signer === undefined || signer === controller) return { ok: true, keyHash: controller, role: `controller of ${didOf(d.id)}, delegator of ${link.id}`, record };
  if (activeKey(record.record, signer, PURPOSE.delegation)) return { ok: true, keyHash: signer, role: `delegation key of ${didOf(d.id)}, delegator of ${link.id}`, record };
  const keys = delegationKeysOf(record.record);
  return { ok: false, who: `the controller ${controller}${keys.length > 0 ? ` or a delegation key (${keys.join(', ')})` : ''} of ${didOf(d.id)} (delegator of ${link.id})` };
}

export interface UndelegateParams extends BuildCommon {
  /** The token name of the delegation to end. */
  id: string;
  /**
   * The key hash that signs: the delegator of this delegation or of an ancestor (a principal key, or an agent's controller or listed
   * delegation key). Default: the delegator of this delegation (its principal key, or its agent's controller).
   */
  signer?: string;
}

export interface UndelegateBuild extends SignedByBuild {
  id: string;
  delegation: DelegationDatum;
  /** The AP3X of the delegation output: the transaction returns it to the wallet (less the fee). */
  releasedLovelace: bigint;
  /** Whose delegator signs: 0 this delegation, 1 its parent, and so on. */
  authorityLink: number;
  /** Who signs, in words. */
  authority: string;
}

/**
 * Builds the unsigned Undelegate of a live delegation (Part 2 Section 5.2): the delegation output is the only input at the delegation
 * address, its token burns (`[(id, -1)]`, Undelegate as both the mint and the spend redeemer, decision 10), and its AP3X returns to the
 * wallet. The delegator of the delegation signs, or the delegator of an ancestor: the builder walks up the chain until `signer` is a
 * delegator's key, and adds the ancestors up to that link and the agent's record as reference inputs. Delegations below it become
 * unusable at once.
 */
export async function buildUndelegate(ctx: IdentityContext, p: UndelegateParams): Promise<UndelegateBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const target = await findDelegation(provider, deployment, p.id.toLowerCase());
  if (!target) throw new Error(`No live delegation ${p.id} at ${deployment.delegation.address}: it does not exist, has been undelegated, or is not confirmed yet.`);
  const signer = p.signer?.toLowerCase();
  const links: DelegationUtxo[] = [target];
  const who: string[] = [];
  let found: { link: number; keyHash: string; role: string; record: RecordUtxo | null } | null = null;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const link = links[i];
    const authority = await delegatorAuthority(provider, deployment, link, signer);
    if (authority.ok) { found = { link: i, keyHash: authority.keyHash, role: authority.role, record: authority.record }; break; }
    who.push(authority.who);
    if (signer === undefined || link.delegation.parent === null) break;
    const parent = await findDelegation(provider, deployment, link.delegation.parent);
    if (!parent) { who.push(`nobody above: the parent delegation ${link.delegation.parent} no longer exists`); break; }
    links.push(parent);
  }
  if (!found) {
    throw new Error(signer === undefined
      ? `Nobody can sign for the delegator of ${target.id}: ${who.join('; ')}.`
      : `The key ${signer} is not a delegator's key of ${target.id} or of an ancestor, so it cannot undelegate (Part 2 Section 5.2). Who can sign: ${who.join('; ')}.`);
  }

  const signers = new SignerList().add(found.keyHash, found.role);
  const refs: UTxO[] = [
    await readRefScript(provider, deployment, 'delegation', deployment.delegation.hash),
    ...links.slice(1, found.link + 1).map((link) => link.utxo),
    ...(found.record ? [found.record.utxo] : []),
  ];
  const unit = `${deployment.delegation.hash}${target.id}`;
  const undelegate = encodeDelegationMint({ type: 'Undelegate' });
  let tx = lucid.newTx()
    .collectFrom([target.utxo], undelegate)
    .mintAssets({ [unit]: -1n }, undelegate)
    .validFrom(window.lo)
    .validTo(window.hi)
    .readFrom(uniqueUtxos(refs));
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  return {
    ...result, id: target.id, delegation: target.delegation, releasedLovelace: target.utxo.assets.lovelace,
    authorityLink: found.link, authority: found.role,
  };
}
