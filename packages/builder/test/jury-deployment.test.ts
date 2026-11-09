// packages/builder/test/jury-deployment.test.ts
// The Module-1 and jury manifests: the environment, the checks of each manifest (the mainnet Module-1 manifest; a jury manifest in the
// format of the Python deploy tool), the checks between them, and the reference scripts on chain (a fixture node). No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  JURY_NOT_CONFIGURED, MODULE1_NOT_CONFIGURED, describeJurySources, juryFromManifest, juryOf, jurySourcesFrom, loadJuryConfig, module1FromManifest,
  requireModule1,
} from '../src/vector/jury-deployment.ts';
import { encodeJuryParams } from '../src/vector/jury-codec.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';
import { CONFIG, JURY, JURY_HASH, JURY_PARAMS, JURY_REF_UTXO, MODULE1, MODULE1_MANIFEST, MODULE1_UTXOS, ZERO_KEY_ADDRESS } from './fixtures/jury-world.ts';

const V = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/jury-python-vectors.json'), 'utf8'));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** A jury manifest as the Python deploy tool writes it (vector_jury.deployment), for the fixture jury. */
const JURY_MANIFEST = {
  format: 'vector-module1-jury-deployment/1', network: 'mainnet',
  params: {
    identity_hash: JURY_PARAMS.identityHash, m1_claim: JURY_PARAMS.m1Claim, m1_challenge: JURY_PARAMS.m1Challenge,
    treasury: 'addr1wx2yu92dtp70q0stsv8kmnrv284lh836lp0l936x6gsrggshvzzlc', bond_min: 250000000, slash: 25000000, juror_floor: 10000000,
    eligibility_delay: 259200000, exit_notice: 259200000, commit_window: 7200000, reveal_window: 7200000, resolve_margin: 7200000,
    claim_period: 2592000000, quorum: 3, majority_num: 2, majority_den: 3,
  },
  params_cbor: V.params_cbor, script_hash: JURY_HASH, address: JURY.address, reference_script: `${JURY.ref.txHash}#${JURY.ref.outputIndex}`,
  plutus: 'plutus.json', txs: { reference_script: JURY.ref.txHash }, time: '2026-11-09T12:00:00Z', compiler: 'aiken v1.1.21',
};

