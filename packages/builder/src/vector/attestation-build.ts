// packages/builder/src/vector/attestation-build.ts
// Keyless builders of the attestation contract (Part 2 Section 4): Attest, RevokeAtt, Contest, and Withdraw with Burn. Each builder
// checks the rules of Section 4.1 that it can check before it builds, so that a refusal names the rule. Then it assembles the
// transaction, lets Lucid run the applied attestation script on it (local evaluation through the reference script), and returns the
// unsigned CBOR with every key hash that must sign. Attest also returns the COSE Sig_structure of Section 4.2: the issuer signs it to
// add an envelope signature. Nothing is signed or submitted.
import { CML, calculateMinLovelaceFromUTxO } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import {
  MAX_TIME_MS, decodeAttestationDatum, encodeAttestationDatum, encodeAttestationMint, encodeAttestationSpend,
} from './identity-codec.js';
import type { Anchor, AttestationDatum, AttestationSpend, Link } from './identity-codec.js';
import { readRefScript } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import {
  chainClock, didOf, findTokenOutput, identifierFromSeed, recordWithAncestors, recordsById, requireRecord, seedFrom, signedByResult,
  uniqueUtxos, walletOf, windowAt, SignerList,
} from './identity-chain.js';
import type { SignedByBuild, Window } from './identity-chain.js';
import {
  DAYS_366_MS, DAYS_90_MS, MAX_RANGE_MS, MIN_ATTESTATION_LOVELACE, PURPOSE, activeKey, effectiveStatus, keyHashOf,
} from './identity-rules.js';
import { outputIndexOf } from './identity-build.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';
import { isoOrRaw } from './marketplace-shared.js';

const byteLength = (hex: string): number => hex.length / 2;
const validTime = (t: number): boolean => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME_MS;

/**
 * The ledger minimum AP3X (min-UTxO) of an output at `address` that holds one token `unit` and the inline datum `datum` (CBOR hex),
 * from the node's protocol parameters (through Lucid). An attestation or delegation output holds at least this much.
 */
export function ledgerMinLovelace(lucid: LucidEvolution, address: string, unit: string, datum: string): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of the output is unknown.');
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address, assets: { lovelace: 0n, [unit]: 1n }, datum });
}

// ─── Constants (Part 2 Section 4, attestation/handlers.ak) ─────────────────────────────────────────────────────────────────────

/** The attestation types by name. Every other value is reserved, and the contract refuses it. */
export const ATT_TYPES = { identity: 0, provenance: 1, software: 2, environment: 3, principal_binding: 4, approval: 5, other: 15 } as const;
export type AttTypeName = keyof typeof ATT_TYPES;
export const ATT_TYPE_NAMES = Object.keys(ATT_TYPES) as AttTypeName[];
/** The link relations by name (decision 6 of tests/attestation.md: only these four). */
export const LINK_RELS = { supersedes: 0, depends_on: 1, corroborates: 2, disputes: 3 } as const;
export type LinkRelName = keyof typeof LINK_RELS;
export const LINK_REL_NAMES = Object.keys(LINK_RELS) as LinkRelName[];
/** The most links of an attestation. */
export const MAX_LINKS = 4;
/** The longest locator and the longest contest uri, in bytes. */
export const MAX_URI_BYTES = 256;
/** The greatest CoAP Content-Format number (RFC 7252 Section 12.3; decision 5). */
export const MAX_FORMAT = 65_535;
/** Types 4 (principal binding) and 5 (approval): the digest must be a salted commitment (Part 2 Section 4.1). */
export const SALTED_TYPES: readonly number[] = [ATT_TYPES.principal_binding, ATT_TYPES.approval];
/** What the issuer of a type 4 or 5 attestation must know about the digest. */
export const SALTED_DIGEST_RULE =
  'Types principal_binding (4) and approval (5) need a salted digest: SHA-256(salt ++ document). The salt stays off-chain with the document, so the owner can delete both.';

export const attTypeName = (code: number): string => ATT_TYPE_NAMES.find((name) => ATT_TYPES[name] === code) ?? `reserved type ${code}`;
export const linkRelName = (rel: number): string => LINK_REL_NAMES.find((name) => LINK_RELS[name] === rel) ?? `unknown relation ${rel}`;

// ─── Lookup ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An attestation: its token name, its UTxO at the attestation address, and its decoded datum. */
export interface AttestationUtxo { id: string; utxo: UTxO; attestation: AttestationDatum }

