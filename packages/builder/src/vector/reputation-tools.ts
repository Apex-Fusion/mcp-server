// packages/builder/src/vector/reputation-tools.ts
// The reputation family: keyless builders for an agent's Module-3 self-stake, in two steps as the reference SDK makes it (step 1 locks
// the opening output, step 2 creates the stake). The deployment these builders name takes no new stakes (REPUTATION_TAKES_NEW_STAKES),
// so both tools refuse with NO_NEW_STAKES before they read anything; the build path stays for the new Module-3 deployment, and tests
// run it through the `takesNewStakes` setting. Each tool takes a wallet address only and returns unsigned CBOR for the local signer;
// nothing here signs or submits. Same conventions as the marketplace family: the node comes from `providerFor` and the rate limiter is
// the caller's, so a test can hand in a fixture node and a limiter of its own.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { limiterFor } from './rate-limiter.js';
import type { RateLimiter } from './rate-limiter.js';
import { lucidForAddress } from './build.js';
import { withJson } from './marketplace-indexer.js';
import { text, fail, cell, isoOrRaw, rateGate, SIGN_COPY } from './marketplace-shared.js';
import { buildStakeOpening, buildStake, NO_NEW_STAKES, REPUTATION_TAKES_NEW_STAKES } from './reputation-build.js';

function newProvider() { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }

const AGENT_ID = z.string().describe("Agent DID in the legacy registry form: did:vector:agent:{policyId}:{nftAssetName}");
const CAPABILITIES = z.array(z.string().min(1)).min(1).describe("Capabilities to stake on: each must be one the agent's registry record lists, exactly (vector_get_agent_profile shows them); for a supplier, the capability_id of its advert");

/**
 * Registers the two reputation tools. The server passes only `server` and `identity`; `provider`, `limiter` and `takesNewStakes` (the
 * deployment's REPUTATION_TAKES_NEW_STAKES unless a test runs the build path) are for tests, as for registerMarketplaceTools.
 */
export function registerReputationTools(
  server: McpServer, identity: string,
  providerFor: () => Provider = newProvider, limiter: Pick<RateLimiter, 'check'> = limiterFor(identity),
  takesNewStakes: boolean = REPUTATION_TAKES_NEW_STAKES,
) {
  const checkRateLimit = rateGate(limiter);

  server.tool(
    "vector_build_reputation_stake_open",
    `${NO_NEW_STAKES} Until then this tool refuses and builds nothing. It builds step 1 of 2 of a reputation self-stake for your registered agent on Vector: an UNSIGNED transaction that locks a 2-unit opening output at the reputation (Module-3) validator, naming the agent and the capabilities to stake on; step 2 is vector_build_reputation_stake. Takes no key material.`,
    {
      changeAddress: z.string().describe("The agent owner's wallet address (the wallet that registered the agent). Get it from vector_signer_get_address."),
      agent_id: AGENT_ID,
      capabilities: CAPABILITIES,
    },
    async ({ changeAddress, agent_id, capabilities }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      if (!takesNewStakes) return text(`Failed to build stake opening: ${NO_NEW_STAKES}`);
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildStakeOpening(lucid, provider, { changeAddress, agentId: agent_id, capabilities });
        const warning = r.collateralKept ? '' : '\n**Warning:** no pure 5-unit output was kept aside; step 2 runs a script and needs one as collateral, so make sure the wallet still has one afterwards.';
        const md = `# Unsigned Stake Opening Built (Not Submitted), step 1 of 2\n\n` +
          `**Opening ref (after submit):** \`${r.openingRef}\`\n**Agent:** \`${cell(agent_id, 160)}\`\n**Owner key:** \`${r.ownerPkh}\`\n` +
          `**Capabilities:** ${r.capabilities.map((c) => `\`${cell(c)}\``).join(', ')}\n` +
          `**Locked:** ${lovelaceToAda(r.lovelace)} (returns as change when step 2 consumes it)\n` +
          `**Estimated fee:** ${r.feeAda}\n**Collateral kept aside:** ${r.collateralKept ? 'yes' : 'no'}${warning}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY} Once it confirms, call vector_build_reputation_stake with opening_ref \`${r.openingRef}\` and the same agent_id and capabilities.`;
        return text(withJson(md, { opening_ref: r.openingRef, agent_did: r.agentDidHex, owner_pkh: r.ownerPkh, capabilities: r.capabilities, lovelace: r.lovelace, tx_hash: r.txHash, fee: r.fee, collateral_kept: r.collateralKept }));
      } catch (err) {
        return fail('build stake opening', err, [
          'changeAddress must be the agent\'s owner: the wallet that registered it',
          'Each capability must be one the registry record lists (vector_get_agent_profile shows them)',
          'The wallet needs the 2-unit opening output, the module\'s minimum for step 2, about 1 unit of fees, and one pure 5-unit output as collateral for step 2',
        ]);
      }
    },
  );

  server.tool(
    "vector_build_reputation_stake",
    `${NO_NEW_STAKES} Until then this tool refuses and builds nothing. It builds step 2 of 2 of your agent's reputation self-stake on Vector: an UNSIGNED transaction that consumes the opening output from vector_build_reputation_stake_open, mints the agent's stake token and locks the module's minimum self-stake (read from the module's parameters on the ledger) behind the named capabilities, with your key as its owner. Takes no key material.`,
    {
      changeAddress: z.string().describe("The SAME owner wallet address used in step 1. Get it from vector_signer_get_address."),
      agent_id: AGENT_ID,
      capabilities: CAPABILITIES,
      opening_ref: z.string().describe("The CONFIRMED opening output '<txid>#0' that vector_build_reputation_stake_open returned"),
    },
    async ({ changeAddress, agent_id, capabilities, opening_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      if (!takesNewStakes) return text(`Failed to build reputation stake: ${NO_NEW_STAKES}`);
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildStake(lucid, provider, { changeAddress, agentId: agent_id, capabilities, openingRef: opening_ref });
        const md = `# Unsigned Reputation Stake Built (Not Submitted), step 2 of 2\n\n` +
          `**Stake ref (after submit):** \`${r.stakeRef}\`\n**Agent:** \`${cell(agent_id, 160)}\`\n**Owner key:** \`${r.ownerPkh}\`\n` +
          `**Capabilities:** ${r.capabilities.map((c) => `\`${cell(c)}\``).join(', ')}\n` +
          `**Stake locked:** ${lovelaceToAda(r.stakeLovelace)} with stake token \`${r.tokenUnit}\`\n` +
          `**Consumes:** opening output \`${r.openingRef}\` (its lovelace returns as change)\n` +
          `**Stake time (last_updated):** ${isoOrRaw(r.lastUpdated)}\n**Valid until:** ${isoOrRaw(r.validTo)} (sign and submit before then, or build it again)\n` +
          `**Estimated fee:** ${r.feeAda}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, {
          stake_ref: r.stakeRef, opening_ref: r.openingRef, agent_did: r.agentDidHex, owner_pkh: r.ownerPkh, capabilities: r.capabilities,
          stake_lovelace: r.stakeLovelace, token_unit: r.tokenUnit, last_updated: r.lastUpdated, valid_to: r.validTo, tx_hash: r.txHash, fee: r.fee,
        }));
      } catch (err) {
        return fail('build reputation stake', err, [
          'opening_ref must be the confirmed output of vector_build_reputation_stake_open for the same agent',
          'changeAddress must be the agent\'s owner, and each capability one its registry record lists',
          'The wallet needs the stake (the module\'s minimum) plus about 1 unit for fees, and one pure 5-unit output as collateral',
        ]);
      }
    },
  );
}
