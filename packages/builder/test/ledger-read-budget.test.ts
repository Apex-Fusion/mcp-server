// packages/builder/test/ledger-read-budget.test.ts
// One budget for each of the six reads (withinBudget): a source that never answers gives the answer of the budget at 30 s, and not a
// millisecond before; the Koios requests of the call are aborted; and when the open request of the call is answered late, no request
// starts after the end. The clock is the mock clock of the test runner, so no test waits. The node is an offline world and Koios is a fake:
// no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readAttestation, checkAttestation, listAttestations } from '../src/vector/attestation-read.ts';
import { checkDelegationUse, readDelegation } from '../src/vector/delegation-read.ts';
import { BudgetSpent, READ_BUDGET_MS } from '../src/vector/ledger-read.ts';
import type { LedgerEnv } from '../src/vector/ledger-read.ts';
import { readVaults } from '../src/vector/vault-read.ts';
import { HIRE_ACTION, escrowResource } from '../src/vector/delegation-build.ts';
import { testKey } from './fixtures/identity-world.ts';
import { CAPTURE_MS, DAY, MAINNET, attestation, attestationUtxo, delegation, delegationUtxo, koiosRow, ledgerWorld, liveRecord, recordUtxo, vaultUtxo } from './fixtures/ledger-read-world.ts';
import type { LedgerWorld } from './fixtures/ledger-read-world.ts';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** What a promise settled with, once it has: it tracks the outcome, so that a rejection is not left unhandled. */
const track = (promise: Promise<unknown>): (() => unknown) => {
  let result: unknown = 'pending';
  promise.then((value) => { result = value; }, (err) => { result = err; });
  return () => result;
};

/**
 * The node and the fetch of one call, with every request counted. The first request of the side that `hang` names is held: with `never`
 * it ends only when the signal of the request aborts (a Koios request) or not at all (a node request), and with `late` it is answered when
 * the test calls `release`, whatever its signal says. The other requests, and every request when `hang` is null, go through. With `when`
 * the held request is the first one whose arguments it accepts, and not the first one.
 */
class Probe {
  readonly calls: string[] = [];
  readonly signals: AbortSignal[] = [];
  private held = false;
  private open: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => { this.open = resolve; });

  constructor(private readonly hang: 'node' | 'koios' | null, private readonly mode: 'never' | 'late', private readonly when?: (args: unknown[]) => boolean) {}

  /** Answers the held request. */
  release(): void { this.open(); }

  private pass<T>(side: 'node' | 'koios', name: string, args: unknown[], run: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    this.calls.push(`${side} ${name}`);
    if (side !== this.hang || this.held || (this.when !== undefined && !this.when(args))) return run();
    this.held = true;
    if (this.mode === 'late') return this.gate.then(run);
    return new Promise<T>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(signal.reason)); });
  }

  /** The env of `world` with the node and the fetch of this probe. */
  envOf(world: LedgerWorld): LedgerEnv {
    const provider = new Proxy(world.provider, {
      get: (target, name) => {
        const member: unknown = Reflect.get(target, name);
        return typeof member === 'function' ? (...args: unknown[]) => this.pass('node', String(name), args, () => member.apply(target, args)) : member;
      },
    });
    const fetchImpl = ((url: string, init?: RequestInit) => {
      if (init?.signal) this.signals.push(init.signal);
      return this.pass('koios', new URL(url).pathname.split('/').pop()!, [url, init], () => world.env.fetchImpl(url, init), init?.signal);
    }) as typeof fetch;
    return { ...world.env, provider, fetchImpl };
  }
}

// ─── The worlds ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const idOf = (n: number): string => n.toString(16).padStart(64, '0');
const SUBJECT = 'a1'.repeat(32);
const ISSUER = 'ee'.repeat(32);
const PARENT = 'b1'.repeat(32);
const CHILD = 'b2'.repeat(32);
const D = 'd1'.repeat(32);
const KEY = testKey(31);
const OWNER = testKey(50);
const owner = { type: 'PrincipalKey', hash: OWNER.keyHash, organisation: null } as const;

/** An attestation of a registered issuer, and the record of that issuer: a check reads the node twice. */
const attestationWorld = (): LedgerWorld => ledgerWorld([attestationUtxo(idOf(1), attestation({ subject: SUBJECT, issuerId: ISSUER })), recordUtxo(ISSUER, liveRecord())]);
/** 500 attestations about one subject: a full page, so that a list asks for a second one. */
const subjectWorld = (): LedgerWorld => ledgerWorld(Array.from({ length: 500 }, (_, i) => attestationUtxo(idOf(i + 1), attestation({ subject: SUBJECT }))));
/** A child delegation and its parent: a read of the chain asks for two links. */
const chainWorld = (): LedgerWorld => ledgerWorld([delegationUtxo(PARENT, delegation()), delegationUtxo(CHILD, delegation({ parent: PARENT, depth: 2, remaining: 0, delegator: { type: 'Agent', id: 'c3'.repeat(32) } }))]);
/** A delegation that can be used, with the record of its delegate, and the output that Koios knows for the confirmations. */
const useWorld = (): LedgerWorld => {
  const link = delegationUtxo(D, delegation());
  return ledgerWorld([link, recordUtxo(delegation().delegate, liveRecord({}, [KEY.publicKey]))], { utxoInfo: [koiosRow(link, { block_height: 9_000_000 })] });
};
/** A Live vault of its owner, the delegation that it names and the record of the delegate. */
const vaultWorld = (): { world: LedgerWorld; ref: string } => {
  const vault = vaultUtxo({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2 }, 9_000_000n);
  return { world: ledgerWorld([vault, delegationUtxo(D, delegation({ delegator: owner })), recordUtxo(delegation().delegate, liveRecord({}, [KEY.publicKey]))]), ref: `${vault.txHash}#${vault.outputIndex}` };
};

