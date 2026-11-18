// packages/builder/src/vector/reputation-read.ts
// Reads the stakes of agents on the identity-era Module-3 deployment from Koios, with one asset_utxos call for any number of agents. The
// stake token of an agent has a name that anybody can compute from the agent's identifier (reputation-datum.ts stakeTokenName), so no
// scan of the stake address is needed. An agent can have more than one stake: the result lists each one, and `total` is the sum of their
// `stake_amount` (the amount that the datum counts, which can be less than the AP3X in the output). An agent with no stake has the total 0.
//
// This file imports only reputation-datum.ts (which imports only Lucid's Data codec and blake2b), so that another repository can copy both
// files. Only a spent output and an output at another address are no stake. Any other row that Koios returns for a stake token must be a
// readable stake, or the read fails with an error that names the output: a read that skipped it would report less stake than there is.
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, decodeStakeDatum, outRefText, stakeTokenName, stakeTokenUnit } from './reputation-datum.js';

/** The most agents that one read takes (one Koios call). */
export const MAX_AGENTS_PER_READ = 50;

/** One stake output, as the chain holds it now. */
export interface StakeRead {
  /** `<txid>#<index>` of the stake output. It changes with each action on the stake. */
  ref: string;
  /** AP3X base units that the stake counts (the datum's `stake_amount`). */
  stakeAmount: bigint;
  /** The AP3X base units in the output (at least `stakeAmount`). */
  lovelace: bigint;
  /** The staked capabilities as text (`0x` and hex for bytes that are not UTF-8). */
  capabilities: string[];
  /** POSIX ms of the last action of the owner. */
  lastUpdated: number;
  /** How many open challenges lock the stake. */
  challengeLocks: number;
  /** `<txid>#<index>` of the seed output that made the stake: it tells the stakes of one agent apart and never changes. */
  stakeId: string;
  /** The key hash of the owner credential. */
  ownerKeyHash: string;
  historyPoints: bigint;
}

export interface AgentStakes {
  /** The 64-hex identifier of the agent. */
  agentId: string;
  /** The stake token: the policy and the name. */
  tokenUnit: string;
  stakes: StakeRead[];
  /** The sum of `stakeAmount` over `stakes`; 0n when the agent has no stake. */
  total: bigint;
}

interface KoiosRow {
  tx_hash?: unknown; tx_index?: unknown; address?: unknown; value?: unknown; is_spent?: unknown;
  inline_datum?: { bytes?: unknown } | null;
  asset_list?: Array<{ policy_id?: unknown; asset_name?: unknown; quantity?: unknown }> | null;
}

const IDENTIFIER = /^[0-9a-f]{64}$/;

/** A capability as text for a person: UTF-8 when the bytes are, else `0x` and the hex. */
export function capabilityText(hex: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex')); } catch { return `0x${hex}`; }
}

/**
 * The stakes of `agentIds` (1 to 50 identifiers, each 64 lowercase hex characters) in the order given, each identifier once. One Koios
 * `asset_utxos` call. Errors name the operation and the status only, never the endpoint.
 */
export async function readStakes(koiosUrl: string, agentIds: readonly string[], fetchImpl: typeof fetch = fetch): Promise<AgentStakes[]> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) throw new Error('Name at least one agent.');
  if (ids.length > MAX_AGENTS_PER_READ) throw new Error(`Name at most ${MAX_AGENTS_PER_READ} agents in one read.`);
  const bad = ids.find((id) => !IDENTIFIER.test(id));
  if (bad !== undefined) throw new Error(`${JSON.stringify(bad.slice(0, 80))} is not an agent identifier (64 lowercase hex characters).`);

  const names = new Map(ids.map((id) => [stakeTokenName(id), id]));
  const res = await fetchImpl(`${koiosUrl.replace(/\/+$/, '')}/api/v1/asset_utxos`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-mcp-builder' },
    body: JSON.stringify({ _asset_list: [...names.keys()].map((name) => [REPUTATION_SCRIPT_HASH, name]), _extended: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Koios asset_utxos answered ${res.status}`);
  let body: unknown;
  try { body = await res.json(); } catch { throw new Error('Koios asset_utxos: the answer is not JSON'); }
  if (!Array.isArray(body)) throw new Error('Koios asset_utxos: Koios returned a non-list response');

  const byAgent = new Map<string, StakeRead[]>(ids.map((id) => [id, []]));
  const seen = new Set<string>();
  for (const entry of body as unknown[]) {
    if (entry === null || typeof entry !== 'object') throw new Error(`Koios asset_utxos returned a row that is not an object: ${String(JSON.stringify(entry)).slice(0, 80)}.`);
    const row = entry as KoiosRow;
    if (row.is_spent === true) continue;
    if (typeof row.tx_hash !== 'string' || !Number.isInteger(row.tx_index)) {
      throw new Error(`Koios asset_utxos returned a row with no readable output reference (tx_hash ${JSON.stringify(row.tx_hash)}, tx_index ${JSON.stringify(row.tx_index)}).`);
    }
    const ref = `${row.tx_hash.toLowerCase()}#${row.tx_index}`;
    if (typeof row.address !== 'string') throw new Error(`The Koios row of the output ${ref} has no address.`);
    if (row.address !== REPUTATION_ADDRESS || seen.has(ref)) continue;
    if (!Array.isArray(row.asset_list) || row.asset_list.length === 0) throw new Error(`The stake address output ${ref} has no asset list in the Koios answer.`);
    const held = row.asset_list.find((a) => a?.policy_id === REPUTATION_SCRIPT_HASH && typeof a.asset_name === 'string' && names.has(a.asset_name));
    if (!held) throw new Error(`The stake address output ${ref} holds none of the stake tokens that were asked for.`);
    const agent = names.get(held.asset_name as string) as string;
    if (String(held.quantity) !== '1') throw new Error(`The stake address output ${ref} holds ${String(held.quantity)} of the stake token of ${agent}, not 1.`);
    const hex = row.inline_datum?.bytes;
    if (typeof hex !== 'string') throw new Error(`The stake output ${ref} has no inline datum.`);
    let datum;
    try { datum = decodeStakeDatum(hex.toLowerCase()); } catch (err) { throw new Error(`The stake output ${ref} does not decode: ${err instanceof Error ? err.message : String(err)}.`); }
    if (datum.agent_did !== agent) throw new Error(`The stake output ${ref} holds the stake token of ${agent} but its datum names ${datum.agent_did}.`);
    if (typeof row.value !== 'string' || !/^\d+$/.test(row.value)) throw new Error(`The stake output ${ref} has no AP3X amount that can be read.`);
    seen.add(ref);
    byAgent.get(agent)!.push({
      ref, stakeAmount: datum.stake_amount, lovelace: BigInt(row.value), capabilities: datum.staked_capabilities.map(capabilityText), lastUpdated: datum.last_updated,
      challengeLocks: datum.challenge_locks.length, stakeId: outRefText(datum.stake_id), ownerKeyHash: datum.owner_pkh, historyPoints: datum.history_points,
    });
  }
  return ids.map((id) => {
    const stakes = byAgent.get(id)!.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return { agentId: id, tokenUnit: stakeTokenUnit(id), stakes, total: stakes.reduce((sum, s) => sum + s.stakeAmount, 0n) };
  });
}
