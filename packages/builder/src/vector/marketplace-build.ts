// packages/builder/src/vector/marketplace-build.ts
// Keyless marketplace transaction building. Every builder returns UNSIGNED CBOR through toBuildResult; signing
// happens on the member's local signer. The plan functions are pure: they decide what a transaction must say, so the
// same numbers can be shown to the signer and unit-tested without a chain.
//
// Two escrow layouts during the drain (Part 2 Sections 6.1, 6.5 and 9.6). The legacy escrow keeps its rules and is evaluated by the
// node, as before; from the escrow switch on (ESCROW_SWITCH_SLOT) Post builds no new legacy escrow, and the legacy spends stay. The
// identity-marketplace escrow of the server's deployment (16-field datum: agent_id and refund) adds rules that every spend here meets:
// the escrow input is the only script input, no mint, withdrawal or certificate, a validity range of at most one hour, and buyer
// payouts at the refund address with its datum when the escrow names one. Its spends are evaluated locally with the real script, read
// from the deployment's reference-script UTxO. Post refuses an escrow above the value cap F-29 in both layouts.
import { Data, Constr, CML, calculateMinLovelaceFromUTxO, credentialToAddress } from '@lucid-evolution/lucid';
import type { Assets, LucidEvolution, Provider, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { ensureSlotConfig, paymentKeyHashOf, ChainClockError } from './gov-build.js';
import type { SlotClockProvider } from './gov-build.js';
import {
  ESCROW_ADDRESS, ESCROW_REF_UTXO, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MAX_PROCESSING_MS_CEILING, MARKETPLACE_MIN_FEE,
  COLLATERAL_MIN_LOVELACE, MIN_UTXO_LOVELACE, REDEEMER, MAX_ESCROW_LOVELACE, ESCROW_SWITCH_SLOT, ESCROW_SWITCH_AT,
} from './marketplace-constants.js';
import {
  advertTextFieldsRoundTrip, encodeEscrowDatum, encodeIdentityEscrowDatum, requestSpecHash, promptHashForPayload,
  escrowLockFloor, identityEscrowLockFloor, parseOutRef, formatOutRef,
} from './marketplace-datum.js';
import type { AdvertDatum, EscrowDatum, IdentityAdvertDatum, IdentityEscrowDatum, Refund } from './marketplace-datum.js';
import { readAdvert, koiosTxInputCreds, listedAdvertRow, rowAgentId } from './marketplace-indexer.js';
import type { AdvertRead, SupplierRow } from './marketplace-indexer.js';
import { resolveEscrowLineage, nodeFailure, isIdentityEscrow } from './marketplace-lineage.js';
import type { EscrowLayout } from './marketplace-lineage.js';
import { isFleetCapability } from './marketplace-transport.js';
import { cell } from './marketplace-shared.js';
import { plutusAddressFromBech32, plutusAddressToBech32, utf8Hex } from './identity-codec.js';
import type { Status } from './identity-codec.js';
import { readRefScript } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { didOf, findRecord, signedByResult, windowAt, SignerList } from './identity-chain.js';
import type { RecordUtxo, SignedByBuild, Window } from './identity-chain.js';
import { MAX_RANGE_MS, PURPOSE, activeKey, effectiveStatus, hasCapability } from './identity-rules.js';

// The resolver lives in marketplace-lineage.ts; callers keep importing it from here.
export { resolveEscrowLineage };
export type { EscrowLineage } from './marketplace-lineage.js';

// One definition of "the payment key hash of a change address" for every builder family: gov-build's, re-exported.
export { paymentKeyHashOf };
export function enterpriseAddressOf(pkh: string): string { return credentialToAddress('Mainnet', { type: 'Key', hash: pkh }); }
const redeemerHex = (idx: number) => Data.to(new Constr(idx, []));
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** `new Error(message, { cause })`: Node has had the option since v16.9, but the type library this package compiles against (ES2020) does not declare it. */
const ErrorWithCause = Error as new (message?: string, options?: { cause?: unknown }) => Error;
/** ISO text for error messages; a datum can hold a time no Date can represent, and that must not replace the real message with a RangeError. */
const iso = (ms: number) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString(); };
/** AP3X text of a lovelace amount, for refusals. */
const ap3x = (lovelace: bigint): string => `${lovelace / 1_000_000n}.${(lovelace % 1_000_000n).toString().padStart(6, '0')}`;

// ─── Post ───────────────────────────────────────────────────────────────────

/**
 * What a Post commits the buyer to, in the terms the signer needs before signing: who is paid (the supplier key and the
 * host its endpoint is on), for which capability, the price and both bonds, the lock, the deadline from which the
 * buyer can Reclaim, and the last moment the Post can land. supplierPkh, endpointHost and capabilityId come from the
 * advert, which anyone can write: show them escaped.
 */
export interface PostEscrowTerms {
  supplierPkh: string; endpointHost: string; capabilityId: string;
  priceLovelace: bigint; supplierBondLovelace: bigint; buyerBondLovelace: bigint;
  /** price + both bonds, raised to the min-UTxO floor of the escrow's largest datum. */
  lockLovelace: bigint;
  /** POSIX ms. */
  deliverBy: number;
  /**
   * POSIX ms: the Post is invalid after this. It is the earlier of posted_at + the buffer and deliver_by - the supplier's window, so a
   * Post that lands in time leaves the supplier at least its full window, and one that lands later would not. The default deliver_by
   * is posted_at + the window + the buffer, and then the two are the same: at most 180 s after posted_at. A deliver_by the caller
   * chose that is nearer ends the validity sooner.
   */
  validTo: number;
}
/** What an identity-marketplace Post adds to the escrow datum (Part 2 Section 6.1): the agent of the advert and where buyer payouts go. */
export interface IdentityPostTerms { agentId: string; refund: Refund | null }
export interface PostEscrowPlan extends PostEscrowTerms {
  /** An IdentityEscrowDatum for the identity layout. */
  datum: EscrowDatum;
  layout: EscrowLayout;
  /** The datum as the Post writes it. */
  datumHex: string;
}
export type PostEscrowBuild = VectorUnsignedBuildResult & PostEscrowTerms & {
  escrowRef: string; promptHash: string;
  /**
   * True when the wallet's smallest pure output of at least 5 units was held back, so it is still there as collateral for
   * Accept and Reclaim. False on the fallback (nothing to spare, or the reserved selection did not complete): that output
   * may then be spent, and the wallet has collateral afterwards only if some pure output of at least 5 units remains,
   * for instance this Post's own change.
   */
  collateralKept: boolean;
  layout: EscrowLayout;
  /** The agent the escrow names (identity layout), or null. */
  agentId: string | null;
  /** The address of the escrow output (output 0). */
  escrowAddress: string;
  /** POSIX ms: the start of the validity range. */
  validFrom: number;
  /** Every key that must sign: the buyer, who is also the wallet. */
  requiredSigners: SignedByBuild['requiredSigners'];
};

/** The host the endpoint URL really connects to (userinfo dropped, port kept, IDN in punycode), or an error: a signer must be able to see who is paid. */
function endpointHostOf(endpointUrl: string, advertRef: string): string {
  let host = '';
  try { host = new URL(endpointUrl).host; } catch { /* refused below */ }
  if (!host) throw new Error(`Advert ${advertRef} has an endpoint that is not a usable URL with a host, so a job could not be delivered to it.`);
  return host;
}

/**
 * The value cap F-29 (Part 2 Sections 6.1 and 6.5): payment + buyer bond + supplier bond of an escrow is at most 10,000 AP3X. An
 * identity-marketplace escrow above it cannot be claimed and returns to the buyer only by Reclaim after deliver_by, and the indexer
 * does not list such an advert; a Post builder refuses to build one in either layout.
 */
