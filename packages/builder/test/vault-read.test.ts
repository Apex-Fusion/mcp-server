// packages/builder/test/vault-read.test.ts
// The reads of vaults (vault-read.ts) on the vault outputs that mainnet holds (one Live, four Returned) and on synthetic ones, and the
// check whether an escrow was paid from a vault on the payment that mainnet holds and on its twin, an escrow that no vault paid. The node
// is an offline world and Koios is a fake: no network. Anyone can write an output at the vault address with any datum, so the synthetic
// outputs include hostile ones. Each refusal has its accepted twin.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMinLovelaceFromUTxO, credentialToAddress } from '@lucid-evolution/lucid';
import type { Address, Credential, UTxO } from '@lucid-evolution/lucid';
import { decodeDelegationDatum, decodeVaultDatum, encodeVaultDatum, plutusAddressFromBech32, utf8Hex } from '../src/vector/identity-codec.ts';
import type { DelegationDatum, Delegator, IdentityDatum, ValueLimit, VaultDatum } from '../src/vector/identity-codec.ts';
import { windowAt } from '../src/vector/identity-chain.ts';
import { BudgetSpent, KOIOS_ANSWER_BYTES } from '../src/vector/ledger-read.ts';
import type { Page } from '../src/vector/ledger-read.ts';
import { planVaultEscrow } from '../src/vector/marketplace-build.ts';
import { encodeIdentityEscrowDatum, identityEscrowLockFloor } from '../src/vector/marketplace-datum.ts';
import type { IdentityEscrowDatum } from '../src/vector/marketplace-datum.ts';
import { NOT_ON_NODE, escrowPaidFromVault, periodAllowance, readVaults } from '../src/vector/vault-read.ts';
import type { VaultReading } from '../src/vector/vault-read.ts';
import { testKey } from './fixtures/identity-world.ts';
import { ADVERT_REF, AGENT_ID, IDENTITY_ADVERT, PAYLOAD } from './fixtures/escrow-identity.fixture.ts';
import { koiosRow } from './fixtures/ledger-read-world.ts';
import { fixtureProtocolParameters } from './fixtures/fixture-provider.ts';
import {
  CAPTURE, CAPTURE_MS, DAY, MAINNET, callsTo, delegation, delegationUtxo, delegationWithPeriod, endsWithin, ledgerKoios, ledgerWorld, liveRecord, recordUtxo, utxoOf, vaultUtxo, withVaultRedeemer,
} from './fixtures/ledger-read-world.ts';
import type { Contract, KoiosOptions, LedgerKoios, LedgerWorld, TxIo, TxRow } from './fixtures/ledger-read-world.ts';

type Live = Extract<VaultDatum, { type: 'Live' }>;

const refOf = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;
const refsOf = (page: Page<VaultReading>): string[] => page.items.map((r) => r.output.ref);
/** The ledger minimum of an output at the vault address that holds `lovelace` and the datum `datum`, with the protocol parameters of the fixtures. */
const minimumOf = (lovelace: bigint, datum: VaultDatum): bigint => calculateMinLovelaceFromUTxO(fixtureProtocolParameters().coinsPerUtxoByte, {
  txHash: '00'.repeat(32), outputIndex: 0, address: MAINNET.vault.address, assets: { lovelace }, datum: encodeVaultDatum(datum),
});

// ─── The vault outputs of mainnet ────────────────────────────────────────────────────────────────────────────────────────────

const CAPTURED = CAPTURE.vaults.map((row) => ({ row, ref: `${row.tx_hash}#${row.tx_index}`, vault: decodeVaultDatum(row.inline_datum!.bytes) }));
const LIVE_OUTPUT = CAPTURED.find((v) => v.vault.type === 'Live')!;
const LIVE_VAULT = LIVE_OUTPUT.vault as Live;
const RETURNED = CAPTURED.filter((v) => v.vault.type === 'Returned');
const DELEGATION = CAPTURE.delegations.live;
const REAL = decodeDelegationDatum(DELEGATION.mint_output.inline_datum!.bytes);
const LIMIT = REAL.value!;
const OWNER = LIVE_VAULT.owner.type === 'PrincipalKey' ? LIVE_VAULT.owner.hash : '';
const DELEGATE_KEY = testKey(31);

/**
 * The live delegation of mainnet with the delegate key of a key of the tests, and the record of its delegate that lists that key: the
 * delegate key of mainnet has no public key here, and the use checks of a payment need one. Its token and its terms are mainnet's.
 */
const payable = (): UTxO[] => [delegationUtxo(DELEGATION.id, { ...REAL, delegateKey: DELEGATE_KEY.keyHash }), recordUtxo(REAL.delegate, liveRecord({}, [DELEGATE_KEY.publicKey]))];
/** The vault outputs of the capture, the delegation that they name, its delegate, and `extra`. */
const world = (extra: UTxO[] = []): LedgerWorld => ledgerWorld([...CAPTURE.vaults.map(utxoOf), ...payable(), ...extra]);
const filterOf = (w: LedgerWorld): string | null => {
  const calls = callsTo(w.koios, 'credential_utxos').filter((c) => c.body !== null && Array.isArray(c.body._payment_credentials) && c.body._payment_credentials[0] === MAINNET.vault.hash);
  return new URL(calls[calls.length - 1].url).searchParams.get('inline_datum->>bytes');
};

describe('the capture', () => {
  test('holds the five vault outputs of mainnet: one Live and four Returned, all of one owner', () => {
    assert.equal(CAPTURED.length, 5);
    assert.equal(RETURNED.length, 4);
    assert.equal(LIVE_OUTPUT.ref, 'aa373b0b647dcffc654031990ae85df83d07e17def69e6affda3b503ee1c61a5#1');
    assert.equal(LIVE_VAULT.delegation, DELEGATION.id);
    assert.equal(LIVE_VAULT.spent, 20_800_000n);
    assert.equal(LIVE_VAULT.periodStart, 1794846798000);
    assert.equal(OWNER, '38abc11175937560b05ab347e6f11ae055931781ce1549dc33b86939');
    assert.ok(CAPTURED.every((v) => v.vault.owner.type === 'PrincipalKey' && v.vault.owner.hash === OWNER));
    assert.deepEqual(LIMIT, { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY });
  });
});

// ─── periodAllowance ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('periodAllowance', () => {
  const vault = (spent: bigint, periodStart = 1_000_000): Live => ({ type: 'Live', owner: { type: 'Agent', id: 'aa'.repeat(32) }, delegation: 'bb'.repeat(32), spent, periodStart });
  const limit = { perTx: 6_000_000n, total: 22_000_000n, periodMs: 1000 };
  const ROOM = 10n ** 12n;

  test('while the period runs: what is left of the total, and at most per_tx for the next payment', () => {
    const a = periodAllowance(vault(10_000_000n), limit, 1_000_500, ROOM);
    assert.deepEqual([a.periodRunning, a.periodStart, a.periodEnd, a.spent, a.remaining, a.nextMax], [true, 1_000_000, 1_001_000, 10_000_000n, 12_000_000n, 6_000_000n]);
    assert.equal(a.limit, limit);
  });
  test('when less than per_tx is left, that is the most the next payment may lock', () => {
    const a = periodAllowance(vault(20_800_000n), limit, 1_000_500, ROOM);
    assert.deepEqual([a.remaining, a.nextMax], [1_200_000n, 1_200_000n]);
    const full = periodAllowance(vault(22_000_000n), limit, 1_000_500, ROOM);
    assert.deepEqual([full.remaining, full.nextMax], [0n, 0n]);
    assert.equal(periodAllowance(vault(23_000_000n), limit, 1_000_500, ROOM).remaining, 0n, 'never below zero');
  });
  test('at period_start plus period_ms the period is over: the next payment starts a new one with all of total', () => {
    const edge = periodAllowance(vault(20_800_000n), limit, 1_001_000, ROOM);
    assert.deepEqual([edge.periodRunning, edge.remaining, edge.nextMax], [false, 22_000_000n, 6_000_000n]);
    const before = periodAllowance(vault(20_800_000n), limit, 1_000_999, ROOM);
    assert.deepEqual([before.periodRunning, before.remaining], [true, 1_200_000n]);
    assert.equal(periodAllowance(vault(22_000_000n), limit, 5_000_000, ROOM).remaining, 22_000_000n);
  });
  test('a total below per_tx limits the next payment too', () => {
    const small = { perTx: 6_000_000n, total: 4_000_000n, periodMs: 1000 };
    assert.equal(periodAllowance(vault(0n), small, 1_000_500, ROOM).nextMax, 4_000_000n);
  });
  test('what the vault holds above the ledger minimum of its next output limits the next payment, and never below 0', () => {
    assert.equal(periodAllowance(vault(0n), limit, 1_000_500, 3_000_000n).nextMax, 3_000_000n, 'below per_tx and remaining');
    assert.equal(periodAllowance(vault(0n), limit, 1_000_500, 6_000_000n).nextMax, 6_000_000n, 'equal to per_tx');
    assert.equal(periodAllowance(vault(0n), limit, 1_000_500, 6_000_001n).nextMax, 6_000_000n, 'above per_tx');
    assert.equal(periodAllowance(vault(20_800_000n), limit, 1_000_500, 5_000_000n).nextMax, 1_200_000n, 'above what the period leaves');
    assert.equal(periodAllowance(vault(0n), limit, 1_000_500, 0n).nextMax, 0n);
    assert.equal(periodAllowance(vault(0n), limit, 1_000_500, 3_000_000n).remaining, 22_000_000n, 'room does not change what the period allows');
  });
});

// ─── readVaults on the capture ──────────────────────────────────────────────────────────────────────────────────────────────

