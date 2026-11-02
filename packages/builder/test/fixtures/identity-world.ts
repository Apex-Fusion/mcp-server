// packages/builder/test/fixtures/identity-world.ts
// An offline identity registry for the builder tests: a deployment with test parameters (the scripts of the real blueprint, applied
// as at a deployment), its reference-script UTxOs, a configuration record whose Module-1 is a script that always succeeds, test keys,
// records, and a FixtureProvider that holds them with the wallet. Lucid runs the real applied scripts on every build (local
// evaluation), so a build that completes passes the contracts, minus the signatures (the scripts read only the required signers).
import { CML, Data, credentialToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { LucidEvolution, Script, UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS } from './fixture-provider.ts';
import { lucidForAddress } from '../../src/vector/build.ts';
import { CONFIG_TOKEN_NAME, makeIdentityDeployment } from '../../src/vector/identity-deployment.ts';
import type { DeployedScript, IdentityDeployment, RefName } from '../../src/vector/identity-deployment.ts';
import { encodeIdentityDatum, utf8Hex } from '../../src/vector/identity-codec.ts';
import type { IdentityDatum, Party } from '../../src/vector/identity-codec.ts';
import { allowlistRoot, keyHashOf } from '../../src/vector/identity-rules.ts';

/** 2026-11-15T12:00:00Z: the time of every build in the tests. */
export const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
/** The window that windowAt gives at NOW with the default 30 minutes. */
export const WINDOW = { lo: NOW - 60_000, hi: NOW + 30 * 60_000 };
export const DAY = 86_400_000;

/** Legacy identifiers on the test allowlist (the adoption tests use the first). */
export const LEGACY_IDS = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32), '44'.repeat(32), '55'.repeat(32)];
export const CONFIG_SEED = { txHash: '5d'.repeat(32), outputIndex: 2 };
const REF_TX = 'e0'.repeat(32);
const REF_NAMES: RefName[] = ['identity', 'attestation', 'delegation', 'vault', 'escrow', 'advert', 'module1'];

export const DEPLOYMENT: IdentityDeployment = makeIdentityDeployment({
  legacyRoot: allowlistRoot(LEGACY_IDS), configSeed: CONFIG_SEED,
  refs: Object.fromEntries(REF_NAMES.map((name, i) => [name, { txHash: REF_TX, outputIndex: i }])),
});

/** `(program 1.1.0 (lam ctx (con unit ())))`: the stand-in of Module-1's identity_party, which accepts every withdrawal. */
export const ALWAYS_SUCCEEDS: Script = { type: 'PlutusV3', script: '450101002499' };
export const M1 = validatorToScriptHash(ALWAYS_SUCCEEDS);

/** The enterprise address whose key hash is 28 zero bytes, where reference scripts live (Part 2 Section 2). */
export const ZERO_KEY_ADDRESS = credentialToAddress('Mainnet', { type: 'Key', hash: '00'.repeat(28) });

const scriptOf = (name: RefName): Script => {
  if (name === 'module1') return ALWAYS_SUCCEEDS;
  const deployed: DeployedScript = DEPLOYMENT[name];
  return deployed.script;
};
export const REF_UTXOS: UTxO[] = REF_NAMES.map((name, i) => ({
  txHash: REF_TX, outputIndex: i, address: ZERO_KEY_ADDRESS, assets: { lovelace: 60_000_000n }, scriptRef: scriptOf(name),
}));

/** The configuration record: the configuration token at the config_holder address, with M1 as its datum. */
export const CONFIG_UTXO: UTxO = {
  txHash: 'c0'.repeat(32), outputIndex: 0, address: DEPLOYMENT.configHolder.address,
  assets: { lovelace: 2_000_000n, [`${DEPLOYMENT.configSeal.hash}${CONFIG_TOKEN_NAME}`]: 1n }, datum: Data.to(M1),
};

/** A deterministic test key: its Ed25519 public key and key hash (the private key never leaves this function). */
export function testKey(n: number): { publicKey: string; keyHash: string } {
  const publicKey = Buffer.from(CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, n)).to_public().to_raw_bytes()).toString('hex');
  return { publicKey, keyHash: keyHashOf(publicKey) };
}

export const CONTROLLER = testKey(1);
export const LISTED = testKey(2);
export const PARTY_KEY = testKey(3);
export const GUARDIAN_A = testKey(4);
export const GUARDIAN_B = testKey(5);
export const NEW_CONTROLLER = testKey(6);
export const OTHER = testKey(7);

/** An Accountable Party signed by the controller, from long ago. */
export const CONTROLLER_ACCOUNTABLE: Party = {
  role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: null, rights: 3, removalAfter: null,
};

/** A valid Active root record created 30 days ago, with the controller as its Accountable Party and one listed key. */
export function rootRecord(overrides: Partial<IdentityDatum> = {}): IdentityDatum {
  return {
    controller: CONTROLLER.publicKey,
    keys: [{ keyType: 'Ed25519', key: LISTED.publicKey, purposes: 1 + 2 + 8 + 16, pop: null }],
    parties: [CONTROLLER_ACCOUNTABLE],
    guardianThreshold: 0, pendingRecovery: null, lineage: { type: 'Root' }, subagentEpoch: 0,
    name: utf8Hex('Test Agent'), description: utf8Hex('An agent for the tests'), framework: utf8Hex('custom'),
    endpoint: utf8Hex('https://agent.example'), capabilities: [utf8Hex('demo.text.stats.v1')],
    createdAt: NOW - 30 * DAY, status: { type: 'Active' },
    ...overrides,
  };
}

let recordCounter = 0;
/** The record output of `id` holding `record`, at the identity address with its token and 10 AP3X (or `lovelace`). */
export function recordUtxo(id: string, record: IdentityDatum, lovelace = 10_000_000n): UTxO {
  recordCounter += 1;
  return {
    txHash: recordCounter.toString(16).padStart(2, '0').repeat(32).slice(0, 64), outputIndex: 0,
    address: DEPLOYMENT.identity.address, assets: { lovelace, [`${DEPLOYMENT.identity.hash}${id}`]: 1n }, datum: encodeIdentityDatum(record),
  };
}

/**
 * A node that holds the wallet, the reference scripts, the configuration record (unless `config: false`) and `extra`. Its reward
 * accounts hold `rewards` (default 0), which a Module-1 consent withdraws in full.
 */
export function identityWorld(extra: UTxO[] = [], opts: { config?: boolean; rewards?: bigint } = {}): FixtureProvider {
  const provider = new FixtureProvider([...FIXTURE_UTXOS, ...REF_UTXOS, ...(opts.config === false ? [] : [CONFIG_UTXO]), ...extra]);
  return Object.assign(provider, { getDelegation: async () => ({ poolId: null, rewards: opts.rewards ?? 0n }) });
}

/** Lucid bound to the fixture wallet. */
export function lucidOn(provider: FixtureProvider): Promise<LucidEvolution> { return lucidForAddress(provider, OWN_ADDRESS); }

export { OWN_ADDRESS };
