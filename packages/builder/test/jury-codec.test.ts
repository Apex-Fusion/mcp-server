// packages/builder/test/jury-codec.test.ts
// The jury and Module-1 codecs: byte-exact against the Python library of the jury (fixtures/jury-python-vectors.json, made with
// vector_jury), real mainnet Module-1 datums and token names, the commit hash and the result rule. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Data, Constr } from '@lucid-evolution/lucid';
import {
  TOKEN_PREFIX, commitHash, decodeChallengeDatum, decodeClaimDatum, decodeJuryDatum, decodeJuryMint, decodeJuryParams, decodeJurySpend,
  encodeClaimDatum, encodeJuryDatum, encodeJuryMint, encodeJuryParams, encodeJurySpend, juryParamsProblems, outcome, seedTokenName, voteFrom,
} from '../src/vector/jury-codec.ts';
import type { CaseDatum, JurorDatum, JuryParams } from '../src/vector/jury-codec.ts';
import { plutusAddressFromBech32, textOf, utf8Hex } from '../src/vector/identity-codec.ts';
import { documentHash } from '../src/vector/jury-document.ts';
import { OWN_ADDRESS } from './fixtures/fixture-provider.ts';

const V = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/jury-python-vectors.json'), 'utf8'));

/** The mainnet values of SPEC Section 3, as JuryParams. */
const MAINNET_JURY_PARAMS: JuryParams = {
  identityHash: 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762', m1Claim: '53f6fc36219a3bc3c8af33c830480cff65aadb51baabb0bf485b4523',
  m1Challenge: '9873ba3348eef1c277bcd6dce266ae170f68aa3baa64cf859d0eec08', treasury: plutusAddressFromBech32('addr1wx2yu92dtp70q0stsv8kmnrv284lh836lp0l936x6gsrggshvzzlc'),
  bondMin: 250_000_000n, slash: 25_000_000n, jurorFloor: 10_000_000n, eligibilityDelay: 259_200_000, exitNotice: 259_200_000, commitWindow: 7_200_000,
  revealWindow: 7_200_000, resolveMargin: 7_200_000, claimPeriod: 2_592_000_000, quorum: 3, majorityNum: 2, majorityDen: 3,
};

const juror: JurorDatum = {
  agent: '22'.repeat(32), owner: '44'.repeat(28), promptHash: '55'.repeat(32), registeredAt: 1793785476000, exitAfter: 1794044676000,
  open: [{ case: V.case_token, revealEnd: 1793800000000 }],
};

const kase: CaseDatum = {
  challenge: `63686c5f${'01'.repeat(28)}`, claim: `636c6d5f${'02'.repeat(28)}`, challengeOut: { txHash: '0a'.repeat(32), outputIndex: 0 },
  claimOut: { txHash: '0b'.repeat(32), outputIndex: 1 }, claimer: '03'.repeat(32), auditor: '04'.repeat(32), claimHash: '05'.repeat(32), evidenceHash: '06'.repeat(32),
  deadline: 1794044676000, openedAt: 1793785476000, commitEnd: 1793792676000, revealEnd: 1793799876000, refundTo: plutusAddressFromBech32(OWN_ADDRESS),
  fee: 5_000_000n,
  ballots: [
    { agent: '22'.repeat(32), juror: V.juror_token, commit: V.commit, status: { type: 'Committed' } },
    { agent: '66'.repeat(32), juror: '77'.repeat(32), commit: '', status: { type: 'Revealed', vote: 'ClaimerWins' } },
    { agent: '99'.repeat(32), juror: 'aa'.repeat(32), commit: '', status: { type: 'Paid', vote: 'Inconclusive' } },
  ],
  tally: { claimer: 1, auditor: 0, inconclusive: 1 }, state: { type: 'Settling', share: 2_500_000n },
};

/** The same Data in Lucid's encoding: pycardano writes a list as a definite array, Lucid (like Plutus serialiseData) an indefinite one. */
const sameData = (hex: string): string => Data.to(Data.from(hex));

