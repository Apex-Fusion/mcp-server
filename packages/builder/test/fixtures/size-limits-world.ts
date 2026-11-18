// packages/builder/test/fixtures/size-limits-world.ts
//
// The world of input-size-limits.test.ts: the 79 tools of registerVectorTools behind an MCP client in the same process, a node that
// answers at once (no network, no wait), the texts that a caller can send, and the walk over the input schema of each tool that finds
// every string input. The schema snapshot (test/smoke/tool-schemas.snapshot.json) is the list of tools and inputs.
import './size-limits-env.ts'; // first: it sets the environment before the modules of the builder are loaded
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { applyDoubleCborEncoding, validatorToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { registerVectorTools } from '../../src/vector/vector.ts';
import { GOV_ENV, GOV_REF_ENV } from '../../src/vector/gov-deployment.ts';
import { allowlistRoot } from '../../src/vector/identity-rules.ts';
import { buildSendApex, lucidForAddress } from '../../src/vector/build.ts';
import { FIXTURE_TOKEN_UNIT, FIXTURE_TXHASH, FIXTURE_UTXOS, FixtureProvider, FOREIGN_ADDRESS, OWN_ADDRESS, fixtureProtocolParameters } from './fixture-provider.ts';
import { GOV } from './gov-world.ts';
import { CONFIG_SEED, LEGACY_IDS } from './identity-world.ts';
import { TEMPLATE_RECEIPT } from './template-receipt.fixture.ts';

/** The part of a JSON schema that the snapshot uses. */
export interface Schema {
  type?: string; description?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[];
  additionalProperties?: Schema | boolean; enum?: unknown[]; const?: unknown; pattern?: string; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; minItems?: number;
}
export interface ToolSpec { description: string; inputSchema: Schema }

export const SNAPSHOT: Record<string, ToolSpec> = JSON.parse(readFileSync(resolve(import.meta.dirname!, '../smoke/tool-schemas.snapshot.json'), 'utf8'));

// ─── The texts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const repeatTo = (unit: string, length: number): string => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** A map of CBOR (hex, `length` characters) with as many different keys as fit: indefinite length, keys of 3 bytes, values of 1 byte. */
function cborMap(length: number): string {
  const entries = Math.floor((length - 4) / 8);
  let text = 'bf';
  for (let i = 0; i < entries; i += 1) text += `19${i.toString(16).padStart(4, '0')}00`;
  return `${text}${'0000'.repeat(((length - 4) - 8 * entries) / 4)}ff`;
}

/** A text of exactly `length` characters in each shape that a caller can send. The JSON and CBOR shapes are valid and flat. */
export const SHAPES: Array<{ name: string; make: (length: number) => string }> = [
  { name: 'lowercase letters', make: (n) => repeatTo('abcdefghijklmnopqrstuvwxyz', n) },
  { name: 'hex digits', make: (n) => repeatTo('0123456789abcdef', n) },
  { name: 'decimal digits', make: (n) => repeatTo('1234567890', n) },
  { name: 'base58 characters', make: (n) => repeatTo(BASE58, n) },
  { name: 'addr1 and letters', make: (n) => `addr1${repeatTo(BECH32, n - 5)}` },
  { name: 'JSON object with one long string', make: (n) => `{"a":"${'x'.repeat(n - 8)}"}` },
  { name: 'JSON array of numbers', make: (n) => `[${'1,'.repeat(Math.floor((n - 3) / 2))}1]`.padEnd(n, ' ') },
  { name: 'JSON object with many keys', make: (n) => { let text = '{'; for (let i = 0; text.length < n - 20; i += 1) text += `"k${i}":${i},`; return `${text}"z":0}`.padEnd(n, ' '); } },
  { name: 'CBOR map in hex', make: (n) => cborMap(n) },
  { name: 'CBOR list in hex', make: (n) => `9f${'00'.repeat((n - 4) / 2)}ff` },
];
/** The shapes for an input that the SDK checks before a tool sees it (a pattern, a maximum length, an enum): two are enough. */
export const CHECKED_SHAPES = SHAPES.slice(0, 2);

/**
 * JSON texts of exactly `length` characters with lists in lists and maps in maps, as many levels as fit, and a list of numbers in 63
 * lists. A tool that reads the values below each level again needs more time for each level, also when the text is short.
 */
export const LEVEL_SHAPES: typeof SHAPES = [
  { name: 'JSON lists in lists', make: (n) => { const levels = Math.floor((n - 1) / 2); return `${'['.repeat(levels)}1${']'.repeat(levels)}`.padEnd(n, ' '); } },
  { name: 'JSON maps in maps', make: (n) => { const levels = Math.floor((n - 1) / 6); return `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`.padEnd(n, ' '); } },
  { name: 'JSON list of numbers in 63 lists', make: (n) => `${'['.repeat(63)}${'1,'.repeat(Math.floor((n - 127) / 2))}1${']'.repeat(63)}`.padEnd(n, ' ') },
];

// ─── The inputs of a tool ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One string input: its place in the arguments, and what the schema says about it. A key of a map is an input too. */
export interface Leaf {
  path: Array<string | number>; kind: 'value' | 'key'; schema: Schema; label: string;
  /** The alternative that the path takes at each node that has several (`anyOf`), by the path of the node. */
  choices: Map<string, number>;
}
/** The path element for the one entry of a map that the arguments hold. */
const ENTRY = '<entry>';
/** The key of that entry. */
const ENTRY_KEY = FIXTURE_TOKEN_UNIT;

const labelOf = (path: Array<string | number>, kind: 'value' | 'key'): string =>
  `${path.map((part) => (part === ENTRY ? '{}' : typeof part === 'number' ? '[]' : `.${part}`)).join('').replace(/^\./, '')}${kind === 'key' ? ' (key)' : ''}`;

export function stringLeaves(schema: Schema, path: Array<string | number> = [], choices = new Map<string, number>(), out: Leaf[] = []): Leaf[] {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    alternatives.forEach((alternative, index) => stringLeaves(alternative, path, new Map(choices).set(path.join('\u0000'), index), out));
  } else if (schema.type === 'string') {
    out.push({ path, kind: 'value', schema, label: labelOf(path, 'value'), choices });
  } else if (schema.type === 'array' && schema.items) {
    stringLeaves(schema.items, [...path, 0], choices, out);
  } else if (schema.type === 'object' || schema.properties) {
    for (const [name, property] of Object.entries(schema.properties ?? {})) stringLeaves(property, [...path, name], choices, out);
    if (typeof schema.additionalProperties === 'object') {
      out.push({ path: [...path, ENTRY], kind: 'key', schema: { type: 'string' }, label: labelOf([...path, ENTRY], 'key'), choices });
      stringLeaves(schema.additionalProperties, [...path, ENTRY], choices, out);
    }
  }
  const seen = new Set<string>();
  return out.filter((leaf) => (seen.has(leaf.label) ? false : (seen.add(leaf.label), true)));
}