/** The authentic attestation `id` (one token of the attestation policy at exactly the attestation address), or null. Its datum must decode. */
export async function findAttestation(provider: Provider, deployment: IdentityDeployment, id: string): Promise<AttestationUtxo | null> {
  const utxo = await findTokenOutput(provider, deployment.attestation.address, deployment.attestation.hash, id);
  if (!utxo) return null;
  const ref = `${utxo.txHash}#${utxo.outputIndex}`;
  if (!utxo.datum) throw new Error(`The attestation ${id} (${ref}) has no inline datum.`);
  try { return { id, utxo, attestation: decodeAttestationDatum(utxo.datum) }; } catch (err) {
    throw new Error(`The attestation ${id} (${ref}) does not decode: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The attestation `id`, or an error that says it is gone. */
export async function requireAttestation(provider: Provider, deployment: IdentityDeployment, id: string): Promise<AttestationUtxo> {
  const found = await findAttestation(provider, deployment, id);
  if (!found) throw new Error(`No attestation ${id} at ${deployment.attestation.address}: it does not exist, has been withdrawn, or is not confirmed yet.`);
  return found;
}

// ─── Rules (port of attestation/handlers.ak) ───────────────────────────────────────────────────────────────────────────────────

/**
 * The problems that make `d` an invalid new attestation datum (`valid_content` of the contract), in words; empty when it is valid:
 * lengths (subject, issuer and digest 32 bytes; issuer_id and profile 32 bytes; envelope_sig 64 bytes; locator at most 256 bytes), a
 * known type, a CoAP format, valid times, `valid_until` from `issued_at` to 366 days after it (required for types 2 and 3),
 * `valid_from` at or before `valid_until`, and at most 4 links with a relation 0 to 3 and a 32-byte target.
 */
export function attestationProblems(d: AttestationDatum): string[] {
  const problems: string[] = [];
  const say = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  say(byteLength(d.subject) === 32, 'the subject must be a 32-byte identifier');
  say(byteLength(d.issuer) === 32, 'the issuer must be a 32-byte Ed25519 public key');
  say(d.issuerId === null || byteLength(d.issuerId) === 32, 'issuer_id must be a 32-byte identifier');
  say((Number.isInteger(d.attType) && d.attType >= 0 && d.attType <= 5) || d.attType === 15, `att_type ${d.attType} is reserved: use 0 identity, 1 provenance, 2 software, 3 environment, 4 principal binding, 5 approval or 15 other`);
  say(d.format === null || (Number.isInteger(d.format) && d.format >= 0 && d.format <= MAX_FORMAT), `format must be a CoAP Content-Format number from 0 to ${MAX_FORMAT}`);
  say(d.profile === null || byteLength(d.profile) === 32, 'profile must be 32 bytes (the hash of the profile or type URI)');
  say(byteLength(d.digest) === 32, 'digest must be 32 bytes (the SHA-256 of the document)');
  say(d.locator === null || byteLength(d.locator) <= MAX_URI_BYTES, `the locator must be at most ${MAX_URI_BYTES} bytes`);
  say(d.envelopeSig === null || byteLength(d.envelopeSig) === 64, 'envelope_sig must be 64 bytes');
  say(validTime(d.issuedAt), 'issued_at is not a valid time');
  if (d.validUntil === null) {
    say(d.attType !== ATT_TYPES.software && d.attType !== ATT_TYPES.environment, `type ${attTypeName(d.attType)} needs valid_until (at most 366 days after issued_at)`);
    say(d.validFrom === null || validTime(d.validFrom), 'valid_from is not a valid time');
  } else {
    const until = d.validUntil;
    say(d.issuedAt <= until, `valid_until (${isoOrRaw(until)}) must be at or after issued_at (${isoOrRaw(d.issuedAt)}, the end of the validity window)`);
    say(until <= d.issuedAt + DAYS_366_MS, `valid_until (${isoOrRaw(until)}) must be at most 366 days after issued_at (${isoOrRaw(d.issuedAt)}): at most ${isoOrRaw(d.issuedAt + DAYS_366_MS)}`);
    say(validTime(until), 'valid_until is not a valid time');
    say(d.validFrom === null || (validTime(d.validFrom) && d.validFrom <= until), `valid_from must be a valid time at or before valid_until (${isoOrRaw(until)})`);
  }
  say(d.links.length <= MAX_LINKS, `at most ${MAX_LINKS} links`);
  d.links.forEach((l, i) => {
    say(Number.isInteger(l.rel) && l.rel >= 0 && l.rel <= 3, `link ${i + 1}: the relation must be 0 supersedes, 1 depends_on, 2 corroborates or 3 disputes`);
    say(byteLength(l.target) === 32, `link ${i + 1}: the target must be the 32-byte identifier of another attestation`);
  });
  return problems;
}

/** `uri` is 1 to 256 bytes and `sha256` is 32 bytes (`valid_anchor`). */
export function anchorProblems(a: Anchor): string[] {
  const problems: string[] = [];
  if (byteLength(a.uri) < 1 || byteLength(a.uri) > MAX_URI_BYTES) problems.push(`the contest uri must be 1 to ${MAX_URI_BYTES} bytes, got ${byteLength(a.uri)}`);
  if (byteLength(a.sha256) !== 32) problems.push('the contest sha256 must be 32 bytes (64 hex characters)');
  return problems;
}

/**
 * The earliest `lo` at which Withdraw passes (`withdrawable`, Part 2 Section 4.1): 90 days after the revocation or 90 days after
 * `valid_until`, whichever comes first. Null for an active attestation without `valid_until`: it must be revoked first.
 */
export function withdrawableFrom(d: AttestationDatum): number | null {
  const times: number[] = [];
  if (d.status.type === 'AttRevoked') times.push(d.status.at + DAYS_90_MS);
  if (d.validUntil !== null) times.push(d.validUntil + DAYS_90_MS);
  return times.length === 0 ? null : Math.min(...times);
}

function refuse(problems: string[], what: string): void {
  if (problems.length > 0) throw new Error(`The ${what} breaks the rules of Part 2 Section 4.1: ${problems.join('; ')}.`);
}

// ─── Envelope (Part 2 Section 4.2) ─────────────────────────────────────────────────────────────────────────────────────────────
// The envelope is a COSE_Sign1 (RFC 9052 Section 4.2) whose payload is the digest: a COSE Hash Envelope (RFC 9995), where header 258
// names the hash algorithm of the payload and 259 the content format of the preimage. The issuer signs, with Ed25519, the bytes of
// Sig_structure = ["Signature1", protected, h'', digest] (RFC 9052 Section 4.4: context, body_protected, external_aad, payload).
// `protected` is the CBOR map below, wrapped in a byte string, in the core deterministic encoding of RFC 8949 Section 4.2.1: the
// shortest heads, definite lengths, and map keys sorted by the bytes of their encodings. Header 1 is the algorithm, -19 = Ed25519
// (RFC 9864); 4 is the kid; 15 is the CWT Claims header (RFC 9597) with the claims iss (1), sub (2) and iat (6) of RFC 8392;
// -16 is SHA-256 (RFC 9054).

function cborHead(major: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`CBOR argument ${value} is not a non-negative safe integer`);
  const top = major << 5;
  if (value < 24) return Buffer.from([top | value]);
  if (value < 0x100) return Buffer.from([top | 24, value]);
  if (value < 0x10000) { const b = Buffer.alloc(3); b[0] = top | 25; b.writeUInt16BE(value, 1); return b; }
  if (value < 0x1_0000_0000) { const b = Buffer.alloc(5); b[0] = top | 26; b.writeUInt32BE(value, 1); return b; }
  const b = Buffer.alloc(9); b[0] = top | 27; b.writeBigUInt64BE(BigInt(value), 1); return b;
}
const cborInt = (n: number): Buffer => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n));
const cborBytes = (bytes: Buffer): Buffer => Buffer.concat([cborHead(2, bytes.length), bytes]);
function cborText(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([cborHead(3, bytes.length), bytes]);
}
const cborArray = (items: Buffer[]): Buffer => Buffer.concat([cborHead(4, items.length), ...items]);
/** A map with its keys sorted by the bytes of their encodings (RFC 8949 Section 4.2.1). */
function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  const sorted = [...entries].sort(([a], [b]) => Buffer.compare(a, b));
  return Buffer.concat([cborHead(5, sorted.length), ...sorted.flatMap(([key, value]) => [key, value])]);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(bytes: Buffer): string {
  let n = bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out;
}

/** The `did:key` of an Ed25519 public key: multibase base58btc ('z') of the multicodec ed25519-pub (0xed 0x01) and the key. */
export function didKeyOf(publicKeyHex: string): string {
  return `did:key:z${base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.from(publicKeyHex, 'hex')]))}`;
}

/** What the envelope of an attestation covers. */
export interface EnvelopeFields { issuer: string; issuerId: string | null; subject: string; issuedAt: number; format: number | null; digest: string }

/** The issuer DID and the kid of an envelope: `did:vector:<issuer_id>` with `#<key hash>`, or the `did:key` of the issuer and its key URL. */
export function envelopeIssuer(e: Pick<EnvelopeFields, 'issuer' | 'issuerId'>): { did: string; kid: string } {
  if (e.issuerId !== null) return { did: didOf(e.issuerId), kid: `${didOf(e.issuerId)}#${keyHashOf(e.issuer)}` };
  const did = didKeyOf(e.issuer);
  return { did, kid: `${did}#${did.slice('did:key:'.length)}` };
}

