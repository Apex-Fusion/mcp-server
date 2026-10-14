// packages/builder/src/vector/marketplace-verify.ts
// The check of a receipt a supplier returned: verifyReceipt (pure: the five checks and the extra row, run on what it is given) and
// verifyJob (reads the escrow, the supplier's key and the Submitted output on chain, then runs verifyReceipt on what it found). It sends
// nothing but one GET for the supplier's key, through safeFetch, and everything else it reads is public. Nothing here builds, signs or
// submits a transaction. marketplace-transport.ts re-exports it, so callers import the transport and the check from one module.
import { CML } from '@lucid-evolution/lucid';
import type { Provider } from '@lucid-evolution/lucid';
import { safeFetch } from './safe-fetch.js';
import { fetchEscrows } from './marketplace-indexer.js';
import { canonicalize, formatOutRef, sha256Utf8Hex } from './marketplace-datum.js';
import type { EscrowDatum } from './marketplace-datum.js';
import { resolveEscrowLineage, readEscrowOutput, readSubmittedOutput, submittedRefsOf } from './marketplace-lineage.js';
import type { EscrowLineage } from './marketplace-lineage.js';
import { cell } from './marketplace-shared.js';
import { readTargetAdvert, callFailure, trim, jsonObject, canonicalRef, notThePostOutput } from './marketplace-supplier.js';

// ─── Verifying a receipt ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A receipt is the supplier's own account of a job. Five questions make it more than that, and none of them takes the supplier at its
// word. The template's own buyer (vector-agent-template c4c378a, try-it/src/verify-receipt.ts, the strict one) asks the same; the
// SDK's shape-only check is not used.
//   (1) escrow_ref_matches      receipt.escrow_ref equals the escrow ref: the receipt is for this escrow and not another job's.
//   (2) response_hash_matches   with the report text given, sha256(result) equals receipt.response_hash. Without it the check is skipped.
//   (3) supplier_key_matches    the supplier's public key hashes to receipt.supplier_pkh AND to the supplier_pkh of the escrow's datum,
//                               the key hash the buyer paid against. A dishonest endpoint can serve a matching receipt, report text and
//                               key; it cannot serve the key hash that is in the buyer's escrow.
//   (4) signature_valid         Ed25519 over canonicalize(receipt) verifies under that key.
//   (5) on_chain_hash_matches   the result_receipt_hash in the escrow's Submitted output equals sha256(canonicalize({receipt, signature})):
//                               the bytes verified here are the bytes the supplier committed on chain in its Submit. The output is
//                               found live, or, once it is spent, through the marketplace indexer (submittedReceiptHash).
//   extra: prompt_hash_matches  receipt.prompt_hash equals the prompt_hash of the escrow's datum: the receipt is for the request the
//                               buyer committed to and not for another. It is not one of the design's five and it counts all the same:
//                               a receipt for another request is not a good one.
// "verified" is said only when every row passes. A check that was not run is `skipped` and a verdict with one is `incomplete`, never
// "verified".

/** `skipped` is a check that was not run, with the reason in its note; `fail` is a check that ran and did not pass, or could not. */
export type CheckState = 'pass' | 'fail' | 'skipped';
/** The outcome of one check. `note` says why when it did not pass, and is '' when it did. */
export interface Check { state: CheckState; note: string }
export interface ReceiptChecks {
  escrow_ref_matches: Check; response_hash_matches: Check; supplier_key_matches: Check; signature_valid: Check; on_chain_hash_matches: Check;
  /** The extra row: not one of the design's five. */
  prompt_hash_matches: Check;
}
export type Verdict = 'verified' | 'failed' | 'incomplete';
export interface ReceiptVerdict { verdict: Verdict; checks: ReceiptChecks }