function assertWithinCap(advertRef: string, economic: bigint): void {
  if (economic > MAX_ESCROW_LOVELACE) {
    throw new Error(`Advert ${advertRef} asks for price + both bonds of ${ap3x(economic)} AP3X, above the ${ap3x(MAX_ESCROW_LOVELACE)} AP3X value cap of an escrow (F-29): such an escrow cannot be claimed, so it is not built.`);
  }
}

/**
 * Pure. The escrow datum a Post would write and the terms the signer is shown. Throws a readable Error for an advert it
 * must not post against: retired, the buyer's own, a window or endpoint that cannot work, numbers the datum cannot hold,
 * price + bonds above the value cap (F-29). A buyer cannot Reclaim before deliver_by, so the supplier-chosen window is capped
 * (MAX_PROCESSING_MS_CEILING) and so is a caller-chosen deliver_by, which also catches a value given in microseconds. The Post is
 * valid until `validTo` (at most posted_at + the buffer), so that it cannot land late enough to give the supplier less than its
 * window. With `identity` the datum is the identity-marketplace escrow (Part 2 Section 6.1): it names the advert's agent and the
 * refund, and its lock is sized for the widest encoding of its Submitted datum (identityEscrowLockFloor).
 */
export function planPostEscrow(advert: AdvertDatum, advertRef: string, buyerPkh: string, payload: string, nowMs: number, deliverByMs?: number, identity?: IdentityPostTerms): PostEscrowPlan {
  if (advert.status !== 'Active') throw new Error(`Advert ${advertRef} is retired; pick another supplier.`);
  if (advert.supplier_pkh === buyerPkh) throw new Error('The buyer cannot be the supplier of the same advert.');
  if (typeof payload !== 'string' || payload.length === 0) throw new Error('payload must be a non-empty string');
  if (!Number.isSafeInteger(nowMs)) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  if (deliverByMs !== undefined && !Number.isSafeInteger(deliverByMs)) throw new Error('deliver_by must be a whole number of POSIX milliseconds');
  parseOutRef(advertRef); // a malformed ref is refused before the advert's numbers are looked at
  const window = advert.max_processing_ms;
  if (!Number.isInteger(window) || window < 0) throw new Error(`Advert ${advertRef} has an unusable processing window (${window} ms).`);
  if (window > MAX_PROCESSING_MS_CEILING) throw new Error(`Advert ${advertRef} advertises a processing window of ${window} ms, longer than the ${MAX_PROCESSING_MS_CEILING} ms (24 h) a Post will lock funds for.`);
  const endpointHost = endpointHostOf(advert.endpoint_url, advertRef);
  const furthest = MAX_PROCESSING_MS_CEILING + DELIVER_BY_BUFFER_MS;
  if (deliverByMs !== undefined && deliverByMs - nowMs > furthest) throw new Error(`deliver_by is ${deliverByMs - nowMs} ms from now, more than the ${furthest} ms (24 h plus the buffer) a Post will lock funds for; deliver_by is POSIX milliseconds, check the unit.`);
  const deliverBy = deliverByMs ?? nowMs + window + DELIVER_BY_BUFFER_MS;
  if (!Number.isSafeInteger(deliverBy) || deliverBy <= nowMs + window) throw new Error(`deliver_by must leave the supplier its full window of ${window} ms`);
  // The Post is valid until the earlier of the buffer after posted_at and the last moment that leaves the supplier its full window before
  // deliver_by, not until deliver_by itself: one that lands later would hand the supplier less than its window. For the default deliver_by
  // the two are the same; a deliver_by the caller chose can be nearer, and then the validity ends sooner (deliverBy - window > nowMs holds).
  const validTo = Math.min(nowMs + DELIVER_BY_BUFFER_MS, deliverBy - window);
  return escrowPlanAt(advert, advertRef, buyerPkh, payload, { postedAt: nowMs, deliverBy, validTo, endpointHost }, identity, false);
}

/**
 * The escrow of a vault payment (Part 2 Section 5.3): planPostEscrow's checks and datum in the identity layout, for a payment valid
 * over `window` (at most an hour). posted_at is now (the start of the window plus a minute), and deliver_by is the end of the window
 * plus the supplier's processing window and the buffer, so that a payment that lands at the last moment still leaves the supplier its
 * full window (and deliver_by is far inside the vault's limit of hi + 7 days). The escrow output holds exactly payment + both bonds,
 * as the vault requires of every escrow it pays: when the lock floor is above the advert's amounts, the difference is added to the
 * buyer bond, which returns to the vault on Accept and on every refund.
 */
export function planVaultEscrow(advert: AdvertDatum, advertRef: string, buyerPkh: string, payload: string, window: Window, identity: IdentityPostTerms): PostEscrowPlan {
  if (typeof payload !== 'string' || payload.length === 0) throw new Error('payload must be a non-empty string');
  const processing = advert.max_processing_ms;
  if (!Number.isInteger(processing) || processing < 0) throw new Error(`Advert ${advertRef} has an unusable processing window (${processing} ms).`);
  if (processing > MAX_PROCESSING_MS_CEILING) throw new Error(`Advert ${advertRef} advertises a processing window of ${processing} ms, longer than the ${MAX_PROCESSING_MS_CEILING} ms (24 h) a Post will lock funds for.`);
  const times = { postedAt: window.lo + 60_000, deliverBy: window.hi + processing + DELIVER_BY_BUFFER_MS, validTo: window.hi, endpointHost: endpointHostOf(advert.endpoint_url, advertRef) };
  return escrowPlanAt(advert, advertRef, buyerPkh, payload, times, identity, true);
}

/** The checks and the datum of an escrow posted at `times.postedAt`; `exactLock` puts the floor top-up into the buyer bond (planVaultEscrow). */
function escrowPlanAt(
  advert: AdvertDatum, advertRef: string, buyerPkh: string, payload: string,
  times: { postedAt: number; deliverBy: number; validTo: number; endpointHost: string }, identity: IdentityPostTerms | undefined, exactLock: boolean,
): PostEscrowPlan {
  if (advert.status !== 'Active') throw new Error(`Advert ${advertRef} is retired; pick another supplier.`);
  if (advert.supplier_pkh === buyerPkh) throw new Error('The buyer cannot be the supplier of the same advert.');
  const ref = parseOutRef(advertRef);
  const legacy: EscrowDatum = {
    buyer_pkh: buyerPkh, supplier_pkh: advert.supplier_pkh,
    advert_ref: { txHash: ref.txHash, index: ref.outputIndex }, capability_id: advert.capability_id,
    request_spec_hash: requestSpecHash(advert), prompt_hash: promptHashForPayload(payload),
    payment_lovelace: advert.price_lovelace, buyer_bond_lovelace: advert.buyer_bond_lovelace, supplier_bond_lovelace: advert.supplier_bond_lovelace,
    deliver_by: times.deliverBy, posted_at: times.postedAt, submitted_at: null, result_receipt_hash: null, state: 'Open',
  };
  let economic = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
  // The advert's numbers are the supplier's to choose. The datum writer refuses what it cannot frame (negative, past
  // uint64); say so in terms of the advert instead of leaking a bare RangeError.
  const unfit = (why: string) => new Error(`Advert ${advertRef} cannot be posted: its terms do not fit an escrow datum (${why}).`);
  let datum: EscrowDatum = legacy;
  let datumHex: string;
  let lockLovelace: bigint;
  if (identity === undefined) {
    try { lockLovelace = escrowLockFloor(legacy, economic); datumHex = encodeEscrowDatum(legacy); } catch (err) { throw unfit(errorText(err)); }
  } else {
    // The identity escrow's Claim needs each amount at least 0 (Part 2 Section 6.1, the value cap); the cap below bounds the rest.
    if (advert.price_lovelace < 0n || advert.buyer_bond_lovelace < 0n || advert.supplier_bond_lovelace < 0n) throw unfit('a negative amount');
    let identityDatum: IdentityEscrowDatum = { ...legacy, agent_id: identity.agentId, refund: identity.refund };
    try {
      lockLovelace = identityEscrowLockFloor(identityDatum, economic);
      // Every integer counts 9 bytes in the floor (plutusDataMaxBytes), so a larger buyer bond does not move the floor.
      if (exactLock && lockLovelace > economic) { identityDatum = { ...identityDatum, buyer_bond_lovelace: identityDatum.buyer_bond_lovelace + lockLovelace - economic }; economic = lockLovelace; }
      datumHex = encodeIdentityEscrowDatum(identityDatum);
    } catch (err) { throw unfit(errorText(err)); }
    datum = identityDatum;
  }
  assertWithinCap(advertRef, economic);
  return {
    datum, datumHex, layout: identity === undefined ? 'legacy' : 'identity', lockLovelace, deliverBy: times.deliverBy, validTo: times.validTo,
    supplierPkh: advert.supplier_pkh, endpointHost: times.endpointHost, capabilityId: advert.capability_id,
    priceLovelace: datum.payment_lovelace, supplierBondLovelace: datum.supplier_bond_lovelace, buyerBondLovelace: datum.buyer_bond_lovelace,
  };
}

