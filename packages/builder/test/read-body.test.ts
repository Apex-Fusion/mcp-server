// packages/builder/test/read-body.test.ts
// takeBody (src/read-body.ts) on a real HTTP server: the body of a POST is read up to the limit and parsed one time. A body of exactly the
// limit is read, and one byte more gets 413 (a short JSON answer, and the end of the connection). The bytes are counted as they arrive, so
// a body with no content-length (a chunked body), or with a content-length that is not true, gets no more room. The server stops taking
// bytes from the connection at the limit, and answers other requests during and after such a body.
//
// The tests write the requests to a socket (fixtures/raw-http.ts): a client library would hide the headers and the chunks that these
// tests send. The tests wait on the platform clock, because the sockets of a real server run on it.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { MAX_BODY_BYTES, takeBody } from '../src/read-body.ts';
import { bodyOf, chunked, post, send } from './fixtures/raw-http.ts';

interface Seen { json: unknown; answered: boolean; bytesRead: number }
const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); } });

/** A server that gives `takeBody` each POST and answers 200 with what it parsed; `seen` has one entry for each POST. */
async function listen(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 2 }); res.end('ok'); return; }
    const taken = await takeBody(req, res);
    seen.push({ json: taken?.json, answered: taken === undefined, bytesRead: req.socket.bytesRead });
    if (taken === undefined) return;
    const answer = JSON.stringify({ parsed: taken.json === undefined ? 'nothing' : taken.json });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(answer) });
    res.end(answer);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, seen };
}

