// packages/builder/src/vector/identity-tools.ts
// The identity registry tools (Part 2 Section 10): keyless builders of every action on a did:vector record: register, adopt, update,
// change controller, suspend, unsuspend, revoke, retire, reclaim, set successor, start, cancel and complete recovery, and end
// subagents. Each takes a wallet address and the action's inputs, and returns the unsigned transaction with every key hash that must
// sign it. Nothing here signs or submits. The node comes from `providerFor` and the deployment from `deploymentFor` (the server's
// environment), so a test can hand in its own.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda, apexToLovelace } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { text, fail, cell, isoOrRaw } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { identifierOf, requireConfigRecord } from './identity-chain.js';
import { LEGACY_REGISTRY_POLICY_ID } from './legacy-registry.js';
import { textOf, utf8Hex } from './identity-codec.js';
import type { Hold, Signer } from './identity-codec.js';
import { REASON_DISPUTE_VERDICT, REASON_NAMES, REVOKE_REASONS, RIGHT, RIGHT_NAMES, SUSPEND_REASONS, keyHashOf, signerText } from './identity-rules.js';
import type { RightName } from './identity-rules.js';
import {
  DEFAULT_SUSPEND_REASON, MODULE1_VERDICTS_ONLY, buildAdopt, buildChangeController, buildEndSubagents, buildReclaim, buildRecoveryCancel,
  buildRecoveryComplete, buildRecoveryStart, buildRegister, buildRetire, buildRevoke, buildSetSuccessor, buildSuspend, buildUnsuspend,
  buildUpdate, reasonText,
} from './identity-build.js';
import type { ActorSpec, DroppedHold, IdentityContext, ProfilePatch, RecordSpendBuild } from './identity-build.js';
import {
  zChangeAddress, zDid, zKeyHash, zTime, zValidMinutes, zPublicKey, zKey, zParty, zProfile, zSignerRef, isModule1Ref, keyFromInput,
  partyFromInput, profileFromInput, signerFromInput, buildText,
} from './identity-shared.js';

/** The deployment a tool builds against: the server's, unless a test hands in another. */
export type DeploymentFor = () => IdentityDeployment;

const PARTY_TIP = 'A record needs at least one Accountable Party that covers the validity window (for example { role: "Accountable", signer: "controller" })';
const FEE_TIP = 'The wallet needs about 1 AP3X for the fee and one pure AP3X output of at least 5 AP3X as collateral';
const RECORD_TIP = 'vector_resolve_did { did } shows the record: its controller, keys, parties (in order, from index 0), holds, status and pending recovery';

/** The facts that every action on a record shows. */
export function spendFacts(r: RecordSpendBuild, deployment: IdentityDeployment): Array<[string, string]> {
  return [
    ['DID', r.did],
    ['Action', `${r.action}: ${cell(r.summary, 400)}`],
    ['Record output', `#${r.recordOutputIndex} at ${deployment.identity.address}, ${lovelaceToAda(r.outputLovelace)} AP3X`],
  ];
}

/** The JSON that every action on a record returns, beside what buildText adds. */
export const spendJson = (r: RecordSpendBuild): Record<string, unknown> => ({
  did: r.did, id: r.id, action: r.action, record_output_index: r.recordOutputIndex, record_lovelace: r.outputLovelace,
});

// ─── Shared input schemas and conversions of the actions on a record ───────────────────────────────────────────────────────────

const zRole = zParty.shape.role;
const zRightNames = z.array(z.enum(RIGHT_NAMES as [RightName, ...RightName[]]));

const zPartyRef = z.object({ role: zRole, signer: zSignerRef });

const zActor = z.union([
  z.literal('controller'),
  z.object({
    party_index: z.number().int().min(0).max(7).optional().describe("The party's position in the record's party list, from 0"),
    role: zRole.optional(),
    signer: zSignerRef.optional(),
  }),
]).optional().describe(`Who acts: 'controller' (the default), or a party of the record that has the right, covers the validity window and signs, named as { party_index } or { role, signer }. ${MODULE1_VERDICTS_ONLY}.`);

/** The actor of a Suspend or a Revoke from its tool form. Module-1 is refused before anything is read. */
function actorFrom(input: z.infer<typeof zActor>): ActorSpec {
  if (input === undefined || input === 'controller') return { type: 'controller' };
  if (input.signer !== undefined && isModule1Ref(input.signer)) throw new Error(`${MODULE1_VERDICTS_ONLY}.`);
  return { type: 'party', index: input.party_index, role: input.role, signer: input.signer === undefined ? undefined : signerFromInput(input.signer, null) };
}

const zReason = (allowed: readonly number[], lead: string) => z.union([z.number().int().min(0), z.string().min(1).max(40)])
  .describe(`${lead} A reason code or its name (Part 2 Appendix A): ${allowed.filter((r) => r !== REASON_DISPUTE_VERDICT).map(reasonText).join(', ')}. Code 64 (disputeVerdict) belongs to Module-1`);

