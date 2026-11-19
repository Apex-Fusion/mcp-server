// packages/builder/src/vector/delegation-cosign.ts
// The co-signature of a Delegate transaction (Part 2 Section 5.2). A Delegate transaction needs the signature of the delegator and the
// signature of the delegate key of the agent that receives the delegation, and only that agent holds the delegate key. This file
// carries the transaction to the agent and takes one witness from its answer. It holds no key and adds no signature of its own.
//
// The route, version 1. An agent serves `POST <origin of its endpoint>/cosign/delegate` with `content-type: application/json` and the
// body `{ "transaction": "<hex CBOR>" }`. It answers `200 { "transaction": "<hex CBOR>" }`: the same transaction body, every witness that
// the request carried, and one more vkey witness, of the delegate key. It refuses with a 4xx and `{ "error": "<code>", "message": "<words>" }`.
// The codes are COSIGN_CODES. The route is public: anybody can call it, not only this tool.
//
// Where a request goes. The tool takes no URL and no agent from the caller. It reads the delegate from the transaction, reads the
// identity record of the delegate from the chain, and sends to the origin of the `endpoint` in that record with the fixed path. The
// endpoint comes from chain data only, and the call goes through safeFetch: https only, no credentials, no private address, no redirect,
// a size limit and a time budget. One request is made and it is not retried. Two limits keep the tool from sending many requests to one
// host: a low one for each caller and origin, so that one caller cannot use up the budget that the other users of an agent need, and a
// higher one for each origin across callers, which bounds what the host gets from this server.
//
// What the result is. The agent has just received the transaction, so nothing of its answer is trusted beyond one witness. The result is
// the transaction that the caller gave with the one vkey witness of the delegate key added. Only the list of vkey witnesses is written
// again. The body, the validity flag, the auxiliary data and each other entry of the witness set keep their bytes. The witness is taken
// from the answer only when the answer is a transaction with the same body hash, holds exactly one witness of the delegate key, and the
// signature verifies over the body hash by the rules of the ledger (signatureVerifies). The agent's own words are never shown.
//
// What is checked before the send. The tool refuses what it can check without running the scripts, and the node checks everything when
// the user submits. Some refusals mirror a rule of the ledger or of the delegation contract: a valid transaction with one delegation
// token minted and one delegation output with a valid datum, the delegate key as a required signer, a validity window that is finite,
// at most one hour long and not over, every input and reference input on the node (and none both spent and read), every witness that
// verifies, a delegate that is Active over the window and lists the delegate key with the delegation purpose, and an https endpoint.
// Other refusals are the scope of this tool and not rules of the ledger: they bound what an agent is asked to sign. A Delegate
// transaction here does nothing else (no second minted policy, no withdrawal, certificate, vote, proposal, donation or stated treasury
// value, and none of them empty or 0), has no witness of the delegate key yet, and has a period of less than 2^53 ms (the codec reads
// whole numbers up to that). Otherwise nothing is sent.
//
// The bytes of a transaction that another party wrote are read before a decoder library sees them. The keys of the body of the transaction
// of the caller are read from the bytes (readBody), and a body that has the key of a part that a delegation does not use is refused. The
// body of the answer of the agent must be, byte for byte, the body that was sent. The only place where this file decodes a transaction with
// a library is parseTransaction, and it gets only a transaction that passed that. The checks after the decode are the second line.
import { CML, slotToUnixTime } from '@lucid-evolution/lucid';
import type { Credential, OutRef, Provider, UTxO } from '@lucid-evolution/lucid';
import { version as SERVER_VERSION } from '../../package.json';
import { decodeDelegationDatum, textOf } from './identity-codec.js';
import type { DelegationDatum, IdentityDatum } from './identity-codec.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { SignerList, WALLET_ROLE, chainClock, didOf, recordWithAncestors, recordsById } from './identity-chain.js';
import type { RequiredSigner } from './identity-chain.js';
import { MAX_RANGE_MS, PURPOSE, activeKey, effectiveStatus, keyHashOf, keyHasPurpose } from './identity-rules.js';
import { delegationProblems } from './delegation-build.js';
import { isoOrRaw } from './marketplace-shared.js';
import { isTimeout, jsonObject } from './marketplace-supplier.js';
import { addressDetails, decodeTransaction } from './guarded-decode.js';
import { safeFetch } from './safe-fetch.js';
import type { SafeFetchOpts } from './safe-fetch.js';
import { readTransactionBody } from './tx-body.js';

/** The version of the route that this file speaks. */
export const COSIGN_ROUTE_VERSION = 1;
/** The path of the route, on the origin of the endpoint in the record of the delegate. */
export const COSIGN_PATH = '/cosign/delegate';
/** The refusal codes of the route (version 1). */
export const COSIGN_CODES = ['not_a_delegation', 'not_for_this_agent', 'key_in_use', 'principal_not_allowed', 'spends_agent_funds', 'expired'] as const;
export type CosignCode = typeof COSIGN_CODES[number];
/** The tool's own words for each code. The words of the agent are never shown. */
export const CODE_TEXT: Readonly<Record<CosignCode, string>> = {
  not_a_delegation: 'the transaction is not a Delegate transaction',
  not_for_this_agent: 'the delegation does not name this agent and one of its own delegation keys',
  key_in_use: 'the delegate key is in use: the agent signed another transaction for it whose window is still open, or a live delegation uses it',
  principal_not_allowed: 'the agent does not accept delegations from this delegator',
  spends_agent_funds: 'the transaction spends funds of the agent',
  expired: 'the validity window of the transaction has ended',
};
/** The shape of a code that the tool takes from an agent at all. */
const CODE_SHAPE = /^[a-z0-9_]{1,64}$/;
const isCosignCode = (code: string | null): code is CosignCode => code !== null && (COSIGN_CODES as readonly string[]).includes(code);

