import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agent-tab/shared": src("./packages/shared/src/index.ts"),
      "@agent-tab/client": src("./packages/client/src/index.ts"),
      "@agent-tab/server": src("./packages/server/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
