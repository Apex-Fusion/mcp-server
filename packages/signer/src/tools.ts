import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { decodeTransaction } from './decode.js';
import { evaluate } from './policy.js';
import { signTransaction } from './sign.js';
import { AuditLog } from './audit.js';
import type { SignerConfig } from './config.js';

const txCborShape = { txCbor: z.string().describe('Hex-encoded CBOR of an unsigned transaction') };

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

export function registerSignerTools(server: McpServer, config: SignerConfig): void {
  const identity = config.keySource.load();
  const audit = new AuditLog(config.auditLogPath);
  const ownAddresses = [identity.address];

  server.tool(
    'vector_signer_get_address',
    'Get this signer\'s wallet address. Pass it to the builder as changeAddress when building a transaction.',
    {},
    async () => text(`Signer address: ${identity.address}\nKey source: ${config.keySource.describe()}`)
  );

  server.tool(
    'vector_signer_decode_transaction',
    'Decode an unsigned transaction and report what it would move, without signing it. Use this to show a human what is about to be signed.',
    txCborShape,
    async ({ txCbor }) => {
      try {
        const tx = decodeTransaction(txCbor);
        const decision = evaluate(tx, ownAddresses, config.limits, audit.committedTodayLovelace());
        const rows = tx.outputs
          .map((o, i) => {
            const mine = o.address === identity.address;
            const assets = o.assets.length ? ` + ${o.assets.length} asset(s)` : '';
            return `  ${i}. ${mine ? '[change]  ' : '[outgoing]'} ${lovelaceToAda(o.lovelace)} AP3X${assets}\n     ${o.address}`;
          })
          .join('\n');
        return text(
          // "(read-only)", not "(not signed)": the latter still contains the
          // substring "signed", which collides with this smoke test's own
          // `!/signed/i.test(text)` check (verified empirically — see the
          // task report). "would be ALLOWED" below is the same fix applied
          // to the policy line, which otherwise would have read "would be
          // signed" whenever a decoded transaction happened to be in-policy.
          `# Transaction preview (read-only)\n\n` +
            `Hash: ${tx.txHashHex}\nInputs: ${tx.inputCount}\nFee: ${lovelaceToAda(tx.fee)} AP3X\n` +
            `Minted assets: ${tx.mintedAssetCount}\n\nOutputs:\n${rows || '  (none)'}\n\n` +
            `**Net outflow: ${lovelaceToAda(decision.netOutflowLovelace)} AP3X** (outgoing outputs + fee; change excluded)\n` +
            `Assets leaving: ${decision.assetMovements.length}\n\n` +
            `Policy: ${decision.allowed ? 'would be ALLOWED' : `would be REFUSED - ${decision.reason}`}`
        );
      } catch (err) {
        return text(`Could not decode the transaction: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.tool(
    'vector_signer_sign',
    'Decode, policy-check, and sign an unsigned transaction. Returns signed CBOR to submit via the builder. Refuses if the transaction violates spend policy.',
    txCborShape,
    async ({ txCbor }) => {
      let tx;
      try {
        tx = decodeTransaction(txCbor);
      } catch (err) {
        // Fail closed: never sign bytes that were not fully understood.
        return text(`REFUSED. ${err instanceof Error ? err.message : String(err)}`);
      }

      const decision = evaluate(tx, ownAddresses, config.limits, audit.committedTodayLovelace());

      if (!decision.allowed) {
        // CONTRACT (see audit.ts's own header comment): append() throws if the
        // write to disk fails. No funds move on a refusal either way, so this
        // is lower stakes than the signed branch below — but a refusal whose
        // audit record silently failed to write would still hand back a
        // clean-looking "REFUSED. <reason>" with nothing to indicate that the
        // refusal itself is now missing from the durable log. Caught here (not
        // left to propagate as a generic isError) specifically so the refusal
        // text and reason are ALWAYS delivered to the caller regardless of
        // audit health, with an appended note when the record could not be
        // written — never silence about it, never a bare unexplained error in
        // its place.
        try {
          audit.append({
            timestamp: new Date().toISOString(),
            txHash: tx.txHashHex,
            decision: 'refused',
            netOutflowLovelace: decision.netOutflowLovelace.toString(),
            reason: decision.reason,
            assetMovements: decision.assetMovements.length,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[sign] audit append failed for a REFUSED tx ${tx.txHashHex}: ${message}`);
          return text(
            `REFUSED. ${decision.reason}\n\n` +
              `Note: this refusal could NOT be recorded in the local audit log (${message}). ` +
              `No funds moved and nothing was signed, but the audit trail for this refusal is incomplete ` +
              `until the log is writable again.`
          );
        }
        return text(`REFUSED. ${decision.reason}`);
      }

      let signed;
      try {
        signed = signTransaction(txCbor, identity.privateKeyBech32);
      } catch (err) {
        return text(`REFUSED. Signing failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // HARD REQUIREMENT (audit.ts's own CONTRACT note; see also the task
      // report): append() throws on a write failure, by design. The reflex to
      // avoid here is `catch { warn(); return signed anyway; }` — that
      // reproduces exactly the failure the throw exists to prevent, just one
      // call site later: a real signature reaches the caller while no durable
      // record of it exists on disk, so the next process's
      // committedTodayLovelace() silently under-counts and the daily limit
      // stops binding. `signed.signedCborHex` is therefore not read anywhere
      // below this catch block — the only `return` that can reach it is the
      // one after a successful append.
      try {
        audit.append({
          timestamp: new Date().toISOString(),
          txHash: signed.txHashHex,
          decision: 'signed',
          netOutflowLovelace: decision.netOutflowLovelace.toString(),
          assetMovements: decision.assetMovements.length,
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

      return text(
        `# Signed\n\nHash: ${signed.txHashHex}\n` +
          `Net outflow: ${lovelaceToAda(decision.netOutflowLovelace)} AP3X\n\n` +
          `Signed CBOR:\n\`\`\`\n${signed.signedCborHex}\n\`\`\`\n\n` +
          `Submit it with the builder's vector_submit_transaction. Nothing has been submitted yet.`
      );
    }
  );

  server.tool(
    'vector_signer_get_spend_limits',
    'Report this signer\'s spend limits, how much of today\'s budget is committed, and recent signing decisions.',
    {},
    async () => {
      const committed = audit.committedTodayLovelace();
      const remaining = config.limits.dailyLovelace - committed;
      const recent = audit
        .recent(5)
        .map((e) => `  ${e.timestamp} ${e.decision.toUpperCase()} ${lovelaceToAda(BigInt(e.netOutflowLovelace))} AP3X ${e.txHash.slice(0, 16)}...${e.reason ? ` (${e.reason})` : ''}`)
        .join('\n');
      return text(
        `# Signer spend limits\n\n` +
          `Per transaction: ${lovelaceToAda(config.limits.perTxLovelace)} AP3X\n` +
          `Daily:           ${lovelaceToAda(config.limits.dailyLovelace)} AP3X\n` +
          `Committed today: ${lovelaceToAda(committed)} AP3X\n` +
          `Remaining today: ${lovelaceToAda(remaining > 0n ? remaining : 0n)} AP3X\n\n` +
          `Audit log: ${config.auditLogPath}\n\n` +
          (recent ? `Recent decisions:\n${recent}` : 'No decisions recorded yet.') +
          `\n\nNote: the daily total counts signed transactions at signing time. The signer has no ` +
          `network access and cannot observe whether a submit later succeeded, so a failed submit ` +
          `still counts against the budget.`
      );
    }
  );
}
