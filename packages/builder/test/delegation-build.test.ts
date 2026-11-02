// packages/builder/test/delegation-build.test.ts
// Builder tests of the delegation contract (Part 2 Sections 5.1 and 5.2): the pattern port, the use checks, Delegate (root and
// sub-delegations) and Undelegate, offline against the real applied delegation script (identity-world.ts). A build that completes
// passed the script (minus the signatures, which it reads only as required signers). Each refusal has a negative test.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import {
  DEPLOYMENT, NOW, WINDOW, DAY, CONTROLLER, LISTED, OWN_ADDRESS, REF_UTXOS, identityWorld, lucidOn, recordUtxo, rootRecord, testKey,
} from './fixtures/identity-world.ts';
import { FIXTURE_UTXOS } from './fixtures/fixture-provider.ts';
import {
  HIRE_ACTION, buildDelegate, buildUndelegate, delegationUseProblems, escrowResource, narrower, patternCovers, patternsCover,
  validActionPattern, validResourcePattern,
} from '../src/vector/delegation-build.ts';
import type { DelegateParams } from '../src/vector/delegation-build.ts';
import { decodeDelegationDatum, encodeDelegationDatum, encodeDelegationMint, utf8Hex } from '../src/vector/identity-codec.ts';
import type { DelegationDatum, IdentityDatum } from '../src/vector/identity-codec.ts';
import { identifierFromSeed } from '../src/vector/identity-chain.ts';
import type { DelegationUtxo } from '../src/vector/identity-chain.ts';

// ─── Patterns (the vectors of pattern.ak) ──────────────────────────────────────────────────────────────────────────────────────

const SCRIPT_RESOURCE = `script:${'e5'.repeat(28)}`;

describe('patterns (port of delegation/pattern.ak)', () => {
  test('action patterns', () => {
    for (const p of ['*', 'a', 'ocr', 'ocr.extract.v1', 'marketplace.hire.v1', 'a-b.c-9', 'document-extraction', 'ocr.*', 'a.b-c.*', 'oauth:x', 'oauth:scope.read',
      'mcp:tools/read', 'mcp:tools.*', 'https://api.example.com/v1', 'https://api.example.com/.*']) assert.ok(validActionPattern(p), p);
    for (const p of ['', '.', 'a.', '.a', 'a..b', 'A', 'Ocr.extract', 'ocr_extract', 'ocr*', '.*', '*.*', 'a.*.*', 'a.*b', 'oauth:', 'mcp:', 'https://', 'http://x',
      'mcp:a b', 'oauth:\n', 'ftp:x', SCRIPT_RESOURCE, 'a b', 'ocr.*.v1', 'ocré']) assert.ok(!validActionPattern(p), p);
  });

  test('resource patterns', () => {
    for (const p of ['*', SCRIPT_RESOURCE, 'https://api.example.com/v1', 'oauth:x', 'mcp:y']) assert.ok(validResourcePattern(p), p);
    for (const p of ['', 'ocr.extract', 'ocr.*', 'a', `script:${'e5'.repeat(27)}e`, `script:${'e5'.repeat(28)}e`, `script:${'E5'.repeat(28)}`,
      `script:g${'5e'.repeat(27)}5`, `Script:${'e5'.repeat(28)}`, 'https://', 'mcp:', 'oauth:', 'https://a b']) assert.ok(!validResourcePattern(p), p);
  });

  test('coverage: star, exact, prefix; oc.* does not cover ocr.*; externals match only exactly', () => {
    assert.ok(patternCovers('*', 'ocr.extract.v1') && patternCovers('*', SCRIPT_RESOURCE) && patternCovers('*', '*'));
    assert.ok(patternCovers('ocr.extract.v1', 'ocr.extract.v1') && patternCovers('document-extraction', 'document-extraction'));
    assert.ok(!patternCovers('ocr.extract.v1', 'ocr.extract.v2') && !patternCovers('ocr.extract', 'ocr.extract.v1') && !patternCovers('document-extraction', '*'));
    assert.ok(patternCovers('ocr.*', 'ocr.extract') && patternCovers('marketplace.*', HIRE_ACTION) && patternCovers('a.b.*', 'a.b.c'));
    assert.ok(!patternCovers('ocr.*', 'ocr') && !patternCovers('ocr.*', 'ocrx') && !patternCovers('ocr.extract.*', 'ocr.other.v1'));
    assert.ok(!patternCovers('oc.*', 'ocr.*') && !patternCovers('oc.*', 'ocr.extract') && !narrower(['ocr.*'], ['oc.*']) && !narrower(['ocr.extract.v1'], ['oc.*']));
    assert.ok(patternCovers('mcp:tools.*', 'mcp:tools.*') && !patternCovers('mcp:tools.*', 'mcp:tools.read') && !patternCovers('oauth:scope.*', 'oauth:scope.read'));
    assert.ok(!patternCovers('https://api.example.com/v1', 'https://api.example.com/v1/jobs') && !narrower(['mcp:tools.read'], ['mcp:tools.*']));
    assert.ok(!patternsCover([], 'x'), 'an empty list covers nothing');
  });

  test('narrower lists', () => {
    assert.ok(narrower(['ocr.extract.v1'], ['ocr.*']) && narrower(['ocr.extract.*'], ['ocr.*']) && narrower(['ocr.*'], ['ocr.*']));
    assert.ok(narrower(['ocr.*', HIRE_ACTION], ['marketplace.*', 'ocr.*']) && narrower(['*'], ['*']) && narrower(['ocr.*', 'oauth:x'], ['*']));
    assert.ok(narrower([], ['ocr.*']) && narrower([], []));
    assert.ok(!narrower(['*'], ['ocr.*']) && !narrower(['ocr.*'], ['ocr.extract.*']) && !narrower(['ocr.*'], ['ocr.extract.v1']));
    assert.ok(!narrower(['ocr.extract.v1', 'ocr.x'], ['ocr.extract.v1']) && !narrower(['ocr.extract.v1'], []) && !narrower([SCRIPT_RESOURCE], ['https://api.example.com/v1']));
    assert.equal(escrowResource('AB'.repeat(28)), `script:${'ab'.repeat(28)}`);
  });
});

