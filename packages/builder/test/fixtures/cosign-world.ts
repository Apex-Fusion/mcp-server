// packages/builder/test/fixtures/cosign-world.ts
// An offline world for the delegation co-signature tests: a Delegate transaction that the real delegation script accepts (built by
// buildDelegate on the identity world), a delegate record with an endpoint, test keys whose private halves the tests hold (to sign as
// the delegator, as the wallet and as the agent), helpers that change a transaction in one place, and a fake agent that records every
// request it gets. No network.
import { once } from 'node:events';
import { CML, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { DEPLOYMENT, DAY, NOW, OWN_ADDRESS, identityWorld, lucidOn, recordUtxo, rootRecord, testKey } from './identity-world.ts';
import type { FixtureProvider } from './fixture-provider.ts';
import { lucidForAddress } from '../../src/vector/build.ts';
import { HIRE_ACTION, buildDelegate, escrowResource } from '../../src/vector/delegation-build.ts';
import type { DelegateBuild, DelegateParams } from '../../src/vector/delegation-build.ts';
import { utf8Hex } from '../../src/vector/identity-codec.ts';
import type { IdentityDatum } from '../../src/vector/identity-codec.ts';
import { keyHashOf } from '../../src/vector/identity-rules.ts';

export { DEPLOYMENT, DAY, NOW, OWN_ADDRESS };

// ─── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SigningKey { privateKey: CML.PrivateKey; publicKey: string; keyHash: string }
/** The key that testKey(n) names, with its private half (a deterministic test key, no secret). */
export function signingKey(n: number): SigningKey {
  const privateKey = CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, n));
  const publicKey = Buffer.from(privateKey.to_public().to_raw_bytes()).toString('hex');
  return { privateKey, publicKey, keyHash: keyHashOf(publicKey) };
}
/** The delegate key of the delegation: the delegate's record lists it with the delegation purpose. */
export const DELEGATE_KEY = signingKey(11);
/** A second delegation key of the delegate, and a key that nobody lists. */
export const SECOND_KEY = signingKey(12);
export const STRANGER_KEY = signingKey(30);
/** The principal that delegates. */
export const PRINCIPAL_KEY = signingKey(14);
/** The key of a wallet that the tests hold, so that a transaction can be signed by every key that it needs. */
export const WALLET_KEY = signingKey(20);
export const MY_WALLET = credentialToAddress('Mainnet', { type: 'Key', hash: WALLET_KEY.keyHash });
/** The key hash of the fixture wallet at OWN_ADDRESS (no test holds its private key). */
export const OWN_KEY_HASH = CML.Address.from_bech32(OWN_ADDRESS).payment_cred()!.as_pub_key()!.to_hex();

// ─── The world ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DELEGATE_ID = 'c3'.repeat(32);
export const DELEGATE_DID = `did:vector:${DELEGATE_ID}`;
export const ENDPOINT = 'https://agent.example';
export const ESCROW = escrowResource(DEPLOYMENT.escrow.hash);
/** The build time of every transaction (NOW) and a moment inside its window: the tool reads this clock, not the real one. */
export const AT_BUILD = NOW + 2 * 60_000;

const listed = (k: SigningKey) => ({ keyType: 'Ed25519' as const, key: k.publicKey, purposes: 16, pop: null });
/** Where the record of the delegate lives, in every world: a variant of the record has the same reference, as an unchanged record has. */
const DELEGATE_RECORD_REF = { txHash: 'c4'.repeat(32), outputIndex: 0 };
/** The record of the delegate: it lists DELEGATE_KEY and SECOND_KEY with the delegation purpose, and has `endpoint` (UTF-8 text). */
export function delegateRecord(endpoint: string = ENDPOINT, overrides: Partial<IdentityDatum> = {}): UTxO {
  return {
    ...recordUtxo(DELEGATE_ID, rootRecord({ controller: testKey(10).publicKey, keys: [listed(DELEGATE_KEY), listed(SECOND_KEY)], endpoint: utf8Hex(endpoint), ...overrides })),
    ...DELEGATE_RECORD_REF,
  };
}

/** Two outputs of the wallet that the tests hold: a seed and a collateral output. */
export const MY_WALLET_UTXOS: UTxO[] = [
  { txHash: 'ab'.repeat(32), outputIndex: 0, address: MY_WALLET, assets: { lovelace: 1_000_000_000n } },
  { txHash: 'ab'.repeat(32), outputIndex: 1, address: MY_WALLET, assets: { lovelace: 5_000_000n } },
];

