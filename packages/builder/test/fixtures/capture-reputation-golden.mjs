// packages/builder/test/fixtures/capture-reputation-golden.mjs
//
// One-time capture: reads the outputs of the identity-era Module-3 deployment, three identity records and one stake output from Vector
// mainnet Koios, and writes reputation-golden.fixture.ts, which the reputation tests hold the builders and the codec against. Read-only: it
// posts queries to Koios and nothing else. Run it manually when the deployment changes:
//
//   node packages/builder/test/fixtures/capture-reputation-golden.mjs [output path]
//
// VECTOR_MAINNET_KOIOS_URL overrides the Koios base (default https://v2.koios.vector.mainnet.apexfusion.org). Never runs in CI: the unit
// tests read the checked-in fixture. Koios serves spent outputs through utxo_info too, so a later capture writes the same file for the
// deployment outputs (which nobody can spend: the records move only with the operator key, and the reference script has no key), and for a
// stake output or an identity record that a later action has spent.
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KOIOS = (process.env.VECTOR_MAINNET_KOIOS_URL || 'https://v2.koios.vector.mainnet.apexfusion.org').replace(/\/+$/, '') + '/api/v1';
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), 'reputation-golden.fixture.ts');

// ─── What is captured ────────────────────────────────────────────────────────
// Module-3/deploy/identity/mainnet/deploy_state.json of vector-agent-modules (tx_hashes.*), all at output 0.
const MODULE = {
  PARAMS_UTXO: 'bcd480d70063e2c7be3c9df2447b67a764e180fc73a3cd3481000a62fcd713d3#0',
  CROSS_REFS_UTXO: 'f194fa5a853e2a775fac5f8091b6d9d412adcfe6c5845512fa3304b00ebc7a44#0',
  REPUTATION_REF_UTXO: '0add1592bdf312fede7f66c48835dee17638af884d37e7246b2bab7e01752ae0#0',
};
const REPUTATION_HASH = 'fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424';
const IDENTITY_HASH = 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762';
// Identity records (the record token is named with the agent's identifier). Each: why the tests use it.
const RECORDS = [
  { name: 'CHANDRA', comment: 'ChandraOCR: an Active root record with four capabilities and a listed key that has the transaction purpose (the controller key is not listed).',
    id: '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', ref: '1459cdeb196d8b48710422af924dddba378c2bb8f0b9a07d1438d7a01145a73e#0' },
  { name: 'REVOKED', comment: 'A revoked root record (a tombstone): the exit of a stake reads it as it is.',
    id: '96f147f41d1c4cca8dc926befd2198bbed0d37b74417d29333ea8e98d4edddfc', ref: '913748df4ba5053e911ae269e2c2237ff0aca48cd6b220e6c6aab921275c8ca4#0' },
  { name: 'RETIRED_SUBAGENT', comment: 'A retired subagent record (a tombstone with a parent): the exit reads no ancestor.',
    id: '3d7a86639db2e21ab5538058aaff2c45aa9b9c7b4354653575bb4f5ec05b7a1e', ref: 'acb1a1224ec0c89c52dbdd56d7b262fda27b5d0d33508871ed59974c38e812ec#0' },
];

// A stake output of the deployment: the output that a decrease of 2026-11-23 wrote on the stake of a test record of the Foundation.
// `comment` is its doc comment in the fixture.
const STAKE = {
  ref: '48d4ce7bbd9141a0e5787af08a2cb14aa6c75b64134f874fa64bc8a4155eb6ad#0',
  comment: [
    'A stake output of the deployment, as the chain holds it: the stake of a test record of the Foundation, made with the stake tools of this server.',
    'Its decrease of 2026-11-23 wrote this output. It holds 11 AP3X, the stake token of its agent, two capabilities and no challenge lock.',
  ],
};

// ─── Koios ───────────────────────────────────────────────────────────────────
async function post(path, body) {
  const res = await fetch(`${KOIOS}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'vector-mcp-builder-capture' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: Koios answered ${res.status}`);
  return res.json();
}
const keyOf = (u) => `${u.tx_hash}#${u.tx_index}`;

