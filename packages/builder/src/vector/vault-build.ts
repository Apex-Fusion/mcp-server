// packages/builder/src/vector/vault-build.ts
// Keyless builders of the vault (Part 2 Section 5.3; contracts vault/handlers.ak): open a vault for a delegation, pay identity-
// marketplace escrows from it as the delegate (Pay), and close vaults as the owner (Close). A vault output is AP3X only with the datum
// Live { owner, delegation, spent, period_start } or Returned { owner } (an escrow refund). Each builder checks the rules it can check
// before it builds, so that a refusal names the rule and says who refuses: a rule that the vault contract enforces ends with the sentence
// that the chain refuses the same transaction, and a rule of the builder alone says that the builder refuses. The vault script then runs on
// the build (local evaluation of the applied script that the reference input holds). buildVaultPay can also let the node judge the
// payment (`ledgerDecides`): the builder then makes no refusal for a rule of the ledger, the node evaluates the scripts, and a refusal
// comes back as a typed error. Nothing is signed or submitted.
import { calculateMinLovelaceFromUTxO, makeTxBuilder } from '@lucid-evolution/lucid';
import { addressDetails } from './guarded-decode.js';
import type { LucidConfig, LucidEvolution, Provider, TxBuilder, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { OgmiosRpcError } from '@apexfusion/vector-mcp-shared/provider';
import { encodeVaultDatum, encodeVaultSpend, decodeVaultDatum, plutusAddressFromBech32, sameDelegator } from './identity-codec.js';
import type { Delegator, ValueLimit, VaultDatum } from './identity-codec.js';
import { readRefScript } from './identity-deployment.js';
import type { IdentityDeployment } from './identity-deployment.js';
import {
  ap3xText, chainClock, chainRecords, chainRefuses, ChainGapError, delegationChain, delegationChainToGap, didOf, findDelegation, LEDGER_DECIDES_HINT, recordsById, requireRecord,
  signedByResult, uniqueUtxos, walletOf, windowAt, SignerList,
} from './identity-chain.js';
import type { ChainGap, DelegationUtxo, SignedByBuild, Window } from './identity-chain.js';
import type { BuildCommon, IdentityContext } from './identity-build.js';
import { HIRE_ACTION, delegationUseProblems, escrowResource, patternsCover, patternsOf } from './delegation-build.js';
import {
  assertIndexerLists, assertWalletIs, assertEscrowIsOutputZero, checkListingRule, fleetAdvertRefusal, paymentKeyHashOf, planVaultEscrow, readAdvertFromNode,
  readHireableAdvert, EscrowPlanRefusal,
} from './marketplace-build.js';
import type { EscrowPlanFault, PostEscrowPlan } from './marketplace-build.js';
import { formatOutRef, parseOutRef } from './marketplace-datum.js';
import type { IdentityAdvertDatum } from './marketplace-datum.js';

const VAULT_PAY = encodeVaultSpend({ type: 'Pay' });
const VAULT_CLOSE = encodeVaultSpend({ type: 'Close' });

/** The sentence that says that the vault contract refuses the same payment on chain, and by which rule of Pay. */
const vaultRefuses = (rule: string): string => chainRefuses('vault', 'Pay', rule, 'payment');

/** The text of an owner, for messages and facts. */
export const ownerText = (owner: Delegator): string =>
  (owner.type === 'Agent' ? `agent ${didOf(owner.id)}` : `principal key ${owner.hash}${owner.organisation === null ? '' : ` (organisation ${Buffer.from(owner.organisation, 'hex').toString('utf8')})`}`);

/** The ledger minimum of a vault output holding `datum` (the protocol parameters come from the node). */
function vaultMinimum(lucid: LucidEvolution, deployment: IdentityDeployment, datum: VaultDatum): bigint {
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error('The node did not give the protocol parameters, so the ledger minimum of the vault output is unknown.');
  return calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { txHash: '00'.repeat(32), outputIndex: 0, address: deployment.vault.address, assets: { lovelace: 0n }, datum: encodeVaultDatum(datum) });
}

/** A vault output on the node: an unspent output with the vault script's credential and a vault datum. */
interface VaultUtxo { ref: string; utxo: UTxO; vault: VaultDatum }
export async function readVault(ctx: IdentityContext, vaultRef: string): Promise<VaultUtxo> {
  const parsed = parseOutRef(vaultRef);
  const ref = formatOutRef(parsed.txHash, parsed.outputIndex);
  const [utxo] = await ctx.provider.getUtxosByOutRef([parsed]);
  if (!utxo) throw new Error(`Vault ${ref} is not an unspent output on the node: it has been spent or closed, or it is not confirmed yet.`);
  let credential: string | undefined;
  try { const c = addressDetails(utxo.address).paymentCredential; credential = c?.type === 'Script' ? c.hash : undefined; } catch { /* refused below */ }
  if (credential !== ctx.deployment.vault.hash) throw new Error(`UTxO ${ref} is not at the vault address.`);
  if (!utxo.datum) throw new Error(`Vault ${ref} has no inline datum.`);
  let vault: VaultDatum;
  try { vault = decodeVaultDatum(utxo.datum); } catch (err) { throw new Error(`Vault ${ref} does not hold a vault datum: ${err instanceof Error ? err.message : String(err)}`); }
  return { ref, utxo, vault };
}

