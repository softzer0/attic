import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      nestjs: "src/nestjs/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    outDir: "dist",
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    entry: {
      "generator/cli": "src/generator/cli.ts",
      "generator/migrate-cli": "src/generator/migrate-cli.ts",
    },
    format: ["cjs"],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
    outExtension: () => ({ js: ".cjs" }),
  },
]);