describe('readVaults on the capture', () => {
  test('by owner key hash: the Live output first, then the four Returned outputs by reference; Koios narrows by the key hash', async () => {
    const w = world();
    const page = await readVaults(w.env, { ownerKeyHash: OWNER.toUpperCase() }, CAPTURE_MS);
    assert.deepEqual(refsOf(page), [LIVE_OUTPUT.ref, ...RETURNED.map((r) => r.ref).sort()]);
    assert.deepEqual([page.total, page.offset, page.limit, page.nextOffset], [5, 0, 20, null]);
    assert.equal(filterOf(w), `like.*${OWNER}*`);
    assert.deepEqual(page.items.slice(1).map((r) => r.live), [null, null, null, null]);
    for (const r of page.items) assert.deepEqual(r.output.vault, decodeVaultDatum(r.output.utxo.datum!));
    assert.deepEqual(page.items.slice(1).map((r) => r.output.utxo.assets.lovelace), [1_064_570n, 1_064_570n, 1_064_570n, 1_064_570n]);
    assert.equal(page.items[0].output.utxo.assets.lovelace, 9_200_000n);
  });
  test('the Live output: its delegation exists, its limit is the one of the delegation, it can pay, and its period is long over at the capture', async () => {
    const [live] = (await readVaults(world().env, { ownerKeyHash: OWNER }, CAPTURE_MS)).items;
    assert.equal(live.live!.delegation!.chain.length, 1);
    assert.equal(live.live!.delegation!.id, DELEGATION.id);
    assert.deepEqual(live.live!.limit, LIMIT);
    assert.equal(live.live!.ownerIsDelegator, true);
    assert.deepEqual([live.live!.error, live.live!.problems, live.live!.canPay], [null, [], true]);
    const a = live.live!.allowance!;
    assert.deepEqual([a.periodStart, a.periodEnd, a.periodRunning, a.spent], [1794846798000, 1794846798000 + DAY, false, 20_800_000n]);
    assert.deepEqual([a.remaining, a.nextMax], [22_000_000n, 6_000_000n]);
  });
  test('inside its period the Live output of mainnet has 1.2 AP3X left, which is below the smallest escrow output: it cannot pay, and the problem says why', async () => {
    const [live] = (await readVaults(world().env, { ownerKeyHash: OWNER }, LIVE_VAULT.periodStart + 3_600_000)).items;
    const r = live.live!;
    assert.deepEqual([r.canPay, r.allowance, r.error], [false, null, null]);
    assert.deepEqual(r.problems, [`the delegation allows 1200000 more lovelace in the period that a payment built now falls in, and the smallest escrow output needs ${r.escrow!.minimum} lovelace (its ledger minimum): no payment can leave this output`]);
    assert.ok(r.escrow!.minimum > 2_000_000n && r.escrow!.minimum < 3_000_000n, `the minimum is ${r.escrow!.minimum}`);
  });
  test('the contract counts the old period for a minute after it ends: the builders open the window a minute before the build', async () => {
    const end = LIVE_VAULT.periodStart + DAY;
    // The vault of mainnet with 10 AP3X spent: the period leaves 12 AP3X, enough for a payment.
    const at = async (ms: number) => (await readVaults(ledgerWorld([vaultUtxo({ ...LIVE_VAULT, spent: 10_000_000n }, 9_200_000n), ...payable()]).env, { ownerKeyHash: OWNER }, ms)).items[0].live!.allowance!;
    assert.equal((await at(end - 1)).periodRunning, true);
    assert.equal((await at(end)).periodRunning, true, 'at the end of the period a payment still counts it');
    assert.equal((await at(end + 59_999)).periodRunning, true, 'a window that opens a second before the end counts the period');
    const over = await at(end + 60_000);
    assert.deepEqual([over.periodRunning, over.remaining], [false, 22_000_000n], 'a window that opens at the end starts a new period');
    assert.deepEqual([(await at(end + 59_999)).remaining, (await at(end + 59_999)).nextMax], [12_000_000n, 6_000_000n]);
  });
  test('by delegation: the Live output that names it, and not the Returned outputs, which name only their owner', async () => {
    const w = world();
    const page = await readVaults(w.env, { delegation: DELEGATION.id.toUpperCase() }, CAPTURE_MS);
    assert.deepEqual(refsOf(page), [LIVE_OUTPUT.ref]);
    assert.equal(filterOf(w), `like.*${DELEGATION.id}*`);
    assert.deepEqual(page.items[0].live!.limit, LIMIT);
  });
  test('by output reference: the unspent output on the node; a Returned one has no delegation to read', async () => {
    const live = await readVaults(world().env, { vaultRef: LIVE_OUTPUT.ref.toUpperCase() }, CAPTURE_MS);
    assert.deepEqual(refsOf(live), [LIVE_OUTPUT.ref]);
    assert.deepEqual(live.items[0].live!.limit, LIMIT);
    const returned = await readVaults(world().env, { vaultRef: RETURNED[0].ref }, CAPTURE_MS);
    assert.deepEqual([refsOf(returned), returned.items[0].live], [[RETURNED[0].ref], null]);
    const w = world();
    await readVaults(w.env, { vaultRef: LIVE_OUTPUT.ref }, CAPTURE_MS);
    assert.equal(callsTo(w.koios, 'credential_utxos').length, 0, 'a read by reference does not list the credential');
  });
  test('an output reference that is not an unspent vault output is an error that says so', async () => {
    const w = world([utxoOf(CAPTURE.attestations[0])]);
    await assert.rejects(() => readVaults(w.env, { vaultRef: `${'ee'.repeat(32)}#1` }, CAPTURE_MS), /is not an unspent output on the node/);
    await assert.rejects(() => readVaults(w.env, { vaultRef: `${CAPTURE.attestations[0].tx_hash}#${CAPTURE.attestations[0].tx_index}` }, CAPTURE_MS), /is not at the vault address/);
    await assert.rejects(() => readVaults(w.env, { vaultRef: 'x' }, CAPTURE_MS), /Invalid out ref/);
  });
  test('an owner key hash and a delegation that are not hex of the right length are refused before Koios is asked', async () => {
    const w = world();
    await assert.rejects(() => readVaults(w.env, { ownerKeyHash: 'abc' }, CAPTURE_MS), /owner key hash must be 56 hex/);
    await assert.rejects(() => readVaults(w.env, { ownerKeyHash: 'ab'.repeat(32) }, CAPTURE_MS), /owner key hash must be 56 hex/);
    await assert.rejects(() => readVaults(w.env, { delegation: 'ab'.repeat(28) }, CAPTURE_MS), /delegation must be 64 hex/);
    assert.equal(w.koios.calls.length, 0);
  });
  test('an owner that has no vault output, and a delegation that no output names, give no row', async () => {
    const none = await readVaults(world().env, { ownerKeyHash: 'ab'.repeat(28) }, CAPTURE_MS);
    assert.deepEqual([none.items, none.total, none.nextOffset], [[], 0, null]);
    assert.equal((await readVaults(world().env, { delegation: 'ab'.repeat(32) }, CAPTURE_MS)).total, 0);
  });
  test('Koios answers that are too big are refused: a page of credential_utxos over the cap', async () => {
    const w = ledgerWorld(CAPTURE.vaults.map(utxoOf), { announce: { credential_utxos: KOIOS_ANSWER_BYTES + 1 } });
    await assert.rejects(() => readVaults(w.env, { ownerKeyHash: OWNER }, CAPTURE_MS), /Koios credential_utxos: the answer is over the 16777216 byte limit/);
  });
});

// ─── Order, pages and the cost of a read ───────────────────────────────────────────────────────────────────────────────────

describe('readVaults: anyone can write a vault output, so the order shows the outputs that can pay first', () => {
  const OWNER_KEY = testKey(50);
  const owner: Delegator = { type: 'PrincipalKey', hash: OWNER_KEY.keyHash, organisation: null };
  const ATTACKER: Delegator = { type: 'PrincipalKey', hash: testKey(51).keyHash, organisation: null };
  const D = 'd1'.repeat(32);
  const live = (over: Partial<Live> = {}): Live => ({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2, ...over });
  const out = (datum: VaultDatum, lovelace = 5_000_000n): UTxO => vaultUtxo(datum, lovelace);
  /** The delegation D of `owner` that can be used for a payment, and its delegate. */
  const delegated = (over = {}): UTxO[] => [delegationUtxo(D, delegation({ delegator: owner, ...over })), recordUtxo(delegation().delegate, liveRecord({}, [testKey(31).publicKey]))];
  const junkId = (i: number): string => (i + 1).toString(16).padStart(2, '0').repeat(32);

  test('by delegation: 55 outputs of an attacker with lower references do not hide the real vault, and every output is reachable by offset', async () => {
    // The outputs are made in this order, so the references of the attacker's outputs sort before the real one.
    const hostile = Array.from({ length: 55 }, () => out(live({ owner: ATTACKER })));
    const real = out(live(), 9_000_000n);
    const w = ledgerWorld([...hostile, real, ...delegated()]);
    const page = await readVaults(w.env, { delegation: D }, CAPTURE_MS);
    assert.deepEqual([page.total, page.items.length, page.nextOffset], [56, 20, 20]);
    assert.equal(page.items[0].output.ref, refOf(real), 'the real vault is first');
    assert.deepEqual([page.items[0].live!.ownerIsDelegator, page.items[0].live!.canPay], [true, true]);
    assert.ok(page.items.slice(1).every((r) => r.live!.ownerIsDelegator === false && r.live!.canPay === false));
    const seen: string[] = [];
    let next: number | null = 0;
    for (let pages = 0; next !== null && pages < 10; pages++) {
      const p: Page<VaultReading> = await readVaults(w.env, { delegation: D }, CAPTURE_MS, { offset: next, limit: 20 });
      seen.push(...refsOf(p));
      next = p.nextOffset;
    }
    assert.equal(next, null, 'the pages end');
    assert.deepEqual([...seen].sort(), [...hostile, real].map(refOf).sort(), 'every output once');
    assert.equal(seen[0], refOf(real));
  });
  test('by owner key hash: the outputs whose owner is the delegator come first, then the other Live outputs, then the Returned ones', async () => {
    const OTHER = 'd2'.repeat(32);
    const nobody = Array.from({ length: 25 }, (_, i) => out(live({ delegation: junkId(i + 10) })));
    const ofOthers = out(live({ delegation: OTHER }));
    const returned = Array.from({ length: 3 }, (_, i) => out({ type: 'Returned', owner }, 1_000_000n + BigInt(i)));
    const real = out(live(), 9_000_000n);
    // OTHER is a delegation that exists but belongs to someone else, as the owner of the output is not its delegator.
    const w = ledgerWorld([...nobody, ofOthers, ...returned, real, ...delegated(), delegationUtxo(OTHER, delegation({ delegator: ATTACKER }))]);
    const first = await readVaults(w.env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS, { limit: 50 });
    assert.equal(first.total, 30);
    assert.equal(first.items[0].output.ref, refOf(real));
    assert.equal(first.items[0].live!.canPay, true);
    const live2 = first.items.filter((r) => r.output.vault.type === 'Live').slice(1);
    assert.deepEqual(live2.map((r) => r.output.ref), [...nobody, ofOthers].map(refOf).sort(), 'the other Live outputs, by reference');
    assert.deepEqual(first.items.slice(-3).map((r) => r.output.ref), returned.map(refOf).sort(), 'the Returned outputs last');
    assert.equal(first.items.findIndex((r) => r.output.vault.type === 'Returned'), 27);
    // The owner of the real vault is read from one request to the delegation credential, with the token filter and without a datum filter.
    const asked = callsTo(w.koios, 'credential_utxos').filter((c) => c.body !== null && Array.isArray(c.body._payment_credentials) && c.body._payment_credentials[0] === MAINNET.delegation.hash);
    assert.equal(asked.length, 1);
    const q = new URL(asked[0].url).searchParams;
    assert.deepEqual([q.get('asset_list'), q.has('inline_datum->>bytes')], [`cs.[{"policy_id":"${MAINNET.delegation.hash}"}]`, false]);
  });
  test('a page shows the outputs that can pay first even when the real vault has the highest reference', async () => {
    const hostile = Array.from({ length: 25 }, (_, i) => out(live({ delegation: junkId(i + 10) })));
    const real = out(live(), 9_000_000n);
    const w = ledgerWorld([...hostile, real, ...delegated()]);
    const page = await readVaults(w.env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS, { limit: 5 });
    assert.equal(page.items[0].output.ref, refOf(real));
    assert.equal(page.nextOffset, 5);
  });
  test('a page that is not one is refused before Koios is asked', async () => {
    const w = ledgerWorld([out(live()), ...delegated()]);
    for (const paging of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { limit: 2.5 }, { offset: 0.5 }]) {
      await assert.rejects(() => readVaults(w.env, { delegation: D }, CAPTURE_MS, paging), /must be a whole number/, JSON.stringify(paging));
    }
    assert.equal(w.koios.calls.length, 0);
    assert.equal((await readVaults(w.env, { delegation: D }, CAPTURE_MS, { limit: 50 })).total, 1);
  });
  test('an offset past the end gives no row and the total', async () => {
    const w = ledgerWorld([out(live()), out(live()), ...delegated()]);
    const page = await readVaults(w.env, { delegation: D }, CAPTURE_MS, { offset: 2 });
    assert.deepEqual([page.items, page.total, page.offset, page.nextOffset], [[], 2, 2, null]);
    assert.equal((await readVaults(w.env, { delegation: D }, CAPTURE_MS, { offset: 1 })).items.length, 1);
  });

  test('only the outputs of the page are read further: 30 outputs that name 30 delegations are read for the 5 of the page', async () => {
    const hostile = Array.from({ length: 30 }, (_, i) => out(live({ delegation: junkId(i) })));
    const w = ledgerWorld(hostile);
    const page = await readVaults(w.env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS, { limit: 5 });
    assert.equal(page.total, 30);
    assert.equal(w.provider.scansOf(MAINNET.delegation.address), 5, 'one read of a delegation for each output of the page');
    const all = ledgerWorld(hostile);
    await readVaults(all.env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS, { limit: 50 });
    assert.equal(all.provider.scansOf(MAINNET.delegation.address), 30, 'with a page of 50, all 30 are read, once each');
  });
  test('each delegation and each record is read once for a call, however many outputs of the page name it', async () => {
    const same = Array.from({ length: 6 }, (_, i) => out(live({ spent: BigInt(i) })));
    const w = ledgerWorld([...same, ...delegated()]);
    const page = await readVaults(w.env, { delegation: D }, CAPTURE_MS);
    assert.equal(page.total, 6);
    assert.equal(w.provider.scansOf(MAINNET.delegation.address), 1, 'the delegation');
    assert.equal(w.provider.scansOf(MAINNET.identity.address), 1, 'the record of its delegate');
    const byOwner = ledgerWorld([...same, ...delegated()]);
    await readVaults(byOwner.env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS);
    assert.equal(byOwner.provider.scansOf(MAINNET.delegation.address), 1);
    assert.equal(byOwner.provider.scansOf(MAINNET.identity.address), 1);
  });
  test('delegations of one family share their parent and their delegates: each is read once for the call', async () => {
    const P = 'a1'.repeat(32);
    const AGENT = 'c4'.repeat(32);
    const keyP = testKey(32);
    const parent = delegationUtxo(P, delegation({ delegate: AGENT, delegateKey: keyP.keyHash, remaining: 1, delegator: owner }));
    const kids = ['b1', 'b2', 'b3'].map((b) => b.repeat(32));
    const children = kids.map((id) => delegationUtxo(id, delegation({ parent: P, depth: 2, remaining: 0, delegator: owner })));
    const vaults = kids.map((id) => out(live({ delegation: id })));
    const w = ledgerWorld([...vaults, parent, ...children, recordUtxo(AGENT, liveRecord({}, [keyP.publicKey])), recordUtxo(delegation().delegate, liveRecord({}, [testKey(31).publicKey]))]);
    const page = await readVaults(w.env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS);
    assert.deepEqual(page.items.map((r) => r.live!.canPay), [true, true, true], page.items.map((r) => r.live!.problems.join('; ')).join(' | '));
    assert.equal(w.provider.scansOf(MAINNET.delegation.address), 4, 'the three children and their parent, once each');
    assert.equal(w.provider.scansOf(MAINNET.identity.address), 2, 'the delegate of the children and the delegate of the parent, once each');
  });
  test('a call that needs more time than its budget stops with an error that says what to do; one with time does not', async () => {
    const w = ledgerWorld([out(live()), ...delegated()]);
    for (const selector of [{ delegation: D }, { ownerKeyHash: OWNER_KEY.keyHash }]) {
      await assert.rejects(() => readVaults({ ...w.env, budgetMs: 0 }, selector, CAPTURE_MS), (err: Error) => err instanceof BudgetSpent && /A list can ask for fewer rows \(limit\)/.test(err.message), JSON.stringify(selector));
      assert.equal((await readVaults({ ...w.env, budgetMs: 60_000 }, selector, CAPTURE_MS)).total, 1);
    }
  });
  test('the whole call ends when its budget is spent even when Koios holds a request open: a read that never answers does not keep the call', { timeout: 20_000 }, async () => {
    const w = ledgerWorld([out(live()), ...delegated()]);
    const hung = { ...w.env, fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch, budgetMs: 50 };
    const started = Date.now();
    for (const selector of [{ ownerKeyHash: OWNER_KEY.keyHash }, { delegation: D }]) {
      await assert.rejects(() => endsWithin(5_000, readVaults(hung, selector, CAPTURE_MS)), (err: Error) => err instanceof BudgetSpent && /the node or Koios answers too slowly/.test(err.message), JSON.stringify(selector));
    }
    assert.ok(Date.now() - started < 5_000, 'the call ended by its budget');
    assert.equal((await readVaults({ ...w.env, budgetMs: 60_000 }, { delegation: D }, CAPTURE_MS)).total, 1, 'the twin: Koios answers');
  });
  test('a budget that is spent while a chain is read ends the whole call: it is not reported as the error of that output', async (t) => {
    const P = 'a1'.repeat(32);
    const C = 'a2'.repeat(32);
    const parent = delegationUtxo(P, delegation({ delegator: owner, remaining: 1 }));
    const child = delegationUtxo(C, delegation({ parent: P, depth: 2, remaining: 0, delegator: owner }));
    const w = ledgerWorld([out(live({ delegation: C })), parent, child]);
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
    const scan = w.provider.getUtxos.bind(w.provider);
    // Each scan of an address costs 2 s of the clock of the call.
    w.provider.getUtxos = async (address: Address | Credential) => { const found = await scan(address); t.mock.timers.tick(2_000); return found; };
    await assert.rejects(() => readVaults({ ...w.env, budgetMs: 1_000 }, { ownerKeyHash: owner.hash }, CAPTURE_MS), BudgetSpent);
    assert.equal((await readVaults({ ...w.env, budgetMs: 60_000 }, { ownerKeyHash: owner.hash }, CAPTURE_MS)).total, 1, 'the twin: the budget is enough');
  });
});

