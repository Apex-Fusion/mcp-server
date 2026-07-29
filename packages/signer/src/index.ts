// Local signing companion for the Vector MCP server.
//
// Speaks stdio only: no HTTP listener, no outbound network, no Provider.
// The signing key never leaves this process. See test/boundary.test.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerSignerTools } from './tools.js';

const config = loadConfig();

const server = new McpServer({ name: 'vector-mcp-signer', version: '0.1.0' });
registerSignerTools(server, config);

// stdout is the MCP channel — every diagnostic must go to stderr.
console.error(`vector-mcp-signer ready. Key source: ${config.keySource.describe()}`);
console.error(`Audit log: ${config.auditLogPath}`);

await server.connect(new StdioServerTransport());
