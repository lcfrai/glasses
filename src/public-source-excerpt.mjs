import { createHash } from 'node:crypto';

// Changing selection semantics must invalidate source-card caches. This version
// describes excerpt selection, not the immutable upstream document identity.
export const PUBLIC_SOURCE_EXCERPT_VERSION = 'readme-purpose-sections-v1';
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_EXCERPT_BYTES = 7000;
const bytes = value => Buffer.byteLength(value, 'utf8');
const clip = (value, limit) => {
  if (bytes(value) <= limit) return value;
  let out = '', used = 0;
  for (const character of value) { const size = bytes(character); if (used + size > limit) break; out += character; used += size; }
  return out;
};
const skippedHeading = /\b(sponsors?|sponsorship|backers?|donat(?:e|ions?)|supporters?|support (?:us|the project)|contributors?|contribut(?:ing|ion|e)|acknowledg(?:e)?ments?|code of conduct|community|connect with me|stay in touch|star history|table of contents|contents|roadmap|release history|changelog|licen[cs]e|copyright|badges|translations?|other projects)\b|特别感谢|赞助|贡献者|作者的另一个|致谢/i;
const categoryFor = heading => /\b(install(?:ation)?|usage|quick\s?start|quick start|get(?:ting)? started|how to (?:use|run|install)|download|deployment|prerequisites?|requirements?|setup|configuration|using\b|run locally|try it)\b|安装|部署|快速开始|使用方式|配置要求/i.test(heading) ? 'adoption'
  : /\b(features?|capabilities|what (?:it|we) (?:does|do|offers?|provides?)|use cases?|highlights?|how it works|supported (?:formats|frameworks|platforms))\b|功能|特性/i.test(heading) ? 'features'
    : /\b(overview|introduction|about|what is|why\b)\b/.test(heading.toLowerCase()) ? 'overview' : 'other';
const warning = /\b(deprecated|end[ -]of[ -]life|unmaintained|no longer (?:maintained|supported|receives)|inactive repository|archived|not (?:ready|intended|recommended) for production)\b/i;
const entity = value => value.replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39|#x27);/gi, token => ({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&#x27;':"'"})[token.toLowerCase()]);

function clean(line) {
  // Keep link labels, never remote image/iframe content. These are plain-text
  // excerpts only; HTML and source instructions are never executed.
  if (/^\s*\[[^\]]+\]:\s*\S+/.test(line)) return '';
  if (/href=["'][^"']*(?:\/i18n\/|README[.-][a-z]{2}(?:[_.-][a-z]{2})?\.)/i.test(line)) return '';
  return entity(line
    .replace(/!\[[^\]]*\]\([^\n]*?\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]*)\]\([^\n]*?\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g, '')
    .replace(/^\s*>\s?/, '').replace(/[ \t]+/g, ' ').trim());
}

