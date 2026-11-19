// packages/builder/test/cbor-guard.test.ts
// The CBOR check at the places where bytes that this package did not build reach a decoder: the wrappers of guarded-decode.ts, the fee
// of a transaction that a caller gives (declaredFee), the datum and the redeemer that a caller gives the contract builders, and the
// codec entry points that read a datum from chain data. For each: an input that is nested past 64 levels is refused with an ordinary
// Error before the decoder is called, an input at the limit is accepted, and a normal call in the same process works after the refusal.
//
// A decoder is replaced by a watch for the length of a test (fixtures/decoder-watch.ts): an input that nests past the limit and reaches the
// decoder shows as a failure, and does not go through the real decoder.
import { afterEach, describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CML, Data, applyDoubleCborEncoding, validatorToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { CborGuardError, MAX_CBOR_DEPTH, assertCborHexDepth, cborDepth } from '@apexfusion/vector-mcp-shared/cbor-depth';
import { assertPlutusDataHex, decodeMetadatum, decodePlutusData, decodeTransaction } from '../src/vector/guarded-decode.ts';
import { buildDeployContract, buildInteractContract, buildSendApex, declaredFee, lucidForAddress } from '../src/vector/build.ts';
import {
  decodeAttestationDatum, decodeDelegationDatum, decodeIdentityDatum, decodeIdentityMint, decodeIdentitySpend, decodeLegacyDatum, decodeVaultDatum,
} from '../src/vector/identity-codec.ts';
import {
  decodeActivityDatum, decodeCritiqueDatum, decodeCrossRefs, decodeEndorsementDatum, decodeGovernanceParams, decodeProposalDatum, encodeGovernanceParams,
} from '../src/vector/gov-codec.ts';
import { decodeChallengeDatum, decodeClaimDatum, decodeJuryDatum, decodeJuryMint, decodeJuryParams, decodeJurySpend } from '../src/vector/jury-codec.ts';
import {
  advertTextFieldsRoundTrip, decodeAdvertDatum, decodeAnyAdvertDatum, decodeAnyEscrowDatum, decodeEscrowDatum, decodeIdentityAdvertDatum,
  decodeIdentityEscrowDatum, encodeIdentityEscrowDatum,
} from '../src/vector/marketplace-datum.ts';
import { parseAgentDatum } from '../src/vector/registry-build.ts';
import { decodeCrossRefs as decodeStakeCrossRefs, decodeStakeDatum, decodeStakeParams, encodeStakeDatum } from '../src/vector/reputation-datum.ts';
import { readAttestationDatum } from '../src/vector/attestation-read.ts';
import { findConfigRecord } from '../src/vector/identity-deployment.ts';
import { FIXTURE_UTXOS, FIXTURE_TXHASH, FOREIGN_ADDRESS, FixtureProvider, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { ADVERT_DATUM_HEX, ESCROW_OPEN_DATUM_HEX } from './fixtures/marketplace.fixture.ts';
import { legacyAgentDatum } from './fixtures/legacy-datum.ts';
import { CONFIG_UTXO, DEPLOYMENT, M1, REF_UTXOS } from './fixtures/identity-world.ts';
import { CROSS_REFS_UTXO, PARAMS, headUtxo } from './fixtures/gov-world.ts';
import { WALLET_ADDRESS, NOW, claimUtxo, juryWorld } from './fixtures/jury-world.ts';
import { buildDocumentPublish } from '../src/vector/jury-build.ts';
import { ADVERT_POSTS } from './fixtures/advert-stake-golden.fixture.ts';
import { AGENT_RECORDS, CROSS_REFS_UTXO as GOLDEN_CROSS_REFS_UTXO, PARAMS_UTXO } from './fixtures/reputation-golden.fixture.ts';
import { identityEscrow } from './fixtures/escrow-identity.fixture.ts';
import { watchDecoder } from './fixtures/decoder-watch.ts';

const here = (name: string) => resolve(import.meta.dirname!, name);
const IDENTITY = JSON.parse(readFileSync(here('fixtures/identity-cbor-fixtures.json'), 'utf8')).fixtures as Record<string, { cbor: string }>;
const JURY = JSON.parse(readFileSync(here('fixtures/jury-python-vectors.json'), 'utf8'));

/** CBOR hex of an array nested `levels` levels deep, with the integer 0 inside: valid Plutus data, and a valid metadatum. */
const nested = (levels: number): string => `${'81'.repeat(levels)}00`;
/** A value that is far past the limit: 5,000 levels. */
const DEEP = nested(5000);

/** The bytes of a definite-length byte string that holds `hex`. */
function bytesOf(hex: string): string {
  const length = hex.length / 2;
  const head = length < 24 ? (0x40 + length).toString(16).padStart(2, '0') : length < 256 ? `58${length.toString(16).padStart(2, '0')}` : `59${length.toString(16).padStart(4, '0')}`;
  return `${head}${hex}`;
}
/** A transaction with one output that carries `datum` inline: [body, witness set, is valid, no auxiliary data]. */
function transactionWithDatum(datum: string): string {
  const input = `825820${'22'.repeat(32)}00`;
  const output = `a300581d61${'11'.repeat(28)}011a001e8480028201d818${bytesOf(datum)}`;
  return `84a30081${input}0181${output}0200a0f5f6`;
}
// The levels around the datum of an output: the transaction, the body, the outputs, the output, the datum option and the tag.
const DATUM_LEVELS_AT_LIMIT = MAX_CBOR_DEPTH - 6;

afterEach(() => { mock.restoreAll(); });

/** The refusal of a value that nests too deep: a CborGuardError of reason `depth`, naming the value as `what`. */
const tooDeep = (what: string): ((err: unknown) => boolean) => (err) => {
  assert.ok(err instanceof CborGuardError, `expected a CborGuardError, got ${String(err)}`);
  assert.equal(err.reason, 'depth');
  assert.equal(err.message, `${what} is nested deeper than 64 levels.`);
  return true;
};

describe('the decode wrappers (guarded-decode.ts)', () => {
  test('Plutus data: 64 levels are decoded, more are refused before Data.from, and Data.from works after', () => {
    const watch = watchDecoder(Data, 'from');
    assert.ok(decodePlutusData(nested(64)) instanceof Array);
    assert.throws(() => decodePlutusData(nested(65)), tooDeep('The datum'));
    assert.throws(() => decodePlutusData(DEEP), tooDeep('The datum'));
    assert.throws(() => decodePlutusData(DEEP, 'The value'), tooDeep('The value'));
    assert.equal(watch.reached(), 0);
    assert.equal(decodePlutusData('d87980').constructor.name, 'Constr');
    assert.deepEqual(decodePlutusData('9f0102ff'), [1n, 2n]);
  });

  test('Plutus data: hex that is not whole bytes, CBOR that is not well-formed, and a float or a simple value are refused', () => {
    for (const hex of ['abc', 'zz', '', 'ff', '9f00', 'fb0000000000000000', '81f6']) {
      assert.throws(() => decodePlutusData(hex), (err: unknown) => err instanceof CborGuardError && err.reason === 'format', hex);
    }
  });

  test('a transaction: 64 levels are decoded, more are refused before CML, and CML works after', () => {
    const watch = watchDecoder(CML.Transaction, 'from_cbor_hex');
    assert.equal(decodeTransaction(transactionWithDatum(nested(DATUM_LEVELS_AT_LIMIT))).body().fee(), 0n);
    assert.throws(() => decodeTransaction(transactionWithDatum(nested(DATUM_LEVELS_AT_LIMIT + 1))), tooDeep('The transaction'));
    assert.throws(() => decodeTransaction(transactionWithDatum(DEEP)), tooDeep('The transaction'));
    assert.throws(() => decodeTransaction(transactionWithDatum(DEEP), 'txCbor'), tooDeep('txCbor'));
    assert.equal(watch.reached(), 0);
    assert.equal(decodeTransaction(transactionWithDatum('d87980')).body().outputs().len(), 1);
    assert.equal(CML.PlutusData.from_cbor_hex('d87980').to_cbor_hex(), 'd87980');
  });

  test('a transaction: depth in the witness set, in the auxiliary data and in a native script is refused as well', () => {
    const body = `a30081825820${'22'.repeat(32)}0001800200`;
    const watch = watchDecoder(CML.Transaction, 'from_cbor_hex');
    const tooDeepScript = `${'820181'.repeat(1700)}8200581c${'00'.repeat(28)}`;
    for (const [where, tx] of [
      ['the data of the witness set', `84${body}a10481${DEEP}f5f6`],
      ['the redeemers of the witness set', `84${body}a10581840000${DEEP}820000f5f6`],
      ['the native scripts of the witness set', `84${body}a10181${tooDeepScript}f5f6`],
      ['the metadata of the auxiliary data', `84${body}a0f5a1a1195644${DEEP}`],
    ] as const) {
      assert.throws(() => decodeTransaction(tx), tooDeep('The transaction'), where);
    }
    assert.equal(watch.reached(), 0);
    assert.equal(decodeTransaction(`84${body}a0f5f6`).body().fee(), 0n);
  });

  test('metadata: 64 levels are decoded, more are refused before CML, and CML works after', () => {
    const watch = watchDecoder(CML.TransactionMetadatum, 'from_cbor_bytes');
    assert.equal(decodeMetadatum(Buffer.from(nested(64), 'hex')).kind(), CML.TransactionMetadatumKind.List);
    assert.throws(() => decodeMetadatum(Buffer.from(nested(65), 'hex')), tooDeep('The metadata'));
    assert.throws(() => decodeMetadatum(Buffer.from(DEEP, 'hex')), tooDeep('The metadata'));
    assert.throws(() => decodeMetadatum(Buffer.from(`${'a100'.repeat(3000)}00`, 'hex'), 'The label value'), tooDeep('The label value'));
    assert.equal(watch.reached(), 0);
    assert.equal(decodeMetadatum(Buffer.from('a1195644a1616101', 'hex')).kind(), CML.TransactionMetadatumKind.Map);
  });

  test('the check also serves a datum or a redeemer that a builder hands to Lucid', () => {
    assert.doesNotThrow(() => assertPlutusDataHex(nested(64)));
    assert.throws(() => assertPlutusDataHex(nested(65), 'redeemer'), tooDeep('redeemer'));
  });
});

describe('declaredFee (vector_dry_run)', () => {
  test('a transaction nested past the limit is refused with the reason, and a normal transaction works after it', async () => {
    const watch = watchDecoder(CML.Transaction, 'from_cbor_hex');
    for (const deep of [transactionWithDatum(nested(DATUM_LEVELS_AT_LIMIT + 1)), transactionWithDatum(DEEP), DEEP]) {
      assert.throws(() => declaredFee(deep), (err: Error) => {
        assert.equal(err.message, 'txCbor is nested deeper than 64 levels. It cannot be evaluated.');
        assert.ok(!(err instanceof CborGuardError), 'the caller gets an ordinary Error');
        return true;
      });
    }
    assert.equal(watch.reached(), 0);
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const built = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 });
    assert.equal(declaredFee(built.txCbor), built.fee);
    assert.ok(BigInt(built.fee) > 0n);
  });

  test('a transaction at the limit is accepted', () => {
    assert.equal(declaredFee(transactionWithDatum(nested(DATUM_LEVELS_AT_LIMIT))), '0');
  });

  test('what is not a transaction keeps its message: text that is not hex, CBOR that is not a transaction, and CBOR that is cut', () => {
    for (const txCbor of ['zz', '00', 'a1', '', '84', 'ff', 'f6']) {
      assert.throws(() => declaredFee(txCbor), (err: Error) => {
        assert.equal(err.message, 'txCbor does not decode as a transaction (expected the hex CBOR of a built transaction), so it cannot be evaluated.');
        return true;
      }, txCbor);
    }
  });
});

