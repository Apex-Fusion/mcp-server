// packages/builder/test/fixtures/capture-advert-stake-golden.mjs
//
// One-time capture: reads the mainnet transactions, outputs and scripts the advert tests hold the builders against,
// from Vector mainnet Koios, and writes advert-stake-golden.fixture.ts. Read-only: it posts queries to Koios and nothing else. Run it
// manually when the golden set changes:
//
//   node packages/builder/test/fixtures/capture-advert-stake-golden.mjs [output path]
//
// VECTOR_MAINNET_KOIOS_URL overrides the Koios base (default https://v2.koios.vector.mainnet.apexfusion.org). Never runs in CI: the unit
// tests read the checked-in fixture. Spent outputs are still served by utxo_info, so a capture made later writes the same file.
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KOIOS = (process.env.VECTOR_MAINNET_KOIOS_URL || 'https://v2.koios.vector.mainnet.apexfusion.org').replace(/\/+$/, '') + '/api/v1';
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), 'advert-stake-golden.fixture.ts');

// ─── What is captured ────────────────────────────────────────────────────────
// The owners of the first two service agents: the address of the wallet output that each one's self-stake spent (a spent output is still
// served by utxo_info).
const OWNERS = [
  { name: 'STAKE_A', comment: "Advocate: the owner address (the wallet of its self-stake 82fdc231...).", wallet: '0ffc11c5aa4eb0bb094b08c39cbaf9f38e48445c3cb715f471a6295e6d066a0d#1' },
  { name: 'STAKE_B', comment: "Audio Snippets: the owner address (the wallet of its self-stake a23857f9...).", wallet: '9b6345abf3fb4b909b662f6edf416456a1ec104f516c198ee84b57d167616005#1' },
];
const MODULE = { advertScript: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#1' };
const SCRIPT_HASHES = { advert: '9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da' };
const ADVERT_POSTS = [
  'b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c', '16a5da8726cab90949da2c0c92e025af276027715a5d854861c683d7d9341ca3',
  '6cc1a8a7776ff6202a95ef6496a73dd521970bb7fa252b8a265c6e204e7ec489', '7dee930257e3d48d16fa267280899042e1619fe57d881c24dd9a332487212b2c',
  '199a5eed5fa377ed35a8fad726b99d2d59beac93bd33ab3eb891b70a98927deb',
];
const RETIRE = { tx: '998499f2826dc80639e6606893f49568fa8c3fb3f3b001138b67637ba58f2374', advert: '6cc1a8a7776ff6202a95ef6496a73dd521970bb7fa252b8a265c6e204e7ec489#0' };

// ─── Koios ───────────────────────────────────────────────────────────────────
async function post(path, body) {
  const res = await fetch(`${KOIOS}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: Koios answered ${res.status}`);
  return res.json();
}
const TX_INFO = { _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: true, _bytecode: false };
const keyOf = (u) => `${u.tx_hash}#${u.tx_index}`;

const utxoRefs = [
  ...OWNERS.map((o) => o.wallet), ...Object.values(MODULE), RETIRE.advert,
  ...ADVERT_POSTS.map((h) => `${h}#0`),
];
const utxos = new Map((await post('/utxo_info', { _utxo_refs: [...new Set(utxoRefs)], _extended: true })).map((u) => [keyOf(u), u]));
const scripts = new Map((await post('/script_info', { _script_hashes: Object.values(SCRIPT_HASHES) })).map((s) => [s.script_hash, s.bytes]));
const txs = new Map((await post('/tx_info', { _tx_hashes: [...ADVERT_POSTS, RETIRE.tx], ...TX_INFO })).map((t) => [t.tx_hash, t]));
for (const ref of utxoRefs) if (!utxos.has(ref)) throw new Error(`utxo_info did not return ${ref}`);
for (const [what, hash] of Object.entries(SCRIPT_HASHES)) if (!scripts.get(hash)) throw new Error(`script_info did not return the ${what} script`);

// ─── Writing ─────────────────────────────────────────────────────────────────
// JSON written the way the first capture wrote it (Python's json.dumps: ", " and ": "), so a capture of the same chain writes the same file.
const pyJson = (v) => Array.isArray(v) ? `[${v.map(pyJson).join(', ')}]`
  : v !== null && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ')}}`
  : JSON.stringify(v);
const ts = (ref) => {
  const u = utxos.get(ref);
  const assets = [['lovelace', u.value], ...(u.asset_list ?? []).map((a) => [`'${a.policy_id}${a.asset_name}'`, a.quantity])];
  const [h, i] = ref.split('#');
  const parts = [`txHash: '${h}'`, `outputIndex: ${i}`, `address: '${u.address}'`, `assets: { ${assets.map(([k, q]) => `${k}: ${q}n`).join(', ')} }`];
  if (u.inline_datum?.bytes) parts.push(`datum: '${u.inline_datum.bytes}'`);
  return `{ ${parts.join(', ')} }`;
};
const refsOf = (list) => (list ?? []).map((r) => `${r.tx_hash}#${r.tx_index}`).sort();
const facts = (t) => ({
  txHash: t.tx_hash, slot: t.absolute_slot, invalidBefore: t.invalid_before, invalidAfter: t.invalid_after, fee: t.fee,
  referenceInputs: refsOf(t.reference_inputs), inputs: refsOf(t.inputs), collateral: refsOf(t.collateral_inputs),
  outputs: [...t.outputs].sort((a, b) => a.tx_index - b.tx_index).map((o) => ({
    index: o.tx_index, address: o.payment_addr.bech32, lovelace: o.value,
    assets: Object.fromEntries((o.asset_list ?? []).map((a) => [a.policy_id + a.asset_name, a.quantity])),
  })),
  minted: Object.fromEntries((t.assets_minted ?? []).map((a) => [a.policy_id + a.asset_name, a.quantity])),
  redeemers: (t.plutus_contracts ?? []).map((p) => ({ purpose: p.input.redeemer.purpose, scriptHash: p.script_hash, data: p.input.redeemer.datum.value }))
    .sort((a, b) => (a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : 0)),
});

const L = [];
const w = (line) => L.push(line);
w('// packages/builder/test/fixtures/advert-stake-golden.fixture.ts');
w('// Golden data for the advert builders, read from Vector mainnet through Koios (utxo_info, tx_info, script_info) by');
w('// capture-advert-stake-golden.mjs (first capture 2026-10-21). Do not edit by hand. The transactions:');
w("//   adverts: the four service agents' Posts (one of them retired since), built by the supplier template's CLI (vector-agent-template");
w('//   c4c378a, agent/src/cli/post-advert.ts); retire 998499f2...: Audio Snippets retiring its first advert 6cc1a8a7...#0 with the');
w("//   template's agent/src/cli/retire-advert.ts.");
w("//   owners: the addresses of the wallets that made the first two service agents' self-stakes.");
w("import type { UTxO } from '@lucid-evolution/lucid';");
w('');
w("/** What Koios reports of a transaction, kept for the comparisons: refs are '<txid>#<index>', sorted; amounts are strings. */");
w('export interface GoldenTx {');
w('  txHash: string; slot: number; invalidBefore: string | null; invalidAfter: string | null; fee: string;');
w('  referenceInputs: string[]; inputs: string[]; collateral: string[];');
w('  outputs: Array<{ index: number; address: string; lovelace: string; assets: Record<string, string> }>;');
w('  minted: Record<string, string>; redeemers: Array<{ purpose: string; scriptHash: string; data: unknown }>;');
w('}');
w('');
w('/** The compiled advert validator (Plutus V3), the reference script at c8d84c6d...#1; its hash is ADVERT_SCRIPT_HASH. */');
w(`export const ADVERT_SCRIPT_CBOR =\n  '${scripts.get(SCRIPT_HASHES.advert)}';`);
w('');
w("/** The advert module's reference output as the ledger holds it (the tests attach the reference script's bytes). */");
w(`export const ADVERT_REF_UTXO_BARE: UTxO = ${ts(MODULE.advertScript)};`);
w('');
for (const o of OWNERS) {
  w(`/** ${o.comment} */`);
  w(`export const ${o.name} = { ownerAddress: '${utxos.get(o.wallet).address}' };`);
}
w('');
w("/** The service agents' adverts as posted, with the facts of each Post transaction. */");
w('export const ADVERT_POSTS: Array<{ advertRef: string; datumHex: string; tx: GoldenTx }> = [');
for (const h of ADVERT_POSTS) w(`  { advertRef: '${h}#0', datumHex: '${utxos.get(`${h}#0`).inline_datum.bytes}', tx: ${pyJson(facts(txs.get(h)))} },`);
w('];');
w('');
w("/** The Retire of Audio Snippets' first advert: the advert as it was, the wallet output the template used, and the transaction's facts. */");
w('export const ADVERT_RETIRE: { advert: UTxO; wallet: UTxO; tx: GoldenTx } = {');
w(`  advert: ${ts(RETIRE.advert)},`);
const retire = txs.get(RETIRE.tx);
const walletInput = retire.inputs.find((i) => `${i.tx_hash}#${i.tx_index}` !== RETIRE.advert);
w(`  wallet: { txHash: '${walletInput.tx_hash}', outputIndex: ${walletInput.tx_index}, address: '${walletInput.payment_addr.bech32}', assets: { lovelace: ${walletInput.value}n } },`);
w(`  tx: ${pyJson(facts(retire))},`);
w('};');
writeFileSync(OUT, L.join('\n') + '\n');
console.log(`wrote ${OUT}`);
