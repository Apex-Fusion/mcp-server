// packages/builder/src/vector/wallet-build-text.ts
// The answer of the wallet build tools of vector.ts (vector_build_send_apex, vector_build_send_tokens, vector_build_transaction,
// vector_build_deploy_contract and vector_build_interact_contract): the facts of the build, every key that must sign, the unsigned
// CBOR, the signing flow, and a JSON block whose required_signers have the shape of the identity and marketplace tools
// ([{ key_hash, roles }]). An unsigned transaction that is submitted is refused, so the answer names each key before the CBOR.
import { CML } from '@lucid-evolution/lucid';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { paymentKeyHashOf } from './gov-build.js';
import { SignerList } from './identity-chain.js';
import type { RequiredSigner } from './identity-chain.js';
import { withJson } from './marketplace-indexer.js';
import { signersLine, signersJson } from './marketplace-shared.js';

/**
 * The keys that must sign a transaction that a wallet build tool built from `changeAddress`: the wallet key (the wallet funds the
 * inputs and the fee, and the collateral of a script spend), and each key hash that the transaction body names as a required signer.
 */
export function walletSigners(txCbor: string, changeAddress: string): RequiredSigner[] {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const collateral = (body.collateral_inputs()?.len() ?? 0) > 0;
  const signers = new SignerList().add(paymentKeyHashOf(changeAddress), collateral ? 'wallet (inputs, fee and collateral)' : 'wallet (inputs and fee)');
  const named = body.required_signers();
  for (let i = 0; named !== undefined && i < named.len(); i++) signers.add(named.get(i).to_hex(), 'named in the transaction as a required signer');
  return signers.list();
}

/**
 * The answer of a wallet build tool: `head` (the title and the facts, one per line), the required signers, the unsigned CBOR, `flow`
 * (what to do next), and a JSON block with `json`, the transaction hash, the fee and the required signers.
 */
export function walletBuildText(head: string, build: VectorUnsignedBuildResult, changeAddress: string, flow: string, json: Record<string, unknown> = {}): string {
  const signers = walletSigners(build.txCbor, changeAddress);
  const md = `${head}\n${signersLine(signers)}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${build.txCbor}\n\`\`\`\n\n${flow}`;
  return withJson(md, { ...json, tx_hash: build.txHash, fee: build.fee, required_signers: signersJson(signers) });
}