describe('jury datums and redeemers: the Data of the Python library', () => {
  test('a Juror datum encodes to the same Data and decodes back', () => {
    assert.equal(encodeJuryDatum({ type: 'Juror', juror }), sameData(V.juror_datum));
    assert.deepEqual(decodeJuryDatum(V.juror_datum), { type: 'Juror', juror });
  });

  test('a Case datum (17 fields, every ballot status, Settling) encodes to the same Data and decodes back', () => {
    assert.equal(encodeJuryDatum({ type: 'Case', case: kase }), sameData(V.case_datum));
    assert.deepEqual(decodeJuryDatum(V.case_datum), { type: 'Case', case: kase });
    const fields = (Data.from(V.case_datum) as Constr<Data>).fields;
    assert.equal(fields.length, 17, 'the Case datum of SPEC amendment 1 has 17 fields (no deposit)');
  });

  test('the redeemers encode to the same bytes and decode back', () => {
    const commit = { type: 'OnJuror', action: { type: 'Commit', case: V.case_token } } as const;
    const reveal = { type: 'OnCase', action: { type: 'CaseReveal', juror: V.juror_token, vote: 'AuditorWins', salt: V.salt, recordHash: V.record_hash } } as const;
    assert.equal(encodeJurySpend(commit), V.spend_commit);
    assert.equal(encodeJurySpend(reveal), V.spend_case_reveal);
    assert.equal(encodeJurySpend({ type: 'OnJuror', action: { type: 'RequestExit' } }), V.spend_request_exit);
    assert.equal(encodeJurySpend({ type: 'OnCase', action: { type: 'Finalize', result: 'Inconclusive' } }), V.spend_finalize);
    assert.deepEqual(decodeJurySpend(V.spend_commit), commit);
    assert.deepEqual(decodeJurySpend(V.spend_case_reveal), reveal);
    const register = { type: 'Register', seed: { txHash: 'cd'.repeat(32), outputIndex: 300 } } as const;
    assert.equal(encodeJuryMint(register), V.mint_register);
    assert.deepEqual(decodeJuryMint(V.mint_register), register);
    assert.equal(encodeJuryMint({ type: 'Burn' }), V.mint_burn);
  });

  test('every juror and case action round-trips', () => {
    const actions = [
      { type: 'OnJuror', action: { type: 'Reveal', case: V.case_token } }, { type: 'OnJuror', action: { type: 'Claim', case: V.case_token } },
      { type: 'OnJuror', action: { type: 'Slash', case: V.case_token } }, { type: 'OnJuror', action: { type: 'Exit' } }, { type: 'OnJuror', action: { type: 'TopUp' } },
      { type: 'OnCase', action: { type: 'CaseCommit', juror: V.juror_token, commit: V.commit } }, { type: 'OnCase', action: { type: 'CaseClaim', juror: V.juror_token } },
      { type: 'OnCase', action: { type: 'Close' } },
    ] as const;
    for (const a of actions) assert.deepEqual(decodeJurySpend(encodeJurySpend(a)), a);
  });

  test('a datum of the wrong shape is refused with the field named', () => {
    assert.throws(() => decodeJuryDatum(Data.to(new Constr(1, [V.case_token]))), /decodeJuryDatum: case: expected 17 fields, got 1/);
    assert.throws(() => encodeJuryDatum({ type: 'Juror', juror: { ...juror, owner: '44'.repeat(27) } }), /juror\.owner: expected 28 bytes/);
  });
});

