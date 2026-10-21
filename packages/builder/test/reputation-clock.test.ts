// packages/builder/test/reputation-clock.test.ts
// The reputation module is deployed on Vector mainnet only, and the reference SDK's one clock failure was a genesis constant that was
// testnet's. The stake builders therefore refuse a node whose chain start is not mainnet's. ensureSlotConfig keeps the first clock it
// reads for the life of the process (gov-build.ts), so a testnet clock has to be the first one a process sees: these tests have a file
// of their own (node runs each file in its own process), as marketplace-build-clock.test.ts does for the escrow builders.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lucidForAddress } from '../src/vector/build.ts';
import { stakeClock, buildStakeOpening } from '../src/vector/reputation-build.ts';
import { STAKE_A, PARAMS_UTXO, CROSS_REFS_UTXO } from './fixtures/advert-stake-golden.fixture.ts';
import { uplcEvaluatingProvider } from './fixtures/uplc-node.fixture.ts';

const TESTNET_ZERO = 1_752_057_484_000; // the SDK's constants.py SYSTEM_START_UNIX_S, in ms
const onTestnetClock = () => Object.assign(uplcEvaluatingProvider([STAKE_A.wallet, STAKE_A.registry, PARAMS_UTXO, CROSS_REFS_UTXO], 100), {
  getSystemStartMs: async () => TESTNET_ZERO,
});

describe('a node whose chain start is not Vector mainnet\'s', () => {
  test('a node that cannot give the clock is a refusal that names the failure, not the endpoint', async () => {
    const node = Object.assign(onTestnetClock(), { getSystemStartMs: async () => { throw new Error('connect ECONNREFUSED https://ogmios.internal.example'); } });
    await assert.rejects(stakeClock(node, Date.now()), (err: Error) => /Could not read the chain clock from the node/.test(err.message) && !err.message.includes('ogmios.internal.example'));
  });
  test('the stake time is refused, naming both starts, and step 1 locks nothing', async () => {
    const node = onTestnetClock();
    await assert.rejects(stakeClock(node, TESTNET_ZERO + 100_000), /The node reports a chain start of 2025-07-09T10:38:04\.000Z, not Vector mainnet's 2025-08-29T16:40:00\.000Z\. The reputation module these tools build for is deployed on mainnet only; nothing was built\./);
    await assert.rejects(
      buildStakeOpening(await lucidForAddress(node, STAKE_A.ownerAddress), node, { changeAddress: STAKE_A.ownerAddress, agentId: STAKE_A.agentId, capabilities: STAKE_A.capabilities, nowMs: TESTNET_ZERO + 100_000 }),
      /not Vector mainnet's/,
    );
  });
});