/**
 * Keep the smallest pure-lovelace UTxO of at least 5 units out of the inputs so Accept/Reclaim can use it as collateral.
 * Returns the UTxOs to fund the Post from, or undefined when the wallet has no such output to spare or the rest cannot
 * pay the lock, the minimum fee and one change output. The sums count lovelace only: whether a change output that carries
 * tokens still fits is for the coin selection to say, and buildPostEscrow falls back to the whole wallet when it does not.
 */
export function reserveCollateralInputs(utxos: UTxO[], lockLovelace: bigint): UTxO[] | undefined {
  const pure = utxos.filter((u) => Object.keys(u.assets).every((k) => k === 'lovelace') && u.assets.lovelace >= COLLATERAL_MIN_LOVELACE);
  if (pure.length === 0) return undefined;
  const collateral = pure.reduce((smallest, u) => (u.assets.lovelace < smallest.assets.lovelace ? u : smallest));
  // By outref, not by object: a copy of the reserved output elsewhere in the list must not slip into the inputs.
  const rest = utxos.filter((u) => !(u.txHash === collateral.txHash && u.outputIndex === collateral.outputIndex));
  const total = rest.reduce((sum, u) => sum + u.assets.lovelace, 0n);
  return total >= lockLovelace + MARKETPLACE_MIN_FEE + MIN_UTXO_LOVELACE ? rest : undefined;
}

/**
 * escrow_ref is `<txHash>#0`, so the escrow must really be output 0. Lucid keeps payment order today; this turns the
 * assumption into a checked fact: a transaction whose first output is not the planned escrow (address, lock and inline
 * datum) is an error, never a result. `address` is the escrow address of the Post's layout (default the legacy one).
 */
export function assertEscrowIsOutputZero(txCbor: string, expected: { datumHex: string; lockLovelace: bigint; address?: string }): void {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  const first = outputs.len() > 0 ? outputs.get(0) : undefined;
  const ok = first !== undefined
    && first.address().to_bech32() === (expected.address ?? ESCROW_ADDRESS)
    && BigInt(first.amount().coin().toString()) === expected.lockLovelace
    && first.datum()?.as_datum()?.to_cbor_hex().toLowerCase() === expected.datumHex.toLowerCase();
  if (!ok) throw new Error('The built transaction does not have the planned escrow as output 0 (address, lock and inline datum), so escrow_ref would point at the wrong output; not returning it.');
}

// The advert validator does not check who creates an advert, and the indexer records any decodable advert output, so the
// supplier_pkh inside one proves nothing by itself. Spending an input needs that key's witness: when an input of the
// creating transaction belongs to supplier_pkh, the supplier signed it.
async function assertAdvertAuthor(advertRef: string, creatingTxHash: string, supplierPkh: string, fetchImpl: typeof fetch): Promise<void> {
  let creds: string[];
  try { creds = await koiosTxInputCreds(VECTOR_KOIOS_URL, creatingTxHash, fetchImpl); } catch (err) { throw new Error(`Could not check who created advert ${advertRef}: ${errorText(err)}`); }
  if (!creds.includes(supplierPkh)) throw new Error(`Advert ${advertRef} was not created by its supplier key: no input of the transaction that created it belongs to ${supplierPkh}. Refusing to hire it.`);
}

/** An advert that a Post (or a vault payment) may hire: read from Koios, unspent, with text fields that round-trip, of a template-contract capability. */
export type HireableAdvert = Exclude<AdvertRead, { error: string }> & { ref: string };

/**
 * Reads the advert `advertRef` in either layout (the identity layout with `deployment`) and refuses one that a Post must not hire:
 * spent, of a spent status Koios does not report, with text fields that are not valid UTF-8, or of a fleet capability.
 * `fetchImpl` stands in for fetch in the Koios call (tests).
 */
export async function readHireableAdvert(advertRef: string, fetchImpl: typeof fetch, deployment: IdentityDeployment | null): Promise<HireableAdvert> {
  let read: AdvertRead;
  try { read = await readAdvert(advertRef, fetchImpl, VECTOR_KOIOS_URL, deployment?.advert.address ?? null); } catch (err) { throw new Error(`Could not read advert ${advertRef.trim()}: ${errorText(err)}`); }
  if ('error' in read) throw new Error(read.error);
  const { utxo, advert } = read;
  const ref = formatOutRef(utxo.tx_hash.toLowerCase(), utxo.tx_index);
  if (read.spent) throw new Error(`Advert ${ref} has been spent (its supplier retired or replaced it); pick another advert.`);
  if (utxo.is_spent !== false) throw new Error(`Koios did not report whether advert ${ref} is unspent; refusing to hire it.`);
  const advertDatumHex = utxo.inline_datum?.bytes;
  if (!advertDatumHex || !advertTextFieldsRoundTrip(advertDatumHex)) throw new Error(`Advert ${ref} has text fields that are not valid UTF-8, so the escrow could not carry its capability id faithfully; refusing to hire it.`);
  // vector_marketplace_send_job serves template-contract suppliers only, and a fleet supplier checks another hash of the request than
  // the prompt_hash a Post commits: a fleet hire could never be sent, and its lock would wait for a Reclaim after deliver_by.
  if (isFleetCapability(advert.capability_id)) throw new Error(`Advert ${ref} serves ${cell(advert.capability_id)}, a fleet capability (llm.text.generate.*, llm.chat.*, ocr.page.extract.* or audio.synthesize.*). vector_marketplace_send_job serves template-contract suppliers only in this release, so the job could never be sent and the lock would wait for a Reclaim after deliver_by. Pick a template-contract supplier.`);
  return { ...read, ref };
}

/**
 * The listing rule of an identity-marketplace advert (Part 2 Section 6.2), as the indexer applies it: a GET /suppliers row for
 * exactly this advert that names its agent_id. The indexer lists only adverts whose creating transaction the supplier key signed and
 * whose agent passes the rule; checkListingRule checks the agent on chain as well. `fetchImpl` stands in for fetch (tests).
 */
