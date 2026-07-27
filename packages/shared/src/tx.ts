// Pure transaction helpers. No network access — this module is safe to import
// from the signer, which must have no network capability.
import { blake2b } from '@noble/hashes/blake2b';

export function lovelaceToAda(lovelace: string | number | bigint): string {
  if (lovelace === undefined || lovelace === null) return '0.000000';
  try {
    return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
  } catch {
    return '0.000000';
  }
}

export function formatAssetName(name: string): string {
  try {
    if (/^[0-9a-fA-F]+$/.test(name) && name.length > 0) {
      return Buffer.from(name, 'hex').toString('utf8');
    }
    return name;
  } catch {
    return name;
  }
}

// Cardano metadata strings must be <= 64 bytes. Chunk long strings into arrays.
export function metadataStr(s: string): string | string[] {
  if (s.length <= 64) return s;
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += 64) {
    chunks.push(s.slice(i, i + 64));
  }
  return chunks;
}

export function cborUint(n: bigint): Buffer {
  if (n < 0n) throw new Error('output_index must be non-negative');
  if (n < 24n) return Buffer.from([Number(n)]);
  if (n < 0x100n) return Buffer.from([0x18, Number(n)]);
  if (n < 0x10000n) return Buffer.from([0x19, Number(n >> 8n) & 0xff, Number(n) & 0xff]);
  if (n < 0x100000000n) {
    const b = Buffer.alloc(5); b[0] = 0x1a; b.writeUInt32BE(Number(n), 1); return b;
  }
  const b = Buffer.alloc(9); b[0] = 0x1b; b.writeBigUInt64BE(n, 1); return b;
}

export function cborBytes(hex: string): Buffer {
  const raw = Buffer.from(hex, 'hex');
  const len = raw.length;
  let header: Buffer;
  if (len < 24) header = Buffer.from([0x40 | len]);
  else if (len < 0x100) header = Buffer.from([0x58, len]);
  else if (len < 0x10000) { header = Buffer.alloc(3); header[0] = 0x59; header.writeUInt16BE(len, 1); }
  else { header = Buffer.alloc(5); header[0] = 0x5a; header.writeUInt32BE(len, 1); }
  return Buffer.concat([header, raw]);
}

// NFT asset name = blake2b_256(CBOR(OutputReference)).
// agent-registry v2 (Conway) requires INDEFINITE-length CBOR for the constructor
// field array (D8 79 9F … FF), matching Aiken's cbor.serialise. Lucid's Data.to
// emits definite-length arrays (D8 79 82 …) which v2 rejects, so the outer
// constructor is hand-rolled here.
export function deriveNftAssetName(txHash: string, outputIndex: number): string {
  const outRefCbor = Buffer.concat([
    Buffer.from([0xd8, 0x79, 0x9f]),
    cborBytes(txHash),
    cborUint(BigInt(outputIndex)),
    Buffer.from([0xff]),
  ]);
  const hashBytes = blake2b(outRefCbor, { dkLen: 32 });
  return Buffer.from(hashBytes).toString('hex');
}
