// packages/builder/src/vector/reputation-build.ts
// Keyless builders of an agent's reputation self-stake on the identity-era Module-3 deployment: the two steps that make a stake (the
// opening output, then CreateStake), and the three owner actions on a stake (IncreaseStake, UpdateCapabilities, DecreaseStake). Every builder
// returns UNSIGNED CBOR with every key hash that must sign it (identity-chain.ts SignedByBuild); nothing here signs or submits. The plan
// functions are pure: they decide what a transaction must say, so the same values can be shown before signing and unit-tested without a chain.
//
// The rules come from the deployed validator (vector-agent-modules Module-3/reputation-staking: validators/reputation.ak and
// lib/reputation_staking/stake_validation.ak, utils.ak). Each builder checks them before it builds, so that a refusal names the rule
// instead of ending in a script failure, and then Lucid runs the deployed script (the reference script output) on the transaction:
//   Every action has a validity window of at most one hour (shared/identity.window). `last_updated` of the new datum is its upper bound `hi`,
//   and the cooldown compares `last_updated` with the lower bound `lo` of a later transaction (so it cannot be shorter than stake_cooldown).
//   CreateStake    the record of the agent is Active over [lo, hi] (parents included) and lists each staked capability; its controller signs;
//                  owner_credential is a declared credential of the record (the controller key, or a listed Ed25519 key with the transaction
//                  purpose) and signs; the transaction mints exactly the stake token and spends one seed (opening) output that holds no
//                  reputation token; stake_amount is at least min_self_stake; the stake output is at the exact address; last_updated = hi;
//                  no history points, no challenge locks; stake_id is the output reference of the seed.
//   IncreaseStake  the same record check, for the capabilities that the stake backs; the controller and the owner sign; the datum changes
//                  only in stake_amount (larger) and last_updated; the output holds the stake token and at least the AP3X that it counts.
//   UpdateCapabilities  the record is Active and lists each NEW capability (not empty); the cooldown is over at lo; no challenge locks the
//                  stake; the controller and the owner sign; the datum changes only in the capabilities and last_updated.
//   DecreaseStake  an exit: the controller signs (the record can have any status); the owner key need not sign; at least min_self_stake stays;
//                  the cooldown is over at lo; no challenge locks the stake; the outputs to the payee hold at least the amount. The payee is
//                  the stake's owner credential while the record still declares it, else the controller key.
// The deployment values are inlined (the Docker image ships only build/): see the constants below and test/reputation-datum.test.ts, which
// pins each one to the captured chain data. The parameters and the cross references are found by their tokens at the params holder, as the
// validator finds them; only the reference script is pinned by its output reference.
import { CML, Constr, Data, calculateMinLovelaceFromUTxO, credentialToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { ensureSlotConfig, ChainClockError } from './gov-build.js';
import type { SlotClockProvider } from './gov-build.js';
import { didOf, findSoleTokenOutput, recordWithAncestors, recordsById, signedByResult, uniqueUtxos, walletOf, windowAt, SignerList } from './identity-chain.js';
import type { RecordUtxo, SignedByBuild, Window } from './identity-chain.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';
import type { IdentityDatum } from './identity-codec.js';
import { textOf, utf8Hex } from './identity-codec.js';
import { decodeTransaction } from './guarded-decode.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { PURPOSE, activeKey, effectiveStatus, hasCapability, keyHashOf } from './identity-rules.js';
import { windowWithin } from './jury-chain.js';
import { reserveCollateralInputs } from './marketplace-build.js';
import { formatOutRef, parseOutRef } from './marketplace-datum.js';
import { nodeFailure } from './marketplace-lineage.js';
import { cell, isoOrRaw } from './marketplace-shared.js';
import {
  REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, SEED_STAKE_ID, decodeCrossRefs, decodeStakeDatum, decodeStakeParams, encodeStakeDatum, stakeTokenUnit,
} from './reputation-datum.js';
import type { StakeDatum, StakeParams } from './reputation-datum.js';
import { capabilityText } from './reputation-read.js';


// ─── Deployment (Vector mainnet) ───────────────────────────────────────────
// From vector-agent-modules Module-3/deploy/identity/mainnet/deploy_state.json (the deployment of 2026-11-03), each value checked against
// the live chain on 2026-11-18 (Koios utxo_info: the four outputs below are unspent and hold what is named here). Inlined, as the
// marketplace's values are: the Docker image ships only build/. REPUTATION_SCRIPT_HASH and REPUTATION_ADDRESS are in reputation-datum.ts.

/** The UTxO that carries the reputation validator as a reference script (deploy_state tx_hashes.reputation_spend_ref). */
export const REPUTATION_REF_SCRIPT_UTXO = { txHash: '0add1592bdf312fede7f66c48835dee17638af884d37e7246b2bab7e01752ae0', outputIndex: 0 };
/** The params holder (deploy_state): the module's parameters and cross references sit at its address, each with its record token. */
export const REPUTATION_PARAMS_HOLDER_HASH = 'bb9e647e6ea974753c0b61ff2330dcf7a27710e954ca460b1aeb24c5';
export const REPUTATION_PARAMS_HOLDER_ADDRESS = credentialToAddress('Mainnet', { type: 'Script', hash: REPUTATION_PARAMS_HOLDER_HASH });
/** The policy of the record token `params` and its asset name (UTF-8 "params"): the validator accepts a parameters output only with this token. */
export const REPUTATION_PARAMS_TOKEN_POLICY = '8295dad015ecba3d5f7b346083d0c879794ab065b1c7ec1a533f2657';
export const PARAMS_TOKEN_NAME = '706172616d73';
/** The record token of the cross-validator references (policy REPUTATION_REFS_TOKEN_POLICY, UTF-8 name "reputation_refs"): the validator finds them by it at any reference. */
export const REFS_TOKEN_NAME = '72657075746174696f6e5f72656673';
export const REPUTATION_REFS_TOKEN_POLICY = '78d0c5547001110c61bcafb143d1c332b7427d91b9ce3f9dbb8d364a';
/** The endorsement validator of the deployment, which the cross references name next to the reputation validator. */
export const ENDORSEMENT_SCRIPT_HASH = '21ac1502ba7bab74e98ef3ad256bba1622a1351934ac19d0432126fe';
/** The identity registry that the reputation validator reads (the `identity_hash` of its configuration): records are found at its address. */
export const REPUTATION_IDENTITY_HASH = 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762';
/** Vector mainnet's chain start, POSIX ms. The deployment is on mainnet only, so a node with another chain start is refused. */
export const VECTOR_MAINNET_ZERO_TIME_MS = 1_756_485_600_000;

/** What step 1 locks at least, and the stake_amount its datum names: the reference SDK's opening output (client.py, min_lovelace = 2_000_000). */
export const STAKE_OPENING_LOVELACE = 2_000_000n;
/** What the fees of the two steps are allowed together when step 1 checks that the wallet can go on to make the stake. */
export const STAKE_FEE_ALLOWANCE_LOVELACE = 1_500_000n;

/** Redeemers (types.ak): StakeAction CreateStake 0, IncreaseStake 1, DecreaseStake 2 { amount }, UpdateCapabilities 3 { new_capabilities }; StakeMintAction MintStakeToken 0. */
export const CREATE_STAKE_REDEEMER = Data.to(new Constr(0, []));
export const MINT_STAKE_TOKEN_REDEEMER = Data.to(new Constr(0, []));
export const INCREASE_STAKE_REDEEMER = Data.to(new Constr(1, []));
export const decreaseStakeRedeemer = (amount: bigint): string => Data.to(new Constr(2, [amount]));
export const updateCapabilitiesRedeemer = (capabilities: string[]): string => Data.to(new Constr(3, [capabilities]));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const ada = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} AP3X`;
const refText = (r: { txHash: string; outputIndex: number }): string => formatOutRef(r.txHash, r.outputIndex);
const hoursText = (ms: bigint | number): string => `${Number(ms) / 3_600_000} h`;

// ─── The agent, the registry and the chain ─────────────────────────────────

/** The identifier of an identity DID (`did:vector:<64 lowercase hex>`; the bare identifier also works). A DID of the legacy registry is refused. */
export function stakeAgentId(did: string): string {
  const value = String(did).trim();
  const legacy = /^did:vector:agent:[0-9a-f]{56}:([0-9a-f]{64})$/.exec(value);
  if (legacy) {
    throw new Error(`${cell(value, 160)} is a DID of the legacy registry. The stake tools take an identity DID, did:vector:<64 lowercase hex>. Adopt the agent into the identity registry first; its identity DID is then did:vector:${legacy[1]}.`);
  }
  const m = /^(?:did:vector:)?([0-9a-f]{64})$/.exec(value);
  if (!m) throw new Error(`${cell(value, 160)} is not an identity DID: expected did:vector:<64 lowercase hex>.`);
  return m[1];
}

/** Refuses a server whose identity registry is not the one that the reputation validator reads: its stakes would not find the agent's record. */
export function assertIdentityRegistry(deployment: IdentityDeployment): void {
  if (deployment.identity.hash !== REPUTATION_IDENTITY_HASH) {
    throw new Error(`This server's identity registry (policy ${deployment.identity.hash}) is not the registry that the Module-3 reputation validator reads (policy ${REPUTATION_IDENTITY_HASH}): the validator would not find the agent's record. Nothing was built.`);
  }
}

/**
 * Sets Lucid's slot clock from the node, and refuses a node whose chain start is not Vector mainnet's: the deployment is on mainnet only,
 * and a validity range from another clock would give `last_updated` a time that the ledger does not share.
 */
export async function assertVectorMainnet(provider: Provider): Promise<void> {
  let zeroTime: number;
  try { zeroTime = await ensureSlotConfig(provider as unknown as SlotClockProvider); } catch (err) {
    throw err instanceof ChainClockError ? err : new Error(`Could not read the chain clock from the node: ${nodeFailure(err)}`);
  }
  if (zeroTime !== VECTOR_MAINNET_ZERO_TIME_MS) {
    throw new Error(`The node reports a chain start of ${isoOrRaw(zeroTime)}, not Vector mainnet's ${isoOrRaw(VECTOR_MAINNET_ZERO_TIME_MS)}. The Module-3 reputation deployment is on Vector mainnet only; nothing was built.`);
  }
}