export async function assertIndexerLists(advertRef: string, agentId: string, fetchImpl: typeof fetch): Promise<void> {
  let row: SupplierRow | null;
  try { row = await listedAdvertRow(advertRef, { fetchImpl }); } catch (err) { throw new Error(`Could not ask the marketplace indexer whether advert ${advertRef} is listed: ${errorText(err)}`); }
  if (row === null) throw new Error(`Advert ${advertRef} is not listed by the marketplace indexer: an identity-marketplace advert is listed only when its supplier key signed it and its agent passes the listing rule (Part 2 Section 6.2). Refusing to hire it.`);
  if (rowAgentId(row) !== agentId) throw new Error(`The marketplace indexer lists advert ${advertRef} with another agent than the one its datum names; refusing to hire it.`);
}

/**
 * The listing rule of an identity-marketplace advert on chain (Part 2 Section 6.2), over `window`: the record of its agent is live and
 * independent, its effective status is Active, it lists the supplier key with the transaction purpose (active_key), and it lists the
 * capability (has_capability). These are also the rules that the agent's Claim must meet. Returns the record.
 */
export async function checkListingRule(provider: Provider, deployment: IdentityDeployment, advert: IdentityAdvertDatum, advertRef: string, window: Window): Promise<RecordUtxo> {
  const agent = didOf(advert.agent_id);
  const found = await findRecord(provider, deployment, advert.agent_id);
  if (!found) throw new Error(`The agent ${agent} of advert ${advertRef} has no record in the identity registry, so the advert is not listed (Part 2 Section 6.2).`);
  const record = found.record;
  if (record.lineage.type !== 'Root') throw new Error(`The agent ${agent} of advert ${advertRef} is a subagent; only an independent agent can take work (listing rule, Part 2 Section 6.2).`);
  const status = effectiveStatus(record, new Map(), window.lo, window.hi);
  if (status !== 'Active') throw new Error(`The agent ${agent} of advert ${advertRef} is ${status}; only an Active agent can take work (listing rule, Part 2 Section 6.2).`);
  if (!activeKey(record, advert.supplier_pkh, PURPOSE.transaction)) throw new Error(`The record of ${agent} does not list the supplier key ${advert.supplier_pkh} of advert ${advertRef} with the transaction purpose, so the agent could not claim the job (listing rule, Part 2 Section 6.2).`);
  if (!hasCapability(record, utf8Hex(advert.capability_id))) throw new Error(`The record of ${agent} does not list the capability ${cell(advert.capability_id)} of advert ${advertRef}, so the agent could not claim the job (listing rule, Part 2 Section 6.2).`);
  return found;
}

// ─── The escrow switch (Part 2 Section 9.6) ─────────────────────────────────

/** The escrow switch as the tool texts and the refusals name it. */
export const ESCROW_SWITCH_NAME = `the escrow switch (slot ${ESCROW_SWITCH_SLOT}, ${ESCROW_SWITCH_AT})`;
/** The refusal of a new legacy-layout advert from the escrow switch on (buildPostAdvert, vector_build_marketplace_post_advert). */
export const LEGACY_ADVERT_REFUSAL = `From ${ESCROW_SWITCH_NAME} on, new adverts use the identity layout only, so no new legacy-layout advert is built. Post an identity-layout advert with vector_build_marketplace_advert_post: it names the agent (did:vector) whose record lists your supplier key and the capability. To take a legacy advert off the market and get its deposit back, use vector_build_marketplace_advert_retire.`;
/** The refusal of a new escrow on the legacy-layout advert `advertRef` from the escrow switch on (buildPostEscrow). */
export const legacyEscrowRefusal = (advertRef: string): string => `Advert ${advertRef} has the legacy layout (it names no agent DID). From ${ESCROW_SWITCH_NAME} on, new escrows go to identity-layout adverts only, so no new escrow is built for it. Hire an advert that names an agent (vector_marketplace_list_suppliers shows its DID) with vector_build_marketplace_post_escrow, or ask the supplier to post one with vector_build_marketplace_advert_post. Escrows posted before the switch keep their Accept, Reclaim and Release.`;

/**
 * Whether the node's tip has reached the escrow switch, decided as the agents-marketplace gateway decides it: the slot of the tip is at
 * least ESCROW_SWITCH_SLOT. A tip that the node cannot give is an error, so that nothing of the legacy layout is built on an unknown
 * side of the switch. The spends of what exists (Accept, Reclaim, Release, the Retire of an advert) never ask.
 */
export async function escrowSwitchPassed(provider: Provider): Promise<boolean> {
  let slot: unknown;
  try { slot = (await (provider as unknown as Required<Pick<SlotClockProvider, 'getNetworkTip'>>).getNetworkTip()).slot; } catch (err) {
    throw new Error(`Could not read the chain tip from the node, so it is not known whether ${ESCROW_SWITCH_NAME} has passed: ${nodeFailure(err)}`);
  }
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) {
    throw new Error(`The node did not report a usable chain tip, so it is not known whether ${ESCROW_SWITCH_NAME} has passed.`);
  }
  return slot >= ESCROW_SWITCH_SLOT;
}

/** Refuses with `refusal` (one of the two above) once the node's tip has reached the escrow switch. */
export async function assertBeforeEscrowSwitch(provider: Provider, refusal: string): Promise<void> {
  if (await escrowSwitchPassed(provider)) throw new Error(refusal);
}

/**
 * Builds the unsigned Post: locks price + both bonds in a new escrow (output 0) for the advert. Reads the advert through
 * readAdvert in either layout and refuses one that is spent, retired, not valid UTF-8, of a fleet capability, above the value cap
 * (F-29), and a buyer who is the supplier. A legacy advert is refused once the node's tip has reached the escrow switch
 * (legacyEscrowRefusal); before it, the advert must have been created by its supplier key, and the escrow is the legacy one.
 * An identity-marketplace advert (at the advert address of `deployment`) must be listed by the indexer with its agent_id and pass the
 * listing rule on chain; the escrow is the identity one at the deployment's escrow address, with that agent_id and the refund set to
 * the buyer's own address (`changeAddress`) with no datum (Part 2 Section 6.5), so that anybody can Reclaim it to the buyer after
 * deliver_by. Funds the Post without the wallet's smallest pure 5-unit output when it can (collateralKept), and checks the built
 * transaction really has the escrow at output 0. `fetchImpl` stands in for fetch in the Koios and indexer calls (tests). Nothing is
 * signed or submitted.
 */
