// packages/builder/src/vector/marketplace-advert-build.ts
// The advert rules that both layouts share, and the keyless builders of the identity-marketplace advert (Part 2 Section 6.2): post,
// update and retire.
//
// The rules (checkAdvertTerms, detailHashFor) hold for every advert that a tool here writes, in either layout: an advert that they
// accept is one that vector_build_marketplace_post_escrow hires and a supplier template can serve. The legacy Post of
// marketplace-advert.ts applies them too.
//
// The identity advert keeps the 13 legacy fields and adds agent_id, the agent whose record lists the supplier key and the capability.
// The contract checks only the supplier's signature, that UpdateAdvert keeps supplier_pkh and agent_id and does not lower
// advertised_at, and that RetireAdvert pays the supplier key; the builders also check the listing rule (the record of agent_id is
// live, independent and Active, and lists the supplier key with the transaction purpose and the capability), so that the advert they
// write is one the indexer lists. Every transaction lists the supplier key as a required signer: the listing rule's first condition.
// Nothing is signed or submitted.
import { Data, Constr, CML, calculateMinLovelaceFromUTxO, fromText, toText, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import { isIP } from 'node:net';
import {
  ADVERT_DEPOSIT_FLOOR_LOVELACE, ADVERT_SCRIPT_HASH, DATUM_BYTES_MAX, EMPTY_DETAIL_HASH, MAX_ESCROW_LOVELACE, MAX_PROCESSING_MS_CEILING,
  MIN_PROCESSING_MS_FLOOR, MIN_UTXO_LOVELACE,
} from './marketplace-constants.js';
import { decodeIdentityAdvertDatum, encodeIdentityAdvertDatum, formatOutRef, parseOutRef } from './marketplace-datum.js';
import type { AdvertStatus, IdentityAdvertDatum } from './marketplace-datum.js';
import type { AdvertLayout } from './marketplace-indexer.js';
import { nodeFailure } from './marketplace-lineage.js';
import { assertWalletIs, checkListingRule, enterpriseAddressOf, paymentKeyHashOf } from './marketplace-build.js';
import { isFleetCapability } from './marketplace-transport.js';
import { isPrivateAddress } from './safe-fetch.js';
import { cell } from './marketplace-shared.js';
import { IdentityConfigError, NOT_CONFIGURED, readRefScript } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { chainClock, didOf, signedByResult, walletOf, windowAt, SignerList } from './identity-chain.js';
import type { SignedByBuild, Window } from './identity-chain.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';

/** The advert redeemers (Part 2 Section 6.2, legacy order): PostAdvert 0, UpdateAdvert 1, RetireAdvert 2. */
const UPDATE_ADVERT = Data.to(new Constr(1, []));
const RETIRE_ADVERT = Data.to(new Constr(2, []));
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const HASH_HEX = /^[0-9a-fA-F]{64}$/;

// ─── The terms rules of both layouts ────────────────────────────────────────

/** The terms a supplier advertises, in the advert's own units (lovelace, milliseconds, tokens). */
export interface AdvertTerms {
  capabilityId: string; model: string;
  maxOutputTokens: number; maxProcessingMs: number;
  priceLovelace: bigint; supplierBondLovelace: bigint; buyerBondLovelace: bigint;
  endpointUrl: string;
  /** '' when the advert names no manifest. */
  detailUri: string;
  /** sha256 of the bytes detailUri serves, 64 hex; sha256 of no bytes (EMPTY_DETAIL_HASH) when detailUri is ''. */
  detailHash: string;
}

/**
 * The most bytes of UTF-8 that endpoint_url and detail_uri hold in an identity-layout advert (did:vector Part 1 Section 5 allows an
 * endpoint of 256 bytes). The identity layout's encoder (Plutus Data, as Aiken writes it) splits a longer bytestring into 64-byte
 * chunks, so the legacy limit of DATUM_BYTES_MAX does not hold there; capability_id and model keep it in both layouts.
 */
export const IDENTITY_URL_BYTES_MAX = 256;

/**
 * A text field of an advert: what the marketplace's encoder writes is its UTF-8 bytes as one bytestring, so it must be text that
 * survives that round trip (an unpaired surrogate or a leading byte-order mark does not) and fit `maxBytes`. The legacy encoder writes
 * each field as one bytestring, so in the legacy layout every field holds at most the 64 bytes a datum bytestring holds. No control
 * characters: every tool shows these fields on one line.
 */
function textField(name: string, value: unknown, required: boolean, maxBytes: number = DATUM_BYTES_MAX): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  if (required && value.length === 0) throw new Error(`${name} must not be empty.`);
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) throw new Error(`${name} must not contain control characters or line breaks.`);
  const hex = fromText(value);
  if (toText(hex) !== value) throw new Error(`${name} is not text that UTF-8 carries unchanged (an unpaired surrogate, or a leading byte-order mark).`);
  const bytes = hex.length / 2;
  if (bytes > maxBytes) {
    throw new Error(maxBytes === DATUM_BYTES_MAX
      ? `${name} is ${bytes} bytes as UTF-8; an advert field holds at most ${DATUM_BYTES_MAX} (the marketplace writes each field as one bytestring, and the ledger refuses a longer one in a datum).`
      : `${name} is ${bytes} bytes as UTF-8; an identity-layout advert holds at most ${maxBytes} in it.`);
  }
  return value;
}

