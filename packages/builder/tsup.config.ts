import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2020",
  outDir: "build",
  clean: true,
  splitting: false,
  noExternal: ["@apexfusion/vector-mcp-shared"],
  banner: { js: "#!/usr/bin/env node" },
});
