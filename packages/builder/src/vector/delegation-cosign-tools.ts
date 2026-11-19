// packages/builder/src/vector/delegation-cosign-tools.ts
// vector_delegation_request_cosign (Part 2 Section 5.2): asks the delegate agent of a Delegate transaction for its co-signature. The tool
// takes the transaction and nothing else. It reads the delegate from the transaction, finds the endpoint in the identity record of the
// delegate, and sends there through safeFetch (delegation-cosign.ts has the route and every check). The result is the transaction that
// the caller gave, with the one witness of the delegate key added. The tool holds no key, adds no signature of its own, and submits
// nothing. The node comes from `providerFor` and the deployment from `deploymentFor`, as for the other delegation tools, so a test can
// hand in its own.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { withJson } from './marketplace-indexer.js';
import { text, fail, cell, isoOrRaw } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { DeploymentFor } from './identity-tools.js';
import { didOf } from './identity-chain.js';
import { textOf } from './identity-codec.js';
import { MULTI_SIGN_COPY } from './identity-shared.js';
import { patternsOf } from './delegation-build.js';
import { AgentRefusal, CALLER_ORIGIN_LIMIT_PER_MINUTE, COSIGN_PATH, COSIGN_ROUTE_VERSION, MAX_COSIGN_TX_HEX, ORIGIN_LIMIT_PER_MINUTE, requestDelegationCosign } from './delegation-cosign.js';
import type { CosignAccess, CosignResult } from './delegation-cosign.js';

/** What to do after each refusal code of the route. */
const CODE_TIPS: Readonly<Record<string, string>> = {
  not_a_delegation: 'Give the transaction that vector_build_delegation_delegate returned (unsigned, or signed by the delegator), not another transaction',
  not_for_this_agent: 'The agent signs only for a delegation that names it and one of its own delegation keys: check the delegate and delegate_key of the build',
  key_in_use: 'The delegate key is in use: build again with another delegation key that the delegate lists, or ask again with the same transaction (the route gives the same answer for the same transaction). Only the delegator of a live delegation that uses the key, or the delegator of one of its ancestors, can end it (vector_build_delegation_undelegate)',
  principal_not_allowed: 'The agent accepts delegations only from the principals that its operator allows: ask the operator, or use another delegator',
  spends_agent_funds: 'The transaction spends funds of the agent: build it again with a wallet that is yours (changeAddress)',
  expired: 'The validity window of the transaction has ended: build the transaction again',
};
const ROUTE_TIP = `The delegate agent must serve POST ${COSIGN_PATH} (route contract, version ${COSIGN_ROUTE_VERSION}); ask its operator when it does not`;
const RECORD_TIP = 'vector_get_agent_profile { agent_id } shows the record of the delegate, with its status, its keys and its endpoint';
const TX_TIP = 'Give txCbor exactly as vector_build_delegation_delegate returned it, or the same transaction signed by the delegator, before its validity window ends';

const DESCRIPTION =
  'Ask the delegate agent of a Delegate transaction for its co-signature. A Delegate transaction needs a signature of the delegate key (Part 2 Section 5.2), and only the delegate agent holds that key. ' +
  'Give txCbor: the unsigned transaction that vector_build_delegation_delegate returned, or the same transaction signed by the delegator. ' +
  'The tool reads the delegate from the transaction, finds the endpoint in the identity record of the delegate, and sends the transaction to ' +
  `POST <origin of the endpoint>${COSIGN_PATH} (route contract, version ${COSIGN_ROUTE_VERSION}). ` +
  'The request has the content type application/json and the body {"transaction": "<hex CBOR>"}. The answer is 200 {"transaction": "<hex CBOR>"}: the same body, every witness that was sent, and one more vkey witness, of the delegate key. ' +
  'A refusal is a 4xx {"error": "<code>", "message": "<words>"} with one of the codes not_a_delegation, not_for_this_agent, key_in_use, principal_not_allowed, spends_agent_funds and expired. ' +
  'An agent must serve this route for the tool to work. ' +
  'What the agent learns: it gets the whole transaction before it is submitted, so it sees the inputs, the outputs with the change address, the witnesses, and the public keys of the key holders that signed before the call. ' +
  'The tool sends only to the endpoint in the record (https, no redirect, a size limit, a time limit, a user agent with the server version), never to an address that the caller gives. ' +
  `It sends at most ${CALLER_ORIGIN_LIMIT_PER_MINUTE} requests a minute for each caller to one host, and at most ${ORIGIN_LIMIT_PER_MINUTE} a minute to one host for all callers together. ` +
  'Before it sends, the tool refuses what it can check without running the scripts. The node checks everything, and runs the scripts, when you submit. ' +
  'Some of these refusals follow a rule of the ledger or of the delegation contract: the transaction must be marked valid (is_valid true), must mint one delegation token, and must have one delegation output with a valid datum; each witness must verify; its validity window must be open and at most one hour long; every input and reference input must be on the node, and none both spent and read; and the delegate must be Active over the window and list the delegate key with the delegation purpose. ' +
  'Other refusals are the scope of this tool, not rules of the ledger: they bound what an agent is asked to sign. The tool refuses a second minted policy, a withdrawal, certificate, vote, proposal, donation or treasury value (also when it is empty or 0), a witness of the delegate key that the transaction already has, and a period of 2^53 ms or more. ' +
  'It takes one thing from the answer: the vkey witness of the delegate key, when the answer has the same body hash and the signature verifies over it by the rules of the ledger. ' +
  'The result is your transaction with that witness added: only the list of vkey witnesses is written again, and every other part keeps its bytes. It also gives the signers that are still missing, with the validity window. The agent cannot change anything else, and its words are never shown: a refusal shows only its code, in the tool\'s own words, when it is one of the six codes (any other code shows as "the agent refused"). ' +
  'The tool holds no key, adds no signature of its own, and submits nothing: the other key holders sign with vector_signer_sign, then the transaction is submitted. ' +
  'For operators of agents: the route is public, so the agent decides alone and the checks of the tool give it no assurance. The agent signs only when it decodes the transaction itself and finds that the only action is the Delegate ' +
  '(one delegation token minted, is_valid true, no withdrawal, certificate, vote or proposal), that no input and no collateral is at an address of a key of the agent, and that the datum names this agent and one of its own delegation keys. ' +
  'It never signs anything else with a delegation key. The contract does not enforce fresh keys, so the agent remembers each body that it co-signed: it refuses another body for the same key while the window of the first is open (key_in_use), and it gives the same answer for the same body again. ' +
  'It keeps the body bytes as it received them and adds only its vkey witness. spends_agent_funds means any input, collateral, withdrawal or certificate of a key of the agent. Other codes are allowed.';

