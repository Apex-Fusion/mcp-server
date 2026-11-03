// Keyless build core for the legacy agent registry (spec PR 7), reduced to what Part 2 Section 10 keeps: the legacy reads (the
// profile of a legacy DID) and the legacy deregistration of a record that does not adopt. The legacy register, update and transfer
// builders are retired; new records go to the identity registry (identity-build.ts), and a legacy record moves there by adoption.
// Constructs UNSIGNED transactions only. The user's key never enters this
// package: signing happens on the local signer (packages/signer), submission
// via vector_submit_transaction. The registry validator itself enforces
// ownership on-chain; the verifyOwnership() check here is a fail-fast courtesy.
// The legacy registry's script, policy, address and deposit live in
// legacy-registry.ts.
import { toText, Data, Constr, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import type { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import type { VectorBuildAgentOpResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { LEGACY_REGISTRY_POLICY_ID, legacyRegistryScript, legacyRegistryAddress, legacyDid } from './legacy-registry.js';

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
