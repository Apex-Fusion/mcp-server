import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { createServer } from 'http';
import { randomUUID } from 'node:crypto';

// Get directory name for ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check for .env file
const envPath = resolve(__dirname, '../../../.env');
console.error('Looking for .env file at:', envPath);
console.error('.env file exists:', existsSync(envPath));

// Load environment variables (non-fatal if missing - env vars can be passed directly)
if (existsSync(envPath)) {
  const result = config({ path: envPath });
  if (result.error) {
    console.error('Warning: Error loading .env file:', result.error);
  }
} else {
  console.error('No .env file found - using environment variables directly');
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerVectorTools } from "./vector/index.js";
import { loadAuthConfig, resolveIdentity, clientIpOf } from "./auth.js";
import { intEnv } from "./env.js";
import { RATE_LIMIT_PER_MINUTE } from "./vector/rate-limiter.js";
// Single source of truth for the advertised server version. tsup/esbuild
// resolves this named JSON import at build time and inlines only the field,
// so the built artifact has no runtime dependency on package.json's location.
import { version as PKG_VERSION } from "../package.json";

function createMcpServer(identity: string) {
  const server = new McpServer({
    name: "vector-mcp-server",
    version: PKG_VERSION,
  });
  registerVectorTools(server, identity);
  return server;
}

console.error('Vector MCP Server starting...');

const authConfig = loadAuthConfig();
if (authConfig.enabled) {
  console.error(`Auth: enabled (${authConfig.identities.size} identit${authConfig.identities.size === 1 ? 'y' : 'ies'} configured)`);
} else {
  console.error('Auth: DISABLED - anonymous callers are admitted with per-client-IP rate limits.');
  console.error('Auth: set MCP_AUTH_TOKENS to require a bearer token. Do not run a public instance without it.');
}

const PORT = parseInt(process.env.PORT || '3000');
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
const streamableIdentities = new Map<string, string>();
// Last activity per /mcp session, bumped on every request that resolves to a
// session (initialize, and every subsequent handleRequest). /mcp has no
// disconnect signal: a caller can POST initialize, take the session id, and
// drop the connection without ever sending DELETE. Nothing in the SDK
// notices - the transport, its McpServer, and its registered tools sit in
// memory until process exit. This map plus the reaper below is what bounds
// that.
const streamableLastSeen = new Map<string, number>();

// Upper bound on concurrent /mcp sessions per identity. A caller that forgets
// to DELETE self-bounds instead of leaking sessions forever, and a flood of
// anon:<ip> sessions from one source cannot grow past this many concurrent
// ones. A GLOBAL cap is the reverse-proxy/network tier's job (clientIpOf's
// trust-model docstring in auth.ts is explicit about that split - this
// server trusts exactly one upstream proxy hop); this is the app-layer
// bound, same philosophy as the per-identity rate limiter in
// vector/rate-limiter.ts. Exported for visibility/tests; production tuning
// is via the env var, since index.ts is an executable entrypoint (importing
// it boots a real server as a side effect) rather than something a test can
// import and reconfigure in-process. Parsed with intEnv (env.ts), not a bare
// parseInt: a malformed value must fail loud at startup, not silently
// disable the cap - parseInt('thirty-two') is NaN, and every
// `length >= MAX_SESSIONS_PER_IDENTITY` comparison in the eviction check
// below is false whenever the right side is NaN, so the cap would silently
// stop evicting anything, forever.
export const MAX_SESSIONS_PER_IDENTITY = intEnv('VECTOR_MCP_MAX_SESSIONS_PER_IDENTITY', 32, 1);

// Idle bound: a session with no request for this long is reaped on the next
// sweep, regardless of whether DELETE ever arrives. Default 10 minutes -
// generous for a real client mid-conversation, short enough that an
// abandoned session does not outlive the process. intEnv, not parseInt, for
// the same fail-loud reason as above - and the failure mode here is worse in
// both directions: a fully non-numeric value is NaN, and `now - lastSeen >
// NaN` is always false, so the reaper would run on schedule forever while
// reaping nothing; a value with a numeric prefix and trailing garbage
// (e.g. a typo like '10m' meaning "10 minutes") would have parseInt-truncated
// to 10, reaping every session within 10ms of creation instead.
const STREAMABLE_SESSION_IDLE_MS = intEnv('VECTOR_MCP_SESSION_IDLE_MS', 10 * 60 * 1000, 100);
// Sweep cadence, kept separate from the idle bound so a hermetic test can
// shrink both independently without waiting anywhere near the real idle
// window. Same truncation risk as the idle bound: a typo like '60s' would
// have parseInt-truncated to 60, running the sweep every 60ms instead of
// every 60 seconds.
const STREAMABLE_SESSION_SWEEP_MS = intEnv('VECTOR_MCP_SESSION_SWEEP_MS', 60_000, 100);

// Operators verify what's actually active from this one line - every DoS
// bound this file and rate-limiter.ts enforce, with the effective value each
// resolved to (default or override), not just the fact that they exist.
console.error(
  `Config: rate limit ${RATE_LIMIT_PER_MINUTE}/min per identity, /mcp session idle ${STREAMABLE_SESSION_IDLE_MS}ms, ` +
  `sweep every ${STREAMABLE_SESSION_SWEEP_MS}ms, cap ${MAX_SESSIONS_PER_IDENTITY} sessions/identity.`
);

/**
 * Closes a /mcp session and drains it from every map, from any trigger other
 * than the SDK's own DELETE handling (the idle reaper, and the per-identity
 * cap's eviction of the oldest session). transport.close() drives our own
 * transport.onclose callback below (which already deletes the same three
 * keys) - the explicit deletes here are belt-and-suspenders so a caller of
 * this function can rely on the maps being drained even if that callback
 * were ever missing or delayed.
 */
