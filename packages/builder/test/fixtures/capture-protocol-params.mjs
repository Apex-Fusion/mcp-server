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
const json = JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v), 2);
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'protocol-params.fixture.json');
writeFileSync(out, json + '\n');
console.log(`wrote ${out}`);
