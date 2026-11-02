// packages/builder/src/vector/marketplace-advert-build.ts
// Keyless builders of the identity-marketplace advert (Part 2 Section 6.2): post, update and retire. The advert keeps the 13 legacy
// fields and adds agent_id, the agent whose record lists the supplier key and the capability. The contract checks only the supplier's
// signature, that UpdateAdvert keeps supplier_pkh and agent_id and does not lower advertised_at, and that RetireAdvert pays the
// supplier key; the builders also check the listing rule (the record of agent_id is live, independent and Active, and lists the
// supplier key with the transaction purpose and the capability), so that the advert they write is one the indexer lists. Every
// transaction lists the supplier key as a required signer: the listing rule's first condition. Nothing is signed or submitted.
import { Data, Constr, CML, calculateMinLovelaceFromUTxO } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { getAddressDetails } from '@lucid-evolution/lucid';
import { MAX_ESCROW_LOVELACE, MAX_PROCESSING_MS_CEILING, MIN_UTXO_LOVELACE } from './marketplace-constants.js';
import { decodeIdentityAdvertDatum, encodeIdentityAdvertDatum, formatOutRef, parseOutRef, sha256Utf8Hex } from './marketplace-datum.js';
import type { AdvertStatus, IdentityAdvertDatum } from './marketplace-datum.js';
import { assertWalletIs, checkListingRule, enterpriseAddressOf, paymentKeyHashOf } from './marketplace-build.js';
import { readRefScript } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { chainClock, didOf, signedByResult, walletOf, windowAt, SignerList } from './identity-chain.js';
import type { SignedByBuild, Window } from './identity-chain.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';

/** The advert redeemers (Part 2 Section 6.2, legacy order): PostAdvert 0, UpdateAdvert 1, RetireAdvert 2. */
const UPDATE_ADVERT = Data.to(new Constr(1, []));
const RETIRE_ADVERT = Data.to(new Constr(2, []));
/** The detail hash of an advert without a manifest: sha256 of the empty file, as the live adverts carry it. */
export const EMPTY_DETAIL_HASH = sha256Utf8Hex('');
/** The deposit an advert locks by default, as the live adverts do: 2 AP3X, raised to the ledger minimum of the output. */
export const DEFAULT_ADVERT_DEPOSIT = 2_000_000n;

/** What a supplier advertises: the advert's fields that the supplier chooses. */
export interface AdvertTerms {
  capabilityId: string; model: string; maxOutputTokens: number; maxProcessingMs: number;
  priceLovelace: bigint; supplierBondLovelace: bigint; buyerBondLovelace: bigint;
  endpointUrl: string; detailUri: string;
  /** The sha256 of the manifest at detailUri (32 bytes, hex); EMPTY_DETAIL_HASH without one. */
  detailHash: string;
}

