// packages/builder/test/identity-scripts.test.ts
// Ties the generated scripts module to the identity-marketplace blueprint of agents-marketplace (copied byte for byte into
// test/fixtures/identity-marketplace.plutus.json by scripts/gen-identity-scripts.mjs): the copy has the sha256 that the module
// records, the generator renders exactly the module from the copy, and every unapplied script hashes to the hash that the blueprint
// states. Then the deployment: parameters applied as `aiken blueprint apply` applies them (hashes computed with the Aiken CLI).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatorToScriptHash, validatorToAddress } from '@lucid-evolution/lucid';
import { IDENTITY_BLUEPRINT, IDENTITY_SCRIPTS } from '../src/vector/identity-scripts.generated.ts';
import { renderIdentityScripts } from '../scripts/gen-identity-scripts.mjs';
import {
  makeIdentityDeployment, identityDeploymentFrom, describeDeployment, refOf, readRefScript, findConfigRecord, parseRef,
  IdentityConfigError, NOT_CONFIGURED, CONFIG_TOKEN_NAME, REF_ENV,
} from '../src/vector/identity-deployment.ts';
import { LEGACY_REGISTRY_POLICY_ID } from '../src/vector/legacy-registry.ts';
import { DEPLOYMENT, CONFIG_UTXO, M1, REF_UTXOS, identityWorld } from './fixtures/identity-world.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';

const FIXTURE = resolve(import.meta.dirname!, 'fixtures/identity-marketplace.plutus.json');
const MODULE = resolve(import.meta.dirname!, '../src/vector/identity-scripts.generated.ts');

describe('the generated scripts module is the blueprint at the recorded commit', () => {
  const text = readFileSync(FIXTURE, 'utf8');

  test('the copied blueprint has the sha256 that the module records (agents-marketplace b5d66a6)', () => {
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), IDENTITY_BLUEPRINT.sha256);
    assert.equal(IDENTITY_BLUEPRINT.sha256, '0d4e3ec1ba3982c4e4e60c29045cd9a0fd554ec3ee598ca77fbabeb85723f7c3');
    assert.equal(IDENTITY_BLUEPRINT.commit, 'b5d66a6');
  });

  test('the generator renders exactly the checked-in module from the copy', () => {
    assert.equal(renderIdentityScripts(text, IDENTITY_BLUEPRINT.commit), readFileSync(MODULE, 'utf8'));
  });

  test('every unapplied script hashes to the hash that the blueprint states', () => {
    for (const [name, s] of Object.entries(IDENTITY_SCRIPTS)) {
      assert.equal(validatorToScriptHash({ type: 'PlutusV3', script: s.compiledCode }), s.hash, name);
    }
  });

  test('the parameters are the ones the deployment applies, in order', () => {
    assert.deepEqual(IDENTITY_SCRIPTS.identity.parameters, ['legacy_hash', 'legacy_root', 'config_policy', 'config_holder']);
    assert.deepEqual(IDENTITY_SCRIPTS.config_seal.parameters, ['seed', 'config_holder']);
    assert.deepEqual(IDENTITY_SCRIPTS.vault.parameters, ['identity_hash', 'delegation_hash', 'escrow_hash']);
    for (const name of ['attestation', 'delegation', 'escrow'] as const) assert.deepEqual(IDENTITY_SCRIPTS[name].parameters, ['identity_hash']);
    for (const name of ['advert', 'config_holder'] as const) assert.deepEqual(IDENTITY_SCRIPTS[name].parameters, []);
  });

  test('the generator refuses a blueprint that is not Plutus V3 or misses a validator', () => {
    const blueprint = JSON.parse(text);
    assert.throws(() => renderIdentityScripts(JSON.stringify({ ...blueprint, preamble: { ...blueprint.preamble, plutusVersion: 'v2' } }), 'b5d66a6'), /not Plutus V3/);
    assert.throws(() => renderIdentityScripts(JSON.stringify({ ...blueprint, validators: blueprint.validators.filter((v: { title: string }) => !v.title.startsWith('vault.')) }), 'b5d66a6'), /no validator vault/);
    assert.throws(() => renderIdentityScripts(text, 'not-a-commit'), /commit/);
  });
});

