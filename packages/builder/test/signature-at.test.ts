// packages/builder/test/signature-at.test.ts
// The check behind vector_verify_signature_at (signature-at.ts): the inputs, the base58btc reader of the keys in a DID document, and the
// decision from one answer of the identity gateway. The gateway is a fake resolver that hands in the answers that the real gateway
// gives (the shapes come from answers that were read from mainnet) and answers that it never gives. No network. The keys are test keys.
import { createHash } from 'node:crypto';
import { isJsonObject } from '../src/vector/identity-gateway.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { keyHashOf } from '../src/vector/identity-rules.ts';
import type { GatewayAnswer } from '../src/vector/identity-gateway.ts';
import {
  MAX_GATEWAY_LAG_BLOCKS, MAX_JSON_DEPTH, MAX_MESSAGE_BYTES, MAX_NODE_TIP_AGE_MS, MIN_AGE_MS, NODE_READ_MS, TIME_CLAIM_NOTE, decodeBase58btc, judge, parseSignatureAtInput,
  parseUtcSeconds,
  readMultikey, scanMemberNames, verifySignatureAt,
} from '../src/vector/signature-at.ts';
import type { JudgeContext, NodeTipRead, RawSignatureAtInput, SignatureAtAccess, SignatureAtRequest, SignatureAtResult } from '../src/vector/signature-at.ts';
import {
  AT, CONTROLLER, DELEGATE, DID, GATEWAY_TIP, LISTED, MESSAGE, NODE_TIP_TIME, NOW, OTHER_DID, RELATIONSHIPS, STRANGER, VECTOR_START_MS,
  answerOf, base58, didDocument, documentAnswer, errorAnswer, fakeGateway, metadata, nodeAt, sign, standardDocument,
} from './fixtures/signature-at-world.ts';

/** A request that passes the check of the inputs. */
function requestOf(over: RawSignatureAtInput = {}): SignatureAtRequest {
  const raw: RawSignatureAtInput = { did: DID, message: MESSAGE, signature_hex: sign(LISTED, MESSAGE), key: LISTED.keyHash, at: AT, ...over };
  const parsed = parseSignatureAtInput(raw);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.refusal);
  return parsed.request;
}
/** The clock and the tip of the node of most tests: a time long after the time of the request, and a gateway that is current. */
const CONTEXT: JudgeContext = { nowMs: NOW, node: nodeAt(GATEWAY_TIP) };
/** The access of `verifySignatureAt` in most tests: the same clock and tip, and the gateway that the test hands in. */
const accessOf = (resolve: SignatureAtAccess['resolve']): SignatureAtAccess => ({ resolve, now: () => NOW, nodeTip: async () => nodeAt(GATEWAY_TIP) });
const verify = async (answer: GatewayAnswer, over: RawSignatureAtInput = {}): Promise<SignatureAtResult> =>
  verifySignatureAt(requestOf(over), accessOf(fakeGateway(answer).resolve));
const resultsOf = (r: SignatureAtResult): Record<string, string> => Object.fromEntries(r.checks.map((c) => [c.id, c.result]));
/** The result of each check when every check passes. A test names the checks that differ. */
const ALL_PASS: Record<string, string> = {
  time_age: 'pass', version: 'pass', document: 'pass', gateway_current: 'pass', version_window: 'pass', status: 'pass', invalid_from: 'pass',
  key_listed: 'pass', key_matches: 'pass', signature: 'pass',
};
const resultsWith = (over: Record<string, string>): Record<string, string> => ({ ...ALL_PASS, ...over });
/** One turn of the event loop: what a test needs to let the work that is ready run, without a wait on the clock. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** What a promise settled with, once it has: it tracks the outcome, so that a rejection is not left unhandled. */
const track = (promise: Promise<unknown>): (() => unknown) => {
  let result: unknown = 'pending';
  promise.then((value) => { result = value; }, (err) => { result = err; });
  return () => result;
};
/** The result of each check when no check ran after the time check: the time check passed. */
const NOT_APPLICABLE: Record<string, string> = { ...Object.fromEntries(Object.keys(ALL_PASS).map((id) => [id, 'not_applicable'])), time_age: 'pass' };

// ─── The inputs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('parseSignatureAtInput', () => {
  const valid: RawSignatureAtInput = { did: DID, message: MESSAGE, signature_hex: sign(LISTED, MESSAGE), key: LISTED.keyHash, at: AT };
  const refusal = (over: RawSignatureAtInput): string => {
    const parsed = parseSignatureAtInput({ ...valid, ...over });
    assert.equal(parsed.ok, false, JSON.stringify(over).slice(0, 100));
    return parsed.ok ? '' : parsed.refusal;
  };

  test('accepts the inputs and takes assertionMethod when the purpose is missing', () => {
    const parsed = parseSignatureAtInput(valid);
    assert.ok(parsed.ok);
    assert.equal(parsed.request.purpose, 'assertionMethod');
    assert.equal(parsed.request.atMs, Date.parse(AT));
    assert.equal(parsed.request.message.toString('utf8'), MESSAGE);
    assert.equal(parsed.request.signature.length, 64);
    assert.deepEqual(parsed.request.key, { form: 'key_hash', keyHash: LISTED.keyHash, publicKey: null });
  });

  test('takes the message as text or as hex, and reads the same bytes', () => {
    const hex = parseSignatureAtInput({ ...valid, message: undefined, message_hex: Buffer.from(MESSAGE).toString('hex').toUpperCase() });
    assert.ok(hex.ok);
    assert.equal(hex.request.message.toString('utf8'), MESSAGE);
    const text = parseSignatureAtInput({ ...valid, message: 'é€😀' });
    assert.ok(text.ok);
    assert.deepEqual([...text.request.message], [...Buffer.from('é€😀', 'utf8')]);
  });

  test('takes the key as a verification method id, a key hash or a public key, in any case for the hex forms', () => {
    const url = parseSignatureAtInput({ ...valid, key: `${DID}#${LISTED.keyHash}` });
    assert.ok(url.ok);
    assert.deepEqual(url.request.key, { form: 'verification_method', keyHash: LISTED.keyHash, publicKey: null });
    const pub = parseSignatureAtInput({ ...valid, key: LISTED.publicKey.toUpperCase() });
    assert.ok(pub.ok);
    assert.deepEqual(pub.request.key, { form: 'public_key', keyHash: LISTED.keyHash, publicKey: LISTED.publicKey });
    const hash = parseSignatureAtInput({ ...valid, key: LISTED.keyHash.toUpperCase() });
    assert.ok(hash.ok);
    assert.equal(hash.request.key.keyHash, LISTED.keyHash);
    assert.equal(parseSignatureAtInput({ ...valid, signature_hex: sign(LISTED, MESSAGE).toUpperCase() }).ok, true);
  });

  test('refuses a DID that is not canonical', () => {
    for (const did of [`did:vector:agent:${'ab'.repeat(28)}:${'cd'.repeat(32)}`, 'c1'.repeat(32), DID.toUpperCase(), `${DID}#${LISTED.keyHash}`, `${DID} `, 'did:web:example.com', '', 5, null, undefined, ['x'], {}]) {
      assert.match(refusal({ did: did as string }), /^did: expected the canonical DID/, String(did));
    }
  });

  test('wants exactly one message, not empty, not over the limit, with valid text', () => {
    assert.match(refusal({ message: undefined }), /^message: give the signed message/);
    assert.match(refusal({ message_hex: '00' }), /^message: give message or message_hex, not both/);
    assert.match(refusal({ message: '' }), /^message: the message is empty/);
    assert.match(refusal({ message: undefined, message_hex: '' }), /^message_hex: expected an even number of hex characters/);
    assert.match(refusal({ message: 7 as unknown as string }), /^message: expected text/);
    assert.match(refusal({ message: null as unknown as string }), /^message: expected text/);
    assert.match(refusal({ message: undefined, message_hex: 7 as unknown as string }), /^message_hex: expected hex characters/);
    for (const hex of ['abc', 'zz', '0x00', 'ab cd', 'ab\n']) assert.match(refusal({ message: undefined, message_hex: hex }), /^message_hex: expected an even number of hex characters/, hex);
    // The limit is in bytes: it applies to the text as UTF-8 and to the hex as bytes.
    assert.ok(parseSignatureAtInput({ ...valid, message: 'a'.repeat(MAX_MESSAGE_BYTES) }).ok, 'exactly the limit');
    assert.match(refusal({ message: 'a'.repeat(MAX_MESSAGE_BYTES + 1) }), /over 16384 bytes/);
    assert.match(refusal({ message: 'é'.repeat(MAX_MESSAGE_BYTES / 2 + 1) }), /over 16384 bytes/);
    assert.ok(parseSignatureAtInput({ ...valid, message: undefined, message_hex: 'ab'.repeat(MAX_MESSAGE_BYTES) }).ok, 'exactly the limit as hex');
    assert.match(refusal({ message: undefined, message_hex: 'ab'.repeat(MAX_MESSAGE_BYTES + 1) }), /over 16384 bytes/);
    assert.match(refusal({ message: 'x'.repeat(5_000_000) }), /over 16384 bytes/);
    assert.match(refusal({ message: undefined, message_hex: 'ab'.repeat(5_000_000) }), /over 16384 bytes/);
  });

  test('refuses a text that has no UTF-8 form, because the signature would cover other bytes', () => {
    for (const lone of ['a\ud800', '\udc00b', 'x\ud83d y']) assert.match(refusal({ message: lone }), /^message: the text is not valid Unicode/, JSON.stringify(lone));
    assert.ok(parseSignatureAtInput({ ...valid, message: 'a\ufffdb' }).ok, 'a real U+FFFD is a valid character');
  });

  test('wants a signature of exactly 64 bytes in hex', () => {
    for (const signature of ['', 'ab'.repeat(63), 'ab'.repeat(65), `${'ab'.repeat(63)}zz`, 12, null, undefined]) {
      assert.match(refusal({ signature_hex: signature as string }), /^signature_hex: expected 128 hex characters/, String(signature));
    }
  });

  test('wants a key in one of the three forms, and a verification method id of the same DID', () => {
    for (const key of ['', 'ab'.repeat(27), 'ab'.repeat(29), 'ab'.repeat(33), `${DID}#${'ab'.repeat(27)}`, `#${LISTED.keyHash}`, `${OTHER_DID}x#${LISTED.keyHash}`, `${DID}#${LISTED.keyHash.toUpperCase()}`, 4, null, undefined]) {
      assert.match(refusal({ key: key as string }), /^key: expected a verification method id/, String(key));
    }
    assert.match(refusal({ key: `${OTHER_DID}#${LISTED.keyHash}` }), /^key: the verification method id names another DID than did/);
  });

  test('wants a purpose from the list', () => {
    assert.ok(parseSignatureAtInput({ ...valid, purpose: 'authentication' }).ok);
    assert.ok(parseSignatureAtInput({ ...valid, purpose: 'assertionMethod' }).ok);
    for (const purpose of ['capabilityInvocation', 'capabilityDelegation', 'assertion', '', 3, null]) assert.match(refusal({ purpose }), /^purpose: expected assertionMethod or authentication/, String(purpose));
  });

  test('wants a real time in whole seconds, UTC (a time that is too recent or in the future is not an input error)', () => {
    for (const at of ['2026-11-03T15:56:00.000Z', '2026-11-03T15:56:00.5Z', '2026-11-03T15:56:00+00:00', '2026-11-03T16:56:00+01:00', '2026-11-03 15:56:00Z', '2026-11-03T15:56Z', '2026-11-03', '2026-11-03T15:56:00z', ' 2026-11-03T15:56:00Z', 'yesterday']) {
      assert.match(refusal({ at }), /^at: expected a real date and time as YYYY-MM-DDThh:mm:ssZ/, at);
    }
    for (const at of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-11-03T24:00:00Z', '2026-11-03T15:60:00Z', '2026-11-03T15:56:60Z', '2025-02-29T00:00:00Z']) {
      assert.match(refusal({ at }), /^at: expected a real date and time/, at);
    }
    for (const at of [20261103, null, undefined, ['x']]) assert.match(refusal({ at: at as unknown as string }), /^at: expected a time as YYYY-MM-DDThh:mm:ssZ/, String(at));
    assert.ok(parseSignatureAtInput({ ...valid, at: '2024-02-29T23:59:59Z' }).ok, 'a leap day');
    assert.ok(parseSignatureAtInput({ ...valid, at: '2999-01-01T00:00:00Z' }).ok, 'a time in the future is no error of the input: the check gives NOT CHECKED (too_recent)');
    assert.ok(parseSignatureAtInput({ ...valid, at: '2026-11-20T12:00:00Z' }).ok, 'now');
    assert.equal(parseUtcSeconds('1970-01-01T00:00:00Z'), 0);
    assert.equal(parseUtcSeconds('2026-11-03T15:56:44Z'), Date.parse('2026-11-03T15:56:44.000Z'));
  });

  test('names the first input that is wrong, and never repeats the value', () => {
    const secret = 'topsecretvalue';
    const parsed = parseSignatureAtInput({ did: secret, message: secret, signature_hex: secret, key: secret, purpose: secret, at: secret });
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && !parsed.refusal.includes(secret));
  });
});

// ─── The keys of a DID document ───────────────────────────────────────────────────────────────────────────────────────────────

