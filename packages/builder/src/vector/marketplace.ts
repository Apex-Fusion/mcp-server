// packages/builder/src/vector/marketplace.ts
// Marketplace family. PR 1: read tools (indexer + Koios only). PR 2: keyless build tools (escrow post, accept, reclaim).
// PR 3 adds job transport. Same conventions as agent-network.ts.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { limiterFor } from './rate-limiter.js';
import { lucidForAddress } from './build.js';
import { fetchCapabilities, fetchSuppliers, fetchSupplier, readAdvert, withJson } from './marketplace-indexer.js';
import { formatOutRef } from './marketplace-datum.js';
import { buildPostEscrow, buildAccept, buildReclaim } from './marketplace-build.js';

const SIGN_COPY = 'Sign it locally with vector_signer_sign { txCbor }, broadcast with vector_submit_transaction { signedTxCbor }, then confirm with vector_await_transaction { txHash }.';
function newProvider() { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }

/** What a test can replace. Production passes nothing and the build tools talk to the configured Ogmios node. */
export interface MarketplaceToolOptions { provider?: () => Provider }

function text(t: string) { return { content: [{ type: "text" as const, text: t }] }; }
/** Long enough for the longest refusal a builder writes (a list of five refs and its explanation), short enough to bound what an error can say. */
const ERROR_TEXT_MAX = 800;
function fail(what: string, err: unknown, tips: string[]) {
  // The message can carry text out of a datum or an advert, which anyone can write: it is shown flattened to one escaped line.
  return text(`Failed to ${what}: ${cell(err instanceof Error ? err.message : String(err), ERROR_TEXT_MAX)}\n\n**Troubleshooting Tips:**\n${tips.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
}
function host(url: string): string { try { return new URL(url).host; } catch { return url; } }
/**
 * Supplier-controlled text headed for a markdown table, bullet or heading: one line, no pipes or backticks, at most
 * `max` characters. Adverts are written by anyone, so an unescaped value could break the table or smuggle lines into
 * the assistant's context. The fenced JSON block carries the verbatim value.
 */
function cell(s: unknown, max = 80): string {
  const flat = String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\|/g, '¦').replace(/`/g, "'").trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : flat;
}
function isoOrRaw(ms: number): string { const d = new Date(ms); return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString(); }