// ─── A hostile row does not break a read ────────────────────────────────────────────────────────────────────────────────────────

describe('readVaults: one hostile row does not break a read', () => {
  const owner: Delegator = { type: 'PrincipalKey', hash: testKey(50).keyHash, organisation: null };
  const D = 'd1'.repeat(32);
  const BAD = 'bd'.repeat(32);
  const live = (delegationId: string, spent = 1_000_000n): Live => ({ type: 'Live', owner, delegation: delegationId, spent, periodStart: CAPTURE_MS - DAY / 2 });
  const delegated = (): UTxO[] => [delegationUtxo(D, delegation({ delegator: owner })), recordUtxo(delegation().delegate, liveRecord({}, [testKey(31).publicKey]))];
  /** A delegation under a limit with a period of 2^60 ms: the contract accepts it, and the codec of the builders does not. */
  const wide = delegationUtxo(BAD, delegation({ delegator: owner }), { datum: delegationWithPeriod(2n ** 60n, { delegator: owner }) });

  test('a delegation whose period is above 2^53 is reported on the outputs that name it, and the other outputs are read as they are', async () => {
    const good = vaultUtxo(live(D), 9_000_000n);
    const hostile = vaultUtxo(live(BAD), 5_000_000n);
    assert.throws(() => decodeDelegationDatum(wide.datum!), /outside the safe range/, 'the codec refuses the datum');
    const w = ledgerWorld([good, hostile, wide, ...delegated()]);
    const page = await readVaults(w.env, { ownerKeyHash: owner.hash }, CAPTURE_MS);
    assert.equal(page.total, 2);
    const byRef = new Map(page.items.map((r) => [r.output.ref, r.live!]));
    const bad = byRef.get(refOf(hostile))!;
    assert.match(bad.error!, /The delegation (bd){32} .*does not decode.*outside the safe range/);
    assert.deepEqual([bad.delegation, bad.limit, bad.ownerIsDelegator, bad.canPay, bad.allowance, bad.problems], [null, null, null, false, null, []]);
    const ok = byRef.get(refOf(good))!;
    assert.deepEqual([ok.error, ok.canPay], [null, true]);
    assert.equal(page.items[0].output.ref, refOf(good), 'the output that can pay is first');
  });
  test('by delegation and by output reference the same output reports the same error', async () => {
    const hostile = vaultUtxo(live(BAD), 5_000_000n);
    const w = ledgerWorld([hostile, wide]);
    const byDelegation = await readVaults(w.env, { delegation: BAD }, CAPTURE_MS);
    assert.match(byDelegation.items[0].live!.error!, /does not decode/);
    const byRef = await readVaults(w.env, { vaultRef: refOf(hostile) }, CAPTURE_MS);
    assert.match(byRef.items[0].live!.error!, /does not decode/);
  });
  test('a delegation that the node cannot read at all is reported on its output as well, and a read that is fine reports none', async () => {
    const hostile = vaultUtxo(live(D), 5_000_000n);
    const noDatum = delegationUtxo(D, delegation({ delegator: owner }), { datum: null });
    const r = (await readVaults(ledgerWorld([hostile, noDatum]).env, { delegation: D }, CAPTURE_MS)).items[0].live!;
    assert.match(r.error!, /has no inline datum/);
    assert.equal((await readVaults(ledgerWorld([hostile, ...delegated()]).env, { delegation: D }, CAPTURE_MS)).items[0].live!.error, null);
  });
});

// ─── An allowance only for an output that can pay ────────────────────────────────────────────────────────────────────────────

