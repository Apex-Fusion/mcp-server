import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CML, Data, Constr } from '@lucid-evolution/lucid';
import type { LucidEvolution } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  GOV_PROPOSAL_SPEND_HASH, GOV_CRITIQUE_SPEND_HASH, GOV_ENDORSEMENT_SPEND_HASH,
  MIN_CRITIQUE_STAKE_APEX, MIN_ENDORSE_STAKE_APEX,
  scriptHashToAddress, deriveProposalTokenName,
  parseProposalDatum, parseCritiqueDatum, parseEndorsementDatum,
  buildCritique, buildEndorse,
} from '../src/vector/gov-build.ts';

// Deployed-state fixture, captured live from Vector testnet by
// scripts/capture-gov-state.mjs (2026-07-30) - see that file for the capture
// and validation logic. `sampleProposal.datumCbor` is a REAL chain datum;
// `goldenTokenPin` is the audit-#10 evidence (recomputed at capture time from
// the sample's own producing transaction).
const FIXTURE_PATH = resolve(import.meta.dirname!, 'fixtures/gov-state.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as {
  asOf: string;
  refScripts: Array<{ name: string; txHash: string; index: number; scriptCborHex: string; hash: string }>;
  infra: Array<{ name: string; txHash: string; index: number; address: string; valueLovelace: string; datumCbor: string | null }>;
  sampleProposal: { txHash: string; index: number; datumCbor: string; tokenUnit: string };
  goldenTokenPin: { lockTxHash: string; lockOutputIndex: number; expectedTokenName: string };
};

// A FixtureProvider extended with the 2 chain-clock methods OgmiosProvider
// carries but the base Provider interface (and FixtureProvider) do not:
// gov-build's ensureSlotConfig/slotClockOf need getSystemStartMs and
// getNetworkTip. Object.assign onto a real FixtureProvider instance keeps
// every other method (getUtxos, getUtxosByOutRef, ...) working normally -
// only these two are stand-ins. Same zeroTime in every call site so
// ensureSlotConfig's module-level cache can't make test order matter.
const ZERO_TIME_MS = 1_700_000_000_000;
const TIP_SLOT = 1_000_000;
function chainClockProvider(utxos: typeof FIXTURE_UTXOS) {
  return Object.assign(new FixtureProvider(utxos), {
    getSystemStartMs: async () => ZERO_TIME_MS,
    getNetworkTip: async () => ({ slot: TIP_SLOT }),
  });
}

const AGENT_DID = 'ab'.repeat(32);
const PROPOSAL_TX = '11'.repeat(32);

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

let lucid: LucidEvolution;
before(async () => {
  lucid = await lucidForAddress(chainClockProvider(FIXTURE_UTXOS), OWN_ADDRESS);
});

describe('gov-build constants and helpers', () => {
  test('family spend addresses derive to the recon-verified bech32 values', () => {
    assert.equal(
      scriptHashToAddress(GOV_PROPOSAL_SPEND_HASH),
      'addr1w8uptag6wcqz665h86planmq73288czq4nhgt333ln8pxngfzg955',
    );
    assert.equal(
      scriptHashToAddress(GOV_CRITIQUE_SPEND_HASH),
      'addr1w88d2gr5scd0jh3qsgqy6crpkr7yhvc0mmtpl9s9hlpqu4gra6s0g',
    );
    assert.equal(
      scriptHashToAddress(GOV_ENDORSEMENT_SPEND_HASH),
      'addr1w90ugjvy3kzlxq58uk7qh54na9wcwthe003879yqcyh348gvfdvx4',
    );
  });

  // Audit #10 (closed 2026-07-30): deriveProposalTokenName - flat
  // Constr(0, [txHash, idx]) through Lucid's own Data.to - reproduces a token
  // name actually minted on deployed bytecode. Literals below are the full
  // hex captured live by scripts/capture-gov-state.mjs from the producing
  // transaction of a real submitted proposal (spend tx
  // 01ac86ca226e1824762dec15a405bed9a67f99419f7ef283c3424964a23d2fb8, lock
  // input 0b4015bd69ef...#0). Hardcoded (not read from the fixture) so this
  // pin catches drift even if the fixture is ever regenerated incorrectly;
  // the second half of the test cross-checks fixture/pin agreement.
  test('deriveProposalTokenName golden pin matches deployed bytecode (audit #10)', () => {
    const LOCK_TX_HASH = '0b4015bd69ef9e93a7eafdc778433ea1d1acb4f8ab7b2efaa52990b65415e919';
    const LOCK_OUTPUT_INDEX = 0;
    const EXPECTED_TOKEN_NAME = '70726f705f1a38676b49274bb694b9677f8b17af728bb4fca74bfd3572049bfe';

    assert.equal(deriveProposalTokenName(LOCK_TX_HASH, LOCK_OUTPUT_INDEX), EXPECTED_TOKEN_NAME);

    // fixture/pin agreement: the checked-in capture must still say the same thing.
    assert.equal(fixture.goldenTokenPin.lockTxHash, LOCK_TX_HASH);
    assert.equal(fixture.goldenTokenPin.lockOutputIndex, LOCK_OUTPUT_INDEX);
    assert.equal(fixture.goldenTokenPin.expectedTokenName, EXPECTED_TOKEN_NAME);
  });

  test('parseProposalDatum parses the captured REAL chain datum into a populated object', () => {
    const parsed = parseProposalDatum(fixture.sampleProposal.datumCbor);
    assert.ok(parsed, 'fixture sample proposal datum failed to parse');
    assert.ok(
      ['Open', 'Amended', 'Adopted', 'Rejected', 'Expired', 'Withdrawn'].includes(parsed!.state),
      `unexpected state: ${parsed!.state}`,
    );
    assert.ok(
      ['ParameterChange', 'TreasurySpend', 'ProtocolUpgrade', 'GameActivation', 'GeneralSuggestion'].includes(parsed!.proposalType),
      `unexpected proposalType: ${parsed!.proposalType}`,
    );
    assert.equal(typeof parsed!.proposerDid, 'string');
    assert.ok(parsed!.proposerDid.length > 0);
    assert.ok(parsed!.storageUri.startsWith('ipfs://') || parsed!.storageUri.length > 0);
    assert.ok(parsed!.stakeAmount > 0);
  });

  test('parseProposalDatum returns null on garbage, never throws', () => {
    assert.equal(parseProposalDatum('deadbeef'), null);
  });

  test('MIN_CRITIQUE_STAKE_APEX and MIN_ENDORSE_STAKE_APEX match the wire minimums', () => {
    assert.equal(MIN_CRITIQUE_STAKE_APEX, 10);
    assert.equal(MIN_ENDORSE_STAKE_APEX, 5);
  });
});

