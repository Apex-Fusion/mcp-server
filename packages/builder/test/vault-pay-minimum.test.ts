// packages/builder/test/vault-pay-minimum.test.ts
// The smallest escrow output that a payment of a vault can make (vault-read.ts, readVaults), against the real applied vault script and the
// ledger rule for the least AP3X of an output. A payment of exactly the ledger minimum that the read gives is accepted by the script, and a
// payment of one lovelace less is refused by the ledger rule. The node is identity-world's offline world, so the vault script runs on every
// build (local evaluation). No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMinLovelaceFromUTxO } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { DEPLOYMENT, NOW, OWN_ADDRESS, REF_UTXOS, identityWorld, lucidOn } from './fixtures/identity-world.ts';
import {
  ADVERT_REF, AGENT_ID, DELEGATE_KEY, DELEGATION_ID, IDENTITY_ADVERT, OWN_PKH, PAYLOAD, VAULT_TX, advertUtxo, agentRecord, chainFake, delegateRecord, delegation, delegationUtxo, listedRow, liveVault, vaultUtxo,
} from './fixtures/escrow-identity.fixture.ts';
import { fixtureProtocolParameters } from './fixtures/fixture-provider.ts';
import { buildVaultPay } from '../src/vector/vault-build.ts';
import { chainClock, windowAt } from '../src/vector/identity-chain.ts';
import { encodeVaultDatum, encodeVaultSpend, plutusAddressFromBech32, utf8Hex } from '../src/vector/identity-codec.ts';
import type { Delegator } from '../src/vector/identity-codec.ts';
import { encodeIdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';
import type { IdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';
import { readVaults } from '../src/vector/vault-read.ts';
import type { LiveVault } from '../src/vector/vault-read.ts';

const WINDOW = windowAt(NOW, 1);
const VAULT_REF = `${VAULT_TX}#0`;
const COINS = fixtureProtocolParameters().coinsPerUtxoByte;
/** The ledger minimum of an output at `address` that holds `datum`: what the ledger rule asks, worked out here and not by the code under test. */
const minimumAt = (address: string, datum: string): bigint => calculateMinLovelaceFromUTxO(COINS, { txHash: '00'.repeat(32), outputIndex: 0, address, assets: { lovelace: 0n }, datum });

/** The owners of the vault that the tests try: a plain principal key, and one with an organisation, which makes the refund datum longer. */
const OWNERS: Array<[string, Delegator]> = [
  ['a principal key', { type: 'PrincipalKey', hash: OWN_PKH, organisation: null }],
  ['a principal key with an organisation', { type: 'PrincipalKey', hash: OWN_PKH, organisation: utf8Hex('Acme Corporation of the tests') }],
];

/** The Open escrow of a payment that the vault script accepts, and that has the least datum: no capability, no bonds, the payment equal to the output. */
const smallestEscrow = (owner: Delegator, payment: bigint): IdentityEscrowDatum => ({
  buyer_pkh: DELEGATE_KEY.keyHash, supplier_pkh: '11'.repeat(28), advert_ref: { txHash: '22'.repeat(32), index: 0 }, capability_id: '', request_spec_hash: '33'.repeat(32), prompt_hash: '44'.repeat(32),
  payment_lovelace: payment, buyer_bond_lovelace: 0n, supplier_bond_lovelace: 0n, deliver_by: WINDOW.hi + 180_000, posted_at: WINDOW.lo + 60_000,
  submitted_at: null, result_receipt_hash: null, state: 'Open', agent_id: AGENT_ID,
  refund: { address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) },
});

/** The nodes of the tests: a Live vault of `owner` that holds `lovelace`, its delegation, the record of the delegate, and the wallet. */
const nodeOf = (owner: Delegator, lovelace: bigint): UTxO[] => [
  vaultUtxo(liveVault({ owner, spent: 0n, periodStart: 0 }), lovelace),
  delegationUtxo(delegation({ delegator: owner })), delegateRecord(), agentRecord(),
];
const noKoios = (async () => { throw new Error('a read by output reference does not ask Koios'); }) as typeof fetch;

/** What the read says about the vault output that holds `lovelace`. */
async function readLive(owner: Delegator, lovelace: bigint): Promise<LiveVault> {
  const provider = identityWorld(nodeOf(owner, lovelace));
  const page = await readVaults({ provider, deployment: DEPLOYMENT, koiosUrl: 'https://koios.example', fetchImpl: noKoios }, { vaultRef: VAULT_REF }, NOW);
  return page.items[0].live!;
}

/** A Pay of the vault that holds `vaultLovelace`, with the escrow output `escrow` and the rest of the AP3X in the continuing vault output. Local evaluation runs the vault script. */
async function pay(owner: Delegator, vaultLovelace: bigint, escrow: { payment: bigint; lovelace: bigint }): Promise<void> {
  const node = nodeOf(owner, vaultLovelace);
  const [vault, link, delegate] = node;
  const provider = identityWorld(node);
  const lucid = await lucidOn(provider);
  await chainClock(provider);
  const next = encodeVaultDatum({ type: 'Live', owner, delegation: DELEGATION_ID, spent: escrow.payment, periodStart: WINDOW.hi });
  await lucid.newTx()
    .readFrom([REF_UTXOS[3], link, delegate])
    .collectFrom([vault], encodeVaultSpend({ type: 'Pay' }))
    .pay.ToAddressWithData(DEPLOYMENT.escrow.address, { kind: 'inline', value: encodeIdentityEscrowDatum(smallestEscrow(owner, escrow.payment)) }, { lovelace: escrow.lovelace })
    .pay.ToAddressWithData(DEPLOYMENT.vault.address, { kind: 'inline', value: next }, { lovelace: vaultLovelace - escrow.lovelace })
    .addSignerKey(DELEGATE_KEY.keyHash)
    .validFrom(WINDOW.lo)
    .validTo(WINDOW.hi)
    .complete();
}

describe('the smallest escrow output that a vault payment can make, against the real vault script and the ledger rule', () => {
  for (const [what, owner] of OWNERS) {
    // The ledger minimum of the next vault output of a payment of the least amount: the amount spent, and the start of the new period.
    const keptFor = (amount: bigint): bigint => minimumAt(DEPLOYMENT.vault.address, encodeVaultDatum({ type: 'Live', owner, delegation: DELEGATION_ID, spent: amount, periodStart: WINDOW.hi }));

    test(`${what}: the minimum that the read gives is the one that the ledger counts for that output`, async () => {
      const r = await readLive(owner, 100_000_000n);
      const expected = minimumAt(DEPLOYMENT.escrow.address, encodeIdentityEscrowDatum(smallestEscrow(owner, 2_500_000n)));
      assert.equal(r.escrow!.minimum, expected);
      assert.equal(minimumAt(DEPLOYMENT.escrow.address, encodeIdentityEscrowDatum(smallestEscrow(owner, r.escrow!.minimum))), r.escrow!.minimum, 'a payment of exactly the minimum has the same minimum');
    });
    test(`${what}: a payment of exactly that minimum is accepted by the vault script, and one of one lovelace less cannot be made`, async () => {
      const minimum = (await readLive(owner, 100_000_000n)).escrow!.minimum;
      const held = keptFor(minimum) + minimum;
      await pay(owner, held, { payment: minimum, lovelace: minimum });
      // Lucid raises an output to the ledger minimum, so the output holds the minimum while its datum says one lovelace less: the vault script
      // refuses it, because the amount of an escrow in its datum must be exactly what the output holds.
      await assert.rejects(() => pay(owner, held, { payment: minimum - 1n, lovelace: minimum - 1n }), /failed script execution Spend/);
    });
    test(`${what}: a vault that holds exactly the minimum of its next output and the minimum of the escrow can pay it, and one lovelace less cannot: the read and the ledger agree`, async () => {
      const minimum = (await readLive(owner, 100_000_000n)).escrow!.minimum;
      const held = keptFor(minimum) + minimum;
      const yes = await readLive(owner, held);
      assert.deepEqual([yes.canPay, yes.problems, yes.allowance!.nextMax], [true, [], minimum]);
      const no = await readLive(owner, held - 1n);
      assert.equal(no.canPay, false);
      assert.match(no.problems[0], new RegExp(`^the vault holds ${held - 1n} lovelace and its next output needs ${keptFor(minimum)}, so a payment may lock at most ${minimum - 1n}, and the smallest escrow output needs ${minimum} lovelace`));
      // The ledger raises the continuing vault output to its minimum, so a payment of the minimum would leave the vault one lovelace too little: the script refuses it.
      await assert.rejects(() => pay(owner, held - 1n, { payment: minimum, lovelace: minimum }), /failed script execution Spend/);
    });
  }

  test('a vault that can pay with the least escrow can still refuse a real advert: next_max below what the advert locks, and the builder says so; at the lock it builds', async () => {
    const owner = OWNERS[0][1];
    const lock = IDENTITY_ADVERT.price_lovelace + IDENTITY_ADVERT.supplier_bond_lovelace + IDENTITY_ADVERT.buyer_bond_lovelace;
    const kept = minimumAt(DEPLOYMENT.vault.address, encodeVaultDatum({ type: 'Live', owner, delegation: DELEGATION_ID, spent: lock, periodStart: WINDOW.hi }));
    const build = async (held: bigint) => {
      const world = identityWorld(nodeOf(owner, held));
      const fake = chainFake({ live: [advertUtxo()], listed: [listedRow()] });
      return buildVaultPay({ lucid: await lucidOn(world), provider: world, deployment: DEPLOYMENT }, { changeAddress: OWN_ADDRESS, nowMs: NOW, vaultRef: VAULT_REF, advertRef: ADVERT_REF, payload: PAYLOAD }, fake.f);
    };
    const floor = (await readLive(owner, 100_000_000n)).escrow!.buildFloor;
    assert.ok(floor < lock, 'the lock of this advert is above the floor of the builder for the shortest datum: the amounts of the advert decide');
    const short = await readLive(owner, kept + lock - 1n);
    assert.deepEqual([short.canPay, short.allowance!.nextMax], [true, lock - 1n], 'the least escrow output fits, so the read says that the output can pay');
    await assert.rejects(() => build(kept + lock - 1n), /below the \d+ its output needs/);
    const exact = await readLive(owner, kept + lock);
    assert.deepEqual([exact.canPay, exact.allowance!.nextMax], [true, lock]);
    const built = await build(kept + lock);
    assert.deepEqual([built.amountLovelace, built.vaultLovelace], [lock, kept]);
  });
});
