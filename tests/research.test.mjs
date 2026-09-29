import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createDiscovery } from '../src/discovery.mjs';
import { createResearch } from '../src/research.mjs';
import { startServer } from '../src/server.mjs';

const directories = [];
after(async () => { for (const path of directories) await rm(path, { recursive: true, force: true }); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'glasses-research-')); directories.push(path); return path; }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixtureFetcher({ failGithub = false } = {}) {
  return async url => {
    let value;
    if (url === 'https://registry.directory/directory.json') value = { registries: [{ name: 'Unfamiliar Labs', url: 'https://unfamiliar-labs.dev/', registry_url: 'https://unfamiliar-labs.dev/registry.json' }] };
    else if (url === 'https://registry.directory/items.json') value = { items: [{ name: 'spinner', description: 'Loading feedback', registry: { name: 'Unfamiliar Labs', basePath: '/unfamiliar/widgets' } }] };
    else if (url === 'https://unfamiliar-labs.dev/registry.json') value = { items: [{ name: 'tool-card', description: 'A provider-discovered card' }] };
    else if (url.startsWith('https://api.github.com/search/repositories?')) {
      if (failGithub) throw new Error('HTTP 429 from api.github.com');
      value = { items: [{ name: 'local-agent-memory', full_name: 'unfamiliar/local-agent-memory', html_url: 'https://github.com/unfamiliar/local-agent-memory', description: 'Whole local memory solution for existing coding agents', topics: ['memory', 'tools'], license: { spdx_id: 'MIT' } }] };
    } else if (url === 'https://registry.directory/api/markdown/unfamiliar/widgets/spinner') return { url, contentType: 'text/markdown', body: '# Spinner\n```tsx\nexport default function Spinner(){return <span>Loading</span>}\n```', status: 200 };
    else throw new Error('Unexpected fixture URL: ' + url);
    return { url, body: JSON.stringify(value), contentType: 'application/json', status: 200 };
  };
}
async function request(app, path, method = 'GET', body) {
  const { token } = await (await fetch(app.url + '/api/session')).json();
  const response = await fetch(app.url + path, { method, headers: { 'X-Glasses-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

test('saved research edits and original run snapshots survive server restart with exact candidate membership', async t => {
  const dataDir = await temporary();
  let app = await startServer({ port: 0, dataDir, autoScout: false, seed: false, discoveryFetcher: fixtureFetcher() });
  t.after(async () => { if (app) await app.close(); });
  const created = await request(app, '/api/research/plans', 'POST', { name: 'Agent memory', query: 'agent memory' });
  assert.equal(created.status, 201);
  const plan = created.data.plan;
  const first = (await request(app, `/api/research/plans/${plan.id}/run`, 'POST', {})).data;
  assert.equal(first.status, 'completed');
  assert.equal(first.planSnapshot.version, 1);
  assert.equal(first.query, 'agent memory');
  assert.ok(first.candidateIds.some(id => app.store.getCapability(id).kind === 'solution'));
  assert.equal(first.added, first.addedCandidateIds.length);
  assert.equal(first.updated, first.updatedCandidateIds.length);
  assert.equal(first.candidateIds.length, first.added + first.updated);
  const edit = await request(app, `/api/research/plans/${plan.id}`, 'PUT', { name: 'UI exploration', query: 'spinner', enabled: false, expectedVersion: 1 });
  assert.equal(edit.data.plan.version, 2);
  const second = (await request(app, `/api/research/plans/${plan.id}/run`, 'POST', {})).data;
  assert.equal(second.query, 'spinner', 'Manual Run explicitly works for a paused plan');
  assert.equal(second.planSnapshot.enabled, false);
  assert.ok(second.updated > 0, 'Refreshed existing results belong to the later run too');
  assert.equal(app.store.getRun(first.id).query, 'agent memory');
  assert.equal(app.store.getRun(first.id).planSnapshot.name, 'Agent memory');
  app.store.upsertCapability({ name: 'Not from either run', kind: 'solution', url: 'https://outside-example.dev/product', provider: 'Fixture' });
  const exact = await request(app, `/api/catalog?runId=${first.id}`);
  assert.deepEqual(exact.data.items.map(item => item.id).sort(), [...first.candidateIds].sort());
  const filtered = await request(app, `/api/catalog?runId=${first.id}&kind=solution`);
  assert.ok(filtered.data.items.length > 0);
  assert.ok(filtered.data.items.every(item => item.kind === 'solution' && first.candidateIds.includes(item.id)));
  await app.close(); app = null;
  app = await startServer({ port: 0, dataDir, autoScout: false, seed: false, discoveryFetcher: fixtureFetcher() });
  assert.equal((await request(app, '/api/research/plans')).data.items[0].query, 'spinner');
  const history = await request(app, `/api/research/runs?planId=${plan.id}&limit=1`);
  assert.equal(history.data.total, 2);
  assert.equal(history.data.items.length, 1);
  const older = await request(app, `/api/research/runs?planId=${plan.id}&limit=1&offset=1`);
  assert.equal(older.data.items[0].id, first.id);
  assert.deepEqual((await request(app, `/api/research/runs/${first.id}`)).data.run, first);
});

test('an in-flight run holds its original plan snapshot while concurrent edits are guarded', async t => {
  const entered = deferred(), release = deferred(), base = fixtureFetcher();
  const app = await startServer({ port: 0, dataDir: await temporary(), autoScout: false, seed: false, discoveryFetcher: async url => {
    if (url === 'https://registry.directory/directory.json') { entered.resolve(); await release.promise; }
    return base(url);
  } });
  t.after(async () => { release.resolve(); await app.close(); });
  const plan = app.store.createResearchPlan({ name: 'Memory', query: 'memory' });
  const other = app.store.createResearchPlan({ name: 'Other', query: 'deployment' });
  const pending = request(app, `/api/research/plans/${plan.id}/run`, 'POST', {});
  await entered.promise;
  const history = (await request(app, '/api/research/runs')).data;
  assert.equal(history.items[0].status, 'running');
  assert.equal(history.items[0].planSnapshot.version, 1);
  assert.equal((await request(app, `/api/research/plans/${plan.id}`, 'PUT', { query: 'spinner', expectedVersion: 1 })).status, 200);
  assert.equal((await request(app, `/api/research/plans/${plan.id}`, 'PUT', { query: 'discarded', expectedVersion: 1 })).status, 409);
  assert.equal((await request(app, `/api/research/plans/${other.id}/run`, 'POST', {})).status, 409);
  assert.equal(app.store.runCount(), 1, 'Busy attempts do not fabricate completed research');
  release.resolve();
  const completed = await pending;
  assert.equal(completed.data.query, 'memory');
  assert.equal(completed.data.planSnapshot.version, 1);
  assert.equal(app.store.getResearchPlan(plan.id).query, 'spinner');
});

test('automatic rotation preserves broad discovery and cycles enabled plans across restart', async t => {
  const directory = await temporary();
  let store = createStore(directory);
  t.after(() => store.close());
  let discovery = createDiscovery({ store, fetcher: fixtureFetcher() });
  let research = createResearch({ store, discovery });
  const first = store.createResearchPlan({ name: 'Memory', query: 'memory' });
  const second = store.createResearchPlan({ name: 'Loading', query: 'spinner' });
  const disabled = store.createResearchPlan({ name: 'Paused', query: 'ignore this', enabled: false });
  const expected = store.researchPlans().filter(plan => plan.enabled);
  const broad = await research.runScheduled();
  assert.equal(broad.researchMode, 'broad');
  assert.equal(broad.trigger, 'scheduled');
  assert.equal(broad.planId, null);
  assert.ok(broad.candidateIds.some(id => store.getCapability(id).kind === 'solution'));
  assert.ok(broad.candidateIds.some(id => store.getCapability(id).provider === 'Unfamiliar Labs'));
  assert.equal((await research.runScheduled()).planId, expected[0].id);
  assert.equal((await research.runScheduled()).researchMode, 'broad');
  store.close(); store = createStore(directory);
  discovery = createDiscovery({ store, fetcher: fixtureFetcher() }); research = createResearch({ store, discovery });
  assert.equal((await research.runScheduled()).planId, expected[1].id);
  assert.ok(store.runs().every(run => run.planId !== disabled.id));
  store.updateResearchPlan(first.id, { enabled: false }); store.updateResearchPlan(second.id, { enabled: false });
  assert.equal((await research.runScheduled()).researchMode, 'broad');
  assert.equal((await research.runScheduled()).researchMode, 'broad', 'Pausing every custom plan retains broad discovery');
  await assert.rejects(research.runPlan(disabled.id, { trigger: 'scheduled' }), /paused/);
});

test('research API rejects malformed plans and queries without mutations', async t => {
  const app = await startServer({ port: 0, dataDir: await temporary(), autoScout: false, seed: false, discoveryFetcher: fixtureFetcher() });
  t.after(() => app.close());
  for (const body of [{}, { name: ' ', query: 'memory' }, { name: 'Memory', query: '' }, { name: 'Memory', query: 3 }, { name: 'x'.repeat(101), query: 'memory' }, { name: 'Memory', query: 'x'.repeat(201) }, { name: 'Memory', query: 'memory', enabled: 'false' }, { name: 'Memory', query: 'memory', script: 'run me' }]) {
    assert.equal((await request(app, '/api/research/plans', 'POST', body)).status, 400);
  }
  assert.equal(app.store.researchPlans().length, 0);
  const plan = app.store.createResearchPlan({ name: 'Memory', query: 'memory' });
  for (const body of [{}, { enabled: null }, { expectedVersion: 0, query: 'new' }, { id: 'replacement' }, { query: [] }]) {
    assert.equal((await request(app, `/api/research/plans/${plan.id}`, 'PUT', body)).status, 400);
  }
  assert.equal(app.store.getResearchPlan(plan.id).version, 1);
  assert.equal((await request(app, `/api/research/plans/${plan.id}/run`, 'POST', { query: 'unsaved override' })).status, 400);
  for (const query of ['limit=0', 'limit=101', 'limit=NaN', 'offset=-1', 'offset=1.5']) assert.equal((await request(app, '/api/research/runs?' + query)).status, 400);
  for (const path of ['/api/research/runs/unknown', '/api/research/plans/unknown', '/api/research/runs?planId=unknown', '/api/catalog?runId=unknown']) assert.equal((await request(app, path)).status, 404);
  assert.equal(app.store.runCount(), 0);
});

test('partial and failed research retains source errors and actual result links; legacy scouts remain usable', async t => {
  const app = await startServer({ port: 0, dataDir: await temporary(), autoScout: false, seed: false, discoveryFetcher: fixtureFetcher({ failGithub: true }) });
  t.after(() => app.close());
  const plan = app.store.createResearchPlan({ name: 'Memory', query: 'spinner' });
  const partial = (await request(app, `/api/research/plans/${plan.id}/run`, 'POST', {})).data;
  assert.equal(partial.status, 'partial');
  assert.match(partial.errors.join(' '), /429/);
  assert.ok(partial.candidateIds.length > 0);
  assert.ok(partial.candidateIds.every(id => app.store.getCapability(id)));
  assert.equal((await request(app, `/api/catalog?runId=${partial.id}`)).data.total, partial.candidateIds.length);
  const legacy = await request(app, '/api/scout', 'POST', { query: 'spinner' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.researchMode, 'query');
  assert.equal(legacy.data.planId, null);
  assert.equal(legacy.data.planSnapshot, null);
  const failing = createDiscovery({ store: app.store, fetcher: async () => { throw new Error('Synthetic offline source'); } });
  const failed = await createResearch({ store: app.store, discovery: failing }).runPlan(plan.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.candidateIds, []);
  assert.equal(failed.added + failed.updated, 0);
  assert.equal(failed.planId, plan.id);
  assert.equal(app.store.getRun(failed.id).errors.length, 3);
});

test('targeted research excludes unrelated providers and registry items while broad discovery retains them', async t => {
  const store = createStore(await temporary()); t.after(() => store.close());
  const discovery = createDiscovery({ store, fetcher: fixtureFetcher() });
  const research = createResearch({ store, discovery });
  const memory = store.createResearchPlan({ name: 'Agent continuity', query: 'agent memory' });
  const targeted = await research.runPlan(memory.id);
  assert.equal(targeted.status, 'completed');
  assert.deepEqual(targeted.candidateIds.map(id => store.getCapability(id).kind), ['solution']);
  assert.ok(targeted.candidateIds.every(id => store.getCapability(id).provider !== 'Unfamiliar Labs'));
  assert.equal(store.search({ query: 'tool-card' }).length, 0);
  const broad = await research.runScheduled();
  assert.ok(broad.candidateIds.some(id => store.getCapability(id).name === 'Unfamiliar Labs'));
  assert.ok(broad.candidateIds.some(id => store.getCapability(id).name === 'tool-card'));
  const later = await research.runPlan(memory.id);
  assert.deepEqual(later.candidateIds, targeted.candidateIds, 'Unrelated catalogue entries remain outside the targeted run after broad research');
  assert.equal(later.added, 0); assert.equal(later.updated, 1);
  store.updateResearchPlan(memory.id, { query: 'agent memory retention export' });
  const amended = await research.runPlan(memory.id);
  assert.equal(amended.githubQuery, 'agent memory retention export', 'Saved plan qualifiers reach repository search rather than being collapsed to a generic memory query');
  assert.equal(store.getRun(targeted.id).githubQuery, 'agent memory');
});

test('startup marks an interrupted persisted run honestly and preserves its recorded results', async t => {
  const dataDir = await temporary(), store = createStore(dataDir);
  const plan = store.createResearchPlan({ name: 'Interrupted memory', query: 'memory' });
  const item = store.upsertCapability({ name: 'Already fetched', kind: 'solution', url: 'https://interrupted-example.dev/product', provider: 'Fixture' }).item;
  store.saveRun({ id: 'interrupted-fixture', status: 'running', query: plan.query, planId: plan.id, planSnapshot: plan, startedAt: '2026-09-28T00:00:00.000Z', finishedAt: null, candidateIds: [item.id], addedCandidateIds: [item.id], updatedCandidateIds: [], added: 1, updated: 0, errors: [] });
  store.close();
  const app = await startServer({ port: 0, dataDir, autoScout: false, seed: false, discoveryFetcher: fixtureFetcher() });
  t.after(() => app.close());
  const run = (await request(app, '/api/research/runs/interrupted-fixture')).data.run;
  assert.equal(run.status, 'interrupted');
  assert.equal(run.planSnapshot.query, 'memory');
  assert.match(run.errors.join(' '), /stopped before/);
  assert.ok(run.finishedAt);
  assert.deepEqual((await request(app, '/api/catalog?runId=interrupted-fixture')).data.items.map(item => item.id), [item.id]);
});
