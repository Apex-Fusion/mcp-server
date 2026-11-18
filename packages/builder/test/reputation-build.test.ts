// packages/builder/test/reputation-build.test.ts
// The reputation stake builders on the identity-era Module-3 deployment, against the DEPLOYED reputation script: Lucid runs it on every
// build (reputation-world.ts holds the captured reference script, parameters and cross references), so a build that completes is one
// that the validator accepts, minus the signatures (the script reads only the required signers). The chain test builds open, create,
// increase, capability update and decrease, each on the ledger that the step before leaves. Each rule has a refusal of the builder, and a
// verdict test: a transaction assembled past the builder's checks, which the deployed script rejects, next to its accepted twin.
// No network is touched.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML, Constr, Data, credentialToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { lucidForAddress } from '../src/vector/build.ts';
import { recordWithAncestors, windowAt } from '../src/vector/identity-chain.ts';
import type { SignedByBuild } from '../src/vector/identity-chain.ts';
import type { IdentityDeployment } from '../src/vector/identity-deployment.ts';
import { keyHashOf } from '../src/vector/identity-rules.ts';
import { decodeIdentityDatum, utf8Hex } from '../src/vector/identity-codec.ts';
import {
  CREATE_STAKE_REDEEMER, MINT_STAKE_TOKEN_REDEEMER, STAKE_OPENING_LOVELACE, assembleStakeCreate, assertIdentityRegistry, assertMeansForStake, assertVectorMainnet, buildStakeCreate, coinsPerUtxoByteOf,
  findOutput, minimumOf, buildStakeOpening, readModuleReferences, readOpening, planStakeCreate, planStakeOpening, stakeAgentId,
  PARAMS_TOKEN_NAME, REFS_TOKEN_NAME, REPUTATION_PARAMS_HOLDER_ADDRESS, REPUTATION_PARAMS_TOKEN_POLICY, REPUTATION_REFS_TOKEN_POLICY, MAX_LISTED_OPENINGS, shownOpenings,
} from '../src/vector/reputation-build.ts';
import type { StakeCreatePlan, StakeOut } from '../src/vector/reputation-build.ts';
import {
  assembleStakeCapabilities, assembleStakeDecrease, assembleStakeIncrease, buildStakeCapabilities, buildStakeDecrease, buildStakeIncrease, planStakeCapabilities,
  planStakeDecrease, planStakeIncrease,
} from '../src/vector/reputation-actions.ts';
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, decodeStakeDatum, encodeStakeDatum, stakeTokenUnit } from '../src/vector/reputation-datum.ts';
import type { StakeDatum } from '../src/vector/reputation-datum.ts';
import { DEPLOYMENT } from './fixtures/identity-world.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';
import {
  AGENT2_ID, AGENT_ID, AGENT_RECORDS, CAPABILITIES, CONTROLLER, CROSS_REFS_UTXO, DAY, HOUR, LISTED, NOW, PARAMS_UTXO, REAL_IDENTITY, REPLACEMENT, REPUTATION_REF_UTXO, STRANGER, SUBAGENT_ID, WALLET,
  WALLET_ADDRESS, WALLET_UTXOS, World, agent2Record, agentRecord, outputsOf, recordOutput, spentBy, AUTH_ONLY,
} from './fixtures/reputation-world.ts';

const DID = `did:vector:${AGENT_ID}`;
const DID2 = `did:vector:${AGENT2_ID}`;
const STAKE_CAPS = CAPABILITIES.slice(0, 2);
const UNIT = stakeTokenUnit(AGENT_ID);
const UNIT2 = stakeTokenUnit(AGENT2_ID);
const AP3X = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What every builder takes: Lucid bound to the wallet, the node (a fixture over the ledger of the world), and the identity registry of mainnet. */
interface Ctx { lucid: LucidEvolution; provider: FixtureProvider; deployment: IdentityDeployment }
async function ctxOf(world: World, address = WALLET_ADDRESS): Promise<Ctx> {
  const provider = world.provider();
  return { lucid: await lucidForAddress(provider, address), provider, deployment: REAL_IDENTITY };
}
const txOf = (cbor: string) => CML.Transaction.from_cbor_hex(cbor);
const refsOf = (list: CML.TransactionInputList | undefined): string[] =>
  Array.from({ length: list?.len() ?? 0 }, (_, i) => `${list!.get(i).transaction_id().to_hex()}#${list!.get(i).index()}`).sort();
const requiredSigners = (cbor: string): string[] => {
  const s = txOf(cbor).body().required_signers();
  return Array.from({ length: s?.len() ?? 0 }, (_, i) => s!.get(i).to_hex()).sort();
};
const mintOf = (cbor: string): Record<string, string> => {
  const m = txOf(cbor).body().mint();
  const out: Record<string, string> = {};
  if (!m) return out;
  const policies = m.keys();
  for (let i = 0; i < policies.len(); i++) {
    const assets = m.get_assets(policies.get(i))!;
    const names = assets.keys();
    for (let j = 0; j < names.len(); j++) out[policies.get(i).to_hex() + Buffer.from(names.get(j).to_raw_bytes()).toString('hex')] = assets.get(names.get(j))!.toString();
  }
  return out;
};
/** The stake output of a built transaction: its datum and lovelace. */
function stakeOutput(cbor: string, unit: string): { index: number; datum: StakeDatum; lovelace: bigint } {
  const found = outputsOf(cbor).findIndex((u) => u.address === REPUTATION_ADDRESS && (u.assets[unit] ?? 0n) === 1n);
  assert.ok(found >= 0, 'the transaction has a stake output');
  const u = outputsOf(cbor)[found];
  return { index: found, datum: decodeStakeDatum(u.datum!), lovelace: u.assets.lovelace };
}

/**
 * The Conway minimum fee of a built transaction with the signatures of every required signer added: the size fee, the price of the
 * execution units, and the price of each byte of the reference scripts that its reference inputs and its inputs hold (Ogmios error 3122
 * when the fee is smaller). A signature of a throwaway key has the size of the signature of the real key.
 */
async function minimumFee(provider: FixtureProvider, lucid: LucidEvolution, txCbor: string, signers: number): Promise<{ fee: bigint; referenceScriptBytes: number }> {
  const pp = lucid.config().protocolParameters;
  assert.ok(pp, 'the fixture provider gives the protocol parameters');
  const tx = txOf(txCbor);
  const body = tx.body();
  const witnesses = tx.witness_set();
  const vkeys = CML.VkeywitnessList.new();
  for (let i = 0; i < signers; i++) vkeys.add(CML.make_vkey_witness(CML.hash_transaction(body), CML.PrivateKey.generate_ed25519()));
  witnesses.set_vkeywitnesses(vkeys);
  const size = CML.Transaction.new(body, witnesses, true, tx.auxiliary_data()).to_cbor_bytes().length;
  const redeemers = tx.witness_set().redeemers()?.to_flat_format();
  let mem = 0n;
  let steps = 0n;
  for (let i = 0; i < (redeemers?.len() ?? 0); i++) {
    mem += redeemers!.get(i).ex_units().mem();
    steps += redeemers!.get(i).ex_units().steps();
  }
  const scale = 10_000_000n;
  const execution = (mem * BigInt(Math.round(pp.priceMem * Number(scale))) + steps * BigInt(Math.round(pp.priceStep * Number(scale))) + scale - 1n) / scale;
  const toRefs = (list: CML.TransactionInputList | undefined) => Array.from({ length: list?.len() ?? 0 }, (_, i) => ({ txHash: list!.get(i).transaction_id().to_hex(), outputIndex: Number(list!.get(i).index()) }));
  const utxos = await provider.getUtxosByOutRef([...toRefs(body.reference_inputs()), ...toRefs(body.inputs())]);
  const referenceScriptBytes = utxos.reduce((sum, u) => sum + (u.scriptRef ? u.scriptRef.script.length / 2 : 0), 0);
  assert.ok(referenceScriptBytes <= 25_600, 'above 25,600 bytes the ledger raises the price of each further tier of bytes');
  const fee = BigInt(pp.minFeeA) * BigInt(size) + BigInt(pp.minFeeB) + execution + BigInt(pp.minFeeRefScriptCostPerByte) * BigInt(referenceScriptBytes);
  return { fee, referenceScriptBytes };
}

const OPEN = (over: Record<string, unknown> = {}) => ({ changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, nowMs: NOW, ...over });
const CREATE = (openingRef: string, over: Record<string, unknown> = {}) => ({ changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, openingRef, nowMs: NOW + 120_000, ...over });

/** A world in which the first agent has opened its stake: the opening output is at `openingRef`. */
async function opened(world = new World(), over: Record<string, unknown> = {}) {
  const r = await buildStakeOpening(await ctxOf(world), OPEN(over));
  world.apply(r.txCbor);
  return { world, openingRef: r.openingRef, open: r };
}
/** A world in which the first agent has a stake of `amount` AP3X (created at NOW + 2 minutes; last_updated is the end of its window). */
async function staked(amount = 10, over: Record<string, unknown> = {}) {
  const { world, openingRef } = await opened();
  const create = await buildStakeCreate(await ctxOf(world), CREATE(openingRef, { amountLovelace: AP3X(amount), ...over }));
  world.apply(create.txCbor);
  return { world, create };
}
/** A world in which the second agent has a stake of `amount` AP3X: its controller and its owner are two keys, and neither is the wallet. */
async function stakedSecond(amount = 15) {
  const world = new World();
  const open = await buildStakeOpening(await ctxOf(world), OPEN({ did: DID2, ownerKeyHash: LISTED.keyHash }));
  world.apply(open.txCbor);
  const create = await buildStakeCreate(await ctxOf(world), CREATE(open.openingRef, { did: DID2, amountLovelace: AP3X(amount), nowMs: NOW + 60_000 }));
  world.apply(create.txCbor);
  return { world, create };
}

// ─── The chain: open, create, increase, capability update, decrease ───────────────────────────────────────────────────────────

/** What the fee test needs of the node and the Lucid that built a step. */
interface StepContext { provider: FixtureProvider; lucid: LucidEvolution; signers: number }

describe('the five steps, each built on the ledger that the step before leaves, accepted by the deployed validator', () => {
  const run = (async () => {
    const world = new World();
    const contexts = new Map<string, StepContext>();
    const at = async <T extends SignedByBuild>(name: string, build: (ctx: Ctx) => Promise<T>): Promise<T> => {
      const ctx = await ctxOf(world);
      const r = await build(ctx);
      contexts.set(name, { provider: ctx.provider, lucid: ctx.lucid, signers: r.requiredSigners.length });
      world.apply(r.txCbor);
      return r;
    };
    const open = await at('open', (ctx) => buildStakeOpening(ctx, OPEN()));
    const recordRef = world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT_ID}`] === 1n)!;
    const create = await at('create', (ctx) => buildStakeCreate(ctx, CREATE(open.openingRef)));
    const increase = await at('increase', (ctx) => buildStakeIncrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: AP3X(5), nowMs: NOW + 2 * HOUR }));
    const capabilities = await at('capabilities', (ctx) => buildStakeCapabilities(ctx, { changeAddress: WALLET_ADDRESS, did: DID, capabilities: CAPABILITIES, nowMs: increase.readyAt + 30_000 }));
    const decrease = await at('decrease', (ctx) => buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, amountLovelace: AP3X(3), nowMs: capabilities.readyAt + 30_000 }));
    return { world, contexts, recordRef, open, create, increase, capabilities, decrease };
  })();

  test('open locks the opening output at the reputation address with the 8-field datum, and leaves the 5 AP3X collateral output alone', async () => {
    const { open: r } = await run;
    const [hash, index] = r.openingRef.split('#');
    const out = outputsOf(r.txCbor)[Number(index)];
    assert.equal(hash, r.txHash);
    assert.equal(out.address, REPUTATION_ADDRESS);
    assert.equal(out.assets.lovelace, STAKE_OPENING_LOVELACE);
    const datum = decodeStakeDatum(out.datum!);
    assert.equal(datum.agent_did, AGENT_ID);
    assert.equal(datum.owner_pkh, WALLET.keyHash);
    assert.deepEqual(datum.staked_capabilities, STAKE_CAPS.map(utf8Hex));
    assert.deepEqual(datum.stake_id, { txHash: '00'.repeat(32), outputIndex: 0 }, 'the placeholder: the stake takes the opening output\'s own reference');
    assert.equal(datum.challenge_locks.length, 0);
    assert.equal(r.collateralKept, true);
    assert.ok(!refsOf(txOf(r.txCbor).body().inputs()).includes(`${'f2'.repeat(32)}#1`), 'the 5 AP3X output is not an input');
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [WALLET.keyHash]);
  });

  test('create consumes the opening output, mints exactly the stake token, and locks the stake with last_updated = the upper bound of the window', async () => {
    const { create: r } = await run;
    const body = txOf(r.txCbor).body();
    const out = stakeOutput(r.txCbor, UNIT);
    assert.equal(r.stakeRef, `${r.txHash}#${out.index}`);
    assert.deepEqual(mintOf(r.txCbor), { [UNIT]: '1' });
    assert.ok(refsOf(body.inputs()).includes(r.openingRef), 'the opening output is spent');
    assert.equal(out.lovelace, 10_000_000n);
    assert.equal(out.datum.stake_amount, 10_000_000n);
    assert.deepEqual(out.datum.staked_capabilities, STAKE_CAPS.map(utf8Hex));
    assert.equal(out.datum.owner_pkh, WALLET.keyHash);
    assert.equal(out.datum.last_updated, r.validTo, 'last_updated is hi');
    assert.equal(out.datum.history_points, 0n);
    assert.deepEqual(out.datum.challenge_locks, []);
    assert.deepEqual(out.datum.stake_id, { txHash: r.openingRef.split('#')[0], outputIndex: Number(r.openingRef.split('#')[1]) }, 'stake_id is the output reference of the opening output');
    assert.equal(r.stakeId, r.openingRef);
    assert.equal(r.lastUpdated, r.validTo);
    assert.ok(r.validTo - r.validFrom <= HOUR);
    assert.equal(r.readyAt, r.validTo + DAY, 'the stake can change one cooldown after last_updated');
  });

  test('create reads the record, the parameters, the cross references and the deployed script as reference inputs, and lists the signers with their roles', async () => {
    const { create: r, recordRef } = await run;
    const refs = refsOf(txOf(r.txCbor).body().reference_inputs());
    for (const u of [REPUTATION_REF_UTXO, PARAMS_UTXO, recordRef]) assert.ok(refs.includes(`${u.txHash}#${u.outputIndex}`), `${u.txHash} is a reference input`);
    assert.ok(refs.some((x) => x.startsWith('f194fa5a')), 'the cross references');
    assert.equal(refs.length, 4);
    // The wallet is the controller and the owner: one signer, three roles.
    assert.deepEqual(requiredSigners(r.txCbor), [WALLET.keyHash]);
    assert.equal(r.requiredSigners.length, 1);
    assert.equal(r.requiredSigners[0].keyHash, WALLET.keyHash);
    assert.match(r.requiredSigners[0].roles.join(' | '), /controller of did:vector:a3.*\| owner of the stake .*\| wallet \(inputs, fee and collateral\)/);
  });

  test('increase adds AP3X: a larger stake_amount, the new last_updated, and everything else as it was', async () => {
    const { increase: r, create } = await run;
    const out = stakeOutput(r.txCbor, UNIT);
    assert.equal(r.stakeRef, `${r.txHash}#${out.index}`);
    assert.equal(r.previousRef, create.stakeRef);
    assert.equal(out.datum.stake_amount, 15_000_000n);
    assert.equal(out.lovelace, 15_000_000n);
    assert.equal(out.datum.last_updated, r.validTo);
    assert.deepEqual(out.datum.staked_capabilities, STAKE_CAPS.map(utf8Hex));
    assert.deepEqual(out.datum.stake_id, { txHash: create.stakeId.split('#')[0], outputIndex: Number(create.stakeId.split('#')[1]) }, 'stake_id never changes');
    assert.equal(r.addedLovelace, 5_000_000n);
    assert.deepEqual(mintOf(r.txCbor), {});
  });

  test('update capabilities replaces the staked list and keeps the AP3X', async () => {
    const { capabilities: r, increase } = await run;
    const out = stakeOutput(r.txCbor, UNIT);
    assert.deepEqual(out.datum.staked_capabilities, CAPABILITIES.map(utf8Hex));
    assert.equal(out.datum.stake_amount, 15_000_000n);
    assert.equal(out.lovelace, 15_000_000n);
    assert.equal(out.datum.last_updated, r.validTo);
    assert.deepEqual(r.previousCapabilities, STAKE_CAPS);
    assert.ok(r.validFrom >= increase.readyAt, 'the cooldown is over at the lower bound');
  });

  test('decrease pays the amount to the payee, keeps the AP3X above the minimum in the stake, and the continuing stake is output 0', async () => {
    const { decrease: r } = await run;
    const outputs = outputsOf(r.txCbor);
    const out = stakeOutput(r.txCbor, UNIT);
    assert.equal(out.index, 0);
    assert.equal(out.datum.stake_amount, 12_000_000n);
    assert.equal(out.lovelace, 12_000_000n);
    assert.equal(outputs[1].address, WALLET_ADDRESS);
    assert.equal(outputs[1].assets.lovelace, 3_000_000n);
    assert.deepEqual(r.payee, { keyHash: WALLET.keyHash, reason: 'owner' });
    assert.equal(r.payoutAddress, WALLET_ADDRESS);
    assert.equal(r.takenLovelace, 3_000_000n);
    assert.equal(out.datum.last_updated, r.validTo);
    assert.deepEqual(requiredSigners(r.txCbor), [WALLET.keyHash]);
  });

  test('the ledger that the five steps leave holds one stake of the agent, and the opening output is gone', async () => {
    const { world } = await run;
    const stakes = world.utxos.filter((u) => u.address === REPUTATION_ADDRESS && (u.assets[UNIT] ?? 0n) > 0n);
    assert.equal(stakes.length, 1);
    assert.equal(decodeStakeDatum(stakes[0].datum!).stake_amount, 12_000_000n);
    assert.equal(world.utxos.filter((u) => u.address === REPUTATION_ADDRESS).length, 1);
  });

  for (const name of ['create', 'increase', 'capabilities', 'decrease'] as const) {
    test(`the fee of ${name} pays for the reference script (15 lovelace for each of its bytes), the execution units and every signature`, async () => {
      const built = await run;
      const { provider, lucid, signers } = built.contexts.get(name)!;
      const minimum = await minimumFee(provider, lucid, built[name].txCbor, signers);
      assert.equal(minimum.referenceScriptBytes, REPUTATION_REF_UTXO.scriptRef!.script.length / 2);
      assert.ok(BigInt(built[name].fee) >= minimum.fee, `the fee ${built[name].fee} is below the ledger minimum ${minimum.fee}`);
    });
  }
  test('the fee of the opening needs no reference script', async () => {
    const built = await run;
    const { provider, lucid } = built.contexts.get('open')!;
    const minimum = await minimumFee(provider, lucid, built.open.txCbor, 1);
    assert.equal(minimum.referenceScriptBytes, 0);
    assert.ok(BigInt(built.open.fee) >= minimum.fee);
  });
});

