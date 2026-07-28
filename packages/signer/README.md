# Vector MCP Signer

Local signing companion for the Vector MCP server. **Holds your key; has no network access.**

The hosted builder is keyless: it constructs unsigned transactions but cannot sign. This
package signs them locally, so your key never reaches a shared server or your model
provider.

## Why it has no network

- **stdio transport only** — no port, no HTTP listener, nothing to connect to
- **no Provider and no Lucid instance** — signing uses CML directly
- **submission lives on the builder**, so the signer needs no egress either

`test/boundary.test.ts` enforces this over both the import graph and the manifest — it walks
every file under `src/`, checks `package.json` for network-capable dependencies, and greps for
ambient network globals (`fetch`, `WebSocket`, ...). It is the package's central security
guarantee.

`test/integration/roundtrip.test.ts` imports `@lucid-evolution/lucid` and the shared package's
`/provider` — that does **not** weaken the guarantee above. That file lives under `test/`,
which `boundary.test.ts` deliberately scans only as far as `src/`, and which the build never
bundles (`tsup`'s only entry point is `src/index.ts`). Those imports exist so the test can
build a real transaction the way the hosted *builder* does (no key) before handing it to the
signer's actual decode/policy/sign code path — the network calls belong to the test's
stand-in builder, never to code that ships.

## Defense in depth

Beyond "no network," a few structural choices narrow what a bug or an accidental leak can
expose:

- **The read-only tools cannot reach the key, even in principle.** `vector_signer_get_address`,
  `vector_signer_decode_transaction`, and `vector_signer_get_spend_limits` are all registered
  by one function whose parameter list never includes the key source. That's structural, not a
  matter of discipline: reintroducing signing capability there means visibly changing that
  function's signature, not adding a line inside a handler.
- **Key material resists accidental logging.** TypeScript `private` is compile-time only — at
  runtime the field is an ordinary enumerable property, fully visible to `JSON.stringify`,
  `console.log`, and `util.inspect`. Mnemonics and derived private keys are therefore held in
  native JavaScript `#private` fields instead, and both `KeySource` classes override
  `toJSON()` and Node's inspect symbol so that even a stray `console.log(keySource)` prints a
  safe description instead of the secret. This defends against *accidental* disclosure (a
  debugging log line, a crash reporter serializing local state) — it is not a defense against
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
| `VECTOR_SIGNER_PRIVATE_KEY` + `VECTOR_SIGNER_ADDRESS` | A derived bech32 signing key. **Safest in terms of blast radius** — it controls one account rather than your whole HD tree, so a leak is bounded. See the mismatch caveat under Known limitations. |

If more than one is set, `config.ts` checks them in this order: `VECTOR_SIGNER_PRIVATE_KEY` +
`VECTOR_SIGNER_ADDRESS`, then `VECTOR_SIGNER_MNEMONIC`, then `VECTOR_SIGNER_MNEMONIC_FILE`.
Unset the ones you are not using — a leftover `VECTOR_SIGNER_MNEMONIC` in your shell profile
silently wins over a `VECTOR_SIGNER_MNEMONIC_FILE` you just configured.

Optional:

| Variable | Default | Notes |
|---|---|---|
| `VECTOR_SIGNER_ACCOUNT_INDEX` | `0` | HD account index, for mnemonic sources |
| `VECTOR_SIGNER_SPEND_LIMIT_PER_TX` | `100000000` (100 AP3X) | Refuses any transaction whose net outflow exceeds this |
| `VECTOR_SIGNER_SPEND_LIMIT_DAILY` | `500000000` (500 AP3X) | Refuses once today's signed total would exceed this |
| `VECTOR_SIGNER_AUDIT_LOG_PATH` | *(see note below)* | Local record of every decision |

**`VECTOR_SIGNER_AUDIT_LOG_PATH`, precisely:** if unset, the log is written to
`vector-signer-audit-log.json` resolved against the *package's own install location* (three
directories up from `build/index.js` — the monorepo root, in this repo), **not** against
whatever directory the process happened to be started from. That makes the location
predictable regardless of your MCP client's working directory, but it also means the file is
easy to forget about. In particular: unlike the builder's `vector-audit-log.json`, this
filename is **not currently listed in this repo's `.gitignore`**. If you run the signer from a
checkout of this repo without setting `VECTOR_SIGNER_AUDIT_LOG_PATH` explicitly, check before
you `git add` — or just set the variable and point it somewhere outside the repo.

## Tools

