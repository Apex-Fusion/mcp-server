// packages/builder/test/vault-build.test.ts
// The vault builders (Part 2 Section 5.3) offline: open, Pay and Close against the real applied vault script (identity-world's
// deployment, local evaluation), with the delegation chain and records as reference inputs; and the Pay that the ledger judges
// (`ledgerDecides`: the node evaluates the scripts, here the evaluating fixture provider that runs the deployed scripts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { OGMIOS_ERROR_DATA_DEPTH_LIMIT, OGMIOS_ERROR_DATA_INPUT_LIMIT, OgmiosProvider, OgmiosRpcError } from '@apexfusion/vector-mcp-shared/provider';
import { CONTROLLER, DEPLOYMENT, NOW, DAY, OWN_ADDRESS, REF_UTXOS, identityWorld, lucidOn } from './fixtures/identity-world.ts';
import { FIXTURE_UTXOS } from './fixtures/fixture-provider.ts';
import { uplcEvaluatingProvider } from './fixtures/uplc-node.fixture.ts';
import {
  ADVERT_REF, AGENT_ID, DELEGATE_ID, DELEGATE_KEY, DELEGATION_ID, IDENTITY_ADVERT, OWN_PKH, PAYLOAD, advertUtxo, agentRecord, chainFake, delegateRecord, delegation,
  delegationUtxo, listedRow, liveVault, vaultUtxo,
} from './fixtures/escrow-identity.fixture.ts';
import {
  VaultPayEvaluationError, VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused, buildVaultOpen, buildVaultPay, buildVaultClose, isLedgerRefusal,
  judgeEvaluation,
} from '../src/vector/vault-build.ts';
import type { VaultPayAttempt } from '../src/vector/vault-build.ts';
import { decodeVaultDatum, encodeVaultDatum, encodeVaultSpend, plutusAddressFromBech32, utf8Hex } from '../src/vector/identity-codec.ts';
import { decodeIdentityEscrowDatum, encodeIdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';
import type { IdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';
import { EscrowPlanRefusal, planVaultEscrow, readAdvertFromNode } from '../src/vector/marketplace-build.ts';
import { MAX_ESCROW_LOVELACE } from '../src/vector/marketplace-constants.ts';
import type { PostEscrowPlan } from '../src/vector/marketplace-build.ts';
import { chainClock, windowAt } from '../src/vector/identity-chain.ts';

const outputs = (txCbor: string) => {
  const outs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  return Array.from({ length: outs.len() }, (_, i) => ({ address: outs.get(i).address().to_bech32(), lovelace: BigInt(outs.get(i).amount().coin().toString()), datum: outs.get(i).datum()?.as_datum()?.to_cbor_hex() ?? null }));
};
const requiredSigners = (txCbor: string): string[] => { const s = CML.Transaction.from_cbor_hex(txCbor).body().required_signers(); return s ? Array.from({ length: s.len() }, (_, i) => s.get(i).to_hex()) : []; };
const ctx = async (utxos: UTxO[]) => { const world = identityWorld(utxos); return { lucid: await lucidOn(world), provider: world, deployment: DEPLOYMENT }; };
const owner = { type: 'PrincipalKey' as const, hash: OWN_PKH, organisation: null };

describe('buildVaultOpen', () => {
  test('locks the AP3X at the vault address with Live { owner, delegation, spent 0, period_start 0 }', async () => {
    const r = await buildVaultOpen(await ctx([delegationUtxo()]), { changeAddress: OWN_ADDRESS, nowMs: NOW, delegation: DELEGATION_ID, amountLovelace: 40_000_000n });
    const [vault] = outputs(r.txCbor);
    assert.deepEqual([vault.address, vault.lovelace], [DEPLOYMENT.vault.address, 40_000_000n]);
    assert.deepEqual(decodeVaultDatum(vault.datum!), { type: 'Live', owner, delegation: DELEGATION_ID, spent: 0n, periodStart: 0 });
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [OWN_PKH]);
  });
  test('refuses a delegation that is missing, of another delegator, without a value limit, or that does not cover the hire', async () => {
    const open = async (utxos: UTxO[], over: Record<string, unknown> = {}) => buildVaultOpen(await ctx(utxos), { changeAddress: OWN_ADDRESS, nowMs: NOW, delegation: DELEGATION_ID, amountLovelace: 40_000_000n, ...over });
    await assert.rejects(open([]), /No live delegation/);
    await assert.rejects(open([delegationUtxo()], { owner: { type: 'Agent', id: AGENT_ID } }), /is principal key .*, not the owner agent did:vector:/);
    await assert.rejects(open([delegationUtxo(delegation({ value: null }))]), /has no value limit/);
    await assert.rejects(open([delegationUtxo(delegation({ actions: [utf8Hex('ocr.*')] }))]), /does not cover the action marketplace\.hire\.v1/);
    await assert.rejects(open([delegationUtxo(delegation({ resources: [] }))]), /does not cover the resource script:/);
    await assert.rejects(open([delegationUtxo()], { amountLovelace: 100_000n }), /ledger minimum/);
  });
});

describe('buildVaultPay (the real vault script)', () => {
  const world = (vault = liveVault(), over: { delegationUtxo?: UTxO; delegate?: UTxO; vaultLovelace?: bigint } = {}) => [
    vaultUtxo(vault, over.vaultLovelace), over.delegationUtxo ?? delegationUtxo(), over.delegate ?? delegateRecord(), agentRecord(),
  ];
  const pay = async (utxos: UTxO[], k = chainFake({ live: [advertUtxo()], listed: [listedRow()] })) =>
    buildVaultPay(await ctx(utxos), { changeAddress: OWN_ADDRESS, nowMs: NOW, vaultRef: `${'fa'.repeat(32)}#0`, advertRef: ADVERT_REF, payload: PAYLOAD }, k.f);

  test('pays one escrow (output 0) for the delegate key with the vault refund, and keeps the rest in the vault with the new period', async () => {
    const r = await pay(world());
    const [escrow, vault] = outputs(r.txCbor);
    assert.equal(escrow.address, DEPLOYMENT.escrow.address);
    const datum = decodeIdentityEscrowDatum(escrow.datum!);
    assert.equal(datum.buyer_pkh, DELEGATE_KEY.keyHash);
    assert.deepEqual(datum.refund, { address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) });
    assert.equal(datum.agent_id, AGENT_ID);
    assert.equal(escrow.lovelace, datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace, 'the escrow holds exactly payment + both bonds');
    assert.equal(datum.buyer_bond_lovelace, 1_000_000n, 'amounts above the lock floor stay as the advert says');
    assert.ok(datum.deliver_by <= r.validTo + 7 * DAY);
    assert.equal(vault.address, DEPLOYMENT.vault.address);
    assert.equal(vault.lovelace, 100_000_000n - escrow.lovelace);
    assert.deepEqual(decodeVaultDatum(vault.datum!), { type: 'Live', owner, delegation: DELEGATION_ID, spent: escrow.lovelace, periodStart: r.validTo });
    assert.deepEqual([r.newPeriod, r.escrowRef, r.vaultRef], [true, `${r.txHash}#0`, `${r.txHash}#1`]);
    assert.deepEqual(requiredSigners(r.txCbor), [DELEGATE_KEY.keyHash]);
  });
  test('within a running period the spending grows', async () => {
    const r = await pay(world(liveVault({ spent: 10_000_000n, periodStart: NOW - 3_600_000 })));
    assert.equal(r.newPeriod, false);
    assert.equal(r.spent, 10_000_000n + r.amountLovelace);
    assert.equal(r.periodStart, NOW - 3_600_000);
  });
  test('when the lock floor is above the advert\'s amounts, the top-up goes into the buyer bond, so the escrow still holds exactly payment + both bonds', async () => {
    const small = { ...IDENTITY_ADVERT, price_lovelace: 100_000n, supplier_bond_lovelace: 100_000n, buyer_bond_lovelace: 100_000n };
    const r = await pay(world(), chainFake({ live: [advertUtxo(small)], listed: [listedRow()] }));
    const [escrow] = outputs(r.txCbor);
    const datum = decodeIdentityEscrowDatum(escrow.datum!);
    assert.ok(escrow.lovelace > 300_000n);
    assert.equal(datum.buyer_bond_lovelace, escrow.lovelace - 200_000n);
    assert.equal(escrow.lovelace, datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace);
  });
  test('refuses what the vault and the delegation do not allow', async () => {
    await assert.rejects(pay(world(liveVault(), { delegationUtxo: delegationUtxo(delegation({ value: { perTx: 1_000_000n, total: 100_000_000n, periodMs: DAY } })) })), /above the per-transaction limit/);
    await assert.rejects(pay(world(liveVault({ spent: 99_000_000n, periodStart: NOW - 3_600_000 }))), /above the total limit/);
    await assert.rejects(pay(world(liveVault(), { delegate: delegateRecord({ keys: [] }) })), /no longer lists the delegate key/);
    await assert.rejects(pay(world(liveVault(), { delegationUtxo: delegationUtxo(delegation({ notAfter: NOW })) })), /ends at .* before the end of the validity window/);
    await assert.rejects(pay(world({ type: 'Returned', owner })), /holds an escrow refund \(Returned\)/);
    await assert.rejects(pay(world(liveVault(), { vaultLovelace: 5_000_000n })), /below the \d+ its output needs/);
    await assert.rejects(pay(world(), chainFake({ live: [advertUtxo()], listed: [] })), /is not listed by the marketplace indexer/);
  });
});

