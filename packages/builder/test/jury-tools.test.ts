// packages/builder/test/jury-tools.test.ts
// Handler-level tests of the Module-1 dispute tools: a minimal fake server captures the handlers, the node is the offline jury world
// (jury-world.ts, real Module-1 and jury scripts), Koios is a fake, and the clock is fixed. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { registerJuryFamily } from '../src/vector/jury-family.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { commitHash, encodeChallengeDatum } from '../src/vector/jury-codec.ts';
import { utf8Hex } from '../src/vector/identity-codec.ts';
import { documentHash, documentMetadata, documentUri } from '../src/vector/jury-document.ts';
import type { JuryConfig } from '../src/vector/jury-deployment.ts';
import {
  AUDITOR_ID, CASE_TOKEN, CHALLENGE_TOKEN, CLAIMER_ID, CLAIM_TOKEN, CONFIG, DAY, HOUR, JURY, JUROR2_ID, JUROR2_TOKEN, JUROR_ID, JUROR_TOKEN, NOW, WALLET,
  WALLET_ADDRESS, caseDatum, caseOutput, claimUtxo, jurorDatum, jurorOutput, juryWorld,
} from './fixtures/jury-world.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const serverOf = (into: Map<string, Handler>) => ({ tool: (name: string, _d: string, _s: unknown, handler: Handler) => { into.set(name, handler); } }) as unknown as McpServer;
const jsonOf = (answer: string): Record<string, unknown> => JSON.parse(answer.slice(answer.lastIndexOf('```json\n') + 8, answer.lastIndexOf('\n```')));

interface KoiosState {
  documents?: Map<string, unknown>;
  /** Inline datums (hex) by output reference, for Koios utxo_info. */
  utxos?: Map<string, string>;
  /** The rows of the indexer's GET /jury/cases; without them the indexer answers 404. */
  indexerCases?: unknown[];
  down?: boolean;
}

/** A fake Koios (tx_metadata, utxo_info) and a fake marketplace indexer (GET /jury/cases). */
function koios(state: KoiosState): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (state.down) return new Response('down', { status: 503 });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/v1/tx_metadata') return json(body._tx_hashes.filter((h: string) => state.documents?.has(h)).map((h: string) => ({ tx_hash: h, metadata: { 22084: state.documents!.get(h) } })));
    if (u.pathname === '/api/v1/utxo_info') {
      return json(body._utxo_refs.filter((r: string) => state.utxos?.has(r)).map((r: string) => ({ tx_hash: r.slice(0, 64), tx_index: Number(r.slice(65)), inline_datum: { bytes: state.utxos!.get(r) } })));
    }
    if (u.host === 'indexer.test' && u.pathname === '/jury/cases' && state.indexerCases) return json({ cases: state.indexerCases });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function tools(opts: { extra?: UTxO[]; config?: JuryConfig; koios?: KoiosState } = {}) {
  const handlers = new Map<string, Handler>();
  registerJuryFamily(serverOf(handlers), 'jury-tools-test', () => juryWorld(opts.extra ?? []), new RateLimiter(100_000), async () => opts.config ?? CONFIG,
    { koiosUrl: 'https://koios.test', indexerUrl: 'https://indexer.test', fetchImpl: koios(opts.koios ?? {}), now: () => NOW });
  return async (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name);
    assert.ok(handler, `tool ${name} is registered`);
    return (await handler(args)).content[0].text;
  };
}

/** The label 22084 metadata of a built transaction, as Koios shows it. */
function metadataOf(txCbor: string): unknown {
  const metadatum = CML.Transaction.from_cbor_hex(txCbor).auxiliary_data()!.metadata()!.get(22084n)!;
  return JSON.parse(CML.decode_metadatum_to_json_str(metadatum, CML.MetadataJsonSchema.BasicConversions));
}

const txCborOf = (answer: string): string => /\*\*Unsigned TX CBOR:\*\*\n```\n([0-9a-f]+)\n```/.exec(answer)![1];

