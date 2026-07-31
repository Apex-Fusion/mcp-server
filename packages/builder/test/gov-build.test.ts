import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CML, Data, Constr, toText, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import { getRegistryAddress, buildAgentDatum, MIN_AP3X_DEPOSIT } from '../src/vector/registry-build.ts';
import {
  GOV_PROPOSAL_SPEND_HASH, GOV_CRITIQUE_SPEND_HASH, GOV_ENDORSEMENT_SPEND_HASH,
  GOV_PROPOSAL_MINT_HASH, AGENT_REGISTRY_POLICY,
  MIN_CRITIQUE_STAKE_APEX, MIN_ENDORSE_STAKE_APEX, MIN_PROPOSAL_STAKE_APEX,
  scriptHashToAddress, deriveProposalTokenName, deriveActivityTokenName,
  parseProposalDatum, parseCritiqueDatum, parseEndorsementDatum,
  buildCritique, buildEndorse, buildProposalLock, buildProposalSpend,
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
const OWN_VKEY_HASH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash!;

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

// Shared by the mint-content and continuing-output-asset checks below (same
// helper as registry-build.test.ts - Mint's as_positive_multiasset() and
// Value's multi_asset() both return the same MultiAsset type).
function findAssetQuantity(ma: any, policyIdHex: string, assetNameHex: string): bigint | undefined {
  const policies = ma.keys();
  for (let i = 0; i < policies.len(); i++) {
    const policy = policies.get(i);
    if (policy.to_hex() !== policyIdHex) continue;
    const assets = ma.get_assets(policy);
    if (!assets) continue;
    const names = assets.keys();
    for (let n = 0; n < names.len(); n++) {
      const name = names.get(n);
      if (name.to_hex() === assetNameHex) return assets.get(name);
    }
  }
  return undefined;
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

  test('MIN_CRITIQUE_STAKE_APEX, MIN_ENDORSE_STAKE_APEX, and MIN_PROPOSAL_STAKE_APEX match the wire minimums', () => {
    assert.equal(MIN_CRITIQUE_STAKE_APEX, 10);
    assert.equal(MIN_ENDORSE_STAKE_APEX, 5);
    assert.equal(MIN_PROPOSAL_STAKE_APEX, 25);
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

describe('buildProposalLock (offline, FixtureProvider)', () => {
  test('builds an unsigned lock tx: stake+2 AP3X to the proposal address, datum round-trips (GeneralSuggestion)', async () => {
    const r = await buildProposalLock(lucid, {
      agentDid: AGENT_DID,
      proposalType: 'GeneralSuggestion',
      stakeApex: 25,
      proposalHash: '22'.repeat(32),
      storageUri: 'ipfs://test-proposal-doc',
    });

    assert.equal(r.stakeLovelace, '25000000');
    assert.equal(r.scriptAddress, scriptHashToAddress(GOV_PROPOSAL_SPEND_HASH));
    assert.equal(r.proposalHash, '22'.repeat(32));
    assert.equal(r.storageUri, 'ipfs://test-proposal-doc');
    assert.equal(r.ipfsCid, undefined, 'no document was given - no upload should have happened');

    const tx = decodeTx(r.txCbor);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'lock build must be unsigned');
    assert.equal(CML.hash_transaction(tx.body()).to_hex(), r.txHash);

    const lockOut = findOutputTo(tx, r.scriptAddress);
    assert.ok(lockOut, 'no output to the proposal address');
    assert.equal(lockOut!.amount().coin(), 27_000_000n, 'output must be stake (25 AP3X) + 2 AP3X');
    assert.ok(lockOut!.datum() && lockOut!.datum()!.kind() === 1, 'continuing datum must be inline');

    const datumCbor = lockOut!.datum()!.as_datum()!.to_cbor_hex();
    const parsed = parseProposalDatum(datumCbor);
    assert.ok(parsed, 'built proposal datum failed to parse back');
    assert.equal(parsed!.proposerDid, AGENT_DID);
    assert.equal(parsed!.proposalType, 'GeneralSuggestion');
    assert.equal(parsed!.stakeAmount, 25_000_000);
    assert.equal(parsed!.storageUri, 'ipfs://test-proposal-doc');
    assert.equal(parsed!.proposalHash, '22'.repeat(32));
    assert.equal(parsed!.state, 'Open');
    assert.equal(parsed!.priority, 'Standard');
    assert.equal(parsed!.amendmentCount, 0);
    assert.equal(parsed!.reviewWindow, 604_800_000);
  });

  test('succeeds at exactly the minimum stake (25 AP3X) - the boundary is inclusive', async () => {
    const r = await buildProposalLock(lucid, {
      agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
      proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
    });
    assert.equal(r.stakeLovelace, '25000000');
    const tx = decodeTx(r.txCbor);
    const lockOut = findOutputTo(tx, r.scriptAddress);
    assert.equal(lockOut!.amount().coin(), 27_000_000n, 'exactly-minimum stake (25 AP3X) must still build: 25 + 2 AP3X');
  });

  test('rejects a stake below the minimum (24 AP3X)', async () => {
    await assert.rejects(
      buildProposalLock(lucid, {
        agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 24,
        proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
      }),
      /at least 25/i,
    );
  });

  test('ParameterChange without typeParams rejects', async () => {
    await assert.rejects(
      buildProposalLock(lucid, {
        agentDid: AGENT_DID, proposalType: 'ParameterChange', stakeApex: 25,
        proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
      }),
      /ParameterChange requires/,
    );
  });

  test('ParameterChange with typeParams embeds paramName/currentValue/proposedValue in the type datum', async () => {
    const r = await buildProposalLock(lucid, {
      agentDid: AGENT_DID, proposalType: 'ParameterChange', stakeApex: 25,
      typeParams: { paramName: 'MIN_PROPOSAL_STAKE', currentValue: 25, proposedValue: 30 },
      proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
    });
    const tx = decodeTx(r.txCbor);
    const lockOut = findOutputTo(tx, r.scriptAddress)!;
    const datumCbor = lockOut.datum()!.as_datum()!.to_cbor_hex();
    const raw = Data.from(datumCbor) as Constr<Data>;
    const typeField = raw.fields[3] as Constr<Data>;
    assert.equal(typeField.index, 0);
    assert.equal(toText(typeField.fields[0] as string), 'MIN_PROPOSAL_STAKE');
    assert.equal(Number(typeField.fields[1]), 25);
    assert.equal(Number(typeField.fields[2]), 30);
  });

  test('TreasurySpend without typeParams rejects', async () => {
    await assert.rejects(
      buildProposalLock(lucid, {
        agentDid: AGENT_DID, proposalType: 'TreasurySpend', stakeApex: 25,
        proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
      }),
      /TreasurySpend requires/,
    );
  });

  // The three Constr indices below are the on-chain contract's own layout
  // (0=ParameterChange, 1=TreasurySpend, 2=ProtocolUpgrade, 3=GameActivation,
  // 4=GeneralSuggestion - see the custodial switch this was transcribed
  // from) - an index swap between any two of these builds a datum the
  // deployed validator would parse as the WRONG proposal type. Each test
  // decodes the raw type-datum Constr directly (not through the parser,
  // which only round-trips the type NAME back from the index) to pin the
  // literal on-wire index.

  test('TreasurySpend with typeParams builds with type datum index 1 (amount + recipientDescription)', async () => {
    const r = await buildProposalLock(lucid, {
      agentDid: AGENT_DID, proposalType: 'TreasurySpend', stakeApex: 25,
      typeParams: { amount: 500, recipientDescription: 'research grant pool' },
      proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
    });
    const tx = decodeTx(r.txCbor);
    const lockOut = findOutputTo(tx, r.scriptAddress)!;
    const datumCbor = lockOut.datum()!.as_datum()!.to_cbor_hex();
    const raw = Data.from(datumCbor) as Constr<Data>;
    const typeField = raw.fields[3] as Constr<Data>;
    assert.equal(typeField.index, 1, "TreasurySpend must encode as Constr index 1 - the on-chain contract's layout, not renumbered");
    assert.equal(Number(typeField.fields[0]), 500);
    assert.equal(toText(typeField.fields[1] as string), 'research grant pool');
  });

  test('ProtocolUpgrade builds with type datum index 2 (upgradeHash embedded)', async () => {
    const r = await buildProposalLock(lucid, {
      agentDid: AGENT_DID, proposalType: 'ProtocolUpgrade', stakeApex: 25,
      typeParams: { upgradeHash: 'cc'.repeat(32) },
      proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
    });
    const tx = decodeTx(r.txCbor);
    const lockOut = findOutputTo(tx, r.scriptAddress)!;
    const datumCbor = lockOut.datum()!.as_datum()!.to_cbor_hex();
    const raw = Data.from(datumCbor) as Constr<Data>;
    const typeField = raw.fields[3] as Constr<Data>;
    assert.equal(typeField.index, 2, "ProtocolUpgrade must encode as Constr index 2 - the on-chain contract's layout, not renumbered");
    assert.equal(typeField.fields[0], 'cc'.repeat(32));
  });

  test('GameActivation builds with type datum index 3 (gameId embedded)', async () => {
    const r = await buildProposalLock(lucid, {
      agentDid: AGENT_DID, proposalType: 'GameActivation', stakeApex: 25,
      typeParams: { gameId: 6 },
      proposalHash: 'aa'.repeat(32), storageUri: 'ipfs://x',
    });
    const tx = decodeTx(r.txCbor);
    const lockOut = findOutputTo(tx, r.scriptAddress)!;
    const datumCbor = lockOut.datum()!.as_datum()!.to_cbor_hex();
    const raw = Data.from(datumCbor) as Constr<Data>;
    const typeField = raw.fields[3] as Constr<Data>;
    assert.equal(typeField.index, 3, "GameActivation must encode as Constr index 3 - the on-chain contract's layout, not renumbered");
    assert.equal(Number(typeField.fields[0]), 6);
  });

  test('manual proposalHash + storageUri path works without a document', async () => {
    const r = await buildProposalLock(lucid, {
      agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
      proposalHash: 'bb'.repeat(32), storageUri: 'ipfs://manual',
    });
    assert.equal(r.proposalHash, 'bb'.repeat(32));
    assert.equal(r.storageUri, 'ipfs://manual');
  });

  test('rejects a malformed proposalHash (not 64 hex chars)', async () => {
    await assert.rejects(
      buildProposalLock(lucid, {
        agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
        proposalHash: 'nothex', storageUri: 'ipfs://x',
      }),
      /64 hex/,
    );
  });

  test('rejects when neither proposalDocument nor proposalHash/storageUri is provided', async () => {
    await assert.rejects(
      buildProposalLock(lucid, {
        agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
      }),
      /proposalHash|proposalDocument/,
    );
  });

  test('stake minimum is validated BEFORE any Filebase upload attempt', async () => {
    // If validation order were wrong, this would fail with the Filebase
    // error instead (proposalDocument is provided, stake is not).
    await assert.rejects(
      buildProposalLock(lucid, {
        agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 1,
        proposalDocument: '{"proposal":"test"}',
      }),
      /at least 25/i,
    );
  });

  test('attempts a Filebase upload when proposalDocument is given (fails clean - not configured in tests)', async () => {
    // No FILEBASE_* env vars are set in this test environment, so a genuine
    // upload attempt must surface the "not configured" error - proving the
    // document path is actually wired up without needing to mock the AWS SDK.
    await assert.rejects(
      buildProposalLock(lucid, {
        agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
        proposalDocument: '{"proposal":"test"}',
      }),
      /Filebase not configured/,
    );
  });
});

describe('buildProposalSpend (offline, FixtureProvider)', () => {
  const LOCK_TX_HASH = 'aa'.repeat(32);
  const PRESERVE_LOCK_TX_HASH = 'bb'.repeat(32);
  const NFT_TX_HASH = 'cc'.repeat(32);
  const NFT_UNIT = AGENT_REGISTRY_POLICY + AGENT_DID;

  let proposalSpendAddress: string;
  let lockDatumCbor: string;
  let lockedUtxoFixture: UTxO;
  let preserveLockedUtxoFixture: UTxO;
  let spendLucid: LucidEvolution;
  let spendProvider: ReturnType<typeof chainClockProvider>;

  function nftFixtureUtxo(): UTxO {
    return {
      txHash: NFT_TX_HASH, outputIndex: 0, address: getRegistryAddress(),
      assets: { lovelace: MIN_AP3X_DEPOSIT, [NFT_UNIT]: 1n },
      datum: buildAgentDatum(OWN_VKEY_HASH, 'FixtureAgent', 'offline fixture agent', ['testing'], 'custom', ''),
    };
  }
  function refScriptFixtureUtxos(): UTxO[] {
    return fixture.refScripts.map((s) => ({
      txHash: s.txHash, outputIndex: s.index, address: proposalSpendAddress,
      assets: { lovelace: 2_000_000n },
      scriptRef: { type: 'PlutusV3', script: s.scriptCborHex },
    }));
  }
  function infraFixtureUtxos(): UTxO[] {
    return fixture.infra.map((i) => ({
      txHash: i.txHash, outputIndex: i.index, address: i.address,
      assets: { lovelace: BigInt(i.valueLovelace) },
      datum: i.datumCbor,
    }));
  }
  // Assembles the offline chain state buildProposalSpend needs, with the
  // ability to omit one category per negative test (missing-NFT,
  // missing-ref-scripts).
  function baseSpendUtxos(opts?: { skipNft?: boolean; skipRefScripts?: boolean }): UTxO[] {
    return [
      ...FIXTURE_UTXOS, lockedUtxoFixture, preserveLockedUtxoFixture,
      ...(opts?.skipNft ? [] : [nftFixtureUtxo()]),
      ...(opts?.skipRefScripts ? [] : refScriptFixtureUtxos()),
      ...infraFixtureUtxos(),
    ];
  }

  // buildProposalSpend's PRODUCTION path (opts omitted - same as Task 5's
  // callers) completes with `localUPLCEval: false`, which asks the PROVIDER
  // to evaluate the transaction's script redeemers (see gov-build.ts's
  // module doc). FixtureProvider deliberately has no evaluateTx (offline
  // only - see fixture-provider.ts), and the REAL deployed validators
  // legitimately reject this test's synthetic chain state - captured
  // honestly, verbatim, in the dedicated native-eval-attempt describe block
  // below, not swept under the rug here.
  //
  // This wrapper stubs evaluateTx with generous-but-harmless execution units
  // (well inside the fixture protocol params' per-tx maximum) purely so
  // Lucid can finish ASSEMBLING a well-formed, decodable transaction for the
  // structural assertions in this describe block. It does NOT assert or
  // imply the deployed validator would accept the result - that question is
  // answered separately, honestly, by the native-eval-attempt test (which
  // never calls evaluateTx at all, so this stub is simply unused there).
  //
  // Two things this stub deliberately does NOT cover, each carried by a
  // different test instead: (1) it fabricates canned ex-units, not real
  // ones, so the structural tests' fees are fictitious - nothing here or
  // elsewhere asserts on `fee`/`feeAda`; (2) it never inspects or
  // constrains REDEEMER CONTENT (only the units Lucid attaches to whichever
  // redeemers already exist in the draft tx) - the structural test's
  // literal 'd87980' redeemer-data pin, the native-eval-attempt test, and
  // the (manual, gated) E2E integration test are what actually exercise
  // redeemer correctness; a corrupted redeemer would sail through this stub
  // unnoticed.
  function stubEvalProvider(utxos: UTxO[]) {
    const provider = chainClockProvider(utxos);
    return Object.assign(provider, {
      evaluateTx: async (txCborHex: string) => {
        const draft = CML.Transaction.from_cbor_hex(txCborHex);
        const legacy = draft.witness_set().redeemers()?.as_arr_legacy_redeemer();
        const tagMap: Record<number, 'spend' | 'mint' | 'publish' | 'withdraw' | 'vote' | 'propose'> = {
          0: 'spend', 1: 'mint', 2: 'publish', 3: 'withdraw', 4: 'vote', 5: 'propose',
        };
        const out: { ex_units: { mem: number; steps: number }; redeemer_index: number; redeemer_tag: typeof tagMap[number] }[] = [];
        if (legacy) {
          for (let i = 0; i < legacy.len(); i++) {
            const r = legacy.get(i);
            out.push({
              ex_units: { mem: 2_000_000, steps: 500_000_000 },
              redeemer_index: Number(r.index()),
              redeemer_tag: tagMap[r.tag()] ?? 'spend',
            });
          }
        }
        return out;
      },
    });
  }

  before(async () => {
    proposalSpendAddress = scriptHashToAddress(GOV_PROPOSAL_SPEND_HASH);

    // Build a lock offline, then decode ITS OWN output to extract the real
    // inline datum bytes - buildProposalSpend must reuse these verbatim, not
    // reconstruct them, so the fixture has to carry genuine built-datum CBOR.
    const lockResult = await buildProposalLock(lucid, {
      agentDid: AGENT_DID, proposalType: 'GeneralSuggestion', stakeApex: 25,
      proposalHash: '33'.repeat(32), storageUri: 'ipfs://spend-fixture-doc',
    });
    const lockTx = decodeTx(lockResult.txCbor);
    const lockOut = findOutputTo(lockTx, proposalSpendAddress)!;
    lockDatumCbor = lockOut.datum()!.as_datum()!.to_cbor_hex();

    lockedUtxoFixture = {
      txHash: LOCK_TX_HASH, outputIndex: 0, address: proposalSpendAddress,
      assets: { lovelace: 27_000_000n }, datum: lockDatumCbor,
    };
    // A second locked UTxO with an off-constant lovelace amount, used ONLY by
    // the value-preservation test below: if buildProposalSpend recomputed
    // stake+2 AP3X instead of carrying the locked input's own coin through,
    // 27_000_001n (not 27_000_000n) could never appear in the continuing
    // output.
    preserveLockedUtxoFixture = {
      txHash: PRESERVE_LOCK_TX_HASH, outputIndex: 0, address: proposalSpendAddress,
      assets: { lovelace: 27_000_001n }, datum: lockDatumCbor,
    };

    spendProvider = stubEvalProvider(baseSpendUtxos());
    spendLucid = await lucidForAddress(spendProvider, OWN_ADDRESS);
  });

  test('spends the locked UTxO, mints prop_+pact_ tokens, preserves the locked datum byte-identically', async () => {
    // No opts: this is the PRODUCTION path (localUPLCEval: false internally)
    // - see stubEvalProvider's comment above for why that still completes
    // offline. Structural assertions only; the honesty-gate test below is
    // what actually asks the real validators anything.
    const r = await buildProposalSpend(spendLucid, spendProvider, {
      agentDid: AGENT_DID, lockTxHash: LOCK_TX_HASH, lockOutputIndex: 0,
    });

    const expectedPropName = deriveProposalTokenName(LOCK_TX_HASH, 0);
    const expectedActName = deriveActivityTokenName(AGENT_DID);
    assert.equal(r.proposalTokenName, expectedPropName);
    assert.equal(r.activityTokenName, expectedActName);
    // THE PIN (Task 3 review mandate): the activity token name must come
    // from deriveActivityTokenName's 'pact_' prefix - a 'pact_' -> 'act_'
    // mutation in the implementation must fail this assertion by name.
    assert.equal(
      r.activityTokenName.slice(0, 10), Buffer.from('pact_', 'utf-8').toString('hex'),
      "activityTokenName must be derived via deriveActivityTokenName's 'pact_' prefix",
    );
    assert.equal(r.scriptAddress, proposalSpendAddress);

    const tx = decodeTx(r.txCbor);

    // unsigned
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'spend build must be unsigned');
    assert.equal(CML.hash_transaction(tx.body()).to_hex(), r.txHash);

    // the locked UTxO is actually spent
    const ins = tx.body().inputs();
    let sawLockedInput = false;
    for (let i = 0; i < ins.len(); i++) {
      if (ins.get(i).transaction_id().to_hex() === LOCK_TX_HASH) sawLockedInput = true;
    }
    assert.ok(sawLockedInput, 'the locked UTxO must be a spent input');

    // mints exactly prop:1 + act:1, with the exact derived unit names
    const mint = tx.body().mint()!;
    assert.ok(mint, 'no mint field');
    const ma = mint.as_positive_multiasset();
    assert.equal(findAssetQuantity(ma, GOV_PROPOSAL_MINT_HASH, expectedPropName), 1n, 'must mint exactly 1 prop_ token of the derived name');
    assert.equal(findAssetQuantity(ma, GOV_PROPOSAL_MINT_HASH, expectedActName), 1n, 'must mint exactly 1 pact_ token of the derived name');

    // Redeemer content, not just mint/output shape - stubEvalProvider only
    // fabricates execution UNITS, it never inspects or constrains redeemer
    // DATA, so nothing above this point would catch a corrupted or
    // mismatched redeemer. Both the Spend and Mint redeemers must be
    // SubmitRedeemer = Data.to(new Constr(0, [])), which CBOR-encodes to the
    // fixed 3-byte 'd87980' (tag 121 = alternative 0, empty field array) -
    // pinned as a literal, not by re-deriving from Constr, so a redeemer
    // corruption can't hide behind a mutated encoder agreeing with itself.
    const legacyRedeemers = tx.witness_set().redeemers()?.as_arr_legacy_redeemer();
    assert.ok(legacyRedeemers, 'no redeemers in the witness set');
    assert.equal(legacyRedeemers!.len(), 2, 'must carry exactly 2 redeemers (Spend + Mint)');
    for (let i = 0; i < legacyRedeemers!.len(); i++) {
      const redeemer = legacyRedeemers!.get(i);
      assert.equal(
        redeemer.data().to_cbor_hex(), 'd87980',
        `redeemer ${i} (tag ${redeemer.tag()}) must be the empty SubmitRedeemer Constr(0, [])`,
      );
    }

    // exactly two continuing outputs at the proposal address
    const outs = tx.body().outputs();
    const atSpendAddr: any[] = [];
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i);
      if (o.address().to_bech32() === proposalSpendAddress) atSpendAddr.push(o);
    }
    assert.equal(atSpendAddr.length, 2, 'must produce exactly 2 continuing outputs at the proposal address');

    // Positional pin, matching the mainnet-proven custodial output order
    // exactly (the proposal-continuing pay.ToAddressWithData call comes
    // before the activity one in both the custodial module and this build):
    // output 0 = the proposal-datum continuing output (prop token), output
    // 1 = the activity output (act token). Verified empirically against a
    // real decoded build before pinning this, not assumed - output 2 (not
    // asserted here) is Lucid's own wallet-change output from fee coin
    // selection, which is incidental to this build's own logic.
    const output0Assets = outs.get(0).amount().multi_asset();
    const output1Assets = outs.get(1).amount().multi_asset();
    assert.equal(
      output0Assets && findAssetQuantity(output0Assets, GOV_PROPOSAL_MINT_HASH, expectedPropName), 1n,
      'output 0 must be the proposal-continuing output (carries the prop_ token)',
    );
    assert.equal(
      output1Assets && findAssetQuantity(output1Assets, GOV_PROPOSAL_MINT_HASH, expectedActName), 1n,
      'output 1 must be the activity output (carries the pact_ token)',
    );

    const propOut = atSpendAddr.find((o) => findAssetQuantity(o.amount().multi_asset()!, GOV_PROPOSAL_MINT_HASH, expectedPropName) === 1n);
    assert.ok(propOut, 'no continuing output carries the prop_ token');
    assert.equal(
      propOut.datum()!.as_datum()!.to_cbor_hex(), lockDatumCbor,
      'the continuing proposal datum must be byte-identical to the locked input datum',
    );
    assert.equal(propOut.amount().coin(), 27_000_000n, 'the continuing proposal output must preserve the locked UTxO coin');

    const actOut = atSpendAddr.find((o) => findAssetQuantity(o.amount().multi_asset()!, GOV_PROPOSAL_MINT_HASH, expectedActName) === 1n);
    assert.ok(actOut, 'no continuing output carries the pact_ token');
    assert.equal(actOut.amount().coin(), 2_000_000n);
    const activityRaw = Data.from(actOut.datum()!.as_datum()!.to_cbor_hex()) as Constr<Data>;
    assert.equal(activityRaw.fields[0], AGENT_DID, 'activity datum agent_did must match');
    assert.equal(Number(activityRaw.fields[2]), 1, 'activity datum active_proposal_count must be 1 (first proposal)');
    assert.equal(Number(activityRaw.fields[3]), r.validToMs - 360_000, 'activity datum last_proposal_slot must equal validFromMs');

    // validity window: exactly 360 slots (360_000ms at the test config's 1000ms/slot)
    const start = tx.body().validity_interval_start();
    const ttl = tx.body().ttl();
    assert.ok(start !== undefined && ttl !== undefined, 'validity interval must be set');
    assert.equal(Number(ttl! - start!), 360, 'validity window must be exactly 360 slots (360_000 ms)');
    assert.equal(r.validToMs, ZERO_TIME_MS + TIP_SLOT * 1000 + 360_000, 'validToMs must be validFromMs + 360_000');

    // required signer = the derived wallet address's payment hash
    const signers = tx.body().required_signers();
    assert.ok(signers && signers.len() >= 1, 'no required_signers');
    let foundSigner = false;
    for (let i = 0; i < signers!.len(); i++) {
      if (signers!.get(i).to_hex() === OWN_VKEY_HASH) foundSigner = true;
    }
    assert.ok(foundSigner, 'wallet vkey hash missing from required_signers');

    // reference inputs: 3 infra + 2 ref-script + 1 NFT = 6
    const refIns = tx.body().reference_inputs();
    assert.ok(refIns, 'no reference_inputs on the spend tx');
    assert.equal(refIns!.len(), 6, 'must read exactly 3 infra + 2 ref-script + 1 NFT UTxOs');
  });

  test('value-preservation: continuing proposal output carries the LOCKED UTxO coin, not a recomputed constant', async () => {
    const r = await buildProposalSpend(spendLucid, spendProvider, {
      agentDid: AGENT_DID, lockTxHash: PRESERVE_LOCK_TX_HASH, lockOutputIndex: 0,
    });
    const expectedPropName = deriveProposalTokenName(PRESERVE_LOCK_TX_HASH, 0);
    const tx = decodeTx(r.txCbor);
    const outs = tx.body().outputs();
    let propOut: any = null;
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i);
      if (o.address().to_bech32() !== proposalSpendAddress) continue;
      const ma = o.amount().multi_asset();
      if (ma && findAssetQuantity(ma, GOV_PROPOSAL_MINT_HASH, expectedPropName) === 1n) propOut = o;
    }
    assert.ok(propOut, 'no continuing output carries the prop_ token');
    assert.equal(
      propOut.amount().coin(), 27_000_001n,
      'must equal the locked input coin exactly, not the recomputed stake+2 constant (27_000_000n)',
    );
  });

  test('absent locked UTxO (random hash) - await-first error', async () => {
    await assert.rejects(
      buildProposalSpend(spendLucid, spendProvider, {
        agentDid: AGENT_DID, lockTxHash: 'ff'.repeat(32), lockOutputIndex: 0,
      }),
      /vector_await_transaction/,
    );
  });

  test('locked UTxO exists but is not at the proposal script address - fail-fast error', async () => {
    // A UTxO that resolves fine by outref but sits at the WALLET's own
    // address, not the proposal script address - simulates a caller passing
    // an unrelated txHash. Must be rejected before any datum parsing is
    // attempted (the datum content here is irrelevant to this check).
    const WRONG_ADDR_TX_HASH = 'dd'.repeat(32);
    const wrongAddressUtxo: UTxO = {
      txHash: WRONG_ADDR_TX_HASH, outputIndex: 0, address: OWN_ADDRESS,
      assets: { lovelace: 27_000_000n }, datum: lockDatumCbor,
    };
    const providerWrongAddr = chainClockProvider([...baseSpendUtxos(), wrongAddressUtxo]);
    const lucidWrongAddr = await lucidForAddress(providerWrongAddr, OWN_ADDRESS);
    await assert.rejects(
      buildProposalSpend(lucidWrongAddr, providerWrongAddr, {
        agentDid: AGENT_DID, lockTxHash: WRONG_ADDR_TX_HASH, lockOutputIndex: 0,
      }),
      /not at the proposal script address/,
    );
  });

  test('DID mismatch between the locked datum and the caller agentDid - clear error', async () => {
    await assert.rejects(
      buildProposalSpend(spendLucid, spendProvider, {
        agentDid: 'ee'.repeat(32), lockTxHash: LOCK_TX_HASH, lockOutputIndex: 0,
      }),
      /DID mismatch/,
    );
  });

  test('missing agent registry NFT - re-register error', async () => {
    const providerNoNft = chainClockProvider(baseSpendUtxos({ skipNft: true }));
    const lucidNoNft = await lucidForAddress(providerNoNft, OWN_ADDRESS);
    await assert.rejects(
      buildProposalSpend(lucidNoNft, providerNoNft, {
        agentDid: AGENT_DID, lockTxHash: LOCK_TX_HASH, lockOutputIndex: 0,
      }),
      /re-register/,
    );
  });

  test('missing reference scripts (omitted from fixtures) - the verbatim redeploy-hint error', async () => {
    const providerNoRefs = chainClockProvider(baseSpendUtxos({ skipRefScripts: true }));
    const lucidNoRefs = await lucidForAddress(providerNoRefs, OWN_ADDRESS);
    await assert.rejects(
      buildProposalSpend(lucidNoRefs, providerNoRefs, {
        agentDid: AGENT_DID, lockTxHash: LOCK_TX_HASH, lockOutputIndex: 0,
      }),
      /redeploy_ref_scripts\.py/,
    );
  });

  describe('native-eval attempt (honesty gate)', () => {
    // Spec PR 8 Task 4's eval strategy (plan's Global Constraints section,
    // "Eval strategy"): attempt NATIVE UPLC evaluation of the REAL deployed
    // proposal spend+mint validators (captured bytecode,
    // gov-state.fixture.json) against this test file's synthetic chain
    // state, calling the SAME buildProposalSpend build used throughout this
    // describe block - just with the opts override flipped to
    // localUPLCEval: true instead of the structural tests' stubbed-provider
    // production path.
    //
    // OUTCOME (captured 2026-07-30, verbatim - see task-4-report.md): FAILS.
    // The validator trace shows it entered proposal_spend and successfully
    // read PARAMS, then crashed - a genuine Plutus evaluation rejection, not
    // a Lucid-level "couldn't build this" error:
    //
    //   TxBuilderError: { Complete: "failed script execution Spend[0] the
    //   validator crashed / exited prematurely Trace ENTER:proposal_spend
    //   Trace OK:read_params" }
    //
    // What this trace DOES establish: the crash is a genuine chain-logic
    // rejection inside the deployed validator, not a Lucid-side "couldn't
    // even assemble this transaction" failure - the crash happens in a
    // LATER check the plan explicitly named as chain-state-dependent
    // (oracle freshness, or a DID/NFT cross-check needing exact real values
    // this fixture's synthetic ORACLE/NFT data cannot satisfy offline).
    //
    // What it does NOT establish: that everything up to and including
    // read_params is correct. "OK:read_params" is ONE-DIRECTIONAL evidence
    // - an EARLIER failure (crashing before ENTER:proposal_spend, or before
    // OK:read_params) WOULD imply a structural break, but reaching this
    // point proves nothing about checks that come AFTER it. Confirmed
    // directly, not assumed: deliberately dropping the NFT reference input
    // from buildProposalSpend's readFrom calls (a real structural bug)
    // reproduces this EXACT SAME trace, since the validator doesn't touch
    // the NFT until a check that comes later. That specific defect class is
    // instead caught by the structural test's reference_inputs-length pin
    // (== 6) above, not by this trace - which is why that pin, the
    // redeemer-content pin, and the output-order pin all live in the
    // structural describe block rather than being inferred from this one
    // eval attempt.
    //
    // This is the expected fork, not a structural defect: production keeps
    // `localUPLCEval: false` and lets the PROVIDER evaluate (tier-1/E2E
    // integration tests exercise that against the live network); this
    // describe block's sibling tests above cover the offline-testable half
    // (the transaction's own shape) with a stubbed evaluateTx that makes no
    // claim about validator acceptance. NEVER weakened to assert.doesNotReject
    // or deleted - the failure is pinned so a change in this behavior (pass
    // OR a different failure) shows up here, not silently.
    test('ATTEMPT: native UPLC eval of the deployed proposal spend+mint validators against fixture chain state (EXPECTED TO FAIL - chain-state-dependent, not a structural defect)', async () => {
      await assert.rejects(
        buildProposalSpend(spendLucid, spendProvider, {
          agentDid: AGENT_DID, lockTxHash: LOCK_TX_HASH, lockOutputIndex: 0,
        }, { localUPLCEval: true }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // Must be a genuine Plutus validator rejection reached AFTER
          // read_params, not a Lucid-side build failure and not a crash
          // earlier than this. This is one-directional: it rules OUT an
          // earlier-than-expected structural break, it does not rule IN
          // that every later check is correct (see the describe-level
          // comment above for why, and what does cover that).
          assert.match(message, /proposal_spend/, 'expected a proposal_spend validator trace, not a build-level error');
          assert.match(message, /OK:read_params/, 'expected the validator to have gotten PAST reading params before crashing - anything earlier would suggest a structural wiring defect, not a chain-state one');
          return true;
        },
      );
    });
  });
});
