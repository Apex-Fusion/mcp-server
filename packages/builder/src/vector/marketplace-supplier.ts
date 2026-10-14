// packages/builder/src/vector/marketplace-supplier.ts
// What the job transport (marketplace-transport.ts: send, poll, the manifest) and the check of a receipt (marketplace-verify.ts) share to
// reach a supplier: the route table, the policy for a call to one (what a failed call may say, and what is out of this release's scope),
// and the advert a call is addressed to. A supplier is reached at the endpoint_url of the advert its escrow names (the escrow's Post
// output, then its advert_ref, then readAdvert), never at a URL the caller gives. Nothing here builds, signs or sends anything.
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
import { readAdvert } from './marketplace-indexer.js';
import type { AdvertRead } from './marketplace-indexer.js';
import { formatOutRef, parseOutRef, wirePayloadFor } from './marketplace-datum.js';
import type { AdvertDatum, EscrowDatum } from './marketplace-datum.js';
import { koiosFailure } from './marketplace-lineage.js';
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
export const trim = (endpoint: string) => endpoint.replace(/\/+$/, '');
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

// ─── Calling a supplier ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What one call to a supplier may wait for and read. */
export type Call = { readonly maxResponseBytes: number; readonly timeoutMs: number };

const TEMPLATE_ONLY = 'this tool supports template-contract suppliers only in this release';

export const canonicalRef = (escrowRef: string): string => { const ref = parseOutRef(escrowRef); return formatOutRef(ref.txHash, ref.outputIndex); };
function isHttps(url: string): boolean { try { return new URL(url).protocol === 'https:'; } catch { return false; } }
export const isTimeout = (err: unknown): boolean => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

/** Why a call to a supplier failed, in words that carry neither its URL nor anything the network or the supplier said. */
export function callFailure(err: unknown, call: Call): string {
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
export function outOfScope(forced: Route['kind'] | undefined, capability: string | undefined): string | null {
  if (forced !== undefined && routeFor('', forced).kind !== 'template') return `the ${forced} route is a fleet route; ${TEMPLATE_ONLY}.`;
  if (capability !== undefined && isFleetCapability(capability)) return `${cell(capability, 80)} uses the fleet route; ${TEMPLATE_ONLY}.`;
  return null;
}

/** "a Claimed output", "an Accepted output". */
const withArticle = (word: string): string => `${/^[AEIOU]/i.test(word) ? 'an' : 'a'} ${word}`;
/** Why a ref is not the Post output of an escrow (a later output has the supplier's transactions behind it, not the buyer's), or null when it is. */
export const notThePostOutput = (posted: EscrowDatum): string | null =>
  posted.state === 'Open' ? null : `it is ${withArticle(posted.state)} output, not the output its Post made: use the escrow ref the Post returned.`;


/** The JSON object in `text`, or null when it is not JSON or not an object. */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}

/**
 * The advert whose endpoint serves the escrow whose Post output is `posted`, read with readAdvert at the advert script address from
 * the same Koios. Refused, naming the escrow and saying nothing was sent:
 * - for a send, an advert that is Retired, spent (its supplier retired or replaced it: the endpoint it names is not one to send a
 *   payload to now) or of a spent status Koios does not report. A poll sends the supplier nothing it does not have, and the endpoint
 *   of a spent or retired advert is still where the job went, so a poll reads the advert whatever its state;
 * - an endpoint that is not an https URL, and a capability that is not a template-contract one (this release).
 */
export async function readTargetAdvert(
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

