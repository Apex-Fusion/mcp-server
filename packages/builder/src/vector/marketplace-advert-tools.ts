// packages/builder/src/vector/marketplace-advert-tools.ts
// The marketplace advert tools: keyless builders for the supplier side. The identity-layout advert (Part 2 Section 6.2): post, update
// and retire; the retire takes a legacy-layout advert too, so that suppliers retire their legacy adverts during the drain. And the
// legacy Post (legacy layout), refused from the escrow switch on (ESCROW_SWITCH_SLOT). Both layouts follow one set of terms rules
// (checkAdvertTerms). Each tool takes a wallet address only and returns unsigned CBOR for the local signer; nothing here signs or
// submits. The node they build against comes from `providerFor` and the identity deployment from `deploymentFor`, so the entry point
// decides them (and a test can hand in its own).
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { withJson } from './marketplace-indexer.js';
import type { AdvertLayout } from './marketplace-indexer.js';
import type { AdvertDatum } from './marketplace-datum.js';
import { buildPostAdvert, buildRetireAdvert } from './marketplace-advert.js';
import { advertLayoutAt, buildAdvertPost, buildAdvertUpdate, buildAdvertRetire, IDENTITY_URL_BYTES_MAX } from './marketplace-advert-build.js';
import type { DetailHashSource } from './marketplace-advert-build.js';
import { identityOnly } from './marketplace-build-tools.js';
import type { MaybeDeploymentFor } from './marketplace-build-tools.js';
import { escrowSwitchPassed, ESCROW_SWITCH_NAME, LEGACY_ADVERT_REFUSAL } from './marketplace-build.js';
import { ADVERT_ADDRESS, MAX_PROCESSING_MS_CEILING, MIN_PROCESSING_MS_FLOOR } from './marketplace-constants.js';
import { text, fail, cell, isoOrRaw, SIGN_COPY } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { identifierOf } from './identity-chain.js';
import { zChangeAddress, zDid, zKeyHash, zValidMinutes, buildText } from './identity-shared.js';

const HASH_SOURCE: Record<DetailHashSource, string> = {
  given: 'as given',
  empty: 'the sha256 of no bytes (no detail URI)',
};
const URL_RULES = 'endpoint_url and detail_uri must be https URLs, and endpoint_url has no whitespace, query or fragment';
const TEXT_LIMITS = `capability_id, model, endpoint_url and detail_uri each hold at most 64 bytes of UTF-8; ${URL_RULES}`;
const IDENTITY_TEXT_LIMITS = `capability_id and model hold at most 64 bytes of UTF-8 each, endpoint_url and detail_uri at most ${IDENTITY_URL_BYTES_MAX}; ${URL_RULES}`;
/** The terms rules (checkAdvertTerms) as the tool descriptions state them, after the field sizes of the layout. */
const RULES_TAIL = 'a fleet capability id, an endpoint that is not https or that has whitespace, a query or a fragment (jobs go to <endpoint_url>/v1/job), a processing window outside 60,001 ms to 24 h, and price + both bonds above 10,000 AP3X. A detail_uri needs your detail_hash: this server fetches nothing.';
const LEGACY_TERMS_RULES = `Terms that buyers could not hire or that a supplier template cannot serve are refused: a text field over 64 bytes of UTF-8, ${RULES_TAIL}`;
const TERMS_RULES = `Terms that buyers could not hire or that a supplier template cannot serve are refused: a capability_id or model over 64 bytes of UTF-8, an endpoint_url or detail_uri over ${IDENTITY_URL_BYTES_MAX}, ${RULES_TAIL}`;
/** The supplier template serves only the advert its ADVERT_REF names (agent/src/routes/custom.ts), so every new advert needs it set. */
const ADVERT_REF_COPY = 'set your supplier runtime\'s ADVERT_REF to this advert_ref and restart it: the supplier template serves only the advert ADVERT_REF names (after a Retire and a new Post, ADVERT_REF must change to the new ref).';
const RETIRED_COPY = 'after this confirms, the supplier runtime\'s ADVERT_REF names a consumed advert; to list the supplier again, post a new advert with vector_build_marketplace_advert_post and set ADVERT_REF to the new advert_ref.';
const CAPABILITY_ID = 'Capability id, at most 64 bytes, outside the fleet namespaces llm.text.generate.*, llm.chat.*, ocr.page.extract.* and audio.synthesize.* (for example research.summary.v1)';
const zAdvertRef = z.string().describe("The advert '<txid>#<index>'");

