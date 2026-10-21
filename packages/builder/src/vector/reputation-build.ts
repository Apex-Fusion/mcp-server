// packages/builder/src/vector/reputation-build.ts
// Keyless building of an agent's reputation self-stake on the Module-3 reputation validator. Every builder returns UNSIGNED CBOR through
// toBuildResult; the agent's owner signs on the local signer. The plan functions are pure: they decide what a transaction must say, so
// the same values can be shown before signing and unit-tested without a chain.
//
// Ported from the reference Python SDK, Apex-Fusion/vector-agent-modules Module-3/python/reputation_staking (client.py: the opening
// output and create_stake; plutus_data.py: StakeDatum; token_names.py: the stake token name), against the deployed validator
// (Module-3/reputation-staking: validators/reputation.ak, stake_validation.ak validate_create_stake). A stake takes two transactions,
// as in the SDK: the validator mints the stake token only when a script input of its own is consumed, so step 1 locks an opening output
// at the reputation address and step 2 consumes it with CreateStake, mints the token and locks the stake. What the validator requires
// of step 2 (validate_create_stake), each checked here before anything is built:
//   1 + 4  the agent has a registry record (a reference input), and every staked capability is one the record lists, byte for byte;
//   F3     the stake's owner is the record's owner, and (7) that key signs;
//   3      the stake is at least the module's minimum (read from the parameters UTxO);
//   5      the stake output is at the reputation address with the stake token, the datum and at least the stake;
//   6      last_updated equals the lower bound of the validity range, as the ledger turns that slot into POSIX milliseconds.
// Rule 6 is where the SDK's clock went wrong on mainnet: it stamps the time from a genesis constant that is testnet's, and the datum lands
// about 51 days off. Here the time comes from the node's own chain start, and that start is pinned to Vector mainnet's and held against
// this server's wall clock before anything is built.
import { Data, Constr, CML, fromText, toText, validatorToScriptHash, credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { ensureSlotConfig, paymentKeyHashOf, ChainClockError } from './gov-build.js';
import { REGISTRY_POLICY_ID, getRegistryAddress, parseDid, resolveAgentUtxo } from './registry-build.js';
import { formatOutRef, parseOutRef } from './marketplace-datum.js';
import { nodeFailure } from './marketplace-lineage.js';
import { reserveCollateralInputs, assertCollateral, assertWalletIs } from './marketplace-build.js';
import { cell } from './marketplace-shared.js';

// ─── Deployment (Vector mainnet) ───────────────────────────────────────────
// From vector-agent-modules Module-3/deploy/mainnet/deploy_state.json (network "vector-mainnet"), each checked against the live chain
// on 2026-10-21 (Koios utxo_info and script_info). Inlined, as the marketplace's are: the Docker image ships only build/.

/** The reputation validator: one script, both the minting policy of the stake token and the script credential of the stake address. */
export const REPUTATION_SCRIPT_HASH = '5168e1871cfdb1e55c18ee173acbcdce092044a48bc2e23f3ba35093';
export const REPUTATION_ADDRESS = 'addr1w9gk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pyc76uluq';
/** The UTxO that carries the reputation validator as a reference script (deploy_state tx_hashes.reputation_spend_ref). */
export const REPUTATION_REF_SCRIPT_UTXO = { txHash: 'dfa32f9c7a625f500a753bd4226b546c776f34cd68987e540786d50cacfa14bb', outputIndex: 0 };
/** The module's protocol parameters (deploy_state tx_hashes.params_utxo), at the parameters holder script. */
export const REPUTATION_PARAMS_UTXO = { txHash: '705d6b572ac634fa1ec1fc9d4d35303be17b6f5a9ce30030955bb0f0d0d7a7fe', outputIndex: 0 };
export const REPUTATION_PARAMS_HOLDER_HASH = 'f98f1dace1ac805615ccc0357b4ecb363a43b947fc99f1a661850867';
/** The cross-validator references (deploy_state tx_hashes.cross_refs_nft): the validator finds them by a token of REFS_TOKEN_POLICY. */
export const REPUTATION_CROSS_REFS_UTXO = { txHash: 'd79b722817548b4ba57ad5c887e7ee084ada3d1ad25a0ba7e152a5946dc5ccaa', outputIndex: 0 };
export const REPUTATION_REFS_TOKEN_POLICY = '09dce01a3c2f2fddeda34a547bb4a5ef9f156feae6c4f45d6d74af84';
/**
 * Vector mainnet's chain start, POSIX ms. The SDK ships testnet's (constants.py SYSTEM_START_UNIX_S = 1752057484) and the deployments
 * had to replace it with this one; here the node's own start is used and must equal it.
 */
export const VECTOR_MAINNET_ZERO_TIME_MS = 1_756_485_600_000;
/** What step 1 locks, and the stake_amount its datum names: the SDK's opening output (client.py, min_lovelace = 2_000_000). */
export const STAKE_OPENING_LOVELACE = 2_000_000n;
/** Step 2 is valid for 600 slots from its lower bound, as the SDK builds it (ttl = current_slot + 600). */
export const STAKE_VALIDITY_MS = 600_000;
/** How far the node's tip may be from this server's clock before the stake's time is not trusted (the deployments' own check, 120 s). */
export const STAKE_CLOCK_SKEW_MAX_MS = 120_000;
/** Redeemers: StakeAction.CreateStake, on the opening output it consumes, and StakeMintAction.MintStakeToken, both constructor 0 (types.ak). */
export const CREATE_STAKE_REDEEMER = Data.to(new Constr(0, []));
export const MINT_STAKE_TOKEN_REDEEMER = Data.to(new Constr(0, []));

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const ErrorWithCause = Error as new (message?: string, options?: { cause?: unknown }) => Error;
const iso = (ms: number) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString(); };
const HEX = /^(?:[0-9a-fA-F]{2})*$/;

