// packages/builder/test/fixtures/template-receipt.fixture.ts
// ONE receipt as the template makes it, for pinning our receipt check to the template's own code (a cross-implementation vector).
// Made with Apex-Fusion/vector-agent-template at c4c378a (read-only; nothing was changed or committed there) by running, with a key
// generated for the purpose and thrown away:
//   receipt = buildReceipt({ prompt_hash, response_hash: sha256(result), model, prompt_tokens, completion_tokens, wallclock_ms,
//                            supplier_pkh, escrow_ref })                         packages/shared/src/receipt/build.ts
//   signed  = signReceipt(receipt, privateKeyHex)         Ed25519 over canonicalize(receipt)                  .../receipt/sign.ts
//   resultReceiptHash = receiptResultHash(signed)         sha256(canonicalize({ receipt, signature }))        .../receipt/sign.ts
//   canonicalReceipt / canonicalSigned = the template's canonicalize() of the receipt and of { receipt, signature }  (cbor/canonical.ts)
// publicKeyHex and supplierPkh (blake2b-224 of the public key) come from agent/src/cli/gen-keypair.ts deriveKeypair. The template's own
// verifyReceipt accepts the vector and refuses it with one signature nibble changed. Two things in it are chosen to catch a canonicaliser
// that differs: the receipt's fields are not in key order, and its model is spelled with a combining accent (NFD), which the template
// brings to NFC before it signs. The result text has a decomposed character too: its hash is taken as it is.

export const TEMPLATE_RECEIPT = {
  "publicKeyHex": "c07e6a3c48104c8b95cb9309e6d5f437e13cdf6158e8fcb94a7ac4a53a8ad3be",
  "supplierPkh": "5742c1af8a144db8b8102085de379cf9c88927bdb39efe80e518519e",
  "receipt": {
    "prompt_hash": "ced2ea09c099fa419ee67ddf75b8626cb345d0d556509b0c9cc09e4f4cb43b01",
    "response_hash": "f7a29c91f05d85bf4b5e23ff04aa6c635d5260eee32d3a78094985dbd532d4d0",
    "model": "cafe\u0301-8b",
    "prompt_tokens": 17,
    "completion_tokens": 42,
    "wallclock_ms": 1234,
    "supplier_pkh": "5742c1af8a144db8b8102085de379cf9c88927bdb39efe80e518519e",
    "escrow_ref": "9ce83e6d4f8cbcb02e7cf88d16a178d356eee1afe77d7a2c4cb2bf9793c3e179#0"
  },
  "signature": "a851482d19d4cfd0ba9555aa1ac9379c71ab541780997a2e5db6434017dd999aa1a28dcd9b651b02f4ded619c87aa2e9b0c94238bb3d6360dda5ea6f21ee790a",
  "resultReceiptHash": "16602cfaf8c084775ca2d37aae36a0a4f27e37cc66e57736d710302732117f77",
  "result": "Weather report for Zagreb\ntemperature: 14 C\nwind from the e\u0301ast, gusting\n",
  "canonicalReceipt": "{\"completion_tokens\":42,\"escrow_ref\":\"9ce83e6d4f8cbcb02e7cf88d16a178d356eee1afe77d7a2c4cb2bf9793c3e179#0\",\"model\":\"caf\u00e9-8b\",\"prompt_hash\":\"ced2ea09c099fa419ee67ddf75b8626cb345d0d556509b0c9cc09e4f4cb43b01\",\"prompt_tokens\":17,\"response_hash\":\"f7a29c91f05d85bf4b5e23ff04aa6c635d5260eee32d3a78094985dbd532d4d0\",\"supplier_pkh\":\"5742c1af8a144db8b8102085de379cf9c88927bdb39efe80e518519e\",\"wallclock_ms\":1234}",
  "canonicalSigned": "{\"receipt\":{\"completion_tokens\":42,\"escrow_ref\":\"9ce83e6d4f8cbcb02e7cf88d16a178d356eee1afe77d7a2c4cb2bf9793c3e179#0\",\"model\":\"caf\u00e9-8b\",\"prompt_hash\":\"ced2ea09c099fa419ee67ddf75b8626cb345d0d556509b0c9cc09e4f4cb43b01\",\"prompt_tokens\":17,\"response_hash\":\"f7a29c91f05d85bf4b5e23ff04aa6c635d5260eee32d3a78094985dbd532d4d0\",\"supplier_pkh\":\"5742c1af8a144db8b8102085de379cf9c88927bdb39efe80e518519e\",\"wallclock_ms\":1234},\"signature\":\"a851482d19d4cfd0ba9555aa1ac9379c71ab541780997a2e5db6434017dd999aa1a28dcd9b651b02f4ded619c87aa2e9b0c94238bb3d6360dda5ea6f21ee790a\"}"
} as const;
