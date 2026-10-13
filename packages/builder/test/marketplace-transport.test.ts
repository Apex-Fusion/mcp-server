// packages/builder/test/marketplace-transport.test.ts
// The job transport: the route table (pinned to the supplier code it talks to), the reading of a supplier's answer, and sendJob and
// getJob against a world of fixtures. The node and Koios describe one chain (fixtures/escrow-koios.fixture.ts `world`), the advert is
// answered the way Koios utxo_info answers it, and the supplier is a fake `fetch` that records what it was sent. No network and no
// DNS: the supplier is an IP literal, which safeFetch checks directly (safeFetch itself is covered by safe-fetch.test.ts).
//
// Pinned from Apex-Fusion/agents-marketplace origin/main e847a55 (2026-10-13), supplier/src/server.ts. A supplier mounts the ONE
// route shape its capability kind serves (createApp, the dispatch at the end). `git grep -n -E 'app\.(post|get)\("/v1/'` there
// prints the lines below; under Git Bash set MSYS_NO_PATHCONV=1, which otherwise rewrites the pattern and prints nothing:
//   1690:    app.post("/v1/audio/synthesize", makeTtsHandler(resolved));
//   1691:    app.get("/v1/audio/synthesize/:jobId", makeGetTtsJobHandler(resolved));
//   1695:    app.post("/v1/ocr/extract", express.json({ limit: "16mb" }), makeOcrHandler(resolved));
//   1696:    app.get("/v1/ocr/extract/:jobId", makeGetOcrJobHandler(resolved));
//   1699:    app.post("/v1/chat/start", chat.start);      (llm.chat.v1, the multi-turn session capability: no one-job route)
//   1700:    app.post("/v1/chat/message", chat.message);
//   1701:    app.post("/v1/chat/end", chat.end);
//   1703:    app.post("/v1/responses", makeChatHandler(resolved));          (llm.text.generate.v1)
//   1704:    app.get("/v1/responses/:jobId", makeGetJobHandler(resolved));
// The three fleet POST handlers read the escrow ref from the X-Escrow-Ref header (makeChatHandler, makeTtsHandler, makeOcrHandler);
// the chat one takes a Responses request (input, instructions, ...: RESPONSE_REQUEST_FIELDS) and refuses any other field. The template
// contract is vector-agent-template c4c378a agent/src/routes/custom.ts: POST /v1/job {escrow_ref, payload}, GET /v1/job/:jobId.
//
// This release serves template-contract suppliers only: the route table and the parsing of the fleet routes' answers are kept, tested
// here, as the transport for a later SDK-backed path, and sendJob and getJob refuse a fleet supplier (and a fleet route) before any
// call. Both also take the buyer's address and refuse an escrow that was not posted from it, and not funded from it: the buyer and the
// prompt hash of an escrow are public datum fields that anyone can copy, so the Post transaction has to carry an input of the buyer's
// key. sendJob refuses a payload that is not the one the escrow committed to. The escrows of these tests are posted from OWN_ADDRESS,
// which also funds their Post transaction as Koios tx_info reports it, with the prompt hash of PAYLOAD.
import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Constr, Data, fromText, getAddressDetails } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { ADVERT_ADDRESS, ESCROW_ADDRESS } from '../src/vector/marketplace-constants.ts';
import { decodeEscrowDatum, encodeEscrowDatum, promptHashForPayload, wirePayloadFor } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../src/vector/marketplace-datum.ts';
import { enterpriseAddressOf } from '../src/vector/marketplace-build.ts';
import { ROUTES, routeFor, parseJobResponse, sendJob, getJob } from '../src/vector/marketplace-transport.ts';
import type { Route } from '../src/vector/marketplace-transport.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF, ESCROW_LOCKED_LOVELACE, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { world, escrowAt, credentialRequests, ESCROW_TX, CLAIM_TX, SUBMIT_TX, DECOY_TX, SUPPLIER_ADDRESS, GENUINE_TXS, DECOY_TXS } from './fixtures/escrow-koios.fixture.ts';
import type { SpentOutputs } from './fixtures/escrow-koios.fixture.ts';

const KOIOS = 'https://koios.example';
const PAYLOAD = 'summarise the filing';
/** An IP literal in a public (documentation) range: safeFetch checks it directly, so no DNS is touched. */
const SUPPLIER = 'https://203.0.113.7';
const JOB_ID = '3f2b8c1e-5a47-4d6e-9b0a-7c1d2e3f4a5b';
const SUBMITTED_REF = `${'ee'.repeat(32)}#0`;
const HOSTILE = '{"error":"db password=hunter2 at https://internal.koios.example"}';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('route table', () => {
  test('unknown capabilities use the template contract, and send the bytes the escrow commits to', () => {
    const r = routeFor('identity.history.report.v1');
    assert.equal(r.kind, 'template');
    assert.equal(r.post('https://s.example'), 'https://s.example/v1/job');
    assert.equal(r.poll('https://s.example', 'abc'), 'https://s.example/v1/job/abc');
    const b = r.body('e#0', '{"x":1}');
    const sent = JSON.parse(b.body);
    // The template hashes the raw `payload` string it receives (sha256(utf8(payload)) must equal the escrow's prompt_hash), and the
    // buyer commits promptHashForPayload: the hash of the canonical one-element message array. So that array is what goes on the wire.
    assert.deepEqual(sent, { escrow_ref: 'e#0', payload: wirePayloadFor('{"x":1}') });
    assert.equal(sent.payload, '[{"content":"{\\"x\\":1}","role":"user"}]');
    assert.equal(sha256(sent.payload), promptHashForPayload('{"x":1}'));
    assert.deepEqual(b.headers, { 'content-type': 'application/json', accept: 'application/json' });
  });
  test('fleet LLM route is /v1/responses: the escrow ref travels in X-Escrow-Ref and the body is a Responses request', () => {
    const r = routeFor('llm.text.generate.v1');
    assert.equal(r.kind, 'chat');
    assert.equal(r.post('https://s.example'), 'https://s.example/v1/responses');
    assert.equal(r.poll('https://s.example', 'abc'), 'https://s.example/v1/responses/abc');
    const b = r.body('e#0', 'hi');
    assert.deepEqual(b.headers, { 'content-type': 'application/json', accept: 'application/json', 'X-Escrow-Ref': 'e#0' });
    // `messages` is not a Responses field: the supplier refuses it with unsupported_parameter
    assert.deepEqual(JSON.parse(b.body), { input: 'hi' });
  });
  test('ocr route passes the payload JSON through', () => {
    const r = routeFor('ocr.page.extract.chandra-ocr-2.v1');
    assert.equal(r.kind, 'ocr');
    assert.equal(r.post('https://s.example'), 'https://s.example/v1/ocr/extract');
    assert.equal(r.poll('https://s.example', 'abc'), 'https://s.example/v1/ocr/extract/abc');
    const b = r.body('e#0', '{"image_b64":"AA==","mime":"image/png"}');
    assert.equal(b.body, '{"image_b64":"AA==","mime":"image/png"}');
    assert.equal(b.headers['X-Escrow-Ref'], 'e#0');
  });
  test('tts route passes the payload JSON through', () => {
    const r = routeFor('audio.synthesize.piper.v1');
    assert.equal(r.kind, 'tts');
    assert.equal(r.post('https://s.example'), 'https://s.example/v1/audio/synthesize');
    assert.equal(r.poll('https://s.example', 'abc'), 'https://s.example/v1/audio/synthesize/abc');
    const b = r.body('e#0', '{"text":"hi","voice":"alloy","format":"mp3","speed":1}');
    assert.equal(b.body, '{"text":"hi","voice":"alloy","format":"mp3","speed":1}');
    assert.equal(b.headers['X-Escrow-Ref'], 'e#0');
  });
  test('the paths are the ones the pinned supplier code mounts, and only the fleet routes ask for X-Escrow-Ref', () => {
    const pinned: Array<[kind: Route['kind'], post: string, poll: string, header: boolean]> = [
      ['template', '/v1/job', '/v1/job/:jobId', false],
      ['chat', '/v1/responses', '/v1/responses/:jobId', true],
      ['ocr', '/v1/ocr/extract', '/v1/ocr/extract/:jobId', true],
      ['tts', '/v1/audio/synthesize', '/v1/audio/synthesize/:jobId', true],
    ];
    assert.deepEqual(Object.keys(ROUTES).sort(), pinned.map(([kind]) => kind).sort());
    for (const [kind, post, poll, header] of pinned) {
      const r = ROUTES[kind];
      assert.equal(r.kind, kind);
      assert.equal(r.post('https://s.example'), `https://s.example${post}`, `${kind} post`);
      assert.equal(r.poll('https://s.example', 'j1'), `https://s.example${poll.replace(':jobId', 'j1')}`, `${kind} poll`);
      assert.equal('X-Escrow-Ref' in r.body('e#0', '{}').headers, header, `${kind} header`);
    }
  });
  test('a trailing slash on the endpoint does not double up, and a path prefix is kept', () => {
    assert.equal(routeFor('x').post('https://s.example/'), 'https://s.example/v1/job');
    assert.equal(routeFor('x').post('https://s.example/agents/a///'), 'https://s.example/agents/a/v1/job');
  });
  test('a job id is escaped into the poll URL, so it cannot add a path or a query', () => {
    assert.equal(routeFor('x').poll('https://s.example', '../capability?x=1#f'), 'https://s.example/v1/job/..%2Fcapability%3Fx%3D1%23f');
  });
  test('capabilities are routed by what their supplier serves; everything else gets the template', () => {
    const kind = (capability: string, forced?: Route['kind']) => routeFor(capability, forced).kind;
    assert.equal(kind('llm.text.generate.v1'), 'chat');
    assert.equal(kind('ocr.page.extract.chandra-ocr-2.v1'), 'ocr');
    assert.equal(kind('audio.synthesize.piper.v1'), 'tts');
    assert.equal(kind('identity.history.report.v1'), 'template');
    // only the families the fleet serves: a neighbouring capability is a template supplier until a route is pinned for it
    for (const other of ['ocr.table.extract.v1', 'audio.transcribe.whisper.v1', 'llm.embed.v1', 'ocr', '']) assert.equal(kind(other), 'template', other);
    // llm.chat.v1 is the multi-turn session capability: its supplier mounts /v1/chat/start|message|end and no one-job route, so the
    // one-shot Responses route is not the place to send it. The table has no route for it either (sendJob and getJob refuse it as a
    // fleet capability, see 'template-contract suppliers only' below); it just does not pretend.
    assert.equal(kind('llm.chat.v1'), 'template');
  });
  test('a caller can force a route, and an unknown name is refused rather than crashing later', () => {
    assert.equal(routeFor('identity.history.report.v1', 'ocr').kind, 'ocr');
    assert.equal(routeFor('llm.text.generate.v1', 'template').kind, 'template');
    for (const bad of ['constructor', '__proto__', 'nope']) assert.throws(() => routeFor('x', bad as never), /Unknown route/, bad);
  });
});

