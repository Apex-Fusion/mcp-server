import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOutflow, evaluate, type SpendLimits } from '../src/policy.ts';
import type { DecodedTx } from '../src/decode.ts';

const OWN = 'addr1own';
const OTHER_OWN = 'addr1own_second_index';
const FOREIGN = 'addr1foreign';

const LIMITS: SpendLimits = { perTxLovelace: 100_000_000n, dailyLovelace: 500_000_000n };

function tx(partial: Partial<DecodedTx>): DecodedTx {
  return {
    txHashHex: 'a'.repeat(64),
    fee: 200_000n,
    outputs: [],
    inputCount: 1,
    mintedAssetCount: 0,
    ...partial,
  };
}

describe('computeOutflow', () => {
  test('counts a foreign output plus the fee', () => {
    const r = computeOutflow(tx({ outputs: [{ address: FOREIGN, lovelace: 3_000_000n, assets: [] }] }), [OWN]);
    assert.equal(r.netOutflowLovelace, 3_200_000n);
  });

  test('excludes change returning to our own address', () => {
    const r = computeOutflow(
      tx({ outputs: [
        { address: FOREIGN, lovelace: 3_000_000n, assets: [] },
        { address: OWN, lovelace: 996_000_000n, assets: [] },
      ] }),
      [OWN]
    );
    assert.equal(r.netOutflowLovelace, 3_200_000n, 'change must not count as outflow');
  });

  test('counts the fee even when every output returns to us', () => {
    const r = computeOutflow(tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }), [OWN]);
    assert.equal(r.netOutflowLovelace, 200_000n);
  });

  test('honours multiple own addresses', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: OTHER_OWN, lovelace: 7_000_000n, assets: [] }] }),
      [OWN, OTHER_OWN]
    );
    assert.equal(r.netOutflowLovelace, 200_000n);
  });

  test('records assets leaving to a foreign address', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: FOREIGN, lovelace: 2_000_000n, assets: [{ unit: 'policy1nft', quantity: 1n }] }] }),
      [OWN]
    );
    assert.deepStrictEqual(r.assetMovements, [{ unit: 'policy1nft', quantity: 1n, toAddress: FOREIGN }]);
  });

  test('does not record assets returning to us', () => {
    const r = computeOutflow(
      tx({ outputs: [{ address: OWN, lovelace: 2_000_000n, assets: [{ unit: 'policy1nft', quantity: 1n }] }] }),
      [OWN]
    );
    assert.deepStrictEqual(r.assetMovements, []);
  });
});

describe('evaluate — adversarial', () => {
  test('refuses a drain that exceeds the per-transaction limit', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 250_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /per-transaction limit/i);
  });

  test('allows a transaction inside both limits', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 3_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
    assert.equal(d.reason, undefined);
  });

  test('refuses when the daily budget is already exhausted', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 10_000_000n, assets: [] }] }),
      [OWN], LIMITS, 495_000_000n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /daily/i);
  });

  test('a large transaction is allowed if it fits exactly', () => {
    const d = evaluate(
      tx({ fee: 0n, outputs: [{ address: FOREIGN, lovelace: 100_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.allowed, true);
  });

  test('a transaction with no outputs still charges the fee', () => {
    const d = evaluate(tx({ outputs: [] }), [OWN], LIMITS, 0n);
    assert.equal(d.netOutflowLovelace, 200_000n);
    assert.equal(d.allowed, true);
  });

  test('refuses when ownAddresses is empty — nothing can be classified as change', () => {
    const d = evaluate(
      tx({ outputs: [{ address: OWN, lovelace: 5_000_000n, assets: [] }] }),
      [], LIMITS, 0n
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /own address/i);
  });

  test('the reported outflow is always present, even on refusal', () => {
    const d = evaluate(
      tx({ outputs: [{ address: FOREIGN, lovelace: 250_000_000n, assets: [] }] }),
      [OWN], LIMITS, 0n
    );
    assert.equal(d.netOutflowLovelace, 250_200_000n);
  });
});
