import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pollUntilConfirmed, buildConfirmationCheck } from '../src/vector/poll.ts';

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

describe('buildConfirmationCheck', () => {
  // vector_await_transaction wires this up as:
  //   buildConfirmationCheck(Boolean(VECTOR_KOIOS_URL), koiosCheck, outRefCheck)
  // Both checkKoios/checkOutRef stand in for provider calls (Koios tx_status,
  // Ogmios getUtxosByOutRef) without ever touching the network - this pins
  // the selection and propagation behavior, not the HTTP calls themselves.

  test('selects checkKoios when Koios is configured, and never calls checkOutRef', async () => {
    let outRefCalls = 0;
    const check = buildConfirmationCheck(
      true,
      async () => true,
      async () => { outRefCalls++; return true; },
    );
    assert.equal(await check(), true);
    assert.equal(outRefCalls, 0, 'the outRef check must not run when Koios is preferred');
  });

  test('selects checkOutRef when Koios is not configured, and never calls checkKoios', async () => {
    let koiosCalls = 0;
    const check = buildConfirmationCheck(
      false,
      async () => { koiosCalls++; return true; },
      async () => false,
    );
    assert.equal(await check(), false);
    assert.equal(koiosCalls, 0, 'the Koios check must not run as a fallback is not a retry path');
  });

  test('propagates the selected check\'s resolved value unchanged, true or false, in either branch', async () => {
    assert.equal(await buildConfirmationCheck(true, async () => true, async () => { throw new Error('unused'); })(), true);
    assert.equal(await buildConfirmationCheck(true, async () => false, async () => { throw new Error('unused'); })(), false);
    assert.equal(await buildConfirmationCheck(false, async () => { throw new Error('unused'); }, async () => true)(), true);
    assert.equal(await buildConfirmationCheck(false, async () => { throw new Error('unused'); }, async () => false)(), false);
  });

  test('propagates a rejection from checkKoios rather than treating it as "not yet confirmed"', async () => {
    const check = buildConfirmationCheck(
      true,
      async () => { throw new Error('Koios tx_status query failed (503): upstream down'); },
      async () => false,
    );
    await assert.rejects(check, /Koios tx_status query failed/);
  });

  test('propagates a rejection from checkOutRef rather than treating it as "not yet confirmed"', async () => {
    const check = buildConfirmationCheck(
      false,
      async () => false,
      async () => { throw new Error('Ogmios RPC error (500): boom'); },
    );
    await assert.rejects(check, /Ogmios RPC error/);
  });

  describe('composed with pollUntilConfirmed (matching the real vector_await_transaction call site)', () => {
    function fakeClock(start = 0) {
      let t = start;
      const sleeps: number[] = [];
      return {
        now: () => t,
        sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
        sleeps,
      };
    }

    test('a Koios failure on the first attempt rejects immediately, without ever sleeping or falling back to outRef', async () => {
      const clock = fakeClock();
      let outRefCalls = 0;
      const check = buildConfirmationCheck(
        true,
        async () => { throw new Error('Koios unreachable'); },
        async () => { outRefCalls++; return true; },
      );
      await assert.rejects(
        () => pollUntilConfirmed(check, 9000, 3000, clock.now, clock.sleep),
        /Koios unreachable/,
      );
      assert.deepEqual(clock.sleeps, [], 'a check that cannot determine status must not be retried like a pending tx');
      assert.equal(outRefCalls, 0);
    });

    test('outRef polling that never confirms resolves false (not an error) once the budget elapses, with Koios not configured', async () => {
      const clock = fakeClock();
      let koiosCalls = 0;
      const check = buildConfirmationCheck(
        false,
        async () => { koiosCalls++; return true; },
        async () => false,
      );
      const result = await pollUntilConfirmed(check, 9000, 3000, clock.now, clock.sleep);
      assert.equal(result, false);
      assert.equal(koiosCalls, 0);
    });

    test('Koios reporting confirmed on a later attempt resolves true without exhausting the budget', async () => {
      const clock = fakeClock();
      let attempts = 0;
      const check = buildConfirmationCheck(
        true,
        async () => { attempts++; return attempts >= 2; },
        async () => { throw new Error('outRef must not run when Koios is configured'); },
      );
      const result = await pollUntilConfirmed(check, 9000, 3000, clock.now, clock.sleep);
      assert.equal(result, true);
      assert.equal(attempts, 2);
      assert.deepEqual(clock.sleeps, [3000]);
    });
  });
});
