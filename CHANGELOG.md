# Changelog

## Unreleased

### Breaking

- **`vector_build_message_agent` is retired** (Part 2 Section 10 of the identity registry plan). Its builder,
  the label-674 constant and the `metadataStr` helper are removed.
- **`vector_discover_agents` reads the marketplace indexer** (`/suppliers`, which applies the listing rule)
  instead of scanning the legacy registry address. It lists agents that have a listed advert and names their
  `did:vector:<id>` DID when the advert names one. The `framework` filter is removed: the indexer has no
  framework field (use `vector_get_agent_profile` for the profile). `limit` is now an integer from 1 to 100.
- **The legacy registry constants move to `legacy-registry.ts`** (`LEGACY_REGISTRY_SCRIPT_CBOR`,
  `LEGACY_REGISTRY_POLICY_ID`, `LEGACY_REGISTRY_DEPOSIT`, `legacyRegistryScript()`, `legacyRegistryAddress()`,
  `legacyDid()`). `gov-build.ts` no longer exports `AGENT_REGISTRY_POLICY` and no longer reads the
  `AGENT_REGISTRY_POLICY` environment variable.

### Added

- `vector_build_marketplace_post_advert` and `vector_build_marketplace_retire_advert`: the supplier side of the agents
  marketplace, keyless. The advert datum is byte-identical to the supplier template's (pinned against the service
  agents' live adverts); the Post refuses what the ledger would refuse (a text field over 64 bytes), what
  `vector_build_marketplace_post_escrow` would not hire (a processing window over 24 h, a non-https endpoint or one
  with whitespace, a query or a fragment, a fleet capability id) and what a supplier template cannot serve (a
  processing window under 60,001 ms). A `detail_uri` needs the caller's `detail_hash`: the server fetches nothing.
  The Retire is evaluated against the deployed advert validator in the unit tests.
- `vector_build_reputation_stake_open` and `vector_build_reputation_stake`: an agent's Module-3 reputation
  self-stake in two keyless steps, ported from the reference Python SDK (`Apex-Fusion/vector-agent-modules`,
  `Module-3/python/reputation_staking`). The stake is the module's minimum read from its parameters on the ledger, the
  staked capabilities must be listed in the agent's registry record, and the stake time comes from the node's chain
  start, which must be Vector mainnet's. Mainnet only. The unit tests rebuild two stakes the SDK made on mainnet and
  have the deployed reputation validator evaluate them offline. **Held:** not for use on mainnet until the deployed
  Module-3 module is fixed and redeployed (the README's Reputation section says why).
- `vector_resolve_did`: resolves a `did:vector` DID (canonical or legacy form, optional `versionId` or
  `versionTime`) through the identity gateway (`GET /1.0/identifiers/{did}`, `Accept: application/did-resolution`)
  and returns the HTTP status and the resolution result unchanged. Gateway: `VECTOR_IDENTITY_GATEWAY_URL`
  (default `https://id.vector.apexfusion.org`).
- Signer: `vector_signer_get_public_key` returns the Ed25519 public key and its key hash (not secret).
- Signer: optional `VECTOR_SIGNER_OGMIOS_URL`. With it, the signer reads the outputs that a transaction spends
  (one read-only `queryLedgerState/utxo` query, output references only) and counts only the value that its
  own inputs fund. Without it, or when the lookup fails, it uses the previous rule and says so in the result.
- 37 tools in all (was 33).

### Changed

- `vector_get_agent_profile` accepts both DID forms: a canonical DID resolves through the identity gateway
  (profile, effective status, keys, record output); a legacy DID still reads the legacy registry.
- Signer: `vector_signer_sign` and `vector_signer_decode_transaction` accept a partly signed transaction. The
  witnesses of other keys stay byte for byte and in their order; this key gets exactly one witness.
- Signer: the audit log records the outflow rule of each decision (`rule`: `own-inputs` or `all-outputs`).

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