describe('vector_build_deploy_contract and vector_build_interact_contract: the datum and the redeemer', () => {
  const SCRIPT = '49480100002221200101';

  test('a datum that is nested past the limit is refused before Lucid decodes it, and a normal build works after', async () => {
    const watch = watchDecoder(CML.PlutusData, 'from_cbor_hex');
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const deploy = (initialDatum: string) => buildDeployContract(lucid, { scriptCbor: SCRIPT, scriptType: 'PlutusV2', initialDatum });
    await assert.rejects(deploy(DEEP), /initialDatum is nested deeper than 64 levels\./);
    await assert.rejects(deploy(nested(65)), /initialDatum is nested deeper than 64 levels\./);
    await assert.rejects(
      buildInteractContract(lucid, { scriptCbor: SCRIPT, scriptType: 'PlutusV2', action: 'lock', changeAddress: OWN_ADDRESS, datum: DEEP }),
      /datum is nested deeper than 64 levels\./,
    );
    assert.equal(watch.reached(), 0);
    assert.ok(BigInt((await deploy('d87980')).fee) > 0n);
  });

  test('a datum at the limit is accepted', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const deploy = await buildDeployContract(lucid, { scriptCbor: SCRIPT, scriptType: 'PlutusV2', initialDatum: nested(64) });
    const lock = await buildInteractContract(lucid, { scriptCbor: SCRIPT, scriptType: 'PlutusV2', action: 'lock', changeAddress: OWN_ADDRESS, datum: nested(64) });
    for (const r of [deploy, lock]) assert.ok(BigInt(r.fee) > 0n);
  });

  test('a redeemer that is nested past the limit is refused before Lucid decodes it, and a normal spend works after', async () => {
    const watch = watchDecoder(CML.PlutusData, 'from_cbor_hex');
    const address = validatorToAddress('Mainnet', { type: 'PlutusV2', script: applyDoubleCborEncoding(SCRIPT) });
    const scriptUtxo: UTxO = { txHash: FIXTURE_TXHASH, outputIndex: 7, address, assets: { lovelace: 2_000_000n }, datum: 'd87980' };
    const lucid = await lucidForAddress(new FixtureProvider([...FIXTURE_UTXOS, scriptUtxo]), OWN_ADDRESS);
    const spend = (redeemer: string) => buildInteractContract(lucid, { scriptCbor: SCRIPT, scriptType: 'PlutusV2', action: 'spend', changeAddress: OWN_ADDRESS, redeemer });
    await assert.rejects(spend(DEEP), /redeemer is nested deeper than 64 levels\./);
    await assert.rejects(spend(nested(65)), /redeemer is nested deeper than 64 levels\./);
    assert.equal(watch.reached(), 0);
    assert.equal((await spend('d87980')).action, 'spend');
    assert.equal((await spend(nested(64))).action, 'spend');
  });

  test('the redeemer is not read for a lock: it is not used there', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const lock = await buildInteractContract(lucid, { scriptCbor: SCRIPT, scriptType: 'PlutusV2', action: 'lock', changeAddress: OWN_ADDRESS, redeemer: DEEP });
    assert.equal(lock.action, 'lock');
  });
});
const STAKE_DATUM_HEX = encodeStakeDatum({
  agent_did: 'a3'.repeat(32), owner_pkh: 'b4'.repeat(28), stake_amount: 10_000_000n, staked_capabilities: ['64656d6f'], last_updated: 1_700_000_000_000,
  history_points: 0n, challenge_locks: [], stake_id: { txHash: '00'.repeat(32), outputIndex: 0 },
});

