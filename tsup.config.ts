import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2020",
  outDir: "build",
  clean: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});
