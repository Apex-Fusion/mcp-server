// packages/builder/test/marketplace-lineage.test.ts
// resolveEscrowLineage: where is this escrow now? Koios supplies the chain (utxo_info for the posted output, credential_utxos for
// the candidates, tx_info for the spend chain between them); the node confirms what Koios found. The fake Koios and the spend
// chain of the live fixture escrow are in fixtures/escrow-koios.fixture.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Constr, Data, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { ADVERT_DATUM_HEX, ESCROW_LOCKED_LOVELACE, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import {
  escrowKoios, world, koiosFor, escrowAt, stakedEscrowAddress, txInfoRequests, credentialRequests, GENUINE_TXS, DECOY_TXS, DECOY_KINDS,
  ESCROW_TX, CLAIM_TX, SUBMIT_TX, DECOY_TX, SLY_DECOY_TX, SUPPLIER_ADDRESS,
} from './fixtures/escrow-koios.fixture.ts';
import type { KoiosOptions } from './fixtures/escrow-koios.fixture.ts';
import { ADVERT_ADDRESS, ESCROW_ADDRESS, ESCROW_SCRIPT_HASH } from '../src/vector/marketplace-constants.ts';
import { decodeEscrowDatum, encodeEscrowDatum } from '../src/vector/marketplace-datum.ts';
import type { EscrowDatum } from '../src/vector/marketplace-datum.ts';
import { resolveEscrowLineage } from '../src/vector/marketplace-lineage.ts';
import { koiosCredentialUtxos } from '../src/vector/marketplace-indexer.ts';
import { resolveEscrowLineage as resolveViaBuild } from '../src/vector/marketplace-build.ts';

const KOIOS = 'https://koios.example';
const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
const claimedDatum: EscrowDatum = { ...posted, state: 'Claimed' }; // what a Claim makes of the Post datum
const submitted: EscrowDatum = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
const at = escrowAt;
const claimed = at(CLAIM_TX, claimedDatum); // the genuine Claimed output
const current = at(SUBMIT_TX, submitted); // the genuine Submitted output
const stranger = at('ff'.repeat(32), { ...submitted, posted_at: 1 });
const postOutput = at(ESCROW_TX, posted); // the Post output itself, as the node lists it while it is unspent
const staked = stakedEscrowAddress('aa'.repeat(28));

type World = ReturnType<typeof world>;
const resolve = (w: World, ref = ESCROW_REF) => resolveEscrowLineage(w.node, KOIOS, ref, w.koios.f);
const lineage = (node: UTxO[], o: KoiosOptions = {}) => resolve(world(node, o));
/** The error names the escrow it was asked about (the canonical ref), in the words of `message`, and any other ref it should name. */
const refusalAbout = (asked: string, message: RegExp, ...alsoNames: string[]) => (err: unknown) => {
  assert.ok(err instanceof Error);
  assert.match(err.message, message);
  for (const named of [asked, ...alsoNames]) assert.ok(err.message.includes(named), `${named} is missing from: ${err.message}`);
  return true;
};
const refusal = (message: RegExp, ...alsoNames: string[]) => refusalAbout(ESCROW_REF, message, ...alsoNames);

// The fixture the Accept/Reclaim and transport tests lean on: node and Koios are built from one list, so they cannot differ by accident.
describe('world (test fixture)', () => {
  const wallet: UTxO = { txHash: 'ab'.repeat(32), outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 5_000_000n } };
  const listed = async (k: ReturnType<typeof world>['koios']) => (await koiosCredentialUtxos(KOIOS, ESCROW_SCRIPT_HASH, k.f)).map((r) => r.tx_hash).sort();
  test('Koios has indexed the escrow-credential outputs the node holds, and only those', async () => {
    const w = world([wallet, claimed, at(SUBMIT_TX, submitted, { address: staked })]);
    assert.deepEqual(await listed(w.koios), [CLAIM_TX, SUBMIT_TX].sort());
    assert.equal((await w.node.getUtxosByOutRef([{ txHash: wallet.txHash, outputIndex: 0 }])).length, 1, 'the wallet output is on the node');
  });
  test('a Koios that lags, or knows more, is asked for with `indexed`', async () => {
    assert.deepEqual(await listed(world([claimed], { indexed: [] }).koios), []);
    assert.deepEqual(await listed(world([claimed], { indexed: [current] }).koios), [SUBMIT_TX]);
  });
});

