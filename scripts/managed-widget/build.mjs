import { build } from 'esbuild';

// Deliberately outside public/: the legacy deployment never serves this artifact.
await build({
  entryPoints: ['src/widget/managed/index.ts'],
  outfile: 'dist/managed-widget/widget.managed.v1.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
});
