import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validatePublicURL } from './discovery.mjs';
import { stableId, licenseInfo } from './store.mjs';
import { ARTIFACTS, ADOPTIONS, INTELLIGENCE_SCHEMA } from './intelligence.mjs';
import { githubRepositoryKind } from './github-kind.mjs';
import { classificationFingerprint, LEGACY_CLASSIFICATION_POLICY, registryComponentIdentity, registryIndexItemURL } from './classification-policy.mjs';
import { enrichCatalogueDetails } from './catalogue-details.mjs';
import { publicPageMetadata } from './page-metadata.mjs';
import { projectPublicArtifacts } from './public-artifacts.mjs';
import { rawReadmeIdentity, repositoryReadmeRefs, verifyRawReadme } from './github-readme.mjs';

export const PUBLIC_CATALOGUE_FORMAT = 'glasses-public-catalogue';
export const PUBLIC_CATALOGUE_VERSION = 1;
const MAX_BYTES = 32 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const unique = values => [...new Set(values)];
// Public pack links never contain request queries, fragments or embedded credentials.
function publicLink(value) {
  try { const raw = new URL(value); if (raw.search || raw.hash) return null; return validatePublicURL(value).href; } catch { return null; }
}
const safeText = value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|(?:\b[A-Z]:[\\/]|\\\\)[^\s]+|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value);
const bounded = max => z.string().max(max).refine(safeText, 'Unsafe public metadata');
const urlSchema = z.string().max(4000).refine(value => publicLink(value) === value, 'Expected a query-free public HTTPS URL');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[a-f0-9]{20}$/);
const timestamp = z.string().datetime();
const citationSchema = z.object({ id:idSchema, endpoint:urlSchema, recordUrl:urlSchema, sha256:digest, observedAt:timestamp, kind:z.enum(['github-repository-metadata','github-search-metadata','registry-directory','registry-item-index','registry-item-document','github-source-evidence','github-artifact-document','source-preview-document','public-page-metadata']) }).strict();
const assessmentSchema = z.object({ artifact:z.enum(ARTIFACTS), adoption:z.enum(ADOPTIONS), capabilities:z.array(bounded(100).min(1)).max(20), confidence:z.number().min(0).max(1), provider:z.enum(['codex','jev']), model:bounded(120).min(1), schemaVersion:z.literal(INTELLIGENCE_SCHEMA), assessedAt:timestamp, citationIds:z.array(idSchema).min(1).max(20) }).strict();
const detailsSchema=z.object({resourceType:z.enum(['component','tool','skill','agent','collection','reference']).optional(),keywords:z.array(bounded(80)).max(20).optional(),overview:bounded(800).optional(),features:z.array(bounded(180)).max(8).optional(),sections:z.array(z.object({title:bounded(100),summary:bounded(280)}).strict()).max(8).optional(),parent:z.object({id:idSchema,url:urlSchema,name:bounded(200)}).strict().optional(),memberCount:z.number().int().min(0).max(100000).optional(),citationIds:z.array(idSchema).min(1).max(8),dependencies:z.array(bounded(150)).max(20).optional(),registryDependencies:z.array(bounded(250)).max(20).optional(),sourceFileCount:z.number().int().min(0).max(10000).optional(),documentationUrl:urlSchema.optional(),sourceUrl:urlSchema.optional(),agentUsage:z.object({triggers:z.array(bounded(200)).max(6).optional(),inputs:z.array(bounded(200)).max(6).optional(),outputs:z.array(bounded(200)).max(6).optional(),compatibility:z.array(bounded(150)).max(8).optional()}).strict().optional(),distribution:z.object({url:urlSchema,sha256:digest,bytes:z.number().int().min(1).max(33554432),revision:z.string().regex(/^[a-f0-9]{40}$/),sourceUrl:urlSchema,fileCount:z.number().int().min(1).max(1000)}).strict().optional(),preview:z.object({imageUrl:urlSchema,sourceUrl:urlSchema,alt:bounded(200),capturedAt:timestamp}).strict().optional()}).strict();
const itemSchema = z.object({
  id:idSchema,url:urlSchema,name:bounded(200).min(1),description:bounded(1200),kind:z.enum(['solution','component','pattern','reference']),provider:bounded(200).min(1),tags:z.array(bounded(100)).max(30),framework:bounded(100).nullable(),
  license:z.object({spdx:bounded(100).nullable(),status:z.enum(['known','restricted','unknown']),scope:z.enum(['repository','registry-provider','registry-item','source-artifact','public-page']),basis:z.enum(['upstream-metadata','source-declaration'])}).strict(),
  github:z.object({stars:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),starsObservedAt:timestamp.nullable(),archived:z.boolean().nullable()}).strict().nullable(),
  observedAt:timestamp,citations:z.array(citationSchema).min(1).max(21),assessment:assessmentSchema.nullable(),details:detailsSchema.optional()
}).strict();
export const publicCatalogueSchema = z.object({
  format:z.literal(PUBLIC_CATALOGUE_FORMAT),formatVersion:z.literal(1),generatedAt:timestamp,contentHash:digest,
  capabilities:z.object({portableInferenceCache:z.literal(false),sourceBodies:z.literal(false)}).strict(),
  counts:z.object({total:z.number().int().nonnegative(),byKind:z.object({solution:z.number().int().nonnegative(),component:z.number().int().nonnegative(),pattern:z.number().int().nonnegative(),reference:z.number().int().nonnegative()}).strict(),withStars:z.number().int().nonnegative(),withAssessment:z.number().int().nonnegative()}).strict(),
  items:z.array(itemSchema).max(100000)
}).strict();
export const publicCatalogueJsonSchema = z.toJSONSchema(publicCatalogueSchema);
function counts(items) { return { total:items.length,byKind:Object.fromEntries(['solution','component','pattern','reference'].map(kind=>[kind,items.filter(item=>item.kind===kind).length])),withStars:items.filter(item=>item.github?.stars!=null).length,withAssessment:items.filter(item=>item.assessment).length }; }
function contentHash(items) { return sha(canonical({format:PUBLIC_CATALOGUE_FORMAT,formatVersion:1,items})); }
function envelope(items, generatedAt) { const sorted=[...items].sort((a,b)=>a.id.localeCompare(b.id)); return {format:PUBLIC_CATALOGUE_FORMAT,formatVersion:1,generatedAt:date(generatedAt),contentHash:contentHash(sorted),capabilities:{portableInferenceCache:false,sourceBodies:false},counts:counts(sorted),items:sorted}; }