/** The most hex characters of a transaction: the ledger accepts no transaction above 16,384 bytes. */
export const MAX_COSIGN_TX_HEX = 32_768;
/** What the call to the agent may read and wait for: the answer is a transaction and a few words. */
export const COSIGN_CALL = { maxResponseBytes: 65_536, timeoutMs: 30_000 } as const;
/** The user agent of the call: the server and its version, so that an operator can see who calls. */
export const COSIGN_USER_AGENT = `vector-mcp-builder/${SERVER_VERSION}`;

/**
 * The most requests that one caller can send to one origin in a minute. One co-signature is one request, so three a minute lets a user
 * ask again. It is low so that one caller cannot use up the budget of an origin (the limit below) with one transaction that it sends
 * again and again, which would block every other user of that agent.
 */
export const CALLER_ORIGIN_LIMIT_PER_MINUTE = 3;
/**
 * The most requests that this server sends to one origin in a minute, for all callers together. It bounds what an agent host gets
 * from this server. Ten callers at the limit above fill it, and a busy agent with many users stays below it.
 */
export const ORIGIN_LIMIT_PER_MINUTE = 30;
/**
 * The most origins, and the most pairs of a caller and an origin, that the limits remember. Both come from outside (the origins from
 * chain records that anyone can write), so the memory is bounded. A pair or an origin that was used longest ago is forgotten and starts
 * a fresh window.
 */
export const MAX_TRACKED_ORIGINS = 1_000;
export const MAX_TRACKED_CALLER_ORIGINS = 10_000;
const WINDOW_MS = 60_000;

/** The answer of the limits: a request may go, or the milliseconds to wait and which limit says so. */
export type OriginAllowance = { allowed: true } | { allowed: false; scope: 'caller' | 'origin'; retryAfterMs: number };
export interface OriginLimiter { check(origin: string, caller: string): OriginAllowance }
export interface OriginLimiterOptions {
  perCallerAndOrigin?: number; perOrigin?: number; now?: () => number; maxCallerOrigins?: number; maxOrigins?: number;
}

/** A sliding window of one minute for each key, with at most `maxKeys` keys. Asking about a key makes it the most recent. */
function slidingWindows(limit: number, maxKeys: number) {
  const calls = new Map<string, number[]>();
  return {
    /** The milliseconds until `key` may call again, or 0 when it may call now. */
    wait(key: string, at: number): number {
      const recent = (calls.get(key) ?? []).filter((t) => at - t < WINDOW_MS);
      calls.delete(key);
      calls.set(key, recent);
      for (let oldest = calls.keys().next(); calls.size > maxKeys && !oldest.done; oldest = calls.keys().next()) calls.delete(oldest.value);
      return recent.length < limit ? 0 : WINDOW_MS - (at - recent[0]);
    },
    /** Counts a call of `key` that was allowed. */
    count(key: string, at: number): void { calls.get(key)?.push(at); },
  };
}

/**
 * The two limits as one check. A call goes only when both allow it, and only then does it count against both: a refused call counts
 * against neither. When both refuse, the answer is the limit of the caller, because the caller can act on it.
 */
export function newOriginLimiter(options: OriginLimiterOptions = {}): OriginLimiter {
  const { perCallerAndOrigin = CALLER_ORIGIN_LIMIT_PER_MINUTE, perOrigin = ORIGIN_LIMIT_PER_MINUTE, now = Date.now, maxCallerOrigins = MAX_TRACKED_CALLER_ORIGINS, maxOrigins = MAX_TRACKED_ORIGINS } = options;
  const byCaller = slidingWindows(perCallerAndOrigin, maxCallerOrigins);
  const byOrigin = slidingWindows(perOrigin, maxOrigins);
  return {
    check(origin, caller) {
      const at = now();
      const pair = `${origin} ${caller}`;
      const callerWait = byCaller.wait(pair, at);
      const originWait = byOrigin.wait(origin, at);
      if (callerWait > 0) return { allowed: false, scope: 'caller', retryAfterMs: callerWait };
      if (originWait > 0) return { allowed: false, scope: 'origin', retryAfterMs: originWait };
      byCaller.count(pair, at);
      byOrigin.count(origin, at);
      return { allowed: true };
    },
  };
}
/** The limits of this process: one for every caller. */
const sharedOriginLimiter = newOriginLimiter();

/** The origin as the texts and the JSON show it. It is chain text (the record of the delegate), so only a plain host is shown. */
const SHOWN_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/;
const UNUSUAL_HOST = 'a host with unusual characters';

