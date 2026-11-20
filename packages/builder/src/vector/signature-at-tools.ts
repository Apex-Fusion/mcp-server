// packages/builder/src/vector/signature-at-tools.ts
// vector_verify_signature_at: was an Ed25519 signature valid at a time that the caller names? The decision is in signature-at.ts. This file
// holds the input schema, the text of the answer and the registration. The tool reads the identity gateway, and the tip of the node (the chain
// provider of the server) to see that the gateway is current. It needs no Koios and no identity deployment, and it builds and signs nothing.
//
// Text from the gateway is cleaned in signature-at.ts before it reaches the markdown or the JSON block (cell: one line, no pipes or backticks,
// no invisible or direction-changing characters, a length limit).
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cell, fail, text } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { withJson } from './marketplace-indexer.js';
import {
  DEFAULT_PURPOSE, DID_INPUT, KEY_INPUT, MAX_GATEWAY_LAG_BLOCKS, MAX_MESSAGE_BYTES, MAX_NODE_TIP_AGE_MS, MESSAGE_HEX, MIN_AGE_MS, PURPOSES, SIGNATURE_HEX, TIME_CLAIM_NOTE,
  TIME_INPUT, parseSignatureAtInput, verifySignatureAt,
} from './signature-at.js';
import type { NowFacts, SignatureAtAccess, SignatureAtResult, StatusFacts } from './signature-at.js';

const DESCRIPTION = [
  'Check an Ed25519 signature of a did:vector agent against the DID document that was valid at a time that you name.',
  'The tool asks the identity gateway for the DID as it was at that time (DID Resolution versionTime).',
  'It decides from that one answer.',
  'The result is VALID only when all of these are true.',
  `The time is at least ${MIN_AGE_MS / 60_000} minutes before now, and at least ${MIN_AGE_MS / 60_000} minutes before the tip block of the node.`,
  'The DID has a version at that time.',
  'The version has a DID document, so the DID is not deactivated or invalidated at that time.',
  `The gateway is current: its ledger tip is at most ${MAX_GATEWAY_LAG_BLOCKS} blocks behind the tip of the node.`,
  `The tip of the node is at most ${MAX_NODE_TIP_AGE_MS / 60_000} minutes old, so the node is a reference for the tip of the chain.`,
  'The time lies inside the version: the version started at or before the time, and its next update, when there is one, is after the time.',
  'The effective status of the version is active.',
  'No invalid-from time lies at or before the time.',
  'The version lists the key for the purpose (assertionMethod or authentication).',
  'The listed key is the key that you give.',
  'The signature verifies over the message.',
  'The result is INVALID, with the reason, when a check fails.',
  'When the gateway gives nextUpdate, a signature in the exact second of an update is INVALID (ambiguous_second).',
  'The result is NOT CHECKED when the tool cannot decide.',
  `This happens when the time is less than ${MIN_AGE_MS / 60_000} minutes before now, less than ${MIN_AGE_MS / 60_000} minutes before the tip block of the node, or in the future (too_recent): a later change can still have fewer than 30 confirmations, and the gateway does not show it.`,
  `It happens when the gateway is more than ${MAX_GATEWAY_LAG_BLOCKS} blocks behind the node (gateway_behind), when the tip of the node is more than ${MAX_NODE_TIP_AGE_MS / 60_000} minutes old (tip_stale), or when the tool cannot read a ledger tip (tip_unreadable).`,
  'It happens when the gateway gives an error, or when its answer is not complete or not well formed (gateway_error, answer_unreadable).',
  'It happens when the listed key is not an Ed25519 key (key_type_unsupported).',
  'It happens when the DID has a later version and the gateway does not give its time (nextUpdate): the tool cannot apply the nextUpdate check then (next_update_missing).',
  'When the gateway gives no nextUpdate, a signature at a time before the latest version gives NOT CHECKED (next_update_missing).',
  `Give the message as UTF-8 text (message) or as hex (message_hex), not both. It is at most ${MAX_MESSAGE_BYTES} bytes.`,
  'The signature is the raw Ed25519 signature of 64 bytes over exactly these bytes. It has no COSE or JWS wrapper.',
  'Give the key as a verification method id (did:vector:<id>#<key hash>), a key hash (56 hex) or an Ed25519 public key (64 hex).',
  'The controller key counts only when the DID lists it for the purpose.',
  'The time (at) is YYYY-MM-DDThh:mm:ssZ in UTC, in whole seconds.',
  'The answer names the version that it used (versionId, and updated and nextUpdate when the gateway gives them).',
  'It lists the keys of that version and gives the state of the DID now.',
  'When the DID is revoked now, the answer shows the reason and the invalid-from time.',
  'A signature that was made before the invalid-from time stays valid.',
  'The time is the claim of the caller. The tool cannot prove when the signature was made.',
  'An auditor needs a time anchor, for example a transaction.',
  'Read-only: the tool builds and signs nothing.',
].join(' ');

