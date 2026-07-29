import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { MnemonicKeySource, PrivateKeyKeySource } from '../src/keysource.ts';

// Throwaway test mnemonic. Controls no funds. Never use outside tests.
const TEST_MNEMONIC =
  'test walk nut penalty hip pave soap entry language right filter choice';

// A second throwaway fixture at the OTHER end of BIP39's valid word-count
// range (24, vs TEST_MNEMONIC's 12). Every other test in this file only ever
// exercises a 12-word mnemonic, which leaves VALID_WORD_COUNTS's other four
// entries (15, 18, 21, 24) completely unexercised as *accepted* input — a
// mutation dropping all of them but 12 would pass every other test in this
// file. Deterministically generated from fixed, obviously-fake entropy
// (bytes 0x00..0x1f) rather than randomly, so it is reproducible from that
// description alone. Controls no funds. Never use outside tests.
const TEST_MNEMONIC_24 =
  'abandon amount liar amount expire adjust cage candy arch gather drum bullet absurd math era live bid rhythm alien crouch range attend journey unaware';

describe('MnemonicKeySource', () => {
  test('derives a bech32 private key and an addr1 address', () => {
    const id = new MnemonicKeySource(TEST_MNEMONIC).load();
    assert.match(id.privateKeyBech32, /^ed25519e?_sk1/);
    assert.match(id.address, /^addr1/);
  });

  test('derivation is deterministic', () => {
    const a = new MnemonicKeySource(TEST_MNEMONIC).load();
    const b = new MnemonicKeySource(TEST_MNEMONIC).load();
    assert.equal(a.address, b.address);
    assert.equal(a.privateKeyBech32, b.privateKeyBech32);
  });

  test('a different account index yields a different address', () => {
    const a = new MnemonicKeySource(TEST_MNEMONIC, 0).load();
    const b = new MnemonicKeySource(TEST_MNEMONIC, 1).load();
    assert.notEqual(a.address, b.address);
  });

  test('tolerates surrounding whitespace and irregular spacing', () => {
    const messy = `  ${TEST_MNEMONIC.split(' ').join('   ')}  \n`;
    assert.equal(new MnemonicKeySource(messy).load().address, new MnemonicKeySource(TEST_MNEMONIC).load().address);
  });

  test('rejects a wrong word count', () => {
    assert.throws(() => new MnemonicKeySource('one two three'), /12, 15, 18, 21 or 24 words/);
  });

  test('describe() never reveals the mnemonic', () => {
    const d = new MnemonicKeySource(TEST_MNEMONIC).describe();
    assert.ok(!d.includes('walk'), 'describe() must not leak key material');
    assert.match(d, /mnemonic/i);
  });
});

describe('PrivateKeyKeySource', () => {
  test('returns the key and address it was constructed with', () => {
    const derived = new MnemonicKeySource(TEST_MNEMONIC).load();
    const id = new PrivateKeyKeySource(derived.privateKeyBech32, derived.address).load();
    assert.equal(id.privateKeyBech32, derived.privateKeyBech32);
    assert.equal(id.address, derived.address);
  });

  test('rejects a key that is not bech32 ed25519', () => {
    assert.throws(() => new PrivateKeyKeySource('nonsense', 'addr1abc'), /private key/i);
  });

  test('rejects an address that is not addr1', () => {
    const derived = new MnemonicKeySource(TEST_MNEMONIC).load();
    assert.throws(() => new PrivateKeyKeySource(derived.privateKeyBech32, 'nope'), /address/i);
  });

  test('describe() never reveals the key', () => {
    const derived = new MnemonicKeySource(TEST_MNEMONIC).load();
    const d = new PrivateKeyKeySource(derived.privateKeyBech32, derived.address).describe();
    assert.ok(!d.includes(derived.privateKeyBech32), 'describe() must not leak key material');
  });
});

// --- Edge-case pass (beyond the brief) --------------------------------------
//
// The brief's 10 tests are a floor. Everything below hunts specifically for
// the failure shape the last three tasks each shipped once: a defect that
// produces a plausible-looking success instead of an error. For this module
// that means: does any input ever derive a WRONG BUT VALID-LOOKING address or
// key, rather than either the correct one or a loud failure?