// Enrichment takes an already validated public projection, never private local
// capability fields. Exact retained source bodies are used only as evidence.
export function enrichPublicCatalogue(input,{evidence=[],generatedAt=new Date().toISOString()}={}) {
  const pack=validatePublicCatalogue(input);
  const artifacts=new Map(pack.items.filter(item=>item.license.scope==='source-artifact'&&item.citations.some(ref=>ref.kind==='github-artifact-document')).map(item=>[item.id,item]));
  const rows=enrichCatalogueDetails({items:pack.items,evidence}).map(item=>artifacts.get(item.id)||item),members=new Map();
  for(const row of rows)if(row.details?.parent)members.set(row.details.parent.id,(members.get(row.details.parent.id)||0)+1);
  for(const row of rows)if(members.has(row.id)||row.details?.memberCount!==undefined)row.details={...row.details,resourceType:'collection',memberCount:members.get(row.id)||0,citationIds:row.details?.citationIds||[row.citations[0].id]};
  return validatePublicCatalogue(envelope(rows,generatedAt));
}

export function withPublicCatalogueItems(input,items,{generatedAt=new Date().toISOString()}={}) {
  validatePublicCatalogue(input);
  return validatePublicCatalogue(envelope(items,generatedAt));
}

export function validatePublicCatalogue(input) {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Public catalogue exceeds 32 MiB');
  let value; try { value=typeof input==='string'?JSON.parse(input):input; } catch { throw new Error('Invalid public catalogue JSON'); }
  const result=publicCatalogueSchema.safeParse(value); if(!result.success)throw new Error('Invalid public catalogue schema');
  const pack=result.data, seen=new Set();
  for(const item of pack.items) {
    if(item.id!==stableId(item.url)||seen.has(item.id))throw new Error('Invalid or duplicate public candidate identity');seen.add(item.id);
    const refs=new Set();for(const citation of item.citations){if(citation.id!==stableId(canonical({endpoint:citation.endpoint,recordUrl:citation.recordUrl,sha256:citation.sha256}))||refs.has(citation.id))throw new Error('Invalid or duplicate public citation identity');refs.add(citation.id);}
    if(item.assessment?.citationIds.some(id=>!refs.has(id)))throw new Error('Assessment cites unavailable public metadata');
    if(item.details?.citationIds.some(id=>!refs.has(id)))throw new Error('Details cite unavailable public metadata');
    const rights=licenseInfo(item.license.spdx);if(rights.licenseStatus!==item.license.status||rights.license!==item.license.spdx)throw new Error('Inconsistent public licence metadata');
    if((item.github?.stars==null)!==(item.github?.starsObservedAt==null))throw new Error('Stars require an observation date');
  }
  const byId=new Map(pack.items.map(item=>[item.id,item])),memberCounts=new Map();for(const child of pack.items){const parent=child.details?.parent?.id;if(parent)memberCounts.set(parent,(memberCounts.get(parent)||0)+1);}
  for(const item of pack.items){const parent=item.details?.parent;if(parent){const source=byId.get(parent.id);if(!source||source.id===item.id||source.url!==parent.url||source.name!==parent.name)throw new Error('Invalid collection parent');const chain=new Set([item.id]);let current=source;while(current){if(chain.has(current.id)||chain.size>8)throw new Error('Cyclic collection membership');chain.add(current.id);current=byId.get(current.details?.parent?.id);}}if(item.details?.memberCount!==undefined&&item.details.memberCount!==(memberCounts.get(item.id)||0))throw new Error('Collection member count does not match');}
  if(canonical(pack.counts)!==canonical(counts(pack.items))||pack.contentHash!==contentHash(pack.items))throw new Error('Public catalogue counts or content hash do not match');
  return pack;
}

