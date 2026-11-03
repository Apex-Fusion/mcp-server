// packages/builder/test/wallet-tools.test.ts
// Handler-level tests of the wallet build tools and vector_dry_run (vector.ts): a minimal fake server captures the handlers, and the
// node is a FixtureProvider handed in as registerVectorTools's nodeFor, with Ogmios's evaluateTransaction stubbed. The builds are real
// (Lucid against the fixture ledger; the contract spend runs the always-succeeds script with Lucid's own evaluator). No network.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CML, applyDoubleCborEncoding, getAddressDetails, validatorToAddress } from '@lucid-evolution/lucid';
import type { SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVectorTools } from '../src/vector/vector.ts';
import type { BuildNode } from '../src/vector/vector.ts';
import { FixtureProvider, FIXTURE_UTXOS, FIXTURE_TXHASH, FIXTURE_TOKEN_UNIT, FOREIGN_ADDRESS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const serverOf = (into: Map<string, Handler>) => ({ tool: (name: string, _d: string, _s: unknown, handler: Handler) => { into.set(name, handler); } }) as unknown as McpServer;
// The node the tools talk to is whatever the running test put in `node`.
let node: BuildNode | undefined;
afterEach(() => { node = undefined; });
const handlers = new Map<string, Handler>();
registerVectorTools(serverOf(handlers), 'wallet-tools-test', () => { if (!node) throw new Error('this test set no node'); return node; });
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} is registered`);
  const out = await handler(args);
  assert.equal(out.content.length, 1);
  return out.content[0].text;
}

/** A node over `utxos` whose transaction evaluation answers with `evaluate` (Ogmios answers a transaction without scripts with []). */
const nodeOver = (utxos: UTxO[], evaluate: (cbor: string) => Promise<unknown> = async () => []): BuildNode =>
  Object.assign(new FixtureProvider(utxos), { evaluateTransaction: evaluate });

const JSON_FENCE = '\n```json\n';
const jsonOf = (t: string) => JSON.parse(t.slice(t.lastIndexOf(JSON_FENCE) + JSON_FENCE.length, t.lastIndexOf('\n```')));
const cborOf = (t: string): string => {
  const m = /\*\*Unsigned TX CBOR:\*\*\n```\n([0-9a-f]+)\n```/.exec(t);
  assert.ok(m, `no unsigned CBOR in: ${t.slice(0, 300)}`);
  return m[1];
};
const bodyOf = (cbor: string) => CML.Transaction.from_cbor_hex(cbor).body();
const hashOf = (cbor: string) => CML.hash_transaction(bodyOf(cbor)).to_hex();
const OWN_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;

/** The payment key hashes of the key-locked outputs that the transaction spends (inputs and collateral), looked up in `ledger`. */
function spendingKeys(cbor: string, ledger: UTxO[]): string[] {
  const body = bodyOf(cbor);
  const refs: string[] = [];
  for (const list of [body.inputs(), body.collateral_inputs()]) {
    for (let i = 0; list !== undefined && i < list.len(); i++) refs.push(`${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`);
  }
  const keys = refs.map((ref) => {
    const utxo = ledger.find((u) => `${u.txHash}#${u.outputIndex}` === ref);
    assert.ok(utxo, `input ${ref} is on the ledger`);
    const credential = getAddressDetails(utxo.address).paymentCredential;
    return credential?.type === 'Key' ? credential.hash : null;
  });
  return [...new Set(keys.filter((k): k is string => k !== null))];
}
/** The key hashes that the transaction body names as required signers. */
function namedSigners(cbor: string): string[] {
  const named = bodyOf(cbor).required_signers();
  if (named === undefined) return [];
  return Array.from({ length: named.len() }, (_, i) => named.get(i).to_hex());
}

/**
 * The answer lists every key that must sign, in the JSON block of the identity and marketplace tools: each key once, with its roles;
 * every key that owns a spent output, and every key that the body names, is listed, and no other. The JSON block names this very
 * transaction (hash and fee).
 */
function assertSignersOf(t: string, ledger: UTxO[]) {
  const cbor = cborOf(t);
  const j = jsonOf(t);
  assert.equal(j.tx_hash, hashOf(cbor));
  assert.equal(j.fee, bodyOf(cbor).fee().toString());
  assert.ok(Array.isArray(j.required_signers) && j.required_signers.length > 0, 'required_signers is listed');
  const listed: string[] = j.required_signers.map((s: { key_hash: string }) => s.key_hash);
  assert.equal(new Set(listed).size, listed.length, 'each key once');
  for (const s of j.required_signers) assert.ok(Array.isArray(s.roles) && s.roles.length > 0 && s.roles.every((r: unknown) => typeof r === 'string' && r.length > 0), JSON.stringify(s));
  const needed = [...new Set([...spendingKeys(cbor, ledger), ...namedSigners(cbor)])];
  assert.deepEqual([...listed].sort(), needed.sort(), 'the listed keys are exactly the keys that must sign');
  return j.required_signers as Array<{ key_hash: string; roles: string[] }>;
}

const ALWAYS_SUCCEEDS_V2 = '49480100002221200101';
const SCRIPT_ADDRESS = validatorToAddress('Mainnet', { type: 'PlutusV2', script: applyDoubleCborEncoding(ALWAYS_SUCCEEDS_V2) } satisfies SpendingValidator);

