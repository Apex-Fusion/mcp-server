# Changelog

## 3.0.0 - 2026-11-03

The identity release (PR #26) and the escrow switch (PR #27). The builder adds keyless tools for the `did:vector`
identity registry: records, attestations, delegations and vaults. The marketplace tools read and spend both escrow
and advert layouts. From the escrow switch (mainnet slot 37226741) on, they create identity-layout adverts and
escrows only. The legacy registry writes and `vector_build_message_agent` are retired. The signer adds
`vector_signer_get_public_key`, accepts partly signed transactions, and can count only the value that its own inputs
fund. All packages, `server.json` and both advertised MCP server identities are at 3.0.0. The marketplace tools of
PRs #20 to #24 (read, escrow build and transport) came after 2.0.0 without entries of their own; this version
includes them.

### Breaking

- **The legacy registry writes are retired** (Part 2 Section 10): `vector_build_register_agent`,
  `vector_build_update_agent` and `vector_build_transfer_agent` are removed with their builders. New records go
  to the identity registry (`vector_build_identity_register`); a legacy record moves there with
  `vector_build_identity_adopt`. `vector_build_deregister_agent` stays for legacy records that do not adopt.
- **Two escrow and advert layouts during the drain** (Part 2 Section 6): the marketplace tools read both the legacy
  layouts and the identity-marketplace layouts (escrow: `agent_id` and `refund`; advert: `agent_id`), and every
  post refuses an escrow above the 10,000 AP3X value cap (payment + both bonds).
- **The escrow switch** (Part 2 Section 9.6): from mainnet slot 37226741 (2026-11-03T13:25:41Z,
  `ESCROW_SWITCH_SLOT`), compared with the chain tip as the agents-marketplace gateway compares it, the builders
  create identity-layout adverts and escrows only. `vector_build_marketplace_post_escrow` refuses a legacy-layout
  advert, and `vector_build_marketplace_post_advert` refuses before it reads the wallet. The refusals name the
  identity-layout tool to use (`vector_build_marketplace_advert_post`). Accept, reclaim and release of legacy escrows,
  and the retire of legacy adverts, stay until the drain ends. A chain tip that the node cannot give is a refusal.
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
- **The self-improvement tools move to the Module-6 deployment on the identity registry** (Part 2 Section 7). The
  `GOV_*` settings name that deployment and have no defaults: `GOV_{PROPOSAL,CRITIQUE,ENDORSEMENT}_SPEND_HASH`,
  `GOV_{PROPOSAL,CRITIQUE}_MINT_HASH`, `GOV_RECORD_TOKEN_POLICY`, `GOV_REFS_TOKEN_POLICY`, `GOV_PARAMS_ADDRESS`,
  `GOV_CROSSREFS_ADDRESS`, `GOV_TREASURY_ADDRESS` (all or none; a value of the previous deployment stops the start) and
  the reference scripts `GOV_{PROPOSAL,CRITIQUE,ENDORSEMENT}_SPEND_REF`, `GOV_{PROPOSAL,CRITIQUE}_MINT_REF`.
  `GOV_PARAMS_UTXO`, `GOV_ORACLE_UTXO` and `GOV_CROSSREFS_UTXO` are gone: the builders find the GovernanceParams
  record, the 5-field CrossRefs output and the head of the activity list by their tokens. The build tools also need
  the identity deployment.
- **`agentDid` is a `did:vector` agent**: the canonical DID, the legacy DID form or the bare 64-hex identifier of an
  identity record (it was the asset name of a legacy registry NFT). The record and its ancestors are reference inputs,
  the record must be Active over the validity window (at most one hour), and the datum names a declared credential
  (`credentialKeyHash`: the controller key or a listed transaction key; default the wallet key), which signs step 2.
- **Critiques and endorsements take two steps**, as proposals do: `vector_build_self_improvement_critique` and
  `_endorse` lock the stake, and the new `vector_build_self_improvement_critique_spend` and `_endorse_spend` create the
  position and mint its token (`crit_`, `gend_`). A critique or an endorsement names its proposal by the seed (the lock
  that its submission spent); `proposalTxHash` takes the seed or the proposal's current output. The first submission of
  an agent inserts its node into the activity list. Steps 2 run the applied Module-6 validators locally at build time.
- `vector_self_improvement_browse` and `_analyze_metrics` read the current deployment, or the previous one with
  `deployment: 'previous'` (its positions stay until their owners exit). The `proposalTxHash` filter takes the seed or
  the current output of the proposal. `scripts/capture-gov-state.mjs` (a capture of the previous deployment) is removed.

### Added

- **Advert tools, one per action** (PR #25 merged into the identity layout): `vector_build_marketplace_advert_post`,
  `_advert_update` and `_advert_retire`. One set of terms rules holds in both layouts: `capability_id` and `model` at
  most 64 bytes of UTF-8, `endpoint_url` and `detail_uri` at most 64 bytes in the legacy layout (its encoder writes
  each field as one bytestring) and 256 in the identity layout (its encoder splits long bytestrings), no fleet
  capability id, an https endpoint without whitespace, query or fragment (jobs go to
  `<endpoint_url>/v1/job`), a processing window from 60,001 ms (the shortest a supplier template serves) to 24 h,
  price + both bonds at most 10,000 AP3X, and a `detail_uri` only with the caller's `detail_hash` (the server fetches
  nothing). `vector_build_marketplace_advert_retire` also retires a legacy-layout advert (the supplier template's
  Retire, evaluated against the deployed advert validator in the unit tests), so suppliers retire their legacy
  adverts during the switch; `vector_build_marketplace_retire_advert` of PR #25 is gone.
- `vector_build_marketplace_post_advert`: legacy layout, refused from the escrow switch on (see Breaking). Before
  the switch, it posts a legacy-layout advert byte-identical to the supplier template's (pinned against the service
  agents' live adverts), with the same terms rules.
- `vector_build_reputation_stake_open` and `vector_build_reputation_stake`: an agent's Module-3 reputation
  self-stake in two keyless steps, ported from the reference Python SDK (`Apex-Fusion/vector-agent-modules`,
  `Module-3/python/reputation_staking`). The current Module-3 deployment takes no new stakes. New stakes use the new
  Module-3 deployment, which is published after the identity release. Until then both tools refuse before they read
  anything; the builders stay, and the unit tests run them against the deployed reputation validator offline.
- Module-1's consent withdrawal reads the reward balance with no default: Ogmios's reward account summary, else
  Koios `account_info` (Vector's Ogmios has no summary for a registered stake credential that is not delegated). A
  stake credential that is not registered, or a read that fails, is refused; the balance is never taken as 0.
- **Identity registry build tools** (`did:vector`, Part 2 Sections 3 and 10), keyless: `vector_build_identity_register`
  (also subagents), `_adopt`, `_update`, `_change_controller`, `_suspend`, `_unsuspend`, `_revoke`, `_retire`,
  `_reclaim`, `_set_successor`, `_recovery_start`, `_recovery_cancel`, `_recovery_complete`, `_end_subagents`.
  Every build returns the unsigned transaction and every key hash that must sign it, with its role; each key
  holder signs in turn with `vector_signer_sign`. Lucid runs the applied identity script on each build.
  Register, adopt and update refuse an appointment that Module-1 would not consent to before they build. A
  revocation takes `invalid_from` from one hour before the record's `created_at` up to the start of the validity
  window, so a key-compromise revocation right after the registration is possible.
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
  (agents-marketplace 1643583, generated into `identity-scripts.generated.ts` by
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
- 63 tools in all (33 before PR #25 and the identity release; 24 in 2.0.0).

### Changed

- `vector_get_agent_profile` accepts both DID forms: a canonical DID resolves through the identity gateway
  (profile, effective status, keys, record output); a legacy DID still reads the legacy registry.
- Signer: `vector_signer_sign` and `vector_signer_decode_transaction` accept a partly signed transaction. The
  witnesses of other keys stay byte for byte and in their order; this key gets exactly one witness.
- Signer: the audit log records the outflow rule of each decision (`rule`: `own-inputs` or `all-outputs`).
- All package versions, `server.json` and both advertised MCP server identities move to 3.0.0 (one shared
  version).

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