/** The protected header of the envelope (Part 2 Section 4.2), CBOR in the core deterministic encoding, as hex. */
export function envelopeProtectedHeader(e: EnvelopeFields): string {
  const issuer = envelopeIssuer(e);
  const claims = cborMap([
    [cborInt(1), cborText(issuer.did)],
    [cborInt(2), cborText(didOf(e.subject))],
    [cborInt(6), cborInt(Math.floor(e.issuedAt / 1000))],
  ]);
  const entries: Array<[Buffer, Buffer]> = [
    [cborInt(1), cborInt(-19)],
    [cborInt(4), cborBytes(Buffer.from(issuer.kid, 'utf8'))],
    [cborInt(15), claims],
    [cborInt(258), cborInt(-16)],
  ];
  if (e.format !== null) entries.push([cborInt(259), cborInt(e.format)]);
  return cborMap(entries).toString('hex');
}

/** The COSE Sig_structure of the envelope, CBOR hex: the bytes that the issuer signs with Ed25519 for `envelope_sig`. */
export function envelopeSigStructure(e: EnvelopeFields): string {
  return cborArray([
    cborText('Signature1'), cborBytes(Buffer.from(envelopeProtectedHeader(e), 'hex')), cborBytes(Buffer.alloc(0)), cborBytes(Buffer.from(e.digest, 'hex')),
  ]).toString('hex');
}

