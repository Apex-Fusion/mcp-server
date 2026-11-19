// packages/builder/test/fixtures/at-once.ts
// A time limit for a call that reads bytes. The readers of a transaction (tx-fee.ts, tx-body.ts) take microseconds, and a reader that does
// not return must fail its test and not hang the run.
import { Script, createContext } from 'node:vm';

/** The time that a call may take, in milliseconds. */
export const LIMIT_MS = 2000;
const callScript = new Script('call()');
const callContext = createContext({ call: (): unknown => undefined });

/** Runs `call` with a time limit. A call that does not return in `limitMs` ends with an error: vm stops a loop that never ends. */
export function atOnce<T>(call: () => T, limitMs = LIMIT_MS): T {
  callContext.call = call;
  return callScript.runInContext(callContext, { timeout: limitMs }) as T;
}
