// packages/builder/test/fixtures/capture-ogmios-evaluation-errors.mjs
//
// One-time capture: the real error bodies of Vector mainnet Ogmios for the evaluation of three vault payments that cannot be valid, and
// writes ogmios-evaluation-errors-mainnet.json. The three drafts come from buildVaultPay with `ledgerDecides` against the live vault
// and the live adverts; the script asks Ogmios (evaluateTransaction) for each draft and keeps the HTTP status and the body as Ogmios
// sent them. Read-only: Ogmios evaluates a draft and submits nothing; Koios is read. Nothing is signed. The cases:
//   above_per_tx    the live advert with the largest lock that a payment may hire (active, and of no fleet capability): its lock is
//                   above per_tx of the delegation of the vault. A validator fails.
//   past_total      a payment inside the running period of the vault, for the advert with the smallest lock of those: the period total
//                   is passed. A validator fails.
//   past_horizon    a validity range beyond the end of the era that the node can foresee. No validator runs: the node cannot make the
//                   evaluation context (error 3004 inside 3010).
// Run it from the root of the repository, with the TypeScript loader, when the golden set changes:
//
//   node --import tsx packages/builder/test/fixtures/capture-ogmios-evaluation-errors.mjs [output path]
//
// VECTOR_MAINNET_OGMIOS_URL and VECTOR_MAINNET_KOIOS_URL override the two bases. The wallet is only a funded address of the chain (the
// drafts are never signed). Never runs in CI: the unit tests read the checked-in file. The cases depend on the live vault (its limit and
// its period): a capture made later fails with a message when the live data no longer shows a case.
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { lucidForAddress } from '../../src/vector/build.ts';
import { identityDeploymentFrom } from '../../src/vector/identity-deployment.ts';
import { decodeIdentityAdvertDatum } from '../../src/vector/marketplace-datum.ts';
import { isFleetCapability } from '../../src/vector/marketplace-transport.ts';
import { decodeVaultDatum } from '../../src/vector/identity-codec.ts';
import { VaultPayEvaluationError, buildVaultPay } from '../../src/vector/vault-build.ts';

const OGMIOS = (process.env.VECTOR_MAINNET_OGMIOS_URL || 'https://ogmios.vector.mainnet.apexfusion.org').replace(/\/+$/, '');
const KOIOS = (process.env.VECTOR_MAINNET_KOIOS_URL || 'https://v2.koios.vector.mainnet.apexfusion.org').replace(/\/+$/, '');
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), 'ogmios-evaluation-errors-mainnet.json');

// The identity deployment of mainnet (agents-marketplace contracts/identity-marketplace/deploy/mainnet/deployment.json).
const DEPLOYMENT = identityDeploymentFrom({
  VECTOR_IDENTITY_LEGACY_ROOT: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  VECTOR_IDENTITY_CONFIG_SEED: '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a#0',
  VECTOR_IDENTITY_POLICY_ID: 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762',
  VECTOR_IDENTITY_REF_UTXO: '3d4471222e524584180a4358e05517a243effc46d15ef62443a82aaed822de46#0',
  VECTOR_IDENTITY_ATTESTATION_REF_UTXO: '55dfa9e05ff96844fd4313f1c7cb7f0c7f900f1cdf50099b0e2abb242da4128d#0',
  VECTOR_IDENTITY_DELEGATION_REF_UTXO: 'f6d47a62146b2bc4dabc12454c8a3dbbedf673d45a6edccd1c462d55c8ba8be7#0',
  VECTOR_IDENTITY_VAULT_REF_UTXO: 'd0bf8f73c915fcbf57ddba714256e520a9a0820bc9e643218db8cf54762d215b#0',
  VECTOR_IDENTITY_ESCROW_REF_UTXO: '4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0',
  VECTOR_IDENTITY_ADVERT_REF_UTXO: '5efd18a1d90a6b87f1fd4b6fe93acfbe5be082260fd52be194b1088ade7c2758#0',
});
const WALLET = 'addr1vycjlux4jerlds2xa58qd9zy78jy96keugjr5tr9w0cd5us3dr78y';
const provider = new OgmiosProvider({ ogmiosUrl: OGMIOS, submitUrl: `${OGMIOS}/unused`, koiosUrl: KOIOS });
const silent = console.error;
console.error = () => {}; // OgmiosProvider logs each error of the node: the captured bodies are the output of this script
const lucid = await lucidForAddress(provider, WALLET);

