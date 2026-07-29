// Opt-in. Requires a funded Vector testnet wallet at the path in
// VECTOR_SIGNER_MNEMONIC_FILE. Builds a real unsigned transaction keylessly,
// has the signer decode and sign it, and verifies the witness. Never submits.
//
// Excluded from CI (no test:integration:signer step there) because it needs a
// funded wallet. Run explicitly: see README "Testing" section.
//
// This file lives under test/, not src/ — boundary.test.ts only scans src/
// (see its own SRC_DIR constant), so the network-capable imports below
// (@lucid-evolution/lucid, the shared package's /provider subpath) do not
// trip the signer's no-network guarantee. Those imports exist ONLY to
// reproduce, from the test's own side, exactly what the hosted *builder*
// does when it constructs a transaction with no key — everything from
// MnemonicKeySource onward exercises the real signer code path.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Lucid } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { MnemonicKeySource } from '../../src/keysource.ts';
import { decodeTransaction } from '../../src/decode.ts';
import { evaluate } from '../../src/policy.ts';
import { signTransaction } from '../../src/sign.ts';

const FOREIGN = 'addr1wx434t2jc3m5uhdf7tq05xjdqu3q5z7a2lhrmn5mapsd43srh7ll8';

let unsignedCbor: string;
let identity: { address: string; privateKeyBech32: string };

before(async () => {
  const path = process.env.VECTOR_SIGNER_MNEMONIC_FILE;
  assert.ok(path, 'set VECTOR_SIGNER_MNEMONIC_FILE to a funded testnet wallet');
  identity = new MnemonicKeySource(readFileSync(path!, 'utf8')).load();

  const lucid = await Lucid(
    new OgmiosProvider({
      ogmiosUrl: 'https://ogmios.vector.testnet.apexfusion.org',
      submitUrl: 'https://submit.vector.testnet.apexfusion.org/api/submit/tx',
      koiosUrl: 'https://v2.koios.vector.testnet.apexfusion.org/',
    }),
    'Mainnet'
  );
  const utxos = await lucid.utxosAt(identity.address);
  assert.ok(utxos.length > 0, `wallet ${identity.address} has no UTxOs - fund it`);

  // Build with NO key, exactly as the hosted builder will.
  lucid.selectWallet.fromAddress(identity.address, utxos);
  unsignedCbor = (await lucid.newTx().pay.ToAddress(FOREIGN, { lovelace: 3_000_000n }).complete()).toCBOR();
});

describe('signer round trip against Vector testnet', () => {
  test('the keyless build produced a decodable transaction', () => {
    assert.ok(decodeTransaction(unsignedCbor).outputs.length >= 1);
  });

  test('net outflow is the payment plus the fee, with change excluded', () => {
    const tx = decodeTransaction(unsignedCbor);
    const { netOutflowLovelace } = evaluate(
      tx, [identity.address],
      { perTxLovelace: 100_000_000n, dailyLovelace: 500_000_000n }, 0n
    );
    assert.equal(netOutflowLovelace, 3_000_000n + tx.fee);
  });

  test('policy allows it and signing attaches a verifying witness', () => {
    const tx = decodeTransaction(unsignedCbor);
    const decision = evaluate(
      tx, [identity.address],
      { perTxLovelace: 100_000_000n, dailyLovelace: 500_000_000n }, 0n
    );
    assert.equal(decision.allowed, true, decision.reason);

    const { signedCborHex, txHashHex } = signTransaction(unsignedCbor, identity.privateKeyBech32);
    const w = CML.Transaction.from_cbor_hex(signedCborHex).witness_set().vkeywitnesses()!.get(0);
    assert.equal(w.vkey().verify(CML.TransactionHash.from_hex(txHashHex).to_raw_bytes(), w.ed25519_signature()), true);
    assert.equal(txHashHex, tx.txHashHex, 'signing must not alter the body');
  });
});
