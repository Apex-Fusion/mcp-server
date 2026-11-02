// packages/builder/src/vector/attestation-tools.ts
// The attestation tools (Part 2 Sections 4 and 10): keyless builders of attest, revoke, contest and withdraw. Each takes a wallet
// address and the action's inputs, and returns the unsigned transaction with every key hash that must sign it. Nothing here signs or
// submits. The node comes from `providerFor` and the deployment from `deploymentFor` (the server's environment), so a test can hand
// in its own.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda, apexToLovelace } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { text, fail, cell, isoOrRaw } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import type { DeploymentFor } from './identity-tools.js';
import { didOf, identifierOf } from './identity-chain.js';
import { textOf, utf8Hex } from './identity-codec.js';
import { keyHashOf } from './identity-rules.js';
import { zChangeAddress, zDid, zValidMinutes, zPublicKey, zTime, buildText } from './identity-shared.js';
import {
  ATT_TYPES, ATT_TYPE_NAMES, LINK_RELS, LINK_REL_NAMES, SALTED_DIGEST_RULE, SALTED_TYPES, attTypeName, didKeyOf, linkRelName, withdrawableFrom,
  buildAttest, buildContestAttestation, buildRevokeAttestation, buildWithdrawAttestation,
} from './attestation-build.js';
import type { AttTypeName, AttestationSpendBuild, LinkRelName } from './attestation-build.js';

const zHex32 = (what: string) => z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters').describe(what);
const zAttestation = zHex32('The attestation: its identifier (the token name, 64 hex) that the attest build returned');
const zBy = z.enum(['issuer', 'controller']).optional()
  .describe("Who signs for the issuer of a registered issuer's attestation: 'issuer' (the issuer key, while the issuer record lists it with the assertion purpose) or 'controller' (the controller of the issuer record). Default: the issuer key while it is listed, else the controller. Without an issuer record only the issuer key can sign.");

const FUNDS_TIP = 'The wallet needs about 1 AP3X for the fee and one pure AP3X output of at least 5 AP3X as collateral';
const PROFILE_TIP = 'vector_get_agent_profile { agent_id } shows a record, its controller and its keys with their purposes';

/** The facts that every revoke or contest shows. */
function keptFacts(r: AttestationSpendBuild, deployment: IdentityDeployment): Array<[string, string]> {
  return [
    ['Attestation', r.id],
    ['Subject', didOf(r.attestation.subject)],
    ['Action', `${r.action}: ${cell(r.summary, 400)}`],
    ['Attestation output', `#${r.outputIndex} at ${deployment.attestation.address}, ${lovelaceToAda(r.outputLovelace)} AP3X`],
  ];
}

