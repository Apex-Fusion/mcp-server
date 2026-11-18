// packages/builder/test/tx-fee.test.ts
// The fee of a transaction that a caller gives vector_dry_run: readTransactionFee reads it from the bytes (tx-fee.ts), and declaredFee
// (build.ts) gives it. No decoder library reads the transaction. The reader gets the bytes of the caller as they are, so the tests give it
// bytes that are not well-formed CBOR too: it must return at once, give no error, and give nothing, or the fee when key 2 comes before the
// bad part. Each direct call of the reader has a time limit (atOnce), so that a reader that does not return fails its test and does not
// hang the run.
import { afterEach, describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { CML } from '@lucid-evolution/lucid';
import { readTransactionFee } from '../src/vector/tx-fee.ts';
import {
  buildDeployContract, buildInteractContract, buildMultiOutput, buildSendApex, buildSendTokens, declaredFee, lucidForAddress,
} from '../src/vector/build.ts';
import { buildDocumentPublish } from '../src/vector/jury-build.ts';
import { FIXTURE_TOKEN_UNIT, FIXTURE_UTXOS, FIXTURE_TXHASH, FOREIGN_ADDRESS, FixtureProvider, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { NOW, WALLET_ADDRESS, juryWorld } from './fixtures/jury-world.ts';

afterEach(() => { mock.restoreAll(); });

/** The time that a call may take, in milliseconds: the reader takes microseconds. */
const LIMIT_MS = 2000;
const callScript = new Script('call()');
const callContext = createContext({ call: (): unknown => undefined });
/** Runs `call` with a time limit. A call that does not return in `limitMs` ends with an error: vm stops a loop that never ends. */
function atOnce<T>(call: () => T, limitMs = LIMIT_MS): T {
  callContext.call = call;
  return callScript.runInContext(callContext, { timeout: limitMs }) as T;
}

const INPUT = `825820${'22'.repeat(32)}00`;
const OUTPUT = `a200581d61${'11'.repeat(28)}011a001e8480`;
/** [body, witness set, is valid, no auxiliary data]: the body holds one input, one output and the fee `fee` (CBOR hex of an integer). */
const withFee = (fee: string): string => `84a30081${INPUT}0181${OUTPUT}02${fee}a0f5f6`;
/** A transaction whose body is `body` (a CBOR map, hex). */
const withBody = (body: string): string => `84${body}a0f5f6`;
const bytesOf = (hex: string): Uint8Array => Buffer.from(hex, 'hex');
const feeOf = (hex: string): bigint | undefined => atOnce(() => readTransactionFee(bytesOf(hex)));
const NOT_READ = 'txCbor does not decode as a transaction (expected the hex CBOR of a built transaction), so it cannot be evaluated.';

/** A body of two keys, key 2 (the fee 5) and key 0, with `bad` in each place before key 2. */
const beforeFee = (bad: string): Record<string, string> => ({
  'as the value of key 0': withBody(`a2 00 ${bad} 02 05`.replace(/ /g, '')),
  'as a key': withBody(`a2 ${bad} 00 02 05`.replace(/ /g, '')),
  'as an item of an array': withBody(`a2 00 81 ${bad} 02 05`.replace(/ /g, '')),
  'as an item of an array of indefinite length': withBody(`a2 00 9f ${bad} ff 02 05`.replace(/ /g, '')),
  'in a body of indefinite length': withBody(`bf 00 ${bad} 02 05 ff`.replace(/ /g, '')),
  'as the first item of the transaction': `84${bad}a0f5f6`,
  'as the transaction': bad,
});
/** The same fee 5, with `bad` after it. */
const afterFee = (bad: string): Record<string, string> => ({
  'as the value of key 0': withBody(`a2 02 05 00 ${bad}`.replace(/ /g, '')),
  'as a key': withBody(`a2 02 05 ${bad} 00`.replace(/ /g, '')),
  'in a body of indefinite length': withBody(`bf 02 05 00 ${bad} ff`.replace(/ /g, '')),
});
/** `bad` gives nothing in each place before key 2, and the fee 5 in each place after it. */
function assertBad(name: string, bad: string): void {
  for (const [place, hex] of Object.entries(beforeFee(bad))) assert.equal(feeOf(hex), undefined, `${name}, ${place}`);
  for (const [place, hex] of Object.entries(afterFee(bad))) assert.equal(feeOf(hex), 5n, `${name}, ${place}, after the fee`);
}

describe('readTransactionFee', () => {
  test('reads the integer under key 2 in each width and each encoding, and gets what CML gets', () => {
    const fees: Array<[string, string]> = [
      ['00', '0'], ['17', '23'], ['1818', '24'], ['18ff', '255'], ['190100', '256'], ['19ffff', '65535'], ['1a00010000', '65536'],
      ['1affffffff', '4294967295'], ['1b0000000100000000', '4294967296'], ['1b001fffffffffffff', '9007199254740991'],
      ['1b0020000000000000', '9007199254740992'], ['1b0020000000000001', '9007199254740993'], ['1b0123456789abcdef', '81985529216486895'],
      ['1bffffffffffffffff', '18446744073709551615'],
      ['0a', '10'], ['180a', '10'], ['19000a', '10'], ['1a0000000a', '10'], ['1b000000000000000a', '10'],
    ];
    for (const [hex, expected] of fees) {
      const tx = withFee(hex);
      assert.equal(feeOf(tx), BigInt(expected), hex);
      assert.equal(feeOf(`84a102${hex}`), BigInt(expected), `${hex}, with the bytes that end after the fee`);
      assert.equal(declaredFee(tx), expected, hex);
      assert.equal(CML.Transaction.from_cbor_hex(tx).body().fee().toString(), expected, `CML reads ${hex} as ${expected}`);
    }
  });

  test('a body and a transaction of indefinite length are read', () => {
    const body = `bf0081${INPUT}0181${OUTPUT}020aff`;
    assert.equal(feeOf(`9f${body}a0f5f6ff`), 10n);
    assert.equal(feeOf(`84${body}a0f5f6`), 10n);
    assert.equal(feeOf(`9f${body}ff`), 10n);
    assert.equal(declaredFee(`9f${body}a0f5f6ff`), '10');
    assert.equal(CML.Transaction.from_cbor_hex(`84${body}a0f5f6`).body().fee().toString(), '10');
  });

  // A value of each shape, and its place: as the value of key 0 and as a key, before key 2. The reader skips it and reads the fee.
  const SHAPES: Record<string, string> = {
    'an empty array': '80', 'an empty map': 'a0', 'arrays in arrays': '8181818100', 'maps in maps': 'a100a100a100a10000',
    'an array of indefinite length': '9f0102ff', 'a map of indefinite length': 'bf0102ff', 'an empty indefinite array': '9fff',
    'a byte string': '43010203', 'a byte string with a 1-byte length': `5820${'ab'.repeat(32)}`, 'a byte string with a 2-byte length': `590100${'cd'.repeat(256)}`,
    'a byte string with a 4-byte length': `5a00010000${'ef'.repeat(65536)}`, 'a byte string with an 8-byte length': '5b0000000000000003010203',
    'a byte string of indefinite length': '5f41014202035820' + 'aa'.repeat(32) + 'ff', 'a text string': '63616263', 'a text string of indefinite length': '7f6161626262ff',
    'CBOR in a byte string under tag 24': 'd81843d8799f', 'a big integer under a tag': 'c249010000000000000000', 'tags in tags': 'c1c2c34100',
    'a negative integer': '3863', 'a float of 2 bytes': 'f93c00', 'a float of 8 bytes': 'fb3ff0000000000000', 'false, true, null and undefined': '84f4f5f6f7',
    'a simple value of 1 byte': 'f8ff', 'an array with an 8-byte count': '9b00000000000000020102',
    'an array of maps with tags and strings': '81a2c1614143aabbcc81f6a1d8184100a0',
    'arrays that have different counts': '838201028303040506', 'tags in an array of indefinite length': '9fc100c201ff', 'tags in a map of indefinite length': 'bfc100c201ff',
    'arrays of definite length in an array of indefinite length': '9f8282010203ff', 'a map of indefinite length in an array': '82bf0102ff03',
  };
  test('skips a value of any shape before key 2: as a value, and as a key', () => {
    for (const [name, value] of Object.entries(SHAPES)) {
      assert.equal(feeOf(withBody(`a2${'00'}${value}0205`)), 5n, `${name}, as a value`);
      assert.equal(feeOf(withBody(`a3${value}00${'00'}${value}0205`)), 5n, `${name}, as a key and a value`);
      assert.equal(feeOf(withBody(`bf${value}${value}0205ff`)), 5n, `${name}, in a body of indefinite length`);
    }
  });

  test('gives nothing when the bytes hold no fee: no key 2, a key 2 that holds no unsigned integer, a first item that is no map, or no array', () => {
    const none: Record<string, string> = {
      'an empty body': withBody('a0'), 'a body with other keys': withBody('a20080 0180'.replace(/ /g, '')), 'an empty body of indefinite length': withBody('bfff'),
      'a body of indefinite length with other keys': withBody('bf0080ff'),
      'a negative integer as the fee': withBody('a10220'), 'a byte string as the fee': withBody('a1024105'), 'a text string as the fee': withBody('a1026135'),
      'an array as the fee': withBody('a1028105'), 'a map as the fee': withBody('a102a10501'), 'a tag as the fee': withBody('a102c10a'),
      'a tagged big integer as the fee': withBody('a102c24101'), 'null as the fee': withBody('a102f6'), 'a float as the fee': withBody('a102f93c00'),
      'no value for key 2': '84a102', 'an unsigned integer cut inside its argument': '84a1021a0000', 'the key 2 as a text string': withBody('a1613200'),
      'the key 2 as a negative integer': withBody('a12100'), 'the key 2 as a byte string': withBody('a1410200'), 'the key 2 as an array': withBody('a1810200'),
      'a first item that is an array': '84' + '80' + 'a0f5f6', 'a first item that is an integer': '84' + '02' + 'a0f5f6', 'a first item that is a byte string': '84410ba0f5f6',
      'a first item that is a tag': '84c1a0a0f5f6', 'a first item that is an array that has the shape of a body': '84820205a0f5f6',
      'an array with no item': '80', 'an empty array, and a body after it': '80a10205', 'an indefinite array with no item': '9fff', 'an indefinite array that is cut': '9f', 'no bytes': '',
      'a break code where a value is': withBody('a200ff0205'), 'a reserved header where key 2 would be': withBody('a11c0000000000000000000000000000000205'),
      'an integer': '02', 'a map': 'a10205', 'a byte string': '4102', 'null': 'f6', 'a break code': 'ff', 'a reserved header': 'fc', 'a reserved array header': '9c',
    };
    for (const [name, hex] of Object.entries(none)) {
      assert.equal(feeOf(hex), undefined, name);
      assert.throws(() => declaredFee(hex), { message: NOT_READ }, name);
    }
  });

  test('the first key 2 is the fee', () => {
    assert.equal(feeOf(withBody('a3 02 07 00 80 02 08'.replace(/ /g, ''))), 7n);
  });

  test('a key 2 after the end of the body is not the fee', () => {
    for (const hex of ['84a00205f5f6', '84a100000205f5f6', '84bf0000ff0205f5f6', '84a0a10205f5f6']) {
      assert.equal(feeOf(hex), undefined, hex);
    }
  });

  test('gives the fee or nothing for each part of a built transaction, and no error', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const built = await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 });
    const bytes = bytesOf(built.txCbor);
    let read = 0;
    for (let length = 0; length < bytes.length; length += 1) {
      const fee = atOnce(() => readTransactionFee(bytes.subarray(0, length)));
      assert.ok(fee === undefined || fee === BigInt(built.fee), `${length} bytes gave ${fee}`);
      if (fee !== undefined) read += 1;
    }
    assert.ok(read > 0 && read < bytes.length, 'the fee is read once the bytes reach it, and not before');
    assert.equal(readTransactionFee(bytes), BigInt(built.fee));
  });

  test('a length or a count that goes past the bytes gives nothing, and no memory is allocated for it', () => {
    for (const hex of [
      '84a100 5bffffffffffffffff', '84a100 9bffffffffffffffff', '84a100 bbffffffffffffffff', '84a100 5affffffff00', '84a100 7bffffffffffffffff',
      '84bbffffffffffffffff', '84a9ffffffffffffffff00',
    ]) {
      assert.equal(feeOf(hex.replace(/ /g, '')), undefined, hex);
    }
  });

  test('a body with 200,000 keys before key 2 is read', () => {
    const body = `ba00030d41${'0100'.repeat(200_000)}0205`;
    assert.equal(feeOf(withBody(body)), 5n);
    assert.equal(declaredFee(withBody(body)), '5');
  });

  // Bytes that are not well-formed CBOR. For each kind of bad item the reader returns at once and gives no error. It gives nothing when the
  // bad item is before key 2 (in each place that an item can be), and the fee when key 2 comes first: the reader reads no more than it needs.
  test('an indefinite string whose chunk has no definite length gives nothing, and the reader returns', () => {
    const strings: Record<string, string> = {
      'a byte string in a byte string': '5f5fffff', 'a text string in a text string': '7f7fffff', 'a text string in a byte string': '5f7fffff',
      'a byte string in a text string': '7f5fffff', 'a chunk that is cut': '5f5f', 'a chunk that ends, in a string that does not': '5f5fff',
      'two such chunks': '5f5f5fffffff', 'such a chunk after a chunk that is read': '5f41015fffff',
    };
    for (const [name, bad] of Object.entries(strings)) assertBad(name, bad);
  });

  test('an indefinite string with a chunk of another major type: the reader takes the header of the chunk and the bytes that it counts, and returns', () => {
    // A text chunk in a byte string, and the reverse, are read as a chunk. The node judges what is wrong with them.
    assert.equal(feeOf(withBody('a2 00 5f 6141 ff 02 05'.replace(/ /g, ''))), 5n);
    assert.equal(feeOf(withBody('a2 00 7f 4141 ff 02 05'.replace(/ /g, ''))), 5n);
    // A chunk with no definite length, a reserved header, and a count that goes past the bytes give nothing.
    for (const chunk of ['9f', 'bf', '9fff', 'bfff', '1c', '1f', 'fc', '1bffffffffffffffff', '9bffffffffffffffff', '5bffffffffffffffff']) {
      assertBad(`a chunk ${chunk}`, `5f${chunk}ff`);
    }
  });

  test('a break code where none is allowed gives nothing', () => {
    assertBad('a break code', 'ff');
    assertBad('a break code after an empty string of indefinite length', '5fffff');
    assertBad('a break code after an empty array of indefinite length', '9fffff');
    assertBad('a break code after a tag', 'c1ff');
    assertBad('a break code after a key', '00ff');
  });

  test('a tag with no content gives nothing', () => {
    for (const tags of ['c1', 'c1c2c3', 'd818', 'd90100', 'daffffffff', 'db0000000000000001']) {
      assert.equal(feeOf(`84a100${tags}`), undefined, `${tags} as a value`);
      assert.equal(feeOf(`84a1${tags}`), undefined, `${tags} as a key`);
      assert.equal(feeOf(`84a2020500${tags}`), 5n, `${tags} after the fee`);
    }
  });

  test('an additional information that CBOR does not allow gives nothing, for each major type', () => {
    for (let major = 0; major < 8; major += 1) {
      for (const information of [28, 29, 30]) assertBad(`major ${major}, information ${information}`, ((major << 5) | information).toString(16));
    }
    // 31 is for the strings, the arrays and the maps of indefinite length, and for the break code (major 7).
    for (const major of [0, 1, 6]) assertBad(`major ${major}, information 31`, ((major << 5) | 31).toString(16));
  });

  test('a header that is cut inside its argument gives nothing, for each major type and each width', () => {
    for (let major = 0; major < 8; major += 1) {
      for (const [information, size] of [[24, 1], [25, 2], [26, 4], [27, 8]]) {
        const cut = ((major << 5) | information).toString(16) + '00'.repeat(size - 1);
        assert.equal(feeOf(`84a100${cut}`), undefined, `major ${major}, ${size} bytes of argument, as a value`);
        assert.equal(feeOf(`84a1${cut}`), undefined, `major ${major}, ${size} bytes of argument, as a key`);
        assert.equal(feeOf(`84a102${cut}`), undefined, `major ${major}, ${size} bytes of argument, as the fee`);
      }
    }
  });

  test('a length or a count that goes past the bytes gives nothing, for each major type and each width of its argument', () => {
    for (const major of [2, 3, 4, 5]) {
      for (const [information, size] of [[24, 1], [25, 2], [26, 4], [27, 8]]) {
        assertBad(`major ${major}, ${size} bytes of count`, ((major << 5) | information).toString(16) + 'ff'.repeat(size));
      }
    }
  });

  test('an empty input gives nothing', () => {
    assert.equal(atOnce(() => readTransactionFee(new Uint8Array(0))), undefined);
  });

  test('every short sequence of bytes, as the value of key 0 and as a key before key 2, gives a fee or nothing, and the reader returns', () => {
    const alphabet = [
      0x00, 0x01, 0x02, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1f, 0x20, 0x3f, 0x40, 0x41, 0x58, 0x5f, 0x60, 0x61, 0x7f, 0x80, 0x81, 0x9f, 0xa0, 0xa1,
      0xbf, 0xc1, 0xd8, 0xdf, 0xf4, 0xf6, 0xf9, 0xfb, 0xfc, 0xff,
    ];
    const calls = atOnce(() => {
      let count = 0;
      const tail = [0x02, 0x05, 0xa0, 0xf5, 0xf6];
      const tryBytes = (...parts: number[][]): void => {
        const fee: unknown = readTransactionFee(Uint8Array.from(parts.flat()));
        if (fee !== undefined && typeof fee !== 'bigint') throw new Error(`the reader gave ${String(fee)}`);
        count += 1;
      };
      const each = (sequence: number[]): void => {
        tryBytes([0x84, 0xa2, 0x00], sequence, tail);
        tryBytes([0x84, 0xa2], sequence, [0x00, ...tail]);
        tryBytes([0x84, 0xbf, 0x00], sequence, [...tail.slice(0, 2), 0xff, 0xa0, 0xf5, 0xf6]);
      };
      each([]);
      for (const a of alphabet) {
        each([a]);
        for (const b of alphabet) {
          each([a, b]);
          for (const c of alphabet) each([a, b, c]);
        }
      }
      return count;
    }, 20_000);
    assert.ok(calls > 100_000, `${calls} calls`);
  });
});