// ─── Open ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The owner of a new vault: an agent, or a principal key whose organisation defaults to the delegation's when its key is the delegator's. */
export type VaultOwnerInput = { type: 'Agent'; id: string } | { type: 'PrincipalKey'; hash: string; /** UTF-8 bytes as hex. */ organisation?: string | null };

export interface VaultOpenParams extends BuildCommon {
  /** The token name of the delegation that the vault pays under. */
  delegation: string;
  /** Default: the wallet's key as a principal key. */
  owner?: VaultOwnerInput;
  /** The AP3X the vault locks; at least the ledger minimum of the vault output. */
  amountLovelace: bigint;
}

export interface VaultOpenBuild extends SignedByBuild {
  /** `<txHash>#<index>` of the new vault output after submit. */
  vaultRef: string;
  owner: Delegator; delegation: string; amountLovelace: bigint;
  /** The delegation's value limit, which every payment from the vault keeps to. */
  limit: ValueLimit;
}

/**
 * Builds the unsigned opening of a vault: one AP3X-only output at the vault address with the datum Live { owner, delegation,
 * spent: 0, period_start: 0 }. Refuses a delegation that does not exist (or was undelegated), whose delegator is not the owner, that
 * has no value limit, or that does not cover the action marketplace.hire.v1 on the resource script:<escrow hash> (Part 2 Section 5.1):
 * a vault for it could never pay. No script runs, so no collateral is needed; only the wallet signs.
 */
export async function buildVaultOpen(ctx: IdentityContext, p: VaultOpenParams): Promise<VaultOpenBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const walletKeyHash = paymentKeyHashOf(p.changeAddress);
  await assertWalletIs(lucid, p.changeAddress);
  const found = await findDelegation(provider, deployment, p.delegation);
  if (!found) throw new Error(`No live delegation ${p.delegation}: it does not exist or has been undelegated.`);
  const d = found.delegation;
  const given: VaultOwnerInput = p.owner ?? { type: 'PrincipalKey', hash: walletKeyHash };
  const owner: Delegator = given.type === 'Agent' ? given : {
    type: 'PrincipalKey', hash: given.hash.toLowerCase(),
    organisation: given.organisation !== undefined ? given.organisation : (d.delegator.type === 'PrincipalKey' && d.delegator.hash === given.hash.toLowerCase() ? d.delegator.organisation : null),
  };
  if (!sameDelegator(d.delegator, owner)) throw new Error(`The delegator of delegation ${p.delegation} is ${ownerText(d.delegator)}, not the owner ${ownerText(owner)}: a vault pays only under a delegation of its owner (Part 2 Section 5.3).`);
  if (d.value === null) throw new Error(`Delegation ${p.delegation} has no value limit, and a vault pays only under one (Part 2 Section 5.3).`);
  const resource = escrowResource(deployment.escrow.hash);
  if (!patternsCover(patternsOf(d.actions), HIRE_ACTION)) throw new Error(`Delegation ${p.delegation} does not cover the action ${HIRE_ACTION}, so a vault could never pay under it.`);
  if (!patternsCover(patternsOf(d.resources), resource)) throw new Error(`Delegation ${p.delegation} does not cover the resource ${resource} (the escrow script), so a vault could never pay under it.`);
  const datum: VaultDatum = { type: 'Live', owner, delegation: p.delegation, spent: 0n, periodStart: 0 };
  const minimum = vaultMinimum(lucid, deployment, datum);
  if (p.amountLovelace < minimum) throw new Error(`A vault output needs at least ${minimum} lovelace (the ledger minimum); ${p.amountLovelace} is less.`);
  const tx = lucid.newTx()
    .pay.ToAddressWithData(deployment.vault.address, { kind: 'inline', value: encodeVaultDatum(datum) }, { lovelace: p.amountLovelace })
    .validFrom(window.lo)
    .validTo(window.hi);
  const result = signedByResult(await tx.complete(), window, new SignerList(), walletKeyHash);
  return { ...result, vaultRef: formatOutRef(result.txHash, 0), owner, delegation: p.delegation, amountLovelace: p.amountLovelace, limit: d.value };
}

// ─── Pay ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VaultPayParams extends BuildCommon {
  /** The Live vault output that pays. */
  vaultRef: string;
  /** The identity-marketplace advert to hire. */
  advertRef: string;
  /** The job payload exactly as it will be sent. */
  payload: string;
  /**
   * Let the ledger decide whether the payment is valid. The builder then makes no refusal of its own for the per-transaction limit, the
   * period total, the use checks of the delegation, the delegator, the other assets of the vault, the value cap, the indexer listing and
   * the listing rule. It reads the advert from the node, and the node evaluates the scripts. The refusal of a fleet capability stays: it
   * throws VaultPayImpossible with the reason `advert_terms`. A payment that the vault script refuses throws VaultPayRefused, a payment
   * that the node did not evaluate throws VaultPayNotEvaluated, and a payment that cannot be built at all throws VaultPayImpossible.
   * Default false: the builder checks the rules first, and Lucid evaluates the scripts on this machine.
   */
  ledgerDecides?: boolean;
}

