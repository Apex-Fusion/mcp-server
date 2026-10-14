// packages/builder/test/fixtures/escrow-koios.fixture.ts
// A fake Koios for the escrow lineage, shared by marketplace-lineage.test.ts, marketplace-build.test.ts,
// marketplace-build-clock.test.ts and marketplace-tools.test.ts, plus the spend chain of the live fixture escrow and the ways a
// decoy comes to be. `world` (at the end) builds a node and the Koios that describes the same chain from one list of UTxOs.
//
// The fake answers the three routes the resolver reads:
//  - utxo_info describes the Post output of the live escrow fixture. A `null` option leaves a field out, as Koios does when it
//    does not know it; `status` answers with an error whose body carries things a caller must never see; `raw` is the response.
//  - tx_info answers only for the transactions in `txs`, giving the outputs each one spent as [ref, address] pairs (the payment
//    credential is read off the address, as Koios reports it); a transaction that is not listed is one Koios does not know (yet).
//  - credential_utxos lists the escrow-credential outputs in `indexed`, paged, ordered and filtered the way PostgREST does it
//    (offset, limit, order, and the like-filter on the inline datum's hex), `pageCap` rows at a time at most; `ignoreDatumFilter`
//    is a Koios that does not apply that filter, which the resolver must not rely on.
import { getAddressDetails, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { ESCROW_ADDRESS, ESCROW_SCRIPT_HASH } from '../../src/vector/marketplace-constants.ts';
import { encodeEscrowDatum } from '../../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../../src/vector/marketplace-datum.ts';
import { ESCROW_LOCKED_LOVELACE, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './marketplace.fixture.ts';
import { FixtureProvider } from './fixture-provider.ts';

export type KoiosFake = { f: typeof fetch; calls: Array<{ path: string; body: any; url?: string }> };
export type SpentOutputs = Array<[ref: string, address: string]>;

export const ESCROW_TX = ESCROW_REF.slice(0, 64);
/** Enterprise address of the supplier key of the live fixture advert (a key address, so not an escrow output). */
export const SUPPLIER_ADDRESS = 'addr1v9qp4aqc5ln0kyrzwu5j3q0um64pes2mtvgja8ytmvk5djgfj3cl6';

/** An address with the escrow's payment credential and a stake part: the validator treats it as the escrow address. */
export const stakedEscrowAddress = (stakeKeyHash = 'ee'.repeat(28)): string =>
  credentialToAddress('Mainnet', { type: 'Script', hash: ESCROW_SCRIPT_HASH }, { type: 'Key', hash: stakeKeyHash });

/** An output at the escrow address (or `over.address`) holding the live escrow's lock and the given datum. */
export const escrowAt = (txHash: string, datum: EscrowDatum, over: Partial<UTxO> = {}): UTxO =>
  ({ txHash, outputIndex: 0, address: ESCROW_ADDRESS, assets: { lovelace: ESCROW_LOCKED_LOVELACE }, datum: encodeEscrowDatum(datum), ...over });

// Memoised: a listing of thousands of outputs is re-read on every page, and parsing an address is the slow part of that.
const credentials = new Map<string, string | undefined>();
const credentialOf = (address: string): string | undefined => {
  if (!credentials.has(address)) credentials.set(address, (() => { try { return getAddressDetails(address).paymentCredential?.hash; } catch { return undefined; } })());
  return credentials.get(address);
};
const hostile = '{"error":"db password=hunter2 at https://internal.koios.example"}';

export function escrowKoios(o: {
  datumHex?: string | null; address?: string | null; spent?: boolean | null; value?: string | null; rows?: unknown[]; status?: number; raw?: string;
  txs?: Record<string, SpentOutputs>; txStatus?: number;
  indexed?: UTxO[]; credentialStatus?: number; pageCap?: number; extraCredentialRows?: Array<Record<string, any>>; ignoreDatumFilter?: boolean;
} = {}): KoiosFake {
  const calls: KoiosFake['calls'] = [];
  const f = (async (url: string, init: any) => {
    const u = new URL(url);
    const body = JSON.parse(init.body);
    const path = '/' + u.pathname.split('/').slice(-3).join('/');
    calls.push({ path, body, url });
    if (path === '/api/v1/tx_info') {
      if (o.txStatus) return new Response(hostile, { status: o.txStatus });
      const known = (body._tx_hashes as string[]).filter((h) => o.txs?.[h] !== undefined);
      return new Response(JSON.stringify(known.map((h) => ({
        tx_hash: h,
        inputs: o.txs![h].map(([ref, address]) => ({ tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)), payment_addr: { bech32: address, cred: credentialOf(address) }, stake_addr: null })),
      }))), { status: 200 });
    }
    if (path === '/api/v1/credential_utxos') {
      if (o.credentialStatus) return new Response(hostile, { status: o.credentialStatus });
      if (!(body._payment_credentials as string[]).includes(ESCROW_SCRIPT_HASH)) return new Response('[]', { status: 200 });
      let rows = (o.indexed ?? []).filter((x) => credentialOf(x.address) === ESCROW_SCRIPT_HASH).map((x) => ({
        tx_hash: x.txHash, tx_index: x.outputIndex, address: x.address, value: String(x.assets.lovelace), stake_address: null, payment_cred: ESCROW_SCRIPT_HASH,
        datum_hash: null, inline_datum: x.datum ? { bytes: x.datum } : null, reference_script: null, asset_list: [], is_spent: false,
      }));
      rows = [...rows, ...(o.extraCredentialRows ?? [])] as typeof rows; // rows a misbehaving Koios might add: the resolver must check what it is given
      const like = u.searchParams.get('inline_datum->>bytes');
      if (like?.startsWith('like.') && !o.ignoreDatumFilter) { const needle = like.slice(5).replace(/\*/g, ''); rows = rows.filter((r) => r.inline_datum?.bytes.includes(needle)); }
      if (u.searchParams.get('order') === 'tx_hash.asc,tx_index.asc') rows.sort((a, b) => (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : a.tx_index - b.tx_index));
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 1000), o.pageCap ?? 1000);
      return new Response(JSON.stringify(rows.slice(offset, offset + limit)), { status: 200 });
    }
    if (o.status) return new Response(hostile, { status: o.status });
    if (o.raw !== undefined) return new Response(o.raw, { status: 200 });
    const row = {
      tx_hash: ESCROW_TX, tx_index: 0,
      ...(o.value === null ? {} : { value: o.value ?? String(ESCROW_LOCKED_LOVELACE) }),
      ...(o.address === null ? {} : { address: o.address ?? ESCROW_ADDRESS }),
      ...(o.spent === null ? {} : { is_spent: o.spent ?? true }),
      inline_datum: o.datumHex === null ? null : { bytes: o.datumHex ?? ESCROW_OPEN_DATUM_HEX },
    };
    return new Response(JSON.stringify(o.rows ?? [row]), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
export const txInfoRequests = (k: KoiosFake) => k.calls.filter((c) => c.path === '/api/v1/tx_info');
export const credentialRequests = (k: KoiosFake) => k.calls.filter((c) => c.path === '/api/v1/credential_utxos');

/**
 * What the resolver says when a flood of decoys at the escrow credential makes the candidate read refuse (5,000 or more outputs carry
 * the escrow's prompt hash), word for word as the buyer reads it (marketplace-lineage.ts). It is under the 800 characters an error is
 * shown in, so the end of it, the way to build the Accept in time, is never cut off.
 */
export const floodRefusal = (escrowRef: string): string =>
  `Could not read escrow ${escrowRef}: Koios credential_utxos: 5000 or more outputs matched; refusing to read them all. ` +
  "Only a flood of decoys leaves that many (anyone can lock an output at the escrow address that copies this escrow's public prompt hash), and these tools cannot tell the escrow's own output from them: they cannot build its Accept or its Reclaim while it lasts. " +
  "If the supplier has submitted, the accept clock is running: Accept must land within 600 s of the supplier's Submit; after that the supplier may Release and keep everything locked (price + both bonds + any floor excess). These tools cannot help within that window; the marketplace buyer SDK (agents-marketplace, acceptResult) can build the Accept.";

// The spend chain of the live fixture escrow, as Koios tx_info tells it. The Claim spent the Post output (and a fee input of the
// supplier's). The Submit spent the Claimed output the Claim made and, as a fee input, the supplier's change the Claim made too.
export const CLAIM_TX = 'c1'.repeat(32);
export const SUBMIT_TX = 'ee'.repeat(32);
export const GENUINE_TXS: Record<string, SpentOutputs> = {
  [CLAIM_TX]: [[ESCROW_REF, ESCROW_ADDRESS], [`${'ab'.repeat(32)}#0`, SUPPLIER_ADDRESS]],
  [SUBMIT_TX]: [[`${CLAIM_TX}#0`, ESCROW_ADDRESS], [`${CLAIM_TX}#1`, SUPPLIER_ADDRESS]],
};

// How a decoy comes to be: a plain transfer to the escrow address, which spends wallet outputs and never an escrow output. The
// sly one spends the supplier's change from the genuine Claim, the one output of the genuine chain a supplier can freely spend.
export const DECOY_TX = 'dd'.repeat(32);
export const SLY_DECOY_TX = 'd5'.repeat(32);
// Others leave a copy behind while spending ANOTHER escrow's outputs: the buyer's Reclaim or Accept and the supplier's Release are
// terminal, so they make no continuation and nothing stops them creating extra outputs. Koios knows those transactions too.
export const OTHER_POST_TX = '0e'.repeat(32); // another escrow's Post transaction
export const OTHER_CLAIM_TX = '0c'.repeat(32); // that escrow's Claim: spent its Post output, made OTHER_CLAIM_TX#0
export const OTHER_SPEND_TX = '0d'.repeat(32); // a terminal spend of that Post output, with a copy left behind
export const OTHER_RELEASE_TX = '0f'.repeat(32); // a terminal spend of that Claimed output, with a copy left behind
export const DECOY_TXS: Record<string, SpentOutputs> = {
  [DECOY_TX]: [[`${'ac'.repeat(32)}#0`, SUPPLIER_ADDRESS]],
  [SLY_DECOY_TX]: [[`${CLAIM_TX}#1`, SUPPLIER_ADDRESS]],
  [OTHER_POST_TX]: [[`${'0a'.repeat(32)}#0`, SUPPLIER_ADDRESS]],
  [OTHER_CLAIM_TX]: [[`${OTHER_POST_TX}#0`, ESCROW_ADDRESS]],
  [OTHER_SPEND_TX]: [[`${OTHER_POST_TX}#0`, ESCROW_ADDRESS]],
  [OTHER_RELEASE_TX]: [[`${OTHER_CLAIM_TX}#0`, ESCROW_ADDRESS]],
};
export const DECOY_KINDS: Array<[name: string, creatingTx: string]> = [
  ['a plain transfer', DECOY_TX],
  ['spending only the supplier\'s change from the Claim', SLY_DECOY_TX],
  ['left behind by a terminal spend of another escrow\'s Post output', OTHER_SPEND_TX],
  ['left behind by a terminal spend of another escrow\'s Claimed output', OTHER_RELEASE_TX],
];

// One chain, two views. A test that builds the node and the Koios by hand can quietly give them different chains and still pass,
// because Koios is where the builders look first and the node is where they confirm; `world` builds both from the one list.
export type KoiosOptions = NonNullable<Parameters<typeof escrowKoios>[0]>;
/** The outputs of `utxos` that sit at the escrow credential, which is all a Koios that has caught up with the node lists. */
export const escrowOutputsOf = (utxos: UTxO[]): UTxO[] => utxos.filter((u) => credentialOf(u.address) === ESCROW_SCRIPT_HASH);
/**
 * The Koios that describes the same chain as a node holding `utxos`: it has indexed the node's escrow-credential outputs and
 * knows the genuine spend chain (GENUINE_TXS). A Koios that lags, or knows more, is asked for on purpose, with `indexed` and
 * `txs`, so that a test of node and Koios disagreeing says so.
 */
export const koiosFor = (utxos: UTxO[], o: KoiosOptions = {}): KoiosFake => escrowKoios({ txs: GENUINE_TXS, indexed: escrowOutputsOf(utxos), ...o });
/** A node holding `utxos` and the Koios that describes the same chain (see koiosFor). */
export function world(utxos: UTxO[], o: KoiosOptions = {}) {
  return { node: new FixtureProvider(utxos), koios: koiosFor(utxos, o) };
}
