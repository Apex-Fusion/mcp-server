// packages/builder/src/vector/marketplace-build-tools.ts
// The marketplace build tools: keyless builders for the unsigned escrow Post, Accept and Reclaim. Each takes a wallet address
// only and returns unsigned CBOR for the local signer; nothing here signs or submits. The node they build against comes from
// `providerFor`, so the entry point decides it (and a test can hand in a fixture).
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { withJson } from './marketplace-indexer.js';
import { buildPostEscrow, buildAccept, buildReclaim, supplierPayoutRaised } from './marketplace-build.js';
import { text, fail, cell, isoOrRaw, SIGN_COPY, ACCEPT_WINDOW_S, RELEASE_TAKE } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';

/** A payout below the minimum output is raised to it (planAccept, planReclaim); the signer is told, as it is shown more than the datum owes. */
const raised = (flag: boolean): string => (flag ? ' (raised to the 1-unit minimum)' : '');

export function registerMarketplaceBuildTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider) {
  server.tool(
    "vector_build_marketplace_post_escrow",
    "Build an UNSIGNED transaction that hires a supplier on the Vector agents marketplace: locks price + supplier bond + buyer bond in escrow for the given advert and commits a hash of your payload. Template-contract suppliers only in this release. Takes no key material. After it confirms, call vector_marketplace_send_job with the returned escrow_ref, the same payload (the JSON block echoes it verbatim) and your wallet address as buyerAddress. The transaction is valid for at most 180 s, so sign and submit it at once. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("Your wallet address (pays the lock and fees; receives the bond back on Accept). Get it from vector_signer_get_address."),
      advert_ref: z.string().describe("Advert '<txid>#<index>' from vector_marketplace_list_suppliers"),
      payload: z.string().min(1).describe("The job payload string exactly as you will send it (for JSON, pass the JSON text)"),
      deliver_by_ms: z.number().int().optional().describe("Optional POSIX ms deadline; default now + advert window + 180 s"),
    },
    async ({ changeAddress, advert_ref, payload, deliver_by_ms }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildPostEscrow(lucid, provider, { changeAddress, advertRef: advert_ref, payload, deliverByMs: deliver_by_ms });
        const deliverBy = isoOrRaw(r.deliverBy);
        // planAccept raises a supplier payout below the minimum output to it, and the raise comes out of the buyer's side: said here, before the Post is signed.
        const supplierRaise = supplierPayoutRaised(r.priceLovelace, r.supplierBondLovelace) ? ' (the supplier payout is raised to the 1-unit minimum out of your return)' : '';
        // supplierPkh, endpointHost and capabilityId come out of an advert, which anyone can write: all three go through cell().
        const warning = r.collateralKept ? '' : '\n**Warning:** no pure 5-unit output was kept aside for the Accept/Reclaim script spends; make sure your wallet still has one afterwards (the change of this Post counts if it is a pure output of at least 5 units).';
        const md = `# Unsigned Escrow Post Built (Not Submitted)\n\n` +
          `**Hiring:** \`${cell(r.capabilityId)}\` from supplier key \`${cell(r.supplierPkh)}\`, endpoint host \`${cell(r.endpointHost)}\`\n` +
          `**Escrow ref (after submit):** \`${r.escrowRef}\`\n` +
          `**Locked:** ${lovelaceToAda(r.lockLovelace)} = price ${lovelaceToAda(r.priceLovelace)} + supplier bond ${lovelaceToAda(r.supplierBondLovelace)} + buyer bond ${lovelaceToAda(r.buyerBondLovelace)} (floored to the min-UTxO of the Submitted datum). ` +
          // escrow.ak: Accept pays the supplier price + supplier bond and the buyer its bond; once the window has passed, Release lets the supplier take at least all three (a floor, not a ceiling)
          `If the supplier submits, accept within ${ACCEPT_WINDOW_S} s: it receives price + supplier bond and your buyer bond (plus any floor excess) returns${supplierRaise}. ` +
          `Miss that window and the supplier may Release and ${RELEASE_TAKE}. ` +
          `If it never submits, Reclaim after ${deliverBy} returns everything.\n` +
          `**Deliver by:** ${deliverBy}\n**Valid until:** ${isoOrRaw(r.validTo)} (sign and submit before then: a Post that landed later would give the supplier less than its window, so it is not valid after this time and has to be built again)\n` +
          `**Payload hash:** \`${r.promptHash}\`\n**Estimated fee:** ${r.feeAda}\n**Collateral kept aside:** ${r.collateralKept ? 'yes' : 'no'}${warning}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\nKeep the payload byte-identical for vector_marketplace_send_job (the JSON block below carries it verbatim). ${SIGN_COPY}`;
        // `payload` is echoed as given: an assistant that carries the block from here to vector_marketplace_send_job sends the committed bytes.
        return text(withJson(md, { escrow_ref: r.escrowRef, lock_lovelace: r.lockLovelace, deliver_by: r.deliverBy, valid_to: r.validTo, prompt_hash: r.promptHash, payload, tx_hash: r.txHash, fee: r.fee, collateral_kept: r.collateralKept }));
      } catch (err) { return fail('build escrow post', err, ['The wallet needs the lock plus about 1 unit for fees, and one pure 5-unit output kept as collateral', 'Check the advert is still Active with vector_marketplace_get_supplier']); }
    },
  );

  server.tool(
    "vector_build_marketplace_accept",
    "Build an UNSIGNED transaction that accepts a Submitted marketplace job: pays the supplier price + supplier bond and returns your buyer bond. Only the buyer can accept, within 600 s of the supplier's Submit. If a receipt has arrived, verify it first with vector_marketplace_verify_receipt. It builds only for a Submitted escrow and prints the seconds left in the window, so it is also the way to check where an escrow stands (vector_marketplace_get_job cannot see where it stands now): a refusal names the state when one was found. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("The buyer wallet address that posted the escrow"),
      escrow_ref: z.string().describe("The escrow_ref returned by vector_build_marketplace_post_escrow"),
    },
    async ({ changeAddress, escrow_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildAccept(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref });
        const warn = r.secondsLeft < 120 ? `\n\n**Hurry:** only ${r.secondsLeft} s remain in the accept window.` : '';
        // The escrow is named by its canonical ref, and the key the Accept pays by the datum the lineage resolved (not by what the caller typed).
        const md = `# Unsigned Accept Built (Not Submitted)\n\n**Escrow:** \`${r.escrowRef}\`\n` +
          `**Supplier receives:** ${lovelaceToAda(r.supplierLovelace)}${raised(r.supplierRaised)} at supplier key \`${cell(r.supplierPkh)}\`\n` +
          `**Your bond back:** ${lovelaceToAda(r.buyerLovelace)}${raised(r.buyerRaised)}\n**Estimated fee:** ${r.feeAda}${warn}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref: r.escrowRef, tx_hash: r.txHash, supplier_pkh: r.supplierPkh, supplier_lovelace: r.supplierLovelace, buyer_lovelace: r.buyerLovelace, seconds_left: r.secondsLeft }));
      } catch (err) {
        return fail('build accept', err, [
          'The escrow must be in Submitted state; the refusal above names the state when one was found. If a receipt has arrived, verify it first with vector_marketplace_verify_receipt',
          `Accept must land within ${ACCEPT_WINDOW_S} s of Submit; after that the supplier may Release and ${RELEASE_TAKE}`,
          'The wallet needs one pure 5-unit output as collateral',
        ]);
      }
    },
  );

  server.tool(
    "vector_build_marketplace_reclaim",
    "Build an UNSIGNED transaction that reclaims your escrow after deliver_by when the supplier never submitted (state Open or Claimed): everything returns to you. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("The buyer wallet address that posted the escrow"),
      escrow_ref: z.string().describe("The escrow_ref returned by vector_build_marketplace_post_escrow"),
    },
    async ({ changeAddress, escrow_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildReclaim(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref });
        const md = `# Unsigned Reclaim Built (Not Submitted)\n\n**Escrow:** \`${r.escrowRef}\`\n` +
          `**Returned to you:** ${lovelaceToAda(r.buyerLovelace)}${raised(r.buyerRaised)} (price + supplier bond + buyer bond), and whatever else the escrow holds, as change\n` +
          `**Estimated fee:** ${r.feeAda}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref: r.escrowRef, tx_hash: r.txHash, buyer_lovelace: r.buyerLovelace }));
      } catch (err) {
        return fail('build reclaim', err, [
          'Reclaim opens only after deliver_by',
          `A Submitted escrow cannot be reclaimed: accept within ${ACCEPT_WINDOW_S} s of Submit; after that the supplier may Release and ${RELEASE_TAKE}`,
        ]);
      }
    },
  );
}
