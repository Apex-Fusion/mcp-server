import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { walletFromSeed } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, getMnemonic, wait, ServerContext } from '../setup.ts';
import { signWithMnemonic } from './sign-helper.ts';

// FULL SELF-IMPROVEMENT LIFECYCLE ON LIVE TESTNET - gated. Registers a fresh
// research agent, locks then spends a real improvement proposal through the
// deployed module validator (the two-step keyless flow spec PR 8
// introduced - the first ever keyless-built validated submit to clear it),
// critiques and endorses that proposal, then deregisters the agent.
// One-way cost: 25 (proposal stake) + 2 (proposal module min) + 2 (activity
// token output) + 10 (critique stake) + 2 (critique module min) + 5 (endorse
// stake) + 2 (endorse module min) = 48 AP3X, plus 6 transaction fees. The
// 10 AP3X registration deposit round-trips (excluded from the 48).
// Requires packages/builder/mnemonic.txt (never committed).
//   VECTOR_E2E_SUBMIT=1 node --import tsx --test packages/builder/test/integration/self-improvement-e2e.test.ts
const GATE = process.env.VECTOR_E2E_SUBMIT === '1';

function explorerTxLink(hash: string): string {
  return `https://vector.testnet.apexscan.org/transaction/${hash}`;
}
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

