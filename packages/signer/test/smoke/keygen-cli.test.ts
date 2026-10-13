// `keygen`, exercised through the BUILT entry point: the file `npx` runs. This
// lives under smoke/ because it needs build/index.js, which `npm run
// test:smoke:signer` builds first. The generateKey() logic itself is covered
// by test/keygen.test.ts.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { loadConfig } from '../../src/config.ts';

const ENTRY = fileURLToPath(new URL('../../build/index.js', import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Runs `keygen` the way a first-time member would: no signer configuration of
// any kind in the environment, stdin closed, in a directory we can inspect
// afterwards.
function runKeygen(cwd: string): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('VECTOR_SIGNER_')) delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, 'keygen'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`keygen did not exit within 20s (a server that started instead would wait on stdin). stderr: ${stderr}`));
    }, 20_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// The NAME=value lines, the way a member (or a dotenv loader) reads them.
function assignments(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    assert.ok(eq > 0, `not a NAME=value line: ${line}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let cwd: string;
let first: RunResult;
let second: RunResult;

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'signer-keygen-'));
  [first, second] = await Promise.all([runKeygen(cwd), runKeygen(cwd)]);
});

after(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('vector-mcp-signer keygen (built entry point)', () => {
  test('runs with no signer configuration at all, exits 0, and prints nothing to stderr', () => {
    assert.equal(first.code, 0, `stderr: ${first.stderr}`);
    assert.equal(first.stderr, '');
  });

  test('stdout is exactly the documented output and nothing else', () => {
    const { VECTOR_SIGNER_PRIVATE_KEY: key, VECTOR_SIGNER_ADDRESS: address } = assignments(first.stdout);
    assert.match(key, /^ed25519_sk1[0-9a-z]+$/);
    assert.match(address, /^addr1v[0-9a-z]+$/);
    assert.equal(
      first.stdout,
      [
        "# Paste these two lines into the signer's env in your MCP client config. Keep the key private.",
        `VECTOR_SIGNER_PRIVATE_KEY=${key}`,
        `VECTOR_SIGNER_ADDRESS=${address}`,
        '',
        `# Send this address (only this) to whoever funds your key: ${address}`,
        '',
      ].join('\n')
    );
  });

  test('prints the private key exactly once, and only the address after it', () => {
    const { VECTOR_SIGNER_PRIVATE_KEY: key, VECTOR_SIGNER_ADDRESS: address } = assignments(first.stdout);
    assert.equal(countOf(first.stdout, key), 1);
    assert.equal(countOf(first.stdout, address), 2);
    assert.ok(!first.stderr.includes(key), 'the key must never reach stderr');
  });

  test('the printed lines are exactly the two variables the signer reads, and they work as its env', () => {
    const env = assignments(first.stdout);
    assert.deepEqual(Object.keys(env).sort(), ['VECTOR_SIGNER_ADDRESS', 'VECTOR_SIGNER_PRIVATE_KEY']);

    const identity = loadConfig(env).keySource.load();
    assert.equal(identity.privateKeyBech32, env.VECTOR_SIGNER_PRIVATE_KEY);
    assert.equal(identity.address, env.VECTOR_SIGNER_ADDRESS);

    // The address really belongs to the key: same payment key hash, mainnet, no stake part.
    const addr = CML.Address.from_bech32(identity.address);
    const keyHash = CML.PrivateKey.from_bech32(identity.privateKeyBech32).to_public().hash().to_hex();
    assert.equal(addr.payment_cred()!.as_pub_key()!.to_hex(), keyHash);
    assert.equal(addr.network_id(), 1);
    assert.equal(addr.staking_cred(), undefined);
  });

  test('every run generates a fresh key', () => {
    assert.equal(second.code, 0, `stderr: ${second.stderr}`);
    assert.notEqual(
      assignments(first.stdout).VECTOR_SIGNER_PRIVATE_KEY,
      assignments(second.stdout).VECTOR_SIGNER_PRIVATE_KEY
    );
  });

  test('writes nothing to disk', () => {
    assert.deepEqual(readdirSync(cwd), []);
  });
});
