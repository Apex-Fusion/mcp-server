// packages/builder/test/delegation-read.test.ts
// The reads of delegations (delegation-read.ts) on the two delegations that mainnet holds or held (one burned, one live at the capture)
// and on synthetic ones (a chain, an ended parent, a delegate that is not Active). The node is an offline world and Koios is a fake:
// no network. Each problem of the use check has its twin that is usable.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Credential, UTxO } from '@lucid-evolution/lucid';
import { HIRE_ACTION, delegationUseProblems, escrowResource } from '../src/vector/delegation-build.ts';
import { checkDelegationUse, isAction, isResource, readChainRecords, readDelegation } from '../src/vector/delegation-read.ts';
import { chainRecords, recordsById } from '../src/vector/identity-chain.ts';
import { decodeDelegationDatum, utf8Hex } from '../src/vector/identity-codec.ts';
import { BudgetSpent, KOIOS_ANSWER_BYTES } from '../src/vector/ledger-read.ts';
import type { DelegationDatum, IdentityDatum } from '../src/vector/identity-codec.ts';
import { testKey } from './fixtures/identity-world.ts';
import { CAPTURE, CAPTURE_MS, DAY, MAINNET, callsTo, delegation, delegationUtxo, koiosRow, ledgerWorld, liveRecord, recordUtxo, utxoOf } from './fixtures/ledger-read-world.ts';
import type { LedgerWorld } from './fixtures/ledger-read-world.ts';

const ESCROW = escrowResource(MAINNET.escrow.hash);
const LIVE = CAPTURE.delegations.live;
const BURNED = CAPTURE.delegations.burned;
const LIVE_DATUM = decodeDelegationDatum(LIVE.mint_output.inline_datum!.bytes);
const BURNED_DATUM = decodeDelegationDatum(BURNED.mint_output.inline_datum!.bytes);

describe('the two delegations of mainnet', () => {
  test('the live one is the one the capture says: its terms, its output, and the burned one is spent', () => {
    assert.equal(LIVE.id, '5b48163362d540ae0cd630882634dd1afb07d274c64dabd8fe57596533b55a66');
    assert.equal(LIVE_DATUM.delegate, 'ea810b914490188b324af165d7a8ec78e103f8f0e214648622af3ba7868e1804');
    assert.equal(LIVE_DATUM.delegateKey, 'f20c2a03f53b35dcd35681a44b2d413757f2777344840bf557136599');
    assert.deepEqual(LIVE_DATUM.actions, [utf8Hex(HIRE_ACTION)]);
    assert.deepEqual(LIVE_DATUM.resources, [utf8Hex(ESCROW)]);
    assert.deepEqual(LIVE_DATUM.value, { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY });
    assert.deepEqual([LIVE_DATUM.notBefore, LIVE_DATUM.notAfter, LIVE_DATUM.depth, LIVE_DATUM.remaining], [1794845449000, 1795450308658, 1, 0]);
    assert.equal(LIVE_DATUM.parent, null);
    assert.equal(LIVE.mint_output.is_spent, false);
    assert.equal(BURNED.id, '57b5e39fbe5986f40c34c618ca3dd06d463186dfaf0b61e488c7305b53db271b');
    assert.equal(BURNED.mint_output.is_spent, true);
    assert.deepEqual(BURNED_DATUM.value, { perTx: 5_000_000n, total: 5_000_000n, periodMs: DAY });
  });
});

