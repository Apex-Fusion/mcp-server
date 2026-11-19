// packages/builder/test/address-check.test.ts
// Every address is read through addressDetails (guarded-decode.ts): the empty string is refused with the message that Lucid gives for text
// that is not an address, and the decoder does not see it. A text of more than 1,024 characters is refused too, in a short time, with a
// message that does not hold the text. The tests: the function itself, and the wallet tools, with an address in each place where a tool
// takes one (the answer is the one for any text that is not an address, and the empty string and a long text do not reach the decoder).
// The sites test names each direct call of getAddressDetails (cbor-guard-sites.test.ts).
import { afterEach, describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CML, getAddressDetails } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addressDetails } from '../src/vector/guarded-decode.ts';
import { registerVectorTools } from '../src/vector/vector.ts';
import { FIXTURE_TOKEN_UNIT, FIXTURE_UTXOS, FixtureProvider, FOREIGN_ADDRESS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';

/** A text of `length` characters, all of them base58 characters: the text that Lucid takes the most time to refuse. */
const base58 = (length: number): string => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.repeat(Math.ceil(length / 58)).slice(0, length);

afterEach(() => { mock.restoreAll(); });

describe('addressDetails', () => {
  test('refuses the empty string with the message that Lucid gives for text that is not an address, and no decoder is called', () => {
    const reads = [mock.method(CML.Address, 'from_hex'), mock.method(CML.Address, 'from_bech32')];
    assert.throws(() => addressDetails(''), (err: unknown) => err instanceof Error && err.message === 'No address type matched for: ');
    assert.deepEqual(reads.map((read) => read.mock.callCount()), [0, 0]);
  });

  test('gives what getAddressDetails gives for an address, and the same refusal for text that is not one', () => {
    for (const address of [OWN_ADDRESS, FOREIGN_ADDRESS]) assert.deepEqual(addressDetails(address), getAddressDetails(address));
    for (const text of ['not an address', 'addr1', '00', '61', 'zz']) {
      assert.throws(() => addressDetails(text), (err: unknown) => err instanceof Error && err.message === `No address type matched for: ${text}`, text);
    }
  });

  test('a text of 1,024 characters gets the answer that it got before, and Lucid reads it', () => {
    const text = base58(1_024);
    const read = mock.method(CML.Address, 'from_bech32');
    assert.throws(() => addressDetails(text), (err: unknown) => err instanceof Error && err.message === `No address type matched for: ${text}`);
    assert.ok(read.mock.callCount() > 0, 'Lucid read the text');
  });

  test('a text of 1,025 characters, and one of 131,072, are refused in under 5 ms, before a decoder reads them, with the length and the first 40 characters', () => {
    const reads = [mock.method(CML.Address, 'from_hex'), mock.method(CML.Address, 'from_bech32'), mock.method(CML.ByronAddress, 'from_base58')];
    for (const length of [1_025, 131_072]) {
      const text = `${'a'.repeat(40)}B${base58(length - 41)}`;
      const started = performance.now();
      assert.throws(() => addressDetails(text), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, `The text has ${length} characters, and an address has at most 1024. It starts with: ${'a'.repeat(40)}`);
        return true;
      });
      assert.ok(performance.now() - started < 5, `${length} characters took ${performance.now() - started} ms`);
    }
    assert.deepEqual(reads.map((read) => read.mock.callCount()), [0, 0, 0]);
  });
});

describe('the wallet tools, with an empty address in each place', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  const handlers = new Map<string, Handler>();
  const server = { tool: (name: string, _description: string, _shape: unknown, handler: Handler) => { handlers.set(name, handler); } } as unknown as McpServer;
  registerVectorTools(server, 'address-check-test', () => Object.assign(new FixtureProvider(FIXTURE_UTXOS), { evaluateTransaction: async () => [] }));
  const outputs = (address: string) => [{ address, lovelace: 2_000_000 }];
  const token = { policyId: FIXTURE_TOKEN_UNIT.slice(0, 56), assetName: FIXTURE_TOKEN_UNIT.slice(56), amount: '10' };
  const script = { scriptCbor: '49480100002221200101', scriptType: 'PlutusV2' };
  const places: Array<[string, (address: string) => [string, Record<string, unknown>]]> = [
    ['the change address of a transfer', (a) => ['vector_build_send_apex', { changeAddress: a, recipientAddress: FOREIGN_ADDRESS, amount: 3 }]],
    ['the recipient of a transfer', (a) => ['vector_build_send_apex', { changeAddress: OWN_ADDRESS, recipientAddress: a, amount: 3 }]],
    ['the change address of a token transfer', (a) => ['vector_build_send_tokens', { changeAddress: a, recipientAddress: FOREIGN_ADDRESS, ...token }]],
    ['the recipient of a token transfer', (a) => ['vector_build_send_tokens', { changeAddress: OWN_ADDRESS, recipientAddress: a, ...token }]],
    ['the change address of a transaction', (a) => ['vector_build_transaction', { changeAddress: a, outputs: outputs(FOREIGN_ADDRESS) }]],
    ['an output of a transaction', (a) => ['vector_build_transaction', { changeAddress: OWN_ADDRESS, outputs: outputs(a) }]],
    ['the change address of a dry run (refused before an address is read: an empty string is no change address)', (a) => ['vector_dry_run', { changeAddress: a, outputs: outputs(FOREIGN_ADDRESS) }]],
    ['the change address of a deployment', (a) => ['vector_build_deploy_contract', { changeAddress: a, ...script }]],
    ['the change address of an interaction', (a) => ['vector_build_interact_contract', { changeAddress: a, ...script, action: 'lock', datum: 'd87980' }]],
  ];
  const ask = async (place: (address: string) => [string, Record<string, unknown>], address: string): Promise<string> => {
    const [name, args] = place(address);
    return (await handlers.get(name)!(args)).content[0].text;
  };

  for (const [what, place] of places) {
    test(`${what}: the answer is the one for text that is not an address, and the empty string does not reach the decoder`, async () => {
      const reads = [mock.method(CML.Address, 'from_hex'), mock.method(CML.Address, 'from_bech32')];
      const odd = await ask(place, 'not an address');
      const empty = await ask(place, '');
      if (what.includes('dry run')) assert.equal(empty, 'Dry run failed: changeAddress is required when building from outputs');
      else {
        assert.ok(odd.includes('No address type matched for: not an address'), odd);
        assert.equal(empty, odd.split('not an address').join(''));
      }
      for (const read of reads) assert.ok(!read.mock.calls.some((call) => call.arguments[0] === ''), 'the decoder did not read the empty string');
    });
  }

  for (const [what, place] of places) {
    test(`${what}: a text of 131,072 characters is refused at once, and the answer holds its length and its start, not the text`, async () => {
      const text = `${'a'.repeat(40)}B${base58(131_072 - 41)}`;
      const started = performance.now();
      const answer = await ask(place, text);
      assert.ok(performance.now() - started < 500, `the call took ${performance.now() - started} ms`);
      assert.ok(answer.includes(`The text has 131072 characters, and an address has at most 1024. It starts with: ${'a'.repeat(40)}`), answer);
      assert.ok(answer.length < 600 && !answer.includes('aB'), `the answer has ${answer.length} characters`);
    });
  }
});