describe('the codec entry points', () => {
  // [name, the decoder, a datum that it decodes (when this file has one)]
  const entries: Array<[string, (hex: string) => unknown, string?]> = [
    ['decodeIdentityDatum', decodeIdentityDatum, IDENTITY.identity_datum_full.cbor],
    ['decodeLegacyDatum', decodeLegacyDatum, IDENTITY.legacy_datum.cbor],
    ['decodeAttestationDatum', decodeAttestationDatum, IDENTITY.attestation_datum_full.cbor],
    ['decodeDelegationDatum', decodeDelegationDatum, IDENTITY.delegation_datum.cbor],
    ['decodeVaultDatum', decodeVaultDatum, IDENTITY.vault_datum_live.cbor],
    ['decodeIdentityMint', decodeIdentityMint, IDENTITY.identity_mint_register.cbor],
    ['decodeIdentitySpend', decodeIdentitySpend, IDENTITY.identity_spend_bump_epoch.cbor],
    ['decodeProposalDatum', decodeProposalDatum],
    ['decodeCritiqueDatum', decodeCritiqueDatum],
    ['decodeEndorsementDatum', decodeEndorsementDatum],
    ['decodeActivityDatum', decodeActivityDatum, headUtxo().datum ?? undefined],
    ['decodeGovernanceParams', decodeGovernanceParams, encodeGovernanceParams(PARAMS)],
    ['decodeCrossRefs', decodeCrossRefs, CROSS_REFS_UTXO.datum ?? undefined],
    ['decodeJuryDatum', decodeJuryDatum, JURY.juror_datum],
    ['decodeJuryMint', decodeJuryMint, JURY.mint_register],
    ['decodeJurySpend', decodeJurySpend, JURY.spend_commit],
    ['decodeJuryParams', decodeJuryParams, JURY.params_cbor],
    ['decodeClaimDatum', decodeClaimDatum, claimUtxo('cc'.repeat(32)).datum ?? undefined],
    ['decodeChallengeDatum', decodeChallengeDatum],
    ['decodeAdvertDatum', decodeAdvertDatum, ADVERT_DATUM_HEX],
    ['decodeIdentityAdvertDatum', decodeIdentityAdvertDatum, IDENTITY.advert_datum.cbor],
    ['decodeAnyAdvertDatum', decodeAnyAdvertDatum, ADVERT_DATUM_HEX],
    ['decodeEscrowDatum', decodeEscrowDatum, ESCROW_OPEN_DATUM_HEX],
    ['decodeIdentityEscrowDatum', decodeIdentityEscrowDatum, IDENTITY.escrow_datum_with_refund.cbor],
    ['decodeAnyEscrowDatum', decodeAnyEscrowDatum, ESCROW_OPEN_DATUM_HEX],
    ['decodeStakeDatum', decodeStakeDatum, STAKE_DATUM_HEX],
    ['decodeStakeParams', decodeStakeParams, PARAMS_UTXO.datum ?? undefined],
    ['decodeStakeCrossRefs', decodeStakeCrossRefs, GOLDEN_CROSS_REFS_UTXO.datum ?? undefined],
    ['readAttestationDatum', readAttestationDatum, IDENTITY.attestation_datum_full.cbor],
  ];

  for (const [name, decode, valid] of entries) {
    test(`${name}: a datum nested past the limit is refused before Data.from, and a normal datum is decoded after`, () => {
      const watch = watchDecoder(Data, 'from');
      for (const deep of [DEEP, nested(65)]) {
        assert.throws(() => decode(deep), (err: unknown) => err instanceof Error && /not Plutus data|nested deeper than 64 levels/i.test(err.message), name);
      }
      assert.equal(watch.reached(), 0, `${name} let a refused datum reach Data.from`);
      if (valid !== undefined) assert.doesNotThrow(() => decode(valid), name);
      assert.equal(decodePlutusData('d87980').constructor.name, 'Constr');
    });
  }

  test('advertTextFieldsRoundTrip answers false for a datum nested past the limit, and its answer for a normal datum after it', () => {
    const watch = watchDecoder(Data, 'from');
    assert.equal(advertTextFieldsRoundTrip(DEEP), false);
    assert.equal(watch.reached(), 0);
    assert.equal(advertTextFieldsRoundTrip(ADVERT_DATUM_HEX), true);
  });

  test('the refund datum of an identity escrow that is nested past the limit is refused when the escrow is written', () => {
    const watch = watchDecoder(Data, 'from');
    const escrow = identityEscrow(1_700_000_000_000);
    const withRefundDatum = (datum: string) => ({ ...escrow, refund: { address: escrow.refund!.address, datum } });
    assert.throws(() => encodeIdentityEscrowDatum(withRefundDatum(DEEP)), tooDeep('The datum'));
    assert.equal(watch.reached(), 0);
    assert.doesNotThrow(() => encodeIdentityEscrowDatum(withRefundDatum('d87980')));
  });

  test('a legacy registry datum nested past the limit gives no profile, and a normal one gives its profile after', () => {
    const watch = watchDecoder(Data, 'from');
    const warn = mock.method(console, 'warn', () => {});
    assert.equal(parseAgentDatum(DEEP, `${FIXTURE_TXHASH}#0`, {}), null);
    warn.mock.restore();
    assert.equal(watch.reached(), 0);
    const profile = parseAgentDatum(legacyAgentDatum('aa'.repeat(28), 'Agent', 'An agent', ['x.y.v1'], 'fw', 'https://agent.example'), `${FIXTURE_TXHASH}#0`, {});
    assert.equal(profile?.name, 'Agent');
  });

  test('the configuration record: an output whose datum is nested past the limit is refused, and the genuine record is read after', async () => {
    const watch = watchDecoder(Data, 'from');
    const withDeepDatum: UTxO = { ...CONFIG_UTXO, datum: DEEP };
    await assert.rejects(findConfigRecord(new FixtureProvider([withDeepDatum, ...REF_UTXOS]), DEPLOYMENT), /has no 28-byte Module-1 hash as its inline datum/);
    assert.equal(watch.reached(), 0);
    assert.equal((await findConfigRecord(new FixtureProvider([CONFIG_UTXO, ...REF_UTXOS]), DEPLOYMENT))?.m1, M1);
  });
});

