// packages/builder/test/ledger-read.test.ts
// What the reads of attestations, delegations and vaults share (ledger-read.ts): a Koios row as an output, the sole token of an output,
// the read of a script credential, the tip, the datum of a transaction input in Koios' JSON form, and paging. No network: the Koios
// here is the fake of fixtures/ledger-read-world.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Constr } from '@lucid-evolution/lucid';
import { DEFAULT_PAGE, KOIOS_ANSWER_BYTES, MAX_PAGE, READ_BUDGET_MS, BudgetSpent, TooManyMatches, credentialOutputs, credentialPage, dataOfKoiosJson, koiosTipHeight, pageOf, soleTokenName, utxoOfKoiosRow, withinBudget } from '../src/vector/ledger-read.ts';
import type { LedgerEnv } from '../src/vector/ledger-read.ts';
import { koiosCredentialPage } from '../src/vector/marketplace-indexer.ts';
import type { Page } from '../src/vector/ledger-read.ts';
import { blake2b } from '@noble/hashes/blake2b';
import { decodeAttestationDatum, decodeDelegationDatum, decodeVaultDatum, textOf, vaultDatumFromData } from '../src/vector/identity-codec.ts';
import { CAPTURE, MAINNET, MAINNET_VALUES, attestationIdOf, attestationUtxo, attestation, callsTo, endsWithin, koiosRow, ledgerKoios, ledgerWorld, utxoOf } from './fixtures/ledger-read-world.ts';
import type { LedgerKoios } from './fixtures/ledger-read-world.ts';
import { NEUTRAL_ORGANISATION } from './fixtures/capture-neutral.ts';

const ROW = CAPTURE.attestations[0];
const ID = attestationIdOf(ROW);

describe('the mainnet deployment', () => {
  test('the values of the published deployment give the published script hashes and addresses', () => {
    assert.equal(MAINNET.identity.hash, MAINNET_VALUES.identity);
    assert.equal(MAINNET.attestation.hash, MAINNET_VALUES.attestation);
    assert.equal(MAINNET.delegation.hash, MAINNET_VALUES.delegation);
    assert.equal(MAINNET.escrow.hash, MAINNET_VALUES.escrow);
    assert.equal(MAINNET.vault.hash, MAINNET_VALUES.vault);
    assert.equal(CAPTURE.hashes.attestation, MAINNET.attestation.hash);
    assert.equal(CAPTURE.hashes.delegation, MAINNET.delegation.hash);
    assert.equal(CAPTURE.hashes.vault, MAINNET.vault.hash);
    assert.equal(CAPTURE.hashes.escrow, MAINNET.escrow.hash);
  });
  test('every captured output sits at the address of its script', () => {
    for (const row of CAPTURE.attestations) assert.equal(row.address, MAINNET.attestation.address, `${row.tx_hash}#${row.tx_index}`);
    for (const row of CAPTURE.vaults) assert.equal(row.address, MAINNET.vault.address, `${row.tx_hash}#${row.tx_index}`);
    for (const d of [CAPTURE.delegations.live, CAPTURE.delegations.burned]) assert.equal(d.mint_output.address, MAINNET.delegation.address, d.id);
  });
});

describe('utxoOfKoiosRow', () => {
  test('a captured row becomes the output: its lovelace, its token and its inline datum', () => {
    const utxo = utxoOf(ROW);
    assert.equal(utxo.txHash, ROW.tx_hash);
    assert.equal(utxo.outputIndex, ROW.tx_index);
    assert.equal(utxo.address, MAINNET.attestation.address);
    assert.deepEqual(utxo.assets, { lovelace: 5_000_000n, [`${MAINNET.attestation.hash}${ID}`]: 1n });
    assert.equal(utxo.datum, ROW.inline_datum!.bytes);
  });
  test('a row without a datum has none; the tokens of one policy and name add up', () => {
    const utxo = utxoOfKoiosRow({ ...ROW, inline_datum: null, asset_list: [{ policy_id: 'ab'.repeat(28), asset_name: '01', quantity: '2' }, { policy_id: 'ab'.repeat(28), asset_name: '01', quantity: '3' }, { policy_id: 'cd'.repeat(28), asset_name: null, quantity: '1' }] });
    assert.equal(utxo!.datum, null);
    assert.deepEqual(utxo!.assets, { lovelace: 5_000_000n, [`${'ab'.repeat(28)}01`]: 5n, [`${'cd'.repeat(28)}`]: 1n });
  });
  test('a row that cannot be read as an output is null', () => {
    const bad: Array<[string, unknown]> = [
      ['null', null], ['no tx hash', { ...ROW, tx_hash: undefined }], ['short tx hash', { ...ROW, tx_hash: 'ab' }], ['no index', { ...ROW, tx_index: 'x' }], ['negative index', { ...ROW, tx_index: -1 }],
      ['no address', { ...ROW, address: undefined }], ['no value', { ...ROW, value: undefined }], ['a value that is not digits', { ...ROW, value: '5.0' }],
      ['an asset list that is not a list', { ...ROW, asset_list: {} }], ['a token with a short policy', { ...ROW, asset_list: [{ policy_id: 'ab', asset_name: '', quantity: '1' }] }],
      ['a token name that is not hex', { ...ROW, asset_list: [{ policy_id: 'ab'.repeat(28), asset_name: 'zz', quantity: '1' }] }],
      ['a token quantity that is not digits', { ...ROW, asset_list: [{ policy_id: 'ab'.repeat(28), asset_name: '', quantity: 'one' }] }], ['a token that is null', { ...ROW, asset_list: [null] }],
    ];
    for (const [what, row] of bad) assert.equal(utxoOfKoiosRow(row as typeof ROW), null, what);
  });
  test('a row with no asset list is an error and not an output without tokens: Koios gives the list only with the extended fields', () => {
    const without = (asset_list: null | undefined) => ({ ...ROW, asset_list }) as unknown as typeof ROW;
    for (const row of [without(null), without(undefined)]) assert.throws(() => utxoOfKoiosRow(row), /no asset list: the answer is incomplete/);
    assert.deepEqual(utxoOfKoiosRow({ ...ROW, asset_list: [] })!.assets, { lovelace: 5_000_000n }, 'an empty list is an output without tokens');
  });
});

