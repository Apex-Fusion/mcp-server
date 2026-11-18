// packages/builder/test/reputation-tools.test.ts
// Handler-level tests of the six reputation tools: a minimal fake server captures the handlers, the node is a fixture over the offline world
// (reputation-world.ts: the deployed reputation script runs on each build), Koios is a stubbed fetch, and the identity registry is the one
// that the hosted server's values give. No network is touched. The refusal of a node that is not on Vector mainnet is in
// reputation-clock.test.ts (a process keeps its first chain clock).
import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { IdentityConfigError, NOT_CONFIGURED } from '../src/vector/identity-deployment.ts';
import { registerReputationTools } from '../src/vector/reputation-tools.ts';
import type { ReputationReadAccess } from '../src/vector/reputation-tools.ts';
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, encodeStakeDatum, stakeTokenName, stakeTokenUnit } from '../src/vector/reputation-datum.ts';
import type { StakeDatum } from '../src/vector/reputation-datum.ts';
import { DEPLOYMENT } from './fixtures/identity-world.ts';
import { AGENT2_ID, AGENT_ID, AUTH_ONLY, CAPABILITIES, CONTROLLER, DAY, LISTED, NOW, REAL_IDENTITY, REPLACEMENT, STRANGER, WALLET, WALLET_ADDRESS, World } from './fixtures/reputation-world.ts';
import { LEVEL_SHAPES, SHAPES } from './fixtures/size-limits-world.ts';

/** Runs `run` with the clock of the handlers (Date.now) at `ms`: the tools build from the time of the call. */
async function at<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const clock = mock.method(Date, 'now', () => ms);
  try { return await run(); } finally { clock.mock.restore(); }
}

interface Registered { description: string; shape: z.ZodRawShape; handler: Handler }
type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const DID = `did:vector:${AGENT_ID}`;
const DID2 = `did:vector:${AGENT2_ID}`;
const STAKE_CAPS = CAPABILITIES.slice(0, 2);
const NAMES = [
  'vector_build_reputation_stake_open', 'vector_build_reputation_stake', 'vector_build_reputation_stake_increase',
  'vector_build_reputation_stake_update_capabilities', 'vector_build_reputation_stake_decrease', 'vector_get_reputation_stake',
];

/** The six tools over a world: `world` is the ledger the node serves now. */
function setup(world: World, opts: { koios?: ReputationReadAccess; deployment?: () => typeof REAL_IDENTITY; limiter?: RateLimiter; provider?: () => Provider } = {}) {
  const tools = new Map<string, Registered>();
  const server = { tool: (name: string, description: string, shape: z.ZodRawShape, handler: Handler) => { tools.set(name, { description, shape, handler }); } } as unknown as McpServer;
  registerReputationTools(
    server, 'reputation-tools-test', opts.provider ?? (() => world.provider() as unknown as Provider), opts.limiter ?? new RateLimiter(100_000), opts.deployment ?? (() => REAL_IDENTITY),
    opts.koios ?? { koiosUrl: 'https://koios.example', fetchImpl: (async () => { throw new Error('Koios was asked'); }) as unknown as typeof fetch },
  );
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const out = await tools.get(name)!.handler(args);
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, 'text');
    return out.content[0].text;
  };
  return { tools, call };
}
const JSON_FENCE = '\n```json\n';
const jsonOf = (t: string) => JSON.parse(t.slice(t.lastIndexOf(JSON_FENCE) + JSON_FENCE.length, t.lastIndexOf('\n```')));
const cborOf = (t: string): string => /\*\*Unsigned TX CBOR:\*\*\n```\n([0-9a-f]+)\n```/.exec(t)![1];

/** The two steps and the actions through the tools, each applied to the world, as a client would do after it signs, submits and confirms. */
async function viaTools(world: World) {
  const t = setup(world);
  const open = await t.call('vector_build_reputation_stake_open', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS });
  world.apply(cborOf(open));
  return { t, open, openJson: jsonOf(open) };
}

