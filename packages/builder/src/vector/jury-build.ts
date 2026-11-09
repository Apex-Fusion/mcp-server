// packages/builder/src/vector/jury-build.ts
// Keyless builders of the juror actions of the Module-1 jury (Module-1/jury/SPEC.md Section 6): register, exit request, exit, top-up,
// commit and reveal, and the publish of a document (SPEC Section 10). Each builder checks the rules of the contract that it can check
// before it builds, so that a refusal names the rule, then assembles the transaction through the jury reference script, lets Lucid
// run the script (local evaluation of the applied script that the reference input holds), and returns the unsigned CBOR with every key
// hash that must sign. Nothing is signed or submitted.
import type { LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { TOKEN_PREFIX, VOTES, commitHash, encodeJuryDatum, encodeJuryMint, encodeJurySpend, seedTokenName } from './jury-codec.js';
import type { Ballot, CaseDatum, JurorDatum, Vote } from './jury-codec.js';
import { readScriptRef } from './jury-deployment.js';
import type { JuryDeployment } from './jury-deployment.js';
import { DOCUMENT_LABEL, documentHash, documentMetadata, documentUri, txHashOfUri } from './jury-document.js';
import type { DocumentMetadata } from './jury-document.js';
import { agentRecords, identityRefusal, iso, minLovelace, windowWithin } from './jury-chain.js';
import { pickCase, pickJuror, readJuryOutputs } from './jury-read.js';
import type { CaseUtxo, JurorUtxo } from './jury-read.js';
import { chainClock, didOf, seedFrom, signedByResult, uniqueUtxos, walletOf, windowAt, SignerList } from './identity-chain.js';
import type { SignedByBuild, Window } from './identity-chain.js';
import { outputIndexOf } from './identity-build.js';
import { paymentKeyHashOf } from './gov-build.js';

/** What every jury builder works with: Lucid bound to the wallet, the node, and the jury deployment. */
export interface JuryContext { lucid: LucidEvolution; provider: Provider; jury: JuryDeployment }

/** What every jury build takes besides its own inputs. */
export interface JuryBuildCommon {
  /** The wallet: it pays the fee, gives the collateral and receives the change. */
  changeAddress: string;
  /** POSIX ms; default now. Tests fix it. */
  nowMs?: number;
  /** Minutes from now until the transaction expires (at most 59; the action's own time bounds can end it earlier). */
  validMinutes?: number;
}

const ada = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} AP3X`;
const OWNER_ROLE = 'juror owner';

// ─── Document publish (SPEC Section 10.1) ─────────────────────────────────────────────────────────────────────────────────────

export interface PublishParams extends JuryBuildCommon { bytes: Uint8Array; type: string; mediaType?: string }
export interface PublishBuild extends SignedByBuild { uri: string; documentHash: string; documentBytes: number; chunks: number }

/**
 * Builds the unsigned publish of a document: a transaction whose only content is the document as label 22084 metadata. Its id, so the
 * URI, is known before signing (signing adds witnesses, not body bytes). Only the wallet key signs; no collateral is needed.
 */
export async function buildDocumentPublish(lucid: LucidEvolution, provider: Provider, p: PublishParams): Promise<PublishBuild> {
  const metadata = documentMetadata(p.bytes, p.type, p.mediaType);
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const keyHash = paymentKeyHashOf(p.changeAddress);
  if ((await lucid.wallet().address()) !== p.changeAddress) throw new Error('changeAddress is not the address this wallet is bound to; nothing was built.');
  const completed = await lucid.newTx().attachMetadata(DOCUMENT_LABEL, metadata).validFrom(window.lo).validTo(window.hi).complete();
  const result = signedByResult(completed, window, new SignerList(), keyHash);
  return { ...result, uri: documentUri(result.txHash), documentHash: documentHash(p.bytes), documentBytes: p.bytes.length, chunks: metadata.d.length };
}

// ─── Register (SPEC Section 6.1) ──────────────────────────────────────────────────────────────────────────────────────────────

export interface RegisterParams extends JuryBuildCommon {
  /** The identifier of the juror DID. */
  agentId: string;
  /** The juror prompt document (SPEC Section 10.3): the transaction carries it, the datum keeps its hash. */
  prompt: Uint8Array;
  promptMediaType?: string;
  /** Default bond_min. */
  bondLovelace?: bigint;
}

export interface RegisterBuild extends SignedByBuild {
  jurorToken: string;
  jurorOutputIndex: number;
  seed: string;
  owner: string;
  promptHash: string;
  bondLovelace: bigint;
  registeredAt: number;
  eligibleFrom: number;
}

/**
 * Builds the unsigned registration of a juror (SPEC Section 6.1): it mints the juror token named from a seed that it spends (the
 * wallet's largest pure-AP3X output) and locks the bond in a juror output with the datum Juror (owner the wallet key, `registered_at`
 * the end of the window, no exit, no open vote). The DID's record is a reference input, the transaction carries the prompt document,
 * and the owner signs. Refuses a bond below bond_min, a subagent, a DID that is not Active and a wallet key that the record does not
 * declare.
 */
export async function buildJuryRegister(ctx: JuryContext, p: RegisterParams): Promise<RegisterBuild> {
  const { lucid, provider, jury } = ctx;
  const metadata = documentMetadata(p.prompt, 'juror-prompt', p.promptMediaType);
  const bond = p.bondLovelace ?? jury.params.bondMin;
  if (bond < jury.params.bondMin) throw new Error(`The bond must be at least ${ada(jury.params.bondMin)} (bond_min of the jury).`);
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const records = await agentRecords(provider, jury.params.identityHash, p.agentId, 'juror');
  const refusal = identityRefusal(records, wallet.keyHash, window, true);
  if (refusal) throw new Error(`The jury would refuse the registration: ${refusal}.`);
  const juryRef = await readScriptRef(provider, jury, 'jury');

  const seed = seedFrom(wallet.utxos);
  const jurorToken = seedTokenName(TOKEN_PREFIX.juror, seed);
  const unit = `${jury.hash}${jurorToken}`;
  const promptHash = documentHash(p.prompt);
  const datum = encodeJuryDatum({ type: 'Juror', juror: { agent: p.agentId, owner: wallet.keyHash, promptHash, registeredAt: window.hi, exitAfter: null, open: [] } });
  const minimum = minLovelace(lucid, jury.address, { [unit]: 1n }, datum);
  const lovelace = bond > minimum ? bond : minimum;
  const signers = new SignerList().add(wallet.keyHash, OWNER_ROLE);
  const completed = await lucid.newTx()
    .collectFrom([seed])
    .mintAssets({ [unit]: 1n }, encodeJuryMint({ type: 'Register', seed: { txHash: seed.txHash, outputIndex: seed.outputIndex } }))
    .pay.ToContract(jury.address, { kind: 'inline', value: datum }, { lovelace, [unit]: 1n })
    .readFrom(uniqueUtxos([juryRef, records[0].utxo]))
    .attachMetadata(DOCUMENT_LABEL, metadata)
    .addSignerKey(wallet.keyHash)
    .validFrom(window.lo)
    .validTo(window.hi)
    .complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  return {
    ...result, jurorToken, jurorOutputIndex: outputIndexOf(result.txCbor, jury.address, unit), seed: `${seed.txHash}#${seed.outputIndex}`,
    owner: wallet.keyHash, promptHash, bondLovelace: lovelace, registeredAt: window.hi, eligibleFrom: window.hi + jury.params.eligibilityDelay,
  };
}