describe('decodeBase58btc and readMultikey', () => {
  /** Keys and key hashes that a mainnet answer gave: the id of each method is the hash of its key. */
  const MAINNET = [
    ['z6Mkm2fdhh8sY6UeTxksGSBnLZqUagRSaWqS4h2AzVCo8cmN', '891fad8bcae40209d9da6d2fb69d733e6b5ac3e1daa0446dca777181'],
    ['z6Mks5L1ouUCGv4i3hfGYE5G6VLErtZCbKKSWMSqGD3t8t3Y', '4a22b14431ea44d1450da3cf8304efcb06e3809c92e60935f32d9fb5'],
    ['z6MkgsgtVnvbE2d7GSKmYizd3seQxV95yrb1x3KbyWUUnBtE', 'a4a440e2ba8b005fd3eecec9591fd5ff4164e293c34d3db7005397c1'],
    ['z6MktpBZKnrTGhexZPYyiFongu5kf3w2ofR4eVXKdrBqctrB', 'f275a66ddeb6f40c955e260fa5e41ee3a72f5f44c3614dd2f594f613'],
  ] as const;

  test('reads the keys of a mainnet answer: the hash of each key is the id of its method', () => {
    for (const [multibase, hash] of MAINNET) {
      const reading = readMultikey(multibase);
      assert.equal(reading.type, 'Ed25519', multibase);
      assert.equal(reading.type === 'Ed25519' && keyHashOf(reading.key.toString('hex')), hash);
    }
  });

  test('reads what an independent encoder writes, with and without leading zero bytes', () => {
    for (const bytes of [[0], [0, 0, 0], [1], [255, 255], [0, 1, 2, 3], Array.from({ length: 34 }, (_, i) => i * 7), Array.from({ length: 34 }, () => 0), [0, 0, ...Array.from({ length: 32 }, (_, i) => 255 - i)]]) {
      assert.deepEqual([...decodeBase58btc(base58(Uint8Array.from(bytes)))!], bytes, bytes.join(','));
    }
  });

  test('refuses a text with a character outside the alphabet, an empty text and a text that is too long', () => {
    for (const bad of ['', '0', 'O', 'I', 'l', 'abc0', 'ab c', 'ab\n', 'é', '😀', '1'.repeat(65), 'z'.repeat(1_000_000)]) assert.equal(decodeBase58btc(bad), null, bad.slice(0, 20));
    assert.notEqual(decodeBase58btc('1'.repeat(64)), null);
  });

  test('tells an Ed25519 key, a P-256 key and anything else', () => {
    const key = Buffer.alloc(32, 7);
    assert.deepEqual(readMultikey(`z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), key]))}`), { type: 'Ed25519', key });
    assert.deepEqual(readMultikey(`z${base58(Buffer.concat([Buffer.from([0x80, 0x24]), Buffer.alloc(33, 3)]))}`), { type: 'P-256' });
    for (const other of [
      null, '', 'z', 'x6Mk', 'f6Mk', `u${base58(Buffer.alloc(34, 1))}`, `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.alloc(31, 7)]))}`,
      `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.alloc(33, 7)]))}`, `z${base58(Buffer.concat([Buffer.from([0x80, 0x24]), Buffer.alloc(32, 3)]))}`,
      `z${base58(Buffer.concat([Buffer.from([0xec, 0x01]), key]))}`, `z${base58(Buffer.concat([Buffer.from([0x00, 0x00]), key]))}`, `z${'1'.repeat(70)}`, `z${'a'.repeat(1_000_000)}`,
    ]) assert.deepEqual(readMultikey(other), { type: 'unknown' }, String(other).slice(0, 30));
  });
});

// ─── The decision ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('VALID', () => {
  test('a key that the version lists for assertionMethod, an active DID and a signature that verifies: every check passes', async () => {
    const gateway = fakeGateway(documentAnswer());
    const r = await verifySignatureAt(requestOf(), accessOf(gateway.resolve));
    assert.equal(r.verdict, 'valid');
    assert.equal(r.reason, null);
    assert.deepEqual(resultsOf(r), ALL_PASS);
    assert.deepEqual(gateway.calls, [{ did: DID, options: { versionTime: AT } }], 'one read, with the time of the request');
    assert.equal(r.httpStatus, 200);
    assert.equal(r.hasDocument, true);
    assert.equal(r.listedPublicKey, LISTED.publicKey);
    assert.match(r.summary, new RegExp(`^The signature verifies with the key #${LISTED.keyHash}\\. Version 5 of the DID listed the key for assertionMethod, and the DID was active at ${AT}\\.$`));
    assert.deepEqual(r.version, { versionId: '5', nextVersionId: '6', created: '2026-11-03T15:37:54Z', updated: '2026-11-03T15:53:53Z', nextUpdate: '2026-11-03T15:56:44Z' });
    assert.deepEqual(r.statusAtTime, { status: 'active', effective: 'active', effectiveReason: null, reason: null, at: null, invalidFrom: null });
    assert.deepEqual(r.now, { effective: 'active', effectiveReason: null, deactivated: false, invalidFrom: null, details: null, detailsRead: 'not_needed' });
    assert.deepEqual(r.message, { bytes: Buffer.byteLength(MESSAGE), sha256: createHash('sha256').update(MESSAGE).digest('hex') });
  });

  test('the keys of the version are listed with their purposes, and the key that was given is marked', async () => {
    const r = await verify(documentAnswer());
    assert.deepEqual(r.listedKeys, [
      { id: `#${CONTROLLER.keyHash}`, type: 'Ed25519', purposes: ['capabilityInvocation'], given: false },
      { id: `#${LISTED.keyHash}`, type: 'Ed25519', purposes: ['authentication', 'assertionMethod'], given: true },
      { id: `#${DELEGATE.keyHash}`, type: 'Ed25519', purposes: ['capabilityDelegation'], given: false },
    ]);
    assert.equal(r.moreKeys, 0);
  });

  test('the three forms of the key give the same verdict', async () => {
    for (const key of [LISTED.keyHash, LISTED.publicKey, `${DID}#${LISTED.keyHash}`, LISTED.publicKey.toUpperCase()]) {
      const r = await verify(documentAnswer(), { key });
      assert.equal(r.verdict, 'valid', key);
      assert.equal(r.checks.find((c) => c.id === 'key_matches')!.detail, key.length === 64 ? 'The public key in the document is the public key that you gave.' : 'The public key in the document hashes to the key hash that you gave.');
    }
  });

  test('the purpose authentication, when the version lists the key for it', async () => {
    const r = await verify(documentAnswer(), { purpose: 'authentication' });
    assert.equal(r.verdict, 'valid');
    assert.match(r.summary, /listed the key for authentication/);
  });

  test('the message as hex is the same message as the text', async () => {
    const r = await verify(documentAnswer(), { message: undefined, message_hex: Buffer.from(MESSAGE).toString('hex') });
    assert.equal(r.verdict, 'valid');
  });

  test('a document that names its keys with absolute ids is read the same way', async () => {
    const doc = standardDocument();
    for (const name of RELATIONSHIPS) if (doc[name]) doc[name] = (doc[name] as string[]).map((ref) => `${DID}${ref}`);
    assert.equal((await verify(documentAnswer({}, doc))).verdict, 'valid');
  });

  test('the facts of the version are kept as the gateway gave them: with a later version, and for the first version with none', async () => {
    const withNext = await verify(documentAnswer());
    assert.equal(withNext.version!.updated, '2026-11-03T15:53:53Z');
    assert.equal(withNext.version!.nextUpdate, '2026-11-03T15:56:44Z');
    assert.equal(withNext.checks.find((c) => c.id === 'version_window')!.detail, 'The version started at 2026-11-03T15:53:53Z, at or before the time, and the next update 2026-11-03T15:56:44Z is after the time.');
    const first = await verify(documentAnswer({ updated: undefined, nextUpdate: undefined, versionId: '0', nextVersionId: undefined }));
    assert.equal(first.verdict, 'valid');
    assert.deepEqual(first.version, { versionId: '0', nextVersionId: null, created: '2026-11-03T15:37:54Z', updated: null, nextUpdate: null });
    assert.equal(first.checks.find((c) => c.id === 'version_window')!.detail, 'The version started at 2026-11-03T15:37:54Z, at or before the time. The gateway shows no later version. A later version with fewer than 30 confirmations is not visible.');
  });

  test('a DID that is deactivated now, with the document of the time (HTTP 410): VALID, and a second read shows the revocation', async () => {
    const now = answerOf(410, { didDocument: null, didDocumentMetadata: {
      versionId: '2', deactivated: true, vectorStatus: { status: 'revoked', effective: 'revoked', by: 'ab'.repeat(28), reason: 'privilegeWithdrawn', at: '2026-11-18T20:09:54Z' },
    } });
    const gateway = fakeGateway(documentAnswer({ deactivated: true, vectorCurrent: { effective: 'revoked' } }, standardDocument(), 410), now);
    const r = await verifySignatureAt(requestOf(), accessOf(gateway.resolve));
    assert.equal(r.verdict, 'valid');
    assert.equal(r.httpStatus, 410);
    assert.deepEqual(gateway.calls.map((c) => c.options), [{ versionTime: AT }, {}], 'the second read has no time');
    assert.equal(r.now.deactivated, true);
    assert.equal(r.now.effective, 'revoked');
    assert.equal(r.now.detailsRead, 'second_read');
    assert.deepEqual(r.now.details, { status: 'revoked', effective: 'revoked', effectiveReason: null, reason: 'privilegeWithdrawn', at: '2026-11-18T20:09:54Z', invalidFrom: null });
  });

  test('the second read never changes the verdict: it can fail, or give nonsense', async () => {
    const first = documentAnswer({ deactivated: true, vectorCurrent: { effective: 'revoked' } }, standardDocument(), 410);
    for (const second of [new Error('the identity gateway could not be reached'), answerOf(500, { didResolutionMetadata: { error: { type: 'x', title: 'y' } } }), answerOf(410, { didDocumentMetadata: { vectorStatus: [1, 2] } }), { status: 410, body: '', result: null } as unknown as GatewayAnswer]) {
      const r = await verifySignatureAt(requestOf(), accessOf(fakeGateway(first, second).resolve));
      assert.equal(r.verdict, 'valid');
      assert.equal(r.now.detailsRead, 'not_available');
      assert.equal(r.now.details, null);
    }
  });

  test('a DID that is active now needs no second read, and a DID that is suspended now needs none either', async () => {
    for (const current of [{ effective: 'active' }, { effective: 'suspended', effectiveReason: 'parentSuspended' }]) {
      const gateway = fakeGateway(documentAnswer({ vectorCurrent: current }));
      const r = await verifySignatureAt(requestOf(), accessOf(gateway.resolve));
      assert.equal(r.verdict, 'valid');
      assert.equal(gateway.calls.length, 1);
      assert.equal(r.now.effective, current.effective);
    }
  });

  test('an invalid-from time after the time of the signature: the signature stays valid, and the time is shown', async () => {
    const gateway = fakeGateway(documentAnswer({ deactivated: true, vectorCurrent: { effective: 'revoked' }, vectorStatus: { status: 'active', effective: 'active', invalidFrom: '2026-11-03T15:56:01Z' } }, standardDocument(), 410), answerOf(410, { didDocumentMetadata: { vectorStatus: { status: 'revoked', effective: 'revoked', reason: 'keyCompromise', at: '2026-11-18T10:00:00Z', invalidFrom: '2026-11-03T15:56:01Z' } } }));
    const r = await verifySignatureAt(requestOf(), accessOf(gateway.resolve));
    assert.equal(r.verdict, 'valid');
    assert.equal(r.now.invalidFrom, '2026-11-03T15:56:01Z');
    assert.equal(r.now.details!.reason, 'keyCompromise');
    assert.match(r.checks.find((c) => c.id === 'invalid_from')!.detail, /is after the time of the signature\. A signature before it stays valid\./);
  });
});