export async function buildPostEscrow(
  lucid: LucidEvolution, provider: Provider,
  p: { changeAddress: string; advertRef: string; payload: string; nowMs?: number; deliverByMs?: number },
  fetchImpl: typeof fetch = fetch, deployment: IdentityDeployment | null = null,
): Promise<PostEscrowBuild> {
  const buyerPkh = paymentKeyHashOf(p.changeAddress);
  const read = await readHireableAdvert(p.advertRef, fetchImpl, deployment);
  const advertRef = read.ref;
  const nowMs = p.nowMs ?? Date.now();
  let plan: PostEscrowPlan;
  let escrowAddress = ESCROW_ADDRESS;
  if (read.layout === 'legacy') {
    await assertBeforeEscrowSwitch(provider, legacyEscrowRefusal(advertRef));
    plan = planPostEscrow(read.advert, advertRef, buyerPkh, p.payload, nowMs, p.deliverByMs);
    await assertAdvertAuthor(advertRef, read.utxo.tx_hash, read.advert.supplier_pkh, fetchImpl);
  } else {
    if (deployment === null) throw new Error('An identity-marketplace advert needs the identity deployment.'); // readAdvert reads one only with it
    const refund: Refund = { address: plutusAddressFromBech32(p.changeAddress), datum: null };
    plan = planPostEscrow(read.advert, advertRef, buyerPkh, p.payload, nowMs, p.deliverByMs, { agentId: read.agentId, refund });
    await assertIndexerLists(advertRef, read.agentId, fetchImpl);
    await checkListingRule(provider, deployment, read.advert, advertRef, { lo: nowMs - 60_000, hi: plan.validTo });
    escrowAddress = deployment.escrow.address;
  }

  await ensureSlotConfig(provider as unknown as SlotClockProvider);
  // A fresh builder per attempt: one that failed in complete() is not reused.
  const assemble = () => lucid.newTx()
    .pay.ToAddressWithData(escrowAddress, { kind: 'inline', value: plan.datumHex }, { lovelace: plan.lockLovelace })
    .addSignerKey(buyerPkh)
    .validFrom(nowMs - 60_000)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE);
  // Post pays to a script address and runs no script, so there is nothing to evaluate. Accept and Reclaim do spend a
  // script and need a pure output of at least 5 units as collateral, so first try to fund the Post without the smallest
  // such output. When the wallet has none to spare, or the rest does not complete (the reservation counts lovelace only,
  // and change that carries tokens can need more), fall back to the whole wallet. Then that output may be spent, and
  // collateralKept says so; the change output is the next collateral only if it is a pure output of at least 5 units,
  // which nothing here guarantees.
  const inputs = reserveCollateralInputs(await lucid.wallet().getUtxos(), plan.lockLovelace);
  let completed: TxSignBuilder | undefined;
  let reservedFailure: unknown;
  if (inputs) {
    try { completed = await assemble().complete({ presetWalletInputs: inputs }); } catch (err) { reservedFailure = err; /* retried below with the whole wallet */ }
  }
  const collateralKept = completed !== undefined;
  if (!completed) {
    try { completed = await assemble().complete({}); } catch (err) {
      // The whole-wallet attempt is the one whose words the caller gets; why the reserved selection was given up on stays attached.
      throw inputs ? new ErrorWithCause(errorText(err), { cause: reservedFailure }) : err;
    }
  }
  const r = toBuildResult(completed);
  assertEscrowIsOutputZero(r.txCbor, { datumHex: plan.datumHex, lockLovelace: plan.lockLovelace, address: escrowAddress });
  const { datum, datumHex: _written, ...terms } = plan;
  return {
    ...r, ...terms, escrowRef: formatOutRef(r.txHash, 0), promptHash: datum.prompt_hash, collateralKept,
    agentId: isIdentityEscrow(datum) ? datum.agent_id : null, escrowAddress, validFrom: nowMs - 60_000,
    requiredSigners: [{ keyHash: buyerPkh, roles: ['buyer (wallet: inputs, fee and collateral)'] }],
  };
}

// ─── Accept / Reclaim / Release plans (pure) ────────────────────────────────

/**
 * Does Accept raise the supplier's payout to the minimum output? Accept owes the supplier the price and its bond; when that is
 * less than MIN_UTXO_LOVELACE the output is raised to it, out of the buyer's return. One rule for planAccept and for the Post text
 * that warns the buyer before it signs.
 */
export function supplierPayoutRaised(priceLovelace: bigint, supplierBondLovelace: bigint): boolean {
  return priceLovelace + supplierBondLovelace < MIN_UTXO_LOVELACE;
}

// A payout below the minimum output cannot exist, so it is raised to MIN_UTXO_LOVELACE and the plan says so (`...Raised`): the
// signer is shown more than the datum owes, and the difference is not free. `supplierPkh` is the key the datum names.
export function planAccept(datum: EscrowDatum, callerPkh: string, nowMs: number) {
  if (datum.buyer_pkh !== callerPkh) throw new Error('This escrow was posted by another key; you are not the buyer.');
  if (datum.state !== 'Submitted' || datum.submitted_at === null) throw new Error(`Escrow state is ${datum.state}; Accept needs Submitted.`);
  const validTo = datum.submitted_at + ACCEPT_WINDOW_MS;
  if (nowMs > validTo) throw new Error(`Accept window closed at ${iso(validTo)}; the supplier may now Release.`);
  const supplierDue = datum.payment_lovelace + datum.supplier_bond_lovelace;
  const supplierRaised = supplierPayoutRaised(datum.payment_lovelace, datum.supplier_bond_lovelace);
  const buyerRaised = datum.buyer_bond_lovelace < MIN_UTXO_LOVELACE;
  return {
    supplierPkh: datum.supplier_pkh,
    supplierAddress: enterpriseAddressOf(datum.supplier_pkh),
    supplierLovelace: supplierRaised ? MIN_UTXO_LOVELACE : supplierDue, supplierRaised,
    buyerLovelace: buyerRaised ? MIN_UTXO_LOVELACE : datum.buyer_bond_lovelace, buyerRaised,
    validFrom: nowMs - 60_000, validTo, redeemerHex: redeemerHex(REDEEMER.Accept), secondsLeft: Math.floor((validTo - nowMs) / 1000),
  };
}

/** The first whole second strictly after `threshold`: a lower bound there is, as the script sees it, at or after `threshold` (see planReclaim). */
const opensAfter = (threshold: number): number => Math.ceil((threshold + 1) / 1000) * 1000;

/**
 * escrow.ak (handle_reclaim) accepts a Reclaim only when the validity range starts at or after deliver_by. Lucid floors
 * validFrom to the slot that contains it, and the script sees that slot's start, so a validFrom taken from an unaligned
 * deliver_by (almost every default one is) lands up to 999 ms before it and the validator rejects the transaction. The Reclaim
 * therefore opens at the first whole second strictly after deliver_by, which is a slot boundary no earlier than it. There
 * is no closing deadline in the validator, so the upper bound leaves ten minutes for a person to sign.
 */
export function planReclaim(datum: EscrowDatum, callerPkh: string, nowMs: number) {
  if (datum.buyer_pkh !== callerPkh) throw new Error('This escrow was posted by another key; you are not the buyer.');
  return reclaimTiming(datum, nowMs, (due) => {
    const buyerRaised = due < MIN_UTXO_LOVELACE;
    return { buyerLovelace: buyerRaised ? MIN_UTXO_LOVELACE : due, buyerRaised };
  });
}

/** The state and timing rules of Reclaim, shared by the buyer's Reclaim and anybody's Reclaim of an escrow with a refund address. */
function reclaimTiming<T>(datum: EscrowDatum, nowMs: number, payout: (due: bigint) => T) {
  if (datum.state !== 'Open' && datum.state !== 'Claimed') throw new Error(`Escrow state is ${datum.state}; Reclaim needs Open or Claimed.`);
  const opens = opensAfter(datum.deliver_by);
  if (nowMs < opens) throw new Error(`Reclaim opens at ${iso(opens)}: deliver_by is ${iso(datum.deliver_by)}, and the validity range may start only on a whole second after it.`);
  const due = datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace;
  return {
    supplierPkh: datum.supplier_pkh, ...payout(due),
    validFrom: Math.max(opens, nowMs - 60_000), validTo: nowMs + 600_000, redeemerHex: redeemerHex(REDEEMER.Reclaim),
  };
}

/**
 * Release (escrow.ak handle_release; escrow/rules.ak release): the supplier key signs, the escrow is Submitted, the validity range
 * starts at or after submitted_at + the accept window, and the supplier's payouts are at least payment + supplier bond + buyer bond
 * (raised to the minimum output when less). The range opens on the first whole second after the window ends (as planReclaim does
 * after deliver_by) and closes at `window.hi`.
 */
