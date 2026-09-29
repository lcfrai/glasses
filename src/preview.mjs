import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeFiles, normalizeVisualEdits, visualStyles, reviewedDependencies } from './workspace.mjs';

const MAX_CSS = 50_000;
const MAX_PROPS = 30_000;
let active = 0;

/** Native compiler libraries live in a disposable OS process, never the service. */
export function runCompilerProcess(workerData, { compilerPath = fileURLToPath(new URL('./preview-worker.mjs', import.meta.url)), timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let response, stderr = '', settled = false;
    const child = fork(compilerPath, [], { execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Preview compilation exceeded ${timeoutMs / 1000} seconds. The compiler process was stopped; the service remains available.`)); }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('message', result => { response = result; });
    child.once('error', error => { child.kill(); finish(new Error(`Preview compiler process failed: ${error.message}`)); });
    // close follows exit and the IPC/stdio drain, so a flushed final result is
    // read before successful completion is accepted.
    child.once('close', (code, signal) => {
      if (code !== 0) { finish(new Error(`Preview compiler exited unexpectedly (${signal || code}). The service remains available.${stderr ? '\n' + stderr : ''}`)); return; }
      if (!response) { finish(new Error('Preview compiler exited without a result. The service remains available.')); return; }
      if (response.error) { finish(new Error(response.error)); return; }
      if (typeof response.code !== 'string' || typeof response.css !== 'string' || !Array.isArray(response.imports)) { finish(new Error('Preview compiler returned an invalid result.')); return; }
      finish(null, response);
    });
    child.send(workerData, error => { if (error) { child.kill(); finish(new Error(`Could not send source to preview compiler: ${error.message}`)); } });
  });
}

/** Compiles, but never executes, candidate code on the host. Runtime is a sandboxed browser frame. */
export async function compilePreview({ source, files, entryPath, css = '', props = {}, visualEdits = {}, editor = false, nonce: trustedNonce } = {}) {
  const workspace = normalizeFiles({ source, files, entryPath });
  visualEdits = normalizeVisualEdits(visualEdits);
  if (typeof css !== 'string' || Buffer.byteLength(css) > MAX_CSS) throw new Error('CSS must be text up to 50 KB.');
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Props must be a JSON object.');
  const propsJSON = JSON.stringify(props);
  if (Buffer.byteLength(propsJSON) > MAX_PROPS) throw new Error('Props must be smaller than 30 KB.');
  if (active >= 2) throw new Error('Two previews are compiling. Try again shortly.');
  active++;
  try {
    const output = await runCompilerProcess({ ...workspace, propsJSON, themeCss: css, editor: !!editor });
    const nonce = trustedNonce && /^[A-Za-z0-9+/=_-]{16,128}$/.test(trustedNonce) ? trustedNonce : randomBytes(20).toString('base64');
    const safeJS = output.code.replace(/<\/script/gi, '<\\/script');
    const compiledCss = output.css + '\n' + css + '\n' + visualStyles(visualEdits);
    const safeCSS = compiledCss.replace(/<\/style/gi, '<\\/style');
    // Child CSP permits inline execution only. A nonce source here would let the
    // candidate reuse its visible nonce on an external script. The initial nonce
    // remains necessary for the independent inherited parent policy.
    const policy = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{min-height:100%;margin:0}body{font-family:Arial,sans-serif}*{box-sizing:border-box}${safeCSS}</style></head><body><div id="root" data-glasses-root></div><script nonce="${nonce}">${safeJS}</script></body></html>`;
    return { html, compiledCss, hash: createHash('sha256').update(JSON.stringify(workspace) + css + propsJSON + JSON.stringify(visualEdits)).digest('hex'), imports: output.imports, dependencies: reviewedDependencies(),
      isolation: { boundary: 'opaque-origin iframe', requiresSandbox: 'allow-scripts', hostExecution: false, subresourceNetwork: false, hardenedContainer: false } };
  } finally { active--; }
}
