import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OgmiosProvider } from '../src/provider.ts';

// The critical this file exists to close: OgmiosProvider used to import
// `fetch` from `cross-fetch` (-> node-fetch@2.7.0), which embeds the
// request URL directly in its own thrown error messages - a leak that
// bypassed every sanitiser in provider-error-format.test.ts, since those
// only cover the `!response.ok` case, never a fetch()-level rejection or a
// response.json() parse failure. Now that provider.ts reads the global
// `fetch`, this file can stub it directly and pin the throw sites for the
// first time - see the docblock at the top of provider.ts for the full
// story, including the live-verified node-fetch source lines and the
// live-verified shape of native fetch's own errors (which do NOT embed the
// URL, but a JSON-parse failure still leaks a body snippet regardless of
// fetch implementation - also live-verified, reproduced in the fixtures
// below).

const OGMIOS_URL = 'https://ogmios-internal.example.cluster.local:1337';
const SUBMIT_URL = 'https://submit-internal.example.cluster.local:1338/api/submit/tx';
const KOIOS_URL = 'https://koios-internal.example.cluster.local:1339';
const HOSTNAME = 'ogmios-internal.example.cluster.local';

function testProvider(): OgmiosProvider {
  return new OgmiosProvider({ ogmiosUrl: OGMIOS_URL, submitUrl: SUBMIT_URL, koiosUrl: KOIOS_URL });
}

async function withStubbedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// Reproduces the exact shape observed live on this Node build:
// `fetch('http://<unreachable host>')` rejects with `TypeError: fetch
// failed`, the real DNS/connection reason attached as `.cause`, NOT folded
// into `.message`. (`Object.assign` instead of the two-arg Error
// constructor - packages/shared's tsconfig targets es2020, whose ambient
// `Error` type has no `cause`-accepting overload; provider.ts's own
// `describeError` reads `.cause` the same untyped way for the same reason.)
function networkErrorFetch(): typeof fetch {
  return (async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: new Error(`getaddrinfo ENOTFOUND ${HOSTNAME}`),
    });
  }) as unknown as typeof fetch;
}

