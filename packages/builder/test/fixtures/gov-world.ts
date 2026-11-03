// packages/builder/test/fixtures/gov-world.ts
// An offline Module-6 deployment on the identity registry for the builder tests. The five validators come from the Module-6 blueprint
// (vector-agent-modules feat/identity-registry 91e3823, Module-6/contracts/governance-suggestion/plutus.json, last built in 9dd049f),
// copied byte for byte into governance-suggestion.plutus.json (gov-build.test.ts pins its sha256). A test GovernanceConfig is applied
// exactly as the Module-6 deploy script applies it (deploy_common.build_governance_config_cbor writes a definite-length CBOR array);
// its identity_hash is the identity deployment of identity-world.ts, so the validators read the records of that world. The world holds
// the reference scripts, the GovernanceParams record, the CrossRefs output, the head of the activity list, the records and the wallet.
// Lucid runs the applied validators on every creation (local evaluation).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { apply_params_to_script } from '@lucid-evolution/uplc';
import { validatorToScriptHash } from '@lucid-evolution/lucid';
import type { Script, UTxO } from '@lucid-evolution/lucid';
import { DEPLOYMENT, NOW, DAY, ZERO_KEY_ADDRESS, identityWorld, recordUtxo, rootRecord, testKey } from './identity-world.ts';
import type { FixtureProvider } from './fixture-provider.ts';
import { makeGovDeployment, scriptAddress, expectedCrossRefs } from '../../src/vector/gov-deployment.ts';
import type { GovDeployment, GovRefName, OutRef } from '../../src/vector/gov-deployment.ts';
import {
  ACTIVITY_HEAD_TOKEN, PARAMS_TOKEN, deriveActivityTokenName, deriveProposalTokenName, encodeActivityDatum, encodeCrossRefs,
  encodeGovernanceParams, encodeProposalDatum,
} from '../../src/vector/gov-codec.ts';
import type { ActivityDatum, GovernanceParams, ProposalDatum } from '../../src/vector/gov-codec.ts';
import { utf8Hex } from '../../src/vector/identity-codec.ts';
import type { IdentityDatum } from '../../src/vector/identity-codec.ts';

export const BLUEPRINT_PATH = resolve(import.meta.dirname!, 'governance-suggestion.plutus.json');
const BLUEPRINT = JSON.parse(readFileSync(BLUEPRINT_PATH, 'utf8')) as { validators: Array<{ title: string; compiledCode: string; hash: string }> };

/** The test GovernanceConfig: holder and policy hashes as in the Module-6 client tests (conftest.py), and the test identity hash. */
export const CONFIG = {
  refsTokenPolicy: '7b'.repeat(28), oracleHolder: '4b'.repeat(28), paramsHolder: '4a'.repeat(28), treasuryHolder: '4c'.repeat(28),
  recordTokenPolicy: '7a'.repeat(28), identityHash: DEPLOYMENT.identity.hash,
};

/** GovernanceConfig (11 fields) as deploy_common.build_governance_config_cbor writes it: tag 121, a definite array of 28-byte strings. */
export function governanceConfigCbor(c = CONFIG): string {
  const zero = '00'.repeat(28);
  const fields = [c.refsTokenPolicy, zero, zero, zero, c.oracleHolder, c.paramsHolder, c.treasuryHolder, zero, zero, c.recordTokenPolicy, c.identityHash];
  return `d8798b${fields.map((h) => `581c${h}`).join('')}`;
}

export const TITLES: Readonly<Record<GovRefName, string>> = {
  proposalSpend: 'proposal.proposal_spend.spend', proposalMint: 'proposal.proposal_mint.mint', critiqueSpend: 'critique.critique_spend.spend',
  critiqueMint: 'critique.critique_mint.mint', endorsementSpend: 'critique.endorsement_spend.spend',
};
const NAMES = Object.keys(TITLES) as GovRefName[];

