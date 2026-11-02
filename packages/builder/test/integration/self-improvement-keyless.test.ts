import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer, stopServer, callTool, ServerContext } from '../setup.ts';

// Tier-1 self-improvement integration: LIVE network, ZERO secrets. Build-only - nothing is signed, nothing is submitted, no value
// moves. The read tools read the previous Module-6 deployment (its positions stay until their owners exit) and, when the server has
// the GOV_* settings, the deployment on the identity registry. The build tools need both the GOV_* settings and the identity
// deployment (VECTOR_IDENTITY_*); without them they answer "not configured", which this suite checks. With them, set
// VECTOR_E2E_AGENT_DID to an agent whose record is Active to build a proposal lock against live data.
const OWN_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
const CONFIGURED = Boolean(process.env.GOV_PROPOSAL_SPEND_HASH?.trim()) && Boolean(process.env.VECTOR_IDENTITY_LEGACY_ROOT?.trim());
const AGENT_DID = process.env.VECTOR_E2E_AGENT_DID?.trim();

let ctx: ServerContext;
before(async () => { ctx = await startServer(); });
after(async () => { await stopServer(ctx); });

describe('self-improvement keyless tier-1 (live network, no secrets)', () => {
  test("vector_self_improvement_browse (proposals, deployment: 'previous') reads the previous deployment", { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'proposals', deployment: 'previous' });
    assert.match(text, /Improvement Proposals \(\d+ found, previous deployment|No proposals found on-chain \(previous deployment/);
  });

  test("vector_self_improvement_analyze_metrics (deployment: 'previous') renders proposal metrics and treasury", { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_self_improvement_analyze_metrics', { deployment: 'previous' });
    assert.match(text, /Proposal Metrics/);
    assert.match(text, /Treasury/);
  });

  test('the current deployment: read tools and build tools work, or say which variables to set', { timeout: 120_000 }, async () => {
    const browse = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'proposals' });
    if (!CONFIGURED) {
      assert.match(browse, /not configured on this server: set GOV_PROPOSAL_SPEND_HASH/);
      const build = await callTool(ctx.client, 'vector_build_self_improvement_endorse', { changeAddress: OWN_ADDRESS, agentDid: 'ab'.repeat(32), proposalTxHash: 'cd'.repeat(32), stakeApex: 5 });
      assert.match(build, /not configured on this server: set GOV_PROPOSAL_SPEND_HASH/);
      return;
    }
    assert.match(browse, /Improvement Proposals \(\d+ found, current deployment|No proposals found on-chain \(current deployment/);
    if (!AGENT_DID) return;
    const lock = await callTool(ctx.client, 'vector_build_self_improvement_proposal_lock', {
      changeAddress: OWN_ADDRESS, agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
      proposalHash: randomBytes(32).toString('hex'), storageUri: 'ipfs://keyless-tier1-proposal',
    });
    assert.match(lock, /Proposal Lock Built, Step 1 of 2 \(Unsigned, Not Submitted\)|^Failed to build proposal lock: /);
  });

  test('vector_build_self_improvement_proposal_spend on an unknown lockTxHash fails fast with the await-first error', { timeout: 30_000, skip: !CONFIGURED }, async () => {
    const text = await callTool(ctx.client, 'vector_build_self_improvement_proposal_spend', { changeAddress: OWN_ADDRESS, agentDid: 'ab'.repeat(32), lockTxHash: 'ee'.repeat(32) });
    assert.match(text, /is not an unspent output: has the lock transaction confirmed\?/);
  });
});