describe('the wallet build tools list their required signers', () => {
  test('the transfers: vector_build_send_apex, vector_build_send_tokens and vector_build_transaction', async () => {
    node = nodeOver(FIXTURE_UTXOS);
    const answers = [
      await call('vector_build_send_apex', { changeAddress: OWN_ADDRESS, recipientAddress: FOREIGN_ADDRESS, amount: 3 }),
      await call('vector_build_send_tokens', {
        changeAddress: OWN_ADDRESS, recipientAddress: FOREIGN_ADDRESS, policyId: FIXTURE_TOKEN_UNIT.slice(0, 56), assetName: FIXTURE_TOKEN_UNIT.slice(56), amount: '10',
      }),
      await call('vector_build_transaction', { changeAddress: OWN_ADDRESS, outputs: [{ address: FOREIGN_ADDRESS, lovelace: 2_000_000 }] }),
    ];
    for (const t of answers) {
      const signers = assertSignersOf(t, FIXTURE_UTXOS);
      assert.deepEqual(signers.map((s) => s.key_hash), [OWN_PKH], 'the wallet key, which owns every input');
      assert.ok(t.indexOf(OWN_PKH) < t.indexOf('**Unsigned TX CBOR:**'), 'the key is named before the transaction to sign');
    }
  });

  test('the contracts: vector_build_deploy_contract, and vector_build_interact_contract lock and spend', async () => {
    const scriptUtxo: UTxO = { txHash: FIXTURE_TXHASH, outputIndex: 7, address: SCRIPT_ADDRESS, assets: { lovelace: 2_000_000n }, datum: 'd87980' };
    const ledger = [...FIXTURE_UTXOS, scriptUtxo];
    node = nodeOver(ledger);
    const contract = { changeAddress: OWN_ADDRESS, scriptCbor: ALWAYS_SUCCEEDS_V2, scriptType: 'PlutusV2' };
    const deploy = await call('vector_build_deploy_contract', contract);
    const lock = await call('vector_build_interact_contract', { ...contract, action: 'lock', datum: 'd87980' });
    for (const t of [deploy, lock]) assert.deepEqual(assertSignersOf(t, ledger).map((s) => s.key_hash), [OWN_PKH]);
    assert.equal(jsonOf(deploy).script_address, SCRIPT_ADDRESS);

    // The spend names the wallet key in the body too (addSigner) and takes collateral from the wallet: one entry, both roles.
    const spend = await call('vector_build_interact_contract', { ...contract, action: 'spend', redeemer: 'd87980' });
    const cbor = cborOf(spend);
    assert.deepEqual(namedSigners(cbor), [OWN_PKH]);
    assert.ok((bodyOf(cbor).collateral_inputs()?.len() ?? 0) > 0, 'the spend has collateral');
    const [wallet, ...others] = assertSignersOf(spend, ledger);
    assert.equal(wallet.key_hash, OWN_PKH);
    assert.equal(wallet.roles.length, 2, 'the wallet and the named signer are one key with two roles');
    assert.deepEqual(others, []);
  });
});

describe('vector_dry_run', () => {
  const feeOf = (t: string) => {
    const m = /Estimated Fee: ([0-9.]+) AP3X \((\d+) lovelace\)/.exec(t);
    assert.ok(m, `no fee in: ${t}`);
    return { ap3x: m[1], lovelace: m[2] };
  };
  const built = async () => {
    const t = await call('vector_build_send_apex', { changeAddress: OWN_ADDRESS, recipientAddress: FOREIGN_ADDRESS, amount: 3 });
    return { cbor: cborOf(t), fee: String(jsonOf(t).fee) };
  };

  test('reports the fee that a given transaction declares, whether the evaluation passes or fails', async () => {
    node = nodeOver(FIXTURE_UTXOS);
    const { cbor, fee } = await built();
    assert.ok(BigInt(fee) > 0n);
    assert.equal(fee, bodyOf(cbor).fee().toString());
    const passed = await call('vector_dry_run', { txCbor: cbor });
    assert.match(passed, /^# Dry Run Result\n\nValid: Yes\n/);
    assert.deepEqual(feeOf(passed), { ap3x: (Number(fee) / 1e6).toFixed(6), lovelace: fee });

    node = nodeOver(FIXTURE_UTXOS, async () => { throw new Error('Ogmios request failed (evaluateTransaction): -32602'); });
    const failed = await call('vector_dry_run', { txCbor: cbor });
    assert.match(failed, /^# Dry Run Result\n\nValid: No\n/);
    assert.equal(feeOf(failed).lovelace, fee, 'a transaction that fails the evaluation still declares its fee');
  });

  test('reports the fee of the transaction it builds from outputs', async () => {
    node = nodeOver(FIXTURE_UTXOS);
    const t = await call('vector_dry_run', { changeAddress: OWN_ADDRESS, outputs: [{ address: FOREIGN_ADDRESS, lovelace: 2_000_000 }] });
    assert.match(t, /Valid: Yes/);
    const built = await call('vector_build_transaction', { changeAddress: OWN_ADDRESS, outputs: [{ address: FOREIGN_ADDRESS, lovelace: 2_000_000 }] });
    assert.equal(feeOf(t).lovelace, String(jsonOf(built).fee), 'the same outputs from the same wallet: the same fee');
    assert.ok(BigInt(feeOf(t).lovelace) > 0n);
  });

  test('a txCbor that is not a transaction is refused, with no fee and no evaluation', async () => {
    const asked: string[] = [];
    node = nodeOver(FIXTURE_UTXOS, async (cbor) => { asked.push(cbor); return []; });
    for (const txCbor of ['00', 'zz', 'a1']) {
      const t = await call('vector_dry_run', { txCbor });
      assert.match(t, /^Dry run failed: /, t);
      assert.ok(!/Estimated Fee/.test(t), t);
    }
    assert.deepEqual(asked, []);
  });
});
