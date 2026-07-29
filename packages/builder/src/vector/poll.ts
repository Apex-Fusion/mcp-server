// Generic bounded polling loop used by vector_await_transaction, plus the
// logic that picks what each poll attempt actually checks.
//
// OgmiosProvider already has an `awaitTx`, but it is not reused here: it
// hard-codes a 60-attempt budget (~3 minutes at a fixed 3s interval) with no
// caller control, and it collapses "gave up waiting" and every internal
// error into the same bare boolean. The tool needs a caller-configurable
// timeout and to tell "not yet confirmed" apart from "failed to check".

/**
 * Poll `check` on a fixed interval until it resolves true or the time
 * budget elapses.
 *
 * Each sleep is clamped to the time remaining before the deadline, so a
 * budget shorter than one interval (e.g. a 1s timeout against a 3s poll
 * interval) cannot overshoot by a full extra interval. An earlier version of
 * this loop slept the fixed interval unconditionally on every iteration and
 * could run up to ~3x past a short requested budget.
 *
 * `now` and `sleep` default to the real clock and a real timer, but are
 * injectable so tests can run a full multi-iteration poll deterministically
 * and instantly with a fake clock, instead of waiting on the wall clock or
 * driving node:test's mock timers through a chain of awaited setTimeouts
 * (which does not fire cleanly across await/microtask boundaries - see
 * poll.test.ts for what was tried).
 *
 * Never throws for "still not confirmed" - only resolves false. A rejection
 * from `check` itself propagates, since that means the caller could not even
 * determine the status, which is a different situation from "checked and it
 * is not there yet".
 */
export async function pollUntilConfirmed(
  check: () => Promise<boolean>,
  budgetMs: number,
  intervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const deadline = now() + budgetMs;
  while (now() < deadline) {
    if (await check()) return true;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return false;
}

/**
 * Choose which confirmation check `pollUntilConfirmed` should run: Koios's
 * `tx_status` when configured (a direct signal), the outRef heuristic when
 * it is not - the same preference order as `OgmiosProvider.awaitTx`, without
 * reusing it (see the file header above).
 *
 * Takes both checks as already-built functions, rather than a provider and
 * txHash, so the selection itself can be pinned with fakes the same way
 * `pollUntilConfirmed`'s own `now`/`sleep` are injected above - no network
 * call happens here. Whichever function is selected is returned as-is, not
 * wrapped in a try/catch, so a rejection from it propagates unchanged
 * through `pollUntilConfirmed` to the tool's outer `try/catch` - it is not
 * reinterpreted as "not yet confirmed". `checkKoios` and `checkOutRef`
 * carrying that same no-swallow contract is the caller's responsibility
 * (see the vector_await_transaction call site).
 */
export function buildConfirmationCheck(
  koiosConfigured: boolean,
  checkKoios: () => Promise<boolean>,
  checkOutRef: () => Promise<boolean>,
): () => Promise<boolean> {
  return koiosConfigured ? checkKoios : checkOutRef;
}