/** The validator `title` of the blueprint with `configCbor` applied (a one-element parameter list), as `aiken blueprint apply` applies it. */
export function appliedScript(title: string, configCbor = governanceConfigCbor()): Script {
  const validator = BLUEPRINT.validators.find((v) => v.title === title);
  if (!validator) throw new Error(`no validator ${title} in the blueprint`);
  const applied = apply_params_to_script(Buffer.from(`81${configCbor}`, 'hex'), Buffer.from(validator.compiledCode, 'hex'));
  return { type: 'PlutusV3', script: Buffer.from(applied).toString('hex') };
}

export const SCRIPTS = Object.fromEntries(NAMES.map((name) => [name, appliedScript(TITLES[name])])) as Record<GovRefName, Script>;
const HASHES = Object.fromEntries(NAMES.map((name) => [name, validatorToScriptHash(SCRIPTS[name])])) as Record<GovRefName, string>;

const REF_TX = 'e6'.repeat(32);
/** The reference-script UTxOs of the five validators, at the zero-key address. */
export const GOV_REF_UTXOS: UTxO[] = NAMES.map((name, i) => ({
  txHash: REF_TX, outputIndex: i, address: ZERO_KEY_ADDRESS, assets: { lovelace: 60_000_000n }, scriptRef: SCRIPTS[name],
}));

export const GOV: GovDeployment = makeGovDeployment({
  ...HASHES,
  recordTokenPolicy: CONFIG.recordTokenPolicy, refsTokenPolicy: CONFIG.refsTokenPolicy,
  paramsAddress: scriptAddress(CONFIG.paramsHolder), crossRefsAddress: scriptAddress(CONFIG.oracleHolder), treasuryAddress: scriptAddress(CONFIG.treasuryHolder),
  refs: Object.fromEntries(NAMES.map((name, i) => [name, { txHash: REF_TX, outputIndex: i }])),
});

/** The default parameters of params.ak (times in POSIX ms, amounts in lovelace). */
export const PARAMS: GovernanceParams = {
  minProposalStake: 25_000_000n, minCritiqueStake: 5_000_000n, minGovernanceEndorsement: 5_000_000n, minReviewWindow: 259_200_000n,
  maxReviewWindow: 2_419_200_000n, maxAmendments: 5n, maxActiveProposals: 3n, proposalCooldown: 86_400_000n, proposerRewardShare: 7_000n,
  criticRewardShare: 2_000n, protocolFeeRate: 1_000n, minAdoptionReward: 50_000_000n, maxAdoptionReward: 500_000_000n,
  maxIncorporatedCritiques: 5n, maxTreasuryRequest: 10_000_000_000n, emergencyStakeMultiplier: 5_000n, emergencyReviewWindow: 43_200_000n,
  paramExecutionDelay: 604_800_000n, minPredictionPool: 100_000_000n, credibilityPoolLowThreshold: 500_000_000n,
  credibilityPoolCriticalThreshold: 200_000_000n,
};

/** The GovernanceParams record: the `params` record token at the params holder, with the parameters as its datum. */
export const paramsUtxo = (params: GovernanceParams = PARAMS): UTxO => ({
  txHash: 'a0'.repeat(32), outputIndex: 0, address: GOV.paramsAddress,
  assets: { lovelace: 3_000_000n, [`${CONFIG.recordTokenPolicy}${PARAMS_TOKEN}`]: 1n }, datum: encodeGovernanceParams(params),
});
/** The CrossRefs output at the oracle holder: a token of the refs policy and the 5-field datum of the deployment. */
export const CROSS_REFS_UTXO: UTxO = {
  txHash: 'c5'.repeat(32), outputIndex: 0, address: GOV.crossRefsAddress,
  assets: { lovelace: 3_000_000n, [`${CONFIG.refsTokenPolicy}${utf8Hex('cross-refs')}`]: 1n }, datum: encodeCrossRefs(expectedCrossRefs(GOV)),
};

