// packages/builder/test/self-improvement-tools.test.ts
// Handler-level tests of the self-improvement (Module-6) tools: registerSelfImprovementTools with a minimal fake server that checks
// the arguments with each tool's zod schema (as the MCP server does) and calls the handler. The node is the offline Module-6 world
// (gov-world.ts): the applied Module-6 validators run on every step 2. The deployments, Koios and the clock come from the test. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod/v4';
import type { UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSelfImprovementTools } from '../src/vector/self-improvement.ts';
import type { SelfImprovementDeps } from '../src/vector/self-improvement.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { IdentityConfigError, NOT_CONFIGURED } from '../src/vector/identity-deployment.ts';
import { GOV_NOT_CONFIGURED, GovConfigError, PREVIOUS_GOV_DEPLOYMENT, scriptAddress } from '../src/vector/gov-deployment.ts';
import type { KoiosAccess } from '../src/vector/gov-deployment.ts';
import {
  deriveActivityTokenName, deriveCritiqueTokenName, deriveEndorsementTokenName, deriveProposalTokenName, encodeCritiqueDatum, encodeEndorsementDatum,
  encodeProposalDatum,
} from '../src/vector/gov-codec.ts';
import type { CritiqueDatum, ProposalDatum } from '../src/vector/gov-codec.ts';
import { utf8Hex } from '../src/vector/identity-codec.ts';
import { DEPLOYMENT, NOW, DAY, CONTROLLER, OWN_ADDRESS } from './fixtures/identity-world.ts';
import { FixtureProvider, FIXTURE_UTXOS } from './fixtures/fixture-provider.ts';
import {
  CRITIC_CONTROLLER, CRITIC_ID, ENDORSER_CONTROLLER, ENDORSER_ID, GOV, PROPOSER_ID, govWorld, headUtxo, lockUtxo, proposalUtxo,
} from './fixtures/gov-world.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
type Tool = { shape: z.ZodRawShape; handler: Handler };
const serverOf = (into: Map<string, Tool>) => ({
  tool: (name: string, _description: string, shape: z.ZodRawShape, handler: Handler) => { into.set(name, { shape, handler }); },
}) as unknown as McpServer;

const NO_KOIOS: KoiosAccess = { url: 'https://koios.example', fetchImpl: (async () => { throw new Error('Koios is not part of this test'); }) as unknown as typeof fetch };
const lo = NOW - 60_000;

/** The self-improvement tools on `world`; a call checks the arguments against the tool's schema first, as the MCP server does. */
function tools(world: () => FixtureProvider, deps: SelfImprovementDeps = {}) {
  const registered = new Map<string, Tool>();
  registerSelfImprovementTools(serverOf(registered), 'self-improvement-tools-test', {
    provider: world, limiter: new RateLimiter(100_000), gov: () => GOV, identity: () => DEPLOYMENT, koios: NO_KOIOS, now: () => NOW, ...deps,
  });
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = registered.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const parsed = z.object(tool.shape).safeParse(args);
    if (!parsed.success) return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    return (await tool.handler(parsed.data as Record<string, unknown>)).content[0].text;
  };
  return { call, names: [...registered.keys()] };
}
/** The JSON block of a tool answer. */
const jsonOf = (answer: string): Record<string, unknown> => JSON.parse(answer.slice(answer.lastIndexOf('```json\n') + 8, answer.lastIndexOf('\n```')));
const signersOf = (answer: string): string[] => (jsonOf(answer).required_signers as Array<{ key_hash: string }>).map((s) => s.key_hash);

const seed = { txHash: '5e'.repeat(32), outputIndex: 0 };
const datum = (o: Partial<ProposalDatum> = {}): ProposalDatum => ({
  proposerDid: PROPOSER_ID, proposerCredential: { type: 'VerificationKey', hash: CONTROLLER.keyHash }, proposalHash: 'ab'.repeat(32),
  proposalType: { type: 'GeneralSuggestion' }, storageUri: utf8Hex('ipfs://proposal'), stakeAmount: 25_000_000n, submittedAt: NOW - DAY,
  reviewWindow: 604_800_000, priority: 'Standard', amendmentCount: 0, incorporatedCritiques: [], state: { type: 'Open' }, ...o,
});
const PROPOSAL = proposalUtxo(seed, datum(), { txHash: 'f1'.repeat(32), outputIndex: 0 });

