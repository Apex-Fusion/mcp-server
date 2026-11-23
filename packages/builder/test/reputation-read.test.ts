// packages/builder/test/reputation-read.test.ts
// The read of stakes from Koios asset_utxos (reputation-read.ts): the sum over the stakes of an agent, the sum 0 for an agent with no stake,
// the checks of each row, and the failures. The stake rows are written as the live Koios answers (the row shape was read from the earlier
// deployment on 2026-11-18); the datums are the 8-field datums of the identity-era deployment. One test reads the stake that the identity-era
// deployment holds, with the reference, the address, the AP3X, the datum and the token of the chain (LIVE_STAKE_UTXO). Koios is a stubbed fetch: no network is touched.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Constr, Data } from '@lucid-evolution/lucid';
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, encodeStakeDatum, stakeTokenName, stakeTokenUnit } from '../src/vector/reputation-datum.ts';
import type { StakeDatum } from '../src/vector/reputation-datum.ts';
import { MAX_AGENTS_PER_READ, capabilityText, readStakes } from '../src/vector/reputation-read.ts';
import { LIVE_STAKE_UTXO } from './fixtures/reputation-golden.fixture.ts';

const A = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const B = 'b2'.repeat(32);
const C = 'a3'.repeat(32);
/** The agent of LIVE_STAKE_UTXO, the stake that the chain holds: a test record of the Foundation. */
const LIVE_AGENT = '4e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9';
const KOIOS = 'https://koios.example/';
const OWNER = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
const hex = (text: string) => Buffer.from(text).toString('hex');

const datumOf = (agent: string, over: Partial<StakeDatum> = {}): StakeDatum => ({
  agent_did: agent, owner_pkh: OWNER, stake_amount: 10_000_000n, staked_capabilities: [hex('ocr.page.extract.v1')], last_updated: 1_794_745_920_000, history_points: 0n,
  challenge_locks: [], stake_id: { txHash: 'ab'.repeat(32), outputIndex: 0 }, ...over,
});

/** A row as Koios asset_utxos answers with `_extended`: the output, its inline datum and its asset list. */
function row(agent: string, ref: string, datum: StakeDatum | string = datumOf(agent), over: Record<string, unknown> = {}) {
  const [tx, index] = ref.split('#');
  return {
    tx_hash: tx, tx_index: Number(index), address: REPUTATION_ADDRESS, value: '10000000', stake_address: null, payment_cred: REPUTATION_SCRIPT_HASH, is_spent: false, reference_script: null,
    inline_datum: { bytes: typeof datum === 'string' ? datum : encodeStakeDatum(datum), value: {} },
    asset_list: [{ decimals: 0, quantity: '1', policy_id: REPUTATION_SCRIPT_HASH, asset_name: stakeTokenName(agent), fingerprint: 'asset1x' }],
    ...over,
  };
}