describe('readVaults: an allowance only for an output that can pay', () => {
  const owner: Delegator = { type: 'PrincipalKey', hash: testKey(50).keyHash, organisation: null };
  const D = 'd1'.repeat(32);
  const DELEGATE = delegation().delegate;
  const KEY = testKey(31);
  const live = (over: Partial<Live> = {}): Live => ({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2, ...over });
  const record = (over = {}, keys = [KEY.publicKey]) => recordUtxo(DELEGATE, liveRecord(over, keys));
  /** The Live output with 9 AP3X, the delegation D of its owner (changed by `over`) and its delegate, and `extra`. */
  const read = async (over: Partial<DelegationDatum> = {}, extra: UTxO[] = [], vault: Live = live(), lovelace = 9_000_000n, atMs = CAPTURE_MS) => {
    const w = ledgerWorld([vaultUtxo(vault, lovelace), delegationUtxo(D, delegation({ delegator: owner, ...over })), ...extra]);
    return (await readVaults(w.env, { delegation: D }, atMs)).items[0].live!;
  };
  const holdUntilLater: IdentityDatum['status'] = { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: CAPTURE_MS - 1000, until: CAPTURE_MS + DAY }] };

  test('an output that can pay: no problem, and the allowance; the twin of every refusal below', async () => {
    const r = await read({}, [record()]);
    assert.deepEqual([r.problems, r.canPay, r.error], [[], true, null]);
    assert.equal(r.allowance!.nextMax, 6_000_000n);
    assert.deepEqual([r.allowance!.remaining, r.ownerIsDelegator], [22_000_000n - 1_000_000n, true]);
  });
  test('the owner is not the delegator: no allowance, and the problem says so', async () => {
    const r = await read({ delegator: { type: 'PrincipalKey', hash: 'ab'.repeat(28), organisation: null } }, [record()]);
    assert.deepEqual([r.ownerIsDelegator, r.canPay, r.allowance], [false, false, null]);
    assert.ok(r.problems.some((p) => /owner of this output is not the delegator of the delegation, so it cannot pay/.test(p)), r.problems.join('; '));
    const withOrg = await read({ delegator: { ...owner, organisation: '6f7267' } }, [record()]);
    assert.deepEqual([withOrg.ownerIsDelegator, withOrg.canPay], [false, false]);
  });
  test('a delegation without a value limit: no allowance, and the problem says a vault pays only under a limit', async () => {
    const r = await read({ value: null }, [record()]);
    assert.deepEqual([r.limit, r.canPay, r.allowance], [null, false, null]);
    assert.ok(r.problems.some((p) => /has no value limit, and a vault pays only under one/.test(p)), r.problems.join('; '));
  });
  test('a delegation past not_after has no allowance, and the problem names the end', async () => {
    const r = await read({ notAfter: CAPTURE_MS - 1000 }, [record()]);
    assert.deepEqual([r.delegation!.chain.length, r.canPay, r.allowance], [1, false, null]);
    assert.ok(r.problems.some((p) => p.includes(`ends at ${new Date(CAPTURE_MS - 1000).toISOString()}, before the end of the validity window`)), r.problems.join('; '));
  });
  test('a delegation that has not started has no allowance either', async () => {
    const r = await read({ notBefore: CAPTURE_MS + DAY }, [record()]);
    assert.deepEqual([r.canPay, r.allowance], [false, null]);
    assert.ok(r.problems.some((p) => /starts at .*, after the start of the validity window/.test(p)), r.problems.join('; '));
  });
  test('the payment has the shortest window that the builders make: a minute before now to a minute after, and not the instant', async () => {
    assert.equal((await read({ notAfter: CAPTURE_MS + 60_000 }, [record()])).canPay, true, 'the window ends at not_after');
    assert.equal((await read({ notAfter: CAPTURE_MS + 59_999 }, [record()])).canPay, false, 'the window ends a millisecond after not_after');
    assert.equal((await read({ notBefore: CAPTURE_MS - 60_000 }, [record()])).canPay, true, 'the window starts at not_before');
    assert.equal((await read({ notBefore: CAPTURE_MS - 59_999 }, [record()])).canPay, false, 'the window starts a millisecond before not_before');
  });
  test('a parent that was undelegated: no allowance, and the problem names the parent', async () => {
    const P = 'a1'.repeat(32);
    const AGENT = 'c3'.repeat(32);
    const child = { parent: P, depth: 2, remaining: 0, delegator: { type: 'Agent', id: AGENT } } as const;
    const r = await read(child, [record(), recordUtxo(AGENT, liveRecord())], live({ owner: { type: 'Agent', id: AGENT } }));
    assert.deepEqual([r.delegation!.missingParent, r.canPay, r.allowance], [P, false, null]);
    assert.ok(r.problems.includes(`the parent delegation ${P} of ${D} is missing`), r.problems.join('; '));
  });
  test('a delegate that is not Active, and a delegate that no longer lists its key: no allowance', async () => {
    const suspended = await read({}, [record({ status: holdUntilLater })]);
    assert.deepEqual([suspended.canPay, suspended.allowance], [false, null]);
    assert.ok(suspended.problems.some((p) => p === `the delegate did:vector:${DELEGATE} of ${D} is Suspended`), suspended.problems.join('; '));
    const noKey = await read({}, [record({}, [testKey(40).publicKey])]);
    assert.deepEqual([noKey.canPay, noKey.allowance], [false, null]);
    assert.ok(noKey.problems.some((p) => /no longer lists the delegate key/.test(p)), noKey.problems.join('; '));
  });
  test('the record of the delegate cannot be read: a problem, and not an error that ends the read', async () => {
    const r = await read({}, []);
    assert.deepEqual([r.canPay, r.allowance, r.error], [false, null, null]);
    assert.ok(r.problems.some((p) => /the records that the use checks read cannot be read \(No record of the delegate for did:vector:/.test(p)), r.problems.join('; '));
  });
  test('an output that holds a token besides AP3X cannot pay (vault decision 5)', async () => {
    const w = ledgerWorld([vaultUtxo(live(), 9_000_000n, { assets: { lovelace: 9_000_000n, [`${'ab'.repeat(28)}01`]: 1n } }), delegationUtxo(D, delegation({ delegator: owner })), record()]);
    const r = (await readVaults(w.env, { delegation: D }, CAPTURE_MS)).items[0].live!;
    assert.deepEqual([r.canPay, r.allowance], [false, null]);
    assert.ok(r.problems.some((p) => /holds assets other than AP3X, so it cannot pay/.test(p)), r.problems.join('; '));
  });
  test('an output that was posted for the delegation of another owner is not read as the vault of this one: no allowance', async () => {
    const r = await read({}, [record()], live({ owner: { type: 'Agent', id: 'a7'.repeat(32) } }));
    assert.deepEqual([r.ownerIsDelegator, r.canPay, r.allowance], [false, false, null]);
  });
  test('every problem is reported at once', async () => {
    const r = await read({ value: null, notAfter: CAPTURE_MS - 1000, delegator: { type: 'PrincipalKey', hash: 'ab'.repeat(28), organisation: null } }, [record()]);
    assert.equal(r.canPay, false);
    assert.equal(r.problems.length, 3, r.problems.join('; '));
  });

  test('next_max is what a payment can take: a vault of 5 AP3X under 6 AP3X per payment can take 5 AP3X less the ledger minimum of its next output', async () => {
    const r = await read({}, [record()], live({ spent: 0n, periodStart: 0 }), 5_000_000n);
    const worst: Live = { ...live(), spent: 22_000_000n, periodStart: windowAt(CAPTURE_MS, 1).hi };
    const minimum = minimumOf(5_000_000n, worst);
    assert.ok(minimum > 1_000_000n && minimum < 2_000_000n, `the minimum is ${minimum}`);
    assert.equal(r.allowance!.nextMax, 5_000_000n - minimum);
    assert.ok(r.allowance!.nextMax < 5_000_000n && r.allowance!.nextMax < 6_000_000n);
    assert.equal(r.allowance!.remaining, 22_000_000n, 'the period allows more: the vault is what limits the payment');
  });
  test('a vault that holds 9 AP3X is limited by the 6 AP3X of one payment, and one that holds as much as its minimum cannot pay at all', async () => {
    assert.equal((await read({}, [record()], live({ spent: 0n, periodStart: 0 }), 9_000_000n)).allowance!.nextMax, 6_000_000n);
    const worst: Live = { ...live(), spent: 22_000_000n, periodStart: windowAt(CAPTURE_MS, 1).hi };
    for (const lovelace of [minimumOf(1_300_000n, worst), 1_000_000n]) {
      const none = await read({}, [record()], live({ spent: 0n, periodStart: 0 }), lovelace);
      assert.deepEqual([none.canPay, none.allowance], [false, null], String(lovelace));
      assert.ok(none.problems.some((p) => /the vault holds \d+ lovelace and its next output needs \d+, so a payment may lock at most 0, and the smallest escrow output needs/.test(p)), none.problems.join('; '));
    }
  });
  test('the protocol parameters are read from the node once, and only when an output can pay', async () => {
    let asked = 0;
    const w = ledgerWorld([vaultUtxo(live(), 9_000_000n), vaultUtxo(live({ spent: 2n }), 9_000_000n), delegationUtxo(D, delegation({ delegator: owner })), record()]);
    const read1 = w.provider.getProtocolParameters.bind(w.provider);
    w.provider.getProtocolParameters = async () => { asked += 1; return read1(); };
    assert.equal((await readVaults(w.env, { delegation: D }, CAPTURE_MS)).total, 2);
    assert.equal(asked, 1);
    asked = 0;
    const none = ledgerWorld([vaultUtxo(live(), 9_000_000n)]);
    none.provider.getProtocolParameters = async () => { asked += 1; throw new Error('the node must not be asked'); };
    assert.equal((await readVaults(none.env, { delegation: D }, CAPTURE_MS)).items[0].live!.canPay, false);
    assert.equal(asked, 0);
  });
  test('the period starts when the first payment is made: a vault with period_start 0 has all of total, whatever period_ms is', async () => {
    const r = await read({}, [record()], live({ spent: 0n, periodStart: 0 }));
    assert.deepEqual([r.allowance!.periodStart, r.allowance!.periodRunning, r.allowance!.remaining], [0, false, 22_000_000n]);
  });
});

// ─── The smallest escrow output ──────────────────────────────────────────────────────────────────────────────────────────────

