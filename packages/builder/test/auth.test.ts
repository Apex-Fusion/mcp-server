import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAuthConfig, resolveIdentity, clientIpOf } from '../src/auth.ts';

describe('loadAuthConfig', () => {
  test('is disabled when MCP_AUTH_TOKENS is unset', () => {
    assert.equal(loadAuthConfig({}).enabled, false);
  });

  test('is disabled when MCP_AUTH_TOKENS is empty or whitespace', () => {
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '' }).enabled, false);
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '   ' }).enabled, false);
  });

  // "Whitespace" above was only ever exercised with an ASCII space. .trim() strips a much
  // wider Unicode set (the WhiteSpace + LineTerminator productions), so pin that the same
  // disabled path is reached for representative non-ASCII members of that set too - NBSP,
  // BOM and the line separator all collapse to '' under trim exactly like an ASCII space.
  test('is disabled when MCP_AUTH_TOKENS is a non-ASCII whitespace character', () => {
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '\u00A0' }).enabled, false); // NBSP
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '\uFEFF' }).enabled, false); // BOM
    assert.equal(loadAuthConfig({ MCP_AUTH_TOKENS: '\u2028' }).enabled, false); // line separator
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
    assert.deepStrictEqual(resolveIdentity(undefined, off, '203.0.113.50'), { ok: true, identity: 'anon:203.0.113.50' });
  });

  test('allows a request with a bogus header', () => {
    assert.deepStrictEqual(resolveIdentity('Bearer whatever', off, '203.0.113.50'), { ok: true, identity: 'anon:203.0.113.50' });
  });
});

describe('resolveIdentity — auth enabled', () => {
  const on = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok-a,bob:tok-b' });

  test('accepts a valid bearer token and returns its label', () => {
    assert.deepStrictEqual(resolveIdentity('Bearer tok-a', on, '203.0.113.50'), { ok: true, identity: 'alice' });
  });

  test('is case-insensitive on the Bearer scheme', () => {
    assert.deepStrictEqual(resolveIdentity('bearer tok-a', on, '203.0.113.50'), { ok: true, identity: 'alice' });
  });

  test('rejects a missing header', () => {
    const r = resolveIdentity(undefined, on, '203.0.113.50');
    assert.equal(r.ok, false);
  });

  test('rejects an unknown token', () => {
    assert.equal(resolveIdentity('Bearer nope', on, '203.0.113.50').ok, false);
  });

  test('rejects a valid token without the Bearer scheme', () => {
    assert.equal(resolveIdentity('tok-a', on, '203.0.113.50').ok, false);
  });

  test('rejects a token with trailing whitespace padding', () => {
    // Exact match only. Tolerating padding here would mean two distinct
    // strings resolve to one identity, which muddies rate-limit accounting.
    assert.equal(resolveIdentity('Bearer  tok-a ', on, '203.0.113.50').ok, false);
  });

  test('a rejection reason never contains the supplied token', () => {
    const r = resolveIdentity('Bearer super-secret-value', on, '203.0.113.50');
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
    assert.deepStrictEqual(resolveIdentity('Bearer tok:with:colons', c, '203.0.113.50'), { ok: true, identity: 'alice' });
  });

  test('handles a very long token', () => {
    const token = 'a'.repeat(5000);
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: `bob:${token}` });
    assert.equal(c.identities.get(token), 'bob');
    assert.deepStrictEqual(resolveIdentity(`Bearer ${token}`, c, '203.0.113.50'), { ok: true, identity: 'bob' });
  });

  test('accepts non-whitespace unicode characters in a token', () => {
    const token = 'tok-é中文-😀'; // "tok-é中文-😀"
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: `bob:${token}` });
    assert.deepStrictEqual(resolveIdentity(`Bearer ${token}`, c, '203.0.113.50'), { ok: true, identity: 'bob' });
  });

  test('a zero-width space (U+200B) in a token is not a bug: preserved by trim, ' +
    'excluded from neither \\s nor \\S, so config and header matching stay consistent', () => {
    const token = 'tok-a\u200B'; // trailing zero-width space (U+200B)
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: `bob:${token}` });
    assert.deepStrictEqual(resolveIdentity(`Bearer ${token}`, c, '203.0.113.50'), { ok: true, identity: 'bob' });
    // The visually-identical token WITHOUT the invisible character must NOT match.
    assert.equal(resolveIdentity('Bearer tok-a', c, '203.0.113.50').ok, false);
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
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok\u00A0nbsp' }), /whitespace/i);
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
    assert.ok(resolveIdentity('Bearer horse', c, '203.0.113.50').ok, 'fragment "horse" became an unintended standalone valid token');
    assert.ok(resolveIdentity('Bearer battery', c, '203.0.113.50').ok, 'fragment "battery" became an unintended standalone valid token');
    assert.ok(resolveIdentity('Bearer staple', c, '203.0.113.50').ok, 'fragment "staple" became an unintended standalone valid token');
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
    assert.deepStrictEqual(resolveIdentity('Bearer tok-old', c, '203.0.113.50'), { ok: true, identity: 'alice' });
    assert.deepStrictEqual(resolveIdentity('Bearer tok-new', c, '203.0.113.50'), { ok: true, identity: 'alice' });
  });

  test('a label of only whitespace falls back to a hash-derived label, like a bare token', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: '   :tok-a' });
    const label = c.identities.get('tok-a')!;
    assert.ok(label.startsWith('client-'));
  });

  test('__proto__ and constructor as label/token values are inert (backed by a Map, not a plain object)', () => {
    const c = loadAuthConfig({ MCP_AUTH_TOKENS: '__proto__:constructor' });
    assert.equal(c.identities.get('constructor'), '__proto__');
    assert.deepStrictEqual(resolveIdentity('Bearer constructor', c, '203.0.113.50'), { ok: true, identity: '__proto__' });
    assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
  });
});