describe('the six tools', () => {
  test('are registered with a description that says what they do and who signs, and none says "not published" or "not deployed"', () => {
    const { tools } = setup(new World());
    assert.deepEqual([...tools.keys()].sort(), [...NAMES].sort());
    for (const [name, { description }] of tools) {
      assert.ok(description.length > 150, name);
      assert.doesNotMatch(description, /not published|not deployed|takes no new stakes|until then/i, name);
      assert.match(description, /Takes no key material|Read-only, no wallet needed/, name);
    }
    const d = (name: string) => tools.get(name)!.description;
    assert.match(d('vector_build_reputation_stake'), /The owner cannot withdraw the module minimum\./);
    assert.match(d('vector_build_reputation_stake'), /controller key and the owner key sign, and the wallet pays the fee/);
    assert.match(d('vector_build_reputation_stake'), /Each agent has one stake through these tools: a second create is refused, and the refusal names the stake and vector_build_reputation_stake_increase/);
    assert.match(d('vector_build_reputation_stake_open'), /Only the wallet signs, and no script runs in this step\. Only step 2 \(vector_build_reputation_stake\) can spend the opening output.*When step 2 never runs, the opening output stays locked\. The answer names the owner_key_hash and the amount to pass to step 2/);
    assert.match(d('vector_build_reputation_stake_open'), /It also refuses when an opening output that names the agent is already at the reputation address: step 2 can spend any of them with any owner key that the record declares, and the refusal lists them with their AP3X and owner \(at most 5, those whose owner the record declares first\)\. allow_second_opening builds a new opening output all the same\./);
    assert.match(d('vector_build_reputation_stake'), /The owner of the stake is owner_key_hash when you pass it, else the owner key that step 1 named in the opening output, which the record must declare now\. The validator reads the owner of the stake, not the owner in the opening output/);
    assert.match(d('vector_build_reputation_stake_increase'), /controller key and the stake's owner key sign, and the wallet pays the AP3X and the fee/);
    assert.match(d('vector_build_reputation_stake_update_capabilities'), /cooldown of the stake \(stake_cooldown, 24 h in the deployed parameters, counted from its last_updated\) must be over/);
    assert.match(d('vector_build_reputation_stake_decrease'), /Only the agent's controller key signs \(besides the wallet\): the owner key need not/);
    assert.match(d('vector_build_reputation_stake_decrease'), /The owner cannot withdraw the module minimum/);
    assert.match(d('vector_get_reputation_stake'), /sum of stake_amount; an agent with no stake has the sum 0/);
  });

  test('take the agent as an identity DID, in the parameter that the identity tools use, and check each input', () => {
    const { tools } = setup(new World());
    const parse = (name: string, args: Record<string, unknown>) => z.object(tools.get(name)!.shape).safeParse(args).success;
    const base = { changeAddress: WALLET_ADDRESS, did: DID };
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'] }), true);
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: [] }), false, 'at least one capability');
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: Array.from({ length: 17 }, () => 'a') }), false, 'at most 16');
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'], owner_key_hash: 'ab'.repeat(28) }), true);
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'], owner_key_hash: 'ab' }), false, 'a key hash is 56 hex characters');
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'], valid_minutes: 59 }), true);
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'], valid_minutes: 60 }), false);
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'], valid_minutes: 0 }), false);
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'], allow_second_opening: true }), true);
    assert.equal(parse('vector_build_reputation_stake_open', { ...base, capabilities: ['a'], allow_second_opening: 'yes' }), false, 'a boolean');
    assert.equal(parse('vector_build_reputation_stake', { ...base, capabilities: ['a'], opening_ref: `${'aa'.repeat(32)}#0`, amount: 12.5 }), true);
    assert.equal(parse('vector_build_reputation_stake', { ...base, capabilities: ['a'], opening_ref: `${'aa'.repeat(32)}#0`, amount: 0 }), false, 'a positive amount');
    assert.equal(parse('vector_build_reputation_stake', { ...base, capabilities: ['a'] }), false, 'the opening ref is needed');
    assert.equal(parse('vector_build_reputation_stake_increase', { ...base, amount: 1, stake_ref: `${'aa'.repeat(32)}#0` }), true);
    assert.equal(parse('vector_build_reputation_stake_increase', { ...base }), false, 'the amount is needed');
    assert.equal(parse('vector_build_reputation_stake_decrease', { ...base, amount: -1 }), false);
    assert.equal(parse('vector_build_reputation_stake_update_capabilities', { ...base, capabilities: ['a'] }), true);
    assert.equal(parse('vector_get_reputation_stake', { dids: [DID] }), true);
    assert.equal(parse('vector_get_reputation_stake', { dids: [] }), false);
    assert.equal(parse('vector_get_reputation_stake', { dids: Array.from({ length: 51 }, () => DID) }), false, 'at most 50 agents');
    assert.equal(Object.keys(tools.get('vector_build_reputation_stake')!.shape).includes('agent_id'), false, 'the legacy parameter name is gone');
  });

  test('a spent limiter answers each of the six with the rate-limit text and touches nothing', async () => {
    const spent = new RateLimiter(1);
    spent.check();
    const { call } = setup(new World(), { limiter: spent, provider: () => { throw new Error('the node was touched'); }, deployment: () => { throw new Error('the registry was read'); } });
    for (const name of NAMES) assert.match(await call(name, {}), /^Rate limit exceeded\. Retry after \d+ms\.$/, name);
  });
});

