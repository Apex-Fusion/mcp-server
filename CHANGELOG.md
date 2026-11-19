# Changelog

## Unreleased

### Added

- **Reputation stake tools on the deployment for the identity registry** (`Module-3/reputation-staking` of
  vector-agent-modules; reputation validator `fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424`, on Vector
  mainnet since 2026-11-03): 4 new tools, 78 in all.
  - Builds: `vector_build_reputation_stake_open` (step 1: the opening output) and `vector_build_reputation_stake` (step
    2: CreateStake) make a stake. `vector_build_reputation_stake_increase` (IncreaseStake),
    `vector_build_reputation_stake_update_capabilities` (UpdateCapabilities) and
    `vector_build_reputation_stake_decrease` (DecreaseStake) act on it. Each build returns the unsigned transaction and
    every key hash that must sign it, with its role: the controller key of the agent, the owner key of the stake, and
    the wallet (an exit needs the controller key only, besides the wallet). Step 1 is the exception: no script runs, and
    only the wallet signs. Each other build checks the rules of the validator before it builds, and Lucid runs the
    deployed validator on the transaction; the fee pays for the
    reference script. The window comes from `valid_minutes` (1 to 59); `last_updated` of the stake is its upper bound.
  - The agent is an identity DID (`did:vector:<64 hex>`), in the parameter `did` as in the identity tools. The create
    tool checks that the record is Active over the window (ancestors included) and lists each capability byte for byte,
    and that the owner key is the controller key or a key that the record lists with the transaction purpose. The owner
    of the stake is `owner_key_hash` when it is passed. When it is not, step 1 takes the key of `changeAddress`, and
    step 2 takes the owner that the opening output names, if the record declares that key now; if it does not, step 2
    refuses, names that key, and says to pass `owner_key_hash` with the controller key or a listed key with the
    transaction purpose. The validator reads the owner of the stake, not the owner in the opening output: when the
    stake gets another owner than the opening output names, the answer of step 2 says so (and the JSON has
    `opening_owner_key_hash`). `amount` locks more than the module minimum. The datum has 8 fields: `challenge_locks`
    and `stake_id` (the output reference of the opening output) are new. The parameters output and the cross references
    are found by their tokens at the params holder, as the validator does; only the reference script is pinned by its
    output reference. The answer of step 1 names the `owner_key_hash` and the `amount` to pass to step 2, as a number
    in the block `step_2` that step 2 takes as it is.
  - One stake for each agent: the create tool and the opening tool refuse an agent that has a stake, and name the stake
    and the increase tool. When an opening output that names the agent is also at the address, the refusal says that only
    a CreateStake can spend an opening output, and that these tools make no second stake. It then lists the opening
    outputs with their AP3X and owner (see the next point for the bound). The owner cannot withdraw the module minimum
    (10 AP3X), so a second create after a retry would lock it twice. The increase, update and decrease tools take
    `stake_ref` when an agent has more than one stake.
  - Opening outputs: the opening tool refuses while an opening output that names the agent is at the address. The
    refusal first says that step 2 can spend any of them with any owner key that the record declares, and names the new
    input `allow_second_opening` (boolean, default false), which builds a new opening output all the same for the case
    that step 2 cannot use the one that exists; each opening output locks its AP3X until a CreateStake spends it. It
    then lists the opening outputs with their AP3X and owner: at most 5, those whose owner the record declares first
    (each group in the order of the node), and the number of the rest ("and N more"). An error keeps 800 characters, so
    the way out comes before the list. The answer of a second opening lists the opening outputs that existed in the same
    way: `other_openings` (at most 5) and `other_openings_more` in the JSON.
  - `vector_get_reputation_stake` reads the stakes of 1 to 50 agents with one Koios `asset_utxos` call (the stake token
    name is `rstk_` and 27 bytes of the blake2b-256 of the identifier): each stake with its `stake_amount`, capabilities,
    `last_updated`, number of challenge locks, `stake_id` and the AP3X in the output, and the sum of `stake_amount`, which
    is 0 for an agent with no stake. The read is in `reputation-read.ts`, which imports only `reputation-datum.ts`.
  - The tools need no new setting. The build tools use the identity registry of the server, and refuse when it is not
    configured and when its policy is not the one that the reputation validator reads (`d958b823…`).
    `vector_get_reputation_stake` needs no identity registry. All six refuse when the node is not on Vector mainnet.
  - Removed: `REPUTATION_TAKES_NEW_STAKES`, the refusal text, the values of the earlier Module-3 deployment (reputation
    `5168e187…`, which keeps its positions) and the read of the legacy registry. The parameter `agent_id` of the two
    tools is now `did`, and a DID of the legacy registry is refused with the identity form named.
