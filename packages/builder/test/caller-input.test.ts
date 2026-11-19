// packages/builder/test/caller-input.test.ts
// The hex that a caller gives for a part of a transaction (a datum, a redeemer, a script) is checked before a library reads it: at most
// 32,768 hex characters, and a script is one CBOR byte string. The tests: the two functions of guarded-decode.ts, then the two builders that
// use them. A script and a datum of the shapes that real scripts and datums have are accepted, and so are the ones at the limits.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDoubleCborEncoding, validatorToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { assertDatumInput, assertScriptInput } from '../src/vector/guarded-decode.ts';
import { buildDeployContract, buildInteractContract, lucidForAddress } from '../src/vector/build.ts';
import { FIXTURE_TXHASH, FIXTURE_UTXOS, FixtureProvider, OWN_ADDRESS } from './fixtures/fixture-provider.ts';

const SINGLE = '450101002499'; // one byte string: the five bytes 01 01 00 24 99
const DOUBLE = '49480100002221200101'; // a byte string that holds a byte string

/** The head of a CBOR byte string of `length` bytes, in the shortest form. */
function head(length: number): string {
  if (length < 24) return (0x40 + length).toString(16).padStart(2, '0');
  if (length < 256) return `58${length.toString(16).padStart(2, '0')}`;
  if (length < 65_536) return `59${length.toString(16).padStart(4, '0')}`;
  return `5a${length.toString(16).padStart(8, '0')}`;
}
const byteString = (content: string): string => `${head(content.length / 2)}${content}`;
/** `bytes` bytes that start as a flat script does (01 00 00). */
const flat = (bytes: number): string => `010000${'ab'.repeat(bytes - 3)}`;

describe('assertScriptInput accepts one byte string, in one encoding or in two', () => {
  test('the scripts of the tests, and byte strings with every width of head', () => {
    for (const text of [SINGLE, DOUBLE, SINGLE.toUpperCase(), DOUBLE.toUpperCase()]) assert.doesNotThrow(() => assertScriptInput(text), text);
    for (const bytes of [5, 23, 24, 255, 256, 300, 16_000]) {
      assert.doesNotThrow(() => assertScriptInput(byteString(flat(bytes))), `${bytes} bytes in one encoding`);
      assert.doesNotThrow(() => assertScriptInput(byteString(byteString(flat(bytes)))), `${bytes} bytes in two encodings`);
    }
    assert.doesNotThrow(() => assertScriptInput(`5b0000000000000003${flat(3)}`), 'a head with a length of 8 bytes');
    assert.doesNotThrow(() => assertScriptInput(`5a00000003${flat(3)}`), 'a head with a length of 4 bytes');
  });

  test('a script of exactly 32,768 hex characters is accepted, and one of 32,770 is refused with its size', () => {
    const exact = byteString(flat(16_381));
    assert.equal(exact.length, 32_768);
    assert.doesNotThrow(() => assertScriptInput(exact));
    const over = byteString(flat(16_382));
    assert.equal(over.length, 32_770);
    assert.throws(() => assertScriptInput(over), /scriptCbor has 32770 hex characters, and the most is 32768 \(a transaction has at most 16,384 bytes\)\./);
  });
});

describe('assertScriptInput refuses what is not one byte string', () => {
  const NOT_ONE = /scriptCbor is not one CBOR byte string/;
  const refused: Array<[string, string, RegExp]> = [
    ['no text', '', /scriptCbor is not hex of whole bytes/],
    ['an odd count of digits', 'abc', /scriptCbor is not hex of whole bytes/],
    ['text that is not hex', 'zz', /scriptCbor is not hex of whole bytes/],
    ['a text with a space', '45 0101002499', /scriptCbor is not hex of whole bytes/],
    ['an integer', '01', NOT_ONE],
    ['a list', '83010203', NOT_ONE],
    ['a map', 'a0', NOT_ONE],
    ['a text string', '6161', NOT_ONE],
    ['a tag', 'd87980', NOT_ONE],
    ['a byte string of indefinite length', '5f4101ff', NOT_ONE],
    ['a head that no byte string has', '5c0000', NOT_ONE],
    ['a head with its length cut', '59', NOT_ONE],
    ['a head with its length cut (4 bytes)', '5a0000', NOT_ONE],
    ['a byte string that is cut', '4501010024', NOT_ONE],
    ['a byte string with a byte after it', '45010100249900', NOT_ONE],
    ['a length that no text holds', '5bffffffffffffffff0102', NOT_ONE],
    ['a byte string with no bytes', '40', /scriptCbor holds no script bytes/],
    ['bytes that start like an array', '4381ff00', /start like an array, a map or a tag/],
    ['bytes that start like a map', '42a000', /start like an array, a map or a tag/],
    ['bytes that start like a tag', '42c000', /start like an array, a map or a tag/],
  ];
  for (const [what, text, message] of refused) {
    test(what, () => assert.throws(() => assertScriptInput(text), message));
  }

  test('text of any size is refused at once: it takes the same short time', () => {
    for (const size of [2_048, 32_768, 131_072]) {
      const started = performance.now();
      assert.throws(() => assertScriptInput('01'.repeat(size / 2)));
      assert.ok(performance.now() - started < 50, `${size} characters took ${performance.now() - started} ms`);
    }
  });
});

