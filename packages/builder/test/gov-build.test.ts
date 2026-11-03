// packages/builder/test/gov-build.test.ts
// The Module-6 (self-improvement) builders on the identity registry (Part 2 Section 7): the blueprint and the test deployment, the
// token names and codecs (pinned against the reference client of the module, governance_identity.py at vector-agent-modules 91e3823),
// the GOV_* configuration, the outputs that the validators read, and every builder. Every creation (step 2) completes against the
// applied Module-6 validators of gov-world.ts (Lucid's local evaluation), and the test decodes the transaction. Offline: no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CML, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import {
  DEPLOYMENT, NOW, WINDOW, DAY, CONTROLLER, LISTED, OTHER, OWN_ADDRESS, lucidOn, recordUtxo, rootRecord, testKey,
} from './fixtures/identity-world.ts';
import {
  BLUEPRINT_PATH, CONFIG, CRITIC_CONTROLLER, CRITIC_ID, CROSS_REFS_UTXO, ENDORSER_CONTROLLER, ENDORSER_ID, GOV, GOV_REF_UTXOS,
  PARAMS, PROPOSER_ID, SCRIPTS, TITLES, AGENT_RECORDS, appliedScript, criticRecord, endorserRecord, governanceConfigCbor, govWorld, headUtxo,
  lockUtxo, nodeUtxo, paramsUtxo, proposalUtxo,
} from './fixtures/gov-world.ts';
import {
  ACTIVITY_HEAD_TOKEN, MINT_ENDORSEMENT_TOKEN_REDEEMER, SPEND_ACTIVITY_REDEEMER, SUBMIT_PROPOSAL_REDEEMER, decodeActivityDatum, decodeCritiqueDatum,
  decodeCrossRefs, decodeEndorsementDatum, decodeGovernanceParams, decodeProposalDatum, deriveActivityTokenName, deriveCritiqueTokenName,
  deriveEndorsementTokenName, deriveProposalTokenName, encodeActivityDatum, encodeCritiqueDatum, encodeCrossRefs, encodeEndorsementDatum,
  encodeGovernanceParams, encodeProposalDatum,
} from '../src/vector/gov-codec.ts';
import type { ActivityDatum, CritiqueDatum, EndorsementDatum, ProposalDatum } from '../src/vector/gov-codec.ts';
import {
  GOV_ENV, GOV_NOT_CONFIGURED, GOV_REF_ENV, GovConfigError, PREVIOUS_GOV_DEPLOYMENT, activityListFrom, activityNode, activityPredecessor,
  describeGovDeployment, expectedCrossRefs, findCrossRefs, findParamsRecord, govDeploymentFrom, makeGovDeployment, readGovRefScript,
  resolveProposal, scriptAddress,
} from '../src/vector/gov-deployment.ts';
import type { GovRefName, KoiosAccess } from '../src/vector/gov-deployment.ts';
import {
  DEFAULT_REVIEW_WINDOW_MS, buildCritiqueLock, buildCritiqueSpend, buildEndorseLock, buildEndorseSpend, buildProposalLock, buildProposalSpend,
  proposalTypeFrom,
} from '../src/vector/gov-tx.ts';
import type { GovContext } from '../src/vector/gov-tx.ts';
import { utf8Hex } from '../src/vector/identity-codec.ts';
import { DAYS_7_MS } from '../src/vector/identity-rules.ts';
import { WALLET_ROLE } from '../src/vector/identity-chain.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';

const { lo, hi } = WINDOW;
const common = { changeAddress: OWN_ADDRESS, nowMs: NOW };
const OWN_KEY_HASH = CML.Address.from_bech32(OWN_ADDRESS).payment_cred()!.as_pub_key()!.to_hex();
const refOf = (u: UTxO): string => `${u.txHash}#${u.outputIndex}`;

/** Koios is not part of a test unless it names one: a call fails loudly. */
const NO_KOIOS: KoiosAccess = { url: 'https://koios.example', fetchImpl: (async () => { throw new Error('Koios is not part of this test'); }) as unknown as typeof fetch };

/** A fake Koios that answers tx_info for `txs`: each transaction with the outputs it spent, as [ref, payment credential]. */
function koiosWith(txs: Record<string, Array<[string, string]>>): KoiosAccess & { calls: string[][] } {
  const calls: string[][] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    assert.ok(String(url).endsWith('/api/v1/tx_info'), String(url));
    const hashes = JSON.parse(init.body)._tx_hashes as string[];
    calls.push(hashes);
    const rows = hashes.filter((h) => txs[h]).map((h) => ({
      tx_hash: h, inputs: txs[h].map(([ref, cred]) => ({ tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)), payment_addr: { bech32: 'addr1', cred } })),
    }));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
  return { url: 'https://koios.example', fetchImpl, calls };
}

async function ctxOn(extra: UTxO[], opts: { koios?: KoiosAccess; records?: UTxO[]; params?: typeof PARAMS } = {}): Promise<GovContext> {
  const provider = govWorld(extra, opts);
  return { lucid: await lucidOn(provider), provider, identity: DEPLOYMENT, gov: GOV, koios: opts.koios ?? NO_KOIOS };
}

const proposalDatum = (o: Partial<ProposalDatum> = {}): ProposalDatum => ({
  proposerDid: PROPOSER_ID, proposerCredential: { type: 'VerificationKey', hash: CONTROLLER.keyHash }, proposalHash: 'ab'.repeat(32),
  proposalType: { type: 'GeneralSuggestion' }, storageUri: utf8Hex('ipfs://proposal'), stakeAmount: 25_000_000n, submittedAt: lo,
  reviewWindow: DEFAULT_REVIEW_WINDOW_MS, priority: 'Standard', amendmentCount: 0, incorporatedCritiques: [], state: { type: 'Open' }, ...o,
});
const proposalLock = (d: ProposalDatum = proposalDatum()): UTxO => lockUtxo(GOV.proposalAddress, encodeProposalDatum(d), d.stakeAmount + 2_000_000n);

/** A submitted proposal of PROPOSER_ID with its seed. */
function submitted(o: Partial<ProposalDatum> = {}): { seed: { txHash: string; outputIndex: number }; utxo: UTxO; datum: ProposalDatum } {
  const seed = { txHash: '5e'.repeat(32), outputIndex: 0 };
  const datum = proposalDatum({ submittedAt: NOW - DAY, ...o });
  return { seed, utxo: proposalUtxo(seed, datum, { txHash: 'f1'.repeat(32), outputIndex: 0 }), datum };
}

/** What a test reads back from a built transaction. */
function inspect(txCbor: string) {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const inputs: string[] = [];
  for (let i = 0; i < body.inputs().len(); i++) inputs.push(`${body.inputs().get(i).transaction_id().to_hex()}#${body.inputs().get(i).index()}`);
  const refs: string[] = [];
  const refInputs = body.reference_inputs();
  for (let i = 0; refInputs && i < refInputs.len(); i++) refs.push(`${refInputs.get(i).transaction_id().to_hex()}#${refInputs.get(i).index()}`);
  const signers: string[] = [];
  const required = body.required_signers();
  for (let i = 0; required && i < required.len(); i++) signers.push(required.get(i).to_hex());
  const mint: Record<string, bigint> = {};
  const m = body.mint();
  if (m) {
    const policies = m.keys();
    for (let i = 0; i < policies.len(); i++) {
      const policy = policies.get(i);
      const names = m.get_assets(policy)!;
      for (let j = 0; j < names.keys().len(); j++) mint[`${policy.to_hex()}${names.keys().get(j).to_hex()}`] = BigInt(names.get(names.keys().get(j))!.toString());
    }
  }
  const outputs = [];
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = body.outputs().get(i);
    const assets: Record<string, bigint> = { lovelace: o.amount().coin() };
    const ma = o.amount().multi_asset();
    for (let j = 0; j < ma.keys().len(); j++) {
      const policy = ma.keys().get(j);
      const names = ma.get_assets(policy)!;
      for (let k = 0; k < names.keys().len(); k++) assets[`${policy.to_hex()}${names.keys().get(k).to_hex()}`] = names.get(names.keys().get(k))!;
    }
    outputs.push({ address: o.address().to_bech32(), assets, datum: o.datum()?.as_datum()?.to_cbor_hex() });
  }
  const redeemers = tx.witness_set().redeemers()?.to_flat_format();
  const scripts: Array<{ tag: number; index: number; data: string; mem: bigint; steps: bigint }> = [];
  for (let i = 0; redeemers && i < redeemers.len(); i++) {
    const r = redeemers.get(i);
    scripts.push({ tag: r.tag(), index: Number(r.index()), data: r.data().to_cbor_hex(), mem: r.ex_units().mem(), steps: r.ex_units().steps() });
  }
  return { inputs, refs, signers, mint, outputs, scripts, start: body.validity_interval_start(), ttl: body.ttl() };
}

