// packages/builder/src/vector/marketplace-transport.ts
// Job transport to supplier endpoints, through safeFetch only: send a job, poll it, and check the receipt that comes back (verifyReceipt,
// verifyJob), plus the fetch of an advert's manifest (fetchManifest). A supplier is reached at the endpoint_url of the advert its
// escrow names (the escrow's Post output, then its advert_ref, then readAdvert), never at a URL the caller gives. Nothing here builds,
// signs or submits a transaction, and no error carries a supplier URL: they name the escrow and what happened.
//
// The routes are pinned from Apex-Fusion/agents-marketplace origin/main e847a55 (2026-10-13), supplier/src/server.ts. A supplier is a
// single-capability process and mounts the ONE route shape its capability kind serves:
//   one-shot LLM (llm.text.generate.*)  POST /v1/responses            GET /v1/responses/:jobId
//   OCR (ocr.page.extract.*)            POST /v1/ocr/extract          GET /v1/ocr/extract/:jobId
//   TTS (audio.synthesize.*)            POST /v1/audio/synthesize     GET /v1/audio/synthesize/:jobId
// The three POST handlers read the escrow ref from the X-Escrow-Ref header. The chat one takes a Responses request and refuses any
// field of another API (`messages` among them); the other two take the request object itself. llm.chat.v1 (the multi-turn session
// capability) mounts /v1/chat/start|message|end and no one-job route, so it has no route here. Every other capability is a
// vector-agent-template (c4c378a, agent/src/routes/custom.ts) supplier: POST /v1/job {escrow_ref, payload}, GET /v1/job/:jobId.
//
// Scope of this release: template-contract suppliers only. Each fleet handler commits its own hash of the request it receives (the
// Responses request, the OCR envelope, the TTS envelope) and buildPostEscrow commits promptHashForPayload, which only the template's
// commitment is, so a fleet hire posted here cannot be claimed. sendJob and getJob therefore refuse a fleet capability (llm.chat.*, the
// multi-turn session capability, included), and a fleet route forced by the caller, before anything is sent; the fleet half of the
// table below stays, tested, as the transport for a later SDK-backed path.
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
import { CML } from '@lucid-evolution/lucid';
import type { Provider } from '@lucid-evolution/lucid';
import { safeFetch } from './safe-fetch.js';
import { readAdvert, koiosTxInputCreds, fetchEscrows } from './marketplace-indexer.js';
import type { AdvertRead } from './marketplace-indexer.js';
import { canonicalize, formatOutRef, parseOutRef, promptHashForPayload, sha256BytesHex, sha256Utf8Hex, wirePayloadFor } from './marketplace-datum.js';
import type { AdvertDatum, EscrowDatum } from './marketplace-datum.js';
import { paymentKeyHashOf } from './gov-build.js';
import { resolveEscrowLineage, readEscrowOutput, readSubmittedOutput, submittedRefsOf, koiosFailure } from './marketplace-lineage.js';
import type { EscrowLineage } from './marketplace-lineage.js';
import { cell } from './marketplace-shared.js';

// ─── Routes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Route {
  kind: 'template' | 'chat' | 'ocr' | 'tts';
  post: (endpoint: string) => string;
  poll: (endpoint: string, jobId: string) => string;
  body: (escrowRef: string, payload: string) => { headers: Record<string, string>; body: string };
}
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;
/** Headers are fixed per route: nothing a caller passes becomes one. */
const withEscrow = (escrowRef: string): Record<string, string> => ({ ...JSON_HEADERS, 'X-Escrow-Ref': escrowRef });
const trim = (endpoint: string) => endpoint.replace(/\/+$/, '');
const jobSegment = (jobId: string) => encodeURIComponent(jobId);

