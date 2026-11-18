// packages/builder/test/module1-build.test.ts
// The Module-1 SubmitClaim, OpenChallenge and WithdrawClaim builders against the applied mainnet claim and challenge scripts (jury-world.ts):
// Lucid runs the real validators on each build, so a build that completes is one that Module-1 accepts, minus the signatures. No network.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML, credentialToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { lucidForAddress } from '../src/vector/build.ts';
import { assertPayoutIsOutputZero, buildOpenChallenge, buildSubmitClaim, buildWithdrawClaim, defaultChallengeWindow, findClaim } from '../src/vector/module1-build.ts';
import {
  SUBMIT_CLAIM_REDEEMER, TOKEN_PREFIX, WITHDRAW_CLAIM_REDEEMER, blake2b256Hex, decodeChallengeDatum, decodeClaimDatum, encodeClaimDatum, seedTokenName,
} from '../src/vector/jury-codec.ts';
import type { ClaimDatum } from '../src/vector/jury-codec.ts';
import { utf8Hex } from '../src/vector/identity-codec.ts';
import { chainClock, windowAt } from '../src/vector/identity-chain.ts';
import {
  AUDITOR_ID, CHALLENGE_SCRIPT, CLAIMER_ID, CLAIM_SCRIPT, DAY, HOUR, IDENTITY_ADDRESS, IDENTITY_HASH, MODULE1, MODULE1_UTXOS, NOW, STRANGER, WALLET,
  WALLET_ADDRESS, WALLET_UTXOS, agentRecord, claimUtxo, juryWorld, recordUtxo,
} from './fixtures/jury-world.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';