describe('readVaults: an output can pay only when its next payment reaches the ledger minimum of the smallest escrow output', () => {
  const owner: Delegator = { type: 'PrincipalKey', hash: testKey(50).keyHash, organisation: null };
  const D = 'd1'.repeat(32);
  const KEY = testKey(31);
  const payWindow = windowAt(CAPTURE_MS, 1);
  const live = (over: Partial<Live> = {}): Live => ({ type: 'Live', owner, delegation: D, spent: 0n, periodStart: 0, ...over });
  /** The Open escrow of a payment from the vault of `vaultOwner` for `delegateKey`: no capability, no bonds, and a payment of `payment` lovelace. Written here, and not by the code under test. */
  const openEscrow = (delegateKey: string, vaultOwner: Delegator, payment: bigint): IdentityEscrowDatum => ({
    buyer_pkh: delegateKey, supplier_pkh: '11'.repeat(28), advert_ref: { txHash: '22'.repeat(32), index: 0 }, capability_id: '', request_spec_hash: '33'.repeat(32), prompt_hash: '44'.repeat(32),
    payment_lovelace: payment, buyer_bond_lovelace: 0n, supplier_bond_lovelace: 0n, deliver_by: payWindow.hi + 180_000, posted_at: payWindow.lo + 60_000,
    submitted_at: null, result_receipt_hash: null, state: 'Open', agent_id: '55'.repeat(32),
    refund: { address: plutusAddressFromBech32(MAINNET.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner: vaultOwner }) },
  });
  /** What the ledger counts for the output at the escrow address that holds `datum`. */
  const ledgerMinimum = (datum: string): bigint => calculateMinLovelaceFromUTxO(fixtureProtocolParameters().coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address: MAINNET.escrow.address, assets: { lovelace: 0n }, datum });
  const SMALLEST = openEscrow(delegation().delegateKey, owner, 2_500_000n);
  const MINIMUM = ledgerMinimum(encodeIdentityEscrowDatum(SMALLEST));
  /** The ledger minimum of the next vault output of a payment under a total of 22 AP3X: the whole total spent, and the latest start. */
  const KEPT = minimumOf(0n, { ...live(), spent: 22_000_000n, periodStart: payWindow.hi });
  const record = () => recordUtxo(delegation().delegate, liveRecord({}, [KEY.publicKey]));
  const readOne = async (limit: Partial<ValueLimit>, vault: Live, lovelace: bigint) => {
    const value = { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY, ...limit };
    const w = ledgerWorld([vaultUtxo(vault, lovelace), delegationUtxo(D, delegation({ delegator: owner, value })), record()]);
    return (await readVaults(w.env, { delegation: D }, CAPTURE_MS)).items[0].live!;
  };

  test('the smallest escrow output is the Open escrow with the delegate key and the refund to the vault: its minimum is the ledger minimum of that output, and the floor of the build tool is the lock floor of the builder for it', async () => {
    const r = await readOne({}, live(), 9_000_000n);
    assert.equal(r.escrow!.minimum, MINIMUM);
    assert.ok(MINIMUM > 2_000_000n && MINIMUM < 3_000_000n, `the minimum is ${MINIMUM}`);
    assert.equal(ledgerMinimum(encodeIdentityEscrowDatum(openEscrow(delegation().delegateKey, owner, MINIMUM))), MINIMUM, 'a payment of exactly the minimum has the same minimum');
    assert.equal(r.escrow!.buildFloor, identityEscrowLockFloor(SMALLEST, 0n));
    assert.ok(r.escrow!.buildFloor > MINIMUM);
    // An advert with a capability and its own amounts locks at least that floor, and its escrow needs at least that minimum.
    const refund = SMALLEST.refund!;
    const plan = planVaultEscrow({ ...IDENTITY_ADVERT, price_lovelace: 100_000n, supplier_bond_lovelace: 100_000n, buyer_bond_lovelace: 100_000n }, ADVERT_REF, delegation().delegateKey, PAYLOAD, payWindow, { agentId: AGENT_ID, refund });
    assert.ok(plan.lockLovelace >= r.escrow!.buildFloor, `the builder locks ${plan.lockLovelace}`);
    assert.ok(ledgerMinimum(plan.datumHex) >= MINIMUM);
  });
  test('the minimum follows the owner of the vault, which the refund names: a longer owner makes a larger output', async () => {
    const organisation: Delegator = { ...owner, organisation: utf8Hex('Acme Corporation') };
    const w = ledgerWorld([vaultUtxo(live({ owner: organisation }), 9_000_000n), delegationUtxo(D, delegation({ delegator: organisation })), record()]);
    const r = (await readVaults(w.env, { delegation: D }, CAPTURE_MS)).items[0].live!;
    assert.equal(r.escrow!.minimum, ledgerMinimum(encodeIdentityEscrowDatum(openEscrow(delegation().delegateKey, organisation, 2_500_000n))));
    assert.ok(r.escrow!.minimum > MINIMUM);
    const agent: Delegator = { type: 'Agent', id: 'a7'.repeat(32) };
    const byAgent = ledgerWorld([vaultUtxo(live({ owner: agent }), 9_000_000n), delegationUtxo(D, delegation({ delegator: agent })), record(), recordUtxo(agent.id, liveRecord())]);
    assert.equal((await readVaults(byAgent.env, { delegation: D }, CAPTURE_MS)).items[0].live!.escrow!.minimum, ledgerMinimum(encodeIdentityEscrowDatum(openEscrow(delegation().delegateKey, agent, 2_500_000n))));
  });

  const BY = {
    'the limit per payment': {
      make: (x: bigint) => readOne({ perTx: x }, live(), 9_000_000n),
      problem: (x: bigint) => `the delegation allows ${x} lovelace for one payment, and the smallest escrow output needs ${MINIMUM} lovelace (its ledger minimum): no payment can leave this output`,
    },
    'what the period still allows': {
      make: (x: bigint) => readOne({}, live({ spent: 22_000_000n - x, periodStart: CAPTURE_MS - DAY / 2 }), 9_000_000n),
      problem: (x: bigint) => `the delegation allows ${x} more lovelace in the period that a payment built now falls in, and the smallest escrow output needs ${MINIMUM} lovelace (its ledger minimum): no payment can leave this output`,
    },
    'what the vault holds above the minimum of its next output': {
      make: (x: bigint) => readOne({}, live(), KEPT + x),
      problem: (x: bigint) => `the vault holds ${KEPT + x} lovelace and its next output needs ${KEPT}, so a payment may lock at most ${x}, and the smallest escrow output needs ${MINIMUM} lovelace (its ledger minimum): no payment can leave this output`,
    },
  };
  for (const [by, { make, problem }] of Object.entries(BY)) {
    test(`next_max set by ${by}: 0, 1 lovelace and the minimum minus 1 cannot pay, with a problem that says why; the minimum can, and so can one lovelace more`, async () => {
      for (const x of [0n, 1n, MINIMUM - 1n]) {
        const r = await make(x);
        assert.deepEqual([r.canPay, r.allowance, r.problems], [false, null, [problem(x)]], `${by}: ${x}`);
        assert.equal(r.escrow!.minimum, MINIMUM, 'the numbers are given when the output cannot pay');
      }
      const yes = await make(MINIMUM);
      assert.deepEqual([yes.canPay, yes.problems, yes.allowance!.nextMax], [true, [], MINIMUM], `${by}: the minimum`);
      const more = await make(MINIMUM + 1n);
      assert.deepEqual([more.canPay, more.allowance!.nextMax], [true, MINIMUM + 1n], `${by}: one lovelace more`);
    });
  }
  test('every limit that is below the minimum is a problem of its own: the three at once, in the order of the limits', async () => {
    const r = await readOne({ perTx: 1n }, live({ spent: 22_000_000n, periodStart: CAPTURE_MS - DAY / 2 }), KEPT);
    assert.equal(r.canPay, false);
    assert.deepEqual(r.problems, [BY['what the vault holds above the minimum of its next output'].problem(0n), BY['what the period still allows'].problem(0n), BY['the limit per payment'].problem(1n)]);
  });
  test('the smallest escrow output is not worked out for an output with another problem', async () => {
    const other: Delegator = { type: 'PrincipalKey', hash: 'ab'.repeat(28), organisation: null };
    const wrongOwner = ledgerWorld([vaultUtxo(live(), 9_000_000n), delegationUtxo(D, delegation({ delegator: other })), record()]);
    const r = (await readVaults(wrongOwner.env, { delegation: D }, CAPTURE_MS)).items[0].live!;
    assert.deepEqual([r.canPay, r.escrow, r.problems.length], [false, null, 1]);
    const noLimit = ledgerWorld([vaultUtxo(live(), 9_000_000n), delegationUtxo(D, delegation({ delegator: owner, value: null })), record()]);
    const n = (await readVaults(noLimit.env, { delegation: D }, CAPTURE_MS)).items[0].live!;
    assert.deepEqual([n.canPay, n.escrow], [false, null]);
  });
});

// ─── The page is confirmed on the node ───────────────────────────────────────────────────────────────────────────────────────

describe('readVaults: the page is confirmed on the node', () => {
  const owner: Delegator = { type: 'PrincipalKey', hash: testKey(50).keyHash, organisation: null };
  const D = 'd1'.repeat(32);
  const live = (over: Partial<Live> = {}): Live => ({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2, ...over });
  const out = (datum: VaultDatum, lovelace = 5_000_000n): UTxO => vaultUtxo(datum, lovelace);
  const delegated = (): UTxO[] => [delegationUtxo(D, delegation({ delegator: owner })), recordUtxo(delegation().delegate, liveRecord({}, [testKey(31).publicKey]))];
  /** The references that the node was asked for, one list for each request. */
  const watch = (w: LedgerWorld): string[][] => {
    const asked: string[][] = [];
    const original = w.provider.getUtxosByOutRef.bind(w.provider);
    w.provider.getUtxosByOutRef = async (refs) => { asked.push(refs.map((r) => `${r.txHash}#${r.outputIndex}`)); return original(refs); };
    return asked;
  };

  test('one request for the page, with the references of its outputs in the order of the page and no more: 50 at most, and the next page has its own', async () => {
    const w = ledgerWorld([...Array.from({ length: 55 }, () => out(live())), ...delegated()]);
    const asked = watch(w);
    const first = await readVaults(w.env, { delegation: D }, CAPTURE_MS, { limit: 50 });
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], refsOf(first));
    assert.equal(asked[0].length, 50);
    const second = await readVaults(w.env, { delegation: D }, CAPTURE_MS, { limit: 50, offset: 50 });
    assert.deepEqual([asked.length, asked[1].length, asked[1]], [2, 5, refsOf(second)]);
    assert.ok(first.items.every((r) => r.onNode));
  });
  test('a row that the node does not hold is not on the node: it cannot pay, its problem says that it is spent or the indexer is ahead, and nothing more is read for it', async () => {
    const E = 'e1'.repeat(32);
    const real = out(live(), 9_000_000n);
    const gone = out(live({ delegation: E, spent: 2_000_000n }), 7_000_000n);
    const goneReturned = out({ type: 'Returned', owner }, 1_100_000n);
    const node = [real, ...delegated(), delegationUtxo(E, delegation({ delegator: owner }))];
    const w = ledgerWorld(node, { rows: [...node.map((u) => koiosRow(u)), koiosRow(gone), koiosRow(goneReturned)] });
    const page = await readVaults(w.env, { ownerKeyHash: owner.hash }, CAPTURE_MS);
    assert.deepEqual(refsOf(page), [real, gone, goneReturned].map(refOf), 'the order is by AP3X as Koios lists them, and the confirmation does not change it');
    const [a, b, c] = page.items;
    assert.deepEqual([a.onNode, a.live!.canPay, a.live!.problems], [true, true, []]);
    assert.deepEqual([b.onNode, b.live!.canPay, b.live!.problems, b.live!.allowance, b.live!.escrow, b.live!.delegation, b.live!.error], [false, false, [NOT_ON_NODE], null, null, null, null]);
    assert.deepEqual([c.onNode, c.live], [false, null]);
    assert.equal(NOT_ON_NODE, 'the node does not hold this output: it is spent, or the indexer is ahead');
    assert.equal(w.provider.scansOf(MAINNET.delegation.address), 1, 'the delegation of the row that the node holds is read, and the delegation E of the other row is not');
  });
  test('the node says what the output holds: the AP3X of the node decide, and not those that Koios lists', async () => {
    const real = out(live(), 3_000_000n);
    const node = [real, ...delegated()];
    const w = ledgerWorld(node, { rows: [koiosRow(real, { value: '9000000' }), ...delegated().map((u) => koiosRow(u))] });
    const [r] = (await readVaults(w.env, { delegation: D }, CAPTURE_MS)).items;
    assert.equal(r.output.utxo.assets.lovelace, 3_000_000n);
    assert.equal(r.live!.canPay, false, 'with the 9 AP3X that Koios lists it could pay: with the 3 that the node holds it cannot');
    const honest = (await readVaults(ledgerWorld([out(live(), 9_000_000n), ...delegated()]).env, { delegation: D }, CAPTURE_MS)).items[0];
    assert.equal(honest.live!.canPay, true);
  });
  test('a read by output reference makes no confirmation request: the node was read for that output, once', async () => {
    const real = out(live(), 9_000_000n);
    const w = ledgerWorld([real, ...delegated()]);
    const asked = watch(w);
    const page = await readVaults(w.env, { vaultRef: refOf(real) }, CAPTURE_MS);
    assert.deepEqual(asked, [[refOf(real)]]);
    assert.deepEqual([page.items[0].onNode, page.byDelegator], [true, true]);
  });
  test('an empty page asks the node nothing', async () => {
    const w = ledgerWorld([]);
    const asked = watch(w);
    assert.equal((await readVaults(w.env, { ownerKeyHash: owner.hash }, CAPTURE_MS)).total, 0);
    const some = ledgerWorld([out(live()), ...delegated()]);
    const askedSome = watch(some);
    assert.equal((await readVaults(some.env, { delegation: D }, CAPTURE_MS, { offset: 5 })).items.length, 0);
    assert.deepEqual([asked, askedSome], [[], []]);
  });
  test('a node that fails ends the call: a page that cannot be confirmed is not shown as if it were', async () => {
    const w = ledgerWorld([out(live()), ...delegated()]);
    w.provider.getUtxosByOutRef = async () => { throw new Error('the node is down'); };
    await assert.rejects(() => readVaults(w.env, { delegation: D }, CAPTURE_MS), /the node is down/);
  });
});

// ─── The read of the delegations only sets the order ─────────────────────────────────────────────────────────────────────────

