// packages/builder/src/vector/ledger-read.ts
// What the reads of attestations, delegations and vaults share (attestation-read.ts, delegation-read.ts, vault-read.ts): the node and
// Koios that a read uses, a Koios row as a node output, the sole token of an output, the read of a script credential, the datum of a
// Koios transaction input, the tip, and paging. Reads only. Nothing here builds, signs or submits.
import { Constr } from '@lucid-evolution/lucid';
import type { Data, Provider, UTxO } from '@lucid-evolution/lucid';
import { holdsSoleToken } from './identity-chain.js';
import type { DelegationUtxo, RecordUtxo } from './identity-chain.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { TooManyOutputs, koiosCredentialPage, koiosCredentialUtxos } from './marketplace-indexer.js';
import type { KoiosUtxo } from './marketplace-indexer.js';

/** What a read works with: the node, the deployment, and Koios (lists of outputs, transactions and the tip). */
export interface LedgerEnv {
  provider: Provider;
  deployment: IdentityDeployment;
  koiosUrl: string;
  fetchImpl: typeof fetch;
  /** How long one call of a tool may run, in ms (default READ_BUDGET_MS). A test hands in a short one. */
  budgetMs?: number;
}

/** The most rows of a list that one call returns. */
export const MAX_PAGE = 50;
/** The rows of a list that one call returns when it names no limit. */
export const DEFAULT_PAGE = 20;
/** Koios pages at 1,000 rows. A page of 500 stays below that cap and keeps a full read of a credential to a few requests. */
const KOIOS_PAGE = 500;
/** The most bytes of one Koios answer that a read accepts. A page of 500 rows is about 2 MB, so this is eight times what a page needs. */
export const KOIOS_ANSWER_BYTES = 16 * 1024 * 1024;
/** The longest that one call of a tool may run. The call ends with an error once it is spent (withinBudget). */
export const READ_BUDGET_MS = 30_000;

/** The call has spent its time (READ_BUDGET_MS). It ends the whole call: a read that catches the errors of single rows lets this one pass. */
export class BudgetSpent extends Error {
  constructor(readonly budgetMs: number) {
    super(`The call ran for ${budgetMs / 1000} s and stopped: the node or Koios answers too slowly, or the read needs too many requests. Retry in a minute. A list can ask for fewer rows (limit).`);
    this.name = 'BudgetSpent';
  }
}

/**
 * What one call keeps between its reads: each delegation link and each identity record once (a chain and its ancestors share
 * records), and the check of the time that the call may still use. The maps hold the reads, so a read that is in progress is shared too.
 */
export interface ReadSession {
  links: Map<string, Promise<DelegationUtxo | null>>;
  records: Map<string, Promise<RecordUtxo>>;
  /** Throws BudgetSpent once the budget of the call is spent. A read calls it before each step of a loop that makes no request of its own. */
  check: () => void;
}

/**
 * Runs `work` inside the budget of one call, and ends the whole call with BudgetSpent once the budget is spent, whatever request is
 * pending. `work` gets the env of the call and its session. In that env the node and the fetch check the budget before each request, so
 * that no request starts after the end, and each fetch carries one signal that the end of the budget aborts, so that a Koios request that
 * is open stops. A node request that is already open does not stop: it ends by the time limit of its HTTP client, and that can be minutes.
 * The work that lost the race goes on until its next request or `session.check()`, and then it stops with BudgetSpent. The provider of the
 * env is shared by all tools, and this function does not change it.
 */
