// packages/builder/scripts/capture-gov-state.mjs
//
// One-time capture: deployed-state fixture for the self-improvement family's
// keyless build core (gov-build.ts). Pulls the 2 reference-script UTxOs, the
// 3 module infrastructure UTxOs, and one live sample proposal UTxO straight
// from Ogmios (raw JSON-RPC, queryLedgerState/utxo), then derives the
// audit-#10 golden token-name pin from the sample's own producing
// transaction (via Koios tx_utxos). Validates every piece before writing so
// the fixture can never silently drift from deployed bytecode - a failed
// validation exits non-zero instead of writing a bad file.
//
// deriveProposalTokenName is inlined below rather than imported from
// gov-build.ts: this script is step 1 of the TDD sequence and runs before
// gov-build.ts exists. Keep this copy byte-for-byte identical to
// gov-build.ts's exported version (both trace to the custodial
// self-improvement.ts original, audit-#10 verified against deployed
// bytecode).
//
// Resolves its own location via import.meta.dirname, so it behaves
// identically regardless of invocation cwd (same convention as
// regen-tool-schemas.mjs). Never runs in CI - unit tests read the
// checked-in JSON at test/fixtures/gov-state.fixture.json.
//
// Run manually (reaches the live testnet):
//   node packages/builder/scripts/capture-gov-state.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Data, Constr, credentialToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';

const OGMIOS = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const KOIOS = (process.env.VECTOR_KOIOS_URL || 'https://v2.koios.vector.testnet.apexfusion.org/').replace(/\/+$/, '') + '/api/v1';

const GOV_PROPOSAL_SPEND_HASH = process.env.GOV_PROPOSAL_SPEND_HASH || 'f815f51a76002d6a973e83fecf60f45473e040acee85c631fcce134d';
const GOV_PROPOSAL_MINT_HASH = process.env.GOV_PROPOSAL_MINT_HASH || 'e8f38052352a3d20c5fe025e2a02d615826a154b26f2239286b8d565';

function parseRef(ref) {
  const [txHash, idx] = ref.split('#');
  return { txHash, index: Number(idx) };
}

const SPEND_REF = parseRef(process.env.GOV_PROPOSAL_SPEND_REF || 'c70a410c9c0c543a0a1103049680b89cbf6fd2277e8469c4d52632dc52b80996#0');
const MINT_REF = parseRef(process.env.GOV_PROPOSAL_MINT_REF || 'c40b64fff5c4056689354076aa3d06431d786a4f8f0c1e492e70261d2309e50a#0');
const INFRA = [
  ['PARAMS', process.env.GOV_PARAMS_UTXO || '2c082e833649175b4a543a5a0cf61f9b736acdfa0d315d1184645185e9a52796#0'],
  ['ORACLE', process.env.GOV_ORACLE_UTXO || '7a23dfdf9468dd35cee3cad03008f2538c86834d4e5140e0ffaf2ff93e7c04a7#0'],
  ['CROSSREFS', process.env.GOV_CROSSREFS_UTXO || '96a4acff8be0fb96b3839ee6c9c1fa75809b94f4967218eaf813ac56b939c4b2#0'],
].map(([name, ref]) => ({ name, ...parseRef(ref) }));

