// packages/builder/test/vault-tools.test.ts
// Handler-level tests of the vault tools (Part 2 Sections 5.3 and 10): open, pay and close through a fake server, on identity-world's
// node (the real applied vault script runs) with global fetch as the fake of Koios and the indexer. The tools build against the clock,
// so the delegation's period is stated relative to Date.now().
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { OGMIOS_ERROR_DATA_INPUT_LIMIT } from '@apexfusion/vector-mcp-shared/provider';
import { registerVaultTools } from '../src/vector/vault-tools.ts';
import { rateGate } from '../src/vector/marketplace-shared.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { IdentityConfigError, NOT_CONFIGURED } from '../src/vector/identity-deployment.ts';
import { MAX_ESCROW_LOVELACE } from '../src/vector/marketplace-constants.ts';
import { ChainGapError } from '../src/vector/identity-chain.ts';
import { DEPLOYMENT, DAY, OWN_ADDRESS, identityWorld } from './fixtures/identity-world.ts';
import {
  ADVERT_REF, AGENT_DID, DELEGATE_ID, DELEGATE_KEY, DELEGATION_ID, IDENTITY_ADVERT, OWN_PKH, PAYLOAD, advertUtxo, agentRecord, chainFake, delegateRecord, delegation, delegationUtxo,
  listedRow, liveVault, vaultUtxo,
} from './fixtures/escrow-identity.fixture.ts';
import { PARENT_ID, answerOf, evaluatingNode, ogmiosRaised, twoHopWorld, validatorsOf } from './fixtures/ledger-node.fixture.ts';
import type { ErrorBody, EvaluatingNode, ValidatorBody } from './fixtures/ledger-node.fixture.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
/** What a tool registered: its description and its input schema (zod types). */
interface Registered { description: string; schema: Record<string, { safeParse(value: unknown): { success: boolean } }> }
const registered = new Map<string, Registered>();
let node: Provider | undefined;
function tools(deployment: () => typeof DEPLOYMENT = () => DEPLOYMENT) {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, description: string, schema: Registered['schema'], handler: Handler) => { handlers.set(name, handler); registered.set(name, { description, schema }); },
  } as unknown as McpServer;
  registerVaultTools(server, rateGate(new RateLimiter(100_000)), () => { if (!node) throw new Error('no node'); return node; }, deployment);
  return async (name: string, args: Record<string, unknown>) => (await handlers.get(name)!(args)).content[0].text;
}
const call = tools();
const jsonOf = (t: string) => JSON.parse(t.slice(t.lastIndexOf('```json\n') + 8, t.lastIndexOf('\n```')));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; node = undefined; });
/** A delegation that runs now. */
const current = () => delegationUtxo(delegation({ notBefore: Date.now() - DAY, notAfter: Date.now() + 30 * DAY }));
const VAULT_REF = `${'fa'.repeat(32)}#0`;