describe('without manifests', () => {
  const call = tools({ config: { module1: null, juries: [] } });

  test('the juror and read tools say to set VECTOR_JURY_MANIFESTS, the claim tool VECTOR_MODULE1_MANIFEST', async () => {
    assert.match(await call('vector_build_jury_register', { changeAddress: WALLET_ADDRESS, agent: JUROR_ID, prompt_text: '{}' }), /^Failed to build juror registration: The Module-1 jury is not configured on this server: set VECTOR_JURY_MANIFESTS/);
    assert.match(await call('vector_get_jury', {}), /set VECTOR_JURY_MANIFESTS/);
    assert.match(await call('vector_get_jury_cases', {}), /set VECTOR_JURY_MANIFESTS/);
    assert.match(await call('vector_build_jury_commit', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, case: CASE_TOKEN, vote: 'ClaimerWins', record_hash: 'ab'.repeat(32) }), /set VECTOR_JURY_MANIFESTS/);
    assert.match(await call('vector_build_module1_claim', { changeAddress: WALLET_ADDRESS, agent: CLAIMER_ID, claim_uri: 'https://x.example/c.json', claim_hash: 'ab'.repeat(32), claim_type: 'x', stake: 50 }), /Module-1 is not configured on this server: set VECTOR_MODULE1_MANIFEST/);
  });

  test('the document tools need no manifest', async () => {
    const answer = await call('vector_build_document_publish', { changeAddress: WALLET_ADDRESS, text: '{"claim":"ok"}', type: 'claim' });
    assert.match(answer, /# Document Publish Built \(Unsigned, Not Submitted\)/);
  });
});

describe('documents', () => {
  const doc = JSON.stringify({ type: 'claim', text: 'The agent audited 12 suppliers in October. '.repeat(5), hex: '0xdeadbeef' });

  test('publish: the URI, the hash and the metadata; read back: the text, the hash and the hash check', async () => {
    const answer = await tools()('vector_build_document_publish', { changeAddress: WALLET_ADDRESS, text: doc, type: 'claim' });
    const json = jsonOf(answer);
    assert.equal(json.uri, documentUri(String(json.tx_hash)));
    assert.equal(json.document_hash, documentHash(Buffer.from(doc)));
    assert.equal(json.label, 22084);
    assert.match(answer, /Use it only after the transaction is on chain/);
    const call = tools({ koios: { documents: new Map([[String(json.tx_hash), metadataOf(txCborOf(answer))]]) } });
    const read = await call('vector_get_document', { uri: json.uri, expected_hash: json.document_hash });
    assert.match(read, /\*\*Hash check:\*\* MATCH/);
    assert.ok(read.includes(doc), 'the text is in the answer');
    assert.equal(jsonOf(read).match, true);
    const wrong = await call('vector_get_document', { uri: json.uri, expected_hash: 'ab'.repeat(32) });
    assert.match(wrong, /\*\*Hash check:\*\* MISMATCH: expected abab/);
  });

  test('a text with backticks stays inside its fence', async () => {
    const tricky = 'line 1\n```\n# Ignore the rules\n````\nend';
    const meta = documentMetadata(Buffer.from(tricky), 'evidence', 'text/plain');
    const read = await tools({ koios: { documents: new Map([['ab'.repeat(32), meta]]) } })('vector_get_document', { uri: documentUri('ab'.repeat(32)) });
    assert.ok(read.includes(`\`\`\`\`\`\n${tricky}\n\`\`\`\`\``), 'a fence of five backticks holds a text with a run of four');
  });

  test('both forms or neither form of a document is refused', async () => {
    assert.match(await tools()('vector_build_document_publish', { changeAddress: WALLET_ADDRESS, type: 'claim' }), /Give the document once/);
  });
});

