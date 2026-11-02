// packages/builder/src/vector/vault-build.ts
// Keyless builders of the vault (Part 2 Section 5.3; contracts vault/handlers.ak): open a vault for a delegation, pay identity-
// marketplace escrows from it as the delegate (Pay), and close vaults as the owner (Close). A vault output is AP3X only with the datum
// Live { owner, delegation, spent, period_start } or Returned { owner } (an escrow refund). Each builder checks the rules it can check
// before it builds, so that a refusal names the rule; the vault script then runs on the build (local evaluation of the applied script
// that the reference input holds). Nothing is signed or submitted.
import { calculateMinLovelaceFromUTxO, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { encodeVaultDatum, encodeVaultSpend, decodeVaultDatum, plutusAddressFromBech32, sameDelegator } from './identity-codec.js';
import type { Delegator, ValueLimit, VaultDatum } from './identity-codec.js';
import { readRefScript } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import {
  chainClock, chainRecords, delegationChain, didOf, findDelegation, recordsById, requireRecord, signedByResult, uniqueUtxos, walletOf, windowAt, SignerList,
} from './identity-chain.js';
import type { SignedByBuild, Window } from './identity-chain.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';
import { HIRE_ACTION, delegationUseProblems, escrowResource, patternsCover, patternsOf } from './delegation-build.js';
import {
  assertIndexerLists, assertWalletIs, assertEscrowIsOutputZero, checkListingRule, paymentKeyHashOf, planVaultEscrow, readHireableAdvert,
} from './marketplace-build.js';
import { formatOutRef, parseOutRef } from './marketplace-datum.js';

const VAULT_PAY = encodeVaultSpend({ type: 'Pay' });
const VAULT_CLOSE = encodeVaultSpend({ type: 'Close' });

/** The text of an owner, for messages and facts. */
export const ownerText = (owner: Delegator): string =>
  (owner.type === 'Agent' ? `agent ${didOf(owner.id)}` : `principal key ${owner.hash}${owner.organisation === null ? '' : ` (organisation ${Buffer.from(owner.organisation, 'hex').toString('utf8')})`}`);

/** The ledger minimum of a vault output holding `datum` (the protocol parameters come from the node). */
function vaultMinimum(lucid: LucidEvolution, deployment: IdentityDeployment, datum: VaultDatum): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of the vault output is unknown.');
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address: deployment.vault.address, assets: { lovelace: 0n }, datum: encodeVaultDatum(datum) });
}

/** A vault output on the node: an unspent output with the vault script's credential and a vault datum. */
interface VaultUtxo { ref: string; utxo: UTxO; vault: VaultDatum }
async function readVault(ctx: IdentityContext, vaultRef: string): Promise<VaultUtxo> {
  const parsed = parseOutRef(vaultRef);
  const ref = formatOutRef(parsed.txHash, parsed.outputIndex);
  const [utxo] = await ctx.provider.getUtxosByOutRef([parsed]);
  if (!utxo) throw new Error(`Vault ${ref} is not an unspent output on the node: it has been spent or closed, or it is not confirmed yet.`);
  let credential: string | undefined;
  try { const c = getAddressDetails(utxo.address).paymentCredential; credential = c?.type === 'Script' ? c.hash : undefined; } catch { /* refused below */ }
  if (credential !== ctx.deployment.vault.hash) throw new Error(`UTxO ${ref} is not at the vault address.`);
  if (!utxo.datum) throw new Error(`Vault ${ref} has no inline datum.`);
  let vault: VaultDatum;
  try { vault = decodeVaultDatum(utxo.datum); } catch (err) { throw new Error(`Vault ${ref} does not hold a vault datum: ${err instanceof Error ? err.message : String(err)}`); }
  return { ref, utxo, vault };
}

// ─── Open ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The owner of a new vault: an agent, or a principal key whose organisation defaults to the delegation's when its key is the delegator's. */
export type VaultOwnerInput = { type: 'Agent'; id: string } | { type: 'PrincipalKey'; hash: string; /** UTF-8 bytes as hex. */ organisation?: string | null };

