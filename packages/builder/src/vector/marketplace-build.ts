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
  ESCROW_ADDRESS, ESCROW_REF_UTXO, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MAX_PROCESSING_MS_CEILING, MARKETPLACE_MIN_FEE,
  COLLATERAL_MIN_LOVELACE, MIN_UTXO_LOVELACE, REDEEMER,
} from './marketplace-constants.js';
import {
  advertTextFieldsRoundTrip, decodeEscrowDatum, encodeEscrowDatum, requestSpecHash, promptHashForPayload,
  escrowLockFloor, parseOutRef, formatOutRef,
} from './marketplace-datum.js';
import type { AdvertDatum, EscrowDatum, EscrowState } from './marketplace-datum.js';
import { readAdvert, koiosTxInputCreds, koiosTxInputRefs, koiosUtxoInfo } from './marketplace-indexer.js';
import type { KoiosUtxo } from './marketplace-indexer.js';

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

// ─── Lineage ────────────────────────────────────────────────────────────────

export interface EscrowLineage {
  /** The datum of the output `escrowRef` names: for the ref buildPostEscrow returns, the Post output as posted (state Open). */
  posted: EscrowDatum;
  /** The live UTxO and its datum; null when the escrow is finished (Accepted, Reclaimed or Released) or no UTxO at the escrow address carries it on. */
  current: { utxo: UTxO; datum: EscrowDatum } | null;
  /** Koios says the posted output has been spent. */
  spent: boolean;
}

type LiveEscrow = { utxo: UTxO; datum: EscrowDatum };

/**
 * What a failed Koios call may tell a caller. The messages of koiosUtxoInfo and koiosTxInputRefs name only the operation and
 * the status; any other failure (a transport error can carry the endpoint's host or URL) becomes a fixed phrase.
 */
function koiosFailure(err: unknown): string {
  const message = errorText(err);
  return /^Koios (utxo_info|tx_info)/.test(message) ? message : 'Koios request failed (network error or timeout)';
}

/** What an escrow's datum says is owed between the parties: the payment and both bonds, all that Accept and Reclaim pay out. */
const owedLovelace = (d: EscrowDatum): bigint => d.payment_lovelace + d.buyer_bond_lovelace + d.supplier_bond_lovelace;
const heldLovelace = (u: UTxO): bigint => u.assets.lovelace ?? 0n;
/** The candidate rule: Claim and Submit leave advert_ref, buyer_pkh, posted_at and prompt_hash as they were posted. Public, so copyable: it only picks candidates. */
const carriesFieldsOf = (posted: EscrowDatum, d: EscrowDatum): boolean =>
  d.advert_ref.txHash === posted.advert_ref.txHash && d.advert_ref.index === posted.advert_ref.index
  && d.buyer_pkh === posted.buyer_pkh && d.posted_at === posted.posted_at && d.prompt_hash === posted.prompt_hash;
/** The states an escrow has a UTxO in, in the order Claim and Submit take it through them. Accepted, Reclaimed and Released are terminal: nothing is left at the escrow address. */
const LIVE_STATES: EscrowState[] = ['Open', 'Claimed', 'Submitted'];
const txOf = (ref: string): string => ref.slice(0, 64);
const refOf = (e: LiveEscrow): string => formatOutRef(e.utxo.txHash.toLowerCase(), e.utxo.outputIndex);
const named = (list: LiveEscrow[]): string => list.map(refOf).sort().join(', ');

/**
 * Which of `candidates` descend from the escrow output `rootRef` by the spend chain, and which Koios cannot tell yet because it
 * does not know a transaction on the way (see resolveEscrowLineage). A candidate one state past the root's was made by a
 * transaction that spent the root; one two states past was made by a transaction that spent an escrow output whose own
 * transaction spent the root. Only inputs at the escrow address count, so a transfer that merely spends the supplier's change
 * from the Claim is no link. One tx_info batch covers the candidates' transactions, a second the step between when one is needed.
 */
