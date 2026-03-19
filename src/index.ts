import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { createServer } from 'http';

// Get directory name for ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check for .env file
const envPath = resolve(__dirname, '../.env');
console.error('Looking for .env file at:', envPath);
console.error('.env file exists:', existsSync(envPath));

// Load environment variables (non-fatal if missing — env vars can be passed directly)
if (existsSync(envPath)) {
  const result = config({ path: envPath });
  if (result.error) {
    console.error('Warning: Error loading .env file:', result.error);
  }
} else {
  console.error('No .env file found — using environment variables directly');
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerVectorTools } from "./vector/index.js";

function createMcpServer() {
  const server = new McpServer({
    name: "vector-mcp-server",
    version: "1.0.0",
  });
  registerVectorTools(server);
  return server;
}

console.error('Vector MCP Server starting...');

const PORT = parseInt(process.env.PORT || '3000');
const transports = new Map<string, SSEServerTransport>();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/sse') {
    const transport = new SSEServerTransport('/messages', res);
    const session = createMcpServer();
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    await session.connect(transport);
  } else if (req.method === 'POST' && url.pathname === '/messages') {
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