/** The delegation of the transaction, in the words of vector_build_delegation_delegate. */
function delegationFacts(r: CosignResult): Array<[string, string]> {
  const d = r.delegation;
  const who = d.delegator.type === 'PrincipalKey'
    ? `principal key ${d.delegator.hash}${d.delegator.organisation === null ? '' : ` for ${cell(textOf(d.delegator.organisation) ?? d.delegator.organisation, 64)}`}`
    : didOf(d.delegator.id);
  const facts: Array<[string, string]> = [
    ['Delegation', r.id],
    ['Delegator', who],
    ['Delegate', `${r.agent.did}, delegate key ${d.delegateKey}`],
    ['Actions', patternsOf(d.actions).map((p) => cell(p, 120)).join(', ')],
    ['Resources', d.resources.length === 0 ? 'none (covers no resource)' : patternsOf(d.resources).map((p) => cell(p, 120)).join(', ')],
    ['Period', `${isoOrRaw(d.notBefore)} to ${isoOrRaw(d.notAfter)}`],
  ];
  if (d.value !== null) facts.push(['Value limit', `${lovelaceToAda(d.value.perTx)} AP3X per payment, ${lovelaceToAda(d.value.total)} AP3X per period of ${d.value.periodMs} ms`]);
  return facts;
}

const SUBMIT_NOW = 'Every key that the transaction needs has signed. Broadcast it with vector_submit_transaction { signedTxCbor }, then confirm with vector_await_transaction { txHash }.';

/** The answer of a good call: the facts, the window, who has signed, who is missing, the transaction, the next step, and a JSON block. */
function resultText(r: CosignResult): string {
  const rows = (keys: CosignResult['required']) => keys.map((s) => `| \`${s.keyHash}\` | ${s.roles.map((role) => cell(role, 120)).join('; ')} |`).join('\n');
  const done = r.missing.length === 0;
  const lines = delegationFacts(r).map(([label, value]) => `**${label}:** ${value}`);
  lines.push(`**Co-signed by:** ${r.agent.did} with its delegate key ${r.coSigner.keyHash} (answered at ${r.agent.origin})`);
  lines.push(`**Valid:** ${isoOrRaw(r.validFrom)} to ${isoOrRaw(r.validTo)} (every signature and the submit must happen before the end)`);
  const missing = done
    ? '**Still missing:** none of the keys that the transaction names.'
    : `**Still missing** (${r.missing.length}):\n\n| key hash | signs as |\n|---|---|\n${rows(r.missing)}`;
  const md = `# Delegation Co-Signed (Not Submitted)\n\n${lines.join('\n')}\n**Signed so far** (${r.signed.length}): ${r.signed.map((k) => `\`${k}\``).join(', ')}\n\n${missing}\n\n` +
    `**Co-signed TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${done ? SUBMIT_NOW : MULTI_SIGN_COPY}`;
  return withJson(md, {
    delegation: r.id, delegate_did: r.agent.did, delegate_key_hash: r.delegation.delegateKey, agent_origin: r.agent.origin,
    co_signed_by: { key_hash: r.coSigner.keyHash, public_key: r.coSigner.publicKey }, tx_hash: r.txHash, valid_from: r.validFrom, valid_to: r.validTo,
    signed_by: r.signed, required_signers: r.required.map((s) => ({ key_hash: s.keyHash, roles: s.roles })),
    missing_signers: r.missing.map((s) => ({ key_hash: s.keyHash, roles: s.roles })), all_signers_present: done,
  });
}

/** `identity` is the caller, for the limit for each caller and origin. `access` is for tests: the fetch of the call to the agent, the host lookup, the clock and the limits. */
export function registerDelegationCosignTool(server: McpServer, identity: string, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: DeploymentFor = requireIdentityDeployment, access: CosignAccess = {}) {
  server.tool(
    'vector_delegation_request_cosign',
    DESCRIPTION,
    {
      txCbor: z.string().max(MAX_COSIGN_TX_HEX).regex(/^[0-9a-fA-F]+$/, 'expected the hex CBOR of a transaction')
        .describe(`The Delegate transaction as hex CBOR: the unsigned transaction that vector_build_delegation_delegate returned, or the same transaction signed by the delegator (at most ${MAX_COSIGN_TX_HEX} hex characters). The tool reads the delegate from it; there is no other input`),
    },
    async ({ txCbor }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const r = await requestDelegationCosign({ provider: providerFor(), deployment: deploymentFor(), caller: identity }, txCbor, access);
        return text(resultText(r));
      } catch (err) {
        const tips = err instanceof AgentRefusal && err.known && err.code !== null ? [CODE_TIPS[err.code]] : [TX_TIP, ROUTE_TIP, RECORD_TIP];
        return fail('request a delegation co-signature', err, tips);
      }
    },
  );
}
