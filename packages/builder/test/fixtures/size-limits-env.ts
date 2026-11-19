// packages/builder/test/fixtures/size-limits-env.ts
//
// The first import of size-limits-world.ts. It sets the environment that the modules of the builder read when they load (the rate limit
// of a caller), before any of them is loaded. The deployments are set in openWorld: the tools read them at their first call.
// A test file runs in its own process, so this changes no other test.

// Thousands of calls come from one caller: the limit of a caller must not answer in the place of a tool.
process.env.VECTOR_RATE_LIMIT_PER_MINUTE = '1000000';
