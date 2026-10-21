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
/**
 * The shortest processing window a supplier template can serve (vector-agent-template c4c378a). It starts only when its
 * ADVERT_MAX_PROCESSING_MS is at least SERVICE_TIMEOUT_MS + 60 s, and SERVICE_TIMEOUT_MS is at least 1 ms (agent/src/server.ts, the
 * boot guard of the custom kind, the one kind that serves /v1/job; agent/src/config.ts). It refuses every job for an advert whose window
 * is smaller than its ADVERT_MAX_PROCESSING_MS (agent/src/routes/custom.ts). With the default SERVICE_TIMEOUT_MS of 120 s, the window
 * must be at least 180,000 ms.
 */
export const MIN_PROCESSING_MS_FLOOR = 60_001;
export const MARKETPLACE_MIN_FEE = 500_000n;
export const COLLATERAL_MIN_LOVELACE = 5_000_000n;
export const MIN_UTXO_LOVELACE = 1_000_000n;
/** The indexer base URL as an operator wrote it, without trailing slashes: every request appends `/<route>`. */
export const indexerUrlFrom = (configured: string | undefined): string => (configured || 'https://mp-indexer.vector.apexfusion.org').replace(/\/+$/, '');
export const INDEXER_URL = indexerUrlFrom(process.env.VECTOR_MARKETPLACE_INDEXER_URL);
/** Redeemer constructor indices of the escrow validator (escrow.ak). */
export const REDEEMER = { Claim: 0, Submit: 1, Accept: 2, Reclaim: 3, Release: 4 } as const;
/** Redeemer constructor indices of the advert validator (advert.ak, types.ak AdvertRedeemer). PostAdvert never reaches the validator: creating an output runs no script. */
export const ADVERT_REDEEMER = { PostAdvert: 0, UpdateAdvert: 1, RetireAdvert: 2 } as const;
/**
 * The least an advert output locks: the supplier template's floor (vector-agent-template c4c378a, liveCbor.ts MIN_UTXO_LOVELACE). The
 * template locks the supplier bond raised to it, and Lucid raises the output further to the ledger minimum for its datum when that is
 * higher (the live adverts lock 2,000,000 to 2,047,250). The deposit returns to the supplier on Retire.
 */
export const ADVERT_DEPOSIT_FLOOR_LOVELACE = 2_000_000n;
/** An advert Post or Retire is valid from 60 s before the build to 5 min after it, as the supplier template builds them. */
export const ADVERT_VALID_BEFORE_MS = 60_000;
export const ADVERT_VALID_AFTER_MS = 300_000;
/**
 * The longest bytestring a datum may hold as one piece: the ledger refuses a definite-length bytestring over 64 bytes in Plutus data,
 * and the marketplace's encoder writes each advert field as one. So each text field of an advert holds at most 64 bytes of UTF-8.
 */
export const DATUM_BYTES_MAX = 64;
/** sha256 of no bytes: the detail_hash the supplier template writes when an advert has no detail URI. */
export const EMPTY_DETAIL_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
