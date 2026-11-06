import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests against a real Postgres (TEST_DATABASE_URL). Files run one
// at a time because each test resets the shared schema.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.db.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    fileParallelism: false,
  },
});
