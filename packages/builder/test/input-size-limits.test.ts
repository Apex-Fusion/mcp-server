// packages/builder/test/input-size-limits.test.ts
// Every tool answers in bounded time for the largest input that the server accepts. The server reads at most 131,072 bytes of a request
// (read-body.ts), so no text of a request is longer than 131,072 characters. For each tool of the schema snapshot and each string input of
// it (also the strings in arrays and objects, and the keys of maps), this test sends a text of that size in several shapes (letters, hex
// digits, decimal digits, base58 characters, an address prefix, JSON, CBOR) with valid values for the other inputs, to the tools as the
// SDK runs them (the input schema first). The node answers at once, so the time of a call is the time that the server needs for the text.
// A call must end within one second, and a timer that is set before the call must fire on time. The sizes grow in steps and a shape stops
// at the first call above the limit, so that a tool that takes too long fails the test within seconds. The smallest size, 1,024
// characters, is the longest text that the address check gives to Lucid. Each input also gets JSON with lists in lists and maps in maps,
// at 2,048 and 4,096 characters and at the largest size: the time for such a text can grow with its levels, and not only with its length.
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL_SHAPES, SNAPSHOT, baseArguments, openWorld, probeTool } from './fixtures/size-limits-world.ts';
import type { Probe, World } from './fixtures/size-limits-world.ts';

const LIMIT_MS = 1000;
const LENGTHS = [1_024, 65_536, 131_072];
const LEVEL_LENGTHS = [2_048, 4_096, 131_072];

let world: World;
before(async () => {
  mock.method(console, 'error', () => undefined); // the node client writes a line for each answer that is not a result
  world = await openWorld();
});
after(async () => { await world.close(); mock.restoreAll(); });

const describeProbe = (p: Probe): string => `${p.input} with ${p.shape}, ${p.length} characters: ${Math.round(p.timing.ms)} ms (a timer was ${Math.round(p.timing.late)} ms late); answer: ${p.first}`;

/**
 * The tools that the configuration of this world does not reach: the jury and Module-1 manifests name the identity registry of mainnet, and
 * the server refuses them next to the identity registry of the fixtures (size-limits-world.ts). Their only string input without a bound in
 * the schema is the change address, and jury-tools.test.ts gives it a text of 131,072 characters in each of them.
 */
const NOT_CONFIGURED = /^vector_(?:build_jury_|build_module1_|get_jury)/;

describe('the tools of the snapshot', () => {
  test('are the tools that the server registers', async () => {
    assert.deepEqual((await world.tools()).sort(), Object.keys(SNAPSHOT).sort());
    assert.equal(Object.keys(SNAPSHOT).length, 74);
  });

  test('are all answered by the tool itself for valid values: the configuration, the rate limit and the input schema do not stop a call', async () => {
    const stopped: string[] = [];
    for (const tool of Object.keys(SNAPSHOT).filter((name) => !NOT_CONFIGURED.test(name))) {
      const answer = await world.call(tool, baseArguments(tool, undefined, world));
      if (/is not configured|Rate limit exceeded|Input validation error/.test(answer)) stopped.push(`${tool}: ${answer.split('\n')[0].slice(0, 140)}`);
    }
    assert.deepEqual(stopped, []);
  });

  for (const tool of Object.keys(SNAPSHOT)) {
    test(`${tool}: each string input, at the largest size, is answered within ${LIMIT_MS} ms`, async () => {
      const probes = [
        ...await probeTool(world, tool, { lengths: LENGTHS, stopAboveMs: LIMIT_MS }),
        ...await probeTool(world, tool, { lengths: LEVEL_LENGTHS, stopAboveMs: LIMIT_MS, shapesOf: () => LEVEL_SHAPES }),
      ];
      assert.ok(probes.length > 0 || Object.keys(SNAPSHOT[tool].inputSchema.properties ?? {}).length === 0, 'the tool has string inputs, and the test sent a text to each');
      assert.deepEqual(probes.filter((p) => p.timing.ms > LIMIT_MS || p.timing.late > LIMIT_MS).map(describeProbe), []);
      // A call that the rate limit or the input schema answers does not show what the tool does with the text: the other values are valid.
      assert.deepEqual(probes.filter((p) => !p.checked && /Rate limit exceeded|Input validation error/.test(p.first)).map(describeProbe), []);
    });
  }
});