// ─── Blueprint and test deployment ──────────────────────────────────────────────────────────────────────────────────────────────

describe('the Module-6 blueprint and the test deployment', () => {
  test('the copied blueprint is vector-agent-modules 91e3823 (sha256 pinned), and each unapplied script has its stated hash', () => {
    const text = readFileSync(BLUEPRINT_PATH, 'utf8');
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), '6560ff0c79fc5205cf54c2a76b58322d0ed7eb9aea6d6b5e3b324c46f2e88be1');
    const blueprint = JSON.parse(text) as { validators: Array<{ title: string; compiledCode: string; hash: string; parameters?: unknown[] }> };
    for (const title of Object.values(TITLES)) {
      const v = blueprint.validators.find((x) => x.title === title)!;
      assert.equal(validatorToScriptHash({ type: 'PlutusV3', script: v.compiledCode }), v.hash, title);
      assert.equal(v.parameters?.length, 1, `${title} takes the GovernanceConfig only`);
    }
  });

  test('the test GovernanceConfig is the CBOR that the Module-6 deploy script writes (deploy_common.build_governance_config_cbor)', () => {
    assert.equal(governanceConfigCbor(), `d8798b581c${'7b'.repeat(28)}581c${'00'.repeat(28)}581c${'00'.repeat(28)}581c${'00'.repeat(28)}581c${'4b'.repeat(28)}581c${'4a'.repeat(28)}581c${'4c'.repeat(28)}581c${'00'.repeat(28)}581c${'00'.repeat(28)}581c${'7a'.repeat(28)}581c${DEPLOYMENT.identity.hash}`);
  });

  test('the applied validators have the hashes and sizes that `aiken blueprint apply` gives for that config (aiken v1.1.21)', () => {
    const expected: Record<GovRefName, [string, number]> = {
      proposalSpend: ['4082a2102e097b0f66b8b99e424e1e8b952dec6cdf5e4f7ead2086f1', 13_699],
      proposalMint: ['e386de52b661f9468de6c7182685ea3aee3cc352aff3f1f845eab89f', 1_484],
      critiqueSpend: ['a699b4dccd4debf3f0a5314c2b0b7cb16b362d373e1596479a8c690d', 9_018],
      critiqueMint: ['09e0b2763187f4b5212e4ed8ee31b21a39ee1e31db850e8c976da0d3', 2_140],
      endorsementSpend: ['726a9ec406a52023f833bfa44106fa423c7da4833b7a5259f225e6d1', 7_547],
    };
    assert.equal(DEPLOYMENT.identity.hash, '97cb4743670c9781d8d5cd7ce4474c4ff50d33a362c68e39aa49872f', 'the config names the identity hash of identity-world');
    for (const [name, [hash, size]] of Object.entries(expected) as Array<[GovRefName, [string, number]]>) {
      assert.equal(GOV[name], hash, name);
      assert.equal(SCRIPTS[name].script.length / 2, size, name);
    }
    assert.notEqual(validatorToScriptHash(appliedScript(TITLES.proposalSpend, governanceConfigCbor({ ...CONFIG, identityHash: 'ee'.repeat(28) }))), GOV.proposalSpend, 'the identity hash is part of the script');
  });
});

// ─── Token names and codecs ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('token names follow utils.ak', () => {
  const golden = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/gov-state.fixture.json'), 'utf8')).goldenTokenPin;
  const seed = { txHash: golden.lockTxHash as string, outputIndex: golden.lockOutputIndex as number };

  test('prop_: the token name that the proposal policy of the previous deployment minted for this seed (captured live 2026-07-30)', () => {
    assert.equal(deriveProposalTokenName(seed.txHash, seed.outputIndex), golden.expectedTokenName);
  });

  test('crit_, gend_ and pact_ equal the names of the reference client (governance_identity.py)', () => {
    assert.equal(deriveCritiqueTokenName(seed.txHash, seed.outputIndex), '637269745f1a38676b49274bb694b9677f8b17af728bb4fca74bfd3572049bfe');
    assert.equal(deriveEndorsementTokenName('a3'.repeat(32), seed), '67656e645f476a5dee08c598b49ad026da95d25186a0360ab551f46a1c687588');
    assert.equal(deriveActivityTokenName('a1'.repeat(32)), '706163745ff65ecdfc7dc414d7816eb3b9248488094e00fb6b69e67da0509cb6');
  });
});

