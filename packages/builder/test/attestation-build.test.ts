// packages/builder/test/attestation-build.test.ts
// Builder tests of the attestation contract (Part 2 Section 4): Attest, RevokeAtt, Contest and Withdraw with Burn, offline against
// the real applied attestation script (identity-world.ts). A build that completes passed the script (minus the signatures, which it
// reads only as required signers). Each refusal has a negative test.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import {
  DEPLOYMENT, NOW, WINDOW, DAY, CONTROLLER, CONTROLLER_ACCOUNTABLE, OWN_ADDRESS, REF_UTXOS, identityWorld, lucidOn, recordUtxo, rootRecord, testKey,
} from './fixtures/identity-world.ts';
import { FIXTURE_UTXOS } from './fixtures/fixture-provider.ts';
import {
  buildAttest, buildContestAttestation, buildRevokeAttestation, buildWithdrawAttestation, didKeyOf, envelopeSigStructure, withdrawableFrom,
} from '../src/vector/attestation-build.ts';
import type { AttestParams } from '../src/vector/attestation-build.ts';
import { decodeAttestationDatum, encodeAttestationDatum, encodeAttestationMint, encodeAttestationSpend, utf8Hex } from '../src/vector/identity-codec.ts';
import type { AttestationDatum, IdentityDatum } from '../src/vector/identity-codec.ts';
import { identifierFromSeed } from '../src/vector/identity-chain.ts';

const OWN_KEY_HASH = CML.Address.from_bech32(OWN_ADDRESS).payment_cred()!.as_pub_key()!.to_hex();
/** The issuer key: the deterministic test key 8 of identity-world.ts (its private key signs the envelope in one test). */
const ISSUER = testKey(8);
const ISSUER_CONTROLLER = testKey(9);
const SUBJECT_ID = 'a1'.repeat(32);
const ISSUER_ID = 'b2'.repeat(32);
const ISSUER_PARENT_ID = 'b3'.repeat(32);
const DIGEST = 'd1'.repeat(32);
const ATT_ID = 'e7'.repeat(32);
const ATT_UNIT = `${DEPLOYMENT.attestation.hash}${ATT_ID}`;

const issuerRecord = (overrides: Partial<IdentityDatum> = {}): IdentityDatum => rootRecord({
  controller: ISSUER_CONTROLLER.publicKey, keys: [{ keyType: 'Ed25519', key: ISSUER.publicKey, purposes: 2, pop: null }], ...overrides,
});
const tombstone = (record: IdentityDatum): IdentityDatum => ({
  ...record, keys: [], parties: [], description: '', framework: '', endpoint: '', capabilities: [], status: { type: 'Retired', at: NOW - DAY, successor: null },
});
const SUBJECT = recordUtxo(SUBJECT_ID, rootRecord());
const ISSUER_RECORD = recordUtxo(ISSUER_ID, issuerRecord());

function attestation(overrides: Partial<AttestationDatum> = {}): AttestationDatum {
  return {
    subject: SUBJECT_ID, issuer: ISSUER.publicKey, issuerId: null, attType: 0, format: null, profile: null, digest: DIGEST, locator: null,
    envelopeSig: null, issuedAt: NOW - 200 * DAY, validFrom: null, validUntil: null, solicited: false, status: { type: 'AttActive' },
    contested: null, links: [], ...overrides,
  };
}
let attestationCounter = 0;
function attestationUtxo(datum: AttestationDatum, lovelace = 5_000_000n, id = ATT_ID): UTxO {
  attestationCounter += 1;
  return {
    txHash: 'aa'.repeat(32), outputIndex: attestationCounter, address: DEPLOYMENT.attestation.address,
    assets: { lovelace, [`${DEPLOYMENT.attestation.hash}${id}`]: 1n }, datum: encodeAttestationDatum(datum),
  };
}

// ─── Reading the built transaction ─────────────────────────────────────────────────────────────────────────────────────────────

