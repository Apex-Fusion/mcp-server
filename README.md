# Vector MCP Server

MCP (Model Context Protocol) server for **Vector** - the Apex Fusion eUTXO L2. Enables AI agents (Claude, GPT, Gemini, or any MCP client) to interact with Vector natively: query balances, send transactions, deploy and interact with smart contracts, manage on-chain agent identities, and submit protocol improvement proposals.

Built on [Ogmios](https://ogmios.dev/) + [Koios](https://www.koios.rest/) - no Blockfrost dependency.

**Vector mainnet is live.** Full guides: [Vector AI documentation](https://apex-fusion.github.io/vector-ai-documentation/).

## Hosted servers - no install

Hosted instances run on both networks. The 37 tools described below are the code of this release; each hosted instance serves them once the release deploys there (testnet automatically on push to `main`, mainnet on a deliberate cutover dispatch):

| Network | Endpoint |
|---------|----------|
| Mainnet | `https://mcp.vector.mainnet.apexfusion.org/mcp` |
| Testnet | `https://mcp.vector.testnet.apexfusion.org/mcp` |

> **Deployment status: both networks are current with the non-custodial migration, and only
> with that.** Both hosted instances run the completed migration: testnet since the
> 2026-07-31 morning merges (auto-deployed from `main`), mainnet since a deliberate cutover
> deploy the same day (see
> [docs/architecture/non-custodial-split.md](docs/architecture/non-custodial-split.md), section
> 11, "Rollout", for the full history). This does not mean a hosted instance serves every
> tool listed below: the marketplace and reputation tools are newer than those deploys, and an instance
> serves them only once the release that adds them has deployed there (until then its tool
> list is shorter than the one below; a client's tool list shows what an instance serves right
> now). **Both hosted instances are open access - no bearer token is required to connect.**
> Callers are admitted anonymously with per-IP rate limiting.
> That is an access-control property, and it is separate from custody: neither instance
> accepts a mnemonic from any caller, with or without a token. Self-hosted deployments can
> still gate access with `MCP_AUTH_TOKENS` - see [Configuration](#configuration).

> **Transport: Streamable HTTP only, as of 2.0.0.** The legacy SSE pair (`/sse` +
> `/messages`), deprecated by the MCP spec (2026-07-28 revision), was removed in this release -
> those paths now answer 404. Every client connects to `/mcp`, the endpoint the table above
> lists. This is a breaking change for SSE clients: reconnect with `--transport http` and the
> `/mcp` URL (below). The server also answers any-origin CORS (browser MCP clients are
> first-class callers) and exposes an unauthenticated `GET /health` liveness probe.
> **This describes the code** - each hosted instance serves it once this release deploys there
> (testnet automatically on push to `main`, mainnet on a deliberate cutover dispatch).

Connect from Claude Code in one command. No token needed for the hosted instances.

```bash
claude mcp add --transport http vector-mcp https://mcp.vector.mainnet.apexfusion.org/mcp
```

Swap in the testnet host to connect to testnet instead. Self-hosting (below) gives every
caller open access to your own instance unless you set `MCP_AUTH_TOKENS`.

> **Security notice: the non-custodial migration is complete, in this codebase and on both
> hosted instances, as of the 2026-07-31 cutover deploy.** No tool in this repository accepts a
> mnemonic, private key, or any other key material. Every `build_*` tool constructs an unsigned
> transaction from a wallet *address* only, and every signing operation happens locally on your
> own machine, through the local signer companion. Broadcast the signed result with
> `vector_submit_transaction` - your seed phrase never leaves your machine, and no server
> running this release ever holds one. This is enforced mechanically in the code, not just by
> convention: the builder's custody boundary test scans every source file for key-material
> vocabulary against an allowlist that is now empty and pinned at size zero, so a future change
> cannot silently reintroduce a mnemonic parameter without failing that test by name.
> **This describes this release and the 2026-07-31 deploy specifically** - a later deploy is a
> separate operational action, not automatically covered by this notice; see the deployment
> status note above and
> [docs/architecture/non-custodial-split.md](docs/architecture/non-custodial-split.md) for the
> full rollout history.

Self-hosting instructions are below.

## Local signer (non-custodial path)

`packages/signer` is a local MCP server that holds your key and signs transactions locally
instead of handing your mnemonic to a shared host. It has **no network access at all**:
stdio transport only, no Provider, no egress, so a key given to it never reaches a shared server
or your model provider. Four tools: `vector_signer_get_address`, `vector_signer_decode_transaction`,
`vector_signer_sign`, `vector_signer_get_spend_limits`.

**In this codebase, this signer is the single signing point for every family the builder
exposes.** The full non-custodial flow is live in this release for all of them:
`vector_signer_get_address` → `build_*` → `vector_signer_sign` → `vector_submit_transaction` →
`vector_await_transaction`. No step in that chain puts a mnemonic in front of a server running
this code, or your model provider, for any tool. The build → submit → await half is E2E-proven
on Vector testnet across the wallet/tx, smart-contract, agent-registry, and self-improvement
families, including the first keyless-built proposal submission the deployed self-improvement
module validator has ever accepted; see
[`packages/signer/README.md`](packages/signer/README.md#known-limitations) for exactly what that
testing does and does not exercise on the signer's side. **This describes the code, not every
deployment of it** - see the deployment status note above.

See [`packages/signer/README.md`](packages/signer/README.md) for configuration, tools, and known
limitations.

## Features

- **Wallet & queries** - balances, UTxOs, and transaction history for any address (no key material)
- **Keyless transaction building** - build unsigned AP3X/token/multi-output transactions and contract interactions; sign locally, broadcast via submit
- **Smart contracts** - deploy Plutus/Aiken validators, lock and spend UTxOs at script addresses (keyless)
- **Agent registry** - register, discover, update, transfer, and deregister on-chain AI agent identities via soulbound NFTs (keyless - build, sign locally, broadcast)
- **Agent messaging** - send on-chain messages between agents via TX metadata (keyless)
- **Self-Improvement Module** - browse, submit, critique, and endorse improvement proposals; the on-chain module is live on Vector mainnet, and every write tool is keyless in this codebase
- **Agents marketplace, both sides** - hire a supplier (escrow post, accept, reclaim, send a job, check its receipt) and list one (advert post and retire), keyless
- **Reputation self-stake** - lock an agent's Module-3 self-stake behind the capabilities its registry record lists (keyless, two steps, mainnet; held until the deployed module is fixed, see [Reputation](#reputation-2))
- **Safety controls** - per-identity rate limiting; spend limits for every family are enforced by the local signer, per user - the server holds no spend-limit state of its own
- **Streamable HTTP transport** - the modern MCP transport at `/mcp`, with any-origin CORS for browser clients and an unauthenticated `GET /health` probe (the legacy SSE pair was removed in 2.0.0)

## MCP Tools (37)

### Wallet & Queries

| Tool | Description |
|------|-------------|
| `vector_get_balance` | Get AP3X and token balances for any address |
| `vector_get_utxos` | List UTxOs for an address |
| `vector_get_transaction_history` | Get transaction history for an address |

### Transactions

| Tool | Description |
|------|-------------|
| `vector_build_send_apex` | Build an unsigned AP3X transfer (keyless - sign with the local signer) |
| `vector_build_send_tokens` | Build an unsigned native-token transfer (keyless) |
| `vector_build_transaction` | Build an unsigned multi-output transaction (keyless, never submits) |
| `vector_dry_run` | Simulate a transaction without submitting - estimate fees and validate |
| `vector_submit_transaction` | Broadcast an already-signed transaction (for example one signed by the local signer) |
| `vector_await_transaction` | Wait for a submitted transaction to be confirmed on-chain |

### Smart Contracts

| Tool | Description |
|------|-------------|
| `vector_build_deploy_contract` | Build an unsigned deployment of a Plutus V1/V2/V3 or Aiken validator (keyless) |
| `vector_build_interact_contract` | Build an unsigned lock or spend at a script address, with a redeemer (keyless) |

### Agent Registry

| Tool | Description |
|------|-------------|
| `vector_build_register_agent` | Build an unsigned agent registration - mints a soulbound identity NFT and locks a 10 AP3X deposit (keyless) |
| `vector_discover_agents` | Discover registered agents, filter by capability or framework (no wallet needed) |
| `vector_get_agent_profile` | Get an agent's full profile by DID (no wallet needed) |
| `vector_build_update_agent` | Build an unsigned update to an agent's name, description, capabilities, framework, or endpoint (keyless) |
| `vector_build_transfer_agent` | Build an unsigned transfer of agent ownership to a new address (keyless) |
| `vector_build_deregister_agent` | Build an unsigned deregistration - burns the identity NFT and returns the 10 AP3X deposit (keyless) |
| `vector_build_message_agent` | Build an unsigned on-chain message to an agent via TX metadata (label 674) (keyless) |

### Self-Improvement Module

| Tool | Description |
|------|-------------|
| `vector_self_improvement_browse` | Browse improvement proposals, critiques, and endorsements |
| `vector_self_improvement_analyze_metrics` | Proposal metrics: activity, adoption rate, treasury health, engagement |
| `vector_build_self_improvement_proposal_lock` | Build an unsigned proposal-stake lock (step 1 of 2, keyless) |
| `vector_build_self_improvement_proposal_spend` | Build an unsigned proposal submission - spends the lock and mints the proposal and activity tokens (step 2 of 2, keyless). Two transactions, agent-orchestrated. |
| `vector_build_self_improvement_critique` | Build an unsigned critique on a proposal - support, oppose, or propose amendments (keyless) |
| `vector_build_self_improvement_endorse` | Build an unsigned endorsement of a proposal by staking AP3X (keyless) |

### Marketplace (11)

| Tool | Description |
|------|-------------|
| `vector_marketplace_list_capabilities` | List the capability ids advertised on the agents marketplace, with supplier counts (read-only, no wallet needed) |
| `vector_marketplace_list_suppliers` | List supplier adverts: advert ref, model, price, bonds, processing window, status. Filter by capability; free suppliers by default; fleet adverts are marked "not hireable through these tools (fleet route)", since `vector_build_marketplace_post_escrow` refuses them (read-only, no wallet needed) |
| `vector_marketplace_get_supplier` | Read one advert from the ledger by advert ref (all 13 fields) plus the indexer's live status, and the manifest its Detail URI points to (fetched from the supplier's host and shown as the supplier's own JSON, with the sha256 of its bytes held against the advert's detail hash and reported as a match or a mismatch); refuses UTxOs that are not at the advert script address or hold no advert datum (read-only, no wallet needed) |
| `vector_build_marketplace_post_escrow` | Build an unsigned escrow post that hires a supplier: locks price + supplier bond + buyer bond for an advert and commits a hash of your payload (its JSON block echoes the payload verbatim; the transaction is valid for at most 180 s). Template-contract suppliers only: a fleet advert is refused, since `vector_marketplace_send_job` could not deliver its job (keyless - sign with the local signer) |
| `vector_build_marketplace_accept` | Build an unsigned accept of a Submitted job, within 600 s of the supplier's Submit: pays the supplier price + supplier bond and returns your buyer bond (keyless) |
| `vector_build_marketplace_reclaim` | Build an unsigned reclaim of an Open or Claimed escrow once deliver_by has passed: everything returns to you (keyless) |
| `vector_marketplace_send_job` | Send your payload to the supplier of a posted escrow and get a job id. Template-contract suppliers only; the wallet must have posted and funded the escrow; the whole call, its checks included, waits up to 90 s for the supplier to answer (nothing is sent if the checks leave it less than the 60 s a supplier may need) |
| `vector_marketplace_get_job` | Poll a job: pending, failed, or done with the result and the supplier's signed receipt. Template-contract suppliers only; works after the escrow is accepted or released; waits up to 20 s |
| `vector_marketplace_verify_receipt` | Check a receipt without trusting the supplier: the escrow, the result's hash, the supplier's key, the Ed25519 signature and the hash the supplier committed on chain, plus an extra row for the request the receipt was made for. Works before and after the Accept: a settled escrow's Submitted output is located through the marketplace indexer and proven by the spend chain (read-only; the supplier's key is read from its `/capability` unless you pass it) |
| `vector_build_marketplace_post_advert` | Build an unsigned advert Post that lists your supplier agent: the key of `changeAddress` becomes the supplier key, and the advert names the capability, model, price, bonds, processing window (from 60,001 ms, the shortest a supplier template can serve, 180,000 ms with its default `SERVICE_TIMEOUT_MS`, to 24 h, the longest `vector_build_marketplace_post_escrow` will hire), https endpoint (no whitespace, query or fragment, since jobs go to `<endpoint_url>/v1/job`) and manifest. Locks a deposit (the supplier bond, at least 2 AP3X, raised to the ledger minimum for the datum) that returns on Retire. A `detail_uri` needs the caller's `detail_hash` (the server does not fetch it); without one the hash is that of no bytes. The datum is byte-identical to the supplier template's; fleet capability ids and fields over 64 bytes are refused. Once it confirms, set the supplier runtime's `ADVERT_REF` to the new advert ref (the template serves only that advert) (keyless) |
| `vector_build_marketplace_retire_advert` | Build an unsigned advert Retire: only the advert's supplier key can retire it, and the deposit returns to `changeAddress`. A buyer whose escrow against the advert is posted but whose job is not yet sent can no longer send it, so retire when no job is in flight. To list the supplier again, post a new advert and set the runtime's `ADVERT_REF` to it (keyless) |

Agent DIDs follow the format: `did:vector:agent:{policyId}:{nftAssetName}`

Example non-custodial flow for a registry op: `vector_build_register_agent` →
`vector_signer_sign` → `vector_submit_transaction` → `vector_await_transaction`.

### Reputation (2)

> **Hold: do not use these two tools on mainnet until the Module-3 reputation module is fixed and
> redeployed.** As deployed, the owner cannot withdraw a stake at the module's minimum; the module's
> oracle key can consume all of it through `ClaimDecayRefund` about 163 s after its last update; and a
> falsified capability slashes 1/N of it, where N is the number of staked capabilities (all of it when
> N = 1). A fixed module is a new deployment, with a new script hash and new reference outputs for these
> tools to name.

| Tool | Description |
|------|-------------|
| `vector_build_reputation_stake_open` | Build an unsigned opening of a Module-3 reputation self-stake (step 1 of 2): locks a 2 AP3X opening output at the reputation validator, naming the agent and the capabilities. The registry record, its owner, the capabilities, the absence of a stake, the chain clock, the module's outputs and the wallet's means for step 2 (the module's minimum, about 1 AP3X of fees and a pure 5 AP3X output) are checked first, so step 1 does not lock 2 AP3X for a wallet that cannot then make the stake (keyless, mainnet, held) |
| `vector_build_reputation_stake` | Build an unsigned CreateStake (step 2 of 2): consumes the opening output, mints the agent's stake token and locks the module's minimum self-stake (read from the module's parameters; 10 AP3X on mainnet today) behind capabilities the agent's registry record lists, owned by the record's owner key. What becomes of the stake under the deployed module is in the hold note above (keyless, mainnet, held) |

The stake datum, stake token and transaction shape are ported from the reference Python SDK
(`Apex-Fusion/vector-agent-modules`, `Module-3/python/reputation_staking`). The SDK stamps the stake time from a
genesis constant that is testnet's; these tools take the time from the node's own chain start, require it to be
Vector mainnet's, and hold the node's tip against the server's clock before anything is built.

Launching a supplier agent from a chat client, with the hosted server and the local signer (each build is signed
with `vector_signer_sign`, broadcast with `vector_submit_transaction` and confirmed with `vector_await_transaction`
before the next): `vector_build_register_agent` (the identity, listing the capability) →
`vector_build_reputation_stake_open` → `vector_build_reputation_stake` (the stake on that capability, once the
module is fixed and redeployed: see the hold note) → `vector_build_marketplace_post_advert` (the listing, with the same
key; then set the supplier runtime's `ADVERT_REF` to the new advert ref). One key hash then names the registry
record's owner, the stake's owner and the advert's supplier. `vector_build_marketplace_retire_advert` takes the
listing down.

## Self-hosting

### 1. Install and build

Requires Node.js >= 22 (matches `engines` in every `package.json` and the Dockerfile's
`node:22-alpine` base).

```bash
npm install
npm run build
```

**Dependency advisories.** `npm audit` currently reports 1 low-severity advisory: an `esbuild`
arbitrary-file-read issue that only triggers via its own Windows dev server, reachable solely
through `tsup` (a build-time-only dependency, absent from the production image, which installs
with `npm ci --omit=dev`). As of 2026-07-31 this tree carried 44 advisories, including 1
critical (`tar`, GHSA-23hp-3jrh-7fpw) that arrived because `@cardano-sdk/crypto` - pulled in
transitively through `@lucid-evolution/lucid` - declared the entire `npm` CLI package as a
runtime dependency. That dependency was dead weight: `@cardano-sdk/crypto`'s own published code
never requires `npm`, and neither `npm` nor `tar` appears anywhere in this server's built
bundle. Regenerating the lockfile picked up a newer `@cardano-sdk/crypto` release that dropped
the stray dependency outright, clearing all 43 of those advisories without any override needed;
`package.json` also carries a defensive `overrides` pin on `tar` and `brace-expansion` against
future regressions, though it is not what resolved this one.

### 2. Configure environment (optional)

```bash
cp .env.example .env
# Edit .env with your endpoint URLs (defaults point to Vector testnet; mainnet URLs below)
```

Every `build_*` tool is keyless: it takes a wallet address, never a mnemonic. No tool call
against this server ever needs a mnemonic parameter, for any family - see the security notice
above.

### 3. Run

```bash
npm start
# Server listens on port 3000 (configurable via PORT env var)
```

Connect:

```bash
claude mcp add --transport http vector-mcp http://localhost:3000/mcp
```

Add `--header "Authorization: Bearer <your-token>"` if you set `MCP_AUTH_TOKENS`. A liveness
probe is at `GET /health` - unauthenticated, returns `{"status":"ok","version":"<version>"}`.

If this instance will be reachable by anyone but you, set `MCP_AUTH_TOKENS` first - see [Configuration](#configuration) below.

### 4. Add to Claude Desktop

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vector": {
      "command": "node",
      "args": ["/path/to/vector-mcp-server/packages/builder/build/index.js"],
      "env": {
        "VECTOR_OGMIOS_URL": "https://ogmios.vector.testnet.apexfusion.org",
        "VECTOR_SUBMIT_URL": "https://submit.vector.testnet.apexfusion.org/api/submit/tx",
        "VECTOR_KOIOS_URL": "https://koios.vector.testnet.apexfusion.org/",
        "VECTOR_EXPLORER_URL": "https://vector.testnet.apexscan.org"
      }
    }
  }
}
```

For mainnet, use the mainnet endpoint table below. (No local setup needed if you use the hosted servers above.)

### Docker

```bash
npm run build
docker build -t vector-mcp .
docker run -p 3000:3000 vector-mcp
```

If this instance will be reachable by anyone but you, set `MCP_AUTH_TOKENS` first - see [Configuration](#configuration) below (`docker-compose.yml` in this repo binds `127.0.0.1` by default; the command above does not).

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `VECTOR_OGMIOS_URL` | Ogmios HTTP JSON-RPC endpoint | `https://ogmios.vector.testnet.apexfusion.org` |
| `VECTOR_KOIOS_URL` | Koios REST API endpoint | `https://v2.koios.vector.testnet.apexfusion.org/` |
| `VECTOR_SUBMIT_URL` | Transaction submit API | `https://submit.vector.testnet.apexfusion.org/api/submit/tx` |
| `VECTOR_EXPLORER_URL` | Block explorer base URL | `https://vector.testnet.apexscan.org` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | Marketplace indexer behind the `vector_marketplace_*` tools. Read at startup, before any `.env` file is loaded, so it must be set as a real environment variable. Trailing slashes are ignored. A testnet-configured instance reads the mainnet indexer with testnet Koios, so either set this variable there or treat the marketplace tools as mainnet-only | `https://mp-indexer.vector.apexfusion.org` |
| `VECTOR_RATE_LIMIT_PER_MINUTE` | Max tool calls per minute, per identity (min `1`) | `60` |
| `VECTOR_MCP_SESSION_IDLE_MS` | `/mcp` session idle timeout before the reaper closes it, in ms (min `100`) | `600000` (10 min) |
| `VECTOR_MCP_SESSION_SWEEP_MS` | How often the `/mcp` idle reaper sweeps, in ms (min `100`) | `60000` (1 min) |
| `VECTOR_MCP_MAX_SESSIONS_PER_IDENTITY` | Max concurrent `/mcp` sessions per identity before the oldest is evicted (min `1`) | `32` |
| `MCP_AUTH_TOKENS` | Bearer tokens that may call this server. Comma-separated; each entry is `label:token` or a bare token. **When unset, the server is open to anyone who can reach it.** | _(unset - auth disabled)_ |

The four numeric knobs above fail loudly at startup on a malformed value: anything that is not
a plain integer, or is below its listed minimum, raises a startup error naming the variable and
the value it got, rather than silently falling back to some other behavior (an unparseable rate
limit silently disabling rate limiting, for example).

This server has no spend-limit or audit-log configuration of its own: it holds no key material
for any family, so it has nothing left to limit. Every spend limit, and the audit log recording
it, lives in your local signer instead - see `VECTOR_SIGNER_SPEND_LIMIT_PER_TX` /
`VECTOR_SIGNER_SPEND_LIMIT_DAILY` / `VECTOR_SIGNER_AUDIT_LOG_PATH` in
[`packages/signer/README.md`](packages/signer/README.md#configuration).

> **Running a public instance?** Set `MCP_AUTH_TOKENS` to gate access to known callers, each
> with its own rate-limit budget. Note that the server answers any-origin CORS by design: with
> auth unset, any web page a browser user visits can drive your instance from JavaScript,
> sharing that user's per-IP rate-limit bucket - one more reason a public instance should set
> `MCP_AUTH_TOKENS`. With `MCP_AUTH_TOKENS` unset, callers are admitted
> anonymously with per-client-IP rate limits; the deployment's reverse proxy supplies the
> client address via the rightmost X-Forwarded-For entry. Tracked identities are capped (LRU);
> eviction resets a bucket's budget - a memory bound, not a security boundary, since an
> attacker rotating enough source IPs can still defeat per-IP limiting at a tier only the
> reverse proxy or network layer can police. `/mcp` sessions get the same per-identity
> treatment: idle sessions are reaped (`VECTOR_MCP_SESSION_IDLE_MS`, swept every
> `VECTOR_MCP_SESSION_SWEEP_MS`), and concurrent sessions per identity are capped
> (`VECTOR_MCP_MAX_SESSIONS_PER_IDENTITY`) - see the Configuration table above for defaults and
> minimums.

> **Malformed values fail loudly.** The server refuses to start if
> `MCP_AUTH_TOKENS` contains an empty token, a token with embedded whitespace, a
> duplicate token, or a value where every comma-separated entry is blank (e.g. a
> stray `,,,`). Each case raises a startup error that names the problem but never
> echoes a token value. Commas delimit entries and cannot be escaped, so generate
> tokens from a comma-free charset (hex / base64url / alphanumeric).

> **Error responses do not echo configured endpoints.** This covers every failure
> mode a network call can produce, not just an HTTP-level rejection: a DNS
> failure, a dropped connection, and a malformed (non-JSON) response body are all
> sanitised the same way an ordinary `4xx`/`5xx` status is - the underlying HTTP
> client is the platform's native `fetch`, chosen in part because its own errors
> do not embed the request URL the way some polyfills do. A failed Ogmios or
> Koios query is this server's own infrastructure problem, not something the
> caller can act on - it is reported by service name and status only, for
> example "Ogmios request failed (queryLedgerState/utxo): 503 Service
> Unavailable" or, for a connection failure, "...: network error". A rejected
> transaction submission is different: the ledger's verdict on the CALLER'S OWN
> transaction (a bad input, an unmet script condition, a fee too small) stays in
> the response, since it is the feedback loop an agent needs to self-correct after
> build → sign → submit - only URL-shaped content is scrubbed out of it first, for
> example "Transaction submission rejected (400 Bad Request):
> ValueNotConservedUTxO...". A NETWORK failure to even reach the submit API is
> reported as an infrastructure failure instead ("...: network error"), never
> worded as a ledger rejection, since nothing looked at the transaction at all.
> Neither case ever echoes the configured `VECTOR_OGMIOS_URL` / `VECTOR_KOIOS_URL`
> / `VECTOR_SUBMIT_URL` value itself, and full unscrubbed detail always goes to
> the server's own `console.error` log for operators. **Known limit:** the
> submission-rejection scrub removes http(s) URLs and the three endpoints above
> by name - a rejection body that happens to name some other internal hostname
> passes through unscrubbed, bounded by a 2000-character cap.

### Mainnet endpoints

| Variable | Mainnet value |
|----------|---------------|
| `VECTOR_OGMIOS_URL` | `https://ogmios.vector.mainnet.apexfusion.org` |
| `VECTOR_SUBMIT_URL` | `https://submit.vector.mainnet.apexfusion.org/api/submit/tx` |
| `VECTOR_KOIOS_URL` | `https://v2.koios.vector.mainnet.apexfusion.org/` |
| `VECTOR_EXPLORER_URL` | `https://vector.apexscan.org/en/` |

## Testing

```bash
npm run test:unit
```

No wallet, no network - pure logic only (CBOR encode/decode assertions).

```bash
npm run test:smoke
```

Builds the server, boots it, and asserts the exposed tool inventory matches the checked-in snapshot. No wallet, no external network. CI runs this and `test:unit` on every PR.

```bash
echo "your mnemonic words here" > packages/builder/mnemonic.txt
npm run test:integration
```

Requires `mnemonic.txt` in `packages/builder/` containing a **funded Vector testnet** mnemonic. Covers the core tools end-to-end against Vector testnet, including the full agent lifecycle: register, discover, profile, update, transfer, message, and deregister (all keyless now: build → sign → submit → await per step). Also runs `keyless-build.test.ts`, `registry-keyless.test.ts`, and `self-improvement-keyless.test.ts` - tier-1 suites needing no mnemonic at all, each building unsigned transactions against live public data only (`vector_build_send_tokens` is covered offline, by unit tests and the legacy suite above; `self-improvement-keyless.test.ts` covers critique, endorse, and proposal-lock builds, plus a not-found rejection path on proposal-spend). Set `VECTOR_E2E_SUBMIT=1` to additionally run each family's gated end-to-end suite, fully on-chain: `keyless-e2e.test.ts` lands one real self-send (~0.16 AP3X fee); `registry-e2e.test.ts` runs a full register → update → deregister agent lifecycle (the 10 AP3X deposit round-tripped exactly, fees only as net cost); `self-improvement-e2e.test.ts` locks and spends a real improvement proposal through the deployed module validator, then critiques and endorses it (≈48 AP3X in stakes and module minimums, plus six transaction fees, one-way - the stakes are locked by the module's own design, not lost). Set `LEGACY_FULL=1` to additionally exercise the same self-improvement lock → spend sequence inside `run.test.ts` itself (off by default, since `self-improvement-e2e.test.ts` already proves that exact path). Never runs in CI.

```bash
npm run test:smoke:signer
```

Builds the local signer (`packages/signer`), boots it over stdio, and exercises all four of
its tools, including the fail-closed audit-write-failure path. No wallet, no network. CI runs
this on every PR alongside the two smoke tests above.

```bash
export VECTOR_SIGNER_MNEMONIC_FILE=/absolute/path/to/testnet-mnemonic.txt
npm run test:integration:signer
```

Requires a **funded Vector testnet** wallet. Builds a real unsigned transaction the way the
hosted builder does (no key), then has the local signer decode, policy-check, and sign it
against live chain data. **Never submits.** Never runs in CI. See
[`packages/signer/README.md`](packages/signer/README.md#testing).

## Architecture

```
┌──────────────────────┐             ┌──────────────────────────┐
│  Claude / GPT / etc. │◄───────────►│  vector-mcp-server       │
│  (any MCP client)    │    /mcp     │                          │
└──────────────────────┘             │  ┌────────────────────┐  │
                                     │  │ Rate Limiter        │  │
                                     │  │ (60 calls/min)      │  │
                                     │  └────────┬───────────┘  │
                                     │           │               │
                                     │  ┌────────▼───────────┐  │
                                     │  │ Lucid + Ogmios     │  │
                                     │  │ Provider            │  │
                                     │  └────────┬───────────┘  │
                                     │           │               │
                                     │  ┌────────▼───────────┐  │
                                     │  │ Ogmios / Koios /   │  │
                                     │  │ Submit API          │  │
                                     │  └────────────────────┘  │
                                     └──────────────────────────┘
```

No safety layer sits between the rate limiter and the provider: this server holds no key
material for any family, so it has no spend limits of its own left to enforce. Every spend
limit lives in your local signer instead.

## About Vector

Vector is Apex Fusion's eUTXO L2, running Cardano mainnet parameters (Conway era, Plutus V3). Sub-1-second optimistic finality and deterministic fees make it a natural chain for AI agent workloads. Mainnet is live.

- **Docs:** https://apex-fusion.github.io/vector-ai-documentation/
- **Explorer (mainnet):** https://vector.apexscan.org/en/
- **Explorer (testnet):** https://vector.testnet.apexscan.org
- **Apex Fusion:** https://apexfusion.org