describe('codecs write the bytes of the reference client', () => {
  const credential = { type: 'VerificationKey' as const, hash: '2c'.repeat(28) };
  const seed = { txHash: '0b4015bd69ef9e93a7eafdc778433ea1d1acb4f8ab7b2efaa52990b65415e919', outputIndex: 0 };
  const at = 1_763_207_940_000;

  test('ProposalDatum (12 fields; a ParameterChange, amended, with an incorporated critique)', () => {
    const d: ProposalDatum = {
      proposerDid: 'a1'.repeat(32), proposerCredential: credential, proposalHash: 'ab'.repeat(32),
      proposalType: { type: 'ParameterChange', paramName: utf8Hex('MIN_PROPOSAL_STAKE'), currentValue: 25_000_000n, proposedValue: 30_000_000n },
      storageUri: utf8Hex('ipfs://doc'), stakeAmount: 25_000_000n, submittedAt: at, reviewWindow: 604_800_000, priority: 'Standard', amendmentCount: 1,
      incorporatedCritiques: [{ txHash: 'c1'.repeat(32), outputIndex: 3 }], state: { type: 'Amended', hash: 'cd'.repeat(32) },
    };
    const hex = 'd8799f5820a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1d8799f581c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2cff5820ababababababababababababababababababababababababababababababababd8799f524d494e5f50524f504f53414c5f5354414b451a017d78401a01c9c380ff4a697066733a2f2f646f631a017d78401b0000019a876207a01a240c8400d87980019fd8799f5820c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c103ffffd87a9f5820cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdffff';
    assert.equal(encodeProposalDatum(d), hex);
    assert.deepEqual(decodeProposalDatum(hex), d);
  });

  test('CritiqueDatum (9 fields; an incorporated Amendment critique that names the seed)', () => {
    const d: CritiqueDatum = {
      criticDid: 'a2'.repeat(32), criticCredential: credential, proposalRef: seed, critiqueHash: 'ef'.repeat(32), storageUri: utf8Hex('ipfs://crit'),
      critiqueType: { type: 'Amendment', suggestedChangeHash: 'ef'.repeat(32) }, stakeAmount: 10_000_000n, submittedAt: at, incorporated: true,
    };
    const hex = 'd8799f5820a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2d8799f581c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2cffd8799f58200b4015bd69ef9e93a7eafdc778433ea1d1acb4f8ab7b2efaa52990b65415e91900ff5820efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef4b697066733a2f2f63726974d87b9f5820efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefff1a009896801b0000019a876207a0d87a80ff';
    assert.equal(encodeCritiqueDatum(d), hex);
    assert.deepEqual(decodeCritiqueDatum(hex), d);
  });

  test('GovernanceEndorsementDatum (5 fields) and ProposerActivityDatum (5 fields, next_did last; the head has empty identifiers)', () => {
    const e: EndorsementDatum = { endorserDid: 'a3'.repeat(32), endorserCredential: credential, proposalRef: seed, stakeAmount: 5_000_000n, createdAt: at };
    const eHex = 'd8799f5820a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3d8799f581c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2cffd8799f58200b4015bd69ef9e93a7eafdc778433ea1d1acb4f8ab7b2efaa52990b65415e91900ff1a004c4b401b0000019a876207a0ff';
    assert.equal(encodeEndorsementDatum(e), eHex);
    assert.deepEqual(decodeEndorsementDatum(eHex), e);
    const a: ActivityDatum = { agentDid: 'a1'.repeat(32), agentCredential: credential, activeProposalCount: 2, lastProposalSlot: at, nextDid: 'a9'.repeat(32) };
    const aHex = 'd8799f5820a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1d8799f581c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2cff021b0000019a876207a05820a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9ff';
    assert.equal(encodeActivityDatum(a), aHex);
    assert.deepEqual(decodeActivityDatum(aHex), a);
    assert.equal(decodeActivityDatum(headUtxo().datum!).agentDid, '');
    assert.equal(encodeActivityDatum({ agentDid: '', agentCredential: { type: 'VerificationKey', hash: '4d'.repeat(28) }, activeProposalCount: 0, lastProposalSlot: 0, nextDid: '' }),
      'd8799f40d8799f581c4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4dff000040ff');
  });

  test('GovernanceParams (21 fields) and GovernanceCrossRefs (5 fields; a 4-field datum of an older deployment is refused)', () => {
    const pHex = 'd8799f1a017d78401a004c4b401a004c4b401a0f7314001a9032100005031a05265c00191b581907d01903e81a02faf0801a1dcd6500051b00000002540be4001913881a02932e001a240c84001a05f5e1001a1dcd65001a0bebc200ff';
    assert.equal(encodeGovernanceParams(PARAMS), pHex);
    assert.deepEqual(decodeGovernanceParams(pHex), PARAMS);
    const r = { proposalValidatorHash: '11'.repeat(28), critiqueValidatorHash: '22'.repeat(28), proposalMintHash: '33'.repeat(28), critiqueMintHash: '44'.repeat(28), endorsementValidatorHash: '55'.repeat(28) };
    const rHex = `d8799f581c${'11'.repeat(28)}581c${'22'.repeat(28)}581c${'33'.repeat(28)}581c${'44'.repeat(28)}581c${'55'.repeat(28)}ff`;
    assert.equal(encodeCrossRefs(r), rHex);
    assert.deepEqual(decodeCrossRefs(rHex), r);
    assert.throws(() => decodeCrossRefs(`d8799f581c${'11'.repeat(28)}581c${'22'.repeat(28)}581c${'33'.repeat(28)}581c${'44'.repeat(28)}ff`), /expected 5 fields, got 4/);
  });

  test('a proposal datum of the previous deployment (captured live) decodes, so the read tools can list old positions', () => {
    const sample = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'fixtures/gov-state.fixture.json'), 'utf8')).sampleProposal;
    const d = decodeProposalDatum(sample.datumCbor);
    assert.equal(d.state.type, 'Open');
    assert.equal(d.proposalType.type, 'GeneralSuggestion');
    assert.equal(d.stakeAmount, 25_000_000n);
    assert.equal(d.proposerDid.length, 64);
  });
});

// ─── Configuration ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the Module-6 deployment from GOV_* (no defaults)', () => {
  const env = (): Record<string, string> => ({
    GOV_PROPOSAL_SPEND_HASH: GOV.proposalSpend, GOV_PROPOSAL_MINT_HASH: GOV.proposalMint, GOV_CRITIQUE_SPEND_HASH: GOV.critiqueSpend,
    GOV_CRITIQUE_MINT_HASH: GOV.critiqueMint, GOV_ENDORSEMENT_SPEND_HASH: GOV.endorsementSpend, GOV_RECORD_TOKEN_POLICY: GOV.recordTokenPolicy,
    GOV_REFS_TOKEN_POLICY: GOV.refsTokenPolicy, GOV_PARAMS_ADDRESS: GOV.paramsAddress, GOV_CROSSREFS_ADDRESS: GOV.crossRefsAddress,
    GOV_TREASURY_ADDRESS: GOV.treasuryAddress,
  });

  test('no GOV_* variable: no deployment, and the startup line says so', () => {
    assert.equal(govDeploymentFrom({}), null);
    assert.equal(govDeploymentFrom({ GOV_PROPOSAL_SPEND_HASH: '  ' }), null);
    assert.match(describeGovDeployment(null), /^not configured/);
    assert.match(GOV_NOT_CONFIGURED, /GOV_PROPOSAL_SPEND_HASH, .*GOV_TREASURY_ADDRESS to the values of its deploy state/);
  });

  test('every value: the deployment with its script addresses and the reference UTxOs that are set', () => {
    const d = govDeploymentFrom({ ...env(), GOV_PROPOSAL_SPEND_REF: `${'E6'.repeat(32)}#0`, GOV_CRITIQUE_MINT_REF: `${'e6'.repeat(32)}#3` })!;
    assert.equal(d.proposalAddress, scriptAddress(GOV.proposalSpend));
    assert.equal(d.critiqueAddress, scriptAddress(GOV.critiqueSpend));
    assert.equal(d.endorsementAddress, scriptAddress(GOV.endorsementSpend));
    assert.deepEqual(d.refs, { proposalSpend: { txHash: 'e6'.repeat(32), outputIndex: 0 }, critiqueMint: { txHash: 'e6'.repeat(32), outputIndex: 3 } });
    assert.match(describeGovDeployment(d), new RegExp(`proposal validator ${GOV.proposalSpend}.*proposalSpend set, proposalMint unset`));
  });

  test('a partial set names the missing variables; a malformed value names its variable', () => {
    const partial = env();
    delete partial.GOV_RECORD_TOKEN_POLICY;
    delete partial.GOV_TREASURY_ADDRESS;
    assert.throws(() => govDeploymentFrom(partial), (e: unknown) => e instanceof GovConfigError && /but GOV_RECORD_TOKEN_POLICY, GOV_TREASURY_ADDRESS are not/.test(e.message));
    assert.throws(() => govDeploymentFrom({ GOV_PROPOSAL_SPEND_REF: `${'e6'.repeat(32)}#0` }), /set every value of the Module-6 deployment/);
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_CRITIQUE_MINT_HASH: 'xyz' }), /GOV_CRITIQUE_MINT_HASH must be 56 hex characters/);
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_REFS_TOKEN_POLICY: '00'.repeat(28) }), /GOV_REFS_TOKEN_POLICY is all zero/);
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_PARAMS_ADDRESS: OWN_ADDRESS }), /GOV_PARAMS_ADDRESS must be a script address/);
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_CROSSREFS_ADDRESS: 'not-an-address' }), /GOV_CROSSREFS_ADDRESS is not a valid address/);
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_ENDORSEMENT_SPEND_REF: 'abc#0' }), /GOV_ENDORSEMENT_SPEND_REF must be <64 hex characters>#<output index>/);
  });

  test('the values of the previous deployment are refused: they read the legacy agent registry', () => {
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_PROPOSAL_SPEND_HASH: PREVIOUS_GOV_DEPLOYMENT.proposalSpend }), /GOV_PROPOSAL_SPEND_HASH is a hash of the previous Module-6 deployment/);
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_CRITIQUE_MINT_HASH: PREVIOUS_GOV_DEPLOYMENT.critiqueMint }), /previous Module-6 deployment/);
    assert.throws(() => govDeploymentFrom({ ...env(), GOV_TREASURY_ADDRESS: PREVIOUS_GOV_DEPLOYMENT.treasuryAddress }), /GOV_TREASURY_ADDRESS is the treasury of the previous Module-6 deployment/);
  });

  test('readGovRefScript names the variable of a reference script that is unset, gone, empty or another script', async () => {
    const world = govWorld();
    assert.equal(validatorToScriptHash((await readGovRefScript(world, GOV, 'critiqueMint')).scriptRef!), GOV.critiqueMint);
    const unset = makeGovDeployment({ ...GOV, refs: {} });
    await assert.rejects(readGovRefScript(world, unset, 'proposalSpend'), (e: unknown) => e instanceof GovConfigError && /GOV_PROPOSAL_SPEND_REF is not set/.test(e.message));
    const swapped = makeGovDeployment({ ...GOV, refs: { ...GOV.refs, proposalMint: GOV.refs.critiqueMint } });
    await assert.rejects(readGovRefScript(world, swapped, 'proposalMint'), new RegExp(`\\(GOV_PROPOSAL_MINT_REF\\) holds script ${GOV.critiqueMint}, not ${GOV.proposalMint}`));
    await assert.rejects(readGovRefScript(new FixtureProvider([]), GOV, 'endorsementSpend'), /\(GOV_ENDORSEMENT_SPEND_REF\) is not an unspent output on the node/);
    const empty = new FixtureProvider(GOV_REF_UTXOS.map((u) => ({ ...u, scriptRef: undefined })));
    await assert.rejects(readGovRefScript(empty, GOV, 'critiqueSpend'), /\(GOV_CRITIQUE_SPEND_REF\) holds no script/);
    assert.equal(GOV_REF_ENV.endorsementSpend, 'GOV_ENDORSEMENT_SPEND_REF');
    assert.equal(GOV_ENV.paramsAddress, 'GOV_PARAMS_ADDRESS');
  });
});

