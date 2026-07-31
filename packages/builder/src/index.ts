import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { createServer } from 'http';

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
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerVectorTools } from "./vector/index.js";
import { loadAuthConfig, resolveIdentity, clientIpOf } from "./auth.js";

function createMcpServer(identity: string) {
  const server = new McpServer({
    name: "vector-mcp-server",
    version: "1.0.0",
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
const transports = new Map<string, SSEServerTransport>();
const sessionIdentities = new Map<string, string>();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/sse') {
    const auth = resolveIdentity(req.headers.authorization, authConfig, clientIpOf(req));
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' });
      res.end(auth.reason);
      return;
    }
    const transport = new SSEServerTransport('/messages', res);
    const session = createMcpServer(auth.identity);
    sessionIdentities.set(transport.sessionId, auth.identity);
    transports.set(transport.sessionId, transport);
    res.on('close', () => {
      transports.delete(transport.sessionId);
      sessionIdentities.delete(transport.sessionId);
    });
    await session.connect(transport);
  } else if (req.method === 'POST' && url.pathname === '/messages') {
    const auth = resolveIdentity(req.headers.authorization, authConfig, clientIpOf(req));
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' });
      res.end(auth.reason);
      return;
    }
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.writeHead(400);
      res.end('Missing sessionId');
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.writeHead(404);
      res.end('Session not found');
      return;
    }
    // A valid token for identity A must not be able to drive identity B's session.
    if (sessionIdentities.get(sessionId) !== auth.identity) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('This session belongs to a different identity.');
      return;
    }
    await transport.handlePostMessage(req, res);
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