describe('the deployment applies parameters as aiken blueprint apply does', () => {
  // Computed with aiken v1.1.21 `blueprint apply` and `blueprint hash` on the blueprint at b5d66a6, for the seed 5d…5d#2 and the
  // legacy root a1…a1.
  const deployment = makeIdentityDeployment({ legacyRoot: 'a1'.repeat(32), configSeed: { txHash: '5d'.repeat(32), outputIndex: 2 } });

  test('every script hash equals the Aiken CLI result', () => {
    assert.equal(deployment.configHolder.hash, '288fea77a0f674c6080aadd8ed3ca42cd5a920bf1f00c0d3e63306e4');
    assert.equal(deployment.configSeal.hash, 'a22bb45073479e4187abc4a317d12186ab161eb5934b5d51a19608e8');
    assert.equal(deployment.identity.hash, '6796754490b50b7cba34e736e6305d7c137bb5ef1f5e96125fc84728');
    assert.equal(deployment.attestation.hash, '1d512e0f0c0c7335245bc08fd071404367e321c747256ca7f69061f5');
    assert.equal(deployment.delegation.hash, '8c8e867d739d8e42b7c859d7cf4150afb7704061b7f37b3f3f419a97');
    assert.equal(deployment.escrow.hash, 'dc5dd979e9da5c69c267c79dc76a29128c4f7912a2f30c902266404c');
    assert.equal(deployment.vault.hash, '5081c95137843c47507c7b6b95ac43aaf67c144dcea59b2c6f7ed725');
    assert.equal(deployment.advert.hash, 'f36e366e06d4480651aa0e1064578f0bfe275af96dfcaaabe5efe26c');
  });

  test('every address is the enterprise address of its script, and the hash is the hash of the applied script', () => {
    for (const s of [deployment.identity, deployment.configHolder, deployment.attestation, deployment.delegation, deployment.vault, deployment.escrow, deployment.advert]) {
      assert.equal(validatorToScriptHash(s.script), s.hash);
      assert.equal(s.address, validatorToAddress('Mainnet', s.script));
      assert.match(s.address, /^addr1w/);
    }
  });

  test('the identity script carries the legacy registry policy as its first parameter: another legacy hash gives another policy', () => {
    assert.equal(LEGACY_REGISTRY_POLICY_ID, 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01');
    const otherRoot = makeIdentityDeployment({ legacyRoot: 'a2'.repeat(32), configSeed: { txHash: '5d'.repeat(32), outputIndex: 2 } });
    assert.notEqual(otherRoot.identity.hash, deployment.identity.hash);
    assert.equal(otherRoot.advert.hash, deployment.advert.hash);
  });
});

describe('identityDeploymentFrom (environment)', () => {
  const env = { VECTOR_IDENTITY_LEGACY_ROOT: 'A1'.repeat(32), VECTOR_IDENTITY_CONFIG_SEED: `${'5d'.repeat(32)}#2` };

  test('no identity variable: not configured (the state before the deployment)', () => {
    assert.equal(identityDeploymentFrom({}), null);
    assert.equal(identityDeploymentFrom({ VECTOR_IDENTITY_LEGACY_ROOT: '  ' }), null);
    assert.match(describeDeployment(null), /not configured/);
    assert.match(NOT_CONFIGURED, /VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/);
  });

  test('both required values give the deployment; a matching VECTOR_IDENTITY_POLICY_ID is accepted', () => {
    const d = identityDeploymentFrom({ ...env, VECTOR_IDENTITY_POLICY_ID: '6796754490b50b7cba34e736e6305d7c137bb5ef1f5e96125fc84728' })!;
    assert.equal(d.identity.hash, '6796754490b50b7cba34e736e6305d7c137bb5ef1f5e96125fc84728');
    assert.equal(d.legacyRoot, 'a1'.repeat(32));
    assert.deepEqual(d.refs, {});
    assert.match(describeDeployment(d), /policy 6796754490b5.*identity unset/);
  });

  test('reference UTxOs and the allowlist URL are read from their variables', () => {
    const d = identityDeploymentFrom({ ...env, VECTOR_IDENTITY_REF_UTXO: `${'AB'.repeat(32)}#0`, VECTOR_IDENTITY_ESCROW_REF_UTXO: `${'cd'.repeat(32)}#4`, VECTOR_IDENTITY_ALLOWLIST_URL: 'https://id.example/allowlist.json' })!;
    assert.deepEqual(d.refs.identity, { txHash: 'ab'.repeat(32), outputIndex: 0 });
    assert.deepEqual(d.refs.escrow, { txHash: 'cd'.repeat(32), outputIndex: 4 });
    assert.equal(d.allowlistUrl, 'https://id.example/allowlist.json');
    assert.throws(() => refOf(d, 'attestation'), (e: Error) => e instanceof IdentityConfigError && /VECTOR_IDENTITY_ATTESTATION_REF_UTXO is not set/.test(e.message));
  });

  test('clear errors: one required value without the other, malformed values, a policy that does not match', () => {
    assert.throws(() => identityDeploymentFrom({ VECTOR_IDENTITY_LEGACY_ROOT: 'a1'.repeat(32) }), /VECTOR_IDENTITY_CONFIG_SEED is not/);
    assert.throws(() => identityDeploymentFrom({ VECTOR_IDENTITY_REF_UTXO: `${'ab'.repeat(32)}#0` }), /VECTOR_IDENTITY_LEGACY_ROOT is not/);
    assert.throws(() => identityDeploymentFrom({ ...env, VECTOR_IDENTITY_LEGACY_ROOT: 'a1'.repeat(31) }), /VECTOR_IDENTITY_LEGACY_ROOT must be 64 hex/);
    assert.throws(() => identityDeploymentFrom({ ...env, VECTOR_IDENTITY_CONFIG_SEED: '5d'.repeat(32) }), /VECTOR_IDENTITY_CONFIG_SEED must be <64 hex characters>#<output index>/);
    assert.throws(() => identityDeploymentFrom({ ...env, VECTOR_IDENTITY_VAULT_REF_UTXO: 'x#1' }), /VECTOR_IDENTITY_VAULT_REF_UTXO must be/);
    assert.throws(() => identityDeploymentFrom({ ...env, VECTOR_IDENTITY_ALLOWLIST_URL: 'http://id.example/a.json' }), /must be an https URL/);
    assert.throws(() => identityDeploymentFrom({ ...env, VECTOR_IDENTITY_POLICY_ID: 'ff'.repeat(28) }), /give the identity policy 6796754490b5/);
  });

  test('every reference variable has the VECTOR_IDENTITY_ prefix and parseRef refuses a leading zero index', () => {
    for (const variable of Object.values(REF_ENV)) assert.match(variable, /^VECTOR_IDENTITY_[A-Z0-9_]+_UTXO$|^VECTOR_IDENTITY_REF_UTXO$/);
    assert.throws(() => parseRef(`${'ab'.repeat(32)}#01`, 'X'), /X must be/);
  });
});

describe('reference scripts and the configuration record', () => {
  test('readRefScript returns the UTxO when it holds the expected script, and names the variable when it does not', async () => {
    const provider = identityWorld();
    const utxo = await readRefScript(provider, DEPLOYMENT, 'identity', DEPLOYMENT.identity.hash);
    assert.equal(utxo.scriptRef?.script, DEPLOYMENT.identity.script.script);
    await assert.rejects(readRefScript(provider, DEPLOYMENT, 'identity', DEPLOYMENT.escrow.hash), /VECTOR_IDENTITY_REF_UTXO\) holds script/);
    await assert.rejects(readRefScript(new FixtureProvider([]), DEPLOYMENT, 'vault', DEPLOYMENT.vault.hash), /is not an unspent output/);
    const noScript = REF_UTXOS.map((u) => ({ ...u, scriptRef: undefined }));
    await assert.rejects(readRefScript(new FixtureProvider(noScript), DEPLOYMENT, 'attestation', DEPLOYMENT.attestation.hash), /holds no script/);
  });

  test('findConfigRecord reads M1 from the token output at the config_holder address, and null before the seal', async () => {
    assert.deepEqual((await findConfigRecord(identityWorld(), DEPLOYMENT))?.m1, M1);
    assert.equal(await findConfigRecord(identityWorld([], { config: false }), DEPLOYMENT), null);
    const bad = { ...CONFIG_UTXO, datum: 'd87980' };
    await assert.rejects(findConfigRecord(new FixtureProvider([bad]), DEPLOYMENT), /no 28-byte Module-1 hash/);
    assert.equal(CONFIG_TOKEN_NAME, Buffer.from('identity-config').toString('hex'));
  });
});