// ─── readDelegation ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('readDelegation', () => {
  const live = ledgerWorld([utxoOf(LIVE.mint_output)]);

  test('the live delegation of mainnet: one link, its datum and its output', async () => {
    const view = await readDelegation(live.env, LIVE.id);
    assert.equal(view.id, LIVE.id);
    assert.equal(view.missingParent, null);
    assert.equal(view.chain.length, 1);
    assert.equal(view.chain[0].id, LIVE.id);
    assert.deepEqual(view.chain[0].delegation, LIVE_DATUM);
    assert.equal(`${view.chain[0].utxo.txHash}#${view.chain[0].utxo.outputIndex}`, `${LIVE.mint_output.tx_hash}#${LIVE.mint_output.tx_index}`);
  });
  test('the burned delegation is not live: no link, and no parent is missing', async () => {
    const view = await readDelegation(live.env, BURNED.id);
    assert.deepEqual([view.chain.length, view.missingParent], [0, null]);
  });
  test('an identifier in capitals is the same delegation, and a malformed one is an error', async () => {
    assert.equal((await readDelegation(live.env, LIVE.id.toUpperCase())).chain.length, 1);
    await assert.rejects(() => readDelegation(live.env, 'abc'), /not an identifier/);
  });
  test('a chain: the delegation first, then its parent, up to the root', async () => {
    const P = 'a1'.repeat(32);
    const C = 'a2'.repeat(32);
    const w = ledgerWorld([delegationUtxo(P, delegation()), delegationUtxo(C, delegation({ parent: P, depth: 2, remaining: 0, delegator: { type: 'Agent', id: 'c3'.repeat(32) } }))]);
    const view = await readDelegation(w.env, C);
    assert.deepEqual(view.chain.map((l) => l.id), [C, P]);
    assert.equal(view.missingParent, null);
  });
  test('a parent that was undelegated is named; the links that exist are returned', async () => {
    const P = 'a1'.repeat(32);
    const C = 'a2'.repeat(32);
    const child = delegationUtxo(C, delegation({ parent: P, depth: 2, delegator: { type: 'Agent', id: 'c3'.repeat(32) } }));
    const orphan = await readDelegation(ledgerWorld([child]).env, C);
    assert.deepEqual([orphan.chain.map((l) => l.id), orphan.missingParent], [[C], P]);
    const whole = await readDelegation(ledgerWorld([child, delegationUtxo(P, delegation())]).env, C);
    assert.deepEqual([whole.chain.map((l) => l.id), whole.missingParent], [[C, P], null]);
  });
  test('a chain read stops between two links when its budget is spent, and reads both when it is not', async (t) => {
    const P = 'a1'.repeat(32);
    const C = 'a2'.repeat(32);
    const w = ledgerWorld([delegationUtxo(P, delegation()), delegationUtxo(C, delegation({ parent: P, depth: 2, remaining: 0, delegator: { type: 'Agent', id: 'c3'.repeat(32) } }))]);
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
    const scan = w.provider.getUtxos.bind(w.provider);
    // Each scan of an address costs 2 s of the clock of the call.
    w.provider.getUtxos = async (address: Address | Credential) => { const found = await scan(address); t.mock.timers.tick(2_000); return found; };
    await assert.rejects(() => readDelegation({ ...w.env, budgetMs: 1_000 }, C), BudgetSpent);
    assert.equal(w.provider.scansOf(MAINNET.delegation.address), 1, 'the parent was not read');
    const whole = await readDelegation({ ...w.env, budgetMs: 60_000 }, C);
    assert.deepEqual(whole.chain.map((l) => l.id), [C, P]);
  });
  test('a chain of more than 4 links is an error, and one of 4 is read', async () => {
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5'].map((b) => b.repeat(32));
    const links = ids.map((id, i) => delegationUtxo(id, delegation({ parent: i + 1 < ids.length ? ids[i + 1] : null, depth: ids.length - i })));
    await assert.rejects(() => readDelegation(ledgerWorld(links).env, ids[0]), /longer than 4 links/);
    assert.equal((await readDelegation(ledgerWorld(links.slice(1)).env, ids[1])).chain.length, 4);
  });
  test('an output at another address, or one with two delegation tokens, is no delegation', async () => {
    const id = 'a9'.repeat(32);
    const good = delegationUtxo(id, delegation());
    assert.equal((await readDelegation(ledgerWorld([{ ...good, address: MAINNET.vault.address }]).env, id)).chain.length, 0);
    const two = delegationUtxo(id, delegation());
    two.assets[`${MAINNET.delegation.hash}${'aa'.repeat(32)}`] = 1n;
    assert.equal((await readDelegation(ledgerWorld([two]).env, id)).chain.length, 0);
    assert.equal((await readDelegation(ledgerWorld([good]).env, id)).chain.length, 1);
  });
});

