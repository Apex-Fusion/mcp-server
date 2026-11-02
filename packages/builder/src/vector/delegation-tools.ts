// packages/builder/src/vector/delegation-tools.ts
// The delegation tools (Part 2 Sections 5.2 and 10): keyless builders of delegate (also sub-delegations) and undelegate. Each takes a
// wallet address and the action's inputs, and returns the unsigned transaction with every key hash that must sign it. Nothing here
// signs or submits. The node comes from `providerFor` and the deployment from `deploymentFor` (the server's environment), so a test
// can hand in its own.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda, apexToLovelace } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { text, fail, cell, isoOrRaw } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { DeploymentFor } from './identity-tools.js';
import { didOf, identifierOf } from './identity-chain.js';
import { textOf, utf8Hex } from './identity-codec.js';
import { keyHashOf } from './identity-rules.js';
import { zChangeAddress, zDid, zValidMinutes, zTime, buildText } from './identity-shared.js';
import { HIRE_ACTION, MAX_ACTIONS, MAX_RESOURCES, buildDelegate, buildUndelegate, patternsOf } from './delegation-build.js';
import type { DelegatorInput } from './delegation-build.js';

const zHex32 = (what: string) => z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters').describe(what);
const KEY_REF = /^(?:[0-9a-fA-F]{56}|[0-9a-fA-F]{64})$/;
const zKeyRef = (what: string) => z.string().regex(KEY_REF, 'expected a key hash (56 hex) or an Ed25519 public key (64 hex)')
  .describe(`${what}: a key hash (56 hex) or an Ed25519 public key (64 hex)`);
/** The key hash of a tool key reference: a key hash as it is, a public key hashed. */
const keyHashFrom = (ref: string): string => (ref.length === 64 ? keyHashOf(ref.toLowerCase()) : ref.toLowerCase());

const FUNDS_TIP = 'The wallet needs about 2 AP3X for the fee and the delegation output, and one pure AP3X output of at least 5 AP3X as collateral';
const PROFILE_TIP = 'vector_get_agent_profile { agent_id } shows a record, its controller and its keys with their purposes';

/** The delegator of the tool inputs; refuses combinations that the contract cannot accept. */
function delegatorFrom(args: { principal_key?: string; organisation?: string; delegator?: string; delegator_signer?: string; parent?: string }): DelegatorInput | undefined {
  if (args.principal_key !== undefined && args.delegator !== undefined) throw new Error('Give principal_key or delegator, not both: a delegation has one delegator.');
  if (args.organisation !== undefined && args.principal_key === undefined) throw new Error('organisation goes only with principal_key.');
  if (args.delegator_signer !== undefined && args.delegator === undefined) throw new Error('delegator_signer goes only with delegator.');
  if (args.parent !== undefined) {
    if (args.principal_key !== undefined) throw new Error("A sub-delegation's delegator is the parent's delegate agent, never a principal key: leave out principal_key.");
    if (args.delegator_signer !== undefined) throw new Error("In a sub-delegation the parent's delegate key signs for the delegator: leave out delegator_signer.");
    return args.delegator === undefined ? undefined : { type: 'Agent', id: identifierOf(args.delegator) };
  }
  if (args.principal_key !== undefined) {
    return { type: 'PrincipalKey', hash: keyHashFrom(args.principal_key), organisation: args.organisation === undefined ? null : utf8Hex(args.organisation) };
  }
  if (args.delegator === undefined) return undefined;
  const signer = args.delegator_signer?.trim();
  if (signer !== undefined && signer.toLowerCase() !== 'controller' && !KEY_REF.test(signer)) {
    throw new Error("delegator_signer must be 'controller', a key hash (56 hex) or an Ed25519 public key (64 hex).");
  }
  return { type: 'Agent', id: identifierOf(args.delegator), signer: signer === undefined || signer.toLowerCase() === 'controller' ? 'controller' : keyHashFrom(signer) };
}