export interface AdvertBuild extends SignedByBuild {
  /** `<txHash>#<index>` of the advert output after submit; null for a retirement. */
  advertRef: string | null;
  /** The advert the transaction writes (post, update) or ends (retire). */
  advert: IdentityAdvertDatum;
  did: string; agentId: string;
  /** The AP3X of the advert output (post, update) or of the payout to the supplier key (retire). */
  depositLovelace: bigint;
  /** Where a retirement pays the deposit; null otherwise. */
  paidTo: string | null;
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The problems of an advert's terms, in words; empty when the advert can be hired (planPostEscrow takes it). */
export function advertProblems(t: AdvertTerms): string[] {
  const problems: string[] = [];
  const say = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  say(bytes(t.capabilityId) >= 1 && bytes(t.capabilityId) <= 64, 'capability_id must be 1 to 64 bytes (a record capability is)');
  say(bytes(t.model) >= 1 && bytes(t.model) <= 64, 'model must be 1 to 64 bytes');
  say(Number.isSafeInteger(t.maxOutputTokens) && t.maxOutputTokens >= 0, 'max_output_tokens must be a whole number of at least 0');
  say(Number.isSafeInteger(t.maxProcessingMs) && t.maxProcessingMs >= 1 && t.maxProcessingMs <= MAX_PROCESSING_MS_CEILING, `max_processing_ms must be 1 to ${MAX_PROCESSING_MS_CEILING} (24 h): a Post locks a buyer's funds for that window`);
  const amounts = [t.priceLovelace, t.supplierBondLovelace, t.buyerBondLovelace];
  say(amounts.every((a) => a >= 0n), 'the price and both bonds must be at least 0');
  say(amounts.reduce((a, b) => a + b, 0n) <= MAX_ESCROW_LOVELACE, 'price + both bonds must be at most 10,000 AP3X: an escrow above the value cap cannot be claimed (F-29), and the indexer does not list such an advert');
  let https = false;
  try { const url = new URL(t.endpointUrl); https = url.protocol === 'https:' && url.host !== ''; } catch { /* refused below */ }
  say(https && bytes(t.endpointUrl) <= 256, 'endpoint_url must be an https URL with a host, at most 256 bytes: buyers send jobs there');
  say(bytes(t.detailUri) <= 256, 'detail_uri must be at most 256 bytes');
  say(/^[0-9a-f]{64}$/.test(t.detailHash), 'detail_hash must be 32 bytes of lowercase hex (the sha256 of the manifest)');
  return problems;
}

/** The advert datum of `terms`, with the fixed fields. */
function advertDatumOf(t: AdvertTerms, fixed: { supplierPkh: string; agentId: string; advertisedAt: number; status: AdvertStatus }): IdentityAdvertDatum {
  return {
    supplier_pkh: fixed.supplierPkh, capability_id: t.capabilityId, model: t.model, max_output_tokens: t.maxOutputTokens, max_processing_ms: t.maxProcessingMs,
    price_lovelace: t.priceLovelace, supplier_bond_lovelace: t.supplierBondLovelace, buyer_bond_lovelace: t.buyerBondLovelace,
    endpoint_url: t.endpointUrl, detail_uri: t.detailUri, detail_hash: t.detailHash, advertised_at: fixed.advertisedAt, status: fixed.status, agent_id: fixed.agentId,
  };
}

/** The terms an advert datum holds. */
export function advertTermsOf(d: IdentityAdvertDatum): AdvertTerms {
  return {
    capabilityId: d.capability_id, model: d.model, maxOutputTokens: d.max_output_tokens, maxProcessingMs: d.max_processing_ms,
    priceLovelace: d.price_lovelace, supplierBondLovelace: d.supplier_bond_lovelace, buyerBondLovelace: d.buyer_bond_lovelace,
    endpointUrl: d.endpoint_url, detailUri: d.detail_uri, detailHash: d.detail_hash,
  };
}

/** The ledger minimum of an advert output holding `datumHex` (the protocol parameters come from the node). */
function advertMinimum(lucid: LucidEvolution, deployment: IdentityDeployment, datumHex: string): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of the advert output is unknown.');
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address: deployment.advert.address, assets: { lovelace: 0n }, datum: datumHex });
}

/** The deposit of an advert output: the caller's (at least the ledger minimum), else `fallback` raised to the ledger minimum. */
function depositFor(lucid: LucidEvolution, deployment: IdentityDeployment, datumHex: string, given: bigint | undefined, fallback: bigint): bigint {
  const minimum = advertMinimum(lucid, deployment, datumHex);
  if (given !== undefined) {
    if (given < minimum) throw new Error(`The deposit of ${given} lovelace is below the ledger minimum of this advert output (${minimum} lovelace).`);
    return given;
  }
  return fallback > minimum ? fallback : minimum;
}

/** The index of the only output at `address` in the built transaction. */
function outputIndexAt(txCbor: string, address: string): number {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  for (let i = 0; i < outputs.len(); i++) if (outputs.get(i).address().to_bech32() === address) return i;
  throw new Error('The built transaction has no advert output; nothing is returned.');
}

