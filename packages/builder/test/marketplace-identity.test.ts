// packages/builder/test/marketplace-identity.test.ts
// The marketplace in the identity layout (Part 2 Section 6), offline: Post, Accept, Reclaim, Release and RefundRevoked against the real
// applied escrow script (identity-world's deployment, local evaluation), the lineage across both escrow credentials, both advert
// layouts, and the receipt's field check. Koios and the indexer are one fake (escrow-identity.fixture.ts); no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML, credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import type { Assets, UTxO } from '@lucid-evolution/lucid';
import { DEPLOYMENT, NOW, DAY, LISTED, OTHER, OWN_ADDRESS, REF_UTXOS, identityWorld, lucidOn, rootRecord, recordUtxo } from './fixtures/identity-world.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import {
  ADVERT_REF, AGENT_ID, AGENT_DID, CAPABILITY, CHAIN_TXS, CLAIM_TX, ESCROW_LOCK, ESCROW_REF, IDENTITY_ADVERT, OWN_PKH, PAYLOAD, POST_TX, SUBMIT_TX,
  SUPPLIER_PKH, advertUtxo, agentRecord, chainFake, escrowUtxo, identityEscrow, keyAddress, listedRow, submitted, supplierEnterprise,
} from './fixtures/escrow-identity.fixture.ts';
import { ESCROW_OPEN_DATUM_HEX, ESCROW_REF as LEGACY_REF } from './fixtures/marketplace.fixture.ts';
import { escrowAt, koiosFor, SUBMIT_TX as LEGACY_SUBMIT_TX, SUPPLIER_ADDRESS as LEGACY_SUPPLIER_ADDRESS } from './fixtures/escrow-koios.fixture.ts';
import { REF_SCRIPT_UTXO, evaluatingProvider } from './fixtures/escrow-node.fixture.ts';
import { FIXTURE_TOKEN_UNIT } from './fixtures/fixture-provider.ts';
import { buildAccept, buildPostEscrow, buildReclaim, buildRefundRevoked, buildRelease, planPostEscrow } from '../src/vector/marketplace-build.ts';
import { decodeEscrowDatum, decodeIdentityEscrowDatum, encodeEscrowDatum, identityEscrowLockFloor } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum, IdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';
import { readEscrowOutput, resolveEscrowLineage } from '../src/vector/marketplace-lineage.ts';
import { readAdvert } from '../src/vector/marketplace-indexer.ts';
import { verifyReceipt } from '../src/vector/marketplace-verify.ts';
import { encodeVaultDatum, plutusAddressFromBech32 } from '../src/vector/identity-codec.ts';
import type { Status } from '../src/vector/identity-codec.ts';
import { ensureSlotConfig } from '../src/vector/gov-build.ts';
import { chainClock, windowAt } from '../src/vector/identity-chain.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';