describe('assertDatumInput', () => {
  test('a datum and a redeemer are accepted up to 32,768 hex characters, and a longer one is refused with its size', () => {
    for (const text of ['d87980', 'd8799f0102ff', '00']) assert.doesNotThrow(() => assertDatumInput(text, 'datum'), text);
    const exact = `9f${'00'.repeat(16_382)}ff`;
    assert.equal(exact.length, 32_768);
    assert.doesNotThrow(() => assertDatumInput(exact, 'datum'));
    const over = `9f${'00'.repeat(16_383)}ff`;
    assert.equal(over.length, 32_770);
    assert.throws(() => assertDatumInput(over, 'redeemer'), /redeemer has 32770 hex characters, and the most is 32768 \(a transaction has at most 16,384 bytes\)\./);
    assert.throws(() => assertDatumInput('00'.repeat(65_536), 'initialDatum'), /initialDatum has 131072 hex characters, and the most is 32768/);
  });

  test('a datum that is nested too deep or is not CBOR is refused by the check of the nesting and the shape, as before', () => {
    assert.throws(() => assertDatumInput(`9f${'00'.repeat(16_000)}`, 'datum'), /datum is not well-formed CBOR/);
    assert.throws(() => assertDatumInput(`${'81'.repeat(65)}00`, 'datum'), /datum is nested deeper than 64 levels/);
    assert.throws(() => assertDatumInput('', 'datum'));
  });
});

describe('the deploy builder and the interact builder', () => {
  const lucid = () => lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
  const REFUSED = /scriptCbor (?:has \d+ hex characters, and the most is 32768|is not one CBOR byte string)/;

  test('a script that is not one byte string is refused before Lucid reads it, and the refusal is quick', async () => {
    const l = await lucid();
    for (const scriptCbor of ['01'.repeat(16_384), '01'.repeat(65_536), 'a0', '83010203']) {
      const started = performance.now();
      await assert.rejects(buildDeployContract(l, { scriptCbor, scriptType: 'PlutusV2' }), REFUSED);
      await assert.rejects(buildInteractContract(l, { scriptCbor, scriptType: 'PlutusV2', action: 'lock', changeAddress: OWN_ADDRESS }), REFUSED);
      assert.ok(performance.now() - started < 500, `${scriptCbor.length} characters took ${performance.now() - started} ms`);
    }
  });

  test('a script in one encoding and a script in two build the same transaction as before', async () => {
    const l = await lucid();
    for (const [scriptCbor, scriptType] of [[DOUBLE, 'PlutusV2'], [SINGLE, 'PlutusV3'], [byteString(flat(300)), 'PlutusV2']] as const) {
      const deploy = await buildDeployContract(l, { scriptCbor, scriptType });
      assert.equal(deploy.scriptType, scriptType);
      assert.ok(BigInt(deploy.fee) > 0n);
      assert.equal(deploy.scriptAddress, validatorToAddress('Mainnet', { type: scriptType, script: applyDoubleCborEncoding(scriptCbor) }));
    }
  });

  test('a datum and a redeemer of more than 32,768 hex characters are refused before Lucid reads them', async () => {
    const l = await lucid();
    const over = `9f${'00'.repeat(16_383)}ff`;
    await assert.rejects(buildDeployContract(l, { scriptCbor: DOUBLE, scriptType: 'PlutusV2', initialDatum: over }), /initialDatum has 32770 hex characters, and the most is 32768/);
    await assert.rejects(
      buildInteractContract(l, { scriptCbor: DOUBLE, scriptType: 'PlutusV2', action: 'lock', changeAddress: OWN_ADDRESS, datum: over }),
      /datum has 32770 hex characters, and the most is 32768/,
    );
    const address = validatorToAddress('Mainnet', { type: 'PlutusV2', script: applyDoubleCborEncoding(DOUBLE) });
    const scriptUtxo: UTxO = { txHash: FIXTURE_TXHASH, outputIndex: 7, address, assets: { lovelace: 2_000_000n }, datum: 'd87980' };
    const spender = await lucidForAddress(new FixtureProvider([...FIXTURE_UTXOS, scriptUtxo]), OWN_ADDRESS);
    await assert.rejects(
      buildInteractContract(spender, { scriptCbor: DOUBLE, scriptType: 'PlutusV2', action: 'spend', changeAddress: OWN_ADDRESS, redeemer: over }),
      /redeemer has 32770 hex characters, and the most is 32768/,
    );
  });
});
