// packages/builder/src/vector/jury-read.ts
// Reading a jury deployment (Module-1/jury/SPEC.md Sections 4, 5, 10.2 and 11): its juror and case outputs from the node, a juror or a
// case named by a tool input, what a juror can do now, the document URIs of a case (from the claim and challenge outputs that the case
// names, through Koios) and the canonical flag of a case (from the marketplace indexer, which follows the mint history of the case
// tokens and the genuine challenge outputs that a read of the live outputs cannot see).
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { koiosUtxoInfo } from './marketplace-indexer.js';
import { identifierOf } from './identity-chain.js';
import { TOKEN_PREFIX, decodeChallengeDatum, decodeClaimDatum, decodeJuryDatum } from './jury-codec.js';
import type { CaseDatum, JurorDatum, JuryParams } from './jury-codec.js';
import { refText } from './jury-deployment.js';
import type { JuryDeployment, OutRef } from './jury-deployment.js';
import { isObject } from './jury-document.js';

export interface JurorUtxo { token: string; utxo: UTxO; datum: JurorDatum }
export interface CaseUtxo { token: string; utxo: UTxO; datum: CaseDatum }
/** The live outputs of a deployment: its jurors, its cases, and the number of other outputs at its address (anybody can send there). */
export interface JuryOutputs { jurors: JurorUtxo[]; cases: CaseUtxo[]; other: number }

/**
 * The juror or case of a UTxO at the jury address (SPEC Section 4): lovelace and exactly one jury token (`jrr_` or `cas_`, quantity 1)
 * and no other asset, no reference script, and an inline datum of the variant of the token. Null for any other output.
 */
export function juryOutputOf(utxo: UTxO, jury: JuryDeployment): { kind: 'juror'; juror: JurorUtxo } | { kind: 'case'; case: CaseUtxo } | null {
  if (utxo.address !== jury.address || utxo.scriptRef || !utxo.datum) return null;
  const units = Object.keys(utxo.assets).filter((unit) => unit !== 'lovelace');
  if (units.length !== 1 || !units[0].startsWith(jury.hash) || utxo.assets[units[0]] !== 1n) return null;
  const token = units[0].slice(56);
  if (token.length !== 64) return null;
  let datum;
  try { datum = decodeJuryDatum(utxo.datum); } catch { return null; }
  if (token.startsWith(TOKEN_PREFIX.juror) && datum.type === 'Juror') return { kind: 'juror', juror: { token, utxo, datum: datum.juror } };
  if (token.startsWith(TOKEN_PREFIX.case) && datum.type === 'Case') return { kind: 'case', case: { token, utxo, datum: datum.case } };
  return null;
}

/** The juror and case outputs of the deployment, from the node. */
export async function readJuryOutputs(provider: Pick<Provider, 'getUtxos'>, jury: JuryDeployment): Promise<JuryOutputs> {
  const out: JuryOutputs = { jurors: [], cases: [], other: 0 };
  for (const utxo of await provider.getUtxos(jury.address)) {
    const found = juryOutputOf(utxo, jury);
    if (found === null) out.other += 1;
    else if (found.kind === 'juror') out.jurors.push(found.juror);
    else out.cases.push(found.case);
  }
  return out;
}

const refOf = (value: string): OutRef | null => {
  const m = /^([0-9a-fA-F]{64})#(0|[1-9][0-9]{0,5})$/.exec(value.trim());
  return m ? { txHash: m[1].toLowerCase(), outputIndex: Number(m[2]) } : null;
};
const isAt = (utxo: UTxO, ref: OutRef): boolean => utxo.txHash === ref.txHash && utxo.outputIndex === ref.outputIndex;

/**
 * The juror that `selector` names in `outputs`: its juror token name (`jrr_…`, 64 hex), its output reference, or its DID when the DID
 * has exactly one juror output.
 */
export function pickJuror(outputs: JuryOutputs, selector: string, jury: JuryDeployment): JurorUtxo {
  const value = selector.trim().toLowerCase();
  const byToken = outputs.jurors.find((j) => j.token === value);
  if (byToken) return byToken;
  const ref = refOf(value);
  if (ref) {
    const byRef = outputs.jurors.find((j) => isAt(j.utxo, ref));
    if (!byRef) throw new Error(`${refText(ref)} is not a live juror output of the jury ${jury.hash}: it was spent (every juror action moves the output) or it is not a juror. Name the juror by its token name.`);
    return byRef;
  }
  if (value.startsWith(TOKEN_PREFIX.juror) && /^[0-9a-f]{64}$/.test(value)) throw new Error(`No live juror of the jury ${jury.hash} holds the juror token ${value}: the juror exited, or the name is wrong.`);
  let agent: string;
  try { agent = identifierOf(selector); } catch { throw new Error(`${JSON.stringify(selector.slice(0, 120))} names no juror: give the juror token name (jrr_…, 64 hex), the juror output reference or the juror DID.`); }
  const mine = outputs.jurors.filter((j) => j.datum.agent === agent);
  if (mine.length === 1) return mine[0];
  if (mine.length === 0) throw new Error(`did:vector:${agent} has no juror output in the jury ${jury.hash}: register it with vector_build_jury_register.`);
  throw new Error(`did:vector:${agent} has ${mine.length} juror outputs (${mine.map((j) => j.token).join(', ')}): name one by its token name.`);
}

/**
 * The case that `selector` names in `outputs`: its case token name (`cas_…`, 64 hex), its output reference, or the token name of its
 * claim (`clm_…`) or its challenge (`chl_…`) when the deployment has exactly one live case of it.
 */