// ─── Who signs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the signers: the controller of the record, the owner credential, and the wallet', () => {
  const WALLET2 = STRANGER; // a wallet that is neither the controller nor the owner
  const wallet2Address = credentialToAddress('Mainnet', { type: 'Key', hash: WALLET2.keyHash });
  const wallet2Utxos: UTxO[] = [
    { txHash: 'e1'.repeat(32), outputIndex: 0, address: wallet2Address, assets: { lovelace: 500_000_000n } },
    { txHash: 'e2'.repeat(32), outputIndex: 1, address: wallet2Address, assets: { lovelace: 5_000_000n } },
  ];
  const world2 = () => new World([], { wallet: wallet2Utxos });

  test('three keys sign when the controller, the owner (a listed key) and the wallet are three keys, and the transaction lists the first two', async () => {
    const world = world2();
    const open = await buildStakeOpening(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: LISTED.keyHash, nowMs: NOW });
    assert.deepEqual(open.requiredSigners.map((s) => s.keyHash), [WALLET2.keyHash], 'no script runs in step 1: only the wallet signs');
    world.apply(open.txCbor);
    const r = await buildStakeCreate(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, capabilities: STAKE_CAPS, openingRef: open.openingRef, ownerKeyHash: LISTED.keyHash, nowMs: NOW + 60_000 });
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, LISTED.keyHash, WALLET2.keyHash]);
    assert.deepEqual(requiredSigners(r.txCbor), [CONTROLLER.keyHash, LISTED.keyHash].sort(), 'the body lists the controller and the owner; the wallet signs for its inputs');
    assert.match(r.requiredSigners[0].roles[0], /^controller of did:vector:a4/);
    assert.match(r.requiredSigners[1].roles[0], /^owner of the stake/);
    assert.equal(r.requiredSigners[2].roles[0], 'wallet (inputs, fee and collateral)');
    const minimum = await minimumFee((await ctxOf(world, wallet2Address)).provider, await lucidForAddress(world.provider(), wallet2Address), r.txCbor, 3);
    assert.ok(BigInt(r.fee) >= minimum.fee, 'the fee covers three signatures');
    world.apply(r.txCbor);
    // Increase: the controller and the owner sign; decrease (after the cooldown): the controller alone, and it pays the owner.
    const inc = await buildStakeIncrease(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, addLovelace: AP3X(1), nowMs: NOW + 2 * HOUR });
    assert.deepEqual(inc.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, LISTED.keyHash, WALLET2.keyHash]);
    world.apply(inc.txCbor);
    const dec = await buildStakeDecrease(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, amountLovelace: AP3X(1), nowMs: inc.readyAt + 60_000 });
    assert.deepEqual(dec.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, WALLET2.keyHash], 'the owner key need not sign an exit');
    assert.deepEqual(requiredSigners(dec.txCbor), [CONTROLLER.keyHash]);
    assert.deepEqual(dec.payee, { keyHash: LISTED.keyHash, reason: 'owner' });
    assert.equal(dec.payoutAddress, credentialToAddress('Mainnet', { type: 'Key', hash: LISTED.keyHash }), 'the payout goes to the owner key, which is not the wallet');
    const payout = outputsOf(dec.txCbor)[1];
    assert.equal(payout.address, dec.payoutAddress);
    assert.equal(payout.assets.lovelace, AP3X(1));
  });

  test('the owner defaults to the key of changeAddress, which must be a declared key of the record', async () => {
    const world = world2();
    await assert.rejects(buildStakeOpening(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, capabilities: STAKE_CAPS, nowMs: NOW }), new RegExp(`owner key ${WALLET2.keyHash} is not a declared key of ${DID2}`));
    // The accepted twin: the controller key as the owner (the controller is not the wallet, and its own key is declared).
    const open = await buildStakeOpening(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: CONTROLLER.keyHash, nowMs: NOW });
    assert.equal(open.ownerKeyHash, CONTROLLER.keyHash);
  });

  test('a stake whose owner is the controller lists the controller once, with both roles', async () => {
    const world = world2();
    const open = await buildStakeOpening(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: CONTROLLER.keyHash, nowMs: NOW });
    world.apply(open.txCbor);
    const r = await buildStakeCreate(await ctxOf(world, wallet2Address), { changeAddress: wallet2Address, did: DID2, capabilities: STAKE_CAPS, openingRef: open.openingRef, ownerKeyHash: CONTROLLER.keyHash, nowMs: NOW + 60_000 });
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, WALLET2.keyHash]);
    assert.equal(r.requiredSigners[0].roles.length, 2);
  });
});

// ─── CreateStake: the rules of the validator, each with a verdict ─────────────────────────────────────────────────────────────

/** A world in which the second agent (a controller that is not the wallet, a listed key) has an opening output, and a plan for its stake. */
async function createKit(over: { record?: Parameters<typeof agent2Record>[0]; owner?: string; world?: World } = {}) {
  const world = over.world ?? new World();
  const open = await buildStakeOpening(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: LISTED.keyHash, nowMs: NOW });
  world.apply(open.txCbor);
  if (over.record) world.replace(`${world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT2_ID}`] === 1n)!.txHash}#0`, recordOutput(AGENT2_ID, agent2Record(over.record)));
  const ctx = await ctxOf(world);
  await assertVectorMainnet(ctx.provider);
  const chain = await recordWithAncestors(ctx.provider, REAL_IDENTITY, AGENT2_ID);
  const refs = await readModuleReferences(ctx.provider);
  const opening = await readOpening(ctx.provider, open.openingRef);
  const window = windowAt(NOW + 60_000);
  const ownerKeyHash = over.owner ?? LISTED.keyHash;
  const plan = planStakeCreate({ chain, did: DID2, ownerKeyHash, capabilities: STAKE_CAPS, opening, params: refs.stakeParams, window });
  const signerKeyHashes = [CONTROLLER.keyHash, ownerKeyHash];
  const assemble = (over2: Partial<{ plan: StakeCreatePlan; records: UTxO[]; signerKeyHashes: string[]; refs: typeof refs }> = {}) => assembleStakeCreate(ctx.lucid, {
    refs: over2.refs ?? refs, records: over2.records ?? chain.map((r) => r.utxo), opening: opening.utxo, plan: over2.plan ?? plan, signerKeyHashes: over2.signerKeyHashes ?? signerKeyHashes,
  });
  const withDatum = (changes: Partial<StakeDatum>, extra: Partial<StakeCreatePlan> = {}): StakeCreatePlan => {
    const datum = { ...plan.datum, ...changes };
    return { ...plan, datum, datumHex: encodeStakeDatum(datum), stakeLovelace: datum.stake_amount, ...extra };
  };
  return { world, ctx, chain, refs, opening, window, plan, assemble, withDatum, open };
}
const REJECTED = /failed script execution (Spend|Mint)/;