/** What a test hands in. The server uses the defaults. */
export interface CosignAccess {
  /** The fetch of the call to the agent. */
  fetchImpl?: typeof fetch;
  /** The host lookup of safeFetch. */
  lookup?: SafeFetchOpts['lookup'];
  /** The clock, in POSIX milliseconds: the window check reads it. */
  now?: () => number;
  /** The limits for each caller and origin, and for each origin. */
  originLimiter?: OriginLimiter;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sameRef = (a: OutRef, b: OutRef): boolean => a.txHash === b.txHash && a.outputIndex === b.outputIndex;
const uniqueRefs = (refs: OutRef[]): OutRef[] => refs.filter((ref, i) => refs.findIndex((other) => sameRef(other, ref)) === i);

// ─── Signatures, as the ledger takes them ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The encodings of the points of order 1, 2, 4 and 8 (the y of each, as the library of the node lists them), with the two other spellings
 * of 0 and 1 (p and p + 1). The sign bit is not compared. A public key or a signature start that is in this list is refused. Any other
 * non-canonical spelling is of a point that nobody can sign for, so it needs no rule of its own.
 */
export const SMALL_ORDER_ENCODINGS: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];
/** Has the point that `bytes` spells, without its sign bit, a small order? */
export const hasSmallOrder = (bytes: Uint8Array): boolean => {
  const point = Buffer.from(bytes);
  point[31] &= 0x7f;
  return SMALL_ORDER_ENCODINGS.includes(point.toString('hex'));
};

/**
 * Does `signature` verify over `message` for `publicKey`, by the rules of the ledger? The library of the node refuses a public key with a
 * small order, a signature whose R has a small order, and a signature whose S is not below the group order. The check of CML is lax for
 * a small order: for many public keys of small order, a signature of R = the identity point and S = 0 verifies over some messages (over
 * every message when the key is the identity point, with R = the base point and S = 1 as well), and a signature with R = the identity point
 * and a good S verifies for a key that the signer holds. So the first two rules are checked here, and CML checks the encoding of R, S below
 * the group order, and the equation. CML does not throw for a key of 32 bytes or a signature of 64 bytes, so only the lengths are checked.
 */
export function signatureVerifies(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (hasSmallOrder(publicKey) || hasSmallOrder(signature.subarray(0, 32))) return false;
  return CML.PublicKey.from_bytes(publicKey).verify(message, CML.Ed25519Signature.from_raw_bytes(signature));
}

// ─── Reading a transaction ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The transaction that `hex` (lower case) writes, or null. CML reads a prefix of its input, so the transaction must write itself back as the same text. */
function parseTransaction(hex: string): CML.Transaction | null {
  try {
    const tx = decodeTransaction(hex, 'txCbor');
    return tx.to_cbor_hex() === hex ? tx : null;
  } catch { return null; }
}

/** A vkey witness: the public key, the signature, and the hash of the key (the 28 bytes that the datum names). */
export interface Witness { publicKey: string; signature: string; keyHash: string }

function witnessesOf(set: CML.TransactionWitnessSet): Witness[] {
  const witnesses: Witness[] = [];
  const list = set.vkeywitnesses();
  for (let i = 0; list && i < list.len(); i++) {
    const w = list.get(i);
    witnesses.push({ publicKey: Buffer.from(w.vkey().to_raw_bytes()).toString('hex'), signature: w.ed25519_signature().to_hex(), keyHash: w.vkey().hash().to_hex() });
  }
  return witnesses;
}

interface Token { policy: string; name: string; quantity: bigint }
/** The assets of one policy: what both a mint and a value give. */
interface PolicyAssets { keys(): CML.AssetNameList; get(name: CML.AssetName): bigint | undefined }
/** A mint or a value of assets. */
interface Tokens { keys(): CML.PolicyIdList; get_assets(policy: CML.ScriptHash): PolicyAssets | undefined }

function tokensOf(tokens: Tokens | undefined): Token[] {
  const found: Token[] = [];
  const policies = tokens?.keys();
  for (let i = 0; tokens && policies && i < policies.len(); i++) {
    const policy = policies.get(i);
    const assets = tokens.get_assets(policy);
    const names = assets?.keys();
    for (let j = 0; assets && names && j < names.len(); j++) found.push({ policy: policy.to_hex(), name: names.get(j).to_hex(), quantity: assets.get(names.get(j)) ?? 0n });
  }
  return found;
}

/** The outputs that a list of inputs names. */
function refsOf(list: CML.TransactionInputList | undefined): OutRef[] {
  const refs: OutRef[] = [];
  for (let i = 0; list && i < list.len(); i++) refs.push({ txHash: list.get(i).transaction_id().to_hex(), outputIndex: Number(list.get(i).index()) });
  return refs;
}

/** What the tool reads from a Delegate transaction before it sends it. */
export interface DelegateTransaction {
  /** The transaction as lower-case hex: what is sent. */
  txCbor: string;
  /** The bytes of its body, as hex: the body that the answer of the agent must keep. */
  bodyHex: string;
  txHash: string;
  /** The delegation: the name of the minted token. */
  id: string;
  delegation: DelegationDatum;
  /** The vkey witnesses that it has, in order. Each one verifies over the body hash. */
  witnesses: Witness[];
  /** The key hashes of the required signers of its body. */
  requiredSigners: string[];
  /** The spent and the collateral inputs: the wallet that owns them signs. */
  inputs: OutRef[];
  /** The reference inputs. */
  references: OutRef[];
  /** The slot of the lower bound of the validity interval, and the slot of its end (the `ttl`). */
  validityStart: bigint | undefined;
  ttl: bigint | undefined;
  /** The transaction itself, decoded once by parseTransaction. */
  tx: CML.Transaction;
}