/** Does `signatureHex` (64 bytes) verify with the issuer key over the Sig_structure of `e`? */
export function envelopeVerifies(e: EnvelopeFields, signatureHex: string): boolean {
  try {
    const key = CML.PublicKey.from_bytes(Buffer.from(e.issuer, 'hex'));
    return key.verify(Buffer.from(envelopeSigStructure(e), 'hex'), CML.Ed25519Signature.from_raw_bytes(Buffer.from(signatureHex, 'hex')));
  } catch { return false; }
}

// ─── Attest (Part 2 Section 4.1) ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The validity window of an Attest. Without `issuedAt` it is windowAt's. With `issuedAt` (a whole second within the coming hour) the
 * window ends at `issuedAt`, and so the attestation gets exactly that `issued_at`: an issuer who signed the Sig_structure of an earlier
 * build passes its `issued_at`, and the new build carries the same time. `validMinutes` has no effect then.
 */
export function attestationWindow(nowMs: number, validMinutes?: number, issuedAt?: number): Window {
  if (issuedAt === undefined) return windowAt(nowMs, validMinutes);
  const { lo } = windowAt(nowMs, 1);
  if (!Number.isSafeInteger(issuedAt) || issuedAt % 1000 !== 0) throw new Error(`issued_at must be a whole second in POSIX milliseconds (a multiple of 1000), got ${issuedAt}.`);
  if (issuedAt <= nowMs) {
    throw new Error(`issued_at (${isoOrRaw(issuedAt)}) has passed. It is the end of the validity window, so it must be in the future: build again without issued_at for a new time, and sign the new Sig_structure.`);
  }
  if (issuedAt - lo > MAX_RANGE_MS) throw new Error(`issued_at (${isoOrRaw(issuedAt)}) is too far ahead: the validity window is at most one hour, so issued_at can be at most ${isoOrRaw(lo + MAX_RANGE_MS)}.`);
  return { lo, hi: issuedAt };
}

