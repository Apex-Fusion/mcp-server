// packages/builder/test/fixtures/ledger-read-world.ts
// The world of the tests of the attestation, delegation and vault read tools: the identity deployment of Vector mainnet (derived from its
// published values, with the published script hashes checked in the tests), the Koios rows and transactions that capture-ledger-read.mjs
// read from mainnet, synthetic outputs where mainnet has no example (a start time, a hold, a Close, a child delegation), an offline node,
// and a fake Koios. The fake Koios answers four routes the way PostgREST does: credential_utxos (credential, datum filter, order,
// offset and limit), utxo_info, tx_info and tip. No test here touches the network.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Constr, Data, getAddressDetails } from '@lucid-evolution/lucid';
import type { Address, Credential, UTxO } from '@lucid-evolution/lucid';
import { makeIdentityDeployment } from '../../src/vector/identity-deployment.ts';
import type { IdentityDeployment } from '../../src/vector/identity-deployment.ts';
import { attestationDatumToData, delegationDatumToData, encodeAttestationDatum, encodeDelegationDatum, encodeIdentityDatum, encodeVaultDatum, utf8Hex } from '../../src/vector/identity-codec.ts';
import type { AttestationDatum, DelegationDatum, IdentityDatum, VaultDatum } from '../../src/vector/identity-codec.ts';
import { utxoOfKoiosRow } from '../../src/vector/ledger-read.ts';
import type { LedgerEnv } from '../../src/vector/ledger-read.ts';
import type { KoiosUtxo } from '../../src/vector/marketplace-indexer.ts';
import { FixtureProvider } from './fixture-provider.ts';
import { CONTROLLER_ACCOUNTABLE, rootRecord, testKey } from './identity-world.ts';

// ─── The deployment of mainnet ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The published values of the identity deployment of Vector mainnet (agents-marketplace, contracts/identity-marketplace/deploy/mainnet/deployment.json). */
export const MAINNET_VALUES = {
  legacyRoot: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  configSeed: { txHash: '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a', outputIndex: 0 },
  identity: 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762',
  attestation: 'f07c644e042ead094cc501f443e03a8955dc1f4d0dcd5b387863e042',
  delegation: 'bdc16990b844a8860f28c51bb0e6a469c84bebcd57db699ce204785a',
  escrow: 'bdd86d9ac1e6f2ef6bcf81c14522f86ada1b438ca7ae0c90c8459deb',
  vault: 'bd45078144effb5011f161d8bb433f2ee360da458644fca9b818097a',
} as const;

export const MAINNET: IdentityDeployment = makeIdentityDeployment({ legacyRoot: MAINNET_VALUES.legacyRoot, configSeed: MAINNET_VALUES.configSeed });

// ─── What the capture holds ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A Koios row of an output: the capture keeps what Koios sent. */
export type Row = KoiosUtxo;
/** The run of a script in a Koios transaction (`_scripts`): the redeemer and the input it spends. */
export interface Contract {
  script_hash: string;
  spends_input?: { tx_hash: string; tx_index: number } | null;
  input: { redeemer: { purpose: string; datum: { hash: string; value: { constructor?: number; fields: unknown[] } } } };
  [key: string]: unknown;
}
/** An input or an output of a Koios `tx_info` row. Its datum is shown in JSON form only (`bytes` is null). */
export interface TxIo {
  tx_hash: string; tx_index: number; value: string;
  payment_addr: { cred: string; bech32: string } | null;
  inline_datum: { bytes: string | null; value?: unknown } | null;
  [key: string]: unknown;
}
/** A Koios `tx_info` row with its inputs and scripts: the capture keeps what Koios sent. */
export interface TxRow { tx_hash: string; inputs: TxIo[]; outputs: TxIo[]; plutus_contracts: Contract[]; [key: string]: unknown }
export interface Capture {
  /** What the capture changed in the rows that Koios gave (the replaced locators), and that the file is not byte-true chain data. */
  note: string;
  captured: { at: string; tip: { block_height: number; abs_slot: number; block_time: number } };
  hashes: Record<'attestation' | 'delegation' | 'escrow' | 'vault', string>;
  attestations: Row[];
  delegations: { burned: { id: string; mint_output: Row }; live: { id: string; mint_output: Row } };
  vaults: Row[];
  payment: { escrow_ref: string; delegation: string; tx: TxRow };
  plain_escrow: { escrow_ref: string; tx: TxRow };
}
// The file is the output of capture-ledger-read.mjs, which checks its shape before it writes it.
export const CAPTURE = JSON.parse(readFileSync(resolve(import.meta.dirname!, 'ledger-read-mainnet.json'), 'utf-8')) as Capture;
/** The time of the capture: the block time of the tip, in POSIX ms. */
export const CAPTURE_MS = CAPTURE.captured.tip.block_time * 1000;

