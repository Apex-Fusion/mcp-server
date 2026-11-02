import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { decodeTransaction, type DecodedTx } from './decode.js';
import { evaluate, type SpendLimits } from './policy.js';
import { publicKeyOf, signTransaction } from './sign.js';
import { ogmiosInputResolver, resolveInputs, type InputResolver } from './resolve.js';
import { AuditLog } from './audit.js';
import { resolutionDescription, type SignerConfig } from './config.js';
import type { KeySource } from './keysource.js';

const txCborShape = {
  txCbor: z
    .string()
    .describe('Hex-encoded CBOR of a transaction: unsigned, or already carrying the vkey witnesses of other keys'),
};

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/** One line on the vkey witnesses a transaction carries, and whether one is this signer's. */
function witnessLine(tx: DecodedTx, keyHashHex: string): string {
  const count = tx.witnessKeyHashes.length;
  if (count === 0) return 'Vkey witnesses already present: none';
  const own = tx.witnessKeyHashes.includes(keyHashHex) ? ", this signer's key among them" : '';
  return `Vkey witnesses already present: ${count} (key hashes ${tx.witnessKeyHashes.join(', ')}${own})`;
}

// Structural guard (review finding, Task 7 follow-up): registerSignerTools()
// used to load the signing identity once and hold it in ONE closure shared
// by all four tool handlers - including decode_transaction and
// get_spend_limits, which never needed it. That is not just untidy: it means
// `identity.privateKeyBech32` sat pre-loaded and one line away inside the
// decode handler, and a mutation that added
// `signTransaction(txCbor, identity.privateKeyBech32)` there, gated behind
// `decision.allowed` and worded to avoid the substring "sign", passed every
// existing test (see the task report for the full mutation transcript) - a
// preview tool that can be made to return genuine signed bytes with no audit
// entry and no budget consumed.
//
// registerReadOnlyTools() below is the fix: its parameter list is exactly
// the non-secret pieces get_address/get_public_key/decode_transaction/
// get_spend_limits need (the public key and its hash are public by nature;
// the input resolver sends output references only). It never receives
// `config`, `config.keySource`, or an `identity` object, so none of the
// handlers defined inside it can reach the private key - not via a
// pre-loaded variable, and not via a fresh `keySource.load()` call either,
// because neither `config` nor `keySource` is a name that resolves in that
// function's scope at all. This is structural, not a matter of discipline:
// reintroducing signing capability into that scope requires visibly changing
// this function's signature, not a one-line addition inside a handler body.
//
// registerSignTool() is the only function in this module whose closure ever
// contains a loaded SigningIdentity. It registers exactly one tool.
interface ReadOnlyToolsContext {
  signerAddress: string;
  publicKeyHex: string;
  keyHashHex: string;
  keySourceDescription: string;
  limits: SpendLimits;
  auditLogPath: string;
  audit: AuditLog;
  resolver: InputResolver | null;
  resolverDescription: string;
}