// ─── Stake datum and token ─────────────────────────────────────────────────

/** StakeDatum (types.ak). Capabilities are the bytes the datum holds (hex); the owner is a verification-key credential. */
export interface StakeDatum {
  agent_did: string; owner_pkh: string; stake_amount: bigint; staked_capabilities: string[]; last_updated: number; history_points: bigint;
}

/**
 * The datum as the SDK writes it (PyCardano: indefinite-length lists, smallest integer forms), which is what Lucid's Data.to writes:
 * byte-identical to the live stakes and opening outputs it is pinned against in test/reputation-build.test.ts.
 */
export function encodeStakeDatum(d: StakeDatum): string {
  return Data.to(new Constr(0, [
    d.agent_did, new Constr(0, [d.owner_pkh]), d.stake_amount, d.staked_capabilities, BigInt(d.last_updated), d.history_points,
  ]));
}

export function decodeStakeDatum(hex: string): StakeDatum {
  const c = Data.from(hex);
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 6) throw new Error('not a stake datum (expected constructor 0 with 6 fields)');
  const [did, owner, amount, caps, updated, history] = c.fields;
  if (typeof did !== 'string') throw new Error('stake datum: agent_did is not bytes');
  if (!(owner instanceof Constr) || owner.index !== 0 || typeof owner.fields[0] !== 'string') throw new Error('stake datum: owner is not a verification-key credential');
  if (typeof amount !== 'bigint' || typeof updated !== 'bigint' || typeof history !== 'bigint') throw new Error('stake datum: an integer field is not an integer');
  if (!Array.isArray(caps) || !caps.every((x) => typeof x === 'string')) throw new Error('stake datum: staked_capabilities is not a list of bytes');
  return {
    agent_did: did, owner_pkh: owner.fields[0], stake_amount: amount, staked_capabilities: caps as string[],
    last_updated: Number(updated), history_points: history,
  };
}

