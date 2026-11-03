// packages/builder/test/agent-network-tools.test.ts
// Handler-level tests of vector_resolve_did, vector_get_agent_profile and vector_discover_agents: a minimal fake server captures
// the handlers, global fetch is stubbed (the identity gateway and the marketplace indexer), and the legacy registry reads go to a
// FixtureProvider. No network.
import { describe, test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressDetails } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgentNetworkTools } from '../src/vector/agent-network.ts';
import { RateLimiter } from '../src/vector/rate-limiter.ts';
import { INDEXER_URL } from '../src/vector/marketplace-constants.ts';
import { DEFAULT_IDENTITY_GATEWAY_URL, identityGatewayUrl } from '../src/vector/identity-gateway.ts';
import { LEGACY_REGISTRY_DEPOSIT, LEGACY_REGISTRY_POLICY_ID, legacyRegistryAddress, legacyDid } from '../src/vector/legacy-registry.ts';
import { legacyAgentDatum } from './fixtures/legacy-datum.ts';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const serverOf = (into: Map<string, Handler>) => ({ tool: (name: string, _d: string, _s: unknown, handler: Handler) => { into.set(name, handler); } }) as unknown as McpServer;

const VECTOR_ID = '3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b';
const DID = `did:vector:${VECTOR_ID}`;
const CONTROLLER = 'aa'.repeat(28);
const LISTED = 'bb'.repeat(28);
const RESULT = {
  didDocument: {
    '@context': 'https://www.w3.org/ns/did/v1.1',
    id: DID,
    verificationMethod: [
      { id: `${DID}#${CONTROLLER}`, type: 'Multikey', controller: DID, publicKeyMultibase: 'z6MkController' },
      { id: `${DID}#${LISTED}`, type: 'Multikey', controller: DID, publicKeyMultibase: 'z6MkListed' },
    ],
    capabilityInvocation: [`#${CONTROLLER}`],
    authentication: [`#${LISTED}`],
    assertionMethod: [`#${LISTED}`],
  },
  didResolutionMetadata: { contentType: 'application/did' },
  didDocumentMetadata: {
    canonicalId: DID, created: '2026-11-03T10:00:00Z', versionId: '0', vectorOrigin: 'native',
    vectorStatus: { status: 'active', effective: 'active' },
    vectorKeys: [{ id: `#${LISTED}`, type: 'Ed25519', purposes: ['authentication', 'assertion', 'transaction'] }],
    vectorProfile: { name: 'OCR agent', description: 'Reads ``` scans', framework: 'custom', endpoint: 'https://ocr.example', capabilities: ['ocr.page.extract.v1'], createdAt: '2026-11-03T10:00:00Z' },
    vectorLedger: { txId: 'cc'.repeat(32), outputIndex: 0, blockHash: 'dd'.repeat(32), blockHeight: 100, slot: 1000, confirmations: 42 },
  },
};
const errorResult = (name: string, title: string) =>
  ({ didDocument: null, didResolutionMetadata: { error: { type: `https://www.w3.org/ns/did#${name}`, title } }, didDocumentMetadata: {} });

interface Answer { status?: number; body?: string; fails?: Error }
let gateway: Answer = {};
let suppliers: Answer = {};
let requested: Array<{ url: string; accept: string | null }> = [];
const realFetch = globalThis.fetch;
before(() => {
  delete process.env.VECTOR_IDENTITY_GATEWAY_URL;
});
afterEach(() => { globalThis.fetch = realFetch; requested = []; });
function stub() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url, accept: new Headers(init?.headers).get('accept') });
    const answer = url.startsWith(`${INDEXER_URL}/suppliers`) ? suppliers : url.startsWith(DEFAULT_IDENTITY_GATEWAY_URL) ? gateway : { status: 500, body: '{"unexpected":true}' };
    if (answer.fails) throw answer.fails;
    return new Response(answer.body ?? '', { status: answer.status ?? 200 });
  }) as typeof fetch;
}