function registerReadOnlyTools(server: McpServer, ctx: ReadOnlyToolsContext): void {
  const { signerAddress, publicKeyHex, keyHashHex, keySourceDescription, limits, auditLogPath, audit, resolver, resolverDescription } = ctx;
  const ownAddresses = [signerAddress];

  server.tool(
    'vector_signer_get_address',
    'Get this signer\'s wallet address. Pass it to the builder as changeAddress when building a transaction.',
    {},
    async () => text(`Signer address: ${signerAddress}\nKey source: ${keySourceDescription}`)
  );

  server.tool(
    'vector_signer_get_public_key',
    'Get this signer\'s Ed25519 public key (hex) and its key hash (blake2b-224, hex). Neither is secret. Use them where an identity record or a transaction must name this key, for example as the controller key or a listed key of a did:vector record.',
    {},
    async () =>
      text(
        `Public key (Ed25519, hex): ${publicKeyHex}\n` +
          `Key hash (blake2b-224, hex): ${keyHashHex}\n` +
          `Address: ${signerAddress}`
      )
  );

  server.tool(
    'vector_signer_decode_transaction',
    'Decode a transaction (unsigned, or already carrying witnesses of other keys) and report what it would move, without signing it. Use this to show a human what is about to be signed.',
    txCborShape,
    async ({ txCbor }) => {
      try {
        const tx = decodeTransaction(txCbor);
        const resolution = await resolveInputs(tx, keyHashHex, resolver);
        const decision = evaluate(tx, ownAddresses, limits, audit.committedTodayLovelace(), resolution);
        const rows = tx.outputs
          .map((o, i) => {
            const mine = o.address === signerAddress;
            const assets = o.assets.length ? ` + ${o.assets.length} asset(s)` : '';
            return `  ${i}. ${mine ? '[change]  ' : '[outgoing]'} ${lovelaceToAda(o.lovelace)} AP3X${assets}\n     ${o.address}`;
          })
          .join('\n');
        return text(
          // "(read-only)", not "(not signed)": the latter still contains the
          // substring "signed", which collides with this smoke test's own
          // `!/signed/i.test(text)` check (verified empirically - see the
          // task report). "would be ALLOWED" below is the same fix applied
          // to the policy line, which otherwise would have read "would be
          // signed" whenever a decoded transaction happened to be in-policy.
          // The same check rules out "unsigned" and "partly signed" here.
          `# Transaction preview (read-only)\n\n` +
            `Hash: ${tx.txHashHex}\nInputs: ${tx.inputCount}\nFee: ${lovelaceToAda(tx.fee)} AP3X\n` +
            `Minted assets: ${tx.mintedAssetCount}\n${witnessLine(tx, keyHashHex)}\n\nOutputs:\n${rows || '  (none)'}\n\n` +
            `**Net outflow: ${lovelaceToAda(decision.netOutflowLovelace)} AP3X** (${decision.ruleNote})\n` +
            `Assets leaving: ${decision.assetMovements.length}\n\n` +
            `Policy: ${decision.allowed ? 'would be ALLOWED' : `would be REFUSED - ${decision.reason}`}`
        );
      } catch (err) {
        return text(`Could not decode the transaction: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.tool(
    'vector_signer_get_spend_limits',
    'Report this signer\'s spend limits, how much of today\'s budget is committed, the rule that counts the outflow, and recent signing decisions.',
    {},
    async () => {
      const committed = audit.committedTodayLovelace();
      const remaining = limits.dailyLovelace - committed;
      const recent = audit
        .recent(5)
        .map((e) => `  ${e.timestamp} ${e.decision.toUpperCase()} ${lovelaceToAda(BigInt(e.netOutflowLovelace))} AP3X ${e.txHash.slice(0, 16)}...${e.reason ? ` (${e.reason})` : ''}`)
        .join('\n');
      return text(
        `# Signer spend limits\n\n` +
          `Per transaction: ${lovelaceToAda(limits.perTxLovelace)} AP3X\n` +
          `Daily:           ${lovelaceToAda(limits.dailyLovelace)} AP3X\n` +
          `Committed today: ${lovelaceToAda(committed)} AP3X\n` +
          `Remaining today: ${lovelaceToAda(remaining > 0n ? remaining : 0n)} AP3X\n\n` +
          `Input resolution: ${resolverDescription}\n` +
          `Outflow rule: ${resolver ? "the value of this signer's own inputs, less the change back to it, and at least the whole fee; every output not to this signer plus the fee when the inputs cannot be resolved" : 'every output not to this signer, plus the fee'}\n` +
          `Audit log: ${auditLogPath}\n\n` +
          (recent ? `Recent decisions:\n${recent}` : 'No decisions recorded yet.') +
          `\n\nNote: the daily total counts signed transactions at signing time. The signer never ` +
          `submits and cannot observe whether a submit later succeeded, so a failed submit ` +
          `still counts against the budget.`
      );
    }
  );
}

// The ONLY function in this module whose closure ever contains a loaded
// SigningIdentity (and therefore the raw private key). Its parameter list
// receives `keySource` directly, not the whole `SignerConfig` - a smaller
// surface than strictly required, kept deliberately narrow so this
// function's own signature stays an honest, visible marker of "this is
// where signing capability lives" for anyone reading the module top to
// bottom.
function registerSignTool(
  server: McpServer,
  keySource: KeySource,
  limits: SpendLimits,
  audit: AuditLog,
  resolver: InputResolver | null
): void {
  const identity = keySource.load();
  const ownAddresses = [identity.address];
  const { keyHashHex } = publicKeyOf(identity.privateKeyBech32);

  server.tool(
    'vector_signer_sign',
    'Decode, policy-check, and sign a transaction: unsigned, or partly signed by other keys. Every witness of another key is kept as it is, in its order; this key adds its own. Returns signed CBOR to pass to the next key holder or to submit via the builder. Refuses if the transaction violates spend policy.',
    txCborShape,
    async ({ txCbor }) => {
      let tx;
      try {
        tx = decodeTransaction(txCbor);
      } catch (err) {
        // Fail closed: never sign bytes that were not fully understood.
        return text(`REFUSED. ${err instanceof Error ? err.message : String(err)}`);
      }

      // The one await of this handler. Nothing below it yields until the
      // audit entry is appended: evaluate() reads committed-today, and a
      // second sign call must not read the same total before this decision
      // is in the log, or two calls could each pass the daily limit alone.
      const resolution = await resolveInputs(tx, keyHashHex, resolver);
      const decision = evaluate(tx, ownAddresses, limits, audit.committedTodayLovelace(), resolution);

      if (!decision.allowed) {
        // CONTRACT (see audit.ts's own header comment): append() throws if the
        // write to disk fails. No value moves on a refusal either way, so this
        // is lower stakes than the signed branch below - but a refusal whose
        // audit record silently failed to write would still hand back a
        // clean-looking "REFUSED. <reason>" with nothing to indicate that the
        // refusal itself is now missing from the durable log. Caught here (not
        // left to propagate as a generic isError) specifically so the refusal
        // text and reason are ALWAYS delivered to the caller regardless of
        // audit health, with an appended note when the record could not be
        // written - never silence about it, never a bare unexplained error in
        // its place.
        try {
          audit.append({
            timestamp: new Date().toISOString(),
            txHash: tx.txHashHex,
            decision: 'refused',
            netOutflowLovelace: decision.netOutflowLovelace.toString(),
            reason: decision.reason,
            assetMovements: decision.assetMovements.length,
            rule: decision.rule,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[sign] audit append failed for a REFUSED tx ${tx.txHashHex}: ${message}`);
          return text(
            `REFUSED. ${decision.reason}\n\n` +
              `Note: this refusal could NOT be recorded in the local audit log (${message}). ` +
              `No value moved and nothing was signed, but the audit trail for this refusal is incomplete ` +
              `until the log is writable again.`
          );
        }
        // This `return` is load-bearing on its own, not just the branch
        // above it: without it, a policy-refused transaction would fall
        // through into the signing code below and be signed for real. Pinned
        // by a dedicated mutation test in the smoke suite (see the task
        // report) that removes exactly this statement.
        return text(`REFUSED. ${decision.reason}\nOutflow: ${decision.ruleNote}.`);
      }

      let signed;
      try {
        signed = signTransaction(txCbor, identity.privateKeyBech32);
      } catch (err) {
        return text(`REFUSED. Signing failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // HARD REQUIREMENT (audit.ts's own CONTRACT note; see also the task
      // report): append() throws on a write failure, by design. The reflex to
      // avoid here is `catch { warn(); return signed anyway; }` - that
      // reproduces exactly the failure the throw exists to prevent, just one
      // call site later: a real signature reaches the caller while no durable
      // record of it exists on disk, so the next process's
      // committedTodayLovelace() silently under-counts and the daily limit
      // stops binding. `signed.signedCborHex` is therefore not read anywhere
      // below this catch block - the only `return` that can reach it is the
      // one after a successful append.
      try {
        audit.append({
          timestamp: new Date().toISOString(),
          txHash: signed.txHashHex,
          decision: 'signed',
          netOutflowLovelace: decision.netOutflowLovelace.toString(),
          assetMovements: decision.assetMovements.length,
          rule: decision.rule,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[sign] withholding a produced signature for tx ${signed.txHashHex}: audit append failed: ${message}`);
        return text(
          `REFUSED. A valid signature for this transaction was produced, but it could not be durably ` +
            `recorded in the local audit log, so it is being withheld rather than returned to you. ` +
            `No signed transaction has been released to any caller. Detail: ${message}\n\n` +
            `Check that the audit log path is writable, then retry.`
        );
      }

      const others = tx.witnessKeyHashes.filter((hash) => hash !== keyHashHex).length;
      return text(
        `# Signed\n\nHash: ${signed.txHashHex}\n` +
          `Net outflow: ${lovelaceToAda(decision.netOutflowLovelace)} AP3X (${decision.ruleNote})\n` +
          `Vkey witnesses: ${others + 1} (${others} of other keys, kept as they were, and this signer's)\n\n` +
          `Signed CBOR:\n\`\`\`\n${signed.signedCborHex}\n\`\`\`\n\n` +
          `If another key must sign too, pass this CBOR to its holder. When every required key has signed, ` +
          `submit it with the builder's vector_submit_transaction. Nothing has been submitted yet.`
      );
    }
  );
}

/**
 * Registers the five signer tools. `resolver` is for tests; the server builds
 * it from VECTOR_SIGNER_OGMIOS_URL, and without that setting there is none.
 */
export function registerSignerTools(
  server: McpServer,
  config: SignerConfig,
  resolver: InputResolver | null = config.ogmiosUrl ? ogmiosInputResolver(config.ogmiosUrl) : null
): void {
  // Only the address, the public key and its hash survive past this line into
  // registerReadOnlyTools()'s context - `config.keySource` itself (the only
  // path to the private key) is threaded exclusively into registerSignTool()
  // below. See the comment above registerReadOnlyTools() for why this split
  // exists.
  const loaded = config.keySource.load();
  const signerAddress = loaded.address;
  const { publicKeyHex, keyHashHex } = publicKeyOf(loaded.privateKeyBech32);
  const audit = new AuditLog(config.auditLogPath);

  registerReadOnlyTools(server, {
    signerAddress,
    publicKeyHex,
    keyHashHex,
    keySourceDescription: config.keySource.describe(),
    limits: config.limits,
    auditLogPath: config.auditLogPath,
    audit,
    resolver,
    resolverDescription: resolutionDescription(config.ogmiosUrl),
  });

  registerSignTool(server, config.keySource, config.limits, audit, resolver);
}
