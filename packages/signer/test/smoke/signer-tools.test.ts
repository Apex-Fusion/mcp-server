import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MnemonicKeySource } from '../../src/keysource.ts';
import { loadConfig } from '../../src/config.ts';
import { signTransaction } from '../../src/sign.ts';

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

// --- Edge-case pass (beyond the brief) --------------------------------------
//
// The brief's 9 tests above are a floor. Every previous task in this signer
// package shipped at least one defect that produced a plausible-looking
// success rather than an error (see .superpowers/sdd/signer-task-*-report.md)
// — that same suspicion is applied here, especially to the audit-then-return
// ordering in the sign tool, which is THE thing this task's brief calls out
// as mattering most: audit.ts's append() throws by design on a write
// failure (see the CONTRACT note at the top of audit.ts), and a signature
// must never be released to a caller when its own audit record failed to
// land durably on disk.
//
// Each test below spins up its OWN dedicated server (own temp dir, own
// mnemonic file, own audit log path) rather than sharing the brief's module-
// level `client`/`dir` — the brief's own 9 tests are order-dependent on a
// single accumulating audit log, and coupling more tests onto that same
// shared state would make failures harder to isolate for no benefit, since
// nothing below needs to observe the brief's own tests' history.

const TEST_IDENTITY = new MnemonicKeySource(TEST_MNEMONIC).load();

interface EdgeServer {
  client: Client;
  dir: string;
  stderrChunks: string[];
}

async function spawnSigner(
  opts: {
    auditLogPath?: (dir: string) => string;
    perTx?: string;
    daily?: string;
  } = {}
): Promise<EdgeServer> {
  const dir = mkdtempSync(join(tmpdir(), 'signer-smoke-edge-'));
  const mnemonicFile = join(dir, 'mnemonic.txt');
  writeFileSync(mnemonicFile, TEST_MNEMONIC, { mode: 0o600 });
  const auditLogPath = opts.auditLogPath ? opts.auditLogPath(dir) : join(dir, 'audit.json');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/signer/build/index.js'],
    env: {
      ...process.env,
      VECTOR_SIGNER_MNEMONIC_FILE: mnemonicFile,
      VECTOR_SIGNER_AUDIT_LOG_PATH: auditLogPath,
      VECTOR_SIGNER_SPEND_LIMIT_PER_TX: opts.perTx ?? '100000000',
      VECTOR_SIGNER_SPEND_LIMIT_DAILY: opts.daily ?? '500000000',
    },
    // Piped (not the brief's default 'inherit') specifically so the startup
    // banner can be captured and inspected for leaked key material below.
    // Per the SDK's own doc comment on StdioClientTransport#stderr, the
    // PassThrough stream exists immediately after construction, so the
    // listener below is attached before connect() (which spawns the child)
    // to avoid losing early output.
    stderr: 'pipe',
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

  const client = new Client({ name: 'signer-smoke-edge', version: '1.0.0' });
  await client.connect(transport);
  // client.connect() only waits for the MCP initialize handshake on stdout;
  // stderr is a separate, independently-buffered pipe with no ordering
  // guarantee relative to stdout at the Node event-loop level, even though
  // the server writes its banner before it ever starts that handshake. A
  // short grace period avoids a race between "handshake done" and "banner
  // chunk delivered" when a test reads stderrChunks immediately afterward.
  await new Promise((r) => setTimeout(r, 75));
  return { client, dir, stderrChunks };
}

async function stopSigner(server: EdgeServer): Promise<void> {
  try {
    await server.client.close();
  } catch {
    /* already closed */
  }
  rmSync(server.dir, { recursive: true, force: true });
}

async function callToolText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  const c = r.content as Array<{ type: string; text?: string }>;
  return c?.[0]?.text ?? '';
}