// ─── Exit request, exit and top-up (SPEC Section 6.8) ─────────────────────────────────────────────────────────────────────────

export interface JurorActionParams extends JuryBuildCommon {
  /** The juror: its token name, its output reference, or its DID when it has one juror output. */
  juror: string;
}

export interface JurorActionBuild extends SignedByBuild {
  jurorToken: string;
  agent: string;
  /** The juror output that the transaction makes, or null for an exit (the token is burned). */
  jurorOutputIndex: number | null;
  jurorLovelace: bigint;
  juror: JurorDatum;
}

async function jurorOf(ctx: JuryContext, selector: string): Promise<JurorUtxo> {
  return pickJuror(await readJuryOutputs(ctx.provider, ctx.jury), selector, ctx.jury);
}

/** Completes a spend of the juror output into a continuing output with `datum` and `lovelace`, signed by the owner. */
async function continueJuror(ctx: JuryContext, juror: JurorUtxo, spend: string, datum: JurorDatum, lovelace: bigint, window: Window, changeAddress: string): Promise<JurorActionBuild> {
  const { lucid, provider, jury } = ctx;
  const wallet = await walletOf(lucid, changeAddress);
  const juryRef = await readScriptRef(provider, jury, 'jury');
  const unit = `${jury.hash}${juror.token}`;
  const completed = await lucid.newTx()
    .collectFrom([juror.utxo], spend)
    .pay.ToContract(jury.address, { kind: 'inline', value: encodeJuryDatum({ type: 'Juror', juror: datum }) }, { lovelace, [unit]: 1n })
    .readFrom([juryRef])
    .addSignerKey(juror.datum.owner)
    .validFrom(window.lo)
    .validTo(window.hi)
    .complete();
  const result = signedByResult(completed, window, new SignerList().add(juror.datum.owner, OWNER_ROLE), wallet.keyHash);
  return { ...result, jurorToken: juror.token, agent: juror.datum.agent, jurorOutputIndex: outputIndexOf(result.txCbor, jury.address, unit), jurorLovelace: lovelace, juror: datum };
}