describe('soleTokenName', () => {
  const at = MAINNET.attestation;
  const base = attestationUtxo(ID, attestation());
  test('an output at exactly the address with exactly one token of the policy has that token', () => {
    assert.equal(soleTokenName(base, at.address, at.hash), ID);
    assert.equal(soleTokenName(utxoOf(ROW), at.address, at.hash), ID);
  });
  test('another address, two tokens of the policy, a quantity of 2, or no token: none', () => {
    assert.equal(soleTokenName({ ...base, address: MAINNET.vault.address }, at.address, at.hash), null);
    assert.equal(soleTokenName({ ...base, assets: { ...base.assets, [`${at.hash}${'ee'.repeat(32)}`]: 1n } }, at.address, at.hash), null);
    assert.equal(soleTokenName({ ...base, assets: { lovelace: 5_000_000n, [`${at.hash}${ID}`]: 2n } }, at.address, at.hash), null);
    assert.equal(soleTokenName({ ...base, assets: { lovelace: 5_000_000n } }, at.address, at.hash), null);
  });
  test('a token of another policy does not count, and does not hide the token of the policy', () => {
    assert.equal(soleTokenName({ ...base, assets: { ...base.assets, [`${'99'.repeat(28)}${ID}`]: 1n } }, at.address, at.hash), ID);
  });
});

