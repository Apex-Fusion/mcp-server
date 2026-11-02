// packages/builder/test/identity-codec.test.ts
// The identity codecs against the Aiken CBOR fixtures (agents-marketplace contracts/identity-marketplace/fixtures/cbor-fixtures.json
// at b5d66a6, copied to test/fixtures/identity-cbor-fixtures.json): every datum decodes and encodes back to the same bytes, and
// every redeemer encodes to the bytes Aiken writes. Then the refusals of the decoders.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Data, Constr } from '@lucid-evolution/lucid';
import {
  decodeIdentityDatum, encodeIdentityDatum, decodeLegacyDatum, encodeLegacyDatum, encodeIdentityMint, decodeIdentityMint,
  encodeIdentitySpend, decodeIdentitySpend, decodeAttestationDatum, encodeAttestationDatum, encodeAttestationMint, encodeAttestationSpend,
  decodeDelegationDatum, encodeDelegationDatum, encodeDelegationMint, decodeVaultDatum, encodeVaultDatum, encodeVaultSpend,
  plutusAddressFromBech32, plutusAddressToBech32, plutusAddressToData, plutusAddressOf, utf8Hex, textOf, sameSigner,
} from '../src/vector/identity-codec.ts';
import type { IdentitySpend } from '../src/vector/identity-codec.ts';
import {
  decodeIdentityEscrowDatum, encodeIdentityEscrowDatum, decodeAnyEscrowDatum, decodeIdentityAdvertDatum, encodeIdentityAdvertDatum,
  decodeAnyAdvertDatum, identityEscrowLockFloor, escrowLockFloor, plutusDataMaxBytes, advertTextFieldsRoundTrip,
} from '../src/vector/marketplace-datum.ts';
import { OWN_ADDRESS } from './fixtures/fixture-provider.ts';

const FIXTURES = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/identity-cbor-fixtures.json'), 'utf8')).fixtures as Record<string, { type: string; cbor: string }>;
const cbor = (name: string): string => { const f = FIXTURES[name]; assert.ok(f, `fixture ${name}`); return f.cbor; };

describe('datums decode and encode back to the bytes Aiken writes', () => {
  const roundTrips: Array<[string, (hex: string) => string]> = [
    ['identity_datum_full', (h) => encodeIdentityDatum(decodeIdentityDatum(h))],
    ['identity_datum_revoked_tombstone', (h) => encodeIdentityDatum(decodeIdentityDatum(h))],
    ['identity_datum_retired_tombstone', (h) => encodeIdentityDatum(decodeIdentityDatum(h))],
    ['legacy_datum', (h) => encodeLegacyDatum(decodeLegacyDatum(h))],
    ['attestation_datum_full', (h) => encodeAttestationDatum(decodeAttestationDatum(h))],
    ['attestation_datum_minimal', (h) => encodeAttestationDatum(decodeAttestationDatum(h))],
    ['delegation_datum', (h) => encodeDelegationDatum(decodeDelegationDatum(h))],
    ['vault_datum_live', (h) => encodeVaultDatum(decodeVaultDatum(h))],
    ['vault_datum_returned', (h) => encodeVaultDatum(decodeVaultDatum(h))],
    ['escrow_datum_with_refund', (h) => encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(h))],
    ['escrow_datum_without_refund', (h) => encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(h))],
    ['advert_datum', (h) => encodeIdentityAdvertDatum(decodeIdentityAdvertDatum(h))],
  ];
  for (const [name, roundTrip] of roundTrips) {
    test(name, () => assert.equal(roundTrip(cbor(name)), cbor(name)));
  }

  test('every datum fixture is covered', () => {
    const datums = Object.keys(FIXTURES).filter((n) => n.includes('datum'));
    assert.deepEqual(datums.sort(), roundTrips.map(([n]) => n).sort());
  });

  test('the full record decodes to the Part 1 Section 5 shape', () => {
    const d = decodeIdentityDatum(cbor('identity_datum_full'));
    assert.equal(d.controller.length, 64);
    assert.deepEqual(d.keys.map((k) => k.keyType), ['Ed25519', 'P256']);
    assert.ok(d.keys[1].pop !== null && d.keys[1].pop.length === 128);
    assert.ok(d.parties.length >= 1 && d.parties.every((p) => typeof p.notBefore === 'number'));
    const tombstone = decodeIdentityDatum(cbor('identity_datum_revoked_tombstone'));
    assert.equal(tombstone.status.type, 'Revoked');
  });

  test('both escrow layouts and both advert layouts are told apart by field count', () => {
    assert.equal(decodeAnyEscrowDatum(cbor('escrow_datum_with_refund')).layout, 'identity');
    assert.equal(decodeAnyAdvertDatum(cbor('advert_datum')).layout, 'identity');
    const withRefund = decodeIdentityEscrowDatum(cbor('escrow_datum_with_refund'));
    assert.ok(withRefund.refund !== null);
    assert.equal(decodeIdentityEscrowDatum(cbor('escrow_datum_without_refund')).refund, null);
    assert.ok(advertTextFieldsRoundTrip(cbor('advert_datum')));
  });
});