// ─── Actions and resources ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('isAction and isResource (Part 2 Section 5.1)', () => {
  test('an action is an internal name or an external; a pattern is not an action', () => {
    for (const ok of ['marketplace.hire.v1', 'a', 'a.b-c.d9', 'oauth:read', 'mcp:server/tool', 'https://example.org/x?y=*']) assert.equal(isAction(ok), true, ok);
    for (const bad of ['', '*', 'x.*', 'Marketplace.hire', 'a..b', '.a', 'a.', 'a b', 'script:' + 'ab'.repeat(28), 'oauth:', 'https://', 'mcp:a b', 'a_b']) assert.equal(isAction(bad), false, JSON.stringify(bad));
  });
  test('a resource is a script hash or an external; a pattern is not a resource', () => {
    for (const ok of [`script:${'ab'.repeat(28)}`, 'oauth:read', 'mcp:server', 'https://example.org/x']) assert.equal(isResource(ok), true, ok);
    for (const bad of ['', '*', 'script:abc', `script:${'AB'.repeat(28)}`, `script:${'ab'.repeat(29)}`, 'marketplace.hire.v1', 'oauth:', 'https://']) assert.equal(isResource(bad), false, JSON.stringify(bad));
  });
});

// ─── checkDelegationUse on the live delegation of mainnet ───────────────────────────────────────────────────────────────────────

describe('checkDelegationUse on the live delegation of mainnet', () => {
  /** The delegate of the live delegation as a record that is Active but lists no key of the real delegate: its key hash has no public key here. */
  const delegate = recordUtxo(LIVE_DATUM.delegate, liveRecord());
  const world = () => ledgerWorld([utxoOf(LIVE.mint_output), delegate]);
  const use = (over: Partial<{ action: string; resource: string; atMs: number }> = {}) =>
    checkDelegationUse(world().env, { id: LIVE.id, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, ...over });
  const KEY_PROBLEM = new RegExp(`no longer lists the delegate key ${LIVE_DATUM.delegateKey} of ${LIVE.id} with the delegation purpose`);

  test('inside the period, for the action of vault payments on the escrow script: the only problem is the key that this test cannot list', async () => {
    const r = await use();
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], KEY_PROBLEM);
    assert.equal(r.usable, false);
  });
  test('the pattern and the period of mainnet pass: no problem about the action, the resource or the time', async () => {
    const r = await use({ atMs: LIVE_DATUM.notBefore });
    assert.deepEqual(r.problems.filter((p) => !KEY_PROBLEM.test(p)), []);
    assert.deepEqual((await use({ atMs: LIVE_DATUM.notAfter })).problems.filter((p) => !KEY_PROBLEM.test(p)), [], 'the period ends at not_after, which is still inside');
  });
  test('the action must be covered: marketplace.hire.v2 is not, and the problem names the delegation', async () => {
    const r = await use({ action: 'marketplace.hire.v2' });
    assert.ok(r.problems.some((p) => p === `no action pattern of the delegation ${LIVE.id} covers "marketplace.hire.v2"`));
  });
  test('the resource must be covered: another script is not', async () => {
    const r = await use({ resource: `script:${'ab'.repeat(28)}` });
    assert.ok(r.problems.some((p) => p.startsWith(`no resource pattern of the delegation ${LIVE.id} covers "script:abab`)));
  });
  test('the time must be inside the period: a millisecond before not_before and after not_after is not', async () => {
    const before = await use({ atMs: LIVE_DATUM.notBefore - 1 });
    assert.ok(before.problems.some((p) => /starts at 2026-11-16T16:10:49\.000Z, after the start of the validity window/.test(p)));
    const after = await use({ atMs: LIVE_DATUM.notAfter + 1 });
    assert.ok(after.problems.some((p) => /ends at 2026-11-23T16:11:48\.658Z, before the end of the validity window/.test(p)));
  });
  test('a burned delegation is a problem and not an error: it is not live', async () => {
    const r = await checkDelegationUse(world().env, { id: BURNED.id, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS });
    assert.deepEqual(r.problems, [`the delegation ${BURNED.id} is not live: it does not exist, or it was undelegated and its token is burned`]);
    assert.equal(r.usable, false);
    assert.equal(r.view.chain.length, 0);
    assert.equal(callsTo(world().koios, 'tip').length, 0);
  });
  test('the delegate has no record: that is an error that names it', async () => {
    const w = ledgerWorld([utxoOf(LIVE.mint_output)]);
    await assert.rejects(() => checkDelegationUse(w.env, { id: LIVE.id, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS }), new RegExp(`did:vector:${LIVE_DATUM.delegate}`));
  });
});

