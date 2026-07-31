/**
 * Custom Lucid Provider backed by Ogmios HTTP JSON-RPC + Vector submit-api.
 *
 * Implements the @lucid-evolution/lucid Provider interface so we can use Lucid's
 * transaction building/signing without depending on Blockfrost.
 *
 * Uses the global `fetch` (native, undici-backed - guaranteed since the node
 * floor is >=22), not a bundled polyfill. This used to import `fetch` from
 * `cross-fetch`, whose underlying `node-fetch` embeds the request URL
 * directly in its own thrown error messages (`request to ${url} failed,
 * reason: ...`, `invalid json response body at ${url} reason: ...`) - a
 * leak that bypassed every sanitiser below it, since those only handle the
 * `!response.ok` case, not a fetch()-level rejection or a response.json()
 * parse failure. Undici's errors do not embed the URL (verified live on this
 * Node build: a DNS failure throws `TypeError: fetch failed` with the real
 * reason on `.cause`, not in `.message`), but every fetch() call and every
 * `.json()` parse is still wrapped below regardless - a JSON-parse failure
 * leaks a snippet of the raw body into its own SyntaxError message
 * (`Unexpected token '<', "<html><bod"... is not valid JSON`, verified live
 * too) independent of which fetch implementation is in use, and operators
 * still need the detail this file's console.error calls carry.
 */
import type {
  Provider,
  ProtocolParameters,
  UTxO,
  OutRef,
  Credential,
  Delegation,
  EvalRedeemer,
} from '@lucid-evolution/lucid';

interface OgmiosProviderConfig {
  ogmiosUrl: string;
  submitUrl: string;
  koiosUrl?: string;
}

/**
 * Interpret a submit-api response body as a transaction hash.
 *
 * Exported and pure so it can be tested without a network round trip. Now
 * that `provider.ts` reads the global `fetch` instead of importing one from
 * `cross-fetch`, `OgmiosProvider`'s own methods are also stubbable in tests
 * (`globalThis.fetch = ...`) - `parseSubmitResponse` stays a separate pure
 * function anyway, on its own merits: it is reused nowhere near a network
 * call, and testing the parsing rule in isolation is simpler than testing it
 * through a live or stubbed HTTP round trip either way.
 *
 * Refuses rather than guessing. The previous implementation fell back to the
 * first 64 characters of the *submitted CBOR*, which is a well-formed 64-char
 * hex string and therefore indistinguishable from a real hash to any caller.
 */
export function parseSubmitResponse(body: string): string {
  const trimmed = body.trim();

  // A transaction hash is 32 bytes: exactly 64 hex characters.
  const isTxHash = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v);

  try {
    const parsed = JSON.parse(trimmed);
    if (isTxHash(parsed)) return parsed;
    const candidate = parsed?.txId ?? parsed?.txHash ?? parsed?.id;
    if (isTxHash(candidate)) return candidate;
  } catch {
    // Not JSON — fall through to the bare-text form below.
  }

  const bare = trimmed.replace(/^"|"$/g, '');
  if (isTxHash(bare)) return bare;

  // Deliberately does not claim the submission failed: the request succeeded,
  // only the response was unreadable.
  throw new Error(
    'Transaction was submitted but the response could not be parsed as a transaction hash. ' +
      'The transaction may or may not have been accepted - check the explorer before retrying.'
  );
}

/**
 * Interpret a parsed Koios `tx_status` response body as a confirmation
 * signal.
 *
 * Exported and pure so it can be tested without a network round trip - same
 * rationale as `parseSubmitResponse` above. By the time this runs, the
 * caller (`OgmiosProvider.getKoiosTxStatus`) has already thrown on a genuine
 * transport/HTTP failure, so anything reaching here is a syntactically valid
 * response from a reachable Koios. A missing hash (empty array - Koios has
 * not indexed it yet), a present-but-zero-confirmation entry, or a body that
 * does not match the expected shape are all treated as "not yet confirmed"
 * (false) rather than an error: none of them mean the check itself failed.
 */
export function koiosIndicatesConfirmed(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  const entry = data[0] as { num_confirmations?: unknown } | undefined;
  return typeof entry?.num_confirmations === 'number' && entry.num_confirmations > 0;
}

