import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, ServerContext } from '../setup.ts';

/**
 * Snapshot of the pre-migration tool surface (23 tools), captured from a real
 * `listTools()` call against a built server on the `ci/harness-and-gitignore`
 * branch. This is the baseline for the non-custodial split series
 * (see docs/architecture/non-custodial-split.md) — PRs 2, 6, 7 and 8
 * deliberately restructure and rename tool families, and each of those PRs is
 * expected to update this list deliberately, not accidentally. No wallet,
 * no network beyond localhost — this never needs a mnemonic.
 */
const EXPECTED_TOOLS = [
  'vector_build_transaction',
  'vector_deploy_contract',
  'vector_deregister_agent',
  'vector_discover_agents',
  'vector_dry_run',
  'vector_get_address',
  'vector_get_agent_profile',
  'vector_get_balance',
  'vector_get_spend_limits',
  'vector_get_transaction_history',
  'vector_get_utxos',
  'vector_interact_contract',
  'vector_message_agent',
  'vector_register_agent',
  'vector_self_improvement_analyze_metrics',
  'vector_self_improvement_browse',
  'vector_self_improvement_critique',
  'vector_self_improvement_endorse',
  'vector_self_improvement_submit_proposal',
  'vector_send_apex',
  'vector_send_tokens',
  'vector_transfer_agent',
  'vector_update_agent',
];

let ctx: ServerContext;
let actualNames: string[];

before(async () => {
  ctx = await startServer();
  const result = await ctx.client.listTools();
  actualNames = result.tools.map((t) => t.name).sort();
});

after(async () => {
  await stopServer(ctx);
});

describe('tool inventory smoke test', () => {
  test('exposes exactly 23 tools', () => {
    assert.equal(
      actualNames.length,
      23,
      `expected 23 tools, got ${actualNames.length}: ${JSON.stringify(actualNames)}`
    );
  });

  test('tool names match the checked-in inventory exactly', () => {
    const added = actualNames.filter((name) => !EXPECTED_TOOLS.includes(name));
    const removed = EXPECTED_TOOLS.filter((name) => !actualNames.includes(name));

    assert.deepEqual(
      actualNames,
      EXPECTED_TOOLS,
      'Tool inventory drifted from the checked-in snapshot in test/smoke/tool-inventory.test.ts.\n' +
        `  added:   ${added.length ? JSON.stringify(added) : '(none)'}\n` +
        `  removed: ${removed.length ? JSON.stringify(removed) : '(none)'}\n` +
        'If this drift is intentional, update EXPECTED_TOOLS in this file to match.'
    );
  });
});
