// packages/builder/test/signature-at-tools.test.ts
// Handler-level tests of vector_verify_signature_at: a minimal fake server that validates the arguments with the zod schema of the tool (as
// the MCP server does) and calls the handler. The first parts give the tool a fake gateway and a fixed clock. The last part registers the
// tool as the server does (registerAgentNetworkTools) and stubs global fetch, so that the real client of the gateway runs: the request that
// it sends, and the answers that it refuses. No network.
import { describe, test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgentNetworkTools } from '../src/vector/agent-network.ts';
import { registerSignatureAtTool } from '../src/vector/signature-at-tools.ts';
import { rateGate } from '../src/vector/marketplace-shared.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { DEFAULT_IDENTITY_GATEWAY_URL } from '../src/vector/identity-gateway.ts';
import type { GatewayAnswer } from '../src/vector/identity-gateway.ts';
import { MAX_MESSAGE_BYTES, MAX_NODE_TIP_AGE_MS, TIME_CLAIM_NOTE } from '../src/vector/signature-at.ts';
import type { SignatureAtAccess } from '../src/vector/signature-at.ts';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { FixtureProvider, FIXTURE_UTXOS } from './fixtures/fixture-provider.ts';
import {
  AT, CONTROLLER, DID, GATEWAY_TIP, LISTED, MESSAGE, NODE_TIP_SLOT, NOW, STRANGER, VECTOR_START_MS,
  answerOf, didDocument, documentAnswer, errorAnswer, fakeGateway, nodeAt, sign, standardDocument,
} from './fixtures/signature-at-world.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
type Tool = { shape: z.ZodRawShape; handler: Handler; description: string };
const serverOf = (into: Map<string, Tool>) => ({
  tool: (name: string, description: string, shape: z.ZodRawShape, handler: Handler) => { into.set(name, { shape, handler, description }); },
}) as unknown as McpServer;

const NAME = 'vector_verify_signature_at';
const args = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ did: DID, message: MESSAGE, signature_hex: sign(LISTED, MESSAGE), key: LISTED.keyHash, at: AT, ...over });
/** A time in the form of the input: UTC, whole seconds. */
const isoOf = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** The JSON block of an answer of the tool, as the tests read it. */
interface AnswerJson {
  verdict: string; valid: boolean; reason: string | null; summary: string; did: string; at: string; purpose: string; detail: string;
  key: { form: string; key_hash: string; public_key: string | null };
  message: { bytes: number; sha256: string };
  asked: boolean; http_status: number | null; tips: { gateway: number | null; node: number | null };
  version: { version_id: string | null; next_version_id: string | null; created: string | null; updated: string | null; next_update: string | null } | null;
  status_at_time: Record<string, string | null> | null;
  status_now: { effective: string | null; effective_reason: string | null; deactivated: boolean; invalid_from: string | null; details: Record<string, string | null> | null; details_read: string };
  listed_keys: Array<{ id: string; type: string; purposes: string[]; given: boolean }>;
  more_keys: number;
  checks: Array<{ id: string; label: string; result: string; reason: string | null; detail: string }>;
  time_note: string;
}
const jsonOf = (answer: string): AnswerJson => JSON.parse(answer.slice(answer.lastIndexOf('```json\n') + 8, answer.lastIndexOf('\n```'))) as AnswerJson;
/** The markdown of a tool answer: everything before the JSON block. */
const markdownOf = (answer: string): string => answer.slice(0, answer.lastIndexOf('```json\n'));
/** Calls a tool through the schema of its input, as the SDK does, and gives the first text of the answer. */
async function callThrough(registeredTool: Tool, input: Record<string, unknown>): Promise<string> {
  const parsed = z.object(registeredTool.shape).safeParse(input);
  if (!parsed.success) return `Input validation error: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  return (await registeredTool.handler(parsed.data as Record<string, unknown>)).content[0].text;
}

/** The tool with a fixed clock, a node at the tip of the gateway with a tip that is not stale, and the given gateway. */
function tool(access: SignatureAtAccess = {}, gate = rateGate(new RateLimiter(100_000))) {
  const registered = new Map<string, Tool>();
  registerSignatureAtTool(serverOf(registered), gate, { now: () => NOW, nodeTip: async () => nodeAt(GATEWAY_TIP), ...access });
  const registeredTool = registered.get(NAME)!;
  return { call: (input: Record<string, unknown>) => callThrough(registeredTool, input), registeredTool, registered };
}
const answering = (...answers: Array<GatewayAnswer | Error>) => tool({ resolve: fakeGateway(...answers).resolve });

describe('the registration', () => {
  test('registers one tool, with a description that states the rule, the three results, the exact behaviour, the time claim and that the tool is read-only', () => {
    const { registered, registeredTool } = tool();
    assert.deepEqual([...registered.keys()], [NAME]);
    for (const part of [
      'The result is VALID only when all of these are true', 'The time is at least 10 minutes before now, and at least 10 minutes before the tip block of the node.', 'The DID has a version at that time.', 'The version has a DID document',
      'The gateway is current: its ledger tip is at most 30 blocks behind the tip of the node.', 'The tip of the node is at most 10 minutes old, so the node is a reference for the tip of the chain.',
      'No invalid-from time lies at or before the time', 'The time lies inside the version',
      'The result is INVALID, with the reason, when a check fails.', 'When the gateway gives nextUpdate, a signature in the exact second of an update is INVALID (ambiguous_second).',
      'The result is NOT CHECKED when the tool cannot decide.', 'less than 10 minutes before the tip block of the node, or in the future (too_recent)', 'fewer than 30 confirmations',
      'more than 30 blocks behind the node (gateway_behind)', 'when the tip of the node is more than 10 minutes old (tip_stale)', 'cannot read a ledger tip (tip_unreadable)',
      '(gateway_error, answer_unreadable)', '(key_type_unsupported)', 'the tool cannot apply the nextUpdate check then (next_update_missing)',
      'When the gateway gives no nextUpdate, a signature at a time before the latest version gives NOT CHECKED (next_update_missing).',
      'The controller key counts only when the DID lists it for the purpose', 'raw Ed25519 signature of 64 bytes', 'It has no COSE or JWS wrapper',
      'The time is the claim of the caller. The tool cannot prove when the signature was made', 'for example a transaction',
      'A signature that was made before the invalid-from time stays valid', 'Read-only: the tool builds and signs nothing.',
    ]) assert.ok(registeredTool.description.includes(part), part);
    assert.ok(!registeredTool.description.includes('Today'), 'the text does not depend on the day: no sentence about what the gateway gives now');
    assert.ok(!registeredTool.description.includes('only after 30 confirmations'), 'the text of the old note about recent times is gone');
    assert.ok(!registeredTool.description.includes('same second as an update is not VALID'), 'the text states the exact second rule');
  });

  test('is one of the tools of the agent identity family: the server registers it with the other read tools of the gateway', () => {
    const handlers = new Map<string, Tool>();
    registerAgentNetworkTools(serverOf(handlers), 'signature-at-test', () => new FixtureProvider(FIXTURE_UTXOS), new RateLimiter(100_000));
    assert.deepEqual([...handlers.keys()], ['vector_resolve_did', NAME, 'vector_get_agent_profile', 'vector_discover_agents', 'vector_build_deregister_agent']);
  });

  test('the input schema takes the canonical DID, one message, a signature of 64 bytes, a key in three forms, two purposes and a time in whole seconds', async () => {
    const { registeredTool, call } = tool();
    const schema = z.object(registeredTool.shape);
    const accepts = (over: Record<string, unknown>): boolean => schema.safeParse(args(over)).success;
    assert.ok(accepts({}));
    assert.ok(accepts({ key: LISTED.publicKey }));
    assert.ok(accepts({ key: `${DID}#${LISTED.keyHash}` }));
    assert.ok(accepts({ purpose: 'authentication' }));
    assert.ok(accepts({ message: undefined, message_hex: 'ab'.repeat(MAX_MESSAGE_BYTES) }));
    assert.ok(accepts({ message: 'a'.repeat(MAX_MESSAGE_BYTES) }));
    for (const bad of [
      { did: 'did:vector:abc' }, { did: DID.toUpperCase() }, { did: `did:vector:agent:${'ab'.repeat(28)}:${'cd'.repeat(32)}` }, { did: 'ab'.repeat(32) },
      { signature_hex: 'ab'.repeat(63) }, { signature_hex: 'zz'.repeat(64) }, { key: 'ab'.repeat(30) }, { key: `${DID}#abc` }, { key: '' },
      { purpose: 'capabilityInvocation' }, { purpose: 'capabilityDelegation' }, { purpose: 'assertion' },
      { at: '2026-11-03T15:56:00.5Z' }, { at: '2026-11-03T15:56:00+00:00' }, { at: 'yesterday' }, { at: 20261103 },
      { message: 'a'.repeat(MAX_MESSAGE_BYTES + 1) }, { message: undefined, message_hex: 'ab'.repeat(MAX_MESSAGE_BYTES + 1) }, { message: undefined, message_hex: 'abc' },
    ]) assert.equal(accepts(bad), false, JSON.stringify(bad).slice(0, 80));
    assert.match(await call(args({ at: 'yesterday' })), /^Input validation error: at: expected YYYY-MM-DDThh:mm:ssZ/);
    assert.match(z.globalRegistry.get(registeredTool.shape.at)?.description ?? '', /at least 10 minutes before now and before the tip block of the node/);
  });
});

