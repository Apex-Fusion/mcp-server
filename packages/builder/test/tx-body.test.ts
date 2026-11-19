// packages/builder/test/tx-body.test.ts
// The keys and the bytes of the body of a transaction that another party gives: readTransactionBody reads them from the bytes (tx-body.ts).
// No decoder library reads the transaction. The reader gets the bytes as they are, so the tests give it bytes that are not well-formed CBOR
// too: it must return at once, give no error, and give nothing. Each direct call of the reader has a time limit (atOnce), so that a reader
// that does not return fails its test and does not hang the run.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import { readTransactionBody } from '../src/vector/tx-body.ts';
import {
  buildDeployContract, buildInteractContract, buildMultiOutput, buildSendApex, buildSendTokens, lucidForAddress,
} from '../src/vector/build.ts';
import { buildDocumentPublish } from '../src/vector/jury-build.ts';
import { atOnce } from './fixtures/at-once.ts';
import { delegateBuild, delegateBuildMine } from './fixtures/cosign-world.ts';
import { FIXTURE_TOKEN_UNIT, FIXTURE_UTXOS, FIXTURE_TXHASH, FOREIGN_ADDRESS, FixtureProvider, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { NOW, WALLET_ADDRESS, juryWorld } from './fixtures/jury-world.ts';

const INPUT = `825820${'22'.repeat(32)}00`;
const OUTPUT = `a200581d61${'11'.repeat(28)}011a001e8480`;
/** A transaction: the body `body` (a CBOR map, hex), no witnesses, valid, no auxiliary data. */
const withBody = (body: string): string => `84${body}a0f5f6`;
const bytesOf = (hex: string): Uint8Array => Buffer.from(hex, 'hex');
const bodyOf = (hex: string) => atOnce(() => readTransactionBody(bytesOf(hex)));
const keysOf = (hex: string): number[] | undefined => bodyOf(hex)?.keys;
/** The hex of `parts`, without the spaces that make it readable. */
const hex = (text: string): string => text.replace(/ /g, '');

/** `bad` in each place where an item can be in the body: the reader gives nothing. */
const inBody = (bad: string): Record<string, string> => ({
  'as the value of key 0': withBody(hex(`a2 00 ${bad} 02 05`)),
  'as a key': withBody(hex(`a2 ${bad} 00 02 05`)),
  'as an item of an array': withBody(hex(`a2 00 81 ${bad} 02 05`)),
  'as an item of an array of indefinite length': withBody(hex(`a2 00 9f ${bad} ff 02 05`)),
  'in a body of indefinite length': withBody(hex(`bf 00 ${bad} 02 05 ff`)),
  'as the first item of the transaction': `84${bad}a0f5f6`,
  'as the transaction': bad,
});
/** `bad` after the body: the reader does not read it, and gives the body. */
const afterBody = (bad: string): Record<string, string> => ({
  'after a body': `84a10000${bad}`,
  'after a body, in a transaction of indefinite length': `9fa10000${bad}`,
});
const BODY_END = 4;
/**
 * `bad` gives nothing in each place inside the body, and the body when it comes after it. `closes` names the one place where the bytes of `bad`
 * are not bad: a break code that closes the body of indefinite length, which is whole there and ends at `end`.
 */
function assertBad(name: string, bad: string, closes?: { place: string; end: number }): void {
  for (const [place, tx] of Object.entries(inBody(bad))) {
    const expected = closes?.place === place ? { keys: [0], start: 1, end: closes.end } : undefined;
    assert.deepEqual(bodyOf(tx), expected, `${name}, ${place}`);
  }
  for (const [place, tx] of Object.entries(afterBody(bad))) {
    assert.deepEqual(bodyOf(tx), { keys: [0], start: 1, end: BODY_END }, `${name}, ${place}`);
  }
}

describe('readTransactionBody', () => {
  test('gives the keys of the body in the order of the bytes, and the bytes that the body takes', () => {
    const body = `a30081${INPUT}0181${OUTPUT}020a`;
    assert.deepEqual(bodyOf(withBody(body)), { keys: [0, 1, 2], start: 1, end: 1 + body.length / 2 });
    assert.deepEqual(keysOf(withBody(hex('a3 16 00 04 80 02 05'))), [22, 4, 2], 'the order of the bytes, not the order of the numbers');
    assert.deepEqual(keysOf(withBody(hex('a2 04 80 04 80'))), [4, 4], 'a key that the bytes repeat is listed each time');
  });

  test('reads an unsigned integer key in each width and each encoding', () => {
    for (const [key, encodings] of [
      [4, ['04', '1804', '190004', '1a00000004', '1b0000000000000004']], [23, ['17', '1817', '190017']], [24, ['1818', '190018', '1a00000018']],
      [255, ['18ff', '1900ff']], [256, ['190100', '1a00000100']], [65535, ['19ffff']], [4294967295, ['1affffffff']], [4294967296, ['1b0000000100000000']],
      [Number.MAX_SAFE_INTEGER, ['1b001fffffffffffff']], [2 ** 53, ['1b0020000000000000']],
    ] as Array<[number, string[]]>) {
      for (const encoding of encodings) assert.deepEqual(keysOf(withBody(`a1${encoding}00`)), [key], `${key} as ${encoding}`);
    }
    // A key above 2^53 is a number that no key of the ledger has. The reader gives some number and does not stop.
    const [huge] = keysOf(withBody('a11bffffffffffffffff00')) ?? [];
    assert.ok(typeof huge === 'number' && huge > 2 ** 63);
  });

  // A value of each shape, and its place: as the value of key 0 and as a key. The reader skips it and reads the keys after it.
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
  test('skips a value of any shape: the keys after it are listed', () => {
    for (const [name, value] of Object.entries(SHAPES)) {
      assert.deepEqual(keysOf(withBody(`a3${'00'}${value}0405${'16'}00`)), [0, 4, 22], `${name}, as a value`);
      assert.deepEqual(keysOf(withBody(`bf${'00'}${value}0405${'16'}00ff`)), [0, 4, 22], `${name}, in a body of indefinite length`);
    }
  });

  test('a key that is not an unsigned integer is skipped and is not listed, and the keys after it are listed', () => {
    for (const [name, key] of Object.entries(SHAPES)) {
      assert.deepEqual(keysOf(withBody(`a3${key}00${'04'}00${'16'}00`)), [4, 22], `${name}, as a key`);
      assert.deepEqual(keysOf(withBody(`bf${key}${key}${'04'}00ff`)), [4], `${name}, as a key and a value, in a body of indefinite length`);
    }
  });

  test('a body of indefinite length ends at its break code, and the break code is part of the body', () => {
    assert.deepEqual(bodyOf(withBody('bf00000480ff')), { keys: [0, 4], start: 1, end: 7 });
    assert.deepEqual(bodyOf(`84bf0000ff${'00'.repeat(10)}`), { keys: [0], start: 1, end: 5 }, 'the bytes after the break code are not the body');
  });

  test('an empty body is read', () => {
    assert.deepEqual(bodyOf(withBody('a0')), { keys: [], start: 1, end: 2 });
    assert.deepEqual(bodyOf(withBody('bfff')), { keys: [], start: 1, end: 3 });
  });

  test('the transaction may be an array of indefinite length, and the reader reads the body and no more', () => {
    assert.deepEqual(bodyOf('9fa10000ff'), { keys: [0], start: 1, end: 4 });
    assert.deepEqual(bodyOf('9fa10000'), { keys: [0], start: 1, end: 4 }, 'with no break code: the reader does not read it');
    assert.deepEqual(bodyOf('81a10000'), { keys: [0], start: 1, end: 4 }, 'with the body as the only item');
    assert.deepEqual(bodyOf('98ffa10000'), { keys: [0], start: 2, end: 5 }, 'with a count in a byte');
  });

  test('a body ends at its count: a body that has fewer entries than its count says gives nothing, and one that has more is read up to its count', () => {
    assert.equal(bodyOf('84a20000'), undefined);
    assert.equal(bodyOf('84a1'), undefined);
    assert.deepEqual(bodyOf('84a1000004000000'), { keys: [0], start: 1, end: 4 });
    assert.deepEqual(bodyOf('84a2000004000000'), { keys: [0, 4], start: 1, end: 6 });
  });

  test('gives nothing when the bytes are not a transaction: no array, an empty array, a first item that is no map', () => {
    const none: Record<string, string> = {
      'no bytes': '', 'an integer': '02', 'a map': 'a10205', 'a byte string': '4102', 'null': 'f6', 'a break code': 'ff', 'a reserved header': 'fc', 'a reserved array header': '9c',
      'an array with no item': '80', 'an empty array, and a body after it': '80a10000', 'an indefinite array with no item': '9fff', 'an indefinite array that is cut': '9f',
      'an array that has a count and no bytes': '84', 'a first item that is an array': '8480a0f5f6', 'a first item that is an integer': '8402a0f5f6',
      'a first item that is a byte string': '84410ba0f5f6', 'a first item that is a text string': '8461 61 a0f5f6'.replace(/ /g, ''), 'a first item that is a tag': '84c1a0a0f5f6',
      'a first item that is a tag on a map': '84d81ca10000a0f5f6', 'a first item that is an array that has the shape of a body': '84820000a0f5f6',
      'a first item that is a break code': '84ffa0f5f6', 'a first item that is a reserved header': '84fca0f5f6',
    };
    for (const [name, tx] of Object.entries(none)) assert.equal(bodyOf(tx), undefined, name);
  });

  test('gives nothing when the body is cut: in a key, in a value, in a header, in a count, or with no break code', () => {
    const cut: Record<string, string> = {
      'a map that has a count and no entry': '84a1', 'a key and no value': '84a100', 'a map of indefinite length and no entry': '84bf', 'a map of indefinite length and no break code': '84bf0000',
      'a map of indefinite length and a key with no value': '84bf00', 'a key that is a byte string with no content': '84a15820', 'a value that is a byte string with a cut content': '84a100582000',
      'a value that is an array with a cut item': '84a1008201', 'a value that is an array of indefinite length with no break code': '84a1009f01',
      'a key that is an array of indefinite length with no break code': '84a19f0100', 'a value that is a tag with no item': '84a100c1', 'a header cut in its argument': '84a1001a0000',
      'a key that is cut in its argument': '84a11a000000',
      'a key that cannot be skipped, with a value after it': '84a15f5f0000', 'a value that cannot be skipped, with an entry after it': '84a2005f5f0400',
      'a value that is a byte string of indefinite length with a chunk and no break code': '84a1005f4101', 'a value that is a text string of indefinite length with a chunk and no break code': '84a1007f6161',
      'a value that is a byte string of indefinite length with no chunk and no break code': '84a1005f',
      'a value that is an array with a byte string of indefinite length that has no break code': '84a100815f4101',
    };
    for (const [name, tx] of Object.entries(cut)) assert.equal(bodyOf(tx), undefined, name);
  });

  test('a transaction cut at any length gives nothing until the body is whole, and then the same body', () => {
    // A body of every kind of item that a body has: arrays, maps, strings of each width, tags, indefinite forms.
    const body = hex(`bf 00 81 ${INPUT} 01 81 ${OUTPUT} 02 1a000186a0 a1 81 00 5f 41 01 42 02 03 ff 09 a1 d8 18 43 d8 79 9f 7f 61 61 62 62 62 ff 0d 9f 01 02 ff 00 ff`);
    const tx = withBody(body);
    const bytes = bytesOf(tx);
    const end = 1 + body.length / 2;
    const whole = atOnce(() => readTransactionBody(bytes));
    assert.ok(whole !== undefined, 'the whole transaction is read');
    assert.equal(whole.end, end);
    for (let length = 0; length <= bytes.length; length += 1) {
      const found = atOnce(() => readTransactionBody(bytes.subarray(0, length)));
      if (length < end) assert.equal(found, undefined, `${length} bytes`);
      else assert.deepEqual(found, whole, `${length} bytes`);
    }
  });

  test('a length or a count that goes past the bytes gives nothing, and no memory is allocated for it', () => {
    for (const tx of [
      '84a100 5bffffffffffffffff', '84a100 9bffffffffffffffff', '84a100 bbffffffffffffffff', '84a100 5affffffff00', '84a100 7bffffffffffffffff',
      '84a1 5bffffffffffffffff 00', '84a1 9bffffffffffffffff 00', '84bbffffffffffffffff', '84baffffffff00', '84a9ffffffffffffffff00',
    ]) {
      assert.equal(bodyOf(hex(tx)), undefined, tx);
    }
  });

  test('a body with 200,000 entries is read', () => {
    const body = `ba00030d41${'0100'.repeat(200_000)}0405`;
    const found = bodyOf(withBody(body));
    assert.ok(found !== undefined);
    assert.equal(found.keys.length, 200_001);
    assert.ok(found.keys.slice(0, 200_000).every((key) => key === 1));
    assert.equal(found.keys[200_000], 4);
    assert.equal(found.end, 1 + body.length / 2);
  });

  // Bytes that are not well-formed CBOR. For each kind of bad item the reader returns at once and gives no error. It gives nothing when the bad
  // item is inside the body (in each place that an item can be), and it gives the body when the bad item comes after it: the reader does not
  // read more than the body.
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
    assert.deepEqual(keysOf(withBody(hex('a2 00 5f 6141 ff 02 05'))), [0, 2]);
    assert.deepEqual(keysOf(withBody(hex('a2 00 7f 4141 ff 02 05'))), [0, 2]);
    // A chunk with no definite length, a reserved header, and a count that goes past the bytes give nothing.
    for (const chunk of ['9f', 'bf', '9fff', 'bfff', '1c', '1f', 'fc', '1bffffffffffffffff', '9bffffffffffffffff', '5bffffffffffffffff']) {
      assertBad(`a chunk ${chunk}`, `5f${chunk}ff`);
    }
  });

  test('a break code where none is allowed gives nothing; where a map of indefinite length can end, it ends the body', () => {
    assertBad('a break code', 'ff');
    assertBad('a break code after a tag', 'c1ff');
    // These end with a break code that closes the body when the body has indefinite length, and then the body is whole: the bytes after it are not read.
    assertBad('a break code after an empty string of indefinite length', '5fffff', { place: 'in a body of indefinite length', end: 6 });
    assertBad('a break code after an empty array of indefinite length', '9fffff', { place: 'in a body of indefinite length', end: 6 });
    assertBad('a break code after a key', '00ff', { place: 'in a body of indefinite length', end: 5 });
    assert.deepEqual(bodyOf(withBody('bf005fffff0205ff')), { keys: [0], start: 1, end: 6 });
  });

  test('a tag with no content gives nothing', () => {
    for (const tags of ['c1', 'c1c2c3', 'd818', 'd90100', 'daffffffff', 'db0000000000000001']) {
      assert.equal(bodyOf(`84a100${tags}`), undefined, `${tags} as a value`);
      assert.equal(bodyOf(`84a1${tags}`), undefined, `${tags} as a key`);
      assert.deepEqual(bodyOf(`84a10000${tags}`), { keys: [0], start: 1, end: 4 }, `${tags} after the body`);
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
        assert.equal(bodyOf(`84a100${cut}`), undefined, `major ${major}, ${size} bytes of argument, as a value`);
        assert.equal(bodyOf(`84a1${cut}`), undefined, `major ${major}, ${size} bytes of argument, as a key`);
        assert.equal(bodyOf(`84${cut}`), undefined, `major ${major}, ${size} bytes of argument, as the first item`);
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
    assert.equal(atOnce(() => readTransactionBody(new Uint8Array(0))), undefined);
  });

  test('every short sequence of bytes, as the value of key 0, as a key and in a body of indefinite length, gives a body or nothing, and the reader returns', () => {
    const alphabet = [
      0x00, 0x01, 0x02, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1f, 0x20, 0x3f, 0x40, 0x41, 0x58, 0x5f, 0x60, 0x61, 0x7f, 0x80, 0x81, 0x9f, 0xa0, 0xa1,
      0xbf, 0xc1, 0xd8, 0xdf, 0xf4, 0xf6, 0xf9, 0xfb, 0xfc, 0xff,
    ];
    const calls = atOnce(() => {
      let count = 0;
      const tail = [0x02, 0x05, 0xa0, 0xf5, 0xf6];
      const tryBytes = (...parts: number[][]): void => {
        const bytes = Uint8Array.from(parts.flat());
        const found = readTransactionBody(bytes);
        if (found !== undefined && !(found.start === 1 && found.end > found.start && found.end <= bytes.length && found.keys.every((key) => key >= 0))) {
          throw new Error(`the reader gave ${JSON.stringify(found)} for ${Buffer.from(bytes).toString('hex')}`);
        }
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

  test('gives the keys that CML reads and the bytes of the body that CML writes, for each kind of transaction that the builders build', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    const script = '49480100002221200101';
    const deploy = (initialDatum?: string) => ({ scriptCbor: script, scriptType: 'PlutusV2' as const, initialDatum });
    const interact = { scriptCbor: script, scriptType: 'PlutusV2' as const, changeAddress: OWN_ADDRESS };
    const scriptAddress = (await buildDeployContract(lucid, deploy('d87980'))).scriptAddress;
    const withScript = await lucidForAddress(new FixtureProvider([...FIXTURE_UTXOS, {
      txHash: FIXTURE_TXHASH, outputIndex: 7, address: scriptAddress, assets: { lovelace: 2_000_000n }, datum: 'd87980',
    }]), OWN_ADDRESS);
    const juryNode = juryWorld();
    const built: Array<[string, string]> = [
      ['a payment', (await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 })).txCbor],
      ['a payment with a note', (await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3, metadataJson: '{"674":{"msg":["a note"]}}' })).txCbor],
      ['a token payment', (await buildSendTokens(lucid, { recipientAddress: FOREIGN_ADDRESS, policyId: FIXTURE_TOKEN_UNIT.slice(0, 56), assetName: FIXTURE_TOKEN_UNIT.slice(56), amount: '10' })).txCbor],
      ['twelve outputs', (await buildMultiOutput(lucid, { outputs: Array.from({ length: 12 }, (_, i) => ({ address: FOREIGN_ADDRESS, lovelace: 2_000_000 + i })) })).txCbor],
      ['a deploy', (await buildDeployContract(lucid, deploy('d8799f0102ff'))).txCbor],
      ['a lock', (await buildInteractContract(withScript, { ...interact, action: 'lock', datum: 'd87980' })).txCbor],
      ['a spend', (await buildInteractContract(withScript, { ...interact, action: 'spend', redeemer: 'd87980' })).txCbor],
      ['a document', (await buildDocumentPublish(await lucidForAddress(juryNode, WALLET_ADDRESS), juryNode, {
        changeAddress: WALLET_ADDRESS, bytes: Buffer.from('{"type":"evidence","text":"ok"}', 'utf8'), type: 'evidence', nowMs: NOW,
      })).txCbor],
      ['a Delegate', (await delegateBuild()).txCbor],
      ['a Delegate that the wallet of the tests pays', (await delegateBuildMine()).txCbor],
    ];
    // Each key of a body that CML knows, and the part of the decoded body that is there when the key is.
    const parts: Array<[number, (body: CML.TransactionBody) => unknown]> = [
      [0, (body) => body.inputs()], [1, (body) => body.outputs()], [2, (body) => body.fee()], [3, (body) => body.ttl()], [4, (body) => body.certs()],
      [5, (body) => body.withdrawals()], [7, (body) => body.auxiliary_data_hash()], [8, (body) => body.validity_interval_start()], [9, (body) => body.mint()],
      [11, (body) => body.script_data_hash()], [13, (body) => body.collateral_inputs()], [14, (body) => body.required_signers()], [15, (body) => body.network_id()],
      [16, (body) => body.collateral_return()], [17, (body) => body.total_collateral()], [18, (body) => body.reference_inputs()],
      [19, (body) => body.voting_procedures()], [20, (body) => body.proposal_procedures()], [21, (body) => body.current_treasury_value()], [22, (body) => body.donation()],
    ];
    for (const [what, tx] of built) {
      const found = bodyOf(tx);
      assert.ok(found !== undefined, what);
      const body = CML.Transaction.from_cbor_hex(tx).body();
      assert.equal(tx.slice(found.start * 2, found.end * 2), body.to_cbor_hex(), `${what}: the bytes of the body`);
      const expected = parts.filter(([, part]) => part(body) !== undefined).map(([key]) => key);
      assert.deepEqual([...found.keys].sort((a, b) => a - b), expected, `${what}: the keys of the body`);
      assert.ok(found.keys.length >= 3, what);
    }
  });
});
