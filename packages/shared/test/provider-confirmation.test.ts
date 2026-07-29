import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { koiosIndicatesConfirmed } from '../src/provider.ts';

// koiosIndicatesConfirmed only ever sees a body that Koios already answered
// with an OK response - getKoiosTxStatus throws before this runs for a
// network failure or a non-2xx status. So every case here is "reachable and
// answered", and the only question is whether that answer means confirmed.

describe('koiosIndicatesConfirmed', () => {
  test('a positive confirmation count means confirmed', () => {
    assert.equal(koiosIndicatesConfirmed([{ tx_hash: 'a'.repeat(64), num_confirmations: 1 }]), true);
  });

  test('a larger confirmation count still means confirmed', () => {
    assert.equal(koiosIndicatesConfirmed([{ tx_hash: 'a'.repeat(64), num_confirmations: 42 }]), true);
  });

  test('an empty array (Koios has not indexed the hash yet) means not confirmed', () => {
    assert.equal(koiosIndicatesConfirmed([]), false);
  });

  test('zero confirmations means not confirmed', () => {
    assert.equal(koiosIndicatesConfirmed([{ tx_hash: 'a'.repeat(64), num_confirmations: 0 }]), false);
  });

  test('a missing num_confirmations field means not confirmed, not an error', () => {
    assert.equal(koiosIndicatesConfirmed([{ tx_hash: 'a'.repeat(64) }]), false);
  });

  test('a non-array body means not confirmed, not an error', () => {
    assert.equal(koiosIndicatesConfirmed(null), false);
    assert.equal(koiosIndicatesConfirmed(undefined), false);
    assert.equal(koiosIndicatesConfirmed({}), false);
    assert.equal(koiosIndicatesConfirmed('unexpected'), false);
  });

  test('a num_confirmations that is not a number means not confirmed, not an error', () => {
    // Defensive: guards against a future Koios response shape change (e.g. a
    // stringified count) silently being coerced by a loose truthiness check
    // instead of being treated as "cannot tell, so say not yet".
    assert.equal(koiosIndicatesConfirmed([{ num_confirmations: '3' }]), false);
    assert.equal(koiosIndicatesConfirmed([{ num_confirmations: null }]), false);
  });

  test('a negative confirmation count means not confirmed', () => {
    assert.equal(koiosIndicatesConfirmed([{ num_confirmations: -1 }]), false);
  });

  test('only the first entry is consulted, matching the single-hash query this is always called with', () => {
    assert.equal(
      koiosIndicatesConfirmed([{ num_confirmations: 0 }, { num_confirmations: 5 }]),
      false,
    );
  });
});