// ─── Records that the validators read ───────────────────────────────────────────────────────────────────────────────────────────

describe('the params record, CrossRefs and the activity list', () => {
  test('the params record is the output with the `params` record token; another output at the holder is ignored', async () => {
    const r = await findParamsRecord(govWorld(), GOV);
    assert.deepEqual(r.params, PARAMS);
    const fake = { ...paramsUtxo({ ...PARAMS, minProposalStake: 1n }), assets: { lovelace: 3_000_000n } };
    const world = govWorld([]);
    const onlyFake = { ...world, getUtxos: async (a: string) => (a === GOV.paramsAddress ? [fake] : world.getUtxos(a)) };
    await assert.rejects(findParamsRecord(onlyFake, GOV), /No GovernanceParams record at .* record token (7a){28}\.params \(GOV_RECORD_TOKEN_POLICY\)/);
  });

  test('CrossRefs: the 5-field datum that names the five validators; a 4-field or foreign datum never matches', async () => {
    assert.deepEqual((await findCrossRefs(govWorld(), GOV)).refs, expectedCrossRefs(GOV));
    const old = { ...CROSS_REFS_UTXO, datum: `d8799f581c${GOV.proposalSpend}581c${GOV.critiqueSpend}581c${GOV.proposalMint}581c${GOV.critiqueMint}ff` };
    const other = { ...CROSS_REFS_UTXO, txHash: 'c6'.repeat(32), datum: encodeCrossRefs({ ...expectedCrossRefs(GOV), endorsementValidatorHash: '55'.repeat(28) }) };
    const world = govWorld();
    const stale = { ...world, getUtxos: async (a: string) => (a === GOV.crossRefsAddress ? [old, other] : world.getUtxos(a)) };
    await assert.rejects(findCrossRefs(stale, GOV), /No CrossRefs output of this deployment .* endorsement_spend [0-9a-f]{56} \(the 5-field GovernanceCrossRefs\)/);
  });

  test('the list walks from the head in ascending order; the predecessor of a new agent and the node of a known one', () => {
    const [x, y] = ['90'.repeat(32), 'b0'.repeat(32)];
    const list = activityListFrom([nodeUtxo(y), headUtxo(x), nodeUtxo(x, { nextDid: y }), proposalLock()], GOV);
    assert.deepEqual(list.nodes.map((n) => n.datum.agentDid), [x, y]);
    assert.equal(activityPredecessor(list, PROPOSER_ID).datum.agentDid, x, 'x < a1.. < y');
    assert.equal(activityPredecessor(list, '10'.repeat(32)), list.head, 'below every node: after the head');
    assert.equal(activityPredecessor(list, 'f0'.repeat(32)).datum.agentDid, y, 'above every node: after the last');
    assert.equal(activityNode(list, y)?.datum.agentDid, y);
    assert.throws(() => activityPredecessor(list, x), /already has a node in the activity list; its next submission spends that node/);
  });

  test('a list that the contract cannot produce is refused', () => {
    const [x, y] = ['90'.repeat(32), 'b0'.repeat(32)];
    assert.throws(() => activityListFrom([nodeUtxo(x)], GOV), /No head of the activity list at .*record token (7a){28}\.activity/);
    assert.throws(() => activityListFrom([headUtxo(), { ...headUtxo(), txHash: 'ae'.repeat(32) }], GOV), /Several outputs hold the activity record token/);
    assert.throws(() => activityListFrom([headUtxo(x)], GOV), /names did:vector:9090.*, which has no node/);
    assert.throws(() => activityListFrom([headUtxo(y), nodeUtxo(y, { nextDid: x }), nodeUtxo(x)], GOV), /not in ascending order/);
    assert.throws(() => activityListFrom([headUtxo(), nodeUtxo(x)], GOV), /not in the list that starts at the head/);
    const wrongToken = { ...nodeUtxo(x), assets: { lovelace: 2_000_000n, [`${GOV.proposalMint}${deriveActivityTokenName(y)}`]: 1n } };
    assert.throws(() => activityListFrom([headUtxo(x), wrongToken], GOV), /holds an activity token but is not the node of its agent/);
    const headWithToken = { ...headUtxo(), assets: { ...headUtxo().assets, [`${GOV.proposalMint}${deriveActivityTokenName(x)}`]: 1n } };
    assert.throws(() => activityListFrom([headWithToken], GOV), /not a valid head of the activity list/);
  });
});

describe('a critique or an endorsement names its proposal by the seed', () => {
  const { seed, utxo, datum } = submitted();
  const SPEND = GOV.proposalSpend;

  test('the seed itself: the proposal that holds its token, without Koios', async () => {
    const t = await resolveProposal(govWorld([utxo]), GOV, seed, NO_KOIOS);
    assert.deepEqual(t.seed, seed);
    assert.equal(refOf(t.utxo), refOf(utxo));
    assert.deepEqual(t.datum, datum);
  });

  test('the current output: the seed is the input of its submission whose token name matches (one tx_info call)', async () => {
    const koios = koiosWith({ [utxo.txHash]: [[`${'ad'.repeat(32)}#0`, SPEND], [refOf({ ...utxo, ...seed }), SPEND], [`${'77'.repeat(32)}#1`, OWN_KEY_HASH]] });
    const t = await resolveProposal(govWorld([utxo]), GOV, { txHash: utxo.txHash, outputIndex: 0 }, koios);
    assert.deepEqual(t.seed, seed);
    assert.deepEqual(koios.calls, [[utxo.txHash]]);
  });

  test('an amended proposal: back through the amendment to the submission (two calls)', async () => {
    const amended = proposalUtxo(seed, proposalDatum({ amendmentCount: 1, state: { type: 'Amended', hash: 'ab'.repeat(32) } }), { txHash: 'f2'.repeat(32), outputIndex: 0 });
    const koios = koiosWith({
      [amended.txHash]: [[refOf(utxo), SPEND], [`${'c9'.repeat(32)}#0`, GOV.critiqueSpend]],
      [utxo.txHash]: [[`${seed.txHash}#${seed.outputIndex}`, SPEND], [`${'ad'.repeat(32)}#0`, SPEND]],
    });
    const t = await resolveProposal(govWorld([amended]), GOV, { txHash: amended.txHash, outputIndex: 0 }, koios);
    assert.deepEqual(t.seed, seed);
    assert.deepEqual(koios.calls, [[amended.txHash], [utxo.txHash]]);
  });

  test('a lock, an unknown output and a Koios that does not know the transaction are refused', async () => {
    const lock = proposalLock();
    await assert.rejects(resolveProposal(govWorld([lock]), GOV, { txHash: lock.txHash, outputIndex: 0 }, NO_KOIOS), /holds no proposal token: it is a proposal lock/);
    await assert.rejects(resolveProposal(govWorld([]), GOV, { txHash: '99'.repeat(32), outputIndex: 0 }, NO_KOIOS), /is neither a proposal of this Module-6 deployment nor the seed of one/);
    await assert.rejects(resolveProposal(govWorld([utxo]), GOV, { txHash: utxo.txHash, outputIndex: 0 }, koiosWith({})), /Koios does not know the transaction f1f1.* yet/);
  });
});

