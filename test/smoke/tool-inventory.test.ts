import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/**
 * Full-schema snapshot: the exact `inputSchema` (JSON Schema) the live server
 * advertises for every tool, keyed by tool name. This is a change detector,
 * not a freeze — PRs 6, 7 and 8 deliberately restructure tool schemas as part
 * of the non-custodial split, and each of those PRs is expected to
 * regenerate this fixture to match its intentional changes (boot the built
 * server, call listTools(), and dump { [name]: inputSchema } sorted by
 * name — do not hand-edit the JSON).
 *
 * What this guards against is an *unintended* wire-format change slipping
 * through unnoticed: the name/count checks above only catch a tool being
 * added, removed, or renamed — they say nothing about a tool's argument
 * schema quietly changing shape. That happened once already: converting
 * vector.ts's Zod import from "zod" to "zod/v4" (for the MCP SDK's Zod 4
 * type inference) also switched which JSON Schema serializer the SDK uses
 * for that file's tools — Zod v3 schemas go through the vendored
 * zod-to-json-schema, Zod v4 schemas go through Zod's own native
 * toJSONSchema — and the two disagree on whether object schemas get
 * `additionalProperties: false`. Nothing in the original name/count smoke
 * test could see that; this fixture exists so the next silent schema drift
 * fails loudly instead.
 */
const SNAPSHOT_PATH = resolve(import.meta.dirname!, 'tool-schemas.snapshot.json');
const schemaSnapshot: Record<string, unknown> = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));

let ctx: ServerContext;
let actualNames: string[];
let actualToolsByName: Map<string, { name: string; inputSchema: unknown }>;

before(async () => {
  ctx = await startServer();
  const result = await ctx.client.listTools();
  actualNames = result.tools.map((t) => t.name).sort();
  actualToolsByName = new Map(result.tools.map((t) => [t.name, t]));
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

describe('tool schema snapshot', () => {
  test('snapshot fixture keys match the live tool set exactly', () => {
    const snapshotNames = Object.keys(schemaSnapshot).sort();
    const missingFromSnapshot = actualNames.filter((name) => !snapshotNames.includes(name));
    const staleInSnapshot = snapshotNames.filter((name) => !actualNames.includes(name));

    assert.deepEqual(
      snapshotNames,
      actualNames,
      'test/smoke/tool-schemas.snapshot.json keys do not match the live tool set.\n' +
        `  live tools missing from snapshot: ${missingFromSnapshot.length ? JSON.stringify(missingFromSnapshot) : '(none)'}\n` +
        `  snapshot entries with no live tool: ${staleInSnapshot.length ? JSON.stringify(staleInSnapshot) : '(none)'}\n` +
        'Regenerate the snapshot from a live built server if this drift is intentional.'
    );
  });

  // One assertion per tool (rather than a single deepEqual over the whole
  // 23-tool map) so a failure names the specific tool and shows a readable
  // diff of just that tool's schema, instead of "objects differ" over an
  // unreadable combined structure.
  for (const toolName of Object.keys(schemaSnapshot).sort()) {
    test(`inputSchema unchanged: ${toolName}`, () => {
      const live = actualToolsByName.get(toolName);
      assert.ok(
        live,
        `Tool "${toolName}" is in the snapshot but was not returned by the live server's listTools().`
      );
      assert.deepEqual(
        live.inputSchema,
        schemaSnapshot[toolName],
        `inputSchema for "${toolName}" differs from the checked-in snapshot in test/smoke/tool-schemas.snapshot.json.\n` +
          'If this is a deliberate schema change (e.g. PRs 6-8 restructuring tool families), regenerate the snapshot ' +
          'from a live built server. If not, this is the exact class of silent wire-format regression this test exists to catch.'
      );
    });
  }
});