/** The stake token's asset name: "rstk_" + the first 27 bytes of blake2b-256(agent_did) (utils.ak derive_stake_token_name; token_names.py). */
export function stakeTokenName(agentDidHex: string): string {
  if (!HEX.test(agentDidHex) || agentDidHex.length === 0) throw new Error('agent_did must be hex bytes');
  const digest = Buffer.from(blake2b(Buffer.from(agentDidHex, 'hex'), { dkLen: 32 })).toString('hex');
  return Buffer.from('rstk_', 'utf-8').toString('hex') + digest.slice(0, 54);
}
export const stakeTokenUnit = (agentDidHex: string): string => REPUTATION_SCRIPT_HASH + stakeTokenName(agentDidHex);

// ─── Module parameters and references ──────────────────────────────────────

/** The two fields of ProtocolParams (params.ak) a self-stake depends on: field 0 min_self_stake and field 3 stake_cooldown. */
export interface StakeParams { minSelfStake: bigint; stakeCooldown: bigint }
export function decodeStakeParams(hex: string): StakeParams {
  const c = Data.from(hex);
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length < 4) throw new Error('not the module parameters datum');
  const [min, , , cooldown] = c.fields;
  if (typeof min !== 'bigint' || typeof cooldown !== 'bigint' || min <= 0n) throw new Error('module parameters: min_self_stake or stake_cooldown is not a positive integer');
  return { minSelfStake: min, stakeCooldown: cooldown };
}

/** The cross-validator references datum (config.ak CrossValidatorRefs): the reputation and endorsement script hashes. */
export function decodeCrossRefs(hex: string): { reputation: string; endorsement: string } {
  const c = Data.from(hex);
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 2 || typeof c.fields[0] !== 'string' || typeof c.fields[1] !== 'string') {
    throw new Error('not the cross-validator references datum');
  }
  return { reputation: c.fields[0], endorsement: c.fields[1] };
}

const outRefOf = (r: { txHash: string; outputIndex: number }) => formatOutRef(r.txHash, r.outputIndex);
const paymentHashOf = (address: string): string | undefined => { try { return getAddressDetails(address).paymentCredential?.hash; } catch { return undefined; } };

/** The three module UTxOs every CreateStake reads (reference script, parameters, cross references), read from the node and checked. */
export async function readModuleReferences(provider: Provider): Promise<{ script: UTxO; params: UTxO; crossRefs: UTxO; stakeParams: StakeParams }> {
  const wanted = [REPUTATION_REF_SCRIPT_UTXO, REPUTATION_PARAMS_UTXO, REPUTATION_CROSS_REFS_UTXO];
  let utxos: UTxO[];
  try { utxos = await provider.getUtxosByOutRef(wanted); } catch (err) { throw new Error(`Could not read the reputation module's reference outputs from the node: ${nodeFailure(err)}`); }
  const find = (r: { txHash: string; outputIndex: number }, what: string): UTxO => {
    const u = utxos.find((x) => x.txHash === r.txHash && x.outputIndex === r.outputIndex);
    if (!u) throw new Error(`The reputation module's ${what} ${outRefOf(r)} is not on the ledger; the module would have to publish it again. Nothing was built.`);
    return u;
  };
  const script = find(REPUTATION_REF_SCRIPT_UTXO, 'reference script');
  if (!script.scriptRef || validatorToScriptHash(script.scriptRef) !== REPUTATION_SCRIPT_HASH) throw new Error(`The output ${outRefOf(REPUTATION_REF_SCRIPT_UTXO)} does not carry the reputation validator; nothing was built.`);
  const params = find(REPUTATION_PARAMS_UTXO, 'parameters');
  if (paymentHashOf(params.address) !== REPUTATION_PARAMS_HOLDER_HASH || !params.datum) throw new Error(`The output ${outRefOf(REPUTATION_PARAMS_UTXO)} is not the module's parameters; nothing was built.`);
  let stakeParams: StakeParams;
  try { stakeParams = decodeStakeParams(params.datum); } catch (err) { throw new Error(`The module's parameters at ${outRefOf(REPUTATION_PARAMS_UTXO)} could not be read (${errorText(err)}); nothing was built.`); }
  const crossRefs = find(REPUTATION_CROSS_REFS_UTXO, 'cross-validator references');
  const authenticated = Object.entries(crossRefs.assets).some(([unit, n]) => unit.startsWith(REPUTATION_REFS_TOKEN_POLICY) && n > 0n);
  let named = '';
  try { named = crossRefs.datum ? decodeCrossRefs(crossRefs.datum).reputation : ''; } catch { /* refused below */ }
  if (!authenticated || named !== REPUTATION_SCRIPT_HASH) throw new Error(`The output ${outRefOf(REPUTATION_CROSS_REFS_UTXO)} is not the module's cross-validator references for this validator; nothing was built.`);
  return { script, params, crossRefs, stakeParams };
}

