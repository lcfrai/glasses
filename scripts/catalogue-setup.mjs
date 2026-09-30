import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createStore } from '../src/store.mjs';
import { createOnboarding, SHARED_CATALOGUE_URL } from '../src/onboarding.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function catalogueOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--status' || arg === '--retry') options[arg.slice(2)] = true;
    else if (arg.startsWith('--catalogue=')) options.choice = arg.slice(12);
    else if (arg === '--data-dir' && args[i + 1]) options.dataDir = resolve(args[++i]);
    else throw new Error('Usage: node scripts/catalogue-setup.mjs [--catalogue=import|decline | --retry | --status] [--data-dir DIRECTORY]');
  }
  if (options.choice && !['import', 'decline'].includes(options.choice)) throw new Error('--catalogue must be import or decline');
  if ([!!options.choice, !!options.status, !!options.retry].filter(Boolean).length > 1) throw new Error('Choose only one catalogue action');
  return options;
}

export async function runCatalogueSetup({ options = {}, input = process.stdin, output = process.stdout, fetchImpl } = {}) {
  const store = createStore(options.dataDir || process.env.GLASSES_DATA_DIR || resolve(root, '.glasses'));
  const onboarding = createOnboarding({ store, ...(fetchImpl ? { fetchImpl } : {}) });
  let reader;
  try {
    let choice = options.choice;
    if (options.status) { const state = onboarding.status(); output.write(JSON.stringify({ onboarding: state }) + '\n'); return state; }
    if (options.retry) { const state = await onboarding.importLatest({ approved: true }); output.write(JSON.stringify({ onboarding: state }) + '\n'); return state; }
    if (!choice && onboarding.status().choice === 'pending') {
      output.write(`\nStart with the shared Glasses catalogue?\nFetch ${SHARED_CATALOGUE_URL}\nThis imports public metadata, citations and attributed model labels. It does not import source code, run models, change your local work, or enable automatic updates.\n`);
      if (!input.isTTY || !output.isTTY) {
        output.write('No interactive terminal: no catalogue request was made. Choose in the local app, or run npm run catalogue:fetch to import explicitly.\n');
        return onboarding.status();
      }
      reader = createInterface({ input, output });
      const answer = (await reader.question('Fetch latest catalogue now? [y/N] ')).trim().toLowerCase();
      choice = ['y', 'yes'].includes(answer) ? 'import' : 'decline';
    }
    const state = choice ? await onboarding.choose({ choice }) : onboarding.status();
    output.write(JSON.stringify({ onboarding: state }) + '\n');
    if (state.choice === 'decline') output.write('Skipped. Glasses is usable without the shared catalogue. Import later from the app or with npm run catalogue:fetch.\n');
    return state;
  } finally { reader?.close(); await onboarding.close(); store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCatalogueSetup({ options: catalogueOptions(process.argv.slice(2)) }).catch(error => {
    process.stderr.write(`Catalogue setup: ${error.message}\n`);
    if (error.onboarding) process.stderr.write('Your choice is saved. Run npm run catalogue:fetch to retry explicitly; the app still works.\n');
    process.exitCode = 1;
  });
}
