// packages/builder/src/vector/marketplace-lineage.ts
// Where is an escrow now? The resolver behind Accept, Reclaim and the transport tools: it follows an escrow along its spend chain on
// Koios and checks what it finds against the node. Reads only; nothing here builds, signs or submits.
import { getAddressDetails } from '@lucid-evolution/lucid';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { ESCROW_SCRIPT_HASH } from './marketplace-constants.js';
import { decodeEscrowDatum, encodeEscrowDatum, parseOutRef, formatOutRef } from './marketplace-datum.js';
import type { EscrowDatum, EscrowState } from './marketplace-datum.js';
import { koiosUtxoInfo, koiosCredentialUtxos, koiosTxInputRefs } from './marketplace-indexer.js';
import type { KoiosUtxo } from './marketplace-indexer.js';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface EscrowLineage {
  /** The datum of the output `escrowRef` names: for the ref buildPostEscrow returns, the Post output as posted (state Open). */
  posted: EscrowDatum;
  /**
   * The live UTxO (as the node holds it, at whatever address it sits) and its datum. Null when no live continuation was found:
   * the escrow is finished, or Koios has not indexed its continuation yet. It never means "finished" on its own.
   */
  current: { utxo: UTxO; datum: EscrowDatum } | null;
  /** Koios says the posted output has been spent. */
  spent: boolean;
}

/** An output Koios lists at the escrow credential whose datum carries the escrow's fields: a candidate for its continuation. */
type Candidate = { txHash: string; outputIndex: number; datum: EscrowDatum };

/**
 * What a failed Koios call may tell a caller. The messages of koiosUtxoInfo, koiosCredentialUtxos and koiosTxInputRefs name only
 * the operation and the status; any other failure (a transport error can carry the endpoint's host or URL) becomes a fixed phrase.
 * Exported for the transport module, whose advert read goes through the same Koios call.
 */
export function koiosFailure(err: unknown): string {
  const message = errorText(err);
  return /^Koios (utxo_info|credential_utxos|tx_info)/.test(message) ? message : 'Koios request failed (network error or timeout)';
}

/**
 * What a failed node call may tell a caller: the provider's own wording up to the status or code ("Ogmios request failed
 * (queryLedgerState/utxo): 503"), without the status text or a JSON-RPC message that may echo the request; anything else
 * becomes a fixed phrase.
 */
export function nodeFailure(err: unknown): string {
  const known = /^Ogmios request failed \([\w/]+\): (?:network error|invalid response|-?\d+|error)/.exec(errorText(err));
  return known ? known[0] : 'node request failed (network error or timeout)';
}

/**
 * Is this an escrow output? The validator finds the continuation of a Claim or Submit with unique_output_to_credential, so it is
 * content with the continuation at ANY address whose payment credential is the escrow script's, stake part and all. An escrow
 * output is therefore known by that credential, never by one exact address.
 */
function isEscrowAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  try {
    const credential = getAddressDetails(address).paymentCredential;
    return credential?.type === 'Script' && credential.hash === ESCROW_SCRIPT_HASH;
  } catch { return false; }
}

/** A lovelace amount as Koios writes it (decimal text), or undefined for anything else. */
const lovelaceOf = (value: unknown): bigint | undefined => (typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined);
/** What an escrow's datum says is owed between the parties: the payment and both bonds, all that Accept and Reclaim pay out. */
const owedLovelace = (d: EscrowDatum): bigint => d.payment_lovelace + d.buyer_bond_lovelace + d.supplier_bond_lovelace;
/** The candidate rule: Claim and Submit leave advert_ref, buyer_pkh, posted_at and prompt_hash as they were posted. Public, so copyable: it only picks candidates. */
const carriesFieldsOf = (posted: EscrowDatum, d: EscrowDatum): boolean =>
  d.advert_ref.txHash === posted.advert_ref.txHash && d.advert_ref.index === posted.advert_ref.index
  && d.buyer_pkh === posted.buyer_pkh && d.posted_at === posted.posted_at && d.prompt_hash === posted.prompt_hash;
