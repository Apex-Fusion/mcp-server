import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // es2022, not es2020 (Task 1's original value): index.ts uses a top-level
  // `await server.connect(...)` (brief's own given code, Task 7), and
  // top-level await is an ES2022 language feature — esbuild hard-errors
  // ("Top-level await is not available in the configured target environment")
  // rather than attempting an unsafe downlevel transform, unlike most other
  // modern syntax. Node 22 (this package's engines.node floor) natively
  // supports it. Scoped to the signer package only; the builder's own
  // tsup.config.ts is untouched because vector.ts/index.ts never uses
  // top-level await and has no need for the bump.
  target: "es2022",
  outDir: "build",
  clean: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});
