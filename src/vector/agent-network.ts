// @ts-nocheck
// Agent network tools: register, discover, message, get_profile, update, deregister, transfer
// ts-nocheck isolates C (Cardano WASM) imports from tsc's complex type inference

import { z } from "zod";
import { Lucid, fromText, toText, Data, Constr, C } from 'lucid-cardano';
import { OgmiosProvider } from './ogmios-provider.js';
import { safetyLayer } from './safety.js';
import { rateLimiter } from './rate-limiter.js';

// Lucid v0.10.x lacks PlutusV3 — downcast to PlutusV2 for hashing (same algorithm)
function lucidCompat(validator) {
  return validator.type === 'PlutusV3' ? { ...validator, type: 'PlutusV2' } : validator;
}

// Env config (mirrors vector.ts)
const VECTOR_OGMIOS_URL = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const VECTOR_SUBMIT_URL = process.env.VECTOR_SUBMIT_URL || 'https://submit.vector.testnet.apexfusion.org/api/submit/tx';
const VECTOR_KOIOS_URL = process.env.VECTOR_KOIOS_URL || 'https://koios.vector.testnet.apexfusion.org/';
const VECTOR_EXPLORER_URL = process.env.VECTOR_EXPLORER_URL || 'https://vector.testnet.apexscan.org';

// Registry constants
const REGISTRY_SCRIPT_CBOR = "59058101010029800aba2aba1aba0aab9faab9eaab9dab9a48888889660033001300337540112232330010010032259800800c52845660026006601400314a3133002002300b001401480424600e60106010003223232330010010042259800800c00e2646644b30013372200e00515980099b8f0070028800c01900944cc014014c03c0110091bae3008001375660120026016002804852f5bded8c1230073008300830083008001918039804000cdc3a4005370e90002444444453001300f0089807004496600266e1d2004300b3754600e60186ea80062946294100a4888c8cc88cc008008004896600200300389919912cc004cdc8803801456600266e3c01c00a20030064049133005005301800440486eb8c044004dd69809000980a000a02433009004003148001222232980098079baa00194c004006910100a44100400d301300548896600260120071323322598009806000c4c9660026036003132598009807180b9baa0018991919912cc004c08000e0111640746eb4c074004dd7180e801180e800980c1baa0018b202c301a0018b2030301637540091598009806800c566002602c6ea801200516405d16405080a0566002601460266ea800a2646644b30013301337586034602e6ea802c8cdd7980d980c1baa0010048acc004cc89660020030028acc004c074006264b30013371e6eb8c064004016260226eb4c0680062941018180e000c00901a203414a0660226eacc040c05cdd500580244cc04cdd61809180b9baa00b25980099baf301b301837540020051598009805800c566002601f30013756602060306ea800600b003402913371290406d620498039bab30103018375400314a080b229410164528202c8a50405514a080a8dca1bb30013374a90001980b99ba548008cc05cdd480125eb80cc05d300103d87a80004bd70180b980a1baa002899912cc004006005159800980d000c4cdc39bad301630190014800600480b90170a503300e3756601a60286ea802000501218099baa002375c602c60266ea80122b3001300a003899199119912cc004c0380062b30013018375400d0028b20328acc004c03c0062b30013018375400d0028b20328b202c40582b3001300c3015375400319800980c980b1baa001912cc004c038c05cdd5000c4c8c8cc004004dd6180e980f180f180f180f180f180f180f180f180d1baa0042259800800c528456600266e3cdd7180f000801c528c4cc008008c07c0050192038375c603660306ea80062941016488c8cc00400400c896600200314c0103d87a80008992cc004c010006266e9520003301d0014bd7044cc00c00cc07c009019180e800a0369192cc004c03cc05cdd5000c4dd7180d980c1baa0018b202c301a301737540029111192cc004c044c068dd5004c4c8c8c9660026600e0246042603c6ea80222660346eb0c064c078dd500912cc004cdd79811180f9baa0010048acc004c0480062b3001301698009bab3017301f37540030038012022899b89482036b1024c038dd5980b980f9baa0018a50407514a080ea294101d4528203832598009811000c4c966002602c6eb4c07c00626eb8c0780062c80e8c0840062c80f8cc05cc9660026028603a6ea800626eacc058c078dd5180b180f1baa3021301e37540031640706600a6eb0c080c074dd5008919baf3021301e37540020140026006002660026eb0c078c06cdd5007803c5660026600801e603c60366ea801626644b30010018014566002604200313370e6eb4c074c0800052001801203c40782940cc054dd5980a180d9baa00f3002330013758603c60366ea803c01e294101920322232598009809980e1baa00189810180e9baa3015301d37546040603a6ea80062c80d8cc0100088cdd79810180e9baa001002459014180a9baa00430170013017301800130133754009164044808860246026008452689b2b200201";
const REGISTRY_POLICY_ID = "5dd5118943d5aa7329696181252a6565a27dbf2c6de92b02a6aae361";
const MIN_AP3X_DEPOSIT = 10_000_000n;
const AGENT_MESSAGE_LABEL = 674;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lovelaceToAda(lovelace) {
  return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
}