// Builds a synthetic transaction whose SOLE output pays `payToAddress`, with
// a fee well inside the smoke test's 100/500 AP3X limits. The brief's own
// FIXTURE_CBOR is deliberately refused for TEST_MNEMONIC (built for a
// different, funded wallet — see the note above the "sign refuses..." test),
// so a genuinely in-policy transaction has to be constructed by hand to
// exercise the "signed" branch of vector_signer_sign at all.
//
// Verified against a throwaway probe before use in any test (see the task
// report): decodes cleanly with decode.ts, policy.evaluate() returns
// allowed:true with netOutflowLovelace equal to feeLovelace alone (the
// output returns to its own address, so it counts as change, not outflow),
// and signTransaction() accepts it. The referenced input UTXO does not need
// to exist on-chain — decode.ts/policy.ts/sign.ts never resolve inputs
// against the chain, by design (that is exactly why this signer needs no
// network access at all).
function buildInPolicyTxCbor(payToAddress: string, feeLovelace = 200_000n, outputLovelace = 5_000_000n): string {
  const inputTxHash = CML.TransactionHash.from_hex(
    'e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c32'
  );
  const inputs = CML.TransactionInputList.new();
  inputs.add(CML.TransactionInput.new(inputTxHash, 0n));

  const outputs = CML.TransactionOutputList.new();
  outputs.add(
    CML.TransactionOutput.new(CML.Address.from_bech32(payToAddress), CML.Value.from_coin(outputLovelace))
  );

  const body = CML.TransactionBody.new(inputs, outputs, feeLovelace);
  const tx = CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true, undefined);
  return tx.to_cbor_hex();
}

