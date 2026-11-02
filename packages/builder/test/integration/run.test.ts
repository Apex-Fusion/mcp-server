import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { walletFromSeed, getAddressDetails } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, getMnemonic, wait, ServerContext } from '../setup.ts';
import { signWithMnemonic } from './sign-helper.ts';
import { ownedLegacyAgentDid } from './legacy-agent.ts';

// Always-succeeds PlutusV2 validator (accepts any datum/redeemer/context, returns True)
const ALWAYS_SUCCEEDS_V2 = '49480100002221200101';

let ctx: ServerContext;
let mnemonic: string;
let walletAddress: string;
let walletHasAda = false;
let agentDid: string | null = null;

before(async () => {
  mnemonic = getMnemonic();
  // The keyless build tools take an address, not a mnemonic - derive it once
  // up front instead of scraping it out of a vector_get_address response
  // (that tool is gone; the signer owns address derivation from PR 7 on).
  walletAddress = walletFromSeed(mnemonic, { network: 'Mainnet', accountIndex: 0 }).address;
  console.log('Starting MCP server...');
  ctx = await startServer();
  console.log(`MCP server running on port ${ctx.port}`);
});

after(async () => {
  console.log('Stopping MCP server...');
  await stopServer(ctx);
});

// Helper: assert tool returned a non-empty response (didn't crash)
function assertResponded(text: string, toolName: string) {
  assert.ok(text.length > 0, `${toolName} should return a non-empty response`);
  assert.ok(!text.includes('Rate limit exceeded'), `${toolName} should not be rate limited`);
}

// Helper: assert tool succeeded (for funded wallet) or returned a known error (unfunded)
function assertSuccessOrKnownError(text: string, successPattern: RegExp, toolName: string) {
  assertResponded(text, toolName);
  const isSuccess = successPattern.test(text);
  const isKnownError = text.includes('Failed') || text.includes('Credential-based UTxO')
    || text.includes('insufficient') || text.includes('No UTxOs in wallet')
    || text.includes('Dry run failed') || text.includes('No variant matched');
  assert.ok(
    isSuccess || isKnownError,
    `${toolName}: expected success or known error, got: ${text.substring(0, 200)}`
  );
  if (isSuccess) console.log(`  ✓ ${toolName} succeeded`);
  else console.log(`  ⚠ ${toolName} returned known error (wallet may be unfunded)`);
}

// ─── Wallet Tools ───────────────────────────────────────────────────────────

describe('Wallet Tools', () => {
  // vector_get_address is gone (the signer owns address derivation from PR 7
  // on) - walletAddress now comes from walletFromSeed in before(). This test
  // takes over its funded/unfunded bookkeeping via the keyless balance tool.
  test('vector_get_balance', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_get_balance', { address: walletAddress });
    console.log(text);
    assert.match(text, /AP3X Balance:/, 'Should show AP3X balance');
    assert.ok(text.includes(walletAddress), 'Should contain the queried address');

    // Check if wallet is funded
    const balanceMatch = text.match(/AP3X Balance:\s*([\d.]+)/);
    if (balanceMatch && parseFloat(balanceMatch[1]) > 0) {
      walletHasAda = true;
      console.log(`Wallet funded: ${balanceMatch[1]} AP3X`);
    } else {
      console.log('Wallet has 0 AP3X - transaction tests will verify error handling');
    }
  });

  test('vector_get_utxos', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_get_utxos', { address: walletAddress });
    console.log(text);
    assert.ok(
      text.includes('Total:') || text.includes('No UTxOs found'),
      'Should show UTxO count or no-UTxO message'
    );
  });
});

// ─── History & Limits ───────────────────────────────────────────────────────

describe('History & Limits', () => {
  // vector_get_spend_limits is gone (the signer owns spend limits from PR 7 on).

  test('vector_get_transaction_history', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_get_transaction_history', { address: walletAddress, limit: 5 });
    console.log(text);
    assert.ok(
      text.includes('Transaction History') || text.includes('No transactions found')
        || text.includes('Failed to get transaction history'),
      'Should show history, no-transactions message, or error'
    );
  });
});