describe('MnemonicKeySource — case is not part of BIP39, so normalising it must be safe', () => {
  // bip39's wordlist lookup (`wordlist.indexOf(word)`) is exact and
  // case-sensitive — confirmed directly against this workspace's installed
  // bip39 before writing this fix: an uppercase or mixed-case rendering of
  // TEST_MNEMONIC throws 'Invalid mnemonic' with NO normalisation applied.
  // That is a safe failure (loud, no derivation) but an unhelpful one, since
  // casing carries no BIP39 meaning — a word is identified purely by which of
  // the 2048 fixed wordlist entries it matches, never by how it happens to be
  // capitalised, so no two distinct valid mnemonics differ only by case.
  // Lowercasing before derivation therefore cannot make this module derive a
  // DIFFERENT wallet than the one the correctly-cased mnemonic would — pinned
  // below as deriving the SAME address, not merely "some" address.
  const CANONICAL = new MnemonicKeySource(TEST_MNEMONIC).load();

  test('an uppercase mnemonic derives the identical address and key as the canonical lowercase form', () => {
    const upper = new MnemonicKeySource(TEST_MNEMONIC.toUpperCase()).load();
    assert.equal(upper.address, CANONICAL.address);
    assert.equal(upper.privateKeyBech32, CANONICAL.privateKeyBech32);
  });

  test('a mixed-case mnemonic derives the identical address and key as the canonical lowercase form', () => {
    const mixedWords = TEST_MNEMONIC.split(' ').map((w, i) => (i % 2 === 0 ? w.toUpperCase() : w));
    const mixed = new MnemonicKeySource(mixedWords.join(' ')).load();
    assert.equal(mixed.address, CANONICAL.address);
    assert.equal(mixed.privateKeyBech32, CANONICAL.privateKeyBech32);
  });
});

describe('MnemonicKeySource — a wrong-but-plausible mnemonic', () => {
  // Right word count (12), every word individually present in the BIP39
  // wordlist, but the checksum encoded in the final word's spare bits does
  // not match the entropy in the first eleven words. Constructed by
  // replacing TEST_MNEMONIC's FIRST word only: the checksum bits live in the
  // last word, so tampering with any of the other eleven changes the entropy
  // while (for a non-adversarially-chosen replacement) almost certainly
  // failing the checksum — confirmed directly: bip39's own validateMnemonic()
  // rejects this exact string. Throwaway, controls nothing; it does not even
  // pass standard BIP39 validation, so no compliant wallet would derive from
  // it at all.
  const BAD_CHECKSUM_MNEMONIC =
    'bulk walk nut penalty hip pave soap entry language right filter choice';

  test('a right-word-count, invalid-checksum mnemonic does not throw at construction time', () => {
    // Construction only checks word COUNT. Documents that the checksum
    // problem is invisible until load() is actually called.
    assert.doesNotThrow(() => new MnemonicKeySource(BAD_CHECKSUM_MNEMONIC));
  });

  test('...but throws at load() time, with a checksum-specific message', () => {
    const source = new MnemonicKeySource(BAD_CHECKSUM_MNEMONIC);
    assert.throws(() => source.load(), /checksum/i);
  });

  test('the checksum failure message reveals no word from the mnemonic', () => {
    const source = new MnemonicKeySource(BAD_CHECKSUM_MNEMONIC);
    try {
      source.load();
      assert.fail('expected load() to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const word of BAD_CHECKSUM_MNEMONIC.split(' ')) {
        assert.ok(!message.includes(word), `error message must not contain the word "${word}"`);
      }
    }
  });

  test('a mnemonic of real English words not all found in the BIP39 wordlist also throws, not derives', () => {
    // Distinct failure path from a checksum mismatch: this fails the
    // wordlist lookup itself (some of these words are not among the 2048
    // BIP39 entries), which is arguably the single most likely real mistake
    // — fat-fingering or misremembering a word — a user actually makes.
    const notAllInWordlist = 'apple banana cherry dragon eagle falcon guitar hammer island jungle kitten lantern';
    assert.throws(() => new MnemonicKeySource(notAllInWordlist).load(), /invalid mnemonic/i);
  });
});

