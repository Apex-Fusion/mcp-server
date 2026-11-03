// packages/builder/src/vector/gov-build.ts
// The chain clock and the payment key hash that the keyless builders share. The identity, attestation, delegation, vault and
// marketplace builders import them from here; this file held the first keyless builder family (self-improvement), which is now in
// gov-tx.ts with its deployment (gov-deployment.ts) and codecs (gov-codec.ts).
import { getAddressDetails, SLOT_CONFIG_NETWORK } from '@lucid-evolution/lucid';

// ─── Slot/time config ───────────────────────────────────────────────────────

// Minimal provider surface needed for slot/time queries. OgmiosProvider
// satisfies this at runtime; the base Lucid `Provider` interface does not
// declare either method (they are OgmiosProvider-specific additions).
export interface SlotClockProvider {
  getSystemStartMs(): Promise<number>;
  getNetworkTip?(): Promise<{ slot: number; hash?: string }>;
}

// Vector slot config - resolved from chain via Ogmios queryNetwork/startTime.
// Cached after first query so SLOT_CONFIG_NETWORK is set before Lucid needs
// it. Module-global cache, same as the custodial original: callers (tests
// included) must use a consistent zeroTime across calls in one process.
let vectorZeroTime: number | null = null;

/**
 * The node answered the chain-start query with something that cannot be a clock. Its message names the kind of answer and nothing
 * the node said (no endpoint, no body), so a caller may show it as it is.
 */
export class ChainClockError extends Error {}

// A node that answers with something that is not a finite number (OgmiosProvider turns an unparseable start time into NaN)
// must not become the process's clock: the cache above never forgets, and every validity range would be computed from it.
export async function ensureSlotConfig(provider: Pick<SlotClockProvider, 'getSystemStartMs'>): Promise<number> {
  if (vectorZeroTime === null) {
    const zeroTime = await provider.getSystemStartMs();
    if (typeof zeroTime !== 'number' || !Number.isFinite(zeroTime)) {
      const got = typeof zeroTime === 'number' ? String(zeroTime) : typeof zeroTime; // NaN, Infinity, or the type of what came back
      throw new ChainClockError(`The node did not report a usable chain start time (got ${got}), so the slot clock was not set.`);
    }
    vectorZeroTime = zeroTime;
    SLOT_CONFIG_NETWORK.Mainnet = { zeroTime, zeroSlot: 0, slotLength: 1000 };
  }
  return vectorZeroTime;
}

// ─── Addresses ───────────────────────────────────────────────────────────────

/** The payment key hash of a wallet address; an address with a script payment credential is refused. */
export function paymentKeyHashOf(address: string): string {
  let details;
  try {
    details = getAddressDetails(address);
  } catch (e) {
    throw new Error(`Invalid address: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (details.paymentCredential?.type !== 'Key' || !details.paymentCredential.hash) {
    throw new Error('Address must have a verification key payment credential, not a script credential.');
  }
  return details.paymentCredential.hash;
}