export interface VaultPayBuild extends SignedByBuild {
  /** `<txHash>#0`: the new escrow (output 0). */
  escrowRef: string;
  /** `<txHash>#1`: the continuing vault output. */
  vaultRef: string;
  /** What the escrow output holds: payment + both bonds, which is what the vault pays. */
  amountLovelace: bigint;
  /** What the vault keeps. */
  vaultLovelace: bigint;
  spent: bigint; periodStart: number; newPeriod: boolean;
  limit: ValueLimit;
  delegateKey: string; owner: Delegator; agentId: string; did: string;
  deliverBy: number; promptHash: string; priceLovelace: bigint; supplierBondLovelace: bigint; buyerBondLovelace: bigint;
}

/**
 * What the builder planned for a payment: the lock that leaves the vault, what the vault keeps, the period after it and the limit.
 * `missingParent` is set when the draft has no reference input for an ancestor delegation that has no output on the node.
 */
export type VaultPayAttempt = Pick<VaultPayBuild, 'amountLovelace' | 'vaultLovelace' | 'spent' | 'periodStart' | 'newPeriod' | 'limit'> & { missingParent?: ChainGap };

/** The facts without which buildVaultPay with `ledgerDecides` cannot build a payment at all, and the checks of the builder that stay. */
export type VaultPayImpossibleReason = 'no_vault' | 'vault_not_live' | 'no_delegation' | 'no_advert' | 'buyer_is_supplier' | 'advert_terms' | 'below_minimum';

/**
 * buildVaultPay with `ledgerDecides` cannot build the payment, whatever the ledger would say: a fact that the transaction needs is
 * missing, or a check of the builder that is no rule of the ledger fails. `reason` names it. `no_vault`: the vault output, or the vault
 * script that it needs, is not on the node. `vault_not_live`: the vault holds an escrow refund. `no_delegation`: the delegation output
 * of the vault, or a record that its use checks read, is not on the node, or the delegation has no value limit (a missing ANCESTOR is
 * no reason: the draft goes to the node without it). `no_advert`: the
 * advert output is not on the node, is no identity-marketplace advert, or is retired. `buyer_is_supplier`: the delegate key is the
 * supplier key of the advert. `advert_terms`: no escrow can be written for the terms of the advert (an amount that does not fit the
 * datum, a processing window that is unusable or above 24 h, an endpoint without a host), or the advert is of a fleet capability, which
 * a Post refuses as well. `below_minimum`: what the vault would keep is
 * below the ledger minimum of its output. The message says it in words. Nothing was sent to the node to evaluate.
 */
export class VaultPayImpossible extends Error {
  readonly reason: VaultPayImpossibleReason;
  constructor(reason: VaultPayImpossibleReason, message: string) {
    super(message);
    this.name = 'VaultPayImpossible';
    this.reason = reason;
  }
}

/**
 * buildVaultPay refuses a rule of the vault contract that the option `ledgerDecides` makes the builder skip: the other assets of the
 * vault, the delegator, the use checks of the delegation, per_tx and total. The message is the plain text of old. The type is the mark
 * of the refusal: a caller that tells how to skip the check (`vector_build_vault_pay`) reads the type, never the message, because a
 * message carries text from the chain, and a supplier writes some of it. See `skippedByLedgerDecides`.
 */
export class VaultRuleRefusal extends Error {}

/**
 * Does the option `ledgerDecides` make the builder skip the check that `err` refuses? True for a VaultRuleRefusal, for the value cap of
 * the escrow planner (an EscrowPlanRefusal with the fault `value_cap`) and for a gap in the delegation chain (a ChainGapError). It reads
 * the type and the fault, never the message. The other refusals stay with the option, so passing it does not change them.
 */
export const skippedByLedgerDecides = (err: unknown): boolean =>
  err instanceof VaultRuleRefusal || err instanceof ChainGapError || (err instanceof EscrowPlanRefusal && err.fault === 'value_cap');

/** The reason of the VaultPayImpossible for each refusal of the escrow planner that stays with `ledgerDecides` (the value cap is the ledger's). */
const PLAN_FAULT_REASON: Record<Exclude<EscrowPlanFault, 'value_cap'>, VaultPayImpossibleReason> = {
  advert_retired: 'no_advert', buyer_is_supplier: 'buyer_is_supplier', advert_terms: 'advert_terms',
};

/**
 * What one validator of the transaction answered when the node evaluated it: its purpose and its index in the transaction, and the code
 * and the message of its error. `detail` is the text that the node gives for the error: `data.validationError` of a validator that
 * failed, `data.reason` of an evaluation context that the node could not make. `traces` are the traces of the execution. They are null
 * when the node gave no list of texts (no list at all, or a list that holds more than texts): an empty list is the node saying "none",
 * and a caller must not read that from an answer that had no list.
 */