/**
 * The node: `record` (the record of the delegate), the wallet that the tests hold, and `extra`. Every world holds the same outputs at
 * the same references (the reference scripts, the fixture wallet, the wallet of the tests, the record of the delegate), so a
 * transaction that one world built is a transaction that every world can check.
 */
export const worldWith = (record: UTxO, ...extra: UTxO[]): FixtureProvider => identityWorld([record, ...MY_WALLET_UTXOS, ...extra]);
/** The node with the record of the delegate as `delegateRecord(endpoint)` makes it. */
export const world = (endpoint: string = ENDPOINT, ...extra: UTxO[]): FixtureProvider => worldWith(delegateRecord(endpoint), ...extra);
/** A node with the wallet that the tests hold and no record of the delegate. */
export const worldWithoutDelegate = (): FixtureProvider => identityWorld(MY_WALLET_UTXOS);

/**
 * A Delegate transaction of PRINCIPAL_KEY to the delegate with DELEGATE_KEY, built by the real builder on `provider`. By default the
 * fixture wallet (OWN_ADDRESS) pays; with `mine` the wallet that the tests hold pays, so that every signer can be a test key.
 */
export async function buildDelegation(p: Partial<DelegateParams> = {}, mine = false, provider: FixtureProvider = world()): Promise<DelegateBuild> {
  const lucid = mine ? await lucidForAddress(provider, MY_WALLET) : await lucidOn(provider);
  return buildDelegate({ lucid, provider, deployment: DEPLOYMENT }, {
    changeAddress: mine ? MY_WALLET : OWN_ADDRESS, nowMs: NOW, delegator: { type: 'PrincipalKey', hash: PRINCIPAL_KEY.keyHash },
    delegate: DELEGATE_ID, delegateKey: DELEGATE_KEY.keyHash, actions: [HIRE_ACTION], resources: [ESCROW], notAfter: NOW + 30 * DAY,
    value: { perTx: 7_000_000n, total: 7_000_000n, periodMs: DAY }, ...p,
  });
}
let built: Promise<DelegateBuild> | undefined;
let builtMine: Promise<DelegateBuild> | undefined;
/** The shared build (fixture wallet), made once: a transaction is immutable text. */
export const delegateBuild = (): Promise<DelegateBuild> => (built ??= buildDelegation());
/** The shared build that the wallet of the tests pays. */
export const delegateBuildMine = (): Promise<DelegateBuild> => (builtMine ??= buildDelegation({}, true));

// ─── Reading and changing a transaction ────────────────────────────────────────────────────────────────────────────────────────

export const txOf = (cbor: string): CML.Transaction => CML.Transaction.from_cbor_hex(cbor);
export const bodyHashOf = (cbor: string): string => CML.hash_transaction(txOf(cbor).body()).to_hex();

/** The vkey witnesses of a transaction, in order. */
export function vkeysOf(cbor: string): CML.Vkeywitness[] {
  const list = txOf(cbor).witness_set().vkeywitnesses();
  return Array.from({ length: list?.len() ?? 0 }, (_, i) => list!.get(i));
}
export const keyHashesOf = (cbor: string): string[] => vkeysOf(cbor).map((w) => w.vkey().hash().to_hex());

/** The witness of `key` over the body of `cbor`. */
export const witnessOf = (key: SigningKey, cbor: string): CML.Vkeywitness =>
  CML.Vkeywitness.new(key.privateKey.to_public(), key.privateKey.sign(CML.hash_transaction(txOf(cbor).body()).to_raw_bytes()));

/** `cbor` with exactly these vkey witnesses (in this order) and every other part of the transaction as it was. */
export function withVkeys(cbor: string, witnesses: CML.Vkeywitness[]): string {
  const tx = txOf(cbor);
  const witnessSet = tx.witness_set();
  const list = CML.VkeywitnessList.new();
  for (const w of witnesses) list.add(w);
  witnessSet.set_vkeywitnesses(list);
  return CML.Transaction.new(tx.body(), witnessSet, tx.is_valid(), tx.auxiliary_data()).to_cbor_hex();
}
/** `cbor` signed by `keys`, each added after the witnesses that it has. */
export const signedBy = (cbor: string, ...keys: SigningKey[]): string => withVkeys(cbor, [...vkeysOf(cbor), ...keys.map((k) => witnessOf(k, cbor))]);
/** What a faithful agent returns: the transaction as it got it, with one more witness of its key. */
export const cosigned = (cbor: string, key: SigningKey = DELEGATE_KEY): string => signedBy(cbor, key);

