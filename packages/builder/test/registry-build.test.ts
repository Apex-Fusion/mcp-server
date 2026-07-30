import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  CML, getAddressDetails, Data, Constr, toText, fromText, credentialToAddress,
} from '@lucid-evolution/lucid';
import type { LucidEvolution } from '@lucid-evolution/lucid';
import {
  FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS, FIXTURE_TOKEN_UNIT,
} from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  REGISTRY_POLICY_ID, MIN_AP3X_DEPOSIT, AGENT_MESSAGE_LABEL,
  getRegistryAddress, parseDid, buildAgentDatum, parseAgentDatum, resolveAgentUtxo,
  buildRegisterAgent, buildMessageAgent,
  buildUpdateAgent, buildTransferAgent, buildDeregisterAgent, registryScript,
} from '../src/vector/registry-build.ts';

// The REAL registry validator evaluates during .complete() (native UPLC, offline).
// A passing build here is ground-truth phase-2 validity, minus signatures.

const OWN_VKEY_HASH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
// A registry UTxO owned by OWN_ADDRESS, for message-resolution tests.
const AGENT_NFT_NAME = 'ab'.repeat(32); // 64 hex chars
const AGENT_UNIT = `${REGISTRY_POLICY_ID}${AGENT_NFT_NAME}`;
const AGENT_DID = `did:vector:agent:${REGISTRY_POLICY_ID}:${AGENT_NFT_NAME}`;
let REGISTRY_UTXO: any;

before(() => {
  REGISTRY_UTXO = {
    txHash: 'cd'.repeat(32), outputIndex: 0,
    address: getRegistryAddress(),
    assets: { lovelace: MIN_AP3X_DEPOSIT, [AGENT_UNIT]: 1n },
    datum: buildAgentDatum(OWN_VKEY_HASH, 'FixtureAgent', 'offline fixture agent', ['testing'], 'custom', '', 1750000000000),
  };
});

function decodeTx(cborHex: string) {
  return CML.Transaction.from_cbor_hex(cborHex);
}

// Shared by the mint-content and registry-output-asset checks below: Mint's
// as_positive_multiasset() and Value's multi_asset() both return the same
// MultiAsset type (policy ScriptHash -> AssetName -> quantity), so one
// traversal serves both call sites.
function findAssetQuantity(ma: any, policyIdHex: string, assetNameHex: string): bigint | undefined {
  const policies = ma.keys();
  for (let i = 0; i < policies.len(); i++) {
    const policy = policies.get(i);
    if (policy.to_hex() !== policyIdHex) continue;
    const assets = ma.get_assets(policy);
    if (!assets) continue;
    const names = assets.keys();
    for (let n = 0; n < names.len(); n++) {
      const name = names.get(n);
      if (name.to_hex() === assetNameHex) return assets.get(name);
    }
  }
  return undefined;
}

// Decodes a TransactionMetadatum leaf as text, joining metadataStr()'s
// chunked-list form (used for values over 64 chars) back into one string.
function metadatumText(m: any): string | undefined {
  const text = m.as_text();
  if (text !== undefined) return text;
  const list = m.as_list();
  if (list) {
    let joined = '';
    for (let i = 0; i < list.len(); i++) joined += list.get(i).as_text() ?? '';
    return joined;
  }
  return undefined;
}

