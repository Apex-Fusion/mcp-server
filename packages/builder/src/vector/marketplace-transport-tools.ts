// packages/builder/src/vector/marketplace-transport-tools.ts
// The marketplace transport tools: send a job to the supplier of a posted escrow, poll it, and check the receipt it returns. They are
// the only marketplace tools that call a URL taken from chain data (the endpoint of the advert an escrow names), and they do it only
// through safeFetch (marketplace-transport.ts). Nothing here builds, signs or submits a transaction. Everything a supplier says is
// shown as data: one escaped line in the markdown (cell), verbatim in the fenced JSON block; the result, which is the point of the
// job, is shown in a fence it cannot close.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from '@lucid-evolution/lucid';
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { withJson } from './marketplace-indexer.js';
import { formatOutRef, parseOutRef } from './marketplace-datum.js';
import { sendJob, getJob, verifyJob } from './marketplace-transport.js';
import type { Check, ReceiptChecks, VerifiedJob } from './marketplace-transport.js';
import { text, fail, cell, ACCEPT_WINDOW_S, RELEASE_TAKE } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';

/** How much of a result the markdown shows. The fenced JSON block always carries all of it. */
const RESULT_VIEW_CHARS = 4_000;
/** What these tools cannot know, in the words every description uses (see the residual in marketplace-transport.ts). */
const BUYER_NOTE = "This tool trusts the buyer address and escrow ref your assistant passes; keep its tool use scoped to escrows you posted. A client-side binding to your signer key is planned.";
/** What a missed accept window costs, as the build tools say it. */
const ACCEPT_CLOCK = `Accept must land within ${ACCEPT_WINDOW_S} s of the supplier's Submit; after that the supplier may Release and ${RELEASE_TAKE}.`;

/** The canonical form of an escrow ref the module has already accepted. */
const canonical = (ref: string): string => { const r = parseOutRef(ref); return formatOutRef(r.txHash, r.outputIndex); };