describe('INVALID', () => {
  test('the DID did not exist at that time (NOT_FOUND, HTTP 404): only the first check ran', async () => {
    const r = await verify(errorAnswer(404, 'NOT_FOUND', 'DID not found: no confirmed version at the requested time'));
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'did_not_found');
    assert.deepEqual(resultsOf(r), { ...NOT_APPLICABLE, version: 'fail' });
    assert.match(r.summary, /^The DID did not exist at that time: the gateway has no confirmed version of it then \(NOT_FOUND: DID not found: no confirmed version at the requested time\)\.$/);
    assert.equal(r.version?.versionId, null);
    assert.equal(r.hasDocument, false);
  });

  test('the DID had no registry record at all: the same refusal', async () => {
    const r = await verify(errorAnswer(404, 'NOT_FOUND', 'DID not found: no registry minted the identifier'));
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'did_not_found');
  });

  test('a DID deactivated at that time has no document (HTTP 410): INVALID, with the status of the version', async () => {
    const gone = answerOf(410, { didDocumentMetadata: metadata({
      versionId: '2', updated: '2026-11-18T20:14:09Z', nextVersionId: undefined, deactivated: true, vectorCurrent: { effective: 'revoked' },
      vectorStatus: { status: 'revoked', effective: 'revoked', by: 'ab'.repeat(28), reason: 'privilegeWithdrawn', at: '2026-11-18T20:09:54Z' },
    }) });
    const gateway = fakeGateway(gone);
    const r = await verifySignatureAt(requestOf({ at: '2026-11-18T20:20:00Z' }), accessOf(gateway.resolve));
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'deactivated');
    assert.equal(gateway.calls.length, 1, 'the status is in the answer: no second read');
    assert.deepEqual(resultsOf(r), { ...NOT_APPLICABLE, version: 'pass', document: 'fail', status: 'fail' });
    assert.equal(r.summary, 'The DID was deactivated at that time, so it has no DID document then.');
    assert.deepEqual(r.statusAtTime, { status: 'revoked', effective: 'revoked', effectiveReason: null, reason: 'privilegeWithdrawn', at: '2026-11-18T20:09:54Z', invalidFrom: null });
    assert.equal(r.now.deactivated, true);
  });

  test('a DID retired at that time: the same, with the word retired', async () => {
    const gone = answerOf(410, { didDocumentMetadata: metadata({ deactivated: true, vectorStatus: { status: 'retired', effective: 'retired', at: '2026-11-18T20:09:54Z' } }) });
    const r = await verify(gone);
    assert.equal(r.reason, 'deactivated');
    assert.equal(r.summary, 'The DID was retired at that time, so it has no DID document then.');
  });

  test('a DID that an invalid-from time ended: no document, and the answer says which time', async () => {
    const gone = answerOf(410, { didDocumentMetadata: metadata({
      deactivated: true, vectorCurrent: { effective: 'revoked' },
      vectorStatus: { status: 'active', effective: 'revoked', effectiveReason: 'invalidated', invalidFrom: '2026-11-03T15:00:00Z' },
    }) });
    const r = await verify(gone);
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'deactivated');
    assert.match(r.summary, /^An invalid-from time \(2026-11-03T15:00:00Z\) at or before the time ended the DID, so it has no DID document then\.$/);
    assert.equal(r.statusAtTime?.effectiveReason, 'invalidated');
  });

  test('the key is not listed at that time: INVALID, with the keys that the version lists', async () => {
    const r = await verify(documentAnswer(), { key: STRANGER.keyHash, signature_hex: sign(STRANGER, MESSAGE) });
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'key_not_listed');
    assert.equal(r.summary, `The version lists no key ${STRANGER.keyHash}.`);
    assert.deepEqual(resultsOf(r), resultsWith({ key_listed: 'fail', key_matches: 'not_applicable', signature: 'not_applicable' }));
    assert.equal(r.listedKeys.length, 3);
    assert.ok(r.listedKeys.every((k) => !k.given));
  });

  test('a key that was listed before and was removed since is not listed in the version of the time', async () => {
    const before = didDocument([{ key: CONTROLLER, purposes: ['capabilityInvocation'] }, { key: STRANGER, purposes: ['authentication', 'assertionMethod'] }]);
    const after = didDocument([{ key: CONTROLLER, purposes: ['capabilityInvocation'] }, { key: LISTED, purposes: ['authentication', 'assertionMethod'] }]);
    const signed = { key: STRANGER.publicKey, signature_hex: sign(STRANGER, MESSAGE) };
    assert.equal((await verify(documentAnswer({ versionId: '1' }, before), signed)).verdict, 'valid');
    const removed = await verify(documentAnswer({ versionId: '2' }, after), signed);
    assert.equal(removed.verdict, 'invalid');
    assert.equal(removed.reason, 'key_not_listed');
  });

  test('the key is listed, but not for the purpose: the controller key and the delegation key do not count for assertionMethod', async () => {
    for (const [key, listedFor] of [[CONTROLLER, 'capabilityInvocation'], [DELEGATE, 'capabilityDelegation']] as const) {
      const r = await verify(documentAnswer(), { key: key.keyHash, signature_hex: sign(key, MESSAGE) });
      assert.equal(r.verdict, 'invalid', listedFor);
      assert.equal(r.reason, 'purpose_missing');
      assert.equal(r.summary, `The version lists the key, but not for assertionMethod. It lists the key for: ${listedFor}.`);
      assert.equal(resultsOf(r).key_matches, 'not_applicable');
    }
  });

  test('a key that is listed for assertionMethod only does not count for authentication, and the other way round', async () => {
    const doc = didDocument([{ key: LISTED, purposes: ['assertionMethod'] }, { key: DELEGATE, purposes: ['authentication'] }]);
    const a = await verify(documentAnswer({}, doc), { purpose: 'authentication' });
    assert.equal(a.reason, 'purpose_missing');
    assert.match(a.summary, /not for authentication\. It lists the key for: assertionMethod\./);
    const b = await verify(documentAnswer({}, doc), { key: DELEGATE.keyHash, signature_hex: sign(DELEGATE, MESSAGE) });
    assert.equal(b.reason, 'purpose_missing');
    assert.match(b.summary, /not for assertionMethod\. It lists the key for: authentication\./);
    assert.equal((await verify(documentAnswer({}, doc), { key: DELEGATE.keyHash, signature_hex: sign(DELEGATE, MESSAGE), purpose: 'authentication' })).verdict, 'valid');
  });

  test('a DID with no authentication and no assertionMethod at all (the members are missing): no key for any of the two purposes', async () => {
    const doc = didDocument([{ key: CONTROLLER, purposes: ['capabilityInvocation', 'capabilityDelegation'] }]);
    for (const purpose of ['assertionMethod', 'authentication'] as const) {
      const r = await verify(documentAnswer({}, doc), { key: CONTROLLER.keyHash, signature_hex: sign(CONTROLLER, MESSAGE), purpose });
      assert.equal(r.verdict, 'invalid');
      assert.equal(r.reason, 'purpose_missing');
      assert.match(r.summary, /It lists the key for: capabilityInvocation, capabilityDelegation\.$/);
    }
  });

  test('a DID that is suspended at that time is INVALID, and the other checks still run', async () => {
    const r = await verify(documentAnswer({ vectorStatus: { status: 'suspended', effective: 'suspended', effectiveReason: 'unaccountable', holds: [] } }));
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'status_not_active');
    assert.equal(r.summary, 'The effective status of the version is suspended (unaccountable), not active.');
    assert.deepEqual(resultsOf(r), resultsWith({ status: 'fail' }));
  });

  test('a record that is suspended by its own status with an effective status of active is active: the effective status decides', async () => {
    assert.equal((await verify(documentAnswer({ vectorStatus: { status: 'suspended', effective: 'active' } }))).verdict, 'valid');
  });

  test('an effective status that looks like active only after the cleaning is not active: the decision reads the text as the gateway wrote it', async () => {
    for (const effective of ['active\u200b', 'active\u202e', 'a\u200bctive', 'active\u0000', ' active', 'active ', 'Active', 'ACTIVE', 'active\n']) {
      const r = await verify(documentAnswer({ vectorStatus: { status: 'active', effective } }));
      assert.equal(r.verdict, 'invalid', JSON.stringify(effective));
      assert.equal(r.reason, 'status_not_active');
    }
    const hidden = await verify(documentAnswer({ vectorStatus: { status: 'active', effective: 'active\u200b' } }));
    assert.equal(hidden.summary, 'The effective status of the version is active (the text has characters that are not shown), not active.');
  });

  test('the signature does not verify: a random signature, another key, another message', async () => {
    const random = await verify(documentAnswer(), { signature_hex: 'ab'.repeat(64) });
    assert.equal(random.verdict, 'invalid');
    assert.equal(random.reason, 'signature_mismatch');
    assert.equal(random.summary, 'The Ed25519 signature does not verify over the message with the listed key.');
    assert.deepEqual(resultsOf(random), resultsWith({ signature: 'fail' }));
    assert.equal((await verify(documentAnswer(), { signature_hex: sign(STRANGER, MESSAGE) })).reason, 'signature_mismatch');
    assert.equal((await verify(documentAnswer(), { message: `${MESSAGE} ` })).reason, 'signature_mismatch');
    assert.equal((await verify(documentAnswer(), { message: undefined, message_hex: Buffer.from(MESSAGE).toString('hex').slice(2) + '00' })).reason, 'signature_mismatch');
    const flipped = Buffer.from(sign(LISTED, MESSAGE), 'hex');
    flipped[63] ^= 1;
    assert.equal((await verify(documentAnswer(), { signature_hex: flipped.toString('hex') })).reason, 'signature_mismatch');
  });

  test('a signature over the same text with a different byte form is not the signature of the text', async () => {
    const decomposed = 'e\u0301';
    const precomposed = '\u00e9';
    const signed = { signature_hex: sign(LISTED, decomposed) };
    assert.equal((await verify(documentAnswer(), { message: decomposed, ...signed })).verdict, 'valid');
    assert.equal((await verify(documentAnswer(), { message: precomposed, ...signed })).reason, 'signature_mismatch');
  });

  test('an invalid-from time at or before the time of the signature is INVALID, also when the gateway gave a document', async () => {
    for (const invalidFrom of ['2026-11-03T15:56:00Z', '2026-11-03T15:55:59Z', '2026-01-01T00:00:00Z']) {
      const r = await verify(documentAnswer({ vectorStatus: { status: 'active', effective: 'active', invalidFrom } }));
      assert.equal(r.verdict, 'invalid', invalidFrom);
      assert.equal(r.reason, 'invalid_from');
      assert.equal(r.summary, `The invalid-from time ${invalidFrom} is at or before the time of the signature. A signature at or after it is invalid.`);
      assert.equal(resultsOf(r).signature, 'pass', 'the signature itself verifies: the other checks still run');
    }
  });

  test('a document and a status that are active, but an invalid-from time that nobody can read: the tool cannot decide', async () => {
    for (const invalidFrom of ['soon', '2026-11-03T15:56:00.5Z', '', 12, {}]) {
      const r = await verify(documentAnswer({ vectorStatus: { status: 'active', effective: 'active', invalidFrom } }));
      assert.equal(r.verdict, 'not_checked', JSON.stringify(invalidFrom));
      assert.equal(r.reason, 'answer_unreadable');
    }
  });

  test('a document that lists another public key under the id of the key that the caller gave', async () => {
    // The id of a method is the hash of its key. A document that lists another key under the id of LISTED is not consistent.
    const liar = didDocument([{ key: LISTED, purposes: ['authentication', 'assertionMethod'] }]);
    (liar.verificationMethod as Array<Record<string, unknown>>)[0].publicKeyMultibase = STRANGER.multibase;
    // The caller gave the public key: the document does not list that key, so the signature is INVALID.
    const given = await verify(documentAnswer({}, liar), { key: LISTED.publicKey });
    assert.equal(given.verdict, 'invalid');
    assert.equal(given.reason, 'key_differs');
    assert.equal(given.summary, 'The version lists another public key under the id of the key that you gave. It does not list the public key that you gave.');
    assert.equal(given.listedPublicKey, STRANGER.publicKey);
    assert.equal(resultsOf(given).signature, 'not_applicable');
    // The caller gave a key hash: the tool has no key to compare with, and the document is not consistent, so the tool cannot decide.
    const hashed = await verify(documentAnswer({}, liar));
    assert.equal(hashed.verdict, 'not_checked');
    assert.equal(hashed.reason, 'answer_unreadable');
    assert.equal(hashed.checks.find((c) => c.id === 'key_matches')!.detail, 'The public key in the document does not match the key hash in its id, so the tool cannot decide.');
    // The signature of STRANGER verifies with the key in the document, and still gives no VALID for the key hash of LISTED.
    const strangerSigned = await verify(documentAnswer({}, liar), { signature_hex: sign(STRANGER, MESSAGE) });
    assert.equal(strangerSigned.verdict, 'not_checked');
  });

  test('a key with a small order, and a signature that the rules of the ledger refuse, do not verify', async () => {
    const zero = Buffer.alloc(32);
    const small = { keyHash: keyHashOf(zero.toString('hex')), multibase: `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), zero]))}` };
    const doc = standardDocument();
    (doc.verificationMethod as Array<Record<string, unknown>>).push({ id: `${DID}#${small.keyHash}`, type: 'Multikey', controller: DID, publicKeyMultibase: small.multibase });
    doc.assertionMethod = [...(doc.assertionMethod as string[]), `#${small.keyHash}`];
    // R is the identity point and S is 0: the weak check of some libraries lets it verify over a message.
    const forged = `01${'00'.repeat(31)}${'00'.repeat(32)}`;
    const r = await verify(documentAnswer({}, doc), { key: small.keyHash, signature_hex: forged });
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'signature_mismatch');
    assert.equal((await verify(documentAnswer({}, doc), { key: zero.toString('hex'), signature_hex: forged })).reason, 'signature_mismatch');
  });
});