export function planRelease(datum: EscrowDatum, callerPkh: string, nowMs: number, window: Window) {
  if (datum.supplier_pkh !== callerPkh) throw new Error('This escrow was posted for another supplier key; you are not its supplier.');
  if (datum.state !== 'Submitted' || datum.submitted_at === null) throw new Error(`Escrow state is ${datum.state}; Release needs Submitted.`);
  const windowEnds = datum.submitted_at + ACCEPT_WINDOW_MS;
  const opens = opensAfter(windowEnds);
  if (nowMs < opens) throw new Error(`Release opens at ${iso(opens)}: the buyer may accept until ${iso(windowEnds)}, 600 s after the Submit, and the validity range may start only on a whole second after that.`);
  const due = datum.payment_lovelace + datum.supplier_bond_lovelace + datum.buyer_bond_lovelace;
  const supplierRaised = due < MIN_UTXO_LOVELACE;
  return {
    supplierPkh: datum.supplier_pkh, supplierLovelace: supplierRaised ? MIN_UTXO_LOVELACE : due, supplierRaised,
    validFrom: Math.max(opens, window.lo), validTo: window.hi, redeemerHex: redeemerHex(REDEEMER.Release),
  };
}

/**
 * The record condition of RefundRevoked (Part 2 Section 6.1; escrow/rules.ak refund_allowed), from the record's own status (W2-ESC
 * decision 1): an Open or Claimed escrow when the record is Revoked or Retired; a Submitted escrow when the record is Revoked with
 * invalid_from at or before submitted_at. Null when it holds, else why not.
 */
export function refundRevokedRefusal(datum: EscrowDatum, status: Status): string | null {
  if (datum.state === 'Open' || datum.state === 'Claimed') {
    return status.type === 'Revoked' || status.type === 'Retired' ? null
      : `the escrow is ${datum.state} and the agent's record is ${status.type}; RefundRevoked needs the record Revoked or Retired`;
  }
  if (datum.state === 'Submitted') {
    if (status.type !== 'Revoked' || status.invalidFrom === null) return `the escrow is Submitted and the agent's record is ${status.type === 'Revoked' ? 'Revoked without invalid_from' : status.type}; RefundRevoked needs the record Revoked with invalid_from at or before submitted_at`;
    if (datum.submitted_at === null || status.invalidFrom > datum.submitted_at) return `the escrow was submitted at ${datum.submitted_at === null ? 'an unknown time' : iso(datum.submitted_at)}, before the revocation took effect (${iso(status.invalidFrom)}): the work was done while the agent was valid`;
    return null;
  }
  return `the escrow is ${datum.state}; RefundRevoked needs Open, Claimed or Submitted`;
}

// ─── Spending an escrow ─────────────────────────────────────────────────────

/**
 * Lucid turns validFrom and validTo into the slots that contain them, and the Reclaim plan opens on a whole second so that the
 * slot it lands in starts at or after deliver_by. That holds only while slots start on whole seconds, which is when the chain's
 * slot zero time is a whole number of seconds; on any other clock the plan's argument does not hold, so nothing is built.
 */
function assertWholeSecondSlots(zeroTime: number): void {
  if (zeroTime % 1000 !== 0) {
    throw new Error(`The chain's slot zero time (${zeroTime} ms) is not a whole number of seconds, so the validity range cannot be placed on slot boundaries the way Accept and Reclaim need; nothing was built.`);
  }
}

/** The escrow validator is read from its live reference-script UTxO instead of being attached, which keeps the transaction small. If that UTxO is ever spent, the marketplace has to publish the script again. */
async function escrowRefScript(provider: Provider): Promise<UTxO> {
  const at = formatOutRef(ESCROW_REF_UTXO.txHash, ESCROW_REF_UTXO.outputIndex);
  let utxos: UTxO[];
  try { utxos = await provider.getUtxosByOutRef([ESCROW_REF_UTXO]); } catch (err) { throw new Error(`Could not read the escrow reference script ${at} from the node: ${nodeFailure(err)}`); }
  if (!utxos[0]?.scriptRef) throw new Error(`Escrow reference script ${at} not found; the marketplace needs to republish it.`);
  return utxos[0];
}

/** Lucid picks the collateral itself. This only turns a wallet with nothing suitable into a readable refusal instead of a ledger error. */
export function assertCollateral(utxos: UTxO[]) {
  if (!utxos.some((u) => Object.keys(u.assets).every((k) => k === 'lovelace') && u.assets.lovelace >= COLLATERAL_MIN_LOVELACE)) {
    throw new Error('Collateral required: the wallet must hold one pure output of at least 5 units.');
  }
}

/** The payout goes to changeAddress but Lucid sends its own change to the wallet it is bound to: the two must be one address, or the buyer's money would be paid out to two places. */
export async function assertWalletIs(lucid: LucidEvolution, changeAddress: string): Promise<void> {
  if ((await lucid.wallet().address()) !== changeAddress) {
    throw new Error('changeAddress is not the address this wallet is bound to: the payout would go to changeAddress but Lucid\'s change to the wallet\'s own address, so nothing was built. Bind the wallet to changeAddress.');
  }
}

/** An output that a spend of an escrow pays: at `address`, holding `assets`, with the inline datum `datum` (CBOR hex) when set. */
interface Payout { address: string; assets: Assets; datum: string | null }

/** The escrow as the resolver found it, with the caller: what a spend decides from. */
interface LiveEscrow {
  utxo: UTxO; datum: EscrowDatum; layout: EscrowLayout;
  callerPkh: string; changeAddress: string; nowMs: number; validMinutes?: number;
  deployment: IdentityDeployment | null;
  /** The ledger minimum of an output (the protocol's coins per byte), for a payout that carries a datum. */
  minimum: (payout: Payout) => bigint;
}

/** What one spend of an escrow does. The plan functions decide it; buildEscrowSpend assembles it. */
interface SpendDecision<T> {
  redeemerHex: string;
  /** POSIX ms. */
  validFrom: number; validTo: number;
  payouts: Payout[];
  /** The keys whose signature the script needs (the wallet is added to the list for its inputs). */
  signers: SignerList;
  /** Reference inputs besides the escrow script: the agent's record for RefundRevoked. */
  refs: UTxO[];
  terms: T;
}

export interface EscrowSpendParams {
  changeAddress: string; escrowRef: string; nowMs?: number;
  /** Minutes the transaction stays valid, where the spend lets the caller choose (Release, RefundRevoked). */
  validMinutes?: number;
  /** The server's identity deployment: an identity-marketplace escrow needs it. */
  deployment?: IdentityDeployment | null;
}

/** What every escrow spend returns: the build, the escrow it spent (its canonical ref and layout) and the agent it names. */
export type EscrowSpendBuild = SignedByBuild & { escrowRef: string; layout: EscrowLayout; agentDid: string | null };

/**
 * Where buyer payouts go (Part 2 Section 6.1, rule 5): to exactly the refund address, with exactly its datum, when an
 * identity-marketplace escrow names one; else to `fallback` (the buyer's own wallet for Accept and Reclaim, whose payment credential is
 * the buyer key; the enterprise address of the buyer key for RefundRevoked).
 */
function buyerPayoutTo(datum: EscrowDatum, fallback: string): { address: string; datum: string | null } {
  if (!isIdentityEscrow(datum) || datum.refund === null) return { address: fallback, datum: null };
  const address = plutusAddressToBech32(datum.refund.address);
  if (address === null) throw new Error('The escrow refunds to a pointer address, which these tools cannot pay; nothing was built.');
  return { address, datum: datum.refund.datum };
}