- **Module-1 disputes and the Module-1 jury** (`Module-1/jury/SPEC.md` of vector-agent-modules): 11 tools, 74 in all.
  - Documents on chain: `vector_build_document_publish` builds a transaction that carries a UTF-8 document as
    metadata under label 22084 (text chunks of at most 64 bytes, split at character boundaries, no chunk starts with
    `0x`) and returns the URI `vector-tx:<unpadded base64url transaction id>` and the blake2b-256 hash.
    `vector_get_document` reads a `vector-tx:` document from Koios (`tx_metadata`) or an https document, and checks
    an expected hash. When Koios gives no JSON for the label 22084 metadata of a transaction (db-sync leaves out the
    metadata of some transactions), the reader takes the CBOR form, as the specification says: Koios `tx_cbor`, then
    Blockfrost `/txs/{hash}/metadata/cbor`. Both forms go through the same checks. `VECTOR_BLOCKFROST_URL` sets the
    Blockfrost URL (default: the Vector mainnet Blockfrost).
  - Module-1 in oracle mode: `vector_build_module1_claim` (SubmitClaim) and `vector_build_module1_challenge`
    (OpenChallenge with MarkChallenged, state PendingOracle) port `build_submit_claim` and `build_open_challenge` of the
    Python builders: the same datums, token names from the first input in ledger order, reference inputs, window and
    signer. Without a document hash they read the document from its URI. URIs are at most 64 bytes. The challenge tool
    warns when the resolution deadline leaves the jury less than 6 h 10 min. The challenge tool finds the claim by its
    payment credential, as Module-1 does: a claim at an address with a stake part can be challenged (by token name
    through Koios, or by output reference), and the continuing claim output stays at the address of the claim.
  - Juror actions: `vector_build_jury_register`, `vector_build_jury_exit` (steps `request` and `exit`),
    `vector_build_jury_topup`, `vector_build_jury_commit` (it makes the salt when none is given and returns it) and
    `vector_build_jury_reveal` (it checks the commitment first and carries the juror record as metadata; with
    `record_in_metadata: false` it builds the reveal without the record, for a record that does not fit, and says to
    publish the record as a `juror-record` document in the reveal window). They check the rules of the jury contract
    before they build, and Lucid runs the jury script on each build.
  - Reads: `vector_get_jury` (deployments, parameters, jurors and when each can vote) and `vector_get_jury_cases`
    (live cases with ballots, tally, windows, the result of the tally, the claim and evidence URIs from the claim and
    challenge outputs of the case, and the canonical flag of the dispute from the marketplace indexer's
    `GET /jury/cases`; filter by claim, challenge or agent).
  - Document rules: a document with U+0000 or the JSON escape `\u0000` is refused; a reader refuses a type or media
    type that starts with `0x`.
  - Configuration: `VECTOR_MODULE1_MANIFEST` (the Module-1 manifest) and `VECTOR_JURY_MANIFESTS` (the jury
    manifests, comma-separated, the default first), as file paths or https URLs. No defaults: without them the tools
    say which variable to set. A malformed value stops the start; the manifests are checked against each other and
    each reference script against the chain at the first call of a tool that needs them.
- **`vector_build_module1_withdraw_claim`** (Module-1 `WithdrawClaim`): the claimer takes the stake of a claim that nobody
  challenged back after its challenge window. The build spends the claim with the `WithdrawClaim` redeemer, burns the
  claim token with the same redeemer, and pays exactly the stake to the wallet in one output. No claim output continues.
  The claim script, the cross_refs output and the params output are reference inputs, as in the withdrawals of the Python
  builder (`build_withdraw_claim`). The tool refuses before it builds when the claim is not Open, when the challenge
  window has not ended (the transaction must start after `submitted_at + challenge_window`, so it says the first second
  to build from) and when the wallet key is not the claimer credential. The claim is named as for the challenge tool, by
  token name or by output reference. Module-1 checks no identity record for a withdrawal. The build pays the fee of the
  claim script, which the spend and the burn both use. 79 tools in all.
- **`ledgerDecides` option of the vault payment builder** (`buildVaultPay` in `vault-build.ts`, library only: the hosted
  tool `vector_build_vault_pay` takes no new input and does not change). With the option, the builder makes no refusal of
  its own for the per-transaction limit, the period total, the use checks of the delegation, the delegator, the other
  assets of the vault, the value cap, the indexer listing and the listing rule. The refusal of a fleet capability stays.
  The builder reads the advert from the node (`readAdvertFromNode`), and the node evaluates the scripts
  (`localUPLCEval: false`). The result has four kinds, told apart by type. A build. `VaultPayRefused`: a validator of the
  transaction ran and failed (the node answered `evaluateTransaction` with the code 3010 and a validator error 3012 in its
  data). It holds the code and the message of the node (`evaluationError`), the error of each validator (`validators`:
  purpose, index, code, message, detail, traces) and the draft transaction that the node evaluated. `VaultPayNotEvaluated`:
  the node answered with an error and no validator failed, for example a validity range beyond the end of the era that the
  node can foresee (the code 3004 inside 3010). The scripts were not evaluated, so it is no refusal. `VaultPayImpossible`
  with a `reason`: no vault output, a vault that is not Live, no delegation output or record to read, no advert output or a
  retired one, a delegate key that is the supplier key (`buyer_is_supplier`), advert terms that no escrow can carry or an
  advert of a fleet capability (`advert_terms`), and a rest below the ledger minimum of the vault output. Any other error is
  no answer of the node: a network error, a timeout, an answer that is no JSON-RPC error, an error of another provider. It
  stays an ordinary error and is no verdict. `judgeEvaluation` gives the kind of an error. `isLedgerRefusal` is true only for
  the failed validator: the `OgmiosRpcError` above, and the `VaultPayRefused` that holds it (a `VaultPayNotEvaluated` is false,
  whatever its cause is). The draft transaction
  (`draftTx`) holds the placeholder witnesses that Lucid adds to size it (no real key, no real signature) and no collateral.
  It is no transaction to submit.
