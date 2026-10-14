// packages/builder/test/fixtures/marketplace.fixture.ts
// Live mainnet datums captured 2026-10-13 via Koios utxo_info. Do not edit by hand.

/** Advert 87c46c30…#0: ChandraOCR, Active. */
export const ADVERT_REF = '87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0';
export const ADVERT_DATUM_HEX =
  'd8798d581c401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c958216f63722e706167652e657874726163742e6368616e6472612d6f63722d322e76315819686973746f726963616c2d7265636f7264732d6f63722d76311b00000000000020001b00000000000493e01b0000000000030d401b00000000000f42401b00000000000f4240582468747470733a2f2f6d702d737570706c696572732d6368616e6472612e68616c382e6169405820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8551b0000019ff571fc53d87980';
export const ADVERT_EXPECTED = {
  supplier_pkh: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9',
  capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
  model: 'historical-records-ocr-v1',
  max_output_tokens: 8192,
  max_processing_ms: 300_000,
  price_lovelace: 200_000n,
  supplier_bond_lovelace: 1_000_000n,
  buyer_bond_lovelace: 1_000_000n,
  endpoint_url: 'https://mp-suppliers-chandra.hal8.ai',
  detail_uri: '',
  detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  advertised_at: 1786529315923,
  status: 'Active' as const,
};

/** Escrow 1f1566b4…#0 as posted (Open) on 2026-08-12. */
export const ESCROW_REF = '1f1566b4fb32fe5af98a686d97383db7cd02bd47eae7f2742187d67e335c8538#0';
export const ESCROW_OPEN_DATUM_HEX =
  'd8798e581c60e82034791d90a7e80130423f5c08061211339b86128a4fda158dc9581c401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9d87982582087c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d1b000000000000000058216f63722e706167652e657874726163742e6368616e6472612d6f63722d322e76315820f41357ac8b61f59e2f33cebc1d2022d38b00026b75517d2d9ccb23a15f6667e858202320c4c4e9d4aec286dfee66452fe3f649b34345a808ad8d7bfe31e09686e9c61b0000000000030d401b00000000000f42401b00000000000f42401b0000019ff58112c71b0000019ff57c09b7d87a80d87a80d87980';
export const ESCROW_EXPECTED = {
  buyer_pkh: '60e82034791d90a7e80130423f5c08061211339b86128a4fda158dc9',
  supplier_pkh: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9',
  advert_ref: { txHash: '87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d', index: 0 },
  capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
  request_spec_hash: 'f41357ac8b61f59e2f33cebc1d2022d38b00026b75517d2d9ccb23a15f6667e8',
  prompt_hash: '2320c4c4e9d4aec286dfee66452fe3f649b34345a808ad8d7bfe31e09686e9c6',
  payment_lovelace: 200_000n,
  buyer_bond_lovelace: 1_000_000n,
  supplier_bond_lovelace: 1_000_000n,
  deliver_by: 1786530304711,
  posted_at: 1786529974711,
  submitted_at: null,
  result_receipt_hash: null,
  state: 'Open' as const,
};
/** Lovelace actually locked by that Post (Koios value of the output). */
export const ESCROW_LOCKED_LOVELACE = 2_261_030n;
