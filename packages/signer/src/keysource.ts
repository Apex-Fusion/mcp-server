// Key material sources. Pure derivation only: walletFromSeed needs no Provider,
// so nothing here can reach the network.
//
// A raw private key is strictly safer than a mnemonic: it controls one account
// rather than the entire HD tree, so a leak is bounded.
//
// SECURITY: this module handles the most sensitive data in the system. Key
// material (mnemonics, private keys) must never reach describe(), a thrown
// error, or a log line -- only the *source* of a failure ("mnemonic could not
// be derived", "invalid private key"), never the value. Every catch block
// below is commented with why the upstream message it surfaces is safe to
// include verbatim.
//
// TypeScript `private` is a COMPILE-TIME check only -- at runtime it is an
// ordinary enumerable own property, fully visible to JSON.stringify,
// util.inspect, console.log (which goes through util.inspect), Object.keys,
// Object.getOwnPropertyNames, spread, and for...in. Verified by execution,
// not assumed: `JSON.stringify(new MnemonicKeySource(m))` printed the
// mnemonic in full under TS `private`. This package already writes
// diagnostics to stderr elsewhere (audit.ts, index.ts) and describe()'s own
// docstring below invites "for logs" usage -- one `console.log(keySource)`
// instead of `console.log(keySource.describe())` away from a real leak. Key
// material fields are therefore declared with native `#private` syntax
// (invisible to all of the above, confirmed by execution) rather than TS
// `private`, and both classes additionally override toJSON() and Node's
// util.inspect.custom symbol as defence in depth, so that even an
// accidental serialisation attempt produces describe()'s safe string
// instead of either a leak or an uninformative `{}`.
import { walletFromSeed } from '@lucid-evolution/wallet';

export interface SigningIdentity {
  privateKeyBech32: string;
  address: string;
}

export interface KeySource {
  /** Human-readable description for logs. MUST NOT include key material. */
  describe(): string;
  load(): SigningIdentity;
}

// The well-known symbol Node's util.inspect (and therefore console.log, which
// calls it) looks for. Built via Symbol.for on its registered name rather
// than `import { inspect } from 'node:util'` so this module's import surface
// stays exactly `@lucid-evolution/wallet` -- confirmed by execution that
// `Symbol.for('nodejs.util.inspect.custom') === util.inspect.custom`.
const NODE_INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

const VALID_WORD_COUNTS = [12, 15, 18, 21, 24];

export class MnemonicKeySource implements KeySource {
  // Native private field, not TS `private` -- see the module header. The
  // mnemonic is the single most sensitive value in this whole package.
  #mnemonic: string;