// ─── checkDelegationUse: every problem, and its twin ──────────────────────────────────────────────────────────────────────────

describe('checkDelegationUse: every problem has a usable twin', () => {
  const ID = 'd1'.repeat(32);
  const DELEGATE_KEY = testKey(31);
  const record = (over: Partial<IdentityDatum> = {}, keys = [DELEGATE_KEY.publicKey]): IdentityDatum => liveRecord(over, keys);
  const base = delegation();
  const holdUntilLater: IdentityDatum['status'] = { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: CAPTURE_MS - 1000, until: CAPTURE_MS + DAY }] };

  /** A world with the delegation `d` (under ID), the record of its delegate, and `extra`. */
  function world(d: DelegationDatum = base, delegateRecord: IdentityDatum | null = record(), extra: UTxO[] = []): LedgerWorld {
    return ledgerWorld([delegationUtxo(ID, d), ...(delegateRecord === null ? [] : [recordUtxo(d.delegate, delegateRecord)]), ...extra]);
  }
  const check = (w: LedgerWorld, over: Partial<{ id: string; action: string; resource: string; atMs: number; minConfirmations: number }> = {}) =>
    checkDelegationUse(w.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, ...over });

  test('a delegation with a live delegate that lists its key, a period that holds the time, and the pattern of the action and resource is usable', async () => {
    const r = await check(world());
    assert.deepEqual(r.problems, []);
    assert.equal(r.usable, true);
    assert.equal(r.confirmations, null);
    assert.equal(r.view.chain.length, 1);
  });
  test('burned: it is not live; the same delegation while it is live is usable', async () => {
    const burned = await check(ledgerWorld([recordUtxo(base.delegate, record())]));
    assert.equal(burned.usable, false);
    assert.match(burned.problems[0], /is not live/);
    assert.equal((await check(world())).usable, true);
  });
  test('an ended ancestor: the parent was undelegated, so the child cannot be used; with the parent it can', async () => {
    const P = 'd2'.repeat(32);
    const AGENT_P = 'c4'.repeat(32);
    const keyP = testKey(32);
    const parent = delegation({ delegate: AGENT_P, delegateKey: keyP.keyHash, remaining: 1 });
    const child = delegation({ parent: P, depth: 2, remaining: 0, delegator: { type: 'Agent', id: AGENT_P } });
    const records = [recordUtxo(AGENT_P, record({}, [keyP.publicKey])), recordUtxo(base.delegate, record())];
    const orphan = await check(ledgerWorld([delegationUtxo(ID, child), ...records]));
    assert.equal(orphan.usable, false);
    assert.ok(orphan.problems.includes(`the parent delegation ${P} of ${ID} is missing`), orphan.problems.join('; '));
    assert.equal(orphan.view.missingParent, P);
    const whole = await check(ledgerWorld([delegationUtxo(ID, child), delegationUtxo(P, parent), ...records]));
    assert.deepEqual(whole.problems, []);
    assert.equal(whole.usable, true);
    assert.deepEqual(whole.view.chain.map((l) => l.id), [ID, P]);
  });
  test('a delegate that is not Active is not usable: a hold, a revocation, and no Accountable Party each; an Active one is', async () => {
    const suspended = await check(world(base, record({ status: holdUntilLater })));
    assert.equal(suspended.usable, false);
    assert.ok(suspended.problems.some((p) => p === `the delegate did:vector:${base.delegate} of ${ID} is Suspended`), suspended.problems.join('; '));
    const revoked = await check(world(base, record({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: CAPTURE_MS - DAY, invalidFrom: null, successor: null } })));
    assert.ok(revoked.problems.some((p) => /is Revoked$/.test(p)), revoked.problems.join('; '));
    const unaccountable = await check(world(base, record({ parties: [] })));
    assert.ok(unaccountable.problems.some((p) => /is Suspended$/.test(p)), unaccountable.problems.join('; '));
    assert.equal((await check(world(base, record()))).usable, true);
  });
  test('a delegate that no longer lists its key with the delegation purpose is not usable', async () => {
    const other = await check(world(base, record({}, [testKey(40).publicKey])));
    assert.ok(other.problems.some((p) => p.includes(`no longer lists the delegate key ${DELEGATE_KEY.keyHash} of ${ID} with the delegation purpose`)), other.problems.join('; '));
    const noPurpose = await check(world(base, record({ keys: [{ keyType: 'Ed25519', key: DELEGATE_KEY.publicKey, purposes: 1 + 2 + 8, pop: null }] })));
    assert.equal(noPurpose.usable, false, 'a key without the delegation purpose is not the delegation key');
    assert.equal((await check(world(base, record({}, [testKey(40).publicKey, DELEGATE_KEY.publicKey])))).usable, true);
  });
  test('a root delegator that is an agent must be Active; a principal key needs no record', async () => {
    const ROOT = 'c5'.repeat(32);
    const byAgent = delegation({ delegator: { type: 'Agent', id: ROOT } });
    const suspended = await check(world(byAgent, record(), [recordUtxo(ROOT, record({ status: holdUntilLater }))]));
    assert.ok(suspended.problems.some((p) => p === `the root delegator did:vector:${ROOT} is Suspended`), suspended.problems.join('; '));
    assert.equal((await check(world(byAgent, record(), [recordUtxo(ROOT, record())]))).usable, true);
    assert.equal((await check(world(base))).usable, true);
  });
  test('the action must be covered, by the pattern rule: a prefix covers a longer name, string equality is not the rule', async () => {
    const cover = async (patterns: string[], action: string) => (await check(world(delegation({ actions: patterns.map(utf8Hex) })), { action })).usable;
    assert.equal(await cover(['marketplace.hire.v1'], HIRE_ACTION), true);
    assert.equal(await cover(['marketplace.hire.v2'], HIRE_ACTION), false, 'another version');
    assert.equal(await cover(['marketplace.*'], HIRE_ACTION), true, 'a prefix covers it');
    assert.equal(await cover(['marketplace.hire.*'], HIRE_ACTION), true);
    assert.equal(await cover(['market.*'], HIRE_ACTION), false, 'a prefix is whole segments: market is not marketplace');
    assert.equal(await cover(['marketplace.hire.v1.*'], HIRE_ACTION), false, 'a prefix needs a dot after it');
    assert.equal(await cover(['*'], HIRE_ACTION), true);
    assert.equal(await cover(['x.y', 'marketplace.*'], HIRE_ACTION), true, 'one pattern of several');
    assert.equal(await cover(['mcp:tool'], 'mcp:tool'), true, 'an external matches exactly');
    assert.equal(await cover(['mcp:tool'], 'mcp:tool2'), false);
    assert.equal(await cover(['mcp:*'], 'mcp:tool'), false, 'an external pattern is never a prefix');
  });
  test('the resource must be covered: its own script and * are, another script and an empty list are not', async () => {
    const cover = async (patterns: string[], resource = ESCROW) => (await check(world(delegation({ resources: patterns.map(utf8Hex) })), { resource })).usable;
    assert.equal(await cover([ESCROW]), true);
    assert.equal(await cover([`script:${'ab'.repeat(28)}`]), false);
    assert.equal(await cover(['*']), true);
    assert.equal(await cover([]), false);
    assert.equal(await cover(['https://api.example/v1'], 'https://api.example/v1'), true);
    assert.equal(await cover(['https://api.example/v1'], 'https://api.example/v2'), false);
    const empty = await check(world(delegation({ resources: [] })));
    assert.ok(empty.problems.some((p) => p.endsWith('(an empty resource list covers nothing)')), empty.problems.join('; '));
  });
  test('the time must be inside the period: both bounds are inside, a millisecond beyond each is not', async () => {
    const at = async (atMs: number) => (await check(world(), { atMs })).usable;
    assert.equal(await at(base.notBefore), true);
    assert.equal(await at(base.notAfter), true);
    assert.equal(await at(base.notBefore - 1), false);
    assert.equal(await at(base.notAfter + 1), false);
    assert.equal(await at(CAPTURE_MS), true);
  });
  test('every problem is reported at once', async () => {
    const atMs = base.notAfter + 1;
    const longHold: IdentityDatum['status'] = { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: CAPTURE_MS, until: atMs + DAY }] };
    const r = await check(world(base, record({ status: longHold })), { action: 'marketplace.hire.v2', resource: `script:${'ab'.repeat(28)}`, atMs });
    assert.equal(r.problems.length, 4, r.problems.join('; '));
    assert.equal(r.usable, false);
  });
  test('an action or a resource that does not follow Part 2 Section 5.1 is refused, naming the rule; a pattern is not an action', async () => {
    const w = world();
    for (const action of ['*', 'marketplace.*', '', 'Hire', 'a b']) await assert.rejects(() => check(w, { action }), /The action must follow Part 2 Section 5\.1/, JSON.stringify(action));
    for (const resource of ['*', 'script:abc', '', 'hire']) await assert.rejects(() => check(w, { resource }), /The resource must follow Part 2 Section 5\.1/, JSON.stringify(resource));
    await assert.rejects(() => check(w, { minConfirmations: -1 }), /min_confirmations/);
    await assert.rejects(() => check(w, { minConfirmations: 1.5 }), /min_confirmations/);
    assert.equal(w.koios.calls.length, 0, 'no request was made for a refused input');
  });
});