/**
 * The keys and the bytes (as hex) of the body of the transaction that `hex` writes, read from the bytes by readTransactionBody before a
 * decoder library sees them. Undefined when `hex` is not the hex of bytes that the reader can read: an odd count of digits, a character
 * that is not a hex digit, or bytes that are not a transaction with a well-formed body.
 */
function readBody(hex: string): { keys: number[]; bodyHex: string } | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return undefined;
  const body = readTransactionBody(Buffer.from(hex, 'hex'));
  return body && { keys: body.keys, bodyHex: hex.slice(body.start * 2, body.end * 2) };
}

/**
 * The optional parts of a body that a delegation does not use. For each: its key in the body map, the words of a refusal, and how the
 * decoded body shows it. The part itself is refused, also when it is empty or 0.
 */
const UNUSED_PARTS: ReadonlyArray<{ key: number; text: string; decoded: (body: CML.TransactionBody) => boolean }> = [
  { key: 5, text: 'it has a withdrawals field', decoded: (body) => body.withdrawals() !== undefined },
  { key: 4, text: 'it has a certificates field', decoded: (body) => body.certs() !== undefined },
  { key: 19, text: 'it has a voting procedures field', decoded: (body) => body.voting_procedures() !== undefined },
  { key: 20, text: 'it has a proposal procedures field', decoded: (body) => body.proposal_procedures() !== undefined },
  { key: 22, text: 'it has a donation field', decoded: (body) => body.donation() !== undefined },
  { key: 21, text: 'it states the treasury value', decoded: (body) => body.current_treasury_value() !== undefined },
];

/**
 * The words of a refusal for a decoded transaction that is marked invalid and for each part of UNUSED_PARTS that it has. This is the second
 * line: readDelegateTransaction has refused the keys of the bytes before the decode, so a transaction gets here without any of the parts.
 */
export function extraPartsOf(tx: CML.Transaction): string[] {
  const body = tx.body();
  const extra: string[] = [];
  if (!tx.is_valid()) extra.push('it is marked invalid (is_valid is false), which the ledger refuses for a transaction whose scripts succeed');
  for (const part of UNUSED_PARTS) if (part.decoded(body)) extra.push(part.text);
  return extra;
}

/**
 * Reads `txCbor` as a Delegate transaction (Part 2 Section 5.2) or refuses, saying why. The keys of the body are read from the bytes first,
 * and the decoder library reads only a transaction that passed that. The transaction is valid (`is_valid`), mints exactly one token of the
 * delegation policy and nothing else, has none of the optional parts that a delegation does not use (withdrawals, certificates, votes,
 * proposals, a donation, a treasury value: the part itself is refused, also when it is empty or 0), has exactly one output at the
 * delegation address that holds that token and AP3X only, with an inline datum that is a valid delegation (delegationProblems), lists the
 * delegate key as a required signer, and does not read an output that it spends. Each vkey witness that it carries verifies over its body
 * hash. The refusals of the optional parts and of a second minted policy are the scope of this tool, not rules of the ledger: they bound
 * what an agent is asked to sign.
 */
