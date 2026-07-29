import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, callTool, getMnemonic, wait, ServerContext } from '../setup.ts';
import { signWithMnemonic } from './sign-helper.ts';
import { walletFromSeed } from '@lucid-evolution/lucid';

// FULL REGISTRY LIFECYCLE ON LIVE TESTNET - gated. Registers a real agent,
// updates it, deregisters it. Net cost ~= 3 tx fees (~0.6 AP3X); the 10 AP3X
// deposit round-trips. Requires packages/builder/mnemonic.txt (never committed).
//   VECTOR_E2E_SUBMIT=1 node --import tsx --test packages/builder/test/integration/registry-e2e.test.ts
const GATE = process.env.VECTOR_E2E_SUBMIT === '1';

function extractCbor(text: string): string {
  const m = text.match(/```\n([0-9a-f]+)\n```/);
  assert.ok(m, `no CBOR block:\n${text.slice(0, 500)}`);
  return m![1];
}
function extractTxHash(text: string): string {
  const m = text.match(/Transaction Hash:\s*([0-9a-f]{64})/);
  assert.ok(m, `no tx hash:\n${text.slice(0, 500)}`);
  return m![1];
}

(GATE ? describe : describe.skip)('registry lifecycle E2E (live testnet, SUBMITS)', () => {
  let ctx: ServerContext;
  let mnemonic: string;
  let walletAddress: string;
  let agentDid: string;

  before(async () => {
    ctx = await startServer();
    mnemonic = getMnemonic();
    walletAddress = walletFromSeed(mnemonic, { network: 'Mainnet', accountIndex: 0 }).address;
  });
  after(async () => { await stopServer(ctx); });

  async function signSubmitAwait(buildText: string): Promise<string> {
    const { signedCborHex, txHash } = signWithMnemonic(extractCbor(buildText), mnemonic);
    const submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signedCborHex });
    const submittedHash = extractTxHash(submitText);
    assert.equal(submittedHash, txHash, 'submitted hash != locally computed hash');
    const awaitText = await callTool(ctx.client, 'vector_await_transaction', { txHash: submittedHash, timeoutSeconds: 240 });
    assert.match(awaitText, /Transaction Confirmed/);
    return submittedHash;
  }

  test('register -> confirm -> profile readable', { timeout: 420_000 }, async () => {
    const buildText = await callTool(ctx.client, 'vector_build_register_agent', {
      changeAddress: walletAddress, name: `E2EAgent-${Date.now()}`,
      description: 'registry e2e lifecycle agent', capabilities: ['testing', 'e2e'], framework: 'custom', endpoint: '',
    });
    const didMatch = buildText.match(/(did:vector:agent:[a-f0-9]+:[a-f0-9]+)/);
    assert.ok(didMatch, 'no DID in register build');
    agentDid = didMatch![1];
    await signSubmitAwait(buildText);
    await wait(5);
    const profile = await callTool(ctx.client, 'vector_get_agent_profile', { agent_id: agentDid });
    assert.match(profile, /registry e2e lifecycle agent/);
  });

  test('update -> confirm -> profile shows the change', { timeout: 420_000 }, async () => {
    await wait(10); // let register's UTxOs settle
    const buildText = await callTool(ctx.client, 'vector_build_update_agent', {
      changeAddress: walletAddress, agent_id: agentDid, description: 'updated by registry e2e',
    });
    await signSubmitAwait(buildText);
    await wait(5);
    const profile = await callTool(ctx.client, 'vector_get_agent_profile', { agent_id: agentDid });
    assert.match(profile, /updated by registry e2e/);
  });

  test('deregister -> confirm -> agent gone', { timeout: 420_000 }, async () => {
    await wait(10);
    const buildText = await callTool(ctx.client, 'vector_build_deregister_agent', {
      changeAddress: walletAddress, agent_id: agentDid,
    });
    assert.match(buildText, /Deposit returned on confirmation/);
    await signSubmitAwait(buildText);
    await wait(5);
    const profile = await callTool(ctx.client, 'vector_get_agent_profile', { agent_id: agentDid });
    assert.match(profile, /Agent not found|Failed to get agent profile/);
  });
});