- **`OgmiosRpcError`** (`@apexfusion/vector-mcp-shared/provider`): OgmiosProvider throws it, in place of a plain Error, when
  Ogmios answers with a JSON-RPC error object (`{ error: { code, message, data? } }`), with an HTTP status that is not OK or
  with one that is OK. Its `message` is the message of the plain Error, byte for byte, so no tool text changes. It adds
  `method`, `code`, `rpcMessage` and `data`. URLs and the configured hosts are removed from `rpcMessage`, and from each string
  and each key of the data before the text is made, so `data` stays valid JSON. Nothing of the request is in the error. The
  lines of `console.error` do not change. `data` has three states. `undefined`: the node sent no data. A text of at most
  `OGMIOS_ERROR_DATA_LIMIT` characters (`dataTruncated` says that it was cut, and a cut text is no longer JSON). `null`:
  the provider dropped the data, and `dataDropped` is true. It drops a data that is larger than
  `OGMIOS_ERROR_DATA_INPUT_LIMIT` (the lengths of the strings and keys, and one for each value) or deeper than
  `OGMIOS_ERROR_DATA_DEPTH_LIMIT` levels, without reading the rest of it, and a data for which anything fails while the
  text is made. A failure with the data never replaces the error: the same `OgmiosRpcError` comes, with the same message.
  The patterns that remove the endpoints are built once for each error.
- **Read and check tools for attestations, delegations and vaults** (Part 2 Sections 4, 5.2 and 5.3 of the identity registry): 6 tools, 85 in all. They only read: they build, sign and submit nothing.
  - `vector_get_attestation` shows an attestation by its identifier: every datum field, the status now, the output, the
    deposit, and the time from which the issuer can withdraw the deposit. The reason of a revocation is shown exactly, whatever its
    size. `vector_list_attestations` lists the attestations about a subject, from an issuer (a DID, a key hash, a public key, or
    64 hex that name an identifier or a key), or both, newest first, with an optional type, a limit and an offset. Koios lists the
    outputs at the attestation credential that hold an attestation token and whose datum holds the bytes of the subject (or, with no
    subject, of the issuer), in one read: the limit of 5,000 or more outputs is then the limit of one subject or one issuer. An issuer
    that is given by its key hash alone has no bytes in a datum to filter by, so that read takes every attestation output and fails
    when 5,000 or more exist. Each row must be an authentic output (exactly at the attestation address, with exactly one attestation
    token). The subject, the issuer and the type are compared on the decoded datum. An output without the token is not listed and does
    not count. An attestation whose datum writes those bytes in a non-standard form (a byte string in chunks) is not listed:
    `vector_get_attestation` reads it by its identifier. With neither a subject nor an issuer, Koios pages the list in the order of the
    output reference, the answer has no total, and a type needs a subject or an issuer. The rows are as Koios lists them:
    `vector_get_attestation` and `vector_check_attestation` confirm one attestation on the node. A revoked attestation whose reason is
    above 2^53 stays in the list.
  - `vector_check_attestation` checks an attestation against the validity rule of Section 4.3 at a time (default now). It lists each
    condition with its result: authentic, active, inside `valid_from` and `valid_until` and not more than one hour before `issued_at`,
    the envelope signature, and no invalid-from time of the issuer identity or its ancestors at or before `issued_at`. It then lists
    each expectation of the caller: type, subject, issuer (a DID matches `issuer_id`; a key hash or public key matches the issuer key
    by its key hash; 64 hex match by either reading) and digest. `issued_at` is the end of the validity window of the transaction, so
    the check does not refuse an attestation because `issued_at` lies after the time of the check. It refuses a time more than one
    hour before `issued_at`, because the attestation did not exist then.
  - `vector_get_delegation` shows a live delegation with its chain of parents up to the root, or says that it is not live.
    `vector_check_delegation_use` lists the problems that stop a delegation from being used for an action on a resource at one
    instant: the delegation and every ancestor exist, each delegate is Active and lists its delegation key, a root delegator agent is
    Active, the period holds the instant, and the patterns cover the action and the resource (the pattern rule of Section 5.1). A
    transaction needs its whole validity window inside the period, so usable is for that one instant. An optional minimum number of
    confirmations applies to each link. Each record is read once for a call.
  - `vector_get_vault` shows vault outputs, Live and Returned, by output reference, by owner key hash or by delegation, in pages (`limit`
    and `offset`). Anyone can write a vault output with any datum, so the outputs whose owner is the delegator of their delegation come
    first, the one with the most AP3X first, then the other Live outputs, then the Returned ones. An output whose datum is not a vault
    datum is not listed (a read by output reference says why). When 5,000 or more delegations exist, the delegations are not read for
    the order: it is by output reference only, and the answer says so. Only the outputs of a page are read further, each delegation and
    each record once. One request to the node confirms the page: a row that the node does not hold is spent, or the indexer is ahead,
    and it cannot pay. For a Live output it says whether the output can pay a marketplace escrow now (the owner is the delegator, no
    link is missing, the use checks find no problem, and a payment can lock at least the ledger minimum of the smallest escrow
    output) and, if not, why not. The smallest escrow output is the Open escrow with the delegate key and the refund to the vault. The
    answer gives its ledger minimum and the floor of `vector_build_vault_pay`, which is higher. Only an output that can pay gets
    `remaining` and `next_max`. `next_max` is the most that the next payment may lock: it also keeps the ledger minimum of the next
    output. A delegation that cannot be read is reported on its output and does not stop the others. A read also fails when 5,000 or
    more outputs match one Koios filter: read by delegation instead of by owner key hash, or the reverse. An organisation of an owner
    above 64 bytes is not shown.
  - Each of the six tools runs inside one budget of 30 s. The call ends with an error when the node or Koios answers too slowly, or
    when the read needs too many requests. At the end of the budget each Koios request of the call is aborted, and no request starts
    after it. A node request that is already open ends by the time limit of its HTTP client.
  - Text from the chain (a locator, a contest reply, an organisation, a pattern) is cleaned in the markdown and in the JSON text fields:
    one line, no pipe or backtick, no invisible or direction-changing character (zero-width characters, the soft hyphen, the byte
    order mark, variation selectors, tag characters), a length limit. The `_hex` fields keep the verbatim bytes.
  - The library files `ledger-read.ts`, `attestation-read.ts`, `delegation-read.ts` and `vault-read.ts` hold the reads with typed results,
    and `escrowPaidFromVault` (in `vault-read.ts`) tells whether an escrow was paid from a vault under a delegation: it reads the
    transaction that made the escrow and looks for a vault input that the vault script spent with the Pay redeemer. A transaction with
    a vault input and no script list is an error. Each script run of a Koios row has a `valid_contract`, and the top level of a row of
    the Vector Koios has none. A Pay run of the vault script counts only when its own `valid_contract` is true: false is
    `contract_failed`, and no value, or one that is not true or false, is an error, never `paid` and never `not_a_payment`. A caller
    waits for confirmations before it trusts the answer. Koios answers are read to 16 MiB at most. `readVault` is exported.
