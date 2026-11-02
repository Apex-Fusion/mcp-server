import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML, Constr, Data, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import {
  DEPLOYMENT, NOW, WINDOW, CONTROLLER, LISTED, PARTY_KEY, GUARDIAN_A, CONTROLLER_ACCOUNTABLE, M1, OWN_ADDRESS, LEGACY_IDS, REF_UTXOS,
  identityWorld, lucidOn, rootRecord, recordUtxo, testKey,
} from './fixtures/identity-world.ts';
import { legacyAgentDatum } from './fixtures/legacy-datum.ts';
import { LEGACY_BURN_REDEEMER, LEGACY_DEREGISTER_REDEEMER, LEGACY_OWNER_OUTPUT_LOVELACE, buildAdopt, buildRegister } from '../src/vector/identity-build.ts';
import type { AdoptParams } from '../src/vector/identity-build.ts';
import { decodeIdentityDatum, decodeIdentityMint, encodeIdentityDatum, encodeIdentityMint, encodeLegacyDatum, utf8Hex } from '../src/vector/identity-codec.ts';
import type { IdentityDatum } from '../src/vector/identity-codec.ts';
import { chainClock, identifierFromSeed, windowAt } from '../src/vector/identity-chain.ts';
import { allowlistProof } from '../src/vector/identity-rules.ts';
import { LEGACY_REGISTRY_POLICY_ID, legacyRegistryAddress, legacyRegistryScript } from '../src/vector/legacy-registry.ts';
import { FIXTURE_UTXOS } from './fixtures/fixture-provider.ts';

const OWN_KEY_HASH = CML.Address.from_bech32(OWN_ADDRESS).payment_cred()!.as_pub_key()!.to_hex();

async function register(extra: Parameters<typeof buildRegister>[1] extends infer P ? Partial<P> : never, utxos = [] as ReturnType<typeof recordUtxo>[]) {
  const provider = identityWorld(utxos);
  const lucid = await lucidOn(provider);
  return buildRegister({ lucid, provider, deployment: DEPLOYMENT }, {
    changeAddress: OWN_ADDRESS, nowMs: NOW, controller: CONTROLLER.publicKey,
    keys: [{ keyType: 'Ed25519', key: LISTED.publicKey, purposes: 9, pop: null }],
    parties: [{ role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notAfter: null, rights: 3, removalAfter: null }],
    name: utf8Hex('Unit Agent'), capabilities: [utf8Hex('demo.text.stats.v1')],
    ...extra,
  });
}

