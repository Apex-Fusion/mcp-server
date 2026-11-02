import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, callTool, ServerContext } from '../setup.ts';
import { liveLegacyAgentDid } from './legacy-agent.ts';

// Tier-1 registry integration: LIVE testnet, ZERO secrets. Build-only - nothing
// is signed, nothing is submitted, no funds move. The legacy registry writes are
// retired (Part 2 Section 10): what stays is the legacy read and the legacy
// deregistration, and the identity registry tools answer either a build (when
// the server has an identity deployment) or how to configure one.
const OWN_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
// The public key of a throwaway test key: the build names it as the controller, and nothing is signed.
const CONTROLLER_PUBLIC_KEY = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
const IDENTITY_CONFIGURED = Boolean(process.env.VECTOR_IDENTITY_LEGACY_ROOT?.trim());

let ctx: ServerContext;
before(async () => { ctx = await startServer(); });
after(async () => { await stopServer(ctx); });

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

  test('vector_build_identity_register builds, or says how to configure the identity registry', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_identity_register', {
      changeAddress: OWN_ADDRESS, controller: CONTROLLER_PUBLIC_KEY, name: `Tier1Agent-${process.pid}`,
      parties: [{ role: 'Accountable', signer: 'controller' }],
    });
    if (IDENTITY_CONFIGURED) {
      assert.match(text, /Identity Registration Built \(Unsigned, Not Submitted\)/);
      assert.match(text, /did:vector:[0-9a-f]{64}/);
    } else {
      assert.match(text, /VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/);
    }
  });

  test('get_agent_profile resolves the live agent', { timeout: 120_000 }, async () => {
    assert.ok(liveDid);
    const text = await callTool(ctx.client, 'vector_get_agent_profile', { agent_id: liveDid! });
    assert.match(text, /Agent Profile/);
    assert.match(text, /Registry UTxO:/);
  });

  test('a bogus changeAddress fails fast with a clear validation error', { timeout: 30_000 }, async () => {
    const t0 = Date.now();
    const text = await callTool(ctx.client, 'vector_build_deregister_agent', { changeAddress: 'addr1garbage', agent_id: liveDid ?? 'did:vector:agent:x:y' });
    assert.match(text, /Invalid change address/);
    assert.ok(Date.now() - t0 < 5_000, 'validation should not have hit the network');
  });

  test('a non-owner legacy deregistration is refused at build time', { timeout: 120_000 }, async () => {
    assert.ok(liveDid);
    const text = await callTool(ctx.client, 'vector_build_deregister_agent', { changeAddress: OWN_ADDRESS, agent_id: liveDid! });
    // The first live legacy record belongs to another wallet; expect the ownership fail-fast specifically.
    assert.match(text, /Ownership check failed/);
  });
});