export interface ValidatorError { purpose: string; index: number; code: number; message: string; detail: string | null; traces: string[] | null }

/**
 * What buildVaultPay with `ledgerDecides` holds of the answer of the node, when the node answered the evaluation with an error
 * (VaultPayRefused and VaultPayNotEvaluated). `evaluationError` is the code and the message of the node, for example "3010 Some scripts
 * of the transactions terminated with error(s)." `validators` are the errors that the node gives for each validator. `draftTx` (hex CBOR)
 * is the transaction that the node was asked to evaluate: the payment as Lucid built it for the evaluation. Its fee is an estimate, its
 * redeemers have zero execution units, and its witness set holds the placeholder witnesses that Lucid adds to size the transaction (no
 * real key, no real signature). It has no collateral. It is no transaction to submit. `attempt` holds what the builder planned for the
 * payment, and `cause` is the OgmiosRpcError that the provider raised.
 */
export abstract class VaultPayEvaluationError extends Error {
  readonly evaluationError: string;
  readonly validators: ValidatorError[];
  readonly draftTx: string;
  readonly attempt: VaultPayAttempt;
  readonly cause: unknown;
  constructor(name: string, message: string, evaluationError: string, validators: ValidatorError[], draftTx: string, attempt: VaultPayAttempt, cause: unknown) {
    super(message);
    this.name = name;
    this.evaluationError = evaluationError;
    this.validators = validators;
    this.draftTx = draftTx;
    this.attempt = attempt;
    this.cause = cause;
  }
}

/**
 * buildVaultPay with `ledgerDecides`: the node refused the payment. It evaluated the scripts of the transaction, and at least one
 * validator ran and failed (the error 3012 of Ogmios in `validators`). It is the evidence of the refusal: asked again with the same
 * ledger state, the node refuses `draftTx` again.
 */
export class VaultPayRefused extends VaultPayEvaluationError {
  constructor(evaluationError: string, validators: ValidatorError[], draftTx: string, attempt: VaultPayAttempt, cause: unknown) {
    super('VaultPayRefused', `The node refused the payment of ${attempt.amountLovelace} lovelace from the vault: a validator of the transaction failed (${evaluationError}). The draft transaction that the node evaluated is in draftTx.`, evaluationError, validators, draftTx, attempt, cause);
  }
}

/**
 * buildVaultPay with `ledgerDecides`: the node answered the evaluation, and the builder read no failed validator in the answer. Mostly
 * the scripts were not evaluated, so this is no refusal by the ledger and no evidence of one. It is no failure to reach the node either:
 * the node answered, and its answer is in `evaluationError` and `validators`. Examples: a validity range that ends beyond the end of the
 * era that the node can foresee (the error 3004 of Ogmios inside 3010: the node cannot make the evaluation context), or an error that is
 * about no script (the tip of the node is too old). One more case: the provider cut or dropped the data of the error (`cause.dataTruncated`
 * or `cause.dataDropped`), so that the builder read no validator. Then it cannot tell whether a validator failed, and the message says so.
 * It is no VaultPayImpossible, because that error means that the builder knew a missing fact and sent nothing to the node, and here the
 * node was asked and its answer decides. A caller can build again with another window, or later.
 */
export class VaultPayNotEvaluated extends VaultPayEvaluationError {
  constructor(evaluationError: string, validators: ValidatorError[], draftTx: string, attempt: VaultPayAttempt, cause: unknown) {
    const lost = cause instanceof OgmiosRpcError && (cause.dataTruncated || cause.dataDropped);
    super('VaultPayNotEvaluated', lost
      ? `The node answered the evaluation of the payment of ${attempt.amountLovelace} lovelace from the vault with an error, and the builder could not read its data in full (the provider cut it or dropped it), so it cannot tell whether a validator failed (${evaluationError}). The draft transaction that the node was asked to evaluate is in draftTx.`
      : `The node did not evaluate the scripts of the payment of ${attempt.amountLovelace} lovelace from the vault, and no validator failed (${evaluationError}). The draft transaction that the node was asked to evaluate is in draftTx.`,
    evaluationError, validators, draftTx, attempt, cause);
  }
}

/** The code of an Ogmios evaluation error that says that some scripts of the transaction terminated with error(s). */
const SCRIPTS_TERMINATED = 3010;
/** The code of the error of one validator that ran and failed ("some of the scripts failed to evaluate to a positive outcome"). */
const VALIDATOR_FAILED = 3012;

const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

