// packages/builder/test/vault-build.test.ts
// The vault builders (Part 2 Section 5.3) offline: open, Pay and Close against the real applied vault script (identity-world's
// deployment, local evaluation), with the delegation chain and records as reference inputs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { CONTROLLER, DEPLOYMENT, NOW, DAY, OWN_ADDRESS, identityWorld, lucidOn } from './fixtures/identity-world.ts';
import {
  ADVERT_REF, AGENT_ID, DELEGATE_KEY, DELEGATION_ID, IDENTITY_ADVERT, OWN_PKH, PAYLOAD, advertUtxo, agentRecord, chainFake, delegateRecord, delegation,
  delegationUtxo, listedRow, liveVault, vaultUtxo,
} from './fixtures/escrow-identity.fixture.ts';
import { buildVaultOpen, buildVaultPay, buildVaultClose } from '../src/vector/vault-build.ts';
import { decodeVaultDatum, encodeVaultDatum, plutusAddressFromBech32, utf8Hex } from '../src/vector/identity-codec.ts';
import { decodeIdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';

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
