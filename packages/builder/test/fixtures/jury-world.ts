// packages/builder/test/fixtures/jury-world.ts
// An offline world for the Module-1 and jury builders: the mainnet Module-1 deployment (its manifest and its applied claim and challenge
// scripts, module1-mainnet-scripts.json), a jury deployment whose script is the jury blueprint (jury-blueprint.json) with the mainnet
// JuryParams applied as at a deployment, identity records at the mainnet identity address, and a wallet whose key is the controller of
// those records. Lucid runs the real scripts of the reference inputs on every build (local evaluation), so a build that completes is
// one that the Module-1 validators and the jury validator accept, minus the signatures (the scripts read only the required signers).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Constr, Data, credentialToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { Script, UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider } from './fixture-provider.ts';
import { ALWAYS_SUCCEEDS, testKey } from './identity-world.ts';
import { applyParams } from '../../src/vector/identity-deployment.ts';
import { encodeIdentityDatum, plutusAddressFromBech32, utf8Hex } from '../../src/vector/identity-codec.ts';
import type { IdentityDatum, Party } from '../../src/vector/identity-codec.ts';
import { encodeClaimDatum, encodeJuryDatum, encodeJuryParams, juryParamsToData } from '../../src/vector/jury-codec.ts';
import type { CaseDatum, ClaimDatum, JurorDatum, JuryParams } from '../../src/vector/jury-codec.ts';
import { module1FromManifest, scriptAddress } from '../../src/vector/jury-deployment.ts';
import type { JuryConfig, JuryDeployment, Module1Deployment } from '../../src/vector/jury-deployment.ts';

const read = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname!, name), 'utf8'));

/** 2026-11-15T12:00:00Z: the time of every build in these tests. */
export const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

// ─── Wallet and identity ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The wallet key: the controller of every record below, so it is the declared credential of every agent. */
export const WALLET = testKey(11);
export const WALLET_ADDRESS = credentialToAddress('Mainnet', { type: 'Key', hash: WALLET.keyHash });
/** Another key: the owner of a juror whose owner is not the wallet. */
export const STRANGER = testKey(12);

/** The wallet outputs: three pure-AP3X outputs (one 5 AP3X, the collateral) and one with a token. */
export const WALLET_UTXOS: UTxO[] = [
  { txHash: 'f1'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 2_000_000_000n } },
  { txHash: 'f2'.repeat(32), outputIndex: 1, address: WALLET_ADDRESS, assets: { lovelace: 5_000_000n } },
  { txHash: 'f0'.repeat(32), outputIndex: 2, address: WALLET_ADDRESS, assets: { lovelace: 300_000_000n } },
  { txHash: 'f3'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 3_000_000n, [`${'11'.repeat(28)}74657374`]: 5n } },
];

export const IDENTITY_HASH = 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762';
export const IDENTITY_ADDRESS = scriptAddress(IDENTITY_HASH);

export const CLAIMER_ID = 'c1'.repeat(32);
export const AUDITOR_ID = 'a1'.repeat(32);
export const JUROR_ID = 'b1'.repeat(32);
export const JUROR2_ID = 'b2'.repeat(32);

const ACCOUNTABLE: Party = { role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: null, rights: 3, removalAfter: null };

/** An Active root record whose controller is the wallet key (or `controller`), created 30 days before NOW. */
export function agentRecord(overrides: Partial<IdentityDatum> = {}, controller = WALLET.publicKey): IdentityDatum {
  return {
    controller, keys: [], parties: [ACCOUNTABLE], guardianThreshold: 0, pendingRecovery: null, lineage: { type: 'Root' }, subagentEpoch: 0,
    name: utf8Hex('Test Agent'), description: '', framework: '', endpoint: '', capabilities: [], createdAt: NOW - 30 * DAY, status: { type: 'Active' },
    ...overrides,
  };
}

let recordCounter = 0;
/** The record output of `id` at the mainnet identity address with its identity token. */
export function recordUtxo(id: string, record: IdentityDatum = agentRecord()): UTxO {
  recordCounter += 1;
  return {
    txHash: (0x30 + recordCounter).toString(16).padStart(2, '0').repeat(32), outputIndex: 0, address: IDENTITY_ADDRESS,
    assets: { lovelace: 10_000_000n, [`${IDENTITY_HASH}${id}`]: 1n }, datum: encodeIdentityDatum(record),
  };
}