interface Call { url: string; init: RequestInit }
/** A fetch that answers every request with `rows` as JSON (or with `status`), and records the requests. */
function koios(rows: unknown, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof rows === 'string' ? rows : JSON.stringify(rows), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const TX = (n: number) => `${n.toString(16).padStart(2, '0').repeat(32)}#0`;

describe('readStakes', () => {
  test('one Koios call for any number of agents: the unit of each agent, and the stake with the right sum', async () => {
    const k = koios([row(A, TX(1))]);
    const [a, b] = await readStakes(KOIOS, [A, B], k.fetchImpl);
    assert.equal(k.calls.length, 1);
    assert.equal(k.calls[0].url, 'https://koios.example/api/v1/asset_utxos');
    assert.equal(k.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(k.calls[0].init.body as string), { _asset_list: [[REPUTATION_SCRIPT_HASH, stakeTokenName(A)], [REPUTATION_SCRIPT_HASH, stakeTokenName(B)]], _extended: true });
    assert.deepEqual(a.stakes, [{
      ref: TX(1), stakeAmount: 10_000_000n, lovelace: 10_000_000n, capabilities: ['ocr.page.extract.v1'], lastUpdated: 1_794_745_920_000, challengeLocks: 0,
      stakeId: `${'ab'.repeat(32)}#0`, ownerKeyHash: OWNER, historyPoints: 0n,
    }]);
    assert.equal(a.agentId, A);
    assert.equal(a.tokenUnit, stakeTokenUnit(A));
    assert.equal(a.total, 10_000_000n);
    assert.deepEqual(b, { agentId: B, tokenUnit: stakeTokenUnit(B), stakes: [], total: 0n }, 'an agent with no stake has the sum 0');
  });

  test('reads the stake that the chain holds as vector_get_reputation_stake reports it: 11 AP3X, the two capabilities, last_updated, no lock', async () => {
    // LIVE_STAKE_UTXO is the stake of a test record of the Foundation. The row takes the reference, the address, the AP3X, the datum and the token from the chain data, so the
    // address that the read accepts and the token that it asks for are held against the chain, not against the code.
    const { txHash, outputIndex, address, assets, datum } = LIVE_STAKE_UTXO;
    const unit = Object.keys(assets).find((u) => u !== 'lovelace')!;
    const policy = unit.slice(0, 56);
    const name = unit.slice(56);
    const k = koios([row(LIVE_AGENT, `${txHash}#${outputIndex}`, datum!, { address, value: String(assets.lovelace), asset_list: [{ policy_id: policy, asset_name: name, quantity: String(assets[unit]) }] })]);
    const [agent] = await readStakes(KOIOS, [LIVE_AGENT], k.fetchImpl);
    assert.deepEqual(JSON.parse(k.calls[0].init.body as string), { _asset_list: [[policy, name]], _extended: true }, 'the read asks Koios for the token that the stake holds');
    assert.deepEqual(agent, {
      agentId: LIVE_AGENT, tokenUnit: unit, total: 11_000_000n,
      stakes: [{
        ref: '48d4ce7bbd9141a0e5787af08a2cb14aa6c75b64134f874fa64bc8a4155eb6ad#0', stakeAmount: 11_000_000n, lovelace: 11_000_000n, capabilities: ['smoke.stake-check.a.v1', 'smoke.stake-check.b.v1'],
        lastUpdated: 1_795_425_911_000, challengeLocks: 0, stakeId: 'c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c#0', ownerKeyHash: '34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682', historyPoints: 0n,
      }],
    });
  });

  test('an agent with more than one stake: each is listed (in the order of its reference) and the sum adds their stake_amount', async () => {
    const k = koios([
      row(A, TX(9), datumOf(A, { stake_amount: 12_000_000n, stake_id: { txHash: 'cd'.repeat(32), outputIndex: 2 }, challenge_locks: ['72636c5f' + '01'.repeat(24), '72636c5f' + '02'.repeat(24)] }), { value: '12500000' }),
      row(A, TX(3), datumOf(A, { stake_amount: 10_000_000n })),
      row(B, TX(5), datumOf(B, { stake_amount: 11_000_000n, staked_capabilities: [hex('a.v1'), 'ff'] })),
    ]);
    const [a, b, c] = await readStakes(KOIOS, [A, B, C], k.fetchImpl);
    assert.deepEqual(a.stakes.map((s) => s.ref), [TX(3), TX(9)]);
    assert.equal(a.total, 22_000_000n);
    assert.equal(a.stakes[1].challengeLocks, 2);
    assert.equal(a.stakes[1].lovelace, 12_500_000n, 'the output can hold more than the stake that the datum counts');
    assert.equal(a.stakes[1].stakeId, `${'cd'.repeat(32)}#2`);
    assert.equal(b.total, 11_000_000n);
    assert.deepEqual(b.stakes[0].capabilities, ['a.v1', '0xff'], 'bytes that are not UTF-8 are shown as hex');
    assert.equal(c.total, 0n);
  });

  test('the sum counts stake_amount, not the AP3X in the output (a stake that decayed to 0 is still a stake)', async () => {
    const [a] = await readStakes(KOIOS, [A], koios([row(A, TX(1), datumOf(A, { stake_amount: 0n }), { value: '9900000' })]).fetchImpl);
    assert.equal(a.stakes.length, 1);
    assert.equal(a.stakes[0].lovelace, 9_900_000n);
    assert.equal(a.total, 0n);
  });

  test('only a spent output, an output at another address, and a duplicate row are skipped', async () => {
    const good = row(A, TX(1));
    const k = koios([
      row(A, TX(2), datumOf(A), { address: 'addr1w9gk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pyc76uluq' }),
      row(A, TX(3), datumOf(A), { is_spent: true }),
      row(A, TX(4), datumOf(A), { is_spent: true, tx_index: 'not a number', asset_list: null }),
      good, good,
    ]);
    const [a] = await readStakes(KOIOS, [A], k.fetchImpl);
    assert.deepEqual(a.stakes.map((s) => s.ref), [TX(1)]);
    assert.equal(a.total, 10_000_000n);
  });

  test('an unspent row at the stake address that is not a readable stake is an error that names the output: the agent never reads as 0 because of it', async () => {
    const fails = (over: Record<string, unknown> | null, message: RegExp) => assert.rejects(readStakes(KOIOS, [A], koios([over === null ? null : row(A, TX(1), datumOf(A), over)]).fetchImpl), message);
    const named = `The stake address output ${TX(1)}`;
    await fails({ asset_list: null }, new RegExp(`${named} has no asset list`));
    await fails({ asset_list: [] }, new RegExp(`${named} has no asset list`));
    await fails({ asset_list: [{ policy_id: '5168e1871cfdb1e55c18ee173acbcdce092044a48bc2e23f3ba35093', asset_name: stakeTokenName(A), quantity: '1' }] }, new RegExp(`${named} holds none of the stake tokens that were asked for`));
    await fails({ asset_list: [{ policy_id: REPUTATION_SCRIPT_HASH, asset_name: stakeTokenName(A), quantity: '2' }] }, new RegExp(`${named} holds 2 of the stake token of ${A}, not 1`));
    await fails({ tx_index: '1' }, new RegExp(`no readable output reference \\(tx_hash "${'01'.repeat(32)}", tx_index "1"\\)`));
    await fails({ tx_index: 1.5 }, /no readable output reference .*tx_index 1\.5/);
    await fails({ tx_index: undefined }, /no readable output reference .*tx_index undefined/);
    await fails({ tx_hash: 7 }, /no readable output reference \(tx_hash 7,/);
    await fails({ address: undefined }, new RegExp(`The Koios row of the output ${TX(1)} has no address`));
    await fails(null, /returned a row that is not an object: null/);
  });

  test('a stake row that cannot be read is an error that names the output, not a stake that is left out', async () => {
    const six = Data.to(new Constr(0, [A, new Constr(0, [OWNER]), 10_000_000n, [], 5n, 0n]));
    await assert.rejects(readStakes(KOIOS, [A], koios([row(A, TX(1), six)]).fetchImpl), new RegExp(`The stake output ${TX(1)} does not decode: not a stake datum \\(expected constructor 0 with 8 fields\\)`));
    await assert.rejects(readStakes(KOIOS, [A], koios([row(A, TX(1), datumOf(A), { inline_datum: null })]).fetchImpl), new RegExp(`The stake output ${TX(1)} has no inline datum`));
    await assert.rejects(readStakes(KOIOS, [A], koios([row(A, TX(1), datumOf(B))]).fetchImpl), new RegExp(`${TX(1)} holds the stake token of ${A} but its datum names ${B}`));
    await assert.rejects(readStakes(KOIOS, [A], koios([row(A, TX(1), datumOf(A), { value: null })]).fetchImpl), new RegExp(`The stake output ${TX(1)} has no AP3X amount that can be read`));
  });

  test('the identifiers are checked, each is read once, and at most 50 are read', async () => {
    const k = koios([]);
    await assert.rejects(readStakes(KOIOS, [], k.fetchImpl), /Name at least one agent/);
    await assert.rejects(readStakes(KOIOS, ['did:vector:' + A], k.fetchImpl), /is not an agent identifier \(64 lowercase hex characters\)/);
    await assert.rejects(readStakes(KOIOS, [A.toUpperCase()], k.fetchImpl), /is not an agent identifier/);
    const ids = Array.from({ length: MAX_AGENTS_PER_READ + 1 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    await assert.rejects(readStakes(KOIOS, ids, k.fetchImpl), /at most 50 agents/);
    assert.equal(k.calls.length, 0, 'nothing was asked');
    const fifty = await readStakes(KOIOS, ids.slice(0, MAX_AGENTS_PER_READ), k.fetchImpl);
    assert.equal(fifty.length, 50);
    assert.equal(k.calls.length, 1, 'fifty agents, one call');
    const once = await readStakes(KOIOS, [A, A, B, A], koios([]).fetchImpl);
    assert.deepEqual(once.map((g) => g.agentId), [A, B]);
  });

  test('a failing Koios is an error that names the operation and the status, not the endpoint', async () => {
    await assert.rejects(readStakes(KOIOS, [A], koios('upstream error', 503).fetchImpl), (err: Error) => err.message === 'Koios asset_utxos answered 503');
    await assert.rejects(readStakes(KOIOS, [A], koios('<html>', 200).fetchImpl), /Koios asset_utxos: the answer is not JSON/);
    await assert.rejects(readStakes(KOIOS, [A], koios({ error: 'x' }).fetchImpl), /Koios asset_utxos: Koios returned a non-list response/);
  });
});

describe('capabilityText', () => {
  test('UTF-8 bytes as text, other bytes as 0x and hex', () => {
    assert.equal(capabilityText(hex('document-extraction')), 'document-extraction');
    assert.equal(capabilityText('ff00'), '0xff00');
  });
});
