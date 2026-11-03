// packages/builder/src/vector/marketplace-advert.ts
// Keyless building of the legacy-layout advert (the 13-field advert of the marketplace before the identity registry): the Post that
// lists a supplier (refused from the escrow switch on, ESCROW_SWITCH_SLOT) and the Retire that takes a legacy listing down and returns
// its deposit (vector_build_marketplace_advert_retire uses it for a legacy advert, before and after the switch, so that suppliers retire
// their legacy adverts during the drain).
// Each builder returns UNSIGNED CBOR; the supplier signs on its local signer. The plan functions are pure: they decide what a
// transaction must say, so the same numbers can be shown before signing and unit-tested without a chain.
//
// The transactions are the ones the supplier template builds (Apex-Fusion/vector-agent-template c4c378a, packages/shared/src/tx/advert/
// postAdvert.ts and retireAdvert.ts, live path in tx/internal/liveCbor.ts): the same datum bytes (encodeAdvertDatum), the same deposit
// rule, validity window, minimum fee, redeemer and reference script. What the advert validator checks (advert.ak) is only the Retire:
// signed by the datum's supplier key, and an output to that key. A Post runs no script, so the checks of planPostAdvert (the terms rules
// of both layouts, checkAdvertTerms) are what stands between a typing slip and a listing nobody can hire; an advert it accepts is one
// vector_build_marketplace_post_escrow would hire.
import { Data, Constr, CML, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { ensureSlotConfig, paymentKeyHashOf } from './gov-build.js';
import type { SlotClockProvider } from './gov-build.js';
import {
  ADVERT_ADDRESS, ADVERT_REF_UTXO, ADVERT_SCRIPT_HASH, ADVERT_REDEEMER, ADVERT_DEPOSIT_FLOOR_LOVELACE, ADVERT_VALID_BEFORE_MS,
  ADVERT_VALID_AFTER_MS, MARKETPLACE_MIN_FEE,
} from './marketplace-constants.js';
import { encodeAdvertDatum, formatOutRef, parseOutRef } from './marketplace-datum.js';
import type { AdvertDatum } from './marketplace-datum.js';
import { readAdvert } from './marketplace-indexer.js';
import { nodeFailure } from './marketplace-lineage.js';
import { reserveCollateralInputs, assertCollateral, assertWalletIs, assertBeforeEscrowSwitch, LEGACY_ADVERT_REFUSAL } from './marketplace-build.js';
import { checkAdvertTerms, detailHashFor } from './marketplace-advert-build.js';
import type { AdvertTerms, DetailHashSource } from './marketplace-advert-build.js';
import { signedByResult, SignerList } from './identity-chain.js';
import type { SignedByBuild } from './identity-chain.js';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** `new Error(message, { cause })`: Node has had the option since v16.9, but the type library this package compiles against (ES2020) does not declare it. */
const ErrorWithCause = Error as new (message?: string, options?: { cause?: unknown }) => Error;
const KEY_HASH_HEX = /^[0-9a-f]{56}$/;

// ─── Post (legacy layout, refused from the escrow switch on) ────────────────

export interface PostAdvertPlan {
  datum: AdvertDatum; datumHex: string;
  /** What the Post asks to lock: the supplier bond raised to the template's floor. Lucid raises the output further to the ledger minimum for the datum. */
  depositLovelace: bigint;
  /** The host buyers' jobs will be sent to (userinfo dropped, port kept, IDN in punycode). */
  endpointHost: string;
  /** POSIX ms: the Post is valid from 60 s before advertised_at to 5 min after it. */
  validFrom: number; validTo: number;
}

/**
 * Pure. The advert datum a Post would write and what the supplier is shown. Throws a readable Error for terms it must not post
 * (checkAdvertTerms, the rules of both layouts). `supplierPkh` is the key that signs: the advert names it as its supplier, and only it
 * can retire the advert.
 */
export function planPostAdvert(terms: AdvertTerms, supplierPkh: string, nowMs: number): PostAdvertPlan {
  if (!KEY_HASH_HEX.test(supplierPkh)) throw new Error('The supplier key hash must be 56 lower-case hex characters.');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  const t = checkAdvertTerms(terms, 'legacy');
  const datum: AdvertDatum = {
    supplier_pkh: supplierPkh, capability_id: t.capabilityId, model: t.model,
    max_output_tokens: t.maxOutputTokens, max_processing_ms: t.maxProcessingMs,
    price_lovelace: t.priceLovelace, supplier_bond_lovelace: t.supplierBondLovelace, buyer_bond_lovelace: t.buyerBondLovelace,
    endpoint_url: t.endpointUrl, detail_uri: t.detailUri, detail_hash: t.detailHash,
    advertised_at: nowMs, status: 'Active',
  };
  const deposit = datum.supplier_bond_lovelace > ADVERT_DEPOSIT_FLOOR_LOVELACE ? datum.supplier_bond_lovelace : ADVERT_DEPOSIT_FLOOR_LOVELACE;
  return {
    datum, datumHex: encodeAdvertDatum(datum), depositLovelace: deposit, endpointHost: new URL(t.endpointUrl).host,
    validFrom: nowMs - ADVERT_VALID_BEFORE_MS, validTo: nowMs + ADVERT_VALID_AFTER_MS,
  };
}

/**
 * advert_ref is `<txHash>#0`, so the advert must really be output 0: the advert address, the planned inline datum, and at least the
 * planned deposit (Lucid may raise it to the ledger minimum). Returns the lovelace output 0 locks.
 */
export function advertOutputZero(txCbor: string, expected: { datumHex: string; depositLovelace: bigint }): bigint {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  const first = outputs.len() > 0 ? outputs.get(0) : undefined;
  const coin = first ? BigInt(first.amount().coin().toString()) : -1n;
  const ok = first !== undefined
    && first.address().to_bech32() === ADVERT_ADDRESS
    && coin >= expected.depositLovelace
    && first.datum()?.as_datum()?.to_cbor_hex().toLowerCase() === expected.datumHex.toLowerCase();
  if (!ok) throw new Error('The built transaction does not have the planned advert as output 0 (address, inline datum and deposit), so advert_ref would point at the wrong output; not returning it.');
  return coin;
}

export type PostAdvertBuild = VectorUnsignedBuildResult & {
  advertRef: string; datum: AdvertDatum; endpointHost: string;
  /** The lovelace output 0 locks: the deposit as planned, or the ledger minimum for the datum when that is higher. */
  depositLovelace: bigint;
  validTo: number;
  detailHashSource: DetailHashSource;
  /** As buildPostEscrow's: whether the wallet's smallest pure output of at least 5 units was kept out of the inputs, for the collateral a supplier needs to Claim, Submit and Retire. */
  collateralKept: boolean;
};

/**
 * Builds the unsigned Post of a legacy-layout advert at output 0 of a new transaction, naming the key of `changeAddress` as its
 * supplier. Refused (LEGACY_ADVERT_REFUSAL) once the node's tip has reached the escrow switch: from then on new adverts use the identity
 * layout. Nothing is signed or submitted, and nothing is fetched (detailHashFor: a detail URI needs the caller's detail_hash). The
 * wallet must be the one bound to changeAddress. The Post leaves the wallet's smallest pure 5-unit output alone when it can.
 */
export async function buildPostAdvert(
  lucid: LucidEvolution, provider: Provider,
  p: { changeAddress: string; terms: Omit<AdvertTerms, 'detailHash'> & { detailHash?: string }; nowMs?: number },
): Promise<PostAdvertBuild> {
  await assertBeforeEscrowSwitch(provider, LEGACY_ADVERT_REFUSAL);
  const supplierPkh = paymentKeyHashOf(p.changeAddress);
  const nowMs = p.nowMs ?? Date.now();
  const { detailHash, source: detailHashSource } = detailHashFor(p.terms.detailUri, p.terms.detailHash);
  const plan = planPostAdvert({ ...p.terms, detailHash }, supplierPkh, nowMs);

  await ensureSlotConfig(provider as unknown as SlotClockProvider);
  await assertWalletIs(lucid, p.changeAddress);
  // A fresh builder per attempt: one that failed in complete() is not reused.
  const assemble = () => lucid.newTx()
    .pay.ToAddressWithData(ADVERT_ADDRESS, { kind: 'inline', value: plan.datumHex }, { lovelace: plan.depositLovelace })
    .addSignerKey(supplierPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE);
  // A supplier needs a pure output of at least 5 units as collateral for every script it runs (Claim, Submit, Retire), so the Post is
  // first assembled without the smallest such output, then, if that cannot complete, from the whole wallet (collateralKept says which).
  const inputs = reserveCollateralInputs(await lucid.wallet().getUtxos(), plan.depositLovelace);
  let completed: TxSignBuilder | undefined;
  let reservedFailure: unknown;
  if (inputs) {
    try { completed = await assemble().complete({ presetWalletInputs: inputs }); } catch (err) { reservedFailure = err; /* retried below with the whole wallet */ }
  }
  const collateralKept = completed !== undefined;
  if (!completed) {
    try { completed = await assemble().complete({}); } catch (err) {
      throw inputs ? new ErrorWithCause(errorText(err), { cause: reservedFailure }) : err;
    }
  }
  const r = toBuildResult(completed);
  const depositLovelace = advertOutputZero(r.txCbor, plan);
  return {
    ...r, advertRef: formatOutRef(r.txHash, 0), datum: plan.datum, endpointHost: plan.endpointHost,
    depositLovelace, validTo: plan.validTo, detailHashSource, collateralKept,
  };
}

// ─── Retire ─────────────────────────────────────────────────────────────────

/**
 * Pure. What a Retire must say: only the advert's supplier key can retire it (the validator requires its signature and an output to it),
 * and the deposit the advert locks returns to that key.
 */
export function planRetireAdvert(advert: AdvertDatum, callerPkh: string, advertLovelace: bigint, nowMs: number) {
  if (advert.supplier_pkh !== callerPkh) throw new Error(`This advert names supplier key ${advert.supplier_pkh}, not the key of changeAddress; only its supplier can retire it.`);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  return {
    supplierPkh: advert.supplier_pkh, returnLovelace: advertLovelace,
    redeemerHex: Data.to(new Constr(ADVERT_REDEEMER.RetireAdvert, [])),
    validFrom: nowMs - ADVERT_VALID_BEFORE_MS, validTo: nowMs + ADVERT_VALID_AFTER_MS,
  };
}

/** The advert validator, read from its live reference-script UTxO (the template's ADVERT_REF_UTXO), and checked to be that validator. */
async function advertRefScript(provider: Provider): Promise<UTxO> {
  const at = formatOutRef(ADVERT_REF_UTXO.txHash, ADVERT_REF_UTXO.outputIndex);
  let utxos: UTxO[];
  try { utxos = await provider.getUtxosByOutRef([ADVERT_REF_UTXO]); } catch (err) { throw new Error(`Could not read the advert reference script ${at} from the node: ${nodeFailure(err)}`); }
  const script = utxos[0]?.scriptRef;
  if (!script) throw new Error(`Advert reference script ${at} not found; the marketplace needs to publish it again.`);
  if (validatorToScriptHash(script) !== ADVERT_SCRIPT_HASH) throw new Error(`The script at ${at} is not the advert validator; nothing was built.`);
  return utxos[0];
}

/** A legacy Retire: the window and the one key that signs (the supplier's, which is also the wallet's), and the advert it ends. */
export type RetireAdvertBuild = SignedByBuild & { advertRef: string; advert: AdvertDatum; supplierPkh: string; capabilityId: string; returnLovelace: bigint };

/**
 * Builds the unsigned Retire of a legacy-layout advert: consumes the advert output with the RetireAdvert redeemer and returns its
 * deposit to changeAddress, whose key must be the advert's supplier. The advert is read through readAdvert (at the advert address, with
 * an advert datum, unspent) and the node's copy of it is the one consumed. The wallet must be the one bound to changeAddress and hold a
 * pure output of at least 5 units as collateral; the node evaluates the validator (`localUPLCEval: false`). `fetchImpl` is for tests.
 */
export async function buildRetireAdvert(
  lucid: LucidEvolution, provider: Provider, p: { changeAddress: string; advertRef: string; nowMs?: number }, fetchImpl: typeof fetch = fetch,
): Promise<RetireAdvertBuild> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  let read: Awaited<ReturnType<typeof readAdvert>>;
  try { read = await readAdvert(p.advertRef, fetchImpl); } catch (err) { throw new Error(`Could not read advert ${p.advertRef.trim()}: ${errorText(err)}`); }
  if ('error' in read) throw new Error(read.error);
  const { utxo, advert } = read;
  const advertRef = formatOutRef(utxo.tx_hash.toLowerCase(), utxo.tx_index);
  if (read.spent) throw new Error(`Advert ${advertRef} has already been consumed (retired or replaced); there is nothing to retire.`);
  if (utxo.is_spent !== false) throw new Error(`Koios did not report whether advert ${advertRef} is unspent; retry.`);
  let nodeCopy: UTxO | undefined;
  try { [nodeCopy] = await provider.getUtxosByOutRef([parseOutRef(advertRef)]); } catch (err) { throw new Error(`Could not read advert ${advertRef} from the node: ${nodeFailure(err)}`); }
  if (!nodeCopy) throw new Error(`The node does not list advert ${advertRef} as unspent (consumed, or not seen yet); retry or check the explorer.`);
  if (nodeCopy.address !== ADVERT_ADDRESS || (nodeCopy.datum ?? '').toLowerCase() !== (utxo.inline_datum?.bytes ?? '').toLowerCase()) {
    throw new Error(`The node and Koios disagree about advert ${advertRef}; retry.`);
  }
  const nowMs = p.nowMs ?? Date.now();
  let plan: ReturnType<typeof planRetireAdvert>;
  try { plan = planRetireAdvert(advert, callerPkh, nodeCopy.assets.lovelace, nowMs); } catch (err) { throw new Error(`${errorText(err)} (advert ${advertRef})`); }

  await ensureSlotConfig(provider as unknown as SlotClockProvider);
  await assertWalletIs(lucid, p.changeAddress);
  assertCollateral(await lucid.wallet().getUtxos());
  const completed = await lucid.newTx()
    .readFrom([await advertRefScript(provider)])
    .collectFrom([nodeCopy], plan.redeemerHex)
    .pay.ToAddress(p.changeAddress, { lovelace: plan.returnLovelace })
    .addSignerKey(callerPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE)
    .complete({ localUPLCEval: false });
  const signers = new SignerList().add(callerPkh, 'supplier key (the advert names it; the advert validator needs its signature)');
  return {
    ...signedByResult(completed, { lo: plan.validFrom, hi: plan.validTo }, signers, callerPkh),
    advertRef, advert, supplierPkh: plan.supplierPkh, capabilityId: advert.capability_id, returnLovelace: plan.returnLovelace,
  };
}
