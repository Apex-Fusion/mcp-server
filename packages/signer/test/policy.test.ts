import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOutflow, evaluate, type SpendLimits } from '../src/policy.ts';
import type { DecodedTx } from '../src/decode.ts';

const OWN = 'addr1own';
const OTHER_OWN = 'addr1own_second_index';
const FOREIGN = 'addr1foreign';
const FOREIGN2 = 'addr1foreign_second';

const LIMITS: SpendLimits = { perTxLovelace: 100_000_000n, dailyLovelace: 500_000_000n };

function tx(partial: Partial<DecodedTx>): DecodedTx {
  return {
    txHashHex: 'a'.repeat(64),
    fee: 200_000n,
    outputs: [],
    inputCount: 1,
    mintedAssetCount: 0,
    ...partial,
  };
}

describe('computeOutflow', () => {
  test('counts a foreign output plus the fee', () => {
    const r = computeOutflow(tx({ outputs: [{ address: FOREIGN, lovelace: 3_000_000n, assets: [] }] }), [OWN]);
    assert.equal(r.netOutflowLovelace, 3_200_000n);
  });

  test('excludes change returning to our own address', () => {
    const r = computeOutflow(
      tx({ outputs: [
        { address: FOREIGN, lovelace: 3_000_000n, assets: [] },
        { address: OWN, lovelace: 996_000_000n, assets: [] },
      ] }),
      [OWN]
    );
    assert.equal(r.netOutflowLovelace, 3_200_000n, 'change must not count as outflow');
  });

  test('counts the fee even when every output returns to us', () => {
    const r = computeOutflow(tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }), [OWN]);
    assert.equal(r.netOutflowLovelace, 200_000n);
  });

  test('honours multiple own addresses', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: OTHER_OWN, lovelace: 7_000_000n, assets: [] }] }),
      [OWN, OTHER_OWN]
    );
    assert.equal(r.netOutflowLovelace, 200_000n);
  });

  test('records assets leaving to a foreign address', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: FOREIGN, lovelace: 2_000_000n, assets: [{ unit: 'policy1nft', quantity: 1n }] }] }),
      [OWN]
    );
    assert.deepStrictEqual(r.assetMovements, [{ unit: 'policy1nft', quantity: 1n, toAddress: FOREIGN }]);
  });

  test('does not record assets returning to us', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: OWN, lovelace: 2_000_000n, assets: [{ unit: 'policy1nft', quantity: 1n }] }] }),
      [OWN]
    );
    assert.deepStrictEqual(r.assetMovements, []);
  });
});

describe('evaluate — adversarial', () => {
  test('refuses a drain that exceeds the per-transaction limit', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 250_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /per-transaction limit/i);
  });

  test('allows a transaction inside both limits', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 3_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
    assert.equal(d.reason, undefined);
  });

  test('refuses when the daily budget is already exhausted', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 10_000_000n, assets: [] }] }),
      [OWN], LIMITS, 495_000_000n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /daily/i);
  });

  test('a large transaction is allowed if it fits exactly', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 100_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
  });

  test('a transaction with no outputs still charges the fee', () => {
    const d = evaluate(tx({ outputs: [] }), [OWN], LIMITS, 0n);
    assert.equal(d.netOutflowLovelace, 200_000n);
    assert.equal(d.allowed, true);
  });

  test('refuses when ownAddresses is empty — nothing can be classified as change', () => {
    const d = evaluate(
      tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }),
      [], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });

  test('the reported outflow is always present, even on refusal', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 250_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.netOutflowLovelace, 250_200_000n);
  });
});

// --- Adversarial pass (beyond the brief) -----------------------------------
//
// The brief's 13 tests are a floor. Everything below was added after they
// passed, specifically hunting for the failure shape this module is uniquely
// exposed to: a wrong comparison or a missed exclusion that does not throw,
// it just quietly returns `allowed: true` when it should not.