/** Builds the unsigned exit request (SPEC Section 6.8, RequestExit): `exit_after` becomes the end of the window plus exit_notice; the value stays. */
export async function buildJuryRequestExit(ctx: JuryContext, p: JurorActionParams): Promise<JurorActionBuild> {
  await chainClock(ctx.provider);
  const juror = await jurorOf(ctx, p.juror);
  if (juror.datum.exitAfter !== null) throw new Error(`The juror ${juror.token} already asked to exit; it can exit from ${iso(juror.datum.exitAfter)} when it has no open vote. A request cannot be cancelled.`);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const datum: JurorDatum = { ...juror.datum, exitAfter: window.hi + ctx.jury.params.exitNotice };
  return continueJuror(ctx, juror, encodeJurySpend({ type: 'OnJuror', action: { type: 'RequestExit' } }), datum, juror.utxo.assets.lovelace, window, p.changeAddress);
}

/** Builds the unsigned top-up of a juror's bond (SPEC Section 6.8, TopUp): the same datum and more lovelace. */
export async function buildJuryTopUp(ctx: JuryContext, p: JurorActionParams & { amountLovelace: bigint }): Promise<JurorActionBuild> {
  if (p.amountLovelace <= 0n) throw new Error('The top-up must add at least 1 lovelace.');
  await chainClock(ctx.provider);
  const juror = await jurorOf(ctx, p.juror);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  return continueJuror(ctx, juror, encodeJurySpend({ type: 'OnJuror', action: { type: 'TopUp' } }), juror.datum, juror.utxo.assets.lovelace + p.amountLovelace, window, p.changeAddress);
}

/**
 * Builds the unsigned exit (SPEC Section 6.8, Exit): it spends the juror output and burns its token; the bond and any claimed fee shares
 * go to the wallet. Refuses a juror without an exit request, one whose notice runs, and one with an open vote.
 */
export async function buildJuryExit(ctx: JuryContext, p: JurorActionParams): Promise<JurorActionBuild> {
  const { lucid, provider, jury } = ctx;
  await chainClock(provider);
  const juror = await jurorOf(ctx, p.juror);
  const j = juror.datum;
  if (j.exitAfter === null) throw new Error(`The juror ${juror.token} has not asked to exit: build step 'request' first; it can exit ${jury.params.exitNotice / 86_400_000} days later.`);
  if (j.open.length > 0) throw new Error(`The juror ${juror.token} has ${j.open.length} unrevealed vote(s) (cases ${j.open.map((o) => o.case).join(', ')}): reveal them, or wait until anybody slashes them after the reveal window.`);
  const window = windowWithin(p.nowMs ?? Date.now(), p.validMinutes, { at: j.exitAfter, why: 'the exit notice of the juror ends' }, null);
  const wallet = await walletOf(lucid, p.changeAddress);
  const juryRef = await readScriptRef(provider, jury, 'jury');
  const unit = `${jury.hash}${juror.token}`;
  const completed = await lucid.newTx()
    .collectFrom([juror.utxo], encodeJurySpend({ type: 'OnJuror', action: { type: 'Exit' } }))
    .mintAssets({ [unit]: -1n }, encodeJuryMint({ type: 'Burn' }))
    .readFrom([juryRef])
    .addSignerKey(j.owner)
    .validFrom(window.lo)
    .validTo(window.hi)
    .complete();
  const result = signedByResult(completed, window, new SignerList().add(j.owner, OWNER_ROLE), wallet.keyHash);
  return { ...result, jurorToken: juror.token, agent: j.agent, jurorOutputIndex: null, jurorLovelace: juror.utxo.assets.lovelace, juror: j };
}

// ─── Commit and reveal (SPEC Sections 6.4, 6.5, 6.9, 6.10 and 7) ──────────────────────────────────────────────────────────────

