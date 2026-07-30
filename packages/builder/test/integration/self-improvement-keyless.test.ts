import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CML } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, ServerContext } from '../setup.ts';
import {
  scriptHashToAddress, GOV_CRITIQUE_SPEND_HASH, GOV_ENDORSEMENT_SPEND_HASH, GOV_PROPOSAL_SPEND_HASH,
  parseProposalDatum,
} from '../../src/vector/gov-build.ts';

// Tier-1 self-improvement integration: LIVE testnet, ZERO secrets. Build-only -
// nothing is signed, nothing is submitted, no funds move. critique, endorse,
// and proposal_lock are all plain locks (a single unsigned payment to a
// script address, no script spend), so this tier can fully exercise their
// datum-construction path against real chain data (a live-discovered agent
// DID and a live-discovered proposal UTxO) with zero risk. The validated
// spend+mint path (buildProposalSpend's POSITIVE case) requires a CONFIRMED
// lock transaction to reference - that is E2E territory
// (self-improvement-e2e.test.ts); this file only covers proposal_spend's
// build-time failure path (no secrets needed to prove a not-found error).
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
function decodeTx(cborHex: string) {
  return CML.Transaction.from_cbor_hex(cborHex);
}
function findOutputTo(tx: ReturnType<typeof decodeTx>, address: string) {
  const outs = tx.body().outputs();
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    if (o.address().to_bech32() === address) return o;
  }
  return null;
}

