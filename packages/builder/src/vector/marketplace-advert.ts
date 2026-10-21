// packages/builder/src/vector/marketplace-advert.ts
// Keyless building of the supplier side of an advert: the Post that lists a supplier on the marketplace and the Retire that takes the
// listing down and returns its deposit. Each builder returns UNSIGNED CBOR through toBuildResult; the supplier signs on its local signer.
// The plan functions are pure: they decide what a transaction must say, so the same numbers can be shown before signing and unit-tested
// without a chain.
//
// The transactions are the ones the supplier template builds (Apex-Fusion/vector-agent-template c4c378a, packages/shared/src/tx/advert/
// postAdvert.ts and retireAdvert.ts, live path in tx/internal/liveCbor.ts): the same datum bytes (encodeAdvertDatum), the same deposit
// rule, validity window, minimum fee, redeemer and reference script. What the advert validator checks (advert.ak) is only the Retire:
// signed by the datum's supplier key, and an output to that key. A Post runs no script, so the checks of planPostAdvert are what stands
// between a typing slip and a listing nobody can hire; an advert it accepts is one vector_build_marketplace_post_escrow would hire.
import { Data, Constr, CML, fromText, toText, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { isIP } from 'node:net';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { ensureSlotConfig, paymentKeyHashOf } from './gov-build.js';
import type { SlotClockProvider } from './gov-build.js';
import {
  ADVERT_ADDRESS, ADVERT_REF_UTXO, ADVERT_SCRIPT_HASH, ADVERT_REDEEMER, ADVERT_DEPOSIT_FLOOR_LOVELACE, ADVERT_VALID_BEFORE_MS,
  ADVERT_VALID_AFTER_MS, DATUM_BYTES_MAX, EMPTY_DETAIL_HASH, MARKETPLACE_MIN_FEE, MAX_PROCESSING_MS_CEILING, MIN_PROCESSING_MS_FLOOR,
} from './marketplace-constants.js';
import { encodeAdvertDatum, formatOutRef, parseOutRef } from './marketplace-datum.js';
import type { AdvertDatum } from './marketplace-datum.js';
import { readAdvert } from './marketplace-indexer.js';
import { nodeFailure } from './marketplace-lineage.js';
import { reserveCollateralInputs, assertCollateral, assertWalletIs } from './marketplace-build.js';
import { isFleetCapability } from './marketplace-transport.js';
import { isPrivateAddress } from './safe-fetch.js';
import { cell } from './marketplace-shared.js';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** `new Error(message, { cause })`: Node has had the option since v16.9, but the type library this package compiles against (ES2020) does not declare it. */
const ErrorWithCause = Error as new (message?: string, options?: { cause?: unknown }) => Error;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const HASH_HEX = /^[0-9a-fA-F]{64}$/;
const KEY_HASH_HEX = /^[0-9a-f]{56}$/;

// ─── Post ───────────────────────────────────────────────────────────────────

/** The terms a supplier advertises, in the advert's own units (lovelace, milliseconds, tokens). */
export interface AdvertTerms {
  capabilityId: string; model: string;
  maxOutputTokens: number; maxProcessingMs: number;
  priceLovelace: bigint; supplierBondLovelace: bigint; buyerBondLovelace: bigint;
  endpointUrl: string;
  /** '' when the advert names no manifest. */
  detailUri: string;
  /** sha256 of the bytes detailUri serves, 64 hex; sha256 of no bytes when detailUri is ''. */
  detailHash: string;
}

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
 * A text field of an advert: what the marketplace's encoder writes is its UTF-8 bytes as one bytestring, so it must be text that
 * survives that round trip (an unpaired surrogate or a leading byte-order mark does not) and fit the 64 bytes a datum bytestring holds.
 * No control characters: every tool shows these fields on one line.
 */
function textField(name: string, value: unknown, required: boolean): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  if (required && value.length === 0) throw new Error(`${name} must not be empty.`);
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) throw new Error(`${name} must not contain control characters or line breaks.`);
  const hex = fromText(value);
  if (toText(hex) !== value) throw new Error(`${name} is not text that UTF-8 carries unchanged (an unpaired surrogate, or a leading byte-order mark).`);
  const bytes = hex.length / 2;
  if (bytes > DATUM_BYTES_MAX) throw new Error(`${name} is ${bytes} bytes as UTF-8; an advert field holds at most ${DATUM_BYTES_MAX} (the marketplace writes each field as one bytestring, and the ledger refuses a longer one in a datum).`);
  return value;
}