describe('the window of the version: updated or created before the time, nextUpdate after it', () => {
  const windowOf = (r: SignatureAtResult) => r.checks.find((c) => c.id === 'version_window')!;

  test('a time inside the version passes, also at the second that the version started', async () => {
    for (const at of ['2026-11-03T15:53:53Z', '2026-11-03T15:53:54Z', AT, '2026-11-03T15:56:43Z']) {
      const r = await verify(documentAnswer(), { at });
      assert.equal(r.verdict, 'valid', at);
      assert.equal(windowOf(r).result, 'pass', at);
    }
  });

  test('a signature in the second of the next update is INVALID: the tool cannot tell on which side of the change it was made', async () => {
    // A request exactly at the time of an update gets the version before it, with the time of the update as its next update.
    const r = await verify(documentAnswer(), { at: '2026-11-03T15:56:44Z' });
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'ambiguous_second');
    assert.equal(r.summary, windowOf(r).detail);
    assert.equal(windowOf(r).detail, 'The DID changed at 2026-11-03T15:56:44Z, in the same second as the signature (the next update equals the time). The tool cannot tell whether the signature came before or after the change, so the signature does not pass.');
    assert.deepEqual(resultsOf(r), resultsWith({ version_window: 'fail' }), 'the signature itself verifies, and every other check passes');
  });

  test('a next update before the time means that the version was not the one in force: INVALID', async () => {
    const r = await verify(documentAnswer(), { at: '2026-11-03T15:56:45Z' });
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'version_superseded');
    assert.equal(windowOf(r).detail, 'A later version of the DID started at 2026-11-03T15:56:44Z, before the time of the signature, so this version was not the one in force.');
  });

  test('a version that started after the time is INVALID', async () => {
    const r = await verify(documentAnswer(), { at: '2026-11-03T15:53:52Z' });
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'version_not_started');
    assert.equal(windowOf(r).detail, 'The version started at 2026-11-03T15:53:53Z, after the time of the signature.');
    assert.equal(resultsOf(r).signature, 'pass');
  });

  test('the first version has no updated: the time of creation is its start', async () => {
    const first = documentAnswer({ versionId: '0', updated: undefined, nextVersionId: undefined, nextUpdate: undefined });
    assert.equal((await verify(first, { at: '2026-11-03T15:37:54Z' })).verdict, 'valid', 'at the second of the creation');
    assert.equal((await verify(first, { at: AT })).verdict, 'valid');
    const early = await verify(first, { at: '2026-11-03T15:37:53Z' });
    assert.equal(early.verdict, 'invalid');
    assert.equal(early.reason, 'version_not_started');
    assert.equal(windowOf(early).detail, 'The version started at 2026-11-03T15:37:54Z, after the time of the signature.');
  });

  test('a version after the first one that has no updated cannot be placed: the tool does not use the time of creation for it', async () => {
    const r = await verify(documentAnswer({ updated: undefined }));
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'answer_unreadable');
    assert.match(windowOf(r).detail, /^The gateway answer gives no time at which the version started/);
    const noVersionId = await verify(documentAnswer({ updated: undefined, versionId: undefined }));
    assert.equal(noVersionId.verdict, 'not_checked');
  });

  test('a start or a next update that is not a time in whole seconds gives no verdict', async () => {
    for (const over of [
      { updated: 'soon' }, { updated: '2026-11-03T15:53:53.5Z' }, { updated: '' }, { updated: 12 }, { updated: true }, { updated: ['2026-11-03T15:53:53Z'] },
      { nextUpdate: 'soon' }, { nextUpdate: '2026-11-03T15:56:44.5Z' }, { nextUpdate: '' }, { nextUpdate: 12 }, { nextUpdate: {} },
    ]) {
      const r = await verify(documentAnswer(over));
      assert.equal(r.verdict, 'not_checked', JSON.stringify(over));
      assert.equal(r.reason, 'answer_unreadable');
      assert.equal(windowOf(r).result, 'unknown');
    }
  });

  test('a gateway that names a later version and gives no next update: the tool says that it cannot apply the check, and the result is NOT CHECKED', async () => {
    const r = await verify(documentAnswer({ nextUpdate: undefined }));
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'next_update_missing');
    assert.equal(r.summary, windowOf(r).detail);
    assert.equal(windowOf(r).detail, 'The gateway did not give nextUpdate, so the tool cannot apply the nextUpdate check. The DID has a later version (version 6), and the gateway did not give its time. The tool cannot rule out that the later version was made in the same second as the signature, so it cannot decide.');
    assert.deepEqual(resultsOf(r), resultsWith({ version_window: 'unknown' }), 'every other check passes, the signature included');
    assert.equal(r.version!.nextVersionId, '6');
    assert.equal(r.version!.nextUpdate, null);
  });

  test('a check that fails still gives INVALID when the gateway gives no next update: an unknown check never hides a failure', async () => {
    const noNextUpdate = documentAnswer({ nextUpdate: undefined });
    const random = await verify(noNextUpdate, { signature_hex: 'ab'.repeat(64) });
    assert.equal(random.verdict, 'invalid');
    assert.equal(random.reason, 'signature_mismatch');
    assert.deepEqual(resultsOf(random), resultsWith({ version_window: 'unknown', signature: 'fail' }));
    assert.equal((await verify(noNextUpdate, { key: STRANGER.keyHash, signature_hex: sign(STRANGER, MESSAGE) })).reason, 'key_not_listed');
    assert.equal((await verify(documentAnswer({ nextUpdate: undefined, vectorStatus: { status: 'suspended', effective: 'suspended' } }))).reason, 'status_not_active');
  });

  test('with no later version and no next update the check passes, and says what it cannot see', async () => {
    const latest = documentAnswer({ nextVersionId: undefined, nextUpdate: undefined });
    const r = await verify(latest);
    assert.equal(r.verdict, 'valid');
    assert.equal(windowOf(r).detail, 'The version started at 2026-11-03T15:53:53Z, at or before the time. The gateway shows no later version. A later version with fewer than 30 confirmations is not visible.');
    assert.equal(r.version!.nextVersionId, null);
  });

  test('a next update without a later version id is compared all the same', async () => {
    const odd = documentAnswer({ nextVersionId: undefined });
    assert.equal((await verify(odd)).verdict, 'valid');
    assert.equal((await verify(odd, { at: '2026-11-03T15:56:44Z' })).reason, 'ambiguous_second');
  });

  test('the start and the next update can be the same second (two updates in one block): the check does not need the start to come first', async () => {
    const same = documentAnswer({ updated: '2026-11-03T15:56:44Z', nextUpdate: '2026-11-03T15:56:44Z' });
    const atTheSecond = await verify(same, { at: '2026-11-03T15:56:44Z' });
    assert.equal(atTheSecond.reason, 'ambiguous_second', 'the start is at or before the time, and the next update equals it');
    assert.equal((await verify(same, { at: '2026-11-03T15:56:45Z' })).reason, 'version_superseded');
    assert.equal((await verify(same, { at: '2026-11-03T15:56:43Z' })).reason, 'version_not_started');
  });

  test('the two times do not carry the invalid-from time: the check of invalid_from applies on its own, also when the window passes', async () => {
    const r = await verify(documentAnswer({ vectorStatus: { status: 'active', effective: 'active', invalidFrom: AT } }));
    assert.equal(windowOf(r).result, 'pass');
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'invalid_from');
  });

  test('a document that is deactivated at the time has no window to check', async () => {
    const gone = answerOf(410, { didDocumentMetadata: metadata({ deactivated: true, vectorStatus: { status: 'revoked', effective: 'revoked' } }) });
    assert.equal(windowOf(await verify(gone)).result, 'not_applicable');
  });
});

describe('NOT CHECKED', () => {
  test('a P-256 key is listed: the tool checks Ed25519 only', async () => {
    const p256 = { keyHash: 'ee'.repeat(28), multibase: `z${base58(Buffer.concat([Buffer.from([0x80, 0x24]), Buffer.alloc(33, 3)]))}` };
    const doc = standardDocument();
    (doc.verificationMethod as Array<Record<string, unknown>>).push({ id: `${DID}#${p256.keyHash}`, type: 'Multikey', controller: DID, publicKeyMultibase: p256.multibase });
    doc.authentication = [...(doc.authentication as string[]), `#${p256.keyHash}`];
    const r = await verify(documentAnswer({}, doc), { key: p256.keyHash, purpose: 'authentication' });
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'key_type_unsupported');
    assert.equal(r.summary, 'The listed key is a P-256 key. The tool checks Ed25519 signatures only, so it cannot decide.');
    assert.equal(r.listedKeys.find((k) => k.given)?.type, 'P-256');
    assert.equal(resultsOf(r).signature, 'not_applicable');
  });

  test('an error of the gateway says nothing about the signature', async () => {
    for (const [status, name] of [[500, 'INTERNAL_ERROR'], [501, 'FEATURE_NOT_SUPPORTED'], [501, 'METHOD_NOT_SUPPORTED'], [400, 'INVALID_OPTIONS'], [400, 'INVALID_DID'], [406, 'REPRESENTATION_NOT_SUPPORTED'], [404, 'SOMETHING_ELSE'], [200, 'NOT_FOUND'], [410, 'NOT_FOUND'], [500, 'NOT_FOUND']] as const) {
      const r = await verify(errorAnswer(status, name, 'Koios failed'));
      assert.equal(r.verdict, 'not_checked', `${status} ${name}`);
      assert.equal(r.reason, 'gateway_error');
      assert.match(r.summary, new RegExp(`^The gateway answered HTTP ${status} with an error \\(${name}: Koios failed\\), so the tool cannot decide\\.$`));
    }
    const noType = await verify(answerOf(500, { didResolutionMetadata: { error: {} } }));
    assert.equal(noType.verdict, 'not_checked');
    assert.match(noType.summary, /\(unknown error\)/);
  });

  test('an error member that is not an object is an error all the same, also next to a document and with the HTTP status 404', async () => {
    for (const error of ['notFound', 'https://www.w3.org/ns/did#NOT_FOUND', 5, true, false, '', [], ['x']]) {
      for (const status of [200, 404, 410]) {
        const withDocument = await verify(answerOf(status, { didDocument: standardDocument(), didResolutionMetadata: { error }, didDocumentMetadata: metadata() }));
        assert.equal(withDocument.verdict, 'not_checked', `${JSON.stringify(error)} ${status}`);
        assert.equal(withDocument.reason, 'gateway_error');
        assert.match(withDocument.summary, /\(unknown error\), so the tool cannot decide\.$/);
        const without = await verify(answerOf(status, { didResolutionMetadata: { error } }));
        assert.equal(without.reason, 'gateway_error', 'a string that names NOT_FOUND is not a NOT_FOUND result');
      }
    }
  });

  test('an answer without a document and without a reason', async () => {
    const r = await verify(answerOf(200, { didDocumentMetadata: metadata() }));
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'answer_unreadable');
    assert.equal(r.summary, 'The gateway answer has no DID document and does not say why, so the tool cannot decide.');
  });

  test('a document without an effective status', async () => {
    for (const vectorStatus of [undefined, null, 'active', ['active'], {}, { status: 'active' }, { effective: 1 }, { effective: null }, { effective: '' }, { effective: ' ' }, { effective: '\u200b' }]) {
      const r = await verify(documentAnswer({ vectorStatus }));
      assert.equal(r.verdict, 'not_checked', JSON.stringify(vectorStatus));
      assert.equal(r.reason, 'answer_unreadable');
    }
  });

  test('a document that the HTTP status does not fit, or that names another DID', async () => {
    for (const status of [201, 202, 301, 400, 404, 500, 501, 503]) assert.equal((await verify(documentAnswer({}, standardDocument(), status))).verdict, 'not_checked', String(status));
    const other = await verify(documentAnswer({}, didDocument([{ key: LISTED, purposes: ['assertionMethod'] }], OTHER_DID)));
    assert.equal(other.verdict, 'not_checked');
    assert.equal(other.summary, 'The DID document names another DID than the one that was asked for, so the tool cannot decide.');
    const noId = standardDocument();
    delete noId.id;
    assert.equal((await verify(documentAnswer({}, noId))).verdict, 'not_checked');
  });

  test('a key that the version lists twice', async () => {
    const doc = standardDocument();
    const methods = doc.verificationMethod as Array<Record<string, unknown>>;
    methods.push({ ...methods[1], publicKeyMultibase: STRANGER.multibase });
    const r = await verify(documentAnswer({}, doc));
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'answer_unreadable');
    assert.match(r.summary, /lists the key .* more than once/);
  });

  test('a listed key that is not a key: a number, a text with other characters, a wrong header, a wrong length, or nothing', async () => {
    const wrongHeader = `z${base58(Buffer.concat([Buffer.from([0xed, 0x02]), Buffer.alloc(32, 5)]))}`;
    for (const multibase of [5, null, undefined, '', 'z', 'z0OIl', 'zabc', LISTED.multibase.slice(0, -2), `${LISTED.multibase}1`, wrongHeader, `u${LISTED.multibase.slice(1)}`, 'z'.repeat(5000), [LISTED.multibase], { a: 1 }]) {
      const doc = standardDocument();
      (doc.verificationMethod as Array<Record<string, unknown>>)[1].publicKeyMultibase = multibase;
      const r = await verify(documentAnswer({}, doc));
      assert.equal(r.verdict, 'not_checked', String(multibase).slice(0, 20));
      assert.equal(r.reason, 'answer_unreadable');
      assert.equal(r.summary, 'The document gives a public key that the tool cannot read, so the tool cannot decide.');
    }
  });

  test('a gateway answer that is not a resolution result at all (a wrong client): no verdict and no throw', async () => {
    for (const answer of [{ status: 200, body: '', result: null }, { status: 200, body: '', result: [] }, { status: 200, body: '', result: 'x' }, { status: '200', body: '', result: { didDocument: null } }, { status: 200 }, {}, null, undefined]) {
      const r = await verifySignatureAt(requestOf(), accessOf(async () => answer as unknown as GatewayAnswer));
      assert.equal(r.verdict, 'not_checked', JSON.stringify(answer));
      assert.equal(r.reason, 'answer_unreadable');
      assert.equal(r.version, null);
    }
  });
});