describe('evaluate — ownAddresses containing only blank entries', () => {
  // A realistic real-world source of this: `''.split(',')` in JS yields `['']`,
  // not `[]`. If whatever populates ownAddresses from config/env ever hits that
  // empty-string case, the array is non-empty but contains no usable address.
  // `ownAddresses.length === 0` alone does not catch this: the array has
  // length 1. Every real output then fails to match the blank entry, so it is
  // over-counted as outflow rather than silently permitted — the safe
  // direction — but the explicit, intentional fail-closed path (and its
  // message) is bypassed, and if the (over-counted) outflow happens to still
  // land under the configured limits, the transaction is signed even though
  // no real own address was ever known. That is the same condition the
  // empty-array check exists to refuse; it should refuse here too.
  test('a single blank entry is treated as no known own address (fails closed)', () => {
    const d = evaluate(
      tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }),
      [''], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });

  test('a blank entry alongside a real own address does not weaken matching', () => {
    // Regression guard for the fix above: filtering blanks must not touch a
    // list that also contains a genuine address.
    const r = computeOutflow(
      tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }),
      ['', OWN]
    );
    assert.equal(r.netOutflowLovelace, 200_000n, 'OWN must still be recognised as change');
  });
});

describe('evaluate — ownAddresses entries built from invisible Unicode characters', () => {
  // `.trim()` alone is not enough to detect "not a real address": it strips
  // the ECMAScript WhiteSpace set (which includes NBSP U+00A0 and BOM
  // U+FEFF) but not every invisible character. U+200B ZERO WIDTH SPACE and
  // U+2060 WORD JOINER are Unicode category Cf (format), not Zs (space
  // separator) or part of ECMAScript's WhiteSpace production, so trimming
  // either one leaves a non-empty string — a trim-then-check-length filter
  // alone would let either slip past exactly the way '' used to. (U+00A0 and
  // U+FEFF, by contrast, ARE stripped by .trim() and were never actually a
  // gap here — verified directly before writing these tests: only U+200B and
  // U+2060 reproduce it.) A denylist of "invisible" codepoints is not the
  // fix: there are dozens of Cf/Cc codepoints and more get added, so this is
  // a positive check instead — an entry only counts as a known own address
  // if, after trimming, it starts with the 'addr' prefix every
  // Cardano/Vector payment address actually uses. Nothing built purely from
  // invisible characters can satisfy that.
  // Built via fromCharCode rather than a literal escape so the codepoint is
  // unambiguous in source and cannot be misrendered by an editor or diff tool.
  const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
  const WORD_JOINER = String.fromCharCode(0x2060);

  test('a single ZERO WIDTH SPACE (U+200B) entry is treated as no known own address', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 5_000_000n, assets: [] }] }),
      [ZERO_WIDTH_SPACE], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });

  test('a single WORD JOINER (U+2060) entry is treated as no known own address', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 5_000_000n, assets: [] }] }),
      [WORD_JOINER], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });

  test('a genuine addr1... address is still accepted (the positive check does not over-reject)', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }),
      [OWN]
    );
    assert.equal(r.netOutflowLovelace, 200_000n, 'a real own address must still be recognised as change');
  });
});

