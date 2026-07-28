import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { spawnServer, stopRawServer } from '../setup.ts';
import type { RawServerHandle } from '../setup.ts';

// Covers the auth gate in packages/builder/src/index.ts against a real spawned
// server. No unit test can see this: it's entirely in the (untyped-by-tsc-only-
// in-the-sense-that-test-files-aren't-checked, but otherwise ordinary) HTTP
// request handler wiring - who returns after a 401, what order the checks run
// in, whether a token ever leaks. See .superpowers/sdd/pr5-integration-tests-report.md
// for the mutation-testing evidence that these assertions are load-bearing.
//
// Deliberately built on raw node:http, not the MCP SDK Client/SSEClientTransport:
// this file's whole point is exercising exact status codes, exact headers, and
// - for the cross-identity case - sending a *different* Authorization header on
// a POST than the one that opened the SSE session. SSEClientTransport fixes its
// headers per transport instance and hides the session id entirely, so it can't
// express that scenario at all.

const TOKEN_ALICE = 'tok-alice-9f2d7c1a';
const TOKEN_BOB = 'tok-bob-4e8b02f5';
const AUTH_ENV = { MCP_AUTH_TOKENS: `alice:${TOKEN_ALICE},bob:${TOKEN_BOB}` };

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface SseResponse extends RawResponse {
  sessionId: string | null;
  /** Ends the underlying request/response so the server's res.on('close', ...) cleanup fires. */
  destroy: () => void;
}

/**
 * Raw GET /sse. Resolves as soon as either (a) a 200 arrives and the
 * `event: endpoint` line has been read (session established, connection left
 * open for the caller to POST against or destroy), or (b) the response ends
 * without ever reaching (a) (the 401/etc. cases - short body, stream closes
 * immediately since index.ts calls res.end() right after writeHead()).
 */
function getSse(port: number, headers: Record<string, string> = {}): Promise<SseResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/sse', method: 'GET', headers }, (res: IncomingMessage) => {
      let buf = '';
      let settled = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        if (!settled && res.statusCode === 200 && buf.includes('event: endpoint')) {
          settled = true;
          const m = buf.match(/data:[^\n]*[?&]sessionId=([0-9a-fA-F-]+)/);
          resolve({ status: res.statusCode!, headers: res.headers, body: buf, sessionId: m ? m[1] : null, destroy: () => req.destroy() });
        }
      });
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, sessionId: null, destroy: () => {} });
        }
      });
      res.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function postMessages(port: number, path: string, headers: Record<string, string>, payload: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(payload, 'utf8');
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), ...headers },
    }, (res: IncomingMessage) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A minimal, genuinely valid JSON-RPC notification (matches the SDK's
// JSONRPCNotificationSchema: {jsonrpc, method, params?} with .strict()). This
// is the real message a client sends right after initialize - using it (over
// some arbitrary method name) means there's no doubt handlePostMessage's own
// parsing could be what rejects it.
const INIT_NOTIFICATION = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

// Every response this file observes, scanned once at the end of the
// auth-enabled block for a leaked token. Populated by record().
const seenBodies: string[] = [];
const seenHeaderDumps: string[] = [];
function record<T extends RawResponse>(r: T): T {
  seenBodies.push(r.body);
  seenHeaderDumps.push(JSON.stringify(r.headers));
  return r;
}

describe('auth gating - MCP_AUTH_TOKENS set', () => {
  let ctx: RawServerHandle;

  before(async () => {
    ctx = await spawnServer(AUTH_ENV);
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('GET /sse with no Authorization header is rejected with 401 and WWW-Authenticate: Bearer', async () => {
    const r = record(await getSse(ctx.port));
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  });

  test('GET /sse with an unrecognised token is rejected with 401', async () => {
    const r = record(await getSse(ctx.port, { Authorization: 'Bearer not-a-real-token' }));
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  });

  test('GET /sse with a valid token connects', async () => {
    const r = record(await getSse(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }));
    assert.equal(r.status, 200);
    assert.ok(r.sessionId, 'expected an "endpoint" SSE event carrying a sessionId');
    r.destroy();
  });

  test('POST /messages with no Authorization header is rejected with 401, not 400 or 404', async () => {
    // No sessionId at all - not even a bogus one. If auth were checked *after*
    // session lookup (the ordering bug this test exists to pin), a missing
    // sessionId would surface as 400 instead of 401.
    const r = record(await postMessages(ctx.port, '/messages', {}, INIT_NOTIFICATION));
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  });

  test('POST /messages with a valid token for a different identity than the session owner is rejected with 403', async () => {
    const sse = record(await getSse(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }));
    assert.equal(sse.status, 200);
    assert.ok(sse.sessionId);
    try {
      const r = record(await postMessages(ctx.port, `/messages?sessionId=${sse.sessionId}`, { Authorization: `Bearer ${TOKEN_BOB}` }, INIT_NOTIFICATION));
      assert.equal(r.status, 403);
    } finally {
      sse.destroy();
    }
  });

  test("POST /messages with the session's own identity is accepted", async () => {
    const sse = record(await getSse(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }));
    assert.equal(sse.status, 200);
    assert.ok(sse.sessionId);
    try {
      const r = record(await postMessages(ctx.port, `/messages?sessionId=${sse.sessionId}`, { Authorization: `Bearer ${TOKEN_ALICE}` }, INIT_NOTIFICATION));
      assert.equal(r.status, 202);
    } finally {
      sse.destroy();
    }
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
    assert.ok(!stderr.includes(TOKEN_ALICE), "server stderr must never contain the alice token");
    assert.ok(!stderr.includes(TOKEN_BOB), "server stderr must never contain the bob token");
  });

  test('the server process is still alive and accepting new connections after all of the above', async () => {
    // The regression this whole file exists to catch: a missing early `return`
    // after a 401 falls through into a second writeHead() on an already-ended
    // response, throws ERR_HTTP_HEADERS_SENT as an unhandled rejection inside
    // the request handler, and takes the whole process down with it - every
    // other in-flight and future connection drops. A per-request status-code
    // assertion can pass even when this happened to a *different* request, so
    // this checks the process itself, then proves liveness by actually using it.
    assert.equal(ctx.process.exitCode, null, 'server process must not have exited');
    assert.equal(ctx.process.killed, false, 'server process must not have been killed');
    const r = await getSse(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` });
    assert.equal(r.status, 200, 'server must still accept new connections');
    r.destroy();
  });
});

describe('auth gating - MCP_AUTH_TOKENS unset (pre-auth behavior unchanged)', () => {
  let ctx: RawServerHandle;

  before(async () => {
    // Explicit empty string, not just "don't pass the key": makes the
    // disabled state independent of whatever the ambient shell/CI environment
    // happens to have set, rather than relying on it happening to be unset.
    ctx = await spawnServer({ MCP_AUTH_TOKENS: '' });
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('GET /sse with no Authorization header still connects, exactly as before auth existed', async () => {
    const r = await getSse(ctx.port);
    assert.equal(r.status, 200);
    assert.ok(r.sessionId);
    r.destroy();
  });
});
