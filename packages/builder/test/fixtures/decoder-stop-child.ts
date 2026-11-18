// packages/builder/test/fixtures/decoder-stop-child.ts
//
// A child process for decoder-health.test.ts: the tools of the builder over a fixture node, and a stop function that ends the process
// (as the entry point does, without waiting for open answers). The scenario is the first argument:
//   healthy:  a tool call that works.
//   ordinary: a tool call that fails because of its input.
//   unusable: the decoder library of this process is made unusable (the memory of its instance is overwritten with zeros), then a tool call.
// The child prints the first line of the answer. The process ends with code 1 when the stop ran, after that line.
import { CML } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVectorTools } from '../../src/vector/vector.ts';
import { setDecoderStop } from '../../src/vector/decoder-health.ts';
import { FIXTURE_UTXOS, FixtureProvider, FOREIGN_ADDRESS, OWN_ADDRESS } from './fixture-provider.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const handlers = new Map<string, Handler>();
const server = { tool: (name: string, _description: string, _shape: unknown, handler: Handler) => { handlers.set(name, handler); } } as unknown as McpServer;
registerVectorTools(server, 'decoder-stop-child', () => Object.assign(new FixtureProvider(FIXTURE_UTXOS), { evaluateTransaction: async () => [] }));
setDecoderStop(() => process.exit(1));

const scenario = process.argv[2];
if (scenario === 'unusable') {
  // The instance of the library is not in its type declarations: the generated glue code exports it as `__wasm`.
  const instance: unknown = Reflect.get(CML, '__wasm');
  if (typeof instance !== 'object' || instance === null || !('memory' in instance) || !(instance.memory instanceof WebAssembly.Memory)) {
    throw new Error('the decoder library does not export its memory');
  }
  new Uint8Array(instance.memory.buffer).fill(0);
}
const recipientAddress = scenario === 'ordinary' ? 'not an address' : FOREIGN_ADDRESS;
const answer = await handlers.get('vector_build_send_apex')!({ changeAddress: OWN_ADDRESS, recipientAddress, amount: 3 });
console.log(`ANSWER ${answer.content[0].text.split('\n')[0]}`);