export interface VerifyInput {
  /** The receipt as the supplier gave it. Any JSON value: one that is not an object fails the checks that read it. */
  receipt: unknown;
  /** The hex Ed25519 signature the supplier gave with it, as the supplier wrote it (the on-chain hash is over that exact string). */
  signature: string;
  /** The escrow ref the receipt must name, in canonical form (lower case, no padding). */
  escrowRef: string;
  /** The report text the buyer was given, byte for byte, when the buyer has it. */
  result?: string;
  /** The supplier's public key: 32 bytes of hex. */
  supplierPubKeyHex: string;
  /** The supplier_pkh of the escrow's datum. */
  escrowSupplierPkh: string;
  /** The prompt_hash of the escrow's datum. */
  escrowPromptHash: string;
  /** The result_receipt_hash of the escrow's Submitted output, or null when there is none to compare. */
  resultReceiptHashOnChain: string | null;
  /** Why there is none, when `resultReceiptHashOnChain` is null. */
  onChainNote?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;
const passed = (): Check => ({ state: 'pass', note: '' });
const failed = (note: string): Check => ({ state: 'fail', note });
const skipped = (note: string): Check => ({ state: 'skipped', note });
const NOT_AN_OBJECT = 'the receipt is not a JSON object';

/** Runs the checks on what it is given. Pure: nothing is read, and nothing throws, whatever the receipt and the signature are. */
export function verifyReceipt(i: VerifyInput): ReceiptVerdict {
  const receipt = i.receipt !== null && typeof i.receipt === 'object' && !Array.isArray(i.receipt) ? (i.receipt as Record<string, unknown>) : null;
  const signature = typeof i.signature === 'string' ? i.signature : null;

  // (1)
  const escrowRef = receipt === null ? failed(NOT_AN_OBJECT) : receipt.escrow_ref === i.escrowRef ? passed() : failed('the receipt names another escrow');

  // (2) the report text is hashed as UTF-8 exactly as given: no normalisation, as the supplier hashes the bytes it returns
  let responseHash: Check;
  if (i.result === undefined) responseHash = skipped('no report text given');
  else if (receipt === null) responseHash = failed(NOT_AN_OBJECT);
  else if (typeof receipt.response_hash !== 'string' || !HEX64.test(receipt.response_hash)) responseHash = failed('the receipt has no response_hash');
  else responseHash = receipt.response_hash.toLowerCase() === sha256Utf8Hex(i.result) ? passed() : failed("the hash of the text given is not the receipt's response_hash; pass the result exactly as vector_marketplace_get_job returned it");

  // (3) and (4) need a key that can be parsed
  let pub: CML.PublicKey | null = null;
  if (typeof i.supplierPubKeyHex === 'string' && HEX64.test(i.supplierPubKeyHex)) {
    try { pub = CML.PublicKey.from_bytes(Buffer.from(i.supplierPubKeyHex, 'hex')); } catch { /* not a key: refused below */ }
  }
  let supplierKey: Check;
  if (receipt === null) supplierKey = failed(NOT_AN_OBJECT);
  else if (pub === null) supplierKey = failed('the supplier public key is not 32 bytes of hex');
  else {
    const keyHash = pub.hash().to_hex();
    const isReceiptsSupplier = typeof receipt.supplier_pkh === 'string' && receipt.supplier_pkh.toLowerCase() === keyHash;
    const isEscrowsSupplier = typeof i.escrowSupplierPkh === 'string' && i.escrowSupplierPkh.toLowerCase() === keyHash;
    supplierKey = isReceiptsSupplier && isEscrowsSupplier ? passed()
      : !isReceiptsSupplier && !isEscrowsSupplier ? failed("the key hashes to neither receipt.supplier_pkh nor the escrow's supplier_pkh")
      : failed(isReceiptsSupplier ? "the key does not hash to the escrow's supplier_pkh" : 'the key does not hash to receipt.supplier_pkh');
  }

  // (4)
  let signatureValid: Check;
  if (receipt === null) signatureValid = failed(NOT_AN_OBJECT);
  else if (signature === null || !HEX128.test(signature)) signatureValid = failed('the signature is not 64 bytes of hex');
  else if (pub === null) signatureValid = failed('there is no usable public key to check it with');
  else {
    let ok = false;
    try { ok = pub.verify(Buffer.from(canonicalize(receipt), 'utf8'), CML.Ed25519Signature.from_hex(signature)); } catch { /* a signature that cannot be read does not verify */ }
    signatureValid = ok ? passed() : failed('the signature does not verify against that key and this receipt');
  }

  // (5)
  let onChainHash: Check;
  if (i.resultReceiptHashOnChain === null) onChainHash = skipped(i.onChainNote ?? 'Submitted output not locatable');
  else if (receipt === null) onChainHash = failed(NOT_AN_OBJECT);
  else if (signature === null) onChainHash = failed('there is no signature to hash');
  else onChainHash = sha256Utf8Hex(canonicalize({ receipt, signature })) === i.resultReceiptHashOnChain.toLowerCase() ? passed() : failed('the hash on chain is not the hash of this signed receipt');

  // extra: the receipt is for the request the escrow committed to
  let promptHash: Check;
  if (receipt === null) promptHash = failed(NOT_AN_OBJECT);
  else if (typeof receipt.prompt_hash === 'string' && typeof i.escrowPromptHash === 'string' && receipt.prompt_hash.toLowerCase() === i.escrowPromptHash.toLowerCase()) promptHash = passed();
  else promptHash = failed("the receipt's prompt_hash is not the escrow's prompt_hash: it was made for another request");

  const checks: ReceiptChecks = {
    escrow_ref_matches: escrowRef, response_hash_matches: responseHash, supplier_key_matches: supplierKey, signature_valid: signatureValid,
    on_chain_hash_matches: onChainHash, prompt_hash_matches: promptHash,
  };
  const states = Object.values(checks).map((c) => c.state);
  const verdict: Verdict = states.includes('fail') ? 'failed' : states.includes('skipped') ? 'incomplete' : 'verified';
  return { verdict, checks };
}

/** What a verification came to, with what it was made of. */
export interface VerifiedJob extends ReceiptVerdict {
  /** The escrow's Post output, in canonical form. */
  escrowRef: string;
  /** The supplier_pkh of the escrow's datum: the key hash the buyer paid against. */
  supplierPkh: string;
  /** Where the key the signature was checked with came from: the caller, or the supplier's own GET /capability. */
  keyFrom: 'argument' | 'capability';
  /** The Submitted output whose result_receipt_hash was compared, or null when none was found. */
  submittedRef: string | null;
  /** Whether Koios reports that output spent, which it is once the escrow is settled; null when none was found. */
  submittedSpent: boolean | null;
  /** How it was found: live on chain (the lineage), through the marketplace indexer, or named by the caller; null when none was. */
  submittedVia: 'lineage' | 'indexer' | 'argument' | null;
}

/** GET /capability answers with the advert and the supplier's key. A few hundred bytes of it matter, and it has no business being large. */
const CAPABILITY_CALL = { maxResponseBytes: 64 * 1024, timeoutMs: 20_000 } as const;

/**
 * The public key of the supplier of an escrow, as the supplier's own GET /capability serves it (`pub_key_hex`), at the endpoint of the
 * advert the escrow names. The endpoint is resolved as a poll resolves it (readTargetAdvert: the advert whatever its state, https, a
 * template-contract capability), and the call is made as every call to a supplier is: through safeFetch, with a 64 KiB cap and a
 * 20 s budget, carrying nothing about the escrow or the job. The key is the supplier's word and nothing more: check (3) holds it to
 * the escrow's supplier_pkh.
 */
async function capabilityKey(posted: EscrowDatum, koiosUrl: string, fetchImpl: typeof fetch, refuse: (why: string) => Error): Promise<string> {
  const advert = await readTargetAdvert(posted, koiosUrl, fetchImpl, { refuse, forSend: false });
  const unreadable = (why: string) => refuse(`the supplier's public key could not be read (${why}); pass supplier_pub_key_hex.`);
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(`${trim(advert.endpoint_url)}/capability`, { headers: { accept: 'application/json' } }, { ...CAPABILITY_CALL, fetchImpl });
  } catch (err) {
    throw unreadable(callFailure(err, CAPABILITY_CALL));
  }
  if (res.status !== 200) throw unreadable(`the supplier answered ${res.status}`);
  const key = jsonObject(res.text)?.pub_key_hex;
  if (typeof key !== 'string' || !HEX64.test(key)) throw unreadable('its /capability answer has no usable pub_key_hex');
  return key;
}

