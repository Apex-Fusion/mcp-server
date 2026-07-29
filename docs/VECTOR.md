# Vector MCP Server — Tool Reference

## Overview

The Vector MCP Server exposes blockchain tools that AI agents can use to interact with the Vector network. All tools use the `vector_` prefix and communicate with Vector via Ogmios (chain queries) and the submit API (transaction submission).

## Prerequisites

1. A Vector wallet address (source of funds) — the tools below are keyless and take no mnemonic; signing happens separately via your local signer
2. Access to Vector network endpoints (Ogmios, submit API, Koios)
3. Node.js >= 14.0.0

## Tools

### vector_get_balance

Get ADA and token balances for any Vector address.

**Parameters:**
- `address` (string, required) — Vector address to check (addr1...)

**Example prompt:** "What's the balance of addr1qx..."

### vector_get_utxos

List unspent transaction outputs for an address.

**Parameters:**
- `address` (string, required) — Address to query (addr1...)

**Example prompt:** "Show me the UTxOs at addr1qx..."

### vector_build_send_apex

Build an unsigned transaction sending AP3X to a recipient (keyless — takes no key material). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — Your wallet address; source of funds and change (addr1...)
- `recipientAddress` (string, required) — Recipient address (addr1...)
- `amount` (number, required) — Amount of AP3X to send (minimum 1)
- `metadata` (string, optional) — Transaction metadata in JSON format

**Example prompt:** "Send 5 AP3X to addr1qy..."

### vector_build_send_tokens

Build an unsigned transaction sending Vector native tokens (keyless — takes no key material). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — Your wallet address; source of funds and change (addr1...)
- `recipientAddress` (string, required) — Recipient address (addr1...)
- `policyId` (string, required) — Token policy ID
- `assetName` (string, required) — Asset name (can be empty)
- `amount` (string, required) — Amount of tokens to send
- `adaAmount` (number, optional) — AP3X to include with tokens

**Example prompt:** "Send 100 of token with policy abc123... to addr1qy..."

### vector_build_transaction

Build an unsigned multi-output transaction with metadata (keyless, never submits). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — Your wallet address; source of funds and change (addr1...)
- `outputs` (array, required) — Array of `{ address, lovelace, assets? }` objects
- `metadata` (string, optional) — JSON metadata (attached under label 674)

**Example prompt:** "Build a transaction sending 5 AP3X to addr1qx... and 3 AP3X to addr1qy..."

### vector_dry_run

Simulate a transaction without submitting — returns fee estimate and validation (keyless).

**Parameters:**
- `txCbor` (string, optional) — Hex CBOR of a built transaction to evaluate
- `outputs` (array, optional) — If no txCbor, build a TX from these outputs and evaluate
- `changeAddress` (string, optional) — Your wallet address; required when building from outputs
- `metadata` (string, optional) — JSON metadata when building from outputs

**Example prompt:** "How much would it cost to send 10 AP3X to addr1qx...?"

### vector_get_transaction_history

Get transaction history for an address via Koios indexed queries.

**Parameters:**
- `address` (string, required) — Address to query (addr1...)
- `limit` (number, optional) — Number of transactions (default: 20, max: 50)
- `offset` (number, optional) — Pagination offset (default: 0)

**Example prompt:** "Show me recent transactions for addr1qx..."

### vector_build_deploy_contract

