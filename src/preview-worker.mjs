import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import { canvasBridge } from './canvas-bridge.mjs';
import { REVIEWED_IMPORTS } from './workspace.mjs';
import { themeTokens } from './theme-tokens.mjs';

// Receive data before loading native libraries. This file runs only in a forked
// compiler process; candidate JavaScript is bundled, never executed here.
const workerData = await new Promise(resolve => process.once('message', resolve));
let stopCompiler;
async function finish(result) {
  stopCompiler?.();
  await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()));
  process.disconnect();
  process.exit(0);
}
const imports = new Set();
const allow = new Set(REVIEWED_IMPORTS);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const files = new Map(workerData.files.map(file => [file.path, file.content]));
const safeProps = workerData.propsJSON.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function resolveFile(request, importer) {
  const candidate = request.startsWith('@/') ? request.slice(2) : posix.normalize(posix.join(posix.dirname(importer), request));
  if (candidate.startsWith('../') || candidate.startsWith('/')) return null;
  const alternatives = [candidate, ...['.tsx', '.ts', '.jsx', '.js', '.json', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'].map(extension => candidate + extension)];
  // Resolve aliases only against supplied files; never read arbitrary host project files.
  for (const value of alternatives) {
    if (files.has(value)) return value;
    if (request.startsWith('@/')) {
      const matches = [...files.keys()].filter(path => path.endsWith('/' + value));
      if (matches.length === 1) return matches[0];
    }
  }
  return null;
}
try {
  const [{ build, stop }, { compile: compileTailwind }, { Scanner }] = await Promise.all([import('esbuild'), import('@tailwindcss/node'), import('@tailwindcss/oxide')]);
  stopCompiler = stop;
  const result = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Candidate from 'glasses:candidate';
      class Boundary extends React.Component {constructor(p){super(p);this.state={error:null}}static getDerivedStateFromError(e){return {error:String(e.message||e)}}render(){return this.state.error?React.createElement('pre',{role:'alert',style:{padding:24,whiteSpace:'pre-wrap',color:'#b42318'}},'Preview error: '+this.state.error):this.props.children}}
      createRoot(document.getElementById('root')).render(React.createElement(Boundary,null,React.createElement(Candidate,${safeProps})));
      ${workerData.editor ? `(${canvasBridge.toString()})();` : ''}`,
      sourcefile: 'entry.jsx', resolveDir: projectRoot, loader: 'jsx' },
    bundle: true, write: false, outfile: 'preview.js', format: 'iife', platform: 'browser', target: ['es2022'], minify: true,
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    inject: ['glasses:react-inject'],
    plugins: [{ name: 'candidate-import-boundary', setup(b) {
      b.onResolve({ filter: /^glasses:/ }, args => args.path === 'glasses:candidate' ? { path: workerData.entryPath, namespace: 'workspace' } : { path: args.path, namespace: 'glasses' });
      b.onLoad({ filter: /^glasses:react-inject$/, namespace: 'glasses' }, () => ({ contents: "export {default as React} from 'react';", loader: 'js', resolveDir: projectRoot }));
      b.onLoad({ filter: /.*/, namespace: 'workspace' }, args => {
        const content = files.get(args.path), extension = posix.extname(args.path).slice(1);
        if (extension === 'css' && /@import|@plugin|@config|@source|url\s*\(/i.test(content)) return { errors: [{ text: 'Workspace CSS cannot import styles, plugins, files or URL resources.' }] };
        return { contents: content, loader: { tsx: 'tsx', ts: 'ts', jsx: 'jsx', js: 'jsx', css: 'css', json: 'json' }[extension], resolveDir: projectRoot };
      });
      b.onResolve({ filter: /.*/, namespace: 'workspace' }, args => {
        imports.add(args.path);
        if (args.path.startsWith('.') || args.path.startsWith('@/')) {
          const path = resolveFile(args.path, args.importer);
          if (path) return { path, namespace: 'workspace' };
        } else if (allow.has(args.path)) return { path: fileURLToPath(import.meta.resolve(args.path)) };
        return { errors: [{ text: `Unsupported preview import "${args.path}" in ${args.importer}. Supply the relative workspace file or use the reviewed React/React DOM, clsx, tailwind-merge, lucide-react, radix-ui, motion/react, recharts or class-variance-authority packages. No packages are installed automatically.` }] };
      });
    }}],
  });
  if (result.warnings.length) throw new Error('Preview code could not be fully resolved: ' + result.warnings.map(w => w.text).join('; '));
  const scanner = new Scanner({ sources: [] });
  const candidates = scanner.scanFiles(workerData.files.filter(file => /\.[jt]sx?$/.test(file.path)).map(file => ({ content: file.content + '\n' + workerData.propsJSON, extension: 'tsx' })));
  // Only validated declarations join the trusted stylesheet. Candidate imports,
  // plugins, sources and other CSS directives never enter the host compiler.
  const theme = themeTokens([workerData.themeCss || '', ...workerData.files.filter(file => file.path.endsWith('.css')).map(file => file.content)].join('\n'));
  const stylesheet = await compileTailwind('@import "tailwindcss" source(none); @custom-variant dark (&:where(.dark, .dark *));\n' + theme, { base: projectRoot, onDependency: () => {} });
  const css = stylesheet.build(candidates.slice(0, 10000)) + '\n' + result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  await finish({ code: result.outputFiles.find(file => file.path.endsWith('.js')).text, css, imports: [...imports] });
} catch (error) {
  try { await finish({ error: error.errors?.map(e => e.text).join('\n') || error.message }); }
  catch { process.exit(1); }
}