/** `body` in a code fence that nothing inside it can close: longer than any run of backticks in the text. */
function fenced(body: string): string {
  const longest = (body.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

/** The receipt as the assistant passed it: an object, or the JSON text of one. */
function receiptOf(receipt: string | Record<string, unknown>): unknown {
  if (typeof receipt !== 'string') return receipt;
  try { return JSON.parse(receipt); } catch { throw new Error('the receipt text is not valid JSON; pass the receipt exactly as vector_marketplace_get_job returned it.'); }
}

// The five checks, by the design's names and in its order.
const CHECK_LABELS: Record<keyof ReceiptChecks, string> = {
  escrow_ref_matches: '`receipt.escrow_ref` equals the escrow ref',
  response_hash_matches: '`sha256(result)` equals `response_hash`',
  supplier_key_matches: "the supplier public key hashes to `receipt.supplier_pkh` and to the escrow datum's `supplier_pkh`",
  signature_valid: 'Ed25519 over `canonicalize(receipt)` verifies',
  on_chain_hash_matches: "the Submitted escrow datum's `result_receipt_hash` equals `sha256(canonicalize({receipt, signature}))`",
};
/** `pass`, `FAIL (why)` or `skipped (why)`. A note is a supplier-influenced sentence, so it is one escaped line. */
const resultOf = (c: Check): string => (c.state === 'pass' ? 'pass' : `${c.state === 'fail' ? 'FAIL' : 'skipped'} (${cell(c.note, 300)})`);

/** What a verdict says to do, with nothing in it that calls a receipt verified unless all five checks passed. */
function verdictAdvice(v: VerifiedJob): string {
  if (v.verdict === 'verified') {
    return "All five checks passed: the receipt is for this escrow, it hashes the result text you gave, it is signed by the key that belongs to the escrow's supplier, and the hash of that signed receipt is the one the supplier committed on chain. That says nothing about whether the result is any good: read it before you accept. " +
      `Next: vector_build_marketplace_accept, which must land within ${ACCEPT_WINDOW_S} s of the supplier's Submit.`;
  }
  if (v.verdict === 'failed') {
    const hint = v.checks.response_hash_matches.state === 'fail' ? ' If the result text may have been shortened or edited, pass it again exactly as it is in the JSON block of vector_marketplace_get_job.' : '';
    return `At least one check failed: do not accept the job on this receipt.${hint} ${ACCEPT_CLOCK}`;
  }
  return `Nothing failed, but not every check ran (see the rows marked skipped), so this is not a verification: run it again with what is missing before you accept. ${ACCEPT_CLOCK}`;
}

export function registerMarketplaceTransportTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider) {
  server.tool(
    "vector_marketplace_send_job",
    "Send the job payload to the supplier of a posted escrow and get back a job id. Call it once the post is confirmed (vector_await_transaction). Template-contract suppliers only in this release. escrow_ref is the one vector_build_marketplace_post_escrow returned. buyerAddress is required and must be the wallet that posted AND funded the escrow (escrows funded from another key are refused). payload must be byte-identical to the one given at post time. The payload goes to the endpoint named by the escrow's advert, and the call waits up to 90 s for the supplier to answer. Then poll with vector_marketplace_get_job. " + BUYER_NOTE,
    {
      escrow_ref: z.string().describe("The escrow_ref that vector_build_marketplace_post_escrow returned, once its transaction is confirmed"),
      payload: z.string().min(1).describe("The same payload string you gave vector_build_marketplace_post_escrow, byte for byte"),
      buyerAddress: z.string().describe("The wallet address that posted AND funded the escrow (vector_signer_get_address). Escrows funded from another key are refused"),
    },
    async ({ escrow_ref, payload, buyerAddress }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const r = await sendJob(providerFor(), VECTOR_KOIOS_URL, { escrowRef: escrow_ref, payload, buyerAddress });
        const ref = canonical(escrow_ref);
        const md = `# Job sent\n\n**Job id:** \`${r.jobId}\` · **status:** ${cell(r.status, 100)}\n**Escrow:** \`${ref}\` · **capability:** \`${cell(r.capabilityId)}\`\n\n` +
          `The supplier answered with this job id. Poll with vector_marketplace_get_job { escrow_ref, job_id, buyerAddress } every few seconds until it returns a result and a receipt. ` +
          `Nothing is verified yet: check the receipt with vector_marketplace_verify_receipt before you accept.`;
        return text(withJson(md, { job_id: r.jobId, status: r.status, escrow_ref: ref, capability_id: r.capabilityId }));
      } catch (err) {
        return fail('send job', err, [
          'Wait for vector_await_transaction to confirm the post, and pass the escrow_ref the post returned',
          'buyerAddress must be the wallet that posted and funded the escrow, and payload exactly the one you posted with',
          'If the supplier cannot take the job, the escrow stays as it is until deliver_by; vector_build_marketplace_reclaim returns it after that',
        ]);
      }
    },
  );

  server.tool(
    "vector_marketplace_get_job",
    "Poll a marketplace job by escrow_ref and job_id. Returns pending, failed, or done with the result and the supplier's signed receipt. Template-contract suppliers only in this release. Works while the escrow is Open, Claimed or Submitted, and after it has been accepted or released. A failed answer can carry the reason malformed_response (the supplier said 200 without a receipt) or escrow_mismatch (its answer was for another escrow). buyerAddress is required, as for vector_marketplace_send_job. The poll waits up to 20 s. A job id is a bearer token for its result: pass it only with the escrow it came from. " + BUYER_NOTE,
    {
      escrow_ref: z.string().describe("The escrow_ref that vector_build_marketplace_post_escrow returned"),
      job_id: z.string().describe("The job_id that vector_marketplace_send_job returned"),
      buyerAddress: z.string().describe("The wallet address that posted AND funded the escrow (vector_signer_get_address). Escrows funded from another key are refused"),
    },
    async ({ escrow_ref, job_id, buyerAddress }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const r = await getJob(VECTOR_KOIOS_URL, { escrowRef: escrow_ref, jobId: job_id, buyerAddress });
        const ref = canonical(escrow_ref);
        const v = r.view;
        if (v.state === 'pending') {
          return text(withJson(`# Job ${job_id}: pending\n\n**Status:** ${cell(v.status, 100)}\n\nThe supplier is still working. Poll again in a few seconds.`, { state: 'pending', job_id, escrow_ref: ref, status: v.status }));
        }
        if (v.state === 'failed') {
          const said = cell(v.message, 500);
          return text(withJson(
            `# Job ${job_id}: failed\n\n**Reason:** ${cell(v.reason, 100)}${said ? `\n**Supplier said:** ${said}` : ''}\n\n` +
            'The job failed; the escrow stays as it is. If it is still Open or Claimed, reclaim it after deliver_by with vector_build_marketplace_reclaim.',
            { state: 'failed', job_id, escrow_ref: ref, reason: v.reason, message: v.message },
          ));
        }
        const chars = Array.from(v.result);
        const shortened = chars.length > RESULT_VIEW_CHARS;
        const shown = shortened ? chars.slice(0, RESULT_VIEW_CHARS).join('') : v.result;
        const named = (field: string) => cell(v.receipt[field], 80);
        const md = `# Job ${job_id}: done\n\nThe supplier returned a result and a signed receipt. Nothing is verified yet.\n\n**Result:**\n\n${fenced(shown)}\n` +
          (shortened ? `\n*Shortened to the first ${RESULT_VIEW_CHARS.toLocaleString('en-US')} of ${chars.length.toLocaleString('en-US')} characters in this view; the full result is in the JSON block, and that is the text to pass to vector_marketplace_verify_receipt.*\n` : '') +
          `\n**Receipt names:** supplier key hash \`${named('supplier_pkh')}\` · escrow \`${named('escrow_ref')}\` · model \`${named('model')}\`\n` +
          `**Signature:** \`${cell(v.receiptSignature, 140)}\`\n` +
          (v.submittedRef ? `**Submitted output the supplier reports:** \`${v.submittedRef}\` (the supplier's word; vector_marketplace_verify_receipt reads the chain)\n` : '') +
          '\nNext: vector_marketplace_verify_receipt with the receipt, receipt_signature and result from the JSON block, then vector_build_marketplace_accept if the result is what you asked for.';
        return text(withJson(md, { state: 'done', job_id, escrow_ref: ref, result: v.result, receipt: v.receipt, receipt_signature: v.receiptSignature, submitted_ref: v.submittedRef, supplier_pkh: r.supplierPkh }));
      } catch (err) {
        return fail('poll job', err, [
          'Check escrow_ref and job_id, and use the buyerAddress that posted and funded the escrow',
          'The supplier may be restarting or slow; poll again in a few seconds',
        ]);
      }
    },
  );

  server.tool(
    "vector_marketplace_verify_receipt",
    "Check a template-contract supplier's receipt without trusting the supplier. Five checks, each reported pass, FAIL or skipped: (1) receipt.escrow_ref equals the escrow ref; (2) sha256 of the result text equals the receipt's response_hash; (3) the supplier's public key hashes to receipt.supplier_pkh and to the escrow's supplier_pkh; (4) the Ed25519 signature over the canonical receipt verifies; (5) the escrow's result_receipt_hash on chain equals the hash of the signed receipt. Says verified only when all five pass. Pass the result text exactly as vector_marketplace_get_job returned it (from its JSON block, not the shortened view), or check 2 is skipped. Run it before vector_build_marketplace_accept: check 5 reads the escrow's Submitted output, which is no longer there once the escrow is accepted. Read-only; the supplier's key is read from its /capability unless you pass supplier_pub_key_hex.",
    {
      escrow_ref: z.string().describe("The escrow_ref that vector_build_marketplace_post_escrow returned"),
      receipt: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The receipt object (or its JSON text) exactly as vector_marketplace_get_job returned it"),
      receipt_signature: z.string().describe("The hex Ed25519 signature exactly as vector_marketplace_get_job returned it"),
      result: z.string().optional().describe("The full result text exactly as vector_marketplace_get_job returned it (the JSON block, not the shortened view). Without it check 2 is skipped"),
      supplier_pub_key_hex: z.string().optional().describe("The supplier's public key, 64 hex characters. Normally read from the supplier's /capability; it has to hash to the escrow's supplier_pkh either way"),
    },
    async ({ escrow_ref, receipt, receipt_signature, result, supplier_pub_key_hex }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const v = await verifyJob(providerFor(), VECTOR_KOIOS_URL, {
          escrowRef: escrow_ref, receipt: receiptOf(receipt), signature: receipt_signature.trim(), result, supplierPubKeyHex: supplier_pub_key_hex?.trim() || undefined,
        });
        const rows = (Object.keys(CHECK_LABELS) as Array<keyof ReceiptChecks>).map((name, i) => `| ${i + 1} | ${CHECK_LABELS[name]} | ${resultOf(v.checks[name])} |`).join('\n');
        const md = `# Receipt check: ${v.verdict.toUpperCase()}\n\n**Escrow:** \`${v.escrowRef}\` · **supplier key hash (from the escrow):** \`${v.supplierPkh}\`\n` +
          `**Supplier key:** ${v.keyFrom === 'argument' ? 'given by you' : "read from the supplier's /capability"} · **Submitted output:** ${v.submittedRef ? `\`${v.submittedRef}\`` : 'none found'}\n\n` +
          `| # | check | result |\n|---|---|---|\n${rows}\n\n${verdictAdvice(v)}`;
        const entries = Object.entries(v.checks) as Array<[string, Check]>;
        return text(withJson(md, {
          verdict: v.verdict, escrow_ref: v.escrowRef, supplier_pkh: v.supplierPkh, supplier_key_from: v.keyFrom, submitted_ref: v.submittedRef,
          checks: Object.fromEntries(entries.map(([name, c]) => [name, c.state])),
          notes: Object.fromEntries(entries.filter(([, c]) => c.note !== '').map(([name, c]) => [name, c.note])),
        }));
      } catch (err) {
        return fail('verify receipt', err, [
          'Pass the receipt and its signature exactly as vector_marketplace_get_job returned them, and the escrow_ref the post returned',
          "If the supplier's /capability cannot be read, pass supplier_pub_key_hex",
        ]);
      }
    },
  );
}
