import { defineConfig } from 'vitest/config';

// Two projects:
//  - unit:        pure domain logic, no infrastructure needed
//  - integration: needs Postgres + Redis (see README → "Running tests")
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'services/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/*.int.test.ts', 'services/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Note: `fileParallelism` is ignored inside a project. Integration files run one at a
          // time via the --no-file-parallelism flag in the test:integration npm script.
        },
      },
    ],
  },
});