// ─── UTxO Consolidation ─────────────────────────────────────────────────────
// Removed: consolidation only had a reason to exist because vector_send_apex
// could submit. The keyless build_* tools never submit (vector_send_apex and
// vector_send_tokens are gone outright), so there is no longer a way for this
// package to land a real consolidating transaction on its own - that becomes
// the local signer's concern once it drives the four-call non-custodial flow.
// Fragmentation-tolerance for the build/dry-run tests below is covered the
// same way every other wallet-state-dependent assertion in this file is:
// assertSuccessOrKnownError treats "Failed to build ..." as an acceptable
// known outcome, not a hard failure.

// ─── Transaction Tools ──────────────────────────────────────────────────────

describe('Transaction Tools', () => {
  test('vector_dry_run', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    const text = await callTool(ctx.client, 'vector_dry_run', {
      outputs: [{ address: walletAddress, lovelace: 2_000_000 }],
      changeAddress: walletAddress,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Valid:.*\nEstimated Fee:/, 'vector_dry_run');
  });

  test('vector_build_transaction', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    const text = await callTool(ctx.client, 'vector_build_transaction', {
      outputs: [{ address: walletAddress, lovelace: 2_000_000 }],
      changeAddress: walletAddress,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /CBOR/, 'vector_build_transaction');
  });

  // vector_build_transaction (submit) is gone: the tool no longer submits at
  // all (no submit param exists on it anymore) - keyless-e2e.test.ts is the
  // suite that now covers the build -> sign -> submit -> await pipeline.

  test('vector_build_send_apex', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    // Wait for previous tx UTxOs to settle
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_build_send_apex', {
      changeAddress: walletAddress,
      recipientAddress: walletAddress,
      amount: 2,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Unsigned TX CBOR:/, 'vector_build_send_apex');
  });

  test('vector_build_send_tokens', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    // Wait for send_apex UTxOs to settle
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_build_send_tokens', {
      changeAddress: walletAddress,
      recipientAddress: walletAddress,
      policyId: 'a'.repeat(56),
      assetName: 'test',
      amount: '1',
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Unsigned TX CBOR:/, 'vector_build_send_tokens');
  });
});

// ─── Smart Contract Tools ───────────────────────────────────────────────────

describe('Smart Contract Tools', () => {
  test('vector_build_deploy_contract', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before deploy...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_build_deploy_contract', {
      scriptCbor: ALWAYS_SUCCEEDS_V2,
      scriptType: 'PlutusV2',
      changeAddress: walletAddress,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Unsigned TX CBOR:/, 'vector_build_deploy_contract');
  });

  test('vector_build_interact_contract (lock)', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for deploy tx to confirm...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_build_interact_contract', {
      scriptCbor: ALWAYS_SUCCEEDS_V2,
      scriptType: 'PlutusV2',
      action: 'lock',
      changeAddress: walletAddress,
      datum: 'd87980',
      lovelaceAmount: 2_000_000,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Unsigned TX CBOR:/, 'vector_build_interact_contract (lock)');
  });

  test('vector_build_interact_contract (spend)', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for lock tx to confirm...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_build_interact_contract', {
      scriptCbor: ALWAYS_SUCCEEDS_V2,
      scriptType: 'PlutusV2',
      action: 'spend',
      changeAddress: walletAddress,
      redeemer: 'd87980',
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Unsigned TX CBOR:/, 'vector_build_interact_contract (spend)');
  });
});

// ─── Agent Network Tools ────────────────────────────────────────────────────
// Keyless since spec PR 7: each old custodial call (mnemonic in, submitted
// on-chain out, all inside one tool call) is now build_* (hosted, unsigned)
// -> signWithMnemonic (local, stands in for the local signer) ->
// vector_submit_transaction (hosted) - the same non-custodial flow the
// Transaction Tools tests above and keyless-e2e.test.ts already exercise.
// vector_discover_agents/vector_get_agent_profile are read-only and were
// never custodial - both unchanged (tool name and call shape). walletHasAda
// gating, the settle waits, and the assertSuccessOrKnownError convention are
// unchanged from the pre-keyless version of this section.
//
// Known/accepted risk, same shape as the pre-keyless suite: if register
// submits but a later step in this chain fails before deregister runs, the
// 10 AP3X deposit stays locked on-chain under this test agent - nothing in
// this file reclaims it automatically.