const KOIOS = 'https://koios.example';
type Out = { address: string; lovelace: bigint; datum: string | null; assets: Record<string, bigint> };
function outputsOf(txCbor: string): Out[] {
  const outs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  return Array.from({ length: outs.len() }, (_, i) => {
    const o = outs.get(i);
    const assets: Record<string, bigint> = {};
    const multi = o.amount().multi_asset();
    const policies = multi.keys();
    for (let p = 0; p < policies.len(); p++) {
      const names = multi.get_assets(policies.get(p))!.keys();
      for (let n = 0; n < names.len(); n++) assets[`${policies.get(p).to_hex()}${names.get(n).to_hex()}`] = multi.get(policies.get(p), names.get(n))!;
    }
    return { address: o.address().to_bech32(), lovelace: BigInt(o.amount().coin().toString()), datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null, assets };
  });
}
const body = (txCbor: string) => CML.Transaction.from_cbor_hex(txCbor).body();
const requiredSigners = (txCbor: string): string[] => { const s = body(txCbor).required_signers(); return s ? Array.from({ length: s.len() }, (_, i) => s.get(i).to_hex()) : []; };
const refInputs = (txCbor: string): string[] => { const r = body(txCbor).reference_inputs(); return r ? Array.from({ length: r.len() }, (_, i) => `${r.get(i).transaction_id().to_hex()}#${r.get(i).index()}`) : []; };
const redeemers = (txCbor: string): string[] => {
  const legacy = CML.Transaction.from_cbor_hex(txCbor).witness_set().redeemers()?.as_arr_legacy_redeemer();
  return legacy ? Array.from({ length: legacy.len() }, (_, i) => legacy.get(i).data().to_cbor_hex()) : [];
};
/** A second wallet: OTHER's enterprise address with 100 AP3X (pure, so also the collateral). */
const OTHER_ADDRESS = keyAddress(OTHER.keyHash);
const otherWallet: UTxO = { txHash: '07'.repeat(32), outputIndex: 0, address: OTHER_ADDRESS, assets: { lovelace: 100_000_000n } };
/** The supplier's wallet: LISTED's enterprise address. */
const supplierWallet: UTxO = { txHash: '08'.repeat(32), outputIndex: 0, address: supplierEnterprise, assets: { lovelace: 100_000_000n } };
const REVOKED: Status = { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: NOW - DAY, invalidFrom: NOW - 2 * DAY, successor: null };
/** The agent's record as a tombstone with `status`. */
const tombstone = (status: Status) => agentRecord({ keys: [], parties: [], description: '', framework: '', endpoint: '', capabilities: [], status });