describe('MnemonicKeySource — invisible Unicode characters between words', () => {
  // This exact class of bug hit policy.ts twice: .trim() and split(/\s+/) do
  // not treat every invisible character alike. NBSP (U+00A0) IS part of JS's
  // \s and IS covered by ECMAScript's WhiteSpace production, so it is already
  // handled correctly by .trim().split(/\s+/).join(' ') with no special
  // casing — confirmed below, not assumed. ZERO WIDTH SPACE (U+200B) is
  // Unicode category Cf (format), not Zs/WhiteSpace, so it is NOT matched by
  // \s and survives normalisation glued onto whichever word it sits next to.
  const NBSP = String.fromCharCode(0xa0);
  const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
  const CANONICAL = new MnemonicKeySource(TEST_MNEMONIC).load();

  test('a non-breaking space between every word normalises exactly like a regular space', () => {
    const withNbsp = TEST_MNEMONIC.split(' ').join(NBSP);
    const derived = new MnemonicKeySource(withNbsp).load();
    assert.equal(derived.address, CANONICAL.address);
    assert.equal(derived.privateKeyBech32, CANONICAL.privateKeyBech32);
  });

  test('a ZERO WIDTH SPACE glued onto a word is not silently ignored — it fails the wordlist match and throws', () => {
    // Unlike policy.ts's address Set (an exact-equality lookup against
    // caller-controlled strings, where a corrupted entry can silently miss a
    // match and get misclassified instead of rejected), BIP39 wordlist
    // lookup is an exact match against a small, fixed 2048-word list that
    // contains no invisible characters. A corrupted word cannot coincidentally
    // equal a different real word, so this fails loud instead of deriving a
    // different, plausible-looking wallet — confirmed here, not assumed.
    const words = TEST_MNEMONIC.split(' ');
    const corrupted = [words[0] + ZERO_WIDTH_SPACE, ...words.slice(1)].join(' ');
    const source = new MnemonicKeySource(corrupted);
    assert.throws(() => source.load(), /invalid mnemonic/i);
  });

  test('a ZERO WIDTH SPACE used as the ONLY separator between two words fuses them, changing the word count and throwing at construction', () => {
    const words = TEST_MNEMONIC.split(' ');
    // Replace the space between word[0] and word[1] with a ZWSP: \s+ cannot
    // split on it, so the two words fuse into a single non-whitespace token,
    // dropping the apparent count from 12 to 11.
    const fused = [words[0] + ZERO_WIDTH_SPACE + words[1], ...words.slice(2)].join(' ');
    assert.throws(() => new MnemonicKeySource(fused), /got 11\./);
  });
});

describe('MnemonicKeySource — the empty-string-split gotcha (same shape as policy.ts\'s knownAddresses bug)', () => {
  // ''.split(' ') yields [''] (length 1), not [] (length 0). Both before and
  // after accounting for this, empty/blank input is correctly REJECTED
  // either way — this only pins that the reported count is accurate (0, not
  // the misleading 1), not a change in whether it fails.
  test('an empty string is reported as 0 words, not the misleading 1 a naive split would report', () => {
    assert.throws(() => new MnemonicKeySource(''), /got 0\./);
  });

  test('a whitespace-only string is also reported as 0 words', () => {
    assert.throws(() => new MnemonicKeySource('   \n\t  '), /got 0\./);
  });
});

describe('MnemonicKeySource — word-count breadth beyond 12', () => {
  // Every test above this one exercises only a 12-word mnemonic as VALID
  // input (12 also appears as an invalid COUNT case via 3/11/0-word inputs,
  // but never as one of the other three accepted lengths). A mutation that
  // narrowed VALID_WORD_COUNTS to just [12] would pass every test above this
  // one. TEST_MNEMONIC_24 closes that gap at the opposite end of the range.
  test('a valid 24-word mnemonic derives a bech32 private key and an addr1 address', () => {
    const id = new MnemonicKeySource(TEST_MNEMONIC_24).load();
    assert.match(id.privateKeyBech32, /^ed25519e?_sk1/);
    assert.match(id.address, /^addr1/);
  });

  test('the 24-word mnemonic is deterministic, same as the 12-word case', () => {
    const a = new MnemonicKeySource(TEST_MNEMONIC_24).load();
    const b = new MnemonicKeySource(TEST_MNEMONIC_24).load();
    assert.equal(a.address, b.address);
    assert.equal(a.privateKeyBech32, b.privateKeyBech32);
  });
});