describe('credentialOutputs', () => {
  const POLICY = MAINNET.attestation.hash;
  test('asks Koios for the credential in pages of 500 with the datum filter, and reads the rows as outputs', async () => {
    const w = ledgerWorld([base()]);
    const outputs = await credentialOutputs(w.env, POLICY, { datumContains: 'AB'.repeat(32) }, 'narrow');
    assert.equal(outputs.length, 1);
    const [call] = callsTo(w.koios, 'credential_utxos');
    const q = new URL(call.url).searchParams;
    assert.equal(q.get('limit'), '500');
    assert.equal(q.get('inline_datum->>bytes'), `like.*${'ab'.repeat(32)}*`);
    assert.equal(q.has('asset_list'), false);
    assert.deepEqual(call.body, { _payment_credentials: [POLICY], _extended: true });
  });
  test('without a filter it asks for none', async () => {
    const w = ledgerWorld([base()]);
    await credentialOutputs(w.env, POLICY, {}, 'narrow');
    const q = new URL(callsTo(w.koios, 'credential_utxos')[0].url).searchParams;
    assert.deepEqual([q.has('inline_datum->>bytes'), q.has('asset_list')], [false, false]);
  });
  test('a token filter asks for the outputs that hold a token of the policy: containment on the asset list, and no filter on the datum', async () => {
    const w = ledgerWorld([base()]);
    assert.equal((await credentialOutputs(w.env, POLICY, { assetPolicy: POLICY.toUpperCase() }, 'narrow')).length, 1);
    const q = new URL(callsTo(w.koios, 'credential_utxos')[0].url).searchParams;
    assert.equal(q.get('asset_list'), `cs.[{"policy_id":"${POLICY}"}]`);
    assert.equal(q.has('inline_datum->>bytes'), false);
  });
  test('a token policy that is not 28 bytes of hex is refused before Koios is asked', async () => {
    const w = ledgerWorld([base()]);
    for (const assetPolicy of ['abc', 'zz'.repeat(28), POLICY.slice(2), `${POLICY}00`]) {
      await assert.rejects(() => credentialOutputs(w.env, POLICY, { assetPolicy }, 'narrow'), /asset policy must be 28 bytes of hex/, assetPolicy);
    }
    assert.equal(w.koios.calls.length, 0);
    assert.equal((await credentialOutputs(w.env, POLICY, { assetPolicy: POLICY }, 'narrow')).length, 1, 'the twin: a policy of 56 hex');
  });
  test('the token filter keeps outputs without a token off the count of 5,000: 5,001 of them and one attestation are one output', async () => {
    const template = koiosRow(base());
    const junk = Array.from({ length: 5_001 }, (_, i) => ({ ...template, tx_hash: i.toString(16).padStart(64, '0'), asset_list: [] }));
    const w = ledgerWorld([], { rows: [...junk, template] });
    assert.equal((await credentialOutputs(w.env, POLICY, { assetPolicy: POLICY }, 'narrow')).length, 1);
    await assert.rejects(() => credentialOutputs(w.env, POLICY, {}, 'narrow'), /5000 or more outputs match/, 'without the filter the same rows end the read');
  });
  test('a row that is not an output is left out', async () => {
    const w = ledgerWorld([], { rows: [koiosRow(base()), { tx_hash: 'zz', tx_index: 0, value: '1' }, koiosRow(base(), { value: undefined })] });
    assert.equal((await credentialOutputs(w.env, POLICY, {}, 'narrow')).length, 1);
  });
  test('a row with no asset list fails the whole read: the answer is incomplete', async () => {
    const row = koiosRow(base());
    const w = ledgerWorld([], { rows: [row, { ...row, tx_hash: 'ab'.repeat(32), asset_list: null as unknown as unknown[] }] });
    await assert.rejects(() => credentialOutputs(w.env, POLICY, {}, 'narrow'), /no asset list: the answer is incomplete/);
    assert.equal((await credentialOutputs(ledgerWorld([], { rows: [row, { ...row, tx_hash: 'ab'.repeat(32), asset_list: [] }] }).env, POLICY, {}, 'narrow')).length, 2, 'an empty list is an output without tokens');
  });
  test('5,000 matching outputs end the read, with the advice of the caller, as an error that says how many', async () => {
    const junk = Array.from({ length: 5_000 }, (_, i) => ({ tx_hash: i.toString(16).padStart(64, '0'), tx_index: 0, address: MAINNET.attestation.address, value: '1', payment_cred: POLICY, is_spent: false, asset_list: [] }));
    const w = ledgerWorld([], { rows: junk });
    await assert.rejects(() => credentialOutputs(w.env, POLICY, {}, 'Read one attestation by its identifier.'), (err: Error) => err instanceof TooManyMatches && err.maxRows === 5_000 && /^5000 or more outputs match at the script f07c644e.*Read one attestation by its identifier\.$/.test(err.message));
    const fewer = ledgerWorld([], { rows: junk.slice(0, 4_999) });
    assert.equal((await credentialOutputs(fewer.env, POLICY, {}, 'narrow')).length, 4_999);
  });
  test('a credential of 1,200 outputs is read whole, in three requests of 500, under the cap of 1,000 rows that Koios has', async () => {
    const rows = Array.from({ length: 1_200 }, (_, i) => koiosRow(attestationUtxo(ID, attestation(), { txHash: i.toString(16).padStart(64, '0') })));
    const w = ledgerWorld([], { rows });
    assert.equal((await credentialOutputs(w.env, POLICY, {}, 'narrow')).length, 1_200);
    assert.deepEqual(callsTo(w.koios, 'credential_utxos').map((c) => [new URL(c.url).searchParams.get('offset'), new URL(c.url).searchParams.get('limit')]), [['0', '500'], ['500', '500'], ['1000', '500']]);
  });
  test('a page that announces more than 16 MiB is refused before it is read; one that announces exactly that is read', async () => {
    const big = ledgerWorld([base()], { announce: { credential_utxos: KOIOS_ANSWER_BYTES + 1 } });
    await assert.rejects(() => credentialOutputs(big.env, POLICY, {}, 'narrow'), (err: Error) => err.message === `Koios credential_utxos: the answer is over the ${KOIOS_ANSWER_BYTES} byte limit`);
    const fine = ledgerWorld([base()], { announce: { credential_utxos: KOIOS_ANSWER_BYTES } });
    assert.equal((await credentialOutputs(fine.env, POLICY, {}, 'narrow')).length, 1);
  });
  test('a page that grows past 16 MiB while it is read is refused too, whatever it announces', async () => {
    const row = koiosRow(base(), { inline_datum: { bytes: 'ab'.repeat(KOIOS_ANSWER_BYTES / 4) } });
    const w = ledgerWorld([], { rows: [row, { ...row, tx_hash: 'f'.repeat(64) }, { ...row, tx_hash: 'e'.repeat(64) }] });
    await assert.rejects(() => credentialOutputs(w.env, POLICY, {}, 'narrow'), /the answer is over the 16777216 byte limit/);
  });
  test('a Koios that fails is an error that names the operation and the status only', async () => {
    const w = ledgerWorld([base()], { status: { credential_utxos: 500 } });
    await assert.rejects(() => credentialOutputs(w.env, POLICY, {}, 'narrow'), (err: Error) => err.message === 'Koios credential_utxos answered 500');
  });
  function base() { return attestationUtxo(ID, attestation({ subject: 'ab'.repeat(32) })); }
});

