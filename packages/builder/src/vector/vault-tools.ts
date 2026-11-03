// packages/builder/src/vector/vault-tools.ts
// The vault tools (Part 2 Sections 5.3 and 10): open, pay and close. A vault holds AP3X that the delegate of a delegation may spend on
// identity-marketplace escrows within the delegation's value limit; escrow refunds come back to the vault for the owner. Each tool
// takes a wallet address and returns the unsigned transaction with every key hash that must sign it. Nothing here signs or submits.
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '@lucid-evolution/lucid';
import { lovelaceToAda, apexToLovelace } from '@apexfusion/vector-mcp-shared/tx';
import { lucidForAddress } from './build.js';
import { text, fail, cell, isoOrRaw } from './marketplace-shared.js';
import type { RateGate } from './marketplace-shared.js';
import { requireIdentityDeployment } from './identity-deployment.js';
import type { DeploymentFor } from './identity-tools.js';
import { identifierOf } from './identity-chain.js';
import { utf8Hex } from './identity-codec.js';
import { buildVaultOpen, buildVaultPay, buildVaultClose, ownerText } from './vault-build.js';
import type { VaultOwnerInput } from './vault-build.js';
import { paymentKeyHashOf } from './marketplace-build.js';
import { zChangeAddress, zDid, zKeyHash, zValidMinutes, buildText } from './identity-shared.js';

const zDelegationId = z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters').describe('The delegation: its token name, 64 hex characters (vector_build_delegation_delegate returns it)');
const zVaultRef = (what: string) => z.string().describe(`${what}: '<txid>#<index>'`);