export function registerDelegationTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: DeploymentFor = requireIdentityDeployment) {
  server.tool(
    'vector_build_delegation_delegate',
    'Build an UNSIGNED transaction that delegates authority to a registered agent (Part 2 Section 5.2): the delegate may act, with its delegate key, for the actions and resources that the patterns cover, inside the period, and within the value limit. ' +
      'The delegator is a principal key (principal_key) or a registered agent (delegator; its controller or a delegation key signs). With parent it is a sub-delegation: the delegator is the parent\'s delegate agent, the parent\'s delegate key signs, and everything must be inside the parent. ' +
      `The delegate key also signs, and no other live delegation may use it (fresh keys). Vault payments need the action ${HIRE_ACTION}, the resource script:<escrow hash> and a value limit. ` +
      'It mints the delegation token named from a seed output of your wallet; the output holds the ledger minimum of AP3X, which undelegate returns. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      delegate: zDid('the delegate agent, which acts under the delegation (its record must be Active)'),
      delegate_key: zKeyRef('The delegate key: a key that the delegate record lists with the delegation purpose and that no other live delegation uses. It signs this transaction and every use'),
      principal_key: zKeyRef('A principal as the delegator (a key, not a registered agent): it signs. Not with delegator or parent').optional(),
      organisation: z.string().min(1).optional().describe('With principal_key: the DID or domain of the organisation that the principal acts for (never a person), 1 to 64 bytes'),
      delegator: zDid("a registered agent as the delegator (its record must be Active). With parent it is the parent's delegate agent and can be left out").optional(),
      delegator_signer: z.string().optional()
        .describe("With delegator and no parent: who signs for the agent: 'controller' (default) or a key that its record lists with the delegation purpose (key hash or public key)"),
      parent: zHex32("The parent delegation, for a sub-delegation: its identifier (64 hex). The parent's delegate agent is the delegator, and the parent's delegate key signs").optional(),
      actions: z.array(z.string().min(1)).min(1).max(MAX_ACTIONS)
        .describe(`What the delegate may do: 1 to ${MAX_ACTIONS} action patterns: "*", a name such as ${HIRE_ACTION}, a prefix such as ocr.* (covers ocr.extract, not ocrx), or oauth:, mcp: or https:// with visible characters after it (matched exactly). A sub-delegation's parent must cover each pattern`),
      resources: z.array(z.string().min(1)).max(MAX_RESOURCES).optional()
        .describe(`On what: 0 to ${MAX_RESOURCES} resource patterns: "*", script:<56 lowercase hex> (a script; vault payments use script:<escrow hash>), or oauth:, mcp: or https:// with visible characters after it. Default none, which covers no resource`),
      not_before: zTime("When the delegation starts; default the start of the validity window (for a sub-delegation, not before the parent's start)").optional(),
      not_after: zTime("When the delegation ends; a sub-delegation ends at or before its parent"),
      remaining: z.number().int().min(0).max(3).optional().describe('How many further levels of sub-delegation this delegation allows (default 0: none); its depth plus remaining is at most 4'),
      purpose: zHex32('The purpose: the 32-byte hash (64 hex) of a purpose text or mandate').optional(),
      value_limit: z.object({
        per_tx: z.number().min(0).describe('The most AP3X that one payment may spend'),
        total: z.number().min(0).max(10_000).describe('The most AP3X that the payments of one period may spend together (at most 10,000); at least per_tx'),
        period_ms: z.number().int().min(1).describe('The length of a period in milliseconds, e.g. 86400000 for one day'),
      }).optional().describe("A spending limit; vault payments need one. Under a parent with a limit, the child needs one inside it (per_tx and total at most the parent's, period_ms at least the parent's)"),
      valid_minutes: zValidMinutes,
    },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const delegator = delegatorFrom(args);
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const limit = args.value_limit;
        const r = await buildDelegate({ lucid, provider, deployment }, {
          changeAddress: args.changeAddress, delegator, parent: args.parent?.toLowerCase(), delegate: identifierOf(args.delegate),
          delegateKey: keyHashFrom(args.delegate_key), actions: args.actions, resources: args.resources, notBefore: args.not_before, notAfter: args.not_after,
          remaining: args.remaining, purpose: args.purpose,
          value: limit === undefined ? undefined : { perTx: apexToLovelace(limit.per_tx), total: apexToLovelace(limit.total), periodMs: limit.period_ms },
          validMinutes: args.valid_minutes,
        });
        const d = r.delegation;
        const who = d.delegator.type === 'PrincipalKey'
          ? `principal key ${d.delegator.hash}${d.delegator.organisation === null ? '' : ` for ${cell(textOf(d.delegator.organisation) ?? d.delegator.organisation, 64)}`}`
          : didOf(d.delegator.id);
        const facts: Array<[string, string]> = [
          ['Delegation', `${r.id} (from the seed ${r.seed}: if that output is spent first, build again for a new identifier)`],
          ['Delegator', who],
          ['Delegate', `${didOf(d.delegate)}, delegate key ${d.delegateKey}`],
          ['Chain', d.parent === null ? 'root delegation (depth 1)' : `sub-delegation of ${d.parent} (depth ${d.depth})`],
          ['Actions', patternsOf(d.actions).map((p) => cell(p, 120)).join(', ')],
          ['Resources', d.resources.length === 0 ? 'none (covers no resource)' : patternsOf(d.resources).map((p) => cell(p, 120)).join(', ')],
          ['Period', `${isoOrRaw(d.notBefore)} to ${isoOrRaw(d.notAfter)}`],
          ['Further levels', String(d.remaining)],
        ];
        if (d.value !== null) facts.push(['Value limit', `${lovelaceToAda(d.value.perTx)} AP3X per payment, ${lovelaceToAda(d.value.total)} AP3X per period of ${d.value.periodMs} ms`]);
        if (d.purpose !== null) facts.push(['Purpose', d.purpose]);
        facts.push(['Delegation output', `#${r.outputIndex} at ${deployment.delegation.address}, ${lovelaceToAda(r.outputLovelace)} AP3X (the ledger minimum; undelegate returns it)`]);
        return text(buildText('Delegation Built', facts, r, {
          delegation: r.id, seed: r.seed,
          delegator: d.delegator.type === 'PrincipalKey'
            ? { principal_key_hash: d.delegator.hash, organisation: d.delegator.organisation === null ? null : textOf(d.delegator.organisation) }
            : { agent_did: didOf(d.delegator.id) },
          delegate_did: didOf(d.delegate), delegate_key_hash: d.delegateKey, parent: d.parent, depth: d.depth, remaining: d.remaining,
          actions: patternsOf(d.actions), resources: patternsOf(d.resources), not_before: d.notBefore, not_after: d.notAfter,
          value_limit: d.value === null ? null : { per_tx_lovelace: d.value.perTx, total_lovelace: d.value.total, period_ms: d.value.periodMs },
          purpose: d.purpose, delegation_output_index: r.outputIndex, delegation_lovelace: r.outputLovelace,
        }));
      } catch (err) {
        return fail('build delegation', err, [
          PROFILE_TIP,
          'The delegate key must be listed with the delegation purpose in the delegate record and unused by other live delegations; one agent holds at most one live delegation per listed key',
          FUNDS_TIP,
        ]);
      }
    },
  );

  server.tool(
    'vector_build_delegation_undelegate',
    'Build an UNSIGNED transaction that ends a delegation (Part 2 Section 5.2): it burns the delegation token and returns its AP3X to your wallet. Every delegation below it becomes unusable at once. ' +
      "The delegator signs: the delegator of this delegation or of an ancestor (a principal key, or a delegator agent's controller or delegation key). Takes no key material.",
    {
      changeAddress: zChangeAddress,
      delegation: zHex32('The delegation to end: its identifier (the token name, 64 hex)'),
      signer: zKeyRef("The key that signs: the delegator's key of this delegation or of an ancestor. Default: this delegation's delegator (its principal key, or its agent's controller)").optional(),
      valid_minutes: zValidMinutes,
    },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const r = await buildUndelegate({ lucid, provider, deployment }, {
          changeAddress: args.changeAddress, id: args.delegation.toLowerCase(), signer: args.signer === undefined ? undefined : keyHashFrom(args.signer),
          validMinutes: args.valid_minutes,
        });
        const facts: Array<[string, string]> = [
          ['Delegation', r.id],
          ['Delegate', `${didOf(r.delegation.delegate)}, delegate key ${r.delegation.delegateKey}`],
          ['Signed by', `${cell(r.authority, 200)}${r.authorityLink === 0 ? '' : ` (an ancestor ${r.authorityLink} level${r.authorityLink === 1 ? '' : 's'} up)`}`],
          ['Released', `${lovelaceToAda(r.releasedLovelace)} AP3X return to the wallet (less the fee)`],
          ['Effect', 'the delegation and every delegation below it become unusable at once'],
        ];
        return text(buildText('Undelegation Built', facts, r, {
          delegation: r.id, action: 'Undelegate', authority: r.authority, authority_link: r.authorityLink, released_lovelace: r.releasedLovelace,
        }));
      } catch (err) {
        return fail('build undelegation', err, [PROFILE_TIP, FUNDS_TIP]);
      }
    },
  );
}