function citation(snapshot, recordUrl, kind) {
  const source=new URL(snapshot.url);source.search='';source.hash='';
  const fields={endpoint:source.href,recordUrl,sha256:snapshot.sha256};
  return {id:stableId(canonical(fields)),...fields,observedAt:date(snapshot.lastFetchedAt||snapshot.firstFetchedAt),kind};
}
function rights(value,scope){const info=licenseInfo(value);return {spdx:info.license,status:info.licenseStatus,scope,basis:'upstream-metadata'};}
const tags = values => (Array.isArray(values)?values:[]).filter(value=>typeof value==='string').slice(0,30).map(value=>text(value,100));
function repoURL(value){const url=publicLink(value);return url&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url)?url.replace(/\/$/,''):null;}
function verifiedSnapshot(snapshot) {
  if(!snapshot||typeof snapshot.body!=='string'||snapshot.body.length>16*1024*1024||sha(snapshot.body)!==snapshot.sha256||snapshot.id!==stableId(`${snapshot.url}\n${snapshot.sha256}`)||!date(snapshot.lastFetchedAt||snapshot.firstFetchedAt)||snapshot.status!==200)return null;
  try{validatePublicURL(snapshot.url);let data=null;try{data=JSON.parse(snapshot.body);}catch{if(!/text\/html/i.test(snapshot.contentType||'')&&!rawReadmeIdentity(snapshot.url))return null;}return {...snapshot,data};}catch{return null;}
}
function projection(item,snapshot) {
  const source=new URL(snapshot.url),data=snapshot.data,url=publicLink(item.url);if(!url)return null;
  let fields,kind;
  if(source.hostname==='api.github.com'&&(/^\/repos\/[^/]+\/[^/]+\/?$/.test(source.pathname)||/^\/repositories\/[1-9]\d*$/.test(source.pathname)||source.pathname==='/search/repositories')){
    const repo=(Array.isArray(data?.items)?data.items:[data]).find(value=>repoURL(value?.html_url)?.toLowerCase()===repoURL(url)?.toLowerCase());
    if(!repo||repo.private!==false||!repoURL(url))return null;
    if(source.pathname.startsWith('/repositories/')&&(!Number.isSafeInteger(repo.id)||repo.id<1||String(repo.id)!==source.pathname.split('/').at(-1)))return null;
    const words=`${repo.name||''} ${repo.description||''} ${(repo.topics||[]).join(' ')}`.toLowerCase();
    const recordKind=githubRepositoryKind(repo);
    const stars=Number.isSafeInteger(repo.stargazers_count)&&repo.stargazers_count>=0?repo.stargazers_count:null;
    fields={name:text(repo.full_name||repo.name,200),description:text(repo.description||'Public repository; inspect upstream for applicability.',1200),kind:recordKind,provider:'GitHub',tags:tags(repo.topics).slice(0,25),framework:/react/.test(words)?'React':null,license:rights(repo.license,'repository'),github:{stars,starsObservedAt:stars===null?null:date(snapshot.lastFetchedAt||snapshot.firstFetchedAt),archived:typeof repo.archived==='boolean'?repo.archived:null}};
    kind=source.pathname==='/search/repositories'?'github-search-metadata':'github-repository-metadata';
  }else if(source.href==='https://registry.directory/items.json'&&Array.isArray(data.items)){
    const row=data.items.find(value=>value?.registry?.basePath&&/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value.registry.basePath)&&`https://registry.directory${value.registry.basePath}/${encodeURIComponent(value.name)}`===url);if(!row)return null;
    fields={name:text(row.name,200),description:text(row.description||'Component indexed by registry.directory. Inspect source before use.',1200),kind:'component',provider:text(row.registry.name,200),tags:tags(['react',...(row.categories||[]),...(row.type?[row.type]:[])]),framework:'React',license:rights(row.license,'registry-item'),github:null};kind='registry-item-index';
  }else if(source.href==='https://registry.directory/directory.json'&&Array.isArray(data.registries)){
    const row=data.registries.find(value=>publicLink(value?.url)===url);if(!row)return null;
    fields={name:text(row.name,200),description:text(row.description,1200),kind:'reference',provider:'registry.directory',tags:tags(['registry','react',...(row.namespace?[row.namespace]:[])]),framework:'React',license:rights(row.license,'registry-provider'),github:null};kind='registry-directory';
  }else if(publicLink(snapshot.url)===url&&data&&typeof data==='object'&&Array.isArray(data.files)&&typeof data.name==='string'){
    fields={name:text(data.title||data.name,200),description:text(data.description||'Registry component source imported for inspection.',1200),kind:'component',provider:source.hostname,tags:['registry','imported','react'],framework:'React',license:rights(data.license,'registry-item'),github:null};kind='registry-item-document';
  }else if(publicLink(snapshot.url)===url&&/text\/html/i.test(snapshot.contentType||'')){
    const metadata=publicPageMetadata(snapshot.body);if(!metadata)return null;
    fields={...metadata,kind:'reference',provider:source.hostname,tags:['reference'],framework:null,license:rights(null,'public-page'),github:null};kind='public-page-metadata';
  }else return null;
  return {id:stableId(url),url,...fields,observedAt:date(snapshot.lastFetchedAt||snapshot.firstFetchedAt),citations:[citation(snapshot,url,kind)],assessment:null};
}