// The template route is the only one sendJob and getJob serve in this release. The fleet routes (chat, ocr, tts) are correct
// transports for the pinned suppliers, kept with their tests for a later SDK-backed path: nothing here reaches them.
export const ROUTES: Record<Route['kind'], Route> = {
  // The template hashes the raw `payload` string it receives and compares it with the escrow's prompt_hash (custom.ts: sha256(payload)),
  // and what a buyer commits is promptHashForPayload, the hash of the canonical one-element message array. So the array goes on the wire.
  template: {
    kind: 'template',
    post: (e) => `${trim(e)}/v1/job`,
    poll: (e, id) => `${trim(e)}/v1/job/${jobSegment(id)}`,
    body: (escrowRef, payload) => ({ headers: { ...JSON_HEADERS }, body: JSON.stringify({ escrow_ref: escrowRef, payload: wirePayloadFor(payload) }) }),
  },
  // The payload is the prompt: a string `input` is one user message in a Responses request.
  chat: {
    kind: 'chat',
    post: (e) => `${trim(e)}/v1/responses`,
    poll: (e, id) => `${trim(e)}/v1/responses/${jobSegment(id)}`,
    body: (escrowRef, payload) => ({ headers: withEscrow(escrowRef), body: JSON.stringify({ input: payload }) }),
  },
  // The payload is the request object as JSON text: {image_b64, mime, output_format} for OCR, {text, voice, format, speed} for TTS.
  ocr: {
    kind: 'ocr',
    post: (e) => `${trim(e)}/v1/ocr/extract`,
    poll: (e, id) => `${trim(e)}/v1/ocr/extract/${jobSegment(id)}`,
    body: (escrowRef, payload) => ({ headers: withEscrow(escrowRef), body: payload }),
  },
  tts: {
    kind: 'tts',
    post: (e) => `${trim(e)}/v1/audio/synthesize`,
    poll: (e, id) => `${trim(e)}/v1/audio/synthesize/${jobSegment(id)}`,
    body: (escrowRef, payload) => ({ headers: withEscrow(escrowRef), body: payload }),
  },
};

/** The route for a capability, or the one a caller forces. A name that is not a route is refused here and not found out later. */
export function routeFor(capabilityId: string, forced?: Route['kind']): Route {
  if (forced !== undefined) {
    if (!Object.keys(ROUTES).includes(forced)) throw new Error(`Unknown route "${cell(forced, 40)}"; expected one of ${Object.keys(ROUTES).join(', ')}.`);
    return ROUTES[forced];
  }
  if (capabilityId.startsWith('llm.text.generate.')) return ROUTES.chat;
  if (capabilityId.startsWith('ocr.page.extract.')) return ROUTES.ocr;
  if (capabilityId.startsWith('audio.synthesize.')) return ROUTES.tts;
  return ROUTES.template;
}

/**
 * Is this capability served by the fleet and not by a template supplier? Whatever routeFor maps to chat, ocr or tts, and llm.chat.*,
 * the multi-turn session capability, which routeFor leaves with the template route only because its supplier has no one-job route.
 */
export function isFleetCapability(capabilityId: string): boolean {
  return routeFor(capabilityId).kind !== 'template' || capabilityId.startsWith('llm.chat.');
}

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

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}
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
  try { const ref = parseOutRef(value); return formatOutRef(ref.txHash, ref.outputIndex); } catch { return null; }
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
type Call = { readonly maxResponseBytes: number; readonly timeoutMs: number };
/** The most a request to a supplier may carry: the body that goes on the wire, which for the template wraps the payload. */
const MAX_REQUEST_BYTES = 1_000_000;
/** A job id goes into a URL and into text a person or an assistant reads: letters, digits, hyphens and underscores (a UUID fits). */
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAY_HAVE_CLAIMED = ' It may have claimed the escrow anyway, so check its state before sending again; if it stays Open, reclaim it after deliver_by.';
const TEMPLATE_ONLY = 'this tool supports template-contract suppliers only in this release';

const canonicalRef = (escrowRef: string): string => { const ref = parseOutRef(escrowRef); return formatOutRef(ref.txHash, ref.outputIndex); };
function isHttps(url: string): boolean { try { return new URL(url).protocol === 'https:'; } catch { return false; } }
const isTimeout = (err: unknown): boolean => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

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