describe('the vault script: each escrow output of a Pay holds exactly payment + both bonds (Part 2 Section 5.3)', () => {
  // A Pay assembled as buildVaultPay assembles it, with the escrow output that `escrow` makes from the plan; the vault pays exactly
  // that output. The vault script of agents-marketplace 1643583 (valid_escrow_output) refuses an escrow output whose AP3X is not the
  // payment + buyer bond + supplier bond of its datum.
  async function shape(advert: typeof IDENTITY_ADVERT, escrow: (plan: PostEscrowPlan) => { datumHex: string; lovelace: bigint }) {
    const vault = vaultUtxo(liveVault());
    const link = delegationUtxo();
    const delegate = delegateRecord();
    const provider = identityWorld([vault, link, delegate]);
    const lucid = await lucidOn(provider);
    await chainClock(provider);
    const window = windowAt(NOW);
    const refund = { address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) };
    const out = escrow(planVaultEscrow(advert, ADVERT_REF, DELEGATE_KEY.keyHash, PAYLOAD, window, { agentId: AGENT_ID, refund }));
    const next = encodeVaultDatum({ type: 'Live', owner, delegation: DELEGATION_ID, spent: out.lovelace, periodStart: window.hi });
    return lucid.newTx()
      .readFrom([REF_UTXOS[3], link, delegate])
      .collectFrom([vault], encodeVaultSpend({ type: 'Pay' }))
      .pay.ToAddressWithData(DEPLOYMENT.escrow.address, { kind: 'inline', value: out.datumHex }, { lovelace: out.lovelace })
      .pay.ToAddressWithData(DEPLOYMENT.vault.address, { kind: 'inline', value: next }, { lovelace: 100_000_000n - out.lovelace })
      .addSignerKey(DELEGATE_KEY.keyHash)
      .validFrom(window.lo)
      .validTo(window.hi)
      .complete();
  }
  const asPlanned = (plan: PostEscrowPlan) => ({ datumHex: plan.datumHex, lovelace: plan.lockLovelace });

  test('the planned escrow output passes; one lovelace above payment + both bonds fails', async () => {
    await shape(IDENTITY_ADVERT, asPlanned);
    await assert.rejects(shape(IDENTITY_ADVERT, (plan) => ({ ...asPlanned(plan), lovelace: plan.lockLovelace + 1n })), /failed script execution Spend/);
  });
  test('a lock floor above the advert\'s amounts passes only with the top-up in the buyer bond', async () => {
    const small = { ...IDENTITY_ADVERT, price_lovelace: 100_000n, supplier_bond_lovelace: 100_000n, buyer_bond_lovelace: 100_000n };
    await shape(small, asPlanned);
    const withoutTopUp = (plan: PostEscrowPlan) => ({ datumHex: encodeIdentityEscrowDatum({ ...(plan.datum as IdentityEscrowDatum), buyer_bond_lovelace: 100_000n }), lovelace: plan.lockLovelace });
    await assert.rejects(shape(small, withoutTopUp), /failed script execution Spend/);
  });
});

