// Signer configuration, entirely from the environment. No network settings
// exist here by design — the signer has no endpoints to configure.
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
  const accountIndex = Number(env.VECTOR_SIGNER_ACCOUNT_INDEX ?? '0');

  if (env.VECTOR_SIGNER_PRIVATE_KEY && env.VECTOR_SIGNER_ADDRESS) {
    return new PrivateKeyKeySource(env.VECTOR_SIGNER_PRIVATE_KEY, env.VECTOR_SIGNER_ADDRESS);
  }
  if (env.VECTOR_SIGNER_MNEMONIC) {
    return new MnemonicKeySource(env.VECTOR_SIGNER_MNEMONIC, accountIndex);
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
    return new MnemonicKeySource(contents, accountIndex);
  }

  throw new Error(
    'No key material configured. Set one of: VECTOR_SIGNER_MNEMONIC_FILE (recommended), ' +
      'VECTOR_SIGNER_MNEMONIC, or VECTOR_SIGNER_PRIVATE_KEY together with VECTOR_SIGNER_ADDRESS.'
  );
}