/** `cbor` with the same body and witnesses, and a changed part: the witness set, the validity flag or the auxiliary data. */
export function withParts(cbor: string, change: { witnessSet?: (set: CML.TransactionWitnessSet) => void; isValid?: boolean; auxiliary?: boolean }): string {
  const tx = txOf(cbor);
  const witnessSet = tx.witness_set();
  change.witnessSet?.(witnessSet);
  return CML.Transaction.new(tx.body(), witnessSet, change.isValid ?? tx.is_valid(), change.auxiliary ? CML.AuxiliaryData.new() : tx.auxiliary_data()).to_cbor_hex();
}

export interface BodyChange {
  fee?: bigint;
  outputs?: CML.TransactionOutput[];
  mint?: CML.Mint;
  requiredSigners?: string[];
  /** The collateral inputs, as `<txhash>#<index>`. */
  collateral?: string[];
  /** The slot of the start of the validity interval, and of its end (`ttl`); `null` leaves the bound out. */
  start?: bigint | null;
  ttl?: bigint | null;
  /** A last change of the new body: a withdrawal, a certificate, a vote and so on. */
  change?: (body: CML.TransactionBody) => void;
}
/** `cbor` with a changed body (the body is rebuilt, so its hash changes) and the same witness set. */
export function withBody(cbor: string, change: BodyChange): string {
  const tx = txOf(cbor);
  const old = tx.body();
  let outputs = old.outputs();
  if (change.outputs) { outputs = CML.TransactionOutputList.new(); for (const o of change.outputs) outputs.add(o); }
  const body = CML.TransactionBody.new(old.inputs(), outputs, change.fee ?? old.fee());
  const ttl = change.ttl === undefined ? old.ttl() : change.ttl; if (ttl !== null && ttl !== undefined) body.set_ttl(ttl);
  const start = change.start === undefined ? old.validity_interval_start() : change.start; if (start !== null && start !== undefined) body.set_validity_interval_start(start);
  const mint = change.mint ?? old.mint(); if (mint) body.set_mint(mint);
  const scriptData = old.script_data_hash(); if (scriptData) body.set_script_data_hash(scriptData);
  let collateral = old.collateral_inputs();
  if (change.collateral) {
    collateral = CML.TransactionInputList.new();
    for (const ref of change.collateral) { const [hash, index] = ref.split('#'); collateral.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(hash), BigInt(index))); }
  }
  if (collateral) body.set_collateral_inputs(collateral);
  let signers = old.required_signers();
  if (change.requiredSigners) { signers = CML.Ed25519KeyHashList.new(); for (const h of change.requiredSigners) signers.add(CML.Ed25519KeyHash.from_hex(h)); }
  if (signers) body.set_required_signers(signers);
  const network = old.network_id(); if (network) body.set_network_id(network);
  const ret = old.collateral_return(); if (ret) body.set_collateral_return(ret);
  const total = old.total_collateral(); if (total !== undefined) body.set_total_collateral(total);
  const refs = old.reference_inputs(); if (refs) body.set_reference_inputs(refs);
  change.change?.(body);
  return CML.Transaction.new(body, tx.witness_set(), tx.is_valid(), tx.auxiliary_data()).to_cbor_hex();
}

export const outputsOf = (cbor: string): CML.TransactionOutput[] => {
  const list = txOf(cbor).body().outputs();
  return Array.from({ length: list.len() }, (_, i) => list.get(i));
};
/** The index of the output at the delegation address. */
export const delegationOutputIndex = (cbor: string): number => outputsOf(cbor).findIndex((o) => o.address().to_bech32() === DEPLOYMENT.delegation.address);

/** A Mint of the given tokens: `[policy, name, quantity]`, both in hex. */
export function mintOf(...tokens: Array<[string, string, bigint]>): CML.Mint {
  const mint = CML.Mint.new();
  for (const [policy, name, quantity] of tokens) mint.set(CML.ScriptHash.from_hex(policy), CML.AssetName.from_hex(name), quantity);
  return mint;
}
/** The output `o` with another datum (inline) and, when given, another value. */
export function withDatum(o: CML.TransactionOutput, datumHex: string | null, value?: CML.Value): CML.TransactionOutput {
  return CML.TransactionOutput.new(o.address(), value ?? o.amount(), datumHex === null ? undefined : CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(datumHex)), o.script_ref());
}

// ─── Parts that a Delegate transaction does not have ────────────────────────────────────────────────────────────────────────────