describe('the build tools: the answer of each, with the signers and the JSON block', () => {
  test('step 1 shows the opening ref and what step 2 needs; only the wallet signs', async () => {
    const world = new World();
    const t = setup(world);
    const text = await t.call('vector_build_reputation_stake_open', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, valid_minutes: 20, amount: 12.345678 });
    assert.ok(text.startsWith('# Reputation Stake Opening Built (Unsigned, Not Submitted)\n\n**Step:** 1 of 2, the opening output (step 2 is vector_build_reputation_stake)\n**Opening ref (after submit):** `'), text.slice(0, 300));
    const j = jsonOf(text);
    assert.equal(j.opening_ref, `${j.tx_hash}#${j.opening_ref.split('#')[1]}`);
    assert.equal(j.did, DID);
    assert.equal(j.owner_key_hash, WALLET.keyHash);
    assert.deepEqual(j.capabilities, STAKE_CAPS);
    assert.equal(j.lovelace, '2000000');
    assert.equal(j.collateral_kept, true);
    assert.deepEqual(j.required_signers, [{ key_hash: WALLET.keyHash, roles: ['wallet (inputs, fee and collateral)'] }]);
    assert.ok(j.valid_to - j.valid_from <= 20 * 60_000 + 60_000);
    assert.match(text, /\*\*Locked:\*\* 2\.000000 AP3X at the reputation address\. Only step 2 can spend it; when step 2 never runs, it stays locked/);
    assert.match(text, /\*\*Stake for step 2:\*\* 12\.345678 AP3X \(the wallet was checked for this amount\)/);
    assert.match(text, /\*\*Step 2 needs:\*\* the controller key of the agent and the owner key to sign, and the record to be Active over its window/);
    assert.match(text, /\*\*Required signers\*\* \(1\):\n\n\| key hash \| signs as \|\n\|---\|---\|\n\| `[0-9a-f]{56}` \| wallet \(inputs, fee and collateral\) \|/);
    assert.ok(text.includes(`Once it confirms, call vector_build_reputation_stake with opening_ref \`${j.opening_ref}\`, the same did and capabilities, owner_key_hash \`${WALLET.keyHash}\` and amount 12.345678.\n\n`));
    assert.ok(text.includes('vector_signer_sign { txCbor }'));
    assert.deepEqual(j.other_openings, []);
    assert.equal(j.other_openings_more, 0);
    assert.doesNotMatch(text, /Other opening outputs/);
    // The block of step 2 is valid input of step 2 as it stands (the amount is a number), and it gives the stake that step 1 checked the wallet for.
    world.apply(cborOf(text));
    const step2 = j.step_2;
    assert.deepEqual(step2, { opening_ref: j.opening_ref, did: DID, capabilities: STAKE_CAPS, owner_key_hash: WALLET.keyHash, amount: 12.345678 });
    const args = { changeAddress: WALLET_ADDRESS, ...step2 };
    assert.equal(z.object(t.tools.get('vector_build_reputation_stake')!.shape).safeParse(args).success, true, 'the schema of step 2 takes the block as it is');
    const created = jsonOf(await t.call('vector_build_reputation_stake', args));
    assert.equal(created.stake_lovelace, '12345678');
  });

  test('step 2 shows the stake, its token, the signers with their roles, the time and the module minimum that stays', async () => {
    const world = new World();
    const { t, openJson } = await viaTools(world);
    const text = await t.call('vector_build_reputation_stake', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, opening_ref: openJson.opening_ref, amount: 12 });
    assert.ok(text.startsWith('# Reputation Stake Built (Unsigned, Not Submitted)\n\n**Step:** 2 of 2, CreateStake\n**Stake ref (after submit):** `'), text.slice(0, 300));
    const j = jsonOf(text);
    assert.equal(j.stake_ref, `${j.tx_hash}#${j.stake_ref.split('#')[1]}`);
    assert.equal(j.stake_id, openJson.opening_ref);
    assert.equal(j.opening_ref, openJson.opening_ref);
    assert.equal(j.stake_lovelace, '12000000');
    assert.equal(j.token_unit, stakeTokenUnit(AGENT_ID));
    assert.equal(j.owner_key_hash, WALLET.keyHash);
    assert.equal(j.controller_key_hash, WALLET.keyHash);
    assert.equal(j.min_self_stake, '10000000');
    assert.equal(j.ready_at, j.last_updated + DAY);
    assert.equal(j.last_updated, j.valid_to);
    assert.equal(j.required_signers.length, 1);
    assert.deepEqual(j.required_signers[0].roles.length, 3);
    assert.ok(text.includes(`**Stake locked:** 12.000000 AP3X with the stake token \`${stakeTokenUnit(AGENT_ID)}\``));
    assert.ok(text.includes(`**Consumes:** the opening output \`${openJson.opening_ref}\` (its AP3X return as change)`));
    assert.match(text, /\*\*Stake time \(last_updated\):\*\* 20\d\d-\d\d-\d\dT[\d:.]+Z/);
    assert.match(text, /\*\*Module minimum:\*\* 10\.000000 AP3X\. The owner cannot withdraw the module minimum\./);
  });

  test('step 2 says when the stake gets another owner than the opening output names, and says nothing when it is the same', async () => {
    const world = new World();
    const t = setup(world);
    const open = await t.call('vector_build_reputation_stake_open', { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, owner_key_hash: LISTED.keyHash });
    world.apply(cborOf(open));
    const base = { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, opening_ref: jsonOf(open).opening_ref };
    const same = await t.call('vector_build_reputation_stake', base);
    assert.doesNotMatch(same, /Owner differs from the opening output/);
    assert.equal(jsonOf(same).owner_key_hash, LISTED.keyHash);
    assert.equal(jsonOf(same).opening_owner_key_hash, LISTED.keyHash);
    const other = await t.call('vector_build_reputation_stake', { ...base, owner_key_hash: CONTROLLER.keyHash.toUpperCase() });
    assert.ok(other.includes(`**Owner key:** \`${CONTROLLER.keyHash}\`\n**Owner differs from the opening output:** the opening output named \`${LISTED.keyHash}\`; the stake gets \`${CONTROLLER.keyHash}\`, because you passed owner_key_hash; the validator reads the owner of the stake, not the owner in the opening output\n**Controller key:**`), other.slice(0, 700));
    assert.equal(jsonOf(other).owner_key_hash, CONTROLLER.keyHash);
    assert.equal(jsonOf(other).opening_owner_key_hash, LISTED.keyHash);
    const undeclared = await t.call('vector_build_reputation_stake', { ...base, owner_key_hash: 'ab'.repeat(28) });
    assert.match(undeclared, /^Failed to build reputation stake: The owner key abab.* is not a declared key of did:vector:a4/);
    assert.match(undeclared, /\*\*Troubleshooting Tips:\*\*[\s\S]*The owner key \(owner_key_hash, else the owner that the opening output names\) must be the record's controller key or a key it lists with the transaction purpose, and both that key and the controller must sign/);
  });

  test('increase, capability update and decrease show the stake that replaces the old one, and who signs', async () => {
    const world = new World();
    const { t, openJson } = await viaTools(world);
    const created = await t.call('vector_build_reputation_stake', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, opening_ref: openJson.opening_ref, amount: 15 });
    world.apply(cborOf(created));
    const stakeJson = jsonOf(created);
    const increased = await t.call('vector_build_reputation_stake_increase', { changeAddress: WALLET_ADDRESS, did: DID, amount: 2.5 });
    const ij = jsonOf(increased);
    assert.ok(increased.startsWith('# Reputation Stake Increase Built (Unsigned, Not Submitted)\n\n'));
    assert.ok(increased.includes(`**Stake ref (after submit):** \`${ij.stake_ref}\` (replaces \`${stakeJson.stake_ref}\`)`));
    assert.equal(ij.added_lovelace, '2500000');
    assert.equal(ij.stake_amount, '17500000');
    assert.equal(ij.previous_ref, stakeJson.stake_ref);
    assert.match(increased, /\*\*Stake now:\*\* 17\.500000 AP3X counted, 17\.500000 AP3X in the output/);
    world.apply(cborOf(increased));
    // The cooldown: not now.
    const early = await t.call('vector_build_reputation_stake_update_capabilities', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: CAPABILITIES });
    assert.match(early, /^Failed to build capability update: .*Too early: the stake changed at /);
    assert.match(early, /\*\*Troubleshooting Tips:\*\*\n1\. The cooldown \(stake_cooldown\) must be over: it counts from the last change of the stake \(the refusal gives the time\)/);
    // After the cooldown (the clock of the handler is moved): the capability update and then the decrease.
    const updated = await at(ij.ready_at + 60_000, () => t.call('vector_build_reputation_stake_update_capabilities', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: CAPABILITIES }));
    const uj = jsonOf(updated);
    assert.ok(updated.startsWith('# Reputation Stake Capabilities Built (Unsigned, Not Submitted)\n\n'));
    assert.ok(updated.includes(`**Stake ref (after submit):** \`${uj.stake_ref}\` (replaces \`${ij.stake_ref}\`)`));
    assert.deepEqual(uj.capabilities, CAPABILITIES);
    assert.deepEqual(uj.previous_capabilities, STAKE_CAPS);
    assert.equal(uj.stake_amount, '17500000');
    assert.match(updated, /\*\*Capabilities now:\*\* `demo\.text\.stats\.v1`, `demo\.text\.summary\.v1`, `demo\.text\.extract\.v1`\n\*\*Capabilities before:\*\* `demo\.text\.stats\.v1`, `demo\.text\.summary\.v1`\n/);
    assert.match(updated, /\*\*Next change:\*\* a decrease or a capability update from 20\d\d-.*Z/);
    world.apply(cborOf(updated));
    const decreased = await at(uj.ready_at + 60_000, () => t.call('vector_build_reputation_stake_decrease', { changeAddress: WALLET_ADDRESS, did: DID, amount: 3 }));
    const dj = jsonOf(decreased);
    assert.ok(decreased.startsWith('# Reputation Stake Decrease Built (Unsigned, Not Submitted)\n\n'));
    assert.equal(dj.taken_lovelace, '3000000');
    assert.equal(dj.stake_amount, '14500000');
    assert.equal(dj.payee_key_hash, WALLET.keyHash);
    assert.equal(dj.payee_reason, 'owner');
    assert.equal(dj.payout_address, WALLET_ADDRESS);
    assert.ok(decreased.includes(`**Paid to:** \`${WALLET_ADDRESS}\` (key \`${WALLET.keyHash}\`, the stake's owner key)`));
    assert.match(decreased, /\*\*Stake keeps:\*\* 14\.500000 AP3X counted, 14\.500000 AP3X in the output \(module minimum 10\.000000 AP3X\)/);
    assert.deepEqual(dj.required_signers.map((s: { key_hash: string }) => s.key_hash), [WALLET.keyHash]);
    // Below the module minimum: refused, naming the most that can be taken out.
    world.apply(cborOf(decreased));
    const tooMuch = await at(dj.ready_at + 60_000, () => t.call('vector_build_reputation_stake_decrease', { changeAddress: WALLET_ADDRESS, did: DID, amount: 5 }));
    assert.match(tooMuch, /^Failed to build stake decrease: The stake counts 14\.500000 AP3X; taking out 5\.000000 AP3X would leave 9\.500000 AP3X, below the module minimum of 10\.000000 AP3X \(min_self_stake\), which the owner cannot withdraw\. The most that can be taken out is 4\.500000 AP3X\./);
  });
});