export interface AttestParams extends BuildCommon {
  /** The identifier of the agent that the attestation is about. */
  subject: string;
  /** The issuer's Ed25519 public key (32 bytes, hex). It signs. */
  issuer: string;
  /** The identifier of the issuer agent, when the issuer is registered. */
  issuerId?: string;
  /** 0 to 5 or 15 (ATT_TYPES). */
  attType: number;
  /** CoAP Content-Format of the document. */
  format?: number;
  /** 32 bytes, hex: the hash of the profile or type URI. */
  profile?: string;
  /** 32 bytes, hex: the SHA-256 of the document; salted for types 4 and 5 (SALTED_DIGEST_RULE). */
  digest: string;
  /** Bytes as hex (utf8Hex of a URL): where the document can be fetched; at most 256 bytes. */
  locator?: string;
  validFrom?: number;
  validUntil?: number;
  /** The subject's controller co-signs. */
  solicited?: boolean;
  links?: Link[];
  /** The AP3X that the attestation locks; at least 5 AP3X (the default). */
  depositLovelace?: bigint;
  /** POSIX ms, a whole second: the end of the validity window and so `issued_at`. Needed with `envelopeSig`. */
  issuedAt?: number;
  /** 64 bytes, hex: the issuer's Ed25519 signature over the Sig_structure for `issuedAt`. */
  envelopeSig?: string;
}

export interface AttestBuild extends SignedByBuild {
  /** The token name of the attestation: its identifier. */
  id: string;
  /** The wallet output that the transaction spends as the seed; it gives the identifier. */
  seed: string;
  outputIndex: number;
  depositLovelace: bigint;
  /** `issued_at`: the upper bound of the window. */
  issuedAt: number;
  attestation: AttestationDatum;
  /** The COSE Sig_structure for this `issued_at` (CBOR hex): the issuer signs it to add `envelope_sig` in a new build with the same `issued_at`. */
  sigStructure: string;
}

/**
 * Builds the unsigned Attest of a new attestation (Part 2 Section 4.1). The wallet's largest pure-AP3X output is the seed, so the
 * identifier is known before signing. Signers: the issuer key (always: a controller signature does not replace it), and the subject's
 * controller for a solicited attestation. Reference inputs: the subject's record (live or tombstone) and, for a registered issuer,
 * its record and ancestors. Refuses a datum that breaks the content rules, a deposit below 5 AP3X, a missing subject, a registered
 * issuer that is not Active or does not list the issuer key with the assertion purpose, and an envelope signature that does not
 * verify over the Sig_structure of its `issued_at`. For types 4 and 5 the digest must be salted (SALTED_DIGEST_RULE); the contract
 * cannot check that.
 */