// ─── Registry record ───────────────────────────────────────────────────────

/** What the stake needs from the agent's registry record: the record itself (a reference input), its owner and its capabilities as bytes. */
export interface RegistryRecord { utxo: UTxO; agentDidHex: string; ownerPkh: string; capabilityHex: string[]; name: string }

/** The registry record of a DID, from the registry address, with the owner a verification key and the capabilities as the bytes the record holds. */
export async function readRegistryRecord(provider: Provider, agentId: string): Promise<RegistryRecord> {
  const { policyId, assetName } = parseDid(agentId);
  if (policyId !== REGISTRY_POLICY_ID) throw new Error(`${cell(agentId)} is not a DID of the agent registry (its policy is not ${REGISTRY_POLICY_ID}).`);
  if (assetName.length !== 64) throw new Error('The DID\'s asset name must be 64 hex characters.');
  const { utxo, profile } = await resolveAgentUtxo(provider as unknown as Parameters<typeof resolveAgentUtxo>[0], agentId);
  if (utxo.address !== getRegistryAddress()) throw new Error(`The registry token of ${agentId} is not at the registry address; nothing was built.`);
  const c = Data.from(utxo.datum!);
  const owner = c instanceof Constr ? c.fields[0] : undefined;
  const caps = c instanceof Constr ? c.fields[3] : undefined;
  if (!(owner instanceof Constr) || owner.index !== 0 || typeof owner.fields[0] !== 'string' || !Array.isArray(caps) || !caps.every((x) => typeof x === 'string')) {
    throw new Error(`The registry record of ${agentId} has no verification-key owner or no capability list; nothing was built.`);
  }
  return { utxo, agentDidHex: assetName, ownerPkh: owner.fields[0], capabilityHex: caps as string[], name: profile.name };
}

/** Capabilities as text, for the person reading: bytes that are not UTF-8 are shown as hex. */
export function capabilityText(hex: string): string { const t = toText(hex); return fromText(t) === hex.toLowerCase() ? t : `0x${hex}`; }

/**
 * Pure. The capabilities a stake names, as the bytes the datum will hold: at least one, no repeats, each one the registry record lists
 * (validate_create_stake rules 1 and 4 compare bytes, so the text must be the record's exactly).
 */
export function stakedCapabilities(requested: unknown, record: Pick<RegistryRecord, 'capabilityHex'>, agentId: string): string[] {
  if (!Array.isArray(requested) || requested.length === 0) throw new Error('Name at least one capability to stake on.');
  const listed = record.capabilityHex.map((h) => h.toLowerCase());
  const out: string[] = [];
  for (const cap of requested) {
    if (typeof cap !== 'string' || cap.length === 0) throw new Error('Each capability must be non-empty text.');
    const hex = fromText(cap);
    if (out.includes(hex)) throw new Error(`Capability ${cell(cap)} is named twice.`);
    if (!listed.includes(hex)) {
      throw new Error(`Capability ${cell(cap)} is not in the registry record of ${agentId}, which lists: ${listed.map((h) => cell(capabilityText(h), 64)).join(', ') || '(none)'}. The validator accepts only capabilities the record lists; add it with vector_build_update_agent first, or stake on listed ones.`);
    }
    out.push(hex);
  }
  return out;
}