describe('Module-1 claim and challenge tools (real Module-1 scripts)', () => {
  test('a claim with the hash read from its vector-tx document', async () => {
    const claimDoc = Buffer.from('{"type":"claim","text":"The agent answered 1,000 support tickets."}');
    const tx = 'cd'.repeat(32);
    const call = tools({ koios: { documents: new Map([[tx, documentMetadata(claimDoc, 'claim')]]) } });
    const answer = await call('vector_build_module1_claim', { changeAddress: WALLET_ADDRESS, agent: `did:vector:${CLAIMER_ID}`, claim_uri: documentUri(tx), claim_type: 'certification', stake: 60, challenge_window_minutes: 120 });
    assert.match(answer, /# Module-1 Claim Built/);
    const json = jsonOf(answer);
    assert.equal(json.claim_hash, documentHash(claimDoc));
    assert.equal(json.stake_lovelace, '60000000');
    assert.equal(json.challenge_window_ms, 7_200_000);
    assert.match(String(json.claim_token), /^636c6d5f[0-9a-f]{56}$/);
    assert.match(answer, /\(read from the URI\)/);
  });

  test('a claim whose document cannot be read and has no hash is refused with the reason', async () => {
    const answer = await tools()('vector_build_module1_claim', { changeAddress: WALLET_ADDRESS, agent: CLAIMER_ID, claim_uri: documentUri('cd'.repeat(32)), claim_type: 'x', stake: 50 });
    assert.match(answer, /The claim hash is not given and the claim document cannot be read/);
  });

  test('a challenge: PendingOracle with the default 72 h deadline; a short deadline warns that the jury cannot decide', async () => {
    const call = tools({ extra: [claimUtxo(CLAIM_TOKEN)] });
    const args = { changeAddress: WALLET_ADDRESS, agent: AUDITOR_ID, claim: CLAIM_TOKEN, evidence_uri: 'https://example.org/e.json', evidence_hash: 'ed'.repeat(32), stake: 50 };
    const answer = await call('vector_build_module1_challenge', args);
    const json = jsonOf(answer);
    assert.equal(json.resolution_deadline_ms, 72 * HOUR);
    assert.equal(json.jury_time_warning, false);
    assert.match(answer, /state PendingOracle/);
    const short = await call('vector_build_module1_challenge', { ...args, resolution_deadline_hours: 5 });
    assert.match(short, /WARNING: the resolution deadline is shorter than 6 h 10 min/);
    assert.equal(jsonOf(short).jury_time_warning, true);
    assert.match(await call('vector_build_module1_challenge', { ...args, claim: 'not-a-claim' }), /Name the claim by its claim token name/);
  });
});

describe('juror tools (real jury script)', () => {
  test('register: the juror token, the prompt hash and the owner', async () => {
    const prompt = JSON.stringify({ type: 'vector-jury-prompt/1', juror: `did:vector:${JUROR_ID}`, max_output_tokens: 4000 });
    const answer = await tools()('vector_build_jury_register', { changeAddress: WALLET_ADDRESS, agent: JUROR_ID, prompt_text: prompt });
    const json = jsonOf(answer);
    assert.match(String(json.juror_token), /^6a72725f[0-9a-f]{56}$/);
    assert.equal(json.prompt_hash, documentHash(Buffer.from(prompt)));
    assert.equal(json.owner, WALLET.keyHash);
    assert.equal(json.bond_lovelace, '250000000');
    assert.equal(json.jury, JURY.hash);
  });

  test('exit request and top-up', async () => {
    const call = tools({ extra: [jurorOutput()] });
    const request = jsonOf(await call('vector_build_jury_exit', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, step: 'request' }));
    assert.ok(Number(request.exit_after) > NOW + 3 * DAY - HOUR);
    assert.match(await call('vector_build_jury_exit', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, step: 'exit' }), /has not asked to exit/);
    const topup = jsonOf(await call('vector_build_jury_topup', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, amount: 10 }));
    assert.equal(topup.juror_lovelace, '310000000');
  });

  test('commit without a salt: the tool makes one, returns it and says to keep it; the commitment is SPEC Section 7', async () => {
    const call = tools({ extra: [jurorOutput(), caseOutput()] });
    const record = JSON.stringify({ type: 'vector-jury-record/1', vote: 'ClaimerWins', reason: 'The claim holds.' });
    const answer = await call('vector_build_jury_commit', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, case: CASE_TOKEN, vote: 'ClaimerWins', record_text: record });
    const json = jsonOf(answer);
    assert.match(String(json.salt), /^[0-9a-f]{64}$/);
    assert.equal(json.salt_generated, true);
    assert.match(answer, new RegExp(`KEEP THE SALT ${json.salt}`));
    const recordHash = documentHash(Buffer.from(record));
    assert.equal(json.record_hash, recordHash);
    assert.equal(json.commit, commitHash({ case: CASE_TOKEN, agent: JUROR_ID, vote: 'ClaimerWins', salt: String(json.salt), recordHash }));
    assert.match(await call('vector_build_jury_commit', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, case: CASE_TOKEN, vote: 'ClaimerWins' }), /Give the juror record/);
    assert.match(await call('vector_build_jury_commit', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, case: CASE_TOKEN, vote: 'ClaimerWins', record_text: record, record_hash: 'ab'.repeat(32) }), /is not the hash of the record/);
  });

  test('reveal: the commitment matches, the tally grows, the record is in the metadata', async () => {
    const record = JSON.stringify({ type: 'vector-jury-record/1', vote: 'Inconclusive' });
    const salt = '42'.repeat(32);
    const commit = commitHash({ case: CASE_TOKEN, agent: JUROR_ID, vote: 'Inconclusive', salt, recordHash: documentHash(Buffer.from(record)) });
    const kase = caseDatum({ ballots: [{ agent: JUROR_ID, juror: JUROR_TOKEN, commit, status: { type: 'Committed' } }] }, 3 * HOUR);
    const call = tools({ extra: [jurorOutput(jurorDatum({ open: [{ case: CASE_TOKEN, revealEnd: kase.revealEnd }] })), caseOutput(kase)] });
    const answer = await call('vector_build_jury_reveal', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, case: CASE_TOKEN, vote: 'Inconclusive', salt, record_text: record });
    const json = jsonOf(answer);
    assert.deepEqual(json.tally, { claimer: 0, auditor: 0, inconclusive: 1 });
    assert.equal(json.commit, commit);
    assert.match(answer, /the commitment [0-9a-f]{64} matches/);
    const wrong = await call('vector_build_jury_reveal', { changeAddress: WALLET_ADDRESS, juror: JUROR_TOKEN, case: CASE_TOKEN, vote: 'ClaimerWins', salt, record_text: record });
    assert.match(wrong, /do not give the commitment of the ballot/);
  });
});

