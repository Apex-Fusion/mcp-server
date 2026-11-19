// packages/builder/test/request-limit-server.test.ts
// The entry point (src/index.ts) in a real process, and the limit of the body of a request (read-body.ts). A POST to /mcp with a body of
// more than 131,072 bytes gets 413 and a short JSON answer, with a session and without one, and the server does not take more than the
// limit from the connection: a body with no content-length that goes on is cut off, and the server answers other requests during and
// after it. A body inside the limit gets the answer that the transport gives it: the first group of tests holds those answers, for a body
// that is JSON, one that is not, and one with a byte order mark, with the headers that the transport checks first.
//
// The tests write the requests to a socket (fixtures/raw-http.ts). They wait on the platform clock: the process runs a real server.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bodyOf, chunked, post, send } from './fixtures/raw-http.ts';
import type { Answer } from './fixtures/raw-http.ts';

const ROOT = resolve(import.meta.dirname!, '../../..');
const ENTRY = resolve(ROOT, 'packages/builder/src/index.ts');
const LIMIT = 131_072;

let child: ChildProcess;
let port = 0;
let stderr = '';

/** Starts the entry point on a free port, and waits until it answers a request. */
async function start(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    port = 7100 + Math.floor(Math.random() * 1800);
    stderr = '';
    child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      cwd: ROOT, env: { ...process.env, PORT: String(port), MCP_AUTH_TOKENS: '', NODE_OPTIONS: '--max-old-space-size=1024' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const deadline = Date.now() + 90_000;
    while (!stderr.includes('listening on port') && child.exitCode === null && Date.now() < deadline) await sleep(100);
    let answers = false;
    while (stderr.includes('listening on port') && !answers && child.exitCode === null && Date.now() < deadline) {
      answers = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false);
      if (!answers) await sleep(100);
    }
    if (answers) return;
    child.kill('SIGKILL');
  }
  throw new Error('the server did not start');
}

before(start);
after(async () => {
  child.kill('SIGKILL');
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once('exit', done) : done(undefined)));
});

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'request-limit-test', version: '1.0.0' } },
});
const ACCEPT = 'Accept: application/json, text/event-stream';

/** One POST to /mcp: `body` with its content-length, the headers `headers`, and the session if there is one. */
function request(body: string | Buffer, headers: string[] = [ACCEPT], session?: string): Promise<Answer> {
  const bytes = Buffer.from(body);
  return send(port, post([...headers, 'Connection: close', ...(session ? [`mcp-session-id: ${session}`] : []), `Content-Length: ${bytes.length}`]), [bytes]);
}

/** The first JSON message of an answer: the body itself, or the first `data:` line of an event stream. */
function messageOf(answer: Answer): { error?: { code: number; message: string }; result?: { content?: Array<{ text: string }> } } {
  const line = answer.body.split('\n').find((text) => text.startsWith('data: '));
  return JSON.parse(line === undefined ? answer.body : line.slice('data: '.length));
}

/** Initializes a session, and returns its id. */
async function openSession(): Promise<string> {
  const answer = await request(INITIALIZE);
  assert.equal(answer.status, 200, answer.body);
  const session = /^mcp-session-id: (\S+)/im.exec(answer.headers)?.[1];
  assert.ok(session, 'the server gave a session');
  assert.equal((await request(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), [ACCEPT], session)).status, 202);
  return session;
}

/** A call of a tool that fails at its first step, so that no node is asked: the text of the answer. */
async function callTool(session: string): Promise<string> {
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vector_build_send_apex', arguments: { changeAddress: 'not an address', recipientAddress: 'x', amount: 3 } } };
  const answer = await request(JSON.stringify(call), [ACCEPT], session);
  assert.equal(answer.status, 200, answer.body);
  return messageOf(answer).result!.content![0].text;
}

const health = async (): Promise<number> => (await fetch(`http://127.0.0.1:${port}/health`)).status;

describe('a body inside the limit gets the answer of the transport', () => {
  test('an initialization, a call of a tool in the session, and a body of exactly the limit', async () => {
    const session = await openSession();
    assert.match(await callTool(session), /^Failed to build transaction: Invalid change address: No address type matched for: not an address/);
    const exact = await request(Buffer.from(INITIALIZE.padEnd(LIMIT, ' ')));
    assert.equal(exact.status, 200, exact.body);
    assert.match(exact.headers, /^mcp-session-id: \S+/im);
    assert.equal(messageOf(exact).result !== undefined, true);
  });

  test('a byte order mark before the body is dropped, as before', async () => {
    const answer = await request(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(INITIALIZE)]));
    assert.equal(answer.status, 200, answer.body);
    assert.match(answer.headers, /^mcp-session-id: \S+/im);
  });

  // [name, headers, body, status, code, message]: what the transport answers, checked in this order: Accept, Content-Type, the JSON, the message.
  const PARSE = 'Parse error: Invalid JSON';
  const MESSAGE = 'Parse error: Invalid JSON-RPC message';
  const ACCEPTABLE = 'Not Acceptable: Client must accept both application/json and text/event-stream';
  const MEDIA = 'Unsupported Media Type: Content-Type must be application/json';
  const CASES: Array<[string, string[], string, number, number, string]> = [
    ['a body that is not JSON', [ACCEPT], 'not json', 400, -32700, PARSE],
    ['an empty body', [ACCEPT], '', 400, -32700, PARSE],
    ['a body that is cut', [ACCEPT], '{"jsonrpc":"2.0","id":1,', 400, -32700, PARSE],
    ['two JSON values', [ACCEPT], '{"a":1}{"b":2}', 400, -32700, PARSE],
    ['JSON that is not a JSON-RPC message', [ACCEPT], '{"a":1}', 400, -32700, MESSAGE],
    ['null', [ACCEPT], 'null', 400, -32700, MESSAGE],
    ['an array of anything', [ACCEPT], '[1,2]', 400, -32700, MESSAGE],
    ['no Accept header', [], INITIALIZE, 406, -32000, ACCEPTABLE],
    ['no Accept header, and a body that is not JSON', [], 'not json', 406, -32000, ACCEPTABLE],
    ['a content type that is not JSON', [ACCEPT, 'Content-Type: text/plain'], INITIALIZE, 415, -32000, MEDIA],
    ['a content type that is not JSON, and a body that is not JSON', [ACCEPT, 'Content-Type: text/plain'], 'not json', 415, -32000, MEDIA],
  ];
  for (const [name, headers, body, status, code, message] of CASES) {
    test(`${name}: ${status}, ${message}`, async () => {
      const answer = await request(body, headers);
      assert.equal(answer.status, status, answer.body);
      assert.match(answer.headers, /^content-type: application\/json/im);
      assert.deepEqual(JSON.parse(answer.body), { jsonrpc: '2.0', error: { code, message }, id: null });
    });
  }

  test('a body that is not JSON, in a session, gets the same answer', async () => {
    const answer = await request('not json', [ACCEPT], await openSession());
    assert.equal(answer.status, 400);
    assert.deepEqual(JSON.parse(answer.body), { jsonrpc: '2.0', error: { code: -32700, message: PARSE }, id: null });
  });
});

