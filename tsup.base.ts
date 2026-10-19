import { defineConfig } from 'tsup';

/** Shared build config: each service bundles its own code + @showtime/common into dist/index.js. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  // Our shared package is bundled in; third-party packages stay in node_modules.
  noExternal: ['@showtime/common'],
  skipNodeModulesBundle: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