(GATE ? describe : describe.skip)('self-improvement lifecycle E2E (live testnet, SUBMITS)', () => {
  let ctx: ServerContext;
  let mnemonic: string;
  let walletAddress: string;
  // The self-improvement family's "agentDid" wire param is the trailing hex
  // asset-name segment only, NOT the full did:vector:agent:{policyId}:
  // {nftAssetName} string the registry family's agent_id means (see
  // self-improvement-keyless.test.ts's discovery-test comment for the full
  // finding). Both forms are needed here: agentFullDid for the registry
  // family's build_register_agent/build_deregister_agent calls (agent_id),
  // agentAssetName for every self-improvement build_* call (agentDid).
  let agentFullDid: string;
  let agentAssetName: string;
  let lockTxHash: string;
  let proposalTxHash: string; // == the confirmed spend tx hash (the tool's own copy: "use THIS transaction's hash as proposalTxHash")
  let critiqueTxHash: string;
  let endorseTxHash: string;
  let balanceBeforeApex = 0;
  let balanceAfterApex = 0;
  const txLog: Array<{ label: string; hash: string }> = [];

  before(async () => {
    ctx = await startServer();
    mnemonic = getMnemonic();
    walletAddress = walletFromSeed(mnemonic, { network: 'Mainnet', accountIndex: 0 }).address;
  });
  after(async () => { await stopServer(ctx); });

  async function getBalanceApex(): Promise<number> {
    const text = await callTool(ctx.client, 'vector_get_balance', { address: walletAddress });
    const m = text.match(/AP3X Balance:\s*([\d.]+)/);
    assert.ok(m, `could not parse balance:\n${text.slice(0, 300)}`);
    return parseFloat(m![1]);
  }

  // build_* (already built by the caller) -> sign locally -> submit -> await
  // confirmation. Hard-asserts throughout (no known-error tolerance): this
  // suite runs once, deliberately, against a wallet already verified funded
  // (~982 AP3X per the plan's recon), so every step is expected to succeed.
  async function signSubmitAwait(buildText: string, label: string): Promise<string> {
    const { signedCborHex, txHash } = signWithMnemonic(extractCbor(buildText), mnemonic);
    const submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signedCborHex });
    const submittedHash = extractTxHash(submitText);
    assert.equal(submittedHash, txHash, `${label}: submitted hash != locally computed hash`);
    const awaitText = await callTool(ctx.client, 'vector_await_transaction', { txHash: submittedHash, timeoutSeconds: 240 });
    assert.match(awaitText, /Transaction Confirmed/, `${label}: did not confirm - ${awaitText.slice(0, 300)}`);
    txLog.push({ label, hash: submittedHash });
    console.log(`  [tx] ${label}: ${submittedHash}  (${explorerTxLink(submittedHash)})`);
    return submittedHash;
  }

  test('record starting wallet balance', { timeout: 60_000 }, async () => {
    balanceBeforeApex = await getBalanceApex();
    console.log(`Starting balance: ${balanceBeforeApex} AP3X`);
  });

  test('register a fresh research agent -> confirm -> DID', { timeout: 420_000 }, async () => {
    const buildText = await callTool(ctx.client, 'vector_build_register_agent', {
      changeAddress: walletAddress, name: `SelfImprovementE2E-${Date.now()}`,
      description: 'self-improvement lifecycle e2e research agent', capabilities: ['research', 'data-extraction'], framework: 'custom', endpoint: '',
    });
    const didMatch = buildText.match(/did:vector:agent:([a-f0-9]+):([a-f0-9]+)/);
    assert.ok(didMatch, `no DID in register build:\n${buildText.slice(0, 500)}`);
    agentFullDid = didMatch![0];
    agentAssetName = didMatch![2];
    await signSubmitAwait(buildText, 'register agent');
    console.log(`Registered agent ${agentFullDid}`);
  });

  test('proposal lock (step 1 of 2) -> confirm', { timeout: 420_000 }, async () => {
    await wait(10); // let register's UTxOs settle
    const buildText = await callTool(ctx.client, 'vector_build_self_improvement_proposal_lock', {
      changeAddress: walletAddress, agentDid: agentAssetName,
      proposalType: 'GeneralSuggestion', stakeApex: 25,
      proposalHash: randomBytes(32).toString('hex'), storageUri: 'ipfs://e2e-proposal-doc',
    });
    assert.match(buildText, /step 1 of 2/);
    lockTxHash = await signSubmitAwait(buildText, 'proposal lock');
  });

  test('proposal spend (step 2 of 2) -> confirm -- THE MONEY ASSERTION', { timeout: 420_000 }, async () => {
    await wait(10); // let the lock tx settle so proposal_spend's getUtxosByOutRef can find it (this wait happens BEFORE the 6-min signing clock starts - it does not eat into the deadline below)

    async function buildSpend(): Promise<{ text: string; validTo: string }> {
      const text = await callTool(ctx.client, 'vector_build_self_improvement_proposal_spend', {
        changeAddress: walletAddress, agentDid: agentAssetName, lockTxHash,
      });
      const m = text.match(/[Vv]alid until (.*Z)/);
      assert.ok(m, `no signing deadline in spend build:\n${text.slice(0, 500)}`);
      const validTo = m[1];
      assert.ok(new Date(validTo).getTime() - Date.now() > 120_000, 'deadline must be meaningfully in the future');
      return { text, validTo };
    }

    // Sign+submit IMMEDIATELY after build - the deployed module gives a
    // ~6-minute validity window (buildProposalSpend's validToMs) before the
    // signature deadline passes. The live submit-failure error shape for a
    // window-expiry rejection isn't known ahead of time, so any submit
    // failure on the first attempt triggers the ONE documented rebuild retry
    // (per the plan); if that retry also fails, the real error propagates
    // (fail loud, never swallowed).
    let { text: spendBuildText, validTo } = await buildSpend();
    console.log(`Proposal spend built, valid until ${validTo}`);
    let signed = signWithMnemonic(extractCbor(spendBuildText), mnemonic);
    let submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signed.signedCborHex });

    if (!/Transaction Submitted/.test(submitText)) {
      console.log(`First proposal-spend submit did not report success - rebuilding ONCE (the documented recovery path for a possible signing-window expiry):\n${submitText.slice(0, 500)}`);
      ({ text: spendBuildText, validTo } = await buildSpend());
      console.log(`Proposal spend rebuilt, valid until ${validTo}`);
      signed = signWithMnemonic(extractCbor(spendBuildText), mnemonic);
      submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signed.signedCborHex });
      assert.match(submitText, /Transaction Submitted/, `proposal-spend submit failed even after the one documented rebuild retry - failing loud: ${submitText.slice(0, 500)}`);
    }
    const submittedHash = extractTxHash(submitText);
    assert.equal(submittedHash, signed.txHash, 'submitted hash != locally computed hash');
    txLog.push({ label: 'proposal spend', hash: submittedHash });
    console.log(`  [tx] proposal spend: ${submittedHash}  (${explorerTxLink(submittedHash)})`);

    const awaitText = await callTool(ctx.client, 'vector_await_transaction', { txHash: submittedHash, timeoutSeconds: 240 });
    assert.match(awaitText, /Transaction Confirmed/, `proposal spend did not confirm: ${awaitText.slice(0, 300)}`);

    proposalTxHash = submittedHash;
    console.log(`*** THE MONEY ASSERTION: proposal spend confirmed on-chain (tx ${proposalTxHash}) - the deployed self-improvement module validator accepted a keyless-built, validated submit (script spend + CIP-33 reference scripts + dual mint). The first one ever. ***`);
  });

  test('the proposal appears on-chain, filtered by our DID, state Open', { timeout: 120_000 }, async () => {
    await wait(5);
    const text = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'proposals', proposerDid: agentAssetName });
    assert.match(text, /GeneralSuggestion Proposal \(Open\)/, `expected our Open GeneralSuggestion proposal:\n${text.slice(0, 800)}`);
    assert.ok(text.includes(`${proposalTxHash}#0`), `expected the continuing proposal UTxO ${proposalTxHash}#0 in the browse response:\n${text.slice(0, 800)}`);
  });

  test('critique (Supportive, stake 10) -> confirm -> visible via browse', { timeout: 420_000 }, async () => {
    await wait(5);
    const buildText = await callTool(ctx.client, 'vector_build_self_improvement_critique', {
      changeAddress: walletAddress, agentDid: agentAssetName, proposalTxHash, proposalOutputIndex: 0,
      critiqueType: 'Supportive', stakeApex: 10, critiqueHash: randomBytes(32).toString('hex'), storageUri: 'ipfs://e2e-critique-doc',
    });
    critiqueTxHash = await signSubmitAwait(buildText, 'critique');
    await wait(5);
    const browseText = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'critiques', proposalTxHash });
    assert.match(browseText, /# Critiques \([1-9]\d* found\)/, `expected a non-zero critique count in the browse header:\n${browseText.slice(0, 300)}`);
    assert.match(browseText, /Supportive Critique/, `expected our critique in the browse response:\n${browseText.slice(0, 800)}`);
    assert.match(browseText, new RegExp(`${critiqueTxHash}#\\d+`), `expected our critique's own UTxO in the browse response:\n${browseText.slice(0, 800)}`);
  });

  test('endorse (stake 5) -> confirm -> visible via browse', { timeout: 420_000 }, async () => {
    await wait(5);
    const buildText = await callTool(ctx.client, 'vector_build_self_improvement_endorse', {
      changeAddress: walletAddress, agentDid: agentAssetName, proposalTxHash, proposalOutputIndex: 0,
      stakeApex: 5,
    });
    endorseTxHash = await signSubmitAwait(buildText, 'endorse');
    await wait(5);
    const browseText = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'endorsements', proposalTxHash });
    assert.match(browseText, /# Endorsements \([1-9]\d* found\)/, `expected a non-zero endorsement count in the browse header:\n${browseText.slice(0, 300)}`);
    assert.match(browseText, /Endorsement/, `expected our endorsement in the browse response:\n${browseText.slice(0, 800)}`);
    assert.match(browseText, new RegExp(`${endorseTxHash}#\\d+`), `expected our endorsement's own UTxO in the browse response:\n${browseText.slice(0, 800)}`);
  });

  // Known/accepted risk, same shape as run.test.ts's Agent Network Tools
  // section: if an earlier step in this chain fails before this one runs,
  // the agent's 10 AP3X deposit stays locked on-chain - nothing in this file
  // reclaims it automatically.
  test('deregister the agent -> confirm -> deposit returned', { timeout: 420_000 }, async () => {
    await wait(10);
    const buildText = await callTool(ctx.client, 'vector_build_deregister_agent', {
      changeAddress: walletAddress, agent_id: agentFullDid,
    });
    assert.match(buildText, /Deposit returned on confirmation/);
    await signSubmitAwait(buildText, 'deregister agent');
  });

  test('final balance reconciles to the expected one-way spend + evidence summary', { timeout: 60_000 }, async () => {
    await wait(5);
    balanceAfterApex = await getBalanceApex();
    const delta = balanceBeforeApex - balanceAfterApex;

    console.log('\n=== Self-improvement lifecycle E2E evidence ===');
    console.log(`  agent DID:        ${agentFullDid}`);
    for (const { label, hash } of txLog) {
      console.log(`  ${label.padEnd(16)} ${hash}  ${explorerTxLink(hash)}`);
    }
    console.log(`  Balance before:   ${balanceBeforeApex.toFixed(6)} AP3X`);
    console.log(`  Balance after:    ${balanceAfterApex.toFixed(6)} AP3X`);
    console.log(`  Delta (one-way):  ${delta.toFixed(6)} AP3X`);
    console.log('  Expected one-way: 25 (proposal stake) + 2 (proposal module min) + 2 (activity token output)');
    console.log('                    + 10 (critique stake) + 2 (critique module min) + 5 (endorse stake)');
    console.log('                    + 2 (endorse module min) = 48 AP3X, plus 6 transaction fees.');
    console.log('                    The 10 AP3X registration deposit round-trips (excluded from the 48).');

    // Sanity bound, not a fee-exact pin (protocol fees vary per tx shape):
    // wide enough to tolerate normal fee variance across 6 txs (~1-3 AP3X),
    // tight enough to catch a gross error (a dropped deposit refund or a
    // duplicated stake would blow well past either bound).
    assert.ok(delta > 47 && delta < 54, `expected the wallet down roughly 48-53 AP3X (stakes + module minimums + 6 tx fees), got ${delta.toFixed(6)}`);
  });
});