describe('an answer that is built to confuse the check never gives VALID and never throws', () => {
  /** The same request against a document that the test spoils. */
  async function against(spoil: (doc: Record<string, unknown>) => void, over: Record<string, unknown> = {}): Promise<SignatureAtResult> {
    const doc = standardDocument();
    spoil(doc);
    return verify(documentAnswer(over, doc));
  }

  test('members of the wrong type in the document', async () => {
    const spoils: Array<[string, (d: Record<string, unknown>) => void]> = [
      ['verificationMethod is a text', (d) => { d.verificationMethod = 'x'; }],
      ['verificationMethod is an object', (d) => { d.verificationMethod = { id: `${DID}#${LISTED.keyHash}` }; }],
      ['verificationMethod holds nothing that is an object', (d) => { d.verificationMethod = [null, 1, 'x', [], true]; }],
      ['a method without an id', (d) => { d.verificationMethod = [{ publicKeyMultibase: LISTED.multibase }]; }],
      ['the id of every method is a number', (d) => { d.verificationMethod = (d.verificationMethod as Array<Record<string, unknown>>).map((m) => ({ ...m, id: 7 })); }],
      ['assertionMethod is a text', (d) => { d.assertionMethod = `#${LISTED.keyHash}`; }],
      ['assertionMethod is an object', (d) => { d.assertionMethod = { [`#${LISTED.keyHash}`]: true }; }],
      ['assertionMethod holds an embedded method, not a reference', (d) => { d.assertionMethod = [{ id: `${DID}#${LISTED.keyHash}`, type: 'Multikey', publicKeyMultibase: LISTED.multibase }]; }],
      ['assertionMethod holds numbers and lists', (d) => { d.assertionMethod = [1, [`#${LISTED.keyHash}`], null]; }],
      ['assertionMethod names the key of another DID', (d) => { d.assertionMethod = [`${OTHER_DID}#${LISTED.keyHash}`]; }],
      ['assertionMethod names the key with another case', (d) => { d.assertionMethod = [`#${LISTED.keyHash.toUpperCase()}`]; }],
      ['assertionMethod names the key with a trailing space', (d) => { d.assertionMethod = [`#${LISTED.keyHash} `]; }],
      ['assertionMethod is empty', (d) => { d.assertionMethod = []; }],
      ['assertionMethod is null', (d) => { d.assertionMethod = null; }],
    ];
    for (const [name, spoil] of spoils) {
      const r = await against(spoil);
      assert.notEqual(r.verdict, 'valid', name);
      assert.ok(r.reason !== null, name);
    }
  });

  test('a prototype key in the answer does not change what the check reads', async () => {
    const answer = JSON.parse(`{"didDocument":${JSON.stringify(standardDocument())},"didResolutionMetadata":{"__proto__":{"error":{"type":"x"}}},"didDocumentMetadata":${JSON.stringify(metadata())}}`) as GatewayAnswer['result'];
    const r = await verifySignatureAt(requestOf(), accessOf(async () => ({ status: 200, body: '', result: answer })));
    assert.equal(r.verdict, 'valid');
    assert.equal(({} as Record<string, unknown>).error, undefined, 'Object.prototype is untouched');
  });

  test('members of the wrong type in the facts of the version give no facts and no VALID, and no crash', async () => {
    const r = await verify(documentAnswer({ versionId: 5, nextVersionId: ['6'], created: null, updated: {}, nextUpdate: 7, vectorCurrent: 'active', deactivated: 'true', canonicalId: 1 }));
    assert.equal(r.verdict, 'not_checked', 'the times of the version are not times: the tool cannot place the signature in the version');
    assert.equal(r.reason, 'answer_unreadable');
    assert.deepEqual(r.version, { versionId: null, nextVersionId: null, created: null, updated: null, nextUpdate: null });
    assert.equal(r.now.effective, null);
    assert.equal(r.now.deactivated, false, 'only the value true counts');
  });

  test('members of the wrong type that the check does not need are left out of the answer, and the verdict does not change', async () => {
    const r = await verify(documentAnswer({ nextVersionId: undefined, nextUpdate: undefined, vectorCurrent: 'active', deactivated: 'true', canonicalId: 1, vectorKeys: 7, vectorParties: 'x', vectorProfile: [] }));
    assert.equal(r.verdict, 'valid');
    assert.equal(r.version!.versionId, '5');
    assert.equal(r.now.effective, null);
    assert.equal(r.now.deactivated, false);
    assert.match(r.summary, /Version 5 of the DID/);
  });

  test('text of the gateway that tries to break a line, a table, a code block or the order of the text is cleaned in every fact', async () => {
    const dirty = 'ok\n# Heading `code` | cell \u202e\u200b\u0000end';
    const r = await verify(documentAnswer({
      versionId: dirty, nextVersionId: dirty, created: dirty, updated: dirty, nextUpdate: dirty, vectorCurrent: { effective: dirty, effectiveReason: dirty },
      vectorStatus: { status: dirty, effective: 'suspended', effectiveReason: dirty, reason: dirty, at: dirty },
    }));
    const facts = [...Object.values(r.version!), ...Object.values(r.statusAtTime!), r.now.effective, r.now.effectiveReason, r.summary, ...r.checks.map((c) => c.detail)];
    for (const fact of facts) {
      if (fact === null) continue;
      assert.doesNotMatch(String(fact), /[\n\r`|\u202e\u200b\u0000]/, String(fact));
    }
    assert.ok(Object.values(r.version!).every((v) => typeof v === 'string' && v.length <= 32), 'a fact is cut to its limit');
  });

  test('a long text in the answer is cut, and the cut does not cost time', async () => {
    const huge = 'x'.repeat(900_000);
    const started = performance.now();
    const r = await verify(documentAnswer({ versionId: huge, effectiveReason: huge, vectorStatus: { status: huge, effective: 'suspended', effectiveReason: huge, reason: huge, at: huge, invalidFrom: huge } }));
    assert.ok(performance.now() - started < 2000);
    assert.ok(r.statusAtTime!.effectiveReason!.length <= 64);
    assert.ok(r.version!.versionId!.length <= 32);
  });

  test('a document with 30,000 methods and 100,000 entries in a relationship: bounded work, the key at the end is found, and the list is cut', async () => {
    const doc = standardDocument();
    const methods = doc.verificationMethod as Array<Record<string, unknown>>;
    for (let i = 0; i < 30_000; i += 1) methods.push({ id: `${DID}#${i.toString(16).padStart(56, '0')}`, type: 'Multikey', controller: DID, publicKeyMultibase: 'z1' });
    doc.authentication = Array.from({ length: 100_000 }, (_, i) => `#${i.toString(16).padStart(56, '0')}`);
    const started = performance.now();
    const r = await verify(documentAnswer({}, doc), { purpose: 'assertionMethod' });
    assert.equal(r.verdict, 'valid');
    assert.equal(r.listedKeys.length, 16);
    assert.equal(r.moreKeys, 3 + 30_000 - 16);
    const asked = await verify(documentAnswer({}, doc), { key: 'ff'.repeat(28) });
    assert.equal(asked.reason, 'key_not_listed');
    assert.ok(performance.now() - started < 5000);
  });

  test('the key under test is listed with a purpose name that the answer writes in another form: still not for the purpose', async () => {
    const r = await against((d) => { d.assertion = [`#${LISTED.keyHash}`]; d.assertionMethod = undefined; });
    assert.equal(r.reason, 'purpose_missing');
  });

  test('a signature check that throws is not a pass', () => {
    // The key bytes of the answer are 32 bytes of a point that is not on the curve: the library of the ledger gives false, or throws.
    const offCurve = Buffer.alloc(32, 0xff);
    const hash = keyHashOf(offCurve.toString('hex'));
    const doc = didDocument([{ key: LISTED, purposes: ['assertionMethod'] }]);
    (doc.verificationMethod as Array<Record<string, unknown>>).push({ id: `${DID}#${hash}`, type: 'Multikey', controller: DID, publicKeyMultibase: `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), offCurve]))}` });
    doc.assertionMethod = [`#${LISTED.keyHash}`, `#${hash}`];
    const { result } = judge(requestOf({ key: hash }), documentAnswer({}, doc), CONTEXT);
    assert.equal(result.verdict, 'invalid');
    assert.equal(result.reason, 'signature_mismatch');
  });
});

describe('a change to a member that the decision reads never gives VALID, and no change makes the check throw', () => {
  type Json = Record<string, unknown>;
  interface Answer { status: unknown; result: Json }
  const isObjectLike = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
  /** The answer for the request of `requestOf`: every check passes. A test changes a copy of it. */
  const validAnswer = (): Answer => ({ status: 200, result: JSON.parse(JSON.stringify(documentAnswer().result)) as Json });
  /** The answer as the client of the gateway gives it: the body is the text of the result. The status of a test can be any value, so the type is a cast. */
  const asGatewayAnswer = (answer: Answer): GatewayAnswer => ({ status: answer.status, body: JSON.stringify(answer.result), result: answer.result }) as unknown as GatewayAnswer;
  const judged = (answer: Answer): SignatureAtResult => judge(requestOf(), asGatewayAnswer(answer), CONTEXT).result;
  const DELETE = Symbol('delete the member');
  /** Values that a hostile or broken gateway can write in place of a member. None of them is a valid value for any member of the answer. */
  const JUNK: unknown[] = [
    DELETE, null, true, false, 0, -1, 1.5, 1e308, '', ' ', 'x', 'z', 'null', [], [null], [[]], {}, { a: 1 }, 'a'.repeat(2000),
    '2026-11-03T15:56:00.5Z', '9999-99-99T99:99:99Z', JSON.parse('{"__proto__":{"effective":"active"}}'),
  ];
  /** A copy of a junk value: the values of JUNK are shared by every round, and a change must not put a value into itself. */
  const copyOf = (value: unknown): unknown => (typeof value === 'symbol' ? value : structuredClone(value));
  /** Changes the member at `path` of the answer. A path that the answer does not have any more is left alone. */
  function change(answer: Answer, path: string[], value: unknown): void {
    let node: unknown = answer.result;
    for (const step of path.slice(0, -1)) node = isObjectLike(node) ? node[step] : undefined;
    if (!isObjectLike(node)) return;
    const last = path[path.length - 1];
    if (value === DELETE) delete node[last];
    else node[last] = copyOf(value);
  }
  /** The checks that VALID needs, made again on the answer, without the code of the check. */
  function stillValid(answer: Answer): boolean {
    const doc = isJsonObject(answer.result.didDocument) ? answer.result.didDocument : null;
    const resolution = isJsonObject(answer.result.didResolutionMetadata) ? answer.result.didResolutionMetadata : null;
    const meta = isJsonObject(answer.result.didDocumentMetadata) ? answer.result.didDocumentMetadata : null;
    const recordStatus = meta !== null && isJsonObject(meta.vectorStatus) ? meta.vectorStatus : null;
    const ledger = meta !== null && isJsonObject(meta.vectorLedger) ? meta.vectorLedger : null;
    const wanted = `${DID}#${LISTED.keyHash}`;
    const method = doc !== null && Array.isArray(doc.verificationMethod) ? doc.verificationMethod.find((m) => isJsonObject(m) && m.id === wanted) : undefined;
    const named = doc !== null && Array.isArray(doc.assertionMethod) && doc.assertionMethod.some((entry) => entry === `#${LISTED.keyHash}` || entry === wanted);
    const wholeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    return (answer.status === 200 || answer.status === 410)
      && ((resolution === null ? undefined : resolution.error) ?? null) === null
      && doc !== null && doc.id === DID && isJsonObject(method) && method.publicKeyMultibase === LISTED.multibase && named
      && isJsonObject(method) && method.type === 'Multikey' && method.controller === DID
      && recordStatus !== null && recordStatus.effective === 'active' && (recordStatus.status === 'active' || recordStatus.status === 'suspended') && (recordStatus.effectiveReason ?? null) === null
      && meta !== null && typeof meta.versionId === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(meta.versionId)
      && typeof meta.updated === 'string' && (typeof meta.nextUpdate === 'string' || (meta.nextVersionId ?? null) === null)
      && ledger !== null && wholeNumber(ledger.blockHeight) && wholeNumber(ledger.confirmations) && GATEWAY_TIP - (ledger.blockHeight + ledger.confirmations) <= MAX_GATEWAY_LAG_BLOCKS;
  }

  test('the answer that the tests change is VALID, and its checks hold', () => {
    const { result, wantsCurrentRead } = judge(requestOf(), asGatewayAnswer(validAnswer()), CONTEXT);
    assert.equal(result.verdict, 'valid');
    assert.equal(wantsCurrentRead, false);
    assert.ok(stillValid(validAnswer()));
  });

  test('each member that a check reads, changed to each kind of junk: not VALID', () => {
    const TARGETS: Array<[string, string[]]> = [
      ['the DID of the document', ['didDocument', 'id']],
      ['the document', ['didDocument']],
      ['the methods of the document', ['didDocument', 'verificationMethod']],
      ['the id of the listed method', ['didDocument', 'verificationMethod', '1', 'id']],
      ['the key of the listed method', ['didDocument', 'verificationMethod', '1', 'publicKeyMultibase']],
      ['the controller of the listed method', ['didDocument', 'verificationMethod', '1', 'controller']],
      ['the type of the listed method', ['didDocument', 'verificationMethod', '1', 'type']],
      ['the methods that name the key for the purpose', ['didDocument', 'assertionMethod']],
      ['the first entry of the methods that name the key for the purpose', ['didDocument', 'assertionMethod', '0']],
      ['the metadata of the document', ['didDocumentMetadata']],
      ['the version id', ['didDocumentMetadata', 'versionId']],
      ['the status block of the version', ['didDocumentMetadata', 'vectorStatus']],
      ['the effective status', ['didDocumentMetadata', 'vectorStatus', 'effective']],
      ['the record status', ['didDocumentMetadata', 'vectorStatus', 'status']],
      ['the start of the version', ['didDocumentMetadata', 'updated']],
      ['the next update', ['didDocumentMetadata', 'nextUpdate']],
      ['the ledger of the version', ['didDocumentMetadata', 'vectorLedger']],
      ['the block height of the ledger of the version', ['didDocumentMetadata', 'vectorLedger', 'blockHeight']],
      ['the confirmations of the ledger of the version', ['didDocumentMetadata', 'vectorLedger', 'confirmations']],
    ];
    for (const [what, path] of TARGETS) {
      for (const junk of JUNK) {
        const answer = validAnswer();
        change(answer, path, junk);
        const result = judged(answer);
        assert.notEqual(result.verdict, 'valid', `${what}: ${junk === DELETE ? 'deleted' : JSON.stringify(junk)?.slice(0, 40)}`);
        assert.doesNotThrow(() => JSON.stringify(result));
      }
    }
  });

  test('a member that the valid answer does not have, with any value but null: not VALID (an error member, a reason for a status that is active)', () => {
    for (const path of [['didResolutionMetadata', 'error'], ['didDocumentMetadata', 'vectorStatus', 'effectiveReason']]) {
      for (const junk of JUNK.filter((j) => j !== DELETE && j !== null)) {
        const answer = validAnswer();
        change(answer, path, junk);
        assert.notEqual(judged(answer).verdict, 'valid', `${path.join('.')}: ${JSON.stringify(junk)?.slice(0, 40)}`);
      }
    }
  });

  test('a status that is not 200 or 410: not VALID', () => {
    for (const status of [0, 100, 199, 201, 204, 301, 400, 404, 500, 503, Number.NaN, '200', null, undefined, {}, [200]]) {
      const answer = validAnswer();
      answer.status = status;
      assert.notEqual(judged(answer).verdict, 'valid', String(status));
    }
  });

  test('random changes of up to three members: no throw, a verdict that can be written as JSON, and no VALID for an answer that fails a check', () => {
    let seed = 20_261_103;
    const random = (): number => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed / 2 ** 32; };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    const pathsOf = (value: unknown, prefix: string[] = []): string[][] =>
      (value !== null && typeof value === 'object' ? Object.keys(value).flatMap((key) => [[...prefix, key], ...pathsOf((value as Record<string, unknown>)[key], [...prefix, key])]) : []);
    const paths = pathsOf(validAnswer().result);
    const statuses = [200, 200, 200, 200, 410, 404, 500, 'x', null];
    let valid = 0;
    for (let round = 0; round < 4000; round += 1) {
      const answer = validAnswer();
      answer.status = pick(statuses);
      for (let k = 0, n = 1 + Math.floor(random() * 3); k < n; k += 1) change(answer, pick(paths), pick(JUNK));
      const result = judged(answer);
      assert.ok(['valid', 'invalid', 'not_checked'].includes(result.verdict));
      assert.doesNotThrow(() => JSON.stringify(result));
      if (result.verdict === 'valid') {
        valid += 1;
        assert.ok(stillValid(answer), `VALID for an answer that fails a check: ${JSON.stringify(answer).slice(0, 300)}`);
      }
    }
    assert.ok(valid > 100, `some changes touch nothing that the decision reads, so some answers stay VALID (${valid})`);
  });
});

describe('judge', () => {
  test('reads nothing from the network and gives the same result as verifySignatureAt for the first answer', async () => {
    const answer = documentAnswer();
    const direct = judge(requestOf(), answer, CONTEXT);
    assert.equal(direct.wantsCurrentRead, false);
    assert.deepEqual(direct.result, await verifySignatureAt(requestOf(), accessOf(fakeGateway(answer).resolve)));
  });

  test('says that a second read is wanted only for a DID that is deactivated now and has a document of the time', () => {
    assert.equal(judge(requestOf(), documentAnswer({ deactivated: true }, standardDocument(), 410), CONTEXT).wantsCurrentRead, true);
    assert.equal(judge(requestOf(), documentAnswer({ deactivated: true }, standardDocument(), 410), CONTEXT).result.verdict, 'valid');
    assert.equal(judge(requestOf(), answerOf(410, { didDocumentMetadata: metadata({ deactivated: true, vectorStatus: { status: 'revoked', effective: 'revoked' } }) }), CONTEXT).wantsCurrentRead, false);
    assert.equal(judge(requestOf(), errorAnswer(404, 'NOT_FOUND'), CONTEXT).wantsCurrentRead, false);
  });
});

describe('the fixed sentence', () => {
  test('says that the time is a claim, and what an auditor needs', () => {
    assert.equal(TIME_CLAIM_NOTE, 'The time is the claim of the caller. The tool cannot prove when the signature was made. An auditor needs a time anchor, for example a transaction.');
  });
});

describe('a time that is less than 10 minutes before now, or in the future: NOT CHECKED (too_recent), and nobody is asked', () => {
  /** An answer for the latest version, so that a time after the version started can be VALID. */
  const latest = (): GatewayAnswer => documentAnswer({ nextVersionId: undefined, nextUpdate: undefined });
  /** The access of a call at the clock `now`, with a node tip at that time (so the clock of the server decides): it counts the reads of the gateway and of the node. */
  function counted(now: number, answer: GatewayAnswer = latest()) {
    const gateway = fakeGateway(answer);
    const nodeReads: number[] = [];
    const access: SignatureAtAccess = { resolve: gateway.resolve, now: () => now, nodeTip: async () => { nodeReads.push(1); return nodeAt(GATEWAY_TIP, now); } };
    return { gateway, nodeReads, access };
  }

  test('exactly 10 minutes before now is old enough, and 1 second less is too recent', async () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const edge = counted(now);
    const old = await verifySignatureAt(requestOf({ at: '2026-11-20T11:50:00Z' }), edge.access);
    assert.equal(old.verdict, 'valid', 'exactly 10 minutes');
    assert.equal(edge.gateway.calls.length, 1);
    const recent = counted(now);
    const r = await verifySignatureAt(requestOf({ at: '2026-11-20T11:50:01Z' }), recent.access);
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'too_recent');
    assert.equal(r.summary, 'The time is less than 10 minutes before now. A change after the time can still have fewer than 30 confirmations, and the gateway does not show it, so the tool cannot decide.');
    assert.deepEqual([recent.gateway.calls.length, recent.nodeReads.length], [0, 0], 'neither the gateway nor the node is asked');
    assert.equal(r.asked, false);
    assert.equal(r.httpStatus, null);
    assert.equal(r.version, null);
    assert.deepEqual(resultsOf(r), { ...Object.fromEntries(Object.keys(ALL_PASS).map((id) => [id, 'not_applicable'])), time_age: 'unknown' });
    assert.equal(MIN_AGE_MS, 600_000);
  });

  test('the edge holds for a clock with milliseconds: the time is compared with now minus 10 minutes to the millisecond', async () => {
    const now = Date.parse('2026-11-20T12:00:00.500Z');
    assert.equal((await verifySignatureAt(requestOf({ at: '2026-11-20T11:50:00Z' }), counted(now).access)).verdict, 'valid');
    assert.equal((await verifySignatureAt(requestOf({ at: '2026-11-20T11:50:01Z' }), counted(now).access)).reason, 'too_recent');
  });

  test('a time in the future is too recent, and the text says that it is in the future', async () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    for (const at of ['2026-11-20T12:00:01Z', '2026-11-20T12:00:00Z', '2026-12-01T00:00:00Z', '2999-01-01T00:00:00Z']) {
      const run = counted(now);
      const r = await verifySignatureAt(requestOf({ at }), run.access);
      assert.equal(r.verdict, 'not_checked', at);
      assert.equal(r.reason, 'too_recent');
      assert.equal(run.gateway.calls.length, 0);
    }
    const future = await verifySignatureAt(requestOf({ at: '2026-11-20T12:00:01Z' }), counted(now).access);
    assert.equal(future.summary, 'The time is in the future. A signature cannot be made in the future, so the tool cannot decide.');
    const nowItself = await verifySignatureAt(requestOf({ at: '2026-11-20T12:00:00Z' }), counted(now).access);
    assert.match(nowItself.summary, /^The time is less than 10 minutes before now\./);
  });

  test('a time that is too recent is not decided by an answer, a failure or a check that would fail', async () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const failing: SignatureAtAccess = { resolve: async () => { throw new Error('the gateway must not be asked'); }, now: () => now, nodeTip: async () => { throw new Error('the node must not be asked'); } };
    const r = await verifySignatureAt(requestOf({ at: '2026-11-20T11:55:00Z', signature_hex: 'ab'.repeat(64), key: STRANGER.keyHash }), failing);
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'too_recent');
    const direct = judge(requestOf({ at: '2026-11-20T11:55:00Z' }), documentAnswer(), { nowMs: now, node: nodeAt(GATEWAY_TIP, now - 5_000) });
    assert.equal(direct.result.verdict, 'not_checked', 'an answer that would give VALID does not decide');
    assert.equal(direct.result.reason, 'too_recent');
    assert.equal(judge(requestOf({ at: '2026-11-20T11:55:00Z' }), null, { nowMs: now, node: nodeAt(GATEWAY_TIP, now - 5_000) }).result.reason, 'too_recent');
  });

  test('a time that is old enough passes the check of the age, and says so', async () => {
    const r = await verify(documentAnswer());
    assert.equal(r.checks[0].id, 'time_age');
    assert.equal(r.checks[0].result, 'pass');
    assert.equal(r.checks[0].detail, 'The time is at least 10 minutes before now, and at least 10 minutes before the tip block of the node.');
    const unreadable = judge(requestOf(), documentAnswer(), { nowMs: NOW, node: { height: null, why: 'x' } }).result;
    assert.equal(unreadable.checks[0].detail, 'The time is at least 10 minutes before now.', 'a node tip that is not known gives no comparison with it');
  });
});

