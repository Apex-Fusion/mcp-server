// packages/builder/src/vector/reputation-tools.ts
// The reputation family: keyless builders for an agent's Module-3 self-stake, in two steps as the reference SDK makes it (step 1 locks
// the opening output, step 2 creates the stake). Each takes a wallet address only and returns unsigned CBOR for the local signer;
// nothing here signs or submits. Same conventions as the marketplace family: the node comes from `providerFor` and the rate limiter
// is the caller's, so a test can hand in a fixture node and a limiter of its own.
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
import { buildStakeOpening, buildStake } from './reputation-build.js';

function newProvider() { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }

/**
 * What becomes of a stake at the module's minimum under the deployed validator, in the one wording both tools and the README use. The
 * module's time parameters are in slots and the validator compares them with POSIX milliseconds, so its activity window is about 163 s.
 */
const LOCKED = 'As deployed, the owner cannot withdraw a stake at the module\'s minimum; the module\'s oracle key can consume all of it through ClaimDecayRefund about 163 s after its last update; and a falsified capability slashes 1/N of it, where N is the number of staked capabilities (all of it when N = 1).';
/** The deployed module is to be fixed and redeployed, which changes the script hash and the reference outputs these tools name; until then the tools are held. */
const HOLD = 'Do not use on mainnet until the Module-3 reputation module is fixed and redeployed.';
const AGENT_ID = z.string().describe("Agent DID: did:vector:agent:{policyId}:{nftAssetName}, as vector_build_register_agent returned it");
const CAPABILITIES = z.array(z.string().min(1)).min(1).describe("Capabilities to stake on: each must be one the agent's registry record lists, exactly (vector_get_agent_profile shows them); for a supplier, the capability_id of its advert");

/**
 * Registers the two reputation tools. The server passes only `server` and `identity`; `provider` and `limiter` are for tests, as for
 * registerMarketplaceTools.
 */
export function registerReputationTools(
  server: McpServer, identity: string,
  providerFor: () => Provider = newProvider, limiter: Pick<RateLimiter, 'check'> = limiterFor(identity),
) {
  const checkRateLimit = rateGate(limiter);

  server.tool(
    "vector_build_reputation_stake_open",
    `${HOLD} Build an UNSIGNED transaction that opens a reputation self-stake for your registered agent on Vector (step 1 of 2): locks a 2-unit opening output at the reputation (Module-3) validator, naming the agent and the capabilities to stake on. The validator mints a stake token only when it consumes an output of its own, so step 2, vector_build_reputation_stake, consumes this one and the 2 units return as change. Checked first: the agent's registry record lists every capability, changeAddress is the record's owner (the same key a supplier's adverts name), the agent has no stake yet, the node's clock is Vector mainnet's, and the wallet also holds what step 2 needs (the module's minimum, about 1 unit of fees and a pure 5-unit output for collateral). An agent that already has an opening output is pointed at it instead. ${LOCKED} Mainnet only. Takes no key material. ` + SIGN_COPY,
    {
      changeAddress: z.string().describe("The agent owner's wallet address (the wallet that registered the agent). Get it from vector_signer_get_address."),
      agent_id: AGENT_ID,
      capabilities: CAPABILITIES,
    },
    async ({ changeAddress, agent_id, capabilities }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildStakeOpening(lucid, provider, { changeAddress, agentId: agent_id, capabilities });
        const warning = r.collateralKept ? '' : '\n**Warning:** no pure 5-unit output was kept aside; step 2 runs a script and needs one as collateral, so make sure the wallet still has one afterwards.';
        const md = `# Unsigned Stake Opening Built (Not Submitted), step 1 of 2\n\n**Hold:** ${HOLD}\n\n` +
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
          'The wallet needs the 2-unit opening output, the module\'s minimum for step 2 (10 units today), about 1 unit of fees, and one pure 5-unit output as collateral for step 2',
        ]);
      }
    },
  );

  server.tool(
    "vector_build_reputation_stake",
    `${HOLD} Build an UNSIGNED transaction that creates your agent's reputation self-stake on Vector (step 2 of 2): consumes the opening output from vector_build_reputation_stake_open, mints the agent's stake token and locks the module's minimum self-stake (read from the module's parameters on the ledger; 10 units on mainnet today) behind the named capabilities, with your key as its owner. ${LOCKED} The stake's time is the ledger's tip: sign and submit before the Valid until time the result shows. Mainnet only. Takes no key material. ` + SIGN_COPY,
    {
      changeAddress: z.string().describe("The SAME owner wallet address used in step 1. Get it from vector_signer_get_address."),
      agent_id: AGENT_ID,
      capabilities: CAPABILITIES,
      opening_ref: z.string().describe("The CONFIRMED opening output '<txid>#0' that vector_build_reputation_stake_open returned"),
    },
    async ({ changeAddress, agent_id, capabilities, opening_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildStake(lucid, provider, { changeAddress, agentId: agent_id, capabilities, openingRef: opening_ref });
        const md = `# Unsigned Reputation Stake Built (Not Submitted), step 2 of 2\n\n**Hold:** ${HOLD}\n\n` +
          `**Stake ref (after submit):** \`${r.stakeRef}\`\n**Agent:** \`${cell(agent_id, 160)}\`\n**Owner key:** \`${r.ownerPkh}\`\n` +
          `**Capabilities:** ${r.capabilities.map((c) => `\`${cell(c)}\``).join(', ')}\n` +
          `**Stake locked:** ${lovelaceToAda(r.stakeLovelace)} with stake token \`${r.tokenUnit}\`. ${LOCKED}\n` +
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
          'The wallet needs the stake (10 units today) plus about 1 unit for fees, and one pure 5-unit output as collateral',
        ]);
      }
    },
  );
}
