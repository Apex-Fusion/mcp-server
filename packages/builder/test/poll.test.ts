import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pollUntilConfirmed } from '../src/vector/poll.ts';

/**
 * A fake clock: `sleep` advances `t` by exactly the requested amount instead
 * of waiting in real time, so a multi-iteration poll runs in microseconds
 * and produces a deterministic elapsed-time trace. `now`/`sleep` are the
 * same seam vector_await_transaction leaves at their defaults (Date.now and
 * a real setTimeout), so this drives the exact loop the tool runs — just
 * without waiting on the wall clock.
 *
 * (node:test's built-in `mock.timers` was tried first, per the convention in
 * rate-limiter.test.ts. It works cleanly for synchronous Date reads, but
 * this loop chains a fresh `setTimeout` after each awaited `check()`, and
 * that next timer isn't registered until a microtask turn after `tick()`
 * already returned - a single tick() only fires the one timer that existed
 * when it ran, so multi-iteration polls silently stalled after the first
 * attempt. Confirmed experimentally before choosing dependency injection
 * instead: it is deterministic without needing to interleave manual
 * microtask flushes with tick() calls.)
 */
function fakeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    elapsed: () => t - start,
  };
}

describe('pollUntilConfirmed', () => {
  test('returns true immediately, without sleeping, when check succeeds on the first attempt', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await pollUntilConfirmed(
      async () => {
        calls++;
        return true;
      },
      9000,
      3000,
      clock.now,
      clock.sleep,
    );
    assert.equal(result, true);
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('returns true on a later attempt once check starts succeeding', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await pollUntilConfirmed(
      async () => {
        calls++;
        return calls >= 3;
      },
      9000,
      3000,
      clock.now,
      clock.sleep,
    );
    assert.equal(result, true);
    assert.equal(calls, 3);
    assert.deepEqual(clock.sleeps, [3000, 3000]);
  });

  test('returns false, not an error, when the budget elapses without confirmation', async () => {
    const clock = fakeClock();
    const result = await pollUntilConfirmed(async () => false, 9000, 3000, clock.now, clock.sleep);
    assert.strictEqual(result, false);
  });

  test('a transaction that never confirms resolves false, never throws and never resolves true', async () => {
    // vector_await_transaction treats `false` as "not yet, might still land"
    // and reports that in its own wording - never "failed". That framing
    // depends on this function having exactly two outcomes (true/false), no
    // third "error" signal smuggled through a throw for the ordinary
    // still-pending case.
    const clock = fakeClock();
    await assert.doesNotReject(() =>
      pollUntilConfirmed(async () => false, 6000, 3000, clock.now, clock.sleep),
    );
  });

  test('total simulated elapsed time equals the budget exactly when it divides evenly by the interval', async () => {
    const clock = fakeClock();
    await pollUntilConfirmed(async () => false, 9000, 3000, clock.now, clock.sleep);
    assert.equal(clock.elapsed(), 9000);
  });

  test('does not overshoot a budget smaller than one interval - the historical bug', async () => {
    // The original inline loop slept a fixed 3000ms every iteration
    // regardless of how much budget was left, so a timeoutSeconds=1 request
    // would actually block for ~3s - a 3x overshoot. This pins the fix: the
    // sleep is clamped to the time remaining before the deadline.
    const clock = fakeClock();
    const result = await pollUntilConfirmed(async () => false, 1000, 3000, clock.now, clock.sleep);
    assert.equal(result, false);
    assert.deepEqual(clock.sleeps, [1000], 'sleep was clamped to the 1000ms remaining, not the full 3000ms interval');
    assert.equal(clock.elapsed(), 1000, 'elapsed time matches the requested budget, not the interval');
  });

  test('does not overshoot when the budget is not an exact multiple of the interval', async () => {
    const clock = fakeClock();
    const result = await pollUntilConfirmed(async () => false, 7000, 3000, clock.now, clock.sleep);
    assert.equal(result, false);
    assert.deepEqual(clock.sleeps, [3000, 3000, 1000]);
    assert.equal(clock.elapsed(), 7000);
  });

  test('a zero budget returns false without ever calling check or sleeping', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await pollUntilConfirmed(
      async () => {
        calls++;
        return false;
      },
      0,
      3000,
      clock.now,
      clock.sleep,
    );
    assert.equal(result, false);
    assert.equal(calls, 0);
    assert.deepEqual(clock.sleeps, []);
  });

  test('always yields between attempts instead of busy-spinning: call count is bounded by budget/interval', async () => {
    const clock = fakeClock();
    let calls = 0;
    await pollUntilConfirmed(
      async () => {
        calls++;
        return false;
      },
      30_000,
      3000,
      clock.now,
      clock.sleep,
    );
    // 30000 / 3000 = 10 attempts before the deadline is reached - bounded
    // and small, not the thousands of calls a non-yielding spin would rack
    // up. Every attempt above also awaits `check()` itself (an async
    // function), so even a near-zero interval could not busy-loop the event
    // loop synchronously.
    assert.equal(calls, 10);
  });

  test('propagates a rejection from check rather than treating it as "not yet confirmed"', async () => {
    const clock = fakeClock();
    await assert.rejects(
      () =>
        pollUntilConfirmed(
          async () => {
            throw new Error('boom');
          },
          9000,
          3000,
          clock.now,
          clock.sleep,
        ),
      /boom/,
    );
  });

  test('uses real Date.now and a real timer by default when no clock is injected', async () => {
    // Smoke test for the production path: the default parameters (used by
    // vector_await_transaction's real call site) must work without a test
    // ever having to supply now/sleep explicitly.
    const start = Date.now();
    const result = await pollUntilConfirmed(async () => true, 5000, 3000);
    assert.equal(result, true);
    assert.ok(Date.now() - start < 1000, 'first attempt succeeds without waiting a full interval');
  });
});
