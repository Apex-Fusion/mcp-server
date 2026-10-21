// packages/builder/test/reputation-build.test.ts
// The Module-3 self-stake, ported from the reference Python SDK. Parity is held against two stakes the SDK built on mainnet
// (advert-stake-golden.fixture.ts): the same opening datum, stake datum, stake token, redeemers, reference inputs and validity range,
// from the same agent, owner, capabilities and tip, and the deployed reputation validator evaluating each built transaction against the
// ledger state those stakes were made in (uplc-node.fixture.ts). Each "verdict" test pairs an accepted twin with the rejected case: the
// SDK's testnet clock, a capability the registry record does not list. The tool text about the stake is pinned the same way: a decrease
// below the module's minimum is rejected, and the module's oracle key consumes all of a stake through ClaimDecayRefund once its activity
// window (about 163 s as deployed) has passed. No network is touched.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { CML, Constr, Data, fromText, getAddressDetails, validatorToScriptHash, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { lucidForAddress } from '../src/vector/build.ts';
import { ensureSlotConfig } from '../src/vector/gov-build.ts';
import { REGISTRY_POLICY_ID, getRegistryAddress } from '../src/vector/registry-build.ts';
import { decodeAdvertDatum } from '../src/vector/marketplace-datum.ts';
import {
  REPUTATION_SCRIPT_HASH, REPUTATION_ADDRESS, REPUTATION_REF_SCRIPT_UTXO, REPUTATION_PARAMS_UTXO, REPUTATION_PARAMS_HOLDER_HASH,
  REPUTATION_CROSS_REFS_UTXO, REPUTATION_REFS_TOKEN_POLICY, VECTOR_MAINNET_ZERO_TIME_MS, STAKE_OPENING_LOVELACE, STAKE_VALIDITY_MS,
  CREATE_STAKE_REDEEMER, MINT_STAKE_TOKEN_REDEEMER,
  encodeStakeDatum, decodeStakeDatum, stakeTokenName, stakeTokenUnit, decodeStakeParams, decodeCrossRefs, readRegistryRecord,
  stakedCapabilities, capabilityText, planStakeOpening, planStake, stakeClock, buildStakeOpening, buildStake, reputationAddressFromHash,
  stakeOutputZero,
} from '../src/vector/reputation-build.ts';
import type { RegistryRecord } from '../src/vector/reputation-build.ts';
import {
  STAKE_A, STAKE_B, PARAMS_UTXO, CROSS_REFS_UTXO, REPUTATION_REF_UTXO_BARE, REPUTATION_SCRIPT_CBOR, REGISTRATION_TX, ADVERT_POSTS,
} from './fixtures/advert-stake-golden.fixture.ts';
import { uplcEvaluatingProvider, UPLC_PATH } from './fixtures/uplc-node.fixture.ts';

const ZERO = VECTOR_MAINNET_ZERO_TIME_MS;
const REF_SCRIPT: UTxO = { ...REPUTATION_REF_UTXO_BARE, scriptRef: { type: 'PlutusV3', script: REPUTATION_SCRIPT_CBOR } };
const MODULE: UTxO[] = [REF_SCRIPT, PARAMS_UTXO, CROSS_REFS_UTXO];
const CASES = [STAKE_A, STAKE_B];
type Case = typeof STAKE_A;
const lowerBound = (c: Case) => ZERO + Number(c.tx.invalidBefore) * 1000;
const ownerOf = (c: Case) => getAddressDetails(c.ownerAddress).paymentCredential!.hash;
const recordOf = (c: Case): RegistryRecord => {
  const f = (Data.from(c.registry.datum!) as Constr<Data>).fields;
  return { utxo: c.registry, agentDidHex: c.agentDidHex, ownerPkh: ((f[0] as Constr<Data>).fields[0]) as string, capabilityHex: f[3] as string[], name: '' };
};
/** The ledger as it stood for a golden stake: the owner's wallet output, the opening output, the registry record and the module's outputs. */
const nodeFor = (c: Case, extra: UTxO[] = [], tipSlot = Number(c.tx.invalidBefore)) => uplcEvaluatingProvider([c.wallet, c.opening, c.registry, ...MODULE, ...extra], tipSlot);
const txOf = (cbor: string) => CML.Transaction.from_cbor_hex(cbor);
const refInputs = (cbor: string): string[] => {
  const r = txOf(cbor).body().reference_inputs();
  const out: string[] = [];
  for (let i = 0; r && i < r.len(); i++) out.push(`${r.get(i).transaction_id().to_hex()}#${r.get(i).index()}`);
  return out.sort();
};
const inputRefs = (cbor: string): string[] => {
  const r = txOf(cbor).body().inputs();
  const out: string[] = [];
  for (let i = 0; i < r.len(); i++) out.push(`${r.get(i).transaction_id().to_hex()}#${r.get(i).index()}`);
  return out.sort();
};
const signers = (cbor: string): string[] => {
  const s = txOf(cbor).body().required_signers();
  const out: string[] = [];
  for (let i = 0; s && i < s.len(); i++) out.push(s.get(i).to_hex());
  return out;
};
const minted = (cbor: string): Record<string, string> => {
  const m = txOf(cbor).body().mint();
  const out: Record<string, string> = {};
  if (!m) return out;
  const policies = m.keys();
  for (let i = 0; i < policies.len(); i++) {
    const p = policies.get(i);
    const assets = m.get_assets(p)!;
    const names = assets.keys();
    for (let j = 0; j < names.len(); j++) out[p.to_hex() + Buffer.from(names.get(j).to_raw_bytes()).toString('hex')] = assets.get(names.get(j))!.toString();
  }
  return out;
};