describe('buildCritique (offline, FixtureProvider)', () => {
  test('builds an unsigned lock tx: stake+2 AP3X to the critique address, datum round-trips', async () => {
    const r = await buildCritique(lucid, {
      agentDid: AGENT_DID,
      proposalTxHash: PROPOSAL_TX,
      proposalOutputIndex: 0,
      critiqueType: 'Supportive',
      stakeApex: 12,
      critiqueHash: 'cd'.repeat(32),
      storageUri: 'ipfs://test-critique-doc',
    });

    assert.equal(r.op, 'critique');
    assert.equal(r.stakeLovelace, '12000000');
    assert.equal(r.scriptAddress, scriptHashToAddress(GOV_CRITIQUE_SPEND_HASH));
    assert.equal(r.proposalRef, `${PROPOSAL_TX}#0`);
    assert.equal(r.ipfsCid, undefined, 'no document was given - no upload should have happened');

    const tx = decodeTx(r.txCbor);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'critique build must be unsigned');
    assert.equal(CML.hash_transaction(tx.body()).to_hex(), r.txHash);

    const critiqueOut = findOutputTo(tx, r.scriptAddress);
    assert.ok(critiqueOut, 'no output to the critique address');
    assert.equal(critiqueOut!.amount().coin(), 14_000_000n, 'output must be stake (12 AP3X) + 2 AP3X');
    assert.ok(critiqueOut!.datum() && critiqueOut!.datum()!.kind() === 1, 'continuing datum must be inline');

    const datumCbor = critiqueOut!.datum()!.as_datum()!.to_cbor_hex();
    const parsed = parseCritiqueDatum(datumCbor);
    assert.ok(parsed, 'built critique datum failed to parse back');
    assert.equal(parsed!.criticDid, AGENT_DID);
    assert.equal(parsed!.critiqueType, 'Supportive');
    assert.equal(parsed!.critiqueHash, 'cd'.repeat(32));
    assert.equal(parsed!.storageUri, 'ipfs://test-critique-doc');
    assert.equal(parsed!.stakeAmount, 12_000_000);
    assert.equal(parsed!.incorporated, false);
    assert.equal(parsed!.proposalRef.fields[0], PROPOSAL_TX);
    assert.equal(Number(parsed!.proposalRef.fields[1]), 0);
  });

  test('Amendment critiqueType embeds the critique hash in the type datum too', async () => {
    const hash = 'ef'.repeat(32);
    const r = await buildCritique(lucid, {
      agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 2,
      critiqueType: 'Amendment', stakeApex: 10, critiqueHash: hash, storageUri: 'ipfs://amend',
    });
    const tx = decodeTx(r.txCbor);
    const critiqueOut = findOutputTo(tx, r.scriptAddress)!;
    const datumCbor = critiqueOut.datum()!.as_datum()!.to_cbor_hex();
    const parsed = parseCritiqueDatum(datumCbor)!;
    assert.equal(parsed.critiqueType, 'Amendment');
    // the parser only surfaces critique_type's constructor index (matches the
    // custodial parser exactly) - decode the raw datum directly to confirm
    // the hash is actually embedded in field 5's payload, not just labeled.
    const raw = Data.from(datumCbor) as Constr<Data>;
    const critiqueTypeField = raw.fields[5] as Constr<Data>;
    assert.equal(critiqueTypeField.index, 2);
    assert.equal(critiqueTypeField.fields[0], hash);
  });

  test('attempts a Filebase upload when critiqueDocument is given (fails clean - not configured in tests)', async () => {
    // No FILEBASE_* env vars are set in this test environment, so a genuine
    // upload attempt must surface the "not configured" error - proving the
    // document path is actually wired up without needing to mock the AWS SDK.
    await assert.rejects(
      buildCritique(lucid, {
        agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0,
        critiqueType: 'Supportive', stakeApex: 12, critiqueDocument: '{"finding":"test"}',
      }),
      /Filebase not configured/,
    );
  });

  test('stake minimum is validated BEFORE any Filebase upload attempt', async () => {
    // If validation order were wrong, this would fail with the Filebase
    // error instead (critiqueDocument is provided, stake is not).
    await assert.rejects(
      buildCritique(lucid, {
        agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0,
        critiqueType: 'Supportive', stakeApex: 1, critiqueDocument: '{"finding":"test"}',
      }),
      /at least 10/i,
    );
  });

  test('succeeds at exactly the minimum stake (10 AP3X) - the boundary is inclusive', async () => {
    const r = await buildCritique(lucid, {
      agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0,
      critiqueType: 'Supportive', stakeApex: 10,
      critiqueHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
    });
    assert.equal(r.stakeLovelace, '10000000');
    const tx = decodeTx(r.txCbor);
    const critiqueOut = findOutputTo(tx, r.scriptAddress);
    assert.ok(critiqueOut, 'no output to the critique address');
    assert.equal(critiqueOut!.amount().coin(), 12_000_000n, 'exactly-minimum stake (10 AP3X) must still build: 10 + 2 AP3X');
  });

  test('rejects a stake below the minimum', async () => {
    await assert.rejects(
      buildCritique(lucid, {
        agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0,
        critiqueType: 'Supportive', stakeApex: 9,
        critiqueHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
      }),
      /at least 10/i,
    );
  });

  test('rejects when neither critiqueDocument nor critiqueHash/storageUri is provided', async () => {
    await assert.rejects(
      buildCritique(lucid, {
        agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0,
        critiqueType: 'Supportive', stakeApex: 10,
      }),
      /critiqueHash|critiqueDocument/,
    );
  });

  test('rejects a malformed critiqueHash (not 64 hex chars)', async () => {
    await assert.rejects(
      buildCritique(lucid, {
        agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0,
        critiqueType: 'Supportive', stakeApex: 10,
        critiqueHash: 'nothex', storageUri: 'ipfs://x',
      }),
      /64 hex/,
    );
  });
});

