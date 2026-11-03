// packages/signer/test/tools.test.ts
// Handler-level tests of the signer tools with a mocked input resolver: a minimal fake server captures the handlers, and the
// resolver is a map that stands in for Ogmios. No network, no stdio (the smoke suite boots the built server).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSignerTools } from '../src/tools.ts';
import { MnemonicKeySource } from '../src/keysource.ts';
import { publicKeyOf, signTransaction } from '../src/sign.ts';
import { decodeTransaction, type DecodedInput } from '../src/decode.ts';
import { outRefKey, type ResolvedOutput } from '../src/policy.ts';
import type { InputResolver } from '../src/resolve.ts';
import type { SignerConfig } from '../src/config.ts';

// Throwaway test mnemonic, shared with the other signer tests. Controls no funds.
const TEST_MNEMONIC = 'test walk nut penalty hip pave soap entry language right filter choice';
const SIGNER = new MnemonicKeySource(TEST_MNEMONIC).load();
const OTHER = new MnemonicKeySource(TEST_MNEMONIC, 1).load();
const SIGNER_KEY = publicKeyOf(SIGNER.privateKeyBech32);
const OTHER_KEY_HASH = publicKeyOf(OTHER.privateKeyBech32).keyHashHex;
const STRANGER = 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8';

const OWN_IN: DecodedInput = { txHash: '0a'.repeat(32), index: 0 };
const OTHER_IN: DecodedInput = { txHash: '0b'.repeat(32), index: 1 };

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const serverOf = (into: Map<string, Handler>) =>
  ({ tool: (name: string, _description: string, _shape: unknown, handler: Handler) => { into.set(name, handler); } }) as unknown as McpServer;

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'signer-tools-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

/** A registered signer with its own audit log; `resolver` stands in for Ogmios (null: resolution off). */
function signerWith(resolver: InputResolver | null) {
  const auditLogPath = join(dir, `audit-${Math.random().toString(16).slice(2)}.json`);
  const config: SignerConfig = {
    keySource: new MnemonicKeySource(TEST_MNEMONIC),
    limits: { perTxLovelace: 100_000_000n, dailyLovelace: 500_000_000n },
    auditLogPath,
    ogmiosUrl: resolver ? 'http://ogmios.test/' : null,
  };
  const handlers = new Map<string, Handler>();
  registerSignerTools(serverOf(handlers), config, resolver);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers.get(name);
    assert.ok(handler, `${name} is registered`);
    return (await handler(args)).content[0].text;
  };
  return { call, handlers, auditLogPath };
}

/** A resolver that knows these outputs and records what it was asked. */
function mapResolver(outputs: Array<[DecodedInput, ResolvedOutput]>) {
  const asked: string[][] = [];
  const resolver: InputResolver = async (inputs) => {
    asked.push(inputs.map(outRefKey));
    return new Map(outputs.filter(([input]) => inputs.some((i) => outRefKey(i) === outRefKey(input))).map(([input, o]) => [outRefKey(input), o]));
  };
  return { resolver, asked };
}

const at = (address: string, lovelace: bigint, paymentKeyHash: string | null): ResolvedOutput => ({ address, lovelace, paymentKeyHash });
const MULTI_PARTY_INPUTS: Array<[DecodedInput, ResolvedOutput]> = [
  [OWN_IN, at(SIGNER.address, 10_000_000n, SIGNER_KEY.keyHashHex)],
  [OTHER_IN, at(OTHER.address, 500_000_000n, OTHER_KEY_HASH)],
];

function txOf(inputs: DecodedInput[], outputs: Array<[string, bigint]>, fee = 200_000n): string {
  const list = CML.TransactionInputList.new();
  for (const input of inputs) list.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(input.txHash), BigInt(input.index)));
  const outs = CML.TransactionOutputList.new();
  for (const [address, lovelace] of outputs) outs.add(CML.TransactionOutput.new(CML.Address.from_bech32(address), CML.Value.from_coin(lovelace)));
  return CML.Transaction.new(CML.TransactionBody.new(list, outs, fee), CML.TransactionWitnessSet.new(), true, undefined).to_cbor_hex();
}

