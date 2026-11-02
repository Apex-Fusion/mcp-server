import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  CML, getAddressDetails, Data, Constr, fromText, credentialToAddress, validatorToScriptHash,
} from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import {
  FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FIXTURE_TOKEN_UNIT,
} from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  parseDid, parseAgentDatum, resolveAgentUtxo, buildDeregisterAgent,
} from '../src/vector/registry-build.ts';
import {
  LEGACY_REGISTRY_POLICY_ID, LEGACY_REGISTRY_DEPOSIT, legacyRegistryAddress, legacyRegistryScript, legacyDid,
} from '../src/vector/legacy-registry.ts';
import { legacyAgentDatum } from './fixtures/legacy-datum.ts';

// The REAL registry validator evaluates during .complete() (native UPLC, offline).
// A passing build here is ground-truth phase-2 validity, minus signatures.
// The legacy register, update and transfer builders are retired (Part 2 Section 10); the legacy reads and the
// deregistration of a record that does not adopt stay.

const OWN_VKEY_HASH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
// A registry UTxO owned by OWN_ADDRESS, for resolution and build tests.
const AGENT_NFT_NAME = 'ab'.repeat(32); // 64 hex chars
const AGENT_UNIT = `${LEGACY_REGISTRY_POLICY_ID}${AGENT_NFT_NAME}`;
const AGENT_DID = `did:vector:agent:${LEGACY_REGISTRY_POLICY_ID}:${AGENT_NFT_NAME}`;
let REGISTRY_UTXO: UTxO;

before(() => {
  REGISTRY_UTXO = {
    txHash: 'cd'.repeat(32), outputIndex: 0,
    address: legacyRegistryAddress(),
    assets: { lovelace: LEGACY_REGISTRY_DEPOSIT, [AGENT_UNIT]: 1n },
    datum: legacyAgentDatum(OWN_VKEY_HASH, 'FixtureAgent', 'offline fixture agent', ['testing'], 'custom', '', 1750000000000),
  };
});

function decodeTx(cborHex: string) {
  return CML.Transaction.from_cbor_hex(cborHex);
}

describe('registry constants and helpers', () => {
  test('the legacy registry address is the one Part 1 Section 4 names', () => {
    assert.equal(legacyRegistryAddress(), 'addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42');
  });

  test('the legacy policy ID is the hash of the legacy script', () => {
    assert.equal(validatorToScriptHash(legacyRegistryScript()), LEGACY_REGISTRY_POLICY_ID);
  });

  test('legacyDid writes the legacy DID form of an identifier', () => {
    assert.equal(legacyDid(AGENT_NFT_NAME), AGENT_DID);
  });

  test('parseDid round-trips and rejects malformed DIDs', () => {
    const d = parseDid(AGENT_DID);
    assert.equal(d.policyId, LEGACY_REGISTRY_POLICY_ID);
    assert.equal(d.assetName, AGENT_NFT_NAME);
    assert.equal(d.unit, AGENT_UNIT);
    assert.throws(() => parseDid('did:vector:wrong:x:y'), /Invalid agent DID/);
    assert.throws(() => parseDid(`did:vector:agent:${LEGACY_REGISTRY_POLICY_ID}:NOTHEX`), /hex/);
  });

  test('parseAgentDatum reads a legacy datum exactly', () => {
    const datum = legacyAgentDatum(OWN_VKEY_HASH, 'A name', 'desc', ['a', 'b'], 'fw', 'https://x.example', 1234);
    const p = parseAgentDatum(datum, 'ref#0', { lovelace: 1n, [AGENT_UNIT]: 1n })!;
    assert.equal(p.name, 'A name');
    assert.deepEqual(p.capabilities, ['a', 'b']);
    assert.equal(p.ownerVkeyHash, OWN_VKEY_HASH);
    assert.equal(p.registeredAt, 1234);
    assert.equal(p.agentId, AGENT_DID);
  });

  test('parseAgentDatum returns null on garbage, never throws', () => {
    assert.equal(parseAgentDatum('deadbeef', 'ref#0', {}), null);
    assert.equal(parseAgentDatum(Data.to(new Constr(1, [])), 'ref#0', {}), null);
  });

  test('parseAgentDatum returns null when the datum has the wrong field count (missing registeredAt)', () => {
    const sixFieldDatum = Data.to(new Constr(0, [
      new Constr(0, ['00'.repeat(28)]), fromText('x'), fromText('x'), [], fromText('x'), fromText('x'),
    ]));
    assert.equal(parseAgentDatum(sixFieldDatum, 'ref#0', {}), null);
  });

  test('the legacy deposit is the protocol deposit floor exactly', () => {
    assert.equal(LEGACY_REGISTRY_DEPOSIT, 10_000_000n, 'protocol deposit constant drifted');
  });
});