const claimParams = (extra: Record<string, unknown> = {}) => ({
  changeAddress: WALLET_ADDRESS, agentId: CLAIMER_ID, claimHash: 'ab'.repeat(32), claimUri: utf8Hex('vector-tx:cu8SkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  claimType: utf8Hex('certification'), stakeLovelace: 50_000_000n, nowMs: NOW, ...extra,
});

/** The outputs of a built transaction: address, lovelace, inline datum (hex). */
function outputsOf(txCbor: string) {
  const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  return Array.from({ length: outputs.len() }, (_, i) => {
    const o = outputs.get(i);
    return { address: o.address().to_bech32(), lovelace: o.amount().coin(), datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null };
  });
}

/**
 * The Conway minimum fee of a built transaction with the signature of the wallet key added: the size fee, the price of the execution
 * units, and the price of each byte of the reference scripts that its reference inputs and its inputs hold. `referenceScriptBytes` is
 * that number of bytes. The node refuses a transaction with a smaller fee (Ogmios error 3122).
 */
async function minimumFee(provider: FixtureProvider, lucid: LucidEvolution, txCbor: string): Promise<{ fee: bigint; referenceScriptBytes: number }> {
  const pp = lucid.config().protocolParameters;
  assert.ok(pp, 'the fixture provider gives the protocol parameters');
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  // A signature of a throwaway key has the size of the signature of the wallet key.
  const witnesses = tx.witness_set();
  const vkeys = CML.VkeywitnessList.new();
  vkeys.add(CML.make_vkey_witness(CML.hash_transaction(body), CML.PrivateKey.generate_ed25519()));
  witnesses.set_vkeywitnesses(vkeys);
  const size = CML.Transaction.new(body, witnesses, true, tx.auxiliary_data()).to_cbor_bytes().length;
  const redeemers = tx.witness_set().redeemers()?.to_flat_format();
  let mem = 0n;
  let steps = 0n;
  for (let i = 0; i < (redeemers?.len() ?? 0); i++) {
    mem += redeemers!.get(i).ex_units().mem();
    steps += redeemers!.get(i).ex_units().steps();
  }
  // The prices are decimal fractions with at most 7 places (577/10000 and 721/10000000 on Vector): integer arithmetic keeps the ceiling exact.
  const scale = 10_000_000n;
  const execution = (mem * BigInt(Math.round(pp.priceMem * Number(scale))) + steps * BigInt(Math.round(pp.priceStep * Number(scale))) + scale - 1n) / scale;
  const refsOf = (list: CML.TransactionInputList | undefined) => Array.from({ length: list?.len() ?? 0 }, (_, i) => ({ txHash: list!.get(i).transaction_id().to_hex(), outputIndex: Number(list!.get(i).index()) }));
  const utxos = await provider.getUtxosByOutRef([...refsOf(body.reference_inputs()), ...refsOf(body.inputs())]);
  const referenceScriptBytes = utxos.reduce((sum, u) => sum + (u.scriptRef ? u.scriptRef.script.length / 2 : 0), 0);
  assert.ok(referenceScriptBytes <= 25_600, 'above 25,600 bytes the ledger raises the price of each further tier of bytes by 1.2');
  const fee = BigInt(pp.minFeeA) * BigInt(size) + BigInt(pp.minFeeB) + execution + BigInt(pp.minFeeRefScriptCostPerByte) * BigInt(referenceScriptBytes);
  return { fee, referenceScriptBytes };
}

describe('the fixture scripts are the mainnet Module-1 scripts', () => {
  test('their hashes are those of the manifest', () => {
    assert.equal(validatorToScriptHash(CLAIM_SCRIPT), MODULE1.claim.hash);
    assert.equal(validatorToScriptHash(CHALLENGE_SCRIPT), MODULE1.challenge.hash);
  });
});

describe('buildSubmitClaim (real claim validator)', () => {
  test('mints the claim token named from the first input and locks the stake with the 9-field datum', async () => {
    const provider = juryWorld();
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const r = await buildSubmitClaim({ lucid, provider, module1: MODULE1 }, claimParams());
    // The wallet outputs except the 5 AP3X collateral, in ledger order: f0…#2 comes first.
    assert.equal(r.seed, `${'f0'.repeat(32)}#2`);
    assert.equal(r.claimToken, seedTokenName(TOKEN_PREFIX.claim, { txHash: 'f0'.repeat(32), outputIndex: 2 }));
    const out = outputsOf(r.txCbor)[r.claimOutputIndex];
    assert.equal(out.address, MODULE1.claim.address);
    assert.equal(out.lovelace, 50_000_000n);
    const claim = decodeClaimDatum(out.datum!);
    assert.equal(claim.claimerDid, CLAIMER_ID);
    assert.deepEqual(claim.claimerCredential, { type: 'VerificationKey', hash: WALLET.keyHash });
    assert.equal(claim.state, 'Open');
    assert.equal(claim.challengeWindow, defaultChallengeWindow(MODULE1));
    assert.ok(claim.submittedAt >= r.validFrom && claim.submittedAt < r.validTo, 'submitted_at lies inside the window');
    assert.ok(r.validTo - r.validFrom <= HOUR);
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [WALLET.keyHash]);
    const body = CML.Transaction.from_cbor_hex(r.txCbor).body();
    const refs = body.reference_inputs()!;
    const refTxs = Array.from({ length: refs.len() }, (_, i) => `${refs.get(i).transaction_id().to_hex()}#${refs.get(i).index()}`);
    for (const ref of [MODULE1.claim.ref, MODULE1.crossRefs, MODULE1.params]) assert.ok(refTxs.includes(`${ref.txHash}#${ref.outputIndex}`));
    assert.equal(body.inputs().len(), 3, 'every wallet output but the collateral is spent');
  });

  test('the fee pays for the claim script, which only the mint uses', async () => {
    const provider = juryWorld();
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const r = await buildSubmitClaim({ lucid, provider, module1: MODULE1 }, claimParams());
    const minimum = await minimumFee(provider, lucid, r.txCbor);
    assert.equal(minimum.referenceScriptBytes, CLAIM_SCRIPT.script.length / 2);
    assert.ok(BigInt(r.fee) >= minimum.fee, `the fee ${r.fee} is below the ledger minimum ${minimum.fee}`);
  });

  test('a 30-minute window and a stake above the minimum are accepted', async () => {
    const provider = juryWorld();
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const r = await buildSubmitClaim({ lucid, provider, module1: MODULE1 }, claimParams({ challengeWindowMs: 30 * 60_000, stakeLovelace: 120_000_000n }));
    assert.equal(r.claim.challengeWindow, 1_800_000);
    assert.equal(r.claim.stakeAmount, 120_000_000n);
  });

  test('refuses what Module-1 refuses, before it builds', async () => {
    const provider = juryWorld();
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const ctx = { lucid, provider, module1: MODULE1 };
    await assert.rejects(buildSubmitClaim(ctx, claimParams({ stakeLovelace: 49_999_999n })), /at least 50\.000000 AP3X/);
    await assert.rejects(buildSubmitClaim(ctx, claimParams({ challengeWindowMs: 29 * 60_000 })), /from 30 min to 1440 min/);
    await assert.rejects(buildSubmitClaim(ctx, claimParams({ claimType: '' })), /claim type must be 1 to 64 bytes/);
    await assert.rejects(buildSubmitClaim(ctx, claimParams({ claimHash: 'ab'.repeat(31) })), /claim hash must be 32 bytes/);
    await assert.rejects(buildSubmitClaim(ctx, claimParams({ agentId: 'ee'.repeat(32) })), /No record for did:vector:eeee.* \(the claimer\)/);
  });

  test('refuses a claimer whose record does not declare the wallet key, or that is not Active', async () => {
    const strangers = juryWorld([], [recordUtxo(CLAIMER_ID, agentRecord({}, STRANGER.publicKey))]);
    const lucid = await lucidForAddress(strangers, WALLET_ADDRESS);
    await assert.rejects(buildSubmitClaim({ lucid, provider: strangers, module1: MODULE1 }, claimParams()), /neither the controller .* nor a listed key/);
    const held = juryWorld([], [recordUtxo(CLAIMER_ID, agentRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: NOW - DAY, until: NOW + DAY }] } }))]);
    const lucid2 = await lucidForAddress(held, WALLET_ADDRESS);
    await assert.rejects(buildSubmitClaim({ lucid: lucid2, provider: held, module1: MODULE1 }, claimParams()), /is Suspended over the validity window/);
  });
});

