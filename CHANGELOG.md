# Changelog

## 2.0.0 - 2026-08-17

### Breaking

- **The legacy SSE transport is removed.** `GET /sse` and `POST /messages` now answer 404.
  Every client connects over Streamable HTTP at `/mcp`:
  `claude mcp add --transport http vector-mcp <url>/mcp`. The `sse` remote was removed from
  the MCP Registry manifest (`server.json`).

### Added

- `GET /health`: unauthenticated liveness probe, returns
  `{"status":"ok","version":"<version>"}`. It creates no session and bypasses the rate
  limiter.
- Any-origin CORS on the whole HTTP surface, including preflight (`OPTIONS` → 204) and error
  responses, with `mcp-session-id` exposed to browser callers. Browser-based MCP clients can
  connect directly; authorization remains bearer-token only. Note for self-hosters: with
  `MCP_AUTH_TOKENS` unset, any web page can drive your instance from a visitor's browser,
  sharing that visitor's per-IP rate-limit bucket - set `MCP_AUTH_TOKENS` on any instance
  reachable by anyone but you.

### Changed

- All package versions, `server.json`, and both advertised MCP server identities are unified
  at 2.0.0; the identities now read the version from `package.json` at build time instead of
  hardcoding it.
- `@modelcontextprotocol/sdk` floor raised to `^1.30.0`.

### Known limits

- POST responses stream as SSE frames (the spec-default mode) with no keepalive bytes while a
  tool call computes. Behind a proxy that cuts idle responses (Cloudflare's edge does at
  ~100 s), a single tool call that stays silent longer than that window is dropped by the
  proxy. Long waits (e.g. `vector_await_transaction` on a congested chain) should poll in
  shorter calls.