// Extracts the CBOR block a build_* tool response embeds ("```\n<hex>\n```"),
// or null if the build didn't produce one (a known-error response, e.g. an
// unfunded wallet) - lets callers skip signing/submitting instead of crashing
// on a missing match.
function extractCborOrNull(text: string): string | null {
  const m = text.match(/```\n([0-9a-f]+)\n```/);
  return m ? m[1] : null;
}

// build_* (hosted, unsigned) -> signWithMnemonic (local) ->
// vector_submit_transaction (hosted). Reuses assertSuccessOrKnownError at
// both legs: the build may legitimately fail a known way on an unfunded
// wallet (no sign/submit attempted then), and submit is only attempted once
// the build actually produced CBOR to sign. Returns the build response text
// (callers that need e.g. the registered DID parse it from there) plus
// whether the transaction was actually submitted, so callers only chain
// follow-on state (agentDid) off a real submission, not just a successful build.
async function buildSignSubmit(
  toolName: string, args: Record<string, unknown>, buildSuccessPattern: RegExp,
): Promise<{ buildText: string; submitted: boolean }> {
  const buildText = await callTool(ctx.client, toolName, args);
  console.log(buildText);
  assertSuccessOrKnownError(buildText, buildSuccessPattern, toolName);
  const cbor = extractCborOrNull(buildText);
  if (!buildSuccessPattern.test(buildText) || !cbor) {
    console.log(`  ⚠ ${toolName}: build did not succeed - skipping sign/submit`);
    return { buildText, submitted: false };
  }
  const { signedCborHex } = signWithMnemonic(cbor, mnemonic);
  const submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signedCborHex });
  console.log(submitText);
  // A successful build against a FUNDED wallet is expected to submit
  // successfully too - hard-assert here instead of the tolerant
  // assertSuccessOrKnownError, which would otherwise treat a real submit
  // regression (e.g. a signing defect - see task-5-report.md's Bug #1) as
  // an indistinguishable "known error, wallet may be unfunded" and let it
  // pass silently. Falls back to the graceful known-error path when the
  // wallet isn't funded (mirrors every other assertion in this file).
  if (walletHasAda) {
    assert.match(submitText, /Transaction Submitted/, `${toolName} (submit): expected success on a funded wallet, got: ${submitText.slice(0, 300)}`);
  } else {
    assertSuccessOrKnownError(submitText, /Transaction Submitted/, `${toolName} (submit)`);
  }
  return { buildText, submitted: /Transaction Submitted/.test(submitText) };
}

describe('Agent Network Tools', () => {
  // The legacy register, update and transfer tools are retired (Part 2 Section 10). The live suite reads a legacy agent that the
  // wallet owns (legacy-agent.ts) and builds, without submitting, its deregistration; the identity registry tools answer a build
  // when the server has an identity deployment, or say how to configure one.
  test('a legacy agent that the wallet owns, from the legacy registry', { timeout: 120_000 }, async () => {
    agentDid = await ownedLegacyAgentDid(getAddressDetails(walletAddress).paymentCredential!.hash);
    console.log(agentDid ? `Owned legacy agent DID: ${agentDid}` : 'The wallet owns no legacy record');
  });

  test('vector_build_identity_register (build only)', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_identity_register', {
      changeAddress: walletAddress, controller: 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
      name: `TestAgent-${Date.now()}`, parties: [{ role: 'Accountable', signer: 'controller' }],
    });
    console.log(text.slice(0, 500));
    assertSuccessOrKnownError(text, /Identity Registration Built|VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/, 'vector_build_identity_register');
  });

  test('vector_discover_agents (no mnemonic)', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_discover_agents', {});
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Discovery Results|No listed agents found/, 'vector_discover_agents');
  });

  test('vector_get_agent_profile', { timeout: 120_000 }, async () => {
    // Use a known DID format even if the wallet owns no legacy record, to test the tool responds
    const testDid = agentDid || `did:vector:agent:${ALWAYS_SUCCEEDS_V2}:${'a'.repeat(64)}`;
    const text = await callTool(ctx.client, 'vector_get_agent_profile', { agent_id: testDid });
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Profile/, 'vector_get_agent_profile');
  });

  test('vector_build_deregister_agent (build only: the legacy record stays for the Module-6 section)', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping deregister - the wallet owns no legacy record');
      return;
    }
    const text = await callTool(ctx.client, 'vector_build_deregister_agent', { changeAddress: walletAddress, agent_id: agentDid });
    assertSuccessOrKnownError(text, /Deposit returned on confirmation/, 'vector_build_deregister_agent');
  });
});