- **Delegation co-signature** (`vector_delegation_request_cosign`): 1 tool, 86 in all. A Delegate transaction needs a
  signature of the delegate key, and only the delegate agent holds that key. The tool takes the transaction
  (`txCbor`, unsigned or signed by the delegator) and nothing else. It reads the delegate from the transaction, finds
  the `endpoint` in the identity record of the delegate, and sends the transaction to
  `POST <origin of the endpoint>/cosign/delegate` through `safeFetch` (route contract, version 1: the body is
  `{ "transaction": hex }`, the answer is `200 { "transaction": hex }` or a 4xx `{ "error": code, "message": words }`
  with the code `not_a_delegation`, `not_for_this_agent`, `key_in_use`, `principal_not_allowed`,
  `spends_agent_funds` or `expired`). **An agent must serve this route for the tool to work.** The README gives the
  route contract for operators: what the agent learns, the route is public, and the rules for when the agent signs.
  - Before it sends, the tool refuses what it can check without running the scripts. The node checks everything, and
    runs the scripts, when the user submits. Some refusals follow a rule of the ledger or of the delegation contract:
    the transaction is marked valid and mints exactly one token of the delegation policy, has one output at the
    delegation address with that token alone and a valid delegation datum, lists the delegate key as a required
    signer, carries only witnesses whose signature verifies over the body hash, and reads no output that it spends.
    Its validity window has a start and an end, is at most one hour long, and has not ended. The delegate is `Active`
    over the window (ancestors included), and its record lists the delegate key with the delegation purpose and has
    an `https` endpoint. Every input, collateral input and reference input is on the node.
  - Other refusals are the scope of this tool and not rules of the ledger. They bound what an agent is asked to
    sign: a second minted policy, a withdrawal, certificate, vote, proposal, donation or treasury value (also when it
    is empty or 0), a witness of the delegate key that the transaction already has, and a period of 2^53 ms or more.
  - The tool reads the keys of the body from the bytes (`readTransactionBody` in `tx-body.ts`) and refuses before the
    decoder library reads the transaction. It refuses when the bytes are not a transaction with a well-formed body, and
    when the body has one of the keys 4, 5, 19, 20, 21 or 22. The same reader takes the bytes of the body of the
    answer, and the tool compares them with the body that it sent before the decoder library reads the answer. The
    reader and `readTransactionFee` share one CBOR reader (`cborReader` in `tx-fee.ts`): a loop and a list, no
    recursion, and a time linear in the size of the input. `readTransactionFee` keeps its behaviour.
  - If one check fails, the tool sends nothing, and its text says so. It sends only to the origin of the endpoint
    in the record, never to an address that the caller gives. The request has the user agent
    `vector-mcp-builder/<version>` and nothing else besides the content type and the accept header.
  - The server sends at most 3 requests a minute for each caller to one origin, and at most 30 a minute to one origin
    for all callers together. The limit for each caller stops one caller from using the whole budget of an agent.
    Both counts are in memory and bounded, and a refused request does not count.
  - From the answer, the tool takes one thing: the vkey witness of the delegate key, with the same body hash and a
    signature that verifies over it by the rules of the ledger (a public key or a signature point of small order, and an
    unreduced scalar, do not verify). It adds that witness to the transaction that the caller gave. Only the list of
    vkey witnesses is written again. The body, the validity flag, the auxiliary data, each other entry of the witness
    set and each witness that the caller sent keep their bytes, so the agent cannot change them. If the answer is
    refused, nothing from the agent comes back.
  - The tool never shows a word of the agent. A refusal shows its code, in the words of the tool, when it is one of the
    six codes. Any other code shows as "the agent refused". The text of an endpoint is never repeated. A failure says
    whether the host received the transaction (a redirect always says that it did), and a failure after a send names
    the host when it is a plain name. Any other host shows as "a host with unusual characters".
  - The result gives the co-signed CBOR, the validity window, the keys that have signed, the keys that are still missing
    and the next step. The tool holds no key, adds no signature of its own and submits nothing.