// ─── Confirmations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('checkDelegationUse: minimum confirmations', () => {
  const ID = 'd1'.repeat(32);
  const TIP = 9_502_929;
  const utxo = delegationUtxo(ID, delegation());
  const keyed = recordUtxo(delegation().delegate, liveRecord({}, [testKey(31).publicKey]));
  const run = (blockHeight: number | undefined, min: number, tip: number | null = TIP) => {
    const w = ledgerWorld([utxo, keyed], { utxoInfo: [koiosRow(utxo, { block_height: blockHeight })], tip });
    return checkDelegationUse(w.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: min }).then((r) => ({ r, w }));
  };

  test('by default the delegation needs no wait, and Koios is not asked anything', async () => {
    const w = ledgerWorld([utxo, keyed]);
    const r = await checkDelegationUse(w.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS });
    assert.equal(r.usable, true);
    assert.equal(r.minConfirmations, 0);
    assert.equal(w.koios.calls.length, 0);
    assert.equal((await checkDelegationUse(w.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 0 })).usable, true);
    assert.equal(w.koios.calls.length, 0);
  });
  test('a mint 30 blocks below the tip has 30 confirmations: usable for 30, not for 31; 29 blocks is not enough for 30', async () => {
    const ok = await run(TIP - 30, 30);
    assert.equal(ok.r.usable, true);
    assert.deepEqual(ok.r.confirmations, { tipHeight: TIP, links: [{ id: ID, blockHeight: TIP - 30, confirmations: 30 }] });
    const fewer = await run(TIP - 29, 30);
    assert.equal(fewer.r.usable, false);
    assert.deepEqual(fewer.r.problems, [`the delegation ${ID} has 29 confirmations, fewer than the 30 that are asked for`]);
    assert.equal((await run(TIP - 30, 31)).r.usable, false);
    assert.equal((await run(TIP, 1)).r.usable, false, 'a mint in the tip block has none');
    assert.equal((await run(TIP, 0)).r.usable, true);
  });
  test('Koios is asked for the tip and for the output of each link, once', async () => {
    const { w } = await run(TIP - 40, 30);
    assert.equal(callsTo(w.koios, 'tip').length, 1);
    const info = callsTo(w.koios, 'utxo_info');
    assert.equal(info.length, 1);
    assert.deepEqual(info[0].body, { _utxo_refs: [`${utxo.txHash}#${utxo.outputIndex}`], _extended: true });
  });
  test('a link whose block height Koios does not give has unknown confirmations: a problem', async () => {
    const { r } = await run(undefined, 30);
    assert.equal(r.usable, false);
    assert.deepEqual(r.problems, [`Koios gives no block height for the output of the delegation ${ID}, so its confirmations are unknown`]);
    assert.deepEqual(r.confirmations!.links, [{ id: ID, blockHeight: null, confirmations: null }]);
    const missing = ledgerWorld([utxo, keyed], { utxoInfo: [] });
    assert.equal((await checkDelegationUse(missing.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 1 })).usable, false);
  });
  test('every link of a chain must be deep enough, and the shallow one is named', async () => {
    const P = 'd2'.repeat(32);
    const AGENT_P = 'c4'.repeat(32);
    const keyP = testKey(32);
    const parent = delegationUtxo(P, delegation({ delegate: AGENT_P, delegateKey: keyP.keyHash, remaining: 1 }));
    const child = delegationUtxo(ID, delegation({ parent: P, depth: 2, remaining: 0, delegator: { type: 'Agent', id: AGENT_P } }));
    const records = [recordUtxo(AGENT_P, liveRecord({}, [keyP.publicKey])), keyed];
    const world = (parentHeight: number) => ledgerWorld([child, parent, ...records], { tip: TIP, utxoInfo: [koiosRow(child, { block_height: TIP - 100 }), koiosRow(parent, { block_height: parentHeight })] });
    const ok = await checkDelegationUse(world(TIP - 50).env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 30 });
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.confirmations!.links.map((l) => l.confirmations), [100, 50]);
    const shallow = await checkDelegationUse(world(TIP - 5).env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 30 });
    assert.deepEqual(shallow.problems, [`the delegation ${P} has 5 confirmations, fewer than the 30 that are asked for`]);
  });
  test('an answer of utxo_info over the size cap is refused, and one at the cap is read', async () => {
    const big = ledgerWorld([utxo, keyed], { utxoInfo: [koiosRow(utxo)], announce: { utxo_info: KOIOS_ANSWER_BYTES + 1 } });
    await assert.rejects(() => checkDelegationUse(big.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 1 }), (err: Error) => err.message === `Koios utxo_info: the answer is over the ${KOIOS_ANSWER_BYTES} byte limit`);
    const fine = ledgerWorld([utxo, keyed], { utxoInfo: [koiosRow(utxo)], announce: { utxo_info: KOIOS_ANSWER_BYTES } });
    assert.equal((await checkDelegationUse(fine.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 1 })).confirmations!.links.length, 1);
  });
  test('a Koios that fails is an error, and not a delegation that cannot be used', async () => {
    const w = ledgerWorld([utxo, keyed], { status: { tip: 500 }, utxoInfo: [koiosRow(utxo)] });
    await assert.rejects(() => checkDelegationUse(w.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 1 }), (err: Error) => err.message === 'Koios tip answered 500');
    const u = ledgerWorld([utxo, keyed], { status: { utxo_info: 500 } });
    await assert.rejects(() => checkDelegationUse(u.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 1 }), (err: Error) => err.message === 'Koios utxo_info answered 500');
  });
  test('a burned delegation is a problem before any confirmation is read', async () => {
    const w = ledgerWorld([keyed]);
    const r = await checkDelegationUse(w.env, { id: ID, action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS, minConfirmations: 30 });
    assert.equal(r.usable, false);
    assert.equal(r.confirmations, null);
    assert.equal(w.koios.calls.length, 0);
  });
});

