// packages/builder/test/fixtures/reputation-world.ts
// An offline world for the reputation stake builders: the identity-era Module-3 deployment as the chain holds it (the reference script, the
// parameters record and the cross references of reputation-golden.fixture.ts, captured from mainnet), the identity registry of mainnet
// (its deployment is derived from the values that the hosted server's environment holds, and its policy is the one that the reputation
// validator reads), records at the identity address, and a wallet. Lucid runs the DEPLOYED reputation script on each build (local
// evaluation), so a build that completes is one that the validator accepts, minus the signatures (the script reads only the required
// signers). `World` keeps the ledger across steps: `apply` leaves the ledger that a built transaction leaves.
import { CML, coreToUtxo, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider } from './fixture-provider.ts';
import { DAY, NOW, rootRecord, testKey } from './identity-world.ts';
import { makeIdentityDeployment } from '../../src/vector/identity-deployment.ts';
import type { IdentityDeployment } from '../../src/vector/identity-deployment.ts';
import { encodeIdentityDatum, utf8Hex } from '../../src/vector/identity-codec.ts';
import type { IdentityDatum } from '../../src/vector/identity-codec.ts';
import { AGENT_RECORDS, CROSS_REFS_UTXO, PARAMS_UTXO, REPUTATION_REF_UTXO } from './reputation-golden.fixture.ts';

export { NOW, DAY };
export const HOUR = 3_600_000;

/** The identity registry of mainnet: the hosted server's VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give the policy that the reputation validator reads. */
export const REAL_IDENTITY: IdentityDeployment = makeIdentityDeployment({
  legacyRoot: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  configSeed: { txHash: '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a', outputIndex: 0 },
});

// ─── Keys and wallet ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The wallet key: the controller and the owner of the first agent. */
export const WALLET = testKey(41);
export const WALLET_ADDRESS = credentialToAddress('Mainnet', { type: 'Key', hash: WALLET.keyHash });
/** The controller of the second agent, a key that is not the wallet's. */
export const CONTROLLER = testKey(42);
/** A key that the second agent lists with the transaction purpose: its stake owner. */
export const LISTED = testKey(43);
/** A key that the records do not list at all. */
export const STRANGER = testKey(44);
/** A key that the second agent lists for authentication only (no transaction purpose). */
export const AUTH_ONLY = testKey(45);
/** A key that the second agent lists with the transaction purpose after its record replaces `LISTED`. */
export const REPLACEMENT = testKey(46);

/** Six tokens with 32-byte names: an output with them needs 1.8964 AP3X, so its lovelace is held back for the tokens. */
const TOKENS = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`${'11'.repeat(28)}${n.toString(16).repeat(64)}`, 7n]));

/** The wallet: pure outputs (one of 5 AP3X, the collateral), one with six tokens at about its minimum, and a large one. */
export const WALLET_UTXOS: UTxO[] = [
  { txHash: 'f1'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 2_000_000_000n } },
  { txHash: 'f2'.repeat(32), outputIndex: 1, address: WALLET_ADDRESS, assets: { lovelace: 5_000_000n } },
  { txHash: 'f0'.repeat(32), outputIndex: 2, address: WALLET_ADDRESS, assets: { lovelace: 300_000_000n } },
  { txHash: 'f3'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 2_000_000n, ...TOKENS } },
];

// ─── Agents and records ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first agent: its controller is the wallet key. */
export const AGENT_ID = 'a3'.repeat(32);
/** The second agent: its controller is another key, and it lists a key with the transaction purpose. */
export const AGENT2_ID = 'a4'.repeat(32);
/** A subagent of the first agent. */
export const SUBAGENT_ID = 'a5'.repeat(32);
export const CAPABILITIES = ['demo.text.stats.v1', 'demo.text.summary.v1', 'demo.text.extract.v1'];