// ─── The world ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const OWN_KEY_HASH = CML.Address.from_bech32(OWN_ADDRESS).payment_cred()!.as_pub_key()!.to_hex();
const AGENT_A_ID = 'a1'.repeat(32); // controller CONTROLLER; LISTED has the delegation purpose
const AGENT_B_ID = 'b4'.repeat(32);
const DELEGATE_ID = 'c3'.repeat(32);
const DELEGATE_CONTROLLER = testKey(10);
const DKEY1 = testKey(11);
const DKEY2 = testKey(12);
const AUTH_ONLY = testKey(13);
const PRINCIPAL = testKey(14);
const B_CONTROLLER = testKey(15);
const BKEY = testKey(16);
const PARENT_ID = '9a'.repeat(32);
const GRANDPARENT_ID = '9b'.repeat(32);
const DELEGATION_ID = '9c'.repeat(32);
const ESCROW = escrowResource(DEPLOYMENT.escrow.hash);

const key = (k: { publicKey: string }, purposes: number) => ({ keyType: 'Ed25519' as const, key: k.publicKey, purposes, pop: null });
const delegateRecord = (overrides: Partial<IdentityDatum> = {}) => rootRecord({ controller: DELEGATE_CONTROLLER.publicKey, keys: [key(DKEY1, 16), key(DKEY2, 16), key(AUTH_ONLY, 1)], ...overrides });
const held = (record: IdentityDatum): IdentityDatum => ({ ...record, status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 6, since: NOW - DAY, until: NOW + DAY }] } });
const tombstone = (record: IdentityDatum): IdentityDatum => ({
  ...record, keys: [], parties: [], description: '', framework: '', endpoint: '', capabilities: [], status: { type: 'Retired', at: NOW - DAY, successor: null },
});
const AGENT_A = recordUtxo(AGENT_A_ID, rootRecord());
const AGENT_B = recordUtxo(AGENT_B_ID, rootRecord({ controller: B_CONTROLLER.publicKey, keys: [key(BKEY, 16)] }));
const DELEGATE = recordUtxo(DELEGATE_ID, delegateRecord());
const BASE = [AGENT_A, AGENT_B, DELEGATE];

