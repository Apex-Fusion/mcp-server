// packages/builder/src/vector/marketplace-constants.ts
// Vector mainnet marketplace constants. Source: agents-marketplace contracts/marketplace/plutus.json
// and the service-agents design spec §6, plus the live reference-script UTxOs (verified via Koios
// 2026-10-13). Inlined on purpose: the Docker image ships only build/, so nothing here may read plutus.json.
export const ESCROW_SCRIPT_HASH = '810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912';
export const ESCROW_ADDRESS = 'addr1wxqsaczee4upnn50n9dwgw9mkph77yqp0d9p0y5ul9c6jysrv9dl5';
export const ADVERT_SCRIPT_HASH = '9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da';
export const ADVERT_ADDRESS = 'addr1wxvjn7jwak9kdvctscywvq0d9f9hksf6ysfa6yatya2efksvgxwpa';
export const ESCROW_REF_UTXO = { txHash: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54', outputIndex: 0 };
export const ADVERT_REF_UTXO = { txHash: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54', outputIndex: 1 };
export const ACCEPT_WINDOW_MS = 600_000;
/** Buyer-side buffer added to the advert's processing window when computing deliver_by. */
export const DELIVER_BY_BUFFER_MS = 180_000;
/**
 * The longest processing window (24 h) a Post will accept from an advert. A buyer cannot Reclaim before deliver_by, so the
 * window an advert declares is how long a buyer's funds can be held; the supplier chooses it, so it is capped here. A caller
 * deliver_by may be at most this plus DELIVER_BY_BUFFER_MS from now.
 */
export const MAX_PROCESSING_MS_CEILING = 86_400_000;
export const MARKETPLACE_MIN_FEE = 500_000n;
export const COLLATERAL_MIN_LOVELACE = 5_000_000n;
export const MIN_UTXO_LOVELACE = 1_000_000n;
export const INDEXER_URL = process.env.VECTOR_MARKETPLACE_INDEXER_URL || 'https://mp-indexer.vector.apexfusion.org';
/** Redeemer constructor indices of the escrow validator (escrow.ak). */
export const REDEEMER = { Claim: 0, Submit: 1, Accept: 2, Reclaim: 3, Release: 4 } as const;