export function readDelegateTransaction(txCbor: string, deployment: IdentityDeployment): DelegateTransaction {
  const hex = txCbor.trim().toLowerCase();
  if (hex.length > MAX_COSIGN_TX_HEX) {
    throw new Error(`txCbor is longer than ${MAX_COSIGN_TX_HEX} hex characters (${MAX_COSIGN_TX_HEX / 2} bytes, the most that the ledger accepts in a transaction).`);
  }
  const notDecoded = () => new Error('txCbor does not decode as a transaction (expected the whole hex CBOR that vector_build_delegation_delegate returned).');
  const refuse = (why: string) => new Error(`The transaction is not a Delegate transaction (Part 2 Section 5.2): ${why}.`);
  // The keys of the body come from the bytes. A body that has the key of a part that a delegation does not use is refused before a decoder
  // library reads the transaction, and so is a transaction that the reader cannot read.
  const found = readBody(hex);
  if (!found) throw notDecoded();
  const named = UNUSED_PARTS.filter((part) => found.keys.includes(part.key)).map((part) => part.text);
  if (named.length > 0) throw refuse(`it must do nothing but delegate (${named.join('; ')})`);
  const tx = parseTransaction(hex);
  if (!tx) throw notDecoded();
  const body = tx.body();
  const policy = deployment.delegation.hash;

  const minted = tokensOf(body.mint());
  const [token] = minted;
  if (minted.length !== 1 || token.policy !== policy || token.quantity !== 1n) {
    throw refuse(`it must mint exactly one token of the delegation policy, with quantity 1, and nothing else (found: ${minted.length === 0 ? 'nothing' : minted.map((t) => `${t.quantity} of ${t.policy.slice(0, 8)}…${t.name.slice(0, 8)}`).join(', ')})`);
  }
  const extra = extraPartsOf(tx);
  if (extra.length > 0) throw refuse(`it must do nothing but delegate (${extra.join('; ')})`);
  const spent = refsOf(body.inputs());
  const references = refsOf(body.reference_inputs());
  const spentAndRead = spent.find((ref) => references.some((other) => sameRef(other, ref)));
  if (spentAndRead) throw new Error(`The transaction spends the output ${spentAndRead.txHash}#${spentAndRead.outputIndex} and also reads it as a reference input, which the ledger refuses (protocol version 10).`);

  const outputs = body.outputs();
  const atDelegation: CML.TransactionOutput[] = [];
  for (let i = 0; i < outputs.len(); i++) {
    if (outputs.get(i).address().to_bech32() === deployment.delegation.address) atDelegation.push(outputs.get(i));
  }
  if (atDelegation.length !== 1) throw refuse(`it must have exactly one output at the delegation address ${deployment.delegation.address} (found ${atDelegation.length})`);
  const [output] = atDelegation;
  const held = tokensOf(output.amount().multi_asset());
  if (held.length !== 1 || held[0].policy !== policy || held[0].name !== token.name || held[0].quantity !== 1n) {
    throw refuse(`the delegation output must hold the minted token ${token.name} (quantity 1) and AP3X only`);
  }
  const datum = output.datum()?.as_datum();
  if (!datum) throw refuse('the delegation output has no inline datum');
  let delegation: DelegationDatum;
  try { delegation = decodeDelegationDatum(datum.to_cbor_hex()); } catch (err) { throw refuse(`the datum of the delegation output does not decode as a delegation: ${errorText(err)}`); }
  const problems = delegationProblems(delegation);
  if (problems.length > 0) throw new Error(`The delegation in the transaction breaks the rules of Part 2 Sections 5.1 and 5.2: ${problems.join('; ')}.`);

  const requiredSigners: string[] = [];
  const signers = body.required_signers();
  for (let i = 0; signers && i < signers.len(); i++) requiredSigners.push(signers.get(i).to_hex());
  if (!requiredSigners.includes(delegation.delegateKey)) {
    throw refuse(`the delegate key ${delegation.delegateKey} is not a required signer of the transaction, and the delegation contract needs it there`);
  }

  const txHash = CML.hash_transaction(body).to_hex();
  const witnesses = witnessesOf(tx.witness_set());
  for (const w of witnesses) {
    if (!signatureVerifies(Buffer.from(w.publicKey, 'hex'), Buffer.from(w.signature, 'hex'), Buffer.from(txHash, 'hex'))) {
      throw new Error(`The transaction carries a vkey witness of key ${w.keyHash} whose signature does not verify over the body hash ${txHash}, so the ledger refuses it.`);
    }
  }
  return {
    txCbor: hex, bodyHex: found.bodyHex, txHash, id: token.name, delegation, witnesses, requiredSigners, inputs: uniqueRefs([...spent, ...refsOf(body.collateral_inputs())]),
    references, validityStart: body.validity_interval_start(), ttl: body.ttl(), tx,
  };
}

// ─── The window, the delegate and the inputs: rules of the ledger that the tool mirrors without running the scripts ──────────────

/** The validity window of a transaction, in POSIX ms. */
export interface ValidityWindow { lo: number; hi: number }

/** The window of `sent`: finite, not empty, at most one hour long (Part 2 Section 3.2), and not over at `now`. */
async function windowOf(provider: Provider, sent: DelegateTransaction, now: number): Promise<ValidityWindow> {
  if (sent.validityStart === undefined || sent.ttl === undefined) {
    throw new Error('The transaction has no finite validity window: it needs a start and an end (Part 2 Section 3.2), so the ledger refuses it.');
  }
  await chainClock(provider);
  const lo = slotToUnixTime('Mainnet', Number(sent.validityStart));
  const hi = slotToUnixTime('Mainnet', Number(sent.ttl));
  if (hi <= lo) throw new Error(`The validity window of the transaction is empty: it starts at ${isoOrRaw(lo)} and ends at ${isoOrRaw(hi)}.`);
  if (hi - lo > MAX_RANGE_MS) throw new Error(`The validity window of the transaction is ${Math.round((hi - lo) / 60_000)} minutes long, and the delegation contract accepts at most ${MAX_RANGE_MS / 60_000} (Part 2 Section 3.2).`);
  if (now >= hi) throw new Error(`The validity window of the transaction ended at ${isoOrRaw(hi)}. Build the transaction again.`);
  return { lo, hi };
}

/**
 * The https URL in the `endpoint` of the identity record of the delegate, or a refusal that says what the record holds. Only its origin
 * is used. The refusals never repeat the text of the endpoint: the delegate writes its own record, and the tool is about to ask it.
 * A subagent has no endpoint by rule (Part 2 Section 3.3).
 */
export function agentEndpoint(record: IdentityDatum, delegate: string): URL {
  const whose = `record of the delegate ${didOf(delegate)}`;
  const text = textOf(record.endpoint);
  if (text === null) throw new Error(`The ${whose} has an endpoint that is not text (its bytes are not UTF-8).`);
  if (text.trim() === '') {
    throw new Error(record.lineage.type === 'Subagent'
      ? `The delegate ${didOf(delegate)} is a subagent, and a subagent record has no endpoint by rule (Part 2 Section 3.3), so there is no agent to ask. The holder of the delegate key of the subagent can sign the delegation, or the delegation can name an agent that has an endpoint.`
      : `The ${whose} has no endpoint, so there is no agent to ask.`);
  }
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`The ${whose} has an endpoint that is not a URL.`); }
  if (url.protocol !== 'https:') throw new Error(`The ${whose} has an endpoint that is not an https URL: the tool sends only to https endpoints.`);
  if (url.username !== '' || url.password !== '') throw new Error(`The endpoint in the ${whose} carries a user name or password, so the tool sends nothing to it.`);
  return url;
}

