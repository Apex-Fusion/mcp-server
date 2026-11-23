// packages/builder/test/reputation-datum.test.ts
// The data of the identity-era Module-3 reputation validator: the deployment values that the builders carry against the captured chain
// data (reputation-golden.fixture.ts, from capture-reputation-golden.mjs) and the deployment record, the 8-field stake datum, the stake
// token name, and the readers of the module parameters and the cross references. The datum, the token name and the address are also held
// against the stake that the chain holds (LIVE_STAKE_UTXO), not only against datums that a test builds. No network is touched.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Constr, Data, credentialToAddress, getAddressDetails, validatorToScriptHash } from '@lucid-evolution/lucid';
import {
  REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, SEED_STAKE_ID, decodeCrossRefs, decodeStakeDatum, decodeStakeParams, encodeStakeDatum, stakeTokenName, stakeTokenUnit,
} from '../src/vector/reputation-datum.ts';
import type { StakeDatum } from '../src/vector/reputation-datum.ts';
import {
  ENDORSEMENT_SCRIPT_HASH, PARAMS_TOKEN_NAME, REFS_TOKEN_NAME, REPUTATION_IDENTITY_HASH, REPUTATION_PARAMS_HOLDER_ADDRESS, REPUTATION_PARAMS_HOLDER_HASH,
  REPUTATION_PARAMS_TOKEN_POLICY, REPUTATION_REF_SCRIPT_UTXO, REPUTATION_REFS_TOKEN_POLICY, VECTOR_MAINNET_ZERO_TIME_MS,
} from '../src/vector/reputation-build.ts';
import { AGENT_RECORDS, CROSS_REFS_UTXO, LIVE_STAKE_UTXO, PARAMS_UTXO, REPUTATION_REF_UTXO, REPUTATION_SCRIPT_CBOR } from './fixtures/reputation-golden.fixture.ts';
import { REAL_IDENTITY } from './fixtures/reputation-world.ts';

/** `reputation_config_cbor` of Module-3/deploy/identity/mainnet/deploy_state.json: the ReputationConfig that the deployed script has applied. */
const REPUTATION_CONFIG_CBOR =
  'd8798c581c78d0c5547001110c61bcafb143d1c332b7427d91b9ce3f9dbb8d364a581c53f6fc36219a3bc3c8af33c830480cff65aadb51baabb0bf485b4523581c9873ba3348eef1c277bcd6dce266ae170f68aa3baa64cf859d0eec08581c1734760872e81fdc312cc380e2ce2bf597eff01ccb6d98ab7e8e0aee581c78d0c5547001110c61bcafb143d1c332b7427d91b9ce3f9dbb8d364a581cbb9e647e6ea974753c0b61ff2330dcf7a27710e954ca460b1aeb24c5581cc5bff82c5d67158234e62cc0a099cd70b072eca9702eec28d8b321ba4040581c470ded7c9d487c2c3832af84aea70987b2c9a01480192ebbf035d028581c8295dad015ecba3d5f7b346083d0c879794ab065b1c7ec1a533f2657581cd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762';

const ID = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const OWNER = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
const DATUM: StakeDatum = {
  agent_did: ID, owner_pkh: OWNER, stake_amount: 10_000_000n, staked_capabilities: [Buffer.from('ocr.page.extract.chandra-ocr-2.v1').toString('hex')], last_updated: 1_794_745_920_000,
  history_points: 0n, challenge_locks: [], stake_id: { txHash: 'ab'.repeat(32), outputIndex: 1 },
};

/** What the datum of LIVE_STAKE_UTXO holds, written from the chain: the stake of a test record of the Foundation (11 AP3X, two capabilities, no lock). */
const LIVE_STAKE: StakeDatum = {
  agent_did: '4e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9', owner_pkh: '34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682', stake_amount: 11_000_000n,
  staked_capabilities: [Buffer.from('smoke.stake-check.a.v1').toString('hex'), Buffer.from('smoke.stake-check.b.v1').toString('hex')], last_updated: 1_795_425_911_000,
  history_points: 0n, challenge_locks: [], stake_id: { txHash: 'c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c', outputIndex: 0 },
};