async function ogmios(method, params) {
  const r = await fetch(OGMIOS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!r.ok) throw new Error(`Ogmios HTTP error (${r.status}) calling ${method}: ${await r.text()}`);
  const j = await r.json();
  if (j.error) throw new Error(`Ogmios RPC error calling ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Same shape OgmiosProvider.ogmiosUtxosToLucid checks (packages/shared/src/provider.ts):
// inline datum arrives as a plain CBOR-hex string on `output.datum` for this
// Ogmios version; only fall through to the object forms defensively.
function extractDatum(output) {
  if (!output.datum) return null;
  if (typeof output.datum === 'string') return output.datum;
  if (output.datum.value || output.datum.bytes) return output.datum.value || output.datum.bytes;
  return null;
}

function deriveTokenName(prefix, cborHex) {
  const hashBytes = blake2b(Buffer.from(cborHex, 'hex'), { dkLen: 32 });
  const prefixHex = Buffer.from(prefix, 'utf-8').toString('hex');
  const hashSlice = Buffer.from(hashBytes).toString('hex').slice(0, 54); // 27 bytes = 54 hex chars
  return prefixHex + hashSlice;
}

function deriveProposalTokenName(txHash, outputIndex) {
  const outRefCbor = Data.to(new Constr(0, [txHash, BigInt(outputIndex)]));
  return deriveTokenName('prop_', outRefCbor);
}

const failures = [];
const fail = (msg) => failures.push(msg);

console.log(`Ogmios: ${OGMIOS}`);
console.log(`Koios:  ${KOIOS}`);

console.log('\nFetching reference-script UTxOs...');
const refUtxoResults = await ogmios('queryLedgerState/utxo', {
  outputReferences: [
    { transaction: { id: SPEND_REF.txHash }, index: SPEND_REF.index },
    { transaction: { id: MINT_REF.txHash }, index: MINT_REF.index },
  ],
});
const refScripts = [];
for (const [label, ref, expectedHash] of [
  ['spend', SPEND_REF, GOV_PROPOSAL_SPEND_HASH],
  ['mint', MINT_REF, GOV_PROPOSAL_MINT_HASH],
]) {
  const u = refUtxoResults.find((x) => x.transaction.id === ref.txHash && x.index === ref.index);
  if (!u) { fail(`${label} reference script UTxO not found: ${ref.txHash}#${ref.index}`); continue; }
  const lang = u.script?.language;
  const cbor = u.script?.cbor || '';
  if (lang !== 'plutus:v3') { fail(`${label} ref script language is "${lang}", want "plutus:v3"`); continue; }
  if (!cbor) { fail(`${label} ref script UTxO ${ref.txHash}#${ref.index} has no script CBOR`); continue; }
  let computedHash = '';
  try {
    computedHash = validatorToScriptHash({ type: 'PlutusV3', script: cbor });
  } catch (e) {
    fail(`${label} script hash computation failed: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  if (computedHash !== expectedHash) {
    fail(`${label} computed hash ${computedHash} does not match the constant ${expectedHash}`);
    continue;
  }
  console.log(`  ${label}: ${ref.txHash}#${ref.index} - ${cbor.length / 2} bytes - hash ${computedHash} (matches constant)`);
  refScripts.push({ name: label, txHash: ref.txHash, index: ref.index, scriptCborHex: cbor, hash: computedHash });
}

console.log('\nFetching infrastructure UTxOs...');
const infraUtxoResults = await ogmios('queryLedgerState/utxo', {
  outputReferences: INFRA.map((i) => ({ transaction: { id: i.txHash }, index: i.index })),
});
const infra = [];
for (const i of INFRA) {
  const u = infraUtxoResults.find((x) => x.transaction.id === i.txHash && x.index === i.index);
  if (!u) { fail(`infra UTxO ${i.name} not found: ${i.txHash}#${i.index}`); continue; }
  const lovelace = u.value?.ada?.lovelace;
  console.log(`  ${i.name}: ${i.txHash}#${i.index} - ALIVE - ${lovelace ?? '?'} lovelace`);
  infra.push({
    name: i.name,
    txHash: i.txHash,
    index: i.index,
    address: u.address,
    valueLovelace: lovelace !== undefined ? String(lovelace) : '0',
    datumCbor: extractDatum(u),
  });
}

console.log('\nFetching sample proposal UTxO (first prop_-token holder)...');
const proposalSpendAddress = credentialToAddress('Mainnet', { type: 'Script', hash: GOV_PROPOSAL_SPEND_HASH });
const proposalUtxoResults = await ogmios('queryLedgerState/utxo', { addresses: [proposalSpendAddress] });
const propPrefix = Buffer.from('prop_', 'utf-8').toString('hex');
let sample = null;
let sampleTokenName = '';
for (const u of proposalUtxoResults) {
  const assets = u.value?.[GOV_PROPOSAL_MINT_HASH];
  if (!assets) continue;
  const name = Object.keys(assets).find((n) => n.startsWith(propPrefix));
  if (name) { sample = u; sampleTokenName = name; break; }
}

let sampleProposal = null;
let goldenTokenPin = null;

if (!sample) {
  fail(`no prop_-token UTxO found at ${proposalSpendAddress} among ${proposalUtxoResults.length} UTxOs - need at least one submitted proposal to capture a sample and the golden token-name pin`);
} else {
  console.log(`  sample: ${sample.transaction.id}#${sample.index} token=${sampleTokenName.slice(0, 24)}...`);
  const datumCbor = extractDatum(sample);
  if (!datumCbor) {
    fail(`sample proposal UTxO ${sample.transaction.id}#${sample.index} has no inline datum`);
  } else {
    sampleProposal = {
      txHash: sample.transaction.id,
      index: sample.index,
      datumCbor,
      tokenUnit: GOV_PROPOSAL_MINT_HASH + sampleTokenName,
    };

    console.log('\nDeriving the golden token-name pin from the producing transaction (Koios)...');
    const kr = await fetch(`${KOIOS}/tx_utxos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ _tx_hashes: [sample.transaction.id] }),
    });
    if (!kr.ok) {
      fail(`Koios tx_utxos query failed (${kr.status}): ${await kr.text()}`);
    } else {
      const kj = await kr.json();
      const inputs = kj?.[0]?.inputs || [];
      console.log(`  producing tx ${sample.transaction.id.slice(0, 12)}... has ${inputs.length} input(s)`);
      for (const inp of inputs) {
        const inHash = inp.tx_hash;
        const inIdx = Number(inp.tx_index ?? inp.index ?? 0);
        const recomputed = deriveProposalTokenName(inHash, inIdx);
        if (recomputed === sampleTokenName) {
          goldenTokenPin = { lockTxHash: inHash, lockOutputIndex: inIdx, expectedTokenName: sampleTokenName };
          console.log(`  MATCH: input ${inHash}#${inIdx} reproduces the on-chain token name via deriveProposalTokenName`);
          break;
        }
      }
      if (!goldenTokenPin) {
        fail(`no input of spend tx ${sample.transaction.id} reproduces the on-chain token name ${sampleTokenName} via deriveProposalTokenName - audit-#10 regression, STOP`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('\nCAPTURE VALIDATION FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

const fixture = {
  asOf: new Date().toISOString(),
  refScripts,
  infra,
  sampleProposal,
  goldenTokenPin,
};

const outPath = resolve(import.meta.dirname, '../test/fixtures/gov-state.fixture.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
console.log(`\nwrote ${outPath}`);
console.log(`  refScripts: ${refScripts.length}/2, infra: ${infra.length}/3`);
console.log(`  sampleProposal: ${sampleProposal.txHash}#${sampleProposal.index}`);
console.log(`  goldenTokenPin.lockTxHash:        ${goldenTokenPin.lockTxHash}`);
console.log(`  goldenTokenPin.lockOutputIndex:   ${goldenTokenPin.lockOutputIndex}`);
console.log(`  goldenTokenPin.expectedTokenName: ${goldenTokenPin.expectedTokenName}`);