describe('CreateStake: the deployed validator accepts the plan, and rejects each rule that the plan breaks', () => {
  test('the plan is accepted (the twin of every rejection below)', async () => {
    const k = await createKit();
    await assert.doesNotReject(k.assemble());
  });
  test('last_updated must be the upper bound of the window: the lower bound, the earlier SDK\'s stamp, is rejected', async () => {
    const k = await createKit();
    await assert.rejects(k.assemble({ plan: k.withDatum({ last_updated: k.window.lo }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ last_updated: k.window.hi + 1000 }) }), REJECTED);
  });
  test('the window is at most one hour: one second more is rejected', async () => {
    const k = await createKit();
    const longer = { lo: k.window.lo, hi: k.window.lo + HOUR + 1000 };
    await assert.rejects(k.assemble({ plan: k.withDatum({ last_updated: longer.hi }, { window: longer }) }), REJECTED);
    const exact = { lo: k.window.lo, hi: k.window.lo + HOUR };
    await assert.doesNotReject(k.assemble({ plan: k.withDatum({ last_updated: exact.hi }, { window: exact }) }), 'exactly one hour is the longest window');
  });
  test('the controller of the record signs, and the owner credential signs', async () => {
    const k = await createKit();
    await assert.rejects(k.assemble({ signerKeyHashes: [LISTED.keyHash] }), REJECTED);
    await assert.rejects(k.assemble({ signerKeyHashes: [CONTROLLER.keyHash] }), REJECTED);
    await assert.rejects(k.assemble({ signerKeyHashes: [WALLET.keyHash] }), REJECTED);
    await assert.doesNotReject(k.assemble({ signerKeyHashes: [CONTROLLER.keyHash, LISTED.keyHash] }));
  });
  test('the owner credential is a declared credential of the record: the controller key and a key listed with the transaction purpose pass; a key listed for authentication only, and an unlisted key, do not', async () => {
    const k = await createKit();
    const asOwner = (hash: string) => k.assemble({ plan: k.withDatum({ owner_pkh: hash }), signerKeyHashes: [CONTROLLER.keyHash, hash] });
    await assert.doesNotReject(asOwner(CONTROLLER.keyHash));
    await assert.doesNotReject(asOwner(LISTED.keyHash));
    await assert.rejects(asOwner(AUTH_ONLY.keyHash), REJECTED);
    await assert.rejects(asOwner(STRANGER.keyHash), REJECTED);
    await assert.rejects(asOwner(WALLET.keyHash), REJECTED);
  });
  test('the owner in the opening output binds nothing: the stake may name another declared owner than the spent opening datum, and an undeclared owner is rejected', async () => {
    const k = await createKit({ owner: CONTROLLER.keyHash });
    assert.equal(k.opening.datum.owner_pkh, LISTED.keyHash, 'the opening output names the listed key');
    assert.equal(k.plan.datum.owner_pkh, CONTROLLER.keyHash, 'the stake names the controller key');
    await assert.doesNotReject(k.assemble());
    await assert.rejects(k.assemble({ plan: k.withDatum({ owner_pkh: STRANGER.keyHash }), signerKeyHashes: [CONTROLLER.keyHash, STRANGER.keyHash] }), REJECTED);
  });
  test('the stake is at least min_self_stake (10 AP3X): one lovelace less is rejected', async () => {
    const k = await createKit();
    await assert.rejects(k.assemble({ plan: k.withDatum({ stake_amount: 9_999_999n }) }), REJECTED);
    await assert.doesNotReject(k.assemble({ plan: k.withDatum({ stake_amount: 10_000_000n }) }));
    await assert.doesNotReject(k.assemble({ plan: k.withDatum({ stake_amount: 25_000_000n }) }), 'more is fine');
  });
  test('each staked capability is one that the record lists, and the list is not empty', async () => {
    const k = await createKit();
    await assert.rejects(k.assemble({ plan: k.withDatum({ staked_capabilities: [utf8Hex('demo.unknown.v1')] }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ staked_capabilities: [utf8Hex(STAKE_CAPS[0]), utf8Hex('Demo.Text.Summary.V1')] }) }), REJECTED, 'bytes, not case-folded text');
    await assert.rejects(k.assemble({ plan: k.withDatum({ staked_capabilities: [] }) }), REJECTED);
    await assert.doesNotReject(k.assemble({ plan: k.withDatum({ staked_capabilities: [utf8Hex(CAPABILITIES[2])] }) }));
  });
  test('stake_id is the output reference of the opening output; history points and challenge locks start empty', async () => {
    const k = await createKit();
    await assert.rejects(k.assemble({ plan: k.withDatum({ stake_id: { txHash: 'cd'.repeat(32), outputIndex: 0 } }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ stake_id: { txHash: k.opening.utxo.txHash, outputIndex: k.opening.utxo.outputIndex + 1 } }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ history_points: 1n }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ challenge_locks: [utf8Hex('rchl_x')] }) }), REJECTED);
  });
  test('the datum has the 8 fields: the earlier 6-field datum is rejected', async () => {
    const k = await createKit();
    const six = Data.to(new Constr(0, [AGENT2_ID, new Constr(0, [LISTED.keyHash]), 10_000_000n, STAKE_CAPS.map(utf8Hex), BigInt(k.window.hi), 0n]));
    await assert.rejects(k.assemble({ plan: { ...k.plan, datumHex: six } }), REJECTED);
  });
  test('the record is Active over the whole window: a hold, a party that ends inside the window, and a revoked record are rejected', async () => {
    const hold = { type: 'Suspended' as const, holds: [{ by: { type: 'ControllerSet' as const }, reason: 0, since: NOW - DAY, until: NOW + DAY }] };
    for (const status of [hold]) {
      const k = await createKit();
      const record = recordOutput(AGENT2_ID, agent2Record({ status }));
      await assert.rejects(k.assemble({ records: [record] }), REJECTED);
    }
    const k = await createKit();
    const ending = recordOutput(AGENT2_ID, agent2Record({ parties: [{ role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: k.window.hi - 1000, rights: 3, removalAfter: null }] }));
    await assert.rejects(k.assemble({ records: [ending] }), REJECTED);
    const covering = recordOutput(AGENT2_ID, agent2Record({ parties: [{ role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: k.window.hi, rights: 3, removalAfter: null }] }));
    await assert.doesNotReject(k.assemble({ records: [covering] }), 'a party that covers exactly to the end of the window is enough');
    const revoked = recordOutput(AGENT2_ID, agent2Record({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 0, at: NOW - DAY, invalidFrom: null, successor: null }, keys: [], parties: [], capabilities: [] }));
    await assert.rejects(k.assemble({ records: [revoked] }), REJECTED);
  });
  test('a subagent needs its parent: with the parent Active it passes, with the parent missing or suspended it does not', async () => {
    const world = new World([], { records: [recordOutput(AGENT2_ID, agent2Record({ lineage: { type: 'Subagent', parent: AGENT_ID, parentEpoch: 0, depth: 1 } })), recordOutput(AGENT_ID, agentRecord())] });
    const k = await createKit({ world });
    await assert.doesNotReject(k.assemble());
    assert.equal(k.chain.length, 2, 'the record and its parent are reference inputs');
    await assert.rejects(k.assemble({ records: [k.chain[0].utxo] }), /failed script execution|parent/);
    const suspendedParent = recordOutput(AGENT_ID, agentRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: NOW - DAY, until: NOW + DAY }] } }));
    await assert.rejects(k.assemble({ records: [k.chain[0].utxo, suspendedParent] }), REJECTED);
    const bumped = recordOutput(AGENT_ID, agentRecord({ subagentEpoch: 1 }));
    await assert.rejects(k.assemble({ records: [k.chain[0].utxo, bumped] }), REJECTED, 'a parent that ended its subagents');
  });
  test('the params output is found by its params token: an output at the holder without it is ignored, so a forged one cannot lower the minimum', async () => {
    const k = await createKit();
    const forged: UTxO = { ...PARAMS_UTXO, txHash: 'ee'.repeat(32), assets: { lovelace: 3_000_000n }, datum: Data.to(new Constr(0, [0n, ...(Data.from(PARAMS_UTXO.datum!) as Constr<Data>).fields.slice(1)])) };
    await assert.rejects(k.assemble({ refs: { ...k.refs, params: forged }, plan: k.withDatum({ stake_amount: 5n }) }), REJECTED);
    await assert.rejects(k.assemble({ refs: { ...k.refs, params: forged } }), REJECTED, 'and the real parameters are not referenced');
  });
  test('the validator itself lets one agent create a second stake: only the tool refuses it, so the tool\'s refusal is the guard', async () => {
    const { world, create } = await staked();
    assert.ok(create.stakeRef);
    // The agent has a stake. An opening output for it is put on the ledger by hand (the opening tool refuses to build one); the validator accepts another CreateStake all the same.
    const seed: UTxO = {
      txHash: 'a9'.repeat(32), outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 2_000_000n },
      datum: encodeStakeDatum({ ...decodeStakeDatum(world.at(create.stakeRef).datum!), stake_amount: 2_000_000n, stake_id: { txHash: '00'.repeat(32), outputIndex: 0 } }),
    };
    world.utxos.push(seed);
    const ctx = await ctxOf(world);
    await assertVectorMainnet(ctx.provider);
    const chain = await recordWithAncestors(ctx.provider, REAL_IDENTITY, AGENT_ID);
    const refs = await readModuleReferences(ctx.provider);
    const opening = await readOpening(ctx.provider, `${seed.txHash}#0`);
    const plan = planStakeCreate({ chain, did: DID, ownerKeyHash: WALLET.keyHash, capabilities: STAKE_CAPS, opening, params: refs.stakeParams, window: windowAt(NOW + 300_000) });
    await assert.doesNotReject(assembleStakeCreate(ctx.lucid, { refs, records: chain.map((r) => r.utxo), opening: opening.utxo, plan, signerKeyHashes: [WALLET.keyHash] }));
    await assert.rejects(buildStakeCreate(ctx, CREATE(`${seed.txHash}#0`, { nowMs: NOW + 300_000 })), /already has a stake/);
  });
  test('the mint redeemer needs a CreateStake spend: the token cannot be minted alone, or twice', async () => {
    const k = await createKit();
    const mintOnly = k.ctx.lucid.newTx().readFrom([k.refs.script, k.refs.params, k.refs.crossRefs, ...k.chain.map((r) => r.utxo)])
      .mintAssets({ [UNIT2]: 1n }, MINT_STAKE_TOKEN_REDEEMER)
      .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: k.plan.datumHex }, { lovelace: 10_000_000n, [UNIT2]: 1n })
      .addSignerKey(CONTROLLER.keyHash).addSignerKey(LISTED.keyHash).validFrom(k.window.lo).validTo(k.window.hi);
    await assert.rejects(mintOnly.complete(), REJECTED);
    const twice = k.ctx.lucid.newTx().readFrom([k.refs.script, k.refs.params, k.refs.crossRefs, ...k.chain.map((r) => r.utxo)])
      .collectFrom([k.opening.utxo], CREATE_STAKE_REDEEMER).mintAssets({ [UNIT2]: 2n }, MINT_STAKE_TOKEN_REDEEMER)
      .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: k.plan.datumHex }, { lovelace: 10_000_000n, [UNIT2]: 2n })
      .addSignerKey(CONTROLLER.keyHash).addSignerKey(LISTED.keyHash).validFrom(k.window.lo).validTo(k.window.hi);
    await assert.rejects(twice.complete(), REJECTED);
  });
});

// ─── Real records of the identity registry ────────────────────────────────────────────────────────────────────────────────────────

describe('against records that the identity registry holds on mainnet (captured)', () => {
  const chandra = AGENT_RECORDS.CHANDRA;
  const chandraOwner = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9'; // the listed key with the transaction purpose
  const controllerOfChandra = '470ded7c9d487c2c3832af84aea70987b2c9a01480192ebbf035d028';
  const caps = ['document-extraction', 'ocr.page.extract.chandra-ocr-2.v1'];

  test('an Active record with a listed transaction key: the stake is built with that key as owner, and the deployed validator accepts it', async () => {
    const world = new World([chandra.utxo], { records: [] });
    const did = `did:vector:${chandra.id}`;
    const open = await buildStakeOpening(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did, capabilities: caps, ownerKeyHash: chandraOwner, nowMs: NOW });
    world.apply(open.txCbor);
    const r = await buildStakeCreate(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did, capabilities: caps, openingRef: open.openingRef, ownerKeyHash: chandraOwner, nowMs: NOW + 60_000 });
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [controllerOfChandra, chandraOwner, WALLET.keyHash]);
    assert.equal(stakeOutput(r.txCbor, stakeTokenUnit(chandra.id)).datum.owner_pkh, chandraOwner);
    // The controller is the owner too: also declared. The wallet key is not.
    await assert.rejects(buildStakeOpening(await ctxOf(new World([chandra.utxo], { records: [] })), { changeAddress: WALLET_ADDRESS, did, capabilities: caps, nowMs: NOW }), /is not a declared key of did:vector:5542837b/);
  });
  test('a revoked record (a tombstone) and a retired subagent cannot stake: each is refused by its own status, with the parent of the subagent on the ledger', async () => {
    const lineage = decodeIdentityDatum(AGENT_RECORDS.RETIRED_SUBAGENT.utxo.datum!).lineage;
    assert.ok(lineage.type === 'Subagent', 'the captured record is a subagent');
    const cases = [
      { name: 'revoked', rec: AGENT_RECORDS.REVOKED, extra: [] as UTxO[], refusal: /is Revoked over the validity window/ },
      { name: 'retired subagent', rec: AGENT_RECORDS.RETIRED_SUBAGENT, extra: [recordOutput(lineage.parent, agentRecord({ subagentEpoch: 1 }))], refusal: /is Retired over the validity window/ },
    ];
    for (const { name, rec, extra, refusal } of cases) {
      const world = new World([rec.utxo, ...extra], { records: [] });
      await assert.rejects(buildStakeOpening(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: `did:vector:${rec.id}`, capabilities: ['x'], nowMs: NOW }), refusal, name);
    }
  });
});

// ─── Plans, refusals and the wallet ───────────────────────────────────────────────────────────────────────────────────────────

describe('the DID and the server', () => {
  test('stakeAgentId takes the identity DID (and the bare identifier), and refuses the legacy form naming the identity form', () => {
    assert.equal(stakeAgentId(`did:vector:${AGENT_ID}`), AGENT_ID);
    assert.equal(stakeAgentId(` ${AGENT_ID} `), AGENT_ID);
    assert.throws(() => stakeAgentId(`did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${AGENT_ID}`), new RegExp(`DID of the legacy registry.*did:vector:<64 lowercase hex>.*did:vector:${AGENT_ID}`));
    assert.throws(() => stakeAgentId('did:vector:abc'), /is not an identity DID: expected did:vector:<64 lowercase hex>/);
    assert.throws(() => stakeAgentId(`did:vector:${AGENT_ID.toUpperCase()}`), /is not an identity DID/);
    assert.throws(() => stakeAgentId('did:web:example.com'), /is not an identity DID/);
  });
  test('a legacy DID is refused before the node is asked anything', async () => {
    const provider = new FixtureProvider([]);
    const ctx = { lucid: undefined as unknown as LucidEvolution, provider, deployment: REAL_IDENTITY };
    const legacy = `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${AGENT_ID}`;
    await assert.rejects(buildStakeOpening(ctx, OPEN({ did: legacy })), /DID of the legacy registry/);
    await assert.rejects(buildStakeCreate(ctx, CREATE(`${'aa'.repeat(32)}#0`, { did: legacy })), /DID of the legacy registry/);
    await assert.rejects(buildStakeIncrease(ctx, { changeAddress: WALLET_ADDRESS, did: legacy, addLovelace: 1n }), /DID of the legacy registry/);
    await assert.rejects(buildStakeCapabilities(ctx, { changeAddress: WALLET_ADDRESS, did: legacy, capabilities: ['a'] }), /DID of the legacy registry/);
    await assert.rejects(buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: legacy, amountLovelace: 1n }), /DID of the legacy registry/);
  });
  test('an identity registry other than the one that the validator reads is refused', async () => {
    assert.doesNotThrow(() => assertIdentityRegistry(REAL_IDENTITY));
    assert.throws(() => assertIdentityRegistry(DEPLOYMENT), new RegExp(`identity registry \\(policy ${DEPLOYMENT.identity.hash}\\) is not the registry that the Module-3 reputation validator reads \\(policy ${REAL_IDENTITY.identity.hash}\\)`));
    const world = new World();
    const ctx = { ...(await ctxOf(world)), deployment: DEPLOYMENT };
    await assert.rejects(buildStakeOpening(ctx, OPEN()), /is not the registry that the Module-3 reputation validator reads/);
    await assert.rejects(buildStakeIncrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: 1n }), /is not the registry that the Module-3 reputation validator reads/);
  });
});

