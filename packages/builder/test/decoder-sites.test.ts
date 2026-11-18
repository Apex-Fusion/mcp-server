// packages/builder/test/decoder-sites.test.ts
// Where the sources of the builder call the decoder library of Lucid. Every address is read through addressDetails (guarded-decode.ts),
// which refuses the empty string first, so this test reads the sources and names each file that calls Lucid's getAddressDetails by itself.
// The fee of a transaction that a caller gives is read from its bytes (tx-fee.ts), so build.ts decodes no transaction.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PACKAGES = resolve(import.meta.dirname!, '../..');
const SOURCE_DIRECTORIES = ['builder/src', 'shared/src'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** The code of a source file: its comments are taken out, so that a sentence about a call is not a call. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

describe('build.ts', () => {
  test('build.ts decodes no transaction: the fee of a transaction that a caller gives is read from its bytes', () => {
    const code = codeOf(join(PACKAGES, 'builder/src/vector/build.ts'));
    assert.doesNotMatch(code, /\bTransaction\.from_cbor|\bfromTx\s*\(/);
    assert.ok(code.includes('readTransactionFee('), 'declaredFee reads the fee with readTransactionFee');
  });
});

/**
 * Lucid reads addresses inside some of its own calls. Each entry names a call that reads an address, the files of this package that make the
 * call, and why that is safe. A call in a file that is not named here fails the test: whoever adds the call says here why it is safe.
 */
interface LucidDecode { decode: string; call: RegExp; files: string[]; why: string }
const LUCID_DECODES: LucidDecode[] = [
  {
    decode: 'getAddressDetails: an address as text',
    call: /\bgetAddressDetails\s*\(/,
    files: ['builder/src/vector/guarded-decode.ts'],
    why: 'every address is read through addressDetails, which refuses the empty string before Lucid reads it',
  },
];

describe('the calls that read an address inside Lucid are named', () => {
  const code = new Map<string, string>();
  for (const directory of SOURCE_DIRECTORIES) for (const path of sourceFiles(join(PACKAGES, directory))) code.set(relative(PACKAGES, path), codeOf(path));

  for (const { decode, call, files, why } of LUCID_DECODES) {
    test(`${decode}: the files that make the call are the named ones`, () => {
      const found = [...code].filter(([, text]) => call.test(text)).map(([file]) => file).sort();
      assert.deepEqual(found, [...files].sort(), `name the new call in LUCID_DECODES, with the reason that it is safe (now: ${why})`);
    });
  }
});
