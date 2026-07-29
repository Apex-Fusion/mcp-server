// packages/builder/test/integration/keyless-e2e.test.ts
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { walletFromSeed } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, getMnemonic, ServerContext } from '../setup.ts';
import { signWithMnemonic } from './sign-helper.ts';

// Full non-custodial pipeline against the live testnet:
//   keyless build (hosted tool) -> inline CML sign (this process, standing in
//   for the in-tree local signer (packages/signer) — same CML primitives,
//   without the signer's decode/policy/audit path) -> submit tool -> await
//   tool. A self-send, so the run costs only the fee (~0.16 AP3X).
//
// Gated: set VECTOR_E2E_SUBMIT=1 to run. Requires packages/builder/mnemonic.txt
// (the funded testnet wallet). NEVER runs in CI.
const RUN = process.env.VECTOR_E2E_SUBMIT === '1';

function extractCbor(text: string): string {
  const m = text.match(/```\n([0-9a-fA-F]+)\n```/);
  assert.ok(m, `no CBOR block in tool response:\n${text.slice(0, 500)}`);
  return m[1];
}
function extractTxHash(text: string): string {
  const m = text.match(/Transaction Hash: ([0-9a-f]{64})/);
  assert.ok(m, `no tx hash in tool response:\n${text.slice(0, 500)}`);
  return m[1];
}

describe('keyless E2E: build -> sign -> submit -> await', { skip: !RUN }, () => {
  let ctx: ServerContext;
  before(async () => { ctx = await startServer(); });
  after(async () => { await stopServer(ctx); });

  test('the four-call non-custodial flow lands a self-send on-chain', { timeout: 300_000 }, async () => {
    const mnemonic = getMnemonic();
    const { address } = walletFromSeed(mnemonic, { network: 'Mainnet', accountIndex: 0 });

    // 1. keyless build (hosted)
    const buildText = await callTool(ctx.client, 'vector_build_send_apex', {
      changeAddress: address, recipientAddress: address, amount: 3,
    });
    const unsignedCbor = extractCbor(buildText);

    // 2. sign locally (stand-in for vector_signer_sign)
    const { signedCborHex: signedCbor, txHash } = signWithMnemonic(unsignedCbor, mnemonic);

    // 3. submit (hosted)
    const submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signedCbor });
    const submittedHash = extractTxHash(submitText);
    assert.equal(submittedHash, txHash, 'submitted hash differs from the locally computed body hash');

    // 4. await confirmation (hosted)
    const awaitText = await callTool(ctx.client, 'vector_await_transaction', {
      txHash: submittedHash, timeoutSeconds: 240,
    });
    assert.match(awaitText, /Transaction Confirmed/);
  });
});