describe('buildStakeOpening: what step 2 will check is checked before anything is locked', () => {
  test('refuses a capability that the record does not list, naming the record\'s capabilities, and a list that is empty or repeats one', async () => {
    const world = new World();
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ capabilities: ['demo.unknown.v1'] })), /Capability demo.unknown.v1 is not in the record of did:vector:a3.*which lists: demo.text.stats.v1, demo.text.summary.v1, demo.text.extract.v1\. The validator accepts only capabilities that the record lists, byte for byte/);
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ capabilities: [] })), /Name at least one capability/);
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ capabilities: [STAKE_CAPS[0], STAKE_CAPS[0]] })), /is named twice/);
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ capabilities: ['Demo.Text.Stats.V1'] })), /is not in the record/);
    await assert.doesNotReject(buildStakeOpening(await ctxOf(world), OPEN({ capabilities: [STAKE_CAPS[1], STAKE_CAPS[0]] })), 'any order');
  });
  test('refuses an unknown agent, a record that is not Active over the window, and an owner key that the record does not declare', async () => {
    const world = new World();
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ did: `did:vector:${'ee'.repeat(32)}` })), /No record of the agent for did:vector:eeee.* in the identity registry/);
    const held = new World([], { records: [recordOutput(AGENT_ID, agentRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: NOW - DAY, until: NOW + DAY }] } }))] });
    await assert.rejects(buildStakeOpening(await ctxOf(held), OPEN()), /is Suspended over the validity window .* Active over the whole window/);
    const gone = new World([], { records: [recordOutput(AGENT_ID, agentRecord({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 0, at: NOW - DAY, invalidFrom: null, successor: null }, keys: [], parties: [], capabilities: [] }))] });
    await assert.rejects(buildStakeOpening(await ctxOf(gone), OPEN()), /is Revoked over the validity window/);
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ ownerKeyHash: STRANGER.keyHash })), new RegExp(`owner key ${STRANGER.keyHash} is not a declared key of ${DID}: it is neither the controller key nor a key that the record lists with the transaction purpose`));
    // A key that the record lists with the authentication purpose only is no declared owner key; a listed key with the transaction purpose is.
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ did: DID2, ownerKeyHash: AUTH_ONLY.keyHash })), new RegExp(`owner key ${AUTH_ONLY.keyHash} is not a declared key of ${DID2}`));
    assert.ok((await buildStakeOpening(await ctxOf(world), OPEN({ did: DID2, ownerKeyHash: LISTED.keyHash }))).openingRef, 'a listed key with the transaction purpose is declared');
    // The record's Accountable Party must cover the whole window: a window one minute shorter is covered, a longer one is not.
    const ends = new World([], { records: [recordOutput(AGENT_ID, agentRecord({ parties: [{ role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: NOW + 10 * 60_000, rights: 3, removalAfter: null }] }))] });
    await assert.rejects(buildStakeOpening(await ctxOf(ends), OPEN()), /is Suspended over the validity window/);
    await assert.doesNotReject(buildStakeOpening(await ctxOf(ends), OPEN({ validMinutes: 5 })), 'a shorter window is covered');
  });
  test('a subagent is Active only while its parent is, and the parent\'s record must exist', async () => {
    const sub = agentRecord({ lineage: { type: 'Subagent', parent: AGENT_ID, parentEpoch: 0, depth: 1 } });
    const ok = new World([], { records: [recordOutput(AGENT_ID, agentRecord()), recordOutput(SUBAGENT_ID, sub)] });
    await assert.doesNotReject(buildStakeOpening(await ctxOf(ok), OPEN({ did: `did:vector:${SUBAGENT_ID}` })));
    const orphan = new World([], { records: [recordOutput(SUBAGENT_ID, sub)] });
    await assert.rejects(buildStakeOpening(await ctxOf(orphan), OPEN({ did: `did:vector:${SUBAGENT_ID}` })), /No parent record for did:vector:a3/);
    const ended = new World([], { records: [recordOutput(AGENT_ID, agentRecord({ subagentEpoch: 1 })), recordOutput(SUBAGENT_ID, sub)] });
    await assert.rejects(buildStakeOpening(await ctxOf(ended), OPEN({ did: `did:vector:${SUBAGENT_ID}` })), /is Revoked over the validity window/);
  });
  test('refuses an agent that has a stake (one stake for each agent), naming the stake and the increase tool, and one that has an opening output, naming it', async () => {
    const { world, create } = await staked();
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ nowMs: NOW + 5 * HOUR })), new RegExp(`already has a stake, at ${create.stakeRef}.*owner cannot withdraw the module minimum.*vector_build_reputation_stake_increase`));
    const open = await opened();
    await assert.rejects(buildStakeOpening(await ctxOf(open.world), OPEN()), new RegExp(`An opening output that names ${DID} is already at the reputation address\\. Step 2 \\(vector_build_reputation_stake\\) can spend any of them with any owner key that the record declares.*allow_second_opening.* Listed \\(at most 5, the ones whose owner the record declares first\\): ${open.openingRef} \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\)\\. Nothing was built\\.$`));
  });
  test('refuses a stake below the module minimum, and a wallet that cannot pay the opening output, the stake and the fees of both steps', async () => {
    const world = new World();
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ stakeLovelace: 9_999_999n })), /The stake must be at least 10\.000000 AP3X, the module's min_self_stake/);
    const poor = new World([], { wallet: WALLET_UTXOS.filter((u) => u.assets.lovelace === 5_000_000n || u.assets.lovelace === 2_000_000n) });
    await assert.rejects(buildStakeOpening(await ctxOf(poor), OPEN()), /The wallet can spend 5\.103600 AP3X, besides 1\.896400 AP3X that its outputs with tokens must keep; a stake needs 13\.500000 AP3X: the opening output of 2\.000000 AP3X, the stake of 10\.000000 AP3X and about 1\.500000 AP3X of fees for the two steps/);
    const enough = new World([], { wallet: [{ txHash: 'd1'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 14_000_000n } }, WALLET_UTXOS[1]] });
    await assert.doesNotReject(buildStakeOpening(await ctxOf(enough), OPEN()));
    const need = new World([], { wallet: [{ txHash: 'd1'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 100_000_000n } }, WALLET_UTXOS[1]] });
    await assert.rejects(buildStakeOpening(await ctxOf(need), OPEN({ stakeLovelace: AP3X(200) })), /a stake needs 203\.500000 AP3X/);
  });
  test('assertMeansForStake counts the lovelace that an output with tokens must keep, at the ledger minimum for its tokens', () => {
    const six = WALLET_UTXOS[3];
    assert.throws(() => assertMeansForStake([six], 2_000_000n, 10_000_000n, 4310n), /can spend 0\.\d+ AP3X, besides 1\.8\d+ AP3X/);
    assert.doesNotThrow(() => assertMeansForStake([{ ...six, assets: { ...six.assets, lovelace: 60_000_000n } }], 2_000_000n, 10_000_000n, 4310n));
  });
  test('a wallet whose lovelace sits in outputs with six 32-byte-name tokens builds the opening and the stake: the change keeps the tokens\' minimum', async () => {
    const tokenWallet: UTxO[] = [
      { ...WALLET_UTXOS[3], txHash: 'd2'.repeat(32), outputIndex: 0, assets: { ...WALLET_UTXOS[3].assets, lovelace: 20_000_000n } },
      WALLET_UTXOS[1],
    ];
    const world = new World([], { wallet: tokenWallet });
    const open = await buildStakeOpening(await ctxOf(world), OPEN());
    world.apply(open.txCbor);
    const r = await buildStakeCreate(await ctxOf(world), CREATE(open.openingRef));
    const change = outputsOf(r.txCbor).filter((u) => u.address === WALLET_ADDRESS);
    assert.ok(change.some((u) => Object.keys(u.assets).length > 1), 'the tokens are in a change output');
    assert.ok(change.every((u) => u.assets.lovelace >= 1_000_000n));
  });
  test('refuses a wallet that is not the one that Lucid is bound to, and one with no pure 5 AP3X output', async () => {
    const world = new World();
    const ctx = await ctxOf(world);
    await assert.rejects(buildStakeOpening(ctx, OPEN({ changeAddress: credentialToAddress('Mainnet', { type: 'Key', hash: STRANGER.keyHash }) })), /changeAddress is not the address this wallet is bound to/);
    const noCollateral = new World([], { wallet: [{ txHash: 'd3'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 4_000_000n } }, { ...WALLET_UTXOS[3], txHash: 'd4'.repeat(32), assets: { ...WALLET_UTXOS[3].assets, lovelace: 400_000_000n } }] });
    await assert.rejects(buildStakeOpening(await ctxOf(noCollateral), OPEN()), /Collateral required: the wallet must hold one pure AP3X output of at least 5 AP3X/);
  });
  test('planStakeOpening locks the ledger minimum of the output when a long capability list makes it more than 2 AP3X', async () => {
    const long = Array.from({ length: 16 }, (_, i) => `demo.long.capability.${i.toString().padStart(2, '0')}.${'x'.repeat(30)}`);
    const record = agentRecord({ capabilities: long.map(utf8Hex) });
    const world = new World([], { records: [recordOutput(AGENT_ID, record)] });
    const open = await buildStakeOpening(await ctxOf(world), OPEN({ capabilities: long }));
    assert.ok(open.lovelace > STAKE_OPENING_LOVELACE, 'the datum needs more than 2 AP3X');
    const chain = await recordWithAncestors(world.provider(), REAL_IDENTITY, AGENT_ID);
    const planWith = (minimum: bigint) => planStakeOpening({ chain, did: DID, ownerKeyHash: WALLET.keyHash, capabilities: long, window: windowAt(NOW), minimumLovelace: () => minimum });
    assert.equal(planWith(1_000_000n).lovelace, STAKE_OPENING_LOVELACE, 'a small minimum leaves the SDK\'s 2 AP3X');
    assert.equal(planWith(3_700_000n).lovelace, 3_700_000n, 'a large minimum is the amount to lock');
  });
});

describe('buildStakeCreate refusals, before anything is built', () => {
  test('refuses an opening output that is not confirmed, is elsewhere, holds tokens, has no datum or a datum that is not a stake datum, or names another agent', async () => {
    const { world, openingRef } = await opened();
    const call = (ref: string, w = world) => ctxOf(w).then((ctx) => buildStakeCreate(ctx, CREATE(ref)));
    await assert.rejects(call(`${'cc'.repeat(32)}#0`), /does not list .* as unspent: the step 1 transaction has not confirmed yet \(run vector_await_transaction first\)/);
    await assert.rejects(call(`${'f2'.repeat(32)}#1`), /is not at the reputation address; pass the opening_ref that vector_build_reputation_stake_open returned/);
    await assert.rejects(call('not-a-ref'), /Invalid out ref/);
    const opening = world.at(openingRef);
    const tokens = { ...opening, txHash: 'c1'.repeat(32), assets: { ...opening.assets, [`${'11'.repeat(28)}74`]: 1n } };
    await assert.rejects(call(`${tokens.txHash}#0`, new World([tokens])), /holds tokens, so it is a stake or a bonus of the module, not an opening output/);
    const bare = { ...opening, txHash: 'c2'.repeat(32), datum: undefined };
    await assert.rejects(call(`${bare.txHash}#0`, new World([bare])), /has no inline datum, so it is not an opening output/);
    const junk = { ...opening, txHash: 'c3'.repeat(32), datum: Data.to(new Constr(0, [1n])) };
    await assert.rejects(call(`${junk.txHash}#0`, new World([junk])), /is not an opening output \(not a stake datum/);
    const other = { ...opening, txHash: 'c4'.repeat(32), datum: encodeStakeDatum({ ...decodeStakeDatum(opening.datum!), agent_did: AGENT2_ID }) };
    await assert.rejects(call(`${other.txHash}#0`, new World([other])), new RegExp(`names another agent \\(did:vector:${AGENT2_ID}\\), not ${DID}; make one for this agent with vector_build_reputation_stake_open`));
  });
  test('refuses a stake below the module minimum, names the minimum, and accepts the minimum and more', async () => {
    const { world, openingRef } = await opened();
    await assert.rejects(ctxOf(world).then((ctx) => buildStakeCreate(ctx, CREATE(openingRef, { amountLovelace: 9_999_999n }))), /The stake must be at least 10\.000000 AP3X, the module's min_self_stake \(validate_create_stake rule 4\); 9\.999999 AP3X is less/);
    const big = await buildStakeCreate(await ctxOf(world), CREATE(openingRef, { amountLovelace: AP3X(40) }));
    assert.equal(big.stakeLovelace, AP3X(40));
    assert.equal(stakeOutput(big.txCbor, UNIT).datum.stake_amount, AP3X(40));
  });
  test('refuses a capability that the record does not list, and an owner_key_hash that the record does not declare', async () => {
    const { world, openingRef } = await opened();
    const call = (over: Record<string, unknown>) => ctxOf(world).then((ctx) => buildStakeCreate(ctx, CREATE(openingRef, over)));
    await assert.rejects(call({ capabilities: ['demo.unknown.v1'] }), /Capability demo.unknown.v1 is not in the record of/);
    await assert.rejects(call({ ownerKeyHash: STRANGER.keyHash }), new RegExp(`The owner key ${STRANGER.keyHash} is not a declared key of ${DID}: it is neither the controller key nor a key that the record lists with the transaction purpose\\. Pass owner_key_hash with the controller key or with a key that the record lists with the transaction purpose\\. Nothing was built\\.$`));
  });
  test('the owner of the stake is owner_key_hash, else the owner that the opening output names: a declared owner that differs from the opening is built, and the build reports both', async () => {
    const world = new World();
    const open = await buildStakeOpening(await ctxOf(world), OPEN({ did: DID2, ownerKeyHash: LISTED.keyHash, stakeLovelace: AP3X(25) }));
    assert.equal(open.stakeLovelace, AP3X(25), 'step 1 reports the amount that it checked the wallet for');
    world.apply(open.txCbor);
    const only = CREATE(open.openingRef, { did: DID2 });
    const byDefault = await buildStakeCreate(await ctxOf(world), only);
    assert.equal(byDefault.ownerKeyHash, LISTED.keyHash, 'no owner_key_hash: the opening output names the owner');
    assert.equal(byDefault.openingOwnerKeyHash, LISTED.keyHash);
    assert.equal(stakeOutput(byDefault.txCbor, UNIT2).datum.owner_pkh, LISTED.keyHash);
    assert.equal(byDefault.stakeLovelace, AP3X(10), 'the module minimum is the default amount');
    assert.deepEqual(byDefault.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, LISTED.keyHash, WALLET.keyHash]);
    const same = await buildStakeCreate(await ctxOf(world), { ...only, ownerKeyHash: LISTED.keyHash.toUpperCase() });
    assert.equal(same.ownerKeyHash, LISTED.keyHash, 'the same key is accepted, in either case');
    // The validator reads the owner of the stake, not the owner in the opening output: another declared key builds.
    const other = await buildStakeCreate(await ctxOf(world), { ...only, ownerKeyHash: CONTROLLER.keyHash });
    assert.equal(other.ownerKeyHash, CONTROLLER.keyHash);
    assert.equal(other.openingOwnerKeyHash, LISTED.keyHash);
    assert.equal(stakeOutput(other.txCbor, UNIT2).datum.owner_pkh, CONTROLLER.keyHash);
    assert.deepEqual(other.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, WALLET.keyHash], 'the controller is the owner too: it signs once');
    assert.equal(other.stakeId, open.openingRef, 'the same opening output is the seed');
  });
  test('refuses an agent that already has a stake, naming it and the increase tool', async () => {
    const { world, create } = await staked();
    await assert.rejects(ctxOf(world).then((ctx) => buildStakeCreate(ctx, CREATE(`${'aa'.repeat(32)}#0`, { nowMs: NOW + 5 * HOUR }))), new RegExp(`already has a stake, at ${create.stakeRef}.*vector_build_reputation_stake_increase`));
  });
  test('an agent that has a stake and an opening output: both refusals name the opening output and say that only a CreateStake spends it', async () => {
    const { world, create } = await staked();
    const stray = (byte: string, owner = WALLET.keyHash): UTxO => ({
      txHash: byte.repeat(32), outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 2_000_000n },
      datum: encodeStakeDatum({ ...decodeStakeDatum(world.at(create.stakeRef).datum!), owner_pkh: owner, stake_amount: 2_000_000n, stake_id: { txHash: '00'.repeat(32), outputIndex: 0 } }),
    });
    const refuse = (call: (ctx: Ctx) => Promise<unknown>) => ctxOf(world).then(call);
    const open = (ctx: Ctx) => buildStakeOpening(ctx, OPEN({ nowMs: NOW + 5 * HOUR }));
    const createWith = (ctx: Ctx) => buildStakeCreate(ctx, CREATE(`${'a8'.repeat(32)}#0`, { nowMs: NOW + 5 * HOUR }));
    const listed = 'Listed \\(at most 5, the ones whose owner the record declares first\\)';
    await assert.rejects(refuse(open), (err: Error) => /already has a stake/.test(err.message) && !/opening output/.test(err.message), 'an agent with no opening output: none is named');
    world.utxos.push(stray('a8'));
    const one = new RegExp(`already has a stake, at ${create.stakeRef}\\..*vector_build_reputation_stake_update_capabilities\\. An opening output that names the agent is also at the reputation address\\. Only a CreateStake can spend an opening output, and these tools make no second stake for an agent\\. ${listed}: ${'a8'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\)\\. Nothing was built\\.$`);
    await assert.rejects(refuse(open), one);
    await assert.rejects(refuse(createWith), one);
    // An output of a stranger's key comes first in the node's order, and last in the list: the declared owners go first.
    world.utxos.unshift(stray('a6', STRANGER.keyHash));
    world.utxos.push(stray('a7'));
    const three = new RegExp(`3 opening outputs that name the agent are also at the reputation address\\..*${listed}: ${'a8'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\), ${'a7'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\), ${'a6'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${STRANGER.keyHash}\\)\\. Nothing was built\\.$`);
    await assert.rejects(refuse(open), three);
    await assert.rejects(refuse(createWith), three);
    // An opening output of another agent is not named.
    const other = world.at(`${'a7'.repeat(32)}#0`);
    world.replace(`${'a7'.repeat(32)}#0`, { ...other, datum: encodeStakeDatum({ ...decodeStakeDatum(other.datum!), agent_did: AGENT2_ID }) });
    await assert.rejects(refuse(open), new RegExp(`2 opening outputs that name the agent are also at the reputation address\\..*${listed}: ${'a8'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\), ${'a6'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${STRANGER.keyHash}\\)\\. Nothing was built\\.$`));
  });
  test('an agent that has a stake and more than 5 opening outputs: the refusal lists 5 and counts the rest', async () => {
    const { world, create } = await staked();
    const datum = decodeStakeDatum(world.at(create.stakeRef).datum!);
    const base = [...world.utxos];
    const strays = Array.from({ length: 7 }, (_, i): UTxO => ({
      txHash: `a${i}`.repeat(32), outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 2_000_000n },
      datum: encodeStakeDatum({ ...datum, stake_amount: 2_000_000n, stake_id: { txHash: '00'.repeat(32), outputIndex: 0 } }),
    }));
    const entry = (u: UTxO) => `${u.txHash}#0 (2.000000 AP3X, owner ${WALLET.keyHash})`;
    const refusal = async (count: number): Promise<string> => {
      world.utxos = [...base, ...strays.slice(0, count)];
      return ctxOf(world).then((ctx) => buildStakeOpening(ctx, OPEN({ nowMs: NOW + 5 * HOUR }))).then(() => assert.fail('the build must refuse'), (err: Error) => err.message);
    };
    const listed = (count: number) => `Listed (at most 5, the ones whose owner the record declares first): ${strays.slice(0, Math.min(count, 5)).map(entry).join(', ')}`;
    assert.ok((await refusal(5)).includes(`5 opening outputs that name the agent are also at the reputation address. Only a CreateStake can spend an opening output, and these tools make no second stake for an agent. ${listed(5)}. Nothing was built.`), 'five are all listed, and there is no rest');
    const six = await refusal(6);
    assert.ok(six.includes(`6 opening outputs that name the agent are also at the reputation address.`), six);
    assert.ok(six.includes(`${listed(6)} and 1 more. Nothing was built.`), six);
    const seven = await refusal(7);
    assert.ok(seven.includes(`7 opening outputs that name the agent are also at the reputation address.`), seven);
    assert.ok(seven.includes(`${listed(7)} and 2 more. Nothing was built.`), seven);
    assert.ok(!seven.includes(strays[5].txHash) && !seven.includes(strays[6].txHash), 'the last two are counted, not listed');
  });
  test('a window above 59 minutes is refused by windowAt', async () => {
    const { world, openingRef } = await opened();
    await assert.rejects(ctxOf(world).then((ctx) => buildStakeCreate(ctx, CREATE(openingRef, { validMinutes: 60 }))), /valid_minutes must be a whole number from 1 to 59/);
    const r = await buildStakeCreate(await ctxOf(world), CREATE(openingRef, { validMinutes: 59 }));
    assert.equal(r.validTo - r.validFrom, 59 * 60_000 + 60_000);
    const short = await buildStakeCreate(await ctxOf(world), CREATE(openingRef, { validMinutes: 1 }));
    assert.equal(short.lastUpdated, short.validTo);
  });
});