Build an unsigned transaction deploying a Plutus/Aiken smart contract by locking funds at its script address (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — Your wallet address; source of funds and change (addr1...)
- `scriptCbor` (string, required) — Compiled script CBOR hex
- `scriptType` (string, required) — "PlutusV1", "PlutusV2", or "PlutusV3"
- `initialDatum` (string, optional) — Datum CBOR hex (default: void `d87980`)
- `lovelaceAmount` (number, optional) — AP3X to lock in lovelace (default: 2 AP3X)

**Example prompt:** "Deploy this smart contract with 5 AP3X locked"

### vector_build_interact_contract

Build an unsigned transaction interacting with a deployed smart contract — lock funds or spend from it (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — Your wallet address; source of funds, change, and the required signer for spends (addr1...)
- `scriptCbor` (string, required) — Compiled script CBOR hex
- `scriptType` (string, required) — "PlutusV1", "PlutusV2", or "PlutusV3"
- `action` (string, required) — "spend" or "lock"
- `redeemer` (string, optional) — Redeemer CBOR hex (for spend, default: void)
- `datum` (string, optional) — Datum CBOR hex (for lock, default: void)
- `lovelaceAmount` (number, optional) — Lovelace to lock (for lock)
- `utxoRef` (object, optional) — `{ txHash, outputIndex }` for specific UTxO (for spend)
- `assets` (object, optional) — Native assets for lock: `{ "unit": "quantity" }`

**Example prompt:** "Collect funds from the escrow contract at addr1..."

### vector_build_register_agent

Build an unsigned transaction that registers an agent in the Vector on-chain registry — mints a soulbound identity NFT and locks a 10 AP3X deposit (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — Your wallet address; source of the deposit and change (addr1...)
- `name` (string, required) — Agent name (max 64 chars)
- `description` (string, required) — Short description of the agent's purpose (max 256 chars)
- `capabilities` (array of strings, required) — Capability tags (e.g. `["investing", "research"]`)
- `framework` (string, required) — Framework used (e.g. "OpenClaw", "LangChain", "CrewAI", "custom")
- `endpoint` (string, required) — A2A communication endpoint URL (or empty string if not applicable)

**Example prompt:** "Register an agent named TradingBot with investing and research capabilities"

### vector_build_update_agent

Build an unsigned transaction that updates a registered agent's profile fields — only the specified fields change, the rest are preserved (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — The agent owner's wallet address (addr1...)
- `agent_id` (string, required) — Agent DID to update: `did:vector:agent:{policyId}:{nftAssetName}`
- `name` (string, optional) — New agent name
- `description` (string, optional) — New description
- `capabilities` (array of strings, optional) — New capability tags (replaces the existing list)
- `framework` (string, optional) — New framework identifier
- `endpoint` (string, optional) — New A2A endpoint URL (or empty string to clear)

**Example prompt:** "Update my agent's description to mention DeFi support"

### vector_build_transfer_agent

Build an unsigned transaction that transfers agent ownership to a new address (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — The CURRENT owner's wallet address (addr1...)
- `agent_id` (string, required) — Agent DID to transfer: `did:vector:agent:{policyId}:{nftAssetName}`
- `new_owner_address` (string, required) — Bech32 address of the new owner (must be a verification-key address, not a script address)

**Example prompt:** "Transfer my agent to addr1qy..."

### vector_build_deregister_agent

Build an unsigned transaction that deregisters an agent — burns the identity NFT and returns the 10 AP3X deposit to the owner wallet (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — The agent owner's wallet address; receives the returned deposit (addr1...)
- `agent_id` (string, required) — Agent DID to deregister: `did:vector:agent:{policyId}:{nftAssetName}`

**Example prompt:** "Deregister my agent and reclaim the deposit"

### vector_build_message_agent

Build an unsigned transaction that sends an on-chain message to a registered agent via TX metadata (label 674), delivering 2 AP3X to the agent's owner address (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) — Your wallet address; pays the 2 AP3X delivery and fee (addr1...)
- `agent_id` (string, required) — Recipient agent DID: `did:vector:agent:{policyId}:{nftAssetName}`
- `message_type` (string, required) — Type of message: "inquiry", "proposal", or "result"
- `payload` (string, required) — Message payload (max 512 chars)

**Example prompt:** "Send an inquiry message to did:vector:agent:... asking about pricing"

## Safety Controls

The tools above are keyless and take no key material, so the server no longer enforces
spend limits on them. Spend policy is enforced by your **local signer** when it signs the
CBOR these tools return — see the security notice in the repo [README](../README.md) and
[docs/architecture/non-custodial-split.md](architecture/non-custodial-split.md).

`VECTOR_SPEND_LIMIT_PER_TX` / `VECTOR_SPEND_LIMIT_DAILY` / `VECTOR_AUDIT_LOG_PATH` still
govern the server's one remaining custodial tool family (self-improvement) until its own
keyless migration lands.

## Network Endpoints

| Service | URL | Protocol |
|---------|-----|----------|
| Ogmios | ogmios.vector.testnet.apexfusion.org | HTTP JSON-RPC + WebSocket |
| Submit API | submit.vector.testnet.apexfusion.org/api/submit/tx | HTTP POST (CBOR) |
| Koios | koios.vector.testnet.apexfusion.org | REST API |
| Explorer | vector.testnet.apexscan.org | Web UI |

## Error Handling

All tools return helpful error messages with troubleshooting tips. Common issues:

- **Insufficient balance** — Ensure the wallet at `changeAddress` has enough AP3X for the transaction + fees
- **Connection failed** — Verify Ogmios endpoint is reachable
- **Invalid address** — Vector addresses start with `addr1`