function assertOwner(record: RegistryRecord, callerPkh: string, agentId: string): void {
  if (record.ownerPkh !== callerPkh) {
    throw new Error(`The key of changeAddress is not the owner of ${agentId} (owner key ${record.ownerPkh}). The validator requires the stake's owner to be the registry record's owner, and that key signs; use the wallet that registered the agent (the same key the supplier's adverts name).`);
  }
}

// ─── The chain clock ───────────────────────────────────────────────────────

/**
 * The POSIX ms the ledger gives the slot of the node's tip: the lower bound of step 2 and the stake's last_updated (rule 6), and the time
 * step 1 stamps (the SDK stamps its current slot the same way). The node's chain start must be Vector mainnet's (the module is deployed
 * there only, and a wrong start is exactly the SDK's testnet-constant failure), and the tip must be within 120 s of this server's clock.
 */
export async function stakeClock(provider: Provider, nowMs: number): Promise<number> {
  let zeroTime: number;
  try { zeroTime = await ensureSlotConfig(provider as unknown as Parameters<typeof ensureSlotConfig>[0]); } catch (err) {
    throw err instanceof ChainClockError ? err : new Error(`Could not read the chain clock from the node: ${nodeFailure(err)}`);
  }
  if (zeroTime !== VECTOR_MAINNET_ZERO_TIME_MS) {
    throw new Error(`The node reports a chain start of ${iso(zeroTime)}, not Vector mainnet's ${iso(VECTOR_MAINNET_ZERO_TIME_MS)}. The reputation module these tools build for is deployed on mainnet only; nothing was built.`);
  }
  let slot: number;
  try { slot = (await (provider as unknown as { getNetworkTip(): Promise<{ slot: number }> }).getNetworkTip()).slot; } catch (err) {
    throw new Error(`Could not read the chain tip from the node: ${nodeFailure(err)}`);
  }
  const at = zeroTime + slot * 1000;
  if (!Number.isSafeInteger(at) || Math.abs(at - nowMs) > STAKE_CLOCK_SKEW_MAX_MS) {
    throw new Error(`The node's tip is at ${iso(at)}, more than ${STAKE_CLOCK_SKEW_MAX_MS / 1000} s from this server's clock (${iso(nowMs)}). The stake's time must be the ledger's; retry when the node is in sync. Nothing was built.`);
  }
  return at;
}

/**
 * What the reputation address holds for an agent: its stake (the output carrying its stake token; the module keeps one per agent, and
 * a second CreateStake would mint the token twice) and its opening outputs (lovelace only, with a stake datum naming the agent).
 */
async function agentOutputs(provider: Provider, agentDidHex: string): Promise<{ stake?: UTxO; openings: UTxO[] }> {
  const unit = stakeTokenUnit(agentDidHex);
  let utxos: UTxO[];
  try { utxos = await provider.getUtxos(REPUTATION_ADDRESS); } catch (err) { throw new Error(`Could not read the reputation address from the node: ${nodeFailure(err)}`); }
  const opens = (u: UTxO): boolean => {
    if (Object.keys(u.assets).some((k) => k !== 'lovelace') || !u.datum) return false;
    try { return decodeStakeDatum(u.datum).agent_did === agentDidHex; } catch { return false; }
  };
  return { stake: utxos.find((u) => (u.assets[unit] ?? 0n) > 0n), openings: utxos.filter(opens) };
}

/** Refuses when the agent already has a stake. */
function assertNoStake(held: { stake?: UTxO }, agentId: string): void {
  if (held.stake) throw new Error(`${agentId} already has a stake, at ${formatOutRef(held.stake.txHash, held.stake.outputIndex)}. The module keeps one stake per agent; nothing was built.`);
}