describe('takeBody', () => {
  test('a body of exactly the limit is read and parsed, and one byte more gets 413', async () => {
    const { port, seen } = await listen();
    const exact = await send(port, post([`Content-Length: ${MAX_BODY_BYTES}`, 'Connection: close']), [bodyOf(MAX_BODY_BYTES)]);
    assert.equal(exact.status, 200);
    assert.deepEqual(JSON.parse(exact.body), { parsed: { a: 1 } });
    // No Connection header: the request would keep the connection, so the answer must say that the connection ends.
    const over = await send(port, post([`Content-Length: ${MAX_BODY_BYTES + 1}`]), [bodyOf(MAX_BODY_BYTES + 1)]);
    assert.equal(over.status, 413);
    assert.match(over.headers, /content-type: application\/json/i);
    assert.match(over.headers, /connection: close/i);
    assert.deepEqual(JSON.parse(over.body), { jsonrpc: '2.0', error: { code: -32000, message: `The request body is larger than the limit of ${MAX_BODY_BYTES} bytes.` }, id: null });
    assert.deepEqual(seen.map((entry) => entry.answered), [false, true]);
  });

  test('a content-length above the limit, by one byte or by far, gets 413 before a byte of the body is sent', async () => {
    for (const length of [MAX_BODY_BYTES + 1, MAX_BODY_BYTES * 1000]) {
      const { port, seen } = await listen();
      const answer = await send(port, post([`Content-Length: ${length}`, 'Connection: close']));
      assert.equal(answer.status, 413, `content-length ${length}`);
      assert.equal(seen[0].answered, true);
    }
  });

  test('after the answer 413 the connection stays open for a short time, so that a sender that still writes can read the answer, and then the server ends it', async () => {
    const { port } = await listen();
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    let answeredAt = 0;
    let closedAt = 0;
    socket.on('data', (data: Buffer) => { received.push(data); if (answeredAt === 0) answeredAt = performance.now(); });
    socket.on('close', () => { closedAt = performance.now(); });
    await once(socket, 'connect');
    socket.write(post([`Content-Length: ${MAX_BODY_BYTES + 1}`, 'Connection: close']));
    for (let waited = 0; answeredAt === 0 && waited < 2000; waited += 10) await sleep(10);
    assert.match(Buffer.concat(received).toString(), /^HTTP\/1\.1 413 /);
    await sleep(300);
    assert.equal(closedAt, 0, 'the connection is open 300 ms after the answer');
    for (let waited = 0; closedAt === 0 && waited < 3000; waited += 20) await sleep(20);
    assert.ok(closedAt > 0 && closedAt - answeredAt < 2500, `the connection ended ${closedAt - answeredAt} ms after the answer`);
    socket.destroy();
  });

  test('only a POST has a body that is read: a GET with a content-length above the limit is not refused', async () => {
    const { port, seen } = await listen();
    const answer = await send(port, 'GET /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n');
    assert.equal(answer.status, 200);
    assert.equal(seen[0].answered, false);
  });

  test('a chunked body with no content-length is cut off at the limit, and the server takes no more than the limit and a few chunks from the connection', async () => {
    const { port, seen } = await listen();
    // 256 MiB in chunks of 16 KiB: far more than the kernel buffers of both sides hold.
    const flood = (async function* () { const chunk = Buffer.alloc(16_384, 0x20); for (let i = 0; i < 16_384; i += 1) yield Buffer.concat([Buffer.from('4000\r\n'), chunk, Buffer.from('\r\n')]); })();
    const answer = await send(port, post(['Transfer-Encoding: chunked', 'Connection: close']), flood);
    assert.equal(answer.status, 413);
    assert.equal(answer.ended, true, 'the server ended the connection');
    assert.ok(answer.sent < 64 * 1024 * 1024, `the sender wrote ${answer.sent} bytes before the connection ended`);
    assert.equal(seen[0].answered, true);
    assert.ok(seen[0].bytesRead < MAX_BODY_BYTES + 512 * 1024, `the server read ${seen[0].bytesRead} bytes of the connection`);
  });

  test('a chunked body of exactly the limit is read, in chunks of any size', async () => {
    const { port } = await listen();
    const body = bodyOf(MAX_BODY_BYTES);
    const parts = [body.subarray(0, 1), body.subarray(1, 5000), body.subarray(5000, 70_000), body.subarray(70_000)];
    const answer = await send(port, post(['Transfer-Encoding: chunked', 'Connection: close']), chunked(parts));
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), { parsed: { a: 1 } });
  });

  test('a chunked body of one byte more than the limit gets 413', async () => {
    const { port, seen } = await listen();
    const body = bodyOf(MAX_BODY_BYTES + 1);
    const answer = await send(port, post(['Transfer-Encoding: chunked', 'Connection: close']), chunked([body.subarray(0, 60_000), body.subarray(60_000)]));
    assert.equal(answer.status, 413);
    assert.equal(seen[0].answered, true);
  });

  test('a content-length that is not true gives no room: the reader takes the bytes that the length names, and the others are not a body', async () => {
    const { port, seen } = await listen();
    // The length says 7 bytes; the sender writes 200,000 more. The HTTP parser takes the first 7 bytes as the body, and the rest is not
    // a request: the connection fails, and no handler sees it as a body.
    await send(port, post(['Content-Length: 7', 'Connection: close']), [Buffer.concat([Buffer.from('{"a":1}'), Buffer.alloc(200_000, 0x20)])]);
    assert.deepEqual(seen.map((entry) => entry.json), [{ a: 1 }]);
  });

  test('a body that is empty or is not JSON is handed on as no body: the transport gives its answer', async () => {
    const { port, seen } = await listen();
    for (const body of ['', 'not json', '{"a":', '\u0000', '{"a":1}{"b":2}']) {
      const answer = await send(port, post([`Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close']), [Buffer.from(body)]);
      assert.equal(answer.status, 200, body);
      assert.deepEqual(JSON.parse(answer.body), { parsed: 'nothing' }, body);
    }
    assert.equal(seen.length, 5);
  });

  test('a body is parsed as the transport parses it: a byte order mark is dropped, bytes that are not UTF-8 are replaced', async () => {
    const { port } = await listen();
    const bom = await send(port, post(['Content-Length: 10', 'Connection: close']), [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')])]);
    assert.deepEqual(JSON.parse(bom.body), { parsed: { a: 1 } });
    const broken = await send(port, post(['Content-Length: 9', 'Connection: close']), [Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')])]);
    assert.deepEqual(JSON.parse(broken.body), { parsed: { a: '\ufffd' } });
  });

  test('a client that closes the connection before the body is complete is not answered, and the server goes on', async () => {
    const { port, seen } = await listen();
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(post(['Content-Length: 1000']));
    socket.write('{"a":');
    await sleep(50);
    socket.destroy();
    for (let waited = 0; seen.length === 0 && waited < 1000; waited += 20) await sleep(20);
    assert.deepEqual(seen.map((entry) => entry.answered), [true]);
    assert.equal((await send(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')).status, 200);
  });

  test('other requests are answered while a body is being sent, and after it is cut off', async () => {
    const { port, seen } = await listen();
    const health = () => send(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    // A sender that is slow: 8 KiB each 25 ms, so that the limit is crossed after about 400 ms.
    const drip = (async function* () { for (let i = 0; i < 400; i += 1) { await sleep(25); yield Buffer.from(`2000\r\n${' '.repeat(8192)}\r\n`); } })();
    const upload = send(port, post(['Transfer-Encoding: chunked', 'Connection: close']), drip);
    await sleep(100);
    assert.equal((await health()).status, 200, 'during the body');
    assert.equal(seen.length, 0, 'the body is still being read');
    assert.equal((await upload).status, 413);
    assert.equal((await health()).status, 200, 'after the body');
  });
});