/** The advert `advertRef` on the node: an unspent output with the advert script's credential and a 14-field advert datum. */
async function readAdvertUtxo(ctx: IdentityContext, advertRef: string): Promise<{ utxo: UTxO; advert: IdentityAdvertDatum; ref: string }> {
  const parsed = parseOutRef(advertRef);
  const ref = formatOutRef(parsed.txHash, parsed.outputIndex);
  const [utxo] = await ctx.provider.getUtxosByOutRef([parsed]);
  if (!utxo) throw new Error(`Advert ${ref} is not an unspent output on the node: it has been retired or replaced, or it is not confirmed yet.`);
  let credential: string | undefined;
  try { const c = getAddressDetails(utxo.address).paymentCredential; credential = c?.type === 'Script' ? c.hash : undefined; } catch { /* refused below */ }
  if (credential !== ctx.deployment.advert.hash) throw new Error(`UTxO ${ref} is not at the identity-marketplace advert address.`);
  if (!utxo.datum) throw new Error(`UTxO ${ref} has no inline datum.`);
  let advert: IdentityAdvertDatum;
  try { advert = decodeIdentityAdvertDatum(utxo.datum); } catch (err) { throw new Error(`UTxO ${ref} does not hold an identity-marketplace advert: ${err instanceof Error ? err.message : String(err)}`); }
  return { utxo, advert, ref };
}

/** The supplier key as a signer: the listing rule needs its signature on every advert transaction. */
const supplierSigner = (supplierPkh: string): SignerList => new SignerList().add(supplierPkh, 'supplier key (the advert names it; the listing rule needs its signature)');

/** The start of the advert's time: now, on a whole second (the window opens a minute before). */
const advertisedAtOf = (window: Window): number => window.lo + 60_000;

export interface AdvertPostParams extends BuildCommon {
  /** The identifier of the agent whose record lists the supplier key and the capability. */
  agentId: string;
  /** The supplier key hash (28 bytes, hex); default the wallet's key. */
  supplierPkh?: string;
  terms: AdvertTerms;
  /** The AP3X the advert locks; default 2 AP3X, raised to the ledger minimum. */
  depositLovelace?: bigint;
}

/**
 * Builds the unsigned post of a new identity-marketplace advert: one output at the deployment's advert address with the advert datum
 * (status Active, advertised_at = now on a whole second, agent_id) and the deposit. Refuses terms that buyers could not hire
 * (advertProblems) and an agent that fails the listing rule over the window (checkListingRule). The supplier key signs; no script
 * runs, so no collateral is needed.
 */
export async function buildAdvertPost(ctx: IdentityContext, p: AdvertPostParams): Promise<AdvertBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const walletKeyHash = paymentKeyHashOf(p.changeAddress);
  await assertWalletIs(lucid, p.changeAddress);
  const supplierPkh = (p.supplierPkh ?? walletKeyHash).toLowerCase();
  const problems = advertProblems(p.terms);
  if (problems.length > 0) throw new Error(`The advert cannot be posted: ${problems.join('; ')}.`);
  const advert = advertDatumOf(p.terms, { supplierPkh, agentId: p.agentId, advertisedAt: advertisedAtOf(window), status: 'Active' });
  await checkListingRule(provider, deployment, advert, 'the new advert', window);
  const datumHex = encodeIdentityAdvertDatum(advert);
  const deposit = depositFor(lucid, deployment, datumHex, p.depositLovelace, DEFAULT_ADVERT_DEPOSIT);
  const signers = supplierSigner(supplierPkh);
  let tx = lucid.newTx()
    .pay.ToAddressWithData(deployment.advert.address, { kind: 'inline', value: datumHex }, { lovelace: deposit })
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const result = signedByResult(await tx.complete(), window, signers, walletKeyHash);
  return {
    ...result, advertRef: formatOutRef(result.txHash, outputIndexAt(result.txCbor, deployment.advert.address)), advert,
    did: didOf(p.agentId), agentId: p.agentId, depositLovelace: deposit, paidTo: null,
  };
}

