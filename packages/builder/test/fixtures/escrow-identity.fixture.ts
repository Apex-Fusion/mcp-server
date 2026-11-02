// packages/builder/test/fixtures/escrow-identity.fixture.ts
// The identity marketplace offline (Part 2 Sections 5.3 and 6): an agent whose record lists the supplier key (LISTED) and the
// capability, its advert in the identity layout, identity-marketplace escrows built with the codecs, delegations and vaults, and one
// fake that answers Koios (utxo_info, credential_utxos, tx_info) and the marketplace indexer (/suppliers, /escrows) from one list of
// outputs. The node is identity-world's FixtureProvider, so the real applied escrow, advert and vault scripts run on every build.
import { credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { DEPLOYMENT, LISTED, PARTY_KEY, NOW, DAY, OWN_ADDRESS, recordUtxo, rootRecord } from './identity-world.ts';
import {
  encodeIdentityAdvertDatum, encodeIdentityEscrowDatum, promptHashForPayload, requestSpecHash, sha256Utf8Hex,
} from '../../src/vector/marketplace-datum.ts';
import type { IdentityAdvertDatum, IdentityEscrowDatum } from '../../src/vector/marketplace-datum.ts';
import { encodeDelegationDatum, encodeVaultDatum, plutusAddressFromBech32, utf8Hex } from '../../src/vector/identity-codec.ts';
import type { DelegationDatum, IdentityDatum, VaultDatum } from '../../src/vector/identity-codec.ts';

export const OWN_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
/** The agent that the identity advert names; its record lists LISTED with the transaction purpose and demo.text.stats.v1. */
export const AGENT_ID = 'ae'.repeat(32);
export const AGENT_DID = `did:vector:${AGENT_ID}`;
export const CAPABILITY = 'demo.text.stats.v1';
export const PAYLOAD = 'count the words';
export const SUPPLIER_PKH = LISTED.keyHash;
export const supplierEnterprise = credentialToAddress('Mainnet', { type: 'Key', hash: SUPPLIER_PKH });
export const keyAddress = (pkh: string): string => credentialToAddress('Mainnet', { type: 'Key', hash: pkh });

export const ADVERT_TX = 'ad'.repeat(32);
export const ADVERT_REF = `${ADVERT_TX}#0`;
export const IDENTITY_ADVERT: IdentityAdvertDatum = {
  supplier_pkh: SUPPLIER_PKH, capability_id: CAPABILITY, model: 'echo-v1', max_output_tokens: 256, max_processing_ms: 60_000,
  price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
  endpoint_url: 'https://agent.example', detail_uri: '', detail_hash: sha256Utf8Hex(''), advertised_at: NOW - DAY, status: 'Active', agent_id: AGENT_ID,
};
export const advertUtxo = (advert: IdentityAdvertDatum = IDENTITY_ADVERT, over: Partial<UTxO> = {}): UTxO => ({
  txHash: ADVERT_TX, outputIndex: 0, address: DEPLOYMENT.advert.address, assets: { lovelace: 2_000_000n }, datum: encodeIdentityAdvertDatum(advert), ...over,
});
export const agentRecord = (over: Partial<IdentityDatum> = {}): UTxO => recordUtxo(AGENT_ID, rootRecord(over));

/** An identity escrow posted by the wallet for the identity advert at `postedAt`, refunding to the wallet's own address. */
export function identityEscrow(postedAt: number, over: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  return {
    buyer_pkh: OWN_PKH, supplier_pkh: SUPPLIER_PKH, advert_ref: { txHash: ADVERT_TX, index: 0 }, capability_id: CAPABILITY,
    request_spec_hash: requestSpecHash(IDENTITY_ADVERT), prompt_hash: promptHashForPayload(PAYLOAD),
    payment_lovelace: 2_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n,
    deliver_by: postedAt + 60_000 + 180_000, posted_at: postedAt, submitted_at: null, result_receipt_hash: null, state: 'Open',
    agent_id: AGENT_ID, refund: { address: plutusAddressFromBech32(OWN_ADDRESS), datum: null },
    ...over,
  };
}
export const submitted = (d: IdentityEscrowDatum, submittedAt: number): IdentityEscrowDatum => ({ ...d, state: 'Submitted', submitted_at: submittedAt, result_receipt_hash: 'cd'.repeat(32) });
/** What the escrows of these tests lock. */
export const ESCROW_LOCK = 4_600_000n;
export const escrowUtxo = (txHash: string, datum: IdentityEscrowDatum, over: Partial<UTxO> = {}): UTxO => ({
  txHash, outputIndex: 0, address: DEPLOYMENT.escrow.address, assets: { lovelace: ESCROW_LOCK }, datum: encodeIdentityEscrowDatum(datum), ...over,
});
export const POST_TX = 'e1'.repeat(32);
export const CLAIM_TX = 'e2'.repeat(32);
export const SUBMIT_TX = 'e3'.repeat(32);
export const ESCROW_REF = `${POST_TX}#0`;
/** The spend chain of an identity escrow: the Claim spent the Post output, the Submit spent the Claimed output. */
export const CHAIN_TXS: Record<string, Array<[string, string]>> = {
  [CLAIM_TX]: [[ESCROW_REF, DEPLOYMENT.escrow.address], [`${'f1'.repeat(32)}#0`, supplierEnterprise]],
  [SUBMIT_TX]: [[`${CLAIM_TX}#0`, DEPLOYMENT.escrow.address]],
};

// ─── Delegations and vaults ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const DELEGATE_ID = 'de'.repeat(32);
export const DELEGATION_ID = 'dd'.repeat(32);
/** The key the delegate agent signs payments with: PARTY_KEY, which its record lists with the delegation purpose. */
export const DELEGATE_KEY = PARTY_KEY;
export const delegateRecord = (over: Partial<IdentityDatum> = {}): UTxO =>
  recordUtxo(DELEGATE_ID, rootRecord({ keys: [{ keyType: 'Ed25519', key: DELEGATE_KEY.publicKey, purposes: 1 + 16, pop: null }], capabilities: [], ...over }));
export function delegation(over: Partial<DelegationDatum> = {}): DelegationDatum {
  return {
    delegator: { type: 'PrincipalKey', hash: OWN_PKH, organisation: null }, parent: null, delegate: DELEGATE_ID, delegateKey: DELEGATE_KEY.keyHash,
    actions: [utf8Hex('marketplace.*')], resources: [utf8Hex(`script:${DEPLOYMENT.escrow.hash}`)],
    notBefore: NOW - 10 * DAY, notAfter: NOW + 30 * DAY, depth: 1, remaining: 0, purpose: null,
    value: { perTx: 50_000_000n, total: 100_000_000n, periodMs: DAY },
    ...over,
  };
}
export const delegationUtxo = (d: DelegationDatum = delegation(), id = DELEGATION_ID): UTxO => ({
  txHash: 'd1'.repeat(32), outputIndex: 0, address: DEPLOYMENT.delegation.address, assets: { lovelace: 3_000_000n, [`${DEPLOYMENT.delegation.hash}${id}`]: 1n }, datum: encodeDelegationDatum(d),
});
export const VAULT_TX = 'fa'.repeat(32);
export const vaultUtxo = (datum: VaultDatum, lovelace = 100_000_000n, outputIndex = 0, over: Partial<UTxO> = {}): UTxO => ({
  txHash: VAULT_TX, outputIndex, address: DEPLOYMENT.vault.address, assets: { lovelace }, datum: encodeVaultDatum(datum), ...over,
});
export const liveVault = (over: Partial<Extract<VaultDatum, { type: 'Live' }>> = {}): VaultDatum => ({
  type: 'Live', owner: { type: 'PrincipalKey', hash: OWN_PKH, organisation: null }, delegation: DELEGATION_ID, spent: 0n, periodStart: 0, ...over,
});

// ─── Koios and the indexer ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ChainFake = { f: typeof fetch; calls: string[] };
const credentialOf = (address: string): string | undefined => { try { return getAddressDetails(address).paymentCredential?.hash; } catch { return undefined; } };
const row = (u: UTxO, spent: boolean) => ({
  tx_hash: u.txHash, tx_index: u.outputIndex, address: u.address, value: String(u.assets.lovelace), is_spent: spent,
  inline_datum: u.datum ? { bytes: u.datum } : null, payment_cred: credentialOf(u.address),
});

/**
 * Koios and the indexer for one chain: `live` are the unspent outputs (also on the node), `spent` the outputs Koios still describes
 * after their spend, `txs` the inputs of the transactions Koios knows (as [ref, address]), `listed` the rows of GET /suppliers and
 * `escrows` the rows of GET /escrows.
 */
export function chainFake(o: { live?: UTxO[]; spent?: UTxO[]; txs?: Record<string, Array<[string, string]>>; listed?: unknown[]; escrows?: unknown[] } = {}): ChainFake {
  const calls: string[] = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.endsWith('/api/v1/utxo_info')) {
      const refs = body._utxo_refs as string[];
      return reply([...(o.live ?? []).map((u) => row(u, false)), ...(o.spent ?? []).map((u) => row(u, true))].filter((r) => refs.includes(`${r.tx_hash}#${r.tx_index}`)));
    }
    if (url.pathname.endsWith('/api/v1/credential_utxos')) {
      const creds = body._payment_credentials as string[];
      const like = url.searchParams.get('inline_datum->>bytes')?.replace(/^like\./, '').replace(/\*/g, '');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const rows = (o.live ?? []).filter((u) => creds.includes(credentialOf(u.address) ?? '') && (!like || (u.datum ?? '').includes(like))).map((u) => row(u, false));
      return reply(rows.slice(offset));
    }
    if (url.pathname.endsWith('/api/v1/tx_info')) {
      const hashes = body._tx_hashes as string[];
      return reply(hashes.filter((h) => o.txs?.[h] !== undefined).map((h) => ({
        tx_hash: h, inputs: o.txs![h].map(([ref, address]) => ({ tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)), payment_addr: { bech32: address, cred: credentialOf(address) } })),
      })));
    }
    if (url.pathname.endsWith('/suppliers')) return reply(o.listed ?? []);
    if (url.pathname.endsWith('/escrows')) return reply(o.escrows ?? []);
    return new Response(JSON.stringify({ unexpected: url.toString() }), { status: 500 });
  }) as typeof fetch;
  return { f, calls };
}

/** The indexer's row of a listed identity advert. */
export const listedRow = (ref = ADVERT_REF, agentId: string | null = AGENT_ID, over: Record<string, unknown> = {}) => ({
  utxo_ref: ref, supplier_pkh: SUPPLIER_PKH, capability_id: CAPABILITY, model: 'echo-v1', max_output_tokens: 256, max_processing_ms: 60_000,
  price_lovelace: '2000000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', endpoint_url: 'https://agent.example', detail_uri: '',
  detail_hash: sha256Utf8Hex(''), advertised_at: NOW - DAY, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: null, created_slot: 1,
  agent_id: agentId, ...over,
});