export function pickCase(outputs: JuryOutputs, selector: string, jury: JuryDeployment): CaseUtxo {
  const value = selector.trim().toLowerCase();
  const byToken = outputs.cases.find((c) => c.token === value);
  if (byToken) return byToken;
  const ref = refOf(value);
  if (ref) {
    const byRef = outputs.cases.find((c) => isAt(c.utxo, ref));
    if (!byRef) throw new Error(`${refText(ref)} is not a live case output of the jury ${jury.hash}: every commit and reveal moves the case output. Name the case by its token name.`);
    return byRef;
  }
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${JSON.stringify(selector.slice(0, 120))} names no case: give the case token name (cas_…, 64 hex), the case output reference, or the token name of its claim (clm_…) or challenge (chl_…).`);
  const ofDispute = outputs.cases.filter((c) => c.datum.claim === value || c.datum.challenge === value);
  if (ofDispute.length === 1) return ofDispute[0];
  if (ofDispute.length > 1) throw new Error(`${value} has ${ofDispute.length} live cases (${ofDispute.map((c) => c.token).join(', ')}): name one by its token name; vector_get_jury_cases shows which one is canonical.`);
  throw new Error(`The jury ${jury.hash} has no live case ${value}: the case closed, it is in another deployment, or the name is wrong (vector_get_jury_cases lists the cases).`);
}

// ─── What a juror can do now (SPEC Sections 6.4 and 6.8) ──────────────────────────────────────────────────────────────────────

/** When the juror can commit, its exit state and why it cannot commit now (identity aside). */
export interface JurorStanding {
  eligibleFrom: number;
  /** The reasons why a commit now would fail, apart from the identity check; empty when it can commit. */
  blockers: string[];
  exit: 'none' | 'requested' | 'possible';
}

export function jurorStanding(j: JurorUtxo, params: JuryParams, nowMs: number): JurorStanding {
  const eligibleFrom = j.datum.registeredAt + params.eligibilityDelay;
  const blockers: string[] = [];
  if (nowMs < eligibleFrom) blockers.push(`it can vote from ${new Date(eligibleFrom).toISOString()}`);
  if (j.datum.exitAfter !== null) blockers.push('it asked to exit');
  if (j.utxo.assets.lovelace < params.bondMin) blockers.push('its bond is below bond_min');
  const exit = j.datum.exitAfter === null ? 'none' : nowMs >= j.datum.exitAfter && j.datum.open.length === 0 ? 'possible' : 'requested';
  return { eligibleFrom, blockers, exit };
}

/** The phase of a case at `nowMs`. */
export function casePhase(c: CaseDatum, nowMs: number): 'commit' | 'reveal' | 'finalize' | 'settling' {
  if (c.state.type === 'Settling') return 'settling';
  if (nowMs < c.commitEnd) return 'commit';
  return nowMs < c.revealEnd ? 'reveal' : 'finalize';
}

// ─── Documents and the canonical case (SPEC Sections 10.2 and 11) ─────────────────────────────────────────────────────────────

/**
 * The document URIs of `cases` (SPEC Section 10.2), as UTF-8 bytes in hex, by output reference: the `storage_uri` of each `claim_out`
 * and the `evidence_uri` of each `challenge_out`. Koios utxo_info gives the inline datum also of an output that is spent since.
 */
export async function caseDocumentUris(koiosUrl: string, cases: CaseDatum[], fetchImpl: typeof fetch): Promise<Map<string, string>> {
  const refs = [...new Set(cases.flatMap((c) => [refText(c.claimOut), refText(c.challengeOut)]))];
  const uris = new Map<string, string>();
  for (let i = 0; i < refs.length; i += 50) {
    for (const u of await koiosUtxoInfo(koiosUrl, refs.slice(i, i + 50), fetchImpl)) {
      const datum = u?.inline_datum?.bytes;
      if (typeof datum !== 'string') continue;
      const ref = `${String(u.tx_hash).toLowerCase()}#${u.tx_index}`;
      try { uris.set(ref, decodeClaimDatum(datum).storageUri); continue; } catch { /* not a claim */ }
      try { uris.set(ref, decodeChallengeDatum(datum).evidenceUri); } catch { /* neither a claim nor a challenge: no URI */ }
    }
  }
  return uris;
}

/**
 * The canonical flag of each case token that the marketplace indexer knows (GET /jury/cases; SPEC Section 11.2: the case of the
 * current deployment at `challenged_at` whose opening is first on chain among all cases of the claim token with a genuine
 * `challenge_out`, at least 10 blocks deep). Null when the indexer has no such route (an indexer before its jury release answers 404).
 */
export async function indexerCanonical(indexerUrl: string, fetchImpl: typeof fetch): Promise<Map<string, boolean> | null> {
  const res = await fetchImpl(`${indexerUrl}/jury/cases`, { headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the marketplace indexer answered ${res.status}`);
  const body: unknown = await res.json().catch(() => { throw new Error('the marketplace indexer answered /jury/cases without JSON'); });
  const rows = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.cases) ? body.cases : null;
  if (rows === null) throw new Error('the marketplace indexer answered /jury/cases without a list of cases');
  const flags = new Map<string, boolean>();
  for (const row of rows) if (isObject(row) && typeof row.case === 'string' && typeof row.canonical === 'boolean') flags.set(row.case.toLowerCase(), row.canonical);
  return flags;
}