/**
 * The payment key hashes of the wallet outputs that the transaction spends. Every input, collateral input and reference input must be on
 * the node: the ledger refuses a transaction that names an output that is spent or unknown.
 */
async function walletKeys(provider: Provider, sent: DelegateTransaction): Promise<string[]> {
  const refs = uniqueRefs([...sent.inputs, ...sent.references]);
  let utxos: UTxO[];
  try { utxos = await provider.getUtxosByOutRef(refs); } catch (err) { throw new Error(`Could not read the inputs of the transaction from the node: ${errorText(err)}`); }
  const absent = refs.filter((ref) => !utxos.some((u) => sameRef(u, ref)));
  if (absent.length > 0) {
    throw new Error(`The node does not have ${absent.length} of the ${refs.length} outputs that the transaction spends or reads (${absent.slice(0, 3).map((ref) => `${ref.txHash}#${ref.outputIndex}`).join(', ')}${absent.length > 3 ? ', …' : ''}). They are spent or not confirmed yet, so the ledger refuses the transaction.`);
  }
  const keyHashes = new Set<string>();
  for (const utxo of utxos.filter((u) => sent.inputs.some((ref) => sameRef(u, ref)))) {
    let credential: Credential | undefined;
    try { credential = addressDetails(utxo.address).paymentCredential; } catch (err) {
      throw new Error(`Could not read the address of the input ${utxo.txHash}#${utxo.outputIndex}, so the tool cannot tell which key signs for it: ${errorText(err)}`);
    }
    if (credential?.type === 'Key') keyHashes.add(credential.hash);
  }
  return [...keyHashes];
}

/** The role of a required signer of the body, from what the datum says. */
function roleOf(keyHash: string, delegation: DelegationDatum): string {
  if (keyHash === delegation.delegateKey) return `delegate key (${didOf(delegation.delegate)})`;
  if (delegation.delegator.type === 'PrincipalKey') return delegation.delegator.hash === keyHash ? 'principal key (delegator)' : 'required signer of the transaction';
  if (delegation.parent !== null) return `delegate key of the parent delegation ${delegation.parent} (${didOf(delegation.delegator.id)})`;
  return `signs for the delegator ${didOf(delegation.delegator.id)}`;
}

// ─── The answer of the agent ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one witness that the answer `answerCbor` adds for `sent`, or a refusal (the message completes "the answer is refused:"). The bytes
 * of the body of the answer must be the bytes of the body that was sent: they are compared before a decoder library reads the answer, so
 * the library reads only an answer whose body is, byte for byte, the body of the caller. The answer must hold exactly one vkey witness of
 * the delegate key in the datum, whose signature verifies over the body hash by the rules of the ledger (signatureVerifies). Nothing else
 * in the answer is used.
 */
export function cosignWitnessOf(sent: DelegateTransaction, answerCbor: string): Witness {
  const hex = answerCbor.trim().toLowerCase();
  const notWhole = () => new Error('it is not the hex CBOR of a whole transaction');
  const notSent = () => new Error('its body is not the body that was sent');
  const found = readBody(hex);
  if (!found) throw notWhole();
  if (found.bodyHex !== sent.bodyHex) throw notSent();
  const tx = parseTransaction(hex);
  if (!tx) throw notWhole();
  // The second line: the hash of the decoded body.
  if (CML.hash_transaction(tx.body()).to_hex() !== sent.txHash) throw notSent();
  const all = witnessesOf(tx.witness_set());
  const own = all.filter((w) => w.keyHash === sent.delegation.delegateKey);
  if (own.length === 0) throw new Error(`it has no vkey witness of the delegate key ${sent.delegation.delegateKey} (its vkey witnesses of other keys: ${all.length})`);
  if (own.length > 1) throw new Error(`it has ${own.length} vkey witnesses of the delegate key; the route adds exactly one`);
  const [witness] = own;
  if (!signatureVerifies(Buffer.from(witness.publicKey, 'hex'), Buffer.from(witness.signature, 'hex'), Buffer.from(sent.txHash, 'hex'))) {
    throw new Error(`the signature of the delegate key does not verify over the body hash ${sent.txHash}`);
  }
  return witness;
}

/**
 * The transaction that the caller gave with `witness` added. Only the list of vkey witnesses is written again, as a set (tag 258) with
 * the new witness last. The body, the validity flag, the auxiliary data, each other entry of the witness set and each witness that the
 * caller sent keep the bytes that they had. The new witness is written from its key and its signature, so nothing of the agent's
 * encoding is kept.
 */
export function withWitness(sent: DelegateTransaction, witness: Witness): string {
  const witnessSet = sent.tx.witness_set();
  const list = CML.VkeywitnessList.new();
  const existing = witnessSet.vkeywitnesses();
  for (let i = 0; existing && i < existing.len(); i++) list.add(existing.get(i));
  list.add(CML.Vkeywitness.new(CML.PublicKey.from_bytes(Buffer.from(witness.publicKey, 'hex')), CML.Ed25519Signature.from_hex(witness.signature)));
  witnessSet.set_vkeywitnesses(list);
  return CML.Transaction.new(sent.tx.body(), witnessSet, sent.tx.is_valid(), sent.tx.auxiliary_data()).to_cbor_hex();
}

/** A refusal of the agent: a 4xx with an error code. Nothing the agent wrote is kept but a code of the shape of CODE_SHAPE. */
export class AgentRefusal extends Error {
  readonly status: number;
  /** The code, when it has the shape `^[a-z0-9_]{1,64}$`; else null. */
  readonly code: string | null;
  /** Is the code one of COSIGN_CODES? Only such a code is shown, with the tool's own words. */
  readonly known: boolean;
  constructor(agent: string, status: number, code: string | null) {
    super(`The agent of ${agent} refused the transaction${isCosignCode(code) ? ` with ${code} (HTTP ${status}): ${CODE_TEXT[code]}` : ` (HTTP ${status})`}. Nothing was signed.`);
    this.name = 'AgentRefusal';
    this.status = status;
    this.code = code;
    this.known = isCosignCode(code);
  }
}

const codeOf = (err: unknown): unknown => (typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined);
/** Did a host name not resolve? The error of a lookup has the code, and the error of a fetch has it in its cause. */
function nameNotResolved(err: unknown): boolean {
  const cause = typeof err === 'object' && err !== null && 'cause' in err ? err.cause : undefined;
  return [codeOf(err), codeOf(cause)].some((code) => code === 'ENOTFOUND' || code === 'EAI_AGAIN');
}

/**
 * The exact messages of safeFetch (safe-fetch.ts), each matched whole. The message of a redirect holds the Location header of the
 * agent, so it is matched first and whole: words in that header must never make a redirect read as a failure before the send.
 */
const SAFE_FETCH_MESSAGE = {
  redirect: /^safeFetch: redirect to [\s\S]* refused \(redirects are not followed\)$/,
  tooLarge: /^safeFetch: response of (?:at least )?\S+ bytes exceeds the \d+ byte cap$/,
  privateAddress: /^safeFetch: \S+ resolves to a private or reserved address; refused$/,
  notResolved: /^safeFetch: \S+ does not resolve$/,
};

/** Why a call to the agent failed, in words that carry neither its URL nor anything that the network or the agent said, and whether the request could have reached it. */
function callFailure(err: unknown): { text: string; reached: 'no' | 'yes' | 'maybe' } {
  if (isTimeout(err)) return { text: `the agent did not answer within ${COSIGN_CALL.timeoutMs / 1000} s`, reached: 'maybe' };
  const message = err instanceof Error ? err.message : '';
  if (SAFE_FETCH_MESSAGE.redirect.test(message)) return { text: 'the agent answered with a redirect, which is not followed', reached: 'yes' };
  if (SAFE_FETCH_MESSAGE.tooLarge.test(message)) return { text: `the agent's answer is over the ${COSIGN_CALL.maxResponseBytes} byte limit`, reached: 'maybe' };
  if (SAFE_FETCH_MESSAGE.privateAddress.test(message)) return { text: 'the agent host resolves to a private or reserved address, which is refused', reached: 'no' };
  if (SAFE_FETCH_MESSAGE.notResolved.test(message) || nameNotResolved(err)) return { text: 'the host does not resolve', reached: 'no' };
  return { text: 'the request to the agent failed (network error)', reached: 'maybe' };
}

/** The transaction in the answer of the agent, or the refusal or the failure that the answer is. `at` names the agent and its origin. */
function transactionIn(at: string, status: number, text: string): string {
  const body = jsonObject(text);
  const error = body === null ? undefined : body.error;
  const code = typeof error === 'string' && CODE_SHAPE.test(error) ? error : null;
  const route = (why: string) => new Error(`The answer of the agent of ${at} is not what the route contract says: ${why}. Nothing from the agent is used.`);
  if (status === 200) {
    if (body === null) throw route('its answer is not a JSON object');
    if (typeof body.transaction !== 'string') throw route('its answer has no "transaction" text');
    return body.transaction;
  }
  const noRoute = status === 404 || status === 405;
  const refusal = status >= 400 && status < 500;
  if (refusal && typeof error === 'string' && (!noRoute || isCosignCode(code))) throw new AgentRefusal(at, status, code);
  if (noRoute) throw new Error(`The agent of ${at} does not serve ${COSIGN_PATH} (HTTP ${status}). An agent must serve this route for the tool to work; ask its operator.`);
  if (refusal) throw new Error(`The agent of ${at} answered HTTP ${status}, which is not a refusal of the route (it has no error code).`);
  throw new Error(`The agent of ${at} answered HTTP ${status}; the route answers 200 with the signed transaction, or a 4xx refusal with a code.`);
}

// ─── The call ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CosignResult {
  /** The transaction that the caller gave, with the witness of the delegate key added (withWitness). */
  txCbor: string;
  txHash: string;
  /** The delegation: the token name. */
  id: string;
  delegation: DelegationDatum;
  /** The agent that signed: its DID and the origin that was called. */
  agent: { did: string; origin: string };
  coSigner: { keyHash: string; publicKey: string };
  /** The key hashes with a vkey witness in `txCbor`. Each witness verifies. */
  signed: string[];
  /** Every key that must sign: the required signers of the body and the wallet keys of the inputs. */
  required: RequiredSigner[];
  /** The required keys that have no witness yet. */
  missing: RequiredSigner[];
  /** The validity window of the transaction, in POSIX ms: every signature and the submit must come before the end. */
  validFrom: number;
  validTo: number;
}