describe('evaluate — knownAddresses must store the trimmed value, not just check it', () => {
  // Real bug, found reviewing the invisible-character fix, present since that
  // fix's very first version: the filter checked `address.trim().startsWith(...)`
  // but Array.prototype.filter always returns the ORIGINAL element on a match,
  // never a transformed one. So an entry that only qualified after trimming
  // was kept *with its padding intact*, then compared by exact string
  // equality against real output addresses (always clean, never padded) —
  // which can never match. The address passes the fail-closed gate (it
  // "looks like" a known address) but is then functionally invisible to
  // computeOutflow's classification, so every one of its own change outputs
  // gets counted as outflow instead of being excluded. Since change is
  // usually the dominant value in a UTxO transaction, a single incidental
  // leading or trailing space on a configured own address would refuse
  // nearly every real transaction at a wildly inflated outflow figure.
  test('a leading space on a real own address no longer hides its change output (regression test for the fix)', () => {
    const d = evaluate(
      tx({ outputs: [
        { address: FOREIGN, lovelace: 3_000_000n, assets: [] },
        { address: OWN, lovelace: 996_000_000n, assets: [] },
      ] }),
      [' ' + OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
    assert.equal(d.netOutflowLovelace, 3_200_000n, 'only the genuine foreign spend + fee, not the misclassified change');
  });

  test('a trailing space on a real own address no longer hides its change output', () => {
    const d = evaluate(
      tx({ outputs: [
        { address: FOREIGN, lovelace: 3_000_000n, assets: [] },
        { address: OWN, lovelace: 996_000_000n, assets: [] },
      ] }),
      [OWN + ' '], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
    assert.equal(d.netOutflowLovelace, 3_200_000n);
  });

  test('residual: a trailing invisible character still hides the change output, since .trim() does not strip it — same safe direction', () => {
    // Documented, deliberate residual (see the comment on knownAddresses in
    // policy.ts): fixing this specific case would mean reaching for the
    // denylist-of-invisible-codepoints approach the positive check exists to
    // avoid. Pinned here so it stays a known, bounded gap rather than an
    // implicit assumption — and because it fails in the safe direction
    // (refuses a legitimate transaction) rather than the dangerous one.
    const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
    const d = evaluate(
      tx({ outputs: [
        { address: FOREIGN, lovelace: 3_000_000n, assets: [] },
        { address: OWN, lovelace: 996_000_000n, assets: [] },
      ] }),
      [OWN + ZERO_WIDTH_SPACE], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.equal(d.netOutflowLovelace, 999_200_000n, 'the change is still misclassified as outflow — known, bounded, safe-direction residual');
  });

  test('an entry merely containing "addr" without starting with it is not a known own address (prefix, not substring)', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 5_000_000n, assets: [] }] }),
      ['xxxaddrxxx'], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });

  test('a case-variant entry does not match a real own address (pins the existing case-sensitivity decision)', () => {
    const CASE_VARIANT = 'ADDR1own'; // OWN is 'addr1own'
    const d = evaluate(
      tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }),
      [CASE_VARIANT], LIMITS, 0n
    );
    // knownAddresses([CASE_VARIANT]) is empty (case-sensitive prefix check
    // fails), so this hits the fail-closed "no own address" path rather than
    // the over-counting path — either way, OWN must not be recognised as
    // change, which is the property this test pins.
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });
});

describe('computeOutflow — the filter applies at the Set-construction site itself, not only in evaluate()', () => {
  // evaluate()'s fail-closed guard and computeOutflow()'s own Set both call
  // knownAddresses(), but nothing above exercises them independently: every
  // prior blank/invisible-entry test either goes through evaluate() (whose
  // guard would refuse before computeOutflow's classification could matter)
  // or pairs a blank ownAddresses entry with a *real* output address (which
  // would pass either way, filtered or not). That leaves a real gap: if a
  // future edit filtered ownAddresses in evaluate()'s guard but left
  // computeOutflow's `new Set(ownAddresses)` unfiltered, nothing here would
  // catch it, because a blank entry in an otherwise-unfiltered Set only
  // matters when something can actually match it — i.e. when an output
  // address is *also* blank. decode.ts can never produce that: every output
  // address comes from `o.address().to_bech32()`, which throws before an
  // empty or blank address could ever reach a DecodedOutput (see decode.ts's
  // per-output try/catch). So this is unreachable through the real pipeline
  // — but computeOutflow is an exported pure function with its own contract,
  // and that contract must hold regardless of what the current pipeline
  // happens to be able to construct.
  test('a blank output address is counted as outflow, not matched as change via a blank ownAddresses entry', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: '', lovelace: 5_000_000n, assets: [] }] }),
      ['']
    );
    assert.equal(
      r.netOutflowLovelace,
      5_200_000n,
      'a blank output address must never be classified as change, even against a blank ownAddresses entry'
    );
  });

  test('an output address built from an invisible character is counted as outflow, not matched as change', () => {
    const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
    const r = computeOutflow(
      tx({ outputs: [{ address: ZERO_WIDTH_SPACE, lovelace: 5_000_000n, assets: [] }] }),
      [ZERO_WIDTH_SPACE]
    );
    assert.equal(r.netOutflowLovelace, 5_200_000n);
  });
});