describe('declaredFee', () => {
  test('gives the fee that CML gives, for each kind of transaction that the builders build, and calls no decoder', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const script = '49480100002221200101';
    const deploy = (initialDatum?: string) => ({ scriptCbor: script, scriptType: 'PlutusV2' as const, initialDatum });
    const interact = { scriptCbor: script, scriptType: 'PlutusV2' as const, changeAddress: OWN_ADDRESS };
    const scriptAddress = (await buildDeployContract(lucid, deploy('d87980'))).scriptAddress;
    const withScript = await lucidForAddress(new FixtureProvider([...FIXTURE_UTXOS, {
      txHash: FIXTURE_TXHASH, outputIndex: 7, address: scriptAddress, assets: { lovelace: 2_000_000n }, datum: 'd87980',
    }]), OWN_ADDRESS);
    const juryNode = juryWorld();
    const built = [
      (await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 })).txCbor,
      (await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3, metadataJson: '{"674":{"msg":["a note"]}}' })).txCbor,
      (await buildSendTokens(lucid, { recipientAddress: FOREIGN_ADDRESS, policyId: FIXTURE_TOKEN_UNIT.slice(0, 56), assetName: FIXTURE_TOKEN_UNIT.slice(56), amount: '10' })).txCbor,
      (await buildMultiOutput(lucid, { outputs: Array.from({ length: 12 }, (_, i) => ({ address: FOREIGN_ADDRESS, lovelace: 2_000_000 + i })) })).txCbor,
      (await buildDeployContract(lucid, deploy('d8799f0102ff'))).txCbor,
      (await buildInteractContract(withScript, { ...interact, action: 'lock', datum: 'd87980' })).txCbor,
      (await buildInteractContract(withScript, { ...interact, action: 'spend', redeemer: 'd87980' })).txCbor,
      (await buildDocumentPublish(await lucidForAddress(juryNode, WALLET_ADDRESS), juryNode, {
        changeAddress: WALLET_ADDRESS, bytes: Buffer.from('{"type":"evidence","text":"ok"}', 'utf8'), type: 'evidence', nowMs: NOW,
      })).txCbor,
    ];
    const expected = built.map((cbor) => CML.Transaction.from_cbor_hex(cbor).body().fee().toString());
    assert.ok(expected.every((fee) => BigInt(fee) > 0n));
    const decoder = mock.method(CML.Transaction, 'from_cbor_hex', () => { throw new Error('CML decoded a transaction that a caller gave'); });
    assert.deepEqual(built.map((cbor) => declaredFee(cbor)), expected);
    assert.equal(decoder.mock.callCount(), 0);
  });

  test('a fee above 2^53 is given in full', () => {
    assert.equal(declaredFee(withFee('1b0020000000000001')), '9007199254740993');
    assert.equal(declaredFee(withFee('1bffffffffffffffff')), '18446744073709551615');
  });

  test('bytes that hold no fee keep the old message', () => {
    for (const tx of ['zz', 'a1', '84', 'ff', 'f6', '84a0a0f5f6', withBody('a1024105'), '84a1021a0000']) {
      assert.throws(() => declaredFee(tx), { message: NOT_READ }, tx);
    }
  });

  test('a transaction whose fee can be read goes on, and the node judges the rest of it', () => {
    const decoder = mock.method(CML.Transaction, 'from_cbor_hex', () => { throw new Error('CML decoded a transaction that a caller gave'); });
    // An address of one byte, no witnesses, and a body key that no ledger rule knows: the fee is there, and the node refuses the rest.
    assert.equal(declaredFee(`84a40081${INPUT}0181a20041000100020a18ff4100a0f5f6`), '10');
    assert.equal(declaredFee(`84a30081${INPUT}0181${OUTPUT}0207a0f5f6`), '7');
    assert.equal(decoder.mock.callCount(), 0);
  });

  test('bytes that are not well-formed give the old message at once, or the fee when key 2 comes first, and no decoder is called', () => {
    const decoder = mock.method(CML.Transaction, 'from_cbor_hex', () => { throw new Error('CML decoded a transaction that a caller gave'); });
    for (const bad of ['5f5fffff', '7f7fffff', 'ff', '1c', '9bffffffffffffffff', '5f5f']) {
      for (const [place, hex] of Object.entries(beforeFee(bad))) assert.throws(() => atOnce(() => declaredFee(hex)), { message: NOT_READ }, `${bad} ${place}`);
      for (const [place, hex] of Object.entries(afterFee(bad))) assert.equal(atOnce(() => declaredFee(hex)), '5', `${bad} ${place}, after the fee`);
    }
    assert.equal(decoder.mock.callCount(), 0);
  });
});
