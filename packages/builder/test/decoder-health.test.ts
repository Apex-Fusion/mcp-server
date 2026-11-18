// packages/builder/test/decoder-health.test.ts
// The process stops when its decoder library cannot decode a known value (decoder-health.ts): after each tool call the decoder decodes
// a known value, and when it cannot, one line goes to stderr and the stop function that the entry point set is called once, after the
// answer of the call. Without a stop function nothing runs and nothing ends. The check does not look at the error of the call, because
// Lucid and the builder catch the errors of the decoder and give others (see the answer of the child process below). The last tests run
// the tools in a child process whose decoder library is really unusable.
import { afterEach, describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CML } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decoderWorks, setDecoderStop, withDecoderCheck } from '../src/vector/decoder-health.ts';
import { registerVectorTools } from '../src/vector/vector.ts';
import { RATE_LIMIT_PER_MINUTE, limiterFor } from '../src/vector/rate-limiter.ts';

const STOP_LINE = 'The decoder library cannot decode a known value. The process stops so that its supervisor starts it again.';

type Handler = (...args: unknown[]) => Promise<unknown>;
/** A server that records each call of `tool`: its arguments, and the handler (the last argument) by the name of the tool. */
function fakeServer() {
  const calls: unknown[][] = [];
  const registered = new Map<string, Handler>();
  const server = {
    label: 'a server',
    ping: () => 'pong',
    tool: (...args: unknown[]) => {
      calls.push(args);
      registered.set(String(args[0]), args[args.length - 1] as Handler);
      return `registered ${String(args[0])}`;
    },
  } as unknown as McpServer;
  return { server, calls, registered };
}
/** Calls `server.tool` with any form of arguments: the tool of McpServer takes several. */
const register = (server: McpServer, ...args: unknown[]): unknown => Reflect.apply(server.tool, server, args);

afterEach(() => {
  setDecoderStop(undefined);
  mock.restoreAll();
});

/** The decoder cannot decode: Plutus data, the value that the self-check decodes, fails. */
const decoderCannotDecode = () => mock.method(CML.PlutusData, 'from_cbor_hex', () => { throw new Error('the decoder is not usable'); });
/** Counts the decodes of the self-check, and passes them on. */
const countDecodes = () => mock.method(CML.PlutusData, 'from_cbor_hex');

describe('decoderWorks', () => {
  test('is true when the decoder decodes the known value, and false when it does not', () => {
    assert.equal(decoderWorks(), true);
    decoderCannotDecode();
    assert.equal(decoderWorks(), false);
  });

  test('is false for any failure of the decoder, whatever its kind', () => {
    mock.method(CML.PlutusData, 'from_cbor_hex', () => { throw new WebAssembly.RuntimeError('the decoder is not usable'); });
    assert.equal(decoderWorks(), false);
  });
});