async function closeStreamableSession(sessionId: string): Promise<void> {
  const transport = streamableTransports.get(sessionId);
  if (transport) {
    try {
      await transport.close();
    } catch (err) {
      console.error(`Error closing Streamable HTTP session ${sessionId}:`, (err as Error).message);
    }
  }
  streamableTransports.delete(sessionId);
  streamableIdentities.delete(sessionId);
  streamableLastSeen.delete(sessionId);
}

// The idle reaper. unref()'d so it never holds the process open on its own
// (matches every other background timer in this process - there are none
// today, but the convention is set here for the next one), and cleared on
// the http server's own 'close' event so a test that spawns and kills many
// server processes never leaks a live interval into a process that outlives
// the test itself.
const streamableReapInterval = setInterval(() => {
  const now = Date.now();
  const idleSessionIds: string[] = [];
  for (const [sessionId, lastSeen] of streamableLastSeen) {
    if (now - lastSeen > STREAMABLE_SESSION_IDLE_MS) idleSessionIds.push(sessionId);
  }
  for (const sessionId of idleSessionIds) {
    void closeStreamableSession(sessionId);
  }
}, STREAMABLE_SESSION_SWEEP_MS);
streamableReapInterval.unref();

// Any-origin CORS by design: browser-based MCP clients are first-class
// callers, and Origin carries no security signal for a public server -
// authorization is the bearer token alone. Applied via setHeader at the top
// of the handler because Node merges prior setHeader() values into any later
// writeHead(status, obj): that one insertion point covers the 401/403/404
// branches below AND the responses the SDK transport writes itself inside
// handleRequest.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-session-id, mcp-protocol-version, last-event-id',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);

  // Preflight, before the auth gate: browsers never attach Authorization to
  // an OPTIONS request, so a preflight inside the authed branch would 401.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Unauthenticated liveness probe. Creates no session and touches no rate
  // limit (the per-identity limiter lives inside the tool handlers, which
  // this never reaches).
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: PKG_VERSION }));
    return;
  }

  if (url.pathname === '/mcp') {
    // Streamable HTTP transport - the only MCP transport since 2.0.0 (the
    // deprecated SSE pair /sse + /messages was removed). A valid token for
    // identity A must not be able to drive identity B's session.
    const auth = resolveIdentity(req.headers.authorization, authConfig, clientIpOf(req));
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' });
      res.end(auth.reason);
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
      const transport = streamableTransports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found');
        return;
      }
      if (streamableIdentities.get(sessionId) !== auth.identity) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('This session belongs to a different identity.');
        return;
      }
      streamableLastSeen.set(sessionId, Date.now());
      await transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing mcp-session-id header');
      return;
    }
    // Per-identity session cap: evict the identity's oldest session before
    // creating one more, so a caller that keeps calling initialize without
    // ever sending DELETE cannot grow this identity's session count past
    // MAX_SESSIONS_PER_IDENTITY.
    const identitySessionIds = [...streamableIdentities.entries()]
      .filter(([, identity]) => identity === auth.identity)
      .map(([sid]) => sid);
    if (identitySessionIds.length > 0 && identitySessionIds.length >= MAX_SESSIONS_PER_IDENTITY) {
      let oldestSessionId = identitySessionIds[0];
      let oldestLastSeen = streamableLastSeen.get(oldestSessionId) ?? 0;
      for (const sid of identitySessionIds) {
        const lastSeen = streamableLastSeen.get(sid) ?? 0;
        if (lastSeen < oldestLastSeen) {
          oldestLastSeen = lastSeen;
          oldestSessionId = sid;
        }
      }
      await closeStreamableSession(oldestSessionId);
    }
    // No session header on a POST: treat as an initialization request. The SDK
    // enforces the rest (a non-initialize body without a session is rejected by
    // the transport itself; the unstored transport is then garbage).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        streamableTransports.set(sid, transport);
        streamableIdentities.set(sid, auth.identity);
        streamableLastSeen.set(sid, Date.now());
      },
      onsessionclosed: (sid) => {
        streamableTransports.delete(sid);
        streamableIdentities.delete(sid);
        streamableLastSeen.delete(sid);
      },
    });
    transport.onclose = () => {
      // Fires on every close, not just DELETE. handleDeleteRequest (the
      // SDK's own webStandardStreamableHttp.js) calls onsessionclosed above
      // AND this callback in the same request, so on that path the two are
      // redundant with each other. But onsessionclosed is wired into the SDK
      // exclusively from that DELETE handler - it is never invoked for an
      // abrupt disconnect, and never invoked by a direct transport.close()
      // call. The idle reaper and the per-identity cap eviction above both
      // call transport.close() directly (via closeStreamableSession), which
      // drives only this callback. This is therefore the one drain path
      // every teardown route - DELETE, idle reaper, and cap eviction alike -
      // actually shares; onsessionclosed only ever adds coverage for DELETE,
      // which this callback already has.
      const sid = transport.sessionId;
      if (sid) {
        streamableTransports.delete(sid);
        streamableIdentities.delete(sid);
        streamableLastSeen.delete(sid);
      }
    };
    const session = createMcpServer(auth.identity);
    await session.connect(transport);
    await transport.handleRequest(req, res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(PORT, () => {
  console.error(`Vector MCP Server listening on port ${PORT}`);
});

httpServer.on('error', (err: Error) => {
  console.error('Fatal error in HTTP server:', err.message);
  process.exit(1);
});

httpServer.on('close', () => {
  clearInterval(streamableReapInterval);
});
