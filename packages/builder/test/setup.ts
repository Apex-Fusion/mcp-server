import { spawn, ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const PROJECT_ROOT = resolve(import.meta.dirname!, '..');

export interface ServerContext {
  client: Client;
  process: ChildProcess;
  port: number;
}

export function getMnemonic(): string {
  const mnemonic = readFileSync(resolve(PROJECT_ROOT, 'mnemonic.txt'), 'utf-8').trim();
  const wordCount = mnemonic.split(/\s+/).length;
  const validLengths = [12, 15, 18, 21, 24];
  if (!validLengths.includes(wordCount)) {
    throw new Error(`mnemonic.txt has ${wordCount} words, expected one of: ${validLengths.join(', ')}`);
  }
  return mnemonic;
}

export async function startServer(): Promise<ServerContext> {
  const port = 3100 + Math.floor(Math.random() * 900);
  const child = spawn('node', ['build/index.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout (60s)')), 60_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited with code ${code}`)); });
  });

  const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`));
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(transport);

  return { client, process: child, port };
}

export async function stopServer(ctx: ServerContext): Promise<void> {
  try { await ctx.client.close(); } catch {}
  ctx.process.kill('SIGTERM');
}

export interface RawServerHandle {
  process: ChildProcess;
  port: number;
  /** Snapshot of everything the server has written to stderr so far. */
  stderr(): string;
}

/**
 * Spawn the built server directly, without connecting an SDK client.
 *
 * startServer() above always connects a default Client with no Authorization
 * header, which is exactly right for the pre-existing suites (auth is never
 * configured there) but wrong for auth-gating/rate-limit tests: those need
 * MCP_AUTH_TOKENS set, several distinct Authorization headers driven by hand
 * (including deliberately-wrong ones), and a captured stderr stream to prove
 * no token leaks into it. A bare "add an env param" to startServer() can't
 * serve those needs without either connecting a client that immediately 401s
 * (auth on, no header) or changing ServerContext's shape for every existing
 * caller - so this is a separate, additive function instead.
 */
export async function spawnServer(envOverrides: Record<string, string> = {}): Promise<RawServerHandle> {
  // Different port range than startServer()'s 3100-3999, and retried on
  // failure: this suite spawns more servers per run than the pre-existing
  // ones, so a single random draw is more likely to collide under CI
  // parallelism (multiple test files spawning concurrently).
  const maxAttempts = 5;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = 4100 + Math.floor(Math.random() * 1800);
    const child = spawn('node', ['build/index.js'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(port), ...envOverrides },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Server start timeout (60s)')), 60_000);
        const onData = () => {
          if (stderrBuf.includes('listening on port')) {
            clearTimeout(timeout);
            child.stderr!.off('data', onData);
            resolve();
          }
        };
        child.stderr!.on('data', onData);
        child.on('error', (err) => { clearTimeout(timeout); reject(err); });
        child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited with code ${code}. stderr so far: ${stderrBuf}`)); });
      });
      return { process: child, port, stderr: () => stderrBuf };
    } catch (err) {
      lastErr = err as Error;
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  throw lastErr ?? new Error('spawnServer: exhausted retries');
}

export async function stopRawServer(handle: RawServerHandle): Promise<void> {
  handle.process.kill('SIGTERM');
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content?.[0]?.text ?? '';
}

export function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}