describe('redeemers encode to the bytes Aiken writes', () => {
  const seed = (byte: string, index: number) => ({ txHash: byte.repeat(32), outputIndex: index });
  const spends: Array<[string, IdentitySpend]> = [
    ['identity_spend_update', { type: 'Update' }],
    ['identity_spend_change_controller', { type: 'ChangeController' }],
    ['identity_spend_suspend', { type: 'Suspend', actor: { type: 'ByController' } }],
    ['identity_spend_unsuspend', { type: 'Unsuspend', author: { type: 'Script', hash: '66'.repeat(28) } }],
    ['identity_spend_revoke', { type: 'Revoke', actor: { type: 'ByParty', index: 2 } }],
    ['identity_spend_retire', { type: 'Retire' }],
    ['identity_spend_reclaim', { type: 'Reclaim' }],
    ['identity_spend_set_successor', { type: 'SetSuccessor' }],
    ['identity_spend_bump_epoch', { type: 'BumpEpoch' }],
    ['identity_spend_recover_init', { type: 'RecoverInit', guardians: [0, 3] }],
    ['identity_spend_recover_cancel', { type: 'RecoverCancel', guardians: [1] }],
    ['identity_spend_recover_finalize', { type: 'RecoverFinalize' }],
  ];
  for (const [name, value] of spends) {
    test(name, () => {
      assert.equal(encodeIdentitySpend(value), cbor(name));
      assert.deepEqual(decodeIdentitySpend(cbor(name)), value);
    });
  }

  test('identity mint: Register and Adopt', () => {
    assert.equal(encodeIdentityMint({ type: 'Register', seed: seed('f1', 24) }), cbor('identity_mint_register'));
    assert.equal(encodeIdentityMint({ type: 'Adopt', proof: ['f2'.repeat(32), 'f3'.repeat(32)] }), cbor('identity_mint_adopt'));
    assert.deepEqual(decodeIdentityMint(cbor('identity_mint_register')), { type: 'Register', seed: seed('f1', 24) });
  });

  test('attestation, delegation and vault redeemers', () => {
    assert.equal(encodeAttestationMint({ type: 'Attest', seed: seed('f4', 0) }), cbor('attestation_mint_attest'));
    assert.equal(encodeAttestationMint({ type: 'Burn' }), cbor('attestation_mint_burn'));
    assert.equal(encodeAttestationSpend({ type: 'RevokeAtt', reason: 5 }), cbor('attestation_spend_revoke_att'));
    assert.equal(encodeAttestationSpend({ type: 'Contest' }), cbor('attestation_spend_contest'));
    assert.equal(encodeAttestationSpend({ type: 'Withdraw' }), cbor('attestation_spend_withdraw'));
    assert.equal(encodeDelegationMint({ type: 'Delegate', seed: seed('f5', 300) }), cbor('delegation_mint_delegate'));
    assert.equal(encodeDelegationMint({ type: 'Undelegate' }), cbor('delegation_mint_undelegate'));
    assert.equal(encodeVaultSpend({ type: 'Pay' }), cbor('vault_spend_pay'));
    assert.equal(encodeVaultSpend({ type: 'Close' }), cbor('vault_spend_close'));
  });

  test('escrow and advert redeemers: RefundRevoked is constructor 5', () => {
    const tags = ['claim', 'submit', 'accept', 'reclaim', 'release', 'refund_revoked'];
    tags.forEach((t, i) => {
      if (t === 'submit') return;
      assert.equal(Data.to(new Constr(i, [])), cbor(`escrow_redeemer_${t}`));
    });
    assert.equal(Data.to(new Constr(1, ['d6'.repeat(32)])), cbor('escrow_redeemer_submit'));
    ['post', 'update', 'retire'].forEach((t, i) => assert.equal(Data.to(new Constr(i, [])), cbor(`advert_redeemer_${t}`)));
  });
});

