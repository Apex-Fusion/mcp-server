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
import { ADVERT_ADDRESS, ESCROW_ADDRESS, INDEXER_URL } from '../src/vector/marketplace-constants.ts';
import { ESCROWS_MAX_BYTES } from '../src/vector/marketplace-indexer.ts';
import { canonicalize, decodeEscrowDatum, encodeEscrowDatum, promptHashForPayload, wirePayloadFor } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../src/vector/marketplace-datum.ts';
import { enterpriseAddressOf } from '../src/vector/marketplace-build.ts';
import { ROUTES, routeFor, parseJobResponse, sendJob, getJob, verifyReceipt, verifyJob, fetchManifest } from '../src/vector/marketplace-transport.ts';
import type { Route, VerifyInput, ReceiptVerdict } from '../src/vector/marketplace-transport.ts';
import { ADVERT_EXPECTED, ADVERT_REF, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { world, credentialRequests, txInfoRequests, ESCROW_TX, CLAIM_TX, SUBMIT_TX, SUPPLIER_ADDRESS } from './fixtures/escrow-koios.fixture.ts';
import { KOIOS, PAYLOAD, SUPPLIER, JOB_ID, HOSTILE, reply, accepted, BUYER_PKH, MAY_HAVE_CLAIMED, scenario, DECOY_SUBMITTED_REF, SUPPLIER_KEY, OTHER_KEY, pkhOf, pubHexOf, RESULT, receiptOf, signWith, committedHash } from './fixtures/transport-world.fixture.ts';
import type { Call, Scenario } from './fixtures/transport-world.fixture.ts';
import { heldOpen } from './fixtures/held-open.ts';

const SUBMITTED_REF = `${'ee'.repeat(32)}#0`;
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
    assert.deepEqual(r, { jobId: JOB_ID, status: 'accepted', route: 'template', endpoint: SUPPLIER, capabilityId: 'identity.history.report.v1', escrowRef: ESCROW_REF });
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
    assert.equal(r.escrowRef, ESCROW_REF);
    assert.equal(r.deliverBy, s.posted.deliver_by);
    assert.equal(s.sup.calls.length, 1);
    assert.deepEqual(s.sup.calls[0], { url: `${SUPPLIER}/v1/job/${JOB_ID}`, method: 'GET', headers: { accept: 'application/json' }, body: '' });
    // one decision draws on one Koios here too
    assert.ok(s.koios.calls.every((c) => c.url?.startsWith(`${KOIOS}/api/v1/`)), JSON.stringify(s.koios.calls.map((c) => c.url)));
    assert.deepEqual(s.advertUrls(), [`${KOIOS}/api/v1/utxo_info`]);
    assert.equal(s.fundingChecks().length, 1);
  });
  test('the escrow comes back as the canonical ref, whatever case and spacing the caller used, for a send and for a poll', async () => {
    const odd = ` ${ESCROW_REF.toUpperCase()} `;
    const sent = scenario();
    assert.equal((await sent.send({ escrowRef: odd })).escrowRef, ESCROW_REF);
    const polled = scenario({ escrow: 'submitted', answer: () => reply(200, done) });
    assert.equal((await polled.poll({ escrowRef: odd })).escrowRef, ESCROW_REF);
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
    await rejectsWith(heldOpen(s.send()), (message) => {
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
    await rejectsWith(heldOpen(s.poll()), (message) => {
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

// ─── verifying a receipt ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A receipt is checked five ways and one more, and "verified" is said only when every row passes. The signed receipts here are made the
// way the template's supplier makes them: the eight fields, Ed25519 over canonicalize(receipt), and a result_receipt_hash on chain that
// is sha256(canonicalize({receipt, signature})).
const statesOf = (v: ReceiptVerdict) => Object.fromEntries(Object.entries(v.checks).map(([name, c]) => [name, c.state]));
const PASSING = { escrow_ref_matches: 'pass', response_hash_matches: 'pass', supplier_key_matches: 'pass', signature_valid: 'pass', on_chain_hash_matches: 'pass', prompt_hash_matches: 'pass' };

describe('verifyReceipt', () => {
  const receipt = receiptOf(SUPPLIER_KEY, ESCROW_REF);
  const signature = signWith(SUPPLIER_KEY, receipt);
  const onChain = committedHash(receipt, signature);
  const good: VerifyInput = {
    receipt, signature, escrowRef: ESCROW_REF, result: RESULT, supplierPubKeyHex: pubHexOf(SUPPLIER_KEY), escrowSupplierPkh: pkhOf(SUPPLIER_KEY),
    escrowPromptHash: promptHashForPayload(PAYLOAD), resultReceiptHashOnChain: onChain,
  };

  test('a good receipt passes the five checks, in the design\'s order, and the extra row, and is verified', () => {
    const v = verifyReceipt(good);
    assert.equal(v.verdict, 'verified');
    assert.deepEqual(Object.keys(v.checks), ['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches']);
    assert.deepEqual(statesOf(v), PASSING);
    for (const c of Object.values(v.checks)) assert.equal(c.note, '');
  });
  test('the same receipt after a JSON round trip, with its keys in another order, is the same receipt', () => {
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse())));
    assert.equal(verifyReceipt({ ...good, receipt: reordered }).verdict, 'verified');
  });

  describe('(1) receipt.escrow_ref equals the escrow ref', () => {
    test('a receipt for another escrow fails that check only: it is validly signed and committed, for something else', () => {
      const other = `${'b'.repeat(64)}#0`;
      const r = receiptOf(SUPPLIER_KEY, other);
      const sig = signWith(SUPPLIER_KEY, r);
      const v = verifyReceipt({ ...good, receipt: r, signature: sig, resultReceiptHashOnChain: committedHash(r, sig) });
      assert.equal(v.verdict, 'failed');
      assert.deepEqual(statesOf(v), { ...PASSING, escrow_ref_matches: 'fail' });
      assert.equal(v.checks.escrow_ref_matches.note, 'the receipt names another escrow');
    });
    test('the spelling is exact, as the template\'s check is: the same ref in upper case or padded is another string', () => {
      for (const spelled of [ESCROW_REF.toUpperCase(), ` ${ESCROW_REF}`, ESCROW_REF.slice(0, -2) + '#00']) {
        const r = receiptOf(SUPPLIER_KEY, spelled);
        const sig = signWith(SUPPLIER_KEY, r);
        assert.equal(verifyReceipt({ ...good, receipt: r, signature: sig, resultReceiptHashOnChain: committedHash(r, sig) }).checks.escrow_ref_matches.state, 'fail', spelled);
      }
    });
  });

  describe('(2) sha256(result) equals response_hash', () => {
    test('without the report text the check is skipped, never passed, and the verdict is not "verified"', () => {
      const v = verifyReceipt({ ...good, result: undefined });
      assert.deepEqual(statesOf(v), { ...PASSING, response_hash_matches: 'skipped' });
      assert.equal(v.checks.response_hash_matches.note, 'no report text given');
      assert.equal(v.verdict, 'incomplete');
    });
    test('a report text that is not the one the supplier hashed fails, whatever the difference', () => {
      for (const result of ['the output!', 'The output', 'the output ', ' the output', 'the  output', '']) {
        const v = verifyReceipt({ ...good, result });
        assert.equal(v.checks.response_hash_matches.state, 'fail', JSON.stringify(result));
        assert.equal(v.verdict, 'failed');
      }
    });
    test('an empty report text that is the one the supplier hashed passes: given is not the same as non-empty', () => {
      const r = receiptOf(SUPPLIER_KEY, ESCROW_REF, '');
      const sig = signWith(SUPPLIER_KEY, r);
      const v = verifyReceipt({ ...good, receipt: r, signature: sig, result: '', resultReceiptHashOnChain: committedHash(r, sig) });
      assert.equal(v.verdict, 'verified');
    });
    test('the text is hashed as UTF-8, exactly as given: no normalisation', () => {
      const composed = 'café';
      const r = receiptOf(SUPPLIER_KEY, ESCROW_REF, composed);
      const sig = signWith(SUPPLIER_KEY, r);
      const input = { ...good, receipt: r, signature: sig, resultReceiptHashOnChain: committedHash(r, sig) };
      assert.equal(verifyReceipt({ ...input, result: composed }).verdict, 'verified');
      assert.equal(verifyReceipt({ ...input, result: 'café' }).checks.response_hash_matches.state, 'fail');
    });
    test('a response_hash that is not a hash fails the check', () => {
      for (const response_hash of [undefined, 7, null, '', 'abc']) {
        const r = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { response_hash });
        const sig = signWith(SUPPLIER_KEY, r);
        assert.equal(verifyReceipt({ ...good, receipt: r, signature: sig, resultReceiptHashOnChain: committedHash(r, sig) }).checks.response_hash_matches.state, 'fail', String(response_hash));
      }
    });
  });

  describe('(3) the supplier public key hashes to receipt.supplier_pkh and to the escrow\'s supplier_pkh', () => {
    test('another supplier\'s key is neither, and it cannot sign this receipt either', () => {
      const v = verifyReceipt({ ...good, supplierPubKeyHex: pubHexOf(OTHER_KEY) });
      assert.deepEqual(statesOf(v), { ...PASSING, supplier_key_matches: 'fail', signature_valid: 'fail' });
      assert.equal(v.checks.supplier_key_matches.note, 'the key hashes to neither receipt.supplier_pkh nor the escrow\'s supplier_pkh');
      assert.equal(v.verdict, 'failed');
    });
    test('a key that is the receipt\'s supplier but not the escrow\'s fails, and so does the other way round', () => {
      const v1 = verifyReceipt({ ...good, escrowSupplierPkh: pkhOf(OTHER_KEY) });
      assert.equal(v1.checks.supplier_key_matches.state, 'fail');
      assert.equal(v1.checks.supplier_key_matches.note, 'the key does not hash to the escrow\'s supplier_pkh');
      assert.equal(v1.checks.signature_valid.state, 'pass', 'the signature itself is fine: the key just is not the escrow\'s supplier');
      // a receipt that names another supplier than the one that signed it
      const r = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { supplier_pkh: pkhOf(OTHER_KEY) });
      const sig = signWith(SUPPLIER_KEY, r);
      const v2 = verifyReceipt({ ...good, receipt: r, signature: sig, resultReceiptHashOnChain: committedHash(r, sig) });
      assert.equal(v2.checks.supplier_key_matches.state, 'fail');
      assert.equal(v2.checks.supplier_key_matches.note, 'the key does not hash to receipt.supplier_pkh');
    });
    test('the hashes are compared in lower case: the datum\'s hex and the receipt\'s may be spelled either way', () => {
      const r = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { supplier_pkh: pkhOf(SUPPLIER_KEY).toUpperCase() });
      const sig = signWith(SUPPLIER_KEY, r);
      const v = verifyReceipt({ ...good, receipt: r, signature: sig, escrowSupplierPkh: pkhOf(SUPPLIER_KEY).toUpperCase(), resultReceiptHashOnChain: committedHash(r, sig) });
      assert.equal(v.verdict, 'verified');
    });
    test('a key that is not 32 bytes of hex, or not a key at all, fails the check and leaves nothing to sign with', () => {
      const keys = ['', 'zz', pubHexOf(SUPPLIER_KEY).slice(0, 62), pubHexOf(SUPPLIER_KEY) + '00', 'g'.repeat(64), ` ${pubHexOf(SUPPLIER_KEY)}`, undefined, null, 7];
      for (const supplierPubKeyHex of keys) {
        const v = verifyReceipt({ ...good, supplierPubKeyHex: supplierPubKeyHex as never });
        assert.equal(v.checks.supplier_key_matches.state, 'fail', String(supplierPubKeyHex));
        assert.equal(v.checks.signature_valid.state, 'fail', String(supplierPubKeyHex));
        assert.equal(v.verdict, 'failed');
      }
    });
  });

  describe('(4) Ed25519 over canonicalize(receipt) verifies', () => {
    test('a receipt signed by another key fails the signature, though the key given is the supplier\'s', () => {
      const v = verifyReceipt({ ...good, signature: signWith(OTHER_KEY, receipt) });
      assert.equal(v.checks.signature_valid.state, 'fail');
      assert.equal(v.checks.supplier_key_matches.state, 'pass');
      assert.equal(v.verdict, 'failed');
    });
    test('a field edited after signing fails, though every hash in it still matches', () => {
      const v = verifyReceipt({ ...good, receipt: { ...receipt, model: 'something-else-v9' } });
      assert.equal(v.checks.signature_valid.state, 'fail');
      assert.equal(v.checks.escrow_ref_matches.state, 'pass');
      assert.equal(v.checks.response_hash_matches.state, 'pass');
    });
    test('a signature that is not 64 bytes of hex fails without throwing', () => {
      for (const sig of ['', 'zz', signature.slice(0, 126), signature + '00', 'g'.repeat(128), undefined, null, 7]) {
        const v = verifyReceipt({ ...good, signature: sig as never });
        assert.equal(v.checks.signature_valid.state, 'fail', String(sig));
        assert.equal(v.verdict, 'failed');
      }
    });
  });

  describe('(5) the Submitted escrow\'s result_receipt_hash equals sha256(canonicalize({receipt, signature}))', () => {
    test('a hash on chain that is not the hash of this signed receipt fails', () => {
      for (const other of ['cd'.repeat(32), committedHash(receipt, signWith(OTHER_KEY, receipt)), committedHash({ ...receipt, model: 'x' }, signature)]) {
        const v = verifyReceipt({ ...good, resultReceiptHashOnChain: other });
        assert.equal(v.checks.on_chain_hash_matches.state, 'fail');
        assert.equal(v.verdict, 'failed');
      }
    });
    test('the hash on chain is compared in lower case', () => {
      assert.equal(verifyReceipt({ ...good, resultReceiptHashOnChain: onChain.toUpperCase() }).verdict, 'verified');
    });
    test('no hash to compare is a skipped check, with the reason it is given or a plain one, and never "verified"', () => {
      const plain = verifyReceipt({ ...good, resultReceiptHashOnChain: null });
      assert.deepEqual(statesOf(plain), { ...PASSING, on_chain_hash_matches: 'skipped' });
      assert.equal(plain.checks.on_chain_hash_matches.note, 'Submitted output not locatable');
      assert.equal(plain.verdict, 'incomplete');
      const told = verifyReceipt({ ...good, resultReceiptHashOnChain: null, onChainNote: 'the escrow is Claimed' });
      assert.equal(told.checks.on_chain_hash_matches.note, 'the escrow is Claimed');
    });
  });

  describe('the verdict', () => {
    test('a failed check outweighs a skipped one', () => {
      const v = verifyReceipt({ ...good, result: undefined, escrowRef: `${'b'.repeat(64)}#0` });
      assert.deepEqual(statesOf(v), { ...PASSING, escrow_ref_matches: 'fail', response_hash_matches: 'skipped' });
      assert.equal(v.verdict, 'failed');
    });
    test('two skipped checks and nothing failed is incomplete', () => {
      const v = verifyReceipt({ ...good, result: undefined, resultReceiptHashOnChain: null });
      assert.equal(v.verdict, 'incomplete');
    });
    test('"verified" is the verdict of a receipt only when every row passed, the extra one included', () => {
      const breaks: Array<[string, Partial<VerifyInput>]> = [
        ['escrow', { escrowRef: `${'b'.repeat(64)}#0` }], ['result', { result: 'x' }], ['no result', { result: undefined }], ['key', { supplierPubKeyHex: pubHexOf(OTHER_KEY) }],
        ['escrow supplier', { escrowSupplierPkh: pkhOf(OTHER_KEY) }], ['signature', { signature: signWith(OTHER_KEY, receipt) }], ['chain', { resultReceiptHashOnChain: 'cd'.repeat(32) }], ['no chain', { resultReceiptHashOnChain: null }],
        ['prompt', { escrowPromptHash: 'ab'.repeat(32) }],
      ];
      for (const [name, change] of breaks) assert.notEqual(verifyReceipt({ ...good, ...change }).verdict, 'verified', name);
    });
  });

  test('a receipt that is not a JSON object fails every check that reads it, without throwing', () => {
    for (const bad of [null, undefined, [], [receipt], 'a string', 7, true]) {
      const v = verifyReceipt({ ...good, receipt: bad });
      assert.equal(v.verdict, 'failed', JSON.stringify(bad));
      for (const [name, check] of Object.entries(v.checks)) assert.equal(check.state, 'fail', `${name} for ${JSON.stringify(bad)}`);
      assert.equal(v.checks.escrow_ref_matches.note, 'the receipt is not a JSON object');
    }
    // with no report text and nothing on chain, those two checks have nothing to read it for
    const v = verifyReceipt({ ...good, receipt: null, result: undefined, resultReceiptHashOnChain: null });
    assert.deepEqual(statesOf(v), { escrow_ref_matches: 'fail', response_hash_matches: 'skipped', supplier_key_matches: 'fail', signature_valid: 'fail', on_chain_hash_matches: 'skipped', prompt_hash_matches: 'fail' });
  });

  // Not one of the design's five, and it counts all the same: a receipt made for another request is not a good one. The template
  // checks the request against the escrow's prompt_hash before it claims, so for a template supplier the two always agree.
  describe('extra: the receipt prompt_hash equals the escrow prompt_hash', () => {
    test('a receipt made for another request fails that row only, and the verdict with it', () => {
      const r = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { prompt_hash: promptHashForPayload('another request') });
      const sig = signWith(SUPPLIER_KEY, r);
      const v = verifyReceipt({ ...good, receipt: r, signature: sig, resultReceiptHashOnChain: committedHash(r, sig) });
      assert.deepEqual(statesOf(v), { ...PASSING, prompt_hash_matches: 'fail' });
      assert.equal(v.checks.prompt_hash_matches.note, "the receipt's prompt_hash is not the escrow's prompt_hash: it was made for another request");
      assert.equal(v.verdict, 'failed');
    });
    test('the hashes are compared in lower case, and a receipt without a prompt_hash fails', () => {
      const upper = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { prompt_hash: promptHashForPayload(PAYLOAD).toUpperCase() });
      const sig = signWith(SUPPLIER_KEY, upper);
      assert.equal(verifyReceipt({ ...good, receipt: upper, signature: sig, resultReceiptHashOnChain: committedHash(upper, sig) }).verdict, 'verified');
      for (const prompt_hash of [undefined, 7, null, '', ['x']]) {
        const r = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { prompt_hash });
        const s = signWith(SUPPLIER_KEY, r);
        assert.equal(verifyReceipt({ ...good, receipt: r, signature: s, resultReceiptHashOnChain: committedHash(r, s) }).checks.prompt_hash_matches.state, 'fail', String(prompt_hash));
      }
    });
  });
});

