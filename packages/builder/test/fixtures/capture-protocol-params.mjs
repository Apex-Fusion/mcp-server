// packages/builder/test/fixtures/capture-protocol-params.mjs
//
// One-time capture: writes Lucid-format protocol parameters from the live
// Vector testnet Ogmios endpoint into protocol-params.fixture.json, using
// OgmiosProvider's own mapping so the fixture can never drift from the
// conversion logic. Run manually after `npm run build`:
//
//   node packages/builder/test/fixtures/capture-protocol-params.mjs
//
// Never runs in CI — unit tests read the checked-in JSON.
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';

const ogmiosUrl = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.testnet.apexfusion.org';
const provider = new OgmiosProvider({ ogmiosUrl, submitUrl: 'http://unused.invalid', koiosUrl: '' });
const params = await provider.getProtocolParameters();

// Refuse to write a fixture that could have come from OgmiosProvider's own
// `??` fallback defaults instead of a real response. Several numeric fields
// (minFeeA, minFeeB, coinsPerUtxoByte, keyDeposit, ...) fall back to
// hardcoded literals on a schema mismatch, so matching those literals proves
// nothing on its own — a broken RPC response is indistinguishable from a
// testnet that genuinely uses standard values. costModels has no such
// populated fallback (provider.ts's only fallback there is `{}`), so a
// well-formed, appropriately-sized cost model per Plutus version is the one
// signal that cannot be produced by falling through to a default.
function sizeOf(x) {
  if (Array.isArray(x)) return x.length;
  if (x && typeof x === 'object') return Object.keys(x).length;
  return 0;
}

const failures = [];
for (const version of ['PlutusV1', 'PlutusV2', 'PlutusV3']) {
  const size = sizeOf(params.costModels?.[version]);
  if (size < 100) {
    failures.push(`costModels.${version} has ${size} entries, want >= 100`);
  }
}
if (typeof params.coinsPerUtxoByte !== 'bigint') {
  failures.push(`coinsPerUtxoByte is ${typeof params.coinsPerUtxoByte}, want bigint`);
}
if (typeof params.keyDeposit !== 'bigint') {
  failures.push(`keyDeposit is ${typeof params.keyDeposit}, want bigint`);
}
if (failures.length > 0) {
  throw new Error('capture looks like fallback defaults, refusing to write: ' + failures.join('; '));
}

const json = JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v), 2);
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'protocol-params.fixture.json');
writeFileSync(out, json + '\n');
console.log(`wrote ${out}`);