describe('parseJobResponse', () => {
  test('202 is pending', () => {
    assert.deepEqual(parseJobResponse(202, '{"status":"running","escrow_ref":"e#0"}'), { state: 'pending', status: 'running' });
    assert.deepEqual(parseJobResponse(202, '{}'), { state: 'pending', status: 'accepted' });
    assert.deepEqual(parseJobResponse(202, 'not json'), { state: 'pending', status: 'accepted' });
  });
  test('200 carries result and receipt (the template shape)', () => {
    const p = parseJobResponse(200, JSON.stringify({ choices: [{ message: { content: 'out' } }], receipt: { a: 1 }, receipt_signature: 'ab', escrow_ref: 'e#0' }));
    assert.ok(p.state === 'done');
    assert.equal(p.result, 'out');
    assert.deepEqual(p.receipt, { a: 1 });
    assert.equal(p.receiptSignature, 'ab');
    assert.equal(p.submittedRef, null, 'the template does not send one');
  });
  test('200 from the fleet routes: the Responses text, the OCR content and the TTS audio are the result', () => {
    const receipt = { prompt_hash: 'aa', response_hash: 'bb' };
    const responses = parseJobResponse(200, JSON.stringify({
      id: 'resp_1', object: 'response', status: 'completed', receipt, receipt_signature: 'cd', submitted_ref: SUBMITTED_REF,
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello ', annotations: [] }, { type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'world' }] },
      ],
    }));
    const ocr = parseJobResponse(200, JSON.stringify({ kind: 'ocr', output_format: 'markdown', content: '# page', receipt, receipt_signature: 'cd', submitted_ref: SUBMITTED_REF }));
    const tts = parseJobResponse(200, JSON.stringify({ kind: 'tts', audio_b64: 'AAEC', format: 'mp3', receipt, receipt_signature: 'cd', submitted_ref: SUBMITTED_REF }));
    for (const [view, result] of [[responses, 'Hello world'], [ocr, '# page'], [tts, 'AAEC']] as const) {
      assert.ok(view.state === 'done');
      assert.equal(view.result, result);
      assert.deepEqual(view.receipt, receipt);
      assert.equal(view.receiptSignature, 'cd');
      assert.equal(view.submittedRef, SUBMITTED_REF);
    }
  });
  test('an empty result is a result, and an answer with a receipt in no known shape is kept whole', () => {
    const empty = parseJobResponse(200, JSON.stringify({ choices: [{ message: { content: '' } }], receipt: {}, receipt_signature: 'ab' }));
    assert.ok(empty.state === 'done');
    assert.equal(empty.result, '');
    const odd = parseJobResponse(200, '{"receipt":{},"receipt_signature":"ab","other":1}');
    assert.ok(odd.state === 'done');
    assert.equal(odd.result, '{"receipt":{},"receipt_signature":"ab","other":1}');
  });
  test('a 200 is a finished job only with a receipt object and a non-empty signature: any other object is a malformed answer', () => {
    const malformed = { state: 'failed', reason: 'malformed_response', message: 'The supplier answered 200 without a receipt object and a non-empty receipt_signature.' };
    const content = { choices: [{ message: { content: 'out' } }] };
    const answers: unknown[] = [
      {}, { other: 1 }, content, // no receipt, no signature
      { ...content, receipt: {} }, { ...content, receipt: { a: 1 } }, // no signature
      { ...content, receipt_signature: 'ab' }, // no receipt
      { ...content, receipt: null, receipt_signature: 'ab' }, { ...content, receipt: 'r', receipt_signature: 'ab' }, { ...content, receipt: 7, receipt_signature: 'ab' },
      { ...content, receipt: true, receipt_signature: 'ab' }, { ...content, receipt: [], receipt_signature: 'ab' }, { ...content, receipt: [{}], receipt_signature: 'ab' },
      { ...content, receipt: {}, receipt_signature: '' }, { ...content, receipt: {}, receipt_signature: null }, { ...content, receipt: {}, receipt_signature: 7 },
      { ...content, receipt: {}, receipt_signature: ['ab'] }, { ...content, receipt: {}, receipt_signature: {} },
    ];
    for (const answer of answers) assert.deepEqual(parseJobResponse(200, JSON.stringify(answer)), malformed, JSON.stringify(answer));
    // the smallest answer that is a finished job
    const smallest = parseJobResponse(200, '{"receipt":{},"receipt_signature":"x"}');
    assert.ok(smallest.state === 'done');
    assert.deepEqual(smallest.receipt, {});
    assert.equal(smallest.receiptSignature, 'x');
  });
  test('a submitted_ref is passed on only when it is a ref, and canonical', () => {
    const view = (submitted_ref: unknown) => {
      const v = parseJobResponse(200, JSON.stringify({ choices: [{ message: { content: 'x' } }], receipt: {}, receipt_signature: 'ab', submitted_ref }));
      assert.ok(v.state === 'done');
      return v.submittedRef;
    };
    assert.equal(view(SUBMITTED_REF), SUBMITTED_REF);
    assert.equal(view(` ${'EE'.repeat(32)}#0 `), SUBMITTED_REF);
    for (const bad of ['', 'ee#0', 'x\n## injected', 7, null, {}, `${'ee'.repeat(32)}#-1`]) assert.equal(view(bad), null, JSON.stringify(bad));
  });
  test('a 200 that is not a JSON object is a malformed answer, not a finished job', () => {
    for (const body of ['', '<html>ok</html>', '[]', 'null', '"done"', '7']) {
      assert.deepEqual(parseJobResponse(200, body), { state: 'failed', reason: 'malformed_response', message: 'The supplier answered 200 with something that is not a JSON object.' }, JSON.stringify(body));
    }
  });
  test('failed jobs surface the reason', () => {
    assert.deepEqual(parseJobResponse(502, '{"status":"failed","reason":"service_timeout","message":"m"}'), { state: 'failed', reason: 'service_timeout', message: 'm' });
    assert.deepEqual(parseJobResponse(404, '{"reason":"job_not_found","message":"no job found","error":{"reason":"job_not_found"}}'), { state: 'failed', reason: 'job_not_found', message: 'no job found' });
  });
  test('without a reason or a message the status stands in, and the body of the answer is not repeated', () => {
    assert.deepEqual(parseJobResponse(503, 'upstream down'), { state: 'failed', reason: 'http_503', message: '' });
    assert.deepEqual(parseJobResponse(500, `<html>${'x'.repeat(300)}`), { state: 'failed', reason: 'http_500', message: '' });
    assert.deepEqual(parseJobResponse(500, '{"reason":"boom","detail":"password=hunter2"}'), { state: 'failed', reason: 'boom', message: '' });
    assert.deepEqual(parseJobResponse(500, '{"reason":7,"message":{"a":1}}'), { state: 'failed', reason: 'http_500', message: '' });
    assert.deepEqual(parseJobResponse(204, ''), { state: 'failed', reason: 'http_204', message: '' });
  });
  test('what a supplier says about a failure, or as its status, is bounded', () => {
    const v = parseJobResponse(500, JSON.stringify({ reason: 'r'.repeat(500), message: 'm'.repeat(5000) }));
    assert.ok(v.state === 'failed');
    assert.equal(v.reason.length, 100);
    assert.equal(v.message.length, 500);
    assert.deepEqual(parseJobResponse(202, JSON.stringify({ status: 's'.repeat(300) })), { state: 'pending', status: 's'.repeat(100) });
  });
});