describe('evaluate — exact limit boundaries, one lovelace either side', () => {
  test('one lovelace under the per-transaction limit is allowed', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 99_999_999n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
  });

  test('one lovelace over the per-transaction limit is refused', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 100_000_001n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /per-transaction limit/i);
  });

  test('a daily total landing exactly on the limit is allowed', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 50_000_000n, assets: [] }] }),
      [OWN], LIMITS, 450_000_000n // 450M + 50M == 500M dailyLovelace, exactly
    );
    assert.equal(d.allowed, true);
  });

  test('one lovelace over the daily limit is refused', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 50_000_000n, assets: [] }] }),
      [OWN], LIMITS, 450_000_001n // sum == dailyLovelace + 1
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /daily/i);
  });

  test('one lovelace under the daily limit is allowed', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 50_000_000n, assets: [] }] }),
      [OWN], LIMITS, 449_999_999n // sum == dailyLovelace - 1
    );
    assert.equal(d.allowed, true);
  });
});

describe('evaluate — many small foreign outputs must sum, not spot-check', () => {
  test('34 outputs of 3 AP3X each breach a 100 AP3X per-transaction limit on their sum', () => {
    // No single output is anywhere near the limit (3_000_000n each); only the
    // total is. A check that inspected outputs individually rather than
    // summing would wrongly allow this.
    const outputs = Array.from({ length: 34 }, () => ({ address: FOREIGN, lovelace: 3_000_000n, assets: [] }));
    const d = evaluate(tx({ outputs }), [OWN], LIMITS, 0n);
    assert.equal(d.netOutflowLovelace, 102_200_000n); // 34 * 3,000,000 + 200,000 fee
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /per-transaction limit/i);
  });
});

describe('computeOutflow — aggregation correctness', () => {
  test('sums repeated outputs to the same foreign address rather than deduplicating', () => {
    const r = computeOutflow(
      tx({ outputs: [
        { address: FOREIGN, lovelace: 1_000_000n, assets: [] },
        { address: FOREIGN, lovelace: 2_000_000n, assets: [] }, // same address again
        { address: OWN, lovelace: 50_000_000n, assets: [] },     // change, excluded
        { address: FOREIGN2, lovelace: 3_000_000n, assets: [] }, // a different foreign address
      ] }),
      [OWN]
    );
    assert.equal(r.netOutflowLovelace, 6_200_000n); // 1M + 2M + 3M + 200K fee; 50M change excluded
  });

  test('duplicate entries in ownAddresses do not change classification', () => {
    const r = computeOutflow(
      tx({ outputs: [
        { address: OWN, lovelace: 5_000_000n, assets: [] },
        { address: OTHER_OWN, lovelace: 3_000_000n, assets: [] },
        { address: FOREIGN, lovelace: 2_000_000n, assets: [] },
      ] }),
      [OWN, OWN, OTHER_OWN, OTHER_OWN]
    );
    assert.equal(r.netOutflowLovelace, 2_200_000n); // only the foreign output + fee
  });

  test('an own address supplied in a different case does not match — over-counts as outflow, the safe direction', () => {
    // Bech32 addresses are canonically lowercase and decode.ts only ever emits
    // that canonical form, so this should not arise in practice. Pinning it
    // anyway: a mismatch here fails toward refusing too much, never toward
    // missing real outflow, which is the direction that matters.
    const r = computeOutflow(
      tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }),
      ['ADDR1OWN']
    );
    assert.equal(r.netOutflowLovelace, 5_200_000n, 'differently-cased own address must not be recognised as change');
  });

  test('records every distinct asset on a single foreign output, not just the first', () => {
    const r = computeOutflow(
      tx({ outputs: [{
        address: FOREIGN,
        lovelace: 2_000_000n,
        assets: [
          { unit: 'policy1nft', quantity: 1n },
          { unit: 'policy2token', quantity: 500n },
        ],
      }] }),
      [OWN]
    );
    assert.deepStrictEqual(r.assetMovements, [
      { unit: 'policy1nft', quantity: 1n, toAddress: FOREIGN },
      { unit: 'policy2token', quantity: 500n, toAddress: FOREIGN },
    ]);
  });

  test('aggregates assets across multiple foreign outputs rather than keeping only the last', () => {
    const r = computeOutflow(
      tx({ outputs: [
        { address: FOREIGN, lovelace: 2_000_000n, assets: [{ unit: 'nftA', quantity: 1n }] },
        { address: FOREIGN2, lovelace: 3_000_000n, assets: [{ unit: 'nftB', quantity: 1n }] },
      ] }),
      [OWN]
    );
    assert.deepStrictEqual(r.assetMovements, [
      { unit: 'nftA', quantity: 1n, toAddress: FOREIGN },
      { unit: 'nftB', quantity: 1n, toAddress: FOREIGN2 },
    ]);
  });
});