/**
 * Format a downstream HTTP or JSON-RPC failure into a message safe to return
 * to an untrusted caller: names the service, the operation, and the status -
 * never the endpoint URL, and never the raw response body.
 *
 * On a hosted, multi-tenant deployment the configured Ogmios/Koios/submit-api
 * endpoint is operator infrastructure, not caller information - and a raw
 * response body from a misconfigured or unreachable endpoint (a reverse-proxy
 * error page, for instance) can itself echo back hostnames or other detail
 * that has no business reaching a caller. Call sites console.error the full
 * detail (status, body, and which endpoint) themselves before throwing this -
 * full detail to the operator's log, a clean summary to the caller. That
 * split is the sanitisation. `status` also accepts a string, for a network
 * failure or a JSON-RPC error code where there is no HTTP status at all.
 *
 * Exported and pure so it can be tested without a network round trip - same
 * rationale as parseSubmitResponse above.
 */
export function formatServiceError(
  service: string,
  operation: string,
  status: number | string,
  statusText?: string,
): string {
  return `${service} request failed (${operation}): ${status}${statusText ? ` ${statusText}` : ''}`;
}

// Longest caller-visible submission-rejection body returned verbatim (after
// scrubbing) - bounds how much of a large upstream error page (some
// reverse proxies return full HTML) ends up in a tool response.
const MAX_SCRUBBED_LENGTH = 2000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrub URL-shaped content out of caller-visible text: every http(s) URL,
 * plus - given a caller-supplied list of known configured endpoints - any
 * bare occurrence of one of their hostnames, with or without a scheme. Bare
 * hostnames matter because the shape a raw reverse-proxy or gateway error
 * page most often uses is not a URL at all ("could not connect to
 * ogmios.vector.mainnet.apexfusion.org:1337"), which the generic
 * https?:// pattern alone would miss. Caps the result length so a large
 * upstream error page cannot flood a tool response.
 *
 * Known limitation, stated plainly rather than left for a reader to
 * discover: this only removes http(s) URLs and whatever hostnames the
 * caller passes in as `knownHosts` (this file always passes the three
 * configured Ogmios/Koios/submit-API hosts). A submission-rejection body
 * that happens to name a DIFFERENT internal host - one this server was
 * never configured to talk to - passes through unscrubbed, bounded only by
 * the 2000-character cap above. Closing that fully would mean pattern-
 * matching arbitrary hostname shapes out of free text, which risks
 * mangling a legitimate ledger-error string; the three known hosts cover
 * every endpoint this server itself is configured to reach, which is the
 * actual leak surface audit E is about.
 *
 * Exported and pure so it can be tested without a network round trip - same
 * rationale as parseSubmitResponse above.
 */
export function scrubUrls(text: string, knownHosts: string[] = []): string {
  let scrubbed = text.replace(/https?:\/\/\S+/gi, '[endpoint]');
  for (const host of knownHosts) {
    if (!host) continue;
    let hostname = host;
    try {
      hostname = new URL(host).hostname || host;
    } catch {
      // Not a full URL - treat the value itself as the bare hostname.
    }
    if (!hostname) continue;
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(hostname), 'gi'), '[endpoint]');
  }
  return scrubbed.length > MAX_SCRUBBED_LENGTH
    ? `${scrubbed.slice(0, MAX_SCRUBBED_LENGTH)} [truncated]`
    : scrubbed;
}

/**
 * Format a transaction-submission rejection for the caller.
 *
 * Unlike formatServiceError (an Ogmios/Koios QUERY failure - our own
 * infrastructure's problem, never the caller's), a submit-api rejection is
 * the ledger's verdict on the CALLER'S OWN transaction: ValueNotConservedUTxO,
 * BadInputsUTxO, ScriptWitnessNotValidating, a missing witness, a fee too
 * small. That reason is caller information, not operator information - it is
 * the entire feedback loop an agent uses to self-correct after
 * build -> sign -> submit, and dropping it to a bare status code breaks the
 * workflow this whole non-custodial migration exists to serve. So the body
 * survives here, scrubbed of URL-shaped content (scrubUrls) rather than
 * discarded outright: the body is still attacker-adjacent (an internal or
 * misconfigured endpoint's own response), even though its content is
 * otherwise legitimate to return.
 *
 * A NETWORK failure to even reach the submit API (no HTTP response at all)
 * is deliberately NOT routed through this function - see submitTx below. It
 * is not a ledger verdict on anything, and calling it a "rejection" would be
 * actively misleading; it goes through formatServiceError instead, the same
 * as an Ogmios/Koios connection failure.
 */
export function formatSubmitRejection(
  status: number,
  statusText: string,
  body: string,
  knownHosts: string[] = [],
): string {
  const suffix = statusText ? ` ${statusText}` : '';
  return `Transaction submission rejected (${status}${suffix}): ${scrubUrls(body, knownHosts)}`;
}