export async function buildAttest(ctx: IdentityContext, p: AttestParams): Promise<AttestBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  if (p.envelopeSig !== undefined && p.issuedAt === undefined) {
    throw new Error('envelope_sig needs issued_at: pass the issued_at of the build whose Sig_structure the issuer signed.');
  }
  const window = attestationWindow(p.nowMs ?? Date.now(), p.validMinutes, p.issuedAt);
  const wallet = await walletOf(lucid, p.changeAddress);
  const deposit = p.depositLovelace ?? MIN_ATTESTATION_LOVELACE;
  if (deposit < MIN_ATTESTATION_LOVELACE) throw new Error('An attestation locks at least 5 AP3X.');

  const attestation: AttestationDatum = {
    subject: p.subject.toLowerCase(), issuer: p.issuer.toLowerCase(), issuerId: p.issuerId?.toLowerCase() ?? null, attType: p.attType,
    format: p.format ?? null, profile: p.profile?.toLowerCase() ?? null, digest: p.digest.toLowerCase(), locator: p.locator?.toLowerCase() ?? null,
    envelopeSig: p.envelopeSig?.toLowerCase() ?? null, issuedAt: window.hi, validFrom: p.validFrom ?? null, validUntil: p.validUntil ?? null,
    solicited: p.solicited ?? false, status: { type: 'AttActive' }, contested: null, links: p.links ?? [],
  };
  refuse(attestationProblems(attestation), 'attestation');
  const envelope: EnvelopeFields = { ...attestation };
  if (attestation.envelopeSig !== null && !envelopeVerifies(envelope, attestation.envelopeSig)) {
    throw new Error(`envelope_sig does not verify with the issuer key over the Sig_structure for issued_at ${window.hi} (${isoOrRaw(window.hi)}): sign exactly the sig_structure bytes that a build with this issued_at returns.`);
  }

  const subject = await requireRecord(provider, deployment, attestation.subject, 'record of the subject');
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'attestation', deployment.attestation.hash), subject.utxo];
  const issuerHash = keyHashOf(attestation.issuer);
  const signers = new SignerList();
  if (attestation.issuerId !== null) {
    const issuer = await recordWithAncestors(provider, deployment, attestation.issuerId, 'record of the issuer');
    const status = effectiveStatus(issuer[0].record, recordsById(issuer), window.lo, window.hi);
    if (status !== 'Active') throw new Error(`The issuer ${didOf(attestation.issuerId)} is ${status}; a registered issuer must be Active to attest (Part 2 Section 4.1).`);
    if (!activeKey(issuer[0].record, issuerHash, PURPOSE.assertion)) {
      throw new Error(`${didOf(attestation.issuerId)} does not list the issuer key ${issuerHash} with the assertion purpose (Part 2 Section 4.1, active_key).`);
    }
    refs.push(...issuer.map((r) => r.utxo));
    signers.add(issuerHash, `issuer (listed with the assertion purpose in ${didOf(attestation.issuerId)})`);
  } else {
    signers.add(issuerHash, 'issuer');
  }
  if (attestation.solicited) signers.addKey(subject.record.controller, `controller of the subject ${didOf(subject.id)} (solicited)`);

  const seed = seedFrom(wallet.utxos);
  const id = identifierFromSeed(seed);
  const unit = `${deployment.attestation.hash}${id}`;
  const datum = encodeAttestationDatum(attestation);
  const minimum = ledgerMinLovelace(lucid, deployment.attestation.address, unit, datum);
  const lovelace = deposit > minimum ? deposit : minimum;
  let tx = lucid.newTx()
    .collectFrom([seed])
    .mintAssets({ [unit]: 1n }, encodeAttestationMint({ type: 'Attest', seed: { txHash: seed.txHash, outputIndex: seed.outputIndex } }))
    .pay.ToContract(deployment.attestation.address, { kind: 'inline', value: datum }, { lovelace, [unit]: 1n })
    .validFrom(window.lo)
    .validTo(window.hi)
    .readFrom(uniqueUtxos(refs));
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  const outputIndex = outputIndexOf(result.txCbor, deployment.attestation.address, unit);
  return {
    ...result, id, seed: `${seed.txHash}#${seed.outputIndex}`, outputIndex,
    depositLovelace: CML.Transaction.from_cbor_hex(result.txCbor).body().outputs().get(outputIndex).amount().coin(),
    issuedAt: window.hi, attestation, sigStructure: envelopeSigStructure(envelope),
  };
}

// ─── Issuer authority (RevokeAtt, Withdraw) ────────────────────────────────────────────────────────────────────────────────────

/** Who acts with issuer authority: the issuer key, or the controller of the issuer record. */
export type IssuerSigner = 'issuer' | 'controller';

/**
 * Issuer authority (Part 2 Section 4.1): without `issuer_id` the issuer key signs. With `issuer_id` the issuer record (live or
 * tombstone) is a reference input, and either its controller signs, or the issuer key signs while the record still lists it with the
 * assertion purpose. `by` chooses; by default the issuer key while it is listed, else the controller.
 */
async function issuerAuthority(ctx: IdentityContext, d: AttestationDatum, by?: IssuerSigner): Promise<{ signers: SignerList; refs: UTxO[]; who: string }> {
  const issuerHash = keyHashOf(d.issuer);
  if (d.issuerId === null) {
    if (by === 'controller') throw new Error('This attestation has no issuer_id, so it has no issuer record and no controller: only the issuer key can sign (by: "issuer").');
    return { signers: new SignerList().add(issuerHash, 'issuer'), refs: [], who: `the issuer key ${issuerHash}` };
  }
  const issuer = await requireRecord(ctx.provider, ctx.deployment, d.issuerId, 'record of the issuer');
  const listed = activeKey(issuer.record, issuerHash, PURPOSE.assertion);
  const choice = by ?? (listed ? 'issuer' : 'controller');
  if (choice === 'issuer') {
    if (!listed) {
      throw new Error(`The issuer key ${issuerHash} is no longer listed with the assertion purpose in ${didOf(issuer.id)}, so it has no authority (Part 2 Section 4.1): the controller of the issuer record signs instead (by: "controller").`);
    }
    return {
      signers: new SignerList().add(issuerHash, `issuer (listed with the assertion purpose in ${didOf(issuer.id)})`), refs: [issuer.utxo],
      who: `the issuer key ${issuerHash}, listed in ${didOf(issuer.id)}`,
    };
  }
  return {
    signers: new SignerList().addKey(issuer.record.controller, `controller of the issuer ${didOf(issuer.id)}`), refs: [issuer.utxo],
    who: `the controller of the issuer ${didOf(issuer.id)}`,
  };
}