/**
 * The fields escrow.ak keeps as they were across Claim and Submit (expect_unchanged_modulo_state and expect_unchanged_modulo_submit):
 * everything but state, submitted_at and result_receipt_hash. The candidate rule above looks at four of them to pick candidates;
 * the one the spend chain chooses must agree on all of them.
 *
 * What is compared are decoded values, not datum bytes: capability_id has been through toText, advert_ref.index, deliver_by and
 * posted_at through Number, and decoding can fold two different byte strings, or two integers past 2^53, into one value. That is
 * safe for what a payout is worked out from. Both key hashes are compared as the hex of their bytes, and the payment and both
 * bonds stay bigint, so none of them can differ unseen. capability_id, advert_ref.index and the two times decide no amount, and
 * the times of a genuine escrow are milliseconds since the epoch and its advert's output index is a small count, far below 2^53.
 */
const KEPT_BY_CLAIM_AND_SUBMIT: Array<[field: string, valueOf: (d: EscrowDatum) => unknown]> = [
  ['buyer_pkh', (d) => d.buyer_pkh], ['supplier_pkh', (d) => d.supplier_pkh],
  ['advert_ref', (d) => formatOutRef(d.advert_ref.txHash, d.advert_ref.index)],
  ['capability_id', (d) => d.capability_id], ['request_spec_hash', (d) => d.request_spec_hash], ['prompt_hash', (d) => d.prompt_hash],
  ['payment_lovelace', (d) => d.payment_lovelace], ['buyer_bond_lovelace', (d) => d.buyer_bond_lovelace], ['supplier_bond_lovelace', (d) => d.supplier_bond_lovelace],
  ['deliver_by', (d) => d.deliver_by], ['posted_at', (d) => d.posted_at],
];
/** The names of the fields Claim and Submit keep that `d` has changed from `earlier`, in datum order. */
const changedFieldsOf = (earlier: EscrowDatum, d: EscrowDatum): string[] =>
  KEPT_BY_CLAIM_AND_SUBMIT.filter(([, valueOf]) => valueOf(earlier) !== valueOf(d)).map(([field]) => field);
/** The same datum, field for field (the escrow encoder is canonical, so equal encodings mean equal datums). */
function sameDatum(a: EscrowDatum, b: EscrowDatum): boolean {
  try { return encodeEscrowDatum(a) === encodeEscrowDatum(b); } catch { return false; }
}
/** The states an escrow has a UTxO in, in the order Claim and Submit take it through them. Accepted, Reclaimed and Released are terminal: nothing is left at the escrow address. */
const LIVE_STATES: EscrowState[] = ['Open', 'Claimed', 'Submitted'];
const txOf = (ref: string): string => ref.slice(0, 64);
const refOf = (e: { txHash: string; outputIndex: number }): string => formatOutRef(e.txHash.toLowerCase(), e.outputIndex);
/** Refs for a refusal, sorted, at most five of them: a flood of copies must not flood the message. */
function named(list: Candidate[]): string {
  const refs = list.map(refOf).sort();
  return refs.length <= 5 ? refs.join(', ') : `${refs.slice(0, 5).join(', ')} and ${refs.length - 5} more`;
}

/**
 * Which of `candidates` descend from the escrow output `rootRef` by the spend chain, and which Koios cannot tell yet because it
 * does not know a transaction on the way (see resolveEscrowLineage). A candidate one state past the root's was made by a
 * transaction that spent the root; one two states past was made by a transaction that spent an escrow output whose own
 * transaction spent the root. Only inputs at an address with the escrow's payment credential count, so a transfer that merely
 * spends the supplier's change from the Claim is no link. One tx_info batch covers the candidates' transactions, a second the
 * step between when one is needed.
 */
async function descendantsOf(rootRef: string, root: EscrowDatum, candidates: Candidate[], koiosUrl: string, fetchImpl: typeof fetch): Promise<{ genuine: Candidate[]; unknown: Candidate[] }> {
  // transaction hash -> the escrow outputs that transaction spent; a transaction Koios does not know is absent
  const escrowInputsOf = async (txHashes: string[]): Promise<Map<string, string[]>> => {
    try { return await koiosTxInputRefs(koiosUrl, txHashes, fetchImpl, ESCROW_SCRIPT_HASH); } catch (err) { throw new Error(`Could not read escrow ${rootRef}: ${koiosFailure(err)}`); }
  };
  const rootStep = LIVE_STATES.indexOf(root.state);
  const stepsPastRoot = (c: Candidate): number => { const step = LIVE_STATES.indexOf(c.datum.state); return rootStep < 0 || step < 0 ? 0 : step - rootStep; };
  const reachable = candidates.filter((c) => stepsPastRoot(c) === 1 || stepsPastRoot(c) === 2); // a copy in any other state cannot come after the root
  const spentByTx = await escrowInputsOf(reachable.map((c) => c.txHash));
  const genuine: Candidate[] = [];
  const unknown: Candidate[] = [];
  const twoSteps: Array<{ candidate: Candidate; spent: string[] }> = [];
  for (const c of reachable) {
    const spent = spentByTx.get(c.txHash);
    if (spent === undefined) unknown.push(c);
    else if (stepsPastRoot(c) === 1) { if (spent.includes(rootRef)) genuine.push(c); }
    else twoSteps.push({ candidate: c, spent });
  }
  const middle = await escrowInputsOf(twoSteps.flatMap(({ spent }) => spent.map(txOf)));
  for (const { candidate, spent } of twoSteps) {
    const behind = spent.map((ref) => middle.get(txOf(ref)));
    if (behind.some((inputs) => inputs?.includes(rootRef))) genuine.push(candidate);
    else if (behind.some((inputs) => inputs === undefined)) unknown.push(candidate);
  }
  return { genuine, unknown };
}

