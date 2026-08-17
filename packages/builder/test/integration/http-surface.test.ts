import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { spawnServer, stopRawServer } from '../setup.ts';
import type { RawServerHandle } from '../setup.ts';

// Covers the non-MCP HTTP surface of packages/builder/src/index.ts against a
// real spawned server: the any-origin CORS contract (preflight, success
// responses, and - the part a naive per-branch implementation drops - error
// responses), the unauthenticated /health probe, and the hard 404 where the
// removed SSE pair (/sse + /messages) used to answer. The gating suite
// (streamable-http-gating.test.ts) owns everything behind the auth gate;
// this file owns everything in front of it.

const TOKEN_ALICE = 'tok-alice-surface-5b1d90aa';
const AUTH_ENV = { MCP_AUTH_TOKENS: `alice:${TOKEN_ALICE}` };

// The exact contract index.ts advertises. Asserted value-for-value, not just
// presence: a broadened or narrowed header list is a behavior change for
// every browser client and must show up as a diff here.
const EXPECTED_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id',
};

const BUILDER_VERSION = JSON.parse(
  readFileSync(resolve(import.meta.dirname!, '../../package.json'), 'utf-8'),
).version as string;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolvePromise, reject) => {
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
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: buf }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

function initializeRequest() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-surface-test', version: '1.0.0' },
    },
  });
}

function postMcp(port: number, headers: Record<string, string>, payload: string): Promise<RawResponse> {
  return rawRequest(port, 'POST', '/mcp', {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...headers,
  }, payload);
}

function assertCors(headers: IncomingHttpHeaders, context: string): void {
  for (const [name, value] of Object.entries(EXPECTED_CORS)) {
    assert.equal(headers[name], value, `${context}: ${name} must be "${value}"`);
  }
}

describe('HTTP surface - CORS, /health, and removed SSE routes (auth enabled)', () => {
  let ctx: RawServerHandle;

  before(async () => {
    ctx = await spawnServer(AUTH_ENV);
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('OPTIONS /mcp with no Authorization answers 204 with the full CORS contract (preflight runs before the auth gate)', async () => {
    // Browsers never attach Authorization to a preflight. If OPTIONS were
    // dispatched inside the authed /mcp branch, every browser client would
    // die here with a 401 before its real request was ever sent.
    const r = await rawRequest(ctx.port, 'OPTIONS', '/mcp', {
      Origin: 'https://example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type, mcp-session-id',
    });
    assert.equal(r.status, 204);
    assertCors(r.headers, 'OPTIONS /mcp');
  });

  test('OPTIONS /health answers 204 with the CORS contract', async () => {
    const r = await rawRequest(ctx.port, 'OPTIONS', '/health', { Origin: 'https://example.com' });
    assert.equal(r.status, 204);
    assertCors(r.headers, 'OPTIONS /health');
  });

  test('GET /health needs no Authorization, reports the package version, and creates no session', async () => {
    const r = await rawRequest(ctx.port, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('application/json'));
    assert.deepEqual(JSON.parse(r.body), { status: 'ok', version: BUILDER_VERSION });
    assert.equal(r.headers['mcp-session-id'], undefined, '/health must not mint a session');
    assertCors(r.headers, 'GET /health');
  });

  test('a 401 from a tokenless POST /mcp still carries the CORS headers (a browser can read the auth failure)', async () => {
    // The load-bearing case for the setHeader-at-handler-top placement:
    // error branches use writeHead(status, obj), which would silently drop
    // CORS if the headers were only attached per-branch. Without CORS on the
    // 401, a browser client sees an opaque network error instead of the
    // status code.
    const r = await postMcp(ctx.port, {}, initializeRequest());
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
    assertCors(r.headers, '401 POST /mcp');
  });

  test('a successful initialize exposes mcp-session-id to browser callers', async () => {
    // Access-Control-Expose-Headers is what lets a browser script read the
    // session id off the response; without it the SDK's browser build cannot
    // continue past initialize even though the header is on the wire.
    const r = await postMcp(ctx.port, { Authorization: `Bearer ${TOKEN_ALICE}` }, initializeRequest());
    assert.equal(r.status, 200);
    assert.ok(r.headers['mcp-session-id'], 'initialize must return a session id');
    assertCors(r.headers, '200 POST /mcp initialize');
  });

  test('the removed SSE pair is gone: GET /sse and POST /messages both 404, still carrying CORS headers', async () => {
    const sse = await rawRequest(ctx.port, 'GET', '/sse', { Authorization: `Bearer ${TOKEN_ALICE}`, Accept: 'text/event-stream' });
    assert.equal(sse.status, 404);
    assertCors(sse.headers, 'GET /sse');

    const messages = await rawRequest(ctx.port, 'POST', '/messages', {
      Authorization: `Bearer ${TOKEN_ALICE}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.equal(messages.status, 404);
    assertCors(messages.headers, 'POST /messages');
  });
});

describe('HTTP surface - /health bypasses the rate limiter', () => {
  let ctx: RawServerHandle;

  before(async () => {
    // Budget of 1: if /health consumed rate-limit budget (or were bucketed
    // at the HTTP layer at all), the second call here would already be
    // refused. The limiter lives inside tool handlers, which /health never
    // reaches - this pins that placement.
    ctx = await spawnServer({ MCP_AUTH_TOKENS: '', VECTOR_RATE_LIMIT_PER_MINUTE: '1' });
  });

  after(async () => {
    await stopRawServer(ctx);
  });

  test('repeated /health probes all answer 200 under a rate-limit budget of 1', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await rawRequest(ctx.port, 'GET', '/health');
      assert.equal(r.status, 200, `/health probe ${i}/5 must not be rate-limited`);
    }
  });
});