// ─── Proposal ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildProposalLock (step 1): every submission rule before the lock', () => {
  const lock = (o: Partial<Parameters<typeof buildProposalLock>[1]> = {}, extra: UTxO[] = [headUtxo()], opts = {}) => ctxOn(extra, opts).then((ctx) => buildProposalLock(ctx, {
    ...common, agentDid: `did:vector:${PROPOSER_ID}`, credentialKeyHash: CONTROLLER.keyHash, proposalType: 'GeneralSuggestion', stakeApex: 25,
    proposalHash: 'ab'.repeat(32), storageUri: 'ipfs://proposal', ...o,
  }));

  test('locks the datum with stake + 2 AP3X at the proposal validator; only the wallet signs; a first proposal', async () => {
    const r = await lock();
    const tx = inspect(r.txCbor);
    const out = tx.outputs[r.lockOutputIndex];
    assert.equal(out.address, GOV.proposalAddress);
    assert.deepEqual(out.assets, { lovelace: 27_000_000n });
    assert.deepEqual(decodeProposalDatum(out.datum!), {
      ...proposalDatum(), proposerCredential: { type: 'VerificationKey', hash: CONTROLLER.keyHash }, submittedAt: lo,
    });
    assert.deepEqual(r.requiredSigners, [{ keyHash: OWN_KEY_HASH, roles: [WALLET_ROLE] }]);
    assert.equal(tx.signers.length, 0);
    assert.equal(tx.scripts.length, 0, 'a lock runs no script');
    assert.equal(r.firstProposal, true);
    assert.equal(r.reviewWindow, DAYS_7_MS);
    assert.equal(r.credentialRole, `controller key of did:vector:${PROPOSER_ID}`);
    assert.equal(r.validFrom, lo);
    assert.equal(r.validTo, hi);
  });

  test('every DID form names the agent; a listed transaction key is a declared credential', async () => {
    for (const agentDid of [PROPOSER_ID, `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${PROPOSER_ID}`]) {
      assert.equal((await lock({ agentDid })).id, PROPOSER_ID, agentDid);
    }
    const r = await lock({ credentialKeyHash: LISTED.keyHash });
    assert.equal(r.credentialRole, `listed transaction key of did:vector:${PROPOSER_ID}`);
    assert.equal(r.datum.proposerCredential.hash, LISTED.keyHash);
  });

  test('the type parameters follow the contract; an Emergency proposal takes the emergency window and stake', async () => {
    const change = await lock({ proposalType: 'ParameterChange', typeParams: { paramName: 'MIN_CRITIQUE_STAKE', currentValue: 5_000_000, proposedValue: 4_000_000 } });
    assert.deepEqual(change.datum.proposalType, { type: 'ParameterChange', paramName: utf8Hex('MIN_CRITIQUE_STAKE'), currentValue: 5_000_000n, proposedValue: 4_000_000n });
    await assert.rejects(lock({ proposalType: 'ParameterChange', typeParams: { paramName: 'NOT_A_PARAM', currentValue: 1, proposedValue: 2 } }), /"NOT_A_PARAM" is not a governable parameter/);
    await assert.rejects(lock({ proposalType: 'TreasurySpend', typeParams: { amount: 10_000_000_001, recipientDescription: 'x' } }), /the treasury amount must be more than 0 and at most 10000000000 lovelace/);
    await assert.rejects(lock({ proposalType: 'ProtocolUpgrade', typeParams: { upgradeHash: 'ab' } }), /ProtocolUpgrade requires upgradeHash/);
    await assert.rejects(lock({ proposalType: 'GameActivation', typeParams: { gameId: 0 } }), /the game id must be positive/);
    const emergency = await lock({ proposalType: 'ProtocolUpgrade', typeParams: { upgradeHash: 'ee'.repeat(32) }, priority: 'Emergency', stakeApex: 125 });
    assert.equal(emergency.reviewWindow, 43_200_000);
    assert.equal(emergency.datum.priority, 'Emergency');
    await assert.rejects(lock({ priority: 'Emergency', stakeApex: 125 }), /an Emergency proposal must be a ParameterChange or a ProtocolUpgrade/);
    await assert.rejects(lock({ proposalType: 'ProtocolUpgrade', typeParams: { upgradeHash: 'ee'.repeat(32) }, priority: 'Emergency', stakeApex: 124 }), /stake of an Emergency proposal is below the minimum of 125\.000000 AP3X/);
  });

  test('refuses an agent that is not Active, a key that is not declared, and an agent without a record', async () => {
    const suspended = rootRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 6, since: NOW - DAY, until: NOW + DAY }] } });
    await assert.rejects(lock({}, [headUtxo()], { records: [recordUtxo(PROPOSER_ID, suspended)] }), /The proposer did:vector:a1a1.* is Suspended over the validity window/);
    await assert.rejects(lock({ credentialKeyHash: OTHER.keyHash }), new RegExp(`The key hash ${OTHER.keyHash} is not a declared credential of did:vector:${PROPOSER_ID}`));
    await assert.rejects(lock({ credentialKeyHash: undefined }), new RegExp(`The key hash ${OWN_KEY_HASH} is not a declared credential`), 'the default credential is the wallet key');
    await assert.rejects(lock({ agentDid: 'cd'.repeat(32) }), /No identity record of the proposer for did:vector:cdcd.* in the identity registry/);
    const noTransaction = rootRecord({ keys: [{ keyType: 'Ed25519', key: LISTED.publicKey, purposes: 1 + 2, pop: null }] });
    await assert.rejects(lock({ credentialKeyHash: LISTED.keyHash }, [headUtxo()], { records: [recordUtxo(PROPOSER_ID, noTransaction)] }), /is not a declared credential/);
  });

  test('refuses a broken rate limit and a missing activity list; the stake and document rules come first', async () => {
    await assert.rejects(lock({}, [headUtxo(PROPOSER_ID), nodeUtxo(PROPOSER_ID, { activeProposalCount: 3 })]), /has 3 active proposals; the limit is 3/);
    await assert.rejects(lock({}, [headUtxo(PROPOSER_ID), nodeUtxo(PROPOSER_ID, { lastProposalSlot: NOW - 3_600_000 })]), /the proposal cooldown of did:vector:a1a1.* ends at/);
    const later = await lock({}, [headUtxo(PROPOSER_ID), nodeUtxo(PROPOSER_ID)]);
    assert.equal(later.firstProposal, false);
    await assert.rejects(lock({}, []), /No head of the activity list/);
    await assert.rejects(lock({ stakeApex: 24 }), /Proposal stake must be at least 25 AP3X/);
    await assert.rejects(lock({ proposalHash: 'ab' }), /proposalHash must be 64 hex characters/);
    await assert.rejects(lock({ storageUri: undefined }), /storageUri is required/);
    await assert.rejects(lock({}, [headUtxo()], { params: { ...PARAMS, minProposalStake: 30_000_000n } }), /the stake is below the minimum of 30\.000000 AP3X/);
  });

  test('a document is uploaded only after every check passes (Filebase is not configured in the tests)', async () => {
    await assert.rejects(lock({ proposalDocument: '{"title":"x"}', proposalHash: undefined, storageUri: undefined }), /Filebase not configured/);
    await assert.rejects(lock({ proposalDocument: '{"title":"x"}', credentialKeyHash: OTHER.keyHash }), /is not a declared credential/);
  });

  test('proposalTypeFrom refuses parameters that are not whole numbers', () => {
    assert.throws(() => proposalTypeFrom('ParameterChange', { paramName: 'JURY_SIZE', currentValue: 1.5, proposedValue: 2 }), /whole numbers/);
    assert.throws(() => proposalTypeFrom('TreasurySpend', { amount: 1 }), /TreasurySpend requires amount/);
  });
});

