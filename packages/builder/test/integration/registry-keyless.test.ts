import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, ServerContext } from '../setup.ts';
import { liveLegacyAgentDid } from './legacy-agent.ts';

// Tier-1 registry integration: LIVE testnet, ZERO secrets. Build-only - nothing
// is signed, nothing is submitted, no funds move. The register build runs the
// REAL registry validator server-side during .complete().
const OWN_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';

let ctx: ServerContext;
before(async () => { ctx = await startServer(); });
after(async () => { await stopServer(ctx); });

function extractCbor(text: string): string {
  const m = text.match(/```\n([0-9a-f]+)\n```/);
  assert.ok(m, `no CBOR block in response:\n${text.slice(0, 500)}`);
  return m![1];
}
function assertBuildNotSubmitted(text: string) {
  assert.doesNotMatch(text, /(?<!Not )Submitted\b|Transaction Submitted/);
  assert.match(text, /Unsigned|NOT been submitted|Not Submitted/i);
}

describe('registry keyless tier-1 (live testnet, no secrets)', () => {
  let liveDid: string | null = null;

  test('discover reads the marketplace indexer', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_discover_agents', { limit: 3 });
    assert.match(text, /Agent Discovery Results|No listed agents found/);
  });

  test('a live legacy agent DID to work with, from the legacy registry', { timeout: 120_000 }, async () => {
    liveDid = await liveLegacyAgentDid();
    assert.ok(liveDid, 'no legacy record at the legacy registry address - is the testnet registry empty?');
  });

  test('build_register_agent builds an evaluable unsigned registration', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_register_agent', {
      changeAddress: OWN_ADDRESS, name: `Tier1Agent-${process.pid}`,
      description: 'tier-1 build-only agent', capabilities: ['testing'], framework: 'custom', endpoint: '',
    });
    assertBuildNotSubmitted(text);
    // Brief specified /Agent DID:\s*did:vector:agent:/ - the live response is
    // Markdown ("**Agent DID:** did:vector:agent:..."), so two literal '*'
    // sit between the label and the value that \s* alone doesn't cover.
    // Verified against the actual tier-1 live response (register-agent build
    // succeeded; only this assertion's regex was too strict) before widening
    // it, per Task 5's task-5-report.md self-review.
    assert.match(text, /Agent DID:\*{0,2}\s*did:vector:agent:/);
    const tx = CML.Transaction.from_cbor_hex(extractCbor(text));
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'register build must be unsigned');
    assert.ok(tx.body().mint(), 'register tx has no mint field');
  });

  test('get_agent_profile resolves the live agent', { timeout: 120_000 }, async () => {
    assert.ok(liveDid);
    const text = await callTool(ctx.client, 'vector_get_agent_profile', { agent_id: liveDid! });
    assert.match(text, /Agent Profile/);
    assert.match(text, /Registry UTxO:/);
  });

  test('a bogus changeAddress fails fast with a clear validation error', { timeout: 30_000 }, async () => {
    const t0 = Date.now();
    const text = await callTool(ctx.client, 'vector_build_register_agent', {
      changeAddress: 'addr1garbage', name: 'X', description: '', capabilities: [], framework: 'c', endpoint: '',
    });
    assert.match(text, /Invalid change address/);
    assert.ok(Date.now() - t0 < 5_000, 'validation should not have hit the network');
  });

  test('non-owner update is refused at build time', { timeout: 120_000 }, async () => {
    assert.ok(liveDid);
    const text = await callTool(ctx.client, 'vector_build_update_agent', {
      changeAddress: OWN_ADDRESS, agent_id: liveDid!, description: 'not mine',
    });
    // The discovered agent belongs to another wallet (verified during planning:
    // live datum owners differ from OWN_ADDRESS's key). Expect the ownership
    // fail-fast specifically, not the broader "Failed to build agent update"
    // wrapper it's nested inside - that second alternative would also match
    // any OTHER build failure (a real regression), so it isn't a safe
    // stand-in for "ownership was checked and correctly refused." Reviewer-
    // confirmed against today's live response; not re-run live for this change.
    assert.match(text, /Ownership check failed/);
  });
});