/** A reason code from its tool form: a number, a decimal string, or a name of Part 2 Appendix A. */
function reasonFrom(input: number | string): number {
  if (typeof input === 'number') return input;
  const value = input.trim();
  if (/^[0-9]+$/.test(value)) return Number(value);
  const named = Object.entries(REASON_NAMES).find(([, name]) => name.toLowerCase() === value.toLowerCase());
  if (!named) throw new Error(`Unknown reason ${JSON.stringify(value)}: give a reason code or its name (Part 2 Appendix A).`);
  return Number(named[0]);
}

const zGuardians = z.array(z.union([z.number().int().min(0).max(7), zKeyHash('A guardian')])).min(1).max(8)
  .describe('The guardians that act, each by its key hash (56 hex characters) or by its position in the party list (from 0): at least the guardian threshold of them. Each one signs');

/** A signer in the form that the tools take: 'controller', 'module1' or a key hash. */
const signerRef = (s: Signer): string => (s.type === 'ControllerSet' ? 'controller' : s.type === 'Script' ? 'module1' : s.hash);
const holdText = (h: Hold): string => `${signerText(h.by)}, ${reasonText(h.reason)}, ${isoOrRaw(h.since)} to ${isoOrRaw(h.until)}`;
const holdJson = (h: Hold) => ({ by: signerRef(h.by), reason: h.reason, reason_name: REASON_NAMES[h.reason] ?? null, since: h.since, until: h.until });

/** The facts of a Suspend or an Unsuspend: the holds that stay, the holds that drop and why, and the new status. */
function holdFacts(r: RecordSpendBuild & { kept: Hold[]; dropped: DroppedHold[] }): Array<[string, string]> {
  const status = r.record.status;
  return [
    ['Holds kept', r.kept.length === 0 ? 'none' : cell(r.kept.map(holdText).join('; '), 600)],
    ['Holds dropped', r.dropped.length === 0 ? 'none' : cell(r.dropped.map((d) => `${holdText(d.hold)} (${d.why})`).join('; '), 600)],
    ['New status', status.type === 'Suspended' ? `Suspended (${status.holds.length} in the hold list)` : status.type],
  ];
}

/** New profile fields from their tool form; only the fields that are given. */
function profilePatchFrom(p: { name?: string; description?: string; framework?: string; endpoint?: string; capabilities?: string[] }): ProfilePatch {
  const patch: ProfilePatch = {};
  for (const field of ['name', 'description', 'framework', 'endpoint'] as const) {
    const value = p[field];
    if (value !== undefined) patch[field] = utf8Hex(value);
  }
  if (p.capabilities !== undefined) patch.capabilities = p.capabilities.map(utf8Hex);
  return patch;
}

/** The identifier to adopt: either DID form, and a legacy DID must name the legacy registry's policy. */
function adoptionId(did: string): string {
  const legacy = /^did:vector:agent:([0-9a-f]{56}):[0-9a-f]{64}$/.exec(did.trim());
  if (legacy && legacy[1] !== LEGACY_REGISTRY_POLICY_ID) {
    throw new Error(`The DID names the policy ${legacy[1]}, not the legacy registry ${LEGACY_REGISTRY_POLICY_ID}: only records of the legacy registry can adopt.`);
  }
  return identifierOf(did);
}

