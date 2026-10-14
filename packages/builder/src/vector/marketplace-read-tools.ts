// packages/builder/src/vector/marketplace-read-tools.ts
// The marketplace read tools: capabilities and suppliers from the public indexer, one advert from the ledger through Koios. They
// need no wallet and no node. The one URL they call that a supplier chose is an advert's detail_uri, through safeFetch (fetchManifest).
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { fetchCapabilities, fetchSuppliers, fetchSupplier, readAdvert, withJson } from './marketplace-indexer.js';
import { formatOutRef } from './marketplace-datum.js';
import { fetchManifest } from './marketplace-transport.js';
import { text, fail, cell, host, isoOrRaw } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';

export function registerMarketplaceReadTools(server: McpServer, checkRateLimit: RateGate) {
  server.tool(
    "vector_marketplace_list_capabilities",
    "List the capability ids currently advertised on the Vector agents marketplace, with supplier counts. Read-only.",
    {},
    async () => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const rows = await fetchCapabilities();
        const table = rows.map((r) => `| \`${cell(r.capability_id)}\` | ${cell(r.supplier_count)} |`).join('\n');
        return text(withJson(`# Marketplace capabilities\n\n| capability_id | suppliers |\n|---|---|\n${table}\n\nNext: vector_marketplace_list_suppliers { capability_id }.`, rows));
      } catch (err) { return fail('list capabilities', err, ['The public indexer may be unreachable; retry in a minute']); }
    },
  );

  server.tool(
    "vector_marketplace_list_suppliers",
    "List supplier adverts on the Vector agents marketplace (advert ref, model, price, bonds, processing window, status). Read-only. Pick an advert_ref here, then hire it with vector_build_marketplace_post_escrow.",
    {
      capability_id: z.string().optional().describe("Filter by capability id, e.g. 'identity.history.report.v1'"),
      only_free: z.boolean().optional().default(true).describe("Only suppliers currently reporting status 'free' (default true)"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Maximum rows (default 20, max 50)"),
    },
    async ({ capability_id, only_free, limit }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const onlyFree = only_free ?? true; // the schema's defaults, for a caller that bypasses the schema
        const rows = (await fetchSuppliers({ capability_id, onlyFree })).slice(0, limit ?? 20);
        if (rows.length === 0) return text(`No suppliers found${capability_id ? ` for ${cell(capability_id)}` : ''}${onlyFree ? ' with status free' : ''}.`);
        const table = rows.map((s) =>
          `| \`${cell(s.utxo_ref)}\` | ${cell(s.capability_id)} | ${cell(s.model)} | ${lovelaceToAda(s.price_lovelace)} | ${lovelaceToAda(s.supplier_bond_lovelace)} / ${lovelaceToAda(s.buyer_bond_lovelace)} | ${Math.round(s.max_processing_ms / 1000)} s | ${cell(s.status)} | ${cell(s.last_seen_iso ?? '-')} | ${cell(host(s.endpoint_url))} |`).join('\n');
        const md = `# Marketplace suppliers\n\nThe buyer locks price + supplier bond + buyer bond; on Accept the supplier receives price + supplier bond and the buyer bond returns to the buyer.\n\n| advert_ref | capability | model | price | bonds (supplier / buyer) | window | status | last seen | endpoint |\n|---|---|---|---|---|---|---|---|---|\n${table}`;
        return text(withJson(md, rows.map((s) => ({ advert_ref: s.utxo_ref, supplier_pkh: s.supplier_pkh, capability_id: s.capability_id, model: s.model, price_lovelace: s.price_lovelace, supplier_bond_lovelace: s.supplier_bond_lovelace, buyer_bond_lovelace: s.buyer_bond_lovelace, max_processing_ms: s.max_processing_ms, status: s.status, last_seen_iso: s.last_seen_iso, endpoint_url: s.endpoint_url, detail_uri: s.detail_uri }))));
      } catch (err) { return fail('list suppliers', err, ['The public indexer may be unreachable; retry in a minute', 'Try without capability_id to see everything']); }
    },
  );

  server.tool(
    "vector_marketplace_get_supplier",
    "Read one supplier advert from the Vector ledger by advert_ref (all 13 advert fields) plus the indexer's live status, and the manifest its detail_uri points to when it has one (fetched from the supplier's host; the supplier's own JSON, shown as such). Read-only.",
    { advert_ref: z.string().describe("Advert UTxO reference '<txid>#<index>' from vector_marketplace_list_suppliers") },
    async ({ advert_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const read = await readAdvert(advert_ref);
        if ('error' in read) return text(read.error);
        const { utxo, advert, spent } = read;
        const ref = formatOutRef(utxo.tx_hash.toLowerCase(), utxo.tx_index);
        // The indexer tracks one live advert per supplier key. Its status describes THIS advert only when the refs match:
        // a spent, replaced or copied advert carrying the same supplier_pkh must not inherit the genuine one's status.
        const row = await fetchSupplier(advert.supplier_pkh).catch(() => null);
        const live = row && String(row.utxo_ref).toLowerCase() === ref ? row : null;
        // The manifest is the supplier's own file at a URL its author chose: fetched through safeFetch, and said to be just that.
        const detail = advert.detail_uri ? await fetchManifest(advert.detail_uri) : null;
        const manifestLine = detail === null ? 'none (the advert has no Detail URI)'
          : 'manifest' in detail ? "fetched from the Detail URI: the supplier's own JSON, not checked against the detail hash (the full text is in the JSON block)"
          : `could not be fetched (${detail.error})`;
        const md = `# Advert ${ref}\n\n` +
          `- **Capability:** \`${cell(advert.capability_id)}\`\n- **Model:** ${cell(advert.model)}\n- **Supplier key hash:** \`${advert.supplier_pkh}\`\n` +
          `- **Price:** ${lovelaceToAda(advert.price_lovelace)} · **Bonds:** supplier ${lovelaceToAda(advert.supplier_bond_lovelace)}, buyer ${lovelaceToAda(advert.buyer_bond_lovelace)}\n` +
          `- **Processing window:** ${advert.max_processing_ms} ms · **Max output tokens:** ${advert.max_output_tokens}\n` +
          `- **Endpoint:** ${cell(advert.endpoint_url)}\n- **Detail URI:** ${cell(advert.detail_uri) || '(none)'} · **Detail hash:** \`${advert.detail_hash}\`\n- **Manifest:** ${manifestLine}\n` +
          `- **Advertised at:** ${isoOrRaw(advert.advertised_at)} · **Status on chain:** ${advert.status}${spent ? ' (UTxO spent: retired or updated)' : ''}\n` +
          `- **Indexer status:** ${live ? `${cell(live.status)}, last seen ${cell(live.last_seen_iso ?? '-')}` : 'not confirmed by the indexer for this advert'}`;
        return text(withJson(md, { advert_ref: ref, ...advert, is_spent: utxo.is_spent ?? null, indexer_status: live?.status ?? null, last_seen_iso: live?.last_seen_iso ?? null, manifest: detail && 'manifest' in detail ? detail.manifest : null, manifest_error: detail && 'error' in detail ? detail.error : null }));
      } catch (err) { return fail('read advert', err, ['Koios may be unreachable; retry in a minute']); }
    },
  );
}
