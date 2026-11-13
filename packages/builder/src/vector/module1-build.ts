// packages/builder/src/vector/module1-build.ts
// Keyless builders of the two Module-1 actions that start a dispute, for the deployment in oracle mode (Module-1/jury/SPEC.md
// Section 1): SubmitClaim and OpenChallenge. They port build_submit_claim and build_open_challenge of the Python builders
// (Module-1/simulation/tx_builder.py): the same datums, token names, reference inputs, validity window and required signer. The
// wallet inputs are chosen as Python chooses them (jury-chain.ts module1Inputs). They hold the stake and MODULE1_FEE_BUFFER for the
// fee and the change, so Lucid's coin selection adds no input (it takes the kept collateral output only when the change needs more
// than the buffer leaves), and the first input in ledger order, which names the new token, is known before the build; each build
// checks it again. Coin selection stays on because Lucid adds the fee of the reference scripts only on that path: without it a script
// that only the mint uses is not paid, and the node refuses the transaction. Lucid runs the deployed scripts of the reference inputs
// on the transaction (local evaluation), so a build that completes passes them, minus the signatures. Nothing is signed or submitted.
import type { LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import {
  MARK_CHALLENGED_REDEEMER, OPEN_CHALLENGE_REDEEMER, SUBMIT_CLAIM_REDEEMER, TOKEN_PREFIX, decodeClaimDatum, encodeChallengeDatum,
  encodeClaimDatum, seedTokenName,
} from './jury-codec.js';
import type { ChallengeDatum, ClaimDatum } from './jury-codec.js';
import { readScriptRef, refText } from './jury-deployment.js';
import type { Module1Deployment, OutRef } from './jury-deployment.js';
import { agentRecords, findTokenOutputAtScript, firstInput, identityRefusal, iso, ledgerOrder, module1Inputs, tokenAtScript, windowWithin } from './jury-chain.js';
import { chainClock, didOf, signedByResult, uniqueUtxos, walletOf, windowAt, SignerList } from './identity-chain.js';
import type { SignedByBuild } from './identity-chain.js';
import { outputIndexOf } from './identity-build.js';

/** What every Module-1 builder works with: Lucid bound to the wallet, the node, and the Module-1 deployment. */
export interface Module1Context { lucid: LucidEvolution; provider: Provider; module1: Module1Deployment }

/** What the wallet outputs that a Module-1 build spends must hold besides the stake: the fee and the change. */
export const MODULE1_FEE_BUFFER = 3_000_000n;
/** The longest URI that the builders write into a claim or a challenge: SPEC Section 10.2 keeps the URIs of our tools at 64 bytes. */
export const MAX_URI_BYTES = 64;

const ada = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} AP3X`;

/** The challenge window that build_submit_claim takes without one: 80% of the longest, inside the bounds of the deployment. */
export function defaultChallengeWindow(m1: Module1Deployment): number {
  const { minChallengeWindow: min, maxChallengeWindow: max } = m1.protocol;
  return Math.min(max, Math.max(min, Math.floor((max * 8) / 10)));
}

/** The CrossValidatorRefs and ProtocolParams outputs, which every Module-1 build reads; the first must hold a token of the refs policy. */
async function module1RecordUtxos(provider: Provider, m1: Module1Deployment): Promise<UTxO[]> {
  const utxos = await provider.getUtxosByOutRef([m1.crossRefs, m1.params]);
  const crossRefs = utxos.find((u) => u.txHash === m1.crossRefs.txHash && u.outputIndex === m1.crossRefs.outputIndex);
  const params = utxos.find((u) => u.txHash === m1.params.txHash && u.outputIndex === m1.params.outputIndex);
  if (!crossRefs || !params) throw new Error(`The Module-1 ${crossRefs ? 'params' : 'cross_refs'} output ${refText(crossRefs ? m1.params : m1.crossRefs)} of the manifest is not an unspent output on the node.`);
  if (!Object.keys(crossRefs.assets).some((unit) => unit.startsWith(m1.refsTokenPolicy))) {
    throw new Error(`The Module-1 cross_refs output ${refText(m1.crossRefs)} holds no token of the refs policy ${m1.refsTokenPolicy}, so the Module-1 scripts would not find it.`);
  }
  return [crossRefs, params];
}

function checkUri(hex: string, what: string): void {
  const size = hex.length / 2;
  if (size < 1 || size > MAX_URI_BYTES) throw new Error(`The ${what} URI must be 1 to ${MAX_URI_BYTES} bytes.`);
}

// ─── SubmitClaim ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SubmitClaimParams {
  /** The wallet: it pays the stake and the fee, gives the collateral and receives the change. Its key is the claimer credential. */
  changeAddress: string;
  /** The claimer's identifier. */
  agentId: string;
  /** blake2b-256 of the claim document (32 bytes, hex). */
  claimHash: string;
  /** The claim document URI, as UTF-8 bytes in hex. */
  claimUri: string;
  /** The claim type, as UTF-8 bytes in hex: 1 to 64 bytes. */
  claimType: string;
  stakeLovelace: bigint;
  /** Default defaultChallengeWindow. */
  challengeWindowMs?: number;
  /** POSIX ms; default now. Tests fix it. */
  nowMs?: number;
  validMinutes?: number;
}

export interface SubmitClaimBuild extends SignedByBuild {
  claimToken: string;
  claimOutputIndex: number;
  /** The wallet output whose reference names the claim token: the first input in ledger order. */
  seed: string;
  claim: ClaimDatum;
  /** `submitted_at + challenge_window`: the last moment of the challenge window. */
  challengeDeadline: number;
}

/**
 * Builds the unsigned SubmitClaim (claim.ak validate_submit_claim; build_submit_claim): it mints the claim token named from the first
 * input and locks exactly the stake in the claim output with the 9-field ClaimDatum (state Open, `submitted_at` inside the window). The
 * claimer's record and its ancestors, the claim reference script and the cross_refs and params outputs are reference inputs; the
 * wallet key is the claimer credential and signs. Refuses before it builds: a stake below min_claim_stake, a challenge window outside
 * the deployment's bounds, an empty or long claim type, a hash that is not 32 bytes, and an identity check that Module-1 would fail.
 */
export async function buildSubmitClaim(ctx: Module1Context, p: SubmitClaimParams): Promise<SubmitClaimBuild> {
  const { lucid, provider, module1 } = ctx;
  const pp = module1.protocol;
  if (p.stakeLovelace < pp.minClaimStake) throw new Error(`The claim stake must be at least ${ada(pp.minClaimStake)} (min_claim_stake of the deployment).`);
  const challengeWindow = p.challengeWindowMs ?? defaultChallengeWindow(module1);
  if (!Number.isSafeInteger(challengeWindow) || challengeWindow < pp.minChallengeWindow || challengeWindow > pp.maxChallengeWindow) {
    throw new Error(`The challenge window must be from ${pp.minChallengeWindow / 60_000} min to ${pp.maxChallengeWindow / 60_000} min.`);
  }
  const typeSize = p.claimType.length / 2;
  if (typeSize < 1 || typeSize > 64) throw new Error('The claim type must be 1 to 64 bytes of text.');
  if (!/^[0-9a-f]{64}$/.test(p.claimHash)) throw new Error('The claim hash must be 32 bytes (64 hex characters): blake2b-256 of the claim document.');
  checkUri(p.claimUri, 'claim');

  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const records = await agentRecords(provider, module1.identityHash, p.agentId, 'claimer');
  const refusal = identityRefusal(records, wallet.keyHash, window, false);
  if (refusal) throw new Error(`Module-1 would refuse the claim: ${refusal}.`);
  const claimScript = await readScriptRef(provider, module1.claim, 'Module-1 claim');
  const recordUtxos = await module1RecordUtxos(provider, module1);

  const inputs = module1Inputs(wallet.utxos, p.stakeLovelace + MODULE1_FEE_BUFFER);
  const seed = inputs[0];
  const claimToken = seedTokenName(TOKEN_PREFIX.claim, seed);
  const unit = `${module1.claim.hash}${claimToken}`;
  // build_submit_claim: submitted_at is the tip slot - 30 s, and the window starts at the tip slot - 60 s, so it lies inside the window.
  const submittedAt = window.lo + 30_000;
  const claim: ClaimDatum = {
    claimerDid: p.agentId, claimerCredential: { type: 'VerificationKey', hash: wallet.keyHash }, claimHash: p.claimHash, claimType: p.claimType,
    storageUri: p.claimUri, stakeAmount: p.stakeLovelace, submittedAt, challengeWindow, state: 'Open',
  };
  const signers = new SignerList().add(wallet.keyHash, 'claimer (the claimer credential of the claim)');
  const completed = await lucid.newTx()
    .collectFrom(inputs)
    .mintAssets({ [unit]: 1n }, SUBMIT_CLAIM_REDEEMER)
    .pay.ToContract(module1.claim.address, { kind: 'inline', value: encodeClaimDatum(claim) }, { lovelace: p.stakeLovelace, [unit]: 1n })
    .readFrom(uniqueUtxos([claimScript, ...recordUtxos, ...records.map((r) => r.utxo)]))
    .addSignerKey(wallet.keyHash)
    .validFrom(window.lo)
    .validTo(window.hi)
    .complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  const first = firstInput(result.txCbor);
  if (ledgerOrder(first, seed) !== 0) throw new Error(`The built transaction spends ${refText(first)} before the seed ${refText(seed)}, so the claim token would have another name; nothing is returned.`);
  return {
    ...result, claimToken, claimOutputIndex: outputIndexOf(result.txCbor, module1.claim.address, unit), seed: refText(seed), claim,
    challengeDeadline: submittedAt + challengeWindow,
  };
}

// ─── OpenChallenge (oracle mode) ──────────────────────────────────────────────────────────────────────────────────────────────

/** A live claim: its output at an address of the claim script, its token and its datum. */
export interface ClaimUtxo { utxo: UTxO; token: string; datum: ClaimDatum }

/**
 * The claim that `claim` names, by its token name or by its output reference: an output with one claim token at any address whose payment
 * credential is the claim script, with any stake credential (SPEC Section 5.7: Module-1 checks only the payment credential).
 */
export async function findClaim(provider: Provider, m1: Module1Deployment, claim: { token?: string; ref?: OutRef }): Promise<ClaimUtxo> {
  let utxo: UTxO | null | undefined;
  if (claim.token !== undefined) {
    utxo = await findTokenOutputAtScript(provider, m1.claim.hash, claim.token);
    if (!utxo) {
      throw new Error(`No live claim holds the claim token ${claim.token}: the claim was withdrawn or resolved, or the name is wrong. A claim at an address with a stake part is found through Koios, which can lag the node: name it by its output reference then.`);
    }
  } else if (claim.ref !== undefined) {
    [utxo] = await provider.getUtxosByOutRef([claim.ref]);
    if (!utxo) throw new Error(`The claim output ${refText(claim.ref)} is not an unspent output: the claim moved (it was challenged) or ended.`);
  } else {
    throw new Error('Name the claim by its token name or by its output reference.');
  }
  const token = tokenAtScript(utxo, m1.claim.hash);
  if (token === null) throw new Error(`${refText(utxo)} is not a Module-1 claim output: it is not at an address with the claim script ${m1.claim.hash} as its payment credential, or it does not hold exactly one claim token.`);
  if (!utxo.datum) throw new Error(`The claim ${refText(utxo)} has no inline datum.`);
  return { utxo, token, datum: decodeClaimDatum(utxo.datum) };
}

export interface OpenChallengeParams {
  /** The wallet: it pays the stake and the fee, gives the collateral and receives the change. Its key is the auditor credential. */
  changeAddress: string;
  /** The auditor's identifier. */
  auditorId: string;
  claim: { token?: string; ref?: OutRef };
  /** blake2b-256 of the evidence document (32 bytes, hex). */
  evidenceHash: string;
  /** The evidence document URI, as UTF-8 bytes in hex. */
  evidenceUri: string;
  stakeLovelace: bigint;
  /** Milliseconds after `challenged_at` before which the challenge must resolve. */
  resolutionDeadlineMs: number;
  nowMs?: number;
  validMinutes?: number;
}

export interface OpenChallengeBuild extends SignedByBuild {
  challengeToken: string;
  challengeOutputIndex: number;
  claimOutputIndex: number;
  claimToken: string;
  /** The claim output that the transaction spends. */
  claimInput: string;
  seed: string;
  challenge: ChallengeDatum;
  claim: ClaimDatum;
  /** `challenged_at + resolution_deadline`: the oracle must resolve before it; after it anybody can submit TimeoutResolve. */
  deadline: number;
}

/**
 * Builds the unsigned OpenChallenge of a deployment in oracle mode (challenge.ak validate_open_challenge and claim.ak
 * validate_mark_challenged; build_open_challenge with oracle_active): it spends the claim with MarkChallenged into a continuing claim
 * output at the address of the claim (state Challenged, every other field and the value unchanged), mints the challenge token named
 * from the first input, and locks exactly the stake in the challenge output with the 11-field ChallengeDatum (state PendingOracle, no
 * eligible jurors, the claim token last). The claim can sit at any address with the claim script as its payment credential (see
 * findClaim). The auditor's record and its ancestors, both reference scripts and the cross_refs and params outputs are reference
 * inputs; the wallet key is the auditor credential and signs. The window ends before the claim's challenge window does. Refuses before
 * it builds: a claim that is not Open, an auditor who is the claimer, a stake below the claim stake, a closed challenge window, and an
 * identity check that Module-1 would fail.
 */
export async function buildOpenChallenge(ctx: Module1Context, p: OpenChallengeParams): Promise<OpenChallengeBuild> {
  const { lucid, provider, module1 } = ctx;
  if (!Number.isSafeInteger(p.resolutionDeadlineMs) || p.resolutionDeadlineMs <= 0) throw new Error('The resolution deadline must be a positive number of milliseconds.');
  if (!/^[0-9a-f]{64}$/.test(p.evidenceHash)) throw new Error('The evidence hash must be 32 bytes (64 hex characters): blake2b-256 of the evidence document.');
  checkUri(p.evidenceUri, 'evidence');

  await chainClock(provider);
  const nowMs = p.nowMs ?? Date.now();
  const claim = await findClaim(provider, module1, p.claim);
  if (claim.datum.state !== 'Open') throw new Error(`The claim ${claim.token} is ${claim.datum.state}; only an Open claim can be challenged.`);
  if (claim.datum.claimerDid === p.auditorId) throw new Error(`The auditor ${didOf(p.auditorId)} is the claimer of this claim; an agent cannot audit its own claim.`);
  if (p.stakeLovelace < claim.datum.stakeAmount) throw new Error(`The challenge stake must be at least the claim stake, ${ada(claim.datum.stakeAmount)}.`);
  const claimDeadline = claim.datum.submittedAt + claim.datum.challengeWindow;
  // build_open_challenge ends the window a slot before the claim's deadline (challenge.ak: tx_ends_before).
  const window = windowWithin(nowMs, p.validMinutes, null, { at: claimDeadline - 1000, why: `the challenge window of the claim ends at ${iso(claimDeadline)}` });
  const wallet = await walletOf(lucid, p.changeAddress);
  const records = await agentRecords(provider, module1.identityHash, p.auditorId, 'auditor');
  const refusal = identityRefusal(records, wallet.keyHash, window, false);
  if (refusal) throw new Error(`Module-1 would refuse the challenge: ${refusal}.`);
  const claimScript = await readScriptRef(provider, module1.claim, 'Module-1 claim');
  const challengeScript = await readScriptRef(provider, module1.challenge, 'Module-1 challenge');
  const recordUtxos = await module1RecordUtxos(provider, module1);

  const walletInputs = module1Inputs(wallet.utxos, p.stakeLovelace + MODULE1_FEE_BUFFER);
  const seed = [...walletInputs, claim.utxo].sort(ledgerOrder)[0];
  const challengeToken = seedTokenName(TOKEN_PREFIX.challenge, seed);
  const unit = `${module1.challenge.hash}${challengeToken}`;
  // build_open_challenge: challenged_at is the tip slot, inside the window, as close to now as possible.
  const challengedAt = Math.floor(nowMs / 1000) * 1000;
  const challenge: ChallengeDatum = {
    claimRef: { txHash: claim.utxo.txHash, outputIndex: claim.utxo.outputIndex }, auditorDid: p.auditorId,
    auditorCredential: { type: 'VerificationKey', hash: wallet.keyHash }, stakeAmount: p.stakeLovelace, evidenceHash: p.evidenceHash,
    evidenceUri: p.evidenceUri, challengedAt, resolutionDeadline: p.resolutionDeadlineMs, eligibleJurors: [], state: { type: 'PendingOracle' },
    claimToken: claim.token,
  };
  const challenged: ClaimDatum = { ...claim.datum, state: 'Challenged' };
  // claim.ak finds the continuing claim output by the payment credential alone, so it goes back to the address of the claim: a stake part that the claimer chose stays.
  const signers = new SignerList().add(wallet.keyHash, 'auditor (the auditor credential of the challenge)');
  const completed = await lucid.newTx()
    .collectFrom([claim.utxo], MARK_CHALLENGED_REDEEMER)
    .collectFrom(walletInputs)
    .mintAssets({ [unit]: 1n }, OPEN_CHALLENGE_REDEEMER)
    .pay.ToContract(module1.challenge.address, { kind: 'inline', value: encodeChallengeDatum(challenge) }, { lovelace: p.stakeLovelace, [unit]: 1n })
    .pay.ToContract(claim.utxo.address, { kind: 'inline', value: encodeClaimDatum(challenged) }, claim.utxo.assets)
    .readFrom(uniqueUtxos([claimScript, challengeScript, ...recordUtxos, ...records.map((r) => r.utxo)]))
    .addSignerKey(wallet.keyHash)
    .validFrom(window.lo)
    .validTo(window.hi)
    .complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  const first = firstInput(result.txCbor);
  if (ledgerOrder(first, seed) !== 0) throw new Error(`The built transaction spends ${refText(first)} before the seed ${refText(seed)}, so the challenge token would have another name; nothing is returned.`);
  return {
    ...result, challengeToken, challengeOutputIndex: outputIndexOf(result.txCbor, module1.challenge.address, unit),
    claimOutputIndex: outputIndexOf(result.txCbor, claim.utxo.address, `${module1.claim.hash}${claim.token}`), claimToken: claim.token,
    claimInput: refText(claim.utxo), seed: refText(seed), challenge, claim: challenged, deadline: challengedAt + p.resolutionDeadlineMs,
  };
}