/** An Active root record created 30 days before NOW that lists CAPABILITIES; `controller` is the wallet key unless given. */
export function agentRecord(overrides: Partial<IdentityDatum> = {}, controller = WALLET.publicKey): IdentityDatum {
  return rootRecord({ controller, keys: [], capabilities: CAPABILITIES.map(utf8Hex), ...overrides });
}

/** The record of the second agent: another controller, a listed transaction key, and a key that has the authentication purpose only. */
export const agent2Record = (overrides: Partial<IdentityDatum> = {}): IdentityDatum => agentRecord({
  keys: [
    { keyType: 'Ed25519', key: LISTED.publicKey, purposes: 1 + 2 + 8, pop: null },
    { keyType: 'Ed25519', key: AUTH_ONLY.publicKey, purposes: 1, pop: null },
  ],
  ...overrides,
}, CONTROLLER.publicKey);

let recordCounter = 0;
/** The record output of `id` at the identity address of mainnet, holding its identity token. */
export function recordOutput(id: string, record: IdentityDatum): UTxO {
  recordCounter += 1;
  return {
    txHash: (0x7e000000 + recordCounter).toString(16).repeat(8), outputIndex: 0, address: REAL_IDENTITY.identity.address,
    assets: { lovelace: 10_000_000n, [`${REAL_IDENTITY.identity.hash}${id}`]: 1n }, datum: encodeIdentityDatum(record),
  };
}

/** Both agents' records, and the record of a subagent of the first. */
export const defaultRecords = (): UTxO[] => [recordOutput(AGENT_ID, agentRecord()), recordOutput(AGENT2_ID, agent2Record())];

export { AGENT_RECORDS, CROSS_REFS_UTXO, PARAMS_UTXO, REPUTATION_REF_UTXO };

// ─── The ledger ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The outputs that a built transaction creates, as UTxOs (the hash is the hash of its body). */
export function outputsOf(txCbor: string): UTxO[] {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const hash = CML.hash_transaction(body).to_hex();
  const outputs = body.outputs();
  return Array.from({ length: outputs.len() }, (_, i) => coreToUtxo(CML.TransactionUnspentOutput.new(CML.TransactionInput.new(CML.TransactionHash.from_hex(hash), BigInt(i)), outputs.get(i))));
}

/** The references of the inputs that a built transaction spends. */
export function spentBy(txCbor: string): Set<string> {
  const inputs = CML.Transaction.from_cbor_hex(txCbor).body().inputs();
  return new Set(Array.from({ length: inputs.len() }, (_, i) => `${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`));
}

/**
 * The ledger of the tests: the wallet, the module outputs of the deployment, the records and `extra`. `provider()` is a node over the
 * ledger now; `apply(txCbor)` leaves the ledger that the transaction leaves (its inputs spent, its outputs created), so the next step
 * is built on what the step before made.
 */
export class World {
  utxos: UTxO[];

  constructor(extra: UTxO[] = [], opts: { records?: UTxO[]; wallet?: UTxO[] } = {}) {
    this.utxos = [...(opts.wallet ?? WALLET_UTXOS), REPUTATION_REF_UTXO, PARAMS_UTXO, CROSS_REFS_UTXO, ...(opts.records ?? defaultRecords()), ...extra];
  }

  provider(): FixtureProvider { return new FixtureProvider([...this.utxos]); }

  apply(txCbor: string): this {
    const spent = spentBy(txCbor);
    this.utxos = [...this.utxos.filter((u) => !spent.has(`${u.txHash}#${u.outputIndex}`)), ...outputsOf(txCbor)];
    return this;
  }

  /** Replaces the output `ref` (the record of an agent, for example) with `utxo`. */
  replace(ref: string, utxo: UTxO): this {
    this.utxos = [...this.utxos.filter((u) => `${u.txHash}#${u.outputIndex}` !== ref), utxo];
    return this;
  }

  /** The output at `ref`. */
  at(ref: string): UTxO {
    const found = this.utxos.find((u) => `${u.txHash}#${u.outputIndex}` === ref);
    if (!found) throw new Error(`the world has no output ${ref}`);
    return found;
  }
}