describe('refusals are answers that name the rule and what to try', () => {
  test('a server with no identity registry says how to configure it, before the node is touched', async () => {
    const { call } = setup(new World(), { deployment: () => { throw new IdentityConfigError(NOT_CONFIGURED); }, provider: () => { throw new Error('the node was touched'); } });
    for (const [name, args] of [
      ['vector_build_reputation_stake_open', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['x'] }],
      ['vector_build_reputation_stake', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['x'], opening_ref: `${'aa'.repeat(32)}#0` }],
      ['vector_build_reputation_stake_increase', { changeAddress: WALLET_ADDRESS, did: DID, amount: 1 }],
      ['vector_build_reputation_stake_update_capabilities', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['x'] }],
      ['vector_build_reputation_stake_decrease', { changeAddress: WALLET_ADDRESS, did: DID, amount: 1 }],
    ] as const) {
      const text = await call(name, args);
      assert.match(text, /^Failed to build .*: The identity registry is not configured on this server: set VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/, name);
      assert.match(text, /\*\*Troubleshooting Tips:\*\*/, name);
    }
  });

  test('a registry other than the one that the validator reads is refused, naming both', async () => {
    const { call } = setup(new World(), { deployment: () => DEPLOYMENT });
    const text = await call('vector_build_reputation_stake_increase', { changeAddress: WALLET_ADDRESS, did: DID, amount: 1 });
    assert.match(text, new RegExp(`^Failed to build stake increase: This server's identity registry \\(policy ${DEPLOYMENT.identity.hash}\\) is not the registry that the Module-3 reputation validator reads \\(policy ${REAL_IDENTITY.identity.hash}\\)`));
  });

  test('a legacy DID is refused with the identity form named', async () => {
    const { call } = setup(new World());
    const legacy = `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${AGENT_ID}`;
    const text = await call('vector_build_reputation_stake_open', { changeAddress: WALLET_ADDRESS, did: legacy, capabilities: ['x'] });
    assert.match(text, /^Failed to build stake opening: did:vector:agent:be1a0a29.* is a DID of the legacy registry\. The stake tools take an identity DID, did:vector:<64 lowercase hex>/);
    const read = await call('vector_get_reputation_stake', { dids: [legacy] });
    assert.match(read, /^Failed to read reputation stakes: .* is a DID of the legacy registry/);
  });

  test('a second create names the stake and the increase tool; the capabilities of a record are named when one is not listed', async () => {
    const world = new World();
    const { t, openJson } = await viaTools(world);
    const bad = await t.call('vector_build_reputation_stake', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['data_analysis'], opening_ref: openJson.opening_ref });
    assert.match(bad, /^Failed to build reputation stake: Capability data_analysis is not in the record of did:vector:a3.*which lists: demo\.text\.stats\.v1, demo\.text\.summary\.v1, demo\.text\.extract\.v1\./);
    assert.match(bad, /\*\*Troubleshooting Tips:\*\*\n1\. opening_ref must be the confirmed output of vector_build_reputation_stake_open/);
    const created = await t.call('vector_build_reputation_stake', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, opening_ref: openJson.opening_ref });
    world.apply(cborOf(created));
    const again = await t.call('vector_build_reputation_stake_open', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS });
    assert.match(again, new RegExp(`^Failed to build stake opening: ${DID} already has a stake, at ${jsonOf(created).stake_ref}\\. These tools make one stake for each agent: the owner cannot withdraw the module minimum.*vector_build_reputation_stake_increase`));
  });

  test('step 1 refuses while an opening output names the agent and lists it; allow_second_opening builds another and names the first', async () => {
    const world = new World();
    const t = setup(world);
    const args = { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS };
    const first = await t.call('vector_build_reputation_stake_open', args);
    world.apply(cborOf(first));
    const ref = jsonOf(first).opening_ref;
    const refused = await t.call('vector_build_reputation_stake_open', args);
    assert.match(refused, new RegExp(`^Failed to build stake opening: An opening output that names ${DID} is already at the reputation address\\. Step 2 .* pass allow_second_opening true to build a new opening output.* Listed \\(at most 5, the ones whose owner the record declares first\\): ${ref} \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\)\\. Nothing was built\\.\\n\\n\\*\\*Troubleshooting Tips`));
    assert.match(refused, /\*\*Troubleshooting Tips:\*\*[\s\S]*When an opening output already names the agent, pass it to vector_build_reputation_stake as opening_ref; allow_second_opening builds another one/);
    const second = await t.call('vector_build_reputation_stake_open', { ...args, allow_second_opening: true });
    assert.ok(second.startsWith('# Reputation Stake Opening Built'));
    assert.ok(second.includes(`**Other opening outputs:** \`${ref}\` (each locks its AP3X until a CreateStake spends it)`));
    assert.deepEqual(jsonOf(second).other_openings, [ref]);
    assert.equal(jsonOf(second).other_openings_more, 0);
    assert.notEqual(jsonOf(second).opening_ref, ref);
  });

  test('7 opening outputs, 2 with an owner that the record declares: the refusal keeps the way out in the text that an error shows, and the row and the JSON list 5 and count the 2 more', async () => {
    const opening = (byte: string, owner: string): UTxO => ({
      txHash: byte.repeat(32), outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 2_000_000n },
      datum: encodeStakeDatum({ agent_did: AGENT2_ID, owner_pkh: owner, stake_amount: 2_000_000n, staked_capabilities: [], last_updated: NOW, history_points: 0n, challenge_locks: [], stake_id: { txHash: '00'.repeat(32), outputIndex: 0 } }),
    });
    // The record of the second agent declares CONTROLLER (its controller key) and LISTED (a listed key with the transaction purpose); the node lists these two last.
    const openings = [STRANGER, AUTH_ONLY, STRANGER, REPLACEMENT, STRANGER, LISTED, CONTROLLER].map((key, i) => opening(`c${i + 1}`, key.keyHash));
    const t = setup(new World(openings));
    const args = { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, owner_key_hash: LISTED.keyHash };
    const refused = await t.call('vector_build_reputation_stake_open', args);
    const shown = refused.slice(0, refused.indexOf('\n\n**Troubleshooting Tips:**'));
    assert.ok(shown.includes('pass allow_second_opening true to build a new opening output'), 'the way out is in the text that the error keeps');
    assert.ok(shown.includes(`${openings[5].txHash}#0 (2.000000 AP3X, owner ${LISTED.keyHash})`), 'the first entry of the list is an output with a declared owner');
    const built = await t.call('vector_build_reputation_stake_open', { ...args, allow_second_opening: true });
    const refs = [5, 6, 0, 1, 2].map((i) => `${openings[i].txHash}#0`);
    assert.deepEqual(jsonOf(built).other_openings, refs);
    assert.equal(jsonOf(built).other_openings_more, 2);
    assert.ok(built.includes(`**Other opening outputs:** ${refs.map((ref) => `\`${ref}\``).join(', ')} and 2 more (each locks its AP3X until a CreateStake spends it)`));
    // One output more than the bound: the row and the JSON count it.
    const six = await setup(new World(openings.slice(0, 6))).call('vector_build_reputation_stake_open', { ...args, allow_second_opening: true });
    const sixRefs = [5, 0, 1, 2, 3].map((i) => `${openings[i].txHash}#0`);
    assert.deepEqual(jsonOf(six).other_openings, sixRefs);
    assert.equal(jsonOf(six).other_openings_more, 1);
    assert.ok(six.includes(`**Other opening outputs:** ${sixRefs.map((ref) => `\`${ref}\``).join(', ')} and 1 more (each locks its AP3X until a CreateStake spends it)`));
  });

  test('a text that the chain or the caller supplies is escaped in the markdown: no backtick or pipe breaks a line', async () => {
    const world = new World();
    const t = setup(world);
    const text = await t.call('vector_build_reputation_stake_open', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: ['evil`|cap\nline'] });
    assert.match(text, /^Failed to build stake opening: Capability evil'¦cap line is not in the record of/);
  });
});