// ─── Step 1: the opening output ────────────────────────────────────────────

export interface StakeOpeningPlan { datum: StakeDatum; datumHex: string; lovelace: bigint }

/** Pure. The opening output the SDK locks before CreateStake: the agent, its owner, the capabilities, 2 units, stamped with the tip's time. */
export function planStakeOpening(record: RegistryRecord, callerPkh: string, capsHex: string[], atMs: number, agentId: string): StakeOpeningPlan {
  assertOwner(record, callerPkh, agentId);
  const datum: StakeDatum = {
    agent_did: record.agentDidHex, owner_pkh: callerPkh, stake_amount: STAKE_OPENING_LOVELACE,
    staked_capabilities: capsHex, last_updated: atMs, history_points: 0n,
  };
  return { datum, datumHex: encodeStakeDatum(datum), lovelace: STAKE_OPENING_LOVELACE };
}

/** The planned output must be output 0 (the ref the next step is given is `<txHash>#0`): its address, inline datum and at least its lovelace. */
function outputZero(txCbor: string, expected: { datumHex: string; lovelace: bigint; unit?: string }): bigint {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  const first = outputs.len() > 0 ? outputs.get(0) : undefined;
  const coin = first ? BigInt(first.amount().coin().toString()) : -1n;
  let tokenOk = true;
  if (first && expected.unit) {
    const multi = first.amount().multi_asset();
    const policy = CML.ScriptHash.from_hex(expected.unit.slice(0, 56));
    const name = CML.AssetName.from_raw_bytes(Buffer.from(expected.unit.slice(56), 'hex'));
    tokenOk = BigInt(multi.get(policy, name)?.toString() ?? '0') === 1n;
  }
  const ok = first !== undefined && first.address().to_bech32() === REPUTATION_ADDRESS && coin >= expected.lovelace && tokenOk
    && first.datum()?.as_datum()?.to_cbor_hex().toLowerCase() === expected.datumHex.toLowerCase();
  if (!ok) throw new Error('The built transaction does not have the planned output as output 0 (address, inline datum and value), so the ref the next step needs would be wrong; not returning it.');
  return coin;
}

export type StakeOpeningBuild = VectorUnsignedBuildResult & {
  openingRef: string; agentDidHex: string; ownerPkh: string; capabilities: string[]; lovelace: bigint; collateralKept: boolean;
};

/**
 * Step 1 of 2. Builds the unsigned transaction that locks the opening output at the reputation address. Everything step 2 will check
 * about the agent is checked first (registry record, owner, capabilities, no stake yet, the chain clock), so the 2 units are not locked
 * for a stake that cannot be made; and an agent that already has an opening output is pointed at it instead of being given a second. Leaves the wallet's smallest pure 5-unit output alone when it can: step 2 runs a script and needs it as
 * collateral. Nothing is signed or submitted.
 */