/**
 * A URL the marketplace tools will call (safeFetch's rules, checked without a network): https (whose URLs always have a host), no
 * credentials, and not an IP literal in a private or reserved range. A name that resolves to such a range is refused when a buyer's
 * call is made; it cannot be known here without a lookup.
 */
function callableUrl(name: string, value: string): void {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`${name} is not a URL.`); }
  if (u.protocol !== 'https:') throw new Error(`${name} must be an https URL: the marketplace tools call https only.`);
  if (u.username || u.password) throw new Error(`${name} must not carry credentials.`);
  const literal = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  if (isIP(literal) && isPrivateAddress(literal)) throw new Error(`${name} points at a private or reserved address; buyers' calls to it would be refused.`);
}

function wholeNumber(name: string, value: unknown, max: number, why = '', min = 0, whyMin = ''): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a whole number from ${min}${whyMin}.`);
  if (value > max) throw new Error(`${name} is ${value}, more than ${max}${why}.`);
  return value;
}

function lovelace(name: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${name} must be a whole number of lovelace from 0.`);
  if (value > MAX_SAFE) throw new Error(`${name} is more than ${MAX_SAFE} lovelace; check the unit (1 AP3X is 1,000,000 lovelace).`);
  return value;
}

/**
 * Pure. The terms of an advert in `layout`, checked: throws a readable Error for terms that must not be posted. The advert would be
 * refused by the ledger (a legacy-layout field over 64 bytes), could never be hired through vector_build_marketplace_post_escrow (a
 * fleet capability id, an endpoint that is not https or that a job URL would not survive, a processing window over 24 h, price + both
 * bonds above the value cap F-29), or no supplier template could serve it (a processing window under MIN_PROCESSING_MS_FLOOR).
 * capability_id and model hold at most 64 bytes in both layouts; endpoint_url and detail_uri hold 64 in the legacy layout and
 * IDENTITY_URL_BYTES_MAX in the identity layout. Returns the terms with the detail hash in lower case.
 */