describe('decoders refuse what is not the layout', () => {
  test('a record with a wrong field count, constructor, byte length or integer range', () => {
    assert.throws(() => decodeIdentityDatum(Data.to(new Constr(0, []))), /decodeIdentityDatum: record: expected 14 fields/);
    const d = Data.from(cbor('identity_datum_full')) as Constr<Data>;
    const withShortController = new Constr(0, ['ab', ...d.fields.slice(1)]);
    assert.throws(() => decodeIdentityDatum(Data.to(withShortController)), /record\.controller: expected 32 bytes/);
    const withNegativeEpoch = new Constr(0, [...d.fields.slice(0, 6), -1n, ...d.fields.slice(7)]);
    assert.throws(() => decodeIdentityDatum(Data.to(withNegativeEpoch)), /record\.subagent_epoch: integer -1 outside/);
    const withBadStatus = new Constr(0, [...d.fields.slice(0, 13), new Constr(4, [])]);
    assert.throws(() => decodeIdentityDatum(Data.to(withBadStatus)), /record\.status: unknown constructor 4/);
    assert.throws(() => decodeIdentityDatum('zz'), /expected hex/);
  });

  test('an escrow or advert with another field count', () => {
    assert.throws(() => decodeAnyEscrowDatum(Data.to(new Constr(0, [1n]))), /14 \(legacy\) or 16 \(identity\)/);
    assert.throws(() => decodeAnyAdvertDatum(Data.to(new Constr(0, [1n]))), /13 \(legacy\) or 14 \(identity\)/);
  });
});

describe('addresses, text and signers', () => {
  test('a base address goes to Plutus Data and back', () => {
    const a = plutusAddressFromBech32(OWN_ADDRESS);
    assert.equal(a.paymentCredential.type, 'VerificationKey');
    assert.equal(a.stakeCredential?.type, 'Inline');
    assert.equal(plutusAddressToBech32(plutusAddressOf(plutusAddressToData(a))), OWN_ADDRESS);
    assert.throws(() => plutusAddressFromBech32('addr1nonsense'), /not a valid address/);
  });

  test('text fields are kept as bytes; invalid UTF-8 has no text', () => {
    assert.equal(utf8Hex('é'), 'c3a9');
    assert.equal(textOf('c3a9'), 'é');
    assert.equal(textOf('ff'), null);
  });

  test('signers compare by kind and hash', () => {
    assert.ok(sameSigner({ type: 'ControllerSet' }, { type: 'ControllerSet' }));
    assert.ok(!sameSigner({ type: 'KeyHash', hash: 'aa'.repeat(28) }, { type: 'Script', hash: 'aa'.repeat(28) }));
    assert.ok(!sameSigner({ type: 'KeyHash', hash: 'aa'.repeat(28) }, { type: 'ControllerSet' }));
  });
});

describe('identity escrow lock floor', () => {
  test('is at least the legacy floor for the same terms, and at least the economic total', () => {
    const legacy = decodeIdentityEscrowDatum(cbor('escrow_datum_with_refund'));
    const economic = legacy.payment_lovelace + legacy.buyer_bond_lovelace + legacy.supplier_bond_lovelace;
    const floor = identityEscrowLockFloor({ ...legacy, state: 'Open', submitted_at: null, result_receipt_hash: null }, economic);
    const { agent_id: _a, refund: _r, ...fourteen } = legacy;
    assert.ok(floor >= economic);
    assert.ok(floor > escrowLockFloor({ ...fourteen, state: 'Open', submitted_at: null, result_receipt_hash: null }, 0n));
  });

  test('plutusDataMaxBytes bounds every encoding: never below the bytes Aiken writes', () => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      assert.ok(plutusDataMaxBytes(Data.from(f.cbor)) >= f.cbor.length / 2, name);
    }
  });
});