describe('real data is inside the limit', () => {
  const REAL_DOCUMENT = JSON.parse(readFileSync(here('fixtures/jury-document-mainnet.json'), 'utf8'));
  const depthOf = (hex: string): number => cborDepth(Buffer.from(hex, 'hex'));

  test('every datum and redeemer of the fixtures is accepted and nests less than 16 levels: the Aiken fixtures, the jury vectors and the mainnet outputs', () => {
    const datums: Array<[string, string]> = [
      ...Object.entries(IDENTITY).map(([name, f]): [string, string] => [`identity fixture ${name}`, f.cbor]),
      ...['params_cbor', 'juror_datum', 'case_datum', 'mint_register', 'mint_burn', 'spend_commit', 'spend_case_reveal', 'spend_request_exit', 'spend_finalize']
        .map((name): [string, string] => [`jury vector ${name}`, JURY[name]]),
      ['marketplace advert', ADVERT_DATUM_HEX], ['marketplace escrow', ESCROW_OPEN_DATUM_HEX],
      ...ADVERT_POSTS.map((post, i): [string, string] => [`mainnet advert ${i}`, post.datumHex]),
      ...Object.entries(AGENT_RECORDS).map(([name, record]): [string, string] => [`mainnet identity record ${name}`, record.utxo.datum!]),
      ...[PARAMS_UTXO, GOLDEN_CROSS_REFS_UTXO].map((utxo, i): [string, string] => [`mainnet reputation output ${i}`, utxo.datum!]),
    ];
    assert.ok(datums.length > 60);
    for (const [name, hex] of datums) {
      assert.doesNotThrow(() => assertCborHexDepth(hex), name);
      assert.ok(depthOf(hex) < 16, `${name} nests ${depthOf(hex)} levels`);
    }
  });

  test('the metadata of a real claim document (Vector mainnet) is accepted as metadata', () => {
    const [row] = REAL_DOCUMENT.blockfrost;
    assert.ok(depthOf(row.metadata) < 8);
    assert.equal(decodeMetadatum(Buffer.from(row.metadata, 'hex')).kind(), CML.TransactionMetadatumKind.Map);
  });

  test('transactions that the builders build are accepted as transactions and nest less than 24 levels', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const juryNode = juryWorld();
    const document = await buildDocumentPublish(await lucidForAddress(juryNode, WALLET_ADDRESS), juryNode, {
      changeAddress: WALLET_ADDRESS, bytes: Buffer.from('{"type":"evidence","text":"ok"}', 'utf8'), type: 'evidence', nowMs: NOW,
    });
    const built = [
      (await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 })).txCbor,
      (await buildDeployContract(lucid, { scriptCbor: '49480100002221200101', scriptType: 'PlutusV2', initialDatum: 'd8799f0102ff' })).txCbor,
      document.txCbor,
    ];
    for (const txCbor of built) {
      assert.doesNotThrow(() => assertCborHexDepth(txCbor, { kind: 'transaction' }));
      assert.ok(depthOf(txCbor) < 24, `a built transaction nests ${depthOf(txCbor)} levels`);
      assert.equal(typeof decodeTransaction(txCbor).body().fee(), 'bigint');
    }
  });
});