describe('a time that is less than 10 minutes before the tip block of the node: NOT CHECKED (too_recent), also when the clock of the server says that the time is old enough', () => {
  /** An answer for the latest version, so that a time after the version started can be VALID. */
  const latest = (): GatewayAnswer => documentAnswer({ nextVersionId: undefined, nextUpdate: undefined });
  const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  /** The decision for the time `atMs` (whole seconds) at the clock NOW, with the given tip of the node, for the latest version of the DID. */
  const judgedAt = (atMs: number, node: JudgeContext['node'], answer: GatewayAnswer = latest()): SignatureAtResult =>
    judge(requestOf({ at: iso(atMs) }), answer, { nowMs: NOW, node }).result;
  const CHAIN_NOTE = 'The time is less than 10 minutes before the tip block of the node, or after it. A change after the time can still have fewer than 30 confirmations, and the gateway does not show it, so the tool cannot decide.';

  test('the probe: a node tip that is 600 s old, a gateway that is 30 blocks behind it, and a time of exactly 10 minutes before now', () => {
    const r = judgedAt(NOW - MIN_AGE_MS, nodeAt(GATEWAY_TIP + MAX_GATEWAY_LAG_BLOCKS, NOW - MAX_NODE_TIP_AGE_MS));
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'too_recent');
    assert.equal(r.summary, CHAIN_NOTE);
    assert.equal(judgedAt(NOW - MIN_AGE_MS, nodeAt(GATEWAY_TIP + MAX_GATEWAY_LAG_BLOCKS, NOW - 590_000)).reason, 'too_recent', 'a node tip of 590 s (a clock that is 9 minutes 50 seconds ahead) gives the same');
    assert.equal(judgedAt(NOW - MIN_AGE_MS, nodeAt(GATEWAY_TIP + MAX_GATEWAY_LAG_BLOCKS, NOW)).verdict, 'valid', 'the same time with a node tip at the clock of the server: each limit is met');
  });

  test('the edge: a time exactly 10 minutes before the tip block passes, and a time one second later does not', () => {
    const tip = NOW - 5_000;
    assert.equal(judgedAt(tip - MIN_AGE_MS, nodeAt(GATEWAY_TIP, tip)).verdict, 'valid');
    const r = judgedAt(tip - MIN_AGE_MS + 1000, nodeAt(GATEWAY_TIP, tip));
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'too_recent');
    assert.equal(r.summary, CHAIN_NOTE);
  });

  test('the edge to the millisecond: the tip block is compared with the time as it is', () => {
    const atMs = NOW - 700_000;
    assert.equal(judgedAt(atMs, nodeAt(GATEWAY_TIP, atMs + MIN_AGE_MS)).verdict, 'valid');
    assert.equal(judgedAt(atMs, nodeAt(GATEWAY_TIP, atMs + MIN_AGE_MS - 1)).reason, 'too_recent');
  });

  test('a node tip that is after the clock of the server: the clock decides, with its own text', () => {
    const ahead = nodeAt(GATEWAY_TIP, NOW + 60_000);
    assert.equal(judgedAt(NOW - MIN_AGE_MS, ahead).verdict, 'valid');
    const r = judgedAt(NOW - MIN_AGE_MS + 1000, ahead);
    assert.equal(r.reason, 'too_recent');
    assert.match(r.summary, /^The time is less than 10 minutes before now\./);
  });

  test('a node tip that the tool could not read: the time is not compared with it, and the check of the tip gives the reason', () => {
    const r = judgedAt(NOW - 700_000, { height: null, why: 'the read of the node failed or took too long' });
    assert.equal(r.reason, 'tip_unreadable');
    assert.equal(r.checks[0].result, 'pass');
    assert.equal(r.checks[0].detail, 'The time is at least 10 minutes before now.');
  });

  test('the result shows what was asked: the gateway was asked, both tips are known, the other checks did not run, and no second read is wanted', () => {
    const deactivated = documentAnswer({ deactivated: true, vectorCurrent: { effective: 'revoked' } }, standardDocument(), 410);
    const { result, wantsCurrentRead } = judge(requestOf({ at: iso(NOW - MIN_AGE_MS) }), deactivated, { nowMs: NOW, node: nodeAt(GATEWAY_TIP, NOW - 300_000) });
    assert.equal(result.reason, 'too_recent');
    assert.equal(result.asked, true);
    assert.equal(result.httpStatus, 410);
    assert.deepEqual(result.tips, { gateway: GATEWAY_TIP, node: GATEWAY_TIP });
    assert.equal(wantsCurrentRead, false);
    assert.deepEqual(resultsOf(result), { ...Object.fromEntries(Object.keys(ALL_PASS).map((id) => [id, 'not_applicable'])), time_age: 'unknown' });
  });

  test('a check that would fail does not matter: the time that is too recent on the chain gives NOT CHECKED before the other checks', () => {
    const r = judge(requestOf({ at: iso(NOW - MIN_AGE_MS), signature_hex: 'ab'.repeat(64), key: STRANGER.keyHash }), latest(), { nowMs: NOW, node: nodeAt(GATEWAY_TIP, NOW - 300_000) });
    assert.equal(r.result.verdict, 'not_checked');
    assert.equal(r.result.reason, 'too_recent');
  });

  test('through verifySignatureAt: both reads are made, and the result is NOT CHECKED (too_recent)', async () => {
    const gateway = fakeGateway(latest());
    const nodeReads: number[] = [];
    const access: SignatureAtAccess = { resolve: gateway.resolve, now: () => NOW, nodeTip: async () => { nodeReads.push(1); return nodeAt(GATEWAY_TIP + MAX_GATEWAY_LAG_BLOCKS, NOW - MAX_NODE_TIP_AGE_MS); } };
    const r = await verifySignatureAt(requestOf({ at: iso(NOW - MIN_AGE_MS) }), access);
    assert.equal(r.reason, 'too_recent');
    assert.equal(r.asked, true);
    assert.deepEqual([gateway.calls.length, nodeReads.length], [1, 1]);
  });
});

