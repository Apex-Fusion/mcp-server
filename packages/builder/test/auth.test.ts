import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAuthConfig, resolveIdentity } from '../src/auth.ts';

describe('loadAuthConfig', () => {
  test('is disabled when MCP_AUTH_TOKENS is unset', () => {
    assert.equal(loadAuthConfig({}).enabled, false);
  });

  test('is disabled when MCP_AUTH_TOKENS is empty or whitespace', () => {
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '' }).enabled, false);
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '   ' }).enabled, false);
  });

  test('parses a bare token', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: 'secret-one' });
    assert.equal(c.enabled, true);
    assert.equal(c.identities.size, 1);
    assert.ok(c.identities.has('secret-one'));
  });

  test('parses label:token pairs', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok-a,bob:tok-b' });
    assert.equal(c.identities.get('tok-a'), 'alice');
    assert.equal(c.identities.get('tok-b'), 'bob');
  });

  test('tolerates whitespace around entries', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: ' alice:tok-a , bob:tok-b ' });
    assert.equal(c.identities.get('tok-a'), 'alice');
    assert.equal(c.identities.get('tok-b'), 'bob');
  });

  test('a bare token gets a stable label that is not the token itself', () => {
    const label = loadAuthConfig({ MCP_AUTH_TOKENS: 'secret-one' }).identities.get('secret-one')!;
    assert.ok(!label.includes('secret-one'), 'the label must not embed the token');
    assert.equal(label, loadAuthConfig({ MCP_AUTH_TOKENS: 'secret-one' }).identities.get('secret-one'));
  });

  test('rejects a duplicate token rather than silently overwriting', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok,bob:tok' }), /duplicate/i);
  });

  test('rejects an entry with an empty token', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:' }), /empty token/i);
  });
});

describe('resolveIdentity — auth disabled', () => {
  const off = loadAuthConfig({});

  test('allows a request with no header', () => {
    assert.deepStrictEqual(resolveIdentity(undefined, off), { ok: true, identity: 'anonymous' });
  });

  test('allows a request with a bogus header', () => {
    assert.deepStrictEqual(resolveIdentity('Bearer whatever', off), { ok: true, identity: 'anonymous' });
  });
});

describe('resolveIdentity — auth enabled', () => {
  const on = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok-a,bob:tok-b' });

  test('accepts a valid bearer token and returns its label', () => {
    assert.deepStrictEqual(resolveIdentity('Bearer tok-a', on), { ok: true, identity: 'alice' });
  });

  test('is case-insensitive on the Bearer scheme', () => {
    assert.deepStrictEqual(resolveIdentity('bearer tok-a', on), { ok: true, identity: 'alice' });
  });

  test('rejects a missing header', () => {
    const r = resolveIdentity(undefined, on);
    assert.equal(r.ok, false);
  });

  test('rejects an unknown token', () => {
    assert.equal(resolveIdentity('Bearer nope', on).ok, false);
  });

  test('rejects a valid token without the Bearer scheme', () => {
    assert.equal(resolveIdentity('tok-a', on).ok, false);
  });

  test('rejects a token with trailing whitespace padding', () => {
    // Exact match only. Tolerating padding here would mean two distinct
    // strings resolve to one identity, which muddies rate-limit accounting.
    assert.equal(resolveIdentity('Bearer  tok-a ', on).ok, false);
  });

  test('a rejection reason never contains the supplied token', () => {
    const r = resolveIdentity('Bearer super-secret-value', on);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('super-secret-value'), 'must not echo the token');
  });
});

// --- Adversarial pass, beyond the brief's 17-test floor ---------------------

