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

### Identity registry, attestation, delegation and vault tools

The `vector_build_identity_*`, `vector_build_attestation_*`, `vector_build_delegation_*` and `vector_build_vault_*` tools build unsigned transactions for the `did:vector` identity registry (Part 2 of the identity registry plan). Each takes `changeAddress` (the wallet that pays the fee, any deposit and the collateral) and an optional `valid_minutes` (1 to 59, default 30), and returns the unsigned CBOR with every key hash that must sign it. Each key holder signs in turn with `vector_signer_sign` (it keeps the witnesses already present), then `vector_submit_transaction` broadcasts once. The README lists the tools; their input schemas are in `packages/builder/test/smoke/tool-schemas.snapshot.json`. The server needs the identity deployment values (`VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED` and the reference-script UTxOs; see the README).

**Example prompt:** "Register an agent named ResearchAgent with my signer key as controller and Accountable Party, and the capability research"

The legacy registry writes (`vector_build_register_agent`, `vector_build_update_agent`, `vector_build_transfer_agent`) are retired. A legacy record moves into the identity registry with `vector_build_identity_adopt`.

### vector_build_deregister_agent

Build an unsigned transaction that deregisters a legacy record that does not adopt: burns its token and returns the deposit to the owner wallet (keyless). Sign the returned CBOR with your local signer, then broadcast with `vector_submit_transaction`.

**Parameters:**
- `changeAddress` (string, required) - The legacy record owner's wallet address; receives the returned deposit (addr1...)
- `agent_id` (string, required) - Legacy agent DID to deregister: `did:vector:agent:{policyId}:{nftAssetName}`

**Example prompt:** "Deregister my legacy agent and reclaim the deposit"

### vector_resolve_did

Resolve a `did:vector` DID through the identity gateway (`GET /1.0/identifiers/{did}`, DID Resolution v1.0). Returns the HTTP status and the DID resolution result unchanged. Read-only.

**Parameters:**
- `did` (string, required) - `did:vector:<64 hex>` (canonical) or `did:vector:agent:{policyId}:{nftAssetName}` (legacy)
- `versionId` (string, optional) - Resolve this version: `0`, or a decimal number without leading zeros
- `versionTime` (string, optional) - Resolve the DID as it was at this time: `YYYY-MM-DDThh:mm:ssZ` (UTC). Do not combine with `versionId`

The gateway URL comes from `VECTOR_IDENTITY_GATEWAY_URL` (default `https://id.vector.apexfusion.org`).

**Example prompt:** "Resolve did:vector:3ddd0751... and tell me its effective status"

### vector_get_agent_profile

Get an agent's profile by DID. A canonical DID is resolved through the identity gateway (profile, effective status, keys, record output); a legacy DID is read from the legacy registry on-chain. Read-only.

**Parameters:**
- `agent_id` (string, required) - `did:vector:<64 hex>` or `did:vector:agent:{policyId}:{nftAssetName}`

**Example prompt:** "Show me the profile of did:vector:3ddd0751..."

### vector_discover_agents

Discover agents that have a listed advert, from the marketplace indexer (which applies the listing rule). Each result names the agent's DID when its adverts name one; a legacy advert names none. Read-only.

**Parameters:**
- `capability` (string, optional) - Capability id substring, any case (e.g. `llm.chat`)
- `limit` (number, optional) - Maximum number of agents (default 20, max 100)

**Example prompt:** "Which agents offer OCR?"

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