export function registerMarketplaceTools(server: McpServer, identity: string, options: MarketplaceToolOptions = {}) {
  const rateLimiter = limiterFor(identity);
  const providerFor = options.provider ?? newProvider;
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
    "Read one supplier advert from the Vector ledger by advert_ref (all 13 advert fields) plus the indexer's live status. Read-only.",
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
        const md = `# Advert ${ref}\n\n` +
          `- **Capability:** \`${cell(advert.capability_id)}\`\n- **Model:** ${cell(advert.model)}\n- **Supplier key hash:** \`${advert.supplier_pkh}\`\n` +
          `- **Price:** ${lovelaceToAda(advert.price_lovelace)} · **Bonds:** supplier ${lovelaceToAda(advert.supplier_bond_lovelace)}, buyer ${lovelaceToAda(advert.buyer_bond_lovelace)}\n` +
          `- **Processing window:** ${advert.max_processing_ms} ms · **Max output tokens:** ${advert.max_output_tokens}\n` +
          `- **Endpoint:** ${cell(advert.endpoint_url)}\n- **Detail URI:** ${cell(advert.detail_uri) || '(none)'} · **Detail hash:** \`${advert.detail_hash}\`\n` +
          `- **Advertised at:** ${isoOrRaw(advert.advertised_at)} · **Status on chain:** ${advert.status}${spent ? ' (UTxO spent: retired or updated)' : ''}\n` +
          `- **Indexer status:** ${live ? `${cell(live.status)}, last seen ${cell(live.last_seen_iso ?? '-')}` : 'not confirmed by the indexer for this advert'}`;
        return text(withJson(md, { advert_ref: ref, ...advert, is_spent: utxo.is_spent ?? null, indexer_status: live?.status ?? null, last_seen_iso: live?.last_seen_iso ?? null }));
      } catch (err) { return fail('read advert', err, ['Koios may be unreachable; retry in a minute']); }
    },
  );

  server.tool(
    "vector_build_marketplace_post_escrow",
    "Build an UNSIGNED transaction that hires a supplier on the Vector agents marketplace: locks price + supplier bond + buyer bond in escrow for the given advert and commits a hash of your payload. Takes no key material. After it confirms, send the job through the marketplace transport tool with the returned escrow_ref and the same payload. " + SIGN_COPY,
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
        // supplierPkh, endpointHost and capabilityId come out of an advert, which anyone can write: all three go through cell().
        const warning = r.collateralKept ? '' : '\n**Warning:** no pure 5-unit output was kept aside for the Accept/Reclaim script spends; make sure your wallet still has one afterwards (the change of this Post counts if it is a pure output of at least 5 units).';
        const md = `# Unsigned Escrow Post Built (Not Submitted)\n\n` +
          `**Hiring:** \`${cell(r.capabilityId)}\` from supplier key \`${cell(r.supplierPkh)}\`, endpoint host \`${cell(r.endpointHost)}\`\n` +
          `**Escrow ref (after submit):** \`${r.escrowRef}\`\n` +
          `**Locked:** ${lovelaceToAda(r.lockLovelace)} = price ${lovelaceToAda(r.priceLovelace)} + supplier bond ${lovelaceToAda(r.supplierBondLovelace)} + buyer bond ${lovelaceToAda(r.buyerBondLovelace)} (floored to the min-UTxO of the Submitted datum). On Accept the supplier receives price + supplier bond and your buyer bond returns. Reclaim after ${deliverBy} returns everything.\n` +
          `**Deliver by:** ${deliverBy}\n**Payload hash:** \`${r.promptHash}\`\n**Estimated fee:** ${r.feeAda}\n**Collateral kept aside:** ${r.collateralKept ? 'yes' : 'no'}${warning}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\nKeep the payload byte-identical when you send the job through the marketplace transport tool. ${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref: r.escrowRef, lock_lovelace: r.lockLovelace, deliver_by: r.deliverBy, prompt_hash: r.promptHash, tx_hash: r.txHash, fee: r.fee, collateral_kept: r.collateralKept }));
      } catch (err) { return fail('build escrow post', err, ['The wallet needs the lock plus about 1 unit for fees, and one pure 5-unit output kept as collateral', 'Check the advert is still Active with vector_marketplace_get_supplier']); }
    },
  );

  server.tool(
    "vector_build_marketplace_accept",
    "Build an UNSIGNED transaction that accepts a Submitted marketplace job: pays the supplier price + supplier bond and returns your buyer bond. Only the buyer can accept, within 600 s of the supplier's Submit. Verify the receipt first. " + SIGN_COPY,
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
        const md = `# Unsigned Accept Built (Not Submitted)\n\n**Supplier receives:** ${lovelaceToAda(r.supplierLovelace)}\n**Your bond back:** ${lovelaceToAda(r.buyerLovelace)}\n**Estimated fee:** ${r.feeAda}${warn}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref, tx_hash: r.txHash, supplier_lovelace: r.supplierLovelace, buyer_lovelace: r.buyerLovelace, seconds_left: r.secondsLeft }));
      } catch (err) { return fail('build accept', err, ['The job must be in Submitted state: check its progress through the marketplace transport tool first', 'Accept must land within 600 s of Submit; after that the supplier may Release', 'The wallet needs one pure 5-unit output as collateral']); }
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
        const md = `# Unsigned Reclaim Built (Not Submitted)\n\n**Returned to you:** ${lovelaceToAda(r.buyerLovelace)} (price + supplier bond + buyer bond), and whatever else the escrow holds, as change\n**Estimated fee:** ${r.feeAda}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref, tx_hash: r.txHash, buyer_lovelace: r.buyerLovelace }));
      } catch (err) { return fail('build reclaim', err, ['Reclaim opens only after deliver_by', 'A Submitted escrow cannot be reclaimed: accept it or wait for the supplier to Release']); }
    },
  );
}