async function descendantsOf(rootRef: string, root: EscrowDatum, candidates: LiveEscrow[], koiosUrl: string, fetchImpl: typeof fetch): Promise<{ genuine: LiveEscrow[]; unknown: LiveEscrow[] }> {
  // transaction hash -> the escrow outputs that transaction spent; a transaction Koios does not know is absent
  const escrowInputsOf = async (txHashes: string[]): Promise<Map<string, string[]>> => {
    try { return await koiosTxInputRefs(koiosUrl, txHashes, fetchImpl, ESCROW_ADDRESS); } catch (err) { throw new Error(`Could not read escrow ${rootRef}: ${koiosFailure(err)}`); }
  };
  const rootStep = LIVE_STATES.indexOf(root.state);
  const stepsPastRoot = (c: LiveEscrow): number => { const step = LIVE_STATES.indexOf(c.datum.state); return rootStep < 0 || step < 0 ? 0 : step - rootStep; };
  const reachable = candidates.filter((c) => stepsPastRoot(c) === 1 || stepsPastRoot(c) === 2); // a copy in any other state cannot come after the root
  const spentByTx = await escrowInputsOf(reachable.map((c) => c.utxo.txHash));
  const genuine: LiveEscrow[] = [];
  const unknown: LiveEscrow[] = [];
  const twoSteps: Array<{ candidate: LiveEscrow; spent: string[] }> = [];
  for (const c of reachable) {
    const spent = spentByTx.get(c.utxo.txHash.toLowerCase());
    if (spent === undefined) unknown.push(c);
    else if (stepsPastRoot(c) === 1) { if (spent.includes(rootRef)) genuine.push(c); }
    else twoSteps.push({ candidate: c, spent });
  }
  const middle = await escrowInputsOf(twoSteps.flatMap(({ spent }) => spent.map(txOf)));
  for (const { candidate, spent } of twoSteps) {
    const behind = spent.map((ref) => middle.get(txOf(ref)));
    if (behind.some((inputs) => inputs?.includes(rootRef))) genuine.push(candidate);
    else if (behind.some((inputs) => inputs === undefined)) unknown.push(candidate);
  }
  return { genuine, unknown };
}

/**
 * Where is this escrow now? `escrowRef` names the Post output (`<txHash>#0`, as buildPostEscrow returns it); a later output of
 * the same escrow works too. While that output is unspent it is the live escrow. Once it is spent, the live one is the UTxO at
 * the escrow address that descends from it by the SPEND CHAIN, and `spent: true` with `current: null` means the escrow is
 * finished.
 *
 * Why the datum is not enough. Claim and Submit leave advert_ref, buyer_pkh, posted_at and prompt_hash as posted, so those four
 * fields pick the candidates; but they are public, and anyone can lock a UTxO at the escrow address that carries copies of
 * them. What a copy cannot fake is how it came to be. escrow.ak lets Claim and Submit make exactly one output at the escrow
 * credential, so the true continuation is the output of the transaction that spent the previous escrow output: Post output,
 * Claim, Claimed output, Submit, Submitted output. A candidate in state Claimed is genuine when the transaction that made it
 * spent the posted output; one in state Submitted when its transaction spent an escrow output whose transaction spent the posted
 * output. Koios tx_info answers both questions in at most two batched calls (none when nothing carries the escrow on, one when
 * the live output is Claimed).
 *
 * Fails closed. Anyone can lock a UTxO at the escrow address with any datum, and Accept pays what the datum says, with the
 * wallet making up whatever the escrow output does not cover; so a UTxO counts as an escrow only when it is at ESCROW_ADDRESS,
 * holds an escrow datum, and holds at least the payment and both bonds that datum owes. It throws, naming the escrow, when
 * Koios cannot be read or does not say whether the Post output is spent, when Koios and the node disagree about it, when
 * UTxOs carry the escrow's fields but none provably descends from it (or Koios does not know a transaction on the way yet), and
 * when two of them do. A Koios failure's message carries neither the endpoint nor a response body. `fetchImpl` stands in for
 * fetch in the Koios calls (tests).
 */