// ─── Module outputs ────────────────────────────────────────────────────────

export interface ModuleReferences { script: UTxO; params: UTxO; crossRefs: UTxO; stakeParams: StakeParams }

/**
 * The three module outputs every stake action reads (the reference script, the parameters, the cross references), read from the node and
 * checked as the validator checks them. The validator finds the parameters and the cross references by their record tokens (`params` and
 * `reputation_refs`) at any reference, so an output that the params holder publishes anew with the same token must be found at once: this
 * server finds each one by its token at the holder address, and never uses an output of that address that lacks the token. Only the
 * reference script is pinned by its output reference. The parameters have the deployed 22-field datum; the cross references name the
 * reputation and endorsement hashes of this deployment.
 */
export async function readModuleReferences(provider: Provider): Promise<ModuleReferences> {
  let script: UTxO | undefined;
  try { [script] = await provider.getUtxosByOutRef([REPUTATION_REF_SCRIPT_UTXO]); } catch (err) { throw new Error(`Could not read the reputation module's reference script from the node: ${nodeFailure(err)}`); }
  if (!script) throw new Error(`The reputation module's reference script ${refText(REPUTATION_REF_SCRIPT_UTXO)} is not on the ledger. This server pins that output by its reference, so it needs a new release when the module publishes the script again. Nothing was built.`);
  if (!script.scriptRef || validatorToScriptHash(script.scriptRef) !== REPUTATION_SCRIPT_HASH) throw new Error(`The output ${refText(REPUTATION_REF_SCRIPT_UTXO)} does not carry the reputation validator; nothing was built.`);
  const byToken = async (policy: string, name: string, what: string): Promise<UTxO> => {
    let found: UTxO | null;
    try { found = await findSoleTokenOutput(provider, REPUTATION_PARAMS_HOLDER_ADDRESS, policy, name); } catch (err) { throw new Error(`Could not read the reputation module's ${what} from the node: ${nodeFailure(err)}`); }
    if (!found) throw new Error(`The node lists no output at the params holder ${REPUTATION_PARAMS_HOLDER_ADDRESS} that holds the token ${policy}${name}, the record token of the reputation module's ${what}. Nothing was built.`);
    return found;
  };
  const params = await byToken(REPUTATION_PARAMS_TOKEN_POLICY, PARAMS_TOKEN_NAME, 'parameters');
  if (!params.datum) throw new Error(`The parameters output ${refText(params)} has no inline datum; nothing was built.`);
  let stakeParams: StakeParams;
  try { stakeParams = decodeStakeParams(params.datum); } catch (err) { throw new Error(`The module's parameters at ${refText(params)} could not be read (${errorText(err)}); nothing was built.`); }
  const crossRefs = await byToken(REPUTATION_REFS_TOKEN_POLICY, REFS_TOKEN_NAME, 'cross-validator references');
  let named: { reputation: string; endorsement: string } | undefined;
  try { named = crossRefs.datum ? decodeCrossRefs(crossRefs.datum) : undefined; } catch { /* refused below */ }
  if (named?.reputation !== REPUTATION_SCRIPT_HASH || named.endorsement !== ENDORSEMENT_SCRIPT_HASH) {
    throw new Error(`The cross-validator references at ${refText(crossRefs)} do not name this deployment's reputation and endorsement validators; nothing was built.`);
  }
  return { script, params, crossRefs, stakeParams };
}

