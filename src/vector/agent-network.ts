// @ts-nocheck
// Agent network tools: register, discover, message, get_profile, update, deregister, transfer

import { z } from "zod/v4";
import { Lucid, fromText, toText, Data, Constr, validatorToAddress, validatorToScriptHash, getAddressDetails, credentialToAddress } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { OgmiosProvider } from './ogmios-provider.js';
import { safetyLayer } from './safety.js';
import { rateLimiter } from './rate-limiter.js';

// Env config (mirrors vector.ts)
const VECTOR_OGMIOS_URL = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const VECTOR_SUBMIT_URL = process.env.VECTOR_SUBMIT_URL || 'https://submit.vector.testnet.apexfusion.org/api/submit/tx';
const VECTOR_KOIOS_URL = process.env.VECTOR_KOIOS_URL || 'https://v2.koios.vector.testnet.apexfusion.org/';
const VECTOR_EXPLORER_URL = process.env.VECTOR_EXPLORER_URL || 'https://vector.testnet.apexscan.org';

// Registry constants - agent-registry v2 (audited, compliant)
// Source blueprint: vector-ai-agents/agent-registry/deploy/agent-registry/plutus.json
const REGISTRY_SCRIPT_CBOR = "5909d101010029800aba2aba1aba0aab9faab9eaab9dab9a4888888966003300130033754011370e90004dc3a40052300730080019180398041804000c8c01cc020c020c020c02000644b30010018a40011337009001198010011804800a00c91803980418041804000c88c8c8cc004004010896600200300389919912cc004cdc8803801456600266e3c01c00a20030064025133005005300f00440246eb8c020004dd598048009805800a01214bd6f7b630488c8cc00400400c896600200314a115980098019805000c528c4cc008008c02c00500520109ba5480026e1d2004488888888888a60026026019301200c912cc004c034c040dd5000c4c8c8cc004004dd6180b180b980b980b980b980b980b980b980b98099baa0042259800800c528456600266e3cdd7180b800801c528c4cc008008c060005012202a375c602860226ea8006294100f48966002601a60206ea800a2646464646464653001375a6036003375c603600d375c603600b37586036009375c6036007375c60360049111112cc004c08801e2646644b3001301d002899192cc004c09c00a0071640906eb8c094004c084dd5001c566002603800513232598009813801400e2c8120dd7181280098109baa0038b203e407c603c6ea80044c8cc00400401489660020030118991980180198130011bae30240014088604201b16407c301b001301a00130190013018001301700130160013011375400516403d259800980618079baa0018a518a504039300600691119199119801001000912cc00400600713233225980099b910070028acc004cdc78038014400600c80b226600a00a603800880b0dd7180a8009bad3016001301800140586601000800629000488c8cc00400400c896600200314c103d87a80008992cc004c0100062600e6602c00297ae0899801801980c001202430160014050911111114c004c0680226034603601125980099b89371a6eb8c048c060dd5000a41000915980099b89371a6eb8c044c060dd5000a41002115980099b89371a6eb8c040c060dd5000a41000515980099b89371a6eb8c06cc070c070c070c070c070c060dd5000a41001115980099b8930043758601c60306ea80052040899198008009bac300f3019375400444b30010018a518acc004cdc49b8d375c603a00290400144cc008008c078006294101820368a50405914a080b229410164528202c8a50405929800800d220100a44100400c9111192cc004c0600062646644b3001301b0018992cc004c090006264b3001301d30203754003132323322598009814801c0222c8130dd698130009bae302600230260013021375400316407c6046003164084603e6ea80222b3001301a0018acc004c07cdd5004400a2c81022c80e901d0992cc004c068c074dd5003c4c8cc89660026602a6eb0c090c084dd5008919baf30253022375400200915980099912cc0040060051598009813800c4c96600266e3cdd71811800802c4c07cdd69812000c52820443026001801204840902940cc058dd5980c98109baa011005899912cc0040060051598009813800c4c966002602c60466ea8006264660260022b300130123028302537540031598009980a00a981418129baa00189806000c52820468a50408c604e60486ea80062c8110c070c08cdd51813000c009024204814a064660020026eb0c06cc088dd5009112cc004006297ae0899912cc0056600266ebcc0a0c094dd5001002c566002b3001301730243754603c604a6ea800a294629410234566002604130013756603e604a6ea800a013006404113371290406d620498059bab301f3025375400514a0811a29410234528204689981380119802002000c4cc01001000502318130009813800a0488a50407d14a080f8dca1bb300130020033021301e375400f1332259800800c00a2b30013024001899192cc004cdc39bad30220024800626464b300130203023375400313259800980b98121baa0018991980a00089980a80b181498131baa00130283025375400316408c603a60486ea8c078c090dd5181398121baa0018a5040886601a6eb0c098c08cdd500992cc004cdd7981398121baa301e302437540020051301f98009bab301e30243754603c60486ea8006011003403d14a08110c01401a2c8100dd718100009811800c009021204214a0660266eacc058c078dd5007001203823011330203374a9001198101ba90014bd7019810260103d87a80004bd70180e1baa006375c603e60386ea80122b30013017001899199119912cc004c0740062b3001302137540150028b20448acc004c0700062b3001302137540150028b20448b203e407c2b3001301b301e3754003198009811180f9baa00191192cc004c078c084dd5000c4c094c088dd5180e18111baa30253022375400316408066016004466ebcc094c088dd500080148c966002603860406ea800626eb8c090c084dd5000c5901f181198101baa00191192cc004c078c084dd5000c4dd5980e18111baa301c30223754604a60446ea80062c8100cc02c0088cdd7981298111baa00100291192cc004c098006264b3001301e375a60460031375c6044003164084604a00316408c6602c004002911112cc004c080c08cdd5006c4c8cc88cc896600266030032605860526ea802a2b3001302432330010013758605a60546ea8068896600200314800226644b30013375e6060605a6ea8c09cc0b4dd5001004c4cdc0000a4005100140ac605c00266004004605e0028162264b30013026302937540031323259800980f18159baa0018991980d8008acc004cdc39bad3005302d37540026eb4c014c0b4dd5007456600260346060605a6ea80062b30013014001899b89301300730133756604e605a6ea800e294102b452820568a5040ac605e60586ea80062c8150c090c0acdd5000981698151baa0018a5040a0660266eb0c088c0a4dd500c92cc004cdd7981698151baa00100689812cc004dd5981218151baa001802c00d015452820508a50409d14a08138cc0100040088c0acc0b0c0b0c0b0c0b0c0b0c0b0004c010004cc00cdd6181418129baa015008330043758604e60486ea805001e26464b30013301501630293026375400f15980099912cc0040060051598009816000c4c96600266e3cdd7181400080244cdc39bad30290014800629410271815800c009029205214a0660366eacc078c098dd500b00144c9660026046604c6ea8006264660386eb0c084c0a0dd500c12cc004cdd7981618149baa302c30293754002605860526ea800a266e252080dac409300f3756604660526ea80062941027180d19814980d19814981518139baa0014bd7019814a6103d87a80004bd704528204a30293026375400f14a08122294102419801198019bac30283025375402a0100026006660086eb0c09cc090dd500a003a04445901d180f1baa008302000130203021001301c375400916406880d0c068dd500188a4d13656400401";
const REGISTRY_POLICY_ID = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";
const MIN_AP3X_DEPOSIT = 10_000_000n;
const AGENT_MESSAGE_LABEL = 674;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Cardano metadata strings must be ≤ 64 bytes. Chunk long strings into arrays.
function metadataStr(s: string): string | string[] {
  if (s.length <= 64) return s;
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += 64) {
    chunks.push(s.slice(i, i + 64));
  }
  return chunks;
}

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
// v2 (Conway) requires INDEFINITE-length CBOR for the constructor field array
// (`D8 79 9F … FF`), matching Aiken's `cbor.serialise`. Lucid's Data.to emits
// definite-length arrays (`D8 79 82 …`) which v2 rejects, so we hand-roll the
// outer constructor and let Lucid encode the inner fields.
function cborUint(n: bigint): Buffer {
  if (n < 0n) throw new Error('output_index must be non-negative');
  if (n < 24n) return Buffer.from([Number(n)]);
  if (n < 0x100n) return Buffer.from([0x18, Number(n)]);
  if (n < 0x10000n) return Buffer.from([0x19, Number(n >> 8n) & 0xff, Number(n) & 0xff]);
  if (n < 0x100000000n) {
    const b = Buffer.alloc(5); b[0] = 0x1a; b.writeUInt32BE(Number(n), 1); return b;
  }
  const b = Buffer.alloc(9); b[0] = 0x1b; b.writeBigUInt64BE(n, 1); return b;
}

