// packages/builder/test/marketplace-build-clock.test.ts
// Accept and Reclaim place their validity range on whole seconds, and the Reclaim plan's guarantee (the lower bound, as the
// script sees it, is not before deliver_by) holds only while Vector's slot zero time is a whole number of seconds. The builders
// check that. ensureSlotConfig keeps the first clock it reads for the life of the process (gov-build.ts), so a misaligned clock
// has to be the first one a process sees, and that is why these tests have a file of their own (node runs each file in its own
// process). The same builders on the real, aligned clock are in marketplace-build.test.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressDetails } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { FIXTURE_UTXOS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { REF_SCRIPT_UTXO } from './fixtures/escrow-node.fixture.ts';
import { world, escrowAt, ESCROW_TX, SUBMIT_TX } from './fixtures/escrow-koios.fixture.ts';
import { decodeEscrowDatum, encodeEscrowDatum } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../src/vector/marketplace-datum.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import { buildAccept, buildReclaim } from '../src/vector/marketplace-build.ts';
import { ensureSlotConfig } from '../src/vector/gov-build.ts';

const OWN_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
const POSTED: EscrowDatum = { ...decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), buyer_pkh: OWN_PKH };
const SUBMITTED: EscrowDatum = { ...POSTED, submitted_at: POSTED.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
const OPENS = Math.ceil((POSTED.deliver_by + 1) / 1000) * 1000;

// Everything else is in order (live escrow, funds, collateral, reference script); only the clock is off, by a single millisecond.
// The node holds `chain` and Koios describes the same chain (`world`); `spent` is what Koios says of the Post output.
const ONE_MS_OFF = 1_756_485_600_001;
const onThisClock = (chain: UTxO[], spent: boolean) => {
  const w = world([...FIXTURE_UTXOS, REF_SCRIPT_UTXO, ...chain], { datumHex: encodeEscrowDatum(POSTED), spent });
  return { provider: Object.assign(w.node, { getSystemStartMs: async () => ONE_MS_OFF }), koios: w.koios.f };
};
const posted = escrowAt(ESCROW_TX, POSTED); // nobody has touched the Post output: a Reclaim is open
const submitted = escrowAt(SUBMIT_TX, SUBMITTED); // the Post output is spent and the escrow is Submitted: an Accept is open

describe('Accept and Reclaim on a chain whose slot zero time is not a whole number of seconds', () => {
  const clockRefusal = new RegExp(`slot zero time \\(${ONE_MS_OFF} ms\\) is not a whole number of seconds`);
  // First, while no clock has been read yet: a failed read sets nothing, and its words carry no endpoint.
  test('a node that cannot give the clock is a refusal that names the failure and not the endpoint', async () => {
    const { provider: node, koios } = onThisClock([posted], false);
    const provider = Object.assign(node, { getSystemStartMs: async (): Promise<number> => { throw new TypeError('connect ECONNREFUSED https://ogmios.example:1337'); } });
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(() => buildReclaim(lucid, provider, 'https://koios.example', { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: OPENS + 5_000 }, koios), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Could not read the chain clock from the node: node request failed (network error or timeout)');
      return true;
    });
  });
  test('a start time that is not a number is refused and never remembered: the next read asks the node again', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, '2025-08-29T16:40:00Z']) {
      let asked = 0;
      const clock = { getSystemStartMs: async () => { asked++; return bad as unknown as number; } };
      for (const attempt of [1, 2]) await assert.rejects(() => ensureSlotConfig(clock), /did not report a usable chain start time/, `${String(bad)}, attempt ${attempt}`);
      assert.equal(asked, 2, `${String(bad)}: the second read must reach the node, so the first answer was not cached`);
    }
  });
  test('Reclaim is refused, saying so, before any transaction is built', async () => {
    const { provider, koios } = onThisClock([posted], false);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(() => buildReclaim(lucid, provider, 'https://koios.example', { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: OPENS + 5_000 }, koios), clockRefusal);
  });
  test('Accept is refused the same way', async () => {
    const { provider, koios } = onThisClock([submitted], true);
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(() => buildAccept(lucid, provider, 'https://koios.example', { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: SUBMITTED.submitted_at! + 120_000 }, koios), clockRefusal);
  });
});