describe('loadAuthConfig — adversarial: delimiter and charset edge cases', () => {
  test('a colon inside the token value only splits on the first colon', () => {
    // "label:token" splits on the FIRST colon only; everything after belongs
    // to the token. A label can therefore never itself contain a colon.
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok:with:colons' });
    assert.equal(c.identities.size, 1);
    assert.equal(c.identities.get('tok:with:colons'), 'alice');
    assert.deepStrictEqual(resolveIdentity('Bearer tok:with:colons', c), { ok: true, identity: 'alice' });
  });

  test('handles a very long token', () => {
    const token = 'a'.repeat(5000);
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: `bob:${token}` });
    assert.equal(c.identities.get(token), 'bob');
    assert.deepStrictEqual(resolveIdentity(`Bearer ${token}`, c), { ok: true, identity: 'bob' });
  });

  test('accepts non-whitespace unicode characters in a token', () => {
    const token = 'tok-é中文-😀'; // "tok-é中文-😀"
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: `bob:${token}` });
    assert.deepStrictEqual(resolveIdentity(`Bearer ${token}`, c), { ok: true, identity: 'bob' });
  });

  test('a zero-width space (U+200B) in a token is not a bug: preserved by trim, ' +
    'excluded from neither \\s nor \\S, so config and header matching stay consistent', () => {
    const token = 'tok-a​';
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: `bob:${token}` });
    assert.deepStrictEqual(resolveIdentity(`Bearer ${token}`, c), { ok: true, identity: 'bob' });
    // The visually-identical token WITHOUT the invisible character must NOT match.
    assert.equal(resolveIdentity('Bearer tok-a', c).ok, false);
  });

  test('rejects a token containing an embedded ASCII space', () => {
    // Such a token could never be presented via "Authorization: Bearer <token>" -
    // resolveIdentity's \S+ capture cannot span a space - so it would be configured
    // yet permanently unusable. Fail loudly at load time instead of creating a dead entry.
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok with space' }), /whitespace/i);
  });

  test('rejects a token containing an embedded tab', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok\twith\ttabs' }), /whitespace/i);
  });

  test('rejects a token containing an embedded non-breaking space', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok nbsp' }), /whitespace/i);
  });

  test('a comma inside an intended token silently fragments into extra, unintended entries ' +
    '(documented delimiter limitation: comma has no escape mechanism)', () => {
    // Operator intent: ONE identity "alice" with token "correct,horse,battery,staple".
    // Actual result: FOUR entries. The three trailing fragments become independently
    // valid bearer tokens under auto-generated identities. This is why token generators
    // must avoid commas - hex/base64url/alphanumeric charsets are all safe.
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:correct,horse,battery,staple' });
    assert.equal(c.identities.size, 4);
    assert.equal(c.identities.get('correct'), 'alice');
    assert.ok(resolveIdentity('Bearer horse', c).ok, 'fragment "horse" became an unintended standalone valid token');
    assert.ok(resolveIdentity('Bearer battery', c).ok, 'fragment "battery" became an unintended standalone valid token');
    assert.ok(resolveIdentity('Bearer staple', c).ok, 'fragment "staple" became an unintended standalone valid token');
  });
});

describe('loadAuthConfig — adversarial: malformed config must not silently disable auth', () => {
  test('MCP_AUTH_TOKENS of only commas throws rather than silently disabling auth', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: ',,,' }), /no usable/i);
  });

  test('MCP_AUTH_TOKENS of only whitespace and commas throws rather than silently disabling auth', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: ' , , ' }), /no usable/i);
  });

  test('a genuinely empty MCP_AUTH_TOKENS still disables cleanly (contrast with the above)', () => {
    // Pins the boundary: raw === '' short-circuits before the "no usable tokens"
    // check even exists, so this must keep behaving like the floor tests require.
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '' }).enabled, false);
  });
});

describe('loadAuthConfig — adversarial: identity mapping', () => {
  test('two entries with the same label but different tokens are both valid ' +
    '(rotation / multiple devices under one identity is a legitimate pattern)', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok-old,alice:tok-new' });
    assert.equal(c.identities.get('tok-old'), 'alice');
    assert.equal(c.identities.get('tok-new'), 'alice');
    assert.deepStrictEqual(resolveIdentity('Bearer tok-old', c), { ok: true, identity: 'alice' });
    assert.deepStrictEqual(resolveIdentity('Bearer tok-new', c), { ok: true, identity: 'alice' });
  });

  test('a label of only whitespace falls back to a hash-derived label, like a bare token', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: '   :tok-a' });
    const label = c.identities.get('tok-a')!;
    assert.ok(label.startsWith('client-'));
  });

  test('__proto__ and constructor as label/token values are inert (backed by a Map, not a plain object)', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: '__proto__:constructor' });
    assert.equal(c.identities.get('constructor'), '__proto__');
    assert.deepStrictEqual(resolveIdentity('Bearer constructor', c), { ok: true, identity: '__proto__' });
    assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
  });
});

describe('resolveIdentity — adversarial', () => {
  const on = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok-a,bob:tok-b' });

  test('token comparison is case-sensitive (exact match only)', () => {
    assert.equal(resolveIdentity('Bearer TOK-A', on).ok, false);
    assert.equal(resolveIdentity('Bearer Tok-A', on).ok, false);
  });

  test('a strict prefix of a valid token is rejected', () => {
    assert.equal(resolveIdentity('Bearer tok', on).ok, false);
  });

  test('a superstring of a valid token is rejected (no partial/prefix matching)', () => {
    assert.equal(resolveIdentity('Bearer tok-a-extra', on).ok, false);
  });

  test('an empty string Authorization header is treated exactly the same as a missing one', () => {
    assert.deepStrictEqual(resolveIdentity('', on), resolveIdentity(undefined, on));
  });

  test('"Bearer" with no token at all is rejected as malformed', () => {
    assert.equal(resolveIdentity('Bearer', on).ok, false);
    assert.equal(resolveIdentity('Bearer ', on).ok, false);
  });

  test('a malformed-header rejection reason never contains the header value', () => {
    const weird = 'not-even-bearer-scheme-' + 'x'.repeat(50);
    const r = resolveIdentity(weird, on);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(weird));
  });
});