describe('the deployment that the builders name is the one on the chain', () => {
  test('the deployed reputation script has the hash fad945ab…, and its address is the exact script address', () => {
    assert.equal(validatorToScriptHash(REPUTATION_REF_UTXO.scriptRef!), 'fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424');
    assert.equal(validatorToScriptHash({ type: 'PlutusV3', script: REPUTATION_SCRIPT_CBOR }), REPUTATION_SCRIPT_HASH);
    assert.equal(credentialToAddress('Mainnet', { type: 'Script', hash: REPUTATION_SCRIPT_HASH }), REPUTATION_ADDRESS);
    assert.equal(REPUTATION_ADDRESS, 'addr1w8adj3dtyrmp5k8mma4r8285jxyeklw5zelmvssqhsrqgfqc9uavs');
    assert.equal(getAddressDetails(REPUTATION_ADDRESS).stakeCredential, undefined, 'no stake credential: every stake sits at the exact address');
  });
  test('the stake that the chain holds sits at the stake address of the builders: the read and the builders look for stakes only there', () => {
    assert.equal(LIVE_STAKE_UTXO.address, REPUTATION_ADDRESS);
  });
  test('the reference script is the output that deploy_state.json names; the parameters and the cross references are found by their tokens at the params holder', () => {
    assert.deepEqual({ txHash: REPUTATION_REF_UTXO.txHash, outputIndex: REPUTATION_REF_UTXO.outputIndex }, REPUTATION_REF_SCRIPT_UTXO);
    assert.equal(getAddressDetails(PARAMS_UTXO.address).paymentCredential!.hash, REPUTATION_PARAMS_HOLDER_HASH);
    assert.equal(REPUTATION_PARAMS_HOLDER_ADDRESS, PARAMS_UTXO.address, 'the holder address is where the parameters sit');
    assert.equal(CROSS_REFS_UTXO.address, REPUTATION_PARAMS_HOLDER_ADDRESS, 'the cross references sit at the same holder');
    assert.equal(PARAMS_TOKEN_NAME, Buffer.from('params').toString('hex'));
    assert.equal(REFS_TOKEN_NAME, Buffer.from('reputation_refs').toString('hex'));
    assert.equal(PARAMS_UTXO.assets[`${REPUTATION_PARAMS_TOKEN_POLICY}${PARAMS_TOKEN_NAME}`], 1n, 'the params record holds its one-shot token');
    assert.equal(CROSS_REFS_UTXO.assets[`${REPUTATION_REFS_TOKEN_POLICY}${REFS_TOKEN_NAME}`], 1n);
    assert.deepEqual(decodeCrossRefs(CROSS_REFS_UTXO.datum!), { reputation: REPUTATION_SCRIPT_HASH, endorsement: ENDORSEMENT_SCRIPT_HASH });
  });
  test('the values that the deployed script has applied (the ReputationConfig of deploy_state.json) are the values that the builders carry', () => {
    const config = Data.from(REPUTATION_CONFIG_CBOR);
    assert.ok(config instanceof Constr && config.index === 0 && config.fields.length === 12, 'ReputationConfig has 12 fields');
    const f = config.fields;
    assert.equal(f[0], REPUTATION_REFS_TOKEN_POLICY, 'refs_token_policy');
    assert.equal(f[5], REPUTATION_PARAMS_HOLDER_HASH, 'params_script_hash');
    assert.equal(f[7], '', 'ap3x_policy_id: AP3X is lovelace');
    assert.equal(f[8], '', 'ap3x_asset_name');
    assert.equal(f[10], REPUTATION_PARAMS_TOKEN_POLICY, 'params_token_policy');
    assert.equal(f[11], REPUTATION_IDENTITY_HASH, 'identity_hash');
  });
  test('the identity registry that the reputation validator reads is the one that the hosted values give, and its records sit at its address', () => {
    assert.equal(REAL_IDENTITY.identity.hash, REPUTATION_IDENTITY_HASH);
    for (const { id, utxo } of Object.values(AGENT_RECORDS)) {
      assert.equal(utxo.address, REAL_IDENTITY.identity.address);
      assert.equal(utxo.assets[`${REPUTATION_IDENTITY_HASH}${id}`], 1n);
    }
  });
  test('Vector mainnet starts at 2025-08-29T16:40:00Z', () => {
    assert.equal(new Date(VECTOR_MAINNET_ZERO_TIME_MS).toISOString(), '2025-08-29T16:40:00.000Z');
  });
  test('the parameters: a stake of at least 10 AP3X, and a cooldown of 24 hours, in milliseconds', () => {
    assert.deepEqual(decodeStakeParams(PARAMS_UTXO.datum!), { minSelfStake: 10_000_000n, stakeCooldown: 86_400_000n });
    const fields = (Data.from(PARAMS_UTXO.datum!) as Constr<Data>).fields;
    assert.equal(fields.length, 22);
    assert.equal(fields[21], 14_400_000n, 'epoch_length: 4 hours in milliseconds');
  });
});