function cborBytes(hex: string): Buffer {
  const raw = Buffer.from(hex, 'hex');
  const len = raw.length;
  let header: Buffer;
  if (len < 24) header = Buffer.from([0x40 | len]);
  else if (len < 0x100) header = Buffer.from([0x58, len]);
  else if (len < 0x10000) { header = Buffer.alloc(3); header[0] = 0x59; header.writeUInt16BE(len, 1); }
  else { header = Buffer.alloc(5); header[0] = 0x5a; header.writeUInt32BE(len, 1); }
  return Buffer.concat([header, raw]);
}

export function deriveNftAssetName(txHash: string, outputIndex: number): string {
  // Constr 0 with indefinite-length inner array:
  //   D8 79         (tag 121 = constr 0)
  //   9F            (indefinite array begin)
  //   <bytes(tx_hash)> <uint(output_index)>
  //   FF            (break)
  const outRefCbor = Buffer.concat([
    Buffer.from([0xd8, 0x79, 0x9f]),
    cborBytes(txHash),
    cborUint(BigInt(outputIndex)),
    Buffer.from([0xff]),
  ]);
  const hashBytes = blake2b(outRefCbor, { dkLen: 32 });
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

  let utxo;
  try {
    utxo = await provider.getUtxoByUnit(unit);
  } catch {
    // Koios unavailable or asset not found - will try Ogmios fallback below
  }

  // If Koios returned a UTxO without datum, or didn't find one, scan via Ogmios
  if (!utxo || !utxo.datum) {
    const registryAddress = await getRegistryAddress();
    const allUtxos = await provider.getUtxos(registryAddress);
    const ogmiosUtxo = allUtxos.find(u => u.assets[unit] && u.assets[unit] > 0n);
    if (ogmiosUtxo) {
      utxo = ogmiosUtxo;
    }
  }

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
  const lucid = await Lucid(provider, 'Mainnet');
  if (!mnemonic) throw new Error('mnemonic is required');
  const trimmed = mnemonic.trim();
  const words = trimmed.split(/\s+/);
  const validLengths = [12, 15, 18, 21, 24];
  if (!validLengths.includes(words.length)) {
    throw new Error(`Invalid mnemonic: Expected 12, 15, 18, 21 or 24 words, got ${words.length}`);
  }
  lucid.selectWallet.fromSeed(trimmed, { accountIndex });

  return lucid;
}