describe('vector_get_reputation_stake', () => {
  const rowOf = (agent: string, ref: string, over: Partial<StakeDatum> = {}, lovelace = '10000000') => {
    const datum: StakeDatum = {
      agent_did: agent, owner_pkh: WALLET.keyHash, stake_amount: 10_000_000n, staked_capabilities: STAKE_CAPS.map((c) => Buffer.from(c).toString('hex')), last_updated: NOW + 30 * 60_000,
      history_points: 0n, challenge_locks: [], stake_id: { txHash: 'ab'.repeat(32), outputIndex: 1 }, ...over,
    };
    const [tx, i] = ref.split('#');
    return {
      tx_hash: tx, tx_index: Number(i), address: REPUTATION_ADDRESS, value: lovelace, is_spent: false, inline_datum: { bytes: encodeStakeDatum(datum) },
      asset_list: [{ policy_id: REPUTATION_SCRIPT_HASH, asset_name: stakeTokenName(agent), quantity: '1' }],
    };
  };
  const koiosWith = (rows: unknown[]) => {
    const calls: unknown[] = [];
    const koios: ReputationReadAccess = { koiosUrl: 'https://koios.example', fetchImpl: (async (_url: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return new Response(JSON.stringify(rows)); }) as unknown as typeof fetch };
    return { koios, calls };
  };

  test('lists each stake and the sum of stake_amount, and gives 0 for an agent with no stake', async () => {
    const { koios, calls } = koiosWith([rowOf(AGENT_ID, `${'01'.repeat(32)}#0`), rowOf(AGENT_ID, `${'02'.repeat(32)}#3`, { stake_amount: 12_000_000n, challenge_locks: ['72636c5f01'] }, '12500000')]);
    const { call } = setup(new World(), { koios });
    const text = await call('vector_get_reputation_stake', { dids: [DID, DID2] });
    assert.equal(calls.length, 1, 'one Koios call for both agents');
    assert.ok(text.startsWith(`# Reputation Stakes\n\n**Reputation policy:** \`${REPUTATION_SCRIPT_HASH}\` (stake address \`${REPUTATION_ADDRESS}\`)\n`));
    assert.match(text, /\| `did:vector:a3[0-9a]*` \| 2 \| 22\.000000 \|\n\| `did:vector:a4[0-9a]*` \| 0 \| 0\.000000 \|/);
    assert.match(text, /`[0-9a-f]{64}#3`: 12\.000000 AP3X counted \(12\.500000 AP3X in the output\); capabilities `demo\.text\.stats\.v1`, `demo\.text\.summary\.v1`; last_updated 20\d\d-.*Z; 1 challenge lock\(s\); stake_id `(?:ab){32}#1`; owner `[0-9a-f]{56}`/);
    const j = jsonOf(text);
    assert.equal(j.reputation_policy, REPUTATION_SCRIPT_HASH);
    assert.equal(j.stake_address, REPUTATION_ADDRESS);
    assert.equal(j.agents.length, 2);
    assert.equal(j.agents[0].did, DID);
    assert.equal(j.agents[0].total, '22000000');
    assert.equal(j.agents[0].token_unit, stakeTokenUnit(AGENT_ID));
    assert.equal(j.agents[0].stakes.length, 2);
    assert.deepEqual(j.agents[0].stakes[1], {
      ref: `${'02'.repeat(32)}#3`, stake_amount: '12000000', lovelace: '12500000', capabilities: STAKE_CAPS, last_updated: NOW + 30 * 60_000, challenge_locks: 1,
      stake_id: `${'ab'.repeat(32)}#1`, owner_key_hash: WALLET.keyHash, history_points: '0',
    });
    assert.deepEqual(j.agents[1], { did: DID2, token_unit: stakeTokenUnit(AGENT2_ID), total: '0', stakes: [] });
  });

  test('reads the stake that the tools built: the stake of the chain test, as the index would return it', async () => {
    const world = new World();
    const { t, openJson } = await viaTools(world);
    const created = await t.call('vector_build_reputation_stake', { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, opening_ref: openJson.opening_ref, amount: 11 });
    const j = jsonOf(created);
    const { koios } = koiosWith([rowOf(AGENT_ID, j.stake_ref, { stake_amount: 11_000_000n, last_updated: j.last_updated, owner_pkh: j.owner_key_hash, stake_id: { txHash: openJson.opening_ref.split('#')[0], outputIndex: Number(openJson.opening_ref.split('#')[1]) } }, '11000000')]);
    const text = await setup(world, { koios }).call('vector_get_reputation_stake', { dids: [DID] });
    const r = jsonOf(text);
    assert.equal(r.agents[0].total, '11000000');
    assert.equal(r.agents[0].stakes[0].ref, j.stake_ref);
    assert.equal(r.agents[0].stakes[0].stake_id, j.stake_id);
    assert.equal(r.agents[0].stakes[0].last_updated, j.last_updated);
  });

  test('a failing Koios is an answer that names the operation and the status; an undecodable stake names the output', async () => {
    const down: ReputationReadAccess = { koiosUrl: 'https://koios.example', fetchImpl: (async () => new Response('x', { status: 502 })) as unknown as typeof fetch };
    const text = await setup(new World(), { koios: down }).call('vector_get_reputation_stake', { dids: [DID] });
    assert.match(text, /^Failed to read reputation stakes: Koios asset_utxos answered 502\n\n\*\*Troubleshooting Tips:\*\*\n1\. dids must be identity DIDs/);
    assert.ok(!text.includes('koios.example'));
    const bad = { ...rowOf(AGENT_ID, `${'01'.repeat(32)}#0`), inline_datum: { bytes: 'd8799f01ff' } };
    const text2 = await setup(new World(), { koios: koiosWith([bad]).koios }).call('vector_get_reputation_stake', { dids: [DID] });
    assert.match(text2, new RegExp(`^Failed to read reputation stakes: The stake output ${'01'.repeat(32)}#0 does not decode`));
  });
});

