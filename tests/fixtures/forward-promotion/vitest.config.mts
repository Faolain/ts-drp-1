import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../../vite.config.mjs';
export default defineConfig({ resolve: { alias: workspaceAliases }, test: {
  include: ['tests/phase-5e-creator-close-red.test.ts'], testTimeout: 90000, hookTimeout: 90000,
  fileParallelism: false, maxWorkers: 1, minWorkers: 1, retry: 0, coverage: { enabled: false }
} });