// Cached registry address (derived from script hash, doesn't need a wallet)
let _registryAddress = null;
async function getRegistryAddress() {
  if (_registryAddress) return _registryAddress;
  const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
  _registryAddress = validatorToAddress('Mainnet', registryScript);
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

  // vector_get_agent_profile (read-only - no mnemonic needed)
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

  // vector_discover_agents (read-only - no mnemonic needed)
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
2. The registry may be empty - no agents have registered yet
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
        const walletAddress = await lucid.wallet().address();
        const addressDetails = getAddressDetails(walletAddress);
        const vkeyHash = addressDetails.paymentCredential?.hash;
        if (!vkeyHash) throw new Error('Cannot derive payment key hash from wallet address');

        const utxos = await lucid.utxosAt(await lucid.wallet().address());
        const seedUtxo = utxos.find(u => {
          const keys = Object.keys(u.assets);
          return keys.length === 1 && keys[0] === 'lovelace' && u.assets['lovelace'] >= MIN_AP3X_DEPOSIT + 2_000_000n;
        }) || utxos[0];
        if (!seedUtxo) throw new Error('No UTxOs in wallet. Please fund the wallet first.');

        const nftAssetName = deriveNftAssetName(seedUtxo.txHash, seedUtxo.outputIndex);
        const nftUnit = `${REGISTRY_POLICY_ID}${nftAssetName}`;
        const datum = buildAgentDatum(vkeyHash, name, description, capabilities, framework, endpoint);
        const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
        const registryAddress = validatorToAddress('Mainnet', registryScript);
        const registerRedeemer = Data.to(new Constr(0, [new Constr(0, [seedUtxo.txHash, BigInt(seedUtxo.outputIndex)])]));

        const tx = await lucid.newTx()
          .collectFrom([seedUtxo])
          .mintAssets({ [nftUnit]: 1n }, registerRedeemer)
          .attach.MintingPolicy(registryScript)
          .pay.ToAddressWithData(registryAddress, { kind: "inline", value: datum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign.withWallet().complete();
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

Save your Agent DID - you'll need it to update, deregister, or let other agents discover you.`,
          }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
        return {
          content: [{
            type: "text",
            text: `Failed to register agent: ${errMsg}

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
        const walletAddress = await lucid.wallet().address();
        const vkeyHash = getAddressDetails(walletAddress).paymentCredential?.hash;
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
        const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
        const registryAddress = validatorToAddress('Mainnet', registryScript);
        const spendRedeemer = Data.to(new Constr(0, [])); // Update

        const tx = await lucid.newTx()
          .collectFrom([utxo], spendRedeemer)
          .attach.SpendingValidator(registryScript)
          .pay.ToAddressWithData(registryAddress, { kind: "inline", value: newDatum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign.withWallet().complete();
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
3. Ensure wallet has enough AP3X for transaction fees
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
        const walletAddress = await lucid.wallet().address();
        const vkeyHash = getAddressDetails(walletAddress).paymentCredential?.hash;
        if (!vkeyHash) throw new Error('Cannot derive payment key hash from wallet address');

        const provider = newProvider();
        const { profile, utxo, nftUnit } = await resolveAgentUtxo(provider, agent_id);
        verifyOwnership(profile, vkeyHash);

        const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
        const spendRedeemer = Data.to(new Constr(1, [])); // Deregister
        const mintRedeemer = Data.to(new Constr(1, []));  // Burn

        const tx = await lucid.newTx()
          .collectFrom([utxo], spendRedeemer)
          .attach.SpendingValidator(registryScript)
          .mintAssets({ [nftUnit]: -1n }, mintRedeemer)
          .attach.MintingPolicy(registryScript)
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign.withWallet().complete();
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
3. Ensure wallet has enough AP3X for transaction fees
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
        const walletAddress = await lucid.wallet().address();
        const vkeyHash = getAddressDetails(walletAddress).paymentCredential?.hash;
        if (!vkeyHash) throw new Error('Cannot derive payment key hash from wallet address');

        // Validate new owner address
        let newOwnerDetails;
        try {
          newOwnerDetails = getAddressDetails(new_owner_address);
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
        const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
        const registryAddress = validatorToAddress('Mainnet', registryScript);
        const spendRedeemer = Data.to(new Constr(0, [])); // Update (transfer uses Update redeemer)

        const tx = await lucid.newTx()
          .collectFrom([utxo], spendRedeemer)
          .attach.SpendingValidator(registryScript)
          .pay.ToAddressWithData(registryAddress, { kind: "inline", value: newDatum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
          .addSigner(walletAddress)
          .complete();
        const signedTx = await tx.sign.withWallet().complete();
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
4. Ensure wallet has enough AP3X for transaction fees`,
          }],
        };
      }
    }
  );

  // vector_message_agent
  server.tool(
    "vector_message_agent",
    "Send an on-chain message to a registered Vector agent via TX metadata (label 674). Delivers 2 AP3X to the agent's owner address.",
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
        const senderAddress = await lucid.wallet().address();
        const recipientAddress = credentialToAddress('Mainnet', { type: 'Key', hash: profile.ownerVkeyHash });
        const minAda = 2_000_000n;
        const safetyCheck = safetyLayer.checkTransaction(Number(minAda));
        if (!safetyCheck.allowed) throw new Error(`Safety limit exceeded: ${safetyCheck.reason}`);

        const tx = await lucid.newTx()
          .pay.ToAddress(recipientAddress, { lovelace: minAda })
          .attachMetadata(AGENT_MESSAGE_LABEL, { msg: ['a2a'], from: metadataStr(senderAddress), to: metadataStr(agent_id), type: message_type, payload: metadataStr(payload) })
          .complete();
        const signedTx = await tx.sign.withWallet().complete();
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
2. Ensure wallet has at least 3 AP3X (2 AP3X delivery + fees)
3. Use vector_get_agent_profile to verify the agent exists first
4. Check spend limits with vector_get_spend_limits`,
          }],
        };
      }
    }
  );
}
