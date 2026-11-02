// Keyless build core for the legacy agent-registry family (spec PR 7).
// Constructs UNSIGNED transactions only. The user's key never enters this
// package: signing happens on the local signer (packages/signer), submission
// via vector_submit_transaction. The registry validator itself enforces
// ownership on-chain; the verifyOwnership() check here is a fail-fast courtesy.
// The legacy registry's script, policy, address and deposit live in
// legacy-registry.ts.
import { fromText, toText, Data, Constr, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import type { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { deriveNftAssetName } from '@apexfusion/vector-mcp-shared/tx';
import type { VectorBuildRegisterResult, VectorBuildAgentOpResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import {
  LEGACY_REGISTRY_POLICY_ID, LEGACY_REGISTRY_DEPOSIT, legacyRegistryScript, legacyRegistryAddress, legacyDid,
} from './legacy-registry.js';

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
      (u) => u.startsWith(LEGACY_REGISTRY_POLICY_ID) && assets[u] === 1n,
    );
    const nftAssetName = nftUnit ? nftUnit.slice(LEGACY_REGISTRY_POLICY_ID.length) : '';
    return {
      agentId: legacyDid(nftAssetName),
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
    const allUtxos = await provider.getUtxos(legacyRegistryAddress());
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
    return keys.length === 1 && keys[0] === 'lovelace' && u.assets['lovelace'] >= LEGACY_REGISTRY_DEPOSIT + 2_000_000n;
  }) || utxos[0];
  if (!oneShotUtxo) throw new Error('No UTxOs at the changeAddress. Add AP3X to the wallet first.');
  const nftAssetName = deriveNftAssetName(oneShotUtxo.txHash, oneShotUtxo.outputIndex);
  const nftUnit = `${LEGACY_REGISTRY_POLICY_ID}${nftAssetName}`;
  const datum = buildAgentDatum(vkeyHash, p.name, p.description, p.capabilities, p.framework, p.endpoint);
  const registerRedeemer = Data.to(new Constr(0, [new Constr(0, [oneShotUtxo.txHash, BigInt(oneShotUtxo.outputIndex)])]));
  const completed = await lucid.newTx()
    .collectFrom([oneShotUtxo])
    .mintAssets({ [nftUnit]: 1n }, registerRedeemer)
    .attach.MintingPolicy(legacyRegistryScript())
    .pay.ToAddressWithData(legacyRegistryAddress(), { kind: 'inline', value: datum }, { lovelace: LEGACY_REGISTRY_DEPOSIT, [nftUnit]: 1n })
    .addSigner(changeAddress)
    .complete();
  return {
    ...toBuildResult(completed),
    agentId: legacyDid(nftAssetName),
    nftAssetName,
    registryAddress: legacyRegistryAddress(),
    depositLovelace: LEGACY_REGISTRY_DEPOSIT.toString(),
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
  // { lovelace: LEGACY_REGISTRY_DEPOSIT, [nftUnit]: 1n } - the deployed validator
  // enforces value preservation on Update (differential-tested; see
  // task-3-report.md's correction section). Hardcoding the floor here was
  // the same latent defect the old custodial code had.
  const completed = await lucid.newTx()
    .collectFrom([utxo], spendRedeemer)
    .attach.SpendingValidator(legacyRegistryScript())
    .pay.ToAddressWithData(legacyRegistryAddress(), { kind: 'inline', value: newDatum }, utxo.assets)
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
    .attach.SpendingValidator(legacyRegistryScript())
    .pay.ToAddressWithData(legacyRegistryAddress(), { kind: 'inline', value: newDatum }, utxo.assets)
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
  // diagnosis). The DEPLOYED registry validator (LEGACY_REGISTRY_SCRIPT_CBOR /
  // LEGACY_REGISTRY_POLICY_ID in legacy-registry.ts) does NOT match the in-workspace Aiken source
  // under agent-infrastructure/contracts/agent-registry/ - that source
  // compiles to policy 5dd51189..., a different script entirely (confirmed
  // by hashing both; provenance worth resolving before the self-improvement
  // family trusts that source as ground truth). Differential-tested
  // directly against the deployed bytecode instead: deregister enforces a
  // floor on the owner's returned change - a sole-input deregister of a
  // registry UTxO holding exactly LEGACY_REGISTRY_DEPOSIT fails, the identical
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
    .attach.SpendingValidator(legacyRegistryScript())
    .collectFrom([feeUtxo])
    .mintAssets({ [nftUnit]: -1n }, mintRedeemer)
    .attach.MintingPolicy(legacyRegistryScript())
    .addSigner(changeAddress)
    .complete();
  return {
    ...toBuildResult(completed),
    agentId: p.agentId, op: 'deregister', agentName: profile.name, detail: String(utxo.assets.lovelace),
  };
}
