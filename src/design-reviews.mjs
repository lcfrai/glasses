import { createHash, randomUUID } from 'node:crypto';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const clone = value => JSON.parse(JSON.stringify(value));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
const now = () => new Date().toISOString();
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
function object(value, label, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid(`${label} must be a plain object`);
  for (const key of Object.keys(value)) if (blockedKeys.has(key) || (allowed && !allowed.includes(key))) throw invalid(`Unknown ${label} field: ${key}`);
}
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw invalid(`${label} must be ${required ? 'non-empty ' : ''}text of at most ${max} characters`);
  return value.trim();
}
function link(value, label) {
  text(value, label, 2000, true);
  let url; try { url = new URL(value); } catch { throw invalid(`${label} must be an absolute HTTP or HTTPS URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid(`${label} must be an HTTP or HTTPS URL without credentials`);
  // Metadata only: no fetch, file access or navigation is performed here.
  return url.href;
}
function parameters(value = {}, label = 'parameters') {
  object(value, label);
  if (Object.keys(value).length > 24) throw invalid(`${label} allows at most 24 keys`);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) throw invalid(`Invalid ${label} key`);
    if (!(item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e9) || (typeof item === 'string' && item.length <= 500 && !/[\u0000-\u001f]/.test(item)))) throw invalid(`${label} values must be bounded JSON primitives`);
    result[key] = item;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 4000) throw invalid(`${label} exceeds 4000 bytes`);
  return result;
}
function options(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) throw invalid('Provide between 2 and 12 design options');
  const ids = new Set();
  return value.map(item => {
    object(item, 'option', ['id', 'label', 'description', 'previewUrl', 'workspaceId', 'capabilityIds', 'sourceRefs', 'parameters']);
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id) || ids.has(item.id)) throw invalid('Design option ids must be unique safe identifiers');
    ids.add(item.id);
    const result = { id: item.id, label: text(item.label, 'option label', 200, true), description: text(item.description ?? '', 'option description', 2000), parameters: parameters(item.parameters) };
    if (item.previewUrl !== undefined) result.previewUrl = link(item.previewUrl, 'previewUrl');
    if (item.workspaceId !== undefined) {
      if (typeof item.workspaceId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(item.workspaceId)) throw invalid('Invalid workspaceId');
      result.workspaceId = item.workspaceId;
    }
    if (item.capabilityIds !== undefined) {
      if (!Array.isArray(item.capabilityIds) || item.capabilityIds.length > 20 || item.capabilityIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id))) throw invalid('capabilityIds must contain at most 20 catalogue ids');
      result.capabilityIds = [...new Set(item.capabilityIds)];
    }
    if (item.sourceRefs !== undefined) {
      if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length > 12) throw invalid('sourceRefs allows at most 12 citations per option');
      result.sourceRefs = item.sourceRefs.map(ref => {
        object(ref, 'source reference', ['url', 'sha256', 'label']);
        const source = { url: link(ref.url, 'source reference URL') };
        if (ref.sha256 !== undefined) {
          if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw invalid('Source SHA-256 must be 64 lowercase hexadecimal characters');
          source.sha256 = ref.sha256;
        }
        if (ref.label !== undefined) source.label = text(ref.label, 'source reference label', 200);
        return source;
      });
    }
    return result;
  });
}
function fields(input, partial = false) {
  object(input, 'design review', partial ? ['title', 'brief', 'options', 'expectedVersion'] : ['title', 'brief', 'options']);
  const output = {};
  if (!partial || input.title !== undefined) output.title = text(input.title, 'title', 200, true);
  if (!partial || input.brief !== undefined) output.brief = text(input.brief, 'brief', 8000, true);
  if (!partial || input.options !== undefined) output.options = options(input.options);
  if (partial && !Object.keys(output).length) throw invalid('Provide title, brief or options to amend a design review');
  if (Buffer.byteLength(JSON.stringify(output)) > 64000) throw invalid('Design review content exceeds 64000 bytes');
  return output;
}
function version(previous, expected) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw invalid('expectedVersion is required and must be a positive integer');
  if (expected !== previous.version) throw invalid(`Design review changed since version ${expected}; current version is ${previous.version}. Reload before editing or choosing.`, 409);
}
function fingerprint(review) {
  return createHash('sha256').update(canonical({ brief: review.brief, options: review.options })).digest('hex');
}
function archive(previous, action, at, notes) {
  if (!previous.decision) return previous.decisionHistory;
  // Never prune prior decisions silently. Refuse further decisions if this local
  // audit reaches its explicit bound; a new board can continue the conversation.
  if (previous.decisionHistory.length >= 1000) throw invalid('This review has reached its decision history limit; create a new board to retain the audit', 409);
  return [...previous.decisionHistory, { action, at, version: previous.version, ...(notes ? {notes} : {}), decision: clone(previous.decision) }];
}

export function makeDesignReview(input) {
  const content = fields(input), stamp = now();
  return { id: randomUUID(), ...content, version: 1, contentHash: fingerprint(content), status: 'open', decision: null, decisionHistory: [], createdAt: stamp, updatedAt: stamp };
}
export function reviseDesignReview(previous, input) {
  const patch = fields(input, true); version(previous, input.expectedVersion);
  const merged = { ...previous, ...patch };
  if (Buffer.byteLength(JSON.stringify({ title: merged.title, brief: merged.brief, options: merged.options })) > 64000) throw invalid('Design review content exceeds 64000 bytes');
  if (canonical({ title: previous.title, brief: previous.brief, options: previous.options }) === canonical({ title: merged.title, brief: merged.brief, options: merged.options })) return previous;
  const contentHash = fingerprint(merged), changed = contentHash !== previous.contentHash, stamp = now();
  return { ...merged, contentHash, version: previous.version + 1, updatedAt: stamp,
    ...(changed ? { status: 'open', decision: null, decisionHistory: archive(previous, 'invalidated', stamp) } : {}) };
}
export function decideDesignReview(previous, input) {
  object(input, 'design decision', ['expectedVersion', 'optionId', 'parameters', 'notes']);
  version(previous, input.expectedVersion);
  const notes = text(input.notes ?? '', 'decision notes', 4000);
  if (input.optionId === null) {
    if (input.parameters !== undefined && Object.keys(parameters(input.parameters)).length) throw invalid('Clearing a choice cannot include parameters');
    if (!previous.decision) return previous;
    const stamp = now();
    return { ...previous, version: previous.version + 1, status: 'open', decision: null, decisionHistory: archive(previous, 'cleared', stamp, notes), updatedAt: stamp };
  }
  const chosen = previous.options.find(option => option.id === input.optionId);
  if (!chosen) throw invalid('Choose an option in this review, or use explicit null to clear the choice');
  const supplied = parameters(input.parameters);
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(chosen.parameters, key)) throw invalid(`Undeclared option parameter: ${key}`);
    const base = chosen.parameters[key];
    if ((base === null) !== (value === null) || (base !== null && typeof base !== typeof value)) throw invalid(`Parameter ${key} must match its declared type`);
  }
  const stamp = now();
  return { ...previous, version: previous.version + 1, status: 'decided', updatedAt: stamp,
    decisionHistory: archive(previous, 'replaced', stamp),
    decision: { optionId: chosen.id, parameters: { ...chosen.parameters, ...supplied }, notes, reviewVersion: previous.version, contentHash: previous.contentHash, decidedAt: stamp, optionSnapshot: clone(chosen), briefSnapshot: previous.brief } };
}
