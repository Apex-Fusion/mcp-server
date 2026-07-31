import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { intEnv } from '../src/env.ts';

// One case per real production call site: exact (name, default, min) triple
// as actually passed in index.ts / rate-limiter.ts, plus a validOverride
// already exercised by the integration suite for that var (see
// streamable-http-gating.test.ts / rate-limit-gating.test.ts) - proof this
// function accepts the values those hermetic tests already depend on, not
// just values chosen for this file. Keep these four rows in sync with the
// real call sites if either changes.
const KNOBS: Array<{ name: string; def: number; min: number; validOverride: string }> = [
  { name: 'VECTOR_MCP_SESSION_IDLE_MS', def: 10 * 60 * 1000, min: 100, validOverride: '400' },
  { name: 'VECTOR_MCP_SESSION_SWEEP_MS', def: 60_000, min: 100, validOverride: '100' },
  { name: 'VECTOR_MCP_MAX_SESSIONS_PER_IDENTITY', def: 32, min: 1, validOverride: '2' },
  { name: 'VECTOR_RATE_LIMIT_PER_MINUTE', def: 60, min: 1, validOverride: '3' },
];

for (const { name, def, min, validOverride } of KNOBS) {
  describe(`intEnv - ${name} (default ${def}, min ${min})`, () => {
    test('uses the default when unset', () => {
      assert.equal(intEnv(name, def, min, {}), def);
    });

    test('accepts a valid override (the exact value the integration suite uses for this var)', () => {
      assert.equal(intEnv(name, def, min, { [name]: validOverride }), Number(validOverride));
    });

    test('accepts the min value itself (inclusive boundary)', () => {
      assert.equal(intEnv(name, def, min, { [name]: String(min) }), min);
    });

    test('rejects a non-integer value, throwing and naming the var', () => {
      // A fully non-numeric string (Number(...) -> NaN), a real fractional
      // number, and a numeric-prefix-plus-garbage string (the specific shape
      // a bare parseInt would have silently truncated instead of rejecting -
      // e.g. parseInt('100garbage') === 100).
      for (const bad of ['not-a-number', `${min}.5`, `${min}garbage`, 'Infinity']) {
        assert.throws(
          () => intEnv(name, def, min, { [name]: bad }),
          new RegExp(name),
          `must throw naming ${name} for value ${JSON.stringify(bad)}`
        );
      }
    });

    test('rejects a below-min value, throwing and naming the var', () => {
      for (const bad of [String(min - 1), '-1']) {
        assert.throws(
          () => intEnv(name, def, min, { [name]: bad }),
          new RegExp(name),
          `must throw naming ${name} for value ${JSON.stringify(bad)}`
        );
      }
    });
  });
}

describe('intEnv - generic behavior', () => {
  test('the thrown message names the var and echoes the offending raw value (never silently swallowed)', () => {
    assert.throws(
      () => intEnv('VECTOR_MCP_SESSION_IDLE_MS', 600_000, 100, { VECTOR_MCP_SESSION_IDLE_MS: '10m' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /VECTOR_MCP_SESSION_IDLE_MS/);
        assert.match(err.message, /10m/);
        return true;
      }
    );
  });

  test('an explicitly empty value is not treated as "unset" - it is parsed (Number(\'\') is 0) and rejected by any min >= 1', () => {
    // Distinguishes "unset" (env[name] === undefined -> default) from
    // "set to an empty string" (env[name] === '' -> parsed, not defaulted).
    // Every real knob's min is >= 1, so this always throws for them - but
    // the throw must come from failing the min check, not from treating ''
    // as somehow equivalent to undefined.
    assert.throws(() => intEnv('VECTOR_RATE_LIMIT_PER_MINUTE', 60, 1, { VECTOR_RATE_LIMIT_PER_MINUTE: '' }), /VECTOR_RATE_LIMIT_PER_MINUTE/);
  });

  test('defaults to process.env when no explicit env object is passed (matches loadAuthConfig\'s own testability pattern in auth.ts)', () => {
    const PROBE = 'VECTOR_TEST_INT_ENV_PROBE__DO_NOT_USE_ELSEWHERE';
    const prior = process.env[PROBE];
    process.env[PROBE] = '42';
    try {
      assert.equal(intEnv(PROBE, 1, 1), 42);
    } finally {
      if (prior === undefined) delete process.env[PROBE];
      else process.env[PROBE] = prior;
    }
  });
});