/** The deployer key of the head's credential (the validators do not read it). */
export const HEAD_OWNER = '4d'.repeat(28);
/** The head of the activity list, with `nextDid` (empty: an empty list). */
export function headUtxo(nextDid = '', lovelace = 2_000_000n): UTxO {
  const datum: ActivityDatum = { agentDid: '', agentCredential: { type: 'VerificationKey', hash: HEAD_OWNER }, activeProposalCount: 0, lastProposalSlot: 0, nextDid };
  return {
    txHash: 'ad'.repeat(32), outputIndex: 0, address: GOV.proposalAddress,
    assets: { lovelace, [`${CONFIG.recordTokenPolicy}${ACTIVITY_HEAD_TOKEN}`]: 1n }, datum: encodeActivityDatum(datum),
  };
}

let counter = 0;
const nextTx = (lead: string): string => { counter += 1; return `${lead}${counter.toString(16).padStart(62, '0')}`; };

/** The node of `agentId` in the activity list: its activity token and its datum. */
export function nodeUtxo(agentId: string, d: Partial<ActivityDatum> = {}, lovelace = 2_000_000n): UTxO {
  const datum: ActivityDatum = {
    agentDid: agentId, agentCredential: { type: 'VerificationKey', hash: CREDENTIAL.keyHash }, activeProposalCount: 1,
    lastProposalSlot: NOW - 10 * DAY, nextDid: '', ...d,
  };
  return { txHash: nextTx('b1'), outputIndex: 1, address: GOV.proposalAddress, assets: { lovelace, [`${GOV.proposalMint}${deriveActivityTokenName(agentId)}`]: 1n }, datum: encodeActivityDatum(datum) };
}

/** A lock of step 1: the datum at `address` with the stake + 2 AP3X and no token. */
export function lockUtxo(address: string, datum: string, lovelace: bigint, txHash = nextTx('1c')): UTxO {
  return { txHash, outputIndex: 0, address, assets: { lovelace }, datum };
}

/** A submitted proposal: its current output holds the proposal token of its seed. */
export function proposalUtxo(seed: OutRef, datum: ProposalDatum, at: OutRef = { txHash: nextTx('9a'), outputIndex: 0 }): UTxO {
  return {
    txHash: at.txHash, outputIndex: at.outputIndex, address: GOV.proposalAddress,
    assets: { lovelace: datum.stakeAmount + 2_000_000n, [`${GOV.proposalMint}${deriveProposalTokenName(seed.txHash, seed.outputIndex)}`]: 1n },
    datum: encodeProposalDatum(datum),
  };
}

// ─── Agents ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The proposer: a root record whose controller is CONTROLLER (identity-world) and whose listed key is LISTED. */
export const PROPOSER_ID = 'a1'.repeat(32);
/** A critic and an endorser with controllers of their own. */
export const CRITIC_ID = 'a2'.repeat(32);
export const ENDORSER_ID = 'a3'.repeat(32);
export const CRITIC_CONTROLLER = testKey(11);
export const ENDORSER_CONTROLLER = testKey(12);
/** The credential key of the nodes that nodeUtxo makes. */
export const CREDENTIAL = testKey(13);

export const criticRecord = (o: Partial<IdentityDatum> = {}): IdentityDatum => rootRecord({ controller: CRITIC_CONTROLLER.publicKey, keys: [], ...o });
export const endorserRecord = (o: Partial<IdentityDatum> = {}): IdentityDatum => rootRecord({ controller: ENDORSER_CONTROLLER.publicKey, keys: [], ...o });

/** The records of the three agents. */
export const AGENT_RECORDS: UTxO[] = [
  recordUtxo(PROPOSER_ID, rootRecord()),
  recordUtxo(CRITIC_ID, criticRecord()),
  recordUtxo(ENDORSER_ID, endorserRecord()),
];

/**
 * A node with the wallet, the identity reference scripts and configuration record (identityWorld), the Module-6 reference scripts, the
 * GovernanceParams record, the CrossRefs output, the agents' records and `extra` (the head of the activity list is not added: each test
 * places the list it needs).
 */
export function govWorld(extra: UTxO[] = [], opts: { params?: GovernanceParams; records?: UTxO[] } = {}): FixtureProvider {
  return identityWorld([...GOV_REF_UTXOS, paramsUtxo(opts.params), CROSS_REFS_UTXO, ...(opts.records ?? AGENT_RECORDS), ...extra]);
}