interface Case { tool: string; source: 'node' | 'koios'; when?: (args: unknown[]) => boolean; make: () => { world: LedgerWorld; call: (env: LedgerEnv) => Promise<unknown> } }
const USE = { id: D, action: HIRE_ACTION, resource: escrowResource(MAINNET.escrow.hash), atMs: CAPTURE_MS };
/** Does a request of the node name the identity registry? A record is read from it after the attestation or the delegation. */
const touchesIdentity = (args: unknown[]): boolean => JSON.stringify(args, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)).includes(MAINNET.identity.hash);
/** Each read with the source whose first request is held. The reads that ask the node first are held at the node, and the ones that ask Koios first are held at Koios. */
const CASES: Case[] = [
  { tool: 'readAttestation', source: 'node', make: () => ({ world: attestationWorld(), call: (env) => readAttestation(env, idOf(1)) }) },
  { tool: 'checkAttestation', source: 'node', make: () => ({ world: attestationWorld(), call: (env) => checkAttestation(env, { id: idOf(1), atMs: CAPTURE_MS }) }) },
  { tool: 'listAttestations', source: 'koios', make: () => ({ world: subjectWorld(), call: (env) => listAttestations(env, { subject: SUBJECT }) }) },
  { tool: 'readDelegation', source: 'node', make: () => ({ world: chainWorld(), call: (env) => readDelegation(env, CHILD) }) },
  { tool: 'checkDelegationUse (the chain from the node)', source: 'node', make: () => ({ world: useWorld(), call: (env) => checkDelegationUse(env, USE) }) },
  { tool: 'checkDelegationUse (the confirmations from Koios)', source: 'koios', make: () => ({ world: useWorld(), call: (env) => checkDelegationUse(env, { ...USE, minConfirmations: 1 }) }) },
  { tool: 'readVaults by owner key hash (the list from Koios)', source: 'koios', make: () => ({ world: vaultWorld().world, call: (env) => readVaults(env, { ownerKeyHash: OWNER.keyHash }, CAPTURE_MS) }) },
  { tool: 'readVaults by output reference (the output from the node)', source: 'node', make: () => { const { world, ref } = vaultWorld(); return { world, call: (env) => readVaults(env, { vaultRef: ref }, CAPTURE_MS) }; } },
  { tool: 'checkAttestation (the record of the issuer, after the attestation)', source: 'node', when: touchesIdentity, make: () => ({ world: attestationWorld(), call: (env) => checkAttestation(env, { id: idOf(1), atMs: CAPTURE_MS }) }) },
  { tool: 'checkDelegationUse (the records, after the chain)', source: 'node', when: touchesIdentity, make: () => ({ world: useWorld(), call: (env) => checkDelegationUse(env, USE) }) },
];

describe('one budget for each of the six reads', () => {
  for (const { tool, source, when, make } of CASES) {
    test(`${tool}: a ${source} that never answers ends the call at the budget and not a millisecond before; a Koios request of the call is aborted`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
      const { world, call } = make();
      const probe = new Probe(source, 'never', when);
      const outcome = track(call(probe.envOf(world)));
      await flush();
      assert.equal(outcome(), 'pending', 'the first request is open');
      assert.ok(probe.calls.length >= 1);
      t.mock.timers.tick(READ_BUDGET_MS - 1);
      await flush();
      assert.equal(outcome(), 'pending', 'a millisecond before the budget the call still waits');
      t.mock.timers.tick(1);
      await flush();
      const ended = outcome();
      assert.ok(ended instanceof BudgetSpent && ended.budgetMs === READ_BUDGET_MS, String(ended));
      const requests = probe.calls.length;
      await flush();
      assert.equal(probe.calls.length, requests, 'no request starts after the end');
      if (source === 'koios') assert.ok(probe.signals.length >= 1 && probe.signals.every((signal) => signal.aborted), 'the Koios requests are aborted');
    });
    test(`${tool}: when the open ${source} request is answered after the end, the call does not go on: no request starts`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
      const { world, call } = make();
      const probe = new Probe(source, 'late', when);
      const outcome = track(call(probe.envOf(world)));
      await flush();
      const open = probe.calls.length;
      assert.ok(open >= 1);
      assert.equal(outcome(), 'pending');
      t.mock.timers.tick(READ_BUDGET_MS);
      await flush();
      assert.ok(outcome() instanceof BudgetSpent);
      probe.release();
      for (let i = 0; i < 5; i++) await flush();
      assert.equal(probe.calls.length, open, 'the late answer starts no new request');
    });
    test(`${tool}: the twin: a source that answers gives the answer of the read, and not the budget`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
      const { world, call } = make();
      const probe = new Probe(null, 'never');
      const outcome = track(call(probe.envOf(world)));
      for (let i = 0; i < 50 && outcome() === 'pending'; i++) await flush();
      assert.notEqual(outcome(), 'pending');
      assert.ok(!(outcome() instanceof Error), String(outcome()));
      assert.ok(probe.calls.length >= 1);
    });
  }
});