export function registerVaultTools(server: McpServer, checkRateLimit: RateGate, providerFor: () => Provider, deploymentFor: DeploymentFor = requireIdentityDeployment) {
  server.tool(
    'vector_build_vault_open',
    "Build an UNSIGNED transaction that opens a vault: AP3X that the delegate of a delegation may spend on identity-marketplace escrows (vector_build_vault_pay), within the delegation's value limit. The owner must be the delegation's delegator: your wallet key by default, another principal key, or an agent. The delegation must have a value limit and cover the action marketplace.hire.v1 on the escrow script. Escrow refunds return to the vault for the owner, and only the owner can close it (vector_build_vault_close). Only the wallet signs. Takes no key material.",
    {
      changeAddress: zChangeAddress,
      delegation: zDelegationId,
      amount: z.number().positive().describe('AP3X the vault locks (at least the ledger minimum of the vault output, about 1.3 AP3X)'),
      owner_did: zDid('the agent that owns the vault (when the delegator is an agent)').optional(),
      owner_key_hash: zKeyHash('The principal key that owns the vault (default your wallet key)').optional(),
      owner_organisation: z.string().min(1).max(64).optional().describe("The owner's organisation (a DID or domain, never a person), as the delegation's delegator names it; default the delegation's"),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        if (a.owner_did !== undefined && a.owner_key_hash !== undefined) throw new Error('Give owner_did or owner_key_hash, not both.');
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, a.changeAddress);
        const owner: VaultOwnerInput | undefined = a.owner_did !== undefined ? { type: 'Agent', id: identifierOf(a.owner_did) }
          : a.owner_key_hash !== undefined || a.owner_organisation !== undefined
            ? { type: 'PrincipalKey', hash: a.owner_key_hash?.toLowerCase() ?? paymentKeyHashOf(a.changeAddress), organisation: a.owner_organisation === undefined ? undefined : utf8Hex(a.owner_organisation) }
            : undefined;
        const r = await buildVaultOpen({ lucid, provider, deployment }, {
          changeAddress: a.changeAddress, delegation: a.delegation.toLowerCase(), owner, amountLovelace: apexToLovelace(a.amount), validMinutes: a.valid_minutes,
        });
        const facts: Array<[string, string]> = [
          ['Vault (after submit)', `${r.vaultRef} at ${deployment.vault.address}, ${lovelaceToAda(r.amountLovelace)} AP3X`],
          ['Owner', cell(ownerText(r.owner), 160)],
          ['Delegation', r.delegation],
          ['Limit', `${lovelaceToAda(r.limit.perTx)} AP3X per payment, ${lovelaceToAda(r.limit.total)} AP3X per period of ${r.limit.periodMs} ms`],
        ];
        return text(buildText('Vault Opening Built', facts, r, { vault_ref: r.vaultRef, delegation: r.delegation, amount_lovelace: r.amountLovelace, per_tx: r.limit.perTx, total: r.limit.total, period_ms: r.limit.periodMs }));
      } catch (err) {
        return fail('build vault opening', err, [
          "The owner must be the delegation's delegator; the delegation needs a value limit and must cover marketplace.hire.v1 on the escrow script",
          'The wallet needs the amount plus about 1 AP3X for the fee',
        ]);
      }
    },
  );

  server.tool(
    'vector_build_vault_pay',
    "Build an UNSIGNED transaction in which the delegate of a vault's delegation hires an identity-marketplace advert from the vault: it pays one escrow (output 0; its escrow_ref is <txHash>#0) whose buyer is the delegate key and whose refunds go back to the vault for the owner, and keeps the rest in the vault (output 1). The delegation must pass its use checks (Part 2 Section 5.2: Active delegate, delegate key still listed, period, action marketplace.hire.v1 on the escrow script) and its value limit (per payment, per period). The advert must be listed. The delegate key signs. After it confirms, send the job with vector_marketplace_send_job using the escrow_ref and a buyerAddress whose key is the delegate key. Takes no key material.",
    {
      changeAddress: z.string().describe("The delegate's wallet address: it pays the fee and gives the collateral. When its payment key is the delegate key, it also funds part of the transaction, which vector_marketplace_send_job checks"),
      vault_ref: zVaultRef('The Live vault output that pays'),
      advert_ref: z.string().describe("The identity-marketplace advert '<txid>#<index>' to hire (vector_marketplace_list_suppliers shows its agent DID)"),
      payload: z.string().min(1).describe('The job payload exactly as you will send it'),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, a.changeAddress);
        const r = await buildVaultPay({ lucid, provider, deployment }, { changeAddress: a.changeAddress, vaultRef: a.vault_ref, advertRef: a.advert_ref, payload: a.payload, validMinutes: a.valid_minutes });
        const facts: Array<[string, string]> = [
          ['Escrow ref (after submit)', `\`${r.escrowRef}\``],
          ['Agent', `${r.did} (the advert's agent)`],
          ['Escrow', `${lovelaceToAda(r.amountLovelace)} AP3X = price ${lovelaceToAda(r.priceLovelace)} + supplier bond ${lovelaceToAda(r.supplierBondLovelace)} + buyer bond ${lovelaceToAda(r.buyerBondLovelace)}; refunds go back to the vault for the owner`],
          ['Deliver by', isoOrRaw(r.deliverBy)],
          ['Vault keeps', `${lovelaceToAda(r.vaultLovelace)} AP3X at ${r.vaultRef}; spent ${lovelaceToAda(r.spent)} of ${lovelaceToAda(r.limit.total)} AP3X this period${r.newPeriod ? ' (a new period starts)' : ''}`],
          ['Payload hash', `\`${r.promptHash}\``],
        ];
        return text(buildText('Vault Payment Built', facts, r, {
          escrow_ref: r.escrowRef, vault_ref: r.vaultRef, did: r.did, agent_id: r.agentId, amount_lovelace: r.amountLovelace, vault_lovelace: r.vaultLovelace,
          spent: r.spent, period_start: r.periodStart, new_period: r.newPeriod, deliver_by: r.deliverBy, prompt_hash: r.promptHash, payload: a.payload, delegate_key: r.delegateKey,
        }));
      } catch (err) {
        return fail('build vault payment', err, [
          "The delegation must still be usable: its delegate Active and still listing the delegate key, its period running, and the payment within per_tx and the period's total",
          'The advert must be an identity-marketplace advert listed by the indexer (vector_marketplace_list_suppliers)',
          'The wallet needs about 1 AP3X for the fee and one pure output of at least 5 AP3X as collateral',
        ]);
      }
    },
  );

  server.tool(
    'vector_build_vault_close',
    'Build an UNSIGNED transaction that closes vault outputs, Live or Returned (escrow refunds), also after the delegation has ended: everything they hold goes to your wallet. The owner of each signs: the principal key, or for an agent owner its controller key (the agent\'s record is read as a reference input). Takes no key material.',
    {
      changeAddress: zChangeAddress,
      vault_refs: z.array(zVaultRef('A vault output to close')).min(1).max(16).describe('The vault outputs to close (Live or Returned)'),
      valid_minutes: zValidMinutes,
    },
    async (a) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const deployment = deploymentFor();
        const provider = providerFor();
        const lucid = await lucidForAddress(provider, a.changeAddress);
        const r = await buildVaultClose({ lucid, provider, deployment }, { changeAddress: a.changeAddress, vaultRefs: a.vault_refs, validMinutes: a.valid_minutes });
        const facts: Array<[string, string]> = [
          ['Closing', r.vaults.map((v) => `${v.ref} (${v.vault.type}, ${lovelaceToAda(v.lovelace)} AP3X, owner ${cell(ownerText(v.vault.owner), 120)})`).join('; ')],
          ['To your wallet', `${lovelaceToAda(r.totalLovelace)} AP3X, less the fee`],
        ];
        return text(buildText('Vault Close Built', facts, r, { vaults: r.vaults.map((v) => ({ vault_ref: v.ref, kind: v.vault.type, lovelace: v.lovelace })), total_lovelace: r.totalLovelace }));
      } catch (err) {
        return fail('build vault close', err, [
          "Only the owner can close a vault: its principal key, or the agent owner's controller key",
          'The wallet needs about 1 AP3X for the fee and one pure output of at least 5 AP3X as collateral',
        ]);
      }
    },
  );
}
