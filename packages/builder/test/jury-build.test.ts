// packages/builder/test/jury-build.test.ts
// The juror builders and the document publish against the jury blueprint with the mainnet parameters applied (jury-world.ts): Lucid
// runs the jury validator on each build, so a build that completes is one that the validator accepts, minus the signatures. The
// refusals name the rule before anything is built. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  buildDocumentPublish, buildJuryCommit, buildJuryExit, buildJuryRegister, buildJuryRequestExit, buildJuryReveal, buildJuryTopUp,
} from '../src/vector/jury-build.ts';
import type { JuryContext } from '../src/vector/jury-build.ts';
import { TOKEN_PREFIX, commitHash, decodeJuryDatum, encodeJuryDatum, encodeJuryMint, seedTokenName } from '../src/vector/jury-codec.ts';
import type { CaseDatum, JurorDatum } from '../src/vector/jury-codec.ts';
import { documentFromMetadata, documentHash, documentUri } from '../src/vector/jury-document.ts';
import { chainClock, windowAt } from '../src/vector/identity-chain.ts';
import {
  AUDITOR_ID, CASE_TOKEN, DAY, HOUR, IDENTITY_ADDRESS, IDENTITY_HASH, JURY, JURY_REF_UTXO, JUROR2_ID, JUROR2_TOKEN, JUROR_ID, JUROR_TOKEN, NOW, STRANGER,
  WALLET, WALLET_ADDRESS, WALLET_UTXOS, JURY_STAND_IN, agentRecord, caseDatum, caseOutput, jurorDatum, jurorOutput, juryWorld, recordUtxo,
} from './fixtures/jury-world.ts';

const PROMPT = Buffer.from(JSON.stringify({ type: 'vector-jury-prompt/1', juror: `did:vector:${JUROR_ID}`, instructions: 'Decide one vote. '.repeat(20), max_output_tokens: 4000 }), 'utf8');
const RECORD = Buffer.from(JSON.stringify({ type: 'vector-jury-record/1', case: CASE_TOKEN, vote: 'AuditorWins', reason: 'The evidence shows that the claim is false. '.repeat(10) }), 'utf8');
const SALT = '5a17'.repeat(16);

async function ctxOf(extra: UTxO[] = [], records?: UTxO[]): Promise<JuryContext> {
  const provider = juryWorld(extra, records);
  return { provider, jury: JURY, lucid: await lucidForAddress(provider, WALLET_ADDRESS) };
}

/** The outputs of a built transaction: address, lovelace, units and inline datum. */
function outputsOf(txCbor: string) {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  return Array.from({ length: outputs.len() }, (_, i) => {
    const o = outputs.get(i);
    return { address: o.address().to_bech32(), lovelace: o.amount().coin(), datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null };
  });
}
const jurorAt = (txCbor: string, i: number): JurorDatum => { const d = decodeJuryDatum(outputsOf(txCbor)[i].datum!); assert.equal(d.type, 'Juror'); return (d as { juror: JurorDatum }).juror; };
const caseAt = (txCbor: string, i: number): CaseDatum => { const d = decodeJuryDatum(outputsOf(txCbor)[i].datum!); assert.equal(d.type, 'Case'); return (d as { case: CaseDatum }).case; };

/** The document in the label 22084 metadata of a built transaction, read as Koios shows metadata (JSON without schema). */
function documentOf(txCbor: string) {
  const metadatum = CML.Transaction.from_cbor_hex(txCbor).auxiliary_data()?.metadata()?.get(22084n);
  assert.ok(metadatum, 'the transaction carries label 22084 metadata');
  return documentFromMetadata(JSON.parse(CML.decode_metadatum_to_json_str(metadatum, CML.MetadataJsonSchema.BasicConversions)));
}

describe('buildDocumentPublish', () => {
  test('the transaction carries the document; the URI names its id', async () => {
    const ctx = await ctxOf();
    const doc = Buffer.from(JSON.stringify({ claim: 'The agent indexed 1,000 pages. '.repeat(12), proof: '0x00ff' }), 'utf8');
    const r = await buildDocumentPublish(ctx.lucid, ctx.provider, { changeAddress: WALLET_ADDRESS, bytes: doc, type: 'claim', nowMs: NOW });
    assert.equal(r.uri, documentUri(r.txHash));
    assert.equal(r.documentHash, documentHash(doc));
    const back = documentOf(r.txCbor);
    assert.deepEqual(back.bytes, doc);
    assert.equal(back.type, 'claim');
    assert.equal(CML.Transaction.from_cbor_hex(r.txCbor).body().auxiliary_data_hash() !== undefined, true);
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [WALLET.keyHash]);
  });
});