// ─── What the stake address holds for an agent ─────────────────────────────

/** A stake output or an opening output of an agent: its UTxO, its decoded datum and its reference. */
export interface StakeOut { utxo: UTxO; datum: StakeDatum; ref: string }

/**
 * What the reputation address holds for an agent, from the node: its stakes (the outputs at the exact address that hold its stake token;
 * the module allows more than one) and its opening outputs (lovelace only, with a stake datum that names the agent). A stake whose datum
 * does not decode is an error: it cannot exist, and a read that skipped it could build a second stake.
 */
export async function agentOutputs(provider: Provider, agentId: string): Promise<{ stakes: StakeOut[]; openings: StakeOut[] }> {
  const unit = stakeTokenUnit(agentId);
  let utxos: UTxO[];
  try { utxos = await provider.getUtxos(REPUTATION_ADDRESS); } catch (err) { throw new Error(`Could not read the reputation address from the node: ${nodeFailure(err)}`); }
  const stakes: StakeOut[] = [];
  const openings: StakeOut[] = [];
  for (const utxo of utxos) {
    const ref = refText(utxo);
    if ((utxo.assets[unit] ?? 0n) > 0n) {
      if (!utxo.datum) throw new Error(`The stake output ${ref} of the agent has no inline datum; nothing was built.`);
      let datum: StakeDatum;
      try { datum = decodeStakeDatum(utxo.datum); } catch (err) { throw new Error(`The stake output ${ref} of the agent does not decode (${errorText(err)}); nothing was built.`); }
      stakes.push({ utxo, datum, ref });
    } else if (utxo.datum && Object.keys(utxo.assets).every((k) => k === 'lovelace')) {
      try {
        const datum = decodeStakeDatum(utxo.datum);
        if (datum.agent_did === agentId) openings.push({ utxo, datum, ref });
      } catch { /* not a stake datum: not an opening output */ }
    }
  }
  return { stakes, openings };
}

/** The stake that an action works on: the one that `stakeRef` names, else the agent's only stake. */
export function pickStake(stakes: StakeOut[], did: string, stakeRef?: string): StakeOut {
  if (stakeRef !== undefined) {
    const parsed = parseOutRef(stakeRef);
    const ref = refText(parsed);
    const found = stakes.find((s) => s.ref === ref);
    if (!found) throw new Error(`${ref} is not a stake of ${did}${stakes.length === 0 ? ', which has no stake' : `; its stakes: ${stakes.map((s) => s.ref).join(', ')}`}.`);
    return found;
  }
  if (stakes.length === 0) throw new Error(`${did} has no stake on the Module-3 reputation deployment. Make one with vector_build_reputation_stake_open and vector_build_reputation_stake.`);
  if (stakes.length > 1) throw new Error(`${did} has ${stakes.length} stakes (${stakes.map((s) => s.ref).join(', ')}); name the one to use in stake_ref.`);
  return stakes[0];
}

// ─── The rules of the identity registry that a stake action meets ──────────

