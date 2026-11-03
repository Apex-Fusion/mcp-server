// packages/builder/test/attestation-tools.test.ts
// Handler-level tests of the attestation tools: registerIdentityFamily with a minimal fake server that validates the arguments with
// each tool's zod schema (as the MCP server does) and calls the handler. The node is the offline identity world (identity-world.ts);
// the real attestation script runs on every build. The tools take the time from the clock, so the records count from now. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIdentityFamily } from '../src/vector/identity-family.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { IdentityConfigError, NOT_CONFIGURED } from '../src/vector/identity-deployment.ts';
import { encodeAttestationDatum } from '../src/vector/identity-codec.ts';
import type { AttestationDatum, IdentityDatum } from '../src/vector/identity-codec.ts';
import { DEPLOYMENT, DAY, CONTROLLER, CONTROLLER_ACCOUNTABLE, OWN_ADDRESS, identityWorld, recordUtxo, rootRecord, testKey } from './fixtures/identity-world.ts';
import type { FixtureProvider } from './fixtures/fixture-provider.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
type Tool = { shape: z.ZodRawShape; handler: Handler };
const serverOf = (into: Map<string, Tool>) => ({
  tool: (name: string, _description: string, shape: z.ZodRawShape, handler: Handler) => { into.set(name, { shape, handler }); },
}) as unknown as McpServer;

/** The tools of the identity family on `world`; a call checks the arguments against the tool's schema first, as the MCP server does. */
function tools(world: () => FixtureProvider, deployment = () => DEPLOYMENT) {
  const registered = new Map<string, Tool>();
  registerIdentityFamily(serverOf(registered), 'attestation-tools-test', world, new RateLimiter(100_000), deployment);
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = registered.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const parsed = z.object(tool.shape).safeParse(args);
    if (!parsed.success) return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    return (await tool.handler(parsed.data as Record<string, unknown>)).content[0].text;
  };
}
/** The JSON block of a tool answer. */
const jsonOf = (answer: string): Record<string, unknown> => JSON.parse(answer.slice(answer.lastIndexOf('```json\n') + 8, answer.lastIndexOf('\n```')));
const signersOf = (answer: string): string[] => (jsonOf(answer).required_signers as Array<{ key_hash: string }>).map((s) => s.key_hash);

const T0 = Date.now() - 30 * DAY;
const ISSUER = testKey(8);
const ISSUER_CONTROLLER = testKey(9);
const SUBJECT_ID = 'a1'.repeat(32);
const ISSUER_ID = 'b2'.repeat(32);
const ATT_ID = 'e7'.repeat(32);
const DIGEST = 'd1'.repeat(32);
/** A record that is Active now: its Accountable Party starts 30 days ago. */
const live = (overrides: Partial<IdentityDatum> = {}): IdentityDatum => rootRecord({ parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: T0 }], createdAt: T0, ...overrides });
const SUBJECT = recordUtxo(SUBJECT_ID, live());
const ISSUER_RECORD = recordUtxo(ISSUER_ID, live({ controller: ISSUER_CONTROLLER.publicKey, keys: [{ keyType: 'Ed25519', key: ISSUER.publicKey, purposes: 2, pop: null }] }));

function attestationUtxo(overrides: Partial<AttestationDatum>, lovelace = 5_000_000n): UTxO {
  const datum: AttestationDatum = {
    subject: SUBJECT_ID, issuer: ISSUER.publicKey, issuerId: null, attType: 0, format: null, profile: null, digest: DIGEST, locator: null, envelopeSig: null,
    issuedAt: T0, validFrom: null, validUntil: null, solicited: false, status: { type: 'AttActive' }, contested: null, links: [], ...overrides,
  };
  return { txHash: 'aa'.repeat(32), outputIndex: 7, address: DEPLOYMENT.attestation.address, assets: { lovelace, [`${DEPLOYMENT.attestation.hash}${ATT_ID}`]: 1n }, datum: encodeAttestationDatum(datum) };
}
const world = (...extra: UTxO[]) => () => identityWorld([SUBJECT, ISSUER_RECORD, ...extra]);

