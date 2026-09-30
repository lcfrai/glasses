import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from '../src/credential-store.mjs';
import { createProviders, JEV_MODEL, CODEX_MODEL, CODEX_RESTRICTIONS, codexTurnFailure, measureJevClassificationBatch, isDefinitelyUnsentProviderError } from '../src/providers.mjs';

const cards = [{ id: 'graft', name: 'Graft', url: 'https://github.com/papercomputeco/graft', description: 'Complete local agent memory system with Codex hooks and an MCP server. SQLite-backed, supports persistence and recall.', evidenceIds: ['readme'], evidence: [{ id: 'readme', sha256: 'a'.repeat(64), url: 'https://github.com/papercomputeco/graft', excerpt: 'Persistent agent memory with recall hooks and local storage.' }], privateWorkspace: 'DO_NOT_SEND_PRIVATE', apiKey: 'DO_NOT_SEND_KEY' }];
const classified = { id: 'graft', artifact: 'whole-product', adoption: 'configure-agent', capabilities: ['agent-memory', 'mcp'], confidence: 0.9, evidenceIds: ['readme'] };
const fixtureKey = 'synthetic-provider-secret-DO-NOT-LEAK';
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
function mockRunner(data = { results: [classified] }) {
  const fn = async () => ({ data, model: CODEX_MODEL, usage: { inputTokens: 12, outputTokens: 8 } });
  fn.status = async () => ({ available: true, authenticated: true, configured: true, model: CODEX_MODEL, authType: 'chatgpt' });
  return fn;
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'glasses-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialStore = createCredentialStore({ dataDir: directory, platform: 'linux' });
  const providers = createProviders({ dataDir: directory, credentialStore, codexRunner: mockRunner(), ...options });
  return { directory, credentialStore, providers };
}
function jevReply(body) {
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: question.instructions.includes("'agent-memory'") ? 0.95 : 0.1 }];
    const keys = Object.keys(question.criteria);
    if (question.type === 'score') return [id, { type: 'score', score: 3.5, confidence: 0.85, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.5, 4: 0.5 }, legend: Object.fromEntries(question.criteria.map((v, i) => [String(i), v])) }];
    const choice = keys.includes('whole-product') ? 'whole-product' : 'configure-agent';
    return [id, { type: 'choice', choice, confidence: 0.88, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
  })), usage: { input_tokens: 1000, output_tokens: 100 } };
}

test('Windows DPAPI stores ciphertext and reopens under the same user without plaintext files', { skip: process.platform !== 'win32' }, async t => {
  const { directory } = await setup(t);
  const store = createCredentialStore({ dataDir: directory });
  assert.deepEqual(await store.save(fixtureKey), { configured: true, storage: 'windows-dpapi' });
  const names = await readdir(join(directory, 'credentials'));
  assert.deepEqual(names, ['jev.dpapi.json']);
  const raw = await readFile(join(directory, 'credentials', names[0]), 'utf8');
  assert.ok(!raw.includes(fixtureKey));
  assert.ok(!Buffer.from(JSON.parse(raw).ciphertext, 'base64').includes(Buffer.from(fixtureKey)));
  assert.equal(await createCredentialStore({ dataDir: directory }).load(), fixtureKey);
  await store.remove();
  assert.equal((await store.status()).configured, false);
  assert.equal(await createCredentialStore({ dataDir: directory }).load(), null);
});

test('non-Windows storage is explicitly session-only; invalid keys are never reflected', async t => {
  const { directory, credentialStore, providers } = await setup(t);
  await providers.saveJevKey(fixtureKey);
  assert.deepEqual(await credentialStore.status(), { configured: true, storage: 'session-only' });
  assert.equal(await createCredentialStore({ dataDir: directory, platform: 'linux' }).load(), null);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(providers.saveJevKey(fixtureKey + '\n'), error => error.code === 'INVALID_KEY' && !error.message.includes(fixtureKey));
  assert.ok(!JSON.stringify(await providers.status()).includes(fixtureKey));
});

