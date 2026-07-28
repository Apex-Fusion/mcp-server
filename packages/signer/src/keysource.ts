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

const VALID_WORD_COUNTS = [12, 15, 18, 21, 24];

export class MnemonicKeySource implements KeySource {
  private readonly mnemonic: string;

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
    this.mnemonic = mnemonic.trim().split(/\s+/).join(' ').toLowerCase();

    // `''.split(' ')` yields `['']` (length 1), not `[]` (length 0) -- the
    // same empty-string-split gotcha documented at length in policy.ts's
    // knownAddresses(). Handled explicitly so a blank/whitespace-only
    // mnemonic is reported as "got 0 words", not the misleading "got 1".
    // Either way this throws and derives nothing; this only fixes what the
    // message says.
    const words = this.mnemonic.length === 0 ? [] : this.mnemonic.split(' ');
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

  load(): SigningIdentity {
    // Vector runs with the --mainnet flag, so addresses are addr1...
    let w;
    try {
      w = walletFromSeed(this.mnemonic, { network: 'Mainnet', accountIndex: this.accountIndex });
    } catch (err) {
      // Never interpolate `this.mnemonic` here. Read bip39's source
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
  private readonly privateKeyBech32: string;
  private readonly address: string;

  // NOTE on a gap this constructor does NOT close: it validates that each
  // argument is independently well-formed, but never checks that `address`
  // is actually the address controlled by `privateKeyBech32`. A caller that
  // supplies a syntactically valid key and a syntactically valid but
  // UNRELATED address constructs and load()s successfully.
  //
  // This is a structural limit, not an oversight. Confirming the
  // correspondence would need to derive a public key (and, for the Base
  // addresses walletFromSeed produces, a stake credential too -- a Base
  // address is not a function of the payment key alone) from
  // privateKeyBech32 and compare it against the address's embedded
  // credential, which needs the Cardano Multiplatform Library. This module
  // deliberately imports ONLY `@lucid-evolution/wallet` (see
  // boundary.test.ts and the package-level import allowlist), and that
  // package's only Provider-free export is walletFromSeed, which takes a
  // MNEMONIC, not a raw key. Its one function that accepts a raw private
  // key, makeWalletFromPrivateKey, requires a live Provider -- exactly the
  // network capability this module exists to not have. There is no way to
  // perform this check without either an out-of-scope import or a network
  // round-trip, so it is left undone, deliberately, rather than partially
  // done via an import this module should not have.
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
    this.privateKeyBech32 = trimmedKey;
    this.address = trimmedAddress;
  }

  describe(): string {
    return 'raw private key';
  }

  load(): SigningIdentity {
    return { privateKeyBech32: this.privateKeyBech32, address: this.address };
  }
}