const OWN_KEY = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
const LEGACY_NAME = 'ab'.repeat(32);
const LEGACY_UTXO = {
  txHash: 'cd'.repeat(32), outputIndex: 0, address: legacyRegistryAddress(),
  assets: { lovelace: LEGACY_REGISTRY_DEPOSIT, [`${LEGACY_REGISTRY_POLICY_ID}${LEGACY_NAME}`]: 1n },
  datum: legacyAgentDatum(OWN_KEY, 'LegacyAgent', 'a legacy record', ['testing'], 'custom', '', 1750000000000),
};

function tools(limiter: Pick<RateLimiter, 'check'> = new RateLimiter(100_000)) {
  const handlers = new Map<string, Handler>();
  registerAgentNetworkTools(serverOf(handlers), 'agent-network-test', () => new FixtureProvider([...FIXTURE_UTXOS, LEGACY_UTXO]), limiter);
  return async (name: string, args: Record<string, unknown>) => (await handlers.get(name)!(args)).content[0].text;
}
const call = tools();

describe('vector_resolve_did', () => {
  test('asks the gateway for the DID with the resolution media type and returns the HTTP status and the result unchanged', async () => {
    const body = JSON.stringify(RESULT);
    gateway = { status: 200, body };
    stub();
    const t = await call('vector_resolve_did', { did: DID });
    assert.deepStrictEqual(requested, [{ url: `${DEFAULT_IDENTITY_GATEWAY_URL}/1.0/identifiers/${DID}`, accept: 'application/did-resolution' }]);
    assert.match(t, /\*\*HTTP status:\*\* 200 \(effective status active\)/);
    assert.ok(t.includes(`\n${body}\n`), 'the body is carried verbatim');
    assert.ok(t.includes('````json\n'), 'a body that holds ``` gets a longer fence');
  });

  test('passes the legacy form and the version options; the DID stays one path segment', async () => {
    gateway = { status: 200, body: JSON.stringify(RESULT) };
    stub();
    await call('vector_resolve_did', { did: legacyDid(VECTOR_ID), versionId: '2' });
    await call('vector_resolve_did', { did: DID, versionTime: '2026-11-03T10:00:00Z' });
    await call('vector_resolve_did', { did: 'did:vector:x/../healthz?a=b#c' });
    assert.deepStrictEqual(requested.map((r) => r.url), [
      `${DEFAULT_IDENTITY_GATEWAY_URL}/1.0/identifiers/${legacyDid(VECTOR_ID)}?versionId=2`,
      `${DEFAULT_IDENTITY_GATEWAY_URL}/1.0/identifiers/${DID}?versionTime=2026-11-03T10%3A00%3A00Z`,
      `${DEFAULT_IDENTITY_GATEWAY_URL}/1.0/identifiers/did:vector:x%2F..%2Fhealthz%3Fa%3Db%23c`,
    ]);
  });

  test('an error result is an answer too: its status and its error are shown with the result', async () => {
    gateway = { status: 404, body: JSON.stringify(errorResult('NOT_FOUND', 'No record')) };
    stub();
    const t = await call('vector_resolve_did', { did: DID });
    assert.match(t, /\*\*HTTP status:\*\* 404 \(NOT_FOUND: No record\)/);
  });

  test('says clearly when there is no resolution result, and never names the gateway', async () => {
    const cases: Array<[Answer, RegExp]> = [
      [{ fails: new TypeError(`fetch failed ${DEFAULT_IDENTITY_GATEWAY_URL}`) }, /could not be reached \(network error or timeout\)/],
      [{ status: 502, body: '<html>bad gateway id.vector.apexfusion.org</html>' }, /answered HTTP 502 without a resolution result/],
      [{ status: 200, body: '{"status":"ok"}' }, /answered HTTP 200 with JSON that is not a DID resolution result/],
      [{ status: 200, body: 'x'.repeat(1024 * 1024 + 1) }, /answer is over 1048576 bytes/],
    ];
    for (const [answer, expected] of cases) {
      gateway = answer;
      stub();
      const t = await call('vector_resolve_did', { did: DID });
      assert.match(t, /^Failed to resolve DID: /);
      assert.match(t, expected);
      assert.ok(!t.includes('id.vector.apexfusion.org'), t);
    }
  });

  test('the gateway URL comes from VECTOR_IDENTITY_GATEWAY_URL, without trailing slashes', () => {
    assert.equal(identityGatewayUrl(undefined), DEFAULT_IDENTITY_GATEWAY_URL);
    assert.equal(identityGatewayUrl(''), DEFAULT_IDENTITY_GATEWAY_URL);
    assert.equal(identityGatewayUrl('https://gw.example/base//'), 'https://gw.example/base');
  });

  test('is rate limited before any request', async () => {
    stub();
    const spent = tools({ check: () => ({ allowed: false, retryAfterMs: 1234 }) });
    assert.match(await spent('vector_resolve_did', { did: DID }), /Rate limit exceeded/);
    assert.equal(requested.length, 0);
  });
});

