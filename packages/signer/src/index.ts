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
//
// It exits from the callback of the stdout write, never straight after it: stdout is
// a pipe when a member redirects or captures it, a pipe may not have taken the text
// when write() returns, and process.exit() drops what it has not delivered - the one
// line the member cannot get again. A failed write exits 1 and says so on stderr
// (never what was to be written), so a key that did not arrive is not mistaken for
// one that did.
if (process.argv[2] === 'keygen') {
  printKeygen((err) => {
    if (err) console.error('vector-mcp-signer keygen: could not write to stdout; run it again.');
    process.exit(err ? 1 : 0);
  });
} else {
  const config = loadConfig();

  const server = new McpServer({ name: 'vector-mcp-signer', version: PKG_VERSION });
  registerSignerTools(server, config);

  // stdout is the MCP channel - every diagnostic must go to stderr.
  console.error(`vector-mcp-signer ready. Key source: ${config.keySource.describe()}`);
  console.error(`Audit log: ${config.auditLogPath}`);

  await server.connect(new StdioServerTransport());
}