/** The Submitted output of an escrow, with the hash it carries, how it was found and whether Koios reports it spent. */
type SubmittedFound = { hash: string; ref: string; spent: boolean; via: 'lineage' | 'indexer' | 'argument' };
const NOT_LOCATABLE = 'Submitted output not locatable: ';
/** A failure as one bounded escaped line (these messages already carry no endpoint and no response body). */
const flat = (err: unknown): string => cell(err instanceof Error ? err.message : String(err), 400);
/** What a failed call to the marketplace indexer may tell a caller: its own words for a status or a body that is no list, a fixed phrase for anything else. */
const indexerFailure = (err: unknown): string => (err instanceof Error && /^list escrows: /.test(err.message) ? err.message : 'the request failed (network error or timeout)');

/**
 * The Submitted output of an escrow and the receipt hash it carries, or why there is none to compare. Three ways to it, and the hash
 * is always the one in the datum bytes that Koios utxo_info returns for the ref (which it does for a spent output too: Koios keeps the
 * datum after the Accept or the Release, so nothing here needs the output unspent).
 *  1. The caller names it (`given`): no lookup, and the same checks as for any other (readSubmittedOutput).
 *  2. It is live: resolveEscrowLineage finds it, as it finds every live output of the escrow (credential-checked, the spend chain
 *     from the Post output, the node's agreement); it is then read again by its ref, so that an Accept landing in between does not
 *     take the hash away, and must agree with what the lineage found.
 *  3. The escrow has no live output (it is settled, or the lineage could not tell): the marketplace indexer is asked for the buyer's
 *     escrows and the rows in state Submitted that agree with the Post datum are the candidates (submittedRefsOf). The indexer only
 *     locates: exactly one candidate is needed, and it is then read from Koios and proven by readSubmittedOutput like a named one.
 *     The buyer's list is read to ESCROWS_MAX_BYTES and no further; a buyer with a longer one, like an indexer that cannot be reached,
 *     stops this check, and the caller can still name the output.
 * A live output that is not yet Submitted has no receipt hash and is said to be what it is. Whatever stops the lookup stops this one
 * check and nothing else.
 */
