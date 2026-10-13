// packages/builder/src/vector/marketplace-build.ts
// Keyless marketplace transaction building. Every builder returns UNSIGNED CBOR through toBuildResult; signing
// happens on the member's local signer. The plan functions are pure: they decide what a transaction must say, so the
// same numbers can be shown to the signer and unit-tested without a chain.
import { Data, Constr, CML, credentialToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { ensureSlotConfig, paymentKeyHashOf } from './gov-build.js';
import type { SlotClockProvider } from './gov-build.js';
import {
  ESCROW_ADDRESS, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MAX_PROCESSING_MS_CEILING, MARKETPLACE_MIN_FEE,
  COLLATERAL_MIN_LOVELACE, MIN_UTXO_LOVELACE, REDEEMER,
} from './marketplace-constants.js';
import {
  advertTextFieldsRoundTrip, encodeEscrowDatum, requestSpecHash, promptHashForPayload,
  escrowLockFloor, parseOutRef, formatOutRef,
} from './marketplace-datum.js';
import type { AdvertDatum, EscrowDatum } from './marketplace-datum.js';
import { readAdvert, koiosTxInputCreds } from './marketplace-indexer.js';

// One definition of "the payment key hash of a change address" for every builder family: gov-build's, re-exported.
export { paymentKeyHashOf };
export function enterpriseAddressOf(pkh: string): string { return credentialToAddress('Mainnet', { type: 'Key', hash: pkh }); }
const redeemerHex = (idx: number) => Data.to(new Constr(idx, []));
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** `new Error(message, { cause })`: Node has had the option since v16.9, but the type library this package compiles against (ES2020) does not declare it. */
const ErrorWithCause = Error as new (message?: string, options?: { cause?: unknown }) => Error;
/** ISO text for error messages; a datum can hold a time no Date can represent, and that must not replace the real message with a RangeError. */
const iso = (ms: number) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString(); };

// ─── Post ───────────────────────────────────────────────────────────────────

/**
 * What a Post commits the buyer to, in the terms the signer needs before signing: who is paid (the supplier key and the
 * host its endpoint is on), for which capability, the price and both bonds, the lock, and the deadline from which the
 * buyer can Reclaim. supplierPkh, endpointHost and capabilityId come from the advert, which anyone can write: show them
 * escaped.
 */
export interface PostEscrowTerms {
  supplierPkh: string; endpointHost: string; capabilityId: string;
  priceLovelace: bigint; supplierBondLovelace: bigint; buyerBondLovelace: bigint;
  /** price + both bonds, raised to the min-UTxO floor of the escrow's largest datum. */
  lockLovelace: bigint;
  /** POSIX ms. */
  deliverBy: number;
}
export interface PostEscrowPlan extends PostEscrowTerms { datum: EscrowDatum }
export type PostEscrowBuild = VectorUnsignedBuildResult & PostEscrowTerms & {
  escrowRef: string; promptHash: string;
  /**
   * True when the wallet's smallest pure output of at least 5 units was held back, so it is still there as collateral for
   * Accept and Reclaim. False on the fallback (nothing to spare, or the reserved selection did not complete): that output
   * may then be spent, and the wallet has collateral afterwards only if some pure output of at least 5 units remains,
   * for instance this Post's own change.
   */
  collateralKept: boolean;
};

/** The host the endpoint URL really connects to (userinfo dropped, port kept, IDN in punycode), or an error: a signer must be able to see who is paid. */
function endpointHostOf(endpointUrl: string, advertRef: string): string {
  let host = '';
  try { host = new URL(endpointUrl).host; } catch { /* refused below */ }
  if (!host) throw new Error(`Advert ${advertRef} has an endpoint that is not a usable URL with a host, so a job could not be delivered to it.`);
  return host;
}

/**
 * Pure. The escrow datum a Post would write and the terms the signer is shown. Throws a readable Error for an advert it
 * must not post against: retired, the buyer's own, a window or endpoint that cannot work, numbers the datum cannot hold.
 * A buyer cannot Reclaim before deliver_by, so the supplier-chosen window is capped (MAX_PROCESSING_MS_CEILING) and so is a
 * caller-chosen deliver_by, which also catches a value given in microseconds.
 */