describe('vector_build_attestation_attest', () => {
  const call = tools(world());

  test('builds an attestation: the identifier, issued_at, the Sig_structure and the signers, with the multi-signer flow', async () => {
    const answer = await call('vector_build_attestation_attest', {
      changeAddress: OWN_ADDRESS, subject: `did:vector:${SUBJECT_ID}`, issuer: ISSUER.publicKey, issuer_did: ISSUER_ID, att_type: 'provenance', digest: DIGEST,
      locator: 'https://issuer.example/doc', links: [{ rel: 'corroborates', target: 'f1'.repeat(32) }], solicited: true,
    });
    assert.match(answer, /# Attestation Built \(Unsigned, Not Submitted\)/);
    const json = jsonOf(answer);
    assert.match(String(json.attestation), /^[0-9a-f]{64}$/);
    assert.equal(json.subject_did, `did:vector:${SUBJECT_ID}`);
    assert.equal(json.issuer_did, `did:vector:${ISSUER_ID}`);
    assert.equal(json.att_type, 'provenance');
    assert.equal(json.issued_at, json.valid_to);
    assert.equal(json.envelope_signed, false);
    assert.match(String(json.sig_structure), /^846a5369676e617475726531/);
    assert.deepEqual(signersOf(answer).slice(0, 2), [ISSUER.keyHash, CONTROLLER.keyHash]);
    assert.match(answer, /\*\*Locator:\*\* https:\/\/issuer\.example\/doc/);
    assert.match(answer, /corroborates f1f1/);
    assert.match(answer, /To add an envelope signature, the issuer signs these bytes/);
    assert.match(answer, /Each key holder in the list signs in turn with vector_signer_sign/);
  });

  test('the envelope round trip: sign the Sig_structure of a fixed issued_at, then build again with the signature', async () => {
    const issuedAt = (Math.floor(Date.now() / 1000) + 20 * 60) * 1000;
    const args = { changeAddress: OWN_ADDRESS, subject: SUBJECT_ID, issuer: ISSUER.publicKey, att_type: 'identity', digest: DIGEST, format: 50, issued_at: issuedAt };
    const first = jsonOf(await call('vector_build_attestation_attest', args));
    assert.equal(first.issued_at, issuedAt);
    // The deterministic test key 8 of identity-world.ts.
    const signature = Buffer.from(CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, 8)).sign(Buffer.from(String(first.sig_structure), 'hex')).to_raw_bytes()).toString('hex');
    const second = await call('vector_build_attestation_attest', { ...args, envelope_sig: signature });
    assert.equal(jsonOf(second).envelope_signed, true);
    assert.match(second, /The attestation carries this envelope signature/);
    const wrong = await call('vector_build_attestation_attest', { ...args, format: 51, envelope_sig: signature });
    assert.match(wrong, /^Failed to build attestation: envelope_sig does not verify/);
  });

  test('types 4 and 5 carry the salted-digest rule; refusals name the rule; the schema refuses a reserved type', async () => {
    const approval = await call('vector_build_attestation_attest', { changeAddress: OWN_ADDRESS, subject: SUBJECT_ID, issuer: ISSUER.publicKey, att_type: 'approval', digest: DIGEST });
    assert.match(approval, /salted digest: SHA-256\(salt \+\+ document\)/);
    const software = await call('vector_build_attestation_attest', { changeAddress: OWN_ADDRESS, subject: SUBJECT_ID, issuer: ISSUER.publicKey, att_type: 'software', digest: DIGEST });
    assert.match(software, /^Failed to build attestation: .*software needs valid_until/);
    assert.match(software, /Troubleshooting Tips/);
    const unlisted = await call('vector_build_attestation_attest', { changeAddress: OWN_ADDRESS, subject: SUBJECT_ID, issuer: testKey(30).publicKey, issuer_did: ISSUER_ID, att_type: 'other', digest: DIGEST });
    assert.match(unlisted, /does not list the issuer key .* with the assertion purpose/);
    const reserved = await call('vector_build_attestation_attest', { changeAddress: OWN_ADDRESS, subject: SUBJECT_ID, issuer: ISSUER.publicKey, att_type: 'reserved', digest: DIGEST });
    assert.match(reserved, /^Invalid arguments: att_type/);
  });

  test('without a deployment the tool says which variables to set', async () => {
    const unconfigured = tools(world(), () => { throw new IdentityConfigError(NOT_CONFIGURED); });
    const answer = await unconfigured('vector_build_attestation_attest', { changeAddress: OWN_ADDRESS, subject: SUBJECT_ID, issuer: ISSUER.publicKey, att_type: 'identity', digest: DIGEST });
    assert.match(answer, /VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/);
  });
});

