import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CML, getAddressDetails, Data, Constr, toText, fromText } from '@lucid-evolution/lucid';
import type { LucidEvolution } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS } from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  REGISTRY_POLICY_ID, MIN_AP3X_DEPOSIT, AGENT_MESSAGE_LABEL,
  getRegistryAddress, parseDid, buildAgentDatum, parseAgentDatum, resolveAgentUtxo,
  buildRegisterAgent, buildMessageAgent,
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