describe('a body above the limit', () => {
  const TOO_LARGE = { jsonrpc: '2.0', error: { code: -32000, message: `The request body is larger than the limit of ${LIMIT} bytes.` }, id: null };

  test('one byte above the limit gets 413 and a short JSON answer, without a session and with one, and the session goes on', async () => {
    const without = await request(bodyOf(LIMIT + 1));
    assert.equal(without.status, 413);
    assert.match(without.headers, /^content-type: application\/json/im);
    assert.deepEqual(JSON.parse(without.body), TOO_LARGE);
    const session = await openSession();
    const within = await request(bodyOf(LIMIT + 1), [ACCEPT], session);
    assert.equal(within.status, 413);
    assert.deepEqual(JSON.parse(within.body), TOO_LARGE);
    assert.match(await callTool(session), /^Failed to build transaction: /, 'the session works after the refusal');
  });

  test('a body of several megabytes gets 413 too, and the answer is short', async () => {
    const answer = await request(Buffer.alloc(8 * 1024 * 1024, 0x20));
    assert.equal(answer.status, 413);
    assert.ok(answer.body.length < 200, answer.body);
  });

  test('a content-length above the limit gets 413 before a byte of the body is sent', async () => {
    const answer = await send(port, post([ACCEPT, 'Connection: close', `Content-Length: ${LIMIT * 1000}`]));
    assert.equal(answer.status, 413);
    assert.deepEqual(JSON.parse(answer.body), TOO_LARGE);
  });

  test('a body with no content-length that goes on is cut off, and the server answers other requests after it', async () => {
    // 64 MiB in chunks of 16 KiB: far more than the kernel buffers of both sides hold.
    const flood = (async function* () { const chunk = Buffer.alloc(16_384, 0x20); for (let i = 0; i < 4096; i += 1) yield Buffer.concat([Buffer.from('4000\r\n'), chunk, Buffer.from('\r\n')]); })();
    const answer = await send(port, post([ACCEPT, 'Transfer-Encoding: chunked', 'Connection: close']), flood);
    assert.equal(answer.status, 413);
    assert.equal(answer.ended, true, 'the server ended the connection');
    assert.ok(answer.sent < 16 * 1024 * 1024, `the sender wrote ${answer.sent} of 64 MiB before the connection ended`);
    assert.equal(await health(), 200);
    assert.match(await callTool(await openSession()), /^Failed to build transaction: /);
  });

  test('a body that comes slowly does not stop other requests, and is cut off at the limit', async () => {
    const drip = (async function* () { for (let i = 0; i < 400; i += 1) { await sleep(25); yield Buffer.from(`2000\r\n${' '.repeat(8192)}\r\n`); } })();
    const upload = send(port, post([ACCEPT, 'Transfer-Encoding: chunked', 'Connection: close']), drip);
    await sleep(100);
    assert.equal(await health(), 200, 'during the body');
    assert.match(await callTool(await openSession()), /^Failed to build transaction: /, 'a call of a tool during the body');
    assert.equal((await upload).status, 413);
    assert.equal(await health(), 200, 'after the body');
  });

  test('the process runs on, and writes no error for the requests that it refused', () => {
    assert.equal(child.exitCode, null, stderr.slice(-500));
    assert.doesNotMatch(stderr, /ERR_[A-Z_]+|Cannot write headers|Error:/, stderr.slice(-500));
  });
});

describe('a chunked body of exactly the limit is read', () => {
  test('in chunks of any size', async () => {
    const body = Buffer.from(INITIALIZE.padEnd(LIMIT, ' '));
    const parts = [body.subarray(0, 1), body.subarray(1, 5000), body.subarray(5000, 70_000), body.subarray(70_000)];
    const answer = await send(port, post([ACCEPT, 'Transfer-Encoding: chunked', 'Connection: close']), chunked(parts));
    assert.equal(answer.status, 200, answer.body);
    assert.match(answer.headers, /^mcp-session-id: \S+/im);
  });
});