describe('buildProposalSpend (step 2), evaluated by the applied validators', () => {
  const spend = async (extra: UTxO[], lockUtxoOf: UTxO, o: { agentDid?: string; records?: UTxO[]; validMinutes?: number } = {}) => {
    const ctx = await ctxOn([lockUtxoOf, ...extra], { records: o.records });
    return buildProposalSpend(ctx, { ...common, agentDid: o.agentDid ?? PROPOSER_ID, lockTxHash: lockUtxoOf.txHash, lockOutputIndex: 0, validMinutes: o.validMinutes });
  };

  test('a first submission after the head: the proposal, the new node and the head with next_did = the agent', async () => {
    const locked = proposalLock(proposalDatum({ submittedAt: NOW - DAY }));
    const head = headUtxo();
    const r = await spend([head], locked);
    const tx = inspect(r.txCbor);
    const propUnit = `${GOV.proposalMint}${deriveProposalTokenName(locked.txHash, 0)}`;
    const actUnit = `${GOV.proposalMint}${deriveActivityTokenName(PROPOSER_ID)}`;
    assert.deepEqual(tx.mint, { [actUnit]: 1n, [propUnit]: 1n });
    assert.deepEqual(new Set(tx.inputs.filter((i) => i === refOf(locked) || i === refOf(head))), new Set([refOf(locked), refOf(head)]));
    const proposal = tx.outputs.find((o) => o.assets[propUnit] === 1n)!;
    assert.equal(r.position, `${r.txHash}#${tx.outputs.indexOf(proposal)}`);
    assert.deepEqual(proposal.assets, { lovelace: 27_000_000n, [propUnit]: 1n });
    assert.deepEqual(decodeProposalDatum(proposal.datum!), proposalDatum({ submittedAt: lo }), 'submitted_at = lo of the creation');
    const node = tx.outputs.find((o) => o.assets[actUnit] === 1n)!;
    assert.equal(node.address, GOV.proposalAddress);
    assert.deepEqual(decodeActivityDatum(node.datum!), { agentDid: PROPOSER_ID, agentCredential: { type: 'VerificationKey', hash: CONTROLLER.keyHash }, activeProposalCount: 1, lastProposalSlot: lo, nextDid: '' });
    const continued = tx.outputs.find((o) => o.assets[`${CONFIG.recordTokenPolicy}${ACTIVITY_HEAD_TOKEN}`] === 1n)!;
    assert.deepEqual(decodeActivityDatum(continued.datum!), { ...decodeActivityDatum(head.datum!), nextDid: PROPOSER_ID });
    assert.ok(continued.assets.lovelace >= head.assets.lovelace);
    assert.deepEqual(new Set(tx.refs), new Set([...GOV_REF_UTXOS.slice(0, 2).map(refOf), refOf(AGENT_RECORDS[0]), refOf(paramsUtxo()), refOf(CROSS_REFS_UTXO)]));
    assert.deepEqual(tx.signers, [CONTROLLER.keyHash]);
    assert.deepEqual(r.requiredSigners, [
      { keyHash: CONTROLLER.keyHash, roles: [`proposer credential (controller key of did:vector:${PROPOSER_ID})`] },
      { keyHash: OWN_KEY_HASH, roles: [WALLET_ROLE] },
    ]);
    assert.equal(tx.scripts.length, 3, 'two spends and one mint');
    assert.ok(tx.scripts.every((s) => s.mem > 0n && s.steps > 0n), 'the scripts ran (local evaluation)');
    assert.equal(r.seed, refOf(locked));
    assert.equal(r.inserted, true);
    assert.equal(r.predecessor, 'head');
    assert.equal(r.validTo - r.validFrom, 31 * 60_000);
  });

  test('an insertion between two nodes spends the predecessor node and keeps its value and tokens', async () => {
    const [x, y] = ['90'.repeat(32), 'b0'.repeat(32)];
    const nx = nodeUtxo(x, { nextDid: y });
    const r = await spend([headUtxo(x), nx, nodeUtxo(y)], proposalLock());
    const tx = inspect(r.txCbor);
    assert.equal(r.predecessor, `did:vector:${x}`);
    const continued = tx.outputs.find((o) => o.assets[`${GOV.proposalMint}${deriveActivityTokenName(x)}`] === 1n)!;
    assert.deepEqual(decodeActivityDatum(continued.datum!), { ...decodeActivityDatum(nx.datum!), nextDid: PROPOSER_ID });
    const fresh = tx.outputs.find((o) => o.assets[`${GOV.proposalMint}${deriveActivityTokenName(PROPOSER_ID)}`] === 1n)!;
    assert.equal(decodeActivityDatum(fresh.datum!).nextDid, y, 'the new node takes the next_did of its predecessor');
    assert.ok(tx.inputs.includes(refOf(nx)));
  });

  test('a later submission spends the agent\'s node: count plus one, last_proposal_slot = lo, only the proposal token', async () => {
    const node = nodeUtxo(PROPOSER_ID, { activeProposalCount: 2, agentCredential: { type: 'VerificationKey', hash: CONTROLLER.keyHash } });
    const locked = proposalLock();
    const r = await spend([headUtxo(PROPOSER_ID), node], locked);
    const tx = inspect(r.txCbor);
    assert.deepEqual(tx.mint, { [`${GOV.proposalMint}${deriveProposalTokenName(locked.txHash, 0)}`]: 1n });
    const continued = tx.outputs.find((o) => o.assets[`${GOV.proposalMint}${deriveActivityTokenName(PROPOSER_ID)}`] === 1n)!;
    assert.deepEqual(decodeActivityDatum(continued.datum!), { ...decodeActivityDatum(node.datum!), activeProposalCount: 3, lastProposalSlot: lo });
    assert.equal(r.inserted, false);
    assert.equal(r.activeProposals, 3);
  });

  test('a subagent: its parent record is a reference input too', async () => {
    const SUB = 'a5'.repeat(32);
    const sub = rootRecord({ controller: testKey(14).publicKey, keys: [], endpoint: '', lineage: { type: 'Subagent', parent: PROPOSER_ID, parentEpoch: 0, depth: 1 } });
    const records = [recordUtxo(SUB, sub), AGENT_RECORDS[0]];
    const locked = proposalLock(proposalDatum({ proposerDid: SUB, proposerCredential: { type: 'VerificationKey', hash: testKey(14).keyHash } }));
    const r = await spend([headUtxo()], locked, { agentDid: SUB, records });
    const tx = inspect(r.txCbor);
    assert.ok(tx.refs.includes(refOf(records[0])) && tx.refs.includes(refOf(records[1])), 'the record and its parent');
    await assert.rejects(spend([headUtxo()], locked, { agentDid: SUB, records: [records[0]] }), /No parent record for did:vector:a1a1/);
  });

  test('refuses a lock that is gone, elsewhere or holds tokens, another agent, and a credential that the record no longer declares', async () => {
    const locked = proposalLock();
    const ctx = await ctxOn([headUtxo()]);
    await assert.rejects(buildProposalSpend(ctx, { ...common, agentDid: PROPOSER_ID, lockTxHash: locked.txHash }), /The proposal lock .* is not an unspent output: has the lock transaction confirmed\?/);
    const elsewhere = lockUtxo(GOV.critiqueAddress, locked.datum!, 27_000_000n);
    await assert.rejects(spend([headUtxo()], elsewhere), /is not at the proposal validator address/);
    const withToken = { ...locked, assets: { ...locked.assets, [`${GOV.proposalMint}${deriveProposalTokenName('11'.repeat(32), 0)}`]: 1n } };
    await assert.rejects(spend([headUtxo()], withToken), /holds tokens: it is not a proposal lock/);
    await assert.rejects(spend([headUtxo()], locked, { agentDid: CRITIC_ID }), /Proposer DID mismatch: the lock belongs to did:vector:a1a1.*, not did:vector:a2a2/);
    const rotated = [recordUtxo(PROPOSER_ID, rootRecord({ controller: OTHER.publicKey, keys: [] }))];
    await assert.rejects(spend([headUtxo()], locked, { records: rotated }), /is not a declared credential of did:vector:a1a1/);
    await assert.rejects(spend([headUtxo(PROPOSER_ID), nodeUtxo(PROPOSER_ID, { lastProposalSlot: NOW - 3_600_000 })], locked), /The submission breaks the rate limit: the proposal cooldown/);
    const script = lockUtxo(GOV.proposalAddress, encodeProposalDatum(proposalDatum({ proposerCredential: { type: 'Script', hash: GOV.proposalSpend } })), 27_000_000n);
    await assert.rejects(spend([headUtxo()], script), /The proposer credential of the lock is a script credential/);
  });

  test('the scripts decide: the same transaction with submitted_at other than lo fails in the proposal validator', async () => {
    const locked = proposalLock();
    const head = headUtxo();
    const ctx = await ctxOn([locked, head]);
    const build = (submittedAt: number) => {
      const propUnit = `${GOV.proposalMint}${deriveProposalTokenName(locked.txHash, 0)}`;
      const actUnit = `${GOV.proposalMint}${deriveActivityTokenName(PROPOSER_ID)}`;
      const node = encodeActivityDatum({ agentDid: PROPOSER_ID, agentCredential: { type: 'VerificationKey', hash: CONTROLLER.keyHash }, activeProposalCount: 1, lastProposalSlot: lo, nextDid: '' });
      const predecessor = encodeActivityDatum({ ...decodeActivityDatum(head.datum!), nextDid: PROPOSER_ID });
      return ctx.lucid.newTx()
        .collectFrom([locked], SUBMIT_PROPOSAL_REDEEMER)
        .collectFrom([head], SPEND_ACTIVITY_REDEEMER)
        .mintAssets({ [actUnit]: 1n, [propUnit]: 1n }, SUBMIT_PROPOSAL_REDEEMER)
        .pay.ToContract(GOV.proposalAddress, { kind: 'inline', value: encodeProposalDatum(proposalDatum({ submittedAt })) }, { lovelace: 27_000_000n, [propUnit]: 1n })
        .pay.ToContract(GOV.proposalAddress, { kind: 'inline', value: node }, { lovelace: 2_000_000n, [actUnit]: 1n })
        .pay.ToContract(GOV.proposalAddress, { kind: 'inline', value: predecessor }, head.assets)
        .readFrom([...GOV_REF_UTXOS.slice(0, 2), AGENT_RECORDS[0], paramsUtxo(), CROSS_REFS_UTXO])
        .addSignerKey(CONTROLLER.keyHash)
        .validFrom(lo).validTo(hi)
        .complete();
    };
    await build(lo);
    await assert.rejects(build(lo + 1000), /failed script execution/);
  });
});

