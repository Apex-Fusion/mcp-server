// packages/builder/src/vector/marketplace-transport.ts
// Job transport to supplier endpoints, through safeFetch only. A supplier is reached at the endpoint_url of the advert its escrow
// names (resolveEscrowLineage, then posted.advert_ref, then readAdvert), never at a URL the caller gives. Nothing here builds, signs
// or submits a transaction, and no error carries a supplier URL: they name the escrow and what happened.
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
// commitment is, so a fleet hire posted here cannot be claimed. sendJob and getJob therefore refuse a fleet capability, and a fleet
// route forced by the caller, before anything is sent; the fleet half of the table below stays, tested, as the transport for a later
// SDK-backed path.
//
// Two ties keep the tool from posting data to an endpoint just because an escrow names it (anyone can post an escrow, and an advert for
// it): the escrow must have been posted by the caller's buyerAddress (its buyer key is in the datum), and a send must carry exactly the
// payload the escrow committed to (promptHashForPayload is its prompt_hash). buyerAddress is the caller's word, not a proof of who the
// caller is; the payload tie is what stops a stranger's escrow from collecting a payload it was not posted for.
import type { Provider } from '@lucid-evolution/lucid';
import { safeFetch } from './safe-fetch.js';
import { readAdvert } from './marketplace-indexer.js';
import type { AdvertRead } from './marketplace-indexer.js';
import { formatOutRef, parseOutRef, promptHashForPayload, wirePayloadFor } from './marketplace-datum.js';
import type { AdvertDatum } from './marketplace-datum.js';
import { paymentKeyHashOf } from './gov-build.js';
import { resolveEscrowLineage, koiosFailure } from './marketplace-lineage.js';
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

// ─── What a supplier answers ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A supplier's answer to a poll. Everything in it comes from the supplier: show it as data. `raw` is the whole answer, kept so a
 * caller can pass on exactly what the receipt was made over; `submittedRef` is the Submitted escrow output the supplier says it made
 * (a ref in canonical form, or null), which says nothing until it is checked against the chain.
 */
export type JobView =
  | { state: 'pending'; status: string }
  | { state: 'done'; result: string; receipt: unknown; receiptSignature: string; submittedRef: string | null; raw: unknown }
  | { state: 'failed'; reason: string; message: string };

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}
/** What a supplier said about a failure: its own reason and message when it sent them, else the status and the start of its body. Bounded. */
function said(status: number, body: Record<string, unknown> | null, text: string): { reason: string; message: string } {
  return {
    reason: typeof body?.reason === 'string' ? body.reason.slice(0, 100) : `http_${status}`,
    message: typeof body?.message === 'string' ? body.message.slice(0, 500) : text.slice(0, 200),
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
    // A job is finished when the supplier hands over a receipt; an answer that is not even a JSON object is not that.
    if (body === null) return { state: 'failed', reason: 'malformed_response', message: 'The supplier answered 200 with something that is not a JSON object.' };
    return {
      state: 'done', result: resultOf(body, text), receipt: body.receipt, submittedRef: submittedRefOf(body.submitted_ref), raw: body,
      receiptSignature: typeof body.receipt_signature === 'string' ? body.receipt_signature : '',
    };
  }
  return { state: 'failed', ...said(status, body, text) };
}

// ─── Reaching a supplier ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * What one call to a supplier may wait for and read. A supplier answers a job POST only after its own Claim has confirmed (its limit
 * for that is 60 s), so the POST is given 90 s (the hosted server sits behind Cloudflare, which drops a call near 100 s); a poll only
 * asks, and is given 20 s. A POST that outlasts its budget is reported as unanswered, with the warning that the escrow may have been
 * claimed anyway.
 */
const SEND_CALL = { maxResponseBytes: 1_000_000, timeoutMs: 90_000 } as const;
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

