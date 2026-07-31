import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { walletFromSeed } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, getMnemonic, wait, ServerContext } from '../setup.ts';

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

describe('Agent Network Tools', () => {
  test('vector_register_agent', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before register...');
      await wait(10);
    }
    const timestamp = Date.now();
    const text = await callTool(ctx.client, 'vector_register_agent', {
      mnemonic,
      name: `TestAgent-${timestamp}`,
      description: 'Integration test agent',
      capabilities: ['testing'],
      framework: 'custom',
      endpoint: '',
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Agent DID:/, 'vector_register_agent');

    const didMatch = text.match(/(did:vector:agent:[a-f0-9]+:[a-f0-9]+)/);
    if (didMatch) {
      agentDid = didMatch[1];
      console.log(`Registered agent DID: ${agentDid}`);
    }
  });

  test('vector_discover_agents (no mnemonic)', { timeout: 120_000 }, async () => {
    if (walletHasAda && agentDid) {
      console.log('Waiting 10s for agent registration to confirm...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_discover_agents', {});
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Discovery|Found|No agents found/, 'vector_discover_agents');
  });

  test('vector_get_agent_profile', { timeout: 120_000 }, async () => {
    // Use a known DID format even if registration failed, to test the tool responds
    const testDid = agentDid || `did:vector:agent:${ALWAYS_SUCCEEDS_V2}:${'a'.repeat(64)}`;
    const text = await callTool(ctx.client, 'vector_get_agent_profile', { agent_id: testDid });
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Profile/, 'vector_get_agent_profile');
  });

  test('vector_update_agent', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping update — no agent registered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before update...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_update_agent', {
      mnemonic,
      agent_id: agentDid,
      description: 'Updated integration test agent',
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Updated|Updated fields/, 'vector_update_agent');
  });

  test('vector_transfer_agent (to self)', { timeout: 120_000 }, async () => {
    if (!agentDid || !walletAddress) {
      console.log('Skipping transfer — no agent registered or no wallet address');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before transfer...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_transfer_agent', {
      mnemonic,
      agent_id: agentDid,
      new_owner_address: walletAddress,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Transferred|Transfer/, 'vector_transfer_agent');
  });

  test('vector_message_agent', { timeout: 120_000 }, async () => {
    // Use a known DID format even if registration failed, to test the tool responds
    const testDid = agentDid || `did:vector:agent:${ALWAYS_SUCCEEDS_V2}:${'a'.repeat(64)}`;
    if (walletHasAda && agentDid) {
      console.log('Waiting 10s for UTxOs to settle before message...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_message_agent', {
      agent_id: testDid,
      message_type: 'inquiry',
      payload: 'integration test ping',
      mnemonic,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Message Sent/, 'vector_message_agent');
  });

  test('vector_deregister_agent', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping deregister — no agent registered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before deregister...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_deregister_agent', {
      mnemonic,
      agent_id: agentDid,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Deregistered|deposit returned/, 'vector_deregister_agent');
  });
});
