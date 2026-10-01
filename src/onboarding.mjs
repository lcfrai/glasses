import { createHash, randomUUID } from 'node:crypto';
import { validatePublicCatalogue } from './public-catalogue.mjs';

export const SHARED_CATALOGUE_URL = 'https://lcfr.ai/glasses/catalogue.json';
export const CATALOGUE_MAX_BYTES = 192 * 1024 * 1024;
const KEY = 'catalogueOnboardingV1';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const stamp = () => new Date().toISOString();

// A status read never fetches. Each import needs a new explicit action, including
// after a previous failure or successful first-run consent. No model hook runs.
export function createOnboarding({ store, fetchImpl = fetch, timeoutMs = 120000, maxBytes = CATALOGUE_MAX_BYTES } = {}) {
  const leaseKey = 'catalogueImportLeaseV1';
  let current = null, controller = null, closed = false;
  const saved = () => store.getSetting(KEY, { version: 1, choice: 'pending', decidedAt: null, lastAttempt: null, lastSuccess: null });
  function status() {
    const value = saved();
    let attempt = value.lastAttempt;
    // A process killed during download is never silently retried. Its expired
    // lease becomes a visible interrupted attempt, without mutating on a read.
    if (attempt?.status === 'fetching' && Date.parse(attempt.expiresAt) <= Date.now()) {
      attempt = { ...attempt, status: 'interrupted', error: 'The previous import was interrupted. Choose Import latest catalogue to retry.' };
    }
    const importing = attempt?.status === 'fetching';
    return { ...value, sourceUrl: SHARED_CATALOGUE_URL, lastAttempt: attempt, importing,
      status: importing ? 'importing' : value.choice === 'decline' ? 'declined' : ['failed', 'interrupted'].includes(attempt?.status) ? 'failed' : value.lastSuccess ? 'ready' : 'pending' };
  }
  async function acquire() {
    if (closed) throw failure('Catalogue setup is closed', 503);
    const lease = { id: randomUUID(), expiresAt: new Date(Date.now() + timeoutMs + 60000).toISOString() };
    // BEGIN IMMEDIATE in the store makes expiry/replacement atomic across a
    // running HTTP app and a separate CLI process using the same directory.
    if (!store.acquireSettingLease(leaseKey, lease)) throw failure('A catalogue import is already running. Wait for it to finish.', 409);
    return lease;
  }
  async function release(lease) {
    store.releaseSettingLease(leaseKey, lease.id);
  }
  async function withDeadline(promise, signal) {
    signal.throwIfAborted();
    let listener;
    const aborted = new Promise((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }); });
    try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', listener); }
  }
  async function download(signal) {
    signal.throwIfAborted();
    const response = await withDeadline(fetchImpl(SHARED_CATALOGUE_URL, {
      method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Glasses-local-catalogue-setup/1' }
    }), signal);
    const cancelBody = () => withDeadline(response.body?.cancel(), signal).catch(() => {});
    if (!response.ok) { await cancelBody(); throw failure(`The shared catalogue returned HTTP ${response.status}. Your local catalogue was not changed.`, 502); }
    if (response.redirected || (response.url && response.url !== SHARED_CATALOGUE_URL)) { await cancelBody(); throw failure('The catalogue response changed URL; no import was made.', 502); }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxBytes) { await cancelBody(); throw failure('The shared catalogue exceeds its download size limit.', 502); }
    if (!response.body) throw failure('The shared catalogue response was empty.', 502);
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await withDeadline(reader.read(), signal); if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw failure('The shared catalogue exceeds its download size limit.', 502);
        chunks.push(Buffer.from(value));
      }
    } finally { await withDeadline(reader.cancel(), signal).catch(() => {}); reader.releaseLock(); }
    signal.throwIfAborted();
    const body = Buffer.concat(chunks);
    // This validates every record, citation and content hash before the store's
    // atomic shared-layer import. No downloaded code is evaluated.
    const snapshot = validatePublicCatalogue(body.toString('utf8'));
    return { snapshot, responseBytes: bytes, sha256: createHash('sha256').update(body).digest('hex') };
  }
  async function runImport() {
    const lease = await acquire();
    controller = new AbortController();
    if (closed) controller.abort();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const startedAt = stamp();
    const attempt = { id: lease.id, status: 'fetching', startedAt, expiresAt: lease.expiresAt, completedAt: null, error: null };
    const before = saved();
    store.setSetting(KEY, { ...before, choice: 'import', decidedAt: stamp(), lastAttempt: attempt });
    try {
      const { snapshot, ...receipt } = await download(signal);
      signal.throwIfAborted();
      const report = await store.importPublicCatalogue(snapshot);
      const completed = { ...attempt, ...receipt, status: 'imported', completedAt: stamp(), report,
        snapshot: { contentHash: snapshot.contentHash, generatedAt: snapshot.generatedAt, counts: snapshot.counts } };
      store.setSetting(KEY, { ...saved(), lastAttempt: completed, lastSuccess: completed });
      return status();
    } catch (error) {
      const message = signal.aborted ? 'The catalogue download was cancelled or exceeded its time limit. Choose Import latest catalogue to retry.'
        : error.status ? error.message : /public catalogue|public candidate|public citation|Assessment cites|licence metadata|Stars require/i.test(error.message) ? 'The shared catalogue failed strict validation. Your local catalogue was not changed.'
        : 'The shared catalogue could not be downloaded. Your local catalogue was not changed; retry when the connection is available.';
      store.setSetting(KEY, { ...saved(), lastAttempt: { ...attempt, status: 'failed', completedAt: stamp(), error: message } });
      throw Object.assign(failure(message, 502), { onboarding: status() });
    } finally { controller = null; await release(lease); }
  }
  async function importLatest(input) {
    if (!input || Object.keys(input).length !== 1 || input.approved !== true) throw failure('Import requires explicit approved: true');
    if (current) throw failure('A catalogue import is already running. Wait for it to finish.', 409);
    current = runImport();
    try { return await current; } finally { current = null; }
  }
  async function choose(input) {
    if (!input || Object.keys(input).length !== 1 || !['import', 'decline'].includes(input.choice)) throw failure('Choose import or decline explicitly');
    if (input.choice === 'import') return importLatest({ approved: true });
    if (current) throw failure('Wait for the current catalogue import to finish.', 409);
    const lease = await acquire();
    try { store.setSetting(KEY, { ...saved(), choice: 'decline', decidedAt: stamp() }); return status(); }
    finally { await release(lease); }
  }
  return { status, choose, importLatest, async close() { closed = true; controller?.abort(); await current?.catch(() => {}); } };
}
