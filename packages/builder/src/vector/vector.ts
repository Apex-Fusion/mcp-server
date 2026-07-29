import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Lucid } from '@lucid-evolution/lucid';

import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { OgmiosProvider, koiosIndicatesConfirmed } from '@apexfusion/vector-mcp-shared/provider';
import { lovelaceToAda, formatAssetName } from '@apexfusion/vector-mcp-shared/tx';
import {
  VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL, VECTOR_EXPLORER_URL, explorerTxLink,
} from '@apexfusion/vector-mcp-shared/config';
import { safetyLayer } from './safety.js';
import { limiterFor } from './rate-limiter.js';
import { pollUntilConfirmed, buildConfirmationCheck } from './poll.js';
import { registerAgentNetworkTools } from './agent-network.js';
import { registerSelfImprovementTools } from './self-improvement.js';
import type {
  VectorToken, VectorWalletInfo, VectorDryRunResult,
} from '@apexfusion/vector-mcp-shared/types';
import {
  lucidForAddress, buildSendApex, buildSendTokens, buildMultiOutput,
  buildDeployContract, buildInteractContract,
} from './build.js';

// Direct .env loading
const __filename = fileURLToPath(import.meta.url);
// From the bundled entrypoint at packages/builder/build/index.js, four levels
// up from the file lands on the repo root (build -> builder -> packages -> root).
const projectRoot = resolve(__filename, '../../../..');
const envPath = resolve(projectRoot, '.env');

if (existsSync(envPath)) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error('Error loading .env file:', result.error);
  }
}

// Initialize Lucid instance with Ogmios provider
async function initLucid(mnemonic: string, accountIndex: number = 0) {
  const provider = new OgmiosProvider({
    ogmiosUrl: VECTOR_OGMIOS_URL,
    submitUrl: VECTOR_SUBMIT_URL,
    koiosUrl: VECTOR_KOIOS_URL,
  });

  // Vector uses --mainnet flag, so addresses are addr1... format
  const lucid = await Lucid(provider, 'Mainnet');

  if (!mnemonic) {
    throw new Error('mnemonic is required');
  }

  const trimmedMnemonic = mnemonic.trim();
  const words = trimmedMnemonic.split(/\s+/);

  const validLengths = [12, 15, 18, 21, 24];
  if (!validLengths.includes(words.length)) {
    throw new Error(`Invalid mnemonic: Expected 12, 15, 18, 21 or 24 words, got ${words.length}`);
  }

  lucid.selectWallet.fromSeed(trimmedMnemonic, { accountIndex });

  const address = await lucid.wallet().address();
  if (!address) {
    throw new Error('Failed to derive address from mnemonic');
  }

  return lucid;
}

// Get wallet info
export async function getWalletInfo(mnemonic: string, accountIndex: number = 0): Promise<VectorWalletInfo> {
  console.error('[getWalletInfo] Initializing Lucid...');
  const lucid = await initLucid(mnemonic, accountIndex);
  console.error('[getWalletInfo] Getting address...');
  const address = await lucid.wallet().address();
  console.error('[getWalletInfo] Querying UTxOs...');
  const utxos = await lucid.utxosAt(address);
  console.error(`[getWalletInfo] Found ${utxos.length} UTxOs`);

  let adaBalance = '0';
  let tokenBalances: VectorToken[] = [];

  if (utxos.length > 0) {
    // Aggregate all UTxO assets
    const aggregated: Record<string, bigint> = {};
    for (const utxo of utxos) {
      for (const [unit, qty] of Object.entries(utxo.assets)) {
        aggregated[unit] = (aggregated[unit] || 0n) + BigInt(qty);
      }
    }

    adaBalance = aggregated['lovelace'] ? lovelaceToAda(aggregated['lovelace']) : '0';

    for (const [unit, quantity] of Object.entries(aggregated)) {
      if (unit === 'lovelace') continue;

      try {
        const policyId = unit.slice(0, 56);
        const assetNameHex = unit.slice(56);
        const displayName = assetNameHex
          ? formatAssetName(assetNameHex)
          : `${policyId.substring(0, 8)}...`;

        tokenBalances.push({
          unit,
          name: displayName,
          quantity: quantity.toString(),
        });
      } catch {
        tokenBalances.push({
          unit,
          name: unit,
          quantity: quantity.toString(),
        });
      }
    }
  }

  return {
    address,
    utxoCount: utxos.length,
    ada: adaBalance,
    tokens: tokenBalances,
  };
}