const INPUT_SCHEMA = {
  did: z.string().regex(DID_INPUT, 'expected did:vector:<64 lowercase hex>').describe('The DID of the agent that signed: did:vector:<64 lowercase hex>'),
  message: z.string().max(MAX_MESSAGE_BYTES).optional().describe(`The signed message as UTF-8 text, at most ${MAX_MESSAGE_BYTES} bytes. Give this or message_hex`),
  message_hex: z.string().max(2 * MAX_MESSAGE_BYTES).regex(MESSAGE_HEX, 'expected an even number of hex characters').optional()
    .describe(`The signed message as hex (an even number of characters), at most ${MAX_MESSAGE_BYTES} bytes. Give this or message`),
  signature_hex: z.string().regex(SIGNATURE_HEX, 'expected 128 hex characters').describe('The Ed25519 signature: 64 bytes, 128 hex characters'),
  key: z.string().regex(KEY_INPUT, 'expected a verification method id, a key hash (56 hex) or an Ed25519 public key (64 hex)')
    .describe('The key that signed: a verification method id (did:vector:<64 hex>#<56 hex>), a key hash (56 hex) or an Ed25519 public key (64 hex)'),
  purpose: z.enum(PURPOSES).optional().describe(`What the version of the DID must list the key for: assertionMethod or authentication (default ${DEFAULT_PURPOSE})`),
  at: z.string().regex(TIME_INPUT, 'expected YYYY-MM-DDThh:mm:ssZ')
    .describe(`The time of the signature: YYYY-MM-DDThh:mm:ssZ (UTC, whole seconds, at least ${MIN_AGE_MS / 60_000} minutes before now and before the tip block of the node). The tool takes it as the claim of the caller`),
};

const code = (value: string): string => `\`${value}\``;

/** The answer for an input that the tool refused: nothing was asked of the gateway, and no signature was checked. */
function refusedText(refusal: string): string {
  return withJson(
    `# Signature Check Refused\n\nThe tool did not check the signature. ${cell(refusal, 300)}.`,
    { verdict: 'not_checked', valid: false, reason: 'input_refused', detail: refusal },
  );
}

/** The status of a version as JSON. */
const statusJson = (s: StatusFacts | null): Record<string, string | null> | null => (s === null ? null : {
  status: s.status, effective: s.effective, effective_reason: s.effectiveReason, reason: s.reason, at: s.at, invalid_from: s.invalidFrom,
});

function keyText(r: SignatureAtResult): string {
  const form = r.key.form === 'verification_method' ? 'a verification method id' : r.key.form === 'key_hash' ? 'a key hash' : 'a public key';
  const listed = r.listedPublicKey === null ? '' : `, Ed25519 public key in the document ${code(r.listedPublicKey)}`;
  return `${code(`#${r.key.keyHash}`)} (given as ${form})${listed}`;
}

function versionText(r: SignatureAtResult): string {
  if (!r.asked) return 'not known: the gateway was not asked';
  const v = r.version;
  const first = r.checks.find((c) => c.id === 'version');
  if (first?.result === 'fail') return 'none: the gateway has no confirmed version of the DID at that time';
  if (v === null || (first?.result !== 'pass' && v.versionId === null)) return 'not known: the gateway gave no version that the tool can use';
  const given = (label: string, value: string | null): string => `${label} ${value === null ? 'not given: the gateway did not give it' : value}`;
  const parts = [`version ${v.versionId ?? 'not given'}`, v.created === null ? null : `created ${v.created}`, given('updated', v.updated), given('next update', v.nextUpdate)];
  if (v.nextVersionId !== null) parts.push(`next version ${v.nextVersionId}`);
  return parts.filter((p) => p !== null).join('; ');
}

function statusText(s: StatusFacts | null): string {
  if (s === null || s.effective === null) return 'not given by the gateway';
  const own = s.status !== null && s.status !== s.effective ? `, record status ${s.status}` : '';
  return `${s.effective}${s.effectiveReason ? ` (${s.effectiveReason})` : ''}${own}`;
}

function nowText(n: NowFacts): string {
  const sentences: string[] = [];
  const state = n.effective === null ? 'not given by the gateway' : `${n.effective}${n.effectiveReason ? ` (${n.effectiveReason})` : ''}`;
  sentences.push(`${state}.${n.deactivated ? ' The DID is deactivated now.' : ''}`);
  if (n.details !== null) {
    const record = [n.details.status === null ? null : `record status ${n.details.status}`, n.details.reason === null ? null : `reason ${n.details.reason}`, n.details.at === null ? null : `at ${n.details.at}`].filter((p) => p !== null);
    if (record.length > 0) sentences.push(`The record says: ${record.join(', ')}.`);
  } else if (n.deactivated && n.detailsRead === 'not_available') {
    sentences.push('The gateway did not give the revocation details. vector_resolve_did { did } shows them.');
  }
  if (n.invalidFrom !== null) {
    sentences.push(`Invalid-from time: ${n.invalidFrom}. A signature that was made before it stays valid. A signature at or after it is invalid.`);
  }
  return sentences.join(' ');
}

