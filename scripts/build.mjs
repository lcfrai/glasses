import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('../public/app.jsx', import.meta.url))],
  outfile: fileURLToPath(new URL('../public/app.js', import.meta.url)),
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('Glasses workbench built.');
