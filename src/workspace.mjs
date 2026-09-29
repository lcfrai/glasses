import { readFileSync } from 'node:fs';

export const REVIEWED_PACKAGES = ['react', 'react-dom', 'clsx', 'tailwind-merge', 'lucide-react', 'radix-ui', 'motion', 'recharts', 'class-variance-authority'];
// Exact package entry points only; no arbitrary package or filesystem resolution.
export const REVIEWED_IMPORTS = [...REVIEWED_PACKAGES, 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'motion/react', 'motion/react-client', ...['accordion','alert-dialog','aspect-ratio','avatar','checkbox','collapsible','context-menu','dialog','dropdown-menu','hover-card','label','menubar','navigation-menu','popover','progress','radio-group','scroll-area','select','separator','slider','slot','switch','tabs','toast','toggle','toggle-group','toolbar','tooltip','visually-hidden'].map(name=>'radix-ui/'+name)];
export const STYLE_PROPERTIES = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'margin', 'borderRadius', 'gap'];
export const SELECTOR_PATTERN = /^\[data-glasses-root\](?: > :nth-child\([1-9]\d{0,3}\)){1,16}$/;

export function reviewedDependencies() {
  return Object.fromEntries(REVIEWED_PACKAGES.map(name => [name, JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version]));
}

export function normalizeFiles({ source, files, entryPath = 'source.tsx' } = {}) {
  const validPath = value => typeof value === 'string' && value.length <= 240 && /^[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)*\.(?:tsx?|jsx?|css|json)$/.test(value) && !value.split('/').some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) && !value.toLowerCase().includes('node_modules');
  if (!validPath(entryPath) || !/\.[jt]sx?$/.test(entryPath)) throw new Error('entryPath must name a workspace JavaScript or TypeScript file.');
  if (files !== undefined && (!Array.isArray(files) || files.length > 40)) throw new Error('Provide at most 40 workspace files.');
  const result = (files || []).map(file => {
    if (!file || !validPath(file.path) || typeof file.content !== 'string') throw new Error('Workspace files need safe relative source paths and text content.');
    if (Buffer.byteLength(file.content) > 100_000) throw new Error('Each workspace source file must be at most 100 KB.');
    return { path: file.path, content: file.content };
  });
  let entry = result.find(file => file.path === entryPath);
  if (source !== undefined) {
    if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 100_000) throw new Error('Provide React source up to 100 KB.');
    if (entry) entry.content = source; else { entry = { path: entryPath, content: source }; result.unshift(entry); }
  }
  if (result.length > 40) throw new Error('Provide at most 40 workspace files, including the entry file.');
  if (new Set(result.map(file => file.path.toLowerCase())).size !== result.length) throw new Error('Duplicate workspace file paths are not supported.');
  if (!entry || !entry.content.trim()) throw new Error('Workspace entry file is missing or empty.');
  if (result.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 350_000) throw new Error('Workspace files must total at most 350 KB.');
  return { files: result, entryPath, source: entry.content };
}

export function normalizeVisualEdits(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 100) throw new Error('Visual edits must be an object with at most 100 element selectors.');
  const output = {};
  for (const [selector, styles] of Object.entries(value)) {
    if (!SELECTOR_PATTERN.test(selector) || !styles || Array.isArray(styles) || typeof styles !== 'object') throw new Error('Visual edits require a supported canvas element selector and style object.');
    const checked = {};
    for (const [property, content] of Object.entries(styles)) {
      if (!STYLE_PROPERTIES.includes(property) || typeof content !== 'string' || content.length > 100 || /[;{}<>\\]|url\s*\(|expression\s*\(|@/i.test(content)) throw new Error('Unsupported visual style property or value.');
      checked[property] = content.trim();
    }
    output[selector] = checked;
  }
  return output;
}

export function visualStyles(value) {
  return Object.entries(normalizeVisualEdits(value)).map(([selector, styles]) => `${selector} {\n${Object.entries(styles).filter(([, content]) => content).map(([property, content]) => `  ${property.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}: ${content} !important;`).join('\n')}\n}`).join('\n');
}