/** True when the SDK refuses a long text for this input before the tool sees it. */
export const checkedBySchema = (schema: Schema): boolean =>
  schema.enum !== undefined || schema.const !== undefined || schema.pattern !== undefined || (schema.maxLength !== undefined && schema.maxLength < 131_072);

// ─── Valid values for the other inputs ────────────────────────────────────────────────────────────────────────────────────────────

const HEX64 = 'ab'.repeat(32);
const HEX56 = 'cd'.repeat(28);
const DID = `did:vector:${'c1'.repeat(32)}`;

/** A value for the string input `name` that a tool takes without complaint, where a fixture or a rule gives one. */
function sampleString(name: string, schema: Schema, world: { txCbor: string }): string {
  if (schema.pattern !== undefined) {
    const pattern = new RegExp(schema.pattern);
    const found = [HEX64, HEX56, 'ab'.repeat(64), 'ab'.repeat(33)].find((candidate) => pattern.test(candidate));
    if (found !== undefined) return found;
  }
  let text: string;
  if (/address$/i.test(name)) text = OWN_ADDRESS;
  else if (/^(?:txCbor|signedTxCbor)$/.test(name)) text = world.txCbor;
  else if (name === 'scriptCbor') text = '49480100002221200101';
  else if (/^(?:datum|redeemer|initialDatum)$/.test(name)) text = 'd87980';
  else if (/TxHash$|^txHash$/.test(name)) text = HEX64;
  else if (/_refs?$|Ref$|^vault_refs$/.test(name)) text = `${HEX64}#0`;
  else if (name === 'policyId') text = FIXTURE_TOKEN_UNIT.slice(0, 56);
  else if (name === 'assetName') text = FIXTURE_TOKEN_UNIT.slice(56);
  else if (/^(?:signer|author|delegator_signer)$/.test(name)) text = 'controller';
  else if (name === 'amount') text = '10';
  else if (name === 'metadata') text = '{"674":{"msg":["a note"]}}';
  else if (/^(?:did|dids|agent|agent_id|agentDid|delegate|delegator|owner_did|successor|parent|juror|case|claim|challenge|issuer_did|subject|proposerDid)$/.test(name)) text = DID;
  else if (name === 'jury') text = HEX56;
  else if (/uri$|url$|^locator$/i.test(name)) text = 'https://example.com/a';
  else if (/signature$/.test(name)) text = 'ab'.repeat(64);
  else if (/hex$/.test(name)) text = HEX64;
  else if (name === 'job_id') text = '3f2b8c1e-5a47-4d6e-9b0a-7c1d2e3f4a5b';
  else if (name === 'receipt') text = JSON.stringify(TEMPLATE_RECEIPT.receipt);
  else text = 'x';
  return text.length < (schema.minLength ?? 0) ? text.padEnd(schema.minLength ?? 0, 'x') : text;
}