describe('the environment', () => {
  test('no variable: nothing is configured', () => {
    const s = jurySourcesFrom({});
    assert.deepEqual(s, { module1: null, juries: [] });
    assert.match(describeJurySources(s), /Module-1 not configured \(set VECTOR_MODULE1_MANIFEST.*jury not configured \(set VECTOR_JURY_MANIFESTS/);
  });

  test('file paths and https URLs, comma-separated, the default first', () => {
    const s = jurySourcesFrom({ VECTOR_MODULE1_MANIFEST: ' /etc/vector/m1.json ', VECTOR_JURY_MANIFESTS: 'https://example.org/a.json, ./b.json' });
    assert.deepEqual(s, { module1: '/etc/vector/m1.json', juries: ['https://example.org/a.json', './b.json'] });
  });

  test('an empty entry, a repeated entry and a URL that is not https stop the start', () => {
    assert.throws(() => jurySourcesFrom({ VECTOR_JURY_MANIFESTS: 'a.json,,b.json' }), /VECTOR_JURY_MANIFESTS has an empty entry/);
    assert.throws(() => jurySourcesFrom({ VECTOR_JURY_MANIFESTS: 'a.json,a.json' }), /names one manifest twice/);
    assert.throws(() => jurySourcesFrom({ VECTOR_MODULE1_MANIFEST: 'http://example.org/m1.json' }), /VECTOR_MODULE1_MANIFEST: .* is a URL that is not https/);
  });
});

describe('the Module-1 manifest', () => {
  test('the mainnet manifest gives the mainnet deployment', () => {
    assert.equal(MODULE1.claim.hash, '53f6fc36219a3bc3c8af33c830480cff65aadb51baabb0bf485b4523');
    assert.equal(MODULE1.claim.address, 'addr1w9fldlpkyxdrhs7g4ueusvzgpnlkt2km2xa2hv9lfpd52gcz33v7u');
    assert.equal(MODULE1.challenge.address, 'addr1wxv88w3nfrh0rsnhhntdecnx4cts76928w4xfnu9n58wczqprfdng');
    assert.deepEqual(MODULE1.claim.ref, { txHash: 'a5ad79d3ded0804241649242f03ab5aa22792361d625391ba5d42a58fec08335', outputIndex: 0 });
    assert.deepEqual(MODULE1.crossRefs, { txHash: '72e417cad239afc47626574246ee3a15dd2cddd8bc648f0a21fa290299dc8941', outputIndex: 0 });
    assert.equal(MODULE1.identityHash, 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762');
    assert.equal(MODULE1.oracleVkh, '470ded7c9d487c2c3832af84aea70987b2c9a01480192ebbf035d028');
    assert.deepEqual(MODULE1.protocol, { minClaimStake: 50_000_000n, minChallengeWindow: 1_800_000, maxChallengeWindow: 86_400_000, resolutionDeadline: 259_200_000 });
  });

  test('a manifest of another module, of jury mode, with a wrong address or not oracle_active is refused', () => {
    const bad = (edit: (m: typeof MODULE1_MANIFEST) => void) => { const m = clone(MODULE1_MANIFEST); edit(m); return () => module1FromManifest(m, 'm1.json'); };
    assert.throws(bad((m) => { m.module = 'module3'; }), /is not a Module-1 deployment manifest/);
    assert.throws(bad((m) => { m.mode = 'jury'; }), /runs in mode "jury"/);
    assert.throws(bad((m) => { m.addresses.claim = m.addresses.challenge; }), /the claim script address .* is not addr1w9fldlpk/);
    assert.throws(bad((m) => { m.protocol_params.oracle_active = false; }), /oracle_active is not true/);
    assert.throws(bad((m) => { m.placeholders = ['identity_hash']; }), /is a plan with placeholders/);
    assert.throws(bad((m) => { m.claim_ref = 'a5ad79d3#0'; }), /claim script reference script must be <64 hex characters>#<output index>/);
  });
});

describe('the jury manifest', () => {
  test('a manifest of the Python deploy tool gives the deployment; params_cbor and params agree', () => {
    const jury = juryFromManifest(JURY_MANIFEST, 'jury.json');
    assert.equal(jury.hash, JURY_HASH);
    assert.equal(jury.address, JURY.address);
    assert.deepEqual(jury.ref, JURY.ref);
    assert.deepEqual(jury.params, JURY_PARAMS);
    assert.equal(jury.test, false);
    assert.equal(jury.time, '2026-11-09T12:00:00Z');
  });

  test('a listed parameter that params_cbor does not give, a missing or unknown field, broken rules or a wrong address are refused', () => {
    const bad = (edit: (m: typeof JURY_MANIFEST & Record<string, unknown>) => void) => { const m = clone(JURY_MANIFEST); edit(m); return () => juryFromManifest(m, 'jury.json'); };
    assert.throws(bad((m) => { m.params.bond_min = 1; }), /params\.bond_min is 1, but params_cbor gives 250000000/);
    assert.throws(bad((m) => { m.params.treasury = 'addr1wxv88w3nfrh0rsnhhntdecnx4cts76928w4xfnu9n58wczqprfdng'; }), /params\.treasury/);
    assert.throws(bad((m) => { delete (m.params as Record<string, unknown>).quorum; }), /missing: quorum/);
    assert.throws(bad((m) => { (m.params as Record<string, unknown>).deposit = 1; }), /unknown: deposit/);
    assert.throws(bad((m) => {
      m.params.bond_min = 30_000_000;
      m.params_cbor = encodeJuryParams({ ...JURY_PARAMS, bondMin: 30_000_000n });
    }), /break the rules of SPEC Section 3: bond_min must be at least juror_floor \+ slash/);
    assert.throws(bad((m) => { m.address = MODULE1.claim.address; }), /the jury script address .* is not addr1/);
    assert.throws(bad((m) => { m.format = 'vector-module-deploy/1'; }), /is not a jury deployment manifest/);
    assert.throws(bad((m) => { m.params_cbor = 'd87980'; }), /params_cbor does not decode as JuryParams/);
  });
});

describe('loadJuryConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jury-manifests-'));
  const file = (name: string, json: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(json)); return path; };
  const m1Path = file('module1.json', MODULE1_MANIFEST);
  const juryPath = file('jury.json', JURY_MANIFEST);
  const node = (utxos = [...MODULE1_UTXOS, JURY_REF_UTXO]) => new FixtureProvider(utxos);

  test('reads the files, checks them against each other and the reference scripts against the chain', async () => {
    const config = await loadJuryConfig({ module1: m1Path, juries: [juryPath] }, node(), MODULE1.identityHash);
    assert.equal(config.module1?.claim.hash, MODULE1.claim.hash);
    assert.deepEqual(config.juries.map((j) => j.hash), [JURY_HASH]);
    assert.deepEqual((await loadJuryConfig({ module1: null, juries: [] }, node(), null)), { module1: null, juries: [] });
  });

  test('refuses another identity registry, another Module-1 deployment, a reference script that is gone or holds another script', async () => {
    await assert.rejects(loadJuryConfig({ module1: m1Path, juries: [juryPath] }, node(), 'aa'.repeat(28)), /names the identity registry d958b823.* but this server's identity deployment is aaaa/);
    const other = file('other-m1.json', { ...JURY_MANIFEST, params: { ...JURY_MANIFEST.params, m1_claim: 'bb'.repeat(28) }, params_cbor: encodeJuryParams({ ...JURY_PARAMS, m1Claim: 'bb'.repeat(28) }) });
    await assert.rejects(loadJuryConfig({ module1: m1Path, juries: [other] }, node(), null), /reads another Module-1 deployment/);
    await assert.rejects(loadJuryConfig({ module1: null, juries: [juryPath] }, node(MODULE1_UTXOS), null), /The jury \(.*\) reference script e7e7.*#0 is not an unspent output on the node/);
    const wrong = { ...JURY_REF_UTXO, scriptRef: MODULE1_UTXOS[0].scriptRef };
    await assert.rejects(loadJuryConfig({ module1: null, juries: [juryPath] }, node([wrong]), null), /holds script 53f6fc36.*, not /);
    await assert.rejects(loadJuryConfig({ module1: join(dir, 'missing.json'), juries: [] }, node(), null), /cannot be read/);
  });

  test('two manifests of one deployment are refused', async () => {
    const copy = file('copy.json', JURY_MANIFEST);
    await assert.rejects(loadJuryConfig({ module1: null, juries: [juryPath, copy] }, node(), null), /names one jury deployment twice/);
  });
});

describe('choosing a deployment', () => {
  test('the first by default, or the one that a script hash or an address names', () => {
    const second = { ...JURY, hash: 'cd'.repeat(28), address: ZERO_KEY_ADDRESS };
    const config = { ...CONFIG, juries: [JURY, second] };
    assert.equal(juryOf(config), JURY);
    assert.equal(juryOf(config, 'CD'.repeat(28)), second);
    assert.equal(juryOf(config, ZERO_KEY_ADDRESS), second);
    assert.throws(() => juryOf(config, 'ef'.repeat(28)), /follows no jury deployment/);
  });

  test('the refusals say what to configure', () => {
    assert.throws(() => juryOf({ module1: null, juries: [] }), (err: Error) => err.message === JURY_NOT_CONFIGURED);
    assert.throws(() => requireModule1({ module1: null, juries: [] }), (err: Error) => err.message === MODULE1_NOT_CONFIGURED);
    assert.match(JURY_NOT_CONFIGURED, /set VECTOR_JURY_MANIFESTS/);
  });
});