function blocksFrom(text) {
  const lines = text.split(/\r?\n/), blocks = [], headingStack = [];
  let paragraph = null, fence = null, hiddenTag = null, inComment = false;
  const flush = () => { if (paragraph?.text.trim()) blocks.push(paragraph); paragraph = null; };
  const section = () => headingStack.at(-1) || { title: '', category: 'overview', skip: false };
  for (let index = 0; index < lines.length; index++) {
    let raw = lines[index];
    // Comments and script/style payloads can span lines. Preserve source line
    // positions independently of the normalized output.
    if (inComment) { const end = raw.indexOf('-->'); if (end < 0) continue; raw = raw.slice(end + 3); inComment = false; }
    raw = raw.replace(/<!--[\s\S]*?-->/g, '');
    const comment = raw.indexOf('<!--'); if (comment >= 0) { raw = raw.slice(0, comment); inComment = true; }
    if (hiddenTag) { const end = new RegExp(`</${hiddenTag}\\s*>`, 'i').exec(raw); if (!end) continue; raw = raw.slice(end.index + end[0].length); hiddenTag = null; }
    raw = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const hidden = /<(script|style)\b[^>]*>/i.exec(raw); if (hidden) { hiddenTag = hidden[1]; raw = raw.slice(0, hidden.index); }
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fenceMatch) {
      flush();
      if (!fence) fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      else if (fence.marker === fenceMatch[1][0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) {
      const current = section();
      if (current.skip || !['adoption', 'features'].includes(current.category)) continue;
      const value = raw.trimEnd(); if (!value.trim()) { flush(); continue; }
      if (!paragraph) paragraph = { text: '', startLine: index + 1, endLine: index + 1, section: current.title, category: current.category, code: true };
      // A code example can demonstrate adoption, but cannot consume the whole
      // card. Its original line range and document hash remain inspectable.
      const remaining = Math.max(0, 800 - bytes(paragraph.text) - (paragraph.text ? 1 : 0)), fragment = clip(value, remaining);
      if (fragment) paragraph.text += (paragraph.text ? '\n' : '') + fragment;
      if (fragment !== value) paragraph.sourceTruncated = true;
      paragraph.endLine = index + 1; continue;
    }
    let heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw), depth, title; const headingLine = index + 1;
    if (heading) { depth = heading[1].length; title = clean(heading[2]); }
    else {
      const htmlHeading = /^\s*<h([1-6])\b[^>]*>(.*?)<\/h\1>\s*$/i.exec(raw);
      if (htmlHeading) { depth = Number(htmlHeading[1]); title = clean(htmlHeading[2]); }
      else if (raw.trim() && index + 1 < lines.length && /^\s*(?:={3,}|-{3,})\s*$/.test(lines[index + 1])) { depth = lines[index + 1].trim()[0] === '=' ? 1 : 2; title = clean(raw); index++; }
    }
    if (title !== undefined) {
      flush(); while (headingStack.length && headingStack.at(-1).depth >= depth) headingStack.pop();
      const parent = section(), ownCategory = categoryFor(title), skip = parent.skip || skippedHeading.test(title);
      const category = warning.test(title) ? 'warning' : ownCategory === 'other' ? parent.category : ownCategory;
      headingStack.push({ depth, title, skip, category });
      // Some READMEs put their entire product definition in an h3/h4 subtitle.
      // Keep that source text even when the following content is only badges.
      if (!skip && (warning.test(title) || title.length >= 40)) blocks.push({ text: title, startLine: headingLine, endLine: headingLine, section: title, category });
      continue;
    }
    const current = section(); if (current.skip) continue;
    const value = clean(raw);
    if (/^(?:ad|advertisement|sponsored)$/i.test(value) && /<sup\b|advertis/i.test(raw)) {
      flush(); const previous = blocks.at(-1);
      // Only remove an adjacent quoted outbound promotion. An image-only ad
      // must not cause the preceding legitimate introduction to disappear.
      if (previous && index + 1 - previous.endLine <= 3 && /^\s*>/.test(lines[previous.startLine - 1]) && /\]\(https?:\/\//.test(lines.slice(previous.startLine - 1, previous.endLine).join('\n'))) blocks.pop();
      continue;
    }
    const chrome = !value || /^[^\p{L}\p{N}]*$/u.test(value) || /^https?:\/\/\S+$/i.test(value) || /^(?:website|docs?|documentation|discord|twitter|community|tutorial|english|简体中文|繁體中文)(?:\s*[|·•—/]\s*(?:website|docs?|documentation|discord|twitter|community|tutorial|english|简体中文|繁體中文))*$/i.test(value) || /^\s*[-*+]\s*\[[^\]]+\]\(#[^)]*\)\s*$/.test(raw);
    if (chrome) { flush(); continue; }
    // Keep feature lists and paragraphs separate so one huge directory/table
    // cannot crowd out a later documented installation or usage section.
    const list = /^\s*(?:[-*+]\s|\d+[.)]\s|\|)/.test(value);
    if (list || paragraph?.code || paragraph && bytes(paragraph.text) > 900) flush();
    const category = warning.test(value) ? 'warning' : current.category;
    if (paragraph && paragraph.category !== category) flush();
    if (!paragraph) paragraph = { text: '', startLine: index + 1, endLine: index + 1, section: current.title, category };
    paragraph.text += (paragraph.text ? '\n' : '') + value; paragraph.endLine = index + 1;
    if (list) flush();
  }
  flush();
  const seen = new Set();
  return blocks.filter(block => { const key = block.text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

/** Select bounded evidence from an already identity/hash-verified public README.
 * This is not a sanitizer or authority boundary: output remains untrusted data.
 * No source fetches, file access, instructions, installation or inference occur.
 */
export function selectPublicSourceExcerpt(source, { maxBytes = 6500 } = {}) {
  if (typeof source !== 'string' || bytes(source) > MAX_SOURCE_BYTES) throw new TypeError('Expected a public README string no larger than 4 MiB');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_EXCERPT_BYTES) throw new TypeError('maxBytes must be an integer from 256 to 7000');
  const sourceBytes = bytes(source), sourceSha256 = createHash('sha256').update(source).digest('hex'), blocks = blocksFrom(source.toWellFormed()), picked = new Map();
  let used = 0;
  const include = (block, allowance) => {
    if (picked.has(block) || allowance < 40 || maxBytes - used < 40) return 0;
    const prefix = `[${block.section ? clip(block.section, 120) + '; ' : ''}README lines ${block.startLine}-${block.endLine}]\n`;
    const available = Math.min(allowance, maxBytes - used) - bytes(prefix) - (picked.size ? 2 : 0);
    if (available < 24) return 0;
    const text = clip(block.text, available); const record = { ...block, text, rendered: prefix + text, truncated: Boolean(block.sourceTruncated) || text !== block.text };
    const size = bytes(record.rendered) + (picked.size ? 2 : 0); picked.set(block, record); used += size; return size;
  };
  // Reserve room for purpose AND actual adoption instead of simply extending
  // the old raw prefix. Unused category space is filled in a second pass.
  const fractions = { warning: .12, overview: .28, features: .27, adoption: .30 };
  for (const [category, fraction] of Object.entries(fractions)) {
    let remaining = Math.floor(maxBytes * fraction);
    for (const block of blocks.filter(value => value.category === category)) remaining -= include(block, remaining);
  }
  for (const category of ['overview', 'features', 'adoption', 'warning', 'other']) {
    for (const block of blocks.filter(value => value.category === category)) include(block, maxBytes - used);
  }
  const selected = [...picked.values()].sort((a, b) => a.startLine - b.startLine);
  const text = selected.map(block => block.rendered).join('\n\n');
  return { text, version: PUBLIC_SOURCE_EXCERPT_VERSION, sourceSha256, sourceBytes, excerptBytes: bytes(text), selected: selected.map(({ startLine, endLine, section, category, truncated }) => ({ startLine, endLine, section, category, truncated })), truncated: selected.length < blocks.length || selected.some(block => block.truncated) };
}
