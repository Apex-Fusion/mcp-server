import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { signTransaction } from '../src/sign.ts';
import { MnemonicKeySource } from '../src/keysource.ts';
import { decodeTransaction } from '../src/decode.ts';
// /tx is an explicitly allowed pure subpath (boundary.test.ts's own
// ALLOWLIST — /tx and /types are pure, /provider is network-capable). Used
// below to build the exact same indefinite-length CBOR constructor shape
// deriveNftAssetName() builds, via the same helper functions, rather than a
// hand-rolled reimplementation that could subtly diverge from the real
// encoding this ecosystem actually produces. Test-only import — sign.ts
// itself imports nothing beyond CML.
import { cborBytes, cborUint } from '@apexfusion/vector-mcp-shared/tx';

const TEST_MNEMONIC =
  'test walk nut penalty hip pave soap entry language right filter choice';

const FIXTURE_CBOR =
  '84a300d9010281825820e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c3200018282581d71ab1aad52c4774e5da9f2c0fa1a4d07220a0bdd57ee3dce9be860dac61a002dc6c0825839013fd872a48d71872cf76528bb41dd2a5775e2c532c21662a47c6cebf44b6be5f33456f28523ed04d1aaad158541176425378d8ed8fce53f881a3b6a7221021a0002911fa0f5f6';

const KEY = new MnemonicKeySource(TEST_MNEMONIC).load().privateKeyBech32;

describe('signTransaction', () => {
  test('attaches exactly one vkey witness', () => {
    const { signedCborHex } = signTransaction(FIXTURE_CBOR, KEY);
    const ws = CML.Transaction.from_cbor_hex(signedCborHex).witness_set().vkeywitnesses();
    assert.ok(ws);
    assert.equal(ws!.len(), 1);
  });

  test('does not alter the transaction body — hash is unchanged', () => {
    const { signedCborHex, txHashHex } = signTransaction(FIXTURE_CBOR, KEY);
    assert.equal(txHashHex, decodeTransaction(FIXTURE_CBOR).txHashHex, 'signing must not change the body');
    assert.equal(decodeTransaction(signedCborHex).txHashHex, txHashHex);
  });

  test('the signature verifies against the signing public key', () => {
    const { signedCborHex, txHashHex } = signTransaction(FIXTURE_CBOR, KEY);
    const w = CML.Transaction.from_cbor_hex(signedCborHex).witness_set().vkeywitnesses()!.get(0);
    const hashBytes = CML.TransactionHash.from_hex(txHashHex).to_raw_bytes();
    assert.equal(w.vkey().verify(hashBytes, w.ed25519_signature()), true);
  });

  test('output is longer than input — witnesses were added', () => {
    const { signedCborHex } = signTransaction(FIXTURE_CBOR, KEY);
    assert.ok(signedCborHex.length > FIXTURE_CBOR.length);
  });

  test('signing is deterministic for the same key and transaction', () => {
    assert.equal(
      signTransaction(FIXTURE_CBOR, KEY).signedCborHex,
      signTransaction(FIXTURE_CBOR, KEY).signedCborHex
    );
  });

  test('rejects undecodable CBOR rather than producing garbage', () => {
    assert.throws(() => signTransaction('not-hex', KEY), /could not be decoded/i);
  });

  test('rejects an invalid private key', () => {
    assert.throws(() => signTransaction(FIXTURE_CBOR, 'nonsense'), /private key/i);
  });
});

