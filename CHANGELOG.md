# Changelog

## Unreleased

### Breaking

- **The legacy registry writes are retired** (Part 2 Section 10): `vector_build_register_agent`,
  `vector_build_update_agent` and `vector_build_transfer_agent` are removed with their builders. New records go
  to the identity registry (`vector_build_identity_register`); a legacy record moves there with
  `vector_build_identity_adopt`. `vector_build_deregister_agent` stays for legacy records that do not adopt.
- **Two escrow and advert layouts during the drain** (Part 2 Section 6): the marketplace tools read both the legacy
  layouts and the identity-marketplace layouts (escrow: `agent_id` and `refund`; advert: `agent_id`), and every
  post refuses an escrow above the 10,000 AP3X value cap (payment + both bonds).
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
- **Identity registry build tools** (`did:vector`, Part 2 Sections 3 and 10), keyless: `vector_build_identity_register`
  (also subagents), `_adopt`, `_update`, `_change_controller`, `_suspend`, `_unsuspend`, `_revoke`, `_retire`,
  `_reclaim`, `_set_successor`, `_recovery_start`, `_recovery_cancel`, `_recovery_complete`, `_end_subagents`.
  Every build returns the unsigned transaction and every key hash that must sign it, with its role; each key
  holder signs in turn with `vector_signer_sign`. Lucid runs the applied identity script on each build.
- **Attestation, delegation and vault build tools** (Part 2 Sections 4 and 5): `vector_build_attestation_attest`,
  `_revoke`, `_contest`, `_withdraw`; `vector_build_delegation_delegate`, `_undelegate`;
  `vector_build_vault_open`, `_pay`, `_close`.
- **Marketplace tools for the identity layout** (Part 2 Section 6): `vector_build_marketplace_release`,
  `vector_build_marketplace_refund_revoked`, `vector_build_marketplace_advert_post`, `_advert_update`,
  `_advert_retire`. Post escrow takes `agent_id` from an advert that the indexer lists and sets the refund to the
  buyer's own address; accept, reclaim and release work in both layouts; receipts are checked with 8 fields
  (legacy escrow) or 9 fields with `agent_did` (identity escrow); the supplier lists show the agent DID; the
  escrow lineage follows both escrow credentials.
- **Identity deployment configuration**: `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` (both or
  neither), optional `VECTOR_IDENTITY_POLICY_ID`, the reference-script UTxOs `VECTOR_IDENTITY_REF_UTXO`,
  `VECTOR_IDENTITY_{ATTESTATION,DELEGATION,VAULT,ESCROW,ADVERT,MODULE1}_REF_UTXO`, and `VECTOR_IDENTITY_ALLOWLIST_URL`.
  The server applies the deployment parameters to the unapplied scripts of the identity-marketplace blueprint
  (agents-marketplace b5d66a6, generated into `identity-scripts.generated.ts` by
  `packages/builder/scripts/gen-identity-scripts.mjs`, with a checksum test) at startup, with the uplc crate of
  Aiken (`@lucid-evolution/uplc`, now a direct dependency), so the hashes equal `aiken blueprint apply`.
- `vector_resolve_did`: resolves a `did:vector` DID (canonical or legacy form, optional `versionId` or
  `versionTime`) through the identity gateway (`GET /1.0/identifiers/{did}`, `Accept: application/did-resolution`)
  and returns the HTTP status and the resolution result unchanged. Gateway: `VECTOR_IDENTITY_GATEWAY_URL`
  (default `https://id.vector.apexfusion.org`).
- Signer: `vector_signer_get_public_key` returns the Ed25519 public key and its key hash (not secret).
- Signer: optional `VECTOR_SIGNER_OGMIOS_URL`. With it, the signer reads the outputs that a transaction spends
  (one read-only `queryLedgerState/utxo` query, output references only) and counts only the value that its
  own inputs fund. Without it, or when the lookup fails, it uses the previous rule and says so in the result.
- 62 tools in all (was 33).

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
