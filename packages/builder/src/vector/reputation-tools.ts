// packages/builder/src/vector/reputation-tools.ts
// The reputation family: keyless builders for an agent's Module-3 self-stake on the identity-era deployment, and a read of stakes. A stake
// takes two builds (step 1 locks an opening output, step 2 is CreateStake); the owner then adds AP3X, replaces the staked capabilities, or
// takes AP3X out down to the module minimum. Each build tool takes a wallet address and returns unsigned CBOR with every key hash that
// must sign it; nothing here signs or submits. The build tools find the agent's record through the identity registry of this server and refuse
// when it is not configured, or when it is not the registry that the reputation validator reads. All six tools refuse a node that is not on Vector mainnet.
// Same conventions as the other families: the node comes from `providerFor`, the rate limiter is the caller's, and a test can hand in its own.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { lovelaceToAda, apexToLovelace } from '@apexfusion/vector-mcp-shared/tx';
import { limiterFor } from './rate-limiter.js';
import type { RateLimiter } from './rate-limiter.js';
import { lucidForAddress } from './build.js';
import { withJson } from './marketplace-indexer.js';
import { text, fail, cell, isoOrRaw, rateGate } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { DeploymentFor } from './identity-tools.js';
import { zChangeAddress, zDid, zKeyHash, zValidMinutes, buildText } from './identity-shared.js';
import { assertVectorMainnet, buildStakeCreate, buildStakeOpening, stakeAgentId } from './reputation-build.js';
import { buildStakeCapabilities, buildStakeDecrease, buildStakeIncrease } from './reputation-actions.js';
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH } from './reputation-datum.js';
import { MAX_AGENTS_PER_READ, readStakes } from './reputation-read.js';

function newProvider(): Provider { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }

const zAgent = zDid('the agent that stakes: its identity DID, did:vector:<64 hex>. A DID of the legacy registry is refused');
const zCapabilities = z.array(z.string().min(1).max(64)).min(1).max(16).describe("Capabilities to stake on, as text: each must be one that the agent's identity record lists, byte for byte (vector_get_agent_profile shows them); for a supplier, the capability_id of its advert");
const zOwnerKey = zKeyHash("The owner credential of the stake: a key that the agent's record declares (its controller key, or a listed key with the transaction purpose); it signs. Default your wallet key").optional();
const zStakeRef = z.string().optional().describe("The stake output '<txid>#<index>' to act on. Needed only when the agent has more than one stake");
const zAp3x = (what: string) => z.number().positive().describe(`${what}, in AP3X`);

/** Where the read tool gets its data: the Koios URL and the fetch it calls (a test hands in its own). */
export interface ReputationReadAccess { koiosUrl: string; fetchImpl: typeof fetch }

const ap3x = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} AP3X`;
const capabilitiesLine = (capabilities: string[]): string => capabilities.map((c) => `\`${cell(c)}\``).join(', ');
const MINIMUM_STAYS = "The owner cannot withdraw the module minimum.";

/**
 * Registers the six reputation tools. The server passes only `server` and `identity`; `providerFor`, `limiter`, `deploymentFor` (the identity
 * registry of the server's environment) and `access` are for tests, as for the other families.
 */
