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
// Empty since spec PR 8: family 3 (self-improvement) went keyless, taking the
// last custodial file (vector/self-improvement.ts) off the allowlist. Every
// builder family is now keyless - this set may never grow again (see the
// size-0 pin below).
const CUSTODIAL_UNTIL_LATER_PR = new Set<string>([]);
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
  // PR 8 drops self-improvement.ts to reach 0 - see the comment above
  // CUSTODIAL_UNTIL_LATER_PR). Pinning the size means any widening is a
  // deliberate, reviewable number change instead of a silent `.add(...)`
  // slipping through - and since the migration is complete, that number can
  // now only ever be 0.
  test('the allowlist may only shrink', () => {
    assert.equal(CUSTODIAL_UNTIL_LATER_PR.size, 0, 'the custodial allowlist is EMPTY - the migration is complete; it may never grow again');
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

// A second, narrower mechanical guard, same style as the custody boundary
// above but for a different invariant: gov-build.ts's buildProposalSpend
// exposes a 4th, TEST-ONLY `opts?: { localUPLCEval?: boolean }` parameter
// (documented in-source as an escape hatch used only by gov-build.test.ts's
// native-eval-attempt test - see gov-build.ts). Every production caller,
// including self-improvement.ts's vector_build_self_improvement_proposal_spend
// handler, must omit it and get gov-build.ts's own default
// (`opts?.localUPLCEval ?? false` - provider-side eval, parity with the
// deployed module). Nothing in the hermetic or smoke suites would notice a
// handler mutation that passed `{ localUPLCEval: true }` as a 4th argument:
// gov-build.test.ts tests buildProposalSpend directly (not through the tool
// handler), and the smoke suite only inspects tool schemas/descriptions, not
// handler bodies. This test closes that gap the same mechanical way the
// custody boundary above closes the mnemonic gap: by asserting on the
// compiled source text itself.
describe('self-improvement.ts never touches the test-only eval escape hatch', () => {
  test('the test-only eval escape hatch may never be passed from a tool handler', () => {
    const content = readFileSync(join(SRC_ROOT, 'vector/self-improvement.ts'), 'utf-8');
    assert.doesNotMatch(
      content,
      /localUPLCEval/,
      'self-improvement.ts must never reference localUPLCEval - the test-only eval escape hatch may never be passed from a tool handler; ' +
        'production callers always get gov-build.ts\'s own default (provider-side eval, parity with the deployed module). ' +
        'If buildProposalSpend is now being called with a 4th argument from a tool handler, remove it - that argument exists only for ' +
        'gov-build.test.ts\'s native-eval-attempt test.',
    );
  });
});
