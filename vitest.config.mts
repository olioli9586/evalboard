import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // *.db.test.ts need Postgres: `npm run test:db`.
    exclude: ["node_modules/**", ".next/**", "**/*.db.test.ts"],
  },
});
