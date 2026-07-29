import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { MnemonicKeySource } from '../src/keysource.ts';

// Throwaway test mnemonic, shared with keysource.test.ts and sign.test.ts.
// Controls no funds. Never use outside tests.
const TEST_MNEMONIC =
  'test walk nut penalty hip pave soap entry language right filter choice';

function envWithMnemonic(accountIndex?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { VECTOR_SIGNER_MNEMONIC: TEST_MNEMONIC };
  if (accountIndex !== undefined) env.VECTOR_SIGNER_ACCOUNT_INDEX = accountIndex;
  return env;
}

// VECTOR_SIGNER_ACCOUNT_INDEX used to go straight into `Number(...)` with no
// validation anywhere downstream. Number() returns NaN for garbage input
// rather than throwing; MnemonicKeySource's constructor takes accountIndex
// on faith (its own validation is about the mnemonic, not this argument);
// and CML's HD derivation (walletFromSeed) does not throw on a NaN,
// negative, or fractional index either — it just walks a different branch
// of the tree. Verified directly against the real walletFromSeed before
// this fix (see the task report): a NaN-producing string, a negative
// integer, and a fractional value each derived a DIFFERENT, syntactically
// valid addr1... address, with no error anywhere in the chain — the
// "confident wrong answer" shape, not a crash. describe() would even echo
// the nonsense value back as if nothing were wrong (e.g. "mnemonic (account
// index NaN)"). These tests pin the fix: anything that is not a
// non-negative integer must throw, loudly, naming both the variable and the
// offending value.
describe('loadConfig — VECTOR_SIGNER_ACCOUNT_INDEX validation', () => {
  test('a non-numeric value (Number(...) produces NaN) is rejected, not silently treated as account 0', () => {
    assert.throws(
      () => loadConfig(envWithMnemonic('not-a-number')),
      /VECTOR_SIGNER_ACCOUNT_INDEX.*not-a-number/
    );
  });

  test('a negative integer is rejected', () => {
    assert.throws(() => loadConfig(envWithMnemonic('-1')), /VECTOR_SIGNER_ACCOUNT_INDEX.*-1/);
  });

  test('a fractional value is rejected', () => {
    assert.throws(() => loadConfig(envWithMnemonic('1.5')), /VECTOR_SIGNER_ACCOUNT_INDEX.*1\.5/);
  });

  test('a valid non-negative integer is accepted and derives the SAME wallet as constructing MnemonicKeySource directly', () => {
    // Not just "does not throw" — confirms the validated value actually
    // reaches derivation unchanged, by cross-checking against an
    // independently constructed MnemonicKeySource for the same index.
    const viaConfig = loadConfig(envWithMnemonic('2')).keySource.load();
    const direct = new MnemonicKeySource(TEST_MNEMONIC, 2).load();
    assert.equal(viaConfig.address, direct.address);
    assert.equal(viaConfig.privateKeyBech32, direct.privateKeyBech32);
  });

  test('an unset VECTOR_SIGNER_ACCOUNT_INDEX still defaults to account 0, unaffected by the new validation', () => {
    const viaConfig = loadConfig(envWithMnemonic()).keySource.load();
    const direct = new MnemonicKeySource(TEST_MNEMONIC, 0).load();
    assert.equal(viaConfig.address, direct.address);
  });

  test('a garbage VECTOR_SIGNER_ACCOUNT_INDEX does not block a PRIVATE_KEY-configured signer, since that path never reads it', () => {
    // parseAccountIndex() is only called from the two MnemonicKeySource
    // branches, not unconditionally at the top of resolveKeySource — a
    // leftover/mistyped VECTOR_SIGNER_ACCOUNT_INDEX in the environment must
    // not newly block startup for a config that never uses it.
    const derived = new MnemonicKeySource(TEST_MNEMONIC).load();
    const env: NodeJS.ProcessEnv = {
      VECTOR_SIGNER_PRIVATE_KEY: derived.privateKeyBech32,
      VECTOR_SIGNER_ADDRESS: derived.address,
      VECTOR_SIGNER_ACCOUNT_INDEX: 'not-a-number',
    };
    assert.doesNotThrow(() => loadConfig(env));
  });
});
