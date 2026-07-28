import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The signer's security claim is that it CANNOT reach the network — not that it
// chooses not to. These assertions are that claim, mechanically enforced.
// Weakening them defeats the purpose of the package.

const PKG_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC_DIR = join(PKG_DIR, 'src');

const FORBIDDEN_IMPORTS = [
  '@apexfusion/vector-mcp-shared/provider',
  '@lucid-evolution/lucid',
  'cross-fetch',
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:tls',
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
const AMBIENT_NETWORK_GLOBALS: { label: string; pattern: RegExp }[] = [
  { label: 'fetch(...)', pattern: /\bfetch\s*\(/ },
  { label: 'new WebSocket', pattern: /\bnew\s+WebSocket\b/ },
  { label: 'new EventSource', pattern: /\bnew\s+EventSource\b/ },
  { label: 'new XMLHttpRequest', pattern: /\bnew\s+XMLHttpRequest\b/ },
  { label: 'navigator.sendBeacon', pattern: /\bnavigator\s*\.\s*sendBeacon\b/ },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  );
}

describe('signer has no network capability', () => {
  test('no source file imports a network-capable module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const bad of FORBIDDEN_IMPORTS) {
        if (text.includes(`'${bad}'`) || text.includes(`"${bad}"`)) {
          offenders.push(`${file} imports ${bad}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], `network-capable imports found:\n  ${offenders.join('\n  ')}`);
  });

  test('package.json declares no network-capable dependency', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const bad = declared.filter((d) => d === '@lucid-evolution/lucid' || d === 'cross-fetch');
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