/** The arguments of a call with a value for each required input and for each input on the way to `leaf`, but not the leaf itself. */
export function baseArguments(tool: string, leaf: Leaf | undefined, world: { txCbor: string }): Record<string, unknown> {
  const onTheWay = (path: Array<string | number>): boolean => leaf !== undefined && path.length <= leaf.path.length && path.every((part, i) => part === leaf.path[i]);
  const build = (schema: Schema, path: Array<string | number>): unknown => {
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (alternatives) return build(alternatives[leaf?.choices.get(path.join('\u0000')) ?? 0] ?? alternatives[0], path);
    if (schema.const !== undefined) return schema.const;
    if (schema.enum !== undefined) return schema.enum[0];
    switch (schema.type) {
      case 'string': {
        const name = [...path].reverse().find((part): part is string => typeof part === 'string' && part !== ENTRY) ?? '';
        return sampleString(name, schema, world);
      }
      case 'number': case 'integer': {
        const low = schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : (schema.minimum ?? 1);
        return Math.min(Math.max(low, 3), schema.maximum ?? Number.MAX_SAFE_INTEGER);
      }
      case 'boolean': return false;
      case 'array': {
        const count = Math.max(schema.minItems ?? 0, onTheWay([...path, 0]) ? 1 : 0);
        return Array.from({ length: count }, () => (schema.items ? build(schema.items, [...path, 0]) : null));
      }
      default: {
        const value: Record<string, unknown> = {};
        const required = new Set(schema.required ?? []);
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
          if (required.has(name) || onTheWay([...path, name])) value[name] = build(property, [...path, name]);
        }
        if (typeof schema.additionalProperties === 'object' && onTheWay([...path, ENTRY])) value[ENTRY_KEY] = build(schema.additionalProperties, [...path, ENTRY]);
        return value;
      }
    }
  };
  const base = build(SNAPSHOT[tool].inputSchema, []) as Record<string, unknown>;
  if (tool === 'vector_await_transaction') base.timeoutSeconds = 1;
  return base;
}

/** The script of the contract tools in the tests, and its address: the node lists one output there, so that a spend finds its input. */
export const SCRIPT_CBOR = '49480100002221200101';
export const SCRIPT_ADDRESS = validatorToAddress('Mainnet', { type: 'PlutusV2', script: applyDoubleCborEncoding(SCRIPT_CBOR) });
const SCRIPT_UTXO: UTxO = { txHash: FIXTURE_TXHASH, outputIndex: 7, address: SCRIPT_ADDRESS, assets: { lovelace: 2_000_000n }, datum: 'd87980' };

/**
 * The arguments to try for `leaf`: `base`, or several variants of it, where one set of arguments does not reach every input of a tool
 * (the dry run takes a transaction or outputs, the contract tools lock or spend, a document is text or base64).
 */
export function variants(tool: string, leaf: Leaf, base: Record<string, unknown>): Array<Record<string, unknown>> {
  const first = leaf.path[0];
  switch (tool) {
    case 'vector_dry_run':
      if (first === 'txCbor') return [base];
      return [{ ...base, txCbor: undefined, changeAddress: base.changeAddress ?? OWN_ADDRESS, outputs: base.outputs ?? [{ address: FOREIGN_ADDRESS, lovelace: 2_000_000 }] }];
    case 'vector_build_interact_contract': {
      const lock = { ...base, action: 'lock', datum: base.datum ?? 'd87980' };
      const spend = { ...base, action: 'spend', redeemer: base.redeemer ?? 'd87980', utxoRef: base.utxoRef ?? { txHash: FIXTURE_TXHASH, outputIndex: 7 } };
      if (first === 'redeemer' || first === 'utxoRef') return [spend];
      if (first === 'datum' || first === 'assets') return [lock];
      return [lock, spend];
    }
    case 'vector_build_document_publish':
      return [leaf.label === 'base64' ? base : { ...base, text: base.text ?? 'a document' }];
    default:
      return [base];
  }
}