export interface VaultOpenParams extends BuildCommon {
  /** The token name of the delegation that the vault pays under. */
  delegation: string;
  /** Default: the wallet's key as a principal key. */
  owner?: VaultOwnerInput;
  /** The AP3X the vault locks; at least the ledger minimum of the vault output. */
  amountLovelace: bigint;
}

export interface VaultOpenBuild extends SignedByBuild {
  /** `<txHash>#<index>` of the new vault output after submit. */
  vaultRef: string;
  owner: Delegator; delegation: string; amountLovelace: bigint;
  /** The delegation's value limit, which every payment from the vault keeps to. */
  limit: ValueLimit;
}

/**
 * Builds the unsigned opening of a vault: one AP3X-only output at the vault address with the datum Live { owner, delegation,
 * spent: 0, period_start: 0 }. Refuses a delegation that does not exist (or was undelegated), whose delegator is not the owner, that
 * has no value limit, or that does not cover the action marketplace.hire.v1 on the resource script:<escrow hash> (Part 2 Section 5.1):
 * a vault for it could never pay. No script runs, so no collateral is needed; only the wallet signs.
 */
export async function buildVaultOpen(ctx: IdentityContext, p: VaultOpenParams): Promise<VaultOpenBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const walletKeyHash = paymentKeyHashOf(p.changeAddress);
  await assertWalletIs(lucid, p.changeAddress);
  const found = await findDelegation(provider, deployment, p.delegation);
  if (!found) throw new Error(`No live delegation ${p.delegation}: it does not exist or has been undelegated.`);
  const d = found.delegation;
  const given: VaultOwnerInput = p.owner ?? { type: 'PrincipalKey', hash: walletKeyHash };
  const owner: Delegator = given.type === 'Agent' ? given : {
    type: 'PrincipalKey', hash: given.hash.toLowerCase(),
    organisation: given.organisation !== undefined ? given.organisation : (d.delegator.type === 'PrincipalKey' && d.delegator.hash === given.hash.toLowerCase() ? d.delegator.organisation : null),
  };
  if (!sameDelegator(d.delegator, owner)) throw new Error(`The delegator of delegation ${p.delegation} is ${ownerText(d.delegator)}, not the owner ${ownerText(owner)}: a vault pays only under a delegation of its owner (Part 2 Section 5.3).`);
  if (d.value === null) throw new Error(`Delegation ${p.delegation} has no value limit, and a vault pays only under one (Part 2 Section 5.3).`);
  const resource = escrowResource(deployment.escrow.hash);
  if (!patternsCover(patternsOf(d.actions), HIRE_ACTION)) throw new Error(`Delegation ${p.delegation} does not cover the action ${HIRE_ACTION}, so a vault could never pay under it.`);
  if (!patternsCover(patternsOf(d.resources), resource)) throw new Error(`Delegation ${p.delegation} does not cover the resource ${resource} (the escrow script), so a vault could never pay under it.`);
  const datum: VaultDatum = { type: 'Live', owner, delegation: p.delegation, spent: 0n, periodStart: 0 };
  const minimum = vaultMinimum(lucid, deployment, datum);
  if (p.amountLovelace < minimum) throw new Error(`A vault output needs at least ${minimum} lovelace (the ledger minimum); ${p.amountLovelace} is less.`);
  const tx = lucid.newTx()
    .pay.ToAddressWithData(deployment.vault.address, { kind: 'inline', value: encodeVaultDatum(datum) }, { lovelace: p.amountLovelace })
    .validFrom(window.lo)
    .validTo(window.hi);
  const result = signedByResult(await tx.complete(), window, new SignerList(), walletKeyHash);
  return { ...result, vaultRef: formatOutRef(result.txHash, 0), owner, delegation: p.delegation, amountLovelace: p.amountLovelace, limit: d.value };
}

// ─── Pay ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VaultPayParams extends BuildCommon {
  /** The Live vault output that pays. */
  vaultRef: string;
  /** The identity-marketplace advert to hire. */
  advertRef: string;
  /** The job payload exactly as it will be sent. */
  payload: string;
}