describe('resolveAgentUtxo (not found)', () => {
  test('an unknown agent DID fails with agent-not-found, not a network error', async () => {
    const provider = new FixtureProvider(FIXTURE_UTXOS); // no registry UTxO
    await assert.rejects(resolveAgentUtxo(provider, AGENT_DID), /Agent not found/);
  });
});

describe('resolveAgentUtxo (Koios/address-scan fallback)', () => {
  test('falls through to the address re-scan when getUtxoByUnit resolves but with no datum', async () => {
    // getUtxoByUnit "succeeding" with a datum-less UTxO (e.g. a Koios hit that
    // only carries a datum hash, not the inline datum) must not be treated as
    // resolved - resolveAgentUtxo has to notice the missing datum and fall
    // back to scanning the registry address, same as when getUtxoByUnit
    // throws outright. Under plain FixtureProvider this branch is dead
    // (getUtxoByUnit always throws), so it needs its own provider double.
    const base = new FixtureProvider([...FIXTURE_UTXOS, REGISTRY_UTXO]);
    const wrapped = {
      getUtxos: (a: string) => base.getUtxos(a),
      getUtxoByUnit: async () => ({ ...REGISTRY_UTXO, datum: null }),
    };
    // A stand-in for the two provider methods resolveAgentUtxo reads; the datum-less hit is the case under test.
    const stub = wrapped as unknown as Parameters<typeof resolveAgentUtxo>[0];
    const { profile, utxo, nftUnit } = await resolveAgentUtxo(stub, AGENT_DID);
    assert.equal(nftUnit, AGENT_UNIT);
    assert.equal(utxo.datum, REGISTRY_UTXO.datum, 're-scanned UTxO must carry the real inline datum, not the datum-less stand-in');
    assert.equal(profile.name, 'FixtureAgent');
    assert.equal(profile.agentId, AGENT_DID);
  });
});

describe('legacy deregistration (real validator, offline)', () => {
  function ownedProvider() {
    return new FixtureProvider([...FIXTURE_UTXOS, REGISTRY_UTXO]);
  }

  test('ownership fail-fast: a non-owner changeAddress is refused before building', async () => {
    // FOREIGN_ADDRESS is a script address in the fixture set; use a foreign KEY address instead.
    const stranger = credentialToAddress('Mainnet', { type: 'Key', hash: '00'.repeat(28) });
    // a lucid for the stranger (their own address-only wallet, holding nothing at the registry)
    const strangerProvider = new FixtureProvider([
      { txHash: 'ee'.repeat(32), outputIndex: 0, address: stranger, assets: { lovelace: 50_000_000n } },
      REGISTRY_UTXO,
    ]);
    const strangerLucid = await lucidForAddress(strangerProvider, stranger);
    await assert.rejects(buildDeregisterAgent(strangerLucid, strangerProvider, { agentId: AGENT_DID }), /Ownership check failed/);
  });

  test('deregister burns the NFT and leaves no registry output (deposit comes back as change)', async () => {
    const provider = ownedProvider();
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const r = await buildDeregisterAgent(lucid, provider, {
      agentId: AGENT_DID,
    });
    assert.equal(r.op, 'deregister');
    assert.equal(r.agentName, 'FixtureAgent');
    const tx = decodeTx(r.txCbor);
    const outs = tx.body().outputs();
    for (let i = 0; i < outs.len(); i++) {
      assert.notEqual(outs.get(i).address().to_bech32(), legacyRegistryAddress(),
        'deregister must not leave an output at the registry');
      // every output is change to the owner
      assert.equal(outs.get(i).address().to_bech32(), OWN_ADDRESS);
    }
    assert.ok(tx.body().mint(), 'no mint (burn) field on the deregister tx');
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'must be unsigned');
  });

  test('deregister picks the LARGEST pure-AP3X wallet UTxO as the extra input', async () => {
    const small = { txHash: 'a1'.repeat(32), outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 3_000_000n } };
    const large = { txHash: 'a2'.repeat(32), outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 900_000_000n } };
    // small listed FIRST so first-match selection would pick it
    const provider = new FixtureProvider([small, large, REGISTRY_UTXO]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const r = await buildDeregisterAgent(lucid, provider, { agentId: AGENT_DID });
    const tx = CML.Transaction.from_cbor_hex(r.txCbor);
    const ins = tx.body().inputs();
    let sawLarge = false, sawSmall = false;
    for (let i = 0; i < ins.len(); i++) {
      const h = ins.get(i).transaction_id().to_hex();
      if (h === 'a2'.repeat(32)) sawLarge = true;
      if (h === 'a1'.repeat(32)) sawSmall = true;
    }
    assert.ok(sawLarge, 'largest pure-AP3X UTxO must be the chosen extra input');
    assert.ok(!sawSmall, 'the smaller pure-AP3X UTxO must not be chosen over the larger');
  });
});

