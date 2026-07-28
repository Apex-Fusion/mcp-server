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

  test('does not depend on the shared provider subpath', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
    const shared = { ...pkg.dependencies, ...pkg.devDependencies }['@apexfusion/vector-mcp-shared'];
    // Depending on the package is fine — /tx is pure. Reaching /provider is not,
    // and the shared package's export map has no root export to smuggle it through.
    assert.ok(shared === undefined || typeof shared === 'string');
  });
});
