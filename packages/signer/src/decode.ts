// Decode a transaction into plain data. Pure: no key, no filesystem, no network.
// Everything policy needs is in the transaction body, which is why the signer
// never has to resolve inputs against the chain.
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';

export interface DecodedOutput {
  address: string;
  lovelace: bigint;
  assets: Array<{ unit: string; quantity: bigint }>;
}

export interface DecodedTx {
  txHashHex: string;
  fee: bigint;
  outputs: DecodedOutput[];
  inputCount: number;
  mintedAssetCount: number;
}

function readAssets(value: CML.Value): Array<{ unit: string; quantity: bigint }> {
  const out: Array<{ unit: string; quantity: bigint }> = [];
  const multiasset = value.multi_asset();
  if (!multiasset) return out;
  const policies = multiasset.keys();
  for (let p = 0; p < policies.len(); p++) {
    const policy = policies.get(p);
    const assets = multiasset.get_assets(policy);
    if (!assets) continue;
    const names = assets.keys();
    for (let n = 0; n < names.len(); n++) {
      const name = names.get(n);
      const qty = assets.get(name);
      if (qty === undefined) continue;
      out.push({
        // name.to_hex() returns the asset name's raw bytes as hex, with no CBOR
        // envelope. name.to_cbor_hex() would need its CBOR byte-string header
        // stripped, and that header is 1 byte only for names up to 23 bytes long;
        // Cardano asset names run up to 32 bytes, where the header grows to 2
        // bytes, so a fixed slice(2) silently corrupts the unit for 24-32 byte
        // names. to_hex() sidesteps CBOR entirely and is correct at every length
        // (verified against CML for lengths 0, 1, 8, 22, 23, 24, 25, 27, 31, 32).
        unit: `${policy.to_hex()}${name.to_hex()}`,
        quantity: BigInt(qty.toString()),
      });
    }
  }
  return out;
}

export function decodeTransaction(cborHex: string): DecodedTx {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(cborHex);
  } catch (err) {
    // Fail closed: refuse rather than return something partially understood.
    throw new Error(
      `Transaction could not be decoded: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // from_cbor_hex only requires that a *prefix* of cborHex parse as a valid
  // transaction; it does not check that parsing consumed the whole string, so
  // trailing bytes would otherwise be silently discarded and produce a
  // confident, fully-populated result over less data than was actually
  // supplied. CML preserves the original encoding on parse-then-reserialize
  // (only objects built from scratch via `.new()` are canonicalised), so
  // re-serialising and comparing against the input detects any unconsumed
  // suffix. Compared case-insensitively: valid uppercase-hex input round-trips
  // through CML as lowercase, which would otherwise read as a mismatch.
  // The risk of comparing strictly is a false positive: if CML re-encoded any
  // legitimate transaction differently, the signer would refuse to sign it at
  // all. That was checked against the encodings this ecosystem actually uses —
  // including the indefinite-length CBOR the agent registry hand-rolls (see
  // shared/tx.ts), metadata, Plutus scripts and datums, and non-canonical
  // integers — and the encoding survived every round trip.
  if (tx.to_cbor_hex().toLowerCase() !== cborHex.toLowerCase()) {
    throw new Error(
      'Transaction could not be decoded: input was not fully consumed (unrecognised trailing data)'
    );
  }

  const body = tx.body();
  const outputs: DecodedOutput[] = [];
  const cmlOutputs = body.outputs();
  for (let i = 0; i < cmlOutputs.len(); i++) {
    const o = cmlOutputs.get(i);
    let address: string;
    try {
      address = o.address().to_bech32();
    } catch (err) {
      throw new Error(`Transaction could not be decoded: output ${i} has an unreadable address`);
    }
    outputs.push({
      address,
      lovelace: BigInt(o.amount().coin().toString()),
      assets: readAssets(o.amount()),
    });
  }

  const mint = body.mint();
  let mintedAssetCount = 0;
  if (mint) {
    const policies = mint.keys();
    for (let p = 0; p < policies.len(); p++) {
      const assets = mint.get_assets(policies.get(p));
      if (assets) mintedAssetCount += assets.keys().len();
    }
  }

  return {
    txHashHex: CML.hash_transaction(body).to_hex(),
    fee: BigInt(body.fee().toString()),
    outputs,
    inputCount: body.inputs().len(),
    mintedAssetCount,
  };
}