export async function resolveEscrowLineage(provider: Provider, koiosUrl: string, escrowRef: string, fetchImpl: typeof fetch = fetch): Promise<EscrowLineage> {
  const ref = parseOutRef(escrowRef);
  const canonical = formatOutRef(ref.txHash, ref.outputIndex);
  let rows: KoiosUtxo[];
  try { rows = await koiosUtxoInfo(koiosUrl, [canonical], fetchImpl); } catch (err) { throw new Error(`Could not read escrow ${canonical}: ${koiosFailure(err)}`); }
  const row = rows.find((u) => String(u?.tx_hash).toLowerCase() === ref.txHash && u?.tx_index === ref.outputIndex);
  if (!row) throw new Error(`Escrow ${canonical} not found on the ledger.`);
  if (typeof row.address !== 'string' || row.address.toLowerCase() !== ESCROW_ADDRESS) throw new Error(`UTxO ${canonical} is not at the escrow script address.`);
  let posted: EscrowDatum;
  try { posted = decodeEscrowDatum(row.inline_datum?.bytes ?? ''); } catch { throw new Error(`UTxO ${canonical} does not hold an escrow datum.`); }
  if (typeof row.is_spent !== 'boolean') throw new Error(`Koios did not report whether escrow ${canonical} is spent; refusing to guess where it is.`);

  if (!row.is_spent) {
    const [utxo] = await provider.getUtxosByOutRef([ref]);
    if (!utxo || utxo.address !== ESCROW_ADDRESS || !utxo.datum) {
      throw new Error(`Koios reports escrow ${canonical} as unspent, but the node does not list it as a live escrow output; the node may be behind Koios, retry in a few seconds.`);
    }
    if (heldLovelace(utxo) < owedLovelace(posted)) {
      throw new Error(`Escrow ${canonical} is not funded: its datum owes ${owedLovelace(posted)} lovelace but the output holds ${heldLovelace(utxo)}; refusing to treat it as an escrow.`);
    }
    return { posted, current: { utxo, datum: posted }, spent: false };
  }

  const candidates: LiveEscrow[] = [];
  for (const u of await provider.getUtxos(ESCROW_ADDRESS)) {
    if (!u.datum) continue;
    // A node that lags Koios may still list the output Koios says is spent: that is where the escrow was, not where it is.
    if (u.txHash.toLowerCase() === ref.txHash && u.outputIndex === ref.outputIndex) continue;
    let d: EscrowDatum;
    try { d = decodeEscrowDatum(u.datum); } catch { continue; }
    if (carriesFieldsOf(posted, d) && heldLovelace(u) >= owedLovelace(d)) candidates.push({ utxo: u, datum: d });
  }
  if (candidates.length === 0) return { posted, current: null, spent: true };
  const { genuine, unknown } = await descendantsOf(canonical, posted, candidates, koiosUrl, fetchImpl);
  if (genuine.length === 1) return { posted, current: genuine[0], spent: true };
  if (genuine.length > 1) throw new Error(`More than one UTxO descends from escrow ${canonical} by the spend chain (${named(genuine)}); refusing to choose between them.`);
  throw new Error(unknown.length > 0
    ? `Cannot tell which UTxO carries escrow ${canonical} on: Koios does not know the transaction behind ${named(unknown)} yet; retry in a few seconds.`
    : `None of ${named(candidates)} descends from escrow ${canonical} by the spend chain, though they carry its fields; refusing to treat any of them as the escrow.`);
}

// ─── Accept / Reclaim builders ──────────────────────────────────────────────

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
  const [u] = await provider.getUtxosByOutRef([ESCROW_REF_UTXO]);
  if (!u?.scriptRef) throw new Error(`Escrow reference script ${formatOutRef(ESCROW_REF_UTXO.txHash, ESCROW_REF_UTXO.outputIndex)} not found; the marketplace needs to republish it.`);
  return u;
}

/** Lucid picks the collateral itself. This only turns a wallet with nothing suitable into a readable refusal instead of a ledger error. */
function assertCollateral(utxos: UTxO[]) {
  if (!utxos.some((u) => Object.keys(u.assets).every((k) => k === 'lovelace') && u.assets.lovelace >= COLLATERAL_MIN_LOVELACE)) {
    throw new Error('Collateral required: the wallet must hold one pure output of at least 5 units.');
  }
}