describe('withDecoderCheck', () => {
  test('hands each tool the same arguments, and the same answer, for each form of the call of `tool`', async () => {
    const { server, calls, registered } = fakeServer();
    const wrapped = withDecoderCheck(server);
    const answer = { content: [{ type: 'text', text: 'an answer' }] };
    const seen: unknown[][] = [];
    const handler = async (...args: unknown[]) => { seen.push(args); return answer; };
    const shape = { a: 1 };
    const annotations = { readOnlyHint: true };
    assert.equal(register(wrapped, 'one', handler), 'registered one');
    assert.equal(register(wrapped, 'two', 'a description', handler), 'registered two');
    assert.equal(register(wrapped, 'three', 'a description', shape, handler), 'registered three');
    assert.equal(register(wrapped, 'four', 'a description', shape, annotations, handler), 'registered four');
    assert.deepEqual(calls.map((args) => args.slice(0, -1)), [['one'], ['two', 'a description'], ['three', 'a description', shape], ['four', 'a description', shape, annotations]]);
    for (const name of ['one', 'two', 'three', 'four']) {
      const extra = { requestId: name };
      assert.equal(await registered.get(name)!({ argument: name }, extra), answer);
      assert.deepEqual(seen.at(-1), [{ argument: name }, extra]);
    }
    assert.ok(!calls.some((args) => args.at(-1) === handler), 'each handler is wrapped');
  });

  test('passes the other members of the server on, and a call of `tool` with no handler', () => {
    const { server, calls } = fakeServer();
    const wrapped = withDecoderCheck(server);
    assert.equal(Reflect.get(wrapped, 'label'), 'a server');
    assert.equal(Reflect.apply(Reflect.get(wrapped, 'ping'), wrapped, []), 'pong');
    register(wrapped, 'no handler', 'only a description');
    assert.deepEqual(calls.at(-1), ['no handler', 'only a description']);
  });

  test('with no stop function set, the decoder is not asked', async () => {
    const decodes = countDecodes();
    const { server, registered } = fakeServer();
    register(withDecoderCheck(server), 'tool', async () => 'an answer');
    assert.equal(await registered.get('tool')!(), 'an answer');
    assert.equal(decodes.mock.callCount(), 0);
  });

  test('with a stop function set, the decoder is asked after each call; a decoder that works never stops the process', async () => {
    const decodes = countDecodes();
    const stop = mock.fn();
    setDecoderStop(stop);
    const { server, registered } = fakeServer();
    const wrapped = withDecoderCheck(server);
    const ordinary = new Error('an ordinary failure');
    const engine = new WebAssembly.RuntimeError('a failure of the engine');
    register(wrapped, 'answers', async () => 'an answer');
    register(wrapped, 'fails', async () => { throw ordinary; });
    register(wrapped, 'engine', async () => { throw engine; });
    assert.equal(await registered.get('answers')!(), 'an answer');
    await assert.rejects(registered.get('fails')!(), (err: unknown) => err === ordinary);
    await assert.rejects(registered.get('engine')!(), (err: unknown) => err === engine);
    await nextTurn();
    assert.equal(decodes.mock.callCount(), 3, 'one self-check after each call');
    assert.equal(stop.mock.callCount(), 0);
  });

  test('a decoder that cannot decode: the answer is the one that the tool gave, one line goes to stderr, and the stop runs once, after the answer', async () => {
    decoderCannotDecode();
    const log = mock.method(console, 'error', () => undefined);
    const order: string[] = [];
    setDecoderStop(() => { order.push('stop'); });
    const { server, registered } = fakeServer();
    const answer = { content: [{ type: 'text', text: 'an answer' }] };
    register(withDecoderCheck(server), 'tool', async () => answer);
    assert.equal(await registered.get('tool')!(), answer);
    order.push('answer');
    assert.deepEqual(order, ['answer'], 'the stop does not run before the answer is out');
    await nextTurn();
    assert.deepEqual(order, ['answer', 'stop']);
    assert.deepEqual(log.mock.calls.map((call) => call.arguments), [[STOP_LINE]]);
  });

  test('several calls that find the decoder unusable stop the process once', async () => {
    decoderCannotDecode();
    const log = mock.method(console, 'error', () => undefined);
    const stop = mock.fn();
    setDecoderStop(stop);
    const { server, registered } = fakeServer();
    register(withDecoderCheck(server), 'tool', async () => 'an answer');
    assert.deepEqual(await Promise.all([registered.get('tool')!(), registered.get('tool')!(), registered.get('tool')!()]), ['an answer', 'an answer', 'an answer']);
    assert.equal(await registered.get('tool')!(), 'an answer');
    await nextTurn();
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(log.mock.callCount(), 1);
  });

  test('a tool that fails when the decoder cannot decode: the failure goes on, and the process stops', async () => {
    decoderCannotDecode();
    mock.method(console, 'error', () => undefined);
    const stop = mock.fn();
    setDecoderStop(stop);
    const { server, registered } = fakeServer();
    const failure = new Error('the tool failed');
    register(withDecoderCheck(server), 'tool', async () => { throw failure; });
    await assert.rejects(registered.get('tool')!(), (err: unknown) => err === failure);
    await nextTurn();
    assert.equal(stop.mock.callCount(), 1);
  });

  test('the decoder is asked when the call ends, not when it starts', async () => {
    mock.method(console, 'error', () => undefined);
    const stop = mock.fn();
    setDecoderStop(stop);
    const { server, registered } = fakeServer();
    // The decoder works when the call starts, and cannot decode when the tool has done its work.
    register(withDecoderCheck(server), 'tool', async () => { await nextTurn(); decoderCannotDecode(); return 'an answer'; });
    assert.equal(await registered.get('tool')!(), 'an answer');
    await nextTurn();
    assert.equal(stop.mock.callCount(), 1);
  });

  test('setting the stop function again makes the process able to stop again', async () => {
    decoderCannotDecode();
    mock.method(console, 'error', () => undefined);
    const first = mock.fn();
    const second = mock.fn();
    const { server, registered } = fakeServer();
    register(withDecoderCheck(server), 'tool', async () => 'an answer');
    setDecoderStop(first);
    await registered.get('tool')!();
    await nextTurn();
    setDecoderStop(undefined);
    await registered.get('tool')!();
    setDecoderStop(second);
    await registered.get('tool')!();
    await nextTurn();
    assert.deepEqual([first.mock.callCount(), second.mock.callCount()], [1, 1]);
  });
});