export async function buildStakeOpening(
  lucid: LucidEvolution, provider: Provider, p: { changeAddress: string; agentId: string; capabilities: string[]; nowMs?: number },
): Promise<StakeOpeningBuild> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  const record = await readRegistryRecord(provider, p.agentId);
  const capsHex = stakedCapabilities(p.capabilities, record, p.agentId);
  assertOwner(record, callerPkh, p.agentId);
  const held = await agentOutputs(provider, record.agentDidHex);
  assertNoStake(held, p.agentId);
  // A second opening output would be stranded: only a CreateStake consumes one, and the agent gets one stake.
  const open = held.openings[0];
  if (open) throw new Error(`An opening output for ${p.agentId} is already at ${formatOutRef(open.txHash, open.outputIndex)}; pass it to vector_build_reputation_stake as opening_ref. Nothing was built.`);
  const at = await stakeClock(provider, p.nowMs ?? Date.now());
  const plan = planStakeOpening(record, callerPkh, capsHex, at, p.agentId);
  const assemble = () => lucid.newTx().pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: plan.datumHex }, { lovelace: plan.lovelace });
  const inputs = reserveCollateralInputs(await lucid.wallet().getUtxos(), plan.lovelace);
  let completed: TxSignBuilder | undefined;
  let reservedFailure: unknown;
  if (inputs) {
    try { completed = await assemble().complete({ presetWalletInputs: inputs }); } catch (err) { reservedFailure = err; /* retried below with the whole wallet */ }
  }
  const collateralKept = completed !== undefined;
  if (!completed) {
    try { completed = await assemble().complete({}); } catch (err) { throw inputs ? new ErrorWithCause(errorText(err), { cause: reservedFailure }) : err; }
  }
  const r = toBuildResult(completed);
  const lovelace = outputZero(r.txCbor, plan);
  return {
    ...r, openingRef: formatOutRef(r.txHash, 0), agentDidHex: record.agentDidHex, ownerPkh: callerPkh,
    capabilities: capsHex.map(capabilityText), lovelace, collateralKept,
  };
}

// ─── Step 2: CreateStake ───────────────────────────────────────────────────

export interface StakePlan {
  datum: StakeDatum; datumHex: string; stakeLovelace: bigint; tokenUnit: string;
  validFrom: number; validTo: number; spendRedeemerHex: string; mintRedeemerHex: string;
}

/**
 * Pure. What CreateStake must say: the stake datum (owner = the record's owner, the capabilities, the module's minimum, last_updated =
 * the lower bound, no history), the token, the redeemers and the validity range. The stake is exactly the module's minimum: nothing here
 * or in the SDK decreases a stake, and the validator lets an owner decrease one only down to that minimum, so more would stay locked too.
 * The opening output must name the same agent: the validator finds the stake output by the token of the agent the opening output names.
 */
export function planStake(record: RegistryRecord, callerPkh: string, capsHex: string[], params: StakeParams, opening: StakeDatum, validFromMs: number, agentId: string): StakePlan {
  assertOwner(record, callerPkh, agentId);
  if (opening.agent_did !== record.agentDidHex) throw new Error(`The opening output names another agent (${opening.agent_did}), not ${agentId}; build one for this agent with vector_build_reputation_stake_open.`);
  if (!Number.isSafeInteger(validFromMs) || validFromMs % 1000 !== 0) throw new Error('The lower bound must be a whole second of POSIX time (the start of a slot).');
  const datum: StakeDatum = {
    agent_did: record.agentDidHex, owner_pkh: callerPkh, stake_amount: params.minSelfStake,
    staked_capabilities: capsHex, last_updated: validFromMs, history_points: 0n,
  };
  return {
    datum, datumHex: encodeStakeDatum(datum), stakeLovelace: params.minSelfStake, tokenUnit: stakeTokenUnit(record.agentDidHex),
    validFrom: validFromMs, validTo: validFromMs + STAKE_VALIDITY_MS,
    spendRedeemerHex: CREATE_STAKE_REDEEMER, mintRedeemerHex: MINT_STAKE_TOKEN_REDEEMER,
  };
}

/** The opening output step 2 consumes: the node's copy, at the reputation address, holding lovelace only, with a stake datum. */
async function readOpening(provider: Provider, openingRef: string): Promise<{ utxo: UTxO; datum: StakeDatum; ref: string }> {
  const parsed = parseOutRef(openingRef);
  const ref = formatOutRef(parsed.txHash, parsed.outputIndex);
  let utxo: UTxO | undefined;
  try { [utxo] = await provider.getUtxosByOutRef([parsed]); } catch (err) { throw new Error(`Could not read the opening output ${ref} from the node: ${nodeFailure(err)}`); }
  if (!utxo) throw new Error(`The node does not list ${ref} as unspent: the step 1 transaction has not confirmed yet (run vector_await_transaction first), or the output was already consumed.`);
  if (utxo.address !== REPUTATION_ADDRESS) throw new Error(`${ref} is not at the reputation address; pass the opening_ref vector_build_reputation_stake_open returned.`);
  if (Object.keys(utxo.assets).some((k) => k !== 'lovelace')) throw new Error(`${ref} holds tokens, so it is a stake or a bonus of the module, not an opening output.`);
  if (!utxo.datum) throw new Error(`${ref} has no inline datum, so it is not an opening output.`);
  let datum: StakeDatum;
  try { datum = decodeStakeDatum(utxo.datum); } catch (err) { throw new Error(`${ref} is not an opening output (${errorText(err)}).`); }
  return { utxo, datum, ref };
}

