// packages/builder/src/stop-server.ts
// How the entry point ends the process when its decoder library cannot decode a known value (decoder-health.ts): the server stops
// listening, lets the answers that are being written finish, and `exit` runs once with code 1.
//
// `close` ends the connections that are idle when it is called. The sweep ends each of the other connections when its answer is written
// (a connection that becomes idle stays open until a client closes it or its keep-alive time ends). A connection that stays open (a
// stream) does not hold the process longer than `graceMs`. When the grace time is over, the process ends: a call of another client that
// needs longer than that gets no answer.
import type { Server } from 'node:http';

/** The sweep: how often the connections that have become idle are ended, in milliseconds. */
const SWEEP_MS = 100;

export function stopServer(server: Server, graceMs: number, exit: (code: number) => void): void {
  let sweep: NodeJS.Timeout | undefined;
  let grace: NodeJS.Timeout | undefined;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(sweep);
    clearTimeout(grace);
    exit(1);
  };
  server.close(end);
  sweep = setInterval(() => server.closeIdleConnections(), SWEEP_MS);
  grace = setTimeout(end, graceMs);
}
