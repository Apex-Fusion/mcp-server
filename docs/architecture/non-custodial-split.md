# Non-Custodial Split Architecture

**Status:** approved · **Date:** 2026-07-27

Why the Vector MCP server is moving from seed-phrase-as-a-parameter to a keyless
hosted builder plus a local signer, and the PR sequence that gets us there.

---

## 1. Problem

Every signing tool on the Vector MCP server takes the user's BIP39 **seed phrase as a call parameter**. Because the LLM must emit that parameter to invoke the tool, the seed travels through the MCP client, **the model provider's context window and request logs**, the network, and finally the **process memory of the hosted server**. A seed is root custody: unlimited, irrevocable, unscopable.

The server's spend limits and rate limits are app-layer only, so they do not constrain anyone who has captured the seed. They are also **process-global singletons**, so on the hosted box every user shares one daily budget, one rate limit, and one audit file.

## 2. Goal

**The agent holds its own key. The shared server never sees a seed.**

Success criteria:
1. No hosted tool accepts a mnemonic or private key. Grep-able: zero `mnemonic` params in the builder package.
2. The signing key never enters the model context, never crosses the network.
3. Spend policy is enforced where it is actually enforceable — locally, per user.
4. Every PR in the series is independently reviewable and leaves `main` coherent.

## 3. Decisions (locked)

| Decision | Choice |
|---|---|
| Deployment reality | Hosted multi-tenant is flagship → seed-to-server is P0 |
| Architecture | Keyless hosted **builder** + local companion **signer** |
| Repo topology | Single repo, **npm workspaces** monorepo |
| Migration | **Hard cut per family** — no dual-mode, no deprecation window |
| Key storage | Pluggable `KeySource`; v1 = env var / `0600` file |
| Signer policy | Decode tx → **net outflow** → limits → audit → sign. Fully autonomous |
| Tool flow | 4 calls: `get_address` → `build_*` → `sign` → `submit` |
| Tool naming | Explicit `build_*` / `signer_*` / `submit_*` prefixes |
| Cross-cutting fixes | Entangled ones inline; independent ones as separate small PRs |
| Rollout | Testnet auto-deploys and may break; mainnet held until complete |
| Testing | **TDD** — tests written first |
| Auth | Enforced when `MCP_AUTH_TOKENS` is configured |

## 4. Architecture

```
mcp-server/                                   npm workspaces root
├── packages/
│   ├── shared/    @apexfusion/vector-mcp-shared
│   │     exports "./tx"        pure CBOR, types, formatting — NO network
│   │     exports "./provider"  OgmiosProvider, endpoints    — network
│   ├── builder/   @apexfusion/vector-mcp-builder   HOSTED · keyless · network
│   └── signer/    @apexfusion/vector-mcp-signer    LOCAL  · holds key · no network
```

Two properties carry the security argument:

**The signer has no network interface, inbound or outbound.** It speaks **stdio** (the natural MCP local transport) — no port, no listener. Submission lives on the builder, so it has no egress either. The signer is a pure function: `CBOR in → signed CBOR out`, gated by policy.

**The boundary is enforced by the module graph, not convention.** `shared` uses subpath exports; the signer imports `@apexfusion/vector-mcp-shared/tx` and *cannot* reach `/provider`. A reviewer can verify the signer is network-free by reading its imports.

### Why zero-network is possible

Net outflow is computable from the transaction body alone:

```
netOutflowLovelace = Σ { output.lovelace | output.address ∉ ownAddresses } + fee
```

No input resolution, therefore no chain access. Change returning to us is excluded automatically because its address is ours.

**Known over-count:** an output to the user's own wallet at a *different derivation index* is classified as foreign and counted as outflow. This fails safe (refuses too much, never too little) and is accepted for v1.

## 5. Components

| Component | Package | Responsibility |
|---|---|---|
| `OgmiosProvider` | shared `/provider` | Chain queries + submit. Relocated unchanged. |
| CBOR / tx helpers | shared `/tx` | Decode, asset-name derivation, formatting. Pure. |
| Tool modules | builder | `build_*` per family, read-only queries, `submit`, `await` |
| Auth + rate limit | builder | Bearer token; **per-identity** limits replace the global singleton |
| `KeySource` | signer | `getSigningKey()`. v1: `EnvKeySource`, `FileKeySource` (0600) |
| `PolicyEngine` | signer | `evaluate(decoded, ownAddresses) → { allowed, reason, netOutflow }` |
| `SpendLimitPolicy` | signer | Ported `safety.ts`, now per-user and enforceable |
| Audit log | signer | Local, per-user |

`PolicyEngine` is an interface with one v1 implementation so recipient-allowlist and threshold-approval land later without touching the sign path.

### Interfaces

```ts
interface KeySource {
  getSigningKey(): Promise<PrivateKey>;
  getAddress(): Promise<string>;
}

interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  netOutflowLovelace: bigint;
  assetMovements: AssetMovement[];
}

interface Policy {
  evaluate(tx: DecodedTx, ownAddresses: string[]): PolicyDecision;
}
```

## 6. Data flow