export function checkAdvertTerms(t: AdvertTerms, layout: AdvertLayout): AdvertTerms {
  const urlBytes = layout === 'legacy' ? DATUM_BYTES_MAX : IDENTITY_URL_BYTES_MAX;
  const capabilityId = textField('capability_id', t.capabilityId, true);
  // vector_build_marketplace_post_escrow refuses fleet capabilities: their suppliers check another hash of the request than the one a
  // Post commits, so vector_marketplace_send_job could never deliver the job. An advert in those namespaces could not be hired here.
  if (isFleetCapability(capabilityId)) throw new Error(`capability_id ${cell(capabilityId)} is in a fleet namespace (llm.text.generate.*, llm.chat.*, ocr.page.extract.* or audio.synthesize.*), which these tools do not hire; name the capability outside those namespaces (for example research.summary.v1).`);
  const model = textField('model', t.model, true);
  const endpointUrl = textField('endpoint_url', t.endpointUrl, true, urlBytes);
  // A job goes to `<endpoint_url>/v1/job` (the template route appends the path to the text, trimming only trailing slashes), so anything
  // that keeps the result from being that path is refused: whitespace (the URL parser drops a trailing space, the route does not), a query
  // or a fragment (the path would land inside it).
  if (/\s/.test(endpointUrl)) throw new Error('endpoint_url must not contain whitespace: jobs are sent to <endpoint_url>/v1/job, and whitespace breaks that URL.');
  if (endpointUrl.includes('?')) throw new Error('endpoint_url must not contain a query (?): jobs are sent to <endpoint_url>/v1/job, and the path would land inside the query.');
  if (endpointUrl.includes('#')) throw new Error('endpoint_url must not contain a fragment (#): jobs are sent to <endpoint_url>/v1/job, and the path would land inside the fragment.');
  callableUrl('endpoint_url', endpointUrl);
  const detailUri = textField('detail_uri', t.detailUri, false, urlBytes);
  if (detailUri !== '') callableUrl('detail_uri', detailUri);
  if (typeof t.detailHash !== 'string' || !HASH_HEX.test(t.detailHash)) throw new Error('detail_hash must be 64 hex characters (the sha256 of the bytes detail_uri serves).');
  const maxOutputTokens = wholeNumber('max_output_tokens', t.maxOutputTokens, Number.MAX_SAFE_INTEGER);
  // The buyer's Post caps the window at 24 h (a buyer cannot reclaim before deliver_by), so a longer one could not be hired.
  // A supplier template starts only when its ADVERT_MAX_PROCESSING_MS is at least SERVICE_TIMEOUT_MS + 60 s, and it refuses jobs for an
  // advert whose window is smaller than that, so no template supplier serves a window under MIN_PROCESSING_MS_FLOOR.
  const maxProcessingMs = wholeNumber('max_processing_ms', t.maxProcessingMs, MAX_PROCESSING_MS_CEILING, ' (24 h), the longest window vector_build_marketplace_post_escrow will hold a buyer\'s escrow for; it is milliseconds, check the unit', MIN_PROCESSING_MS_FLOOR, ': a supplier template needs at least its SERVICE_TIMEOUT_MS + 60000 ms (180000 with the default), so it cannot serve a shorter window');
  const priceLovelace = lovelace('price_lovelace', t.priceLovelace);
  const supplierBondLovelace = lovelace('supplier_bond_lovelace', t.supplierBondLovelace);
  const buyerBondLovelace = lovelace('buyer_bond_lovelace', t.buyerBondLovelace);
  // The value cap F-29 (MAX_ESCROW_LOVELACE): vector_build_marketplace_post_escrow refuses an escrow above it in either layout, and the
  // indexer does not list such an identity advert.
  const economic = priceLovelace + supplierBondLovelace + buyerBondLovelace;
  if (economic > MAX_ESCROW_LOVELACE) throw new Error(`price + both bonds is ${economic} lovelace, above the ${MAX_ESCROW_LOVELACE} lovelace (10,000 AP3X) value cap of an escrow (F-29): vector_build_marketplace_post_escrow would not hire this advert.`);
  return {
    capabilityId, model, maxOutputTokens, maxProcessingMs, priceLovelace, supplierBondLovelace, buyerBondLovelace,
    endpointUrl, detailUri, detailHash: t.detailHash.toLowerCase(),
  };
}

/** Where an advert's detail_hash came from: given by the caller, or the hash of no bytes when there is no detail URI. */
export type DetailHashSource = 'given' | 'empty';