describe('buildOpenChallenge (real challenge and claim validators)', () => {
  const claimToken = `636c6d5f${'0f'.repeat(28)}`;
  const params = (extra: Record<string, unknown> = {}) => ({
    changeAddress: WALLET_ADDRESS, auditorId: AUDITOR_ID, claim: { token: claimToken }, evidenceHash: 'ed'.repeat(32),
    evidenceUri: utf8Hex('https://example.org/evidence.json'), stakeLovelace: 50_000_000n, resolutionDeadlineMs: 72 * HOUR, nowMs: NOW, ...extra,
  });

  test('spends the claim into Challenged, mints the challenge token and locks the stake in PendingOracle', async () => {
    const claim = claimUtxo(claimToken);
    const provider = juryWorld([claim]);
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const r = await buildOpenChallenge({ lucid, provider, module1: MODULE1 }, params());
    // The claim output cc…#0 sorts before every wallet output, so it is the seed (as on mainnet).
    assert.equal(r.seed, `${'cc'.repeat(32)}#0`);
    assert.equal(r.challengeToken, seedTokenName(TOKEN_PREFIX.challenge, { txHash: 'cc'.repeat(32), outputIndex: 0 }));
    const outputs = outputsOf(r.txCbor);
    const ch = decodeChallengeDatum(outputs[r.challengeOutputIndex].datum!);
    assert.deepEqual(ch.state, { type: 'PendingOracle' });
    assert.equal(ch.claimToken, claimToken);
    assert.deepEqual(ch.claimRef, { txHash: 'cc'.repeat(32), outputIndex: 0 });
    assert.equal(ch.auditorDid, AUDITOR_ID);
    assert.deepEqual(ch.eligibleJurors, []);
    assert.equal(ch.resolutionDeadline, 72 * HOUR);
    assert.equal(outputs[r.challengeOutputIndex].lovelace, 50_000_000n);
    const continuing = decodeClaimDatum(outputs[r.claimOutputIndex].datum!);
    assert.equal(continuing.state, 'Challenged');
    assert.deepEqual({ ...continuing, state: 'Open' }, decodeClaimDatum(claim.datum!));
    assert.equal(outputs[r.claimOutputIndex].lovelace, 50_000_000n);
    assert.equal(r.deadline, ch.challengedAt + 72 * HOUR);
    assert.ok(r.validTo <= decodeClaimDatum(claim.datum!).submittedAt + 4 * HOUR - 1000);
  });

  test('the fee pays for the claim script and for the challenge script, which only the mint uses', async () => {
    const provider = juryWorld([claimUtxo(claimToken)]);
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const r = await buildOpenChallenge({ lucid, provider, module1: MODULE1 }, params());
    const minimum = await minimumFee(provider, lucid, r.txCbor);
    assert.equal(minimum.referenceScriptBytes, (CLAIM_SCRIPT.script.length + CHALLENGE_SCRIPT.script.length) / 2);
    assert.ok(BigInt(r.fee) >= minimum.fee, `the fee ${r.fee} is below the ledger minimum ${minimum.fee}`);
  });

  test('the claim can be named by its output reference', async () => {
    const provider = juryWorld([claimUtxo(claimToken)]);
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const r = await buildOpenChallenge({ lucid, provider, module1: MODULE1 }, params({ claim: { ref: { txHash: 'cc'.repeat(32), outputIndex: 0 } } }));
    assert.equal(r.claimToken, claimToken);
  });

  test('the window ends before the challenge window of the claim', async () => {
    const provider = juryWorld([claimUtxo(claimToken, {}, 4 * HOUR - 10 * 60_000)]);
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    const r = await buildOpenChallenge({ lucid, provider, module1: MODULE1 }, params());
    assert.equal(r.validTo, NOW + 10 * 60_000 - 1000);
  });

  test('refuses a self-audit, a low stake, a closed window and a claim that is not Open', async () => {
    const run = async (extra: Record<string, unknown>, claim = claimUtxo(claimToken)) => {
      const provider = juryWorld([claim]);
      const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
      return buildOpenChallenge({ lucid, provider, module1: MODULE1 }, params(extra));
    };
    await assert.rejects(run({ auditorId: CLAIMER_ID }), /cannot audit its own claim/);
    await assert.rejects(run({ stakeLovelace: 49_000_000n }), /at least the claim stake, 50\.000000 AP3X/);
    await assert.rejects(run({}, claimUtxo(claimToken, {}, 5 * HOUR)), /Too late: the challenge window of the claim ends/);
    await assert.rejects(run({}, claimUtxo(claimToken, { state: 'Challenged' })), /is Challenged; only an Open claim can be challenged/);
    await assert.rejects(run({ claim: { token: `636c6d5f${'0e'.repeat(28)}` } }), /No live claim holds the claim token/);
  });
});

