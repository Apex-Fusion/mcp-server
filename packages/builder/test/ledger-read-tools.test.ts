// packages/builder/test/ledger-read-tools.test.ts
// Handler-level tests of the six read and check tools of attestations, delegations and vaults: registerIdentityFamily with a minimal fake
// server that validates the arguments with each tool's zod schema (as the MCP server does) and calls the handler. The node is the offline
// world of fixtures/ledger-read-world.ts and Koios is its fake, loaded with the outputs that mainnet holds (capture-ledger-read.mjs). The
// clock is fixed at the time of the capture. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import type { UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIdentityFamily } from '../src/vector/identity-family.ts';
import { IdentityConfigError } from '../src/vector/identity-deployment.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { HIRE_ACTION, escrowResource } from '../src/vector/delegation-build.ts';
import { decodeAttestationDatum, decodeDelegationDatum, utf8Hex } from '../src/vector/identity-codec.ts';
import { testKey } from './fixtures/identity-world.ts';
import {
  CAPTURE, CAPTURE_MS, DAY, MAINNET, attestation, attestationIdOf, attestationUtxo, callsTo, capturedUtxos, delegation, delegationUtxo, delegationWithPeriod, koiosRow, ledgerKoios, liveRecord, recordUtxo, revokedWithReason, utxoOf, vaultUtxo,
} from './fixtures/ledger-read-world.ts';
import type { Row } from './fixtures/ledger-read-world.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
type Tool = { shape: z.ZodRawShape; handler: Handler; description: string };
const serverOf = (into: Map<string, Tool>) => ({
  tool: (name: string, description: string, shape: z.ZodRawShape, handler: Handler) => { into.set(name, { shape, handler, description }); },
}) as unknown as McpServer;

const TOOLS = ['vector_get_attestation', 'vector_list_attestations', 'vector_check_attestation', 'vector_get_delegation', 'vector_check_delegation_use', 'vector_get_vault'] as const;

interface World { utxos: UTxO[]; extraRows?: Row[]; utxoInfo?: Row[]; tip?: number | null; limiter?: RateLimiter; deployment?: () => typeof MAINNET }

/** The tools on a node that holds `w.utxos` and a Koios that lists them, with the clock at the capture. */
function tools(w: World) {
  const registered = new Map<string, Tool>();
  const koios = ledgerKoios({ rows: [...w.utxos.map((u) => koiosRow(u)), ...(w.extraRows ?? [])], utxoInfo: w.utxoInfo, tip: w.tip });
  registerIdentityFamily(serverOf(registered), 'ledger-read-tools-test', () => new FixtureProvider(w.utxos), w.limiter ?? new RateLimiter(100_000), w.deployment ?? (() => MAINNET), { access: { koiosUrl: 'https://koios.example', fetchImpl: koios.f, now: () => CAPTURE_MS } });
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = registered.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const parsed = z.object(tool.shape).safeParse(args);
    if (!parsed.success) return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    return (await tool.handler(parsed.data as Record<string, unknown>)).content[0].text;
  };
  return { call, registered, koios };
}
/** The JSON block of a tool answer. */
const jsonOf = (answer: string): Record<string, unknown> => JSON.parse(answer.slice(answer.lastIndexOf('```json\n') + 8, answer.lastIndexOf('\n```')));