/** `base` with `text` as the input `leaf`. */
export function withText(base: Record<string, unknown>, leaf: Leaf, text: string): Record<string, unknown> {
  const copy = structuredClone(base);
  let node: unknown = copy;
  for (const part of leaf.path.slice(0, -1)) node = (node as Record<string | number, unknown>)[part === ENTRY ? ENTRY_KEY : part];
  const last = leaf.path[leaf.path.length - 1];
  const holder = node as Record<string | number, unknown>;
  if (leaf.kind === 'key') {
    const value = holder[ENTRY_KEY];
    delete holder[ENTRY_KEY];
    holder[text] = value;
  } else {
    holder[last === ENTRY ? ENTRY_KEY : last] = text;
  }
  return copy;
}

// ─── The node that answers at once ─────────────────────────────────────────────────────────────────────────────────────────────────

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function ogmiosUtxo(u: UTxO): unknown {
  const value: Record<string, Record<string, number>> = { ada: { lovelace: Number(u.assets.lovelace) } };
  for (const [unit, quantity] of Object.entries(u.assets)) {
    if (unit === 'lovelace') continue;
    value[unit.slice(0, 56)] = { ...(value[unit.slice(0, 56)] ?? {}), [unit.slice(56)]: Number(quantity) };
  }
  return { transaction: { id: u.txHash }, index: u.outputIndex, address: u.address, value, ...(u.datum ? { datum: u.datum } : {}) };
}

function ogmiosParameters(): unknown {
  const p = fixtureProtocolParameters();
  return {
    minFeeCoefficient: p.minFeeA, minFeeConstant: { ada: { lovelace: p.minFeeB } }, maxTransactionSize: { bytes: p.maxTxSize }, maxValueSize: { bytes: p.maxValSize },
    stakeCredentialDeposit: { ada: { lovelace: Number(p.keyDeposit) } }, stakePoolDeposit: { ada: { lovelace: Number(p.poolDeposit) } },
    scriptExecutionPrices: { memory: String(p.priceMem), cpu: String(p.priceStep) },
    maxExecutionUnitsPerTransaction: { memory: Number(p.maxTxExMem), cpu: Number(p.maxTxExSteps) }, minUtxoDepositCoefficient: Number(p.coinsPerUtxoByte),
    collateralPercentage: p.collateralPercentage, maxCollateralInputs: p.maxCollateralInputs,
    plutusCostModels: { 'plutus:v1': p.costModels.PlutusV1, 'plutus:v2': p.costModels.PlutusV2, 'plutus:v3': p.costModels.PlutusV3 },
    minFeeReferenceScripts: { base: p.minFeeRefScriptCostPerByte }, delegateRepresentativeDeposit: { ada: { lovelace: Number(p.drepDeposit) } },
    governanceActionDeposit: { ada: { lovelace: Number(p.govActionDeposit) } },
  };
}

/**
 * Ogmios, Koios and the indexer, in one function that answers every request at once. Ogmios lists the outputs of `store` by address or by
 * reference, and the answers of Koios and the indexer are empty.
 */
function answerAtOnce(store: UTxO[], input: RequestInfo | URL, init?: RequestInit): Response {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  interface Params { addresses?: string[]; outputReferences?: Array<{ transaction: { id: string }; index: number }> }
  let rpc: { jsonrpc?: string; method?: string; params?: Params; id?: unknown } | undefined;
  if (typeof init?.body === 'string') { try { rpc = JSON.parse(init.body); } catch { rpc = undefined; } }
  if (rpc?.jsonrpc === '2.0') {
    let result: unknown = [];
    if (rpc.method === 'queryLedgerState/protocolParameters') result = ogmiosParameters();
    else if (rpc.method === 'queryLedgerState/utxo') {
      const { addresses = [], outputReferences } = rpc.params ?? {};
      const found = outputReferences
        ? store.filter((u) => outputReferences.some((ref) => ref.transaction.id === u.txHash && ref.index === u.outputIndex))
        : store.filter((u) => addresses.includes(u.address));
      result = found.map(ogmiosUtxo);
    } else if (rpc.method === 'queryNetwork/startTime') result = '2025-08-29T16:40:00Z';
    else if (rpc.method === 'queryNetwork/tip') result = { slot: 37_300_000, id: '00'.repeat(32) };
    return json({ jsonrpc: '2.0', result, id: rpc.id ?? null });
  }
  if (url.includes('/tx_status')) return json([{ tx_hash: HEX64, num_confirmations: 100 }]);
  return json([]);
}

