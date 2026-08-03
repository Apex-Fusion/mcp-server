import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatServiceError, scrubUrls, formatSubmitRejection } from '../src/provider.ts';
import { VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL, VECTOR_SUBMIT_URL } from '../src/config.ts';

// The concern (audit E): a hosted deployment's internal Ogmios/Koios/submit-api
// endpoint reaching an untrusted caller through error text.
//
// Two distinct cases, two distinct answers:
//
// - An Ogmios/Koios QUERY failure is OUR infrastructure's problem, never the
//   caller's - the caller cannot act on it, so it is sanitised down to
//   service name + status only (formatServiceError). Never the URL, never
//   the response body.
// - A submit-api REJECTION is the ledger's verdict on the CALLER'S OWN
//   transaction (ValueNotConservedUTxO, BadInputsUTxO, a missing witness,
//   fee too small) - that reason is caller information, the feedback loop an
//   agent needs to self-correct after build -> sign -> submit. It survives,
//   scrubbed of URL-shaped content only (formatSubmitRejection + scrubUrls),
//   since the body is still attacker-adjacent even though its content is
//   otherwise legitimate to return.

describe('formatServiceError', () => {
  test('names the service, operation, and HTTP status', () => {
    assert.equal(
      formatServiceError('Ogmios', 'queryLedgerState/utxo', 503, 'Service Unavailable'),
      'Ogmios request failed (queryLedgerState/utxo): 503 Service Unavailable',
    );
  });

  test('covers Koios with the same shape', () => {
    assert.equal(
      formatServiceError('Koios', 'tx_status', 502, 'Bad Gateway'),
      'Koios request failed (tx_status): 502 Bad Gateway',
    );
  });

  test('omits the status text when the caller has none (a JSON-RPC error code, not an HTTP status)', () => {
    assert.equal(
      formatServiceError('Ogmios', 'queryLedgerState/utxo', -32602),
      'Ogmios request failed (queryLedgerState/utxo): -32602',
    );
  });

  test('never contains any configured endpoint URL', () => {
    // Structural, not incidental: the function has no parameter for a URL or
    // a response body, so it cannot forward either - but pin it against the
    // actual values in config.ts (the ones a hosted deployment sets to its
    // own internal endpoints) so a future signature change that threads one
    // through fails this test by name.
    const messages = [
      formatServiceError('Ogmios', 'queryLedgerState/utxo', 503, 'Service Unavailable'),
      formatServiceError('Koios', 'address_txs', 500, 'Internal Server Error'),
    ];
    for (const url of [VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL, VECTOR_SUBMIT_URL]) {
      for (const msg of messages) {
        assert.ok(!msg.includes(url), `message leaked a configured endpoint URL: ${msg}`);
      }
    }
  });

  test('never contains a raw response body, only what the caller passes as status/statusText', () => {
    // Simulates the shape of a real leak: an upstream failure whose body
    // echoes infrastructure detail no caller should see. formatServiceError
    // is never given the body, so it cannot reproduce it - this pins that a
    // future edit cannot casually splice ${text} back into the template.
    // (This is deliberately NOT true of formatSubmitRejection below - a
    // submit-api body is caller information, scrubbed rather than dropped.)
    const leakyBody = 'upstream connect error: could not connect to ogmios-internal.vector.svc.cluster.local:1337';
    const msg = formatServiceError('Ogmios', 'queryLedgerState/utxo', 502, 'Bad Gateway');
    assert.ok(!msg.includes(leakyBody));
    assert.ok(!msg.includes('cluster.local'));
  });
});

describe('scrubUrls', () => {
  test('replaces a full http(s) URL with [endpoint]', () => {
    const text = 'upstream connect error: could not connect to https://ogmios.internal.example.com:1337/health';
    const scrubbed = scrubUrls(text);
    assert.ok(!scrubbed.includes('https://'));
    assert.ok(!scrubbed.includes('ogmios.internal.example.com'));
    assert.ok(scrubbed.includes('[endpoint]'));
  });

  test('replaces a bare configured host with no scheme, given knownHosts', () => {
    // The shape a raw reverse-proxy error page most often actually uses -
    // no "https://" prefix at all, just the bare hostname (optionally with a
    // port), which the generic URL pattern alone would miss.
    const text = 'upstream connect error: could not connect to ogmios.vector.mainnet.apexfusion.org:1337';
    const scrubbed = scrubUrls(text, ['https://ogmios.vector.mainnet.apexfusion.org']);
    assert.ok(!scrubbed.includes('ogmios.vector.mainnet.apexfusion.org'), `host survived scrubbing: ${scrubbed}`);
    assert.ok(scrubbed.includes('[endpoint]'));
  });

  test('accepts a bare hostname (no scheme) in knownHosts too', () => {
    const text = 'DNS lookup failed for koios.vector.testnet.apexfusion.org';
    const scrubbed = scrubUrls(text, ['koios.vector.testnet.apexfusion.org']);
    assert.ok(!scrubbed.includes('koios.vector.testnet.apexfusion.org'));
  });

  test('leaves ordinary text with no URL-shaped content untouched', () => {
    assert.equal(scrubUrls('ValueNotConservedUTxO: inputs 5000000, outputs 5100000'), 'ValueNotConservedUTxO: inputs 5000000, outputs 5100000');
  });

  test('caps the result length so a large upstream page cannot flood a response', () => {
    const huge = 'x'.repeat(5000);
    const scrubbed = scrubUrls(huge);
    assert.ok(scrubbed.length < 5000, `expected truncation, got length ${scrubbed.length}`);
    assert.ok(scrubbed.endsWith('[truncated]'));
  });
});

describe('formatSubmitRejection', () => {
  test('message shape names the rejection, the status, and keeps the body', () => {
    assert.equal(
      formatSubmitRejection(400, 'Bad Request', 'BadInputsUTxO'),
      'Transaction submission rejected (400 Bad Request): BadInputsUTxO',
    );
  });

  test('keeps a representative ledger reason - the exact feedback loop a caller needs to self-correct', () => {
    const body = '{"code":"ValueNotConservedUTxO","message":"inputs 5000000 lovelace, outputs 5100000 lovelace"}';
    const msg = formatSubmitRejection(400, 'Bad Request', body);
    assert.ok(msg.includes('ValueNotConservedUTxO'), 'ledger rejection reason must survive for the caller to self-correct');
    assert.ok(msg.includes('5100000'));
  });

  test('removes a URL embedded in that same body while keeping the ledger reason next to it', () => {
    const body = 'ValueNotConservedUTxO at https://ogmios.vector.mainnet.apexfusion.org/internal-detail: inputs 5000000, outputs 5100000';
    const msg = formatSubmitRejection(400, 'Bad Request', body);
    assert.ok(msg.includes('ValueNotConservedUTxO'), 'ledger reason must survive');
    assert.ok(msg.includes('5100000'), 'ledger reason detail must survive');
    assert.ok(!msg.includes('https://'), 'URL scheme must not survive');
    assert.ok(!msg.includes('ogmios.vector.mainnet.apexfusion.org'), 'endpoint host must not survive');
  });

  test('scrubs every configured endpoint passed as knownHosts, not just the submit one', () => {
    const body = `mirrored via ${VECTOR_OGMIOS_URL} and ${VECTOR_KOIOS_URL} - BadInputsUTxO`;
    const msg = formatSubmitRejection(400, 'Bad Request', body, [VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL]);
    assert.ok(msg.includes('BadInputsUTxO'));
    assert.ok(!msg.includes(VECTOR_OGMIOS_URL));
    assert.ok(!msg.includes(VECTOR_KOIOS_URL));
  });
});