describe('the evaluator the tests use is the one lucid pins', () => {
  test('@lucid-evolution/uplc is loaded from where lucid resolves it, at the version lucid pins, not the copy nested under the wallet package', () => {
    const lucidDir = join(dirname(createRequire(import.meta.url).resolve('@lucid-evolution/lucid')), '..');
    const pinned = JSON.parse(readFileSync(join(lucidDir, 'package.json'), 'utf-8')).dependencies['@lucid-evolution/uplc'];
    const loaded = JSON.parse(readFileSync(join(dirname(UPLC_PATH), '..', '..', 'package.json'), 'utf-8'));
    assert.equal(loaded.name, '@lucid-evolution/uplc');
    assert.equal(loaded.version, pinned);
    assert.ok(!UPLC_PATH.includes(`${sep}wallet${sep}`), UPLC_PATH);
  });
});

describe('the deployment the builders name is the one on the ledger', () => {
  test('script hash, address, reference script, parameters holder and cross references', () => {
    assert.equal(validatorToScriptHash(REF_SCRIPT.scriptRef!), REPUTATION_SCRIPT_HASH);
    assert.equal(reputationAddressFromHash(), REPUTATION_ADDRESS);
    for (const c of CASES) assert.equal(c.tx.outputs[0].address, REPUTATION_ADDRESS);
    assert.deepEqual({ txHash: REF_SCRIPT.txHash, outputIndex: REF_SCRIPT.outputIndex }, REPUTATION_REF_SCRIPT_UTXO);
    assert.deepEqual({ txHash: PARAMS_UTXO.txHash, outputIndex: PARAMS_UTXO.outputIndex }, REPUTATION_PARAMS_UTXO);
    assert.equal(getAddressDetails(PARAMS_UTXO.address).paymentCredential!.hash, REPUTATION_PARAMS_HOLDER_HASH);
    assert.deepEqual({ txHash: CROSS_REFS_UTXO.txHash, outputIndex: CROSS_REFS_UTXO.outputIndex }, REPUTATION_CROSS_REFS_UTXO);
    assert.ok(Object.keys(CROSS_REFS_UTXO.assets).some((u) => u.startsWith(REPUTATION_REFS_TOKEN_POLICY)));
    assert.equal(decodeCrossRefs(CROSS_REFS_UTXO.datum!).reputation, REPUTATION_SCRIPT_HASH);
    for (const c of CASES) assert.deepEqual(c.tx.referenceInputs, [REPUTATION_CROSS_REFS_UTXO, REPUTATION_REF_SCRIPT_UTXO, REPUTATION_PARAMS_UTXO, c.registry].map((r) => `${r.txHash}#${r.outputIndex}`).sort());
  });
  test('the module\'s parameters: a self-stake of at least 10 units', () => {
    const p = decodeStakeParams(PARAMS_UTXO.datum!);
    assert.equal(p.minSelfStake, 10_000_000n);
    assert.equal(p.stakeCooldown, 21_600n);
    assert.throws(() => decodeStakeParams(Data.to(new Constr(0, [0n, 1n, 2n, 3n]))), /not a positive integer/);
    assert.throws(() => decodeStakeParams(Data.to(new Constr(1, []))), /not the module parameters datum/);
  });
});

describe('the stake datum and token, byte for byte against the SDK\'s', () => {
  test('encodeStakeDatum writes the live stakes and opening outputs back exactly, and from their values', () => {
    for (const c of CASES) {
      for (const hex of [c.stakeDatumHex, c.opening.datum!]) {
        const d = decodeStakeDatum(hex);
        assert.equal(encodeStakeDatum(d), hex);
        assert.equal(encodeStakeDatum({ agent_did: c.agentDidHex, owner_pkh: ownerOf(c), stake_amount: d.stake_amount, staked_capabilities: c.capabilities.map(fromText), last_updated: d.last_updated, history_points: 0n }), hex);
      }
    }
  });
  test('the stake token name is "rstk_" + blake2b-256(agent DID) cut to 27 bytes, the name the SDK minted', () => {
    for (const c of CASES) {
      assert.deepEqual(c.tx.minted, { [stakeTokenUnit(c.agentDidHex)]: '1' });
      assert.equal(stakeTokenName(c.agentDidHex).length, 64, '32 bytes, the longest asset name');
    }
    const digest = Buffer.from(blake2b(Buffer.from(STAKE_A.agentDidHex, 'hex'), { dkLen: 32 })).toString('hex');
    assert.equal(stakeTokenName(STAKE_A.agentDidHex), '7273746b5f' + digest.slice(0, 54));
  });
  test('the redeemers are the ones the SDK used: CreateStake and MintStakeToken, both constructor 0 without fields', () => {
    assert.equal(CREATE_STAKE_REDEEMER, 'd87980');
    assert.equal(MINT_STAKE_TOKEN_REDEEMER, 'd87980');
    for (const c of CASES) assert.deepEqual(c.tx.redeemers.map((r) => [r.purpose, r.scriptHash, r.data]), [['mint', REPUTATION_SCRIPT_HASH, { fields: [], constructor: 0 }], ['spend', REPUTATION_SCRIPT_HASH, { fields: [], constructor: 0 }]]);
  });
  test('decodeStakeDatum refuses what is not a stake datum', () => {
    assert.throws(() => decodeStakeDatum(Data.to(new Constr(0, ['aa']))), /not a stake datum/);
    assert.throws(() => decodeStakeDatum(Data.to(new Constr(1, ['aa', new Constr(0, ['bb']), 1n, [], 1n, 0n]))), /not a stake datum/);
    assert.throws(() => decodeStakeDatum(Data.to(new Constr(0, [1n, new Constr(0, ['bb']), 1n, [], 1n, 0n]))), /agent_did is not bytes/);
    assert.throws(() => decodeStakeDatum(Data.to(new Constr(0, ['aa', new Constr(1, ['bb']), 1n, [], 1n, 0n]))), /not a verification-key credential/);
    assert.throws(() => decodeStakeDatum(Data.to(new Constr(0, ['aa', new Constr(0, ['bb']), 'cc', [], 1n, 0n]))), /an integer field is not an integer/);
    assert.throws(() => decodeStakeDatum(Data.to(new Constr(0, ['aa', new Constr(0, ['bb']), 1n, [1n], 1n, 0n]))), /staked_capabilities is not a list of bytes/);
  });
  test('stakeTokenName, decodeCrossRefs and decodeStakeParams refuse what they cannot read', () => {
    assert.throws(() => stakeTokenName('zz'), /agent_did must be hex bytes/);
    assert.throws(() => stakeTokenName(''), /agent_did must be hex bytes/);
    assert.throws(() => decodeCrossRefs(Data.to(new Constr(0, ['aa']))), /not the cross-validator references datum/);
    assert.throws(() => decodeStakeParams(Data.to(new Constr(0, ['aa', 1n, 2n, 3n]))), /not a positive integer/);
  });
});