describe('buildVaultClose (the real vault script)', () => {
  test('the principal-key owner closes a Live and a Returned output at once; everything goes to the wallet', async () => {
    const utxos = [vaultUtxo(liveVault(), 30_000_000n, 0), vaultUtxo({ type: 'Returned', owner }, 2_000_000n, 1)];
    const r = await buildVaultClose(await ctx(utxos), { changeAddress: OWN_ADDRESS, nowMs: NOW, vaultRefs: [`${'fa'.repeat(32)}#0`, `${'fa'.repeat(32)}#1`] });
    assert.equal(r.totalLovelace, 32_000_000n);
    assert.deepEqual(requiredSigners(r.txCbor), [OWN_PKH]);
    assert.ok(outputs(r.txCbor).every((o) => o.address === OWN_ADDRESS));
  });
  test('an agent owner closes through its controller, with its record as a reference input', async () => {
    const record = agentRecord();
    const utxos = [vaultUtxo({ type: 'Returned', owner: { type: 'Agent', id: AGENT_ID } }, 3_000_000n), record];
    const r = await buildVaultClose(await ctx(utxos), { changeAddress: OWN_ADDRESS, nowMs: NOW, vaultRefs: [`${'fa'.repeat(32)}#0`] });
    assert.deepEqual(requiredSigners(r.txCbor), [CONTROLLER.keyHash]);
    const refs = CML.Transaction.from_cbor_hex(r.txCbor).body().reference_inputs()!;
    assert.ok(Array.from({ length: refs.len() }, (_, i) => refs.get(i).transaction_id().to_hex()).includes(record.txHash));
  });
  test('refuses an output that is not a vault', async () => {
    await assert.rejects(buildVaultClose(await ctx([]), { changeAddress: OWN_ADDRESS, nowMs: NOW, vaultRefs: [`${'fa'.repeat(32)}#0`] }), /is not an unspent output on the node/);
  });
});

// ─── Pay, with the ledger as the judge ──────────────────────────────────────────────────────────────────────────────────────────

/** The tip of the fixtures' chain at NOW: it starts at 1756485600000 and has a slot each second. */
const TIP_SLOT = (NOW - 1_756_485_600_000) / 1000;
const VAULT_REF = `${'fa'.repeat(32)}#0`;
/** The fetch of a build that the ledger decides: it must not be called, because the advert comes from the node and no listing is asked. */
const noFetch = (async () => { throw new Error('the network was touched'); }) as typeof fetch;
const payParams = { changeAddress: OWN_ADDRESS, nowMs: NOW, vaultRef: VAULT_REF, advertRef: ADVERT_REF, payload: PAYLOAD };

/** The shape of the error bodies of Ogmios that these tests read and change. */
interface ValidatorBody { validator: { index: number; purpose: string }; error: { code: number; message: string; data: { validationError?: string; reason?: string; traces: unknown[] } } }
interface ErrorBody { error: { code: number; message: string; data?: ValidatorBody[] | Record<string, unknown> } }
const validatorsOf = (body: ErrorBody): ValidatorBody[] => body.error.data as ValidatorBody[];
/** The real error bodies that mainnet Ogmios answered with (capture-ogmios-evaluation-errors.mjs): the HTTP status and the body of each case. */
const OGMIOS_ERRORS: Record<string, { httpStatus: number; body: ErrorBody }> =
  JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/ogmios-evaluation-errors-mainnet.json'), 'utf8')).cases;
/** The answer of the node for a case of the fixture, as a Response; `patch` changes a copy of the body first. */
function answerOf(name: string, patch: (body: ErrorBody) => void = () => {}): Response {
  const body = structuredClone(OGMIOS_ERRORS[name].body);
  patch(body);
  return new Response(JSON.stringify(body), { status: OGMIOS_ERRORS[name].httpStatus, statusText: 'Bad Request' });
}