describe('the stake datum', () => {
  test('has 8 fields in the order of types.ak, written as the module writes them', () => {
    // Constr 0 [agent_did, VerificationKey(owner), stake_amount, [capability], last_updated, history_points, [], OutputReference]
    // The capability is 33 bytes (header 5821); last_updated 1794745920000 is 1b000001a1df316a00. Lucid writes the empty challenge_locks as 80,
    // where the reference SDK writes 9fff: the same Plutus data, and the validator compares data, not bytes.
    const expected = `d8799f5820${ID}d8799f581c${OWNER}ff1a009896809f5821${DATUM.staked_capabilities[0]}ff1b000001a1df316a000080d8799f5820${'ab'.repeat(32)}01ffff`;
    assert.equal(encodeStakeDatum(DATUM), expected);
    assert.deepEqual(decodeStakeDatum(expected), DATUM);
  });
  test('reads the datum of the stake that the chain holds, field by field', () => {
    // LIVE_STAKE_UTXO is the stake of a test record of the Foundation, as its last action left it. The 8 fields are the ones that the chain holds, not ones that a test builds.
    assert.deepEqual(decodeStakeDatum(LIVE_STAKE_UTXO.datum!), LIVE_STAKE);
  });
  test('writes the fields of that stake as the chain holds them, byte for byte', () => {
    // The bytes that the chain holds: the capabilities are an indefinite list of two 22-byte strings (9f56..ff), the empty challenge_locks is 80, and last_updated is a 64-bit integer (1b000001a207b940d8).
    assert.equal(encodeStakeDatum(LIVE_STAKE), LIVE_STAKE_UTXO.datum);
  });
  test('round trips with locks, history points and an opening placeholder', () => {
    const d: StakeDatum = { ...DATUM, history_points: 7n, challenge_locks: ['72636c5f' + '01'.repeat(24)], stake_id: SEED_STAKE_ID, staked_capabilities: ['61', '62'] };
    assert.deepEqual(decodeStakeDatum(encodeStakeDatum(d)), d);
    assert.deepEqual(SEED_STAKE_ID, { txHash: '00'.repeat(32), outputIndex: 0 });
  });
  test('decodeStakeDatum refuses what is not an 8-field stake datum, the earlier 6-field layout included', () => {
    const six = Data.to(new Constr(0, [ID, new Constr(0, [OWNER]), 1n, [], 2n, 0n]));
    assert.throws(() => decodeStakeDatum(six), /expected constructor 0 with 8 fields/);
    assert.throws(() => decodeStakeDatum('zz'), /not a stake datum/);
    const fields = (Data.from(encodeStakeDatum(DATUM)) as Constr<Data>).fields;
    const withField = (i: number, value: Data) => Data.to(new Constr(0, fields.map((f, j) => (j === i ? value : f))));
    assert.throws(() => decodeStakeDatum(withField(0, 'abcd')), /agent_did is not 32 bytes/);
    assert.throws(() => decodeStakeDatum(withField(1, new Constr(1, [OWNER]))), /not a verification-key credential/);
    assert.throws(() => decodeStakeDatum(withField(2, 'ab')), /an integer field is not an integer/);
    assert.throws(() => decodeStakeDatum(withField(3, 'ab')), /staked_capabilities is not a list of bytes/);
    assert.throws(() => decodeStakeDatum(withField(6, [1n])), /challenge_locks is not a list of bytes/);
    assert.throws(() => decodeStakeDatum(withField(7, new Constr(0, ['ab', 0n]))), /stake_id is not an output reference/);
    assert.throws(() => decodeStakeDatum(withField(4, -1n)), /last_updated is not a time/);
  });
  test('encodeStakeDatum refuses fields that are not what the datum holds', () => {
    assert.throws(() => encodeStakeDatum({ ...DATUM, agent_did: 'ab' }), /agent_did must be 32 bytes/);
    assert.throws(() => encodeStakeDatum({ ...DATUM, owner_pkh: 'ab' }), /owner_pkh must be 28 bytes/);
    assert.throws(() => encodeStakeDatum({ ...DATUM, staked_capabilities: ['xyz'] }), /not lowercase hex/);
    assert.throws(() => encodeStakeDatum({ ...DATUM, stake_id: { txHash: 'ab', outputIndex: 0 } }), /stake_id is not an output reference/);
    assert.throws(() => encodeStakeDatum({ ...DATUM, last_updated: 1.5 }), /whole number of POSIX milliseconds/);
  });
});

