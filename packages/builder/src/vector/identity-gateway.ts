// packages/builder/src/vector/identity-gateway.ts
// Read-only client for the did:vector identity gateway: the HTTPS binding of the did:vector method (Part 1 Section 7.4),
// GET /1.0/identifiers/{did} with Accept: application/did-resolution, served at id.vector.apexfusion.org (Part 2 Section 8.1).
// The gateway URL is operator configuration (VECTOR_IDENTITY_GATEWAY_URL), so no error names it, and an error never
// quotes the answer.

export const DEFAULT_IDENTITY_GATEWAY_URL = 'https://id.vector.apexfusion.org';

/**
 * The gateway base URL without trailing slashes: every request appends `/1.0/identifiers/<did>`. Read at call time, not at
 * module load, so a value from the server's .env file applies too.
 */
export function identityGatewayUrl(configured: string | undefined = process.env.VECTOR_IDENTITY_GATEWAY_URL): string {
  return (configured || DEFAULT_IDENTITY_GATEWAY_URL).replace(/\/+$/, '');
}

/** The canonical DID form `did:vector:<vector-id>` (Part 1 Section 3). */
export const CANONICAL_DID = /^did:vector:[0-9a-f]{64}$/;
/** The legacy DID form `did:vector:agent:…`; parseDid in registry-build.ts reads its parts. */
export const LEGACY_DID_PREFIX = 'did:vector:agent:';

const RESOLUTION_MEDIA_TYPE = 'application/did-resolution';
const ERROR_TYPE_PREFIX = 'https://www.w3.org/ns/did#';
/** A record has at most 8 keys, 8 parties, 10 holds and 16 capabilities: its resolution result is some tens of kB at most. */
const MAX_ANSWER_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** The DID Resolution options of Part 1 Section 7.1 that a caller may set. The gateway validates them. */
export interface ResolutionOptions {
  versionId?: string;
  versionTime?: string;
}

export interface GatewayAnswer {
  /** The HTTP status of the answer (Part 1 Section 7.4: 200, 410, 400, 404, 406, 501 or 500). */
  status: number;
  /** The resolution result exactly as the gateway sent it. */
  body: string;
  /** The same result, parsed. */
  result: ResolutionResult;
}

/** The parts of a DID Resolution result that the tools read. Every other member stays in `body`. */
export interface ResolutionResult {
  didDocument: Record<string, unknown> | null;
  didResolutionMetadata: { contentType?: string; error?: { type?: string; title?: string } };
  didDocumentMetadata: Record<string, unknown>;
}

interface Io {
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Asks the gateway to resolve `did` and returns its answer with the HTTP status. An answer with an error status is still an
 * answer: the gateway sends a resolution result for every error (INVALID_DID, NOT_FOUND, ...). Throws only when there is no
 * resolution result: the gateway cannot be reached, the answer is too large or stops part way, or it is not a resolution result.
 */
export async function resolveDid(did: string, options: ResolutionOptions = {}, io: Io = {}): Promise<GatewayAnswer> {
  const query = new URLSearchParams();
  if (options.versionId !== undefined) query.set('versionId', options.versionId);
  if (options.versionTime !== undefined) query.set('versionTime', options.versionTime);
  // The gateway percent-decodes the path once. A colon may stand in a path segment as it is, so only the other characters
  // are encoded: whatever the caller passes stays one path segment and cannot add a query.
  const path = encodeURIComponent(did).replace(/%3A/gi, ':');
  const search = query.toString();
  const url = `${io.gatewayUrl ?? identityGatewayUrl()}/1.0/identifiers/${path}${search ? `?${search}` : ''}`;

  let res: Response;
  try {
    res = await (io.fetchImpl ?? fetch)(url, {
      headers: { accept: RESOLUTION_MEDIA_TYPE, 'user-agent': 'vector-mcp-builder' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error('the identity gateway could not be reached (network error or timeout)');
  }

  const body = await readBody(res);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`the identity gateway answered HTTP ${res.status} without a resolution result (the answer is not JSON)`);
  }
  if (!isResolutionResult(parsed)) {
    throw new Error(`the identity gateway answered HTTP ${res.status} with JSON that is not a DID resolution result`);
  }
  return { status: res.status, body, result: parsed };
}

/** A parsed JSON object (not null, not an array). */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isResolutionResult(value: unknown): value is ResolutionResult {
  return (
    isJsonObject(value) &&
    isJsonObject(value.didResolutionMetadata) &&
    (value.didDocument === null || isJsonObject(value.didDocument)) &&
    isJsonObject(value.didDocumentMetadata)
  );
}

/** The body as text, read to MAX_ANSWER_BYTES at most. */
async function readBody(res: Response): Promise<string> {
  const tooLarge = `the identity gateway answer is over ${MAX_ANSWER_BYTES} bytes`;
  if (Number(res.headers.get('content-length')) > MAX_ANSWER_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(tooLarge);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ANSWER_BYTES) {
        over = true;
        break;
      }
      chunks.push(value);
    }
  } catch {
    throw new Error('the identity gateway answer could not be read in full (network error or timeout)');
  }
  if (over) {
    await reader.cancel().catch(() => {});
    throw new Error(tooLarge);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The error of a resolution result as `NAME: title`, or null when it has none. */
export function resolutionError(result: ResolutionResult): string | null {
  const error = result.didResolutionMetadata.error;
  if (!error) return null;
  const type = typeof error.type === 'string' ? error.type.replace(ERROR_TYPE_PREFIX, '') : 'unknown error';
  return typeof error.title === 'string' && error.title ? `${type}: ${error.title}` : type;
}