describe('buildRegister (real identity script, offline)', () => {
  test('a root record: mint +1 under the identity policy, the record output, created_at = hi, the signers', async () => {
    const r = await register({});
    const seed = FIXTURE_UTXOS.reduce((a, b) => (b.assets.lovelace > a.assets.lovelace && Object.keys(b.assets).length === 1 ? b : a));
    assert.equal(r.id, identifierFromSeed(seed));
    assert.equal(r.did, `did:vector:${r.id}`);
    assert.equal(r.createdAt, WINDOW.hi);
    assert.deepEqual([r.validFrom, r.validTo], [WINDOW.lo, WINDOW.hi]);
    const tx = CML.Transaction.from_cbor_hex(r.txCbor);
    const out = tx.body().outputs().get(r.recordOutputIndex);
    assert.equal(out.address().to_bech32(), DEPLOYMENT.identity.address);
    const datum = decodeIdentityDatum(out.datum()!.as_datum()!.to_cbor_hex());
    assert.equal(datum.createdAt, WINDOW.hi);
    assert.equal(datum.parties[0].notBefore, WINDOW.lo);
    const required = r.requiredSigners.map((s) => s.keyHash);
    assert.deepEqual(required, [CONTROLLER.keyHash, LISTED.keyHash, OWN_KEY_HASH]);
    assert.deepEqual(r.requiredSigners[0].roles, ['controller', 'party 1 (Accountable) (the controller)']);
  });

  test('a key-hash party and a guardian sign as parties; Module-1 as a party adds its consent withdrawal', async () => {
    const r = await register({
      parties: [
        { role: 'Accountable', signer: { type: 'KeyHash', hash: PARTY_KEY.keyHash }, organisation: utf8Hex('example.org'), notAfter: null, rights: 3, removalAfter: null },
        { role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, notAfter: null, rights: 1, removalAfter: null },
        { role: 'Guardian', signer: { type: 'KeyHash', hash: GUARDIAN_A.keyHash }, organisation: null, notAfter: null, rights: 4, removalAfter: null },
      ],
      guardianThreshold: 1,
    });
    const tx = CML.Transaction.from_cbor_hex(r.txCbor);
    assert.equal(tx.body().withdrawals()?.len(), 1);
    const hashes = r.requiredSigners.map((s) => s.keyHash);
    assert.ok(hashes.includes(PARTY_KEY.keyHash) && hashes.includes(GUARDIAN_A.keyHash));
  });

  test('a subagent names its parent, the parent epoch and depth 1, and the parent controller signs', async () => {
    const parentId = 'ab'.repeat(32);
    const r = await register({ parent: parentId, endpoint: '' }, [recordUtxo(parentId, rootRecord({ subagentEpoch: 3 }))]);
    assert.deepEqual(r.record.lineage, { type: 'Subagent', parent: parentId, parentEpoch: 3, depth: 1 });
    assert.ok(r.requiredSigners.some((s) => s.roles.some((role) => role.startsWith('controller of the parent'))));
  });

  test('refusals name the rule', async () => {
    await assert.rejects(register({ parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: NOW + 3_600_000 }] }), /Accountable Party that covers/);
    await assert.rejects(register({ guardianThreshold: 1 }), /guardian threshold/);
    await assert.rejects(register({ depositLovelace: 9_999_999n }), /at least 10 AP3X/);
    await assert.rejects(register({ name: '' }), /name must be 1 to 64 bytes/);
  });

  test('a record whose ledger minimum is above 10 AP3X locks its ledger minimum', async () => {
    const r = await register({
      description: utf8Hex('d'.repeat(256)), endpoint: utf8Hex(`https://${'e'.repeat(240)}.example`),
      capabilities: Array.from({ length: 16 }, (_, i) => utf8Hex(`${String(i).padStart(2, '0')}${'c'.repeat(62)}`)),
      keys: Array.from({ length: 8 }, (_, i) => ({ keyType: 'Ed25519' as const, key: testKey(20 + i).publicKey, purposes: 27, pop: null })),
    });
    assert.ok(r.depositLovelace > 10_000_000n, `deposit ${r.depositLovelace}`);
    assert.equal(CML.Transaction.from_cbor_hex(r.txCbor).body().outputs().get(r.recordOutputIndex).amount().coin(), r.depositLovelace);
  });
});

// ─── Adopt (Part 2 Sections 3.4 and 9.1): the real identity script and the real legacy script ─────────────────────────────────

const LEGACY_ID = LEGACY_IDS[0];
const LEGACY_UNIT = `${LEGACY_REGISTRY_POLICY_ID}${LEGACY_ID}`;
const ALLOWLIST_URL = 'https://203.0.113.10/allowlist.json';
const LEGACY_DATUM = legacyAgentDatum(OWN_KEY_HASH, 'Legacy Agent', 'A legacy agent', ['demo.text.stats.v1'], 'custom', 'https://legacy.example');

/** A legacy record output at the exact legacy address with its token and an inline datum. */
function legacyUtxo(datum: string, assets: Record<string, bigint> = { [LEGACY_UNIT]: 1n }, lovelace = 10_000_000n): UTxO {
  return { txHash: '1e'.repeat(32), outputIndex: 0, address: legacyRegistryAddress(), assets: { lovelace, ...assets }, datum };
}

const allowlistFetch = (body: string, status = 200) => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => { asked.push(String(url)); return new Response(body, { status }); }) as unknown as typeof fetch;
  return { fetchImpl, asked };
};

async function adopt(extra: Partial<AdoptParams>, utxos: UTxO[] = [legacyUtxo(LEGACY_DATUM)], deployment = DEPLOYMENT) {
  const provider = identityWorld(utxos);
  const lucid = await lucidOn(provider);
  return buildAdopt({ lucid, provider, deployment }, {
    changeAddress: OWN_ADDRESS, nowMs: NOW, id: LEGACY_ID, controller: CONTROLLER.publicKey,
    keys: [{ keyType: 'Ed25519', key: LISTED.publicKey, purposes: 9, pop: null }],
    parties: [{ role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notAfter: null, rights: 3, removalAfter: null }],
    proof: allowlistProof(LEGACY_IDS, LEGACY_ID),
    ...extra,
  });
}