/** The errors of the validators in the `data` of an Ogmios evaluation error (JSON text); what is not in the shape of Ogmios is left out. */
function validatorErrorsOf(json: string): ValidatorError[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown): ValidatorError[] => {
    const validator = fieldOf(entry, 'validator');
    const error = fieldOf(entry, 'error');
    const purpose = fieldOf(validator, 'purpose');
    const index = fieldOf(validator, 'index');
    const code = fieldOf(error, 'code');
    const message = fieldOf(error, 'message');
    if (typeof purpose !== 'string' || typeof index !== 'number' || typeof code !== 'number' || typeof message !== 'string') return [];
    const data = fieldOf(error, 'data');
    const detail = fieldOf(data, 'validationError') ?? fieldOf(data, 'reason');
    const traces = fieldOf(data, 'traces');
    // Only a list of texts is a list of traces: anything else is null, because an empty list says "none" and the node did not say that.
    const listOfTexts = Array.isArray(traces) && traces.every((t) => typeof t === 'string');
    return [{ purpose, index, code, message, detail: typeof detail === 'string' ? detail : null, traces: listOfTexts ? (traces as string[]) : null }];
  });
}

/** The JSON-RPC method of OgmiosProvider that asks the node to evaluate a transaction: the `method` of the error of an evaluation. */
const EVALUATE_METHOD = 'evaluateTransaction';

/**
 * How the node answered an evaluation that failed. Only an OgmiosRpcError, the error that OgmiosProvider throws for an answer of the
 * node, is an answer. `refused`: it is of the method evaluateTransaction, its code is 3010, and its `data` lists a validator with the
 * error 3012 (the validator ran and failed). `not_evaluated`: any other OgmiosRpcError, so no failed validator in it, or an error of
 * another method; a `data` that the provider cut or dropped (dataTruncated, dataDropped) holds no validator, so it is no proof of a
 * failed one. `no_answer`: every other error and value: a call that failed, an answer that is no JSON-RPC error, a TypeError, a
 * timeout, an error of a provider that is not OgmiosProvider, a string. It is no verdict, whatever its text says.
 */
export function judgeEvaluation(err: unknown): { kind: 'refused' | 'not_evaluated' | 'no_answer'; text: string; validators: ValidatorError[] } {
  if (!(err instanceof OgmiosRpcError)) return { kind: 'no_answer', text: err instanceof Error ? err.message : String(err), validators: [] };
  const validators = typeof err.data === 'string' ? validatorErrorsOf(err.data) : [];
  const failed = err.method === EVALUATE_METHOD && err.code === SCRIPTS_TERMINATED && validators.some((v) => v.code === VALIDATOR_FAILED);
  return { kind: failed ? 'refused' : 'not_evaluated', text: `${err.code} ${err.rpcMessage}`, validators };
}

/**
 * Did a validator of the transaction run and fail? True for the error that OgmiosProvider throws when the node answers an evaluation
 * with a failed validator (judgeEvaluation: `refused`), and for the VaultPayRefused that holds it. False for every other error and
 * value: a VaultPayNotEvaluated is false, whatever its cause is.
 */
export function isLedgerRefusal(err: unknown): boolean {
  return judgeEvaluation(err instanceof VaultPayRefused ? err.cause : err).kind === 'refused';
}

/** The last transaction that the node was asked to evaluate, and the failure that it answered with (null when it evaluated it). */
interface Evaluation { draftTx: string; failure: Error | null }

/** The node of a build that the ledger decides: it notes the failures that calls to it raise, and the transaction it was last asked to evaluate. */
interface WatchedNode {
  /** The provider, with every call passed on to it. */
  node: Provider;
  /** Did a call to the node raise `err`? A refusal of the builder did not. */
  raised(err: unknown): boolean;
  evaluation(): Evaluation | null;
}

function watchNode(provider: Provider): WatchedNode {
  const raised = new WeakSet<object>();
  let evaluation: Evaluation | null = null;
  const node = new Proxy(provider, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const evaluates = property === 'evaluateTx';
        if (evaluates) evaluation = { draftTx: String(args[0]), failure: null };
        const fail = (err: unknown): never => {
          const failure = err instanceof Error ? err : new Error(String(err));
          raised.add(failure);
          if (evaluates) evaluation = { draftTx: String(args[0]), failure };
          throw failure;
        };
        try {
          const answer: unknown = member.apply(target, args);
          return answer instanceof Promise ? answer.catch(fail) : answer;
        } catch (err) { return fail(err); }
      };
    },
  });
  return { node, raised: (err) => typeof err === 'object' && err !== null && raised.has(err), evaluation: () => evaluation };
}

/** Completes `tx` with the node evaluating the scripts. An answer of the node with a failed validator throws VaultPayRefused, an answer with none VaultPayNotEvaluated. */
async function completeByNode(tx: TxBuilder, watch: WatchedNode, attempt: VaultPayAttempt): Promise<TxSignBuilder> {
  try { return await tx.complete({ localUPLCEval: false }); } catch (err) {
    const evaluated = watch.evaluation();
    if (evaluated !== null && evaluated.failure !== null) {
      const { kind, text, validators } = judgeEvaluation(evaluated.failure);
      if (kind === 'refused') throw new VaultPayRefused(text, validators, evaluated.draftTx, attempt, evaluated.failure);
      if (kind === 'not_evaluated') throw new VaultPayNotEvaluated(text, validators, evaluated.draftTx, attempt, evaluated.failure);
    }
    throw err;
  }
}