const BUILD_TOOLS = [
  'vector_build_self_improvement_proposal_lock', 'vector_build_self_improvement_proposal_spend', 'vector_build_self_improvement_critique',
  'vector_build_self_improvement_critique_spend', 'vector_build_self_improvement_endorse', 'vector_build_self_improvement_endorse_spend',
];

describe('the self-improvement tools', () => {
  test('two read tools and six build tools (a lock and a creation for proposals, critiques and endorsements)', () => {
    assert.deepEqual(tools(() => govWorld()).names.sort(), [...BUILD_TOOLS, 'vector_self_improvement_analyze_metrics', 'vector_self_improvement_browse'].sort());
  });

  test('without a Module-6 deployment every build tool and the current read tools say which GOV_* variables to set', async () => {
    const { call } = tools(() => govWorld(), { gov: () => { throw new GovConfigError(GOV_NOT_CONFIGURED); } });
    const args: Record<string, Record<string, unknown>> = {
      vector_build_self_improvement_proposal_lock: { changeAddress: OWN_ADDRESS, agentDid: PROPOSER_ID, proposalType: 'GeneralSuggestion', stakeApex: 25, proposalHash: 'ab'.repeat(32), storageUri: 'x' },
      vector_build_self_improvement_proposal_spend: { changeAddress: OWN_ADDRESS, agentDid: PROPOSER_ID, lockTxHash: 'aa'.repeat(32) },
      vector_build_self_improvement_critique: { changeAddress: OWN_ADDRESS, agentDid: CRITIC_ID, proposalTxHash: seed.txHash, critiqueType: 'Supportive', stakeApex: 10, critiqueHash: 'cd'.repeat(32), storageUri: 'x' },
      vector_build_self_improvement_critique_spend: { changeAddress: OWN_ADDRESS, agentDid: CRITIC_ID, lockTxHash: 'aa'.repeat(32) },
      vector_build_self_improvement_endorse: { changeAddress: OWN_ADDRESS, agentDid: ENDORSER_ID, proposalTxHash: seed.txHash, stakeApex: 5 },
      vector_build_self_improvement_endorse_spend: { changeAddress: OWN_ADDRESS, agentDid: ENDORSER_ID, lockTxHash: 'aa'.repeat(32) },
    };
    for (const name of BUILD_TOOLS) assert.match(await call(name, args[name]), /^Failed to .*Module-6 deployment on the identity registry is not configured on this server: set GOV_PROPOSAL_SPEND_HASH/, name);
    assert.match(await call('vector_self_improvement_browse', { entity: 'proposals' }), /^Failed to browse proposal data: .*not configured.*deployment: 'previous'/);
    assert.match(await call('vector_self_improvement_analyze_metrics', {}), /^Failed to analyze proposal metrics: .*not configured/);
  });

  test('without an identity deployment the build tools name the identity variables', async () => {
    const { call } = tools(() => govWorld(), { identity: () => { throw new IdentityConfigError(NOT_CONFIGURED); } });
    const answer = await call('vector_build_self_improvement_proposal_spend', { changeAddress: OWN_ADDRESS, agentDid: PROPOSER_ID, lockTxHash: 'aa'.repeat(32) });
    assert.match(answer, /VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/);
  });

  test('the schemas: a lock hash is 64 hex characters, the credential a key hash, the stake at least the wire minimum', async () => {
    const { call } = tools(() => govWorld([headUtxo()]));
    assert.match(await call('vector_build_self_improvement_proposal_spend', { changeAddress: OWN_ADDRESS, agentDid: PROPOSER_ID, lockTxHash: 'abc' }), /^Invalid arguments: lockTxHash/);
    assert.match(await call('vector_build_self_improvement_endorse', { changeAddress: OWN_ADDRESS, agentDid: ENDORSER_ID, proposalTxHash: seed.txHash, stakeApex: 5, credentialKeyHash: 'xyz' }), /^Invalid arguments: credentialKeyHash/);
    assert.match(await call('vector_build_self_improvement_critique', { changeAddress: OWN_ADDRESS, agentDid: CRITIC_ID, proposalTxHash: seed.txHash, critiqueType: 'Supportive', stakeApex: 9 }), /^Invalid arguments: stakeApex/);
  });
});