describe('loadAuthConfig — adversarial: config-error messages never leak the value that triggered them', () => {
  // Every throw site in loadAuthConfig is a candidate for exactly the leak the file's own
  // header forbids ("A token is a secret. It must never appear in ... an error message").
  // Each test below places a distinctive sentinel where it would be in scope for that
  // specific throw site, confirms the right error fires (so the test can't pass by hitting
  // some unrelated throw), and confirms the sentinel is absent from the message. See
  // pr5-task-1-report.md for a manual mutation re-run proving each test catches its site.
  const SENTINEL = 'SENTINEL-must-never-appear-in-any-message';

  test('the empty-token error never echoes the label that triggered it', () => {
    // Trailing colon, no token: the sentinel lands in `label`, not `token` (token is ''
    // by definition of this failure) - `label` is the variable a careless "interpolate
    // whatever the operator typed" edit would most plausibly reach for here.
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: `${SENTINEL}:` }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /empty token/i);
      assert.ok(!err.message.includes(SENTINEL), 'must not echo the sentinel label');
      return true;
    });
  });

  test('the embedded-whitespace error never echoes the token that triggered it', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: `alice:${SENTINEL} has a space` }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /whitespace/i);
      assert.ok(!err.message.includes(SENTINEL), 'must not echo the sentinel token');
      return true;
    });
  });

  test('the duplicate-token error never echoes the token that triggered it', () => {
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: `alice:${SENTINEL},bob:${SENTINEL}` }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /duplicate/i);
      assert.ok(!err.message.includes(SENTINEL), 'must not echo the sentinel token');
      return true;
    });
  });

  test('the no-usable-tokens error never echoes the raw value that triggered it', () => {
    // Unlike the three tests above, this throw fires only when EVERY comma-delimited
    // segment trims to '' - which structurally means `raw` can never hold alphanumeric
    // content at this point (any non-blank segment either succeeds, making this throw
    // unreachable, or fails an earlier check first - see the report for the full proof).
    // There is no way to smuggle a realistic secret in here, so the "sentinel" is a
    // distinctive whitespace/comma pattern instead - still enough to prove the message
    // never echoes `raw`, which is the invariant a careless `${raw}` interpolation would
    // violate. Commas sit at both ends deliberately: loadAuthConfig's own top-level
    // .trim() would otherwise strip a leading/trailing whitespace char, making the `raw`
    // actually in scope at the throw site differ from this literal. All characters are
    // written as \u escapes rather than literal bytes, deliberately - to keep this file's
    // source free of invisible/exotic characters that are easy to mis-transcribe.
    const distinctiveBlank = ',\t,\u00A0,\uFEFF,'; // comma, tab, comma, NBSP, comma, BOM, comma
    assert.throws(() => loadAuthConfig({ MCP_AUTH_TOKENS: distinctiveBlank }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /no usable/i);
      assert.ok(!err.message.includes(distinctiveBlank), 'must not echo the raw env value verbatim');
      // Belt-and-braces beyond the verbatim check above: a well-meaning but still-unsafe
      // interpolation might run `raw` through JSON.stringify first (e.g. to make control
      // characters readable in a log). That escapes the tab to the two-char sequence \t,
      // which breaks the verbatim substring check above - but JSON.stringify leaves NBSP
      // and BOM as literal, unescaped bytes, so checking for either of those individually
      // still catches it. Confirmed empirically before relying on it: JSON.stringify of
      // this exact distinctiveBlank value contains NBSP and BOM unescaped, tab escaped.
      assert.ok(!err.message.includes('\u00A0'), 'must not echo the raw env value\'s NBSP, even JSON-escaped');
      assert.ok(!err.message.includes('\uFEFF'), 'must not echo the raw env value\'s BOM, even JSON-escaped');
      return true;
    });
  });
});

