import { buildLocales } from './locales.mjs';
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await cp('LICENSE', 'dist/LICENSE');
await buildLocales();
await build({
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/offscreen.ts', 'src/popup.ts', 'src/options.ts'],
  outdir: 'dist', bundle: true, target: 'chrome116', format: 'iife',
  sourcemap: false, minify: false, legalComments: 'none'
});
console.log('ECLIRIM → dist/ (Chrome 116+, Manifest V3)');
