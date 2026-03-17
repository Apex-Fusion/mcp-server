# Vector MCP Server — Tool Reference

## Overview

The Vector MCP Server exposes blockchain tools that AI agents can use to interact with the Vector network. All tools use the `vector_` prefix and communicate with Vector via Ogmios (chain queries) and the submit API (transaction submission).

## Prerequisites

1. A funded Vector wallet (15 or 24-word mnemonic)
2. Access to Vector network endpoints (Ogmios, submit API, Koios)
3. Node.js >= 14.0.0

## Tools

### vector_get_balance

Get ADA and token balances for any Vector address.

**Parameters:**
- `address` (string, required) — Vector address to check (addr1...)

**Example prompt:** "What's the balance of addr1qx..."

### vector_get_address

Get the agent's own wallet address, balance, and token holdings.

**Parameters:** None

**Example prompt:** "What's my wallet address and balance?"

### vector_get_utxos

List unspent transaction outputs for an address or the agent's wallet.

**Parameters:**
- `address` (string, optional) — Address to query. Uses agent's wallet if omitted.

**Example prompt:** "Show me the UTxOs in my wallet"

### vector_send_ada

Send ADA from the agent's wallet to a recipient. Enforces spend limits.

**Parameters:**
- `recipientAddress` (string, required) — Recipient address (addr1...)
- `amount` (number, required) — Amount of ADA to send (minimum 1)
- `metadata` (string, optional) — Transaction metadata in JSON format

**Example prompt:** "Send 5 ADA to addr1qy..."

### vector_send_tokens

Send Vector native tokens from the agent's wallet.

**Parameters:**
- `recipientAddress` (string, required) — Recipient address (addr1...)
- `policyId` (string, required) — Token policy ID
- `assetName` (string, required) — Asset name (can be empty)
- `amount` (string, required) — Amount of tokens to send
- `adaAmount` (number, optional) — ADA to include with tokens

**Example prompt:** "Send 100 of token with policy abc123... to addr1qy..."

### vector_get_spend_limits

Check current spend limits, daily usage, and recent transaction audit log.

**Parameters:** None

**Example prompt:** "What are my current spend limits?"

### vector_build_transaction

Build a complex multi-output transaction with metadata. Optionally sign and submit.

**Parameters:**
- `outputs` (array, required) — Array of `{ address, lovelace, assets? }` objects
- `metadata` (string, optional) — JSON metadata (attached under label 674)
- `submit` (boolean, optional) — If true, sign and submit. If false/omitted, return unsigned CBOR.

**Example prompt:** "Build a transaction sending 5 ADA to addr1qx... and 3 ADA to addr1qy..."

### vector_dry_run

Simulate a transaction without submitting — returns fee estimate and validation.

**Parameters:**
- `txCbor` (string, optional) — Hex CBOR of a built transaction to evaluate
- `outputs` (array, optional) — If no txCbor, build a TX from these outputs and evaluate
- `metadata` (string, optional) — JSON metadata when building from outputs

**Example prompt:** "How much would it cost to send 10 ADA to addr1qx...?"

### vector_get_transaction_history

Get transaction history for an address via Koios indexed queries.

**Parameters:**
- `address` (string, optional) — Address to query. Uses agent's wallet if omitted.
- `limit` (number, optional) — Number of transactions (default: 20, max: 50)
- `offset` (number, optional) — Pagination offset (default: 0)

**Example prompt:** "Show me my recent transactions"

### vector_deploy_contract

Deploy a Plutus/Aiken smart contract by locking funds at its script address.

**Parameters:**
- `scriptCbor` (string, required) — Compiled script CBOR hex
- `scriptType` (string, required) — "PlutusV1", "PlutusV2", or "PlutusV3"
- `initialDatum` (string, optional) — Datum CBOR hex (default: void `d87980`)
- `lovelaceAmount` (number, optional) — ADA to lock in lovelace (default: 2 ADA)

**Example prompt:** "Deploy this smart contract with 5 ADA locked"

### vector_interact_contract

Interact with a deployed smart contract — lock funds or spend from it.

**Parameters:**
- `scriptCbor` (string, required) — Compiled script CBOR hex
- `scriptType` (string, required) — "PlutusV1", "PlutusV2", or "PlutusV3"
- `action` (string, required) — "spend" or "lock"
- `redeemer` (string, optional) — Redeemer CBOR hex (for spend, default: void)
- `datum` (string, optional) — Datum CBOR hex (for lock, default: void)
- `lovelaceAmount` (number, optional) — ADA to lock in lovelace (for lock)
- `utxoRef` (object, optional) — `{ txHash, outputIndex }` for specific UTxO (for spend)
- `assets` (object, optional) — Native assets for lock: `{ "unit": "quantity" }`

**Example prompt:** "Collect funds from the escrow contract at addr1..."

## Safety Controls

The server enforces configurable spend limits:

- **Per-transaction limit** — Maximum ADA per single transaction (default: 100 ADA)
- **Daily limit** — Maximum ADA per 24-hour period (default: 500 ADA)
- **Audit log** — All transactions are logged with timestamp, amount, and recipient
- **Persistent audit log** — Audit log is written to a JSON file that survives server restarts. Daily spend is recalculated from the log on startup.

Limits are configured via environment variables:
```
VECTOR_SPEND_LIMIT_PER_TX=100000000   # 100 ADA in lovelace
VECTOR_SPEND_LIMIT_DAILY=500000000    # 500 ADA in lovelace
VECTOR_AUDIT_LOG_PATH=./vector-audit-log.json  # Audit log file path
```

## Network Endpoints

| Service | URL | Protocol |
|---------|-----|----------|
| Ogmios | ogmios.vector.testnet.apexfusion.org | HTTP JSON-RPC + WebSocket |
| Submit API | submit.vector.testnet.apexfusion.org/api/submit/tx | HTTP POST (CBOR) |
| Koios | koios.vector.testnet.apexfusion.org | REST API |
| Explorer | vector.testnet.apexscan.org | Web UI |

## Error Handling

All tools return helpful error messages with troubleshooting tips. Common issues:

- **Invalid mnemonic** — Check VECTOR_MNEMONIC has exactly 15 or 24 words
- **Insufficient balance** — Ensure wallet has enough ADA for the transaction + fees
- **Spend limit exceeded** — Check limits with `vector_get_spend_limits`
- **Connection failed** — Verify Ogmios endpoint is reachable
- **Invalid address** — Vector addresses start with `addr1`