```
1. vector_signer_get_address                    → { address }              [signer]
2. vector_build_send_apex                       → { txCbor, summary, fee } [builder, keyless]
     { changeAddress, recipientAddress, amount }
3. vector_signer_sign                           → { signedTxCbor }         [signer, key]
     { txCbor }    decode → net outflow → policy → audit → sign
4. vector_submit_transaction                    → { txHash, explorerUrl }  [builder]
     { signedTxCbor }
```

`vector_signer_decode_transaction` is a read-only preview so an agent can show a human what it is about to sign.

**Accepted trade-off of the 4-call shape:** the signer records **intent to spend** at signing time, not confirmed submission. If a submit later fails, the audit log over-counts. Conservative, therefore acceptable — and it is the price of the signer having no network access. Documented, not hidden.

### Two-step governance flow

`submit_proposal` is a lock-then-spend pair with a confirmation wait between. Keyless, that orchestration becomes explicit:

```
build_self_improvement_proposal_lock → sign → submit → await_transaction
  → build_self_improvement_proposal_spend(lockTxHash) → sign → submit
```

This is why governance is the last family: the LLM must drive a stateful, multi-transaction sequence.

## 7. Tool inventory

**Builder — 24 tools, zero keys.**

| Group | Tools |
|---|---|
| Read-only (8, unchanged) | `get_balance`, `get_utxos`, `get_transaction_history`, `dry_run`, `discover_agents`, `get_agent_profile`, `self_improvement_browse`, `self_improvement_analyze_metrics` |
| Build — tx (3) | `build_send_apex`, `build_send_tokens`, `build_transaction` |
| Build — contracts (2) | `build_deploy_contract`, `build_interact_contract` |
| Build — registry (5) | `build_register_agent`, `build_update_agent`, `build_transfer_agent`, `build_deregister_agent`, `build_message_agent` |
| Build — governance (4) | `build_self_improvement_proposal_lock`, `build_self_improvement_proposal_spend`, `build_self_improvement_critique`, `build_self_improvement_endorse` |
| Chain ops (2, new) | `submit_transaction`, `await_transaction` |

**Signer — 4 tools, holds the key.**

`signer_get_address` · `signer_decode_transaction` · `signer_sign` · `signer_get_spend_limits`

**Removed:** `vector_get_address` (replaced by `signer_get_address`), `vector_get_spend_limits` (moved to signer).

## 8. Error handling

**The signer fails closed.** Any CBOR it cannot fully parse, any unrecognised output type, any address it cannot classify as ours-or-foreign → **refuse**. A signer that guesses is worthless. Refusals return a structured reason the agent relays verbatim: `"net outflow 250.00 AP3X exceeds per-transaction limit 100.00 AP3X"`.

**The builder never fabricates.** Submission returns a real error when it fails, never a synthesised or placeholder result.

## 9. Testing

TDD throughout: failing test before implementation, every PR.

| Layer | Coverage | Wallet | Network |
|---|---|---|---|
| `shared` | Golden CBOR encode/decode, asset-name derivation | no | no |
| `builder` | Fixture UTxOs + mocked provider → assert structure, fee, change | no | no |
| `signer` | **Adversarial** (below) | throwaway key | no |
| integration | build→sign→submit round trip | **funded testnet** | yes |

**Mandatory adversarial cases for the signer** — these are the security boundary:

- Drain to a foreign address exceeding the limit → **refused**
- Change returning to own address → **excluded** from net outflow
- Malformed / truncated CBOR → **refused**, never signed
- Unrecognised output type → **refused**
- Daily limit accumulation across multiple signs → enforced
- Fee included in net outflow

## 10. PR sequence

### Spine (ordered)

| PR | Content | Breaks testnet |
|---|---|---|
| **1** | CI harness: build + unit tests. Ships this design doc into `docs/architecture/` so reviewers have the rationale | no |
| **2** | Fix the 8 type errors (import Zod via `zod/v4`) + **typecheck becomes a hard gate** | no |
| **3** | Workspace scaffolding — pure `git mv`, zero logic change, validated by PR 1–2 CI | no |
| **4** | **Signer package** (purely additive): `KeySource`, decode, `PolicyEngine`, audit, 4 tools. Heavy TDD | no |
| **5** | Builder hardening: auth (enforced when configured), per-identity rate limits, `submit_transaction`, `await_transaction` | no |
| **6** | **Family 1 — wallet/tx keyless.** Mnemonics removed; `build_*` tools land ✅ **(landed — this PR)** | **yes** |
| **7** | **Family 2 — agent registry keyless.** Drops `@ts-nocheck` from `agent-network.ts` | yes |
| **8** | **Family 3 — governance keyless.** Plus env-driven ref-UTxO config and a CBOR encoding fix | yes |
| **9** | Mainnet cutover: README, security-page correction, deliberate `workflow_dispatch` | — |

**PR 4 is the review that matters.** It is additive, self-contained, and *is* the security boundary. It breaks nothing while it is reviewed.

**PR 2 rationale:** `main` does not currently typecheck (§12). Gating CI on a red tree is impossible, so the gate is established before any refactor lands on top of it.