function explorerTxLink(txHash) {
  return `${VECTOR_EXPLORER_URL}/transaction/${txHash}`;
}

function newProvider() {
  return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
}

// Derive NFT asset name = blake2b_256(CBOR(OutputReference))
// Matches Aiken's derive_asset_name (verified via CBOR parity tests in agent-registry repo)
function deriveNftAssetName(txHash, outputIndex) {
  const outRefCbor = Data.to(new Constr(0, [txHash, BigInt(outputIndex)]));
  const hashBytes = C.hash_blake2b256(Buffer.from(outRefCbor, 'hex'));
  return Buffer.from(hashBytes).toString('hex');
}

function buildAgentDatum(vkeyHash, name, description, capabilities, framework, endpoint, registeredAt) {
  return Data.to(new Constr(0, [
    new Constr(0, [vkeyHash]),
    fromText(name),
    fromText(description),
    capabilities.map(c => fromText(c)),
    fromText(framework),
    fromText(endpoint),
    BigInt(registeredAt ?? Date.now()),
  ]));
}

function parseAgentDatum(datumCbor, utxoRef, assets) {
  try {
    const c = Data.from(datumCbor);
    if (Number(c.index) !== 0) return null;
    const ownerCred = c.fields[0];
    const vkeyHash = ownerCred.fields[0];
    const nftUnit = Object.keys(assets).find(
      u => u.startsWith(REGISTRY_POLICY_ID) && assets[u] === 1n
    );
    const nftAssetName = nftUnit ? nftUnit.slice(REGISTRY_POLICY_ID.length) : '';
    return {
      agentId: `did:vector:agent:${REGISTRY_POLICY_ID}:${nftAssetName}`,
      name: toText(c.fields[1]),
      description: toText(c.fields[2]),
      capabilities: c.fields[3].map(toText),
      framework: toText(c.fields[4]),
      endpoint: toText(c.fields[5]),
      registeredAt: Number(c.fields[6]),
      utxoRef,
      ownerVkeyHash: vkeyHash,
    };
  } catch (err) {
    console.warn(`parseAgentDatum failed for ${utxoRef}:`, err?.message || err);
    return null;
  }
}

// ─── DID & Agent Resolution ──────────────────────────────────────────────────

function parseDid(agentId) {
  const parts = agentId.split(':');
  if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'vector' || parts[2] !== 'agent') {
    throw new Error('Invalid agent DID format. Expected: did:vector:agent:{policyId}:{nftAssetName}');
  }
  if (!/^[a-f0-9]+$/.test(parts[3]) || !/^[a-f0-9]+$/.test(parts[4])) {
    throw new Error('Invalid agent DID: policyId and assetName must be hex strings.');
  }
  return { policyId: parts[3], assetName: parts[4], unit: `${parts[3]}${parts[4]}` };
}

async function resolveAgentUtxo(provider, agentId) {
  const { unit } = parseDid(agentId);
  const utxo = await provider.getUtxoByUnit(unit);
  if (!utxo) throw new Error(`Agent not found: no UTxO holds NFT ${unit}. The agent may not exist or may have deregistered.`);
  if (!utxo.datum) throw new Error('Registry UTxO found but has no inline datum.');
  const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
  if (!profile) throw new Error('Could not parse agent datum. The on-chain data may be malformed.');
  return { profile, utxo, nftUnit: unit };
}

