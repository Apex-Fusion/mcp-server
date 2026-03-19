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
    const timeout = setTimeout(() => reject(new Error('Server start timeout (15s)')), 15_000);
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

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content?.[0]?.text ?? '';
}

export function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}