describe('Post in the identity layout (Part 2 Section 6.1)', () => {
  const post = async (o: { records?: UTxO[]; listed?: unknown[]; advert?: UTxO; deployment?: typeof DEPLOYMENT | null } = {}) => {
    const world = identityWorld(o.records ?? [agentRecord()]);
    const k = chainFake({ live: [o.advert ?? advertUtxo()], listed: o.listed ?? [listedRow()] });
    return buildPostEscrow(await lucidOn(world), world, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: PAYLOAD, nowMs: NOW }, k.f, o.deployment === undefined ? DEPLOYMENT : o.deployment);
  };

  test('pays the identity escrow at output 0: the agent of the advert, the refund to the buyer\'s own address, the widest-datum lock', async () => {
    const r = await post();
    assert.deepEqual([r.layout, r.agentId, r.escrowAddress, r.escrowRef], ['identity', AGENT_ID, DEPLOYMENT.escrow.address, `${r.txHash}#0`]);
    const [escrow] = outputsOf(r.txCbor);
    assert.equal(escrow.address, DEPLOYMENT.escrow.address);
    const datum = decodeIdentityEscrowDatum(escrow.datum!);
    assert.deepEqual([datum.agent_id, datum.state, datum.buyer_pkh, datum.supplier_pkh, datum.capability_id], [AGENT_ID, 'Open', OWN_PKH, SUPPLIER_PKH, CAPABILITY]);
    assert.deepEqual(datum.refund, { address: plutusAddressFromBech32(OWN_ADDRESS), datum: null });
    assert.equal(escrow.lovelace, identityEscrowLockFloor(datum, 4_000_000n));
    assert.equal(r.lockLovelace, escrow.lovelace);
    assert.deepEqual(requiredSigners(r.txCbor), [OWN_PKH]);
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [OWN_PKH]);
  });
  test('refuses an advert the indexer does not list, or lists with another agent', async () => {
    await assert.rejects(post({ listed: [] }), /is not listed by the marketplace indexer/);
    await assert.rejects(post({ listed: [listedRow(ADVERT_REF, 'bf'.repeat(32))] }), /with another agent than the one its datum names/);
    await assert.rejects(post({ listed: [listedRow(ADVERT_REF, null)] }), /with another agent/);
  });
  test('refuses an agent that fails the listing rule on chain: not Active, a subagent, the key or the capability not listed, no record', async () => {
    const hold = { by: { type: 'ControllerSet' as const }, reason: 6, since: NOW - DAY, until: NOW + DAY };
    await assert.rejects(post({ records: [agentRecord({ status: { type: 'Suspended', holds: [hold] } })] }), /is Suspended; only an Active agent can take work/);
    await assert.rejects(post({ records: [tombstone(REVOKED)] }), /is Revoked/);
    await assert.rejects(post({ records: [agentRecord({ lineage: { type: 'Subagent', parent: 'ab'.repeat(32), parentEpoch: 0, depth: 1 }, endpoint: '' })] }), /is a subagent/);
    await assert.rejects(post({ records: [agentRecord({ keys: [] })] }), /does not list the supplier key .* with the transaction purpose/);
    await assert.rejects(post({ records: [agentRecord({ capabilities: [] })] }), /does not list the capability/);
    await assert.rejects(post({ records: [] }), /has no record in the identity registry/);
  });
  test('refuses price + bonds above 10,000 AP3X in both layouts (F-29), and lets exactly the cap through', () => {
    const at = (price: bigint) => ({ ...IDENTITY_ADVERT, price_lovelace: price });
    const identity = { agentId: AGENT_ID, refund: null };
    assert.throws(() => planPostEscrow(at(9_998_000_001n), ADVERT_REF, OWN_PKH, PAYLOAD, NOW, undefined, identity), /above the 10000\.000000 AP3X value cap of an escrow \(F-29\)/);
    assert.throws(() => planPostEscrow(at(9_998_000_001n), ADVERT_REF, OWN_PKH, PAYLOAD, NOW), /value cap of an escrow \(F-29\)/);
    assert.equal(planPostEscrow(at(9_998_000_000n), ADVERT_REF, OWN_PKH, PAYLOAD, NOW, undefined, identity).lockLovelace, 10_000_000_000n);
    assert.throws(() => planPostEscrow({ ...IDENTITY_ADVERT, buyer_bond_lovelace: -1n }, ADVERT_REF, OWN_PKH, PAYLOAD, NOW, undefined, identity), /a negative amount/);
  });
  test('without a deployment an identity advert is refused with the words that say how to configure the server', async () => {
    await assert.rejects(post({ deployment: null }), /holds an identity-marketplace advert\. The identity registry is not configured on this server: set VECTOR_IDENTITY_LEGACY_ROOT/);
  });
});

describe('both advert layouts (readAdvert)', () => {
  test('the identity advert address reads the 14-field advert with its agent; the legacy address keeps the 13-field one', async () => {
    const read = await readAdvert(ADVERT_REF, chainFake({ live: [advertUtxo()] }).f, KOIOS, DEPLOYMENT.advert.address);
    assert.ok(!('error' in read));
    assert.deepEqual([read.layout, read.agentId, read.advert.capability_id], ['identity', AGENT_ID, CAPABILITY]);
    const elsewhere = await readAdvert(ADVERT_REF, chainFake({ live: [advertUtxo(IDENTITY_ADVERT, { address: DEPLOYMENT.escrow.address })] }).f, KOIOS, DEPLOYMENT.advert.address);
    assert.deepEqual(elsewhere, { error: `UTxO ${ADVERT_REF} is not at the advert script address.` });
  });
});