test('Jev connection test uses canonical model listing and sends no inference request', async t => {
  let request;
  const { providers } = await setup(t, { fetchImpl: async (url, init) => { request = { url, init }; return json({ models: [{ name: 'jev-latest', description: 'Jev', release_date: '2026-09-01' }] }); } });
  await providers.saveJevKey(fixtureKey);
  const result = await providers.test('jev');
  assert.equal(request.url, 'https://api.typesafe.ai/v1/models');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.body, undefined);
  assert.equal(request.init.redirect, 'error');
  assert.equal(result.inference, false);
  assert.ok(!JSON.stringify(result).includes(fixtureKey));
});

test('Jev typed classification and rank use canonical endpoint, public-only cards and measured usage', async t => {
  const requests = [];
  const { providers } = await setup(t, { fetchImpl: async (url, init) => { const body = JSON.parse(init.body); requests.push({ url, body }); return json(jevReply(body)); } });
  await providers.saveJevKey(fixtureKey);
  const result = await providers.classify('jev', { cards });
  assert.equal(result.results[0].artifact, 'whole-product');
  assert.deepEqual(result.results[0].capabilities, ['agent-memory']);
  assert.equal(result.usage.inputTokens, 1000);
  assert.equal(result.usage.costUsd, 0.000042);
  const ranked = await providers.rank('jev', { cards, query: 'agent memory' });
  assert.equal(ranked.results[0].score, 0.875);
  for (const request of requests) {
    assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
    assert.ok(!JSON.stringify(request.body).includes('DO_NOT_SEND'));
  }
});

test('both classifiers retain only bounded public tags and generic collection/source-adoption criteria', async t => {
  const tags = [' agent-memory ', null, { privateNote: 'TAG_OBJECT_DO_NOT_SEND' }, ...Array.from({ length: 20 }, (_, i) => `public-${i}-` + 'x'.repeat(140))];
  const input = [{ ...cards[0], tags, outcomes: ['OUTCOME_DO_NOT_SEND'], correction: { notes: 'CORRECTION_DO_NOT_SEND' } }];
  let codexPrompt, jevBody;
  const runner = async args => { codexPrompt = args.prompt; return { data: { results: [classified] }, model: CODEX_MODEL, usage: { inputTokens: 12, outputTokens: 8 } }; };
  const { providers } = await setup(t, { codexRunner: runner, fetchImpl: async (_, init) => { jevBody = JSON.parse(init.body); return json(jevReply(jevBody)); } });
  await providers.saveJevKey(fixtureKey);
  await providers.classify('codex', { cards: input });
  await providers.classify('jev', { cards: input });
  const codexCards = JSON.parse(codexPrompt.split('PUBLIC_CARDS=')[1]);
  for (const projected of [codexCards[0], jevBody.state.cards[0]]) {
    assert.equal(projected.tags.length, 15);
    assert.equal(projected.tags[0], 'agent-memory');
    assert.ok(projected.tags.every(tag => typeof tag === 'string' && tag.length <= 100));
    assert.doesNotMatch(JSON.stringify(projected), /DO_NOT_SEND/);
  }
  assert.deepEqual(codexCards[0].tags, jevBody.state.cards[0].tags);
  assert.match(jevBody.questions.a0.criteria['tool-library'], /collection overview/);
  assert.match(jevBody.questions.a0.criteria.component, /not a library\/collection/);
  assert.match(jevBody.questions.d0.criteria['embed-package'], /registry source item alone does not establish/);
  assert.match(jevBody.questions.d0.criteria['adapt-source'], /source-distribution registry/);
  assert.match(codexPrompt, /collection overview/);
});