function delegationDatum(overrides: Partial<DelegationDatum> = {}): DelegationDatum {
  return {
    delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash, organisation: null }, parent: null, delegate: AGENT_A_ID, delegateKey: LISTED.keyHash,
    actions: [utf8Hex('ocr.*'), utf8Hex(HIRE_ACTION)], resources: [utf8Hex('*')], notBefore: NOW - 10 * DAY, notAfter: NOW + 60 * DAY,
    depth: 1, remaining: 2, purpose: null, value: { perTx: 100_000_000n, total: 1_000_000_000n, periodMs: DAY }, ...overrides,
  };
}
let delegationCounter = 0;
function delegationUtxo(id: string, datum: DelegationDatum, lovelace = 1_500_000n): UTxO {
  delegationCounter += 1;
  return {
    txHash: 'dd'.repeat(32), outputIndex: delegationCounter, address: DEPLOYMENT.delegation.address,
    assets: { lovelace, [`${DEPLOYMENT.delegation.hash}${id}`]: 1n }, datum: encodeDelegationDatum(datum),
  };
}
/** The parent (a principal's delegation to agent A with LISTED) and the grandparent of a depth-3 chain. */
const PARENT = delegationUtxo(PARENT_ID, delegationDatum());
const GRANDPARENT = delegationUtxo(GRANDPARENT_ID, delegationDatum({ remaining: 3 }));
const MIDDLE = delegationUtxo(PARENT_ID, delegationDatum({
  delegator: { type: 'Agent', id: AGENT_A_ID }, parent: GRANDPARENT_ID, delegate: AGENT_B_ID, delegateKey: BKEY.keyHash, depth: 2, remaining: 2,
}));

// ─── Reading the built transaction ─────────────────────────────────────────────────────────────────────────────────────────────

const txOf = (cbor: string) => CML.Transaction.from_cbor_hex(cbor);
const refOf = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;
const DELEGATION_REF_SCRIPT = refOf(REF_UTXOS[2]);
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
function outputsAt(cbor: string, address: string): Array<{ lovelace: bigint; units: string[]; datum: string | null; scriptRef: boolean }> {
  const outputs = txOf(cbor).body().outputs();
  const found = [];
  for (let i = 0; i < outputs.len(); i++) {
    const o = outputs.get(i);
    if (o.address().to_bech32() !== address) continue;
    const ma = o.amount().multi_asset();
    const policies = ma.keys();
    const units: string[] = [];
    for (let j = 0; j < policies.len(); j++) {
      const names = ma.get_assets(policies.get(j))!.keys();
      for (let k = 0; k < names.len(); k++) units.push(`${policies.get(j).to_hex()}${names.get(k).to_hex()}:${ma.get_assets(policies.get(j))!.get(names.get(k))}`);
    }
    found.push({ lovelace: o.amount().coin(), units, datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null, scriptRef: o.script_ref() !== undefined });
  }
  return found;
}
/** The required signers of the transaction body, sorted. */
function signersOf(cbor: string): string[] {
  const list = txOf(cbor).body().required_signers();
  return list ? Array.from({ length: list.len() }, (_, i) => list.get(i).to_hex()).sort() : [];
}
function refsOf(cbor: string): string[] {
  const list = txOf(cbor).body().reference_inputs();
  return list ? Array.from({ length: list.len() }, (_, i) => `${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`).sort() : [];
}
/** The redeemers `[tag, data]` (0 spend, 1 mint), after checking that local evaluation of the applied script set execution units on each. */
function redeemersOf(cbor: string): Array<[number, string]> {
  const list = txOf(cbor).witness_set().redeemers()?.to_flat_format();
  const all = list ? Array.from({ length: list.len() }, (_, i) => list.get(i)) : [];
  assert.ok(all.length > 0 && all.every((r) => r.ex_units().mem() > 0n && r.ex_units().steps() > 0n), 'every redeemer has execution units from local evaluation');
  return all.map((r): [number, string] => [r.tag(), r.data().to_cbor_hex()]).sort((a, b) => a[0] - b[0]);
}

