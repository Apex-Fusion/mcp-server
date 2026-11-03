import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { walletFromSeed } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, getMnemonic, wait, ServerContext } from '../setup.ts';
import { signWithMnemonic } from './sign-helper.ts';

// SELF-IMPROVEMENT LIFECYCLE ON A LIVE NETWORK (Module-6 on the identity registry) - gated three times: VECTOR_E2E_SUBMIT=1, the
// GOV_* and VECTOR_IDENTITY_* settings in the environment of the server, and VECTOR_E2E_AGENT_DID: an agent whose record is Active
// and whose controller is the test wallet's key (vector_build_identity_register with controller = vector_signer_get_public_key). The
// wallet key is then the declared credential, so one signature covers each step. It locks and submits a proposal (the first
// submission inserts the agent's node into the activity list), then locks and creates an Amendment critique of its own proposal (the
// only critique that the proposer may write). An endorsement needs another party (another controller key), so it is not covered here.
// One-way cost: 25 + 2 (proposal) + 2 (activity node) + 10 + 2 (critique) = 41 AP3X, plus 4 transaction fees.
// Requires packages/builder/mnemonic.txt (never committed).
//   VECTOR_E2E_SUBMIT=1 VECTOR_E2E_AGENT_DID=did:vector:... GOV_... VECTOR_IDENTITY_... node --import tsx --test packages/builder/test/integration/self-improvement-e2e.test.ts
const AGENT_DID = process.env.VECTOR_E2E_AGENT_DID?.trim();
const GATE = process.env.VECTOR_E2E_SUBMIT === '1' && Boolean(AGENT_DID) && Boolean(process.env.GOV_PROPOSAL_SPEND_HASH?.trim());

function extractCbor(text: string): string {
  const m = text.match(/```\n([0-9a-f]+)\n```/);
  assert.ok(m, `no CBOR block:\n${text.slice(0, 500)}`);
  return m![1];
}
const jsonOf = (text: string): Record<string, unknown> => JSON.parse(text.slice(text.lastIndexOf('```json\n') + 8, text.lastIndexOf('\n```')));

(GATE ? describe : describe.skip)('self-improvement lifecycle E2E (live network, SUBMITS)', () => {
  let ctx: ServerContext;
  let mnemonic: string;
  let walletAddress: string;
  let seed: string;

  before(async () => {
    ctx = await startServer();
    mnemonic = getMnemonic();
    walletAddress = walletFromSeed(mnemonic, { network: 'Mainnet', accountIndex: 0 }).address;
  });
  after(async () => { await stopServer(ctx); });

  async function signSubmitAwait(buildText: string): Promise<string> {
    const { signedCborHex, txHash } = signWithMnemonic(extractCbor(buildText), mnemonic);
    const submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signedCborHex });
    assert.match(submitText, /Transaction Submitted/, submitText.slice(0, 300));
    const awaitText = await callTool(ctx.client, 'vector_await_transaction', { txHash, timeoutSeconds: 240 });
    assert.match(awaitText, /Transaction Confirmed/);
    return txHash;
  }

  test('proposal: lock (step 1) -> confirm -> submission (step 2) -> confirm', { timeout: 900_000 }, async () => {
    const lock = await callTool(ctx.client, 'vector_build_self_improvement_proposal_lock', {
      changeAddress: walletAddress, agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
      proposalHash: randomBytes(32).toString('hex'), storageUri: 'ipfs://e2e-proposal-doc',
    });
    const lockTx = await signSubmitAwait(lock);
    await wait(10);
    const spend = await callTool(ctx.client, 'vector_build_self_improvement_proposal_spend', {
      changeAddress: walletAddress, agentDid: AGENT_DID, lockTxHash: lockTx, lockOutputIndex: jsonOf(lock).lock_output_index,
    });
    seed = String(jsonOf(spend).seed);
    await signSubmitAwait(spend);
  });

  test('the proposal appears on-chain, by the agent DID, state Open', { timeout: 120_000 }, async () => {
    await wait(10);
    const text = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'proposals', proposerDid: AGENT_DID });
    assert.match(text, /\(Open\)/);
  });

  test('an Amendment critique of its own proposal: lock -> confirm -> creation -> confirm', { timeout: 900_000 }, async () => {
    const [txHash, index] = seed.split('#');
    const lock = await callTool(ctx.client, 'vector_build_self_improvement_critique', {
      changeAddress: walletAddress, agentDid: AGENT_DID, proposalTxHash: txHash, proposalOutputIndex: Number(index), critiqueType: 'Amendment',
      stakeApex: 10, critiqueHash: randomBytes(32).toString('hex'), storageUri: 'ipfs://e2e-critique-doc',
    });
    const lockTx = await signSubmitAwait(lock);
    await wait(10);
    const create = await callTool(ctx.client, 'vector_build_self_improvement_critique_spend', {
      changeAddress: walletAddress, agentDid: AGENT_DID, lockTxHash: lockTx, lockOutputIndex: jsonOf(lock).lock_output_index,
    });
    await signSubmitAwait(create);
  });
});