// --- Edge-case pass (beyond the brief) --------------------------------------
//
// The brief's 7 tests are a floor. sign.ts calls CML.Transaction.from_cbor_hex
// independently of decode.ts — it does not automatically inherit decode.ts's
// trailing-bytes consumption guard just because that module happens to have
// one. Checked directly, not assumed.
describe('unconsumed input (trailing bytes) — sign.ts decodes independently of decode.ts', () => {
  // CML's from_cbor_hex only requires that a *prefix* of the input parse as a
  // valid transaction — decode.ts's own history (commit 5da4447) documents
  // this exact gap and fixes it with a re-serialise consumption check. sign.ts
  // is a SEPARATE call site that does not inherit that fix automatically.
  // Reproduced empirically before writing this test (see the task report):
  // against the brief's unmodified implementation, signing
  // FIXTURE_CBOR + 'deadbeef' did NOT throw — it silently signed the 156-byte
  // prefix and returned a confident, fully-formed result, with the appended
  // 4 bytes dropped and no indication anything was wrong. That is precisely
  // the failure this task warned about: the caller asked to sign one set of
  // bytes and, with no error, received a signature over a DIFFERENT
  // (shorter) set of bytes than it supplied.
  test('rejects a transaction with trailing bytes appended, rather than silently signing a shorter prefix', () => {
    assert.throws(() => signTransaction(FIXTURE_CBOR + 'deadbeef', KEY), /could not be decoded/i);
  });

  test('still accepts the clean fixture (no false positive on legitimate input)', () => {
    assert.doesNotThrow(() => signTransaction(FIXTURE_CBOR, KEY));
  });

  test('a single self-valid trailing byte is still caught, not just multi-byte garbage', () => {
    // Mirrors decode.test.ts's own strongest version of this check: even one
    // extra byte that would itself decode as something (rather than obvious
    // noise) must not slip through.
    assert.throws(() => signTransaction(FIXTURE_CBOR + '00', KEY), /could not be decoded/i);
  });

  // The consumption check compares tx.to_cbor_hex() against unsignedCborHex
  // case-INSENSITIVELY, specifically because CML re-serialises hex as
  // lowercase regardless of the input's casing — a strict comparison would
  // reject perfectly legitimate uppercase-hex input as a false positive
  // "trailing data" mismatch. Notably, decode.ts's OWN test suite documents
  // this reasoning in a comment but never actually pins it with a test — this
  // closes that same gap here, verified empirically first (see the task
  // report) rather than assumed safe by analogy.
  test('an uppercase-hex rendering of the same clean transaction is still accepted (no false positive from the case-insensitive consumption check)', () => {
    const result = signTransaction(FIXTURE_CBOR.toUpperCase(), KEY);
    assert.equal(result.txHashHex, decodeTransaction(FIXTURE_CBOR).txHashHex);
  });
});