export interface VaultPayBuild extends SignedByBuild {
  /** `<txHash>#0`: the new escrow (output 0). */
  escrowRef: string;
  /** `<txHash>#1`: the continuing vault output. */
  vaultRef: string;
  /** What the escrow output holds: payment + both bonds, which is what the vault pays. */
  amountLovelace: bigint;
  /** What the vault keeps. */
  vaultLovelace: bigint;
  spent: bigint; periodStart: number; newPeriod: boolean;
  limit: ValueLimit;
  delegateKey: string; owner: Delegator; agentId: string; did: string;
  deliverBy: number; promptHash: string; priceLovelace: bigint; supplierBondLovelace: bigint; buyerBondLovelace: bigint;
}

/**
 * Builds the unsigned Pay of a Live vault (vault/handlers.ak pay): the delegate of the vault's delegation hires an identity-
 * marketplace advert. The advert must be listed (the indexer and the listing rule on chain, as for a Post). The transaction spends the
 * vault (the only script input), reads the vault script, the delegation chain and the records its use checks read (reference inputs),
 * pays one escrow at output 0 (planVaultEscrow: buyer_pkh = the delegate key, refund = the vault address with the datum
 * Returned { owner }, payment + both bonds exactly the output's AP3X) and one continuing vault output at output 1 with the new
 * spent and period_start. Refuses before it builds: a vault that is not Live or holds other assets, a delegation that fails the use
 * checks of Part 2 Section 5.2 for marketplace.hire.v1 on the escrow script, whose delegator is not the owner, or that has no value
 * limit, an amount above per_tx or a period total above total, and a vault too small to keep its minimum output. The delegate key
 * signs. `fetchImpl` stands in for fetch in the Koios and indexer calls (tests).
 */
export async function buildVaultPay(ctx: IdentityContext, p: VaultPayParams, fetchImpl: typeof fetch = fetch): Promise<VaultPayBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window: Window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const { ref: vaultRef, utxo, vault } = await readVault(ctx, p.vaultRef);
  if (vault.type !== 'Live') throw new Error(`Vault ${vaultRef} holds an escrow refund (Returned): only its owner can close it, and it cannot pay.`);
  if (Object.keys(utxo.assets).some((unit) => unit !== 'lovelace')) throw new Error(`Vault ${vaultRef} holds assets other than AP3X, so it cannot pay (vault decision 5); its owner can close it.`);

  const chain = await delegationChain(provider, deployment, vault.delegation);
  const leaf = chain[0].delegation;
  if (!sameDelegator(leaf.delegator, vault.owner)) throw new Error(`The delegator of delegation ${vault.delegation} is not the owner of vault ${vaultRef}.`);
  const limit = leaf.value;
  if (limit === null) throw new Error(`Delegation ${vault.delegation} has no value limit, and a vault pays only under one (Part 2 Section 5.3).`);
  const records = await chainRecords(provider, deployment, chain);
  const problems = delegationUseProblems(chain, recordsById(records), HIRE_ACTION, escrowResource(deployment.escrow.hash), window);
  if (problems.length > 0) throw new Error(`The delegation ${vault.delegation} cannot be used for this payment (Part 2 Section 5.2): ${problems.join('; ')}.`);

  const advert = await readHireableAdvert(p.advertRef, fetchImpl, deployment);
  if (advert.layout !== 'identity') throw new Error(`Advert ${advert.ref} is a legacy advert; a vault pays only identity-marketplace escrows.`);
  const refund = { address: plutusAddressFromBech32(deployment.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner: vault.owner }) };
  const plan = planVaultEscrow(advert.advert, advert.ref, leaf.delegateKey, p.payload, window, { agentId: advert.agentId, refund });
  await assertIndexerLists(advert.ref, advert.agentId, fetchImpl);
  await checkListingRule(provider, deployment, advert.advert, advert.ref, window);

  const amount = plan.lockLovelace;
  if (amount > limit.perTx) throw new Error(`The payment of ${amount} lovelace is above the per-transaction limit of delegation ${vault.delegation} (${limit.perTx}).`);
  const newPeriod = window.lo >= vault.periodStart + limit.periodMs;
  const spent = newPeriod ? amount : vault.spent + amount;
  const periodStart = newPeriod ? window.hi : vault.periodStart;
  if (spent > limit.total) throw new Error(`The payment would bring this period's spending to ${spent} lovelace, above the total limit of delegation ${vault.delegation} (${limit.total}).`);
  const next: VaultDatum = { type: 'Live', owner: vault.owner, delegation: vault.delegation, spent, periodStart };
  const kept = utxo.assets.lovelace - amount;
  const minimum = vaultMinimum(lucid, deployment, next);
  if (kept < minimum) throw new Error(`Vault ${vaultRef} holds ${utxo.assets.lovelace} lovelace: after the payment of ${amount} it would keep ${kept}, below the ${minimum} its output needs. Pay less, or have the owner add to a new vault.`);

  const signers = new SignerList().add(leaf.delegateKey, `delegate key of delegation ${vault.delegation}`);
  const refs = uniqueUtxos([await readRefScript(provider, deployment, 'vault', deployment.vault.hash), ...chain.map((link) => link.utxo), ...records.map((r) => r.utxo)]);
  let tx = lucid.newTx()
    .readFrom(refs)
    .collectFrom([utxo], VAULT_PAY)
    .pay.ToAddressWithData(deployment.escrow.address, { kind: 'inline', value: plan.datumHex }, { lovelace: amount })
    .pay.ToAddressWithData(deployment.vault.address, { kind: 'inline', value: encodeVaultDatum(next) }, { lovelace: kept })
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const result = signedByResult(await tx.complete(), window, signers, wallet.keyHash);
  assertEscrowIsOutputZero(result.txCbor, { datumHex: plan.datumHex, lockLovelace: amount, address: deployment.escrow.address });
  return {
    ...result, escrowRef: formatOutRef(result.txHash, 0), vaultRef: formatOutRef(result.txHash, 1), amountLovelace: amount, vaultLovelace: kept,
    spent, periodStart, newPeriod, limit, delegateKey: leaf.delegateKey, owner: vault.owner, agentId: advert.agentId, did: didOf(advert.agentId),
    deliverBy: plan.deliverBy, promptHash: plan.datum.prompt_hash, priceLovelace: plan.priceLovelace, supplierBondLovelace: plan.supplierBondLovelace, buyerBondLovelace: plan.buyerBondLovelace,
  };
}

