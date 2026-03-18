// @ts-nocheck
// Agent network tools: register, discover, message, get_profile
// ts-nocheck isolates C (Cardano WASM) imports from tsc's complex type inference

import { z } from "zod";
import { Lucid, fromText, toText, Data, Constr, C } from 'lucid-cardano';
import { OgmiosProvider } from './ogmios-provider.js';
import { safetyLayer } from './safety.js';
import { rateLimiter } from './rate-limiter.js';

// Env config (mirrors vector.ts)
const VECTOR_OGMIOS_URL = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const VECTOR_SUBMIT_URL = process.env.VECTOR_SUBMIT_URL || 'https://submit.vector.testnet.apexfusion.org/api/submit/tx';
const VECTOR_KOIOS_URL = process.env.VECTOR_KOIOS_URL || 'https://koios.vector.testnet.apexfusion.org/';
const VECTOR_EXPLORER_URL = process.env.VECTOR_EXPLORER_URL || 'https://vector.testnet.apexscan.org';
const VECTOR_MNEMONIC = process.env.VECTOR_MNEMONIC || '';
const VECTOR_ACCOUNT_INDEX = parseInt(process.env.VECTOR_ACCOUNT_INDEX || '0');

// Registry constants
const REGISTRY_SCRIPT_CBOR = "59058101010029800aba2aba1aba0aab9faab9eaab9dab9a48888889660033001300337540112232330010010032259800800c52845660026006601400314a3133002002300b001401480424600e60106010003223232330010010042259800800c00e2646644b30013372200e00515980099b8f0070028800c01900944cc014014c03c0110091bae3008001375660120026016002804852f5bded8c1230073008300830083008001918039804000cdc3a4005370e90002444444453001300f0089807004496600266e1d2004300b3754600e60186ea80062946294100a4888c8cc88cc008008004896600200300389919912cc004cdc8803801456600266e3c01c00a20030064049133005005301800440486eb8c044004dd69809000980a000a02433009004003148001222232980098079baa00194c004006910100a44100400d301300548896600260120071323322598009806000c4c9660026036003132598009807180b9baa0018991919912cc004c08000e0111640746eb4c074004dd7180e801180e800980c1baa0018b202c301a0018b2030301637540091598009806800c566002602c6ea801200516405d16405080a0566002601460266ea800a2646644b30013301337586034602e6ea802c8cdd7980d980c1baa0010048acc004cc89660020030028acc004c074006264b30013371e6eb8c064004016260226eb4c0680062941018180e000c00901a203414a0660226eacc040c05cdd500580244cc04cdd61809180b9baa00b25980099baf301b301837540020051598009805800c566002601f30013756602060306ea800600b003402913371290406d620498039bab30103018375400314a080b229410164528202c8a50405514a080a8dca1bb30013374a90001980b99ba548008cc05cdd480125eb80cc05d300103d87a80004bd70180b980a1baa002899912cc004006005159800980d000c4cdc39bad301630190014800600480b90170a503300e3756601a60286ea802000501218099baa002375c602c60266ea80122b3001300a003899199119912cc004c0380062b30013018375400d0028b20328acc004c03c0062b30013018375400d0028b20328b202c40582b3001300c3015375400319800980c980b1baa001912cc004c038c05cdd5000c4c8c8cc004004dd6180e980f180f180f180f180f180f180f180f180d1baa0042259800800c528456600266e3cdd7180f000801c528c4cc008008c07c0050192038375c603660306ea80062941016488c8cc00400400c896600200314c0103d87a80008992cc004c010006266e9520003301d0014bd7044cc00c00cc07c009019180e800a0369192cc004c03cc05cdd5000c4dd7180d980c1baa0018b202c301a301737540029111192cc004c044c068dd5004c4c8c8c9660026600e0246042603c6ea80222660346eb0c064c078dd500912cc004cdd79811180f9baa0010048acc004c0480062b3001301698009bab3017301f37540030038012022899b89482036b1024c038dd5980b980f9baa0018a50407514a080ea294101d4528203832598009811000c4c966002602c6eb4c07c00626eb8c0780062c80e8c0840062c80f8cc05cc9660026028603a6ea800626eacc058c078dd5180b180f1baa3021301e37540031640706600a6eb0c080c074dd5008919baf3021301e37540020140026006002660026eb0c078c06cdd5007803c5660026600801e603c60366ea801626644b30010018014566002604200313370e6eb4c074c0800052001801203c40782940cc054dd5980a180d9baa00f3002330013758603c60366ea803c01e294101920322232598009809980e1baa00189810180e9baa3015301d37546040603a6ea80062c80d8cc0100088cdd79810180e9baa001002459014180a9baa00430170013017301800130133754009164044808860246026008452689b2b200201";
const REGISTRY_POLICY_ID = "5dd5118943d5aa7329696181252a6565a27dbf2c6de92b02a6aae361";
const MIN_AP3X_DEPOSIT = 10_000_000n;
const AGENT_MESSAGE_LABEL = 674;

