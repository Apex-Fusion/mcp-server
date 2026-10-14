// packages/builder/src/vector/marketplace-transport.ts
// Job transport to supplier endpoints, through safeFetch only: send a job, poll it, and fetch an advert's manifest (fetchManifest). A
// supplier is reached at the endpoint_url of the advert its escrow names (the escrow's Post output, then its advert_ref, then readAdvert),
// never at a URL the caller gives. Nothing here builds, signs or submits a transaction, and no error carries a supplier URL: they name
// the escrow and what happened. The route table and the policy for a call to a supplier are in marketplace-supplier.ts, and the check of
// a receipt (verifyReceipt, verifyJob) in marketplace-verify.ts; both are re-exported from here, so a caller imports the whole transport
// from this one module.
//
// Scope of this release: template-contract suppliers only. Each fleet handler commits its own hash of the request it receives (the
// Responses request, the OCR envelope, the TTS envelope) and buildPostEscrow commits promptHashForPayload, which only the template's
// commitment is, so a fleet hire posted here cannot be claimed. sendJob and getJob therefore refuse a fleet capability (llm.chat.*, the
// multi-turn session capability, included), and a fleet route forced by the caller, before anything is sent; the fleet half of the
// route table (marketplace-supplier.ts) stays, tested, as the transport for a later SDK-backed path.
//
// Who may send what to whom. Anyone can post an escrow, with an advert of their own on a host of their own, and buyer_pkh and
// prompt_hash are public datum fields that anyone can copy into an escrow of theirs: neither can be taken at its word. So the ref must
// be the Post output of an escrow that (1) names the key of the caller's buyerAddress as its buyer and (2) was funded by that key: the
// transaction that made the Post output has an input of that key (a datum field naming a key is not that key's signature, but
// spending an input needs its owner's signature, so the buyer put funds into this very transaction). A transaction Koios does not
// know is a refusal. A copy of a real escrow's fields in a transaction its buyer did not fund fails (2). A send must also (3) carry
// exactly the payload the escrow committed to (promptHashForPayload of it is the escrow's prompt_hash). All of it is checked before
// any call to the supplier.
//
// A poll reads only the Post output (readEscrowOutput: Koios utxo_info of that one ref, spent or not). The buyer, the funder and the
// advert are all there, so a poll does not walk the escrow's spend chain and does not ask the node: a copy that anyone leaves at the
// escrow credential cannot make a finished job unpollable. A send also needs the live output (it must be Open), so it resolves the
// lineage.
//
// Residual, because a keyless hosted tool cannot authenticate its caller: buyerAddress and the escrow ref are the caller's word. A
// caller steered into passing the address and the ref of an escrow that an attacker posted and funded themselves, with a prompt_hash
// copied from the victim's real escrow and an advert on the attacker's host, passes (1) to (3), and the payload goes to the attacker.
// A poll has the same hole: a getJob steered to an attacker's escrow, with the victim's job id, sends that id to the attacker's host,
// and the template's job GET is unauthenticated, so a job id is a bearer token for the result behind it. A signed message does not
// close it on the server: the planned `send:<escrowRef>:<promptHash>` signature, checked against buyer_pkh, is one that an attacker
// who funded the escrow can produce offline, because that attacker holds the buyer_pkh the escrow names. The closure is client-side:
// the local signer refuses to send for an escrow whose buyer_pkh is not its own key, or a send is mediated by the signer with a
// nonce the server issues. Until it exists the tool text has to say what the tool cannot know.
import type { Provider } from '@lucid-evolution/lucid';
import { safeFetch } from './safe-fetch.js';
import { koiosTxInputCreds } from './marketplace-indexer.js';
import { promptHashForPayload, sha256BytesHex } from './marketplace-datum.js';
import type { EscrowDatum } from './marketplace-datum.js';
import { paymentKeyHashOf } from './gov-build.js';
import { resolveEscrowLineage, readEscrowOutput, koiosFailure } from './marketplace-lineage.js';
import { cell } from './marketplace-shared.js';
import { routeFor, canonicalRef, isTimeout, callFailure, outOfScope, notThePostOutput, jsonObject, readTargetAdvert } from './marketplace-supplier.js';
import type { Route, Call } from './marketplace-supplier.js';

