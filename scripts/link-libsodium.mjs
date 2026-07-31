#!/usr/bin/env node
/**
 * Cross-platform replacement for the old postinstall one-liner:
 *
 *   ln -sf ../../../libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs \
 *     node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs \
 *     2>/dev/null || true
 *
 * `ln -sf` has no reliable equivalent on stock Windows (symlinks need an elevated
 * privilege Windows does not grant by default), and the trailing `|| true` swallowed
 * that failure silently - `npm install` reported success while leaving a dangling
 * ESM import that only surfaces later as ERR_MODULE_NOT_FOUND at runtime, far from
 * the install step that actually caused it. This script COPIES the file instead
 * (identical result on every platform) and never swallows a genuine failure: it
 * exits non-zero and prints why whenever it cannot leave the tree in a working
 * state.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SOURCE = 'node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs';
const DEST = 'node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs';

if (!existsSync(SOURCE)) {
  console.error(
    `link-libsodium: source missing at "${SOURCE}" - is libsodium-sumo installed? Run npm install.`
  );
  process.exit(1);
}

if (existsSync(DEST) && readFileSync(DEST).equals(readFileSync(SOURCE))) {
  console.log(`link-libsodium: "${DEST}" already matches the source, nothing to do.`);
  process.exit(0);
}

if (!existsSync(dirname(DEST))) {
  console.error(
    `link-libsodium: destination directory missing at "${dirname(DEST)}" - is libsodium-wrappers-sumo installed correctly? Run npm install.`
  );
  process.exit(1);
}

try {
  copyFileSync(SOURCE, DEST);
} catch (err) {
  console.error(`link-libsodium: failed to copy "${SOURCE}" to "${DEST}": ${err.message}`);
  process.exit(1);
}

console.log(`link-libsodium: copied "${SOURCE}" to "${DEST}".`);
