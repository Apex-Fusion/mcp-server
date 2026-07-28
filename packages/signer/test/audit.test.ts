import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog, type AuditEntry } from '../src/audit.ts';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signer-audit-'));
  logPath = join(dir, 'audit.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    txHash: 'b'.repeat(64),
    decision: 'signed',
    netOutflowLovelace: '3000000',
    assetMovements: 0,
    ...over,
  };
}

describe('AuditLog', () => {
  test('starts empty when the file does not exist', () => {
    const log = new AuditLog(logPath);
    assert.deepStrictEqual(log.recent(10), []);
    assert.equal(log.committedTodayLovelace(), 0n);
  });

  test('appends and persists to disk', () => {
    new AuditLog(logPath).append(entry());
    assert.ok(existsSync(logPath));
    assert.equal(JSON.parse(readFileSync(logPath, 'utf8')).length, 1);
  });

  test('reloads entries written by a previous instance', () => {
    new AuditLog(logPath).append(entry());
    assert.equal(new AuditLog(logPath).recent(10).length, 1);
  });

  test('sums only signed entries into today total', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '3000000' }));
    log.append(entry({ netOutflowLovelace: '5000000' }));
    assert.equal(log.committedTodayLovelace(), 8_000_000n);
  });

  test('excludes refused entries from today total', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '3000000' }));
    log.append(entry({ decision: 'refused', netOutflowLovelace: '900000000', reason: 'over limit' }));
    assert.equal(log.committedTodayLovelace(), 3_000_000n, 'a refusal must not consume budget');
  });

  test('excludes entries from previous days', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ timestamp: '2020-01-01T00:00:00.000Z', netOutflowLovelace: '400000000' }));
    log.append(entry({ netOutflowLovelace: '3000000' }));
    assert.equal(log.committedTodayLovelace(), 3_000_000n);
  });

  test('recent() returns newest first and respects the limit', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ txHash: 'c'.repeat(64) }));
    log.append(entry({ txHash: 'd'.repeat(64) }));
    const r = log.recent(1);
    assert.equal(r.length, 1);
    assert.equal(r[0].txHash, 'd'.repeat(64));
  });

  test('survives a corrupt log file rather than crashing', () => {
    // The brief's own version of this test called `require('node:fs')` here,
    // which throws `ReferenceError: require is not defined` in this package:
    // packages/signer/package.json sets "type": "module", so this file is
    // real ESM (not CJS-via-tsx-in-a-directory-with-no-package.json, which is
    // what made an ad-hoc isolated check of the same snippet misleadingly
    // pass). Using the top-level import instead is the only change from the
    // brief's given test code needed to make it run at all in this package.
    writeFileSync(logPath, 'not json at all');
    const log = new AuditLog(logPath);
    assert.deepStrictEqual(log.recent(10), []);
    log.append(entry());
    assert.equal(log.recent(10).length, 1);
  });
});

// --- Edge-case pass (beyond the brief) --------------------------------------
//
// The brief's 8 tests are a floor. Everything below was added after they
// passed, hunting specifically for the failure shape this module is exposed
// to: committedTodayLovelace() quietly returning a number that is too LOW
// (which loosens the daily limit) rather than throwing or visibly failing.
// Some of these were verified against plain Node semantics before writing an
// assertion, precisely because a couple of them are not what intuition
// suggests (see the BigInt('') and slice(-0) cases below).

/** Captures console.error output for the duration of `fn`, then restores it. */
function captureStderr(fn: () => void): string[] {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return messages;
}

describe('committedTodayLovelace — netOutflowLovelace parsing', () => {
  test('an unparseable amount (non-numeric text) does not crash the total and contributes nothing', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '3000000' }));
    log.append(entry({ netOutflowLovelace: 'not-a-number' }));
    assert.equal(log.committedTodayLovelace(), 3_000_000n);
  });

  test('a decimal amount is rejected by BigInt (no fractional lovelace) and contributes nothing', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '3000000' }));
    log.append(entry({ netOutflowLovelace: '3000000.5' }));
    assert.equal(log.committedTodayLovelace(), 3_000_000n);
  });

  test('an empty-string amount parses as BigInt("") === 0n — verified directly, it does NOT throw — so it contributes zero rather than crashing or getting "skipped"', () => {
    // BigInt("") is a genuine JS gotcha (mirrors Number("") === 0): the catch
    // block never fires for this input, so this is a different code path
    // from the non-numeric-text case above even though the externally
    // observable result (no change to the total) looks the same.
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '3000000' }));
    log.append(entry({ netOutflowLovelace: '' }));
    assert.equal(log.committedTodayLovelace(), 3_000_000n);
  });

  test('a negative amount parses successfully as a valid negative bigint but must not reduce the total', () => {
    // The dangerous case: BigInt('-5000000') does not throw, so without an
    // explicit sign check this entry would SUBTRACT from an already-correct
    // total — an actual under-report, not just a missed contribution. Not
    // reachable through the real decode.ts -> policy.ts pipeline (outputs
    // and fees are always non-negative), so this can only arise from a
    // corrupted or hand-edited log file, which is exactly the input this
    // module must not trust.
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '5000000' }));
    log.append(entry({ netOutflowLovelace: '-5000000' }));
    assert.equal(
      log.committedTodayLovelace(),
      5_000_000n,
      'a negative entry must never subtract from the committed total'
    );
  });
});