// Helpers
function lovelaceToAda(lovelace) {
  return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
}
function explorerTxLink(txHash) {
  return `${VECTOR_EXPLORER_URL}/transaction/${txHash}`;
}

// Derive NFT asset name = blake2b_256(CBOR(OutputReference))
// Matches Aiken's derive_asset_name (verified via CBOR parity tests in agent-registry repo)
function deriveNftAssetName(txHash, outputIndex) {
  const outRefCbor = Data.to(new Constr(0, [txHash, BigInt(outputIndex)]));
  const hashBytes = C.hash_blake2b256(Buffer.from(outRefCbor, 'hex'));
  return Buffer.from(hashBytes).toString('hex');
}

function buildAgentDatum(vkeyHash, name, description, capabilities, framework, endpoint) {
  return Data.to(new Constr(0, [
    new Constr(0, [vkeyHash]),
    fromText(name),
    fromText(description),
    capabilities.map(c => fromText(c)),
    fromText(framework),
    fromText(endpoint),
    BigInt(Date.now()),
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
  } catch {
    return null;
  }
}

async function initLucid() {
  const provider = new OgmiosProvider({
    ogmiosUrl: VECTOR_OGMIOS_URL,
    submitUrl: VECTOR_SUBMIT_URL,
    koiosUrl: VECTOR_KOIOS_URL,
  });
  const lucid = await Lucid.new(provider, 'Mainnet');
  if (!VECTOR_MNEMONIC) throw new Error('VECTOR_MNEMONIC is required');
  const trimmed = VECTOR_MNEMONIC.trim();
  const words = trimmed.split(/\s+/);
  if (words.length !== 15 && words.length !== 24) {
    throw new Error(`Invalid mnemonic: Expected 15 or 24 words, got ${words.length}`);
  }
  lucid.selectWalletFromSeed(trimmed, { accountIndex: VECTOR_ACCOUNT_INDEX });
  return lucid;
}

export function registerAgentNetworkTools(server) {

  // vector_get_agent_profile
  server.tool(
    "vector_get_agent_profile",
    "Get a registered agent's profile from the on-chain registry by DID (did:vector:agent:...)",
    {
      agent_id: z.string().describe("Agent DID: did:vector:agent:{policyId}:{nftAssetName}"),
    },
    async ({ agent_id }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const parts = agent_id.split(':');
        if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'vector' || parts[2] !== 'agent') {
          throw new Error('Invalid agent DID format. Expected: did:vector:agent:{policyId}:{nftAssetName}');
        }
        const unit = `${parts[3]}${parts[4]}`;
        const provider = new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
        const utxo = await provider.getUtxoByUnit(unit);
        if (!utxo) throw new Error(`Agent not found: no UTxO holds NFT ${unit}. The agent may not exist or may have deregistered.`);
        if (!utxo.datum) throw new Error(`Registry UTxO found but has no inline datum.`);
        const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
        if (!profile) throw new Error(`Could not parse agent datum.`);
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

  // vector_discover_agents
  server.tool(
    "vector_discover_agents",
    "Discover registered agents in the Vector on-chain registry, optionally filtered by capability or framework",
    {
      capability: z.string().optional().describe("Filter by capability tag (e.g. 'investing', 'research')"),
      framework: z.string().optional().describe("Filter by framework (e.g. 'OpenClaw', 'LangChain', 'CrewAI')"),
      limit: z.number().optional().default(20).describe("Maximum number of agents to return (default: 20)"),
    },
    async ({ capability, framework, limit }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const lucid = await initLucid();
        const registryScript = { type: "PlutusV3", script: REGISTRY_SCRIPT_CBOR };
        const registryAddress = lucid.utils.validatorToAddress(registryScript);
        const provider = new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
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
    "Register this agent in the Vector on-chain agent registry. Mints a soulbound identity NFT and locks a 10 AP3X deposit.",
    {
      name: z.string().min(1).max(64).describe("Agent name (e.g. 'TradingBot', 'ResearchAgent')"),
      description: z.string().max(256).describe("Short description of the agent's purpose"),
      capabilities: z.array(z.string()).describe("List of capability tags (e.g. ['investing', 'research', 'environmental'])"),
      framework: z.string().describe("Framework used (e.g. 'OpenClaw', 'LangChain', 'CrewAI', 'custom')"),
      endpoint: z.string().describe("A2A communication endpoint URL (or empty string if not applicable)"),
    },
    async ({ name, description, capabilities, framework, endpoint }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const safetyCheck = safetyLayer.checkTransaction(Number(MIN_AP3X_DEPOSIT));
        if (!safetyCheck.allowed) throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);

        const lucid = await initLucid();
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
        const registryAddress = lucid.utils.validatorToAddress(registryScript);
        const registerRedeemer = Data.to(new Constr(0, [new Constr(0, [seedUtxo.txHash, BigInt(seedUtxo.outputIndex)])]));

        const tx = await lucid.newTx()
          .collectFrom([seedUtxo])
          .mintAssets({ [nftUnit]: 1n }, registerRedeemer)
          .attachMintingPolicy(registryScript)
          .payToContract(registryAddress, { inline: datum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
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

  // vector_message_agent
  server.tool(
    "vector_message_agent",
    "Send an on-chain message to a registered Vector agent via TX metadata (label 674). Delivers 2 ADA to the agent's owner address.",
    {
      agent_id: z.string().describe("Recipient agent DID: did:vector:agent:{policyId}:{nftAssetName}"),
      message_type: z.enum(["inquiry", "proposal", "result"]).describe("Type of message"),
      payload: z.string().max(512).describe("Message payload (string, max 512 chars)"),
    },
    async ({ agent_id, message_type, payload }) => {
      const rateCheck = rateLimiter.check();
      if (!rateCheck.allowed) {
        return { content: [{ type: "text", text: `Rate limit exceeded. Retry after ${rateCheck.retryAfterMs}ms.` }] };
      }
      try {
        const parts = agent_id.split(':');
        if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'vector' || parts[2] !== 'agent') {
          throw new Error('Invalid agent DID format. Expected: did:vector:agent:{policyId}:{nftAssetName}');
        }
        const unit = `${parts[3]}${parts[4]}`;
        const provider = new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL });
        const utxo = await provider.getUtxoByUnit(unit);
        if (!utxo || !utxo.datum) throw new Error(`Agent not found: ${agent_id}. The agent may not be registered or may have deregistered.`);
        const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
        if (!profile?.ownerVkeyHash) throw new Error('Could not parse agent owner from registry datum');

        const lucid = await initLucid();
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