describe('buildJuryRegister (real jury validator)', () => {
  test('mints the juror token from the seed and locks the bond with the Juror datum; the prompt is in the metadata', async () => {
    const ctx = await ctxOf();
    const r = await buildJuryRegister(ctx, { changeAddress: WALLET_ADDRESS, agentId: JUROR_ID, prompt: PROMPT, nowMs: NOW });
    assert.equal(r.seed, `${'f1'.repeat(32)}#0`, 'the largest pure AP3X output is the seed');
    assert.equal(r.jurorToken, seedTokenName(TOKEN_PREFIX.juror, { txHash: 'f1'.repeat(32), outputIndex: 0 }));
    const j = jurorAt(r.txCbor, r.jurorOutputIndex);
    assert.deepEqual(j, { agent: JUROR_ID, owner: WALLET.keyHash, promptHash: documentHash(PROMPT), registeredAt: r.validTo, exitAfter: null, open: [] });
    assert.equal(outputsOf(r.txCbor)[r.jurorOutputIndex].lovelace, 250_000_000n);
    assert.equal(r.eligibleFrom, r.validTo + 3 * DAY);
    assert.deepEqual(documentOf(r.txCbor).bytes, PROMPT);
    assert.equal(documentOf(r.txCbor).type, 'juror-prompt');
    assert.deepEqual(r.requiredSigners, [{ keyHash: WALLET.keyHash, roles: ['juror owner', 'wallet (inputs, fee and collateral)'] }]);
  });

  test('refuses a low bond, a subagent, a DID that the wallet key does not control, and a record that is not Active', async () => {
    const ctx = await ctxOf();
    await assert.rejects(buildJuryRegister(ctx, { changeAddress: WALLET_ADDRESS, agentId: JUROR_ID, prompt: PROMPT, bondLovelace: 249_000_000n, nowMs: NOW }), /at least 250\.000000 AP3X/);
    const subagent = await ctxOf([], [recordUtxo(JUROR_ID, agentRecord({ lineage: { type: 'Subagent', parent: JUROR2_ID, parentEpoch: 0, depth: 1 }, endpoint: '' })), recordUtxo(JUROR2_ID)]);
    await assert.rejects(buildJuryRegister(subagent, { changeAddress: WALLET_ADDRESS, agentId: JUROR_ID, prompt: PROMPT, nowMs: NOW }), /is a subagent; the jury takes only independent agents/);
    const foreign = await ctxOf([], [recordUtxo(JUROR_ID, agentRecord({}, STRANGER.publicKey))]);
    await assert.rejects(buildJuryRegister(foreign, { changeAddress: WALLET_ADDRESS, agentId: JUROR_ID, prompt: PROMPT, nowMs: NOW }), /neither the controller/);
    const retired = await ctxOf([], [recordUtxo(JUROR_ID, agentRecord({ keys: [], parties: [], status: { type: 'Retired', at: NOW - DAY, successor: null } }))]);
    await assert.rejects(buildJuryRegister(retired, { changeAddress: WALLET_ADDRESS, agentId: JUROR_ID, prompt: PROMPT, nowMs: NOW }), /is Retired over the validity window/);
  });
});