// verifyJob reads what the five checks need and runs them: the escrow's Post output (its supplier), the supplier's key (the caller's, or
// the supplier's own GET /capability at the endpoint of the advert the escrow names), and the Submitted output the escrow has now.
describe('verifyJob', () => {
  const receipt = receiptOf(SUPPLIER_KEY, ESCROW_REF);
  const signature = signWith(SUPPLIER_KEY, receipt);
  const CAPABILITY = `${SUPPLIER}/capability`;
  /** A supplier whose GET /capability serves `body`. */
  const serving = (body: unknown, status = 200) => (call: Call) => (call.url === CAPABILITY ? reply(status, body) : reply(404, { reason: 'not_found' }));
  const submitted = (o: Scenario = {}) => scenario({ escrow: 'submitted', supplierPkh: pkhOf(SUPPLIER_KEY), receiptHash: committedHash(receipt, signature), answer: serving({ pub_key_hex: pubHexOf(SUPPLIER_KEY) }), ...o });
  const input = { receipt, signature, result: RESULT };
  /** The error names the escrow and carries nothing the supplier or the network said. */
  const plainly = (message: string) => {
    assert.ok(message.includes(ESCROW_REF), message);
    for (const secret of ['203.0.113.7', '203.0.113.99', '169.254.169.254', '192.168.1.10', 'evil.example', 'hunter2', 'internal.koios.example', 'user:pw', 'Bad gateway']) assert.ok(!message.includes(secret), `${secret} leaked into: ${message}`);
  };

  test('reads the key from the supplier\'s /capability and the hash from the Submitted output, and says verified', async () => {
    const s = submitted();
    const v = await s.verify(input);
    assert.equal(v.verdict, 'verified');
    assert.deepEqual(statesOf(v), PASSING);
    assert.equal(v.escrowRef, ESCROW_REF);
    assert.equal(v.supplierPkh, pkhOf(SUPPLIER_KEY), 'the supplier the escrow\'s datum names');
    assert.equal(v.keyFrom, 'capability');
    assert.equal(v.submittedRef, `${SUBMIT_TX}#0`);
    // one GET, to the endpoint of the escrow\'s advert, carrying nothing about the escrow or the job
    assert.deepEqual(s.sup.calls, [{ url: CAPABILITY, method: 'GET', headers: { accept: 'application/json' }, body: '' }]);
    assert.equal(s.advertReads(), 1);
    assert.ok(s.koios.calls.every((c) => c.url?.startsWith(`${KOIOS}/api/v1/`)), 'one decision draws on one Koios');
  });
  test('a key the caller gives is used and the supplier is not called: the key still has to be the escrow\'s supplier', async () => {
    const s = submitted();
    const v = await s.verify({ ...input, supplierPubKeyHex: pubHexOf(SUPPLIER_KEY) });
    assert.equal(v.verdict, 'verified');
    assert.equal(v.keyFrom, 'argument');
    assert.equal(s.sup.calls.length, 0);
    assert.equal(s.advertReads(), 0);
    const wrong = await submitted().verify({ ...input, supplierPubKeyHex: pubHexOf(OTHER_KEY) });
    assert.equal(wrong.verdict, 'failed');
    assert.equal(wrong.checks.supplier_key_matches.state, 'fail');
  });
  test('a supplier that serves another key than its escrow\'s supplier cannot pass, whatever it signed and committed', async () => {
    // a dishonest endpoint serves a self-consistent set: its own key, a receipt naming that key, a signature, and (it controls its
    // own chain data too) a hash that matches. Only the escrow's supplier_pkh, which the buyer paid against, is outside its control.
    const forged = receiptOf(OTHER_KEY, ESCROW_REF);
    const sig = signWith(OTHER_KEY, forged);
    const s = submitted({ receiptHash: committedHash(forged, sig), answer: serving({ pub_key_hex: pubHexOf(OTHER_KEY) }) });
    const v = await s.verify({ receipt: forged, signature: sig, result: RESULT });
    assert.equal(v.verdict, 'failed');
    assert.deepEqual(statesOf(v), { ...PASSING, supplier_key_matches: 'fail' });
  });
  test('without the report text the verdict is incomplete, and the other four checks still ran', async () => {
    const v = await submitted().verify({ receipt, signature });
    assert.equal(v.verdict, 'incomplete');
    assert.deepEqual(statesOf(v), { ...PASSING, response_hash_matches: 'skipped' });
    assert.equal(v.checks.response_hash_matches.note, 'no report text given');
  });
  test('a receipt for another escrow, or a report text that is not the supplier\'s, fails', async () => {
    const other = receiptOf(SUPPLIER_KEY, `${'b'.repeat(64)}#0`);
    const sig = signWith(SUPPLIER_KEY, other);
    const v1 = await submitted({ receiptHash: committedHash(other, sig) }).verify({ receipt: other, signature: sig, result: RESULT });
    assert.deepEqual(statesOf(v1), { ...PASSING, escrow_ref_matches: 'fail' });
    const v2 = await submitted().verify({ ...input, result: 'something else' });
    assert.deepEqual(statesOf(v2), { ...PASSING, response_hash_matches: 'fail' });
  });
  test('a receipt made for another request than the one the escrow committed to fails the extra row, whatever else it passes', async () => {
    const other = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { prompt_hash: promptHashForPayload('another request') });
    const sig = signWith(SUPPLIER_KEY, other);
    const s = submitted({ receiptHash: committedHash(other, sig) });
    const v = await s.verify({ receipt: other, signature: sig, result: RESULT });
    assert.deepEqual(statesOf(v), { ...PASSING, prompt_hash_matches: 'fail' });
    assert.equal(v.verdict, 'failed');
    assert.equal(s.posted.prompt_hash, promptHashForPayload(PAYLOAD), 'the escrow committed to the payload it was posted with');
    // and an escrow posted with another payload takes a receipt for that one
    const posted = submitted({ committed: 'another request', receiptHash: committedHash(other, sig) });
    assert.equal((await posted.verify({ receipt: other, signature: sig, result: RESULT })).verdict, 'verified');
  });
  test('the escrow ref may be spelled in any case with spaces around it: the receipt is checked against the canonical ref', async () => {
    const v = await submitted().verify({ ...input, escrowRef: ` ${ESCROW_REF.toUpperCase()} ` });
    assert.equal(v.verdict, 'verified');
    assert.equal(v.escrowRef, ESCROW_REF);
  });

  // The Submitted output is read by its ref from utxo_info, which answers for a spent output too (Koios keeps the datum after the
  // Accept): an Accept that lands after the escrow was resolved does not take the hash away.
  test('the hash is read from the Submitted output by its ref, whether or not Koios says it is spent by then', async () => {
    for (const submittedSpent of [false, true]) {
      const s = submitted({ submittedSpent });
      const v = await s.verify(input);
      assert.equal(v.verdict, 'verified', `spent: ${submittedSpent}`);
      const reads = s.koios.calls.filter((c) => c.path === '/api/v1/utxo_info').flatMap((c) => c.body._utxo_refs as string[]);
      assert.equal(reads.filter((ref) => ref === `${SUBMIT_TX}#0`).length, 1, 'the Submitted output is asked for once, by its ref');
      assert.equal(reads.at(-1), `${SUBMIT_TX}#0`, 'and last, after the resolver has found it');
    }
  });

  test('a Submitted output that Koios describes differently by its ref than the lineage found it is not trusted: the hash check is skipped', async () => {
    const s = submitted();
    const lying = (async (url: string, init: { body: string }) => {
      const res = await s.fetchImpl(url, init as never);
      if (!String(url).endsWith('/api/v1/utxo_info') || !(JSON.parse(init.body)._utxo_refs as string[]).includes(`${SUBMIT_TX}#0`)) return res;
      const rows = (await res.json()) as Array<{ tx_hash: string; inline_datum: { bytes: string } }>;
      for (const row of rows) if (row.tx_hash === SUBMIT_TX) row.inline_datum.bytes = encodeEscrowDatum({ ...decodeEscrowDatum(row.inline_datum.bytes), result_receipt_hash: 'ee'.repeat(32) });
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as unknown as typeof fetch;
    const v = await verifyJob(s.node, KOIOS, { escrowRef: ESCROW_REF, ...input }, lying);
    assert.equal(v.verdict, 'incomplete');
    assert.deepEqual(statesOf(v), { ...PASSING, on_chain_hash_matches: 'skipped' });
    assert.equal(v.checks.on_chain_hash_matches.note, `Koios describes the Submitted output ${SUBMIT_TX}#0 differently when it is read by its ref; its receipt hash is not used`);
    assert.equal(v.submittedRef, null);
  });
  test('a Submitted output that cannot be read by its ref skips the hash check, with the status and none of what Koios said', async () => {
    const s = submitted();
    const failing = (async (url: string, init: { body: string }) => {
      if (String(url).endsWith('/api/v1/utxo_info') && (JSON.parse(init.body)._utxo_refs as string[]).includes(`${SUBMIT_TX}#0`)) return new Response(HOSTILE, { status: 502 });
      return s.fetchImpl(url, init as never);
    }) as unknown as typeof fetch;
    const v = await verifyJob(s.node, KOIOS, { escrowRef: ESCROW_REF, ...input }, failing);
    assert.equal(v.verdict, 'incomplete');
    assert.equal(v.checks.on_chain_hash_matches.note, `the Submitted output ${SUBMIT_TX}#0 could not be read by its ref: Could not read escrow ${SUBMIT_TX}#0: Koios utxo_info answered 502`);
    assert.ok(!v.checks.on_chain_hash_matches.note.includes('hunter2'));
  });

  // (5) needs the Submitted output of the escrow, and the escrow can be in any state: not submitted yet, live and Submitted, or settled
  // (its Submitted output spent by the Accept or the Release). The other rows never depend on it.
  test('an escrow the supplier has not submitted has no hash on chain: the check is skipped, with the state, and the indexer is not asked', async () => {
    for (const escrow of ['open', 'claimed'] as const) {
      const s = submitted({ escrow });
      const v = await s.verify(input);
      assert.equal(v.verdict, 'incomplete', escrow);
      assert.deepEqual(statesOf(v), { ...PASSING, on_chain_hash_matches: 'skipped' }, escrow);
      assert.equal(v.checks.on_chain_hash_matches.note, `the escrow is ${escrow === 'open' ? 'Open' : 'Claimed'}: the supplier has not put a receipt hash on chain`, escrow);
      assert.deepEqual([v.submittedRef, v.submittedSpent, v.submittedVia], [null, null, null]);
      assert.deepEqual(s.indexerCalls(), [], `${escrow}: a live output that is not Submitted leaves nothing for the indexer to find`);
    }
  });

  describe('a settled escrow: the Submitted output is located through the marketplace indexer', () => {
    test('the indexer says where it was, Koios supplies the bytes, the spend chain proves it is the escrow\'s, and the receipt is verified', async () => {
      const s = submitted({ escrow: 'finished' });
      const v = await s.verify(input);
      assert.equal(v.verdict, 'verified');
      assert.deepEqual(statesOf(v), PASSING);
      assert.deepEqual([v.submittedRef, v.submittedVia, v.submittedSpent], [`${SUBMIT_TX}#0`, 'indexer', true]);
      // asked once, for the buyer's escrows, and only after the lineage found nothing live
      assert.deepEqual(s.indexerCalls(), [`${INDEXER_URL}/escrows?buyer=${BUYER_PKH}`]);
      // the bytes the hash is compared with are Koios's, read by ref, spent as the output is
      const reads = s.koios.calls.filter((c) => c.path === '/api/v1/utxo_info').flatMap((c) => c.body._utxo_refs as string[]);
      assert.equal(reads.filter((ref) => ref === `${SUBMIT_TX}#0`).length, 1);
      // and the proof asks Koios about the transaction that made the output, then about the one that made the output it spent
      assert.deepEqual(txInfoRequests(s.koios).map((c) => c.body._tx_hashes), [[SUBMIT_TX], [CLAIM_TX]]);
    });
    test('the rows of other escrows of the same buyer, with the same supplier, advert and payload, are other escrows', async () => {
      // the same hire made again differs from this one in posted_at and deliver_by only: that is a different escrow, not a second match
      const again = (ref: string, over: Record<string, unknown>) => (honest: unknown[]) => [...honest, { ...(honest.at(-1) as object), utxo_ref: ref, ...over }];
      for (const [name, over] of [['posted_at', { posted_at: 1 }], ['deliver_by', { deliver_by: 2 }], ['prompt_hash', { prompt_hash: 'ab'.repeat(32) }], ['payment', { payment_lovelace: '1' }]] as const) {
        const v = await submitted({ escrow: 'finished', indexer: { rows: again(`${'f1'.repeat(32)}#0`, over) } }).verify(input);
        assert.equal(v.verdict, 'verified', name);
        assert.equal(v.submittedRef, `${SUBMIT_TX}#0`, name);
      }
    });
    test('rows that are not rows, rows in other states and rows with no usable ref are passed over', async () => {
      const junk = (honest: unknown[]) => [null, 7, 'row', [], {}, { state: 'Submitted' }, { ...(honest.at(-1) as object), utxo_ref: 'nope' }, { ...(honest.at(-1) as object), utxo_ref: 7 }, ...honest];
      const v = await submitted({ escrow: 'finished', indexer: { rows: junk } }).verify(input);
      assert.equal(v.verdict, 'verified');
      assert.equal(v.submittedRef, `${SUBMIT_TX}#0`);
    });
    test('no Submitted row of the escrow is no answer: the check is skipped, with the reason', async () => {
      for (const rows of [[], (honest: unknown[]) => honest.slice(0, 2)]) {
        const v = await submitted({ escrow: 'finished', indexer: { rows } }).verify(input);
        assert.equal(v.verdict, 'incomplete');
        assert.deepEqual(statesOf(v), { ...PASSING, on_chain_hash_matches: 'skipped' });
        assert.equal(v.checks.on_chain_hash_matches.note, 'Submitted output not locatable: the escrow has no live output, and the indexer lists no Submitted output of it');
        assert.deepEqual([v.submittedRef, v.submittedSpent, v.submittedVia], [null, null, null]);
      }
    });
    test('two Submitted outputs that match are no answer either: the check is skipped, and the one the caller names decides', async () => {
      const s = submitted({ escrow: 'finished', decoySubmitted: true });
      const v = await s.verify(input);
      assert.equal(v.verdict, 'incomplete');
      assert.equal(v.checks.on_chain_hash_matches.note, 'Submitted output not locatable: the indexer lists 2 Submitted outputs that match this escrow; pass submitted_ref to name the one');
      assert.equal(v.submittedRef, null);
      // naming the escrow's own output settles it, and naming the copy does not: the copy does not descend from the escrow
      const own = await submitted({ escrow: 'finished', decoySubmitted: true }).verify({ ...input, submittedRef: `${SUBMIT_TX}#0` });
      assert.equal(own.verdict, 'verified');
      const copy = await submitted({ escrow: 'finished', decoySubmitted: true }).verify({ ...input, submittedRef: DECOY_SUBMITTED_REF });
      assert.equal(copy.verdict, 'incomplete');
      assert.match(copy.checks.on_chain_hash_matches.note, new RegExp(`^Submitted output not locatable: the one you gave was refused: UTxO ${DECOY_SUBMITTED_REF} does not belong to escrow ${ESCROW_REF}: it carries the escrow's fields, but it does not descend from that escrow by the spend chain\\.$`));
    });
    test('a copy that the indexer names alone is refused by the spend chain, and the hash it carries is never used', async () => {
      // the copy carries a receipt hash of its own: a receipt made to match it would pass if the indexer's word were enough
      const forged = receiptOf(SUPPLIER_KEY, ESCROW_REF, RESULT, { model: 'forged' });
      const sig = signWith(SUPPLIER_KEY, forged);
      const s = submitted({ escrow: 'finished', decoySubmitted: true, decoyHash: committedHash(forged, sig), indexer: { rows: (_honest, decoy) => [decoy] } });
      const v = await verifyJob(s.node, KOIOS, { escrowRef: ESCROW_REF, receipt: forged, signature: sig, result: RESULT }, s.fetchImpl);
      assert.equal(v.verdict, 'incomplete');
      assert.match(v.checks.on_chain_hash_matches.note, new RegExp(`^Submitted output not locatable: the indexer lists ${DECOY_SUBMITTED_REF}, which was refused: UTxO ${DECOY_SUBMITTED_REF} does not belong to escrow ${ESCROW_REF}: it carries the escrow's fields, but it does not descend`));
      assert.equal(v.submittedRef, null);
    });
    test('a copy that stops the lineage does not stop the located check, and says so when the indexer finds nothing either', async () => {
      const found = await submitted({ escrow: 'finished', decoy: true }).verify(input);
      assert.equal(found.verdict, 'verified');
      assert.equal(found.submittedVia, 'indexer');
      const lost = await submitted({ escrow: 'finished', decoy: true, indexer: { rows: [] } }).verify(input);
      assert.equal(lost.verdict, 'incomplete');
      assert.match(lost.checks.on_chain_hash_matches.note, /^Submitted output not locatable: the escrow's live output could not be resolved \(None of .* descends from escrow .* by the spend chain.*\), and the indexer lists no Submitted output of it$/);
    });
    test('an indexer that cannot be asked, or answers with something else than a list, skips the check in words that carry nothing it said', async () => {
      const cases: Array<[NonNullable<Scenario['indexer']>, string]> = [
        [{ status: 502 }, 'list escrows: indexer answered 502'],
        [{ timesOut: true }, 'list escrows: indexer list read timed out after 14 bytes'],
        [{ raw: `["${'x'.repeat(ESCROWS_MAX_BYTES)}"]` }, `list escrows: the answer is over the ${ESCROWS_MAX_BYTES} byte limit`],
        [{ raw: '<html>Bad gateway password=hunter2</html>' }, 'list escrows: response was not valid JSON'],
        [{ raw: '{"rows":[]}' }, 'list escrows: indexer returned a non-list response'],
        [{ fails: new TypeError('fetch failed: connect ECONNREFUSED internal.koios.example:443 password=hunter2') }, 'the request failed (network error or timeout)'],
      ];
      for (const [indexer, why] of cases) {
        const v = await submitted({ escrow: 'finished', indexer }).verify(input);
        assert.equal(v.verdict, 'incomplete', why);
        assert.equal(v.checks.on_chain_hash_matches.note, `Submitted output not locatable: the escrow has no live output, and the indexer could not be asked (${why})`);
        for (const secret of ['hunter2', 'internal.koios.example', 'Bad gateway', INDEXER_URL]) assert.ok(!v.checks.on_chain_hash_matches.note.includes(secret), `${secret} leaked`);
      }
    });
    test('what Koios says of the output decides, not the row: a datum that differs, a value that differs, or a transaction Koios does not know refuses it', async () => {
      const s = submitted({ escrow: 'finished' });
      const through = (change: (row: Record<string, any>) => void, hideTx?: string): typeof fetch => (async (url: string, init: { body: string }) => {
        const res = await s.fetchImpl(url, init as never);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}; // the supplier's GET carries none
        if (String(url).endsWith('/api/v1/utxo_info') && (body._utxo_refs as string[]).includes(`${SUBMIT_TX}#0`)) {
          const rows = (await res.json()) as Array<Record<string, any>>;
          for (const row of rows) if (row.tx_hash === SUBMIT_TX) change(row);
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (hideTx !== undefined && String(url).endsWith('/api/v1/tx_info') && (body._tx_hashes as string[]).includes(hideTx)) return new Response('[]', { status: 200 });
        return res;
      }) as unknown as typeof fetch;
      const check = async (fetchImpl: typeof fetch, expected: RegExp) => {
        const v = await verifyJob(s.node, KOIOS, { escrowRef: ESCROW_REF, ...input }, fetchImpl);
        assert.equal(v.verdict, 'incomplete');
        assert.match(v.checks.on_chain_hash_matches.note, expected);
      };
      const datumWith = (row: Record<string, any>, over: Partial<EscrowDatum>) => { row.inline_datum.bytes = encodeEscrowDatum({ ...decodeEscrowDatum(row.inline_datum.bytes), ...over }); };
      await check(through((row) => datumWith(row, { payment_lovelace: 100_000n })), new RegExp(`UTxO ${SUBMIT_TX}#0 does not belong to escrow ${ESCROW_REF}: its datum differs from that escrow's in payment_lovelace, which Claim and Submit leave unchanged\\.$`));
      await check(through((row) => { row.value = '9999999'; }), new RegExp(`UTxO ${SUBMIT_TX}#0 does not belong to escrow ${ESCROW_REF}: it holds 9999999 lovelace where the Post output held 2261030\\.$`));
      await check(through((row) => datumWith(row, { state: 'Claimed', submitted_at: null, result_receipt_hash: null })), new RegExp(`UTxO ${SUBMIT_TX}#0 is not a Submitted output: its datum is in state Claimed\\.$`));
      await check(through((row) => datumWith(row, { result_receipt_hash: null })), new RegExp(`UTxO ${SUBMIT_TX}#0 is a Submitted output without a receipt hash\\.$`));
      await check(through(() => {}, SUBMIT_TX), new RegExp(`Cannot tell whether UTxO ${SUBMIT_TX}#0 belongs to escrow ${ESCROW_REF}: Koios does not know the transaction behind it yet; retry in a few seconds\\.$`));
      await check(through((row) => { row.address = ADVERT_ADDRESS; }), new RegExp(`UTxO ${SUBMIT_TX}#0 is not an escrow output: its payment credential is not the escrow script's\\.$`));
    });
  });

  describe('a Submitted output the caller names', () => {
    test('needs no lookup - not the lineage and not the indexer - and is held to the same proof, live or settled', async () => {
      for (const escrow of ['submitted', 'finished'] as const) {
        const s = submitted({ escrow, indexer: { fails: new Error('the indexer must not be asked') } });
        const v = await s.verify({ ...input, submittedRef: ` ${SUBMIT_TX.toUpperCase()}#0 ` });
        assert.equal(v.verdict, 'verified', escrow);
        assert.deepEqual([v.submittedRef, v.submittedVia, v.submittedSpent], [`${SUBMIT_TX}#0`, 'argument', escrow === 'finished'], escrow);
        assert.deepEqual(s.indexerCalls(), [], escrow);
        assert.equal(credentialRequests(s.koios).length, 0, `${escrow}: no lineage was walked`);
        assert.deepEqual(txInfoRequests(s.koios).map((c) => c.body._tx_hashes), [[SUBMIT_TX], [CLAIM_TX]], escrow);
      }
    });
    test('that is not a Submitted output of the escrow is refused, and the check is skipped with the reason', async () => {
      const s = submitted({ escrow: 'submitted' });
      const post = await s.verify({ ...input, submittedRef: ESCROW_REF });
      assert.equal(post.verdict, 'incomplete');
      assert.equal(post.checks.on_chain_hash_matches.note, `Submitted output not locatable: the one you gave was refused: UTxO ${ESCROW_REF} is not a Submitted output: its datum is in state Open.`);
      const nowhere = await s.verify({ ...input, submittedRef: `${'ab'.repeat(32)}#3` });
      assert.equal(nowhere.checks.on_chain_hash_matches.note, `Submitted output not locatable: the one you gave was refused: Escrow ${'ab'.repeat(32)}#3 not found on the ledger.`);
      assert.deepEqual([nowhere.submittedRef, nowhere.submittedVia], [null, null]);
    });
    test('that is no ref at all is an error before anything is asked', async () => {
      const s = submitted();
      await assert.rejects(s.verify({ ...input, submittedRef: 'nope#1' }), /Invalid out ref "nope#1"/);
      assert.equal(s.koios.calls.length, 0);
    });
  });

  test('the live Submitted output is found on chain and the indexer is not asked; the Accept landing in between makes it spent and nothing else', async () => {
    for (const submittedSpent of [false, true]) {
      const s = submitted({ submittedSpent });
      const v = await s.verify(input);
      assert.equal(v.verdict, 'verified');
      assert.deepEqual([v.submittedRef, v.submittedVia, v.submittedSpent], [`${SUBMIT_TX}#0`, 'lineage', submittedSpent]);
      assert.deepEqual(s.indexerCalls(), []);
    }
  });
  test('a ref that names a later output of the escrow is refused: the receipt names the Post output', async () => {
    await rejectsWith(submitted({ escrow: 'claimed', names: 'claimed-output' }).verify(input), (message) => {
      assert.equal(message, `Cannot verify a receipt for escrow ${CLAIM_TX}#0: it is a Claimed output, not the output its Post made: use the escrow ref the Post returned.`);
    });
    await rejectsWith(submitted({ names: 'accepted-output' }).verify(input), (message) => assert.match(message, /: it is an Accepted output, not the output its Post made/));
  });
  test('an escrow Koios does not know, or cannot be asked about, is an error that names the escrow', async () => {
    const failing = world([], { status: 502 });
    await rejectsWith(verifyJob(failing.node, KOIOS, { escrowRef: ESCROW_REF, ...input }, failing.koios.f), (message) => assert.equal(message, `Could not read escrow ${ESCROW_REF}: Koios utxo_info answered 502`));
  });

  describe('when the supplier\'s key cannot be read', () => {
    const readFails = (why: string) => `Cannot verify a receipt for escrow ${ESCROW_REF}: the supplier's public key could not be read (${why}); pass supplier_pub_key_hex.`;
    test('an answer that is not 200 is reported by its status alone', async () => {
      for (const status of [404, 500, 503]) {
        await rejectsWith(submitted({ answer: serving({ reason: 'advert_not_active', message: 'advert is retired (status=Retired) password=hunter2' }, status) }).verify(input), (message) => {
          plainly(message);
          assert.equal(message, readFails(`the supplier answered ${status}`));
        });
      }
    });
    test('an answer without a usable pub_key_hex is refused, and what it said instead is not repeated', async () => {
      const bad: unknown[] = [{}, { pub_key_hex: 7 }, { pub_key_hex: '' }, { pub_key_hex: 'zz' }, { pub_key_hex: pubHexOf(SUPPLIER_KEY).slice(2) }, { pub_key_hex: `${pubHexOf(SUPPLIER_KEY)}00` }, { pub_key_hex: ['x'] }, [pubHexOf(SUPPLIER_KEY)], 'not json password=hunter2', '', 'null'];
      for (const body of bad) {
        await rejectsWith(submitted({ answer: serving(body) }).verify(input), (message) => {
          plainly(message);
          assert.equal(message, readFails('its /capability answer has no usable pub_key_hex'), JSON.stringify(body));
        });
      }
    });
    test('the key is accepted in either case of hex and used in lower case', async () => {
      const v = await submitted({ answer: serving({ pub_key_hex: pubHexOf(SUPPLIER_KEY).toUpperCase() }) }).verify(input);
      assert.equal(v.verdict, 'verified');
    });
    test('a redirect is not followed, a private or reserved address is refused by the rule, and an endpoint that is not https never reaches the call', async () => {
      const redirect = submitted({ answer: () => new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }) });
      await rejectsWith(redirect.verify(input), (message) => { plainly(message); assert.equal(message, readFails('the supplier answered with a redirect, which is not followed')); });
      for (const endpoint of ['https://169.254.169.254/latest', 'https://192.168.1.10', 'https://127.0.0.1:8443']) {
        const s = submitted({ endpoint });
        await rejectsWith(s.verify(input), (message) => { plainly(message); assert.equal(message, readFails('the supplier host resolves to a private or reserved address, which is refused')); });
        assert.equal(s.sup.calls.length, 0, endpoint);
      }
      const plain = submitted({ endpoint: 'http://203.0.113.7' });
      await rejectsWith(plain.verify(input), (message) => assert.match(message, /^Cannot verify a receipt for escrow .*: the endpoint of its advert .* is not an https URL\.$/));
      assert.equal(plain.sup.calls.length, 0);
    });
    test('a connection that drops, and an answer over 64 KiB, are reported without what the network said', async () => {
      const dropped = submitted({ answer: () => { throw new TypeError('fetch failed: connect ECONNRESET 203.0.113.7:443 (evil.example)'); } });
      await rejectsWith(dropped.verify(input), (message) => { plainly(message); assert.equal(message, readFails('the request to the supplier failed (network error)')); });
      const big = submitted({ answer: () => reply(200, JSON.stringify({ pub_key_hex: pubHexOf(SUPPLIER_KEY), pad: 'x'.repeat(65_536) })) });
      await rejectsWith(big.verify(input), (message) => { plainly(message); assert.equal(message, readFails('the supplier\'s answer is over the 65536 byte limit')); });
      const exact = JSON.stringify({ pub_key_hex: pubHexOf(SUPPLIER_KEY), pad: '' });
      const fits = submitted({ answer: () => reply(200, JSON.stringify({ pub_key_hex: pubHexOf(SUPPLIER_KEY), pad: 'x'.repeat(65_536 - Buffer.byteLength(exact)) })) });
      assert.equal((await fits.verify(input)).verdict, 'verified', 'exactly 64 KiB is read');
    });
    test('a fleet supplier is out of scope where the endpoint is resolved, and a retired or spent advert is still where the key is', async () => {
      const fleet = submitted({ capability: 'ocr.page.extract.chandra-ocr-2.v1' });
      await rejectsWith(fleet.verify(input), (message) => assert.match(message, /^Cannot verify a receipt for escrow .*: ocr\.page\.extract\.chandra-ocr-2\.v1 uses the fleet route; this tool supports template-contract suppliers only in this release\.$/));
      assert.equal(fleet.sup.calls.length, 0);
      for (const advert of [{ status: 'Retired' as const }, { spent: true }, { spentUnreported: true }]) {
        assert.equal((await submitted({ advert }).verify(input)).verdict, 'verified', JSON.stringify(advert));
      }
    });
  });
});