describe('indefinite-length CBOR — the agent registry\'s D8 79 9F … FF constructor encoding', () => {
  // packages/shared/src/tx.ts's deriveNftAssetName() documents that the
  // agent registry's Conway-era Aiken validators require INDEFINITE-length
  // CBOR for a Plutus constructor's field array (D8 79 9F … FF) — Lucid's
  // Data.to instead emits definite-length arrays (D8 79 82 …), which those
  // validators reject. Both sign.ts's consumption check (above) and
  // decode.ts's equivalent assert in a comment that CML's parse-then-
  // reserialise round trip preserves this exact encoding rather than
  // silently canonicalising it to definite-length — which matters because if
  // it did NOT, the consumption check would misread that harmless
  // re-encoding as "unrecognised trailing data" and refuse to sign every
  // transaction using this ecosystem's own real encoding. That claim was
  // asserted only in prose until now; this fixture makes it an executable,
  // permanent check. (decode.ts's own test suite has the exact same untested
  // gap — out of scope for this task's file boundary; flagged in the report
  // for a later task to close.)
  //
  // Built using the SAME helper functions (cborBytes, cborUint) that
  // packages/shared/src/tx.ts's deriveNftAssetName() itself uses to build its
  // OutputReference constructor, for maximum fidelity to the real encoding.
  function indefiniteLengthConstructor(): Buffer {
    // Same shape as deriveNftAssetName's outRefCbor: tag 121 (Plutus
    // constructor index 0), indefinite-length array open, one bytestring
    // field (reusing FIXTURE_CBOR's own input tx hash, so this is a
    // realistic 32-byte field rather than arbitrary filler), one small uint
    // field, indefinite-length array close.
    const someHash32 = 'e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c3';
    return Buffer.concat([
      Buffer.from([0xd8, 0x79, 0x9f]),
      cborBytes(someHash32),
      cborUint(0n),
      Buffer.from([0xff]),
    ]);
  }

  test('sanity: the hand-rolled bytes are actually the D8 79 9F … FF shape under test', () => {
    const hex = indefiniteLengthConstructor().toString('hex');
    assert.ok(hex.startsWith('d8799f'), 'must open with tag 121 + indefinite-length array');
    assert.ok(hex.endsWith('ff'), 'must close with the indefinite-length-array break byte');
  });

  describe('embedded in the transaction BODY (an inline datum on an output)', () => {
    // Body-embedded specifically because this is the placement where the
    // encoding actually participates in the body hash: if CML's round trip
    // ever DID mangle this encoding, this is the fixture that would show up
    // as a changed hash, not just a rejected consumption check.
    function fixtureWithBodyEmbeddedDatum(): string {
      const unsigned = CML.Transaction.from_cbor_hex(FIXTURE_CBOR);
      const body = unsigned.body();
      const datum = CML.PlutusData.from_cbor_hex(indefiniteLengthConstructor().toString('hex'));
      const existingOutput = body.outputs().get(0);
      const outputWithDatum = CML.TransactionOutput.new(
        existingOutput.address(),
        existingOutput.amount(),
        CML.DatumOption.new_datum(datum),
        undefined
      );
      const outputs = CML.TransactionOutputList.new();
      outputs.add(outputWithDatum);
      const newBody = CML.TransactionBody.new(body.inputs(), outputs, body.fee());
      const tx = CML.Transaction.new(newBody, CML.TransactionWitnessSet.new(), true, undefined);
      return tx.to_cbor_hex();
    }

    test('signTransaction accepts it — no false-positive "unrecognised trailing data" rejection', () => {
      const cborHex = fixtureWithBodyEmbeddedDatum();
      assert.doesNotThrow(() => signTransaction(cborHex, KEY));
    });

    test('the body hash is unchanged by signing', () => {
      const cborHex = fixtureWithBodyEmbeddedDatum();
      const { txHashHex } = signTransaction(cborHex, KEY);
      const independentHash = CML.hash_transaction(CML.Transaction.from_cbor_hex(cborHex).body()).to_hex();
      assert.equal(txHashHex, independentHash);
    });

    test('the indefinite-length datum itself survives signing byte-for-byte, not just the surrounding transaction', () => {
      const cborHex = fixtureWithBodyEmbeddedDatum();
      const { signedCborHex } = signTransaction(cborHex, KEY);
      const survivingDatum = CML.Transaction.from_cbor_hex(signedCborHex).body().outputs().get(0).datum()!.as_datum()!;
      assert.equal(survivingDatum.to_cbor_hex(), indefiniteLengthConstructor().toString('hex'));
    });
  });

  describe('embedded in the WITNESS SET (a plutus_datums entry)', () => {
    // The other placement the coordinator's reviewer independently checked.
    // Unlike the body-embedded case, the body hash can never be affected
    // here (plutus_datums lives on TransactionWitnessSet, not
    // TransactionBody) — this fixture instead exercises the OTHER risk: the
    // consumption check compares the WHOLE transaction's re-serialised CBOR,
    // witness set included, so a mangled round trip here would still cause a
    // false-positive rejection even though it could never show up as a
    // changed hash.
    function fixtureWithWitnessEmbeddedDatum(): string {
      const unsigned = CML.Transaction.from_cbor_hex(FIXTURE_CBOR);
      const body = unsigned.body();
      const datum = CML.PlutusData.from_cbor_hex(indefiniteLengthConstructor().toString('hex'));
      const witnessSet = CML.TransactionWitnessSet.new();
      const datums = CML.PlutusDataList.new();
      datums.add(datum);
      witnessSet.set_plutus_datums(datums);
      const tx = CML.Transaction.new(body, witnessSet, true, undefined);
      return tx.to_cbor_hex();
    }

    test('signTransaction accepts it — no false-positive "unrecognised trailing data" rejection', () => {
      const cborHex = fixtureWithWitnessEmbeddedDatum();
      assert.doesNotThrow(() => signTransaction(cborHex, KEY));
    });

    test('the body hash is unchanged (same body as FIXTURE_CBOR — only the witness set differs)', () => {
      const cborHex = fixtureWithWitnessEmbeddedDatum();
      const { txHashHex } = signTransaction(cborHex, KEY);
      assert.equal(txHashHex, decodeTransaction(FIXTURE_CBOR).txHashHex);
    });
  });
});