test('Jev ranks thirty Unicode-rich cards in one bounded request and preserves IDs, scores and measured usage', async t => {
  let calls = 0, request;
  const input = Array.from({ length: 30 }, (_, index) => {
    const id = `item-${index}-` + '🧭'.repeat(30);
    return { id, name: `Public memory ${index} ` + '界'.repeat(30), url: `https://example.org/public/${index}/` + 'x'.repeat(60),
      description: 'Scoped recall and deletion. ' + '界'.repeat(200), sourceKind: 'solution', tags: ['agent-memory', 'mcp', 'public-tag'],
      assessment: { artifact: 'agent-extension', adoption: 'configure-agent', notes: 'PRIVATE_ASSESSMENT_DO_NOT_SEND' },
      evidenceIds: [`public-${index}`], evidence: [{ id: `public-${index}`, url: `https://example.org/evidence/${index}`, sha256: 'a'.repeat(64), excerpt: 'Retained public evidence for scoped memory. ' + 'Ω'.repeat(150) }],
      correction: { notes: 'PRIVATE_CORRECTION_DO_NOT_SEND' }, outcomes: ['PRIVATE_OUTCOME_DO_NOT_SEND'] };
  });
  const { providers } = await setup(t, { fetchImpl: async (_, init) => {
    calls++; request = JSON.parse(init.body);
    const stateBytes = Buffer.byteLength(JSON.stringify(request.state));
    const questionBytes = Math.max(...Object.values(request.questions).map(question => Buffer.byteLength(JSON.stringify(question))));
    assert.ok(stateBytes + questionBytes <= 30000);
    assert.ok(Buffer.byteLength(init.body) <= 60000);
    assert.equal(request.state.cards.length, 30);
    assert.equal(Object.keys(request.questions).length, 30);
    assert.doesNotMatch(init.body, /DO_NOT_SEND/);
    assert.ok(request.state.cards.every((card, index) => card.index === index && card.name && card.description && card.evidenceExcerpt && card.tags));
    assert.equal(request.state.cards[0].assessment.artifact, 'agent-extension');
    const reply = jevReply(request);
    for (let i = 0; i < 30; i++) reply.answers[`r${i}`].score = i * 4 / 29;
    reply.usage = { input_tokens: 23456, output_tokens: 321 };
    return json(reply);
  } });
  await providers.saveJevKey(fixtureKey);
  // Escaped control characters exercise serialized byte accounting even when
  // a query's character count is within the API's accepted bound.
  const query = 'Public memory ' + '\u0001'.repeat(1986);
  const result = await providers.rank('jev', { cards: input, query });
  assert.equal(calls, 1, 'One engine invocation must reserve for exactly one upstream request');
  assert.equal(request.state.query, query, 'The user query is never silently truncated');
  assert.deepEqual(result.results.map(item => item.id), input.map(item => item.id));
  for (let i = 0; i < 30; i++) assert.equal(result.results[i].score, i / 29);
  assert.deepEqual(result.usage, { inputTokens: 23456, outputTokens: 321, costUsd: 23456 * 0.042 / 1000000 });
});