### Changed

- `vector_dry_run` reads the fee of a given transaction (`txCbor`) from its bytes, and does not decode the
  transaction. A transaction whose fee it can read (the unsigned integer under key 2 of its body) goes to the
  evaluation of the node, and the node judges the rest of it. A `txCbor` from which it cannot read the fee is refused
  with the same message as before. The fee shows in full above 2^53 lovelace. The reader is
  `packages/builder/src/vector/tx-fee.ts`.
- The builder reads every address through one checked function (`addressDetails` in
  `packages/builder/src/vector/guarded-decode.ts`). It refuses the empty string with the message that Lucid gives
  for text that is not an address, and then calls `getAddressDetails`. No tool text changes. A test names each call
  of `getAddressDetails`.
- After each tool call the server checks that the stack pointer of the decoder library is back at its start value,
  and puts it back when a failed call left it changed. It reads the start value two times when it starts. A pointer
  below the start value is put back, and one line with the difference goes to stderr. A pointer at the start value
  or above it is not touched. A library with no such export is not checked. The put back runs before the check of the
  known value (next entry), so a call that left the pointer low does not stop a process whose library works again.
  The put back does not give back other memory that a failed call of the library took: the check with the stop stays
  the last line.
- The server stops when its decoder library cannot decode a known value, so that its supervisor starts it again.
  After each tool call, the decoder decodes one known value (the Plutus data `d87980`). When it cannot, the server
  writes one line to stderr, stops listening, and ends with code 1 when the answer of the call is written, at the
  latest 3 seconds later. A call of another client that needs longer than that gets no answer. The containers run
  with `--restart unless-stopped`, so a process that ends comes back by itself. Nothing changes for a decoder that
  works. The check covers the decoder library only, not the script evaluator of Lucid (a separate WebAssembly
  instance). The entry point (`packages/builder/src/index.ts`) sets the stop and starts the check of the stack
  pointer: a program that imports the builder as a library gets neither.
- The server limits the size of what a caller sends. A POST to `/mcp` with a body of more than 131,072 bytes gets
  HTTP 413 and a short JSON answer. The server counts the bytes as they arrive, so a body with no `content-length`, or
  with one that is not true, gets no more room, and the server takes no more bytes from the connection after the
  limit. A body inside the limit gets the answer that it got before, also a body that is not JSON. The limit is far
  above every valid request: the largest input of a tool is a transaction of 32,768 hex characters. The body is
  parsed one time, and the transport gets the parsed body. A text of more than 1,024 characters is refused as an
  address, before Lucid reads it, with its length and its first 40 characters (no valid address is that long).
  The metadata of `vector_build_send_apex`, `vector_build_transaction` and `vector_dry_run` is read one time before
  Lucid gets it. Metadata that no transaction can hold gets a short refusal: a value that is not a text of at most
  64 characters, a number, a list or a map, a number that is not a whole number between -2^64 and 2^64, more than
  63 levels of lists and maps, or more than 16,384 bytes (the most that a transaction has). Before, Lucid or the
  library refused such metadata, and a refusal of Lucid repeated
  the metadata. Nothing else changes: no tool text, no schema, and no answer for an input
  inside the limits. A test gives each string input of each of the 86 tools a text of up to 131,072 characters in
  several shapes, also JSON with many levels, and checks that the tool answers within one second.

### Fixed

- `cell`, which cleans the text of a datum or an advert for one line of a tool answer, handles more characters. A C1 control (U+0080 to
  U+009F) becomes a space, as a C0 control does. The zero-width characters and direction marks (U+200B to U+200F), the embedding and
  override controls (U+202A to U+202E) and the isolate controls (U+2066 to U+2069) are removed. They could hide a word or reorder
  the text around them in a line that the assistant reads.
