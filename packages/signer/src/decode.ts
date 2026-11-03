// Decode a transaction into plain data. Pure: no key, no filesystem, no network.
// The body names the inputs it spends only by output reference. The value and
// the owner of each input are not in the transaction, so the own-inputs spend
// rule needs them from resolve.ts; without them policy.ts uses the body alone.
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';

export interface DecodedOutput {
  address: string;
  lovelace: bigint;
  assets: Array<{ unit: string; quantity: bigint }>;
}

/** An output reference: the transaction that made the output (lowercase hex) and the output's index. */
export interface DecodedInput {
  txHash: string;
  index: number;
}

export interface DecodedWithdrawal {
  rewardAddress: string;
  /** The reward account's credential when it is a key hash (lowercase hex); null for a script credential. */
  keyHash: string | null;
  lovelace: bigint;
}

export interface DecodedTx {
  txHashHex: string;
  fee: bigint;
  outputs: DecodedOutput[];
  inputCount: number;
  mintedAssetCount: number;
  /** The inputs the transaction spends, in body order. */
  inputs: DecodedInput[];
  /** The collateral inputs. A node takes them when a script of the transaction fails. */
  collateralInputs: DecodedInput[];
  /** The output that gets the rest of the collateral when a script fails; null when the body has none. */
  collateralReturn: DecodedOutput | null;
  withdrawals: DecodedWithdrawal[];
  /**
   * Key hashes of the credentials whose deposit a certificate of this transaction returns (stake or DRep
   * deregistration). The refund adds value to the transaction, and for the legacy stake deregistration
   * certificate the body does not say how much.
   */
  depositRefundKeyHashes: string[];
  /** Key hashes of the vkey witnesses that the transaction already carries, in order. */
  witnessKeyHashes: string[];
  isValid: boolean;
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

function readOutput(o: CML.TransactionOutput, what: string): DecodedOutput {
  let address: string;
  try {
    address = o.address().to_bech32();
  } catch {
    throw new Error(`Transaction could not be decoded: ${what} has an unreadable address`);
  }
  return { address, lovelace: BigInt(o.amount().coin().toString()), assets: readAssets(o.amount()) };
}

function readInputs(list: CML.TransactionInputList | undefined): DecodedInput[] {
  const out: DecodedInput[] = [];
  if (!list) return out;
  for (let i = 0; i < list.len(); i++) {
    const input = list.get(i);
    out.push({ txHash: input.transaction_id().to_hex().toLowerCase(), index: Number(input.index()) });
  }
  return out;
}

// The certificates that return a deposit into the transaction's balance. Every other kind
// takes a deposit (registration) or moves no value.
function depositRefundKeyHashes(body: CML.TransactionBody): string[] {
  const certs = body.certs();
  const out: string[] = [];
  if (!certs) return out;
  for (let i = 0; i < certs.len(); i++) {
    const cert = certs.get(i);
    let credential: CML.Credential | undefined;
    switch (cert.kind()) {
      case CML.CertificateKind.StakeDeregistration:
        credential = cert.as_stake_deregistration()?.stake_credential();
        break;
      case CML.CertificateKind.UnregCert:
        credential = cert.as_unreg_cert()?.stake_credential();
        break;
      case CML.CertificateKind.UnregDrepCert:
        credential = cert.as_unreg_drep_cert()?.drep_credential();
        break;
      default:
        continue;
    }
    const keyHash = credential?.as_pub_key()?.to_hex().toLowerCase();
    if (keyHash) out.push(keyHash);
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
  // all. That was checked against the encodings this ecosystem actually uses -
  // including the indefinite-length CBOR the agent registry hand-rolls (see
  // shared/tx.ts), metadata, Plutus scripts and datums, and non-canonical
  // integers - and the encoding survived every round trip.
  if (tx.to_cbor_hex().toLowerCase() !== cborHex.toLowerCase()) {
    throw new Error(
      'Transaction could not be decoded: input was not fully consumed (unrecognised trailing data)'
    );
  }

  const body = tx.body();
  const outputs: DecodedOutput[] = [];
  const cmlOutputs = body.outputs();
  for (let i = 0; i < cmlOutputs.len(); i++) outputs.push(readOutput(cmlOutputs.get(i), `output ${i}`));

  const withdrawals: DecodedWithdrawal[] = [];
  const cmlWithdrawals = body.withdrawals();
  if (cmlWithdrawals) {
    const accounts = cmlWithdrawals.keys();
    for (let i = 0; i < accounts.len(); i++) {
      const account = accounts.get(i);
      withdrawals.push({
        rewardAddress: account.to_address().to_bech32(),
        keyHash: account.payment().as_pub_key()?.to_hex().toLowerCase() ?? null,
        lovelace: BigInt((cmlWithdrawals.get(account) ?? 0n).toString()),
      });
    }
  }

  const witnessKeyHashes: string[] = [];
  const vkeys = tx.witness_set().vkeywitnesses();
  if (vkeys) {
    for (let i = 0; i < vkeys.len(); i++) witnessKeyHashes.push(vkeys.get(i).vkey().hash().to_hex().toLowerCase());
  }

  const collateralReturn = body.collateral_return();

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
    inputs: readInputs(body.inputs()),
    collateralInputs: readInputs(body.collateral_inputs()),
    collateralReturn: collateralReturn ? readOutput(collateralReturn, 'the collateral return output') : null,
    withdrawals,
    depositRefundKeyHashes: depositRefundKeyHashes(body),
    witnessKeyHashes,
    isValid: tx.is_valid(),
  };
}