| Tool | Purpose |
|---|---|
| `vector_signer_get_address` | Your address. Pass it to the builder as `changeAddress`. |
| `vector_signer_decode_transaction` | Show what a transaction would move, **without signing**. |
| `vector_signer_sign` | Policy-check and sign. Returns signed CBOR. |
| `vector_signer_get_spend_limits` | Limits, today's committed total, recent decisions. |

No tool accepts key material as a parameter — that is asserted by the smoke test.

## What "net outflow" means

Spend limits apply to **net outflow**: every output that does *not* return to your address,
plus the fee. Change is excluded, so a 1000 AP3X wallet sending 3 AP3X is measured as ~3.2
AP3X, not 1000.

An output to your own wallet at a *different* derivation index counts as outflow. That
over-counts, which refuses too much rather than too little.

## Known limitations

- **Native assets are recorded and reported, but not limited.** Spend limits apply to
  lovelace. A transaction moving ~2 AP3X plus a valuable NFT passes the lovelace check.
  Asset movements appear in `decode_transaction` output and the audit log so they are
  visible, but they are not yet a policy input.
- **The audit log records intent, not confirmation.** The signer has no network and cannot
  observe whether a submit succeeded, so a failed submit still counts against the daily
  budget. Conservative by design.
- **A durable audit record is mandatory for signing — which means an unwritable audit log
  stops all signing, not just accounting.** `AuditLog.append()` throws if the write fails, and
  `vector_signer_sign` withholds a signature it already produced rather than return one with
  no durable record of it — the alternative would let a restarted process silently under-count
  today's spend, which quietly raises the effective daily limit. The practical effect: if the
  audit log's directory disappears, the disk fills, or the path loses write permission, every
  `vector_signer_sign` call starts returning `REFUSED` — including transactions well inside
  policy — until it is writable again. That refusal names the audit failure explicitly rather
  than reading like an ordinary policy refusal, but it is still a full stop on signing, not a
  warning.
- **The key is plaintext at rest** in v1 (env var or file). The win is that it is *local*
  and never transits your model provider or a shared host — not that it is in an HSM.
  `KeySource` exists so keychain and hardware backends can be added without touching the
  signing path.
- **`VECTOR_SIGNER_PRIVATE_KEY` and `VECTOR_SIGNER_ADDRESS` are not cross-checked against each
  other.** Each is validated as well-formed independently, but nothing confirms the address is
  actually the one the private key controls — that check is possible entirely offline (this
  package already depends on the CML library that could do it) but is not wired up yet. A
  mismatched pair still constructs and signs without error. The failure surfaces later: either
  as a chain-level rejection at submission, or as the policy engine failing to recognise your
  own change as change and over-counting it as outflow — the safe direction, but confusing if
  you hit it without knowing why.
- **Prompt injection is bounded, not eliminated.** Policy refuses out-of-limit
  transactions, but an injected agent can still cause any transaction *within* policy.
  Recipient allowlisting is the next lever.
- **Pairing this signer with the hosted builder does not yet remove the custody exposure it
  is designed to fix.** The signer's own four tools are complete and independently verified
  end to end against live chain data (`test/integration/roundtrip.test.ts`). What is not yet
  true is a wired-up keyless round trip through the hosted *builder's* actual tools: today
  every builder tool that builds or sends a transaction (`vector_send_apex`,
  `vector_build_transaction`, the registry and governance tools, ...) still requires your
  mnemonic as a call parameter, and no `submit_transaction` tool exists yet to submit a
  transaction this signer produced. That migration is tracked separately in
  [`docs/architecture/non-custodial-split.md`](../../docs/architecture/non-custodial-split.md)
  (PRs 6-8) and has not shipped. Until it does, the root README's custody notice still
  describes the hosted builder accurately.

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

Register it alongside the hosted builder so an agent has both sets of tools available. See the
last bullet under Known limitations above before expecting that pairing to keep your mnemonic
off the hosted server today — the signer half is ready; the builder half is not yet.

## Testing

```bash
npm run test:unit          # pure logic, no wallet, no network (from the repo root)
npm run test:smoke:signer  # builds the signer, boots it over stdio, exercises all 4 tools
```

Both run in CI on every PR.

```bash
export VECTOR_SIGNER_MNEMONIC_FILE=/absolute/path/to/testnet-mnemonic.txt
export NODE_OPTIONS=--max-old-space-size=12288
npm run test:integration:signer
```

Requires a **funded Vector testnet** wallet. Builds a real unsigned transaction the way the
hosted builder does (no key), then decodes, policy-checks, and signs it with the real signer
code path against live chain data. **Never submits.** Not run in CI — see
`test/integration/roundtrip.test.ts`.
