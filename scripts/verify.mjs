import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ required; install a supported Node.js version and run npm run verify.');
for (const args of [['scripts/build.mjs'], ['--test', 'tests/*.test.mjs'], ['tests/e2e.mjs'], ['tests/canvas-e2e.mjs'], ['tests/catalogue-e2e.mjs'], ['tests/intelligence-e2e.mjs'], ['tests/catalogue-scale-e2e.mjs'], ['tests/token-recovery-e2e.mjs'], ['tests/reviewed-components-e2e.mjs'], ['tests/public-catalogue-e2e.mjs'], ['tests/onboarding-e2e.mjs']]) {
  const extraEvidence = {'tests/token-recovery-e2e.mjs':'token-recovery','tests/reviewed-components-e2e.mjs':'reviewed-components','tests/public-catalogue-e2e.mjs':'public-catalogue','tests/onboarding-e2e.mjs':'onboarding'}[args[0]];
  const env = extraEvidence ? {...process.env,GLASSES_EVIDENCE_DIR:`${process.env.GLASSES_EVIDENCE_DIR || 'evidence/verification'}/${extraEvidence}`} : process.env;
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
