import { createHash } from 'node:crypto';

// Wire shape stays compatible. Policy versions describe the evidence semantics.
export const CLASSIFICATION_SCHEMA = 'glasses-evidence-v2';
export const LEGACY_CLASSIFICATION_POLICY = 'glasses-evidence-v2';
export const CLASSIFICATION_POLICY = 'glasses-purpose-v3';
export const REGISTRY_COMPONENT_SOURCE_SELECTION = 'registry-component-exact-url-v1';

// A component's provider namespace is part of its identity. A bare name is
// never enough: many independent registries publish "button" or "accordion".
export function registryIndexItemURL(entry) {
  const base=entry?.registry?.basePath,name=entry?.name;
  if(!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(base||'')||typeof name!=='string'||!name||name.length>200)return null;
  return `https://registry.directory${base}/${encodeURIComponent(name)}`;
}
export function registryComponentIdentity(value) {
  if(typeof value!=='string')return null;
  const match=value.match(/^https:\/\/registry\.directory(\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/([^/?#]+)$/);
  if(!match)return null;
  try{const name=decodeURIComponent(match[2]),canonical=registryIndexItemURL({registry:{basePath:match[1]},name});return canonical===value&&new URL(value).href===value?{url:value,basePath:match[1],name}:null;}catch{return null;}
}

// Shared by local assessment freshness and strict public projection. Callers
// supply the same bounded public base and ordered evidence IDs, never private
// outcomes/corrections. Non-registry legacy inputs keep their original hash
// algorithm; registry children intentionally invalidate pre-identity excerpts.
export function classificationFingerprint({ base, evidenceIds, revision = null, sourceHash = null, policy = CLASSIFICATION_POLICY }) {
  if (![LEGACY_CLASSIFICATION_POLICY, CLASSIFICATION_POLICY].includes(policy)) throw new Error('Unknown classification policy');
  const input = { schema: CLASSIFICATION_SCHEMA, ...(policy === LEGACY_CLASSIFICATION_POLICY ? {} : { policy }), ...(registryComponentIdentity(base?.url)?{sourceSelection:REGISTRY_COMPONENT_SOURCE_SELECTION}:{}), ...base, evidenceIds, revision, sourceHash };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
