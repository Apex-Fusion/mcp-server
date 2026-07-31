# Vector MCP Server

MCP (Model Context Protocol) server for **Vector** - the Apex Fusion eUTXO L2. Enables AI agents (Claude, GPT, Gemini, or any MCP client) to interact with Vector natively: query balances, send transactions, deploy and interact with smart contracts, manage on-chain agent identities, and submit protocol improvement proposals.

Built on [Ogmios](https://ogmios.dev/) + [Koios](https://www.koios.rest/) - no Blockfrost dependency.

**Vector mainnet is live.** Full guides: [Vector AI documentation](https://apex-fusion.github.io/vector-ai-documentation/).

## Hosted servers - no install

Hosted instances run on both networks, exposing all 23 tools:

| Network | Endpoint |
|---------|----------|
| Mainnet | `https://mcp.vector.mainnet.apexfusion.org/sse` |
| Testnet | `https://mcp.vector.testnet.apexfusion.org/sse` |

Connect from Claude Code in one command:

```bash
claude mcp add --transport sse vector-mcp https://mcp.vector.mainnet.apexfusion.org/sse
```

> **Security notice — custody.** The wallet, transaction, smart-contract, and agent-registry
> tools are now **keyless**: `build_*` tools construct unsigned transactions from a wallet
> *address* and never accept a mnemonic. Sign the returned CBOR with the local signer companion
> and broadcast it with `vector_submit_transaction` — your seed phrase never leaves your machine.
> **The Self-Improvement Module (5 tools) is the only family still taking a mnemonic as a
> tool-call parameter** (its keyless migration is next — see the architecture doc). For those
> tools the mnemonic passes through your MCP client, your model provider, and the hosted
> server's memory: use only a hot wallet holding funds you can afford to lose, and prefer
> self-hosting until the migration completes.
> See [docs/architecture/non-custodial-split.md](docs/architecture/non-custodial-split.md).

Self-hosting instructions are below.

## Local signer (non-custodial path)

`packages/signer` is a local MCP server that holds your key and signs transactions locally
instead of handing your mnemonic to a shared host. It has **no network access at all** —
stdio transport, no Provider, no egress — so a key given to it never reaches a shared server
or your model provider. Four tools: `vector_signer_get_address`, `vector_signer_decode_transaction`,
`vector_signer_sign`, `vector_signer_get_spend_limits`.

**Paired with this hosted builder, the full non-custodial flow is live today** for the wallet,
transaction, smart-contract, and agent-registry family: `vector_signer_get_address` →
`build_*` → `vector_signer_sign` → `vector_submit_transaction` → `vector_await_transaction`. No
step in that chain puts a mnemonic in front of this server or your model provider. The
build → submit → await half is E2E-proven on Vector testnet for both: a payment self-send, and
a full register → update → deregister agent lifecycle with the 10 AP3X deposit round-tripped
exactly; see [`packages/signer/README.md`](packages/signer/README.md#known-limitations) for
exactly what that testing does and does not exercise on the signer's side. **The
Self-Improvement Module is not part of that pairing yet** — its 5 tools still take a mnemonic
as a tool-call parameter until their own keyless migration lands (see the security notice above
and [docs/architecture/non-custodial-split.md](docs/architecture/non-custodial-split.md)).

See [`packages/signer/README.md`](packages/signer/README.md) for configuration, tools, and known
limitations.

## Features

- **Wallet & queries** - balances, UTxOs, and transaction history for any address (no key material)
- **Keyless transaction building** - build unsigned AP3X/token/multi-output transactions and contract interactions; sign locally, broadcast via submit
- **Smart contracts** - deploy Plutus/Aiken validators, lock and spend UTxOs at script addresses
- **Agent registry** - register, discover, update, transfer, and deregister on-chain AI agent identities via soulbound NFTs (keyless - build, sign locally, broadcast)
- **Agent messaging** - send on-chain messages between agents via TX metadata (keyless)
- **Self-Improvement Module** - browse, submit, critique, and endorse improvement proposals (live on Vector mainnet)
- **Safety controls** - per-identity rate limiting; spend limits for the keyless families (wallet/tx/contract, agent registry) are enforced by the local signer (the Self-Improvement Module keeps server-side limits until its keyless migration)
- **SSE transport** - HTTP server with Server-Sent Events for MCP client connectivity

## MCP Tools (23)

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
| `vector_self_improvement_submit_proposal` | Submit an improvement proposal (stakes AP3X) |
| `vector_self_improvement_critique` | Critique a proposal - support, oppose, or propose amendments |
| `vector_self_improvement_endorse` | Endorse a proposal by staking AP3X |
| `vector_self_improvement_analyze_metrics` | Proposal metrics: activity, adoption rate, treasury health, engagement |

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

The wallet/tx/contract and agent-registry families are keyless: `build_*` tools take a wallet
address, never a mnemonic. The Self-Improvement Module still takes a per-call mnemonic until
its keyless migration lands — see the security notice above.

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
| `VECTOR_SPEND_LIMIT_PER_TX` | Max lovelace per transaction | `100000000` (100 AP3X) |
| `VECTOR_SPEND_LIMIT_DAILY` | Max lovelace per day | `500000000` (500 AP3X) |
| `VECTOR_AUDIT_LOG_PATH` | Persistent audit log file path | `./vector-audit-log.json` |
| `VECTOR_RATE_LIMIT_PER_MINUTE` | Max tool calls per minute | `60` |
| `MCP_AUTH_TOKENS` | Bearer tokens that may call this server. Comma-separated; each entry is `label:token` or a bare token. **When unset, the server is open to anyone who can reach it.** | _(unset — auth disabled)_ |

`VECTOR_SPEND_LIMIT_PER_TX` / `VECTOR_SPEND_LIMIT_DAILY` govern only the still-custodial
Self-Improvement family — the keyless `build_*` families (wallet/tx/contract, agent registry)
ignore them; their spend limits are enforced by the local signer instead.

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

Requires `mnemonic.txt` in `packages/builder/` containing a **funded Vector testnet** mnemonic. Covers the core tools end-to-end against Vector testnet, including the full agent lifecycle: register, discover, profile, update, transfer, message, and deregister (all keyless now: build → sign → submit → await per step). Also runs `keyless-build.test.ts` and `registry-keyless.test.ts`, which need no mnemonic at all - they build unsigned transactions (four of the five wallet/tx `build_*` tools, and the registry's register + message builds, plus a non-owner rejection path on update) against live public data only (`vector_build_send_tokens` is covered offline, by unit tests and the legacy suite above, not by either live suite). The full registry lifecycle (register → update → deregister) is exercised by the gated E2E suite. Set `VECTOR_E2E_SUBMIT=1` to additionally run the full non-custodial pipeline end-to-end, on-chain: `keyless-e2e.test.ts` lands one real self-send (~0.16 AP3X fee), and `registry-e2e.test.ts` runs a full register → update → deregister agent lifecycle (the 10 AP3X deposit round-tripped exactly, fees only as net cost). Never runs in CI.

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
                              │  │ Safety Layer *      │  │
                              │  │ - Per-tx limits     │  │
                              │  │ - Daily limits      │  │
                              │  │ - Audit log         │  │
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

\* The still-custodial Self-Improvement family only — the keyless `build_*` path (wallet/tx/
contract, agent registry) never reaches the Safety Layer; its spend limits are enforced by the
local signer instead.

## About Vector

Vector is Apex Fusion's eUTXO L2, running Cardano mainnet parameters (Conway era, Plutus V3). Sub-1-second optimistic finality and deterministic fees make it a natural chain for AI agent workloads. Mainnet is live.

- **Docs:** https://apex-fusion.github.io/vector-ai-documentation/
- **Explorer (mainnet):** https://vector.apexscan.org/en/
- **Explorer (testnet):** https://vector.testnet.apexscan.org
- **Apex Fusion:** https://apexfusion.org
