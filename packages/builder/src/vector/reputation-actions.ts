// packages/builder/src/vector/reputation-actions.ts
// Keyless builders of the three owner actions on an existing stake of the identity-era Module-3 deployment: IncreaseStake, UpdateCapabilities
// and DecreaseStake. They share the rules, the deployment values and the helpers of reputation-build.ts, which also holds the two steps
// that make a stake. Each builder checks the rules of the deployed validator (stake_validation.ak) before it builds, so that a refusal names
// the rule, then Lucid runs the deployed script on the transaction and the unsigned CBOR comes back with every key hash that must sign it.
// Nothing here signs or submits. The plan functions are pure; the assemble functions are exported so that a test can hand one a plan that
// breaks a rule and see the validator refuse it.
import { credentialToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, TxBuilder, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { didOf, recordWithAncestors, requireRecord, signedByResult, uniqueUtxos, walletOf, windowAt } from './identity-chain.js';
import type { RecordUtxo, SignedByBuild, Window } from './identity-chain.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';
import { hasCapability, keyHashOf } from './identity-rules.js';
import { formatOutRef } from './marketplace-datum.js';
import {
  INCREASE_STAKE_REDEEMER, agentOutputs, assertActive, assertIdentityRegistry, assertVectorMainnet, capabilityList, cooldownWindow, decreaseStakeRedeemer, findOutput,
  minimumOf, payeeOf, pickStake, readModuleReferences, readyAt, stakeAgentId, stakeSigners, stakedCapabilities, updateCapabilitiesRedeemer,
} from './reputation-build.js';
import type { ModuleReferences, StakeAssembly, StakeOut } from './reputation-build.js';
import { REPUTATION_ADDRESS, encodeStakeDatum, outRefText, stakeTokenUnit } from './reputation-datum.js';
import type { StakeDatum, StakeParams } from './reputation-datum.js';
import { capabilityText } from './reputation-read.js';

const ada = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} AP3X`;

/** What every action on an existing stake takes. */
export interface StakeActionCommon extends BuildCommon {
  did: string;
  /** The stake to act on (`<txid>#<index>`), needed when the agent has more than one stake. */
  stakeRef?: string;
}

/** What every action on an existing stake returns about the stake that it continues. */
export interface ContinuedStake {
  /** `<txHash>#<index>` of the continuing stake output after submit. */
  stakeRef: string;
  /** The stake output that the transaction spends. */
  previousRef: string;
  stakeId: string; did: string; ownerKeyHash: string; controllerKeyHash: string; capabilities: string[]; stakeAmount: bigint; stakeLovelace: bigint; lastUpdated: number;
  /** The earliest lower bound of a later UpdateCapabilities or DecreaseStake. */
  readyAt: number;
}

/** The continuing stake output of an action: the same address, the stake token, `lovelace`, and the datum. */
function continuingOutput(tx: TxBuilder, datumHex: string, tokenUnit: string, lovelace: bigint): TxBuilder {
  return tx.pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: datumHex }, { lovelace, [tokenUnit]: 1n });
}

/** What every action reads before it plans: the wallet, the module outputs, the record(s) of the agent and the stake that the action works on. */
interface ActionData { did: string; wallet: { keyHash: string; utxos: UTxO[] }; refs: ModuleReferences; chain: RecordUtxo[]; stake: StakeOut }

/**
 * Reads what an action needs, after the checks that need no chain read (the DID form, the identity registry of the server, the node on
 * mainnet). An exit (`ownRecordOnly`) reads the record as it is, whatever its status (a revoked or retired record can exit), and no ancestor.
 */
async function readAction(ctx: IdentityContext, p: StakeActionCommon, ownRecordOnly: boolean): Promise<ActionData> {
  const { lucid, provider, deployment } = ctx;
  const id = stakeAgentId(p.did);
  const did = didOf(id);
  assertIdentityRegistry(deployment);
  await assertVectorMainnet(provider);
  const wallet = await walletOf(lucid, p.changeAddress);
  const refs = await readModuleReferences(provider);
  const chain = ownRecordOnly ? [await requireRecord(provider, deployment, id, 'record of the agent')] : await recordWithAncestors(provider, deployment, id, 'record of the agent');
  const stake = pickStake((await agentOutputs(provider, id)).stakes, did, p.stakeRef);
  return { did, wallet, refs, chain, stake };
}