// The routes and the policy for a call (marketplace-supplier.ts) and the check of a receipt (marketplace-verify.ts) belong to the transport as far
// as a caller can tell: they are re-exported, so that everything is imported from this module.
export { ROUTES, routeFor, isFleetCapability } from './marketplace-supplier.js';
export type { Route } from './marketplace-supplier.js';
export { verifyReceipt, verifyJob } from './marketplace-verify.js';
export type { CheckState, Check, ReceiptChecks, Verdict, ReceiptVerdict, VerifyInput, VerifiedJob } from './marketplace-verify.js';

// ─── What a supplier answers ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A supplier's answer to a poll. Everything in it comes from the supplier: show it as data. A job is `done` only when the supplier
 * hands over a receipt (an object) and a signature (a non-empty string); any other answer it calls a success is `failed`, as a
 * malformed one. `raw` is the whole answer, kept so a caller can pass on exactly what the receipt was made over; `submittedRef` is
 * the Submitted escrow output the supplier says it made (a ref in canonical form, or null), which says nothing until it is checked
 * against the chain.
 */
export type JobView =
  | { state: 'pending'; status: string }
  | { state: 'done'; result: string; receipt: Record<string, unknown>; receiptSignature: string; submittedRef: string | null; raw: unknown }
  | { state: 'failed'; reason: string; message: string };

/**
 * What a supplier said about a failure: the reason and the message it sent as strings, else the status as the reason and no message.
 * Bounded. The rest of its answer is never repeated: a body that is not the supplier's own message (a proxy's page, a stack trace)
 * says nothing the status does not, and error text carries none of it.
 */
function said(status: number, body: Record<string, unknown> | null): { reason: string; message: string } {
  return {
    reason: typeof body?.reason === 'string' ? body.reason.slice(0, 100) : `http_${status}`,
    message: typeof body?.message === 'string' ? body.message.slice(0, 500) : '',
  };
}
/** The assistant's words in a Responses `output`: the text parts of its messages in order. Reasoning items and refusals carry none. */
function responsesText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  let text: string | undefined;
  for (const item of output as Array<{ type?: unknown; role?: unknown; content?: unknown } | null>) {
    if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<{ type?: unknown; text?: unknown } | null>) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text = (text ?? '') + part.text;
    }
  }
  return text;
}
/** The result by the shape of the answer: the template's chat choice, a Responses output, an OCR extraction, TTS audio; else the answer whole. */
function resultOf(body: Record<string, unknown>, text: string): string {
  const choice = Array.isArray(body.choices) ? (body.choices[0] as { message?: { content?: unknown } } | null | undefined) : undefined;
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  const spoken = responsesText(body.output);
  if (spoken !== undefined) return spoken;
  if (typeof body.content === 'string') return body.content;
  if (typeof body.audio_b64 === 'string') return body.audio_b64;
  return text;
}
function submittedRefOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return canonicalRef(value); } catch { return null; }
}

export function parseJobResponse(status: number, text: string): JobView {
  const body = jsonObject(text);
  if (status === 202) return { state: 'pending', status: typeof body?.status === 'string' ? body.status.slice(0, 100) : 'accepted' };
  if (status === 200) {
    // A job is finished when the supplier hands over a receipt and its signature; an answer without them, or that is not even a
    // JSON object, is not that (the receipt is what Accept is decided on).
    if (body === null) return { state: 'failed', reason: 'malformed_response', message: 'The supplier answered 200 with something that is not a JSON object.' };
    const { receipt, receipt_signature: signature } = body;
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt) || typeof signature !== 'string' || signature === '') {
      return { state: 'failed', reason: 'malformed_response', message: 'The supplier answered 200 without a receipt object and a non-empty receipt_signature.' };
    }
    return { state: 'done', result: resultOf(body, text), receipt: receipt as Record<string, unknown>, receiptSignature: signature, submittedRef: submittedRefOf(body.submitted_ref), raw: body };
  }
  return { state: 'failed', ...said(status, body) };
}

