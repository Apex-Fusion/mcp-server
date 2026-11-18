// packages/builder/test/stack-pointer.test.ts
// The watch of the stack pointer of the decoder library (decoder-health.ts): the entry point reads the start value once. After each tool
// call the pointer is read again. A pointer below the start value is put back, with one line on stderr. A pointer at the start value, or
// above it, is not touched. The pointer is put back before the self-check runs, so a call that leaves it low does not stop a process whose
// library works again. A library with no such export is not watched, and the self-check with the stop works as before. The first tests
// use a fake library, so that every value of the pointer can be tried. The last tests run the real library in child processes.
import { afterEach, describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CML } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { restoreStackPointer, setDecoderStop, unwatchStackPointer, watchStackPointer, withDecoderCheck } from '../src/vector/decoder-health.ts';

const START = 1_048_576;

/** A library whose pointer is `pointer`; `takesWrites: false` gives a pointer that ignores the writes. */
function fakeLibrary(takesWrites = true) {
  const state = { pointer: START, moves: [] as number[] };
  const library = {
    __wasm: {
      __wbindgen_add_to_stack_pointer: (delta: number) => {
        state.moves.push(delta);
        if (takesWrites) state.pointer += delta;
        return state.pointer;
      },
    },
  };
  return { library, state };
}
const logged = () => mock.method(console, 'error', () => undefined);

afterEach(() => {
  unwatchStackPointer();
  setDecoderStop(undefined);
  mock.restoreAll();
});

