import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Lucid, fromText, Data, applyDoubleCborEncoding } from 'lucid-cardano';
import type { SpendingValidator } from 'lucid-cardano';

/**
 * Lucid v0.10.x lacks PlutusV3 support. This helper downcasts PlutusV3 to
 * PlutusV2 for hashing/address derivation (same blake2b-224 algorithm).
 * Use this when passing validators to any Lucid method.
 */
function lucidCompat(validator: SpendingValidator): SpendingValidator {
  if ((validator.type as string) === 'PlutusV3') {
    return { ...validator, type: 'PlutusV2' as const };
  }
  return validator;
}
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { OgmiosProvider } from './ogmios-provider.js';
import { safetyLayer } from './safety.js';
import { rateLimiter } from './rate-limiter.js';
import { registerAgentNetworkTools } from './agent-network.js';
import type {
  VectorToken,
  VectorWalletInfo,
  VectorAdaTransactionResult,
  VectorTokenTransactionResult,
  TxOutput,
  VectorBuildTransactionResult,
  VectorDryRunResult,
  VectorDeployContractResult,
  VectorInteractContractResult,
} from './types.js';

// Direct .env loading
const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(__filename, '../../../..');
const envPath = resolve(projectRoot, '.env');

if (existsSync(envPath)) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error('Error loading .env file:', result.error);
  }
}

// Configuration from environment variables
const VECTOR_OGMIOS_URL = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const VECTOR_SUBMIT_URL = process.env.VECTOR_SUBMIT_URL || 'https://submit.vector.testnet.apexfusion.org/api/submit/tx';
const VECTOR_KOIOS_URL = process.env.VECTOR_KOIOS_URL || 'https://koios.vector.testnet.apexfusion.org/';
const VECTOR_EXPLORER_URL = process.env.VECTOR_EXPLORER_URL || 'https://vector.testnet.apexscan.org';

// Helper function to format ADA amounts
function lovelaceToAda(lovelace: string | number | bigint): string {
  return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
}

// Helper function to format asset name
function formatAssetName(name: string): string {
  try {
    if (/^[0-9a-fA-F]+$/.test(name) && name.length > 0) {
      return Buffer.from(name, 'hex').toString('utf8');
    }
    return name;
  } catch {
    return name;
  }
}

// Explorer link helper
function explorerTxLink(txHash: string): string {
  return `${VECTOR_EXPLORER_URL}/transaction/${txHash}`;
}

// Initialize Lucid instance with Ogmios provider
async function initLucid(mnemonic: string, accountIndex: number = 0) {
  const provider = new OgmiosProvider({
    ogmiosUrl: VECTOR_OGMIOS_URL,
    submitUrl: VECTOR_SUBMIT_URL,
    koiosUrl: VECTOR_KOIOS_URL,
  });

  // Vector uses --mainnet flag, so addresses are addr1... format
  const lucid = await Lucid.new(provider, 'Mainnet');

  if (!mnemonic) {
    throw new Error('mnemonic is required');
  }

  const trimmedMnemonic = mnemonic.trim();
  const words = trimmedMnemonic.split(/\s+/);

  const validLengths = [12, 15, 18, 21, 24];
  if (!validLengths.includes(words.length)) {
    throw new Error(`Invalid mnemonic: Expected 12, 15, 18, 21 or 24 words, got ${words.length}`);
  }

  lucid.selectWalletFromSeed(trimmedMnemonic, { accountIndex });

  const address = await lucid.wallet.address();
  if (!address) {
    throw new Error('Failed to derive address from mnemonic');
  }

  // Store the full wallet address so credential-based UTxO lookups resolve correctly
  provider.setWalletAddress(address);

  return lucid;
}