/**
 * A URL the marketplace tools will call (safeFetch's rules, checked without a network): https (whose URLs always have a host), no credentials, and not an IP
 * literal in a private or reserved range. A name that resolves to such a range is refused when a buyer's call is made; it cannot be
 * known here without a lookup.
 */
function callableUrl(name: string, value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`${name} is not a URL.`); }
  if (u.protocol !== 'https:') throw new Error(`${name} must be an https URL: the marketplace tools call https only.`);
  if (u.username || u.password) throw new Error(`${name} must not carry credentials.`);
  const literal = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  if (isIP(literal) && isPrivateAddress(literal)) throw new Error(`${name} points at a private or reserved address; buyers' calls to it would be refused.`);
  return u.host;
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
 * Pure. The advert datum a Post would write and what the supplier is shown. Throws a readable Error for terms it must not post: the
 * advert would be refused by the ledger (a field over 64 bytes), or could never be hired through vector_build_marketplace_post_escrow
 * (a processing window over 24 h, an endpoint that is not https, a fleet capability id, numbers the escrow datum cannot hold).
 * `supplierPkh` is the key that signs: the advert names it as its supplier, and only it can retire the advert.
 */
export function planPostAdvert(terms: AdvertTerms, supplierPkh: string, nowMs: number): PostAdvertPlan {
  if (!KEY_HASH_HEX.test(supplierPkh)) throw new Error('The supplier key hash must be 56 lower-case hex characters.');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  const capabilityId = textField('capability_id', terms.capabilityId, true);
  // vector_build_marketplace_post_escrow refuses fleet capabilities: their suppliers check another hash of the request than the one a
  // Post commits, so vector_marketplace_send_job could never deliver the job. An advert in those namespaces could not be hired here.
  if (isFleetCapability(capabilityId)) throw new Error(`capability_id ${cell(capabilityId)} is in a fleet namespace (llm.text.generate.*, llm.chat.*, ocr.page.extract.* or audio.synthesize.*), which these tools do not hire; name the capability outside those namespaces (for example research.summary.v1).`);
  const model = textField('model', terms.model, true);
  const endpointUrl = textField('endpoint_url', terms.endpointUrl, true);
  // A job goes to `<endpoint_url>/v1/job` (the template route appends the path to the text, trimming only trailing slashes), so anything
  // that keeps the result from being that path is refused: whitespace (the URL parser drops a trailing space, the route does not), a query
  // or a fragment (the path would land inside it).
  if (/\s/.test(endpointUrl)) throw new Error('endpoint_url must not contain whitespace: jobs are sent to <endpoint_url>/v1/job, and whitespace breaks that URL.');
  if (endpointUrl.includes('?')) throw new Error('endpoint_url must not contain a query (?): jobs are sent to <endpoint_url>/v1/job, and the path would land inside the query.');
  if (endpointUrl.includes('#')) throw new Error('endpoint_url must not contain a fragment (#): jobs are sent to <endpoint_url>/v1/job, and the path would land inside the fragment.');
  const endpointHost = callableUrl('endpoint_url', endpointUrl);
  const detailUri = textField('detail_uri', terms.detailUri, false);
  if (detailUri !== '') callableUrl('detail_uri', detailUri);
  if (typeof terms.detailHash !== 'string' || !HASH_HEX.test(terms.detailHash)) throw new Error('detail_hash must be 64 hex characters (the sha256 of the bytes detail_uri serves).');
  const maxOutputTokens = wholeNumber('max_output_tokens', terms.maxOutputTokens, Number.MAX_SAFE_INTEGER);
  // The buyer's Post caps the window at 24 h (a buyer cannot reclaim before deliver_by), so a longer one could not be hired.
  // A supplier template starts only when its ADVERT_MAX_PROCESSING_MS is at least SERVICE_TIMEOUT_MS + 60 s, and it refuses jobs for an
  // advert whose window is smaller than that, so no template supplier serves a window under MIN_PROCESSING_MS_FLOOR.
  const maxProcessingMs = wholeNumber('max_processing_ms', terms.maxProcessingMs, MAX_PROCESSING_MS_CEILING, ' (24 h), the longest window vector_build_marketplace_post_escrow will hold a buyer\'s escrow for; it is milliseconds, check the unit', MIN_PROCESSING_MS_FLOOR, ': a supplier template needs at least its SERVICE_TIMEOUT_MS + 60000 ms (180000 with the default), so it cannot serve a shorter window');
  const datum: AdvertDatum = {
    supplier_pkh: supplierPkh, capability_id: capabilityId, model,
    max_output_tokens: maxOutputTokens, max_processing_ms: maxProcessingMs,
    price_lovelace: lovelace('price_lovelace', terms.priceLovelace),
    supplier_bond_lovelace: lovelace('supplier_bond_lovelace', terms.supplierBondLovelace),
    buyer_bond_lovelace: lovelace('buyer_bond_lovelace', terms.buyerBondLovelace),
    endpoint_url: endpointUrl, detail_uri: detailUri, detail_hash: terms.detailHash.toLowerCase(),
    advertised_at: nowMs, status: 'Active',
  };
  const deposit = datum.supplier_bond_lovelace > ADVERT_DEPOSIT_FLOOR_LOVELACE ? datum.supplier_bond_lovelace : ADVERT_DEPOSIT_FLOOR_LOVELACE;
  return {
    datum, datumHex: encodeAdvertDatum(datum), depositLovelace: deposit, endpointHost,
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

/** Where the advert's detail_hash came from: given by the caller, or the hash of no bytes when there is no detail URI. */
export type DetailHashSource = 'given' | 'empty';

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
 * Builds the unsigned Post of an advert at output 0 of a new transaction, naming the key of `changeAddress` as its supplier. Nothing is
 * signed or submitted, and nothing is fetched: a detail URI needs the caller's detail_hash (the server never fetches a URL a caller
 * gives), and without a detail URI the hash is that of no bytes (the supplier template's default). A detail_hash of '' counts as not
 * given, as in the template. The wallet must be the one bound to changeAddress. The Post leaves the wallet's smallest pure 5-unit output
 * alone when it can.
 */
export async function buildPostAdvert(
  lucid: LucidEvolution, provider: Provider,
  p: { changeAddress: string; terms: Omit<AdvertTerms, 'detailHash'> & { detailHash?: string }; nowMs?: number },
): Promise<PostAdvertBuild> {
  const supplierPkh = paymentKeyHashOf(p.changeAddress);
  const nowMs = p.nowMs ?? Date.now();
  const given = p.terms.detailHash === '' ? undefined : p.terms.detailHash;
  if (given === undefined && p.terms.detailUri !== '') {
    throw new Error('detail_hash is required with a detail_uri: pass the sha256 (64 hex) of the exact bytes detail_uri serves. This server does not fetch it; vector_marketplace_get_supplier checks the hash against the served bytes once the advert is posted.');
  }
  const detailHashSource: DetailHashSource = given === undefined ? 'empty' : 'given';
  const plan = planPostAdvert({ ...p.terms, detailHash: given ?? EMPTY_DETAIL_HASH }, supplierPkh, nowMs);

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

export type RetireAdvertBuild = VectorUnsignedBuildResult & { advertRef: string; supplierPkh: string; capabilityId: string; returnLovelace: bigint };

/**
 * Builds the unsigned Retire of an advert: consumes the advert output with the RetireAdvert redeemer and returns its deposit to
 * changeAddress, whose key must be the advert's supplier. The advert is read through readAdvert (at the advert address, with an advert
 * datum, unspent) and the node's copy of it is the one consumed. The wallet must be the one bound to changeAddress and hold a pure
 * output of at least 5 units as collateral; the node evaluates the validator (`localUPLCEval: false`). `fetchImpl` is for tests.
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
  return { ...toBuildResult(completed), advertRef, supplierPkh: plan.supplierPkh, capabilityId: advert.capability_id, returnLovelace: plan.returnLovelace };
}
