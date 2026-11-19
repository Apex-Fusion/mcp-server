// packages/builder/src/vector/ledger-read-tools.ts
// The read and check tools of attestations, delegations and vaults (Part 2 Sections 4, 5.2 and 5.3): get and list attestations, check
// an attestation against the validity rule, get a delegation with its chain, check whether a delegation can be used, and get vault
// outputs. Each tool is a thin wrapper of the library functions in attestation-read.ts, delegation-read.ts and vault-read.ts. All of
// them read only: nothing is built, signed or submitted, and no key material is involved. The node comes from `providerFor`, the
// deployment from `deploymentFor` and Koios from `access`, so that a test can hand in its own.
//
// Text that comes from the chain (a locator, a contest URI, an organisation, an action or resource pattern) is written by anyone who
// can make the output. Each tool shows it cleaned in the markdown and in the JSON text field (cell: one line, no pipes or backticks, no
// invisible or direction-changing characters, a length limit), and keeps the verbatim bytes in the `_hex` field next to it.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { text, fail, cell, isoOrRaw } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { withJson } from './marketplace-indexer.js';
import type { DeploymentFor } from './identity-tools.js';
import { didOf, identifierOf } from './identity-chain.js';
import { textOf } from './identity-codec.js';
import type { Delegator } from './identity-codec.js';
import { MAX_RANGE_MS, keyHashOf } from './identity-rules.js';
import { zDid, zKeyHash, zTime } from './identity-shared.js';
import { ATT_TYPES, ATT_TYPE_NAMES, attTypeName, didKeyOf, linkRelName } from './attestation-build.js';
import type { AttTypeName } from './attestation-build.js';
import { attestationState, checkAttestation, listAttestations, parseIssuer, readAttestation } from './attestation-read.js';
import type { AttestationView, CheckLine } from './attestation-read.js';
import { HIRE_ACTION, patternsOf } from './delegation-build.js';
import { checkDelegationUse, readDelegation } from './delegation-read.js';
import type { DelegationView } from './delegation-read.js';
import { DEFAULT_PAGE, MAX_PAGE, READ_BUDGET_MS } from './ledger-read.js';
import type { LedgerEnv } from './ledger-read.js';
import { NOT_ON_NODE, readVaults } from './vault-read.js';
import type { VaultReading, VaultSelector } from './vault-read.js';

/** Koios and fetch for the reads, and the clock: the server's, unless a test hands in its own. */
export interface LedgerReadAccess { koiosUrl: string; fetchImpl: typeof fetch; now?: () => number }

const zHex32 = (what: string) => z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters').describe(what);
const zAttestation = zHex32('The attestation: its identifier (the token name, 64 hex) that the attest build returned');
const zDelegation = zHex32('The delegation: its identifier (the token name, 64 hex) that the delegate build returned');
const zAttType = z.enum(ATT_TYPE_NAMES as [AttTypeName, ...AttTypeName[]]);
const zIssuerText = (what: string) => z.string().min(1).max(256).describe(what);
const zLimit = z.number().int().min(1).max(MAX_PAGE).optional().describe(`Rows in one answer (default ${DEFAULT_PAGE}, at most ${MAX_PAGE})`);
const zOffset = z.number().int().min(0).optional().describe('Rows to skip (default 0): the next_offset of the previous answer');

const TIP_ENV = 'The server needs the identity deployment values (VECTOR_IDENTITY_*) and a node and Koios that it can reach';
const RETRY_TIP = 'The node or Koios may be unreachable; retry in a minute';

/** What every paged tool says about its pages: each call reads the whole set again, and the set can change between two calls. */
const PAGING_NOTE = 'Each call reads the set again, so a set that changes between two calls can repeat a row or skip one at a page boundary.';
/** What every tool says about its time: one budget for the whole call. */
const BUDGET_NOTE = `A call that the node or Koios answers too slowly stops after ${READ_BUDGET_MS / 1000} s with an error.`;

const ada = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} AP3X`;
const key = (hash: string): string => `\`${hash}\``;

/** The text of a field that holds UTF-8 bytes, cleaned for a JSON text field (see the header); null when the bytes are not UTF-8. */
const cleanText = (hex: string | null, max: number): string | null => {
  if (hex === null) return null;
  const decoded = textOf(hex);
  return decoded === null ? null : cell(decoded, max);
};
/** The text of a field that holds UTF-8 bytes, for markdown: cleaned, and the bytes as hex when they are not UTF-8. */
const shownText = (hex: string, max: number): string => cell(textOf(hex) ?? `0x${hex}`, max);

/** A revocation reason as JSON: a number while a number holds it exactly, else its exact decimal text. */
const reasonJson = (reason: bigint | null): number | string | null => {
  if (reason === null) return null;
  return reason >= BigInt(Number.MIN_SAFE_INTEGER) && reason <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reason) : reason.toString();
};