describe('exit request, exit and top-up (real jury validator)', () => {
  test('an exit request sets exit_after to the end of the window plus the notice and keeps the value', async () => {
    const ctx = await ctxOf([jurorOutput()]);
    const r = await buildJuryRequestExit(ctx, { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, nowMs: NOW });
    assert.equal(jurorAt(r.txCbor, r.jurorOutputIndex!).exitAfter, r.validTo + 3 * DAY);
    assert.equal(outputsOf(r.txCbor)[r.jurorOutputIndex!].lovelace, 300_000_000n);
    await assert.rejects(buildJuryRequestExit(await ctxOf([jurorOutput(jurorDatum({ exitAfter: NOW }))]), { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, nowMs: NOW }), /already asked to exit/);
  });

  test('the exit burns the token after the notice; it refuses an open vote and a running notice', async () => {
    const after = await ctxOf([jurorOutput(jurorDatum({ exitAfter: NOW - HOUR }))]);
    const r = await buildJuryExit(after, { changeAddress: WALLET_ADDRESS, juror: `did:vector:${JUROR_ID}`, nowMs: NOW });
    const mint = CML.Transaction.from_cbor_hex(r.txCbor).body().mint();
    assert.ok(mint, 'the transaction burns the juror token');
    assert.equal(r.jurorOutputIndex, null);
    assert.ok(r.validFrom >= NOW - HOUR);
    const early = await ctxOf([jurorOutput(jurorDatum({ exitAfter: NOW + HOUR }))]);
    await assert.rejects(buildJuryExit(early, { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, nowMs: NOW }), /Too early: the exit notice of the juror ends/);
    const open = await ctxOf([jurorOutput(jurorDatum({ exitAfter: NOW - HOUR, open: [{ case: CASE_TOKEN, revealEnd: NOW + HOUR }] }))]);
    await assert.rejects(buildJuryExit(open, { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, nowMs: NOW }), /1 unrevealed vote/);
    await assert.rejects(buildJuryExit(await ctxOf([jurorOutput()]), { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, nowMs: NOW }), /has not asked to exit/);
  });

  test('a top-up adds lovelace and keeps the datum', async () => {
    const ctx = await ctxOf([jurorOutput()]);
    const r = await buildJuryTopUp(ctx, { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, amountLovelace: 25_000_000n, nowMs: NOW });
    assert.equal(outputsOf(r.txCbor)[r.jurorOutputIndex!].lovelace, 325_000_000n);
    assert.deepEqual(jurorAt(r.txCbor, r.jurorOutputIndex!), jurorDatum());
  });

  test('a juror whose owner is another key lists that key as a signer', async () => {
    const ctx = await ctxOf([jurorOutput(jurorDatum({ owner: STRANGER.keyHash }))]);
    const r = await buildJuryTopUp(ctx, { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, amountLovelace: 1_000_000n, nowMs: NOW });
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [STRANGER.keyHash, WALLET.keyHash]);
  });
});