describe('the answer', () => {
  test('VALID: the facts of the version, the status now, each check, the keys of the version, the digest of the message and the fixed sentence', async () => {
    const gateway = fakeGateway(documentAnswer());
    const text = await tool({ resolve: gateway.resolve }).call(args());
    assert.match(text, /^# Signature Check at a Time: VALID\n/);
    assert.match(text, /\*\*Result:\*\* VALID\. The signature verifies with the key #[0-9a-f]{56}\. Version 5 of the DID listed the key for assertionMethod, and the DID was active at 2026-11-03T15:56:00Z\./);
    assert.ok(text.includes(`**DID:** ${DID}\n`));
    assert.ok(text.includes('**Time (the claim of the caller):** 2026-11-03T15:56:00Z\n'));
    assert.ok(text.includes('**Purpose:** assertionMethod\n'));
    assert.ok(text.includes(`**Key:** \`#${LISTED.keyHash}\` (given as a key hash), Ed25519 public key in the document \`${LISTED.publicKey}\`\n`));
    assert.match(text, new RegExp(`\\*\\*Message:\\*\\* ${Buffer.byteLength(MESSAGE)} bytes, SHA-256 \`[0-9a-f]{64}\`\\n`));
    assert.ok(text.includes('**Gateway answer:** HTTP 200, DID document: yes\n'));
    assert.ok(text.includes('**Version used:** version 5; created 2026-11-03T15:37:54Z; updated 2026-11-03T15:53:53Z; next update 2026-11-03T15:56:44Z; next version 6\n'));
    assert.ok(text.includes('**Status in that version:** active\n'));
    assert.ok(text.includes('**Status now:** active.\n'));
    assert.equal((text.match(/\| (?:pass|fail|unknown|not applicable) \|/g) ?? []).length, 10, 'ten checks');
    assert.equal((text.match(/\| pass \|/g) ?? []).length, 10);
    assert.ok(text.includes(`**Ledger tips:** gateway block ${GATEWAY_TIP}, node block ${GATEWAY_TIP} (the gateway is not behind)\n`));
    assert.ok(text.includes(`- \`#${CONTROLLER.keyHash}\`: Ed25519, capabilityInvocation\n`));
    assert.ok(text.includes(`- \`#${LISTED.keyHash}\`: Ed25519, authentication, assertionMethod (the key that you gave)\n`));
    assert.equal(markdownOf(text).split(TIME_CLAIM_NOTE).length, 2, 'the fixed sentence is there once, and the JSON block carries it too');
    assert.deepEqual(gateway.calls, [{ did: DID, options: { versionTime: AT } }]);
    const json = jsonOf(text);
    assert.equal(json.verdict, 'valid');
    assert.equal(json.valid, true);
    assert.equal(json.reason, null);
    assert.equal(json.did, DID);
    assert.equal(json.at, AT);
    assert.equal(json.purpose, 'assertionMethod');
    assert.deepEqual(json.key, { form: 'key_hash', key_hash: LISTED.keyHash, public_key: LISTED.publicKey });
    assert.deepEqual(json.version, { version_id: '5', next_version_id: '6', created: '2026-11-03T15:37:54Z', updated: '2026-11-03T15:53:53Z', next_update: '2026-11-03T15:56:44Z' });
    assert.deepEqual(json.status_at_time, { status: 'active', effective: 'active', effective_reason: null, reason: null, at: null, invalid_from: null });
    assert.deepEqual(json.status_now, { effective: 'active', effective_reason: null, deactivated: false, invalid_from: null, details: null, details_read: 'not_needed' });
    assert.equal(json.http_status, 200);
    assert.equal(json.asked, true);
    assert.deepEqual(json.tips, { gateway: GATEWAY_TIP, node: GATEWAY_TIP });
    assert.deepEqual(json.checks.map((c: { id: string }) => c.id), ['time_age', 'version', 'document', 'gateway_current', 'version_window', 'status', 'invalid_from', 'key_listed', 'key_matches', 'signature']);
    assert.equal(json.listed_keys.length, 3);
    assert.equal(json.time_note, TIME_CLAIM_NOTE);
  });

  test('INVALID: a random signature, with the failed check, the reason and the version that was used', async () => {
    const text = await answering(documentAnswer()).call(args({ signature_hex: 'ab'.repeat(64) }));
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.match(text, /\*\*Result:\*\* INVALID\. The Ed25519 signature does not verify over the message with the listed key\./);
    assert.equal((text.match(/\| fail \|/g) ?? []).length, 1);
    assert.ok(text.includes('**Version used:** version 5;'));
    assert.equal(markdownOf(text).split(TIME_CLAIM_NOTE).length, 2);
    const json = jsonOf(text);
    assert.equal(json.verdict, 'invalid');
    assert.equal(json.valid, false);
    assert.equal(json.reason, 'signature_mismatch');
  });

  test('INVALID: a signature in the second of the next update: the result names the second, and the signature itself is fine', async () => {
    const text = await answering(documentAnswer()).call(args({ at: '2026-11-03T15:56:44Z' }));
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.match(text, /\*\*Result:\*\* INVALID\. The DID changed at 2026-11-03T15:56:44Z, in the same second as the signature \(the next update equals the time\)\./);
    assert.equal(jsonOf(text).reason, 'ambiguous_second');
    assert.equal((text.match(/\| pass \|/g) ?? []).length, 9);
  });

  test('NOT CHECKED: a gateway that names a later version and gives no next update: the answer says that the tool cannot apply the nextUpdate check', async () => {
    const text = await answering(documentAnswer({ nextUpdate: undefined })).call(args());
    assert.match(text, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.match(text, /\*\*Result:\*\* NOT CHECKED\. The gateway did not give nextUpdate, so the tool cannot apply the nextUpdate check\. The DID has a later version \(version 6\), and the gateway did not give its time\./);
    assert.ok(text.includes('**Version used:** version 5; created 2026-11-03T15:37:54Z; updated 2026-11-03T15:53:53Z; next update not given: the gateway did not give it; next version 6\n'));
    assert.ok(text.includes('| unknown |'));
    assert.equal((text.match(/\| pass \|/g) ?? []).length, 9);
    const json = jsonOf(text);
    assert.equal(json.verdict, 'not_checked');
    assert.equal(json.valid, false);
    assert.equal(json.reason, 'next_update_missing');
    assert.equal(json.version!.next_update, null);
    assert.equal(markdownOf(text).split(TIME_CLAIM_NOTE).length, 2);
  });

  test('a gateway that gives no next update, for a signature that does not verify: INVALID, with the unknown check in the table', async () => {
    const text = await answering(documentAnswer({ nextUpdate: undefined })).call(args({ signature_hex: 'ab'.repeat(64) }));
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.equal(jsonOf(text).reason, 'signature_mismatch');
    assert.ok(text.includes('| unknown |'));
  });

  test('a DID with no later version: the check of the next update passes by the absence of a later version, and the answer says what it cannot see', async () => {
    const text = await answering(documentAnswer({ nextVersionId: undefined, nextUpdate: undefined })).call(args());
    assert.match(text, /^# Signature Check at a Time: VALID\n/);
    assert.ok(text.includes('**Version used:** version 5; created 2026-11-03T15:37:54Z; updated 2026-11-03T15:53:53Z; next update not given: the gateway did not give it\n'));
    assert.match(text, /The gateway shows no later version\. A later version with fewer than 30 confirmations is not visible\./);
  });

  test('INVALID: the DID did not exist at that time: no version, and the checks after the first one did not run', async () => {
    const text = await answering(errorAnswer(404, 'NOT_FOUND', 'DID not found: no confirmed version at the requested time')).call(args({ at: '2026-11-03T15:00:00Z' }));
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.ok(text.includes('**Version used:** none: the gateway has no confirmed version of the DID at that time\n'));
    assert.ok(text.includes('**Gateway answer:** HTTP 404, DID document: no\n'));
    assert.ok(text.includes('**Status in that version:** not given by the gateway\n'));
    assert.equal((text.match(/\| not applicable \|/g) ?? []).length, 8);
    const json = jsonOf(text);
    assert.equal(json.reason, 'did_not_found');
    assert.equal(json.version!.version_id, null);
    assert.equal(json.status_at_time, null);
    assert.deepEqual(json.listed_keys, []);
    assert.ok(!text.includes('**Keys that this version lists:**'));
  });

  test('INVALID: a DID that is revoked now, with the document of the time: the version, the revocation and the invalid-from time are shown', async () => {
    const first = documentAnswer({
      created: '2026-11-18T19:32:28Z', versionId: '1', updated: '2026-11-18T19:38:49Z', nextVersionId: '2', nextUpdate: '2026-11-18T20:14:09Z', deactivated: true,
      vectorCurrent: { effective: 'revoked' }, vectorStatus: { status: 'active', effective: 'active', invalidFrom: '2026-11-19T00:00:00Z' },
    }, didDocument([{ key: CONTROLLER, purposes: ['capabilityInvocation', 'capabilityDelegation'] }]), 410);
    const second = answerOf(410, { didDocumentMetadata: { versionId: '2', deactivated: true, vectorStatus: { status: 'revoked', effective: 'revoked', reason: 'keyCompromise', at: '2026-11-18T20:09:54Z', invalidFrom: '2026-11-19T00:00:00Z' } } });
    const gateway = fakeGateway(first, second);
    const text = await tool({ resolve: gateway.resolve }).call(args({ key: CONTROLLER.keyHash, signature_hex: sign(CONTROLLER, MESSAGE), at: '2026-11-18T19:47:03Z' }));
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.match(text, /The version lists the key, but not for assertionMethod\. It lists the key for: capabilityInvocation, capabilityDelegation\./);
    assert.ok(text.includes('**Gateway answer:** HTTP 410, DID document: yes\n'));
    assert.ok(text.includes('**Version used:** version 1; created 2026-11-18T19:32:28Z; updated 2026-11-18T19:38:49Z; next update 2026-11-18T20:14:09Z; next version 2\n'));
    assert.ok(text.includes('**Status now:** revoked. The DID is deactivated now. The record says: record status revoked, reason keyCompromise, at 2026-11-18T20:09:54Z. Invalid-from time: 2026-11-19T00:00:00Z. A signature that was made before it stays valid. A signature at or after it is invalid.\n'));
    assert.deepEqual(gateway.calls.map((c) => c.options), [{ versionTime: '2026-11-18T19:47:03Z' }, {}]);
    assert.deepEqual(jsonOf(text).status_now.details, { status: 'revoked', effective: 'revoked', effective_reason: null, reason: 'keyCompromise', at: '2026-11-18T20:09:54Z', invalid_from: '2026-11-19T00:00:00Z' });
    assert.equal(jsonOf(text).status_now.details_read, 'second_read');
  });

  test('the second read can fail: the answer says that the details are not available, and keeps its result', async () => {
    const first = documentAnswer({ deactivated: true, vectorCurrent: { effective: 'revoked' } }, standardDocument(), 410);
    const text = await answering(first, new Error('the identity gateway could not be reached')).call(args());
    assert.match(text, /^# Signature Check at a Time: VALID\n/);
    assert.ok(text.includes('**Status now:** revoked. The DID is deactivated now. The gateway did not give the revocation details. vector_resolve_did { did } shows them.\n'));
    assert.equal(jsonOf(text).status_now.details_read, 'not_available');
    assert.equal(jsonOf(text).status_now.details, null);
  });

  test('NOT CHECKED: an error of the gateway, and an answer that is not complete, each with its reason', async () => {
    const error = await answering(errorAnswer(500, 'INTERNAL_ERROR', 'Koios failed')).call(args());
    assert.match(error, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.match(error, /\*\*Result:\*\* NOT CHECKED\. The gateway answered HTTP 500 with an error \(INTERNAL_ERROR: Koios failed\), so the tool cannot decide\./);
    assert.ok(error.includes('**Version used:** not known: the gateway gave no version that the tool can use\n'));
    assert.equal(jsonOf(error).verdict, 'not_checked');
    assert.equal(jsonOf(error).valid, false);
    assert.equal(jsonOf(error).reason, 'gateway_error');
    assert.equal(markdownOf(error).split(TIME_CLAIM_NOTE).length, 2);
    const unfinished = await answering(documentAnswer({ vectorStatus: undefined })).call(args());
    assert.equal(jsonOf(unfinished).reason, 'answer_unreadable');
    assert.equal(jsonOf(unfinished).valid, false);
  });

  test('NOT CHECKED: a time of the last ten minutes, or in the future: the answer says that nobody was asked, and the gateway and the node get no request', async () => {
    const gateway = fakeGateway(documentAnswer());
    const nodeReads: number[] = [];
    const clock = (iso: string) => tool({ resolve: gateway.resolve, now: () => Date.parse(iso), nodeTip: async () => { nodeReads.push(1); return nodeAt(GATEWAY_TIP, Date.parse(iso) - 5_000); } });
    const recent = await clock('2026-11-03T16:00:00Z').call(args());
    assert.match(recent, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.match(recent, /\*\*Result:\*\* NOT CHECKED\. The time is less than 10 minutes before now\. A change after the time can still have fewer than 30 confirmations, and the gateway does not show it, so the tool cannot decide\./);
    assert.ok(recent.includes('**Gateway answer:** not asked: the time is too recent\n'));
    assert.ok(recent.includes('**Version used:** not known: the gateway was not asked\n'));
    assert.ok(!recent.includes('**Ledger tips:**'));
    assert.equal((recent.match(/\| unknown \|/g) ?? []).length, 1);
    assert.equal((recent.match(/\| not applicable \|/g) ?? []).length, 9);
    const json = jsonOf(recent);
    assert.deepEqual([json.verdict, json.valid, json.reason, json.asked, json.http_status, json.version], ['not_checked', false, 'too_recent', false, null, null]);
    assert.deepEqual(json.tips, { gateway: null, node: null });
    assert.equal(markdownOf(recent).split(TIME_CLAIM_NOTE).length, 2);
    const future = await clock('2026-11-03T15:00:00Z').call(args());
    assert.match(future, /\*\*Result:\*\* NOT CHECKED\. The time is in the future\. A signature cannot be made in the future, so the tool cannot decide\./);
    assert.equal(jsonOf(future).reason, 'too_recent');
    assert.deepEqual([gateway.calls.length, nodeReads.length], [0, 0]);
    assert.doesNotMatch(await answering(documentAnswer()).call(args()), /less than 10 minutes/);
  });

  test('the edge of the age: exactly ten minutes before now is checked, and one second less is not', async () => {
    const run = (iso: string) => tool({ resolve: fakeGateway(documentAnswer()).resolve, now: () => Date.parse(iso), nodeTip: async () => nodeAt(GATEWAY_TIP, Date.parse(iso)) }).call(args());
    assert.match(await run('2026-11-03T16:06:00Z'), /^# Signature Check at a Time: VALID\n/);
    assert.equal(jsonOf(await run('2026-11-03T16:05:59Z')).reason, 'too_recent');
  });

  test('NOT CHECKED: a time that is less than 10 minutes before the tip block of the node, though it is 10 minutes before now: the answer says so, and a time 5 seconds earlier is VALID', async () => {
    const latestAnswer = documentAnswer({ nextVersionId: undefined, nextUpdate: undefined });
    // The tool of these tests has a node tip that is 5 seconds before NOW, so the time must be 605 seconds before NOW.
    const run = (atMs: number) => tool({ resolve: fakeGateway(latestAnswer).resolve }).call(args({ at: isoOf(atMs) }));
    const recent = await run(NOW - 600_000);
    assert.match(recent, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.ok(recent.includes('**Result:** NOT CHECKED. The time is less than 10 minutes before the tip block of the node, or after it.'));
    assert.ok(recent.includes('**Gateway answer:** HTTP 200, DID document: yes\n'));
    assert.ok(recent.includes('The time is at least 10 minutes before now and before the tip block of the node | unknown |'));
    assert.equal(jsonOf(recent).reason, 'too_recent');
    assert.equal(jsonOf(recent).asked, true);
    assert.match(await run(NOW - 605_000), /^# Signature Check at a Time: VALID\n/);
  });

  test('NOT CHECKED: a gateway that is more than 30 blocks behind the node: the answer names both ledger tips, and 30 blocks is still current', async () => {
    const text = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: async () => nodeAt(GATEWAY_TIP + 31) }).call(args());
    assert.match(text, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.ok(text.includes(`**Result:** NOT CHECKED. The gateway is 31 blocks behind the node: the tip of the gateway is block ${GATEWAY_TIP}, and the tip of the node is block ${GATEWAY_TIP + 31}.`));
    assert.ok(text.includes(`**Ledger tips:** gateway block ${GATEWAY_TIP}, node block ${GATEWAY_TIP + 31} (the gateway is 31 blocks behind)\n`));
    assert.equal(jsonOf(text).reason, 'gateway_behind');
    assert.deepEqual(jsonOf(text).tips, { gateway: GATEWAY_TIP, node: GATEWAY_TIP + 31 });
    assert.equal((text.match(/\| unknown \|/g) ?? []).length, 1);
    assert.equal((text.match(/\| pass \|/g) ?? []).length, 9);
    const edge = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: async () => nodeAt(GATEWAY_TIP + 30) }).call(args());
    assert.match(edge, /^# Signature Check at a Time: VALID\n/);
    assert.ok(edge.includes('(the gateway is 30 blocks behind)'));
  });

  test('NOT CHECKED: a node that cannot be read, and a gateway that gives no ledger tip: the answer says which tip is not known', async () => {
    const noNode = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: async () => { throw new Error('Ogmios network error'); } }).call(args());
    assert.ok(noNode.includes('**Result:** NOT CHECKED. The tool could not read the tip of the node (the read of the node failed or took too long), so it cannot tell whether the gateway is current. The tool cannot decide.'));
    assert.ok(noNode.includes(`**Ledger tips:** gateway block ${GATEWAY_TIP}, node not known\n`));
    assert.equal(jsonOf(noNode).reason, 'tip_unreadable');
    assert.deepEqual(jsonOf(noNode).tips, { gateway: GATEWAY_TIP, node: null });
    const noGateway = await answering(documentAnswer({ vectorLedger: undefined })).call(args());
    assert.match(noGateway, /\*\*Result:\*\* NOT CHECKED\. The gateway answer does not give the ledger tip of the gateway/);
    assert.ok(noGateway.includes(`**Ledger tips:** gateway not known, node block ${GATEWAY_TIP}\n`));
    assert.deepEqual(jsonOf(noGateway).tips, { gateway: null, node: GATEWAY_TIP });
    const noProvider = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: undefined }).call(args());
    assert.equal(jsonOf(noProvider).reason, 'tip_unreadable');
  });

  test('a signature that does not verify next to a gateway that is behind: INVALID, with the unknown check in the table', async () => {
    const text = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: async () => nodeAt(GATEWAY_TIP + 500) }).call(args({ signature_hex: 'ab'.repeat(64) }));
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.equal(jsonOf(text).reason, 'signature_mismatch');
    assert.ok(text.includes('| unknown |'));
  });

  test('NOT CHECKED: a node tip that is older than 10 minutes: the answer says how old it is, and exactly 10 minutes is still current', async () => {
    const stale = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: async () => nodeAt(GATEWAY_TIP, NOW - MAX_NODE_TIP_AGE_MS - 1000) }).call(args());
    assert.match(stale, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.ok(stale.includes(`**Result:** NOT CHECKED. The tip of the node (block ${GATEWAY_TIP}) is 601 seconds old. The limit is 600 seconds.`));
    assert.equal(jsonOf(stale).reason, 'tip_stale');
    assert.equal(jsonOf(stale).valid, false);
    assert.equal((stale.match(/\| unknown \|/g) ?? []).length, 1);
    assert.equal((stale.match(/\| pass \|/g) ?? []).length, 9);
    assert.ok(stale.includes('The tip of the node is at most 10 minutes old, and the ledger tip of the gateway is at most 30 blocks behind it | unknown |'));
    const edge = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: async () => nodeAt(GATEWAY_TIP, NOW - MAX_NODE_TIP_AGE_MS) }).call(args());
    assert.match(edge, /^# Signature Check at a Time: VALID\n/);
  });

  test('a signature that does not verify next to a stale node tip: INVALID, with the unknown check in the table', async () => {
    const text = await tool({ resolve: fakeGateway(documentAnswer()).resolve, nodeTip: async () => nodeAt(GATEWAY_TIP, NOW - MAX_NODE_TIP_AGE_MS - 1) }).call(args({ signature_hex: 'ab'.repeat(64) }));
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.equal(jsonOf(text).reason, 'signature_mismatch');
    assert.ok(text.includes('| unknown |'));
  });

  test('NOT CHECKED: a version id that is not a whole number, a method that is not a Multikey of the DID, and a status that disagrees: each with its sentence', async () => {
    const version = await answering(documentAnswer({ versionId: 5 })).call(args());
    assert.match(version, /\*\*Result:\*\* NOT CHECKED\. The gateway answer gives no version id that is a whole number, so the tool cannot decide\./);
    assert.equal(jsonOf(version).reason, 'answer_unreadable');
    const doc = standardDocument();
    (doc.verificationMethod as Array<Record<string, unknown>>)[1].type = 'JsonWebKey2020';
    assert.match(await answering(documentAnswer({}, doc)).call(args()), /is not a Multikey method of this DID/);
    const status = await answering(documentAnswer({ vectorStatus: { status: 'revoked', effective: 'active' } })).call(args());
    assert.match(status, /The status and the effective status of the version do not agree/);
    assert.equal(jsonOf(status).reason, 'answer_unreadable');
  });

  test('the keys of a version are listed, the key that was given is marked, and a long list is cut', async () => {
    const doc = standardDocument();
    const methods = doc.verificationMethod as Array<Record<string, unknown>>;
    for (let i = 0; i < 40; i += 1) methods.push({ id: `${DID}#${i.toString(16).padStart(56, '0')}`, type: 'Multikey', controller: DID, publicKeyMultibase: 'z1' });
    const text = await answering(documentAnswer({}, doc)).call(args());
    assert.equal((text.match(/^- `#/gm) ?? []).length, 16, 'sixteen keys');
    assert.ok(text.includes('- and 27 more'));
    assert.equal(jsonOf(text).listed_keys.length, 16);
    assert.equal(jsonOf(text).more_keys, 27);
  });
});

describe('what the tool refuses before it asks the gateway', () => {
  test('each input that is wrong is refused with a sentence that names it, and the gateway is not asked', async () => {
    const gateway = fakeGateway(documentAnswer());
    const { call } = tool({ resolve: gateway.resolve });
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ message: undefined }, /^# Signature Check Refused\n\nThe tool did not check the signature\. message: give the signed message as message \(UTF-8 text\) or as message_hex\./],
      [{ message_hex: '00' }, /message: give message or message_hex, not both/],
      [{ message: '' }, /message: the message is empty/],
      [{ message: 'a\ud800' }, /message: the text is not valid Unicode/],
      [{ key: `did:vector:${'d2'.repeat(32)}#${LISTED.keyHash}` }, /key: the verification method id names another DID than did/],
      [{ at: '2026-02-30T00:00:00Z' }, /at: expected a real date and time/],
    ];
    for (const [over, expected] of cases) {
      const text = await call(args(over));
      assert.match(text, expected, JSON.stringify(over));
      const json = jsonOf(text);
      assert.equal(json.verdict, 'not_checked');
      assert.equal(json.valid, false);
      assert.equal(json.reason, 'input_refused');
      assert.doesNotMatch(text, /\bVALID\b/);
    }
    assert.equal(gateway.calls.length, 0);
  });

  test('is rate limited before anything else', async () => {
    const gateway = fakeGateway(documentAnswer());
    const limited = tool({ resolve: gateway.resolve }, rateGate({ check: () => ({ allowed: false, retryAfterMs: 1234 }) }));
    assert.equal(await limited.call(args()), 'Rate limit exceeded. Retry after 1234ms.');
    assert.equal(await limited.call(args({ message: undefined })), 'Rate limit exceeded. Retry after 1234ms.');
    assert.equal(gateway.calls.length, 0);
  });
});

describe('what the tool says when there is no answer to decide from', () => {
  test('a gateway that cannot be reached gives a failure text, never a result', async () => {
    const text = await answering(new Error('the identity gateway could not be reached (network error or timeout)')).call(args());
    assert.match(text, /^Failed to check the signature: the identity gateway could not be reached \(network error or timeout\)\n\n\*\*Troubleshooting Tips:\*\*\n1\. The identity gateway may be unreachable; retry in a minute\n2\. vector_resolve_did \{ did, versionTime \} shows/);
    assert.doesNotMatch(text, /\bVALID\b|NOT CHECKED/);
  });

  test('a failure that is not an Error is still a failure text', async () => {
    const text = await tool({ resolve: async () => { throw 'a plain text'; } }).call(args());
    assert.match(text, /^Failed to check the signature: a plain text\n/);
  });
});

describe('text of the gateway in the answer', () => {
  test('a text that tries to add a heading, a code block, a table row or hidden characters is cleaned, in the markdown and in the JSON', async () => {
    const evil = 'x\n# Injected heading\n```\n| a | b |\n\u202e\u200bend';
    const doc = standardDocument();
    (doc.verificationMethod as Array<Record<string, unknown>>).push({ id: `${DID}#${evil}`, type: 'Multikey', controller: DID, publicKeyMultibase: 'z1' });
    const answer = documentAnswer({
      versionId: evil, nextVersionId: evil, created: evil, updated: evil, nextUpdate: evil, vectorCurrent: { effective: evil, effectiveReason: evil },
      vectorStatus: { status: evil, effective: 'suspended', effectiveReason: evil, reason: evil, at: evil, invalidFrom: '2026-11-03T15:56:01Z' },
    }, doc);
    const text = await answering(answer).call(args());
    assert.doesNotMatch(text, /^# Injected/m);
    assert.doesNotMatch(text, /^\| a \| b \|/m);
    assert.doesNotMatch(text, /[\u202e\u200b]/);
    assert.equal((text.match(/```/g) ?? []).length, 2, 'only the fence of the JSON block');
    assert.ok(text.split('\n').every((line) => !line.startsWith('# ') || line.startsWith('# Signature Check at a Time')));
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk({ ...jsonOf(text), key: undefined, message: undefined, did: undefined, time_note: undefined });
    assert.ok(strings.length > 10, 'the walk reached the facts');
    for (const s of strings) assert.doesNotMatch(s, /[\n\r`|\u202e\u200b]/, s.slice(0, 40));
  });

  test('an error title of the gateway is cleaned too', async () => {
    const evil = 'Koios failed\n# Injected `x` | y';
    const text = await answering(errorAnswer(500, 'INTERNAL_ERROR', evil)).call(args());
    assert.doesNotMatch(text, /^# Injected/m);
    assert.match(text, /INTERNAL_ERROR: Koios failed # Injected 'x' ¦ y\)/);
  });
});

// ─── The real client of the gateway ────────────────────────────────────────────────────────────────────────────────────────────

describe('with the real client of the gateway', () => {
  interface Answer { status?: number; body?: string; fails?: Error }
  /**
   * What the stub of fetch gives for the node: `height` is the result of queryNetwork/blockHeight, `tip` is the result of queryNetwork/tip,
   * and queryNetwork/startTime always gives the start of Vector mainnet. `status` and `fails` make every request of the node fail.
   */
  interface NodeAnswer { height?: unknown; tip?: unknown; status?: number; fails?: Error }
  const RpcRequest = z.object({ jsonrpc: z.string(), method: z.string(), params: z.unknown(), id: z.unknown() });
  const OGMIOS_URL = 'https://ogmios.test.example';
  const SUBMIT_URL = 'https://submit.test.example/api/submit/tx';
  const START_TIME = new Date(VECTOR_START_MS).toISOString();
  /** A node at the tip of the gateway, with a tip block 5 seconds before NOW. */
  const nodeDefault = (): NodeAnswer => ({ height: GATEWAY_TIP, tip: { slot: NODE_TIP_SLOT, id: 'ee'.repeat(32) } });
  /** A node whose tip block is `age` milliseconds before NOW. */
  const nodeOfAge = (age: number): NodeAnswer => ({ height: GATEWAY_TIP, tip: { slot: (NOW - age - VECTOR_START_MS) / 1000, id: 'ee'.repeat(32) } });
  let requested: Array<{ url: string; accept: string | null }> = [];
  let nodeRequested: Array<z.infer<typeof RpcRequest>> = [];
  let node: NodeAnswer = nodeDefault();
  const realFetch = globalThis.fetch;
  before(() => { delete process.env.VECTOR_IDENTITY_GATEWAY_URL; });
  afterEach(() => { globalThis.fetch = realFetch; requested = []; nodeRequested = []; node = nodeDefault(); });
  /** Global fetch answers the node with `node`, and the gateway with the given answers one after the other (the last one again and again). */
  function stub(...answers: Answer[]): void {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === OGMIOS_URL) {
        const request = RpcRequest.parse(JSON.parse(String(init?.body)));
        nodeRequested.push(request);
        if (node.fails) throw node.fails;
        const result = request.method === 'queryNetwork/blockHeight' ? node.height : request.method === 'queryNetwork/tip' ? node.tip : request.method === 'queryNetwork/startTime' ? START_TIME : undefined;
        return new Response(JSON.stringify({ jsonrpc: '2.0', method: request.method, result, id: null }), { status: node.status ?? 200 });
      }
      requested.push({ url: String(input), accept: new Headers(init?.headers).get('accept') });
      const answer = answers[Math.min(requested.length - 1, answers.length - 1)];
      if (answer.fails) throw answer.fails;
      return new Response(answer.body ?? '', { status: answer.status ?? 200 });
    }) as typeof fetch;
  }
  /** The tool as the server registers it, behind the fake server of the family, with a node (Ogmios) at a fixed address and a fixed clock. */
  function registered(): (input: Record<string, unknown>) => Promise<string> {
    const handlers = new Map<string, Tool>();
    registerAgentNetworkTools(serverOf(handlers), 'signature-at-real-client', () => new OgmiosProvider({ ogmiosUrl: OGMIOS_URL, submitUrl: SUBMIT_URL }), new RateLimiter(100_000), { now: () => NOW });
    return (input) => callThrough(handlers.get(NAME)!, input);
  }

  test('sends one GET with the resolution media type and the time as versionTime, and decides from the answer', async () => {
    stub({ status: 200, body: documentAnswer().body });
    const text = await registered()(args());
    assert.deepStrictEqual(requested, [{ url: `${DEFAULT_IDENTITY_GATEWAY_URL}/1.0/identifiers/${DID}?versionTime=2026-11-03T15%3A56%3A00Z`, accept: 'application/did-resolution' }]);
    // The chain clock of the server is set once for the process (queryNetwork/startTime), so the start time is read in the first call only.
    assert.deepStrictEqual(nodeRequested.filter((r) => r.method !== 'queryNetwork/startTime'), [
      { jsonrpc: '2.0', method: 'queryNetwork/blockHeight', params: {}, id: null },
      { jsonrpc: '2.0', method: 'queryNetwork/tip', params: {}, id: null },
    ], 'one read of the block height and one read of the tip of the node');
    assert.match(text, /^# Signature Check at a Time: VALID\n/);
  });

  test('a DID that is deactivated now: a second GET without a time', async () => {
    stub({ status: 410, body: documentAnswer({ deactivated: true, vectorCurrent: { effective: 'revoked' } }, standardDocument(), 410).body },
      { status: 410, body: answerOf(410, { didDocumentMetadata: { deactivated: true, vectorStatus: { status: 'revoked', effective: 'revoked', reason: 'privilegeWithdrawn', at: '2026-11-18T20:09:54Z' } } }).body });
    const text = await registered()(args());
    assert.deepStrictEqual(requested.map((r) => r.url), [
      `${DEFAULT_IDENTITY_GATEWAY_URL}/1.0/identifiers/${DID}?versionTime=2026-11-03T15%3A56%3A00Z`,
      `${DEFAULT_IDENTITY_GATEWAY_URL}/1.0/identifiers/${DID}`,
    ]);
    assert.match(text, /^# Signature Check at a Time: VALID\n/);
    assert.match(text, /reason privilegeWithdrawn, at 2026-11-18T20:09:54Z/);
  });

  test('an answer that is no result, an answer that is too large and a network failure give a failure text that names no gateway', async () => {
    const cases: Array<[Answer, RegExp]> = [
      [{ fails: new TypeError(`fetch failed ${DEFAULT_IDENTITY_GATEWAY_URL}`) }, /could not be reached \(network error or timeout\)/],
      [{ status: 502, body: '<html>bad gateway id.vector.apexfusion.org</html>' }, /answered HTTP 502 without a resolution result/],
      [{ status: 200, body: '{"status":"ok"}' }, /answered HTTP 200 with JSON that is not a DID resolution result/],
      [{ status: 200, body: '[]' }, /not a DID resolution result/],
      [{ status: 200, body: 'null' }, /not a DID resolution result/],
      [{ status: 200, body: 'x'.repeat(1024 * 1024 + 1) }, /answer is over 1048576 bytes/],
      [{ status: 200, body: '' }, /without a resolution result/],
      [{ status: 200, body: `{"didDocument":${'['.repeat(100_000)}` }, /without a resolution result/],
    ];
    for (const [answer, expected] of cases) {
      stub(answer);
      const text = await registered()(args());
      assert.match(text, /^Failed to check the signature: /);
      assert.match(text, expected);
      assert.doesNotMatch(text, /id\.vector\.apexfusion\.org/, text);
      assert.doesNotMatch(text, /\bVALID\b/);
    }
  });

  test('a resolution result that is not complete or not well formed gives a result that is not VALID, and no crash', async () => {
    const bodies = [
      '{"didDocument":null,"didResolutionMetadata":{},"didDocumentMetadata":{}}',
      '{"didDocument":{},"didResolutionMetadata":{},"didDocumentMetadata":{}}',
      JSON.stringify({ didDocument: { id: DID, verificationMethod: 'x', assertionMethod: 7 }, didResolutionMetadata: {}, didDocumentMetadata: { vectorStatus: { effective: 'active' } } }),
      JSON.stringify({ didDocument: { id: DID, verificationMethod: [null, 1, { id: 5 }, { id: `${DID}#${LISTED.keyHash}`, publicKeyMultibase: {} }], assertionMethod: [[`#${LISTED.keyHash}`]] }, didResolutionMetadata: {}, didDocumentMetadata: { vectorStatus: { effective: 'active' } } }),
      JSON.stringify({ didDocument: null, didResolutionMetadata: { error: 'x' }, didDocumentMetadata: [] }),
      JSON.stringify({ didDocument: [], didResolutionMetadata: {}, didDocumentMetadata: {} }),
    ];
    for (const body of bodies) {
      stub({ status: 200, body });
      const text = await registered()(args());
      assert.doesNotMatch(text, /# Signature Check at a Time: VALID/, body.slice(0, 80));
    }
  });

  test('a result of nearly one MiB, with thousands of keys, gives a short answer in a short time', async () => {
    const doc = standardDocument();
    const methods = doc.verificationMethod as Array<Record<string, unknown>>;
    for (let i = 0; i < 3_400; i += 1) methods.push({ id: `${DID}#${i.toString(16).padStart(56, '0')}`, type: 'Multikey', controller: DID, publicKeyMultibase: 'z1' });
    const { body } = documentAnswer({}, doc);
    assert.ok(body.length > 800_000 && body.length < 1024 * 1024, `the body has ${body.length} bytes`);
    stub({ status: 200, body });
    const started = performance.now();
    const text = await registered()(args());
    assert.ok(performance.now() - started < 3000);
    assert.match(text, /^# Signature Check at a Time: VALID\n/);
    assert.ok(text.length < 20_000, `the answer has ${text.length} characters`);
  });

  test('a message of the largest size is checked, and a signature over it verifies', async () => {
    const big = 'é'.repeat(MAX_MESSAGE_BYTES / 2);
    assert.equal(Buffer.byteLength(big), MAX_MESSAGE_BYTES);
    stub({ status: 200, body: documentAnswer().body });
    const text = await registered()(args({ message: big, signature_hex: sign(LISTED, big) }));
    assert.match(text, /^# Signature Check at a Time: VALID\n/);
    assert.ok(text.includes(`**Message:** ${MAX_MESSAGE_BYTES} bytes,`));
  });

  test('the key is looked up in the document of the request: a document that does not list it gives INVALID', async () => {
    stub({ status: 200, body: documentAnswer({}, didDocument([{ key: STRANGER, purposes: ['assertionMethod'] }])).body });
    const text = await registered()(args());
    assert.match(text, /^# Signature Check at a Time: INVALID\n/);
    assert.equal(jsonOf(text).reason, 'key_not_listed');
  });

  test('uses the gateway that the server is configured with, and never names it in an answer', async () => {
    process.env.VECTOR_IDENTITY_GATEWAY_URL = 'https://gateway.internal.example/base/';
    try {
      stub({ status: 200, body: documentAnswer().body });
      const text = await registered()(args());
      assert.equal(requested[0].url, `https://gateway.internal.example/base/1.0/identifiers/${DID}?versionTime=2026-11-03T15%3A56%3A00Z`);
      assert.doesNotMatch(text, /gateway\.internal\.example/);
    } finally {
      delete process.env.VECTOR_IDENTITY_GATEWAY_URL;
    }
  });

  test('a gateway that is 31 blocks behind the node, as the node says: NOT CHECKED (gateway_behind), and 30 blocks is VALID', async () => {
    node = { ...nodeDefault(), height: GATEWAY_TIP + 31 };
    stub({ status: 200, body: documentAnswer().body });
    const behind = await registered()(args());
    assert.match(behind, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.equal(jsonOf(behind).reason, 'gateway_behind');
    node = { ...nodeDefault(), height: GATEWAY_TIP + 30 };
    assert.match(await registered()(args()), /^# Signature Check at a Time: VALID\n/);
  });

  test('a node that fails, answers with an error or gives no whole number: NOT CHECKED (tip_unreadable), and no answer names the node', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const cases: NodeAnswer[] = [
      { fails: new TypeError(`fetch failed ${OGMIOS_URL}`) }, { status: 503 }, { height: 'origin' }, { height: null }, { height: -1 }, { height: 1.5 }, { height: '9548458' }, { height: {} },
    ];
    for (const answer of cases) {
      node = { ...nodeDefault(), ...answer };
      stub({ status: 200, body: documentAnswer().body });
      const text = await registered()(args());
      assert.match(text, /^# Signature Check at a Time: NOT CHECKED\n/, JSON.stringify(answer));
      assert.equal(jsonOf(text).reason, 'tip_unreadable', JSON.stringify(answer));
      assert.doesNotMatch(text, /ogmios\.test\.example/, text);
    }
  });

  test('a server whose chain provider is not Ogmios has no tip of the node: NOT CHECKED (tip_unreadable)', async () => {
    stub({ status: 200, body: documentAnswer().body });
    const handlers = new Map<string, Tool>();
    registerAgentNetworkTools(serverOf(handlers), 'signature-at-no-ogmios', () => new FixtureProvider(FIXTURE_UTXOS), new RateLimiter(100_000), { now: () => NOW });
    const text = await callThrough(handlers.get(NAME)!, args());
    assert.equal(jsonOf(text).reason, 'tip_unreadable');
    assert.equal(jsonOf(text).valid, false);
  });

  test('a body with a member name twice: NOT CHECKED (answer_unreadable), also when the last member says active', async () => {
    const body = documentAnswer().body.replace('"status":"active","effective":"active"', '"status":"active","effective":"revoked","effective":"active"');
    assert.notEqual(body, documentAnswer().body);
    stub({ status: 200, body });
    const text = await registered()(args());
    assert.match(text, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.match(text, /The gateway answer names a member twice in one object/);
    assert.equal(jsonOf(text).reason, 'answer_unreadable');
  });

  test('the block time of the tip of the node comes from its slot with the chain clock of the server: 10 minutes is current, 601 seconds is stale (tip_stale)', async () => {
    stub({ status: 200, body: documentAnswer().body });
    node = nodeOfAge(MAX_NODE_TIP_AGE_MS);
    assert.match(await registered()(args()), /^# Signature Check at a Time: VALID\n/);
    node = nodeOfAge(MAX_NODE_TIP_AGE_MS + 1000);
    const stale = await registered()(args());
    assert.match(stale, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.equal(jsonOf(stale).reason, 'tip_stale');
    assert.match(stale, /The tip of the node \(block 9548458\) is 601 seconds old\. The limit is 600 seconds\./);
  });

  test('a tip of the node without a slot or with a slot that is not a whole positive number: NOT CHECKED (tip_unreadable), never tip_stale', async () => {
    const id = 'ee'.repeat(32);
    const tips: unknown[] = [undefined, null, 'origin', {}, { id }, { slot: NODE_TIP_SLOT }, { slot: 0, id }, { slot: -5, id }, { slot: 1.5, id }, { slot: '38000000', id }, { slot: Number.MAX_SAFE_INTEGER + 2, id }, { slot: [1], id }];
    for (const tip of tips) {
      node = { ...nodeDefault(), tip };
      stub({ status: 200, body: documentAnswer().body });
      const text = await registered()(args());
      assert.match(text, /^# Signature Check at a Time: NOT CHECKED\n/, JSON.stringify(tip));
      assert.equal(jsonOf(text).reason, 'tip_unreadable', JSON.stringify(tip));
    }
  });

  test('the probe of the review: a node tip that is 600 s old, a gateway that is 30 blocks behind, and a time of 10 minutes before now: NOT CHECKED (too_recent); a time 10 minutes before the tip block is VALID', async () => {
    stub({ status: 200, body: documentAnswer({ nextVersionId: undefined, nextUpdate: undefined }).body });
    node = { ...nodeOfAge(MAX_NODE_TIP_AGE_MS), height: GATEWAY_TIP + 30 };
    const probe = await registered()(args({ at: isoOf(NOW - 600_000) }));
    assert.match(probe, /^# Signature Check at a Time: NOT CHECKED\n/);
    assert.equal(jsonOf(probe).reason, 'too_recent');
    assert.match(probe, /The time is less than 10 minutes before the tip block of the node, or after it\./);
    const later = await registered()(args({ at: isoOf(NOW - 1_200_000) }));
    assert.match(later, /^# Signature Check at a Time: VALID\n/);
  });
});