const ATTESTATIONS = CAPTURE.attestations.map((row) => ({ id: attestationIdOf(row), row, datum: decodeAttestationDatum(row.inline_datum!.bytes) }));
const ENVIRONMENT = ATTESTATIONS.filter((a) => a.datum.attType === 3)[0];
const REVOKED = ATTESTATIONS.find((a) => a.datum.status.type === 'AttRevoked')!;
const issuers = ATTESTATIONS.flatMap((a) => (a.datum.issuerId === null ? [] : [a.datum.issuerId]));
/** The outputs of mainnet, a record for each registered issuer, and a record of the delegate of the live delegation (Active, with no key that its key hash could belong to). */
const mainnet = (): UTxO[] => [...capturedUtxos(), ...[...new Set(issuers)].map((id) => recordUtxo(id, liveRecord())), recordUtxo(decodeDelegationDatum(CAPTURE.delegations.live.mint_output.inline_datum!.bytes).delegate, liveRecord())];
const LIVE = CAPTURE.delegations.live;
const LIVE_DATUM = decodeDelegationDatum(LIVE.mint_output.inline_datum!.bytes);
const ESCROW = escrowResource(MAINNET.escrow.hash);
const iso = (ms: number): string => new Date(ms).toISOString();
/** The characters that a cleaned text must not hold: C1 controls, the soft hyphen, zero-width characters, direction marks, the word joiner, embedding, override and isolate controls, the byte order mark, variation selectors and tag characters. */
const INVISIBLE = /[\u0080-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

describe('registration', () => {
  test('the identity family registers the six read tools beside the build tools, each with a description that says it is read-only', () => {
    const { registered } = tools({ utxos: [] });
    for (const name of TOOLS) {
      assert.ok(registered.has(name), name);
    }
    assert.equal([...registered.keys()].filter((n) => !n.startsWith('vector_build_')).length, TOOLS.length);
  });
});

describe('vector_get_attestation', () => {
  const { call } = tools({ utxos: mainnet() });
  test('an environment attestation of mainnet: its fields, its status, its output and its deposit', async () => {
    const answer = await call('vector_get_attestation', { attestation: ENVIRONMENT.id });
    assert.match(answer, new RegExp(`^# Attestation ${ENVIRONMENT.id}\\n`));
    assert.match(answer, /\*\*Status:\*\* active at 2026-11-18T/);
    assert.match(answer, /\*\*Type:\*\* environment \(3\)/);
    assert.match(answer, new RegExp(`\\*\\*Subject:\\*\\* did:vector:${ENVIRONMENT.datum.subject}`));
    assert.match(answer, new RegExp(`\\*\\*Issuer:\\*\\* did:vector:${ENVIRONMENT.datum.issuerId}, key`));
    assert.match(answer, /\*\*Deposit withdrawable from:\*\* 2027-03-16T/);
    const json = jsonOf(answer);
    assert.equal(json.found, true);
    assert.equal(json.attestation, ENVIRONMENT.id);
    assert.equal(json.output_ref, `${ENVIRONMENT.row.tx_hash}#${ENVIRONMENT.row.tx_index}`);
    assert.equal(json.lovelace, '5000000');
    assert.equal(json.att_type, 'environment');
    assert.equal(json.att_type_code, 3);
    assert.equal(json.subject_did, `did:vector:${ENVIRONMENT.datum.subject}`);
    assert.equal(json.issuer_did, `did:vector:${ENVIRONMENT.datum.issuerId}`);
    assert.equal(json.digest, ENVIRONMENT.datum.digest);
    assert.equal(json.valid_until, ENVIRONMENT.datum.validUntil);
    assert.equal(json.status, 'active');
    assert.equal(json.state, 'active');
    assert.equal(json.at, CAPTURE_MS);
    assert.equal(json.withdrawable_from, ENVIRONMENT.datum.validUntil! + 90 * DAY);
  });
  test('the revoked attestation: the time and the reason of the revocation', async () => {
    const answer = await call('vector_get_attestation', { attestation: REVOKED.id });
    const status = REVOKED.datum.status as { at: number; reason: number };
    assert.match(answer, new RegExp(`\\*\\*Status:\\*\\* revoked at ${iso(status.at).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} with reason ${status.reason}`));
    const json = jsonOf(answer);
    assert.deepEqual([json.status, json.state, json.revoked_at, json.revoke_reason, json.att_type], ['revoked', 'revoked', status.at, status.reason, 'identity']);
  });
  test('an attestation that is not there is not found, in the text and in the JSON', async () => {
    const answer = await call('vector_get_attestation', { attestation: 'ee'.repeat(32) });
    assert.match(answer, /^# Attestation Not Found/);
    assert.match(answer, /does not exist, it was withdrawn, or it is not confirmed yet/);
    assert.deepEqual(jsonOf(answer), { attestation: 'ee'.repeat(32), found: false });
  });
  test('a text that comes from the chain is cleaned in the markdown and in the JSON, and verbatim in the hex fields; contest reply and links are shown', async () => {
    const id = 'f4'.repeat(32);
    const locator = 'https://x.example/a|b`c\nd';
    const reply = 'https://reply.example/r|1';
    const datum = attestation({ locator: utf8Hex(locator), contested: { uri: utf8Hex(reply), sha256: 'ab'.repeat(32) }, links: [{ rel: 0, target: 'cd'.repeat(32) }], format: 50, profile: 'ef'.repeat(32), validFrom: CAPTURE_MS - DAY, validUntil: CAPTURE_MS + DAY });
    const answer = await tools({ utxos: [attestationUtxo(id, datum)] }).call('vector_get_attestation', { attestation: id });
    assert.match(answer, /\*\*Locator:\*\* https:\/\/x\.example\/a¦b'c d\n/);
    assert.match(answer, /the subject replied: https:\/\/reply\.example\/r¦1 \(SHA-256 `(ab){32}`\)/);
    assert.match(answer, /\*\*Links:\*\* supersedes `cdcd/);
    assert.match(answer, /\*\*Format:\*\* CoAP Content-Format 50/);
    const json = jsonOf(answer);
    assert.equal(json.locator, "https://x.example/a¦b'c d");
    assert.equal(json.locator_hex, utf8Hex(locator));
    assert.deepEqual(json.contested, { uri: 'https://reply.example/r¦1', uri_hex: utf8Hex(reply), sha256: 'ab'.repeat(32) });
    assert.deepEqual(json.links, [{ rel: 'supersedes', rel_code: 0, target: 'cd'.repeat(32) }]);
    assert.equal(json.issuer_did, null);
    assert.equal(json.issuer_key_hash, testKey(21).keyHash);
  });
  test('invisible characters and direction marks in the text of the chain are removed from the markdown and from the JSON text, and kept in the hex', async () => {
    const id = 'f9'.repeat(32);
    const hostile = 'https://x.example/\u202Eevil\u200B/\u0085next\u2066z\u2069\ufeff\u00ad\u2060\u061c\u180e\ufe0f\u{e0069}\u{e0100}';
    assert.match(hostile, INVISIBLE, 'the text holds them');
    const answer = await tools({ utxos: [attestationUtxo(id, attestation({ locator: utf8Hex(hostile), contested: { uri: utf8Hex(hostile), sha256: 'ab'.repeat(32) } }))] }).call('vector_get_attestation', { attestation: id });
    assert.doesNotMatch(answer, INVISIBLE, 'neither the markdown nor the JSON text holds one');
    const json = jsonOf(answer);
    assert.equal(json.locator, 'https://x.example/evil/ nextz');
    assert.deepEqual([json.locator_hex, (json.contested as { uri_hex: string }).uri_hex], [utf8Hex(hostile), utf8Hex(hostile)]);
  });
  test('the valid range says that the attestation did not exist more than an hour before issued_at', async () => {
    const answer = await call('vector_get_attestation', { attestation: ENVIRONMENT.id });
    assert.match(answer, new RegExp(`\\*\\*Valid:\\*\\* .* to ${iso(ENVIRONMENT.datum.validUntil!).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}; never before ${iso(ENVIRONMENT.datum.issuedAt - 3_600_000).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}, one hour before issued_at \\(the attestation did not exist earlier\\)`));
  });
  test('the status says why an attestation is not active yet: more than an hour before issued_at, or before valid_from; the list says "not yet valid"', async () => {
    const id = 'f3'.repeat(32);
    const issuedLater = attestationUtxo(id, attestation({ issuedAt: CAPTURE_MS + 2 * 3_600_000 }));
    const early = await tools({ utxos: [issuedLater] }).call('vector_get_attestation', { attestation: id });
    assert.match(early, /\*\*Status:\*\* active, but more than one hour before issued_at at 2026-11-1\d[0-9:.TZ-]*, so it did not exist yet\n/);
    assert.equal(jsonOf(early).state, 'not_yet_valid');
    const waiting = attestationUtxo(id, attestation({ validFrom: CAPTURE_MS + DAY, validUntil: CAPTURE_MS + 2 * DAY }));
    const later = await tools({ utxos: [waiting] }).call('vector_get_attestation', { attestation: id });
    assert.match(later, /\*\*Status:\*\* active, but before valid_from at 2026-11-1\d[0-9:.TZ-]*\n/);
    assert.doesNotMatch(later, /did not exist yet\n\*\*Output/);
    assert.equal(jsonOf(later).state, 'not_yet_valid');
    assert.match(await tools({ utxos: [issuedLater] }).call('vector_list_attestations', { subject: attestation().subject }), /: other \(15\), not yet valid\n/);
    const now = await tools({ utxos: [attestationUtxo(id, attestation())] }).call('vector_get_attestation', { attestation: id });
    assert.match(now, /\*\*Status:\*\* active at 2026-11-1\d[0-9:.TZ-]*\n/, 'the twin: an attestation that is in its range');
  });
  test('a revoked attestation whose reason is above 2^53 is shown, with its exact reason in the text and in the JSON', async () => {
    const id = 'f7'.repeat(32);
    const answer = await tools({ utxos: [attestationUtxo(id, attestation(), { datum: revokedWithReason(2n ** 60n) })] }).call('vector_get_attestation', { attestation: id });
    assert.match(answer, /\*\*Status:\*\* revoked at 2026-11-1\d.* with reason 1152921504606846976\n/);
    const json = jsonOf(answer);
    assert.deepEqual([json.status, json.state, json.revoke_reason], ['revoked', 'revoked', '1152921504606846976']);
    const small = jsonOf(await tools({ utxos: [attestationUtxo(id, attestation({ status: { type: 'AttRevoked', at: CAPTURE_MS - DAY, reason: 7 } }))] }).call('vector_get_attestation', { attestation: id }));
    assert.equal(small.revoke_reason, 7, 'a reason that a number holds is a number');
  });
  test('the identifier must be 64 hex characters', async () => {
    assert.match(await call('vector_get_attestation', { attestation: 'abc' }), /^Invalid arguments: attestation: expected 64 hex characters/);
  });
});

describe('vector_list_attestations', () => {
  const { call } = tools({ utxos: mainnet() });
  const subject = ENVIRONMENT.datum.subject;
  test('by subject: the three attestations of one agent, newest first, with the state of each now', async () => {
    const answer = await call('vector_list_attestations', { subject: `did:vector:${subject}` });
    assert.match(answer, /^# Attestations \(1 to 3 of 3\)/);
    const json = jsonOf(answer);
    assert.deepEqual([json.total, json.offset, json.limit, json.next_offset, json.at], [3, 0, 20, null, CAPTURE_MS]);
    const rows = json.attestations as Array<Record<string, unknown>>;
    const expected = ATTESTATIONS.filter((a) => a.datum.subject === subject).sort((a, b) => b.datum.issuedAt - a.datum.issuedAt).map((a) => a.id);
    assert.deepEqual(rows.map((r) => r.attestation), expected);
    assert.ok(rows.every((r) => r.state === 'active'));
    assert.match(answer, new RegExp(`1\\. \`${expected[0]}\`: environment \\(3\\), active`));
    assert.match(answer, /Matching: subject did:vector:[0-9a-f]{64}\. Newest first\. The rows are as Koios lists them: vector_get_attestation and vector_check_attestation confirm one attestation on the node\./);
  });
  test('by issuer as a key hash, a public key or a DID, and by type', async () => {
    const key = ENVIRONMENT.datum.issuer;
    const keyHash = jsonOf(await call('vector_get_attestation', { attestation: ENVIRONMENT.id })).issuer_key_hash as string;
    const byHash = jsonOf(await call('vector_list_attestations', { issuer: keyHash }));
    const byKey = jsonOf(await call('vector_list_attestations', { issuer: key.toUpperCase() }));
    const byDid = jsonOf(await call('vector_list_attestations', { issuer: `did:vector:${ENVIRONMENT.datum.issuerId}` }));
    assert.deepEqual(byKey.attestations, byHash.attestations);
    assert.deepEqual(byDid.attestations, byHash.attestations);
    assert.ok((byHash.total as number) >= 2);
    const typed = jsonOf(await call('vector_list_attestations', { issuer: keyHash, att_type: 'environment' }));
    assert.deepEqual((typed.attestations as Array<Record<string, unknown>>).map((r) => r.att_type), ['environment', 'environment']);
  });
  test('a page: the limit and the offset, and where the next one starts', async () => {
    const keyHash = jsonOf(await call('vector_get_attestation', { attestation: ATTESTATIONS.find((a) => a.datum.issuerId === null)!.id })).issuer_key_hash as string;
    const first = await call('vector_list_attestations', { issuer: keyHash, limit: 2 });
    assert.match(first, /More rows follow: call again with offset 2\./);
    const j1 = jsonOf(first);
    assert.deepEqual([j1.offset, j1.limit, j1.next_offset], [0, 2, 2]);
    const second = jsonOf(await call('vector_list_attestations', { issuer: keyHash, limit: 2, offset: 2 }));
    assert.equal(second.offset, 2);
    const ids = [...(j1.attestations as Array<{ attestation: string }>), ...(second.attestations as Array<{ attestation: string }>)].map((r) => r.attestation);
    assert.equal(new Set(ids).size, 4, 'the pages share no row');
  });
  test('no attestation matches: said so, with the JSON still there', async () => {
    const answer = await call('vector_list_attestations', { subject: 'ee'.repeat(32) });
    assert.match(answer, /^# Attestations\n\nNo attestation matches \(subject did:vector:e{64}\)\./);
    assert.equal(jsonOf(answer).total, 0);
  });
  test('an offset past the end says so and gives the total', async () => {
    const answer = await call('vector_list_attestations', { subject, offset: 5 });
    assert.match(answer, /^# Attestations\n\nNo rows at offset 5: 3 in total \(subject did:vector:[0-9a-f]{64}\)\./);
    const json = jsonOf(answer);
    assert.deepEqual([json.total, json.offset, json.attestations, json.next_offset], [3, 5, [], null]);
    assert.match(await call('vector_list_attestations', { subject, offset: 2 }), /^# Attestations \(3 to 3 of 3\)/);
  });
  test('a bare 64-hex issuer is read as an identifier and as a key: either finds the attestations of that issuer', async () => {
    const byDid = jsonOf(await call('vector_list_attestations', { issuer: `did:vector:${ENVIRONMENT.datum.issuerId}` }));
    const bareId = jsonOf(await call('vector_list_attestations', { issuer: ENVIRONMENT.datum.issuerId }));
    assert.deepEqual(bareId.attestations, byDid.attestations);
    assert.ok((bareId.total as number) >= 2);
    assert.deepEqual(jsonOf(await call('vector_list_attestations', { issuer: ENVIRONMENT.datum.issuer })).attestations, byDid.attestations);
    assert.equal(jsonOf(await call('vector_list_attestations', { issuer: 'ee'.repeat(32) })).total, 0);
  });
  test('a revoked attestation with a reason above 2^53 is in the list, with its exact reason', async () => {
    const S = 'a8'.repeat(32);
    const id = 'f8'.repeat(32);
    const answer = await tools({ utxos: [attestationUtxo(id, attestation({ subject: S }), { datum: revokedWithReason(2n ** 60n, { subject: S }) })] }).call('vector_list_attestations', { subject: S });
    assert.match(answer, /^# Attestations \(1 to 1 of 1\)/);
    const [row] = jsonOf(answer).attestations as Array<Record<string, unknown>>;
    assert.deepEqual([row.attestation, row.status, row.revoke_reason], [id, 'revoked', '1152921504606846976']);
  });
  test('with neither a subject nor an issuer it lists every attestation, a page at a time, in the order of the output reference, with no total', async () => {
    const all = ATTESTATIONS.map((a) => `${a.row.tx_hash}#${a.row.tx_index}`).sort();
    assert.equal(all.length, 27);
    const first = await call('vector_list_attestations', { limit: 10 });
    assert.match(first, /^# Attestations \(1 to 10\)\n\nEvery attestation, in the order of its output reference \(not newest first\)\. The rows are as Koios lists them: vector_get_attestation and vector_check_attestation confirm one attestation on the node\./);
    assert.doesNotMatch(first, /Newest first|Matching:| of \d+\)/);
    assert.match(first, /More rows follow: call again with offset 10\./);
    const joined: string[] = [];
    let next: number | null = 0;
    let last = '';
    // The bound makes a next offset that never ends fail the test, and not hang it.
    for (let pages = 0; next !== null && pages < 10; pages++) {
      last = await call('vector_list_attestations', { limit: 10, offset: next });
      const json = jsonOf(last);
      assert.deepEqual([json.total, json.offset, json.limit], [null, next, 10]);
      joined.push(...(json.attestations as Array<{ output_ref: string }>).map((r) => r.output_ref));
      next = json.next_offset as number | null;
    }
    assert.equal(next, null, 'the pages end');
    assert.deepEqual(joined, all);
    assert.match(last, /^# Attestations \(21 to 27\)\n/);
    assert.doesNotMatch(last, /More rows follow/);
  });
  test('an empty set and an offset past the end of the list of every attestation say so, and give no total', async () => {
    assert.match(await tools({ utxos: [] }).call('vector_list_attestations', {}), /^# Attestations\n\nNo rows at offset 0\./);
    const past = await call('vector_list_attestations', { offset: 30 });
    assert.match(past, /^# Attestations\n\nNo rows at offset 30\.\n/);
    assert.deepEqual([jsonOf(past).total, jsonOf(past).attestations, jsonOf(past).next_offset], [null, [], null]);
  });
  test('refuses an issuer that is none of the three forms, a type with neither a subject nor an issuer, and a page that is not one', async () => {
    assert.match(await call('vector_list_attestations', { issuer: 'nope' }), /^Failed to list attestations: The issuer must be a DID/);
    assert.match(await call('vector_list_attestations', { att_type: 'environment' }), /^Failed to list attestations: A type narrows a list by subject or by issuer: name one of them/);
    assert.match(await call('vector_list_attestations', { subject, limit: 51 }), /^Invalid arguments: limit/);
    assert.match(await call('vector_list_attestations', { subject, limit: 0 }), /^Invalid arguments: limit/);
    assert.match(await call('vector_list_attestations', { subject, offset: -1 }), /^Invalid arguments: offset/);
    assert.match(await call('vector_list_attestations', { subject, att_type: 'nope' }), /^Invalid arguments: att_type/);
  });
});

describe('vector_check_attestation', () => {
  const { call } = tools({ utxos: mainnet() });
  const expectAll = { expected_type: 'environment', expected_subject: `did:vector:${ENVIRONMENT.datum.subject}`, expected_issuer: `did:vector:${ENVIRONMENT.datum.issuerId}`, expected_digest: ENVIRONMENT.datum.digest };

  test('valid: each condition of the rule and each expectation is a row with its result', async () => {
    const answer = await call('vector_check_attestation', { attestation: ENVIRONMENT.id, ...expectAll });
    assert.match(answer, /^# Attestation Check: valid\n\nAttestation `[0-9a-f]{64}`, checked at 2026-11-18T[0-9:.]+Z \(now\)\.\n/);
    assert.match(answer, /## Validity rule \(Part 2 Section 4\.3\): met/);
    assert.match(answer, /## Expectations: met/);
    const json = jsonOf(answer);
    assert.deepEqual([json.valid, json.rule_valid, json.found, json.at], [true, true, true, CAPTURE_MS]);
    assert.deepEqual((json.conditions as Array<{ id: string; result: string }>).map((c) => `${c.id}:${c.result}`), ['authentic:pass', 'active:pass', 'time_window:pass', 'envelope:not_applicable', 'issuer_not_invalidated:pass', 'issuer_key_listed:pass']);
    assert.deepEqual((json.expectations as Array<{ id: string; result: string }>).map((c) => `${c.id}:${c.result}`), ['type:pass', 'subject:pass', 'issuer:pass', 'digest:pass']);
    assert.equal((json.details as Record<string, unknown>).attestation, ENVIRONMENT.id);
  });
  test('not valid, for each reason: revoked, expired, wrong type, wrong subject, wrong issuer, wrong digest; the answer counts the checks that fail', async () => {
    const revoked = await call('vector_check_attestation', { attestation: REVOKED.id });
    assert.match(revoked, /^# Attestation Check: not valid\n/);
    assert.match(revoked, /1 check fails\./);
    assert.match(revoked, /\| The status is AttActive \| fail \| the attestation was revoked at/);
    const expired = await call('vector_check_attestation', { attestation: ENVIRONMENT.id, time: ENVIRONMENT.datum.validUntil! + 1 });
    assert.match(expired, /^# Attestation Check: not valid\n\nAttestation `[0-9a-f]{64}`, checked at 2026-12-16T15:56:21\.001Z\./, 'a time that the caller gives has no "(now)"');
    assert.match(expired, /\| The time is inside valid_from and valid_until, and not more than one hour before issued_at \| fail \| the time 2026-12-16T15:56:21\.001Z is after valid_until 2026-12-16T15:56:21\.000Z/);
    for (const [wrong, row] of [
      [{ expected_type: 'identity' }, /\| The type is identity \(0\) \| fail \|/],
      [{ expected_subject: 'ee'.repeat(32) }, /\| The subject is did:vector:e{64} \| fail \|/],
      [{ expected_issuer: `did:vector:${'ee'.repeat(32)}` }, /\| The issuer is did:vector:e{64} \| fail \|/],
      [{ expected_issuer: '00'.repeat(28) }, /\| The issuer key has the key hash 0{56} \| fail \|/],
      [{ expected_digest: 'ee'.repeat(32) }, /\| The digest is e{64} \| fail \|/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const answer = await call('vector_check_attestation', { attestation: ENVIRONMENT.id, ...expectAll, ...wrong });
      assert.match(answer, /^# Attestation Check: not valid\n/, JSON.stringify(wrong));
      assert.match(answer, /## Validity rule \(Part 2 Section 4\.3\): met/, 'the rule still holds');
      assert.match(answer, /## Expectations: not met/);
      assert.match(answer, row);
      assert.equal(jsonOf(answer).valid, false);
      assert.equal(jsonOf(answer).rule_valid, true);
    }
  });
  test('an attestation that is not there is not valid and the answer says why', async () => {
    const answer = await call('vector_check_attestation', { attestation: 'ee'.repeat(32), expected_type: 'other' });
    assert.match(answer, /^# Attestation Check: not valid/);
    assert.match(answer, /does not exist, it was withdrawn, or it is not confirmed yet/);
    assert.doesNotMatch(answer, /## Attestation\n/);
    const json = jsonOf(answer);
    assert.deepEqual([json.found, json.valid, json.details], [false, false, null]);
  });
  test('issued_at after the time of the check does not make an attestation not valid', async () => {
    const id = 'f5'.repeat(32);
    const answer = await tools({ utxos: [attestationUtxo(id, attestation({ issuedAt: CAPTURE_MS + 59 * 60_000 }))] }).call('vector_check_attestation', { attestation: id });
    assert.match(answer, /^# Attestation Check: valid/);
  });
  test('a time more than one hour before issued_at is not valid: the attestation did not exist yet; an hour before is valid', async () => {
    const id = 'f6'.repeat(32);
    const w = tools({ utxos: [attestationUtxo(id, attestation())] });
    const early = await w.call('vector_check_attestation', { attestation: id, time: CAPTURE_MS - 3_600_001 });
    assert.match(early, /^# Attestation Check: not valid/);
    assert.match(early, /\| The time is inside valid_from and valid_until, and not more than one hour before issued_at \| fail \| the time .* is more than one hour before issued_at .*, so the attestation did not exist yet/);
    assert.match(await w.call('vector_check_attestation', { attestation: id, time: CAPTURE_MS - 3_600_000 }), /^# Attestation Check: valid/);
    assert.match(await w.call('vector_check_attestation', { attestation: id, time: 0 }), /^# Attestation Check: not valid/);
  });
  test('a bare 64-hex expected issuer is the identifier or the key: either one is valid, another is not', async () => {
    assert.match(await call('vector_check_attestation', { attestation: ENVIRONMENT.id, expected_issuer: ENVIRONMENT.datum.issuerId }), /^# Attestation Check: valid/);
    assert.match(await call('vector_check_attestation', { attestation: ENVIRONMENT.id, expected_issuer: ENVIRONMENT.datum.issuer }), /^# Attestation Check: valid/);
    const wrong = await call('vector_check_attestation', { attestation: ENVIRONMENT.id, expected_issuer: 'ee'.repeat(32) });
    assert.match(wrong, /^# Attestation Check: not valid/);
    assert.match(wrong, /\| The issuer is did:vector:e{64}, or the issuer key is e{64} \| fail \|/);
  });
  test('a revoked attestation whose reason is above 2^53 is not valid, with its exact reason in the text and in the JSON', async () => {
    const id = 'f7'.repeat(32);
    const answer = await tools({ utxos: [attestationUtxo(id, attestation(), { datum: revokedWithReason(2n ** 60n) })] }).call('vector_check_attestation', { attestation: id });
    assert.match(answer, /^# Attestation Check: not valid/);
    assert.match(answer, /\| The status is AttActive \| fail \| the attestation was revoked at .* with reason 1152921504606846976 \|/);
    const json = jsonOf(answer);
    assert.equal(json.valid, false);
    assert.equal((json.details as Record<string, unknown>).revoke_reason, '1152921504606846976');
  });
  test('arguments that are not well formed are refused by the schema', async () => {
    assert.match(await call('vector_check_attestation', { attestation: 'abc' }), /^Invalid arguments: attestation/);
    assert.match(await call('vector_check_attestation', { attestation: ENVIRONMENT.id, expected_digest: 'abc' }), /^Invalid arguments: expected_digest/);
    assert.match(await call('vector_check_attestation', { attestation: ENVIRONMENT.id, time: -1 }), /^Invalid arguments: time/);
    assert.match(await call('vector_check_attestation', { attestation: ENVIRONMENT.id, time: 1.5 }), /^Invalid arguments: time/);
    assert.match(await call('vector_check_attestation', { attestation: ENVIRONMENT.id, expected_issuer: 'nope' }), /^Failed to check the attestation: The issuer must be a DID/);
  });
});

describe('vector_get_delegation', () => {
  const { call } = tools({ utxos: mainnet() });
  test('the live delegation of mainnet: delegator, delegate, key, actions, resources, period, depth, purpose and limit', async () => {
    const answer = await call('vector_get_delegation', { delegation: LIVE.id });
    assert.match(answer, new RegExp(`^# Delegation \`${LIVE.id}\``));
    assert.match(answer, /\*\*Delegator:\*\* principal key 38abc111/);
    assert.match(answer, new RegExp(`\\*\\*Delegate:\\*\\* did:vector:${LIVE_DATUM.delegate}, delegation key \`${LIVE_DATUM.delegateKey}\``));
    assert.match(answer, /\*\*Actions:\*\* `marketplace\.hire\.v1`/);
    assert.match(answer, new RegExp(`\\*\\*Resources:\\*\\* \`${ESCROW}\``));
    assert.match(answer, /\*\*Period:\*\* 2026-11-16T16:10:49\.000Z to 2026-11-23T16:11:48\.658Z/);
    assert.match(answer, /\*\*Depth:\*\* 1, 0 further hops allowed below it/);
    assert.match(answer, /\*\*Value limit:\*\* 6\.000000 AP3X per payment, 22\.000000 AP3X per period of 86400000 ms/);
    assert.match(answer, /\*\*Chain to the root:\*\* 1 link \(this delegation is the root\)/);
    const json = jsonOf(answer);
    assert.deepEqual([json.live, json.delegation, json.missing_parent], [true, LIVE.id, null]);
    const [link] = json.chain as Array<Record<string, unknown>>;
    assert.deepEqual([link.delegate_did, link.delegate_key, link.actions, link.resources, link.depth, link.remaining], [`did:vector:${LIVE_DATUM.delegate}`, LIVE_DATUM.delegateKey, [HIRE_ACTION], [ESCROW], 1, 0]);
    assert.deepEqual(link.value, { per_tx: '6000000', total: '22000000', period_ms: DAY });
    assert.deepEqual(link.delegator, { type: 'PrincipalKey', key_hash: (LIVE_DATUM.delegator as { hash: string }).hash, organisation: null, organisation_hex: null, organisation_bytes: null });
    assert.deepEqual([link.actions_hex, link.resources_hex], [[utf8Hex(HIRE_ACTION)], [utf8Hex(ESCROW)]]);
    assert.equal(link.purpose, LIVE_DATUM.purpose);
    assert.equal(link.output_ref, `${LIVE.mint_output.tx_hash}#0`);
  });
  test('the burned delegation is not live', async () => {
    const answer = await call('vector_get_delegation', { delegation: CAPTURE.delegations.burned.id });
    assert.match(answer, /^# Delegation Not Live/);
    assert.match(answer, /does not exist, or it was undelegated and its token is burned/);
    assert.deepEqual(jsonOf(answer), { delegation: CAPTURE.delegations.burned.id, live: false, chain: [], missing_parent: null });
  });
  test('a chain: the parents are shown to the root; an undelegated parent is named and the delegation cannot be used', async () => {
    const P = 'a1'.repeat(32);
    const C = 'a2'.repeat(32);
    const AGENT = 'c3'.repeat(32);
    const parent = delegationUtxo(P, delegation({ delegate: AGENT, remaining: 1 }));
    const child = delegationUtxo(C, delegation({ parent: P, depth: 2, remaining: 0, delegator: { type: 'Agent', id: AGENT } }));
    const whole = await tools({ utxos: [parent, child] }).call('vector_get_delegation', { delegation: C });
    assert.match(whole, /\*\*Chain to the root:\*\* 2 links/);
    assert.match(whole, new RegExp(`### Parent 1: \`${P}\``));
    assert.match(whole, new RegExp(`\\*\\*Delegator:\\*\\* agent did:vector:${AGENT}`));
    assert.deepEqual((jsonOf(whole).chain as Array<{ delegation: string }>).map((l) => l.delegation), [C, P]);
    const orphan = await tools({ utxos: [child] }).call('vector_get_delegation', { delegation: C });
    assert.match(orphan, new RegExp(`The parent delegation \`${P}\` does not exist: it was undelegated\\. This delegation, and every delegation below it, cannot be used\\.`));
    assert.equal(jsonOf(orphan).missing_parent, P);
  });
  test('chain text is cleaned in the markdown and in the JSON, and verbatim in the hex fields: an action pattern with markdown characters', async () => {
    const id = 'a3'.repeat(32);
    const pattern = 'https://x.example/a|b`c';
    const answer = await tools({ utxos: [delegationUtxo(id, delegation({ actions: [utf8Hex(pattern)] }))] }).call('vector_get_delegation', { delegation: id });
    assert.match(answer, /\*\*Actions:\*\* `https:\/\/x\.example\/a¦b'c`/);
    const [link] = jsonOf(answer).chain as Array<{ actions: string[]; actions_hex: string[] }>;
    assert.deepEqual([link.actions, link.actions_hex], [["https://x.example/a¦b'c"], [utf8Hex(pattern)]]);
  });
  test('invisible characters and direction marks in the patterns and in an organisation are removed from the markdown and from the JSON text, and kept in the hex', async () => {
    const id = 'a4'.repeat(32);
    const hostile = 'https://x.example/\u202Eevil\u200B\u0085z';
    const organisation = utf8Hex('Acme\u202E\u200Bco');
    const d = delegation({ actions: [utf8Hex(hostile)], resources: [utf8Hex(hostile)], delegator: { type: 'PrincipalKey', hash: testKey(30).keyHash, organisation } });
    const answer = await tools({ utxos: [delegationUtxo(id, d)] }).call('vector_get_delegation', { delegation: id });
    assert.doesNotMatch(answer, INVISIBLE);
    const [link] = jsonOf(answer).chain as Array<{ actions: string[]; actions_hex: string[]; resources: string[]; delegator: Record<string, unknown> }>;
    assert.deepEqual([link.actions, link.resources], [['https://x.example/evil z'], ['https://x.example/evil z']]);
    assert.deepEqual([link.delegator.organisation, link.delegator.organisation_hex, link.delegator.organisation_bytes], ['Acmeco', organisation, organisation.length / 2]);
    assert.deepEqual(link.actions_hex, [utf8Hex(hostile)]);
  });
  test('the identifier must be 64 hex characters', async () => {
    assert.match(await call('vector_get_delegation', { delegation: 'abc' }), /^Invalid arguments: delegation/);
  });
});

describe('vector_check_delegation_use', () => {
  const ID = 'd1'.repeat(32);
  const key = testKey(31);
  const live = (over = {}) => [delegationUtxo(ID, delegation(over)), recordUtxo(delegation().delegate, liveRecord({}, [key.publicKey]))];
  const args = (over: Record<string, unknown> = {}) => ({ delegation: ID, action: HIRE_ACTION, resource: ESCROW, ...over });

  test('usable: no problem, and the answer says the signature is not checked', async () => {
    const answer = await tools({ utxos: live() }).call('vector_check_delegation_use', args());
    assert.match(answer, /^# Delegation Use: usable\n\nDelegation `(d1){32}`, action `marketplace\.hire\.v1` on resource `script:[0-9a-f]{56}`, at the instant 2026-11-18T[0-9:.]+Z \(now\)\.\n\nNo problem found\./);
    assert.match(answer, /The answer is for that one instant\. A transaction needs its whole validity window inside the period, with each delegate Active over the whole window\./);
    assert.match(answer, /The signature of the delegation key is not checked\./);
    const json = jsonOf(answer);
    assert.deepEqual([json.usable, json.problems, json.at, json.min_confirmations, json.confirmations, json.missing_parent], [true, [], CAPTURE_MS, 0, null, null]);
    assert.deepEqual(json.chain, [ID]);
  });
  test('not usable: every problem is numbered; the action, the resource and the time', async () => {
    const answer = await tools({ utxos: live() }).call('vector_check_delegation_use', args({ action: 'marketplace.hire.v2', resource: `script:${'ab'.repeat(28)}`, time: delegation().notAfter + 1 }));
    assert.match(answer, /^# Delegation Use: not usable/);
    assert.match(answer, /3 problems:\n1\. no action pattern of the delegation d1/);
    assert.match(answer, /\n2\. no resource pattern of the delegation/);
    assert.match(answer, /\n3\. the delegation d1\S+ ends at 2026-11-23T[0-9:.]+Z, before the end of the validity window/);
    assert.doesNotMatch(answer, /\(now\)/);
    const json = jsonOf(answer);
    assert.equal(json.usable, false);
    assert.equal((json.problems as string[]).length, 3);
  });
  test('a burned delegation: not usable, one problem, and nothing to chain', async () => {
    const answer = await tools({ utxos: [] }).call('vector_check_delegation_use', args());
    assert.match(answer, /^# Delegation Use: not usable/);
    assert.match(answer, /1 problem:\n1\. the delegation d1\S+ is not live: it does not exist, or it was undelegated and its token is burned/);
    assert.doesNotMatch(answer, /\*\*Chain:\*\*/);
  });
  test('the delegation of mainnet, whose delegate is not in this world: an error that names the delegate', async () => {
    const answer = await tools({ utxos: [utxoOf(LIVE.mint_output)] }).call('vector_check_delegation_use', args({ delegation: LIVE.id }));
    assert.match(answer, new RegExp(`^Failed to check the delegation use: No record of the delegate for did:vector:${LIVE_DATUM.delegate}`));
  });
  test('min_confirmations: the depth of each link is shown, and a mint that is too shallow is a problem', async () => {
    const utxos = live();
    const info = [koiosRow(utxos[0], { block_height: 9_502_929 - 12 })];
    const answer = await tools({ utxos, utxoInfo: info, tip: 9_502_929 }).call('vector_check_delegation_use', args({ min_confirmations: 30 }));
    assert.match(answer, /^# Delegation Use: not usable/);
    assert.match(answer, /the delegation d1\S+ has 12 confirmations, fewer than the 30 that are asked for/);
    assert.match(answer, /\*\*Confirmations\*\* \(tip height 9502929\): `d1\S+` 12/);
    const json = jsonOf(answer);
    assert.deepEqual(json.confirmations, { tip_height: 9_502_929, links: [{ delegation: ID, block_height: 9_502_917, confirmations: 12 }] });
    const deep = await tools({ utxos, utxoInfo: [koiosRow(utxos[0], { block_height: 9_502_929 - 30 })], tip: 9_502_929 }).call('vector_check_delegation_use', args({ min_confirmations: 30 }));
    assert.match(deep, /^# Delegation Use: usable/);
  });
  test('an action or a resource that does not follow Part 2 Section 5.1 is refused with the rule; a pattern is not an action', async () => {
    const { call } = tools({ utxos: live() });
    assert.match(await call('vector_check_delegation_use', args({ action: 'marketplace.*' })), /^Failed to check the delegation use: The action must follow Part 2 Section 5\.1/);
    assert.match(await call('vector_check_delegation_use', args({ resource: '*' })), /^Failed to check the delegation use: The resource must follow Part 2 Section 5\.1/);
    assert.match(await call('vector_check_delegation_use', args({ min_confirmations: -1 })), /^Invalid arguments: min_confirmations/);
    assert.match(await call('vector_check_delegation_use', { delegation: ID }), /^Invalid arguments: action: .*resource/);
  });
});

describe('vector_get_vault', () => {
  const DELEGATE_KEY = testKey(31);
  /** The vault outputs of mainnet, its live delegation with the delegate key of a key of the tests, and the record of the delegate that lists it: a payment can pass the use checks. */
  const payable = (): UTxO[] => [...CAPTURE.vaults.map(utxoOf), delegationUtxo(LIVE.id, { ...LIVE_DATUM, delegateKey: DELEGATE_KEY.keyHash }), recordUtxo(LIVE_DATUM.delegate, liveRecord({}, [DELEGATE_KEY.publicKey]))];
  const { call } = tools({ utxos: payable() });
  const LIVE_VAULT = CAPTURE.vaults.find((r) => r.inline_datum!.bytes.startsWith('d8799f'))!;
  const LIVE_REF = `${LIVE_VAULT.tx_hash}#${LIVE_VAULT.tx_index}`;
  const OWNER = '38abc11175937560b05ab347e6f11ae055931781ce1549dc33b86939';
  const owner = { type: 'PrincipalKey', hash: testKey(50).keyHash, organisation: null } as const;
  const D = 'd1'.repeat(32);
  const refOf = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;
  const live = (over = {}) => ({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2, ...over }) as const;
  const delegated = (over = {}): UTxO[] => [delegationUtxo(D, delegation({ delegator: owner, ...over })), recordUtxo(delegation().delegate, liveRecord({}, [DELEGATE_KEY.publicKey]))];
  const outputsOf = (answer: string): Array<Record<string, unknown>> => jsonOf(answer).outputs as Array<Record<string, unknown>>;

  test('by owner key hash: the Live output with its limit, that it can pay and what the period allows, then the four Returned outputs', async () => {
    const answer = await call('vector_get_vault', { owner_key_hash: OWNER });
    assert.match(answer, /^# Vault Outputs \(1 to 5 of 5\)\n\nRead by owner key hash `38abc111\w+`, at 2026-11-18T/);
    assert.match(answer, /A vault output reference changes with each payment: read by owner key hash or by delegation to find the current output\./);
    assert.match(answer, /The outputs whose owner is the delegator of their delegation come first, the one with the most AP3X first\. Anyone can write a vault output, so an output that names an owner is not a vault of that owner\. The outputs of the page are confirmed on the node: a row that the node does not hold cannot pay\./);
    assert.equal(answer.match(/## Live vault output/g)!.length, 1);
    assert.equal(answer.match(/## Returned vault output/g)!.length, 4);
    assert.match(answer, new RegExp(`## Live vault output \`${LIVE_REF}\``));
    assert.match(answer, /\*\*Holds:\*\* 9\.200000 AP3X/);
    assert.match(answer, new RegExp(`\\*\\*Delegation:\\*\\* \`${LIVE.id}\`, its token exists at the delegation address\\n`));
    assert.match(answer, /\*\*Pays now:\*\* yes: a payment built now for marketplace\.hire\.v1 on the escrow script passes the use checks \(the shortest validity window, one minute before and after now\), and the next payment may lock at least the ledger minimum of the smallest escrow output/);
    assert.match(answer, /\*\*Limit:\*\* 6\.000000 AP3X per payment, 22\.000000 AP3X per period of 86400000 ms/);
    assert.match(answer, /\*\*Period:\*\* started 2026-11-16T16:33:18\.000Z, ended 2026-11-17T16:33:18\.000Z; spent 20\.800000 AP3X \(a payment built now starts a new period; a payment opens its window a minute before the build, so the contract counts the old period for a minute after it ends\)/);
    assert.match(answer, /\*\*Still allowed:\*\* 22\.000000 AP3X in the next period; the next payment may lock up to 6\.000000 AP3X: the smallest of the limit per payment, what the period still allows, and the AP3X of the vault above the ledger minimum of its next output/);
    assert.match(answer, /\*\*Smallest payment:\*\* 2\.\d{6} AP3X, the ledger minimum of the smallest escrow output \(an Open escrow with the refund to this vault and the delegate key\)\. vector_build_vault_pay locks at least 2\.\d{6} AP3X, its own floor for the shortest datum, and a real advert needs more/);
    assert.doesNotMatch(answer, /Why it cannot pay/);
    assert.match(answer, /An escrow refund\. Only its owner can spend it, with vector_build_vault_close/);
    const json = jsonOf(answer);
    assert.deepEqual([json.total, json.shown, json.offset, json.limit, json.next_offset, json.ordered_by_delegator], [5, 5, 0, 20, null, true]);
    const outputs = outputsOf(answer);
    assert.deepEqual(outputs.map((o) => o.kind), ['Live', 'Returned', 'Returned', 'Returned', 'Returned']);
    assert.ok(outputs.every((o) => o.on_node === true));
    const [first] = outputs;
    assert.deepEqual(
      [first.vault_ref, first.lovelace, first.delegation, first.spent, first.period_start, first.per_tx, first.total, first.period_ms, first.period_end, first.period_running, first.remaining, first.next_max, first.owner_is_delegator, first.delegation_live],
      [LIVE_REF, '9200000', LIVE.id, '20800000', 1794846798000, '6000000', '22000000', DAY, 1794846798000 + DAY, false, '22000000', '6000000', true, true],
    );
    assert.deepEqual([first.can_pay, first.problems, first.delegation_error, first.delegation_missing_parent], [true, [], null, null]);
    const minimum = BigInt(first.escrow_minimum as string);
    const floor = BigInt(first.build_floor as string);
    assert.ok(minimum > 2_000_000n && minimum < 3_000_000n && floor > minimum, `the minimum is ${minimum} and the floor of the build tool is ${floor}`);
    assert.deepEqual(first.owner, { type: 'PrincipalKey', key_hash: OWNER, organisation: null, organisation_hex: null, organisation_bytes: null });
    assert.deepEqual(Object.keys(outputs[1]).includes('per_tx'), false, 'a Returned output has no limit');
    assert.deepEqual(Object.keys(outputs[1]).includes('escrow_minimum'), false, 'and no smallest escrow');
  });
  test('by delegation: the Live output only', async () => {
    const answer = await call('vector_get_vault', { delegation: LIVE.id });
    assert.match(answer, /^# Vault Outputs \(1 to 1 of 1\)\n\nRead by delegation `5b481633/);
    assert.equal(jsonOf(answer).total, 1);
    assert.doesNotMatch(answer, /Returned vault output/);
  });
  test('by output reference: that output, with its allowance', async () => {
    const answer = await call('vector_get_vault', { vault_ref: LIVE_REF });
    assert.match(answer, /^# Vault Outputs \(1 to 1 of 1\)\n\nRead by output `aa373b0b/);
    assert.match(answer, /\*\*Still allowed:\*\*/);
    assert.match(await call('vector_get_vault', { vault_ref: `${'ee'.repeat(32)}#1` }), /^Failed to read the vault: Vault e{64}#1 is not an unspent output on the node/);
  });
  test('nothing found: said so', async () => {
    const answer = await call('vector_get_vault', { owner_key_hash: 'ab'.repeat(28) });
    assert.match(answer, /^# Vault Outputs\n\nNo vault output matches \(owner key hash `(ab){28}`\)/);
    assert.deepEqual([jsonOf(answer).total, jsonOf(answer).outputs], [0, []]);
  });
  test('exactly one of the three: none and two are refused, and the refusal names them', async () => {
    assert.match(await call('vector_get_vault', {}), /^Failed to read the vault: Give exactly one of vault_ref, owner_key_hash and delegation\./);
    assert.match(await call('vector_get_vault', { owner_key_hash: OWNER, delegation: LIVE.id }), /^Failed to read the vault: Give exactly one of vault_ref, owner_key_hash and delegation\./);
    assert.match(await call('vector_get_vault', { vault_ref: LIVE_REF, owner_key_hash: OWNER, delegation: LIVE.id }), /^Failed to read the vault: Give exactly one of/);
    assert.match(await call('vector_get_vault', { owner_key_hash: 'abc' }), /^Invalid arguments: owner_key_hash/);
    assert.match(await call('vector_get_vault', { delegation: 'abc' }), /^Invalid arguments: delegation/);
  });

  test('pages: 53 outputs are 20 at a time by default, 50 at most, and an offset past the end says so', async () => {
    const many = Array.from({ length: 53 }, (_, i) => vaultUtxo({ type: 'Returned', owner }, 1_000_000n + BigInt(i)));
    const { call: many3 } = tools({ utxos: many });
    const first = await many3('vector_get_vault', { owner_key_hash: owner.hash });
    assert.match(first, /^# Vault Outputs \(1 to 20 of 53\)/);
    assert.match(first, /\n\nMore outputs follow: call again with offset 20\. Each call reads the set again, so a set that changes between two calls can repeat a row or skip one at a page boundary\./);
    assert.deepEqual([jsonOf(first).total, jsonOf(first).shown, jsonOf(first).offset, jsonOf(first).limit, jsonOf(first).next_offset], [53, 20, 0, 20, 20]);
    const wide = jsonOf(await many3('vector_get_vault', { owner_key_hash: owner.hash, limit: 50 }));
    assert.deepEqual([wide.shown, wide.next_offset], [50, 50]);
    const last = await many3('vector_get_vault', { owner_key_hash: owner.hash, limit: 50, offset: 50 });
    assert.match(last, /^# Vault Outputs \(51 to 53 of 53\)/);
    assert.doesNotMatch(last, /More outputs follow/);
    const past = await many3('vector_get_vault', { owner_key_hash: owner.hash, offset: 60 });
    assert.match(past, /^# Vault Outputs\n\nNo rows at offset 60: 53 in total \(owner key hash `[0-9a-f]{56}`\)\./);
    assert.deepEqual([jsonOf(past).total, jsonOf(past).outputs, jsonOf(past).next_offset], [53, [], null]);
    assert.match(await many3('vector_get_vault', { owner_key_hash: owner.hash, limit: 51 }), /^Invalid arguments: limit/);
    assert.match(await many3('vector_get_vault', { owner_key_hash: owner.hash, limit: 0 }), /^Invalid arguments: limit/);
    assert.match(await many3('vector_get_vault', { owner_key_hash: owner.hash, offset: -1 }), /^Invalid arguments: offset/);
  });
  test('55 outputs of an attacker with lower references do not hide the real vault: it is the first section, and offset reaches the rest', async () => {
    const hostile = Array.from({ length: 55 }, () => vaultUtxo(live({ owner: { type: 'PrincipalKey', hash: testKey(51).keyHash, organisation: null } }), 5_000_000n));
    const real = vaultUtxo(live(), 9_000_000n);
    const { call: world } = tools({ utxos: [...hostile, real, ...delegated()] });
    const answer = await world('vector_get_vault', { delegation: D, limit: 5 });
    assert.match(answer, /^# Vault Outputs \(1 to 5 of 56\)/);
    assert.equal(outputsOf(answer)[0].vault_ref, refOf(real));
    assert.ok(answer.indexOf(`## Live vault output \`${refOf(real)}\``) < answer.indexOf(`## Live vault output \`${refOf(hostile[0])}\``));
    assert.deepEqual(outputsOf(answer).map((o) => o.can_pay), [true, false, false, false, false]);
    const rest = outputsOf(await world('vector_get_vault', { delegation: D, limit: 50, offset: 50 }));
    assert.equal(rest.length, 6);
  });

  test('a Live output whose delegation was burned: said so, and the owner can still close it', async () => {
    const answer = await tools({ utxos: [vaultUtxo(live(), 5_000_000n)] }).call('vector_get_vault', { owner_key_hash: owner.hash });
    assert.match(answer, /\*\*Delegation:\*\* `(d1){32}`, it does not exist: it was never made, or it was undelegated; the owner can still close this output/);
    assert.match(answer, /\*\*Pays now:\*\* no, for 1 reason \(below\)/);
    assert.match(answer, /\*\*Why it cannot pay:\*\*\n1\. the delegation (d1){32} does not exist: it was never made, or it was undelegated and its token is burned; the owner can still close this output/);
    assert.doesNotMatch(answer, /\*\*Still allowed:\*\*|\(live\)/);
    const [row] = outputsOf(answer);
    assert.deepEqual([row.delegation_live, row.per_tx, row.period_running, row.owner_is_delegator, row.can_pay, row.remaining, row.next_max], [false, null, null, null, false, null, null]);
  });
  test('an owner that is not the delegator, and a delegation without a limit: the answer says that the output cannot pay, and why', async () => {
    const wrongOwner = await tools({ utxos: [vaultUtxo(live(), 5_000_000n), ...delegated({ delegator: { type: 'PrincipalKey', hash: 'ab'.repeat(28), organisation: null } })] }).call('vector_get_vault', { delegation: D });
    assert.match(wrongOwner, /\*\*Pays now:\*\* no, for 1 reason/);
    assert.match(wrongOwner, /1\. the owner of this output is not the delegator of the delegation, so it cannot pay/);
    assert.doesNotMatch(wrongOwner, /\*\*Still allowed:\*\*/);
    const noLimit = await tools({ utxos: [vaultUtxo(live(), 5_000_000n), ...delegated({ value: null })] }).call('vector_get_vault', { delegation: D });
    assert.match(noLimit, /the delegation has no value limit, and a vault pays only under one/);
    assert.doesNotMatch(noLimit, /\*\*Limit:\*\*|\*\*Still allowed:\*\*/);
  });
  test('a delegation past not_after is not shown as live with an allowance: the output cannot pay, and the problem names the end', async () => {
    const answer = await tools({ utxos: [vaultUtxo(live(), 5_000_000n), ...delegated({ notAfter: CAPTURE_MS - 1000 })] }).call('vector_get_vault', { delegation: D });
    assert.match(answer, /\*\*Pays now:\*\* no, for 1 reason/);
    assert.match(answer, /ends at 2026-11-18T[0-9:.]+Z, before the end of the validity window/);
    assert.match(answer, /\*\*Limit:\*\* 6\.000000 AP3X per payment/, 'the limit is a fact of the delegation');
    assert.doesNotMatch(answer, /\*\*Still allowed:\*\*|\(live\)/);
    const [row] = outputsOf(answer);
    assert.deepEqual([row.can_pay, row.remaining, row.next_max, row.period_end, row.period_running, row.per_tx], [false, null, null, null, null, '6000000']);
  });
  test('a delegation whose period is above 2^53 is reported on its output, and the other outputs are read', async () => {
    const BAD = 'bd'.repeat(32);
    const hostile = vaultUtxo(live({ delegation: BAD }), 5_000_000n);
    const real = vaultUtxo(live(), 9_000_000n);
    const wide = delegationUtxo(BAD, delegation({ delegator: owner }), { datum: delegationWithPeriod(2n ** 60n, { delegator: owner }) });
    const answer = await tools({ utxos: [hostile, real, wide, ...delegated()] }).call('vector_get_vault', { owner_key_hash: owner.hash });
    assert.match(answer, /^# Vault Outputs \(1 to 2 of 2\)/);
    assert.match(answer, /\*\*Delegation:\*\* `(bd){32}`, which cannot be read: The delegation (bd){32} .* does not decode: decodeDelegationDatum: delegation\.value\.period_ms: integer outside the safe range of this tool/);
    assert.match(answer, /\*\*Pays now:\*\* unknown, because the delegation cannot be read/);
    const byRef = new Map(outputsOf(answer).map((o) => [o.vault_ref, o]));
    assert.match(String(byRef.get(refOf(hostile))!.delegation_error), /outside the safe range/);
    assert.deepEqual([byRef.get(refOf(hostile))!.can_pay, byRef.get(refOf(hostile))!.next_max], [false, null]);
    assert.deepEqual([byRef.get(refOf(real))!.can_pay, byRef.get(refOf(real))!.delegation_error], [true, null]);
  });
  test('a vault that has paid nothing yet says so: no payment yet, and not a period in 1970', async () => {
    const answer = await tools({ utxos: [vaultUtxo(live({ spent: 0n, periodStart: 0 }), 9_000_000n), ...delegated()] }).call('vector_get_vault', { delegation: D });
    assert.match(answer, /\*\*Period:\*\* no payment yet: the first payment starts the period\n/);
    assert.doesNotMatch(answer, /1970/);
    const [row] = outputsOf(answer);
    assert.deepEqual([row.period_start, row.can_pay, row.remaining], [0, true, '22000000']);
    const started = await tools({ utxos: [vaultUtxo(live(), 9_000_000n), ...delegated()] }).call('vector_get_vault', { delegation: D });
    assert.match(started, /\*\*Period:\*\* started 2026-11-1\d.*, ends 2026-11-1\d.*; spent 1\.000000 AP3X\n/);
  });
  test('a limit whose period is longer than the time since 1970 never ends: with no payment yet the answer says that its total counts for the whole life of the vault, and not that the first payment starts the period', async () => {
    const value = { perTx: 6_000_000n, total: 22_000_000n, periodMs: 5_000_000_000_000 };
    const answer = await tools({ utxos: [vaultUtxo(live({ spent: 0n, periodStart: 0 }), 9_000_000n), ...delegated({ value })] }).call('vector_get_vault', { delegation: D });
    assert.match(answer, /\*\*Period:\*\* no payment yet: the period of the limit counts from 0 and has not ended, so its total is a limit for the whole life of the vault\n/);
    assert.doesNotMatch(answer, /the first payment starts the period/);
    const [row] = outputsOf(answer);
    assert.deepEqual([row.can_pay, row.period_running, row.remaining], [true, true, '22000000']);
    const cannot = await tools({ utxos: [vaultUtxo(live({ spent: 0n, periodStart: 0 }), 9_000_000n), ...delegated({ value, notAfter: CAPTURE_MS - 1000 })] }).call('vector_get_vault', { delegation: D });
    assert.match(cannot, /\*\*Period:\*\* no payment yet\n/, 'an output that cannot pay says only that there is no payment yet');
  });
  test('next_max is what a payment can take: a vault of 5 AP3X under 6 AP3X per payment may lock less than 5 AP3X, as it keeps the ledger minimum', async () => {
    const answer = await tools({ utxos: [vaultUtxo(live({ spent: 0n, periodStart: 0 }), 5_000_000n), ...delegated()] }).call('vector_get_vault', { delegation: D });
    const [row] = outputsOf(answer);
    const next = BigInt(row.next_max as string);
    assert.ok(next > 3_000_000n && next < 5_000_000n, `next_max is ${next}`);
    assert.match(answer, new RegExp(`the next payment may lock up to ${(Number(next) / 1e6).toFixed(6)} AP3X`));
    assert.equal(row.remaining, '22000000');
  });
  test('an output that no payment can leave cannot pay: the answer says why, and gives the ledger minimum of the smallest escrow output and the floor of the build tool', async () => {
    const left = await tools({ utxos: [vaultUtxo(live({ spent: 20_800_000n }), 9_000_000n), ...delegated()] }).call('vector_get_vault', { delegation: D });
    const [row] = outputsOf(left);
    const minimum = BigInt(row.escrow_minimum as string);
    const floor = BigInt(row.build_floor as string);
    assert.ok(minimum > 2_000_000n && minimum < 3_000_000n && floor > minimum, `the minimum is ${minimum} and the floor is ${floor}`);
    assert.deepEqual([row.can_pay, row.remaining, row.next_max, row.period_running], [false, null, null, null]);
    assert.deepEqual(row.problems, [`the delegation allows 1200000 more lovelace in the period that a payment built now falls in, and the smallest escrow output needs ${minimum} lovelace (its ledger minimum): no payment can leave this output`]);
    assert.match(left, /\*\*Pays now:\*\* no, for 1 reason \(below\)/);
    assert.match(left, new RegExp(`\\*\\*Smallest payment:\\*\\* ${(Number(minimum) / 1e6).toFixed(6)} AP3X, the ledger minimum of the smallest escrow output \\(an Open escrow with the refund to this vault and the delegate key\\)\\. vector_build_vault_pay locks at least ${(Number(floor) / 1e6).toFixed(6)} AP3X, its own floor for the shortest datum, and a real advert needs more`));
    assert.match(left, /\*\*Why it cannot pay:\*\*\n1\. the delegation allows 1200000 more lovelace in the period that a payment built now falls in, and the smallest escrow output needs \d+ lovelace/);
    assert.doesNotMatch(left, /\*\*Still allowed:\*\*/);
    const enough = await tools({ utxos: [vaultUtxo(live({ spent: 12_000_000n }), 9_000_000n), ...delegated()] }).call('vector_get_vault', { delegation: D });
    const [ok] = outputsOf(enough);
    assert.deepEqual([ok.can_pay, ok.escrow_minimum, ok.build_floor], [true, row.escrow_minimum, row.build_floor], 'the twin: with 10 AP3X left it can pay, and the answer still gives both numbers');
    assert.match(enough, /\*\*Smallest payment:\*\*/);
  });
  test('a row that Koios lists and the node does not hold is shown as such: not on the node, it cannot pay, and the answer says that it is spent or that the indexer is ahead', async () => {
    const real = vaultUtxo(live(), 9_000_000n);
    const gone = vaultUtxo(live({ spent: 2_000_000n }), 7_000_000n);
    const goneReturned = vaultUtxo({ type: 'Returned', owner }, 1_100_000n);
    const { call: world } = tools({ utxos: [real, ...delegated()], extraRows: [koiosRow(gone), koiosRow(goneReturned)] });
    const answer = await world('vector_get_vault', { owner_key_hash: owner.hash });
    const byRef = new Map(outputsOf(answer).map((o) => [o.vault_ref, o]));
    assert.deepEqual([byRef.get(refOf(real))!.on_node, byRef.get(refOf(real))!.can_pay], [true, true]);
    const g = byRef.get(refOf(gone))!;
    assert.deepEqual([g.on_node, g.can_pay, g.problems, g.remaining, g.next_max, g.escrow_minimum], [false, false, ['the node does not hold this output: it is spent, or the indexer is ahead'], null, null, null]);
    assert.equal(byRef.get(refOf(goneReturned))!.on_node, false);
    assert.match(answer, new RegExp(`## Live vault output \`${refOf(gone)}\`\\n\\n\\*\\*Holds:\\*\\* 7\\.000000 AP3X\\n\\*\\*Owner:\\*\\* .*\\n\\*\\*On the node:\\*\\* no \\(the node does not hold this output: it is spent, or the indexer is ahead\\)\\n\\*\\*Pays now:\\*\\* no, because the node does not hold this output`));
    assert.match(answer, new RegExp(`## Returned vault output \`${refOf(goneReturned)}\`\\n\\n\\*\\*Holds:\\*\\* 1\\.100000 AP3X\\n\\*\\*Owner:\\*\\* .*\\n\\*\\*On the node:\\*\\* no \\(the node does not hold this output: it is spent, or the indexer is ahead\\)(\\n\\n|$)`));
    assert.doesNotMatch(answer, /An escrow refund\./, 'a Returned output that the node does not hold is not described as spendable');
    assert.match(answer, / The outputs of the page are confirmed on the node: a row that the node does not hold cannot pay\./);
    assert.doesNotMatch(await world('vector_get_vault', { vault_ref: refOf(real) }), /confirmed on the node/, 'a read by output reference reads the node itself');
  });
  test('the funded vault comes first: the outputs that can pay are in the order of their AP3X, and equal amounts by output reference', async () => {
    const small = vaultUtxo(live(), 5_000_000n);
    const big = vaultUtxo(live({ spent: 2_000_000n }), 9_000_000n);
    const mid = vaultUtxo(live({ spent: 3_000_000n }), 6_000_000n);
    const same = vaultUtxo(live({ spent: 4_000_000n }), 6_000_000n);
    const returned = vaultUtxo({ type: 'Returned', owner }, 8_000_000n);
    const answer = await tools({ utxos: [small, big, mid, same, returned, ...delegated()] }).call('vector_get_vault', { owner_key_hash: owner.hash });
    assert.deepEqual(outputsOf(answer).map((o) => o.vault_ref), [big, mid, same, small, returned].map(refOf), 'the Returned output with the most AP3X is last');
    const byDelegation = await tools({ utxos: [small, big, mid, ...delegated()] }).call('vector_get_vault', { delegation: D });
    assert.deepEqual(outputsOf(byDelegation).map((o) => o.vault_ref), [big, mid, small].map(refOf));
  });
  test('when 5,000 or more delegations exist the order is by output reference only, and the answer says so; each output still says whether its owner is the delegator', async () => {
    const template = koiosRow(delegationUtxo('aa'.repeat(32), delegation()));
    const many = Array.from({ length: 5_000 }, (_, i) => ({ ...template, tx_hash: (i + 1).toString(16).padStart(8, '0').repeat(8), asset_list: [{ policy_id: MAINNET.delegation.hash, asset_name: (i + 1).toString(16).padStart(64, '0'), quantity: '1' }] }));
    const small = vaultUtxo(live(), 5_000_000n);
    const big = vaultUtxo(live({ spent: 2_000_000n }), 9_000_000n);
    const returned = vaultUtxo({ type: 'Returned', owner }, 8_000_000n);
    const world = tools({ utxos: [small, big, returned, ...delegated()], extraRows: many });
    const answer = await world.call('vector_get_vault', { owner_key_hash: owner.hash });
    assert.match(answer, /The delegations could not be read for the order \(5,000 or more exist, or the delegation cannot be read\), so the order is by output reference only, Live outputs first\. Each output of the page says whether its owner is the delegator of its delegation\. Anyone can write a vault output/);
    assert.equal(jsonOf(answer).ordered_by_delegator, false);
    const rows = outputsOf(answer);
    assert.deepEqual(rows.map((o) => o.vault_ref), [small, big, returned].map(refOf), 'by output reference, Live first, and not by AP3X');
    assert.deepEqual(rows.slice(0, 2).map((o) => [o.owner_is_delegator, o.can_pay]), [[true, true], [true, true]]);
    const fewer = await tools({ utxos: [small, big, returned, ...delegated()] }).call('vector_get_vault', { owner_key_hash: owner.hash });
    assert.equal(jsonOf(fewer).ordered_by_delegator, true);
    assert.doesNotMatch(fewer, /could not be read for the order/);
  });

  test('the organisation of an owner is cleaned in the markdown and in the JSON text, and kept in the hex; one above 64 bytes is marked and not shown', async () => {
    const short = utf8Hex('Acme\u202E\u200Bco');
    const text = (organisation: string) => tools({ utxos: [vaultUtxo({ type: 'Returned', owner: { type: 'PrincipalKey', hash: owner.hash, organisation } }, 1_000_000n)] }).call('vector_get_vault', { owner_key_hash: owner.hash });
    const ok = await text(short);
    assert.doesNotMatch(ok, INVISIBLE);
    assert.match(ok, /\*\*Owner:\*\* principal key [0-9a-f]{56} \(organisation Acmeco\)/);
    assert.deepEqual(outputsOf(ok)[0].owner, { type: 'PrincipalKey', key_hash: owner.hash, organisation: 'Acmeco', organisation_hex: short, organisation_bytes: short.length / 2 });
    const exactly = utf8Hex('o'.repeat(64));
    assert.match(await text(exactly), /\(organisation o{64}\)/, 'a 64-byte organisation is shown');
    assert.deepEqual(outputsOf(await text(exactly))[0].owner, { type: 'PrincipalKey', key_hash: owner.hash, organisation: 'o'.repeat(64), organisation_hex: exactly, organisation_bytes: 64 });
    const long = utf8Hex('x'.repeat(200));
    const marked = await text(long);
    assert.match(marked, /\*\*Owner:\*\* principal key [0-9a-f]{56} \(an organisation of 200 bytes, not shown\)/);
    assert.doesNotMatch(marked, /x{20}|78787878/, 'neither the text nor its hex is in the answer');
    assert.deepEqual(outputsOf(marked)[0].owner, { type: 'PrincipalKey', key_hash: owner.hash, organisation: null, organisation_hex: null, organisation_bytes: 200 });
    assert.ok(marked.length < 5_000, 'the answer stays small');
  });
});

describe('the descriptions of the tools say what a caller needs to know', () => {
  const { registered } = tools({ utxos: [] });
  const text = (name: (typeof TOOLS)[number]): string => registered.get(name)!.description;
  /** The description of a parameter: the schema of an optional parameter wraps the one that carries the description. */
  const describedAs = (schema: z.core.$ZodType): string => z.globalRegistry.get(schema)?.description ?? z.globalRegistry.get(schema instanceof z.ZodOptional ? schema.unwrap() : schema)?.description ?? '';

  test('every tool says that it is read-only and builds and signs nothing', () => {
    for (const name of TOOLS) assert.match(text(name), /Read-only: the tool builds and signs nothing\./, name);
  });
  test('the attestation tools say that a time more than an hour before issued_at is before the attestation existed', () => {
    assert.match(text('vector_get_attestation'), /never earlier than one hour before issued_at: issued_at is the end of the validity window of the transaction that made it, and that window is at most one hour long/);
    assert.match(text('vector_check_attestation'), /not more than one hour before issued_at \(a time before that is before the attestation existed\)/);
    assert.match(text('vector_list_attestations'), /not yet valid \(before valid_from, or more than one hour before issued_at\)/);
  });
  test('the attestation list says how it reads and what it cannot find: the bytes of the subject or the issuer, 5,000 or more, a key hash, the list of every attestation, and that the rows are as Koios lists them', () => {
    const d = text('vector_list_attestations');
    assert.doesNotMatch(d, /The list is exact/);
    assert.match(d, /Give neither to list every attestation\./);
    assert.match(d, /Koios lists the outputs at the attestation script that hold an attestation token and whose datum holds the bytes of the subject \(or, with no subject, of the issuer\)\. The tool decodes each output and compares the subject, the issuer and the type on the decoded fields\./);
    assert.match(d, /A call fails when 5,000 or more attestation outputs name the subject or the issuer: read one attestation with vector_get_attestation then\./);
    assert.match(d, /An attestation whose datum writes those bytes in a non-standard form \(a byte string in chunks\) is not listed: vector_get_attestation reads it by its identifier\./);
    assert.match(d, /An issuer that is given by its key hash alone cannot narrow the read, because a datum holds the public key and not its hash: the call then reads every attestation output, and it fails when 5,000 or more exist\. Give the public key, the issuer DID or a subject\./);
    assert.match(d, /With neither a subject nor an issuer, Koios pages the list: the rows come in the order of the output reference, not newest first, and the answer has no total\. A type needs a subject or an issuer\./);
    assert.match(d, /The rows are as Koios lists them\. vector_get_attestation and vector_check_attestation confirm one attestation on the node\./);
    assert.match(describedAs(registered.get('vector_list_attestations')!.shape.att_type), /it needs a subject or an issuer/);
  });
  test('every tool says that a call stops after 30 s with an error when the node or Koios answers too slowly', () => {
    for (const name of TOOLS) assert.match(text(name), /A call that the node or Koios answers too slowly stops after 30 s with an error\.|that the node or Koios answers too slowly, stops after 30 s with an error: ask for a smaller limit\./, name);
  });
  test('the lists that page say that the set can change between two calls: a row can repeat or be skipped', () => {
    for (const name of ['vector_list_attestations', 'vector_get_vault'] as const) {
      assert.match(text(name), /Each call reads the set again, so a set that changes between two calls can repeat a row or skip one at a page boundary\./, name);
    }
  });
  test('a 64-hex issuer can be an identifier or a public key, in the list, in the check and in the schemas', () => {
    assert.match(text('vector_list_attestations'), /or 64 hex that can be an issuer identifier or a public key \(they match by either reading\)/);
    assert.match(text('vector_check_attestation'), /64 hex can be an issuer identifier or a public key: they match by either reading\./);
    for (const [name, field] of [['vector_list_attestations', 'issuer'], ['vector_check_attestation', 'expected_issuer']] as const) {
      assert.match(describedAs(registered.get(name)!.shape[field]), /64 hex.*identifier.*(either reading|public key)/i, `${name}.${field}`);
    }
  });
  test('the delegation use check says that usable is for one instant, and what a transaction needs', () => {
    const d = text('vector_check_delegation_use');
    assert.match(d, /can be used for an action on a resource at one instant/);
    assert.match(d, /Usable is for that one instant\. A transaction needs its whole validity window inside the period, and each delegate Active over the whole window, so a delegation that is usable now can still fail in a build that ends later\./);
    assert.match(describedAs(registered.get('vector_check_delegation_use')!.shape.time), /The instant to check at/);
  });
  test('the vault tool says that anyone can write a vault output, how it orders and pages, when it gives an allowance, what it does not list, and when it stops', () => {
    const d = text('vector_get_vault');
    assert.match(d, /Anyone can write a vault output with any datum, so an output is not a vault of its owner because it names the owner\./);
    assert.match(d, /A vault output whose datum the tool cannot read as a vault datum is not listed: read it with vault_ref to see why\./);
    assert.match(d, /The outputs whose owner is the delegator of their delegation come first, the one with the most AP3X first, then the other Live outputs, then the Returned ones; each of the last two groups is in the order of the output reference\./);
    assert.match(d, /When the delegations cannot be read for this order \(5,000 or more exist\), the order is by output reference only, and the answer says so\./);
    assert.match(d, /Limit and offset page the list\. Only the outputs of the page are read further\. The tool confirms the page on the node with one request: a row that the node does not hold \(it is spent, or the indexer is ahead\) cannot pay, and the answer says so\./);
    assert.match(d, /It gives what the period still allows \(remaining, and next_max: the most that the next payment may lock, which also keeps the ledger minimum of the next output\) only for an output that can pay\./);
    assert.match(d, /An output can pay only when next_max reaches the ledger minimum of the smallest escrow output that a payment can make \(an Open escrow with the refund to the vault and the delegate key\): below that, no payment can leave it\. The answer gives that minimum as escrow_minimum\. vector_build_vault_pay locks at least its own floor, which is higher; the answer gives it as build_floor, and a real advert needs more\./);
    assert.match(d, /A delegation that cannot be read is reported on its output and does not stop the others\. A call that needs too many requests, or that the node or Koios answers too slowly, stops after 30 s with an error: ask for a smaller limit\./);
    assert.match(d, /A read also fails when 5,000 or more outputs match one Koios filter \(the vault outputs of the owner key, or the Live outputs of the delegation\): read by delegation instead of by owner key hash, or the reverse\./);
    assert.ok(registered.get('vector_get_vault')!.shape.limit && registered.get('vector_get_vault')!.shape.offset, 'limit and offset are parameters');
  });
});

describe('every tool: the gate, the deployment and Koios', () => {
  const ARGS: Record<(typeof TOOLS)[number], Record<string, unknown>> = {
    vector_get_attestation: { attestation: ENVIRONMENT.id },
    vector_list_attestations: { subject: ENVIRONMENT.datum.subject },
    vector_check_attestation: { attestation: ENVIRONMENT.id },
    vector_get_delegation: { delegation: LIVE.id },
    vector_check_delegation_use: { delegation: LIVE.id, action: HIRE_ACTION, resource: ESCROW },
    vector_get_vault: { owner_key_hash: '38abc11175937560b05ab347e6f11ae055931781ce1549dc33b86939' },
  };
  test('a caller that is over its budget is refused before the node or Koios is asked', async () => {
    const spent = new RateLimiter(1);
    spent.check();
    let asked = 0;
    const registered = new Map<string, Tool>();
    registerIdentityFamily(serverOf(registered), 'ledger-read-over-budget', () => { asked += 1; throw new Error('the node must not be asked'); }, spent, () => MAINNET, { access: { koiosUrl: 'https://koios.example', fetchImpl: (async () => { asked += 1; return new Response('[]'); }) as typeof fetch } });
    for (const name of TOOLS) assert.match((await registered.get(name)!.handler(ARGS[name])).content[0].text, /^Rate limit exceeded\. Retry after \d+ms\.$/, name);
    assert.equal(asked, 0);
  });
  test('a server without the identity deployment says what to set, as a failure and not an exception', async () => {
    const { call } = tools({ utxos: [], deployment: () => { throw new IdentityConfigError('The identity registry is not configured on this server: set VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED.'); } });
    for (const name of TOOLS) {
      const answer = await call(name, ARGS[name]);
      assert.match(answer, /^Failed to .*: The identity registry is not configured on this server: set VECTOR_IDENTITY_LEGACY_ROOT/, name);
      assert.match(answer, /\*\*Troubleshooting Tips:\*\*\n1\. The server needs the identity deployment values \(VECTOR_IDENTITY_\*\)/, name);
    }
  });
  test('a Koios that fails is a failure that names the operation and the status, never a URL', async () => {
    const registered = new Map<string, Tool>();
    const koios = ledgerKoios({ status: { credential_utxos: 503, utxo_info: 503, tx_info: 503, tip: 503 } });
    registerIdentityFamily(serverOf(registered), 'ledger-read-koios-down', () => new FixtureProvider(mainnet()), new RateLimiter(100_000), () => MAINNET, { access: { koiosUrl: 'https://koios.example', fetchImpl: koios.f, now: () => CAPTURE_MS } });
    for (const name of ['vector_list_attestations', 'vector_get_vault'] as const) {
      const text = (await registered.get(name)!.handler(ARGS[name])).content[0].text;
      assert.match(text, /^Failed to (list attestations|read the vault): Koios credential_utxos answered 503/, name);
      assert.doesNotMatch(text, /koios\.example/);
      assert.doesNotMatch(text, /Give a subject/, 'a call that gave a subject is not told to give one');
      if (name === 'vector_list_attestations') assert.match(text, /\n\*\*Troubleshooting Tips:\*\*\n1\. .*\n2\. .*\n3\. If 5,000 or more attestation outputs name the subject or the issuer, read one attestation with vector_get_attestation$/);
    }
    assert.ok(callsTo(koios, 'credential_utxos').length === 2);
  });
  test('a node or a Koios that never answers ends each of the six tools at 30 s with a failure that says so; the twin answers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: CAPTURE_MS });
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    // A node whose every request never answers, and a Koios whose every request ends only when it is aborted.
    const hungNode = new Proxy(new FixtureProvider(mainnet()), { get: (target, name) => { const member: unknown = Reflect.get(target, name); return typeof member === 'function' ? () => new Promise(() => {}) : member; } });
    const hungKoios = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const registered = new Map<string, Tool>();
    registerIdentityFamily(serverOf(registered), 'ledger-read-hung', () => hungNode, new RateLimiter(100_000), () => MAINNET, { access: { koiosUrl: 'https://koios.example', fetchImpl: hungKoios, now: () => CAPTURE_MS } });
    for (const name of TOOLS) {
      let answer = '';
      void registered.get(name)!.handler(ARGS[name]).then((r) => { answer = r.content[0].text; });
      await settle();
      assert.equal(answer, '', `${name} waits for the source`);
      t.mock.timers.tick(30_000 - 1);
      await settle();
      assert.equal(answer, '', `${name} waits until the budget is spent`);
      t.mock.timers.tick(1);
      await settle();
      assert.match(answer, /^Failed to .*: The call ran for 30 s and stopped: the node or Koios answers too slowly, or the read needs too many requests\. Retry in a minute\. A list can ask for fewer rows \(limit\)\.\n/, name);
      assert.match(answer, /\*\*Troubleshooting Tips:\*\*\n1\. The server needs the identity deployment values/, name);
    }
    const { call } = tools({ utxos: mainnet() });
    for (const name of TOOLS) assert.doesNotMatch(await call(name, ARGS[name]), /^Failed to/, `${name}: the twin answers`);
  });
  test('every tool takes the time from the clock of the server, and a time that the caller gives wins for the two checks', async () => {
    const { call } = tools({ utxos: mainnet() });
    assert.equal(jsonOf(await call('vector_get_attestation', ARGS.vector_get_attestation)).at, CAPTURE_MS);
    assert.equal(jsonOf(await call('vector_list_attestations', ARGS.vector_list_attestations)).at, CAPTURE_MS);
    assert.equal(jsonOf(await call('vector_get_vault', ARGS.vector_get_vault)).at, CAPTURE_MS);
    assert.equal(jsonOf(await call('vector_check_attestation', { ...ARGS.vector_check_attestation, time: 5 })).at, 5);
    assert.equal(jsonOf(await call('vector_check_delegation_use', { ...ARGS.vector_check_delegation_use, time: 7 })).at, 7);
  });
});
