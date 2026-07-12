import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 70,
        lines: 75,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/generator/cli.ts", "src/generator/migrate-cli.ts", "src/**/index.ts"],
    },
  },
});