describe('a claim at an address with a stake part (SPEC Section 5.7: Module-1 reads the payment credential alone)', () => {
  const claimToken = `636c6d5f${'0f'.repeat(28)}`;
  const unit = `${MODULE1.claim.hash}${claimToken}`;
  // The claim script is the payment credential and a stake key the stake part: claim.ak and challenge.ak take it for a claim address.
  const STAKED = credentialToAddress('Mainnet', { type: 'Script', hash: MODULE1.claim.hash }, { type: 'Key', hash: STRANGER.keyHash });
  const stakedClaim = (overrides: Partial<UTxO> = {}): UTxO => ({ ...claimUtxo(claimToken), address: STAKED, ...overrides });
  const refOf = (u: UTxO) => ({ txHash: u.txHash, outputIndex: u.outputIndex });
  /** The node, with the index of Koios as OgmiosProvider.getUtxoByUnit reads it (asset_utxos): it names the output that holds `held`'s token, wherever that is. */
  const withIndex = (provider: FixtureProvider, held: UTxO): FixtureProvider => Object.assign(provider, {
    getUtxoByUnit: async (u: string): Promise<UTxO> => { if (held.assets[u] === undefined) throw new Error('no answer'); return held; },
  });
  const challengeBase = {
    changeAddress: WALLET_ADDRESS, auditorId: AUDITOR_ID, evidenceHash: 'ed'.repeat(32), evidenceUri: utf8Hex('https://example.org/evidence.json'),
    stakeLovelace: 50_000_000n, resolutionDeadlineMs: 72 * HOUR, nowMs: NOW,
  };

  test('is found by its token name (Koios names the output, the node confirms it) and by its output reference', async () => {
    const claim = stakedClaim();
    const byToken = await findClaim(withIndex(juryWorld([claim]), claim), MODULE1, { token: claimToken });
    const byRef = await findClaim(juryWorld([claim]), MODULE1, { ref: refOf(claim) });
    for (const found of [byToken, byRef]) {
      assert.equal(found.utxo.address, STAKED);
      assert.equal(found.token, claimToken);
      assert.deepEqual(found.datum, decodeClaimDatum(claim.datum!));
    }
  });

  test('a challenge can be built against it, and the continuing claim output keeps its address', async () => {
    const claim = stakedClaim();
    for (const named of [{ token: claimToken }, { ref: refOf(claim) }]) {
      const provider = withIndex(juryWorld([claim]), claim);
      const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
      const r = await buildOpenChallenge({ lucid, provider, module1: MODULE1 }, { ...challengeBase, claim: named });
      const outputs = outputsOf(r.txCbor);
      assert.equal(r.claimToken, claimToken);
      assert.equal(r.claimInput, `${'cc'.repeat(32)}#0`);
      assert.equal(outputs[r.claimOutputIndex].address, STAKED);
      assert.equal(outputs[r.claimOutputIndex].lovelace, 50_000_000n);
      assert.equal(decodeClaimDatum(outputs[r.claimOutputIndex].datum!).state, 'Challenged');
      assert.equal(outputs[r.challengeOutputIndex].address, MODULE1.challenge.address);
      assert.deepEqual(decodeChallengeDatum(outputs[r.challengeOutputIndex].datum!).claimRef, refOf(claim));
    }
  });

  test('Koios names an output that the node does not list: the node decides', async () => {
    const stale = { ...stakedClaim(), txHash: 'dd'.repeat(32) };
    // An enterprise claim is still found, by the scan of the enterprise address.
    const enterprise = claimUtxo(claimToken);
    assert.equal((await findClaim(withIndex(juryWorld([enterprise]), stale), MODULE1, { token: claimToken })).utxo.address, MODULE1.claim.address);
    // A claim at an address with a stake part is not found, and the error says how to name it.
    await assert.rejects(findClaim(withIndex(juryWorld(), stale), MODULE1, { token: claimToken }), /No live claim holds the claim token .* name it by its output reference then/);
  });

  test('an output that is not at the claim script, or does not hold exactly one claim token, is not a claim', async () => {
    const otherToken = `${MODULE1.claim.hash}${'0e'.repeat(32)}`;
    const cases: Array<[string, UTxO]> = [
      ['the claim script is only the stake part', stakedClaim({ address: credentialToAddress('Mainnet', { type: 'Key', hash: STRANGER.keyHash }, { type: 'Script', hash: MODULE1.claim.hash }) })],
      ['the address of the challenge script', stakedClaim({ address: MODULE1.challenge.address })],
      ['two claim tokens', stakedClaim({ assets: { lovelace: 50_000_000n, [unit]: 1n, [otherToken]: 1n } })],
      ['a quantity of two', stakedClaim({ assets: { lovelace: 50_000_000n, [unit]: 2n } })],
    ];
    for (const [why, output] of cases) {
      await assert.rejects(findClaim(juryWorld([output]), MODULE1, { ref: refOf(output) }), /is not a Module-1 claim output/, why);
      await assert.rejects(findClaim(withIndex(juryWorld([output]), output), MODULE1, { token: claimToken }), /No live claim holds the claim token/, why);
    }
  });

  test('a withdrawal can be built against it, by token name and by output reference, and the stake goes to the wallet', async () => {
    const mine = { ...claimUtxo(claimToken, { claimerCredential: { type: 'VerificationKey', hash: WALLET.keyHash } }, 5 * HOUR), address: STAKED };
    for (const named of [{ token: claimToken }, { ref: refOf(mine) }]) {
      const provider = withIndex(juryWorld([mine]), mine);
      const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
      const r = await buildWithdrawClaim({ lucid, provider, module1: MODULE1 }, { changeAddress: WALLET_ADDRESS, claim: named, nowMs: NOW });
      assert.equal(r.claimToken, claimToken);
      assert.equal(r.claimInput, `${'cc'.repeat(32)}#0`);
      assert.deepEqual(outputsOf(r.txCbor)[0], { address: WALLET_ADDRESS, lovelace: 50_000_000n, datum: null });
    }
  });
});

