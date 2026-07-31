# Vector MCP Server

MCP (Model Context Protocol) server for **Vector** - the Apex Fusion eUTXO L2. Enables AI agents (Claude, GPT, Gemini, or any MCP client) to interact with Vector natively: query balances, send transactions, deploy and interact with smart contracts, manage on-chain agent identities, and submit protocol improvement proposals.

Built on [Ogmios](https://ogmios.dev/) + [Koios](https://www.koios.rest/) - no Blockfrost dependency.

**Vector mainnet is live.** Full guides: [Vector AI documentation](https://apex-fusion.github.io/vector-ai-documentation/).

## Hosted servers - no install

Hosted instances run on both networks, exposing all 24 tools:

| Network | Endpoint |
|---------|----------|
| Mainnet | `https://mcp.vector.mainnet.apexfusion.org/sse` |
| Testnet | `https://mcp.vector.testnet.apexfusion.org/sse` |

> **Deployment status: both networks are current.** Both hosted instances run today's
> completed migration: testnet since the 2026-07-31 morning merges (auto-deployed from
> `main`), mainnet since a deliberate cutover deploy the same day (see
> [docs/architecture/non-custodial-split.md](docs/architecture/non-custodial-split.md), section
> 11, "Rollout", for the full history). **Both hosted instances currently require a bearer
> token from the operators to connect** - that is an access control, not a custody one:
> neither instance accepts a mnemonic from any caller, token or not. Open public access
> (per-IP rate limiting, no token required) is a planned follow-up, not yet shipped. Self-host
> this release for tokenless access today.

Connect from Claude Code in one command. Both hosted instances require a bearer token from the
operators (contact the Apex Fusion team for one):

```bash
claude mcp add --transport sse vector-mcp https://mcp.vector.mainnet.apexfusion.org/sse \
  --header "Authorization: Bearer <your-token>"
```

Self-hosting (below) needs no token and gives every caller open access to your own instance.

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
instead of handing your mnemonic to a shared host. It has **no network access at all** —
stdio transport, no Provider, no egress — so a key given to it never reaches a shared server
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
- **Safety controls** - per-identity rate limiting; spend limits for every family are enforced by the local signer, per user - the server holds no spend-limit state of its own
- **SSE transport** - HTTP server with Server-Sent Events for MCP client connectivity

## MCP Tools (24)

### Wallet & Queries

| Tool | Description |
|------|-------------|
| `vector_get_balance` | Get AP3X and token balances for any address |
| `vector_get_utxos` | List UTxOs for an address |
| `vector_get_transaction_history` | Get transaction history for an address |

### Transactions

| Tool | Description |
|------|-------------|
| `vector_build_send_apex` | Build an unsigned AP3X payment (keyless — sign with the local signer) |
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

Agent DIDs follow the format: `did:vector:agent:{policyId}:{nftAssetName}`

Example non-custodial flow for a registry op: `vector_build_register_agent` →
`vector_signer_sign` → `vector_submit_transaction` → `vector_await_transaction`.

## Self-hosting

### 1. Install and build

```bash
npm install
npm run build
```

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
| `VECTOR_RATE_LIMIT_PER_MINUTE` | Max tool calls per minute | `60` |
| `MCP_AUTH_TOKENS` | Bearer tokens that may call this server. Comma-separated; each entry is `label:token` or a bare token. **When unset, the server is open to anyone who can reach it.** | _(unset — auth disabled)_ |

This server has no spend-limit or audit-log configuration of its own: it holds no key material
for any family, so it has nothing left to limit. Every spend limit, and the audit log recording
it, lives in your local signer instead - see `VECTOR_SIGNER_SPEND_LIMIT_PER_TX` /
`VECTOR_SIGNER_SPEND_LIMIT_DAILY` / `VECTOR_SIGNER_AUDIT_LOG_PATH` in
[`packages/signer/README.md`](packages/signer/README.md#configuration).

> **Running a public instance?** Set `MCP_AUTH_TOKENS`. Without it every caller
> is treated as one anonymous identity and shares a single rate-limit bucket, so
> one busy client throttles everyone. Rate limits are applied per identity, so
> give each client its own token.

> **Malformed values fail loudly, not silently.** The server refuses to start if
> `MCP_AUTH_TOKENS` contains an empty token, a token with embedded whitespace, a
> duplicate token, or a value where every comma-separated entry is blank (e.g. a
> stray `,,,`) — each raises a startup error that names the problem but never
> echoes a token value. Commas delimit entries and cannot be escaped, so generate
> tokens from a comma-free charset (hex / base64url / alphanumeric).

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

No wallet, no network — pure logic only (CBOR encode/decode assertions).

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
┌──────────────────────┐      ┌──────────────────────────┐
│  Claude / GPT / etc. │◄────►│  vector-mcp-server       │
│  (any MCP client)    │ SSE  │                          │
└──────────────────────┘      │  ┌────────────────────┐  │
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