export const ZERO_KEY_ADDRESS = credentialToAddress('Mainnet', { type: 'Key', hash: '00'.repeat(28) });

// ─── Module-1 (mainnet) ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const MODULE1_MANIFEST = read('module1-mainnet-manifest.json');
export const MODULE1: Module1Deployment = module1FromManifest(MODULE1_MANIFEST, 'module1-mainnet-manifest.json');
const M1_SCRIPTS = read('module1-mainnet-scripts.json');
export const CLAIM_SCRIPT: Script = { type: 'PlutusV3', script: M1_SCRIPTS.claim.compiledCode };
export const CHALLENGE_SCRIPT: Script = { type: 'PlutusV3', script: M1_SCRIPTS.challenge.compiledCode };

/** The reference-script outputs of the claim and challenge scripts, the CrossValidatorRefs output and the ProtocolParams output. */
export const MODULE1_UTXOS: UTxO[] = [
  { ...MODULE1.claim.ref, address: ZERO_KEY_ADDRESS, assets: { lovelace: 60_000_000n }, scriptRef: CLAIM_SCRIPT },
  { ...MODULE1.challenge.ref, address: ZERO_KEY_ADDRESS, assets: { lovelace: 90_000_000n }, scriptRef: CHALLENGE_SCRIPT },
  {
    ...MODULE1.crossRefs, address: MODULE1_MANIFEST.module1.records_holder.address,
    assets: { lovelace: 2_000_000n, [`${MODULE1.refsTokenPolicy}${MODULE1_MANIFEST.module1.refs_token_name}`]: 1n },
    datum: Data.to(new Constr(0, [MODULE1.claim.hash, MODULE1.challenge.hash, MODULE1_MANIFEST.hashes.jury_pool])),
  },
  { ...MODULE1.params, address: MODULE1_MANIFEST.module1.records_holder.address, assets: { lovelace: 2_000_000n }, datum: MODULE1_MANIFEST.parameters.protocol_params_cbor },
];

