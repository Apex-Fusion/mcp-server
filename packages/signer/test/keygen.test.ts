import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { generateKey, printKeygen } from '../src/keygen.ts';
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

  // The one-shot command exits from `done`; it must not be called before stdout has taken the text, and a failed write must reach it.
  // process.stdout.write is replaced for the length of the call only: the runner's own reports go through the same stream.
  describe('printKeygen', () => {
    type Take = (err?: Error | null) => void;
    function printed(): { chunks: string[]; take: Take | undefined; calls: Array<Error | null | undefined> } {
      const real = process.stdout.write;
      const seen: { chunks: string[]; take: Take | undefined; calls: Array<Error | null | undefined> } = { chunks: [], take: undefined, calls: [] };
      process.stdout.write = ((chunk: string, cb?: Take) => { seen.chunks.push(String(chunk)); seen.take = cb; return true; }) as typeof process.stdout.write;
      try { printKeygen((err) => seen.calls.push(err)); } finally { process.stdout.write = real; }
      return seen;
    }
    test('calls done from the callback of the write and not before: the caller exits only after stdout took the text', () => {
      const seen = printed();
      assert.equal(seen.chunks.length, 1, 'one write');
      assert.match(seen.chunks[0], /^# Paste these two lines[^\n]*\nVECTOR_SIGNER_PRIVATE_KEY=ed25519_sk1[0-9a-z]+\nVECTOR_SIGNER_ADDRESS=addr1v[0-9a-z]+\n\n# Send this address/);
      assert.deepEqual(seen.calls, [], 'the write has not completed, so done has not been called');
      seen.take!(null);
      assert.deepEqual(seen.calls, [null]);
    });
    test('a write that failed reaches done with its error, so the command can exit non-zero', () => {
      const seen = printed();
      const failure = new Error('EPIPE');
      seen.take!(failure);
      assert.deepEqual(seen.calls, [failure]);
    });
    test('needs no callback: done is optional', () => {
      const real = process.stdout.write;
      let taken: unknown;
      process.stdout.write = ((chunk: string, cb?: Take) => { taken = chunk; cb?.(null); return true; }) as typeof process.stdout.write;
      try { printKeygen(); } finally { process.stdout.write = real; }
      assert.equal(typeof taken, 'string');
    });
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
