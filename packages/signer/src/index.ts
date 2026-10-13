// Local signing companion for the Vector MCP server.
//
// Speaks stdio only: no HTTP listener, no outbound network, no Provider.
// The signing key never leaves this process. See test/boundary.test.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { printKeygen } from './keygen.js';
import { registerSignerTools } from './tools.js';
// Single source of truth for the advertised version; inlined at build time.
import { version as PKG_VERSION } from '../package.json';

// `keygen` is a one-shot command, not the server: it prints a fresh key and exits.
// It runs before loadConfig() on purpose - a member generating their first key has
// no signer configuration yet, and loadConfig() throws without one. In this mode no
// server is running, so stdout is free for the output (in server mode it is the MCP
// channel, see below).
if (process.argv[2] === 'keygen') {
  printKeygen();
  process.exit(0);
}

const config = loadConfig();

const server = new McpServer({ name: 'vector-mcp-signer', version: PKG_VERSION });
registerSignerTools(server, config);

// stdout is the MCP channel - every diagnostic must go to stderr.
console.error(`vector-mcp-signer ready. Key source: ${config.keySource.describe()}`);
console.error(`Audit log: ${config.auditLogPath}`);

await server.connect(new StdioServerTransport());