// ─── The world ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface World {
  /** Calls a tool through the SDK, as a request does: the arguments pass the input schema first. Returns the first line of the answer. */
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** The names of the tools that the server lists. */
  tools: () => Promise<string[]>;
  txCbor: string;
  close: () => Promise<void>;
}

/**
 * The identity registry and the Module-6 deployment of the fixtures, as the environment of the server gives them (the tools read them at
 * their first call). The jury and Module-1 tools are not configured here: their manifests name the identity registry of mainnet, and the
 * server refuses them next to the identity registry of the fixtures. jury-tools.test.ts gives each of them a long change address.
 */
function configureDeployments(): void {
  process.env.VECTOR_IDENTITY_LEGACY_ROOT = allowlistRoot(LEGACY_IDS);
  process.env.VECTOR_IDENTITY_CONFIG_SEED = `${CONFIG_SEED.txHash}#${CONFIG_SEED.outputIndex}`;
  for (const [name, variable] of Object.entries(GOV_ENV)) process.env[variable] = GOV[name as keyof typeof GOV_ENV];
  for (const [name, variable] of Object.entries(GOV_REF_ENV)) {
    const ref = GOV.refs[name as keyof typeof GOV_REF_ENV];
    if (ref) process.env[variable] = `${ref.txHash}#${ref.outputIndex}`;
  }
}

export async function openWorld(): Promise<World> {
  configureDeployments();
  const store = [...FIXTURE_UTXOS, SCRIPT_UTXO];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => answerAtOnce(store, input, init)) as typeof fetch;
  const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
  const txCbor = (await buildSendApex(lucid, { recipientAddress: FOREIGN_ADDRESS, amountApex: 3 })).txCbor;
  const node = () => Object.assign(new FixtureProvider(FIXTURE_UTXOS), { evaluateTransaction: async () => [] });
  const server = new McpServer({ name: 'size-limits', version: '0.0.0' });
  registerVectorTools(server, 'size-limits', node);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'size-limits-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    txCbor,
    tools: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      return content[0]?.text ?? '';
    },
    close: async () => { await client.close(); await server.close(); globalThis.fetch = realFetch; },
  };
}

/** What a call took: the time of the call, and the longest time that a timer of 10 ms was late while it ran. */
export interface Timing { ms: number; late: number }

export async function timed(run: () => Promise<unknown>): Promise<Timing> {
  const step = 10;
  const started = performance.now();
  let last = started;
  let late = 0;
  const timer = setInterval(() => { const now = performance.now(); late = Math.max(late, now - last - step); last = now; }, step);
  try { await run(); } finally { clearInterval(timer); }
  const ended = performance.now();
  return { ms: ended - started, late: Math.max(late, ended - last - step) };
}

/** One call with one input made long, and what it took. */
export interface Probe { tool: string; input: string; shape: string; length: number; timing: Timing; first: string; checked: boolean }

/**
 * Gives each string input of `tool`, one at a time, a text of each shape at each length of `lengths` (smallest first), and times the
 * calls. A shape stops at the first call above `stopAboveMs`: the probe for that input and shape is that call, else the last call.
 */
export async function probeTool(world: World, tool: string, options: { lengths: number[]; stopAboveMs: number; shapesOf?: (leaf: Leaf) => typeof SHAPES }): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (const leaf of stringLeaves(SNAPSHOT[tool].inputSchema)) {
    const shapes = options.shapesOf?.(leaf) ?? (checkedBySchema(leaf.schema) ? CHECKED_SHAPES : SHAPES);
    for (const base of variants(tool, leaf, baseArguments(tool, leaf, world))) {
      for (const shape of shapes) {
        for (const length of options.lengths) {
          let first = '';
          const timing = await timed(async () => { first = (await world.call(tool, withText(base, leaf, shape.make(length)))).split('\n')[0].slice(0, 160); });
          const probe = { tool, input: leaf.label, shape: shape.name, length, timing, first, checked: checkedBySchema(leaf.schema) };
          if (length === options.lengths[options.lengths.length - 1] || timing.ms > options.stopAboveMs) { probes.push(probe); break; }
        }
      }
    }
  }
  return probes;
}
