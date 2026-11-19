// packages/builder/test/cbor-guard-fixtures.test.ts
// Every transaction, datum, metadata and script in the fixtures passes the checks of the builder. The test reads the fixture files (the JSON
// files and the quoted hex of the TypeScript fixtures, and the real transactions in the tests of the signer), finds the hex texts that a
// library reads as a transaction, as Plutus data or as metadata, and checks that the check of cbor-depth.ts accepts each one. A text that
// the library reads and the check refuses would be a valid input that the builder refuses. The compiled scripts of the blueprints and the
// fixtures must pass assertScriptInput the same way.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CML, applyDoubleCborEncoding } from '@lucid-evolution/lucid';
import { assertCborDepth, assertCborHexDepth } from '@apexfusion/vector-mcp-shared/cbor-depth';
import { assertScriptInput } from '../src/vector/guarded-decode.ts';

const TESTS = resolve(import.meta.dirname!);
const PACKAGES = join(TESTS, '..', '..');
const FIXTURES = join(TESTS, 'fixtures');
// The transactions that the tests of the builder use are built on the spot by the builders. The real transactions are in the tests of the signer.
const SIGNER_TESTS = ['decode.test.ts', 'sign.test.ts', 'smoke/signer-tools.test.ts'].map((name) => join(PACKAGES, 'signer/test', name));
const FIXTURE_FILES = readdirSync(FIXTURES).filter((name) => name.endsWith('.json') || name.endsWith('.ts')).sort().map((name) => join(FIXTURES, name));
const texts = new Map([...FIXTURE_FILES, ...SIGNER_TESTS].map((path) => [relative(PACKAGES, path), readFileSync(path, 'utf8')] as const));

/** The quoted hex texts of at least 8 bytes in a file, once each. */
function hexTexts(text: string): string[] {
  return [...new Set([...text.matchAll(/["'`]([0-9a-fA-F]{16,})["'`]/g)].map((match) => match[1]).filter((hex) => hex.length % 2 === 0))];
}

// The library may read only a prefix of its input, so a value counts only when it writes itself back as the same text.
const asTransaction = (hex: string): boolean => { try { return CML.Transaction.from_cbor_hex(hex).to_cbor_hex() === hex.toLowerCase(); } catch { return false; } };
const asData = (hex: string): boolean => { try { return CML.PlutusData.from_cbor_hex(hex).to_cbor_hex() === hex.toLowerCase(); } catch { return false; } };
const asMetadatum = (hex: string): boolean => { try { return Buffer.from(CML.TransactionMetadatum.from_cbor_bytes(Buffer.from(hex, 'hex')).to_cbor_bytes()).toString('hex') === hex.toLowerCase(); } catch { return false; } };

describe('the fixtures are inside the checks', () => {
  test('every hex text that a library reads as a transaction, Plutus data or metadata passes the check of its kind', (t) => {
    const refused: string[] = [];
    const count = { transaction: 0, data: 0, metadata: 0 };
    for (const [name, text] of texts) {
      for (const hex of hexTexts(text)) {
        const check = (kind: keyof typeof count, run: () => void): void => {
          count[kind] += 1;
          try { run(); } catch (err) { refused.push(`${name}: ${kind} ${hex.slice(0, 60)}...: ${(err as Error).message}`); }
        };
        if (asTransaction(hex)) check('transaction', () => assertCborHexDepth(hex, { kind: 'transaction' }));
        else if (asData(hex)) check('data', () => assertCborHexDepth(hex));
        else if (asMetadatum(hex)) check('metadata', () => assertCborDepth(Buffer.from(hex, 'hex')));
      }
    }
    t.diagnostic(`${texts.size} files: ${count.transaction} transactions, ${count.data} datums, ${count.metadata} metadata values`);
    assert.deepEqual(refused, []);
    assert.ok(count.transaction >= 3 && count.data >= 20, `the scan found ${JSON.stringify(count)}: it must find the fixtures`);
  });

  test('every compiled script of the blueprints and of the fixtures passes assertScriptInput, and Lucid reads it as before', (t) => {
    const scripts = new Map<string, string>();
    for (const [name, text] of texts) {
      if (name.endsWith('.json')) {
        for (const match of text.matchAll(/"(?:compiledCode|cborHex|scriptCbor)"\s*:\s*"([0-9a-fA-F]+)"/g)) scripts.set(`${name} ${match[1].slice(0, 16)}`, match[1]);
      } else {
        for (const match of text.matchAll(/\b[A-Z_]*SCRIPT_CBOR\b[^=]*=\s*'([0-9a-fA-F]+)'/g)) scripts.set(`${name} ${match[1].slice(0, 16)}`, match[1]);
      }
    }
    t.diagnostic(`${scripts.size} scripts`);
    assert.ok(scripts.size >= 5, `the scan found ${scripts.size} scripts: it must find the fixtures`);
    for (const [what, script] of scripts) {
      assert.doesNotThrow(() => assertScriptInput(script), what);
      assert.doesNotThrow(() => applyDoubleCborEncoding(script), what);
    }
  });
});
