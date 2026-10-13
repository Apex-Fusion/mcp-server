// packages/builder/src/vector/marketplace.ts
// Marketplace family. PR 1: read tools (indexer + Koios only). PR 2 adds build tools,
// PR 3 adds job transport. Same conventions as agent-network.ts.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import { fetchCapabilities, fetchSuppliers, fetchSupplier, koiosUtxoInfo, withJson } from './marketplace-indexer.js';
import { decodeAdvertDatum, parseOutRef } from './marketplace-datum.js';

function text(t: string) { return { content: [{ type: "text" as const, text: t }] }; }
function fail(what: string, err: unknown, tips: string[]) {
  return text(`Failed to ${what}: ${err instanceof Error ? err.message : String(err)}\n\n**Troubleshooting Tips:**\n${tips.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
}
function host(url: string): string { try { return new URL(url).host; } catch { return url; } }

export function registerMarketplaceTools(server: McpServer, identity: string) {
  const rateLimiter = limiterFor(identity);
  function checkRateLimit() {
    const r = rateLimiter.check();
    return r.allowed ? null : text(`Rate limit exceeded. Retry after ${r.retryAfterMs}ms.`);
  }

  server.tool(
    "vector_marketplace_list_capabilities",
    "List the capability ids currently advertised on the Vector agents marketplace, with supplier counts. Read-only.",
    {},
    async () => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const rows = await fetchCapabilities();
        const table = rows.map((r) => `| \`${r.capability_id}\` | ${r.supplier_count} |`).join('\n');
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
        const rows = (await fetchSuppliers({ capability_id, onlyFree: only_free ?? true })).slice(0, limit ?? 20);
        if (rows.length === 0) return text(`No suppliers found${capability_id ? ` for ${capability_id}` : ''}${only_free ? ' with status free' : ''}.`);
        const table = rows.map((s) =>
          `| \`${s.utxo_ref}\` | ${s.capability_id} | ${s.model} | ${lovelaceToAda(s.price_lovelace)} | ${lovelaceToAda(s.supplier_bond_lovelace)} / ${lovelaceToAda(s.buyer_bond_lovelace)} | ${Math.round(s.max_processing_ms / 1000)} s | ${s.status} | ${s.last_seen_iso ?? '-'} | ${host(s.endpoint_url)} |`).join('\n');
        const md = `# Marketplace suppliers\n\nA job locks price + supplier bond + buyer bond; both bonds return on Accept.\n\n| advert_ref | capability | model | price | bonds (supplier / buyer) | window | status | last seen | endpoint |\n|---|---|---|---|---|---|---|---|---|\n${table}`;
        return text(withJson(md, rows.map((s) => ({ advert_ref: s.utxo_ref, supplier_pkh: s.supplier_pkh, capability_id: s.capability_id, model: s.model, price_lovelace: s.price_lovelace, supplier_bond_lovelace: s.supplier_bond_lovelace, buyer_bond_lovelace: s.buyer_bond_lovelace, max_processing_ms: s.max_processing_ms, status: s.status, last_seen_iso: s.last_seen_iso, endpoint_url: s.endpoint_url, detail_uri: s.detail_uri }))));
      } catch (err) { return fail('list suppliers', err, ['The public indexer may be unreachable; retry in a minute', 'Try without capability_id to see everything']); }
    },
  );

  server.tool(
    "vector_marketplace_get_supplier",
    "Read one supplier advert from the Vector ledger by advert_ref (all 13 advert fields) plus the indexer's live status. Read-only.",
    { advert_ref: z.string().describe("Advert UTxO reference '<txid>#<index>' from vector_marketplace_list_suppliers") },
    async ({ advert_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const ref = parseOutRef(advert_ref);
        const [utxo] = await koiosUtxoInfo(VECTOR_KOIOS_URL, [`${ref.txHash}#${ref.outputIndex}`]);
        if (!utxo?.inline_datum?.bytes) return text(`No advert found at ${advert_ref} (no UTxO or no inline datum).`);
        const advert = decodeAdvertDatum(utxo.inline_datum.bytes);
        const live = await fetchSupplier(advert.supplier_pkh).catch(() => null);
        const md = `# Advert ${advert_ref}\n\n` +
          `- **Capability:** \`${advert.capability_id}\`\n- **Model:** ${advert.model}\n- **Supplier key hash:** \`${advert.supplier_pkh}\`\n` +
          `- **Price:** ${lovelaceToAda(advert.price_lovelace)} · **Bonds:** supplier ${lovelaceToAda(advert.supplier_bond_lovelace)}, buyer ${lovelaceToAda(advert.buyer_bond_lovelace)}\n` +
          `- **Processing window:** ${advert.max_processing_ms} ms · **Max output tokens:** ${advert.max_output_tokens}\n` +
          `- **Endpoint:** ${advert.endpoint_url}\n- **Detail URI:** ${advert.detail_uri || '(none)'} · **Detail hash:** \`${advert.detail_hash}\`\n` +
          `- **Advertised at:** ${new Date(advert.advertised_at).toISOString()} · **Status on chain:** ${advert.status}${utxo.is_spent ? ' (UTxO spent: retired or updated)' : ''}\n` +
          `- **Indexer status:** ${live ? `${live.status}, last seen ${live.last_seen_iso ?? '-'}` : 'unknown'}`;
        return text(withJson(md, { advert_ref, ...advert, is_spent: utxo.is_spent ?? null, indexer_status: live?.status ?? null, last_seen_iso: live?.last_seen_iso ?? null }));
      } catch (err) { return fail('read advert', err, ['Check the advert_ref format <64-hex>#<index>', 'Koios may be unreachable; retry']); }
    },
  );
}