describe('Accept, Reclaim, Release and RefundRevoked of an identity escrow (the real escrow script)', () => {
  const posted = identityEscrow(NOW - 10 * 60_000);
  /** The escrow after the Submit: the Post and Claimed outputs are spent, the Submitted one is live at the exact escrow address. */
  const afterSubmit = (d: IdentityEscrowDatum, submittedAt: number, wallet: UTxO[] = []) => {
    const live = escrowUtxo(SUBMIT_TX, submitted(d, submittedAt));
    const world = identityWorld([live, agentRecord(), ...wallet]);
    const k = chainFake({ live: [live], spent: [escrowUtxo(POST_TX, d), escrowUtxo(CLAIM_TX, { ...d, state: 'Claimed' })], txs: CHAIN_TXS });
    return { world, k };
  };
  /** The escrow as posted: the Post output is live. */
  const open = (d: IdentityEscrowDatum, extra: UTxO[] = [], over: Partial<UTxO> = {}) => {
    const live = escrowUtxo(POST_TX, d, over);
    return { world: identityWorld([live, ...extra]), k: chainFake({ live: [live] }) };
  };
  const p = (changeAddress: string, over: Record<string, unknown> = {}) => ({ changeAddress, escrowRef: ESCROW_REF, nowMs: NOW, deployment: DEPLOYMENT, ...over });

  test('Accept follows the identity lineage, pays the supplier key and the buyer bond to the refund address, and the buyer signs', async () => {
    const { world, k } = afterSubmit(posted, NOW - 60_000);
    const r = await buildAccept(await lucidOn(world), world, KOIOS, p(OWN_ADDRESS), k.f);
    assert.deepEqual([r.layout, r.agentDid, r.escrowRef], ['identity', AGENT_DID, ESCROW_REF]);
    const outs = outputsOf(r.txCbor);
    assert.ok(outs.some((o) => o.address === supplierEnterprise && o.lovelace === 3_000_000n), 'price + supplier bond to the supplier key');
    assert.ok(outs.some((o) => o.address === OWN_ADDRESS && o.lovelace === 1_000_000n && o.datum === null), 'the buyer bond at exactly the refund address, no datum');
    assert.deepEqual(requiredSigners(r.txCbor), [OWN_PKH]);
    assert.deepEqual(redeemers(r.txCbor), ['d87b80']);
    assert.ok(refInputs(r.txCbor).includes(`${'e0'.repeat(32)}#4`), 'the identity escrow script is read from its reference UTxO');
    assert.ok(r.validTo - r.validFrom <= 3_600_000);
  });
  test('Accept of a vault payment returns the buyer bond to the vault address with the Returned datum', async () => {
    const owner = { type: 'PrincipalKey' as const, hash: OWN_PKH, organisation: null };
    const returned = encodeVaultDatum({ type: 'Returned', owner });
    const vaultPaid = identityEscrow(NOW - 10 * 60_000, { refund: { address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: returned } });
    const { world, k } = afterSubmit(vaultPaid, NOW - 60_000);
    const r = await buildAccept(await lucidOn(world), world, KOIOS, p(OWN_ADDRESS), k.f);
    const back = outputsOf(r.txCbor).find((o) => o.address === DEPLOYMENT.vault.address)!;
    assert.equal(back.datum, returned);
    assert.ok(back.lovelace >= 1_000_000n);
    assert.equal(r.buyerAddress, DEPLOYMENT.vault.address);
  });
  test('Accept still refuses another key than the buyer, and a closed window', async () => {
    const { world, k } = afterSubmit(posted, NOW - 60_000, [otherWallet]);
    await assert.rejects(buildAccept(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), k.f), /you are not the buyer/);
    const late = afterSubmit(posted, NOW - 700_000);
    await assert.rejects(buildAccept(await lucidOn(late.world), late.world, KOIOS, p(OWN_ADDRESS), late.k.f), /Accept window closed/);
  });
  test('Reclaim with a refund address: any wallet builds it, nobody else signs, and the refund carries everything the escrow holds', async () => {
    const due = identityEscrow(NOW - 2 * 3_600_000);
    const { world, k } = open(due, [otherWallet], { assets: { lovelace: ESCROW_LOCK, [FIXTURE_TOKEN_UNIT]: 5n } });
    const r = await buildReclaim(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), k.f);
    const refund = outputsOf(r.txCbor).find((o) => o.address === OWN_ADDRESS)!;
    assert.deepEqual([refund.lovelace, refund.assets[FIXTURE_TOKEN_UNIT], refund.datum], [ESCROW_LOCK, 5n, null]);
    assert.deepEqual(requiredSigners(r.txCbor), [], 'no buyer signature');
    assert.deepEqual([r.fullRefund, r.buyerAddress], [true, OWN_ADDRESS]);
    assert.deepEqual(redeemers(r.txCbor), ['d87c80']);
  });
  test('Reclaim without a refund address keeps the legacy rule: only the buyer, payment and both bonds back', async () => {
    const due = identityEscrow(NOW - 2 * 3_600_000, { refund: null });
    const { world, k } = open(due, [otherWallet]);
    const r = await buildReclaim(await lucidOn(world), world, KOIOS, p(OWN_ADDRESS), k.f);
    assert.deepEqual(requiredSigners(r.txCbor), [OWN_PKH]);
    assert.ok(outputsOf(r.txCbor).some((o) => o.address === OWN_ADDRESS && o.lovelace === 4_000_000n));
    await assert.rejects(buildReclaim(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), k.f), /you are not the buyer/);
  });
  test('Reclaim before deliver_by is refused', async () => {
    const { world, k } = open(identityEscrow(NOW - 60_000));
    await assert.rejects(buildReclaim(await lucidOn(world), world, KOIOS, p(OWN_ADDRESS), k.f), /Reclaim opens at/);
  });
  test('Release: the supplier key signs after the accept window and takes payment + both bonds; before the window it is refused', async () => {
    const { world, k } = afterSubmit(posted, NOW - 20 * 60_000, [supplierWallet]);
    const lucid = await lucidForAddress(world, supplierEnterprise);
    const r = await buildRelease(lucid, world, KOIOS, p(supplierEnterprise), k.f);
    assert.ok(outputsOf(r.txCbor).some((o) => o.address === supplierEnterprise && o.lovelace === 4_000_000n));
    assert.deepEqual(requiredSigners(r.txCbor), [SUPPLIER_PKH]);
    assert.deepEqual(redeemers(r.txCbor), ['d87d80']);
    const early = afterSubmit(posted, NOW - 60_000, [supplierWallet]);
    await assert.rejects(buildRelease(await lucidForAddress(early.world, supplierEnterprise), early.world, KOIOS, p(supplierEnterprise), early.k.f), /Release opens at/);
    await assert.rejects(buildRelease(await lucidOn(world), world, KOIOS, p(OWN_ADDRESS), k.f), /you are not its supplier/);
  });
  test('RefundRevoked: anybody, the record as a reference input, everything to the refund address', async () => {
    const record = tombstone(REVOKED);
    const { world, k } = open(posted, [otherWallet, record]);
    const r = await buildRefundRevoked(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), k.f);
    assert.ok(refInputs(r.txCbor).includes(`${record.txHash}#0`), 'the record is a reference input');
    assert.ok(outputsOf(r.txCbor).some((o) => o.address === OWN_ADDRESS && o.lovelace === ESCROW_LOCK));
    assert.deepEqual(requiredSigners(r.txCbor), []);
    assert.deepEqual(redeemers(r.txCbor), ['d87e80']);
    assert.deepEqual([r.recordStatus, r.agentId], ['Revoked', AGENT_ID]);
  });
  test('RefundRevoked carries every asset of the escrow input, a token too, to the refund address', async () => {
    const record = tombstone(REVOKED);
    const { world, k } = open(posted, [otherWallet, record], { assets: { lovelace: ESCROW_LOCK, [FIXTURE_TOKEN_UNIT]: 5n } });
    const r = await buildRefundRevoked(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), k.f);
    const refund = outputsOf(r.txCbor).find((o) => o.address === OWN_ADDRESS)!;
    assert.deepEqual([refund.lovelace, refund.assets[FIXTURE_TOKEN_UNIT], refund.datum], [ESCROW_LOCK, 5n, null]);
    assert.deepEqual(redeemers(r.txCbor), ['d87e80']);
  });
  test('RefundRevoked without a refund address pays the enterprise address of the buyer key; a Retired record allows it for an Open escrow', async () => {
    const plain = identityEscrow(NOW - 10 * 60_000, { refund: null });
    const { world, k } = open(plain, [otherWallet, tombstone({ type: 'Retired', at: NOW - DAY, successor: null })]);
    const r = await buildRefundRevoked(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), k.f);
    assert.ok(outputsOf(r.txCbor).some((o) => o.address === keyAddress(OWN_PKH) && o.lovelace === ESCROW_LOCK));
  });
  test('RefundRevoked of a Submitted escrow needs the revocation in force at submitted_at', async () => {
    const before = afterSubmit(posted, NOW - 3 * DAY, [otherWallet]);
    const revokedWorld = identityWorld([...(await before.world.getUtxos(DEPLOYMENT.escrow.address)), otherWallet, tombstone(REVOKED)]);
    await assert.rejects(buildRefundRevoked(await lucidForAddress(revokedWorld, OTHER_ADDRESS), revokedWorld, KOIOS, p(OTHER_ADDRESS), before.k.f), /before the revocation took effect/);
    const after = afterSubmit(posted, NOW - DAY, [otherWallet]);
    const world = identityWorld([...(await after.world.getUtxos(DEPLOYMENT.escrow.address)), otherWallet, tombstone(REVOKED)]);
    const r = await buildRefundRevoked(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), after.k.f);
    assert.ok(outputsOf(r.txCbor).some((o) => o.address === OWN_ADDRESS && o.lovelace === ESCROW_LOCK));
  });
  test('RefundRevoked refuses an agent that is still Active', async () => {
    const { world, k } = open(posted, [otherWallet, agentRecord()]);
    await assert.rejects(buildRefundRevoked(await lucidForAddress(world, OTHER_ADDRESS), world, KOIOS, p(OTHER_ADDRESS), k.f), /RefundRevoked is not allowed: the escrow is Open and the agent's record is Active/);
  });
});