// ─── Reaching a supplier ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * What one call to a supplier may wait for and read. A supplier answers a job POST only after its own Claim has confirmed (its limit
 * for that is 60 s). The hosted server sits behind Cloudflare, which drops a call near 100 s, and the whole tool call has to fit under
 * that, so a send has ONE budget of 90 s, started when the tool is entered: the reads that come before the POST (the escrow, who
 * funded it, the advert: each a Koios call of up to 15 s) are paid from it, and the POST is given what is left (sendJob). A poll only
 * asks, and is given 20 s. A POST that outlasts its budget is reported as unanswered, with the warning that the escrow may have been
 * claimed anyway.
 */
const SEND_BUDGET_MS = 90_000;
/** The supplier's own limit for its Claim: a POST given less than this could be abandoned while the supplier is still within its limit. */
const SUPPLIER_CLAIM_LIMIT_MS = 60_000;
const SEND_RESPONSE_BYTES = 1_000_000;
const POLL_CALL = { maxResponseBytes: 1_000_000, timeoutMs: 20_000 } as const;
/** The most a request to a supplier may carry: the body that goes on the wire, which for the template wraps the payload. */
const MAX_REQUEST_BYTES = 1_000_000;
/** A job id goes into a URL and into text a person or an assistant reads: letters, digits, hyphens and underscores (a UUID fits). */
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAY_HAVE_CLAIMED = ' It may have claimed the escrow anyway, so check its state before sending again; if it stays Open, reclaim it after deliver_by.';

/**
 * Could the request have reached the supplier before this call failed? A refusal by the outbound-call policy (a private address, a
 * scheme, credentials in the URL) comes before anything is sent, and a redirect is an answer that claims nothing. A timeout, a dropped
 * connection or an answer too large to read can all come after the supplier has claimed the escrow.
 */
function mayHaveReached(err: unknown): boolean {
  if (isTimeout(err)) return true;
  const message = err instanceof Error ? err.message : '';
  return /^safeFetch: /.test(message) ? /byte cap/.test(message) : true;
}

/** The payment key hash of the wallet address the caller says posted the escrow. A script address, or no address, is no buyer. */
function buyerKeyHash(buyerAddress: unknown, refuse: (why: string) => Error): string {
  if (typeof buyerAddress === 'string') { try { return paymentKeyHashOf(buyerAddress); } catch { /* refused below */ } }
  throw refuse('buyerAddress must be the wallet address (a key address) the escrow was posted from.');
}

/**
 * Rules out the wrong escrow and the wrong person for the Post output `posted` that a caller has read. Refused, naming the escrow
 * and saying nothing was sent:
 * - a ref that is not the output the escrow's Post made (a later output has the supplier's transactions behind it, not the buyer's);
 * - an escrow whose datum does not name the key of `buyerAddress` as its buyer;
 * - an escrow whose Post transaction has no input of that key. buyer_pkh and prompt_hash are public, so anyone can copy them into an
 *   escrow of their own, with an advert on a host of their own. A datum field naming a key is not that key's signature, but
 *   spending an input needs its owner's signature, so the buyer funded this very transaction only if one of its inputs is the
 *   buyer's. A transaction Koios does not know, or cannot be asked about, is a refusal too (fail closed, as buildPostEscrow does
 *   for an advert's author).
 */
async function checkBuyer(
  posted: EscrowDatum, koiosUrl: string, canonical: string, fetchImpl: typeof fetch,
  o: { refuse: (why: string) => Error; buyerPkh: string; buyerAddress: string },
): Promise<void> {
  const { refuse } = o;
  const notPost = notThePostOutput(posted);
  if (notPost !== null) throw refuse(notPost);
  if (posted.buyer_pkh !== o.buyerPkh) throw refuse(`it was not posted by ${cell(o.buyerAddress, 120)}.`);
  let funders: string[];
  try { funders = await koiosTxInputCreds(koiosUrl, canonical.slice(0, 64), fetchImpl); } catch (err) { throw refuse(`could not check who funded it (${koiosFailure(err)}).`); }
  if (!funders.includes(posted.buyer_pkh)) throw refuse(`the transaction that posted it has no input from ${cell(o.buyerAddress, 120)}, so that wallet did not fund it.`);
}