/**
 * The output `escrowRef` names, as Koios utxo_info describes it, spent or not (Koios keeps the datum of a spent output): its
 * datum, whether Koios says it is spent, and what it holds. Koios only: no node, no spend chain, no other output, so nothing that
 * anyone locks at the escrow credential can change the answer. A caller that needs only what the Post output says (its buyer, its
 * supplier, its advert, its hashes) reads it here and not through resolveEscrowLineage, which fails when a copy at the escrow
 * credential cannot be told from the escrow's own continuation. It fails closed as the resolver does for this output: not found,
 * not at the escrow credential, no escrow datum, spent status or value not reported, not funded. Errors name the escrow by its
 * canonical ref and carry no endpoint and no response body.
 */
export async function readEscrowOutput(koiosUrl: string, escrowRef: string, fetchImpl: typeof fetch = fetch): Promise<{ datum: EscrowDatum; spent: boolean; lovelace: bigint }> {
  const ref = parseOutRef(escrowRef);
  const canonical = formatOutRef(ref.txHash, ref.outputIndex);
  let rows: KoiosUtxo[];
  try { rows = await koiosUtxoInfo(koiosUrl, [canonical], fetchImpl); } catch (err) { throw new Error(`Could not read escrow ${canonical}: ${koiosFailure(err)}`); }
  const row = rows.find((u) => String(u?.tx_hash).toLowerCase() === ref.txHash && u?.tx_index === ref.outputIndex);
  if (!row) throw new Error(`Escrow ${canonical} not found on the ledger.`);
  if (!isEscrowAddress(row.address)) throw new Error(`UTxO ${canonical} is not an escrow output: its payment credential is not the escrow script's.`);
  let datum: EscrowDatum;
  try { datum = decodeEscrowDatum(row.inline_datum?.bytes ?? ''); } catch { throw new Error(`UTxO ${canonical} does not hold an escrow datum.`); }
  if (typeof row.is_spent !== 'boolean') throw new Error(`Koios did not report whether escrow ${canonical} is spent; refusing to guess where it is.`);
  const lovelace = lovelaceOf(row.value);
  if (lovelace === undefined) throw new Error(`Koios did not report the value of escrow ${canonical}; refusing to guess whether it is funded.`);
  if (lovelace < owedLovelace(datum)) {
    throw new Error(`Escrow ${canonical} is not funded: its datum owes ${owedLovelace(datum)} lovelace but the output holds ${lovelace}; refusing to treat it as an escrow.`);
  }
  return { datum, spent: row.is_spent, lovelace };
}

// ─── The Submitted output of an escrow that may be settled ──────────────────────────────────────────────────────────────────────
// resolveEscrowLineage finds the live output of an escrow, and a settled escrow has none: its Submitted output was spent by the
// Accept or the Release. The marketplace indexer keeps a row for every state an escrow reached, so it can say where that output was;
// but it is a third party's list, and anyone can lock a copy of an escrow's fields at the escrow address. So an output named by the
// indexer (or by a caller) is used only after readSubmittedOutput has read it from Koios and proven it the escrow's own.

const lowerText = (v: unknown): string | undefined => (typeof v === 'string' ? v.toLowerCase() : undefined);