describe('readVaults: the read of the delegations only sets the order, and the funded vault comes first', () => {
  const owner: Delegator = { type: 'PrincipalKey', hash: testKey(50).keyHash, organisation: null };
  const D = 'd1'.repeat(32);
  const live = (over: Partial<Live> = {}): Live => ({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2, ...over });
  const out = (datum: VaultDatum, lovelace = 5_000_000n): UTxO => vaultUtxo(datum, lovelace);
  const delegated = (): UTxO[] => [delegationUtxo(D, delegation({ delegator: owner })), recordUtxo(delegation().delegate, liveRecord({}, [testKey(31).publicKey]))];
  const rowsOf = (utxos: UTxO[]) => utxos.map((u) => koiosRow(u));
  /** `count` rows that Koios lists at the delegation credential, each with a token of the delegation policy. */
  const delegationRows = (count: number) => {
    const template = koiosRow(delegationUtxo('aa'.repeat(32), delegation()));
    return Array.from({ length: count }, (_, i) => ({ ...template, tx_hash: (i + 1).toString(16).padStart(8, '0').repeat(8), asset_list: [{ policy_id: MAINNET.delegation.hash, asset_name: (i + 1).toString(16).padStart(64, '0'), quantity: '1' }] }));
  };
  const asksAt = (w: LedgerWorld, credential: string): number => callsTo(w.koios, 'credential_utxos').filter((c) => c.body !== null && Array.isArray(c.body._payment_credentials) && c.body._payment_credentials[0] === credential).length;

  test('the outputs that can pay come first, the one with the most AP3X first and equal amounts by reference; the other Live outputs and the Returned ones are by reference, whatever their AP3X', async () => {
    const small = out(live(), 5_000_000n);
    const big = out(live({ spent: 2n }), 9_000_000n);
    const mid = out(live({ spent: 3n }), 6_000_000n);
    const same = out(live({ spent: 4n }), 6_000_000n);
    const lowFirst = out(live({ delegation: 'e1'.repeat(32) }), 1_000_000n);
    const highAfter = out(live({ delegation: 'e2'.repeat(32) }), 20_000_000n);
    const returnedLow = out({ type: 'Returned', owner }, 1_100_000n);
    const returnedHigh = out({ type: 'Returned', owner }, 30_000_000n);
    const all = [returnedHigh, small, highAfter, same, big, returnedLow, lowFirst, mid];
    const expected = [big, mid, same, small, lowFirst, highAfter, returnedLow, returnedHigh];
    const page = await readVaults(ledgerWorld([...all, ...delegated()]).env, { ownerKeyHash: owner.hash }, CAPTURE_MS, { limit: 50 });
    assert.deepEqual(refsOf(page), expected.map(refOf));
    assert.equal(page.byDelegator, true);
    const byDelegation = await readVaults(ledgerWorld([small, big, mid, same, ...delegated()]).env, { delegation: D }, CAPTURE_MS);
    assert.deepEqual(refsOf(byDelegation), [big, mid, same, small].map(refOf));
  });
  test('5,000 or more delegations do not end the call: the order is by output reference only, Live before Returned, the page says so, and each row says whether its owner is the delegator', async () => {
    const small = out(live(), 5_000_000n);
    const big = out(live({ spent: 2n }), 9_000_000n);
    const returned = out({ type: 'Returned', owner }, 8_000_000n);
    const node = [small, big, returned, ...delegated()];
    const many = ledgerWorld(node, { rows: [...rowsOf(node), ...delegationRows(4_999)] });
    const page = await readVaults(many.env, { ownerKeyHash: owner.hash }, CAPTURE_MS);
    assert.equal(page.byDelegator, false);
    assert.deepEqual(refsOf(page), [small, big, returned].map(refOf), 'by reference: not by AP3X');
    assert.deepEqual(page.items.slice(0, 2).map((r) => [r.live!.ownerIsDelegator, r.live!.canPay]), [[true, true], [true, true]]);
    const some = ledgerWorld(node, { rows: [...rowsOf(node), ...delegationRows(4_998)] });
    const ordered = await readVaults(some.env, { ownerKeyHash: owner.hash }, CAPTURE_MS);
    assert.equal(ordered.byDelegator, true, 'the twin: 4,999 delegations are read for the order');
    assert.deepEqual(refsOf(ordered), [big, small, returned].map(refOf));
  });
  test('only too many delegations are tolerated: any other failure of that read ends the call', async () => {
    const w = ledgerWorld([out(live()), ...delegated()]);
    const failing = (async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { _payment_credentials?: string[] } : {};
      return body._payment_credentials?.[0] === MAINNET.delegation.hash ? new Response('{}', { status: 503 }) : w.env.fetchImpl(url, init);
    }) as typeof fetch;
    await assert.rejects(() => readVaults({ ...w.env, fetchImpl: failing }, { ownerKeyHash: owner.hash }, CAPTURE_MS), /Koios credential_utxos answered 503/);
  });
  test('a delegation that cannot be read does not end a read by delegation: the page says that the order is by reference, and each output reports the error', async () => {
    const noDatum = delegationUtxo(D, delegation({ delegator: owner }), { datum: null });
    const page = await readVaults(ledgerWorld([out(live()), out(live({ spent: 2n })), noDatum]).env, { delegation: D }, CAPTURE_MS);
    assert.equal(page.byDelegator, false);
    assert.ok(page.items.every((r) => /has no inline datum/.test(r.live!.error ?? '')));
    const fine = await readVaults(ledgerWorld([out(live()), ...delegated()]).env, { delegation: D }, CAPTURE_MS);
    assert.equal(fine.byDelegator, true);
    const missing = await readVaults(ledgerWorld([out(live())]).env, { delegation: D }, CAPTURE_MS);
    assert.equal(missing.byDelegator, true, 'a delegation that does not exist was read: no owner is its delegator');
  });
  test('the delegations are not read for the order when no output is Live, and not when no output names the delegation', async () => {
    const returned = [out({ type: 'Returned', owner }, 1_100_000n), out({ type: 'Returned', owner }, 1_200_000n)];
    const w = ledgerWorld(returned);
    assert.equal((await readVaults(w.env, { ownerKeyHash: owner.hash }, CAPTURE_MS)).total, 2);
    assert.deepEqual([asksAt(w, MAINNET.delegation.hash), asksAt(w, MAINNET.vault.hash)], [0, 1], 'only the vault credential was asked');
    const none = ledgerWorld(delegated());
    assert.equal((await readVaults(none.env, { delegation: D }, CAPTURE_MS)).total, 0);
    assert.equal(none.provider.scansOf(MAINNET.delegation.address), 0, 'the delegation was not read');
    const withLive = ledgerWorld([out(live()), ...delegated()]);
    await readVaults(withLive.env, { ownerKeyHash: owner.hash }, CAPTURE_MS);
    assert.equal(asksAt(withLive, MAINNET.delegation.hash), 1, 'the twin: a Live output makes the read');
  });
});

// ─── The exact filter and what the Live output says about its delegation ───────────────────────────────────────────────────────

describe('readVaults: the exact filter and what the Live output says about its delegation', () => {
  const OWNER_KEY = testKey(50);
  const owner: Delegator = { type: 'PrincipalKey', hash: OWNER_KEY.keyHash, organisation: null };
  const D = 'd1'.repeat(32);
  const live = (over: Partial<Live> = {}): Live => ({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2, ...over });
  const delegationOf = (over = {}): UTxO => delegationUtxo(D, delegation({ delegator: owner, ...over }));
  const out = (datum: VaultDatum, lovelace = 5_000_000n): UTxO => vaultUtxo(datum, lovelace);
  const ownerRefs = async (utxos: UTxO[], koios: KoiosOptions = {}) => refsOf(await readVaults(ledgerWorld(utxos, koios).env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS));

  test('an owner key hash inside another field of a datum is not the owner: Koios matches the bytes, the decoded owner decides', async () => {
    const mine = out(live());
    const returned = out({ type: 'Returned', owner });
    // The key hash is the first 28 bytes of a delegation identifier and of an agent identifier, and the whole of an organisation.
    const inId = out(live({ delegation: `${OWNER_KEY.keyHash}${'ee'.repeat(4)}`, owner: { type: 'PrincipalKey', hash: 'ab'.repeat(28), organisation: null } }));
    const agent = out(live({ owner: { type: 'Agent', id: `${OWNER_KEY.keyHash}${'ee'.repeat(4)}` } }));
    const organisation = out({ type: 'Returned', owner: { type: 'PrincipalKey', hash: 'cd'.repeat(28), organisation: OWNER_KEY.keyHash } });
    const otherOwner = out({ type: 'Returned', owner: { type: 'PrincipalKey', hash: 'ef'.repeat(28), organisation: null } });
    const all = [mine, returned, inId, agent, organisation, otherOwner];
    const w = ledgerWorld(all);
    const asked = await readVaults(w.env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS);
    assert.deepEqual(refsOf(asked).sort(), [mine, returned].map(refOf).sort());
    assert.ok(callsTo(w.koios, 'credential_utxos').length > 0);
    assert.deepEqual(await ownerRefs([inId, agent, otherOwner]), [], 'with only the decoys nothing is the owner\'s');
  });
  test('a delegation inside another field of a datum is not the delegation: a Live output counts only when it names it', async () => {
    const named = out(live());
    const inOrganisation = out(live({ delegation: 'ab'.repeat(32), owner: { type: 'PrincipalKey', hash: 'cd'.repeat(28), organisation: D } }));
    const returned = out({ type: 'Returned', owner });
    const w = ledgerWorld([named, inOrganisation, returned, delegationOf()]);
    const page = await readVaults(w.env, { delegation: D }, CAPTURE_MS);
    assert.deepEqual(refsOf(page), [refOf(named)]);
    const noFilter = ledgerWorld([named, inOrganisation, returned], { ignoreDatumFilter: true });
    assert.equal((await readVaults(noFilter.env, { delegation: D }, CAPTURE_MS)).total, 1, 'a Koios that ignores the filter changes nothing');
  });
  test('an agent that owns a vault names it by delegation, not by an owner key hash', async () => {
    const AGENT: Delegator = { type: 'Agent', id: 'a7'.repeat(32) };
    const byAgent = out(live({ owner: AGENT }));
    const w = ledgerWorld([byAgent, delegationUtxo(D, delegation({ delegator: AGENT }))]);
    const [reading] = (await readVaults(w.env, { delegation: D }, CAPTURE_MS)).items;
    assert.equal(reading.live!.ownerIsDelegator, true);
    assert.deepEqual((await readVaults(w.env, { ownerKeyHash: 'a7'.repeat(28) }, CAPTURE_MS)).items, []);
  });
  test('a Live output whose delegation was burned says so: no limit, no allowance, no owner check, and a problem that the owner can close it', async () => {
    const [r] = (await readVaults(ledgerWorld([out(live())]).env, { delegation: D }, CAPTURE_MS)).items;
    assert.deepEqual([r.live!.delegation!.chain.length, r.live!.limit, r.live!.ownerIsDelegator, r.live!.allowance, r.live!.canPay], [0, null, null, null, false]);
    assert.ok(r.live!.problems.some((p) => /does not exist: it was never made, or it was undelegated.*the owner can still close this output/.test(p)), r.live!.problems.join('; '));
  });
  test('an owner that is not the delegator of the delegation cannot be paid from: the read says it', async () => {
    const other: Delegator = { type: 'PrincipalKey', hash: 'ab'.repeat(28), organisation: null };
    const [r] = (await readVaults(ledgerWorld([out(live()), delegationOf({ delegator: other })]).env, { delegation: D }, CAPTURE_MS)).items;
    assert.equal(r.live!.ownerIsDelegator, false);
    const [same] = (await readVaults(ledgerWorld([out(live()), delegationOf()]).env, { delegation: D }, CAPTURE_MS)).items;
    assert.equal(same.live!.ownerIsDelegator, true);
    const withOrg: Delegator = { ...owner, organisation: '6f7267' };
    const [diffOrg] = (await readVaults(ledgerWorld([out(live()), delegationOf({ delegator: withOrg })]).env, { delegation: D }, CAPTURE_MS)).items;
    assert.equal(diffOrg.live!.ownerIsDelegator, false, 'the organisation is part of the owner');
  });
  test('a delegation without a value limit gives no limit and no allowance', async () => {
    const [r] = (await readVaults(ledgerWorld([out(live()), delegationOf({ value: null })]).env, { delegation: D }, CAPTURE_MS)).items;
    assert.deepEqual([r.live!.delegation!.chain.length, r.live!.limit, r.live!.allowance], [1, null, null]);
  });
  test('the limit and the allowance come from the leaf of a chain, the delegation that the vault names', async () => {
    const P = 'd2'.repeat(32);
    const AGENT = 'c3'.repeat(32);
    const parent = delegationUtxo(P, delegation({ delegate: AGENT, remaining: 1, value: { perTx: 90_000_000n, total: 900_000_000n, periodMs: DAY } }));
    const leaf = delegationUtxo(D, delegation({ parent: P, depth: 2, remaining: 0, delegator: { type: 'Agent', id: AGENT }, value: { perTx: 2_000_000n, total: 8_000_000n, periodMs: 3_600_000 } }));
    const [r] = (await readVaults(ledgerWorld([out(live({ owner: { type: 'Agent', id: AGENT } }), 5_000_000n), parent, leaf]).env, { delegation: D }, CAPTURE_MS)).items;
    assert.deepEqual(r.live!.limit, { perTx: 2_000_000n, total: 8_000_000n, periodMs: 3_600_000 });
    assert.deepEqual(r.live!.delegation!.chain.map((l) => l.id), [D, P]);
  });
  test('Live outputs come before Returned outputs, each group by reference, whatever order Koios lists them in', async () => {
    const a = out({ type: 'Returned', owner }, 1_000_001n);
    const b = out(live(), 2_000_000n);
    const c = out({ type: 'Returned', owner }, 1_000_002n);
    const d = out(live({ spent: 2_000_000n }), 3_000_000n);
    const expected = [b, d].map(refOf).sort().concat([a, c].map(refOf).sort());
    for (const order of [[a, b, c, d], [d, c, b, a], [c, a, d, b]]) assert.deepEqual(await ownerRefs(order, { ignoreOrder: true }), expected);
  });
  test('a datum that does not decode, and an output at the vault credential with no datum, are left out', async () => {
    const junk = vaultUtxo(live(), 5_000_000n, { datum: `d8799f581c${OWNER_KEY.keyHash}ff` });
    const none = vaultUtxo(live(), 5_000_000n, { datum: null });
    assert.deepEqual(await ownerRefs([junk, none]), []);
    const good = out(live());
    assert.deepEqual(await ownerRefs([junk, none, good]), [refOf(good)]);
  });
  test('an output at another address with the vault credential is a vault output too, as the node reads it: the vault script runs on it', async () => {
    const staked = credentialToAddress('Mainnet', { type: 'Script', hash: MAINNET.vault.hash }, { type: 'Key', hash: 'ee'.repeat(28) });
    const atStaked = vaultUtxo(live(), 5_000_000n, { address: staked });
    const [reading] = (await readVaults(ledgerWorld([atStaked]).env, { ownerKeyHash: OWNER_KEY.keyHash }, CAPTURE_MS)).items;
    assert.equal(reading.output.utxo.address, staked);
  });
});