// ─── Attestations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The facts of an attestation: every field of its datum, its status at `atMs`, its output and its deposit. */
function attestationFacts(view: AttestationView, atMs: number): Array<[string, string]> {
  const a = view.attestation;
  const state = attestationState(a, atMs);
  const at = isoOrRaw(atMs);
  const existed = a.issuedAt - MAX_RANGE_MS;
  const before = a.validFrom !== null && atMs < a.validFrom ? `before valid_from at ${at}` : `more than one hour before issued_at at ${at}, so it did not exist yet`;
  const stateText = a.status.type === 'AttRevoked' ? `revoked at ${isoOrRaw(a.status.at)} with reason ${view.revokeReason}`
    : state === 'expired' ? `active, but past valid_until at ${at}` : state === 'not_yet_valid' ? `active, but ${before}` : `active at ${at}`;
  const facts: Array<[string, string]> = [
    ['Status', stateText],
    ['Output', `${key(view.ref)} at the attestation address, ${ada(view.lovelace)} deposit`],
    ['Subject', didOf(a.subject)],
    ['Issuer', a.issuerId === null ? `unregistered key ${key(keyHashOf(a.issuer))} (${didKeyOf(a.issuer)})` : `${didOf(a.issuerId)}, key ${key(keyHashOf(a.issuer))}`],
    ['Type', `${attTypeName(a.attType)} (${a.attType})${a.solicited ? ', solicited by the subject' : ''}`],
    ['Digest', key(a.digest)],
  ];
  if (a.format !== null) facts.push(['Format', `CoAP Content-Format ${a.format}`]);
  if (a.profile !== null) facts.push(['Profile', key(a.profile)]);
  if (a.locator !== null) facts.push(['Locator', shownText(a.locator, 256)]);
  facts.push(
    ['Issued at', `${isoOrRaw(a.issuedAt)} (the end of the validity window of its transaction; it can lie after the block time)`],
    ['Valid', `${a.validFrom === null ? 'no start date' : isoOrRaw(a.validFrom)} to ${a.validUntil === null ? 'no end date' : isoOrRaw(a.validUntil)}; never before ${isoOrRaw(existed)}, one hour before issued_at (the attestation did not exist earlier)`],
    ['Envelope', a.envelopeSig === null ? 'none' : 'carries an envelope signature (vector_check_attestation verifies it)'],
  );
  if (a.contested !== null) facts.push(['Contested', `the subject replied: ${shownText(a.contested.uri, 256)} (SHA-256 ${key(a.contested.sha256)})`]);
  if (a.links.length > 0) facts.push(['Links', a.links.map((l) => `${linkRelName(l.rel)} ${key(l.target)}`).join(', ')]);
  facts.push(['Deposit withdrawable from', view.withdrawableFrom === null ? 'not until it is revoked (it has no valid_until)' : isoOrRaw(view.withdrawableFrom)]);
  return facts;
}

/** An attestation as JSON: the datum fields by their datum names, the status and the output. Text from the chain is cleaned; `locator_hex` and `uri_hex` are verbatim. */
function attestationJson(view: AttestationView, atMs: number): Record<string, unknown> {
  const a = view.attestation;
  return {
    attestation: view.id, output_ref: view.ref, lovelace: view.lovelace,
    subject: a.subject, subject_did: didOf(a.subject),
    issuer_key: a.issuer, issuer_key_hash: keyHashOf(a.issuer), issuer_id: a.issuerId, issuer_did: a.issuerId === null ? null : didOf(a.issuerId),
    att_type: attTypeName(a.attType), att_type_code: a.attType, format: a.format, profile: a.profile, digest: a.digest,
    locator: cleanText(a.locator, 256), locator_hex: a.locator, envelope_sig: a.envelopeSig,
    issued_at: a.issuedAt, valid_from: a.validFrom, valid_until: a.validUntil, solicited: a.solicited,
    status: a.status.type === 'AttActive' ? 'active' : 'revoked', revoked_at: a.status.type === 'AttRevoked' ? a.status.at : null, revoke_reason: reasonJson(view.revokeReason),
    state: attestationState(a, atMs), at: atMs,
    contested: a.contested === null ? null : { uri: cleanText(a.contested.uri, 256), uri_hex: a.contested.uri, sha256: a.contested.sha256 },
    links: a.links.map((l) => ({ rel: linkRelName(l.rel), rel_code: l.rel, target: l.target })),
    withdrawable_from: view.withdrawableFrom,
  };
}

const factLines = (facts: Array<[string, string]>): string => facts.map(([k, v]) => `**${k}:** ${v}`).join('\n');

/** The rows of a check as a markdown table: each condition or expectation with its result. */
function checkTable(rows: CheckLine[], header: string): string {
  return `| ${header} | Result | Facts |\n|---|---|---|\n${rows.map((r) => `| ${cell(r.label, 200)} | ${r.result.replace('_', ' ')} | ${cell(r.detail, 300)} |`).join('\n')}`;
}

// ─── Delegators, delegations ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The most bytes of an organisation that a read shows. A delegation cannot name more (Part 2 Section 5.2), but a vault output is
 * written by anyone and has no such rule: a longer organisation is not shown, and its length is.
 */
const ORGANISATION_MAX_BYTES = 64;