test('malformed Jev taxonomy, probabilities, usage and missing answers are rejected', async t => {
  let corrupt;
  const { providers } = await setup(t, { fetchImpl: async (_, init) => { const reply = jevReply(JSON.parse(init.body)); corrupt(reply); return json(reply); } });
  await providers.saveJevKey(fixtureKey);
  for (const change of [r => { r.answers.a0.choice = 'invented'; }, r => { r.answers.a0.probabilities['whole-product'] = -1; }, r => { r.usage.input_tokens = -4; }, r => { delete r.answers.a0; }, r => { r.model = 'jev-unpriced'; }]) {
    corrupt = change;
    await assert.rejects(providers.classify('jev', { cards }), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
});

test('upstream HTTP/network errors never reflect the key or upstream body', async t => {
  let mode = 'http';
  const { providers } = await setup(t, { fetchImpl: async () => {
    if (mode === 'http') return new Response(`secret=${fixtureKey}`, { status: 401 });
    throw new Error(`Authorization Bearer ${fixtureKey}`);
  } });
  await providers.saveJevKey(fixtureKey);
  for (const value of ['http', 'network']) {
    mode = value;
    await assert.rejects(providers.test('jev'), error => !error.message.includes(fixtureKey) && !error.stack.includes(fixtureKey));
  }
});

test('timeout and cancellation propagate an abort to an in-flight upstream fetch', async t => {
  let aborted = 0;
  const { providers } = await setup(t, { fetchImpl: async (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted++; reject(new Error('upstream abort')); }, { once: true })) });
  await providers.saveJevKey(fixtureKey);
  await assert.rejects(providers.test('jev', { timeoutMs: 25 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const operation = providers.test('jev', { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(operation, { code: 'ABORTED' });
  assert.equal(aborted, 2);
});

test('Codex validates IDs/evidence/taxonomy and removes private caller properties from the prompt', async t => {
  let response = { results: [classified] }, prompt;
  const runner = mockRunner();
  const wrapped = async args => { prompt = args.prompt; return { data: response, model: CODEX_MODEL, usage: { inputTokens: 12, outputTokens: 8 } }; };
  wrapped.status = runner.status;
  const { providers } = await setup(t, { codexRunner: wrapped });
  assert.equal((await providers.classify('codex', { cards })).results[0].id, 'graft');
  assert.ok(!prompt.includes('DO_NOT_SEND'));
  for (const bad of [{ ...classified, id: 'wrong' }, { ...classified, artifact: 'made-up' }, { ...classified, evidenceIds: ['invented'] }, { ...classified, confidence: 2 }]) {
    response = { results: [bad] };
    await assert.rejects(providers.classify('codex', { cards }), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
  response = { results: [classified, classified] };
  await assert.rejects(providers.classify('codex', { cards }), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('Codex plan and rank reject unsafe URLs and incomplete candidate membership', async t => {
  let data = { queries: ['Codex agent memory'], urls: ['https://github.com/papercomputeco/graft'] };
  let schema;
  const runner = async args => { schema = args.schema; return { data, model: CODEX_MODEL, usage: { inputTokens: 10, outputTokens: 5 } }; };
  const { providers } = await setup(t, { codexRunner: runner });
  assert.equal((await providers.plan({ query: 'persistent memory' })).queries.length, 1);
  assert.equal(schema.properties.urls.items.format, undefined, 'Codex rejects the unsupported URI format annotation');
  assert.equal(schema.properties.urls.items.maxLength, 2048);
  data = { queries: ['memory'], urls: ['not-a-url'] };
  await assert.rejects(providers.plan({ query: 'memory' }), { code: 'INVALID_PROVIDER_RESPONSE' });
  data = { queries: ['memory'], urls: ['http://localhost:1234'] };
  await assert.rejects(providers.plan({ query: 'memory' }), { code: 'INVALID_PROVIDER_RESPONSE' });
  data = { results: [] };
  await assert.rejects(providers.rank('codex', { query: 'memory', cards }), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('Codex turn errors expose useful fixed diagnostics without upstream secrets', () => {
  const schemaError = codexTurnFailure({ message: `Invalid schema: format uri not supported. Authorization=${fixtureKey}`, codexErrorInfo: 'other' });
  assert.equal(schemaError.code, 'CODEX_SCHEMA');
  assert.deepEqual(schemaError.diagnostics.schemaKeywords, ['format', 'uri']);
  assert.ok(!JSON.stringify(schemaError).includes(fixtureKey));
  const usageError = codexTurnFailure({ message: fixtureKey, codexErrorInfo: 'usageLimitExceeded' });
  assert.match(usageError.message, /usage limit/u);
  assert.ok(!usageError.message.includes(fixtureKey));
  const arbitraryError = codexTurnFailure({ message: fixtureKey, codexErrorInfo: { [fixtureKey]: { httpStatusCode: 401 } } });
  assert.equal(arbitraryError.diagnostics.upstreamCode, 'unknown');
  assert.ok(!JSON.stringify(arbitraryError).includes(fixtureKey));
});

test('Codex cancellation bounds even a runner that ignores the signal; diagnostics are cached', async t => {
  let probes = 0, signal;
  const runner = args => { signal = args.signal; return new Promise(() => {}); };
  runner.status = async () => { probes++; return { configured: true, authenticated: true, available: true, model: CODEX_MODEL }; };
  const { providers } = await setup(t, { codexRunner: runner });
  await Promise.all([providers.status(), providers.status(), providers.status()]);
  assert.equal(probes, 1);
  await providers.status(); assert.equal(probes, 1);
  await providers.status({ force: true }); assert.equal(probes, 2);
  await assert.rejects(providers.classify('codex', { cards, timeoutMs: 25 }), { code: 'TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('invalid batches and provider/model names fail before any upstream call', async t => {
  const { providers } = await setup(t, { fetchImpl: () => { throw new Error('must not reach network'); } });
  await assert.rejects(providers.classify('jev', { cards: [cards[0], cards[0]] }), { code: 'INVALID_CARDS' });
  await assert.rejects(providers.classify('other', { cards }), { code: 'INVALID_PROVIDER' });
  await assert.rejects(providers.classify('jev', { cards, model: 'other' }), { code: 'INVALID_MODEL' });
  await assert.rejects(providers.plan({ query: '' }), { code: 'INVALID_QUERY' });
});

test('Jev measures actual projected question overhead and rejects oversize requests before credentials or fetch', async t => {
  const enriched = Array.from({ length: 3 }, (_, index) => ({
    id: `source-${index}`, name: `Repository ${index}`, description: 'd'.repeat(1200),
    evidenceIds: [0, 1, 2].map(n => `readme-${index}-${n}`),
    evidence: [0, 1, 2].map(n => ({ id: `readme-${index}-${n}`, url: `https://example.org/${index}/${n}`, excerpt: 'e'.repeat(2000) })),
    privateNote: 'DO_NOT_SEND'
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(enriched)) < 25000, 'The old cards-only threshold admits this real-shaped batch');
  const oversized = measureJevClassificationBatch(enriched);
  assert.ok(oversized.bodyBytes > 60000);
  assert.equal(oversized.fits, false);
  let loads = 0, fetches = 0, actual;
  const { providers } = await setup(t, {
    credentialStore: { load: async () => { loads++; return fixtureKey; } },
    fetchImpl: async (_, init) => { fetches++; actual = JSON.parse(init.body); return json(jevReply(actual)); }
  });
  await assert.rejects(providers.classify('jev', { cards: enriched }), error => error.code === 'INVALID_CARDS' && isDefinitelyUnsentProviderError(error));
  assert.equal(loads, 0); assert.equal(fetches, 0);
  const fitting = enriched.slice(0, 1);
  fitting[0] = { ...fitting[0], description: '界\\\"'.repeat(350) };
  const measured = measureJevClassificationBatch(fitting);
  assert.equal(measured.fits, true);
  await providers.classify('jev', { cards: fitting });
  assert.equal(fetches, 1);
  assert.equal(measured.bodyBytes, Buffer.byteLength(JSON.stringify(actual)));
  assert.equal(measured.stateBytes, Buffer.byteLength(JSON.stringify(actual.state)));
  assert.equal(measured.longestQuestionBytes, Math.max(...Object.values(actual.questions).map(q => Buffer.byteLength(JSON.stringify(q)))));
  assert.doesNotMatch(JSON.stringify(actual), /DO_NOT_SEND/);
  assert.equal(isDefinitelyUnsentProviderError(Object.assign(new Error('forged'), { code: 'INVALID_CARDS', requestSent: false })), false);
});

test('Jev credential timeout is definitely unsent and cannot start a late request, while network failure remains uncertain', async t => {
  let release, fetches = 0;
  const credentialStore = { load: () => new Promise(resolve => { release = resolve; }) };
  const { providers } = await setup(t, { credentialStore, fetchImpl: async () => { fetches++; throw new Error('Synthetic disconnected transport'); } });
  await assert.rejects(providers.classify('jev', { cards, timeoutMs: 20 }), error => error.code === 'TIMEOUT' && isDefinitelyUnsentProviderError(error));
  release(fixtureKey);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fetches, 0);
  credentialStore.load = async () => fixtureKey;
  await assert.rejects(providers.classify('jev', { cards }), error => error.code === 'PROVIDER_NETWORK' && !isDefinitelyUnsentProviderError(error));
  assert.equal(fetches, 1);
});

test('worker restrictions deny host capabilities without changing global approval or trust settings', () => {
  for (const name of ['shell_tool', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'multi_agent', 'memories', 'code_mode_host']) assert.equal(CODEX_RESTRICTIONS.features[name], false);
  assert.equal(CODEX_RESTRICTIONS.project_doc_max_bytes, 0);
  assert.equal(CODEX_RESTRICTIONS.web_search, 'disabled');
  assert.equal(CODEX_RESTRICTIONS.approval_policy, undefined);
  assert.equal(CODEX_RESTRICTIONS.projects, undefined);
});