// ─── The module outputs ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('readModuleReferences: the module outputs are found and checked as the validator does', () => {
  const read = (world: World) => readModuleReferences(world.provider());
  const paramsUnit = `${REPUTATION_PARAMS_TOKEN_POLICY}${PARAMS_TOKEN_NAME}`;
  const refsUnit = `${REPUTATION_REFS_TOKEN_POLICY}${REFS_TOKEN_NAME}`;
  const noOutput = (unit: string, what: string) => new RegExp(`The node lists no output at the params holder ${REPUTATION_PARAMS_HOLDER_ADDRESS} that holds the token ${unit}, the record token of the reputation module's ${what}\\. Nothing was built\\.`);
  /** The parameters datum with another minimum: the first of its 22 fields. */
  const paramsDatum = (minSelfStake: bigint) => Data.to(new Constr(0, [minSelfStake, ...(Data.from(PARAMS_UTXO.datum!) as Constr<Data>).fields.slice(1)]));
  const replacing = (real: UTxO, change: Partial<UTxO>) => new World().replace(`${real.txHash}#0`, { ...real, ...change });

  test('reads the script, the parameters and the cross references', async () => {
    const refs = await read(new World());
    assert.equal(refs.stakeParams.minSelfStake, 10_000_000n);
    assert.equal(refs.stakeParams.stakeCooldown, 86_400_000n);
    assert.ok(refs.script.scriptRef);
    assert.equal(refs.params.txHash, PARAMS_UTXO.txHash);
    assert.equal(refs.crossRefs.txHash, CROSS_REFS_UTXO.txHash);
  });
  test('the reference script is pinned by its output reference: when it is not on the ledger, the refusal says that a new release of the server is needed', async () => {
    const gone = new World();
    gone.utxos = gone.utxos.filter((x) => x.txHash !== REPUTATION_REF_UTXO.txHash);
    await assert.rejects(read(gone), new RegExp(`The reputation module's reference script ${REPUTATION_REF_UTXO.txHash}#0 is not on the ledger\\. This server pins that output by its reference, so it needs a new release when the module publishes the script again\\. Nothing was built\\.`));
  });
  test('refuses a script output that carries another script', async () => {
    await assert.rejects(read(replacing(REPUTATION_REF_UTXO, { scriptRef: { type: 'PlutusV3', script: '450101002499' } })), /does not carry the reputation validator/);
    await assert.rejects(read(replacing(REPUTATION_REF_UTXO, { scriptRef: undefined })), /does not carry the reputation validator/);
  });
  test('the parameters are found by their token at the holder: an output that the holder publishes anew with the token is used at once', async () => {
    const republished: UTxO = { ...PARAMS_UTXO, txHash: 'e1'.repeat(32), datum: paramsDatum(12_000_000n) };
    const refs = await read(new World().replace(`${PARAMS_UTXO.txHash}#0`, republished));
    assert.equal(refs.params.txHash, republished.txHash, 'the new output, not the output of the deployment');
    assert.equal(refs.stakeParams.minSelfStake, 12_000_000n);
  });
  test('an output at the holder address without the token is never used, so a look-alike cannot give other parameters', async () => {
    const lookAlike: UTxO = { ...PARAMS_UTXO, txHash: 'e2'.repeat(32), assets: { lovelace: 3_000_000n }, datum: paramsDatum(1n) };
    const refs = await read(new World([lookAlike]));
    assert.equal(refs.params.txHash, PARAMS_UTXO.txHash, 'the output with the token is used');
    assert.equal(refs.stakeParams.minSelfStake, 10_000_000n);
    const alone = new World([lookAlike]);
    alone.utxos = alone.utxos.filter((x) => x.txHash !== PARAMS_UTXO.txHash);
    await assert.rejects(read(alone), noOutput(paramsUnit, 'parameters'));
  });
  test('an output that holds the token but is not the record is not used: it is at another address, or holds another token, or holds two', async () => {
    for (const change of [
      { address: WALLET_ADDRESS },
      { assets: { lovelace: 3_000_000n, [`${'99'.repeat(28)}${PARAMS_TOKEN_NAME}`]: 1n } },
      { assets: { lovelace: 3_000_000n, [paramsUnit]: 2n } },
    ] as Array<Partial<UTxO>>) {
      await assert.rejects(read(replacing(PARAMS_UTXO, change)), noOutput(paramsUnit, 'parameters'), JSON.stringify(Object.keys(change)));
    }
  });
  test('Koios names the output of a token and the node must confirm it as the record: a hint at another address is ignored, and the holder address decides', async () => {
    const world = new World();
    const elsewhere: UTxO = { ...PARAMS_UTXO, txHash: 'e5'.repeat(32), address: WALLET_ADDRESS, datum: paramsDatum(1n) }; // holds the token, but not at the holder
    world.utxos.push(elsewhere);
    const hinted = (hint: UTxO) => Object.assign(world.provider(), { getUtxoByUnit: async () => hint });
    const refs = await readModuleReferences(hinted(elsewhere));
    assert.equal(refs.params.txHash, PARAMS_UTXO.txHash, 'the hint at another address is not used');
    assert.equal(refs.stakeParams.minSelfStake, 10_000_000n);
    assert.equal((await readModuleReferences(hinted(PARAMS_UTXO))).params.txHash, PARAMS_UTXO.txHash, 'a hint that the node confirms is used');
  });
  test('a parameters output with no datum, or with a datum of another layout, is refused', async () => {
    await assert.rejects(read(replacing(PARAMS_UTXO, { datum: undefined })), /The parameters output .* has no inline datum; nothing was built/);
    await assert.rejects(read(replacing(PARAMS_UTXO, { datum: Data.to(new Constr(0, [1n, 2n])) })), /could not be read \(not the module parameters datum.*\); nothing was built/);
  });
  test('the cross references are found by their token too: a republished output is used, and a look-alike without the token is not', async () => {
    const republished: UTxO = { ...CROSS_REFS_UTXO, txHash: 'e3'.repeat(32) };
    assert.equal((await read(new World().replace(`${CROSS_REFS_UTXO.txHash}#0`, republished))).crossRefs.txHash, republished.txHash);
    const lookAlike: UTxO = { ...CROSS_REFS_UTXO, txHash: 'e4'.repeat(32), assets: { lovelace: 3_000_000n }, datum: Data.to(new Constr(0, ['ab'.repeat(28), 'cd'.repeat(28)])) };
    assert.equal((await read(new World([lookAlike]))).crossRefs.txHash, CROSS_REFS_UTXO.txHash, 'the output with the token is used');
    const alone = new World([lookAlike]);
    alone.utxos = alone.utxos.filter((x) => x.txHash !== CROSS_REFS_UTXO.txHash);
    await assert.rejects(read(alone), noOutput(refsUnit, 'cross-validator references'));
    await assert.rejects(read(replacing(CROSS_REFS_UTXO, { address: WALLET_ADDRESS })), noOutput(refsUnit, 'cross-validator references'));
  });
  test('refuses cross references that name another reputation or endorsement validator, or that have no datum', async () => {
    const named = /The cross-validator references at .* do not name this deployment's reputation and endorsement validators; nothing was built/;
    await assert.rejects(read(replacing(CROSS_REFS_UTXO, { datum: Data.to(new Constr(0, ['ab'.repeat(28), '21ac1502ba7bab74e98ef3ad256bba1622a1351934ac19d0432126fe'])) })), named);
    await assert.rejects(read(replacing(CROSS_REFS_UTXO, { datum: Data.to(new Constr(0, [REPUTATION_SCRIPT_HASH, 'ab'.repeat(28)])) })), named);
    await assert.rejects(read(replacing(CROSS_REFS_UTXO, { datum: undefined })), named);
  });
  test('a node that fails is a refusal that names the failure, not the endpoint', async () => {
    const down = (method: 'getUtxosByOutRef' | 'getUtxos') => Object.assign(new World().provider(), { [method]: async () => { throw new Error('connect ECONNREFUSED https://ogmios.internal.example'); } });
    const quiet = (what: RegExp) => (err: Error) => what.test(err.message) && !err.message.includes('ogmios.internal.example');
    await assert.rejects(readModuleReferences(down('getUtxosByOutRef')), quiet(/Could not read the reputation module's reference script from the node/));
    await assert.rejects(readModuleReferences(down('getUtxos')), quiet(/Could not read the reputation module's parameters from the node/));
  });
});

// ─── IncreaseStake ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('IncreaseStake: refusals, and the validator\'s verdict on each rule', () => {
  test('refuses what the rules refuse: no stake, an amount of 0, a stake_ref that is not a stake of the agent', async () => {
    const world = new World();
    await assert.rejects(buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: AP3X(1), nowMs: NOW }), new RegExp(`${DID} has no stake on the Module-3 reputation deployment. Make one with vector_build_reputation_stake_open and vector_build_reputation_stake`));
    const { world: w2 } = await staked();
    await assert.rejects(buildStakeIncrease(await ctxOf(w2), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: 0n, nowMs: NOW + HOUR }), /The amount to add must be more than 0/);
    await assert.rejects(buildStakeIncrease(await ctxOf(w2), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: -1n, nowMs: NOW + HOUR }), /The amount to add must be more than 0/);
    await assert.rejects(buildStakeIncrease(await ctxOf(w2), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: 1n, stakeRef: `${'ab'.repeat(32)}#0`, nowMs: NOW + HOUR }), new RegExp(`${'ab'.repeat(32)}#0 is not a stake of ${DID}; its stakes: `));
    const none = await buildStakeIncrease(await ctxOf(w2), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: 1n, nowMs: NOW + HOUR });
    assert.equal(none.stakeAmount, 10_000_001n, 'one lovelace more is a larger stake');
  });
  test('needs no cooldown: it builds right after the stake was made', async () => {
    const { world, create } = await staked();
    const r = await buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: AP3X(2), nowMs: NOW + 5 * 60_000 });
    assert.equal(r.previousRef, create.stakeRef);
    assert.ok(r.validFrom < create.lastUpdated, 'the lower bound is before the last_updated of the stake');
  });
  test('refuses a record that no longer lists a capability that the stake backs, and points at the capability update', async () => {
    const { world } = await staked();
    const stripped = agentRecord({ capabilities: [CAPABILITIES[0], CAPABILITIES[2]].map(utf8Hex) });
    world.replace(`${world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT_ID}`] === 1n)!.txHash}#0`, recordOutput(AGENT_ID, stripped));
    await assert.rejects(buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: AP3X(1), nowMs: NOW + HOUR }), /no longer lists demo.text.summary.v1, which the stake backs\. IncreaseStake needs a record that lists each staked capability \(validate_increase_stake rule 4\): change the staked capabilities first with vector_build_reputation_stake_update_capabilities/);
  });
  test('refuses an agent whose record is not Active over the window', async () => {
    const { world } = await staked();
    const hold = agentRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: NOW - DAY, until: NOW + 3 * DAY }] } });
    world.replace(`${world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT_ID}`] === 1n)!.txHash}#0`, recordOutput(AGENT_ID, hold));
    await assert.rejects(buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: AP3X(1), nowMs: NOW + HOUR }), /is Suspended over the validity window/);
  });
  test('names the stake with stake_ref when the agent has more than one; the build refuses without it', async () => {
    const { world, create } = await staked();
    const stake = world.at(create.stakeRef);
    const second: UTxO = { ...stake, txHash: 'b2'.repeat(32), outputIndex: 0, datum: encodeStakeDatum({ ...decodeStakeDatum(stake.datum!), stake_id: { txHash: 'b1'.repeat(32), outputIndex: 3 }, stake_amount: 11_000_000n }), assets: { ...stake.assets, lovelace: 11_000_000n } };
    world.utxos.push(second);
    await assert.rejects(buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: AP3X(1), nowMs: NOW + HOUR }), new RegExp(`${DID} has 2 stakes \\(.*\\); name the one to use in stake_ref`));
    const r = await buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: AP3X(1), stakeRef: `${second.txHash}#0`, nowMs: NOW + HOUR });
    assert.equal(r.previousRef, `${second.txHash}#0`);
    assert.equal(r.stakeAmount, 12_000_000n);
    assert.deepEqual(r.stakeId, `${'b1'.repeat(32)}#3`);
  });

  /** An IncreaseStake past the builder's checks, with the datum and signers that the caller gives. */
  async function increaseKit() {
    const { world, create } = await staked();
    const ctx = await ctxOf(world);
    await assertVectorMainnet(ctx.provider);
    const chain = await recordWithAncestors(ctx.provider, REAL_IDENTITY, AGENT_ID);
    const refs = await readModuleReferences(ctx.provider);
    const stake = { utxo: world.at(create.stakeRef), datum: decodeStakeDatum(world.at(create.stakeRef).datum!), ref: create.stakeRef };
    const window = windowAt(NOW + 3 * HOUR);
    const plan = planStakeIncrease({ chain, did: DID, stake, addLovelace: AP3X(2), window });
    const assemble = (over: Partial<{ plan: typeof plan; signerKeyHashes: string[]; records: UTxO[] }> = {}) => assembleStakeIncrease(ctx.lucid, {
      refs, records: over.records ?? chain.map((r) => r.utxo), stake: stake.utxo, plan: over.plan ?? plan, signerKeyHashes: over.signerKeyHashes ?? [WALLET.keyHash],
    });
    const withDatum = (changes: Partial<StakeDatum>, lovelace?: bigint) => {
      const datum = { ...plan.datum, ...changes };
      return { ...plan, datum, datumHex: encodeStakeDatum(datum), lovelace: lovelace ?? plan.lovelace };
    };
    return { plan, window, assemble, withDatum, chain, stake };
  }
  test('verdict: the plan is accepted; a stake_amount that does not grow, the lower bound as last_updated, and another change in the datum are rejected', async () => {
    const k = await increaseKit();
    await assert.doesNotReject(k.assemble());
    await assert.rejects(k.assemble({ plan: k.withDatum({ stake_amount: k.stake.datum.stake_amount }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ stake_amount: k.stake.datum.stake_amount - 1n }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ last_updated: k.window.lo }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ staked_capabilities: [utf8Hex(CAPABILITIES[2])] }) }), REJECTED, 'the capabilities stay');
    await assert.rejects(k.assemble({ plan: k.withDatum({ history_points: 5n }) }), REJECTED);
    await assert.rejects(k.assemble({ plan: k.withDatum({ owner_pkh: LISTED.keyHash }) }), REJECTED, 'the owner stays');
  });
  test('verdict: the output must hold the AP3X that the datum counts, and the signers are the owner and the controller', async () => {
    const k = await increaseKit();
    await assert.rejects(k.assemble({ plan: k.withDatum({}, 11_999_999n) }), REJECTED, 'less than stake_amount in the output');
    await assert.doesNotReject(k.assemble({ plan: k.withDatum({}, 13_000_000n) }), 'more is fine');
    await assert.rejects(k.assemble({ signerKeyHashes: [] }), REJECTED);
    await assert.rejects(k.assemble({ signerKeyHashes: [STRANGER.keyHash] }), REJECTED);
  });
  test('verdict: a record that does not list a staked capability, and one that is not Active, are rejected', async () => {
    const k = await increaseKit();
    const stripped = recordOutput(AGENT_ID, agentRecord({ capabilities: [utf8Hex(CAPABILITIES[0])] }));
    await assert.rejects(k.assemble({ records: [stripped] }), REJECTED);
    const hold = recordOutput(AGENT_ID, agentRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: NOW - DAY, until: NOW + 5 * DAY }] } }));
    await assert.rejects(k.assemble({ records: [hold] }), REJECTED);
  });
  test('the owner of the stake signs, and the controller too, when they are different keys', async () => {
    const world = new World();
    const open = await buildStakeOpening(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: LISTED.keyHash, nowMs: NOW });
    world.apply(open.txCbor);
    const created = await buildStakeCreate(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, openingRef: open.openingRef, ownerKeyHash: LISTED.keyHash, nowMs: NOW + 60_000 });
    world.apply(created.txCbor);
    const ctx = await ctxOf(world);
    await assertVectorMainnet(ctx.provider);
    const chain = await recordWithAncestors(ctx.provider, REAL_IDENTITY, AGENT2_ID);
    const refs = await readModuleReferences(ctx.provider);
    const stake = { utxo: world.at(created.stakeRef), datum: decodeStakeDatum(world.at(created.stakeRef).datum!), ref: created.stakeRef };
    const plan = planStakeIncrease({ chain, did: DID2, stake, addLovelace: AP3X(1), window: windowAt(NOW + 2 * HOUR) });
    const build = (signerKeyHashes: string[]) => assembleStakeIncrease(ctx.lucid, { refs, records: chain.map((r) => r.utxo), stake: stake.utxo, plan, signerKeyHashes });
    await assert.doesNotReject(build([CONTROLLER.keyHash, LISTED.keyHash]));
    await assert.rejects(build([CONTROLLER.keyHash]), REJECTED, 'the owner must sign');
    await assert.rejects(build([LISTED.keyHash]), REJECTED, 'the controller must sign');
    await assert.rejects(build([WALLET.keyHash]), REJECTED);
    assert.ok(UNIT2);
  });
});