function verifyOwnership(profile, walletVkeyHash) {
  if (profile.ownerVkeyHash !== walletVkeyHash) {
    throw new Error('Ownership check failed: your wallet does not own this agent. The agent\'s owner verification key does not match your wallet\'s payment key.');
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateEndpoint(endpoint) {
  if (!endpoint) return; // empty string is allowed
  try {
    new URL(endpoint);
  } catch {
    throw new Error(`Invalid endpoint URL: "${endpoint}". Must be a valid URL (e.g. https://example.com/api) or empty string.`);
  }
}

function validateCapabilities(capabilities) {
  for (const cap of capabilities) {
    if (typeof cap !== 'string' || cap.trim().length === 0) {
      throw new Error('Each capability must be a non-empty string.');
    }
  }
}

// ─── Lucid Init ──────────────────────────────────────────────────────────────

async function initLucid(mnemonic, accountIndex = 0) {
  const provider = newProvider();
  const lucid = await Lucid.new(provider, 'Mainnet');
  if (!mnemonic) throw new Error('mnemonic is required');
  const trimmed = mnemonic.trim();
  const words = trimmed.split(/\s+/);
  const validLengths = [12, 15, 18, 21, 24];
  if (!validLengths.includes(words.length)) {
    throw new Error(`Invalid mnemonic: Expected 12, 15, 18, 21 or 24 words, got ${words.length}`);
  }
  lucid.selectWalletFromSeed(trimmed, { accountIndex });

  // Store the full wallet address so credential-based UTxO lookups resolve correctly
  const address = await lucid.wallet.address();
  provider.setWalletAddress(address);

  return lucid;
}

// Cached registry address (derived from script hash, doesn't need a wallet)
let _registryAddress = null;
async function getRegistryAddress() {
  if (_registryAddress) return _registryAddress;
  const provider = newProvider();
  const lucid = await Lucid.new(provider, 'Mainnet');
  const registryScript = { type: 'PlutusV3', script: REGISTRY_SCRIPT_CBOR };
  _registryAddress = lucid.utils.validatorToAddress(lucidCompat(registryScript));
  return _registryAddress;
}

// ─── Rate limit wrapper ──────────────────────────────────────────────────────

function checkRateLimit() {
  const rateCheck = rateLimiter.check();
  if (!rateCheck.allowed) {
    return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
  }
  return null;
}

// ─── Tool Registration ───────────────────────────────────────────────────────

export function registerAgentNetworkTools(server) {

  // vector_get_agent_profile (read-only — no mnemonic needed)
  server.tool(
    "vector_get_agent_profile",
    "Get a registered agent's profile from the on-chain registry by DID (did:vector:agent:...)",
    {
      agent_id: z.string().describe("Agent DID: did:vector:agent:{policyId}:{nftAssetName}"),
    },
    async ({ agent_id }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const { profile } = await resolveAgentUtxo(provider, agent_id);
        const capList = profile.capabilities.length > 0
          ? profile.capabilities.map(c => `- ${c}`).join('\n')
          : '- (none listed)';
        return {
          content: [{
            type: "text",
            text: `# Agent Profile

**DID:** ${profile.agentId}
**Name:** ${profile.name}
**Description:** ${profile.description}

**Capabilities:**
${capList}

**Framework:** ${profile.framework || '(not specified)'}
**Endpoint:** ${profile.endpoint || '(not specified)'}
**Registered:** ${new Date(profile.registeredAt).toISOString()}
**Registry UTxO:** ${profile.utxoRef}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to get agent profile: ${err.message}

**Troubleshooting Tips:**
1. Verify the DID format: did:vector:agent:{policyId}:{nftAssetName}
2. The agent may not be registered or may have deregistered
3. Check that Koios is reachable at ${VECTOR_KOIOS_URL}`,
          }],
        };
      }
    }
  );

  // vector_discover_agents (read-only — no mnemonic needed)
  server.tool(
    "vector_discover_agents",
    "Discover registered agents in the Vector on-chain registry, optionally filtered by capability or framework",
    {
      capability: z.string().optional().describe("Filter by capability tag (e.g. 'investing', 'research')"),
      framework: z.string().optional().describe("Filter by framework (e.g. 'OpenClaw', 'LangChain', 'CrewAI')"),
      limit: z.number().optional().default(20).describe("Maximum number of agents to return (default: 20)"),
    },
    async ({ capability, framework, limit }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const registryAddress = await getRegistryAddress();
        const provider = newProvider();
        const utxos = await provider.getUtxos(registryAddress);
        const profiles = [];
        for (const utxo of utxos) {
          if (!utxo.datum) continue;
          const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
          if (!profile) continue;
          if (capability && !profile.capabilities.some(c => c.toLowerCase().includes(capability.toLowerCase()))) continue;
          if (framework && profile.framework.toLowerCase() !== framework.toLowerCase()) continue;
          profiles.push(profile);
          if (profiles.length >= (limit ?? 20)) break;
        }
        if (profiles.length === 0) {
          const filterDesc = [capability ? `capability="${capability}"` : '', framework ? `framework="${framework}"` : ''].filter(Boolean).join(', ');
          return { content: [{ type: "text", text: `No agents found${filterDesc ? ` matching ${filterDesc}` : ''} in the registry.\n\nTotal UTxOs at registry: ${utxos.length}` }] };
        }
        const agentList = profiles.map((p, i) =>
          `### ${i + 1}. ${p.name}\n**DID:** ${p.agentId}\n**Description:** ${p.description}\n**Capabilities:** ${p.capabilities.join(', ') || '(none)'}\n**Framework:** ${p.framework || '(not specified)'}\n**Endpoint:** ${p.endpoint || '(not specified)'}\n**Registered:** ${new Date(p.registeredAt).toISOString()}`
        ).join('\n\n');
        return {
          content: [{
            type: "text",
            text: `# Agent Discovery Results\n\nFound **${profiles.length}** agent${profiles.length !== 1 ? 's' : ''}${capability ? ` with capability "${capability}"` : ''}${framework ? ` using framework "${framework}"` : ''}:\n\n${agentList}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to discover agents: ${err.message}

**Troubleshooting Tips:**
1. Check that Ogmios is reachable at ${VECTOR_OGMIOS_URL}
2. The registry may be empty — no agents have registered yet
3. Try without filters to list all agents`,
          }],
        };
      }
    }
  );

  // vector_register_agent
  server.tool(
    "vector_register_agent",
    "Register an agent in the Vector on-chain agent registry. Mints a soulbound identity NFT and locks a 10 AP3X deposit.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the registering wallet"),
      name: z.string().min(1).max(64).describe("Agent name (e.g. 'TradingBot', 'ResearchAgent')"),
      description: z.string().max(256).describe("Short description of the agent's purpose"),
      capabilities: z.array(z.string()).describe("List of capability tags (e.g. ['investing', 'research', 'environmental'])"),
      framework: z.string().describe("Framework used (e.g. 'OpenClaw', 'LangChain', 'CrewAI', 'custom')"),
      endpoint: z.string().describe("A2A communication endpoint URL (or empty string if not applicable)"),
    },
    async ({ mnemonic, name, description, capabilities, framework, endpoint }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        validateEndpoint(endpoint);
        validateCapabilities(capabilities);

        const safetyCheck = safetyLayer.checkTransaction(Number(MIN_AP3X_DEPOSIT));
        if (!safetyCheck.allowed) throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);

        const lucid = await initLucid(mnemonic);
        const walletAddress = await lucid.wallet.address();
        const addressDetails = lucid.utils.getAddressDetails(walletAddress);
        const vkeyHash = addressDetails.paymentCredential?.hash;
        if (!vkeyHash) throw new Error('Cannot derive payment key hash from wallet address');

        const utxos = await lucid.wallet.getUtxos();
        const seedUtxo = utxos.find(u => {
          const keys = Object.keys(u.assets);
          return keys.length === 1 && keys[0] === 'lovelace' && u.assets['lovelace'] >= MIN_AP3X_DEPOSIT + 2_000_000n;
        }) || utxos[0];
        if (!seedUtxo) throw new Error('No UTxOs in wallet. Please fund the wallet first.');

        const nftAssetName = deriveNftAssetName(seedUtxo.txHash, seedUtxo.outputIndex);
        const nftUnit = `${REGISTRY_POLICY_ID}${nftAssetName}`;
        const datum = buildAgentDatum(vkeyHash, name, description, capabilities, framework, endpoint);
        const registryScript = { type: "PlutusV3", script: REGISTRY_SCRIPT_CBOR };
        const registryAddress = lucid.utils.validatorToAddress(lucidCompat(registryScript));
        const registerRedeemer = Data.to(new Constr(0, [new Constr(0, [seedUtxo.txHash, BigInt(seedUtxo.outputIndex)])]));

        const tx = await lucid.newTx()
          .collectFrom([seedUtxo])
          .mintAssets({ [nftUnit]: 1n }, registerRedeemer)
          .attachMintingPolicy(lucidCompat(registryScript))
          .payToContract(registryAddress, { inline: datum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign().complete();
        const txHash = await signedTx.submit();
        safetyLayer.recordTransaction(txHash, Number(MIN_AP3X_DEPOSIT), registryAddress);

        const agentId = `did:vector:agent:${REGISTRY_POLICY_ID}:${nftAssetName}`;
        return {
          content: [{
            type: "text",
            text: `# Agent Registered Successfully

**Agent DID:** ${agentId}
**Name:** ${name}
**NFT Asset Name:** ${nftAssetName}
**Registry Address:** ${registryAddress}
**Transaction:** ${txHash}
**Deposit:** ${lovelaceToAda(MIN_AP3X_DEPOSIT)} AP3X (returned on deregistration)

[View on Explorer](${explorerTxLink(txHash)})

Save your Agent DID — you'll need it to update, deregister, or let other agents discover you.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to register agent: ${err.message}

**Troubleshooting Tips:**
1. Ensure wallet has at least 12 AP3X (10 deposit + fees)
2. Check spend limits with vector_get_spend_limits
3. Each wallet can register multiple agents (different seed UTxOs)
4. Verify Ogmios endpoint is reachable at ${VECTOR_OGMIOS_URL}`,
          }],
        };
      }
    }
  );

  // vector_update_agent
  server.tool(
    "vector_update_agent",
    "Update a registered agent's profile fields (name, description, capabilities, framework, endpoint). Only the specified fields are changed; others are preserved.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the agent's owner wallet"),
      agent_id: z.string().describe("Agent DID to update: did:vector:agent:{policyId}:{nftAssetName}"),
      name: z.string().min(1).max(64).optional().describe("New agent name"),
      description: z.string().max(256).optional().describe("New description"),
      capabilities: z.array(z.string()).optional().describe("New capability tags (replaces existing list)"),
      framework: z.string().optional().describe("New framework identifier"),
      endpoint: z.string().optional().describe("New A2A endpoint URL (or empty string to clear)"),
    },
    async ({ mnemonic, agent_id, name, description, capabilities, framework, endpoint }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        if (name === undefined && description === undefined && capabilities === undefined && framework === undefined && endpoint === undefined) {
          throw new Error('At least one field must be provided to update (name, description, capabilities, framework, or endpoint).');
        }
        if (endpoint !== undefined) validateEndpoint(endpoint);
        if (capabilities !== undefined) validateCapabilities(capabilities);

        const lucid = await initLucid(mnemonic);
        const walletAddress = await lucid.wallet.address();
        const vkeyHash = lucid.utils.getAddressDetails(walletAddress).paymentCredential?.hash;
        if (!vkeyHash) throw new Error('Cannot derive payment key hash from wallet address');

        const provider = newProvider();
        const { profile, utxo, nftUnit } = await resolveAgentUtxo(provider, agent_id);
        verifyOwnership(profile, vkeyHash);

        // Merge: use new values where provided, keep old values otherwise
        const newName = name ?? profile.name;
        const newDesc = description ?? profile.description;
        const newCaps = capabilities ?? profile.capabilities;
        const newFramework = framework ?? profile.framework;
        const newEndpoint = endpoint ?? profile.endpoint;

        const newDatum = buildAgentDatum(vkeyHash, newName, newDesc, newCaps, newFramework, newEndpoint, profile.registeredAt);
        const registryScript = { type: 'PlutusV3', script: REGISTRY_SCRIPT_CBOR };
        const registryAddress = lucid.utils.validatorToAddress(lucidCompat(registryScript));
        const spendRedeemer = Data.to(new Constr(0, [])); // Update

        const tx = await lucid.newTx()
          .collectFrom([utxo], spendRedeemer)
          .attachSpendingValidator(lucidCompat(registryScript))
          .payToContract(registryAddress, { inline: newDatum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign().complete();
        const txHash = await signedTx.submit();
        safetyLayer.recordTransaction(txHash, 0, registryAddress);

        const updatedFields = [];
        if (name !== undefined) updatedFields.push('name');
        if (description !== undefined) updatedFields.push('description');
        if (capabilities !== undefined) updatedFields.push('capabilities');
        if (framework !== undefined) updatedFields.push('framework');
        if (endpoint !== undefined) updatedFields.push('endpoint');

        return {
          content: [{
            type: "text",
            text: `# Agent Updated Successfully

**Agent DID:** ${agent_id}
**Updated fields:** ${updatedFields.join(', ')}
**Transaction:** ${txHash}

[View on Explorer](${explorerTxLink(txHash)})

The agent's profile has been updated on-chain. The identity NFT and deposit are unchanged.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to update agent: ${err.message}

**Troubleshooting Tips:**
1. Verify the agent DID is correct
2. Your wallet must be the agent's current owner
3. Ensure wallet has enough ADA for transaction fees
4. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );

  // vector_deregister_agent
  server.tool(
    "vector_deregister_agent",
    "Deregister an agent from the Vector registry. Burns the identity NFT and returns the 10 AP3X deposit to your wallet.",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the agent's owner wallet"),
      agent_id: z.string().describe("Agent DID to deregister: did:vector:agent:{policyId}:{nftAssetName}"),
    },
    async ({ mnemonic, agent_id }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const lucid = await initLucid(mnemonic);
        const walletAddress = await lucid.wallet.address();
        const vkeyHash = lucid.utils.getAddressDetails(walletAddress).paymentCredential?.hash;
        if (!vkeyHash) throw new Error('Cannot derive payment key hash from wallet address');

        const provider = newProvider();
        const { profile, utxo, nftUnit } = await resolveAgentUtxo(provider, agent_id);
        verifyOwnership(profile, vkeyHash);

        const registryScript = { type: 'PlutusV3', script: REGISTRY_SCRIPT_CBOR };
        const spendRedeemer = Data.to(new Constr(1, [])); // Deregister
        const mintRedeemer = Data.to(new Constr(1, []));  // Burn

        const tx = await lucid.newTx()
          .collectFrom([utxo], spendRedeemer)
          .attachSpendingValidator(lucidCompat(registryScript))
          .mintAssets({ [nftUnit]: -1n }, mintRedeemer)
          .attachMintingPolicy(lucidCompat(registryScript))
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign().complete();
        const txHash = await signedTx.submit();
        safetyLayer.recordTransaction(txHash, 0, walletAddress);

        return {
          content: [{
            type: "text",
            text: `# Agent Deregistered Successfully

**Agent DID:** ${agent_id}
**Name:** ${profile.name}
**Deposit returned:** ${lovelaceToAda(MIN_AP3X_DEPOSIT)} AP3X
**Transaction:** ${txHash}

[View on Explorer](${explorerTxLink(txHash)})

The agent's identity NFT has been burned and the 10 AP3X deposit has been returned to your wallet.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to deregister agent: ${err.message}

**Troubleshooting Tips:**
1. Verify the agent DID is correct
2. Your wallet must be the agent's current owner
3. Ensure wallet has enough ADA for transaction fees
4. Use vector_get_agent_profile to check the agent's current state`,
          }],
        };
      }
    }
  );

  // vector_transfer_agent
  server.tool(
    "vector_transfer_agent",
    "Transfer agent ownership to a new address. The new owner must have a verification key credential (not a script address).",
    {
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the current owner's wallet"),
      agent_id: z.string().describe("Agent DID to transfer: did:vector:agent:{policyId}:{nftAssetName}"),
      new_owner_address: z.string().describe("Bech32 address of the new owner (must be a verification key address, not a script address)"),
    },
    async ({ mnemonic, agent_id, new_owner_address }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const lucid = await initLucid(mnemonic);
        const walletAddress = await lucid.wallet.address();
        const vkeyHash = lucid.utils.getAddressDetails(walletAddress).paymentCredential?.hash;
        if (!vkeyHash) throw new Error('Cannot derive payment key hash from wallet address');

        // Validate new owner address
        let newOwnerDetails;
        try {
          newOwnerDetails = lucid.utils.getAddressDetails(new_owner_address);
        } catch {
          throw new Error(`Invalid new owner address: "${new_owner_address}". Must be a valid bech32 address.`);
        }
        if (newOwnerDetails.paymentCredential?.type !== 'Key') {
          throw new Error('New owner address must be a verification key credential, not a script address. The on-chain contract rejects script credentials as owners.');
        }
        const newOwnerVkeyHash = newOwnerDetails.paymentCredential.hash;

        const provider = newProvider();
        const { profile, utxo, nftUnit } = await resolveAgentUtxo(provider, agent_id);
        verifyOwnership(profile, vkeyHash);

        // Build datum with new owner, everything else preserved
        const newDatum = buildAgentDatum(
          newOwnerVkeyHash, profile.name, profile.description,
          profile.capabilities, profile.framework, profile.endpoint,
          profile.registeredAt
        );
        const registryScript = { type: 'PlutusV3', script: REGISTRY_SCRIPT_CBOR };
        const registryAddress = lucid.utils.validatorToAddress(lucidCompat(registryScript));
        const spendRedeemer = Data.to(new Constr(0, [])); // Update (transfer uses Update redeemer)

        const tx = await lucid.newTx()
          .collectFrom([utxo], spendRedeemer)
          .attachSpendingValidator(lucidCompat(registryScript))
          .payToContract(registryAddress, { inline: newDatum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign().complete();
        const txHash = await signedTx.submit();
        safetyLayer.recordTransaction(txHash, 0, registryAddress);

        return {
          content: [{
            type: "text",
            text: `# Agent Transferred Successfully

**Agent DID:** ${agent_id}
**Name:** ${profile.name}
**Previous owner:** ${walletAddress}
**New owner:** ${new_owner_address}
**Transaction:** ${txHash}

[View on Explorer](${explorerTxLink(txHash)})

Ownership has been transferred. The new owner can now update, transfer, or deregister this agent.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to transfer agent: ${err.message}

**Troubleshooting Tips:**
1. Verify the agent DID is correct
2. Your wallet must be the agent's current owner
3. The new owner address must be a verification key address (not a script)
4. Ensure wallet has enough ADA for transaction fees`,
          }],
        };
      }
    }
  );

  // vector_message_agent
  server.tool(
    "vector_message_agent",
    "Send an on-chain message to a registered Vector agent via TX metadata (label 674). Delivers 2 ADA to the agent's owner address.",
    {
      agent_id: z.string().describe("Recipient agent DID: did:vector:agent:{policyId}:{nftAssetName}"),
      message_type: z.enum(["inquiry", "proposal", "result"]).describe("Type of message"),
      payload: z.string().max(512).describe("Message payload (string, max 512 chars)"),
      mnemonic: z.string().describe("15 or 24-word BIP39 mnemonic for the sending wallet"),
    },
    async ({ agent_id, message_type, payload, mnemonic }) => {
      const rateLimited = checkRateLimit();
      if (rateLimited) return rateLimited;
      try {
        const provider = newProvider();
        const { profile } = await resolveAgentUtxo(provider, agent_id);
        if (!profile.ownerVkeyHash) throw new Error('Could not parse agent owner from registry datum');

        const lucid = await initLucid(mnemonic);
        const senderAddress = await lucid.wallet.address();
        const recipientAddress = lucid.utils.credentialToAddress({ type: 'Key', hash: profile.ownerVkeyHash });
        const minAda = 2_000_000n;
        const safetyCheck = safetyLayer.checkTransaction(Number(minAda));
        if (!safetyCheck.allowed) throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);

        const tx = await lucid.newTx()
          .payToAddress(recipientAddress, { lovelace: minAda })
          .attachMetadata(AGENT_MESSAGE_LABEL, { msg: ['a2a'], from: senderAddress, to: agent_id, type: message_type, payload })
          .complete();
        const signedTx = await tx.sign().complete();
        const txHash = await signedTx.submit();
        safetyLayer.recordTransaction(txHash, Number(minAda), recipientAddress);

        return {
          content: [{
            type: "text",
            text: `# Message Sent

**To:** ${profile.name} (${agent_id})
**Type:** ${message_type}
**Payload:** ${payload}
**Recipient Address:** ${recipientAddress}
**Transaction:** ${txHash}

[View on Explorer](${explorerTxLink(txHash)})

The message is recorded on-chain in TX metadata label 674.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to send message: ${err.message}

**Troubleshooting Tips:**
1. Verify the agent DID is correct: did:vector:agent:{policyId}:{nftAssetName}
2. Ensure wallet has at least 3 ADA (2 ADA delivery + fees)
3. Use vector_get_agent_profile to verify the agent exists first
4. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );
}