export interface VoteParams extends JurorActionParams {
  /** The case: its token name, its output reference, or the token name of its challenge when the deployment has one case of it. */
  case: string;
  vote: Vote;
  /** 32 bytes, hex. */
  salt: string;
}

export interface VoteBuild extends SignedByBuild {
  jurorToken: string;
  caseToken: string;
  agent: string;
  vote: Vote;
  recordHash: string;
  commit: string;
  jurorOutputIndex: number;
  caseOutputIndex: number;
  /** The lovelace of the case output before and after the transaction: a larger datum can need more for the ledger minimum. */
  caseLovelaceBefore: bigint;
  caseLovelace: bigint;
  case: CaseDatum;
}

async function voteParties(ctx: JuryContext, p: VoteParams): Promise<{ juror: JurorUtxo; kase: CaseUtxo }> {
  const outputs = await readJuryOutputs(ctx.provider, ctx.jury);
  const kase = pickCase(outputs, p.case, ctx.jury);
  const juror = pickJuror(outputs, p.juror, ctx.jury);
  if (kase.datum.state.type !== 'Open') throw new Error(`The case ${kase.token} is Settling: its votes are over.`);
  return { juror, kase };
}

/**
 * The lovelace of the new case output: at least what it held, and at least its ledger minimum plus the fee, so that the fee never
 * pays for the ledger minimum (SPEC Section 9).
 */
function caseLovelace(ctx: JuryContext, kase: CaseUtxo, datum: string): bigint {
  const floor = minLovelace(ctx.lucid, ctx.jury.address, { [`${ctx.jury.hash}${kase.token}`]: 1n }, datum) + kase.datum.fee;
  return kase.utxo.assets.lovelace > floor ? kase.utxo.assets.lovelace : floor;
}

/** Completes the two spends of a commit or a reveal: the juror output and the case output into their continuing outputs. */
async function voteTx(
  ctx: JuryContext, p: VoteParams, juror: JurorUtxo, kase: CaseUtxo, spends: { juror: string; case: string },
  jurorDatum: JurorDatum, caseDatum: CaseDatum, window: Window, refs: UTxO[], metadata?: DocumentMetadata,
) {
  const { lucid, provider, jury } = ctx;
  const wallet = await walletOf(lucid, p.changeAddress);
  const juryRef = await readScriptRef(provider, jury, 'jury');
  const jurorUnit = `${jury.hash}${juror.token}`;
  const caseUnit = `${jury.hash}${kase.token}`;
  const caseHex = encodeJuryDatum({ type: 'Case', case: caseDatum });
  const lovelace = caseLovelace(ctx, kase, caseHex);
  let tx = lucid.newTx()
    .collectFrom([juror.utxo], spends.juror)
    .collectFrom([kase.utxo], spends.case)
    .pay.ToContract(jury.address, { kind: 'inline', value: encodeJuryDatum({ type: 'Juror', juror: jurorDatum }) }, { lovelace: juror.utxo.assets.lovelace, [jurorUnit]: 1n })
    .pay.ToContract(jury.address, { kind: 'inline', value: caseHex }, { lovelace, [caseUnit]: 1n })
    .readFrom(uniqueUtxos([juryRef, ...refs]))
    .addSignerKey(juror.datum.owner)
    .validFrom(window.lo)
    .validTo(window.hi);
  if (metadata) tx = tx.attachMetadata(DOCUMENT_LABEL, metadata);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, new SignerList().add(juror.datum.owner, OWNER_ROLE), wallet.keyHash);
  return {
    result, lovelace,
    jurorOutputIndex: outputIndexOf(result.txCbor, jury.address, jurorUnit), caseOutputIndex: outputIndexOf(result.txCbor, jury.address, caseUnit),
  };
}

/**
 * Builds the unsigned commit of a vote (SPEC Sections 6.4 and 6.9): the juror output gets the open vote, the case output gets the
 * ballot with the commitment of SPEC Section 7. The juror's record is a reference input (the identity check), and the owner signs.
 * Refuses what the contract refuses: a case outside its commit window, a juror before its eligibility or after its exit request, a bond
 * that cannot cover one more slash, a party of the case, a DID with a ballot in the case, and a failing identity check.
 */