describe('one key across identity, advert and stake', () => {
  test('Advocate: the registry record\'s owner (registered by vector_build_register_agent), the stake\'s owner and the advert\'s supplier are one key hash', () => {
    assert.equal(STAKE_A.registry.txHash, REGISTRATION_TX);
    const owner = recordOf(STAKE_A).ownerPkh;
    assert.equal(decodeStakeDatum(STAKE_A.stakeDatumHex).owner_pkh, owner);
    assert.equal(decodeAdvertDatum(ADVERT_POSTS[4].datumHex).supplier_pkh, owner);
    assert.equal(ownerOf(STAKE_A), owner);
  });
});

describe('readRegistryRecord and stakedCapabilities', () => {
  test('reads the record at the registry address: owner and capabilities as bytes', async () => {
    for (const c of CASES) {
      const record = await readRegistryRecord(nodeFor(c), c.agentId);
      assert.equal(record.utxo.txHash, c.registry.txHash);
      assert.equal(record.ownerPkh, ownerOf(c));
      assert.deepEqual(record.capabilityHex.map(capabilityText), c.capabilities);
      assert.equal(c.registry.address, getRegistryAddress());
    }
  });
  test('refuses a DID of another policy, and one with no record', async () => {
    await assert.rejects(readRegistryRecord(nodeFor(STAKE_A), STAKE_A.agentId.replace(REGISTRY_POLICY_ID, 'ab'.repeat(28))), /is not a DID of the agent registry/);
    await assert.rejects(readRegistryRecord(nodeFor(STAKE_A), STAKE_B.agentId), /Agent not found/);
    await assert.rejects(readRegistryRecord(nodeFor(STAKE_A), STAKE_A.agentId.slice(0, -2)), /asset name must be 64 hex characters/);
  });
  test('refuses a registry token that is not at the registry address, and a record whose owner is not a verification key', async () => {
    // Koios (getUtxoByUnit) may find the token anywhere; the record counts only at the registry address.
    const moved = Object.assign(nodeFor(STAKE_A), { getUtxoByUnit: async () => ({ ...STAKE_A.registry, address: STAKE_A.ownerAddress }) });
    await assert.rejects(readRegistryRecord(moved, STAKE_A.agentId), /is not at the registry address/);
    const f = (Data.from(STAKE_A.registry.datum!) as Constr<Data>).fields;
    const scriptOwned = { ...STAKE_A.registry, datum: Data.to(new Constr(0, [new Constr(1, [ownerOf(STAKE_A)]), ...f.slice(1)])) };
    const node = uplcEvaluatingProvider([STAKE_A.wallet, scriptOwned, ...MODULE], Number(STAKE_A.tx.invalidBefore));
    await assert.rejects(readRegistryRecord(node, STAKE_A.agentId), /has no verification-key owner or no capability list/);
  });
  test('the staked capabilities are a subset of the record\'s, byte for byte, without repeats', () => {
    const record = recordOf(STAKE_A);
    assert.deepEqual(stakedCapabilities(STAKE_A.capabilities, record, STAKE_A.agentId), STAKE_A.capabilities.map(fromText));
    assert.throws(() => stakedCapabilities(['data_analysis'], record, STAKE_A.agentId), /Capability data_analysis is not in the registry record of .*, which lists: research\.advocate\.onesided\.v1\. The validator accepts only capabilities the record lists/);
    assert.throws(() => stakedCapabilities(['Research.advocate.onesided.v1'], record, STAKE_A.agentId), /is not in the registry record/);
    assert.throws(() => stakedCapabilities([...STAKE_A.capabilities, ...STAKE_A.capabilities], record, STAKE_A.agentId), /is named twice/);
    assert.throws(() => stakedCapabilities([], record, STAKE_A.agentId), /at least one capability/);
    assert.throws(() => stakedCapabilities([''], record, STAKE_A.agentId), /non-empty text/);
  });
});