// Correction round (see task-3-report.md): differential testing against the
// REAL deployed validator (not the in-workspace Aiken source, which turned
// out to compile to an unrelated policy - see the report) found the deployed
// script enforces a returned-change floor on Deregister. These tests pin that
// corrected understanding.
describe('legacy deregister floor (correction, real validator)', () => {
  function overfundedRegistryUtxo(lovelace: bigint) {
    return {
      txHash: 'ce'.repeat(32), outputIndex: 0,
      address: legacyRegistryAddress(),
      assets: { lovelace, [AGENT_UNIT]: 1n },
      datum: legacyAgentDatum(OWN_VKEY_HASH, 'FixtureAgent', 'offline fixture agent', ['testing'], 'custom', '', 1750000000000),
    };
  }

  test('validator floor pin: deregister of an over-funded (25 AP3X) registry UTxO succeeds with no extra input pulled in', async () => {
    // Direct build (not through buildDeregisterAgent, which now
    // unconditionally requires a fee UTxO whenever the wallet has one) -
    // pins the underlying chain fact that motivates that requirement: the
    // deployed validator's returned-change floor is cleared by the registry
    // deposit alone once it's well above LEGACY_REGISTRY_DEPOSIT. Confirms this is
    // a genuine value floor on the validator side, not "any sole-input
    // deregister fails" (which was the earlier, wrong diagnosis).
    const overfunded = overfundedRegistryUtxo(25_000_000n);
    const provider = new FixtureProvider([overfunded, ...FIXTURE_UTXOS]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const spendRedeemer = Data.to(new Constr(1, []));
    const mintRedeemer = Data.to(new Constr(1, []));
    const completed = await lucid.newTx()
      .collectFrom([overfunded], spendRedeemer)
      .attach.SpendingValidator(legacyRegistryScript())
      .mintAssets({ [AGENT_UNIT]: -1n }, mintRedeemer)
      .attach.MintingPolicy(legacyRegistryScript())
      .addSigner(OWN_ADDRESS)
      .complete();
    const tx = decodeTx(completed.toCBOR());
    assert.equal(tx.body().inputs().len(), 1, 'sole input - Lucid should not need to pull in any extra wallet UTxO here');

    // Pin: buildDeregisterAgent's returned `detail` is the ACTUAL spent
    // registry UTxO lovelace (25 AP3X here), not the LEGACY_REGISTRY_DEPOSIT
    // constant. Goes through buildDeregisterAgent itself (unlike the direct
    // build above), which is safe here because the provider also carries
    // FIXTURE_UTXOS, so the extra fee UTxO that path unconditionally pulls in
    // is available.
    const r = await buildDeregisterAgent(lucid, provider, { agentId: AGENT_DID });
    assert.equal(r.detail, '25000000', 'detail must be the spent registry UTxO lovelace, not the constant');
  });

  test('deregister throws an actionable error (not a validator crash) when the wallet has no plain AP3X-only UTxO', async () => {
    const tokenOnlyUtxo = {
      txHash: 'df'.repeat(32), outputIndex: 0, address: OWN_ADDRESS,
      assets: { lovelace: 1_000_000_000n, [FIXTURE_TOKEN_UNIT]: 500n },
    };
    const provider = new FixtureProvider([tokenOnlyUtxo, REGISTRY_UTXO]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(buildDeregisterAgent(lucid, provider, {
      agentId: AGENT_DID,
    }), /AP3X-only UTxO/);
  });
});
