// packages/builder/src/vector/identity-shared.ts
// What the identity, attestation, delegation and vault tools share: the input schemas of keys, parties and signers, their conversion
// to the record's types, and the text of a build (the facts, the window, the key hashes that must sign, the unsigned CBOR and a JSON
// block). The tools take no key material: every key holder signs the returned transaction in turn with its own signer.
import { z } from 'zod/v4';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { withJson } from './marketplace-indexer.js';
import { cell, isoOrRaw } from './marketplace-shared.js';
import { ROLES, utf8Hex } from './identity-codec.js';
import type { Key, Role, Signer } from './identity-codec.js';
import type { PartySpec } from './identity-build.js';
import { DEFAULT_VALID_MINUTES, MAX_VALID_MINUTES } from './identity-chain.js';
import type { SignedByBuild } from './identity-chain.js';
import { PURPOSE, PURPOSE_NAMES, RIGHT, RIGHT_NAMES, ROLE_MAX_RIGHTS } from './identity-rules.js';
import type { PurposeName, RightName } from './identity-rules.js';

// ─── Input schemas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const zChangeAddress = z.string().describe("Your wallet address: it pays the fee and any deposit, gives the collateral, and receives the change. Get it from vector_signer_get_address.");
export const zDid = (whose: string) => z.string().min(1).max(256).describe(`The DID of ${whose}: did:vector:<64 hex> (the bare 64-hex identifier also works)`);
export const zValidMinutes = z.number().int().min(1).max(MAX_VALID_MINUTES).optional()
  .describe(`Minutes from now until the transaction expires (default ${DEFAULT_VALID_MINUTES}, at most ${MAX_VALID_MINUTES}): every key holder must sign and the transaction must be submitted before then`);
export const zPublicKey = (what: string) => z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters').describe(`${what}: an Ed25519 public key, 64 hex characters (vector_signer_get_public_key shows yours)`);
export const zKeyHash = (what: string) => z.string().regex(/^[0-9a-fA-F]{56}$/, 'expected 56 hex characters').describe(`${what}: a key hash, 56 hex characters`);
export const zTime = (what: string) => z.number().int().min(0).describe(`${what} (POSIX milliseconds)`);

export const zKey = z.object({
  type: z.enum(['Ed25519', 'P256']).optional().describe('Key type (default Ed25519)'),
  key: z.string().regex(/^[0-9a-fA-F]+$/).describe('The public key: 64 hex characters for Ed25519, 66 for a compressed P-256 point'),
  purposes: z.array(z.enum(PURPOSE_NAMES as [PurposeName, ...PurposeName[]])).min(1).describe('What the key may do: authentication, assertion, transaction, delegation (a P-256 key: authentication and assertion only)'),
  pop: z.string().regex(/^[0-9a-fA-F]{128}$/).optional().describe('P-256 only: the 64-byte ES256 signature by this key over "did:vector:<id>#<key hash>" (r || s, hex)'),
});
export type KeyInput = z.infer<typeof zKey>;

export const zSignerRef = z.string().describe("Who signs for the party: 'controller' (whoever is the record's controller), 'module1' (the approved dispute contract; Accountable or Responsible only), or a key hash (56 hex characters)");

export const zParty = z.object({
  role: z.enum(ROLES as unknown as [Role, ...Role[]]).describe('Accountable, Responsible, Provider, Distributor or Guardian'),
  signer: zSignerRef,
  organisation: z.string().min(1).max(64).optional().describe('The DID or domain of an organisation that the party acts for (never a person), 1 to 64 bytes'),
  not_before: zTime('When the party starts to count; default the start of the validity window').optional(),
  not_after: zTime('When the party stops counting; default never').optional(),
  rights: z.array(z.enum(RIGHT_NAMES as [RightName, ...RightName[]])).optional().describe("The party's rights: suspend, revoke, recover. Default: the highest rights of the role (Accountable suspend+revoke, Responsible and Provider suspend, Distributor none, Guardian recover)"),
});
export type PartyInput = z.infer<typeof zParty>;

export const zProfile = {
  name: z.string().min(1).max(64).describe('Agent name, 1 to 64 bytes of UTF-8'),
  description: z.string().max(256).optional().describe('Description, up to 256 bytes'),
  framework: z.string().max(64).optional().describe("Framework, up to 64 bytes (e.g. 'LangChain', 'custom')"),
  endpoint: z.string().max(256).optional().describe('Endpoint URL, up to 256 bytes (a subagent has none)'),
  capabilities: z.array(z.string().min(1).max(64)).max(16).optional().describe('Capability ids, up to 16 of 1 to 64 bytes, no duplicates'),
};

