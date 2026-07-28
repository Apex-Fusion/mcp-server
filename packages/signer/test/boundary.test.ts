import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// This is a text scan over src/'s import graph, package.json's declared
// dependencies, and a fixed list of ambient-global patterns — not a sandbox,
// and not a proof that no sequence of JavaScript could ever reach the
// network from this package. What it reliably catches: an accidentally
// added network-capable dependency, a forgotten forbidden import, an
// unthinking `fetch(...)` call — the shape of mistake code review can miss
// but a mechanical check cannot. What it does not catch: deliberate
// obfuscation. A reference to an ambient global reached through an alias
// (`const f = fetch; f(...)`) or a module specifier assembled at runtime
// from concatenated strings (`import('node:' + 'dns')`) defeats a text scan
// by construction — closing every such route is not a fixed-pattern problem,
// so it is not this file's job. Catching deliberate evasion is a code-review
// responsibility; this file's job is to make the accidental and the casual
// loud and immediate. See the README for the specific evasions verified
// against this file. Within that narrower, accurate scope, weakening these
// assertions — narrowing FORBIDDEN_IMPORTS, loosening a pattern, deleting a
// check — still defeats the purpose they do serve.

const PKG_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC_DIR = join(PKG_DIR, 'src');

const FORBIDDEN_IMPORTS = [
  '@apexfusion/vector-mcp-shared/provider',
  '@lucid-evolution/lucid',
  'cross-fetch',
  'node:http',
  'node:https',
  // Same network-transport class as http/https above, different protocol
  // version.
  'node:http2',
  'node:net',
  'node:dgram',
  'node:tls',
  // A DNS lookup is network I/O in its own right, not merely a step before
  // some other request — and a well-known covert exfiltration channel (DNS
  // tunneling) even with no HTTP client available at all.
  'node:dns',
  'node:dns/promises',
  // Reaching the network by shelling out (execSync('curl ...')) bypasses every
  // other assertion here, so the process-spawning modules are forbidden too.
  'node:child_process',
  'child_process',
  // Same reasoning as child_process just above: both are general
  // code-execution primitives that can run a separate script (a worker's
  // entry file, or a string handed to vm.Script/vm.runInNewContext) outside
  // this file's own source text — precisely what an import-graph scan
  // cannot see into.
  'node:worker_threads',
  'node:vm',
  // Opens a debugger port.
  'node:inspector',
];

const SHARED_PKG = '@apexfusion/vector-mcp-shared';
// /tx and /types are pure. /provider is network-capable. /config is deliberately
// excluded too: it carries network endpoint URLs the signer has no use for and
// should not be reaching into. A bare root import (no subpath at all) is excluded
// as well. This is an allowlist, not a denylist — anything not named here fails,
// including forms nobody has thought to forbid yet.
const ALLOWED_SHARED_SUBPATHS = [`${SHARED_PKG}/tx`, `${SHARED_PKG}/types`];

// fetch, WebSocket, EventSource, XMLHttpRequest, and navigator.sendBeacon are
// globals in Node 22 — no import statement exists for them, so the import-graph
// scan above is structurally blind to their use. These patterns are matched with
// word boundaries so they don't false-positive on legitimate identifiers like a
// variable named `prefetchCount`.
//
// Every pattern below this comment requires the global's BARE identifier
// (`fetch`, `WebSocket`, ...) to appear, and most require it to be called or
// constructed immediately. Both are one-line evasions: `globalThis['fetch']`
// never spells the bare word `fetch` followed by `(`, and neither does
// `(0, globalThis.fetch)(...)` — the comma-operator trick (used to strip
// `this` binding so a borrowed method doesn't throw on an unexpected
// receiver) puts a `)` between `fetch` and the call parens that actually
// invoke it. Both still name `globalThis` and the target property, though —
// just via a different route to the same runtime object — so that route is
// checked for directly below: dot notation and bracket notation (the latter
// is literally "computed member access", the formal name for what
// `obj[expr]` is), covering both quoting styles quotedForms() above exists
// to handle. This still only recognises the literal text `globalThis` — a
// further level of indirection (aliasing globalThis to another name first,
// or building the property name from concatenated substrings the way
// FORBIDDEN_IMPORTS's own dynamic-`import()` gap allows, see the README) is
// the kind of arbitrary obfuscation this file does not attempt to defeat.
function globalThisQualifiedAccess(name: string): RegExp {
  return new RegExp(`\\bglobalThis\\s*(?:\\.\\s*${name}\\b|\\[\\s*['"\`]${name}['"\`]\\s*\\])`);
}

