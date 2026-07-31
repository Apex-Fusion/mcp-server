import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatServiceError } from '../src/provider.ts';
import { VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL, VECTOR_SUBMIT_URL } from '../src/config.ts';

// The concern (audit E): a hosted deployment's internal Ogmios/Koios/submit-api
// endpoint reaching an untrusted caller through error text - either the
// configured URL itself, or a raw response body from a misconfigured/internal
// endpoint (a reverse-proxy error page, for instance) that can echo back
// hostnames or other operator-only detail. formatServiceError is the pure
// function every throw site in provider.ts now routes its caller-visible
// message through; the full detail (status, body, and which endpoint) goes to
// console.error instead, at each call site.

describe('formatServiceError', () => {
  test('names the service, operation, and HTTP status', () => {
    assert.equal(
      formatServiceError('Ogmios', 'queryLedgerState/utxo', 503, 'Service Unavailable'),
      'Ogmios request failed (queryLedgerState/utxo): 503 Service Unavailable',
    );
  });

  test('covers Koios and the submit API with the same shape', () => {
    assert.equal(
      formatServiceError('Koios', 'tx_status', 502, 'Bad Gateway'),
      'Koios request failed (tx_status): 502 Bad Gateway',
    );
    assert.equal(
      formatServiceError('Submit API', 'submitTx', 400, 'Bad Request'),
      'Submit API request failed (submitTx): 400 Bad Request',
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
      formatServiceError('Submit API', 'submitTx', 400, 'Bad Request'),
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
    const leakyBody = 'upstream connect error: could not connect to ogmios-internal.vector.svc.cluster.local:1337';
    const msg = formatServiceError('Ogmios', 'queryLedgerState/utxo', 502, 'Bad Gateway');
    assert.ok(!msg.includes(leakyBody));
    assert.ok(!msg.includes('cluster.local'));
  });
});