export async function buildJuryCommit(ctx: JuryContext, p: VoteParams & { recordHash: string }): Promise<VoteBuild> {
  const { provider, jury } = ctx;
  const params = jury.params;
  await chainClock(provider);
  const { juror, kase } = await voteParties(ctx, p);
  const j = juror.datum;
  const c = kase.datum;
  if (j.open.some((o) => o.case === kase.token)) throw new Error(`The juror ${juror.token} already committed in the case ${kase.token}.`);
  if (j.exitAfter !== null) throw new Error(`The juror ${juror.token} asked to exit, so it cannot vote any more.`);
  const lovelace = juror.utxo.assets.lovelace;
  if (lovelace < params.bondMin) throw new Error(`The juror output holds ${ada(lovelace)}, below bond_min (${ada(params.bondMin)}): top it up first.`);
  if (j.agent === c.claimer || j.agent === c.auditor) throw new Error(`${didOf(j.agent)} is a party of the case (the ${j.agent === c.claimer ? 'claimer' : 'auditor'}); a party cannot vote in it.`);
  if (c.ballots.some((b) => b.agent === j.agent)) throw new Error(`${didOf(j.agent)} already has a ballot in the case ${kase.token}: one ballot per DID.`);
  const window = windowWithin(p.nowMs ?? Date.now(), p.validMinutes,
    { at: j.registeredAt + params.eligibilityDelay, why: 'the juror can vote only after the eligibility delay from its registration' },
    { at: c.commitEnd, why: `the commit window of the case ended` });
  const records = await agentRecords(provider, params.identityHash, j.agent, 'juror');
  const refusal = identityRefusal(records, j.owner, window, true);
  if (refusal) throw new Error(`The jury would refuse the commit: ${refusal}.`);

  const commit = commitHash({ case: kase.token, agent: j.agent, vote: p.vote, salt: p.salt, recordHash: p.recordHash });
  const jurorDatum: JurorDatum = { ...j, open: [{ case: kase.token, revealEnd: c.revealEnd }, ...j.open] };
  const ballot: Ballot = { agent: j.agent, juror: juror.token, commit, status: { type: 'Committed' } };
  const caseDatum: CaseDatum = { ...c, ballots: [ballot, ...c.ballots] };
  const built = await voteTx(ctx, p, juror, kase, {
    juror: encodeJurySpend({ type: 'OnJuror', action: { type: 'Commit', case: kase.token } }),
    case: encodeJurySpend({ type: 'OnCase', action: { type: 'CaseCommit', juror: juror.token, commit } }),
  }, jurorDatum, caseDatum, window, [records[0].utxo]);
  return {
    ...built.result, jurorToken: juror.token, caseToken: kase.token, agent: j.agent, vote: p.vote, recordHash: p.recordHash, commit,
    jurorOutputIndex: built.jurorOutputIndex, caseOutputIndex: built.caseOutputIndex, caseLovelaceBefore: kase.utxo.assets.lovelace,
    caseLovelace: built.lovelace, case: caseDatum,
  };
}

/** What a reveal takes besides the vote: the record, or only its hash when the record goes into its own transaction (overflow). */
export interface RevealParams extends VoteParams {
  /** The record document; required when it goes into the metadata of the reveal. */
  record?: Uint8Array;
  /** The record hash, when the record is not given (only without metadata). */
  recordHash?: string;
  recordMediaType?: string;
  /** Default true: the reveal carries the record as metadata. False: the overflow rule of SPEC Section 10.4. */
  withRecord?: boolean;
  /** Overflow only: the `vector-tx:` URI of the transaction that already holds the record; the reveal then carries a juror-record-ref document. */
  recordUri?: string;
}

/**
 * Builds the unsigned reveal of a vote (SPEC Sections 6.5 and 6.10): the open vote leaves the juror output, the ballot becomes Revealed
 * with the vote and the tally of the vote grows by one. By default the transaction carries the record document (SPEC Section 10.4).
 * Overflow (SPEC Section 10.4): the juror first publishes the same record bytes in its own juror-record transaction in the reveal
 * window; then `withRecord: false` with `recordUri` (that transaction's vector-tx: URI) makes the reveal carry a juror-record-ref
 * document. It checks the vote, the salt and the record hash against the commitment first. Refuses a reveal outside the reveal window
 * and a juror without a committed ballot in the case.
 */
