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
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FOREIGN_ADDRESS } from './fixtures/fixture-provider.ts';
import { ESCROW_LOCKED_LOVELACE, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { ESCROW_SCRIPT_CBOR } from './fixtures/escrow-script.fixture.ts';
import { ESCROW_ADDRESS, ESCROW_REF_UTXO } from '../src/vector/marketplace-constants.ts';
import { decodeEscrowDatum, encodeEscrowDatum } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../src/vector/marketplace-datum.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import { buildAccept, buildReclaim } from '../src/vector/marketplace-build.ts';

const OWN_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
const POSTED: EscrowDatum = { ...decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), buyer_pkh: OWN_PKH };
const SUBMITTED: EscrowDatum = { ...POSTED, submitted_at: POSTED.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
const OPENS = Math.ceil((POSTED.deliver_by + 1) / 1000) * 1000;
const escrowAt = (txHash: string, datum: EscrowDatum): UTxO =>
  ({ txHash, outputIndex: 0, address: ESCROW_ADDRESS, assets: { lovelace: ESCROW_LOCKED_LOVELACE }, datum: encodeEscrowDatum(datum) });
const REF_SCRIPT_UTXO: UTxO = {
  txHash: ESCROW_REF_UTXO.txHash, outputIndex: ESCROW_REF_UTXO.outputIndex, address: FOREIGN_ADDRESS,
  assets: { lovelace: 60_000_000n }, scriptRef: { type: 'PlutusV3', script: ESCROW_SCRIPT_CBOR },
};
const koios = (spent: boolean) => (async () => new Response(JSON.stringify([{
  tx_hash: ESCROW_REF.slice(0, 64), tx_index: 0, address: ESCROW_ADDRESS, value: '2261030', is_spent: spent, inline_datum: { bytes: encodeEscrowDatum(POSTED) },
}]), { status: 200 })) as unknown as typeof fetch;

// Everything else is in order (live escrow, funds, collateral, reference script); only the clock is off, by a single millisecond.
const ONE_MS_OFF = 1_756_485_600_001;
const provider = Object.assign(
  new FixtureProvider([...FIXTURE_UTXOS, REF_SCRIPT_UTXO, escrowAt(ESCROW_REF.slice(0, 64), POSTED), escrowAt('ee'.repeat(32), SUBMITTED)]),
  { getSystemStartMs: async () => ONE_MS_OFF },
);

describe('Accept and Reclaim on a chain whose slot zero time is not a whole number of seconds', () => {
  const clockRefusal = new RegExp(`slot zero time \\(${ONE_MS_OFF} ms\\) is not a whole number of seconds`);
  test('Reclaim is refused, saying so, before any transaction is built', async () => {
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(() => buildReclaim(lucid, provider, 'https://koios.example', { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: OPENS + 5_000 }, koios(false)), clockRefusal);
  });
  test('Accept is refused the same way', async () => {
    const lucid = await lucidForAddress(provider, OWN_ADDRESS);
    await assert.rejects(() => buildAccept(lucid, provider, 'https://koios.example', { changeAddress: OWN_ADDRESS, escrowRef: ESCROW_REF, nowMs: SUBMITTED.submitted_at! + 120_000 }, koios(true)), clockRefusal);
  });
});