/**
 * The detail_hash of an advert, in either layout. Nothing is fetched: a detail URI needs the caller's detail_hash (the server never
 * fetches a URL a caller gives; vector_marketplace_get_supplier checks the hash against the served bytes once the advert is posted),
 * and without a detail URI the hash is that of no bytes (the supplier template's default) unless the caller gives one. A detail_hash
 * of '' counts as not given, as in the template.
 */
export function detailHashFor(detailUri: string, detailHash: string | undefined): { detailHash: string; source: DetailHashSource } {
  const given = detailHash === '' ? undefined : detailHash;
  if (given === undefined && detailUri !== '') {
    throw new Error('detail_hash is required with a detail_uri: pass the sha256 (64 hex) of the exact bytes detail_uri serves. This server does not fetch it; vector_marketplace_get_supplier checks the hash against the served bytes once the advert is posted.');
  }
  return given === undefined ? { detailHash: EMPTY_DETAIL_HASH, source: 'empty' } : { detailHash: given, source: 'given' };
}

/**
 * The layout of the advert `advertRef`, read from the node: legacy when the output is at the legacy advert script, identity when it is
 * at the deployment's advert script. Refuses an output that is not unspent on the node and one at neither script; without a
 * deployment, an output that is not at the legacy advert script is refused with the words that say how to configure the server.
 */
export async function advertLayoutAt(provider: Provider, advertRef: string, deployment: IdentityDeployment | null): Promise<AdvertLayout> {
  const parsed = parseOutRef(advertRef);
  const ref = formatOutRef(parsed.txHash, parsed.outputIndex);
  let utxo: UTxO | undefined;
  try { [utxo] = await provider.getUtxosByOutRef([parsed]); } catch (err) { throw new Error(`Could not read advert ${ref} from the node: ${nodeFailure(err)}`); }
  if (!utxo) throw new Error(`Advert ${ref} is not an unspent output on the node: it has been retired or replaced, or it is not confirmed yet.`);
  const credential = scriptHashOf(utxo.address);
  if (credential === ADVERT_SCRIPT_HASH) return 'legacy';
  if (deployment === null) throw new IdentityConfigError(`UTxO ${ref} is not at the legacy advert address, and this server cannot read an identity-marketplace advert. ${NOT_CONFIGURED}`);
  if (credential === deployment.advert.hash) return 'identity';
  throw new Error(`UTxO ${ref} is not at an advert script address.`);
}

/** The script hash of an address's payment credential, or undefined (a key credential, or not an address). */
function scriptHashOf(address: string): string | undefined {
  try { const c = getAddressDetails(address).paymentCredential; return c?.type === 'Script' ? c.hash : undefined; } catch { return undefined; }
}

// ─── The identity-marketplace advert ────────────────────────────────────────

export interface AdvertBuild extends SignedByBuild {
  /** `<txHash>#<index>` of the advert output after submit; null for a retirement. */
  advertRef: string | null;
  /** The advert output that the transaction spends (update, retire); null for a post. */
  spentRef: string | null;
  /** The advert the transaction writes (post, update) or ends (retire). */
  advert: IdentityAdvertDatum;
  did: string; agentId: string;
  /** The AP3X of the advert output (post, update) or of the payout to the supplier key (retire). */
  depositLovelace: bigint;
  /** Where a retirement pays the deposit; null otherwise. */
  paidTo: string | null;
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
  if (scriptHashOf(utxo.address) !== ctx.deployment.advert.hash) throw new Error(`UTxO ${ref} is not at the identity-marketplace advert address.`);
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
  /** The terms; detailHash follows detailHashFor (required with a detail URI; '' or absent is the hash of no bytes without one). */
  terms: Omit<AdvertTerms, 'detailHash'> & { detailHash?: string };
  /** The AP3X the advert locks; default 2 AP3X, raised to the ledger minimum. */
  depositLovelace?: bigint;
}

