// packages/builder/test/fixtures/capture-advert-stake-golden.mjs
//
// One-time capture: reads the mainnet transactions, outputs and scripts the advert and reputation-stake tests hold the builders against,
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
const REG = 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01';

// ─── What is captured ────────────────────────────────────────────────────────
const STAKES = [
  { name: 'STAKE_A', comment: 'Advocate: stake 82fdc231..., opening 0ffc11c5...#0, registry record 0699bc56...#0.',
    did: 'c5e44677dadefc8a194d15293cad889b85e1ce5c839177f1955778ac4c63d01c', tx: '82fdc231932405c105f8b8b03cc56c37c702d03befc1830e85d0debeeeabbb15',
    opening: '0ffc11c5aa4eb0bb094b08c39cbaf9f38e48445c3cb715f471a6295e6d066a0d#0', wallet: '0ffc11c5aa4eb0bb094b08c39cbaf9f38e48445c3cb715f471a6295e6d066a0d#1',
    registry: '0699bc56992695511fd3c55681deba4f9ad611cd5c526dcfe45758f203abe767#0', capabilities: ['research.advocate.onesided.v1'] },
  { name: 'STAKE_B', comment: 'Audio Snippets: stake a23857f9..., opening 9b6345ab...#0, registry record c101d9dd...#0.',
    did: '1532506e54fa79cdfca6bef566ff1a5e7af9fceb332ffb7414d9923334b9d1ee', tx: 'a23857f97c9197dd1051ef291decb06ee9cf5818339ac67ea120d0810720f3a3',
    opening: '9b6345abf3fb4b909b662f6edf416456a1ec104f516c198ee84b57d167616005#0', wallet: '9b6345abf3fb4b909b662f6edf416456a1ec104f516c198ee84b57d167616005#1',
    registry: 'c101d9dd20a82d573bbb4d8d0155c89de403de29a73f1a68f1afa642542dc83b#0', capabilities: ['audio.transcript.snippets.v1'] },
];
const REGISTRATION_TX = '0699bc56992695511fd3c55681deba4f9ad611cd5c526dcfe45758f203abe767';
const MODULE = {
  params: '705d6b572ac634fa1ec1fc9d4d35303be17b6f5a9ce30030955bb0f0d0d7a7fe#0',
  crossRefs: 'd79b722817548b4ba57ad5c887e7ee084ada3d1ad25a0ba7e152a5946dc5ccaa#0',
  reputationScript: 'dfa32f9c7a625f500a753bd4226b546c776f34cd68987e540786d50cacfa14bb#0',
  advertScript: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#1',
};
const SCRIPT_HASHES = { reputation: '5168e1871cfdb1e55c18ee173acbcdce092044a48bc2e23f3ba35093', advert: '9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da' };
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
  ...STAKES.flatMap((s) => [s.opening, s.wallet, s.registry, `${s.tx}#0`]), ...Object.values(MODULE), RETIRE.advert,
  ...ADVERT_POSTS.map((h) => `${h}#0`),
];
const utxos = new Map((await post('/utxo_info', { _utxo_refs: [...new Set(utxoRefs)], _extended: true })).map((u) => [keyOf(u), u]));
const scripts = new Map((await post('/script_info', { _script_hashes: Object.values(SCRIPT_HASHES) })).map((s) => [s.script_hash, s.bytes]));
const txs = new Map((await post('/tx_info', { _tx_hashes: [...STAKES.map((s) => s.tx), ...ADVERT_POSTS, RETIRE.tx], ...TX_INFO })).map((t) => [t.tx_hash, t]));
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
w('// Golden data for the advert and reputation-stake builders, read from Vector mainnet through Koios (utxo_info, tx_info, script_info) by');
w('// capture-advert-stake-golden.mjs (first capture 2026-10-21). Do not edit by hand. The transactions:');
w("//   stake A 82fdc231...: Advocate's self-stake, built by the reference Python SDK (create_stake), opening output 0ffc11c5...#0;");
w("//   stake B a23857f9...: Audio Snippets' self-stake, built the same way, opening output 9b6345ab...#0;");
w("//   registration 0699bc56...: Advocate's registry record, built by this server's vector_build_register_agent; stake A reads it;");
w("//   adverts: the four service agents' Posts (one of them retired since), built by the supplier template's CLI (vector-agent-template");
w('//   c4c378a, agent/src/cli/post-advert.ts); retire 998499f2...: Audio Snippets retiring its first advert 6cc1a8a7...#0 with the');
w("//   template's agent/src/cli/retire-advert.ts.");
w("import type { UTxO } from '@lucid-evolution/lucid';");
w('');
w("/** What Koios reports of a transaction, kept for the comparisons: refs are '<txid>#<index>', sorted; amounts are strings. */");
w('export interface GoldenTx {');
w('  txHash: string; slot: number; invalidBefore: string | null; invalidAfter: string | null; fee: string;');
w('  referenceInputs: string[]; inputs: string[]; collateral: string[];');
w('  outputs: Array<{ index: number; address: string; lovelace: string; assets: Record<string, string> }>;');
w('  minted: Record<string, string>; redeemers: Array<{ purpose: string; scriptHash: string; data: unknown }>;');
w('}');
w('export interface GoldenStake {');
w('  agentId: string; agentDidHex: string; capabilities: string[]; ownerAddress: string;');
w('  wallet: UTxO; opening: UTxO; registry: UTxO; stakeDatumHex: string; tx: GoldenTx;');
w('}');
w('');
w('/** The compiled reputation validator (Plutus V3), the reference script at dfa32f9c...#0; its hash is REPUTATION_SCRIPT_HASH. */');
w(`export const REPUTATION_SCRIPT_CBOR =\n  '${scripts.get(SCRIPT_HASHES.reputation)}';`);
w('/** The compiled advert validator (Plutus V3), the reference script at c8d84c6d...#1; its hash is ADVERT_SCRIPT_HASH. */');
w(`export const ADVERT_SCRIPT_CBOR =\n  '${scripts.get(SCRIPT_HASHES.advert)}';`);
w('');
w("/** The module's reference outputs as the ledger holds them (the tests attach the reference scripts' bytes). */");
w(`export const PARAMS_UTXO: UTxO = ${ts(MODULE.params)};`);
w(`export const CROSS_REFS_UTXO: UTxO = ${ts(MODULE.crossRefs)};`);
w(`export const REPUTATION_REF_UTXO_BARE: UTxO = ${ts(MODULE.reputationScript)};`);
w(`export const ADVERT_REF_UTXO_BARE: UTxO = ${ts(MODULE.advertScript)};`);
w('');
for (const s of STAKES) {
  w(`/** ${s.comment} */`);
  w(`export const ${s.name}: GoldenStake = {`);
  w(`  agentId: 'did:vector:agent:${REG}:${s.did}',`);
  w(`  agentDidHex: '${s.did}',`);
  w(`  capabilities: ${pyJson(s.capabilities)},`);
  w(`  ownerAddress: '${utxos.get(s.wallet).address}',`);
  w(`  wallet: ${ts(s.wallet)},`);
  w(`  opening: ${ts(s.opening)},`);
  w(`  registry: ${ts(s.registry)},`);
  w(`  stakeDatumHex: '${utxos.get(`${s.tx}#0`).inline_datum.bytes}',`);
  w(`  tx: ${pyJson(facts(txs.get(s.tx)))},`);
  w('};');
}
w('');
w('/** The registration of Advocate, built by vector_build_register_agent: STAKE_A.registry is its output 0. */');
w(`export const REGISTRATION_TX = '${REGISTRATION_TX}';`);
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