  constructor(mnemonic: string, private readonly accountIndex: number = 0) {
    // Whitespace normalisation: collapse any run of whitespace (including
    // tabs/newlines and Unicode space separators like NBSP, which JS `\s`
    // already covers) to a single space, and trim the ends. This is the
    // ONLY normalisation that can be done safely with a denylist-free,
    // positive approach for whitespace -- see the residual note below for
    // what it deliberately does not catch.
    //
    // Case normalisation: BIP39 wordlist lookup is case-sensitive
    // (`wordlist.indexOf(word)`), but casing carries no BIP39 semantic
    // weight -- a word is identified purely by which of the 2048 fixed
    // wordlist entries it matches, never by how it happens to be
    // capitalised. There is no such thing as two different valid mnemonics
    // that differ only in case, so lowercasing here cannot turn one legitimate
    // mnemonic into a different, also-legitimate one -- it can only turn an
    // otherwise-correct mnemonic that a client capitalised (autocapitalize,
    // pasted from a sentence, typed by hand) from a hard, unhelpful throw
    // into the working derivation the caller actually intended. Verified
    // empirically before relying on this: lowercasing an uppercase or
    // mixed-case rendering of a valid mnemonic reproduces the exact
    // canonical lowercase string byte-for-byte, and therefore derives the
    // exact same address -- never a different, also-plausible one.
    this.#mnemonic = mnemonic.trim().split(/\s+/).join(' ').toLowerCase();

    // `''.split(' ')` yields `['']` (length 1), not `[]` (length 0) -- the
    // same empty-string-split gotcha documented at length in policy.ts's
    // knownAddresses(). Handled explicitly so a blank/whitespace-only
    // mnemonic is reported as "got 0 words", not the misleading "got 1".
    // Either way this throws and derives nothing; this only fixes what the
    // message says.
    const words = this.#mnemonic.length === 0 ? [] : this.#mnemonic.split(' ');
    if (!VALID_WORD_COUNTS.includes(words.length)) {
      throw new Error(
        `Invalid mnemonic: expected 12, 15, 18, 21 or 24 words, got ${words.length}.`
      );
    }

    // Residual, deliberately not chased further (same shape as policy.ts's
    // own documented residual): a character that is invisible but is NOT
    // matched by `\s` -- e.g. U+200B ZERO WIDTH SPACE or U+2060 WORD
    // JOINER, neither of which are in ECMAScript's WhiteSpace production --
    // survives `.split(/\s+/)` glued onto whichever word it sits next to.
    // Unlike policy.ts's address matching (an exact-equality check against
    // caller-supplied strings, where a corrupted entry can silently fail to
    // match and be misclassified), this does not create a silent-wrong-
    // derivation risk: BIP39 word lookup is an exact match against a fixed,
    // closed 2048-word list, so a corrupted word can (for all practical,
    // non-adversarially-constructed input) never happen to equal a
    // different real wordlist word. The corrupted word simply fails to
    // match anything, and load() throws "Invalid mnemonic" -- confirmed
    // empirically, see keysource.test.ts. The failure is safe (loud, no
    // derivation), just not always caught at construction time the way a
    // word-count mismatch is, because the corrupted string still counts as
    // one "word" by count alone.
  }

  describe(): string {
    return `mnemonic (account index ${this.accountIndex})`;
  }

  // Defence in depth beyond the #private field above: even if some future
  // caller (or library) reaches for JSON.stringify(keySource) or
  // console.log(keySource) instead of keySource.describe()'s intended path,
  // both now resolve to the same safe string rather than either leaking or
  // silently producing an uninformative `{}`.
  toJSON(): string {
    return this.describe();
  }

  [NODE_INSPECT_CUSTOM](): string {
    return this.describe();
  }

  load(): SigningIdentity {
    // Vector runs with the --mainnet flag, so addresses are addr1...
    let w;
    try {
      w = walletFromSeed(this.#mnemonic, { network: 'Mainnet', accountIndex: this.accountIndex });
    } catch (err) {
      // Never interpolate `this.#mnemonic` here. Read bip39's source
      // (mnemonicToEntropy, which walletFromSeed calls directly) to confirm
      // this before relying on it: every throw site in that function uses
      // one of four FIXED constant strings -- 'Invalid mnemonic' (wrong
      // word count, or a word absent from the wordlist), 'Invalid mnemonic
      // checksum' (right words, wrong combination), 'Invalid entropy', or a
      // wordlist-config error -- and none of them ever interpolates the
      // input. err.message is therefore safe to surface verbatim. This
      // also confirms the safety property the constructor's comment
      // depends on: a bad mnemonic throws here rather than silently
      // resolving to different, plausible-looking entropy.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Mnemonic could not be derived into a wallet: ${message}`);
    }
    return { privateKeyBech32: w.paymentKey, address: w.address };
  }
}

export class PrivateKeyKeySource implements KeySource {
  // Native private fields, not TS `private` -- see the module header.
  #privateKeyBech32: string;
  #address: string;

