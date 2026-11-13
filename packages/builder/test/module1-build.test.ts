// packages/builder/test/module1-build.test.ts
// The Module-1 SubmitClaim and OpenChallenge builders against the applied mainnet claim and challenge scripts (jury-world.ts): Lucid
// runs the real validators on each build, so a build that completes is one that Module-1 accepts, minus the signatures. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML, credentialToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { lucidForAddress } from '../src/vector/build.ts';
import { buildOpenChallenge, buildSubmitClaim, defaultChallengeWindow, findClaim } from '../src/vector/module1-build.ts';
import { SUBMIT_CLAIM_REDEEMER, TOKEN_PREFIX, decodeChallengeDatum, decodeClaimDatum, encodeClaimDatum, seedTokenName } from '../src/vector/jury-codec.ts';
import { utf8Hex } from '../src/vector/identity-codec.ts';
import { chainClock, windowAt } from '../src/vector/identity-chain.ts';
import {
  AUDITOR_ID, CHALLENGE_SCRIPT, CLAIMER_ID, CLAIM_SCRIPT, DAY, HOUR, IDENTITY_ADDRESS, IDENTITY_HASH, MODULE1, NOW, STRANGER, WALLET, WALLET_ADDRESS,
  WALLET_UTXOS, agentRecord, claimUtxo, juryWorld, recordUtxo,
} from './fixtures/jury-world.ts';
import type { FixtureProvider } from './fixtures/fixture-provider.ts';

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