// ─── Close ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VaultCloseBuild extends SignedByBuild {
  /** The vaults the transaction closes, with what each held. */
  vaults: Array<{ ref: string; vault: VaultDatum; lovelace: bigint }>;
  /** Their AP3X together: it goes to the wallet, less the fee. */
  totalLovelace: bigint;
}

/**
 * Builds the unsigned Close of one or more vault outputs, Live or Returned, also after Undelegate (vault/handlers.ak owner_signed): the
 * owner of each signs, as a principal key, or for an agent owner as the agent's controller with the agent's record as a reference input.
 * Everything the vaults hold goes to the wallet as change.
 */
export async function buildVaultClose(ctx: IdentityContext, p: BuildCommon & { vaultRefs: string[] }): Promise<VaultCloseBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  if (p.vaultRefs.length === 0) throw new Error('Name at least one vault output to close.');
  const vaults: VaultUtxo[] = [];
  for (const ref of p.vaultRefs) vaults.push(await readVault(ctx, ref));
  if (new Set(vaults.map((v) => v.ref)).size !== vaults.length) throw new Error('A vault output is named twice.');
  const signers = new SignerList();
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'vault', deployment.vault.hash)];
  for (const { ref, vault } of vaults) {
    if (vault.owner.type === 'PrincipalKey') { signers.add(vault.owner.hash, `owner of vault ${ref}`); continue; }
    const record = await requireRecord(provider, deployment, vault.owner.id, 'record of the vault owner');
    signers.addKey(record.record.controller, `controller of ${didOf(vault.owner.id)}, owner of vault ${ref}`);
    refs.push(record.utxo);
  }
  let tx = lucid.newTx()
    .readFrom(uniqueUtxos(refs))
    .collectFrom(vaults.map((v) => v.utxo), VAULT_CLOSE)
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const result = signedByResult(await tx.complete(), window, signers, wallet.keyHash);
  const listed = vaults.map((v) => ({ ref: v.ref, vault: v.vault, lovelace: v.utxo.assets.lovelace }));
  return { ...result, vaults: listed, totalLovelace: listed.reduce((sum, v) => sum + v.lovelace, 0n) };
}