describe('resolveEscrowLineage', () => {
  test('is the one the build module re-exports', () => {
    assert.equal(resolveViaBuild, resolveEscrowLineage);
  });
  test('finds the current UTxO by advert_ref, buyer, posted_at and prompt_hash', async () => {
    const r = await lineage([current, stranger]);
    assert.equal(r.spent, true);
    assert.equal(r.current?.utxo.txHash, 'ee'.repeat(32));
    assert.equal(r.current?.datum.state, 'Submitted');
    assert.deepEqual(r.posted, posted, 'posted stays the datum of the output the ref names');
  });
  test('every field of the lineage rule matters: a UTxO that differs in any one of them belongs to another escrow', async () => {
    const differing: Array<[string, Partial<EscrowDatum>]> = [
      ['advert_ref.txHash', { advert_ref: { ...claimedDatum.advert_ref, txHash: 'aa'.repeat(32) } }],
      ['advert_ref.index', { advert_ref: { ...claimedDatum.advert_ref, index: claimedDatum.advert_ref.index + 1 } }],
      ['buyer_pkh', { buyer_pkh: 'aa'.repeat(28) }],
      ['posted_at', { posted_at: claimedDatum.posted_at + 1 }],
      ['prompt_hash', { prompt_hash: 'aa'.repeat(32) }],
    ];
    // Koios narrows the listing by prompt hash on the server; the resolver does not rely on that, so every field is checked on
    // a Koios that ignores the filter too.
    for (const ignoreDatumFilter of [false, true]) {
      for (const [field, change] of differing) {
        assert.equal((await lineage([at(CLAIM_TX, { ...claimedDatum, ...change })], { ignoreDatumFilter })).current, null, `${field}${ignoreDatumFilter ? ' (Koios ignores the datum filter)' : ''}`);
      }
    }
    // what Claim and Submit do change (state, submitted_at, the receipt hash) does not make it another escrow
    assert.equal((await lineage([claimed])).current?.datum.state, 'Claimed');
    assert.equal((await lineage([current])).current?.datum.state, 'Submitted');
  });
  // The four fields above only pick the candidates. escrow.ak keeps every field but state, submitted_at and result_receipt_hash as it
  // was across Claim and Submit (expect_unchanged_modulo_state, expect_unchanged_modulo_submit), so the continuation the spend chain
  // leads to must agree with the output it follows on all the rest. A transaction that spent the escrow in a way that ends it (a
  // Reclaim, an Accept, a Release) can still leave an output at the escrow credential behind, with any datum it likes: it descends
  // from the escrow by the spend chain, and Accept would pay out what that datum says.
  test('a continuation that follows the spend chain but changes a field Claim and Submit keep is refused, naming the field', async () => {
    const changes: Array<[field: string, change: Partial<EscrowDatum>]> = [
      ['supplier_pkh', { supplier_pkh: 'aa'.repeat(28) }],
      ['capability_id', { capability_id: 'other.capability.v1' }],
      ['request_spec_hash', { request_spec_hash: 'aa'.repeat(32) }],
      ['payment_lovelace', { payment_lovelace: posted.payment_lovelace + 1_000_000n }],
      ['buyer_bond_lovelace', { buyer_bond_lovelace: posted.buyer_bond_lovelace + 1n }],
      ['supplier_bond_lovelace', { supplier_bond_lovelace: posted.supplier_bond_lovelace - 1n }],
      ['deliver_by', { deliver_by: posted.deliver_by + 1 }],
    ];
    for (const [field, change] of changes) {
      // one step down (the Claimed output) and two steps down (the Submitted output)
      for (const [stateName, decoy] of [['Claimed', at(CLAIM_TX, { ...claimedDatum, ...change })], ['Submitted', at(SUBMIT_TX, { ...submitted, ...change })]] as const) {
        await assert.rejects(() => lineage([decoy]), refusal(new RegExp(`but its datum differs from that escrow's in ${field}, which Claim and Submit leave unchanged; refusing to build on it[.]$`), `${decoy.txHash}#0`), `${field}, ${stateName}`);
      }
    }
    // every changed field is named
    await assert.rejects(() => lineage([at(CLAIM_TX, { ...claimedDatum, payment_lovelace: 9n, deliver_by: 1 })]), refusal(/in payment_lovelace, deliver_by, which Claim/));
  });
  test('a continuation that changes only what Claim and Submit may change - state, submitted_at, the receipt hash - is the escrow', async () => {
    const r = await lineage([at(SUBMIT_TX, { ...submitted, submitted_at: posted.deliver_by, result_receipt_hash: 'ee'.repeat(32) })]);
    assert.equal(r.current?.datum.state, 'Submitted');
    assert.equal(r.current?.datum.submitted_at, posted.deliver_by);
  });
  test('returns current = null when the lineage is finished', async () => {
    const r = await lineage([stranger]);
    assert.equal(r.current, null);
    assert.equal(r.spent, true);
  });
  test('returns current = null, not an error, when Koios has not indexed the continuation yet: "nothing found" never claims "finished"', async () => {
    const w = world([claimed], { indexed: [] });
    const r = await resolve(w);
    assert.equal(r.current, null);
    assert.equal(r.spent, true);
    assert.equal(txInfoRequests(w.koios).length, 0);
  });
  test('a credential listing that still shows the Post output as unspent, after utxo_info said it was spent, is a Koios that is behind: the output is not its own continuation', async () => {
    const w = world([], { spent: true, indexed: [postOutput] });
    const r = await resolve(w);
    assert.equal(r.current, null);
    assert.equal(r.spent, true);
    assert.equal(txInfoRequests(w.koios).length, 0);
  });
  test('while the Post output is unspent it is the live escrow: the node\'s copy of it is current', async () => {
    const r = await lineage([postOutput], { spent: false });
    assert.equal(r.spent, false);
    assert.equal(r.current?.utxo, postOutput);
    assert.equal(r.current?.datum.state, 'Open');
  });
  test('asks Koios for the canonical lowercase ref, and a malformed ref is refused without calling Koios', async () => {
    const w = world([postOutput], { spent: false });
    await resolveEscrowLineage(w.node, KOIOS, `  ${ESCROW_TX.toUpperCase()}#0 `, w.koios.f);
    assert.deepEqual(w.koios.calls.map((c) => c.body), [{ _utxo_refs: [ESCROW_REF], _extended: true }]);
    const unused = escrowKoios();
    await assert.rejects(() => resolveEscrowLineage(new FixtureProvider([]), KOIOS, 'nope#1', unused.f), /Invalid out ref/);
    assert.equal(unused.calls.length, 0);
  });
  test('outputs Koios lists that hold no datum, or one that is not an escrow datum, are ignored', async () => {
    const noDatum = at('aa'.repeat(32), submitted, { datum: undefined });
    const junk = at('bb'.repeat(32), submitted, { datum: 'ff' });
    assert.equal((await lineage([noDatum, junk, current])).current?.utxo.txHash, 'ee'.repeat(32));
  });

  // The datum alone cannot say which UTxO is the escrow: its four lineage fields are public, and anyone can lock a UTxO at the
  // escrow address carrying copies of them. What a copy cannot fake is how it came to be. escrow.ak lets Claim and Submit make
  // exactly one output at the escrow credential, so the true continuation is the output of the transaction that spent the
  // previous escrow output: Post output -> Claim -> Claimed output -> Submit -> Submitted output.
  test('a Claimed continuation is one step from the Post output: the transaction that made it spent that output, one tx_info call', async () => {
    const w = world([claimed, stranger]);
    const r = await resolve(w);
    assert.equal(r.current?.utxo.txHash, CLAIM_TX);
    assert.equal(r.current?.datum.state, 'Claimed');
    assert.deepEqual(txInfoRequests(w.koios).map((c) => c.body), [{ _tx_hashes: [CLAIM_TX], _inputs: true, _assets: true }]);
  });
  test('a Submitted continuation is two steps away: its transaction spent a Claimed output that the Claim made from the Post output, two calls', async () => {
    const w = world([current]);
    const r = await resolve(w);
    assert.equal(r.current?.utxo.txHash, SUBMIT_TX);
    assert.deepEqual(txInfoRequests(w.koios).map((c) => c.body._tx_hashes), [[SUBMIT_TX], [CLAIM_TX]]);
  });
  test('any output of the escrow\'s life can be the ref: from the Claimed output the Submitted one is one step away', async () => {
    const row = { tx_hash: CLAIM_TX, tx_index: 0, address: ESCROW_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), is_spent: true, inline_datum: { bytes: encodeEscrowDatum(claimedDatum) } };
    const w = world([current], { rows: [row] });
    const r = await resolve(w, `${CLAIM_TX}#0`);
    assert.equal(r.current?.utxo.txHash, SUBMIT_TX);
    assert.deepEqual(r.posted, claimedDatum);
    assert.deepEqual(txInfoRequests(w.koios).map((c) => c.body._tx_hashes), [[SUBMIT_TX]]);
  });
  test('nothing carries the escrow on: no candidate, no tx_info call', async () => {
    const w = world([stranger]);
    assert.equal((await resolve(w)).current, null);
    assert.equal(txInfoRequests(w.koios).length, 0);
  });
  test('a decoy that copies a Claimed escrow\'s fields never beats the genuine Claimed output, wherever it is listed', async () => {
    for (const [name, decoyTx] of DECOY_KINDS) {
      const decoy = at(decoyTx, claimedDatum);
      for (const held of [[decoy, claimed], [claimed, decoy]]) {
        const r = await lineage(held, { txs: { ...GENUINE_TXS, ...DECOY_TXS } });
        assert.equal(r.current?.utxo.txHash, CLAIM_TX, `${name}, listed ${held.map((u) => u.txHash.slice(0, 2)).join(' then ')}`);
      }
    }
  });
  test('the same for Submitted decoys beside the genuine Submitted output', async () => {
    for (const [name, decoyTx] of DECOY_KINDS) {
      const decoy = at(decoyTx, submitted);
      for (const held of [[decoy, current], [current, decoy]]) {
        const r = await lineage(held, { txs: { ...GENUINE_TXS, ...DECOY_TXS } });
        assert.equal(r.current?.utxo.txHash, SUBMIT_TX, `${name}, listed ${held.map((u) => u.txHash.slice(0, 2)).join(' then ')}`);
      }
    }
  });
  test('however many decoys are listed it is at most two tx_info calls, each a single batch of the candidates\' transactions', async () => {
    const decoys = [at(DECOY_TX, submitted), at(SLY_DECOY_TX, submitted), at('d6'.repeat(32), claimedDatum), at('d7'.repeat(32), posted)];
    const w = world([...decoys, current], { txs: { ...GENUINE_TXS, ...DECOY_TXS } });
    await resolve(w);
    const calls = txInfoRequests(w.koios);
    assert.equal(calls.length, 2);
    assert.deepEqual([...calls[0].body._tx_hashes].sort(), [DECOY_TX, SLY_DECOY_TX, 'd6'.repeat(32), SUBMIT_TX].sort(), 'an Open copy cannot be a continuation and is not even asked about');
    assert.deepEqual(calls[1].body._tx_hashes, [CLAIM_TX], 'the Claimed output behind the Submitted candidates, asked once');
  });
  test('a candidate whose transaction Koios does not know yet is ignored beside a verified one; alone, or half-known, it is refused as unverifiable', async () => {
    const lagging = at('b1'.repeat(32), claimedDatum);
    assert.equal((await lineage([lagging, claimed])).current?.utxo.txHash, CLAIM_TX);
    await assert.rejects(() => lineage([lagging]), refusal(/Cannot tell which UTxO carries escrow .* on: Koios does not know the transaction behind /, `${'b1'.repeat(32)}#0`));
    // the Submitted output's own transaction is known, the Claim behind it is not
    await assert.rejects(() => lineage([current], { txs: { [SUBMIT_TX]: GENUINE_TXS[SUBMIT_TX] } }), refusal(/Koios does not know the transaction behind /, `${SUBMIT_TX}#0`));
  });
  test('UTxOs that carry the fields but do not descend from the escrow are refused, naming them, and not reported as a finished escrow', async () => {
    const decoys = [at(DECOY_TX, claimedDatum), at(SLY_DECOY_TX, submitted)];
    await assert.rejects(() => lineage(decoys, { txs: { ...GENUINE_TXS, ...DECOY_TXS } }), refusal(/None of .* descends from escrow .* by the spend chain, though they carry its fields/, `${DECOY_TX}#0`, `${SLY_DECOY_TX}#0`));
  });
  test('a copy in a state the escrow cannot be in after this output is refused without asking Koios about it', async () => {
    const w = world([at(DECOY_TX, posted), at(SLY_DECOY_TX, { ...posted, state: 'Accepted' })]);
    await assert.rejects(() => resolve(w), refusal(/None of .* descends from escrow/, `${DECOY_TX}#0`));
    assert.equal(txInfoRequests(w.koios).length, 0);
  });
  test('an output whose datum says the escrow was already finished has no descendants: its candidates are refused without asking Koios', async () => {
    const row = { tx_hash: CLAIM_TX, tx_index: 0, address: ESCROW_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), is_spent: true, inline_datum: { bytes: encodeEscrowDatum({ ...claimedDatum, state: 'Accepted' }) } };
    const w = world([at('c3'.repeat(32), claimedDatum)], { rows: [row] }); // one state "past" Accepted, if a terminal state counted as a step
    await assert.rejects(() => resolve(w, `${CLAIM_TX}#0`), refusalAbout(`${CLAIM_TX}#0`, /None of .* descends from escrow/, `${'c3'.repeat(32)}#0`));
    assert.equal(txInfoRequests(w.koios).length, 0);
  });
  test('two candidates that both descend from the escrow are refused, naming both (the chain cannot do that, but the code path is pinned)', async () => {
    const claim2 = 'c2'.repeat(32);
    const both = refusal(/More than one UTxO descends from escrow .* by the spend chain/, `${CLAIM_TX}#0`, `${claim2}#0`);
    await assert.rejects(() => lineage([claimed, at(claim2, claimedDatum)], { txs: { ...GENUINE_TXS, [claim2]: [[ESCROW_REF, ESCROW_ADDRESS]] } }), both);
    // one a step down, one two steps down
    await assert.rejects(() => lineage([claimed, current]), refusal(/More than one UTxO descends/, `${CLAIM_TX}#0`, `${SUBMIT_TX}#0`));
  });
  test('refusal lists are sorted, whatever order the candidates were found in', async () => {
    const late = 'ff'.repeat(32); // a second Claimed output that spent the Post output: found one step down, before the Submitted one two steps down
    await assert.rejects(() => lineage([at(late, claimedDatum), current], { txs: { ...GENUINE_TXS, [late]: [[ESCROW_REF, ESCROW_ADDRESS]] } }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(`(${SUBMIT_TX}#0, ${late}#0)`), err.message);
      return true;
    });
  });
  test('a hash Koios writes in capitals is the same hash', async () => {
    const w = world([claimed], { indexed: [at(CLAIM_TX.toUpperCase(), claimedDatum)] });
    assert.equal((await resolve(w)).current?.utxo.txHash, CLAIM_TX);
  });
  test('refusal lists are capped: five refs fit, a sixth makes it "and 1 more", a dozen "and 7 more"', async () => {
    for (const n of [5, 6, 12]) {
      const txs: Record<string, Array<[string, string]>> = {};
      const copies = Array.from({ length: n }, (_, i) => {
        const tx = `d${i.toString(16)}`.repeat(32).slice(0, 64);
        txs[tx] = [[`${'ac'.repeat(32)}#${i}`, SUPPLIER_ADDRESS]];
        return at(tx, claimedDatum);
      });
      const refs = copies.map((u) => `${u.txHash}#0`).sort();
      const listed = n <= 5 ? refs.join(', ') : `${refs.slice(0, 5).join(', ')} and ${n - 5} more`;
      await assert.rejects(() => lineage(copies, { txs: { ...GENUINE_TXS, ...txs } }), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(`None of ${listed} descends from escrow ${ESCROW_REF}`), err.message);
        for (const hidden of refs.slice(5)) assert.ok(!err.message.includes(hidden), `${hidden} should not be listed (${n} copies)`);
        return true;
      });
    }
  });

  // Escrow outputs are known by payment credential, not by exact address. escrow.ak finds the continuation of a Claim or Submit
  // with unique_output_to_credential, so the validator is content with the continuation at ANY address that has the escrow
  // script's payment credential, a stake part and all. An enterprise-address scan would see nothing, and "nothing" would read as
  // "finished": a free way to keep a buyer from ever reclaiming.
  test('a row Koios lists whose address does not have the escrow credential is ignored, whatever its datum says', async () => {
    const intruder = { tx_hash: CLAIM_TX, tx_index: 0, address: OWN_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), payment_cred: ESCROW_SCRIPT_HASH, inline_datum: { bytes: encodeEscrowDatum(claimedDatum) }, is_spent: false };
    const w = world([], { extraCredentialRows: [intruder, { ...intruder, address: 'not-an-address' }] });
    assert.equal((await resolve(w)).current, null);
    assert.equal(txInfoRequests(w.koios).length, 0);
  });
  test('a genuine Submitted continuation at a stake-variant address resolves', async () => {
    const s = at(SUBMIT_TX, submitted, { address: staked });
    const r = await lineage([s]);
    assert.equal(r.current?.utxo, s);
    assert.equal(r.current?.utxo.address, staked);
    assert.equal(r.current?.datum.state, 'Submitted');
  });
  test('and so does a Claimed one, and a chain whose Claimed output sat at another stake variant', async () => {
    assert.equal((await lineage([at(CLAIM_TX, claimedDatum, { address: staked })])).current?.utxo.address, staked);
    const staked2 = stakedEscrowAddress('bb'.repeat(28));
    const txs = { ...GENUINE_TXS, [SUBMIT_TX]: [[`${CLAIM_TX}#0`, staked2], [`${CLAIM_TX}#1`, SUPPLIER_ADDRESS]] as Array<[string, string]> };
    assert.equal((await lineage([at(SUBMIT_TX, submitted, { address: stakedEscrowAddress('cc'.repeat(28)) })], { txs })).current?.utxo.txHash, SUBMIT_TX);
  });
  test('a stake-variant decoy beside the genuine enterprise-address output is a decoy like any other', async () => {
    const decoy = at(DECOY_TX, submitted, { address: staked });
    assert.equal((await lineage([decoy, current], { txs: { ...GENUINE_TXS, ...DECOY_TXS } })).current?.utxo.txHash, SUBMIT_TX);
  });
  test('the root may sit at a stake-variant address too, spent or not', async () => {
    const row = (spent: boolean) => ({ tx_hash: ESCROW_TX, tx_index: 0, address: staked, value: String(ESCROW_LOCKED_LOVELACE), is_spent: spent, inline_datum: { bytes: ESCROW_OPEN_DATUM_HEX } });
    assert.equal((await lineage([current], { rows: [row(true)] })).current?.utxo.txHash, SUBMIT_TX);
    const stakedPost = at(ESCROW_TX, posted, { address: staked });
    assert.equal((await lineage([stakedPost], { rows: [row(false)] })).current?.utxo, stakedPost);
  });
  test('the node\'s list of UTxOs at an address is not how candidates are found', async () => {
    const w = world([current]);
    const node = Object.assign(w.node, { getUtxos: async () => { throw new Error('the resolver must not scan the node'); } });
    const r = await resolveEscrowLineage(node, KOIOS, ESCROW_REF, w.koios.f);
    assert.equal(r.current?.utxo.txHash, SUBMIT_TX);
  });
  test('refuses a Post output whose payment credential is not the escrow script\'s: a key address, the advert script, any other', async () => {
    const keyWithTheScriptHash = credentialToAddress('Mainnet', { type: 'Key', hash: ESCROW_SCRIPT_HASH }); // same 28 bytes, but a key, not the script
    for (const address of [OWN_ADDRESS, SUPPLIER_ADDRESS, ADVERT_ADDRESS, keyWithTheScriptHash, 'not-an-address', null]) {
      await assert.rejects(() => lineage([current], { address }), refusal(/^UTxO .* is not an escrow output: its payment credential is not the escrow script's\.$/), String(address));
    }
  });

  // Koios and the node are two views of one chain, each possibly a little behind. Wherever they disagree about the escrow the
  // answer is a refusal that names both, never a guess and never "finished".
  test('Koios says the Post output is spent but the node still lists it: refused, not read as a finished escrow', async () => {
    await assert.rejects(() => lineage([postOutput, current]), refusal(/Koios and the node disagree about escrow .*Koios says it is spent, the node still lists it as unspent.*retry in a minute/));
  });
  test('Koios says the Post output is unspent but the node does not list it as an escrow output', async () => {
    const noDatum = at(ESCROW_TX, posted, { datum: undefined });
    const elsewhere = at(ESCROW_TX, posted, { address: OWN_ADDRESS });
    const says = /Koios and the node disagree about escrow .*Koios says it is unspent, the node does not list it.*retry in a minute/;
    for (const held of [[], [current]]) await assert.rejects(() => lineage(held, { spent: false }), refusal(says));
    for (const held of [[noDatum], [elsewhere]]) await assert.rejects(() => lineage(held, { spent: false }), refusal(/Koios and the node disagree about escrow .*not as an escrow output.*retry in a minute/));
  });
  test('Koios lists a live continuation that the node does not: refused, naming it', async () => {
    const w = world([], { indexed: [current] }); // Koios has indexed an output the node does not list
    await assert.rejects(() => resolve(w), refusal(/Koios and the node disagree about escrow .*Koios lists .* as its live continuation, the node does not list it.*retry in a minute/, `${SUBMIT_TX}#0`));
  });
  test('the node\'s copy must be the output Koios described: same datum, same lovelace', async () => {
    const otherDatum = at(SUBMIT_TX, { ...submitted, result_receipt_hash: 'ab'.repeat(32) });
    const lessLovelace = at(SUBMIT_TX, submitted, { assets: { lovelace: ESCROW_LOCKED_LOVELACE - 1n } });
    const notAnEscrowDatum = at(SUBMIT_TX, submitted, { datum: 'ff' });
    for (const [name, onNode] of [['datum', otherDatum], ['lovelace', lessLovelace], ['not a datum', notAnEscrowDatum]] as const) {
      const w = world([onNode], { indexed: [current] }); // the node holds another version of the output Koios indexed
      await assert.rejects(() => resolve(w), refusal(/Koios and the node disagree about escrow .*retry in a minute/, `${SUBMIT_TX}#0`), name);
    }
    // the same while the Post output is unspent: the datum the node carries is compared with the one Koios decoded
    const changed = at(ESCROW_TX, { ...posted, deliver_by: posted.deliver_by + 1 });
    await assert.rejects(() => lineage([changed], { spent: false }), refusal(/Koios and the node disagree about escrow .*differs from the one Koios reports.*retry in a minute/, `${ESCROW_TX}#0`));
    await assert.rejects(() => lineage([at(ESCROW_TX, posted, { assets: { lovelace: ESCROW_LOCKED_LOVELACE + 1n } })], { spent: false }), refusal(/Koios and the node disagree about escrow/));
  });

  // A genuine continuation holds exactly what the output before it held (value_equal on Claim and Submit), so a decoy has to
  // lock the full amount. And an escrow that holds less than its datum owes is no escrow: Accept pays what the datum says, and
  // the wallet would make up the difference.
  test('a candidate holds exactly the lovelace of the output it continues: one lovelace more or less is a different output', async () => {
    assert.equal((await lineage([{ ...current, assets: { lovelace: ESCROW_LOCKED_LOVELACE } }])).current?.utxo.txHash, SUBMIT_TX);
    for (const lovelace of [ESCROW_LOCKED_LOVELACE - 1n, ESCROW_LOCKED_LOVELACE + 1n, ESCROW_LOCKED_LOVELACE * 100n, 2_200_000n]) {
      assert.equal((await lineage([{ ...current, assets: { lovelace } }])).current, null, String(lovelace));
    }
  });
  test('refuses a Post output that holds less than its datum owes, spent or not', async () => {
    const owed = posted.payment_lovelace + posted.buyer_bond_lovelace + posted.supplier_bond_lovelace;
    assert.equal(owed, 2_200_000n);
    const thin = at(ESCROW_TX, posted, { assets: { lovelace: 1_000_000n } });
    await assert.rejects(() => lineage([thin], { spent: false, value: '1000000' }), refusal(/is not funded: its datum owes 2200000 lovelace but the output holds 1000000/));
    await assert.rejects(() => lineage([current], { value: '1000000' }), refusal(/is not funded: its datum owes 2200000 lovelace but the output holds 1000000/));
    assert.equal((await lineage([current], { value: String(owed) })).current, null, 'exactly what it owes passes the root check; the candidate then differs in value');
  });
  test('refuses a Post output Koios gives no value for', async () => {
    for (const value of [null, 'lots', '', '12abc', '-5']) await assert.rejects(() => lineage([current], { value }), refusal(/did not report the value of escrow/));
  });

  test('a row for another output of the same transaction is not the output asked about', async () => {
    const other = `${ESCROW_TX}#1`;
    await assert.rejects(() => resolve(world([current]), other), refusalAbout(other, /not found on the ledger/));
  });
  test('refuses a Post output Koios does not know, or answers for a different output', async () => {
    const other = [{ tx_hash: 'ab'.repeat(32), tx_index: 0, address: ESCROW_ADDRESS, value: '1', is_spent: false, inline_datum: { bytes: ESCROW_OPEN_DATUM_HEX } }];
    for (const rows of [[], other]) await assert.rejects(() => lineage([current], { rows }), refusal(/not found on the ledger/));
  });
  test('refuses an output that holds no escrow datum', async () => {
    for (const datumHex of [null, ADVERT_DATUM_HEX, 'ff', 'zz']) {
      await assert.rejects(() => lineage([current], { datumHex }), refusal(/^UTxO .* does not hold an escrow datum\.$/), String(datumHex).slice(0, 8));
    }
  });
  test('fails closed when Koios does not say whether the Post output is spent, whatever the node holds', async () => {
    for (const held of [[], [postOutput], [current], [postOutput, current]]) {
      await assert.rejects(() => lineage(held, { spent: null }), refusal(/did not report whether escrow .* is spent/));
    }
  });

  // Tool output goes to anonymous callers: a failure names the escrow and the failure, never an (operator-configured) endpoint or
  // a snippet of a response body, from Koios or from the node.
  test('a Koios failure is an Error that names the escrow and carries neither the endpoint nor a response body', async () => {
    const LEAKS = ['http://', 'https://', 'koios.example', 'internal', 'hunter2', 'Bad Gateway', '<html', 'ECONNREFUSED'];
    const rejecting = (error: Error) => (async () => { throw error; }) as unknown as typeof fetch;
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const after = (calls: number, error: Error): typeof fetch => { // the first `calls` requests are answered by a good Koios, then every request fails
      const good = koiosFor([current]).f;
      let n = 0;
      return (async (u: string, init: any) => { if (n++ < calls) return good(u, init); throw error; }) as unknown as typeof fetch;
    };
    const transport = new TypeError('connect ECONNREFUSED https://koios.example:8443/api/v1/credential_utxos');
    const cases: Array<[string, typeof fetch, RegExp]> = [
      ['an HTTP error whose body names internals', escrowKoios({ status: 503 }).f, /: Koios utxo_info answered 503$/],
      ['a 200 that is not JSON', escrowKoios({ raw: '<html>502 Bad Gateway from internal.koios.example</html>' }).f, /: Koios utxo_info: response was not valid JSON$/],
      ['a 200 that is not a list', escrowKoios({ raw: '{"error":"internal.koios.example is down"}' }).f, /: Koios utxo_info: Koios returned a non-list response$/],
      ['a transport error that names the endpoint', rejecting(new TypeError('connect ECONNREFUSED https://koios.example:8443/api/v1/utxo_info')), /: Koios request failed \(network error or timeout\)$/],
      ['a timeout', rejecting(timeout), /: Koios request failed \(network error or timeout\)$/],
      ['an HTTP error from credential_utxos', koiosFor([current], { credentialStatus: 502 }).f, /: Koios credential_utxos answered 502$/],
      ['a transport error from credential_utxos', after(1, transport), /: Koios request failed \(network error or timeout\)$/],
      ['an HTTP error from tx_info', koiosFor([current], { txStatus: 503 }).f, /: Koios tx_info answered 503$/],
      ['a transport error from tx_info', after(2, new TypeError('connect ECONNREFUSED https://koios.example:8443/api/v1/tx_info')), /: Koios request failed \(network error or timeout\)$/],
    ];
    for (const [name, f, message] of cases) {
      await assert.rejects(() => resolveEscrowLineage(new FixtureProvider([current]), KOIOS, ESCROW_REF, f), (err: unknown) => {
        assert.ok(err instanceof Error, name);
        assert.ok(err.message.startsWith(`Could not read escrow ${ESCROW_REF}: `), `${name}: ${err.message}`);
        assert.match(err.message, message, name);
        for (const leak of LEAKS) assert.ok(!err.message.includes(leak), `${name}: "${leak}" leaked into: ${err.message}`);
        return true;
      }, name);
    }
  });
  test('a node failure is an Error that names the escrow and carries neither the endpoint nor a response body', async () => {
    const LEAKS = ['http://', 'https://', 'ogmios.example', 'hunter2', 'Service Unavailable', 'ECONNREFUSED', 'Invalid params'];
    const cases: Array<[string, Error, RegExp]> = [
      ['an HTTP error', new Error('Ogmios request failed (queryLedgerState/utxo): 503 Service Unavailable'), /from the node: Ogmios request failed \(queryLedgerState\/utxo\): 503$/],
      ['a JSON-RPC error with details', new Error('Ogmios request failed (queryLedgerState/utxo): -32602 Invalid params: {"password":"hunter2"} at https://ogmios.example'), /from the node: Ogmios request failed \(queryLedgerState\/utxo\): -32602$/],
      ['a network error', new Error('Ogmios request failed (queryLedgerState/utxo): network error'), /from the node: Ogmios request failed \(queryLedgerState\/utxo\): network error$/],
      ['anything else, which may carry the endpoint', new TypeError('connect ECONNREFUSED https://ogmios.example:1337'), /from the node: node request failed \(network error or timeout\)$/],
    ];
    for (const [name, error, message] of cases) {
      const node = Object.assign(new FixtureProvider([current]), { getUtxosByOutRef: async () => { throw error; } });
      for (const k of [koiosFor([current]), escrowKoios({ spent: false })]) {
        await assert.rejects(() => resolveEscrowLineage(node, KOIOS, ESCROW_REF, k.f), (err: unknown) => {
          assert.ok(err instanceof Error, name);
          assert.ok(err.message.startsWith(`Could not read escrow ${ESCROW_REF} from the node: `), `${name}: ${err.message}`);
          assert.match(err.message, message, name);
          for (const leak of LEAKS) assert.ok(!err.message.includes(leak), `${name}: "${leak}" leaked into: ${err.message}`);
          return true;
        }, name);
      }
    }
  });

  // Koios pages at 1,000 rows and the escrow credential holds thousands of outputs, so candidates are found by asking Koios for
  // the outputs whose datum carries this escrow's prompt hash (a server-side filter), page by page.
  test('candidates are the outputs whose datum carries the prompt hash, read page by page however many copies there are', async () => {
    const flood = Array.from({ length: 250 }, (_, i) => at(i.toString(16).padStart(64, '0'), claimedDatum)); // 250 copies, all unknown to Koios's tx_info
    const bystanders = Array.from({ length: 40 }, (_, i) => at((i + 0x1000).toString(16).padStart(64, '0'), { ...claimedDatum, prompt_hash: 'ab'.repeat(32), posted_at: i }));
    const w = world([...flood, ...bystanders, claimed]);
    const r = await resolve(w);
    assert.equal(r.current?.utxo.txHash, CLAIM_TX);
    const reads = credentialRequests(w.koios);
    assert.equal(reads.length, 3, '251 matching rows, 100 to a page');
    assert.deepEqual(reads.map((c) => new URL(c.url!).searchParams.get('offset')), ['0', '100', '200']);
    for (const c of reads) assert.equal(new URL(c.url!).searchParams.get('inline_datum->>bytes'), `like.*${posted.prompt_hash}*`, 'the bystanders\' other prompt hash never comes back');
    const batches = txInfoRequests(w.koios);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].body._tx_hashes.length, 251);
  });
  test('a credential with more matching outputs than the read allows is refused, not truncated', async () => {
    const lots = Array.from({ length: 5_050 }, (_, i) => at(i.toString(16).padStart(64, '0'), claimedDatum));
    await assert.rejects(() => lineage([...lots, claimed]), refusal(/: Koios credential_utxos: 5000 or more outputs matched; refusing to read them all$/));
  });
  // The prompt hash is what the candidate read searches for (1 to 128 bytes of hex). Anyone can lock an output at the escrow
  // credential with a prompt hash of another size, and a spent one of those is a permanent refusal: wording it as a failed Koios
  // call would send the caller off to retry something that cannot change.
  test('a spent Post output whose prompt hash cannot be searched for is refused for good, not as a Koios failure to retry', async () => {
    const rootWith = (bytes: number) => {
      const datum = Data.from(ESCROW_OPEN_DATUM_HEX) as Constr<Data>;
      datum.fields[5] = 'ab'.repeat(bytes); // the prompt hash; Lucid frames a bytestring over 64 bytes in chunks, as the ledger does
      return { tx_hash: ESCROW_TX, tx_index: 0, address: ESCROW_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), is_spent: true, inline_datum: { bytes: Data.to(datum) } };
    };
    for (const bytes of [0, 129, 1000]) {
      const w = world([], { rows: [rootWith(bytes)] });
      await assert.rejects(() => resolve(w), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, `Escrow ${ESCROW_REF} cannot be followed: its prompt hash is ${bytes} bytes, outside the 1 to 128 bytes the lookup supports; retrying will not change that.`);
        return true;
      }, `${bytes} bytes`);
      assert.equal(credentialRequests(w.koios).length, 0, `${bytes} bytes: Koios was not asked to search`);
    }
    // the ends of the range are searched for as usual, and finding nothing is "no continuation", not a refusal
    for (const bytes of [1, 128]) {
      const w = world([], { rows: [rootWith(bytes)] });
      assert.equal((await resolve(w)).current, null, `${bytes} bytes`);
      assert.equal(credentialRequests(w.koios).length, 1);
    }
  });
  test('an unspent Post output needs no search, so its prompt hash does not matter', async () => {
    const odd = at(ESCROW_TX, { ...posted, prompt_hash: '' });
    const row = { tx_hash: ESCROW_TX, tx_index: 0, address: ESCROW_ADDRESS, value: String(ESCROW_LOCKED_LOVELACE), is_spent: false, inline_datum: { bytes: encodeEscrowDatum({ ...posted, prompt_hash: '' }) } };
    assert.equal((await lineage([odd], { rows: [row] })).current?.utxo, odd);
  });
});