describe('the escrow script: a full refund returns every asset of the escrow input (Part 2 Section 6.1, rule 6)', () => {
  // Reclaim with a refund address and RefundRevoked, assembled as buildReclaim and buildRefundRevoked assemble them, of an escrow that
  // also holds a token. Another wallet builds them, so its change output never counts as a buyer payout. The escrow script of
  // agents-marketplace 1643583 (full_refund) refuses refund outputs that do not carry the token.
  const held: Assets = { lovelace: ESCROW_LOCK, [FIXTURE_TOKEN_UNIT]: 5n };
  async function shape(redeemer: string, d: IdentityEscrowDatum, refund: Assets, refs: UTxO[] = []) {
    const live = escrowUtxo(POST_TX, d, { assets: held });
    const world = identityWorld([live, otherWallet, ...refs]);
    const lucid = await lucidForAddress(world, OTHER_ADDRESS);
    await chainClock(world);
    const window = windowAt(NOW);
    return lucid.newTx()
      .readFrom([REF_UTXOS[4], ...refs])
      .collectFrom([live], redeemer)
      .pay.ToAddress(OWN_ADDRESS, refund)
      .validFrom(window.lo)
      .validTo(window.hi)
      .complete();
  }

  test('Reclaim with a refund address: the AP3X without the token fails; the AP3X with the token passes', async () => {
    const due = identityEscrow(NOW - 2 * 3_600_000);
    await assert.rejects(shape('d87c80', due, { lovelace: ESCROW_LOCK }), /failed script execution Spend/);
    await shape('d87c80', due, held);
  });
  test('RefundRevoked: the AP3X without the token fails; the AP3X with the token passes', async () => {
    const record = tombstone(REVOKED);
    const openEscrow = identityEscrow(NOW - 10 * 60_000);
    await assert.rejects(shape('d87e80', openEscrow, { lovelace: ESCROW_LOCK }, [record]), /failed script execution Spend/);
    await shape('d87e80', openEscrow, held, [record]);
  });
});

