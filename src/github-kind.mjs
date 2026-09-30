// A conservative source-metadata heuristic shared by discovery and publication.
// These are explicit library/UI signals, not arbitrary occurrences of "component"
// (for example monitoring IT components or an application's PDF-viewer topic).
const uiTopics = new Set([
  'component-library', 'components-library', 'ui-library', 'ui-components',
  'react-components', 'react-ui', 'vue-components', 'vue-ui',
  'angular-components', 'angular-ui-components', 'svelte-components',
  'svelte-ui', 'web-components-library', 'ui-kit', 'uikit',
]);
const uiPhrase = /\b(?:components?[ -]+librar(?:y|ies)|ui[ -]+(?:components?|librar(?:y|ies)|kit|toolkit)|(?:react(?:[ -]+native)?|vue(?:[ -]+\d+)?|angular|svelte)[ -]+components?)\b/i;

export function githubRepositoryKind(repo) {
  const name = typeof repo?.name === 'string' ? repo.name : '';
  if (/\b(?:samples|tutorials?|examples)\b/i.test(name)) return 'pattern';
  const topics = Array.isArray(repo?.topics) ? repo.topics : [];
  if (topics.some(topic => typeof topic === 'string' && uiTopics.has(topic.toLowerCase()))) return 'component';
  const description = typeof repo?.description === 'string' ? repo.description : '';
  return uiPhrase.test(`${name} ${description}`) ? 'component' : 'solution';
}