/** Everything that is checked before a request: a refusal here sends nothing. */
async function prepare(ctx: { provider: Provider; deployment: IdentityDeployment }, txCbor: string, now: number): Promise<{ sent: DelegateTransaction; endpoint: URL; window: ValidityWindow; wallet: string[] }> {
  const { provider, deployment } = ctx;
  const sent = readDelegateTransaction(txCbor, deployment);
  const key = sent.delegation.delegateKey;
  if (sent.witnesses.some((w) => w.keyHash === key)) {
    throw new Error(`The transaction already carries a signature of the delegate key ${key}: there is nothing to request. Sign it with the other required keys and submit it.`);
  }
  const window = await windowOf(provider, sent, now);
  const records = await recordWithAncestors(provider, deployment, sent.delegation.delegate, 'record of the delegate');
  const delegate = records[0].record;
  const status = effectiveStatus(delegate, recordsById(records), window.lo, window.hi);
  if (status !== 'Active') {
    throw new Error(`The delegate ${didOf(sent.delegation.delegate)} is ${status} over the validity window of the transaction; it must be Active (Part 2 Section 5.2), so the ledger refuses the transaction.`);
  }
  if (!activeKey(delegate, key, PURPOSE.delegation)) {
    throw new Error(`The record of the delegate ${didOf(sent.delegation.delegate)} does not list the delegate key ${key} with the delegation purpose (active_key, Part 2 Section 5.2), so the ledger refuses the transaction. Its delegation keys: ${delegate.keys.filter((k) => keyHasPurpose(k, PURPOSE.delegation)).map((k) => keyHashOf(k.key)).join(', ') || 'none'}.`);
  }
  const endpoint = agentEndpoint(delegate, sent.delegation.delegate);
  return { sent, endpoint, window, wallet: await walletKeys(provider, sent) };
}