describe('self-improvement keyless tier-1 (live testnet, no secrets)', () => {
  // NOTE (found running this live, not a typo): the self-improvement family's
  // "agentDid" wire param is NOT the full `did:vector:agent:{policyId}:
  // {nftAssetName}` string the registry family's agent_id means (that one
  // gets split via registry-build.ts's parseDid()) - it is JUST the trailing
  // hex asset-name segment (schema description: "Agent DID (hex) - the asset
  // name from Agent Registry NFT"; confirmed in gov-build.ts's
  // buildProposalSpend, which concatenates it directly onto
  // AGENT_REGISTRY_POLICY to form an asset unit). This is pre-existing,
  // inherited verbatim from the custodial code (verified against commit
  // 8162673, before Task 5's keyless rewrite) - not something introduced or
  // fixable in this task. Passing the FULL DID string here throws
  // "Could not serialize the data: ... hex string expected, got non-hex
  // character \"di\" at index 0" (Lucid's Data.to treats the string field as
  // a ByteArray - reproduced live before this comment was written). Flagged
  // as a naming-consistency minor in the task report; tests below use the
  // correct (asset-name-only) value.
  let liveAgentAssetName: string | null = null;
  let liveProposalTxHash: string | null = null;
  let liveProposalOutputIndex = 0;

  test('discover a live agent DID to reference in builds', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_discover_agents', { limit: 3 });
    const m = text.match(/did:vector:agent:([a-f0-9]+):([a-f0-9]+)/);
    assert.ok(m, `no DID found in discovery output - is the testnet registry empty?\n${text.slice(0, 500)}`);
    liveAgentAssetName = m![2];
  });

  test('vector_self_improvement_browse (proposals) returns live proposals and yields a real UTxO ref', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_self_improvement_browse', { entity: 'proposals' });
    const countMatch = text.match(/Improvement Proposals \((\d+) found\)/);
    assert.ok(countMatch, `no proposal count header:\n${text.slice(0, 500)}`);
    assert.ok(Number(countMatch![1]) >= 1, `expected at least 1 live proposal (recon showed 25+), got ${countMatch![1]}`);
    const refMatch = text.match(/\*\*UTxO:\*\*\s*([0-9a-f]{64})#(\d+)/);
    assert.ok(refMatch, `no proposal UTxO ref found in the response:\n${text.slice(0, 800)}`);
    liveProposalTxHash = refMatch![1];
    liveProposalOutputIndex = parseInt(refMatch![2], 10);
  });

  test('vector_self_improvement_analyze_metrics renders proposal metrics and treasury', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_self_improvement_analyze_metrics', {});
    assert.match(text, /# Proposal Metrics/);
    assert.match(text, /## Proposals/);
    assert.match(text, /## Treasury/);
    // Markdown-bold label: "**Balance:** 387.000000 AP3X" - two literal '*'
    // sit between the label and the value (same gotcha documented in
    // registry-keyless.test.ts), so \s* alone right after "Balance:" doesn't
    // cover it. Verified against the actual live response before widening.
    assert.match(text, /Balance:\*{0,2}\s*[\d.]+\s*AP3X/);
  });

  test('vector_build_self_improvement_critique builds an unsigned lock against the live proposal (stake 10 -> 12 AP3X)', { timeout: 120_000 }, async () => {
    assert.ok(liveAgentAssetName && liveProposalTxHash, 'needs the DID and proposal ref from earlier tests');
    const text = await callTool(ctx.client, 'vector_build_self_improvement_critique', {
      changeAddress: OWN_ADDRESS, agentDid: liveAgentAssetName!, proposalTxHash: liveProposalTxHash!, proposalOutputIndex: liveProposalOutputIndex,
      critiqueType: 'Supportive', stakeApex: 10, critiqueHash: 'c1'.repeat(32), storageUri: 'ipfs://tier1-placeholder',
    });
    assertBuildNotSubmitted(text);

    const tx = decodeTx(extractCbor(text));
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'critique build must be unsigned');

    const critiqueAddress = scriptHashToAddress(GOV_CRITIQUE_SPEND_HASH);
    const out = findOutputTo(tx, critiqueAddress);
    assert.ok(out, `no output to the critique address ${critiqueAddress}`);
    assert.equal(out!.amount().coin(), 12_000_000n, 'output must be stake (10 AP3X) + 2 AP3X module minimum');
  });

  test('vector_build_self_improvement_endorse builds an unsigned lock against the live proposal (stake 5 -> 7 AP3X)', { timeout: 120_000 }, async () => {
    assert.ok(liveAgentAssetName && liveProposalTxHash, 'needs the DID and proposal ref from earlier tests');
    const text = await callTool(ctx.client, 'vector_build_self_improvement_endorse', {
      changeAddress: OWN_ADDRESS, agentDid: liveAgentAssetName!, proposalTxHash: liveProposalTxHash!, proposalOutputIndex: liveProposalOutputIndex,
      stakeApex: 5,
    });
    assertBuildNotSubmitted(text);

    const tx = decodeTx(extractCbor(text));
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'endorse build must be unsigned');

    const endorseAddress = scriptHashToAddress(GOV_ENDORSEMENT_SPEND_HASH);
    const out = findOutputTo(tx, endorseAddress);
    assert.ok(out, `no output to the endorsement address ${endorseAddress}`);
    assert.equal(out!.amount().coin(), 7_000_000n, 'output must be stake (5 AP3X) + 2 AP3X module minimum');
  });

  test('vector_build_self_improvement_proposal_lock builds an unsigned lock (GeneralSuggestion, stake 25 -> 27 AP3X) and announces the two-step handoff', { timeout: 120_000 }, async () => {
    assert.ok(liveAgentAssetName, 'needs the DID from discovery');
    const text = await callTool(ctx.client, 'vector_build_self_improvement_proposal_lock', {
      changeAddress: OWN_ADDRESS, agentDid: liveAgentAssetName!,
      proposalType: 'GeneralSuggestion', stakeApex: 25,
      proposalHash: 'a5'.repeat(32), storageUri: 'ipfs://tier1-placeholder-proposal',
    });
    assertBuildNotSubmitted(text);

    // The two-step handoff must be explicit in the copy: this is step 1 of 2,
    // and the response must name the counterpart tool + the lockTxHash param
    // the agent needs to complete the submission after confirmation.
    assert.match(text, /step 1 of 2/);
    assert.match(text, /vector_build_self_improvement_proposal_spend[\s\S]{0,120}lockTxHash/,
      'response must name the counterpart tool alongside the lockTxHash param it expects');

    const tx = decodeTx(extractCbor(text));
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'proposal lock build must be unsigned');

    const proposalAddress = scriptHashToAddress(GOV_PROPOSAL_SPEND_HASH);
    const out = findOutputTo(tx, proposalAddress);
    assert.ok(out, `no output to the proposal address ${proposalAddress}`);
    assert.equal(out!.amount().coin(), 27_000_000n, 'output must be stake (25 AP3X) + 2 AP3X module minimum');
    assert.ok(out!.datum() && out!.datum()!.kind() === 1, 'continuing datum must be inline');

    const datumCbor = out!.datum()!.as_datum()!.to_cbor_hex();
    const parsed = parseProposalDatum(datumCbor);
    assert.ok(parsed, 'built proposal datum failed to parse back');
    assert.equal(parsed!.state, 'Open');
    assert.equal(parsed!.proposalType, 'GeneralSuggestion');
    assert.equal(parsed!.proposerDid, liveAgentAssetName);
    assert.equal(parsed!.stakeAmount, 25_000_000);
  });

  test('vector_build_self_improvement_proposal_spend on an unknown lockTxHash fails fast with the await-first error', { timeout: 30_000 }, async () => {
    assert.ok(liveAgentAssetName, 'needs the DID from discovery');
    const t0 = Date.now();
    const bogusLockTxHash = randomBytes(32).toString('hex');
    const text = await callTool(ctx.client, 'vector_build_self_improvement_proposal_spend', {
      changeAddress: OWN_ADDRESS, agentDid: liveAgentAssetName!, lockTxHash: bogusLockTxHash,
    });
    // One real UTxO lookup happens here (getUtxosByOutRef against Ogmios),
    // so this cannot be as fast as the fully-local changeAddress check below
    // - bounded generously to still catch a hang/retry-storm regression.
    assert.ok(Date.now() - t0 < 30_000, 'a not-found outref lookup should not be slow');
    assert.match(text, /Locked proposal UTxO not found/);
    assert.match(text, /vector_await_transaction/, 'error should point the agent at the await-first recovery step');
  });

  test('a bogus changeAddress fails fast with a clear local validation error (<5s)', { timeout: 30_000 }, async () => {
    const t0 = Date.now();
    const text = await callTool(ctx.client, 'vector_build_self_improvement_critique', {
      changeAddress: 'addr1garbage', agentDid: liveAgentAssetName || 'ab'.repeat(32), proposalTxHash: liveProposalTxHash || '11'.repeat(32),
      proposalOutputIndex: 0, critiqueType: 'Supportive', stakeApex: 10, critiqueHash: 'c1'.repeat(32), storageUri: 'ipfs://x',
    });
    assert.match(text, /Invalid change address/);
    assert.ok(Date.now() - t0 < 5_000, 'address validation should not have hit the network');
  });
});