// ─── UpdateCapabilities ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('UpdateCapabilities: the cooldown, the locks, the capabilities, and the validator\'s verdict', () => {
  test('refuses before the cooldown ends, naming the time to build again, and builds from that time on', async () => {
    const { world, create } = await staked();
    const call = (nowMs: number) => ctxOf(world).then((ctx) => buildStakeCapabilities(ctx, { changeAddress: WALLET_ADDRESS, did: DID, capabilities: CAPABILITIES, nowMs }));
    await assert.rejects(call(create.readyAt - 2 * 60_000), new RegExp(`Too early: the stake changed at ${new Date(create.lastUpdated).toISOString().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} and its cooldown of 24 h \\(stake_cooldown\\) ends at ${new Date(create.readyAt).toISOString().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} \\(${new Date(create.readyAt).toISOString().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\)\\. Build again after that time`));
    await assert.rejects(call(create.readyAt - 1000), /Too early/);
    const exact = await call(create.readyAt);
    assert.equal(exact.validFrom, create.readyAt, 'the window starts when the cooldown ends');
    const later = await call(create.readyAt + 10 * 60_000);
    assert.equal(later.validFrom, create.readyAt + 9 * 60_000, 'a window opens a minute before now, which is after the end of the cooldown');
    const much = await call(create.readyAt + 3 * HOUR);
    assert.equal(much.validFrom, create.readyAt + 3 * HOUR - 60_000);
  });
  test('refuses an empty list, a capability that the record does not list, a repeat, and a stake that a challenge locks', async () => {
    const { world, create } = await staked();
    const call = (capabilities: unknown, w = world) => ctxOf(w).then((ctx) => buildStakeCapabilities(ctx, { changeAddress: WALLET_ADDRESS, did: DID, capabilities: capabilities as string[], nowMs: create.readyAt + 60_000 }));
    await assert.rejects(call([]), /Name at least one capability to stake on/);
    await assert.rejects(call(['demo.unknown.v1']), /Capability demo.unknown.v1 is not in the record of/);
    await assert.rejects(call([CAPABILITIES[0], CAPABILITIES[0]]), /is named twice/);
    const stake = world.at(create.stakeRef);
    const locked = { ...stake, datum: encodeStakeDatum({ ...decodeStakeDatum(stake.datum!), challenge_locks: [utf8Hex('rchl_one'), utf8Hex('rchl_two')] }) };
    const lockedWorld = new World();
    lockedWorld.utxos = world.utxos.map((u) => (u === stake ? locked : u));
    await assert.rejects(call([CAPABILITIES[0]], lockedWorld), new RegExp(`2 open challenge\\(s\\) lock the stake ${create.stakeRef}: its capabilities cannot change until they close \\(validate_update_capabilities rule 4\\)`));
    await assert.doesNotReject(call([CAPABILITIES[0]]));
  });
  test('the same list again is allowed: it only records a new last_updated', async () => {
    const { world, create } = await staked();
    const r = await buildStakeCapabilities(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, nowMs: create.readyAt + 60_000 });
    assert.deepEqual(r.capabilities, STAKE_CAPS);
    assert.ok(r.lastUpdated > create.lastUpdated);
  });
  test('refuses a record that is not Active over the window', async () => {
    const { world, create } = await staked();
    world.replace(`${world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT_ID}`] === 1n)!.txHash}#0`, recordOutput(AGENT_ID, agentRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: NOW - DAY, until: create.readyAt + 5 * DAY }] } })));
    await assert.rejects(buildStakeCapabilities(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, nowMs: create.readyAt + 60_000 }), /is Suspended over the validity window/);
  });

  /**
   * The kit for the update of the stake of the first agent (the wallet is its controller and its owner) or, with `second`, of the second
   * agent (its controller and its owner are two keys, and neither is the wallet). A locked stake has a challenge lock: the planner refuses
   * it, so the plan is made on the stake without the lock and the planned output gets the lock back. The datum rule then holds, and only
   * the lock rule can fail.
   */
  async function capsKit(opts: { locked?: boolean; second?: boolean } = {}) {
    const did = opts.second ? DID2 : DID;
    const { world, create } = opts.second ? await stakedSecond() : await staked();
    if (opts.locked) {
      const held = world.at(create.stakeRef);
      world.replace(create.stakeRef, { ...held, datum: encodeStakeDatum({ ...decodeStakeDatum(held.datum!), challenge_locks: [utf8Hex('rchl_one')] }) });
    }
    const ctx = await ctxOf(world);
    await assertVectorMainnet(ctx.provider);
    const chain = await recordWithAncestors(ctx.provider, REAL_IDENTITY, opts.second ? AGENT2_ID : AGENT_ID);
    const refs = await readModuleReferences(ctx.provider);
    const utxo = world.at(create.stakeRef);
    const stake = { utxo, datum: decodeStakeDatum(utxo.datum!), ref: create.stakeRef };
    const planAt = (lo: number, capabilities: string[] = [CAPABILITIES[0]]) => {
      const window = { lo, hi: lo + 30 * 60_000 };
      const plan = planStakeCapabilities({ chain, did, stake: { ...stake, datum: { ...stake.datum, challenge_locks: [] } }, capabilities, window });
      const datum = { ...plan.datum, challenge_locks: stake.datum.challenge_locks };
      return { window, plan: { ...plan, datum, datumHex: encodeStakeDatum(datum) } };
    };
    const signers = opts.second ? [CONTROLLER.keyHash, LISTED.keyHash] : [WALLET.keyHash];
    const assemble = (plan: ReturnType<typeof planAt>['plan'], signerKeyHashes = signers, records = chain.map((r) => r.utxo)) => assembleStakeCapabilities(ctx.lucid, { refs, records, stake: utxo, plan, signerKeyHashes });
    return { create, planAt, assemble, chain };
  }
  test('verdict: one millisecond of cooldown left is rejected, and the end of the cooldown is accepted', async () => {
    const k = await capsKit();
    await assert.rejects(k.assemble(k.planAt(k.create.readyAt - 1000).plan), REJECTED);
    await assert.rejects(k.assemble(k.planAt(k.create.readyAt - 60_000).plan), REJECTED);
    await assert.doesNotReject(k.assemble(k.planAt(k.create.readyAt).plan));
    await assert.doesNotReject(k.assemble(k.planAt(k.create.readyAt + HOUR).plan));
  });
  test('verdict: a capability that the record does not list, and an empty list, are rejected', async () => {
    const k = await capsKit();
    const ok = k.planAt(k.create.readyAt).plan;
    const withCaps = (staked_capabilities: string[]) => {
      const datum = { ...ok.datum, staked_capabilities };
      return { ...ok, datum, datumHex: encodeStakeDatum(datum), redeemerHex: Data.to(new Constr(3, [staked_capabilities])), capabilities: staked_capabilities };
    };
    await assert.rejects(k.assemble(withCaps([utf8Hex('demo.unknown.v1')])), REJECTED);
    await assert.rejects(k.assemble(withCaps([])), REJECTED);
    await assert.doesNotReject(k.assemble(withCaps([utf8Hex(CAPABILITIES[2])])));
  });
  test('verdict: a stake that a challenge locks cannot change its capabilities: the output keeps the lock, so only the lock rule fails, and the same plan on an unlocked stake is accepted', async () => {
    const unlocked = await capsKit();
    await assert.doesNotReject(unlocked.assemble(unlocked.planAt(unlocked.create.readyAt).plan));
    const locked = await capsKit({ locked: true });
    const plan = locked.planAt(locked.create.readyAt).plan;
    assert.deepEqual(plan.datum.challenge_locks, [utf8Hex('rchl_one')], 'the planned output keeps the lock, so the datum rule holds');
    await assert.rejects(locked.assemble(plan), REJECTED);
  });
  test('verdict: the redeemer and the datum must name the same capabilities, and the owner and the controller sign', async () => {
    const k = await capsKit();
    const ok = k.planAt(k.create.readyAt).plan;
    await assert.rejects(k.assemble({ ...ok, redeemerHex: Data.to(new Constr(3, [[utf8Hex(CAPABILITIES[1])]])) }), REJECTED);
    await assert.rejects(k.assemble(ok, []), REJECTED);
    await assert.rejects(k.assemble(ok, [STRANGER.keyHash]), REJECTED);
    await assert.doesNotReject(k.assemble(ok, [WALLET.keyHash]));
  });
  test('an owner that is not the controller: the body names the controller and the owner, and the validator rejects the controller alone and the owner alone', async () => {
    const { world, create } = await stakedSecond();
    const update = await buildStakeCapabilities(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: [CAPABILITIES[0]], nowMs: create.readyAt + 60_000 });
    assert.deepEqual(requiredSigners(update.txCbor), [CONTROLLER.keyHash, LISTED.keyHash].sort(), 'the transaction body names both keys');
    assert.deepEqual(update.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, LISTED.keyHash, WALLET.keyHash]);
    const k = await capsKit({ second: true });
    const plan = k.planAt(k.create.readyAt).plan;
    await assert.doesNotReject(k.assemble(plan));
    await assert.rejects(k.assemble(plan, [CONTROLLER.keyHash]), REJECTED, 'the controller alone');
    await assert.rejects(k.assemble(plan, [LISTED.keyHash]), REJECTED, 'the owner alone');
  });
});