const AMBIENT_NETWORK_GLOBALS: { label: string; pattern: RegExp }[] = [
  { label: 'fetch(...)', pattern: /\bfetch\s*\(/ },
  { label: 'new WebSocket', pattern: /\bnew\s+WebSocket\b/ },
  { label: 'new EventSource', pattern: /\bnew\s+EventSource\b/ },
  { label: 'new XMLHttpRequest', pattern: /\bnew\s+XMLHttpRequest\b/ },
  { label: 'navigator.sendBeacon', pattern: /\bnavigator\s*\.\s*sendBeacon\b/ },
  { label: `navigator['sendBeacon']`, pattern: /\bnavigator\s*\[\s*['"`]sendBeacon['"`]\s*\]/ },
  { label: `globalThis.fetch / globalThis['fetch']`, pattern: globalThisQualifiedAccess('fetch') },
  { label: `globalThis.WebSocket / globalThis['WebSocket']`, pattern: globalThisQualifiedAccess('WebSocket') },
  { label: `globalThis.EventSource / globalThis['EventSource']`, pattern: globalThisQualifiedAccess('EventSource') },
  {
    label: `globalThis.XMLHttpRequest / globalThis['XMLHttpRequest']`,
    pattern: globalThisQualifiedAccess('XMLHttpRequest'),
  },
];

// Any module format that Node can execute, not just .ts — a stray .js or .mjs
// under src/ would otherwise be invisible to every scan below.
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : SOURCE_EXTENSIONS.some((ext) => e.name.endsWith(ext))
        ? [join(dir, e.name)]
        : []
  );
}

// Module specifiers can be single-, double-, or backtick-quoted. Matching only
// the first two left a trivial evasion.
function quotedForms(specifier: string): string[] {
  return [`'${specifier}'`, `"${specifier}"`, `\`${specifier}\``];
}

describe('signer has no network capability', () => {
  test('no source file imports a network-capable module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const bad of FORBIDDEN_IMPORTS) {
        if (quotedForms(bad).some((form) => text.includes(form))) {
          offenders.push(`${file} imports ${bad}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], `network-capable imports found:\n  ${offenders.join('\n  ')}`);
  });

  test('package.json declares no network-capable dependency', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
    // All four dependency kinds — optional and peer deps install too.
    const declared = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    });
    const NETWORK_PACKAGES = [
      '@lucid-evolution/lucid',
      'cross-fetch',
      'axios',
      'node-fetch',
      'undici',
      'got',
      'ky',
      'superagent',
      'request',
      'ws',
      'socket.io-client',
      'eventsource',
    ];
    const bad = declared.filter((d) => NETWORK_PACKAGES.includes(d));
    assert.deepStrictEqual(bad, [], `network-capable dependencies declared: ${bad.join(', ')}`);
  });

  test('only imports the shared package via an allowed pure subpath', () => {
    const specifierPattern = new RegExp(`['"](${SHARED_PKG}(?:/[^'"]*)?)['"]`, 'g');
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(specifierPattern)) {
        const specifier = match[1];
        if (!ALLOWED_SHARED_SUBPATHS.includes(specifier)) {
          offenders.push(`${file} imports '${specifier}'`);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], `disallowed shared-package specifier found:\n  ${offenders.join('\n  ')}`);
  });

  test('no source file uses an ambient network global', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const { label, pattern } of AMBIENT_NETWORK_GLOBALS) {
        if (pattern.test(text)) {
          offenders.push(`${file} uses ${label}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], `ambient network globals found:\n  ${offenders.join('\n  ')}`);
  });
});
