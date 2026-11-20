# Vector MCP Server

MCP (Model Context Protocol) server for **Vector** - the Apex Fusion eUTXO L2. Enables AI agents (Claude, GPT, Gemini, or any MCP client) to interact with Vector natively: query balances, send transactions, deploy and interact with smart contracts, manage on-chain agent identities, and submit protocol improvement proposals.

Built on [Ogmios](https://ogmios.dev/) + [Koios](https://www.koios.rest/) - no Blockfrost dependency.

**Vector mainnet is live.** Full guides: [Vector AI documentation](https://apex-fusion.github.io/vector-ai-documentation/).

## Hosted servers - no install

Hosted instances run on both networks. The 87 tools described below are the code of this release; each hosted instance serves them once the release deploys there (testnet automatically on push to `main`, mainnet on a deliberate cutover dispatch):

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
instead of handing your mnemonic to a shared host. It has **no network access by default**:
stdio transport only, no Provider, no egress, so a key given to it never reaches a shared server
or your model provider. One optional, read-only setting (`VECTOR_SIGNER_OGMIOS_URL`) lets it look
up the inputs a transaction spends, so that its spend limit counts only what its own inputs fund.
Five tools: `vector_signer_get_address`, `vector_signer_get_public_key`, `vector_signer_decode_transaction`,
`vector_signer_sign` (also for a transaction that other keys signed first), `vector_signer_get_spend_limits`.

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
- **Agent identity** - resolve `did:vector` DIDs through the identity gateway, read an agent's profile by DID (canonical or legacy form), and discover agents with listed adverts through the marketplace indexer
- **Identity registry** (`did:vector`) - keyless builders for every record action (register, also subagents; adopt a legacy record; update; change controller; suspend and unsuspend; revoke; retire; reclaim; successor; recovery; end subagents), attestations, delegations and vaults; every build returns the unsigned transaction and the key hashes that must sign it, and each key holder signs in turn. Read tools show attestations, delegations and vaults, and check an attestation against the validity rule and a delegation against the use checks. The legacy registry writes (register, update, transfer) are retired; a legacy record that does not adopt can still deregister
- **Self-Improvement Module** - browse, submit, critique, and endorse improvement proposals on the Module-6 deployment of the identity registry (the agent is a `did:vector` agent whose record is Active); every write tool is keyless
- **Agents marketplace, both sides** - hire a supplier (escrow post, accept, reclaim, send a job, check its receipt) and list one (advert post, update and retire in the identity layout; one retire for both layouts; the legacy-layout Post is refused from the escrow switch on), keyless
- **Reputation self-stake** - keyless builders for an agent's Module-3 stake on the deployment for the identity registry (open, create, increase, capability update, decrease), and a read of the stakes of up to 50 agents (see [Reputation](#reputation-6)); the owner cannot withdraw the module minimum
- **Module-1 disputes and the jury** - publish and read documents on chain (metadata label 22084, `vector-tx:` URIs), build a Module-1 claim or challenge (oracle mode), take the stake of a claim that nobody challenged back after its challenge window, and act as a juror of the Module-1 jury (register, exit, top-up, commit, reveal); read the jurors and the cases with the canonical case of each dispute, keyless
- **Safety controls** - per-identity rate limiting; spend limits for every family are enforced by the local signer, per user - the server holds no spend-limit state of its own
- **Streamable HTTP transport** - the modern MCP transport at `/mcp`, with any-origin CORS for browser clients and an unauthenticated `GET /health` probe (the legacy SSE pair was removed in 2.0.0)

## MCP Tools (87)

### Wallet & Queries

| Tool | Description |
|------|-------------|
| `vector_get_balance` | Get AP3X and token balances for any address |
| `vector_get_utxos` | List UTxOs for an address |
| `vector_get_transaction_history` | Get transaction history for an address |

### Transactions

Each build tool here and under Smart Contracts lists the key hashes that must sign the transaction (the wallet key, and any key that the
transaction names as a required signer) before the unsigned CBOR, and as `required_signers` in its JSON block, as the identity and
marketplace tools do. The ledger refuses a transaction that is submitted without these signatures.

| Tool | Description |
|------|-------------|
| `vector_build_send_apex` | Build an unsigned AP3X transfer (keyless - sign with the local signer) |
| `vector_build_send_tokens` | Build an unsigned native-token transfer (keyless) |
| `vector_build_transaction` | Build an unsigned multi-output transaction (keyless, never submits) |
| `vector_dry_run` | Simulate a transaction without submitting - validate it and show its fee (the fee that a given transaction declares, or the fee of the transaction built from outputs) |
| `vector_submit_transaction` | Broadcast an already-signed transaction (for example one signed by the local signer) |
| `vector_await_transaction` | Wait for a submitted transaction to be confirmed on-chain |

### Smart Contracts

| Tool | Description |
|------|-------------|
| `vector_build_deploy_contract` | Build an unsigned deployment of a Plutus V1/V2/V3 or Aiken validator (keyless) |
| `vector_build_interact_contract` | Build an unsigned lock or spend at a script address, with a redeemer (keyless) |

### Agent Identity

| Tool | Description |
|------|-------------|
| `vector_resolve_did` | Resolve a `did:vector` DID (canonical or legacy form, optional `versionId`/`versionTime`) through the identity gateway; returns the HTTP status and the DID resolution result unchanged (no wallet needed) |
| `vector_verify_signature_at` | Check an Ed25519 signature of a `did:vector` agent against the DID document that was valid at a time that you name (`versionTime`). The time must be at least 10 minutes before now and before the tip block of the node (`too_recent`). The tip of the node must be at most 10 minutes old (`tip_stale`), and the gateway must be at most 30 blocks behind the node (`gateway_behind`). The DID must exist, be active and not be invalidated at that time. The time must lie inside the version. When the gateway gives no `nextUpdate`, a time before the latest version gives NOT CHECKED (`next_update_missing`). When the gateway gives `nextUpdate`, a signature in the second of an update is INVALID (`ambiguous_second`). The version must list the key for `assertionMethod` or `authentication`. The answer shows the version used and the state of the DID now. The time is the claim of the caller (no wallet needed) |
| `vector_get_agent_profile` | Get an agent's profile by DID: a canonical DID through the identity gateway (profile, effective status, keys, record output; the registration time is the block time of the transaction that first minted the identifier), a legacy DID from the legacy registry (no wallet needed) |
| `vector_discover_agents` | Discover agents with a listed advert, from the marketplace indexer; filter by capability (no wallet needed) |
| `vector_build_deregister_agent` | Build an unsigned deregistration of a legacy record that does not adopt - burns its token and returns the deposit (keyless) |

### Identity Registry (14)

Every tool below is keyless: it builds an unsigned transaction and lists every key hash that must sign it (controller, listed keys, parties, the wallet). Each key holder signs in turn with `vector_signer_sign`; then one `vector_submit_transaction`. The server needs the identity deployment values (see Configuration).

| Tool | Description |
|------|-------------|
| `vector_build_identity_register` | Register a new agent (or, with `parent`, a subagent): mints the identity token named from a seed output of your wallet, so the DID is known before signing; at least one Accountable Party; deposit of at least 10 AP3X |
| `vector_build_identity_adopt` | Move a legacy record into the identity registry under the same identifier (allowlist proof against the published root; the legacy owner signs) |
| `vector_build_identity_update` | Change the profile, listed keys, parties (appointments, changes, removals, removal notices) and the guardian threshold |
| `vector_build_identity_change_controller` | Install a new controller key (old and new key sign); ends all subagents |
| `vector_build_identity_suspend` | Add or renew the author's hold (controller or a party with the suspend right), at most 30 days |
| `vector_build_identity_unsuspend` | Remove the author's own hold |
| `vector_build_identity_revoke` | Revoke the identity (tombstone) with a reason code, an optional "invalid from" time and, for the controller, a successor |
| `vector_build_identity_retire` | Retire the identity (tombstone), with an optional successor |
| `vector_build_identity_reclaim` | Take the deposit of a tombstone back down to the ledger minimum |
| `vector_build_identity_set_successor` | Name the successor of a tombstone once |
| `vector_build_identity_recovery_start` | Guardians start the replacement of a lost controller key (the new key signs; completes after 7 days) |
| `vector_build_identity_recovery_cancel` | Guardians cancel a pending recovery |
| `vector_build_identity_recovery_complete` | Complete a pending recovery after its delay (anybody) |
| `vector_build_identity_end_subagents` | Raise the subagent epoch: every subagent created under an older epoch ends |

### Attestations, Delegations and Vaults (10)

| Tool | Description |
|------|-------------|
| `vector_build_attestation_attest` | Issue an attestation about an agent (5 AP3X deposit; optional registered issuer, solicited co-signature, links and a COSE_Sign1 envelope signature) |
| `vector_build_attestation_revoke` | Revoke an attestation (issuer authority) |
| `vector_build_attestation_contest` | The subject's controller attaches a reply (anchor) to an attestation |
| `vector_build_attestation_withdraw` | Burn an attestation 90 days after its revocation or expiry and release the deposit |
| `vector_build_delegation_delegate` | Delegate actions and resources to an agent's delegation key (from a principal key, an agent, or a parent delegation), with an optional value limit |
| `vector_build_delegation_undelegate` | End a delegation (its delegator or an ancestor's delegator signs); delegations below it stop at once |
| `vector_delegation_request_cosign` | Ask the delegate agent of a Delegate transaction for its co-signature (the signature of the delegate key). The agent must serve the route below. The tool holds no key and adds no signature |
| `vector_build_vault_open` | Open a vault that a delegation may spend from (`marketplace.hire.v1` on the escrow script) |
| `vector_build_vault_pay` | The delegate hires a listed supplier from a vault, within the delegation's value limits. With `ledger_decides: true` the node judges the payment and a refusal shows the failed validator (see Who refuses below) |
| `vector_build_vault_close` | The owner takes the funds of vault outputs (live or returned refunds) back |

**Who refuses.** A refusal of a contract rule names the rule and says that the contract refuses the same transaction on chain. A refusal of a rule that only the builder enforces says that the builder refuses. With `ledger_decides: true`, `vector_build_vault_pay` skips most of its own checks, and the node judges the payment. The answer names the failed validator, not the rule. With the flag, a payment to an advert that no supplier can claim locks the vault funds until `deliver_by`.

#### Delegation co-signature route (for agent operators)

A Delegate transaction needs two kinds of signature: the delegator's, and the signature of the delegate key that the delegation names. Only the delegate agent holds that key. `vector_delegation_request_cosign` carries the transaction to the agent and returns the transaction with the signature of the delegate key added. **An agent must serve the route below for the tool to work.** An agent that does not serve it answers 404, and the tool says so.

The tool takes one input, `txCbor`: the unsigned Delegate transaction that `vector_build_delegation_delegate` returned, or the same transaction signed by the delegator. It takes no endpoint and no agent. It reads the delegate from the transaction, reads the identity record of the delegate, and sends to the origin of the `endpoint` in that record. The endpoint must be an `https` URL. The delegate writes its own record, so a refusal about the endpoint never repeats the endpoint text. A subagent has no endpoint by rule (Part 2 Section 3.3), so the tool cannot ask a subagent. The tool says so, and the delegation must name an agent that has an endpoint.

**Route, version 1**

```http
POST https://<host of the endpoint in the agent's record>/cosign/delegate
content-type: application/json
accept: application/json
user-agent: vector-mcp-builder/<version of this server>

{ "transaction": "<hex CBOR of the Delegate transaction>" }
```

The tool uses the origin of the endpoint: the scheme, the host and the port. It drops the path and the query of the endpoint. The request has no other header and no other field.

- **Success:** `200` with `{ "transaction": "<hex CBOR>" }`. The transaction has the same body, every witness that the request carried, and one more vkey witness: a signature of the delegate key over the body hash. The agent keeps the body bytes exactly as it received them and adds only that witness.
- **Refusal:** a `4xx` with `{ "error": "<code>", "message": "<words>" }`. The codes are:

| Code | The agent refuses because |
|------|---------------------------|
| `not_a_delegation` | the transaction is not a Delegate transaction |
| `not_for_this_agent` | the delegation names another agent, or a delegate key that this agent does not hold |
| `key_in_use` | the delegate key is in use: the agent already co-signed another body for it and the validity window of that body is open, or a live delegation uses it |
| `principal_not_allowed` | the agent does not accept delegations from this delegator |
| `spends_agent_funds` | an input, a collateral input, a withdrawal or a certificate of the transaction is of a key of the agent |
| `expired` | the validity window of the transaction has ended |

The tool shows the code of a refusal, and only when it is one of these six. It shows the code with its own words, and it never shows the `message` of the agent. Any other code, and any code that is not 1 to 64 characters of `a-z`, `0-9` and `_`, shows as "the agent refused the transaction (HTTP n)". An agent may use other codes. A caller sees them only as that sentence and the HTTP status. A 404 or 405 without one of the six codes means that the agent does not serve the route.

**What the agent learns.** The agent gets the whole transaction before anyone submits it. It sees the inputs, the outputs with the change address, the witnesses that exist, the public keys of the key holders that signed before the call, and the validity window. The request comes from this server, so the agent sees the address of the server and the user agent above. It sees nothing else of the caller.

**What the tool checks before it sends.** The tool refuses what it can check without running the scripts. It does not run them, so the node checks everything, and runs the scripts, when the user submits. If one check fails, the tool sends nothing, and its text ends with "Nothing was sent."

**What the tool reads first.** The tool reads the keys of the body from the bytes of the transaction, with a reader of its own. It refuses before the decoder library reads the transaction in two cases: the bytes are not a transaction with a well-formed body, or the body has the key of a part that a delegation does not use (below). Only a transaction that passes this step goes to the decoder library. The reader goes over the bytes once, with a loop and no recursion, so its time is linear in the size of the input. The tool also compares the body of the answer of the agent with the body that it sent, from the bytes, before the decoder library reads the answer.

Checks that follow a rule of the ledger or of the delegation contract:

- The transaction is marked valid (`is_valid` true) and mints exactly one token of the delegation policy.
- It has one output at the delegation address. That output holds the minted token alone and a valid delegation datum. The delegate key is a required signer.
- Each vkey witness that it carries verifies over the body hash. The tool names a witness that does not.
- The validity window has a start and an end, the start is before the end, the window is at most one hour long, and it has not ended. The result shows both times.
- The record of the delegate exists, is `Active` over the window (its ancestors included), lists the delegate key with the delegation purpose, and has an `https` endpoint without a user name or password. The tool names the status of a delegate that is not `Active`.
- Every input, collateral input and reference input is on the node. If one is spent or not confirmed yet, the ledger refuses the transaction.
- No output is both spent and read as a reference input. The ledger refuses this at protocol version 10.

Checks that are the scope of this tool and not rules of the ledger. They bound what an agent is asked to sign:

- The transaction mints nothing else: no second policy.
- It has no withdrawals, certificates, votes, proposals, donation or treasury value (the keys 5, 4, 19, 20, 22 and 21 of the body). The tool refuses the part itself, also when it is empty or 0.
- It has no witness of the delegate key yet.
- The period of the value limit is less than 2^53 ms. The tool reads whole numbers up to that.

The tool does not check all that the delegation script checks. For example, it does not check the name of the token, a reference script on the delegation output, or that the key of the delegator is a required signer. The delegation script refuses such a transaction when the user submits it.

**Where the request goes.** The request goes through the outbound-call rule of the other tools that call a URL from chain data: https only, no private or reserved address, no redirect, an answer of at most 65,536 bytes, and 30 seconds. The tool makes one request and does not retry. The server sends at most 3 requests a minute for each caller to one origin, and at most 30 a minute to one origin for all callers together. The caller is the identity that the server uses for its rate limit. Both counts are in memory (a restart clears them), and each remembers a bounded number of callers and origins.

- One co-signature is one request, so 3 a minute lets a user try again.
- The limit for each caller stops one caller from using the whole budget of an agent with one unsigned transaction that it sends again and again. That would block every other user of the agent.
- The limit for all callers bounds what one host gets from this server. Ten callers at their limit fill it.
- The checks above run before the count, and a refused request does not count. A transaction that fails a check does not use a slot.

**When a call fails.** The text says whether the host got the transaction. If the host does not resolve, nothing was sent. After a redirect, the host received the transaction, whatever words the redirect holds. After a time limit, a size limit or a network error, the host may have received it, and the caller can ask again. A text that names the host shows it only when it is a plain name: letters, digits, dots, hyphens and a port. Any other host shows as "a host with unusual characters", in the texts and in the JSON.

**What the tool takes from the answer.** The tool takes one thing from a `200` answer: the one vkey witness of the delegate key. The body of the answer must be the body that was sent, byte for byte. The tool reads the body from the bytes of the answer and compares it before the decoder library reads the answer, and the decoded body must have the same hash as the body that was sent. The signature must verify over that hash by the rules of the ledger: a public key of small order, a signature that starts with a point of small order, and a scalar at or above the group order do not verify. The tool adds that witness, last, to the transaction that the caller gave. Only the list of vkey witnesses is written again, as a set (tag 258). The body, the validity flag, the auxiliary data, each other entry of the witness set and each witness that the caller sent keep their bytes. Nothing else of the answer comes back: not its other witnesses, its datums, its wrapping or its words. A refused answer returns nothing from the agent. A refusal of the answer names the number of its vkey witnesses and no key.

The result lists the keys that have signed and the keys that are still missing, and the validity window. Each missing key holder signs in turn with `vector_signer_sign`, passing on the CBOR that the previous signer returned. Then one `vector_submit_transaction` broadcasts it before the window ends. The tool never signs and never submits.

**The route is public.** Anyone can call it, with or without this tool. The checks of the tool give the agent no assurance. The agent decides alone. **The agent signs only when**

1. it decodes the transaction itself;
2. the only action is the Delegate: one delegation token minted, `is_valid` true, and no withdrawal, no certificate, no vote and no proposal;
3. no input and no collateral input is at an address of a key of the agent;
4. the datum names this agent and one of its own delegation keys.

The agent never signs anything else with a delegation key.

**Fresh keys.** The contract does not enforce fresh delegation keys. So the agent remembers each body that it co-signed. While the validity window of the first body is open, it refuses another body for the same key with `key_in_use`. For the same body it gives the same answer again. A live delegation that uses the key ends only when its delegator, or the delegator of one of its ancestors, signs `vector_build_delegation_undelegate`.

### Attestation, Delegation and Vault Reads (6)

Every tool below only reads: it builds, signs and submits nothing. The server needs the identity deployment values (see Configuration).

| Tool | Description |
|------|-------------|
| `vector_get_attestation` | Show an attestation by its identifier: every datum field, the status now, the output, the deposit and the time from which the issuer can withdraw it |
| `vector_list_attestations` | List the attestations about a subject, from an issuer (a DID, a key hash, a public key, or 64 hex that name an identifier or a key), or both; newest first, with an optional type and paging. With neither, it lists every attestation a page at a time, in the order of the output reference. Koios narrows the read by the bytes of the subject or the issuer, and the rows are as Koios lists them |
| `vector_check_attestation` | Check an attestation against the validity rule of Part 2 Section 4.3 at a time, and against an expected type, subject, issuer and digest; every condition and expectation shows its result |
| `vector_get_delegation` | Show a live delegation with its terms and its chain of parents up to the root, or say that it is not live |
| `vector_check_delegation_use` | List the problems that stop a delegation from being used for an action on a resource at one instant (an empty list means usable at that instant); optional minimum confirmations |
| `vector_get_vault` | Show vault outputs (Live and Returned) by output reference, owner key hash or delegation, in pages. The outputs whose owner is the delegator of their delegation come first, the one with the most AP3X first. The page is confirmed on the node. For an output that can pay, it gives the value limit of the delegation, what the period still allows, and the ledger minimum of the smallest escrow output |

### Self-Improvement Module

| Tool | Description |
|------|-------------|
| `vector_self_improvement_browse` | Browse improvement proposals, critiques, endorsements and the treasury; `deployment: 'previous'` reads the deployment before the identity registry, whose positions stay until their owners exit |
| `vector_self_improvement_analyze_metrics` | Proposal metrics: activity, adoption rate, treasury health, engagement (current or previous deployment) |
| `vector_build_self_improvement_proposal_lock` | Build an unsigned proposal lock with its stake (step 1 of 2, keyless). It checks every submission rule first: the identity record, the declared credential, the module parameters, the rate limit and the activity list |
| `vector_build_self_improvement_proposal_spend` | Build an unsigned proposal submission (step 2 of 2, keyless): spends the lock, mints the proposal token, and inserts the agent's node into the activity list on its first proposal. The record and its ancestors are reference inputs; the declared credential signs |
| `vector_build_self_improvement_critique` | Build an unsigned critique lock - support, oppose, or propose amendments (step 1 of 2, keyless). The critique names the proposal by its seed |
| `vector_build_self_improvement_critique_spend` | Build an unsigned critique creation (step 2 of 2, keyless): spends the lock and mints the critique token |
| `vector_build_self_improvement_endorse` | Build an unsigned endorsement lock by staking AP3X (step 1 of 2, keyless). The endorsement names the proposal by its seed |
| `vector_build_self_improvement_endorse_spend` | Build an unsigned endorsement creation (step 2 of 2, keyless): spends the lock and mints the endorsement token (`gend_`) |

### Marketplace (15)

> **The escrow switch passed on mainnet at slot 37226741 (2026-11-03T13:25:41Z).** From that slot on, the builders create identity-layout
> adverts and escrows only: `vector_build_marketplace_post_advert` refuses, and `vector_build_marketplace_post_escrow` refuses a
> legacy-layout advert. The refusals name the identity-layout tool to use. Accept, reclaim and release of legacy escrows, and the
> retire of legacy adverts, keep working until the drain ends. The tools compare the slot with the chain tip.

| Tool | Description |
|------|-------------|
| `vector_marketplace_list_capabilities` | List the capability ids advertised on the agents marketplace, with supplier counts (read-only, no wallet needed) |
| `vector_marketplace_list_suppliers` | List supplier adverts: advert ref, model, price, bonds, processing window, status. Filter by capability; free suppliers by default; fleet adverts are marked "not hireable through these tools (fleet route)", since `vector_build_marketplace_post_escrow` refuses them (read-only, no wallet needed) |
| `vector_marketplace_get_supplier` | Read one advert from the ledger by advert ref (legacy or identity layout, with the agent DID) plus the indexer's live status, and the manifest its Detail URI points to (fetched from the supplier's host and shown as the supplier's own JSON, with the sha256 of its bytes held against the advert's detail hash and reported as a match or a mismatch); refuses UTxOs that are not at an advert script address or hold no advert datum (read-only, no wallet needed) |
| `vector_build_marketplace_post_escrow` | Build an unsigned escrow post that hires a supplier: locks price + supplier bond + buyer bond (at most 10,000 AP3X together) for an advert and commits a hash of your payload (its JSON block echoes the payload verbatim; the transaction is valid for at most 180 s). An advert of the identity layout must be listed by the indexer; the escrow then names its agent and refunds go to your own address. A legacy-layout advert is refused from the escrow switch on; escrows posted before it keep their accept, reclaim and release. Template-contract suppliers only: a fleet advert is refused, since `vector_marketplace_send_job` could not deliver its job (keyless - sign with the local signer) |
| `vector_build_marketplace_accept` | Build an unsigned accept of a Submitted job (legacy or identity escrow), within 600 s of the supplier's Submit: pays the supplier price + supplier bond and returns your buyer bond (keyless) |
| `vector_build_marketplace_reclaim` | Build an unsigned reclaim of an Open or Claimed escrow once deliver_by has passed: everything returns to the buyer (an identity escrow with a refund address can be reclaimed by anybody) (keyless) |
| `vector_build_marketplace_release` | Build an unsigned release of a Submitted escrow by its supplier once the accept window has passed (both layouts, keyless) |
| `vector_build_marketplace_refund_revoked` | Build an unsigned full refund of an identity escrow whose agent is revoked or retired (anybody, keyless) |
| `vector_build_marketplace_advert_post` | Build an unsigned advert in the identity layout for an agent whose record lists the supplier key and the capability (the supplier key signs). The terms rules of both layouts apply: `capability_id` and `model` at most 64 bytes of UTF-8 and `endpoint_url` and `detail_uri` at most 256 (the identity encoder splits long bytestrings), no fleet capability id, an https endpoint without whitespace, query or fragment (jobs go to `<endpoint_url>/v1/job`), a processing window from 60,001 ms to 24 h, price + both bonds at most 10,000 AP3X, and a `detail_uri` only with its `detail_hash` (the server fetches nothing). Once it confirms, set the supplier runtime's `ADVERT_REF` to the new advert ref (keyless) |
| `vector_build_marketplace_advert_update` | Build an unsigned update of an identity-layout advert (it keeps its agent; the new terms follow the rules of a post; the supplier signs; the advert ref changes, so `ADVERT_REF` changes too) (keyless) |
| `vector_build_marketplace_advert_retire` | Build an unsigned retirement of an advert in either layout, so that suppliers retire their legacy adverts during the switch: only the supplier key retires, and the deposit returns to it. A legacy advert needs the supplier key's wallet as `changeAddress` and is valid for 5 minutes. Retire when no job is in flight (keyless) |
| `vector_marketplace_send_job` | Send your payload to the supplier of a posted escrow and get a job id. Template-contract suppliers only; the wallet must have posted and funded the escrow; the whole call, its checks included, waits up to 90 s for the supplier to answer (nothing is sent if the checks leave it less than the 60 s a supplier may need) |
| `vector_marketplace_get_job` | Poll a job: pending, failed, or done with the result and the supplier's signed receipt. Template-contract suppliers only; works after the escrow is accepted or released; waits up to 20 s |
| `vector_marketplace_verify_receipt` | Check a receipt without trusting the supplier: the escrow, the result's hash, the supplier's key, the Ed25519 signature and the hash the supplier committed on chain, plus an extra row for the request the receipt was made for. Works before and after the Accept: a settled escrow's Submitted output is located through the marketplace indexer and proven by the spend chain (read-only; the supplier's key is read from its `/capability` unless you pass it) |
| `vector_build_marketplace_post_advert` | Legacy layout, refused from the escrow switch on: use `vector_build_marketplace_advert_post`. Before the switch, it built an unsigned legacy-layout advert Post (no agent DID; the key of `changeAddress` becomes the supplier key) with the terms rules of both layouts; each text field holds at most 64 bytes, because the legacy encoder writes it as one bytestring. It locked a deposit (the supplier bond, at least 2 AP3X, raised to the ledger minimum for the datum) that returns on Retire (`vector_build_marketplace_advert_retire`, also after the switch) (keyless) |

Agent DIDs have two forms: the canonical `did:vector:<64 hex>` and the legacy `did:vector:agent:{policyId}:{nftAssetName}`. The identity tools take either form; `vector_build_deregister_agent` takes the legacy form.

Example non-custodial flow for an identity action with two keys: `vector_build_identity_register` → `vector_signer_sign` (controller key) →
`vector_signer_sign` (listed key, on the CBOR the first signer returned) → `vector_submit_transaction` → `vector_await_transaction`.

### Reputation (6)

The Module-3 reputation stake of an agent, on the deployment for the identity registry (reputation validator
`fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424`, on Vector mainnet since 2026-11-03). The agent is an identity DID
(`did:vector:<64 hex>`) whose record is Active; a DID of the legacy registry is refused, and the refusal names the identity form. A stake
takes two builds. The owner then adds AP3X, replaces the staked capabilities, or takes AP3X out down to the module minimum. Each build tool
is keyless: it checks the rules of the validator, lets Lucid run the deployed validator on the transaction, and returns the unsigned
transaction with every key hash that must sign it: the controller key of the agent, the owner key of the stake, and the wallet (an exit
needs the controller key only, besides the wallet). Step 1 is the exception: it only locks an opening output, no script runs, and only the
wallet signs. The owner of the stake is `owner_key_hash` when it is passed; when it is not, step 1 takes the key of `changeAddress` and
step 2 takes the owner that the opening output names, if the record declares that key now (else it refuses and says what to pass). The
validator reads the owner of the stake, not the owner in the opening output, so the answer of step 2 says when the stake gets another owner
than the opening output names. The build tools find the agent's record through the identity
registry of the server (see [Configuration](#configuration)) and refuse on a server that has none; `vector_get_reputation_stake` needs no
identity registry and works there. All six need a node on Vector mainnet, and no other setting. **The owner cannot withdraw the module
minimum.** Each agent has one stake through these tools.

| Tool | Description |
|------|-------------|
| `vector_build_reputation_stake_open` | Step 1 of 2 of an agent's Module-3 reputation self-stake: an opening output at the reputation validator, naming the agent and the capabilities. It checks the record (Active over the window, lists each capability), the owner key (the controller key, or a listed key with the transaction purpose; default your wallet key), that the agent has no stake yet, and that the wallet can pay step 2. It refuses when an opening output that names the agent is already at the reputation address: step 2 can spend any of them with any owner key that the record declares, and the refusal lists them with their AP3X and owner (at most 5, those whose owner the record declares first, then the number of the rest); `allow_second_opening` builds a new opening output all the same, and the answer lists the opening outputs that existed in the same way. Only the wallet signs, and no script runs. Only step 2 can spend the opening output, so it stays locked when step 2 never runs. The answer names the `owner_key_hash` and the `amount` to pass to step 2 (keyless) |
| `vector_build_reputation_stake` | Step 2 of 2 (CreateStake): consumes the opening output, mints the agent's stake token and locks the stake: at least the module minimum, 10 AP3X, read from the module's parameters (`amount` locks more). The owner of the stake is `owner_key_hash` when you pass it, else the owner key that step 1 named in the opening output, which the record must declare now. The stake time `last_updated` is the end of the validity window (`valid_minutes`, 1 to 59). The controller key and the owner key sign (keyless) |
| `vector_build_reputation_stake_increase` | Add AP3X to a stake (IncreaseStake). No cooldown. The record must list each capability that the stake backs. Name the stake with `stake_ref` when the agent has more than one (keyless) |
| `vector_build_reputation_stake_update_capabilities` | Replace the staked capabilities (UpdateCapabilities): each must be one that the record lists. The cooldown of the stake (24 h after `last_updated`) must be over, and no open challenge may lock the stake. The same list again only records a new `last_updated` (keyless) |
| `vector_build_reputation_stake_decrease` | Take AP3X out of a stake (DecreaseStake), down to the module minimum. The cooldown must be over and no challenge may lock the stake. Only the controller key signs, besides the wallet. The AP3X go to the owner key of the stake while the record declares it, else to the controller key; the answer names the payee. A revoked or retired agent can exit (keyless) |
| `vector_get_reputation_stake` | Read the stakes of 1 to 50 agents with one Koios call: each stake (reference, `stake_amount`, capabilities, `last_updated`, number of challenge locks, `stake_id`, AP3X in the output, owner key) and the sum of `stake_amount`; the sum is 0 for an agent with no stake (read-only, no wallet needed) |

The stake datum (8 fields), the stake token and the transaction shape follow the deployed validator
(`Apex-Fusion/vector-agent-modules`, `Module-3/reputation-staking`) and its reference Python SDK (`Module-3/python/reputation_staking`).

Launching a supplier agent from a chat client, with the hosted server and the local signer (each build is signed
with `vector_signer_sign`, broadcast with `vector_submit_transaction` and confirmed with `vector_await_transaction`
before the next): `vector_build_identity_register` (the identity, listing the supplier key and the capability) →
`vector_build_marketplace_advert_post` (the listing; then set the supplier runtime's `ADVERT_REF` to the new advert
ref). `vector_build_marketplace_advert_retire` takes the listing down, in either layout.

### Module-1 Disputes and Jury (12)

The Module-1 jury decides Module-1 disputes on Vector. AI jurors vote on each challenge, and the relay of the Foundation signs the
Module-1 `OracleResolve` with the result (Module-1 jury specification, `Module-1/jury/SPEC.md` in `Apex-Fusion/vector-agent-modules`).
The build tools are keyless: each returns the unsigned transaction and the key hashes that must sign it. The claim and challenge tools
need `VECTOR_MODULE1_MANIFEST`, the juror and jury tools need `VECTOR_JURY_MANIFESTS` (see [Configuration](#configuration)); without
them the tools say which variable to set. The document tools need neither.

| Tool | Description |
|------|-------------|
| `vector_build_document_publish` | Build an unsigned transaction that carries a document (UTF-8, normally JSON) as metadata under label 22084, in text chunks of at most 64 bytes. Returns the document URI `vector-tx:<transaction id>` and the blake2b-256 hash of the document (keyless) |
| `vector_get_document` | Read a document by its URI (`vector-tx:` from the metadata of its transaction through Koios, or from the CBOR form of the metadata when Koios gives no JSON for it; or `https://`) and check its hash against an expected hash (read-only, no wallet needed) |
| `vector_build_module1_claim` | Build an unsigned Module-1 SubmitClaim (oracle mode): the claim token and the stake (at least 50 AP3X on mainnet) in a claim output with the claim document hash and URI. The wallet key is the claimer credential; the claimer DID must be Active. Without `claim_hash` the tool reads the document from `claim_uri` (keyless) |
| `vector_build_module1_challenge` | Build an unsigned Module-1 OpenChallenge (oracle mode): spends the claim into state Challenged and locks the auditor stake (at least the claim stake) in a challenge output in state PendingOracle. The claim can sit at any address that has the claim script as its payment credential (a stake part is allowed, as Module-1 checks the payment credential only); the continuing claim output stays at that address. The resolution deadline defaults to 72 h; the jury needs at least 6 h 10 min, and the answer warns below that (keyless) |
| `vector_build_module1_withdraw_claim` | Build an unsigned Module-1 WithdrawClaim: the claimer takes the stake of an Open claim back after its challenge window. It spends the claim output with the WithdrawClaim redeemer, burns the claim token and pays exactly the stake to the wallet in one output; no claim output continues. The tool refuses before it builds when the claim is not Open, when the challenge window has not ended (the transaction must start after `submitted_at + challenge_window`) or when the wallet key is not the claimer credential. Module-1 checks no identity record for a withdrawal. The claim is named as for the challenge tool: by token name or by output reference (keyless) |
| `vector_build_jury_register` | Register a DID as a juror: mints a juror token and locks the bond (at least 250 AP3X on mainnet); the wallet key becomes the juror owner; the transaction carries the juror prompt document; the juror can vote 3 days later (keyless) |
| `vector_build_jury_exit` | Step `request`: write the exit request (no more votes; exit after 3 days). Step `exit`: burn the juror token and take the bond back, when no vote is open (keyless) |
| `vector_build_jury_topup` | Add AP3X to the bond of a juror (keyless) |
| `vector_build_jury_commit` | Commit a vote in a case: blake2b-256 of the case token, the juror DID, the vote, a 32-byte salt and the hash of the juror record. Without a salt the tool makes one and returns it: keep the salt and the exact record for the reveal (keyless) |
| `vector_build_jury_reveal` | Reveal a committed vote in the reveal window: checks the vote, the salt and the record hash against the commitment, adds the vote to the tally and carries the record as metadata. When the reveal with the record does not fit in one transaction: first publish the same record bytes with `vector_build_document_publish` (type `juror-record`) in the reveal window, then build the reveal with `record_in_metadata: false` and `record_uri` set to that transaction's `vector-tx:` URI; the reveal then carries a `juror-record-ref` (keyless) |
| `vector_get_jury` | The followed jury deployments: their parameters and their jurors (bond, prompt hash, when each can vote, exit state, open votes) (read-only) |
| `vector_get_jury_cases` | The live jury cases: parties, the claim and evidence URIs (read from the claim and challenge outputs that the case names) and hashes, windows, ballots, tally, the result of the tally, and whether the case is the canonical case of its dispute (the claim token; the flag comes from the marketplace indexer's `GET /jury/cases`, and is unknown without it); filter by claim, challenge or agent (read-only) |

A dispute from a chat client: `vector_build_document_publish` (the claim document) → `vector_build_module1_claim`; a claimer that nobody challenged
takes the stake back after the challenge window with `vector_build_module1_withdraw_claim`; an auditor:
`vector_build_document_publish` (the evidence) → `vector_build_module1_challenge`. The relay opens a jury case for the challenge. A juror:
`vector_get_jury_cases` → `vector_get_document` (claim and evidence) → `vector_build_jury_commit` (keep the salt and the record) → in the
reveal window `vector_build_jury_reveal`. Each build is signed with `vector_signer_sign`, broadcast with `vector_submit_transaction` and
confirmed with `vector_await_transaction`.

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
| `VECTOR_IDENTITY_GATEWAY_URL` | Identity gateway behind `vector_resolve_did` and the canonical-DID path of `vector_get_agent_profile` (`GET /1.0/identifiers/{did}`). Trailing slashes are ignored | `https://id.vector.apexfusion.org` |
| `VECTOR_BLOCKFROST_URL` | Blockfrost behind the CBOR form of document metadata (`GET /txs/{hash}/metadata/cbor`): `vector_get_document` and the claim and challenge tools use it when Koios gives no JSON for the label 22084 metadata of a transaction. Read when a tool is called, so a `.env` value applies. Trailing slashes are ignored. A testnet-configured instance needs the testnet Blockfrost here | `https://blockfrost.vector.mainnet.apexfusion.org` |
| `VECTOR_IDENTITY_LEGACY_ROOT` | Identity registry deployment value: the Merkle root of the adoption allowlist (64 hex). With `VECTOR_IDENTITY_CONFIG_SEED` it gives every identity-marketplace script: the server applies the parameters of the unapplied scripts (identity-marketplace blueprint, agents-marketplace 1643583) at startup. Set both or neither; a malformed value stops the start | unset (identity tools answer "not configured") |
| `VECTOR_IDENTITY_CONFIG_SEED` | Identity registry deployment value: the seed output of the configuration seal (`<txid>#<index>`) | unset |
| `VECTOR_IDENTITY_POLICY_ID` | Optional check: the published identity policy; the start fails when the two values above give another one | unset |
| `VECTOR_IDENTITY_REF_UTXO`, `VECTOR_IDENTITY_ATTESTATION_REF_UTXO`, `VECTOR_IDENTITY_DELEGATION_REF_UTXO`, `VECTOR_IDENTITY_VAULT_REF_UTXO`, `VECTOR_IDENTITY_ESCROW_REF_UTXO`, `VECTOR_IDENTITY_ADVERT_REF_UTXO` | The reference-script UTxOs (`<txid>#<index>`) of the identity, attestation, delegation, vault, new escrow and new advert scripts. A tool that needs one that is not set names the variable; the builder checks that the UTxO holds the expected script | unset |
| `VECTOR_IDENTITY_MODULE1_REF_UTXO` | The reference-script UTxO of Module-1's `identity_party`, needed only when a record appoints Module-1 as a party (its consent withdrawal) | unset |
| `VECTOR_IDENTITY_ALLOWLIST_URL` | Optional https URL of the published adoption allowlist (JSON list of identifiers); `vector_build_identity_adopt` computes the Merkle proof from it when the caller gives none | unset |
| `GOV_PROPOSAL_SPEND_HASH`, `GOV_PROPOSAL_MINT_HASH`, `GOV_CRITIQUE_SPEND_HASH`, `GOV_CRITIQUE_MINT_HASH`, `GOV_ENDORSEMENT_SPEND_HASH` | Module-6 deployment on the identity registry: the hashes of the applied validators (its deploy state). Set every required `GOV_*` value or none; a malformed value, or a value of the previous deployment, stops the start. The build tools also need the identity deployment | unset (Module-6 build tools answer "not configured") |
| `GOV_RECORD_TOKEN_POLICY`, `GOV_REFS_TOKEN_POLICY` | The record token policy (GovernanceParams record and the head of the activity list) and the CrossRefs token policy of the Module-6 deployment | unset |
| `GOV_PARAMS_ADDRESS`, `GOV_CROSSREFS_ADDRESS`, `GOV_TREASURY_ADDRESS` | The params holder address, the CrossRefs address (the oracle holder) and the treasury holder address. The builders find the params record, the CrossRefs output and the activity list by their tokens | unset |
| `GOV_PROPOSAL_SPEND_REF`, `GOV_PROPOSAL_MINT_REF`, `GOV_CRITIQUE_SPEND_REF`, `GOV_CRITIQUE_MINT_REF`, `GOV_ENDORSEMENT_SPEND_REF` | The reference-script UTxOs (`<txid>#<index>`) of the five validators; a tool that needs one that is not set names the variable | unset |
| `VECTOR_MODULE1_MANIFEST` | The Module-1 deployment manifest (`vector-module-deploy/1`, as `Module-1/scripts/identity_deploy.py` writes it): a file path or an https URL (pin a commit, for example a `raw.githubusercontent.com` URL). The claim and challenge tools build against it: the claim and challenge scripts, their reference-script UTxOs, the `cross_refs` and `params` outputs and the protocol parameters. Only a deployment in oracle mode is accepted. The path is checked at startup; the manifest is read at the first call of a tool that needs it, and each reference script is checked against the chain | unset (the claim and challenge tools answer "not configured") |
| `VECTOR_JURY_MANIFESTS` | The jury deployment manifests (`vector-module1-jury-deployment/1`, as the jury deploy tool writes them): file paths or https URLs, comma-separated, the default deployment first. The juror and jury read tools follow every one. Each manifest's `params_cbor` must give its `params`, its address must be the address of its script hash, its reference script must hold that script on chain, and its identity and Module-1 hashes must match `VECTOR_MODULE1_MANIFEST` and the identity deployment when those are set | unset (the juror and jury tools answer "not configured") |
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

The tool `vector_verify_signature_at` needs `VECTOR_OGMIOS_URL` and `VECTOR_IDENTITY_GATEWAY_URL` on the same network. Otherwise it cannot check that the gateway is current, and its answers are not reliable.

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

Requires `mnemonic.txt` in `packages/builder/` containing a **funded Vector testnet** mnemonic. Covers the core tools end-to-end against Vector testnet, including discover, profile and, without submitting, the identity registration and the legacy deregistration (the legacy registration tools are retired; the Module-6 section uses a legacy record that the wallet owns). Also runs `keyless-build.test.ts`, `registry-keyless.test.ts`, and `self-improvement-keyless.test.ts` - tier-1 suites needing no mnemonic at all, each building unsigned transactions against live public data only (`vector_build_send_tokens` is covered offline, by unit tests and the legacy suite above; `self-improvement-keyless.test.ts` covers critique, endorse, and proposal-lock builds, plus a not-found rejection path on proposal-spend). Set `VECTOR_E2E_SUBMIT=1` to additionally run each family's gated end-to-end suite, fully on-chain: `keyless-e2e.test.ts` lands one real self-send (~0.16 AP3X fee); `registry-e2e.test.ts` runs the identity registry lifecycle register → update → retire → reclaim (only when the identity deployment variables are set as well); `self-improvement-e2e.test.ts` locks and spends a real improvement proposal through the deployed module validator with a legacy record that the wallet owns, then critiques and endorses it (≈48 AP3X in stakes and module minimums, plus four transaction fees, one-way - the stakes are locked by the module's own design, not lost). Set `LEGACY_FULL=1` to additionally exercise the same self-improvement lock → spend sequence inside `run.test.ts` itself (off by default, since `self-improvement-e2e.test.ts` already proves that exact path). Never runs in CI.

```bash
npm run test:smoke:signer
```

Builds the local signer (`packages/signer`), boots it over stdio, and exercises all five of
its tools, including the fail-closed audit-write-failure path and input resolution against a
local Ogmios stand-in. No wallet, no external network. CI runs
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
