// packages/builder/test/fixtures/capture-ledger-read.mjs
//
// One-time capture: reads the mainnet outputs and transactions that the tests of the attestation, delegation and vault read tools hold
// the code against, from Vector mainnet Koios, and writes ledger-read-mainnet.json. Read-only: it sends queries to Koios and nothing
// else. It needs the TypeScript loader, because it encodes datums with the codec of the builder. Run it manually when the set changes:
//
//   node --import tsx packages/builder/test/fixtures/capture-ledger-read.mjs [output path]
//
// The output path must lie inside this folder: a wrong argument must not overwrite another file. VECTOR_MAINNET_KOIOS_URL overrides the
// Koios base (default https://v2.koios.vector.mainnet.apexfusion.org); the file does not record it, as it is operator configuration. The
// script never runs in CI: the unit tests read the checked-in file. The live sets (the unspent attestation and vault outputs, the live
// delegation) change with the chain, so a later capture writes another file; the output records the tip that it was read at.
//
// What it holds, as Koios rows:
//  - every unspent output at the attestation credential: attestations of types 0, 3 and 15, one of them revoked, with and without an
//    issuer record. The locators are replaced, except in the attestation of the Foundation smoke test (capture-neutral.ts);
//  - the two delegations that exist or existed: one burned (its mint output, which is spent) and one live;
//  - every unspent output at the vault credential: one Live output and the Returned outputs of refunds;
//  - the transaction of a vault payment (inputs and scripts), and as its twin the transaction of an escrow that no vault paid.
// The organisation text of a delegator or of a vault owner is replaced too (none of the rows has one today). Each row is checked
// against the published script hashes before it is written. The file says in its `note` what it changes.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neutralAttestation, neutralDelegationRow, neutralVaultJson, neutralVaultRow, outputInside } from './capture-neutral.ts';

const FIXTURES = dirname(fileURLToPath(import.meta.url));
// The first thing the script does: a refusal comes before any request.
const OUT = outputInside(FIXTURES, process.argv[2] ?? join(FIXTURES, 'ledger-read-mainnet.json'));
const KOIOS = `${(process.env.VECTOR_MAINNET_KOIOS_URL || 'https://v2.koios.vector.mainnet.apexfusion.org').replace(/\/+$/, '')}/api/v1`;

// ─── What is captured ────────────────────────────────────────────────────────
// The script hashes of the identity deployment on mainnet (contracts/identity-marketplace/deploy/mainnet/deployment.json).
const HASHES = {
  attestation: 'f07c644e042ead094cc501f443e03a8955dc1f4d0dcd5b387863e042',
  delegation: 'bdc16990b844a8860f28c51bb0e6a469c84bebcd57db699ce204785a',
  escrow: 'bdd86d9ac1e6f2ef6bcf81c14522f86ada1b438ca7ae0c90c8459deb',
  vault: 'bd45078144effb5011f161d8bb433f2ee360da458644fca9b818097a',
};
// The mint outputs of the two delegations (the first is burned, so its output is spent).
const DELEGATIONS = {
  burned: { id: '57b5e39fbe5986f40c34c618ca3dd06d463186dfaf0b61e488c7305b53db271b', mintOutput: 'dd81a4b796c8be7a83af2bfa6e02ff8886238db82b391a363de57239f3a96475#0' },
  live: { id: '5b48163362d540ae0cd630882634dd1afb07d274c64dabd8fe57596533b55a66', mintOutput: '0e2701b1827b0bd834c4e6deb9ba94080fa0a6b2cbacbc6c65c663b11cac95b7#0' },
};
// A vault payment: its transaction spends a Live vault output of the live delegation and makes the escrow at output 0.
const PAYMENT = { tx: '91d11516dfb7534ae40b19fce9a94f27ff1ee8629c0c40171bfcd78dd2158805', escrowRef: '91d11516dfb7534ae40b19fce9a94f27ff1ee8629c0c40171bfcd78dd2158805#0' };
// Its twin: a plain post of an escrow from a key wallet. No vault is among its inputs.
const PLAIN = { tx: '3f4569779f4be3190865dbb51fe0c353fe6087320250a14fb1f64c484b30d8b5', escrowRef: '3f4569779f4be3190865dbb51fe0c353fe6087320250a14fb1f64c484b30d8b5#0' };