const delegatorJson = (d: Delegator): Record<string, unknown> => {
  if (d.type === 'Agent') return { type: 'Agent', agent_did: didOf(d.id), agent: d.id };
  const organisation = d.organisation;
  const bytes = organisation === null ? null : organisation.length / 2;
  const shown = organisation !== null && bytes !== null && bytes <= ORGANISATION_MAX_BYTES;
  return { type: 'PrincipalKey', key_hash: d.hash, organisation: shown ? cleanText(organisation, ORGANISATION_MAX_BYTES) : null, organisation_hex: shown ? organisation : null, organisation_bytes: bytes };
};

/** The delegator or owner as markdown text: an agent, or a principal key with its organisation when it is short enough to show. */
const delegatorText = (d: Delegator): string => {
  if (d.type === 'Agent') return `agent ${didOf(d.id)}`;
  if (d.organisation === null) return `principal key ${d.hash}`;
  const bytes = d.organisation.length / 2;
  return `principal key ${d.hash} (${bytes <= ORGANISATION_MAX_BYTES ? `organisation ${shownText(d.organisation, ORGANISATION_MAX_BYTES)}` : `an organisation of ${bytes} bytes, not shown`})`;
};

/** One link of a delegation chain as JSON. Patterns are cleaned (at most 120 characters each); `actions_hex` and `resources_hex` are verbatim. */
function linkJson(link: DelegationView['chain'][number]): Record<string, unknown> {
  const d = link.delegation;
  return {
    delegation: link.id, output_ref: `${link.utxo.txHash}#${link.utxo.outputIndex}`, lovelace: link.utxo.assets.lovelace,
    delegator: delegatorJson(d.delegator), parent: d.parent, delegate: d.delegate, delegate_did: didOf(d.delegate), delegate_key: d.delegateKey,
    actions: patternsOf(d.actions).map((p) => cell(p, 120)), actions_hex: d.actions, resources: patternsOf(d.resources).map((p) => cell(p, 120)), resources_hex: d.resources,
    not_before: d.notBefore, not_after: d.notAfter, depth: d.depth, remaining: d.remaining, purpose: d.purpose,
    value: d.value === null ? null : { per_tx: d.value.perTx, total: d.value.total, period_ms: d.value.periodMs },
  };
}

const patternList = (hexes: readonly string[]): string => (hexes.length === 0 ? 'none (an empty list covers nothing)' : patternsOf(hexes).map((p) => `\`${cell(p, 120)}\``).join(', '));