/** Why a call to a supplier failed, in words that carry neither its URL nor anything the network or the supplier said. */
function callFailure(err: unknown, call: Call): string {
  if (isTimeout(err)) return `the supplier did not answer within ${call.timeoutMs / 1000} s`;
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
 * Why a route forced by the caller, or an advert's capability, is out of this release's scope, or null. A capability that routeFor
 * maps to the chat, ocr or tts route is a fleet supplier, and so is any forced route but the template's. (A forced name that is no
 * route at all is routeFor's Unknown route error.)
 */
function outOfScope(forced: Route['kind'] | undefined, capability: string | undefined): string | null {
  if (forced !== undefined && routeFor('', forced).kind !== 'template') return `the ${forced} route is a fleet route; ${TEMPLATE_ONLY}.`;
  if (capability !== undefined && routeFor(capability).kind !== 'template') return `${cell(capability, 80)} uses the fleet route; ${TEMPLATE_ONLY}.`;
  return null;
}

/** The payment key hash of the wallet address the caller says posted the escrow. A script address, or no address, is no buyer. */
function buyerKeyHash(buyerAddress: unknown, refuse: (why: string) => Error): string {
  if (typeof buyerAddress === 'string') { try { return paymentKeyHashOf(buyerAddress); } catch { /* refused below */ } }
  throw refuse('buyerAddress must be the wallet address (a key address) the escrow was posted from.');
}

/**
 * The escrow's lineage and the advert whose endpoint serves it, once everything that could make this the wrong escrow, the wrong
 * person or the wrong place is ruled out. The escrow comes from resolveEscrowLineage (credential-checked, fails closed), its advert from
 * readAdvert at the advert script address. Refused, naming the escrow and saying nothing was sent:
 * - an escrow that was not posted by `buyerAddress` (the buyer key is in the datum the buyer signed);
 * - an escrow with no live output; for a send, one that is not Open;
 * - for a send, an advert that is Retired, spent (its supplier retired or replaced it: the endpoint it names is not one to send a
 *   payload to now) or of a spent status Koios does not report. A poll sends the supplier nothing it does not have, and the endpoint
 *   of a spent or retired advert is still where the job went, so a poll reads the advert whatever its state;
 * - an endpoint that is not an https URL, and a capability that is not a template-contract one (this release).
 * (readAdvert reads from the configured Koios, which is the `koiosUrl` every tool passes; the escrow is read from the `koiosUrl` given.)
 */
async function resolveTarget(
  provider: Provider, koiosUrl: string, canonical: string, fetchImpl: typeof fetch,
  o: { refuse: (why: string) => Error; buyerPkh: string; buyerAddress: string; forSend: boolean },
): Promise<{ lineage: EscrowLineage; advert: AdvertDatum }> {
  const { refuse } = o;
  const lineage = await resolveEscrowLineage(provider, koiosUrl, canonical, fetchImpl);
  if (lineage.posted.buyer_pkh !== o.buyerPkh) throw refuse(`it was not posted by ${cell(o.buyerAddress, 120)}.`);
  if (lineage.current === null) throw refuse('no live output was found for it (it may be finished, or the chain index may be behind).');
  if (o.forSend && lineage.current.datum.state !== 'Open') throw refuse(`it is ${lineage.current.datum.state} and a job can only be sent while it is Open.`);
  const advertRef = formatOutRef(lineage.posted.advert_ref.txHash, lineage.posted.advert_ref.index);
  let read: AdvertRead;
  try { read = await readAdvert(advertRef, fetchImpl); } catch (err) { throw refuse(`its advert ${advertRef} could not be read (${koiosFailure(err)}).`); }
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
  return { lineage, advert: read.advert };
}

export interface SentJob { jobId: string; status: string; route: Route['kind']; endpoint: string; capabilityId: string }

/**
 * Sends the job for an Open escrow to its supplier and returns the job id the supplier answers with (202 means its Claim has
 * confirmed). Only for a template-contract supplier, and only for the escrow's own buyer: `buyerAddress` must be the wallet address the
 * escrow was posted from, and `payload` exactly the payload it was posted with (its prompt_hash is promptHashForPayload of it), so an
 * escrow someone else posted, with an advert of their own, is not a place to send anything. All of that is checked before the supplier
 * is called. The request is the route's: the escrow ref is the canonical one, the headers are the route's alone. Errors name the escrow
 * and never the endpoint; a supplier that does not answer within the call budget is an error that says the escrow may have been
 * claimed anyway.
 */
export async function sendJob(provider: Provider, koiosUrl: string, p: { escrowRef: string; payload: string; buyerAddress: string; route?: Route['kind'] }, fetchImpl: typeof fetch = fetch): Promise<SentJob> {
  const canonical = canonicalRef(p.escrowRef);
  const refuse = (why: string) => new Error(`Cannot send a job for escrow ${canonical}: ${why} Nothing was sent.`);
  if (typeof p.payload !== 'string' || p.payload.length === 0) throw refuse('the payload must be a non-empty string.');
  const forced = outOfScope(p.route, undefined);
  if (forced !== null) throw refuse(forced);
  const buyerPkh = buyerKeyHash(p.buyerAddress, refuse);
  const { lineage, advert } = await resolveTarget(provider, koiosUrl, canonical, fetchImpl, { refuse, buyerPkh, buyerAddress: p.buyerAddress, forSend: true });
  if (promptHashForPayload(p.payload) !== lineage.posted.prompt_hash) throw refuse("the payload does not match the escrow's prompt_hash: it must be exactly the payload the escrow was posted with.");
  const route = routeFor(advert.capability_id, p.route);
  const { headers, body } = route.body(canonical, p.payload);
  const size = Buffer.byteLength(body, 'utf8');
  if (size > MAX_REQUEST_BYTES) throw refuse(`the request is ${size} bytes, over the ${MAX_REQUEST_BYTES} byte limit.`);

  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(route.post(advert.endpoint_url), { method: 'POST', headers, body }, { ...SEND_CALL, fetchImpl });
  } catch (err) {
    throw new Error(`Could not send the job for escrow ${canonical}: ${callFailure(err, SEND_CALL)}.${isTimeout(err) ? MAY_HAVE_CLAIMED : ''}`);
  }
  const answer = jsonObject(res.text);
  if (res.status !== 202) {
    const { reason, message } = said(res.status, answer, res.text);
    throw new Error(`Could not send the job for escrow ${canonical}: the supplier answered ${res.status} (${cell(reason, 64)}): ${cell(message, 200).replace(/[.\s]+$/, '')}.`);
  }
  const jobId = answer?.job_id;
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error(`Could not send the job for escrow ${canonical}: the supplier answered 202 but returned no usable job id.`);
  const status = typeof answer?.status === 'string' ? answer.status.slice(0, 100) : 'accepted';
  return { jobId, status, route: route.kind, endpoint: advert.endpoint_url, capabilityId: advert.capability_id };
}