describe('vector_get_agent_profile', () => {
  test('a canonical DID goes through the gateway: profile, effective status, keys and record output', async () => {
    gateway = { status: 200, body: JSON.stringify(RESULT) };
    stub();
    const t = await call('vector_get_agent_profile', { agent_id: DID });
    assert.equal(requested.length, 1);
    assert.match(t, /\*\*Effective status:\*\* active\n/);
    assert.match(t, /\*\*Name:\*\* OCR agent/);
    assert.match(t, /- ocr\.page\.extract\.v1/);
    assert.match(t, new RegExp(`- \`#${CONTROLLER}\` key, controller key \\(z6MkController\\)`));
    assert.match(t, new RegExp(`- \`#${LISTED}\` Ed25519: authentication, assertion, transaction \\(z6MkListed\\)`));
    assert.match(t, new RegExp(`\\*\\*Record output:\\*\\* ${'cc'.repeat(32)}#0 \\(42 confirmations\\)`));
    const json = JSON.parse(t.slice(t.lastIndexOf('```json\n') + 8, t.lastIndexOf('\n```')));
    assert.equal(json.origin, 'native');
    assert.deepStrictEqual(json.keys.map((k: { id: string; controller: boolean }) => [k.id, k.controller]), [[`#${CONTROLLER}`, true], [`#${LISTED}`, false]]);
  });

  test('a deactivated DID shows as such, with its listed keys and no document', async () => {
    const meta = { ...RESULT.didDocumentMetadata, deactivated: true, vectorStatus: { status: 'revoked', effective: 'revoked' } };
    gateway = { status: 410, body: JSON.stringify({ didDocument: null, didResolutionMetadata: {}, didDocumentMetadata: meta }) };
    stub();
    const t = await call('vector_get_agent_profile', { agent_id: DID });
    assert.match(t, /\*\*Effective status:\*\* revoked - the DID is deactivated/);
    assert.match(t, new RegExp(`- \`#${LISTED}\` Ed25519: authentication, assertion, transaction\n`));
  });

  test('a canonical DID the gateway does not know is not found; a gateway error says so', async () => {
    gateway = { status: 404, body: JSON.stringify(errorResult('NOT_FOUND', 'No record')) };
    stub();
    assert.match(await call('vector_get_agent_profile', { agent_id: DID }), /^Agent not found: NOT_FOUND: No record\./);
    gateway = { status: 500, body: JSON.stringify(errorResult('INTERNAL_ERROR', 'ledger read failed')) };
    stub();
    assert.match(await call('vector_get_agent_profile', { agent_id: DID }), /^Failed to get agent profile: the identity gateway answered HTTP 500 \(INTERNAL_ERROR: ledger read failed\)/);
  });

  test('a legacy DID keeps reading the legacy registry, without the gateway', async () => {
    stub();
    const t = await call('vector_get_agent_profile', { agent_id: legacyDid(LEGACY_NAME) });
    assert.equal(requested.length, 0);
    assert.match(t, /^# Agent Profile/);
    assert.match(t, /\*\*Name:\*\* LegacyAgent/);
    assert.match(t, new RegExp(`\\*\\*Registry UTxO:\\*\\* ${'cd'.repeat(32)}#0`));
  });

  test('anything else is refused, naming both forms, with no request', async () => {
    stub();
    for (const agent_id of [`did:vector:${VECTOR_ID.toUpperCase()}`, 'did:web:example.com', 'nonsense']) {
      assert.match(await call('vector_get_agent_profile', { agent_id }), /is not a did:vector DID\. Expected did:vector:<64 hex> \(canonical\) or did:vector:agent:/);
    }
    assert.equal(requested.length, 0);
  });
});

describe('vector_discover_agents', () => {
  const row = (over: Record<string, unknown>) => ({ utxo_ref: 'ee'.repeat(32) + '#0', supplier_pkh: 'f1'.repeat(28), capability_id: 'llm.chat.v1', model: 'm', max_output_tokens: 1, max_processing_ms: 1, price_lovelace: '1', supplier_bond_lovelace: '1', buyer_bond_lovelace: '1', endpoint_url: 'https://s.example/x', detail_uri: '', detail_hash: '', advertised_at: 1, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: null, created_slot: 1, ...over });
  const ROWS = [
    row({ utxo_ref: '01'.repeat(32) + '#0', agent_id: VECTOR_ID, capability_id: 'llm.chat.v1' }),
    row({ utxo_ref: '02'.repeat(32) + '#0', agent_id: VECTOR_ID, capability_id: 'ocr.page.extract.v1' }),
    row({ utxo_ref: '03'.repeat(32) + '#0', agent_id: null, supplier_pkh: 'f2'.repeat(28), capability_id: 'audio.synthesize.piper.v1' }),
    row({ utxo_ref: '04'.repeat(32) + '#0', agent_id: 'ABC', supplier_pkh: 'f3'.repeat(28), capability_id: 'demo.text.stats.v1' }),
  ];

  test('reads only the indexer\'s listed adverts and groups them by agent; a legacy advert has no DID', async () => {
    suppliers = { status: 200, body: JSON.stringify(ROWS) };
    stub();
    const t = await call('vector_discover_agents', {});
    assert.deepStrictEqual(requested.map((r) => r.url), [`${INDEXER_URL}/suppliers`]);
    assert.match(t, /Found \*\*3\*\* agents among the listed adverts/);
    assert.match(t, new RegExp(`### 1\\. ${DID}\n\\*\\*Capabilities:\\*\\* llm\\.chat\\.v1, ocr\\.page\\.extract\\.v1`));
    assert.match(t, new RegExp(`### 2\\. No DID \\(legacy advert of key ${'f2'.repeat(28)}\\)`));
    assert.match(t, new RegExp(`### 3\\. No DID \\(legacy advert of key ${'f3'.repeat(28)}\\)`), 'a malformed agent_id is not made into a DID');
    const json = JSON.parse(t.slice(t.lastIndexOf('```json\n') + 8, t.lastIndexOf('\n```')));
    assert.deepStrictEqual(json.map((a: { did: string | null }) => a.did), [DID, null, null]);
  });

  test('filters by a capability substring, any case, and caps the number of agents', async () => {
    suppliers = { status: 200, body: JSON.stringify(ROWS) };
    stub();
    const t = await call('vector_discover_agents', { capability: 'OCR' });
    assert.match(t, /Found \*\*1\*\* agent with a capability matching "OCR"/);
    assert.ok(!t.includes('llm.chat.v1'), 'only the matching adverts');
    assert.match(await call('vector_discover_agents', { limit: 1 }), /Found \*\*1\*\* agent among/);
    assert.match(await call('vector_discover_agents', { capability: 'nothing-like-this' }), /^No listed agents found with a capability matching "nothing-like-this"\./);
  });

  test('an indexer failure is reported without the indexer URL', async () => {
    suppliers = { status: 503, body: 'down' };
    stub();
    const t = await call('vector_discover_agents', {});
    assert.match(t, /^Failed to discover agents: list suppliers: indexer answered 503/);
    assert.ok(!t.includes(INDEXER_URL));
  });
});
