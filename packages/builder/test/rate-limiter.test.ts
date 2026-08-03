import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, limiterFor, resetLimiters, MAX_TRACKED_IDENTITIES } from '../src/vector/rate-limiter.ts';

beforeEach(() => resetLimiters());

describe('RateLimiter', () => {
  test('allows calls up to the limit', () => {
    const l = new RateLimiter(3);
    assert.equal(l.check().allowed, true);
    assert.equal(l.check().allowed, true);
    assert.equal(l.check().allowed, true);
  });

  test('refuses the call after the limit and reports a retry delay', () => {
    const l = new RateLimiter(2);
    l.check();
    l.check();
    const r = l.check();
    assert.equal(r.allowed, false);
    assert.ok(typeof r.retryAfterMs === 'number' && r.retryAfterMs > 0);
  });

  test('a refused call does not consume budget', () => {
    const l = new RateLimiter(1);
    assert.equal(l.check().allowed, true);
    assert.equal(l.check().allowed, false);
    assert.equal(l.check().allowed, false, 'still refused, not compounding');
  });
});

describe('limiterFor', () => {
  test('returns the same limiter for the same identity', () => {
    assert.strictEqual(limiterFor('alice'), limiterFor('alice'));
  });

  test('returns different limiters for different identities', () => {
    assert.notStrictEqual(limiterFor('alice'), limiterFor('bob'));
  });

  test('one identity exhausting its budget does not affect another', () => {
    const alice = limiterFor('alice');
    for (let i = 0; i < 100; i++) alice.check();
    assert.equal(alice.check().allowed, false, 'alice should be exhausted');
    assert.equal(limiterFor('bob').check().allowed, true, 'bob must be unaffected');
  });

  test('the same identity reconnecting keeps its budget', () => {
    const first = limiterFor('alice');
    for (let i = 0; i < 100; i++) first.check();
    // A fresh lookup models a reconnect: it must not hand back a clean bucket.
    assert.equal(limiterFor('alice').check().allowed, false);
  });
});

// Beyond the brief's floor: unusual identity strings. `limiters` is a plain
// Map keyed by the identity string, so nothing here is expected to need
// special-casing - these tests exist to prove that empirically rather than
// assume it, the same way auth.ts's tests proved __proto__/constructor are
// inert against a Map-backed identities table.
describe('limiterFor — unusual identity strings', () => {
  test('the empty string is accepted as an ordinary, distinct identity key', () => {
    assert.strictEqual(limiterFor(''), limiterFor(''), 'stable across repeated lookups');
    assert.notStrictEqual(limiterFor(''), limiterFor('alice'), 'distinct from a real identity');
  });

  test('prototype-property-shaped, very long, whitespace, and unicode identities are ordinary distinct keys with no collisions', () => {
    const ids = [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'hasOwnProperty',
      ' ',
      '\x00',
      '🤖ünïcödé-identity',
      'a'.repeat(10_000),
    ];
    const gotten = ids.map((id) => limiterFor(id));
    for (let i = 0; i < ids.length; i++) {
      assert.strictEqual(limiterFor(ids[i]), gotten[i], `identity ${JSON.stringify(ids[i]).slice(0, 40)} must be stable across lookups`);
      for (let j = i + 1; j < ids.length; j++) {
        assert.notStrictEqual(gotten[i], gotten[j], `identities at index ${i} and ${j} must not collide onto the same bucket`);
      }
    }
  });

  test('exhausting the "__proto__" identity does not pollute Object.prototype or bleed into other identities', () => {
    const protoLimiter = limiterFor('__proto__');
    for (let i = 0; i < 100; i++) protoLimiter.check();
    assert.equal(protoLimiter.check().allowed, false, '__proto__ identity itself is exhausted');
    assert.equal(limiterFor('alice').check().allowed, true, 'an unrelated identity is unaffected');
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'no prototype pollution occurred');
  });
});

// Beyond the brief's floor: the RateLimiter class hard-codes a real 60_000ms
// window (the constructor's `perMinute` argument only sets the call budget,
// not the window length - there is no public way to shrink it). Sleeping 60
// real seconds in a test is both slow and, at the exact boundary, at the
// mercy of scheduler jitter. node:test's built-in Date mock advances the
// clock deterministically without touching RateLimiter itself, so this
// exercises the real, unmodified sliding-window comparison
// (`now - t < this.windowMs`) at its exact edge.
describe('RateLimiter — genuine sliding-window expiry', () => {
  test('a bucket exhausted at time T is still refused one ms before the window elapses, and allowed the instant it does', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const l = new RateLimiter(1);
    assert.equal(l.check().allowed, true, 'first call consumes the only slot');
    assert.equal(l.check().allowed, false, 'second call refused within the same window');

    t.mock.timers.tick(59_999);
    assert.equal(l.check().allowed, false, '59.999s later: window has not yet elapsed');

    t.mock.timers.tick(2); // now 60.001s after the original call
    assert.equal(l.check().allowed, true, '60.001s later: window elapsed, budget renewed');
  });
});

describe('limiter registry cap', () => {
  test('evicts the least-recently-used identity at the cap, and refresh-on-access protects active callers', () => {
    resetLimiters();
    const first = limiterFor('keeper');
    // Captured at the moment filler-0 is created, so it can be compared against
    // (not just type-checked against) whatever limiterFor('filler-0') returns
    // after the overflow below - see the comment on that assertion for why a
    // same-object check is the load-bearing part of this test.
    const originalFillerZero = limiterFor('filler-0');
    for (let i = 1; i < MAX_TRACKED_IDENTITIES - 1; i++) limiterFor(`filler-${i}`);
    // registry is now exactly at the cap; 'keeper' is the oldest by insertion.
    assert.equal(limiterFor('keeper'), first, 'accessing keeper must refresh its recency, not evict it');
    limiterFor('overflow-1'); // evicts filler-0 (now the oldest), NOT keeper
    assert.equal(limiterFor('keeper'), first, 'keeper must survive the overflow eviction');
    // filler-0 was evicted: asking for it again must yield a FRESH instance (budget
    // reset - the documented memory-bound trade), not the object captured above.
    // An `instanceof RateLimiter` check alone cannot tell "evicted, this is a new
    // one" apart from "never evicted, this is still the same one" - limiterFor's
    // return type already guarantees instanceof, so that check passes whether or
    // not eviction actually ran. Proven by mutation test: deleting the cap-eviction
    // block in limiterFor left the old assertion green (see task-1-report.md for
    // the recorded failure output of THIS assertion against that mutation).
    assert.notEqual(
      limiterFor('filler-0'),
      originalFillerZero,
      'filler-0 must be a FRESH instance - eviction really happened and its budget reset'
    );
    resetLimiters();
  });
});