/**
 * Render an Error (or thrown non-Error value) into one log-friendly string,
 * including its `.cause` when present - operator-log use only, never for a
 * caller-visible message. Native fetch (undici) throws are often terse
 * ("fetch failed") with the actual DNS/connection reason attached as
 * `.cause` rather than folded into `.message` (verified live: a DNS failure
 * yields message "fetch failed", cause.message "getaddrinfo ENOTFOUND
 * <host>") - without this, the operator's console.error would show only the
 * useless top-level message.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined;
    return causeText ? `${err.message} (cause: ${causeText})` : err.message;
  }
  return String(err);
}

export class OgmiosProvider implements Provider {
  private ogmiosUrl: string;
  private submitUrl: string;
  private koiosUrl: string | undefined;

  constructor(config: OgmiosProviderConfig) {
    // Strip trailing slashes for consistent URL building
    this.ogmiosUrl = config.ogmiosUrl.replace(/\/+$/, '');
    this.submitUrl = config.submitUrl.replace(/\/+$/, '');
    this.koiosUrl = config.koiosUrl?.replace(/\/+$/, '');
  }

  /**
   * The three configured endpoints, for scrubUrls' knownHosts parameter -
   * defensive: a shared reverse proxy in front of more than one of these
   * services could in principle echo a SIBLING service's hostname in its own
   * error page, so every caller-visible scrub pass considers all three, not
   * just the one endpoint actually being called.
   */
  private knownHosts(): string[] {
    return [this.ogmiosUrl, this.submitUrl, this.koiosUrl].filter((u): u is string => Boolean(u));
  }

  /**
   * Send a JSON-RPC request to Ogmios.
   *
   * Every failure mode a bare `await fetch(...)` can produce is caught here
   * and rethrown sanitised: a rejected fetch (network/DNS failure - the
   * class of error node-fetch used to embed this.ogmiosUrl into, see the
   * file header), a non-OK HTTP response, a response body that is not valid
   * JSON, and a well-formed JSON-RPC error object. Full detail (including
   * the URL) always goes to console.error first; only a sanitised summary is
   * ever thrown.
   */
  private async rpc(method: string, params?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.ogmiosUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          params: params || {},
          id: null,
        }),
      });
    } catch (err) {
      console.error(`[OgmiosProvider] Ogmios network error (${method}) at ${this.ogmiosUrl}: ${describeError(err)}`);
      throw new Error(formatServiceError('Ogmios', method, 'network error'));
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`[OgmiosProvider] Ogmios RPC error (${method}) at ${this.ogmiosUrl}: ${response.status} ${response.statusText} - ${text}`);
      throw new Error(formatServiceError('Ogmios', method, response.status, response.statusText));
    }

    let json: any;
    try {
      json = await response.json();
    } catch (err) {
      console.error(`[OgmiosProvider] Ogmios response parse error (${method}) at ${this.ogmiosUrl}: ${describeError(err)}`);
      throw new Error(formatServiceError('Ogmios', method, 'invalid response'));
    }

    if (json.error) {
      console.error(`[OgmiosProvider] Ogmios RPC error (${method}) at ${this.ogmiosUrl}:`, json.error);
      throw new Error(formatServiceError('Ogmios', method, json.error?.code ?? 'error', json.error?.message ?? 'RPC error'));
    }

    return json.result;
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const result = await this.rpc('queryLedgerState/protocolParameters');

    try {
      // Map Ogmios v6 response to Lucid's ProtocolParameters format
      // Defaults are sourced from the Vector public testnet (2026-03-31)
      return {
        minFeeA: result.minFeeCoefficient ?? 45,
        minFeeB: result.minFeeConstant?.ada?.lovelace
          ?? result.minFeeConstant?.lovelace
          ?? (typeof result.minFeeConstant === 'number' ? result.minFeeConstant : 156253),
        maxTxSize: result.maxTransactionSize?.bytes ?? result.maxTransactionSize ?? 16384,
        maxValSize: result.maxValueSize?.bytes ?? result.maxValueSize ?? 5000,
        keyDeposit: BigInt(result.stakeCredentialDeposit?.ada?.lovelace ?? result.stakeCredentialDeposit ?? 500000000),
        poolDeposit: BigInt(result.stakePoolDeposit?.ada?.lovelace ?? result.stakePoolDeposit ?? 5000000000000),
        priceMem: result.scriptExecutionPrices?.memory
          ? this.parseFraction(result.scriptExecutionPrices.memory)
          : (result.prices?.memory ?? 0.0577),
        priceStep: result.scriptExecutionPrices?.cpu
          ? this.parseFraction(result.scriptExecutionPrices.cpu)
          : (result.prices?.steps ?? 0.0000721),
        maxTxExMem: BigInt(result.maxExecutionUnitsPerTransaction?.memory ?? 16000000),
        maxTxExSteps: BigInt(result.maxExecutionUnitsPerTransaction?.cpu ?? 10000000000),
        coinsPerUtxoByte: BigInt(result.minUtxoDepositCoefficient ?? result.coinsPerUtxoByte ?? 4310),
        collateralPercentage: result.collateralPercentage ?? 150,
        maxCollateralInputs: result.maxCollateralInputs ?? 3,
        costModels: this.parseCostModels(result.plutusCostModels ?? result.costModels ?? {}),
        minFeeRefScriptCostPerByte: result.minFeeReferenceScripts?.base ?? 15,
        drepDeposit: BigInt(result.delegateRepresentativeDeposit?.ada?.lovelace ?? 1000000000000),
        govActionDeposit: BigInt(result.governanceActionDeposit?.ada?.lovelace ?? 1000000000),
      } as ProtocolParameters;
    } catch (err) {
      console.error('[OgmiosProvider] Protocol parameter mapping failed:', err);
      console.error('[OgmiosProvider] Raw Ogmios result:', JSON.stringify(result, null, 2));
      throw err;
    }
  }

  private parseFraction(value: string | number): number {
    if (typeof value === 'number') return value;
    const parts = value.split('/');
    if (parts.length === 2) {
      return Number(parts[0]) / Number(parts[1]);
    }
    return parseFloat(value);
  }

  private parseCostModels(raw: any): any {
    const costModels: any = {};
    if (raw['plutus:v1']) {
      costModels.PlutusV1 = raw['plutus:v1'];
    }
    if (raw['plutus:v2']) {
      costModels.PlutusV2 = raw['plutus:v2'];
    }
    if (raw['plutus:v3']) {
      costModels.PlutusV3 = raw['plutus:v3'];
    }
    // Fallback: if keys are already PlutusV1/V2 format
    if (raw.PlutusV1) costModels.PlutusV1 = raw.PlutusV1;
    if (raw.PlutusV2) costModels.PlutusV2 = raw.PlutusV2;
    if (raw.PlutusV3) costModels.PlutusV3 = raw.PlutusV3;
    return costModels;
  }

  async getUtxos(addressOrCredential: string | Credential): Promise<UTxO[]> {
    if (typeof addressOrCredential !== 'string') {
      throw new Error(
        'Credential-based UTxO lookup is not supported by Ogmios. ' +
        'Please provide a bech32 address string.'
      );
    }

    const result = await this.rpc('queryLedgerState/utxo', { addresses: [addressOrCredential] });
    return this.ogmiosUtxosToLucid(result);
  }

  async getUtxosWithUnit(addressOrCredential: string | Credential, unit: string): Promise<UTxO[]> {
    const utxos = await this.getUtxos(addressOrCredential);
    return utxos.filter((utxo) => utxo.assets[unit]);
  }

  async getUtxoByUnit(unit: string): Promise<UTxO> {
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);

    // Try Koios indexer first (fastest path). Every failure here - network,
    // non-OK, or unparseable body - is logged for operators and then falls
    // through to the generic "not found" throw below, which names none of
    // it: the caller only ever learns the asset was not found, not why the
    // Koios attempt failed.
    if (this.koiosUrl) {
      try {
        const response = await fetch(`${this.koiosUrl}/api/v1/asset_utxos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _asset_list: [[policyId, assetName]] }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.length > 0) {
            return this.koiosUtxoToLucid(data[0]);
          }
        } else {
          console.error(`[OgmiosProvider] Koios asset_utxos query failed at ${this.koiosUrl}: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        console.error(`[OgmiosProvider] Koios asset_utxos error at ${this.koiosUrl}: ${describeError(err)}`);
      }
    }

    throw new Error(
      `Asset ${policyId.slice(0, 8)}...${assetName ? assetName.slice(0, 8) + '...' : '(empty)'} not found. ` +
      `${this.koiosUrl ? 'Koios returned no results.' : 'No Koios indexer configured.'} ` +
      `The asset may not exist on-chain yet (wait for TX confirmation) or may have been burned.`
    );
  }

  async getNetworkTip(): Promise<{ slot: number; hash: string }> {
    const result = await this.rpc('queryNetwork/tip');
    return {
      slot: result.slot ?? 0,
      hash: result.id ?? '',
    };
  }

  /**
   * Query the genesis system start time from Ogmios.
   * Returns POSIX milliseconds (e.g. 1756485600000 for Vector mainnet).
   */
  async getSystemStartMs(): Promise<number> {
    const result = await this.rpc('queryNetwork/startTime');
    // Result is an ISO 8601 string, e.g. "2025-08-29T16:40:00Z"
    return new Date(result).getTime();
  }

  async getUtxosByOutRef(outRefs: OutRef[]): Promise<UTxO[]> {
    const outputReferences = outRefs.map((ref) => ({
      transaction: { id: ref.txHash },
      index: ref.outputIndex,
    }));

    const result = await this.rpc('queryLedgerState/utxo', { outputReferences });
    return this.ogmiosUtxosToLucid(result);
  }

  async getDelegation(rewardAddress: string): Promise<Delegation> {
    // Try Koios first if available - same swallow-to-default shape as
    // getUtxoByUnit above, now with operator visibility on the way in.
    if (this.koiosUrl) {
      try {
        const response = await fetch(`${this.koiosUrl}/api/v1/account_info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _stake_addresses: [rewardAddress] }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.length > 0) {
            return {
              poolId: data[0].delegated_pool || null,
              rewards: BigInt(data[0].rewards_available || 0),
            };
          }
        } else {
          console.error(`[OgmiosProvider] Koios account_info query failed at ${this.koiosUrl}: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        console.error(`[OgmiosProvider] Koios account_info error at ${this.koiosUrl}: ${describeError(err)}`);
      }
    }
    return { poolId: null, rewards: 0n };
  }

  async getDatum(datumHash: string): Promise<string> {
    // Try Koios if available - same shape again.
    if (this.koiosUrl) {
      try {
        const response = await fetch(`${this.koiosUrl}/api/v1/datum_info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _datum_hashes: [datumHash] }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.length > 0 && data[0].bytes) {
            return data[0].bytes;
          }
        } else {
          console.error(`[OgmiosProvider] Koios datum_info query failed at ${this.koiosUrl}: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        console.error(`[OgmiosProvider] Koios datum_info error at ${this.koiosUrl}: ${describeError(err)}`);
      }
    }
    throw new Error(`Datum not found for hash: ${datumHash}. Datum lookups require Koios indexer.`);
  }

  /**
   * Query Koios for a transaction's confirmation status, once.
   *
   * Thin and deliberately does not interpret the response - see
   * `koiosIndicatesConfirmed` above, kept separate so it can be unit tested
   * without a network round trip. Unlike the Koios branch inside `awaitTx`
   * below (which swallows every failure into "keep polling"), this throws on
   * a network failure, a non-OK response, or an unparseable body: the caller
   * could not determine status, which is a different situation from "asked,
   * and it is not confirmed yet", and callers such as `pollUntilConfirmed`
   * (packages/builder/src/vector/poll.ts) need to be able to tell the two
   * apart. Every throw here is sanitised the same way rpc()'s is.
   */
  async getKoiosTxStatus(txHash: string): Promise<unknown> {
    if (!this.koiosUrl) {
      throw new Error(
        'Koios URL is not configured. Transaction status checks require Koios indexer. ' +
        'Set VECTOR_KOIOS_URL in your environment.'
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.koiosUrl}/api/v1/tx_status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _tx_hashes: [txHash] }),
      });
    } catch (err) {
      console.error(`[OgmiosProvider] Koios network error (tx_status) at ${this.koiosUrl}: ${describeError(err)}`);
      throw new Error(formatServiceError('Koios', 'tx_status', 'network error'));
    }
    if (!response.ok) {
      const text = await response.text();
      console.error(`[OgmiosProvider] Koios tx_status query failed at ${this.koiosUrl}: ${response.status} ${response.statusText} - ${text}`);
      throw new Error(formatServiceError('Koios', 'tx_status', response.status, response.statusText));
    }
    try {
      return await response.json();
    } catch (err) {
      console.error(`[OgmiosProvider] Koios response parse error (tx_status) at ${this.koiosUrl}: ${describeError(err)}`);
      throw new Error(formatServiceError('Koios', 'tx_status', 'invalid response'));
    }
  }

  /**
   * Required by the @lucid-evolution/lucid `Provider` interface that this
   * class implements, but otherwise unused repo-wide: `vector_await_transaction`
   * builds its own poll loop on top of `getKoiosTxStatus`/`getUtxosByOutRef`
   * (see packages/builder/src/vector/poll.ts) instead of calling this,
   * because this method's fixed 60-attempt/3s-interval budget cannot be
   * configured by a caller and it swallows every failure - network error,
   * non-OK response, malformed body - into "keep polling", which is
   * indistinguishable from "checked and it is not there yet". Left
   * unmodified rather than deleted or reworked: TypeScript requires it to
   * satisfy `implements Provider`, and changing its own retry/error
   * semantics is out of scope here since nothing depends on them. The two
   * catch blocks now log for operator visibility (they did not before);
   * the swallow-and-continue-polling behavior itself is unchanged.
   */
  async awaitTx(txHash: string, checkInterval: number = 3000): Promise<boolean> {
    // Poll for tx confirmation
    const maxAttempts = 60; // ~3 minutes at 3s intervals
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));

      // Try Koios tx_status if available
      if (this.koiosUrl) {
        try {
          const response = await fetch(`${this.koiosUrl}/api/v1/tx_status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _tx_hashes: [txHash] }),
          });
          if (response.ok) {
            const data = await response.json();
            if (data.length > 0 && data[0].num_confirmations > 0) {
              return true;
            }
          }
        } catch (err) {
          console.error(`[OgmiosProvider] awaitTx Koios poll error at ${this.koiosUrl}: ${describeError(err)}`);
        }
      } else {
        // Without Koios, try querying the UTxO by outRef
        try {
          const utxos = await this.getUtxosByOutRef([{ txHash, outputIndex: 0 }]);
          if (utxos.length > 0) {
            return true;
          }
        } catch (err) {
          console.error(`[OgmiosProvider] awaitTx getUtxosByOutRef poll error: ${describeError(err)}`);
        }
      }
    }
    return false;
  }

  /**
   * Evaluate a transaction (lucid-evolution Provider interface).
   * Returns execution units for script validation as EvalRedeemer[].
   */
  async evaluateTx(tx: string, additionalUTxOs?: UTxO[]): Promise<EvalRedeemer[]> {
    const result = await this.rpc('evaluateTransaction', {
      transaction: { cbor: tx },
    });
    // Parse result to EvalRedeemer[] format
    if (Array.isArray(result)) {
      return result.map((item: any) => ({
        ex_units: {
          mem: item.budget?.memory ?? 0,
          steps: item.budget?.cpu ?? 0,
        },
        redeemer_index: item.validator?.index ?? 0,
        redeemer_tag: item.validator?.purpose ?? 'spend',
      }));
    }
    return [];
  }

  /**
   * Evaluate a transaction without submitting (dry run).
   * Backward-compatible alias - returns raw Ogmios response.
   */
  async evaluateTransaction(txCborHex: string): Promise<any> {
    return this.rpc('evaluateTransaction', {
      transaction: { cbor: txCborHex },
    });
  }

  /**
   * Get transaction history for an address via Koios.
   *
   * Step 1 (address_txs) is load-bearing: any failure - network, non-OK, or
   * unparseable body - is sanitised and thrown, same shape as rpc()/
   * getKoiosTxStatus(). Step 2 (tx_info) is optional detail on top of a
   * result Step 1 already produced: any failure there - network, non-OK, or
   * unparseable body - degrades to the basic tx list instead of failing the
   * whole call, extending what used to be only a `!response.ok` fallback to
   * cover every failure mode, with operator logging on each path (none of
   * which existed before this change).
   */
  async getTransactionHistory(
    address: string,
    offset: number = 0,
    limit: number = 20,
  ): Promise<any[]> {
    if (!this.koiosUrl) {
      throw new Error(
        'Koios URL is not configured. Transaction history requires Koios indexer. ' +
        'Set VECTOR_KOIOS_URL in your environment.'
      );
    }

    // Step 1: Get tx hashes for the address
    let txListResponse: Response;
    try {
      txListResponse = await fetch(`${this.koiosUrl}/api/v1/address_txs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _addresses: [address], _after_block_height: 0 }),
      });
    } catch (err) {
      console.error(`[OgmiosProvider] Koios network error (address_txs) at ${this.koiosUrl}: ${describeError(err)}`);
      throw new Error(formatServiceError('Koios', 'address_txs', 'network error'));
    }

    if (!txListResponse.ok) {
      const text = await txListResponse.text();
      console.error(`[OgmiosProvider] Koios address_txs query failed at ${this.koiosUrl}: ${txListResponse.status} ${txListResponse.statusText} - ${text}`);
      throw new Error(formatServiceError('Koios', 'address_txs', txListResponse.status, txListResponse.statusText));
    }

    let txList: any[];
    try {
      txList = await txListResponse.json();
    } catch (err) {
      console.error(`[OgmiosProvider] Koios response parse error (address_txs) at ${this.koiosUrl}: ${describeError(err)}`);
      throw new Error(formatServiceError('Koios', 'address_txs', 'invalid response'));
    }

    // Apply pagination
    const paginatedTxs = txList.slice(offset, offset + limit);

    if (paginatedTxs.length === 0) {
      return [];
    }

    const basicTxList = () => paginatedTxs.map((tx: any) => ({
      txHash: tx.tx_hash,
      blockHeight: tx.block_height || 0,
      blockTime: tx.block_time
        ? new Date(tx.block_time * 1000).toISOString()
        : '',
      fee: '0',
    }));

    // Step 2: Fetch full tx details - optional enrichment, falls back to the
    // basic list above on any failure rather than failing the whole call.
    const txHashes = paginatedTxs.map((tx: any) => tx.tx_hash);
    let txInfoResponse: Response;
    try {
      txInfoResponse = await fetch(`${this.koiosUrl}/api/v1/tx_info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _tx_hashes: txHashes }),
      });
    } catch (err) {
      console.error(`[OgmiosProvider] Koios network error (tx_info) at ${this.koiosUrl}: ${describeError(err)} - falling back to basic tx list`);
      return basicTxList();
    }

    if (!txInfoResponse.ok) {
      const text = await txInfoResponse.text().catch(() => '');
      console.error(`[OgmiosProvider] Koios tx_info query failed at ${this.koiosUrl}: ${txInfoResponse.status} ${txInfoResponse.statusText} - ${text} - falling back to basic tx list`);
      return basicTxList();
    }

    let txInfos: any[];
    try {
      txInfos = await txInfoResponse.json();
    } catch (err) {
      console.error(`[OgmiosProvider] Koios response parse error (tx_info) at ${this.koiosUrl}: ${describeError(err)} - falling back to basic tx list`);
      return basicTxList();
    }

    return txInfos.map((info: any) => ({
      txHash: info.tx_hash,
      blockHeight: info.block_height || 0,
      blockTime: info.tx_timestamp
        ? new Date(info.tx_timestamp * 1000).toISOString()
        : info.block_time
          ? new Date(info.block_time * 1000).toISOString()
          : '',
      fee: info.fee || '0',
      inputs: (info.inputs || []).map((inp: any) => ({
        address: inp.payment_addr?.bech32 || inp.address || '',
        amount: inp.value || '0',
      })),
      outputs: (info.outputs || []).map((out: any) => ({
        address: out.payment_addr?.bech32 || out.address || '',
        amount: out.value || '0',
      })),
    }));
  }

  /**
   * A NETWORK failure to reach the submit API (fetch() itself rejects, no
   * HTTP response was ever received) is not a ledger verdict on anything -
   * it is this server's own infrastructure failing to talk to the submit
   * endpoint, the same class of problem as an Ogmios/Koios connection
   * failure. It is sanitised through formatServiceError, not
   * formatSubmitRejection: calling an unreachable endpoint a "rejection"
   * would misleadingly imply the ledger looked at the transaction and said
   * no, when nothing looked at it at all. An actual non-OK HTTP response
   * from the submit API IS the ledger's verdict, and keeps going through
   * formatSubmitRejection exactly as before.
   */
  async submitTx(tx: string): Promise<string> {
    // tx is a hex-encoded CBOR transaction
    // submit-api expects raw CBOR bytes with Content-Type: application/cbor
    const bytes = Buffer.from(tx, 'hex');

    let response: Response;
    try {
      response = await fetch(this.submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/cbor' },
        body: bytes,
      });
    } catch (err) {
      console.error(`[OgmiosProvider] Submit API network error at ${this.submitUrl}: ${describeError(err)}`);
      throw new Error(formatServiceError('Submit API', 'submitTx', 'network error'));
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OgmiosProvider] Transaction submission failed at ${this.submitUrl}: ${response.status} ${response.statusText} - ${errorText}`);
      throw new Error(
        formatSubmitRejection(
          response.status,
          response.statusText,
          errorText,
          this.knownHosts(),
        ),
      );
    }

    const result = await response.text();
    return parseSubmitResponse(result);
  }

  /**
   * Convert Ogmios UTxO response format to Lucid UTxO format
   */
  private ogmiosUtxosToLucid(ogmiosUtxos: any[]): UTxO[] {
    if (!Array.isArray(ogmiosUtxos)) return [];

    return ogmiosUtxos.map((utxo) => {
      const txHash = utxo.transaction?.id ?? utxo.txId;
      const outputIndex = utxo.index ?? utxo.outputIndex;
      const output = utxo.output ?? utxo;

      // Parse assets
      const assets: Record<string, bigint> = {};

      // Handle different Ogmios response formats for value
      const value = output.value ?? output.amount;

      if (typeof value === 'object' && value !== null) {
        // Ogmios v6 format: { ada: { lovelace: N }, policyId: { assetName: N } }
        if (value.ada?.lovelace !== undefined) {
          assets['lovelace'] = BigInt(value.ada.lovelace);
        } else if (value.coins !== undefined) {
          // Older format
          assets['lovelace'] = BigInt(value.coins);
        } else if (typeof value === 'bigint' || typeof value === 'number') {
          assets['lovelace'] = BigInt(value);
        }

        // Parse native assets
        for (const [key, val] of Object.entries(value)) {
          if (key === 'ada' || key === 'coins' || key === 'lovelace') continue;
          if (typeof val === 'object' && val !== null) {
            // key is policy ID, val is { assetName: quantity }
            for (const [assetName, quantity] of Object.entries(val as Record<string, any>)) {
              const unit = `${key}${assetName === '' ? '' : assetName}`;
              assets[unit] = BigInt(quantity);
            }
          }
        }
      } else if (typeof value === 'number' || typeof value === 'string') {
        assets['lovelace'] = BigInt(value);
      }

      // Handle address
      const address = output.address ?? '';

      // Handle datum
      let datumHash: string | null = null;
      let datum: string | null = null;

      if (output.datumHash) {
        datumHash = output.datumHash;
      }
      if (output.datum) {
        if (typeof output.datum === 'string') {
          datum = output.datum;
        } else if (output.datum.hash) {
          datumHash = output.datum.hash;
        } else if (output.datum.value || output.datum.bytes) {
          datum = output.datum.value || output.datum.bytes;
        }
      }

      // Handle script reference
      let scriptRef: any = null;
      if (output.script) {
        const script = output.script;
        // Ogmios v6 format: { language: "plutus:v3", cbor: "..." }
        if (script.language && script.cbor) {
          const langMap: Record<string, string> = {
            'plutus:v1': 'PlutusV1',
            'plutus:v2': 'PlutusV2',
            'plutus:v3': 'PlutusV3',
          };
          const lucidType = langMap[script.language];
          if (lucidType) {
            scriptRef = { type: lucidType, script: script.cbor };
          }
        // Legacy format: { "plutus:v2": "..." }
        } else if (script['plutus:v2']) {
          scriptRef = { type: 'PlutusV2', script: script['plutus:v2'] };
        } else if (script['plutus:v1']) {
          scriptRef = { type: 'PlutusV1', script: script['plutus:v1'] };
        } else if (script['plutus:v3']) {
          scriptRef = { type: 'PlutusV3', script: script['plutus:v3'] };
        } else if (script.native) {
          scriptRef = { type: 'Native', script: JSON.stringify(script.native) };
        }
      }

      return {
        txHash,
        outputIndex,
        assets,
        address,
        datumHash,
        datum,
        scriptRef,
      } as UTxO;
    });
  }

  /**
   * Convert a Koios UTxO response to Lucid format
   */
  private koiosUtxoToLucid(koiosUtxo: any): UTxO {
    const assets: Record<string, bigint> = {};
    assets['lovelace'] = BigInt(koiosUtxo.value || 0);

    if (koiosUtxo.asset_list) {
      for (const asset of koiosUtxo.asset_list) {
        const unit = `${asset.policy_id}${asset.asset_name || ''}`;
        assets[unit] = BigInt(asset.quantity || 0);
      }
    }

    return {
      txHash: koiosUtxo.tx_hash,
      outputIndex: koiosUtxo.tx_index,
      assets,
      address: koiosUtxo.address,
      datumHash: koiosUtxo.datum_hash || null,
      datum: koiosUtxo.inline_datum?.bytes || null,
      scriptRef: null,
    } as UTxO;
  }
}
