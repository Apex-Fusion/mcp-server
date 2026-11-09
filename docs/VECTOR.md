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

### Self-improvement (Module-6) build tools

The tools build on the Module-6 deployment of the identity registry (the `GOV_*` settings and the identity deployment). A proposal, a critique and an endorsement each take two keyless transactions: step 1 locks the stake with the datum, step 2 spends the confirmed lock through the module validator and mints the position's token. The agent is a `did:vector` agent (`agentDid`: the canonical DID, the legacy form or the bare 64-hex identifier) whose identity record is Active over the validity window of step 2 (at most one hour). The datum names a declared credential (`credentialKeyHash`: the record's controller key or a listed Ed25519 key with the transaction purpose; default the key of `changeAddress`); its key signs step 2, and stakes and rewards return to it. Every tool also takes `validMinutes` (optional, 1 to 59, default 30).

- `vector_build_self_improvement_proposal_lock` (step 1): `changeAddress`, `agentDid`, `proposalType` ("ParameterChange", "TreasurySpend", "ProtocolUpgrade", "GameActivation" or "GeneralSuggestion"), `stakeApex` (minimum 25), optional `credentialKeyHash`, `typeParams`, `priority` ("Standard", 7-day review window, or "Emergency"), `proposalDocument` or `proposalHash` and `storageUri`. A proposal lock leaves the validator only through its submission, so the tool checks every submission rule first.
- `vector_build_self_improvement_proposal_spend` (step 2): `changeAddress`, `agentDid`, `lockTxHash`, optional `lockOutputIndex`. Mints the proposal token; the first proposal of an agent inserts its node into the activity list. The answer names the proposal's seed (the lock), by which critiques and endorsements name the proposal.
- `vector_build_self_improvement_critique` (step 1): `changeAddress`, `agentDid`, `proposalTxHash` (the seed or the current output of the proposal), optional `proposalOutputIndex`, `critiqueType` ("Supportive", "Opposing" or "Amendment"), `stakeApex` (minimum 10), optional `credentialKeyHash`, `critiqueDocument` or `critiqueHash` and `storageUri`. Except for an Amendment critique, the critic and the proposer must be different parties.
- `vector_build_self_improvement_critique_spend` (step 2): `changeAddress`, `agentDid`, `lockTxHash`, optional `lockOutputIndex`. Mints the critique token.
- `vector_build_self_improvement_endorse` (step 1): `changeAddress`, `agentDid`, `proposalTxHash`, optional `proposalOutputIndex`, `stakeApex` (minimum 5), optional `credentialKeyHash`. The endorser and the proposer must be different parties.
- `vector_build_self_improvement_endorse_spend` (step 2): `changeAddress`, `agentDid`, `lockTxHash`, optional `lockOutputIndex`. Mints the endorsement token (`gend_`).

**Example prompt:** "Lock a 25 AP3X GeneralSuggestion proposal for did:vector:3ddd0751..., then submit it once the lock confirms"

### Module-1 dispute and jury tools

The tools follow the Module-1 jury specification (`Module-1/jury/SPEC.md` of vector-agent-modules). The jury decides Module-1 disputes: AI jurors vote on each challenge, and the relay of the Foundation signs the Module-1 `OracleResolve` with the result. The build tools are keyless and return the unsigned CBOR with every key hash that must sign it. The claim and challenge tools need `VECTOR_MODULE1_MANIFEST`, the juror and jury read tools need `VECTOR_JURY_MANIFESTS`; without them the tools say which variable to set.

- `vector_build_document_publish`: `changeAddress`, `text` or `base64`, `type` (`claim`, `evidence`, `juror-prompt`, `juror-record`, `resolution` or another short text), optional `media_type` (default `application/json`). The transaction carries the document as metadata under label 22084. The answer gives the URI `vector-tx:<transaction id>` and the blake2b-256 hash. Use them after the transaction is on chain.
- `vector_get_document`: `uri` (`vector-tx:` or `https://`), optional `expected_hash`. Read-only. A `vector-tx:` document is read from the JSON metadata of its transaction (Koios `tx_metadata`). When Koios gives no JSON for the label 22084 metadata (db-sync leaves out the metadata of some transactions), the tool reads the CBOR form: Koios `tx_cbor`, then Blockfrost `/txs/{hash}/metadata/cbor`. The Blockfrost URL comes from `VECTOR_BLOCKFROST_URL` (default `https://blockfrost.vector.mainnet.apexfusion.org`). Both forms go through the same checks: `v` is 1, every chunk is text of at most 64 bytes that does not start with `0x`, and the hash is blake2b-256 of the joined chunks.
- `vector_build_module1_claim`: `changeAddress` (its key is the claimer credential), `agent`, `claim_uri`, optional `claim_hash` (default: read the document and compute it), `claim_type` (1 to 64 bytes), `stake` (AP3X, at least 50 on mainnet), optional `challenge_window_minutes` (30 to 1440 on mainnet).
- `vector_build_module1_challenge`: `changeAddress` (its key is the auditor credential), `agent`, `claim` (the claim token name or the claim output reference), `evidence_uri`, optional `evidence_hash`, `stake` (at least the claim stake), optional `resolution_deadline_hours` (default 72). The jury needs at least 6 h 10 min before the deadline. The claim can sit at any address that has the claim script as its payment credential, with or without a stake part (Module-1 checks the payment credential only). A claim at an address with a stake part is found through Koios by its token name, or by its output reference when Koios is behind. The continuing claim output stays at the address of the claim.
- `vector_build_jury_register`: `changeAddress` (its key becomes the juror owner), `agent`, `prompt_text` or `prompt_base64`, optional `bond` (default bond_min, 250 AP3X on mainnet). The juror can vote after the eligibility delay (3 days on mainnet).
- `vector_build_jury_exit` (`step`: `request` or `exit`), `vector_build_jury_topup` (`amount`): `changeAddress`, `juror` (token name, output reference or DID).
- `vector_build_jury_commit`: `changeAddress`, `juror`, `case`, `vote`, `record_text`, `record_base64` or `record_hash`, optional `salt`. Without a salt the tool makes one and returns it. Keep the salt and the exact record: the reveal needs both, and an unrevealed vote costs 25 AP3X.
- `vector_build_jury_reveal`: `changeAddress`, `juror`, `case`, `vote`, `salt`, `record_text` or `record_base64`. The tool checks the commitment first. When the reveal with the record does not fit: first publish the same record bytes with `vector_build_document_publish` (type `juror-record`) in the reveal window, then set `record_in_metadata` to false (give the record or its `record_hash`) and `record_uri` to that transaction's `vector-tx:` URI. The reveal then carries a `juror-record-ref` document.
- `vector_get_jury` and `vector_get_jury_cases` (optional `jury`, `agent`; the cases also `claim` and `challenge`): the deployments with their jurors, and the live cases with ballots, tally, the document URIs and the canonical flag of the dispute (from the marketplace indexer). Read-only.

**Example prompt:** "Publish my evidence document, then challenge the claim clm_… with a 50 AP3X stake"

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
