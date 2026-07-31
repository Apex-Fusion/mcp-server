// Bearer-token auth for the hosted builder.
//
// Enforced only when MCP_AUTH_TOKENS is configured: hosted deployments set it,
// localhost self-hosters are unaffected. The resolved identity is also the
// rate-limit bucket key, so limits are per-caller rather than per-process.
//
// A token is a secret. It must never appear in a log line, an error message,
// or a rejection reason.
import { createHash } from 'node:crypto';

export interface AuthConfig {
  enabled: boolean;
  /** token -> non-secret identity label */
  identities: Map<string, string>;
}

export const ANONYMOUS_PREFIX = 'anon:';

/**
 * Client address for rate-limit identity when auth is disabled.
 *
 * Trust model: this server binds 127.0.0.1 behind ONE trusted reverse proxy that
 * APPENDS the true peer address to X-Forwarded-For. The RIGHTMOST entry is therefore
 * the only trustworthy one; everything left of it is client-supplied and forgeable.
 * Direct access (self-hosting without a proxy) has no XFF header and falls back to the
 * socket's remote address.
 */
export function clientIpOf(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  const raw = req.headers['x-forwarded-for'];
  const headerValue = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (headerValue) {
    const entries = headerValue.split(',');
    const rightmost = entries[entries.length - 1]?.trim();
    if (rightmost) return rightmost.replace(/^::ffff:/i, '');
  }
  const remote = req.socket?.remoteAddress;
  if (remote) return remote.replace(/^::ffff:/i, '');
  return 'unknown';
}

/** Stable, non-reversible label for a bare token, so logs can name a caller safely. */
function labelForToken(token: string): string {
  return `client-${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;
}

// Parsing notes for MCP_AUTH_TOKENS (comma-separated "label:token" or bare-token entries):
//
// - Only the FIRST colon in an entry separates label from token. Everything after it,
//   including further colons, belongs to the token (so a token may itself contain colons,
//   but a label never can - "team:alpha:tok" means label "team", token "alpha:tok").
// - Comma is the entry delimiter and cannot be escaped. A label or token that itself
//   contains a literal comma will silently fragment into extra, unintended entries
//   (e.g. "alice:correct,horse,battery,staple" yields FOUR entries, three of them
//   unintended standalone bearer tokens). Generate tokens from a comma-free charset
//   (hex / base64url / alphanumeric) to avoid this - there is no way for this parser
//   to detect the fragmentation after the fact, since the comma is already consumed
//   by the top-level split before any entry is inspected.
export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const raw = (env.MCP_AUTH_TOKENS ?? '').trim();
  if (raw === '') return { enabled: false, identities: new Map() };

  const identities = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const sep = trimmed.indexOf(':');
    const label = sep === -1 ? undefined : trimmed.slice(0, sep).trim();
    const token = sep === -1 ? trimmed : trimmed.slice(sep + 1).trim();

    if (token === '') {
      throw new Error(
        'MCP_AUTH_TOKENS contains an entry with an empty token. Use "label:token" or a bare token.'
      );
    }
    if (/\s/.test(token)) {
      // resolveIdentity matches the token with \S+, which cannot span whitespace (this
      // includes ASCII space/tab and Unicode space separators, but not the zero-width
      // space U+200B - the token would be configured yet could never be presented via
      // "Authorization: Bearer <token>". Fail loudly now instead of creating a dead entry.
      throw new Error(
        'MCP_AUTH_TOKENS contains a token with embedded whitespace, which can never be ' +
          'presented in an Authorization header. Remove the whitespace from the token value.'
      );
    }
    if (identities.has(token)) {
      // Silently overwriting would merge two callers into one rate-limit bucket.
      throw new Error('MCP_AUTH_TOKENS contains a duplicate token.');
    }
    identities.set(token, label && label !== '' ? label : labelForToken(token));
  }

  if (identities.size === 0) {
    // raw was non-empty (the early return above already handled unset/blank), yet every
    // comma-delimited segment parsed to nothing (e.g. ",,," or " , , "). That is almost
    // certainly a broken template or interpolation, not an intentional choice - unlike an
    // explicitly empty/unset MCP_AUTH_TOKENS, which is the documented way to disable auth.
    // Failing loudly here matters: the alternative is silently treating a botched "enable
    // auth" attempt as "auth disabled", exposing an unauthenticated server the operator
    // believed was locked down.
    throw new Error(
      'MCP_AUTH_TOKENS is set but contains no usable tokens (only empty/blank entries after ' +
        'parsing). Leave it unset to disable auth, or provide at least one "label:token" or bare token.'
    );
  }
  return { enabled: true, identities };
}

export function resolveIdentity(
  authHeader: string | undefined,
  config: AuthConfig,
  clientIp: string
): { ok: true; identity: string } | { ok: false; reason: string } {
  // Auth disabled: every caller is admitted, but each client IP gets its OWN
  // rate-limit bucket. Before this, all anonymous callers shared one bucket and
  // one busy caller throttled the whole box - untenable for a public instance.
  if (!config.enabled) return { ok: true, identity: ANONYMOUS_PREFIX + clientIp };

  if (!authHeader) {
    return { ok: false, reason: 'Missing Authorization header. Expected: Authorization: Bearer <token>' };
  }

  const match = /^Bearer (\S+)$/i.exec(authHeader);
  if (!match) {
    return { ok: false, reason: 'Malformed Authorization header. Expected: Authorization: Bearer <token>' };
  }

  // Map.get is not constant-time (a hash step, then a native string-equality check on a
  // bucket hit that may short-circuit on the first mismatched byte). Judged acceptable here,
  // not applied blindly: the hash step's cost depends on the LENGTH of the caller-supplied
  // string, which the caller already knows, not on how many of its leading bytes match a
  // stored token, so it leaks no "getting warmer" gradient the way a naive sequential
  // comparison of one fixed secret would. A false hash-bucket hit against a specific
  // high-entropy token is not a practical target, and the comparison sits behind an HTTP
  // round trip (Task 2), where network jitter dwarfs any nanosecond-scale residual signal.
  // crypto.timingSafeEqual defends a different shape (one supplied value against one known
  // secret via naive comparison); it does not fit a multi-key lookup without a linear scan
  // over every configured token on every request, which is a worse trade for a risk that
  // is not actually present here.
  // Caveat: this relies on V8 hashing the whole input before any per-key comparison, which
  // is an engine implementation detail, not an ECMAScript guarantee - worth re-checking if
  // this ever runs on a different JS engine.
  const identity = config.identities.get(match[1]);
  if (!identity) {
    // Never echo the supplied value.
    return { ok: false, reason: 'Unrecognised bearer token.' };
  }

  return { ok: true, identity };
}
