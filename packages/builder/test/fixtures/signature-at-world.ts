// packages/builder/test/fixtures/signature-at-world.ts
// What the tests of the signature check share (signature-at.test.ts, signature-at-tools.test.ts): test keys that sign, DID documents and
// answers of the identity gateway in the shapes that mainnet gives, and a fake gateway that hands in answers. No network, no secret.
import { CML } from '@lucid-evolution/lucid';
import { didKeyOf } from '../../src/vector/attestation-build.ts';
import { keyHashOf } from '../../src/vector/identity-rules.ts';
import type { GatewayAnswer, ResolutionOptions } from '../../src/vector/identity-gateway.ts';
import type { NodeTipRead } from '../../src/vector/signature-at.ts';

export interface TestKey { privateKey: CML.PrivateKey; publicKey: string; keyHash: string; multibase: string }
/** A deterministic test key: its private half is a byte that the test names, and no secret. */
export function testKey(n: number): TestKey {
  const privateKey = CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, n));
  const publicKey = Buffer.from(privateKey.to_public().to_raw_bytes()).toString('hex');
  return { privateKey, publicKey, keyHash: keyHashOf(publicKey), multibase: didKeyOf(publicKey).slice('did:key:'.length) };
}
/** The Ed25519 signature of `key` over the bytes of `message`, as hex. */
export const sign = (key: TestKey, message: string | Buffer): string => Buffer.from(key.privateKey.sign(Buffer.from(message)).to_raw_bytes()).toString('hex');

export const CONTROLLER = testKey(1);
export const LISTED = testKey(2);
export const DELEGATE = testKey(3);
export const STRANGER = testKey(9);
export const DID = `did:vector:${'c1'.repeat(32)}`;
export const OTHER_DID = `did:vector:${'d2'.repeat(32)}`;
/** The time of the signature in the tests, and the clock: a time later. */
export const AT = '2026-11-03T15:56:00Z';
export const NOW = Date.parse('2026-11-20T12:00:00Z');
export const MESSAGE = 'an action of the agent';
/** The ledger tip of the gateway in the answers of these tests, as a block height (the tip of Vector mainnet at the time of a live read). */
export const GATEWAY_TIP = 9_548_458;
/** The start of Vector mainnet (the answer of Ogmios `queryNetwork/startTime`). A slot is one second. */
export const VECTOR_START_MS = Date.parse('2025-08-29T16:40:00Z');
/** The time of the tip block of the node in the tests: 5 seconds before NOW, so the tip is not stale. */
export const NODE_TIP_TIME = NOW - 5_000;
/** The slot of that block: the seconds from the start of the chain. */
export const NODE_TIP_SLOT = (NODE_TIP_TIME - VECTOR_START_MS) / 1000;
/** The tip of the node at the block height `height`, with the block time `timeMs` (default: a tip that is not stale). */
export const nodeAt = (height: number, timeMs: number = NODE_TIP_TIME): NodeTipRead => ({ height, timeMs });

/** An independent encoder of base58btc, as the gateway writes the keys of a document. */
export function base58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = '';
  for (; n > 0n; n /= 58n) out = alphabet[Number(n % 58n)] + out;
  const zeros = bytes.findIndex((b) => b !== 0);
  return '1'.repeat(zeros === -1 ? bytes.length : zeros) + out;
}

export type Purposes = Array<'authentication' | 'assertionMethod' | 'capabilityInvocation' | 'capabilityDelegation'>;
export const RELATIONSHIPS = ['capabilityInvocation', 'authentication', 'assertionMethod', 'capabilityDelegation'] as const;

/** A DID document as the gateway writes it: one method for each key, and each relationship names its keys as `#<key hash>`. */
export function didDocument(methods: Array<{ key: TestKey; purposes: Purposes }>, id = DID): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    '@context': 'https://www.w3.org/ns/did/v1.1', id,
    verificationMethod: methods.map(({ key }) => ({ id: `${id}#${key.keyHash}`, type: 'Multikey', controller: id, publicKeyMultibase: key.multibase })),
  };
  for (const name of RELATIONSHIPS) {
    const refs = methods.filter((m) => m.purposes.includes(name)).map((m) => `#${m.key.keyHash}`);
    if (refs.length > 0) doc[name] = refs;
  }
  return doc;
}
/** The document of the controller `CONTROLLER`, the listed key `LISTED` (authentication and assertion) and the delegation key `DELEGATE`. */
export const standardDocument = (): Record<string, unknown> => didDocument([
  { key: CONTROLLER, purposes: ['capabilityInvocation'] },
  { key: LISTED, purposes: ['authentication', 'assertionMethod'] },
  { key: DELEGATE, purposes: ['capabilityDelegation'] },
]);

/**
 * The metadata of a version, as the gateway writes it for a request with a time once it gives the next update: version 5 started at
 * 15:53:53 and version 6 at 15:56:44, so the time AT (15:56:00) lies inside version 5. `nextUpdate` is there exactly when `nextVersionId` is.
 * A test of a gateway that gives no next update (a later version and no next update) passes `nextUpdate: undefined`. `vectorLedger` gives the tip of the
 * gateway: `blockHeight` and `confirmations` add up to GATEWAY_TIP.
 */
export const metadata = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  created: '2026-11-03T15:37:54Z', updated: '2026-11-03T15:53:53Z', versionId: '5', nextVersionId: '6', nextUpdate: '2026-11-03T15:56:44Z', canonicalId: DID,
  vectorCurrent: { effective: 'active' }, vectorStatus: { status: 'active', effective: 'active' },
  vectorLedger: { txId: 'cc'.repeat(32), outputIndex: 0, blockHash: 'dd'.repeat(32), blockHeight: 9_184_115, slot: 37_235_633, confirmations: GATEWAY_TIP - 9_184_115 },
  ...over,
});

export function answerOf(status: number, parts: { didDocument?: unknown; didResolutionMetadata?: unknown; didDocumentMetadata?: unknown }): GatewayAnswer {
  const result = { didDocument: parts.didDocument ?? null, didResolutionMetadata: parts.didResolutionMetadata ?? {}, didDocumentMetadata: parts.didDocumentMetadata ?? {} };
  return { status, body: JSON.stringify(result), result: result as GatewayAnswer['result'] };
}
export const documentAnswer = (over: Record<string, unknown> = {}, doc: unknown = standardDocument(), status = 200): GatewayAnswer =>
  answerOf(status, { didDocument: doc, didResolutionMetadata: { contentType: 'application/did' }, didDocumentMetadata: metadata(over) });
export const errorAnswer = (status: number, name: string, title = 'a title'): GatewayAnswer =>
  answerOf(status, { didResolutionMetadata: { error: { type: `https://www.w3.org/ns/did#${name}`, title } } });

/** Hands out the given answers one after the other (the last one again and again); an Error is thrown. */
export function fakeGateway(...answers: Array<GatewayAnswer | Error>) {
  const calls: Array<{ did: string; options: ResolutionOptions }> = [];
  const resolve = async (did: string, options: ResolutionOptions): Promise<GatewayAnswer> => {
    calls.push({ did, options });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, resolve };
}