describe('load() is idempotent — calling it twice on the SAME instance returns consistent results', () => {
  test('MnemonicKeySource.load() called twice on one instance agrees with itself', () => {
    const source = new MnemonicKeySource(TEST_MNEMONIC, 0);
    const first = source.load();
    const second = source.load();
    assert.deepEqual(first, second);
  });

  test('PrivateKeyKeySource.load() called twice on one instance agrees with itself', () => {
    const derived = new MnemonicKeySource(TEST_MNEMONIC).load();
    const source = new PrivateKeyKeySource(derived.privateKeyBech32, derived.address);
    const first = source.load();
    const second = source.load();
    assert.deepEqual(first, second);
  });
});

describe('PrivateKeyKeySource — whitespace tolerance mirrors MnemonicKeySource, without weakening validation', () => {
  const derived = new MnemonicKeySource(TEST_MNEMONIC).load();

  test('tolerates surrounding whitespace on both the key and the address, and stores the trimmed form', () => {
    // Regression guard for the exact shape of policy.ts's knownAddresses()
    // bug: validating the trimmed value but STORING the original padded one
    // would pass this constructor yet never match anything downstream by
    // exact string equality. Asserting the loaded value equals the clean,
    // untrimmed-source derivation (not just "does not throw") is what would
    // catch that.
    const padded = new PrivateKeyKeySource(`  ${derived.privateKeyBech32}  `, `\t${derived.address}\n`).load();
    assert.equal(padded.privateKeyBech32, derived.privateKeyBech32);
    assert.equal(padded.address, derived.address);
  });

  test('a trailing ZERO WIDTH SPACE on the address is rejected, not silently accepted — trim() cannot strip it, and the regex is anchored', () => {
    const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
    assert.throws(
      () => new PrivateKeyKeySource(derived.privateKeyBech32, derived.address + ZERO_WIDTH_SPACE),
      /address/i
    );
  });

  test('a trailing ZERO WIDTH SPACE on the private key is rejected, not silently accepted', () => {
    const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
    assert.throws(
      () => new PrivateKeyKeySource(derived.privateKeyBech32 + ZERO_WIDTH_SPACE, derived.address),
      /private key/i
    );
  });
});

describe('PrivateKeyKeySource — validation boundaries a loose regex mutation could silently pass', () => {
  const derived = new MnemonicKeySource(TEST_MNEMONIC).load();

  test('accepts the non-extended ed25519_sk1 form, not just ed25519e_sk1', () => {
    // walletFromSeed only ever produces the EXTENDED form (ed25519e_sk1...),
    // so nothing above this test ever exercises the regex's `e?` — every
    // prior key came from walletFromSeed. A power user importing a raw key
    // generated by e.g. `cardano-cli address key-gen` gets a NON-extended
    // key (ed25519_sk1...) instead. Constructed here by stripping the 'e'
    // from a real derived key: this only needs to be shaped like a
    // non-extended bech32 key for the regex under test, not a
    // cryptographically valid one, since the constructor performs no
    // cryptographic check (see the documented address/key gap above) — same
    // "fake but correctly shaped" approach the brief itself uses for
    // 'addr1abc'.
    const nonExtended = derived.privateKeyBech32.replace(/^ed25519e_sk1/, 'ed25519_sk1');
    assert.doesNotThrow(() => new PrivateKeyKeySource(nonExtended, derived.address));
  });

  test('rejects a testnet-shaped address (addr_test1...) even though it starts with "addr"', () => {
    // Vector runs mainnet-only (see MnemonicKeySource, which hardcodes
    // network: 'Mainnet'), so an address for any other network is wrong
    // for this system, not merely differently formatted. A regex loosened
    // to `/^addr/` (matching only the four literal letters, not `addr1`
    // specifically) would let this through — a realistic operator mistake
    // (pasting a testnet address into a mainnet-only signer config), not
    // just a contrived string.
    const testnetShaped = 'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w';
    assert.throws(() => new PrivateKeyKeySource(derived.privateKeyBech32, testnetShaped), /address/i);
  });
});