### Independent singles (any order, parallel)

| PR | Fix |
|---|---|
| A | Koios v2 default; reconcile `.env.example` / `docker-compose` |
| B | `engines.node` floor; `postinstall` symlink hack |
| C | Submission error handling |
| D | `min(1)` APEX floor → real dust floor |
| E | Endpoint URLs in error text |
| F | SSE → Streamable HTTP |
| G | Float → bigint money math |
| H | Dependency updates |

### Dependency graph

```
PR1 ─→ PR2 ─→ PR3 ─┬─→ PR4 (signer)           ─┐
                   └─→ PR5 (builder hardening) ─┴─→ PR6 ─→ PR7 ─→ PR8 ─→ PR9

A…H  independent of the spine and of each other — land any time
```

PR 4 and PR 5 both depend on the workspace split (PR 3) and can proceed in parallel; PR 6 needs both, because the first keyless family requires a signer to sign with and a `submit_transaction` to submit through.

## 11. Rollout

Testnet auto-deploys on push to `main` (`deploy.yml`) and **is the proving ground** — breaking it from PR 6 onward is expected and useful signal. Mainnet deploys only by manual `workflow_dispatch` and **stays on the last custodial image until PR 9**. This uses the existing CI split as designed; no new infrastructure.

## 12. Findings from local verification

Verified locally on Windows 11, **Node v25.8.0 / npm 11.11.0**: `npm ci` clean in 16 s (396 packages), `tsup` build succeeds (131 KB, 67 ms).

> **Verification caveat:** local Node is **25.8.0**; the Dockerfile deploys on **node:22-alpine**, and `package.json` claims `>=14`. Local green does not prove green on the deploy runtime. PR 1's CI must pin the **Node 22** matrix so the gate matches production, and PR B corrects the declared floor.

**`npm run typecheck` fails on `main` — 8 errors, all `src/vector/vector.ts`.**

```
512,3 · 702,3 · 782,3 · 920,3 · 990,3 · 1192,3 · 1250,3   TS2589  instantiation excessively deep
1250,10                                                    TS2769  no overload — z.record(z.string()).optional()
```

CI only runs `npm run build`, and `tsup`/esbuild strips types without checking them, so this has never been caught.

**This corrects an earlier misattribution.** The `@ts-nocheck` headers are attributed in-code to "Cardano WASM imports," but the real cause is `server.tool()` generic inference exceeding TypeScript's instantiation depth on rich Zod schemas — the same failure leaking out of the one file lacking the escape hatch.

**Root cause, resolved (PR 2).** The initial hypothesis — a stale `@modelcontextprotocol/sdk@^1.4.1` — was wrong: `^1.4.1` is the declared *range*, and npm resolves it to 1.27.1. The actual cause is that the app imported Zod 3 (`from "zod"`) while the SDK expects Zod 4; its `ZodRawShapeCompat` dual-compat type degrades on Zod 3 schemas, and anything richer than a bare `z.string()` exceeds the instantiation limit. The TS2769 is a downstream symptom, not a second defect. Ruled out by experiment before landing the fix: upgrading the SDK to 1.29.0, a duplicate Zod in the tree, pinning Zod 3.24.4, `moduleResolution: bundler`/`nodenext`, the newer `registerTool` API, and hoisting schemas to a `const`. The fix is importing via the `zod/v4` subpath — already shipped inside `zod@3.25.76` — so no dependency change was needed.

**Accepted trade-off.** `zod/v4` routes schemas through a different JSON Schema serializer than v3 (the SDK uses the vendored `zod-to-json-schema` for v3, Zod's native `toJSONSchema` for v4). Consequently **no tool advertises `additionalProperties: false` any more**, where the v3 path emitted it. All three tool modules were converted together so the 23-tool surface stays uniform rather than split. Runtime enforcement is unaffected — missing required arguments are still rejected, and extra keys were already stripped under v3. `test/smoke/tool-schemas.snapshot.json` pins the resulting surface so any further drift is deliberate.

## 13. Residual risks

**Native-asset outflow is not limited in v1.** Spend limits apply to lovelace. A transaction moving ~2 AP3X plus a valuable NFT to a foreign address passes the lovelace check. Blanket-denying asset outflow is not viable because legitimate registry flows mint an NFT to the registry script address.

v1 mitigation: all asset movements are decoded, logged, and returned in the policy decision, and `assetOutflowPolicy` is configurable (`allow` default | `deny` | `allowlist`) for high-value wallets. **Stated as a known limitation, not glossed.** Post-v1: per-policy asset rules.

**Key at rest is plaintext in v1** (env var or `0600` file). The win is that the key is *local and never transits the LLM or a shared host* — not that it is in an HSM. `KeySource` exists so keychain/HSM/hardware land later without touching the sign path.

**Prompt injection is mitigated, not eliminated.** The signer refuses transactions violating policy, but an injected LLM can still cause any transaction *within* policy. Recipient allowlisting is the next lever.

## 14. Open items

1. **`typecheck` must be added to branch protection as a required status check.** The CI job exists and goes red on a type error, but only a repository admin can make it block a merge.