describe('a proposal through the tools: lock, then the creation with the activity list', () => {
  test('step 1 answers with the lock output, the declared credential and the call of step 2', async () => {
    const { call } = tools(() => govWorld([headUtxo()]));
    const answer = await call('vector_build_self_improvement_proposal_lock', {
      changeAddress: OWN_ADDRESS, agentDid: `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${PROPOSER_ID}`,
      credentialKeyHash: CONTROLLER.keyHash, proposalType: 'GeneralSuggestion', stakeApex: 25, proposalHash: 'ab'.repeat(32), storageUri: 'ipfs://proposal',
    });
    assert.match(answer, /^# Proposal Lock Built, Step 1 of 2 \(Unsigned, Not Submitted\)/);
    const json = jsonOf(answer);
    assert.equal(json.step, 1);
    assert.equal(json.agent_did, `did:vector:${PROPOSER_ID}`);
    assert.equal(json.credential_key_hash, CONTROLLER.keyHash);
    assert.equal(json.first_proposal, true);
    assert.equal(json.lock_tx_hash, json.tx_hash);
    assert.equal(json.stake_lovelace, '25000000');
    assert.equal(signersOf(answer).length, 1, 'only the wallet signs a lock');
    assert.match(answer, new RegExp(`call vector_build_self_improvement_proposal_spend \\{ changeAddress, agentDid: "did:vector:${PROPOSER_ID}", lockTxHash: "${json.tx_hash}", lockOutputIndex: ${json.lock_output_index} \\}`));
    assert.match(answer, /leaves the validator only through that submission/);
  });

  test('step 2 inserts the node after the head, mints the proposal and activity tokens, and the credential signs', async () => {
    const locked = lockUtxo(GOV.proposalAddress, encodeProposalDatum(datum({ submittedAt: lo })), 27_000_000n);
    const { call } = tools(() => govWorld([headUtxo(), locked]));
    const answer = await call('vector_build_self_improvement_proposal_spend', { changeAddress: OWN_ADDRESS, agentDid: `did:vector:${PROPOSER_ID}`, lockTxHash: locked.txHash });
    assert.match(answer, /^# Proposal Submission Built, Step 2 of 2 \(Unsigned, Not Submitted\)/);
    const json = jsonOf(answer);
    assert.equal(json.seed, `${locked.txHash}#0`);
    assert.equal(json.proposal_token_name, deriveProposalTokenName(locked.txHash, 0));
    assert.equal(json.activity_token_name, deriveActivityTokenName(PROPOSER_ID));
    assert.equal(json.inserted, true);
    assert.equal(json.predecessor, 'head');
    assert.deepEqual(signersOf(answer).slice(0, 1), [CONTROLLER.keyHash]);
    assert.match(answer, /Each key holder in the list signs in turn/);
  });

  test('a refusal names the rule and the tips', async () => {
    const locked = lockUtxo(GOV.proposalAddress, encodeProposalDatum(datum()), 27_000_000n);
    const { call } = tools(() => govWorld([locked]));
    const answer = await call('vector_build_self_improvement_proposal_spend', { changeAddress: OWN_ADDRESS, agentDid: PROPOSER_ID, lockTxHash: locked.txHash });
    assert.match(answer, /^Failed to build proposal submission: No head of the activity list/);
    assert.match(answer, /Confirm the lock transaction first with vector_await_transaction/);
  });
});

describe('a critique and an endorsement through the tools', () => {
  test('a critique: step 1 names the seed of the proposal, step 2 mints crit_ of the lock', async () => {
    const one = tools(() => govWorld([PROPOSAL]));
    const answer = await one.call('vector_build_self_improvement_critique', {
      changeAddress: OWN_ADDRESS, agentDid: CRITIC_ID, credentialKeyHash: CRITIC_CONTROLLER.keyHash, proposalTxHash: seed.txHash,
      critiqueType: 'Opposing', stakeApex: 10, critiqueHash: 'cd'.repeat(32), storageUri: 'ipfs://critique',
    });
    assert.match(answer, /^# Critique Lock Built, Step 1 of 2/);
    assert.equal(jsonOf(answer).seed, `${seed.txHash}#0`);
    assert.equal(jsonOf(answer).proposal, `${PROPOSAL.txHash}#0`);
    const critique: CritiqueDatum = {
      criticDid: CRITIC_ID, criticCredential: { type: 'VerificationKey', hash: CRITIC_CONTROLLER.keyHash }, proposalRef: seed, critiqueHash: 'cd'.repeat(32),
      storageUri: utf8Hex('ipfs://critique'), critiqueType: { type: 'Opposing' }, stakeAmount: 10_000_000n, submittedAt: lo, incorporated: false,
    };
    const locked = lockUtxo(GOV.critiqueAddress, encodeCritiqueDatum(critique), 12_000_000n);
    const two = tools(() => govWorld([PROPOSAL, locked]));
    const created = await two.call('vector_build_self_improvement_critique_spend', { changeAddress: OWN_ADDRESS, agentDid: CRITIC_ID, lockTxHash: locked.txHash });
    assert.match(created, /^# Critique Built, Step 2 of 2/);
    assert.equal(jsonOf(created).token_name, deriveCritiqueTokenName(locked.txHash, 0));
    assert.deepEqual(signersOf(created)[0], CRITIC_CONTROLLER.keyHash);
  });

  test('an endorsement: step 2 mints gend_ of the endorser and the seed', async () => {
    const locked = lockUtxo(GOV.endorsementAddress, encodeEndorsementDatum({
      endorserDid: ENDORSER_ID, endorserCredential: { type: 'VerificationKey', hash: ENDORSER_CONTROLLER.keyHash }, proposalRef: seed, stakeAmount: 5_000_000n, createdAt: lo,
    }), 7_000_000n);
    const { call } = tools(() => govWorld([PROPOSAL, locked]));
    const answer = await call('vector_build_self_improvement_endorse_spend', { changeAddress: OWN_ADDRESS, agentDid: ENDORSER_ID, lockTxHash: locked.txHash });
    assert.match(answer, /^# Endorsement Built, Step 2 of 2/);
    assert.equal(jsonOf(answer).token_name, deriveEndorsementTokenName(ENDORSER_ID, seed));
    const lockAnswer = await call('vector_build_self_improvement_endorse', { changeAddress: OWN_ADDRESS, agentDid: PROPOSER_ID, credentialKeyHash: CONTROLLER.keyHash, proposalTxHash: seed.txHash, stakeApex: 5 });
    assert.match(lockAnswer, /^Failed to build endorsement: .*an agent cannot endorse its own proposal/);
  });
});

describe('the read tools', () => {
  const critiqueOf = (ref: { txHash: string; outputIndex: number }, txHash: string): UTxO => ({
    ...lockUtxo(GOV.critiqueAddress, encodeCritiqueDatum({
      criticDid: CRITIC_ID, criticCredential: { type: 'VerificationKey', hash: CRITIC_CONTROLLER.keyHash }, proposalRef: ref, critiqueHash: 'cd'.repeat(32),
      storageUri: utf8Hex('ipfs://critique'), critiqueType: { type: 'Supportive' }, stakeAmount: 10_000_000n, submittedAt: lo, incorporated: false,
    }), 12_000_000n, txHash),
  });
  const created = (u: UTxO): UTxO => ({ ...u, assets: { ...u.assets, [`${GOV.critiqueMint}${deriveCritiqueTokenName(u.txHash, 0)}`]: 1n } });
  const ofProposal = created(critiqueOf(seed, 'c2'.repeat(32)));
  const ofOther = created(critiqueOf({ txHash: '6e'.repeat(32), outputIndex: 0 }, 'c3'.repeat(32)));
  const uncreated = critiqueOf(seed, 'c4'.repeat(32));
  const lock = lockUtxo(GOV.proposalAddress, encodeProposalDatum(datum({ proposerDid: CRITIC_ID })), 27_000_000n);
  const world = () => govWorld([headUtxo(), PROPOSAL, lock, ofProposal, ofOther, uncreated]);

  test('browse lists the created proposals of the current deployment (not the locks), by any DID form of the proposer', async () => {
    const { call } = tools(world);
    const answer = await call('vector_self_improvement_browse', { entity: 'proposals' });
    assert.match(answer, /^# Improvement Proposals \(1 found, current deployment\)/);
    assert.match(answer, new RegExp(`\\*\\*Proposer:\\*\\* did:vector:${PROPOSER_ID}`));
    assert.match(answer, /\*\*Submitted:\*\* 2026-11-14T12:00:00\.000Z/);
    assert.match(answer, /\*\*Review Window:\*\* 7\.0 days/);
    assert.match(answer, /\*\*Storage:\*\* ipfs:\/\/proposal/);
    assert.match(await call('vector_self_improvement_browse', { entity: 'proposals', proposerDid: `did:vector:${CRITIC_ID}` }), /^No proposals found on-chain \(current deployment\)\./);
    assert.match(await call('vector_self_improvement_browse', { entity: 'proposals', proposerDid: PROPOSER_ID, state: 'Open' }), /1 found/);
  });

  test('browse lists created critiques; the proposal filter takes the seed transaction or the current output transaction', async () => {
    const { call } = tools(world);
    const all = await call('vector_self_improvement_browse', { entity: 'critiques' });
    assert.match(all, /^# Critiques \(2 found, current deployment\)/);
    for (const proposalTxHash of [seed.txHash, PROPOSAL.txHash]) {
      const answer = await call('vector_self_improvement_browse', { entity: 'critiques', proposalTxHash });
      assert.match(answer, /^# Critiques \(1 found/, proposalTxHash);
      assert.match(answer, new RegExp(`\\*\\*UTxO:\\*\\* ${ofProposal.txHash}#0`));
    }
  });

  test('metrics count the created proposals; the treasury is read at the treasury address', async () => {
    const treasury: UTxO = { txHash: '7e'.repeat(32), outputIndex: 0, address: GOV.treasuryAddress, assets: { lovelace: 3_000_000_000n } };
    const { call } = tools(() => govWorld([headUtxo(), PROPOSAL, lock, treasury]));
    const metrics = await call('vector_self_improvement_analyze_metrics', {});
    assert.match(metrics, /- \*\*Total on-chain:\*\* 1\n/);
    assert.match(metrics, /- Open: 1/);
    assert.match(metrics, /\*\*Balance:\*\* 3000\.000000 AP3X/);
    assert.match(await call('vector_self_improvement_browse', { entity: 'treasury' }), /\*\*Total:\*\* 3000\.000000 AP3X/);
  });

  test("deployment: 'previous' reads the deployment before the identity registry, also without the GOV_* settings", async () => {
    const sample = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/gov-state.fixture.json'), 'utf8')).sampleProposal;
    const old: UTxO = {
      txHash: sample.txHash, outputIndex: sample.index, address: scriptAddress(PREVIOUS_GOV_DEPLOYMENT.proposalSpend),
      assets: { lovelace: 27_000_000n, [sample.tokenUnit]: 1n }, datum: sample.datumCbor,
    };
    const { call } = tools(() => new FixtureProvider([...FIXTURE_UTXOS, old]), { gov: () => { throw new GovConfigError(GOV_NOT_CONFIGURED); } });
    const answer = await call('vector_self_improvement_browse', { entity: 'proposals', deployment: 'previous' });
    assert.match(answer, /^# Improvement Proposals \(1 found, previous deployment \(read-only; its positions stay until their owners exit\)\)/);
    assert.match(answer, new RegExp(`\\*\\*UTxO:\\*\\* ${sample.txHash}#0`));
    assert.match(await call('vector_self_improvement_analyze_metrics', { deployment: 'previous', focus: 'treasury' }), new RegExp(`\\*\\*Address:\\*\\* ${PREVIOUS_GOV_DEPLOYMENT.treasuryAddress}`));
  });
});
