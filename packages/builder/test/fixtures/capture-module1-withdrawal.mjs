// packages/builder/test/fixtures/capture-module1-withdrawal.mjs
//
// One-time capture: reads the mainnet Module-1 claim withdrawal b3a165bd... and the outputs it spent from Vector mainnet Koios
// (tx_info, utxo_info) and Blockfrost (required_signers), and writes module1-withdrawal-mainnet.json. Read-only: it sends queries and
// nothing else. Run it manually when the golden set changes:
//
//   node packages/builder/test/fixtures/capture-module1-withdrawal.mjs [output path]
//
// VECTOR_MAINNET_KOIOS_URL and VECTOR_MAINNET_BLOCKFROST_URL override the two bases. Never runs in CI: the unit tests read the checked-in
// file. Spent outputs are still served by utxo_info, so a capture made later writes the same file.
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KOIOS = (process.env.VECTOR_MAINNET_KOIOS_URL || 'https://v2.koios.vector.mainnet.apexfusion.org').replace(/\/+$/, '') + '/api/v1';
const BLOCKFROST = (process.env.VECTOR_MAINNET_BLOCKFROST_URL || 'https://blockfrost.vector.mainnet.apexfusion.org').replace(/\/+$/, '');
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), 'module1-withdrawal-mainnet.json');

// The withdrawal: the claimer took back a claim that nobody challenged (window 30 min, 50 AP3X).
const TX = 'b3a165bd55d1569cea444b3b5a7d1b4e7c282911836ada08553a37348640445f';
const CLAIM = '289b45d83745bd7a5e5cc329b6ee9070f90eeae121360b67d9c312a498b372f2#0';
const WALLET = ['289b45d83745bd7a5e5cc329b6ee9070f90eeae121360b67d9c312a498b372f2#1', 'f14576d9ac26917fd1d8b4763a0244d42c05020a16533c6b09d20ff4e814ee2a#0'];

const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'vector-mcp-builder-fixture-capture' };
async function post(path, body) {
  const res = await fetch(`${KOIOS}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: Koios answered ${res.status}`);
  return res.json();
}
async function get(path) {
  const res = await fetch(`${BLOCKFROST}${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: Blockfrost answered ${res.status}`);
  return res.json();
}

const [t] = await post('/tx_info', { _tx_hashes: [TX], _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: true, _bytecode: false });
if (!t || t.tx_hash !== TX) throw new Error('tx_info did not return the withdrawal');
const utxos = await post('/utxo_info', { _utxo_refs: [CLAIM, ...WALLET], _extended: true });
const signers = (await get(`/txs/${TX}/required_signers`)).map((s) => s.witness_hash).sort();

const refOf = (u) => `${u.tx_hash}#${u.tx_index}`;
const refsOf = (list) => (list ?? []).map(refOf).sort();
const assetsOf = (list) => Object.fromEntries((list ?? []).map((a) => [a.policy_id + a.asset_name, a.quantity]));
const utxoOf = (ref) => {
  const u = utxos.find((x) => refOf(x) === ref);
  if (!u) throw new Error(`utxo_info did not return ${ref}`);
  return { ref, address: u.address, lovelace: u.value, assets: assetsOf(u.asset_list), ...(u.inline_datum?.bytes ? { datum: u.inline_datum.bytes } : {}) };
};

const fixture = {
  _source: `Vector mainnet: Koios tx_info and utxo_info of ${TX} and of the outputs it spent, and Blockfrost required_signers; made by capture-module1-withdrawal.mjs. The withdrawal was built by the Python builder of vector-agent-modules (build_withdraw_claim); amounts are strings.`,
  // What Koios reports of the transaction, in the form of GoldenTx (advert-stake-golden.fixture.ts), and the required signers.
  tx: {
    txHash: t.tx_hash, slot: t.absolute_slot, invalidBefore: t.invalid_before, invalidAfter: t.invalid_after, fee: t.fee,
    referenceInputs: refsOf(t.reference_inputs), inputs: refsOf(t.inputs), collateral: refsOf(t.collateral_inputs),
    outputs: [...t.outputs].sort((a, b) => a.tx_index - b.tx_index).map((o) => ({ index: o.tx_index, address: o.payment_addr.bech32, lovelace: o.value, assets: assetsOf(o.asset_list) })),
    minted: assetsOf(t.assets_minted),
    redeemers: (t.plutus_contracts ?? []).map((p) => ({ purpose: p.input.redeemer.purpose, scriptHash: p.script_hash, data: p.input.redeemer.datum.value, dataHash: p.input.redeemer.datum.hash }))
      .sort((a, b) => (a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : 0)),
    requiredSigners: signers,
  },
  // The claim output that it spent (with its datum) and the wallet outputs that were there: the build of the same withdrawal starts from them.
  claim: utxoOf(CLAIM),
  wallet: WALLET.map(utxoOf),
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${OUT}`);
