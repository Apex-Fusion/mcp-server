// packages/builder/src/vector/jury-codec.ts
// Plutus Data codecs of the Module-1 jury (Module-1/jury/SPEC.md Section 5) and of the Module-1 data that the jury tools write and
// read (ClaimDatum, ChallengeDatum and their redeemers, Module-1/contracts/lib/adversarial_auditing/types.ak), the token names of
// both (SPEC Section 4; Module-1 utils.ak), the commit hash (SPEC Section 7) and the result rule (SPEC Section 8).
//
// The conventions of identity-codec.ts: every ByteArray is lowercase hex (also the URI and claim-type fields, which hold UTF-8 text),
// times and counts are numbers (a value past 2^53 - 1 is refused with its field named), lovelace amounts are bigints. Decoders check
// the shape: constructor indices, field counts and fixed byte lengths. Every error is `<what>: <field path>: <problem>`.
import { Constr, Data } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { deriveNftAssetName } from '@apexfusion/vector-mcp-shared/tx';
import {
  bigintOf, bytesOf, constrFields, constrIndex, credentialData, credentialOf, hexData, intData, intOf, listOf, optionData, optionOf,
  outRefData, outRefOf, plutusAddressOf, plutusAddressToData,
} from './identity-codec.js';
import type { Credential, OutputReference, PlutusAddress } from './identity-codec.js';

const HEX = /^(?:[0-9a-f]{2})*$/;