describe('registry constants and helpers', () => {
  test('registry address derives to the live testnet address', () => {
    assert.equal(getRegistryAddress(), 'addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42');
  });

  test('parseDid round-trips and rejects malformed DIDs', () => {
    const d = parseDid(AGENT_DID);
    assert.equal(d.policyId, REGISTRY_POLICY_ID);
    assert.equal(d.assetName, AGENT_NFT_NAME);
    assert.equal(d.unit, AGENT_UNIT);
    assert.throws(() => parseDid('did:vector:wrong:x:y'), /Invalid agent DID/);
    assert.throws(() => parseDid(`did:vector:agent:${REGISTRY_POLICY_ID}:NOTHEX`), /hex/);
  });

  test('parseAgentDatum inverts buildAgentDatum exactly', () => {
    const datum = buildAgentDatum(OWN_VKEY_HASH, 'A name', 'desc', ['a', 'b'], 'fw', 'https://x.example', 1234);
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

  test('MIN_AP3X_DEPOSIT matches the protocol deposit floor exactly', () => {
    assert.equal(MIN_AP3X_DEPOSIT, 10_000_000n, 'protocol deposit constant drifted');
  });
});

describe('buildRegisterAgent (real validator, offline)', () => {
  let lucid: LucidEvolution;
  before(async () => {
    lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
  });

  test('builds an evaluable register tx: mint +1, deposit output, inline datum, owner signer', async () => {
    const r = await buildRegisterAgent(lucid, {
      changeAddress: OWN_ADDRESS, name: 'UnitAgent', description: 'unit test agent',
      capabilities: ['testing', 'ci'], framework: 'custom', endpoint: '',
    });
    const tx = decodeTx(r.txCbor);
    // unsigned
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'register build must be unsigned');
    // mint exactly +1 of the derived unit
    const mint = tx.body().mint()!;
    assert.ok(mint, 'no mint field');
    // DID binds to the consumed one-shot input
    assert.match(r.agentId, new RegExp(`^did:vector:agent:${REGISTRY_POLICY_ID}:[0-9a-f]{64}$`));
    assert.equal(r.nftAssetName.length, 64);
    assert.equal(
      findAssetQuantity(mint.as_positive_multiasset(), REGISTRY_POLICY_ID, r.nftAssetName), 1n,
      'minted unit must be exactly +1 of policy:nftAssetName, not just any positive mint',
    );
    // one output to the registry address carrying deposit + NFT
    const outs = tx.body().outputs();
    let registryOut: any = null;
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i);
      if (o.address().to_bech32() === getRegistryAddress()) registryOut = o;
    }
    assert.ok(registryOut, 'no output to the registry address');
    // literal is the load-bearing assertion: comparing only to the constant
    // under test is tautological (it would pass even if MIN_AP3X_DEPOSIT drifted
    // above the real on-chain floor - see the dedicated pin test above).
    assert.equal(registryOut.amount().coin(), 10_000_000n, 'registry deposit must equal the literal on-chain floor');
    assert.equal(registryOut.amount().coin(), MIN_AP3X_DEPOSIT, 'MIN_AP3X_DEPOSIT should still equal the literal floor pinned above');
    assert.ok(registryOut.datum() && registryOut.datum()!.kind() === 1, 'registry output datum must be inline');
    // registry output must actually carry the NFT, not just the deposit
    const registryAssets = registryOut.amount().multi_asset();
    assert.ok(registryAssets, 'registry output carries no native assets');
    assert.equal(
      findAssetQuantity(registryAssets, REGISTRY_POLICY_ID, r.nftAssetName), 1n,
      'registry output must hold exactly 1 of the derived NFT unit',
    );
    // required signer = owner
    const signers = tx.body().required_signers();
    assert.ok(signers && signers.len() >= 1, 'no required_signers');
    let found = false;
    for (let i = 0; i < signers!.len(); i++) {
      if (signers!.get(i).to_hex() === OWN_VKEY_HASH) found = true;
    }
    assert.ok(found, 'owner vkey hash missing from required_signers');
    assert.equal(r.depositLovelace, MIN_AP3X_DEPOSIT.toString());
  });

  test('rejects invalid endpoint and empty capability before building', async () => {
    await assert.rejects(buildRegisterAgent(lucid, {
      changeAddress: OWN_ADDRESS, name: 'X', description: '', capabilities: [], framework: 'c', endpoint: 'not a url',
    }), /Invalid endpoint URL/);
    await assert.rejects(buildRegisterAgent(lucid, {
      changeAddress: OWN_ADDRESS, name: 'X', description: '', capabilities: ['ok', ' '], framework: 'c', endpoint: '',
    }), /capability/i);
  });

  test('rejects a script-credential changeAddress with a clear error', async () => {
    await assert.rejects(buildRegisterAgent(lucid, {
      changeAddress: getRegistryAddress(), name: 'X', description: '', capabilities: [], framework: 'c', endpoint: '',
    }), /verification key|payment key/i);
  });
});