// A minimal hand-rolled Transport, used ONLY by the stdout-purity test below.
// StdioClientTransport (used everywhere else in this file) does not expose
// the child process's raw stdout stream through any public API — only
// `.stderr` and `.pid` are getters on it, by design, since a normal caller
// should only ever see fully parsed messages. That is exactly the wrong tool
// for this test: verified directly against the SDK's own source
// (node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js and
// client/stdio.js) that `ReadBuffer.readMessage()` advances its internal
// buffer PAST a line before attempting to parse it, so a line that fails
// `JSON.parse` is silently skipped — the read loop moves on to the next
// line and the connection keeps working. A stray non-JSON line on stdout
// (e.g. index.ts's banner lines written via console.log instead of
// console.error) would therefore corrupt the protocol stream without
// failing the handshake, without failing any tool call, and without
// tripping any assertion that only checks "did the connection work" —
// which is all every other test in this file does. This class exists so a
// test can instead read every raw byte written to stdout directly and
// assert on it, independent of the SDK's own leniency.
//
// Reimplements the wire format directly (JSON.stringify(message) + '\n' to
// send; split-on-'\n', JSON.parse each line to receive) rather than
// importing the SDK's own ReadBuffer/serializeMessage — both are internal,
// unexported implementation details of shared/stdio.js, not part of the
// package's public export surface (unlike client/index.js and
// client/stdio.js, which this file already imports). The format itself is
// simple enough (confirmed by reading the same source above) that
// reproducing it directly here is more honest than reaching into another
// module's internals.
class RawCapturingStdioTransport implements Transport {
  private child?: ChildProcess;
  private lineBuffer = '';
  readonly rawStdoutChunks: string[] = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child.stdout!.on('data', (chunk: Buffer) => {
      const chunkText = chunk.toString('utf8');
      // Captured BEFORE any line-splitting/parsing below — this is the raw
      // ground truth the test asserts against, deliberately independent of
      // whatever the parsing loop below does with it.
      this.rawStdoutChunks.push(chunkText);

      this.lineBuffer += chunkText;
      let index: number;
      while ((index = this.lineBuffer.indexOf('\n')) !== -1) {
        const line = this.lineBuffer.slice(0, index).replace(/\r$/, '');
        this.lineBuffer = this.lineBuffer.slice(index + 1);
        if (line.length === 0) continue;
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    this.child.on('close', () => this.onclose?.());
    this.child.on('error', (err) => this.onerror?.(err));
    await new Promise<void>((resolvePromise, reject) => {
      this.child!.once('spawn', () => resolvePromise());
      this.child!.once('error', reject);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error('RawCapturingStdioTransport: not connected');
    const json = JSON.stringify(message) + '\n';
    await new Promise<void>((resolvePromise) => {
      if (stdin.write(json)) resolvePromise();
      else stdin.once('drain', resolvePromise);
    });
  }

  async close(): Promise<void> {
    this.child?.kill();
  }
}

describe('stdout carries ONLY the MCP protocol — direct assertion, not an incidental one', () => {
  // Review finding (Task 7 follow-up): swapping index.ts's two startup-
  // banner console.error calls for console.log was previously caught only
  // incidentally, by the "startup banner (stderr)" test's
  // `banner.length > 0` sanity check happening to fail once the banner
  // stopped going to stderr at all — a coincidence of a DIFFERENT test's
  // setup, not a real check of stdout. Confirmed directly against the SDK's
  // own source (see the comment on RawCapturingStdioTransport above) that
  // there is no implicit tripwire either: a corrupted line is silently
  // skipped by the read loop, so the connection and every tool call in this
  // suite would keep working normally even with genuinely corrupted stdout.
  test('every line written to stdout, across a healthy startup and a normal tool call, is valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signer-smoke-stdout-'));
    const mnemonicFile = join(dir, 'mnemonic.txt');
    writeFileSync(mnemonicFile, TEST_MNEMONIC, { mode: 0o600 });

    const transport = new RawCapturingStdioTransport('node', ['packages/signer/build/index.js'], {
      ...process.env,
      VECTOR_SIGNER_MNEMONIC_FILE: mnemonicFile,
      VECTOR_SIGNER_AUDIT_LOG_PATH: join(dir, 'audit.json'),
      VECTOR_SIGNER_SPEND_LIMIT_PER_TX: '100000000',
      VECTOR_SIGNER_SPEND_LIMIT_DAILY: '500000000',
    });
    const client = new Client({ name: 'signer-smoke-stdout-purity', version: '1.0.0' });
    try {
      // The real handshake (initialize -> notifications/initialized), driven
      // by the actual Client class for protocol correctness — only the
      // transport underneath it is custom. See Client.connect() in
      // node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js: it
      // calls transport.start(), sends 'initialize', then
      // 'notifications/initialized' once the response validates.
      await client.connect(transport);
      // One normal tool call, matching "a normal tool call" from the review.
      await callToolText(client, 'vector_signer_get_address');

      const rawOutput = transport.rawStdoutChunks.join('');
      const lines = rawOutput
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.length > 0);

      assert.ok(lines.length >= 2, `sanity: expected at least an initialize response and a tool-call response, got ${lines.length} line(s)`);
      for (const [i, line] of lines.entries()) {
        assert.doesNotThrow(
          () => JSON.parse(line),
          `stdout line #${i} is not valid JSON — the MCP protocol stream is corrupted by a stray write: ${line.slice(0, 200)}`
        );
      }
    } finally {
      try {
        await client.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig() — no key material configured', () => {
  test('throws a clear, specific error naming what is missing, not a vague one', () => {
    // No VECTOR_SIGNER_MNEMONIC / _MNEMONIC_FILE / _PRIVATE_KEY+_ADDRESS at
    // all — the "nobody configured a key yet" case a fresh deployment or a
    // misconfigured launcher would actually hit.
    const bareEnv = {} as NodeJS.ProcessEnv;
    assert.throws(() => loadConfig(bareEnv), /No key material configured/);
  });

  test('the built server exits promptly and loudly on stderr rather than hanging or crashing unhelpfully', async () => {
    const strippedEnv: NodeJS.ProcessEnv = { ...process.env };
    delete strippedEnv.VECTOR_SIGNER_MNEMONIC;
    delete strippedEnv.VECTOR_SIGNER_MNEMONIC_FILE;
    delete strippedEnv.VECTOR_SIGNER_PRIVATE_KEY;
    delete strippedEnv.VECTOR_SIGNER_ADDRESS;

    const child: ChildProcess = spawn('node', ['packages/signer/build/index.js'], {
      env: strippedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`process did not exit within 5s — looks like a hang. stderr so far: ${stderr}`)),
        5000
      );
      child.on('exit', (code) => {
        clearTimeout(timeout);
        resolvePromise(code);
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    assert.notEqual(exitCode, 0, 'must exit non-zero when it cannot start at all');
    assert.match(stderr, /No key material configured/, 'the real, specific reason must reach stderr');
    assert.equal(stdout, '', 'nothing MCP-protocol-shaped should ever reach stdout on a startup failure');
  });
});

describe('key material is never emitted', () => {
  test('the startup banner (stderr) never contains a mnemonic word or the derived private key', async () => {
    const server = await spawnSigner();
    try {
      const banner = server.stderrChunks.join('');
      assert.ok(banner.length > 0, 'sanity: something was actually captured on stderr');
      assert.match(banner, /ready/i);
      for (const word of TEST_MNEMONIC.split(' ')) {
        assert.ok(!banner.includes(word), `startup banner must not contain mnemonic word "${word}": ${banner}`);
      }
      assert.ok(
        !banner.includes(TEST_IDENTITY.privateKeyBech32),
        'startup banner must not contain the derived private key'
      );
    } finally {
      await stopSigner(server);
    }
  });

  test('no tool response across a sweep of calls (including a real successful sign) contains a mnemonic word or the derived private key', async () => {
    const server = await spawnSigner();
    try {
      const inPolicyTx = buildInPolicyTxCbor(TEST_IDENTITY.address);

      const responses: string[] = [];
      responses.push(await callToolText(server.client, 'vector_signer_get_address'));
      responses.push(await callToolText(server.client, 'vector_signer_decode_transaction', { txCbor: FIXTURE_CBOR }));
      responses.push(
        await callToolText(server.client, 'vector_signer_decode_transaction', { txCbor: inPolicyTx })
      );
      responses.push(await callToolText(server.client, 'vector_signer_sign', { txCbor: FIXTURE_CBOR })); // refused
      responses.push(await callToolText(server.client, 'vector_signer_sign', { txCbor: 'not-hex' })); // malformed
      responses.push(await callToolText(server.client, 'vector_signer_sign', { txCbor: inPolicyTx })); // actually signed
      responses.push(await callToolText(server.client, 'vector_signer_get_spend_limits'));

      // Sanity: the sweep must actually exercise the real success path, or
      // this test would vacuously pass by never looking at a response that
      // could plausibly contain key material in the first place.
      assert.ok(responses.some((r) => /Signed CBOR/i.test(r)), 'sanity: the sweep must include a real signed response');

      for (const [i, resp] of responses.entries()) {
        for (const word of TEST_MNEMONIC.split(' ')) {
          assert.ok(!resp.includes(word), `response #${i} contains mnemonic word "${word}": ${resp.slice(0, 300)}`);
        }
        assert.ok(!resp.includes(TEST_IDENTITY.privateKeyBech32), `response #${i} contains the raw private key`);
      }
    } finally {
      await stopSigner(server);
    }
  });
});

describe('decode_transaction is strictly read-only', () => {
  test('never appears in get_spend_limits recent decisions and never changes committed-today, even for an in-policy transaction', async () => {
    const server = await spawnSigner();
    try {
      const before = await callToolText(server.client, 'vector_signer_get_spend_limits');
      assert.match(before, /No decisions recorded yet\./, 'sanity: starts with an empty audit log');

      await callToolText(server.client, 'vector_signer_decode_transaction', { txCbor: FIXTURE_CBOR });
      await callToolText(server.client, 'vector_signer_decode_transaction', { txCbor: FIXTURE_CBOR });
      await callToolText(server.client, 'vector_signer_decode_transaction', {
        txCbor: buildInPolicyTxCbor(TEST_IDENTITY.address),
      });

      const after = await callToolText(server.client, 'vector_signer_get_spend_limits');
      assert.match(
        after,
        /No decisions recorded yet\./,
        'decode_transaction must never write an audit entry, even when previewing a transaction that would be ALLOWED'
      );
      assert.match(after, /Committed today:\s*0\.000000 AP3X/);
    } finally {
      await stopSigner(server);
    }
  });

  // Review finding (Task 7 follow-up): the audit-log check above does NOT
  // catch a decode_transaction that has been made to genuinely sign a
  // transaction whenever policy would have allowed it, worded to avoid the
  // substring "sign" (e.g. "Witnessed bytes:") - that mutation writes no
  // audit entry at all, so "No decisions recorded yet." stays true right up
  // until real signed bytes are already sitting in the response text. This
  // test targets that different failure mode directly: it does not depend on
  // wording, and it does not depend on FIXTURE_CBOR happening to be refused
  // (the mutation is only reachable when a transaction is genuinely allowed).
  //
  // registerReadOnlyTools() in tools.ts (see its own comment) now makes the
  // underlying mutation impossible to write as a one-line addition in the
  // first place - decode_transaction's handler has no `identity` or
  // `keySource` in scope at all, structurally, not by convention. This test
  // is the defense-in-depth layer underneath that structural guard: it pins
  // the CURRENT behaviour directly against what real signing would actually
  // produce, so it would still catch a future regression that re-threads
  // signing capability into that scope some other way.
  test('the response never contains the transaction\'s actual signed bytes, computed independently, for a transaction that would be ALLOWED', async () => {
    const server = await spawnSigner();
    try {
      const tx = buildInPolicyTxCbor(TEST_IDENTITY.address);
      // Computed independently, in the test, via the same signTransaction()
      // the real vector_signer_sign tool uses - this is exactly what a
      // "helpfully pre-computed" decode_transaction would produce and return,
      // whatever label it gave those bytes.
      const { signedCborHex } = signTransaction(tx, TEST_IDENTITY.privateKeyBech32);

      const result = await callToolText(server.client, 'vector_signer_decode_transaction', { txCbor: tx });

      assert.match(result, /would be ALLOWED/i, 'sanity: this fixture must actually reach the allowed branch decode_transaction previews, or the check below is vacuous');
      assert.ok(
        !result.includes(signedCborHex),
        'decode_transaction must never return the transaction\'s actual signed bytes, under any wording or label'
      );
    } finally {
      await stopSigner(server);
    }
  });
});

describe('a decode failure inside sign() is refused before any audit entry is even attempted', () => {
  test('malformed CBOR does not appear in recent decisions and does not change committed-today', async () => {
    const server = await spawnSigner();
    try {
      await callToolText(server.client, 'vector_signer_sign', { txCbor: 'not-hex' });
      const after = await callToolText(server.client, 'vector_signer_get_spend_limits');
      assert.match(
        after,
        /No decisions recorded yet\./,
        'undecodable input never reaches evaluate(), so there is no PolicyDecision to audit yet — by design, not a gap'
      );
      assert.match(after, /Committed today:\s*0\.000000 AP3X/);
    } finally {
      await stopSigner(server);
    }
  });
});

describe('get_spend_limits surfaces the concrete refusal reason, not just the word REFUSED', () => {
  test('the per-transaction-limit reason text appears in recent decisions', async () => {
    const server = await spawnSigner();
    try {
      await callToolText(server.client, 'vector_signer_sign', { txCbor: FIXTURE_CBOR });
      const limits = await callToolText(server.client, 'vector_signer_get_spend_limits');
      assert.match(limits, /REFUSED/);
      assert.match(
        limits,
        /per-transaction limit/i,
        'the recent-decisions line should carry the actual policy reason, not just the decision label'
      );
      assert.match(limits, /Committed today:\s*0\.000000 AP3X/);
    } finally {
      await stopSigner(server);
    }
  });
});

describe('THE hard requirement: an audit append failure on the SIGNED path withholds the signature', () => {
  // audit.ts's own CONTRACT note (top of the file) is explicit: append()
  // throws if the durable write fails, and a caller that catches the throw
  // and still returns the signature it already produced reproduces exactly
  // the failure the throw exists to prevent — a real signature reaching a
  // caller with no durable record of it, so a restarted process's
  // committedTodayLovelace() silently under-counts and the daily limit
  // stops binding. This describe block is the test that proves tools.ts
  // does not fall into that trap.

  test('control: the SAME in-policy transaction against a HEALTHY audit log genuinely signs (proves the fixture below is not simply broken)', async () => {
    const server = await spawnSigner();
    try {
      const tx = buildInPolicyTxCbor(TEST_IDENTITY.address);
      const result = await callToolText(server.client, 'vector_signer_sign', { txCbor: tx });
      assert.match(result, /^# Signed/);
      assert.match(result, /Signed CBOR/i);
    } finally {
      await stopSigner(server);
    }
  });

  test('an unwritable audit log withholds a genuinely-produced signature: no signed CBOR anywhere in the response', async () => {
    const server = await spawnSigner({
      // Mirrors audit.test.ts's own proven approach: a parent directory that
      // does not exist makes writeFileSync fail with ENOENT, deterministically
      // and cross-platform, without needing OS-specific permission tricks.
      auditLogPath: (dir) => join(dir, 'no-such-subdirectory', 'audit.json'),
    });
    try {
      const tx = buildInPolicyTxCbor(TEST_IDENTITY.address);
      const result = await callToolText(server.client, 'vector_signer_sign', { txCbor: tx });

      assert.ok(!/Signed CBOR/i.test(result), 'a signature must never be returned when its audit record failed to write');
      assert.ok(!/```/.test(result), 'no fenced code block — where signed CBOR would appear — should be present at all');
      assert.match(result, /REFUSED/, 'the caller must get an unambiguous, non-signed response');
      assert.match(result, /produced/i, 'the response should be honest that a real signature WAS produced');
      assert.match(
        result,
        /(withheld|not been released)/i,
        'the response should say the signature is being withheld, not silently dropped'
      );
    } finally {
      await stopSigner(server);
    }
  });

  test('after a withheld signature, this process still counts it toward committed-today (conservative over-count, never an under-count)', async () => {
    // AuditLog.append() pushes the entry into its own in-memory array BEFORE
    // attempting the write (audit.ts's own comment explains why: so THIS
    // process's accounting does not under-count even when the write fails).
    // tools.ts has no way to "unpush" that entry, and should not try to -
    // over-counting a withheld signature against this process's own
    // remaining daily budget is the safe direction, matching every other
    // fail-closed choice in this package. Pinned here as a deliberate,
    // understood consequence rather than an accidental surprise.
    const server = await spawnSigner({
      auditLogPath: (dir) => join(dir, 'no-such-subdirectory', 'audit.json'),
    });
    try {
      const tx = buildInPolicyTxCbor(TEST_IDENTITY.address, 200_000n, 5_000_000n);
      await callToolText(server.client, 'vector_signer_sign', { txCbor: tx });

      const limits = await callToolText(server.client, 'vector_signer_get_spend_limits');
      assert.match(
        limits,
        /Committed today:\s*0\.200000 AP3X/,
        'the fee from the withheld signature is still counted in this process memory, even though it was never released'
      );
    } finally {
      await stopSigner(server);
    }
  });
});

describe('a lower-stakes decision: an audit append failure on the REFUSED path', () => {
  // Funds do not move on a refusal either way, so this is lower stakes than
  // the signed case above — but a refusal whose own audit record silently
  // failed to write must not look like a normal, cleanly-recorded refusal to
  // the caller. Decision made here: still refuse (obviously — nothing about
  // an audit failure should ever cause a REFUSED decision to become
  // ALLOWED), still deliver the concrete policy reason, and additionally
  // disclose that the audit trail for this specific refusal is incomplete.

  test('still refuses with the concrete reason, and additionally flags that the refusal itself could not be recorded', async () => {
    const server = await spawnSigner({
      auditLogPath: (dir) => join(dir, 'no-such-subdirectory', 'audit.json'),
    });
    try {
      // FIXTURE_CBOR is refused for TEST_MNEMONIC unconditionally (~1000 AP3X
      // net outflow against a 100 AP3X per-transaction limit — see the note
      // above the brief's own "sign refuses..." test). No funds are at risk
      // either way; this test is about whether the CALLER is told the truth
      // about the state of the audit trail.
      const result = await callToolText(server.client, 'vector_signer_sign', { txCbor: FIXTURE_CBOR });

      assert.match(result, /REFUSED/);
      assert.match(
        result,
        /per-transaction limit/i,
        'the concrete policy reason must still reach the caller even when the audit write fails'
      );
      assert.ok(!/Signed CBOR/i.test(result));
      assert.match(result, /audit log/i);
      assert.match(result, /(could not|NOT).*record/i, 'must disclose that this specific refusal was not durably recorded');
    } finally {
      await stopSigner(server);
    }
  });

  test('committed-today is unaffected by a refusal whether or not the audit write succeeds', async () => {
    const server = await spawnSigner({
      auditLogPath: (dir) => join(dir, 'no-such-subdirectory', 'audit.json'),
    });
    try {
      await callToolText(server.client, 'vector_signer_sign', { txCbor: FIXTURE_CBOR });
      const limits = await callToolText(server.client, 'vector_signer_get_spend_limits');
      assert.match(limits, /Committed today:\s*0\.000000 AP3X/);
    } finally {
      await stopSigner(server);
    }
  });
});
