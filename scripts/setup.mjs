// Repository bootstrap: uses the checked-in lockfile, never a published npx package.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`Setup step exited ${code ?? signal}`)));
  });
}
function npmCommand() {
  const cli = [process.env.npm_execpath, resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(p => p && existsSync(p));
  if (cli) return { command: process.execPath, args: [cli, 'ci'], options: {} };
  // Only a constant npm command reaches the Windows shell; user args and paths
  // are never interpolated. On Unix npm is spawned directly.
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['ci'], options: { shell: process.platform === 'win32' } };
}
export async function setup(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 or newer with npm before running setup.');
  const catalogueArgs = args.filter(arg => arg !== '--no-build');
  // Validate arguments before any dependency fetch. Parsing this small argument
  // subset here avoids loading application dependencies before npm ci.
  for (let i = 0; i < catalogueArgs.length; i++) {
    if (['--status', '--retry', '--catalogue=import', '--catalogue=decline'].includes(catalogueArgs[i])) continue;
    if (catalogueArgs[i] === '--data-dir' && catalogueArgs[i + 1]) { i++; continue; }
    throw new Error('Usage: node scripts/setup.mjs [--catalogue=import|decline | --status | --retry] [--data-dir DIRECTORY] [--no-build]');
  }
  if (catalogueArgs.filter(arg => arg === '--status' || arg === '--retry' || arg.startsWith('--catalogue=')).length > 1) throw new Error('Choose only one catalogue action');
  let ready = true;
  for (const dependency of ['esbuild', 'zod', 'react', '@modelcontextprotocol/sdk/client/index.js']) { try { require.resolve(dependency); } catch { ready = false; } }
  if (!ready) {
    console.log('Installing this repository’s locked development/runtime dependencies with npm ci. Shared catalogue consent is separate.');
    const npm = npmCommand(); await run(npm.command, npm.args, npm.options);
  }
  if (!args.includes('--no-build') && !args.includes('--status')) await run(process.execPath, [resolve(root, 'scripts/build.mjs')]);
  const { runCatalogueSetup, catalogueOptions } = await import('./catalogue-setup.mjs');
  await runCatalogueSetup({ options: catalogueOptions(catalogueArgs) });
  console.log('\nReady. Run npm start, then open http://127.0.0.1:4317.');
  console.log('Optional agent connection, when you choose it: npm run mcp:install. No agent configuration was changed by setup.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setup().catch(error => { process.stderr.write(`Glasses setup: ${error.message}\nYou can still start Glasses after dependencies/build are ready. Catalogue retry: npm run catalogue:fetch\n`); process.exitCode = 1; });
}