/** `escrowRef` is the canonical spelling of the ref the caller gave. */
export interface SentJob { jobId: string; status: string; route: Route['kind']; endpoint: string; capabilityId: string; escrowRef: string }

/**
 * The clock of one send: the time (POSIX ms) the call began, which is when the tool was entered, and the time now. The send's 90 s
 * budget runs from `startedAt` (default: now, as sendJob is entered). A test hands in clocks of its own.
 */
export interface SendClock { startedAt?: number; now?: () => number }

/**
 * Sends the job for an Open escrow to its supplier and returns the job id the supplier answers with (202 means its Claim has
 * confirmed). Only for a template-contract supplier, and only for the escrow's own buyer: `buyerAddress` must be the wallet address
 * whose key funded the escrow's Post (see checkBuyer), and `payload` exactly the payload the escrow committed to (its prompt_hash
 * is promptHashForPayload of it). All of that is checked before the supplier is called; who the caller is cannot be (see the
 * residual in the header). The escrow must be live and Open before its advert is read, and so before anything is asked of the
 * advert's host. The request is the route's: the escrow ref is the canonical one, the headers are the route's alone. Errors name the
 * escrow and never the endpoint or the body of an answer; a failure after the request may have reached the supplier says the
 * escrow may have been claimed anyway.
 *
 * The call has one budget of 90 s from `clock.startedAt` (SEND_BUDGET_MS), and the checks above are paid from it: the POST is given
 * what is left, so the whole call stays under the proxy's cut. If the checks have used so much that less than the supplier's own
 * claim limit (60 s) is left, nothing is sent: a POST abandoned while the supplier is still within its limit may have claimed the
 * escrow with no job id for the buyer to poll, whereas a send that was refused can simply be repeated.
 */
export async function sendJob(provider: Provider, koiosUrl: string, p: { escrowRef: string; payload: string; buyerAddress: string; route?: Route['kind'] }, fetchImpl: typeof fetch = fetch, clock: SendClock = {}): Promise<SentJob> {
  const now = clock.now ?? Date.now;
  const startedAt = clock.startedAt ?? now();
  const canonical = canonicalRef(p.escrowRef);
  const refuse = (why: string) => new Error(`Cannot send a job for escrow ${canonical}: ${why} Nothing was sent.`);
  if (typeof p.payload !== 'string' || p.payload.length === 0) throw refuse('the payload must be a non-empty string.');
  const forced = outOfScope(p.route, undefined);
  if (forced !== null) throw refuse(forced);
  const buyerPkh = buyerKeyHash(p.buyerAddress, refuse);
  const lineage = await resolveEscrowLineage(provider, koiosUrl, canonical, fetchImpl);
  const { posted } = lineage;
  await checkBuyer(posted, koiosUrl, canonical, fetchImpl, { refuse, buyerPkh, buyerAddress: p.buyerAddress });
  // Live and Open comes before the advert is read: an escrow that is finished, Claimed or Submitted costs no read of its advert.
  if (lineage.current === null) throw refuse('no live output was found for it (it may be finished, or the chain index may be behind).');
  if (lineage.current.datum.state !== 'Open') throw refuse(`it is ${lineage.current.datum.state} and a job can only be sent while it is Open.`);
  const advert = await readTargetAdvert(posted, koiosUrl, fetchImpl, { refuse, forSend: true });
  if (promptHashForPayload(p.payload) !== posted.prompt_hash) throw refuse("the payload does not match the escrow's prompt_hash: it must be exactly the payload the escrow was posted with.");
  const route = routeFor(advert.capability_id, p.route);
  const { headers, body } = route.body(canonical, p.payload);
  const size = Buffer.byteLength(body, 'utf8');
  if (size > MAX_REQUEST_BYTES) throw refuse(`the request is ${size} bytes, over the ${MAX_REQUEST_BYTES} byte limit.`);

  const spent = Math.max(now() - startedAt, 0);
  const left = SEND_BUDGET_MS - spent;
  if (left < SUPPLIER_CLAIM_LIMIT_MS) {
    throw refuse(`the checks before the send took ${Math.round(spent / 1000)} s of the ${SEND_BUDGET_MS / 1000} s this call may use, which leaves less than the ${SUPPLIER_CLAIM_LIMIT_MS / 1000} s a supplier may need to claim the escrow and answer; send again.`);
  }
  const post: Call = { maxResponseBytes: SEND_RESPONSE_BYTES, timeoutMs: left };

  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(route.post(advert.endpoint_url), { method: 'POST', headers, body }, { ...post, fetchImpl });
  } catch (err) {
    throw new Error(`Could not send the job for escrow ${canonical}: ${callFailure(err, post)}.${mayHaveReached(err) ? MAY_HAVE_CLAIMED : ''}`);
  }
  const answer = jsonObject(res.text);
  if (res.status !== 202) {
    const { reason, message } = said(res.status, answer);
    const detail = cell(message, 200).replace(/[.\s]+$/, '');
    // A 4xx is the supplier turning the job down before it claimed anything; any other status may come after the claim (the template's
    // 504 claim_timeout, a proxy's 5xx, an unexpected 2xx).
    const turnedDown = res.status >= 400 && res.status < 500;
    throw new Error(`Could not send the job for escrow ${canonical}: the supplier answered ${res.status} (${cell(reason, 64)})${detail ? `: ${detail}` : ''}.${turnedDown ? '' : MAY_HAVE_CLAIMED}`);
  }
  const jobId = answer?.job_id;
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error(`Could not send the job for escrow ${canonical}: the supplier answered 202 but returned no usable job id.${MAY_HAVE_CLAIMED}`);
  const status = typeof answer?.status === 'string' ? answer.status.slice(0, 100) : 'accepted';
  return { jobId, status, route: route.kind, endpoint: advert.endpoint_url, capabilityId: advert.capability_id, escrowRef: canonical };
}