export interface AdvertUpdateParams extends BuildCommon {
  advertRef: string;
  /** The terms to change; the others stay. */
  changes: Partial<AdvertTerms> & { status?: AdvertStatus };
  /** The AP3X of the new advert output; default what the advert holds, raised to the ledger minimum. */
  depositLovelace?: bigint;
}

/**
 * Builds the unsigned UpdateAdvert of an identity-marketplace advert (advert/rules.ak update): the advert input with the advert
 * reference script, and exactly one output at the advert address with the new datum, which keeps supplier_pkh and agent_id and does
 * not lower advertised_at (it becomes now, or stays when that is later). The supplier key signs. An update that leaves the advert
 * Active must pass the listing rule; one that sets it Retired need not.
 */
export async function buildAdvertUpdate(ctx: IdentityContext, p: AdvertUpdateParams): Promise<AdvertBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const { utxo, advert: old, ref } = await readAdvertUtxo(ctx, p.advertRef);
  const { status, ...termChanges } = p.changes;
  const terms: AdvertTerms = { ...advertTermsOf(old), ...Object.fromEntries(Object.entries(termChanges).filter(([, v]) => v !== undefined)) };
  const problems = advertProblems(terms);
  if (problems.length > 0) throw new Error(`The advert cannot be updated: ${problems.join('; ')}.`);
  const advertisedAt = Math.max(old.advertised_at, advertisedAtOf(window));
  const advert = advertDatumOf(terms, { supplierPkh: old.supplier_pkh, agentId: old.agent_id, advertisedAt, status: status ?? old.status });
  if (advert.status === 'Active') await checkListingRule(provider, deployment, advert, ref, window);
  const datumHex = encodeIdentityAdvertDatum(advert);
  const deposit = depositFor(lucid, deployment, datumHex, p.depositLovelace, utxo.assets.lovelace);
  const signers = supplierSigner(old.supplier_pkh);
  let tx = lucid.newTx()
    .readFrom([await readRefScript(provider, deployment, 'advert', deployment.advert.hash)])
    .collectFrom([utxo], UPDATE_ADVERT)
    .pay.ToAddressWithData(deployment.advert.address, { kind: 'inline', value: datumHex }, { lovelace: deposit })
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const result = signedByResult(await tx.complete(), window, signers, wallet.keyHash);
  return {
    ...result, advertRef: formatOutRef(result.txHash, outputIndexAt(result.txCbor, deployment.advert.address)), advert,
    did: didOf(old.agent_id), agentId: old.agent_id, depositLovelace: deposit, paidTo: null,
  };
}

/**
 * Builds the unsigned RetireAdvert of an identity-marketplace advert (advert/rules.ak retire): the advert input with the advert
 * reference script, the supplier key signs, and the deposit goes to the supplier key: to the wallet when the wallet is the supplier
 * key's, else to the enterprise address of the supplier key.
 */
export async function buildAdvertRetire(ctx: IdentityContext, p: BuildCommon & { advertRef: string }): Promise<AdvertBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const { utxo, advert } = await readAdvertUtxo(ctx, p.advertRef);
  const paidTo = wallet.keyHash === advert.supplier_pkh ? p.changeAddress : enterpriseAddressOf(advert.supplier_pkh);
  const lovelace = utxo.assets.lovelace < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : utxo.assets.lovelace;
  const signers = supplierSigner(advert.supplier_pkh);
  let tx = lucid.newTx()
    .readFrom([await readRefScript(provider, deployment, 'advert', deployment.advert.hash)])
    .collectFrom([utxo], RETIRE_ADVERT)
    .pay.ToAddress(paidTo, { lovelace })
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const result = signedByResult(await tx.complete(), window, signers, wallet.keyHash);
  return { ...result, advertRef: null, advert, did: didOf(advert.agent_id), agentId: advert.agent_id, depositLovelace: lovelace, paidTo };
}