// Shared provider for the keyless build_* tools (Task 5 reuses this).
function makeProvider(): OgmiosProvider {
  return new OgmiosProvider({
    ogmiosUrl: VECTOR_OGMIOS_URL,
    submitUrl: VECTOR_SUBMIT_URL,
    koiosUrl: VECTOR_KOIOS_URL,
  });
}

// Register all Vector MCP tools
export function registerVectorTools(server: McpServer, identity: string) {
  const rateLimiter = limiterFor(identity);

  // vector_get_balance - Get balance for any address
  server.tool(
    "vector_get_balance",
    "Get AP3X and token balances for a Vector address",
    {
      address: z.string().describe("Vector address to check (addr1...)"),
    },
    async ({ address }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const provider = new OgmiosProvider({
          ogmiosUrl: VECTOR_OGMIOS_URL,
          submitUrl: VECTOR_SUBMIT_URL,
          koiosUrl: VECTOR_KOIOS_URL,
        });

        const utxos = await provider.getUtxos(address);

        // Aggregate all assets
        const tokenMap = new Map<string, bigint>();
        for (const utxo of utxos) {
          for (const [unit, qty] of Object.entries(utxo.assets)) {
            const current = tokenMap.get(unit) || 0n;
            tokenMap.set(unit, current + BigInt(qty));
          }
        }

        const adaBalance = tokenMap.get('lovelace') || 0n;
        tokenMap.delete('lovelace');

        const tokens = Array.from(tokenMap.entries()).map(([unit, quantity]) => {
          const policyId = unit.slice(0, 56);
          const assetNameHex = unit.slice(56);
          return {
            unit,
            policyId,
            assetName: formatAssetName(assetNameHex),
            quantity: quantity.toString(),
          };
        });

        tokens.sort((a, b) => (BigInt(b.quantity) - BigInt(a.quantity)) > 0n ? 1 : -1);

        const tokenList = tokens.length > 0
          ? tokens.map(t => `${t.quantity} ${t.assetName || t.unit} (Policy: ${t.policyId.substring(0, 8)}...)`).join('\n')
          : 'No tokens found';

        return {
          content: [{
            type: "text",
            text: `Vector Address Balance for ${address}:

AP3X Balance: ${lovelaceToAda(adaBalance)} AP3X
UTxO Count: ${utxos.length}

${tokens.length > 0 ? `Token Holdings (${tokens.length}):\n${tokenList}` : 'No token holdings found'}`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to retrieve Vector address balance: ${error.message}`,
          }],
        };
      }
    }
  );

  // vector_get_address - Get the agent's wallet address and balance
  server.tool(
    "vector_get_address",
    "Get the Vector wallet address, balance, and token holdings derived from a mnemonic",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the wallet"),
    },
    async ({ mnemonic }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const walletInfo = await getWalletInfo(mnemonic);

        const tokenList = walletInfo.tokens.length > 0
          ? walletInfo.tokens.map((t: VectorToken) => `${t.quantity} ${t.name}`).join('\n')
          : 'No tokens found';

        return {
          content: [{
            type: "text",
            text: `# Vector Wallet Information

Address: ${walletInfo.address}
AP3X Balance: ${walletInfo.ada} AP3X
UTXO Count: ${walletInfo.utxoCount}

${walletInfo.tokens.length > 0 ? `## Token Holdings (${walletInfo.tokens.length}):\n${tokenList}` : 'No token holdings found'}`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to get wallet information: ${error.message}

**Troubleshooting Tips:**
1. Make sure you have a valid 15 or 24-word BIP39 mnemonic
2. Verify the Ogmios endpoint is reachable: ${VECTOR_OGMIOS_URL}
3. Check the console logs for detailed error information`,
          }],
        };
      }
    }
  );

  // vector_get_utxos - List UTxOs for an address or the wallet
  server.tool(
    "vector_get_utxos",
    "List unspent transaction outputs (UTxOs) for a Vector address or a wallet derived from a mnemonic",
    {
      address: z.string().optional().describe("Vector address to query UTxOs for. If omitted, mnemonic is required."),
      mnemonic: z.string().optional().describe("15 or 24-word BIP39 mnemonic (required if address is omitted)"),
    },
    async ({ address, mnemonic }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        let utxos;
        let queryAddress: string;

        if (address) {
          const provider = new OgmiosProvider({
            ogmiosUrl: VECTOR_OGMIOS_URL,
            submitUrl: VECTOR_SUBMIT_URL,
            koiosUrl: VECTOR_KOIOS_URL,
          });
          utxos = await provider.getUtxos(address);
          queryAddress = address;
        } else {
          if (!mnemonic) throw new Error('Provide either address or mnemonic');
          const lucid = await initLucid(mnemonic);
          queryAddress = await lucid.wallet().address();
          utxos = await lucid.utxosAt(queryAddress);
        }

        if (utxos.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No UTxOs found for ${queryAddress}`,
            }],
          };
        }

        const utxoList = utxos.map((utxo, i) => {
          const ada = utxo.assets['lovelace'] ? lovelaceToAda(utxo.assets['lovelace']) : '0';
          const tokenCount = Object.keys(utxo.assets).filter(k => k !== 'lovelace').length;
          return `${i + 1}. ${utxo.txHash}#${utxo.outputIndex} - ${ada} AP3X${tokenCount > 0 ? ` + ${tokenCount} token(s)` : ''}`;
        }).join('\n');

        return {
          content: [{
            type: "text",
            text: `# UTxOs for ${queryAddress}

Total: ${utxos.length} UTxO(s)

${utxoList}`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to get UTxOs: ${error.message}`,
          }],
        };
      }
    }
  );

  // vector_build_send_apex - build an UNSIGNED AP3X payment (keyless)
  server.tool(
    "vector_build_send_apex",
    "Build an UNSIGNED transaction sending AP3X to a recipient. Takes no key material - sign the returned CBOR with your local signer (vector_signer_sign), then broadcast with vector_submit_transaction.",
    {
      changeAddress: z.string().describe("Your wallet address (source of funds; receives change). Get it from your local signer's vector_signer_get_address."),
      recipientAddress: z.string().describe("Recipient Vector address (addr1...)"),
      amount: z.number().min(1).describe("Amount of AP3X to send"),
      metadata: z.string().optional().describe("Optional transaction metadata in JSON format"),
    },
    async ({ changeAddress, recipientAddress, amount, metadata }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const lucid = await lucidForAddress(makeProvider(), changeAddress);
        const result = await buildSendApex(lucid, { recipientAddress, amountApex: amount, metadataJson: metadata });
        return {
          content: [{
            type: "text",
            text: `# Unsigned Transaction Built

**Amount:** ${amount} AP3X
**To:** ${recipientAddress}
**Estimated Fee:** ${result.feeAda} AP3X
**Tx Hash:** ${result.txHash}

**Unsigned TX CBOR:**
\`\`\`
${result.txCbor}
\`\`\`

Non-custodial flow: 1) sign locally with vector_signer_sign { txCbor } — your keys never leave your machine; 2) broadcast with vector_submit_transaction { signedTxCbor }; 3) confirm with vector_await_transaction { txHash }.`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to build transaction: ${error.message}

**Troubleshooting Tips:**
1. Verify the change address is your funded wallet address (addr1...)
2. Verify the recipient address is correct (addr1...)
3. Ensure the wallet has enough AP3X for the amount plus fees`,
          }],
        };
      }
    }
  );

  // vector_build_send_tokens - build an UNSIGNED native-token transfer (keyless)
  server.tool(
    "vector_build_send_tokens",
    "Build an UNSIGNED transaction sending Vector native tokens. Takes no key material - sign the returned CBOR with your local signer (vector_signer_sign), then broadcast with vector_submit_transaction.",
    {
      changeAddress: z.string().describe("Your wallet address (source of funds; receives change). Get it from your local signer's vector_signer_get_address."),
      recipientAddress: z.string().describe("Recipient Vector address (addr1...)"),
      policyId: z.string().describe("Token policy ID (56 hex characters)"),
      assetName: z.string().describe("Asset name (text or hex; can be empty for policy-only tokens)"),
      amount: z.string().describe("Amount of tokens to send"),
      adaAmount: z.number().optional().describe("Optional AP3X to include with the tokens (defaults to the 2 AP3X minimum)"),
    },
    async ({ changeAddress, recipientAddress, policyId, assetName, amount, adaAmount }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const lucid = await lucidForAddress(makeProvider(), changeAddress);
        const result = await buildSendTokens(lucid, { recipientAddress, policyId, assetName, amount, apexAmount: adaAmount });
        const displayName = assetName && !/^[0-9a-fA-F]+$/.test(assetName) ? assetName : (formatAssetName(assetName) || `${policyId.substring(0, 8)}...`);
        return {
          content: [{
            type: "text",
            text: `# Unsigned Token Transaction Built

**Token:** ${displayName}
**Amount:** ${amount}
**To:** ${recipientAddress}
**Estimated Fee:** ${result.feeAda} AP3X
**Tx Hash:** ${result.txHash}

**Unsigned TX CBOR:**
\`\`\`
${result.txCbor}
\`\`\`

Non-custodial flow: 1) sign locally with vector_signer_sign { txCbor }; 2) broadcast with vector_submit_transaction { signedTxCbor }; 3) confirm with vector_await_transaction { txHash }.`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to build token transaction: ${error.message}

**Troubleshooting Tips:**
1. Check that the wallet at changeAddress holds the token and enough AP3X
2. Verify the policy ID (56 hex chars) and asset name are correct
3. Verify the recipient address is correct (addr1...)`,
          }],
        };
      }
    }
  );

  // vector_get_spend_limits - Check safety layer status
  server.tool(
    "vector_get_spend_limits",
    "Check current spend limits and remaining daily budget",
    {},
    async () => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const status = safetyLayer.getSpendStatus();
        const log = safetyLayer.getAuditLog();

        const recentTxs = log.slice(-5).reverse().map((entry) =>
          `- ${entry.timestamp}: ${lovelaceToAda(entry.amountLovelace)} AP3X → ${entry.recipient.substring(0, 20)}... (${entry.txHash.substring(0, 16)}...)`
        ).join('\n');

        return {
          content: [{
            type: "text",
            text: `# Vector Spend Limits

Per-Transaction Limit: ${lovelaceToAda(status.perTransactionLimit)} AP3X
Daily Limit: ${lovelaceToAda(status.dailyLimit)} AP3X
Daily Spent: ${lovelaceToAda(status.dailySpent)} AP3X
Daily Remaining: ${lovelaceToAda(status.dailyRemaining)} AP3X
Resets At: ${status.resetTime}

${log.length > 0 ? `## Recent Transactions (last ${Math.min(5, log.length)}):\n${recentTxs}` : 'No transactions recorded yet.'}`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to get spend limits: ${error.message}`,
          }],
        };
      }
    }
  );

  // vector_build_transaction - build an UNSIGNED multi-output transaction (keyless)
  server.tool(
    "vector_build_transaction",
    "Build an UNSIGNED multi-output transaction with optional metadata. Takes no key material and never submits - sign the returned CBOR with your local signer (vector_signer_sign), then broadcast with vector_submit_transaction.",
    {
      changeAddress: z.string().describe("Your wallet address (source of funds; receives change). Get it from your local signer's vector_signer_get_address."),
      outputs: z.array(z.object({
        address: z.string().describe("Recipient Vector address"),
        lovelace: z.number().describe("Amount in lovelace (1 AP3X = 1,000,000 lovelace)"),
        assets: z.record(z.string(), z.string()).optional().describe("Optional native assets: { 'policyId+assetNameHex': 'quantity' }"),
      })).min(1).describe("Transaction outputs"),
      metadata: z.string().optional().describe("Optional JSON metadata (attached under label 674)"),
    },
    async ({ changeAddress, outputs, metadata }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const lucid = await lucidForAddress(makeProvider(), changeAddress);
        const result = await buildMultiOutput(lucid, { outputs, metadataJson: metadata });
        const totalLovelace = outputs.reduce((sum, o) => sum + o.lovelace, 0);
        return {
          content: [{
            type: "text",
            text: `# Unsigned Transaction Built (Not Submitted)

**Tx Hash:** ${result.txHash}
**Fee:** ${result.feeAda} AP3X
**Outputs:** ${outputs.length}
**Total AP3X:** ${lovelaceToAda(totalLovelace)} AP3X

**Unsigned TX CBOR:**
\`\`\`
${result.txCbor}
\`\`\`

Use vector_dry_run with this CBOR to simulate it, sign it locally with vector_signer_sign, then broadcast with vector_submit_transaction.`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to build transaction: ${error.message}

**Troubleshooting Tips:**
1. Verify all recipient addresses are valid (addr1...)
2. Ensure the wallet at changeAddress has enough AP3X for outputs + fees`,
          }],
        };
      }
    }
  );

  // vector_dry_run - Simulate a transaction without submitting
  server.tool(
    "vector_dry_run",
    "Simulate a transaction without submitting - returns fee estimate and validation result",
    {
      txCbor: z.string().optional().describe("Hex-encoded CBOR of a built transaction to evaluate"),
      outputs: z.array(z.object({
        address: z.string().describe("Recipient Vector address"),
        lovelace: z.number().describe("Amount in lovelace"),
        assets: z.record(z.string(), z.string()).optional(),
      })).optional().describe("If no txCbor provided, build a TX from these outputs and evaluate it"),
      mnemonic: z.string().optional().describe("15 or 24-word BIP39 mnemonic (required when outputs is provided)"),
      metadata: z.string().optional().describe("Optional JSON metadata when building from outputs"),
    },
    async ({ txCbor, outputs, mnemonic, metadata }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        let cborToEvaluate = txCbor;
        let feeFromBuild: string | null = null;

        if (!cborToEvaluate && outputs && outputs.length > 0) {
          // Build the transaction first
          if (!mnemonic) throw new Error('mnemonic is required when building from outputs');
          const lucid = await initLucid(mnemonic);

          let tx = lucid.newTx();
          for (const output of outputs) {
            const assets: Record<string, bigint> = { lovelace: BigInt(output.lovelace) };
            if (output.assets) {
              for (const [unit, qty] of Object.entries(output.assets)) {
                assets[unit] = BigInt(qty);
              }
            }
            tx = tx.pay.ToAddress(output.address, assets);
          }

          if (metadata) {
            const parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
            tx = tx.attachMetadata(674, parsedMetadata);
          }

          const completedTx = await tx.complete();
          const txJson = (completedTx as any).toJSON?.() ?? {};
          feeFromBuild = String(txJson?.body?.fee ?? '0');
          const signedTx = await completedTx.sign.withWallet().complete();
          cborToEvaluate = signedTx.toCBOR();
        }

        if (!cborToEvaluate) {
          throw new Error('Provide either txCbor or outputs to evaluate');
        }

        const provider = new OgmiosProvider({
          ogmiosUrl: VECTOR_OGMIOS_URL,
          submitUrl: VECTOR_SUBMIT_URL,
          koiosUrl: VECTOR_KOIOS_URL,
        });

        let evalResult: VectorDryRunResult;
        try {
          const result = await provider.evaluateTransaction(cborToEvaluate);

          // Parse Ogmios evaluateTransaction response
          let totalMemory = 0;
          let totalCpu = 0;
          if (Array.isArray(result)) {
            for (const item of result) {
              if (item.budget) {
                totalMemory += item.budget.memory || 0;
                totalCpu += item.budget.cpu || 0;
              }
            }
          }

          const fee = feeFromBuild || '0';
          evalResult = {
            valid: true,
            fee,
            feeAda: lovelaceToAda(fee),
            executionUnits: (totalMemory > 0 || totalCpu > 0) ? { memory: totalMemory, cpu: totalCpu } : undefined,
          };
        } catch (evalErr) {
          // evaluateTransaction failed - still return fee if we built the tx
          if (feeFromBuild) {
            evalResult = {
              valid: true,
              fee: feeFromBuild,
              feeAda: lovelaceToAda(feeFromBuild),
              error: `Script evaluation unavailable: ${(evalErr as Error).message}. Fee estimate is from transaction building.`,
            };
          } else {
            evalResult = {
              valid: false,
              fee: '0',
              feeAda: '0',
              error: `Evaluation failed: ${(evalErr as Error).message}`,
            };
          }
        }

        return {
          content: [{
            type: "text",
            text: `# Dry Run Result

Valid: ${evalResult.valid ? 'Yes' : 'No'}
Estimated Fee: ${evalResult.feeAda} AP3X (${evalResult.fee} lovelace)
${evalResult.executionUnits ? `Execution Units: Memory ${evalResult.executionUnits.memory}, CPU ${evalResult.executionUnits.cpu}` : ''}
${evalResult.error ? `\nNote: ${evalResult.error}` : ''}

No transaction was submitted to the network.`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Dry run failed: ${error.message}`,
          }],
        };
      }
    }
  );

  // vector_submit_transaction - submit an externally signed transaction
  server.tool(
    "vector_submit_transaction",
    "Submit an already-signed transaction to Vector. Use this to broadcast CBOR signed elsewhere (for example by a local signer). Does not sign anything.",
    {
      signedTxCbor: z.string().describe("Hex-encoded CBOR of a fully signed transaction"),
    },
    async ({ signedTxCbor }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const provider = new OgmiosProvider({
          ogmiosUrl: VECTOR_OGMIOS_URL,
          submitUrl: VECTOR_SUBMIT_URL,
          koiosUrl: VECTOR_KOIOS_URL,
        });
        const txHash = await provider.submitTx(signedTxCbor);
        return {
          content: [{
            type: "text",
            text: `# Transaction Submitted

Transaction Hash: ${txHash}

[View on Explorer](${explorerTxLink(txHash)})`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to submit transaction: ${error.message}

**Troubleshooting Tips:**
1. Ensure the CBOR is a fully signed transaction, not an unsigned one
2. A transaction can only be submitted once - check the explorer if unsure
3. Verify the submit endpoint is reachable`,
          }],
        };
      }
    }
  );

  // vector_await_transaction - wait for on-chain confirmation
  server.tool(
    "vector_await_transaction",
    "Wait for a submitted transaction to be confirmed on Vector. Polls until it appears on-chain or the timeout elapses.",
    {
      txHash: z.string().describe("Transaction hash returned by vector_submit_transaction"),
      timeoutSeconds: z.number().min(1).max(300).optional().describe("How long to wait before giving up (default: 120)"),
    },
    async ({ txHash, timeoutSeconds }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const provider = new OgmiosProvider({
          ogmiosUrl: VECTOR_OGMIOS_URL,
          submitUrl: VECTOR_SUBMIT_URL,
          koiosUrl: VECTOR_KOIOS_URL,
        });
        const budgetMs = (timeoutSeconds ?? 120) * 1000;
        const intervalMs = 3000;
        const confirmed = await pollUntilConfirmed(
          buildConfirmationCheck(
            Boolean(VECTOR_KOIOS_URL),
            async () => koiosIndicatesConfirmed(await provider.getKoiosTxStatus(txHash)),
            async () => {
              const utxos = await provider.getUtxosByOutRef([{ txHash, outputIndex: 0 }]);
              return utxos.length > 0;
            },
          ),
          budgetMs,
          intervalMs,
        );
        return {
          content: [{
            type: "text",
            text: confirmed
              ? `# Transaction Confirmed\n\nTransaction Hash: ${txHash}\n\n[View on Explorer](${explorerTxLink(txHash)})`
              : `# Not Confirmed Yet\n\nTransaction ${txHash} did not appear on-chain within ${timeoutSeconds ?? 120}s.\n\nThis does not mean it failed - it may still be pending. Check the explorer.\n\n[View on Explorer](${explorerTxLink(txHash)})`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return { content: [{ type: "text", text: `Failed to check transaction status: ${error.message}` }] };
      }
    }
  );

  // vector_get_transaction_history - Get transaction history via Koios
  server.tool(
    "vector_get_transaction_history",
    "Get transaction history for a Vector address via Koios indexed queries",
    {
      address: z.string().optional().describe("Vector address to query. If omitted, mnemonic is required."),
      mnemonic: z.string().optional().describe("15 or 24-word BIP39 mnemonic (required if address is omitted)"),
      limit: z.number().min(1).max(50).optional().describe("Number of transactions to return (default: 20, max: 50)"),
      offset: z.number().min(0).optional().describe("Offset for pagination (default: 0)"),
    },
    async ({ address, mnemonic, limit, offset }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        let queryAddress = address;
        if (!queryAddress) {
          if (!mnemonic) throw new Error('Provide either address or mnemonic');
          const lucid = await initLucid(mnemonic);
          queryAddress = await lucid.wallet().address();
        }

        const provider = new OgmiosProvider({
          ogmiosUrl: VECTOR_OGMIOS_URL,
          submitUrl: VECTOR_SUBMIT_URL,
          koiosUrl: VECTOR_KOIOS_URL,
        });

        const txs = await provider.getTransactionHistory(queryAddress, offset || 0, limit || 20);

        if (txs.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No transactions found for ${queryAddress}`,
            }],
          };
        }

        const txList = txs.map((tx, i) => {
          const feeAda = tx.fee ? lovelaceToAda(tx.fee) : 'N/A';
          return `${i + 1}. ${tx.txHash}\n   Block: ${tx.blockHeight} | Time: ${tx.blockTime} | Fee: ${feeAda} AP3X`;
        }).join('\n\n');

        return {
          content: [{
            type: "text",
            text: `# Transaction History for ${queryAddress}

Showing ${txs.length} transaction(s) (offset: ${offset || 0}):

${txList}

[View on Explorer](${VECTOR_EXPLORER_URL}/address/${queryAddress})`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to get transaction history: ${error.message}

**Troubleshooting Tips:**
1. Ensure Koios is configured and reachable: ${VECTOR_KOIOS_URL}
2. Verify the address is valid
3. Check the block explorer for this address`,
          }],
        };
      }
    }
  );

  // vector_build_deploy_contract - build an UNSIGNED contract deployment (keyless)
  server.tool(
    "vector_build_deploy_contract",
    "Build an UNSIGNED transaction deploying a Plutus/Aiken smart contract (locks funds at its script address). Takes no key material - sign with your local signer, then broadcast with vector_submit_transaction.",
    {
      changeAddress: z.string().describe("Your wallet address (source of funds; receives change). Get it from your local signer's vector_signer_get_address."),
      scriptCbor: z.string().describe("Compiled Plutus/Aiken script in CBOR hex format"),
      scriptType: z.enum(["PlutusV1", "PlutusV2", "PlutusV3"]).describe("Script version"),
      initialDatum: z.string().optional().describe("Initial datum as CBOR hex. Use 'd87980' for void/unit datum. Defaults to void if omitted."),
      lovelaceAmount: z.number().optional().describe("AP3X to lock at the script address in lovelace (default: 2,000,000 = 2 AP3X)"),
    },
    async ({ changeAddress, scriptCbor, scriptType, initialDatum, lovelaceAmount }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const lucid = await lucidForAddress(makeProvider(), changeAddress);
        const result = await buildDeployContract(lucid, { scriptCbor, scriptType, initialDatum, lovelaceAmount });
        return {
          content: [{
            type: "text",
            text: `# Unsigned Contract Deployment Built

**Script Address:** ${result.scriptAddress}
**Script Hash:** ${result.scriptHash}
**Script Type:** ${result.scriptType}
**Estimated Fee:** ${result.feeAda} AP3X
**Tx Hash:** ${result.txHash}

**Unsigned TX CBOR:**
\`\`\`
${result.txCbor}
\`\`\`

Sign locally with vector_signer_sign, broadcast with vector_submit_transaction, then use vector_build_interact_contract to interact with the deployed contract.`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to build contract deployment: ${error.message}

**Troubleshooting Tips:**
1. Verify the script CBOR is valid hex (compiled Aiken or Plutus output)
2. Ensure the wallet at changeAddress has sufficient AP3X for the locked amount + fees
3. Check that the script type matches the compiled version (PlutusV1/V2/V3)`,
          }],
        };
      }
    }
  );

  // vector_build_interact_contract - build an UNSIGNED contract interaction (keyless)
  server.tool(
    "vector_build_interact_contract",
    "Build an UNSIGNED transaction interacting with a deployed Plutus/Aiken contract - lock AP3X at it or spend from it. Takes no key material - sign with your local signer, then broadcast with vector_submit_transaction.",
    {
      changeAddress: z.string().describe("Your wallet address (source of funds, change, and the required signer for spends). Get it from your local signer's vector_signer_get_address."),
      scriptCbor: z.string().describe("Compiled Plutus/Aiken script in CBOR hex"),
      scriptType: z.enum(["PlutusV1", "PlutusV2", "PlutusV3"]).describe("Script version"),
      action: z.enum(["spend", "lock"]).describe("'spend' to collect UTxOs from the script, 'lock' to send funds to it"),
      redeemer: z.string().optional().describe("Redeemer as CBOR hex (required for spend, use 'd87980' for void)"),
      datum: z.string().optional().describe("Datum as CBOR hex (required for lock, use 'd87980' for void)"),
      lovelaceAmount: z.number().optional().describe("Lovelace to lock (for lock action, default: 2,000,000 = 2 AP3X)"),
      utxoRef: z.object({
        txHash: z.string(),
        outputIndex: z.number(),
      }).optional().describe("Specific UTxO to spend from (optional, otherwise spends all UTxOs at script address)"),
      assets: z.record(z.string(), z.string()).optional().describe("Additional native assets for lock action: { 'policyId+assetNameHex': 'quantity' }"),
    },
    async ({ changeAddress, scriptCbor, scriptType, action, redeemer, datum, lovelaceAmount, utxoRef, assets }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const lucid = await lucidForAddress(makeProvider(), changeAddress);
        const result = await buildInteractContract(lucid, {
          scriptCbor, scriptType, action, changeAddress, redeemer, datum, lovelaceAmount, utxoRef, assets,
        });
        const actionVerb = result.action === 'spend' ? 'collects from' : 'locks funds at';
        return {
          content: [{
            type: "text",
            text: `# Unsigned Contract Interaction Built

**Action:** ${result.action} (${actionVerb} the script address)
**Script Address:** ${result.scriptAddress}
**Estimated Fee:** ${result.feeAda} AP3X
**Tx Hash:** ${result.txHash}

**Unsigned TX CBOR:**
\`\`\`
${result.txCbor}
\`\`\`

Sign locally with vector_signer_sign { txCbor }, then broadcast with vector_submit_transaction { signedTxCbor }.`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to build contract interaction: ${error.message}

**Troubleshooting Tips:**
1. For 'spend': ensure the script address has UTxOs and the redeemer satisfies the validator
2. For 'lock': ensure the wallet at changeAddress has sufficient AP3X and the datum matches the script's expectations
3. Spending requires collateral - ensure the wallet has a pure-AP3X UTxO (no native tokens)
4. Verify the script CBOR matches the deployed script exactly`,
          }],
        };
      }
    }
  );

  // Agent network tools (register, discover, message, profile) live in agent-network.ts
  // to isolate C (Cardano WASM) imports from tsc's complex type inference
  registerAgentNetworkTools(server, identity);

  // Self-Improvement Module tools (Module 6)
  registerSelfImprovementTools(server, identity);
}
