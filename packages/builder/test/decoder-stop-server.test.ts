// packages/builder/test/decoder-stop-server.test.ts
// The entry point (src/index.ts) in a real process: when its decoder library cannot decode a known value, the server writes one line to
// stderr, gives the answer of the call that it is running, and ends with code 1, so that the supervisor of the container starts it again.
// The decoder library of the process is made unusable by a preload (fixtures/decoder-unusable-on-signal.ts), on a signal. The tool call
// fails at its first step, the check of the address, so that no test call needs a network. The entry point also starts the check of the
// stack pointer of the library (decoder-health.ts): the first test reads the line that it writes when it does.
//
// A client that keeps a stream open (the SDK client does) holds the server until the grace time; a client that does not (a plain request)
// lets it end as soon as its answer is written (stop-server.test.ts shows the cases on a server in the test process).
//
// The tests wait on the platform clock: the process runs a real server, so fake timers cannot drive it.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FOREIGN_ADDRESS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';

const STOP_LINE = 'The decoder library cannot decode a known value. The process stops so that its supervisor starts it again.';
const WATCH_LINE = 'Decoder library: the stack pointer is checked after each tool call.';
const ROOT = resolve(import.meta.dirname!, '../../..');
const ENTRY = resolve(ROOT, 'packages/builder/src/index.ts');
const PRELOAD = resolve(import.meta.dirname!, 'fixtures/decoder-unusable-on-signal.ts');
const GRACE_MS = 3000;

interface Ended { code: number | null; signal: NodeJS.Signals | null; at: number }
interface Server { child: ChildProcess; port: number; stderr: () => string; ended: Promise<Ended> }
const running: Array<{ child: ChildProcess; client?: Client }> = [];

/** Starts the entry point with the preload, on a free port. */
async function start(): Promise<Server> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 5100 + Math.floor(Math.random() * 1800);
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', PRELOAD, ENTRY], {
      cwd: ROOT, env: { ...process.env, PORT: String(port), MCP_AUTH_TOKENS: '', NODE_OPTIONS: '--max-old-space-size=1024' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    running.push({ child });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const ended = new Promise<Ended>((done) => { child.on('exit', (code, signal) => done({ code, signal, at: Date.now() })); });
    const deadline = Date.now() + 90_000;
    while (!stderr.includes('listening on port') && child.exitCode === null && Date.now() < deadline) await sleep(100);
    // The server writes its line when it listens. The test goes on when it also answers a request: under a heavy load it may need a moment.
    let answers = false;
    while (stderr.includes('listening on port') && !answers && child.exitCode === null && Date.now() < deadline) {
      answers = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false);
      if (!answers) await sleep(100);
    }
    if (answers) return { child, port, stderr: () => stderr, ended };
    child.kill('SIGKILL');
  }
  throw new Error('the server did not start');
}

/** Makes the decoder library of the server unusable, and waits until the preload says that it did. */
async function breakDecoder(server: Server): Promise<void> {
  server.child.kill('SIGUSR2');
  for (let waited = 0; !server.stderr().includes('is unusable') && waited < 100; waited += 1) await sleep(100);
  assert.ok(server.stderr().includes('is unusable'), 'the preload made the decoder library unusable');
}

/** One request of the Streamable HTTP transport, with no stream left open: the first message of the answer, and the session. */
async function post(server: Server, message: Record<string, unknown>, session?: string): Promise<{ session: string | null; message: unknown }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });
  const data = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
  return { session: response.headers.get('mcp-session-id'), message: data ? JSON.parse(data.slice('data: '.length)) : undefined };
}

/** The first line of the text of the answer of a tool call. The tool checks the change address first, before it asks the node for anything. */
function textOf(answer: unknown): string {
  assert.ok(typeof answer === 'object' && answer !== null && 'result' in answer, JSON.stringify(answer));
  // The shape of the result of a tool call is fixed by the protocol.
  const result = answer.result as { content: Array<{ text: string }> };
  return result.content[0].text.split('\n')[0];
}

/** When the server ended. The test fails when the server still runs after `waitMs`. */
async function endOf(server: Server, waitMs: number): Promise<Ended> {
  const ended = await Promise.race([server.ended, sleep(waitMs).then(() => null)]);
  assert.ok(ended, 'the server ends');
  return ended;
}

/** A call of `vector_build_send_apex` over plain requests. Returns the first line of the answer. */
async function sendApexByRequests(server: Server, changeAddress = OWN_ADDRESS): Promise<string> {
  const initialized = await post(server, {
    id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'decoder-stop-test', version: '1.0.0' } },
  });
  assert.ok(initialized.session, 'the server gave a session');
  await post(server, { method: 'notifications/initialized' }, initialized.session);
  const answer = await post(server, {
    id: 2, method: 'tools/call', params: { name: 'vector_build_send_apex', arguments: { changeAddress, recipientAddress: FOREIGN_ADDRESS, amount: 3 } },
  }, initialized.session);
  return textOf(answer.message);
}

afterEach(async () => {
  for (const { child, client } of running.splice(0)) {
    try { await client?.close(); } catch { /* the process may be gone */ }
    child.kill('SIGKILL');
  }
});

const stopLines = (server: Server): number => server.stderr().split('\n').filter((line) => line === STOP_LINE).length;

describe('the server and a decoder library that cannot decode a known value', () => {
  test('the entry point starts the check of the stack pointer of the decoder library, and says so when it starts', async () => {
    const server = await start();
    assert.ok(server.stderr().split('\n').includes(WATCH_LINE), server.stderr());
  });

  test('a call that fails because of its input does not stop the server', async () => {
    const server = await start();
    assert.match(await sendApexByRequests(server, 'not an address'), /^Failed to build transaction: Invalid change address/);
    await sleep(GRACE_MS + 1000);
    assert.equal(server.child.exitCode, null, 'the server runs on');
    assert.equal(stopLines(server), 0);
  });

  test('the decoder library is unusable: the call gets its answer, and the server ends with code 1 as soon as the answer is written', async () => {
    const server = await start();
    await breakDecoder(server);
    assert.match(await sendApexByRequests(server), /^Failed to build transaction: /, 'the answer reaches the client');
    const answered = Date.now();
    const ended = await endOf(server, GRACE_MS + 5000);
    assert.equal(ended.code, 1);
    assert.equal(ended.signal, null);
    assert.ok(ended.at - answered < GRACE_MS - 500, `the server ended ${ended.at - answered} ms after the answer: the grace time was not needed`);
    assert.equal(stopLines(server), 1, server.stderr());
  });

  test('a client that keeps a stream open does not hold the server longer than the grace time', async () => {
    const server = await start();
    const client = new Client({ name: 'decoder-stop-test', version: '1.0.0' });
    running[running.length - 1].client = client;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`)));
    await breakDecoder(server);
    const result = await client.callTool({ name: 'vector_build_send_apex', arguments: { changeAddress: OWN_ADDRESS, recipientAddress: FOREIGN_ADDRESS, amount: 3 } });
    assert.match(textOf({ result }), /^Failed to build transaction: /, 'the answer reaches the client');
    const answered = Date.now();
    const ended = await endOf(server, GRACE_MS + 5000);
    assert.equal(ended.code, 1);
    assert.ok(ended.at - answered < GRACE_MS + 2000, `the server ended ${ended.at - answered} ms after the answer`);
    assert.equal(stopLines(server), 1, server.stderr());
  });
});