/** The configuration of `lucid` with `provider` as its node: what lucid.newTx() builds with, for a builder that must watch the node. */
function configOn(lucid: LucidEvolution, provider: Provider): LucidConfig {
  const { network, wallet, costModels, txbuilderconfig, protocolParameters } = lucid.config();
  if (network === undefined || costModels === undefined || txbuilderconfig === undefined || protocolParameters === undefined) {
    throw new Error('Lucid has no network, cost models or protocol parameters, so no transaction can be built; nothing was built.');
  }
  return { provider, network, wallet, costModels, txbuilderconfig, protocolParameters };
}

/**
 * Builds the unsigned Pay of a Live vault (vault/handlers.ak pay): the delegate of the vault's delegation hires an identity-
 * marketplace advert. The advert must be listed (the indexer and the listing rule on chain, as for a Post). The transaction spends the
 * vault (the only script input), reads the vault script, the delegation chain and the records its use checks read (reference inputs),
 * pays one escrow at output 0 (planVaultEscrow: buyer_pkh = the delegate key, refund = the vault address with the datum
 * Returned { owner }, payment + both bonds exactly the output's AP3X) and one continuing vault output at output 1 with the new
 * spent and period_start. Refuses before it builds: a vault that is not Live or holds other assets, a delegation that fails the use
 * checks of Part 2 Section 5.2 for marketplace.hire.v1 on the escrow script, whose delegator is not the owner, or that has no value
 * limit, an amount above per_tx or a period total above total, and a vault too small to keep its minimum output. Each refusal of a rule
 * that the vault contract enforces says that the contract refuses the same payment on chain; a refusal that the option `ledgerDecides`
 * skips says how to pass it, and its error has a mark by type: a VaultRuleRefusal (per_tx, total, the use checks, the delegator, the
 * other assets), an EscrowPlanRefusal with the fault `value_cap`, or a ChainGapError (`skippedByLedgerDecides` tells them). A caller
 * reads the mark, not the message, because a message carries text from the chain. The delegate key signs. `fetchImpl` stands in for
 * fetch in the Koios and indexer calls (tests).
 *
 * With `ledgerDecides` the node judges the payment, not the builder. The builder makes no refusal for the per-transaction limit, the
 * period total, the use checks of the delegation, the delegator, the other assets of the vault, the value cap, the indexer listing and
 * the listing rule; it reads the advert from the node (readAdvertFromNode), not from Koios and the indexer; and the node evaluates the
 * scripts (`localUPLCEval: false`). The refusal of a fleet capability stays (VaultPayImpossible, the reason `advert_terms`). An
 * evaluation in which a validator of the transaction ran and failed throws
 * VaultPayRefused: it holds the code and the message of the node, the error of each validator and the draft transaction. An answer of
 * the node in which the builder read no failed validator (for example a validity range beyond the end of the era that the node can
 * foresee) throws VaultPayNotEvaluated: the scripts were not evaluated, so it is no refusal. What makes a transaction impossible is still refused, as
 * VaultPayImpossible with a reason. A delegation whose ANCESTOR has no output on the node (it was undelegated) is not impossible: the
 * draft is built with the chain up to the gap, and the node evaluates it. The vault script needs every ancestor as a reference input
 * (delegation/chain.ak, `expect Some(parent)`), so it cannot pass with this chain: it fails at the gap, or at an earlier check of the
 * links below it. The result is VaultPayRefused, with `attempt.missingParent`. Only a missing
 * delegation of the vault itself stays impossible, because nothing says which delegate key it names. Any other failure (the node does
 * not answer, the wallet, the coin selection) is an ordinary error, so a caller tells a build, a refusal of the ledger, an evaluation
 * that did not happen and an impossible transaction apart by type.
 */