describe('registerVectorTools', () => {
  test('registers every tool through the check: one self-check follows each call of each tool', async () => {
    const identity = 'decoder-health-wiring';
    const limiter = limiterFor(identity);
    for (let call = 0; call <= RATE_LIMIT_PER_MINUTE; call += 1) limiter.check(); // the rate gate of each tool answers at once
    const { server, registered } = fakeServer();
    registerVectorTools(server, identity);
    assert.ok(registered.size >= 74, `${registered.size} tools`);
    setDecoderStop(() => undefined);
    const decodes = countDecodes();
    for (const [name, handler] of registered) {
      const before = decodes.mock.callCount();
      assert.match(JSON.stringify(await handler({})), /Rate limit exceeded/, name);
      assert.equal(decodes.mock.callCount(), before + 1, `${name}: one self-check follows the call`);
    }
  });

  test('wraps its server before it registers a tool or hands the server to a family of tools', () => {
    const source = readFileSync(resolve(import.meta.dirname!, '../src/vector/vector.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function registerVectorTools('));
    const inner = body.slice(body.indexOf('\n'));
    assert.ok(inner.includes('server = withDecoderCheck(server);'));
    assert.equal(inner.search(/\bserver\b/), inner.indexOf('server = withDecoderCheck(server);'), 'the first use of `server` is the wrap');
  });
});

describe('a process whose decoder library is unusable (child process)', () => {
  const fixture = resolve(import.meta.dirname!, 'fixtures/decoder-stop-child.ts');
  const run = (scenario: string) => spawnSync(process.execPath, ['--import', 'tsx', fixture, scenario], {
    cwd: resolve(import.meta.dirname!, '../../..'), encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
  });
  const stopLines = (stderr: string): number => stderr.split('\n').filter((line) => line === STOP_LINE).length;

  test('a tool call that works: the process ends by itself with code 0, and says nothing about the decoder', () => {
    const child = run('healthy');
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /^ANSWER /);
    assert.ok(!child.stdout.includes('Failed'), child.stdout);
    assert.equal(stopLines(child.stderr), 0);
  });

  test('a tool call that fails because of its input: the same, and the answer says why', () => {
    const child = run('ordinary');
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /^ANSWER Failed to build transaction: Invalid recipient address/);
    assert.equal(stopLines(child.stderr), 0);
  });

  test('a decoder library that is unusable: the tool answers, the process writes one line to stderr and ends with code 1', () => {
    const child = run('unusable');
    assert.equal(child.status, 1, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /^ANSWER Failed to build transaction: /, 'the answer is written before the process ends');
    assert.equal(stopLines(child.stderr), 1, child.stderr);
  });
});