describe('the legacy escrow keeps its rules', () => {
  const POSTED: EscrowDatum = { ...decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), buyer_pkh: OWN_PKH };
  const SUBMITTED_AT = POSTED.posted_at + 60_000;
  const SUBMITTED: EscrowDatum = { ...POSTED, submitted_at: SUBMITTED_AT, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
  const legacyWorld = (wallet: UTxO[]) => {
    const utxos = [...wallet, REF_SCRIPT_UTXO, escrowAt(LEGACY_SUBMIT_TX, SUBMITTED)];
    return { provider: evaluatingProvider(utxos), k: koiosFor(utxos, { datumHex: encodeEscrowDatum(POSTED), spent: true }) };
  };
  const supplier: UTxO = { txHash: '09'.repeat(32), outputIndex: 0, address: LEGACY_SUPPLIER_ADDRESS, assets: { lovelace: 100_000_000n } };

  test('Release of a legacy escrow: node evaluation, the supplier key signs, payment + both bonds to it', async () => {
    await ensureSlotConfig(new FixtureProvider([]));
    const { provider, k } = legacyWorld([supplier]);
    const r = await buildRelease(await lucidForAddress(provider, LEGACY_SUPPLIER_ADDRESS), provider, KOIOS, { changeAddress: LEGACY_SUPPLIER_ADDRESS, escrowRef: LEGACY_REF, nowMs: SUBMITTED_AT + 700_000, deployment: DEPLOYMENT }, k.f);
    assert.equal(r.layout, 'legacy');
    assert.ok(provider.evaluations.length > 0, 'the node evaluates the legacy script');
    assert.ok(outputsOf(r.txCbor).some((o) => o.address === LEGACY_SUPPLIER_ADDRESS && o.lovelace === 2_200_000n));
    assert.deepEqual(requiredSigners(r.txCbor), [getAddressDetails(LEGACY_SUPPLIER_ADDRESS).paymentCredential!.hash]);
  });
  test('RefundRevoked of a legacy escrow is refused: it has no such redeemer', async () => {
    const { provider, k } = legacyWorld([{ txHash: '0a'.repeat(32), outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 100_000_000n } }]);
    await assert.rejects(buildRefundRevoked(await lucidForAddress(provider, OWN_ADDRESS), provider, KOIOS, { changeAddress: OWN_ADDRESS, escrowRef: LEGACY_REF, deployment: DEPLOYMENT }, k.f), /RefundRevoked exists only for identity-marketplace escrows/);
    assert.equal(provider.evaluations.length, 0);
  });
});

