# Changelog

## Unreleased

### Added

- `vector_build_marketplace_post_advert` and `vector_build_marketplace_retire_advert`: the supplier side of the agents
  marketplace, keyless. The advert datum is byte-identical to the supplier template's (pinned against the service
  agents' live adverts); the Post refuses what the ledger would refuse (a text field over 64 bytes) and what
  `vector_build_marketplace_post_escrow` would not hire (a processing window over 24 h, a non-https endpoint, a fleet
  capability id). The Retire is evaluated against the deployed advert validator in the unit tests.
- `vector_build_reputation_stake_open` and `vector_build_reputation_stake`: an agent's Module-3 reputation
  self-stake in two keyless steps, ported from the reference Python SDK (`Apex-Fusion/vector-agent-modules`,
  `Module-3/python/reputation_staking`). The stake is the module's minimum read from its parameters on the ledger, the
  staked capabilities must be listed in the agent's registry record, and the stake time comes from the node's chain
  start, which must be Vector mainnet's. Mainnet only. The unit tests rebuild two stakes the SDK made on mainnet and
  have the deployed reputation validator evaluate them offline.
- 37 tools in all (was 33).

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