describe('koiosTipHeight', () => {
  const read = (k: LedgerKoios, base = 'https://koios.example') => koiosTipHeight(base, k.f);
  test('is the block height of the first row of GET tip, however many slashes end the base', async () => {
    for (const base of ['https://koios.example', 'https://koios.example/', 'https://koios.example///']) {
      const k = ledgerKoios({ tip: 9_502_929 });
      assert.equal(await read(k, base), 9_502_929);
      assert.equal(k.calls[0].url, 'https://koios.example/api/v1/tip');
      assert.equal(k.calls[0].method, 'GET');
    }
  });
  test('a status, an empty list and a height that is not a whole number are errors', async () => {
    await assert.rejects(() => read(ledgerKoios({ status: { tip: 503 } })), (err: Error) => err.message === 'Koios tip answered 503');
    await assert.rejects(() => read(ledgerKoios({ tip: null })), /no block height/);
    await assert.rejects(() => read(ledgerKoios({ tip: -1 })), /no block height/);
    await assert.rejects(() => read(ledgerKoios({ tip: 1.5 })), /no block height/);
    const html = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => koiosTipHeight('https://koios.example', html), /not valid JSON/);
  });
});

describe('dataOfKoiosJson', () => {
  test('reads the forms of Koios: int, bytes, list, map and constructor', () => {
    assert.equal(dataOfKoiosJson({ int: 5_200_000 }), 5_200_000n);
    assert.equal(dataOfKoiosJson({ int: '9007199254740993' }), 9_007_199_254_740_993n);
    assert.equal(dataOfKoiosJson({ bytes: 'AB01' }), 'ab01');
    assert.deepEqual(dataOfKoiosJson({ list: [{ int: 1 }, { bytes: '' }] }), [1n, '']);
    assert.deepEqual([...(dataOfKoiosJson({ map: [{ k: { int: 1 }, v: { bytes: 'ff' } }] }) as Map<unknown, unknown>)], [[1n, 'ff']]);
    assert.deepEqual(dataOfKoiosJson({ constructor: 1, fields: [{ int: 2 }] }), new Constr(1, [2n]));
  });
  test('the payment datum of the capture decodes as the Live vault datum that it is', () => {
    const input = CAPTURE.payment.tx.inputs.find((i) => i.payment_addr?.cred === MAINNET.vault.hash)!;
    const datum = vaultDatumFromData(dataOfKoiosJson(input.inline_datum!.value));
    assert.equal(datum.type, 'Live');
    if (datum.type === 'Live') { assert.equal(datum.delegation, CAPTURE.payment.delegation); assert.equal(datum.spent, 0n); }
  });
  test('refuses what is not Plutus Data', () => {
    for (const bad of [null, 7, 'x', [], {}, { int: true }, { int: 1.5 }, { bytes: 5 }, { bytes: 'zz' }, { list: 5 }, { map: 5 }, { constructor: -1, fields: [] }, { constructor: 'a', fields: [] }, { constructor: 0 }, { fields: [] }]) {
      assert.throws(() => dataOfKoiosJson(bad), Error, JSON.stringify(bad));
    }
  });
  test('the property constructor of every object is not a constructor of Plutus Data', () => {
    assert.throws(() => dataOfKoiosJson({ fields: [] }), /not a Plutus Data value/);
    assert.throws(() => dataOfKoiosJson(Object.create({ constructor: 0, fields: [] })), /not a Plutus Data value/);
  });
});

