// packages/builder/src/vector/marketplace-build-tools.ts
// The marketplace build tools: keyless builders for the unsigned escrow Post, Accept, Reclaim, Release and RefundRevoked, and for the
// identity-marketplace advert (post, update, retire). Each takes a wallet address only and returns unsigned CBOR for the local signer
// with every key hash that must sign; nothing here signs or submits. The node they build against comes from `providerFor` and the
// identity deployment from `deploymentFor`, so the entry point decides them (and a test can hand in its own). The escrow tools work in
// both layouts (Part 2 Section 9.6): a legacy advert or escrow needs no deployment; an identity-marketplace one needs it.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { withJson } from './marketplace-indexer.js';
import { buildPostEscrow, buildAccept, buildReclaim, buildRelease, buildRefundRevoked, supplierPayoutRaised } from './marketplace-build.js';
import type { EscrowSpendBuild } from './marketplace-build.js';
import { buildAdvertPost, buildAdvertUpdate, buildAdvertRetire, EMPTY_DETAIL_HASH } from './marketplace-advert-build.js';
import type { AdvertBuild, AdvertTerms } from './marketplace-advert-build.js';
import { text, fail, cell, isoOrRaw, signersLine, signersJson, SIGN_COPY, ACCEPT_WINDOW_S, RELEASE_TAKE } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { IdentityConfigError, NOT_CONFIGURED } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { identifierOf } from './identity-chain.js';
import { zChangeAddress, zDid, zKeyHash, zValidMinutes, buildText } from './identity-shared.js';

/** The server's identity deployment, or null before it has one: the marketplace tools serve the legacy layout without it. */
export type MaybeDeploymentFor = () => IdentityDeployment | null;

/** A payout below the minimum output is raised to it (planAccept, planReclaim); the signer is told, as it is shown more than the datum owes. */
const raised = (flag: boolean): string => (flag ? ' (raised to the 1-unit minimum)' : '');
/** The deployment for a tool that serves only the identity layout. */
function identityOnly(deploymentFor: MaybeDeploymentFor): IdentityDeployment {
  const deployment = deploymentFor();
  if (!deployment) throw new IdentityConfigError(NOT_CONFIGURED);
  return deployment;
}
/** The agent line of an identity-marketplace escrow, or nothing. */
const agentLine = (did: string | null): string => (did === null ? '' : `**Agent:** ${did} (the escrow names it; its receipt must name it too)\n`);
/** What the escrow spends share in their JSON block. */
const spendJson = (r: EscrowSpendBuild) => ({ escrow_ref: r.escrowRef, layout: r.layout, agent_did: r.agentDid, tx_hash: r.txHash, required_signers: signersJson(r.requiredSigners) });

const zLovelace = (what: string) => z.number().int().min(0).describe(`${what}, in lovelace (1 AP3X = 1,000,000)`);
const zAdvertRef = z.string().describe("The advert '<txid>#<index>'");
const ADVERT_TIPS = [
  'The agent record must list the supplier key with the transaction purpose and the capability (vector_build_identity_update), be independent (no parent) and be Active',
  'The supplier key must sign: pass the transaction to its holder after the wallet (vector_signer_sign)',
  'The wallet needs the deposit plus about 1 AP3X for the fee; update and retire also need one pure output of at least 5 AP3X as collateral',
];

/** The facts of an advert build. */
function advertFacts(r: AdvertBuild, deployment: IdentityDeployment): Array<[string, string]> {
  const a = r.advert;
  return [
    ['Agent', `${r.did} (the advert's agent)`],
    ['Supplier key hash', `\`${a.supplier_pkh}\``],
    ['Capability', `\`${cell(a.capability_id)}\` · model ${cell(a.model)}`],
    ['Price', `${lovelaceToAda(a.price_lovelace)} AP3X · bonds: supplier ${lovelaceToAda(a.supplier_bond_lovelace)}, buyer ${lovelaceToAda(a.buyer_bond_lovelace)}`],
    ['Processing window', `${a.max_processing_ms} ms · max output tokens ${a.max_output_tokens}`],
    ['Endpoint', cell(a.endpoint_url, 200)],
    ['Status', a.status],
    r.paidTo === null
      ? ['Advert output', `${r.advertRef ?? '-'} at ${deployment.advert.address}, deposit ${lovelaceToAda(r.depositLovelace)} AP3X`]
      : ['Deposit back', `${lovelaceToAda(r.depositLovelace)} AP3X to ${r.paidTo}`],
  ];
}
const advertJson = (r: AdvertBuild) => ({
  advert_ref: r.advertRef, did: r.did, agent_id: r.agentId, supplier_pkh: r.advert.supplier_pkh, capability_id: r.advert.capability_id, status: r.advert.status,
  advertised_at: r.advert.advertised_at, deposit_lovelace: r.depositLovelace, paid_to: r.paidTo,
});