/** Why a call to a supplier failed, in words that carry neither its URL nor anything the network or the supplier said. */
function callFailure(err: unknown, call: Call): string {
  if (isTimeout(err)) return `the supplier did not answer within ${Math.round(call.timeoutMs / 1000)} s`;
  const message = err instanceof Error ? err.message : '';
  if (/^safeFetch: /.test(message)) {
    if (/private or reserved address/.test(message)) return 'the supplier host resolves to a private or reserved address, which is refused';
    if (/redirect/.test(message)) return 'the supplier answered with a redirect, which is not followed';
    if (/byte cap/.test(message)) return `the supplier's answer is over the ${call.maxResponseBytes} byte limit`;
    return 'the supplier URL was refused by the outbound-call policy';
  }
  return 'the request to the supplier failed (network error)';
}

/**
 * Why a route forced by the caller, or an advert's capability, is out of this release's scope, or null. A capability that
 * isFleetCapability is a fleet supplier, and so is any forced route but the template's. (A forced name that is no route at all is
 * routeFor's Unknown route error.)
 */
function outOfScope(forced: Route['kind'] | undefined, capability: string | undefined): string | null {
  if (forced !== undefined && routeFor('', forced).kind !== 'template') return `the ${forced} route is a fleet route; ${TEMPLATE_ONLY}.`;
  if (capability !== undefined && isFleetCapability(capability)) return `${cell(capability, 80)} uses the fleet route; ${TEMPLATE_ONLY}.`;
  return null;
}

/** The payment key hash of the wallet address the caller says posted the escrow. A script address, or no address, is no buyer. */
function buyerKeyHash(buyerAddress: unknown, refuse: (why: string) => Error): string {
  if (typeof buyerAddress === 'string') { try { return paymentKeyHashOf(buyerAddress); } catch { /* refused below */ } }
  throw refuse('buyerAddress must be the wallet address (a key address) the escrow was posted from.');
}

/** "a Claimed output", "an Accepted output". */
const withArticle = (word: string): string => `${/^[AEIOU]/i.test(word) ? 'an' : 'a'} ${word}`;
/** Why a ref is not the Post output of an escrow (a later output has the supplier's transactions behind it, not the buyer's), or null when it is. */
const notThePostOutput = (posted: EscrowDatum): string | null =>
  posted.state === 'Open' ? null : `it is ${withArticle(posted.state)} output, not the output its Post made: use the escrow ref the Post returned.`;

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

/**
 * The advert whose endpoint serves the escrow whose Post output is `posted`, read with readAdvert at the advert script address from
 * the same Koios. Refused, naming the escrow and saying nothing was sent:
 * - for a send, an advert that is Retired, spent (its supplier retired or replaced it: the endpoint it names is not one to send a
 *   payload to now) or of a spent status Koios does not report. A poll sends the supplier nothing it does not have, and the endpoint
 *   of a spent or retired advert is still where the job went, so a poll reads the advert whatever its state;
 * - an endpoint that is not an https URL, and a capability that is not a template-contract one (this release).
 */
async function readTargetAdvert(
  posted: EscrowDatum, koiosUrl: string, fetchImpl: typeof fetch,
  o: { refuse: (why: string) => Error; forSend: boolean },
): Promise<AdvertDatum> {
  const { refuse } = o;
  const advertRef = formatOutRef(posted.advert_ref.txHash, posted.advert_ref.index);
  let read: AdvertRead;
  try { read = await readAdvert(advertRef, fetchImpl, koiosUrl); } catch (err) { throw refuse(`its advert ${advertRef} could not be read (${koiosFailure(err)}).`); }
  if ('error' in read) throw refuse(read.error);
  if (o.forSend) {
    if (read.advert.status !== 'Active') throw refuse(`its advert ${advertRef} is ${read.advert.status}.`);
    if (read.spent) throw refuse(`its advert ${advertRef} has been spent (its supplier retired or replaced it).`);
    // Koios leaves is_spent out when it does not know; "not reported" must not read as "unspent" (buildPostEscrow and the resolver agree).
    if (read.utxo.is_spent !== false) throw refuse(`Koios did not report whether its advert ${advertRef} is spent.`);
  }
  if (!isHttps(read.advert.endpoint_url)) throw refuse(`the endpoint of its advert ${advertRef} is not an https URL.`);
  const scope = outOfScope(undefined, read.advert.capability_id);
  if (scope !== null) throw refuse(scope);
  return read.advert;
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