export interface PolledJob { view: JobView; route: Route['kind']; endpoint: string; supplierPkh: string; capabilityId: string }

/**
 * Asks the supplier of a live escrow (Open, Claimed or Submitted) how a job stands, for the escrow's own buyer only (`buyerAddress`, as
 * for sendJob) and for a template-contract supplier only. The endpoint is the advert's even when the advert has since been spent or
 * retired. `supplierPkh` is the key the advert names; the view is the supplier's own account (see JobView) and `endpoint` the URL it
 * came from.
 */
export async function getJob(provider: Provider, koiosUrl: string, p: { escrowRef: string; jobId: string; buyerAddress: string; route?: Route['kind'] }, fetchImpl: typeof fetch = fetch): Promise<PolledJob> {
  const canonical = canonicalRef(p.escrowRef);
  const refuse = (why: string) => new Error(`Cannot poll a job for escrow ${canonical}: ${why} Nothing was sent.`);
  if (typeof p.jobId !== 'string' || !JOB_ID.test(p.jobId)) throw refuse('the job id must be 1 to 128 letters, digits, hyphens or underscores.');
  const forced = outOfScope(p.route, undefined);
  if (forced !== null) throw refuse(forced);
  const buyerPkh = buyerKeyHash(p.buyerAddress, refuse);
  const { advert } = await resolveTarget(provider, koiosUrl, canonical, fetchImpl, { refuse, buyerPkh, buyerAddress: p.buyerAddress, forSend: false });
  const route = routeFor(advert.capability_id, p.route);
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(route.poll(advert.endpoint_url, p.jobId), { headers: { accept: 'application/json' } }, { ...POLL_CALL, fetchImpl });
  } catch (err) {
    throw new Error(`Could not poll job ${p.jobId} of escrow ${canonical}: ${callFailure(err, POLL_CALL)}.`);
  }
  return { view: parseJobResponse(res.status, res.text), route: route.kind, endpoint: advert.endpoint_url, supplierPkh: advert.supplier_pkh, capabilityId: advert.capability_id };
}