describe('the capture holds no text of a party that is not the Foundation', () => {
  const FOUNDATION_ID = '8a4af9dbe4c2a356da2279391d3ed6a5717ca542bdbc86da0c5a0b3b361f1cb4';
  const rows = CAPTURE.attestations.map((row) => ({ row, id: attestationIdOf(row), datum: decodeAttestationDatum(row.inline_datum!.bytes) }));

  test('the header says that the locators are replaced and that the file is not byte-true chain data', () => {
    assert.match(CAPTURE.note, /locators of \d+ attestations are replaced by https:\/\/example\.invalid\/a\//);
    assert.match(CAPTURE.note, /not byte-true chain data/);
  });
  test('each attestation has a neutral locator or none, and carries no hash of the datum that was replaced; the smoke test attestation is as read', () => {
    const replaced = rows.filter((r) => r.id !== FOUNDATION_ID && r.datum.locator !== null);
    assert.ok(replaced.length >= 20, 'most attestations of mainnet carry a locator');
    for (const { id, datum, row } of rows) {
      if (id === FOUNDATION_ID) {
        const hash = Buffer.from(blake2b(Buffer.from(row.inline_datum!.bytes, 'hex'), { dkLen: 32 })).toString('hex');
        assert.equal(row.datum_hash, hash, 'the hash that Koios gave is the hash of the bytes that the file holds');
        continue;
      }
      if (datum.locator !== null) { assert.equal(textOf(datum.locator), `https://example.invalid/a/${id.slice(0, 8)}`); assert.equal(row.datum_hash, null); }
      if (datum.contested !== null) assert.equal(textOf(datum.contested.uri), `https://example.invalid/c/${id.slice(0, 8)}`);
    }
  });
  test('every run of 16 printable characters in a datum of the file is a neutral URL, the hire action, or an escrow script', () => {
    // A datum in CBOR holds its text next to a header of one or two bytes, so a run is allowed text plus fewer than 8 other characters.
    const allowed = /https:\/\/example\.invalid\/[ac]\/[0-9a-f]{8}|marketplace\.hire\.v1|script:[0-9a-f]{56}/;
    const runs = [...JSON.stringify(CAPTURE).matchAll(/"bytes":"([0-9a-f]{12,})"/g)].flatMap((m) => Buffer.from(m[1], 'hex').toString('latin1').match(/[\x20-\x7e]{16,}/g) ?? []);
    assert.ok(runs.length >= 27, `the scan found ${runs.length} runs`);
    for (const run of runs) {
      assert.ok(allowed.test(run), `${run.slice(0, 40)} is not allowed text`);
      assert.ok(run.replace(new RegExp(allowed.source, 'g'), '').length < 8, `${run.slice(0, 40)} holds text besides the allowed text`);
    }
  });
  test('the capture does not record where Koios was asked: no base URL, in the header or anywhere', () => {
    assert.equal('koios' in CAPTURE.captured, false);
    assert.doesNotMatch(JSON.stringify(CAPTURE), /https?:\/\/[^"\s]*koios/i);
  });
  test('the organisation of a delegator or of a vault owner is none or the neutral text, in the outputs and in the vault input of the payment', () => {
    const owners = [
      ...CAPTURE.vaults.map((r) => decodeVaultDatum(r.inline_datum!.bytes).owner),
      ...[CAPTURE.delegations.live, CAPTURE.delegations.burned].map((d) => decodeDelegationDatum(d.mint_output.inline_datum!.bytes).delegator),
      vaultDatumFromData(dataOfKoiosJson(CAPTURE.payment.tx.inputs.find((i) => i.payment_addr?.cred === MAINNET.vault.hash)!.inline_datum!.value)).owner,
    ];
    assert.ok(owners.length >= 7);
    for (const owner of owners) assert.ok(owner.type !== 'PrincipalKey' || owner.organisation === null || owner.organisation === NEUTRAL_ORGANISATION, JSON.stringify(owner));
  });
});

describe('withinBudget', () => {
  const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  /** The env of an offline world with a budget of `budgetMs`. */
  const envOf = (budgetMs?: number): LedgerEnv => ({ ...ledgerWorld([]).env, budgetMs });
  /** What a promise settled with, once it has: it tracks the outcome, so that a rejection is not left unhandled. */
  const track = (promise: Promise<unknown>): (() => unknown) => {
    let result: unknown = 'pending';
    promise.then((value) => { result = value; }, (err) => { result = err; });
    return () => result;
  };
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  test('gives the work the env of the call and a session, returns what the work returns, and leaves no timer behind', async () => {
    const before = timers();
    const value = await withinBudget(envOf(60_000), async (inside, session) => { session.check(); assert.equal(inside.deployment, MAINNET); return 7; });
    assert.equal(value, 7);
    assert.equal(timers(), before, 'the timer of the budget is cleared');
  });
  test('passes the error of the work on as it is, and leaves no timer behind', async () => {
    const before = timers();
    const failure = new Error('the work failed');
    await assert.rejects(() => withinBudget(envOf(60_000), async () => { throw failure; }), (err: Error) => err === failure);
    assert.equal(timers(), before);
  });
  test('ends with BudgetSpent at the budget when the work never ends, and says what to do', { timeout: 20_000 }, async () => {
    const started = Date.now();
    await assert.rejects(() => endsWithin(5_000, withinBudget(envOf(40), () => new Promise<number>(() => {}))), (err: Error) => err instanceof BudgetSpent && err.budgetMs === 40 && /Retry in a minute\. A list can ask for fewer rows \(limit\)/.test(err.message) && /the node or Koios answers too slowly/.test(err.message));
    assert.ok(Date.now() - started >= 30, 'it waited for the budget');
    assert.ok(Date.now() - started < 5_000);
  });
  test('the session of the work throws BudgetSpent once the budget is spent: at once for a budget of 0, and not before for a long one', async () => {
    await assert.rejects(() => withinBudget(envOf(0), async (_inside, session) => { session.check(); return 1; }), BudgetSpent);
    assert.equal(await withinBudget(envOf(60_000), async (_inside, session) => { session.check(); return 1; }), 1);
  });
  test('a call without a budget of its own ends at 30 s, and not a millisecond before', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const outcome = track(withinBudget(envOf(), () => new Promise<number>(() => {})));
    t.mock.timers.tick(READ_BUDGET_MS - 1);
    await flush();
    assert.equal(outcome(), 'pending');
    t.mock.timers.tick(1);
    await flush();
    const ended = outcome();
    assert.ok(ended instanceof BudgetSpent && ended.budgetMs === READ_BUDGET_MS, String(ended));
  });
  test('the session throws at the budget and not before it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
    await withinBudget(envOf(500), async (_inside, session) => {
      t.mock.timers.tick(499);
      assert.doesNotThrow(() => session.check());
      t.mock.timers.tick(1);
      assert.throws(() => session.check(), BudgetSpent);
    });
    await withinBudget(envOf(), async (_inside, session) => {
      t.mock.timers.tick(READ_BUDGET_MS - 1);
      assert.doesNotThrow(() => session.check(), 'a call without a budget of its own has 30 s');
      t.mock.timers.tick(1);
      assert.throws(() => session.check(), BudgetSpent);
    });
  });
  test('a session keeps the links and the records that a call has read, each by its identifier, and each call has its own', async () => {
    await withinBudget(envOf(60_000), async (_inside, first) => {
      assert.deepEqual([first.links.size, first.records.size], [0, 0]);
      await withinBudget(envOf(60_000), async (_other, second) => { assert.notEqual(second.links, first.links); assert.notEqual(second.records, first.records); });
    });
    assert.equal(READ_BUDGET_MS, 30_000, 'the budget of a call is 30 s unless the environment names another');
  });

  test('the node of the call checks the budget before each request: no request starts after the end, and the shared provider is not changed', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
    const world = ledgerWorld([]);
    const shared = world.provider;
    const asked: string[] = [];
    const protocol = shared.getProtocolParameters.bind(shared);
    shared.getProtocolParameters = async () => { asked.push('protocol'); return protocol(); };
    const scan = shared.getUtxos.bind(shared);
    shared.getUtxos = async (a) => { asked.push('utxos'); return scan(a); };
    const members = [...Object.keys(shared)].sort();
    const getUtxos = shared.getUtxos;
    await withinBudget({ ...world.env, budgetMs: 1_000 }, async (inside) => {
      assert.notEqual(inside.provider, shared);
      await inside.provider.getProtocolParameters();
      assert.deepEqual(asked, ['protocol'], 'a request in time reaches the shared provider');
      t.mock.timers.tick(1_000);
      await assert.rejects(() => inside.provider.getProtocolParameters(), BudgetSpent);
      await assert.rejects(() => inside.provider.getUtxos(MAINNET.vault.address), BudgetSpent);
      await assert.rejects(() => inside.provider.getUtxosByOutRef([{ txHash: 'ab'.repeat(32), outputIndex: 0 }]), BudgetSpent);
    });
    assert.deepEqual(asked, ['protocol'], 'the requests after the end did not start');
    assert.deepEqual([...Object.keys(shared)].sort(), members, 'the shared provider has no new member');
    assert.equal(shared.getUtxos, getUtxos, 'and its methods are the ones it had');
  });
  test('the fetch of the call checks the budget before each request, and carries one signal that the end of the budget aborts', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => { signals.push(init!.signal!); return new Response('[]'); }) as typeof fetch;
    let inside!: LedgerEnv;
    const outcome = track(withinBudget({ ...envOf(5_000), fetchImpl }, async (env) => { inside = env; await env.fetchImpl('https://koios.example/in-time'); return new Promise<number>(() => {}); }));
    await flush();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false, 'the signal of a request in time is not aborted');
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(signals[0].aborted, true, 'the end of the budget aborts it');
    assert.ok(outcome() instanceof BudgetSpent);
    await assert.rejects(() => inside.fetchImpl('https://koios.example/late'), BudgetSpent);
    assert.equal(signals.length, 1, 'the request after the end did not start');
  });
  test('the signal of the caller still ends its own request: the fetch of the call carries both', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => { signals.push(init!.signal!); return new Response('[]'); }) as typeof fetch;
    await withinBudget({ ...envOf(5_000), fetchImpl }, async (env) => {
      const own = new AbortController();
      await env.fetchImpl('https://koios.example/a', { signal: own.signal });
      await env.fetchImpl('https://koios.example/b');
      assert.equal(signals[0].aborted, false);
      own.abort();
      assert.equal(signals[0].aborted, true, 'the signal of the caller ends the request');
      assert.equal(signals[1].aborted, false, 'and it does not end the budget of the call');
    });
  });
  test('a Koios that never answers ends the call at the budget, and the request is aborted', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const signals: AbortSignal[] = [];
    const hung = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signals.push(init!.signal!);
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    })) as typeof fetch;
    const outcome = track(withinBudget({ ...envOf(5_000), fetchImpl: hung }, (env) => env.fetchImpl('https://koios.example/never')));
    await flush();
    assert.equal(outcome(), 'pending');
    t.mock.timers.tick(5_000);
    await flush();
    assert.ok(outcome() instanceof BudgetSpent);
    assert.equal(signals[0].aborted, true);
  });
  test('the end of the budget by the timer stops the later requests of the call, whatever the clock of the process says', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let inside!: LedgerEnv;
    const outcome = track(withinBudget(envOf(), async (env) => { inside = env; return new Promise<number>(() => {}); }));
    await flush();
    t.mock.timers.tick(READ_BUDGET_MS);
    await flush();
    assert.ok(outcome() instanceof BudgetSpent);
    await assert.rejects(() => inside.provider.getProtocolParameters(), BudgetSpent);
    await assert.rejects(() => inside.fetchImpl('https://koios.example/late'), BudgetSpent);
  });
  test('a request that finds the budget spent by the clock aborts the Koios requests of the call that are still open', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
    const hung = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    })) as typeof fetch;
    await withinBudget({ ...envOf(1_000), fetchImpl: hung }, async (env) => {
      const open = env.fetchImpl('https://koios.example/a').then(() => 'answered', () => 'aborted');
      await flush();
      t.mock.timers.tick(1_000);
      await assert.rejects(() => env.fetchImpl('https://koios.example/b'), BudgetSpent);
      assert.equal(await open, 'aborted', 'the request that was open is aborted by the request that found the budget spent');
    });
  });
});