describe('reads', () => {
  test('vector_get_jury: the parameters and each juror with when it can vote', async () => {
    const call = tools({ extra: [jurorOutput(), jurorOutput(jurorDatum({ agent: JUROR2_ID }, DAY), JUROR2_TOKEN), caseOutput()] });
    const answer = await call('vector_get_jury', {});
    const [deployment] = jsonOf(answer) as unknown as Array<Record<string, unknown>>;
    assert.equal(deployment.jury, JURY.hash);
    assert.equal(deployment.live_cases, 1);
    const jurors = deployment.jurors as Array<Record<string, unknown>>;
    assert.equal(jurors.find((j) => j.juror_token === JUROR_TOKEN)!.can_vote_now, true);
    const fresh = jurors.find((j) => j.juror_token === JUROR2_TOKEN)!;
    assert.equal(fresh.can_vote_now, false);
    assert.equal(fresh.eligible_from, NOW - DAY + 3 * DAY);
    assert.match(answer, /\| juror token \| DID \| bond \| can vote now \| exit \| open votes \|/);
    const filtered = jsonOf(await call('vector_get_jury', { agent: JUROR2_ID })) as unknown as Array<{ jurors: unknown[] }>;
    assert.equal(filtered[0].jurors.length, 1);
  });

  const CASE2 = `6361735f${'e2'.repeat(28)}`;
  const CASE3 = `6361735f${'e3'.repeat(28)}`;
  const OTHER_CHALLENGE = `63686c5f${'1e'.repeat(28)}`;
  const OTHER_CLAIM = `636c6d5f${'1f'.repeat(28)}`;
  const evidence = encodeChallengeDatum({
    claimRef: { txHash: 'cc'.repeat(32), outputIndex: 0 }, auditorDid: AUDITOR_ID, auditorCredential: { type: 'VerificationKey', hash: WALLET.keyHash },
    stakeAmount: 50_000_000n, evidenceHash: '0d'.repeat(32), evidenceUri: utf8Hex('https://example.org/evidence.json'), challengedAt: NOW - HOUR,
    resolutionDeadline: 72 * HOUR, eligibleJurors: [], state: { type: 'PendingOracle' }, claimToken: CLAIM_TOKEN,
  });

  /** Live: CASE_TOKEN and CASE2 of the dispute CLAIM_TOKEN, and CASE3 of OTHER_CLAIM with a ballot of JUROR_ID. */
  const world = () => [caseOutput(caseDatum(), CASE_TOKEN), caseOutput(caseDatum(), CASE2), caseOutput(caseDatum({ claim: OTHER_CLAIM, challenge: OTHER_CHALLENGE, ballots: [{ agent: JUROR_ID, juror: JUROR_TOKEN, commit: 'cc'.repeat(32), status: { type: 'Committed' } }] }), CASE3)];
  /** The indexer knows CASE_TOKEN and CASE2 (CASE2 is canonical); Koios has the claim and challenge outputs that the cases name. */
  const chain: KoiosState = {
    indexerCases: [{ case: CASE2, canonical: true, claim: CLAIM_TOKEN }, { case: CASE_TOKEN, canonical: false, claim: CLAIM_TOKEN }],
    utxos: new Map([[`${'cc'.repeat(32)}#1`, claimUtxo(CLAIM_TOKEN, { state: 'Challenged' }).datum!], [`${'ce'.repeat(32)}#0`, evidence]]),
  };

  test('vector_get_jury_cases: the canonical flag of the indexer and the document URIs of the claim and challenge outputs', async () => {
    const answer = await tools({ extra: world(), koios: chain })('vector_get_jury_cases', {});
    const cases = jsonOf(answer) as unknown as Array<Record<string, unknown>>;
    const byToken = new Map(cases.map((c) => [c.case_token, c]));
    assert.equal(byToken.get(CASE2)!.canonical, true);
    assert.equal(byToken.get(CASE_TOKEN)!.canonical, false);
    assert.equal(byToken.get(CASE3)!.canonical, null);
    assert.match(String(byToken.get(CASE3)!.canonical_note), /does not know this case yet/);
    assert.equal(byToken.get(CASE_TOKEN)!.claim_uri, 'vector-tx:cu8SkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(byToken.get(CASE_TOKEN)!.evidence_uri, 'https://example.org/evidence.json');
    assert.equal(byToken.get(CASE_TOKEN)!.claim_out, `${'cc'.repeat(32)}#1`);
    assert.equal(byToken.get(CASE_TOKEN)!.phase, 'commit');
    assert.equal(byToken.get(CASE_TOKEN)!.outcome, 'Inconclusive');
    assert.match(answer, /# Module-1 Jury Cases \(3\)/);
  });

  test('filters by claim, challenge and agent; without the indexer route the flag is unknown; without Koios the URIs are unknown', async () => {
    const call = tools({ extra: world(), koios: chain });
    const ids = async (args: Record<string, unknown>) => (jsonOf(await call('vector_get_jury_cases', args)) as unknown as Array<Record<string, unknown>>).map((c) => c.case_token);
    assert.deepEqual(await ids({ claim: OTHER_CLAIM }), [CASE3]);
    assert.deepEqual(await ids({ challenge: OTHER_CHALLENGE }), [CASE3]);
    assert.deepEqual(await ids({ agent: JUROR_ID }), [CASE3]);
    assert.equal((await ids({ agent: `did:vector:${CLAIMER_ID}` })).length, 3);
    const noRoute = jsonOf(await tools({ extra: world(), koios: { utxos: chain.utxos } })('vector_get_jury_cases', { claim: CLAIM_TOKEN })) as unknown as Array<Record<string, unknown>>;
    assert.equal(noRoute[0].canonical, null);
    assert.match(String(noRoute[0].canonical_note), /has no \/jury\/cases route yet/);
    const down = await tools({ extra: world(), koios: { down: true } })('vector_get_jury_cases', { challenge: CHALLENGE_TOKEN });
    assert.match(down, /could not be read/);
    assert.equal((jsonOf(down) as unknown as Array<Record<string, unknown>>)[0].claim_uri, null);
    assert.match(await tools({ koios: chain })('vector_get_jury_cases', {}), /No live case/);
  });
});