/** The facts of one link of a delegation chain. */
function linkFacts(link: DelegationView['chain'][number]): Array<[string, string]> {
  const d = link.delegation;
  return [
    ['Output', `${key(`${link.utxo.txHash}#${link.utxo.outputIndex}`)} at the delegation address, ${ada(link.utxo.assets.lovelace)}`],
    ['Delegator', cell(delegatorText(d.delegator), 200)],
    ['Delegate', `${didOf(d.delegate)}, delegation key ${key(d.delegateKey)}`],
    ['Actions', patternList(d.actions)],
    ['Resources', patternList(d.resources)],
    ['Period', `${isoOrRaw(d.notBefore)} to ${isoOrRaw(d.notAfter)}`],
    ['Depth', `${d.depth}, ${d.remaining} further ${d.remaining === 1 ? 'hop' : 'hops'} allowed below it`],
    ['Purpose', d.purpose === null ? 'none' : key(d.purpose)],
    ['Value limit', d.value === null ? 'none' : `${ada(d.value.perTx)} per payment, ${ada(d.value.total)} per period of ${d.value.periodMs} ms`],
  ];
}

// ─── Vaults ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One vault output as JSON, with what its delegation allows when it is Live. `remaining` and `next_max` are set only for an output that can pay. */
function vaultJson(r: VaultReading): Record<string, unknown> {
  const v = r.output.vault;
  const base: Record<string, unknown> = {
    vault_ref: r.output.ref, kind: v.type, lovelace: r.output.utxo.assets.lovelace, address: r.output.utxo.address, on_node: r.onNode,
    owner: delegatorJson(v.owner), delegation: v.type === 'Live' ? v.delegation : null, spent: v.type === 'Live' ? v.spent : null, period_start: v.type === 'Live' ? v.periodStart : null,
  };
  if (r.live === null) return base;
  const a = r.live.allowance;
  const e = r.live.escrow;
  return {
    ...base,
    delegation_live: r.live.delegation !== null && r.live.delegation.chain.length > 0, delegation_missing_parent: r.live.delegation?.missingParent ?? null, delegation_error: r.live.error,
    owner_is_delegator: r.live.ownerIsDelegator, can_pay: r.live.canPay, problems: r.live.problems,
    per_tx: r.live.limit?.perTx ?? null, total: r.live.limit?.total ?? null, period_ms: r.live.limit?.periodMs ?? null,
    period_end: a?.periodEnd ?? null, period_running: a?.periodRunning ?? null, remaining: a?.remaining ?? null, next_max: a?.nextMax ?? null,
    escrow_minimum: e?.minimum ?? null, build_floor: e?.buildFloor ?? null,
  };
}

/** The text of one vault output. */
function vaultSection(r: VaultReading): string {
  const { output, live } = r;
  const v = output.vault;
  const head = `## ${v.type} vault output ${key(output.ref)}\n\n`;
  const base: Array<[string, string]> = [['Holds', ada(output.utxo.assets.lovelace)], ['Owner', cell(delegatorText(v.owner), 200)]];
  if (!r.onNode) {
    const facts: Array<[string, string]> = [...base, ['On the node', `no (${NOT_ON_NODE})`]];
    if (live !== null) facts.push(['Pays now', 'no, because the node does not hold this output']);
    return `${head}${factLines(facts)}`;
  }
  if (v.type === 'Returned' || live === null) {
    return `${head}${factLines(base)}\n\nAn escrow refund. Only its owner can spend it, with vector_build_vault_close; it never raises what the delegate can spend.`;
  }
  if (live.delegation === null) {
    return `${head}${factLines([...base, ['Delegation', `${key(v.delegation)}, which cannot be read: ${cell(live.error, 300)}`], ['Pays now', 'unknown, because the delegation cannot be read']])}`;
  }
  const missing = live.delegation.missingParent === null ? '' : `; its parent ${key(live.delegation.missingParent)} does not exist (it was undelegated)`;
  const exists = live.delegation.chain.length > 0
    ? `its token exists at the delegation address${missing}`
    : 'it does not exist: it was never made, or it was undelegated; the owner can still close this output';
  const facts: Array<[string, string]> = [...base, ['Delegation', `${key(v.delegation)}, ${exists}`]];
  const a = live.allowance;
  facts.push(['Pays now', live.canPay
    ? `yes: a payment built now for ${HIRE_ACTION} on the escrow script passes the use checks (the shortest validity window, one minute before and after now), and the next payment may lock at least the ledger minimum of the smallest escrow output`
    : `no, for ${live.problems.length} ${live.problems.length === 1 ? 'reason' : 'reasons'} (below)`]);
  if (live.limit !== null) {
    const spent = v.spent === 0n ? '' : `; spent ${ada(v.spent)}`;
    // With no payment yet the period starts at 0. The first payment starts a period only when the one from 0 has ended: a limit with a period
    // longer than the time since 1970 never ends, and its total counts for the whole life of the vault.
    const first = a === null ? '' : a.periodRunning ? ': the period of the limit counts from 0 and has not ended, so its total is a limit for the whole life of the vault' : ': the first payment starts the period';
    facts.push(
      ['Limit', `${ada(live.limit.perTx)} per payment, ${ada(live.limit.total)} per period of ${live.limit.periodMs} ms`],
      ['Period', v.periodStart === 0
        ? `no payment yet${first}${spent}`
        : a === null ? `started ${isoOrRaw(v.periodStart)}${spent}`
          : `started ${isoOrRaw(a.periodStart)}, ${a.periodRunning ? 'ends' : 'ended'} ${isoOrRaw(a.periodEnd)}${spent}${a.periodRunning ? '' : ' (a payment built now starts a new period; a payment opens its window a minute before the build, so the contract counts the old period for a minute after it ends)'}`],
    );
  }
  if (a !== null) {
    facts.push(['Still allowed', `${ada(a.remaining)} in ${a.periodRunning ? 'this period' : 'the next period'}; the next payment may lock up to ${ada(a.nextMax)}: the smallest of the limit per payment, what the period still allows, and the AP3X of the vault above the ledger minimum of its next output`]);
  }
  if (live.escrow !== null) {
    facts.push(['Smallest payment', `${ada(live.escrow.minimum)}, the ledger minimum of the smallest escrow output (an Open escrow with the refund to this vault and the delegate key). vector_build_vault_pay locks at least ${ada(live.escrow.buildFloor)}, its own floor for the shortest datum, and a real advert needs more`]);
  }
  const why = live.canPay ? '' : `\n\n**Why it cannot pay:**\n${live.problems.map((p, i) => `${i + 1}. ${cell(p, 300)}`).join('\n')}`;
  return `${head}${factLines(facts)}${why}`;
}

// ─── Registration ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function registerLedgerReadTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: DeploymentFor, access: LedgerReadAccess) {
  const now = () => (access.now ?? Date.now)();
  const envOf = (): LedgerEnv => ({ provider: providerFor(), deployment: deploymentFor(), koiosUrl: access.koiosUrl, fetchImpl: access.fetchImpl });
  /** Runs a tool: the rate gate, then `body`; a failure becomes `fail`. */
  const run = async (failure: string, tips: string[], body: () => Promise<string>) => {
    const limited = checkRateLimit(); if (limited) return limited;
    try { return text(await body()); } catch (err) { return fail(failure, err, tips); }
  };

  server.tool(
    'vector_get_attestation',
    'Show an attestation by its identifier (Part 2 Section 4). The answer gives every field of the datum, the status now, the output reference, the deposit, and the time from which the issuer can withdraw the deposit. ' +
      'The identifier is the token name that the attest build returns. A withdrawn attestation, or one that never existed, is not found. ' +
      'The attestation is valid from valid_from (or from its issue, when it has none) to valid_until, but never earlier than one hour before issued_at: issued_at is the end of the validity window of the transaction that made it, and that window is at most one hour long, so a time before that is before the attestation existed. ' +
      `The reason of a revocation is shown exactly, whatever its size. ${BUDGET_NOTE} Read-only: the tool builds and signs nothing.`,
    { attestation: zAttestation },
    async (args) => run('read the attestation', [TIP_ENV, RETRY_TIP], async () => {
      const env = envOf();
      const id = args.attestation.toLowerCase();
      const view = await readAttestation(env, id);
      if (view === null) {
        return withJson(`# Attestation Not Found\n\nNo output at ${env.deployment.attestation.address} holds the attestation token ${id}. The attestation does not exist, it was withdrawn, or it is not confirmed yet.`, { attestation: id, found: false });
      }
      const atMs = now();
      return withJson(`# Attestation ${id}\n\n${factLines(attestationFacts(view, atMs))}`, { found: true, ...attestationJson(view, atMs) });
    }),
  );

  server.tool(
    'vector_list_attestations',
    'List the attestations about a subject, from an issuer, or both (Part 2 Section 4). Give a subject, an issuer or both. Give neither to list every attestation. The issuer is a DID (it matches issuer_id), a key hash or a public key (both match the issuer key), ' +
      'or 64 hex that can be an issuer identifier or a public key (they match by either reading). ' +
      'With a subject or an issuer, the newest attestation comes first (by issued_at, then by identifier). Each row shows its state now: active, revoked, expired or not yet valid (before valid_from, or more than one hour before issued_at). An optional type narrows the list. Limit and offset page it. ' +
      'Koios lists the outputs at the attestation script that hold an attestation token and whose datum holds the bytes of the subject (or, with no subject, of the issuer). The tool decodes each output and compares the subject, the issuer and the type on the decoded fields. ' +
      'A call fails when 5,000 or more attestation outputs name the subject or the issuer: read one attestation with vector_get_attestation then. ' +
      'An attestation whose datum writes those bytes in a non-standard form (a byte string in chunks) is not listed: vector_get_attestation reads it by its identifier. ' +
      'An issuer that is given by its key hash alone cannot narrow the read, because a datum holds the public key and not its hash: the call then reads every attestation output, and it fails when 5,000 or more exist. Give the public key, the issuer DID or a subject. ' +
      'With neither a subject nor an issuer, Koios pages the list: the rows come in the order of the output reference, not newest first, and the answer has no total. A type needs a subject or an issuer. ' +
      'The rows are as Koios lists them. vector_get_attestation and vector_check_attestation confirm one attestation on the node. ' +
      `${PAGING_NOTE} ${BUDGET_NOTE} Read-only: the tool builds and signs nothing.`,
    {
      subject: zDid('the agent that the attestations are about').optional(),
      issuer: zIssuerText('The issuer: a DID (did:vector:<64 hex>, matched with issuer_id of a registered issuer), a key hash (56 hex) or an Ed25519 public key (64 hex) of the issuer key. 64 hex can also be an issuer identifier: they match by either reading').optional(),
      att_type: zAttType.optional().describe('Only attestations of this type (it needs a subject or an issuer): identity (0), provenance (1), software (2), environment (3), principal_binding (4), approval (5) or other (15)'),
      limit: zLimit,
      offset: zOffset,
    },
    async (args) => run('list attestations', [TIP_ENV, RETRY_TIP, 'If 5,000 or more attestation outputs name the subject or the issuer, read one attestation with vector_get_attestation'], async () => {
      const env = envOf();
      const atMs = now();
      const page = await listAttestations(env, {
        subject: args.subject, issuer: args.issuer === undefined ? undefined : parseIssuer(args.issuer),
        attType: args.att_type === undefined ? undefined : ATT_TYPES[args.att_type], offset: args.offset, limit: args.limit,
      });
      const named = args.subject !== undefined || args.issuer !== undefined;
      const asked = [args.subject === undefined ? null : `subject ${didOf(identifierOf(args.subject))}`, args.issuer === undefined ? null : `issuer ${cell(args.issuer, 80)}`, args.att_type === undefined ? null : `type ${args.att_type}`].filter((s) => s !== null).join(', ');
      const rows = page.items.map((v, i) => {
        const a = v.attestation;
        const state = attestationState(a, atMs);
        const issuer = a.issuerId === null ? `key ${key(keyHashOf(a.issuer))}` : `${didOf(a.issuerId)}`;
        return `${page.offset + i + 1}. ${key(v.id)}: ${attTypeName(a.attType)} (${a.attType}), ${state.replace(/_/g, ' ')}\n   - Subject: ${didOf(a.subject)}\n   - Issuer: ${issuer}\n   - Issued: ${isoOrRaw(a.issuedAt)}; valid until ${a.validUntil === null ? 'no end date' : isoOrRaw(a.validUntil)}; output ${key(v.ref)}`;
      });
      const next = page.nextOffset === null ? '' : `\n\nMore rows follow: call again with offset ${page.nextOffset}. ${PAGING_NOTE}`;
      const order = named ? `Matching: ${asked}. Newest first.` : 'Every attestation, in the order of its output reference (not newest first).';
      const source = 'The rows are as Koios lists them: vector_get_attestation and vector_check_attestation confirm one attestation on the node.';
      const md = page.total === 0
        ? `# Attestations\n\nNo attestation matches (${asked}).`
        : page.items.length === 0
          ? `# Attestations\n\nNo rows at offset ${page.offset}${page.total === null ? '' : `: ${page.total} in total (${asked})`}.${next}`
          : `# Attestations (${page.offset + 1} to ${page.offset + page.items.length}${page.total === null ? '' : ` of ${page.total}`})\n\n${order} ${source}\n\n${rows.join('\n')}${next}`;
      return withJson(md, { total: page.total, offset: page.offset, limit: page.limit, next_offset: page.nextOffset, at: atMs, attestations: page.items.map((v) => attestationJson(v, atMs)) });
    }),
  );

  server.tool(
    'vector_check_attestation',
    'Check an attestation against the validity rule for relying parties (Part 2 Section 4.3). The answer lists each condition with its result: the attestation is authentic and active; the time is inside valid_from and valid_until (the bounds are inclusive) ' +
      'and not more than one hour before issued_at (a time before that is before the attestation existed); the envelope signature verifies, if there is one; the issuer identity and its ancestors have no invalid-from time at or before issued_at. ' +
      'It then lists each expectation that you give with its result: type, subject, issuer and digest. ' +
      'A DID matches issuer_id. A key hash or a public key matches the issuer key by its key hash. 64 hex can be an issuer identifier or a public key: they match by either reading. ' +
      'The attestation is valid only when every condition and every expectation passes. A revoked attestation is not valid, and the answer gives its reason exactly, whatever its size. The time defaults to now. ' +
      `issued_at is the end of the validity window of the transaction that made the attestation. It can lie after the block time and after the time of the check, so a time up to one hour before issued_at can still be a time at which the attestation existed. ${BUDGET_NOTE} Read-only: the tool builds and signs nothing.`,
    {
      attestation: zAttestation,
      time: zTime('The time to check at (default now)').optional(),
      expected_type: zAttType.optional().describe('The type that the attestation must have: identity (0), provenance (1), software (2), environment (3), principal_binding (4), approval (5) or other (15)'),
      expected_subject: zDid('the agent that the attestation must be about').optional(),
      expected_issuer: zIssuerText('The issuer that the attestation must name: a DID (compared with issuer_id), a key hash (56 hex) or an Ed25519 public key (64 hex) compared with the issuer key by its key hash, or 64 hex that can be an issuer identifier or a public key (they match by either reading)').optional(),
      expected_digest: zHex32('The SHA-256 digest that the attestation must carry (64 hex)').optional(),
    },
    async (args) => run('check the attestation', [TIP_ENV, RETRY_TIP], async () => {
      const env = envOf();
      const atMs = args.time ?? now();
      const check = await checkAttestation(env, {
        id: args.attestation, atMs,
        expect: {
          attType: args.expected_type === undefined ? undefined : ATT_TYPES[args.expected_type], subject: args.expected_subject,
          issuer: args.expected_issuer === undefined ? undefined : parseIssuer(args.expected_issuer), digest: args.expected_digest,
        },
      });
      const unmet = [...check.conditions, ...check.expectations].filter((l) => l.result === 'fail').length;
      const head = `# Attestation Check: ${check.valid ? 'valid' : 'not valid'}\n\nAttestation ${key(check.id)}, checked at ${isoOrRaw(atMs)}${args.time === undefined ? ' (now)' : ''}.${check.valid ? '' : ` ${unmet} ${unmet === 1 ? 'check fails' : 'checks fail'}.`}`;
      const rule = `## Validity rule (Part 2 Section 4.3): ${check.ruleValid ? 'met' : 'not met'}\n\n${checkTable(check.conditions, 'Condition')}`;
      const expect = check.expectations.length === 0 ? '' : `\n\n## Expectations: ${check.expectations.every((e) => e.result === 'pass') ? 'met' : 'not met'}\n\n${checkTable(check.expectations, 'Expectation')}`;
      const view = check.attestation;
      return withJson(`${head}\n\n${rule}${expect}${view === null ? '' : `\n\n## Attestation\n\n${factLines(attestationFacts(view, atMs))}`}`, {
        attestation: check.id, found: view !== null, at: atMs, valid: check.valid, rule_valid: check.ruleValid,
        conditions: check.conditions, expectations: check.expectations, details: view === null ? null : attestationJson(view, atMs),
      });
    }),
  );

  server.tool(
    'vector_get_delegation',
    'Show a live delegation by its identifier (Part 2 Section 5.2). The answer gives the delegator, the delegate and its delegation key, the actions, the resources, the period, the depth, the purpose and the value limit. It also gives the chain of parent delegations up to the root. ' +
      'A delegation that does not exist, or that was undelegated, is not live. When a parent was undelegated, the answer shows the links that exist and names the missing parent. The delegation cannot be used then. ' +
      `The text of a pattern is cleaned for display; the JSON also gives each pattern as verbatim hex. ${BUDGET_NOTE} Read-only: the tool builds and signs nothing.`,
    { delegation: zDelegation },
    async (args) => run('read the delegation', [TIP_ENV, RETRY_TIP], async () => {
      const view = await readDelegation(envOf(), args.delegation);
      if (view.chain.length === 0) {
        return withJson(`# Delegation Not Live\n\nNo output at the delegation address holds the delegation token ${view.id}. The delegation does not exist, or it was undelegated and its token is burned.`, { delegation: view.id, live: false, chain: [], missing_parent: null });
      }
      const [leaf, ...parents] = view.chain;
      const chain = parents.map((p, i) => `### Parent ${i + 1}: ${key(p.id)}\n\n${factLines(linkFacts(p))}`).join('\n\n');
      const gone = view.missingParent === null ? '' : `\n\nThe parent delegation ${key(view.missingParent)} does not exist: it was undelegated. This delegation, and every delegation below it, cannot be used.`;
      const md = `# Delegation ${key(leaf.id)}\n\n${factLines(linkFacts(leaf))}\n\n**Chain to the root:** ${view.chain.length} ${view.chain.length === 1 ? 'link' : 'links'}${view.missingParent === null && parents.length === 0 ? ' (this delegation is the root)' : ''}${chain === '' ? '' : `\n\n${chain}`}${gone}`;
      return withJson(md, { delegation: view.id, live: true, missing_parent: view.missingParent, chain: view.chain.map(linkJson) });
    }),
  );

  server.tool(
    'vector_check_delegation_use',
    'Check whether a delegation can be used for an action on a resource at one instant (Part 2 Section 5.2). The answer lists the problems. An empty list means usable at that instant. The checks are those that a dependent contract such as the vault makes. ' +
      'The delegation and every ancestor exist (a burned one is a problem). Each delegate is Active and still lists its delegation key with the delegation purpose. A root delegator that is an agent is Active. The period holds the instant. ' +
      'The action patterns and the resource patterns cover the action and the resource by the pattern rule of Section 5.1: marketplace.* covers marketplace.hire.v1, and string equality is not the rule. The instant defaults to now. ' +
      'Usable is for that one instant. A transaction needs its whole validity window inside the period, and each delegate Active over the whole window, so a delegation that is usable now can still fail in a build that ends later. ' +
      `The action for vault payments is ${HIRE_ACTION}. Its resource is script:<escrow script hash>. With min_confirmations, each link must also lie that many blocks below the tip (the gateway token path uses 30 for a mint). The tool does not check the signature of the delegation key. ${BUDGET_NOTE} Read-only: the tool builds and signs nothing.`,
    {
      delegation: zDelegation,
      action: z.string().min(1).max(256).describe(`The action: an internal name such as ${HIRE_ACTION}, or an external that starts with oauth:, mcp: or https://`),
      resource: z.string().min(1).max(256).describe('The resource: script: and the 56 hex characters of a script hash, or an external that starts with oauth:, mcp: or https://'),
      time: zTime('The instant to check at (default now)').optional(),
      min_confirmations: z.number().int().min(0).max(100_000).optional().describe('Each link of the chain must have at least this many blocks on top of the block of its mint (default 0: no wait)'),
    },
    async (args) => run('check the delegation use', [TIP_ENV, RETRY_TIP, `For a vault payment the action is ${HIRE_ACTION} and the resource is script:<escrow script hash>`], async () => {
      const atMs = args.time ?? now();
      const check = await checkDelegationUse(envOf(), { id: args.delegation, action: args.action, resource: args.resource, atMs, minConfirmations: args.min_confirmations });
      const problems = check.problems.length === 0 ? 'No problem found.' : `${check.problems.length} ${check.problems.length === 1 ? 'problem' : 'problems'}:\n${check.problems.map((p, i) => `${i + 1}. ${cell(p, 400)}`).join('\n')}`;
      const links = check.view.chain.length === 0 ? '' : `\n\n**Chain:** ${check.view.chain.map((l) => key(l.id)).join(' then ')}`;
      const conf = check.confirmations === null ? '' : `\n\n**Confirmations** (tip height ${check.confirmations.tipHeight}): ${check.confirmations.links.map((l) => `${key(l.id)} ${l.confirmations === null ? 'unknown' : l.confirmations}`).join(', ')}`;
      const md = `# Delegation Use: ${check.usable ? 'usable' : 'not usable'}\n\nDelegation ${key(check.view.id)}, action \`${cell(check.action, 120)}\` on resource \`${cell(check.resource, 120)}\`, at the instant ${isoOrRaw(atMs)}${args.time === undefined ? ' (now)' : ''}.\n\n${problems}${links}${conf}\n\nThe answer is for that one instant. A transaction needs its whole validity window inside the period, with each delegate Active over the whole window. The signature of the delegation key is not checked.`;
      return withJson(md, {
        delegation: check.view.id, action: check.action, resource: check.resource, at: atMs, usable: check.usable, problems: check.problems, min_confirmations: check.minConfirmations,
        chain: check.view.chain.map((l) => l.id), missing_parent: check.view.missingParent,
        confirmations: check.confirmations === null ? null : { tip_height: check.confirmations.tipHeight, links: check.confirmations.links.map((l) => ({ delegation: l.id, block_height: l.blockHeight, confirmations: l.confirmations })) },
      });
    }),
  );

  server.tool(
    'vector_get_vault',
    'Show vault outputs (Part 2 Section 5.3), Live and Returned, with their datum and AP3X. Give exactly one of vault_ref (one unspent output), owner_key_hash (every output that this principal key owns) or delegation (every Live output that names it). ' +
      'The reference of a vault output changes with each payment. A read by owner key hash or by delegation finds the current output. A Returned output (an escrow refund) names only its owner, so read it by owner key hash. ' +
      'A vault output whose datum the tool cannot read as a vault datum is not listed: read it with vault_ref to see why. ' +
      'Anyone can write a vault output with any datum, so an output is not a vault of its owner because it names the owner. The outputs whose owner is the delegator of their delegation come first, the one with the most AP3X first, then the other Live outputs, then the Returned ones; each of the last two groups is in the order of the output reference. ' +
      'When the delegations cannot be read for this order (5,000 or more exist), the order is by output reference only, and the answer says so. ' +
      'Limit and offset page the list. Only the outputs of the page are read further. The tool confirms the page on the node with one request: a row that the node does not hold (it is spent, or the indexer is ahead) cannot pay, and the answer says so. ' +
      'For a Live output the answer gives the delegation, the value limit, whether the output can pay a marketplace escrow now and, if not, why not. ' +
      'It gives what the period still allows (remaining, and next_max: the most that the next payment may lock, which also keeps the ledger minimum of the next output) only for an output that can pay. ' +
      'An output can pay only when next_max reaches the ledger minimum of the smallest escrow output that a payment can make (an Open escrow with the refund to the vault and the delegate key): below that, no payment can leave it. The answer gives that minimum as escrow_minimum. ' +
      'vector_build_vault_pay locks at least its own floor, which is higher; the answer gives it as build_floor, and a real advert needs more. ' +
      `A delegation that cannot be read is reported on its output and does not stop the others. A call that needs too many requests, or that the node or Koios answers too slowly, stops after ${READ_BUDGET_MS / 1000} s with an error: ask for a smaller limit. ` +
      'A read also fails when 5,000 or more outputs match one Koios filter (the vault outputs of the owner key, or the Live outputs of the delegation): read by delegation instead of by owner key hash, or the reverse. ' +
      `${PAGING_NOTE} Read-only: the tool builds and signs nothing.`,
    {
      vault_ref: z.string().min(1).max(100).optional().describe("One vault output: '<txid>#<index>'"),
      owner_key_hash: zKeyHash('The principal key that owns the vault outputs').optional(),
      delegation: zDelegation.optional(),
      limit: zLimit,
      offset: zOffset,
    },
    async (args) => run('read the vault', [TIP_ENV, RETRY_TIP, 'A vault output reference changes with each payment: read by owner_key_hash or delegation to find the current one'], async () => {
      const given = [args.vault_ref, args.owner_key_hash, args.delegation].filter((v) => v !== undefined).length;
      if (given !== 1) throw new Error('Give exactly one of vault_ref, owner_key_hash and delegation.');
      const selector: VaultSelector = args.vault_ref !== undefined ? { vaultRef: args.vault_ref } : args.owner_key_hash !== undefined ? { ownerKeyHash: args.owner_key_hash } : { delegation: args.delegation! };
      const by = 'vaultRef' in selector ? `output ${key(cell(selector.vaultRef, 100))}` : 'ownerKeyHash' in selector ? `owner key hash ${key(selector.ownerKeyHash.toLowerCase())}` : `delegation ${key(selector.delegation.toLowerCase())}`;
      const atMs = now();
      const page = await readVaults(envOf(), selector, atMs, { offset: args.offset, limit: args.limit });
      const note = 'A vault output reference changes with each payment: read by owner key hash or by delegation to find the current output.';
      const anyone = 'Anyone can write a vault output, so an output that names an owner is not a vault of that owner.';
      const order = page.byDelegator
        ? `The outputs whose owner is the delegator of their delegation come first, the one with the most AP3X first. ${anyone}`
        : `The delegations could not be read for the order (5,000 or more exist, or the delegation cannot be read), so the order is by output reference only, Live outputs first. Each output of the page says whether its owner is the delegator of its delegation. ${anyone}`;
      const confirmed = 'vaultRef' in selector ? '' : ' The outputs of the page are confirmed on the node: a row that the node does not hold cannot pay.';
      const next = page.nextOffset === null ? '' : `\n\nMore outputs follow: call again with offset ${page.nextOffset}. ${PAGING_NOTE}`;
      const md = page.total === 0
        ? `# Vault Outputs\n\nNo vault output matches (${by}). ${note}`
        : page.items.length === 0
          ? `# Vault Outputs\n\nNo rows at offset ${page.offset}: ${page.total} in total (${by}).`
          : `# Vault Outputs (${page.offset + 1} to ${page.offset + page.items.length} of ${page.total})\n\nRead by ${by}, at ${isoOrRaw(atMs)}. ${note} ${order}${confirmed}\n\n${page.items.map(vaultSection).join('\n\n')}${next}`;
      return withJson(md, { read_by: by.replace(/`/g, ''), at: atMs, total: page.total, offset: page.offset, limit: page.limit, next_offset: page.nextOffset, shown: page.items.length, ordered_by_delegator: page.byDelegator, outputs: page.items.map(vaultJson) });
    }),
  );
}
