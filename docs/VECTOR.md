# Vector MCP Server - Tool Reference

## Overview

The Vector MCP Server exposes blockchain tools that AI agents can use to interact with the Vector network. All tools use the `vector_` prefix and communicate with Vector via Ogmios (chain queries) and the submit API (transaction submission).

## Prerequisites

1. A Vector wallet address that holds your AP3X - the tools below are keyless and take no mnemonic; signing happens separately via your local signer
2. Access to Vector network endpoints (Ogmios, submit API, Koios)
3. Node.js >= 14.0.0

## Tools

### vector_get_balance

Get AP3X and token balances for any Vector address.

**Parameters:**
- `address` (string, required) - Vector address to check (addr1...)

**Example prompt:** "What's the balance of addr1qx..."

### vector_get_utxos

List unspent transaction outputs for an address.

**Parameters:**
- `address` (string, required) - Address to query (addr1...)

**Example prompt:** "Show me the UTxOs at addr1qx..."

### vector_build_send_apex

Build an unsigned transaction sending AP3X to a recipient (keyless, takes no key material). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - Your wallet address; holds the AP3X and receives change (addr1...)
- `recipientAddress` (string, required) - Recipient address (addr1...)
- `amount` (number, required) - Amount of AP3X to send (minimum 1)
- `metadata` (string, optional) - Transaction metadata in JSON format

**Example prompt:** "Send 5 AP3X to addr1qy..."

### vector_build_send_tokens

Build an unsigned transaction sending Vector native tokens (keyless, takes no key material). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - Your wallet address; holds the AP3X and receives change (addr1...)
- `recipientAddress` (string, required) - Recipient address (addr1...)
- `policyId` (string, required) - Token policy ID
- `assetName` (string, required) - Asset name (can be empty)
- `amount` (string, required) - Amount of tokens to send
- `adaAmount` (number, optional) - AP3X to include with tokens

**Example prompt:** "Send 100 of token with policy abc123... to addr1qy..."

### vector_build_transaction

Build an unsigned multi-output transaction with metadata (keyless, never submits). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - Your wallet address; holds the AP3X and receives change (addr1...)
- `outputs` (array, required) - Array of `{ address, lovelace, assets? }` objects
- `metadata` (string, optional) - JSON metadata (attached under label 674)

**Example prompt:** "Build a transaction sending 5 AP3X to addr1qx... and 3 AP3X to addr1qy..."

### vector_dry_run

Simulate a transaction without submitting - returns fee estimate and validation (keyless).

**Parameters:**
- `txCbor` (string, optional) - Hex CBOR of a built transaction to evaluate
- `outputs` (array, optional) - If no txCbor, build a TX from these outputs and evaluate
- `changeAddress` (string, optional) - Your wallet address; required when building from outputs
- `metadata` (string, optional) - JSON metadata when building from outputs

**Example prompt:** "How much would it cost to send 10 AP3X to addr1qx...?"

### vector_get_transaction_history

Get transaction history for an address via Koios indexed queries.

**Parameters:**
- `address` (string, required) - Address to query (addr1...)
- `limit` (number, optional) - Number of transactions (default: 20, max: 50)
- `offset` (number, optional) - Pagination offset (default: 0)

**Example prompt:** "Show me recent transactions for addr1qx..."

### vector_build_deploy_contract