describe('JuryParams', () => {
  test('the mainnet values encode to the params CBOR of the Python deploy tool, and decode back', () => {
    assert.equal(encodeJuryParams(MAINNET_JURY_PARAMS), V.params_cbor);
    assert.deepEqual(decodeJuryParams(V.params_cbor), MAINNET_JURY_PARAMS);
    assert.deepEqual(juryParamsProblems(MAINNET_JURY_PARAMS), []);
  });

  test('the rules of SPEC Section 3 are checked', () => {
    assert.deepEqual(juryParamsProblems({ ...MAINNET_JURY_PARAMS, bondMin: 30_000_000n }), ['bond_min must be at least juror_floor + slash']);
    assert.match(juryParamsProblems({ ...MAINNET_JURY_PARAMS, majorityNum: 1, majorityDen: 3 }).join(), /majority_num < majority_den < 2 \* majority_num/);
    assert.match(juryParamsProblems({ ...MAINNET_JURY_PARAMS, quorum: 0 }).join(), /quorum must be positive/);
  });

  test('SPEC amendment 2: majority_den must be below 2 * majority_num', () => {
    assert.match(juryParamsProblems({ ...MAINNET_JURY_PARAMS, majorityNum: 2, majorityDen: 4 }).join(), /majority_num < majority_den < 2 \* majority_num/);
  });
});

describe('token names', () => {
  test('Module-1 claim and challenge tokens of mainnet come from their first inputs', () => {
    // Mainnet: claim 4658fd5a…b787 (first input 5e12d94a…2863#1) and challenge f821b313…7d93 (first input the claim 4658fd5a…b787#0).
    assert.equal(seedTokenName(TOKEN_PREFIX.claim, { txHash: '5e12d94ac9c779dcb1f541e369b925e3bd63ddee71e6833acd785b5feb0c2863', outputIndex: 1 }),
      '636c6d5f755399bdf97db8329415605ff6aba170606a318675fc16f63e718b77');
    assert.equal(seedTokenName(TOKEN_PREFIX.challenge, { txHash: '4658fd5aa0b050cacb6d0000cb8116f20bc7469148d8faf6c0178c2a1f5cb787', outputIndex: 0 }),
      '63686c5fceeae49316a60053cae9192b3d92ab27ddae968ebe878796e9409657');
  });

  test('juror and case tokens are the names of the Python library (an index above 255 included)', () => {
    assert.equal(seedTokenName(TOKEN_PREFIX.case, { txHash: 'ab'.repeat(32), outputIndex: 3 }), V.case_token);
    assert.equal(seedTokenName(TOKEN_PREFIX.juror, { txHash: 'cd'.repeat(32), outputIndex: 300 }), V.juror_token);
  });
});

describe('commit hash and result rule', () => {
  test('the commitment of SPEC Section 7 is the one of the Python library', () => {
    const recordHash = documentHash(Buffer.from(V.record_preimage_text, 'utf8'));
    assert.equal(recordHash, V.record_hash);
    assert.equal(commitHash({ case: V.case_token, agent: V.agent, vote: 'AuditorWins', salt: V.salt, recordHash }), V.commit);
    assert.notEqual(commitHash({ case: V.case_token, agent: V.agent, vote: 'ClaimerWins', salt: V.salt, recordHash }), V.commit);
    assert.throws(() => commitHash({ case: V.case_token, agent: V.agent, vote: 'AuditorWins', salt: '33'.repeat(31), recordHash }), /salt: expected 32 bytes/);
  });

  test('outcome: a side needs the quorum and 2/3 of the revealed votes; Inconclusive votes count', () => {
    const p = MAINNET_JURY_PARAMS;
    assert.equal(outcome({ claimer: 2, auditor: 0, inconclusive: 0 }, p), 'Inconclusive');
    assert.equal(outcome({ claimer: 3, auditor: 0, inconclusive: 0 }, p), 'ClaimerWins');
    assert.equal(outcome({ claimer: 2, auditor: 1, inconclusive: 0 }, p), 'ClaimerWins');
    assert.equal(outcome({ claimer: 1, auditor: 2, inconclusive: 0 }, p), 'AuditorWins');
    assert.equal(outcome({ claimer: 3, auditor: 2, inconclusive: 0 }, p), 'Inconclusive');
    assert.equal(outcome({ claimer: 0, auditor: 4, inconclusive: 2 }, p), 'AuditorWins');
    assert.equal(outcome({ claimer: 0, auditor: 3, inconclusive: 2 }, p), 'Inconclusive');
  });

  test('votes parse case-insensitively and refuse other words', () => {
    assert.equal(voteFrom('auditorwins'), 'AuditorWins');
    assert.throws(() => voteFrom('yes'), /is not a vote/);
  });
});