/** A payout of `lovelace` (and `extra`, the escrow's other assets for a full refund), raised to the ledger minimum when it carries a datum or other assets. */
function payoutOf(live: LiveEscrow, to: { address: string; datum: string | null }, lovelace: bigint, extra: Assets = {}): { payout: Payout; raised: boolean } {
  const payout: Payout = { address: to.address, assets: { ...extra, lovelace }, datum: to.datum };
  if (to.datum === null && Object.keys(extra).length === 0) return { payout, raised: false };
  const minimum = live.minimum(payout);
  return minimum > lovelace ? { payout: { ...payout, assets: { ...extra, lovelace: minimum } }, raised: true } : { payout, raised: false };
}

/** The escrow input's assets other than AP3X: a full refund carries them along to the refund address. */
const otherAssetsOf = (utxo: UTxO): Assets => Object.fromEntries(Object.entries(utxo.assets).filter(([unit]) => unit !== 'lovelace'));

/**
 * What Accept, Reclaim, Release and RefundRevoked share, in the order that matters: the caller's key, the live continuation of the
 * escrow (resolveEscrowLineage in either layout, which fails closed), the plan (who may, in which state, when, what is paid where),
 * the chain clock, the wallet binding, the collateral, the reference script of the escrow's layout, and then the transaction. The
 * spend is of the node's copy of the live output, at whatever address it sits: the validator knows the escrow by payment credential.
 * A refusal names the escrow by its canonical ref, and none claims the escrow is finished: not finding a live continuation is not the
 * same thing (it may not be indexed yet). The legacy escrow is evaluated by the node, as before; the identity escrow is evaluated
 * locally with the real script, and its range is at most one hour (Part 2 Section 6.1, rule 3).
 */
async function buildEscrowSpend<T>(
  lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: EscrowSpendParams, fetchImpl: typeof fetch,
  decide: (live: LiveEscrow) => SpendDecision<T> | Promise<SpendDecision<T>>,
): Promise<{ build: EscrowSpendBuild; terms: T; datum: EscrowDatum }> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  const deployment = p.deployment ?? null;
  const lineage = await resolveEscrowLineage(provider, koiosUrl, p.escrowRef, fetchImpl, deployment);
  const parsed = parseOutRef(p.escrowRef);
  const escrow = formatOutRef(parsed.txHash, parsed.outputIndex);
  if (!lineage.current) throw new Error(`No live continuation of escrow ${escrow} found (spent, or not yet indexed); retry or check the explorer.`);
  const { layout } = lineage;
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  const live: LiveEscrow = {
    utxo: lineage.current.utxo, datum: lineage.current.datum, layout, callerPkh, changeAddress: p.changeAddress, nowMs: p.nowMs ?? Date.now(),
    validMinutes: p.validMinutes, deployment,
    minimum: (payout) => {
      if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of a payout is unknown.');
      return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address: payout.address, assets: payout.assets, datum: payout.datum ?? undefined });
    },
  };
  let decision: SpendDecision<T>;
  try { decision = await decide(live); } catch (err) { throw new Error(`${errorText(err)} (escrow ${escrow})`); }
  if (layout === 'identity' && decision.validTo - decision.validFrom > MAX_RANGE_MS) throw new Error(`The validity range would be longer than one hour, which the escrow refuses (Part 2 Section 6.1); nothing was built. (escrow ${escrow})`);
  let zeroTime: number;
  // A clock that is not a number is said as what it is (ChainClockError carries nothing the node said); any other failure is a node failure.
  try { zeroTime = await ensureSlotConfig(provider as unknown as SlotClockProvider); } catch (err) {
    throw err instanceof ChainClockError ? err : new Error(`Could not read the chain clock from the node: ${nodeFailure(err)}`);
  }
  assertWholeSecondSlots(zeroTime);
  await assertWalletIs(lucid, p.changeAddress);
  assertCollateral(await lucid.wallet().getUtxos());
  const script = layout === 'legacy' ? await escrowRefScript(provider) : await readRefScript(provider, deployment!, 'escrow', deployment!.escrow.hash);
  let tx = lucid.newTx().readFrom([script, ...decision.refs]).collectFrom([live.utxo], decision.redeemerHex);
  for (const payout of decision.payouts) {
    tx = payout.datum === null ? tx.pay.ToAddress(payout.address, payout.assets) : tx.pay.ToAddressWithData(payout.address, { kind: 'inline', value: payout.datum }, payout.assets);
  }
  for (const hash of decision.signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx
    .validFrom(decision.validFrom)
    .validTo(decision.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE)
    .complete(layout === 'legacy' ? { localUPLCEval: false } : {});
  const build = signedByResult(completed, { lo: decision.validFrom, hi: decision.validTo }, decision.signers, callerPkh);
  const agentDid = isIdentityEscrow(live.datum) ? didOf(live.datum.agent_id) : null;
  return { build: { ...build, escrowRef: escrow, layout, agentDid }, terms: decision.terms, datum: live.datum };
}

/** What an Accept pays, for the signer: `escrowRef` is the caller's ref in canonical form; the key is the supplier the datum names. */
export interface AcceptTerms {
  escrowRef: string; supplierPkh: string;
  supplierLovelace: bigint; supplierRaised: boolean; buyerLovelace: bigint; buyerRaised: boolean;
  secondsLeft: number;
  /** Where the buyer bond goes: the caller's wallet, or the escrow's refund address (identity layout). */
  buyerAddress: string;
}
/** What a Reclaim returns, for the signer; `supplierPkh` is the supplier the escrow was posted for. */
export interface ReclaimTerms {
  escrowRef: string; supplierPkh: string; buyerLovelace: bigint; buyerRaised: boolean;
  /** Where the refund goes: the caller's wallet, or the escrow's refund address (identity layout, anybody may submit it). */
  buyerAddress: string;
  /** True for a full refund (all the escrow holds) to the refund address, which anybody may build and submit. */
  fullRefund: boolean;
}

/**
 * Builds the unsigned Accept of a Submitted escrow: pays the supplier price + supplier bond, returns the buyer bond, and must land
 * within 600 s of Submit. Only the buyer can accept (both layouts); that and the escrow's state and window are checked (planAccept)
 * before anything is built. The escrow's live UTxO comes from resolveEscrowLineage, which fails closed. The buyer bond goes to the
 * change address, or for an identity-marketplace escrow that names a refund to exactly the refund address with its datum (raised to
 * the ledger minimum of that output when the bond is less); the identity escrow's range is cut to one hour.
 *
 * A script spend needs collateral, and Lucid takes it from the wallet: a pure-lovelace output of at least 5 units must exist
 * (checked first, so the refusal reads as one instead of as a ledger error); buildPostEscrow's `collateralKept` says whether the
 * Post left one. The wallet must be the one bound to `changeAddress`. The validator is read from the reference script of the
 * escrow's layout (ESCROW_REF_UTXO for the legacy escrow, evaluated by the node with `localUPLCEval: false`), the plan's validity
 * bounds reach the transaction unchanged, and nothing is signed or submitted. `fetchImpl` stands in for fetch in the Koios calls (tests).
 */
