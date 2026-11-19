// packages/builder/test/uplc-node.test.ts
// The offline script evaluator of fixtures/uplc-node.fixture.ts is the one that Lucid itself requires, so that an offline verdict is the
// verdict of the evaluator that `localUPLCEval: true` runs, and never of another copy that the lockfile happens to hoist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { UPLC_PATH } from './fixtures/uplc-node.fixture.ts';

test('@lucid-evolution/uplc is loaded from where lucid resolves it, at the version lucid pins, not the copy nested under the wallet package', () => {
  const lucidDir = join(dirname(createRequire(import.meta.url).resolve('@lucid-evolution/lucid')), '..');
  const pinned = JSON.parse(readFileSync(join(lucidDir, 'package.json'), 'utf-8')).dependencies['@lucid-evolution/uplc'];
  const loaded = JSON.parse(readFileSync(join(dirname(UPLC_PATH), '..', '..', 'package.json'), 'utf-8'));
  assert.equal(loaded.name, '@lucid-evolution/uplc');
  assert.equal(loaded.version, pinned);
  assert.ok(!UPLC_PATH.includes(`${sep}wallet${sep}`), UPLC_PATH);
});
