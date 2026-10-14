// packages/builder/test/fixtures/held-open.ts
// A call that only its time budget can end waits on AbortSignal.timeout, whose timer Node unrefs. A fake that hangs (a supplier, a
// resolver or a body that never answers) holds nothing else, so the event loop is idle, and Node 22's test runner (the CI and Docker
// runtime) cancels the rest of the file: "Promise resolution is still pending but the event loop has already resolved". In production
// the server's listening socket, and a real connection's socket, keep the loop alive. node:test's mock timers cannot drive
// AbortSignal.timeout, so these budgets run on the real clock.

/** Awaits `work` with the event loop held open, as the pending query or the open socket of a real lookup or connection holds it. */
export async function heldOpen<T>(work: Promise<T>): Promise<T> {
  const socket = setInterval(() => {}, 1_000);
  try {
    return await work;
  } finally {
    clearInterval(socket);
  }
}