describe('commit and reveal (real jury validator)', () => {
  const recordHash = documentHash(RECORD);
  const commit = commitHash({ case: CASE_TOKEN, agent: JUROR_ID, vote: 'AuditorWins', salt: SALT, recordHash });
  const vote = { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, case: CASE_TOKEN, vote: 'AuditorWins' as const, salt: SALT, nowMs: NOW };

  test('a commit adds the open vote to the juror and the ballot to the case', async () => {
    const ctx = await ctxOf([jurorOutput(), caseOutput()]);
    const r = await buildJuryCommit(ctx, { ...vote, recordHash });
    assert.equal(r.commit, commit);
    const c = caseDatum();
    assert.deepEqual(jurorAt(r.txCbor, r.jurorOutputIndex).open, [{ case: CASE_TOKEN, revealEnd: c.revealEnd }]);
    assert.deepEqual(caseAt(r.txCbor, r.caseOutputIndex).ballots, [{ agent: JUROR_ID, juror: JUROR_TOKEN, commit, status: { type: 'Committed' } }]);
    assert.equal(outputsOf(r.txCbor)[r.jurorOutputIndex].lovelace, 300_000_000n);
    assert.ok(r.validTo <= c.commitEnd);
  });

  test('a commit adds lovelace when the larger case datum needs it, and keeps lovelace - fee above the ledger minimum', async () => {
    const ctx = await ctxOf([jurorOutput(), caseOutput(caseDatum({ fee: 3_000_000n }), CASE_TOKEN, 4_000_000n)]);
    const r = await buildJuryCommit(ctx, { ...vote, recordHash });
    assert.ok(r.caseLovelace > 4_000_000n, `the case output got ${r.caseLovelace}`);
    assert.equal(outputsOf(r.txCbor)[r.caseOutputIndex].lovelace, r.caseLovelace);
  });

  test('the commit refuses a party, a second ballot of a DID, a juror before its eligibility, after its exit request or below bond_min, and a closed window', async () => {
    const refuse = async (juror: UTxO, kase: UTxO, re: RegExp) => assert.rejects(buildJuryCommit(await ctxOf([juror, kase]), { ...vote, recordHash }), re);
    await refuse(jurorOutput(jurorDatum({ agent: AUDITOR_ID })), caseOutput(), /is a party of the case \(the auditor\)/);
    await refuse(jurorOutput(), caseOutput(caseDatum({ ballots: [{ agent: JUROR_ID, juror: JUROR2_TOKEN, commit, status: { type: 'Committed' } }] })), /already has a ballot/);
    await refuse(jurorOutput(jurorDatum({}, 2 * DAY)), caseOutput(), /Too early: the juror can vote only after the eligibility delay/);
    await refuse(jurorOutput(jurorDatum({ exitAfter: NOW + DAY })), caseOutput(), /asked to exit/);
    await refuse(jurorOutput(jurorDatum(), JUROR_TOKEN, 240_000_000n), caseOutput(), /below bond_min/);
    // SPEC amendment 2: no limit on open commitments, so eleven open votes do not stop a twelfth.
    const eleven = Array.from({ length: 11 }, (_, i) => ({ case: `6361735f${(i + 0x10).toString(16).repeat(28)}`, revealEnd: NOW + HOUR }));
    const r = await buildJuryCommit(await ctxOf([jurorOutput(jurorDatum({ open: eleven })), caseOutput()]), { ...vote, recordHash });
    assert.equal(jurorAt(r.txCbor, r.jurorOutputIndex).open.length, 12);
    await refuse(jurorOutput(), caseOutput(caseDatum({}, 3 * HOUR)), /Too late: the commit window of the case ended/);
    await refuse(jurorOutput(), caseOutput(caseDatum({ state: { type: 'Settling', share: 1n } })), /is Settling/);
  });

  const committed = () => caseDatum({ ballots: [{ agent: JUROR_ID, juror: JUROR_TOKEN, commit, status: { type: 'Committed' } }] }, 3 * HOUR);
  const openJuror = () => jurorDatum({ open: [{ case: CASE_TOKEN, revealEnd: committed().revealEnd }] });

  test('a reveal checks the commitment, marks the ballot Revealed, counts the vote and carries the record', async () => {
    const ctx = await ctxOf([jurorOutput(openJuror()), caseOutput(committed())]);
    const r = await buildJuryReveal(ctx, { ...vote, record: RECORD });
    const c = caseAt(r.txCbor, r.caseOutputIndex);
    assert.deepEqual(c.ballots[0].status, { type: 'Revealed', vote: 'AuditorWins' });
    assert.deepEqual(c.tally, { claimer: 0, auditor: 1, inconclusive: 0 });
    assert.deepEqual(jurorAt(r.txCbor, r.jurorOutputIndex).open, []);
    assert.deepEqual(documentOf(r.txCbor).bytes, RECORD);
    assert.equal(documentOf(r.txCbor).type, 'juror-record');
    assert.ok(r.validFrom >= committed().commitEnd && r.validTo <= committed().revealEnd);
  });

  test('a reveal without the record (overflow, SPEC Section 10.4): a juror-record-ref to the published record, the record hash alone is checked', async () => {
    const ctx = await ctxOf([jurorOutput(openJuror()), caseOutput(committed())]);
    const recordUri = `vector-tx:${Buffer.from('ab'.repeat(32), 'hex').toString('base64url')}`;
    const r = await buildJuryReveal(ctx, { ...vote, recordHash, withRecord: false, recordUri });
    assert.equal(documentOf(r.txCbor).type, 'juror-record-ref');
    assert.equal(Buffer.from(documentOf(r.txCbor).bytes).toString('utf8'), recordUri);
    assert.deepEqual(caseAt(r.txCbor, r.caseOutputIndex).tally, { claimer: 0, auditor: 1, inconclusive: 0 });
    await assert.rejects(buildJuryReveal(ctx, { ...vote, recordHash: '00'.repeat(32), withRecord: false, recordUri }), /do not give the commitment/);
    await assert.rejects(buildJuryReveal(ctx, { ...vote, recordHash, withRecord: false }), /needs record_uri/);
    await assert.rejects(buildJuryReveal(ctx, { ...vote, recordHash, withRecord: false, recordUri: `vector-tx:${'A'.repeat(42)}B` }), /not a canonical vector-tx: URI|does not encode a 32-byte transaction id/);
    await assert.rejects(buildJuryReveal(ctx, { ...vote, recordHash }), /needs the record itself/);
  });

  test('a reveal refuses another vote, salt or record, and a time outside the reveal window', async () => {
    const ctx = await ctxOf([jurorOutput(openJuror()), caseOutput(committed())]);
    await assert.rejects(buildJuryReveal(ctx, { ...vote, vote: 'ClaimerWins', record: RECORD }), /do not give the commitment of the ballot/);
    await assert.rejects(buildJuryReveal(ctx, { ...vote, salt: '00'.repeat(32), record: RECORD }), /do not give the commitment/);
    await assert.rejects(buildJuryReveal(ctx, { ...vote, record: Buffer.from(`${RECORD.toString()} `) }), /do not give the commitment/);
    const early = await ctxOf([jurorOutput(openJuror()), caseOutput(caseDatum({ ballots: committed().ballots }))]);
    await assert.rejects(buildJuryReveal(early, { ...vote, record: RECORD }), /Too early: the reveal window opens/);
    const late = await ctxOf([jurorOutput(openJuror()), caseOutput(caseDatum({ ballots: committed().ballots }, 5 * HOUR))]);
    await assert.rejects(buildJuryReveal(late, { ...vote, record: RECORD }), /Too late: the reveal window of the case ended/);
    const none = await ctxOf([jurorOutput(), caseOutput(caseDatum({}, 3 * HOUR))]);
    await assert.rejects(buildJuryReveal(none, { ...vote, record: RECORD }), /has no ballot in the case/);
  });

  test('a juror and a case can be named by output reference, a case by its challenge', async () => {
    const juror = jurorOutput();
    const kase = caseOutput();
    const ctx = await ctxOf([juror, kase]);
    const r = await buildJuryCommit(ctx, { ...vote, juror: `${juror.txHash}#${juror.outputIndex}`, case: caseDatum().challenge, recordHash });
    assert.equal(r.caseToken, CASE_TOKEN);
    assert.equal(r.jurorToken, JUROR_TOKEN);
    const two = await ctxOf([jurorOutput(), jurorOutput(jurorDatum(), JUROR2_TOKEN), caseOutput()]);
    await assert.rejects(buildJuryCommit(two, { ...vote, juror: `did:vector:${JUROR_ID}`, recordHash }), /has 2 juror outputs/);
  });
});