export async function buildVaultPay(ctx: IdentityContext, p: VaultPayParams, fetchImpl: typeof fetch = fetch): Promise<VaultPayBuild> {
  const { lucid, deployment } = ctx;
  const decides = p.ledgerDecides === true;
  const watch = decides ? watchNode(ctx.provider) : null;
  const provider = watch === null ? ctx.provider : watch.node;
  // With `ledgerDecides` what the builder refuses is a VaultPayImpossible: `cannot` for its own refusals, `read` for what a read of the
  // chain refuses. A failure that a call to the node raised stays as it is. Without it, both are the plain errors of old.
  const cannot = (reason: VaultPayImpossibleReason, message: string): Error => (decides ? new VaultPayImpossible(reason, message) : new Error(message));
  const read = async <T>(reason: VaultPayImpossibleReason, body: () => Promise<T>): Promise<T> => {
    try { return await body(); } catch (err) {
      if (watch === null || watch.raised(err)) throw err;
      throw new VaultPayImpossible(reason, err instanceof Error ? err.message : String(err));
    }
  };
  await chainClock(provider);
  const window: Window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  const { ref: vaultRef, utxo, vault } = await read('no_vault', () => readVault({ ...ctx, provider }, p.vaultRef));
  if (vault.type !== 'Live') throw cannot('vault_not_live', `Vault ${vaultRef} holds an escrow refund (Returned): only its owner can close it, and it cannot pay. ${vaultRefuses('a Returned output cannot pay')}`);
  if (!decides && Object.keys(utxo.assets).some((unit) => unit !== 'lovelace')) throw new VaultRuleRefusal(`Vault ${vaultRef} holds assets other than AP3X, so it cannot pay; its owner can close it. ${vaultRefuses('the vault input holds AP3X only')} ${LEDGER_DECIDES_HINT}`);

  // With `ledgerDecides` the chain may end at a gap: an ancestor that was undelegated. The draft then has no reference input for it, and
  // the node judges that draft. Without it a gap is an error, as it always was.
  const { chain, gap } = await read('no_delegation', async (): Promise<{ chain: DelegationUtxo[]; gap: ChainGap | null }> => (decides
    ? delegationChainToGap(provider, deployment, vault.delegation)
    : { chain: await delegationChain(provider, deployment, vault.delegation), gap: null }));
  const leaf = chain[0].delegation;
  if (!decides && !sameDelegator(leaf.delegator, vault.owner)) throw new VaultRuleRefusal(`The delegator of delegation ${vault.delegation} is not the owner of vault ${vaultRef}. ${vaultRefuses('the delegator of the delegation is the owner of the vault')} ${LEDGER_DECIDES_HINT}`);
  const limit = leaf.value;
  if (limit === null) throw cannot('no_delegation', `Delegation ${vault.delegation} has no value limit, and a vault pays only under one (Part 2 Section 5.3). ${vaultRefuses('the delegation has a value limit')}`);
  const records = await read('no_delegation', () => chainRecords(provider, deployment, chain, gap === null));
  const problems = decides ? [] : delegationUseProblems(chain, recordsById(records), HIRE_ACTION, escrowResource(deployment.escrow.hash), window);
  if (problems.length > 0) throw new VaultRuleRefusal(`The delegation ${vault.delegation} cannot be used for this payment (Part 2 Section 5.2). ${vaultRefuses('the use checks of the delegation')} ${LEDGER_DECIDES_HINT} The builder found: ${problems.join('; ')}.`);

  let advert: { ref: string; advert: IdentityAdvertDatum; agentId: string };
  if (decides) {
    const onNode = await readAdvertFromNode(provider, p.advertRef, deployment);
    if ('error' in onNode) throw new VaultPayImpossible('no_advert', onNode.error);
    const fleet = fleetAdvertRefusal(onNode.ref, onNode.advert.capability_id);
    if (fleet !== null) throw new VaultPayImpossible('advert_terms', fleet);
    advert = onNode;
  } else {
    const hireable = await readHireableAdvert(p.advertRef, fetchImpl, deployment);
    if (hireable.layout !== 'identity') throw new Error(`Advert ${hireable.ref} is a legacy advert; a vault pays only identity-marketplace escrows. ${vaultRefuses('the escrow outputs at the identity escrow address hold at least the amount that leaves the vault')}`);
    advert = hireable;
  }
  const refund = { address: plutusAddressFromBech32(deployment.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner: vault.owner }) };
  let plan: PostEscrowPlan;
  try { plan = planVaultEscrow(advert.advert, advert.ref, leaf.delegateKey, p.payload, window, { agentId: advert.agentId, refund }, { capped: !decides }); } catch (err) {
    // With `ledgerDecides` the planner does not check the value cap (the vault script does); what it refuses is a check of the builder.
    if (decides && err instanceof EscrowPlanRefusal && err.fault !== 'value_cap') throw new VaultPayImpossible(PLAN_FAULT_REASON[err.fault], err.message);
    throw err;
  }
  if (!decides) {
    await assertIndexerLists(advert.ref, advert.agentId, fetchImpl);
    await checkListingRule(provider, deployment, advert.advert, advert.ref, window);
  }

  const amount = plan.lockLovelace;
  if (!decides && amount > limit.perTx) throw new VaultRuleRefusal(`The payment of ${ap3xText(amount)} is above the per-transaction limit of delegation ${vault.delegation}: per_tx is ${ap3xText(limit.perTx)}. The payment is what the hire takes from the vault: price + buyer bond + supplier bond. ${vaultRefuses('amount <= per_tx')} ${LEDGER_DECIDES_HINT}`);
  const newPeriod = window.lo >= vault.periodStart + limit.periodMs;
  const spent = newPeriod ? amount : vault.spent + amount;
  const periodStart = newPeriod ? window.hi : vault.periodStart;
  if (!decides && spent > limit.total) throw new VaultRuleRefusal(`The payment would bring this period's spending to ${ap3xText(spent)}, above the total limit of delegation ${vault.delegation}: total is ${ap3xText(limit.total)}. The payment of ${ap3xText(amount)} is what the hire takes from the vault: price + buyer bond + supplier bond. ${vaultRefuses('spent in the period <= total')} ${LEDGER_DECIDES_HINT}`);
  const next: VaultDatum = { type: 'Live', owner: vault.owner, delegation: vault.delegation, spent, periodStart };
  const kept = utxo.assets.lovelace - amount;
  const minimum = vaultMinimum(lucid, deployment, next);
  if (kept < minimum) throw cannot('below_minimum', `Vault ${vaultRef} holds ${ap3xText(utxo.assets.lovelace)}: after the payment of ${ap3xText(amount)} it would keep ${ap3xText(kept)}, below the ${ap3xText(minimum)} its output needs. The ledger refuses an output below its minimum. Pay less, or have the owner add to a new vault.`);

  const signers = new SignerList().add(leaf.delegateKey, `delegate key of delegation ${vault.delegation}`);
  const vaultScript = await read('no_vault', () => readRefScript(provider, deployment, 'vault', deployment.vault.hash));
  const refs = uniqueUtxos([vaultScript, ...chain.map((link) => link.utxo), ...records.map((r) => r.utxo)]);
  // With `ledgerDecides` the transaction is built on the watched node, so that Lucid asks it to evaluate the scripts and the evaluation is seen.
  let tx = (watch === null ? lucid.newTx() : makeTxBuilder(configOn(lucid, provider)))
    .readFrom(refs)
    .collectFrom([utxo], VAULT_PAY)
    .pay.ToAddressWithData(deployment.escrow.address, { kind: 'inline', value: plan.datumHex }, { lovelace: amount })
    .pay.ToAddressWithData(deployment.vault.address, { kind: 'inline', value: encodeVaultDatum(next) }, { lovelace: kept })
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const attempt: VaultPayAttempt = { amountLovelace: amount, vaultLovelace: kept, spent, periodStart, newPeriod, limit, ...(gap === null ? {} : { missingParent: gap }) };
  const completed = watch === null ? await tx.complete() : await completeByNode(tx, watch, attempt);
  const result = signedByResult(completed, window, signers, wallet.keyHash);
  assertEscrowIsOutputZero(result.txCbor, { datumHex: plan.datumHex, lockLovelace: amount, address: deployment.escrow.address });
  return {
    ...result, escrowRef: formatOutRef(result.txHash, 0), vaultRef: formatOutRef(result.txHash, 1), amountLovelace: amount, vaultLovelace: kept,
    spent, periodStart, newPeriod, limit, delegateKey: leaf.delegateKey, owner: vault.owner, agentId: advert.agentId, did: didOf(advert.agentId),
    deliverBy: plan.deliverBy, promptHash: plan.datum.prompt_hash, priceLovelace: plan.priceLovelace, supplierBondLovelace: plan.supplierBondLovelace, buyerBondLovelace: plan.buyerBondLovelace,
  };
}