describe('credentialPage and koiosCredentialPage', () => {
  const POLICY = MAINNET.attestation.hash;
  const hash = (i: number): string => i.toString(16).padStart(64, '0');
  const outputs = (n: number) => Array.from({ length: n }, (_, i) => attestationUtxo(ID, attestation(), { txHash: hash(i + 1) }));
  const refs = (list: Array<{ txHash: string }>): string[] => list.map((u) => u.txHash);
  const queryOf = (w: { koios: LedgerKoios }, n = 0) => new URL(callsTo(w.koios, 'credential_utxos')[n].url).searchParams;

  test('asks for one row more than the limit, from the offset, in the order of the reference, with the filters; the answer says whether more follow', async () => {
    const w = ledgerWorld(outputs(5));
    const first = await credentialPage(w.env, POLICY, { assetPolicy: POLICY }, 0, 2);
    assert.deepEqual([refs(first.outputs), first.more], [[hash(1), hash(2)], true]);
    const q = queryOf(w);
    assert.deepEqual([q.get('offset'), q.get('limit'), q.get('order'), q.get('asset_list'), q.has('inline_datum->>bytes')], ['0', '3', 'tx_hash.asc,tx_index.asc', `cs.[{"policy_id":"${POLICY}"}]`, false]);
    assert.deepEqual(callsTo(w.koios, 'credential_utxos')[0].body, { _payment_credentials: [POLICY], _extended: true });
    const second = await credentialPage(w.env, POLICY, { datumContains: 'AB' }, 2, 2);
    assert.deepEqual([refs(second.outputs), second.more], [[], false], 'a datum filter that no output matches');
    assert.equal(queryOf(w, 1).get('inline_datum->>bytes'), 'like.*ab*');
    assert.equal(queryOf(w, 1).get('offset'), '2');
  });
  test('a full last page has nothing after it: exactly `limit` rows left, and one more row', async () => {
    const w = ledgerWorld(outputs(5));
    const four = await credentialPage(w.env, POLICY, {}, 3, 2);
    assert.deepEqual([refs(four.outputs), four.more], [[hash(4), hash(5)], false], 'two rows are left and the limit is two');
    const three = await credentialPage(w.env, POLICY, {}, 2, 2);
    assert.deepEqual([refs(three.outputs), three.more], [[hash(3), hash(4)], true], 'three rows are left');
    const past = await credentialPage(w.env, POLICY, {}, 9, 2);
    assert.deepEqual([past.outputs, past.more], [[], false]);
  });
  test('reads the page and no more: 5,001 matching outputs do not end it', async () => {
    const template = koiosRow(outputs(1)[0]);
    const rows = Array.from({ length: 5_001 }, (_, i) => ({ ...template, tx_hash: hash(i + 1) }));
    const w = ledgerWorld([], { rows });
    const page = await credentialPage(w.env, POLICY, {}, 5_000, 50);
    assert.deepEqual([page.outputs.length, page.more], [1, false]);
    assert.equal(callsTo(w.koios, 'credential_utxos').length, 1);
  });
  test('a row that cannot be read as an output is left out and still counts in the page; a row with no asset list fails the read', async () => {
    const good = koiosRow(outputs(1)[0]);
    const w = ledgerWorld([], { rows: [{ ...good, tx_hash: hash(1) }, { tx_hash: hash(2), tx_index: 0, value: '1', payment_cred: POLICY, asset_list: [] }, { ...good, tx_hash: hash(3) }] });
    const page = await credentialPage(w.env, POLICY, {}, 0, 2);
    assert.deepEqual([page.outputs.length, page.more], [1, true], 'the second row has no address: it is no output, and it fills the page');
    const bad = ledgerWorld([], { rows: [{ ...good, asset_list: null as unknown as unknown[] }] });
    await assert.rejects(() => credentialPage(bad.env, POLICY, {}, 0, 2), /no asset list: the answer is incomplete/);
  });
  test('a row that has no hash or no index is left out of the page and a row listed twice is returned once', async () => {
    const good = koiosRow(outputs(1)[0]);
    const rows = [{ ...good, tx_hash: hash(1) }, { ...good, tx_hash: hash(1) }, { tx_index: 0 }, null, { ...good, tx_hash: undefined }];
    const fetchImpl = (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;
    const page = await koiosCredentialPage('https://koios.example', POLICY, fetchImpl, { offset: 0, limit: 10 });
    assert.deepEqual([page.rows.map((r) => r.tx_hash), page.more], [[hash(1)], false]);
  });
  test('refuses a credential, an offset and a limit that are not valid before Koios is asked: the limit is at most 999, because one more row is asked for', async () => {
    const w = ledgerWorld(outputs(1));
    const ask = (credential: string, offset: number, limit: number) => koiosCredentialPage(w.env.koiosUrl, credential, w.env.fetchImpl, { offset, limit });
    await assert.rejects(() => ask('abc', 0, 1), /payment credential must be 28 bytes of hex/);
    for (const offset of [-1, 0.5, Number.NaN]) await assert.rejects(() => ask(POLICY, offset, 1), /offset must be a whole number of at least 0/, String(offset));
    for (const limit of [0, 1000, 2.5, Number.NaN]) await assert.rejects(() => ask(POLICY, 0, limit), /limit must be a whole number from 1 to 999/, String(limit));
    assert.equal(w.koios.calls.length, 0);
    assert.equal((await ask(POLICY, 0, 999)).rows.length, 1, 'the twin: 999 is the largest page');
  });
  test('a Koios that fails is an error that names the operation and the status only', async () => {
    const w = ledgerWorld(outputs(1), { status: { credential_utxos: 503 } });
    await assert.rejects(() => credentialPage(w.env, POLICY, {}, 0, 5), (err: Error) => err.message === 'Koios credential_utxos answered 503');
  });
});

describe('pageOf', () => {
  const all = Array.from({ length: 45 }, (_, i) => i);
  test('takes the rows from the offset, a page at a time, and says where the next page starts', () => {
    const first = pageOf(all);
    assert.equal(first.items.length, DEFAULT_PAGE);
    assert.deepEqual([first.total, first.offset, first.limit, first.nextOffset], [45, 0, DEFAULT_PAGE, DEFAULT_PAGE]);
    const last = pageOf(all, 40, 10);
    assert.deepEqual(last.items, [40, 41, 42, 43, 44]);
    assert.equal(last.nextOffset, null);
    assert.equal(pageOf(all, 35, 10).nextOffset, null, 'a page that ends at the end has none after it');
    assert.equal(pageOf(all, 34, 10).nextOffset, 44, 'a page that stops one row before the end points at that row');
    assert.equal(pageOf(all, 45, 10).items.length, 0);
    assert.equal(pageOf(all, 0, 45).nextOffset, null);
  });
  test('the pages of one list join up with no gap and no overlap', () => {
    const joined: number[] = [];
    let next: number | null = 0;
    // The bound makes a next offset that never ends fail the test, and not hang it.
    for (let pages = 0; next !== null && pages < 10; pages++) { const p: Page<number> = pageOf(all, next, 7); joined.push(...p.items); next = p.nextOffset; }
    assert.equal(next, null, 'the pages end');
    assert.deepEqual(joined, all);
  });
  test('refuses an offset below 0, a limit below 1 or above the most, and numbers that are not whole', () => {
    for (const [offset, limit] of [[-1, 5], [0, 0], [0, MAX_PAGE + 1], [0.5, 5], [0, 2.5], [Number.NaN, 5]]) assert.throws(() => pageOf(all, offset, limit), /must be a whole number/, `${offset} ${limit}`);
    assert.equal(pageOf(all, 0, MAX_PAGE).items.length, MAX_PAGE > 45 ? 45 : MAX_PAGE);
  });
});