// ─── Koios ───────────────────────────────────────────────────────────────────
const HEADERS = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'vector-mcp-builder-capture' };
async function call(route, init, query = '') {
  const res = await fetch(`${KOIOS}/${route}${query}`, { ...init, headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${route}: Koios answered ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`${route}: Koios did not answer with a list`);
  return body;
}
const post = (route, body, query) => call(route, { method: 'POST', body: JSON.stringify(body) }, query);

/** Every unspent output at a payment credential, in the order (tx hash, index), as Koios gives the rows. */
async function credentialRows(credential) {
  const rows = [];
  for (const page = 1000; ;) {
    const part = await post('credential_utxos', { _payment_credentials: [credential], _extended: true }, `?order=tx_hash.asc,tx_index.asc&offset=${rows.length}&limit=${page}`);
    rows.push(...part);
    if (part.length < page) return rows;
  }
}
const keyOf = (u) => `${u.tx_hash}#${u.tx_index}`;
const expect = (ok, what) => { if (!ok) throw new Error(`capture refused: ${what}`); };

// ─── Reading ─────────────────────────────────────────────────────────────────
const [tip] = await call('tip', { method: 'GET' });
const attestations = await credentialRows(HASHES.attestation);
const vaults = await credentialRows(HASHES.vault);
const delegations = new Map((await post('utxo_info', { _utxo_refs: Object.values(DELEGATIONS).map((d) => d.mintOutput), _extended: true })).map((u) => [keyOf(u), u]));
const TX_INFO = { _inputs: true, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: true, _bytecode: false };
const txs = new Map((await post('tx_info', { _tx_hashes: [PAYMENT.tx, PLAIN.tx], ...TX_INFO })).map((t) => [t.tx_hash, t]));

// ─── Checks: what was read is what the tests say it is ────────────────────────
const unit = (hash) => (a) => a.policy_id === hash;
expect(attestations.length > 0 && attestations.every((r) => r.payment_cred === HASHES.attestation && !r.is_spent), 'an attestation row is not an unspent output at the attestation credential');
expect(attestations.every((r) => (r.asset_list ?? []).filter(unit(HASHES.attestation)).length === 1), 'an attestation output does not hold exactly one attestation token');
expect(vaults.length > 0 && vaults.every((r) => r.payment_cred === HASHES.vault && !r.is_spent), 'a vault row is not an unspent output at the vault credential');
for (const [name, d] of Object.entries(DELEGATIONS)) {
  const row = delegations.get(d.mintOutput);
  expect(row !== undefined && row.payment_cred === HASHES.delegation, `utxo_info did not return the mint output of the ${name} delegation`);
  expect(row.asset_list.some((a) => a.policy_id === HASHES.delegation && a.asset_name === d.id && a.quantity === '1'), `the mint output of the ${name} delegation does not hold its token`);
}
expect(delegations.get(DELEGATIONS.burned.mintOutput).is_spent === true, 'the burned delegation output is not spent');
for (const p of [PAYMENT, PLAIN]) {
  const tx = txs.get(p.tx);
  const [hash, index] = p.escrowRef.split('#');
  expect(tx !== undefined && hash === p.tx, `tx_info did not return ${p.tx}`);
  expect(tx.outputs.some((o) => o.tx_index === Number(index) && o.payment_addr?.cred === HASHES.escrow), `output ${p.escrowRef} is not at the escrow credential`);
  expect(tx.plutus_contracts.every((c) => c.valid_contract === true), `a script run of the transaction ${p.tx} did not pass script validation`);
}
const vaultInputs = (tx) => tx.inputs.filter((i) => i.payment_addr?.cred === HASHES.vault);
expect(vaultInputs(txs.get(PAYMENT.tx)).length === 1, 'the payment does not spend exactly one vault output');
expect(txs.get(PAYMENT.tx).plutus_contracts.some((c) => c.script_hash === HASHES.vault && c.input?.redeemer?.datum?.value?.constructor === 0), 'the payment ran no vault script with the Pay redeemer');
expect(vaultInputs(txs.get(PLAIN.tx)).length === 0 && txs.get(PLAIN.tx).plutus_contracts.length === 0, 'the plain escrow transaction spends a vault output or runs a script');

// ─── Writing ─────────────────────────────────────────────────────────────────
// The text of an attestation is the text of the party that wrote it: its locator names a host and a path of that party. The locator (and
// the contest reply, if there is one) of every attestation but the one of the Foundation smoke test is replaced by a neutral value of the
// same form, and so is the organisation of a delegator or a vault owner (capture-neutral.ts). The same row gets the same value in each run.
let locators = 0;
let organisations = 0;
/** A row after the neutral text is put in; `count` says how many rows changed. */
const taken = (neutral, count) => { if (neutral.changed) count(); return neutral.row; };
const idOf = (row) => row.asset_list.find((a) => a.policy_id === HASHES.attestation).asset_name;
const neutralAttestations = attestations.map((row) => taken(neutralAttestation(row, idOf(row)), () => { locators += 1; }));
const neutralVaults = vaults.map((row) => taken(neutralVaultRow(row), () => { organisations += 1; }));
const neutralDelegation = (name) => taken(neutralDelegationRow(delegations.get(DELEGATIONS[name].mintOutput)), () => { organisations += 1; });

// A transaction is written with what the reads use: its inputs, the places of its outputs and the scripts that ran.
// Its reference inputs are left out, and so are the datums of its outputs: they hold the records and escrow terms of agents, whose profile
// text the tests do not need and the repository should not carry. The vault input keeps its datum, which the payment check reads.
const neutralInput = (i) => {
  if (i.payment_addr?.cred !== HASHES.vault || !i.inline_datum) return i;
  const owner = neutralVaultJson(i.inline_datum.value);
  if (owner.changed) organisations += 1;
  return owner.changed ? { ...i, inline_datum: { ...i.inline_datum, value: owner.row } } : i;
};
const slim = (t) => ({
  tx_hash: t.tx_hash, block_height: t.block_height, absolute_slot: t.absolute_slot, inputs: t.inputs.map(neutralInput),
  outputs: t.outputs.map((o) => ({ ...o, inline_datum: null })), plutus_contracts: t.plutus_contracts,
});
const payment = { escrow_ref: PAYMENT.escrowRef, delegation: DELEGATIONS.live.id, tx: slim(txs.get(PAYMENT.tx)) };
const plainEscrow = { escrow_ref: PLAIN.escrowRef, tx: slim(txs.get(PLAIN.tx)) };
// The note counts the rows that changed, so every row is made before the note is written.
const burnedOutput = neutralDelegation('burned');
const liveOutput = neutralDelegation('live');
const fixture = {
  note: `Rows that Koios gave for Vector mainnet, with these changes: the locators of ${locators} attestations are replaced by https://example.invalid/a/<first 8 hex of the attestation id>, and the organisation text of ${organisations} delegation or vault rows is replaced by a neutral text; the datums of these rows are encoded again, so they carry no datum_hash and no JSON datum value; the attestation of the Foundation smoke test of 2026-11-03 is as read; a transaction keeps its inputs, the places of its outputs and its scripts. This file is not byte-true chain data.`,
  captured: { at: new Date().toISOString(), tip: { block_height: tip.block_height, abs_slot: tip.abs_slot, block_time: tip.block_time } },
  hashes: HASHES,
  attestations: neutralAttestations,
  delegations: {
    burned: { id: DELEGATIONS.burned.id, mint_output: burnedOutput },
    live: { id: DELEGATIONS.live.id, mint_output: liveOutput },
  },
  vaults: neutralVaults,
  payment,
  plain_escrow: plainEscrow,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${OUT}: ${attestations.length} attestation outputs (${locators} with a replaced locator), ${vaults.length} vault outputs, ${organisations} organisation texts replaced, tip ${tip.block_height}`);
