// Vitest Configuration
//
// ES-module project (package.json has "type": "module"). Vitest runs the
// TypeScript sources directly via its Vite pipeline, so no separate
// compilation step is needed for tests.
//
// Test files: src/ (recursive, .test.ts)
// Coverage:   src/ (recursive, excluding node_modules, dist, test files)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // ES module + TypeScript support is built into Vitest via Vite.
  test: {
    // Match test files anywhere under src/.
    include: ['src/**/*.test.ts'],
    // Use the node environment (file system, streams, etc.).
    environment: 'node',
    // Run test files sequentially to avoid concurrent lock contention on embedded KuzuDB.
    fileParallelism: false,
    // Enable global APIs (describe/it/expect) alongside explicit imports.
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'node_modules/**',
        'dist/**',
        'frontend/**',
      ],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