async function submittedReceiptHash(
  provider: Provider, koiosUrl: string, post: { ref: string; datum: EscrowDatum; lovelace: bigint }, given: string | null, fetchImpl: typeof fetch,
): Promise<SubmittedFound | { why: string }> {
  const why = (text: string) => ({ why: text });
  if (given !== null) {
    try {
      const out = await readSubmittedOutput(koiosUrl, post, given, fetchImpl);
      return { hash: out.receiptHash, ref: out.ref, spent: out.spent, via: 'argument' };
    } catch (err) { return why(`${NOT_LOCATABLE}the one you gave was refused: ${flat(err)}`); }
  }

  let live: EscrowLineage['current'] = null;
  let lineageFailure: string | null = null;
  try { live = (await resolveEscrowLineage(provider, koiosUrl, post.ref, fetchImpl)).current; } catch (err) { lineageFailure = flat(err); }
  if (live !== null) {
    if (live.datum.state !== 'Submitted') return why(`the escrow is ${live.datum.state}: the supplier has not put a receipt hash on chain`);
    const ref = formatOutRef(live.utxo.txHash, live.utxo.outputIndex);
    let output: Awaited<ReturnType<typeof readEscrowOutput>>;
    try { output = await readEscrowOutput(koiosUrl, ref, fetchImpl); } catch (err) { return why(`the Submitted output ${ref} could not be read by its ref: ${flat(err)}`); }
    const hash = output.datum.result_receipt_hash;
    if (output.datum.state !== 'Submitted' || hash === null || hash !== live.datum.result_receipt_hash) return why(`Koios describes the Submitted output ${ref} differently when it is read by its ref; its receipt hash is not used`);
    return { hash, ref, spent: output.spent, via: 'lineage' };
  }

  const lead = lineageFailure === null ? 'the escrow has no live output' : `the escrow's live output could not be resolved (${lineageFailure})`;
  let rows: unknown[];
  try { rows = await fetchEscrows(post.datum.buyer_pkh, { fetchImpl }); } catch (err) { return why(`${NOT_LOCATABLE}${lead}, and the indexer could not be asked (${indexerFailure(err)})`); }
  const refs = submittedRefsOf(rows, post.datum);
  if (refs.length === 0) return why(`${NOT_LOCATABLE}${lead}, and the indexer lists no Submitted output of it`);
  if (refs.length > 1) return why(`${NOT_LOCATABLE}the indexer lists ${refs.length} Submitted outputs that match this escrow; pass submitted_ref to name the one`);
  try {
    const out = await readSubmittedOutput(koiosUrl, post, refs[0], fetchImpl);
    return { hash: out.receiptHash, ref: out.ref, spent: out.spent, via: 'indexer' };
  } catch (err) { return why(`${NOT_LOCATABLE}the indexer lists ${refs[0]}, which was refused: ${flat(err)}`); }
}