/** The error that `OgmiosProvider.evaluateTx` raises when its node answers with `answer`, or does not answer: the real provider, with the answer in place of the network. */
async function ogmiosRaised(answer: Response | Error): Promise<unknown> {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = (async () => { if (answer instanceof Error) throw answer; return answer; }) as typeof fetch;
  console.error = () => {};
  try {
    await new OgmiosProvider({ ogmiosUrl: 'http://ogmios.test', submitUrl: 'http://submit.test' }).evaluateTx('00');
  } catch (err) {
    return err;
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  return assert.fail('evaluateTx did not throw');
}

describe('buildVaultPay with ledgerDecides (the node evaluates the scripts)', () => {
  /** What the node holds for a payment: the vault, its delegation, the delegate, the agent of the advert and the advert. */
  const held = (vault = liveVault(), over: { delegationUtxo?: UTxO; delegate?: UTxO; vaultLovelace?: bigint; advert?: UTxO } = {}): UTxO[] => [
    vaultUtxo(vault, over.vaultLovelace), over.delegationUtxo ?? delegationUtxo(), over.delegate ?? delegateRecord(), agentRecord(), over.advert ?? advertUtxo(),
  ];
  const without = (utxos: UTxO[], keep: (u: UTxO) => boolean): UTxO[] => utxos.filter(keep);
  /**
   * A node that evaluates the scripts for real, and answers a validator that failed as Ogmios does: the 3010 with a 3012 of the real
   * fixture (above_per_tx), with the text of the evaluator as the detail of the validator.
   */
  const node = (utxos: UTxO[]) => {
    const provider = uplcEvaluatingProvider([...FIXTURE_UTXOS, ...REF_UTXOS, ...utxos], TIP_SLOT);
    const evaluate = provider.evaluateTx;
    return Object.assign(provider, {
      evaluateTx: async (tx: string, additional?: UTxO[]) => {
        try { return await evaluate(tx, additional); } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          const place = /\b(Spend|Mint|Publish|Withdraw|Vote|Propose)\[(\d+)\]/.exec(text);
          throw await ogmiosRaised(answerOf('above_per_tx', (body) => {
            const [validator] = validatorsOf(body);
            validator.error.data.validationError = text;
            if (place) { validator.validator.purpose = place[1].toLowerCase(); validator.validator.index = Number(place[2]); }
          }));
        }
      },
    });
  };
  const decide = async (utxos: UTxO[], over: Record<string, unknown> = {}, provider = node(utxos)) => {
    const lucid = await lucidOn(provider);
    return { provider, run: () => buildVaultPay({ lucid, provider, deployment: DEPLOYMENT }, { ...payParams, ledgerDecides: true, ...over }, noFetch) };
  };
  const byDefault = async (utxos: UTxO[], k = chainFake({ live: [advertUtxo()], listed: [listedRow()] })) => buildVaultPay(await ctx(utxos), payParams, k.f);
  /** What a promise rejects with; the test fails when it completes. */
  const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => assert.fail('the build completed'), (err: unknown) => err);
  /** The refusal is the node's: the evidence is the draft that the node evaluated last, which pays the planned amount out of the vault. */
  const assertEvidence = (error: unknown, provider: { evaluations: string[] }): VaultPayRefused => {
    assert.ok(error instanceof VaultPayRefused, `a ledger refusal, not ${String(error)}`);
    assert.ok(!(error instanceof VaultPayImpossible));
    assert.equal(provider.evaluations.length > 0 && error.draftTx, provider.evaluations[provider.evaluations.length - 1], 'the draft is the last transaction that the node evaluated');
    assert.equal(error.evaluationError, '3010 Some scripts of the transactions terminated with error(s).');
    assert.ok(error.cause instanceof OgmiosRpcError && error.cause.method === 'evaluateTransaction' && error.cause.code === 3010, 'the cause is the error of the node');
    assert.ok(isLedgerRefusal(error.cause) && isLedgerRefusal(error), 'the refusal is told by type');
    assert.deepEqual(error.validators.map((v) => v.code), [3012]);
    assert.match(error.validators[0].detail!, /failed script execution/, 'the text of the evaluator is the detail of the validator');
    const [escrow] = outputs(error.draftTx);
    assert.deepEqual([escrow.address, escrow.lovelace], [DEPLOYMENT.escrow.address, error.attempt.amountLovelace], 'the draft pays the escrow that the builder planned');
    const inputs = CML.Transaction.from_cbor_hex(error.draftTx).body().inputs();
    assert.ok(Array.from({ length: inputs.len() }, (_, i) => `${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`).includes(VAULT_REF), 'the draft spends the vault');
    const draft = CML.Transaction.from_cbor_hex(error.draftTx);
    assert.ok(!draft.body().collateral_inputs() && !draft.body().collateral_return(), 'the draft has no collateral');
    assert.deepEqual(requiredSigners(error.draftTx), [DELEGATE_KEY.keyHash], 'the draft asks for the delegate key');
    const witnesses = draft.witness_set().vkeywitnesses();
    assert.ok(witnesses !== undefined && witnesses.len() > 0, 'Lucid adds placeholder witnesses to size the draft');
    for (let i = 0; i < witnesses.len(); i++) assert.notEqual(witnesses.get(i).vkey().hash().to_hex(), DELEGATE_KEY.keyHash, 'no witness is the real key');
    assert.match(JSON.stringify(draft.witness_set().redeemers()?.to_js_value()), /"ex_units":\{"mem":0,"steps":0\}/, 'the redeemers have zero execution units');
    return error;
  };

  test('a valid payment gives the build that the default path gives; the node evaluated it, and neither Koios nor the indexer was asked', async () => {
    const utxos = held();
    const expected = await byDefault(utxos);
    const { provider, run } = await decide(utxos);
    assert.deepEqual(await run(), expected);
    assert.ok(provider.evaluations.length >= 1, 'the node was asked to evaluate the scripts');
  });

  test('a payment above per_tx: VaultPayRefused with the draft transaction; the default path refuses in its own words', async () => {
    const tight = held(liveVault(), { delegationUtxo: delegationUtxo(delegation({ value: { perTx: 1_000_000n, total: 100_000_000n, periodMs: DAY } })) });
    const { provider, run } = await decide(tight);
    const refused = assertEvidence(await rejection(run()), provider);
    assert.ok(refused.attempt.amountLovelace > refused.attempt.limit.perTx, 'the payment is above per_tx');
    await assert.rejects(byDefault(tight), /above the per-transaction limit/);
    assert.ok(!((await rejection(byDefault(tight))) instanceof VaultPayRefused), 'the default path never throws the ledger refusal');
  });

  test('a payment past total: VaultPayRefused with the draft transaction; the default path refuses in its own words', async () => {
    const spentUp = held(liveVault({ spent: 99_000_000n, periodStart: NOW - 3_600_000 }));
    const { provider, run } = await decide(spentUp);
    const refused = assertEvidence(await rejection(run()), provider);
    assert.ok(refused.attempt.spent > refused.attempt.limit.total && !refused.attempt.newPeriod, 'the period total is passed in the running period');
    await assert.rejects(byDefault(spentUp), /above the total limit/);
  });

  test('the use checks of the delegation are the ledger\'s: a delegate key that is not listed any more, a delegation that ends before the window', async () => {
    for (const [why, utxos, own] of [
      ['the delegate lists no key', held(liveVault(), { delegate: delegateRecord({ keys: [] }) }), /no longer lists the delegate key/],
      ['the delegation ends inside the window', held(liveVault(), { delegationUtxo: delegationUtxo(delegation({ notAfter: NOW })) }), /ends at .* before the end of the validity window/],
    ] as const) {
      const { provider, run } = await decide(utxos);
      assertEvidence(await rejection(run()), provider);
      await assert.rejects(byDefault(utxos), own, why);
    }
  });

  test('the delegator and the assets of the vault are the ledger\'s too', async () => {
    const stranger = delegationUtxo(delegation({ delegator: { type: 'PrincipalKey', hash: '99'.repeat(28), organisation: null } }));
    const tokens = vaultUtxo(liveVault(), 100_000_000n, 0, { assets: { lovelace: 100_000_000n, ['ab'.repeat(28) + '01']: 1n } });
    const cases: Array<[UTxO[], RegExp]> = [
      [held(liveVault(), { delegationUtxo: stranger }), /is not the owner of vault/],
      [[tokens, ...held().slice(1)], /holds assets other than AP3X/],
    ];
    for (const [utxos, own] of cases) {
      const { provider, run } = await decide(utxos);
      assertEvidence(await rejection(run()), provider);
      await assert.rejects(byDefault(utxos), own);
    }
  });

  test('the indexer and the listing rule are not asked: an advert that is not listed, and an agent that has no record, still build', async () => {
    const noAgent = without(held(), (u) => u.assets[`${DEPLOYMENT.identity.hash}${AGENT_ID}`] === undefined);
    await assert.rejects(byDefault(held(), chainFake({ live: [advertUtxo()], listed: [] })), /is not listed by the marketplace indexer/);
    await assert.rejects(byDefault(noAgent), /has no record in the identity registry/);
    for (const utxos of [held(), noAgent]) {
      const { provider, run } = await decide(utxos);
      assert.ok((await run()).txCbor);
      assert.ok(provider.evaluations.length >= 1);
    }
  });

  test('what makes the transaction impossible is refused with VaultPayImpossible, before the node evaluates anything', async () => {
    const cases: Array<[string, UTxO[], string, RegExp]> = [
      ['no vault output', without(held(), (u) => u.address !== DEPLOYMENT.vault.address), 'no_vault', /Vault .* is not an unspent output on the node/],
      ['a vault that is not Live', held({ type: 'Returned', owner }), 'vault_not_live', /holds an escrow refund \(Returned\)/],
      ['no delegation output', without(held(), (u) => u.address !== DEPLOYMENT.delegation.address), 'no_delegation', /No live delegation/],
      ['no record of the delegate', without(held(), (u) => u.assets[`${DEPLOYMENT.identity.hash}${DELEGATE_ID}`] === undefined), 'no_delegation', /record of the delegate/],
      ['a delegation without a value limit', held(liveVault(), { delegationUtxo: delegationUtxo(delegation({ value: null })) }), 'no_delegation', /has no value limit/],
      ['no advert output', without(held(), (u) => u.address !== DEPLOYMENT.advert.address), 'no_advert', /The node has no unspent output/],
      ['an output that is no advert', held(liveVault(), { advert: advertUtxo(IDENTITY_ADVERT, { address: DEPLOYMENT.escrow.address }) }), 'no_advert', /is not at the advert address/],
      ['an advert that is retired', held(liveVault(), { advert: advertUtxo({ ...IDENTITY_ADVERT, status: 'Retired' }) }), 'no_advert', /is retired/],
      ['a delegate key that is the supplier key of the advert', held(liveVault(), { advert: advertUtxo({ ...IDENTITY_ADVERT, supplier_pkh: DELEGATE_KEY.keyHash }) }), 'buyer_is_supplier', /cannot be the supplier of the same advert/],
      ['a processing window above 24 h', held(liveVault(), { advert: advertUtxo({ ...IDENTITY_ADVERT, max_processing_ms: 90_000_000 }) }), 'advert_terms', /processing window of 90000000 ms/],
      ['an endpoint without a host', held(liveVault(), { advert: advertUtxo({ ...IDENTITY_ADVERT, endpoint_url: 'not a url' }) }), 'advert_terms', /not a usable URL with a host/],
      ['a rest below the ledger minimum of the vault output', held(liveVault(), { vaultLovelace: 5_000_000n }), 'below_minimum', /below the \d+ its output needs/],
    ];
    for (const [why, utxos, reason, words] of cases) {
      const { provider, run } = await decide(utxos);
      const error = await rejection(run());
      assert.ok(error instanceof VaultPayImpossible, `${why}: ${String(error)}`);
      assert.ok(!(error instanceof VaultPayRefused));
      assert.equal(error.reason, reason, why);
      assert.match(error.message, words, why);
      assert.equal(isLedgerRefusal(error), false, why);
      assert.equal(provider.evaluations.length, 0, `${why}: the node evaluated nothing`);
    }
  });

  test('the refusal of a fleet capability stays: it comes before the node evaluates anything, in the words of the default path, and the same payment for an ordinary capability builds', async () => {
    for (const capability_id of ['llm.text.generate.v1', 'llm.chat.v1', 'ocr.page.extract.v1', 'audio.synthesize.v1']) {
      const fleet = advertUtxo({ ...IDENTITY_ADVERT, capability_id });
      const { provider, run } = await decide(held(liveVault(), { advert: fleet }));
      const error = await rejection(run());
      assert.ok(error instanceof VaultPayImpossible && error.reason === 'advert_terms', `${capability_id}: ${String(error)}`);
      assert.equal(provider.evaluations.length, 0, `${capability_id}: the node evaluated nothing`);
      const byDefaultError = await rejection(byDefault(held(liveVault(), { advert: fleet }), chainFake({ live: [fleet], listed: [listedRow()] })));
      assert.match(error.message, /a fleet capability \(llm\.text\.generate\.\*, llm\.chat\.\*, ocr\.page\.extract\.\* or audio\.synthesize\.\*\)/, capability_id);
      assert.equal(error.message, (byDefaultError as Error).message, `${capability_id}: the words of the default path`);
    }
    const { provider, run } = await decide(held());
    assert.ok((await run()).txCbor, 'the twin, an advert of an ordinary capability, builds');
    assert.ok(provider.evaluations.length >= 1);
  });

  test('a failure of the node is neither a refusal nor an impossible transaction', async () => {
    const down = async () => { throw new Error('Ogmios request failed (queryLedgerState/utxo): 503 Service Unavailable'); };
    for (const read of ['getUtxosByOutRef', 'getUtxos'] as const) {
      const { provider, run } = await decide(held());
      Object.assign(provider, { [read]: down });
      const error = await rejection(run());
      assert.ok(!(error instanceof VaultPayImpossible) && !(error instanceof VaultPayRefused), `${read}: ${String(error)}`);
      assert.match(String(error), /503 Service Unavailable/);
    }
  });

  test('the real error bodies of mainnet: a payment above per_tx and a payment past total are refused with the error of each validator; the 3004 of a validity range past the era horizon is not a refusal', async () => {
    for (const [name, refused] of [['above_per_tx', true], ['past_total', true], ['past_horizon', false]] as const) {
      const { provider, run } = await decide(held());
      Object.assign(provider, { evaluateTx: async (tx: string) => { provider.evaluations.push(tx); throw await ogmiosRaised(answerOf(name)); } });
      const error = await rejection(run());
      assert.ok(error instanceof VaultPayEvaluationError && !(error instanceof VaultPayImpossible), `${name}: ${String(error)}`);
      assert.equal(error instanceof VaultPayRefused, refused, name);
      assert.equal(error instanceof VaultPayNotEvaluated, !refused, name);
      assert.equal(isLedgerRefusal(error), refused, name);
      assert.equal(error.draftTx, provider.evaluations[provider.evaluations.length - 1], `${name}: the draft that the node was asked to evaluate`);
      assert.equal(error.evaluationError, '3010 Some scripts of the transactions terminated with error(s).');
      assert.ok(error.cause instanceof OgmiosRpcError && error.cause.code === 3010 && error.cause.method === 'evaluateTransaction');
      assert.equal(error.validators.length, 1, name);
      const [validator] = error.validators;
      assert.deepEqual([validator.purpose, validator.index, validator.code], ['spend', 1, refused ? 3012 : 3004], name);
      assert.match(validator.message, refused ? /failed to evaluate to a positive outcome/ : /Unable to create the evaluation context/, name);
      assert.match(validator.detail!, refused ? /The machine terminated because of an error/ : /PastHorizon/, name);
      assert.deepEqual(validator.traces, [], name);
    }
  });

  test('an answer that is no verdict of the node is neither: no answer, a timeout, an answer that is no JSON-RPC error, a body that is null, a node that is down', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const cases: Array<[Response | Error, RegExp]> = [
      [new Error('fetch failed'), /Ogmios request failed \(evaluateTransaction\)/],
      [timeout, /Ogmios request failed \(evaluateTransaction\)/],
      [new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }), /Ogmios request failed \(evaluateTransaction\)/],
      [new Response('not json', { status: 200 }), /Ogmios request failed \(evaluateTransaction\)/],
      [new Response('null', { status: 200 }), /Cannot read properties of null/],
    ];
    for (const [answer, words] of cases) {
      const { provider, run } = await decide(held());
      Object.assign(provider, { evaluateTx: async (tx: string) => { provider.evaluations.push(tx); throw await ogmiosRaised(answer); } });
      const error = await rejection(run());
      assert.ok(error instanceof Error && !(error instanceof VaultPayEvaluationError) && !(error instanceof VaultPayImpossible), String(error));
      assert.equal(isLedgerRefusal(error), false);
      assert.match(String(error), words);
    }
  });

  test('an error of the call that is no answer of the node is no verdict, whatever it says: a network error, a timeout, a refused connection, and the text of an evaluator', async () => {
    const failures = [
      new TypeError('fetch failed'),
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1337'), { code: 'ECONNREFUSED' }),
      new Error('failed script execution\n Spend[1] the validator crashed / exited prematurely'),
    ];
    for (const failure of failures) {
      const { provider, run } = await decide(held());
      Object.assign(provider, { evaluateTx: async (tx: string) => { provider.evaluations.push(tx); throw failure; } });
      const error = await rejection(run());
      assert.ok(!(error instanceof VaultPayEvaluationError) && !(error instanceof VaultPayImpossible), `${failure.message}: ${String(error)}`);
      assert.equal(isLedgerRefusal(error), false, failure.message);
    }
  });

  test('the value cap of an escrow is the ledger\'s: a lock above 10,000 AP3X is refused by the vault script, and the default path refuses it in its own words', async () => {
    const rich = { ...IDENTITY_ADVERT, price_lovelace: MAX_ESCROW_LOVELACE + 1_000_000n };
    const limit = { perTx: 2n * MAX_ESCROW_LOVELACE, total: 2n * MAX_ESCROW_LOVELACE, periodMs: DAY };
    const utxos = held(liveVault(), { delegationUtxo: delegationUtxo(delegation({ value: limit })), advert: advertUtxo(rich), vaultLovelace: 2n * MAX_ESCROW_LOVELACE });
    const { provider, run } = await decide(utxos);
    const refused = assertEvidence(await rejection(run()), provider);
    assert.ok(refused.attempt.amountLovelace > MAX_ESCROW_LOVELACE, 'the lock is above the cap');
    await assert.rejects(byDefault(utxos, chainFake({ live: [advertUtxo(rich)], listed: [listedRow()] })), /value cap of an escrow \(F-29\)/);
  });

  test('the payload is an input, not a fact about the advert: an empty one is an ordinary error', async () => {
    const { run } = await decide(held(), { payload: '' });
    const error = await rejection(run());
    assert.ok(!(error instanceof VaultPayImpossible) && !(error instanceof VaultPayRefused));
    assert.match(String(error), /payload must be a non-empty string/);
  });

  test('with the option false the default path runs: Koios is asked for the advert, and the scripts are evaluated on this machine', async () => {
    const { provider, run } = await decide(held(), { ledgerDecides: false });
    const error = await rejection(run());
    assert.ok(error instanceof Error && !(error instanceof VaultPayRefused) && !(error instanceof VaultPayImpossible));
    assert.match(error.message, /Could not read advert .*the network was touched/);
    assert.equal(provider.evaluations.length, 0, 'the node evaluated nothing');
  });
});

