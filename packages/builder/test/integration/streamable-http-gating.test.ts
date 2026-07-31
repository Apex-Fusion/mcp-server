import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer, stopRawServer } from '../setup.ts';
import type { RawServerHandle } from '../setup.ts';

// Covers the /mcp Streamable HTTP route in packages/builder/src/index.ts - the
// modern, dual-stack sibling of the deprecated /sse + /messages pair that
// auth-gating.test.ts covers. Same two things at stake, same reason no unit
// test can see them: the exact status-code/header wiring against a real
// spawned server (401 checked before session lookup, 404 on an unknown
// session, 403 on cross-identity - on both POST and GET), and whether
// streamableTransports/streamableIdentities/streamableLastSeen actually
// drain on every teardown path: DELETE (onsessionclosed, then
// transport.onclose - redundant with each other on that one path), the idle
// reaper, and the per-identity session cap's eviction (the latter two only
// ever go through transport.onclose - see index.ts's own comment on that
// callback for why onsessionclosed does not cover them). The reaper and the
// cap exist because the SSE pair self-limits on an abrupt disconnect
// (res.on('close') drains its maps with no help from us) and /mcp does not:
// nothing tells the server a caller dropped its socket without DELETE, so an
// un-reaped session - transport, McpServer, and its 24 tools - would
// otherwise sit in memory until process exit. Both bounds are exercised
// below with env-shrunk thresholds (VECTOR_MCP_SESSION_IDLE_MS /
// VECTOR_MCP_SESSION_SWEEP_MS / VECTOR_MCP_MAX_SESSIONS_PER_IDENTITY), never
// the real multi-minute defaults.
//
// Mixed transport strategy, deliberately:
// - Case 1 uses the real SDK Client + StreamableHTTPClientTransport, to prove
//   a real client can drive this route end to end (not just that our own raw
//   assertions are self-consistent).
// - Every other case uses raw node:http, for the same reason auth-gating.test.ts
//   does: this file's point is exact status codes and exact headers, plus -
//   for the cross-identity case - presenting a *different* Authorization
//   header than the one that opened the session, and reusing one session's id
//   under another identity's headers. StreamableHTTPClientTransport fixes its
//   Authorization header per transport instance and manages mcp-session-id
//   internally, so it cannot express either scenario.
//
// One wrinkle the SSE pair never had: the route does not set
// enableJsonResponse, so a POST that carries a JSON-RPC *request* (as opposed
// to a bare notification) gets back a 200 with Content-Type: text/event-stream
// and the JSON-RPC response embedded in a single "data: ..." line, not a
// plain application/json body. extractJsonRpc() below unwraps that. Responses
// this route writes itself - 401/403/404/400 - are always short plain-text
// bodies (res.end(literal) before the transport is ever touched), never SSE.

const TOKEN_ALICE = 'tok-alice-shttp-3f8b21ec';
const TOKEN_BOB = 'tok-bob-shttp-9a06d4c7';
const AUTH_ENV = { MCP_AUTH_TOKENS: `alice:${TOKEN_ALICE},bob:${TOKEN_BOB}` };

const RATE_LIMIT_PATTERN = /^Rate limit exceeded\. Retry after \d+ms\.$/;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(body, 'utf8') : undefined;
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload ? { ...headers, 'Content-Length': String(payload.length) } : headers,
    }, (res: IncomingMessage) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

// Every POST this file sends carries a real JSON-RPC body, so the required
// Accept/Content-Type pair (the transport 406s/415s a POST missing either
// half - see webStandardStreamableHttp.js's handlePostRequest) is applied
// once here rather than at every call site.
function postMcp(port: number, headers: Record<string, string>, payload: unknown): Promise<RawResponse> {
  return rawRequest(port, 'POST', '/mcp', {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...headers,
  }, JSON.stringify(payload));
}

interface StreamResponse extends RawResponse {
  /** Ends the underlying request/response once the caller is done with the open stream. */
  destroy: () => void;
}

/**
 * Raw GET /mcp. Resolves as soon as the response headers arrive - for a 200
 * that leaves an open SSE stream behind (the caller destroys it when done);
 * for a 4xx the body is a short literal string index.ts writes directly, but
 * this file never needs to inspect it, only the status/headers.
 */
