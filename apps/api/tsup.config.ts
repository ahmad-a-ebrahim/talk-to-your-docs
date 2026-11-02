import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them in; every real npm package
  // (including the db package's drizzle-orm/postgres) is loaded from node_modules at runtime.
  skipNodeModulesBundle: true,
  noExternal: [/^@ttyd\//],
});
