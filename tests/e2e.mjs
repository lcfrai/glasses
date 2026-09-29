import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await mkdtemp(path.join(tmpdir(), 'glasses-e2e-'));
const evidenceDir = path.resolve(root, process.env.GLASSES_EVIDENCE_DIR || 'evidence/local-2026-09-28');
await mkdir(evidenceDir, { recursive: true });
const port = Number(process.env.GLASSES_TEST_PORT || 33000 + Math.floor(Math.random() * 15000));
const base = `http://127.0.0.1:${port}`;
const report = { startedAt: new Date().toISOString(), result: 'RUNNING', checks: [], limitations: ['This uses the explicitly labelled original workbench sample. Live external discovery is tested separately.', 'Browser interaction does not establish design quality or token savings.'] };
let logs = '';
let token;
let browser;
let page;
let workspace;
const pageErrors = [];
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root,
  env: { ...process.env, GLASSES_PORT: String(port), GLASSES_DATA_DIR: dataDir, GLASSES_SCOUT_ENABLED: 'false', GLASSES_SCOUT_ON_START: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
server.on('exit', (code, signal) => { logs += `\nServer exit: code=${code} signal=${signal}\n`; });

async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Glasses-Token': token } : {}), ...options.headers }, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  assert.equal(response.ok, true, `${route}: ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); report.checks.push({ name, result: 'PASS', ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, result: 'FAIL', ms: Date.now() - started, error: error.message }); throw error; }
}
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: 15000 }); }
async function readWorkspace() {
  const items = (await api('/api/workspaces')).items;
  assert.ok(items.length, 'UI must create a persistent workspace');
  return items.find(item => item.id === workspace?.id) || items[0];
}