function getMcpStream(port: number, headers: Record<string, string>): Promise<StreamResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'GET', headers }, (res: IncomingMessage) => {
      res.resume(); // drain so the socket doesn't back up; body content is never asserted on here
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '', destroy: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Unwraps the single JSON-RPC response this file's POSTs always carry.
 * enableJsonResponse is not set on the transport (matching the brief's
 * route code verbatim), so a POST carrying a request - as opposed to a bare
 * notification, which gets 202 with no body - answers with a
 * text/event-stream body containing exactly one "data: <json>" line, not a
 * plain application/json body.
 */
function extractJsonRpc(headers: IncomingHttpHeaders, body: string): any {
  const contentType = headers['content-type'] ?? '';
  if (contentType.includes('text/event-stream')) {
    const m = body.match(/^data: (.*)$/m);
    assert.ok(m, `expected an SSE "data:" line in a text/event-stream body, got: ${body}`);
    return JSON.parse(m![1]);
  }
  if (contentType.includes('application/json') && body.length > 0) {
    return JSON.parse(body);
  }
  return undefined;
}

let rpcId = 1;
function nextId(): number {
  return rpcId++;
}

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'streamable-http-gating-test', version: '1.0.0' },
    },
  };
}

function toolsListRequest() {
  return { jsonrpc: '2.0', id: nextId(), method: 'tools/list' };
}

// Same fast-fail probe rate-limit-gating.test.ts established: lucidForAddress
// (packages/builder/src/vector/build.ts) validates changeAddress via
// getAddressDetails() and throws before any provider call, so this is
// in-process only - no network, no real timing dependency - whether or not
// the rate limiter admits the call.
const PROBE_TOOL_ARGS = { changeAddress: 'addr1garbage', recipientAddress: 'addr1garbage', amount: 1 };
function toolsCallRequest() {
  return {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: { name: 'vector_build_send_apex', arguments: PROBE_TOOL_ARGS },
  };
}