/** `escrowRef` is the canonical spelling of the ref the caller gave, and `deliverBy` the escrow's deliver_by (POSIX ms), from its datum. */
export interface PolledJob { view: JobView; route: Route['kind']; endpoint: string; supplierPkh: string; capabilityId: string; escrowRef: string; deliverBy: number }

/** A poll answer that names another escrow than the one asked about is not an answer about this job: the failed view that says so, else null. */
function wrongEscrow(text: string, canonical: string): JobView | null {
  const echoed = jsonObject(text)?.escrow_ref;
  if (echoed === undefined) return null;
  let same = false;
  if (typeof echoed === 'string') { try { same = canonicalRef(echoed) === canonical; } catch { /* not a ref: not the same */ } }
  return same ? null : { state: 'failed', reason: 'escrow_mismatch', message: `The supplier's answer is for another escrow than ${canonical}; it is not used.` };
}

/**
 * Asks the supplier of an escrow how a job stands, for the escrow's own buyer only (`buyerAddress`, as for sendJob) and for a
 * template-contract supplier only. The escrow may be live (Open, Claimed, Submitted) or consumed (accepted, released): a finished
 * job is fetchable after settlement. Only the Post output is read (readEscrowOutput; see the header), which holds the buyer, the
 * funder's transaction and the advert, so no copy left at the escrow credential and no lag of the node can stop a poll. The
 * endpoint is the advert's even when the advert has since been spent or retired. An answer that names another escrow than the one
 * asked about is a failed view. `supplierPkh` is the key the advert names; the view is the supplier's own account (see JobView) and
 * `endpoint` the URL it came from.
 */
