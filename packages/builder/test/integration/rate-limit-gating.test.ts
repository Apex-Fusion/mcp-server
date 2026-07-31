import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawnServer, stopRawServer } from '../setup.ts';
import type { RawServerHandle } from '../setup.ts';

// Covers callTool()-level behavior of per-identity rate limiting, against a
// real spawned server driving the real registered tools. rate-limiter.test.ts
// unit-tests RateLimiter/limiterFor in isolation; test:smoke only ever calls
// listTools(). Neither exercises a single tool handler, so neither would
// notice checkRateLimit/rateLimiter falling out of scope in agent-network.ts
// or self-improvement.ts (both @ts-nocheck - tsc can't catch it either). See
// .superpowers/sdd/pr5-integration-tests-report.md for the mutation-testing
// evidence.
//
// Tool choice: vector_build_send_apex (vector.ts) with a deliberately invalid
// changeAddress. lucidForAddress (packages/builder/src/vector/build.ts)
// validates the address with getAddressDetails() and throws BEFORE any
// provider call - proven by Task 2's booby-trapped-provider test. Handlers
// return caught errors as normal content, so isError stays false and this
// probe is just as hermetic as the spend-limit-status tool it replaces
// (vector.ts no longer has one - Task 5 deleted it, since SafetyLayer state
// is no longer exposed to keyless callers).
// vector_get_agent_profile (agent-network.ts) and
// vector_self_improvement_analyze_metrics (self-improvement.ts) DO reach
// Ogmios/Koios in their normal bodies, but only after their own
// checkRateLimit() call, which is the first statement in both handlers and
// returns before any network code runs. This file only ever calls those two
// once alice's budget is already exhausted, so that network-touching code is
// never reached in a passing run - confirmed empirically below (response time,
// and the exact rate-limit text rather than a network error). That is also
// exactly why this suite is hermetic and safe for CI: see the report for the
// full argument.

const TOKEN_ALICE = 'tok-alice-rl-3c9f1a';
const TOKEN_BOB = 'tok-bob-rl-7d2e6b';

const RATE_LIMIT_ENV = {
  MCP_AUTH_TOKENS: `alice:${TOKEN_ALICE},bob:${TOKEN_BOB}`,
  // Deliberately tiny: the first call consumes the identity's only slot, the
  // second is refused, for the rest of the real 60s sliding window - which
  // easily outlasts this whole test file.
  VECTOR_RATE_LIMIT_PER_MINUTE: '1',
};

const RATE_LIMIT_PATTERN = /^Rate limit exceeded\. Retry after \d+ms\.$/;

async function connect(port: number, token: string): Promise<Client> {
  const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'rate-limit-integration-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

interface ToolOutcome {
  text: string;
  isError: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return { text: content?.[0]?.text ?? '', isError: result.isError === true };
}

describe('per-identity rate limiting across real registered tools', () => {
  let ctx: RawServerHandle;
  let alice: Client;
  let bob: Client;

  before(async () => {
    ctx = await spawnServer(RATE_LIMIT_ENV);
    alice = await connect(ctx.port, TOKEN_ALICE);
    bob = await connect(ctx.port, TOKEN_BOB);
  });

  after(async () => {
    try { await alice.close(); } catch {}
    try { await bob.close(); } catch {}
    await stopRawServer(ctx);
  });

  test('alice exhausts her budget on a vector.ts tool; bob is unaffected (isolation via the real tools, not just limiterFor)', async () => {
    const PROBE_ARGS = { changeAddress: 'not-an-address', recipientAddress: 'not-an-address', amount: 1 };

    const first = await call(alice, 'vector_build_send_apex', PROBE_ARGS);
    assert.equal(first.isError, false, 'first call must not be a tool error');
    assert.ok(!RATE_LIMIT_PATTERN.test(first.text), 'first call must not be rate-limited yet');

    const second = await call(alice, 'vector_build_send_apex', PROBE_ARGS);
    assert.equal(second.isError, false, 'a rate-limit refusal is a normal, well-formed result - not a thrown tool error');
    assert.match(second.text, RATE_LIMIT_PATTERN, 'alice must now be rate-limited');

    // Bob has never called anything: this proves his bucket is independent of
    // alice's, driven through a real connection and a real tool call - not an
    // inference from limiterFor() in isolation (rate-limiter.test.ts already
    // covers that in isolation; this covers the wiring rate-limiter.test.ts
    // cannot see).
    const bobFirst = await call(bob, 'vector_build_send_apex', PROBE_ARGS);
    assert.equal(bobFirst.isError, false);
    assert.ok(!RATE_LIMIT_PATTERN.test(bobFirst.text), "bob must be unaffected by alice's exhausted budget");
  });

  test('alice, still exhausted, is also rate-limited on an agent-network.ts tool', async () => {
    const r = await call(alice, 'vector_get_agent_profile', { agent_id: 'did:vector:agent:test:test' });
    assert.equal(r.isError, false, 'must be a well-formed rate-limit result, not a thrown error');
    assert.match(
      r.text,
      RATE_LIMIT_PATTERN,
      'a checkRateLimit/rateLimiter scoping regression in agent-network.ts would surface here as ' +
      'isError:true with a ReferenceError message ("rateLimiter is not defined") instead of this text'
    );
  });

  test('alice, still exhausted, is also rate-limited on a self-improvement.ts tool', async () => {
    const r = await call(alice, 'vector_self_improvement_analyze_metrics', {});
    assert.equal(r.isError, false, 'must be a well-formed rate-limit result, not a thrown error');
    assert.match(
      r.text,
      RATE_LIMIT_PATTERN,
      'a checkRateLimit/rateLimiter scoping regression in self-improvement.ts would surface here as ' +
      'isError:true with a ReferenceError message ("rateLimiter is not defined") instead of this text'
    );
  });
});