// ─── DecreaseStake ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('DecreaseStake: the cooldown, the minimum that stays, the payee, and the validator\'s verdict', () => {
  test('refuses before the cooldown ends, and builds from that time on', async () => {
    const { world, create } = await staked(15);
    const call = (nowMs: number) => ctxOf(world).then((ctx) => buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, amountLovelace: AP3X(2), nowMs }));
    await assert.rejects(call(create.readyAt - 120_000), /Too early: the stake changed at .* its cooldown of 24 h \(stake_cooldown\) ends at/);
    const r = await call(create.readyAt + 30_000);
    assert.equal(r.stakeAmount, AP3X(13));
  });
  test('refuses an amount of 0, one that leaves less than the module minimum (naming the most that can be taken out), and a stake that a challenge locks', async () => {
    const { world, create } = await staked(15);
    const call = (amount: bigint, w = world) => ctxOf(w).then((ctx) => buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, amountLovelace: amount, nowMs: create.readyAt + 60_000 }));
    await assert.rejects(call(0n), /The amount to take out must be more than 0/);
    await assert.rejects(call(AP3X(5) + 1n), /The stake counts 15\.000000 AP3X; taking out 5\.000001 AP3X would leave 9\.999999 AP3X, below the module minimum of 10\.000000 AP3X \(min_self_stake\), which the owner cannot withdraw\. The most that can be taken out is 5\.000000 AP3X/);
    const all = await call(AP3X(5));
    assert.equal(all.stakeAmount, AP3X(10), 'down to the minimum');
    const stake = world.at(create.stakeRef);
    const lockedWorld = new World();
    lockedWorld.utxos = world.utxos.map((u) => (u === stake ? { ...stake, datum: encodeStakeDatum({ ...decodeStakeDatum(stake.datum!), challenge_locks: [utf8Hex('rchl_one')] }) } : u));
    await assert.rejects(call(AP3X(1), lockedWorld), new RegExp(`1 open challenge\\(s\\) lock the stake ${create.stakeRef}: it cannot decrease until they close \\(validate_decrease_stake rule 4\\)`));
  });
  test('a stake at the minimum cannot decrease at all: the most that can be taken out is 0', async () => {
    const { world, create } = await staked(10);
    await assert.rejects(ctxOf(world).then((ctx) => buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, amountLovelace: 1n, nowMs: create.readyAt + 60_000 })), /would leave 9\.999999 AP3X, below the module minimum of 10\.000000 AP3X.*The most that can be taken out is 0\.000000 AP3X/);
  });
  test('refuses a payout below the ledger minimum of an output', async () => {
    const { world, create } = await staked(15);
    await assert.rejects(ctxOf(world).then((ctx) => buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, amountLovelace: 100_000n, nowMs: create.readyAt + 60_000 })), /The payout of 0\.100000 AP3X is below the ledger minimum of an output, 0\.\d+ AP3X; take out at least that much/);
  });
  test('the payee is the owner key while the record declares it, else the controller key; the record\'s status does not matter', async () => {
    const world = new World();
    const open = await buildStakeOpening(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: LISTED.keyHash, nowMs: NOW });
    world.apply(open.txCbor);
    const created = await buildStakeCreate(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, openingRef: open.openingRef, ownerKeyHash: LISTED.keyHash, amountLovelace: AP3X(15), nowMs: NOW + 60_000 });
    world.apply(created.txCbor);
    const recordRef = `${world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT2_ID}`] === 1n)!.txHash}#0`;
    const at = created.readyAt + 60_000;
    const exit = () => ctxOf(world).then((ctx) => buildStakeDecrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID2, amountLovelace: AP3X(2), nowMs: at }));
    const declared = await exit();
    assert.deepEqual(declared.payee, { keyHash: LISTED.keyHash, reason: 'owner' });
    // The record drops the owner's key: the payee is now the controller.
    world.replace(recordRef, recordOutput(AGENT2_ID, agent2Record({ keys: [] })));
    const dropped = await exit();
    assert.deepEqual(dropped.payee, { keyHash: CONTROLLER.keyHash, reason: 'controller' });
    assert.equal(dropped.payoutAddress, credentialToAddress('Mainnet', { type: 'Key', hash: CONTROLLER.keyHash }));
    assert.equal(outputsOf(dropped.txCbor)[1].address, dropped.payoutAddress);
    // The key is listed again, but for authentication only: not declared, so the controller is paid.
    world.replace(recordRef, recordOutput(AGENT2_ID, agent2Record({ keys: [{ keyType: 'Ed25519', key: LISTED.publicKey, purposes: 1, pop: null }] })));
    assert.equal((await exit()).payee.reason, 'controller');
    // A revoked record (a tombstone with no keys, parties or capabilities): the exit still builds, paid to the controller.
    world.replace(recordRef, recordOutput(AGENT2_ID, agent2Record({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 0, at: NOW, invalidFrom: null, successor: null }, keys: [], parties: [], capabilities: [] })));
    const revoked = await exit();
    assert.deepEqual(revoked.payee, { keyHash: CONTROLLER.keyHash, reason: 'controller' });
    assert.deepEqual(revoked.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, WALLET.keyHash]);
    // A retired record likewise.
    world.replace(recordRef, recordOutput(AGENT2_ID, agent2Record({ status: { type: 'Retired', at: NOW, successor: null }, keys: [], parties: [], capabilities: [] })));
    assert.equal((await exit()).payee.reason, 'controller');
    assert.ok(keyHashOf(agent2Record().controller));
  });
  test('a subagent that was retired exits without its parent: no ancestor is read', async () => {
    const sub = agentRecord({ lineage: { type: 'Subagent', parent: AGENT_ID, parentEpoch: 0, depth: 1 } });
    const world = new World([], { records: [recordOutput(AGENT_ID, agentRecord()), recordOutput(SUBAGENT_ID, sub)] });
    const did = `did:vector:${SUBAGENT_ID}`;
    const open = await buildStakeOpening(await ctxOf(world), OPEN({ did }));
    world.apply(open.txCbor);
    const created = await buildStakeCreate(await ctxOf(world), CREATE(open.openingRef, { did, amountLovelace: AP3X(15) }));
    world.apply(created.txCbor);
    // The subagent is retired and its parent record is gone from the ledger.
    const retired = agentRecord({ lineage: sub.lineage, status: { type: 'Retired', at: NOW, successor: null }, keys: [], parties: [], capabilities: [] });
    world.utxos = world.utxos.filter((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT_ID}`] !== 1n && u.assets[`${REAL_IDENTITY.identity.hash}${SUBAGENT_ID}`] !== 1n);
    world.utxos.push(recordOutput(SUBAGENT_ID, retired));
    const r = await buildStakeDecrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did, amountLovelace: AP3X(2), nowMs: created.readyAt + 60_000 });
    assert.equal(refsOf(txOf(r.txCbor).body().reference_inputs()).length, 4, 'the script, the parameters, the cross references and the record: no parent');
    // With the parent's record back on the ledger, the other actions refuse the retired subagent by its status.
    world.utxos.push(recordOutput(AGENT_ID, agentRecord()));
    await assert.rejects(buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did, addLovelace: 1n, nowMs: created.readyAt + 60_000 }), /is Retired over the validity window/);
  });

  async function decreaseKit(opts: { stake?: number; record?: Parameters<typeof agent2Record>[0]; locked?: boolean } = {}) {
    const world = new World();
    const open = await buildStakeOpening(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: LISTED.keyHash, nowMs: NOW });
    world.apply(open.txCbor);
    const created = await buildStakeCreate(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, openingRef: open.openingRef, ownerKeyHash: LISTED.keyHash, amountLovelace: AP3X(opts.stake ?? 15), nowMs: NOW + 60_000 });
    world.apply(created.txCbor);
    if (opts.record) world.replace(`${world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${AGENT2_ID}`] === 1n)!.txHash}#0`, recordOutput(AGENT2_ID, agent2Record(opts.record)));
    if (opts.locked) {
      const held = world.at(created.stakeRef);
      world.replace(created.stakeRef, { ...held, datum: encodeStakeDatum({ ...decodeStakeDatum(held.datum!), challenge_locks: [utf8Hex('rchl_one')] }) });
    }
    const ctx = await ctxOf(world);
    await assertVectorMainnet(ctx.provider);
    const refs = await readModuleReferences(ctx.provider);
    const record = (await recordWithAncestors(ctx.provider, REAL_IDENTITY, AGENT2_ID))[0];
    const utxo = world.at(created.stakeRef);
    const stake = { utxo, datum: decodeStakeDatum(utxo.datum!), ref: created.stakeRef };
    // The planner refuses a locked stake: the plan is made on the stake without the lock, and the planned output gets the lock back, so that only the lock rule can fail.
    const planWith = (params: typeof refs.stakeParams) => (lo: number, amount = AP3X(2)) => {
      const plan = planStakeDecrease({
        record, did: DID2, stake: { ...stake, datum: { ...stake.datum, challenge_locks: [] } }, params, amountLovelace: amount, window: { lo, hi: lo + 30 * 60_000 }, walletKeyHash: WALLET.keyHash, changeAddress: WALLET_ADDRESS, payoutMinimum: () => 0n,
      });
      const datum = { ...plan.datum, challenge_locks: stake.datum.challenge_locks };
      return { ...plan, datum, datumHex: encodeStakeDatum(datum) };
    };
    const planAt = planWith(refs.stakeParams);
    /** A plan that leaves the stake as the caller says, past the builder's check of the minimum (the plan is made with a minimum of one lovelace): what the validator alone says of it. */
    const forced = planWith({ ...refs.stakeParams, minSelfStake: 1n });
    const assemble = (plan: ReturnType<typeof planAt>, signerKeyHashes = [CONTROLLER.keyHash]) => assembleStakeDecrease(ctx.lucid, { refs, records: [record.utxo], stake: utxo, plan, signerKeyHashes });
    return { created, planAt, forced, assemble };
  }
  test('verdict: the cooldown must be over at the lower bound', async () => {
    const k = await decreaseKit();
    await assert.rejects(k.assemble(k.planAt(k.created.readyAt - 1000)), REJECTED);
    await assert.doesNotReject(k.assemble(k.planAt(k.created.readyAt)));
  });
  test('verdict: at least the minimum stays: a stake of 10 AP3X cannot decrease by 1 lovelace, a stake of 15 can decrease by 5', async () => {
    const k = await decreaseKit();
    await assert.doesNotReject(k.assemble(k.forced(k.created.readyAt, AP3X(5))));
    await assert.rejects(k.assemble(k.forced(k.created.readyAt, AP3X(5) + 1n)), REJECTED);
    const min = await decreaseKit({ stake: 10 });
    await assert.rejects(min.assemble(min.forced(min.created.readyAt, 1_000_000n)), REJECTED);
  });
  test('verdict: the controller signs, and the owner key need not', async () => {
    const k = await decreaseKit();
    const plan = k.planAt(k.created.readyAt);
    await assert.doesNotReject(k.assemble(plan, [CONTROLLER.keyHash]));
    await assert.rejects(k.assemble(plan, [LISTED.keyHash]), REJECTED, 'the owner alone is not enough');
    await assert.rejects(k.assemble(plan, []), REJECTED);
    await assert.rejects(k.assemble(plan, [WALLET.keyHash]), REJECTED);
  });
  test('verdict: the amount goes to the payee: the owner key while the record declares it (not the wallet, not the controller), the controller when it does not', async () => {
    const k = await decreaseKit();
    const plan = k.planAt(k.created.readyAt);
    assert.equal(plan.payee.keyHash, LISTED.keyHash);
    await assert.doesNotReject(k.assemble(plan));
    const to = (hash: string) => ({ ...plan, payoutAddress: credentialToAddress('Mainnet', { type: 'Key', hash }) });
    await assert.rejects(k.assemble(to(CONTROLLER.keyHash)), REJECTED, 'the controller is not the payee while the owner key is declared');
    await assert.rejects(k.assemble(to(STRANGER.keyHash)), REJECTED);
    await assert.rejects(k.assemble({ ...plan, payoutAddress: WALLET_ADDRESS }), REJECTED, 'the wallet is neither');
    const dropped = await decreaseKit({ record: { keys: [] } });
    const droppedPlan = dropped.planAt(dropped.created.readyAt);
    assert.equal(droppedPlan.payee.keyHash, CONTROLLER.keyHash);
    await assert.doesNotReject(dropped.assemble(droppedPlan));
    await assert.rejects(dropped.assemble({ ...droppedPlan, payoutAddress: credentialToAddress('Mainnet', { type: 'Key', hash: LISTED.keyHash }) }), REJECTED, 'the owner key is no longer declared');
  });
  test('verdict: the continuing datum changes only stake_amount (by the amount) and last_updated; a revoked record can exit', async () => {
    const k = await decreaseKit();
    const plan = k.planAt(k.created.readyAt);
    const bad = (changes: Partial<StakeDatum>) => { const datum = { ...plan.datum, ...changes }; return { ...plan, datum, datumHex: encodeStakeDatum(datum) }; };
    await assert.rejects(k.assemble(bad({ stake_amount: plan.datum.stake_amount + 1n })), REJECTED);
    await assert.rejects(k.assemble(bad({ stake_amount: plan.datum.stake_amount - 1n })), REJECTED);
    await assert.rejects(k.assemble(bad({ last_updated: plan.window.lo })), REJECTED);
    await assert.rejects(k.assemble(bad({ staked_capabilities: [] })), REJECTED);
    await assert.rejects(k.assemble({ ...plan, amount: plan.amount + 1n, redeemerHex: Data.to(new Constr(2, [plan.amount + 1n])) }), REJECTED, 'the redeemer amount and the datum must agree');
    const revoked = await decreaseKit({ record: { status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 0, at: NOW, invalidFrom: null, successor: null }, keys: [], parties: [], capabilities: [] } });
    await assert.doesNotReject(revoked.assemble(revoked.planAt(revoked.created.readyAt)), 'a revoked record exits');
  });
  test('verdict: a stake that a challenge locks cannot decrease: the output keeps the lock, so only the lock rule fails, and the same build on an unlocked stake is accepted', async () => {
    const unlocked = await decreaseKit();
    await assert.doesNotReject(unlocked.assemble(unlocked.planAt(unlocked.created.readyAt)));
    const locked = await decreaseKit({ locked: true });
    const plan = locked.planAt(locked.created.readyAt);
    assert.deepEqual(plan.datum.challenge_locks, [utf8Hex('rchl_one')], 'the planned output keeps the lock, so the datum rule holds');
    await assert.rejects(locked.assemble(plan), REJECTED);
  });
});

// ─── The assembled outputs ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('planStakeCreate and the opening plan', () => {
  test('the stake amount defaults to the module minimum; the datum names the agent, the owner and the capabilities', async () => {
    const k = await createKit();
    assert.equal(k.plan.stakeLovelace, 10_000_000n);
    assert.equal(k.plan.datum.last_updated, k.window.hi);
    assert.equal(k.plan.controllerKeyHash, CONTROLLER.keyHash);
    assert.equal(k.plan.ownerKeyHash, LISTED.keyHash);
    assert.equal(k.plan.tokenUnit, UNIT2);
    assert.equal(k.plan.spendRedeemerHex, CREATE_STAKE_REDEEMER);
    assert.equal(REPUTATION_SCRIPT_HASH.length, 56);
  });
  test('without an owner the plan takes the owner that the opening output names, and refuses it when the record does not declare it; an owner that is passed wins', async () => {
    const k = await createKit();
    const plan = (ownerKeyHash?: string, opening = k.opening) => planStakeCreate({ chain: k.chain, did: DID2, ownerKeyHash, capabilities: STAKE_CAPS, opening, params: k.refs.stakeParams, window: k.window });
    assert.equal(plan().ownerKeyHash, LISTED.keyHash);
    assert.equal(plan().datum.owner_pkh, LISTED.keyHash);
    assert.equal(plan(CONTROLLER.keyHash).ownerKeyHash, CONTROLLER.keyHash);
    const stranger = { ...k.opening, datum: { ...k.opening.datum, owner_pkh: STRANGER.keyHash } };
    assert.throws(() => plan(undefined, stranger), new RegExp(`names the owner key ${STRANGER.keyHash}, and the record of ${DID2} does not declare that key now`));
    assert.equal(plan(LISTED.keyHash, stranger).ownerKeyHash, LISTED.keyHash, 'an owner that is passed wins over the opening output');
    assert.throws(() => plan(STRANGER.keyHash, stranger), new RegExp(`The owner key ${STRANGER.keyHash} is not a declared key of ${DID2}`));
  });
});

// ─── What the stake address holds, and the helpers ────────────────────────────────────────────────────────────────────────────

describe('what the stake address holds for an agent', () => {
  const callIncrease = (w: World) => ctxOf(w).then((ctx) => buildStakeIncrease(ctx, { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: 1n, nowMs: NOW + HOUR }));
  test('an output that holds the stake token but has no datum, or a datum that does not decode, is an error: a read that skipped it could build a second stake', async () => {
    const { world, create } = await staked();
    const stake = world.at(create.stakeRef);
    const swapped = (change: Partial<UTxO>) => {
      const w = new World();
      w.utxos = world.utxos.map((u) => (u === stake ? { ...stake, ...change } : u));
      return w;
    };
    await assert.rejects(callIncrease(swapped({ datum: undefined })), new RegExp(`The stake output ${create.stakeRef} of the agent has no inline datum`));
    await assert.rejects(callIncrease(swapped({ datum: Data.to(new Constr(0, [1n])) })), new RegExp(`The stake output ${create.stakeRef} of the agent does not decode \\(not a stake datum`));
    await assert.doesNotReject(callIncrease(world));
  });
  test('an opening output of another agent, one that holds a token, and one whose datum is no stake datum do not block the agent\'s own opening', async () => {
    const world = new World();
    const datumOf = (agent: string) => encodeStakeDatum({
      agent_did: agent, owner_pkh: WALLET.keyHash, stake_amount: 2_000_000n, staked_capabilities: [], last_updated: NOW, history_points: 0n, challenge_locks: [], stake_id: { txHash: '00'.repeat(32), outputIndex: 0 },
    });
    const at = (byte: string, over: Partial<UTxO>): UTxO => ({ txHash: byte.repeat(32), outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: 2_000_000n }, datum: datumOf(AGENT_ID), ...over });
    world.utxos.push(
      at('a1', { datum: datumOf(AGENT2_ID) }),
      at('a2', { assets: { lovelace: 2_000_000n, [`${'99'.repeat(28)}74`]: 1n } }),
      at('a3', { datum: Data.to(new Constr(0, [1n])) }),
      at('a4', { datum: undefined }),
    );
    const open = await buildStakeOpening(await ctxOf(world), OPEN());
    assert.ok(open.openingRef);
    world.utxos.push(at('a5', {}));
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN()), new RegExp(`An opening output that names ${DID} is already at the reputation address\\..* Listed \\(at most 5, the ones whose owner the record declares first\\): ${'a5'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\)\\. Nothing was built\\.$`));
    await assert.rejects(
      buildStakeOpening(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID2, capabilities: STAKE_CAPS, ownerKeyHash: LISTED.keyHash, nowMs: NOW }),
      new RegExp(`An opening output that names ${DID2} is already at the reputation address\\..* Listed \\(at most 5, the ones whose owner the record declares first\\): ${'a1'.repeat(32)}#0 \\(2\\.000000 AP3X, owner ${WALLET.keyHash}\\)\\. Nothing was built\\.$`), 'the second agent has its own opening output',
    );
  });
  test('a wallet with one pure output spends it: the answer says that no 5 AP3X output was kept aside for step 2', async () => {
    const single = new World([], { wallet: [{ txHash: 'd5'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 40_000_000n } }] });
    const open = await buildStakeOpening(await ctxOf(single), OPEN());
    assert.equal(open.collateralKept, false);
    const kept = await buildStakeOpening(await ctxOf(new World()), OPEN());
    assert.equal(kept.collateralKept, true);
  });
  test('the opening datum is stamped with the second of the build', async () => {
    const open = await buildStakeOpening(await ctxOf(new World()), OPEN({ nowMs: NOW + 400 }));
    const datum = decodeStakeDatum(outputsOf(open.txCbor)[Number(open.openingRef.split('#')[1])].datum!);
    assert.equal(datum.last_updated, NOW, 'the whole second of now');
  });
  test('a capability must be non-empty text', async () => {
    const world = new World();
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ capabilities: [''] })), /Each capability must be non-empty text/);
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ capabilities: [5] })), /Each capability must be non-empty text/);
  });
  test('valid_minutes above 59 is refused by every action', async () => {
    const { world, create } = await staked();
    const later = create.readyAt + HOUR;
    await assert.rejects(buildStakeIncrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, addLovelace: 1n, validMinutes: 60, nowMs: later }), /valid_minutes must be a whole number from 1 to 59/);
    await assert.rejects(buildStakeCapabilities(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, capabilities: STAKE_CAPS, validMinutes: 60, nowMs: later }), /valid_minutes must be a whole number from 1 to 59/);
    await assert.rejects(buildStakeDecrease(await ctxOf(world), { changeAddress: WALLET_ADDRESS, did: DID, amountLovelace: AP3X(1), validMinutes: 0, nowMs: later }), /valid_minutes must be a whole number from 1 to 59/);
  });
});