export async function getJob(koiosUrl: string, p: { escrowRef: string; jobId: string; buyerAddress: string; route?: Route['kind'] }, fetchImpl: typeof fetch = fetch): Promise<PolledJob> {
  const canonical = canonicalRef(p.escrowRef);
  const refuse = (why: string) => new Error(`Cannot poll a job for escrow ${canonical}: ${why} Nothing was sent.`);
  if (typeof p.jobId !== 'string' || !JOB_ID.test(p.jobId)) throw refuse('the job id must be 1 to 128 letters, digits, hyphens or underscores.');
  const forced = outOfScope(p.route, undefined);
  if (forced !== null) throw refuse(forced);
  const buyerPkh = buyerKeyHash(p.buyerAddress, refuse);
  const { datum: posted } = await readEscrowOutput(koiosUrl, canonical, fetchImpl);
  await checkBuyer(posted, koiosUrl, canonical, fetchImpl, { refuse, buyerPkh, buyerAddress: p.buyerAddress });
  const advert = await readTargetAdvert(posted, koiosUrl, fetchImpl, { refuse, forSend: false });
  const route = routeFor(advert.capability_id, p.route);
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(route.poll(advert.endpoint_url, p.jobId), { headers: { accept: 'application/json' } }, { ...POLL_CALL, fetchImpl });
  } catch (err) {
    throw new Error(`Could not poll job ${p.jobId} of escrow ${canonical}: ${callFailure(err, POLL_CALL)}.`);
  }
  const view = wrongEscrow(res.text, canonical) ?? parseJobResponse(res.status, res.text);
  return { view, route: route.kind, endpoint: advert.endpoint_url, supplierPkh: advert.supplier_pkh, capabilityId: advert.capability_id, escrowRef: canonical, deliverBy: posted.deliver_by };
}

// ─── The manifest an advert points to ────────────────────────────────────────────────────────────────────────────────────────────
// An advert's detail_uri is a URL its author chose: a description of what the supplier offers. It is fetched as every URL taken from
// chain data is, through safeFetch, and is the supplier's own JSON. The advert also commits to it: detail_hash is the sha256 of the
// detail JSON (agents-marketplace docs/ARCHITECTURE.md), so fetchManifest returns the sha256 of the bytes it read and the caller holds
// it against detail_hash. A file that does not hash to it is not the file the advert committed to.
const MANIFEST_CALL = { maxResponseBytes: 256 * 1024, timeoutMs: 15_000 } as const;

/**
 * `fetchImpl` with a tap on the body: the bytes that whoever reads the answer pulls from the stream are kept, so they can be hashed as
 * they came. safeFetch returns the answer as text, and text is not the bytes: a file that is not valid UTF-8 decodes with replacement
 * characters, and the hash of the decoded text is not the hash of the file. (safeFetch is vendored from the sister repo and is not
 * changed here, so the bytes are taken from the stream it reads.) The tap reads nothing itself, so the cap safeFetch enforces on the
 * body bounds what is kept, and a stream that safeFetch abandons is abandoned.
 */
function tapped(fetchImpl: typeof fetch): { fetchImpl: typeof fetch; bytes: () => Buffer } {
  const chunks: Uint8Array[] = [];
  const through = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await fetchImpl(input, init);
    if (res.body === null) return res;
    const tap = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { chunks.push(chunk); controller.enqueue(chunk); } });
    return new Response(res.body.pipeThrough(tap), { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
  return { fetchImpl: through, bytes: () => Buffer.concat(chunks) };
}

/**
 * The JSON the detail_uri serves and the sha256 (lower-case hex) of the bytes it was served as, or why it could not be fetched, in words
 * that carry neither the URL nor anything the host said. A file that cannot be fetched or is not JSON has no hash here: nothing was
 * checked.
 */
export async function fetchManifest(detailUri: string, fetchImpl: typeof fetch = fetch): Promise<{ manifest: unknown; sha256: string } | { error: string }> {
  const tap = tapped(fetchImpl);
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(detailUri, { headers: { accept: 'application/json' } }, { ...MANIFEST_CALL, fetchImpl: tap.fetchImpl });
  } catch (err) {
    return { error: callFailure(err, MANIFEST_CALL) };
  }
  if (res.status !== 200) return { error: `the supplier answered ${res.status}` };
  let manifest: unknown;
  try { manifest = JSON.parse(res.text) as unknown; } catch { return { error: 'its answer is not JSON' }; }
  return { manifest, sha256: sha256BytesHex(tap.bytes()) };
}