describe('the vault tools', () => {
  test('vector_build_vault_open: the wallet key owns the vault for its delegation', async () => {
    node = identityWorld([current()]);
    const t = await call('vector_build_vault_open', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, amount: 40 });
    assert.ok(t.startsWith('# Vault Opening Built (Unsigned, Not Submitted)\n'), t.slice(0, 400));
    const j = jsonOf(t);
    assert.deepEqual([j.vault_ref, j.amount_lovelace, j.per_tx, j.total], [`${j.tx_hash}#0`, '40000000', '50000000', '100000000']);
    assert.match(t, /\*\*Owner:\*\* principal key [0-9a-f]{56}/);
    assert.match(await call('vector_build_vault_open', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, amount: 40, owner_did: AGENT_DID }), /^Failed to build vault opening: The delegator of delegation .* not the owner agent/);
  });
  test('vector_build_vault_pay: the delegate key signs, the escrow is output 0 and the vault output 1', async () => {
    node = identityWorld([vaultUtxo(liveVault()), current(), delegateRecord(), agentRecord()]);
    globalThis.fetch = chainFake({ live: [advertUtxo()], listed: [listedRow()] }).f;
    const t = await call('vector_build_vault_pay', { changeAddress: OWN_ADDRESS, vault_ref: VAULT_REF, advert_ref: ADVERT_REF, payload: PAYLOAD });
    assert.ok(t.startsWith('# Vault Payment Built (Unsigned, Not Submitted)\n'), t.slice(0, 600));
    const j = jsonOf(t);
    assert.deepEqual([j.escrow_ref, j.vault_ref, j.did, j.new_period, j.payload], [`${j.tx_hash}#0`, `${j.tx_hash}#1`, AGENT_DID, true, PAYLOAD]);
    assert.deepEqual(j.required_signers.map((s: { key_hash: string }) => s.key_hash), [DELEGATE_KEY.keyHash, OWN_PKH]);
    assert.match(t, /Each key holder in the list signs in turn/);
  });
  test('vector_build_vault_close: the owner closes; a wrong ref is a text refusal', async () => {
    node = identityWorld([vaultUtxo({ type: 'Returned', owner: { type: 'PrincipalKey', hash: OWN_PKH, organisation: null } }, 3_000_000n)]);
    const t = await call('vector_build_vault_close', { changeAddress: OWN_ADDRESS, vault_refs: [VAULT_REF] });
    assert.ok(t.startsWith('# Vault Close Built (Unsigned, Not Submitted)\n'), t.slice(0, 400));
    assert.deepEqual(jsonOf(t).vaults, [{ vault_ref: VAULT_REF, kind: 'Returned', lovelace: '3000000' }]);
    assert.match(await call('vector_build_vault_close', { changeAddress: OWN_ADDRESS, vault_refs: [`${'fb'.repeat(32)}#0`] }), /^Failed to build vault close: Vault .* is not an unspent output on the node/);
  });
  test('without a deployment every vault tool says which variables to set', async () => {
    const unconfigured = tools(() => { throw new IdentityConfigError(NOT_CONFIGURED); });
    node = identityWorld([]);
    for (const [name, args] of [
      ['vector_build_vault_open', { changeAddress: OWN_ADDRESS, delegation: DELEGATION_ID, amount: 40 }],
      ['vector_build_vault_pay', { changeAddress: OWN_ADDRESS, vault_ref: VAULT_REF, advert_ref: ADVERT_REF, payload: PAYLOAD }],
      ['vector_build_vault_close', { changeAddress: OWN_ADDRESS, vault_refs: [VAULT_REF] }],
    ] as const) assert.match(await unconfigured(name, args), /VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/, name);
  });
});