describe('the lineage across both escrow credentials', () => {
  const posted = identityEscrow(NOW - 10 * 60_000);
  const claimed: IdentityEscrowDatum = { ...posted, state: 'Claimed' };
  const node = (utxos: UTxO[]) => identityWorld(utxos);

  test('an identity escrow is followed at its own credential, and its continuation must be at exactly the escrow address', async () => {
    const exact = escrowUtxo(CLAIM_TX, claimed);
    const k = chainFake({ live: [exact], spent: [escrowUtxo(POST_TX, posted)], txs: CHAIN_TXS });
    const found = await resolveEscrowLineage(node([exact]), KOIOS, ESCROW_REF, k.f, DEPLOYMENT);
    assert.deepEqual([found.layout, found.current?.utxo.txHash, found.current?.datum.state], ['identity', CLAIM_TX, 'Claimed']);
    const stakedAddress = credentialToAddress('Mainnet', { type: 'Script', hash: DEPLOYMENT.escrow.hash }, { type: 'Key', hash: 'ee'.repeat(28) });
    const elsewhere = escrowUtxo(CLAIM_TX, claimed, { address: stakedAddress });
    const k2 = chainFake({ live: [elsewhere], spent: [escrowUtxo(POST_TX, posted)], txs: CHAIN_TXS });
    assert.equal((await resolveEscrowLineage(node([elsewhere]), KOIOS, ESCROW_REF, k2.f, DEPLOYMENT)).current, null, 'a staked copy is no continuation of an identity escrow');
  });
  test('a continuation that changes agent_id or refund is refused, naming the field', async () => {
    for (const [field, d] of [['agent_id', { ...claimed, agent_id: 'bf'.repeat(32) }], ['refund', { ...claimed, refund: null }]] as const) {
      const live = escrowUtxo(CLAIM_TX, d);
      const k = chainFake({ live: [live], spent: [escrowUtxo(POST_TX, posted)], txs: CHAIN_TXS });
      await assert.rejects(resolveEscrowLineage(node([live]), KOIOS, ESCROW_REF, k.f, DEPLOYMENT), new RegExp(`datum differs from that escrow's in ${field}`));
    }
  });
  test('without a deployment an identity escrow is refused with the words that say how to configure the server', async () => {
    const k = chainFake({ live: [escrowUtxo(POST_TX, posted)] });
    await assert.rejects(readEscrowOutput(KOIOS, ESCROW_REF, k.f), /is an identity-marketplace escrow\. The identity registry is not configured on this server/);
    const read = await readEscrowOutput(KOIOS, ESCROW_REF, k.f, DEPLOYMENT);
    assert.equal((read.datum as IdentityEscrowDatum).agent_id, AGENT_ID);
  });
});