// A second, independent signing identity — a different account index derives
// a different key pair from the same throwaway mnemonic (already proven
// distinct in keysource.test.ts: "a different account index yields a
// different address"). Used below wherever a test needs two DIFFERENT keys.
const KEY_2 = new MnemonicKeySource(TEST_MNEMONIC, 1).load().privateKeyBech32;

/**
 * Builds a variant of FIXTURE_CBOR that already carries one vkey witness from
 * a throwaway, unrelated key — the same fixture shape decode.test.ts's own
 * "still accepts a signed transaction" test uses. Returns the CBOR plus the
 * pre-existing witness's public key (bech32) and raw signature bytes, so a
 * test can confirm that EXACT witness — not merely "some" witness — survives.
 */
function fixtureWithOneWitness(): {
  cborHex: string;
  existingVkeyBech32: string;
  existingSignatureHex: string;
} {
  const unsigned = CML.Transaction.from_cbor_hex(FIXTURE_CBOR);
  const body = unsigned.body();
  const hash = CML.hash_transaction(body);
  const preexistingKey = CML.PrivateKey.generate_ed25519();
  const signature = preexistingKey.sign(hash.to_raw_bytes());

  const vkeywitnesses = CML.VkeywitnessList.new();
  vkeywitnesses.add(CML.Vkeywitness.new(preexistingKey.to_public(), signature));
  const witnessSet = CML.TransactionWitnessSet.new();
  witnessSet.set_vkeywitnesses(vkeywitnesses);

  const withWitness = CML.Transaction.new(body, witnessSet, true, undefined);
  return {
    cborHex: withWitness.to_cbor_hex(),
    existingVkeyBech32: preexistingKey.to_public().to_bech32(),
    existingSignatureHex: Buffer.from(signature.to_raw_bytes()).toString('hex'),
  };
}

describe('signing a transaction that already carries a vkey witness', () => {
  // The brief's implementation copies existing witnesses into a fresh
  // VkeywitnessList before appending the new one. This is the test that
  // actually exercises that copy step — nothing in the brief's own 7 tests
  // ever signs a transaction that already has a witness, so a version that
  // dropped the copy (built the new list containing ONLY the freshly-added
  // witness) would satisfy every brief test while silently discarding any
  // other signer's contribution — fatal for anything requiring more than one
  // signature. Verified below (mutation) that this test does in fact catch
  // that exact regression.
  test('the pre-existing witness survives, and the new one is appended rather than replacing it', () => {
    const { cborHex, existingVkeyBech32, existingSignatureHex } = fixtureWithOneWitness();
    const { signedCborHex, txHashHex } = signTransaction(cborHex, KEY);

    const ws = CML.Transaction.from_cbor_hex(signedCborHex).witness_set().vkeywitnesses();
    assert.ok(ws);
    assert.equal(ws!.len(), 2, 'expected the pre-existing witness PLUS the newly added one, not one replacing the other');

    const witnesses = [ws!.get(0), ws!.get(1)];
    const vkeyBech32s = witnesses.map((w) => w.vkey().to_bech32());
    const signatureHexes = witnesses.map((w) => Buffer.from(w.ed25519_signature().to_raw_bytes()).toString('hex'));

    assert.ok(vkeyBech32s.includes(existingVkeyBech32), 'the pre-existing witness public key must still be present');
    assert.ok(
      signatureHexes.includes(existingSignatureHex),
      'the pre-existing witness signature bytes must be byte-for-byte unchanged, not merely a witness for the same key'
    );

    const newSignerVkeyBech32 = CML.PrivateKey.from_bech32(KEY).to_public().to_bech32();
    assert.ok(vkeyBech32s.includes(newSignerVkeyBech32), 'the newly added witness must also be present');

    // Both witnesses must independently verify against the (unchanged) tx hash.
    const hashBytes = CML.TransactionHash.from_hex(txHashHex).to_raw_bytes();
    for (const w of witnesses) {
      assert.equal(w.vkey().verify(hashBytes, w.ed25519_signature()), true);
    }
  });

  test('signing a witnessed transaction still does not alter the body — hash matches the pre-witnessed fixture', () => {
    const { cborHex } = fixtureWithOneWitness();
    const { txHashHex } = signTransaction(cborHex, KEY);
    // Same underlying body as FIXTURE_CBOR (only the witness set differs), so
    // the hash must match the plain fixture's hash too.
    assert.equal(txHashHex, decodeTransaction(FIXTURE_CBOR).txHashHex);
  });
});