describe('planStakeOpening and planStake reproduce the SDK\'s datums', () => {
  test('the opening datum: the agent, its owner, the capabilities, 2 units, the tip\'s time', () => {
    for (const c of CASES) {
      const live = decodeStakeDatum(c.opening.datum!);
      const plan = planStakeOpening(recordOf(c), ownerOf(c), c.capabilities.map(fromText), live.last_updated, c.agentId);
      assert.equal(plan.datumHex, c.opening.datum);
      assert.equal(plan.lovelace, STAKE_OPENING_LOVELACE);
      assert.equal(c.opening.assets.lovelace, STAKE_OPENING_LOVELACE);
    }
  });
  test('the stake datum: last_updated is the lower bound, the stake the module\'s minimum, valid for 600 slots', () => {
    for (const c of CASES) {
      const plan = planStake(recordOf(c), ownerOf(c), c.capabilities.map(fromText), decodeStakeParams(PARAMS_UTXO.datum!), decodeStakeDatum(c.opening.datum!), lowerBound(c), c.agentId);
      assert.equal(plan.datumHex, c.stakeDatumHex);
      assert.equal(plan.stakeLovelace, BigInt(c.tx.outputs[0].lovelace));
      assert.equal(plan.tokenUnit, Object.keys(c.tx.minted)[0]);
      assert.equal((plan.validTo - ZERO) / 1000, Number(c.tx.invalidAfter));
      assert.equal(plan.validTo - plan.validFrom, STAKE_VALIDITY_MS);
    }
  });
  test('refuses another owner, an opening output of another agent, and a lower bound that is not a slot start', () => {
    const params = decodeStakeParams(PARAMS_UTXO.datum!);
    const caps = STAKE_A.capabilities.map(fromText);
    assert.throws(() => planStakeOpening(recordOf(STAKE_A), 'ab'.repeat(28), caps, lowerBound(STAKE_A), STAKE_A.agentId), /is not the owner of .* \(owner key 20d8/);
    assert.throws(() => planStake(recordOf(STAKE_A), 'ab'.repeat(28), caps, params, decodeStakeDatum(STAKE_A.opening.datum!), lowerBound(STAKE_A), STAKE_A.agentId), /is not the owner/);
    assert.throws(() => planStake(recordOf(STAKE_A), ownerOf(STAKE_A), caps, params, decodeStakeDatum(STAKE_B.opening.datum!), lowerBound(STAKE_A), STAKE_A.agentId), /The opening output names another agent/);
    assert.throws(() => planStake(recordOf(STAKE_A), ownerOf(STAKE_A), caps, params, decodeStakeDatum(STAKE_A.opening.datum!), lowerBound(STAKE_A) + 1, STAKE_A.agentId), /whole second/);
  });
});

describe('stakeClock', () => {
  test('the tip\'s slot as the ledger turns it into POSIX ms, within 120 s of this server\'s clock', async () => {
    const node = nodeFor(STAKE_A);
    assert.equal(await stakeClock(node, lowerBound(STAKE_A) + 119_000), lowerBound(STAKE_A));
    await assert.rejects(stakeClock(node, lowerBound(STAKE_A) + 121_000), /more than 120 s from this server's clock/);
    // The SDK's unpatched testnet genesis puts the stamp about 51 days off the ledger's: the same refusal, by a wide margin.
    await assert.rejects(stakeClock(node, lowerBound(STAKE_A) - (1_756_485_600 - 1_752_057_484) * 1000), /more than 120 s/);
  });
});

describe('buildStake (step 2): the deployed validator accepts what the SDK built, built here', () => {
  for (const c of CASES) {
    test(`${c.capabilities[0]}: datum, value, token, reference inputs, redeemers, signer and validity range as the SDK's stake ${c.tx.txHash.slice(0, 8)}`, async () => {
      const node = nodeFor(c);
      const lucid = await lucidForAddress(node, c.ownerAddress);
      const r = await buildStake(lucid, node, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, openingRef: `${c.opening.txHash}#0`, nowMs: lowerBound(c) + 5_000 });
      assert.equal(node.evaluations.length, 1, 'the deployed validator evaluated the transaction (both redeemers) and accepted it');
      const body = txOf(r.txCbor).body();
      const out0 = body.outputs().get(0);
      assert.equal(out0.address().to_bech32(), c.tx.outputs[0].address);
      assert.equal(out0.datum()?.as_datum()?.to_cbor_hex(), c.stakeDatumHex);
      assert.equal(out0.amount().coin().toString(), c.tx.outputs[0].lovelace);
      assert.deepEqual(minted(r.txCbor), c.tx.minted);
      assert.deepEqual(refInputs(r.txCbor), c.tx.referenceInputs);
      assert.ok(inputRefs(r.txCbor).includes(`${c.opening.txHash}#0`), 'the opening output is consumed');
      assert.deepEqual(inputRefs(r.txCbor), c.tx.inputs, 'the same inputs: the opening output and the owner\'s wallet output');
      assert.equal(body.validity_interval_start()?.toString(), c.tx.invalidBefore);
      assert.equal(body.ttl()?.toString(), c.tx.invalidAfter);
      assert.deepEqual(signers(r.txCbor), [ownerOf(c)]);
      const v = txOf(r.txCbor).witness_set().vkeywitnesses();
      assert.ok(v === undefined || v.len() === 0, 'unsigned');
      assert.equal(r.stakeRef, `${r.txHash}#0`);
      assert.equal(r.stakeLovelace, 10_000_000n);
      assert.equal(r.lastUpdated, lowerBound(c));
    });
  }
  /** A CreateStake built by hand, past every check of the builder, with the datum the caller gives: what the deployed validator alone says of it. */
  const handBuiltStake = async (c: Case, datum: (plan: ReturnType<typeof planStake>) => string, capsHex = c.capabilities.map(fromText)) => {
    const node = nodeFor(c);
    await ensureSlotConfig(node);
    const lucid = await lucidForAddress(node, c.ownerAddress);
    const plan = planStake(recordOf(c), ownerOf(c), capsHex, decodeStakeParams(PARAMS_UTXO.datum!), decodeStakeDatum(c.opening.datum!), lowerBound(c), c.agentId);
    return lucid.newTx().readFrom([...MODULE, c.registry]).collectFrom([c.opening], plan.spendRedeemerHex).mintAssets({ [plan.tokenUnit]: 1n }, plan.mintRedeemerHex)
      .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: datum(plan) }, { lovelace: plan.stakeLovelace, [plan.tokenUnit]: 1n })
      .addSignerKey(ownerOf(c)).validFrom(plan.validFrom).validTo(plan.validTo).complete({ localUPLCEval: false });
  };
  test('the evaluator is a verdict: the stake stamped with the tip is accepted, the same stamped with the SDK\'s unpatched testnet clock rejected', async () => {
    await assert.doesNotReject(handBuiltStake(STAKE_A, (plan) => plan.datumHex), 'the twin: last_updated = the lower bound, accepted');
    const testnetStamp = (plan: ReturnType<typeof planStake>) => encodeStakeDatum({ ...plan.datum, last_updated: plan.datum.last_updated - (1_756_485_600 - 1_752_057_484) * 1000 });
    await assert.rejects(handBuiltStake(STAKE_A, testnetStamp), /failed script execution/);
  });
  test('the evaluator is a verdict: a listed capability is accepted, one the registry record does not list rejected', async () => {
    await assert.doesNotReject(handBuiltStake(STAKE_A, (plan) => plan.datumHex, [fromText(STAKE_A.capabilities[0])]), 'the twin: the record\'s capability, accepted');
    await assert.rejects(handBuiltStake(STAKE_A, (plan) => plan.datumHex, [fromText('data_analysis')]), /failed script execution/);
  });
  test('what the tool text says about withdrawal: the deployed validator refuses to decrease a stake below the minimum, and allows it above', async () => {
    const c = STAKE_A;
    const live = decodeStakeDatum(c.stakeDatumHex);
    const unit = stakeTokenUnit(c.agentDidHex);
    const decrease = async (stake: bigint, by: bigint) => {
      const at = live.last_updated + 86_400_000; // a day later, past any cooldown
      const stakeUtxo: UTxO = { txHash: 'ee'.repeat(32), outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: stake, [unit]: 1n }, datum: encodeStakeDatum({ ...live, stake_amount: stake }) };
      const node = uplcEvaluatingProvider([c.wallet, stakeUtxo, c.registry, ...MODULE], (at - ZERO) / 1000);
      await ensureSlotConfig(node);
      const lucid = await lucidForAddress(node, c.ownerAddress);
      return lucid.newTx().readFrom([...MODULE, c.registry]).collectFrom([stakeUtxo], Data.to(new Constr(2, [by])))
        .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: encodeStakeDatum({ ...live, stake_amount: stake - by, last_updated: at }) }, { lovelace: 10_000_000n, [unit]: 1n })
        .pay.ToAddress(c.ownerAddress, { lovelace: by })
        .addSignerKey(live.owner_pkh).validFrom(at).validTo(at + 600_000).complete({ localUPLCEval: false });
    };
    await assert.rejects(decrease(10_000_000n, 1_000_000n), /failed script execution/, 'a stake at the minimum (10 units) cannot be decreased');
    await assert.doesNotReject(decrease(11_000_000n, 1_000_000n), 'down to the minimum it can');
  });
  test('what the tool text says about decay: the module\'s oracle key consumes all of a stake at the minimum through ClaimDecayRefund about 163 s after its last update', async () => {
    // The module's configuration as deployed: the oracle key (deploy_state wallet_vkey_hash, the key the refs token policy is locked to)
    // and the treasury script (the SDK's TREASURY_SCRIPT_HASH). A decay that drops the stake below the minimum burns the token and must
    // send the treasury its share; nothing sends the rest to the owner. The parameters' epoch_length (900) and activity_window (180) are
    // compared with POSIX milliseconds: decay opens once (now - last_updated) / 900 > 180, at 162.9 s.
    const ORACLE = '151cadb75179beb35c094c4d05aed5cf9ac1ef5295e5161ac4141de4';
    const oracleAddress = credentialToAddress('Mainnet', { type: 'Key', hash: ORACLE });
    const treasury = credentialToAddress('Mainnet', { type: 'Script', hash: 'ab1aad52c4774e5da9f2c0fa1a4d07220a0bdd57ee3dce9be860dac6' });
    const c = STAKE_A;
    const live = decodeStakeDatum(c.stakeDatumHex);
    const unit = stakeTokenUnit(c.agentDidHex);
    const stake: UTxO = { txHash: c.tx.txHash, outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 10_000_000n, [unit]: 1n }, datum: c.stakeDatumHex };
    const oracleWallet: UTxO = { txHash: 'f1'.repeat(32), outputIndex: 0, address: oracleAddress, assets: { lovelace: 20_000_000n } };
    const decay = async (afterMs: number, treasuryLovelace: bigint) => {
      const at = live.last_updated + afterMs;
      const node = uplcEvaluatingProvider([oracleWallet, stake, ...MODULE], (at - ZERO) / 1000);
      await ensureSlotConfig(node);
      const lucid = await lucidForAddress(node, oracleAddress);
      return lucid.newTx().readFrom(MODULE).collectFrom([stake], Data.to(new Constr(4, []))) // StakeAction.ClaimDecayRefund
        .mintAssets({ [unit]: -1n }, Data.to(new Constr(1, []))) // StakeMintAction.BurnStakeToken
        .pay.ToAddress(treasury, { lovelace: treasuryLovelace })
        .addSignerKey(ORACLE).validFrom(at).validTo(at + 600_000).complete({ localUPLCEval: false });
    };
    // At + 200 s: 222 epochs, 42 past the window; decay 10 x 1% x 42 = 4.2 units, 5% of it (0.21) to the collector, 3.99 to the treasury.
    await assert.rejects(decay(150_000, 3_990_000n), /failed script execution/, 'rejected at last_updated + 150 s');
    await assert.rejects(decay(162_000, 3_990_000n), /failed script execution/, 'still rejected at + 162 s');
    await assert.doesNotReject(decay(163_000, 3_990_000n), 'accepted at + 163 s');
    const accepted = await decay(200_000, 3_990_000n);
    await assert.rejects(decay(200_000, 3_989_999n), /failed script execution/, 'the treasury\'s share is the rule: one lovelace short is rejected');
    const outs = txOf(accepted.toCBOR()).body().outputs();
    const paid: Array<[string, bigint]> = [];
    for (let i = 0; i < outs.len(); i++) paid.push([outs.get(i).address().to_bech32(), BigInt(outs.get(i).amount().coin().toString())]);
    assert.deepEqual(paid[0], [treasury, 3_990_000n], 'the treasury output');
    assert.ok(paid.slice(1).every(([address]) => address === oracleAddress), 'every other output is the oracle\'s: the collector fee and the rest of the stake');
    const fee = BigInt(txOf(accepted.toCBOR()).body().fee().toString());
    const inputs = inputRefs(accepted.toCBOR()).reduce((sum, ref) => sum + (ref === `${stake.txHash}#0` ? 10_000_000n : ref === `${oracleWallet.txHash}#0` ? 20_000_000n : 0n), 0n);
    const toOracle = paid.slice(1).reduce((sum, [, l]) => sum + l, 0n);
    assert.equal(toOracle, inputs - 3_990_000n - fee, 'the oracle takes everything the treasury does not');
    assert.ok(toOracle >= 10_000_000n - 3_990_000n - fee, 'including the rest of the stake (6.01 units, the 0.21 collector fee among them), less the fee');
    assert.ok(!paid.some(([address]) => address === c.ownerAddress), 'nothing goes to the owner');
    assert.deepEqual(minted(accepted.toCBOR()), { [unit]: '-1' }, 'the stake token is burned');
  });
});