/** A live claim output of `CLAIMER_ID` (state Open unless `overrides` says otherwise), submitted `ageMs` before NOW. */
export function claimUtxo(token: string, overrides: Partial<ClaimDatum> = {}, ageMs = HOUR): UTxO {
  const datum: ClaimDatum = {
    claimerDid: CLAIMER_ID, claimerCredential: { type: 'VerificationKey', hash: STRANGER.keyHash }, claimHash: '0c'.repeat(32), claimType: utf8Hex('certification'),
    storageUri: utf8Hex('vector-tx:cu8SkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), stakeAmount: 50_000_000n, submittedAt: NOW - ageMs, challengeWindow: 4 * HOUR, state: 'Open',
    ...overrides,
  };
  return {
    txHash: 'cc'.repeat(32), outputIndex: 0, address: MODULE1.claim.address, assets: { lovelace: datum.stakeAmount, [`${MODULE1.claim.hash}${token}`]: 1n },
    datum: encodeClaimDatum(datum),
  };
}

// ─── Jury ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The mainnet values of SPEC Section 3. */
export const JURY_PARAMS: JuryParams = {
  identityHash: IDENTITY_HASH, m1Claim: MODULE1.claim.hash, m1Challenge: MODULE1.challenge.hash,
  treasury: plutusAddressFromBech32('addr1wx2yu92dtp70q0stsv8kmnrv284lh836lp0l936x6gsrggshvzzlc'),
  bondMin: 250_000_000n, slash: 25_000_000n, jurorFloor: 10_000_000n, eligibilityDelay: 3 * DAY, exitNotice: 3 * DAY, commitWindow: 2 * HOUR,
  revealWindow: 2 * HOUR, resolveMargin: 2 * HOUR, claimPeriod: 30 * DAY, quorum: 3, majorityNum: 2, majorityDen: 3,
};

export const JURY_BLUEPRINT = read('jury-blueprint.json');
/**
 * The fixture records the case layout of the blueprint it copies. A blueprint from before SPEC amendment 2 (challenge_out and claim_out
 * in the case, no URIs) cannot decode the cases that the builders write, so the world then puts a script that accepts every
 * transaction in its place: the builders' own checks still run, the contract's do not. A blueprint copied from the rebuilt contract
 * has no such mark, and the world runs the real jury script.
 */
export const JURY_STAND_IN = JURY_BLUEPRINT.case_layout === 'pre-amendment-2';
/** The jury blueprint with JURY_PARAMS applied, as the deploy tool applies it (or the stand-in, see JURY_STAND_IN). */
export const JURY_SCRIPT: Script = JURY_STAND_IN ? ALWAYS_SUCCEEDS : { type: 'PlutusV3', script: applyParams(JURY_BLUEPRINT.compiledCode, [juryParamsToData(JURY_PARAMS)]) };
export const JURY_HASH = validatorToScriptHash(JURY_SCRIPT);

export const JURY: JuryDeployment = {
  hash: JURY_HASH, address: scriptAddress(JURY_HASH), ref: { txHash: 'e7'.repeat(32), outputIndex: 0 }, source: 'jury-world', network: 'mainnet',
  test: false, params: JURY_PARAMS, paramsCbor: encodeJuryParams(JURY_PARAMS), time: '2026-11-09T12:00:00Z',
};
export const JURY_REF_UTXO: UTxO = { ...JURY.ref, address: ZERO_KEY_ADDRESS, assets: { lovelace: 100_000_000n }, scriptRef: JURY_SCRIPT };

export const CONFIG: JuryConfig = { module1: MODULE1, juries: [JURY] };

export const JUROR_TOKEN = `6a72725f${'d1'.repeat(28)}`;
export const JUROR2_TOKEN = `6a72725f${'d2'.repeat(28)}`;
export const CASE_TOKEN = `6361735f${'e1'.repeat(28)}`;
export const CHALLENGE_TOKEN = `63686c5f${'0e'.repeat(28)}`;
export const CLAIM_TOKEN = `636c6d5f${'0f'.repeat(28)}`;

/** A juror registered `ageMs` before NOW, owned by the wallet key. */
export function jurorDatum(overrides: Partial<JurorDatum> = {}, ageMs = 4 * DAY): JurorDatum {
  return { agent: JUROR_ID, owner: WALLET.keyHash, promptHash: '5a'.repeat(32), registeredAt: NOW - ageMs, exitAfter: null, open: [], ...overrides };
}

/** A case opened `ageMs` before NOW (so in its commit window by default), with no ballot. */
export function caseDatum(overrides: Partial<CaseDatum> = {}, ageMs = 30 * 60_000): CaseDatum {
  const openedAt = NOW - ageMs;
  return {
    challenge: CHALLENGE_TOKEN, claim: CLAIM_TOKEN, challengeOut: { txHash: 'ce'.repeat(32), outputIndex: 0 }, claimOut: { txHash: 'cc'.repeat(32), outputIndex: 1 },
    claimer: CLAIMER_ID, auditor: AUDITOR_ID, claimHash: '0c'.repeat(32), evidenceHash: '0d'.repeat(32),
    deadline: openedAt + 72 * HOUR, openedAt, commitEnd: openedAt + 2 * HOUR, revealEnd: openedAt + 4 * HOUR, refundTo: plutusAddressFromBech32(WALLET_ADDRESS),
    fee: 0n, ballots: [], tally: { claimer: 0, auditor: 0, inconclusive: 0 }, state: { type: 'Open' }, ...overrides,
  };
}

let juryCounter = 0;
const juryTx = () => { juryCounter += 1; return (0x80 + juryCounter).toString(16).padStart(2, '0').repeat(32); };

export function jurorOutput(datum: JurorDatum = jurorDatum(), token = JUROR_TOKEN, lovelace = 300_000_000n): UTxO {
  return { txHash: juryTx(), outputIndex: 0, address: JURY.address, assets: { lovelace, [`${JURY.hash}${token}`]: 1n }, datum: encodeJuryDatum({ type: 'Juror', juror: datum }) };
}
export function caseOutput(datum: CaseDatum = caseDatum(), token = CASE_TOKEN, lovelace = 10_000_000n): UTxO {
  return { txHash: juryTx(), outputIndex: 1, address: JURY.address, assets: { lovelace, [`${JURY.hash}${token}`]: 1n }, datum: encodeJuryDatum({ type: 'Case', case: datum }) };
}

/** A node with the wallet, the Module-1 outputs, the jury reference script, the records of the four agents and `extra`. */
export function juryWorld(extra: UTxO[] = [], records: UTxO[] = [recordUtxo(CLAIMER_ID), recordUtxo(AUDITOR_ID), recordUtxo(JUROR_ID), recordUtxo(JUROR2_ID)]): FixtureProvider {
  return new FixtureProvider([...WALLET_UTXOS, ...MODULE1_UTXOS, JURY_REF_UTXO, ...records, ...extra]);
}