export async function buildJuryReveal(ctx: JuryContext, p: RevealParams): Promise<VoteBuild> {
  const withRecord = p.withRecord ?? true;
  if (withRecord && p.record === undefined) throw new Error('A reveal with the record in its metadata needs the record itself.');
  if (withRecord && p.recordUri !== undefined) throw new Error('record_uri is only for a reveal without the record (record_in_metadata false).');
  if (!withRecord && p.recordUri === undefined) {
    throw new Error('A reveal without the record needs record_uri: first publish the same record bytes as a juror-record document in the reveal window, then give its vector-tx: URI (SPEC Section 10.4, overflow).');
  }
  if (p.recordUri !== undefined && txHashOfUri(p.recordUri) === null) throw new Error(`The record URI ${p.recordUri} is not a canonical vector-tx: URI.`);
  const metadata = withRecord
    ? documentMetadata(p.record!, 'juror-record', p.recordMediaType)
    : documentMetadata(new TextEncoder().encode(p.recordUri!), 'juror-record-ref', 'text/plain');
  const recordHash = p.record !== undefined ? documentHash(p.record) : p.recordHash?.toLowerCase();
  if (recordHash === undefined || !/^[0-9a-f]{64}$/.test(recordHash)) throw new Error('Give the record, or its 32-byte hash for a reveal without metadata.');
  if (p.record !== undefined && p.recordHash !== undefined && p.recordHash.toLowerCase() !== recordHash) throw new Error(`The record hash ${p.recordHash.toLowerCase()} is not the hash of the record (${recordHash}).`);
  await chainClock(ctx.provider);
  const { juror, kase } = await voteParties(ctx, p);
  const j = juror.datum;
  const c = kase.datum;
  const at = c.ballots.map((b, i) => (b.juror === juror.token ? i : -1)).filter((i) => i >= 0);
  if (at.length !== 1) throw new Error(`The juror ${juror.token} has no ballot in the case ${kase.token}: it did not commit there.`);
  const ballot = c.ballots[at[0]];
  if (ballot.status.type !== 'Committed') throw new Error(`The ballot of the juror ${juror.token} in the case ${kase.token} is already ${ballot.status.type}.`);
  if (j.open.filter((o) => o.case === kase.token).length !== 1) throw new Error(`The juror ${juror.token} has no open vote for the case ${kase.token}.`);
  const commit = commitHash({ case: kase.token, agent: ballot.agent, vote: p.vote, salt: p.salt, recordHash });
  if (commit !== ballot.commit) {
    throw new Error(`The vote ${p.vote}, the salt and the record (hash ${recordHash}) do not give the commitment of the ballot (${ballot.commit}): one of the three differs from the commit. Give the exact record bytes and salt of the commit.`);
  }
  const window = windowWithin(p.nowMs ?? Date.now(), p.validMinutes,
    { at: c.commitEnd, why: 'the reveal window opens when the commit window ends' },
    { at: c.revealEnd, why: 'the reveal window of the case ended; anybody can now slash the unrevealed vote' });

  const tally = { ...c.tally };
  if (p.vote === 'ClaimerWins') tally.claimer += 1;
  else if (p.vote === 'AuditorWins') tally.auditor += 1;
  else tally.inconclusive += 1;
  const ballots = c.ballots.map((b, i): Ballot => (i === at[0] ? { ...b, commit: '', status: { type: 'Revealed', vote: p.vote } } : b));
  const caseDatum: CaseDatum = { ...c, ballots, tally };
  const jurorDatum: JurorDatum = { ...j, open: j.open.filter((o) => o.case !== kase.token) };
  let built;
  try {
    built = await voteTx(ctx, p, juror, kase, {
      juror: encodeJurySpend({ type: 'OnJuror', action: { type: 'Reveal', case: kase.token } }),
      case: encodeJurySpend({ type: 'OnCase', action: { type: 'CaseReveal', juror: juror.token, vote: p.vote, salt: p.salt, recordHash } }),
    }, jurorDatum, caseDatum, window, [], metadata);
  } catch (err) {
    if (withRecord && /size/i.test(err instanceof Error ? err.message : String(err))) {
      throw new Error(`The reveal with the record does not fit in one transaction (${err instanceof Error ? err.message : String(err)}). First publish the same record bytes as a juror-record document in the reveal window, then build the reveal with record_in_metadata false and record_uri set to that document's vector-tx: URI (SPEC Section 10.4, overflow).`);
    }
    throw err;
  }
  return {
    ...built.result, jurorToken: juror.token, caseToken: kase.token, agent: j.agent, vote: p.vote, recordHash, commit,
    jurorOutputIndex: built.jurorOutputIndex, caseOutputIndex: built.caseOutputIndex, caseLovelaceBefore: kase.utxo.assets.lovelace,
    caseLovelace: built.lovelace, case: caseDatum,
  };
}

/** Every vote name, for a tool's input schema. */
export const VOTE_NAMES = [...VOTES] as [Vote, ...Vote[]];