/**
 * Asks the delegate of the Delegate transaction `txCbor` to co-sign it (the route above) and returns the transaction that the caller
 * gave with the witness of the delegate key added, the keys that have signed and the keys that are still missing. `ctx.caller` is the
 * identity of the caller, for the limit for each caller and origin. Refuses before the send what the tool can check without running
 * the scripts, and when the record of the delegate has no https endpoint; refuses after the answer when it breaks the route contract.
 * A refusal of the agent is an AgentRefusal.
 */
export async function requestDelegationCosign(ctx: { provider: Provider; deployment: IdentityDeployment; caller: string }, txCbor: string, access: CosignAccess = {}): Promise<CosignResult> {
  const { sent, endpoint, window, wallet } = await prepare(ctx, txCbor, (access.now ?? Date.now)()).catch((err: unknown) => { throw new Error(`${errorText(err)} Nothing was sent.`); });
  const agent = didOf(sent.delegation.delegate);
  const origin = SHOWN_ORIGIN.test(endpoint.origin) ? endpoint.origin : UNUSUAL_HOST;
  const at = `${agent} at ${origin}`;
  const allowance = (access.originLimiter ?? sharedOriginLimiter).check(endpoint.origin, ctx.caller);
  if (!allowance.allowed) {
    const wait = `Nothing was sent. Try again in ${Math.ceil(allowance.retryAfterMs / 1000)} s.`;
    throw new Error(allowance.scope === 'caller'
      ? `Too many requests from this caller went to ${origin} in the last minute: this server allows ${CALLER_ORIGIN_LIMIT_PER_MINUTE} a minute from one caller to one host. ${wait}`
      : `Too many requests went to ${origin} in the last minute: this server sends at most ${ORIGIN_LIMIT_PER_MINUTE} a minute to one host, for all callers together. ${wait}`);
  }

  let res: { status: number; text: string };
  try {
    res = await safeFetch(
      `${endpoint.origin}${COSIGN_PATH}`,
      { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': COSIGN_USER_AGENT }, body: JSON.stringify({ transaction: sent.txCbor }) },
      { ...COSIGN_CALL, fetchImpl: access.fetchImpl, lookup: access.lookup },
    );
  } catch (err) {
    const failure = callFailure(err);
    throw new Error(failure.reached === 'no'
      ? `Could not ask the agent of ${agent}: ${failure.text}. Nothing was sent.`
      : failure.reached === 'yes'
        ? `The agent of ${at} could not be used: ${failure.text}. The host received the transaction.`
        : `Could not ask the agent of ${at}: ${failure.text}. It may have received the transaction; you can ask again.`);
  }
  const answer = transactionIn(at, res.status, res.text);
  let witness: Witness;
  try { witness = cosignWitnessOf(sent, answer); } catch (err) {
    throw new Error(`The answer of the agent of ${at} is refused: ${errorText(err)}. Nothing from the agent is used.`);
  }

  const list = new SignerList();
  for (const keyHash of sent.requiredSigners) list.add(keyHash, roleOf(keyHash, sent.delegation));
  for (const keyHash of wallet) list.add(keyHash, WALLET_ROLE);
  const required = list.list();
  const signed = [...sent.witnesses.map((w) => w.keyHash), witness.keyHash];
  return {
    txCbor: withWitness(sent, witness), txHash: sent.txHash, id: sent.id, delegation: sent.delegation, agent: { did: agent, origin },
    coSigner: { keyHash: witness.keyHash, publicKey: witness.publicKey }, signed, required, missing: required.filter((s) => !signed.includes(s.keyHash)),
    validFrom: window.lo, validTo: window.hi,
  };
}