async function connectStreamable(port: number, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
  const client = new Client({ name: 'streamable-http-gating-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

// Every response the auth-enabled block observes, scanned once at the end for
// a leaked token - same style as auth-gating.test.ts's record()/seenBodies.
const seenBodies: string[] = [];
const seenHeaderDumps: string[] = [];
function record<T extends RawResponse>(r: T): T {
  seenBodies.push(r.body);
  seenHeaderDumps.push(JSON.stringify(r.headers));
  return r;
}

describe('streamable HTTP gating - MCP_AUTH_TOKENS set', () => {
  let ctx: RawServerHandle;

  before(async () => {
    ctx = await spawnServer(AUTH_ENV);
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('SDK client with a valid token connects over Streamable HTTP and lists exactly 24 tools', async () => {
    const client = await connectStreamable(ctx.port, TOKEN_ALICE);
    try {
      const result = await client.listTools();
      assert.equal(result.tools.length, 24);
    } finally {
      await client.close();
    }
  });

  test('no token: the SDK client rejects on connect, and a raw POST initialize is rejected with 401 and no token echo', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx.port}/mcp`));
    const client = new Client({ name: 'streamable-http-gating-test', version: '1.0.0' });
    await assert.rejects(() => client.connect(transport));

    const r = record(await postMcp(ctx.port, {}, initializeRequest()));
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
    assert.ok(!r.body.includes(TOKEN_ALICE) && !r.body.includes(TOKEN_BOB), 'no token value echoed in the 401 body');
  });

  test('a real, valid session id with no Authorization header is still rejected with 401, not 403 or 404 (auth checked before session lookup)', async () => {
    // Ordering pin, same class as auth-gating.test.ts's "POST /messages with
    // no Authorization header is rejected with 401, not 400 or 404": uses a
    // session id that genuinely exists (not a bogus one), so a passing result
    // cannot be explained away as "it 404'd because the session doesn't
    // exist" - it specifically proves the auth check runs, and short-circuits,
    // before the session map is ever consulted.
    const init = record(await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest()));
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'] as string | undefined;
    assert.ok(sessionId);

    const r = record(await postMcp(ctx.port, { 'mcp-session-id': sessionId! }, toolsListRequest()));
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  });

  test('cross-identity: a valid token for a different identity than the session owner is rejected with 403; the owner is accepted', async () => {
    const init = record(await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest()));
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'] as string | undefined;
    assert.ok(sessionId, 'expected an mcp-session-id response header on the initialize response');

    const crossed = record(await postMcp(
      ctx.port,
      { Authorization: `Bearer ${TOKEN_BOB}`, 'mcp-session-id': sessionId! },
      toolsListRequest(),
    ));
    assert.equal(crossed.status, 403);
    assert.equal(crossed.body, 'This session belongs to a different identity.');

    const own = record(await postMcp(
      ctx.port,
      { Authorization: `Bearer ${TOKEN_ALICE}`, 'mcp-session-id': sessionId! },
      toolsListRequest(),
    ));
    assert.equal(own.status, 200);
    const payload = extractJsonRpc(own.headers, own.body);
    assert.equal(payload.result.tools.length, 24);
  });

  test('GET opens the standalone SSE stream for the session owner; GET with no session id is rejected with 400', async () => {
    const init = record(await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest()));
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'] as string | undefined;
    assert.ok(sessionId);

    const opened = record(await getMcpStream(ctx.port, {
      Authorization: `Bearer ${TOKEN_ALICE}`,
      'mcp-session-id': sessionId!,
      Accept: 'text/event-stream',
    }));
    assert.equal(opened.status, 200);
    assert.ok(opened.headers['content-type']?.includes('text/event-stream'));
    opened.destroy();

    const noSession = record(await getMcpStream(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}`, Accept: 'text/event-stream' }));
    assert.equal(noSession.status, 400);
    noSession.destroy();
  });

  test('GET with a valid session but a different identity token is rejected with 403, independent of the POST cross-identity path', async () => {
    // The cross-identity test above only ever exercises POST. The route's
    // identity check runs before transport.handleRequest() regardless of
    // method, so this pins that it is not accidentally POST-only wiring.
    const init = record(await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest()));
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'] as string | undefined;
    assert.ok(sessionId);

    // GET's error responses (unlike its 200 open-stream response) are short,
    // res.end()-terminated bodies - safe to read to completion with
    // rawRequest, same as the POST cross-identity case.
    const crossed = record(await rawRequest(ctx.port, 'GET', '/mcp', {
      Authorization: `Bearer ${TOKEN_BOB}`,
      'mcp-session-id': sessionId!,
      Accept: 'text/event-stream',
    }));
    assert.equal(crossed.status, 403);
    assert.equal(crossed.body, 'This session belongs to a different identity.');
  });

  test('DELETE terminates the session; a follow-up request with that session id 404s (the maps drain via onsessionclosed)', async () => {
    const init = record(await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest()));
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'] as string | undefined;
    assert.ok(sessionId);

    const del = record(await rawRequest(ctx.port, 'DELETE', '/mcp', {
      Authorization: `Bearer ${TOKEN_ALICE}`,
      'mcp-session-id': sessionId!,
    }));
    assert.equal(del.status, 200);

    const followUp = record(await postMcp(
      ctx.port,
      { Authorization: `Bearer ${TOKEN_ALICE}`, 'mcp-session-id': sessionId! },
      toolsListRequest(),
    ));
    assert.equal(followUp.status, 404);
  });

  test('DELETE with no session id is rejected with 400', async () => {
    const r = record(await rawRequest(ctx.port, 'DELETE', '/mcp', { Authorization: `Bearer ${TOKEN_ALICE}` }));
    assert.equal(r.status, 400);
    assert.equal(r.body, 'Missing mcp-session-id header');
  });

  test('no token value leaked into any captured response body, response header, or stderr', () => {
    const stderr = ctx.stderr();
    for (const body of seenBodies) {
      assert.ok(!body.includes(TOKEN_ALICE), 'a response body must never contain the alice token');
      assert.ok(!body.includes(TOKEN_BOB), 'a response body must never contain the bob token');
    }
    for (const dump of seenHeaderDumps) {
      assert.ok(!dump.includes(TOKEN_ALICE), 'a response header must never contain the alice token');
      assert.ok(!dump.includes(TOKEN_BOB), 'a response header must never contain the bob token');
    }
    assert.ok(!stderr.includes(TOKEN_ALICE), 'server stderr must never contain the alice token');
    assert.ok(!stderr.includes(TOKEN_BOB), 'server stderr must never contain the bob token');
  });
});