describe('receipts with 8 and 9 fields (Part 2 Section 6.3)', () => {
  const base = {
    prompt_hash: 'aa'.repeat(32), response_hash: 'bb'.repeat(32), model: 'm', prompt_tokens: 1, completion_tokens: 2, wallclock_ms: 3,
    supplier_pkh: SUPPLIER_PKH, escrow_ref: ESCROW_REF,
  };
  const check = (receipt: Record<string, unknown>, agentId: string | null) => verifyReceipt({
    receipt, signature: '00'.repeat(64), escrowRef: ESCROW_REF, supplierPubKeyHex: LISTED.publicKey, escrowSupplierPkh: SUPPLIER_PKH,
    escrowPromptHash: base.prompt_hash, escrowAgentId: agentId, resultReceiptHashOnChain: null,
  }).checks.fields_match;
  test('a legacy escrow takes exactly the 8 fields; an identity escrow exactly the 9 with its agent DID', () => {
    assert.equal(check(base, null).state, 'pass');
    assert.equal(check({ ...base, agent_did: AGENT_DID }, AGENT_ID).state, 'pass');
  });
  test('the wrong layout, a missing or extra field, or another agent fails', () => {
    assert.match(check({ ...base, agent_did: AGENT_DID }, null).note, /a legacy escrow has exactly the 8 receipt fields; it has fields the layout does not have: agent_did/);
    assert.match(check(base, AGENT_ID).note, /it lacks agent_did/);
    assert.match(check({ ...base, agent_did: `did:vector:${'bf'.repeat(32)}` }, AGENT_ID).note, /names another agent than the one the buyer hired/);
    assert.equal(check({ ...base, extra: 1 }, null).state, 'fail');
    const { model: _dropped, ...seven } = base;
    assert.match(check(seven, null).note, /it lacks model/);
  });
});

describe('records of the fixtures', () => {
  test('the agent record lists the supplier key with the transaction purpose and the capability', () => {
    assert.ok(rootRecord().keys.some((k) => k.key === LISTED.publicKey));
    assert.ok(recordUtxo(AGENT_ID, rootRecord()).assets[`${DEPLOYMENT.identity.hash}${AGENT_ID}`] === 1n);
  });
});