// ─── the world sendJob and getJob run in ─────────────────────────────────────────────────────────────────────────────────────────
type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Answer = Response | Promise<Response>;
const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const accepted = (over: Record<string, unknown> = {}) => reply(202, { job_id: JOB_ID, status: 'accepted', escrow_ref: ESCROW_REF, ...over });

/** A fake supplier: records every request it is sent and answers with `answer` (the init safeFetch gave the request comes second). */
function supplier(answer: (call: Call, init: RequestInit) => Answer = () => accepted()) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call: Call = { url: String(url), method: String(init?.method ?? 'GET'), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    return answer(call, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** The wallet the escrows of these tests were posted from: a base address, so the buyer key is the payment part of it. */
const BUYER_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
const POSTED_BASE: EscrowDatum = { ...decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), buyer_pkh: BUYER_PKH };
const ADVERT_TX = ADVERT_REF.slice(0, 64);
const FUNDING_INPUT = `${'ac'.repeat(32)}#0`;
/** The inputs of the Post transaction, as Koios tx_info lists them, for the funders that have any. */
const POST_INPUTS: Record<string, SpentOutputs | undefined> = {
  buyer: [[FUNDING_INPUT, OWN_ADDRESS]],
  stranger: [[FUNDING_INPUT, SUPPLIER_ADDRESS]],
  'stranger-and-buyer': [[FUNDING_INPUT, SUPPLIER_ADDRESS], [`${'ad'.repeat(32)}#1`, OWN_ADDRESS]],
};
const MAY_HAVE_CLAIMED = ' It may have claimed the escrow anyway, so check its state before sending again; if it stays Open, reclaim it after deliver_by.';
/** The live advert with the capability, the endpoint or the status changed, re-encoded. */
function advertDatum(over: { capability_id?: string; endpoint_url?: string; status?: 'Active' | 'Retired' }): string {
  const c = Data.from(ADVERT_DATUM_HEX) as Constr<Data>;
  if (over.capability_id !== undefined) c.fields[1] = fromText(over.capability_id);
  if (over.endpoint_url !== undefined) c.fields[8] = fromText(over.endpoint_url);
  if (over.status === 'Retired') c.fields[12] = new Constr(1, []);
  return Data.to(c);
}

interface Scenario {
  capability?: string; endpoint?: string; escrow?: 'open' | 'claimed' | 'submitted' | 'finished';
  /**
   * The ref the caller names: the Post output (default), the output the Claim made (a later output of the same escrow; needs
   * escrow: 'claimed'), or an output in the Accepted state, which is all there is of the escrow on the chain.
   */
  names?: 'post' | 'claimed-output' | 'accepted-output';
  /** A copy of the escrow's fields left at the escrow credential by a transaction that spent no escrow output, besides the escrow's own outputs. */
  decoy?: boolean;
  /** The payload the escrow commits to, as its prompt_hash (default PAYLOAD). */
  committed?: string;
  /**
   * Who funded the Post transaction, as Koios tx_info reports its inputs: the buyer (default), a stranger only, a stranger and the
   * buyer, nobody Koios knows (the transaction is unknown to it), or Koios failing to answer ('koios-error' needs escrow: 'open'
   * because every tx_info call fails; 'unreachable' fails only the question about the Post transaction).
   */
  funder?: 'buyer' | 'stranger' | 'stranger-and-buyer' | 'unknown' | 'koios-error' | 'unreachable';
  advert?: { status?: 'Active' | 'Retired'; spent?: boolean; spentUnreported?: boolean; address?: string; missing?: boolean; httpStatus?: number; unreachable?: boolean };
  answer?: (call: Call, init: RequestInit) => Answer;
}
/**
 * One escrow (Open, Claimed, Submitted, or finished with nothing left on the chain), posted from OWN_ADDRESS with the prompt hash of
 * its payload, its advert, and a supplier. The node and Koios are built from one list of UTxOs (`world`); the advert read is answered
 * on top of Koios (and counted, with the URL it went to); whatever else is fetched is the supplier.
 */
function scenario(o: Scenario = {}) {
  const capability = o.capability ?? 'identity.history.report.v1';
  const posted: EscrowDatum = { ...POSTED_BASE, capability_id: capability, prompt_hash: promptHashForPayload(o.committed ?? PAYLOAD) };
  const claimed: EscrowDatum = { ...posted, state: 'Claimed' };
  const submitted: EscrowDatum = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
  const state = o.escrow ?? 'open';
  const accepted: EscrowDatum = { ...posted, state: 'Accepted' };
  const own: UTxO[] = o.names === 'accepted-output'
    ? [escrowAt(CLAIM_TX, accepted)]
    : { open: [escrowAt(ESCROW_TX, posted)], claimed: [escrowAt(CLAIM_TX, claimed)], submitted: [escrowAt(SUBMIT_TX, submitted)], finished: [] }[state];
  const chain: UTxO[] = [...own, ...(o.decoy ? [escrowAt(DECOY_TX, claimed)] : [])];
  const funder = o.funder ?? 'buyer';
  const postInputs = POST_INPUTS[funder]; // undefined: Koios does not know the Post transaction
  const koiosOptions = { txs: { ...GENUINE_TXS, ...(o.decoy ? DECOY_TXS : {}), ...(postInputs ? { [ESCROW_TX]: postInputs } : {}) }, ...(funder === 'koios-error' ? { txStatus: 502 } : {}) };
  const laterOutputRow = (datum: EscrowDatum) => ({ tx_hash: CLAIM_TX, tx_index: 0, address: ESCROW_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), is_spent: false, inline_datum: { bytes: encodeEscrowDatum(datum) } });
  const w = o.names === 'claimed-output' ? world(chain, { ...koiosOptions, rows: [laterOutputRow(claimed)] })
    : o.names === 'accepted-output' ? world(chain, { ...koiosOptions, rows: [laterOutputRow(accepted)] })
    : world(chain, { ...koiosOptions, datumHex: encodeEscrowDatum(posted), spent: state !== 'open' });
  const advert = o.advert ?? {};
  const advertRow: Record<string, unknown> = {
    tx_hash: ADVERT_TX, tx_index: 0, address: advert.address ?? ADVERT_ADDRESS, value: '2000000', is_spent: advert.spent ?? false,
    inline_datum: { bytes: advertDatum({ capability_id: capability, endpoint_url: o.endpoint ?? SUPPLIER, status: advert.status }) },
  };
  if (advert.spentUnreported) delete advertRow.is_spent; // Koios leaves the field out when it does not know
  const sup = supplier(o.answer);
  const advertUrls: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const u = String(url);
    if (u.endsWith('/api/v1/utxo_info') && (JSON.parse(init.body)._utxo_refs as string[]).includes(ADVERT_REF)) {
      advertUrls.push(u);
      if (advert.unreachable) throw new TypeError('fetch failed: connect ECONNREFUSED internal.koios.example:443 password=hunter2');
      if (advert.httpStatus) return new Response(HOSTILE, { status: advert.httpStatus });
      return new Response(JSON.stringify(advert.missing ? [] : [advertRow]), { status: 200 });
    }
    if (u.endsWith('/api/v1/tx_info') && funder === 'unreachable' && (JSON.parse(init.body)._tx_hashes as string[]).includes(ESCROW_TX)) {
      throw new TypeError('fetch failed: connect ECONNREFUSED internal.koios.example:443 password=hunter2');
    }
    if (u.includes('/api/v1/')) return w.koios.f(url, init);
    return sup.f(url, init as RequestInit);
  }) as unknown as typeof fetch;
  const named = o.names === 'claimed-output' || o.names === 'accepted-output' ? `${CLAIM_TX}#0` : ESCROW_REF;
  return {
    sup, koios: w.koios, posted, named, advertUrls: () => advertUrls, advertReads: () => advertUrls.length,
    /** The tx_info questions asked about the Post transaction (who funded it). */
    fundingChecks: () => w.koios.calls.filter((c) => c.path === '/api/v1/tx_info' && (c.body._tx_hashes as string[]).includes(ESCROW_TX)).map((c) => c.body),
    send: (over: Partial<Parameters<typeof sendJob>[2]> = {}) => sendJob(w.node, KOIOS, { escrowRef: named, payload: PAYLOAD, buyerAddress: OWN_ADDRESS, ...over }, fetchImpl),
    poll: (over: Partial<Parameters<typeof getJob>[1]> = {}) => getJob(KOIOS, { escrowRef: named, jobId: JOB_ID, buyerAddress: OWN_ADDRESS, ...over }, fetchImpl),
  };
}