// ─── RevokeAtt and Contest (the common rules of Part 2 Section 4.1) ───────────────────────────────────────────────────────────

/** What a RevokeAtt or a Contest decides, given the attestation it spends and the window. */
interface KeptPlan { redeemer: AttestationSpend; next: AttestationDatum; signers: SignerList; refs: UTxO[]; summary: string }

export interface AttestationSpendBuild extends SignedByBuild {
  id: string; action: 'RevokeAtt' | 'Contest'; summary: string;
  outputIndex: number; outputLovelace: bigint;
  /** The datum of the new attestation output. */
  attestation: AttestationDatum;
}

/**
 * Builds the unsigned spend of the attestation `id` that keeps it at the attestation address: the attestation is the only input at
 * the address, the attestation policy mints nothing, and one output at exactly the address holds the same token, the input's AP3X (or
 * the ledger minimum of the new datum, when that is more), no other asset, no reference script, and the new inline datum.
 */
async function buildKept(
  ctx: IdentityContext, p: BuildCommon & { id: string },
  plan: (current: AttestationUtxo, window: Window) => Promise<KeptPlan>,
): Promise<AttestationSpendBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const current = await requireAttestation(provider, deployment, p.id);
  const decided = await plan(current, window);
  const unit = `${deployment.attestation.hash}${current.id}`;
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'attestation', deployment.attestation.hash), ...decided.refs];
  // AP3X at least the input's (Part 2 Section 4.1), raised to the ledger minimum when the new datum is larger (a contest anchor).
  const datum = encodeAttestationDatum(decided.next);
  const minimum = ledgerMinLovelace(lucid, deployment.attestation.address, unit, datum);
  const lovelace = current.utxo.assets.lovelace > minimum ? current.utxo.assets.lovelace : minimum;
  let tx = lucid.newTx()
    .collectFrom([current.utxo], encodeAttestationSpend(decided.redeemer))
    .pay.ToContract(deployment.attestation.address, { kind: 'inline', value: datum }, { lovelace, [unit]: 1n })
    .validFrom(window.lo)
    .validTo(window.hi)
    .readFrom(uniqueUtxos(refs));
  for (const hash of decided.signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, decided.signers, wallet.keyHash);
  const outputIndex = outputIndexOf(result.txCbor, deployment.attestation.address, unit);
  return {
    ...result, id: current.id, action: decided.redeemer.type === 'RevokeAtt' ? 'RevokeAtt' : 'Contest', summary: decided.summary,
    outputIndex, outputLovelace: CML.Transaction.from_cbor_hex(result.txCbor).body().outputs().get(outputIndex).amount().coin(), attestation: decided.next,
  };
}

/** The greatest revocation reason: the contract takes any integer in [0, 2^63); this tool takes safe integers. */
const MAX_REASON = Number.MAX_SAFE_INTEGER;

/**
 * Builds the unsigned RevokeAtt of an active attestation (Part 2 Section 4.1): the status becomes `AttRevoked { at: lo, reason }`,
 * nothing else changes. Issuer authority signs (issuerAuthority; `by` chooses). The reason is any non-negative integer; Appendix A
 * codes are customary, but the contract does not enforce them for attestations (decision 9 of tests/attestation.md).
 */
export async function buildRevokeAttestation(
  ctx: IdentityContext, p: BuildCommon & { id: string; reason: number; by?: IssuerSigner },
): Promise<AttestationSpendBuild> {
  if (!Number.isSafeInteger(p.reason) || p.reason < 0 || p.reason > MAX_REASON) throw new Error('The revocation reason must be a whole number from 0 (unspecified) up.');
  return buildKept(ctx, p, async (current, window) => {
    const d = current.attestation;
    if (d.status.type === 'AttRevoked') {
      const from = withdrawableFrom(d);
      throw new Error(`The attestation ${current.id} was revoked at ${isoOrRaw(d.status.at)} (reason ${d.status.reason}); it cannot be revoked again.${from === null ? '' : ` The issuer can withdraw it from ${isoOrRaw(from)}.`}`);
    }
    const authority = await issuerAuthority(ctx, d, p.by);
    return {
      redeemer: { type: 'RevokeAtt', reason: p.reason },
      next: { ...d, status: { type: 'AttRevoked', at: window.lo, reason: p.reason } },
      signers: authority.signers, refs: authority.refs,
      summary: `revoked at ${isoOrRaw(window.lo)} with reason ${p.reason}, signed by ${authority.who}`,
    };
  });
}

