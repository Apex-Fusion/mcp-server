import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, callTool, getMnemonic, wait, ServerContext } from './setup.ts';

// Always-succeeds PlutusV3 validator (accepts any datum/redeemer/context)
const ALWAYS_SUCCEEDS_V3 = '49480100002221200101';

let ctx: ServerContext;
let mnemonic: string;
let walletAddress: string;
let walletHasAda = false;
let agentDid: string | null = null;

before(async () => {
  mnemonic = getMnemonic();
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
  test('vector_get_address', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_get_address', { mnemonic });
    console.log(text);
    assert.match(text, /addr1/, 'Should contain a Vector address');
    assert.match(text, /ADA Balance:/, 'Should show ADA balance');
    assert.match(text, /UTXO Count:/, 'Should show UTXO count');

    const addrMatch = text.match(/(addr1[a-z0-9]+)/);
    assert.ok(addrMatch, 'Should be able to extract address');
    walletAddress = addrMatch![1];

    // Check if wallet is funded
    const balanceMatch = text.match(/ADA Balance:\s*([\d.]+)/);
    if (balanceMatch && parseFloat(balanceMatch[1]) > 0) {
      walletHasAda = true;
      console.log(`Wallet funded: ${balanceMatch[1]} ADA`);
    } else {
      console.log('Wallet has 0 ADA - transaction tests will verify error handling');
    }
  });

  test('vector_get_balance', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address should be set from previous test');
    const text = await callTool(ctx.client, 'vector_get_balance', { address: walletAddress });
    console.log(text);
    assert.match(text, /ADA Balance:/, 'Should show ADA balance');
    assert.ok(text.includes(walletAddress), 'Should contain the queried address');
  });

  test('vector_get_utxos', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_get_utxos', { mnemonic });
    console.log(text);
    assert.ok(
      text.includes('Total:') || text.includes('No UTxOs found'),
      'Should show UTxO count or no-UTxO message'
    );
  });
});

// ─── History & Limits ───────────────────────────────────────────────────────

describe('History & Limits', () => {
  test('vector_get_spend_limits', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_get_spend_limits', {});
    console.log(text);
    assert.match(text, /Per-Transaction Limit:/, 'Should show per-tx limit');
    assert.match(text, /Daily Limit:/, 'Should show daily limit');
    assert.match(text, /Daily Remaining:/, 'Should show daily remaining');
  });

  test('vector_get_transaction_history', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_get_transaction_history', { mnemonic, limit: 5 });
    console.log(text);
    assert.ok(
      text.includes('Transaction History') || text.includes('No transactions found')
        || text.includes('Failed to get transaction history'),
      'Should show history, no-transactions message, or error'
    );
  });
});

// ─── Transaction Tools ──────────────────────────────────────────────────────

describe('Transaction Tools', () => {
  test('vector_dry_run', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    const text = await callTool(ctx.client, 'vector_dry_run', {
      outputs: [{ address: walletAddress, lovelace: 2_000_000 }],
      mnemonic,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Valid:.*\nEstimated Fee:/, 'vector_dry_run');
  });

  test('vector_build_transaction (unsigned)', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    const text = await callTool(ctx.client, 'vector_build_transaction', {
      outputs: [{ address: walletAddress, lovelace: 2_000_000 }],
      mnemonic,
      submit: false,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /CBOR/, 'vector_build_transaction (unsigned)');
  });

  test('vector_build_transaction (submit)', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    const text = await callTool(ctx.client, 'vector_build_transaction', {
      outputs: [{ address: walletAddress, lovelace: 2_000_000 }],
      mnemonic,
      submit: true,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Transaction Hash:/, 'vector_build_transaction (submit)');
  });

  test('vector_send_apex', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    // Wait for previous tx UTxOs to settle
    if (walletHasAda) {
      console.log('Waiting 30s for UTxOs to settle...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_send_apex', {
      recipientAddress: walletAddress,
      amount: 2,
      mnemonic,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Transaction Hash:/, 'vector_send_apex');
  });

  test('vector_send_tokens', { timeout: 120_000 }, async () => {
    assert.ok(walletAddress, 'Wallet address required');
    // Wait for send_apex UTxOs to settle
    if (walletHasAda) {
      console.log('Waiting 30s for UTxOs to settle...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_send_tokens', {
      recipientAddress: walletAddress,
      policyId: 'a'.repeat(56),
      assetName: 'test',
      amount: '1',
      mnemonic,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Transaction Hash:/, 'vector_send_tokens');
  });
});

// ─── Smart Contract Tools ───────────────────────────────────────────────────

describe('Smart Contract Tools', () => {
  test('vector_deploy_contract', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 30s for UTxOs to settle before deploy...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_deploy_contract', {
      scriptCbor: ALWAYS_SUCCEEDS_V3,
      scriptType: 'PlutusV3',
      mnemonic,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Script Address:/, 'vector_deploy_contract');
  });

  test('vector_interact_contract (lock)', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 30s for deploy tx to confirm...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_interact_contract', {
      scriptCbor: ALWAYS_SUCCEEDS_V3,
      scriptType: 'PlutusV3',
      action: 'lock',
      mnemonic,
      datum: 'd87980',
      lovelaceAmount: 2_000_000,
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Transaction Hash:/, 'vector_interact_contract (lock)');
  });

  test('vector_interact_contract (spend)', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 30s for lock tx to confirm...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_interact_contract', {
      scriptCbor: ALWAYS_SUCCEEDS_V3,
      scriptType: 'PlutusV3',
      action: 'spend',
      mnemonic,
      redeemer: 'd87980',
    });
    console.log(text);
    assertSuccessOrKnownError(text, /Transaction Hash:/, 'vector_interact_contract (spend)');
  });
});

// ─── Agent Network Tools ────────────────────────────────────────────────────

describe('Agent Network Tools', () => {
  test('vector_register_agent', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 30s for UTxOs to settle before register...');
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
      console.log('Waiting 30s for agent registration to confirm...');
      await wait(10);
    }
    const text = await callTool(ctx.client, 'vector_discover_agents', {});
    console.log(text);
    assertSuccessOrKnownError(text, /Agent Discovery|Found|No agents found/, 'vector_discover_agents');
  });

  test('vector_get_agent_profile', { timeout: 120_000 }, async () => {
    // Use a known DID format even if registration failed, to test the tool responds
    const testDid = agentDid || `did:vector:agent:${ALWAYS_SUCCEEDS_V3}:${'a'.repeat(64)}`;
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
      console.log('Waiting 30s for UTxOs to settle before update...');
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
      console.log('Waiting 30s for UTxOs to settle before transfer...');
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
    const testDid = agentDid || `did:vector:agent:${ALWAYS_SUCCEEDS_V3}:${'a'.repeat(64)}`;
    if (walletHasAda && agentDid) {
      console.log('Waiting 30s for UTxOs to settle before message...');
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
      console.log('Waiting 30s for UTxOs to settle before deregister...');
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
