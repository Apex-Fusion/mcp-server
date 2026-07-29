import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

/**
 * The builder-side custody guarantee, made mechanical (design-spec success
 * criterion 1: "grep-able: zero mnemonic params in the builder").
 *
 * Files still on the custodial path are explicitly allowlisted with the PR
 * that removes them. Shrinking this list is the definition of done for the
 * non-custodial split; growing it should be impossible to do accidentally.
 */
const SRC_ROOT = resolve(import.meta.dirname!, '../src');
const CUSTODIAL_UNTIL_LATER_PR = new Set([
  'vector/agent-network.ts',     // family 2 — goes keyless in spec PR 7
  'vector/self-improvement.ts',  // family 3 — goes keyless in spec PR 8
]);
const FORBIDDEN = /\b(mnemonic|seed|bip39|fromSeed|walletFromSeed|selectWallet\.fromSeed)\b/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js|mjs|cjs|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('builder custody boundary', () => {
  test('no key-material vocabulary outside the allowlisted custodial files', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (CUSTODIAL_UNTIL_LATER_PR.has(rel)) continue;
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `key-material vocabulary found in keyless builder source:\n${offenders.join('\n')}`);
  });

  test('the allowlist matches reality (files removed from the custodial path must leave the list)', () => {
    for (const rel of CUSTODIAL_UNTIL_LATER_PR) {
      const content = readFileSync(join(SRC_ROOT, rel), 'utf-8');
      assert.match(
        content, FORBIDDEN,
        `${rel} is allowlisted as custodial but contains no key-material vocabulary - remove it from CUSTODIAL_UNTIL_LATER_PR`,
      );
    }
  });
});