describe('signing with two different keys', () => {
  test('produces two distinct witnesses when applied one after the other, and both verify', () => {
    const firstPass = signTransaction(FIXTURE_CBOR, KEY);
    const secondPass = signTransaction(firstPass.signedCborHex, KEY_2);

    const ws = CML.Transaction.from_cbor_hex(secondPass.signedCborHex).witness_set().vkeywitnesses();
    assert.ok(ws);
    assert.equal(ws!.len(), 2, 'both signatures must be present — the second call must not replace the first');

    const witnesses = [ws!.get(0), ws!.get(1)];
    const vkeyBech32s = witnesses.map((w) => w.vkey().to_bech32());
    assert.notEqual(vkeyBech32s[0], vkeyBech32s[1], 'the two witnesses must be for two DIFFERENT public keys');

    const signatureHexes = witnesses.map((w) => Buffer.from(w.ed25519_signature().to_raw_bytes()).toString('hex'));
    assert.notEqual(signatureHexes[0], signatureHexes[1], 'the two witnesses must carry two DIFFERENT signatures');

    const hashBytes = CML.TransactionHash.from_hex(secondPass.txHashHex).to_raw_bytes();
    for (const w of witnesses) {
      assert.equal(w.vkey().verify(hashBytes, w.ed25519_signature()), true, 'every witness must independently verify');
    }

    // Neither key's public key can verify the OTHER key's signature — confirms
    // the two witnesses are not accidentally duplicates of one another.
    assert.equal(witnesses[0].vkey().verify(hashBytes, witnesses[1].ed25519_signature()), false);
    assert.equal(witnesses[1].vkey().verify(hashBytes, witnesses[0].ed25519_signature()), false);
  });

  test('signing the SAME transaction independently (not chained) with two different keys yields two different single-witness results', () => {
    const signedByKey1 = signTransaction(FIXTURE_CBOR, KEY);
    const signedByKey2 = signTransaction(FIXTURE_CBOR, KEY_2);
    assert.notEqual(signedByKey1.signedCborHex, signedByKey2.signedCborHex);
    // Both still sign the exact same, unaltered body.
    assert.equal(signedByKey1.txHashHex, signedByKey2.txHashHex);
  });
});

describe('signing is deterministic — strengthened beyond the brief\'s single check', () => {
  // The brief's own determinism test only compares the whole signedCborHex
  // string across two calls using the SAME already-loaded KEY constant. This
  // strengthens it two ways: (a) asserts on the witness's raw signature bytes
  // specifically, the property that actually matters (ed25519 is a
  // deterministic signature scheme per RFC 8032 — no random nonce, so the
  // same key signing the same message must always produce the same
  // signature), and (b) re-derives the key from the mnemonic a SECOND time
  // (a fresh MnemonicKeySource / fresh load()) rather than reusing the one
  // in-memory KEY constant, so a hypothetical bug that made determinism
  // depend on JS object identity rather than the key's actual bytes would be
  // caught.
  test('two independently re-derived instances of the same key produce byte-identical signatures', () => {
    const rederivedKey = new MnemonicKeySource(TEST_MNEMONIC).load().privateKeyBech32;
    assert.equal(rederivedKey, KEY, 'sanity check: re-derivation must reproduce the same key bech32');

    const a = signTransaction(FIXTURE_CBOR, KEY);
    const b = signTransaction(FIXTURE_CBOR, rederivedKey);

    const wa = CML.Transaction.from_cbor_hex(a.signedCborHex).witness_set().vkeywitnesses()!.get(0);
    const wb = CML.Transaction.from_cbor_hex(b.signedCborHex).witness_set().vkeywitnesses()!.get(0);
    assert.equal(
      Buffer.from(wa.ed25519_signature().to_raw_bytes()).toString('hex'),
      Buffer.from(wb.ed25519_signature().to_raw_bytes()).toString('hex')
    );
    assert.equal(a.signedCborHex, b.signedCborHex);
  });
});