export function registerReputationTools(
  server: McpServer, identity: string,
  providerFor: () => Provider = newProvider, limiter: Pick<RateLimiter, 'check'> = limiterFor(identity),
  deploymentFor: DeploymentFor = requireIdentityDeployment,
  access: ReputationReadAccess = { koiosUrl: VECTOR_KOIOS_URL, fetchImpl: fetch },
) {
  const checkRateLimit: RateGate = rateGate(limiter);
  /** The start of every build handler: the rate gate, then the node, the wallet-bound Lucid and the identity registry of this server. */
  const context = async (changeAddress: string) => {
    const deployment = deploymentFor();
    const provider = providerFor();
    return { lucid: await lucidForAddress(provider, changeAddress), provider, deployment };
  };

  server.tool(
    'vector_build_reputation_stake_open',
    "Build step 1 of 2 of an agent's Module-3 reputation self-stake: an UNSIGNED transaction that locks an opening output at the reputation validator, naming the agent and the capabilities to stake on. The agent is an identity DID (did:vector:<64 hex>) whose record is Active and lists each capability; the owner key (default your wallet key) must be the record's controller key or a key it lists with the transaction purpose. It refuses when the agent already has a stake, and it checks that your wallet can pay step 2. It also refuses when an opening output that names the agent is already at the reputation address: step 2 can spend any of them with any owner key that the record declares, and the refusal lists them with their AP3X and owner (at most 5, those whose owner the record declares first). allow_second_opening builds a new opening output all the same. Only the wallet signs, and no script runs in this step. Only step 2 (vector_build_reputation_stake) can spend the opening output: it needs the agent's controller key and the owner key to sign, and the record must be Active. When step 2 never runs, the opening output stays locked. The answer names the owner_key_hash and the amount to pass to step 2. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      did: zAgent,
      capabilities: zCapabilities,
      owner_key_hash: zOwnerKey,
      amount: zAp3x('The stake that step 2 will lock; only used to check that the wallet can pay it (default the module minimum, 10 AP3X)').optional(),
      allow_second_opening: z.boolean().optional().describe('Build a new opening output although one that names the agent is already at the reputation address. Use it only when step 2 cannot use the one that exists; each opening output locks its AP3X until a CreateStake spends it. Default false: the tool refuses and lists the opening outputs'),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const ctx = await context(a.changeAddress);
        const r = await buildStakeOpening(ctx, {
          changeAddress: a.changeAddress, did: a.did, capabilities: a.capabilities, ownerKeyHash: a.owner_key_hash?.toLowerCase(),
          stakeLovelace: a.amount === undefined ? undefined : apexToLovelace(a.amount), allowSecondOpening: a.allow_second_opening, validMinutes: a.valid_minutes,
        });
        const amount = Number(r.stakeLovelace) / 1_000_000;
        const others: Array<[string, string]> = r.otherOpenings.length === 0
          ? []
          : [['Other opening outputs', `${r.otherOpenings.map((ref) => `\`${ref}\``).join(', ')}${r.otherOpeningsMore > 0 ? ` and ${r.otherOpeningsMore} more` : ''} (each locks its AP3X until a CreateStake spends it)`]];
        const facts: Array<[string, string]> = [
          ['Step', '1 of 2, the opening output (step 2 is vector_build_reputation_stake)'],
          ['Opening ref (after submit)', `\`${r.openingRef}\``],
          ['Agent', `\`${r.did}\``],
          ['Owner key', `\`${r.ownerKeyHash}\``],
          ['Capabilities', capabilitiesLine(r.capabilities)],
          ['Locked', `${ap3x(r.lovelace)} at the reputation address. Only step 2 can spend it; when step 2 never runs, it stays locked`],
          ...others,
          ['Collateral kept aside', r.collateralKept ? 'yes' : 'no'],
          ['Stake for step 2', `${ap3x(r.stakeLovelace)} (the wallet was checked for this amount)`],
          ['Step 2 needs', 'the controller key of the agent and the owner key to sign, and the record to be Active over its window'],
        ];
        const warning = r.collateralKept ? '' : '**Warning:** no pure 5 AP3X output was kept aside; step 2 runs a script and needs one as collateral, so make sure the wallet still has one afterwards.\n\n';
        const note = `${warning}Once it confirms, call vector_build_reputation_stake with opening_ref \`${r.openingRef}\`, the same did and capabilities, owner_key_hash \`${r.ownerKeyHash}\` and amount ${amount}.`;
        return text(buildText('Reputation Stake Opening Built', facts, r, {
          opening_ref: r.openingRef, did: r.did, owner_key_hash: r.ownerKeyHash, capabilities: r.capabilities, lovelace: r.lovelace, collateral_kept: r.collateralKept, other_openings: r.otherOpenings, other_openings_more: r.otherOpeningsMore,
          step_2: { opening_ref: r.openingRef, did: r.did, capabilities: r.capabilities, owner_key_hash: r.ownerKeyHash, amount },
        }, note));
      } catch (err) {
        return fail('build stake opening', err, [
          "did must be an identity DID (did:vector:<64 hex>) whose record is Active and lists each capability (vector_get_agent_profile shows them)",
          "The owner key must be the record's controller key or a key it lists with the transaction purpose",
          'When an opening output already names the agent, pass it to vector_build_reputation_stake as opening_ref; allow_second_opening builds another one',
          'The wallet needs the opening output, the stake (the module minimum, 10 AP3X, or more), about 1.5 AP3X of fees for the two steps, and one pure 5 AP3X output as collateral for step 2',
        ]);
      }
    },
  );

  server.tool(
    'vector_build_reputation_stake',
    `Build step 2 of 2 of an agent's Module-3 reputation self-stake (CreateStake): an UNSIGNED transaction that consumes the opening output from vector_build_reputation_stake_open, mints the agent's stake token and locks the stake behind the named capabilities. The stake is at least the module minimum (read from the module's parameters: 10 AP3X); amount locks more. The owner of the stake is owner_key_hash when you pass it, else the owner key that step 1 named in the opening output, which the record must declare now. The validator reads the owner of the stake, not the owner in the opening output, so the answer says when the stake gets another owner than the opening output names. The agent's controller key and the owner key sign, and the wallet pays the fee; the build lists each key hash with its role. The stake time (last_updated) is the end of the validity window, and the stake can be decreased or its capabilities changed one cooldown after it (stake_cooldown, 24 h in the deployed parameters). ${MINIMUM_STAYS} Each agent has one stake through these tools: a second create is refused, and the refusal names the stake and vector_build_reputation_stake_increase. Takes no key material.`,
    {
      changeAddress: zChangeAddress,
      did: zAgent,
      capabilities: zCapabilities,
      opening_ref: z.string().describe("The CONFIRMED opening output '<txid>#<index>' that vector_build_reputation_stake_open returned"),
      owner_key_hash: zOwnerKey.describe("The owner of the stake: a key that the agent's record declares (its controller key, or a listed key with the transaction purpose); it signs. Default: the owner key that the opening output names, when the record declares that key now"),
      amount: zAp3x('The stake to lock: at least the module minimum, which is the default').optional(),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const ctx = await context(a.changeAddress);
        const r = await buildStakeCreate(ctx, {
          changeAddress: a.changeAddress, did: a.did, capabilities: a.capabilities, openingRef: a.opening_ref, ownerKeyHash: a.owner_key_hash?.toLowerCase(),
          amountLovelace: a.amount === undefined ? undefined : apexToLovelace(a.amount), validMinutes: a.valid_minutes,
        });
        const differs: Array<[string, string]> = r.ownerKeyHash === r.openingOwnerKeyHash
          ? []
          : [['Owner differs from the opening output', `the opening output named \`${r.openingOwnerKeyHash}\`; the stake gets \`${r.ownerKeyHash}\`, because you passed owner_key_hash; the validator reads the owner of the stake, not the owner in the opening output`]];
        const facts: Array<[string, string]> = [
          ['Step', '2 of 2, CreateStake'],
          ['Stake ref (after submit)', `\`${r.stakeRef}\``],
          ['Agent', `\`${r.did}\``],
          ['Owner key', `\`${r.ownerKeyHash}\``],
          ...differs,
          ['Controller key', `\`${r.controllerKeyHash}\``],
          ['Capabilities', capabilitiesLine(r.capabilities)],
          ['Stake locked', `${ap3x(r.stakeLovelace)} with the stake token \`${r.tokenUnit}\``],
          ['Consumes', `the opening output \`${r.openingRef}\` (its AP3X return as change)`],
          ['Stake time (last_updated)', isoOrRaw(r.lastUpdated)],
          ['Next change', `a decrease or a capability update from ${isoOrRaw(r.readyAt)} (cooldown of ${(r.readyAt - r.lastUpdated) / 3_600_000} h after last_updated)`],
          ['Module minimum', `${ap3x(r.minSelfStake)}. ${MINIMUM_STAYS}`],
        ];
        return text(buildText('Reputation Stake Built', facts, r, {
          stake_ref: r.stakeRef, stake_id: r.stakeId, opening_ref: r.openingRef, did: r.did, owner_key_hash: r.ownerKeyHash, opening_owner_key_hash: r.openingOwnerKeyHash, controller_key_hash: r.controllerKeyHash,
          capabilities: r.capabilities, stake_lovelace: r.stakeLovelace, token_unit: r.tokenUnit, last_updated: r.lastUpdated, ready_at: r.readyAt, min_self_stake: r.minSelfStake,
        }));
      } catch (err) {
        return fail('build reputation stake', err, [
          'opening_ref must be the confirmed output of vector_build_reputation_stake_open for the same agent (vector_await_transaction waits for it)',
          'The agent record must be Active over the whole validity window and list each capability; a smaller valid_minutes keeps the window short',
          "The owner key (owner_key_hash, else the owner that the opening output names) must be the record's controller key or a key it lists with the transaction purpose, and both that key and the controller must sign",
          'The wallet needs the stake plus about 1 AP3X for the fee, and one pure 5 AP3X output as collateral',
        ]);
      }
    },
  );

  server.tool(
    'vector_build_reputation_stake_increase',
    "Build an UNSIGNED transaction that adds AP3X to an agent's Module-3 stake (IncreaseStake). The stake keeps its capabilities and its challenge locks and records a new last_updated (the end of the validity window). No cooldown applies. The agent's record must be Active and list each capability that the stake backs now; the agent's controller key and the stake's owner key sign, and the wallet pays the AP3X and the fee. Name the stake with stake_ref when the agent has more than one. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      did: zAgent,
      amount: zAp3x('The AP3X to add to the stake'),
      stake_ref: zStakeRef,
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const ctx = await context(a.changeAddress);
        const r = await buildStakeIncrease(ctx, { changeAddress: a.changeAddress, did: a.did, addLovelace: apexToLovelace(a.amount), stakeRef: a.stake_ref, validMinutes: a.valid_minutes });
        const facts: Array<[string, string]> = [
          ['Stake ref (after submit)', `\`${r.stakeRef}\` (replaces \`${r.previousRef}\`)`],
          ['Agent', `\`${r.did}\``],
          ['Added', ap3x(r.addedLovelace)],
          ['Stake now', `${ap3x(r.stakeAmount)} counted, ${ap3x(r.stakeLovelace)} in the output`],
          ['Owner key', `\`${r.ownerKeyHash}\``],
          ['Controller key', `\`${r.controllerKeyHash}\``],
          ['Stake time (last_updated)', isoOrRaw(r.lastUpdated)],
          ['Next change', `a decrease or a capability update from ${isoOrRaw(r.readyAt)}`],
        ];
        return text(buildText('Reputation Stake Increase Built', facts, r, {
          stake_ref: r.stakeRef, previous_ref: r.previousRef, stake_id: r.stakeId, did: r.did, added_lovelace: r.addedLovelace, stake_amount: r.stakeAmount, stake_lovelace: r.stakeLovelace,
          owner_key_hash: r.ownerKeyHash, controller_key_hash: r.controllerKeyHash, last_updated: r.lastUpdated, ready_at: r.readyAt,
        }));
      } catch (err) {
        return fail('build stake increase', err, [
          'The agent must already have a stake (vector_get_reputation_stake shows it); name it with stake_ref when there is more than one',
          'The record must be Active over the validity window and list each capability that the stake backs; if it dropped one, change the staked capabilities first with vector_build_reputation_stake_update_capabilities',
          "The stake's owner key and the agent's controller key must both sign",
        ]);
      }
    },
  );

  server.tool(
    'vector_build_reputation_stake_update_capabilities',
    "Build an UNSIGNED transaction that replaces the capabilities that an agent's Module-3 stake backs (UpdateCapabilities). Each new capability must be one that the agent's record lists; the list cannot be empty. The cooldown of the stake (stake_cooldown, 24 h in the deployed parameters, counted from its last_updated) must be over, and no open challenge may lock the stake. Naming the same list again is allowed: it only records a new last_updated. The agent's controller key and the stake's owner key sign, and the wallet pays the fee. Name the stake with stake_ref when the agent has more than one. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      did: zAgent,
      capabilities: zCapabilities,
      stake_ref: zStakeRef,
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const ctx = await context(a.changeAddress);
        const r = await buildStakeCapabilities(ctx, { changeAddress: a.changeAddress, did: a.did, capabilities: a.capabilities, stakeRef: a.stake_ref, validMinutes: a.valid_minutes });
        const facts: Array<[string, string]> = [
          ['Stake ref (after submit)', `\`${r.stakeRef}\` (replaces \`${r.previousRef}\`)`],
          ['Agent', `\`${r.did}\``],
          ['Capabilities now', capabilitiesLine(r.capabilities)],
          ['Capabilities before', capabilitiesLine(r.previousCapabilities)],
          ['Stake', `${ap3x(r.stakeAmount)} counted, unchanged`],
          ['Owner key', `\`${r.ownerKeyHash}\``],
          ['Controller key', `\`${r.controllerKeyHash}\``],
          ['Stake time (last_updated)', isoOrRaw(r.lastUpdated)],
          ['Next change', `a decrease or a capability update from ${isoOrRaw(r.readyAt)}`],
        ];
        return text(buildText('Reputation Stake Capabilities Built', facts, r, {
          stake_ref: r.stakeRef, previous_ref: r.previousRef, stake_id: r.stakeId, did: r.did, capabilities: r.capabilities, previous_capabilities: r.previousCapabilities,
          stake_amount: r.stakeAmount, owner_key_hash: r.ownerKeyHash, controller_key_hash: r.controllerKeyHash, last_updated: r.lastUpdated, ready_at: r.readyAt,
        }));
      } catch (err) {
        return fail('build capability update', err, [
          'The cooldown (stake_cooldown) must be over: it counts from the last change of the stake (the refusal gives the time)',
          "Each capability must be one that the agent's record lists, and the record must be Active over the validity window",
          'No open challenge may lock the stake',
        ]);
      }
    },
  );

  server.tool(
    'vector_build_reputation_stake_decrease',
    "Build an UNSIGNED transaction that takes AP3X out of an agent's Module-3 stake (DecreaseStake), down to the module minimum. The cooldown of the stake (stake_cooldown, 24 h in the deployed parameters, counted from its last_updated) must be over, and no open challenge may lock the stake. The AP3X are paid to the stake's owner key while the agent's record still declares it, else to the agent's controller key; the result names the payee. Only the agent's controller key signs (besides the wallet): the owner key need not. The record can have any status, so a revoked or retired agent can exit. " +
    `${MINIMUM_STAYS} Name the stake with stake_ref when the agent has more than one. Takes no key material.`,
    {
      changeAddress: zChangeAddress,
      did: zAgent,
      amount: zAp3x('The AP3X to take out of the stake (the stake keeps at least the module minimum)'),
      stake_ref: zStakeRef,
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const ctx = await context(a.changeAddress);
        const r = await buildStakeDecrease(ctx, { changeAddress: a.changeAddress, did: a.did, amountLovelace: apexToLovelace(a.amount), stakeRef: a.stake_ref, validMinutes: a.valid_minutes });
        const payee = r.payee.reason === 'owner' ? "the stake's owner key" : "the agent's controller key, because the record no longer declares the owner key of the stake";
        const facts: Array<[string, string]> = [
          ['Stake ref (after submit)', `\`${r.stakeRef}\` (replaces \`${r.previousRef}\`)`],
          ['Agent', `\`${r.did}\``],
          ['Taken out', ap3x(r.takenLovelace)],
          ['Paid to', `\`${r.payoutAddress}\` (key \`${r.payee.keyHash}\`, ${payee})`],
          ['Stake keeps', `${ap3x(r.stakeAmount)} counted, ${ap3x(r.stakeLovelace)} in the output (module minimum ${ap3x(r.minSelfStake)})`],
          ['Controller key', `\`${r.controllerKeyHash}\``],
          ['Stake time (last_updated)', isoOrRaw(r.lastUpdated)],
          ['Next change', `a decrease or a capability update from ${isoOrRaw(r.readyAt)}`],
        ];
        return text(buildText('Reputation Stake Decrease Built', facts, r, {
          stake_ref: r.stakeRef, previous_ref: r.previousRef, stake_id: r.stakeId, did: r.did, taken_lovelace: r.takenLovelace, payee_key_hash: r.payee.keyHash, payee_reason: r.payee.reason,
          payout_address: r.payoutAddress, stake_amount: r.stakeAmount, stake_lovelace: r.stakeLovelace, controller_key_hash: r.controllerKeyHash, last_updated: r.lastUpdated, ready_at: r.readyAt,
        }));
      } catch (err) {
        return fail('build stake decrease', err, [
          'The cooldown (stake_cooldown) must be over: it counts from the last change of the stake (the refusal gives the time)',
          'At least the module minimum stays in the stake, and no open challenge may lock it',
          "The agent's controller key must sign; the wallet pays the fee and gives a pure 5 AP3X output as collateral",
        ]);
      }
    },
  );

  server.tool(
    'vector_get_reputation_stake',
    `Read the Module-3 reputation stakes of 1 to ${MAX_AGENTS_PER_READ} agents (identity DIDs) from the chain, with one indexer call. For each agent it lists each stake (output reference, stake_amount, staked capabilities, last_updated, number of challenge locks, stake_id, the AP3X in the output, owner key) and the sum of stake_amount; an agent with no stake has the sum 0. The sum counts stake_amount, which can be less than the AP3X in the output. An agent can have more than one stake. Read-only, no wallet needed.`,
    { dids: z.array(zDid('an agent whose stakes to read')).min(1).max(MAX_AGENTS_PER_READ).describe(`The agents: 1 to ${MAX_AGENTS_PER_READ} identity DIDs (did:vector:<64 hex>)`) },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        await assertVectorMainnet(providerFor());
        const agents = await readStakes(access.koiosUrl, a.dids.map(stakeAgentId), access.fetchImpl);
        const rows = agents.map((g) => `| \`did:vector:${g.agentId}\` | ${g.stakes.length} | ${lovelaceToAda(g.total)} |`).join('\n');
        const details = agents.filter((g) => g.stakes.length > 0).map((g) => `**did:vector:${g.agentId}**, sum ${ap3x(g.total)}:\n` + g.stakes.map((s) =>
          `- \`${s.ref}\`: ${ap3x(s.stakeAmount)} counted (${ap3x(s.lovelace)} in the output); capabilities ${capabilitiesLine(s.capabilities)}; last_updated ${isoOrRaw(s.lastUpdated)}; ` +
          `${s.challengeLocks} challenge lock(s); stake_id \`${s.stakeId}\`; owner \`${s.ownerKeyHash}\``).join('\n')).join('\n\n');
        const md = `# Reputation Stakes\n\n**Reputation policy:** \`${REPUTATION_SCRIPT_HASH}\` (stake address \`${REPUTATION_ADDRESS}\`)\n\n| agent | stakes | sum of stake_amount (AP3X) |\n|---|---|---|\n${rows}` +
          `${details ? `\n\n${details}` : ''}`;
        return text(withJson(md, {
          reputation_policy: REPUTATION_SCRIPT_HASH, stake_address: REPUTATION_ADDRESS,
          agents: agents.map((g) => ({
            did: `did:vector:${g.agentId}`, token_unit: g.tokenUnit, total: g.total,
            stakes: g.stakes.map((s) => ({
              ref: s.ref, stake_amount: s.stakeAmount, lovelace: s.lovelace, capabilities: s.capabilities, last_updated: s.lastUpdated, challenge_locks: s.challengeLocks,
              stake_id: s.stakeId, owner_key_hash: s.ownerKeyHash, history_points: s.historyPoints,
            })),
          })),
        }));
      } catch (err) {
        return fail('read reputation stakes', err, [
          `dids must be identity DIDs (did:vector:<64 hex>), at most ${MAX_AGENTS_PER_READ}`,
          'The read needs the Koios indexer and a node on Vector mainnet',
        ]);
      }
    },
  );
}
