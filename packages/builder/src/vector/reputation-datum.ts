// packages/builder/src/vector/reputation-datum.ts
// The data of the Module-3 reputation validator on the identity-era deployment (vector-agent-modules Module-3/reputation-staking:
// lib/reputation_staking/types.ak, params.ak, config.ak, utils.ak): the 8-field stake datum, the stake token name, the two fields of the
// module parameters that a stake depends on, and the cross-validator references. This file imports only Lucid's Data codec and blake2b,
// so that another repository can copy it together with reputation-read.ts.
//
// The deployment: the reputation validator is one script, both the minting policy of the stake token and the payment credential of the
// stake address. Its values come from Module-3/deploy/identity/mainnet/deploy_state.json (read from Vector mainnet on 2026-11-18).
import { Constr, Data } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';

/** The reputation validator: the policy of the stake token and the script credential of the stake address. */
export const REPUTATION_SCRIPT_HASH = 'fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424';
/** The exact stake address: the script credential and no stake credential. Every stake output is at this address. */
export const REPUTATION_ADDRESS = 'addr1w8adj3dtyrmp5k8mma4r8285jxyeklw5zelmvssqhsrqgfqc9uavs';

const HEX = /^(?:[0-9a-f]{2})*$/;
const isHex = (value: unknown, bytes?: number): value is string =>
  typeof value === 'string' && HEX.test(value) && (bytes === undefined || value.length === bytes * 2);

/** An output reference as the datum holds it. */
export interface OutRef { txHash: string; outputIndex: number }
export const outRefText = (ref: OutRef): string => `${ref.txHash}#${ref.outputIndex}`;

/**
 * StakeDatum (types.ak): `Constr 0` with 8 fields, in this order. Bytes are lowercase hex.
 * - `agent_did`: the 32-byte identifier of the agent's identity record;
 * - `owner_pkh`: the key hash of the owner credential (a VerificationKey credential);
 * - `stake_amount`: AP3X in base units that the stake counts;
 * - `staked_capabilities`: the capabilities that the stake backs, UTF-8 bytes as hex;
 * - `last_updated`: POSIX ms, the upper bound of the validity range of the last owner action;
 * - `history_points`: points that the module adds;
 * - `challenge_locks`: the token names of the open challenges against the stake;
 * - `stake_id`: the output reference of the seed output that CreateStake spent. It never changes.
 */
export interface StakeDatum {
  agent_did: string;
  owner_pkh: string;
  stake_amount: bigint;
  staked_capabilities: string[];
  last_updated: number;
  history_points: bigint;
  challenge_locks: string[];
  stake_id: OutRef;
}

/** The stake_id that a seed (opening) output carries: CreateStake does not read it, and the new stake takes the seed's output reference. */
export const SEED_STAKE_ID: OutRef = { txHash: '00'.repeat(32), outputIndex: 0 };

/** The datum as Lucid's Data.to writes it, which is what the module's own encoders write (indefinite lists, smallest integers). */
export function encodeStakeDatum(d: StakeDatum): string {
  if (!isHex(d.agent_did, 32)) throw new Error('stake datum: agent_did must be 32 bytes of lowercase hex');
  if (!isHex(d.owner_pkh, 28)) throw new Error('stake datum: owner_pkh must be 28 bytes of lowercase hex');
  if (!d.staked_capabilities.every((c) => isHex(c)) || !d.challenge_locks.every((c) => isHex(c))) throw new Error('stake datum: a capability or a challenge lock is not lowercase hex');
  if (!isHex(d.stake_id.txHash, 32) || !Number.isSafeInteger(d.stake_id.outputIndex) || d.stake_id.outputIndex < 0) throw new Error('stake datum: stake_id is not an output reference');
  if (!Number.isSafeInteger(d.last_updated) || d.last_updated < 0) throw new Error('stake datum: last_updated must be a whole number of POSIX milliseconds');
  return Data.to(new Constr(0, [
    d.agent_did, new Constr(0, [d.owner_pkh]), d.stake_amount, d.staked_capabilities, BigInt(d.last_updated), d.history_points, d.challenge_locks,
    new Constr(0, [d.stake_id.txHash, BigInt(d.stake_id.outputIndex)]),
  ]));
}

