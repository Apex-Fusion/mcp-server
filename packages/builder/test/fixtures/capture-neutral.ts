// packages/builder/test/fixtures/capture-neutral.ts
// What capture-ledger-read.mjs changes in the rows that Koios gives, so that the checked-in file holds no text of a party that is not the
// Foundation: the locator and the contest reply of an attestation, and the organisation of a delegator or of a vault owner. Each text is
// replaced by a neutral value of the same form, and the same row gets the same value in each run. The datum is encoded again with the
// codec of the builder, after a check that the codec writes back the bytes that were read, so that nothing but the replaced text changes.
// A row that is encoded again carries no datum_hash and no JSON datum value, as they would no longer match its bytes.
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  decodeAttestationDatum, decodeDelegationDatum, decodeVaultDatum, encodeAttestationDatum, encodeDelegationDatum, encodeVaultDatum, utf8Hex,
} from '../../src/vector/identity-codec.ts';
import type { Delegator } from '../../src/vector/identity-codec.ts';
import type { KoiosUtxo } from '../../src/vector/marketplace-indexer.ts';

/** The attestation of the Foundation smoke test of 2026-11-03 (Smoke Test Agent A attests Smoke Test Agent B; revoked later): it is written as read. */
export const FOUNDATION_ATTESTATIONS: Record<string, true> = { '8a4af9dbe4c2a356da2279391d3ed6a5717ca542bdbc86da0c5a0b3b361f1cb4': true };

/** The text that replaces the organisation of a delegator or an owner, as hex. A delegation allows 1 to 64 bytes. */
export const NEUTRAL_ORGANISATION = utf8Hex('Example Organisation');

/** A value after the capture changed it, and whether it did. */
export interface Neutral<T> { row: T; changed: boolean }

/** `row` with `bytes` as its inline datum, and without the hash and the JSON value of the datum that was replaced. */
const withDatum = <T extends KoiosUtxo>(row: T, bytes: string): T => ({ ...row, datum_hash: null, inline_datum: { bytes } });

/** Refuses a datum that the codec does not write back as it was read: encoding it again would change more than the replaced text. */
function mustEncodeBack(read: string, again: string, what: string): void {
  if (again !== read) throw new Error(`capture refused: the datum of ${what} does not encode back to the bytes that were read`);
}

/**
 * The attestation row `row` (the token name `id`) with its locator and its contest reply replaced by https://example.invalid/a/<first 8 hex
 * of the identifier> and https://example.invalid/c/<the same>. The attestations of FOUNDATION_ATTESTATIONS, and a row with no text, stay.
 */
export function neutralAttestation<T extends KoiosUtxo>(row: T, id: string): Neutral<T> {
  const bytes = row.inline_datum?.bytes;
  if (FOUNDATION_ATTESTATIONS[id] === true || typeof bytes !== 'string') return { row, changed: false };
  const datum = decodeAttestationDatum(bytes);
  if (datum.locator === null && datum.contested === null) return { row, changed: false };
  mustEncodeBack(bytes, encodeAttestationDatum(datum), `the attestation ${id}`);
  const short = id.slice(0, 8);
  const next = {
    ...datum,
    locator: datum.locator === null ? null : utf8Hex(`https://example.invalid/a/${short}`),
    contested: datum.contested === null ? null : { ...datum.contested, uri: utf8Hex(`https://example.invalid/c/${short}`) },
  };
  return { row: withDatum(row, encodeAttestationDatum(next)), changed: true };
}

/** `delegator` with a neutral organisation when it has one that is not neutral; null when nothing changes. */
function neutralDelegator(delegator: Delegator): Delegator | null {
  if (delegator.type !== 'PrincipalKey' || delegator.organisation === null || delegator.organisation === NEUTRAL_ORGANISATION) return null;
  return { ...delegator, organisation: NEUTRAL_ORGANISATION };
}

/** The delegation row `row` with a neutral organisation of its delegator, when it has an organisation. */
export function neutralDelegationRow<T extends KoiosUtxo>(row: T): Neutral<T> {
  const bytes = row.inline_datum?.bytes;
  if (typeof bytes !== 'string') return { row, changed: false };
  const datum = decodeDelegationDatum(bytes);
  const delegator = neutralDelegator(datum.delegator);
  if (delegator === null) return { row, changed: false };
  mustEncodeBack(bytes, encodeDelegationDatum(datum), `the delegation output ${row.tx_hash}#${row.tx_index}`);
  return { row: withDatum(row, encodeDelegationDatum({ ...datum, delegator })), changed: true };
}

/** The vault row `row` with a neutral organisation of its owner, when it has an organisation. */
export function neutralVaultRow<T extends KoiosUtxo>(row: T): Neutral<T> {
  const bytes = row.inline_datum?.bytes;
  if (typeof bytes !== 'string') return { row, changed: false };
  const datum = decodeVaultDatum(bytes);
  const owner = neutralDelegator(datum.owner);
  if (owner === null) return { row, changed: false };
  mustEncodeBack(bytes, encodeVaultDatum(datum), `the vault output ${row.tx_hash}#${row.tx_index}`);
  return { row: withDatum(row, encodeVaultDatum({ ...datum, owner })), changed: true };
}

// ─── The datum of a transaction input, in Koios' JSON form ───────────────────────────────────────────────────────────────────────

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** An own property: `constructor` is also a property of every object, and a datum names its own. */
const own = (x: Record<string, unknown>, key: string): unknown => Object.getOwnPropertyDescriptor(x, key)?.value;

/** The fields of a Plutus Data constructor with the index `index` in Koios' JSON form, or null. */
function fieldsOf(x: unknown, index: number): unknown[] | null {
  if (!isObject(x)) return null;
  const fields = own(x, 'fields');
  return own(x, 'constructor') === index && Array.isArray(fields) ? fields : null;
}

/** An owner in the JSON form (PrincipalKey is constructor 0 with a hash and an Option of the organisation) with a neutral organisation, when it has one. */
function neutralOwnerJson(owner: unknown): Neutral<unknown> {
  const parts = fieldsOf(owner, 0);
  const some = parts === null ? null : fieldsOf(parts[1], 0);
  if (!isObject(owner) || parts === null || some === null) return { row: owner, changed: false };
  const organisation = isObject(some[0]) ? own(some[0], 'bytes') : undefined;
  if (organisation === NEUTRAL_ORGANISATION) return { row: owner, changed: false };
  return { row: { ...owner, fields: [parts[0], { constructor: 0, fields: [{ bytes: NEUTRAL_ORGANISATION }] }] }, changed: true };
}

/** The vault datum of an input in the JSON form (Live is constructor 0, Returned is constructor 1; the owner is the first field) with a neutral organisation of its owner. */
export function neutralVaultJson(value: unknown): Neutral<unknown> {
  const fields = fieldsOf(value, 0) ?? fieldsOf(value, 1);
  if (!isObject(value) || fields === null) return { row: value, changed: false };
  const owner = neutralOwnerJson(fields[0]);
  return owner.changed ? { row: { ...value, fields: [owner.row, ...fields.slice(1)] }, changed: true } : { row: value, changed: false };
}

// ─── The output ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `path` as an absolute path inside `folder`, or an error: the capture writes one file, and a wrong argument must not overwrite another. */
export function outputInside(folder: string, path: string): string {
  const resolved = resolve(path);
  const inside = relative(folder, resolved);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`capture refused: ${path} is outside the fixtures folder ${folder}`);
  return resolved;
}