async function context(extra: UTxO[]) {
  const provider = identityWorld(extra);
  return { lucid: await lucidOn(provider), provider, deployment: DEPLOYMENT };
}
async function delegate(p: Partial<DelegateParams>, extra: UTxO[] = BASE) {
  return buildDelegate(await context(extra), {
    changeAddress: OWN_ADDRESS, nowMs: NOW, delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash }, delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash,
    actions: [HIRE_ACTION], resources: [ESCROW], notAfter: NOW + 30 * DAY, ...p,
  });
}
/** A sub-delegation of PARENT (whose delegate is agent A with LISTED) to the delegate with DKEY1. */
async function child(p: Partial<DelegateParams>, parent: UTxO = PARENT, extra: UTxO[] = BASE) {
  return delegate({ delegator: undefined, parent: PARENT_ID, actions: ['ocr.extract.*', HIRE_ACTION], value: { perTx: 50_000_000n, total: 500_000_000n, periodMs: DAY }, ...p }, [...extra, parent]);
}
const parentWith = (overrides: Partial<DelegationDatum>) => delegationUtxo(PARENT_ID, delegationDatum(overrides));

// ─── Delegate ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildDelegate (real delegation script, offline)', () => {
  test('a principal key: mint +1 named from the seed, one output at DA with the token and the ledger minimum, the datum, the signers', async () => {
    const r = await delegate({ delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash, organisation: utf8Hex('example.org') }, purpose: 'ee'.repeat(32), value: { perTx: 10_000_000n, total: 100_000_000n, periodMs: DAY } });
    const seed = FIXTURE_UTXOS[0];
    assert.equal(r.id, identifierFromSeed(seed));
    const unit = `${DEPLOYMENT.delegation.hash}${r.id}`;
    assert.deepEqual(mintOf(r.txCbor), { [unit]: 1n });
    const [out, ...more] = outputsAt(r.txCbor, DEPLOYMENT.delegation.address);
    assert.equal(more.length, 0);
    assert.deepEqual(out.units, [`${unit}:1`]);
    assert.equal(out.scriptRef, false);
    assert.equal(out.lovelace, r.outputLovelace);
    assert.ok(r.outputLovelace > 1_000_000n && r.outputLovelace < 3_000_000n);
    assert.deepEqual(decodeDelegationDatum(out.datum!), {
      delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash, organisation: utf8Hex('example.org') }, parent: null, delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash,
      actions: [utf8Hex(HIRE_ACTION)], resources: [utf8Hex(ESCROW)], notBefore: WINDOW.lo, notAfter: NOW + 30 * DAY, depth: 1, remaining: 0,
      purpose: 'ee'.repeat(32), value: { perTx: 10_000_000n, total: 100_000_000n, periodMs: DAY },
    });
    assert.deepEqual(signersOf(r.txCbor), [PRINCIPAL.keyHash, DKEY1.keyHash].sort());
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [PRINCIPAL.keyHash, DKEY1.keyHash, OWN_KEY_HASH]);
    assert.deepEqual(refsOf(r.txCbor), [DELEGATION_REF_SCRIPT, refOf(DELEGATE)].sort());
    assert.deepEqual(redeemersOf(r.txCbor), [[1, encodeDelegationMint({ type: 'Delegate', seed: { txHash: seed.txHash, outputIndex: seed.outputIndex } })]]);
  });

  test('an agent delegator: its controller by default, or a key it lists with the delegation purpose; its record is a reference input', async () => {
    const byController = await delegate({ delegator: { type: 'Agent', id: AGENT_A_ID } });
    assert.deepEqual(signersOf(byController.txCbor), [CONTROLLER.keyHash, DKEY1.keyHash].sort());
    assert.ok(refsOf(byController.txCbor).includes(refOf(AGENT_A)));
    assert.deepEqual(byController.delegation.delegator, { type: 'Agent', id: AGENT_A_ID });
    const byKey = await delegate({ delegator: { type: 'Agent', id: AGENT_A_ID, signer: LISTED.keyHash } });
    assert.deepEqual(signersOf(byKey.txCbor), [LISTED.keyHash, DKEY1.keyHash].sort());
    assert.deepEqual(byKey.requiredSigners[0].roles, [`delegation key of the delegator did:vector:${AGENT_A_ID}`]);
  });

  test("a sub-delegation: the parent's delegate is the delegator, the parent's delegate key signs, depth + 1, the chain and its records are read", async () => {
    const r = await child({ resources: [ESCROW], remaining: 1 });
    const datum = decodeDelegationDatum(outputsAt(r.txCbor, DEPLOYMENT.delegation.address)[0].datum!);
    assert.deepEqual(datum.delegator, { type: 'Agent', id: AGENT_A_ID });
    assert.equal(datum.parent, PARENT_ID);
    assert.equal(datum.depth, 2);
    assert.equal(datum.remaining, 1);
    assert.equal(datum.notBefore, WINDOW.lo);
    assert.deepEqual(signersOf(r.txCbor), [LISTED.keyHash, DKEY1.keyHash].sort());
    assert.deepEqual(r.requiredSigners[0].roles, [`delegate key of the parent delegation ${PARENT_ID} (did:vector:${AGENT_A_ID})`]);
    assert.deepEqual(refsOf(r.txCbor), [DELEGATION_REF_SCRIPT, refOf(PARENT), refOf(AGENT_A), refOf(DELEGATE)].sort());
    redeemersOf(r.txCbor);
  });

  test('depth 3 under a depth-2 parent: the whole chain and every record it reads are reference inputs; not_before follows a later parent start', async () => {
    const r = await delegate({ delegator: undefined, parent: PARENT_ID, actions: ['ocr.extract.v1'], resources: [], value: { perTx: 1n, total: 1n, periodMs: DAY } }, [...BASE, MIDDLE, GRANDPARENT]);
    assert.equal(r.delegation.depth, 3);
    assert.deepEqual(r.delegation.delegator, { type: 'Agent', id: AGENT_B_ID });
    assert.deepEqual(signersOf(r.txCbor), [BKEY.keyHash, DKEY1.keyHash].sort());
    assert.deepEqual(refsOf(r.txCbor), [DELEGATION_REF_SCRIPT, refOf(MIDDLE), refOf(GRANDPARENT), refOf(AGENT_A), refOf(AGENT_B), refOf(DELEGATE)].sort());
    const later = await child({ resources: [] }, parentWith({ notBefore: NOW + DAY }));
    assert.equal(later.delegation.notBefore, NOW + DAY);
  });

  test('datum refusals name the rule (Sections 5.1 and 5.2)', async () => {
    await assert.rejects(delegate({ actions: ['Ocr.extract'] }), /"Ocr.extract" is not an action pattern/);
    await assert.rejects(delegate({ actions: ['ocr.*.v1'] }), /is not an action pattern/);
    await assert.rejects(delegate({ resources: ['ocr.*'] }), /"ocr.\*" is not a resource pattern/);
    await assert.rejects(delegate({ resources: [`script:${'e5'.repeat(27)}e`] }), /is not a resource pattern/);
    await assert.rejects(delegate({ actions: [] }), /1 to 16 action patterns, got 0/);
    await assert.rejects(delegate({ actions: Array.from({ length: 17 }, (_, i) => `a${i}`) }), /1 to 16 action patterns, got 17/);
    await assert.rejects(delegate({ resources: Array.from({ length: 9 }, () => '*') }), /at most 8 resource patterns/);
    await assert.rejects(delegate({ notBefore: NOW + DAY, notAfter: NOW + DAY }), /must be before not_after/);
    await assert.rejects(delegate({ value: { perTx: 2n, total: 1n, periodMs: DAY } }), /per_tx \(2\) must be at most total/);
    await assert.rejects(delegate({ value: { perTx: 0n, total: 10_000_000_001n, periodMs: DAY } }), /at most 10,000 AP3X/);
    await assert.rejects(delegate({ value: { perTx: 0n, total: 0n, periodMs: 0 } }), /period_ms must be a whole number of at least 1/);
    await assert.rejects(delegate({ purpose: 'ee'.repeat(31) }), /purpose must be 32 bytes/);
    await assert.rejects(delegate({ remaining: 4 }), /depth 1 plus remaining 4 must be at most 4/);
    await assert.rejects(delegate({ delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash, organisation: '6f'.repeat(65) } }), /organisation must be 1 to 64 bytes/);
    await assert.rejects(delegate({ delegator: undefined }), /Name the delegator/);
  });

  test('delegate refusals: missing, not Active, a key without the delegation purpose, and a key that a live delegation uses (fresh keys)', async () => {
    await assert.rejects(delegate({}, [AGENT_A]), /No record of the delegate for did:vector:c3c3/);
    await assert.rejects(delegate({}, [recordUtxo(DELEGATE_ID, held(delegateRecord()))]), /The delegate did:vector:c3c3.* is Suspended/);
    await assert.rejects(delegate({ delegateKey: AUTH_ONLY.keyHash }), new RegExp(`does not list the key ${AUTH_ONLY.keyHash} with the delegation purpose.*${DKEY1.keyHash}, ${DKEY2.keyHash}`));
    const used = delegationUtxo(DELEGATION_ID, delegationDatum({ delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash }));
    await assert.rejects(delegate({}, [...BASE, used]), new RegExp(`${DELEGATION_ID} already uses the delegate key ${DKEY1.keyHash}.*Free delegation keys of did:vector:c3c3[0-9a-f]*: ${DKEY2.keyHash}`));
    const second = await delegate({ delegateKey: DKEY2.keyHash }, [...BASE, used]);
    assert.equal(second.delegation.delegateKey, DKEY2.keyHash);
  });

  test('agent delegator refusals: missing, not Active, a signer that is neither its controller nor a delegation key', async () => {
    await assert.rejects(delegate({ delegator: { type: 'Agent', id: 'f9'.repeat(32) } }), /No record of the delegator for did:vector:f9f9/);
    await assert.rejects(delegate({ delegator: { type: 'Agent', id: AGENT_A_ID } }, [recordUtxo(AGENT_A_ID, held(rootRecord())), DELEGATE]), /The delegator did:vector:a1a1.* is Suspended/);
    await assert.rejects(delegate({ delegator: { type: 'Agent', id: DELEGATE_ID, signer: AUTH_ONLY.keyHash }, delegateKey: DKEY2.keyHash }), /is neither the controller of did:vector:c3c3.* nor a key that it lists with the delegation purpose/);
  });

  test('parent refusals: missing, a broken chain, another delegator, no hops left, a removed parent key, a suspended delegator', async () => {
    await assert.rejects(child({}, delegationUtxo('9e'.repeat(32), delegationDatum())), /No live delegation 9a9a/);
    await assert.rejects(delegate({ delegator: undefined, parent: PARENT_ID, actions: ['ocr.extract.v1'] }, [...BASE, MIDDLE]), /parent delegation 9b9b.* no longer exists/);
    await assert.rejects(child({ delegator: { type: 'Agent', id: AGENT_B_ID } }), /delegator of a sub-delegation is the delegate of its parent: did:vector:a1a1/);
    await assert.rejects(child({}, parentWith({ remaining: 0 })), /allows no further hop/);
    await assert.rejects(child({}, PARENT, [recordUtxo(AGENT_A_ID, rootRecord({ keys: [] })), DELEGATE]), /no longer lists the delegate key .* of the parent delegation/);
    await assert.rejects(child({}, PARENT, [recordUtxo(AGENT_A_ID, held(rootRecord())), DELEGATE]), /The delegator did:vector:a1a1.* is Suspended/);
  });

  test('narrowing refusals: wider actions (oc.* does not cover ocr.*), an external used as a prefix, wider resources, period, hops and value', async () => {
    await assert.rejects(child({ actions: ['ocr.*'] }, parentWith({ actions: [utf8Hex('ocr.extract.*')] })), /no action pattern of the parent \("ocr.extract.\*"\) covers "ocr.\*"/);
    await assert.rejects(child({ actions: ['ocr.*'] }, parentWith({ actions: [utf8Hex('oc.*')] })), /covers "ocr.\*"/);
    await assert.rejects(child({ actions: ['mcp:tools.read'] }, parentWith({ actions: [utf8Hex('mcp:tools.*')] })), /covers "mcp:tools.read"/);
    await assert.rejects(child({ actions: ['*'] }), /covers "\*"/);
    await assert.rejects(child({ resources: ['*'] }, parentWith({ resources: [] })), /no resource pattern of the parent \(none\) covers "\*"/);
    await assert.rejects(child({ resources: [ESCROW] }, parentWith({ resources: [utf8Hex(SCRIPT_RESOURCE)] })), /no resource pattern of the parent/);
    await assert.rejects(child({ notBefore: NOW - 11 * DAY }), /must be inside the parent's/);
    await assert.rejects(child({ notAfter: NOW + 61 * DAY }), /must be inside the parent's/);
    await assert.rejects(child({ remaining: 2 }), /remaining \(2\) must be at most the parent's minus one \(1\)/);
    await assert.rejects(child({ value: undefined }), /the child needs one within it/);
    await assert.rejects(child({ value: { perTx: 100_000_001n, total: 100_000_001n, periodMs: DAY } }), /per_tx \(100000001\) must be at most the parent's/);
    await assert.rejects(child({ value: { perTx: 1n, total: 1_000_000_001n, periodMs: DAY } }), /total \(1000000001\) must be at most the parent's/);
    await assert.rejects(child({ value: { perTx: 1n, total: 1n, periodMs: DAY - 1 } }), /period_ms \(86399999\) must be at least the parent's/);
    const narrow = await child({ actions: ['ocr.*'], resources: [ESCROW] }, parentWith({ actions: [utf8Hex('ocr.*')], value: null }));
    assert.deepEqual(narrow.delegation.actions, [utf8Hex('ocr.*')]);
  });
});

// ─── Use checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('delegationUseProblems (port of chain.use_delegation)', () => {
  const link = (id: string, delegation: DelegationDatum): DelegationUtxo => ({ id, utxo: delegationUtxo(id, delegation), delegation });
  const usable = delegationDatum({
    delegator: { type: 'Agent', id: AGENT_A_ID }, parent: PARENT_ID, delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash, actions: [utf8Hex(HIRE_ACTION)],
    resources: [utf8Hex(ESCROW)], depth: 2, remaining: 0,
  });
  const chain = [link(DELEGATION_ID, usable), link(PARENT_ID, delegationDatum({ delegator: { type: 'Agent', id: AGENT_B_ID } }))];
  const records = new Map<string, IdentityDatum>([[AGENT_A_ID, rootRecord()], [AGENT_B_ID, rootRecord()], [DELEGATE_ID, delegateRecord()]]);

  test('a usable chain has no problem', () => {
    assert.deepEqual(delegationUseProblems(chain, records, HIRE_ACTION, ESCROW, WINDOW), []);
  });

  test('each use rule', () => {
    assert.match(delegationUseProblems(chain, records, 'ocr.extract', ESCROW, WINDOW).join(), /no action pattern .* covers "ocr.extract"/);
    assert.match(delegationUseProblems(chain, records, HIRE_ACTION, SCRIPT_RESOURCE, WINDOW).join(), /no resource pattern/);
    assert.match(delegationUseProblems([link(DELEGATION_ID, { ...usable, resources: [] }), chain[1]], records, HIRE_ACTION, ESCROW, WINDOW).join(), /an empty resource list covers nothing/);
    assert.match(delegationUseProblems(chain, records, HIRE_ACTION, ESCROW, { lo: NOW + 70 * DAY, hi: NOW + 70 * DAY + 1000 }).join(), /ends at/);
    assert.match(delegationUseProblems(chain, new Map([...records, [AGENT_A_ID, rootRecord({ keys: [] })]]), HIRE_ACTION, ESCROW, WINDOW).join(), /no longer lists the delegate key .* of 9a9a/);
    assert.match(delegationUseProblems(chain, new Map([...records, [DELEGATE_ID, held(delegateRecord())]]), HIRE_ACTION, ESCROW, WINDOW).join(), /is Suspended/);
    assert.match(delegationUseProblems(chain, new Map([...records, [AGENT_B_ID, tombstone(rootRecord())]]), HIRE_ACTION, ESCROW, WINDOW).join(), /root delegator did:vector:b4b4.* is Retired/);
    assert.match(delegationUseProblems(chain.slice(0, 1), records, HIRE_ACTION, ESCROW, WINDOW).join(), /parent delegation 9a9a.* is missing/);
  });
});

// ─── Undelegate ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function undelegate(id: string, extra: UTxO[], signer?: string) {
  return buildUndelegate(await context(extra), { changeAddress: OWN_ADDRESS, nowMs: NOW, id, signer });
}

describe('buildUndelegate (real delegation script, offline)', () => {
  test("a principal's delegation: burn exactly [(id, -1)], no output at DA, Undelegate as both redeemers, the principal key signs", async () => {
    const target = delegationUtxo(DELEGATION_ID, delegationDatum());
    const r = await undelegate(DELEGATION_ID, [...BASE, target]);
    const unit = `${DEPLOYMENT.delegation.hash}${DELEGATION_ID}`;
    assert.deepEqual(mintOf(r.txCbor), { [unit]: -1n });
    assert.equal(outputsAt(r.txCbor, DEPLOYMENT.delegation.address).length, 0);
    const undelegateRedeemer = encodeDelegationMint({ type: 'Undelegate' });
    assert.deepEqual(redeemersOf(r.txCbor), [[0, undelegateRedeemer], [1, undelegateRedeemer]]);
    assert.deepEqual(signersOf(r.txCbor), [PRINCIPAL.keyHash]);
    assert.deepEqual(refsOf(r.txCbor), [DELEGATION_REF_SCRIPT]);
    assert.equal(r.releasedLovelace, 1_500_000n);
    assert.equal(r.authorityLink, 0);
  });

  test("an agent's delegation: its controller by default or a delegation key, with the agent's record; a revoked agent still undelegates", async () => {
    const target = delegationUtxo(DELEGATION_ID, delegationDatum({ delegator: { type: 'Agent', id: AGENT_A_ID }, delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash }));
    const byController = await undelegate(DELEGATION_ID, [...BASE, target]);
    assert.deepEqual(signersOf(byController.txCbor), [CONTROLLER.keyHash]);
    assert.deepEqual(refsOf(byController.txCbor), [DELEGATION_REF_SCRIPT, refOf(AGENT_A)].sort());
    const byKey = await undelegate(DELEGATION_ID, [...BASE, target], LISTED.keyHash);
    assert.deepEqual(signersOf(byKey.txCbor), [LISTED.keyHash]);
    const revoked = recordUtxo(AGENT_A_ID, tombstone(rootRecord()));
    const ended = await undelegate(DELEGATION_ID, [revoked, DELEGATE, target]);
    assert.deepEqual(signersOf(ended.txCbor), [CONTROLLER.keyHash]);
  });

  test('the delegator of an ancestor signs: the walk adds the ancestors up to that link; an orphan is undelegated by its own delegator', async () => {
    const target = delegationUtxo(DELEGATION_ID, delegationDatum({
      delegator: { type: 'Agent', id: AGENT_B_ID }, parent: PARENT_ID, delegate: DELEGATE_ID, delegateKey: DKEY1.keyHash, depth: 3, remaining: 0,
    }));
    const byRoot = await undelegate(DELEGATION_ID, [...BASE, MIDDLE, GRANDPARENT, target], PRINCIPAL.keyHash);
    assert.equal(byRoot.authorityLink, 2);
    assert.deepEqual(signersOf(byRoot.txCbor), [PRINCIPAL.keyHash]);
    assert.deepEqual(refsOf(byRoot.txCbor), [DELEGATION_REF_SCRIPT, refOf(MIDDLE), refOf(GRANDPARENT)].sort());
    const byMiddle = await undelegate(DELEGATION_ID, [...BASE, MIDDLE, GRANDPARENT, target], CONTROLLER.keyHash);
    assert.equal(byMiddle.authorityLink, 1);
    assert.deepEqual(refsOf(byMiddle.txCbor), [DELEGATION_REF_SCRIPT, refOf(MIDDLE), refOf(AGENT_A)].sort());
    const orphan = await undelegate(DELEGATION_ID, [...BASE, target]);
    assert.deepEqual(signersOf(orphan.txCbor), [B_CONTROLLER.keyHash]);
  });

  test('refusals: a stranger, an agent key without the delegation purpose, a missing delegation', async () => {
    const target = delegationUtxo(DELEGATION_ID, delegationDatum({ delegator: { type: 'Agent', id: DELEGATE_ID }, delegate: AGENT_A_ID }));
    await assert.rejects(undelegate(DELEGATION_ID, [...BASE, target], testKey(30).keyHash), new RegExp(`is not a delegator's key of ${DELEGATION_ID}.*Who can sign: the controller ${DELEGATE_CONTROLLER.keyHash} or a delegation key \\(${DKEY1.keyHash}, ${DKEY2.keyHash}\\)`));
    await assert.rejects(undelegate(DELEGATION_ID, [...BASE, target], AUTH_ONLY.keyHash), /is not a delegator's key/);
    await assert.rejects(undelegate(DELEGATION_ID, BASE), /No live delegation 9c9c/);
  });
});
