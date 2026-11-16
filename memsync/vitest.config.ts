import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The default forks/threads pools fail to share the runner context with
    // test modules on Node >= 24 ("reading 'config'"); the VM pools keep the
    // runner and the collected module in one context.
    pool: "vmForks",
    // Integration tests spawn real git processes; under parallel file
    // execution the 5s default is too tight for the slowest governance flow.
    testTimeout: 15_000,
  },
});