/** The ledger tips as one line, or null when the check has none. */
function tipsText(r: SignatureAtResult): string | null {
  const { gateway, node } = r.tips;
  if (gateway === null && node === null) return null;
  const known = (height: number | null): string => (height === null ? 'not known' : `block ${height}`);
  const lag = gateway === null || node === null ? '' : node - gateway > 0 ? ` (the gateway is ${node - gateway} blocks behind)` : ' (the gateway is not behind)';
  return `gateway ${known(gateway)}, node ${known(node)}${lag}`;
}

function checkTable(r: SignatureAtResult): string {
  const rows = r.checks.map((c) => `| ${cell(c.label, 200)} | ${c.result.replace('_', ' ')} | ${cell(c.detail, 300)} |`);
  return `| Check | Result | Facts |\n|---|---|---|\n${rows.join('\n')}`;
}

function keysSection(r: SignatureAtResult): string {
  if (!r.hasDocument) return '';
  if (r.listedKeys.length === 0) return '\n\n**Keys that this version lists:** none (the DID document has no verification method)';
  const rows = r.listedKeys.map((k) => `- ${code(k.id)}: ${k.type}, ${k.purposes.length ? k.purposes.join(', ') : 'no purpose'}${k.given ? ' (the key that you gave)' : ''}`);
  const more = r.moreKeys > 0 ? `\n- and ${r.moreKeys} more` : '';
  return `\n\n**Keys that this version lists:**\n${rows.join('\n')}${more}`;
}

/** The answer of a check: the verdict, the facts of the version and of the state now, each check, the keys of the version, and the fixed sentence. */
function answerText(r: SignatureAtResult): string {
  const title = r.verdict === 'not_checked' ? 'NOT CHECKED' : r.verdict.toUpperCase();
  const gateway = !r.asked ? 'not asked: the time is too recent'
    : r.httpStatus === null ? 'no answer that the tool can read'
      : `HTTP ${r.httpStatus}, DID document: ${r.hasDocument ? 'yes' : 'no'}`;
  const tips = tipsText(r);
  const facts: Array<[string, string]> = [
    ['Result', `${title}. ${r.summary}`],
    ['DID', r.did],
    ['Time (the claim of the caller)', r.at],
    ['Purpose', r.purpose],
    ['Key', keyText(r)],
    ['Message', `${r.message.bytes} bytes, SHA-256 ${code(r.message.sha256)}`],
    ['Gateway answer', gateway],
    ...(tips === null ? [] : [['Ledger tips', tips] as [string, string]]),
    ['Version used', versionText(r)],
    ['Status in that version', statusText(r.statusAtTime)],
    ['Status now', nowText(r.now)],
  ];
  const md = `# Signature Check at a Time: ${title}\n\n${facts.map(([label, value]) => `**${label}:** ${value}`).join('\n')}\n\n${checkTable(r)}${keysSection(r)}\n\n${TIME_CLAIM_NOTE}`;
  return withJson(md, {
    verdict: r.verdict, valid: r.verdict === 'valid', reason: r.reason, summary: r.summary,
    did: r.did, at: r.at, purpose: r.purpose,
    key: { form: r.key.form, key_hash: r.key.keyHash, public_key: r.key.publicKey ?? r.listedPublicKey },
    message: r.message, asked: r.asked, http_status: r.httpStatus,
    tips: r.tips,
    version: r.version === null ? null : {
      version_id: r.version.versionId, next_version_id: r.version.nextVersionId, created: r.version.created, updated: r.version.updated, next_update: r.version.nextUpdate,
    },
    status_at_time: statusJson(r.statusAtTime),
    status_now: {
      effective: r.now.effective, effective_reason: r.now.effectiveReason, deactivated: r.now.deactivated, invalid_from: r.now.invalidFrom,
      details: statusJson(r.now.details), details_read: r.now.detailsRead,
    },
    listed_keys: r.listedKeys, more_keys: r.moreKeys,
    checks: r.checks,
    time_note: TIME_CLAIM_NOTE,
  });
}

/**
 * Registers vector_verify_signature_at. `access` is for the server and for tests: the gateway, the tip of the node and the clock. The rate
 * gate is the caller's.
 */
export function registerSignatureAtTool(server: McpServer, checkRateLimit: RateGate, access: SignatureAtAccess = {}) {
  server.tool(
    'vector_verify_signature_at',
    DESCRIPTION,
    INPUT_SCHEMA,
    async (args) => {
      const limited = checkRateLimit();
      if (limited) return limited;
      const parsed = parseSignatureAtInput(args);
      if (!parsed.ok) return text(refusedText(parsed.refusal));
      try {
        return text(answerText(await verifySignatureAt(parsed.request, access)));
      } catch (err) {
        return fail('check the signature', err, [
          'The identity gateway may be unreachable; retry in a minute',
          'vector_resolve_did { did, versionTime } shows the resolution result that this check reads',
        ]);
      }
    },
  );
}
