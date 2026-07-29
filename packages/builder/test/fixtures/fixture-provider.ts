// packages/builder/test/fixtures/fixture-provider.ts
//
// Offline stand-in for OgmiosProvider in unit tests. Serves the checked-in
// protocol-params fixture (captured from the live testnet by
// capture-protocol-params.mjs) and a caller-supplied UTxO set. Every method
// that would need the chain throws loudly so a test that would touch the
// network fails fast instead of hanging or silently passing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Provider, ProtocolParameters, UTxO, OutRef, Address, Credential,
  Delegation, DatumHash, Datum, RewardAddress, Transaction, TxHash, Unit,
} from '@lucid-evolution/lucid';

export const OWN_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
export const FOREIGN_ADDRESS = 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8';
export const FIXTURE_TXHASH = 'e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c32';
export const FIXTURE_TOKEN_UNIT = '1111111111111111111111111111111111111111111111111111111154657374546f6b656e';

export const FIXTURE_UTXOS: UTxO[] = [
  { txHash: FIXTURE_TXHASH, outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 1_000_000_000n } },
  { txHash: FIXTURE_TXHASH, outputIndex: 1, address: OWN_ADDRESS, assets: { lovelace: 5_000_000n } },
  { txHash: FIXTURE_TXHASH, outputIndex: 2, address: OWN_ADDRESS, assets: { lovelace: 10_000_000n, [FIXTURE_TOKEN_UNIT]: 500n } },
];

const PARAMS_PATH = resolve(import.meta.dirname!, 'protocol-params.fixture.json');

export function fixtureProtocolParameters(): ProtocolParameters {
  return JSON.parse(readFileSync(PARAMS_PATH, 'utf-8'), (_k, v) =>
    v !== null && typeof v === 'object' && '__bigint' in v ? BigInt(v.__bigint) : v,
  ) as ProtocolParameters;
}

export class FixtureProvider implements Provider {
  private utxos: UTxO[];

  // Not a parameter-property constructor (`constructor(private utxos...)`):
  // Node's native type-stripping (no ts-node/tsx loader in the plain `node
  // --test` invocation this file is designed to run under) only erases
  // types, it does not transform TS-only constructs like parameter
  // properties, and rejects them with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  // Same behavior as the parameter-property form, just spelled so `node`
  // can strip-and-run it directly. Matches OgmiosProvider's own style in
  // provider.ts, which never uses parameter properties either.
  constructor(utxos: UTxO[]) {
    this.utxos = utxos;
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    return fixtureProtocolParameters();
  }

  async getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> {
    if (typeof addressOrCredential !== 'string') {
      throw new Error('FixtureProvider: credential queries not supported offline');
    }
    return this.utxos.filter((u) => u.address === addressOrCredential);
  }

  async getUtxosByOutRef(outRefs: Array<OutRef>): Promise<UTxO[]> {
    return this.utxos.filter((u) =>
      outRefs.some((r) => r.txHash === u.txHash && Number(r.outputIndex) === u.outputIndex),
    );
  }

  async getUtxosWithUnit(_a: Address | Credential, _u: Unit): Promise<UTxO[]> {
    throw new Error('FixtureProvider: offline — getUtxosWithUnit unavailable');
  }
  async getUtxoByUnit(_u: Unit): Promise<UTxO> {
    throw new Error('FixtureProvider: offline — getUtxoByUnit unavailable');
  }
  async getDelegation(_r: RewardAddress): Promise<Delegation> {
    throw new Error('FixtureProvider: offline — getDelegation unavailable');
  }
  async getDatum(_d: DatumHash): Promise<Datum> {
    throw new Error('FixtureProvider: offline — getDatum unavailable');
  }
  awaitTx(_tx: TxHash, _interval?: number): Promise<boolean> {
    throw new Error('FixtureProvider: offline — awaitTx unavailable');
  }
  async submitTx(_tx: Transaction): Promise<TxHash> {
    throw new Error('FixtureProvider: offline — submitTx unavailable');
  }
  async evaluateTx(_tx: Transaction, _additional?: UTxO[]): Promise<any> {
    throw new Error('FixtureProvider: offline — evaluateTx unavailable');
  }
}