export type StakeBuild = VectorUnsignedBuildResult & {
  stakeRef: string; openingRef: string; agentDidHex: string; ownerPkh: string; capabilities: string[];
  stakeLovelace: bigint; tokenUnit: string; lastUpdated: number; validTo: number; stakeCooldown: bigint;
};

/**
 * Step 2 of 2. Builds the unsigned CreateStake: consumes the opening output, mints the stake token and locks the stake at output 0, with
 * the registry record, the module's parameters and cross references and the validator's reference script as reference inputs. Every rule
 * of validate_create_stake that can be known before the node evaluates the script is checked first (see the head of this file). The wallet
 * must be the one bound to changeAddress and hold a pure output of at least 5 units as collateral; the node evaluates the validator
 * (`localUPLCEval: false`); nothing is signed or submitted.
 */
export async function buildStake(
  lucid: LucidEvolution, provider: Provider, p: { changeAddress: string; agentId: string; capabilities: string[]; openingRef: string; nowMs?: number },
): Promise<StakeBuild> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  const record = await readRegistryRecord(provider, p.agentId);
  const capsHex = stakedCapabilities(p.capabilities, record, p.agentId);
  assertOwner(record, callerPkh, p.agentId);
  assertNoStake(await agentOutputs(provider, record.agentDidHex), p.agentId);
  const opening = await readOpening(provider, p.openingRef);
  const refs = await readModuleReferences(provider);
  const validFrom = await stakeClock(provider, p.nowMs ?? Date.now());
  const plan = planStake(record, callerPkh, capsHex, refs.stakeParams, opening.datum, validFrom, p.agentId);
  await assertWalletIs(lucid, p.changeAddress);
  assertCollateral(await lucid.wallet().getUtxos());
  const completed = await lucid.newTx()
    .readFrom([refs.script, refs.params, refs.crossRefs, record.utxo])
    .collectFrom([opening.utxo], plan.spendRedeemerHex)
    .mintAssets({ [plan.tokenUnit]: 1n }, plan.mintRedeemerHex)
    .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: plan.datumHex }, { lovelace: plan.stakeLovelace, [plan.tokenUnit]: 1n })
    .addSignerKey(callerPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .complete({ localUPLCEval: false });
  const r = toBuildResult(completed);
  outputZero(r.txCbor, { datumHex: plan.datumHex, lovelace: plan.stakeLovelace, unit: plan.tokenUnit });
  return {
    ...r, stakeRef: formatOutRef(r.txHash, 0), openingRef: opening.ref, agentDidHex: record.agentDidHex, ownerPkh: callerPkh,
    capabilities: capsHex.map(capabilityText), stakeLovelace: plan.stakeLovelace, tokenUnit: plan.tokenUnit,
    lastUpdated: plan.datum.last_updated, validTo: plan.validTo, stakeCooldown: refs.stakeParams.stakeCooldown,
  };
}

/** The reputation address as Lucid derives it from the script hash: test/reputation-build.test.ts pins it equal to REPUTATION_ADDRESS. */
export const reputationAddressFromHash = (): string => credentialToAddress('Mainnet', { type: 'Script', hash: REPUTATION_SCRIPT_HASH });