describe('the gateway is current: the tip of the node is at most 10 minutes old, and the ledger tip of the gateway is at most 30 blocks behind it', () => {
  const judgedWith = (node: JudgeContext['node'], answer: GatewayAnswer = documentAnswer(), over: RawSignatureAtInput = {}): SignatureAtResult =>
    judge(requestOf(over), answer, { nowMs: NOW, node }).result;
  const gatewayLine = (r: SignatureAtResult) => r.checks.find((c) => c.id === 'gateway_current')!;
  /** The tip of the node at the height of the gateway, from a block that is `age` milliseconds before NOW. */
  const tipOfAge = (age: number): NodeTipRead => nodeAt(GATEWAY_TIP, NOW - age);

  test('a gateway at the tip of the node, a few blocks behind, exactly 30 behind, and ahead of the node: current', () => {
    for (const lag of [0, 1, 29, MAX_GATEWAY_LAG_BLOCKS, -1, -1000]) {
      const r = judgedWith(nodeAt(GATEWAY_TIP + lag));
      assert.equal(r.verdict, 'valid', `lag ${lag}`);
      assert.equal(gatewayLine(r).result, 'pass');
      assert.deepEqual(r.tips, { gateway: GATEWAY_TIP, node: GATEWAY_TIP + lag });
    }
    assert.equal(gatewayLine(judgedWith(nodeAt(GATEWAY_TIP + 5))).detail, `The tip of the node (block ${GATEWAY_TIP + 5}) is at most 10 minutes old, and the ledger tip of the gateway (block ${GATEWAY_TIP}) is at most 30 blocks behind it.`);
  });

  test('a gateway that is 31 blocks behind, or more: NOT CHECKED (gateway_behind), and the text names both tips', () => {
    for (const lag of [MAX_GATEWAY_LAG_BLOCKS + 1, 100, 10_000, 9_000_000]) {
      const r = judgedWith(nodeAt(GATEWAY_TIP + lag));
      assert.equal(r.verdict, 'not_checked', `lag ${lag}`);
      assert.equal(r.reason, 'gateway_behind');
      assert.equal(gatewayLine(r).result, 'unknown');
      assert.equal(r.summary, `The gateway is ${lag} blocks behind the node: the tip of the gateway is block ${GATEWAY_TIP}, and the tip of the node is block ${GATEWAY_TIP + lag}. A change after the tip of the gateway is not in its answer, so the tool cannot decide.`);
      assert.deepEqual(resultsOf(r), resultsWith({ gateway_current: 'unknown' }), 'every other check passes');
    }
  });

  test('a tip of the node that is older than 10 minutes: NOT CHECKED (tip_stale), and a tip of exactly 10 minutes is current', () => {
    const edge = judgedWith(tipOfAge(MAX_NODE_TIP_AGE_MS));
    assert.equal(edge.verdict, 'valid', 'exactly 10 minutes');
    assert.equal(gatewayLine(edge).result, 'pass');
    for (const age of [MAX_NODE_TIP_AGE_MS + 1, MAX_NODE_TIP_AGE_MS + 1000, 3_600_000, 86_400_000]) {
      const r = judgedWith(tipOfAge(age));
      assert.equal(r.verdict, 'not_checked', `age ${age}`);
      assert.equal(r.reason, 'tip_stale', `age ${age}`);
      assert.equal(gatewayLine(r).result, 'unknown');
      assert.equal(r.summary, `The tip of the node (block ${GATEWAY_TIP}) is ${Math.ceil(age / 1000)} seconds old. The limit is 600 seconds. A node that is behind is no reference for the tip of the chain, so the tool cannot tell whether the gateway is current. The tool cannot decide.`);
      assert.deepEqual(resultsOf(r), resultsWith({ gateway_current: 'unknown' }), 'every other check passes');
      assert.deepEqual(r.tips, { gateway: GATEWAY_TIP, node: GATEWAY_TIP });
    }
    // A tip that is older than the time of the request: the time is too recent on the chain, and that check comes first.
    assert.equal(judgedWith(tipOfAge(NOW - VECTOR_START_MS)).reason, 'too_recent');
    assert.equal(MAX_NODE_TIP_AGE_MS, 600_000);
  });

  test('a tip of the node that is as new as the clock, or after it, is not stale', () => {
    for (const age of [0, 1, -1000, -3_600_000]) assert.equal(judgedWith(tipOfAge(age)).verdict, 'valid', `age ${age}`);
  });

  test('a stale tip of the node and a gateway that is behind it: the stale tip is the reason, because the node is no reference', () => {
    const r = judgedWith(nodeAt(GATEWAY_TIP + 500, NOW - 700_000));
    assert.equal(r.reason, 'tip_stale');
    assert.equal(r.verdict, 'not_checked');
  });

  test('a tip of the node that the tool could not read: NOT CHECKED (tip_unreadable), and the text says why', () => {
    const r = judgedWith({ height: null, why: 'the read of the node failed or took too long' });
    assert.equal(r.verdict, 'not_checked');
    assert.equal(r.reason, 'tip_unreadable');
    assert.equal(r.summary, 'The tool could not read the tip of the node (the read of the node failed or took too long), so it cannot tell whether the gateway is current. The tool cannot decide.');
    assert.deepEqual(r.tips, { gateway: GATEWAY_TIP, node: null });
  });

  test('a tip of the gateway that the answer does not give as two whole numbers: NOT CHECKED (tip_unreadable)', () => {
    const ledger = (over: Record<string, unknown>): Record<string, unknown> => ({ blockHeight: 9_184_115, confirmations: GATEWAY_TIP - 9_184_115, ...over });
    const cases: unknown[] = [
      undefined, null, 'x', 5, [], [ledger({})], {}, ledger({ blockHeight: undefined }), ledger({ confirmations: undefined }), ledger({ blockHeight: null }), ledger({ confirmations: null }),
      ledger({ blockHeight: '9184115' }), ledger({ confirmations: '364343' }), ledger({ blockHeight: 1.5 }), ledger({ confirmations: 0.5 }), ledger({ blockHeight: -1 }),
      ledger({ confirmations: -1 }), ledger({ blockHeight: 1e308 }), ledger({ confirmations: 1e308 }), ledger({ blockHeight: Number.MAX_SAFE_INTEGER, confirmations: 10 }),
      ledger({ blockHeight: true }), ledger({ confirmations: [1] }), ledger({ blockHeight: {} }),
      ledger({ blockHeight: 9_184_115.5, confirmations: GATEWAY_TIP - 9_184_115.5 }), ledger({ blockHeight: 0.5, confirmations: 0.5 }),
      ledger({ blockHeight: -5, confirmations: GATEWAY_TIP + 5 }), ledger({ blockHeight: GATEWAY_TIP + 5, confirmations: -5 }),
    ];
    for (const vectorLedger of cases) {
      const r = judgedWith(nodeAt(GATEWAY_TIP), documentAnswer({ vectorLedger }));
      assert.equal(r.verdict, 'not_checked', JSON.stringify(vectorLedger));
      assert.equal(r.reason, 'tip_unreadable');
      assert.equal(r.tips.gateway, null);
      assert.match(r.summary, /^The gateway answer does not give the ledger tip of the gateway/);
    }
  });

  test('a tip of the gateway of 0 blocks and confirmations that add up: read, and compared', () => {
    const early = documentAnswer({ vectorLedger: { blockHeight: 0, confirmations: 10 } });
    assert.equal(judgedWith(nodeAt(41), early).reason, 'gateway_behind');
    assert.equal(judgedWith(nodeAt(41), early).tips.gateway, 10);
    assert.equal(judgedWith(nodeAt(40), early).verdict, 'valid', '30 blocks behind');
    assert.equal(judgedWith(nodeAt(40), documentAnswer({ vectorLedger: { blockHeight: 20, confirmations: 15 } })).verdict, 'valid');
  });

  test('a check that fails still gives INVALID next to a gateway that is behind, a stale node or an unreadable tip: the unknown check never hides a failure', () => {
    const random = judgedWith(nodeAt(GATEWAY_TIP + 500), documentAnswer(), { signature_hex: 'ab'.repeat(64) });
    assert.equal(random.verdict, 'invalid');
    assert.equal(random.reason, 'signature_mismatch');
    assert.deepEqual(resultsOf(random), resultsWith({ gateway_current: 'unknown', signature: 'fail' }));
    const stale = judgedWith(tipOfAge(MAX_NODE_TIP_AGE_MS + 1), documentAnswer(), { signature_hex: 'ab'.repeat(64) });
    assert.equal(stale.verdict, 'invalid');
    assert.deepEqual(resultsOf(stale), resultsWith({ gateway_current: 'unknown', signature: 'fail' }));
    const unreadable = judgedWith({ height: null, why: 'x' }, documentAnswer(), { key: STRANGER.keyHash, signature_hex: sign(STRANGER, MESSAGE) });
    assert.equal(unreadable.reason, 'key_not_listed');
  });

  test('an answer without a document or with an error has no check of the tip, and its verdict does not depend on the tip', () => {
    const gone = answerOf(410, { didDocumentMetadata: metadata({ deactivated: true, vectorStatus: { status: 'revoked', effective: 'revoked' } }) });
    for (const node of [nodeAt(GATEWAY_TIP), { height: null, why: 'x' }, nodeAt(GATEWAY_TIP + 999), tipOfAge(MAX_NODE_TIP_AGE_MS + 1)]) {
      const deactivated = judgedWith(node, gone);
      assert.equal(deactivated.reason, 'deactivated');
      assert.equal(gatewayLine(deactivated).result, 'not_applicable');
      assert.equal(judgedWith(node, errorAnswer(404, 'NOT_FOUND')).reason, 'did_not_found');
    }
  });

  test('the tip of the gateway is shown with the verdict: both tips in the result', async () => {
    const r = await verify(documentAnswer());
    assert.deepEqual(r.tips, { gateway: GATEWAY_TIP, node: GATEWAY_TIP });
  });

  describe('the read of the tip of the node, with the check of the whole', () => {
    const readWith = (nodeTip: SignatureAtAccess['nodeTip'], now: number = NOW): Promise<SignatureAtResult> =>
      verifySignatureAt(requestOf(), { resolve: fakeGateway(documentAnswer()).resolve, now: () => now, nodeTip });
    /** A read that gives `value`, whatever its type: a broken provider can give any value. */
    const gives = (value: unknown): SignatureAtAccess['nodeTip'] => (async () => value) as () => Promise<NodeTipRead>;

    test('the tip from the provider is the tip of the node, and it is read one time', async () => {
      let reads = 0;
      const r = await readWith(async () => { reads += 1; return nodeAt(GATEWAY_TIP + 3); });
      assert.equal(r.verdict, 'valid');
      assert.equal(reads, 1);
      assert.deepEqual(r.tips, { gateway: GATEWAY_TIP, node: GATEWAY_TIP + 3 });
    });

    test('a node that is 31 blocks ahead of the gateway gives NOT CHECKED (gateway_behind)', async () => {
      const r = await readWith(async () => nodeAt(GATEWAY_TIP + 31));
      assert.equal(r.reason, 'gateway_behind');
      assert.equal(r.verdict, 'not_checked');
    });

    test('the clock of the call decides if the tip is stale: 10 minutes is current, one millisecond more is stale, also for a later clock', async () => {
      assert.equal((await readWith(async () => tipOfAge(MAX_NODE_TIP_AGE_MS))).verdict, 'valid');
      const stale = await readWith(async () => tipOfAge(MAX_NODE_TIP_AGE_MS + 1));
      assert.equal(stale.verdict, 'not_checked');
      assert.equal(stale.reason, 'tip_stale');
      const later = await readWith(async () => nodeAt(GATEWAY_TIP, NODE_TIP_TIME), NODE_TIP_TIME + MAX_NODE_TIP_AGE_MS);
      assert.equal(later.verdict, 'valid', 'the tip is exactly 10 minutes old at that clock');
      assert.equal((await readWith(async () => nodeAt(GATEWAY_TIP, NODE_TIP_TIME), NODE_TIP_TIME + MAX_NODE_TIP_AGE_MS + 1)).reason, 'tip_stale');
    });

    test('a read that fails, throws at once, or gives no block height and time: NOT CHECKED (tip_unreadable), and never a throw', async () => {
      const reads: Array<[string, SignatureAtAccess['nodeTip']]> = [
        ['rejects', async () => { throw new Error('Ogmios network error'); }],
        ['throws at once', () => { throw new Error('no provider'); }],
        ['gives only a number', gives(9_548_458)],
        ['gives a text', gives('9548458')],
        ['gives origin', gives('origin')],
        ['gives nothing', gives(undefined)],
        ['gives null', gives(null)],
        ['gives a list', gives([9_548_458, NODE_TIP_TIME])],
        ['gives an empty object', gives({})],
        ['gives a list that carries a height and a time', gives(Object.assign([], { height: GATEWAY_TIP, timeMs: NODE_TIP_TIME }))],
        ['gives a function that carries a height and a time', gives(Object.assign(() => undefined, { height: GATEWAY_TIP, timeMs: NODE_TIP_TIME }))],
        ['gives a fraction as the height', gives({ height: 1.5, timeMs: NODE_TIP_TIME })],
        ['gives a negative height', gives({ height: -1, timeMs: NODE_TIP_TIME })],
        ['gives not a number as the height', gives({ height: Number.NaN, timeMs: NODE_TIP_TIME })],
        ['gives infinity as the height', gives({ height: Number.POSITIVE_INFINITY, timeMs: NODE_TIP_TIME })],
        ['gives a height that is too large', gives({ height: 2 ** 53, timeMs: NODE_TIP_TIME })],
        ['gives a text as the height', gives({ height: '9548458', timeMs: NODE_TIP_TIME })],
        ['gives no time', gives({ height: GATEWAY_TIP })],
        ['gives null as the time', gives({ height: GATEWAY_TIP, timeMs: null })],
        ['gives a text as the time', gives({ height: GATEWAY_TIP, timeMs: String(NODE_TIP_TIME) })],
        ['gives the time 0', gives({ height: GATEWAY_TIP, timeMs: 0 })],
        ['gives a negative time', gives({ height: GATEWAY_TIP, timeMs: -1 })],
        ['gives a fraction as the time', gives({ height: GATEWAY_TIP, timeMs: NODE_TIP_TIME + 0.5 })],
        ['gives not a number as the time', gives({ height: GATEWAY_TIP, timeMs: Number.NaN })],
        ['gives infinity as the time', gives({ height: GATEWAY_TIP, timeMs: Number.POSITIVE_INFINITY })],
        ['gives a time that is too large', gives({ height: GATEWAY_TIP, timeMs: 2 ** 53 })],
      ];
      for (const [what, nodeTip] of reads) {
        const r = await readWith(nodeTip);
        assert.equal(r.verdict, 'not_checked', what);
        assert.equal(r.reason, 'tip_unreadable', what);
        assert.equal(r.tips.node, null);
      }
    });

    test('a read that does not end is given up at 10 seconds and not before, and the check goes on', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const outcome = track(readWith(() => new Promise<NodeTipRead>(() => undefined)));
      t.mock.timers.tick(NODE_READ_MS - 1);
      await flush();
      assert.equal(outcome(), 'pending');
      t.mock.timers.tick(1);
      await flush();
      const r = outcome() as SignatureAtResult;
      assert.equal(r.verdict, 'not_checked');
      assert.equal(r.reason, 'tip_unreadable');
      assert.match(r.summary, /the read of the node failed or took too long/);
      assert.equal(NODE_READ_MS, 10_000);
    });

    test('the timer of the read is cleared when the read ends, and when it fails', async () => {
      const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      const before = timers();
      await readWith(async () => nodeAt(GATEWAY_TIP));
      await readWith(async () => { throw new Error('failed'); });
      assert.equal(timers(), before);
    });

    test('the error text of the provider is never shown (it can name the node)', async () => {
      const r = await readWith(async () => { throw new Error('Ogmios network error at https://ogmios.internal.example:1337'); });
      assert.doesNotMatch(r.summary, /ogmios\.internal\.example/);
      assert.doesNotMatch(JSON.stringify(r), /ogmios\.internal\.example/);
    });

    test('without a chain provider there is no tip of the node: NOT CHECKED (tip_unreadable)', async () => {
      const r = await verifySignatureAt(requestOf(), { resolve: fakeGateway(documentAnswer()).resolve, now: () => NOW });
      assert.equal(r.verdict, 'not_checked');
      assert.equal(r.reason, 'tip_unreadable');
      assert.match(r.summary, /the server has no chain provider for it/);
    });

    test('a failure of the gateway is a throw, and a failure of the node read at the same time is not an unhandled error', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const failing: SignatureAtAccess = { resolve: async () => { throw new Error('the identity gateway could not be reached'); }, now: () => NOW, nodeTip: async () => { throw new Error('the node failed'); } };
        await assert.rejects(verifySignatureAt(requestOf(), failing), /the identity gateway could not be reached/);
        await flush();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      assert.deepEqual(unhandled, []);
    });
  });
});

