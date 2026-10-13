// packages/builder/test/fixtures/transport-world.fixture.ts
// The world the job-transport tests run in, shared by marketplace-transport.test.ts (the module) and
// marketplace-transport-tools.test.ts (the tools): one escrow (Open, Claimed, Submitted, or finished with nothing left on the chain),
// posted from OWN_ADDRESS with the prompt hash of its payload, its advert, and a supplier. The node and Koios describe one chain
// (fixtures/escrow-koios.fixture.ts `world`), the advert is answered the way Koios utxo_info answers it, and the supplier is a fake
// `fetch` that records what it was sent. No network and no DNS: the supplier is an IP literal, which safeFetch checks directly.
import { createHash } from 'node:crypto';
import { CML, Constr, Data, fromText, getAddressDetails } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { ADVERT_ADDRESS, ESCROW_ADDRESS } from '../../src/vector/marketplace-constants.ts';
import { canonicalize, decodeEscrowDatum, encodeEscrowDatum, promptHashForPayload } from '../../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../../src/vector/marketplace-datum.ts';
import { sendJob, getJob, verifyJob } from '../../src/vector/marketplace-transport.ts';
import { ADVERT_DATUM_HEX, ADVERT_REF, ESCROW_LOCKED_LOVELACE, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './marketplace.fixture.ts';
import { OWN_ADDRESS } from './fixture-provider.ts';
import { world, escrowAt, ESCROW_TX, CLAIM_TX, SUBMIT_TX, DECOY_TX, SUPPLIER_ADDRESS, GENUINE_TXS, DECOY_TXS } from './escrow-koios.fixture.ts';
import type { SpentOutputs } from './escrow-koios.fixture.ts';

export const KOIOS = 'https://koios.example';
export const PAYLOAD = 'summarise the filing';
/** An IP literal in a public (documentation) range: safeFetch checks it directly, so no DNS is touched. */
export const SUPPLIER = 'https://203.0.113.7';
export const JOB_ID = '3f2b8c1e-5a47-4d6e-9b0a-7c1d2e3f4a5b';
export const HOSTILE = '{"error":"db password=hunter2 at https://internal.koios.example"}';

export type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Answer = Response | Promise<Response>;
export const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
export const accepted = (over: Record<string, unknown> = {}) => reply(202, { job_id: JOB_ID, status: 'accepted', escrow_ref: ESCROW_REF, ...over });

/** A fake supplier: records every request it is sent and answers with `answer` (the init safeFetch gave the request comes second). */
export function supplier(answer: (call: Call, init: RequestInit) => Answer = () => accepted()) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call: Call = { url: String(url), method: String(init?.method ?? 'GET'), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    return answer(call, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** The wallet the escrows of these tests were posted from: a base address, so the buyer key is the payment part of it. */
export const BUYER_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
export const POSTED_BASE: EscrowDatum = { ...decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), buyer_pkh: BUYER_PKH };
const ADVERT_TX = ADVERT_REF.slice(0, 64);
const FUNDING_INPUT = `${'ac'.repeat(32)}#0`;
/** The inputs of the Post transaction, as Koios tx_info lists them, for the funders that have any. */
const POST_INPUTS: Record<string, SpentOutputs | undefined> = {
  buyer: [[FUNDING_INPUT, OWN_ADDRESS]],
  stranger: [[FUNDING_INPUT, SUPPLIER_ADDRESS]],
  'stranger-and-buyer': [[FUNDING_INPUT, SUPPLIER_ADDRESS], [`${'ad'.repeat(32)}#1`, OWN_ADDRESS]],
};
export const MAY_HAVE_CLAIMED = ' It may have claimed the escrow anyway, so check its state before sending again; if it stays Open, reclaim it after deliver_by.';
/** The live advert with the capability, the endpoint or the status changed, re-encoded. */
function advertDatum(over: { capability_id?: string; endpoint_url?: string; status?: 'Active' | 'Retired' }): string {
  const c = Data.from(ADVERT_DATUM_HEX) as Constr<Data>;
  if (over.capability_id !== undefined) c.fields[1] = fromText(over.capability_id);
  if (over.endpoint_url !== undefined) c.fields[8] = fromText(over.endpoint_url);
  if (over.status === 'Retired') c.fields[12] = new Constr(1, []);
  return Data.to(c);
}

export interface Scenario {
  capability?: string; endpoint?: string; escrow?: 'open' | 'claimed' | 'submitted' | 'finished';
  /**
   * The ref the caller names: the Post output (default), the output the Claim made (a later output of the same escrow; needs
   * escrow: 'claimed'), or an output in the Accepted state, which is all there is of the escrow on the chain.
   */
  names?: 'post' | 'claimed-output' | 'accepted-output';
  /** A copy of the escrow's fields left at the escrow credential by a transaction that spent no escrow output, besides the escrow's own outputs. */
  decoy?: boolean;
  /** The payload the escrow commits to, as its prompt_hash (default PAYLOAD). */
  committed?: string;
  /** The supplier_pkh of the escrow's datum (default: the fixture advert's supplier). The signing key of a receipt test hashes to it. */
  supplierPkh?: string;
  /** The result_receipt_hash the supplier wrote in its Submit, in the Submitted datum (default 'cd' repeated). */
  receiptHash?: string;
  /** Koios reports the Submitted output as spent when it is read by its ref (the Accept landed after the lineage was resolved). */
  submittedSpent?: boolean;
  /**
   * Who funded the Post transaction, as Koios tx_info reports its inputs: the buyer (default), a stranger only, a stranger and the
   * buyer, nobody Koios knows (the transaction is unknown to it), or Koios failing to answer ('koios-error' needs escrow: 'open'
   * because every tx_info call fails; 'unreachable' fails only the question about the Post transaction).
   */
  funder?: 'buyer' | 'stranger' | 'stranger-and-buyer' | 'unknown' | 'koios-error' | 'unreachable';
  advert?: { status?: 'Active' | 'Retired'; spent?: boolean; spentUnreported?: boolean; address?: string; missing?: boolean; httpStatus?: number; unreachable?: boolean };
  answer?: (call: Call, init: RequestInit) => Answer;
}
/**
 * One escrow (Open, Claimed, Submitted, or finished with nothing left on the chain), posted from OWN_ADDRESS with the prompt hash of
 * its payload, its advert, and a supplier. The node and Koios are built from one list of UTxOs (`world`); the advert read is answered
 * on top of Koios (and counted, with the URL it went to); whatever else is fetched is the supplier.
 */
export function scenario(o: Scenario = {}) {
  const capability = o.capability ?? 'identity.history.report.v1';
  const posted: EscrowDatum = { ...POSTED_BASE, supplier_pkh: o.supplierPkh ?? POSTED_BASE.supplier_pkh, capability_id: capability, prompt_hash: promptHashForPayload(o.committed ?? PAYLOAD) };
  const claimed: EscrowDatum = { ...posted, state: 'Claimed' };
  const submitted: EscrowDatum = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: o.receiptHash ?? 'cd'.repeat(32), state: 'Submitted' };
  const state = o.escrow ?? 'open';
  const accepted: EscrowDatum = { ...posted, state: 'Accepted' };
  const own: UTxO[] = o.names === 'accepted-output'
    ? [escrowAt(CLAIM_TX, accepted)]
    : { open: [escrowAt(ESCROW_TX, posted)], claimed: [escrowAt(CLAIM_TX, claimed)], submitted: [escrowAt(SUBMIT_TX, submitted)], finished: [] }[state];
  const chain: UTxO[] = [...own, ...(o.decoy ? [escrowAt(DECOY_TX, claimed)] : [])];
  const funder = o.funder ?? 'buyer';
  const postInputs = POST_INPUTS[funder]; // undefined: Koios does not know the Post transaction
  const koiosOptions = { txs: { ...GENUINE_TXS, ...(o.decoy ? DECOY_TXS : {}), ...(postInputs ? { [ESCROW_TX]: postInputs } : {}) }, ...(funder === 'koios-error' ? { txStatus: 502 } : {}) };
  const laterOutputRow = (datum: EscrowDatum) => ({ tx_hash: CLAIM_TX, tx_index: 0, address: ESCROW_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), is_spent: false, inline_datum: { bytes: encodeEscrowDatum(datum) } });
  // utxo_info answers with these rows for any ref and each reader picks its own: the Post output, and the Submitted one when there is one
  const outputRow = (txHash: string, datum: EscrowDatum, spent: boolean) => ({ tx_hash: txHash, tx_index: 0, address: ESCROW_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), is_spent: spent, inline_datum: { bytes: encodeEscrowDatum(datum) } });
  const w = o.names === 'claimed-output' ? world(chain, { ...koiosOptions, rows: [laterOutputRow(claimed)] })
    : o.names === 'accepted-output' ? world(chain, { ...koiosOptions, rows: [laterOutputRow(accepted)] })
    : world(chain, { ...koiosOptions, rows: [outputRow(ESCROW_TX, posted, state !== 'open'), ...(state === 'submitted' ? [outputRow(SUBMIT_TX, submitted, o.submittedSpent ?? false)] : [])] });
  const advert = o.advert ?? {};
  const advertRow: Record<string, unknown> = {
    tx_hash: ADVERT_TX, tx_index: 0, address: advert.address ?? ADVERT_ADDRESS, value: '2000000', is_spent: advert.spent ?? false,
    inline_datum: { bytes: advertDatum({ capability_id: capability, endpoint_url: o.endpoint ?? SUPPLIER, status: advert.status }) },
  };
  if (advert.spentUnreported) delete advertRow.is_spent; // Koios leaves the field out when it does not know
  const sup = supplier(o.answer);
  const advertUrls: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const u = String(url);
    if (u.endsWith('/api/v1/utxo_info') && (JSON.parse(init.body)._utxo_refs as string[]).includes(ADVERT_REF)) {
      advertUrls.push(u);
      if (advert.unreachable) throw new TypeError('fetch failed: connect ECONNREFUSED internal.koios.example:443 password=hunter2');
      if (advert.httpStatus) return new Response(HOSTILE, { status: advert.httpStatus });
      return new Response(JSON.stringify(advert.missing ? [] : [advertRow]), { status: 200 });
    }
    if (u.endsWith('/api/v1/tx_info') && funder === 'unreachable' && (JSON.parse(init.body)._tx_hashes as string[]).includes(ESCROW_TX)) {
      throw new TypeError('fetch failed: connect ECONNREFUSED internal.koios.example:443 password=hunter2');
    }
    if (u.includes('/api/v1/')) return w.koios.f(url, init);
    return sup.f(url, init as RequestInit);
  }) as unknown as typeof fetch;
  const named = o.names === 'claimed-output' || o.names === 'accepted-output' ? `${CLAIM_TX}#0` : ESCROW_REF;
  return {
    sup, koios: w.koios, posted, named, advertUrls: () => advertUrls, advertReads: () => advertUrls.length,
    /** The tx_info questions asked about the Post transaction (who funded it). */
    fundingChecks: () => w.koios.calls.filter((c) => c.path === '/api/v1/tx_info' && (c.body._tx_hashes as string[]).includes(ESCROW_TX)).map((c) => c.body),
    send: (over: Partial<Parameters<typeof sendJob>[2]> = {}) => sendJob(w.node, KOIOS, { escrowRef: named, payload: PAYLOAD, buyerAddress: OWN_ADDRESS, ...over }, fetchImpl),
    poll: (over: Partial<Parameters<typeof getJob>[1]> = {}) => getJob(KOIOS, { escrowRef: named, jobId: JOB_ID, buyerAddress: OWN_ADDRESS, ...over }, fetchImpl),
    verify: (p: Omit<Parameters<typeof verifyJob>[2], 'escrowRef'> & { escrowRef?: string }) => verifyJob(w.node, KOIOS, { escrowRef: named, ...p }, fetchImpl),
    /** What the tools are handed in a handler test: the node, and the fetch that answers for Koios, the advert and the supplier. */
    node: w.node, fetchImpl,
  };
}


// ─── receipts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A receipt as a template supplier makes it: the eight fields, Ed25519 over canonicalize(receipt) by the supplier's key, and a
// result_receipt_hash on chain that is sha256(canonicalize({receipt, signature})).
export const SUPPLIER_KEY = CML.PrivateKey.generate_ed25519();
export const OTHER_KEY = CML.PrivateKey.generate_ed25519();
export const pkhOf = (sk: CML.PrivateKey) => sk.to_public().hash().to_hex();
export const pubHexOf = (sk: CML.PrivateKey) => Buffer.from(sk.to_public().to_raw_bytes()).toString('hex');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const RESULT = 'the output';
export function receiptOf(sk: CML.PrivateKey, ref: string, result = RESULT, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { prompt_hash: promptHashForPayload(PAYLOAD), response_hash: sha256(result), model: 'echo-v1', prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 12, supplier_pkh: pkhOf(sk), escrow_ref: ref, ...over };
}
export const signWith = (sk: CML.PrivateKey, receipt: unknown) => sk.sign(Buffer.from(canonicalize(receipt), 'utf8')).to_hex();
export const committedHash = (receipt: unknown, signature: string) => sha256(canonicalize({ receipt, signature }));