Build an unsigned transaction deploying a Plutus/Aiken smart contract by locking AP3X at its script address (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - Your wallet address; holds the AP3X and receives change (addr1...)
- `scriptCbor` (string, required) - Compiled script CBOR hex
- `scriptType` (string, required) - "PlutusV1", "PlutusV2", or "PlutusV3"
- `initialDatum` (string, optional) - Datum CBOR hex (default: void `d87980`)
- `lovelaceAmount` (number, optional) - AP3X to lock in lovelace (default: 2 AP3X)

**Example prompt:** "Deploy this smart contract with 5 AP3X locked"

### vector_build_interact_contract

Build an unsigned transaction interacting with a deployed smart contract: lock AP3X or spend from it (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - Your wallet address; holds the AP3X, receives change, and provides the required signer for spends (addr1...)
- `scriptCbor` (string, required) - Compiled script CBOR hex
- `scriptType` (string, required) - "PlutusV1", "PlutusV2", or "PlutusV3"
- `action` (string, required) - "spend" or "lock"
- `redeemer` (string, optional) - Redeemer CBOR hex (for spend, default: void)
- `datum` (string, optional) - Datum CBOR hex (for lock, default: void)
- `lovelaceAmount` (number, optional) - Lovelace to lock (for lock)
- `utxoRef` (object, optional) - `{ txHash, outputIndex }` for specific UTxO (for spend)
- `assets` (object, optional) - Native assets for lock: `{ "unit": "quantity" }`

**Example prompt:** "Collect the locked AP3X from the escrow contract at addr1..."

### vector_build_register_agent

Build an unsigned transaction that registers an agent in the Vector on-chain registry: mints a soulbound identity NFT and locks a 10 AP3X deposit (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - Your wallet address; source of the deposit and change (addr1...)
- `name` (string, required) - Agent name (max 64 chars)
- `description` (string, required) - Short description of the agent's purpose (max 256 chars)
- `capabilities` (array of strings, required) - Capability tags (e.g. `["research", "data-extraction"]`)
- `framework` (string, required) - Framework used (e.g. "OpenClaw", "LangChain", "CrewAI", "custom")
- `endpoint` (string, required) - A2A communication endpoint URL (or empty string if not applicable)

**Example prompt:** "Register an agent named ResearchAgent with research and data-extraction capabilities"

### vector_build_update_agent

Build an unsigned transaction that updates a registered agent's profile fields: only the specified fields change, the rest are preserved (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - The agent owner's wallet address (addr1...)
- `agent_id` (string, required) - Agent DID to update: `did:vector:agent:{policyId}:{nftAssetName}`
- `name` (string, optional) - New agent name
- `description` (string, optional) - New description
- `capabilities` (array of strings, optional) - New capability tags (replaces the existing list)
- `framework` (string, optional) - New framework identifier
- `endpoint` (string, optional) - New A2A endpoint URL (or empty string to clear)

**Example prompt:** "Update my agent's description to mention archive-extraction support"

### vector_build_transfer_agent

Build an unsigned transaction that transfers agent ownership to a new address (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - The CURRENT owner's wallet address (addr1...)
- `agent_id` (string, required) - Agent DID to transfer: `did:vector:agent:{policyId}:{nftAssetName}`
- `new_owner_address` (string, required) - Bech32 address of the new owner (must be a verification-key address, not a script address)

**Example prompt:** "Transfer my agent to addr1qy..."

### vector_build_deregister_agent

Build an unsigned transaction that deregisters an agent: burns the identity NFT and returns the 10 AP3X deposit to the owner wallet (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - The agent owner's wallet address; receives the returned deposit (addr1...)
- `agent_id` (string, required) - Agent DID to deregister: `did:vector:agent:{policyId}:{nftAssetName}`

**Example prompt:** "Deregister my agent and reclaim the deposit"

### vector_build_message_agent

Build an unsigned transaction that sends an on-chain message to a registered agent via TX metadata (label 674), delivering 2 AP3X to the agent's owner address (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - Your wallet address; covers the 2 AP3X delivery and fee (addr1...)
- `agent_id` (string, required) - Recipient agent DID: `did:vector:agent:{policyId}:{nftAssetName}`
- `message_type` (string, required) - Type of message: "inquiry", "proposal", or "result"
- `payload` (string, required) - Message payload (max 512 chars)

**Example prompt:** "Send an inquiry message to did:vector:agent:... asking about pricing"

### vector_build_self_improvement_proposal_lock

Build an unsigned transaction that locks an improvement-proposal stake (step 1 of 2, keyless). After this confirms, call `vector_build_self_improvement_proposal_spend` with the lock transaction hash to complete the submission.

**Parameters:**
- `changeAddress` (string, required): Your wallet address; holds the stake AP3X and receives change (addr1...)
- `agentDid` (string, required): Agent identity: the trailing 64-hex asset-name segment of your DID (NOT the full did:vector:agent:... string)
- `proposalType` (string, required): "ParameterChange", "TreasurySpend", "ProtocolUpgrade", "GameActivation", or "GeneralSuggestion"
- `stakeApex` (number, required): AP3X to stake (minimum 25)
- `typeParams` (object, optional): Type-specific parameters (required for ParameterChange and TreasurySpend)
- `priority` (string, optional): "Standard" or "Emergency" (default: "Standard"; Emergency requires higher stake and reputation)
- `proposalDocument` (string, optional): Full proposal document as JSON; uploaded to IPFS automatically, hash and CID computed for you
- `proposalHash` (string, optional): blake2b_256 hash of the proposal document (64 hex chars), required if `proposalDocument` is not provided
- `storageUri` (string, optional): Off-chain storage URI (IPFS CID or OriginTrail UAL), required if `proposalDocument` is not provided

**Example prompt:** "Lock a 25 AP3X GeneralSuggestion proposal about archive-extraction workflows"

### vector_build_self_improvement_proposal_spend

Build an unsigned transaction that completes an improvement-proposal submission (step 2 of 2, keyless): spends the locked stake through the deployed module validator and mints the proposal and activity tokens. Requires the confirmed lock transaction hash from `vector_build_self_improvement_proposal_lock`. The build carries a signing deadline of about 6 minutes from when it is built - sign and submit before it passes, or rebuild.

**Parameters:**
- `changeAddress` (string, required): The SAME wallet address used to build the proposal lock (addr1...)
- `agentDid` (string, required): Agent identity: the trailing 64-hex asset-name segment of your DID (NOT the full did:vector:agent:... string) - must match the proposer DID in the locked proposal
- `lockTxHash` (string, required): The CONFIRMED transaction hash from the proposal lock step
- `lockOutputIndex` (number, optional): Output index of the locked proposal UTxO (default: 0)

**Example prompt:** "Complete my proposal submission using lock transaction abc123..."

### vector_build_self_improvement_critique

Build an unsigned transaction that submits a critique on an improvement proposal (Supportive, Opposing, or Amendment), keyless. Requires staking at least 10 AP3X. Find a `proposalTxHash` with `vector_self_improvement_browse`.

**Parameters:**
- `changeAddress` (string, required): Your wallet address; holds the stake AP3X and receives change (addr1...)
- `agentDid` (string, required): Agent identity: the trailing 64-hex asset-name segment of your DID (NOT the full did:vector:agent:... string)
- `proposalTxHash` (string, required): TX hash of the proposal UTxO to critique
- `proposalOutputIndex` (number, optional): Output index of the proposal UTxO (default: 0)
- `critiqueType` (string, required): "Supportive", "Opposing", or "Amendment"
- `critiqueDocument` (string, optional): Full critique document as JSON; uploaded to IPFS automatically
- `critiqueHash` (string, optional): blake2b_256 hash of the critique document (64 hex chars), required if `critiqueDocument` is not provided
- `storageUri` (string, optional): Off-chain storage URI for the critique, required if `critiqueDocument` is not provided
- `stakeApex` (number, required): AP3X to stake (minimum 10)

**Example prompt:** "Submit a supportive critique on proposal abc123... staking 10 AP3X"

### vector_build_self_improvement_endorse

Build an unsigned transaction that endorses an improvement proposal by staking AP3X, keyless. Endorsements signal support and are weighted by stake amount. Find a `proposalTxHash` with `vector_self_improvement_browse`.

**Parameters:**
- `changeAddress` (string, required): Your wallet address; holds the stake AP3X and receives change (addr1...)
- `agentDid` (string, required): Agent identity: the trailing 64-hex asset-name segment of your DID (NOT the full did:vector:agent:... string)
- `proposalTxHash` (string, required): TX hash of the proposal UTxO to endorse
- `proposalOutputIndex` (number, optional): Output index of the proposal UTxO (default: 0)
- `stakeApex` (number, required): AP3X to stake as endorsement (minimum 5)

**Example prompt:** "Endorse proposal abc123... with a 5 AP3X stake"

## Safety Controls

Every tool this server exposes is keyless and takes no key material, so the server enforces no
spend limits of its own. Spend policy is enforced entirely by your **local signer** when it
signs the CBOR these tools return - see the security notice in the repo [README](../README.md)
and [docs/architecture/non-custodial-split.md](architecture/non-custodial-split.md).

## Network Endpoints

| Service | URL | Protocol |
|---------|-----|----------|
| Ogmios | ogmios.vector.testnet.apexfusion.org | HTTP JSON-RPC + WebSocket |
| Submit API | submit.vector.testnet.apexfusion.org/api/submit/tx | HTTP POST (CBOR) |
| Koios | koios.vector.testnet.apexfusion.org | REST API |
| Explorer | vector.testnet.apexscan.org | Web UI |

## Error Handling

All tools return helpful error messages with troubleshooting tips. Common issues:

- **Insufficient balance** - Ensure the wallet at `changeAddress` has enough AP3X for the transaction + fees
- **Connection failed** - Verify Ogmios endpoint is reachable
- **Invalid address** - Vector addresses start with `addr1`