describe('an answer that the tool cannot read or does not trust gives NOT CHECKED (answer_unreadable)', () => {
  const unreadable = (r: SignatureAtResult, what: string): void => {
    assert.equal(r.verdict, 'not_checked', what);
    assert.equal(r.reason, 'answer_unreadable', what);
  };
  const withMethod = (over: Record<string, unknown>): GatewayAnswer => {
    const doc = standardDocument();
    const methods = doc.verificationMethod as Array<Record<string, unknown>>;
    methods[1] = { ...methods[1], ...over };
    return documentAnswer({}, doc);
  };

  test('a version id that is not a whole number as the gateway writes it (a number, a text with a sign, a space, a zero in front, nothing)', async () => {
    for (const versionId of [5, 0, 5.5, null, undefined, '', ' 5', '5 ', '05', '00', '-1', '+5', '5.0', '0x5', 'five', ['5'], {}, true, '9'.repeat(17), '１２', '5\n', '5\u200b']) {
      unreadable(await verify(documentAnswer({ versionId })), JSON.stringify(versionId));
    }
    for (const versionId of ['0', '5', '10', '123456789012345', '9'.repeat(16)]) {
      assert.equal((await verify(documentAnswer({ versionId }))).verdict, 'valid', versionId);
    }
    const r = await verify(documentAnswer({ versionId: 5 }));
    assert.equal(r.summary, 'The gateway answer gives no version id that is a whole number, so the tool cannot decide.');
    assert.equal(resultsOf(r).version, 'unknown');
  });

  test('a version id that is missing gives no VALID, also for a document of the latest version', async () => {
    unreadable(await verify(documentAnswer({ versionId: undefined, nextVersionId: undefined, nextUpdate: undefined })), 'missing');
  });

  test('a version id that is not readable does not hide a failed check: INVALID stays INVALID', async () => {
    const r = await verify(documentAnswer({ versionId: 5 }), { signature_hex: 'ab'.repeat(64) });
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'signature_mismatch');
  });

  test('a listed method whose controller is missing, empty, another DID or not a text', async () => {
    for (const controller of [undefined, null, '', OTHER_DID, `${DID} `, `${DID}#${LISTED.keyHash}`, DID.toUpperCase(), 5, [DID], { id: DID }]) {
      const r = await verify(withMethod({ controller }));
      unreadable(r, JSON.stringify(controller));
      assert.equal(r.summary, 'The method that the version lists for the key is not a Multikey method of this DID (its type is not Multikey, or its controller is missing or is not the DID), so the tool cannot decide.');
      assert.equal(resultsOf(r).key_listed, 'unknown');
    }
    assert.equal((await verify(withMethod({ controller: DID }))).verdict, 'valid');
  });

  test('a listed method whose type is not Multikey', async () => {
    for (const type of [undefined, null, '', 'multikey', 'Multikey ', 'JsonWebKey2020', 'Ed25519VerificationKey2020', 'Ed25519VerificationKey2018', 5, ['Multikey'], { type: 'Multikey' }]) {
      unreadable(await verify(withMethod({ type })), JSON.stringify(type));
    }
  });

  test('the controller and the type of a method that is not the listed one are not read', async () => {
    const doc = standardDocument();
    const methods = doc.verificationMethod as Array<Record<string, unknown>>;
    methods[0] = { ...methods[0], controller: OTHER_DID, type: 'JsonWebKey2020' };
    methods[2] = { ...methods[2], controller: undefined };
    assert.equal((await verify(documentAnswer({}, doc))).verdict, 'valid');
  });

  test('a method that fails the controller or type check gives NOT CHECKED for each purpose that lists it, and a key that is not listed for the purpose is INVALID as before', async () => {
    unreadable(await verify(withMethod({ controller: OTHER_DID }), { purpose: 'authentication' }), 'authentication lists the same key');
    const doc = didDocument([{ key: LISTED, purposes: ['capabilityInvocation'] }]);
    (doc.verificationMethod as Array<Record<string, unknown>>)[0].controller = OTHER_DID;
    assert.equal((await verify(documentAnswer({}, doc))).reason, 'purpose_missing');
  });

  test('an effective status of active with a record status that is revoked, retired, missing or not a status', async () => {
    for (const status of ['revoked', 'retired', undefined, null, '', 'Active', 'x', 5, ['active'], {}, true]) {
      const r = await verify(documentAnswer({ vectorStatus: { status, effective: 'active' } }));
      unreadable(r, JSON.stringify(status));
      assert.equal(r.summary, 'The status and the effective status of the version do not agree (a record that is revoked or retired, or a reason for a status that is active), so the tool cannot decide.');
      assert.equal(resultsOf(r).status, 'unknown');
    }
  });

  test('an effective status of active with a reason for a status that is not active', async () => {
    for (const effectiveReason of ['invalidated', 'parentRevoked', 'unaccountable', 'x', '', 0, false, [], {}]) {
      unreadable(await verify(documentAnswer({ vectorStatus: { status: 'active', effective: 'active', effectiveReason } })), JSON.stringify(effectiveReason));
    }
  });

  test('a record that is suspended with holds that ended has an effective status of active, and that stays VALID', async () => {
    assert.equal((await verify(documentAnswer({ vectorStatus: { status: 'suspended', effective: 'active' } }))).verdict, 'valid');
    assert.equal((await verify(documentAnswer({ vectorStatus: { status: 'active', effective: 'active', effectiveReason: null } }))).verdict, 'valid');
  });

  test('a status that disagrees does not hide a failed check: INVALID stays INVALID', async () => {
    const r = await verify(documentAnswer({ vectorStatus: { status: 'revoked', effective: 'active' } }), { signature_hex: 'ab'.repeat(64) });
    assert.equal(r.verdict, 'invalid');
    assert.equal(r.reason, 'signature_mismatch');
  });

  /** An answer of the client of the gateway for a text: the body is the text, and the result is what the parser makes of it (the last member of a name wins). */
  const fromText = (body: string, status = 200): GatewayAnswer => ({ status, body, result: JSON.parse(body) as GatewayAnswer['result'] });
  const validText = (): string => JSON.stringify(documentAnswer().result);

  test('a member name that appears twice in one object: the parser keeps the last, and the tool does not trust the answer', () => {
    const text = validText();
    const duplicated: Array<[string, string]> = [
      ['effective twice in the status block', text.replace('"status":"active","effective":"active"', '"status":"active","effective":"revoked","effective":"active"')],
      ['effective twice, the active one first', text.replace('"status":"active","effective":"active"', '"status":"active","effective":"active","effective":"active"')],
      ['invalidFrom twice, the last null', text.replace('"effective":"active"}', '"effective":"active","invalidFrom":"2026-01-01T00:00:00Z","invalidFrom":null}')],
      ['nextUpdate twice', text.replace('"nextUpdate":"2026-11-03T15:56:44Z"', '"nextUpdate":"2026-11-03T15:55:00Z","nextUpdate":"2026-11-03T15:56:44Z"')],
      ['updated twice', text.replace('"updated":"2026-11-03T15:53:53Z"', '"updated":"2026-11-03T15:53:53Z","updated":"2026-11-03T15:53:53Z"')],
      ['didDocument twice', text.replace('{"didDocument":', '{"didDocument":{},"didDocument":')],
      ['didDocumentMetadata twice', `${text.slice(0, -1)},"didDocumentMetadata":{}}`],
      ['a name that is written with an escape', text.replace('"status":"active","effective":"active"', '"status":"active","effective":"revoked","\\u0065ffective":"active"')],
      ['a name with an escaped quote, twice', text.replace('"versionId":"5"', '"a\\"b":1,"a\\"b":2,"versionId":"5"')],
      ['a method with its id twice', text.replace('"type":"Multikey"', '"type":"Multikey","type":"Multikey"')],
      ['an object in a list with a name twice', text.replace('"verificationMethod":[', '"verificationMethod":[{"id":"x","id":"y"},')],
    ];
    for (const [what, body] of duplicated) {
      assert.notEqual(body, text, `${what}: the text was changed`);
      const r = judge(requestOf(), fromText(body), CONTEXT).result;
      unreadable(r, what);
      assert.equal(r.summary, 'The gateway answer names a member twice in one object, so the tool cannot trust it. The tool cannot decide.', what);
    }
  });

  test('the same name in different objects, in a parent and its child, or in the items of a list is not a duplicate', () => {
    const text = validText();
    const same = text.replace('"nextUpdate"', '"extra":{"effective":"x","extra":{"effective":"y"}},"extras":[{"effective":1},{"effective":2}],"nextUpdate"');
    assert.notEqual(same, text);
    assert.equal(judge(requestOf(), fromText(same), CONTEXT).result.verdict, 'valid');
  });

  test('a duplicate name makes no VALID, and no NOT_FOUND INVALID either: the whole body is not trusted', () => {
    const error = JSON.stringify(errorAnswer(404, 'NOT_FOUND').result);
    const body = error.replace('"error":', '"error":{},"error":');
    const r = judge(requestOf(), fromText(body, 404), CONTEXT).result;
    unreadable(r, 'error twice');
  });

  test('an answer that nests deeper than 64 levels gives NOT CHECKED, and one at 64 levels is read', () => {
    const nest = (levels: number): GatewayAnswer => {
      const answer = documentAnswer();
      // The root object and didDocumentMetadata are 2 levels. The rest of the levels are lists in a member that no check reads.
      (answer.result.didDocumentMetadata as Record<string, unknown>).extra = levels === 0 ? 1 : JSON.parse(`${'['.repeat(levels)}${']'.repeat(levels)}`);
      return { ...answer, body: JSON.stringify(answer.result) };
    };
    assert.equal(judge(requestOf(), nest(MAX_JSON_DEPTH - 2), CONTEXT).result.verdict, 'valid', '64 levels');
    const deep = judge(requestOf(), nest(MAX_JSON_DEPTH - 1), CONTEXT).result;
    unreadable(deep, '65 levels');
    assert.equal(deep.summary, 'The gateway answer nests deeper than 64 levels, so the tool cannot trust it. The tool cannot decide.');
  });

  test('an answer with no body text, or a body that is not a text: NOT CHECKED', () => {
    for (const body of [undefined, null, 5, {}, ['x']]) {
      const r = judge(requestOf(), { ...documentAnswer(), body } as unknown as GatewayAnswer, CONTEXT).result;
      unreadable(r, JSON.stringify(body) ?? 'undefined');
      assert.equal(r.summary, 'The gateway answer has no body text that the tool can check, so the tool cannot trust it. The tool cannot decide.');
    }
  });

  test('a body that the scan cannot follow gives NOT CHECKED', () => {
    for (const body of ['{"a":', '{"a":"b', '{"a":["b"}', '}', ']', '[}', '{]', '{}}', '{} {}', '{"a":1}x']) {
      unreadable(judge(requestOf(), { ...documentAnswer(), body }, CONTEXT).result, body);
    }
  });
});

describe('scanMemberNames', () => {
  test('finds a name that an object has twice, with the escapes read', () => {
    for (const text of ['{"a":1,"a":2}', '{"a":1,"b":{"c":1,"c":2}}', '{"a":[{"b":1,"b":1}]}', '{"a":1,"\\u0061":2}', '{"\\"":1,"\\"":2}', '{"é":1,"\\u00e9":2}', '{"a":{},"a":{}}', '{"a":1,"b":2,"a":3}']) {
      assert.equal(scanMemberNames(text), 'duplicate', text);
    }
  });

  test('lets pass what is not a duplicate', () => {
    for (const text of [
      '{}', '[]', '{"a":1,"b":2}', '{"a":{"a":{"a":1}}}', '[{"a":1},{"a":2}]', '{"a":[{"a":1},{"a":2}],"b":[{"a":1}]}', '{"a":"a","b":"a"}', '{"a":"{\\"a\\":1,\\"a\\":2}"}',
      '{"a,b":1,"c":"x,y","d":["{","}","[","]"]}', '"text"', '1', 'null', '{"a":1}   ', ' {"a" : 1 , "b" : 2 } ', '{"a\\\\":1,"a":2}', '{"":1,"\\u0000":2}',
    ]) {
      assert.equal(scanMemberNames(text), 'ok', text);
    }
  });

  test('stops at a nesting that is too deep, at the limit and above it', () => {
    const lists = (levels: number): string => `${'['.repeat(levels)}${']'.repeat(levels)}`;
    const maps = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
    assert.equal(scanMemberNames(lists(MAX_JSON_DEPTH)), 'ok');
    assert.equal(scanMemberNames(lists(MAX_JSON_DEPTH + 1)), 'too_deep');
    assert.equal(scanMemberNames(maps(MAX_JSON_DEPTH)), 'ok');
    assert.equal(scanMemberNames(maps(MAX_JSON_DEPTH + 1)), 'too_deep');
    assert.equal(scanMemberNames(lists(500_000)), 'too_deep', 'a text of 1 MB of open lists is refused at once');
  });

  test('says invalid for a text that it cannot follow, and never throws', () => {
    for (const text of ['{"a', '{"a":"b', '"', '{"a\\', '{"\\u00zz":1}', '{', '[', '{"a":1', ']', '}', '[}', '{]', '{"a":1}}', '{} {}', '[][]', '{"a":1}x', '{"a":1} "b"']) {
      assert.doesNotThrow(() => scanMemberNames(text), text);
      assert.equal(scanMemberNames(text), 'invalid', text);
    }
  });

  test('one pass over a body of 1 MiB with 100,000 names, with and without escapes, takes a short time', () => {
    const plain = `{${Array.from({ length: 100_000 }, (_, i) => `"k${i}":${i}`).join(',')}}`;
    const escaped = `{${Array.from({ length: 20_000 }, (_, i) => `"k\\u0041${i}":${i}`).join(',')}}`;
    const started = performance.now();
    assert.equal(scanMemberNames(plain), 'ok');
    assert.equal(scanMemberNames(escaped), 'ok');
    assert.equal(scanMemberNames(`${plain.slice(0, -1)},"k5":0}`), 'duplicate');
    assert.ok(performance.now() - started < 3000);
  });
});
