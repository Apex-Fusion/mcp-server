// packages/builder/test/fixtures/raw-http.ts
//
// An HTTP client that writes the request to a socket as it is given: the request line and headers, then each chunk of the body. The tests
// of the size limit use it because a client library hides the headers and the chunks that they send (a body with no content-length, a
// content-length that is not true, a sender that goes on after the server answers).
import { once } from 'node:events';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Answer {
  /** The status of the first answer, or 0 when none came. */
  status: number;
  headers: string;
  /** The body of the first answer, as text (a chunked body is decoded). */
  body: string;
  /** True when the connection was closed (by the server, or by an error) before `waitMs` was over. */
  ended: boolean;
  /** The bytes of the body that the client wrote before the connection ended. */
  sent: number;
}

/** The bytes of a chunked body: the data of each chunk, up to the last chunk, or up to the end of what came. */
function dechunk(bytes: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < bytes.length) {
    const lineEnd = bytes.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = parseInt(bytes.subarray(at, lineEnd).toString('latin1').split(';')[0], 16);
    if (!Number.isInteger(size) || size === 0) break;
    parts.push(bytes.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/**
 * Sends `head` (the request line and the headers, written as they are), then each chunk of `chunks` as it is (the caller frames a chunked
 * body), and reads the answer. Stops writing when the server closes the connection. Resolves when the connection is closed, or `waitMs`
 * after the last write.
 */
export async function send(port: number, head: string, chunks: AsyncIterable<Buffer> | Buffer[] = [], waitMs = 1500): Promise<Answer> {
  const socket = connect(port, '127.0.0.1');
  const received: Buffer[] = [];
  let ended = false;
  let sent = 0;
  socket.on('data', (data: Buffer) => { received.push(data); });
  socket.on('error', () => { ended = true; });
  socket.on('close', () => { ended = true; });
  await once(socket, 'connect');
  socket.write(head);
  try {
    for await (const chunk of chunks) {
      if (ended || socket.destroyed) break;
      if (!socket.write(chunk)) await Promise.race([once(socket, 'drain'), once(socket, 'close')]);
      sent += chunk.length;
    }
  } catch { /* the server closed the connection while the client wrote */ }
  for (let waited = 0; !ended && waited < waitMs; waited += 20) await sleep(20);
  socket.destroy();
  const bytes = Buffer.concat(received);
  const split = bytes.indexOf('\r\n\r\n');
  const headers = (split < 0 ? bytes : bytes.subarray(0, split)).toString('latin1');
  const rest = split < 0 ? Buffer.alloc(0) : bytes.subarray(split + 4);
  const body = /^transfer-encoding:\s*chunked/im.test(headers) ? dechunk(rest) : rest;
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1] ?? 0), headers, body: body.toString('utf8'), ended, sent };
}

/** The head of a POST to /mcp with the headers `extra`; the content type is JSON unless `extra` gives one. */
export const post = (extra: string[], path = '/mcp'): string => [
  `POST ${path} HTTP/1.1`, 'Host: localhost', ...(extra.some((header) => /^content-type:/i.test(header)) ? [] : ['Content-Type: application/json']), ...extra, '', '',
].join('\r\n');

/** A JSON body of exactly `length` bytes: an object, then spaces. */
export const bodyOf = (length: number): Buffer => Buffer.from('{"a":1}'.padEnd(length, ' '));

/** The chunks of a chunked body: each part with its size, then the last chunk. */
export const chunked = (parts: Buffer[]): Buffer[] => [
  ...parts.map((part) => Buffer.concat([Buffer.from(`${part.length.toString(16)}\r\n`), part, Buffer.from('\r\n')])),
  Buffer.from('0\r\n\r\n'),
];
