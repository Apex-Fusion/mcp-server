// packages/builder/scripts/regen-tool-schemas.mjs
// Boots the BUILT server, lists tools over SSE, rewrites the smoke snapshot
// sorted by name. Run: npm run build && node packages/builder/scripts/regen-tool-schemas.mjs
// (npm run build must still run from the repo root - or via `npm run build
// --workspace=...` - since it's an npm script; but this script itself now
// runs from any cwd, since its paths are resolved from its own location).
//
// Deviation from the original brief version: the brief used a flat 2000ms
// sleep before connecting. On this machine that raced the server's actual
// startup (cold module load of lucid-evolution/libsodium takes longer),
// producing ECONNREFUSED. Swapped for the same "wait for the 'listening on
// port' stderr line" readiness signal that test/setup.ts's startServer()
// already uses elsewhere in this repo, with spawn error/exit handling so a
// real startup crash fails loudly instead of hanging.
//
// PR 6 (Task 5) change: each snapshot entry is now { description, inputSchema }
// instead of a bare inputSchema, so the fixture also guards the
// security-teaching copy in tool descriptions (the sign/submit/confirm flow
// callers learn from them), not just the JSON Schema shape. See the docblock
// above the schema-snapshot describe() in
// packages/builder/test/smoke/tool-inventory.test.ts for the full rationale.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Resolved from this file's own location, not from process.cwd(), so the
// script behaves identically regardless of where it's invoked from (repo
// root, packages/builder, or anywhere else).
const SERVER_ENTRY = resolve(import.meta.dirname, '../build/index.js');
const SNAPSHOT_PATH = resolve(import.meta.dirname, '../test/smoke/tool-schemas.snapshot.json');

const PORT = 3939;
const server = spawn('node', [SERVER_ENTRY], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderrBuf = '';
server.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

try {
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server start timeout (20s). stderr so far:\n${stderrBuf}`)), 20_000);
    const onData = () => {
      if (stderrBuf.includes('listening on port')) {
        clearTimeout(timeout);
        server.stderr.off('data', onData);
        resolvePromise();
      }
    };
    server.stderr.on('data', onData);
    server.on('error', (err) => { clearTimeout(timeout); reject(err); });
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited with code ${code}. stderr so far:\n${stderrBuf}`)); });
  });

  const client = new Client({ name: 'regen', version: '0.0.0' });
  await client.connect(new SSEClientTransport(new URL(`http://localhost:${PORT}/sse`)));
  const { tools } = await client.listTools();
  const snapshot = Object.fromEntries(
    tools
      .map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify(snapshot, null, 2) + '\n',
  );
  console.log(`wrote ${tools.length} tool schemas`);
  await client.close();
} finally {
  server.kill();
}
