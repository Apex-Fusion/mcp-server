// packages/builder/test/fixtures/ledger-node.fixture.ts
// A node that judges a vault payment as mainnet Ogmios does, offline. The evaluator that Lucid ships runs the deployed scripts over the
// UTxOs of the world (uplc-node.fixture.ts). When a script fails, the node answers with the real error body that mainnet Ogmios gave for
// a refused vault payment (ogmios-evaluation-errors-mainnet.json, captured by capture-ogmios-evaluation-errors.mjs), and the real
// OgmiosProvider turns that body into the OgmiosRpcError that the builders read. So a test sees the error as production sees it.
// The library tests (vault-build.test.ts) and the handler tests (vault-tools.test.ts) of `ledger_decides` share it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { UTxO } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { FIXTURE_UTXOS } from './fixture-provider.ts';
import type { FixtureProvider } from './fixture-provider.ts';
import { DAY, NOW, REF_UTXOS, LISTED, recordUtxo, rootRecord } from './identity-world.ts';
import { uplcEvaluatingProvider } from './uplc-node.fixture.ts';
import { advertUtxo, agentRecord, delegateRecord, delegation, delegationUtxo, liveVault, vaultUtxo } from './escrow-identity.fixture.ts';

/** The tip of the fixtures' chain at NOW: it starts at 1756485600000 and has a slot each second. */
export const TIP_SLOT = (NOW - 1_756_485_600_000) / 1000;

/** The shape of the error bodies of Ogmios that the tests read and change. */
export interface ValidatorBody { validator: { index: number; purpose: string }; error: { code: number; message: string; data: { validationError?: string; reason?: string; traces: unknown[] } } }
export interface ErrorBody { error: { code: number; message: string; data?: ValidatorBody[] | Record<string, unknown> } }
export const validatorsOf = (body: ErrorBody): ValidatorBody[] => body.error.data as ValidatorBody[];

/** The real error bodies that mainnet Ogmios answered with: the HTTP status and the body of each case (above_per_tx, past_total, past_horizon). */
export const OGMIOS_ERRORS: Record<string, { httpStatus: number; body: ErrorBody }> =
  JSON.parse(readFileSync(resolve(import.meta.dirname!, 'ogmios-evaluation-errors-mainnet.json'), 'utf8')).cases;

/** The answer of the node for a case of the fixture, as a Response; `patch` changes a copy of the body first. */
export function answerOf(name: string, patch: (body: ErrorBody) => void = () => {}): Response {
  const body = structuredClone(OGMIOS_ERRORS[name].body);
  patch(body);
  return new Response(JSON.stringify(body), { status: OGMIOS_ERRORS[name].httpStatus, statusText: 'Bad Request' });
}

/** The error that `OgmiosProvider.evaluateTx` raises when its node answers with `answer`, or does not answer: the real provider, with the answer in place of the network. */
export async function ogmiosRaised(answer: Response | Error): Promise<unknown> {
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

/** The node of these tests: the fixture provider that evaluates the scripts, and the list of the transactions that it was asked to evaluate. */
export type EvaluatingNode = FixtureProvider & { evaluations: string[] };

/**
 * A node that evaluates the scripts for real, and answers a validator that failed as Ogmios does: the 3010 with a 3012 of the real
 * fixture (above_per_tx), with the text of the evaluator as the detail of the validator, and the purpose and the index that the
 * evaluator names.
 */
export function evaluatingNode(utxos: UTxO[]): EvaluatingNode {
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
}

// ─── A delegation with two hops ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The parent delegation of the leaf: the principal key delegates to the middle agent. */
export const PARENT_ID = '9a'.repeat(32);
/** The middle agent: the delegate of the parent, the delegator of the leaf, and the owner of the vault. */
export const MIDDLE_ID = 'a1'.repeat(32);
export const MIDDLE_OWNER = { type: 'Agent' as const, id: MIDDLE_ID };

/** The parent delegation output: the middle agent may delegate one hop further; it holds the wider limit. Valid from a day before `now`. */
export const parentDelegationUtxo = (now = NOW): UTxO => ({
  ...delegationUtxo(delegation({
    delegate: MIDDLE_ID, delegateKey: LISTED.keyHash, remaining: 1, notBefore: now - DAY, notAfter: now + 30 * DAY, value: { perTx: 80_000_000n, total: 200_000_000n, periodMs: DAY },
  }), PARENT_ID),
  txHash: 'd2'.repeat(32),
});
/** The leaf delegation output (the id DELEGATION_ID that the vault names): the middle agent delegates to the delegate agent, one hop down. */
export const leafDelegationUtxo = (now = NOW): UTxO =>
  delegationUtxo(delegation({ delegator: MIDDLE_OWNER, parent: PARENT_ID, depth: 2, remaining: 0, notBefore: now - DAY, notAfter: now + 30 * DAY }));

/**
 * What the node holds for a payment under a delegation with two hops: the vault (owned by the middle agent), the leaf, the parent
 * (unless `parent` is false: it was undelegated), the records of the middle and the delegate agent, the agent of the advert and the advert.
 * `now` is the time that the delegations run around; `vaultTxHash` is where the vault output is.
 */
export function twoHopWorld(over: { parent?: boolean; now?: number; vaultTxHash?: string } = {}): UTxO[] {
  const now = over.now ?? NOW;
  return [
    vaultUtxo(liveVault({ owner: MIDDLE_OWNER }), 100_000_000n, 0, over.vaultTxHash === undefined ? {} : { txHash: over.vaultTxHash }),
    leafDelegationUtxo(now), ...(over.parent === false ? [] : [parentDelegationUtxo(now)]),
    recordUtxo(MIDDLE_ID, rootRecord()), delegateRecord(), agentRecord(), advertUtxo(),
  ];
}