/** The capabilities as text, for a person reading a refusal. */
export const capabilityList = (hexes: string[]): string => hexes.map((h) => cell(textOf(h) ?? `0x${h}`, 64)).join(', ') || '(none)';

/**
 * Pure. The record of the agent is Active over the whole window, parents included (`vector_identity.effective`): no hold in force, an
 * Accountable Party that covers [lo, hi], and an Active parent for a subagent. CreateStake, IncreaseStake and UpdateCapabilities need it.
 */
export function assertActive(chain: RecordUtxo[], window: Window): void {
  const [self, ...ancestors] = chain;
  const did = didOf(self.id);
  let status: string;
  try { status = effectiveStatus(self.record, recordsById(ancestors), window.lo, window.hi); } catch (err) { throw new Error(`The status of ${did} cannot be found: ${errorText(err)}. Nothing was built.`); }
  if (status !== 'Active') {
    throw new Error(`${did} is ${status} over the validity window ${isoOrRaw(window.lo)} to ${isoOrRaw(window.hi)}. This action needs a record whose effective status is Active over the whole window: no hold in force, an Accountable Party that covers the window, and Active parents for a subagent (a smaller valid_minutes keeps the window short when a party ends soon). Nothing was built.`);
  }
}

/** Pure. Each capability is one the record lists, byte for byte (`has_capability`). */
export function assertListsCapabilities(record: IdentityDatum, capabilities: string[], did: string): void {
  const missing = capabilities.filter((c) => !hasCapability(record, c));
  if (missing.length > 0) {
    throw new Error(`Capability ${capabilityList(missing)} is not in the record of ${did}, which lists: ${capabilityList(record.capabilities)}. The validator accepts only capabilities that the record lists, byte for byte.`);
  }
}

/** Pure. The owner key is a declared credential of the record: its controller key, or a listed Ed25519 key with the transaction purpose (`declared_credential`). */
export function assertDeclaredOwner(record: IdentityDatum, ownerKeyHash: string, did: string): void {
  if (!isDeclared(record, ownerKeyHash)) {
    throw new Error(`The owner key ${ownerKeyHash} is not a declared key of ${did}: it is neither the controller key nor a key that the record lists with the transaction purpose. Pass owner_key_hash with the controller key or with a key that the record lists with the transaction purpose. Nothing was built.`);
  }
}
const isDeclared = (record: IdentityDatum, keyHash: string): boolean => keyHash === keyHashOf(record.controller) || activeKey(record, keyHash, PURPOSE.transaction);

/**
 * Pure. The capabilities a stake names, as the bytes the datum holds: at least one, none twice, each one the record lists (CreateStake and
 * UpdateCapabilities compare bytes, so the text must be the record's exactly).
 */
export function stakedCapabilities(requested: unknown, record: IdentityDatum, did: string): string[] {
  if (!Array.isArray(requested) || requested.length === 0) throw new Error('Name at least one capability to stake on.');
  const out: string[] = [];
  for (const cap of requested) {
    if (typeof cap !== 'string' || cap.length === 0) throw new Error('Each capability must be non-empty text.');
    const hex = utf8Hex(cap);
    if (out.includes(hex)) throw new Error(`Capability ${cell(cap)} is named twice.`);
    out.push(hex);
  }
  assertListsCapabilities(record, out, did);
  return out;
}

/** The payee of a payout to a stake of owner `ownerKeyHash` (`utils.record_payee`): the owner while the record declares it, else the controller key. */
export function payeeOf(record: IdentityDatum, ownerKeyHash: string): { keyHash: string; reason: 'owner' | 'controller' } {
  return isDeclared(record, ownerKeyHash) ? { keyHash: ownerKeyHash, reason: 'owner' } : { keyHash: keyHashOf(record.controller), reason: 'controller' };
}

/** The signers of an action: the controller of the record, the owner of the stake when the action needs it, and (added by signedByResult) the wallet. */
export function stakeSigners(controllerKeyHash: string, did: string, ownerKeyHash?: string): SignerList {
  const signers = new SignerList().add(controllerKeyHash, `controller of ${did} (the validator reads controller_signed)`);
  if (ownerKeyHash !== undefined) signers.add(ownerKeyHash, 'owner of the stake (the validator reads owner_credential)');
  return signers;
}

/** The earliest lower bound of a later owner action that changes the stake (UpdateCapabilities, DecreaseStake): `last_updated` plus the cooldown. */
export const readyAt = (lastUpdated: number, params: StakeParams): number => lastUpdated + Number(params.stakeCooldown);

/** The validity window of an action that needs the cooldown to be over at its lower bound. `Too early` names the time to build again. */
export function cooldownWindow(nowMs: number, validMinutes: number | undefined, stake: StakeDatum, params: StakeParams): Window {
  const at = readyAt(stake.last_updated, params);
  return windowWithin(nowMs, validMinutes, { at, why: `the stake changed at ${isoOrRaw(stake.last_updated)} and its cooldown of ${hoursText(params.stakeCooldown)} (stake_cooldown) ends at ${isoOrRaw(at)}` }, null);
}

/** The ledger's price of a byte of an output (coins per UTxO byte), from the protocol parameters that Lucid read from the node. */
export function coinsPerUtxoByteOf(lucid: LucidEvolution): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of an output is unknown.');
  return coinsPerUtxoByte;
}

/** The ledger minimum of an output at `address` holding `assets` (lovelace aside) and the inline `datumHex`. */
export function minimumOf(lucid: LucidEvolution, address: string, assets: Record<string, bigint> = {}, datumHex?: string): bigint {
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByteOf(lucid), { txHash: '00'.repeat(32), outputIndex: 0, address, assets: { ...assets, lovelace: 0n }, ...(datumHex ? { datum: datumHex } : {}) });
}

