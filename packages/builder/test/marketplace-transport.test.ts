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
import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Constr, Data, fromText } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { ADVERT_ADDRESS } from '../src/vector/marketplace-constants.ts';
import { decodeEscrowDatum, encodeEscrowDatum, promptHashForPayload, wirePayloadFor } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../src/vector/marketplace-datum.ts';
import { ROUTES, routeFor, parseJobResponse, sendJob, getJob } from '../src/vector/marketplace-transport.ts';
import type { Route } from '../src/vector/marketplace-transport.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { world, escrowAt, ESCROW_TX, CLAIM_TX, SUBMIT_TX } from './fixtures/escrow-koios.fixture.ts';

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
    // one-shot Responses route is not the place to send it
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
  test('an empty result is a result, and an answer in no known shape is kept whole', () => {
    const empty = parseJobResponse(200, JSON.stringify({ choices: [{ message: { content: '' } }], receipt: {}, receipt_signature: 'ab' }));
    assert.ok(empty.state === 'done');
    assert.equal(empty.result, '');
    const odd = parseJobResponse(200, '{"other":1}');
    assert.ok(odd.state === 'done');
    assert.equal(odd.result, '{"other":1}');
    assert.equal(odd.receiptSignature, '');
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
  test('without a reason or a message the status and the start of the body stand in', () => {
    assert.deepEqual(parseJobResponse(503, 'upstream down'), { state: 'failed', reason: 'http_503', message: 'upstream down' });
    assert.deepEqual(parseJobResponse(500, 'x'.repeat(300)), { state: 'failed', reason: 'http_500', message: 'x'.repeat(200) });
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

const POSTED_BASE: EscrowDatum = { ...decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), prompt_hash: promptHashForPayload(PAYLOAD) };
const ADVERT_TX = ADVERT_REF.slice(0, 64);
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
  advert?: { status?: 'Active' | 'Retired'; spent?: boolean; spentUnreported?: boolean; address?: string; missing?: boolean; httpStatus?: number; unreachable?: boolean };
  answer?: (call: Call, init: RequestInit) => Answer;
}
/**
 * One escrow (Open, Claimed, Submitted, or finished with nothing left on the chain), its advert, and a supplier. The node and Koios
 * are built from one list of UTxOs (`world`); the advert read is answered on top of Koios; whatever else is fetched is the supplier.
 */
function scenario(o: Scenario = {}) {
  const capability = o.capability ?? 'identity.history.report.v1';
  const posted: EscrowDatum = { ...POSTED_BASE, capability_id: capability };
  const claimed: EscrowDatum = { ...posted, state: 'Claimed' };
  const submitted: EscrowDatum = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
  const state = o.escrow ?? 'open';
  const chain: UTxO[] = { open: [escrowAt(ESCROW_TX, posted)], claimed: [escrowAt(CLAIM_TX, claimed)], submitted: [escrowAt(SUBMIT_TX, submitted)], finished: [] }[state];
  const w = world(chain, { datumHex: encodeEscrowDatum(posted), spent: state !== 'open' });
  const advert = o.advert ?? {};
  const advertRow: Record<string, unknown> = {
    tx_hash: ADVERT_TX, tx_index: 0, address: advert.address ?? ADVERT_ADDRESS, value: '2000000', is_spent: advert.spent ?? false,
    inline_datum: { bytes: advertDatum({ capability_id: capability, endpoint_url: o.endpoint ?? SUPPLIER, status: advert.status }) },
  };
  if (advert.spentUnreported) delete advertRow.is_spent; // Koios leaves the field out when it does not know
  const sup = supplier(o.answer);
  const fetchImpl = (async (url: string, init: { body: string }) => {
    if (String(url).endsWith('/api/v1/utxo_info') && (JSON.parse(init.body)._utxo_refs as string[]).includes(ADVERT_REF)) {
      if (advert.unreachable) throw new TypeError('fetch failed: connect ECONNREFUSED internal.koios.example:443 password=hunter2');
      if (advert.httpStatus) return new Response(HOSTILE, { status: advert.httpStatus });
      return new Response(JSON.stringify(advert.missing ? [] : [advertRow]), { status: 200 });
    }
    if (String(url).includes('/api/v1/')) return w.koios.f(url, init);
    return sup.f(url, init as RequestInit);
  }) as unknown as typeof fetch;
  return {
    sup, koios: w.koios, posted,
    send: (over: Partial<Parameters<typeof sendJob>[2]> = {}) => sendJob(w.node, KOIOS, { escrowRef: ESCROW_REF, payload: PAYLOAD, ...over }, fetchImpl),
    poll: (over: Partial<Parameters<typeof getJob>[2]> = {}) => getJob(w.node, KOIOS, { escrowRef: ESCROW_REF, jobId: JOB_ID, ...over }, fetchImpl),
  };
}

/** The promise rejects with an Error whose message `check` accepts. */
const rejectsWith = (run: Promise<unknown>, check: (message: string) => void) => assert.rejects(run, (err: unknown) => { assert.ok(err instanceof Error, String(err)); check(err.message); return true; });
/** An error from this module names the escrow and never the endpoint, a Koios error body or the hostile text behind it. */
const cleanOf = (message: string) => {
  assert.ok(message.includes(ESCROW_REF), `the escrow ref is missing from: ${message}`);
  for (const secret of ['203.0.113.7', '169.254.169.254', '192.168.1.10', 'evil.example', 'hunter2', 'internal.koios.example', 'not a url', 'user:pw']) assert.ok(!message.includes(secret), `${secret} leaked into: ${message}`);
};

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
    // the escrow is read from the Koios the caller named
    assert.ok(s.koios.calls.length > 0 && s.koios.calls.every((c) => c.url?.startsWith(`${KOIOS}/api/v1/`)), JSON.stringify(s.koios.calls.map((c) => c.url)));
  });
  test('the escrow named in the request is the canonical ref, whatever case or spacing the caller used', async () => {
    const s = scenario({ capability: 'llm.text.generate.v1' });
    await s.send({ escrowRef: `  ${ESCROW_REF.toUpperCase()} ` });
    assert.equal(s.sup.calls[0].headers['X-Escrow-Ref'], ESCROW_REF);
    const t = scenario();
    await t.send({ escrowRef: ` ${ESCROW_REF.toUpperCase()}` });
    assert.equal(JSON.parse(t.sup.calls[0].body).escrow_ref, ESCROW_REF);
  });
  const fleet: Array<[capability: string, route: Route['kind'], path: string, body: (payload: string) => string]> = [
    ['llm.text.generate.v1', 'chat', '/v1/responses', (p) => JSON.stringify({ input: p })],
    ['ocr.page.extract.chandra-ocr-2.v1', 'ocr', '/v1/ocr/extract', (p) => p],
    ['audio.synthesize.piper.v1', 'tts', '/v1/audio/synthesize', (p) => p],
  ];
  for (const [capability, route, path, body] of fleet) {
    test(`${capability} goes to ${path} with the escrow in X-Escrow-Ref`, async () => {
      const s = scenario({ capability });
      const payload = route === 'chat' ? 'hi there' : '{"k":"v"}';
      const r = await s.send({ payload });
      assert.equal(r.route, route);
      assert.equal(r.capabilityId, capability);
      assert.equal(s.sup.calls.length, 1);
      const call = s.sup.calls[0];
      assert.equal(call.url, `${SUPPLIER}${path}`);
      assert.equal(call.method, 'POST');
      assert.deepEqual(call.headers, { 'content-type': 'application/json', accept: 'application/json', 'X-Escrow-Ref': ESCROW_REF });
      assert.equal(call.body, body(payload));
    });
  }
  test('a forced route overrides the capability', async () => {
    const s = scenario();
    const r = await s.send({ route: 'ocr', payload: '{"k":"v"}' });
    assert.equal(r.route, 'ocr');
    assert.equal(s.sup.calls[0].url, `${SUPPLIER}/v1/ocr/extract`);
    assert.equal(s.sup.calls[0].headers['X-Escrow-Ref'], ESCROW_REF);
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
  test('refuses an empty payload before asking anything, and a request over 1,000,000 bytes before it reaches the supplier', async () => {
    const s = scenario();
    await rejectsWith(s.send({ payload: '' }), (message) => { cleanOf(message); assert.match(message, /the payload must be a non-empty string\. Nothing was sent\.$/); });
    assert.equal(s.koios.calls.length, 0, 'not even Koios was asked');
    await rejectsWith(s.send({ payload: 'x'.repeat(1_000_000) }), (message) => { cleanOf(message); assert.match(message, /the request is \d+ bytes, over the 1000000 byte limit\. Nothing was sent\.$/); });
    assert.equal(s.sup.calls.length, 0);
    // a body of exactly the limit goes through (an OCR route sends the payload as it is)
    const ocr = scenario({ capability: 'ocr.page.extract.chandra-ocr-2.v1' });
    await ocr.send({ payload: 'x'.repeat(1_000_000) });
    assert.equal(ocr.sup.calls[0].body.length, 1_000_000);
    await rejectsWith(ocr.send({ payload: 'x'.repeat(1_000_001) }), (message) => assert.match(message, /the request is 1000001 bytes, over the 1000000 byte limit/));
  });
  test('a lineage the resolver refuses is the refusal, with its words and none of what Koios said', async () => {
    const failing = world([], { status: 502 });
    await rejectsWith(sendJob(failing.node, KOIOS, { escrowRef: ESCROW_REF, payload: PAYLOAD }, failing.koios.f), (message) => {
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
    test('an answer in no known form is reported by its status and the start of its body', async () => {
      const s = scenario({ answer: () => reply(502, '<html>Bad gateway' + 'x'.repeat(500)) });
      await rejectsWith(s.send(), (message) => {
        cleanOf(message);
        assert.match(message, /the supplier answered 502 \(http_502\): <html>Bad gateway/);
        assert.ok(message.length < 400, `${message.length} characters`);
      });
    });
    test('what a supplier writes cannot break the line the error is shown on', async () => {
      const s = scenario({ answer: () => reply(500, { reason: 'bad | reason', message: 'line one\n## injected `x`' }) });
      await rejectsWith(s.send(), (message) => { assert.ok(!/[\n|`]/.test(message), message); assert.match(message, /bad ¦ reason.*line one ## injected 'x'/); });
    });
    test('202 without a usable job id is not a started job', async () => {
      for (const body of [{ status: 'accepted' }, { job_id: '' }, { job_id: 7 }, { job_id: null }, '', 'not json']) {
        const s = scenario({ answer: () => reply(202, body) });
        await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /the supplier answered 202 but returned no usable job id\.$/); });
      }
    });
    test('a job id that is not a plain token is refused: it will be put in a URL and in a line of markdown', async () => {
      for (const job_id of ['../../capability', 'a b', 'x\n## injected', 'a?b=1', 'a#b', 'a/b', 'é', 'x'.repeat(129)]) {
        const s = scenario({ answer: () => accepted({ job_id }) });
        await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /returned no usable job id/); });
      }
      assert.equal((await scenario({ answer: () => accepted({ job_id: 'x'.repeat(128) }) }).send()).jobId, 'x'.repeat(128));
    });
    test('a 200, or any other status that is not 202, is not a started job either', async () => {
      const s = scenario({ answer: () => reply(200, { job_id: JOB_ID, choices: [] }) });
      await rejectsWith(s.send(), (message) => assert.match(message, /the supplier answered 200 \(http_200\)/));
    });
    test('a redirect is not followed, and its target is not repeated', async () => {
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
    test('a connection that fails is reported without what the network said', async () => {
      const s = scenario({ answer: () => { throw new TypeError('fetch failed: connect ECONNREFUSED 203.0.113.7:443 (evil.example)'); } });
      await rejectsWith(s.send(), (message) => { cleanOf(message); assert.match(message, /the request to the supplier failed \(network error\)\.$/); });
    });
    test('reads at most 1,000,000 bytes of an answer: exactly that many are read, one more is refused', async () => {
      const overhead = Buffer.byteLength(JSON.stringify({ job_id: JOB_ID, status: 'accepted', pad: '' }));
      const sized = (bytes: number) => reply(202, JSON.stringify({ job_id: JOB_ID, status: 'accepted', pad: 'x'.repeat(bytes - overhead) }));
      assert.equal((await scenario({ answer: () => sized(1_000_000) }).send()).jobId, JOB_ID);
      await rejectsWith(scenario({ answer: () => sized(1_000_001) }).send(), (message) => { cleanOf(message); assert.match(message, /the supplier's answer is over the 1000000 byte limit\.$/); });
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
  });
  const fleet: Array<[capability: string, path: string]> = [
    ['llm.text.generate.v1', '/v1/responses'], ['ocr.page.extract.chandra-ocr-2.v1', '/v1/ocr/extract'], ['audio.synthesize.piper.v1', '/v1/audio/synthesize'],
  ];
  for (const [capability, path] of fleet) {
    test(`${capability} is polled at ${path}/<job id>, with no escrow header`, async () => {
      const s = scenario({ capability, escrow: 'claimed', answer: () => reply(202, { status: 'running', escrow_ref: ESCROW_REF }) });
      const r = await s.poll();
      assert.deepEqual(r.view, { state: 'pending', status: 'running' });
      assert.deepEqual(s.sup.calls[0], { url: `${SUPPLIER}${path}/${JOB_ID}`, method: 'GET', headers: { accept: 'application/json' }, body: '' });
    });
  }
  test('a forced route overrides the capability', async () => {
    const s = scenario({ escrow: 'claimed', answer: () => reply(202, { status: 'running' }) });
    const r = await s.poll({ route: 'tts' });
    assert.equal(r.route, 'tts');
    assert.equal(s.sup.calls[0].url, `${SUPPLIER}/v1/audio/synthesize/${JOB_ID}`);
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
  test('the submitted_ref the supplier reports comes with a finished job, for the verification that follows', async () => {
    const s = scenario({ capability: 'ocr.page.extract.chandra-ocr-2.v1', escrow: 'submitted', answer: () => reply(200, { kind: 'ocr', content: '# page', receipt: {}, receipt_signature: 'cd', submitted_ref: SUBMITTED_REF }) });
    const r = await s.poll();
    assert.ok(r.view.state === 'done');
    assert.equal(r.view.submittedRef, SUBMITTED_REF);
  });

  const refusals: Array<[name: string, o: Scenario, expected: RegExp]> = [
    ['an escrow with no live output', { escrow: 'finished' }, /no live output was found for it .*Nothing was sent\.$/],
    ['a retired advert', { escrow: 'claimed', advert: { status: 'Retired' } }, /is Retired\. Nothing was sent\.$/],
    ['a spent advert', { escrow: 'claimed', advert: { spent: true } }, /has been spent/],
    ['an advert whose spent status Koios does not report', { escrow: 'claimed', advert: { spentUnreported: true } }, /Koios did not report whether its advert .* is spent\. Nothing was sent\.$/],
    ['an endpoint that is plain http', { escrow: 'claimed', endpoint: 'http://203.0.113.7' }, /is not an https URL/],
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

// A supplier that never answers must cost a bounded wait and say what to check, not hang (Review Focus 1).
describe('a supplier that never answers', () => {
  afterEach(() => { mock.restoreAll(); });
  /**
   * The budget becomes a number in exactly one place, AbortSignal.timeout inside safeFetch. It is recorded there, and the 20 s is
   * shortened to 30 ms so that the test does not sit through it; every other timeout (Koios, 15 s) is left alone.
   */
  function shortened() {
    const budgets: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    mock.method(AbortSignal, 'timeout', (ms: number) => { budgets.push(ms); return real(ms === 20_000 ? 30 : ms); });
    return budgets;
  }
  /** Answers when the request is abandoned and not before, as a connection to a dead supplier does. */
  const hangs = (_call: Call, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  test('sendJob gives up after 20 s and says the escrow may have been claimed', async () => {
    const budgets = shortened();
    const s = scenario({ answer: hangs });
    const started = Date.now();
    await rejectsWith(s.send(), (message) => {
      cleanOf(message);
      assert.equal(message, `Could not send the job for escrow ${ESCROW_REF}: the supplier did not answer within 20 s. It may have claimed the escrow anyway, so check its state before sending again; if it stays Open, reclaim it after deliver_by.`);
    });
    assert.ok(Date.now() - started < 5_000, 'it did not wait for the real budget');
    assert.deepEqual(budgets.filter((ms) => ms === 20_000), [20_000], 'the supplier call is given 20 s, once');
    assert.equal(s.sup.calls.length, 1, 'and is not retried');
  });
  test('getJob gives up after 20 s too, without the claim warning (a poll claims nothing)', async () => {
    const budgets = shortened();
    const s = scenario({ escrow: 'claimed', answer: hangs });
    await rejectsWith(s.poll(), (message) => {
      cleanOf(message);
      assert.equal(message, `Could not poll job ${JOB_ID} of escrow ${ESCROW_REF}: the supplier did not answer within 20 s.`);
    });
    assert.deepEqual(budgets.filter((ms) => ms === 20_000), [20_000]);
    assert.equal(s.sup.calls.length, 1);
  });
  test('an aborted call is a timeout whichever way the abort is named', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const s = scenario({ answer: () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name }); } });
      await rejectsWith(s.send(), (message) => assert.match(message, /the supplier did not answer within 20 s\. It may have claimed the escrow anyway/, name));
    }
  });
  test('a Koios that never answers is an error naming the escrow, not a hang', async () => {
    const never = (async () => { await new Promise((resolve) => setTimeout(resolve, 50)); throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    await rejectsWith(sendJob({} as never, KOIOS, { escrowRef: ESCROW_REF, payload: 'x' }, never), (message) => {
      assert.equal(message, `Could not read escrow ${ESCROW_REF}: Koios request failed (network error or timeout)`);
    });
  });
});