// ─── Close ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VaultCloseBuild extends SignedByBuild {
  /** The vaults the transaction closes, with what each held. */
  vaults: Array<{ ref: string; vault: VaultDatum; lovelace: bigint }>;
  /** Their AP3X together: it goes to the wallet, less the fee. */
  totalLovelace: bigint;
}

/**
 * Builds the unsigned Close of one or more vault outputs, Live or Returned, also after Undelegate (vault/handlers.ak owner_signed): the
 * owner of each signs, as a principal key, or for an agent owner as the agent's controller with the agent's record as a reference input.
 * Everything the vaults hold goes to the wallet as change.
 */
export async function buildVaultClose(ctx: IdentityContext, p: BuildCommon & { vaultRefs: string[] }): Promise<VaultCloseBuild> {
  const { lucid, provider, deployment } = ctx;
  await chainClock(provider);
  const window = windowAt(p.nowMs ?? Date.now(), p.validMinutes);
  const wallet = await walletOf(lucid, p.changeAddress);
  if (p.vaultRefs.length === 0) throw new Error('Name at least one vault output to close.');
  const vaults: VaultUtxo[] = [];
  for (const ref of p.vaultRefs) vaults.push(await readVault(ctx, ref));
  if (new Set(vaults.map((v) => v.ref)).size !== vaults.length) throw new Error('A vault output is named twice.');
  const signers = new SignerList();
  const refs: UTxO[] = [await readRefScript(provider, deployment, 'vault', deployment.vault.hash)];
  for (const { ref, vault } of vaults) {
    if (vault.owner.type === 'PrincipalKey') { signers.add(vault.owner.hash, `owner of vault ${ref}`); continue; }
    const record = await requireRecord(provider, deployment, vault.owner.id, 'record of the vault owner');
    signers.addKey(record.record.controller, `controller of ${didOf(vault.owner.id)}, owner of vault ${ref}`);
    refs.push(record.utxo);
  }
  let tx = lucid.newTx()
    .readFrom(uniqueUtxos(refs))
    .collectFrom(vaults.map((v) => v.utxo), VAULT_CLOSE)
    .validFrom(window.lo)
    .validTo(window.hi);
  for (const hash of signers.hashes()) tx = tx.addSignerKey(hash);
  const result = signedByResult(await tx.complete(), window, signers, wallet.keyHash);
  const listed = vaults.map((v) => ({ ref: v.ref, vault: v.vault, lovelace: v.utxo.assets.lovelace }));
  return { ...result, vaults: listed, totalLovelace: listed.reduce((sum, v) => sum + v.lovelace, 0n) };
}