describe('buildMessageAgent (resolves via fixture registry UTxO)', () => {
  test('pays 2 AP3X to the owner-derived address with label-674 metadata', async () => {
    const provider = new FixtureProvider([...FIXTURE_UTXOS, REGISTRY_UTXO]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const r = await buildMessageAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID, messageType: 'inquiry', payload: 'unit ping',
    });
    assert.equal(r.agentName, 'FixtureAgent');
    const tx = decodeTx(r.txCbor);
    // 2 AP3X output to the recipient (owner == OWN_ADDRESS's key, enterprise-derived)
    const outs = tx.body().outputs();
    let paid = 0;
    for (let i = 0; i < outs.len(); i++) {
      if (outs.get(i).address().to_bech32() === r.recipientAddress && outs.get(i).amount().coin() === 2_000_000n) paid++;
    }
    assert.ok(paid >= 1, 'no 2 AP3X output to the recipient address');
    // metadata label present
    const aux = tx.auxiliary_data();
    assert.ok(aux && aux.metadata() && aux.metadata()!.get(BigInt(AGENT_MESSAGE_LABEL)), 'label-674 metadata missing');
    // metadata content: from/to must be the real sender/recipient, not swapped
    const metaMap = aux!.metadata()!.get(BigInt(AGENT_MESSAGE_LABEL))!.as_map()!;
    const fromVal = metadatumText(metaMap.get(CML.TransactionMetadatum.new_text('from'))!);
    const toVal = metadatumText(metaMap.get(CML.TransactionMetadatum.new_text('to'))!);
    assert.equal(fromVal, OWN_ADDRESS, 'metadata "from" must be the sending changeAddress');
    assert.equal(toVal, AGENT_DID, 'metadata "to" must be the recipient agent DID');
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'message build must be unsigned');
  });

  test('unknown agent DID fails with agent-not-found, not a network error', async () => {
    const provider = new FixtureProvider(FIXTURE_UTXOS); // no registry UTxO
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(buildMessageAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID, messageType: 'inquiry', payload: 'x',
    }), /Agent not found/);
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
    const { profile, utxo, nftUnit } = await resolveAgentUtxo(wrapped as any, AGENT_DID);
    assert.equal(nftUnit, AGENT_UNIT);
    assert.equal(utxo.datum, REGISTRY_UTXO.datum, 're-scanned UTxO must carry the real inline datum, not the datum-less stand-in');
    assert.equal(profile.name, 'FixtureAgent');
    assert.equal(profile.agentId, AGENT_DID);
  });
});