/** The description of the continuing stake output of a built transaction. */
function continued(result: SignedByBuild, stake: StakeOut, datum: StakeDatum, controllerKeyHash: string, params: StakeParams, tokenUnit: string, did: string): ContinuedStake {
  const out = findOutput(result.txCbor, { address: REPUTATION_ADDRESS, unit: tokenUnit, datumHex: encodeStakeDatum(datum) });
  return {
    stakeRef: formatOutRef(result.txHash, out.index), previousRef: stake.ref, stakeId: outRefText(datum.stake_id), did, ownerKeyHash: datum.owner_pkh, controllerKeyHash,
    capabilities: datum.staked_capabilities.map(capabilityText), stakeAmount: datum.stake_amount, stakeLovelace: out.lovelace, lastUpdated: datum.last_updated,
    readyAt: readyAt(datum.last_updated, params),
  };
}

/** A transaction that spends the stake with `redeemerHex`, reads the module outputs and the records, and lists the signers. */
function stakeSpend(lucid: LucidEvolution, a: StakeAssembly & { stake: UTxO }, redeemerHex: string): TxBuilder {
  return lucid.newTx().readFrom(uniqueUtxos([a.refs.script, a.refs.params, a.refs.crossRefs, ...a.records])).collectFrom([a.stake], redeemerHex);
}

/** Lists the signers, sets the window, and lets Lucid run the deployed validator and balance the transaction (coin selection also pays the fee of the reference script). */
function finish(tx: TxBuilder, signerKeyHashes: string[], window: Window): Promise<TxSignBuilder> {
  let signed = tx;
  for (const hash of signerKeyHashes) signed = signed.addSignerKey(hash);
  return signed.validFrom(window.lo).validTo(window.hi).complete();
}

// ─── IncreaseStake ─────────────────────────────────────────────────────────

export interface StakeIncreasePlan {
  datum: StakeDatum; datumHex: string; lovelace: bigint; tokenUnit: string; window: Window; controllerKeyHash: string; ownerKeyHash: string; redeemerHex: string;
}

/**
 * Pure. What IncreaseStake must say: the stake datum with a larger `stake_amount` and `last_updated` the upper bound of the window (every other
 * field stays, the challenge locks included), the output holding the AP3X of the spent stake plus the amount, and the signers. The record
 * must be Active over the window and list each capability that the stake backs now.
 */
export function planStakeIncrease(p: { chain: RecordUtxo[]; did: string; stake: StakeOut; addLovelace: bigint; window: Window }): StakeIncreasePlan {
  const [self] = p.chain;
  const { datum: old } = p.stake;
  if (p.addLovelace <= 0n) throw new Error('The amount to add must be more than 0.');
  assertActive(p.chain, p.window);
  const unlisted = old.staked_capabilities.filter((c) => !hasCapability(self.record, c));
  if (unlisted.length > 0) {
    throw new Error(`The record of ${p.did} no longer lists ${capabilityList(unlisted)}, which the stake backs. IncreaseStake needs a record that lists each staked capability (validate_increase_stake rule 4): change the staked capabilities first with vector_build_reputation_stake_update_capabilities.`);
  }
  const stakeAmount = old.stake_amount + p.addLovelace;
  const datum: StakeDatum = { ...old, stake_amount: stakeAmount, last_updated: p.window.hi };
  const held = p.stake.utxo.assets.lovelace + p.addLovelace;
  return {
    datum, datumHex: encodeStakeDatum(datum), lovelace: held > stakeAmount ? held : stakeAmount, tokenUnit: stakeTokenUnit(self.id), window: p.window,
    controllerKeyHash: keyHashOf(self.record.controller), ownerKeyHash: old.owner_pkh, redeemerHex: INCREASE_STAKE_REDEEMER,
  };
}

