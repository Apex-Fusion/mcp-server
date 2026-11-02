# Vector MCP Signer

Local signing companion for the Vector MCP server. **Holds your key; has no network access unless
you turn on one read-only input lookup (`VECTOR_SIGNER_OGMIOS_URL`).**

The hosted builder is keyless: it constructs unsigned transactions but cannot sign. This
package signs them locally, so your key never reaches a shared server or your model
provider.

## Install with npx

> **Written for after the first npm release.** At the time of writing,
> `@apexfusion/vector-mcp-signer` is not on npm, so `npx` cannot find it. If it still cannot,
> build from this repo (`npm run build`) and use `node packages/signer/build/index.js` in place
> of `npx -y @apexfusion/vector-mcp-signer`; the MCP client entry for that is under
> [Running it](#running-it).

Needs Node 22 or newer. No clone, no build.

**1. Generate your key.** Run this once, in your own terminal:

```bash
npx -y @apexfusion/vector-mcp-signer keygen
```

> **Never run `keygen` through an AI assistant's shell tool.** Its output goes back into the
> conversation, so the only copy of your key would reach your model provider.

It makes a fresh Ed25519 key that controls one address and nothing else, and prints it with
that address (a mainnet enterprise address: payment key only, no stake key):

```text
# Paste these two lines into the signer's env in your MCP client config. Keep the key private.
VECTOR_SIGNER_PRIVATE_KEY=ed25519_sk1…
VECTOR_SIGNER_ADDRESS=addr1v…

# Send this address (only this) to whoever funds your key: addr1v…
```

**The key line is the only copy.** `keygen` prints it once, to your terminal, and stores
nothing: no file, no log, no mnemonic that could rebuild it. Lose it and whatever sits at that
address is gone, so save it in your password manager before you close the terminal. The address
is public. The key is not: it goes in step 2 and nowhere else (not a chat, a ticket or a prompt).

**2. Register the signer in your MCP client** (Claude Desktop's `claude_desktop_config.json`,
for example). Paste the two values from step 1 into `env`, and set a path for the audit log:

```json
{
  "mcpServers": {
    "vector-signer": {
      "command": "npx",
      "args": ["-y", "@apexfusion/vector-mcp-signer"],
      "env": {
        "VECTOR_SIGNER_PRIVATE_KEY": "ed25519_sk1…",
        "VECTOR_SIGNER_ADDRESS": "addr1v…",
        "VECTOR_SIGNER_AUDIT_LOG_PATH": "C:/Users/you/vector-signer-audit-log.json"
      }
    }
  }
}
```

Replace the audit log path with a file in a folder that already exists. Use forward slashes
even on Windows (backslashes would need doubling in JSON); on Linux or macOS use an absolute
path in your home folder instead. Your daily spend limit is counted from that log, and under
`npx` the default lands inside npm's cache (`_npx/<hash>/node_modules/`), so the daily total can
reset when the cache is cleared, and two spellings of the package spec (with and without
`@2.0.0`, say) would get two separate logs.

Restart the client, then ask your agent to call `vector_signer_get_address` (it should return
the address `keygen` printed) and `vector_signer_get_spend_limits` (its `Audit log:` line shows
the path in use).

**3. Fund the address.** Send the address, and only the address, to whoever funds your key.

`keygen` is the quickest way to a dedicated key with a small blast radius. If you would rather
use a mnemonic you already hold, see [Configuration](#configuration).

## Why it has no network (by default)

- **stdio transport only** - no port, no HTTP listener, nothing to connect to
- **no Provider and no Lucid instance** - signing uses CML directly
- **submission lives on the builder**, so the signer needs no egress either
- **one optional exception:** with `VECTOR_SIGNER_OGMIOS_URL` set, `src/resolve.ts` sends one
  read-only Ogmios query per decision (`queryLedgerState/utxo`, output references only, never a
  key or a transaction) to learn the value and the owner of each input the transaction spends.
  Without that setting the signer makes no network call at all.

`test/boundary.test.ts` checks this mechanically: it walks every file under `src/` for a
network-capable import or an ambient network global (`fetch`, `WebSocket`, ...), and checks
`package.json` for a network-capable dependency. `src/resolve.ts` is the one file that may name
`fetch`; the check pins that it imports nothing that holds the key, makes one call, and names
only the read-only query. That check is a text scan, not a sandbox, and
it is scoped accordingly: it reliably catches *accidental* regressions and *casual* misuse, an
added dependency, a forgotten forbidden import, an unthinking `fetch(...)` call, including one
routed around the bare identifier via `globalThis['fetch']` or `globalThis.fetch`. It does not
catch *deliberate* obfuscation. Verified directly against the hardened check: an ambient global
reached through a plain alias (`const f = fetch; f(...)`) or a forbidden module specifier
assembled at runtime from concatenated strings (`import('node:' + 'dns')`) both still pass.
Closing gaps like those is a code-review responsibility, not something a fixed set of text
patterns can guarantee: what this check actually verifies is that today's shipped `src/` has no
*accidental or careless* network capability, not a proof that none could ever be smuggled in.

`test/integration/roundtrip.test.ts` imports `@lucid-evolution/lucid` and the shared package's
`/provider` - that does **not** weaken the check above. That file lives under `test/`,
which `boundary.test.ts` deliberately scans only as far as `src/`, and which the build never
bundles (`tsup`'s only entry point is `src/index.ts`). Those imports exist so the test can
build a real transaction the way the hosted *builder* does (no key) before handing it to the
signer's actual decode/policy/sign code path: the network calls belong to the test's
stand-in builder, never to code that ships.

## Defense in depth

Beyond "no network," a few structural choices narrow what a bug or an accidental leak can
expose:

- **The read-only tools cannot reach the key, even in principle.** `vector_signer_get_address`,
  `vector_signer_decode_transaction`, and `vector_signer_get_spend_limits` are all registered
  by one function whose parameter list never includes the key source. That's structural, not a
  matter of discipline: reintroducing signing capability there means visibly changing that
  function's signature, not adding a line inside a handler.
- **Key material resists accidental logging.** TypeScript `private` is compile-time only: at
  runtime the field is an ordinary enumerable property, fully visible to `JSON.stringify`,
  `console.log`, and `util.inspect`. Mnemonics and derived private keys are therefore held in
  native JavaScript `#private` fields instead, and both `KeySource` classes override
  `toJSON()` and Node's inspect symbol so that even a stray `console.log(keySource)` prints a
  safe description instead of the secret. This defends against *accidental* disclosure (a
  debugging log line, a crash reporter serializing local state); it is not a defense against
  a compromised process, which can still read the key out of memory directly.
- **The audit log is crash-safe.** Every entry is written to a temp file and renamed into
  place, so a process kill mid-write costs at most the one entry in flight, never the rest of
  the day's history. See the mandatory-audit limitation below for the cost of this design.

## Configuration

Pick one key source:

| Variable | Notes |
|---|---|
| `VECTOR_SIGNER_MNEMONIC_FILE` | Path to a file containing your mnemonic. Use `chmod 600`. Recommended. |
| `VECTOR_SIGNER_MNEMONIC` | The mnemonic inline. Convenient, but ends up in your shell history and process environment. |
| `VECTOR_SIGNER_PRIVATE_KEY` + `VECTOR_SIGNER_ADDRESS` | A derived bech32 signing key. **Safest in terms of blast radius**: it controls one account rather than your whole HD tree, so a leak is bounded. See the mismatch caveat under Known limitations. |

If more than one is set, `config.ts` checks them in this order: `VECTOR_SIGNER_PRIVATE_KEY` +
`VECTOR_SIGNER_ADDRESS`, then `VECTOR_SIGNER_MNEMONIC`, then `VECTOR_SIGNER_MNEMONIC_FILE`.
Unset the ones you are not using: a leftover `VECTOR_SIGNER_MNEMONIC` in your shell profile
silently wins over a `VECTOR_SIGNER_MNEMONIC_FILE` you just configured.

Optional:

| Variable | Default | Notes |
|---|---|---|
| `VECTOR_SIGNER_ACCOUNT_INDEX` | `0` | HD account index, for mnemonic sources |
| `VECTOR_SIGNER_SPEND_LIMIT_PER_TX` | `100000000` (100 AP3X) | Refuses any transaction whose net outflow exceeds this |
| `VECTOR_SIGNER_SPEND_LIMIT_DAILY` | `500000000` (500 AP3X) | Refuses once today's signed total would exceed this |
| `VECTOR_SIGNER_AUDIT_LOG_PATH` | *(see note below)* | Local record of every decision |
| `VECTOR_SIGNER_OGMIOS_URL` | *(unset)* | Ogmios HTTP JSON-RPC endpoint for input resolution. Set: the own-inputs spend rule (see below). Unset: no network call at all, and the fallback rule. A value that is not an http(s) URL stops startup. |

**`VECTOR_SIGNER_AUDIT_LOG_PATH`, precisely:** if unset, the log is written to
`vector-signer-audit-log.json` resolved against the *package's own install location* (three
directories up from `build/index.js`, the monorepo root, in this repo), **not** against
whatever directory the process happened to be started from. That makes the location
predictable regardless of your MCP client's working directory, but it also means the file is
easy to forget about. Like the builder's `vector-audit-log.json`, this exact filename is listed
in this repo's `.gitignore`, so a default-configured signer run from a checkout will not get its
audit log accidentally staged. That entry only matches the default filename, though: if you
point `VECTOR_SIGNER_AUDIT_LOG_PATH` at some other path inside the repo, check before you
`git add`, or just set the variable to somewhere outside the repo entirely.

## Tools

| Tool | Purpose |
|---|---|
| `vector_signer_get_address` | Your address. Pass it to the builder as `changeAddress`. |
| `vector_signer_get_public_key` | Your Ed25519 public key and its key hash (blake2b-224). Not secret; use them where an identity record must name your key. |
| `vector_signer_decode_transaction` | Show what a transaction would move, **without signing**. Also shows the witnesses it already carries. |
| `vector_signer_sign` | Policy-check and sign. Accepts an unsigned transaction or one that other keys signed first: their witnesses stay byte for byte and in their order, and your key gets exactly one witness. Returns signed CBOR. |
| `vector_signer_get_spend_limits` | Limits, today's committed total, the outflow rule in use, recent decisions. |

No tool accepts key material as a parameter; that is asserted by the smoke test.

## What "net outflow" means

Spend limits apply to **net outflow**. The signer counts it with one of two rules, and every
result says which rule counted it, and for the fallback why.

**Own-inputs rule** (needs `VECTOR_SIGNER_OGMIOS_URL`, and every spent input and collateral input
found unspent). An input is *own* when the payment credential of the output it spends is your key
hash. Then:

```text
net outflow = max( 0,
                   own spent inputs + withdrawals from your key's reward account - outputs to your address,
                   own collateral inputs - the collateral return when it goes to your address,
                   the whole fee, when your key funds any spent or collateral input )
```

The second and third terms are the two outcomes one signature covers: `is_valid` is outside the
signed body, so a node can take the collateral instead of the inputs when a script fails. The
fee share is conservative: when your key funds any input, the whole fee counts, even if another
party pays it. In a multi-party transaction, the value the other parties fund does not count.
Value at a script address that your signature unlocks is not an own input: the script's rules
decide where it goes.

**Fallback rule** (the previous rule): every output that does *not* return to your address, plus
the fee. It applies when `VECTOR_SIGNER_OGMIOS_URL` is unset, when the lookup fails, when an input
is not found unspent, and when a certificate returns a deposit to your key (the body does not
always say how much). Change is excluded, so a 1000 AP3X wallet sending 3 AP3X is measured as
~3.2 AP3X, not 1000.

Under both rules an output counts as returned only when it goes to your configured address
exactly. An output to your own wallet at a *different* derivation index counts as outflow. That
over-counts, which refuses too much rather than too little.

**Trust.** The own-inputs rule trusts the Ogmios endpoint. An endpoint that lies about who holds an
input can make the signer count less than the signature gives away. Point
`VECTOR_SIGNER_OGMIOS_URL` only at an endpoint you trust, best your own node.

## Known limitations

- **Native assets are recorded and reported, but not limited.** Spend limits apply to
  lovelace. A transaction moving ~2 AP3X plus a valuable NFT passes the lovelace check.
  Asset movements appear in `decode_transaction` output and the audit log so they are
  visible, but they are not yet a policy input.
- **The audit log records intent to spend, at signing time.** The signer never submits and cannot
  observe whether a submit succeeded, so a failed submit still counts against the daily
  budget. Conservative by design.
- **The fallback rule does not count collateral.** A transaction with a failing script lets a node
  take the collateral inputs. The own-inputs rule counts your collateral; the fallback rule (no
  `VECTOR_SIGNER_OGMIOS_URL`, or a failed lookup) counts only outputs and the fee, as before.
- **A durable audit record is mandatory for signing: an unwritable audit log halts every
  signature.** `AuditLog.append()` throws if the write fails, and
  `vector_signer_sign` withholds a signature it already produced rather than return one with
  no durable record of it. The alternative would let a restarted process silently under-count
  today's spend, which quietly raises the effective daily limit. The practical effect: if the
  audit log's directory disappears, the disk fills, or the path loses write permission, every
  `vector_signer_sign` call starts returning `REFUSED`, including transactions well inside
  policy, until it is writable again. That refusal names the audit failure explicitly rather
  than reading like an ordinary policy refusal, but it is still a full stop on signing, not a
  warning.
- **The key is plaintext at rest** in v1 (env var or file). The win is that it is *local*
  and never transits your model provider or a shared host, not that it is in an HSM.
  `KeySource` exists so keychain and hardware backends can be added without touching the
  signing path.
- **`VECTOR_SIGNER_PRIVATE_KEY` and `VECTOR_SIGNER_ADDRESS` are not cross-checked against each
  other.** Each is validated as well-formed independently, but nothing confirms the address is
  actually the one the private key controls: that check is possible entirely offline (this
  package already depends on the CML library that could do it) but is not wired up yet. A
  mismatched pair still constructs and signs without error. The failure surfaces later: either
  as a chain-level rejection at submission, or as the policy engine failing to recognise your
  own change as change and over-counting it as outflow (safe, but confusing if
  you hit it without knowing why).
- **Prompt injection is a residual risk.** Policy refuses out-of-limit
  transactions, but an injected agent can still cause any transaction *within* policy.
  Recipient allowlisting is the next lever.
- **Pairing this signer with the builder in this codebase now removes the custody exposure it
  was designed to fix, for every family the builder exposes.** The signer's own four tools are
  complete and independently verified end to end against live chain data
  (`test/integration/roundtrip.test.ts`), and this codebase's *builder* tools are keyless across
  the board: every `build_*` tool, across the wallet/transaction, smart-contract, agent-registry,
  and self-improvement families, takes a wallet *address* and never a mnemonic, and
  `vector_submit_transaction` / `vector_await_transaction` complete the round trip. The
  build → sign → submit → await pipeline is E2E-proven on Vector testnet across all four
  families: an AP3X self-send (`packages/builder/test/integration/keyless-e2e.test.ts`), a full
  register → update → deregister agent lifecycle with the 10 AP3X deposit round-tripped exactly
  (`registry-e2e.test.ts`), and a full improvement-proposal lock → spend sequence through the
  deployed self-improvement module validator, followed by a critique and an endorsement
  (`self-improvement-e2e.test.ts`) - the first keyless-built, validated proposal submission that
  validator has ever accepted. All three E2E suites sign with the same CML primitives `sign.ts`
  uses (hash the body, produce a vkey witness, attach it - explicitly a stand-in for calling
  `vector_signer_sign` directly, not a call to this package's own code), then submit and confirm
  on real Vector testnet blocks. This signer's own tool surface, policy engine, and audit log
  are exercised separately, by this package's own suite (`test/integration/roundtrip.test.ts`
  and the smoke tests above). **Nothing is left open in the code: this was the last custodial
  family.** The non-custodial migration described in
  [`docs/architecture/non-custodial-split.md`](../../docs/architecture/non-custodial-split.md)
  is complete in this codebase, and as of the 2026-07-31 cutover deploy, on both hosted
  instances too: pair this signer with a self-hosted builder, the testnet instance, or the
  mainnet instance now, since any of them running the 2026-07-31 deploy or later carries the
  guarantee above. Both hosted instances currently require a bearer token from the operators
  to connect - that is an access control, separate from the custody guarantee above.

## Running it

```bash
npm run build
VECTOR_SIGNER_MNEMONIC_FILE=/path/to/mnemonic.txt node packages/signer/build/index.js
```

Or registered directly in an MCP client (Claude Desktop's `claude_desktop_config.json`, for
example):

```json
{
  "mcpServers": {
    "vector-signer": {
      "command": "node",
      "args": ["/path/to/mcp-server/packages/signer/build/index.js"],
      "env": {
        "VECTOR_SIGNER_MNEMONIC_FILE": "/path/to/mnemonic.txt"
      }
    }
  }
}
```

Register it alongside the builder so an agent has both sets of tools available. This pairing
keeps your mnemonic off any server running the 2026-07-31 deploy or later, for every family it
exposes: wallet, transaction, smart-contract, agent-registry, and self-improvement alike. Both
hosted instances qualify now, and so does any self-hosted deployment of this release. See the
last bullet under Known limitations above for the full evidence.

## Testing

```bash
npm run test:unit          # pure logic, no wallet, no network (from the repo root)
npm run test:smoke:signer  # builds the signer, boots it over stdio, exercises all 5 tools, input resolution against a local Ogmios stand-in, and `keygen`
```

Both run in CI on every PR.

```bash
export VECTOR_SIGNER_MNEMONIC_FILE=/absolute/path/to/testnet-mnemonic.txt
export NODE_OPTIONS=--max-old-space-size=12288
npm run test:integration:signer
```

Requires a **funded Vector testnet** wallet. Builds a real unsigned transaction the way the
hosted builder does (no key), then decodes, policy-checks, and signs it with the real signer
code path against live chain data. **Never submits.** Not run in CI; see
`test/integration/roundtrip.test.ts`.