describe('registry owner ops (real validator, offline)', () => {
  function ownedProvider() {
    return new FixtureProvider([...FIXTURE_UTXOS, REGISTRY_UTXO]);
  }

  test('update merges fields, preserves registeredAt, keeps NFT + deposit at the registry', async () => {
    const provider = ownedProvider();
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const r = await buildUpdateAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID, description: 'updated by unit test',
    });
    assert.equal(r.op, 'update');
    assert.equal(r.detail, 'description');
    const tx = decodeTx(r.txCbor);
    const outs = tx.body().outputs();
    let registryOut: any = null;
    for (let i = 0; i < outs.len(); i++) {
      if (outs.get(i).address().to_bech32() === getRegistryAddress()) registryOut = outs.get(i);
    }
    assert.ok(registryOut, 'no continuing registry output');
    assert.equal(registryOut.amount().coin(), MIN_AP3X_DEPOSIT);
    assert.ok(registryOut.datum() && registryOut.datum()!.kind() === 1, 'continuing datum must be inline');
    // decode the continuing inline datum and verify the merge
    const datumCbor = registryOut.datum()!.as_datum()!.to_cbor_hex();
    const p = parseAgentDatum(datumCbor, 'x#0', { [AGENT_UNIT]: 1n })!;
    assert.equal(p.description, 'updated by unit test');
    assert.equal(p.name, 'FixtureAgent');           // preserved
    assert.equal(p.registeredAt, 1750000000000);    // preserved
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'must be unsigned');
  });

  test('update with no fields throws before any resolution', async () => {
    const provider = ownedProvider();
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(buildUpdateAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID,
    }), /At least one field/);
  });

  test('ownership fail-fast: a non-owner changeAddress is refused before building', async () => {
    const provider = ownedProvider();
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    // FOREIGN_ADDRESS is a script address in the fixture set; use a foreign KEY address instead:
    // derive one from a different fixture or construct via credentialToAddress with a random hash.
    const strangerHash = '00'.repeat(28);
    const stranger = credentialToAddress('Mainnet', { type: 'Key', hash: strangerHash });
    // build a lucid for the stranger (their own address-only wallet, holding nothing at the registry)
    const strangerProvider = new FixtureProvider([
      { txHash: 'ee'.repeat(32), outputIndex: 0, address: stranger, assets: { lovelace: 50_000_000n } },
      REGISTRY_UTXO,
    ]);
    const strangerLucid = await lucidForAddress(strangerProvider, stranger);
    await assert.rejects(buildUpdateAgent(strangerLucid, strangerProvider, {
      changeAddress: stranger, agentId: AGENT_DID, description: 'hijack attempt',
    }), /Ownership check failed/);
  });

  test('transfer swaps the datum owner to the new key and rejects script-address owners', async () => {
    const provider = ownedProvider();
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const newOwnerHash = '11'.repeat(28);
    const newOwner = credentialToAddress('Mainnet', { type: 'Key', hash: newOwnerHash });
    const r = await buildTransferAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID, newOwnerAddress: newOwner,
    });
    assert.equal(r.op, 'transfer');
    const tx = decodeTx(r.txCbor);
    const outs = tx.body().outputs();
    let registryOut: any = null;
    for (let i = 0; i < outs.len(); i++) {
      if (outs.get(i).address().to_bech32() === getRegistryAddress()) registryOut = outs.get(i);
    }
    const datumCbor = registryOut.datum()!.as_datum()!.to_cbor_hex();
    const p = parseAgentDatum(datumCbor, 'x#0', { [AGENT_UNIT]: 1n })!;
    assert.equal(p.ownerVkeyHash, newOwnerHash);
    assert.equal(p.name, 'FixtureAgent'); // everything else preserved
    // script-credential new owner refused
    await assert.rejects(buildTransferAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID, newOwnerAddress: getRegistryAddress(),
    }), /verification key/i);
  });

  test('deregister burns the NFT and leaves no registry output (deposit comes back as change)', async () => {
    const provider = ownedProvider();
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const r = await buildDeregisterAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID,
    });
    assert.equal(r.op, 'deregister');
    assert.equal(r.agentName, 'FixtureAgent');
    const tx = decodeTx(r.txCbor);
    const outs = tx.body().outputs();
    for (let i = 0; i < outs.len(); i++) {
      assert.notEqual(outs.get(i).address().to_bech32(), getRegistryAddress(),
        'deregister must not leave an output at the registry');
      // every output is change to the owner
      assert.equal(outs.get(i).address().to_bech32(), OWN_ADDRESS);
    }
    assert.ok(tx.body().mint(), 'no mint (burn) field on the deregister tx');
  });

  test('deregister picks the LARGEST pure-AP3X wallet UTxO as the extra input', async () => {
    const small = { txHash: 'a1'.repeat(32), outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 3_000_000n } };
    const large = { txHash: 'a2'.repeat(32), outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 900_000_000n } };
    // small listed FIRST so first-match selection would pick it
    const provider = new FixtureProvider([small, large, REGISTRY_UTXO]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const r = await buildDeregisterAgent(lucid, provider, { changeAddress: OWN_ADDRESS, agentId: AGENT_DID });
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
// script enforces value-preservation on Update/Transfer and a returned-
// change floor on Deregister. These tests pin that corrected understanding.
describe('registry owner ops - value preservation & deregister floor (correction, real validator)', () => {
  function overfundedRegistryUtxo(lovelace: bigint) {
    return {
      txHash: 'ce'.repeat(32), outputIndex: 0,
      address: getRegistryAddress(),
      assets: { lovelace, [AGENT_UNIT]: 1n },
      datum: buildAgentDatum(OWN_VKEY_HASH, 'FixtureAgent', 'offline fixture agent', ['testing'], 'custom', '', 1750000000000),
    };
  }

  test('update preserves the FULL input value on an over-funded registry UTxO, not just the deposit floor', async () => {
    const overfunded = overfundedRegistryUtxo(25_000_000n);
    const provider = new FixtureProvider([...FIXTURE_UTXOS, overfunded]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const r = await buildUpdateAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID, description: 'overfunded update',
    });
    assert.equal(r.op, 'update');
    const tx = decodeTx(r.txCbor);
    const outs = tx.body().outputs();
    let registryOut: any = null;
    for (let i = 0; i < outs.len(); i++) {
      if (outs.get(i).address().to_bech32() === getRegistryAddress()) registryOut = outs.get(i);
    }
    assert.ok(registryOut, 'no continuing registry output');
    assert.equal(registryOut.amount().coin(), 25_000_000n, 'continuing output must preserve the FULL input value, not the deposit floor');
  });

  test('transfer preserves the FULL input value on an over-funded registry UTxO', async () => {
    const overfunded = overfundedRegistryUtxo(25_000_000n);
    const provider = new FixtureProvider([...FIXTURE_UTXOS, overfunded]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const newOwnerHash = '22'.repeat(28);
    const newOwner = credentialToAddress('Mainnet', { type: 'Key', hash: newOwnerHash });
    const r = await buildTransferAgent(lucid, provider, {
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID, newOwnerAddress: newOwner,
    });
    assert.equal(r.op, 'transfer');
    const tx = decodeTx(r.txCbor);
    const outs = tx.body().outputs();
    let registryOut: any = null;
    for (let i = 0; i < outs.len(); i++) {
      if (outs.get(i).address().to_bech32() === getRegistryAddress()) registryOut = outs.get(i);
    }
    assert.ok(registryOut, 'no continuing registry output');
    assert.equal(registryOut.amount().coin(), 25_000_000n, 'continuing output must preserve the FULL input value on transfer too');
  });

  test('validator floor pin: deregister of an over-funded (25 AP3X) registry UTxO succeeds with no extra input pulled in', async () => {
    // Direct build (not through buildDeregisterAgent, which now
    // unconditionally requires a fee UTxO whenever the wallet has one) -
    // pins the underlying chain fact that motivates that requirement: the
    // deployed validator's returned-change floor is cleared by the registry
    // deposit alone once it's well above MIN_AP3X_DEPOSIT. Confirms this is
    // a genuine value floor on the validator side, not "any sole-input
    // deregister fails" (which was the earlier, wrong diagnosis).
    const overfunded = overfundedRegistryUtxo(25_000_000n);
    const provider = new FixtureProvider([overfunded, ...FIXTURE_UTXOS]);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    const spendRedeemer = Data.to(new Constr(1, []));
    const mintRedeemer = Data.to(new Constr(1, []));
    const completed = await lucid.newTx()
      .collectFrom([overfunded], spendRedeemer)
      .attach.SpendingValidator(registryScript())
      .mintAssets({ [AGENT_UNIT]: -1n }, mintRedeemer)
      .attach.MintingPolicy(registryScript())
      .addSigner(OWN_ADDRESS)
      .complete();
    const tx = decodeTx(completed.toCBOR());
    assert.equal(tx.body().inputs().len(), 1, 'sole input - Lucid should not need to pull in any extra wallet UTxO here');

    // Pin: buildDeregisterAgent's returned `detail` is the ACTUAL spent
    // registry UTxO lovelace (25 AP3X here), not the MIN_AP3X_DEPOSIT
    // constant. Goes through buildDeregisterAgent itself (unlike the direct
    // build above), which is safe here because the provider also carries
    // FIXTURE_UTXOS, so the extra fee UTxO that path unconditionally pulls in
    // is available.
    const r = await buildDeregisterAgent(lucid, provider, { changeAddress: OWN_ADDRESS, agentId: AGENT_DID });
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
      changeAddress: OWN_ADDRESS, agentId: AGENT_DID,
    }), /AP3X-only UTxO/);
  });
});
