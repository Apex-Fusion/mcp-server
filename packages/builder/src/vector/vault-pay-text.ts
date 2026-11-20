// packages/builder/src/vector/vault-pay-text.ts
// The answers of vector_build_vault_pay when the ledger decides (`ledger_decides: true`): what the node said, in the words of the tool.
// A refusal has two parts with two sources, and the text keeps them apart. The node says which validator failed. The deployed scripts carry
// no trace messages, so the node does not name the rule. The builder reads the amount and the limits from the chain, and says what that
// reading shows; the node does not confirm it. Text that the node gives goes through cell(), as all text from outside does. The draft
// transaction is never printed: it is no transaction to submit.
import { OgmiosRpcError } from '@apexfusion/vector-mcp-shared/provider';
import { decodeTransaction } from './guarded-decode.js';
import { ap3xText } from './identity-chain.js';
import type { IdentityDeployment } from './identity-deployment.js';
import { cell } from './marketplace-shared.js';
import type { ValidatorError, VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused } from './vault-build.js';

/** The most validators and the most traces that an answer lists; the rest is counted. */
const MOST_LISTED = 5;

/**
 * The inputs of a transaction in the order of the ledger: by transaction id, then by index. The index of a spend validator in the answer
 * of the node is a position in this list. Null when the bytes are not a transaction that can be read.
 */
export function inputsInLedgerOrder(txCbor: string): string[] | null {
  try {
    const inputs = decodeTransaction(txCbor, 'The draft transaction').body().inputs();
    const refs = Array.from({ length: inputs.len() }, (_, i) => ({ txHash: inputs.get(i).transaction_id().to_hex(), index: Number(inputs.get(i).index()) }));
    refs.sort((a, b) => (a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1));
    return refs.map((r) => `${r.txHash}#${r.index}`);
  } catch { return null; }
}

/** What the validator `v` of the draft is, in words: only a spend validator at the vault input is the vault script. */
function placeOf(v: ValidatorError, inputs: string[] | null, vaultRef: string, scriptHash: string): string {
  if (v.purpose !== 'spend') {
    return `purpose ${cell(v.purpose, 24)}, index ${v.index}: the draft of a vault payment runs one script, the vault script on a spend, so the builder cannot map this validator`;
  }
  if (inputs === null) return `purpose spend, index ${v.index}: the builder could not read the draft, so it cannot say which input that is`;
  const input = inputs[v.index];
  if (input === undefined) return `purpose spend, index ${v.index}: the draft has no input ${v.index}, so the builder cannot map this validator`;
  if (input !== vaultRef) return `purpose spend, index ${v.index}: input ${v.index} of the draft is \`${input}\`, which is not the vault output, so the builder cannot map this validator to the vault script`;
  return `purpose spend, index ${v.index}: input ${v.index} of the draft is the vault output \`${vaultRef}\`, so this is the vault script \`${scriptHash}\`, run with the redeemer Pay that the builder attached`;
}

/** The traces of one validator: none, and why; the traces, escaped; or that the node gave no list that the builder can read. */
function tracesText(traces: string[] | null): string {
  if (traces === null) return 'Traces: the node gave no trace list that the builder can read, so the builder cannot tell whether the node names a rule.';
  if (traces.length === 0) return 'Traces: none. The deployed scripts carry no trace messages, so the node does not name the rule that failed.';
  const more = traces.length > MOST_LISTED ? ` and ${traces.length - MOST_LISTED} more` : '';
  return `Traces: ${traces.slice(0, MOST_LISTED).map((t) => `"${cell(t, 160)}"`).join(', ')}${more}.`;
}

/** What the node said about one validator: its code, its message and its detail. */
const answerOf = (v: ValidatorError): string => `Node answer: code ${v.code}, "${cell(v.message, 240)}"${v.detail === null ? '' : `; detail: "${cell(v.detail, 300)}"`}.`;

/**
 * The answer of the tool when the node ran the scripts of the draft and a validator failed. Part one is the verdict of the node: each
 * validator with its purpose, its index, the input and script it maps to, the redeemer, its code and message, and the traces. Part two is
 * the reading of the builder, labelled as such: the amount, per_tx, the spending of the period, total and the period, and the parent
 * delegation that the draft lacks, when it lacks one. `vaultRef` is the vault output in the form `<txid>#<index>`.
 */