/** The IncreaseStake transaction as the plan says (see assembleStakeCreate in reputation-build.ts). */
export function assembleStakeIncrease(lucid: LucidEvolution, a: StakeAssembly & { stake: UTxO; plan: StakeIncreasePlan }): Promise<TxSignBuilder> {
  const { plan } = a;
  return finish(continuingOutput(stakeSpend(lucid, a, plan.redeemerHex), plan.datumHex, plan.tokenUnit, plan.lovelace), a.signerKeyHashes, plan.window);
}

export interface StakeIncreaseParams extends StakeActionCommon {
  /** The AP3X to add. */
  addLovelace: bigint;
}
export interface StakeIncreaseBuild extends SignedByBuild, ContinuedStake { addedLovelace: bigint }

/**
 * Adds AP3X to a stake (IncreaseStake). The cooldown does not apply. The controller of the agent and the owner of the stake sign, and the
 * wallet, which pays the AP3X and the fee. The record must list each capability that the stake backs and be Active over the window.
 */
export async function buildStakeIncrease(ctx: IdentityContext, p: StakeIncreaseParams): Promise<StakeIncreaseBuild> {
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const { did, wallet, refs, chain, stake } = await readAction(ctx, p, false);
  const plan = planStakeIncrease({ chain, did, stake, addLovelace: p.addLovelace, window });
  const signers = stakeSigners(plan.controllerKeyHash, did, plan.ownerKeyHash);
  const completed = await assembleStakeIncrease(ctx.lucid, { refs, records: chain.map((r) => r.utxo), stake: stake.utxo, plan, signerKeyHashes: signers.hashes() });
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  return { ...result, ...continued(result, stake, plan.datum, plan.controllerKeyHash, refs.stakeParams, plan.tokenUnit, did), addedLovelace: p.addLovelace };
}

// ─── UpdateCapabilities ────────────────────────────────────────────────────

export interface StakeCapabilitiesPlan {
  datum: StakeDatum; datumHex: string; lovelace: bigint; tokenUnit: string; window: Window; capabilities: string[];
  controllerKeyHash: string; ownerKeyHash: string; redeemerHex: string;
}

/**
 * Pure. What UpdateCapabilities must say: the redeemer and the datum list the new capabilities (not empty, none twice, each one the record
 * lists), `last_updated` is the upper bound of the window, every other field stays, and the output holds what the spent stake held. The
 * record must be Active over the window and no challenge may lock the stake. The cooldown is the window's: see cooldownWindow.
 */
export function planStakeCapabilities(p: { chain: RecordUtxo[]; did: string; stake: StakeOut; capabilities: unknown; window: Window }): StakeCapabilitiesPlan {
  const [self] = p.chain;
  const { datum: old } = p.stake;
  const capabilities = stakedCapabilities(p.capabilities, self.record, p.did);
  assertActive(p.chain, p.window);
  if (old.challenge_locks.length > 0) {
    throw new Error(`${old.challenge_locks.length} open challenge(s) lock the stake ${p.stake.ref}: its capabilities cannot change until they close (validate_update_capabilities rule 4). Nothing was built.`);
  }
  const datum: StakeDatum = { ...old, staked_capabilities: capabilities, last_updated: p.window.hi };
  return {
    datum, datumHex: encodeStakeDatum(datum), lovelace: p.stake.utxo.assets.lovelace, tokenUnit: stakeTokenUnit(self.id), window: p.window, capabilities,
    controllerKeyHash: keyHashOf(self.record.controller), ownerKeyHash: old.owner_pkh, redeemerHex: updateCapabilitiesRedeemer(capabilities),
  };
}

