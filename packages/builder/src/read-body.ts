// packages/builder/src/read-body.ts
// How the entry point reads the body of a POST to /mcp. The server counts the bytes as they arrive and stops at the limit, whatever the
// headers say: a request with no content-length (a chunked body), or with a content-length that is not true, gets no more room. The body
// is parsed one time, here, and handed to the transport (handleRequest takes a parsed body).
//
// For every body inside the limit the answers do not change. A body that is empty or is not JSON goes to the transport as "no parsed
// body", and the transport answers as it did when it read the body itself (400, "Parse error: Invalid JSON", after its checks of the
// Accept and Content-Type headers).
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The most bytes that the server reads from the body of a request: 128 KiB. The largest input that a tool takes is a transaction of 32,768
 * hex characters (a transaction has at most 16,384 bytes), and the other inputs of a request are short, so every valid request is far below
 * this limit.
 */
export const MAX_BODY_BYTES = 131_072;

export type BodyRead =
  /** The body is inside the limit. `json` is the parsed body, or undefined when the body is empty or is not JSON. */
  | { kind: 'body'; json: unknown }
  | { kind: 'too large' }
  /** The client closed the connection, or the connection failed, before the body was complete. */
  | { kind: 'aborted' };

// The same decoder that the transport uses for a body: it drops a byte order mark and replaces bytes that are not UTF-8.
const decoder = new TextDecoder();

function parse(bytes: Buffer): unknown {
  try { return JSON.parse(decoder.decode(bytes)); } catch { return undefined; }
}

/**
 * Reads the body of `req` and parses it. A `content-length` above the limit ends the read before a byte of the body is read. Else the bytes
 * are counted as they arrive, and the read stops, with no more bytes taken from the connection, at the first byte past the limit.
 */
export function readJsonBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<BodyRead> {
  return new Promise((resolve) => {
    const stop = (): void => { req.pause(); };
    if (Number(req.headers['content-length']) > limit) {
      stop();
      resolve({ kind: 'too large' });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const finish = (result: BodyRead): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > limit) {
        stop();
        finish({ kind: 'too large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ kind: 'body', json: parse(Buffer.concat(chunks, received)) });
    const onAbort = (): void => finish({ kind: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

/** How long the connection stays open after the answer 413, in milliseconds, when the sender does not close it. */
const LINGER_MS = 1000;

/**
 * The answer for a body above the limit: 413, and a short JSON-RPC error. The answer is written in full, but the response is not ended
 * at once. The server has stopped reading, so it holds unread bytes of the sender. To end the connection now would reset it, and a
 * sender that is still writing could lose the answer. The sender reads the answer (its writes wait, as the server does not read), and
 * closes the connection; if it does not, the server ends the connection after LINGER_MS. The server takes no more bytes from it.
 */
export function answerTooLarge(res: ServerResponse, limit: number = MAX_BODY_BYTES): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: `The request body is larger than the limit of ${limit} bytes.` }, id: null });
  res.writeHead(413, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
  res.write(body);
  const timer = setTimeout(() => { res.end(); }, LINGER_MS);
  res.once('close', () => { clearTimeout(timer); });
}

/**
 * The parsed body of a request, for the transport: `{ json }` (json is undefined for no body, or a body that is not JSON), or undefined
 * when this function has answered (413) or the client has gone. Only a POST has a body that the server reads.
 */
export async function takeBody(req: IncomingMessage, res: ServerResponse, limit: number = MAX_BODY_BYTES): Promise<{ json: unknown } | undefined> {
  if (req.method !== 'POST') return { json: undefined };
  const read = await readJsonBody(req, limit);
  if (read.kind === 'too large') {
    answerTooLarge(res, limit);
    return undefined;
  }
  if (read.kind === 'aborted') {
    res.destroy();
    return undefined;
  }
  return { json: read.json };
}