// The live Live vault with the most AP3X, and the adverts at the identity advert address that a payment may hire (active, and of no fleet
// capability: buildVaultPay refuses a fleet advert), with their lock (price + both bonds).
const vaults = (await provider.getUtxos(DEPLOYMENT.vault.address)).filter((u) => { try { return decodeVaultDatum(u.datum).type === 'Live'; } catch { return false; } });
const vault = vaults.sort((a, b) => (a.assets.lovelace < b.assets.lovelace ? 1 : -1))[0];
if (!vault) throw new Error('No Live vault output on the node.');
const vaultDatum = decodeVaultDatum(vault.datum);
const adverts = (await provider.getUtxos(DEPLOYMENT.advert.address)).flatMap((u) => {
  try {
    const d = decodeIdentityAdvertDatum(u.datum);
    return d.status !== 'Active' || isFleetCapability(d.capability_id) ? [] : [{ ref: `${u.txHash}#${u.outputIndex}`, lock: d.price_lovelace + d.supplier_bond_lovelace + d.buyer_bond_lovelace }];
  } catch { return []; }
}).sort((a, b) => (a.lock < b.lock ? 1 : -1));
const smallest = adverts[adverts.length - 1];
const largest = adverts[0];
const vaultRef = `${vault.txHash}#${vault.outputIndex}`;
const DAY = 86_400_000;

/** Builds the payment with ledgerDecides, expects the node to answer the evaluation with an error, and asks Ogmios again for the body. */
async function capture(name, description, advertRef, nowMs, expectSpentOverTotal) {
  let failure;
  try {
    await buildVaultPay({ lucid, provider, deployment: DEPLOYMENT }, { changeAddress: WALLET, vaultRef, advertRef, payload: 'ogmios evaluation errors', nowMs, ledgerDecides: true });
  } catch (err) { failure = err; }
  if (!(failure instanceof VaultPayEvaluationError)) throw new Error(`${name}: the node did not answer the evaluation with an error (${failure ? failure.message : 'the payment was built'}).`);
  if (expectSpentOverTotal === 'perTx' && !(failure.attempt.amountLovelace > failure.attempt.limit.perTx)) throw new Error(`${name}: the lock is not above per_tx (${failure.attempt.amountLovelace} and ${failure.attempt.limit.perTx}).`);
  if (expectSpentOverTotal === 'total' && !(failure.attempt.spent > failure.attempt.limit.total && !failure.attempt.newPeriod)) throw new Error(`${name}: the period total is not passed (${failure.attempt.spent} and ${failure.attempt.limit.total}).`);
  const res = await fetch(OGMIOS, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'vector-mcp-builder-fixture-capture' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'evaluateTransaction', params: { transaction: { cbor: failure.draftTx } }, id: null }),
  });
  return { description, httpStatus: res.status, body: await res.json() };
}

const cases = {
  above_per_tx: await capture('above_per_tx', `The payment from the live vault ${vaultRef} for the advert with the largest lock, ${largest.ref} (${largest.lock} lovelace): above per_tx of the delegation of the vault.`, largest.ref, Date.now(), 'perTx'),
  past_total: await capture('past_total', `A payment from the live vault ${vaultRef} inside its running period (period_start ${vaultDatum.periodStart}): the period total is passed.`, smallest.ref, vaultDatum.periodStart + 600_000, 'total'),
  past_horizon: await capture('past_horizon', `A payment from the live vault ${vaultRef} with a validity range 14 days from now: beyond the end of the era that the node can foresee.`, smallest.ref, Date.now() + 14 * DAY, null),
};
console.error = silent;
const fixture = {
  _source: `Vector mainnet Ogmios evaluateTransaction (HTTP status and body as the node sent them) for drafts of buildVaultPay with ledgerDecides; made by capture-ogmios-evaluation-errors.mjs. The vault is ${vaultRef}.`,
  cases,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${OUT}`);
for (const [name, c] of Object.entries(cases)) console.log(name, c.httpStatus, c.body.error?.code, JSON.stringify(c.body.error?.data?.map?.((d) => [d.validator, d.error?.code])));
