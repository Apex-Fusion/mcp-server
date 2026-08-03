// Signer configuration, entirely from the environment. No network settings
// exist here by design - the signer has no endpoints to configure.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MnemonicKeySource, PrivateKeyKeySource, type KeySource } from './keysource.js';
import type { SpendLimits } from './policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SignerConfig {
  keySource: KeySource;
  limits: SpendLimits;
  auditLogPath: string;
}

function repoRootDefault(): string {
  // From packages/signer/build/index.js, three levels up is the repo root.
  return resolve(__dirname, '../../..');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  const keySource = resolveKeySource(env);

  return {
    keySource,
    limits: {
      perTxLovelace: BigInt(env.VECTOR_SIGNER_SPEND_LIMIT_PER_TX ?? '100000000'),
      dailyLovelace: BigInt(env.VECTOR_SIGNER_SPEND_LIMIT_DAILY ?? '500000000'),
    },
    auditLogPath: env.VECTOR_SIGNER_AUDIT_LOG_PATH
      ? resolve(env.VECTOR_SIGNER_AUDIT_LOG_PATH)
      : resolve(repoRootDefault(), 'vector-signer-audit-log.json'),
  };
}

function resolveKeySource(env: NodeJS.ProcessEnv): KeySource {
  if (env.VECTOR_SIGNER_PRIVATE_KEY && env.VECTOR_SIGNER_ADDRESS) {
    return new PrivateKeyKeySource(env.VECTOR_SIGNER_PRIVATE_KEY, env.VECTOR_SIGNER_ADDRESS);
  }
  if (env.VECTOR_SIGNER_MNEMONIC) {
    return new MnemonicKeySource(env.VECTOR_SIGNER_MNEMONIC, parseAccountIndex(env.VECTOR_SIGNER_ACCOUNT_INDEX));
  }
  if (env.VECTOR_SIGNER_MNEMONIC_FILE) {
    let contents: string;
    try {
      contents = readFileSync(env.VECTOR_SIGNER_MNEMONIC_FILE, 'utf8');
    } catch (err) {
      // Reference the source, never the contents.
      throw new Error(
        `Could not read VECTOR_SIGNER_MNEMONIC_FILE (${env.VECTOR_SIGNER_MNEMONIC_FILE}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return new MnemonicKeySource(contents, parseAccountIndex(env.VECTOR_SIGNER_ACCOUNT_INDEX));
  }

  throw new Error(
    'No key material configured. Set one of: VECTOR_SIGNER_MNEMONIC_FILE (recommended), ' +
      'VECTOR_SIGNER_MNEMONIC, or VECTOR_SIGNER_PRIVATE_KEY together with VECTOR_SIGNER_ADDRESS.'
  );
}

// Number(x) returns NaN for garbage input rather than throwing, and nothing
// downstream re-validates it: MnemonicKeySource's constructor takes
// accountIndex on faith (its own validation is about the mnemonic, not this
// argument), and walletFromSeed's HD derivation does not throw on a NaN,
// negative, or fractional index either -- it just walks a different (but
// still syntactically valid-looking) branch of the tree. A single env-var
// typo would otherwise silently start the signer against a different
// wallet, with no error anywhere in the chain and describe() printing the
// nonsense value back out as if nothing were wrong (e.g. "mnemonic (account
// index NaN)"). This file's own spend limits, a few lines up, already fail
// loud on the same shape of mistake (BigInt(...) throws on non-numeric
// input) -- this applies that same instinct here.
//
// Only called from the two MnemonicKeySource-constructing branches above,
// not unconditionally: PrivateKeyKeySource never uses an account index (see
// its own doc comment in keysource.ts), so a leftover/garbage
// VECTOR_SIGNER_ACCOUNT_INDEX must not block startup for a config that never
// reads it.
function parseAccountIndex(raw: string | undefined): number {
  const source = raw ?? '0';
  const accountIndex = Number(source);
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(
      `Invalid VECTOR_SIGNER_ACCOUNT_INDEX: expected a non-negative integer, got "${source}".`
    );
  }
  return accountIndex;
}