/** The index and the lovelace of the output of a built transaction at `address` that holds `unit` (when given) and the inline datum `datumHex` (when given). */
export function findOutput(txCbor: string, want: { address: string; unit?: string; datumHex?: string }): { index: number; lovelace: bigint } {
  const outputs = decodeTransaction(txCbor).body().outputs();
  for (let i = 0; i < outputs.len(); i++) {
    const output = outputs.get(i);
    if (output.address().to_bech32() !== want.address) continue;
    if (want.datumHex !== undefined && output.datum()?.as_datum()?.to_cbor_hex().toLowerCase() !== want.datumHex.toLowerCase()) continue;
    if (want.unit !== undefined) {
      const policy = CML.ScriptHash.from_hex(want.unit.slice(0, 56));
      const name = CML.AssetName.from_raw_bytes(Buffer.from(want.unit.slice(56), 'hex'));
      if (BigInt(output.amount().multi_asset().get(policy, name)?.toString() ?? '0') !== 1n) continue;
    }
    return { index: i, lovelace: BigInt(output.amount().coin().toString()) };
  }
  throw new Error('The built transaction does not have the planned output at the reputation address (address, inline datum and token); not returning it.');
}

// ─── Step 1: the opening output ────────────────────────────────────────────

export interface StakeOpeningPlan { datum: StakeDatum; datumHex: string; lovelace: bigint; capabilities: string[]; ownerKeyHash: string }

/**
 * Pure. The opening output that CreateStake spends (a seed): at the reputation address with the 8-field datum of the reference SDK,
 * which names the agent (CreateStake reads only `agent_did` of it), the owner and the capabilities, and a placeholder stake_id
 * (SEED_STAKE_ID: the new stake takes the seed's own output reference). It locks the SDK's 2 AP3X, or the ledger minimum of the output when
 * that is more (a long capability list makes the datum big). Rules that step 2 will check are checked now, before anything is locked.
 */
export function planStakeOpening(p: {
  chain: RecordUtxo[]; did: string; ownerKeyHash: string; capabilities: unknown; window: Window; minimumLovelace: (datumHex: string) => bigint;
}): StakeOpeningPlan {
  const [self] = p.chain;
  assertActive(p.chain, p.window);
  const capabilities = stakedCapabilities(p.capabilities, self.record, p.did);
  assertDeclaredOwner(self.record, p.ownerKeyHash, p.did);
  const datum: StakeDatum = {
    agent_did: self.id, owner_pkh: p.ownerKeyHash, stake_amount: STAKE_OPENING_LOVELACE, staked_capabilities: capabilities,
    last_updated: p.window.lo + 60_000, history_points: 0n, challenge_locks: [], stake_id: SEED_STAKE_ID,
  };
  const datumHex = encodeStakeDatum(datum);
  const minimum = p.minimumLovelace(datumHex);
  return { datum, datumHex, lovelace: minimum > STAKE_OPENING_LOVELACE ? minimum : STAKE_OPENING_LOVELACE, capabilities, ownerKeyHash: p.ownerKeyHash };
}

/**
 * Pure. Refuses step 1 for a wallet that could not go on to make the stake: it must hold the opening output, the stake and about 1.5 AP3X of
 * fees for the two steps (the opening output returns as change in step 2). Only lovelace that the wallet can spend counts: an output that
 * holds tokens keeps the ledger minimum for them (`calculateMinLovelaceFromUTxO` at coinsPerUtxoByte, as Lucid sizes its outputs), because
 * that lovelace goes with the tokens into a change output. An opening output is locked until a CreateStake consumes it, so a wallet that
 * could not pay for the stake would lock its AP3X for nothing.
 */
export function assertMeansForStake(utxos: UTxO[], openingLovelace: bigint, stakeLovelace: bigint, coinsPerUtxoByte: bigint): void {
  let spendable = 0n;
  let kept = 0n;
  for (const u of utxos) {
    const minimum = Object.keys(u.assets).some((k) => k !== 'lovelace') ? calculateMinLovelaceFromUTxO(coinsPerUtxoByte, u) : 0n;
    const keep = minimum < u.assets.lovelace ? minimum : u.assets.lovelace;
    kept += keep;
    spendable += u.assets.lovelace - keep;
  }
  const needed = openingLovelace + stakeLovelace + STAKE_FEE_ALLOWANCE_LOVELACE;
  if (spendable < needed) {
    const besides = kept > 0n ? `, besides ${ada(kept)} that its outputs with tokens must keep` : '';
    throw new Error(`The wallet can spend ${ada(spendable)}${besides}; a stake needs ${ada(needed)}: the opening output of ${ada(openingLovelace)}, the stake of ${ada(stakeLovelace)} and about ${ada(STAKE_FEE_ALLOWANCE_LOVELACE)} of fees for the two steps. Nothing was built.`);
  }
}

export interface StakeOpeningParams extends BuildCommon {
  /** The agent: an identity DID. */
  did: string;
  /** Capabilities to stake on, as text: each must be one the record lists. */
  capabilities: string[];
  /** The owner credential of the stake, a key hash. Default: the key of `changeAddress`. */
  ownerKeyHash?: string;
  /** The AP3X that step 2 will lock, only to check that the wallet can pay it. Default: the module minimum. */
  stakeLovelace?: bigint;
  /** Build a new opening output although one that names the agent is already at the reputation address. Default: refuse. */
  allowSecondOpening?: boolean;
}