const STAKE_KEY_HASH = CML.Ed25519KeyHash.from_hex('bb'.repeat(28));
const stakeCredential = (): CML.Credential => CML.Credential.new_pub_key(STAKE_KEY_HASH);
/** Each function adds one such part to the body that `withBody` builds. */
export const addWithdrawal = (body: CML.TransactionBody): void => {
  const withdrawals = CML.MapRewardAccountToCoin.new();
  withdrawals.insert(CML.RewardAddress.new(1, stakeCredential()), 1n);
  body.set_withdrawals(withdrawals);
};
export const addCertificate = (body: CML.TransactionBody): void => {
  const certs = CML.CertificateList.new();
  certs.add(CML.Certificate.new_stake_registration(stakeCredential()));
  body.set_certs(certs);
};
export const addVote = (body: CML.TransactionBody): void => {
  const votes = CML.VotingProcedures.new();
  const byAction = CML.MapGovActionIdToVotingProcedure.new();
  byAction.insert(CML.GovActionId.new(CML.TransactionHash.from_hex('00'.repeat(32)), 0n), CML.VotingProcedure.new(CML.Vote.Yes));
  votes.insert(CML.Voter.new_constitutional_committee_hot_key_hash(STAKE_KEY_HASH), byAction);
  body.set_voting_procedures(votes);
};
export const addProposal = (body: CML.TransactionBody): void => {
  const proposals = CML.ProposalProcedureList.new();
  const anchor = CML.Anchor.new(CML.Url.from_json('"https://proposal.example"'), CML.AnchorDocHash.from_hex('00'.repeat(32)));
  proposals.add(CML.ProposalProcedure.new(1n, CML.RewardAddress.new(1, stakeCredential()), CML.GovAction.new_info_action(), anchor));
  body.set_proposal_procedures(proposals);
};
export const addDonation = (body: CML.TransactionBody): void => body.set_donation(1n);
export const addTreasuryValue = (body: CML.TransactionBody): void => body.set_current_treasury_value(1n);
/** The same parts, present and empty: a withdrawal map without an entry, an empty list, a donation of nothing. The ledger refuses each of them. */
export const addEmptyWithdrawals = (body: CML.TransactionBody): void => body.set_withdrawals(CML.MapRewardAccountToCoin.new());
export const addEmptyCertificates = (body: CML.TransactionBody): void => body.set_certs(CML.CertificateList.new());
export const addEmptyVotes = (body: CML.TransactionBody): void => body.set_voting_procedures(CML.VotingProcedures.new());
export const addEmptyProposals = (body: CML.TransactionBody): void => body.set_proposal_procedures(CML.ProposalProcedureList.new());
export const addZeroDonation = (body: CML.TransactionBody): void => body.set_donation(0n);
export const addZeroTreasuryValue = (body: CML.TransactionBody): void => body.set_current_treasury_value(0n);

// ─── The raw bytes of a transaction ─────────────────────────────────────────────────────────────────────────────────────────────
//
// CML decodes a transaction and writes it again, so a test that compares CML's output with CML's output cannot see a byte that CML
// changed. These functions split the hex of a transaction by its CBOR heads and give the bytes as they stand.

/** The major type, the argument (null for an indefinite length) and the offset after the head of the CBOR item at `at`. */
function headOf(b: Buffer, at: number): { major: number; arg: number | null; next: number } {
  const major = b[at] >> 5;
  const info = b[at] & 31;
  if (info < 24) return { major, arg: info, next: at + 1 };
  if (info === 24) return { major, arg: b[at + 1], next: at + 2 };
  if (info === 25) return { major, arg: b.readUInt16BE(at + 1), next: at + 3 };
  if (info === 26) return { major, arg: b.readUInt32BE(at + 1), next: at + 5 };
  if (info === 27) return { major, arg: Number(b.readBigUInt64BE(at + 1)), next: at + 9 };
  if (info === 31) return { major, arg: null, next: at + 1 };
  throw new Error(`not a CBOR head: ${b[at]} at ${at}`);
}
/** The offset after the CBOR item that starts at `at`. */
function itemEnd(b: Buffer, at: number): number {
  const { major, arg, next } = headOf(b, at);
  if (major === 0 || major === 1 || major === 7) return next;
  if (major === 6) return itemEnd(b, next);
  if ((major === 2 || major === 3) && arg !== null) return next + arg;
  let end = next;
  if (arg === null) { while (b[end] !== 0xff) end = itemEnd(b, end); return end + 1; }
  for (let i = 0; i < (major === 5 ? arg * 2 : arg); i++) end = itemEnd(b, end);
  return end;
}
/** The start and the end of each item of the array or map at `at` (a map gives key, value, key, value). A tag in front is skipped. */
function itemsOf(b: Buffer, at: number): Array<[number, number]> {
  let head = headOf(b, at);
  while (head.major === 6) head = headOf(b, head.next);
  const items: Array<[number, number]> = [];
  for (let p = head.next; b[p] !== 0xff && (head.arg === null || items.length < (head.major === 5 ? head.arg * 2 : head.arg)); ) {
    const end = itemEnd(b, p);
    items.push([p, end]);
    p = end;
  }
  return items;
}