const txOf = (cbor: string) => CML.Transaction.from_cbor_hex(cbor);
function mintOf(cbor: string): Record<string, bigint> {
  const mint = txOf(cbor).body().mint();
  const out: Record<string, bigint> = {};
  const policies = mint?.keys();
  for (let i = 0; mint && policies && i < policies.len(); i++) {
    const assets = mint.get_assets(policies.get(i))!;
    const names = assets.keys();
    for (let j = 0; j < names.len(); j++) out[`${policies.get(i).to_hex()}${names.get(j).to_hex()}`] = assets.get(names.get(j))!;
  }
  return out;
}
function outputsAt(cbor: string, address: string): Array<{ lovelace: bigint; assets: Record<string, bigint>; datum: string | null; scriptRef: boolean }> {
  const outputs = txOf(cbor).body().outputs();
  const found = [];
  for (let i = 0; i < outputs.len(); i++) {
    const o = outputs.get(i);
    if (o.address().to_bech32() !== address) continue;
    const assets: Record<string, bigint> = {};
    const ma = o.amount().multi_asset();
    const policies = ma.keys();
    for (let j = 0; j < policies.len(); j++) {
      const names = ma.get_assets(policies.get(j))!.keys();
      for (let k = 0; k < names.len(); k++) assets[`${policies.get(j).to_hex()}${names.get(k).to_hex()}`] = ma.get_assets(policies.get(j))!.get(names.get(k))!;
    }
    found.push({ lovelace: o.amount().coin(), assets, datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null, scriptRef: o.script_ref() !== undefined });
  }
  return found;
}
/** The required signers of the transaction body, sorted. */
function signersOf(cbor: string): string[] {
  const list = txOf(cbor).body().required_signers();
  return list ? Array.from({ length: list.len() }, (_, i) => list.get(i).to_hex()).sort() : [];
}
function inputsOf(cbor: string): string[] {
  const list = txOf(cbor).body().inputs();
  return Array.from({ length: list.len() }, (_, i) => `${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`);
}
function refsOf(cbor: string): string[] {
  const list = txOf(cbor).body().reference_inputs();
  return list ? Array.from({ length: list.len() }, (_, i) => `${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`) : [];
}
const refOf = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;
/**
 * The redeemers of the transaction, `[tag, data]` sorted (0 spend, 1 mint), after checking that local evaluation of the applied script
 * set execution units on each: the real attestation script ran on the build.
 */
function redeemersOf(cbor: string): Array<[number, string]> {
  const list = txOf(cbor).witness_set().redeemers()?.to_flat_format();
  const all = list ? Array.from({ length: list.len() }, (_, i) => list.get(i)) : [];
  assert.ok(all.length > 0 && all.every((r) => r.ex_units().mem() > 0n && r.ex_units().steps() > 0n), 'every redeemer has execution units from local evaluation');
  return all.map((r): [number, string] => [r.tag(), r.data().to_cbor_hex()]).sort((a, b) => a[0] - b[0]);
}
const ATTESTATION_REF_SCRIPT = refOf(REF_UTXOS[1]);

async function context(extra: UTxO[]) {
  const provider = identityWorld(extra);
  return { lucid: await lucidOn(provider), provider, deployment: DEPLOYMENT };
}
async function attest(p: Partial<AttestParams>, extra: UTxO[] = [SUBJECT, ISSUER_RECORD]) {
  return buildAttest(await context(extra), { changeAddress: OWN_ADDRESS, nowMs: NOW, subject: SUBJECT_ID, issuer: ISSUER.publicKey, attType: 0, digest: DIGEST, ...p });
}