/**
 * Checks a receipt against the escrow it is for: reads the escrow's Post output (the supplier the buyer paid, the request it committed
 * to), the supplier's key (`supplierPubKeyHex` when the caller gives one, else the supplier's own GET /capability) and the receipt hash
 * of the escrow's Submitted output (live, settled, or named by `submittedRef`: see submittedReceiptHash), and runs verifyReceipt. It
 * needs no buyer: it sends nothing but one GET for the key, and everything it reads is public. `signature` is the supplier's string
 * exactly as it gave it. An escrow that cannot be read, a ref that names a later output, a `submittedRef` that is no ref, and a key
 * that cannot be read are errors that name the escrow and say nothing of the supplier's host or its answer.
 */
export async function verifyJob(
  provider: Provider, koiosUrl: string,
  p: { escrowRef: string; receipt: unknown; signature: string; result?: string; supplierPubKeyHex?: string; submittedRef?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedJob> {
  const canonical = canonicalRef(p.escrowRef);
  const given = p.submittedRef === undefined ? null : canonicalRef(p.submittedRef);
  const refuse = (why: string) => new Error(`Cannot verify a receipt for escrow ${canonical}: ${why}`);
  const { datum: posted, lovelace } = await readEscrowOutput(koiosUrl, canonical, fetchImpl);
  const notPost = notThePostOutput(posted);
  if (notPost !== null) throw refuse(notPost);
  const keyFrom = p.supplierPubKeyHex === undefined ? 'capability' : 'argument';
  const supplierPubKeyHex = p.supplierPubKeyHex ?? await capabilityKey(posted, koiosUrl, fetchImpl, refuse);
  const onChain = await submittedReceiptHash(provider, koiosUrl, { ref: canonical, datum: posted, lovelace }, given, fetchImpl);
  const found = 'hash' in onChain ? onChain : null;
  const checked = verifyReceipt({
    receipt: p.receipt, signature: p.signature, escrowRef: canonical, result: p.result, supplierPubKeyHex,
    escrowSupplierPkh: posted.supplier_pkh, escrowPromptHash: posted.prompt_hash,
    resultReceiptHashOnChain: found?.hash ?? null, onChainNote: 'why' in onChain ? onChain.why : undefined,
  });
  return { ...checked, escrowRef: canonical, supplierPkh: posted.supplier_pkh, keyFrom, submittedRef: found?.ref ?? null, submittedSpent: found?.spent ?? null, submittedVia: found?.via ?? null };
}