/** The promise rejects with an Error whose message `check` accepts. */
const rejectsWith = (run: Promise<unknown>, check: (message: string) => void) => assert.rejects(run, (err: unknown) => { assert.ok(err instanceof Error, String(err)); check(err.message); return true; });
/** An error from this module names the escrow and never the endpoint, a Koios error body or the hostile text behind it. */
const cleanOf = (message: string) => {
  assert.ok(message.includes(ESCROW_REF), `the escrow ref is missing from: ${message}`);
  for (const secret of ['203.0.113.7', '203.0.113.99', '169.254.169.254', '192.168.1.10', 'evil.example', 'hunter2', 'internal.koios.example', 'not a url', 'user:pw', 'Bad gateway']) assert.ok(!message.includes(secret), `${secret} leaked into: ${message}`);
};
const FLEET_CAPABILITIES = ['llm.text.generate.v1', 'ocr.page.extract.chandra-ocr-2.v1', 'audio.synthesize.piper.v1'];
/** What is out of scope in this release: the capabilities the fleet serves on a route, and the multi-turn session capability. */
const OUT_OF_SCOPE = [...FLEET_CAPABILITIES, 'llm.chat.v1', 'llm.chat.v2'];
const NOT_A_BUYER = 'buyerAddress must be the wallet address (a key address) the escrow was posted from.';

