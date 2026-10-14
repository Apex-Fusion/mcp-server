// Fresh raw Ed25519 key for a member's local signer. Prints to stdout; writes nothing.
//
// SECURITY: the key leaves this module only through generateKey()'s return value
// and printKeygen()'s one stdout line. printKeygen() prints it exactly once, in the
// NAME=value form config.ts reads; it is never written to stderr, a file or the
// audit log. There is no mnemonic behind it either (generate_ed25519 draws 32
// random bytes), so that one line is the only copy: lose it and the funds at its
// address are gone.
//
// A raw key controls exactly one address, which keeps a leak bounded (see
// keysource.ts). The address is an enterprise address (no stake part) on network
// 1 = mainnet: Vector is mainnet-only and PrivateKeyKeySource rejects addr_test1.
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';

const MAINNET = 1;

export function generateKey(): { privateKeyBech32: string; address: string; pubKeyHash: string } {
  const sk = CML.PrivateKey.generate_ed25519();
  const pkh = sk.to_public().hash();
  const address = CML.EnterpriseAddress.new(MAINNET, CML.Credential.new_pub_key(pkh)).to_address().to_bech32();
  return { privateKeyBech32: sk.to_bech32(), address, pubKeyHash: pkh.to_hex() };
}

export function printKeygen(): void {
  const k = generateKey();
  process.stdout.write([
    "# Paste these two lines into the signer's env in your MCP client config. Keep the key private.",
    `VECTOR_SIGNER_PRIVATE_KEY=${k.privateKeyBech32}`,
    `VECTOR_SIGNER_ADDRESS=${k.address}`,
    '',
    `# Send this address (only this) to whoever funds your key: ${k.address}`,
    '',
  ].join('\n'));
}