/**
 * Builds the unsigned Contest of an attestation (Part 2 Section 4.1): the subject's reply `contested = Some(anchor)` replaces any
 * earlier one; nothing else changes. It works on active, revoked and already contested attestations (decision 10). The subject's
 * controller signs, with the subject's record (live or tombstone) as a reference input.
 */
export async function buildContestAttestation(ctx: IdentityContext, p: BuildCommon & { id: string; anchor: Anchor }): Promise<AttestationSpendBuild> {
  const anchor: Anchor = { uri: p.anchor.uri.toLowerCase(), sha256: p.anchor.sha256.toLowerCase() };
  const problems = anchorProblems(anchor);
  if (problems.length > 0) throw new Error(`The contest anchor breaks the rules of Part 2 Section 4.1: ${problems.join('; ')}.`);
  return buildKept(ctx, p, async (current) => {
    const d = current.attestation;
    const subject = await requireRecord(ctx.provider, ctx.deployment, d.subject, 'record of the subject');
    return {
      redeemer: { type: 'Contest' },
      next: { ...d, contested: anchor },
      signers: new SignerList().addKey(subject.record.controller, `controller of the subject ${didOf(subject.id)}`),
      refs: [subject.utxo],
      summary: `${d.contested === null ? 'the subject contests' : 'the subject replaces its earlier reply to'} the attestation of ${d.issuerId === null ? `the issuer key ${keyHashOf(d.issuer)}` : didOf(d.issuerId)}`,
    };
  });
}

// ─── Withdraw with Burn (Part 2 Section 4.1) ───────────────────────────────────────────────────────────────────────────────────

export interface WithdrawBuild extends SignedByBuild {
  id: string;
  /** The AP3X of the attestation output: the transaction returns it to the wallet (less the fee). */
  releasedLovelace: bigint;
  /** The earliest `lo` at which Withdraw passes. */
  withdrawableFrom: number;
  /** Who signs, in words. */
  authority: string;
  attestation: AttestationDatum;
}

/**
 * Builds the unsigned Withdraw of an attestation with the Burn of its token (`[(id, -1)]`): the deposit returns to the wallet.
 * Issuer authority signs (issuerAuthority; `by` chooses). Refuses before the attestation can be withdrawn (revoked with
 * `at + 90 days <= lo`, or `valid_until + 90 days <= lo`) and names the date when it can.
 */
export async function buildWithdrawAttestation(ctx: IdentityContext, p: BuildCommon & { id: string; by?: IssuerSigner }): Promise<WithdrawBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const current = await requireAttestation(provider, deployment, p.id);
  const d = current.attestation;
  const from = withdrawableFrom(d);
  if (from === null) {
    throw new Error(`The attestation ${current.id} is active and has no valid_until: it can be withdrawn only 90 days after it is revoked. Revoke it first (vector_build_attestation_revoke).`);
  }
  if (window.lo < from) {
    // The window starts a minute before the build (windowAt), so the first build that passes is a minute after `from`.
    const firstBuild = Math.ceil((from + 60_000) / 1000) * 1000;
    throw new Error(`The attestation ${current.id} can be withdrawn from ${isoOrRaw(from)} (90 days after ${d.status.type === 'AttRevoked' && d.status.at + DAYS_90_MS === from ? `its revocation at ${isoOrRaw(d.status.at)}` : `its valid_until ${isoOrRaw(d.validUntil ?? 0)}`}). Build again at or after ${isoOrRaw(firstBuild)}.`);
  }
  const authority = await issuerAuthority(ctx, d, p.by);
  const unit = `${deployment.attestation.hash}${current.id}`;
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'attestation', deployment.attestation.hash), ...authority.refs];
  let tx = lucid.newTx()
    .collectFrom([current.utxo], encodeAttestationSpend({ type: 'Withdraw' }))
    .mintAssets({ [unit]: -1n }, encodeAttestationMint({ type: 'Burn' }))
    .validFrom(window.lo)
    .validTo(window.hi)
    .readFrom(uniqueUtxos(refs));
  for (const hash of authority.signers.hashes()) tx = tx.addSignerKey(hash);
  const completed = await tx.complete();
  const result = signedByResult(completed, window, authority.signers, wallet.keyHash);
  return { ...result, id: current.id, releasedLovelace: current.utxo.assets.lovelace, withdrawableFrom: from, authority: authority.who, attestation: d };
}