describe('watchStackPointer and restoreStackPointer, over a fake library', () => {
  test('a library with no such export is not watched, and the restore does nothing', () => {
    const log = logged();
    assert.equal(watchStackPointer({}), false);
    assert.equal(watchStackPointer({ __wasm: {} }), false);
    assert.equal(watchStackPointer({ __wasm: { __wbindgen_add_to_stack_pointer: 'not a function' } }), false);
    assert.equal(watchStackPointer({ __wasm: { __wbindgen_add_to_stack_pointer: () => 'not a number' } }), false);
    restoreStackPointer();
    assert.equal(log.mock.callCount(), 0);
  });

  test('two reads that differ do not start the watch', () => {
    let reads = 0;
    assert.equal(watchStackPointer({ __wasm: { __wbindgen_add_to_stack_pointer: () => START + reads++ } }), false);
  });

  test('a pointer at the start value is not touched, and nothing is written to stderr', () => {
    const { library, state } = fakeLibrary();
    const log = logged();
    assert.equal(watchStackPointer(library), true);
    restoreStackPointer();
    assert.equal(state.pointer, START);
    assert.ok(state.moves.every((delta) => delta === 0), 'no write: every move is a read');
    assert.equal(log.mock.callCount(), 0);
  });

  test('a pointer below the start value is put back and read again, with one line that gives the difference', () => {
    const { library, state } = fakeLibrary();
    const log = logged();
    watchStackPointer(library);
    state.pointer = START - 4096;
    state.moves.length = 0;
    restoreStackPointer();
    assert.equal(state.pointer, START);
    assert.deepEqual(state.moves, [0, 4096, 0], 'read, write the difference, read again');
    assert.deepEqual(log.mock.calls.map((call) => call.arguments), [['The stack pointer of the decoder library was 4096 bytes below its start value after a tool call. The server put it back.']]);
  });

  test('a put back that does not take is said in the line', () => {
    const { library, state } = fakeLibrary(false);
    const log = logged();
    watchStackPointer(library);
    state.pointer = START - 64;
    restoreStackPointer();
    assert.match(String(log.mock.calls[0].arguments[0]), /64 bytes below its start value.* could not put it back\.$/);
  });

  test('a pointer above the start value is not touched, and nothing is written to stderr', () => {
    const { library, state } = fakeLibrary();
    const log = logged();
    watchStackPointer(library);
    state.pointer = START + 16;
    state.moves.length = 0;
    restoreStackPointer();
    assert.equal(state.pointer, START + 16);
    assert.ok(state.moves.every((delta) => delta === 0));
    assert.equal(log.mock.callCount(), 0);
  });

  test('the restore never sets a value above the start value: for any pointer, it ends at the start value or where it was above it', () => {
    logged();
    const { library, state } = fakeLibrary();
    watchStackPointer(library);
    for (const pointer of [0, 1, 7, 8, 100, 4095, 65_535, START - 1, START, START + 1, START + 16, START + 1_000_000, -5]) {
      state.pointer = pointer;
      restoreStackPointer();
      assert.ok(state.pointer === (pointer < START ? START : pointer), `${pointer} became ${state.pointer}`);
      assert.ok(state.pointer <= Math.max(START, pointer));
    }
  });

  test('the wrapper puts the pointer back after a call that succeeds and after a call that fails, and the answer does not change', async () => {
    const { library, state } = fakeLibrary();
    const log = logged();
    watchStackPointer(library);
    const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const server = { tool: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { registered.set(name, handler); } } as unknown as McpServer;
    const wrapped = withDecoderCheck(server);
    const answer = { content: [{ type: 'text', text: 'an answer' }] };
    Reflect.apply(wrapped.tool, wrapped, ['succeeds', async () => { state.pointer -= 300; return answer; }]);
    Reflect.apply(wrapped.tool, wrapped, ['fails', async () => { state.pointer -= 500; throw new Error('the tool failed'); }]);
    assert.equal(await registered.get('succeeds')!(), answer);
    assert.equal(state.pointer, START);
    await assert.rejects(registered.get('fails')!(), /the tool failed/);
    assert.equal(state.pointer, START);
    assert.equal(log.mock.callCount(), 2);
  });

  test('the pointer is put back before the self-check: a call that leaves it low does not stop a process whose decoder works again after the restore', async () => {
    const { library, state } = fakeLibrary();
    const log = logged();
    // The decoder cannot decode while the pointer is below its start value, and works when it is back at the start value.
    const decode = CML.PlutusData.from_cbor_hex.bind(CML.PlutusData);
    mock.method(CML.PlutusData, 'from_cbor_hex', (hex: string) => {
      if (state.pointer < START) throw new Error('the decoder is not usable');
      return decode(hex);
    });
    const stop = mock.fn();
    setDecoderStop(stop);
    const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const server = { tool: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { registered.set(name, handler); } } as unknown as McpServer;
    const wrapped = withDecoderCheck(server);
    Reflect.apply(wrapped.tool, wrapped, ['leaves the pointer low', async () => { state.pointer -= 4096; return 'an answer'; }]);
    // With the watch: the pointer is put back first, so the self-check passes and nothing stops.
    assert.equal(watchStackPointer(library), true);
    assert.equal(await registered.get('leaves the pointer low')!(), 'an answer');
    await nextTurn();
    assert.equal(state.pointer, START);
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 1, 'one line: the pointer was put back');
    // With no watch, the same call leaves the pointer low, the self-check fails, and the process stops: the test tells the two apart.
    unwatchStackPointer();
    assert.equal(await registered.get('leaves the pointer low')!(), 'an answer');
    await nextTurn();
    assert.equal(state.pointer, START - 4096);
    assert.equal(stop.mock.callCount(), 1);
  });

  test('with no export in the library, the self-check and the stop work as before', async () => {
    mock.method(CML.PlutusData, 'from_cbor_hex', () => { throw new Error('the decoder is not usable'); });
    logged();
    assert.equal(watchStackPointer({}), false);
    const stop = mock.fn();
    setDecoderStop(stop);
    const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const server = { tool: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { registered.set(name, handler); } } as unknown as McpServer;
    Reflect.apply(withDecoderCheck(server).tool, withDecoderCheck(server), ['tool', async () => 'an answer']);
    assert.equal(await registered.get('tool')!(), 'an answer');
    await nextTurn();
    assert.equal(stop.mock.callCount(), 1);
  });
});

describe('the stack pointer of the real decoder library, in child processes', () => {
  const fixture = resolve(import.meta.dirname!, 'fixtures/stack-pointer-child.ts');
  const run = (scenario: string) => spawnSync(process.execPath, ['--import', 'tsx', fixture, scenario], {
    cwd: resolve(import.meta.dirname!, '../../..'), encoding: 'utf8', timeout: 240_000, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
  });

  test('a call that leaves the pointer at the bottom of its range does not stop the process: the pointer is put back before the self-check', () => {
    const child = run('low');
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.stdout.trim(), 'ok, 0 stops with the watch, 1 stop without it');
  });

  test('a healthy call never changes the pointer, and writes no line', () => {
    const child = run('healthy');
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.stdout.trim(), 'ok, 0 lines');
  });

  test('a pointer above the start value is never set lower by the restore', () => {
    const child = run('above');
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.stdout.trim(), 'ok');
  });
});