// ─── escrowPaidFromVault ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('escrowPaidFromVault', () => {
  const PAY = CAPTURE.payment;
  const PLAIN = CAPTURE.plain_escrow;
  const PAY_TX = PAY.escrow_ref.split('#')[0];
  const VAULT_INPUT = PAY.tx.inputs.find((i) => i.payment_addr?.cred === MAINNET.vault.hash)!;
  const VAULT_REF = `${VAULT_INPUT.tx_hash}#${VAULT_INPUT.tx_index}`;
  const koios = (...txs: TxRow[]) => ledgerKoios({ txs });
  const env = (k: LedgerKoios) => ({ deployment: MAINNET, koiosUrl: 'https://koios.example', fetchImpl: k.f });
  const ask = (tx: TxRow, escrowRef = PAY.escrow_ref, delegationId = PAY.delegation) => escrowPaidFromVault(env(koios(tx)), escrowRef, delegationId);
  const txOf = (tx: TxRow, over: Partial<TxRow>): TxRow => ({ ...structuredClone(tx), ...over });
  /** `run` with `valid_contract` set to `flag`, or without the key when `flag` is undefined. */
  const flagged = (run: Contract, flag: unknown): Contract => { const next: Contract = { ...run, valid_contract: flag }; if (flag === undefined) delete next.valid_contract; return next; };
  /** `tx` with each of its script runs changed by `change`. */
  const mapRuns = (tx: TxRow, change: (run: Contract) => Contract): TxRow => ({ ...structuredClone(tx), plutus_contracts: tx.plutus_contracts.map(change) });
  /** `tx` with `valid_contract` of each of its script runs set to `flag` (removed when `flag` is undefined). */
  const withRunFlag = (tx: TxRow, flag: unknown): TxRow => mapRuns(tx, (run) => flagged(run, flag));

  test('the payment of mainnet: its escrow was paid from the Live vault output of the delegation, and the answer names the output that paid', async () => {
    const k = koios(PAY.tx);
    assert.deepEqual(await escrowPaidFromVault(env(k), PAY.escrow_ref, PAY.delegation), {
      paid: true, vaultRef: VAULT_REF, escrowRef: PAY.escrow_ref, delegation: PAY.delegation, payTx: PAY_TX,
    });
    assert.equal(VAULT_REF, '0502227640c98354ee991594eee6c4157b19711203e0d0ca4bde687de33032ee#0');
    assert.deepEqual(callsTo(k, 'tx_info').map((c) => c.body), [{ _tx_hashes: [PAY_TX], _inputs: true, _scripts: true, _assets: false, _metadata: false, _certs: false, _withdrawals: false, _bytecode: false }]);
    assert.equal(k.calls.length, 1, 'one request to Koios');
  });
  test('capitals in the reference and in the delegation do not matter', async () => {
    const r = await ask(PAY.tx, PAY.escrow_ref.toUpperCase(), PAY.delegation.toUpperCase());
    assert.equal(r.paid, true);
  });
  test('its twin, an escrow that a wallet posted with no vault: no vault input', async () => {
    const r = await escrowPaidFromVault(env(koios(PLAIN.tx)), PLAIN.escrow_ref, PAY.delegation);
    assert.equal(r.paid, false);
    if (!r.paid) { assert.equal(r.reason, 'no_vault_input'); assert.match(r.detail, new RegExp(`no input of the transaction ${PLAIN.escrow_ref.split('#')[0]} is at the vault script ${MAINNET.vault.hash}`)); }
  });
  test('another delegation did not pay it: the vault output that paid names the delegation that it does', async () => {
    const r = await ask(PAY.tx, PAY.escrow_ref, 'ee'.repeat(32));
    assert.equal(r.paid, false);
    if (!r.paid) { assert.equal(r.reason, 'other_delegation'); assert.match(r.detail, new RegExp(`${VAULT_REF} that paid names the delegation ${PAY.delegation}, not the delegation ${'ee'.repeat(32)}`)); }
  });
  test('a Close of the vault output in the same transaction is not a payment: the redeemer decides, and the Pay redeemer is the twin', async () => {
    const close = await ask(withVaultRedeemer(PAY.tx, 1));
    assert.equal(close.paid, false);
    if (!close.paid) { assert.equal(close.reason, 'not_a_payment'); assert.match(close.detail, new RegExp(VAULT_REF)); }
    assert.equal((await ask(withVaultRedeemer(PAY.tx, 0))).paid, true);
  });
  test('a run of the vault script that is not a spend, or of another script, is not a payment', async () => {
    const asMint = txOf(PAY.tx, { plutus_contracts: PAY.tx.plutus_contracts.map((c) => ({ ...c, input: { redeemer: { ...c.input.redeemer, purpose: 'mint' } } })) });
    const other = txOf(PAY.tx, { plutus_contracts: PAY.tx.plutus_contracts.map((c) => ({ ...c, script_hash: 'ab'.repeat(28) })) });
    for (const tx of [asMint, other]) { const r = await ask(tx); assert.deepEqual([r.paid, r.paid ? null : r.reason], [false, 'not_a_payment']); }
    assert.equal((await ask(PAY.tx)).paid, true);
  });
  test('a redeemer with fields, or an index above 1, is not Pay', async () => {
    const field = (c: Contract): Contract => ({ ...c, input: { redeemer: { ...c.input.redeemer, datum: { ...c.input.redeemer.datum, value: { constructor: 0, fields: [{ int: 1 }] } } } } });
    const r = await ask(txOf(PAY.tx, { plutus_contracts: PAY.tx.plutus_contracts.map(field) }));
    assert.deepEqual([r.paid, r.paid ? null : r.reason], [false, 'not_a_payment']);
    const noOwnConstructor = (c: Contract): Contract => ({ ...c, input: { redeemer: { ...c.input.redeemer, datum: { ...c.input.redeemer.datum, value: { fields: [] } as unknown as Contract['input']['redeemer']['datum']['value'] } } } });
    const s = await ask(txOf(PAY.tx, { plutus_contracts: PAY.tx.plutus_contracts.map(noOwnConstructor) }));
    assert.deepEqual([s.paid, s.paid ? null : s.reason], [false, 'not_a_payment'], 'the constructor of every object is not the constructor of a redeemer');
  });
  test('a later output of an escrow (a claim, a submit or an accept) is not the escrow that was paid: the answer says to give the first output', async () => {
    const continuation = txOf(PLAIN.tx, { inputs: [...PLAIN.tx.inputs, { ...PLAIN.tx.inputs[0], tx_hash: 'cc'.repeat(32), tx_index: 0, payment_addr: { cred: MAINNET.escrow.hash, bech32: MAINNET.escrow.address } }] });
    const r = await escrowPaidFromVault(env(koios(continuation)), PLAIN.escrow_ref, PAY.delegation);
    assert.equal(r.paid, false);
    if (!r.paid) { assert.equal(r.reason, 'continuation'); assert.match(r.detail, new RegExp(`escrow output ${'cc'.repeat(32)}#0.*give the first output of the escrow`)); }
    const claim = txOf(PAY.tx, { inputs: [...PAY.tx.inputs, { ...PLAIN.tx.inputs[0], tx_hash: 'cc'.repeat(32), tx_index: 0, payment_addr: { cred: MAINNET.escrow.hash, bech32: MAINNET.escrow.address } }] });
    assert.equal((await ask(claim)).paid, false, 'even with a vault input paid in the same transaction');
  });
  test('an output that is not at the escrow script is not an escrow: the continuing vault output, a wallet output, and an index past the outputs', async () => {
    for (const index of [1, 2, 9]) {
      const r = await ask(PAY.tx, `${PAY_TX}#${index}`);
      assert.equal(r.paid, false, String(index));
      if (!r.paid) { assert.equal(r.reason, 'not_an_escrow_output'); assert.match(r.detail, new RegExp(`output ${PAY_TX}#${index} is not an output at the escrow script ${MAINNET.escrow.hash}`)); }
    }
    assert.equal((await ask(PAY.tx, `${PAY_TX}#0`)).paid, true);
  });
  test('a transaction that Koios does not know is not found', async () => {
    const r = await escrowPaidFromVault(env(koios()), PAY.escrow_ref, PAY.delegation);
    assert.equal(r.paid, false);
    if (!r.paid) { assert.equal(r.reason, 'transaction_not_found'); assert.match(r.detail, new RegExp(PAY_TX)); }
    const other = await escrowPaidFromVault(env(koios(PLAIN.tx)), PAY.escrow_ref, PAY.delegation);
    assert.equal(other.paid, false, 'Koios knows another transaction only');
  });
  test('a vault datum that cannot be read is said so', async () => {
    const broken = (i: TxIo): TxIo => (i.payment_addr?.cred === MAINNET.vault.hash ? { ...i, inline_datum: { bytes: null, value: { bytes: 'zz' } } } : i);
    const r = await ask(txOf(PAY.tx, { inputs: PAY.tx.inputs.map(broken) }));
    assert.equal(r.paid, false);
    if (!r.paid) { assert.equal(r.reason, 'unreadable_vault_datum'); assert.match(r.detail, new RegExp(VAULT_REF)); }
    const none = await ask(txOf(PAY.tx, { inputs: PAY.tx.inputs.map((i) => (i.payment_addr?.cred === MAINNET.vault.hash ? { ...i, inline_datum: null } : i)) }));
    assert.deepEqual([none.paid, none.paid ? null : none.reason], [false, 'unreadable_vault_datum']);
  });
  test('a Returned datum on the input that the Pay redeemer spends is no delegation', async () => {
    const returned = (i: TxIo): TxIo => (i.payment_addr?.cred === MAINNET.vault.hash
      ? { ...i, inline_datum: { bytes: null, value: { constructor: 1, fields: [{ constructor: 0, fields: [{ bytes: '38'.repeat(28) }, { constructor: 1, fields: [] }] }] } } } : i);
    const r = await ask(txOf(PAY.tx, { inputs: PAY.tx.inputs.map(returned) }));
    assert.equal(r.paid, false);
    if (!r.paid) { assert.equal(r.reason, 'other_delegation'); assert.match(r.detail, /no delegation \(Returned\)/); }
  });
  test('two vault inputs: the Pay redeemer is tied to the input it spends, so the delegation of the Closed one did not pay', async () => {
    const D_OTHER = 'e2'.repeat(32);
    const closedInput: TxIo = {
      ...VAULT_INPUT, tx_hash: 'ab'.repeat(32), tx_index: 3,
      inline_datum: { bytes: null, value: { constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: OWNER }, { constructor: 1, fields: [] }] }, { bytes: D_OTHER }, { int: 0 }, { int: 0 }] } },
    };
    const closeRun: Contract = { ...PAY.tx.plutus_contracts[0], spends_input: { tx_hash: closedInput.tx_hash, tx_index: 3 } };
    closeRun.input = { redeemer: { ...closeRun.input.redeemer, datum: { ...closeRun.input.redeemer.datum, value: { constructor: 1, fields: [] } } } };
    const two = txOf(PAY.tx, { inputs: [...PAY.tx.inputs, closedInput], plutus_contracts: [...PAY.tx.plutus_contracts, closeRun] });
    assert.equal((await ask(two, PAY.escrow_ref, PAY.delegation)).paid, true, 'the delegation of the input that Pay spent');
    const other = await ask(two, PAY.escrow_ref, D_OTHER);
    assert.equal(other.paid, false, 'the delegation of the input that Close spent');
    if (!other.paid) assert.equal(other.reason, 'other_delegation');
  });
  test('without spends_input a single vault input is the one that Pay spent', async () => {
    const without = txOf(PAY.tx, { plutus_contracts: PAY.tx.plutus_contracts.map((c) => ({ ...c, spends_input: null })) });
    assert.equal((await ask(without)).paid, true);
  });
  test('an answer that cannot decide is an error: no inputs, or no list of scripts', async () => {
    await assert.rejects(() => ask(txOf(PAY.tx, { inputs: [] })), /response has no inputs/);
    await assert.rejects(() => ask(txOf(PAY.tx, { inputs: undefined as unknown as TxIo[] })), /response has no inputs/);
    await assert.rejects(() => ask(txOf(PAY.tx, { plutus_contracts: null as unknown as Contract[] })), /response has no script list/);
    const plain = txOf(PLAIN.tx, { plutus_contracts: null as unknown as Contract[] });
    assert.equal((await escrowPaidFromVault(env(koios(plain)), PLAIN.escrow_ref, PAY.delegation)).paid, false, 'with no vault input the scripts are not needed');
  });
  test('an empty list of scripts for a transaction with a vault input is an incomplete answer, and not "not a payment"', async () => {
    await assert.rejects(() => ask(txOf(PAY.tx, { plutus_contracts: [] })), /Koios tx_info: response has no script list/);
    const plain = txOf(PLAIN.tx, { plutus_contracts: [] });
    const r = await escrowPaidFromVault(env(koios(plain)), PLAIN.escrow_ref, PAY.delegation);
    assert.deepEqual([r.paid, r.paid ? null : r.reason], [false, 'no_vault_input'], 'with no vault input an empty list is what a transaction without scripts has');
    assert.equal((await ask(PAY.tx)).paid, true, 'the twin: the list of the capture');
  });
  test('a transaction that failed script validation (valid_contract false) made no output: it is not a payment, whatever its inputs say', async () => {
    const failed = await ask(txOf(PAY.tx, { valid_contract: false }));
    assert.equal(failed.paid, false);
    if (!failed.paid) { assert.equal(failed.reason, 'contract_failed'); assert.match(failed.detail, new RegExp(`the transaction ${PAY_TX} failed script validation`)); }
    assert.equal((await ask(txOf(PAY.tx, { valid_contract: true }))).paid, true, 'the twin: its scripts passed');
    assert.equal((await ask(PAY.tx)).paid, true, 'the top level of a row of the Vector Koios has no valid_contract: the flag of the run decides');
    const noOutputs = await ask(txOf(PAY.tx, { outputs: [] }));
    assert.deepEqual([noOutputs.paid, noOutputs.paid ? null : noOutputs.reason], [false, 'not_an_escrow_output'], 'a failed transaction that lists no output');
  });
  test('the Pay run of the real payment says that its scripts passed: its own valid_contract is true, and the top level of the row has none', async () => {
    assert.equal(PAY.tx.plutus_contracts[0].valid_contract, true, 'the capture holds the flag of the run');
    assert.equal('valid_contract' in PAY.tx, false, 'the capture holds no flag at the top level, as the Vector Koios gives none');
    const r = await ask(PAY.tx);
    assert.deepEqual([r.paid, r.paid ? r.vaultRef : null], [true, VAULT_REF]);
  });
  test('a Pay run with valid_contract false is contract_failed, and its twin with true is paid', async () => {
    const failed = await ask(withRunFlag(PAY.tx, false));
    assert.equal(failed.paid, false);
    if (!failed.paid) {
      assert.equal(failed.reason, 'contract_failed');
      assert.match(failed.detail, new RegExp(`the transaction ${PAY_TX} failed script validation \\(its Pay run of the vault script has valid_contract false\\)`));
    }
    assert.equal((await ask(withRunFlag(PAY.tx, true))).paid, true);
  });
  test('a Pay run with no valid_contract is an incomplete answer: an error, and neither paid nor not a payment; its twin with true is paid', async () => {
    await assert.rejects(() => ask(withRunFlag(PAY.tx, undefined)), /Koios tx_info: a Pay run of the vault script has no valid_contract that is true or false: the answer is incomplete/);
    assert.equal((await ask(withRunFlag(PAY.tx, true))).paid, true);
  });
  test('a Pay run with a valid_contract that is not true or false is an incomplete answer too, whatever the value; its twin with true is paid', async () => {
    for (const flag of ['true', 'false', 'TRUE', 1, 0, null, {}, [], [true], '']) {
      await assert.rejects(() => ask(withRunFlag(PAY.tx, flag)), /a Pay run of the vault script has no valid_contract that is true or false/, JSON.stringify(flag));
    }
    assert.equal((await ask(withRunFlag(PAY.tx, true))).paid, true);
  });
  test('only a Pay run of the vault script needs the flag: a Close, a run that is not a spend and a run of another script are not the Pay of the vault', async () => {
    const asClose = (flag: unknown) => withRunFlag(withVaultRedeemer(PAY.tx, 1), flag);
    const asMint = (flag: unknown) => mapRuns(PAY.tx, (run) => flagged({ ...run, input: { redeemer: { ...run.input.redeemer, purpose: 'mint' } } }, flag));
    const ofOther = (flag: unknown) => mapRuns(PAY.tx, (run) => flagged({ ...run, script_hash: 'ab'.repeat(28) }, flag));
    for (const flag of [undefined, false, 'x', null]) {
      for (const [what, tx] of [['a Close', asClose(flag)], ['a mint', asMint(flag)], ['another script', ofOther(flag)]] as const) {
        const r = await ask(tx);
        assert.deepEqual([r.paid, r.paid ? null : r.reason], [false, 'not_a_payment'], `${what} with the flag ${String(flag)}`);
      }
    }
    await assert.rejects(() => ask(withRunFlag(PAY.tx, undefined)), /no valid_contract/, 'the twin: a Pay run with the same flag');
  });
  test('every Pay run of the vault script must have passed: with true and false it is contract_failed, with true and no flag an error, with true and true paid', async () => {
    const D_OTHER = 'e2'.repeat(32);
    const secondInput: TxIo = {
      ...VAULT_INPUT, tx_hash: 'ab'.repeat(32), tx_index: 3,
      inline_datum: { bytes: null, value: { constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: OWNER }, { constructor: 1, fields: [] }] }, { bytes: D_OTHER }, { int: 0 }, { int: 0 }] } },
    };
    const second = (flag: unknown): Contract => flagged({ ...PAY.tx.plutus_contracts[0], spends_input: { tx_hash: secondInput.tx_hash, tx_index: 3 } }, flag);
    const two = (first: unknown, next: unknown): TxRow => txOf(PAY.tx, { inputs: [...PAY.tx.inputs, secondInput], plutus_contracts: [flagged(PAY.tx.plutus_contracts[0], first), second(next)] });
    assert.equal((await ask(two(true, true))).paid, true, 'both passed');
    for (const [first, next] of [[true, false], [false, true]] as const) {
      const r = await ask(two(first, next));
      assert.deepEqual([r.paid, r.paid ? null : r.reason], [false, 'contract_failed'], `${first} and ${next}`);
    }
    for (const [first, next] of [[true, undefined], [undefined, true]] as const) {
      await assert.rejects(() => ask(two(first, next)), /no valid_contract/, `${first} and ${next}`);
    }
  });
  test('the flag of the run decides when the top level has one too: a run with no flag is not made believable by a top level true, and a run false is a failure', async () => {
    await assert.rejects(() => ask(txOf(withRunFlag(PAY.tx, undefined), { valid_contract: true })), /no valid_contract/);
    const failed = await ask(txOf(withRunFlag(PAY.tx, false), { valid_contract: true }));
    assert.deepEqual([failed.paid, failed.paid ? null : failed.reason], [false, 'contract_failed']);
    assert.equal((await ask(txOf(PAY.tx, { valid_contract: true }))).paid, true, 'the twin: both say true');
  });
  test('a failed transaction as Koios lists it, with its runs false and no output, is contract_failed and not "not an escrow output"', async () => {
    const failed = await ask(txOf(withRunFlag(PAY.tx, false), { outputs: [] }));
    assert.deepEqual([failed.paid, failed.paid ? null : failed.reason], [false, 'contract_failed']);
    const gone = await ask(txOf(PAY.tx, { outputs: [] }));
    assert.deepEqual([gone.paid, gone.paid ? null : gone.reason], [false, 'not_an_escrow_output'], 'the twin: the scripts passed and the output is not there');
  });
  test('a Koios that fails is an error that names the operation and the status only', async () => {
    const k = ledgerKoios({ txs: [PAY.tx], status: { tx_info: 502 } });
    await assert.rejects(() => escrowPaidFromVault(env(k), PAY.escrow_ref, PAY.delegation), (err: Error) => err.message === 'Koios tx_info answered 502');
  });
  test('an answer over the size cap is refused', async () => {
    const k = ledgerKoios({ txs: [PAY.tx], announce: { tx_info: KOIOS_ANSWER_BYTES + 1 } });
    await assert.rejects(() => escrowPaidFromVault(env(k), PAY.escrow_ref, PAY.delegation), /Koios tx_info: the answer is over the 16777216 byte limit/);
  });
  test('an escrow reference or a delegation that is not well formed is refused before Koios is asked', async () => {
    const k = koios(PAY.tx);
    await assert.rejects(() => escrowPaidFromVault(env(k), 'abc', PAY.delegation), /Invalid out ref/);
    await assert.rejects(() => escrowPaidFromVault(env(k), PAY.escrow_ref, 'abc'), /delegation must be 64 hex/);
    assert.equal(k.calls.length, 0);
  });
});