describe('committedTodayLovelace — timestamp handling', () => {
  test('a missing timestamp field does not crash the total and is excluded', () => {
    const raw = [
      { txHash: 'e'.repeat(64), decision: 'signed', netOutflowLovelace: '3000000', assetMovements: 0 },
      // no `timestamp` key at all — simulates an older or hand-edited entry.
    ];
    writeFileSync(logPath, JSON.stringify(raw));
    const log = new AuditLog(logPath);
    assert.equal(log.committedTodayLovelace(), 0n);
    assert.equal(log.recent(10).length, 1, 'the entry itself is still visible for forensic purposes');
  });

  test('an unparseable timestamp string does not crash the total and is excluded', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '3000000' }));
    log.append({ ...entry({ netOutflowLovelace: '9000000' }), timestamp: 'not-a-date' });
    assert.equal(log.committedTodayLovelace(), 3_000_000n);
  });

  test('a JSON null timestamp resolves to the 1970 epoch (verified: does not throw) and is excluded as not-today', () => {
    // new Date(null) is new Date(+null) = new Date(0) = the epoch — a VALID
    // date, not NaN. It still gets excluded, but via the "not today" branch
    // rather than the NaN branch; worth pinning so that distinction stays
    // intentional rather than incidental.
    const raw = [
      {
        txHash: 'e'.repeat(64),
        decision: 'signed',
        netOutflowLovelace: '3000000',
        assetMovements: 0,
        timestamp: null,
      },
    ];
    writeFileSync(logPath, JSON.stringify(raw));
    const log = new AuditLog(logPath);
    assert.equal(log.committedTodayLovelace(), 0n);
  });
});

describe('committedTodayLovelace — the UTC day boundary', () => {
  test('23:59 UTC yesterday is excluded and 00:01 UTC today is included', () => {
    const now = new Date();
    const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const yesterday2359 = new Date(startOfTodayUtc - 60_000).toISOString(); // 23:59:00 UTC yesterday
    const today0001 = new Date(startOfTodayUtc + 60_000).toISOString(); // 00:01:00 UTC today

    const log = new AuditLog(logPath);
    log.append(entry({ timestamp: yesterday2359, netOutflowLovelace: '400000000' }));
    log.append(entry({ timestamp: today0001, netOutflowLovelace: '3000000' }));
    assert.equal(log.committedTodayLovelace(), 3_000_000n, 'only the entry from today (UTC) should count');
  });

  test('an entry timestamped at exactly UTC midnight counts as today (inclusive boundary)', () => {
    const now = new Date();
    const startOfTodayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ).toISOString();

    const log = new AuditLog(logPath);
    log.append(entry({ timestamp: startOfTodayUtc, netOutflowLovelace: '3000000' }));
    assert.equal(log.committedTodayLovelace(), 3_000_000n);
  });
});