export function registerIdentityRegistryTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: DeploymentFor = requireIdentityDeployment) {
  server.tool(
    'vector_build_identity_register',
    'Build an UNSIGNED transaction that registers a new agent in the Vector identity registry (did:vector): it mints the identity token named from a seed output of your wallet, so the DID is known before you sign, and locks a deposit of at least 10 AP3X in the record. ' +
      'The record names a controller key (the only key that can change it), listed keys with their purposes, and parties; at least one Accountable Party must cover the validity window. With `parent` it registers a subagent of that agent (no endpoint; the parent controller signs too). ' +
      'The controller, each listed Ed25519 key, each key-hash party and a parent controller must sign; Module-1 as a party consents through its withdrawal. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      controller: zPublicKey('The controller key of the new record'),
      ...zProfile,
      keys: z.array(zKey).max(8).optional().describe('Listed keys (up to 8): the keys that act for the agent. Each new Ed25519 key signs the registration.'),
      parties: z.array(zParty).min(1).max(8).describe(`Parties (up to 8). ${PARTY_TIP}.`),
      guardian_threshold: z.number().int().min(0).optional().describe('How many guardians must act together to replace a lost controller key (default 0: no recovery); at most the number of Guardian parties with the recover right'),
      parent: zDid('the parent agent, to register a subagent').optional(),
      deposit: z.number().min(10).optional().describe('AP3X that the record locks (default 10, the minimum); the controller can take it back after the record ends'),
      valid_minutes: zValidMinutes,
    },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const m1 = args.parties.some((p) => isModule1Ref(p.signer)) ? (await requireConfigRecord(provider, deployment)).m1 : null;
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const r = await buildRegister({ lucid, provider, deployment }, {
          changeAddress: args.changeAddress, controller: args.controller, keys: (args.keys ?? []).map(keyFromInput),
          parties: args.parties.map((p) => partyFromInput(p, m1)), guardianThreshold: args.guardian_threshold,
          ...profileFromInput(args), parent: args.parent === undefined ? undefined : identifierOf(args.parent),
          depositLovelace: args.deposit === undefined ? undefined : apexToLovelace(args.deposit), validMinutes: args.valid_minutes,
        });
        const facts: Array<[string, string]> = [
          ['DID', `${r.did} (from the seed ${r.seed}: if that output is spent first, build again for a new DID)`],
          ['Name', cell(args.name, 64)],
          ['Kind', r.record.lineage.type === 'Subagent' ? `subagent of did:vector:${r.record.lineage.parent} at depth ${r.record.lineage.depth}` : 'independent agent'],
          ['Record output', `#${r.recordOutputIndex} at ${deployment.identity.address}, deposit ${lovelaceToAda(r.depositLovelace)} AP3X`],
          ['Created at', new Date(r.createdAt).toISOString()],
        ];
        return text(buildText('Identity Registration Built', facts, r, {
          did: r.did, id: r.id, seed: r.seed, record_output_index: r.recordOutputIndex, deposit_lovelace: r.depositLovelace, created_at: r.createdAt,
        }));
      } catch (err) {
        return fail('build identity registration', err, [
          PARTY_TIP,
          'The wallet needs the deposit plus about 1 AP3X for the fee, and one pure AP3X output of at least 5 AP3X as collateral',
          'vector_signer_get_public_key shows the public key of your signer, for controller and keys',
        ]);
      }
    },
  );

  server.tool(
    'vector_build_identity_end_subagents',
    "Build an UNSIGNED transaction that ends every subagent of an agent at once: it raises the record's subagent epoch by one, and each subagent created under an older epoch resolves as revoked (parentRevoked). The controller signs. Takes no key material.",
    { changeAddress: zChangeAddress, did: zDid('the agent whose subagents end'), valid_minutes: zValidMinutes },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const r = await buildEndSubagents({ lucid, provider, deployment }, { changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes });
        return text(buildText('End Subagents Built', spendFacts(r, deployment), r, spendJson(r)));
      } catch (err) {
        return fail('build end of subagents', err, ['vector_get_agent_profile { agent_id } shows the record and its controller key', 'The wallet needs about 1 AP3X for the fee and one pure AP3X output of at least 5 AP3X as collateral']);
      }
    },
  );

  /** Runs a build tool: the rate gate, the deployment, the node, Lucid bound to the wallet, then `build`; a failure becomes `fail`. */
  const run = async (changeAddress: string, failure: string, tips: string[], build: (ctx: IdentityContext) => Promise<string>) => {
    const limited = checkRateLimit(); if (limited) return limited;
    try {
      const deployment = deploymentFor();
      const provider = providerFor();
      const lucid = await lucidForAddress(provider, changeAddress);
      return text(await build({ lucid, provider, deployment }));
    } catch (err) {
      return fail(failure, err, tips);
    }
  };
  /** The Module-1 hash of the configuration record when one of `refs` names Module-1, else null (nothing is read). */
  const m1For = async (ctx: IdentityContext, refs: Array<string | undefined>): Promise<string | null> =>
    (refs.some((ref) => ref !== undefined && isModule1Ref(ref)) ? (await requireConfigRecord(ctx.provider, ctx.deployment)).m1 : null);

  server.tool(
    'vector_build_identity_adopt',
    'Build an UNSIGNED transaction that adopts a legacy agent record into the Vector identity registry (did:vector): it deregisters the legacy record, burns its legacy token and mints the identity token of the same identifier, so the agent keeps its identifier. ' +
      'The identifier must be on the adoption allowlist: pass `proof`, or the server computes it from the published allowlist. Each legacy profile field that fits the identity limits is copied; give a new value for each field that does not (a refusal lists them). ' +
      'The transaction also pays 10 AP3X to the legacy owner key, as the legacy deregistration requires (back to your wallet when your wallet is the owner). The legacy owner key, the controller, each listed Ed25519 key and each key-hash party sign; Module-1 as a party consents through its withdrawal. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      did: zDid('the legacy agent to adopt (did:vector:agent:<legacy policy>:<64 hex> or did:vector:<64 hex>)'),
      controller: zPublicKey('The controller key of the adopted record'),
      keys: z.array(zKey).max(8).optional().describe('Listed keys (up to 8): the keys that act for the agent. Each new Ed25519 key signs the adoption.'),
      parties: z.array(zParty).min(1).max(8).describe(`Parties (up to 8). ${PARTY_TIP}.`),
      guardian_threshold: z.number().int().min(0).optional().describe('How many guardians must act together to replace a lost controller key (default 0: no recovery); at most the number of Guardian parties with the recover right'),
      name: zProfile.name.optional().describe('New agent name, 1 to 64 bytes; default the legacy name when it fits'),
      description: z.string().max(256).optional().describe('New description, up to 256 bytes; default the legacy description when it fits'),
      framework: z.string().max(64).optional().describe('New framework, up to 64 bytes; default the legacy framework when it fits'),
      endpoint: z.string().max(256).optional().describe('New endpoint URL, up to 256 bytes; default the legacy endpoint when it fits'),
      capabilities: z.array(z.string().min(1).max(64)).max(16).optional().describe('New capability ids, up to 16 of 1 to 64 bytes, no duplicates; default the legacy list when it fits'),
      proof: z.array(z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters')).max(64).optional()
        .describe('The Merkle proof of the identifier on the adoption allowlist: the 32-byte nodes (64 hex characters each) from the leaf upward. Default: computed from the allowlist that the deployment publishes'),
      deposit: z.number().min(10).optional().describe('AP3X that the new record locks (default 10, the minimum; a large record needs its ledger minimum, which the builder takes when it is higher)'),
      valid_minutes: zValidMinutes,
    },
    async (args) => run(args.changeAddress, 'build identity adoption', [
      'Only records on the adoption allowlist (legacy records minted before the cutoff slot) can adopt; the legacy owner key must sign',
      'Without proof, the server reads the allowlist from VECTOR_IDENTITY_ALLOWLIST_URL; pass proof when it has none',
      PARTY_TIP,
      'The wallet needs the deposit, the 10 AP3X owner output (it returns to the wallet when the wallet is the owner), about 1 AP3X for the fee, and one pure AP3X output of at least 5 AP3X as collateral',
    ], async (ctx) => {
      const m1 = await m1For(ctx, args.parties.map((p) => p.signer));
      const r = await buildAdopt(ctx, {
        changeAddress: args.changeAddress, id: adoptionId(args.did), controller: args.controller, keys: (args.keys ?? []).map(keyFromInput),
        parties: args.parties.map((p) => partyFromInput(p, m1)), guardianThreshold: args.guardian_threshold, profile: profilePatchFrom(args),
        proof: args.proof, depositLovelace: args.deposit === undefined ? undefined : apexToLovelace(args.deposit), validMinutes: args.valid_minutes,
      });
      const fields = Object.entries(r.profileFrom);
      const copied = fields.filter(([, from]) => from === 'legacy').map(([field]) => field);
      const given = fields.filter(([, from]) => from === 'given').map(([field]) => field);
      const facts: Array<[string, string]> = [
        ['DID', `${r.did} (adopted from ${r.legacyDid}; the identifier stays)`],
        ['Legacy record', `${r.legacyInput}, owner key hash ${r.legacyOwner}, ${lovelaceToAda(r.legacyLovelace)} AP3X: the legacy Deregister spends it and the legacy Burn burns its token`],
        ['Name', cell(textOf(r.record.name) ?? r.record.name, 64)],
        ['Profile', `copied from the legacy record: ${copied.join(', ') || 'none'}; given: ${given.join(', ') || 'none'}`],
        ['Allowlist proof', `${r.proof.length} nodes, ${r.proofFrom === 'given' ? 'as given' : 'computed from the published allowlist'}; it leads to the deployment's root`],
        ['Record output', `#${r.recordOutputIndex} at ${ctx.deployment.identity.address}, deposit ${lovelaceToAda(r.depositLovelace)} AP3X`],
        ['Owner output', `#${r.ownerOutputIndex}: 10 AP3X to ${r.ownerAddress} (the legacy Deregister needs one output of at least 10 AP3X to the owner key)`],
        ['Created at', isoOrRaw(r.createdAt)],
      ];
      return buildText('Identity Adoption Built', facts, r, {
        did: r.did, id: r.id, legacy_did: r.legacyDid, legacy_utxo: r.legacyInput, legacy_owner: r.legacyOwner, proof: r.proof, proof_from: r.proofFrom,
        profile_from: r.profileFrom, record_output_index: r.recordOutputIndex, deposit_lovelace: r.depositLovelace,
        owner_output_index: r.ownerOutputIndex, owner_address: r.ownerAddress, created_at: r.createdAt,
      });
    }),
  );

  server.tool(
    'vector_build_identity_update',
    "Build an UNSIGNED transaction that updates a live did:vector record: profile fields, listed keys, parties and the guardian threshold, in one Update. Give only what changes. The controller signs; so does each new Ed25519 key, each new or changed party, and each removed party whose removal notice has not passed. " +
      'A removal notice (announce_party_removal) needs no signature of the party: after it ends (at least 7 days), the controller removes the party alone. A threshold of 0 cancels a pending recovery. Module-1 joins as a party by its consent withdrawal; it never consents to a change or to an early removal. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      did: zDid('the agent to update'),
      name: zProfile.name.optional().describe('New agent name, 1 to 64 bytes of UTF-8'),
      description: zProfile.description.describe('New description, up to 256 bytes'),
      framework: zProfile.framework.describe('New framework, up to 64 bytes'),
      endpoint: zProfile.endpoint.describe('New endpoint URL, up to 256 bytes (a subagent has none)'),
      capabilities: zProfile.capabilities.describe('The new capability list (it replaces the old one): up to 16 ids of 1 to 64 bytes, no duplicates'),
      add_keys: z.array(zKey).max(8).optional().describe('Keys that join the record. Each new Ed25519 key signs; a P-256 key carries pop. A listed key cannot change: remove it in one update and add it again in a later one'),
      remove_keys: z.array(z.string().regex(/^(?:[0-9a-fA-F]{56}|[0-9a-fA-F]{64}|[0-9a-fA-F]{66})$/, 'expected a public key (64 or 66 hex characters) or a key hash (56)')).max(8).optional()
        .describe('Keys that leave the record, each by its public key or its key hash'),
      add_parties: z.array(zParty).max(8).optional().describe('Parties that join (they come last in the list). Each signs: a key-hash party by its key, the controller party by the controller, Module-1 by its consent withdrawal'),
      change_parties: z.array(z.object({
        role: zRole, signer: zSignerRef,
        organisation: z.string().min(1).max(64).nullable().optional().describe('New organisation (1 to 64 bytes), or null to clear it'),
        not_before: zTime('New not_before').optional(),
        not_after: zTime('New not_after, or null for no end').nullable().optional(),
        rights: zRightNames.optional().describe('New rights: suspend, revoke, recover (within the highest rights of the role)'),
        removal_after: zTime('New removal_after, or null to withdraw a removal notice').nullable().optional(),
      })).max(8).optional().describe('Changes of existing parties, each named by its role and signer; fields that are not given stay. The party signs'),
      remove_parties: z.array(zPartyRef).max(8).optional().describe('Parties that leave, each named by its role and signer. The party signs, unless its removal notice has ended'),
      announce_party_removal: z.array(z.object({
        role: zRole, signer: zSignerRef,
        removal_after: zTime('When the controller may remove the party without its signature: at least 7 days after the end of the validity window (the default)').optional(),
      })).max(8).optional().describe('Removal notices for parties, each named by its role and signer. The party does not sign'),
      guardian_threshold: z.number().int().min(0).optional().describe('New guardian threshold: at most the Guardian parties with the recover right whose period has not ended; 0 turns recovery off and cancels a pending recovery'),
      deposit: z.number().min(10).optional().describe('The AP3X that the record holds after the update (at least 10, or its ledger minimum when that is higher); default unchanged. The difference comes from or goes to the wallet'),
      valid_minutes: zValidMinutes,
    },
    async (args) => run(args.changeAddress, 'build identity update', [RECORD_TIP, 'Each new key, each new or changed party and each party removed without an ended notice signs in turn after the controller', FEE_TIP], async (ctx) => {
      const refs = [args.add_parties, args.change_parties, args.remove_parties, args.announce_party_removal].flatMap((list) => (list ?? []).map((p: { signer: string }) => p.signer));
      const m1 = await m1For(ctx, refs);
      const r = await buildUpdate(ctx, {
        changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes, profile: profilePatchFrom(args),
        addKeys: args.add_keys?.map(keyFromInput), removeKeys: args.remove_keys,
        addParties: args.add_parties?.map((p) => partyFromInput(p, m1)),
        changeParties: args.change_parties?.map((c) => ({
          role: c.role, signer: signerFromInput(c.signer, m1),
          organisation: c.organisation === undefined || c.organisation === null ? c.organisation : utf8Hex(c.organisation),
          notBefore: c.not_before, notAfter: c.not_after, removalAfter: c.removal_after,
          rights: c.rights === undefined ? undefined : [...new Set(c.rights)].reduce((sum, name) => sum + RIGHT[name], 0),
        })),
        removeParties: args.remove_parties?.map((q) => ({ role: q.role, signer: signerFromInput(q.signer, m1) })),
        announcePartyRemoval: args.announce_party_removal?.map((n) => ({ role: n.role, signer: signerFromInput(n.signer, m1), removalAfter: n.removal_after })),
        guardianThreshold: args.guardian_threshold, depositLovelace: args.deposit === undefined ? undefined : apexToLovelace(args.deposit),
      });
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ...r.changes.map((change): [string, string] => ['Change', cell(change, 400)]),
        ...r.notes.map((note): [string, string] => ['Note', cell(note, 400)]),
      ];
      return buildText('Identity Update Built', facts, r, { ...spendJson(r), changes: r.changes, notes: r.notes });
    }),
  );

  server.tool(
    'vector_build_identity_change_controller',
    'Build an UNSIGNED transaction that installs a new controller key on a live did:vector record. It ends every subagent of the agent (the subagent epoch rises by one) and cancels a pending recovery; holds stay. The old and the new controller keys sign. Takes no key material.',
    { changeAddress: zChangeAddress, did: zDid('the agent whose controller changes'), new_controller: zPublicKey('The new controller key'), valid_minutes: zValidMinutes },
    async (args) => run(args.changeAddress, 'build controller change', [RECORD_TIP, 'The current and the new controller keys both sign', FEE_TIP], async (ctx) => {
      const r = await buildChangeController(ctx, { changeAddress: args.changeAddress, id: identifierOf(args.did), newController: args.new_controller, validMinutes: args.valid_minutes });
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ['New controller', `key hash ${keyHashOf(r.record.controller)}`],
        ['Subagent epoch', `${r.record.subagentEpoch} (every subagent created under an older epoch ends)`],
      ];
      return buildText('Controller Change Built', facts, r, {
        ...spendJson(r), new_controller: r.record.controller, new_controller_key_hash: keyHashOf(r.record.controller), subagent_epoch: r.record.subagentEpoch,
      });
    }),
  );

  server.tool(
    'vector_build_identity_suspend',
    "Build an UNSIGNED transaction that suspends a live did:vector record with a hold of its author (the controller, or a party with the suspend right) for at most 30 days. Each author has one hold: a new hold replaces the author's older one, and the holds of other authors stay. The author signs. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      did: zDid('the agent to suspend'),
      actor: zActor,
      reason: zReason(SUSPEND_REASONS, `Why the agent is held (default ${DEFAULT_SUSPEND_REASON}, hold).`).optional(),
      days: z.number().int().min(1).max(30).optional().describe('How long the hold lasts, in days from the start of the validity window (default 30). Do not combine with until'),
      until: zTime('When the hold ends: after the end of the validity window, at most 30 days after its start').optional(),
      valid_minutes: zValidMinutes,
    },
    async (args) => run(args.changeAddress, 'build suspension', [RECORD_TIP, 'A party acts only with the suspend right and while its period covers the validity window', FEE_TIP], async (ctx) => {
      const r = await buildSuspend(ctx, {
        changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes, actor: actorFrom(args.actor),
        reason: args.reason === undefined ? undefined : reasonFrom(args.reason), days: args.days, until: args.until,
      });
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ['New hold', cell(holdText(r.hold), 300)],
        ...holdFacts(r),
      ];
      return buildText('Suspension Built', facts, r, {
        ...spendJson(r), hold: holdJson(r.hold), holds: [...r.kept, r.hold].map(holdJson), dropped: r.dropped.map((d) => ({ ...holdJson(d.hold), why: d.why })),
      });
    }),
  );

  server.tool(
    'vector_build_identity_unsuspend',
    'Build an UNSIGNED transaction that lifts the hold of one author (the controller, or the key of a party) on a live did:vector record. The holds of other authors stay; the status is Active when none remains. The author signs. A Module-1 hold cannot be lifted: it ends at its end time. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      did: zDid('the agent whose hold ends'),
      author: zSignerRef.optional().describe("The author whose hold ends: 'controller' (the default) or the key hash of the party that set it"),
      valid_minutes: zValidMinutes,
    },
    async (args) => run(args.changeAddress, 'build unsuspension', [RECORD_TIP, 'Only the author of a hold lifts it, and it signs', FEE_TIP], async (ctx) => {
      const ref = args.author ?? 'controller';
      if (isModule1Ref(ref)) throw new Error(`Module-1 never lifts its holds: a Module-1 hold ends only at its until. ${MODULE1_VERDICTS_ONLY}.`);
      const r = await buildUnsuspend(ctx, { changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes, author: signerFromInput(ref, null) });
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ...holdFacts(r),
      ];
      return buildText('Unsuspension Built', facts, r, {
        ...spendJson(r), author: signerRef(r.author), status: r.record.status.type, holds: r.kept.map(holdJson), dropped: r.dropped.map((d) => ({ ...holdJson(d.hold), why: d.why })),
      });
    }),
  );

  server.tool(
    'vector_build_identity_revoke',
    'Build an UNSIGNED transaction that revokes a live did:vector record for good: the record becomes a tombstone (keys, parties, holds and most profile fields are cleared; the identifier, controller and name stay). The controller or a party with the revoke right acts and signs. ' +
      'The reason code is public for ever. invalid_from makes signatures by the record\'s keys from that time on invalid (a keyCompromise needs it). Only the controller names a successor, whose controller signs too. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      did: zDid('the agent to revoke'),
      actor: zActor,
      reason: zReason(REVOKE_REASONS, 'Why the agent is revoked.'),
      invalid_from: zTime('From when signatures by the keys of the record are invalid: from one hour before the record\'s created_at (the end of the validity window of its registration or adoption) up to the start of the validity window. A keyCompromise (1) needs it').optional(),
      successor: zDid('the successor: another live, independent agent whose controller signs too (controller only)').optional(),
      valid_minutes: zValidMinutes,
    },
    async (args) => run(args.changeAddress, 'build revocation', [RECORD_TIP, 'A party acts only with the revoke right and while its period covers the validity window; it names no successor', FEE_TIP], async (ctx) => {
      const r = await buildRevoke(ctx, {
        changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes, actor: actorFrom(args.actor),
        reason: reasonFrom(args.reason), invalidFrom: args.invalid_from, successor: args.successor === undefined ? undefined : identifierOf(args.successor),
      });
      const status = r.record.status;
      if (status.type !== 'Revoked') throw new Error('The built record is not revoked.');
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ['Revoked by', signerText(status.by)],
        ['Reason', reasonText(status.reason)],
        ['At', isoOrRaw(status.at)],
        ['Invalid from', status.invalidFrom === null ? 'not set' : isoOrRaw(status.invalidFrom)],
        ['Successor', status.successor === null ? 'none' : `did:vector:${status.successor}`],
      ];
      return buildText('Revocation Built', facts, r, {
        ...spendJson(r), status: 'Revoked', by: signerRef(status.by), reason: status.reason, reason_name: REASON_NAMES[status.reason] ?? null,
        at: status.at, invalid_from: status.invalidFrom, successor: status.successor === null ? null : `did:vector:${status.successor}`,
      }, 'A revocation is final: the record cannot become live again.');
    }),
  );

  server.tool(
    'vector_build_identity_retire',
    'Build an UNSIGNED transaction that retires a live did:vector record for good: the record becomes a tombstone with status Retired. The controller signs, and so does the controller of a successor. By default the tombstone keeps its AP3X; with take_deposit it keeps only the ledger minimum and the rest returns to the wallet. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      did: zDid('the agent to retire'),
      successor: zDid('the successor: another live, independent agent whose controller signs too').optional(),
      take_deposit: z.boolean().optional().describe('Return the deposit above the ledger minimum to the wallet in the same transaction (default false; vector_build_identity_reclaim can do it later)'),
      valid_minutes: zValidMinutes,
    },
    async (args) => run(args.changeAddress, 'build retirement', [RECORD_TIP, 'The controller signs; a successor must be a live record without a parent', FEE_TIP], async (ctx) => {
      const r = await buildRetire(ctx, {
        changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes,
        successor: args.successor === undefined ? undefined : identifierOf(args.successor), takeDeposit: args.take_deposit,
      });
      const status = r.record.status;
      if (status.type !== 'Retired') throw new Error('The built record is not retired.');
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ['Retired at', isoOrRaw(status.at)],
        ['Successor', status.successor === null ? 'none' : `did:vector:${status.successor}`],
        ['Returned to the wallet', `${lovelaceToAda(r.returnedLovelace)} AP3X`],
      ];
      return buildText('Retirement Built', facts, r, {
        ...spendJson(r), status: 'Retired', at: status.at, successor: status.successor === null ? null : `did:vector:${status.successor}`, returned_lovelace: r.returnedLovelace,
      }, 'A retirement is final: the record cannot become live again.');
    }),
  );

  server.tool(
    'vector_build_identity_reclaim',
    'Build an UNSIGNED transaction that takes back the AP3X of an ended (Revoked or Retired) did:vector record above the ledger minimum. The tombstone stays unchanged with the ledger minimum; the rest returns to the wallet. The controller signs. Takes no key material.',
    { changeAddress: zChangeAddress, did: zDid('the ended agent'), valid_minutes: zValidMinutes },
    async (args) => run(args.changeAddress, 'build reclaim', [RECORD_TIP, 'Only a Revoked or Retired record can be reclaimed; its controller signs', FEE_TIP], async (ctx) => {
      const r = await buildReclaim(ctx, { changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes });
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ['Returned to the wallet', `${lovelaceToAda(r.returnedLovelace)} AP3X (the tombstone keeps the ledger minimum of ${lovelaceToAda(r.outputLovelace)} AP3X)`],
      ];
      return buildText('Reclaim Built', facts, r, { ...spendJson(r), returned_lovelace: r.returnedLovelace });
    }),
  );

  server.tool(
    'vector_build_identity_set_successor',
    'Build an UNSIGNED transaction that names the successor of an ended (Revoked or Retired) did:vector record that has none yet, also after a party revoked it. The successor is another live, independent agent. The controller of the ended record and the controller of the successor sign. Takes no key material.',
    { changeAddress: zChangeAddress, did: zDid('the ended agent'), successor: zDid('the successor'), valid_minutes: zValidMinutes },
    async (args) => run(args.changeAddress, 'build successor', [RECORD_TIP, 'A record names its successor once; the successor must be live and have no parent', FEE_TIP], async (ctx) => {
      const r = await buildSetSuccessor(ctx, { changeAddress: args.changeAddress, id: identifierOf(args.did), successor: identifierOf(args.successor), validMinutes: args.valid_minutes });
      const status = r.record.status;
      const successor = status.type === 'Revoked' || status.type === 'Retired' ? status.successor : null;
      const facts: Array<[string, string]> = [...spendFacts(r, ctx.deployment), ['Successor', `did:vector:${successor}`], ['Status', status.type]];
      return buildText('Successor Built', facts, r, { ...spendJson(r), successor: `did:vector:${successor}`, status: status.type });
    }),
  );

  server.tool(
    'vector_build_identity_recovery_start',
    'Build an UNSIGNED transaction that starts the recovery of a live did:vector record whose controller key is lost: enough guardians (at least the guardian threshold) and the new controller key sign. Anybody can complete the recovery 7 days later with vector_build_identity_recovery_complete; until then the guardians can cancel it. Takes no key material.',
    { changeAddress: zChangeAddress, did: zDid('the agent to recover'), new_controller: zPublicKey('The new controller key'), guardians: zGuardians, valid_minutes: zValidMinutes },
    async (args) => run(args.changeAddress, 'build recovery start', [RECORD_TIP, 'Each named guardian needs the recover right and a period that covers the validity window', FEE_TIP], async (ctx) => {
      const r = await buildRecoveryStart(ctx, { changeAddress: args.changeAddress, id: identifierOf(args.did), newController: args.new_controller, guardians: args.guardians, validMinutes: args.valid_minutes });
      const pending = r.record.pendingRecovery;
      if (!pending) throw new Error('The built record has no pending recovery.');
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ['New controller', `key hash ${keyHashOf(pending.newController)}`],
        ['Guardians', `party indices ${r.guardians.join(', ')}`],
        ['Can complete from', isoOrRaw(pending.effectiveAfter)],
      ];
      return buildText('Recovery Start Built', facts, r, {
        ...spendJson(r), new_controller: pending.newController, new_controller_key_hash: keyHashOf(pending.newController), effective_after: pending.effectiveAfter, guardians: r.guardians,
      });
    }),
  );

  server.tool(
    'vector_build_identity_recovery_cancel',
    'Build an UNSIGNED transaction that cancels the pending recovery of a live did:vector record: enough guardians (at least the guardian threshold) sign. Takes no key material.',
    { changeAddress: zChangeAddress, did: zDid('the agent whose recovery ends'), guardians: zGuardians, valid_minutes: zValidMinutes },
    async (args) => run(args.changeAddress, 'build recovery cancel', [RECORD_TIP, 'Each named guardian needs the recover right and a period that covers the validity window', FEE_TIP], async (ctx) => {
      const r = await buildRecoveryCancel(ctx, { changeAddress: args.changeAddress, id: identifierOf(args.did), guardians: args.guardians, validMinutes: args.valid_minutes });
      return buildText('Recovery Cancel Built', [...spendFacts(r, ctx.deployment), ['Guardians', `party indices ${r.guardians.join(', ')}`]], r, { ...spendJson(r), guardians: r.guardians });
    }),
  );

  server.tool(
    'vector_build_identity_recovery_complete',
    'Build an UNSIGNED transaction that completes the pending recovery of a live did:vector record once its 7 days have passed: the new controller key takes over, and every subagent ends (the subagent epoch rises by one). Anybody can submit it: only the wallet signs. Takes no key material.',
    { changeAddress: zChangeAddress, did: zDid('the agent to recover'), valid_minutes: zValidMinutes },
    async (args) => run(args.changeAddress, 'build recovery completion', [RECORD_TIP, 'The recovery completes only when its effective_after is at or before the start of the validity window', FEE_TIP], async (ctx) => {
      const r = await buildRecoveryComplete(ctx, { changeAddress: args.changeAddress, id: identifierOf(args.did), validMinutes: args.valid_minutes });
      const facts: Array<[string, string]> = [
        ...spendFacts(r, ctx.deployment),
        ['New controller', `key hash ${keyHashOf(r.record.controller)}`],
        ['Subagent epoch', `${r.record.subagentEpoch} (every subagent created under an older epoch ends)`],
      ];
      return buildText('Recovery Completion Built', facts, r, {
        ...spendJson(r), new_controller: r.record.controller, new_controller_key_hash: keyHashOf(r.record.controller), subagent_epoch: r.record.subagentEpoch,
      });
    }),
  );
}
