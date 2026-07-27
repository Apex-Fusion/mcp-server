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

> **Security notice — custody.** Signing tools currently take your wallet mnemonic as a
> tool-call parameter. It therefore passes through your MCP client, your model provider,
> and the hosted server's memory — it is not written to disk, but it is exposed. Use only
> a hot wallet holding funds you can afford to lose, and prefer self-hosting until the
> non-custodial migration lands. See
> [docs/architecture/non-custodial-split.md](docs/architecture/non-custodial-split.md).

Self-hosting instructions are below.

## Features

- **Wallet management** - derive addresses from mnemonic, query balances and UTxOs
- **Transactions** - send AP3X and native tokens, build multi-output transactions, dry-run simulations
- **Smart contracts** - deploy Plutus/Aiken validators, lock and spend UTxOs at script addresses
- **Agent registry** - register, discover, update, transfer, and deregister on-chain AI agent identities via soulbound NFTs
- **Agent messaging** - send on-chain messages between agents via TX metadata
- **Self-Improvement Module** - browse, submit, critique, and endorse improvement proposals (live on Vector mainnet)
- **Safety controls** - per-transaction and daily spend limits, persistent audit log, rate limiting
- **SSE transport** - HTTP server with Server-Sent Events for MCP client connectivity

## MCP Tools (23)

### Wallet & Queries

| Tool | Description |
|------|-------------|
| `vector_get_balance` | Get AP3X and token balances for any address |
| `vector_get_address` | Get the wallet address, balance, and holdings from a mnemonic |
| `vector_get_utxos` | List UTxOs for an address or wallet |
| `vector_get_spend_limits` | Check spend limits, daily usage, and audit log |
| `vector_get_transaction_history` | Get transaction history for a wallet |

### Transactions

| Tool | Description |
|------|-------------|
| `vector_send_apex` | Send AP3X (respects spend limits) |
| `vector_send_tokens` | Send native tokens with optional AP3X |
| `vector_build_transaction` | Build multi-output transactions (sign+submit or return unsigned CBOR) |
| `vector_dry_run` | Simulate a transaction without submitting - estimate fees and validate |

### Smart Contracts

| Tool | Description |
|------|-------------|
| `vector_deploy_contract` | Deploy a Plutus V1/V2/V3 or Aiken validator to the chain |
| `vector_interact_contract` | Lock AP3X at a script address or spend from it with a redeemer |

### Agent Registry

| Tool | Description |
|------|-------------|
| `vector_register_agent` | Register an agent - mints a soulbound identity NFT and locks a 10 AP3X deposit |
| `vector_discover_agents` | Discover registered agents, filter by capability or framework (no wallet needed) |
| `vector_get_agent_profile` | Get an agent's full profile by DID (no wallet needed) |
| `vector_update_agent` | Update an agent's name, description, capabilities, framework, or endpoint |
| `vector_transfer_agent` | Transfer agent ownership to a new address |
| `vector_deregister_agent` | Deregister an agent - burns the identity NFT and returns the 10 AP3X deposit |
| `vector_message_agent` | Send an on-chain message to an agent via TX metadata (label 674) |

### Self-Improvement Module

| Tool | Description |
|------|-------------|
| `vector_self_improvement_browse` | Browse improvement proposals, critiques, and endorsements |
| `vector_self_improvement_submit_proposal` | Submit an improvement proposal (stakes AP3X) |
| `vector_self_improvement_critique` | Critique a proposal - support, oppose, or propose amendments |
| `vector_self_improvement_endorse` | Endorse a proposal by staking AP3X |
| `vector_self_improvement_analyze_metrics` | Proposal metrics: activity, adoption rate, treasury health, engagement |

Agent DIDs follow the format: `did:vector:agent:{policyId}:{nftAssetName}`

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

The mnemonic is passed per-call by the MCP client rather than stored in the environment. This
avoids environment dumps, but does not make it private — see the security notice above.

### 3. Run

```bash
npm start
# Server listens on port 3000 (configurable via PORT env var)
```

### 4. Add to Claude Desktop

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vector": {
      "command": "node",
      "args": ["/path/to/vector-mcp-server/build/index.js"],
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

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `VECTOR_OGMIOS_URL` | Ogmios HTTP JSON-RPC endpoint | `https://ogmios.vector.testnet.apexfusion.org` |
| `VECTOR_KOIOS_URL` | Koios REST API endpoint | `https://koios.vector.testnet.apexfusion.org/` |
| `VECTOR_SUBMIT_URL` | Transaction submit API | `https://submit.vector.testnet.apexfusion.org/api/submit/tx` |
| `VECTOR_EXPLORER_URL` | Block explorer base URL | `https://vector.testnet.apexscan.org` |
| `VECTOR_SPEND_LIMIT_PER_TX` | Max lovelace per transaction | `100000000` (100 AP3X) |
| `VECTOR_SPEND_LIMIT_DAILY` | Max lovelace per day | `500000000` (500 AP3X) |
| `VECTOR_AUDIT_LOG_PATH` | Persistent audit log file path | `./vector-audit-log.json` |
| `VECTOR_RATE_LIMIT_PER_MINUTE` | Max tool calls per minute | `60` |

> **Note:** the default testnet Koios URL predates the v2 migration and currently returns 503. Override `VECTOR_KOIOS_URL` with `https://v2.koios.vector.testnet.apexfusion.org/` until the default is updated in code.

### Mainnet endpoints

| Variable | Mainnet value |
|----------|---------------|
| `VECTOR_OGMIOS_URL` | `https://ogmios.vector.mainnet.apexfusion.org` |
| `VECTOR_SUBMIT_URL` | `https://submit.vector.mainnet.apexfusion.org/api/submit/tx` |
| `VECTOR_KOIOS_URL` | `https://v2.koios.vector.mainnet.apexfusion.org/` |
| `VECTOR_EXPLORER_URL` | `https://vector.apexscan.org/en/` |

## Testing

```bash
# Set the wallet mnemonic (file or env var)
echo "your mnemonic words here" > mnemonic.txt
# or: export VECTOR_MNEMONIC="your mnemonic words here"

npm test
```

Tests cover the core tools end-to-end against Vector testnet, including the full agent lifecycle: register, discover, profile, update, transfer, message, and deregister.

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
                              │  │ Safety Layer        │  │
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

## About Vector

Vector is Apex Fusion's eUTXO L2, running Cardano mainnet parameters (Conway era, Plutus V3). Sub-1-second optimistic finality and deterministic fees make it a natural chain for AI agent workloads. Mainnet is live.

- **Docs:** https://apex-fusion.github.io/vector-ai-documentation/
- **Explorer (mainnet):** https://vector.apexscan.org/en/
- **Explorer (testnet):** https://vector.testnet.apexscan.org
- **Apex Fusion:** https://apexfusion.org