describe('sendJob', () => {
  test('sends the job to the advert endpoint over the template contract and returns the job id', async () => {
    const s = scenario();
    const r = await s.send();
    assert.deepEqual(r, { jobId: JOB_ID, status: 'accepted', route: 'template', endpoint: SUPPLIER, capabilityId: 'identity.history.report.v1' });
    assert.equal(s.sup.calls.length, 1);
    const call = s.sup.calls[0];
    assert.equal(call.url, `${SUPPLIER}/v1/job`);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.headers, { 'content-type': 'application/json', accept: 'application/json' });
    const sent = JSON.parse(call.body);
    assert.deepEqual(Object.keys(sent).sort(), ['escrow_ref', 'payload']);
    assert.equal(sent.escrow_ref, ESCROW_REF);
    // the hash the template computes over the bytes it receives is the hash this escrow committed
    assert.equal(sent.payload, wirePayloadFor(PAYLOAD));
    assert.equal(sha256(sent.payload), s.posted.prompt_hash);
    // one decision draws on one Koios: the escrow, who funded it and the advert are all asked of the Koios the caller named
    assert.ok(s.koios.calls.length > 0 && s.koios.calls.every((c) => c.url?.startsWith(`${KOIOS}/api/v1/`)), JSON.stringify(s.koios.calls.map((c) => c.url)));
    assert.deepEqual(s.advertUrls(), [`${KOIOS}/api/v1/utxo_info`]);
    // and who funded the escrow was asked of the transaction that posted it, inputs included
    assert.deepEqual(s.fundingChecks(), [{ _tx_hashes: [ESCROW_TX], _inputs: true, _assets: true }]);
  });
  test('the escrow named in the request is the canonical ref, whatever case or spacing the caller used', async () => {
    const s = scenario();
    await s.send({ escrowRef: ` ${ESCROW_REF.toUpperCase()}` });
    assert.equal(JSON.parse(s.sup.calls[0].body).escrow_ref, ESCROW_REF);
  });
  test('only the headers of the route are sent: nothing the caller passes becomes a header', async () => {
    const s = scenario();
    await s.send({ ...({ headers: { authorization: 'Bearer x', 'x-evil': '1' } } as object) });
    assert.deepEqual(Object.keys(s.sup.calls[0].headers).sort(), ['accept', 'content-type']);
  });
  test('keeps the status the supplier reports and defaults to accepted', async () => {
    assert.equal((await scenario({ answer: () => accepted({ status: 'running' }) }).send()).status, 'running');
    assert.equal((await scenario({ answer: () => accepted({ status: 's'.repeat(300) }) }).send()).status, 's'.repeat(100));
    assert.equal((await scenario({ answer: () => reply(202, { job_id: JOB_ID }) }).send()).status, 'accepted');
  });

  // The escrow is the buyer's, and the buyer is the key that funded it: the datum names a buyer, but anyone can copy the datum of a
  // real escrow into an escrow of their own, with an advert on a host of their own. Only a transaction the buyer's key took part in
  // (an input needs its owner's signature) proves the buyer put funds into this escrow.
  describe('only the buyer, who funded the escrow, sends', () => {
    test('the buyer is a key: a base address and an enterprise address of that key are the same buyer', async () => {
      for (const buyerAddress of [OWN_ADDRESS, enterpriseAddressOf(BUYER_PKH)]) {
        const s = scenario();
        assert.equal((await s.send({ buyerAddress })).jobId, JOB_ID, buyerAddress);
      }
    });
    test('an escrow whose datum names someone else is refused, naming the address, before the funder is asked, the advert is read or anything reaches the supplier', async () => {
      const s = scenario();
      await rejectsWith(s.send({ buyerAddress: SUPPLIER_ADDRESS }), (message) => {
        cleanOf(message);
        assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: it was not posted by ${SUPPLIER_ADDRESS}. Nothing was sent.`);
      });
      assert.equal(s.fundingChecks().length, 0);
      assert.equal(s.advertReads(), 0);
      assert.equal(s.sup.calls.length, 0);
    });
    test('an address that is no wallet key address is no buyer, and nothing is asked of anyone', async () => {
      for (const buyerAddress of [ESCROW_ADDRESS, 'not-an-address', '', undefined, null, 7]) {
        const s = scenario();
        await rejectsWith(s.send({ buyerAddress: buyerAddress as never }), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: ${NOT_A_BUYER} Nothing was sent.`);
        });
        assert.equal(s.koios.calls.length, 0, String(buyerAddress));
        assert.equal(s.sup.calls.length, 0, String(buyerAddress));
      }
    });
    test('a copy of a real escrow\'s buyer and prompt hash, in a Post the buyer did not fund and with an advert on the attacker\'s host, is refused and nothing reaches the attacker', async () => {
      // same datum fields as the real escrow (buyer_pkh and prompt_hash are public), a Post transaction with nothing of the buyer's in it,
      // and an advert whose endpoint is the attacker's: every check on the datum passes, the one on the transaction does not
      const s = scenario({ funder: 'stranger', endpoint: 'https://203.0.113.99' });
      await rejectsWith(s.send(), (message) => {
        cleanOf(message);
        assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: the transaction that posted it has no input from ${OWN_ADDRESS}, so that wallet did not fund it. Nothing was sent.`);
      });
      assert.equal(s.sup.calls.length, 0);
      assert.equal(s.advertReads(), 0, 'refused before the attacker\'s advert is even read');
      assert.deepEqual(s.fundingChecks(), [{ _tx_hashes: [ESCROW_TX], _inputs: true, _assets: true }]);
    });
    test('a Post that has an input of the buyer among others was funded by the buyer', async () => {
      const s = scenario({ funder: 'stranger-and-buyer' });
      assert.equal((await s.send()).jobId, JOB_ID);
    });
    test('a Post transaction Koios does not know is a refusal: no proof of who funded it, no job', async () => {
      const s = scenario({ funder: 'unknown' });
      await rejectsWith(s.send(), (message) => {
        cleanOf(message);
        assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: could not check who funded it (Koios tx_info: transaction not found). Nothing was sent.`);
      });
      assert.equal(s.sup.calls.length, 0);
      assert.equal(s.advertReads(), 0);
    });
    test('a Koios that cannot be asked who funded it is a refusal, with its status and none of what it said', async () => {
      for (const [funder, expected] of [['koios-error', 'Koios tx_info answered 502'], ['unreachable', 'Koios request failed (network error or timeout)']] as const) {
        const s = scenario({ funder });
        await rejectsWith(s.send(), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: could not check who funded it (${expected}). Nothing was sent.`);
        });
        assert.equal(s.sup.calls.length, 0, funder);
        assert.equal(s.advertReads(), 0, funder);
      }
    });
    test('a ref that names a later output of the escrow is refused: its transaction is the supplier\'s, the buyer funded the Post', async () => {
      const s = scenario({ escrow: 'claimed', names: 'claimed-output' });
      await rejectsWith(s.send(), (message) => {
        assert.equal(message, `Cannot send a job for escrow ${CLAIM_TX}#0: it is a Claimed output, not the output its Post made: use the escrow ref the Post returned. Nothing was sent.`);
      });
      assert.equal(s.fundingChecks().length, 0);
      assert.equal(s.sup.calls.length, 0);
    });
    test('the refusal names the state of that output with the right article: "an Accepted output", "a Claimed output"', async () => {
      const s = scenario({ names: 'accepted-output' });
      await rejectsWith(s.send(), (message) => {
        assert.equal(message, `Cannot send a job for escrow ${CLAIM_TX}#0: it is an Accepted output, not the output its Post made: use the escrow ref the Post returned. Nothing was sent.`);
      });
      assert.equal(s.fundingChecks().length, 0);
      assert.equal(s.sup.calls.length, 0);
    });
  });

  // The payload is the buyer's too: the escrow committed to exactly one.
  describe('only the payload the escrow committed to is sent', () => {
    test('any other payload is refused, whatever the difference, before anything reaches the supplier', async () => {
      for (const payload of ['summarise the filing.', 'Summarise the filing', ' summarise the filing', 'summarise the filing\n', 'summarise  the filing', 'something else entirely']) {
        const s = scenario();
        await rejectsWith(s.send({ payload }), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: the payload does not match the escrow's prompt_hash: it must be exactly the payload the escrow was posted with. Nothing was sent.`);
        });
        assert.equal(s.sup.calls.length, 0, JSON.stringify(payload));
      }
    });
    test('an escrow posted with another payload takes that payload and no other', async () => {
      const s = scenario({ committed: 'the other payload' });
      await rejectsWith(s.send(), (message) => assert.match(message, /the payload does not match the escrow's prompt_hash/));
      assert.equal(s.sup.calls.length, 0);
      await s.send({ payload: 'the other payload' });
      assert.equal(JSON.parse(s.sup.calls[0].body).payload, wirePayloadFor('the other payload'));
    });
    test('the hash is the one a buyer commits: promptHashForPayload of the payload, the hash of its canonical message array', async () => {
      const payload = '{"records":[1,2,3],"note":"café"}';
      const s = scenario({ committed: payload });
      assert.equal(s.posted.prompt_hash, sha256(wirePayloadFor(payload)));
      assert.equal((await s.send({ payload })).jobId, JOB_ID);
    });
  });

  // This release serves template-contract suppliers only. The route table keeps the fleet routes (tested above); nothing reaches them.
  describe('template-contract suppliers only', () => {
    for (const capability of OUT_OF_SCOPE) {
      test(`${capability} is a fleet capability and is refused, before anything reaches the supplier`, async () => {
        const s = scenario({ capability });
        await rejectsWith(s.send(), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: ${capability} uses the fleet route; this tool supports template-contract suppliers only in this release. Nothing was sent.`);
        });
        assert.equal(s.sup.calls.length, 0);
        // forcing the template route does not make a fleet supplier a template one
        await rejectsWith(s.send({ route: 'template' }), (message) => assert.match(message, /uses the fleet route; this tool supports template-contract suppliers only in this release/));
        assert.equal(s.sup.calls.length, 0);
      });
    }
    test('only the families the fleet serves are out of scope: a neighbouring capability is a template supplier', async () => {
      for (const capability of ['llm.embed.v1', 'ocr.table.extract.v1', 'audio.transcribe.whisper.v1', 'llm', 'llm.chatter.v1']) {
        const s = scenario({ capability });
        assert.equal((await s.send()).capabilityId, capability, capability);
      }
    });
    test('what an advert calls its capability cannot break the line the refusal is shown on', async () => {
      const s = scenario({ capability: 'ocr.page.extract.evil | cap\n## injected `x`' });
      await rejectsWith(s.send(), (message) => { assert.ok(!/[\n|`]/.test(message), message); assert.match(message, /ocr\.page\.extract\.evil ¦ cap ## injected 'x' uses the fleet route/); });
    });
    test('a fleet route the caller forces is refused before anything at all is asked; the template route may be named', async () => {
      for (const route of ['chat', 'ocr', 'tts'] as const) {
        const s = scenario();
        await rejectsWith(s.send({ route }), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot send a job for escrow ${ESCROW_REF}: the ${route} route is a fleet route; this tool supports template-contract suppliers only in this release. Nothing was sent.`);
        });
        assert.equal(s.koios.calls.length, 0, route);
        assert.equal(s.sup.calls.length, 0, route);
      }
      const t = scenario();
      assert.equal((await t.send({ route: 'template' })).route, 'template');
    });
    test('a route that is no route at all is refused as such, before anything is asked', async () => {
      const s = scenario();
      await assert.rejects(s.send({ route: 'nope' as never }), /Unknown route "nope"/);
      assert.equal(s.koios.calls.length, 0);
    });
  });

  // Nothing is sent to a supplier unless the escrow is live and Open and its advert is live, Active and on an https endpoint.
  const refusals: Array<[name: string, o: Scenario, expected: RegExp]> = [
    ['an escrow the supplier has already claimed', { escrow: 'claimed' }, /it is Claimed and a job can only be sent while it is Open\. Nothing was sent\.$/],
    ['an escrow that is already submitted', { escrow: 'submitted' }, /it is Submitted and a job can only be sent while it is Open/],
    ['an escrow with no live output', { escrow: 'finished' }, /no live output was found for it .*Nothing was sent\.$/],
    ['a retired advert', { advert: { status: 'Retired' } }, new RegExp(`its advert ${ADVERT_REF} is Retired\\. Nothing was sent\\.$`)],
    ['a spent advert', { advert: { spent: true } }, new RegExp(`its advert ${ADVERT_REF} has been spent \\(its supplier retired or replaced it\\)\\. Nothing was sent\\.$`)],
    ['an advert whose spent status Koios does not report', { advert: { spentUnreported: true } }, new RegExp(`Koios did not report whether its advert ${ADVERT_REF} is spent\\. Nothing was sent\\.$`)],
    ['an endpoint that is plain http', { endpoint: 'http://203.0.113.7' }, new RegExp(`the endpoint of its advert ${ADVERT_REF} is not an https URL\\. Nothing was sent\\.$`)],
    ['an endpoint that is no URL at all', { endpoint: 'not a url' }, /is not an https URL/],
    ['an advert UTxO at the wrong address', { advert: { address: 'addr1' + 'q'.repeat(54) } }, /is not at the advert script address\. Nothing was sent\.$/],
    ['an advert the ledger does not know', { advert: { missing: true } }, /No UTxO at .* Nothing was sent\.$/],
    ['an advert Koios cannot be asked about', { advert: { httpStatus: 502 } }, new RegExp(`its advert ${ADVERT_REF} could not be read \\(Koios utxo_info answered 502\\)\\. Nothing was sent\\.$`)],
    ['an advert read that fails on the network', { advert: { unreachable: true } }, new RegExp(`its advert ${ADVERT_REF} could not be read \\(Koios request failed \\(network error or timeout\\)\\)\\. Nothing was sent\\.$`)],
  ];
  for (const [name, o, expected] of refusals) {
    test(`refuses ${name}, before anything reaches the supplier`, async () => {
      const s = scenario(o);
      await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /^Cannot send a job for escrow /); assert.match(message, expected); });
      assert.equal(s.sup.calls.length, 0);
    });
  }
  // The advert is where the payload would go. The escrow must be live and Open before the advert is so much as read, so a send
  // for an escrow that is Claimed, Submitted or finished never asks the ledger about its advert, and a live Open one asks once.
  test('the escrow must be live and Open before its advert is read: otherwise the advert is never asked for', async () => {
    for (const escrow of ['claimed', 'submitted', 'finished'] as const) {
      const s = scenario({ escrow });
      await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /^Cannot send a job for escrow .* Nothing was sent\.$/); });
      assert.equal(s.advertReads(), 0, `${escrow}: the advert was read`);
      assert.equal(s.sup.calls.length, 0, escrow);
    }
    const open = scenario();
    await open.send();
    assert.equal(open.advertReads(), 1, 'an Open escrow reads its advert once');
  });
  test('refuses an empty payload before asking anything, and a request over 1,000,000 bytes before it reaches the supplier', async () => {
    const s = scenario();
    await rejectsWith(s.send({ payload: '' }), (message) => { cleanOf(message); assert.match(message, /the payload must be a non-empty string\. Nothing was sent\.$/); });
    assert.equal(s.koios.calls.length, 0, 'not even Koios was asked');
    // The request is the body that goes on the wire, which wraps the payload: build payloads that make it exactly the limit and one over.
    const wrapping = Buffer.byteLength(ROUTES.template.body(ESCROW_REF, '').body);
    const atLimit = 'x'.repeat(1_000_000 - wrapping);
    const full = scenario({ committed: atLimit });
    await full.send({ payload: atLimit });
    assert.equal(full.sup.calls[0].body.length, 1_000_000);
    const over = `${atLimit}x`;
    const tooBig = scenario({ committed: over });
    await rejectsWith(tooBig.send({ payload: over }), (message) => { cleanOf(message); assert.match(message, /the request is 1000001 bytes, over the 1000000 byte limit\. Nothing was sent\.$/); });
    assert.equal(tooBig.sup.calls.length, 0);
  });
  test('a lineage the resolver refuses is the refusal, with its words and none of what Koios said', async () => {
    const failing = world([], { status: 502 });
    await rejectsWith(sendJob(failing.node, KOIOS, { escrowRef: ESCROW_REF, payload: PAYLOAD, buyerAddress: OWN_ADDRESS }, failing.koios.f), (message) => {
      cleanOf(message);
      assert.equal(message, `Could not read escrow ${ESCROW_REF}: Koios utxo_info answered 502`);
    });
  });

  describe('what the supplier answers', () => {
    test('a refusal is reported with its status, its reason and its message, and no job id', async () => {
      const s = scenario({ answer: () => reply(409, { reason: 'prompt_mismatch', message: 'prompt_hash in escrow does not match request body payload' }) });
      await rejectsWith(s.send(), (message) => {
        cleanOf(message);
        assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier answered 409 (prompt_mismatch): prompt_hash in escrow does not match request body payload.`);
      });
    });
    test('a 4xx turned the job down before anything was claimed and says nothing about a claim; any other status may have come after one', async () => {
      for (const status of [400, 403, 404, 408, 409, 413, 429, 499]) {
        await rejectsWith(scenario({ answer: () => reply(status, { reason: 'refused', message: 'no' }) }).send(), (message) => {
          assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier answered ${status} (refused): no.`);
        });
      }
      for (const status of [200, 500, 502, 503, 504, 599]) {
        await rejectsWith(scenario({ answer: () => reply(status, { reason: 'refused', message: 'no' }) }).send(), (message) => {
          assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier answered ${status} (refused): no.${MAY_HAVE_CLAIMED}`);
        });
      }
    });
    test('the template\'s own 504 claim_timeout may have come after the claim, and says so', async () => {
      const s = scenario({ answer: () => reply(504, { reason: 'claim_timeout', message: 'Claim awaitTx failed: timed out', error: { reason: 'claim_timeout' } }) });
      await rejectsWith(s.send(), (message) => {
        cleanOf(message);
        assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier answered 504 (claim_timeout): Claim awaitTx failed: timed out.${MAY_HAVE_CLAIMED}`);
      });
    });
    test('a proxy\'s page is reported by the status alone: the body of an answer is not repeated', async () => {
      const s = scenario({ answer: () => reply(502, '<html>Bad gateway' + 'x'.repeat(500)) });
      await rejectsWith(s.send(), (message) => {
        cleanOf(message);
        assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier answered 502 (http_502).${MAY_HAVE_CLAIMED}`);
      });
    });
    test('a JSON answer without a message string gives its reason and nothing else of its body', async () => {
      for (const body of [{ reason: 'boom', detail: 'password=hunter2', trace: 'at /srv/app.js:1' }, { reason: 'boom', message: { text: 'password=hunter2' } }, { reason: 'boom', message: 7 }]) {
        await rejectsWith(scenario({ answer: () => reply(500, body) }).send(), (message) => {
          cleanOf(message);
          assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier answered 500 (boom).${MAY_HAVE_CLAIMED}`);
        });
      }
    });
    test('what a supplier writes cannot break the line the error is shown on', async () => {
      const s = scenario({ answer: () => reply(500, { reason: 'bad | reason', message: 'line one\n## injected `x`' }) });
      await rejectsWith(s.send(), (message) => { assert.ok(!/[\n|`]/.test(message), message); assert.match(message, /bad ¦ reason.*line one ## injected 'x'/); });
    });
    test('202 without a usable job id is not a started job, and the supplier did claim the escrow', async () => {
      for (const body of [{ status: 'accepted' }, { job_id: '' }, { job_id: 7 }, { job_id: null }, '', 'not json']) {
        const s = scenario({ answer: () => reply(202, body) });
        await rejectsWith(s.send(), (message) => {
          cleanOf(message);
          assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier answered 202 but returned no usable job id.${MAY_HAVE_CLAIMED}`);
        });
      }
    });
    test('a job id that is not a plain token is refused: it will be put in a URL and in a line of markdown', async () => {
      for (const job_id of ['../../capability', 'a b', 'x\n## injected', 'a?b=1', 'a#b', 'a/b', 'é', 'x'.repeat(129)]) {
        const s = scenario({ answer: () => accepted({ job_id }) });
        await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /returned no usable job id/); });
      }
      assert.equal((await scenario({ answer: () => accepted({ job_id: 'x'.repeat(128) }) }).send()).jobId, 'x'.repeat(128));
    });
    test('a redirect is not followed, its target is not repeated, and it claimed nothing', async () => {
      const s = scenario({ answer: () => new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }) });
      await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /the supplier answered with a redirect, which is not followed\.$/); });
      assert.equal(s.sup.calls.length, 1);
    });
    test('an endpoint on a private or reserved address is refused by the rule, and nothing is fetched from it', async () => {
      for (const endpoint of ['https://169.254.169.254/latest', 'https://10.0.0.5', 'https://127.0.0.1:8443']) {
        const s = scenario({ endpoint });
        await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /the supplier host resolves to a private or reserved address, which is refused\.$/, endpoint); });
        assert.equal(s.sup.calls.length, 0, endpoint);
      }
    });
    test('an endpoint with credentials in it is refused by the outbound-call policy, and they are not repeated', async () => {
      const s = scenario({ endpoint: 'https://user:pw@203.0.113.7' });
      await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /the supplier URL was refused by the outbound-call policy\.$/); });
      assert.equal(s.sup.calls.length, 0);
    });
    test('a connection that drops is reported without what the network said, and may have come after the claim', async () => {
      const s = scenario({ answer: () => { throw new TypeError('fetch failed: connect ECONNRESET 203.0.113.7:443 (evil.example)'); } });
      await rejectsWith(s.send(), (message) => {
        cleanOf(message);
        assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the request to the supplier failed (network error).${MAY_HAVE_CLAIMED}`);
      });
    });
    test('reads at most 1,000,000 bytes of an answer: exactly that many are read, one more is refused (and the supplier had answered)', async () => {
      const overhead = Buffer.byteLength(JSON.stringify({ job_id: JOB_ID, status: 'accepted', pad: '' }));
      const sized = (bytes: number) => reply(202, JSON.stringify({ job_id: JOB_ID, status: 'accepted', pad: 'x'.repeat(bytes - overhead) }));
      assert.equal((await scenario({ answer: () => sized(1_000_000) }).send()).jobId, JOB_ID);
      await rejectsWith(scenario({ answer: () => sized(1_000_001) }).send(), (message) => {
        cleanOf(message);
        assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier's answer is over the 1000000 byte limit.${MAY_HAVE_CLAIMED}`);
      });
    });
  });
});