export interface StakeOpeningBuild extends SignedByBuild {
  /** `<txHash>#<index>` of the opening output after submit. */
  openingRef: string;
  did: string; ownerKeyHash: string; capabilities: string[]; lovelace: bigint;
  /** The AP3X that this step checked the wallet for: pass it to step 2 as `amount`. */
  stakeLovelace: bigint;
  /** Whether the wallet's smallest pure 5 AP3X output was left out of the inputs: step 2 needs a collateral output. */
  collateralKept: boolean;
  /**
   * The references of the opening outputs that already named the agent (only with `allowSecondOpening`; else none): at most
   * MAX_LISTED_OPENINGS, those whose owner the record declares first.
   */
  otherOpenings: string[];
  /** How many more opening outputs named the agent than `otherOpenings` lists. */
  otherOpeningsMore: number;
}

/**
 * Step 1 of 2. Builds the unsigned transaction that locks the opening output at the reputation address. What step 2 will check about the
 * agent is checked first (identity record, capabilities, owner, no stake yet), and so are the module's outputs and the wallet's means for
 * step 2 (assertMeansForStake). When an opening output that names the agent is already at the address, this refuses and lists them (at
 * most MAX_LISTED_OPENINGS, those whose owner the record declares first), unless `allowSecondOpening` is set: step 2 can spend any opening
 * output with any owner key that the record declares, and each opening output locks its AP3X until a CreateStake spends it. Leaves the
 * wallet's smallest pure 5 AP3X output alone when it can, as step 2 needs it as collateral. No script runs, so only the wallet signs.
 */
export async function buildStakeOpening(ctx: IdentityContext, p: StakeOpeningParams): Promise<StakeOpeningBuild> {
  const { lucid, provider, deployment } = ctx;
  const id = stakeAgentId(p.did);
  const did = didOf(id);
  assertIdentityRegistry(deployment);
  await assertVectorMainnet(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const ownerKeyHash = (p.ownerKeyHash ?? wallet.keyHash).toLowerCase();
  const refs = await readModuleReferences(provider);
  const chain = await recordWithAncestors(provider, deployment, id, 'record of the agent');
  const plan = planStakeOpening({ chain, did, ownerKeyHash, capabilities: p.capabilities, window, minimumLovelace: (datumHex) => minimumOf(lucid, REPUTATION_ADDRESS, {}, datumHex) });
  const held = await agentOutputs(provider, id);
  const [self] = chain;
  assertNoStake(held, did, self.record);
  if (held.openings.length > 0 && !p.allowSecondOpening) {
    throw new Error(`An opening output that names ${did} is already at the reputation address. Step 2 (vector_build_reputation_stake) can spend any of them with any owner key that the record declares: pass one as opening_ref, and owner_key_hash when you want another owner than the one it names. When step 2 cannot use any of them, pass allow_second_opening true to build a new opening output; each opening output locks its AP3X until a CreateStake spends it. Listed (at most ${MAX_LISTED_OPENINGS}, the ones whose owner the record declares first): ${openingList(held.openings, self.record)}. Nothing was built.`);
  }
  const coinsPerUtxoByte = coinsPerUtxoByteOf(lucid);
  const stakeLovelace = p.stakeLovelace ?? refs.stakeParams.minSelfStake;
  if (stakeLovelace < refs.stakeParams.minSelfStake) throw new Error(`The stake must be at least ${ada(refs.stakeParams.minSelfStake)}, the module's min_self_stake; ${ada(stakeLovelace)} is less.`);
  assertMeansForStake(wallet.utxos, plan.lovelace, stakeLovelace, coinsPerUtxoByte);
  const assemble = () => lucid.newTx()
    .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: plan.datumHex }, { lovelace: plan.lovelace })
    .validFrom(window.lo)
    .validTo(window.hi);
  const reserved = reserveCollateralInputs(wallet.utxos, plan.lovelace);
  let completed: TxSignBuilder | undefined;
  if (reserved) {
    try { completed = await assemble().complete({ presetWalletInputs: reserved }); } catch { /* retried below with the whole wallet */ }
  }
  const collateralKept = completed !== undefined;
  completed ??= await assemble().complete({});
  const result = signedByResult(completed, window, new SignerList(), wallet.keyHash);
  const out = findOutput(result.txCbor, { address: REPUTATION_ADDRESS, datumHex: plan.datumHex });
  const others = shownOpenings(held.openings, self.record);
  return {
    ...result, openingRef: formatOutRef(result.txHash, out.index), did, ownerKeyHash, capabilities: plan.capabilities.map(capabilityText), lovelace: out.lovelace, stakeLovelace, collateralKept,
    otherOpenings: others.shown.map((o) => o.ref), otherOpeningsMore: others.more,
  };
}

/** The most opening outputs that a refusal or an answer lists: a long list would push the rest of the text out of the 800 characters that an error keeps. */
export const MAX_LISTED_OPENINGS = 5;

/** The opening outputs to list: those whose owner key the record declares first, then the others (each group in the order of the node), at most MAX_LISTED_OPENINGS, and how many more there are. */
export function shownOpenings(openings: StakeOut[], record: IdentityDatum): { shown: StakeOut[]; more: number } {
  const declared: StakeOut[] = [];
  const others: StakeOut[] = [];
  for (const o of openings) (isDeclared(record, o.datum.owner_pkh) ? declared : others).push(o);
  const ordered = [...declared, ...others];
  return { shown: ordered.slice(0, MAX_LISTED_OPENINGS), more: Math.max(0, ordered.length - MAX_LISTED_OPENINGS) };
}