describe('vector_build_vault_pay with ledger_decides: the node judges the payment', () => {
  const PAY_TOOL = 'vector_build_vault_pay';
  const pay = { changeAddress: OWN_ADDRESS, vault_ref: VAULT_REF, advert_ref: ADVERT_REF, payload: PAYLOAD };
  const noNetwork = (async () => { throw new Error('the network was touched'); }) as typeof fetch;
  /** What the node holds for a payment that runs now. */
  const held = (over: { delegation?: UTxO; vault?: UTxO } = {}): UTxO[] => [over.vault ?? vaultUtxo(liveVault()), over.delegation ?? current(), delegateRecord(), agentRecord(), advertUtxo()];
  /** A delegation that runs now and lets at most 1 AP3X through per payment: the advert of the fixtures costs 4 AP3X. */
  const tight = (): UTxO => delegationUtxo(delegation({ notBefore: Date.now() - DAY, notAfter: Date.now() + 30 * DAY, value: { perTx: 1_000_000n, total: 100_000_000n, periodMs: DAY } }));
  const withNode = (utxos: UTxO[]): EvaluatingNode => { const n = evaluatingNode(utxos); node = n; return n; };
  /** The node answers every evaluation with the error that `patch` makes of the real mainnet body of a refused payment. */
  const answering = (n: EvaluatingNode, name: string, patch: (validator: ValidatorBody) => void = () => {}, patchBody: (body: ErrorBody) => void = () => {}) => {
    Object.assign(n, { evaluateTx: async (tx: string) => { n.evaluations.push(tx); throw await ogmiosRaised(answerOf(name, (body) => { patchBody(body); for (const v of validatorsOf(body)) patch(v); })); } });
  };
  const answer = (args: Record<string, unknown> = {}) => call(PAY_TOOL, { ...pay, ledger_decides: true, ...args });
  const placeOf = (t: string, ref: string): RegExpExecArray | null =>
    new RegExp(`1\\. purpose spend, index (\\d+): input \\1 of the draft is the vault output \`${ref}\`, so this is the vault script \`${DEPLOYMENT.vault.hash}\`, run with the redeemer Pay that the builder attached\\.`).exec(t);

  test('the tool takes the flag as an optional boolean, and its text says what the flag skips and what it can cost', () => {
    const { description, schema } = registered.get(PAY_TOOL)!;
    assert.deepEqual([true, false, undefined].map((value) => schema.ledger_decides.safeParse(value).success), [true, true, true]);
    assert.equal(schema.ledger_decides.safeParse('yes').success, false);
    for (const words of [
      'With ledger_decides: true the builder skips its own checks of per_tx, total, the use checks, the delegator, the other assets of the vault, the value cap, the indexer listing and the listing rule',
      'a build means that the node ran the scripts and none failed, and a refusal shows the failed validator (the node does not name the rule)',
      'a payment to an advert that no supplier can claim locks the vault funds until deliver_by; then Reclaim and a vault Close return them',
      'The builder checks these rules first, so that a refusal names the rule; the vault contract refuses the same payment on chain',
    ]) assert.ok(description.includes(words), words);
    assert.ok(description.endsWith('Takes no key material.'));
    // The listing is no rule of a contract: the sentence about the contract comes first, and the listing has its own sentence that says that only the builder checks it.
    const contract = description.indexOf('the vault contract refuses the same payment on chain');
    const listing = description.indexOf('The advert must be listed: only the builder checks this.');
    assert.ok(contract >= 0 && listing > contract, 'the sentence about the contract comes before the sentence about the listing');
    assert.ok(!description.includes('The advert must be listed. '), 'the listing is not among the rules that the contract refuses');
  });

  test('a payment that passes: the answer is the answer of the default path plus one line, the node ran the scripts, and neither Koios nor the indexer was asked', async (t) => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const utxos = held();
    withNode(utxos);
    globalThis.fetch = chainFake({ live: [advertUtxo()], listed: [listedRow()] }).f;
    const byDefault = await call(PAY_TOOL, pay);
    assert.equal(await call(PAY_TOOL, { ...pay, ledger_decides: false }), byDefault, 'false is the default, byte for byte');
    assert.doesNotMatch(byDefault, /Ledger verdict/);
    assert.ok(!('ledger_decides' in jsonOf(byDefault)));
    globalThis.fetch = noNetwork;
    const n = withNode(utxos);
    const flagged = await answer();
    assert.ok(n.evaluations.length >= 1, 'the node ran the scripts');
    const verdict = flagged.split('\n').filter((line) => line.startsWith('**Ledger verdict:**'));
    assert.deepEqual(verdict, ['**Ledger verdict:** the node ran the scripts of the draft transaction and none failed. The builder skipped its own checks, among them the indexer listing and the listing rule: an advert that no supplier can claim locks the vault funds until deliver_by']);
    const { ledger_decides, ...json } = jsonOf(flagged);
    assert.equal(ledger_decides, true);
    assert.deepEqual(json, jsonOf(byDefault), 'the facts, the transaction and the signers are those of the default path');
    const markdown = (answerText: string) => answerText.slice(0, answerText.lastIndexOf('```json'));
    assert.equal(markdown(flagged).replace(`${verdict[0]}\n`, ''), markdown(byDefault));
  });

  test('a payment above per_tx: the answer says that the LEDGER refused, names the validator, the input and the script, and keeps the reading of the builder apart', async () => {
    const n = withNode(held({ delegation: tight() }));
    globalThis.fetch = noNetwork;
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it. The node ran the scripts of the draft transaction, and a validator failed. Nothing was signed or submitted.\n'), t);
    assert.ok(t.includes('**The verdict of the node** (the answer of the ledger: 3010 Some scripts of the transactions terminated with error(s).):'));
    const place = placeOf(t, VAULT_REF);
    assert.ok(place, t);
    assert.match(t, new RegExp(`Spend\\[${place[1]}\\]`), 'the evaluator named the same input');
    assert.match(t, /Node answer: code 3012, "Some of the scripts failed to evaluate to a positive outcome\./);
    assert.ok(t.includes('Traces: none. The deployed scripts carry no trace messages, so the node does not name the rule that failed.'));
    assert.ok(t.indexOf('**The verdict of the node**') < t.indexOf("**The builder's own reading**"));
    assert.ok(t.includes("**The builder's own reading** (not the verdict of the node: the builder worked it out from the chain and the advert, and the node does not confirm it):"));
    assert.ok(t.includes('- The payment takes 4 AP3X (4000000 lovelace) from the vault: price + buyer bond + supplier bond.'));
    assert.ok(t.includes('- per_tx of the delegation is 1 AP3X (1000000 lovelace). The payment is above it.'));
    assert.ok(t.includes('- The spending of the period after this payment would be 4 AP3X (4000000 lovelace). total is 100 AP3X (100000000 lovelace). The spending is within it. The period is 86400000 ms, and this payment starts a new period.'));
    assert.ok(t.includes('1. The node judged the draft against the chain as it is now. Lower the payment'));
    const draft = n.evaluations[n.evaluations.length - 1];
    assert.ok(!t.includes(draft.slice(0, 64)), 'the draft transaction is not printed');
    assert.doesNotMatch(t, /Unsigned TX CBOR|Required signers|# Vault Payment Built/);
  });

  test('a payment past total: the reading shows the spending above total and the payment within per_tx', async () => {
    withNode(held({ vault: vaultUtxo(liveVault({ spent: 99_000_000n, periodStart: Date.now() - 3_600_000 })) }));
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it.'), t);
    assert.ok(t.includes('- per_tx of the delegation is 50 AP3X (50000000 lovelace). The payment is within it.'));
    assert.ok(t.includes('- The spending of the period after this payment would be 103 AP3X (103000000 lovelace). total is 100 AP3X (100000000 lovelace). The spending is above it. The period is 86400000 ms.'));
  });

  test('a refusal for a rule of the reading that both figures pass says so: the figures are within the limits, so the cause is another rule', async () => {
    withNode(held({ delegation: delegationUtxo(delegation({ delegator: { type: 'PrincipalKey', hash: '99'.repeat(28), organisation: null }, notBefore: Date.now() - DAY, notAfter: Date.now() + 30 * DAY })) }));
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it.'), t);
    assert.ok(t.includes('- Both figures are within the limits. By this reading the refusal is for another rule of the vault script: the use checks of the delegation, the delegator, the other assets of the vault, or the value cap of an escrow.'));
  });

  test('the index names the vault input wherever the vault output sits among the inputs', async () => {
    const indexes: number[] = [];
    for (const txHash of ['00'.repeat(32), 'ff'.repeat(32)]) {
      const ref = `${txHash}#0`;
      withNode(held({ vault: vaultUtxo(liveVault(), 100_000_000n, 0, { txHash }), delegation: tight() }));
      const t = await answer({ vault_ref: ` ${ref.toUpperCase()} ` });
      const place = placeOf(t, ref);
      assert.ok(place, t);
      assert.match(t, new RegExp(`Spend\\[${place[1]}\\]`), 'the evaluator named the same input');
      indexes.push(Number(place[1]));
    }
    assert.ok(indexes[0] === 0 && indexes[1] > 0, `the vault output is the first input, then the last: ${indexes}`);
  });

  test('a validator that is not the vault script is not called the vault script: an index with no input, another input, a purpose that is not spend', async () => {
    const cases: Array<[string, (validator: ValidatorBody) => void, RegExp]> = [
      ['an index with no input', (v) => { v.validator.index = 99; }, /1\. purpose spend, index 99: the draft has no input 99, so the builder cannot map this validator\./],
      ['an input that is not the vault output', (v) => { v.validator.index = 0; }, /1\. purpose spend, index 0: input 0 of the draft is `[0-9a-f]{64}#\d+`, which is not the vault output, so the builder cannot map this validator to the vault script\./],
      ['a purpose that is not spend', (v) => { v.validator.purpose = 'mint'; }, /1\. purpose mint, index \d+: the draft of a vault payment runs one script, the vault script on a spend, so the builder cannot map this validator\./],
    ];
    for (const [why, patch, words] of cases) {
      const n = withNode(held({ vault: vaultUtxo(liveVault(), 100_000_000n, 0, { txHash: 'ff'.repeat(32) }), delegation: tight() }));
      answering(n, 'above_per_tx', patch);
      const t = await answer({ vault_ref: `${'ff'.repeat(32)}#0` });
      assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it.'), `${why}: ${t}`);
      assert.match(t, words, why);
      assert.doesNotMatch(t, /so this is the vault script/, why);
    }
  });

  test('text from the node is escaped: a newline, a pipe, a backtick, a heading and a fence in a message, a trace or the detail stay in one line', async () => {
    const hostile = 'line one\n## Injected heading\n```json\n{"x":1}\n``` | cell `tick`';
    const n = withNode(held({ delegation: tight() }));
    answering(n, 'above_per_tx', (v) => { v.error.message = hostile; v.error.data.validationError = hostile; v.error.data.traces = [hostile, 'second']; }, (body) => { body.error.message = hostile; });
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it.'), t);
    assert.ok(!t.includes('\n## Injected'));
    assert.ok(!t.includes('```'), 'no code fence comes from the node');
    assert.ok(t.includes('Traces: "line one ## Injected heading \'\'\'json {"x":1} \'\'\' ¦ cell \'tick\'", "second".'), t);
    assert.ok(!t.includes('Traces: none'), 'traces that exist are not called none');
    assert.ok(t.includes('detail: "line one ## Injected heading \'\'\'json {"x":1} \'\'\' ¦ cell \'tick\'"'), t);
    assert.ok(t.includes('Node answer: code 3012, "line one ## Injected heading \'\'\'json {"x":1} \'\'\' ¦ cell \'tick\'"; detail: '), t);
    assert.ok(t.includes('(the answer of the ledger: 3010 line one ## Injected heading \'\'\'json {"x":1} \'\'\' ¦ cell \'tick\'):'), t);
  });

  test('a trace list that the node did not give is not called none: an absent list, a text and a list of other values say that the builder cannot read a list; an empty list says none', async () => {
    const unreadable = 'Traces: the node gave no trace list that the builder can read, so the builder cannot tell whether the node names a rule.';
    const cases: Array<[string, (data: { traces?: unknown }) => void]> = [
      ['an absent list', (data) => { delete data.traces; }],
      ['a text', (data) => { data.traces = 'one trace'; }],
      ['a list of other values', (data) => { data.traces = [{ x: 1 }, 42]; }],
      ['a list with more than texts', (data) => { data.traces = ['first', 7]; }],
    ];
    for (const [why, set] of cases) {
      const n = withNode(held({ delegation: tight() }));
      answering(n, 'above_per_tx', (v) => { set(v.error.data); });
      const t = await answer();
      assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it.'), `${why}: ${t}`);
      assert.ok(t.includes(`   ${unreadable}\n`), `${why}: ${t}`);
      assert.ok(!t.includes('Traces: none'), `${why}: the builder does not say none`);
    }
    withNode(held({ delegation: tight() }));
    assert.ok((await answer()).includes('   Traces: none. The deployed scripts carry no trace messages, so the node does not name the rule that failed.\n'), 'an empty list is none');
  });

  test('text from the node is escaped in the answer for an evaluation that did not happen too', async () => {
    const hostile = 'line one\n## Injected heading\n```json\n{"x":1}\n``` | cell `tick`';
    const n = withNode(held());
    answering(n, 'past_horizon', () => {}, (body) => { body.error.message = hostile; });
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the node did NOT evaluate'), t);
    assert.ok(!t.includes('\n## Injected') && !t.includes('```'));
    assert.ok(t.includes('**What the node said:** 3010 line one ## Injected heading \'\'\'json {"x":1} \'\'\' ¦ cell \'tick\'\n'), t);
  });

  test('an evaluation that did not happen is no refusal: the 3004 of the era horizon is shown with its code and a cut of its detail', async () => {
    const n = withNode(held());
    answering(n, 'past_horizon');
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the node did NOT evaluate the scripts of the payment. This is not a refusal by the ledger, and it is no verdict on the payment: no validator failed. Nothing was signed or submitted.\n'), t);
    assert.doesNotMatch(t, /LEDGER refused/);
    assert.ok(t.includes('**What the node said:** 3010 Some scripts of the transactions terminated with error(s).'));
    assert.match(t, /1\. purpose spend, index \d+: Node answer: code 3004, "Unable to create the evaluation context/);
    assert.ok(t.includes('…'), 'the long detail is cut');
    assert.ok(t.length < 2_500, `the 6,685 characters of the detail are not shown: ${t.length}`);
  });

  test('an answer that the provider cut or dropped says that the builder cannot tell whether a validator failed: it is no refusal, and it never says that none failed', async () => {
    const cases: Array<[string, (v: ValidatorBody) => void]> = [
      ['cut', (v) => { v.error.data.traces = ['x'.repeat(40_000)]; }],
      ['dropped', (v) => { v.error.data.traces = ['x'.repeat(OGMIOS_ERROR_DATA_INPUT_LIMIT)]; }],
    ];
    for (const [why, patch] of cases) {
      const n = withNode(held({ delegation: tight() }));
      answering(n, 'above_per_tx', patch);
      const t = await answer();
      assert.ok(t.startsWith('Failed to build vault payment: the node answered the evaluation with an error, and the builder could not read the data of the error in full: the provider cut it or dropped it. The builder cannot tell whether a validator failed, so it gives no verdict on the payment: the ledger may have refused it. Nothing was signed or submitted.\n'), `${why}: ${t}`);
      assert.doesNotMatch(t, /did NOT evaluate|This is not a refusal|no validator failed|LEDGER refused/, why);
      assert.ok(t.includes('**What the node said:** 3010 Some scripts of the transactions terminated with error(s).'), why);
      assert.ok(t.includes('\n1. Build again without ledger_decides: the builder then checks the rules itself, and Lucid runs the vault script on this machine.'), why);
    }
  });

  test('a payment that the builder cannot build is told as that, with its reason, and the node is not asked', async () => {
    const n = withNode(held().filter((u) => u.address !== DEPLOYMENT.delegation.address));
    const t = await answer();
    assert.ok(t.startsWith(`Failed to build vault payment: The builder cannot build this payment, and it did not ask the node to evaluate it (reason: no_delegation). No live delegation ${DELEGATION_ID}: it does not exist or has been undelegated.\n\n**Troubleshooting Tips:**\n1. `), t);
    assert.equal(n.evaluations.length, 0);
    assert.doesNotMatch(t, /LEDGER|did NOT evaluate/);
    assert.doesNotMatch(t, /Pass ledger_decides: true to let the node judge the payment/, 'with the flag the tip about the flag is not repeated');
  });

  test('a node that does not answer is no verdict: the plain failure, not a refusal and not an impossible payment', async () => {
    const n = withNode(held());
    Object.assign(n, { getUtxosByOutRef: async () => { throw new Error('Ogmios request failed (queryLedgerState/utxo): 503 Service Unavailable'); } });
    const t = await answer();
    assert.match(t, /^Failed to build vault payment: Ogmios request failed \(queryLedgerState\/utxo\): 503 Service Unavailable\n\n\*\*Troubleshooting Tips:\*\*/);
    assert.doesNotMatch(t, /LEDGER|did NOT evaluate|cannot build this payment/);
  });

  test('without the flag a refusal of a limit says who refuses and how to let the node judge it, and the tips name the flag', async () => {
    withNode(held({ delegation: tight() }));
    globalThis.fetch = chainFake({ live: [advertUtxo()], listed: [listedRow()] }).f;
    const t = await call(PAY_TOOL, pay);
    assert.match(t, /^Failed to build vault payment: The payment of 4 AP3X \(4000000 lovelace\) is above the per-transaction limit of delegation [0-9a-f]{64}: per_tx is 1 AP3X \(1000000 lovelace\)\. The payment is what the hire takes from the vault: price \+ buyer bond \+ supplier bond\. The vault contract refuses the same payment on chain \(Pay: amount <= per_tx\)\. Pass ledger_decides: true to let the node judge it\.\n\n\*\*Troubleshooting Tips:\*\*\n1\. /);
    assert.match(t, /\n4\. Pass ledger_decides: true to let the node judge the payment: the builder then skips its own checks of per_tx, total, the use checks, the delegator, the other assets of the vault, the value cap, the indexer listing and the listing rule/);
  });

  test('without the flag the tip about ledger_decides goes only to a refusal of a check that the flag skips, by the type of the error: not to a Returned vault, a delegation without a value limit, the rest below the minimum, a rule of the builder alone, or text of a supplier that holds the hint', async () => {
    const listed = chainFake({ live: [advertUtxo()], listed: [listedRow()] }).f;
    /** The answer to a payment that the builder refuses (the node holds `utxos`; Koios and the indexer are `fetchImpl`): the message and the tips apart. */
    const failureOf = async (utxos: UTxO[], fetchImpl: typeof fetch = listed) => {
      withNode(utxos);
      globalThis.fetch = fetchImpl;
      const t = await call(PAY_TOOL, pay);
      assert.ok(t.startsWith('Failed to build vault payment: '), t);
      const at = t.indexOf('**Troubleshooting Tips:**');
      return { message: t.slice(0, at), tips: t.slice(at) };
    };
    const owner = { type: 'PrincipalKey' as const, hash: OWN_PKH, organisation: null };
    const advertAt = (over: Partial<typeof IDENTITY_ADVERT>): typeof fetch => chainFake({ live: [advertUtxo({ ...IDENTITY_ADVERT, ...over })], listed: [listedRow()] }).f;
    const unchanged: Array<[string, UTxO[], typeof fetch | undefined]> = [
      ['a Returned vault', held({ vault: vaultUtxo({ type: 'Returned', owner }) }), undefined],
      ['a delegation without a value limit', held({ delegation: delegationUtxo(delegation({ notBefore: Date.now() - DAY, notAfter: Date.now() + 30 * DAY, value: null })) }), undefined],
      ['the rest below the minimum', held({ vault: vaultUtxo(liveVault(), 5_000_000n) }), undefined],
      ['an advert that the indexer does not list', held(), chainFake({ live: [advertUtxo()], listed: [] }).f],
      ['a retired advert', held(), advertAt({ status: 'Retired' })],
    ];
    for (const [why, utxos, fetchImpl] of unchanged) assert.doesNotMatch((await failureOf(utxos, fetchImpl)).tips, /ledger_decides/, `${why}: the flag changes nothing here`);
    // The refusal shows the capability id of the advert, which the supplier writes. An id that holds the sentence of the hint is no mark.
    const hint = 'Pass ledger_decides: true to let the node judge it.';
    const hostile: Array<[string, typeof fetch]> = [
      ['a fleet capability', advertAt({ capability_id: `llm.chat.${hint}` })],
      ['a capability that the agent does not list (the listing rule)', advertAt({ capability_id: `demo.${hint}` })],
    ];
    for (const [why, fetchImpl] of hostile) {
      const { message, tips } = await failureOf(held(), fetchImpl);
      assert.ok(message.includes(hint), `${why}: the refusal shows the id of the supplier, which holds the sentence`);
      assert.doesNotMatch(tips, /ledger_decides/, `${why}: text of a supplier is no mark`);
    }
    assert.match((await failureOf(held({ delegation: tight() }))).tips, /\n4\. Pass ledger_decides: true to let the node judge the payment: the builder then skips its own checks of per_tx, total,/, 'a refusal of per_tx');
    assert.match((await failureOf(held({ vault: vaultUtxo(liveVault({ spent: 99_000_000n, periodStart: Date.now() - 3_600_000 })) }))).tips, /\n4\. Pass ledger_decides: true to let the node judge the payment: the builder then skips/, 'a refusal of total');
    const capped = await failureOf(held(), advertAt({ price_lovelace: MAX_ESCROW_LOVELACE + 1_000_000n }));
    assert.match(capped.message, /value cap of an escrow \(F-29\)/);
    assert.match(capped.tips, /\n4\. Pass ledger_decides: true to let the node judge the payment: the builder then skips/, 'a refusal of the value cap');
    assert.match((await failureOf(twoHopWorld({ now: Date.now(), parent: false }))).tips, /\n4\. Pass ledger_decides: true to let the node judge a draft that lacks the parent delegation\. The builder then does not refuse the gap, and it skips its other checks too; the answer shows the verdict of the node/, 'a gap in the chain');
  });

  test('with the flag the tip to pass it is never given, whatever the error is: the builder skipped those checks already', async () => {
    const n = withNode(held());
    // An error of the type that the mark reads, raised by a call to the node: with the flag no check of the builder raises it, so only this can show the rule.
    Object.assign(n, { getUtxosByOutRef: async () => { throw new ChainGapError({ missing: PARENT_ID, child: DELEGATION_ID }); } });
    const t = await answer();
    assert.match(t, /^Failed to build vault payment: The parent delegation 9a9a[0-9a-f]* of dddd[0-9a-f]* no longer exists/);
    assert.doesNotMatch(t, /Pass ledger_decides/, 'the flag is passed');
  });

  test('an ancestor delegation that was undelegated: the node judges the draft without it, and the answer names the missing parent; the twin with every hop builds', async () => {
    const now = Date.now();
    withNode(twoHopWorld({ now }));
    assert.ok((await answer()).startsWith('# Vault Payment Built (Unsigned, Not Submitted)\n'), 'the twin with every hop builds');
    withNode(twoHopWorld({ now, parent: false }));
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it.'), t);
    assert.ok(t.includes(`- The builder found no output for the parent delegation ${PARENT_ID} of ${DELEGATION_ID}: it was undelegated, or it is not confirmed yet. The draft has no reference input for it. The vault script needs every ancestor of the delegation, so it cannot pass with this chain: it fails at the gap, or at an earlier check of the links below it.`), t);
    assert.doesNotMatch(t, /so it fails there/, 'the builder skipped the checks of the links below the gap, so it cannot say that the gap is where the script fails');
    assert.ok(t.includes('Ask the delegator for a new delegation. An undelegated parent ends every delegation below it.'));
    assert.doesNotMatch(t, /Both figures are within the limits/, 'the gap is the reading, not the figures');
    globalThis.fetch = chainFake({ live: [advertUtxo()], listed: [listedRow()] }).f;
    assert.match(await call(PAY_TOOL, pay), /^Failed to build vault payment: The parent delegation 9a9a[0-9a-f]* of dddd[0-9a-f]* no longer exists \(undelegated\), so the chain cannot be used\.\n/);
  });

  test('a gap with another fault below it: the answer does not say that the gap is where the script fails', async () => {
    const now = Date.now();
    withNode(twoHopWorld({ now, parent: false }).map((u) => (u.assets[`${DEPLOYMENT.identity.hash}${DELEGATE_ID}`] === undefined ? u : delegateRecord({ keys: [] }))));
    const t = await answer();
    assert.ok(t.startsWith('Failed to build vault payment: the LEDGER refused it.'), t);
    assert.ok(t.includes('it cannot pass with this chain: it fails at the gap, or at an earlier check of the links below it.'), t);
    assert.doesNotMatch(t, /so it fails there/);
  });
});

describe('the vault script address of the deployment', () => {
  test('is the applied vault script\'s enterprise address', () => {
    assert.match(DEPLOYMENT.vault.address, /^addr1w/);
    assert.equal(liveVault().type, 'Live');
  });
});