describe('streamable HTTP gating - per-IP separation for anonymous callers', () => {
  let ctx: RawServerHandle;

  before(async () => {
    // No MCP_AUTH_TOKENS: every caller is admitted, bucketed by clientIpOf(req)
    // (rightmost X-Forwarded-For entry). Tiny budget so three probes exhaust it
    // well within this test's lifetime.
    ctx = await spawnServer({ MCP_AUTH_TOKENS: '', VECTOR_RATE_LIMIT_PER_MINUTE: '3' });
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('the forgeable leftmost X-Forwarded-For entry does not matter; only the rightmost, proxy-appended entry buckets the rate limit', async () => {
    // Identical leftmost entry ("6.6.6.6") in both groups - the assertion
    // below on this fact is the point of the test: if the leftmost entry
    // mattered, both groups would land in the same bucket. Only the rightmost
    // entry differs, and only the rightmost entry may legitimately be trusted
    // (see clientIpOf's docstring in auth.ts) - the trusted proxy appends it,
    // everything left of that append point is client-supplied and forgeable.
    const XFF_BUDGET_IP = '6.6.6.6, 203.0.113.50';
    const XFF_OTHER_IP = '6.6.6.6, 198.51.100.7';
    assert.equal(
      XFF_BUDGET_IP.split(',')[0].trim(),
      XFF_OTHER_IP.split(',')[0].trim(),
      'sanity: the leftmost (forgeable) XFF entry must be identical across both probe groups',
    );

    // A "probe" is a fresh session (own initialize) plus one tool call under
    // the given X-Forwarded-For - a session's identity is fixed at
    // initialize time, so the follow-up call must repeat the same header or
    // it would 403 as a cross-identity request instead of ever reaching the
    // rate limiter (see the bonus assertion at the end of this test).
    async function probe(xff: string): Promise<{ sessionId: string; text: string }> {
      const init = await postMcp(ctx.port, { 'X-Forwarded-For': xff }, initializeRequest());
      assert.equal(init.status, 200, `probe initialize under X-Forwarded-For "${xff}" must succeed`);
      const sessionId = init.headers['mcp-session-id'] as string | undefined;
      assert.ok(sessionId, 'expected an mcp-session-id response header on the initialize response');

      const call = await postMcp(ctx.port, { 'X-Forwarded-For': xff, 'mcp-session-id': sessionId! }, toolsCallRequest());
      assert.equal(call.status, 200, `probe tool call under X-Forwarded-For "${xff}" must reach the tool handler`);
      const payload = extractJsonRpc(call.headers, call.body);
      const content = payload.result.content as Array<{ type: string; text?: string }>;
      return { sessionId: sessionId!, text: content?.[0]?.text ?? '' };
    }

    // Three probes under 203.0.113.50 consume the whole budget (VECTOR_RATE_LIMIT_PER_MINUTE=3).
    // Each probe opens its OWN session - proven separately below - but all three
    // share one rate-limit bucket because limiterFor() keys on identity
    // (anon:203.0.113.50), not on session id.
    for (let i = 1; i <= 3; i++) {
      const { text } = await probe(XFF_BUDGET_IP);
      assert.ok(!RATE_LIMIT_PATTERN.test(text), `probe ${i} under 203.0.113.50 must not be rate-limited yet, got: ${text}`);
    }

    // The 4th probe's tool call is refused - the bucket is exhausted.
    const fourth = await probe(XFF_BUDGET_IP);
    assert.match(fourth.text, RATE_LIMIT_PATTERN, 'the 4th probe under 203.0.113.50 must be rate-limited');

    // A distinct rightmost IP gets its own, unexhausted budget - proving the
    // buckets are separate despite the identical leftmost entry above.
    const distinct = await probe(XFF_OTHER_IP);
    assert.ok(!RATE_LIMIT_PATTERN.test(distinct.text), `a distinct rightmost IP must have its own budget, got: ${distinct.text}`);

    // Bonus invariant proof (per the task brief): the 198.51.100.7 probe's own
    // session id, presented with its own consistent XFF, is still accepted.
    // Presented instead with the budget IP's XFF, it recomputes to a
    // different identity (anon:203.0.113.50) and hits the same
    // cross-identity guard the token-based case exercises - it does not
    // silently fall through to the exhausted bucket, or to any bucket at all.
    const ownIdentity = await postMcp(
      ctx.port,
      { 'X-Forwarded-For': XFF_OTHER_IP, 'mcp-session-id': distinct.sessionId },
      toolsListRequest(),
    );
    assert.equal(ownIdentity.status, 200, "the OTHER-IP session's own identity, presented consistently, is still accepted");

    const crossedIdentity = await postMcp(
      ctx.port,
      { 'X-Forwarded-For': XFF_BUDGET_IP, 'mcp-session-id': distinct.sessionId },
      toolsListRequest(),
    );
    assert.equal(crossedIdentity.status, 403, 'a session opened under one anonymous identity must reject a request whose recomputed identity differs');
  });
});

describe('streamable HTTP gating - idle session reaper', () => {
  let ctx: RawServerHandle;

  before(async () => {
    // Idle bound and sweep cadence both shrunk far below their real defaults
    // (10 minutes / 60 seconds) so this test proves the reaper in under a
    // second instead of sleeping anywhere near the production window. The
    // worst case for when a sweep can first observe this session as idle is
    // roughly idleMs + sweepMs after creation (a sweep tick can land just
    // before the session is created); the wait below is 2x that worst case.
    ctx = await spawnServer({ ...AUTH_ENV, VECTOR_MCP_SESSION_IDLE_MS: '400', VECTOR_MCP_SESSION_SWEEP_MS: '100' });
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('a session idle past the threshold is reaped on the next sweep; the maps drain the same way DELETE does', async () => {
    const init = await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest());
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'] as string | undefined;
    assert.ok(sessionId);

    // No request of any kind against this session in between - lastSeen never
    // bumps, so it goes idle starting from the moment initialize returned.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));

    const followUp = await postMcp(
      ctx.port,
      { Authorization: `Bearer ${TOKEN_ALICE}`, 'mcp-session-id': sessionId! },
      toolsListRequest(),
    );
    assert.equal(followUp.status, 404, 'an idle-reaped session must 404 - streamableTransports/streamableIdentities drained, same observable proof as the DELETE case');
  });
});

describe('streamable HTTP gating - per-identity session cap', () => {
  let ctx: RawServerHandle;

  before(async () => {
    // Cap shrunk to 2 so the third session for the same identity is enough to
    // force an eviction, well within a hermetic test's budget.
    ctx = await spawnServer({ ...AUTH_ENV, VECTOR_MCP_MAX_SESSIONS_PER_IDENTITY: '2' });
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('opening a session beyond the per-identity cap evicts the oldest; the newest sessions survive', async () => {
    const first = await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest());
    assert.equal(first.status, 200);
    const firstId = first.headers['mcp-session-id'] as string | undefined;
    assert.ok(firstId);

    const second = await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest());
    assert.equal(second.status, 200);
    const secondId = second.headers['mcp-session-id'] as string | undefined;
    assert.ok(secondId);
    assert.notEqual(secondId, firstId);

    // alice is now at the cap (2 live sessions). A third session for the SAME
    // identity must evict the oldest (first) before it is created.
    const third = await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest());
    assert.equal(third.status, 200);
    const thirdId = third.headers['mcp-session-id'] as string | undefined;
    assert.ok(thirdId);

    const firstFollowUp = await postMcp(
      ctx.port,
      { Authorization: `Bearer ${TOKEN_ALICE}`, 'mcp-session-id': firstId! },
      toolsListRequest(),
    );
    assert.equal(firstFollowUp.status, 404, 'the oldest session must have been evicted once the identity hit its session cap');

    const secondFollowUp = await postMcp(
      ctx.port,
      { Authorization: `Bearer ${TOKEN_ALICE}`, 'mcp-session-id': secondId! },
      toolsListRequest(),
    );
    assert.equal(secondFollowUp.status, 200, 'the second-oldest session must still be alive');

    const thirdFollowUp = await postMcp(
      ctx.port,
      { Authorization: `Bearer ${TOKEN_ALICE}`, 'mcp-session-id': thirdId! },
      toolsListRequest(),
    );
    assert.equal(thirdFollowUp.status, 200, 'the newest session must still be alive');
  });
});