describe('PrivateKeyKeySource — address/key correspondence is NOT verified (documented, deliberate gap)', () => {
  // See the long comment on PrivateKeyKeySource in keysource.ts for the full
  // reasoning. Short version: verifying this would need to derive a public
  // key (and, for a Base address, a stake credential too — a Base address is
  // not a function of the payment key alone) from the private key and
  // compare it against the address's embedded credential, which needs the
  // Cardano Multiplatform Library. This module deliberately imports ONLY
  // @lucid-evolution/wallet, and that package's one function taking a raw
  // private key (makeWalletFromPrivateKey) requires a live Provider — the
  // network capability this module exists to not have. Pinned here so the
  // gap is a visible, intentional decision, not a silent assumption.
  test('a syntactically valid key and a syntactically valid but unrelated address construct and load() without error', () => {
    const accountA = new MnemonicKeySource(TEST_MNEMONIC, 0).load();
    const accountB = new MnemonicKeySource(TEST_MNEMONIC, 1).load();
    // accountA's key paired with accountB's address: independently valid,
    // mutually unrelated. Nothing in this module can detect that mismatch.
    const mismatched = new PrivateKeyKeySource(accountA.privateKeyBech32, accountB.address).load();
    assert.equal(mismatched.privateKeyBech32, accountA.privateKeyBech32);
    assert.equal(mismatched.address, accountB.address);
  });
});