// ─── Critique ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('critiques: the lock names the seed, the creation mints crit_', () => {
  const { seed, utxo: proposal, datum } = submitted();
  const lock = (o: Partial<Parameters<typeof buildCritiqueLock>[1]> = {}, extra: UTxO[] = [proposal], opts: { koios?: KoiosAccess; records?: UTxO[]; params?: typeof PARAMS } = {}) =>
    ctxOn(extra, opts).then((ctx) => buildCritiqueLock(ctx, {
      ...common, agentDid: CRITIC_ID, credentialKeyHash: CRITIC_CONTROLLER.keyHash, proposalTxHash: seed.txHash, proposalOutputIndex: seed.outputIndex,
      critiqueType: 'Opposing', stakeApex: 10, critiqueHash: 'cd'.repeat(32), storageUri: 'ipfs://critique', ...o,
    }));
  const critiqueLock = (d: CritiqueDatum): UTxO => lockUtxo(GOV.critiqueAddress, encodeCritiqueDatum(d), d.stakeAmount + 2_000_000n);
  const critiqueDatum = (o: Partial<CritiqueDatum> = {}): CritiqueDatum => ({
    criticDid: CRITIC_ID, criticCredential: { type: 'VerificationKey', hash: CRITIC_CONTROLLER.keyHash }, proposalRef: seed, critiqueHash: 'cd'.repeat(32),
    storageUri: utf8Hex('ipfs://critique'), critiqueType: { type: 'Opposing' }, stakeAmount: 10_000_000n, submittedAt: lo, incorporated: false, ...o,
  });

  test('step 1 by the seed: the datum names the seed, submitted_at = lo, the stake + 2 AP3X', async () => {
    const r = await lock();
    const out = inspect(r.txCbor).outputs[r.lockOutputIndex];
    assert.equal(out.address, GOV.critiqueAddress);
    assert.deepEqual(out.assets, { lovelace: 12_000_000n });
    assert.deepEqual(decodeCritiqueDatum(out.datum!), critiqueDatum());
    assert.equal(r.seed, `${seed.txHash}#0`);
    assert.equal(r.proposal, refOf(proposal));
    assert.equal(r.proposerDid, `did:vector:${PROPOSER_ID}`);
  });

  test('step 1 by the current output: the seed comes from the submission (Koios), and an Amendment critique carries its hash', async () => {
    const koios = koiosWith({ [proposal.txHash]: [[`${seed.txHash}#0`, GOV.proposalSpend], [`${'ad'.repeat(32)}#0`, GOV.proposalSpend]] });
    const r = await lock({ proposalTxHash: proposal.txHash, critiqueType: 'Amendment' }, [proposal], { koios });
    assert.deepEqual(r.datum.proposalRef, seed);
    assert.deepEqual(r.datum.critiqueType, { type: 'Amendment', suggestedChangeHash: 'cd'.repeat(32) });
  });

  test('step 1 refuses parties that are not different, a proposal that is not open, and a stake under the parameters', async () => {
    const sameController = [AGENT_RECORDS[0], recordUtxo(CRITIC_ID, criticRecord({ controller: CONTROLLER.publicKey }))];
    await assert.rejects(lock({ credentialKeyHash: CONTROLLER.keyHash }, [proposal], { records: sameController }), /not different parties|the agent and the proposer have the same controller key/);
    const child = [AGENT_RECORDS[0], recordUtxo(CRITIC_ID, criticRecord({ endpoint: '', lineage: { type: 'Subagent', parent: PROPOSER_ID, parentEpoch: 0, depth: 1 } }))];
    await assert.rejects(lock({}, [proposal], { records: child }), /the agent is a subagent of the proposer/);
    await assert.rejects(lock({ agentDid: PROPOSER_ID, credentialKeyHash: CONTROLLER.keyHash }), /the proposer can only write an Amendment critique of its own proposal/);
    const adopted = proposalUtxo(seed, { ...datum, state: { type: 'Adopted', hash: 'ee'.repeat(32) } }, { txHash: 'f1'.repeat(32), outputIndex: 0 });
    await assert.rejects(lock({}, [adopted]), /the proposal is Adopted, not Open or Amended/);
    await assert.rejects(lock({}, [proposal], { params: { ...PARAMS, minCritiqueStake: 20_000_000n } }), /the stake is below the minimum of 20\.000000 AP3X/);
    await assert.rejects(lock({ stakeApex: 9 }), /Critique stake must be at least 10 AP3X/);
    await assert.rejects(lock({}, [proposal], { records: [AGENT_RECORDS[1]] }), /No identity record of the proposer did:vector:a1a1/);
  });

  test('step 2 mints crit_ of the lock and reads the proposal and the proposer record; evaluated by the applied validators', async () => {
    const locked = critiqueLock(critiqueDatum({ submittedAt: NOW - DAY }));
    const ctx = await ctxOn([proposal, locked]);
    const r = await buildCritiqueSpend(ctx, { ...common, agentDid: `did:vector:${CRITIC_ID}`, lockTxHash: locked.txHash });
    const tx = inspect(r.txCbor);
    const unit = `${GOV.critiqueMint}${deriveCritiqueTokenName(locked.txHash, 0)}`;
    assert.deepEqual(tx.mint, { [unit]: 1n });
    const out = tx.outputs.find((o) => o.assets[unit] === 1n)!;
    assert.equal(out.address, GOV.critiqueAddress);
    assert.deepEqual(out.assets, { lovelace: 12_000_000n, [unit]: 1n });
    assert.deepEqual(decodeCritiqueDatum(out.datum!), critiqueDatum());
    assert.ok(tx.refs.includes(refOf(proposal)) && tx.refs.includes(refOf(AGENT_RECORDS[0])) && tx.refs.includes(refOf(AGENT_RECORDS[1])));
    assert.deepEqual(tx.signers, [CRITIC_CONTROLLER.keyHash]);
    assert.ok(tx.scripts.length === 2 && tx.scripts.every((s) => s.mem > 0n));
    assert.equal(r.seed, `${seed.txHash}#0`);
    assert.equal(r.position, `${r.txHash}#${tx.outputs.indexOf(out)}`);
  });

  test('step 2 of an Amendment critique by the proposer needs no proposer record; it is evaluated too', async () => {
    const locked = critiqueLock(critiqueDatum({ criticDid: PROPOSER_ID, criticCredential: { type: 'VerificationKey', hash: CONTROLLER.keyHash }, critiqueType: { type: 'Amendment', suggestedChangeHash: 'cd'.repeat(32) } }));
    const r = await buildCritiqueSpend(await ctxOn([proposal, locked]), { ...common, agentDid: PROPOSER_ID, lockTxHash: locked.txHash });
    assert.ok(!inspect(r.txCbor).refs.includes(refOf(AGENT_RECORDS[1])));
  });

  test('step 2 refuses a proposal that has ended and a critic that is no longer Active', async () => {
    const locked = critiqueLock(critiqueDatum());
    await assert.rejects(buildCritiqueSpend(await ctxOn([locked]), { ...common, agentDid: CRITIC_ID, lockTxHash: locked.txHash }), /No proposal at .* holds the proposal token of the seed 5e5e/);
    const revoked = rootRecord({ controller: CRITIC_CONTROLLER.publicKey, keys: [], status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: NOW - DAY, invalidFrom: null, successor: null } });
    const ctx = await ctxOn([proposal, locked], { records: [AGENT_RECORDS[0], recordUtxo(CRITIC_ID, revoked)] });
    await assert.rejects(buildCritiqueSpend(ctx, { ...common, agentDid: CRITIC_ID, lockTxHash: locked.txHash }), /The critic did:vector:a2a2.* is Revoked over the validity window/);
  });
});