// Get wallet info
export async function getWalletInfo(mnemonic: string, accountIndex: number = 0): Promise<VectorWalletInfo> {
  const lucid = await initLucid(mnemonic, accountIndex);
  const address = await lucid.wallet.address();
  const utxos = await lucid.utxosAt(address);

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

// Send ADA transaction
export async function sendAda(
  recipientAddress: string,
  amountAda: number,
  mnemonic: string,
  metadata: any = null
): Promise<VectorAdaTransactionResult> {
  if (!recipientAddress) {
    throw new Error('Recipient address is required');
  }

  if (typeof amountAda !== 'number' || amountAda <= 0) {
    throw new Error('Amount must be a positive number');
  }

  const lovelaceAmount = Math.floor(amountAda * 1_000_000);

  // Safety check
  const safetyCheck = safetyLayer.checkTransaction(lovelaceAmount);
  if (!safetyCheck.allowed) {
    throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);
  }

  const lucid = await initLucid(mnemonic);
  const senderAddress = await lucid.wallet.address();

  // Validate recipient address
  try {
    // @ts-ignore
    lucid.utils.getAddressDetails(recipientAddress);
  } catch (error) {
    throw new Error(`Invalid recipient address: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Build transaction
  // @ts-ignore
  let tx = lucid.newTx()
    .payToAddress(recipientAddress, { lovelace: BigInt(lovelaceAmount) });

  if (metadata) {
    const parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    // @ts-ignore
    tx = tx.attachMetadata(674, parsedMetadata);
  }

  // @ts-ignore
  tx = await tx.complete();
  // @ts-ignore
  const signedTx = await tx.sign().complete();
  const txHash = await signedTx.submit();

  // Record in safety layer
  safetyLayer.recordTransaction(txHash, lovelaceAmount, recipientAddress);

  return {
    txHash,
    senderAddress,
    recipientAddress,
    amount: amountAda,
    links: {
      explorer: explorerTxLink(txHash),
    },
  };
}

// Send tokens transaction
export async function sendTokens(
  recipientAddress: string,
  policyId: string,
  assetName: string,
  amount: string,
  mnemonic: string,
  adaAmount: number | null = null
): Promise<VectorTokenTransactionResult> {
  if (!recipientAddress) throw new Error('Recipient address is required');
  if (!policyId) throw new Error('Policy ID is required');
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    throw new Error('Amount must be a positive number');
  }

  // Safety check on ADA portion
  const adaLovelace = adaAmount ? Math.floor(adaAmount * 1_000_000) : 2_000_000; // min ~2 ADA
  const safetyCheck = safetyLayer.checkTransaction(adaLovelace);
  if (!safetyCheck.allowed) {
    throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);
  }

  const lucid = await initLucid(mnemonic);
  const senderAddress = await lucid.wallet.address();

  try {
    // @ts-ignore
    lucid.utils.getAddressDetails(recipientAddress);
  } catch (error) {
    throw new Error(`Invalid recipient address: ${error instanceof Error ? error.message : String(error)}`);
  }

  let assetNameHex = assetName;
  if (assetName && !/^[0-9a-fA-F]+$/.test(assetName)) {
    assetNameHex = fromText(assetName);
  }

  const unit = `${policyId}${assetNameHex}`;
  const assets = { [unit]: BigInt(amount) };

  const outputLovelace = adaAmount
    ? BigInt(Math.floor(adaAmount * 1_000_000))
    : BigInt(2_000_000); // Default min ADA

  // @ts-ignore
  let tx = lucid.newTx()
    .payToAddress(recipientAddress, {
      lovelace: outputLovelace,
      ...assets,
    });

  // @ts-ignore
  tx = await tx.complete();
  // @ts-ignore
  const signedTx = await tx.sign().complete();
  const txHash = await signedTx.submit();

  safetyLayer.recordTransaction(txHash, Number(outputLovelace), recipientAddress);

  const displayAssetName = assetName ? formatAssetName(assetNameHex) : '';

  return {
    txHash,
    senderAddress,
    recipientAddress,
    token: {
      policyId,
      name: displayAssetName,
      amount,
    },
    ada: lovelaceToAda(outputLovelace),
    links: {
      explorer: explorerTxLink(txHash),
    },
  };
}

// Build a complex multi-output transaction
export async function buildTransaction(
  outputs: TxOutput[],
  mnemonic: string,
  metadata: any = null,
  submit: boolean = false,
): Promise<VectorBuildTransactionResult> {
  if (!outputs || outputs.length === 0) {
    throw new Error('At least one output is required');
  }

  // Calculate total ADA across all outputs for safety check
  const totalLovelace = outputs.reduce((sum, o) => sum + o.lovelace, 0);
  const safetyCheck = safetyLayer.checkTransaction(totalLovelace);
  if (!safetyCheck.allowed) {
    throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);
  }

  const lucid = await initLucid(mnemonic);

  // @ts-ignore
  let tx = lucid.newTx();

  for (const output of outputs) {
    const assets: Record<string, bigint> = {
      lovelace: BigInt(output.lovelace),
    };
    if (output.assets) {
      for (const [unit, qty] of Object.entries(output.assets)) {
        assets[unit] = BigInt(qty);
      }
    }
    tx = tx.payToAddress(output.address, assets);
  }

  if (metadata) {
    const parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    // @ts-ignore
    tx = tx.attachMetadata(674, parsedMetadata);
  }

  // @ts-ignore
  const completedTx = await tx.complete();
  // @ts-ignore
  const fee = completedTx.fee;
  // @ts-ignore
  const txHash = completedTx.toHash();
  // @ts-ignore
  const txCbor = completedTx.toString();

  if (submit) {
    // @ts-ignore
    const signedTx = await completedTx.sign().complete();
    const submittedHash = await signedTx.submit();

    safetyLayer.recordTransaction(submittedHash, totalLovelace, outputs.map(o => o.address).join(', '));

    return {
      txCbor: '',
      txHash: submittedHash,
      fee: String(fee),
      feeAda: lovelaceToAda(fee),
      outputCount: outputs.length,
      totalAda: lovelaceToAda(totalLovelace),
      submitted: true,
      links: { explorer: explorerTxLink(submittedHash) },
    };
  }

  return {
    txCbor,
    txHash,
    fee: String(fee),
    feeAda: lovelaceToAda(fee),
    outputCount: outputs.length,
    totalAda: lovelaceToAda(totalLovelace),
    submitted: false,
  };
}

// Deploy a smart contract by locking funds at the script address
export async function deployContract(
  scriptCbor: string,
  scriptType: string,
  mnemonic: string,
  initialDatum: string | null = null,
  lovelaceAmount: number = 2_000_000,
): Promise<VectorDeployContractResult> {
  const safetyCheck = safetyLayer.checkTransaction(lovelaceAmount);
  if (!safetyCheck.allowed) {
    throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);
  }

  const lucid = await initLucid(mnemonic);

  const validator: SpendingValidator = {
    type: scriptType as any,
    script: applyDoubleCborEncoding(scriptCbor),
  };

  // @ts-ignore
  const scriptAddress = lucid.utils.validatorToAddress(lucidCompat(validator));
  // @ts-ignore
  const scriptHash = lucid.utils.validatorToScriptHash(lucidCompat(validator));

  const datum = initialDatum || Data.void();

  // @ts-ignore
  let tx = lucid.newTx()
    .payToContract(scriptAddress, { inline: datum }, { lovelace: BigInt(lovelaceAmount) });

  // @ts-ignore
  tx = await tx.complete();
  // @ts-ignore
  const signedTx = await tx.sign().complete();
  const txHash = await signedTx.submit();

  safetyLayer.recordTransaction(txHash, lovelaceAmount, scriptAddress);

  return {
    txHash,
    scriptAddress,
    scriptHash,
    scriptType,
    links: { explorer: explorerTxLink(txHash) },
  };
}

// Interact with a deployed smart contract (lock or spend)
export async function interactWithContract(
  scriptCbor: string,
  scriptType: string,
  action: 'spend' | 'lock',
  mnemonic: string,
  redeemer: string | null = null,
  datum: string | null = null,
  lovelaceAmount: number = 2_000_000,
  utxoRef: { txHash: string; outputIndex: number } | null = null,
  assets: Record<string, string> | null = null,
): Promise<VectorInteractContractResult> {
  const lucid = await initLucid(mnemonic);
  const walletAddress = await lucid.wallet.address();

  const validator: SpendingValidator = {
    type: scriptType as any,
    script: applyDoubleCborEncoding(scriptCbor),
  };

  // @ts-ignore
  const scriptAddress = lucid.utils.validatorToAddress(lucidCompat(validator));

  if (action === 'lock') {
    const safetyCheck = safetyLayer.checkTransaction(lovelaceAmount);
    if (!safetyCheck.allowed) {
      throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);
    }

    const datumData = datum || Data.void();
    const outputAssets: Record<string, bigint> = { lovelace: BigInt(lovelaceAmount) };
    if (assets) {
      for (const [unit, qty] of Object.entries(assets)) {
        outputAssets[unit] = BigInt(qty);
      }
    }

    // @ts-ignore
    let tx = lucid.newTx()
      .payToContract(scriptAddress, { inline: datumData }, outputAssets);

    // @ts-ignore
    tx = await tx.complete();
    // @ts-ignore
    const signedTx = await tx.sign().complete();
    const txHash = await signedTx.submit();

    safetyLayer.recordTransaction(txHash, lovelaceAmount, scriptAddress);

    return {
      txHash,
      scriptAddress,
      action: 'lock',
      links: { explorer: explorerTxLink(txHash) },
    };
  } else {
    // SPEND: collect from script
    let scriptUtxos;
    if (utxoRef) {
      scriptUtxos = await lucid.provider.getUtxosByOutRef([utxoRef]);
    } else {
      scriptUtxos = await lucid.provider.getUtxos(scriptAddress);
    }

    if (!scriptUtxos || scriptUtxos.length === 0) {
      throw new Error(`No UTxOs found at script address ${scriptAddress}`);
    }

    const redeemerData = redeemer || Data.void();

    // @ts-ignore
    let tx = lucid.newTx()
      .collectFrom(scriptUtxos, redeemerData)
      .attachSpendingValidator(lucidCompat(validator))
      .addSigner(walletAddress);

    try {
      // @ts-ignore
      tx = await tx.complete();
    } catch (err) {
      // Retry without native UPLC evaluator if it fails
      // @ts-ignore
      tx = await lucid.newTx()
        .collectFrom(scriptUtxos, redeemerData)
        .attachSpendingValidator(lucidCompat(validator))
        .addSigner(walletAddress)
        .complete({ nativeUplc: false });
    }

    // @ts-ignore
    const signedTx = await tx.sign().complete();
    const txHash = await signedTx.submit();

    // No spend recording for collecting — funds are coming back to wallet

    return {
      txHash,
      scriptAddress,
      action: 'spend',
      links: { explorer: explorerTxLink(txHash) },
    };
  }
}

// Register all Vector MCP tools
export function registerVectorTools(server: McpServer) {

  // vector_get_balance — Get balance for any address
  // @ts-ignore: MCP SDK deep type instantiation
  server.tool(
    "vector_get_balance",
    "Get ADA and token balances for a Vector address",
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

ADA Balance: ${lovelaceToAda(adaBalance)} ADA
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

  // vector_get_address — Get the agent's wallet address and balance
  // @ts-ignore: MCP SDK deep type instantiation
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
ADA Balance: ${walletInfo.ada} ADA
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

  // vector_get_utxos — List UTxOs for an address or the wallet
  // @ts-ignore: MCP SDK deep type instantiation
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
          queryAddress = await lucid.wallet.address();
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
          return `${i + 1}. ${utxo.txHash}#${utxo.outputIndex} — ${ada} ADA${tokenCount > 0 ? ` + ${tokenCount} token(s)` : ''}`;
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

  // vector_send_apex — Send APEX with safety limits (or craft unsigned TX)
  // @ts-ignore: MCP SDK deep type instantiation
  server.tool(
    "vector_send_apex",
    "Send ADA from a wallet to a recipient address. Set unsigned_only=true to return unsigned CBOR without submitting (transaction-crafter mode).",
    {
      recipientAddress: z.string().describe("Recipient Vector address (addr1...)"),
      amount: z.number().min(1).describe("Amount of ADA to send"),
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the sending wallet"),
      metadata: z.string().optional().describe("Optional transaction metadata in JSON format"),
      unsigned_only: z.boolean().optional().default(false).describe("If true, return unsigned TX CBOR without signing or submitting"),
    },
    async ({ recipientAddress, amount, mnemonic, metadata, unsigned_only }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        if (unsigned_only) {
          const lovelaceAmount = BigInt(Math.floor(amount * 1_000_000));
          const lucid = await initLucid(mnemonic);
          // @ts-ignore
          let txBuilder = lucid.newTx().payToAddress(recipientAddress, { lovelace: lovelaceAmount });
          if (metadata) {
            const parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
            // @ts-ignore
            txBuilder = txBuilder.attachMetadata(674, parsedMetadata);
          }
          // @ts-ignore
          const tx = await txBuilder.complete();
          // @ts-ignore
          const fee = tx.fee;
          // @ts-ignore
          const txCbor = tx.toString();
          return {
            content: [{
              type: "text",
              text: `# Unsigned Transaction (Transaction-Crafter Mode)

**Amount:** ${amount} ADA (${lovelaceAmount} lovelace)
**To:** ${recipientAddress}
**Estimated Fee:** ${lovelaceToAda(fee)} ADA

**Unsigned TX CBOR:**
\`\`\`
${txCbor}
\`\`\`

This transaction has NOT been submitted. Sign and submit it separately.`,
            }],
          };
        }

        const result = await sendAda(recipientAddress, amount, mnemonic, metadata);
        return {
          content: [{
            type: "text",
            text: `# ADA Transaction Successful

Transaction Hash: ${result.txHash}
From: ${result.senderAddress}
To: ${result.recipientAddress}
Amount: ${result.amount} ADA

[View on Explorer](${result.links.explorer})`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to send ADA: ${error.message}

**Troubleshooting Tips:**
1. Check that your wallet has sufficient balance
2. Verify the recipient address is correct (addr1...)
3. Check spend limits with vector_get_spend_limits
4. Verify the Ogmios endpoint is reachable`,
          }],
        };
      }
    }
  );

  // vector_send_tokens — Send native tokens with safety limits (or craft unsigned TX)
  // @ts-ignore: MCP SDK deep type instantiation
  server.tool(
    "vector_send_tokens",
    "Send Vector native tokens from a wallet to a recipient address. Set unsigned_only=true to return unsigned CBOR without submitting.",
    {
      recipientAddress: z.string().describe("Recipient Vector address (addr1...)"),
      policyId: z.string().describe("Token policy ID"),
      assetName: z.string().describe("Asset name (can be empty for policy-only tokens)"),
      amount: z.string().describe("Amount of tokens to send"),
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the sending wallet"),
      adaAmount: z.number().optional().describe("Optional ADA to include (uses minimum required if not specified)"),
      unsigned_only: z.boolean().optional().default(false).describe("If true, return unsigned TX CBOR without signing or submitting"),
    },
    async ({ recipientAddress, policyId, assetName, amount, mnemonic, adaAmount, unsigned_only }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        if (unsigned_only) {
          const lucid = await initLucid(mnemonic);
          let assetNameHex = assetName;
          if (assetName && !/^[0-9a-fA-F]+$/.test(assetName)) {
            assetNameHex = fromText(assetName);
          }
          const unit = `${policyId}${assetNameHex}`;
          const outputLovelace = adaAmount
            ? BigInt(Math.floor(adaAmount * 1_000_000))
            : BigInt(2_000_000);
          // @ts-ignore
          const tx = await lucid.newTx()
            .payToAddress(recipientAddress, { lovelace: outputLovelace, [unit]: BigInt(amount) })
            .complete();
          // @ts-ignore
          const fee = tx.fee;
          // @ts-ignore
          const txCbor = tx.toString();
          return {
            content: [{
              type: "text",
              text: `# Unsigned Token Transaction (Transaction-Crafter Mode)

**Token:** ${formatAssetName(assetNameHex) || policyId.substring(0,8) + '...'}
**Amount:** ${amount}
**To:** ${recipientAddress}
**Included ADA:** ${lovelaceToAda(outputLovelace)} ADA
**Estimated Fee:** ${lovelaceToAda(fee)} ADA

**Unsigned TX CBOR:**
\`\`\`
${txCbor}
\`\`\`

This transaction has NOT been submitted. Sign and submit it separately.`,
            }],
          };
        }

        const result = await sendTokens(recipientAddress, policyId, assetName, amount, mnemonic, adaAmount);
        return {
          content: [{
            type: "text",
            text: `# Token Transaction Successful

Transaction Hash: ${result.txHash}
From: ${result.senderAddress}
To: ${result.recipientAddress}

Token Details:
- Policy ID: ${result.token.policyId}
- Asset Name: ${result.token.name || '(none)'}
- Amount: ${result.token.amount}

Included ADA: ${result.ada} ADA

[View on Explorer](${result.links.explorer})`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to send tokens: ${error.message}

**Troubleshooting Tips:**
1. Check that your wallet has sufficient ADA and token balance
2. Verify the policy ID and asset name are correct
3. Verify the recipient address is correct (addr1...)
4. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );

  // vector_get_spend_limits — Check safety layer status
  // @ts-ignore: MCP SDK deep type instantiation
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
          `- ${entry.timestamp}: ${lovelaceToAda(entry.amountLovelace)} ADA → ${entry.recipient.substring(0, 20)}... (${entry.txHash.substring(0, 16)}...)`
        ).join('\n');

        return {
          content: [{
            type: "text",
            text: `# Vector Spend Limits

Per-Transaction Limit: ${lovelaceToAda(status.perTransactionLimit)} ADA
Daily Limit: ${lovelaceToAda(status.dailyLimit)} ADA
Daily Spent: ${lovelaceToAda(status.dailySpent)} ADA
Daily Remaining: ${lovelaceToAda(status.dailyRemaining)} ADA
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

  // vector_build_transaction — Build a complex multi-output transaction
  // @ts-ignore: MCP SDK deep type instantiation
  server.tool(
    "vector_build_transaction",
    "Build a complex multi-output transaction with metadata. Set submit=true to sign and submit, or false to return unsigned CBOR for review.",
    {
      outputs: z.array(z.object({
        address: z.string().describe("Recipient Vector address"),
        lovelace: z.number().describe("Amount in lovelace (1 ADA = 1,000,000 lovelace)"),
        assets: z.record(z.string()).optional().describe("Optional native assets: { 'policyId+assetNameHex': 'quantity' }"),
      })).min(1).describe("Transaction outputs"),
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the signing wallet"),
      metadata: z.string().optional().describe("Optional JSON metadata (attached under label 674)"),
      submit: z.boolean().optional().describe("If true, sign and submit the transaction. If false/omitted, return unsigned CBOR for review."),
    },
    async ({ outputs, mnemonic, metadata, submit }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const result = await buildTransaction(outputs, mnemonic, metadata, submit);

        if (result.submitted) {
          return {
            content: [{
              type: "text",
              text: `# Transaction Submitted

Transaction Hash: ${result.txHash}
Fee: ${result.feeAda} ADA
Outputs: ${result.outputCount}
Total ADA Sent: ${result.totalAda} ADA

[View on Explorer](${result.links?.explorer})`,
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: `# Transaction Built (Not Submitted)

Transaction Hash: ${result.txHash}
Fee: ${result.feeAda} ADA
Outputs: ${result.outputCount}
Total ADA: ${result.totalAda} ADA

CBOR (hex): ${result.txCbor.substring(0, 200)}${result.txCbor.length > 200 ? '...' : ''}

Use vector_dry_run with this CBOR to simulate, or call vector_build_transaction again with submit=true to submit.`,
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
2. Ensure wallet has enough ADA for outputs + fees
3. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );

  // vector_dry_run — Simulate a transaction without submitting
  // @ts-ignore: MCP SDK deep type instantiation
  server.tool(
    "vector_dry_run",
    "Simulate a transaction without submitting — returns fee estimate and validation result",
    {
      txCbor: z.string().optional().describe("Hex-encoded CBOR of a built transaction to evaluate"),
      outputs: z.array(z.object({
        address: z.string().describe("Recipient Vector address"),
        lovelace: z.number().describe("Amount in lovelace"),
        assets: z.record(z.string()).optional(),
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

          // @ts-ignore
          let tx = lucid.newTx();
          for (const output of outputs) {
            const assets: Record<string, bigint> = { lovelace: BigInt(output.lovelace) };
            if (output.assets) {
              for (const [unit, qty] of Object.entries(output.assets)) {
                assets[unit] = BigInt(qty);
              }
            }
            tx = tx.payToAddress(output.address, assets);
          }

          if (metadata) {
            const parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
            // @ts-ignore
            tx = tx.attachMetadata(674, parsedMetadata);
          }

          // @ts-ignore
          const completedTx = await tx.complete();
          // @ts-ignore
          feeFromBuild = String(completedTx.fee);
          // @ts-ignore
          const signedTx = await completedTx.sign().complete();
          cborToEvaluate = signedTx.toString();
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
          // evaluateTransaction failed — still return fee if we built the tx
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
Estimated Fee: ${evalResult.feeAda} ADA (${evalResult.fee} lovelace)
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

  // vector_get_transaction_history — Get transaction history via Koios
  // @ts-ignore: MCP SDK deep type instantiation
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
          queryAddress = await lucid.wallet.address();
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
          return `${i + 1}. ${tx.txHash}\n   Block: ${tx.blockHeight} | Time: ${tx.blockTime} | Fee: ${feeAda} ADA`;
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

  // vector_deploy_contract — Deploy a Plutus/Aiken smart contract
  // @ts-ignore: MCP SDK deep type instantiation
  server.tool(
    "vector_deploy_contract",
    "Deploy a Plutus/Aiken smart contract to Vector by sending funds to its script address",
    {
      scriptCbor: z.string().describe("Compiled Plutus/Aiken script in CBOR hex format"),
      scriptType: z.enum(["PlutusV1", "PlutusV2", "PlutusV3"]).describe("Script version"),
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the deploying wallet"),
      initialDatum: z.string().optional().describe("Initial datum as CBOR hex. Use 'd87980' for void/unit datum. Defaults to void if omitted."),
      lovelaceAmount: z.number().optional().describe("ADA to lock at the script address in lovelace (default: 2,000,000 = 2 ADA)"),
    },
    async ({ scriptCbor, scriptType, mnemonic, initialDatum, lovelaceAmount }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const result = await deployContract(
          scriptCbor,
          scriptType,
          mnemonic,
          initialDatum || null,
          lovelaceAmount || 2_000_000,
        );

        return {
          content: [{
            type: "text",
            text: `# Smart Contract Deployed

Transaction Hash: ${result.txHash}
Script Address: ${result.scriptAddress}
Script Hash: ${result.scriptHash}
Script Type: ${result.scriptType}

Funds locked at the script address. Use vector_interact_contract to interact with this contract.

[View on Explorer](${result.links.explorer})`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to deploy contract: ${error.message}

**Troubleshooting Tips:**
1. Verify the script CBOR is valid hex (compiled Aiken or Plutus output)
2. Ensure wallet has sufficient ADA for the locked amount + fees
3. Check that the script type matches the compiled version (PlutusV1/V2/V3)
4. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );

  // vector_interact_contract — Interact with a deployed smart contract
  // @ts-ignore: MCP SDK deep type instantiation
  server.tool(
    "vector_interact_contract",
    "Interact with a deployed Plutus/Aiken smart contract — lock funds or spend from it",
    {
      scriptCbor: z.string().describe("Compiled Plutus/Aiken script in CBOR hex"),
      scriptType: z.enum(["PlutusV1", "PlutusV2", "PlutusV3"]).describe("Script version"),
      action: z.enum(["spend", "lock"]).describe("'spend' to collect UTxOs from the script, 'lock' to send funds to it"),
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the wallet"),
      redeemer: z.string().optional().describe("Redeemer as CBOR hex (required for spend, use 'd87980' for void)"),
      datum: z.string().optional().describe("Datum as CBOR hex (required for lock, use 'd87980' for void)"),
      lovelaceAmount: z.number().optional().describe("Lovelace to lock (for lock action, default: 2,000,000 = 2 ADA)"),
      utxoRef: z.object({
        txHash: z.string(),
        outputIndex: z.number(),
      }).optional().describe("Specific UTxO to spend from (optional, otherwise spends all UTxOs at script address)"),
      assets: z.record(z.string()).optional().describe("Additional native assets for lock action: { 'policyId+assetNameHex': 'quantity' }"),
    },
    async ({ scriptCbor, scriptType, action, mnemonic, redeemer, datum, lovelaceAmount, utxoRef, assets }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const result = await interactWithContract(
          scriptCbor,
          scriptType,
          action,
          mnemonic,
          redeemer || null,
          datum || null,
          lovelaceAmount || 2_000_000,
          utxoRef || null,
          assets || null,
        );

        const actionVerb = result.action === 'spend' ? 'collected from' : 'locked at';

        return {
          content: [{
            type: "text",
            text: `# Contract Interaction Successful

Transaction Hash: ${result.txHash}
Action: ${result.action}
Script Address: ${result.scriptAddress}

Funds ${actionVerb} the script address.

[View on Explorer](${result.links.explorer})`,
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{
            type: "text",
            text: `Failed to interact with contract: ${error.message}

**Troubleshooting Tips:**
1. For 'spend': ensure the script address has UTxOs and the redeemer satisfies the validator
2. For 'lock': ensure wallet has sufficient ADA and the datum matches the script's expectations
3. Spending requires collateral — ensure wallet has a pure-ADA UTxO (no native tokens)
4. Verify the script CBOR matches the deployed script exactly
5. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );

  // Agent network tools (register, discover, message, profile) live in agent-network.ts
  // to isolate C (Cardano WASM) imports from tsc's complex type inference
  registerAgentNetworkTools(server);
}
