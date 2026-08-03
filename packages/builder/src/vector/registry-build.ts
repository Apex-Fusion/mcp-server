// Keyless build core for the agent-registry family (spec PR 7).
// Constructs UNSIGNED transactions only. The user's key never enters this
// package: signing happens on the local signer (packages/signer), submission
// via vector_submit_transaction. The registry validator itself enforces
// ownership on-chain; the verifyOwnership() check here is a fail-fast courtesy.
import {
  fromText, toText, Data, Constr, validatorToAddress, getAddressDetails, credentialToAddress,
} from '@lucid-evolution/lucid';
import type { LucidEvolution, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import type { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { deriveNftAssetName, metadataStr } from '@apexfusion/vector-mcp-shared/tx';
import type {
  VectorBuildRegisterResult, VectorBuildAgentOpResult, VectorBuildMessageResult,
} from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';

// Registry constants - agent-registry v2 (audited, compliant)
// Source blueprint: vector-ai-agents/agent-registry/deploy/agent-registry/plutus.json
export const REGISTRY_SCRIPT_CBOR = '5909d101010029800aba2aba1aba0aab9faab9eaab9dab9a4888888966003300130033754011370e90004dc3a40052300730080019180398041804000c8c01cc020c020c020c02000644b30010018a40011337009001198010011804800a00c91803980418041804000c88c8c8cc004004010896600200300389919912cc004cdc8803801456600266e3c01c00a20030064025133005005300f00440246eb8c020004dd598048009805800a01214bd6f7b630488c8cc00400400c896600200314a115980098019805000c528c4cc008008c02c00500520109ba5480026e1d2004488888888888a60026026019301200c912cc004c034c040dd5000c4c8c8cc004004dd6180b180b980b980b980b980b980b980b980b98099baa0042259800800c528456600266e3cdd7180b800801c528c4cc008008c060005012202a375c602860226ea8006294100f48966002601a60206ea800a2646464646464653001375a6036003375c603600d375c603600b37586036009375c6036007375c60360049111112cc004c08801e2646644b3001301d002899192cc004c09c00a0071640906eb8c094004c084dd5001c566002603800513232598009813801400e2c8120dd7181280098109baa0038b203e407c603c6ea80044c8cc00400401489660020030118991980180198130011bae30240014088604201b16407c301b001301a00130190013018001301700130160013011375400516403d259800980618079baa0018a518a504039300600691119199119801001000912cc00400600713233225980099b910070028acc004cdc78038014400600c80b226600a00a603800880b0dd7180a8009bad3016001301800140586601000800629000488c8cc00400400c896600200314c103d87a80008992cc004c0100062600e6602c00297ae0899801801980c001202430160014050911111114c004c0680226034603601125980099b89371a6eb8c048c060dd5000a41000915980099b89371a6eb8c044c060dd5000a41002115980099b89371a6eb8c040c060dd5000a41000515980099b89371a6eb8c06cc070c070c070c070c070c060dd5000a41001115980099b8930043758601c60306ea80052040899198008009bac300f3019375400444b30010018a518acc004cdc49b8d375c603a00290400144cc008008c078006294101820368a50405914a080b229410164528202c8a50405929800800d220100a44100400c9111192cc004c0600062646644b3001301b0018992cc004c090006264b3001301d30203754003132323322598009814801c0222c8130dd698130009bae302600230260013021375400316407c6046003164084603e6ea80222b3001301a0018acc004c07cdd5004400a2c81022c80e901d0992cc004c068c074dd5003c4c8cc89660026602a6eb0c090c084dd5008919baf30253022375400200915980099912cc0040060051598009813800c4c96600266e3cdd71811800802c4c07cdd69812000c52820443026001801204840902940cc058dd5980c98109baa011005899912cc0040060051598009813800c4c966002602c60466ea8006264660260022b300130123028302537540031598009980a00a981418129baa00189806000c52820468a50408c604e60486ea80062c8110c070c08cdd51813000c009024204814a064660020026eb0c06cc088dd5009112cc004006297ae0899912cc0056600266ebcc0a0c094dd5001002c566002b3001301730243754603c604a6ea800a294629410234566002604130013756603e604a6ea800a013006404113371290406d620498059bab301f3025375400514a0811a29410234528204689981380119802002000c4cc01001000502318130009813800a0488a50407d14a080f8dca1bb300130020033021301e375400f1332259800800c00a2b30013024001899192cc004cdc39bad30220024800626464b300130203023375400313259800980b98121baa0018991980a00089980a80b181498131baa00130283025375400316408c603a60486ea8c078c090dd5181398121baa0018a5040886601a6eb0c098c08cdd500992cc004cdd7981398121baa301e302437540020051301f98009bab301e30243754603c60486ea8006011003403d14a08110c01401a2c8100dd718100009811800c009021204214a0660266eacc058c078dd5007001203823011330203374a9001198101ba90014bd7019810260103d87a80004bd70180e1baa006375c603e60386ea80122b30013017001899199119912cc004c0740062b3001302137540150028b20448acc004c0700062b3001302137540150028b20448b203e407c2b3001301b301e3754003198009811180f9baa00191192cc004c078c084dd5000c4c094c088dd5180e18111baa30253022375400316408066016004466ebcc094c088dd500080148c966002603860406ea800626eb8c090c084dd5000c5901f181198101baa00191192cc004c078c084dd5000c4dd5980e18111baa301c30223754604a60446ea80062c8100cc02c0088cdd7981298111baa00100291192cc004c098006264b3001301e375a60460031375c6044003164084604a00316408c6602c004002911112cc004c080c08cdd5006c4c8cc88cc896600266030032605860526ea802a2b3001302432330010013758605a60546ea8068896600200314800226644b30013375e6060605a6ea8c09cc0b4dd5001004c4cdc0000a4005100140ac605c00266004004605e0028162264b30013026302937540031323259800980f18159baa0018991980d8008acc004cdc39bad3005302d37540026eb4c014c0b4dd5007456600260346060605a6ea80062b30013014001899b89301300730133756604e605a6ea800e294102b452820568a5040ac605e60586ea80062c8150c090c0acdd5000981698151baa0018a5040a0660266eb0c088c0a4dd500c92cc004cdd7981698151baa00100689812cc004dd5981218151baa001802c00d015452820508a50409d14a08138cc0100040088c0acc0b0c0b0c0b0c0b0c0b0c0b0004c010004cc00cdd6181418129baa015008330043758604e60486ea805001e26464b30013301501630293026375400f15980099912cc0040060051598009816000c4c96600266e3cdd7181400080244cdc39bad30290014800629410271815800c009029205214a0660366eacc078c098dd500b00144c9660026046604c6ea8006264660386eb0c084c0a0dd500c12cc004cdd7981618149baa302c30293754002605860526ea800a266e252080dac409300f3756604660526ea80062941027180d19814980d19814981518139baa0014bd7019814a6103d87a80004bd704528204a30293026375400f14a08122294102419801198019bac30283025375402a0100026006660086eb0c09cc090dd500a003a04445901d180f1baa008302000130203021001301c375400916406880d0c068dd500188a4d13656400401';
export const REGISTRY_POLICY_ID = 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01';
export const MIN_AP3X_DEPOSIT = 10_000_000n;
export const AGENT_MESSAGE_LABEL = 674;

export function registryScript(): SpendingValidator {
  return { type: 'PlutusV3', script: REGISTRY_SCRIPT_CBOR };
}

let _registryAddress: string | null = null;
export function getRegistryAddress(): string {
  if (!_registryAddress) _registryAddress = validatorToAddress('Mainnet', registryScript());
  return _registryAddress;
}

export interface RegistryAgentProfile {
  agentId: string;
  name: string;
  description: string;
  capabilities: string[];
  framework: string;
  endpoint: string;
  registeredAt: number;
  utxoRef: string;
  ownerVkeyHash: string;
}

export function paymentKeyHashOf(address: string): string {
  let details;
  try {
    details = getAddressDetails(address);
  } catch (e) {
    throw new Error(`Invalid address: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (details.paymentCredential?.type !== 'Key' || !details.paymentCredential.hash) {
    throw new Error('Address must have a verification key payment credential, not a script credential.');
  }
  return details.paymentCredential.hash;
}

export function validateEndpoint(endpoint: string): void {
  if (!endpoint) return; // empty string is allowed
  try {
    new URL(endpoint);
  } catch {
    throw new Error(`Invalid endpoint URL: "${endpoint}". Must be a valid URL (e.g. https://example.com/api) or empty string.`);
  }
}

export function validateCapabilities(capabilities: string[]): void {
  for (const cap of capabilities) {
    if (typeof cap !== 'string' || cap.trim().length === 0) {
      throw new Error('Each capability must be a non-empty string.');
    }
  }
}

export function buildAgentDatum(
  vkeyHash: string, name: string, description: string, capabilities: string[],
  framework: string, endpoint: string, registeredAt?: number,
): string {
  return Data.to(new Constr(0, [
    new Constr(0, [vkeyHash]),
    fromText(name),
    fromText(description),
    capabilities.map((c) => fromText(c)),
    fromText(framework),
    fromText(endpoint),
    BigInt(registeredAt ?? Date.now()),
  ]));
}

export function parseAgentDatum(
  datumCbor: string, utxoRef: string, assets: Record<string, bigint>,
): RegistryAgentProfile | null {
  try {
    const c = Data.from(datumCbor);
    if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 7) return null;
    const ownerCred = c.fields[0];
    if (!(ownerCred instanceof Constr) || typeof ownerCred.fields[0] !== 'string') return null;
    const nftUnit = Object.keys(assets).find(
      (u) => u.startsWith(REGISTRY_POLICY_ID) && assets[u] === 1n,
    );
    const nftAssetName = nftUnit ? nftUnit.slice(REGISTRY_POLICY_ID.length) : '';
    return {
      agentId: `did:vector:agent:${REGISTRY_POLICY_ID}:${nftAssetName}`,
      name: toText(c.fields[1] as string),
      description: toText(c.fields[2] as string),
      capabilities: (c.fields[3] as string[]).map(toText),
      framework: toText(c.fields[4] as string),
      endpoint: toText(c.fields[5] as string),
      registeredAt: Number(c.fields[6] as bigint),
      utxoRef,
      ownerVkeyHash: ownerCred.fields[0],
    };
  } catch (err) {
    console.warn(`parseAgentDatum failed for ${utxoRef}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function parseDid(agentId: string): { policyId: string; assetName: string; unit: string } {
  const parts = agentId.split(':');
  if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'vector' || parts[2] !== 'agent') {
    throw new Error('Invalid agent DID format. Expected: did:vector:agent:{policyId}:{nftAssetName}');
  }
  if (!/^[a-f0-9]+$/.test(parts[3]) || !/^[a-f0-9]+$/.test(parts[4])) {
    throw new Error('Invalid agent DID: policyId and assetName must be hex strings.');
  }
  return { policyId: parts[3], assetName: parts[4], unit: `${parts[3]}${parts[4]}` };
}

export async function resolveAgentUtxo(
  provider: Pick<OgmiosProvider, 'getUtxos' | 'getUtxoByUnit'>, agentId: string,
): Promise<{ profile: RegistryAgentProfile; utxo: UTxO; nftUnit: string }> {
  const { unit } = parseDid(agentId);
  let utxo: UTxO | undefined;
  try {
    utxo = await provider.getUtxoByUnit(unit);
  } catch {
    // Koios unavailable, asset not found, or fixture provider - fall through to the address scan
  }
  if (!utxo || !utxo.datum) {
    const allUtxos = await provider.getUtxos(getRegistryAddress());
    const scanned = allUtxos.find((u) => u.assets[unit] && u.assets[unit] > 0n);
    if (scanned) utxo = scanned;
  }
  if (!utxo) throw new Error(`Agent not found: no UTxO holds NFT ${unit}. The agent may not exist or may have deregistered.`);
  if (!utxo.datum) throw new Error('Registry UTxO found but has no inline datum.');
  const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
  if (!profile) throw new Error('Could not parse agent datum. The on-chain data may be malformed.');
  return { profile, utxo, nftUnit: unit };
}

export function verifyOwnership(profile: RegistryAgentProfile, walletVkeyHash: string): void {
  if (profile.ownerVkeyHash !== walletVkeyHash) {
    throw new Error("Ownership check failed: the changeAddress wallet does not own this agent. The agent's owner verification key does not match that wallet's payment key. (The on-chain validator would also reject this.)");
  }
}

export async function buildRegisterAgent(lucid: LucidEvolution, p: {
  name: string; description: string;
  capabilities: string[]; framework: string; endpoint: string;
}): Promise<VectorBuildRegisterResult> {
  const changeAddress = await lucid.wallet().address();
  validateEndpoint(p.endpoint);
  validateCapabilities(p.capabilities);
  const vkeyHash = paymentKeyHashOf(changeAddress);
  const utxos = await lucid.wallet().getUtxos();
  // Same selection heuristic as the old custodial tool (behavior parity):
  // prefer a pure-lovelace UTxO covering deposit + fee headroom, else the first.
  const oneShotUtxo = utxos.find((u) => {
    const keys = Object.keys(u.assets);
    return keys.length === 1 && keys[0] === 'lovelace' && u.assets['lovelace'] >= MIN_AP3X_DEPOSIT + 2_000_000n;
  }) || utxos[0];
  if (!oneShotUtxo) throw new Error('No UTxOs at the changeAddress. Add AP3X to the wallet first.');
  const nftAssetName = deriveNftAssetName(oneShotUtxo.txHash, oneShotUtxo.outputIndex);
  const nftUnit = `${REGISTRY_POLICY_ID}${nftAssetName}`;
  const datum = buildAgentDatum(vkeyHash, p.name, p.description, p.capabilities, p.framework, p.endpoint);
  const registerRedeemer = Data.to(new Constr(0, [new Constr(0, [oneShotUtxo.txHash, BigInt(oneShotUtxo.outputIndex)])]));
  const completed = await lucid.newTx()
    .collectFrom([oneShotUtxo])
    .mintAssets({ [nftUnit]: 1n }, registerRedeemer)
    .attach.MintingPolicy(registryScript())
    .pay.ToAddressWithData(getRegistryAddress(), { kind: 'inline', value: datum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
    .addSigner(changeAddress)
    .complete();
  return {
    ...toBuildResult(completed),
    agentId: `did:vector:agent:${REGISTRY_POLICY_ID}:${nftAssetName}`,
    nftAssetName,
    registryAddress: getRegistryAddress(),
    depositLovelace: MIN_AP3X_DEPOSIT.toString(),
  };
}

export async function buildUpdateAgent(
  lucid: LucidEvolution,
  provider: Pick<OgmiosProvider, 'getUtxos' | 'getUtxoByUnit'>,
  p: {
    agentId: string; name?: string; description?: string;
    capabilities?: string[]; framework?: string; endpoint?: string;
  },
): Promise<VectorBuildAgentOpResult> {
  const changeAddress = await lucid.wallet().address();
  if (p.name === undefined && p.description === undefined && p.capabilities === undefined
    && p.framework === undefined && p.endpoint === undefined) {
    throw new Error('At least one field must be provided to update (name, description, capabilities, framework, or endpoint).');
  }
  if (p.endpoint !== undefined) validateEndpoint(p.endpoint);
  if (p.capabilities !== undefined) validateCapabilities(p.capabilities);
  const vkeyHash = paymentKeyHashOf(changeAddress);
  const { profile, utxo } = await resolveAgentUtxo(provider, p.agentId);
  verifyOwnership(profile, vkeyHash);
  // Owner is written from profile.ownerVkeyHash, not the caller's vkeyHash:
  // makes owner-immutability on this path structural (the datum literally
  // cannot carry a different owner out of buildUpdateAgent) rather than
  // depending solely on the verifyOwnership() call two lines up.
  const newDatum = buildAgentDatum(
    profile.ownerVkeyHash,
    p.name ?? profile.name,
    p.description ?? profile.description,
    p.capabilities ?? profile.capabilities,
    p.framework ?? profile.framework,
    p.endpoint ?? profile.endpoint,
    profile.registeredAt,
  );
  const spendRedeemer = Data.to(new Constr(0, [])); // Update
  // The continuing output must carry the spent input's value EXACTLY
  // (utxo.assets - lovelace AND the NFT), not a hardcoded
  // { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n } - the deployed validator
  // enforces value preservation on Update (differential-tested; see
  // task-3-report.md's correction section). Hardcoding the floor here was
  // the same latent defect the old custodial code had.
  const completed = await lucid.newTx()
    .collectFrom([utxo], spendRedeemer)
    .attach.SpendingValidator(registryScript())
    .pay.ToAddressWithData(getRegistryAddress(), { kind: 'inline', value: newDatum }, utxo.assets)
    .addSigner(changeAddress)
    .complete();
  const updatedFields: string[] = [];
  if (p.name !== undefined) updatedFields.push('name');
  if (p.description !== undefined) updatedFields.push('description');
  if (p.capabilities !== undefined) updatedFields.push('capabilities');
  if (p.framework !== undefined) updatedFields.push('framework');
  if (p.endpoint !== undefined) updatedFields.push('endpoint');
  return {
    ...toBuildResult(completed),
    agentId: p.agentId, op: 'update', agentName: profile.name, detail: updatedFields.join(', '),
  };
}

export async function buildTransferAgent(
  lucid: LucidEvolution,
  provider: Pick<OgmiosProvider, 'getUtxos' | 'getUtxoByUnit'>,
  p: { agentId: string; newOwnerAddress: string },
): Promise<VectorBuildAgentOpResult> {
  const changeAddress = await lucid.wallet().address();
  const vkeyHash = paymentKeyHashOf(changeAddress);
  let newOwnerHash: string;
  try {
    newOwnerHash = paymentKeyHashOf(p.newOwnerAddress);
  } catch (e) {
    throw new Error(`Invalid new owner address: ${e instanceof Error ? e.message : String(e)} The on-chain contract rejects script credentials as owners.`);
  }
  const { profile, utxo } = await resolveAgentUtxo(provider, p.agentId);
  verifyOwnership(profile, vkeyHash);
  const newDatum = buildAgentDatum(
    newOwnerHash, profile.name, profile.description,
    profile.capabilities, profile.framework, profile.endpoint, profile.registeredAt,
  );
  const spendRedeemer = Data.to(new Constr(0, [])); // Update (transfer uses the Update redeemer)
  // Value-preserving output, same reasoning as buildUpdateAgent above: the
  // deployed validator requires the continuing output to carry the spent
  // input's value exactly, not a hardcoded deposit-floor amount.
  const completed = await lucid.newTx()
    .collectFrom([utxo], spendRedeemer)
    .attach.SpendingValidator(registryScript())
    .pay.ToAddressWithData(getRegistryAddress(), { kind: 'inline', value: newDatum }, utxo.assets)
    .addSigner(changeAddress)
    .complete();
  return {
    ...toBuildResult(completed),
    agentId: p.agentId, op: 'transfer', agentName: profile.name, detail: p.newOwnerAddress,
  };
}

export async function buildDeregisterAgent(
  lucid: LucidEvolution,
  provider: Pick<OgmiosProvider, 'getUtxos' | 'getUtxoByUnit'>,
  p: { agentId: string },
): Promise<VectorBuildAgentOpResult> {
  const changeAddress = await lucid.wallet().address();
  const vkeyHash = paymentKeyHashOf(changeAddress);
  const { profile, utxo, nftUnit } = await resolveAgentUtxo(provider, p.agentId);
  verifyOwnership(profile, vkeyHash);
  const spendRedeemer = Data.to(new Constr(1, [])); // Deregister
  const mintRedeemer = Data.to(new Constr(1, []));  // Burn
  // CORRECTED root cause (see task-3-report.md's correction section for the
  // full account - this replaces an earlier, wrong "Lucid library bug"
  // diagnosis). The DEPLOYED registry validator (REGISTRY_SCRIPT_CBOR /
  // REGISTRY_POLICY_ID above) does NOT match the in-workspace Aiken source
  // under agent-infrastructure/contracts/agent-registry/ - that source
  // compiles to policy 5dd51189..., a different script entirely (confirmed
  // by hashing both; provenance worth resolving before the self-improvement
  // family trusts that source as ground truth). Differential-tested
  // directly against the deployed bytecode instead: deregister enforces a
  // floor on the owner's returned change - a sole-input deregister of a
  // registry UTxO holding exactly MIN_AP3X_DEPOSIT fails, the identical
  // build against a 25 AP3X registry UTxO succeeds unaided. Feeding in a
  // second, plain pure-AP3X wallet UTxO - the LARGEST one available, so the
  // returned change clears the floor with margin rather than by a hair -
  // satisfies it for the common exactly-the-floor case.
  const walletUtxos = await lucid.wallet().getUtxos();
  const feeUtxo = walletUtxos
    .filter((u) => {
      const keys = Object.keys(u.assets);
      return keys.length === 1 && keys[0] === 'lovelace';
    })
    .sort((a, b) => Number(b.assets.lovelace - a.assets.lovelace))[0];
  if (!feeUtxo) {
    throw new Error("Deregistration needs a plain AP3X-only UTxO in the wallet to clear the validator's returned-change floor; send yourself a small AP3X-only transfer first.");
  }
  const completed = await lucid.newTx()
    .collectFrom([utxo], spendRedeemer)
    .attach.SpendingValidator(registryScript())
    .collectFrom([feeUtxo])
    .mintAssets({ [nftUnit]: -1n }, mintRedeemer)
    .attach.MintingPolicy(registryScript())
    .addSigner(changeAddress)
    .complete();
  return {
    ...toBuildResult(completed),
    agentId: p.agentId, op: 'deregister', agentName: profile.name, detail: String(utxo.assets.lovelace),
  };
}

export async function buildMessageAgent(
  lucid: LucidEvolution,
  provider: Pick<OgmiosProvider, 'getUtxos' | 'getUtxoByUnit'>,
  p: { agentId: string; messageType: string; payload: string },
): Promise<VectorBuildMessageResult> {
  const changeAddress = await lucid.wallet().address();
  paymentKeyHashOf(changeAddress); // validate before any resolution work
  const { profile } = await resolveAgentUtxo(provider, p.agentId);
  if (!profile.ownerVkeyHash) throw new Error('Could not parse agent owner from registry datum');
  const recipientAddress = credentialToAddress('Mainnet', { type: 'Key', hash: profile.ownerVkeyHash });
  const completed = await lucid.newTx()
    .pay.ToAddress(recipientAddress, { lovelace: 2_000_000n })
    .attachMetadata(AGENT_MESSAGE_LABEL, {
      msg: ['a2a'],
      from: metadataStr(changeAddress),
      to: metadataStr(p.agentId),
      type: p.messageType,
      payload: metadataStr(p.payload),
    })
    .complete();
  return {
    ...toBuildResult(completed),
    agentId: p.agentId,
    agentName: profile.name,
    recipientAddress,
  };
}