/**
 * Builds the unsigned Accept of a Submitted escrow: pays the supplier price + supplier bond, returns the buyer bond to the
 * change address, and must land within 600 s of Submit. Only the buyer can accept; that and the escrow's state and window are
 * checked (planAccept) before anything is built. The escrow's live UTxO comes from resolveEscrowLineage, which fails closed.
 *
 * A script spend needs collateral, and Lucid takes it from the wallet: a pure-lovelace output of at least 5 units must exist
 * (checked first, so the refusal reads as one instead of as a ledger error); buildPostEscrow's `collateralKept` says whether the
 * Post left one. The validator is read from the reference script at ESCROW_REF_UTXO, the node evaluates it
 * (`localUPLCEval: false`), the plan's validity bounds reach the transaction unchanged, and nothing is signed or submitted.
 * `fetchImpl` stands in for fetch in the Koios call (tests).
 */
export async function buildAccept(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: { changeAddress: string; escrowRef: string; nowMs?: number }, fetchImpl: typeof fetch = fetch)
  : Promise<VectorUnsignedBuildResult & { supplierLovelace: bigint; buyerLovelace: bigint; secondsLeft: number }> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  const lineage = await resolveEscrowLineage(provider, koiosUrl, p.escrowRef, fetchImpl);
  if (!lineage.current) throw new Error(`Escrow ${p.escrowRef} has no live UTxO: it was already accepted, released or reclaimed.`);
  const plan = planAccept(lineage.current.datum, callerPkh, p.nowMs ?? Date.now());
  assertWholeSecondSlots(await ensureSlotConfig(provider as unknown as SlotClockProvider));
  assertCollateral(await lucid.wallet().getUtxos());
  const completed = await lucid.newTx()
    .readFrom([await escrowRefScript(provider)])
    .collectFrom([lineage.current.utxo], plan.redeemerHex)
    .pay.ToAddress(plan.supplierAddress, { lovelace: plan.supplierLovelace })
    .pay.ToAddress(p.changeAddress, { lovelace: plan.buyerLovelace })
    .addSignerKey(callerPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE)
    .complete({ localUPLCEval: false });
  return { ...toBuildResult(completed), supplierLovelace: plan.supplierLovelace, buyerLovelace: plan.buyerLovelace, secondsLeft: plan.secondsLeft };
}

/**
 * Builds the unsigned Reclaim of an Open or Claimed escrow whose deliver_by has passed: payment and both bonds go back to the
 * change address. Only the buyer can reclaim; that, the state and the opening time are checked (planReclaim) before anything is
 * built. Collateral, reference script, evaluation and the plan's validity bounds are as for buildAccept: a pure-lovelace output
 * of at least 5 units must exist in the wallet, and `fetchImpl` is for tests.
 */
export async function buildReclaim(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: { changeAddress: string; escrowRef: string; nowMs?: number }, fetchImpl: typeof fetch = fetch)
  : Promise<VectorUnsignedBuildResult & { buyerLovelace: bigint }> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  const lineage = await resolveEscrowLineage(provider, koiosUrl, p.escrowRef, fetchImpl);
  if (!lineage.current) throw new Error(`Escrow ${p.escrowRef} has no live UTxO: nothing to reclaim.`);
  const plan = planReclaim(lineage.current.datum, callerPkh, p.nowMs ?? Date.now());
  assertWholeSecondSlots(await ensureSlotConfig(provider as unknown as SlotClockProvider));
  assertCollateral(await lucid.wallet().getUtxos());
  const completed = await lucid.newTx()
    .readFrom([await escrowRefScript(provider)])
    .collectFrom([lineage.current.utxo], plan.redeemerHex)
    .pay.ToAddress(p.changeAddress, { lovelace: plan.buyerLovelace })
    .addSignerKey(callerPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE)
    .complete({ localUPLCEval: false });
  return { ...toBuildResult(completed), buyerLovelace: plan.buyerLovelace };
}