/** The opening outputs as a refusal lists them (shownOpenings): the reference, the AP3X in the output and the owner key that its datum names, then the number of the rest. */
function openingList(openings: StakeOut[], record: IdentityDatum): string {
  const { shown, more } = shownOpenings(openings, record);
  return `${shown.map((o) => `${o.ref} (${ada(o.utxo.assets.lovelace)}, owner ${o.datum.owner_pkh})`).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * Refuses when the agent already has a stake: the tools build one stake for each agent. An opening output that names the agent is not part
 * of the stake, and only a CreateStake spends it, so the refusal lists them (openingList).
 */
export function assertNoStake(held: { stakes: StakeOut[]; openings: StakeOut[] }, did: string, record: IdentityDatum): void {
  if (held.stakes.length === 0) return;
  const count = held.openings.length;
  const openings = count === 0
    ? ''
    : ` ${count === 1 ? 'An opening output that names the agent is' : `${count} opening outputs that name the agent are`} also at the reputation address. Only a CreateStake can spend an opening output, and these tools make no second stake for an agent. Listed (at most ${MAX_LISTED_OPENINGS}, the ones whose owner the record declares first): ${openingList(held.openings, record)}.`;
  throw new Error(`${did} already has a stake, at ${held.stakes.map((s) => s.ref).join(', ')}. These tools make one stake for each agent: the owner cannot withdraw the module minimum, so a second stake would lock it twice. Add AP3X with vector_build_reputation_stake_increase, or change the capabilities with vector_build_reputation_stake_update_capabilities.${openings} Nothing was built.`);
}

// ─── Step 2: CreateStake ───────────────────────────────────────────────────

export interface StakeCreatePlan {
  datum: StakeDatum; datumHex: string; stakeLovelace: bigint; tokenUnit: string; window: Window; capabilities: string[];
  controllerKeyHash: string; ownerKeyHash: string; spendRedeemerHex: string; mintRedeemerHex: string;
}

/**
 * Pure. What CreateStake must say: the stake datum (the capabilities, owner_credential the owner key, `stake_amount` the amount, last_updated
 * the upper bound of the window, no history, no locks, `stake_id` the output reference of the opening output), the token, the redeemers and
 * the signers. The amount defaults to the module minimum and is at least that. The opening output must name the same agent: the validator
 * finds the stake output by the token of the agent that the spent datum names. The validator reads only that agent in the opening output,
 * and the owner of the stake in the stake datum: the owner is `ownerKeyHash` when given, else the owner that the opening output names.
 * The record must declare it either way.
 */
export function planStakeCreate(p: {
  chain: RecordUtxo[]; did: string; ownerKeyHash?: string; capabilities: unknown; opening: StakeOut; params: StakeParams; amountLovelace?: bigint; window: Window;
}): StakeCreatePlan {
  const [self] = p.chain;
  assertActive(p.chain, p.window);
  const capabilities = stakedCapabilities(p.capabilities, self.record, p.did);
  if (p.opening.datum.agent_did !== self.id) throw new Error(`The opening output ${p.opening.ref} names another agent (did:vector:${p.opening.datum.agent_did}), not ${p.did}; make one for this agent with vector_build_reputation_stake_open.`);
  const named = p.opening.datum.owner_pkh;
  if (p.ownerKeyHash !== undefined) assertDeclaredOwner(self.record, p.ownerKeyHash, p.did);
  else if (!isDeclared(self.record, named)) {
    throw new Error(`The opening output ${p.opening.ref} names the owner key ${named}, and the record of ${p.did} does not declare that key now. Pass owner_key_hash with the controller key or with a key that the record lists with the transaction purpose. Nothing was built.`);
  }
  const ownerKeyHash = p.ownerKeyHash ?? named;
  const amount = p.amountLovelace ?? p.params.minSelfStake;
  if (amount < p.params.minSelfStake) throw new Error(`The stake must be at least ${ada(p.params.minSelfStake)}, the module's min_self_stake (validate_create_stake rule 4); ${ada(amount)} is less.`);
  const datum: StakeDatum = {
    agent_did: self.id, owner_pkh: ownerKeyHash, stake_amount: amount, staked_capabilities: capabilities, last_updated: p.window.hi,
    history_points: 0n, challenge_locks: [], stake_id: { txHash: p.opening.utxo.txHash, outputIndex: p.opening.utxo.outputIndex },
  };
  return {
    datum, datumHex: encodeStakeDatum(datum), stakeLovelace: amount, tokenUnit: stakeTokenUnit(self.id), window: p.window, capabilities,
    controllerKeyHash: keyHashOf(self.record.controller), ownerKeyHash, spendRedeemerHex: CREATE_STAKE_REDEEMER, mintRedeemerHex: MINT_STAKE_TOKEN_REDEEMER,
  };
}

/** The opening output that step 2 consumes: the node's copy, at the reputation address, holding lovelace only, with a stake datum. */
export async function readOpening(provider: Provider, openingRef: string): Promise<StakeOut> {
  const parsed = parseOutRef(openingRef);
  const ref = refText(parsed);
  let utxo: UTxO | undefined;
  try { [utxo] = await provider.getUtxosByOutRef([parsed]); } catch (err) { throw new Error(`Could not read the opening output ${ref} from the node: ${nodeFailure(err)}`); }
  if (!utxo) throw new Error(`The node does not list ${ref} as unspent: the step 1 transaction has not confirmed yet (run vector_await_transaction first), or the output was already consumed.`);
  if (utxo.address !== REPUTATION_ADDRESS) throw new Error(`${ref} is not at the reputation address; pass the opening_ref that vector_build_reputation_stake_open returned.`);
  if (Object.keys(utxo.assets).some((k) => k !== 'lovelace')) throw new Error(`${ref} holds tokens, so it is a stake or a bonus of the module, not an opening output.`);
  if (!utxo.datum) throw new Error(`${ref} has no inline datum, so it is not an opening output.`);
  let datum: StakeDatum;
  try { datum = decodeStakeDatum(utxo.datum); } catch (err) { throw new Error(`${ref} is not an opening output (${errorText(err)}).`); }
  return { utxo, datum, ref };
}