describe('evaluate — check ordering is pinned, not incidental', () => {
  test('a transaction breaching both limits at once reports the per-transaction reason first', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 250_000_000n, assets: [] }] }),
      [OWN], LIMITS, 400_000_000n // also breaches the daily limit (250M + 400M > 500M)
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /per-transaction limit/i);
    assert.doesNotMatch(d.reason!, /daily/i);
  });

  test('an empty ownAddresses list reports the own-address reason before any limit is even considered', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 250_000_000n, assets: [] }] }),
      [], LIMITS, 400_000_000n // this transaction would also fail both limit checks
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });
});

describe('evaluate — zero limits and an already-over-budget day', () => {
  test('zero limits still allow a genuinely zero-value transaction', () => {
    const zeroLimits: SpendLimits = { perTxLovelace: 0n, dailyLovelace: 0n };
    const d = evaluate(tx({ fee: 0n, outputs: [] }), [OWN], zeroLimits, 0n);
    assert.equal(d.netOutflowLovelace, 0n);
    assert.equal(d.allowed, true);
  });

  test('zero limits refuse even the smallest positive outflow', () => {
    const zeroLimits: SpendLimits = { perTxLovelace: 0n, dailyLovelace: 0n };
    const d = evaluate(tx({ fee: 1n, outputs: [] }), [OWN], zeroLimits, 0n);
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /per-transaction limit/i);
  });

  test('an already over-budget day clamps the reported remaining budget to zero, not negative', () => {
    // alreadySpentTodayLovelace (600M) already exceeds dailyLovelace (500M) —
    // should not happen if the audit log is accounted correctly, but the
    // module must still behave sanely (and keep refusing) if it ever does.
    const d = evaluate(tx({ outputs: [] }), [OWN], LIMITS, 600_000_000n);
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /daily/i);
    assert.match(d.reason!, /remaining daily budget of 0\.000000 AP3X/);
  });
});

describe('policy — known gap: SpendLimits governs lovelace only, not native asset value', () => {
  test('a transaction moving a native asset to a foreign address is allowed if lovelace stays under both limits', () => {
    // computeOutflow tracks assetMovements, but evaluate() only compares
    // netOutflowLovelace against limits — it never inspects assetMovements.
    // A transaction that sends an NFT or a large token balance out while
    // keeping the lovelace side minimal (e.g. just the ~2 AP3X min-UTxO
    // deposit) passes both limit checks untouched. SpendLimits has no
    // asset-value dimension to check against, so this is not a coding
    // mistake relative to the given interface — it is a scope boundary of
    // this policy, pinned here so it is visible rather than silently assumed.
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 2_000_000n, assets: [{ unit: 'preciousNFT', quantity: 1n }] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
    assert.deepStrictEqual(d.assetMovements, [{ unit: 'preciousNFT', quantity: 1n, toAddress: FOREIGN }]);
  });
});

describe('evaluate — bigint precision at magnitudes beyond float safety', () => {
  test('the bigint outflow figure stays exact past Number.MAX_SAFE_INTEGER, even though the human-readable message may round', () => {
    // ada() formats via Number() for the reason string only; the allow/deny
    // decision itself is decided entirely in bigint arithmetic and must never
    // lose precision, no matter how large the values get. Not reachable at
    // this system's real scale (limits and balances run to hundreds of AP3X,
    // far below 2^53 lovelace) — tested anyway because the decision-critical
    // field must hold regardless of realistic bounds.
    const HUGE_FEE = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    const zeroLimits: SpendLimits = { perTxLovelace: 0n, dailyLovelace: 0n };
    const d = evaluate(tx({ fee: HUGE_FEE, outputs: [] }), [OWN], zeroLimits, 0n);
    assert.equal(d.allowed, false);
    assert.equal(d.netOutflowLovelace, HUGE_FEE, 'the bigint decision figure must never lose precision');
  });
});