describe('the stake token', () => {
  test('its name is "rstk_" and the first 27 bytes of blake2b-256 of the 32 identifier bytes, the name that the live stakes carry', () => {
    // The agent of the Agent History service and its stake token on the earlier deployment (Koios asset_utxos, 2026-11-18): the same name rule.
    assert.equal(stakeTokenName('8a98c4b74f0e49a09ca4b3502e121c96a8e6992afd2cba64ef8128042fedd440'), '7273746b5f59bf69e33704bdced209a605cedeec1c9c2439920829877ca45915');
    assert.equal(stakeTokenName(ID).length, 64, '32 bytes, the longest asset name');
    assert.equal(stakeTokenUnit(ID), REPUTATION_SCRIPT_HASH + stakeTokenName(ID));
  });
  test('the stake that the chain holds carries the token that the identifier of its agent gives, and no other token', () => {
    // The name rule on the identity-era deployment itself: the test above uses a stake of the earlier deployment. The name comes from the identifier of the agent, not from stake_id.
    const unit = stakeTokenUnit(LIVE_STAKE.agent_did);
    assert.deepEqual(Object.keys(LIVE_STAKE_UTXO.assets).filter((u) => u !== 'lovelace'), [unit]);
    assert.equal(LIVE_STAKE_UTXO.assets[unit], 1n);
  });
  test('an identifier is 32 bytes of lowercase hex', () => {
    assert.throws(() => stakeTokenName('abcd'), /32 bytes/);
    assert.throws(() => stakeTokenName(ID.toUpperCase()), /32 bytes/);
  });
});

describe('the readers of the module parameters and the cross references', () => {
  test('decodeStakeParams reads the 22-field record and refuses anything else', () => {
    const base = (Data.from(PARAMS_UTXO.datum!) as Constr<Data>).fields;
    assert.throws(() => decodeStakeParams(Data.to(new Constr(0, [10_000_000n, 1n, 2n, 3n]))), /expected constructor 0 with 22 fields/);
    assert.throws(() => decodeStakeParams(Data.to(new Constr(1, base))), /expected constructor 0 with 22 fields/);
    assert.throws(() => decodeStakeParams(Data.to(new Constr(0, base.map((f, i) => (i === 0 ? 0n : f))))), /min_self_stake must be a positive integer/);
    assert.throws(() => decodeStakeParams(Data.to(new Constr(0, base.map((f, i) => (i === 3 ? 'ab' : f))))), /stake_cooldown/);
    assert.throws(() => decodeStakeParams('zz'), /not Plutus data/);
  });
  test('decodeCrossRefs reads two 28-byte hashes and refuses anything else', () => {
    assert.throws(() => decodeCrossRefs(Data.to(new Constr(0, [REPUTATION_SCRIPT_HASH]))), /not the cross-validator references datum/);
    assert.throws(() => decodeCrossRefs(Data.to(new Constr(0, [REPUTATION_SCRIPT_HASH, 'ab']))), /not the cross-validator references datum/);
    assert.throws(() => decodeCrossRefs('zz'), /not Plutus data/);
  });
});