/** Advert terms from the tool's fields; `detail_hash` defaults to the hash of an empty manifest when there is no detail_uri. */
function termsFrom(a: {
  capability_id: string; model: string; max_output_tokens: number; max_processing_ms: number; price_lovelace: number; supplier_bond_lovelace: number;
  buyer_bond_lovelace: number; endpoint_url: string; detail_uri?: string; detail_hash?: string;
}): AdvertTerms {
  const detailUri = a.detail_uri ?? '';
  if (detailUri !== '' && a.detail_hash === undefined) throw new Error('detail_hash is needed with a detail_uri: it is the sha256 of the manifest there, which buyers check.');
  return {
    capabilityId: a.capability_id, model: a.model, maxOutputTokens: a.max_output_tokens, maxProcessingMs: a.max_processing_ms,
    priceLovelace: BigInt(a.price_lovelace), supplierBondLovelace: BigInt(a.supplier_bond_lovelace), buyerBondLovelace: BigInt(a.buyer_bond_lovelace),
    endpointUrl: a.endpoint_url, detailUri, detailHash: (a.detail_hash ?? EMPTY_DETAIL_HASH).toLowerCase(),
  };
}

export function registerMarketplaceBuildTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: MaybeDeploymentFor) {
  server.tool(
    "vector_build_marketplace_post_escrow",
    "Build an UNSIGNED transaction that hires a supplier on the Vector agents marketplace: locks price + supplier bond + buyer bond in escrow for the given advert and commits a hash of your payload. Template-contract suppliers only in this release. Takes no key material. After it confirms, call vector_marketplace_send_job with the returned escrow_ref, the same payload (the JSON block echoes it verbatim) and your wallet address as buyerAddress. The transaction is valid for at most 180 s, so sign and submit it at once. " +
      "Both advert layouts: an identity-marketplace advert (it names an agent, did:vector) must be listed by the marketplace indexer and its agent must pass the listing rule on chain; its escrow names the agent and refunds to your address, so anybody can Reclaim it to you after deliver_by. Price + both bonds above 10,000 AP3X is refused (value cap F-29). " + SIGN_COPY,
    {
      changeAddress: z.string().describe("Your wallet address (pays the lock and fees; receives the bond back on Accept). Get it from vector_signer_get_address."),
      advert_ref: z.string().describe("Advert '<txid>#<index>' from vector_marketplace_list_suppliers"),
      payload: z.string().min(1).describe("The job payload string exactly as you will send it (for JSON, pass the JSON text)"),
      deliver_by_ms: z.number().int().optional().describe("Optional POSIX ms deadline; default now + advert window + 180 s"),
    },
    async ({ changeAddress, advert_ref, payload, deliver_by_ms }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildPostEscrow(lucid, provider, { changeAddress, advertRef: advert_ref, payload, deliverByMs: deliver_by_ms }, fetch, deployment);
        const deliverBy = isoOrRaw(r.deliverBy);
        const did = r.agentId === null ? null : `did:vector:${r.agentId}`;
        // planAccept raises a supplier payout below the minimum output to it, and the raise comes out of the buyer's side: said here, before the Post is signed.
        const supplierRaise = supplierPayoutRaised(r.priceLovelace, r.supplierBondLovelace) ? ' (the supplier payout is raised to the 1-unit minimum out of your return)' : '';
        // supplierPkh, endpointHost and capabilityId come out of an advert, which anyone can write: all three go through cell().
        const warning = r.collateralKept ? '' : '\n**Warning:** no pure 5-unit output was kept aside for the Accept/Reclaim script spends; make sure your wallet still has one afterwards (the change of this Post counts if it is a pure output of at least 5 units).';
        const ifNoSubmit = r.layout === 'identity'
          ? `If it never submits, anybody may Reclaim after ${deliverBy}, and everything returns to your address; if the agent's record is revoked or retired first, anybody may return everything at once with vector_build_marketplace_refund_revoked.`
          : `If it never submits, Reclaim after ${deliverBy} returns everything.`;
        const md = `# Unsigned Escrow Post Built (Not Submitted)\n\n` +
          `**Hiring:** \`${cell(r.capabilityId)}\` from supplier key \`${cell(r.supplierPkh)}\`, endpoint host \`${cell(r.endpointHost)}\`\n` +
          agentLine(did) +
          `**Escrow ref (after submit):** \`${r.escrowRef}\`\n` +
          `**Locked:** ${lovelaceToAda(r.lockLovelace)} = price ${lovelaceToAda(r.priceLovelace)} + supplier bond ${lovelaceToAda(r.supplierBondLovelace)} + buyer bond ${lovelaceToAda(r.buyerBondLovelace)} (floored to the min-UTxO of the Submitted datum). ` +
          // escrow.ak: Accept pays the supplier price + supplier bond and the buyer its bond; once the window has passed, Release lets the supplier take at least all three (a floor, not a ceiling)
          `If the supplier submits, accept within ${ACCEPT_WINDOW_S} s: it receives price + supplier bond and your buyer bond (plus any floor excess) returns${supplierRaise}. ` +
          `Miss that window and the supplier may Release and ${RELEASE_TAKE}. ` +
          `${ifNoSubmit}\n` +
          `**Deliver by:** ${deliverBy}\n**Valid until:** ${isoOrRaw(r.validTo)} (sign and submit before then: a Post that landed later would give the supplier less than its window, so it is not valid after this time and has to be built again)\n` +
          `**Payload hash:** \`${r.promptHash}\`\n**Estimated fee:** ${r.feeAda}\n**Collateral kept aside:** ${r.collateralKept ? 'yes' : 'no'}${warning}\n` +
          `${signersLine(r.requiredSigners)}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\nKeep the payload byte-identical for vector_marketplace_send_job (the JSON block below carries it verbatim). ${SIGN_COPY}`;
        // `payload` is echoed as given: an assistant that carries the block from here to vector_marketplace_send_job sends the committed bytes.
        return text(withJson(md, {
          escrow_ref: r.escrowRef, lock_lovelace: r.lockLovelace, deliver_by: r.deliverBy, valid_to: r.validTo, prompt_hash: r.promptHash, payload, tx_hash: r.txHash, fee: r.fee, collateral_kept: r.collateralKept,
          layout: r.layout, ...(r.agentId === null ? {} : { agent_id: r.agentId, did }), required_signers: signersJson(r.requiredSigners),
        }));
      } catch (err) { return fail('build escrow post', err, ['The wallet needs the lock plus about 1 unit for fees, and one pure 5-unit output kept as collateral', 'Check the advert is still Active with vector_marketplace_get_supplier']); }
    },
  );

  server.tool(
    "vector_build_marketplace_accept",
    "Build an UNSIGNED transaction that accepts a Submitted marketplace job: pays the supplier price + supplier bond and returns your buyer bond (to the escrow's refund address when an identity-marketplace escrow names one). Only the buyer can accept, within 600 s of the supplier's Submit, in both escrow layouts. If a receipt has arrived, verify it first with vector_marketplace_verify_receipt. It builds only for a Submitted escrow and prints the seconds left in the window, so it is also the way to check where an escrow stands (vector_marketplace_get_job cannot see where it stands now): a refusal names the state when one was found. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("The buyer wallet address that posted the escrow"),
      escrow_ref: z.string().describe("The escrow_ref returned by vector_build_marketplace_post_escrow"),
    },
    async ({ changeAddress, escrow_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildAccept(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref, deployment });
        const warn = r.secondsLeft < 120 ? `\n\n**Hurry:** only ${r.secondsLeft} s remain in the accept window.` : '';
        const bondTo = r.buyerAddress === changeAddress ? '' : ` to the escrow's refund address ${r.buyerAddress}`;
        // The escrow is named by its canonical ref, and the key the Accept pays by the datum the lineage resolved (not by what the caller typed).
        const md = `# Unsigned Accept Built (Not Submitted)\n\n**Escrow:** \`${r.escrowRef}\`\n${agentLine(r.agentDid)}` +
          `**Supplier receives:** ${lovelaceToAda(r.supplierLovelace)}${raised(r.supplierRaised)} at supplier key \`${cell(r.supplierPkh)}\`\n` +
          `**Your bond back:** ${lovelaceToAda(r.buyerLovelace)}${raised(r.buyerRaised)}${bondTo}\n**Estimated fee:** ${r.feeAda}\n${signersLine(r.requiredSigners)}${warn}\n\n` +
          `**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { ...spendJson(r), supplier_pkh: r.supplierPkh, supplier_lovelace: r.supplierLovelace, buyer_lovelace: r.buyerLovelace, buyer_address: r.buyerAddress, seconds_left: r.secondsLeft }));
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
    "Build an UNSIGNED transaction that reclaims your escrow after deliver_by when the supplier never submitted (state Open or Claimed): everything returns to you. An identity-marketplace escrow with a refund address (every one that vector_build_marketplace_post_escrow posts in that layout) can be reclaimed by anybody: the caller's wallet pays the fee, and everything the escrow holds goes to the refund address. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("The buyer wallet address that posted the escrow (for an identity-marketplace escrow with a refund address: any wallet, which pays the fee)"),
      escrow_ref: z.string().describe("The escrow_ref returned by vector_build_marketplace_post_escrow"),
    },
    async ({ changeAddress, escrow_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildReclaim(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref, deployment });
        const returned = r.fullRefund
          ? `**Returned:** ${lovelaceToAda(r.buyerLovelace)}${r.buyerRaised ? ' (raised to the ledger minimum of the refund output)' : ''}: everything the escrow holds, to its refund address ${r.buyerAddress}; anybody may submit this Reclaim\n`
          : `**Returned to you:** ${lovelaceToAda(r.buyerLovelace)}${raised(r.buyerRaised)} (price + supplier bond + buyer bond), and whatever else the escrow holds, as change\n`;
        const md = `# Unsigned Reclaim Built (Not Submitted)\n\n**Escrow:** \`${r.escrowRef}\`\n${agentLine(r.agentDid)}${returned}` +
          `**Estimated fee:** ${r.feeAda}\n${signersLine(r.requiredSigners)}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { ...spendJson(r), buyer_lovelace: r.buyerLovelace, buyer_address: r.buyerAddress, full_refund: r.fullRefund }));
      } catch (err) {
        return fail('build reclaim', err, [
          'Reclaim opens only after deliver_by',
          `A Submitted escrow cannot be reclaimed: accept within ${ACCEPT_WINDOW_S} s of Submit; after that the supplier may Release and ${RELEASE_TAKE}`,
        ]);
      }
    },
  );

  server.tool(
    "vector_build_marketplace_release",
    "Build an UNSIGNED transaction that releases a Submitted escrow to its supplier once the buyer's 600 s accept window has passed: payment + supplier bond + buyer bond go to your wallet, whose payment key must be the escrow's supplier key (it signs). Both escrow layouts. Takes no key material.",
    {
      changeAddress: z.string().describe("The supplier's wallet address: its payment key must be the escrow's supplier_pkh. It receives the payout and pays the fee"),
      escrow_ref: z.string().describe("The escrow's ref '<txid>#<index>' (its Post output)"),
      valid_minutes: zValidMinutes,
    },
    async ({ changeAddress, escrow_ref, valid_minutes }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildRelease(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref, validMinutes: valid_minutes, deployment });
        const facts: Array<[string, string]> = [
          ['Escrow', `\`${r.escrowRef}\` (${r.layout} layout)`],
          ...(r.agentDid === null ? [] : [['Agent', r.agentDid] as [string, string]]),
          ['Supplier receives', `${lovelaceToAda(r.supplierLovelace)} AP3X${raised(r.supplierRaised)} (payment + both bonds) at ${changeAddress}, and whatever else the escrow holds as change`],
        ];
        return text(buildText('Escrow Release Built', facts, r, { escrow_ref: r.escrowRef, layout: r.layout, agent_did: r.agentDid, supplier_lovelace: r.supplierLovelace }));
      } catch (err) {
        return fail('build release', err, [
          `Release opens ${ACCEPT_WINDOW_S} s after the Submit, when the buyer's accept window has passed; until then only the buyer can Accept`,
          "The wallet's payment key must be the escrow's supplier key, and the wallet needs one pure 5-unit output as collateral",
        ]);
      }
    },
  );

  server.tool(
    "vector_build_marketplace_refund_revoked",
    "Build an UNSIGNED RefundRevoked of an identity-marketplace escrow (Part 2 Section 6.1): anybody may submit it, before or after deliver_by, when the record of the escrow's agent is Revoked or Retired (escrow Open or Claimed), or Revoked with invalid_from at or before submitted_at (escrow Submitted). Everything the escrow holds goes to its refund address, or to the buyer key's enterprise address when it names none. Your wallet only pays the fee. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      escrow_ref: z.string().describe("The escrow's ref '<txid>#<index>' (its Post output)"),
      valid_minutes: zValidMinutes,
    },
    async ({ changeAddress, escrow_ref, valid_minutes }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = identityOnly(deploymentFor);
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildRefundRevoked(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref, validMinutes: valid_minutes, deployment });
        const facts: Array<[string, string]> = [
          ['Escrow', `\`${r.escrowRef}\``],
          ['Agent', `${r.agentDid} (record ${r.recordStatus}, read as a reference input)`],
          ['Refund', `${lovelaceToAda(r.buyerLovelace)} AP3X: everything the escrow holds, to ${r.buyerAddress}`],
        ];
        return text(buildText('RefundRevoked Built', facts, r, { escrow_ref: r.escrowRef, agent_did: r.agentDid, record_status: r.recordStatus, buyer_lovelace: r.buyerLovelace, buyer_address: r.buyerAddress }));
      } catch (err) {
        return fail('build refund of a revoked agent', err, [
          'RefundRevoked needs the agent record Revoked or Retired (Open or Claimed escrow), or Revoked with invalid_from at or before submitted_at (Submitted escrow)',
          'An escrow whose agent is still valid returns to the buyer by Reclaim after deliver_by (vector_build_marketplace_reclaim)',
          'The wallet needs about 1 AP3X for the fee and one pure output of at least 5 AP3X as collateral',
        ]);
      }
    },
  );

  const advertFields = {
    capability_id: z.string().min(1).max(64).describe("The capability id the advert offers; the agent's record must list it"),
    model: z.string().min(1).max(64).describe('The model or product name'),
    max_output_tokens: z.number().int().min(0).describe('The most output tokens of a job'),
    max_processing_ms: z.number().int().min(1).describe('How long a job may take, in ms (at most 86,400,000: a Post locks the buyer\'s funds for that window)'),
    price_lovelace: zLovelace('The price of a job'),
    supplier_bond_lovelace: zLovelace('The supplier bond (the buyer funds it; it goes to the supplier on Accept)'),
    buyer_bond_lovelace: zLovelace('The buyer bond (returns to the buyer on Accept)'),
    endpoint_url: z.string().min(1).max(256).describe('The https URL buyers send jobs to'),
    detail_uri: z.string().max(256).optional().describe('Where the manifest is (default none)'),
    detail_hash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe('The sha256 of the manifest at detail_uri, 64 hex characters (needed with detail_uri; default the hash of an empty file)'),
  };

  server.tool(
    "vector_build_marketplace_advert_post",
    "Build an UNSIGNED transaction that posts an identity-marketplace advert (Part 2 Section 6.2): the advert names the agent (did:vector) whose record lists the supplier key with the transaction purpose and the capability. The builder checks the listing rule on chain (the record is live, independent and Active, and lists the key and the capability), so the indexer lists the advert. The supplier key must sign (the listing rule needs its signature). Takes no key material.",
    {
      changeAddress: zChangeAddress,
      did: zDid('the agent the advert offers'),
      supplier_key_hash: zKeyHash("The supplier key that claims and submits the jobs (default your wallet's key)").optional(),
      ...advertFields,
      deposit_lovelace: zLovelace('The AP3X the advert locks (default 2 AP3X, raised to the ledger minimum); it returns on retirement').optional(),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = identityOnly(deploymentFor);
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, a.changeAddress);
        const r = await buildAdvertPost({ lucid, provider, deployment }, {
          changeAddress: a.changeAddress, agentId: identifierOf(a.did), supplierPkh: a.supplier_key_hash?.toLowerCase(), terms: termsFrom(a),
          depositLovelace: a.deposit_lovelace === undefined ? undefined : BigInt(a.deposit_lovelace), validMinutes: a.valid_minutes,
        });
        return text(buildText('Advert Post Built', advertFacts(r, deployment), r, advertJson(r)));
      } catch (err) { return fail('build advert post', err, ADVERT_TIPS); }
    },
  );

  server.tool(
    "vector_build_marketplace_advert_update",
    "Build an UNSIGNED UpdateAdvert of an identity-marketplace advert: changes the fields you pass and keeps the others; the supplier key and the agent stay (the contract keeps them), advertised_at moves to now. An advert that stays Active must still pass the listing rule; status Retired takes it off the market but keeps the output. The supplier key signs. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      advert_ref: zAdvertRef,
      capability_id: advertFields.capability_id.optional(), model: advertFields.model.optional(), max_output_tokens: advertFields.max_output_tokens.optional(),
      max_processing_ms: advertFields.max_processing_ms.optional(), price_lovelace: advertFields.price_lovelace.optional(),
      supplier_bond_lovelace: advertFields.supplier_bond_lovelace.optional(), buyer_bond_lovelace: advertFields.buyer_bond_lovelace.optional(),
      endpoint_url: advertFields.endpoint_url.optional(), detail_uri: advertFields.detail_uri, detail_hash: advertFields.detail_hash,
      status: z.enum(['Active', 'Retired']).optional().describe('The new status (default unchanged)'),
      deposit_lovelace: zLovelace('The AP3X of the new advert output (default what the advert holds, raised to the ledger minimum)').optional(),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = identityOnly(deploymentFor);
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, a.changeAddress);
        const big = (n: number | undefined) => (n === undefined ? undefined : BigInt(n));
        const r = await buildAdvertUpdate({ lucid, provider, deployment }, {
          changeAddress: a.changeAddress, advertRef: a.advert_ref, validMinutes: a.valid_minutes, depositLovelace: big(a.deposit_lovelace),
          changes: {
            capabilityId: a.capability_id, model: a.model, maxOutputTokens: a.max_output_tokens, maxProcessingMs: a.max_processing_ms,
            priceLovelace: big(a.price_lovelace), supplierBondLovelace: big(a.supplier_bond_lovelace), buyerBondLovelace: big(a.buyer_bond_lovelace),
            endpointUrl: a.endpoint_url, detailUri: a.detail_uri, detailHash: a.detail_hash?.toLowerCase(), status: a.status,
          },
        });
        return text(buildText('Advert Update Built', advertFacts(r, deployment), r, advertJson(r)));
      } catch (err) { return fail('build advert update', err, ADVERT_TIPS); }
    },
  );

  server.tool(
    "vector_build_marketplace_advert_retire",
    "Build an UNSIGNED RetireAdvert of an identity-marketplace advert: spends the advert and pays its deposit to the supplier key (to your wallet when its key is the supplier key). The supplier key signs. Takes no key material.",
    { changeAddress: zChangeAddress, advert_ref: zAdvertRef, valid_minutes: zValidMinutes },
    async ({ changeAddress, advert_ref, valid_minutes }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = identityOnly(deploymentFor);
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildAdvertRetire({ lucid, provider, deployment }, { changeAddress, advertRef: advert_ref, validMinutes: valid_minutes });
        return text(buildText('Advert Retirement Built', advertFacts(r, deployment), r, advertJson(r)));
      } catch (err) { return fail('build advert retirement', err, ADVERT_TIPS); }
    },
  );
}
