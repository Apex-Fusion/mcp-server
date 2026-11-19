// packages/builder/test/cbor-guard-sites.test.ts
// Where the sources of the builder and the shared package decode CBOR. A transaction, Plutus data and metadata are decoded through the
// wrappers of guarded-decode.ts, which check the bytes first (cbor-depth.ts). A file that calls a decoder of CML, or Lucid's Data.from,
// by itself would decode bytes that nothing has checked, so this test reads the sources and names such a file. The second part names the
// calls of Lucid that decode inside Lucid, where the first part does not see them, with the check that runs before each decode.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PACKAGES = resolve(import.meta.dirname!, '../..');
const SOURCE_DIRECTORIES = ['builder/src', 'shared/src'];
/** The calls that decode CBOR that was not built here: the decoders of CML, Lucid's Data.from and Lucid's fromTx. */
const DECODER_CALL = /\b(?:from_cbor_hex|from_cbor_bytes)\s*\(|\bData\.from\s*\(|\bfromTx\s*\(/;

/** The files that call a decoder, and why. guarded-decode.ts is the wrappers. */
const MAY_CALL_DECODERS: Record<string, string> = {
  'builder/src/vector/guarded-decode.ts': 'the wrappers: each one checks the bytes first',
  'builder/src/vector/decoder-health.ts': 'the self-check: it decodes a constant of its own',
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** The code of a source file: its comments are taken out, so that a sentence about a decoder is not a call. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

const callsByFile = new Map<string, string[]>();
for (const directory of SOURCE_DIRECTORIES) {
  for (const path of sourceFiles(join(PACKAGES, directory))) {
    const calls = codeOf(path).split('\n').flatMap((line, i) => (DECODER_CALL.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
    if (calls.length > 0) callsByFile.set(relative(PACKAGES, path), calls);
  }
}

describe('the sources decode CBOR through guarded-decode.ts', () => {
  test('no other file calls a decoder of CML or Lucid by itself', () => {
    const others = [...callsByFile].filter(([file]) => !(file in MAY_CALL_DECODERS));
    assert.deepEqual(others, [], `these files decode CBOR by themselves; use decodeTransaction, decodePlutusData or decodeMetadatum:\n${others.map(([file, calls]) => `${file}\n  ${calls.join('\n  ')}`).join('\n')}`);
  });

  test('each file that may call a decoder does call one', () => {
    for (const file of Object.keys(MAY_CALL_DECODERS)) assert.ok(callsByFile.has(file), `${file} calls no decoder: take it out of MAY_CALL_DECODERS`);
  });

  test('each wrapper of guarded-decode.ts checks the bytes before it calls its decoder', () => {
    const code = codeOf(join(PACKAGES, 'builder/src/vector/guarded-decode.ts'));
    const functions = new Map(code.split(/\nexport function /).slice(1).map((part) => [part.slice(0, part.indexOf('(')), part] as const));
    for (const [wrapper, check, decoder] of [
      ['decodeTransaction', 'assertCborHexDepth(', 'CML.Transaction.from_cbor_hex('],
      ['decodePlutusData', 'assertPlutusDataHex(', 'Data.from('],
      ['decodeMetadatum', 'assertCborDepth(', 'CML.TransactionMetadatum.from_cbor_bytes('],
    ] as const) {
      const body = functions.get(wrapper);
      assert.ok(body, `${wrapper} is exported`);
      assert.ok(body.includes(check) && body.includes(decoder) && body.indexOf(check) < body.indexOf(decoder), `${wrapper} calls ${check} before ${decoder}`);
    }
    assert.equal(code.split(DECODER_CALL).length, 4, 'guarded-decode.ts calls three decoders, one in each wrapper');
  });

  test('build.ts decodes no transaction: the fee of a transaction that a caller gives is read from its bytes', () => {
    const code = codeOf(join(PACKAGES, 'builder/src/vector/build.ts'));
    assert.doesNotMatch(code, /decodeTransaction|\bTransaction\.from_cbor|\bfromTx\s*\(/);
    assert.ok(code.includes('readTransactionFee('), 'declaredFee reads the fee with readTransactionFee');
  });
});

/**
 * Lucid decodes CBOR, and reads addresses, inside some of its own calls. Each entry names a call that reaches such a decode, the files
 * of this package that make the call, and the check that runs before the decode (or why none is needed). A call in a file that is not
 * named here fails the test: whoever adds the call says here which check protects it.
 */
interface LucidDecode { decode: string; call: RegExp; files: string[]; why: string }
const LUCID_DECODES: LucidDecode[] = [
  {
    decode: 'getAddressDetails: an address as text',
    call: /\bgetAddressDetails\s*\(/,
    files: ['builder/src/vector/guarded-decode.ts'],
    why: 'every address is read through addressDetails, which refuses the empty string before Lucid reads it',
  },
  {
    decode: 'attachMetadata: JSON into transaction metadata',
    call: /\.attachMetadata\s*\(/,
    files: ['builder/src/vector/build.ts', 'builder/src/vector/jury-build.ts'],
    why: 'its argument is JSON, not CBOR: the metadata of a caller is parsed as JSON text, and jury-build.ts splits a document into text chunks',
  },
  {
    decode: 'applyDoubleCborEncoding: the CBOR of a script, read in JavaScript',
    call: /\bapplyDoubleCborEncoding\s*\(/,
    files: ['builder/src/vector/build.ts'],
    why: 'it reads the script with a JavaScript reader inside a try block, and CML reads only the byte string that it writes; assertScriptInput reads the head of the script first, and refuses a script that is not one byte string',
  },
  {
    decode: 'validatorToScriptHash and validatorToAddress (and toScriptRef, for a reference script): a script into CML',
    call: /\b(?:validatorToScriptHash|validatorToAddress)\s*\(/,
    files: [
      'builder/src/vector/build.ts', 'builder/src/vector/gov-deployment.ts', 'builder/src/vector/identity-deployment.ts', 'builder/src/vector/jury-deployment.ts',
      'builder/src/vector/legacy-registry.ts', 'builder/src/vector/marketplace-advert.ts', 'builder/src/vector/reputation-build.ts',
    ],
    why: 'CML reads a script as one byte string, which applyDoubleCborEncoding writes, and does not read the bytes inside it as CBOR; the scripts are the compiled scripts of this package, the manifests, and the reference scripts that the provider gives',
  },
  {
    decode: 'utxoToCore (and toScriptRef inside it): the inline datum and the reference script of each UTxO that Lucid is given',
    call: /\.(?:collectFrom|readFrom)\s*\(|\bselectWallet\.fromAddress\s*\(/,
    files: [
      'builder/src/vector/attestation-build.ts', 'builder/src/vector/build.ts', 'builder/src/vector/delegation-build.ts', 'builder/src/vector/gov-tx.ts',
      'builder/src/vector/identity-build.ts', 'builder/src/vector/jury-build.ts', 'builder/src/vector/marketplace-advert-build.ts', 'builder/src/vector/marketplace-advert.ts',
      'builder/src/vector/marketplace-build.ts', 'builder/src/vector/module1-build.ts', 'builder/src/vector/registry-build.ts', 'builder/src/vector/reputation-actions.ts',
      'builder/src/vector/reputation-build.ts', 'builder/src/vector/vault-build.ts',
    ],
    why: 'the UTxOs come from OgmiosProvider, which gives no inline datum that fails the check of cbor-depth.ts (readableDatum), or from this package; a legacy native script is JSON text, which CML refuses as not hex',
  },
  {
    decode: 'toScriptRef: a script reference that a provider builds for Lucid',
    call: /\bscriptRef\s*=\s*\{/,
    files: ['shared/src/provider.ts'],
    why: 'only the provider builds a script reference: no other file gives Lucid a script that a caller wrote',
  },
  {
    decode: 'calculateMinLovelaceFromUTxO (utxoToCore inside it): the address and the inline datum of the output that it sizes',
    call: /\bcalculateMinLovelaceFromUTxO\s*\(/,
    files: [
      'builder/src/vector/attestation-build.ts', 'builder/src/vector/gov-tx.ts', 'builder/src/vector/identity-build.ts', 'builder/src/vector/jury-chain.ts',
      'builder/src/vector/marketplace-advert-build.ts', 'builder/src/vector/marketplace-build.ts', 'builder/src/vector/reputation-build.ts', 'builder/src/vector/vault-build.ts',
      'builder/src/vector/vault-read.ts',
    ],
    why: 'each call sizes an output that this package builds: its address is the address of a script of a deployment, an address that the node lists for an output, or one that addressDetails has read, and its datum is one that an encoder of this package wrote (the refund datum of an escrow comes out of an escrow datum that decodePlutusData has checked; vault-read.ts sizes the vault datum that encodeVaultDatum writes); an output of the wallet comes from OgmiosProvider, whose inline datums pass the check of cbor-depth.ts (readableDatum)',
  },
  {
    decode: 'pay.ToAddress: an address as text',
    call: /\.pay\.ToAddress\s*\(/,
    files: [
      'builder/src/vector/build.ts', 'builder/src/vector/identity-build.ts', 'builder/src/vector/marketplace-advert-build.ts', 'builder/src/vector/marketplace-advert.ts',
      'builder/src/vector/marketplace-build.ts', 'builder/src/vector/module1-build.ts', 'builder/src/vector/reputation-actions.ts',
    ],
    why: 'the address has been read through addressDetails before (requireValidRecipient, paymentKeyHashOf, which walletOf calls), or this package made it from a key hash (credentialToAddress), or it comes out of an escrow datum that decodePlutusData has checked',
  },
  {
    decode: 'pay.ToAddressWithData: an address as text and an inline datum',
    call: /\.pay\.ToAddressWithData\s*\(/,
    files: [
      'builder/src/vector/build.ts', 'builder/src/vector/marketplace-advert-build.ts', 'builder/src/vector/marketplace-advert.ts', 'builder/src/vector/marketplace-build.ts',
      'builder/src/vector/reputation-actions.ts', 'builder/src/vector/reputation-build.ts', 'builder/src/vector/vault-build.ts',
    ],
    why: 'the address is the address of a script that this package knows (a deployment, a constant, or what validatorToAddress makes from the script), or one of the addresses of pay.ToAddress; the datum is one that an encoder of this package wrote, or the datum of a caller, which assertPlutusDataHex has checked (build.ts)',
  },
  {
    decode: 'pay.ToContract: the address of a script and an inline datum',
    call: /\.pay\.ToContract\s*\(/,
    files: [
      'builder/src/vector/attestation-build.ts', 'builder/src/vector/delegation-build.ts', 'builder/src/vector/gov-tx.ts', 'builder/src/vector/identity-build.ts',
      'builder/src/vector/jury-build.ts', 'builder/src/vector/module1-build.ts',
    ],
    why: 'the address is the address of a script of a deployment, or of an output that the node lists for it; the datum is one that an encoder of this package wrote',
  },
];

describe('the calls that decode inside Lucid are named', () => {
  const code = new Map<string, string>();
  for (const directory of SOURCE_DIRECTORIES) for (const path of sourceFiles(join(PACKAGES, directory))) code.set(relative(PACKAGES, path), codeOf(path));

  for (const { decode, call, files, why } of LUCID_DECODES) {
    test(`${decode}: the files that make the call are the named ones`, () => {
      const found = [...code].filter(([, text]) => call.test(text)).map(([file]) => file).sort();
      assert.deepEqual(found, [...files].sort(), `name the new call in LUCID_DECODES, with the check that protects it (now: ${why})`);
    });
  }
});

/** The call of each wrapper, as the sources spell it. */
const WRAPPER_CALL: Record<string, RegExp> = {
  decodeTransaction: /\bdecodeTransaction\s*\(/,
  decodePlutusData: /\bdecodePlutusData\s*\(/,
  decodeMetadatum: /\bdecodeMetadatum\s*\(/,
  assertDatumInput: /\bassertDatumInput\s*\(/,
  assertScriptInput: /\bassertScriptInput\s*\(/,
  assertCborHexDepth: /\bassertCborHexDepth\s*\(/,
};

const DEFINITION = 'the definition of the wrapper';

/** Where the bytes of each wrapper come from, by the file that calls it. A call in a file that is not named here fails the test. */
const WRAPPER_SITES: Record<string, Record<string, string>> = {
  decodeTransaction: {
    'builder/src/vector/guarded-decode.ts': DEFINITION,
    'builder/src/vector/attestation-build.ts': 'the transaction that Lucid has just built: the output that holds the token',
    'builder/src/vector/delegation-cosign.ts': 'the txCbor of a caller (vector_delegation_request_cosign), checked before the library reads it',
    'builder/src/vector/gov-tx.ts': 'the transaction that Lucid has just built: the output that holds the lock or the proposal',
    'builder/src/vector/identity-build.ts': 'the transaction that Lucid has just built: the output that holds the record',
    'builder/src/vector/jury-chain.ts': 'the transaction that Lucid has just built: its first input',
    'builder/src/vector/jury-document.ts': 'the transaction CBOR that Koios or Blockfrost gives for a document',
    'builder/src/vector/marketplace-advert-build.ts': 'the transaction that Lucid has just built: the output that holds the advert',
    'builder/src/vector/marketplace-advert.ts': 'the transaction that Lucid has just built: the output that holds the advert',
    'builder/src/vector/marketplace-build.ts': 'the transaction that Lucid has just built: the output that holds the escrow',
    'builder/src/vector/module1-build.ts': 'the transaction that Lucid has just built: the payout of a withdrawal',
    'builder/src/vector/reputation-build.ts': 'the transaction that Lucid has just built: the output that holds the stake',
    'builder/src/vector/wallet-build-text.ts': 'the transaction that Lucid has just built: the text of a build answer',
  },
  decodePlutusData: {
    'builder/src/vector/guarded-decode.ts': DEFINITION,
    'builder/src/vector/attestation-read.ts': 'the inline datum of an attestation output, from the node or Koios',
    'builder/src/vector/gov-codec.ts': 'the datums of the Module-6 outputs, from the node',
    'builder/src/vector/identity-codec.ts': 'the datums of the identity registry (records, attestations, delegations, vaults, escrows), from the node or Koios',
    'builder/src/vector/identity-deployment.ts': 'the datum of the config output of the identity registry, from the node',
    'builder/src/vector/jury-codec.ts': 'the datums of Module-1 and of the jury, from the node or Koios',
    'builder/src/vector/marketplace-datum.ts': 'the datums of the marketplace (adverts and escrows), from the node or Koios',
    'builder/src/vector/registry-build.ts': 'the datum of the legacy agent registry, from the node',
    'builder/src/vector/reputation-datum.ts': 'the stake datum, the parameters datum and the references datum, from the node or Koios',
  },
  decodeMetadatum: {
    'builder/src/vector/guarded-decode.ts': DEFINITION,
    'builder/src/vector/jury-document.ts': 'the metadata that Koios or Blockfrost gives for a document',
  },
  assertDatumInput: {
    'builder/src/vector/guarded-decode.ts': DEFINITION,
    'builder/src/vector/build.ts': 'the initialDatum, the datum and the redeemer of a caller',
  },
  assertScriptInput: {
    'builder/src/vector/guarded-decode.ts': DEFINITION,
    'builder/src/vector/build.ts': 'the scriptCbor of a caller',
  },
  assertCborHexDepth: {
    'shared/src/cbor-depth.ts': DEFINITION,
    'builder/src/vector/build.ts': 'the txCbor of a caller (declaredFee), which no library reads',
    'builder/src/vector/guarded-decode.ts': 'the wrappers',
    'builder/src/vector/marketplace-indexer.ts': 'the inline datums of the rows that Koios gives',
    'shared/src/provider.ts': 'the inline datums that Ogmios and Koios give for an output, and a datum that is looked up by its hash',
  },
};

describe('each call of a wrapper is named, with where its bytes come from', () => {
  for (const [wrapper, named] of Object.entries(WRAPPER_SITES)) {
    test(`${wrapper}: the files that call it are the named ones`, () => {
      const found: string[] = [];
      for (const directory of SOURCE_DIRECTORIES) {
        for (const path of sourceFiles(join(PACKAGES, directory))) if (WRAPPER_CALL[wrapper].test(codeOf(path))) found.push(relative(PACKAGES, path));
      }
      assert.deepEqual(found.sort(), Object.keys(named).sort(), `name the new call of ${wrapper} in WRAPPER_SITES, with where its bytes come from`);
    });
  }
});

describe('the input of a caller is checked before a library reads it', () => {
  const build = codeOf(join(PACKAGES, 'builder/src/vector/build.ts'));

  test('build.ts calls assertScriptInput before each applyDoubleCborEncoding, and assertDatumInput for each datum and redeemer', () => {
    const calls = [...build.matchAll(/\bapplyDoubleCborEncoding\s*\(/g)].map((match) => match.index!);
    assert.equal(calls.length, 2, 'the deploy builder and the interact builder');
    for (const at of calls) {
      const function_ = build.slice(build.lastIndexOf('\nexport async function ', at), at);
      assert.ok(function_.includes('assertScriptInput(p.scriptCbor)'), 'the check comes before the call in the same function');
    }
    for (const name of ['initialDatum', 'datum', 'redeemer']) assert.ok(build.includes(`assertDatumInput(p.${name}, '${name}')`), `${name} is checked`);
  });

  test('the signer checks the bytes before each decoder call', () => {
    const directory = join(PACKAGES, 'signer/src');
    for (const path of sourceFiles(directory)) {
      const code = codeOf(path);
      const reads = [...code.matchAll(/\bfrom_cbor_hex\s*\(/g)].map((match) => match.index!);
      for (const at of reads) {
        assert.ok(code.lastIndexOf('assertCborHexDepth(', at) >= 0, `${relative(PACKAGES, path)} checks the bytes before it calls from_cbor_hex`);
      }
    }
  });
});