// ─── Self-Improvement Tools ─────────────────────────────────────────────────
// This section has never existed in run.test.ts before this change (checked
// the file's full git history: zero "proposal"/"critique"/"endorse" hits and
// zero hits for the old family name this PR retired, at any point) - added
// fresh here, following this file's
// established conventions (buildSignSubmit, assertSuccessOrKnownError,
// walletHasAda gating, settle waits), rather than "rewritten" from a prior
// custodial version that turns out not to exist in this file.
//
// Uses a legacy record that the wallet owns (legacy-agent.ts): this Module-6
// deployment needs a LIVE legacy agent NFT of the proposer as a reference
// input, and the legacy registration tool is retired (Part 2 Section 10), so
// the suite no longer registers and deregisters an agent of its own. Module-6
// moves to the identity registry with its new deployment.
//
// The self-improvement family's "agentDid" wire param is the trailing hex
// asset-name segment only, NOT the full did:vector:agent:{policyId}:
// {nftAssetName} string the registry family's agent_id means (found running
// self-improvement-keyless.test.ts live - see that file's discovery-test
// comment for the full finding). Both forms are captured below.
//
// COST-CONSCIOUS BY DEFAULT: critique and endorse target a LIVE, already-
// existing proposal discovered via browse - any proposal reference works for
// these (gov-build.ts's buildCritique/buildEndorse build a plain lock paid
// to a NEW UTxO; they never spend or validate the target proposal's state),
// at MINIMUM stakes (10 -> 12 AP3X output; 5 -> 7 AP3X output). That is real,
// on-chain coverage of the critique and endorse build_* tools for about
// 15 AP3X one-way.
//
// The two-step proposal SUBMISSION (lock -> await -> spend -> await) is
// deliberately NOT run by default here: self-improvement-e2e.test.ts already
// proves that exact path live and rigorously (its "THE MONEY ASSERTION"
// test), including the ~6-minute signing window and its documented
// rebuild-once recovery. Re-running the identical ~29 AP3X one-way sequence
// here would spend real testnet AP3X a second time for no new information
// about the underlying build/sign/submit/await mechanism. Set LEGACY_FULL=1
// to additionally exercise it through THIS file's own broader multi-family
// run (useful as a regression check once other families ahead of it in this
// file have already reshaped the wallet's UTxO set) - that branch reuses the
// exact proven build -> sign -> submit -> await sequence from the E2E, typed
// and typechecked, but was NOT executed as part of this task (only the
// default, cheaper path below was run live against the funded wallet) -
// stated plainly here rather than silently claiming coverage that wasn't
// exercised.
describe('Self-Improvement Tools', () => {
  let siAgentFullDid: string | null = null;
  let siAgentAssetName: string | null = null;
  let siProposalTxHash: string | null = null;
  let siProposalOutputIndex = 0;

  test('a legacy agent that the wallet owns (this Module-6 deployment needs a legacy record of the proposer)', { timeout: 120_000 }, async () => {
    siAgentFullDid = await ownedLegacyAgentDid(getAddressDetails(walletAddress).paymentCredential!.hash);
    if (siAgentFullDid) {
      siAgentAssetName = siAgentFullDid.slice(siAgentFullDid.lastIndexOf(':') + 1);
      console.log(`Self-improvement agent DID: ${siAgentFullDid}`);
    } else {
      console.log('The wallet owns no legacy record: the critique, endorse and proposal steps below are skipped');
    }
  });

  test('vector_self_improvement_browse (proposals) - also discovers a live proposal for critique/endorse below', { timeout: 120_000 }, async () => {
    if (walletHasAda && siAgentFullDid) {
      console.log('Waiting 10s for agent registration to confirm...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'proposals' });
    console.log(text.slice(0, 500));
    assertSuccessOrKnownError(text, /Improvement Proposals/, 'vector_self_improvement_browse (proposals)');
    const refMatch = text.match(/\*\*UTxO:\*\*\s*([0-9a-f]{64})#(\d+)/);
    if (refMatch) {
      siProposalTxHash = refMatch[1];
      siProposalOutputIndex = parseInt(refMatch[2], 10);
      console.log(`Discovered live proposal ref: ${siProposalTxHash}#${siProposalOutputIndex}`);
    }
  });

  test('vector_self_improvement_analyze_metrics', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_self_improvement_analyze_metrics', {});
    console.log(text.slice(0, 500));
    assertSuccessOrKnownError(text, /Proposal Metrics/, 'vector_self_improvement_analyze_metrics');
  });

  test('vector_build_self_improvement_critique (min stake 10) -> sign -> submit', { timeout: 120_000 }, async () => {
    if (!siAgentAssetName || !siProposalTxHash) {
      console.log('Skipping critique - no agent registered or no live proposal discovered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before critique...');
      await wait(10);
    }
    await buildSignSubmit('vector_build_self_improvement_critique', {
      changeAddress: walletAddress,
      agentDid: siAgentAssetName,
      proposalTxHash: siProposalTxHash,
      proposalOutputIndex: siProposalOutputIndex,
      critiqueType: 'Supportive',
      stakeApex: 10,
      critiqueHash: randomBytes(32).toString('hex'),
      storageUri: 'ipfs://legacy-critique-doc',
    }, /Unsigned Critique Built/);
  });

  test('vector_build_self_improvement_endorse (min stake 5) -> sign -> submit', { timeout: 120_000 }, async () => {
    if (!siAgentAssetName || !siProposalTxHash) {
      console.log('Skipping endorse - no agent registered or no live proposal discovered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before endorse...');
      await wait(10);
    }
    await buildSignSubmit('vector_build_self_improvement_endorse', {
      changeAddress: walletAddress,
      agentDid: siAgentAssetName,
      proposalTxHash: siProposalTxHash,
      proposalOutputIndex: siProposalOutputIndex,
      stakeApex: 5,
    }, /Unsigned Endorsement Built/);
  });

  // LEGACY_FULL=1 only - see the section banner comment above for why this
  // is gated off by default. Mirrors self-improvement-e2e.test.ts's proven
  // lock -> await -> spend -> await sequence exactly (including the
  // rebuild-once-on-window-expiry recovery), adapted to this file's
  // walletHasAda-tolerant helpers instead of E2E's hard asserts, since this
  // section (unlike the dedicated E2E) may run against an unfunded wallet.
  test('vector_build_self_improvement_proposal_lock -> await -> vector_build_self_improvement_proposal_spend -> sign -> submit [LEGACY_FULL=1 only]', { timeout: 600_000, skip: process.env.LEGACY_FULL !== '1' }, async () => {
    if (!siAgentAssetName) {
      console.log('Skipping full proposal submission - no agent registered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before proposal lock...');
      await wait(10);
    }

    // Inlined rather than buildSignSubmit: this step needs the lock's own
    // submitted tx hash directly (to await it, then feed it to
    // proposal_spend) - buildSignSubmit only reports whether a submit
    // succeeded, not the hash it produced.
    const lockBuildText = await callTool(ctx.client, 'vector_build_self_improvement_proposal_lock', {
      changeAddress: walletAddress,
      agentDid: siAgentAssetName,
      proposalType: 'GeneralSuggestion',
      stakeApex: 25,
      proposalHash: randomBytes(32).toString('hex'),
      storageUri: 'ipfs://legacy-proposal-doc',
    });
    console.log(lockBuildText.slice(0, 500));
    assertSuccessOrKnownError(lockBuildText, /step 1 of 2/, 'vector_build_self_improvement_proposal_lock');
    const lockCbor = extractCborOrNull(lockBuildText);
    if (!/step 1 of 2/.test(lockBuildText) || !lockCbor) {
      console.log('Skipping proposal spend - lock did not build (wallet likely unfunded)');
      return;
    }
    const lockSigned = signWithMnemonic(lockCbor, mnemonic);
    const lockSubmitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: lockSigned.signedCborHex });
    if (walletHasAda) {
      assert.match(lockSubmitText, /Transaction Submitted/, `proposal lock: expected success on a funded wallet, got: ${lockSubmitText.slice(0, 300)}`);
    } else {
      assertSuccessOrKnownError(lockSubmitText, /Transaction Submitted/, 'vector_build_self_improvement_proposal_lock (submit)');
    }
    if (!/Transaction Submitted/.test(lockSubmitText)) {
      console.log('Skipping proposal spend - lock did not submit (wallet likely unfunded)');
      return;
    }
    const lockTxHash = lockSigned.txHash;
    const awaitLockText = await callTool(ctx.client, 'vector_await_transaction', { txHash: lockTxHash, timeoutSeconds: 240 });
    assert.match(awaitLockText, /Transaction Confirmed/, `proposal lock did not confirm: ${awaitLockText.slice(0, 300)}`);

    async function buildSpend(): Promise<{ text: string; validTo: string }> {
      const text = await callTool(ctx.client, 'vector_build_self_improvement_proposal_spend', {
        changeAddress: walletAddress, agentDid: siAgentAssetName!, lockTxHash,
      });
      const m = text.match(/[Vv]alid until (.*Z)/);
      assert.ok(m, `no signing deadline in spend build:\n${text.slice(0, 500)}`);
      return { text, validTo: m[1] };
    }

    let { text: spendBuildText, validTo } = await buildSpend();
    console.log(`Proposal spend built, valid until ${validTo}`);
    let signed = signWithMnemonic(extractCborOrNull(spendBuildText)!, mnemonic);
    let submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signed.signedCborHex });

    if (!/Transaction Submitted/.test(submitText)) {
      console.log(`First proposal-spend submit did not report success - rebuilding ONCE (the documented recovery path for a possible signing-window expiry):\n${submitText.slice(0, 500)}`);
      ({ text: spendBuildText, validTo } = await buildSpend());
      console.log(`Proposal spend rebuilt, valid until ${validTo}`);
      signed = signWithMnemonic(extractCborOrNull(spendBuildText)!, mnemonic);
      submitText = await callTool(ctx.client, 'vector_submit_transaction', { signedTxCbor: signed.signedCborHex });
    }
    if (walletHasAda) {
      assert.match(submitText, /Transaction Submitted/, `proposal spend: expected success on a funded wallet, got: ${submitText.slice(0, 300)}`);
    } else {
      assertSuccessOrKnownError(submitText, /Transaction Submitted/, 'vector_build_self_improvement_proposal_spend (submit)');
    }
    if (/Transaction Submitted/.test(submitText)) {
      const hashMatch = submitText.match(/Transaction Hash:\s*([0-9a-f]{64})/);
      assert.ok(hashMatch, `no tx hash in submit response:\n${submitText.slice(0, 300)}`);
      const awaitSpendText = await callTool(ctx.client, 'vector_await_transaction', { txHash: hashMatch[1], timeoutSeconds: 240 });
      assert.match(awaitSpendText, /Transaction Confirmed/, `proposal spend did not confirm: ${awaitSpendText.slice(0, 300)}`);
      console.log(`Proposal submission complete via the legacy suite (tx ${hashMatch[1]})`);
    }
  });

  // No deregistration here: the legacy registration tool is retired, so this suite keeps the wallet's legacy record for its next run.
});
