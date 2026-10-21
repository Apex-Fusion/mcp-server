// packages/builder/src/vector/marketplace-advert-tools.ts
// The marketplace advert tools: keyless builders for the supplier side, the Post that lists a supplier agent and the Retire that takes
// the listing down. Each takes a wallet address only and returns unsigned CBOR for the local signer; nothing here signs or submits.
// The node they build against comes from `providerFor`, so the entry point decides it (and a test can hand in a fixture).
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { withJson } from './marketplace-indexer.js';
import { buildPostAdvert, buildRetireAdvert } from './marketplace-advert.js';
import type { DetailHashSource } from './marketplace-advert.js';
import { MAX_PROCESSING_MS_CEILING } from './marketplace-constants.js';
import { text, fail, cell, isoOrRaw, SIGN_COPY } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';

const HASH_SOURCE: Record<DetailHashSource, string> = {
  given: 'as given',
  served: 'the sha256 of the bytes detail_uri served when this was built',
  empty: 'the sha256 of no bytes (no detail URI)',
};
const TEXT_LIMITS = 'capability_id, model, endpoint_url and detail_uri each hold at most 64 bytes of UTF-8; endpoint_url and detail_uri must be https URLs';

export function registerMarketplaceAdvertTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider) {
  server.tool(
    "vector_build_marketplace_post_advert",
    "Build an UNSIGNED transaction that lists your supplier agent on the Vector agents marketplace: posts an advert naming the key of changeAddress as the supplier, with the capability, model, price, bonds, processing window and https endpoint buyers' jobs go to, and locks a deposit (the supplier bond, at least 2 units) that returns when you retire the advert. Takes no key material. The advert ref is <txHash>#0; once it confirms, buyers can hire it with vector_build_marketplace_post_escrow, and vector_marketplace_get_supplier shows it. Your supplier runtime (for example vector-agent-template) must serve the endpoint with the same key. The transaction is valid for 5 minutes. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("Your supplier wallet address: its key becomes the advert's supplier key, the only key that can retire the advert. Get it from vector_signer_get_address."),
      capability_id: z.string().min(1).describe("Capability id, at most 64 bytes, outside the fleet namespaces llm.text.generate.*, llm.chat.*, ocr.page.extract.* and audio.synthesize.* (for example research.summary.v1). A reputation stake names the same id."),
      model: z.string().min(1).describe("Model or service version the supplier runs, at most 64 bytes"),
      max_output_tokens: z.number().int().min(0).describe("Largest output the supplier commits to, in tokens (0 if not token-based)"),
      max_processing_ms: z.number().int().min(0).max(MAX_PROCESSING_MS_CEILING).describe("Processing window in milliseconds, at most 86400000 (24 h): how long the supplier has to submit a job"),
      price_lovelace: z.number().int().min(0).describe("Price per job in lovelace (1 AP3X = 1000000)"),
      supplier_bond_lovelace: z.number().int().min(0).default(1_000_000).describe("Supplier bond in lovelace (default 1000000). A buyer locks price + both bonds per job; on Accept the supplier receives price + supplier bond. It is also the advert's deposit, raised to 2 units"),
      buyer_bond_lovelace: z.number().int().min(0).default(1_000_000).describe("Buyer bond in lovelace (default 1000000); it returns to the buyer on Accept"),
      endpoint_url: z.string().min(1).describe("https URL of your supplier runtime, at most 64 bytes (vector_marketplace_send_job posts jobs to <endpoint_url>/v1/job)"),
      detail_uri: z.string().default('').describe("Optional https URL of your manifest (agent.json), at most 64 bytes"),
      detail_hash: z.string().optional().describe("Optional sha256 (64 hex) of the bytes detail_uri serves. Omitted with a detail_uri: the tool fetches detail_uri once and uses the sha256 of the bytes served. Omitted without one: the sha256 of no bytes"),
    },
    async ({ changeAddress, capability_id, model, max_output_tokens, max_processing_ms, price_lovelace, supplier_bond_lovelace, buyer_bond_lovelace, endpoint_url, detail_uri, detail_hash }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildPostAdvert(lucid, provider, {
          changeAddress,
          terms: {
            capabilityId: capability_id, model, maxOutputTokens: max_output_tokens, maxProcessingMs: max_processing_ms,
            priceLovelace: BigInt(price_lovelace), supplierBondLovelace: BigInt(supplier_bond_lovelace), buyerBondLovelace: BigInt(buyer_bond_lovelace),
            endpointUrl: endpoint_url, detailUri: detail_uri, detailHash: detail_hash,
          },
        });
        const d = r.datum;
        const warning = r.collateralKept ? '' : '\n**Warning:** no pure 5-unit output was kept aside; a supplier needs one as collateral to Claim, Submit and Retire, so make sure the wallet still has one afterwards (the change of this Post counts if it is a pure output of at least 5 units).';
        // The advert's text fields are the caller's, and each tool shows them on one line: they go through cell().
        const md = `# Unsigned Advert Post Built (Not Submitted)\n\n` +
          `**Advert ref (after submit):** \`${r.advertRef}\`\n` +
          `**Supplier key:** \`${d.supplier_pkh}\` (the key of changeAddress; only it can retire the advert)\n` +
          `**Capability:** \`${cell(d.capability_id)}\`, model \`${cell(d.model)}\`, up to ${d.max_output_tokens} output tokens\n` +
          `**Per job:** a buyer locks price ${lovelaceToAda(d.price_lovelace)} + supplier bond ${lovelaceToAda(d.supplier_bond_lovelace)} + buyer bond ${lovelaceToAda(d.buyer_bond_lovelace)}; on Accept the supplier receives price + supplier bond and the buyer bond returns to the buyer\n` +
          `**Processing window:** ${d.max_processing_ms} ms\n` +
          `**Endpoint host:** \`${cell(r.endpointHost)}\`\n` +
          `**Detail URI:** ${d.detail_uri === '' ? '(none)' : `\`${cell(d.detail_uri)}\``}, detail hash \`${d.detail_hash}\` (${HASH_SOURCE[r.detailHashSource]})\n` +
          `**Deposit locked:** ${lovelaceToAda(r.depositLovelace)} (returns to you when you retire the advert with vector_build_marketplace_retire_advert)\n` +
          `**Valid until:** ${isoOrRaw(r.validTo)} (sign and submit before then, or build it again)\n` +
          `**Estimated fee:** ${r.feeAda}\n**Collateral kept aside:** ${r.collateralKept ? 'yes' : 'no'}${warning}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY} Once it confirms, vector_marketplace_get_supplier { advert_ref } reads the advert back.`;
        return text(withJson(md, {
          advert_ref: r.advertRef, supplier_pkh: d.supplier_pkh, capability_id: d.capability_id, deposit_lovelace: r.depositLovelace,
          advertised_at: d.advertised_at, valid_to: r.validTo, detail_hash: d.detail_hash, detail_hash_source: r.detailHashSource,
          tx_hash: r.txHash, fee: r.fee, collateral_kept: r.collateralKept,
        }));
      } catch (err) {
        return fail('build advert post', err, [
          TEXT_LIMITS,
          'The wallet needs the deposit (at least 2 units) plus about 1 unit for fees, and one pure 5-unit output kept as collateral',
        ]);
      }
    },
  );

  server.tool(
    "vector_build_marketplace_retire_advert",
    "Build an UNSIGNED transaction that retires your supplier advert on the Vector agents marketplace: consumes the advert and returns its deposit to changeAddress. Only the advert's supplier key can retire it. Once it confirms, buyers can no longer hire the advert, and a buyer whose escrow against it is posted but whose job is not yet sent can no longer send it (that buyer reclaims everything after deliver_by): retire when no job is in flight. Takes no key material. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("The supplier wallet address whose key the advert names. Get it from vector_signer_get_address."),
      advert_ref: z.string().describe("Advert '<txid>#<index>', as vector_build_marketplace_post_advert returned it"),
    },
    async ({ changeAddress, advert_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildRetireAdvert(lucid, provider, { changeAddress, advertRef: advert_ref });
        const md = `# Unsigned Advert Retire Built (Not Submitted)\n\n**Advert:** \`${r.advertRef}\` (\`${cell(r.capabilityId)}\`)\n` +
          `**Deposit returned to you:** ${lovelaceToAda(r.returnLovelace)}\n**Estimated fee:** ${r.feeAda}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { advert_ref: r.advertRef, tx_hash: r.txHash, supplier_pkh: r.supplierPkh, return_lovelace: r.returnLovelace, fee: r.fee }));
      } catch (err) {
        return fail('build advert retire', err, [
          'Only the key the advert names as its supplier can retire it: pass that wallet as changeAddress',
          'The wallet needs one pure 5-unit output as collateral',
        ]);
      }
    },
  );
}