export function registerAttestationTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: DeploymentFor = requireIdentityDeployment) {
  server.tool(
    'vector_build_attestation_attest',
    'Build an UNSIGNED transaction that issues an attestation about a registered agent (Part 2 Section 4): a claim by an issuer key about the subject, anchored by the SHA-256 digest of a document. ' +
      'It mints the attestation token named from a seed output of your wallet (the identifier is known before you sign) and locks a deposit of at least 5 AP3X; the issuer takes it back by withdrawal. ' +
      "The issuer key always signs. With issuer_did the issuer is a registered agent: its record must be Active and list the issuer key with the assertion purpose. With solicited the subject's controller co-signs. " +
      'Every answer gives the COSE Sig_structure for its issued_at: to add an envelope signature, the issuer signs those bytes with its Ed25519 key and builds again with the same issued_at and envelope_sig. ' +
      `${SALTED_DIGEST_RULE} Takes no key material.`,
    {
      changeAddress: zChangeAddress,
      subject: zDid('the agent that the attestation is about (its record can be live or ended)'),
      issuer: zPublicKey('The issuer key: it signs the attestation and its envelope'),
      issuer_did: zDid('the issuer, when the issuer is a registered agent (its record must be Active and list the issuer key with the assertion purpose)').optional(),
      att_type: z.enum(ATT_TYPE_NAMES as [AttTypeName, ...AttTypeName[]])
        .describe('The type: identity (0), provenance (1), software (2), environment (3), principal_binding (4), approval (5) or other (15). Software and environment need valid_until.'),
      digest: zHex32(`The SHA-256 of the document (64 hex). ${SALTED_DIGEST_RULE}`),
      format: z.number().int().min(0).max(65_535).optional().describe('The CoAP Content-Format number of the document, e.g. 50 for application/json (default: unspecified)'),
      profile: zHex32('The hash of the profile or type URI of the document (64 hex)').optional(),
      locator: z.string().min(1).optional().describe('Where the document can be fetched, e.g. an https URL: 1 to 256 bytes of UTF-8 (default: none)'),
      valid_from: zTime('When the claim starts to hold (default: unspecified); at or before valid_until').optional(),
      valid_until: zTime('When the claim stops holding: at or after issued_at and at most 366 days after it. Required for software and environment').optional(),
      solicited: z.boolean().optional().describe("true when the subject asked for the attestation: the subject's controller co-signs (default false)"),
      links: z.array(z.object({
        rel: z.enum(LINK_REL_NAMES as [LinkRelName, ...LinkRelName[]]).describe('supersedes, depends_on, corroborates or disputes'),
        target: zHex32('The identifier of the other attestation (64 hex)'),
      })).max(4).optional().describe('Up to 4 links to other attestations. To correct an attestation, issue a new one that supersedes it, then revoke the old one.'),
      deposit: z.number().min(5).optional().describe('AP3X that the attestation locks (default 5, the minimum; more when the ledger minimum of the output is higher)'),
      issued_at: zTime('Fixes issued_at, which is the end of the validity window: a whole second (a multiple of 1000) within the coming hour. Pass the issued_at of an earlier build to add its envelope signature. valid_minutes has no effect then').optional(),
      envelope_sig: z.string().regex(/^[0-9a-fA-F]{128}$/, 'expected 128 hex characters').optional()
        .describe("The issuer's Ed25519 signature (64 bytes, 128 hex) over the sig_structure of an earlier build. Needs that build's issued_at; the builder checks the signature"),
      valid_minutes: zValidMinutes,
    },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const issuerId = args.issuer_did === undefined ? undefined : identifierOf(args.issuer_did);
        const r = await buildAttest({ lucid, provider, deployment }, {
          changeAddress: args.changeAddress, subject: identifierOf(args.subject), issuer: args.issuer, issuerId, attType: ATT_TYPES[args.att_type],
          digest: args.digest, format: args.format, profile: args.profile, locator: args.locator === undefined ? undefined : utf8Hex(args.locator),
          validFrom: args.valid_from, validUntil: args.valid_until, solicited: args.solicited,
          links: args.links?.map((l) => ({ rel: LINK_RELS[l.rel], target: l.target.toLowerCase() })),
          depositLovelace: args.deposit === undefined ? undefined : apexToLovelace(args.deposit),
          issuedAt: args.issued_at, envelopeSig: args.envelope_sig, validMinutes: args.valid_minutes,
        });
        const a = r.attestation;
        const issuerHash = keyHashOf(a.issuer);
        const facts: Array<[string, string]> = [
          ['Attestation', `${r.id} (from the seed ${r.seed}: if that output is spent first, build again for a new identifier)`],
          ['Subject', didOf(a.subject)],
          ['Issuer', a.issuerId === null ? `unregistered key ${issuerHash} (${didKeyOf(a.issuer)})` : `${didOf(a.issuerId)}, key ${issuerHash}`],
          ['Type', `${attTypeName(a.attType)} (${a.attType})${a.solicited ? ', solicited by the subject' : ''}`],
          ['Digest', a.digest],
          ['Valid', `${a.validFrom === null ? 'from issue' : isoOrRaw(a.validFrom)} to ${a.validUntil === null ? 'no end date' : isoOrRaw(a.validUntil)}`],
        ];
        if (a.locator !== null) facts.push(['Locator', cell(textOf(a.locator) ?? a.locator, 256)]);
        if (a.links.length > 0) facts.push(['Links', a.links.map((l) => `${linkRelName(l.rel)} ${l.target}`).join(', ')]);
        facts.push(
          ['Attestation output', `#${r.outputIndex} at ${deployment.attestation.address}, deposit ${lovelaceToAda(r.depositLovelace)} AP3X`],
          ['Issued at', `${isoOrRaw(r.issuedAt)} (${r.issuedAt}): the end of the validity window`],
          ['Envelope', a.envelopeSig === null ? 'none' : 'signed: envelope_sig verifies over the Sig_structure below'],
        );
        const note = `**Envelope Sig_structure** (COSE, Part 2 Section 4.2) for issued_at ${r.issuedAt}:\n\`\`\`\n${r.sigStructure}\n\`\`\`\n` +
          (a.envelopeSig === null
            ? `To add an envelope signature, the issuer signs these bytes with its Ed25519 key, then builds again with issued_at ${r.issuedAt} and envelope_sig (128 hex) before ${isoOrRaw(r.issuedAt)}. Without one, sign and submit this transaction as it is.`
            : 'The attestation carries this envelope signature.') +
          (SALTED_TYPES.includes(a.attType) ? `\n\n${SALTED_DIGEST_RULE}` : '');
        return text(buildText('Attestation Built', facts, r, {
          attestation: r.id, seed: r.seed, subject_did: didOf(a.subject), issuer_key_hash: issuerHash, issuer_did: a.issuerId === null ? null : didOf(a.issuerId),
          att_type: attTypeName(a.attType), att_type_code: a.attType, issued_at: r.issuedAt, attestation_output_index: r.outputIndex,
          deposit_lovelace: r.depositLovelace, sig_structure: r.sigStructure, envelope_signed: a.envelopeSig !== null,
        }, note));
      } catch (err) {
        return fail('build attestation', err, [
          PROFILE_TIP,
          'A registered issuer must be Active and list the issuer key with the assertion purpose; an unregistered issuer leaves out issuer_did',
          'The wallet needs the deposit (5 AP3X) plus about 1 AP3X for the fee, and one pure AP3X output of at least 5 AP3X as collateral',
        ]);
      }
    },
  );

  server.tool(
    'vector_build_attestation_revoke',
    'Build an UNSIGNED transaction that revokes an active attestation (Part 2 Section 4.1): its status becomes revoked at the start of the validity window with the reason code; nothing else changes. ' +
      'The issuer key signs, or for a registered issuer the controller of its record (by). Ninety days later the issuer can withdraw the deposit. Takes no key material.',
    {
      changeAddress: zChangeAddress,
      attestation: zAttestation,
      reason: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
        .describe('The reason code (default 0, unspecified). Common codes: 1 keyCompromise, 3 affiliationChanged, 4 superseded, 5 cessationOfOperation, 9 privilegeWithdrawn. The contract takes any whole number'),
      by: zBy,
      valid_minutes: zValidMinutes,
    },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const r = await buildRevokeAttestation({ lucid, provider, deployment }, {
          changeAddress: args.changeAddress, id: args.attestation.toLowerCase(), reason: args.reason ?? 0, by: args.by, validMinutes: args.valid_minutes,
        });
        const status = r.attestation.status;
        const revokedAt = status.type === 'AttRevoked' ? status.at : r.validFrom;
        return text(buildText('Attestation Revocation Built', keptFacts(r, deployment), r, {
          attestation: r.id, action: r.action, revoked_at: revokedAt, reason: args.reason ?? 0, withdrawable_from: withdrawableFrom(r.attestation),
          attestation_output_index: r.outputIndex, attestation_lovelace: r.outputLovelace,
        }));
      } catch (err) {
        return fail('build attestation revocation', err, [PROFILE_TIP, FUNDS_TIP]);
      }
    },
  );

  server.tool(
    'vector_build_attestation_contest',
    "Build an UNSIGNED transaction in which the subject of an attestation publishes its reply (Part 2 Section 4.1): the attestation's contested field points to the reply (a URI and its SHA-256), and a later reply replaces an earlier one. " +
      "It works on active, revoked and already contested attestations. The subject's controller signs. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      attestation: zAttestation,
      uri: z.string().min(1).describe("Where the subject's reply is, e.g. an https URL: 1 to 256 bytes of UTF-8"),
      sha256: zHex32('The SHA-256 of the reply (64 hex)'),
      valid_minutes: zValidMinutes,
    },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const r = await buildContestAttestation({ lucid, provider, deployment }, {
          changeAddress: args.changeAddress, id: args.attestation.toLowerCase(), anchor: { uri: utf8Hex(args.uri), sha256: args.sha256 }, validMinutes: args.valid_minutes,
        });
        const facts = [...keptFacts(r, deployment), ['Reply', `${cell(args.uri, 256)} (SHA-256 ${args.sha256.toLowerCase()})`] as [string, string]];
        return text(buildText('Attestation Contest Built', facts, r, {
          attestation: r.id, action: r.action, contested_uri: args.uri, contested_sha256: args.sha256.toLowerCase(),
          attestation_output_index: r.outputIndex, attestation_lovelace: r.outputLovelace,
        }));
      } catch (err) {
        return fail('build attestation contest', err, [PROFILE_TIP, FUNDS_TIP]);
      }
    },
  );

  server.tool(
    'vector_build_attestation_withdraw',
    'Build an UNSIGNED transaction that withdraws an attestation (Part 2 Section 4.1): it burns the attestation token and returns the deposit to your wallet. ' +
      'This is possible 90 days after the revocation, or 90 days after valid_until; before then the tool names the date. The issuer key signs, or for a registered issuer the controller of its record (by). Takes no key material.',
    { changeAddress: zChangeAddress, attestation: zAttestation, by: zBy, valid_minutes: zValidMinutes },
    async (args) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, args.changeAddress);
        const r = await buildWithdrawAttestation({ lucid, provider, deployment }, {
          changeAddress: args.changeAddress, id: args.attestation.toLowerCase(), by: args.by, validMinutes: args.valid_minutes,
        });
        const facts: Array<[string, string]> = [
          ['Attestation', r.id],
          ['Subject', didOf(r.attestation.subject)],
          ['Action', `Withdraw with Burn of the attestation token, signed by ${cell(r.authority, 200)}`],
          ['Released', `${lovelaceToAda(r.releasedLovelace)} AP3X return to the wallet (less the fee); withdrawable since ${isoOrRaw(r.withdrawableFrom)}`],
        ];
        return text(buildText('Attestation Withdrawal Built', facts, r, {
          attestation: r.id, action: 'Withdraw', released_lovelace: r.releasedLovelace, withdrawable_from: r.withdrawableFrom,
        }));
      } catch (err) {
        return fail('build attestation withdrawal', err, [
          'An active attestation without valid_until must be revoked first (vector_build_attestation_revoke); withdrawal follows 90 days later',
          FUNDS_TIP,
        ]);
      }
    },
  );
}