/** Runs `body` and prefixes an error with the name of the codec. */
function codec<T>(name: string, body: () => T): T {
  try { return body(); } catch (err) { throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
}

function parse(hex: string): Data {
  if (typeof hex !== 'string' || !HEX.test(hex.toLowerCase())) throw new Error('cbor: expected hex');
  try { return Data.from(hex.toLowerCase()); } catch { throw new Error('cbor: not Plutus Data'); }
}

const tag = (index: number, fields: Data[] = []): Data => new Constr(index, fields);
/** A constructor without fields, of `count` constructors: its index. */
function tagOf(x: Data, path: string, count: number): number {
  const index = constrIndex(x, path, count);
  constrFields(x, path, index, 0);
  return index;
}

/** blake2b-256 of bytes, as lowercase hex. */
export const blake2b256Hex = (bytes: Uint8Array): string => Buffer.from(blake2b(bytes, { dkLen: 32 })).toString('hex');

// ─── Vote (SPEC Section 5.1; the Module-1 Verdict has the same indices) ───────────────────────────────────────────────────────

export const VOTES = ['ClaimerWins', 'AuditorWins', 'Inconclusive'] as const;
export type Vote = typeof VOTES[number];

/** The vote of its tool form, case-insensitive. */
export function voteFrom(text: string): Vote {
  const vote = VOTES.find((v) => v.toLowerCase() === text.trim().toLowerCase());
  if (!vote) throw new Error(`${JSON.stringify(text.slice(0, 40))} is not a vote: use ClaimerWins, AuditorWins or Inconclusive.`);
  return vote;
}
function voteData(vote: Vote, path: string): Data {
  const index = VOTES.indexOf(vote);
  if (index < 0) throw new Error(`${path}: unknown vote ${String(vote)}`);
  return tag(index);
}
const voteOf = (x: Data, path: string): Vote => VOTES[tagOf(x, path, 3)];

// ─── Juror datum (SPEC Section 5.2) ───────────────────────────────────────────────────────────────────────────────────────────

/** A commitment that is not revealed yet: the case token name and the case's `reveal_end`. */
export interface OpenVote { case: string; revealEnd: number }
export interface JurorDatum {
  /** The juror DID: a 32-byte identifier. */
  agent: string;
  /** The verification key hash that signs the juror's actions. */
  owner: string;
  /** blake2b-256 of the juror's prompt document (SPEC Section 10.3). */
  promptHash: string;
  /** `hi` of the registration. */
  registeredAt: number;
  /** Set by an exit request: the time from which the juror can exit. */
  exitAfter: number | null;
  open: OpenVote[];
}

// ─── Case datum (SPEC Section 5.3) ────────────────────────────────────────────────────────────────────────────────────────────

export type BallotStatus = { type: 'Committed' } | { type: 'Revealed'; vote: Vote } | { type: 'Paid'; vote: Vote };
export interface Ballot {
  agent: string;
  /** The juror token name. */
  juror: string;
  commit: string;
  status: BallotStatus;
}
export interface Tally { claimer: number; auditor: number; inconclusive: number }
export type CaseState = { type: 'Open' } | { type: 'Settling'; share: bigint };
export interface CaseDatum {
  challenge: string;
  claim: string;
  /** The challenge output that the opening transaction read; its datum holds the evidence URI. */
  challengeOut: OutputReference;
  /** The claim output that the opening transaction read; its datum holds the claim URI. */
  claimOut: OutputReference;
  claimer: string;
  auditor: string;
  claimHash: string;
  evidenceHash: string;
  deadline: number;
  openedAt: number;
  commitEnd: number;
  revealEnd: number;
  refundTo: PlutusAddress;
  fee: bigint;
  ballots: Ballot[];
  tally: Tally;
  state: CaseState;
}

export type JuryDatum = { type: 'Juror'; juror: JurorDatum } | { type: 'Case'; case: CaseDatum };

function jurorToData(j: JurorDatum): Data {
  const p = 'juror';
  return tag(0, [
    hexData(j.agent, `${p}.agent`, 32), hexData(j.owner, `${p}.owner`, 28), hexData(j.promptHash, `${p}.prompt_hash`, 32),
    intData(j.registeredAt, `${p}.registered_at`), optionData(j.exitAfter, (t) => intData(t, `${p}.exit_after`)),
    j.open.map((o, i) => tag(0, [hexData(o.case, `${p}.open[${i}].case`, 32), intData(o.revealEnd, `${p}.open[${i}].reveal_end`)])),
  ]);
}

function ballotStatusData(s: BallotStatus, path: string): Data {
  if (s.type === 'Committed') return tag(0);
  return tag(s.type === 'Revealed' ? 1 : 2, [voteData(s.vote, `${path}.vote`)]);
}

function caseToData(c: CaseDatum): Data {
  const p = 'case';
  return tag(1, [
    hexData(c.challenge, `${p}.challenge`, 32), hexData(c.claim, `${p}.claim`, 32), outRefData(c.challengeOut, `${p}.challenge_out`),
    outRefData(c.claimOut, `${p}.claim_out`), hexData(c.claimer, `${p}.claimer`, 32), hexData(c.auditor, `${p}.auditor`, 32),
    hexData(c.claimHash, `${p}.claim_hash`, 32), hexData(c.evidenceHash, `${p}.evidence_hash`, 32), intData(c.deadline, `${p}.deadline`),
    intData(c.openedAt, `${p}.opened_at`), intData(c.commitEnd, `${p}.commit_end`), intData(c.revealEnd, `${p}.reveal_end`),
    plutusAddressToData(c.refundTo, `${p}.refund_to`), c.fee,
    c.ballots.map((b, i) => tag(0, [
      hexData(b.agent, `${p}.ballots[${i}].agent`, 32), hexData(b.juror, `${p}.ballots[${i}].juror`, 32),
      hexData(b.commit, `${p}.ballots[${i}].commit`, b.status.type === 'Committed' ? 32 : 0), ballotStatusData(b.status, `${p}.ballots[${i}].status`),
    ])),
    tag(0, [intData(c.tally.claimer, `${p}.tally.claimer`), intData(c.tally.auditor, `${p}.tally.auditor`), intData(c.tally.inconclusive, `${p}.tally.inconclusive`)]),
    c.state.type === 'Open' ? tag(0) : tag(1, [c.state.share]),
  ]);
}

function jurorFromFields(f: Data[], p: string): JurorDatum {
  const [agent, owner, promptHash, registeredAt, exitAfter, open] = f;
  return {
    agent: bytesOf(agent, `${p}.agent`, 32), owner: bytesOf(owner, `${p}.owner`, 28), promptHash: bytesOf(promptHash, `${p}.prompt_hash`, 32),
    registeredAt: intOf(registeredAt, `${p}.registered_at`), exitAfter: optionOf(exitAfter, `${p}.exit_after`, (d, q) => intOf(d, q)),
    open: listOf(open, `${p}.open`, (d, q) => {
      const [c, revealEnd] = constrFields(d, q, 0, 2);
      return { case: bytesOf(c, `${q}.case`, 32), revealEnd: intOf(revealEnd, `${q}.reveal_end`) };
    }),
  };
}

function ballotStatusOf(x: Data, path: string): BallotStatus {
  const index = constrIndex(x, path, 3);
  if (index === 0) { constrFields(x, path, 0, 0); return { type: 'Committed' }; }
  const [vote] = constrFields(x, path, index, 1);
  return { type: index === 1 ? 'Revealed' : 'Paid', vote: voteOf(vote, `${path}.vote`) };
}

function caseFromFields(f: Data[], p: string): CaseDatum {
  const [challenge, claim, challengeOut, claimOut, claimer, auditor, claimHash, evidenceHash, deadline, openedAt, commitEnd, revealEnd, refundTo, fee, ballots, tally, state] = f;
  const [tc, ta, ti] = constrFields(tally, `${p}.tally`, 0, 3);
  const stateIndex = constrIndex(state, `${p}.state`, 2);
  return {
    challenge: bytesOf(challenge, `${p}.challenge`, 32), claim: bytesOf(claim, `${p}.claim`, 32), challengeOut: outRefOf(challengeOut, `${p}.challenge_out`),
    claimOut: outRefOf(claimOut, `${p}.claim_out`), claimer: bytesOf(claimer, `${p}.claimer`, 32), auditor: bytesOf(auditor, `${p}.auditor`, 32),
    claimHash: bytesOf(claimHash, `${p}.claim_hash`, 32), evidenceHash: bytesOf(evidenceHash, `${p}.evidence_hash`, 32),
    deadline: intOf(deadline, `${p}.deadline`), openedAt: intOf(openedAt, `${p}.opened_at`), commitEnd: intOf(commitEnd, `${p}.commit_end`),
    revealEnd: intOf(revealEnd, `${p}.reveal_end`), refundTo: plutusAddressOf(refundTo, `${p}.refund_to`), fee: bigintOf(fee, `${p}.fee`),
    ballots: listOf(ballots, `${p}.ballots`, (d, q) => {
      const [agent, juror, commit, status] = constrFields(d, q, 0, 4);
      const st = ballotStatusOf(status, `${q}.status`);
      // SPEC §6.10 rule 6: a reveal drops the commitment, so Revealed and Paid ballots hold an empty commit.
      return { agent: bytesOf(agent, `${q}.agent`, 32), juror: bytesOf(juror, `${q}.juror`, 32), commit: bytesOf(commit, `${q}.commit`, st.type === 'Committed' ? 32 : 0), status: st };
    }),
    tally: { claimer: intOf(tc, `${p}.tally.claimer`), auditor: intOf(ta, `${p}.tally.auditor`), inconclusive: intOf(ti, `${p}.tally.inconclusive`) },
    state: stateIndex === 0
      ? (constrFields(state, `${p}.state`, 0, 0), { type: 'Open' })
      : { type: 'Settling', share: bigintOf(constrFields(state, `${p}.state`, 1, 1)[0], `${p}.state.share`) },
  };
}

export const encodeJuryDatum = (d: JuryDatum): string =>
  codec('encodeJuryDatum', () => Data.to(d.type === 'Juror' ? jurorToData(d.juror) : caseToData(d.case)));

export function decodeJuryDatum(hex: string): JuryDatum {
  return codec('decodeJuryDatum', () => {
    const x = parse(hex);
    const index = constrIndex(x, 'datum', 2);
    if (index === 0) return { type: 'Juror', juror: jurorFromFields(constrFields(x, 'juror', 0, 6), 'juror') };
    return { type: 'Case', case: caseFromFields(constrFields(x, 'case', 1, 17), 'case') };
  });
}

// ─── Redeemers (SPEC Sections 5.4 and 5.5) ────────────────────────────────────────────────────────────────────────────────────

export type JuryMint = { type: 'Register'; seed: OutputReference } | { type: 'Open'; seed: OutputReference } | { type: 'Burn' };
export type JurorAction =
  | { type: 'Commit' | 'Reveal' | 'Claim' | 'Slash'; case: string }
  | { type: 'RequestExit' | 'Exit' | 'TopUp' };
export type CaseAction =
  | { type: 'CaseCommit'; juror: string; commit: string }
  | { type: 'CaseReveal'; juror: string; vote: Vote; salt: string; recordHash: string }
  | { type: 'Finalize'; result: Vote }
  | { type: 'CaseClaim'; juror: string }
  | { type: 'Close' };
export type JurySpend = { type: 'OnJuror'; action: JurorAction } | { type: 'OnCase'; action: CaseAction };

const JUROR_ACTIONS = ['Commit', 'Reveal', 'Claim', 'Slash', 'RequestExit', 'Exit', 'TopUp'] as const;
const CASE_ACTIONS = ['CaseCommit', 'CaseReveal', 'Finalize', 'CaseClaim', 'Close'] as const;

export function encodeJuryMint(r: JuryMint): string {
  return codec('encodeJuryMint', () => Data.to(r.type === 'Burn' ? tag(2) : tag(r.type === 'Register' ? 0 : 1, [outRefData(r.seed, 'seed')])));
}

function jurorActionData(a: JurorAction): Data {
  const index = JUROR_ACTIONS.indexOf(a.type);
  return 'case' in a ? tag(index, [hexData(a.case, 'case', 32)]) : tag(index);
}

function caseActionData(a: CaseAction): Data {
  switch (a.type) {
    case 'CaseCommit': return tag(0, [hexData(a.juror, 'juror', 32), hexData(a.commit, 'commit', 32)]);
    case 'CaseReveal': return tag(1, [hexData(a.juror, 'juror', 32), voteData(a.vote, 'vote'), hexData(a.salt, 'salt', 32), hexData(a.recordHash, 'record_hash', 32)]);
    case 'Finalize': return tag(2, [voteData(a.result, 'result')]);
    case 'CaseClaim': return tag(3, [hexData(a.juror, 'juror', 32)]);
    case 'Close': return tag(4);
  }
}

export function encodeJurySpend(r: JurySpend): string {
  return codec('encodeJurySpend', () => Data.to(r.type === 'OnJuror' ? tag(0, [jurorActionData(r.action)]) : tag(1, [caseActionData(r.action)])));
}

export function decodeJuryMint(hex: string): JuryMint {
  return codec('decodeJuryMint', () => {
    const x = parse(hex);
    const index = constrIndex(x, 'mint', 3);
    if (index === 2) { constrFields(x, 'mint', 2, 0); return { type: 'Burn' }; }
    return { type: index === 0 ? 'Register' : 'Open', seed: outRefOf(constrFields(x, 'mint', index, 1)[0], 'mint.seed') };
  });
}

export function decodeJurySpend(hex: string): JurySpend {
  return codec('decodeJurySpend', () => {
    const x = parse(hex);
    const side = constrIndex(x, 'spend', 2);
    const [action] = constrFields(x, 'spend', side, 1);
    if (side === 0) {
      const index = constrIndex(action, 'spend.action', JUROR_ACTIONS.length);
      const type = JUROR_ACTIONS[index];
      if (index <= 3) return { type: 'OnJuror', action: { type: type as 'Commit', case: bytesOf(constrFields(action, 'spend.action', index, 1)[0], 'spend.action.case', 32) } };
      constrFields(action, 'spend.action', index, 0);
      return { type: 'OnJuror', action: { type: type as 'Exit' } };
    }
    const index = constrIndex(action, 'spend.action', CASE_ACTIONS.length);
    const p = 'spend.action';
    switch (index) {
      case 0: { const [juror, commit] = constrFields(action, p, 0, 2); return { type: 'OnCase', action: { type: 'CaseCommit', juror: bytesOf(juror, `${p}.juror`, 32), commit: bytesOf(commit, `${p}.commit`, 32) } }; }
      case 1: {
        const [juror, vote, salt, recordHash] = constrFields(action, p, 1, 4);
        return { type: 'OnCase', action: { type: 'CaseReveal', juror: bytesOf(juror, `${p}.juror`, 32), vote: voteOf(vote, `${p}.vote`), salt: bytesOf(salt, `${p}.salt`, 32), recordHash: bytesOf(recordHash, `${p}.record_hash`, 32) } };
      }
      case 2: return { type: 'OnCase', action: { type: 'Finalize', result: voteOf(constrFields(action, p, 2, 1)[0], `${p}.result`) } };
      case 3: return { type: 'OnCase', action: { type: 'CaseClaim', juror: bytesOf(constrFields(action, p, 3, 1)[0], `${p}.juror`, 32) } };
      default: constrFields(action, p, 4, 0); return { type: 'OnCase', action: { type: 'Close' } };
    }
  });
}

// ─── Deployment parameter (SPEC Section 5.6) ──────────────────────────────────────────────────────────────────────────────────

export interface JuryParams {
  identityHash: string;
  m1Claim: string;
  m1Challenge: string;
  treasury: PlutusAddress;
  bondMin: bigint;
  slash: bigint;
  jurorFloor: bigint;
  eligibilityDelay: number;
  exitNotice: number;
  commitWindow: number;
  revealWindow: number;
  resolveMargin: number;
  claimPeriod: number;
  quorum: number;
  majorityNum: number;
  majorityDen: number;
}

/** The field names of JuryParams in the order of SPEC Section 5.6, as the deployment manifest writes them. */
export const JURY_PARAM_FIELDS = [
  'identity_hash', 'm1_claim', 'm1_challenge', 'treasury', 'bond_min', 'slash', 'juror_floor', 'eligibility_delay', 'exit_notice',
  'commit_window', 'reveal_window', 'resolve_margin', 'claim_period', 'quorum', 'majority_num', 'majority_den',
] as const;

export function juryParamsToData(p: JuryParams): Data {
  return tag(0, [
    hexData(p.identityHash, 'identity_hash', 28), hexData(p.m1Claim, 'm1_claim', 28), hexData(p.m1Challenge, 'm1_challenge', 28),
    plutusAddressToData(p.treasury, 'treasury'), p.bondMin, p.slash, p.jurorFloor, intData(p.eligibilityDelay, 'eligibility_delay'),
    intData(p.exitNotice, 'exit_notice'), intData(p.commitWindow, 'commit_window'), intData(p.revealWindow, 'reveal_window'),
    intData(p.resolveMargin, 'resolve_margin'), intData(p.claimPeriod, 'claim_period'), intData(p.quorum, 'quorum'),
    intData(p.majorityNum, 'majority_num'), intData(p.majorityDen, 'majority_den'),
  ]);
}

export const encodeJuryParams = (p: JuryParams): string => codec('encodeJuryParams', () => Data.to(juryParamsToData(p)));

export function decodeJuryParams(hex: string): JuryParams {
  return codec('decodeJuryParams', () => {
    const f = constrFields(parse(hex), 'params', 0, 16);
    return {
      identityHash: bytesOf(f[0], 'params.identity_hash', 28), m1Claim: bytesOf(f[1], 'params.m1_claim', 28), m1Challenge: bytesOf(f[2], 'params.m1_challenge', 28),
      treasury: plutusAddressOf(f[3], 'params.treasury'), bondMin: bigintOf(f[4], 'params.bond_min'), slash: bigintOf(f[5], 'params.slash'),
      jurorFloor: bigintOf(f[6], 'params.juror_floor'), eligibilityDelay: intOf(f[7], 'params.eligibility_delay'), exitNotice: intOf(f[8], 'params.exit_notice'),
      commitWindow: intOf(f[9], 'params.commit_window'), revealWindow: intOf(f[10], 'params.reveal_window'), resolveMargin: intOf(f[11], 'params.resolve_margin'),
      claimPeriod: intOf(f[12], 'params.claim_period'), quorum: intOf(f[13], 'params.quorum'), majorityNum: intOf(f[14], 'params.majority_num'),
      majorityDen: intOf(f[15], 'params.majority_den'),
    };
  });
}

/** The rules of SPEC Section 3 for the values (the deploy tool checks them; the validator does not), as problems in words. */
export function juryParamsProblems(p: JuryParams): string[] {
  const problems: string[] = [];
  const positive: Array<[string, bigint | number]> = [
    ['bond_min', p.bondMin], ['slash', p.slash], ['juror_floor', p.jurorFloor], ['eligibility_delay', p.eligibilityDelay], ['exit_notice', p.exitNotice],
    ['commit_window', p.commitWindow], ['reveal_window', p.revealWindow], ['resolve_margin', p.resolveMargin], ['claim_period', p.claimPeriod],
    ['quorum', p.quorum], ['majority_num', p.majorityNum], ['majority_den', p.majorityDen],
  ];
  for (const [name, value] of positive) if (!(BigInt(value) > 0n)) problems.push(`${name} must be positive`);
  if (p.bondMin < p.jurorFloor + p.slash) problems.push('bond_min must be at least juror_floor + slash');
  if (!(p.majorityNum < p.majorityDen && p.majorityDen < 2 * p.majorityNum)) problems.push('majority_num < majority_den < 2 * majority_num must hold');
  return problems;
}

// ─── Token names (SPEC Section 4; Module-1 utils.ak) ──────────────────────────────────────────────────────────────────────────

/** The 4-byte prefixes of the token names, as hex: `jrr_`, `cas_` (jury), `clm_`, `chl_` (Module-1). */
export const TOKEN_PREFIX = { juror: '6a72725f', case: '6361735f', claim: '636c6d5f', challenge: '63686c5f' } as const;

/** The token name of `seed`: the prefix, then the first 28 bytes of blake2b-256 of `serialiseData(seed)`. */
export const seedTokenName = (prefix: string, seed: OutputReference): string => `${prefix}${deriveNftAssetName(seed.txHash, seed.outputIndex).slice(0, 56)}`;

// ─── Commit hash (SPEC Section 7) and result rule (SPEC Section 8) ────────────────────────────────────────────────────────────

/** `blake2b_256(case_name ++ agent ++ vote_byte ++ salt ++ record_hash)`: a 129-byte preimage; every part but the vote is 32 bytes. */
export function commitHash(p: { case: string; agent: string; vote: Vote; salt: string; recordHash: string }): string {
  const part = (hex: string, name: string): Buffer => Buffer.from(hexData(hex, name, 32), 'hex');
  const preimage = Buffer.concat([part(p.case, 'case'), part(p.agent, 'agent'), Buffer.from([VOTES.indexOf(p.vote)]), part(p.salt, 'salt'), part(p.recordHash, 'record_hash')]);
  if (preimage.length !== 129 || VOTES.indexOf(p.vote) < 0) throw new Error('commitHash: the preimage must be 129 bytes with a known vote');
  return blake2b256Hex(preimage);
}

/** The number of revealed votes. */
export const revealed = (t: Tally): number => t.claimer + t.auditor + t.inconclusive;

/** `outcome(tally)`: a side wins with at least `quorum` revealed votes and at least majority_num/majority_den of them. */
export function outcome(t: Tally, p: Pick<JuryParams, 'quorum' | 'majorityNum' | 'majorityDen'>): Vote {
  const n = BigInt(revealed(t));
  const num = BigInt(p.majorityNum);
  const den = BigInt(p.majorityDen);
  if (n >= BigInt(p.quorum) && BigInt(t.claimer) * den >= n * num) return 'ClaimerWins';
  if (n >= BigInt(p.quorum) && BigInt(t.auditor) * den >= n * num) return 'AuditorWins';
  return 'Inconclusive';
}

// ─── Module-1 data (types.ak) ─────────────────────────────────────────────────────────────────────────────────────────────────

export const CLAIM_STATES = ['Open', 'Challenged', 'Validated', 'Invalidated'] as const;
export type ClaimState = typeof CLAIM_STATES[number];

/** The Module-1 ClaimDatum: Constr 0 with 9 fields. */
export interface ClaimDatum {
  claimerDid: string;
  claimerCredential: Credential;
  claimHash: string;
  /** UTF-8 bytes as hex, as is `storageUri`. */
  claimType: string;
  storageUri: string;
  stakeAmount: bigint;
  submittedAt: number;
  challengeWindow: number;
  state: ClaimState;
}

export type ChallengeState =
  | { type: 'PendingOracle' } | { type: 'PendingJury' } | { type: 'Voting'; selectedJurors: string[] }
  | { type: 'Resolved'; verdict: Vote; refundTo: PlutusAddress };

/** The Module-1 ChallengeDatum: Constr 0 with 11 fields, the claim token last. */
export interface ChallengeDatum {
  claimRef: OutputReference;
  auditorDid: string;
  auditorCredential: Credential;
  stakeAmount: bigint;
  evidenceHash: string;
  evidenceUri: string;
  challengedAt: number;
  resolutionDeadline: number;
  eligibleJurors: string[];
  state: ChallengeState;
  claimToken: string;
}

export function encodeClaimDatum(d: ClaimDatum): string {
  return codec('encodeClaimDatum', () => Data.to(tag(0, [
    hexData(d.claimerDid, 'claim.claimer_did', 32), credentialData(d.claimerCredential, 'claim.claimer_credential'), hexData(d.claimHash, 'claim.claim_hash'),
    hexData(d.claimType, 'claim.claim_type'), hexData(d.storageUri, 'claim.storage_uri'), d.stakeAmount, intData(d.submittedAt, 'claim.submitted_at'),
    intData(d.challengeWindow, 'claim.challenge_window'), tag(CLAIM_STATES.indexOf(d.state)),
  ])));
}

export function decodeClaimDatum(hex: string): ClaimDatum {
  return codec('decodeClaimDatum', () => {
    const p = 'claim';
    const [did, credential, claimHash, claimType, storageUri, stake, submittedAt, window, state] = constrFields(parse(hex), p, 0, 9);
    return {
      claimerDid: bytesOf(did, `${p}.claimer_did`, 32), claimerCredential: credentialOf(credential, `${p}.claimer_credential`),
      claimHash: bytesOf(claimHash, `${p}.claim_hash`), claimType: bytesOf(claimType, `${p}.claim_type`), storageUri: bytesOf(storageUri, `${p}.storage_uri`),
      stakeAmount: bigintOf(stake, `${p}.stake_amount`), submittedAt: intOf(submittedAt, `${p}.submitted_at`), challengeWindow: intOf(window, `${p}.challenge_window`),
      state: CLAIM_STATES[tagOf(state, `${p}.state`, 4)],
    };
  });
}

function challengeStateData(s: ChallengeState): Data {
  switch (s.type) {
    case 'PendingOracle': return tag(0);
    case 'PendingJury': return tag(1);
    case 'Voting': return tag(2, [s.selectedJurors.map((j, i) => hexData(j, `challenge.state.selected_jurors[${i}]`))]);
    case 'Resolved': return tag(3, [voteData(s.verdict, 'challenge.state.verdict'), plutusAddressToData(s.refundTo, 'challenge.state.refund_to')]);
  }
}

function challengeStateOf(x: Data, path: string): ChallengeState {
  const index = constrIndex(x, path, 4);
  if (index === 0) { constrFields(x, path, 0, 0); return { type: 'PendingOracle' }; }
  if (index === 1) { constrFields(x, path, 1, 0); return { type: 'PendingJury' }; }
  if (index === 2) return { type: 'Voting', selectedJurors: listOf(constrFields(x, path, 2, 1)[0], `${path}.selected_jurors`, (d, q) => bytesOf(d, q)) };
  const [verdict, refundTo] = constrFields(x, path, 3, 2);
  return { type: 'Resolved', verdict: voteOf(verdict, `${path}.verdict`), refundTo: plutusAddressOf(refundTo, `${path}.refund_to`) };
}

export function encodeChallengeDatum(d: ChallengeDatum): string {
  return codec('encodeChallengeDatum', () => Data.to(tag(0, [
    outRefData(d.claimRef, 'challenge.claim_ref'), hexData(d.auditorDid, 'challenge.auditor_did', 32),
    credentialData(d.auditorCredential, 'challenge.auditor_credential'), d.stakeAmount, hexData(d.evidenceHash, 'challenge.evidence_hash'),
    hexData(d.evidenceUri, 'challenge.evidence_uri'), intData(d.challengedAt, 'challenge.challenged_at'),
    intData(d.resolutionDeadline, 'challenge.resolution_deadline'), d.eligibleJurors.map((j, i) => hexData(j, `challenge.eligible_jurors[${i}]`)),
    challengeStateData(d.state), hexData(d.claimToken, 'challenge.claim_token'),
  ])));
}

export function decodeChallengeDatum(hex: string): ChallengeDatum {
  return codec('decodeChallengeDatum', () => {
    const p = 'challenge';
    const f = constrFields(parse(hex), p, 0, 11);
    return {
      claimRef: outRefOf(f[0], `${p}.claim_ref`), auditorDid: bytesOf(f[1], `${p}.auditor_did`, 32), auditorCredential: credentialOf(f[2], `${p}.auditor_credential`),
      stakeAmount: bigintOf(f[3], `${p}.stake_amount`), evidenceHash: bytesOf(f[4], `${p}.evidence_hash`), evidenceUri: bytesOf(f[5], `${p}.evidence_uri`),
      challengedAt: intOf(f[6], `${p}.challenged_at`), resolutionDeadline: intOf(f[7], `${p}.resolution_deadline`),
      eligibleJurors: listOf(f[8], `${p}.eligible_jurors`, (d, q) => bytesOf(d, q)), state: challengeStateOf(f[9], `${p}.state`),
      claimToken: bytesOf(f[10], `${p}.claim_token`),
    };
  });
}

/** The Module-1 redeemers that the claim and challenge builders use: ClaimAction.SubmitClaim, ClaimAction.MarkChallenged, ChallengeAction.OpenChallenge. */
export const SUBMIT_CLAIM_REDEEMER = Data.to(tag(0));
export const MARK_CHALLENGED_REDEEMER = Data.to(tag(2));
export const OPEN_CHALLENGE_REDEEMER = Data.to(tag(0));