export async function buildAccept(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: EscrowSpendParams, fetchImpl: typeof fetch = fetch)
  : Promise<EscrowSpendBuild & AcceptTerms> {
  const { build, terms } = await buildEscrowSpend(lucid, provider, koiosUrl, p, fetchImpl, (live) => {
    const plan = planAccept(live.datum, live.callerPkh, live.nowMs);
    const buyer = payoutOf(live, buyerPayoutTo(live.datum, live.changeAddress), plan.buyerLovelace);
    // The identity escrow refuses a range over one hour; a Submit's submitted_at is its upper bound, which can lie up to an hour ahead.
    const validFrom = live.layout === 'identity' ? Math.max(plan.validFrom, plan.validTo - MAX_RANGE_MS) : plan.validFrom;
    return {
      redeemerHex: plan.redeemerHex, validFrom, validTo: plan.validTo,
      payouts: [{ address: plan.supplierAddress, assets: { lovelace: plan.supplierLovelace }, datum: null }, buyer.payout],
      signers: new SignerList().add(live.datum.buyer_pkh, 'buyer'), refs: [],
      terms: {
        supplierPkh: plan.supplierPkh, supplierLovelace: plan.supplierLovelace, supplierRaised: plan.supplierRaised,
        buyerLovelace: buyer.payout.assets.lovelace, buyerRaised: plan.buyerRaised || buyer.raised, secondsLeft: plan.secondsLeft, buyerAddress: buyer.payout.address,
      },
    };
  });
  return { ...build, ...terms };
}

/**
 * Builds the unsigned Reclaim of an Open or Claimed escrow whose deliver_by has passed: payment and both bonds go back to the buyer.
 * The state and the opening time are checked (planReclaim) before anything is built. Without a refund address (every legacy escrow)
 * only the buyer can reclaim, and the refund goes to the change address. An identity-marketplace escrow that names a refund address
 * (every escrow that buildPostEscrow posts in that layout, and every vault payment) can be reclaimed by anybody (Part 2 Section 6.1):
 * the caller's wallet only pays the fee, and everything the escrow holds goes to exactly the refund address with its datum.
 * Collateral, wallet binding, reference script, evaluation and the plan's validity bounds are as for buildAccept: a pure-lovelace
 * output of at least 5 units must exist in the wallet, and `fetchImpl` is for tests.
 */
export async function buildReclaim(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: EscrowSpendParams, fetchImpl: typeof fetch = fetch)
  : Promise<EscrowSpendBuild & ReclaimTerms> {
  const { build, terms } = await buildEscrowSpend(lucid, provider, koiosUrl, p, fetchImpl, (live) => {
    const { datum } = live;
    if (isIdentityEscrow(datum) && datum.refund !== null) {
      // With a refund address anybody may reclaim, and the payouts are a full refund: at least what the escrow input holds.
      const plan = reclaimTiming(datum, live.nowMs, () => ({}));
      const refund = payoutOf(live, buyerPayoutTo(datum, live.changeAddress), live.utxo.assets.lovelace, otherAssetsOf(live.utxo));
      return {
        redeemerHex: plan.redeemerHex, validFrom: plan.validFrom, validTo: plan.validTo, payouts: [refund.payout], signers: new SignerList(), refs: [],
        terms: { supplierPkh: plan.supplierPkh, buyerLovelace: refund.payout.assets.lovelace, buyerRaised: refund.raised, buyerAddress: refund.payout.address, fullRefund: true },
      };
    }
    const plan = planReclaim(datum, live.callerPkh, live.nowMs);
    return {
      redeemerHex: plan.redeemerHex, validFrom: plan.validFrom, validTo: plan.validTo,
      payouts: [{ address: live.changeAddress, assets: { lovelace: plan.buyerLovelace }, datum: null }],
      signers: new SignerList().add(datum.buyer_pkh, 'buyer'), refs: [],
      terms: { supplierPkh: plan.supplierPkh, buyerLovelace: plan.buyerLovelace, buyerRaised: plan.buyerRaised, buyerAddress: live.changeAddress, fullRefund: false },
    };
  });
  return { ...build, ...terms };
}

/** What a Release pays the supplier, for the signer. */
export interface ReleaseTerms { supplierPkh: string; supplierLovelace: bigint; supplierRaised: boolean }

/**
 * Builds the unsigned Release of a Submitted escrow whose accept window has passed (escrow.ak handle_release; escrow/rules.ak
 * release), in either layout: the supplier key signs, and payment + supplier bond + buyer bond go to the change address, whose payment
 * credential must be the supplier key; whatever else the escrow holds comes back as change. The window opens on the first whole
 * second after submitted_at + 600 s and closes after `validMinutes` (default 30). Collateral, wallet binding, reference script and
 * evaluation are as for buildAccept.
 */
export async function buildRelease(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: EscrowSpendParams, fetchImpl: typeof fetch = fetch)
  : Promise<EscrowSpendBuild & ReleaseTerms> {
  const { build, terms } = await buildEscrowSpend(lucid, provider, koiosUrl, p, fetchImpl, (live) => {
    const plan = planRelease(live.datum, live.callerPkh, live.nowMs, windowAt(live.nowMs, live.validMinutes));
    return {
      redeemerHex: plan.redeemerHex, validFrom: plan.validFrom, validTo: plan.validTo,
      payouts: [{ address: live.changeAddress, assets: { lovelace: plan.supplierLovelace }, datum: null }],
      signers: new SignerList().add(live.datum.supplier_pkh, 'supplier'), refs: [],
      terms: { supplierPkh: plan.supplierPkh, supplierLovelace: plan.supplierLovelace, supplierRaised: plan.supplierRaised },
    };
  });
  return { ...build, ...terms };
}

/** What a RefundRevoked returns, and why the record allows it. */
export interface RefundTerms {
  /** All the escrow holds, at least: the full refund. */
  buyerLovelace: bigint; buyerRaised: boolean;
  /** The refund address of the escrow, or the enterprise address of the buyer key when it names none. */
  buyerAddress: string;
  agentId: string; recordStatus: Status['type'];
}

/**
 * Builds the unsigned RefundRevoked of an identity-marketplace escrow (Part 2 Section 6.1): anybody, before or after deliver_by, when
 * the record of its agent allows it (refundRevokedRefusal: the record's own status). The record is a reference input. Everything the
 * escrow holds goes to exactly the refund address with its datum, or to the enterprise address of buyer_pkh when the escrow names no
 * refund. The caller's wallet pays the fee and gives the collateral; nobody else signs. A legacy escrow has no such redeemer.
 */
export async function buildRefundRevoked(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: EscrowSpendParams, fetchImpl: typeof fetch = fetch)
  : Promise<EscrowSpendBuild & RefundTerms> {
  const { build, terms } = await buildEscrowSpend(lucid, provider, koiosUrl, p, fetchImpl, async (live) => {
    const { datum } = live;
    if (!isIdentityEscrow(datum) || live.deployment === null) throw new Error('RefundRevoked exists only for identity-marketplace escrows (Part 2 Section 6.1); a legacy escrow returns its funds by Reclaim after deliver_by.');
    const found = await findRecord(provider, live.deployment, datum.agent_id);
    if (!found) throw new Error(`The agent ${didOf(datum.agent_id)} of the escrow has no record in the identity registry, so RefundRevoked cannot show its status.`);
    const why = refundRevokedRefusal(datum, found.record.status);
    if (why !== null) throw new Error(`RefundRevoked is not allowed: ${why}.`);
    const window = windowAt(live.nowMs, live.validMinutes);
    const refund = payoutOf(live, buyerPayoutTo(datum, enterpriseAddressOf(datum.buyer_pkh)), live.utxo.assets.lovelace, otherAssetsOf(live.utxo));
    return {
      redeemerHex: redeemerHex(REDEEMER.RefundRevoked), validFrom: window.lo, validTo: window.hi, payouts: [refund.payout], signers: new SignerList(), refs: [found.utxo],
      terms: { buyerLovelace: refund.payout.assets.lovelace, buyerRaised: refund.raised, buyerAddress: refund.payout.address, agentId: datum.agent_id, recordStatus: found.record.status.type },
    };
  });
  return { ...build, ...terms };
}
