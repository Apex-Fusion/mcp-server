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

  test('vector_build_deregister_agent (build only: the legacy record stays for the next run)', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping deregister - the wallet owns no legacy record');
      return;
    }
    const text = await callTool(ctx.client, 'vector_build_deregister_agent', { changeAddress: walletAddress, agent_id: agentDid });
    assertSuccessOrKnownError(text, /Deposit returned on confirmation/, 'vector_build_deregister_agent');
  });
});

// ─── Self-Improvement Tools ─────────────────────────────────────────────────
// Module-6 moved to its deployment on the identity registry (Part 2 Section 7): a proposal, a critique and an endorsement each take a
// lock and a creation, and the agent is a did:vector agent whose record is Active. The full lifecycle runs in
// self-improvement-e2e.test.ts (gated by the deployment settings and an agent of the wallet). This run reads the previous deployment,
// whose positions stay until their owners exit, and checks that the build tools either build or say which settings they need.
describe('Self-Improvement Tools', () => {
  test("vector_self_improvement_browse (proposals, deployment: 'previous')", { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'proposals', deployment: 'previous' });
    console.log(text.slice(0, 500));
    assertSuccessOrKnownError(text, /Improvement Proposals|No proposals found on-chain/, 'vector_self_improvement_browse (proposals)');
  });

  test("vector_self_improvement_analyze_metrics (deployment: 'previous')", { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_self_improvement_analyze_metrics', { deployment: 'previous' });
    console.log(text.slice(0, 500));
    assertSuccessOrKnownError(text, /Proposal Metrics/, 'vector_self_improvement_analyze_metrics');
  });

  test('vector_build_self_improvement_proposal_lock (build only)', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_self_improvement_proposal_lock', {
      changeAddress: walletAddress, agentDid: process.env.VECTOR_E2E_AGENT_DID?.trim() || 'ab'.repeat(32), proposalType: 'GeneralSuggestion',
      stakeApex: 25, proposalHash: randomBytes(32).toString('hex'), storageUri: 'ipfs://run-suite-proposal-doc',
    });
    console.log(text.slice(0, 500));
    assertSuccessOrKnownError(text, /Proposal Lock Built, Step 1 of 2|not configured on this server/, 'vector_build_self_improvement_proposal_lock');
  });
});