/** The UpdateCapabilities transaction as the plan says (see assembleStakeCreate in reputation-build.ts). */
export function assembleStakeCapabilities(lucid: LucidEvolution, a: StakeAssembly & { stake: UTxO; plan: StakeCapabilitiesPlan }): Promise<TxSignBuilder> {
  const { plan } = a;
  return finish(continuingOutput(stakeSpend(lucid, a, plan.redeemerHex), plan.datumHex, plan.tokenUnit, plan.lovelace), a.signerKeyHashes, plan.window);
}

export interface StakeCapabilitiesParams extends StakeActionCommon {
  /** The new capabilities, as text: they replace the staked capabilities, and each must be one the record lists. */
  capabilities: string[];
}
export interface StakeCapabilitiesBuild extends SignedByBuild, ContinuedStake { previousCapabilities: string[] }

/**
 * Replaces the staked capabilities (UpdateCapabilities). The cooldown of the stake must be over at the start of the window, and no
 * challenge may lock the stake. The controller of the agent and the owner of the stake sign, and the wallet. The new list may equal the old
 * one: the action then only records a new `last_updated`.
 */
export async function buildStakeCapabilities(ctx: IdentityContext, p: StakeCapabilitiesParams): Promise<StakeCapabilitiesBuild> {
  const nowMs = p.nowMs ?? Date.now();
  const { did, wallet, refs, chain, stake } = await readAction(ctx, p, false);
  const window = cooldownWindow(nowMs, p.validMinutes, stake.datum, refs.stakeParams);
  const plan = planStakeCapabilities({ chain, did, stake, capabilities: p.capabilities, window });
  const signers = stakeSigners(plan.controllerKeyHash, did, plan.ownerKeyHash);
  const completed = await assembleStakeCapabilities(ctx.lucid, { refs, records: chain.map((r) => r.utxo), stake: stake.utxo, plan, signerKeyHashes: signers.hashes() });
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  return { ...result, ...continued(result, stake, plan.datum, plan.controllerKeyHash, refs.stakeParams, plan.tokenUnit, did), previousCapabilities: stake.datum.staked_capabilities.map(capabilityText) };
}

// ─── DecreaseStake ─────────────────────────────────────────────────────────

export interface StakeDecreasePlan {
  datum: StakeDatum; datumHex: string; tokenUnit: string; window: Window;
  /** What the continuing stake output holds: the AP3X of the spent stake less the amount. */
  lovelace: bigint;
  controllerKeyHash: string; redeemerHex: string; amount: bigint;
  /** The payee of the payout (utils.record_payee) and why it is that key. */
  payee: { keyHash: string; reason: 'owner' | 'controller' };
  /** The address that receives the payout: `changeAddress` when its key is the payee, else the enterprise address of the payee key. */
  payoutAddress: string;
}

/**
 * Pure. What DecreaseStake (an exit) must say: the redeemer and the AP3X taken out; the continuing datum with `stake_amount` reduced by it
 * (at least min_self_stake remains) and `last_updated` the upper bound of the window; the continuing output holding the AP3X of the spent
 * stake less the amount; the payout of the amount to the payee; the controller as the only signer besides the wallet. No challenge may lock
 * the stake. The record can have any status. The cooldown is the window's: see cooldownWindow.
 */