// ─── Conversions ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A signer from its tool form. `m1` is the Module-1 hash of the configuration record, needed for 'module1'. */
export function signerFromInput(ref: string, m1: string | null): Signer {
  const value = ref.trim().toLowerCase();
  if (value === 'controller' || value === 'controllerset') return { type: 'ControllerSet' };
  if (value === 'module1' || value === 'module-1') {
    if (m1 === null) throw new Error("A party with signer 'module1' needs the configuration record of the identity registry, which does not exist yet (Part 2 Section 3.8).");
    return { type: 'Script', hash: m1 };
  }
  if (/^[0-9a-f]{56}$/.test(value)) return { type: 'KeyHash', hash: value };
  throw new Error(`Signer ${JSON.stringify(ref.slice(0, 80))} is not 'controller', 'module1' or a 56-hex key hash.`);
}

/** Does this tool-form signer name Module-1? */
export const isModule1Ref = (ref: string): boolean => ['module1', 'module-1'].includes(ref.trim().toLowerCase());

export function keyFromInput(k: KeyInput): Key {
  const keyType = k.type ?? 'Ed25519';
  const purposes = [...new Set(k.purposes)].reduce((sum, name) => sum + PURPOSE[name], 0);
  return { keyType, key: k.key.toLowerCase(), purposes, pop: k.pop ? k.pop.toLowerCase() : null };
}

/** A party from its tool form. Without `not_before` the builder takes the start of the window; rights default to the role's highest. */
export function partyFromInput(p: PartyInput, m1: string | null): PartySpec {
  const rights = p.rights === undefined ? ROLE_MAX_RIGHTS[p.role] : [...new Set(p.rights)].reduce((sum, name) => sum + RIGHT[name], 0);
  return {
    role: p.role, signer: signerFromInput(p.signer, m1), organisation: p.organisation === undefined ? null : utf8Hex(p.organisation),
    notBefore: p.not_before, notAfter: p.not_after ?? null, rights, removalAfter: null,
  };
}

/** The profile fields as record bytes. */
export function profileFromInput(p: { name: string; description?: string; framework?: string; endpoint?: string; capabilities?: string[] }) {
  return {
    name: utf8Hex(p.name), description: utf8Hex(p.description ?? ''), framework: utf8Hex(p.framework ?? ''),
    endpoint: utf8Hex(p.endpoint ?? ''), capabilities: (p.capabilities ?? []).map(utf8Hex),
  };
}

// ─── Build text ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The signing flow when several keys must sign: each key holder in turn, then one submit. */
export const MULTI_SIGN_COPY =
  'Each key holder in the list signs in turn with vector_signer_sign { txCbor }, passing on the CBOR that the previous signer returned (the signer keeps the witnesses already present). ' +
  'Then broadcast with vector_submit_transaction { signedTxCbor } and confirm with vector_await_transaction { txHash }.';

/**
 * The answer of a build tool: a title, the facts (each one escaped line), the validity window, the fee, the table of key hashes that
 * must sign, the unsigned CBOR, the signing flow, and a JSON block with `json` plus the hash, fee, window and signers.
 */
export function buildText(title: string, facts: Array<[string, string]>, build: SignedByBuild, json: Record<string, unknown>, note = ''): string {
  const lines = facts.map(([label, value]) => `**${label}:** ${value}`);
  const signers = build.requiredSigners.map((s) => `| \`${s.keyHash}\` | ${s.roles.map((r) => cell(r, 120)).join('; ')} |`).join('\n');
  const md = `# ${title} (Unsigned, Not Submitted)\n\n${lines.join('\n')}\n` +
    `**Valid:** ${isoOrRaw(build.validFrom)} to ${isoOrRaw(build.validTo)} (every signature and the submit must happen before the end)\n` +
    `**Estimated fee:** ${lovelaceToAda(build.fee)} AP3X\n\n` +
    `**Required signers** (${build.requiredSigners.length}):\n\n| key hash | signs as |\n|---|---|\n${signers}\n\n` +
    `**Unsigned TX CBOR:**\n\`\`\`\n${build.txCbor}\n\`\`\`\n\n${note ? `${note}\n\n` : ''}${MULTI_SIGN_COPY}`;
  return withJson(md, {
    ...json, tx_hash: build.txHash, fee: build.fee, valid_from: build.validFrom, valid_to: build.validTo,
    required_signers: build.requiredSigners.map((s) => ({ key_hash: s.keyHash, roles: s.roles })),
  });
}