// ─── Endorsement ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('endorsements: the lock names the seed, the creation mints gend_', () => {
  const { seed, utxo: proposal } = submitted();
  const endorsementDatum = (o: Partial<EndorsementDatum> = {}): EndorsementDatum => ({
    endorserDid: ENDORSER_ID, endorserCredential: { type: 'VerificationKey', hash: ENDORSER_CONTROLLER.keyHash }, proposalRef: seed, stakeAmount: 5_000_000n, createdAt: lo, ...o,
  });

  test('step 1 locks the endorsement of the seed with created_at = lo', async () => {
    const ctx = await ctxOn([proposal]);
    const r = await buildEndorseLock(ctx, { ...common, agentDid: ENDORSER_ID, credentialKeyHash: ENDORSER_CONTROLLER.keyHash, proposalTxHash: seed.txHash, stakeApex: 5 });
    const out = inspect(r.txCbor).outputs[r.lockOutputIndex];
    assert.equal(out.address, GOV.endorsementAddress);
    assert.deepEqual(out.assets, { lovelace: 7_000_000n });
    assert.deepEqual(decodeEndorsementDatum(out.datum!), endorsementDatum());
  });

  test('step 1 refuses the proposer and a stake under the parameters', async () => {
    const ctx = await ctxOn([proposal]);
    await assert.rejects(buildEndorseLock(ctx, { ...common, agentDid: PROPOSER_ID, credentialKeyHash: CONTROLLER.keyHash, proposalTxHash: seed.txHash, stakeApex: 5 }), /an agent cannot endorse its own proposal/);
    const high = await ctxOn([proposal], { params: { ...PARAMS, minGovernanceEndorsement: 8_000_000n } });
    await assert.rejects(buildEndorseLock(high, { ...common, agentDid: ENDORSER_ID, credentialKeyHash: ENDORSER_CONTROLLER.keyHash, proposalTxHash: seed.txHash, stakeApex: 5 }), /below the minimum of 8\.000000 AP3X/);
    const sameCredential = await ctxOn([proposal], { records: [AGENT_RECORDS[0], recordUtxo(ENDORSER_ID, endorserRecord({ keys: [{ keyType: 'Ed25519', key: CONTROLLER.publicKey, purposes: 8, pop: null }] }))] });
    await assert.rejects(buildEndorseLock(sameCredential, { ...common, agentDid: ENDORSER_ID, credentialKeyHash: CONTROLLER.keyHash, proposalTxHash: seed.txHash, stakeApex: 5 }), /the credential of the agent is the proposer credential/);
  });

  test('step 2 mints gend_(endorser, seed) through critique_mint; evaluated by the applied validators', async () => {
    const locked = lockUtxo(GOV.endorsementAddress, encodeEndorsementDatum(endorsementDatum({ createdAt: NOW - DAY })), 7_000_000n);
    const r = await buildEndorseSpend(await ctxOn([proposal, locked]), { ...common, agentDid: ENDORSER_ID, lockTxHash: locked.txHash });
    const tx = inspect(r.txCbor);
    const unit = `${GOV.critiqueMint}${deriveEndorsementTokenName(ENDORSER_ID, seed)}`;
    assert.equal(r.tokenName, deriveEndorsementTokenName(ENDORSER_ID, seed));
    assert.ok(r.tokenName.startsWith(utf8Hex('gend_')));
    assert.deepEqual(tx.mint, { [unit]: 1n });
    const out = tx.outputs.find((o) => o.assets[unit] === 1n)!;
    assert.deepEqual(out.assets, { lovelace: 7_000_000n, [unit]: 1n });
    assert.deepEqual(decodeEndorsementDatum(out.datum!), endorsementDatum());
    assert.ok(tx.refs.includes(refOf(proposal)) && tx.refs.includes(refOf(AGENT_RECORDS[0])) && tx.refs.includes(refOf(AGENT_RECORDS[2])));
    assert.deepEqual(r.requiredSigners.map((s) => s.keyHash), [ENDORSER_CONTROLLER.keyHash, OWN_KEY_HASH]);
    assert.ok(tx.scripts.length === 2 && tx.scripts.every((s) => s.mem > 0n));
  });

  test('the scripts decide: without the proposer record as a reference input the endorsement validator fails', async () => {
    const locked = lockUtxo(GOV.endorsementAddress, encodeEndorsementDatum(endorsementDatum()), 7_000_000n);
    const ctx = await ctxOn([proposal, locked]);
    const unit = `${GOV.critiqueMint}${deriveEndorsementTokenName(ENDORSER_ID, seed)}`;
    const build = (refs: UTxO[]) => ctx.lucid.newTx()
      .collectFrom([locked], MINT_ENDORSEMENT_TOKEN_REDEEMER)
      .mintAssets({ [unit]: 1n }, MINT_ENDORSEMENT_TOKEN_REDEEMER)
      .pay.ToContract(GOV.endorsementAddress, { kind: 'inline', value: encodeEndorsementDatum(endorsementDatum()) }, { lovelace: 7_000_000n, [unit]: 1n })
      .readFrom([GOV_REF_UTXOS[4], GOV_REF_UTXOS[3], AGENT_RECORDS[2], paramsUtxo(), CROSS_REFS_UTXO, proposal, ...refs])
      .addSignerKey(ENDORSER_CONTROLLER.keyHash)
      .validFrom(lo).validTo(hi)
      .complete();
    await build([AGENT_RECORDS[0]]);
    await assert.rejects(build([]), /failed script execution/);
  });
});