describe('a transaction carrying auxiliary data / metadata', () => {
  // Builds a variant of FIXTURE_CBOR with a real AuxiliaryData (metadata)
  // section attached to the transaction, the same way the brief's own
  // implementation passes `tx.auxiliary_data()` through into the reconstructed
  // signed Transaction. Confirms that plumbing actually works end to end,
  // rather than trusting the pass-through argument is wired correctly.
  function fixtureWithMetadata(): { cborHex: string; auxDataCborHex: string } {
    const unsigned = CML.Transaction.from_cbor_hex(FIXTURE_CBOR);
    const body = unsigned.body();

    const metadata = CML.Metadata.new();
    metadata.set(674n, CML.TransactionMetadatum.new_text('sign.ts edge-case pass'));
    const auxData = CML.AuxiliaryData.new();
    auxData.add_metadata(metadata);
    // Captured BEFORE auxData is passed into Transaction.new() below.
    // wasm-bindgen gives Transaction.new() ownership of its AuxiliaryData
    // argument (Rust move semantics leaking through the WASM boundary):
    // reusing `auxData` itself after this call throws "null pointer passed
    // to rust" (confirmed empirically — see the task report). This is a
    // property of CML's bindings, not of sign.ts, which never reuses a
    // getter-returned object after handing it to `.new()` for exactly this
    // reason. A caller of THIS fixture function only ever sees the CBOR
    // string, so it is unaffected either way.
    const auxDataCborHex = auxData.to_cbor_hex();

    const withAux = CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true, auxData);
    return { cborHex: withAux.to_cbor_hex(), auxDataCborHex };
  }

  test('auxiliary data survives signing byte-for-byte', () => {
    const { cborHex, auxDataCborHex } = fixtureWithMetadata();
    const { signedCborHex } = signTransaction(cborHex, KEY);

    const signedTx = CML.Transaction.from_cbor_hex(signedCborHex);
    const survivingAuxData = signedTx.auxiliary_data();
    assert.ok(survivingAuxData, 'auxiliary data must not be dropped when a witness is added');
    assert.equal(survivingAuxData!.to_cbor_hex(), auxDataCborHex);

    // Content-level check too, not just byte-equality of the CBOR blob.
    const label = survivingAuxData!.metadata()!.get(674n);
    assert.ok(label);
    assert.equal(label!.as_text(), 'sign.ts edge-case pass');
  });

  test('the body hash is unchanged by the presence of auxiliary data', () => {
    const { cborHex } = fixtureWithMetadata();
    const { txHashHex } = signTransaction(cborHex, KEY);
    // Same body as FIXTURE_CBOR — aux data lives alongside the body, not
    // inside it, so the hash must be identical to the plain fixture's.
    assert.equal(txHashHex, decodeTransaction(FIXTURE_CBOR).txHashHex);
  });

  test('the witness itself still verifies against the unchanged hash when auxiliary data is present', () => {
    const { cborHex } = fixtureWithMetadata();
    const { signedCborHex, txHashHex } = signTransaction(cborHex, KEY);
    const w = CML.Transaction.from_cbor_hex(signedCborHex).witness_set().vkeywitnesses()!.get(0);
    const hashBytes = CML.TransactionHash.from_hex(txHashHex).to_raw_bytes();
    assert.equal(w.vkey().verify(hashBytes, w.ed25519_signature()), true);
  });
});