describe('resolveIdentity — adversarial', () => {
  const on = loadAuthConfig({ MCP_AUTH_TOKENS: 'alice:tok-a,bob:tok-b' });

  test('token comparison is case-sensitive (exact match only)', () => {
    assert.equal(resolveIdentity('Bearer TOK-A', on, '203.0.113.50').ok, false);
    assert.equal(resolveIdentity('Bearer Tok-A', on, '203.0.113.50').ok, false);
  });

  test('a strict prefix of a valid token is rejected', () => {
    assert.equal(resolveIdentity('Bearer tok', on, '203.0.113.50').ok, false);
  });

  test('a superstring of a valid token is rejected (no partial/prefix matching)', () => {
    assert.equal(resolveIdentity('Bearer tok-a-extra', on, '203.0.113.50').ok, false);
  });

  test('an empty string Authorization header is treated exactly the same as a missing one', () => {
    assert.deepStrictEqual(resolveIdentity('', on, '203.0.113.50'), resolveIdentity(undefined, on, '203.0.113.50'));
  });

  test('"Bearer" with no token at all is rejected as malformed', () => {
    assert.equal(resolveIdentity('Bearer', on, '203.0.113.50').ok, false);
    assert.equal(resolveIdentity('Bearer ', on, '203.0.113.50').ok, false);
  });

  test('a malformed-header rejection reason never contains the header value', () => {
    const weird = 'not-even-bearer-scheme-' + 'x'.repeat(50);
    const r = resolveIdentity(weird, on, '203.0.113.50');
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(weird));
  });
});

describe('clientIpOf', () => {
  const mk = (xff: string | string[] | undefined, remote?: string) =>
    ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });

  test('takes the RIGHTMOST X-Forwarded-For entry (the one our proxy appended)', () => {
    assert.equal(clientIpOf(mk('203.0.113.50')), '203.0.113.50');
    assert.equal(clientIpOf(mk('6.6.6.6, 203.0.113.50')), '203.0.113.50');
    assert.equal(clientIpOf(mk('forged, also-forged, 198.51.100.7')), '198.51.100.7');
  });

  test('normalizes IPv6-mapped IPv4 and strips whitespace', () => {
    assert.equal(clientIpOf(mk('::ffff:203.0.113.50')), '203.0.113.50');
    assert.equal(clientIpOf(mk('  203.0.113.50  ')), '203.0.113.50');
  });

  test('array-valued header uses the last header instance', () => {
    assert.equal(clientIpOf(mk(['1.1.1.1', '2.2.2.2, 203.0.113.9'])), '203.0.113.9');
  });

  test('falls back to socket.remoteAddress, then "unknown"', () => {
    assert.equal(clientIpOf(mk(undefined, '::ffff:127.0.0.1')), '127.0.0.1');
    assert.equal(clientIpOf(mk(undefined, undefined)), 'unknown');
    assert.equal(clientIpOf({ headers: {} }), 'unknown');
  });

  test('an empty rightmost entry falls back rather than yielding an empty identity', () => {
    assert.equal(clientIpOf(mk('203.0.113.50,', '10.0.0.1')), '10.0.0.1');
  });

  test('strips a trailing port suffix from IPv4 and bracketed IPv6; unbracketed IPv6 is left intact', () => {
    // The trusted proxy SHOULD emit a bare address, but a port suffix is stripped
    // defensively so a proxy that includes the ephemeral source port doesn't
    // fragment one client across many rate-limit buckets.
    assert.equal(clientIpOf(mk('203.0.113.50:8080')), '203.0.113.50');
    assert.equal(clientIpOf(mk('[2001:db8::1]:8080')), '2001:db8::1');
    assert.equal(clientIpOf(mk('[2001:db8::1]')), '2001:db8::1');
    // Unbracketed IPv6 has no unambiguous port delimiter - its own colons must
    // never be mistaken for one.
    assert.equal(clientIpOf(mk('2001:db8::1')), '2001:db8::1');
  });
});

describe('resolveIdentity with auth disabled (per-IP anonymous buckets)', () => {
  const disabled = loadAuthConfig({});
  test('identity is anon:<ip>, distinct per client', () => {
    const a = resolveIdentity(undefined, disabled, '203.0.113.50');
    const b = resolveIdentity(undefined, disabled, '198.51.100.7');
    assert.deepEqual(a, { ok: true, identity: 'anon:203.0.113.50' });
    assert.deepEqual(b, { ok: true, identity: 'anon:198.51.100.7' });
    assert.notEqual((a as any).identity, (b as any).identity);
  });
  test('a presented token is ignored when auth is disabled - still per-IP', () => {
    const r = resolveIdentity('Bearer whatever', disabled, '203.0.113.50');
    assert.deepEqual(r, { ok: true, identity: 'anon:203.0.113.50' });
  });
});
