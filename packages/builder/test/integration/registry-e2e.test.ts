import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CML, walletFromSeed } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, getMnemonic, wait, ServerContext } from '../setup.ts';
import { signWithMnemonic } from './sign-helper.ts';

// FULL IDENTITY REGISTRY LIFECYCLE ON A LIVE NETWORK - gated twice: VECTOR_E2E_SUBMIT=1 and an identity deployment
// (VECTOR_IDENTITY_LEGACY_ROOT, VECTOR_IDENTITY_CONFIG_SEED, VECTOR_IDENTITY_REF_UTXO) in the environment of the server.
// Registers a record whose controller and Accountable Party is the test wallet's key, updates its description, retires it and
// reclaims the deposit down to the ledger minimum. Net cost ~= 4 tx fees plus the ledger minimum that the tombstone keeps.
// Requires packages/builder/mnemonic.txt (never committed). The legacy registry lifecycle that this suite ran before is retired
// with the legacy registry writes (Part 2 Section 10).
//   VECTOR_E2E_SUBMIT=1 VECTOR_IDENTITY_... node --import tsx --test packages/builder/test/integration/registry-e2e.test.ts
const GATE = process.env.VECTOR_E2E_SUBMIT === '1' && Boolean(process.env.VECTOR_IDENTITY_LEGACY_ROOT?.trim());

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

(GATE ? describe : describe.skip)('identity registry lifecycle E2E (live network, SUBMITS)', () => {
  let ctx: ServerContext;
  let mnemonic: string;
  let walletAddress: string;
  let publicKey: string;
  let did: string;

  before(async () => {
    ctx = await startServer();
    mnemonic = getMnemonic();
    const wallet = walletFromSeed(mnemonic, { network: 'Mainnet', accountIndex: 0 });
    walletAddress = wallet.address;
    publicKey = Buffer.from(CML.PrivateKey.from_bech32(wallet.paymentKey).to_public().to_raw_bytes()).toString('hex');
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

  test('register -> confirm', { timeout: 420_000 }, async () => {
    const buildText = await callTool(ctx.client, 'vector_build_identity_register', {
      changeAddress: walletAddress, controller: publicKey, name: `E2EAgent-${Date.now()}`, description: 'identity e2e lifecycle agent',
      capabilities: ['testing'], parties: [{ role: 'Accountable', signer: 'controller' }],
    });
    const didMatch = buildText.match(/(did:vector:[0-9a-f]{64})/);
    assert.ok(didMatch, `no DID in the register build:\n${buildText.slice(0, 500)}`);
    did = didMatch![1];
    await signSubmitAwait(buildText);
  });

  test('update the description -> confirm', { timeout: 420_000 }, async () => {
    await wait(10);
    const buildText = await callTool(ctx.client, 'vector_build_identity_update', { changeAddress: walletAddress, did, description: 'updated by the identity e2e' });
    await signSubmitAwait(buildText);
  });

  test('retire -> confirm', { timeout: 420_000 }, async () => {
    await wait(10);
    const buildText = await callTool(ctx.client, 'vector_build_identity_retire', { changeAddress: walletAddress, did });
    await signSubmitAwait(buildText);
  });

  test('reclaim the deposit -> confirm', { timeout: 420_000 }, async () => {
    await wait(10);
    const buildText = await callTool(ctx.client, 'vector_build_identity_reclaim', { changeAddress: walletAddress, did });
    await signSubmitAwait(buildText);
  });
});