// ─── Attest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildAttest (real attestation script, offline)', () => {
  test('an unregistered issuer: mint +1 named from the seed, one output at AA with 5 AP3X, issued_at = hi, the issuer signs', async () => {
    const r = await attest({});
    const seed = FIXTURE_UTXOS[0];
    assert.equal(r.id, identifierFromSeed(seed));
    const unit = `${DEPLOYMENT.attestation.hash}${r.id}`;
    assert.deepEqual(mintOf(r.txCbor), { [unit]: 1n });
    const [out, ...more] = outputsAt(r.txCbor, DEPLOYMENT.attestation.address);
    assert.equal(more.length, 0);
    assert.equal(out.lovelace, 5_000_000n);
    assert.equal(r.depositLovelace, 5_000_000n);
    assert.deepEqual(out.assets, { [unit]: 1n });
    assert.equal(out.scriptRef, false);
    const datum = decodeAttestationDatum(out.datum!);
    assert.deepEqual(datum, attestation({ issuedAt: WINDOW.hi }));
    assert.equal(r.issuedAt, WINDOW.hi);
    assert.deepEqual(signersOf(r.txCbor), [ISSUER.keyHash]);
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [ISSUER.keyHash, OWN_KEY_HASH]);
    assert.deepEqual(new Set(refsOf(r.txCbor)), new Set([ATTESTATION_REF_SCRIPT, refOf(SUBJECT)]));
    assert.equal(r.sigStructure, envelopeSigStructure({ ...datum }));
    assert.deepEqual(redeemersOf(r.txCbor), [[1, encodeAttestationMint({ type: 'Attest', seed: { txHash: seed.txHash, outputIndex: seed.outputIndex } })]]);
  });

  test('a registered, solicited attestation with every optional field: the issuer record is read, the issuer key and the subject controller sign', async () => {
    const links = [{ rel: 0, target: 'f1'.repeat(32) }, { rel: 3, target: 'f2'.repeat(32) }];
    const r = await attest({
      issuerId: ISSUER_ID, attType: 2, format: 50, profile: 'c4'.repeat(32), locator: utf8Hex('https://issuer.example/att/1'),
      validFrom: NOW - DAY, validUntil: NOW + 365 * DAY, solicited: true, links, depositLovelace: 7_000_000n,
    });
    const datum = decodeAttestationDatum(outputsAt(r.txCbor, DEPLOYMENT.attestation.address)[0].datum!);
    assert.equal(datum.issuerId, ISSUER_ID);
    assert.equal(datum.solicited, true);
    assert.deepEqual(datum.links, links);
    assert.equal(r.depositLovelace, 7_000_000n);
    assert.deepEqual(signersOf(r.txCbor), [ISSUER.keyHash, CONTROLLER.keyHash].sort());
    assert.deepEqual(r.requiredSigners[0].roles, [`issuer (listed with the assertion purpose in did:vector:${ISSUER_ID})`]);
    assert.ok(refsOf(r.txCbor).includes(refOf(ISSUER_RECORD)));
  });

  test('a registered issuer that is a subagent: its ancestors are reference inputs, so the effective status passes on chain', async () => {
    const parent = recordUtxo(ISSUER_PARENT_ID, rootRecord());
    const child = recordUtxo(ISSUER_ID, issuerRecord({ lineage: { type: 'Subagent', parent: ISSUER_PARENT_ID, parentEpoch: 0, depth: 1 }, endpoint: '' }));
    const r = await attest({ issuerId: ISSUER_ID }, [SUBJECT, parent, child]);
    assert.ok(refsOf(r.txCbor).includes(refOf(parent)) && refsOf(r.txCbor).includes(refOf(child)));
  });

  test('a subject tombstone is accepted (decision 13)', async () => {
    const r = await attest({}, [recordUtxo(SUBJECT_ID, tombstone(rootRecord()))]);
    assert.equal(r.attestation.subject, SUBJECT_ID);
  });

  test('the envelope: the issuer signs the Sig_structure, and a build with the same issued_at carries the signature', async () => {
    const issuedAt = NOW + 20 * 60_000;
    const first = await attest({ issuerId: ISSUER_ID, format: 50, issuedAt });
    assert.equal(first.issuedAt, issuedAt);
    assert.equal(first.validTo, issuedAt);
    // The deterministic test key 8 of identity-world.ts.
    const signature = Buffer.from(CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, 8)).sign(Buffer.from(first.sigStructure, 'hex')).to_raw_bytes()).toString('hex');
    const second = await attest({ issuerId: ISSUER_ID, format: 50, issuedAt, envelopeSig: signature });
    assert.equal(second.attestation.envelopeSig, signature);
    assert.equal(second.sigStructure, first.sigStructure);
    assert.equal(decodeAttestationDatum(outputsAt(second.txCbor, DEPLOYMENT.attestation.address)[0].datum!).envelopeSig, signature);
    await assert.rejects(attest({ issuerId: ISSUER_ID, format: 51, issuedAt, envelopeSig: signature }), /envelope_sig does not verify/);
    await assert.rejects(attest({ issuedAt, envelopeSig: signature }), /envelope_sig does not verify/);
    await assert.rejects(attest({ envelopeSig: signature }), /envelope_sig needs issued_at/);
  });

  test('the Sig_structure is ["Signature1", protected, h\'\', digest] with the protected header of Section 4.2 in deterministic CBOR', () => {
    const issuedAt = 1_794_744_000_000;
    const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
    const kid = `did:vector:${ISSUER_ID}#${ISSUER.keyHash}`;
    const protectedHeader =
      'a5' + '0132' + // 1: -19 (Ed25519)
      '04' + '5884' + hex(kid) + // 4: kid, 132 bytes
      '0f' + 'a3' + '01' + '784b' + hex(`did:vector:${ISSUER_ID}`) + '02' + '784b' + hex(`did:vector:${SUBJECT_ID}`) + '06' + '1a' + (issuedAt / 1000).toString(16).padStart(8, '0') +
      '190102' + '2f' + // 258: -16 (SHA-256)
      '190103' + '1832'; // 259: 50
    assert.equal(protectedHeader.length / 2, 0x137);
    const expected = '84' + '6a' + hex('Signature1') + '590137' + protectedHeader + '40' + '5820' + DIGEST;
    assert.equal(envelopeSigStructure({ issuer: ISSUER.publicKey, issuerId: ISSUER_ID, subject: SUBJECT_ID, issuedAt, format: 50, digest: DIGEST }), expected);
    // An unregistered issuer: the did:key of the key, its key URL as the kid, and no format.
    const unregistered = envelopeSigStructure({ issuer: ISSUER.publicKey, issuerId: null, subject: SUBJECT_ID, issuedAt, format: null, digest: DIGEST });
    const didKey = didKeyOf(ISSUER.publicKey);
    assert.ok(unregistered.includes(hex(`${didKey}#${didKey.slice(8)}`)) && unregistered.includes(`784b${hex(`did:vector:${SUBJECT_ID}`)}`));
    assert.ok(!unregistered.includes('190103'));
  });

  test('did:key of an Ed25519 key (the did:key test vector of the zero seed)', () => {
    assert.equal(didKeyOf(testKey(0).publicKey), 'did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp');
  });

  test('content refusals name the rule', async () => {
    await assert.rejects(attest({ attType: 6 }), /att_type 6 is reserved/);
    await assert.rejects(attest({ attType: 2 }), /software needs valid_until/);
    await assert.rejects(attest({ attType: 3 }), /environment needs valid_until/);
    await assert.rejects(attest({ validUntil: WINDOW.hi - 1000 }), /must be at or after issued_at/);
    await assert.rejects(attest({ validUntil: WINDOW.hi + 366 * DAY + 1 }), /at most 366 days after issued_at/);
    await assert.rejects(attest({ validUntil: NOW + DAY, validFrom: NOW + 2 * DAY }), /valid_from must be a valid time at or before valid_until/);
    await assert.rejects(attest({ format: 65_536 }), /CoAP Content-Format/);
    await assert.rejects(attest({ digest: 'd1'.repeat(31) }), /digest must be 32 bytes/);
    await assert.rejects(attest({ profile: 'c4'.repeat(31) }), /profile must be 32 bytes/);
    await assert.rejects(attest({ locator: '61'.repeat(257) }), /locator must be at most 256 bytes/);
    await assert.rejects(attest({ links: Array.from({ length: 5 }, () => ({ rel: 0, target: 'f1'.repeat(32) })) }), /at most 4 links/);
    await assert.rejects(attest({ links: [{ rel: 4, target: 'f1'.repeat(32) }] }), /relation must be 0 supersedes/);
    await assert.rejects(attest({ links: [{ rel: 0, target: 'f1'.repeat(31) }] }), /target must be the 32-byte identifier/);
    await assert.rejects(attest({ depositLovelace: 4_999_999n }), /at least 5 AP3X/);
  });

  test('the window refusals of issued_at', async () => {
    await assert.rejects(attest({ issuedAt: NOW + 600_500 }), /whole second/);
    await assert.rejects(attest({ issuedAt: NOW - 1000 }), /has passed/);
    await assert.rejects(attest({ issuedAt: NOW + 60 * 60_000 }), /too far ahead/);
  });

  test('chain refusals: the subject, the issuer record, its status and the assertion purpose', async () => {
    await assert.rejects(attest({}, [ISSUER_RECORD]), /No record of the subject for did:vector:a1a1/);
    await assert.rejects(attest({ issuerId: ISSUER_ID }, [SUBJECT]), /No record of the issuer for did:vector:b2b2/);
    const held = issuerRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 6, since: NOW - DAY, until: NOW + DAY }] } });
    await assert.rejects(attest({ issuerId: ISSUER_ID }, [SUBJECT, recordUtxo(ISSUER_ID, held)]), /is Suspended; a registered issuer must be Active/);
    const unaccountable = issuerRecord({ parties: [{ ...CONTROLLER_ACCOUNTABLE, notAfter: NOW - DAY }] });
    await assert.rejects(attest({ issuerId: ISSUER_ID }, [SUBJECT, recordUtxo(ISSUER_ID, unaccountable)]), /is Suspended/);
    const authOnly = issuerRecord({ keys: [{ keyType: 'Ed25519', key: ISSUER.publicKey, purposes: 1, pop: null }] });
    await assert.rejects(attest({ issuerId: ISSUER_ID }, [SUBJECT, recordUtxo(ISSUER_ID, authOnly)]), /does not list the issuer key .* with the assertion purpose/);
  });
});