- `vector_build_module1_claim` and `vector_build_module1_challenge` pay the fee of the reference scripts
  (15 lovelace for each byte of each reference script in the transaction). Their fee was below the ledger minimum:
  by 0.107295 AP3X for a claim (the claim script) and by 0.185145 AP3X for a challenge (the challenge script), because
  the fee of a reference script that only the mint uses was not added. The node refused each transaction that was
  signed as built (Ogmios error 3122, "Insufficient fee"). The builds now complete with the coin selection of Lucid,
  which adds this fee. The wallet inputs do not change. A challenge pays about 0.107 AP3X above the minimum, because
  the fee counts the claim script two times: as a reference script, and as the script of the claim output that the
  transaction spends.
- `vector_dry_run` of a given transaction (`txCbor`) shows the fee that the transaction declares. It showed
  0 AP3X. A `txCbor` from which the fee cannot be read is refused before the evaluation.
- `vector_get_agent_profile` of a canonical DID shows as "Registered" the block time of the transaction that first
  minted the identifier (`created` of the resolution result). It showed the record's `created_at`, which is the end
  of the validity window of the creating transaction (up to one hour later). The record's `created_at` shows on its
  own line, and the JSON block adds `created`.
- `vector_build_send_apex`, `vector_build_send_tokens`, `vector_build_transaction`, `vector_build_deploy_contract`
  and `vector_build_interact_contract` list the key hashes that must sign (the wallet key, and any key that the
  transaction names as a required signer) before the unsigned CBOR, and in a JSON block with `tx_hash`, `fee` and
  `required_signers` (`[{ key_hash, roles }]`), as the identity and marketplace tools do. The ledger refuses a
  transaction that is submitted without these signatures.

## 3.0.0 - 2026-11-03