function retainedRefs(item){const repository=item.repositoryEvidence||[];return unique([...repositoryReadmeRefs(item),item.sourceDocumentEvidence?.id,item.metadataEvidence?.id,item.registryDocumentEvidence?.id,item.provenance?.sourceEvidenceId,item.licenseEvidence?.evidenceId,...repository.map(x=>x.id)].filter(Boolean));}
export function publicCatalogueEvidenceIds(capabilities){return unique(capabilities.filter(item=>item.origin==='live'&&publicLink(item.url)).flatMap(item=>[item.metadataEvidence?.id,item.sourceDocumentEvidence?.id,item.repositoryReadmeProof?.apiEvidence?.id,...retainedRefs(item).slice(0,3),...(item.repositoryScopeEvidence||[]).map(ref=>ref.id),...(item.artifactEvidence||[]).map(ref=>ref.id)]).filter(id=>typeof id==='string'));}
function sourceSafe(snapshot,item,getSnapshot){
  if(!snapshot)return false;const url=new URL(snapshot.url);
  if(rawReadmeIdentity(snapshot.url)){
    const proof=item.repositoryReadmeProof,repository=repoURL(item.url)?.slice('https://github.com/'.length),api=proof&&getSnapshot(proof.apiEvidence?.id);
    if(!repository||!proof||proof.rawEvidence?.id!==snapshot.id||proof.rawEvidence.sha256!==snapshot.sha256||!api||api.sha256!==proof.apiEvidence.sha256)return false;
    try{verifyRawReadme(snapshot,api,{repository,revision:item.provenance?.resolvedRevision});return true;}catch{return false;}
  }
  if(url.hostname==='api.github.com'){
    // Search query text was visible to the original classifier and may be private.
    // Metadata remains exportable, but inferred free text must not echo that query.
    if(url.pathname==='/search/repositories')return !url.search&&Array.isArray(snapshot.data?.items)&&snapshot.data.items.every(repo=>repo.private===false);
    if(/^\/repositories\/[1-9]\d*$/.test(url.pathname))return !url.search&&snapshot.data?.private===false&&Number.isSafeInteger(snapshot.data.id)&&String(snapshot.data.id)===url.pathname.split('/').at(-1)&&repoURL(snapshot.data.html_url)?.toLowerCase()===repoURL(item.url)?.toLowerCase();
    if(!/^\/repos\/[^/]+\/[^/]+(?:\/(?:readme|license|commits\/[a-f0-9]{40}))?$/.test(url.pathname))return false;
    const prefix=new URL(item.url).pathname.replace(/^\//,'/repos/').toLowerCase();
    const sourcePath=url.pathname.toLowerCase();
    const sameRepository=sourcePath===prefix||sourcePath.startsWith(prefix+'/');
    return sameRepository&&[...url.searchParams.keys()].every(key=>key==='ref')&&(!url.search||/^[a-f0-9]{40}$/i.test(url.searchParams.get('ref')||''));
  }
  if(url.href==='https://registry.directory/items.json')return !!registryComponentIdentity(item.url)&&Array.isArray(snapshot.data?.items)&&snapshot.data.items.filter(entry=>registryIndexItemURL(entry)===item.url).length===1;
  return !url.search&&(url.href==='https://registry.directory/directory.json'||url.href===item.url&&Array.isArray(snapshot.data?.files));
}
function attachAssessment(projected,item,assessment,getSnapshot){
  if(!assessment||assessment.schemaVersion!==INTELLIGENCE_SCHEMA||!['codex','jev'].includes(assessment.provider)||assessment.model!==(assessment.provider==='codex'?'gpt-6-luna':'jev-1.13.0')||!date(assessment.updatedAt))return false;
  // The producer must prove that the model's bounded metadata matches public upstream facts.
  const base={id:item.id,name:text(item.name,200),url:item.url,description:text(item.description,1200),provider:text(item.provider,100),sourceKind:item.kind,tags:tags(item.tags).slice(0,15)};
  const publicBase={id:projected.id,name:projected.name,url:projected.url,description:projected.description,provider:text(projected.provider,100),sourceKind:projected.kind,tags:projected.tags.slice(0,15)};
  if(canonical(base)!==canonical(publicBase))return false;
  // The shared helper also binds registry components to the exact-URL excerpt
  // selection version. Old same-name matches cannot become public labels.
  const refs=retainedRefs(item),fingerprint=classificationFingerprint({base,evidenceIds:refs,revision:item.provenance?.resolvedRevision||item.provenance?.revision||null,sourceHash:item.provenance?.sourceHash||null,policy:assessment.policyVersion||LEGACY_CLASSIFICATION_POLICY});
  if(assessment.sourceFingerprint!==fingerprint)return false;
  const used=refs.slice(0,3).map(getSnapshot);if(!used.length||used.some(snapshot=>!sourceSafe(snapshot,item,getSnapshot)))return false;
  const classification=assessment.classification;if(!classification||!Array.isArray(classification.evidenceIds)||!classification.evidenceIds.length||classification.evidenceIds.some(id=>!used.some(snapshot=>snapshot.id===id)))return false;
  const extra=used.map(snapshot=>citation(snapshot,projected.url,new URL(snapshot.url).hostname==='api.github.com'||rawReadmeIdentity(snapshot.url)?'github-source-evidence':projected.citations[0].kind));
  const citations=[...new Map([...projected.citations,...extra].map(value=>[value.id,value])).values()];
  const exported={artifact:classification.artifact,adoption:classification.adoption,capabilities:classification.capabilities,confidence:classification.confidence,provider:assessment.provider,model:assessment.model,schemaVersion:assessment.schemaVersion,assessedAt:date(assessment.updatedAt),citationIds:classification.evidenceIds.map(id=>extra[used.findIndex(snapshot=>snapshot.id===id)].id)};
  if(!assessmentSchema.safeParse(exported).success)return false;
  projected.citations=citations;projected.assessment=exported;return true;
}

/** Pure, zero-network projection. Raw local objects are never spread into output. */
export function createPublicCatalogue({capabilities,evidence,assessments=[],generatedAt=new Date().toISOString()}) {
  if(!Array.isArray(capabilities)||!Array.isArray(evidence)||!Array.isArray(assessments))throw new Error('Public catalogue input arrays are required');
  const raw=new Map(evidence.map(value=>[value.id,value])),parsed=new Map(),assessmentById=new Map(assessments.map(value=>[value.id,value]));
  const getSnapshot=id=>{if(!parsed.has(id))parsed.set(id,verifiedSnapshot(raw.get(id)));return parsed.get(id);};
  const items=new Map(),excluded={notLive:0,unsupportedEvidence:0,unsafeMetadata:0},report={examined:capabilities.length,excluded,assessmentOmitted:0};
  for(const item of capabilities){
    if(item.origin!=='live'){excluded.notLive++;continue;}
    if(item.artifactManifest)continue;
    const snapshot=getSnapshot(item.metadataEvidence?.id||item.sourceDocumentEvidence?.id);
    if(!snapshot||item.metadataEvidence?.sha256&&item.metadataEvidence.sha256!==snapshot.sha256){excluded.unsupportedEvidence++;continue;}
    let projected;try{projected=projection(item,snapshot);}catch{projected=null;}
    if(!projected){excluded.unsupportedEvidence++;continue;}
    if(!itemSchema.safeParse(projected).success){excluded.unsafeMetadata++;continue;}
    const assessment=assessmentById.get(item.id);
    if(assessment){let accepted=false;try{accepted=attachAssessment(projected,item,assessment,getSnapshot);}catch{}if(!accepted)report.assessmentOmitted++;}
    const previous=items.get(projected.id);if(!previous||projected.observedAt>previous.observedAt)items.set(projected.id,projected);
  }
  const artifactGroups=new Map();
  for(const item of capabilities.filter(item=>item.origin==='live'&&item.artifactManifest)){
    const manifest=item.artifactManifest;
    if(manifest?.schemaVersion!==1||!Array.isArray(manifest.items)||manifest.items.length!==1||!Array.isArray(manifest.sources)||manifest.sources.length!==1||!manifest.items[0]||typeof manifest.items[0]!=='object'||!manifest.sources[0]||typeof manifest.sources[0]!=='object'){excluded.unsupportedEvidence++;continue;}
    const source=manifest.sources[0],key=canonical(source);
    if(!artifactGroups.has(key))artifactGroups.set(key,{source,entries:[]});
    artifactGroups.get(key).entries.push(manifest.items[0]);
  }
  for(const {source,entries} of artifactGroups.values())for(let offset=0;offset<entries.length;offset+=1000){const result=projectPublicArtifacts({manifest:{schemaVersion:1,sources:[source],items:entries.slice(offset,offset+1000)},evidence,parents:[...items.values()]});for(const item of result.items)if(itemSchema.safeParse(item).success)items.set(item.id,item);else excluded.unsafeMetadata++;excluded.unsupportedEvidence+=result.report.excluded.length;}
  const membership=new Map();for(const item of items.values())if(item.details?.parent)membership.set(item.details.parent.id,(membership.get(item.details.parent.id)||0)+1);
  for(const [id,total] of membership){const parent=items.get(id);parent.details={...parent.details,resourceType:'collection',memberCount:total,citationIds:parent.details?.citationIds||[parent.citations[0].id]};}
  const snapshot=validatePublicCatalogue(envelope([...items.values()],generatedAt));return {snapshot,report:{...report,exported:snapshot.items.length}};
}

/** Merge only the public layer. Never touches the local catalogue, jobs, keys or model cache. */
export function isNewerPublicItem(previous,item,{previousGeneratedAt,incomingGeneratedAt}={}) {
  if(item.observedAt>previous.observedAt)return true;
  if(item.observedAt!==previous.observedAt||!(incomingGeneratedAt>previousGeneratedAt))return false;
  // Reassessment can change without a new GitHub metadata observation. Keep
  // source facts fixed, require a newer publication and reject older/tied
  // conflicting assessments. A newer publisher may withdraw an assessment.
  // Projection places the primary metadata citation first. Assessment attachment
  // can decorate that same citation as source evidence; its identity and bytes
  // must stay identical, while that display role may change.
  const facts=({assessment,details,citations,...rest})=>{const {kind,...primary}=citations[0];return{...rest,primaryCitation:primary};};
  if(canonical(facts(previous))!==canonical(facts(item)))return false;
  if(item.assessment&&previous.assessment&&(item.assessment.assessedAt<previous.assessment.assessedAt||item.assessment.assessedAt===previous.assessment.assessedAt&&canonical(item.assessment)!==canonical(previous.assessment)))return false;
  return canonical(item)!==canonical(previous);
}
export function mergePublicCatalogues(current,incoming,{generatedAt=new Date().toISOString()}={}) {
  const old=validatePublicCatalogue(current),next=validatePublicCatalogue(incoming),items=new Map(old.items.map(item=>[item.id,item]));
  const report={added:0,updated:0,unchanged:0,conflicts:0};
  for(const item of next.items){const previous=items.get(item.id);if(!previous){items.set(item.id,item);report.added++;}else if(canonical(previous)===canonical(item)){report.unchanged++;}else if(isNewerPublicItem(previous,item,{previousGeneratedAt:old.generatedAt,incomingGeneratedAt:next.generatedAt})){items.set(item.id,item);report.updated++;}else{report.conflicts++;}}
  return {snapshot:validatePublicCatalogue(envelope([...items.values()],generatedAt)),report};
}