/** The mint of a built transaction, by unit. */
function mintOf(txCbor: string): Record<string, bigint> {
  const mint = CML.Transaction.from_cbor_hex(txCbor).body().mint()!;
  const units: Record<string, bigint> = {};
  const policies = mint.keys();
  for (let i = 0; i < policies.len(); i++) {
    const assets = mint.get_assets(policies.get(i))!;
    const names = assets.keys();
    for (let j = 0; j < names.len(); j++) units[`${policies.get(i).to_hex()}${names.get(j).to_hex()}`] = assets.get(names.get(j))!;
  }
  return units;
}

/** The redeemers of a built transaction as tag, index and Plutus Data CBOR. */
function redeemersOf(txCbor: string): Array<{ tag: number; index: number; data: string }> {
  const list = CML.Transaction.from_cbor_hex(txCbor).witness_set().redeemers()!.to_flat_format();
  return Array.from({ length: list.len() }, (_, i) => ({ tag: list.get(i).tag(), index: Number(list.get(i).index()), data: list.get(i).data().to_cbor_hex() }));
}

describe('buildAdopt (real identity script and real legacy script, offline)', () => {
  test('with a proof: burns the legacy token, mints the identity token, spends the legacy record, copies the profile, pays the owner 10 AP3X', async () => {
    const proof = allowlistProof(LEGACY_IDS, LEGACY_ID);
    const r = await adopt({});
    assert.equal(r.did, `did:vector:${LEGACY_ID}`);
    assert.equal(r.legacyDid, `did:vector:agent:${LEGACY_REGISTRY_POLICY_ID}:${LEGACY_ID}`);
    assert.deepEqual(mintOf(r.txCbor), { [`${DEPLOYMENT.identity.hash}${LEGACY_ID}`]: 1n, [LEGACY_UNIT]: -1n });

    const policies = [DEPLOYMENT.identity.hash, LEGACY_REGISTRY_POLICY_ID].sort();
    const redeemers = redeemersOf(r.txCbor);
    const mints = redeemers.filter((x) => x.tag === CML.RedeemerTag.Mint);
    const identityMint = mints.find((x) => policies[x.index] === DEPLOYMENT.identity.hash)!;
    const legacyBurn = mints.find((x) => policies[x.index] === LEGACY_REGISTRY_POLICY_ID)!;
    assert.deepEqual(decodeIdentityMint(identityMint.data), { type: 'Adopt', proof });
    assert.equal(legacyBurn.data, LEGACY_BURN_REDEEMER);
    const spends = redeemers.filter((x) => x.tag === CML.RedeemerTag.Spend);
    assert.deepEqual(spends.map((x) => x.data), [LEGACY_DEREGISTER_REDEEMER]);
    assert.equal(LEGACY_BURN_REDEEMER, Data.to(new Constr(1, [])));

    const body = CML.Transaction.from_cbor_hex(r.txCbor).body();
    const inputs = Array.from({ length: body.inputs().len() }, (_, i) => `${body.inputs().get(i).transaction_id().to_hex()}#${body.inputs().get(i).index()}`);
    assert.ok(inputs.includes(`${'1e'.repeat(32)}#0`));
    const record = decodeIdentityDatum(body.outputs().get(r.recordOutputIndex).datum()!.as_datum()!.to_cbor_hex());
    assert.deepEqual(record, {
      controller: CONTROLLER.publicKey, keys: [{ keyType: 'Ed25519', key: LISTED.publicKey, purposes: 9, pop: null }],
      parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: WINDOW.lo }], guardianThreshold: 0, pendingRecovery: null, lineage: { type: 'Root' }, subagentEpoch: 0,
      name: utf8Hex('Legacy Agent'), description: utf8Hex('A legacy agent'), framework: utf8Hex('custom'), endpoint: utf8Hex('https://legacy.example'),
      capabilities: [utf8Hex('demo.text.stats.v1')], createdAt: WINDOW.hi, status: { type: 'Active' },
    });
    assert.equal(body.outputs().get(r.recordOutputIndex).amount().coin(), 10_000_000n);
    const owner = body.outputs().get(r.ownerOutputIndex);
    assert.deepEqual([owner.address().to_bech32(), owner.amount().coin()], [OWN_ADDRESS, LEGACY_OWNER_OUTPUT_LOVELACE]);
    assert.deepEqual(r.profileFrom, { name: 'legacy', description: 'legacy', framework: 'legacy', endpoint: 'legacy', capabilities: 'legacy' });

    const required = body.required_signers()!;
    const hashes = new Set(Array.from({ length: required.len() }, (_, i) => required.get(i).to_hex()));
    assert.deepEqual(hashes, new Set([OWN_KEY_HASH, CONTROLLER.keyHash, LISTED.keyHash]));
    assert.deepEqual(r.requiredSigners[0], { keyHash: OWN_KEY_HASH, roles: ['legacy owner', 'wallet (inputs, fee and collateral)'] });
  });

  test('without a proof: reads the allowlist file of the deployment through safeFetch and computes the proof', async () => {
    const { fetchImpl, asked } = allowlistFetch(JSON.stringify(LEGACY_IDS.map((id) => id.toUpperCase())));
    const r = await adopt({ proof: undefined, fetchImpl }, undefined, { ...DEPLOYMENT, allowlistUrl: ALLOWLIST_URL });
    assert.deepEqual(asked, [ALLOWLIST_URL]);
    assert.equal(r.proofFrom, 'allowlist');
    assert.deepEqual(r.proof, allowlistProof(LEGACY_IDS, LEGACY_ID));
  });

  test('an owner that is not the wallet: the 10 AP3X go to the enterprise address of the owner key, and the owner key signs', async () => {
    const owner = testKey(8);
    const r = await adopt({}, [legacyUtxo(legacyAgentDatum(owner.keyHash, 'Legacy Agent', '', [], '', ''))]);
    const ownerAddress = credentialToAddress('Mainnet', { type: 'Key', hash: owner.keyHash });
    assert.equal(r.ownerAddress, ownerAddress);
    const output = CML.Transaction.from_cbor_hex(r.txCbor).body().outputs().get(r.ownerOutputIndex);
    assert.deepEqual([output.address().to_bech32(), output.amount().coin()], [ownerAddress, 10_000_000n]);
    assert.deepEqual(r.requiredSigners[0], { keyHash: owner.keyHash, roles: ['legacy owner'] });
  });

  test('profile copy: each legacy field that breaks a limit needs a new value; given values replace the legacy ones', async () => {
    const wide = [legacyUtxo(legacyAgentDatum(OWN_KEY_HASH, 'n'.repeat(80), 'd'.repeat(300), Array.from({ length: 17 }, (_, i) => `cap.${i}`), 'custom', 'https://legacy.example'))];
    await assert.rejects(adopt({}, wide), /give a new value for each: name \(1 to 64 bytes; the legacy name has 80\); description \(up to 256 bytes; the legacy description has 300\); capabilities \(up to 16 capabilities/);
    const r = await adopt({ profile: { name: utf8Hex('Short Name'), description: utf8Hex(''), capabilities: [utf8Hex('demo.text.stats.v1')] } }, wide);
    assert.deepEqual(r.profileFrom, { name: 'given', description: 'given', framework: 'legacy', endpoint: 'legacy', capabilities: 'given' });
    assert.equal(r.record.name, utf8Hex('Short Name'));
  });

  test('refusals say why the record cannot adopt', async () => {
    const scriptOwned = encodeLegacyDatum({
      owner: { type: 'Script', hash: '9a'.repeat(28) }, name: utf8Hex('x'), description: '', capabilities: [], framework: '', endpoint: '', registeredAt: 0n,
    });
    await assert.rejects(adopt({}, [legacyUtxo(scriptOwned)]), /is owned by the script 9a9a.*cannot adopt/);
    await assert.rejects(adopt({}, [legacyUtxo(Data.to(new Constr(0, [])))]), /has a datum that does not decode as a legacy record/);
    await assert.rejects(adopt({ proof: allowlistProof(LEGACY_IDS, LEGACY_IDS[1]) }), /does not lead to the deployment's root/);
    await assert.rejects(adopt({ proof: undefined }), /no allowlist URL \(VECTOR_IDENTITY_ALLOWLIST_URL\)/);
    await assert.rejects(adopt({}, []), /No legacy record holds the token/);
    await assert.rejects(adopt({}, [recordUtxo(LEGACY_ID, rootRecord())]), /is already in the identity registry as did:vector:1111/);
    await assert.rejects(adopt({}, [legacyUtxo(LEGACY_DATUM, { [LEGACY_UNIT]: 1n, [`${LEGACY_REGISTRY_POLICY_ID}${LEGACY_IDS[1]}`]: 1n })]), /shares the output .* with another legacy token/);
    await assert.rejects(adopt({ depositLovelace: 9_999_999n }), /at least 10 AP3X/);
    await assert.rejects(adopt({ parties: [{ role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, notAfter: null, rights: 1, removalAfter: null }] }), /Accountable Party that covers/);
    await assert.rejects(adopt({
      parties: [
        { role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notAfter: null, rights: 3, removalAfter: null },
        { role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, notAfter: null, rights: 0, removalAfter: null },
      ],
    }), /Module-1 would not consent to this appointment/);

    const url = { ...DEPLOYMENT, allowlistUrl: ALLOWLIST_URL };
    const other = '66'.repeat(32);
    await assert.rejects(adopt({ id: other, proof: undefined, fetchImpl: allowlistFetch(JSON.stringify(LEGACY_IDS)).fetchImpl },
      [legacyUtxo(LEGACY_DATUM, { [`${LEGACY_REGISTRY_POLICY_ID}${other}`]: 1n })], url), /is not on the adoption allowlist/);
    await assert.rejects(adopt({ proof: undefined, fetchImpl: allowlistFetch(JSON.stringify([...LEGACY_IDS, other])).fetchImpl }, undefined, url), /does not give the deployment's root/);
    await assert.rejects(adopt({ proof: undefined, fetchImpl: allowlistFetch('oops', 500).fetchImpl }, undefined, url), /answered HTTP 500/);
    await assert.rejects(adopt({ proof: undefined, fetchImpl: allowlistFetch('not json').fetchImpl }, undefined, url), /is not JSON/);
    await assert.rejects(adopt({ proof: undefined, fetchImpl: allowlistFetch('[1,2]').fetchImpl }, undefined, url), /is not a JSON list of identifiers/);
  });
});

describe('the adoption shape against the real legacy script', () => {
  // The legacy Deregister needs one output of at least 10 AP3X to the owner key (W1F, measured). Here the owner is not the wallet, so no
  // change output can meet the rule by chance; the shapes differ only in the outputs to the owner key.
  async function shape(ownerOutputs: bigint[]) {
    const owner = testKey(8);
    const legacy = legacyUtxo(legacyAgentDatum(owner.keyHash, 'Legacy Agent', '', [], '', ''));
    const provider = identityWorld([legacy]);
    const lucid = await lucidOn(provider);
    await chainClock(provider);
    const window = windowAt(NOW);
    const unit = `${DEPLOYMENT.identity.hash}${LEGACY_ID}`;
    const record: IdentityDatum = rootRecord({ keys: [], parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: window.lo }], createdAt: window.hi });
    let tx = lucid.newTx()
      .collectFrom([legacy], LEGACY_DEREGISTER_REDEEMER).attach.SpendingValidator(legacyRegistryScript())
      .mintAssets({ [LEGACY_UNIT]: -1n }, LEGACY_BURN_REDEEMER).attach.MintingPolicy(legacyRegistryScript())
      .mintAssets({ [unit]: 1n }, encodeIdentityMint({ type: 'Adopt', proof: allowlistProof(LEGACY_IDS, LEGACY_ID) }))
      .pay.ToContract(DEPLOYMENT.identity.address, { kind: 'inline', value: encodeIdentityDatum(record) }, { lovelace: 10_000_000n, [unit]: 1n })
      .readFrom([REF_UTXOS[0]]).addSignerKey(owner.keyHash).addSignerKey(CONTROLLER.keyHash).validFrom(window.lo).validTo(window.hi);
    for (const lovelace of ownerOutputs) tx = tx.pay.ToAddress(credentialToAddress('Mainnet', { type: 'Key', hash: owner.keyHash }), { lovelace });
    return tx.complete();
  }

  test('no owner output, or two of 5 AP3X, fail the legacy Deregister; one output of 10 AP3X passes', async () => {
    await assert.rejects(shape([]), /failed script execution Spend/);
    await assert.rejects(shape([5_000_000n, 5_000_000n]), /failed script execution Spend/);
    await shape([LEGACY_OWNER_OUTPUT_LOVELACE]);
  });
});
