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
const SCRIPTS_ROOT = resolve(import.meta.dirname!, '../scripts');
const CUSTODIAL_UNTIL_LATER_PR = new Set([
  'vector/self-improvement.ts',  // family 3 (governance) — goes keyless in spec PR 8
]);
// No \b boundaries: this is deliberately a substring match, not a whole-word
// one. Word-bounding let `seedPhrase`, `WALLET_SEED` or `bip39x` slip past
// undetected — those are real key-material vocabulary wearing a different
// word shape, not false positives. `fromSeed`/`walletFromSeed` are already
// covered as substrings of `seed`, but stay in the alternation anyway for
// self-documentation (they cost nothing and name the exact API shape this
// guard exists to catch).
const FORBIDDEN = /(mnemonic|seed|bip39|fromSeed|walletFromSeed|selectWallet\.fromSeed)/i;

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
    // scripts/ is dev-tooling, not shipped builder source - it has no
    // custodial carve-out, so nothing here is ever checked against the
    // allowlist (unlike SRC_ROOT files above).
    for (const file of sourceFiles(SCRIPTS_ROOT)) {
      const rel = relative(SCRIPTS_ROOT, file).replace(/\\/g, '/');
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) offenders.push(`scripts/${rel}:${i + 1}: ${line.trim()}`);
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

  // The allowlist may only shrink (PR 7 dropped agent-network.ts to reach 1,
  // PR 8 drops self-improvement.ts to reach 0 - see the "goes keyless in spec
  // PR N" comment above). Pinning the size means any widening is a deliberate,
  // reviewable number change instead of a silent `.add(...)` slipping through.
  test('the allowlist may only shrink', () => {
    assert.equal(CUSTODIAL_UNTIL_LATER_PR.size, 1, 'the custodial allowlist may only shrink - spec PR 8 takes it to 0');
  });

  // Pins every FORBIDDEN alternative individually against a fixture corpus, so
  // deleting one alternative from the regex (e.g. "we don't need bip39
  // anymore") fails a test by name instead of silently narrowing what this
  // guard catches. Also pins representative keyless vocabulary that must NOT
  // trip the guard, so widening FORBIDDEN too aggressively is equally visible.
  test('every FORBIDDEN alternative is individually pinned against a fixture corpus', () => {
    const mustMatch = [
      'mnemonic', 'MNEMONIC', 'seedPhrase', 'WALLET_SEED', 'bip39',
      'fromSeed', 'walletFromSeed', 'selectWallet.fromSeed', 'seed',
    ];
    for (const s of mustMatch) {
      assert.match(s, FORBIDDEN, `FORBIDDEN should match "${s}" - deleting the alternative that catches this would silently narrow the guard`);
    }

    const mustNotMatch = ['address-only wallet', 'unsigned transaction', 'changeAddress'];
    for (const s of mustNotMatch) {
      assert.doesNotMatch(s, FORBIDDEN, `FORBIDDEN should NOT match "${s}" - this is legitimate keyless vocabulary`);
    }
  });
});
