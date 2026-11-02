// Input resolution: the one network call this package can make, and only when
// VECTOR_SIGNER_OGMIOS_URL is set. It asks Ogmios for the outputs that a
// transaction spends (the ledger-state query queryLedgerState/utxo, by output
// reference), so that the spend policy can count only what this signer's own
// inputs fund. The request carries output references and nothing else: no
// key, no transaction. test/boundary.test.ts keeps every other module free of
// network access and keeps this one to its single read-only query.
//
// Trust: the answer decides which inputs count as this signer's. An endpoint
// that lies about the address of an input can make the policy count less than
// the signature gives away, so point VECTOR_SIGNER_OGMIOS_URL only at an
// endpoint you trust (best: your own node). Every failure here - unreachable,
// an HTTP error, an answer that is malformed, too large, or names an output
// that was not asked for - gives the fallback rule, never a smaller count.
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import type { DecodedInput, DecodedTx } from './decode.js';
import { outRefKey, RESOLUTION_OFF, type InputResolution, type ResolvedOutput } from './policy.js';

/** Resolves output references to the outputs they name. Throws when it cannot answer for certain. */
export type InputResolver = (inputs: readonly DecodedInput[]) => Promise<Map<string, ResolvedOutput>>;

const TIMEOUT_MS = 10_000;
/** A transaction spends at most a few hundred outputs, and an output with an inline datum or a script is at most some tens of kB. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A resolver that asks the Ogmios HTTP JSON-RPC endpoint at `url`. The errors
 * it throws name the failure only, never the URL: the URL is the user's own
 * configuration and can carry a token.
 */
export function ogmiosInputResolver(url: string, fetchImpl: typeof fetch = globalThis.fetch): InputResolver {
  return async (inputs) => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      method: 'queryLedgerState/utxo',
      params: { outputReferences: inputs.map((input) => ({ transaction: { id: input.txHash }, index: input.index })) },
      id: null,
    });
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: request,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error('Ogmios could not be reached (network error or timeout)');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Ogmios answered HTTP ${res.status}`);
    }
    const answer = (await readAnswer(res)) as { result?: unknown; error?: { code?: unknown } } | null;
    if (answer === null || typeof answer !== 'object') throw new Error('the Ogmios answer is not a JSON-RPC response');
    if (answer.error !== undefined) {
      const code = typeof answer.error?.code === 'number' ? ` ${answer.error.code}` : '';
      throw new Error(`Ogmios answered with JSON-RPC error${code}`);
    }
    return readOutputs(answer.result, inputs);
  };
}

/** The body as JSON, read to MAX_ANSWER_BYTES at most. */
async function readAnswer(res: Response): Promise<unknown> {
  const tooLarge = `the Ogmios answer is over ${MAX_ANSWER_BYTES} bytes`;
  if (Number(res.headers.get('content-length')) > MAX_ANSWER_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(tooLarge);
  }
  if (!res.body) throw new Error('the Ogmios answer has no body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ANSWER_BYTES) {
        over = true;
        break;
      }
      chunks.push(value);
    }
  } catch {
    throw new Error('the Ogmios answer could not be read in full (network error or timeout)');
  }
  if (over) {
    await reader.cancel().catch(() => {});
    throw new Error(tooLarge);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('the Ogmios answer is not JSON');
  }
}

/** The value at `path` inside a parsed JSON value, or undefined where the path leaves the objects. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const isWhole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The outputs of an Ogmios v6 UTxO list, keyed by outRefKey. Every entry must be one that was asked for, once. */
function readOutputs(result: unknown, asked: readonly DecodedInput[]): Map<string, ResolvedOutput> {
  if (!Array.isArray(result)) throw new Error('the Ogmios answer holds no list of outputs');
  const wanted = new Set(asked.map(outRefKey));
  const outputs = new Map<string, ResolvedOutput>();
  for (const entry of result) {
    const id = at(entry, 'transaction', 'id');
    const index = at(entry, 'index');
    if (typeof id !== 'string' || !HEX64.test(id.toLowerCase()) || !isWhole(index)) {
      throw new Error('the Ogmios answer holds an output without a valid output reference');
    }
    const key = `${id.toLowerCase()}#${index}`;
    if (!wanted.has(key)) throw new Error(`the Ogmios answer holds output ${key}, which was not asked for`);
    if (outputs.has(key)) throw new Error(`the Ogmios answer holds output ${key} twice`);

    const lovelace = at(entry, 'value', 'ada', 'lovelace');
    if (!isWhole(lovelace)) {
      throw new Error(`the Ogmios answer gives output ${key} a lovelace amount that is not a safe whole number`);
    }
    const address = at(entry, 'address');
    const notBech32 = `the Ogmios answer gives output ${key} an address that is not bech32`;
    if (typeof address !== 'string') throw new Error(notBech32);
    let paymentKeyHash: string | null;
    try {
      paymentKeyHash = CML.Address.from_bech32(address).payment_cred()?.as_pub_key()?.to_hex().toLowerCase() ?? null;
    } catch {
      throw new Error(notBech32);
    }
    outputs.set(key, { address, lovelace: BigInt(lovelace), paymentKeyHash });
  }
  return outputs;
}

/**
 * Resolves every spent input and collateral input of `tx` for the policy.
 * Without a resolver this is RESOLUTION_OFF. Never throws: a failure is an
 * unresolved result that says why, and the policy then uses the fallback rule.
 */
export async function resolveInputs(
  tx: DecodedTx,
  signerKeyHash: string,
  resolver: InputResolver | null
): Promise<InputResolution> {
  if (!resolver) return RESOLUTION_OFF;
  const asked = [...new Map([...tx.inputs, ...tx.collateralInputs].map((input) => [outRefKey(input), input])).values()];
  try {
    const outputs = asked.length === 0 ? new Map<string, ResolvedOutput>() : await resolver(asked);
    return { resolved: true, signerKeyHash: signerKeyHash.toLowerCase(), outputs };
  } catch (err) {
    return { resolved: false, why: `input resolution failed (${err instanceof Error ? err.message : String(err)})` };
  }
}