// ─── RevokeAtt ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function revoke(datum: AttestationDatum, p: { reason?: number; by?: 'issuer' | 'controller' } = {}, extra: UTxO[] = [SUBJECT, ISSUER_RECORD], lovelace = 5_000_000n) {
  const input = attestationUtxo(datum, lovelace);
  const r = await buildRevokeAttestation(await context([...extra, input]), { changeAddress: OWN_ADDRESS, nowMs: NOW, id: ATT_ID, reason: p.reason ?? 4, by: p.by });
  return { r, input };
}

describe('buildRevokeAttestation (real attestation script, offline)', () => {
  test('an unregistered issuer: status AttRevoked { at: lo, reason }, nothing else changes, the same token and AP3X, the issuer key signs', async () => {
    const before = attestation({ validUntil: NOW + 100 * DAY, links: [{ rel: 2, target: 'f1'.repeat(32) }] });
    const { r, input } = await revoke(before, {}, [SUBJECT], 7_000_000n);
    assert.deepEqual(mintOf(r.txCbor), {});
    const inputs = txOf(r.txCbor).body().inputs();
    assert.ok(Array.from({ length: inputs.len() }, (_, i) => `${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`).includes(refOf(input)));
    const [out, ...more] = outputsAt(r.txCbor, DEPLOYMENT.attestation.address);
    assert.equal(more.length, 0);
    assert.deepEqual(out.assets, { [ATT_UNIT]: 1n });
    assert.equal(out.lovelace, 7_000_000n);
    assert.deepEqual(decodeAttestationDatum(out.datum!), { ...before, status: { type: 'AttRevoked', at: WINDOW.lo, reason: 4 } });
    assert.deepEqual(signersOf(r.txCbor), [ISSUER.keyHash]);
    assert.equal(r.action, 'RevokeAtt');
    assert.deepEqual(redeemersOf(r.txCbor), [[0, encodeAttestationSpend({ type: 'RevokeAtt', reason: 4 })]]);
  });

  test('a registered issuer: the issuer key while it is listed, or its controller (by), with the issuer record as a reference input', async () => {
    const registered = attestation({ issuerId: ISSUER_ID });
    const byKey = await revoke(registered);
    assert.deepEqual(signersOf(byKey.r.txCbor), [ISSUER.keyHash]);
    assert.ok(refsOf(byKey.r.txCbor).includes(refOf(ISSUER_RECORD)));
    const byController = await revoke(registered, { by: 'controller', reason: 0 });
    assert.deepEqual(signersOf(byController.r.txCbor), [ISSUER_CONTROLLER.keyHash]);
  });

  test('after the issuer key is removed, the controller signs by default; a tombstone issuer keeps its controller (decision 11)', async () => {
    const registered = attestation({ issuerId: ISSUER_ID });
    const removed = recordUtxo(ISSUER_ID, issuerRecord({ keys: [] }));
    const { r } = await revoke(registered, {}, [SUBJECT, removed]);
    assert.deepEqual(signersOf(r.txCbor), [ISSUER_CONTROLLER.keyHash]);
    await assert.rejects(revoke(registered, { by: 'issuer' }, [SUBJECT, removed]), /no longer listed with the assertion purpose/);
    const ended = await revoke(registered, {}, [SUBJECT, recordUtxo(ISSUER_ID, tombstone(issuerRecord()))]);
    assert.deepEqual(signersOf(ended.r.txCbor), [ISSUER_CONTROLLER.keyHash]);
  });

  test('refusals: revoked already, no issuer record for by controller, a missing record or attestation, a negative reason', async () => {
    await assert.rejects(revoke(attestation({ status: { type: 'AttRevoked', at: NOW - DAY, reason: 0 } })), /cannot be revoked again/);
    await assert.rejects(revoke(attestation(), { by: 'controller' }), /only the issuer key can sign/);
    await assert.rejects(revoke(attestation({ issuerId: ISSUER_ID }), {}, [SUBJECT]), /No record of the issuer/);
    await assert.rejects(revoke(attestation(), { reason: -1 }), /whole number from 0/);
    const ctx = await context([SUBJECT]);
    await assert.rejects(buildRevokeAttestation(ctx, { changeAddress: OWN_ADDRESS, nowMs: NOW, id: ATT_ID, reason: 0 }), /No attestation e7e7/);
  });
});