/** Is `x` a token of an asset list? */
const isToken = (x: unknown): x is { policy_id: string; asset_name: string } => typeof x === 'object' && x !== null && 'policy_id' in x && 'asset_name' in x;

/** The id of an attestation row: the name of its one attestation token. */
export function attestationIdOf(row: Row): string {
  const token = (row.asset_list ?? []).filter(isToken).find((a) => a.policy_id === MAINNET_VALUES.attestation);
  if (!token) throw new Error(`the row ${row.tx_hash}#${row.tx_index} holds no attestation token`);
  return token.asset_name;
}
/** The output of a Koios row; the rows of the capture all read. */
export function utxoOf(row: Row): UTxO {
  const utxo = utxoOfKoiosRow(row);
  if (utxo === null) throw new Error(`the row ${row.tx_hash}#${row.tx_index} is not an output`);
  return utxo;
}

/** The transaction `tx` with the redeemer of its vault script run changed to the constructor `constructor` (0 is Pay, 1 is Close). */
export function withVaultRedeemer(tx: TxRow, constructor: number): TxRow {
  const change = (c: Contract): Contract => {
    if (c.script_hash !== MAINNET_VALUES.vault) return c;
    const { redeemer } = c.input;
    return { ...c, input: { ...c.input, redeemer: { ...redeemer, datum: { ...redeemer.datum, value: { ...redeemer.datum.value, constructor } } } } };
  };
  return { ...structuredClone(tx), plutus_contracts: tx.plutus_contracts.map(change) };
}

// ─── Synthetic outputs ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DAY = 86_400_000;
let counter = 0;
const nextTx = (): string => { counter += 1; return counter.toString(16).padStart(8, '0').repeat(8); };

export const ISSUER_KEY = testKey(21);

/** A valid attestation datum of type 15 by a key without a record, issued at `CAPTURE_MS`; `over` changes fields. */
export function attestation(over: Partial<AttestationDatum> = {}): AttestationDatum {
  return {
    subject: 'a1'.repeat(32), issuer: ISSUER_KEY.publicKey, issuerId: null, attType: 15, format: null, profile: null, digest: 'd1'.repeat(32), locator: null, envelopeSig: null,
    issuedAt: CAPTURE_MS, validFrom: null, validUntil: null, solicited: false, status: { type: 'AttActive' }, contested: null, links: [], ...over,
  };
}
/** The output of attestation `id` at the mainnet attestation address, with its token and 5 AP3X. */
export function attestationUtxo(id: string, datum: AttestationDatum, over: Partial<UTxO> = {}): UTxO {
  return {
    txHash: nextTx(), outputIndex: 0, address: MAINNET.attestation.address, assets: { lovelace: 5_000_000n, [`${MAINNET.attestation.hash}${id}`]: 1n },
    datum: encodeAttestationDatum(datum), ...over,
  };
}

/** A delegation datum that covers the hire action on the mainnet escrow, from a principal key; `over` changes fields. */
export function delegation(over: Partial<DelegationDatum> = {}): DelegationDatum {
  return {
    delegator: { type: 'PrincipalKey', hash: testKey(30).keyHash, organisation: null }, parent: null, delegate: 'c3'.repeat(32), delegateKey: testKey(31).keyHash,
    actions: [utf8Hex('marketplace.hire.v1')], resources: [utf8Hex(`script:${MAINNET.escrow.hash}`)], notBefore: CAPTURE_MS - 2 * DAY, notAfter: CAPTURE_MS + 5 * DAY,
    depth: 1, remaining: 2, purpose: null, value: { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY }, ...over,
  };
}
export function delegationUtxo(id: string, datum: DelegationDatum, over: Partial<UTxO> = {}): UTxO {
  return {
    txHash: nextTx(), outputIndex: 0, address: MAINNET.delegation.address, assets: { lovelace: 2_400_000n, [`${MAINNET.delegation.hash}${id}`]: 1n },
    datum: encodeDelegationDatum(datum), ...over,
  };
}

export function vaultUtxo(datum: VaultDatum, lovelace: bigint, over: Partial<UTxO> = {}): UTxO {
  return { txHash: nextTx(), outputIndex: 1, address: MAINNET.vault.address, assets: { lovelace }, datum: encodeVaultDatum(datum), ...over };
}