  // NOTE on a gap this constructor does NOT close: it validates that each
  // argument is independently well-formed, but never checks that `address`
  // is actually the address controlled by `privateKeyBech32`. A caller that
  // supplies a syntactically valid key and a syntactically valid but
  // UNRELATED address constructs and load()s successfully.
  //
  // This is a deliberate scope boundary for THIS module, not a technical
  // impossibility -- worth being precise about, since "structural limit"
  // language here previously read as the latter and that is not accurate.
  // The check itself is possible with no network I/O: the Cardano
  // Multiplatform Library can derive a public key from a raw private key
  // and hash it into a credential entirely offline. CML is not some
  // unavailable dependency -- it is already a DIRECT dependency of this
  // exact package (`@anastasia-labs/cardano-multiplatform-lib-nodejs` in
  // package.json), it is not on boundary.test.ts's forbidden-import list,
  // and decode.ts already imports it elsewhere in this same package. So CML
  // is not the obstacle. The actual constraint is narrower and self-
  // imposed: this module's task brief calls for importing ONLY
  // `@lucid-evolution/wallet`, to keep this one file's dependency surface
  // minimal and its intent legible at a glance -- and that package's only
  // function accepting a raw private key, makeWalletFromPrivateKey,
  // requires a live Provider (a genuine network capability, unlike CML),
  // which really is off-limits here. Closing this gap is therefore in
  // reach for a future, deliberate change (a CML import, with
  // boundary.test.ts re-verified against it) -- it is left open FOR NOW
  // because it is out of THIS task's scope, not because it cannot be done.
  //
  // For the Base addresses walletFromSeed produces specifically, closing
  // this gap fully would also need the stake credential, not just the
  // payment one -- a Base address is not a function of the payment key
  // alone, and this constructor never receives a stake key at all. A CML-
  // based check could still verify the payment-credential half, which
  // would already catch the realistic mistake (an unrelated key/address
  // pair) even without verifying the stake half.
  //
  // What this gap does NOT do: it does not let a mismatch pass unnoticed
  // forever, and it fails in a bounded direction. Signing itself does not
  // need the address (raw Ed25519 signing over a transaction body needs
  // only the private key), so a mismatch does not corrupt the signature --
  // it produces a witness for a DIFFERENT credential than the one the
  // transaction's inputs actually require, which is exactly the shape of
  // failure a UTxO chain is built to reject at submission. Separately, and
  // verified by reading the already-implemented policy.ts: `address` is
  // also the value fed into policy.ts's own-address change detection, which
  // only ever uses it to decide what does NOT count as outflow. A wrong
  // `address` there cannot make policy.ts treat a foreign payment as safe
  // change -- at worst it fails to recognise real change as change, which
  // policy.ts's own documentation already establishes as its deliberate
  // bias (over-refuse, never under-refuse). Both consequences are pinned as
  // tests below rather than left as assumptions.
  constructor(privateKeyBech32: string, address: string) {
    // Trimmed for the same reason MnemonicKeySource tolerates surrounding
    // whitespace: a bech32 string has no meaningful leading/trailing
    // whitespace, so trimming is pure UX (copy-paste noise) with no
    // ambiguity risk. Validate AND store the trimmed value, not the
    // original -- storing the untrimmed original after validating the
    // trimmed one is precisely the bug policy.ts's knownAddresses() had
    // (validated the trimmed form, kept the padded one, which then never
    // matched anything downstream by exact string equality). Both fields
    // here feed later exact-string comparisons too (this address flows into
    // policy.ts's ownAddresses), so the same failure shape applies.
    const trimmedKey = privateKeyBech32.trim();
    const trimmedAddress = address.trim();
    if (!/^ed25519e?_sk1[0-9a-z]+$/.test(trimmedKey)) {
      throw new Error('Invalid private key: expected a bech32 ed25519_sk / ed25519e_sk value.');
    }
    if (!/^addr1[0-9a-z]+$/.test(trimmedAddress)) {
      throw new Error('Invalid address: expected a bech32 addr1 value.');
    }
    this.#privateKeyBech32 = trimmedKey;
    this.#address = trimmedAddress;
  }

  describe(): string {
    return 'raw private key';
  }

  // Defence in depth beyond the #private fields above -- see the matching
  // comment on MnemonicKeySource.
  toJSON(): string {
    return this.describe();
  }

  [NODE_INSPECT_CUSTOM](): string {
    return this.describe();
  }

  load(): SigningIdentity {
    return { privateKeyBech32: this.#privateKeyBech32, address: this.#address };
  }
}