describe('getJob', () => {
  const done = { choices: [{ message: { content: 'the output' } }], receipt: { response_hash: 'bb' }, receipt_signature: 'cd', escrow_ref: ESCROW_REF };
  test('polls the job at the poll route of the template and reads the finished job', async () => {
    const s = scenario({ escrow: 'submitted', answer: () => reply(200, done) });
    const r = await s.poll();
    assert.ok(r.view.state === 'done');
    assert.equal(r.view.result, 'the output');
    assert.deepEqual(r.view.receipt, { response_hash: 'bb' });
    assert.equal(r.view.receiptSignature, 'cd');
    assert.equal(r.route, 'template');
    assert.equal(r.endpoint, SUPPLIER);
    assert.equal(r.supplierPkh, ADVERT_EXPECTED.supplier_pkh);
    assert.equal(r.capabilityId, 'identity.history.report.v1');
    assert.equal(s.sup.calls.length, 1);
    assert.deepEqual(s.sup.calls[0], { url: `${SUPPLIER}/v1/job/${JOB_ID}`, method: 'GET', headers: { accept: 'application/json' }, body: '' });
    // one decision draws on one Koios here too
    assert.ok(s.koios.calls.every((c) => c.url?.startsWith(`${KOIOS}/api/v1/`)), JSON.stringify(s.koios.calls.map((c) => c.url)));
    assert.deepEqual(s.advertUrls(), [`${KOIOS}/api/v1/utxo_info`]);
    assert.equal(s.fundingChecks().length, 1);
  });
  test('a job that failed is the failed view', async () => {
    const s = scenario({ escrow: 'claimed', answer: () => reply(502, { status: 'failed', reason: 'service_timeout', message: 'the service did not answer' }) });
    assert.deepEqual((await s.poll()).view, { state: 'failed', reason: 'service_timeout', message: 'the service did not answer' });
  });
  test('works while the escrow is Open (the supplier may not have claimed it yet), Claimed or Submitted', async () => {
    for (const escrow of ['open', 'claimed', 'submitted'] as const) {
      const s = scenario({ escrow, answer: () => reply(404, { reason: 'job_not_found', message: 'no job' }) });
      assert.equal((await s.poll()).view.state, 'failed', escrow);
      assert.equal(s.sup.calls.length, 1, escrow);
    }
  });
  test('the submitted_ref a supplier reports comes with a finished job, for the verification that follows', async () => {
    const s = scenario({ escrow: 'submitted', answer: () => reply(200, { ...done, submitted_ref: SUBMITTED_REF }) });
    const r = await s.poll();
    assert.ok(r.view.state === 'done');
    assert.equal(r.view.submittedRef, SUBMITTED_REF);
  });
  test('a 200 without a receipt and a signature is a malformed answer, not a finished job', async () => {
    for (const body of [{ choices: [{ message: { content: 'out' } }], escrow_ref: ESCROW_REF }, { ...done, receipt: null }, { ...done, receipt_signature: '' }]) {
      const s = scenario({ escrow: 'claimed', answer: () => reply(200, body) });
      assert.deepEqual((await s.poll()).view, { state: 'failed', reason: 'malformed_response', message: 'The supplier answered 200 without a receipt object and a non-empty receipt_signature.' }, JSON.stringify(body));
    }
  });

  // A poll asks for a job the supplier already has, so it resolves the endpoint from the advert whatever the advert's state is now:
  // only a send needs a live, Active advert.
  test('polls through an advert that has since been retired or spent, or whose spent status Koios does not report', async () => {
    const adverts: Array<NonNullable<Scenario['advert']>> = [{ status: 'Retired' }, { spent: true }, { spentUnreported: true }, { status: 'Retired', spent: true }];
    for (const advert of adverts) {
      const s = scenario({ escrow: 'claimed', advert, answer: () => reply(202, { status: 'running' }) });
      assert.deepEqual((await s.poll()).view, { state: 'pending', status: 'running' }, JSON.stringify(advert));
      assert.equal(s.sup.calls[0].url, `${SUPPLIER}/v1/job/${JOB_ID}`, JSON.stringify(advert));
    }
  });
  // A finished job must be fetchable after Accept or Release: with nothing left on the chain, the Post output alone (spent, and still
  // readable) names the buyer, the funder and the advert. Settlement opens no door: all of that is still proven.
  describe('after the escrow is settled', () => {
    test('a finished job is fetched, the Post output alone naming the buyer and the advert', async () => {
      const s = scenario({ escrow: 'finished', answer: () => reply(200, done) });
      const r = await s.poll();
      assert.ok(r.view.state === 'done');
      assert.equal(r.view.result, 'the output');
      assert.equal(r.endpoint, SUPPLIER);
      assert.equal(s.sup.calls[0].url, `${SUPPLIER}/v1/job/${JOB_ID}`);
    });
    test('another wallet, and a copy of the escrow the buyer did not fund, are refused all the same', async () => {
      await rejectsWith(scenario({ escrow: 'finished' }).poll({ buyerAddress: SUPPLIER_ADDRESS }), (message) => { cleanOf(message); assert.match(message, /it was not posted by /); });
      const copy = scenario({ escrow: 'finished', funder: 'stranger' });
      await rejectsWith(copy.poll(), (message) => { cleanOf(message); assert.match(message, /has no input from .*, so that wallet did not fund it\./); });
      assert.equal(copy.sup.calls.length, 0);
      const unknown = scenario({ escrow: 'finished', funder: 'unknown' });
      await rejectsWith(unknown.poll(), (message) => { cleanOf(message); assert.match(message, /could not check who funded it \(Koios tx_info: transaction not found\)/); });
      assert.equal(unknown.sup.calls.length, 0);
    });
  });

  // A poll needs the buyer, the funder and the advert, and the Post output holds all three: it reads that output and nothing else
  // of the escrow. So what anyone leaves at the escrow credential cannot make a finished job unpollable (griefing), and no node is
  // asked (getJob takes none).
  describe('a poll reads only the Post output', () => {
    test('one read of the output and one of the transaction that made it, whatever state the escrow is in: no spend chain, no credential listing', async () => {
      for (const escrow of ['open', 'claimed', 'submitted', 'finished'] as const) {
        const s = scenario({ escrow, answer: () => reply(202, { status: 'running' }) });
        assert.equal((await s.poll()).view.state, 'pending', escrow);
        assert.deepEqual(s.koios.calls.map((c) => c.path), ['/api/v1/utxo_info', '/api/v1/tx_info'], escrow);
        assert.equal(credentialRequests(s.koios).length, 0, escrow);
      }
    });
    test('a copy of the escrow left at its credential cannot make a finished job unpollable, though a send for that escrow is stopped by it', async () => {
      const s = scenario({ escrow: 'finished', decoy: true, answer: () => reply(200, done) });
      const r = await s.poll();
      assert.ok(r.view.state === 'done');
      assert.equal(r.view.result, 'the output');
      assert.equal(credentialRequests(s.koios).length, 0, 'the credential was not listed, so the copy was not met');
      // a send has to know where the escrow is, and the resolver does not guess among copies: it fails closed
      await rejectsWith(s.send(), (message) => assert.match(message, /^None of .* descends from escrow .* by the spend chain, though they carry its fields; refusing to treat any of them as the escrow\.$/));
      assert.equal(s.sup.calls.length, 1, 'only the poll reached the supplier');
    });
    test('a ref that names an Accepted output is refused as "an Accepted output"', async () => {
      const s = scenario({ names: 'accepted-output' });
      await rejectsWith(s.poll(), (message) => {
        assert.equal(message, `Cannot poll a job for escrow ${CLAIM_TX}#0: it is an Accepted output, not the output its Post made: use the escrow ref the Post returned. Nothing was sent.`);
      });
      assert.equal(s.fundingChecks().length, 0);
      assert.equal(s.sup.calls.length, 0);
    });
  });

  describe('only the buyer, who funded the escrow, polls', () => {
    test('the buyer is a key: a base address and an enterprise address of that key are the same buyer', async () => {
      for (const buyerAddress of [OWN_ADDRESS, enterpriseAddressOf(BUYER_PKH)]) {
        const s = scenario({ escrow: 'claimed', answer: () => reply(202, { status: 'running' }) });
        assert.equal((await s.poll({ buyerAddress })).view.state, 'pending', buyerAddress);
      }
    });
    test('an escrow whose datum names someone else is refused, naming the address, before the funder is asked, the advert is read or anything reaches the supplier', async () => {
      const s = scenario({ escrow: 'claimed' });
      await rejectsWith(s.poll({ buyerAddress: SUPPLIER_ADDRESS }), (message) => {
        cleanOf(message);
        assert.equal(message, `Cannot poll a job for escrow ${ESCROW_REF}: it was not posted by ${SUPPLIER_ADDRESS}. Nothing was sent.`);
      });
      assert.equal(s.fundingChecks().length, 0);
      assert.equal(s.advertReads(), 0);
      assert.equal(s.sup.calls.length, 0);
    });
    test('an address that is no wallet key address is no buyer, and nothing is asked of anyone', async () => {
      for (const buyerAddress of [ESCROW_ADDRESS, 'not-an-address', '', undefined, null, 7]) {
        const s = scenario({ escrow: 'claimed' });
        await rejectsWith(s.poll({ buyerAddress: buyerAddress as never }), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot poll a job for escrow ${ESCROW_REF}: ${NOT_A_BUYER} Nothing was sent.`);
        });
        assert.equal(s.koios.calls.length, 0, String(buyerAddress));
        assert.equal(s.sup.calls.length, 0, String(buyerAddress));
      }
    });
    test('a copy of a real escrow\'s buyer and prompt hash, in a Post the buyer did not fund, is refused and nothing reaches the attacker', async () => {
      const s = scenario({ escrow: 'claimed', funder: 'stranger', endpoint: 'https://203.0.113.99' });
      await rejectsWith(s.poll(), (message) => {
        cleanOf(message);
        assert.equal(message, `Cannot poll a job for escrow ${ESCROW_REF}: the transaction that posted it has no input from ${OWN_ADDRESS}, so that wallet did not fund it. Nothing was sent.`);
      });
      assert.equal(s.sup.calls.length, 0);
      assert.equal(s.advertReads(), 0);
    });
    test('a Post transaction Koios does not know, or cannot be asked about, is a refusal', async () => {
      for (const [funder, expected] of [['unknown', 'Koios tx_info: transaction not found'], ['unreachable', 'Koios request failed (network error or timeout)']] as const) {
        const s = scenario({ escrow: 'claimed', funder });
        await rejectsWith(s.poll(), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot poll a job for escrow ${ESCROW_REF}: could not check who funded it (${expected}). Nothing was sent.`);
        });
        assert.equal(s.sup.calls.length, 0, funder);
      }
    });
    test('a ref that names a later output of the escrow is refused', async () => {
      const s = scenario({ escrow: 'claimed', names: 'claimed-output' });
      await rejectsWith(s.poll(), (message) => {
        assert.equal(message, `Cannot poll a job for escrow ${CLAIM_TX}#0: it is a Claimed output, not the output its Post made: use the escrow ref the Post returned. Nothing was sent.`);
      });
      assert.equal(s.sup.calls.length, 0);
    });
  });

  // The template echoes the escrow it keyed the job with in every answer about a job; an answer for another escrow is not about this job.
  describe('an answer that names another escrow', () => {
    const other = `${'bb'.repeat(32)}#0`;
    const mismatch = { state: 'failed', reason: 'escrow_mismatch', message: `The supplier's answer is for another escrow than ${ESCROW_REF}; it is not used.` };
    test('is a failed view whatever its status, never the answer for this job', async () => {
      const answers: Array<[number, unknown]> = [
        [202, { status: 'running', escrow_ref: other }], [200, { ...done, escrow_ref: other }],
        [502, { status: 'failed', reason: 'service_timeout', message: 'x', escrow_ref: other }], [404, { reason: 'job_not_found', escrow_ref: other }],
      ];
      for (const [status, body] of answers) {
        const s = scenario({ escrow: 'claimed', answer: () => reply(status, body) });
        assert.deepEqual((await s.poll()).view, mismatch, String(status));
      }
    });
    test('and so is an echo that is no escrow ref at all', async () => {
      for (const echoed of ['nonsense', '', 7, null, {}, [ESCROW_REF], `${ESCROW_REF.slice(0, -1)}1`]) {
        const s = scenario({ escrow: 'claimed', answer: () => reply(200, { ...done, escrow_ref: echoed }) });
        assert.deepEqual((await s.poll()).view, mismatch, JSON.stringify(echoed));
      }
    });
    test('the same escrow in another spelling is the same escrow, and an answer that echoes nothing is not a mismatch', async () => {
      const respelled = scenario({ escrow: 'claimed', answer: () => reply(200, { ...done, escrow_ref: `  ${ESCROW_REF.toUpperCase()} ` }) });
      assert.equal((await respelled.poll()).view.state, 'done');
      const silent = scenario({ escrow: 'claimed', answer: () => reply(202, { status: 'running' }) });
      assert.deepEqual((await silent.poll()).view, { state: 'pending', status: 'running' });
    });
  });

  describe('template-contract suppliers only', () => {
    for (const capability of OUT_OF_SCOPE) {
      test(`${capability} is a fleet capability and is refused, before anything reaches the supplier`, async () => {
        const s = scenario({ capability, escrow: 'claimed' });
        await rejectsWith(s.poll(), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot poll a job for escrow ${ESCROW_REF}: ${capability} uses the fleet route; this tool supports template-contract suppliers only in this release. Nothing was sent.`);
        });
        assert.equal(s.sup.calls.length, 0);
        await rejectsWith(s.poll({ route: 'template' }), (message) => assert.match(message, /uses the fleet route; this tool supports template-contract suppliers only in this release/));
        assert.equal(s.sup.calls.length, 0);
      });
    }
    test('a fleet route the caller forces is refused before anything at all is asked; the template route may be named', async () => {
      for (const route of ['chat', 'ocr', 'tts'] as const) {
        const s = scenario({ escrow: 'claimed' });
        await rejectsWith(s.poll({ route }), (message) => {
          cleanOf(message);
          assert.equal(message, `Cannot poll a job for escrow ${ESCROW_REF}: the ${route} route is a fleet route; this tool supports template-contract suppliers only in this release. Nothing was sent.`);
        });
        assert.equal(s.koios.calls.length, 0, route);
        assert.equal(s.sup.calls.length, 0, route);
      }
      const t = scenario({ escrow: 'claimed', answer: () => reply(202, { status: 'running' }) });
      assert.equal((await t.poll({ route: 'template' })).route, 'template');
    });
  });

  const refusals: Array<[name: string, o: Scenario, expected: RegExp]> = [
    ['an endpoint that is plain http', { escrow: 'claimed', endpoint: 'http://203.0.113.7' }, /is not an https URL/],
    ['an advert UTxO at the wrong address', { escrow: 'claimed', advert: { address: 'addr1' + 'q'.repeat(54) } }, /is not at the advert script address\. Nothing was sent\.$/],
    ['an advert the ledger does not know', { escrow: 'claimed', advert: { missing: true } }, /No UTxO at .* Nothing was sent\.$/],
    ['an advert Koios cannot be asked about', { escrow: 'claimed', advert: { httpStatus: 502 } }, /Koios utxo_info answered 502/],
  ];
  for (const [name, o, expected] of refusals) {
    test(`refuses ${name}, before anything reaches the supplier`, async () => {
      const s = scenario(o);
      await rejectsWith(s.poll(), (message) => { cleanOf(message); assert.match(message, /^Cannot poll a job for escrow /); assert.match(message, expected); });
      assert.equal(s.sup.calls.length, 0);
    });
  }
  test('refuses a job id that is not a plain token, without asking anything', async () => {
    const s = scenario({ escrow: 'claimed' });
    for (const jobId of ['', '../../capability', 'a b', 'a?b=1', 'a#b', 'a/b', 'x\n## injected', 'x'.repeat(129)]) {
      await rejectsWith(s.poll({ jobId }), (message) => { cleanOf(message); assert.match(message, /the job id must be 1 to 128 letters, digits, hyphens or underscores\. Nothing was sent\.$/); });
    }
    assert.equal(s.sup.calls.length, 0);
    assert.equal(s.koios.calls.length, 0);
  });
  test('reads at most 1,000,000 bytes of an answer: exactly that many are read, one more is refused', async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ choices: [{ message: { content: '' } }], receipt: {}, receipt_signature: 'cd' }));
    const sized = (bytes: number) => reply(200, JSON.stringify({ choices: [{ message: { content: 'x'.repeat(bytes - overhead) } }], receipt: {}, receipt_signature: 'cd' }));
    const full = await scenario({ escrow: 'claimed', answer: () => sized(1_000_000) }).poll();
    assert.ok(full.view.state === 'done');
    assert.equal(full.view.result.length, 1_000_000 - overhead);
    await rejectsWith(scenario({ escrow: 'claimed', answer: () => sized(1_000_001) }).poll(), (message) => { cleanOf(message); assert.match(message, /the supplier's answer is over the 1000000 byte limit\.$/); });
  });
  test('a 200 that is no JSON object is not a finished job', async () => {
    const s = scenario({ escrow: 'claimed', answer: () => reply(200, '<html>welcome</html>') });
    assert.deepEqual((await s.poll()).view, { state: 'failed', reason: 'malformed_response', message: 'The supplier answered 200 with something that is not a JSON object.' });
  });
  test('a supplier that cannot be reached is reported without what the network said, naming the job and the escrow', async () => {
    const s = scenario({ escrow: 'claimed', answer: () => { throw new TypeError('fetch failed: connect ECONNREFUSED 203.0.113.7:443'); } });
    await rejectsWith(s.poll(), (message) => { cleanOf(message); assert.equal(message, `Could not poll job ${JOB_ID} of escrow ${ESCROW_REF}: the request to the supplier failed (network error).`); });
  });
  test('an endpoint on a private or reserved address is refused by the rule', async () => {
    const s = scenario({ escrow: 'claimed', endpoint: 'https://192.168.1.10' });
    await rejectsWith(s.poll(), (message) => { cleanOf(message); assert.match(message, /the supplier host resolves to a private or reserved address, which is refused\.$/); });
    assert.equal(s.sup.calls.length, 0);
  });
});

// A supplier that never answers must cost a bounded wait and say what to check, not hang (Review Focus 1). The job POST waits for the
// supplier's Claim to confirm (its own limit is 60 s), so it is given 90 s; a poll is given 20 s.
describe('a supplier that never answers', () => {
  afterEach(() => { mock.restoreAll(); });
  /**
   * The budget becomes a number in exactly one place, AbortSignal.timeout inside safeFetch. It is recorded there, and the supplier
   * budgets (90 s and 20 s) are shortened to 30 ms so that the test does not sit through them; every other timeout (Koios, 15 s) is
   * left alone.
   */
  function shortened() {
    const budgets: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    mock.method(AbortSignal, 'timeout', (ms: number) => { budgets.push(ms); return real(ms === 90_000 || ms === 20_000 ? 30 : ms); });
    return () => budgets.filter((ms) => ms === 90_000 || ms === 20_000);
  }
  /** Answers when the request is abandoned and not before, as a connection to a dead supplier does. */
  const hangs = (_call: Call, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  test('sendJob gives up after 90 s and says the escrow may have been claimed', async () => {
    const supplierBudgets = shortened();
    const s = scenario({ answer: hangs });
    const started = Date.now();
    await rejectsWith(s.send(), (message) => {
      cleanOf(message);
      assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier did not answer within 90 s.${MAY_HAVE_CLAIMED}`);
    });
    assert.ok(Date.now() - started < 5_000, 'it did not wait for the real budget');
    assert.deepEqual(supplierBudgets(), [90_000], 'the job POST is given 90 s, once, and nothing else is given a supplier budget');
    assert.equal(s.sup.calls.length, 1, 'and is not retried');
  });
  test('getJob gives up after 20 s, without the claim warning (a poll claims nothing)', async () => {
    const supplierBudgets = shortened();
    const s = scenario({ escrow: 'claimed', answer: hangs });
    await rejectsWith(s.poll(), (message) => {
      cleanOf(message);
      assert.equal(message, `Could not poll job ${JOB_ID} of escrow ${ESCROW_REF}: the supplier did not answer within 20 s.`);
    });
    assert.deepEqual(supplierBudgets(), [20_000], 'the poll is given 20 s, once');
    assert.equal(s.sup.calls.length, 1);
  });
  test('an aborted call is a timeout whichever way the abort is named', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const s = scenario({ answer: () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name }); } });
      await rejectsWith(s.send(), (message) => assert.match(message, /the supplier did not answer within 90 s\. It may have claimed the escrow anyway/, name));
    }
  });
  test('a Koios that never answers is an error naming the escrow, not a hang', async () => {
    const never = (async () => { await new Promise((resolve) => setTimeout(resolve, 50)); throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    await rejectsWith(sendJob({} as never, KOIOS, { escrowRef: ESCROW_REF, payload: 'x', buyerAddress: OWN_ADDRESS }, never), (message) => {
      assert.equal(message, `Could not read escrow ${ESCROW_REF}: Koios request failed (network error or timeout)`);
    });
  });
});