describe('the is_valid flag is threaded through, not hardcoded', () => {
  // is_valid lives on CML.Transaction itself, not on TransactionBody — so it
  // is INVISIBLE to every hash-equality check elsewhere in this file
  // (hash_transaction only ever hashes the body). A version of sign.ts that
  // hardcodes Transaction.new(body, witnessSet, true, ...) regardless of the
  // INPUT transaction's own is_valid() would satisfy every other test in
  // this file, including "does not alter the transaction body — hash is
  // unchanged", because FIXTURE_CBOR's own is_valid happens to already be
  // true. Confirmed by mutation (see the task report): flipping the
  // hardcoded literal from true to false still passed all 21 pre-existing
  // tests, with zero failures.
  //
  // is_valid: false is Cardano's collateral-forfeit encoding: a node sets it
  // when a script transaction is included specifically to consume collateral
  // after a phase-2 validation failure. If the signer silently rewrote this
  // to true, a node re-executing phase 2 would find the claimed validity
  // mismatched and reject the transaction outright — the signer would have
  // silently rewritten a field of the transaction it was asked to sign.
  //
  // Confirmed directly (throwaway probe, see the task report) that CML can
  // construct, serialise, and correctly round-trip an is_valid: false
  // Transaction before relying on that here.
  function fixtureWithIsValid(isValid: boolean): string {
    const unsigned = CML.Transaction.from_cbor_hex(FIXTURE_CBOR);
    const tx = CML.Transaction.new(unsigned.body(), unsigned.witness_set(), isValid, undefined);
    return tx.to_cbor_hex();
  }

  test('an is_valid: false transaction is signed with is_valid still false, not silently flipped to true', () => {
    const cborHex = fixtureWithIsValid(false);
    const { signedCborHex } = signTransaction(cborHex, KEY);
    const signedTx = CML.Transaction.from_cbor_hex(signedCborHex);
    assert.equal(signedTx.is_valid(), false);
  });

  test('an is_valid: true transaction is signed with is_valid still true (pinned explicitly, not just incidentally true because the default fixture happens to be)', () => {
    const cborHex = fixtureWithIsValid(true);
    const { signedCborHex } = signTransaction(cborHex, KEY);
    const signedTx = CML.Transaction.from_cbor_hex(signedCborHex);
    assert.equal(signedTx.is_valid(), true);
  });

  test('is_valid: false does not affect the body hash — is_valid lives on Transaction, not TransactionBody', () => {
    const cborHex = fixtureWithIsValid(false);
    const { txHashHex } = signTransaction(cborHex, KEY);
    assert.equal(txHashHex, decodeTransaction(FIXTURE_CBOR).txHashHex);
  });
});

describe('key material is never emitted', () => {
  // Task 5's keysource.ts had to fix an actual leak (TypeScript `private` is
  // compile-time only). sign.ts never holds a KeySource instance and never
  // constructs a class at all — privateKeyBech32 is a plain function
  // parameter — but the discipline from that task (verify by execution, not
  // by reading the code and assuming) is applied here too: every throw site
  // in sign.ts is checked directly against the actual rejected key value.
  test('an invalid private key value never appears in the thrown error message', () => {
    const rejected = 'this-key-value-must-never-appear-in-the-thrown-message';
    try {
      signTransaction(FIXTURE_CBOR, rejected);
      assert.fail('expected signTransaction to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(rejected));
    }
  });

  test('a VALID private key never appears in any thrown error message either (decode failure path)', () => {
    // Distinct code path from the test above: here the KEY is well-formed
    // and never even reaches PrivateKey.from_bech32, because the CBOR is
    // rejected first. Confirms the decode-failure branch's error message
    // (built from CML's own err.message, not from any local variable) cannot
    // somehow embed the key argument either.
    try {
      signTransaction('not-hex', KEY);
      assert.fail('expected signTransaction to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(KEY));
    }
  });
});
