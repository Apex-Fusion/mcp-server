import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TEST_MNEMONIC =
  'test walk nut penalty hip pave soap entry language right filter choice';

const FIXTURE_CBOR =
  '84a300d9010281825820e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c3200018282581d71ab1aad52c4774e5da9f2c0fa1a4d07220a0bdd57ee3dce9be860dac61a002dc6c0825839013fd872a48d71872cf76528bb41dd2a5775e2c532c21662a47c6cebf44b6be5f33456f28523ed04d1aaad158541176425378d8ed8fce53f881a3b6a7221021a0002911fa0f5f6';

const EXPECTED_TOOLS = [
  'vector_signer_decode_transaction',
  'vector_signer_get_address',
  'vector_signer_get_spend_limits',
  'vector_signer_sign',
];

let client: Client;
let dir: string;

async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  const c = r.content as Array<{ type: string; text?: string }>;
  return c?.[0]?.text ?? '';
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'signer-smoke-'));
  const mnemonicFile = join(dir, 'mnemonic.txt');
  writeFileSync(mnemonicFile, TEST_MNEMONIC, { mode: 0o600 });

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/signer/build/index.js'],
    env: {
      ...process.env,
      VECTOR_SIGNER_MNEMONIC_FILE: mnemonicFile,
      VECTOR_SIGNER_AUDIT_LOG_PATH: join(dir, 'audit.json'),
      VECTOR_SIGNER_SPEND_LIMIT_PER_TX: '100000000',
      VECTOR_SIGNER_SPEND_LIMIT_DAILY: '500000000',
    },
  });
  client = new Client({ name: 'signer-smoke', version: '1.0.0' });
  await client.connect(transport);
});

after(async () => {
  try { await client.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe('signer MCP server over stdio', () => {
  test('exposes exactly the four expected tools', async () => {
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  });

  test('no tool accepts a mnemonic or private key parameter', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as any).properties ?? {});
      for (const p of props) {
        assert.ok(!/mnemonic|private_?key|seed/i.test(p), `${t.name} exposes key material as parameter "${p}"`);
      }
    }
  });

  test('get_address returns the derived addr1 address', async () => {
    assert.match(await callText('vector_signer_get_address'), /addr1[0-9a-z]+/);
  });

  test('decode_transaction reports the net outflow without signing', async () => {
    const text = await callText('vector_signer_decode_transaction', { txCbor: FIXTURE_CBOR });
    assert.match(text, /Net outflow/i);
    assert.ok(!/signed/i.test(text), 'decode must not sign');
  });

  // The fixture was built for a DIFFERENT wallet, so for this test key both of
  // its outputs are foreign: net outflow is ~1000 AP3X, far over the 100 AP3X
  // per-transaction limit. Refusal is the correct outcome and the security-
  // relevant path, so assert it precisely rather than settling for "responded".
  test('sign refuses a transaction whose net outflow exceeds the per-transaction limit', async () => {
    const text = await callText('vector_signer_sign', { txCbor: FIXTURE_CBOR });
    assert.match(text, /REFUSED/);
    assert.match(text, /per-transaction limit/i);
  });

  test('a refusal returns no signed CBOR', async () => {
    const text = await callText('vector_signer_sign', { txCbor: FIXTURE_CBOR });
    assert.ok(!/Signed CBOR/i.test(text), 'a refused transaction must not return signed bytes');
  });

  test('a refusal is recorded in the audit log but consumes no daily budget', async () => {
    await callText('vector_signer_sign', { txCbor: FIXTURE_CBOR });
    const limits = await callText('vector_signer_get_spend_limits');
    assert.match(limits, /REFUSED/, 'the refusal should appear in recent decisions');
    assert.match(limits, /Committed today:\s*0\.000000 AP3X/, 'a refusal must not consume budget');
  });

  test('get_spend_limits reports the configured limits', async () => {
    const text = await callText('vector_signer_get_spend_limits');
    assert.match(text, /100\.000000/);
    assert.match(text, /500\.000000/);
  });

  test('sign rejects malformed CBOR', async () => {
    const text = await callText('vector_signer_sign', { txCbor: 'not-hex' });
    assert.match(text, /could not be decoded|refus/i);
  });
});