describe('buildEndorse (offline, FixtureProvider)', () => {
  test('builds an unsigned lock tx: stake+2 AP3X to the endorsement address, datum round-trips', async () => {
    const r = await buildEndorse(lucid, {
      agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 1, stakeApex: 7,
    });

    assert.equal(r.op, 'endorse');
    assert.equal(r.stakeLovelace, '7000000');
    assert.equal(r.scriptAddress, scriptHashToAddress(GOV_ENDORSEMENT_SPEND_HASH));
    assert.equal(r.proposalRef, `${PROPOSAL_TX}#1`);

    const tx = decodeTx(r.txCbor);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'endorse build must be unsigned');
    assert.equal(CML.hash_transaction(tx.body()).to_hex(), r.txHash);

    const endorseOut = findOutputTo(tx, r.scriptAddress);
    assert.ok(endorseOut, 'no output to the endorsement address');
    assert.equal(endorseOut!.amount().coin(), 9_000_000n, 'output must be stake (7 AP3X) + 2 AP3X');
    assert.ok(endorseOut!.datum() && endorseOut!.datum()!.kind() === 1, 'continuing datum must be inline');

    const datumCbor = endorseOut!.datum()!.as_datum()!.to_cbor_hex();
    const parsed = parseEndorsementDatum(datumCbor);
    assert.ok(parsed, 'built endorsement datum failed to parse back');
    assert.equal(parsed!.endorserDid, AGENT_DID);
    assert.equal(parsed!.stakeAmount, 7_000_000);
    assert.equal(parsed!.proposalRef.fields[0], PROPOSAL_TX);
    assert.equal(Number(parsed!.proposalRef.fields[1]), 1);
  });

  test('succeeds at exactly the minimum stake (5 AP3X) - the boundary is inclusive', async () => {
    const r = await buildEndorse(lucid, {
      agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0, stakeApex: 5,
    });
    assert.equal(r.stakeLovelace, '5000000');
    const tx = decodeTx(r.txCbor);
    const endorseOut = findOutputTo(tx, r.scriptAddress);
    assert.ok(endorseOut, 'no output to the endorsement address');
    assert.equal(endorseOut!.amount().coin(), 7_000_000n, 'exactly-minimum stake (5 AP3X) must still build: 5 + 2 AP3X');
  });

  test('rejects a stake below the minimum', async () => {
    await assert.rejects(
      buildEndorse(lucid, {
        agentDid: AGENT_DID, proposalTxHash: PROPOSAL_TX, proposalOutputIndex: 0, stakeApex: 4,
      }),
      /at least 5/i,
    );
  });
});