describe('a supplier that never answers GET /capability', () => {
  afterEach(() => { mock.restoreAll(); });
  test('verifyJob gives up after 20 s and says to pass the key', async () => {
    const budgets: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    mock.method(AbortSignal, 'timeout', (ms: number) => { budgets.push(ms); return real(ms === 20_000 ? 30 : ms); });
    const hangs = (_call: Call, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const receipt = receiptOf(SUPPLIER_KEY, ESCROW_REF);
    const signature = signWith(SUPPLIER_KEY, receipt);
    const s = scenario({ escrow: 'submitted', supplierPkh: pkhOf(SUPPLIER_KEY), receiptHash: committedHash(receipt, signature), answer: hangs });
    await rejectsWith(heldOpen(s.verify({ receipt, signature, result: RESULT })), (message) => {
      assert.equal(message, `Cannot verify a receipt for escrow ${ESCROW_REF}: the supplier's public key could not be read (the supplier did not answer within 20 s); pass supplier_pub_key_hex.`);
    });
    assert.deepEqual(budgets.filter((ms) => ms === 20_000), [20_000], 'the key is asked for once, with a 20 s budget');
    assert.equal(s.sup.calls.length, 1);
  });
});

// The manifest an advert's detail_uri points to: fetched as every URL taken from chain data is, and reported without the URL.
describe('fetchManifest', () => {
  const URI = 'https://203.0.113.9/agents/manifest.json';
  const fetching = (answer: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; method: string; headers: unknown }> = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), method: String(init?.method ?? 'GET'), headers: init?.headers }); return answer(String(url), init); }) as unknown as typeof fetch;
    return { f, calls };
  };
  const plainly = (error: string) => { for (const secret of ['203.0.113.9', 'evil.example', 'hunter2', 'manifest.json', 'Bad gateway']) assert.ok(!error.includes(secret), `${secret} leaked into: ${error}`); };

  test('GETs the URI once, asking for JSON, and returns whatever JSON it serves', async () => {
    const manifest = { name: 'Chandra OCR', capabilities: ['ocr.page.extract.chandra-ocr-2.v1'], nested: { a: [1, 2, { b: null }] } };
    const { f, calls } = fetching(() => reply(200, manifest));
    assert.deepEqual(await fetchManifest(URI, f), { manifest });
    assert.deepEqual(calls, [{ url: URI, method: 'GET', headers: { accept: 'application/json' } }]);
    for (const served of [null, [], 7, 'text', true]) assert.deepEqual(await fetchManifest(URI, fetching(() => reply(200, JSON.stringify(served))).f), { manifest: served }, JSON.stringify(served));
  });
  test('an answer that is not 200, and one that is not JSON, are reported without what the host said', async () => {
    for (const status of [201, 206, 401, 404, 500, 503]) {
      const r = await fetchManifest(URI, fetching(() => reply(status, '{"error":"db password=hunter2"}')).f);
      assert.deepEqual(r, { error: `the supplier answered ${status}` });
    }
    for (const body of ['', '<html>Bad gateway password=hunter2</html>', '{"unfinished":', 'not json']) {
      const r = await fetchManifest(URI, fetching(() => reply(200, body)).f);
      assert.deepEqual(r, { error: 'its answer is not JSON' }, JSON.stringify(body));
    }
  });
  test('a redirect is not followed, a URI that is not https or is on a private or reserved address is refused, and none of it is repeated', async () => {
    const redirect = await fetchManifest(URI, fetching(() => new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } })).f);
    assert.deepEqual(redirect, { error: 'the supplier answered with a redirect, which is not followed' });
    const refused = [
      ['http://203.0.113.9/manifest.json', 'the supplier URL was refused by the outbound-call policy'],
      ['ipfs://bafybeigdyrzt/manifest.json', 'the supplier URL was refused by the outbound-call policy'],
      ['https://user:pw@203.0.113.9/manifest.json', 'the supplier URL was refused by the outbound-call policy'],
      ['not a url', 'the supplier URL was refused by the outbound-call policy'],
      ['https://169.254.169.254/latest/meta-data', 'the supplier host resolves to a private or reserved address, which is refused'],
      ['https://192.168.1.10/manifest.json', 'the supplier host resolves to a private or reserved address, which is refused'],
      ['https://[::1]/manifest.json', 'the supplier host resolves to a private or reserved address, which is refused'],
    ];
    for (const [uri, error] of refused) {
      const { f, calls } = fetching(() => reply(200, {}));
      const r = await fetchManifest(uri, f);
      assert.deepEqual(r, { error }, uri);
      assert.equal(calls.length, 0, `${uri} was fetched`);
      plainly((r as { error: string }).error);
    }
  });
  test('a connection that drops is reported as a network error, and the answer is read to 256 KiB and no further', async () => {
    const dropped = await fetchManifest(URI, fetching(() => { throw new TypeError('fetch failed: connect ECONNRESET 203.0.113.9:443 (evil.example)'); }).f);
    assert.deepEqual(dropped, { error: 'the request to the supplier failed (network error)' });
    const overhead = Buffer.byteLength(JSON.stringify({ pad: '' }));
    const sized = (bytes: number) => reply(200, JSON.stringify({ pad: 'x'.repeat(bytes - overhead) }));
    const full = await fetchManifest(URI, fetching(() => sized(262_144)).f);
    assert.ok('manifest' in full, 'exactly 256 KiB is read');
    assert.deepEqual(await fetchManifest(URI, fetching(() => sized(262_145)).f), { error: "the supplier's answer is over the 262144 byte limit" });
  });
});

describe('a manifest host that never answers', () => {
  afterEach(() => { mock.restoreAll(); });
  test('fetchManifest gives up after 15 s', async () => {
    const budgets: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    mock.method(AbortSignal, 'timeout', (ms: number) => { budgets.push(ms); return real(ms === 15_000 ? 30 : ms); });
    const hangs = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as unknown as typeof fetch;
    assert.deepEqual(await heldOpen(fetchManifest('https://203.0.113.9/manifest.json', hangs)), { error: 'the supplier did not answer within 15 s' });
    assert.deepEqual(budgets, [15_000], 'one call, one 15 s budget');
  });
});