export interface AdvertUpdateParams extends BuildCommon {
  advertRef: string;
  /**
   * The terms to change; the others stay. A detailUri that is given needs its detailHash, as in a post (detailHashFor); a detailHash of
   * '' counts as not given.
   */
  changes: Partial<AdvertTerms> & { status?: AdvertStatus };
  /** The AP3X of the new advert output; default what the advert holds, raised to the ledger minimum. */
  depositLovelace?: bigint;
}

/**
 * Builds the unsigned post of a new identity-marketplace advert: one output at the deployment's advert address with the advert datum
 * (status Active, advertised_at = now on a whole second, agent_id) and the deposit. Refuses terms that buyers could not hire or that a
 * supplier template cannot serve (detailHashFor, checkAdvertTerms) before it reads the chain, and an agent that fails the listing rule
 * over the window (checkListingRule). The supplier key signs; no script runs, so no collateral is needed.
 */
export async function buildAdvertPost(ctx: IdentityContext, p: AdvertPostParams): Promise<AdvertBuild> {
  const { lucid, provider, deployment } = ctx;
  const { detailHash } = detailHashFor(p.terms.detailUri, p.terms.detailHash);
  const terms = checkAdvertTerms({ ...p.terms, detailHash }, 'identity');
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const walletKeyHash = paymentKeyHashOf(p.changeAddress);
  await assertWalletIs(lucid, p.changeAddress);
  const supplierPkh = (p.supplierPkh ?? walletKeyHash).toLowerCase();
  const advert = advertDatumOf(terms, { supplierPkh, agentId: p.agentId, advertisedAt: advertisedAtOf(window), status: 'Active' });
  await checkListingRule(provider, deployment, advert, 'the new advert', window);
  const datumHex = encodeIdentityAdvertDatum(advert);
  const deposit = depositFor(lucid, deployment, datumHex, p.depositLovelace, ADVERT_DEPOSIT_FLOOR_LOVELACE);
  const signers = supplierSigner(supplierPkh);
  let tx = lucid.newTx()
    .pay.ToAddressWithData(deployment.advert.address, { kind: 'inline', value: datumHex }, { lovelace: deposit })
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const result = signedByResult(await tx.complete(), window, signers, walletKeyHash);
  return {
    ...result, advertRef: formatOutRef(result.txHash, outputIndexAt(result.txCbor, deployment.advert.address)), spentRef: null, advert,
    did: didOf(p.agentId), agentId: p.agentId, depositLovelace: deposit, paidTo: null,
  };
}

/**
 * Builds the unsigned UpdateAdvert of an identity-marketplace advert (advert/rules.ak update): the advert input with the advert
 * reference script, and exactly one output at the advert address with the new datum, which keeps supplier_pkh and agent_id and does
 * not lower advertised_at (it becomes now, or stays when that is later). The new terms follow the rules of a post (checkAdvertTerms).
 * The supplier key signs. An update that leaves the advert Active must pass the listing rule; one that sets it Retired need not.
 */
export async function buildAdvertUpdate(ctx: IdentityContext, p: AdvertUpdateParams): Promise<AdvertBuild> {
  const { lucid, provider, deployment } = ctx;
  const { status, ...termChanges } = p.changes;
  if (termChanges.detailHash === '') termChanges.detailHash = undefined;
  if (termChanges.detailUri !== undefined) termChanges.detailHash = detailHashFor(termChanges.detailUri, termChanges.detailHash).detailHash;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const { utxo, advert: old, ref } = await readAdvertUtxo(ctx, p.advertRef);
  const terms = checkAdvertTerms({ ...advertTermsOf(old), ...Object.fromEntries(Object.entries(termChanges).filter(([, v]) => v !== undefined)) }, 'identity');
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
    ...result, advertRef: formatOutRef(result.txHash, outputIndexAt(result.txCbor, deployment.advert.address)), spentRef: ref, advert,
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
  const { utxo, advert, ref } = await readAdvertUtxo(ctx, p.advertRef);
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
  return { ...result, advertRef: null, spentRef: ref, advert, did: didOf(advert.agent_id), agentId: advert.agent_id, depositLovelace: lovelace, paidTo };
}