// ─── Contest ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function contest(datum: AttestationDatum, uri: string, sha256 = 'ab'.repeat(32), extra: UTxO[] = [SUBJECT], lovelace = 5_000_000n) {
  return buildContestAttestation(await context([...extra, attestationUtxo(datum, lovelace)]), {
    changeAddress: OWN_ADDRESS, nowMs: NOW, id: ATT_ID, anchor: { uri: utf8Hex(uri), sha256 },
  });
}

describe('buildContestAttestation (real attestation script, offline)', () => {
  test('the subject controller signs; only contested changes; it works on revoked and contested attestations (decision 10)', async () => {
    const revoked = attestation({ status: { type: 'AttRevoked', at: NOW - DAY, reason: 0 }, contested: { uri: utf8Hex('https://old.example'), sha256: '01'.repeat(32) } });
    const r = await contest(revoked, 'https://subject.example/reply');
    const [out] = outputsAt(r.txCbor, DEPLOYMENT.attestation.address);
    assert.deepEqual(decodeAttestationDatum(out.datum!), { ...revoked, contested: { uri: utf8Hex('https://subject.example/reply'), sha256: 'ab'.repeat(32) } });
    assert.deepEqual(out.assets, { [ATT_UNIT]: 1n });
    assert.deepEqual(signersOf(r.txCbor), [CONTROLLER.keyHash]);
    assert.ok(refsOf(r.txCbor).includes(refOf(SUBJECT)));
    assert.deepEqual(mintOf(r.txCbor), {});
    assert.match(r.summary, /replaces its earlier reply/);
    assert.deepEqual(redeemersOf(r.txCbor), [[0, encodeAttestationSpend({ type: 'Contest' })]]);
  });

  test('a subject tombstone still contests; a large anchor raises the output to the ledger minimum, never below the input', async () => {
    const large = attestation({
      issuerId: ISSUER_ID, format: 50, profile: 'c4'.repeat(32), locator: '61'.repeat(256), envelopeSig: '5a'.repeat(64), validUntil: NOW + DAY,
      links: Array.from({ length: 4 }, (_, i) => ({ rel: i, target: `f${i}`.repeat(32) })),
    });
    const r = await contest(large, 'h'.repeat(256), 'ab'.repeat(32), [recordUtxo(SUBJECT_ID, tombstone(rootRecord()))]);
    assert.ok(r.outputLovelace >= 5_000_000n);
    assert.equal(outputsAt(r.txCbor, DEPLOYMENT.attestation.address)[0].lovelace, r.outputLovelace);
  });

  test('refusals: the anchor limits and a missing subject record', async () => {
    await assert.rejects(contest(attestation(), ''), /contest uri must be 1 to 256 bytes/);
    await assert.rejects(contest(attestation(), 'h'.repeat(257)), /contest uri must be 1 to 256 bytes/);
    await assert.rejects(contest(attestation(), 'https://x', 'ab'.repeat(31)), /sha256 must be 32 bytes/);
    await assert.rejects(contest(attestation(), 'https://x', 'ab'.repeat(32), []), /No record of the subject/);
  });
});