const refs = [...Object.values(MODULE), ...RECORDS.map((r) => r.ref), STAKE.ref];
const utxos = new Map((await post('/utxo_info', { _utxo_refs: refs, _extended: true })).map((u) => [keyOf(u), u]));
for (const ref of refs) if (!utxos.has(ref)) throw new Error(`utxo_info did not return ${ref}`);
const scripts = await post('/script_info', { _script_hashes: [REPUTATION_HASH] });
const script = scripts.find((s) => s.script_hash === REPUTATION_HASH);
if (!script?.bytes) throw new Error('script_info did not return the reputation script');
const refScript = utxos.get(MODULE.REPUTATION_REF_UTXO).reference_script;
if (refScript?.hash !== REPUTATION_HASH || refScript.bytes !== script.bytes) throw new Error('the reference script output does not carry the script that script_info returns');
for (const r of RECORDS) {
  const u = utxos.get(r.ref);
  const held = (u.asset_list ?? []).filter((a) => a.policy_id === IDENTITY_HASH);
  if (held.length !== 1 || held[0].asset_name !== r.id || held[0].quantity !== '1' || !u.inline_datum?.bytes) throw new Error(`${r.ref} is not the record of ${r.id}`);
}
const stake = utxos.get(STAKE.ref);
const stakeTokens = (stake.asset_list ?? []).filter((a) => a.policy_id === REPUTATION_HASH);
if (stake.payment_cred !== REPUTATION_HASH || stakeTokens.length !== 1 || stakeTokens[0].quantity !== '1' || !stake.inline_datum?.bytes) throw new Error(`${STAKE.ref} is not a stake output of the reputation validator`);

// ─── Writing ─────────────────────────────────────────────────────────────────
const ts = (ref, withScript = false) => {
  const u = utxos.get(ref);
  const assets = [['lovelace', u.value], ...(u.asset_list ?? []).map((a) => [`'${a.policy_id}${a.asset_name}'`, a.quantity])];
  const [h, i] = ref.split('#');
  const parts = [`txHash: '${h}'`, `outputIndex: ${i}`, `address: '${u.address}'`, `assets: { ${assets.map(([k, q]) => `${k}: ${q}n`).join(', ')} }`];
  if (u.inline_datum?.bytes) parts.push(`datum: '${u.inline_datum.bytes}'`);
  if (withScript) parts.push('scriptRef: { type: \'PlutusV3\', script: REPUTATION_SCRIPT_CBOR }');
  return `{ ${parts.join(', ')} }`;
};

const L = [];
const w = (line) => L.push(line);
w('// packages/builder/test/fixtures/reputation-golden.fixture.ts');
w('// Golden data for the reputation stake builders, read from Vector mainnet through Koios (utxo_info, script_info) by');
w('// capture-reputation-golden.mjs. Do not edit by hand. It holds the outputs of the identity-era Module-3 deployment (deploy_state.json of');
w('// vector-agent-modules Module-3/deploy/identity/mainnet, deployed 2026-11-03) and three identity records of the identity registry that');
w('// the reputation validator reads. It also holds one stake output of the deployment: the tests of the codec and of the reader use it, and the builder tests build their stakes.');
w("import type { UTxO } from '@lucid-evolution/lucid';");
w('');
w('/** The compiled reputation validator (Plutus V3) as the reference script output holds it; its hash is REPUTATION_SCRIPT_HASH. */');
w(`export const REPUTATION_SCRIPT_CBOR =\n  '${script.bytes}';`);
w('');
w('/** The reference script output as the ledger holds it: at the address of the zero key hash, which nobody can spend. */');
w(`export const REPUTATION_REF_UTXO: UTxO = ${ts(MODULE.REPUTATION_REF_UTXO, true)};`);
w('/** The module parameters record: at the params holder, with the one-shot token `params` and the 22-field datum. */');
w(`export const PARAMS_UTXO: UTxO = ${ts(MODULE.PARAMS_UTXO)};`);
w('/** The cross-validator references: the token `reputation_refs`, and a datum that names the reputation and the endorsement validators. */');
w(`export const CROSS_REFS_UTXO: UTxO = ${ts(MODULE.CROSS_REFS_UTXO)};`);
w('');
w('/**');
for (const line of STAKE.comment) w(` * ${line}`);
w(' */');
w(`export const LIVE_STAKE_UTXO: UTxO = ${ts(STAKE.ref)};`);
w('');
w('/** The identity records, at the identity address with their record tokens. `id` is the identifier (the token name). */');
w('export const AGENT_RECORDS: Record<string, { id: string; utxo: UTxO }> = {');
for (const r of RECORDS) {
  w(`  // ${r.comment}`);
  w(`  ${r.name}: { id: '${r.id}', utxo: ${ts(r.ref)} },`);
}
w('};');
w('');
writeFileSync(OUT, L.join('\n'));
console.log(`wrote ${OUT}`);