export function refusedText(err: VaultPayRefused, vaultRef: string, deployment: IdentityDeployment): string {
  const inputs = inputsInLedgerOrder(err.draftTx);
  const listed = err.validators.slice(0, MOST_LISTED).map((v, i) => [
    `${i + 1}. ${placeOf(v, inputs, vaultRef, deployment.vault.hash)}.`,
    `   ${answerOf(v)}`,
    `   ${tracesText(v.traces)}`,
  ].join('\n'));
  if (err.validators.length > MOST_LISTED) listed.push(`... and ${err.validators.length - MOST_LISTED} more validators.`);
  const a = err.attempt;
  const aboveTx = a.amountLovelace > a.limit.perTx;
  const aboveTotal = a.spent > a.limit.total;
  const reading = [
    `- The payment takes ${ap3xText(a.amountLovelace)} from the vault: price + buyer bond + supplier bond.`,
    `- per_tx of the delegation is ${ap3xText(a.limit.perTx)}. The payment is ${aboveTx ? 'above' : 'within'} it.`,
    `- The spending of the period after this payment would be ${ap3xText(a.spent)}. total is ${ap3xText(a.limit.total)}. The spending is ${aboveTotal ? 'above' : 'within'} it. `
      + `The period is ${a.limit.periodMs} ms${a.newPeriod ? ', and this payment starts a new period' : ''}.`,
  ];
  if (a.missingParent !== undefined) {
    reading.push(`- The builder found no output for the parent delegation ${a.missingParent.missing} of ${a.missingParent.child}: it was undelegated, or it is not confirmed yet. The draft has no reference input for it. The vault script needs every ancestor of the delegation, so it cannot pass with this chain: it fails at the gap, or at an earlier check of the links below it.`);
  } else if (!aboveTx && !aboveTotal) {
    reading.push('- Both figures are within the limits. By this reading the refusal is for another rule of the vault script: the use checks of the delegation, the delegator, the other assets of the vault, or the value cap of an escrow.');
  }
  const advice = a.missingParent === undefined
    ? 'Lower the payment (an advert with a lower price or lower bonds), wait for the period to end, or ask the delegator for a wider delegation.'
    : 'Ask the delegator for a new delegation. An undelegated parent ends every delegation below it.';
  return [
    'Failed to build vault payment: the LEDGER refused it. The node ran the scripts of the draft transaction, and a validator failed. Nothing was signed or submitted.',
    '',
    `**The verdict of the node** (the answer of the ledger: ${cell(err.evaluationError, 200)}):`,
    ...listed,
    '',
    "**The builder's own reading** (not the verdict of the node: the builder worked it out from the chain and the advert, and the node does not confirm it):",
    ...reading,
    '',
    '**Troubleshooting Tips:**',
    `1. The node judged the draft against the chain as it is now. ${advice}`,
    '2. Build again without ledger_decides: the builder then checks the rules itself, names the rule that fails, or builds the transaction.',
  ].join('\n');
}

/** Did the provider cut or drop the data of the error of the node, so that the builder could not read it in full? */
const dataLost = (err: VaultPayNotEvaluated): boolean => err.cause instanceof OgmiosRpcError && (err.cause.dataTruncated || err.cause.dataDropped);

/**
 * The answer of the tool when the node answered and the builder read no failed validator. Nearly always the node did not evaluate the
 * scripts: it is no refusal by the ledger and no verdict on the payment. When the provider cut or dropped the data of the error, the
 * builder could not read it. It cannot tell whether a validator failed, and the answer says that: it never says that none failed.
 */
export function notEvaluatedText(err: VaultPayNotEvaluated): string {
  const lost = dataLost(err);
  const entries = err.validators.slice(0, MOST_LISTED).map((v, i) => `${i + 1}. purpose ${cell(v.purpose, 24)}, index ${v.index}: ${answerOf(v)}`);
  const withoutFlag = 'Build again without ledger_decides: the builder then checks the rules itself, and Lucid runs the vault script on this machine.';
  const tips = lost
    ? [withoutFlag]
    : ['Build again, now or later, or with a shorter valid_minutes. The node could not make the evaluation: for example, its tip is old, or the validity range is beyond what it can foresee.', withoutFlag];
  return [
    lost
      ? 'Failed to build vault payment: the node answered the evaluation with an error, and the builder could not read the data of the error in full: the provider cut it or dropped it. The builder cannot tell whether a validator failed, so it gives no verdict on the payment: the ledger may have refused it. Nothing was signed or submitted.'
      : 'Failed to build vault payment: the node did NOT evaluate the scripts of the payment. This is not a refusal by the ledger, and it is no verdict on the payment: no validator failed. Nothing was signed or submitted.',
    '',
    `**What the node said:** ${cell(err.evaluationError, 240)}`,
    ...entries,
    '',
    '**Troubleshooting Tips:**',
    ...tips.map((tip, i) => `${i + 1}. ${tip}`),
  ].join('\n');
}

/** The message of the failure when the builder cannot build the payment, whatever the ledger would say: the reason first, then the words of the builder. */
export const impossibleMessage = (err: VaultPayImpossible): string =>
  `The builder cannot build this payment, and it did not ask the node to evaluate it (reason: ${err.reason}). ${err.message}`;