/** A record that is Active at `CAPTURE_MS`: its Accountable Party started long before; `keys` are listed with every purpose. */
export function liveRecord(over: Partial<IdentityDatum> = {}, keys: string[] = []): IdentityDatum {
  return rootRecord({
    parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: CAPTURE_MS - 60 * DAY }], createdAt: CAPTURE_MS - 60 * DAY,
    keys: keys.map((key) => ({ keyType: 'Ed25519' as const, key, purposes: 1 + 2 + 8 + 16, pop: null })), ...over,
  });
}
/** The record output of `id` at the mainnet identity address. */
export function recordUtxo(id: string, record: IdentityDatum): UTxO {
  return { txHash: nextTx(), outputIndex: 0, address: MAINNET.identity.address, assets: { lovelace: 10_000_000n, [`${MAINNET.identity.hash}${id}`]: 1n }, datum: encodeIdentityDatum(record) };
}

// ─── Koios rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An output as Koios shows it with extended rows (`utxo_info`, `credential_utxos`). */
export function koiosRow(utxo: UTxO, over: Partial<Row> = {}): Row {
  const tokens = Object.entries(utxo.assets).filter(([unit]) => unit !== 'lovelace');
  return {
    tx_hash: utxo.txHash, tx_index: utxo.outputIndex, address: utxo.address, value: String(utxo.assets.lovelace),
    payment_cred: getAddressDetails(utxo.address).paymentCredential?.hash, datum_hash: null, inline_datum: utxo.datum ? { bytes: utxo.datum } : null,
    reference_script: null, is_spent: false, block_height: 9_000_000, block_time: 1_794_000_000,
    asset_list: tokens.map(([unit, quantity]) => ({ policy_id: unit.slice(0, 56), asset_name: unit.slice(56), quantity: String(quantity), decimals: 0 })), ...over,
  };
}

export interface KoiosCall { route: string; method: string; url: string; body: Record<string, unknown> | null }
export interface LedgerKoios { f: typeof fetch; calls: KoiosCall[] }
export const callsTo = (k: LedgerKoios, route: string): KoiosCall[] => k.calls.filter((c) => c.route === route);

/**
 * Awaits `work`, and fails when it has not ended after `ms`. A call that must end by its own budget cannot hang its test when the
 * budget does not work: the timer here keeps the event loop alive until it fires, and it is cleared when `work` ends.
 */
