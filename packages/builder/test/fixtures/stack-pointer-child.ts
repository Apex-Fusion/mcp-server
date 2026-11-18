// packages/builder/test/fixtures/stack-pointer-child.ts
//
// A child process for stack-pointer.test.ts: the real decoder library and the watch of its stack pointer (decoder-health.ts). The scenario is
// the first argument. The child prints one line when the scenario ends as it should.
//   healthy: calls that work never change the pointer, and the watch writes no line.
//   above:   a pointer above the start value is not set lower.
//   low:     a tool call leaves the pointer at the bottom of its range. The wrapper puts it back before the self-check, so the check passes and
//            the process does not stop. With no watch, the same call makes the self-check fail, and the stop runs.
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CML, getAddressDetails } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decoderWorks, restoreStackPointer, setDecoderStop, unwatchStackPointer, watchStackPointer, withDecoderCheck } from '../../src/vector/decoder-health.ts';

const scenario = process.argv[2];
const VALID_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
const INPUT = `825820${'22'.repeat(32)}00`;

// The lines of the watch are counted, not written.
const lines: string[] = [];
console.error = (...parts: unknown[]) => { lines.push(String(parts[0])); };

const instance: unknown = Reflect.get(CML, '__wasm');
if (typeof instance !== 'object' || instance === null) throw new Error('the decoder library has no instance');
const move = (delta: number): number => Number(Reflect.apply(Reflect.get(instance, '__wbindgen_add_to_stack_pointer'), instance, [delta]));
const start = move(0);
const fail = (message: string): never => { process.stdout.write(`FAILED ${message}\n`); process.exit(1); };
const ordinary = (run: () => unknown): void => { try { run(); } catch { /* an ordinary error */ } };

if (scenario === 'healthy') {
  if (!watchStackPointer()) fail('the pointer is not watched');
  for (let call = 0; call < 200; call += 1) {
    ordinary(() => CML.PlutusData.from_cbor_hex('d87980').free());
    ordinary(() => getAddressDetails(VALID_ADDRESS));
    ordinary(() => CML.Transaction.from_cbor_hex(`84a30081${INPUT}0181a200581d61${'11'.repeat(28)}011a001e84800218a8a0f5f6`));
    ordinary(() => getAddressDetails('not an address'));
    restoreStackPointer();
    if (move(0) !== start) fail(`the pointer moved at call ${call}`);
  }
  console.log(`ok, ${lines.length} lines`);
} else if (scenario === 'above') {
  if (!watchStackPointer()) fail('the pointer is not watched');
  move(16);
  restoreStackPointer();
  const after = move(0);
  move(start - after);
  console.log(after === start + 16 && lines.length === 0 ? 'ok' : `FAILED the pointer is ${after - start} above the start value, ${lines.length} lines`);
} else if (scenario === 'low') {
  const handlers = new Map<string, () => Promise<string>>();
  const server = { tool: (name: string, handler: () => Promise<string>) => { handlers.set(name, handler); } } as unknown as McpServer;
  const wrapped = withDecoderCheck(server);
  // The tool leaves the pointer at the bottom of its range, as a failed call of the library can.
  Reflect.apply(wrapped.tool, wrapped, ['leaves the pointer low', async () => { move(-start); return 'an answer'; }]);
  let stops = 0;
  setDecoderStop(() => { stops += 1; });
  if (!watchStackPointer()) fail('the pointer is not watched');
  const answer = await handlers.get('leaves the pointer low')!();
  await nextTurn();
  if (answer !== 'an answer' || stops !== 0 || move(0) !== start || lines.length !== 1 || !decoderWorks()) {
    fail(`with the watch: ${stops} stops, the pointer is ${move(0) - start} from its start value, ${lines.length} lines`);
  }
  unwatchStackPointer();
  await handlers.get('leaves the pointer low')!();
  await nextTurn();
  if (stops !== 1) fail(`with no watch: ${stops} stops`);
  console.log('ok, 0 stops with the watch, 1 stop without it');
} else {
  fail(`unknown scenario ${scenario}`);
}