export function planPostEscrow(advert: AdvertDatum, advertRef: string, buyerPkh: string, payload: string, nowMs: number, deliverByMs?: number): PostEscrowPlan {
  if (advert.status !== 'Active') throw new Error(`Advert ${advertRef} is retired; pick another supplier.`);
  if (advert.supplier_pkh === buyerPkh) throw new Error('The buyer cannot be the supplier of the same advert.');
  if (typeof payload !== 'string' || payload.length === 0) throw new Error('payload must be a non-empty string');
  if (!Number.isSafeInteger(nowMs)) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  if (deliverByMs !== undefined && !Number.isSafeInteger(deliverByMs)) throw new Error('deliver_by must be a whole number of POSIX milliseconds');
  const ref = parseOutRef(advertRef);
  const window = advert.max_processing_ms;
  if (!Number.isInteger(window) || window < 0) throw new Error(`Advert ${advertRef} has an unusable processing window (${window} ms).`);
  if (window > MAX_PROCESSING_MS_CEILING) throw new Error(`Advert ${advertRef} advertises a processing window of ${window} ms, longer than the ${MAX_PROCESSING_MS_CEILING} ms (24 h) a Post will lock funds for.`);
  const endpointHost = endpointHostOf(advert.endpoint_url, advertRef);
  const furthest = MAX_PROCESSING_MS_CEILING + DELIVER_BY_BUFFER_MS;
  if (deliverByMs !== undefined && deliverByMs - nowMs > furthest) throw new Error(`deliver_by is ${deliverByMs - nowMs} ms from now, more than the ${furthest} ms (24 h plus the buffer) a Post will lock funds for; deliver_by is POSIX milliseconds, check the unit.`);
  const deliverBy = deliverByMs ?? nowMs + window + DELIVER_BY_BUFFER_MS;
  if (!Number.isSafeInteger(deliverBy) || deliverBy <= nowMs + window) throw new Error(`deliver_by must leave the supplier its full window of ${window} ms`);
  const datum: EscrowDatum = {
    buyer_pkh: buyerPkh, supplier_pkh: advert.supplier_pkh,
    advert_ref: { txHash: ref.txHash, index: ref.outputIndex }, capability_id: advert.capability_id,
    request_spec_hash: requestSpecHash(advert), prompt_hash: promptHashForPayload(payload),
    payment_lovelace: advert.price_lovelace, buyer_bond_lovelace: advert.buyer_bond_lovelace, supplier_bond_lovelace: advert.supplier_bond_lovelace,
    deliver_by: deliverBy, posted_at: nowMs, submitted_at: null, result_receipt_hash: null, state: 'Open',
  };
  const economic = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
  // The advert's numbers are the supplier's to choose. The datum writer refuses what it cannot frame (negative, past
  // uint64); say so in terms of the advert instead of leaking a bare RangeError.
  let lockLovelace: bigint;
  try { lockLovelace = escrowLockFloor(datum, economic); } catch (err) { throw new Error(`Advert ${advertRef} cannot be posted: its terms do not fit an escrow datum (${errorText(err)}).`); }
  return {
    datum, lockLovelace, deliverBy,
    supplierPkh: advert.supplier_pkh, endpointHost, capabilityId: advert.capability_id,
    priceLovelace: advert.price_lovelace, supplierBondLovelace: advert.supplier_bond_lovelace, buyerBondLovelace: advert.buyer_bond_lovelace,
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
 * datum) is an error, never a result.
 */
export function assertEscrowIsOutputZero(txCbor: string, expected: { datumHex: string; lockLovelace: bigint }): void {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  const first = outputs.len() > 0 ? outputs.get(0) : undefined;
  const ok = first !== undefined
    && first.address().to_bech32() === ESCROW_ADDRESS
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

/**
 * Builds the unsigned Post: locks price + both bonds in a new escrow (output 0) for the advert. Reads the advert through
 * readAdvert and refuses one that is spent, retired, not valid UTF-8 or not created by its supplier key, and a buyer who
 * is the supplier. Funds the Post without the wallet's smallest pure 5-unit output when it can (collateralKept), and
 * checks the built transaction really has the escrow at output 0. `fetchImpl` stands in for fetch in the two Koios calls
 * (tests). Nothing is signed or submitted.
 */
export async function buildPostEscrow(
  lucid: LucidEvolution, provider: Provider,
  p: { changeAddress: string; advertRef: string; payload: string; nowMs?: number; deliverByMs?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<PostEscrowBuild> {
  const buyerPkh = paymentKeyHashOf(p.changeAddress);
  let read: Awaited<ReturnType<typeof readAdvert>>;
  try { read = await readAdvert(p.advertRef, fetchImpl); } catch (err) { throw new Error(`Could not read advert ${p.advertRef.trim()}: ${errorText(err)}`); }
  if ('error' in read) throw new Error(read.error);
  const { utxo, advert } = read;
  const advertRef = formatOutRef(utxo.tx_hash.toLowerCase(), utxo.tx_index);
  if (read.spent) throw new Error(`Advert ${advertRef} has been spent (its supplier retired or replaced it); pick another advert.`);
  if (utxo.is_spent !== false) throw new Error(`Koios did not report whether advert ${advertRef} is unspent; refusing to hire it.`);
  const advertDatumHex = utxo.inline_datum?.bytes;
  if (!advertDatumHex || !advertTextFieldsRoundTrip(advertDatumHex)) throw new Error(`Advert ${advertRef} has text fields that are not valid UTF-8, so the escrow could not carry its capability id faithfully; refusing to hire it.`);
  const nowMs = p.nowMs ?? Date.now();
  const plan = planPostEscrow(advert, advertRef, buyerPkh, p.payload, nowMs, p.deliverByMs);
  await assertAdvertAuthor(advertRef, utxo.tx_hash, advert.supplier_pkh, fetchImpl);

  await ensureSlotConfig(provider as unknown as SlotClockProvider);
  const escrowDatumHex = encodeEscrowDatum(plan.datum);
  // A fresh builder per attempt: one that failed in complete() is not reused.
  const assemble = () => lucid.newTx()
    .pay.ToAddressWithData(ESCROW_ADDRESS, { kind: 'inline', value: escrowDatumHex }, { lovelace: plan.lockLovelace })
    .addSignerKey(buyerPkh)
    .validFrom(nowMs - 60_000)
    .validTo(plan.deliverBy)
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
  assertEscrowIsOutputZero(r.txCbor, { datumHex: escrowDatumHex, lockLovelace: plan.lockLovelace });
  const { datum, ...terms } = plan;
  return { ...r, ...terms, escrowRef: formatOutRef(r.txHash, 0), promptHash: datum.prompt_hash, collateralKept };
}

// ─── Accept / Reclaim plans (pure) ──────────────────────────────────────────
export function planAccept(datum: EscrowDatum, callerPkh: string, nowMs: number) {
  if (datum.buyer_pkh !== callerPkh) throw new Error('This escrow was posted by another key; you are not the buyer.');
  if (datum.state !== 'Submitted' || datum.submitted_at === null) throw new Error(`Escrow state is ${datum.state}; Accept needs Submitted.`);
  const validTo = datum.submitted_at + ACCEPT_WINDOW_MS;
  if (nowMs > validTo) throw new Error(`Accept window closed at ${iso(validTo)}; the supplier may now Release.`);
  const supplierDue = datum.payment_lovelace + datum.supplier_bond_lovelace;
  return {
    supplierAddress: enterpriseAddressOf(datum.supplier_pkh),
    supplierLovelace: supplierDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : supplierDue,
    buyerLovelace: datum.buyer_bond_lovelace < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : datum.buyer_bond_lovelace,
    validFrom: nowMs - 60_000, validTo, redeemerHex: redeemerHex(REDEEMER.Accept), secondsLeft: Math.floor((validTo - nowMs) / 1000),
  };
}

/**
 * escrow.ak (handle_reclaim) accepts a Reclaim only when the validity range starts at or after deliver_by. Lucid floors
 * validFrom to the slot that contains it, and the script sees that slot's start, so a validFrom taken from an unaligned
 * deliver_by (almost every default one is) lands up to 999 ms before it and the validator rejects the transaction. The Reclaim
 * therefore opens at the first whole second strictly after deliver_by, which is a slot boundary no earlier than it. There
 * is no closing deadline in the validator, so the upper bound leaves ten minutes for a person to sign.
 */
export function planReclaim(datum: EscrowDatum, callerPkh: string, nowMs: number) {
  if (datum.buyer_pkh !== callerPkh) throw new Error('This escrow was posted by another key; you are not the buyer.');
  if (datum.state !== 'Open' && datum.state !== 'Claimed') throw new Error(`Escrow state is ${datum.state}; Reclaim needs Open or Claimed.`);
  const opens = Math.ceil((datum.deliver_by + 1) / 1000) * 1000;
  if (nowMs < opens) throw new Error(`Reclaim opens at ${iso(opens)}: deliver_by is ${iso(datum.deliver_by)}, and the validity range may start only on a whole second after it.`);
  const due = datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace;
  return { buyerLovelace: due < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : due, validFrom: Math.max(opens, nowMs - 60_000), validTo: nowMs + 600_000, redeemerHex: redeemerHex(REDEEMER.Reclaim) };
}
