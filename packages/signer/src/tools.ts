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
        audit.append({
          timestamp: new Date().toISOString(),
          txHash: tx.txHashHex,
          decision: 'refused',
          netOutflowLovelace: decision.netOutflowLovelace.toString(),
          reason: decision.reason,
          assetMovements: decision.assetMovements.length,
        });
        return text(`REFUSED. ${decision.reason}`);
      }

      let signed;
      try {
        signed = signTransaction(txCbor, identity.privateKeyBech32);
      } catch (err) {
        return text(`REFUSED. Signing failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      audit.append({
        timestamp: new Date().toISOString(),
        txHash: signed.txHashHex,
        decision: 'signed',
        netOutflowLovelace: decision.netOutflowLovelace.toString(),
        assetMovements: decision.assetMovements.length,
      });

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
