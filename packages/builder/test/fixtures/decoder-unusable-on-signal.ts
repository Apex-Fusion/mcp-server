// packages/builder/test/fixtures/decoder-unusable-on-signal.ts
//
// A preload for decoder-stop-server.test.ts (`node --import tsx --import <this file> <entry point>`). When the process gets the signal
// SIGUSR2, the decoder library of the process is made unusable: the memory of its instance is overwritten with zeros.
import { CML } from '@lucid-evolution/lucid';

process.on('SIGUSR2', () => {
  // The instance of the library is not in its type declarations: the generated glue code exports it as `__wasm`.
  const instance: unknown = Reflect.get(CML, '__wasm');
  if (typeof instance !== 'object' || instance === null || !('memory' in instance) || !(instance.memory instanceof WebAssembly.Memory)) {
    throw new Error('the decoder library does not export its memory');
  }
  new Uint8Array(instance.memory.buffer).fill(0);
  console.error('The decoder library of this process is unusable.');
});
