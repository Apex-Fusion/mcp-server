import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { generateKey } from '../src/keygen.ts';
import { loadConfig } from '../src/config.ts';

describe('keygen', () => {
  test('produces a bech32 ed25519 key and the matching mainnet enterprise address', () => {
    const k = generateKey();
    assert.match(k.privateKeyBech32, /^ed25519_sk1/);
    assert.match(k.address, /^addr1v/);
    const sk = CML.PrivateKey.from_bech32(k.privateKeyBech32);
    assert.equal(sk.to_public().hash().to_hex(), k.pubKeyHash);
    assert.equal(CML.Address.from_bech32(k.address).payment_cred()!.as_pub_key()!.to_hex(), k.pubKeyHash);
  });

  test('the address is a mainnet enterprise address: key-hash payment credential, no stake part', () => {
    const k = generateKey();
    const addr = CML.Address.from_bech32(k.address);
    assert.equal(addr.kind(), CML.AddressKind.Enterprise);
    // Network id 1 is mainnet. Vector runs mainnet-only (keysource.ts rejects addr_test1...).
    assert.equal(addr.network_id(), 1);
    assert.equal(addr.staking_cred(), undefined);
    assert.match(k.pubKeyHash, /^[0-9a-f]{56}$/);
  });

  test('two calls give two different keys', () => {
    const a = generateKey();
    const b = generateKey();
    assert.notEqual(a.privateKeyBech32, b.privateKeyBech32);
    assert.notEqual(a.address, b.address);
    assert.notEqual(a.pubKeyHash, b.pubKeyHash);
  });

  test('the pair is accepted by the signer as VECTOR_SIGNER_PRIVATE_KEY + VECTOR_SIGNER_ADDRESS', () => {
    const k = generateKey();
    const identity = loadConfig({
      VECTOR_SIGNER_PRIVATE_KEY: k.privateKeyBech32,
      VECTOR_SIGNER_ADDRESS: k.address,
    }).keySource.load();
    assert.deepEqual(identity, { privateKeyBech32: k.privateKeyBech32, address: k.address });
  });
});