/** The other party funds 500 AP3X and pays a stranger 300; the signer puts in 10 and takes 10 back. */
const multiPartyTx = () => txOf([OWN_IN, OTHER_IN], [[STRANGER, 300_000_000n], [OTHER.address, 199_800_000n], [SIGNER.address, 10_000_000n]]);
const signedCborOf = (text: string) => text.match(/```\n([0-9a-f]+)\n```/)![1];

describe('vector_signer_get_public_key', () => {
  test('gives the public key and the key hash of the signing key, and the address', async () => {
    const t = await signerWith(null).call('vector_signer_get_public_key');
    assert.match(t, new RegExp(`^Public key \\(Ed25519, hex\\): ${SIGNER_KEY.publicKeyHex}$`, 'm'));
    assert.match(t, new RegExp(`^Key hash \\(blake2b-224, hex\\): ${SIGNER_KEY.keyHashHex}$`, 'm'));
    assert.match(t, new RegExp(`^Address: ${SIGNER.address}$`, 'm'));
    assert.ok(!t.includes(SIGNER.privateKeyBech32));
  });
});

describe('vector_signer_sign with resolved inputs (a mocked resolver)', () => {
  test('a 2-party round trip: the other party signs first, this signer second; the result carries both witnesses', async () => {
    const { resolver, asked } = mapResolver(MULTI_PARTY_INPUTS);
    const partlySigned = signTransaction(multiPartyTx(), OTHER.privateKeyBech32);
    const t = await signerWith(resolver).call('vector_signer_sign', { txCbor: partlySigned.signedCborHex });

    assert.match(t, /^# Signed/);
    assert.match(t, /Net outflow: 0\.200000 AP3X \(counted from this signer's own inputs/);
    assert.match(t, /Vkey witnesses: 2 \(1 of other keys, kept as they were, and this signer's\)/);
    assert.deepStrictEqual(asked, [[outRefKey(OWN_IN), outRefKey(OTHER_IN)]]);

    const signed = CML.Transaction.from_cbor_hex(signedCborOf(t));
    const list = signed.witness_set().vkeywitnesses()!;
    const before = CML.Transaction.from_cbor_hex(partlySigned.signedCborHex).witness_set().vkeywitnesses()!.get(0);
    assert.equal(list.len(), 2);
    assert.equal(list.get(0).to_cbor_hex(), before.to_cbor_hex(), 'the other party\'s witness is first and unchanged');
    assert.equal(list.get(1).vkey().hash().to_hex(), SIGNER_KEY.keyHashHex);
    const hash = CML.hash_transaction(signed.body()).to_raw_bytes();
    for (let i = 0; i < list.len(); i++) assert.ok(list.get(i).vkey().verify(hash, list.get(i).ed25519_signature()));
  });

  test('a multi-party transaction where the other party funds most inputs passes the limit; without resolution it is refused', async () => {
    const { resolver } = mapResolver(MULTI_PARTY_INPUTS);
    assert.match(await signerWith(resolver).call('vector_signer_sign', { txCbor: multiPartyTx() }), /^# Signed/);

    const refused = await signerWith(null).call('vector_signer_sign', { txCbor: multiPartyTx() });
    assert.match(refused, /^REFUSED\. Net outflow 500\.000000 AP3X exceeds the per-transaction limit/);
    assert.match(refused, /Outflow: counted as every output not to this signer's address, plus the fee \(fallback rule\), because input resolution is off/);
  });

  test('a transaction that spends the signer\'s inputs to a stranger is still limited', async () => {
    const { resolver } = mapResolver([[OWN_IN, at(SIGNER.address, 500_000_000n, SIGNER_KEY.keyHashHex)]]);
    const t = await signerWith(resolver).call('vector_signer_sign', { txCbor: txOf([OWN_IN], [[STRANGER, 499_800_000n]]) });
    assert.match(t, /^REFUSED\. Net outflow 500\.000000 AP3X exceeds the per-transaction limit/);
    assert.match(t, /Outflow: counted from this signer's own inputs/);
    assert.ok(!/Signed CBOR/.test(t));
  });

  test('a resolver that fails gives the fallback rule and says why', async () => {
    const failing: InputResolver = async () => { throw new Error('Ogmios answered HTTP 503'); };
    const t = await signerWith(failing).call('vector_signer_sign', { txCbor: multiPartyTx() });
    assert.match(t, /^REFUSED\. Net outflow 500\.000000 AP3X/);
    assert.match(t, /because input resolution failed \(Ogmios answered HTTP 503\)/);
  });

  test('an input that the resolver does not know gives the fallback rule', async () => {
    const { resolver } = mapResolver([MULTI_PARTY_INPUTS[0]]);
    const t = await signerWith(resolver).call('vector_signer_sign', { txCbor: multiPartyTx() });
    assert.match(t, new RegExp(`because input ${outRefKey(OTHER_IN)} was not found unspent`));
  });

  test('the audit log records the rule of each decision', async () => {
    const { resolver } = mapResolver(MULTI_PARTY_INPUTS);
    const s = signerWith(resolver);
    await s.call('vector_signer_sign', { txCbor: multiPartyTx() });
    await s.call('vector_signer_sign', { txCbor: txOf([OWN_IN], [[STRANGER, 499_800_000n]]) }); // OWN_IN resolves as 10 AP3X: still own-inputs
    const entries = JSON.parse(readFileSync(s.auditLogPath, 'utf8')) as Array<{ decision: string; rule: string; netOutflowLovelace: string }>;
    assert.deepStrictEqual(entries.map((e) => [e.decision, e.rule, e.netOutflowLovelace]), [['signed', 'own-inputs', '200000'], ['signed', 'own-inputs', '10000000']]);
  });
});

describe('vector_signer_decode_transaction with resolved inputs', () => {
  test('previews the own-inputs rule and the witnesses already present, and never says "signed"', async () => {
    const { resolver } = mapResolver(MULTI_PARTY_INPUTS);
    const partlySigned = signTransaction(multiPartyTx(), OTHER.privateKeyBech32).signedCborHex;
    const t = await signerWith(resolver).call('vector_signer_decode_transaction', { txCbor: partlySigned });
    assert.match(t, /\*\*Net outflow: 0\.200000 AP3X\*\* \(counted from this signer's own inputs/);
    assert.match(t, new RegExp(`Vkey witnesses already present: 1 \\(key hashes ${OTHER_KEY_HASH}\\)`));
    assert.match(t, /Policy: would be ALLOWED/);
    assert.ok(!/signed/i.test(t), 'the preview never contains the word "signed"');
  });

  test('names this signer\'s key among the witnesses when it already signed', async () => {
    const own = signTransaction(multiPartyTx(), SIGNER.privateKeyBech32).signedCborHex;
    const t = await signerWith(null).call('vector_signer_decode_transaction', { txCbor: own });
    assert.match(t, /this signer's key among them/);
    assert.equal(decodeTransaction(own).witnessKeyHashes[0], SIGNER_KEY.keyHashHex);
  });
});

describe('vector_signer_get_spend_limits', () => {
  test('names the input resolution setting by host only, and the rule it gives', async () => {
    const { resolver } = mapResolver([]);
    const on = await signerWith(resolver).call('vector_signer_get_spend_limits');
    assert.match(on, /^Input resolution: on \(Ogmios at ogmios\.test\)$/m);
    assert.match(on, /^Outflow rule: the value of this signer's own inputs/m);
    const off = await signerWith(null).call('vector_signer_get_spend_limits');
    assert.match(off, /^Input resolution: off \(VECTOR_SIGNER_OGMIOS_URL is not set\)$/m);
    assert.match(off, /^Outflow rule: every output not to this signer, plus the fee$/m);
  });
});