export function planStakeDecrease(p: {
  record: RecordUtxo; did: string; stake: StakeOut; params: StakeParams; amountLovelace: bigint; window: Window; walletKeyHash: string; changeAddress: string;
  payoutMinimum: (address: string) => bigint;
}): StakeDecreasePlan {
  const { datum: old } = p.stake;
  if (p.amountLovelace <= 0n) throw new Error('The amount to take out must be more than 0.');
  const remaining = old.stake_amount - p.amountLovelace;
  if (remaining < p.params.minSelfStake) {
    const most = old.stake_amount > p.params.minSelfStake ? old.stake_amount - p.params.minSelfStake : 0n;
    throw new Error(`The stake counts ${ada(old.stake_amount)}; taking out ${ada(p.amountLovelace)} would leave ${ada(remaining)}, below the module minimum of ${ada(p.params.minSelfStake)} (min_self_stake), which the owner cannot withdraw. The most that can be taken out is ${ada(most)}.`);
  }
  if (old.challenge_locks.length > 0) {
    throw new Error(`${old.challenge_locks.length} open challenge(s) lock the stake ${p.stake.ref}: it cannot decrease until they close (validate_decrease_stake rule 4). Nothing was built.`);
  }
  const payee = payeeOf(p.record.record, old.owner_pkh);
  const payoutAddress = payee.keyHash === p.walletKeyHash ? p.changeAddress : credentialToAddress('Mainnet', { type: 'Key', hash: payee.keyHash });
  const minimum = p.payoutMinimum(payoutAddress);
  if (p.amountLovelace < minimum) throw new Error(`The payout of ${ada(p.amountLovelace)} is below the ledger minimum of an output, ${ada(minimum)}; take out at least that much.`);
  const datum: StakeDatum = { ...old, stake_amount: remaining, last_updated: p.window.hi };
  return {
    datum, datumHex: encodeStakeDatum(datum), lovelace: p.stake.utxo.assets.lovelace - p.amountLovelace, tokenUnit: stakeTokenUnit(p.record.id), window: p.window,
    controllerKeyHash: keyHashOf(p.record.record.controller), redeemerHex: decreaseStakeRedeemer(p.amountLovelace), amount: p.amountLovelace, payee, payoutAddress,
  };
}

/** The DecreaseStake transaction as the plan says (see assembleStakeCreate in reputation-build.ts): the continuing stake is output 0 and the payout output 1. */
export function assembleStakeDecrease(lucid: LucidEvolution, a: StakeAssembly & { stake: UTxO; plan: StakeDecreasePlan }): Promise<TxSignBuilder> {
  const { plan } = a;
  const tx = continuingOutput(stakeSpend(lucid, a, plan.redeemerHex), plan.datumHex, plan.tokenUnit, plan.lovelace).pay.ToAddress(plan.payoutAddress, { lovelace: plan.amount });
  return finish(tx, a.signerKeyHashes, plan.window);
}

export interface StakeDecreaseParams extends StakeActionCommon {
  /** The AP3X to take out. */
  amountLovelace: bigint;
}
export interface StakeDecreaseBuild extends SignedByBuild, ContinuedStake {
  takenLovelace: bigint;
  payee: { keyHash: string; reason: 'owner' | 'controller' };
  payoutAddress: string;
  minSelfStake: bigint;
}

/**
 * Takes AP3X out of a stake (DecreaseStake), down to the module minimum, which the owner cannot withdraw. The cooldown must be over at the start of the
 * window and no challenge may lock the stake. Only the controller of the agent signs (besides the wallet): the owner key of the stake need
 * not. The AP3X go to the payee: the owner key of the stake while the record still declares it, else the controller key. The record can
 * have any status, so a revoked or retired agent can exit.
 */
export async function buildStakeDecrease(ctx: IdentityContext, p: StakeDecreaseParams): Promise<StakeDecreaseBuild> {
  const nowMs = p.nowMs ?? Date.now();
  const { did, wallet, refs, chain, stake } = await readAction(ctx, p, true);
  const window = cooldownWindow(nowMs, p.validMinutes, stake.datum, refs.stakeParams);
  const plan = planStakeDecrease({
    record: chain[0], did, stake, params: refs.stakeParams, amountLovelace: p.amountLovelace, window, walletKeyHash: wallet.keyHash, changeAddress: p.changeAddress,
    payoutMinimum: (address) => minimumOf(ctx.lucid, address),
  });
  const signers = stakeSigners(plan.controllerKeyHash, did);
  const completed = await assembleStakeDecrease(ctx.lucid, { refs, records: [chain[0].utxo], stake: stake.utxo, plan, signerKeyHashes: signers.hashes() });
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  return {
    ...result, ...continued(result, stake, plan.datum, plan.controllerKeyHash, refs.stakeParams, plan.tokenUnit, did), takenLovelace: plan.amount, payee: plan.payee,
    payoutAddress: plan.payoutAddress, minSelfStake: refs.stakeParams.minSelfStake,
  };
}