describe('the Module-1 claim validator runs on every build', () => {
  test('a claim output that holds more than the stake fails in the evaluation of the claim script; the exact one completes', async () => {
    const provider = juryWorld();
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    await chainClock(provider);
    const window = windowAt(NOW);
    const inputs = WALLET_UTXOS.filter((u) => u.assets.lovelace !== 5_000_000n);
    const seed = [...inputs].sort((a, b) => (a.txHash < b.txHash ? -1 : 1))[0];
    const unit = `${MODULE1.claim.hash}${seedTokenName(TOKEN_PREFIX.claim, seed)}`;
    const datum = encodeClaimDatum({
      claimerDid: CLAIMER_ID, claimerCredential: { type: 'VerificationKey', hash: WALLET.keyHash }, claimHash: 'ab'.repeat(32), claimType: utf8Hex('x'),
      storageUri: utf8Hex('https://example.org/c.json'), stakeAmount: 50_000_000n, submittedAt: window.lo + 30_000, challengeWindow: HOUR, state: 'Open',
    });
    const refs = await provider.getUtxosByOutRef([MODULE1.claim.ref, MODULE1.crossRefs, MODULE1.params]);
    const records = (await provider.getUtxos(IDENTITY_ADDRESS)).filter((u) => u.assets[`${IDENTITY_HASH}${CLAIMER_ID}`] === 1n);
    const claim = (lovelace: bigint) => lucid.newTx()
      .collectFrom(inputs)
      .mintAssets({ [unit]: 1n }, SUBMIT_CLAIM_REDEEMER)
      .pay.ToContract(MODULE1.claim.address, { kind: 'inline', value: datum }, { lovelace, [unit]: 1n })
      .readFrom([...refs, ...records])
      .addSignerKey(WALLET.keyHash)
      .validFrom(window.lo)
      .validTo(window.hi)
      .complete();
    await assert.rejects(claim(50_000_001n));
    assert.ok((await claim(50_000_000n)).toHash());
  });
});

// ─── WithdrawClaim ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MAINNET_WITHDRAWAL = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/module1-withdrawal-mainnet.json'), 'utf8'));
interface CapturedUtxo { ref: string; address: string; lovelace: string; assets: Record<string, string>; datum?: string }
const utxoFrom = (u: CapturedUtxo): UTxO => ({
  txHash: u.ref.slice(0, 64), outputIndex: Number(u.ref.slice(65)), address: u.address,
  assets: { lovelace: BigInt(u.lovelace), ...Object.fromEntries(Object.entries(u.assets).map(([unit, quantity]) => [unit, BigInt(quantity)])) },
  ...(u.datum ? { datum: u.datum } : {}),
});
const WITHDRAW_HASH = blake2b256Hex(Buffer.from(WITHDRAW_CLAIM_REDEEMER, 'hex'));
const refText = (r: { txHash: string; outputIndex: number }): string => `${r.txHash}#${r.outputIndex}`;

/** What a transaction says, in the terms of the fixture of the mainnet withdrawal: sorted references, the mint, the redeemers, the outputs and the signers. */
function shapeOf(txCbor: string) {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const refsOf = (list: CML.TransactionInputList | undefined) => Array.from({ length: list?.len() ?? 0 }, (_, i) => `${list!.get(i).transaction_id().to_hex()}#${list!.get(i).index()}`).sort();
  const assetsOf = (multi: CML.MultiAsset | CML.Mint | undefined): Record<string, string> => {
    const assets: Record<string, string> = {};
    for (let i = 0; multi && i < multi.keys().len(); i++) {
      const policy = multi.keys().get(i);
      const names = multi.get_assets(policy)!;
      for (let j = 0; j < names.keys().len(); j++) assets[`${policy.to_hex()}${names.keys().get(j).to_hex()}`] = String(names.get(names.keys().get(j)));
    }
    return assets;
  };
  const flat = tx.witness_set().redeemers()?.to_flat_format();
  const redeemers = Array.from({ length: flat?.len() ?? 0 }, (_, i) => ({
    purpose: ['spend', 'mint'][flat!.get(i).tag()] ?? `tag ${flat!.get(i).tag()}`, index: Number(flat!.get(i).index()),
    dataHash: blake2b256Hex(Buffer.from(flat!.get(i).data().to_cbor_hex(), 'hex')),
  })).sort((a, b) => (a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : 0));
  const outputs = Array.from({ length: body.outputs().len() }, (_, i) => {
    const o = body.outputs().get(i);
    return { address: o.address().to_bech32(), lovelace: o.amount().coin().toString(), assets: assetsOf(o.amount().multi_asset()), datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null };
  });
  const signers = body.required_signers();
  return {
    inputs: refsOf(body.inputs()), referenceInputs: refsOf(body.reference_inputs()), minted: assetsOf(body.mint()), redeemers, outputs,
    requiredSigners: Array.from({ length: signers?.len() ?? 0 }, (_, i) => signers!.get(i).to_hex()).sort(), validFromSlot: body.validity_interval_start()?.toString(),
  };
}