describe('the jury validator runs on every build', () => {
  test('a registration with registered_at one second before hi fails in the evaluation of the jury script; the right one completes', { skip: JURY_STAND_IN && 'the jury blueprint fixture predates SPEC amendment 2 (case layout): refresh it from the rebuilt contract' }, async () => {
    const ctx = await ctxOf();
    await chainClock(ctx.provider);
    const seed = WALLET_UTXOS[0];
    const unit = `${JURY.hash}${seedTokenName(TOKEN_PREFIX.juror, seed)}`;
    const window = windowAt(NOW);
    const records = (await ctx.provider.getUtxos(IDENTITY_ADDRESS)).filter((u) => u.assets[`${IDENTITY_HASH}${JUROR_ID}`] === 1n);
    const register = (registeredAt: number) => ctx.lucid.newTx()
      .collectFrom([seed])
      .mintAssets({ [unit]: 1n }, encodeJuryMint({ type: 'Register', seed }))
      .pay.ToContract(JURY.address, { kind: 'inline', value: encodeJuryDatum({ type: 'Juror', juror: { ...jurorDatum(), registeredAt } }) }, { lovelace: 250_000_000n, [unit]: 1n })
      .readFrom([JURY_REF_UTXO, ...records])
      .addSignerKey(WALLET.keyHash)
      .validFrom(window.lo)
      .validTo(window.hi)
      .complete();
    await assert.rejects(register(window.hi - 1000));
    assert.ok((await register(window.hi)).toHash());
  });
});
