// Fail-loud parsing for integer environment variables that bound resource
// usage: rate limits, session timers, session caps. A malformed value must
// never silently degrade or disable the bound it configures - the same
// philosophy loadAuthConfig (auth.ts) already applies to MCP_AUTH_TOKENS,
// applied here to the numeric knobs instead.
//
// Pulled into its own file, rather than written inline in index.ts, for one
// concrete reason: index.ts is an executable entrypoint (importing it boots
// a real server as a side effect - see MAX_SESSIONS_PER_IDENTITY's comment
// there), so nothing defined at its module scope can be unit-tested by
// importing it directly. This function has no side effects of its own and
// takes an explicit `env` parameter (default `process.env`), matching
// loadAuthConfig's own testability pattern, so it - and every knob that
// calls it - can be verified directly, in isolation, the same way
// loadAuthConfig is.
export function intEnv(
  name: string,
  def: number,
  min: number,
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[name];
  if (raw === undefined) return def;

  // Number(), not parseInt: parseInt('10m') silently truncates to 10, so a
  // typo ships a working-looking-but-wrong bound instead of failing to
  // start. Number('10m') is NaN, which fails the isInteger check below, so
  // trailing garbage is rejected rather than misread.
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}.`);
  }
  return n;
}