describe('buildWithdrawClaim (real claim validator)', () => {
  const claimToken = `636c6d5f${'0f'.repeat(28)}`;
  const unit = `${MODULE1.claim.hash}${claimToken}`;
  const WALLET_CREDENTIAL = { type: 'VerificationKey' as const, hash: WALLET.keyHash };
  /** A claim of the wallet key, 50 AP3X: its window of 4 h ended `endedMs` before NOW. */
  const mine = (overrides: Partial<ClaimDatum> = {}, endedMs = HOUR) => claimUtxo(claimToken, { claimerCredential: WALLET_CREDENTIAL, ...overrides }, 4 * HOUR + endedMs);
  const world = async (claim: UTxO) => { const provider = juryWorld([claim]); return { provider, lucid: await lucidForAddress(provider, WALLET_ADDRESS) }; };
  const withdraw = async (claim: UTxO, extra: Record<string, unknown> = {}) => {
    const { provider, lucid } = await world(claim);
    return buildWithdrawClaim({ lucid, provider, module1: MODULE1 }, { changeAddress: WALLET_ADDRESS, claim: { token: claimToken }, nowMs: NOW, ...extra });
  };

  test('the redeemer is WithdrawClaim, constructor 1: the Data of the mainnet withdrawal', () => {
    assert.equal(WITHDRAW_CLAIM_REDEEMER, 'd87a80');
    for (const redeemer of MAINNET_WITHDRAWAL.tx.redeemers) assert.equal(redeemer.dataHash, WITHDRAW_HASH);
  });

  test('the claim script accepts it: the claim is spent and its token burned with WithdrawClaim, the stake goes back in one output, no claim output continues', async () => {
    const r = await withdraw(mine());
    const shape = shapeOf(r.txCbor);
    assert.equal(r.claimInput, `${'cc'.repeat(32)}#0`);
    assert.ok(shape.inputs.includes(r.claimInput), 'the claim output is spent');
    assert.deepEqual(shape.referenceInputs, [MODULE1.claim.ref, MODULE1.crossRefs, MODULE1.params].map(refText).sort(), 'the claim script, cross_refs and params');
    assert.deepEqual(shape.minted, { [unit]: '-1' });
    assert.deepEqual(shape.redeemers.map((x) => [x.purpose, x.dataHash]), [['mint', WITHDRAW_HASH], ['spend', WITHDRAW_HASH]]);
    assert.equal(shape.outputs.length, 2, 'the stake and the change');
    assert.deepEqual(shape.outputs[0], { address: WALLET_ADDRESS, lovelace: '50000000', assets: {}, datum: null });
    assert.equal(r.payoutRef, `${r.txHash}#0`);
    assert.ok(shape.outputs.every((o) => o.address === WALLET_ADDRESS), 'no output is at the claim script');
    assert.deepEqual(shape.requiredSigners, [WALLET.keyHash]);
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [WALLET.keyHash]);
    assert.equal(r.claim.state, 'Open');
    assert.equal(r.challengeDeadline, NOW - HOUR);
    assert.ok(r.validFrom > r.challengeDeadline && r.validTo - r.validFrom <= HOUR, 'the window starts after the challenge window and is at most an hour');
  });

  test('the shape of the build is the shape of the mainnet withdrawal b3a165bd…, for the same claim and wallet', async () => {
    const m = MAINNET_WITHDRAWAL;
    const provider = new FixtureProvider([...MODULE1_UTXOS, utxoFrom(m.claim), ...m.wallet.map(utxoFrom)]);
    const walletAddress: string = m.wallet[0].address;
    const lucid = await lucidForAddress(provider, walletAddress);
    // The Python builder started the window one minute before its tip slot: the tip was 60 slots after invalidBefore.
    const nowMs = (await provider.getSystemStartMs()) + (Number(m.tx.invalidBefore) + 60) * 1000;
    const r = await buildWithdrawClaim({ lucid, provider, module1: MODULE1 }, { changeAddress: walletAddress, claim: { ref: { txHash: m.claim.ref.slice(0, 64), outputIndex: 0 } }, nowMs });
    const shape = shapeOf(r.txCbor);
    assert.deepEqual(shape.inputs, m.tx.inputs);
    assert.deepEqual(shape.referenceInputs, m.tx.referenceInputs);
    assert.deepEqual(shape.minted, m.tx.minted);
    assert.deepEqual(shape.redeemers.map((x) => [x.purpose, x.dataHash]), m.tx.redeemers.map((x: { purpose: string; dataHash: string }) => [x.purpose, x.dataHash]));
    assert.equal(shape.redeemers.find((x) => x.purpose === 'spend')!.index, 0, 'the claim output is the first input');
    assert.deepEqual(shape.outputs.map((o) => [o.address, o.assets]), m.tx.outputs.map((o: { address: string; assets: unknown }) => [o.address, o.assets]));
    assert.equal(shape.outputs[0].lovelace, m.tx.outputs[0].lovelace, 'exactly the stake to the claimer');
    assert.deepEqual(shape.requiredSigners, m.tx.requiredSigners);
    assert.equal(decodeClaimDatum(m.claim.datum).claimerCredential.hash, m.tx.requiredSigners[0], 'the required signer is the claimer credential');
    assert.equal(shape.validFromSlot, m.tx.invalidBefore, 'the window starts in the same slot');
    assert.equal(r.claimToken, Object.keys(m.tx.minted)[0].slice(MODULE1.claim.hash.length));
    // What the build pays for the Python fee-less difference: its change is the wallet output less its own fee.
    assert.equal(BigInt(shape.outputs[1].lovelace), BigInt(m.wallet[0].lovelace) - BigInt(r.fee));
  });

  test('the fee pays for the claim script, which the spend and the burn both use', async () => {
    const { provider, lucid } = await world(mine());
    const r = await buildWithdrawClaim({ lucid, provider, module1: MODULE1 }, { changeAddress: WALLET_ADDRESS, claim: { token: claimToken }, nowMs: NOW });
    const minimum = await minimumFee(provider, lucid, r.txCbor);
    assert.equal(minimum.referenceScriptBytes, CLAIM_SCRIPT.script.length / 2);
    assert.ok(BigInt(r.fee) >= minimum.fee, `the fee ${r.fee} is below the ledger minimum ${minimum.fee}`);
  });

  test('the claim can be named by its token or by its output reference', async () => {
    const byToken = await withdraw(mine());
    const byRef = await withdraw(mine(), { claim: { ref: { txHash: 'cc'.repeat(32), outputIndex: 0 } } });
    for (const r of [byToken, byRef]) assert.deepEqual([r.claimToken, r.claimInput], [claimToken, `${'cc'.repeat(32)}#0`]);
  });

  test('refuses a claim whose challenge window has not ended, and builds from the first second after it', async () => {
    const claim = mine({}, 0);
    assert.equal(decodeClaimDatum(claim.datum!).submittedAt + decodeClaimDatum(claim.datum!).challengeWindow, NOW, 'the window ends at NOW');
    const early = /Too early: the challenge window of the claim ends at 2026-11-15T12:00:00\.000Z, and a withdrawal must start after it \(2026-11-15T12:00:01\.000Z\)\. Build again after that time/;
    await assert.rejects(withdraw(claim), early);
    await assert.rejects(withdraw(claim, { nowMs: NOW + 999 }), early);
    const r = await withdraw(claim, { nowMs: NOW + 1000 });
    assert.equal(r.validFrom, NOW + 1000);
    assert.equal(r.challengeDeadline, NOW);
    assert.equal((await withdraw(mine({}, HOUR))).validFrom, NOW - 60_000, 'a window that ended long ago leaves the usual start, a minute before now');
  });

  test('a deadline inside a second: the first whole second after it is the first start', async () => {
    // submitted_at has no whole second (another builder can write one): the window ends 500 ms after NOW.
    const claim = mine({ submittedAt: NOW - 4 * HOUR + 500 }, 0);
    assert.equal(decodeClaimDatum(claim.datum!).submittedAt + decodeClaimDatum(claim.datum!).challengeWindow, NOW + 500);
    await assert.rejects(withdraw(claim), /Too early: the challenge window of the claim ends at 2026-11-15T12:00:00\.500Z, .* \(2026-11-15T12:00:01\.000Z\)/);
    const r = await withdraw(claim, { nowMs: NOW + 1000 });
    assert.equal(r.validFrom, NOW + 1000, 'the claim script accepts a start 500 ms after the deadline');
  });

  test('refuses a claim that is not Open, and builds the Open claim', async () => {
    for (const state of ['Challenged', 'Validated', 'Invalidated'] as const) {
      await assert.rejects(withdraw(mine({ state })), new RegExp(`is ${state}; only an Open claim can be withdrawn`));
    }
    assert.equal((await withdraw(mine({ state: 'Open' }))).claim.state, 'Open');
  });

  test('refuses a wallet key that is not the claimer credential, and builds for the claimer', async () => {
    const stranger = claimUtxo(claimToken, { claimerCredential: { type: 'VerificationKey', hash: STRANGER.keyHash } }, 5 * HOUR);
    await assert.rejects(withdraw(stranger), new RegExp(`The wallet key ${WALLET.keyHash} is not the claimer credential of the claim .* \\(${STRANGER.keyHash}\\): only the claimer credential can withdraw it`));
    const script = claimUtxo(claimToken, { claimerCredential: { type: 'Script', hash: 'ab'.repeat(28) } }, 5 * HOUR);
    await assert.rejects(withdraw(script), /\(a script, abab/);
    // A script credential can never sign, even when its hash is the hash of the wallet key.
    const sameHash = claimUtxo(claimToken, { claimerCredential: { type: 'Script', hash: WALLET.keyHash } }, 5 * HOUR);
    await assert.rejects(withdraw(sameHash), /\(a script, /);
    assert.deepEqual((await withdraw(mine())).requiredSigners.map((s) => s.keyHash), [WALLET.keyHash]);
  });

  test('refuses a claim that is not on the node, and a name that is none', async () => {
    const { provider, lucid } = await world(mine());
    const ctx = { lucid, provider, module1: MODULE1 };
    await assert.rejects(buildWithdrawClaim(ctx, { changeAddress: WALLET_ADDRESS, claim: { token: `636c6d5f${'0e'.repeat(28)}` }, nowMs: NOW }), /No live claim holds the claim token/);
    await assert.rejects(buildWithdrawClaim(ctx, { changeAddress: WALLET_ADDRESS, claim: {}, nowMs: NOW }), /Name the claim by its token name or by its output reference/);
  });

  test('the payout is output 0: the check passes for the build and refuses another address, another amount and the change', async () => {
    const r = await withdraw(mine());
    assertPayoutIsOutputZero(r.txCbor, WALLET_ADDRESS, 50_000_000n);
    assert.throws(() => assertPayoutIsOutputZero(r.txCbor, WALLET_ADDRESS, 50_000_001n), /does not have the payout of the stake as output 0/);
    assert.throws(() => assertPayoutIsOutputZero(r.txCbor, MODULE1.claim.address, 50_000_000n), /does not have the payout of the stake as output 0/);
    const change = BigInt(shapeOf(r.txCbor).outputs[1].lovelace);
    assert.throws(() => assertPayoutIsOutputZero(r.txCbor, WALLET_ADDRESS, change), /does not have the payout of the stake as output 0/);
  });
});

describe('the claim script refuses a withdrawal that breaks one of its rules (claim.ak validate_withdraw_claim)', () => {
  const claimToken = `636c6d5f${'0f'.repeat(28)}`;
  const unit = `${MODULE1.claim.hash}${claimToken}`;
  /** A claim of the wallet key whose window ended at `deadline`. */
  const deadline = NOW - HOUR;
  const mine = (overrides: Partial<ClaimDatum> = {}) => claimUtxo(claimToken, { claimerCredential: { type: 'VerificationKey', hash: WALLET.keyHash }, ...overrides }, 5 * HOUR);
  /** The transaction of buildWithdrawClaim, put together by hand, with `o` breaking one rule. Lucid evaluates the claim script on it. */
  async function assemble(claim: UTxO, o: { from?: number; signer?: string; pay?: bigint; burn?: boolean; continuing?: boolean } = {}) {
    const provider = juryWorld([claim]);
    const lucid = await lucidForAddress(provider, WALLET_ADDRESS);
    await chainClock(provider);
    const refs = await provider.getUtxosByOutRef([MODULE1.claim.ref, MODULE1.crossRefs, MODULE1.params]);
    const stake = decodeClaimDatum(claim.datum!).stakeAmount;
    let tx = lucid.newTx().collectFrom([claim], WITHDRAW_CLAIM_REDEEMER);
    if (o.burn !== false) tx = tx.mintAssets({ [unit]: -1n }, WITHDRAW_CLAIM_REDEEMER);
    tx = tx.pay.ToAddress(WALLET_ADDRESS, { lovelace: o.pay ?? stake });
    if (o.continuing) tx = tx.pay.ToContract(MODULE1.claim.address, { kind: 'inline', value: claim.datum! }, { lovelace: stake });
    return tx.readFrom(refs).addSignerKey(o.signer ?? WALLET.keyHash).validFrom(o.from ?? deadline + 1000).validTo(NOW + 30 * 60_000).complete();
  }
  const failed = /failed script execution/;

  test('a start at the end of the challenge window fails, a start one second later completes', async () => {
    await assert.rejects(assemble(mine(), { from: deadline }), failed);
    assert.ok((await assemble(mine(), { from: deadline + 1000 })).toHash());
  });
  test('a claim that was challenged fails, the Open claim completes', async () => {
    await assert.rejects(assemble(mine({ state: 'Challenged' })), failed);
    assert.ok((await assemble(mine())).toHash());
  });
  test('a required signer that is not the claimer credential fails, the claimer completes', async () => {
    await assert.rejects(assemble(mine(), { signer: STRANGER.keyHash }), failed);
    assert.ok((await assemble(mine(), { signer: WALLET.keyHash })).toHash());
  });
  test('a payout of one lovelace more than the stake fails, the exact stake completes', async () => {
    await assert.rejects(assemble(mine(), { pay: 50_000_001n }), failed);
    assert.ok((await assemble(mine(), { pay: 50_000_000n })).toHash());
  });
  test('a claim output that continues fails, none completes', async () => {
    await assert.rejects(assemble(mine(), { continuing: true }), failed);
    assert.ok((await assemble(mine(), { continuing: false })).toHash());
  });
  test('a claim token that is not burned fails, the burn completes', async () => {
    await assert.rejects(assemble(mine(), { burn: false }), failed);
    assert.ok((await assemble(mine(), { burn: true })).toHash());
  });
});