/** What the assemble functions take besides the plan: the module outputs, the records the validator reads (the agent's and its ancestors'), and the keys that sign. */
export interface StakeAssembly { refs: Pick<ModuleReferences, 'script' | 'params' | 'crossRefs'>; records: UTxO[]; signerKeyHashes: string[] }

/**
 * The CreateStake transaction as the plan says: spends the opening output with CreateStake, mints the stake token, locks the stake at its
 * output, reads the record(s), the parameters, the cross references and the validator as reference inputs, lists the signers, and has the
 * window. Lucid runs the deployed validator on it (local evaluation) and balances it with coin selection, which also pays the fee of the
 * reference script. Exported so that a test can hand it a plan that breaks one rule and see the validator refuse it.
 */
export function assembleStakeCreate(lucid: LucidEvolution, a: StakeAssembly & { opening: UTxO; plan: StakeCreatePlan }): Promise<TxSignBuilder> {
  const { plan } = a;
  let tx = lucid.newTx()
    .readFrom(uniqueUtxos([a.refs.script, a.refs.params, a.refs.crossRefs, ...a.records]))
    .collectFrom([a.opening], plan.spendRedeemerHex)
    .mintAssets({ [plan.tokenUnit]: 1n }, plan.mintRedeemerHex)
    .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: plan.datumHex }, { lovelace: plan.stakeLovelace, [plan.tokenUnit]: 1n });
  for (const hash of a.signerKeyHashes) tx = tx.addSignerKey(hash);
  return tx.validFrom(plan.window.lo).validTo(plan.window.hi).complete();
}

export interface StakeCreateParams extends BuildCommon {
  did: string;
  capabilities: string[];
  /** The confirmed opening output `<txid>#<index>` that vector_build_reputation_stake_open returned. */
  openingRef: string;
  /** The owner credential of the stake, a key hash that the record declares. Default: the owner that the opening output names, when the record declares that key now. */
  ownerKeyHash?: string;
  /** The AP3X to lock, at least the module minimum (the default). */
  amountLovelace?: bigint;
}

export interface StakeCreateBuild extends SignedByBuild {
  /** `<txHash>#<index>` of the stake output after submit. */
  stakeRef: string;
  /** `stake_id` of the new stake: the output reference of the opening output. */
  stakeId: string;
  openingRef: string; did: string; ownerKeyHash: string; controllerKeyHash: string; capabilities: string[];
  /** The owner key that the opening output names: the stake gets it unless the caller passed another declared key. */
  openingOwnerKeyHash: string;
  stakeLovelace: bigint; tokenUnit: string; lastUpdated: number;
  /** The earliest lower bound of a later UpdateCapabilities or DecreaseStake. */
  readyAt: number;
  minSelfStake: bigint;
}

/**
 * Step 2 of 2. Builds the unsigned CreateStake: consumes the opening output, mints the agent's stake token and locks the stake, with the
 * record(s) of the agent, the module's parameters and cross references and the validator's reference script as reference inputs. Every rule
 * of validate_create_stake that can be known before the script runs is checked first (see the head of this file). The controller of the
 * agent and the owner key sign, and the wallet. The wallet must be the one bound to changeAddress and hold a pure output of at least
 * 5 AP3X as collateral. Nothing is signed or submitted.
 */
export async function buildStakeCreate(ctx: IdentityContext, p: StakeCreateParams): Promise<StakeCreateBuild> {
  const { lucid, provider, deployment } = ctx;
  const id = stakeAgentId(p.did);
  const did = didOf(id);
  assertIdentityRegistry(deployment);
  await assertVectorMainnet(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const refs = await readModuleReferences(provider);
  const chain = await recordWithAncestors(provider, deployment, id, 'record of the agent');
  assertNoStake(await agentOutputs(provider, id), did, chain[0].record);
  const opening = await readOpening(provider, p.openingRef);
  const plan = planStakeCreate({ chain, did, ownerKeyHash: p.ownerKeyHash?.toLowerCase(), capabilities: p.capabilities, opening, params: refs.stakeParams, amountLovelace: p.amountLovelace, window });
  const signers = stakeSigners(plan.controllerKeyHash, did, plan.ownerKeyHash);
  const completed = await assembleStakeCreate(lucid, { refs, records: chain.map((r) => r.utxo), opening: opening.utxo, plan, signerKeyHashes: signers.hashes() });
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  const out = findOutput(result.txCbor, { address: REPUTATION_ADDRESS, unit: plan.tokenUnit, datumHex: plan.datumHex });
  return {
    ...result, stakeRef: formatOutRef(result.txHash, out.index), stakeId: opening.ref, openingRef: opening.ref, did, ownerKeyHash: plan.ownerKeyHash, openingOwnerKeyHash: opening.datum.owner_pkh,
    controllerKeyHash: plan.controllerKeyHash,
    capabilities: plan.capabilities.map(capabilityText), stakeLovelace: out.lovelace, tokenUnit: plan.tokenUnit, lastUpdated: plan.datum.last_updated,
    readyAt: readyAt(plan.datum.last_updated, refs.stakeParams), minSelfStake: refs.stakeParams.minSelfStake,
  };
}