// ─── Each record is read once for a call ───────────────────────────────────────────────────────────────────────────────────────────

describe('checkDelegationUse: each record is read once for a call', () => {
  // A chain of four links. The delegates are four agents that are subagents of one agent, so each of them has the same ancestor.
  const SHARED = 'e0'.repeat(32);
  const ids = ['d1', 'd2', 'd3', 'd4'].map((b) => b.repeat(32));
  const agents = ['a1', 'a2', 'a3', 'a4'].map((b) => b.repeat(32));
  const keys = [60, 61, 62, 63].map((n) => testKey(n));
  const links = ids.map((id, i) => delegationUtxo(id, delegation({
    parent: i + 1 < ids.length ? ids[i + 1] : null, depth: ids.length - i, remaining: i, delegate: agents[i], delegateKey: keys[i].keyHash,
    delegator: i + 1 < ids.length ? { type: 'Agent', id: agents[i + 1] } : { type: 'PrincipalKey', hash: testKey(30).keyHash, organisation: null },
  })));
  const records = [recordUtxo(SHARED, liveRecord()), ...agents.map((a, i) => recordUtxo(a, liveRecord({ lineage: { type: 'Subagent', parent: SHARED, parentEpoch: 0, depth: 1 } }, [keys[i].publicKey])))];
  const world = () => ledgerWorld([...links, ...records]);

  test('the shared ancestor is read once, not once for each link: 5 records for 4 delegates', async () => {
    const w = world();
    const r = await checkDelegationUse(w.env, { id: ids[0], action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS });
    assert.deepEqual(r.problems, []);
    assert.equal(r.view.chain.length, 4);
    assert.equal(w.provider.scansOf(MAINNET.identity.address), 5, 'the four agents and their shared ancestor, once each');
    assert.equal(w.provider.scansOf(MAINNET.delegation.address), 4, 'the four links, once each');
  });
  test('it reads the records that chainRecords reads, and a record that is missing is an error that names it', async () => {
    const w = world();
    const view = await readDelegation(w.env, ids[0]);
    const once = await readChainRecords(w.env, view.chain);
    const each = await chainRecords(w.env.provider, MAINNET, view.chain);
    assert.deepEqual(once.map((r) => r.id).sort(), each.map((r) => r.id).sort());
    assert.deepEqual(delegationUseProblems(view.chain, recordsById(once), HIRE_ACTION, ESCROW, { lo: CAPTURE_MS, hi: CAPTURE_MS }), []);
    const lone = ledgerWorld([...links, ...records.slice(1)]);
    await assert.rejects(() => checkDelegationUse(lone.env, { id: ids[0], action: HIRE_ACTION, resource: ESCROW, atMs: CAPTURE_MS }), new RegExp(`No parent record for did:vector:${SHARED}`));
  });
});
