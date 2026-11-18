// packages/builder/test/stop-server.test.ts
// stopServer (src/stop-server.ts) on a real HTTP server: the server stops listening at once, an answer that is being written is written
// in full, and `exit` runs once with code 1: when the connections are closed, and after the grace time at the latest.
//
// The tests wait on the platform clock: the sockets of a real server and the timers of stopServer run on it, so fake timers cannot drive them.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { stopServer } from '../src/stop-server.ts';

const GRACE_MS = 2000;
const servers: Server[] = [];
const aborts: AbortController[] = [];

/** A server on a free port. `handler` may name the server: it is called after the server is listening. */
async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // The server listens on a port, not on a pipe: its address is an AddressInfo.
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

/** Waits until `condition` holds, for at most `ms` milliseconds. */
async function until(condition: () => boolean, ms: number): Promise<void> {
  for (const deadline = Date.now() + ms; !condition() && Date.now() < deadline;) await sleep(20);
}

afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe('stopServer', () => {
  test('an answer that is being written is written in full, and the exit runs once with code 1 after it, long before the grace time', async () => {
    const events: string[] = [];
    const exits: Array<{ code: number; at: number }> = [];
    const started = Date.now();
    const { server, url } = await listen((_request, response) => {
      // The stop is asked for while the answer is not written: the answer takes 300 ms.
      setTimeout(() => stopServer(server, GRACE_MS, (code) => { events.push('exit'); exits.push({ code, at: Date.now() }); }), 30);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('part one,');
      setTimeout(() => { events.push('answer written'); response.end(' part two'); }, 300);
    });
    assert.equal(await (await fetch(`${url}/slow`)).text(), 'part one, part two');
    await until(() => exits.length > 0, GRACE_MS + 1000);
    assert.deepEqual(events, ['answer written', 'exit']);
    assert.deepEqual(exits.map((exit) => exit.code), [1]);
    assert.ok(exits[0].at - started < GRACE_MS / 2, `the exit ran ${exits[0].at - started} ms after the call: the grace time was not needed`);
  });

  test('the server stops listening at once', async () => {
    const { server, url } = await listen((_request, response) => { response.end('ok'); });
    assert.equal(await (await fetch(url)).text(), 'ok');
    stopServer(server, GRACE_MS, () => undefined);
    await assert.rejects(fetch(url), /fetch failed/);
  });

  test('a connection that stays open holds the exit until the grace time, and no longer; the exit runs once', async () => {
    const exits: Array<{ code: number; at: number }> = [];
    const { server, url } = await listen((request, response) => {
      if (request.url === '/stream') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': open\n\n');
        return;
      }
      stopServer(server, GRACE_MS, (code) => { exits.push({ code, at: Date.now() }); });
      response.end('stopping');
    });
    const stream = new AbortController();
    aborts.push(stream);
    assert.equal((await fetch(`${url}/stream`, { signal: stream.signal })).status, 200);
    const asked = Date.now();
    assert.equal(await (await fetch(`${url}/stop`)).text(), 'stopping');
    await sleep(GRACE_MS / 2);
    assert.equal(exits.length, 0, 'the open stream holds the exit');
    await until(() => exits.length > 0, GRACE_MS + 1500);
    assert.deepEqual(exits.map((exit) => exit.code), [1]);
    assert.ok(exits[0].at - asked >= GRACE_MS - 200 && exits[0].at - asked < GRACE_MS + 1500, `the exit ran ${exits[0].at - asked} ms after the stop`);
    stream.abort();
    await sleep(300);
    assert.equal(exits.length, 1, 'the end of the stream does not run the exit again');
  });

  test('with no connection open, the exit runs at once, and the grace time does not run it again', async () => {
    const exits: number[] = [];
    const { server } = await listen((_request, response) => { response.end('ok'); });
    stopServer(server, 300, (code) => { exits.push(code); });
    await sleep(100);
    assert.deepEqual(exits, [1]);
    await sleep(500);
    assert.deepEqual(exits, [1]);
  });
});