describe('error messages never echo the rejected input, even when the input itself is invalid', () => {
  // Distinct from the describe()-leak tests above: this pins that the
  // CONSTRUCTOR's own validation errors never interpolate the value that was
  // rejected, on the principle that a string purporting to be a private key
  // should never be echoed back, valid or not.
  test('the rejected private key value itself never appears in the constructor error message', () => {
    const rejected = 'this-string-must-never-appear-in-the-thrown-message';
    try {
      new PrivateKeyKeySource(rejected, 'addr1abc');
      assert.fail('expected constructor to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(rejected));
    }
  });

  test('the rejected address value itself never appears in the constructor error message', () => {
    const derived = new MnemonicKeySource(TEST_MNEMONIC).load();
    const rejected = 'this-address-string-must-never-appear-in-the-thrown-message';
    try {
      new PrivateKeyKeySource(derived.privateKeyBech32, rejected);
      assert.fail('expected constructor to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(rejected));
    }
  });
});

// --- Coordinator review pass ------------------------------------------------
//
// Independent review found one real leak the tests above did not cover, and
// one unpinned default. Both reproduced first against the pre-fix code
// (confirmed RED — see signer-task-5-report.md's addendum for the transcript)
// before the fix landed.

describe('key material is unreachable at RUNTIME, not just hidden from the compiler', () => {
  // TypeScript `private` erases at compile time only. At runtime an instance
  // built with plain `private readonly mnemonic: string` is an ordinary
  // object with an ordinary enumerable `mnemonic` property — JSON.stringify,
  // util.inspect (and therefore console.log, which calls it internally),
  // Object.keys, Object.getOwnPropertyNames, spread, and for...in all see it.
  // Reproduced directly before writing this fix: JSON.stringify() on the
  // pre-fix class printed the mnemonic in full. This package already writes
  // diagnostics to stderr elsewhere (audit.ts, index.ts), so this is one
  // `console.log(keySource)` away from a real leak, not a theoretical one.
  const mnemonicSource = new MnemonicKeySource(TEST_MNEMONIC, 2);
  const derived = new MnemonicKeySource(TEST_MNEMONIC).load();
  const privateKeySource = new PrivateKeyKeySource(derived.privateKeyBech32, derived.address);

  // TEST_MNEMONIC's words, checked individually: a substring check for the
  // whole phrase would miss a leak that reformats or partially reproduces it
  // (e.g. an inspect call that line-wraps between words).
  const MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');

  function assertNoLeak(rendered: string, label: string) {
    for (const word of MNEMONIC_WORDS) {
      assert.ok(!rendered.includes(word), `${label} must not contain the mnemonic word "${word}"`);
    }
    assert.ok(!rendered.includes(derived.privateKeyBech32), `${label} must not contain the private key`);
  }

  test('JSON.stringify(MnemonicKeySource instance) leaks nothing', () => {
    assertNoLeak(JSON.stringify(mnemonicSource), 'JSON.stringify');
  });

  test('util.inspect(MnemonicKeySource instance) leaks nothing (covers console.log too, which calls util.inspect internally)', () => {
    assertNoLeak(util.inspect(mnemonicSource), 'util.inspect');
  });

  test('Object.keys(MnemonicKeySource instance) no longer exposes the "mnemonic" property name, and accountIndex (not secret) remains', () => {
    // Object.keys returns property NAMES, which for the secret field are
    // never themselves derived from the mnemonic's VALUE — the meaningful
    // assertion is that the #private field is not enumerable at all.
    // accountIndex is explicitly not secret and is allowed to stay visible.
    assert.deepEqual(Object.keys(mnemonicSource), ['accountIndex']);
  });

  test('Object.values(MnemonicKeySource instance) leaks nothing (the value-exposure half Object.keys alone does not test)', () => {
    assertNoLeak(JSON.stringify(Object.values(mnemonicSource)), 'Object.values');
  });

  test('JSON.stringify(PrivateKeyKeySource instance) leaks nothing', () => {
    assertNoLeak(JSON.stringify(privateKeySource), 'JSON.stringify');
  });

  test('util.inspect(PrivateKeyKeySource instance) leaks nothing (covers console.log too)', () => {
    assertNoLeak(util.inspect(privateKeySource), 'util.inspect');
  });

  test('Object.keys(PrivateKeyKeySource instance) exposes no property names at all — both fields are secret', () => {
    assert.deepEqual(Object.keys(privateKeySource), []);
  });

  test('Object.values(PrivateKeyKeySource instance) leaks nothing', () => {
    assertNoLeak(JSON.stringify(Object.values(privateKeySource)), 'Object.values');
  });

  test('JSON.stringify still produces something useful (describe()\'s string), not an uninformative {}', () => {
    // Defence-in-depth check: toJSON()/inspect.custom exist so an accidental
    // serialisation attempt is still legible, not merely safe. Confirms the
    // override actually engages rather than JSON.stringify silently falling
    // back to `{}` because every enumerable property happened to be gone.
    assert.equal(JSON.stringify(mnemonicSource), JSON.stringify(mnemonicSource.describe()));
    assert.equal(JSON.stringify(privateKeySource), JSON.stringify(privateKeySource.describe()));
  });
});

describe('MnemonicKeySource — the default account index is pinned to 0', () => {
  // keysource.test.ts previously only ever compared an EXPLICIT 0 against an
  // EXPLICIT 1 ("a different account index yields a different address");
  // nothing tied the OMITTED-argument default itself to 0. A silent
  // regression changing the default would derive a different, validly
  // formatted wallet for every caller that omits the argument — and since
  // policy.ts matches change outputs by exact address, that would make
  // every real transaction look like a full outflow and get refused.
  test('a default-constructed instance derives the identical address as an explicit accountIndex: 0', () => {
    const defaulted = new MnemonicKeySource(TEST_MNEMONIC).load();
    const explicit = new MnemonicKeySource(TEST_MNEMONIC, 0).load();
    assert.equal(defaulted.address, explicit.address);
    assert.equal(defaulted.privateKeyBech32, explicit.privateKeyBech32);
  });
});

describe('MnemonicKeySource.load() — the error-wrap prefix is pinned', () => {
  // Removing the try/catch around walletFromSeed entirely still lets the
  // underlying bip39 error ("Invalid mnemonic checksum") through unwrapped,
  // which satisfied every /checksum/i-style assertion above without the
  // wrap actually being present. This pins the wrap itself.
  const BAD_CHECKSUM_MNEMONIC =
    'bulk walk nut penalty hip pave soap entry language right filter choice';

  test('load() failure is prefixed with the source-attributing wrap message', () => {
    // assert.throws matches against error.toString() ('Error: <message>'),
    // not error.message directly, hence no leading ^ anchor here.
    assert.throws(
      () => new MnemonicKeySource(BAD_CHECKSUM_MNEMONIC).load(),
      /Mnemonic could not be derived into a wallet: Invalid mnemonic checksum/
    );
  });
});
