// packages/builder/test/integration/keyless-build.test.ts
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CML } from '@lucid-evolution/lucid';
import { startServer, stopServer, callTool, ServerContext } from '../setup.ts';

// The funded shared testnet wallet's ADDRESS — public information. This suite
// proves the keyless family builds real transactions against the live chain
// while holding zero secrets: no mnemonic anywhere in this file.
const OWN_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';

// Always-succeeds PlutusV2 validator (accepts any datum/redeemer/context, returns True)
const ALWAYS_SUCCEEDS_V2 = '49480100002221200101';

function extractCbor(text: string): string {
  const m = text.match(/```\n([0-9a-fA-F]+)\n```/);
  assert.ok(m, `no CBOR block in tool response:\n${text.slice(0, 500)}`);
  return m[1];
}

// Handler-level pin for "build tools never render a submitted claim" (folded
// in from Task 4's opus review). The forbidden pattern excludes literal "Not
// Submitted" via a negative lookbehind rather than a blanket allow:
// vector_build_transaction's own correct heading is "Unsigned Transaction
// Built (Not Submitted)", and a bare /Submitted\b/ would flag that required
// phrasing as a false positive — \b only anchors the boundary *after* the
// word, not before it, so "(Not Submitted)" satisfies "Submitted\b" too.
// Verified empirically against every tier-1 handler's actual response text;
// the fixed pattern still catches a real "# Transaction Submitted" claim.
function assertBuildNotSubmitted(text: string): void {
  assert.doesNotMatch(text, /Transaction Submitted|(?<!Not )Submitted\b/);
  assert.match(text, /Unsigned|NOT been submitted|Not Submitted/i);
}

let ctx: ServerContext;
before(async () => { ctx = await startServer(); });
after(async () => { await stopServer(ctx); });

describe('keyless build against live testnet', () => {
  test('vector_build_send_apex builds a real, decodable, UNSIGNED self-send', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_send_apex', {
      changeAddress: OWN_ADDRESS, recipientAddress: OWN_ADDRESS, amount: 3,
    });
    const cbor = extractCbor(text);
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const outs = tx.body().outputs();
    let paid = 0n;
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i);
      assert.equal(o.address().to_bech32(), OWN_ADDRESS, 'self-send must only pay the own address');
      paid += BigInt(o.amount().coin().toString());
    }
    const fee = BigInt(tx.body().fee().toString());
    assert.ok(fee >= 156_253n && fee <= 500_000n, `fee out of sane range: ${fee}`);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'hosted builder returned a SIGNED transaction');
    assert.ok(paid >= 3_000_000n, 'outputs below the requested amount');
    assertBuildNotSubmitted(text);
  });

  test('vector_dry_run accepts the unsigned CBOR and reports it valid', { timeout: 120_000 }, async () => {
    const buildText = await callTool(ctx.client, 'vector_build_send_apex', {
      changeAddress: OWN_ADDRESS, recipientAddress: OWN_ADDRESS, amount: 3,
    });
    const cbor = extractCbor(buildText);
    const text = await callTool(ctx.client, 'vector_dry_run', { txCbor: cbor });
    assert.match(text, /Valid: Yes/);
  });

  test('a bogus change address fails with a clear error, not a network error', { timeout: 60_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_send_apex', {
      changeAddress: 'addr1notreal', recipientAddress: OWN_ADDRESS, amount: 3,
    });
    assert.match(text, /Invalid change address/);
  });

  // --- Controller additions (Task 4's opus review): handler-level coverage
  // for the remaining three build tools, still no secrets, no funds spent. ---

  test('vector_build_transaction builds a real, decodable, UNSIGNED multi-output self-send', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_transaction', {
      changeAddress: OWN_ADDRESS,
      outputs: [
        { address: OWN_ADDRESS, lovelace: 2_000_000 },
        { address: OWN_ADDRESS, lovelace: 2_000_000 },
      ],
    });
    const cbor = extractCbor(text);
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const outs = tx.body().outputs();
    let matchingOutputs = 0;
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i);
      assert.equal(o.address().to_bech32(), OWN_ADDRESS, 'self-send must only pay the own address');
      if (BigInt(o.amount().coin().toString()) === 2_000_000n) matchingOutputs++;
    }
    assert.ok(matchingOutputs >= 2, `expected both requested 2 AP3X outputs present, found ${matchingOutputs}`);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'hosted builder returned a SIGNED transaction');
    assertBuildNotSubmitted(text);
  });

  test('vector_build_deploy_contract builds a real, decodable, UNSIGNED contract deployment', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_deploy_contract', {
      changeAddress: OWN_ADDRESS,
      scriptCbor: ALWAYS_SUCCEEDS_V2,
      scriptType: 'PlutusV2',
    });
    assert.match(text, /Script Address:/);
    const cbor = extractCbor(text);
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'hosted builder returned a SIGNED transaction');
    assertBuildNotSubmitted(text);
  });

  test('vector_build_interact_contract (lock) builds a real, decodable, UNSIGNED contract interaction', { timeout: 120_000 }, async () => {
    const text = await callTool(ctx.client, 'vector_build_interact_contract', {
      changeAddress: OWN_ADDRESS,
      scriptCbor: ALWAYS_SUCCEEDS_V2,
      scriptType: 'PlutusV2',
      action: 'lock',
      datum: 'd87980',
      lovelaceAmount: 2_000_000,
    });
    assert.match(text, /\*\*Action:\*\* lock/);
    const cbor = extractCbor(text);
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const vkeys = tx.witness_set().vkeywitnesses();
    assert.ok(vkeys === undefined || vkeys.len() === 0, 'hosted builder returned a SIGNED transaction');
    assertBuildNotSubmitted(text);
  });
});
