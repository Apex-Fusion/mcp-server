// packages/builder/test/reputation-clock.test.ts
// The reputation module is deployed on Vector mainnet only, and a validity range from another chain's clock would give `last_updated` a time
// that the ledger does not share. The stake tools therefore refuse a node whose chain start is not mainnet's. ensureSlotConfig keeps the first
// clock it reads for the life of the process (gov-build.ts), so a testnet clock has to be the first one a process sees: these tests have a
// file of their own (node runs each file in its own process), as marketplace-build-clock.test.ts does for the escrow builders.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { lucidForAddress } from '../src/vector/build.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { assertVectorMainnet, buildStakeCreate, buildStakeOpening } from '../src/vector/reputation-build.ts';
import { buildStakeCapabilities, buildStakeDecrease, buildStakeIncrease } from '../src/vector/reputation-actions.ts';
import { registerReputationTools } from '../src/vector/reputation-tools.ts';
import { AGENT_ID, CAPABILITIES, NOW, REAL_IDENTITY, WALLET_ADDRESS, World } from './fixtures/reputation-world.ts';

const TESTNET_ZERO = 1_752_057_484_000; // the reference SDK's constants.py SYSTEM_START_UNIX_S, in ms
const onTestnetClock = () => Object.assign(new World().provider(), { getSystemStartMs: async () => TESTNET_ZERO });
const DID = `did:vector:${AGENT_ID}`;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

describe('a node whose chain start is not Vector mainnet\'s', () => {
  test('a node that cannot give the clock is a refusal that names the failure, not the endpoint', async () => {
    const node = Object.assign(onTestnetClock(), { getSystemStartMs: async () => { throw new Error('connect ECONNREFUSED https://ogmios.internal.example'); } });
    await assert.rejects(assertVectorMainnet(node), (err: Error) => /Could not read the chain clock from the node/.test(err.message) && !err.message.includes('ogmios.internal.example'));
  });
  test('a node that answers with something that is not a clock is refused as such, and nothing is cached', async () => {
    const node = Object.assign(onTestnetClock(), { getSystemStartMs: async () => Number.NaN });
    await assert.rejects(assertVectorMainnet(node), /The node did not report a usable chain start time \(got NaN\)/);
  });
  test('the clock is refused, naming both starts, and every builder builds nothing', async () => {
    const node = onTestnetClock();
    await assert.rejects(assertVectorMainnet(node), /The node reports a chain start of 2025-07-09T10:38:04\.000Z, not Vector mainnet's 2025-08-29T16:40:00\.000Z\. The Module-3 reputation deployment is on Vector mainnet only; nothing was built\./);
    const ctx = { lucid: await lucidForAddress(node, WALLET_ADDRESS), provider: node, deployment: REAL_IDENTITY };
    const refused = /not Vector mainnet's/;
    await assert.rejects(buildStakeOpening(ctx, { changeAddress: WALLET_ADDRESS, did: DID, capabilities: CAPABILITIES.slice(0, 1), nowMs: NOW }), refused);
    await assert.rejects(buildStakeCreate(ctx, { changeAddress: WALLET_ADDRESS, did: DID, capabilities: CAPABILITIES.slice(0, 1), openingRef: `${'aa'.repeat(32)}#0`, nowMs: NOW }), refused);
    await assert.rejects(buildStakeIncrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: 1n, nowMs: NOW }), refused);
    await assert.rejects(buildStakeCapabilities(ctx, { changeAddress: WALLET_ADDRESS, did: DID, capabilities: CAPABILITIES.slice(0, 1), nowMs: NOW }), refused);
    await assert.rejects(buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, amountLovelace: 1n, nowMs: NOW }), refused);
  });
  test('each of the six tools answers with that refusal, and the read tool asks Koios for nothing', async () => {
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, _description: string, _shape: unknown, handler: Handler) => { handlers.set(name, handler); } } as unknown as McpServer;
    let fetched = 0;
    const koios = { koiosUrl: 'https://koios.example', fetchImpl: (async () => { fetched += 1; return new Response('[]'); }) as unknown as typeof fetch };
    registerReputationTools(server, 'clock-test', () => onTestnetClock() as unknown as Provider, new RateLimiter(100_000), () => REAL_IDENTITY, koios);
    const calls: Record<string, Record<string, unknown>> = {
      vector_build_reputation_stake_open: { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['x'] },
      vector_build_reputation_stake: { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['x'], opening_ref: `${'aa'.repeat(32)}#0` },
      vector_build_reputation_stake_increase: { changeAddress: WALLET_ADDRESS, did: DID, amount: 1 },
      vector_build_reputation_stake_update_capabilities: { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['x'] },
      vector_build_reputation_stake_decrease: { changeAddress: WALLET_ADDRESS, did: DID, amount: 1 },
      vector_get_reputation_stake: { dids: [DID] },
    };
    for (const [name, args] of Object.entries(calls)) {
      const out = await handlers.get(name)!(args);
      assert.match(out.content[0].text, /^Failed to .*: The node reports a chain start of 2025-07-09T10:38:04\.000Z, not Vector mainnet's 2025-08-29T16:40:00\.000Z\./, name);
    }
    assert.equal(fetched, 0);
  });
});