try {
  await check('Disposable backend starts with auto scouting disabled', async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}: ${logs}`);
      try { ({ token } = await api('/api/session')); break; } catch { await delay(100); }
    }
    assert.ok(token, `Server not ready: ${logs}`);
    const status = await api('/api/status');
    assert.equal(status.scouting, false);
    assert.equal(status.schedule.enabled, false);
  });
  await check('Browser launches', async () => {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (executablePath) await access(executablePath);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
    report.browserVersion = await browser.version();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base);
  });
  await check('Catalogue loads, zero-match search stays empty and product origin is inspectable', async () => {
    const search = page.getByRole('searchbox', { name: 'Search catalogue' });
    await visible(search);
    await visible(page.getByRole('button', { name: 'Inspect Coolify', exact: true }));
    assert.equal((await api('/api/workspaces')).items.length, 0, 'Catalogue visits must not create a sample');
    assert.equal(await page.locator('iframe[title="Isolated component preview"]').count(), 0);
    await page.screenshot({ path: path.join(evidenceDir, 'desktop-catalogue.png'), fullPage: true });
    await search.fill('zzq-no-existing-capability-9b784e');
    await visible(page.getByRole('heading', { name: 'No matching capabilities.' }));
    assert.equal((await api('/api/catalog?q=zzq-no-existing-capability-9b784e')).total, 0);
    await search.fill('Coolify');
    await page.getByRole('button', { name: 'Inspect Coolify', exact: true }).click();
    const upstream = page.getByRole('link', { name: 'Inspect original source' });
    await visible(upstream);
    assert.match(await upstream.getAttribute('href'), /^https:\/\/github\.com\/coollabsio\/coolify/);
  });
  await check('Whole-solution goal produces an exportable adoption brief without claiming installation', async () => {
    await page.getByRole('button', { name: 'Prepare adoption brief' }).click();
    const goal = 'Deploy my applications locally instead of building a deployment platform.';
    await page.getByRole('textbox', { name: 'Adoption goal' }).fill(goal);
    await page.getByRole('button', { name: 'Create adoption brief' }).click();
    await visible(page.getByText('Needs assessment · fit not confirmed', { exact: true }));
    await visible(page.getByText(goal, { exact: true }));
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export assessment brief' }).click();
    const brief = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
    assert.equal(brief.candidate.name, 'Coolify');
    assert.equal(brief.requirements.goal, goal);
    assert.equal(brief.fitConfirmed, false);
    assert.equal(brief.execution.installed, false);
    assert.ok(brief.missingContext.length > 0);
    await page.screenshot({ path: path.join(evidenceDir, 'adoption-brief.png'), fullPage: true });
    await page.getByRole('button', { name: 'Close dialog' }).click();
  });
  await check('Original sample opens as an isolated live React preview', async () => {
    await page.goto(base);
    await page.getByRole('navigation', { name: 'Site navigation' }).getByRole('button', { name: 'Workbench', exact: true }).click();
    await page.getByRole('button', { name: 'New sample workspace' }).click();
    const frame = page.locator('iframe[title="Isolated component preview"]');
    await visible(frame);
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
    const preview = page.frameLocator('iframe[title="Isolated component preview"]');
    await visible(preview.getByRole('heading', { name: 'A little clarity is on the way.' }));
    await page.getByRole('button', { name: 'Pause preview motion' }).click();
    const pauseDeadline = Date.now() + 10000;
    let playState;
    while (Date.now() < pauseDeadline) {
      playState = await preview.locator('.dot-orbit i').first().evaluate(element => getComputedStyle(element).animationPlayState);
      if (playState === 'paused') break;
      await delay(100);
    }
    assert.equal(playState, 'paused', 'Pause must affect the actual animation');
    workspace = await readWorkspace();
    assert.match(workspace.source, /A little clarity is on the way/);
  });
  await check('Property and actual source edits change the rendered result', async () => {
    await page.getByRole('button', { name: 'Properties', exact: true }).click();
    const props = { ...workspace.props, label: 'Evidence retained', radius: 30, accent: '#47b9ed' };
    await page.getByText('All props', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Component props JSON' }).fill(JSON.stringify(props, null, 2));
    await page.getByRole('button', { name: 'TSX', exact: true }).click();
    assert.match(workspace.source, /Connecting the useful things/);
    await page.getByRole('textbox', { name: 'Component TSX source' }).fill(workspace.source.replace('Connecting the useful things.', 'Edited source proven in browser.'));
    await page.getByRole('button', { name: 'CSS', exact: true }).click();
    await page.getByRole('textbox', { name: 'Component CSS source' }).fill(workspace.css + '\n/* E2E source edit is exported verbatim. */\n');
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Isolated component preview"]');
    await visible(frame.getByRole('heading', { name: 'Evidence retained' }));
    await visible(frame.getByText(/Edited source proven in browser/));
    assert.equal(await frame.locator('.thinking-card').evaluate(element => getComputedStyle(element).borderRadius), '30px');
  });
  await check('Saved source and props survive a page reload and are exported exactly', async () => {
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      workspace = await readWorkspace();
      if (workspace.props.label === 'Evidence retained' && workspace.source.includes('Edited source proven in browser.')) break;
      await delay(100);
    }
    assert.equal(workspace.props.label, 'Evidence retained');
    assert.match(workspace.source, /Edited source proven in browser/);
    assert.match(workspace.css, /E2E source edit is exported verbatim/);
    await page.reload();
    // The app should restore the selected workspace, or make the saved study reachable by title.
    await page.getByRole('combobox', { name: 'Select workspace' }).selectOption(workspace.id);
    await visible(page.frameLocator('iframe[title="Isolated component preview"]').getByRole('heading', { name: 'Evidence retained' }));
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export workspace', exact: true }).click();
    const download = await downloadPromise;
    const downloaded = await readFile(await download.path(), 'utf8');
    assert.match(downloaded, /Evidence retained/);
    assert.match(downloaded, /Edited source proven in browser/);
    const exported = await api(`/api/workspaces/${workspace.id}/export`);
    assert.equal(exported.files.find(file => file.path === 'source.tsx').content, workspace.source);
    assert.equal(JSON.parse(exported.files.find(file => file.path === 'props.json').content).label, 'Evidence retained');
    assert.ok(exported.files.find(file => file.path === 'provenance.json'));
    await page.screenshot({ path: path.join(evidenceDir, 'desktop-workbench.png'), fullPage: true });
  });
  await check('Unsupported dependency gives an actionable error and restored source renders again', async () => {
    await page.getByRole('button', { name: 'TSX', exact: true }).click();
    await page.getByRole('textbox', { name: 'Component TSX source' }).fill('import Unknown from "unreviewed-package-for-e2e"; export default function Example(){ return <Unknown />; }');
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await visible(page.getByRole('heading', { name: 'This source needs a closer look.' }));
    assert.match(await page.locator('.preview-error').textContent(), /unreviewed-package-for-e2e/);
    await page.getByRole('button', { name: 'TSX', exact: true }).click();
    await page.getByRole('textbox', { name: 'Component TSX source' }).fill(workspace.source);
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await visible(page.frameLocator('iframe[title="Isolated component preview"]').getByRole('heading', { name: 'Evidence retained' }));
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await visible(page.getByRole('button', { name: 'All changes saved', exact: true }));
  });
  await check('Actual MCP update appears in the open browser without reloading', async () => {
    const client = new Client({ name: 'glasses-browser-e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp.mjs')], env: { ...process.env, GLASSES_URL: base }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'glasses_update_workspace', arguments: { id: workspace.id, props: { ...workspace.props, label: 'Agent edit visible' } } });
      assert.ok(!result.isError, result.content?.[0]?.text);
      await visible(page.frameLocator('iframe[title="Isolated component preview"]').getByRole('heading', { name: 'Agent edit visible' }));
      assert.equal(await page.getByRole('textbox', { name: 'Component heading' }).inputValue(), 'Agent edit visible');
      workspace = await readWorkspace();
      assert.equal(workspace.props.label, 'Agent edit visible');
      await page.screenshot({ path: path.join(evidenceDir, 'mcp-browser-sync.png'), fullPage: true });
    } finally { await client.close(); }
  });
  await check('Preview cannot read parent storage/document or fetch the local API', async () => {
    const source = `import React, {useEffect, useState} from 'react';
export default function Probe() {
  const [result, setResult] = useState(null);
  useEffect(() => { (async () => {
    const result = {};
    try { void parent.localStorage.length; result.parentStorage = 'ALLOWED'; } catch { result.parentStorage = 'blocked'; }
    try { void parent.document.body; result.parentDocument = 'ALLOWED'; } catch { result.parentDocument = 'blocked'; }
    try { await fetch(${JSON.stringify(`${base}/api/status?preview-probe=1`)}); result.fetch = 'ALLOWED'; } catch { result.fetch = 'blocked'; }
    setResult(result);
  })(); }, []);
  return <pre data-testid="isolation-result">{result ? JSON.stringify(result) : 'pending'}</pre>;
}`;
    const preview = await api('/api/preview', { method: 'POST', body: JSON.stringify({ source, css: '', props: {} }) });
    await page.evaluate(html => {
      const frame = document.createElement('iframe');
      frame.id = 'security-probe';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = html;
      frame.style.width = '500px';
      frame.style.height = '100px';
      document.body.append(frame);
    }, preview.html);
    const output = page.frameLocator('#security-probe').getByTestId('isolation-result');
    await visible(output);
    const deadline = Date.now() + 10000;
    let content;
    while (Date.now() < deadline) {
      content = await output.textContent();
      if (content !== 'pending') break;
      await delay(50);
    }
    assert.deepEqual(JSON.parse(content), { parentStorage: 'blocked', parentDocument: 'blocked', fetch: 'blocked' });
    await page.evaluate(() => document.getElementById('security-probe').remove());
  });
  await check('Mobile catalogue fits viewport and browser has no uncaught page errors', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    await visible(page.getByRole('searchbox', { name: 'Search catalogue' }));
    await visible(page.getByRole('button', { name: 'Inspect Coolify', exact: true }));
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-catalogue.png'), fullPage: true });
    const sizes = await page.evaluate(() => ({ viewport: window.innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(sizes.width <= sizes.viewport + 2, `Mobile page overflow: ${JSON.stringify(sizes)}`);
    await page.getByRole('navigation', { name: 'Site navigation' }).getByRole('button', { name: 'Workbench', exact: true }).click();
    await visible(page.locator('iframe[title="Isolated component preview"]'));
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-workbench.png'), fullPage: true });
    assert.deepEqual(pageErrors, [], 'Uncaught browser errors');
  });
  report.result = 'PASS';
} catch (error) {
  report.result = /Executable doesn't exist|browserType.launch/.test(error.message) ? 'BLOCKED' : 'FAIL';
  report.error = error.stack;
  if (error.cause) report.cause = {message:error.cause.message, code:error.cause.code};
  report.serverLogs = logs;
  if (page) { try { await page.screenshot({ path: path.join(evidenceDir, 'e2e-failure.png'), fullPage: true }); } catch {} }
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await browser?.close();
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2500)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
  await writeFile(path.join(evidenceDir, 'e2e.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`E2E ${report.result}: ${report.checks.filter(check => check.result === 'PASS').length}/${report.checks.length} checks. Evidence: evidence/e2e.json`);