describe('coinsPerUtxoByteOf and findOutput', () => {
  test('coinsPerUtxoByteOf gives the price of a byte, and refuses a Lucid that has no protocol parameters', () => {
    // Stubs of the one method that the helpers call: a Lucid without protocol parameters cannot be made from a node that gives them.
    const none = { config: () => ({}) } as unknown as LucidEvolution;
    const priced = { config: () => ({ protocolParameters: { coinsPerUtxoByte: 4310n } }) } as unknown as LucidEvolution;
    assert.equal(coinsPerUtxoByteOf(priced), 4310n);
    assert.throws(() => coinsPerUtxoByteOf(none), /The node did not give the protocol parameters/);
    assert.throws(() => minimumOf(none, REPUTATION_ADDRESS), /The node did not give the protocol parameters/);
  });
  test('findOutput finds the output by its address, its token and its datum, and refuses a transaction that has none', async () => {
    const world = new World();
    const { lucid } = await ctxOf(world);
    const unit = `${'11'.repeat(28)}${'1'.repeat(64)}`; // a token that the wallet holds
    const datumHex = encodeStakeDatum({ agent_did: AGENT_ID, owner_pkh: WALLET.keyHash, stake_amount: 1n, staked_capabilities: [], last_updated: 1, history_points: 0n, challenge_locks: [], stake_id: { txHash: '00'.repeat(32), outputIndex: 0 } });
    const other = encodeStakeDatum({ agent_did: AGENT_ID, owner_pkh: WALLET.keyHash, stake_amount: 2n, staked_capabilities: [], last_updated: 1, history_points: 0n, challenge_locks: [], stake_id: { txHash: '00'.repeat(32), outputIndex: 0 } });
    const built = await lucid.newTx()
      .pay.ToAddressWithData(WALLET_ADDRESS, { kind: 'inline', value: datumHex }, { lovelace: 3_000_000n, [unit]: 1n })
      .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: other }, { lovelace: 4_000_000n, [unit]: 2n })
      .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: datumHex }, { lovelace: 5_000_000n })
      .pay.ToAddressWithData(REPUTATION_ADDRESS, { kind: 'inline', value: datumHex }, { lovelace: 6_000_000n, [unit]: 1n })
      .complete();
    const cbor = built.toCBOR();
    const none = /does not have the planned output at the reputation address/;
    assert.deepEqual(findOutput(cbor, { address: REPUTATION_ADDRESS, unit, datumHex }), { index: 3, lovelace: 6_000_000n }, 'the address, the token (quantity 1) and the datum');
    assert.equal(findOutput(cbor, { address: WALLET_ADDRESS, unit, datumHex }).index, 0);
    assert.equal(findOutput(cbor, { address: REPUTATION_ADDRESS, datumHex }).index, 2, 'no token asked: the first output with the datum');
    assert.equal(findOutput(cbor, { address: REPUTATION_ADDRESS }).index, 1, 'only the address asked');
    assert.throws(() => findOutput(cbor, { address: credentialToAddress('Mainnet', { type: 'Key', hash: STRANGER.keyHash }), datumHex }), none, 'another address');
    assert.throws(() => findOutput(cbor, { address: REPUTATION_ADDRESS, unit: `${'11'.repeat(28)}${'2'.repeat(64)}`, datumHex }), none, 'another token');
    assert.throws(() => findOutput(cbor, { address: REPUTATION_ADDRESS, unit, datumHex: encodeStakeDatum({ ...decodeStakeDatum(datumHex), stake_amount: 3n }) }), none, 'another datum');
    assert.throws(() => findOutput(cbor, { address: REPUTATION_ADDRESS, unit, datumHex: other }), none, 'two tokens are not the one token of a stake');
  });
});

// ─── An opening output that another wallet made ──────────────────────────────────────────────────────────────────────────────

/** An opening output that another wallet made: at the reputation address, lovelace only, with a stake datum that names `agent` and `owner`. */
function foreignOpening(byte: string, agent: string, owner: string, lovelace = 2_000_000n): UTxO {
  const datum: StakeDatum = {
    agent_did: agent, owner_pkh: owner, stake_amount: 2_000_000n, staked_capabilities: [], last_updated: NOW, history_points: 0n, challenge_locks: [], stake_id: { txHash: '00'.repeat(32), outputIndex: 0 },
  };
  return { txHash: byte.repeat(32), outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace }, datum: encodeStakeDatum(datum) };
}
/** The output reference of the record of `id` in `world`. */
const recordRefOf = (world: World, id: string): string => `${world.utxos.find((u) => u.assets[`${REAL_IDENTITY.identity.hash}${id}`] === 1n)!.txHash}#0`;

describe('an opening output that names the agent and a key that the record does not declare', () => {
  const undeclared = (ref: string, owner: string, did = DID) => new RegExp(`The opening output ${ref} names the owner key ${owner}, and the record of ${did} does not declare that key now\\. Pass owner_key_hash with the controller key or with a key that the record lists with the transaction purpose\\. Nothing was built\\.$`);

  test('step 2 with no owner_key_hash refuses the key of the opening output and says what to pass; with a declared owner_key_hash it builds on that opening output, and the validator accepts it', async () => {
    const foreign = foreignOpening('b2', AGENT_ID, STRANGER.keyHash);
    const ref = `${foreign.txHash}#0`;
    const world = new World([foreign]);
    const call = (over: Record<string, unknown> = {}) => ctxOf(world).then((ctx) => buildStakeCreate(ctx, CREATE(ref, over)));
    await assert.rejects(call(), undeclared(ref, STRANGER.keyHash));
    await assert.rejects(call({ ownerKeyHash: STRANGER.keyHash }), new RegExp(`The owner key ${STRANGER.keyHash} is not a declared key of ${DID}`), 'passing the undeclared key is refused too');
    const r = await call({ ownerKeyHash: WALLET.keyHash });
    assert.equal(r.ownerKeyHash, WALLET.keyHash);
    assert.equal(r.openingOwnerKeyHash, STRANGER.keyHash);
    assert.equal(r.stakeId, ref, 'the opening output is the seed of the stake');
    assert.ok(spentBy(r.txCbor).has(ref), 'the build spends it');
    assert.equal(stakeOutput(r.txCbor, UNIT).datum.owner_pkh, WALLET.keyHash);
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [WALLET.keyHash]);
  });
  test('an opening output of another agent is refused as that, before its owner is looked at', async () => {
    const foreign = foreignOpening('b3', AGENT2_ID, STRANGER.keyHash);
    await assert.rejects(
      ctxOf(new World([foreign])).then((ctx) => buildStakeCreate(ctx, CREATE(`${foreign.txHash}#0`))),
      new RegExp(`names another agent \\(did:vector:${AGENT2_ID}\\), not ${DID}`),
    );
  });
  test('the record replaces the listed key after step 1: the new key and the controller key build, the old key and the default are refused, and step 1 builds another opening only when it is allowed', async () => {
    const world = new World();
    const open = await buildStakeOpening(await ctxOf(world), OPEN({ did: DID2, ownerKeyHash: LISTED.keyHash }));
    world.apply(open.txCbor);
    world.replace(recordRefOf(world, AGENT2_ID), recordOutput(AGENT2_ID, agent2Record({ keys: [{ keyType: 'Ed25519', key: REPLACEMENT.publicKey, purposes: 1 + 2 + 8, pop: null }] })));
    const call = (over: Record<string, unknown> = {}) => ctxOf(world).then((ctx) => buildStakeCreate(ctx, CREATE(open.openingRef, { did: DID2, ...over })));
    await assert.rejects(call(), undeclared(open.openingRef, LISTED.keyHash, DID2));
    await assert.rejects(call({ ownerKeyHash: LISTED.keyHash }), new RegExp(`The owner key ${LISTED.keyHash} is not a declared key of ${DID2}`));
    const fresh = await call({ ownerKeyHash: REPLACEMENT.keyHash });
    assert.equal(fresh.ownerKeyHash, REPLACEMENT.keyHash);
    assert.equal(fresh.openingOwnerKeyHash, LISTED.keyHash);
    assert.deepEqual(fresh.requiredSigners.map((s) => s.keyHash), [CONTROLLER.keyHash, REPLACEMENT.keyHash, WALLET.keyHash]);
    assert.equal(stakeOutput(fresh.txCbor, UNIT2).datum.owner_pkh, REPLACEMENT.keyHash);
    assert.equal((await call({ ownerKeyHash: CONTROLLER.keyHash })).ownerKeyHash, CONTROLLER.keyHash, 'the controller key is declared too');
    const again = { ...OPEN({ did: DID2, ownerKeyHash: REPLACEMENT.keyHash }) };
    await assert.rejects(buildStakeOpening(await ctxOf(world), again), /is already at the reputation address/);
    const second = await buildStakeOpening(await ctxOf(world), { ...again, allowSecondOpening: true });
    assert.deepEqual(second.otherOpenings, [open.openingRef]);
    assert.equal(second.otherOpeningsMore, 0);
  });
  test('step 1 refuses while an opening output that names the agent is at the address, lists each with its AP3X and its owner, and builds another only with allowSecondOpening', async () => {
    const a = foreignOpening('b4', AGENT_ID, STRANGER.keyHash, 1_390_000n);
    const b = foreignOpening('b5', AGENT_ID, LISTED.keyHash);
    const elsewhere = foreignOpening('b6', AGENT2_ID, STRANGER.keyHash);
    const world = new World([a, b, elsewhere]);
    const refusal = new RegExp(`An opening output that names ${DID} is already at the reputation address\\. Step 2 \\(vector_build_reputation_stake\\) can spend any of them with any owner key that the record declares: pass one as opening_ref, and owner_key_hash when you want another owner than the one it names\\. When step 2 cannot use any of them, pass allow_second_opening true to build a new opening output; each opening output locks its AP3X until a CreateStake spends it\\. Listed \\(at most 5, the ones whose owner the record declares first\\): ${a.txHash}#0 \\(1\\.390000 AP3X, owner ${STRANGER.keyHash}\\), ${b.txHash}#0 \\(2\\.000000 AP3X, owner ${LISTED.keyHash}\\)\\. Nothing was built\\.$`);
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN()), refusal);
    await assert.rejects(buildStakeOpening(await ctxOf(world), OPEN({ allowSecondOpening: false })), refusal);
    const second = await buildStakeOpening(await ctxOf(world), OPEN({ allowSecondOpening: true }));
    assert.ok(second.openingRef);
    assert.deepEqual(second.otherOpenings, [`${a.txHash}#0`, `${b.txHash}#0`], 'the other opening outputs of this agent, not the one of the other agent');
    assert.deepEqual((await buildStakeOpening(await ctxOf(new World()), OPEN({ allowSecondOpening: true }))).otherOpenings, [], 'with none at the address the flag changes nothing');
    assert.deepEqual((await buildStakeOpening(await ctxOf(new World()), OPEN())).otherOpenings, []);
    assert.equal(second.otherOpeningsMore, 0);
    assert.equal((await buildStakeOpening(await ctxOf(new World()), OPEN())).otherOpeningsMore, 0);
  });
  test('7 opening outputs, 2 with an owner that the record declares: the refusal and the answer list 5 with the declared ones first and count the 2 more, and the refusal names allow_second_opening within its first 800 characters', async () => {
    // The second agent declares CONTROLLER (its controller key) and LISTED (a listed key with the transaction purpose). The node lists the 2 declared owners last.
    const owners = [STRANGER, AUTH_ONLY, STRANGER, REPLACEMENT, STRANGER, LISTED, CONTROLLER];
    const openings = owners.map((key, i) => foreignOpening(`c${i + 1}`, AGENT2_ID, key.keyHash));
    const [u1, u2, u3, , , d6, d7] = openings;
    const world = new World(openings);
    const call = (extra: Record<string, unknown> = {}) => ctxOf(world).then((ctx) => buildStakeOpening(ctx, OPEN({ did: DID2, ownerKeyHash: LISTED.keyHash, ...extra })));
    const entry = (u: UTxO) => `${u.txHash}#0 (2.000000 AP3X, owner ${decodeStakeDatum(u.datum!).owner_pkh})`;
    const message = await call().then(() => assert.fail('the build must refuse'), (err: Error) => err.message);
    assert.ok(message.includes(`Listed (at most 5, the ones whose owner the record declares first): ${[d6, d7, u1, u2, u3].map(entry).join(', ')} and 2 more. Nothing was built.`), message);
    assert.ok(message.indexOf('allow_second_opening') >= 0 && message.indexOf('allow_second_opening') < 800, 'the way out is inside the 800 characters that an error keeps');
    assert.ok(message.indexOf('can spend any of them with any owner key that the record declares') < message.indexOf('Listed ('), 'the way out comes before the list');
    const second = await call({ allowSecondOpening: true });
    assert.deepEqual(second.otherOpenings, [d6, d7, u1, u2, u3].map((u) => `${u.txHash}#0`));
    assert.equal(second.otherOpeningsMore, 2);
  });
  test('shownOpenings lists at most 5 and counts the rest, the declared owners first, each group in the order of the node', () => {
    const record = agent2Record();
    const make = (prefix: string, count: number, owner: string): StakeOut[] => Array.from({ length: count }, (_, i) => {
      const utxo = foreignOpening(`${prefix}${i}`, AGENT2_ID, owner);
      return { utxo, datum: decodeStakeDatum(utxo.datum!), ref: `${utxo.txHash}#0` };
    });
    assert.equal(MAX_LISTED_OPENINGS, 5);
    assert.deepEqual(shownOpenings([], record), { shown: [], more: 0 });
    const five = make('d', 5, STRANGER.keyHash);
    assert.deepEqual(shownOpenings(five, record), { shown: five, more: 0 }, 'five are all listed');
    const six = make('d', 6, STRANGER.keyHash);
    assert.deepEqual(shownOpenings(six, record), { shown: six.slice(0, 5), more: 1 }, 'the sixth is counted');
    const declared = make('e', 2, CONTROLLER.keyHash);
    const mixed = shownOpenings([...six, ...declared], record);
    assert.deepEqual(mixed.shown.map((o) => o.ref), [...declared, ...six.slice(0, 3)].map((o) => o.ref), 'the declared owners first, then the others in the order of the node');
    assert.equal(mixed.more, 3);
    assert.deepEqual(shownOpenings([...make('f', 2, STRANGER.keyHash), ...declared], record).shown.slice(0, 2), declared, 'a declared owner after an undeclared one still comes first');
  });
});