describe('judgeEvaluation and isLedgerRefusal, against the errors that OgmiosProvider raises', () => {
  const kindOf = async (answer: Response | Error) => judgeEvaluation(await ogmiosRaised(answer)).kind;
  const deepArray = (levels: number): unknown[] => { let value: unknown[] = []; for (let i = 1; i < levels; i += 1) value = [value]; return value; };

  test('a validator of the transaction ran and failed (3010 with a 3012 inside): a refusal; with the error of each validator', async () => {
    for (const name of ['above_per_tx', 'past_total']) {
      const error = await ogmiosRaised(answerOf(name));
      assert.deepEqual([judgeEvaluation(error).kind, isLedgerRefusal(error)], ['refused', true], name);
    }
  });
  test('the same top-level code without a failed validator is no refusal: the 3004 of the era horizon, another code inside, no data, data that is no list, a cut text', async () => {
    assert.equal(await kindOf(answerOf('past_horizon')), 'not_evaluated');
    assert.equal(await kindOf(answerOf('above_per_tx', (b) => { validatorsOf(b)[0].error.code = 3011; })), 'not_evaluated', 'a validator error that is no failure');
    assert.equal(await kindOf(answerOf('above_per_tx', (b) => { b.error.code = 3011; })), 'not_evaluated', 'another top-level code');
    assert.equal(await kindOf(answerOf('above_per_tx', (b) => { delete b.error.data; })), 'not_evaluated', 'no data');
    assert.equal(await kindOf(answerOf('above_per_tx', (b) => { b.error.data = { validator: 'none' }; })), 'not_evaluated', 'data that is no list');
    assert.equal(await kindOf(answerOf('above_per_tx', (b) => { validatorsOf(b)[0].error.data.traces = ['x'.repeat(40_000)]; })), 'not_evaluated', 'a text that is cut is no proof');
    const tooLarge = (b: ErrorBody) => { validatorsOf(b)[0].error.data.traces = ['x'.repeat(OGMIOS_ERROR_DATA_INPUT_LIMIT)]; };
    assert.equal(await kindOf(answerOf('above_per_tx', tooLarge)), 'not_evaluated', 'a data that the provider dropped for its size is no proof');
    assert.equal(await kindOf(answerOf('above_per_tx', (b) => { validatorsOf(b)[0].error.data.traces = [deepArray(OGMIOS_ERROR_DATA_DEPTH_LIMIT)]; })), 'not_evaluated', 'a data that the provider dropped for its depth is no proof');
    const dropped = await ogmiosRaised(answerOf('above_per_tx', tooLarge));
    assert.ok(dropped instanceof OgmiosRpcError && dropped.dataDropped && dropped.data === null);
    assert.deepEqual([judgeEvaluation(dropped).validators, isLedgerRefusal(dropped)], [[], false]);
    const error = await ogmiosRaised(answerOf('past_horizon'));
    assert.ok(error instanceof OgmiosRpcError && judgeEvaluation(error).validators[0].code === 3004);
    assert.equal(isLedgerRefusal(error), false);
  });
  test('other errors that the node answers with are not evaluations either: the tip is too old, the transaction is malformed', async () => {
    const rpc = (code: number, message: string, status: number, statusText: string) => new Response(JSON.stringify({ error: { code, message } }), { status, statusText });
    assert.equal(await kindOf(rpc(3003, 'The node is too far behind.', 200, 'OK')), 'not_evaluated');
    assert.equal(await kindOf(rpc(-32602, 'Invalid transaction', 400, 'Bad Request')), 'not_evaluated');
  });
  test('an entry that is not in the shape of Ogmios is left out, a text that is not JSON is no validator, and the traces keep only their texts', async () => {
    const entry = (patch: (e: ValidatorBody) => void) => (b: ErrorBody) => {
      const good = validatorsOf(b)[0];
      const bad = structuredClone(good);
      patch(bad);
      b.error.data = [bad, good, structuredClone(good)];
      validatorsOf(b)[2].error.data.traces = ['first', 7, 'second'];
    };
    const wrong: Array<[string, (e: ValidatorBody) => void]> = [
      ['no purpose', (e) => { delete (e.validator as Partial<ValidatorBody['validator']>).purpose; }],
      ['an index that is no number', (e) => { (e.validator as { index: unknown }).index = '1'; }],
      ['a code that is no number', (e) => { (e.error as { code: unknown }).code = '3012'; }],
      ['no message', (e) => { delete (e.error as Partial<ValidatorBody['error']>).message; }],
    ];
    for (const [why, patch] of wrong) {
      const { validators } = judgeEvaluation(await ogmiosRaised(answerOf('above_per_tx', entry(patch))));
      assert.equal(validators.length, 2, `${why}: only the entries in the shape of Ogmios are kept`);
      assert.deepEqual(validators[1].traces, ['first', 'second'], why);
    }
    const text = judgeEvaluation(await ogmiosRaised(new Response(JSON.stringify({ error: { code: 3010, message: 'm', data: 'not a list' } }), { status: 400 })));
    assert.deepEqual([text.kind, text.validators], ['not_evaluated', []]);
  });
  test('no answer, an answer that is unreadable, and a status without a JSON-RPC error are no answer of the node', async () => {
    assert.equal(await kindOf(new Error('fetch failed')), 'no_answer');
    assert.equal(await kindOf(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 'no_answer', 'a timeout');
    assert.equal(await kindOf(new Response('not json', { status: 200 })), 'no_answer');
    assert.equal(await kindOf(new Response('null', { status: 200 })), 'no_answer', 'a body that is null');
    for (const status of [429, 500, 502, 503, 504]) assert.equal(await kindOf(new Response('down', { status, statusText: 'Down' })), 'no_answer', String(status));
  });
  test('an error that OgmiosProvider did not raise for an answer of the node is no verdict, whatever its text says: a network error, a timeout, a refused connection, the text of an evaluator, a string', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1337'), { code: 'ECONNREFUSED' });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const evaluator = new Error('failed script execution\n Spend[1] the validator crashed / exited prematurely');
    for (const err of [new TypeError('fetch failed'), timeout, refused, evaluator, new Error('3010 Some scripts of the transactions terminated with error(s).'), 'the validator crashed', null, undefined]) {
      const verdict = judgeEvaluation(err);
      assert.deepEqual([verdict.kind, verdict.validators], ['no_answer', []], String(err));
      assert.equal(isLedgerRefusal(err), false, String(err));
    }
  });
  test('the method decides: an error of another method with the 3010 and a failed validator in it is no refusal', () => {
    const { error } = OGMIOS_ERRORS.above_per_tx.body;
    const raised = (method: string) => new OgmiosRpcError('message', method, error.code, error.message, JSON.stringify(error.data), false);
    assert.equal(judgeEvaluation(raised('evaluateTransaction')).kind, 'refused');
    for (const method of ['queryLedgerState/tip', 'submitTransaction', 'evaluate']) {
      assert.equal(judgeEvaluation(raised(method)).kind, 'not_evaluated', method);
      assert.equal(isLedgerRefusal(raised(method)), false, method);
    }
  });
  test('a URL in a trace of a validator leaves a refusal a refusal: the data is scrubbed string by string, and it stays JSON', async () => {
    const error = await ogmiosRaised(answerOf('above_per_tx', (b) => { validatorsOf(b)[0].error.data.traces = ['see https://example.org/doc', 'then https://example.org/other.']; }));
    assert.ok(error instanceof OgmiosRpcError && !error.dataTruncated);
    const verdict = judgeEvaluation(error);
    assert.equal(verdict.kind, 'refused');
    assert.deepEqual(verdict.validators[0].traces, ['see [endpoint]', 'then [endpoint]']);
  });
  test('isLedgerRefusal unwraps the cause of a VaultPayRefused only: a VaultPayNotEvaluated that holds a refusal is no refusal', async () => {
    const cause = await ogmiosRaised(answerOf('above_per_tx'));
    const attempt: VaultPayAttempt = { amountLovelace: 1n, vaultLovelace: 2n, spent: 3n, periodStart: 4, newPeriod: false, limit: { perTx: 1n, total: 1n, periodMs: 1 } };
    assert.equal(isLedgerRefusal(cause), true, 'the error of the node');
    assert.equal(isLedgerRefusal(new VaultPayRefused('3010 m', [], 'aa', attempt, cause)), true, 'the refusal that holds it');
    assert.equal(isLedgerRefusal(new VaultPayNotEvaluated('3010 m', [], 'aa', attempt, cause)), false, 'the other result, whatever its cause is');
    assert.equal(isLedgerRefusal(new VaultPayRefused('x', [], 'aa', attempt, new Error('failed script execution'))), false, 'a refusal that holds no error of the node');
  });
});