describe('buildStake refusals, before anything is built', () => {
  const run = (c: Case, over: { node?: ReturnType<typeof nodeFor>; changeAddress?: string; capabilities?: string[]; openingRef?: string; nowMs?: number } = {}) => (async () => {
    const node = over.node ?? nodeFor(c);
    const changeAddress = over.changeAddress ?? c.ownerAddress;
    return buildStake(await lucidForAddress(node, changeAddress), node, {
      changeAddress, agentId: c.agentId, capabilities: over.capabilities ?? c.capabilities, openingRef: over.openingRef ?? `${c.opening.txHash}#0`, nowMs: over.nowMs ?? lowerBound(c) + 5_000,
    });
  })();
  test('a wallet that is not the record\'s owner, and a capability the record does not list', async () => {
    const stranger = credentialToAddress('Mainnet', { type: 'Key', hash: 'ab'.repeat(28) });
    const node = nodeFor(STAKE_A, [{ txHash: 'ab'.repeat(32), outputIndex: 0, address: stranger, assets: { lovelace: 40_000_000n } }]);
    await assert.rejects(run(STAKE_A, { node, changeAddress: stranger }), /is not the owner of/);
    await assert.rejects(run(STAKE_A, { capabilities: ['data_analysis'] }), /is not in the registry record/);
  });
  test('an agent that already has a stake', async () => {
    const existing: UTxO = { txHash: STAKE_A.tx.txHash, outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 10_000_000n, [stakeTokenUnit(STAKE_A.agentDidHex)]: 1n }, datum: STAKE_A.stakeDatumHex };
    await assert.rejects(run(STAKE_A, { node: nodeFor(STAKE_A, [existing]) }), new RegExp(`already has a stake, at ${STAKE_A.tx.txHash}#0\\. These tools build one stake per agent; nothing was built\\.`));
  });
  test('an opening output with no datum, or with a datum that is not a stake datum', async () => {
    const bare: UTxO = { ...STAKE_A.opening, txHash: 'c1'.repeat(32), datum: undefined };
    await assert.rejects(run(STAKE_A, { node: nodeFor(STAKE_A, [bare]), openingRef: `${'c1'.repeat(32)}#0` }), /has no inline datum, so it is not an opening output/);
    const odd: UTxO = { ...STAKE_A.opening, txHash: 'c2'.repeat(32), datum: Data.to(new Constr(0, [STAKE_A.agentDidHex])) };
    await assert.rejects(run(STAKE_A, { node: nodeFor(STAKE_A, [odd]), openingRef: `${'c2'.repeat(32)}#0` }), /is not an opening output \(not a stake datum/);
  });
  test('a wallet that is not the one bound to changeAddress', async () => {
    const node = nodeFor(STAKE_A, [{ ...STAKE_B.wallet }]);
    await assert.rejects(buildStake(await lucidForAddress(node, STAKE_B.ownerAddress), node, {
      changeAddress: STAKE_A.ownerAddress, agentId: STAKE_A.agentId, capabilities: STAKE_A.capabilities, openingRef: `${STAKE_A.opening.txHash}#0`, nowMs: lowerBound(STAKE_A) + 5_000,
    }), /changeAddress is not the address this wallet is bound to/);
    assert.equal(node.evaluations.length, 0);
  });
  test('a node that cannot give its tip: a refusal that names the failure, not the endpoint', async () => {
    const node = Object.assign(nodeFor(STAKE_A), { getNetworkTip: async () => { throw new Error('connect ECONNREFUSED https://ogmios.internal.example'); } });
    await assert.rejects(run(STAKE_A, { node }), (err: Error) => /Could not read the chain tip from the node: node request failed/.test(err.message) && !err.message.includes('ogmios.internal.example'));
  });
  test('an opening output that has not confirmed, is elsewhere, holds tokens, or names another agent', async () => {
    await assert.rejects(run(STAKE_A, { openingRef: `${'cd'.repeat(32)}#0` }), /has not confirmed yet \(run vector_await_transaction first\)/);
    const elsewhere: UTxO = { ...STAKE_A.opening, txHash: 'cd'.repeat(32), address: STAKE_A.ownerAddress };
    await assert.rejects(run(STAKE_A, { node: nodeFor(STAKE_A, [elsewhere]), openingRef: `${'cd'.repeat(32)}#0` }), /is not at the reputation address/);
    const withToken: UTxO = { ...STAKE_A.opening, txHash: 'ce'.repeat(32), assets: { lovelace: 2_000_000n, [`${REPUTATION_SCRIPT_HASH}aa`]: 1n } };
    await assert.rejects(run(STAKE_A, { node: nodeFor(STAKE_A, [withToken]), openingRef: `${'ce'.repeat(32)}#0` }), /holds tokens, so it is a stake or a bonus/);
    await assert.rejects(run(STAKE_A, { node: nodeFor(STAKE_A, [STAKE_B.opening]), openingRef: `${STAKE_B.opening.txHash}#0` }), /The opening output names another agent/);
  });
  test('module outputs that are not the deployment\'s', async () => {
    const without = (drop: UTxO, add: UTxO[] = []) => uplcEvaluatingProvider([STAKE_A.wallet, STAKE_A.opening, STAKE_A.registry, ...MODULE.filter((u) => u !== drop), ...add], Number(STAKE_A.tx.invalidBefore));
    await assert.rejects(run(STAKE_A, { node: without(REF_SCRIPT) }), /reference script dfa32f9c.*#0 is not on the ledger/);
    await assert.rejects(run(STAKE_A, { node: without(REF_SCRIPT, [REPUTATION_REF_UTXO_BARE]) }), /does not carry the reputation validator/);
    await assert.rejects(run(STAKE_A, { node: without(PARAMS_UTXO, [{ ...PARAMS_UTXO, address: STAKE_A.ownerAddress }]) }), /is not the module's parameters/);
    await assert.rejects(run(STAKE_A, { node: without(CROSS_REFS_UTXO, [{ ...CROSS_REFS_UTXO, assets: { lovelace: 3_000_000n } }]) }), /is not the module's cross-validator references/);
    await assert.rejects(run(STAKE_A, { node: without(CROSS_REFS_UTXO, [{ ...CROSS_REFS_UTXO, datum: Data.to(new Constr(0, ['ab'.repeat(28), 'cd'.repeat(28)])) }]) }), /is not the module's cross-validator references/, 'references naming another validator');
    await assert.rejects(run(STAKE_A, { node: without(PARAMS_UTXO, [{ ...PARAMS_UTXO, datum: Data.to(new Constr(0, [])) }]) }), /The module's parameters at 705d6b57.*#0 could not be read \(not the module parameters datum\)/);
  });
  test('the owner is checked before the node is asked about stakes or the clock', async () => {
    const stranger = credentialToAddress('Mainnet', { type: 'Key', hash: 'ab'.repeat(28) });
    const existing: UTxO = { txHash: STAKE_A.tx.txHash, outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 10_000_000n, [stakeTokenUnit(STAKE_A.agentDidHex)]: 1n }, datum: STAKE_A.stakeDatumHex };
    const node = nodeFor(STAKE_A, [existing, { txHash: 'ab'.repeat(32), outputIndex: 0, address: stranger, assets: { lovelace: 40_000_000n } }]);
    await assert.rejects(run(STAKE_A, { node, changeAddress: stranger }), /is not the owner of/, 'step 2');
    await assert.rejects(buildStakeOpening(await lucidForAddress(node, stranger), node, { changeAddress: stranger, agentId: STAKE_A.agentId, capabilities: STAKE_A.capabilities, nowMs: lowerBound(STAKE_A) }),
      /is not the owner of/, 'step 1');
  });
  test('a node whose tip is not near this server\'s clock, and a wallet with no collateral', async () => {
    await assert.rejects(run(STAKE_A, { nowMs: lowerBound(STAKE_A) + 600_000 }), /more than 120 s from this server's clock/);
    const poor = uplcEvaluatingProvider([{ ...STAKE_A.wallet, assets: { lovelace: 4_000_000n } }, STAKE_A.opening, STAKE_A.registry, ...MODULE], Number(STAKE_A.tx.invalidBefore));
    await assert.rejects(run(STAKE_A, { node: poor }), /Collateral required/);
  });
});

describe('buildStakeOpening (step 1)', () => {
  test('locks the opening output at output 0 with the SDK\'s datum, stamped with the tip, and keeps a 5-unit output for step 2', async () => {
    const c = STAKE_A;
    const live = decodeStakeDatum(c.opening.datum!);
    const tipSlot = (live.last_updated - ZERO) / 1000;
    const wallet: UTxO[] = [{ ...c.wallet, txHash: 'ab'.repeat(32) }, { ...c.wallet, txHash: 'ab'.repeat(32), outputIndex: 2, assets: { lovelace: 5_000_000n } }];
    const node = uplcEvaluatingProvider([...wallet, c.registry, ...MODULE], tipSlot);
    const r = await buildStakeOpening(await lucidForAddress(node, c.ownerAddress), node, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, nowMs: live.last_updated + 2_000 });
    const out0 = txOf(r.txCbor).body().outputs().get(0);
    assert.equal(out0.address().to_bech32(), REPUTATION_ADDRESS);
    assert.equal(out0.datum()?.as_datum()?.to_cbor_hex(), c.opening.datum, 'the same bytes as the SDK\'s opening output');
    assert.equal(out0.amount().coin().toString(), String(STAKE_OPENING_LOVELACE));
    assert.equal(r.openingRef, `${r.txHash}#0`);
    assert.equal(r.collateralKept, true);
    assert.equal(node.evaluations.length, 0, 'no script runs in step 1');
  });
  test('checks what step 2 will check before it locks anything', async () => {
    const c = STAKE_A;
    const node = (extra: UTxO[] = []) => uplcEvaluatingProvider([c.wallet, c.registry, ...MODULE, ...extra], Number(c.tx.invalidBefore));
    const open = async (n: ReturnType<typeof node>, over: { capabilities?: string[]; nowMs?: number } = {}) =>
      buildStakeOpening(await lucidForAddress(n, c.ownerAddress), n, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: over.capabilities ?? c.capabilities, nowMs: over.nowMs ?? lowerBound(c) });
    await assert.rejects(open(node(), { capabilities: ['data_analysis'] }), /is not in the registry record/);
    const existing: UTxO = { txHash: c.tx.txHash, outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 10_000_000n, [stakeTokenUnit(c.agentDidHex)]: 1n }, datum: c.stakeDatumHex };
    await assert.rejects(open(node([existing])), /already has a stake/);
    await assert.rejects(open(node(), { nowMs: lowerBound(c) + 300_000 }), /more than 120 s/);
  });
  test('refuses a wallet that could not go on to make the stake, before it locks the 2 units', async () => {
    const c = STAKE_A;
    const withWallet = (wallet: UTxO[]) => uplcEvaluatingProvider([...wallet, c.registry, ...MODULE], Number(c.tx.invalidBefore));
    const open = async (n: ReturnType<typeof withWallet>) => buildStakeOpening(await lucidForAddress(n, c.ownerAddress), n, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, nowMs: lowerBound(c) });
    const at = (lovelace: bigint, i = 0, extra: Record<string, bigint> = {}): UTxO => ({ ...c.wallet, txHash: 'a1'.repeat(32), outputIndex: i, assets: { lovelace, ...extra } });
    // The review's case: 4.5 units build step 1 and leave step 2 without the stake or its collateral.
    await assert.rejects(open(withWallet([at(4_500_000n)])), /The wallet holds 4\.500000 units; a stake needs 13\.000000: the 2-unit opening output, the module's minimum of 10\.000000 and about 1 unit of fees for the two steps\. Nothing was built\./);
    await assert.rejects(open(withWallet([at(12_999_999n)])), /a stake needs 13\.000000/, 'one lovelace short');
    await assert.rejects(open(withWallet([at(4_000_000n), at(4_500_000n, 1), at(4_500_000n, 2)])), /no pure output of at least 5 units, which step 2 needs as collateral/);
    await assert.rejects(open(withWallet([at(20_000_000n, 0, { [`${'ab'.repeat(28)}74`]: 1n })])), /no pure output of at least 5 units/, 'an output that carries a token is not collateral');
    await assert.doesNotReject(open(withWallet([at(13_000_000n)])), 'exactly enough');
  });
  test('refuses a wallet that is not the one bound to changeAddress', async () => {
    const c = STAKE_A;
    const n = uplcEvaluatingProvider([c.wallet, STAKE_B.wallet, c.registry, ...MODULE], Number(c.tx.invalidBefore));
    await assert.rejects(buildStakeOpening(await lucidForAddress(n, STAKE_B.ownerAddress), n, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, nowMs: lowerBound(c) }),
      /changeAddress is not the address this wallet is bound to/);
  });
  test('stakeOutputZero: the opening output and the stake must be output 0, with their datum, lovelace and (for the stake) one token', async () => {
    const c = STAKE_A;
    // Step 1, built: output 0 is the opening output.
    const live = decodeStakeDatum(c.opening.datum!);
    const n1 = uplcEvaluatingProvider([c.wallet, c.registry, ...MODULE], (live.last_updated - ZERO) / 1000);
    const opened = await buildStakeOpening(await lucidForAddress(n1, c.ownerAddress), n1, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, nowMs: live.last_updated });
    assert.equal(stakeOutputZero(opened.txCbor, { datumHex: c.opening.datum!, lovelace: STAKE_OPENING_LOVELACE }), STAKE_OPENING_LOVELACE);
    assert.throws(() => stakeOutputZero(opened.txCbor, { datumHex: c.stakeDatumHex, lovelace: STAKE_OPENING_LOVELACE }), /not have the planned output as output 0/, 'another datum');
    assert.throws(() => stakeOutputZero(opened.txCbor, { datumHex: c.opening.datum!, lovelace: STAKE_OPENING_LOVELACE + 1n }), /not have the planned output as output 0/, 'more lovelace than it holds');
    assert.throws(() => stakeOutputZero(opened.txCbor, { datumHex: c.opening.datum!, lovelace: STAKE_OPENING_LOVELACE, unit: stakeTokenUnit(c.agentDidHex) }), /not have the planned output as output 0/, 'no stake token');
    // Step 2, built: output 0 is the stake with its token, and buildStake returns the lovelace it holds.
    const n2 = nodeFor(c);
    const staked = await buildStake(await lucidForAddress(n2, c.ownerAddress), n2, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, openingRef: `${c.opening.txHash}#0`, nowMs: lowerBound(c) });
    const unit = stakeTokenUnit(c.agentDidHex);
    assert.equal(stakeOutputZero(staked.txCbor, { datumHex: c.stakeDatumHex, lovelace: 10_000_000n, unit }), staked.stakeLovelace);
    assert.throws(() => stakeOutputZero(staked.txCbor, { datumHex: c.stakeDatumHex, lovelace: 10_000_000n, unit: stakeTokenUnit(STAKE_B.agentDidHex) }), /not have the planned output as output 0/, 'another agent\'s token');
    // The same datum and lovelace at another address is not the stake.
    await ensureSlotConfig(n2);
    const elsewhere = await (await lucidForAddress(n2, c.ownerAddress)).newTx()
      .pay.ToAddressWithData(c.ownerAddress, { kind: 'inline', value: c.opening.datum! }, { lovelace: STAKE_OPENING_LOVELACE }).complete();
    assert.throws(() => stakeOutputZero(elsewhere.toCBOR(), { datumHex: c.opening.datum!, lovelace: STAKE_OPENING_LOVELACE }), /not have the planned output as output 0/, 'another address');
  });
  test('an agent that already has an opening output is pointed at it, not given a second one to strand', async () => {
    const c = STAKE_A;
    const n = uplcEvaluatingProvider([c.wallet, c.opening, STAKE_B.opening, c.registry, ...MODULE], Number(c.tx.invalidBefore));
    await assert.rejects(
      buildStakeOpening(await lucidForAddress(n, c.ownerAddress), n, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, nowMs: lowerBound(c) }),
      new RegExp(`An opening output for .* is already at ${c.opening.txHash}#0; pass it to vector_build_reputation_stake as opening_ref`),
    );
    // Another agent's opening output does not count, nor an output that holds a token (an opening output holds lovelace only).
    const otherAgent = uplcEvaluatingProvider([c.wallet, STAKE_B.opening, c.registry, ...MODULE], Number(c.tx.invalidBefore));
    await assert.doesNotReject(buildStakeOpening(await lucidForAddress(otherAgent, c.ownerAddress), otherAgent, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, nowMs: lowerBound(c) }));
    const withToken: UTxO = { ...c.opening, txHash: 'c3'.repeat(32), assets: { lovelace: 2_000_000n, [`${REPUTATION_SCRIPT_HASH}aa`]: 1n } };
    const tokened = uplcEvaluatingProvider([c.wallet, withToken, c.registry, ...MODULE], Number(c.tx.invalidBefore));
    await assert.doesNotReject(buildStakeOpening(await lucidForAddress(tokened, c.ownerAddress), tokened, { changeAddress: c.ownerAddress, agentId: c.agentId, capabilities: c.capabilities, nowMs: lowerBound(c) }));
  });
});