/** The fields of the terms that both layouts describe alike. The post tools add the rest; the update tool makes each one optional. */
const termFields = {
  model: z.string().min(1).describe("Model or service version the supplier runs, at most 64 bytes"),
  max_output_tokens: z.number().int().min(0).describe("Largest output the supplier commits to, in tokens (0 if not token-based)"),
  max_processing_ms: z.number().int().min(MIN_PROCESSING_MS_FLOOR).max(MAX_PROCESSING_MS_CEILING).describe("Processing window in milliseconds, from 60001 to 86400000 (24 h): how long the supplier has to submit a job. A vector-agent-template supplier needs at least its SERVICE_TIMEOUT_MS + 60000 (180000 with the default)"),
  price_lovelace: z.number().int().min(0).describe("Price per job in lovelace (1 AP3X = 1000000); price + both bonds is at most 10,000 AP3X"),
  detail_hash: z.string().regex(/^(?:[0-9a-fA-F]{64})?$/, 'expected 64 hex characters, or ""').optional().describe("sha256 (64 hex) of the exact bytes detail_uri serves; required with a detail_uri (this server does not fetch it). Without a detail_uri, omit it (or pass \"\"): the sha256 of no bytes is used"),
};
const ENDPOINT_RULES = 'without whitespace, query or fragment (vector_marketplace_send_job posts jobs to <endpoint_url>/v1/job)';
const legacyEndpoint = z.string().min(1).describe(`https URL of your supplier runtime, at most 64 bytes, ${ENDPOINT_RULES}`);
const identityEndpoint = z.string().min(1).max(IDENTITY_URL_BYTES_MAX).describe(`https URL of your supplier runtime, at most ${IDENTITY_URL_BYTES_MAX} bytes, ${ENDPOINT_RULES}`);

const ADVERT_TIPS = [
  'The agent record must list the supplier key with the transaction purpose and the capability (vector_build_identity_update), be independent (no parent) and be Active',
  'The supplier key must sign: pass the transaction to its holder after the wallet (vector_signer_sign)',
  IDENTITY_TEXT_LIMITS,
  'The wallet needs the deposit plus about 1 AP3X for the fee; an update also needs one pure output of at least 5 AP3X as collateral',
];

/** What the answer of an advert build shows, in both layouts: the advert, its agent, and where its deposit is or goes. */
interface AdvertView {
  layout: AdvertLayout; advert: AdvertDatum; did: string | null; agentId: string | null;
  /** The advert output the transaction writes; null for a retirement. */
  advertRef: string | null;
  /** The advert output the transaction spends; null for a post. */
  spentRef: string | null;
  depositLovelace: bigint;
  /** Where a retirement pays the deposit; null otherwise. */
  paidTo: string | null;
}

/** The facts of an advert build; `advertAddress` is where the advert output is (post, update). */
function advertFacts(v: AdvertView, advertAddress: string): Array<[string, string]> {
  const a = v.advert;
  const spent: Array<[string, string]> = v.spentRef === null ? [] : [[v.paidTo === null ? 'Replaces' : 'Retires', `\`${v.spentRef}\``]];
  return [
    ['Layout', v.layout === 'identity' ? 'identity (the advert names its agent)' : 'legacy (the advert names no agent)'],
    ['Agent', v.did === null ? 'none' : `${v.did} (the advert's agent)`],
    ...spent,
    ['Supplier key hash', `\`${a.supplier_pkh}\``],
    ['Capability', `\`${cell(a.capability_id)}\` · model ${cell(a.model)}`],
    ['Price', `${lovelaceToAda(a.price_lovelace)} AP3X · bonds: supplier ${lovelaceToAda(a.supplier_bond_lovelace)}, buyer ${lovelaceToAda(a.buyer_bond_lovelace)}`],
    ['Processing window', `${a.max_processing_ms} ms · max output tokens ${a.max_output_tokens}`],
    ['Endpoint', cell(a.endpoint_url, 200)],
    ['Detail', `${a.detail_uri === '' ? 'no detail URI' : cell(a.detail_uri, 200)} · detail hash \`${cell(a.detail_hash, 80)}\``],
    ['Status', a.status],
    v.paidTo === null
      ? ['Advert output', `${v.advertRef ?? '-'} at ${advertAddress}, deposit ${lovelaceToAda(v.depositLovelace)} AP3X`]
      : ['Deposit back', `${lovelaceToAda(v.depositLovelace)} AP3X to ${v.paidTo}`],
  ];
}
const advertJson = (v: AdvertView) => ({
  layout: v.layout, advert_ref: v.advertRef, spent_ref: v.spentRef, did: v.did, agent_id: v.agentId, supplier_pkh: v.advert.supplier_pkh,
  capability_id: v.advert.capability_id, status: v.advert.status, advertised_at: v.advert.advertised_at, detail_hash: v.advert.detail_hash,
  deposit_lovelace: v.depositLovelace, paid_to: v.paidTo,
});
const lovelaceOrUndefined = (n: number | undefined): bigint | undefined => (n === undefined ? undefined : BigInt(n));

export function registerMarketplaceAdvertTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: MaybeDeploymentFor) {
  server.tool(
    "vector_build_marketplace_advert_post",
    "Build an UNSIGNED transaction that lists your supplier agent on the Vector agents marketplace with an identity-layout advert (Part 2 Section 6.2): the advert names the agent (did:vector) whose record lists the supplier key with the transaction purpose and the capability, and the capability, model, price, bonds, processing window and https endpoint that buyers' jobs go to. It locks a deposit that returns when you retire the advert. The builder checks the listing rule on chain (the record is live, independent and Active, and lists the key and the capability), so the indexer lists the advert. " + TERMS_RULES + " The supplier key must sign (the listing rule needs its signature). Once the Post confirms, buyers can hire it with vector_build_marketplace_post_escrow; " + ADVERT_REF_COPY + " Takes no key material.",
    {
      changeAddress: zChangeAddress,
      did: zDid('the agent the advert offers'),
      supplier_key_hash: zKeyHash("The supplier key that claims and submits the jobs (default your wallet's key)").optional(),
      capability_id: z.string().min(1).describe(`${CAPABILITY_ID}; the agent's record must list it`),
      ...termFields,
      endpoint_url: identityEndpoint,
      supplier_bond_lovelace: z.number().int().min(0).describe("Supplier bond in lovelace: a buyer locks price + both bonds per job, and on Accept the supplier receives price + supplier bond"),
      buyer_bond_lovelace: z.number().int().min(0).describe("Buyer bond in lovelace; it returns to the buyer on Accept"),
      detail_uri: z.string().max(IDENTITY_URL_BYTES_MAX).optional().describe(`Optional https URL of your manifest (agent.json), at most ${IDENTITY_URL_BYTES_MAX} bytes (default none); requires detail_hash`),
      deposit_lovelace: z.number().int().min(0).optional().describe("The AP3X the advert locks, in lovelace (default 2 AP3X, raised to the ledger minimum); it returns on retirement"),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = identityOnly(deploymentFor);
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, a.changeAddress);
        const r = await buildAdvertPost({ lucid, provider, deployment }, {
          changeAddress: a.changeAddress, agentId: identifierOf(a.did), supplierPkh: a.supplier_key_hash?.toLowerCase(),
          terms: {
            capabilityId: a.capability_id, model: a.model, maxOutputTokens: a.max_output_tokens, maxProcessingMs: a.max_processing_ms,
            priceLovelace: BigInt(a.price_lovelace), supplierBondLovelace: BigInt(a.supplier_bond_lovelace), buyerBondLovelace: BigInt(a.buyer_bond_lovelace),
            endpointUrl: a.endpoint_url, detailUri: a.detail_uri ?? '', detailHash: a.detail_hash,
          },
          depositLovelace: lovelaceOrUndefined(a.deposit_lovelace), validMinutes: a.valid_minutes,
        });
        const view: AdvertView = { ...r, layout: 'identity' };
        return text(buildText('Advert Post Built', advertFacts(view, deployment.advert.address), r, advertJson(view), `**Supplier runtime:** once this confirms, ${ADVERT_REF_COPY}`));
      } catch (err) { return fail('build advert post', err, ADVERT_TIPS); }
    },
  );

  server.tool(
    "vector_build_marketplace_advert_update",
    "Build an UNSIGNED UpdateAdvert of an identity-layout advert: changes the fields you pass and keeps the others; the supplier key and the agent stay (the contract keeps them), advertised_at moves to now. The new terms follow the rules of a Post: " + TERMS_RULES + " An advert that stays Active must still pass the listing rule; status Retired takes it off the market but keeps the output (vector_build_marketplace_advert_retire returns the deposit). The supplier key signs. The update writes a new advert output, so once it confirms, set your supplier runtime's ADVERT_REF to the new advert_ref. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      advert_ref: zAdvertRef,
      capability_id: z.string().min(1).optional().describe(`${CAPABILITY_ID}; the agent's record must list it`),
      model: termFields.model.optional(), max_output_tokens: termFields.max_output_tokens.optional(),
      max_processing_ms: termFields.max_processing_ms.optional(), price_lovelace: termFields.price_lovelace.optional(),
      supplier_bond_lovelace: z.number().int().min(0).optional().describe("Supplier bond in lovelace"),
      buyer_bond_lovelace: z.number().int().min(0).optional().describe("Buyer bond in lovelace"),
      endpoint_url: identityEndpoint.optional(),
      detail_uri: z.string().max(IDENTITY_URL_BYTES_MAX).optional().describe(`The new https URL of your manifest, at most ${IDENTITY_URL_BYTES_MAX} bytes ("" for none); a new detail_uri requires its detail_hash`),
      detail_hash: termFields.detail_hash,
      status: z.enum(['Active', 'Retired']).optional().describe('The new status (default unchanged)'),
      deposit_lovelace: z.number().int().min(0).optional().describe("The AP3X of the new advert output, in lovelace (default what the advert holds, raised to the ledger minimum)"),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = identityOnly(deploymentFor);
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, a.changeAddress);
        const r = await buildAdvertUpdate({ lucid, provider, deployment }, {
          changeAddress: a.changeAddress, advertRef: a.advert_ref, validMinutes: a.valid_minutes, depositLovelace: lovelaceOrUndefined(a.deposit_lovelace),
          changes: {
            capabilityId: a.capability_id, model: a.model, maxOutputTokens: a.max_output_tokens, maxProcessingMs: a.max_processing_ms,
            priceLovelace: lovelaceOrUndefined(a.price_lovelace), supplierBondLovelace: lovelaceOrUndefined(a.supplier_bond_lovelace),
            buyerBondLovelace: lovelaceOrUndefined(a.buyer_bond_lovelace), endpointUrl: a.endpoint_url, detailUri: a.detail_uri, detailHash: a.detail_hash,
            status: a.status,
          },
        });
        const view: AdvertView = { ...r, layout: 'identity' };
        return text(buildText('Advert Update Built', advertFacts(view, deployment.advert.address), r, advertJson(view), `**Supplier runtime:** once this confirms, ${ADVERT_REF_COPY}`));
      } catch (err) { return fail('build advert update', err, ADVERT_TIPS); }
    },
  );

  server.tool(
    "vector_build_marketplace_advert_retire",
    "Build an UNSIGNED transaction that retires your supplier advert on the Vector agents marketplace, in either layout: it consumes the advert and returns its deposit to the supplier key. Only the advert's supplier key can retire it, and that key signs. An identity-layout advert: the deposit goes to your wallet when its key is the supplier key, else to the supplier key's enterprise address. A legacy-layout advert (suppliers retire these during the switch): changeAddress must be the supplier key's wallet, the deposit returns to it, and the transaction is valid for 5 minutes, as the supplier template builds it. Once it confirms, buyers can no longer hire the advert, and a buyer whose escrow against it is posted but whose job is not yet sent can no longer send it (that buyer reclaims everything after deliver_by): retire when no job is in flight. After it confirms, the supplier runtime's ADVERT_REF names a consumed advert: to list the supplier again, post a new advert and set ADVERT_REF to its ref. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      advert_ref: zAdvertRef,
      valid_minutes: zValidMinutes.describe("Identity layout only: minutes from now until the transaction expires (default 30, at most 59). A legacy-layout Retire is valid for 5 minutes"),
    },
    async ({ changeAddress, advert_ref, valid_minutes }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        const layout = await advertLayoutAt(provider, advert_ref, deploymentFor());
        const lucid = await lucidForAddress(provider, changeAddress);
        if (layout === 'legacy') {
          const r = await buildRetireAdvert(lucid, provider, { changeAddress, advertRef: advert_ref });
          const view: AdvertView = { layout, advert: r.advert, did: null, agentId: null, advertRef: null, spentRef: r.advertRef, depositLovelace: r.returnLovelace, paidTo: changeAddress };
          return text(buildText('Advert Retirement Built', advertFacts(view, ADVERT_ADDRESS), r, advertJson(view), `**Supplier runtime:** ${RETIRED_COPY}`));
        }
        const deployment = identityOnly(deploymentFor);
        const r = await buildAdvertRetire({ lucid, provider, deployment }, { changeAddress, advertRef: advert_ref, validMinutes: valid_minutes });
        const view: AdvertView = { ...r, layout };
        return text(buildText('Advert Retirement Built', advertFacts(view, deployment.advert.address), r, advertJson(view), `**Supplier runtime:** ${RETIRED_COPY}`));
      } catch (err) {
        return fail('build advert retirement', err, [
          'Only the key the advert names as its supplier can retire it; for a legacy-layout advert, pass that key\'s wallet as changeAddress',
          'The supplier key must sign: for an identity-layout advert built from another wallet, pass the transaction to its holder after the wallet (vector_signer_sign)',
          'The wallet needs one pure output of at least 5 AP3X as collateral',
        ]);
      }
    },
  );

  server.tool(
    "vector_build_marketplace_post_advert",
    "Legacy layout, refused from " + ESCROW_SWITCH_NAME + " on: from then on new adverts use the identity layout, so use vector_build_marketplace_advert_post (the advert names your agent's did:vector DID). Before the switch, it builds an UNSIGNED transaction that lists your supplier agent on the Vector agents marketplace with a legacy-layout advert, which names no agent DID: posts an advert naming the key of changeAddress as the supplier, with the capability, model, price, bonds, processing window and https endpoint buyers' jobs go to, and locks a deposit (the supplier bond, at least 2 units) that returns when you retire the advert with vector_build_marketplace_advert_retire (also after the switch). " + LEGACY_TERMS_RULES + " Takes no key material. The advert ref is <txHash>#0; once it confirms, buyers can hire it with vector_build_marketplace_post_escrow until the switch, and vector_marketplace_get_supplier shows it. Your supplier runtime (for example vector-agent-template) must serve the endpoint with the same key; once the Post confirms, " + ADVERT_REF_COPY + " The transaction is valid for 5 minutes. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("Your supplier wallet address: its key becomes the advert's supplier key, the only key that can retire the advert. Get it from vector_signer_get_address."),
      capability_id: z.string().min(1).describe(CAPABILITY_ID),
      ...termFields,
      endpoint_url: legacyEndpoint,
      supplier_bond_lovelace: z.number().int().min(0).default(1_000_000).describe("Supplier bond in lovelace (default 1000000). A buyer locks price + both bonds per job; on Accept the supplier receives price + supplier bond. It is also the advert's deposit, raised to 2 units"),
      buyer_bond_lovelace: z.number().int().min(0).default(1_000_000).describe("Buyer bond in lovelace (default 1000000); it returns to the buyer on Accept"),
      detail_uri: z.string().default('').describe("Optional https URL of your manifest (agent.json), at most 64 bytes; requires detail_hash"),
    },
    async ({ changeAddress, capability_id, model, max_output_tokens, max_processing_ms, price_lovelace, supplier_bond_lovelace, buyer_bond_lovelace, endpoint_url, detail_uri, detail_hash }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = providerFor();
        // From the escrow switch on, no wallet can make this tool build: it refuses before it reads one (buildPostAdvert checks again).
        if (await escrowSwitchPassed(provider)) return text(`Failed to build advert post: ${LEGACY_ADVERT_REFUSAL}`);
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
          `**Layout:** legacy, until ${ESCROW_SWITCH_NAME}; for the identity layout use vector_build_marketplace_advert_post\n` +
          `**Advert ref (after submit):** \`${r.advertRef}\`\n` +
          `**Supplier key:** \`${d.supplier_pkh}\` (the key of changeAddress; only it can retire the advert)\n` +
          `**Capability:** \`${cell(d.capability_id)}\`, model \`${cell(d.model)}\`, up to ${d.max_output_tokens} output tokens\n` +
          `**Per job:** a buyer locks price ${lovelaceToAda(d.price_lovelace)} + supplier bond ${lovelaceToAda(d.supplier_bond_lovelace)} + buyer bond ${lovelaceToAda(d.buyer_bond_lovelace)}; on Accept the supplier receives price + supplier bond and the buyer bond returns to the buyer\n` +
          `**Processing window:** ${d.max_processing_ms} ms\n` +
          `**Endpoint host:** \`${cell(r.endpointHost)}\`\n` +
          `**Detail URI:** ${d.detail_uri === '' ? '(none)' : `\`${cell(d.detail_uri)}\``}, detail hash \`${d.detail_hash}\` (${HASH_SOURCE[r.detailHashSource]})\n` +
          `**Deposit locked:** ${lovelaceToAda(r.depositLovelace)} (returns to you when you retire the advert with vector_build_marketplace_advert_retire)\n` +
          `**Valid until:** ${isoOrRaw(r.validTo)} (sign and submit before then, or build it again)\n` +
          `**Estimated fee:** ${r.feeAda}\n**Collateral kept aside:** ${r.collateralKept ? 'yes' : 'no'}${warning}\n\n` +
          `**Supplier runtime:** once this confirms, ${ADVERT_REF_COPY}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY} Once it confirms, vector_marketplace_get_supplier { advert_ref } reads the advert back.`;
        return text(withJson(md, {
          layout: 'legacy', advert_ref: r.advertRef, supplier_pkh: d.supplier_pkh, capability_id: d.capability_id, deposit_lovelace: r.depositLovelace,
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
}