describe('a text of 131,072 characters in an input that the schema does not bound', () => {
  // The time test (input-size-limits.test.ts) cannot reach the build tools: the reputation validator reads the identity registry of mainnet, and
  // the server refuses these tools next to the identity registry of its fixtures. So each input of them without a bound in the schema gets the
  // text here, on the world of these tests, in each shape that the time test uses. The tool must refuse it within one second, with the words
  // of its own check, and the answer must stay short.
  const LIMIT_MS = 1000;
  const SIZE = 131_072;
  const ADDRESS = /Invalid change address: The text has 131072 characters, and an address has at most 1024\./;
  const OUT_REF = /Invalid out ref /;
  const base = { changeAddress: WALLET_ADDRESS, did: DID };
  const places: Array<[string, string, (text: string) => Record<string, unknown>, RegExp]> = [
    ['vector_build_reputation_stake_open', 'changeAddress', (text) => ({ ...base, changeAddress: text, capabilities: STAKE_CAPS }), ADDRESS],
    ['vector_build_reputation_stake', 'changeAddress', (text) => ({ ...base, changeAddress: text, capabilities: STAKE_CAPS, opening_ref: `${'aa'.repeat(32)}#0` }), ADDRESS],
    ['vector_build_reputation_stake', 'opening_ref', (text) => ({ ...base, capabilities: STAKE_CAPS, opening_ref: text }), OUT_REF],
    ['vector_build_reputation_stake_increase', 'changeAddress', (text) => ({ ...base, changeAddress: text, amount: 1 }), ADDRESS],
    ['vector_build_reputation_stake_increase', 'stake_ref', (text) => ({ ...base, amount: 1, stake_ref: text }), OUT_REF],
    ['vector_build_reputation_stake_update_capabilities', 'changeAddress', (text) => ({ ...base, changeAddress: text, capabilities: STAKE_CAPS }), ADDRESS],
    ['vector_build_reputation_stake_update_capabilities', 'stake_ref', (text) => ({ ...base, capabilities: STAKE_CAPS, stake_ref: text }), OUT_REF],
    ['vector_build_reputation_stake_decrease', 'changeAddress', (text) => ({ ...base, changeAddress: text, amount: 1 }), ADDRESS],
    ['vector_build_reputation_stake_decrease', 'stake_ref', (text) => ({ ...base, amount: 1, stake_ref: text }), OUT_REF],
  ];
  for (const [name, input, args, refusal] of places) {
    test(`${name}: ${input} of ${SIZE} characters, in each shape, is refused within ${LIMIT_MS} ms`, async () => {
      const { call } = setup(new World());
      const slow: string[] = [];
      for (const shape of [...SHAPES, ...LEVEL_SHAPES]) {
        const started = performance.now();
        const answer = await call(name, args(shape.make(SIZE)));
        const ms = performance.now() - started;
        assert.match(answer, refusal, `${shape.name}: ${answer.slice(0, 200)}`);
        assert.ok(answer.length < 1500, `${shape.name}: the answer has ${answer.length} characters`);
        if (ms > LIMIT_MS) slow.push(`${shape.name}: ${Math.round(ms)} ms`);
      }
      assert.deepEqual(slow, []);
    });
  }
});