describe('load() — malformed on-disk shapes', () => {
  test('a JSON object at the top level (not an array) starts clean rather than crashing', () => {
    writeFileSync(logPath, JSON.stringify({ oops: 'not an array' }));
    const log = new AuditLog(logPath);
    assert.deepStrictEqual(log.recent(10), []);
    assert.equal(log.committedTodayLovelace(), 0n);
  });

  test('a bare JSON null at the top level starts clean rather than crashing', () => {
    writeFileSync(logPath, 'null');
    const log = new AuditLog(logPath);
    assert.deepStrictEqual(log.recent(10), []);
    assert.equal(log.committedTodayLovelace(), 0n);
  });

  test('a non-array top-level shape is reported on stderr, not silently accepted', () => {
    const messages = captureStderr(() => {
      writeFileSync(logPath, JSON.stringify({ oops: 'not an array' }));
      new AuditLog(logPath);
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /\[audit\]/);
  });

  test('a null element inside an otherwise-valid array crashed committedTodayLovelace() before the fix; now it is dropped and the rest of the log still counts', () => {
    // Verified directly against plain JS before writing this test: accessing
    // `.decision` on `null` throws (unlike a stray string or number element,
    // which just yields `undefined` and is safely skipped). One bad element
    // anywhere in the array — from a hand edit, a future producer bug, or a
    // torn write that happens to still leave valid-but-odd JSON — must not
    // take down accounting for every entry in the file.
    const good = entry({ netOutflowLovelace: '5000000' });
    writeFileSync(logPath, JSON.stringify([null, good]));
    const log = new AuditLog(logPath);
    assert.equal(log.committedTodayLovelace(), 5_000_000n);
    assert.equal(log.recent(10).length, 1, 'only the one genuine entry survives; null is dropped, not kept as a phantom entry');
  });

  test('dropping a null element is reported on stderr, not silently accepted', () => {
    const good = entry({ netOutflowLovelace: '5000000' });
    const messages = captureStderr(() => {
      writeFileSync(logPath, JSON.stringify([null, good]));
      new AuditLog(logPath);
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /\[audit\]/);
    assert.match(messages[0], /dropped 1 of 2/);
  });
});

describe('recent() — limit handling', () => {
  test('recent(0) returns no entries, not the entire log (slice(-0) === slice(0) is a JS gotcha — verified directly)', () => {
    // [1,2,3].slice(-0) returns [1,2,3], the whole array, because -0 < 0 is
    // false in JS — the "count back from the end" branch never triggers.
    // Without an explicit limit <= 0 guard, recent(0) would silently return
    // every entry ever recorded instead of none.
    const log = new AuditLog(logPath);
    log.append(entry());
    log.append(entry());
    assert.deepStrictEqual(log.recent(0), []);
  });

  test('a negative limit is treated the same as zero rather than slicing from the front', () => {
    const log = new AuditLog(logPath);
    log.append(entry());
    assert.deepStrictEqual(log.recent(-1), []);
  });

  test('recent(n) where n exceeds the entry count returns everything available, newest first', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ txHash: 'c'.repeat(64) }));
    log.append(entry({ txHash: 'd'.repeat(64) }));
    const r = log.recent(1000);
    assert.equal(r.length, 2);
    assert.equal(r[0].txHash, 'd'.repeat(64));
    assert.equal(r[1].txHash, 'c'.repeat(64));
  });
});

describe('append() — write failure', () => {
  test('a write to an unwritable path throws, but the entry is kept in this process\'s memory rather than lost', () => {
    const unwritablePath = join(dir, 'no-such-subdirectory', 'audit.json');
    const log = new AuditLog(unwritablePath);
    assert.throws(() => log.append(entry({ netOutflowLovelace: '3000000' })), /audit log write failed/i);
    // The write failed, but the decision it recorded must still be visible
    // to this same process — see the comment on append() in audit.ts for why
    // silently losing it here (or silently swallowing the write failure)
    // would be worse than throwing.
    assert.equal(log.recent(10).length, 1);
    assert.equal(log.committedTodayLovelace(), 3_000_000n);
  });

  test('a write failure is reported on stderr in addition to being thrown', () => {
    const unwritablePath = join(dir, 'no-such-subdirectory', 'audit.json');
    const log = new AuditLog(unwritablePath);
    const messages = captureStderr(() => {
      assert.throws(() => log.append(entry()));
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /\[audit\]/);
  });

  test('a refused entry\'s write failure throws exactly like a signed entry\'s — append() does not special-case by decision', () => {
    const unwritablePath = join(dir, 'no-such-subdirectory', 'audit.json');
    const log = new AuditLog(unwritablePath);
    assert.throws(
      () => log.append(entry({ decision: 'refused', reason: 'over limit', netOutflowLovelace: '900000000' })),
      /audit log write failed/i
    );
    assert.equal(log.recent(10).length, 1);
  });
});

describe('committedTodayLovelace — decision field integrity', () => {
  test('recent() returns entries newest-first even when some are refused, and refused entries carry their reason', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ netOutflowLovelace: '3000000' }));
    log.append(entry({ decision: 'refused', netOutflowLovelace: '900000000', reason: 'over limit' }));
    const r = log.recent(10);
    assert.equal(r.length, 2);
    assert.equal(r[0].decision, 'refused');
    assert.equal(r[0].reason, 'over limit');
    assert.equal(r[1].decision, 'signed');
  });

  test('many interleaved signed and refused entries: only the signed amounts sum, regardless of order', () => {
    const log = new AuditLog(logPath);
    log.append(entry({ decision: 'refused', netOutflowLovelace: '999000000', reason: 'too big' }));
    log.append(entry({ netOutflowLovelace: '1000000' }));
    log.append(entry({ decision: 'refused', netOutflowLovelace: '888000000', reason: 'too big' }));
    log.append(entry({ netOutflowLovelace: '2000000' }));
    log.append(entry({ decision: 'refused', netOutflowLovelace: '777000000', reason: 'too big' }));
    log.append(entry({ netOutflowLovelace: '4000000' }));
    assert.equal(log.committedTodayLovelace(), 7_000_000n);
    assert.equal(log.recent(100).length, 6);
  });
});
