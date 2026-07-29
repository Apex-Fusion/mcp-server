import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubmitResponse } from '../src/provider.ts';

const CBOR = 'ab'.repeat(200); // 400 hex chars — its first 64 look exactly like a hash
const HASH = 'a'.repeat(64);

describe('parseSubmitResponse', () => {
  test('accepts a JSON-quoted hash', () => {
    assert.equal(parseSubmitResponse(`"${HASH}"`), HASH);
  });

  test('accepts a bare-text hash', () => {
    assert.equal(parseSubmitResponse(HASH), HASH);
  });

  test('tolerates surrounding whitespace', () => {
    assert.equal(parseSubmitResponse(`  ${HASH}\n`), HASH);
  });

  test('accepts a hash carried on a JSON object field', () => {
    assert.equal(parseSubmitResponse(JSON.stringify({ txId: HASH })), HASH);
    assert.equal(parseSubmitResponse(JSON.stringify({ txHash: HASH })), HASH);
  });

  test('accepts a hash carried on the "id" field too', () => {
    // The brief's fixture exercises txId and txHash; the implementation also
    // recognizes `id` as a fallback field. Pin that third branch explicitly
    // instead of leaving it covered only incidentally.
    assert.equal(parseSubmitResponse(JSON.stringify({ id: HASH })), HASH);
  });

  test('accepts uppercase hex', () => {
    const upper = 'A'.repeat(64);
    assert.equal(parseSubmitResponse(upper), upper);
  });

  // The bug: the old code returned the first 64 chars of the SUBMITTED CBOR
  // here, which is a well-formed 64-char hex string and therefore
  // indistinguishable from a real hash to any caller.
  test('throws on an unparseable response instead of fabricating a hash', () => {
    assert.throws(() => parseSubmitResponse('not a hash at all'), /could not be parsed/i);
  });

  test('throws on an empty response', () => {
    assert.throws(() => parseSubmitResponse(''), /could not be parsed/i);
  });

  test('rejects a hex string of the wrong length', () => {
    assert.throws(() => parseSubmitResponse('abc123'), /could not be parsed/i);
    assert.throws(() => parseSubmitResponse('a'.repeat(63)), /could not be parsed/i);
    assert.throws(() => parseSubmitResponse('a'.repeat(65)), /could not be parsed/i);
  });

  test('rejects a 64-character string that is not hex', () => {
    assert.throws(() => parseSubmitResponse('z'.repeat(64)), /could not be parsed/i);
  });

  test('the error never echoes the response body', () => {
    try {
      parseSubmitResponse('some-unexpected-body-value');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(!(err as Error).message.includes('some-unexpected-body-value'));
    }
  });

  // NOTE on this test: the brief's literal assertion here was
  // `assert.throws(...)`. It was changed to `assert.equal(...)` - see the
  // "judgement call" section of the task report for the full reasoning.
  // Short version: parseSubmitResponse only ever receives the HTTP response
  // body, never the tx that was submitted, so this value can no longer be
  // *invented* by our code from the request. `'ab'.repeat(32)` is also a
  // genuinely well-formed 64-character hex string, so if a server's response
  // literally equals it, accepting it is correct - the same as accepting any
  // other bare-text hash. That is a materially different bug shape than the
  // original: our own code deriving a fake answer from data it already held,
  // with no server involved at all.
  test('the submitted CBOR is not an input, so it cannot leak into the result', () => {
    // Regression guard on the shape of the old bug: this function only ever
    // sees the response, never the transaction that was sent.
    assert.equal(parseSubmitResponse(CBOR.slice(0, 64)), CBOR.slice(0, 64));
  });

  // Beyond the brief: valid JSON, but not a shape the parser recognizes.
  describe('valid JSON the parser does not recognize as a hash', () => {
    test('a bare JSON array throws rather than guessing', () => {
      assert.throws(() => parseSubmitResponse(JSON.stringify([HASH])), /could not be parsed/i);
    });

    test('a bare JSON number throws rather than guessing', () => {
      assert.throws(() => parseSubmitResponse('42'), /could not be parsed/i);
    });

    test('a bare JSON null throws rather than guessing', () => {
      assert.throws(() => parseSubmitResponse('null'), /could not be parsed/i);
    });

    test('a bare JSON boolean throws rather than guessing', () => {
      assert.throws(() => parseSubmitResponse('true'), /could not be parsed/i);
    });

    test('a hash nested one level too deep is not found', () => {
      // Only top-level txId/txHash/id are checked. A wrapper shape like
      // { result: { txId } } is deliberately not unwrapped - guessing at
      // nesting is exactly the kind of leniency that produced the original
      // bug.
      assert.throws(
        () => parseSubmitResponse(JSON.stringify({ result: { txId: HASH } })),
        /could not be parsed/i,
      );
    });

    test('a hash on a field name the parser does not recognize throws', () => {
      // Confirms the field allowlist is exact: `hash` is a plausible name a
      // future server might use, but until the parser is explicitly taught
      // about it, it must refuse rather than pattern-match any hex-looking
      // value anywhere in the object.
      assert.throws(
        () => parseSubmitResponse(JSON.stringify({ hash: HASH })),
        /could not be parsed/i,
      );
    });
  });
});