The identity release (PR #26) and the escrow switch (PR #27). The builder adds keyless tools for the `did:vector`
identity registry: records, attestations, delegations and vaults. The marketplace tools read and spend both escrow
and advert layouts. From the escrow switch (mainnet slot 37226741) on, they create identity-layout adverts and
escrows only. The legacy registry writes and `vector_build_message_agent` are retired. The signer adds
`vector_signer_get_public_key`, accepts partly signed transactions, and can count only the value that its own inputs
fund. All packages, `server.json` and both advertised MCP server identities are at 3.0.0. The marketplace tools of
PRs #20 to #24 (read, escrow build and transport) came after 2.0.0 without entries of their own; this version
includes them.

### Breaking

- **The legacy registry writes are retired** (Part 2 Section 10): `vector_build_register_agent`,
  `vector_build_update_agent` and `vector_build_transfer_agent` are removed with their builders. New records go
  to the identity registry (`vector_build_identity_register`); a legacy record moves there with
  `vector_build_identity_adopt`. `vector_build_deregister_agent` stays for legacy records that do not adopt.
- **Two escrow and advert layouts during the drain** (Part 2 Section 6): the marketplace tools read both the legacy
  layouts and the identity-marketplace layouts (escrow: `agent_id` and `refund`; advert: `agent_id`), and every
  post refuses an escrow above the 10,000 AP3X value cap (payment + both bonds).
- **The escrow switch** (Part 2 Section 9.6): from mainnet slot 37226741 (2026-11-03T13:25:41Z,
  `ESCROW_SWITCH_SLOT`), compared with the chain tip as the agents-marketplace gateway compares it, the builders
  create identity-layout adverts and escrows only. `vector_build_marketplace_post_escrow` refuses a legacy-layout
  advert, and `vector_build_marketplace_post_advert` refuses before it reads the wallet. The refusals name the
  identity-layout tool to use (`vector_build_marketplace_advert_post`). Accept, reclaim and release of legacy escrows,
  and the retire of legacy adverts, stay until the drain ends. A chain tip that the node cannot give is a refusal.
- **`vector_build_message_agent` is retired** (Part 2 Section 10 of the identity registry plan). Its builder,
  the label-674 constant and the `metadataStr` helper are removed.
- **`vector_discover_agents` reads the marketplace indexer** (`/suppliers`, which applies the listing rule)
  instead of scanning the legacy registry address. It lists agents that have a listed advert and names their
  `did:vector:<id>` DID when the advert names one. The `framework` filter is removed: the indexer has no
  framework field (use `vector_get_agent_profile` for the profile). `limit` is now an integer from 1 to 100.
- **The legacy registry constants move to `legacy-registry.ts`** (`LEGACY_REGISTRY_SCRIPT_CBOR`,
  `LEGACY_REGISTRY_POLICY_ID`, `LEGACY_REGISTRY_DEPOSIT`, `legacyRegistryScript()`, `legacyRegistryAddress()`,
  `legacyDid()`). `gov-build.ts` no longer exports `AGENT_REGISTRY_POLICY` and no longer reads the
  `AGENT_REGISTRY_POLICY` environment variable.
- **The self-improvement tools move to the Module-6 deployment on the identity registry** (Part 2 Section 7). The
  `GOV_*` settings name that deployment and have no defaults: `GOV_{PROPOSAL,CRITIQUE,ENDORSEMENT}_SPEND_HASH`,
  `GOV_{PROPOSAL,CRITIQUE}_MINT_HASH`, `GOV_RECORD_TOKEN_POLICY`, `GOV_REFS_TOKEN_POLICY`, `GOV_PARAMS_ADDRESS`,
  `GOV_CROSSREFS_ADDRESS`, `GOV_TREASURY_ADDRESS` (all or none; a value of the previous deployment stops the start) and
  the reference scripts `GOV_{PROPOSAL,CRITIQUE,ENDORSEMENT}_SPEND_REF`, `GOV_{PROPOSAL,CRITIQUE}_MINT_REF`.
  `GOV_PARAMS_UTXO`, `GOV_ORACLE_UTXO` and `GOV_CROSSREFS_UTXO` are gone: the builders find the GovernanceParams
  record, the 5-field CrossRefs output and the head of the activity list by their tokens. The build tools also need
  the identity deployment.
- **`agentDid` is a `did:vector` agent**: the canonical DID, the legacy DID form or the bare 64-hex identifier of an
  identity record (it was the asset name of a legacy registry NFT). The record and its ancestors are reference inputs,
  the record must be Active over the validity window (at most one hour), and the datum names a declared credential
  (`credentialKeyHash`: the controller key or a listed transaction key; default the wallet key), which signs step 2.
- **Critiques and endorsements take two steps**, as proposals do: `vector_build_self_improvement_critique` and
  `_endorse` lock the stake, and the new `vector_build_self_improvement_critique_spend` and `_endorse_spend` create the
  position and mint its token (`crit_`, `gend_`). A critique or an endorsement names its proposal by the seed (the lock
  that its submission spent); `proposalTxHash` takes the seed or the proposal's current output. The first submission of
  an agent inserts its node into the activity list. Steps 2 run the applied Module-6 validators locally at build time.
- `vector_self_improvement_browse` and `_analyze_metrics` read the current deployment, or the previous one with
  `deployment: 'previous'` (its positions stay until their owners exit). The `proposalTxHash` filter takes the seed or
  the current output of the proposal. `scripts/capture-gov-state.mjs` (a capture of the previous deployment) is removed.

### Added

- **Advert tools, one per action** (PR #25 merged into the identity layout): `vector_build_marketplace_advert_post`,
  `_advert_update` and `_advert_retire`. One set of terms rules holds in both layouts: `capability_id` and `model` at
  most 64 bytes of UTF-8, `endpoint_url` and `detail_uri` at most 64 bytes in the legacy layout (its encoder writes
  each field as one bytestring) and 256 in the identity layout (its encoder splits long bytestrings), no fleet
  capability id, an https endpoint without whitespace, query or fragment (jobs go to
  `<endpoint_url>/v1/job`), a processing window from 60,001 ms (the shortest a supplier template serves) to 24 h,
  price + both bonds at most 10,000 AP3X, and a `detail_uri` only with the caller's `detail_hash` (the server fetches
  nothing). `vector_build_marketplace_advert_retire` also retires a legacy-layout advert (the supplier template's
  Retire, evaluated against the deployed advert validator in the unit tests), so suppliers retire their legacy
  adverts during the switch; `vector_build_marketplace_retire_advert` of PR #25 is gone.
- `vector_build_marketplace_post_advert`: legacy layout, refused from the escrow switch on (see Breaking). Before
  the switch, it posts a legacy-layout advert byte-identical to the supplier template's (pinned against the service
  agents' live adverts), with the same terms rules.
- `vector_build_reputation_stake_open` and `vector_build_reputation_stake`: an agent's Module-3 reputation
  self-stake in two keyless steps, ported from the reference Python SDK (`Apex-Fusion/vector-agent-modules`,
  `Module-3/python/reputation_staking`). In 3.0.0 both tools refused before they read anything, because the Module-3
  deployment of that time took no new stakes. The deployment for the identity registry went on chain at
  2026-11-03T15:09Z, one hour after the release. Both tools build on it since the entry "Reputation stake tools on
  the deployment for the identity registry" of the Unreleased section.
- Module-1's consent withdrawal reads the reward balance with no default: Ogmios's reward account summary, else
  Koios `account_info` (Vector's Ogmios has no summary for a registered stake credential that is not delegated). A
  stake credential that is not registered, or a read that fails, is refused; the balance is never taken as 0.
- **Identity registry build tools** (`did:vector`, Part 2 Sections 3 and 10), keyless: `vector_build_identity_register`
  (also subagents), `_adopt`, `_update`, `_change_controller`, `_suspend`, `_unsuspend`, `_revoke`, `_retire`,
  `_reclaim`, `_set_successor`, `_recovery_start`, `_recovery_cancel`, `_recovery_complete`, `_end_subagents`.
  Every build returns the unsigned transaction and every key hash that must sign it, with its role; each key
  holder signs in turn with `vector_signer_sign`. Lucid runs the applied identity script on each build.
  Register, adopt and update refuse an appointment that Module-1 would not consent to before they build. A
  revocation takes `invalid_from` from one hour before the record's `created_at` up to the start of the validity
  window, so a key-compromise revocation right after the registration is possible.
- **Attestation, delegation and vault build tools** (Part 2 Sections 4 and 5): `vector_build_attestation_attest`,
  `_revoke`, `_contest`, `_withdraw`; `vector_build_delegation_delegate`, `_undelegate`;
  `vector_build_vault_open`, `_pay`, `_close`.
- **Marketplace tools for the identity layout** (Part 2 Section 6): `vector_build_marketplace_release`,
  `vector_build_marketplace_refund_revoked`, `vector_build_marketplace_advert_post`, `_advert_update`,
  `_advert_retire`. Post escrow takes `agent_id` from an advert that the indexer lists and sets the refund to the
  buyer's own address; accept, reclaim and release work in both layouts; receipts are checked with 8 fields
  (legacy escrow) or 9 fields with `agent_did` (identity escrow); the supplier lists show the agent DID; the
  escrow lineage follows both escrow credentials.
- **Identity deployment configuration**: `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` (both or
  neither), optional `VECTOR_IDENTITY_POLICY_ID`, the reference-script UTxOs `VECTOR_IDENTITY_REF_UTXO`,
  `VECTOR_IDENTITY_{ATTESTATION,DELEGATION,VAULT,ESCROW,ADVERT,MODULE1}_REF_UTXO`, and `VECTOR_IDENTITY_ALLOWLIST_URL`.
  The server applies the deployment parameters to the unapplied scripts of the identity-marketplace blueprint
  (agents-marketplace 1643583, generated into `identity-scripts.generated.ts` by
  `packages/builder/scripts/gen-identity-scripts.mjs`, with a checksum test) at startup, with the uplc crate of
  Aiken (`@lucid-evolution/uplc`, now a direct dependency), so the hashes equal `aiken blueprint apply`.
- `vector_resolve_did`: resolves a `did:vector` DID (canonical or legacy form, optional `versionId` or
  `versionTime`) through the identity gateway (`GET /1.0/identifiers/{did}`, `Accept: application/did-resolution`)
  and returns the HTTP status and the resolution result unchanged. Gateway: `VECTOR_IDENTITY_GATEWAY_URL`
  (default `https://id.vector.apexfusion.org`).
- Signer: `vector_signer_get_public_key` returns the Ed25519 public key and its key hash (not secret).
- Signer: optional `VECTOR_SIGNER_OGMIOS_URL`. With it, the signer reads the outputs that a transaction spends
  (one read-only `queryLedgerState/utxo` query, output references only) and counts only the value that its
  own inputs fund. Without it, or when the lookup fails, it uses the previous rule and says so in the result.
- 63 tools in all (33 before PR #25 and the identity release; 24 in 2.0.0).

### Changed

- `vector_get_agent_profile` accepts both DID forms: a canonical DID resolves through the identity gateway
  (profile, effective status, keys, record output); a legacy DID still reads the legacy registry.
- Signer: `vector_signer_sign` and `vector_signer_decode_transaction` accept a partly signed transaction. The
  witnesses of other keys stay byte for byte and in their order; this key gets exactly one witness.
- Signer: the audit log records the outflow rule of each decision (`rule`: `own-inputs` or `all-outputs`).
- All package versions, `server.json` and both advertised MCP server identities move to 3.0.0 (one shared
  version).

## 2.0.0 - 2026-08-17

### Breaking

- **The legacy SSE transport is removed.** `GET /sse` and `POST /messages` now answer 404.
  Every client connects over Streamable HTTP at `/mcp`:
  `claude mcp add --transport http vector-mcp <url>/mcp`. The `sse` remote was removed from
  the MCP Registry manifest (`server.json`).

### Added

- `GET /health`: unauthenticated liveness probe, returns
  `{"status":"ok","version":"<version>"}`. It creates no session and bypasses the rate
  limiter.
- Any-origin CORS on the whole HTTP surface, including preflight (`OPTIONS` → 204) and error
  responses, with `mcp-session-id` exposed to browser callers. Browser-based MCP clients can
  connect directly; authorization remains bearer-token only. Note for self-hosters: with
  `MCP_AUTH_TOKENS` unset, any web page can drive your instance from a visitor's browser,
  sharing that visitor's per-IP rate-limit bucket - set `MCP_AUTH_TOKENS` on any instance
  reachable by anyone but you.

### Changed

- All package versions, `server.json`, and both advertised MCP server identities are unified
  at 2.0.0; the identities now read the version from `package.json` at build time instead of
  hardcoding it.
- `@modelcontextprotocol/sdk` floor raised to `^1.30.0`.

### Known limits

- POST responses stream as SSE frames (the spec-default mode) with no keepalive bytes while a
  tool call computes. Behind a proxy that cuts idle responses (Cloudflare's edge does at
  ~100 s), a single tool call that stays silent longer than that window is dropped by the
  proxy. Long waits (e.g. `vector_await_transaction` on a congested chain) should poll in
  shorter calls.
