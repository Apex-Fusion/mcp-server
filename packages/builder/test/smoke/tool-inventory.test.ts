import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, stopServer, ServerContext } from '../setup.ts';

/**
 * Snapshot of the current tool surface (23 tools) for the non-custodial split
 * series (see docs/architecture/non-custodial-split.md). PR 6 (Task 5) is the
 * PR that took this list from 25 to 23: it deleted `vector_get_address`
 * outright, along with the tool that reported per-transaction/daily
 * SafetyLayer spend status (the safety-layer/wallet-info tools have no
 * keyless equivalent — spend status is gone because the builder no longer
 * holds keys to limit) as part of making the remaining query tools
 * (`vector_get_utxos`, `vector_get_transaction_history`, `vector_dry_run`)
 * keyless. PRs 2, 6, 7 and 8 each deliberately restructure and rename tool
 * families, and each of those PRs is expected to update this list
 * deliberately, not accidentally. No wallet, no network beyond localhost —
 * this never needs a mnemonic.
 */
const EXPECTED_TOOLS = [
  'vector_await_transaction',
  'vector_build_deploy_contract',
  'vector_build_deregister_agent',
  'vector_build_interact_contract',
  'vector_build_message_agent',
  'vector_build_register_agent',
  'vector_build_send_apex',
  'vector_build_send_tokens',
  'vector_build_transaction',
  'vector_build_transfer_agent',
  'vector_build_update_agent',
  'vector_discover_agents',
  'vector_dry_run',
  'vector_get_agent_profile',
  'vector_get_balance',
  'vector_get_transaction_history',
  'vector_get_utxos',
  'vector_self_improvement_analyze_metrics',
  'vector_self_improvement_browse',
  'vector_self_improvement_critique',
  'vector_self_improvement_endorse',
  'vector_self_improvement_submit_proposal',
  'vector_submit_transaction',
];

/**
 * Full-schema snapshot: the exact `description` and `inputSchema` (JSON
 * Schema) the live server advertises for every tool, keyed by tool name.
 * This is a change detector, not a freeze — PRs 6, 7 and 8 deliberately
 * restructure tool schemas as part of the non-custodial split, and each of
 * those PRs is expected to regenerate this fixture to match its intentional
 * changes: run `npm run build && node packages/builder/scripts/regen-tool-schemas.mjs`
 * (boots the built server, calls listTools(), and dumps
 * { [name]: { description, inputSchema } } sorted by name — do not hand-edit
 * the JSON).
 *
 * What this guards against is an *unintended* wire-format or copy change
 * slipping through unnoticed: the name/count checks above only catch a tool
 * being added, removed, or renamed — they say nothing about a tool's argument
 * schema or description quietly changing shape. The inputSchema half happened
 * once already: converting vector.ts's Zod import from "zod" to "zod/v4"
 * (for the MCP SDK's Zod 4 type inference) also switched which JSON Schema
 * serializer the SDK uses for that file's tools — Zod v3 schemas go through
 * the vendored zod-to-json-schema, Zod v4 schemas go through Zod's own native
 * toJSONSchema — and the two disagree on whether object schemas get
 * `additionalProperties: false`. Nothing in the original name/count smoke
 * test could see that. `description` was folded into this same fixture in
 * PR 6 (Task 5) because several tool descriptions are the only place a
 * caller learns the non-custodial build → sign → submit → confirm flow
 * (vector_signer_sign / vector_submit_transaction / vector_await_transaction)
 * — a silently edited or dropped sentence there is a real regression this
 * fixture should catch too, not just a JSON Schema shape change.
 */
const SNAPSHOT_PATH = resolve(import.meta.dirname!, 'tool-schemas.snapshot.json');
const schemaSnapshot: Record<string, { description?: string; inputSchema: unknown }> =
  JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));

let ctx: ServerContext;
let actualNames: string[];
let actualToolsByName: Map<string, { name: string; description?: string; inputSchema: unknown }>;

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

    assert.deepStrictEqual(
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

    assert.deepStrictEqual(
      snapshotNames,
      actualNames,
      'test/smoke/tool-schemas.snapshot.json keys do not match the live tool set.\n' +
        `  live tools missing from snapshot: ${missingFromSnapshot.length ? JSON.stringify(missingFromSnapshot) : '(none)'}\n` +
        `  snapshot entries with no live tool: ${staleInSnapshot.length ? JSON.stringify(staleInSnapshot) : '(none)'}\n` +
        'Regenerate the snapshot from a live built server (packages/builder/scripts/regen-tool-schemas.mjs) if this drift is intentional.'
    );
  });

  // One assertion per tool (rather than a single deepStrictEqual over the whole
  // 23-tool map) so a failure names the specific tool and shows a readable
  // diff of just that tool's schema, instead of "objects differ" over an
  // unreadable combined structure.
  for (const toolName of Object.keys(schemaSnapshot).sort()) {
    test(`schema+description unchanged: ${toolName}`, () => {
      const live = actualToolsByName.get(toolName);
      assert.ok(
        live,
        `Tool "${toolName}" is in the snapshot but was not returned by the live server's listTools().`
      );
      // Named separately from the deepStrictEqual below: a regen that
      // silently drops descriptions (e.g. JSON.stringify dropping an
      // `undefined` description key) should fail by naming exactly that,
      // not just show up as an opaque diff.
      assert.ok(
        'description' in (schemaSnapshot[toolName] as any),
        `Snapshot entry for "${toolName}" has no "description" key in test/smoke/tool-schemas.snapshot.json.`
      );
      assert.deepStrictEqual(
        { description: live.description, inputSchema: live.inputSchema },
        schemaSnapshot[toolName],
        `description/inputSchema for "${toolName}" differs from the checked-in snapshot in test/smoke/tool-schemas.snapshot.json.\n` +
          'If this is a deliberate schema or copy change (e.g. PRs 6-8 restructuring tool families), regenerate the snapshot ' +
          'from a live built server (packages/builder/scripts/regen-tool-schemas.mjs). If not, this is the exact class of silent ' +
          'wire-format/copy regression this test exists to catch.'
      );
    });
  }
});