describe('vector_build_attestation_revoke, _contest and _withdraw', () => {
  test('revoke: the status, the reason, the authority; a second revocation is refused', async () => {
    const answer = await tools(world(attestationUtxo({ issuerId: ISSUER_ID })))('vector_build_attestation_revoke', { changeAddress: OWN_ADDRESS, attestation: ATT_ID, reason: 4, by: 'controller' });
    assert.match(answer, /# Attestation Revocation Built/);
    const json = jsonOf(answer);
    assert.equal(json.action, 'RevokeAtt');
    assert.equal(json.reason, 4);
    assert.equal(json.revoked_at, json.valid_from);
    assert.equal(json.withdrawable_from, Number(json.valid_from) + 90 * DAY);
    assert.deepEqual(signersOf(answer)[0], ISSUER_CONTROLLER.keyHash);
    const again = await tools(world(attestationUtxo({ status: { type: 'AttRevoked', at: T0, reason: 0 } })))('vector_build_attestation_revoke', { changeAddress: OWN_ADDRESS, attestation: ATT_ID });
    assert.match(again, /^Failed to build attestation revocation: .*cannot be revoked again/);
  });

  test("contest: the subject's controller signs the reply; a uri over 256 bytes is refused", async () => {
    const call = tools(world(attestationUtxo({})));
    const answer = await call('vector_build_attestation_contest', { changeAddress: OWN_ADDRESS, attestation: ATT_ID, uri: 'https://subject.example/reply', sha256: 'ab'.repeat(32) });
    assert.match(answer, /# Attestation Contest Built/);
    assert.equal(jsonOf(answer).contested_uri, 'https://subject.example/reply');
    assert.equal(signersOf(answer)[0], CONTROLLER.keyHash);
    assert.match(await call('vector_build_attestation_contest', { changeAddress: OWN_ADDRESS, attestation: ATT_ID, uri: 'h'.repeat(257), sha256: 'ab'.repeat(32) }), /contest uri must be 1 to 256 bytes/);
  });

  test('withdraw: the burn returns the deposit; too early, the tool names the date', async () => {
    const answer = await tools(world(attestationUtxo({ status: { type: 'AttRevoked', at: Date.now() - 91 * DAY, reason: 0 } }, 6_000_000n)))('vector_build_attestation_withdraw', { changeAddress: OWN_ADDRESS, attestation: ATT_ID });
    assert.match(answer, /# Attestation Withdrawal Built/);
    assert.equal(jsonOf(answer).released_lovelace, '6000000');
    assert.equal(signersOf(answer)[0], ISSUER.keyHash);
    const at = Date.now() - 10 * DAY;
    const early = await tools(world(attestationUtxo({ status: { type: 'AttRevoked', at, reason: 0 } })))('vector_build_attestation_withdraw', { changeAddress: OWN_ADDRESS, attestation: ATT_ID });
    assert.match(early, new RegExp(`can be withdrawn from ${new Date(at + 90 * DAY).toISOString()}`));
    const missing = await tools(world())('vector_build_attestation_withdraw', { changeAddress: OWN_ADDRESS, attestation: ATT_ID });
    assert.match(missing, /No attestation e7e7/);
  });
});