export async function endsWithin<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the call did not end within ${ms} ms`)), ms); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface KoiosOptions {
  /** The outputs that credential_utxos lists, by payment credential. */
  rows?: Row[];
  /** The rows that utxo_info knows, by output reference. */
  utxoInfo?: Row[];
  /** The transactions that tx_info knows. */
  txs?: TxRow[];
  /** The height that tip answers (default: the tip of the capture); null answers an empty list. */
  tip?: number | null;
  /** Makes a route answer with this HTTP status. */
  status?: Record<string, number>;
  /** The most rows that one credential_utxos answer holds (default 1,000, the cap of Koios). */
  pageCap?: number;
  /** A Koios that does not apply the datum filter, which a read must not rely on. */
  ignoreDatumFilter?: boolean;
  /** A Koios that lists in the order of its own index and not in the one asked for, which a read must not rely on. */
  ignoreOrder?: boolean;
  /** A Koios that does not apply the token filter (asset_list=cs.…), which a read must not rely on. */
  ignoreAssetFilter?: boolean;
  /** Makes the answer of a route announce this many bytes in its content-length header, whatever the body holds. */
  announce?: Record<string, number>;
}

/** A fake Koios (see KoiosOptions). */
export function ledgerKoios(o: KoiosOptions = {}): LedgerKoios {
  const calls: KoiosCall[] = [];
  // The fake stands in for fetch, whose type has more overloads than a test needs to fake.
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const route = u.pathname.split('/').pop()!;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string[]> : null;
    calls.push({ route, method: init?.method ?? 'GET', url, body });
    if (o.status?.[route]) return new Response('{"error":"internal"}', { status: o.status[route] });
    const answer = (rows: unknown): Response => new Response(JSON.stringify(rows), { status: 200, headers: o.announce?.[route] === undefined ? {} : { 'content-length': String(o.announce[route]) } });
    if (route === 'tip') {
      const height = o.tip === undefined ? CAPTURE.captured.tip.block_height : o.tip;
      return answer(height === null ? [] : [{ block_height: height, block_no: height }]);
    }
    if (route === 'credential_utxos') {
      let rows = (o.rows ?? []).filter((r) => body!._payment_credentials.includes(r.payment_cred ?? ''));
      const like = u.searchParams.get('inline_datum->>bytes');
      if (like?.startsWith('like.') && !o.ignoreDatumFilter) { const needle = like.slice(5).replace(/\*/g, ''); rows = rows.filter((r) => r.inline_datum?.bytes?.includes(needle)); }
      // PostgREST containment: the rows whose asset list holds a token that has every key and value of each object asked for.
      const assets = u.searchParams.get('asset_list');
      if (assets?.startsWith('cs.') && !o.ignoreAssetFilter) {
        const wanted = JSON.parse(assets.slice(3)) as Array<Record<string, unknown>>;
        rows = rows.filter((r) => wanted.every((w) => (r.asset_list ?? []).some((t) => isToken(t) && Object.entries(w).every(([k, v]) => Object.getOwnPropertyDescriptor(t, k)?.value === v))));
      }
      if (!o.ignoreOrder && u.searchParams.get('order') === 'tx_hash.asc,tx_index.asc') rows = [...rows].sort((a, b) => (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : a.tx_index - b.tx_index));
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 1000), o.pageCap ?? 1000);
      return answer(rows.slice(offset, offset + limit));
    }
    if (route === 'utxo_info') return answer((o.utxoInfo ?? []).filter((r) => body!._utxo_refs.includes(`${r.tx_hash}#${r.tx_index}`)));
    if (route === 'tx_info') return answer((o.txs ?? []).filter((t) => body!._tx_hashes.includes(t.tx_hash)));
    return new Response('[]', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

// ─── Worlds ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The offline node of the tests, and the addresses that were scanned on it: how a token output is found when Koios has no answer is a
 * scan of its address, so the scans count the reads of delegations, records and attestations that a call makes.
 */
export class CountingProvider extends FixtureProvider {
  readonly scans: string[] = [];
  override async getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> {
    this.scans.push(typeof addressOrCredential === 'string' ? addressOrCredential : JSON.stringify(addressOrCredential));
    return super.getUtxos(addressOrCredential);
  }
  /** How many times the node scanned `address`. */
  scansOf(address: string): number { return this.scans.filter((a) => a === address).length; }
}

export interface LedgerWorld { env: LedgerEnv; provider: CountingProvider; koios: LedgerKoios }

/**
 * A node that holds `utxos`, and a Koios that lists the same outputs (`koios.rows` lists others), on the mainnet deployment. `koios`
 * sets what else Koios knows.
 */
export function ledgerWorld(utxos: UTxO[], koios: KoiosOptions = {}): LedgerWorld {
  const provider = new CountingProvider(utxos);
  const k = ledgerKoios({ ...koios, rows: koios.rows ?? utxos.map((u) => koiosRow(u)) });
  return { env: { provider, deployment: MAINNET, koiosUrl: 'https://koios.example', fetchImpl: k.f }, provider, koios: k };
}

// ─── Datums that the codec of the builders refuses ────────────────────────────────────────────────────────────────────────────
// The contract accepts any integer below 2^63 where a datum holds one, and the codec holds a number: these are the datums that a hostile
// writer can make, which a read must not lose.

/** The Plutus Data of a datum as a constructor: the datums of the builders are all constructors. */
function constrOf(data: Data): Constr<Data> {
  if (!(data instanceof Constr)) throw new Error('a datum is not a constructor');
  return data;
}

/** The hex of an attestation datum whose status is Revoked with exactly the fields `status`: a datum that the contract cannot make, or one that a number cannot hold. `over` changes the other fields. */
export function revokedWithStatus(status: Data[], over: Partial<AttestationDatum> = {}): string {
  const data = constrOf(attestationDatumToData(attestation({ ...over, status: { type: 'AttRevoked', at: CAPTURE_MS - DAY, reason: 0 } })));
  return Data.to(new Constr(0, data.fields.map((field, i) => (i === 13 ? new Constr(1, status) : field))));
}

/** The hex of a revoked attestation whose revocation reason is `reason`: an integer that a number may not hold. `over` changes the other fields. */
export function revokedWithReason(reason: bigint, over: Partial<AttestationDatum> = {}): string {
  return revokedWithStatus([BigInt(CAPTURE_MS - DAY), reason], over);
}

/** The hex of a delegation under a value limit whose period is `periodMs` ms: an integer that a number may not hold. */
export function delegationWithPeriod(periodMs: bigint, over: Partial<DelegationDatum> = {}): string {
  const data = constrOf(delegationDatumToData(delegation({ ...over, value: { perTx: 6_000_000n, total: 22_000_000n, periodMs: 0 } })));
  const some = constrOf(data.fields[11]);
  const limit = constrOf(some.fields[0]);
  return Data.to(new Constr(0, data.fields.map((field, i) => (i === 11 ? new Constr(0, [new Constr(0, [limit.fields[0], limit.fields[1], periodMs])]) : field))));
}

/** The outputs of the capture as a node would hold them: the attestations, the live delegation and the vault outputs. */
export function capturedUtxos(): UTxO[] {
  return [...CAPTURE.attestations, CAPTURE.delegations.live.mint_output, ...CAPTURE.vaults].map(utxoOf);
}
