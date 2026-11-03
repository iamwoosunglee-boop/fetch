import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['server/*.test.ts'], testTimeout: 10_000 },
});