// ─── Withdraw ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function withdraw(datum: AttestationDatum, by?: 'issuer' | 'controller', extra: UTxO[] = [SUBJECT, ISSUER_RECORD]) {
  const input = attestationUtxo(datum, 6_000_000n);
  const r = await buildWithdrawAttestation(await context([...extra, input]), { changeAddress: OWN_ADDRESS, nowMs: NOW, id: ATT_ID, by });
  return { r, input };
}

describe('buildWithdrawAttestation (real attestation script, offline)', () => {
  test('revoked 90 days before lo: burn exactly [(id, -1)], no output at AA, the deposit goes to the wallet', async () => {
    const at = WINDOW.lo - 90 * DAY;
    const { r, input } = await withdraw(attestation({ status: { type: 'AttRevoked', at, reason: 0 } }));
    assert.deepEqual(mintOf(r.txCbor), { [ATT_UNIT]: -1n });
    assert.deepEqual(redeemersOf(r.txCbor), [[0, encodeAttestationSpend({ type: 'Withdraw' })], [1, encodeAttestationMint({ type: 'Burn' })]]);
    assert.equal(outputsAt(r.txCbor, DEPLOYMENT.attestation.address).length, 0);
    assert.equal(r.releasedLovelace, 6_000_000n);
    assert.equal(r.withdrawableFrom, at + 90 * DAY);
    // Every output goes to the wallet: the inputs (the attestation and any wallet input) less the fee.
    const spent = inputsOf(r.txCbor).map((ref) => [...FIXTURE_UTXOS, input].find((u) => refOf(u) === ref)!);
    assert.ok(spent.includes(input));
    const toWallet = outputsAt(r.txCbor, OWN_ADDRESS).reduce((sum, o) => sum + o.lovelace, 0n);
    assert.equal(toWallet, spent.reduce((sum, u) => sum + u.assets.lovelace, 0n) - BigInt(r.fee));
    assert.equal(txOf(r.txCbor).body().outputs().len(), outputsAt(r.txCbor, OWN_ADDRESS).length);
    assert.deepEqual(signersOf(r.txCbor), [ISSUER.keyHash]);
  });

  test('expired 90 days before lo (active with valid_until), by the controller of a registered issuer', async () => {
    const { r } = await withdraw(attestation({ issuerId: ISSUER_ID, validUntil: NOW - 91 * DAY, issuedAt: NOW - 200 * DAY }), 'controller');
    assert.deepEqual(signersOf(r.txCbor), [ISSUER_CONTROLLER.keyHash]);
    assert.ok(refsOf(r.txCbor).includes(refOf(ISSUER_RECORD)));
  });

  test('refusals name the date when the withdrawal becomes possible', async () => {
    const at = NOW - 89 * DAY;
    await assert.rejects(withdraw(attestation({ status: { type: 'AttRevoked', at, reason: 0 } })), new RegExp(`can be withdrawn from ${new Date(at + 90 * DAY).toISOString()}`));
    await assert.rejects(withdraw(attestation()), /Revoke it first/);
    await assert.rejects(withdraw(attestation({ status: { type: 'AttRevoked', at: NOW - 100 * DAY, reason: 0 } }), 'controller'), /only the issuer key can sign/);
    assert.equal(withdrawableFrom(attestation({ validUntil: 10, status: { type: 'AttRevoked', at: 5, reason: 0 } })), 5 + 90 * DAY);
  });
});

