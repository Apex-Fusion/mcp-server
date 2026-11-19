// packages/builder/test/fixtures/decoder-watch.ts
//
// For the tests of the CBOR check (cbor-guard*.test.ts, and the refusals in jury-document.test.ts and wallet-tools.test.ts). A watch stands
// in for a decoder for the length of a test (`mock.restoreAll()` in afterEach takes it away). An input that nests no deeper than the limit
// goes to the real decoder. A deeper input is counted, and the watch throws a marked Error for it: the real decoder never sees it, and the
// guard that should have refused it is the failure. So a test shows a missing guard without a deep input reaching CML.
import { mock } from 'node:test';
import { CML, Data } from '@lucid-evolution/lucid';
import { CborGuardError, cborDepth } from '@apexfusion/vector-mcp-shared/cbor-depth';

type Decoder = (input: string | Uint8Array, ...rest: unknown[]) => unknown;

export interface DecoderWatch {
  /** How many inputs that nest past the limit reached a watched decoder. */
  reached: () => number;
}

/** Watches `target[method]`, which takes hex or bytes as its first argument. */
export function watchDecoder(target: object, method: string): DecoderWatch {
  const real = (target as Record<string, Decoder>)[method].bind(target);
  let reached = 0;
  mock.method(target as Record<string, Decoder>, method, (input: string | Uint8Array, ...rest: unknown[]) => {
    try {
      cborDepth(typeof input === 'string' ? Buffer.from(input, 'hex') : input);
    } catch (err) {
      // cborDepth has the limit of the scanner: it refuses the first level past it. Any other refusal is not CBOR: the real decoder refuses it.
      if (err instanceof CborGuardError && err.reason === 'depth') {
        reached += 1;
        throw new Error('DECODER REACHED: the guard did not refuse this input');
      }
    }
    return real(input, ...rest);
  });
  return { reached: () => reached };
}

/** Watches Lucid's `Data.from` and the decoders of CML that this package, and Lucid for it, call on CBOR that this package did not build. */
export function watchAllDecoders(): DecoderWatch {
  const watches = [
    watchDecoder(Data, 'from'), watchDecoder(CML.PlutusData, 'from_cbor_hex'), watchDecoder(CML.Transaction, 'from_cbor_hex'),
    watchDecoder(CML.TransactionMetadatum, 'from_cbor_bytes'),
  ];
  return { reached: () => watches.reduce((sum, watch) => sum + watch.reached(), 0) };
}