describe('planVaultEscrow: the refusals have a kind, and the value cap can be left to the ledger', () => {
  const refund = { address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) };
  const plan = (advert: typeof IDENTITY_ADVERT, options?: { capped?: boolean }, buyer = DELEGATE_KEY.keyHash) =>
    planVaultEscrow(advert, ADVERT_REF, buyer, PAYLOAD, windowAt(NOW), { agentId: AGENT_ID, refund }, options);
  const fault = (run: () => unknown) => { try { run(); } catch (err) { return err instanceof EscrowPlanRefusal ? err.fault : `not typed: ${String(err)}`; } return 'no refusal'; };

  test('each refusal has its kind, and the message of old', () => {
    assert.equal(fault(() => plan({ ...IDENTITY_ADVERT, status: 'Retired' })), 'advert_retired');
    assert.equal(fault(() => plan(IDENTITY_ADVERT, undefined, IDENTITY_ADVERT.supplier_pkh)), 'buyer_is_supplier');
    assert.equal(fault(() => plan({ ...IDENTITY_ADVERT, max_processing_ms: -1 })), 'advert_terms');
    assert.equal(fault(() => plan({ ...IDENTITY_ADVERT, max_processing_ms: 90_000_000 })), 'advert_terms');
    assert.equal(fault(() => plan({ ...IDENTITY_ADVERT, endpoint_url: 'not a url' })), 'advert_terms');
    assert.equal(fault(() => plan({ ...IDENTITY_ADVERT, price_lovelace: -1n })), 'advert_terms');
    assert.equal(fault(() => plan({ ...IDENTITY_ADVERT, price_lovelace: MAX_ESCROW_LOVELACE + 1n })), 'value_cap');
    assert.equal(fault(() => plan(IDENTITY_ADVERT)), 'no refusal');
  });
  test('with capped false a lock above the cap is planned; every other refusal stays', () => {
    const rich = { ...IDENTITY_ADVERT, price_lovelace: MAX_ESCROW_LOVELACE + 1n };
    assert.equal(fault(() => plan(rich)), 'value_cap');
    assert.ok(plan(rich, { capped: false }).lockLovelace > MAX_ESCROW_LOVELACE);
    assert.equal(fault(() => plan(rich, { capped: true })), 'value_cap');
    assert.equal(fault(() => plan({ ...rich, status: 'Retired' }, { capped: false })), 'advert_retired');
  });
});