describe('Module-1 datums of mainnet', () => {
  // Koios datum_info of the claim 4658fd5a…b787#0 (state Open) and the challenge f821b313…7d93#0 (cbor2 writes definite lists).
  const CLAIM = 'd879895820b399a61facdaf136d5114cdc428555272c807ab8f3f68051e1a076b0781a63c4d87981581c8c1a4155461a657b0c8a6c58600e07b59a2f211c2771741f38f0435f5820e535041f533f95ab40db98ced6f0812f56a85525b791bb0799f91af24bc7b3a34d63657274696669636174696f6e583a68747470733a2f2f6d61726b6574706c6163652e766563746f722e61706578667573696f6e2e6f72672f65766964656e63652f63322e6a736f6e1a02faf0801b000001a1a5f18f901a0036ee80d87980';
  const CHALLENGE = 'd8798bd8798258204658fd5aa0b050cacb6d0000cb8116f20bc7469148d8faf6c0178c2a1f5cb78700582044ca2b6984627a40698506276e58b01d1596206c92cfa0627e8e5c89db638249d87981581c312ff0d59647f6c146ed0e069444f1e442ead9e2243a2c6573f0da721a02faf0805820e3533da833ef349b823fccf02bcc55524184189baee44d71cff69fce93962e88583a68747470733a2f2f6d61726b6574706c6163652e766563746f722e61706578667573696f6e2e6f72672f65766964656e63652f65322e6a736f6e1b000001a1a5f220181a0f73140080d879805820636c6d5f755399bdf97db8329415605ff6aba170606a318675fc16f63e718b77';

  test('the claim decodes (9 fields) and re-encodes to the same Data', () => {
    const claim = decodeClaimDatum(CLAIM);
    assert.equal(claim.claimerDid, 'b399a61facdaf136d5114cdc428555272c807ab8f3f68051e1a076b0781a63c4');
    assert.deepEqual(claim.claimerCredential, { type: 'VerificationKey', hash: '8c1a4155461a657b0c8a6c58600e07b59a2f211c2771741f38f0435f' });
    assert.equal(textOf(claim.claimType), 'certification');
    assert.equal(textOf(claim.storageUri), 'https://marketplace.vector.apexfusion.org/evidence/c2.json');
    assert.equal(claim.stakeAmount, 50_000_000n);
    assert.equal(claim.challengeWindow, 3_600_000);
    assert.equal(claim.state, 'Open');
    assert.deepEqual(decodeClaimDatum(encodeClaimDatum(claim)), claim);
    assert.equal(decodeClaimDatum(encodeClaimDatum({ ...claim, state: 'Challenged' })).state, 'Challenged');
  });

  test('the challenge decodes (11 fields, PendingOracle, the claim token last)', () => {
    const ch = decodeChallengeDatum(CHALLENGE);
    assert.deepEqual(ch.claimRef, { txHash: '4658fd5aa0b050cacb6d0000cb8116f20bc7469148d8faf6c0178c2a1f5cb787', outputIndex: 0 });
    assert.equal(ch.auditorDid, '44ca2b6984627a40698506276e58b01d1596206c92cfa0627e8e5c89db638249');
    assert.equal(ch.resolutionDeadline, 259_200_000);
    assert.deepEqual(ch.eligibleJurors, []);
    assert.deepEqual(ch.state, { type: 'PendingOracle' });
    assert.equal(ch.claimToken, '636c6d5f755399bdf97db8329415605ff6aba170606a318675fc16f63e718b77');
  });
});