/**
 * Which of the rows the indexer lists for an escrow's buyer put forward a Submitted output of the escrow whose Post datum is
 * `posted`? A row counts when its state is Submitted and it agrees with the Post datum on every field escrow.ak keeps across Claim and
 * Submit: buyer, supplier, advert, capability, request spec hash, prompt hash, the three amounts, deliver_by and posted_at. The same
 * buyer hiring the same supplier with the same payload again differs from an earlier escrow in posted_at and deliver_by alone, and
 * does it often. The refs come back canonical, sorted and once each; an entry that is no row, or has no usable utxo_ref, is skipped.
 */
export function submittedRefsOf(rows: unknown[], posted: EscrowDatum): string[] {
  const advert = formatOutRef(posted.advert_ref.txHash, posted.advert_ref.index);
  const refs = new Set<string>();
  for (const entry of rows) {
    if (entry === null || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (r.state !== 'Submitted' || typeof r.utxo_ref !== 'string') continue;
    let ref: string;
    try { const parsed = parseOutRef(r.utxo_ref); ref = formatOutRef(parsed.txHash, parsed.outputIndex); } catch { continue; }
    const agrees = lowerText(r.buyer_pkh) === posted.buyer_pkh && lowerText(r.supplier_pkh) === posted.supplier_pkh
      && lowerText(r.advert_ref) === advert && r.capability_id === posted.capability_id
      && lowerText(r.request_spec_hash) === posted.request_spec_hash && lowerText(r.prompt_hash) === posted.prompt_hash
      && lovelaceOf(r.payment_lovelace) === posted.payment_lovelace && lovelaceOf(r.buyer_bond_lovelace) === posted.buyer_bond_lovelace
      && lovelaceOf(r.supplier_bond_lovelace) === posted.supplier_bond_lovelace
      && r.deliver_by === posted.deliver_by && r.posted_at === posted.posted_at;
    if (agrees) refs.add(ref);
  }
  return [...refs].sort();
}

/**
 * The output `submittedRef` as the Submitted output of the escrow whose Post output is `post`, live or spent. It is read from Koios
 * utxo_info (readEscrowOutput: at the escrow credential, an escrow datum, funded; Koios keeps the datum of an output after the Accept
 * or the Release, so nothing here needs it unspent) and used only if it is provably the escrow's own. The datum is not enough: its
 * fields are public and anyone can lock a copy. What a copy cannot fake is how it came to be, so it must also (1) be in state
 * Submitted with a receipt hash, (2) agree with the Post datum on every field Claim and Submit keep, (3) hold what the Post output
 * held, and (4) descend from the Post output by the spend chain (descendantsOf: its transaction spent a Claimed output that the
 * escrow's Claim made, two calls to tx_info). Whoever named the ref, the indexer or a caller, these checks are the same. Throws, naming
 * the output and the escrow, when any fails or Koios cannot say.
 */
export async function readSubmittedOutput(
  koiosUrl: string, post: { ref: string; datum: EscrowDatum; lovelace: bigint }, submittedRef: string, fetchImpl: typeof fetch = fetch,
): Promise<{ datum: EscrowDatum; receiptHash: string; spent: boolean; ref: string }> {
  const parsed = parseOutRef(submittedRef);
  const at = formatOutRef(parsed.txHash, parsed.outputIndex);
  const out = await readEscrowOutput(koiosUrl, at, fetchImpl);
  const { datum } = out;
  if (datum.state !== 'Submitted') throw new Error(`UTxO ${at} is not a Submitted output: its datum is in state ${datum.state}.`);
  if (datum.result_receipt_hash === null) throw new Error(`UTxO ${at} is a Submitted output without a receipt hash.`);
  const changed = changedFieldsOf(post.datum, datum);
  if (changed.length > 0) throw new Error(`UTxO ${at} does not belong to escrow ${post.ref}: its datum differs from that escrow's in ${changed.join(', ')}, which Claim and Submit leave unchanged.`);
  if (out.lovelace !== post.lovelace) throw new Error(`UTxO ${at} does not belong to escrow ${post.ref}: it holds ${out.lovelace} lovelace where the Post output held ${post.lovelace}.`);
  const { genuine, unknown } = await descendantsOf(post.ref, post.datum, [{ txHash: parsed.txHash, outputIndex: parsed.outputIndex, datum }], koiosUrl, fetchImpl);
  if (unknown.length > 0) throw new Error(`Cannot tell whether UTxO ${at} belongs to escrow ${post.ref}: Koios does not know the transaction behind it yet; retry in a few seconds.`);
  if (genuine.length === 0) throw new Error(`UTxO ${at} does not belong to escrow ${post.ref}: it carries the escrow's fields, but it does not descend from that escrow by the spend chain.`);
  return { datum, receiptHash: datum.result_receipt_hash, spent: out.spent, ref: at };
}

/**
 * Where is this escrow now? `escrowRef` names the Post output (`<txHash>#0`, as buildPostEscrow returns it); a later output of
 * the same escrow works too. While that output is unspent it is the live escrow. Once it is spent, the live one is the UTxO
 * that descends from it by the SPEND CHAIN, and `current: null` means none was found: the escrow is finished, or Koios has not
 * indexed its continuation yet (the caller must not say which).
 *
 * Escrow outputs are known by payment credential, not by address. escrow.ak finds the continuation of a Claim or Submit with
 * unique_output_to_credential, so a continuation may sit at any address with the escrow script's credential, a stake part and
 * all; the posted output, every candidate, the node's copy and the inputs of the transactions in between are all checked by that
 * credential, and candidates come from Koios credential_utxos (narrowed on the server to outputs whose datum carries this
 * escrow's prompt hash), never from the node's list for one address. The spend is built from the node's copy of the chosen
 * output, whatever its address.
 *
 * Why the datum is not enough. Claim and Submit leave advert_ref, buyer_pkh, posted_at and prompt_hash as posted, so those four
 * fields pick the candidates; but they are public, and anyone can lock a UTxO at the escrow address that carries copies of
 * them. What a copy cannot fake is how it came to be. escrow.ak lets Claim and Submit make exactly one output at the escrow
 * credential, so the true continuation is the output of the transaction that spent the previous escrow output: Post output,
 * Claim, Claimed output, Submit, Submitted output. A candidate in state Claimed is genuine when the transaction that made it
 * spent the posted output; one in state Submitted when its transaction spent an escrow output whose transaction spent the posted
 * output. A genuine continuation also holds exactly the lovelace the posted output held (Claim and Submit keep the value), so a
 * copy has to lock the full amount. Koios tx_info answers the chain questions in at most two batched calls (none when nothing
 * carries the escrow on, one when the live output is Claimed). Nor is descending enough on its own: a transaction that ended the
 * escrow (Reclaim, Accept, Release) can leave an output at the escrow credential behind, which descends from it by the spend
 * chain with a datum of its own. So the output chosen must agree with the one it follows on every field escrow.ak keeps across
 * Claim and Submit (all but state, submitted_at and result_receipt_hash), not only the four that pick the candidates.
 *
 * Fails closed. A UTxO counts as an escrow only when its payment credential is the escrow script's, it holds an escrow datum, and
 * the posted output holds at least the payment and both bonds its datum owes (Accept pays what the datum says, and the wallet
 * would make up the difference). Everything throws, naming the escrow by its canonical ref, when: Koios or the node cannot be
 * read (their messages carry no endpoint and no response body); Koios does not say whether the posted output is spent or what it
 * holds; Koios and the node disagree (one is behind: the posted output spent on one and not on the other, the live continuation
 * on Koios but not on the node, or the node's copy of an output differs from the one Koios described); UTxOs carry the escrow's
 * fields but none provably descends from it, or Koios does not know a transaction on the way yet; when two of them do; and when
 * the one that does differs from the escrow in a field Claim and Submit keep.
 * `fetchImpl` stands in for fetch in the Koios calls (tests).
 */
export async function resolveEscrowLineage(provider: Provider, koiosUrl: string, escrowRef: string, fetchImpl: typeof fetch = fetch): Promise<EscrowLineage> {
  const ref = parseOutRef(escrowRef);
  const canonical = formatOutRef(ref.txHash, ref.outputIndex);
  const fromKoios = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read(); } catch (err) { throw new Error(`Could not read escrow ${canonical}: ${koiosFailure(err)}`); }
  };
  const fromNode = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read(); } catch (err) { throw new Error(`Could not read escrow ${canonical} from the node: ${nodeFailure(err)}`); }
  };
  const disagree = (detail: string) => new Error(`Koios and the node disagree about escrow ${canonical}: ${detail}; retry in a minute.`);
  /** The node's copy of an output Koios described must be that output: an escrow output, with that datum and that lovelace. */
  const confirmedOnNode = (utxo: UTxO, at: string, expected: { datum: EscrowDatum; lovelace: bigint }): UTxO => {
    if (!isEscrowAddress(utxo.address) || !utxo.datum) throw disagree(`the node lists ${at} but not as an escrow output (no escrow payment credential or no inline datum)`);
    let datum: EscrowDatum | undefined;
    try { datum = decodeEscrowDatum(utxo.datum); } catch { /* not an escrow datum: refused below */ }
    if (!datum || !sameDatum(datum, expected.datum)) throw disagree(`the datum the node holds at ${at} differs from the one Koios reports`);
    if (utxo.assets.lovelace !== expected.lovelace) throw disagree(`the node holds ${utxo.assets.lovelace} lovelace at ${at} where Koios reports ${expected.lovelace}`);
    return utxo;
  };

  const { datum: posted, spent: rootSpent, lovelace: rootLovelace } = await readEscrowOutput(koiosUrl, canonical, fetchImpl);

  const [rootOnNode] = await fromNode(() => provider.getUtxosByOutRef([ref]));
  if (!rootSpent) {
    if (!rootOnNode) throw disagree('Koios says it is unspent, the node does not list it (one of them is behind)');
    return { posted, current: { utxo: confirmedOnNode(rootOnNode, canonical, { datum: posted, lovelace: rootLovelace }), datum: posted }, spent: false };
  }
  if (rootOnNode) throw disagree('Koios says it is spent, the node still lists it as unspent (one of them is behind)');

  // The search below is for the prompt hash as a slice of the datum (1 to 128 bytes). A Post output can be locked by anyone with
  // a prompt hash of any size; one the search cannot take is no transient failure and no network error, so it is said as what it is.
  const promptBytes = posted.prompt_hash.length / 2;
  if (!(promptBytes >= 1 && promptBytes <= 128)) {
    throw new Error(`Escrow ${canonical} cannot be followed: its prompt hash is ${promptBytes} bytes, outside the 1 to 128 bytes the lookup supports; retrying will not change that.`);
  }
  // Candidates: the outputs at the escrow credential whose datum carries this escrow's prompt hash, as Koios lists them.
  const listed = await fromKoios(() => koiosCredentialUtxos(koiosUrl, ESCROW_SCRIPT_HASH, fetchImpl, { datumContains: posted.prompt_hash }));
  const candidates: Candidate[] = [];
  for (const u of listed) {
    const txHash = u.tx_hash.toLowerCase();
    if (txHash === ref.txHash && u.tx_index === ref.outputIndex) continue; // Koios lists the posted output as spent above: it is not its own continuation
    if (!isEscrowAddress(u.address) || typeof u.inline_datum?.bytes !== 'string') continue;
    let datum: EscrowDatum;
    try { datum = decodeEscrowDatum(u.inline_datum.bytes); } catch { continue; }
    if (carriesFieldsOf(posted, datum) && lovelaceOf(u.value) === rootLovelace) candidates.push({ txHash, outputIndex: u.tx_index, datum });
  }
  if (candidates.length === 0) return { posted, current: null, spent: true };

  const { genuine, unknown } = await descendantsOf(canonical, posted, candidates, koiosUrl, fetchImpl);
  if (genuine.length > 1) throw new Error(`More than one UTxO descends from escrow ${canonical} by the spend chain (${named(genuine)}); refusing to choose between them.`);
  if (genuine.length === 0) {
    throw new Error(unknown.length > 0
      ? `Cannot tell which UTxO carries escrow ${canonical} on: Koios does not know the transaction behind ${named(unknown)} yet; retry in a few seconds.`
      : `None of ${named(candidates)} descends from escrow ${canonical} by the spend chain, though they carry its fields; refusing to treat any of them as the escrow.`);
  }
  const chosen = genuine[0];
  const at = refOf(chosen);
  // Descending by the spend chain is not enough: a transaction that ended the escrow (Reclaim, Accept, Release) can leave an
  // output at the escrow credential behind, with a datum of its own, and Accept would pay out what that datum says.
  const changed = changedFieldsOf(posted, chosen.datum);
  if (changed.length > 0) {
    throw new Error(`UTxO ${at} follows escrow ${canonical} along the spend chain, but its datum differs from that escrow's in ${changed.join(', ')}, which Claim and Submit leave unchanged; refusing to build on it.`);
  }
  const [utxo] = await fromNode(() => provider.getUtxosByOutRef([{ txHash: chosen.txHash, outputIndex: chosen.outputIndex }]));
  if (!utxo) throw disagree(`Koios lists ${at} as its live continuation, the node does not list it (one of them is behind)`);
  return { posted, current: { utxo: confirmedOnNode(utxo, at, { datum: chosen.datum, lovelace: rootLovelace }), datum: chosen.datum }, spent: true };
}