/** The 8 fields of a stake datum. Refuses what is not exactly that shape (a datum of the earlier 6-field layout included). */
export function decodeStakeDatum(hex: string): StakeDatum {
  let c: Data;
  try { c = Data.from(hex); } catch { throw new Error('not a stake datum (not Plutus data)'); }
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 8) throw new Error('not a stake datum (expected constructor 0 with 8 fields)');
  const [did, owner, amount, caps, updated, history, locks, stakeId] = c.fields;
  if (!isHex(did, 32)) throw new Error('stake datum: agent_did is not 32 bytes');
  if (!(owner instanceof Constr) || owner.index !== 0 || owner.fields.length !== 1 || !isHex(owner.fields[0], 28)) throw new Error('stake datum: owner is not a verification-key credential');
  if (typeof amount !== 'bigint' || typeof updated !== 'bigint' || typeof history !== 'bigint') throw new Error('stake datum: an integer field is not an integer');
  if (updated < 0n || updated > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('stake datum: last_updated is not a time');
  if (!Array.isArray(caps) || !caps.every((x) => isHex(x))) throw new Error('stake datum: staked_capabilities is not a list of bytes');
  if (!Array.isArray(locks) || !locks.every((x) => isHex(x))) throw new Error('stake datum: challenge_locks is not a list of bytes');
  if (!(stakeId instanceof Constr) || stakeId.index !== 0 || stakeId.fields.length !== 2 || !isHex(stakeId.fields[0], 32) || typeof stakeId.fields[1] !== 'bigint'
    || stakeId.fields[1] < 0n || stakeId.fields[1] > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('stake datum: stake_id is not an output reference');
  }
  return {
    agent_did: did, owner_pkh: owner.fields[0] as string, stake_amount: amount, staked_capabilities: caps as string[], last_updated: Number(updated),
    history_points: history, challenge_locks: locks as string[], stake_id: { txHash: stakeId.fields[0] as string, outputIndex: Number(stakeId.fields[1]) },
  };
}

/** The stake token's asset name: "rstk_" + the first 27 bytes of blake2b-256 of the 32 identifier bytes (utils.ak derive_stake_token_name). */
export function stakeTokenName(agentIdHex: string): string {
  if (!isHex(agentIdHex, 32)) throw new Error('an agent identifier is 32 bytes: 64 lowercase hex characters');
  const digest = Buffer.from(blake2b(Buffer.from(agentIdHex, 'hex'), { dkLen: 32 })).toString('hex');
  return Buffer.from('rstk_', 'utf-8').toString('hex') + digest.slice(0, 54);
}
/** The stake token of an agent as one asset unit: the policy and the name. */
export const stakeTokenUnit = (agentIdHex: string): string => REPUTATION_SCRIPT_HASH + stakeTokenName(agentIdHex);

/** The two fields of ProtocolParams (params.ak) that a stake action depends on. Both are in the units of the validity range: AP3X base units and POSIX ms. */
export interface StakeParams { minSelfStake: bigint; stakeCooldown: bigint }
/** The number of fields of the deployed ProtocolParams record. */
export const PARAMS_FIELD_COUNT = 22;

/** `min_self_stake` (field 0) and `stake_cooldown` (field 3) of the 22-field parameters record. */
export function decodeStakeParams(hex: string): StakeParams {
  let c: Data;
  try { c = Data.from(hex); } catch { throw new Error('not the module parameters datum (not Plutus data)'); }
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== PARAMS_FIELD_COUNT) throw new Error(`not the module parameters datum (expected constructor 0 with ${PARAMS_FIELD_COUNT} fields)`);
  const [min, , , cooldown] = c.fields;
  if (typeof min !== 'bigint' || typeof cooldown !== 'bigint' || min <= 0n || cooldown < 0n) throw new Error('module parameters: min_self_stake must be a positive integer and stake_cooldown a whole number');
  return { minSelfStake: min, stakeCooldown: cooldown };
}

/** The cross-validator references datum (config.ak CrossValidatorRefs): the reputation and the endorsement script hashes. */
export function decodeCrossRefs(hex: string): { reputation: string; endorsement: string } {
  let c: Data;
  try { c = Data.from(hex); } catch { throw new Error('not the cross-validator references datum (not Plutus data)'); }
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 2 || !isHex(c.fields[0], 28) || !isHex(c.fields[1], 28)) throw new Error('not the cross-validator references datum');
  return { reputation: c.fields[0], endorsement: c.fields[1] };
}