/** The parts of a transaction, each as the hex of its bytes. */
export interface RawParts {
  body: string; witnessSet: string; isValid: string; auxiliary: string;
  /** The keys of the witness set in the order of the bytes, and the bytes of the value of each (the head of a tag included). */
  keys: number[]; entries: Map<number, string>;
  /** The bytes of each vkey witness (the value of key 0), in order. */
  vkeys: string[];
}
export function rawParts(txHex: string): RawParts {
  const bytes = Buffer.from(txHex, 'hex');
  const hex = (b: Buffer, [start, end]: [number, number]) => b.subarray(start, end).toString('hex');
  const [body, witnessSet, isValid, auxiliary] = itemsOf(bytes, 0).map((item) => hex(bytes, item));
  const set = Buffer.from(witnessSet, 'hex');
  const pairs = itemsOf(set, 0);
  const keys: number[] = [];
  const entries = new Map<number, string>();
  for (let i = 0; i < pairs.length; i += 2) {
    const key = headOf(set, pairs[i][0]).arg;
    if (key === null) throw new Error('a key of the witness set has an indefinite length');
    keys.push(key);
    entries.set(key, hex(set, pairs[i + 1]));
  }
  const list = Buffer.from(entries.get(0) ?? '', 'hex');
  return { body, witnessSet, isValid, auxiliary, keys, entries, vkeys: list.length === 0 ? [] : itemsOf(list, 0).map((item) => hex(list, item)) };
}

/** Every output that a transaction spends, uses as collateral or reads, as `<txhash>#<index>`. */
export function refsOfTx(cbor: string): string[] {
  const body = txOf(cbor).body();
  const refs: string[] = [];
  for (const list of [body.inputs(), body.collateral_inputs(), body.reference_inputs()]) {
    for (let i = 0; list && i < list.len(); i++) refs.push(`${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`);
  }
  return [...new Set(refs)];
}

// ─── A fake agent ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentCall { url: string; method: string | undefined; headers: Record<string, string>; body: string; redirect: RequestRedirect | undefined; hasSignal: boolean }
/** A fetch for the agent, and every request that went through it. */
export interface FakeAgent { fetchImpl: typeof fetch; calls: AgentCall[] }

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that records each request and answers it with `answer`. Every request that leaves the tool is in `calls`. */
export function agentFetch(answer: (call: AgentCall) => Response | Promise<Response>): FakeAgent {
  const calls: AgentCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: AgentCall = {
      url: String(input), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? ''),
      redirect: init?.redirect, hasSignal: init?.signal instanceof AbortSignal,
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
/** The transaction that a request carries (its body is `{ "transaction": hex }`). */
export function requestedTx(call: AgentCall): string {
  const body: unknown = JSON.parse(call.body);
  if (typeof body === 'object' && body !== null && 'transaction' in body && typeof body.transaction === 'string') return body.transaction;
  throw new Error('the request carries no transaction');
}
/** An agent that follows the route: it returns the transaction with one more witness of `key`. */
export const faithfulAgent = (key: SigningKey = DELEGATE_KEY): FakeAgent => agentFetch((call) => json(200, { transaction: cosigned(requestedTx(call), key) }));
/** An agent that answers with whatever `change` makes of the transaction that it got (a faithful answer is `cosigned`). */
export const agentThatAnswers = (change: (sent: string) => string): FakeAgent => agentFetch((call) => json(200, { transaction: change(requestedTx(call)) }));
/** A fetch that answers when the request is abandoned and not before, as a connection to a dead agent does. */
export const silentAgent = (async (_input: unknown, init?: RequestInit) => {
  const signal = init?.signal;
  if (!signal) throw new Error('the call has no time budget');
  await once(signal, 'abort');
  throw signal.reason;
}) as typeof fetch;
/** A host lookup that gives a public address, so that no test asks a resolver. */
export const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

export { HIRE_ACTION };