describe('readAdvertFromNode', () => {
  test('reads the identity advert from the node, and says in words what is none', async () => {
    const read = (utxos: UTxO[], ref = ADVERT_REF) => readAdvertFromNode(identityWorld(utxos), ref, DEPLOYMENT);
    assert.deepEqual(await read([advertUtxo()]), { ref: ADVERT_REF, advert: IDENTITY_ADVERT, agentId: AGENT_ID });
    assert.deepEqual(await read([advertUtxo()], ` ${ADVERT_REF.toUpperCase()} `), { ref: ADVERT_REF, advert: IDENTITY_ADVERT, agentId: AGENT_ID });
    const cases: Array<[string, UTxO[], string, RegExp]> = [
      ['no output', [], ADVERT_REF, /The node has no unspent output/],
      ['a ref that is none', [advertUtxo()], 'not-a-ref', /Invalid out ref/],
      ['another address', [advertUtxo(IDENTITY_ADVERT, { address: DEPLOYMENT.escrow.address })], ADVERT_REF, /is not at the advert address of the identity marketplace/],
      ['no inline datum', [advertUtxo(IDENTITY_ADVERT, { datum: undefined })], ADVERT_REF, /has no inline datum/],
      ['another datum', [advertUtxo(IDENTITY_ADVERT, { datum: encodeVaultDatum(liveVault()) })], ADVERT_REF, /holds no identity-marketplace advert datum/],
      ['text that is not UTF-8', [advertUtxo(IDENTITY_ADVERT, { datum: advertUtxo().datum!.replace('6563686f2d7631', 'ffffffffffffff') })], ADVERT_REF, /not valid UTF-8/],
    ];
    for (const [why, utxos, ref, words] of cases) {
      const answer = await read(utxos, ref);
      assert.ok('error' in answer && words.test(answer.error), `${why}: ${JSON.stringify(answer)}`);
    }
  });
  test('a failure of the node throws', async () => {
    const provider = Object.assign(identityWorld([advertUtxo()]), { getUtxosByOutRef: async () => { throw new Error('node down'); } });
    await assert.rejects(readAdvertFromNode(provider, ADVERT_REF, DEPLOYMENT), /node down/);
  });
});