export async function withinBudget<T>(env: LedgerEnv, work: (inside: LedgerEnv, session: ReadSession) => Promise<T>): Promise<T> {
  const budget = env.budgetMs ?? READ_BUDGET_MS;
  const started = Date.now();
  const stop = new AbortController();
  const check = (): void => {
    if (stop.signal.aborted || Date.now() - started >= budget) { stop.abort(); throw new BudgetSpent(budget); }
  };
  // Each method of the node checks the budget, then calls the shared provider: a node request has no signal to carry.
  const provider = new Proxy(env.provider, {
    get(target, name) {
      const member: unknown = Reflect.get(target, name);
      return typeof member === 'function' ? async (...args: unknown[]) => { check(); return member.apply(target, args); } : member;
    },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    check();
    return env.fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, stop.signal]) : stop.signal });
  };
  let timer: NodeJS.Timeout | undefined;
  const spent = new Promise<never>((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(new BudgetSpent(budget)); }, budget); });
  try {
    return await Promise.race([work({ ...env, provider, fetchImpl }, { links: new Map(), records: new Map(), check }), spent]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Koios rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const HASH = /^[0-9a-f]{64}$/;
const POLICY = /^[0-9a-f]{56}$/;
const NAME = /^(?:[0-9a-f]{2})*$/;
const DIGITS = /^[0-9]+$/;

/**
 * A Koios row (`utxo_info`, `credential_utxos` or `asset_utxos` with extended rows) as the node's output: its lovelace, its tokens and
 * its inline datum. Null for a row that has no output reference, address or amount, or a token that is not well formed: Koios is
 * a witness that the caller checks, and the read skips what it cannot use. A row with no asset list at all is an error, not an output
 * without tokens: Koios gives the list only with the extended fields, so the answer is incomplete.
 */
export function utxoOfKoiosRow(row: KoiosUtxo | null | undefined): UTxO | null {
  if (row === null || typeof row !== 'object') return null;
  const txHash = typeof row.tx_hash === 'string' ? row.tx_hash.toLowerCase() : '';
  if (!HASH.test(txHash) || !Number.isSafeInteger(row.tx_index) || row.tx_index < 0) return null;
  if (typeof row.address !== 'string' || row.address === '' || typeof row.value !== 'string' || !DIGITS.test(row.value)) return null;
  const assets: Record<string, bigint> = { lovelace: BigInt(row.value) };
  if (row.asset_list === undefined || row.asset_list === null) throw new Error(`Koios gave the output ${txHash}#${row.tx_index} with no asset list: the answer is incomplete, so its tokens are unknown`);
  if (!Array.isArray(row.asset_list)) return null;
  for (const entry of row.asset_list) {
    const token = entry as { policy_id?: unknown; asset_name?: unknown; quantity?: unknown } | null;
    const policy = typeof token?.policy_id === 'string' ? token.policy_id.toLowerCase() : '';
    const name = token?.asset_name === null || token?.asset_name === undefined ? '' : typeof token.asset_name === 'string' ? token.asset_name.toLowerCase() : null;
    if (!POLICY.test(policy) || name === null || !NAME.test(name) || typeof token?.quantity !== 'string' || !DIGITS.test(token.quantity)) return null;
    assets[`${policy}${name}`] = (assets[`${policy}${name}`] ?? 0n) + BigInt(token.quantity);
  }
  const datum = row.inline_datum?.bytes;
  return {
    txHash, outputIndex: row.tx_index, address: row.address, assets,
    datumHash: typeof row.datum_hash === 'string' ? row.datum_hash : null, datum: typeof datum === 'string' && datum !== '' ? datum.toLowerCase() : null, scriptRef: null,
  };
}

/**
 * The name of the token that makes `utxo` authentic (Part 2 Sections 4.1 and 5.2): `utxo` is at exactly `address` and holds exactly
 * one token of `policy`, in quantity 1. Null for any other output.
 */
export function soleTokenName(utxo: UTxO, address: string, policy: string): string | null {
  const tokens = Object.keys(utxo.assets).filter((unit) => unit.startsWith(policy));
  if (tokens.length !== 1) return null;
  const name = tokens[0].slice(policy.length);
  return holdsSoleToken(utxo, address, policy, name) ? name : null;
}

/** How `credentialOutputs` narrows the read on the server: by bytes inside the inline datum, by a token policy, or both. */
export interface CredentialFilter {
  /** Hex that the inline datum must contain. A coarse filter: a 32-byte value also appears in other fields, and a datum that writes the value as chunks of bytes does not match it. */
  datumContains?: string;
  /** The policy (56 hex) of a token that the output must hold. Exact: it needs no check of the datum. */
  assetPolicy?: string;
}

/** More outputs match one read than a call reads (the cap of koiosCredentialUtxos). The read is refused, and `narrow` says what to do. */
export class TooManyMatches extends Error {
  constructor(readonly maxRows: number, credential: string, narrow: string) {
    super(`${maxRows} or more outputs match at the script ${credential}. ${narrow}`);
    this.name = 'TooManyMatches';
  }
}

/** The rows of Koios that read as outputs: a row that does not is left out (utxoOfKoiosRow). */
const outputsOf = (rows: KoiosUtxo[]): UTxO[] => rows.flatMap((row) => { const utxo = utxoOfKoiosRow(row); return utxo === null ? [] : [utxo]; });

/**
 * The unspent outputs at the payment credential `credential` (28 bytes, hex), read from Koios `credential_utxos` as pages of at
 * most KOIOS_ANSWER_BYTES each. `filter` narrows the read on the server. A datum filter is coarse, so the caller decodes each output
 * and checks the field itself. A row that Koios sends in a shape that cannot be read as an output is left out; a row with no asset
 * list makes the read fail (utxoOfKoiosRow). A read that matches too many outputs says what to do about it (`narrow`).
 */
export async function credentialOutputs(env: LedgerEnv, credential: string, filter: CredentialFilter, narrow: string): Promise<UTxO[]> {
  try {
    return outputsOf(await koiosCredentialUtxos(env.koiosUrl, credential, env.fetchImpl, { ...filter, pageSize: KOIOS_PAGE, maxPageBytes: KOIOS_ANSWER_BYTES }));
  } catch (err) {
    if (err instanceof TooManyOutputs) throw new TooManyMatches(err.maxRows, credential, narrow);
    throw err;
  }
}

/**
 * One page of the unspent outputs at the payment credential `credential`, as Koios lists them: `limit` rows from row `offset` of the list in
 * the order of the output reference, and whether more rows follow (koiosCredentialPage). It never reads the rest of the list, so it has no
 * limit on how many outputs match. A row that Koios sends in a shape that cannot be read as an output is left out, and a row with no asset
 * list makes the read fail (utxoOfKoiosRow). The `offset` counts rows of Koios, whether or not a row reads as an output.
 */
export async function credentialPage(env: LedgerEnv, credential: string, filter: CredentialFilter, offset: number, limit: number): Promise<{ outputs: UTxO[]; more: boolean }> {
  const { rows, more } = await koiosCredentialPage(env.koiosUrl, credential, env.fetchImpl, { ...filter, offset, limit, maxPageBytes: KOIOS_ANSWER_BYTES });
  return { outputs: outputsOf(rows), more };
}

/** The height of the newest block that Koios knows (GET tip). Errors name the operation and the status only. */
export async function koiosTipHeight(koiosUrl: string, fetchImpl: typeof fetch): Promise<number> {
  const res = await fetchImpl(`${koiosUrl.replace(/\/+$/, '')}/api/v1/tip`, {
    method: 'GET', headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Koios tip answered ${res.status}`);
  let body: unknown;
  try { body = await res.json(); } catch { throw new Error('Koios tip: response was not valid JSON'); }
  const height = (Array.isArray(body) ? body[0] as { block_height?: unknown } | undefined : undefined)?.block_height;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) throw new Error('Koios tip: the answer has no block height');
  return height;
}

// ─── Plutus Data in Koios' JSON form ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Plutus Data from the JSON form that Koios shows for a datum (`{ int }`, `{ bytes }`, `{ list }`, `{ map }` and `{ constructor,
 * fields }`). A transaction input shows its datum only in this form, so a decoder of Data reads it. Throws for any other shape.
 */
export function dataOfKoiosJson(json: unknown): Data {
  if (json === null || typeof json !== 'object') throw new Error('not a Plutus Data value');
  const v = json as Record<string, unknown>;
  // `constructor` is also a property of every object, so the form is read from the own keys only.
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(v, key);
  if (has('int')) {
    if (typeof v.int !== 'number' && typeof v.int !== 'string') throw new Error('an int is not a number');
    return BigInt(v.int);
  }
  if (has('bytes')) {
    if (typeof v.bytes !== 'string' || !NAME.test(v.bytes.toLowerCase())) throw new Error('bytes are not hex');
    return v.bytes.toLowerCase();
  }
  if (has('list')) {
    if (!Array.isArray(v.list)) throw new Error('a list is not an array');
    return v.list.map(dataOfKoiosJson);
  }
  if (has('map')) {
    if (!Array.isArray(v.map)) throw new Error('a map is not an array');
    return new Map(v.map.map((e: { k?: unknown; v?: unknown }) => [dataOfKoiosJson(e.k), dataOfKoiosJson(e.v)] as [Data, Data]));
  }
  if (has('constructor') && Array.isArray(v.fields)) {
    const index = Number(v.constructor);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('a constructor has no index');
    return new Constr(index, v.fields.map(dataOfKoiosJson));
  }
  throw new Error('not a Plutus Data value');
}

// ─── Paging ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A page of a list: `nextOffset` is where the next page starts, or null at the end. */
export interface Page<T> { items: T[]; total: number; offset: number; limit: number; nextOffset: number | null }

/** Refuses an offset or a limit that does not name a page: a read checks them before it asks Koios for anything. */
export function checkPage(offset = 0, limit = DEFAULT_PAGE): void {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a whole number of at least 0');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Error(`limit must be a whole number from 1 to ${MAX_PAGE}`);
}

/** The page of `all` that starts at `offset` and holds at most `limit` rows. */
export function pageOf<T>(all: readonly T[], offset = 0, limit = DEFAULT_PAGE): Page<T> {
  checkPage(offset, limit);
  const items = all.slice(offset, offset + limit);
  const end = offset + items.length;
  return { items, total: all.length, offset, limit, nextOffset: end < all.length ? end : null };
}