// Reproduces the exact shape observed live: a 200 response whose body is
// HTML (a misconfigured reverse proxy's own error page), not JSON -
// response.json() throws a real SyntaxError quoting a snippet of the body.
function htmlBodyFetch(): typeof fetch {
  return (async () => new Response(
    `<html><body>502 Bad Gateway from ${HOSTNAME}</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } },
  )) as unknown as typeof fetch;
}

function okJsonFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('OgmiosProvider - fetch-level failures never leak the endpoint (audit E, critical)', () => {
  test('a network error (rejected fetch) on an Ogmios query yields no URL, no hostname, no raw DNS detail', async () => {
    await assert.rejects(
      () => withStubbedFetch(networkErrorFetch(), () => testProvider().getNetworkTip()),
      (err: Error) => {
        assert.ok(!err.message.includes('http://') && !err.message.includes('https://'), `leaked a URL scheme: ${err.message}`);
        assert.ok(!err.message.includes(HOSTNAME), `leaked the hostname: ${err.message}`);
        assert.ok(!err.message.includes('ENOTFOUND'), `leaked the raw DNS error: ${err.message}`);
        assert.equal(err.message, 'Ogmios request failed (queryNetwork/tip): network error');
        return true;
      },
    );
  });

  test('a malformed (HTML) response body on an Ogmios query yields no URL, no body snippet', async () => {
    await assert.rejects(
      () => withStubbedFetch(htmlBodyFetch(), () => testProvider().getNetworkTip()),
      (err: Error) => {
        assert.ok(!err.message.includes('<html>'), `leaked the raw body: ${err.message}`);
        assert.ok(!err.message.includes(HOSTNAME), `leaked the hostname: ${err.message}`);
        assert.equal(err.message, 'Ogmios request failed (queryNetwork/tip): invalid response');
        return true;
      },
    );
  });

  test('an Ogmios JSON-RPC structured error is still sanitised (unaffected by this round, re-pinned here)', async () => {
    await assert.rejects(
      () => withStubbedFetch(okJsonFetch({ error: { code: -32602, message: 'Invalid params' } }), () => testProvider().getNetworkTip()),
      (err: Error) => {
        assert.ok(!err.message.includes(HOSTNAME));
        assert.equal(err.message, 'Ogmios request failed (queryNetwork/tip): -32602 Invalid params');
        return true;
      },
    );
  });

  test('a network error on submitTx yields no URL, no hostname, and is NOT worded as a "rejection"', async () => {
    await assert.rejects(
      () => withStubbedFetch(networkErrorFetch(), () => testProvider().submitTx('ab'.repeat(32))),
      (err: Error) => {
        assert.ok(!err.message.includes('http://') && !err.message.includes('https://'));
        assert.ok(!err.message.includes('cluster.local'), `leaked the hostname: ${err.message}`);
        assert.equal(err.message, 'Submit API request failed (submitTx): network error');
        // A network failure never reached the ledger - calling it a
        // "rejection" would misleadingly imply a verdict was ever rendered.
        assert.ok(!err.message.toLowerCase().includes('rejected'), `network failure worded as a ledger rejection: ${err.message}`);
        return true;
      },
    );
  });

  test('a network error on a Koios query (getKoiosTxStatus) yields no URL, no hostname', async () => {
    await assert.rejects(
      () => withStubbedFetch(networkErrorFetch(), () => testProvider().getKoiosTxStatus('a'.repeat(64))),
      (err: Error) => {
        assert.ok(!err.message.includes('cluster.local'));
        assert.equal(err.message, 'Koios request failed (tx_status): network error');
        return true;
      },
    );
  });

  test('a malformed response body on getKoiosTxStatus yields no URL, no body snippet', async () => {
    await assert.rejects(
      () => withStubbedFetch(htmlBodyFetch(), () => testProvider().getKoiosTxStatus('a'.repeat(64))),
      (err: Error) => {
        assert.ok(!err.message.includes('<html>'));
        assert.equal(err.message, 'Koios request failed (tx_status): invalid response');
        return true;
      },
    );
  });

  test('a network error on getTransactionHistory (address_txs, the load-bearing call) yields no URL, no hostname', async () => {
    await assert.rejects(
      () => withStubbedFetch(networkErrorFetch(), () => testProvider().getTransactionHistory('addr1qtest')),
      (err: Error) => {
        assert.ok(!err.message.includes('cluster.local'));
        assert.equal(err.message, 'Koios request failed (address_txs): network error');
        return true;
      },
    );
  });

  test('a Koios failure on a swallow-to-fallback method (getDelegation) degrades quietly, no throw, no leak possible', async () => {
    const result = await withStubbedFetch(networkErrorFetch(), () => testProvider().getDelegation('stake1uxxxxxxx'));
    assert.deepEqual(result, { poolId: null, rewards: 0n });
  });

  test('a Koios failure on a swallow-to-fallback method (getUtxoByUnit) still reaches the generic not-found message, no leak', async () => {
    await assert.rejects(
      () => withStubbedFetch(networkErrorFetch(), () => testProvider().getUtxoByUnit('a'.repeat(56) + 'deadbeef')),
      (err: Error) => {
        assert.ok(!err.message.includes(HOSTNAME));
        assert.match(err.message, /not found/i);
        return true;
      },
    );
  });

  test('the happy path is unaffected: a normal successful response still resolves correctly', async () => {
    const tip = await withStubbedFetch(
      okJsonFetch({ result: { slot: 12345, id: 'a'.repeat(64) } }),
      () => testProvider().getNetworkTip(),
    );
    assert.equal(tip.slot, 12345);
    assert.equal(tip.hash, 'a'.repeat(64));
  });

  test('the happy path for submitTx is unaffected: a normal successful response still resolves correctly', async () => {
    const hash = 'a'.repeat(64);
    const txHash = await withStubbedFetch(
      (async () => new Response(hash, { status: 200 })) as unknown as typeof fetch,
      () => testProvider().submitTx('ab'.repeat(32)),
    );
    assert.equal(txHash, hash);
  });
});
