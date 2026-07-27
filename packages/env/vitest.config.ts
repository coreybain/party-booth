import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "env",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
