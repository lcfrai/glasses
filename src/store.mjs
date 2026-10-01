import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeFiles, normalizeVisualEdits, visualStyles, reviewedDependencies } from './workspace.mjs';
import { validateResearchPlan } from './research.mjs';
import { makeDesignReview, reviseDesignReview, decideDesignReview } from './design-reviews.mjs';

export const KINDS = ['solution', 'component', 'pattern', 'reference'];
export const RESOURCE_TYPES=['component','tool','skill','agent','collection','reference'];
export const resourceTypeOf=item=>item.details?.resourceType||(item.kind==='solution'?'tool':item.kind==='component'?'component':'reference');
export const OPEN_LICENSES = new Set(['MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC','MPL-2.0','GPL-2.0','GPL-2.0-only','GPL-2.0-or-later','GPL-3.0','GPL-3.0-only','GPL-3.0-or-later','LGPL-2.1','LGPL-2.1-only','LGPL-2.1-or-later','LGPL-3.0','LGPL-3.0-only','LGPL-3.0-or-later','AGPL-3.0','AGPL-3.0-only','AGPL-3.0-or-later','Unlicense','0BSD','BSL-1.0','Zlib','EPL-2.0']);
export const stableId = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const now = () => new Date().toISOString();
const parse = row => row ? JSON.parse(row.data) : null;
// Count the merged identity set in SQLite without materializing source summaries.
// Local kind wins even when a shared publication classifies that ID differently.
const countsSQL = `SELECT kind, COUNT(*) AS count FROM (
  SELECT json_extract(data, '$.kind') AS kind FROM capabilities
  UNION ALL
  SELECT json_extract(shared.data, '$.item.kind') AS kind
  FROM shared_capabilities AS shared
  WHERE NOT EXISTS (SELECT 1 FROM capabilities AS local WHERE local.id = shared.id)
) GROUP BY kind`;
const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const STOP_WORDS=new Set('a an and are as at be been build building built but by can could do does for from get give has have how i if in into is it its me my need of on or our please should some something that the their them there these they this to use using want was we what when where which will with would you your'.split(' '));
export const searchTerms=query=>query.toLowerCase().replace(/[^a-z0-9+#.-]+/g,' ').split(/\s+/).filter(word=>word.length>=2&&!STOP_WORDS.has(word)).slice(0,20);
export function licenseInfo(value) {
  const license = typeof value === 'object' ? value?.spdx_id : value;
  if (!license || ['NOASSERTION','NONE','unknown'].includes(license)) return { license: null, licenseStatus: 'unknown' };
  return {license: text(license, 100), licenseStatus: OPEN_LICENSES.has(license) ? 'known' : 'restricted'};
}

export function createStore(dataDir = process.env.GLASSES_DATA_DIR || '.glasses') {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'glasses.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS capabilities (id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_capabilities (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS design_reviews (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS capabilities_kind_counts ON capabilities(json_extract(data, '$.kind'));
    CREATE INDEX IF NOT EXISTS shared_capabilities_kind_counts ON shared_capabilities(json_extract(data, '$.item.kind'), id);`);
  const all = table => db.prepare(`SELECT data FROM ${table}`).all().map(parse);
  const get = (table, id) => parse(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id));
  const save = (table, data) => {db.prepare(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(data.id, JSON.stringify(data)); return data;};
  const mutateDesignReview = (id, transform) => {
    // Serialize the read/version-check/write across other local processes too.
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous=get('design_reviews',id);
      const result=previous ? save('design_reviews',transform(previous)) : null;
      db.exec('COMMIT');return result;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  };
  const sharedCapability = row => {
    if(!row)return null;const item=row.item;
    return {id:item.id,url:item.url,name:item.name,description:item.description,kind:item.kind,provider:item.provider,tags:item.tags,framework:item.framework,license:item.license.spdx,licenseStatus:item.license.status,
      licenseEvidence:{status:'metadata-only',scope:item.license.scope,sourceUrl:item.url,spdx:item.license.spdx,note:'Imported upstream metadata claim; no original licence text or local verification is included.'},
      origin:'shared',discoveredAt:row.importedAt,updatedAt:row.importedAt,sourceItemUrl:item.citations.some(citation=>citation.kind==='registry-item-document')?item.url:undefined,github:item.github?{stars:item.github.stars,starsFetchedAt:item.github.starsObservedAt,archived:item.github.archived}:undefined,
      sharedPublication:{contentHash:row.contentHash,generatedAt:row.generatedAt,importedAt:row.importedAt,portableInferenceCache:false,sourceBodies:false},sharedCitations:item.citations,sharedAssessment:item.assessment,...(item.details?{details:item.details,detailsBasis:'Published source details; not independently verified by this installation.'}:{}),
      provenance:{sourceUrl:item.url,fetchedAt:item.observedAt,note:'Imported public catalogue metadata. Citations and model labels are attributed to the pack; source has not been independently fetched or verified by this installation.'}};
  };
  const withSharedDetails=(local,shared)=>{if(!local)return shared;if(local.details&&!local.detailsPublication&&!local.sharedPublication||!shared?.details)return local;return {...local,details:shared.details,detailsCitations:shared.sharedCitations,detailsBasis:'Published source details from '+shared.sharedPublication.generatedAt+'; inspect current local source before adoption.',detailsPublication:shared.sharedPublication};};
  const capability = id => withSharedDetails(get('capabilities',id),sharedCapability(get('shared_capabilities',id)));
  const summarySQL="SELECT json_remove(data,'$.repositoryFiles','$.sourceFiles','$.previewFiles','$.previewSource','$.previewCss','$.previewProps') AS data FROM capabilities";
  const summaryById=db.prepare(summarySQL+' WHERE id=?'),sharedById=db.prepare('SELECT data FROM shared_capabilities WHERE id=?');
  const capabilitySummary=id=>withSharedDetails(parse(summaryById.get(id)),sharedCapability(parse(sharedById.get(id))));
  const capabilities = () => {const items=new Map(all('shared_capabilities').map(row=>[row.id,sharedCapability(row)]));for(const row of db.prepare(summarySQL).all()){const item=parse(row);items.set(item.id,withSharedDetails(item,items.get(item.id)));}return [...items.values()];};
  const countsStatement=db.prepare(countsSQL);
  return {
    directory, close: () => db.close(),
    designReviews: () => all('design_reviews').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id)),
    getDesignReview: id => get('design_reviews',id),
    createDesignReview: input => save('design_reviews',makeDesignReview(input)),
    updateDesignReview: (id,input) => mutateDesignReview(id,previous=>reviseDesignReview(previous,input)),
    decideDesignReview: (id,input) => mutateDesignReview(id,previous=>decideDesignReview(previous,input)),
    retainEvidence({url,body,contentType='',status=200,transport='direct',fetchedAt=now(),request}) {
      if(typeof body!=='string') throw new Error('Evidence requires the exact fetched text');
      const sha256=createHash('sha256').update(body).digest('hex');
      const id=stableId(`${url}\n${sha256}`),previous=get('evidence',id);
      let requestReceipt=previous?.request;
      if(request!==undefined){
        if(url!=='https://api.github.com/graphql'||request?.method!=='POST'||typeof request.body!=='string'||Buffer.byteLength(request.body)>100000||Object.keys(request).some(key=>!['method','body'].includes(key)))throw new Error('Unsupported source request receipt');
        requestReceipt={method:'POST',body:request.body};
        if(previous?.request&&JSON.stringify(previous.request)!==JSON.stringify(requestReceipt))throw new Error('Existing response evidence is bound to a different request');
      }
      const snapshot={id,url,sha256,bytes:Buffer.byteLength(body),contentType,status,transport,firstFetchedAt:previous?.firstFetchedAt||fetchedAt,lastFetchedAt:fetchedAt,body,...(requestReceipt?{request:requestReceipt,requestSha256:createHash('sha256').update(requestReceipt.body).digest('hex')}:{})};
      save('evidence',snapshot);
      const {body:raw,request:requestBody,...summary}=snapshot;return summary;
    },
    getEvidence:id=>get('evidence',id),
    evidence:()=>all('evidence').map(({body,request,...summary})=>summary),
    getCapability: capability,
    getCapabilitySummary: capabilitySummary,
    async importPublicCatalogue(input) {
      // Dynamic import avoids making the local store depend on projection initialization.
      // Validation completes before the one-table transaction; no network/model hook runs.
      const {validatePublicCatalogue,isNewerPublicItem}=await import('./public-catalogue.mjs');const pack=validatePublicCatalogue(input);
      const report={contentHash:pack.contentHash,added:0,updated:0,unchanged:0,conflicts:0,localOverrides:0};
      db.exec('BEGIN IMMEDIATE');
      try{
        for(const item of pack.items){
          const previous=get('shared_capabilities',item.id);
          if(get('capabilities',item.id))report.localOverrides++;
          if(previous&&JSON.stringify(previous.item)===JSON.stringify(item)){report.unchanged++;continue;}
          if(previous&&!isNewerPublicItem(previous.item,item,{previousGeneratedAt:previous.generatedAt,incomingGeneratedAt:pack.generatedAt})){report.conflicts++;continue;}
          save('shared_capabilities',{id:item.id,item,contentHash:pack.contentHash,generatedAt:pack.generatedAt,importedAt:now()});report[previous?'updated':'added']++;
        }
        db.exec('COMMIT');return report;
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    upsertCapability(input) {
      const url = text(input.url, 4000);
      if (!url || !KINDS.includes(input.kind)) throw new Error('Capability requires a URL and valid kind');
      const previous = parse(db.prepare('SELECT data FROM capabilities WHERE url=?').get(url));
      const stamp = now();
      const invalidatedLicence=input.licenseEvidence?.status==='unverified-current-source';
      const item = {
        ...previous, ...input, id: previous?.id || stableId(url), url,
        name: text(input.name, 200) || url, description: text(input.description, 4000),
        provider: text(input.provider, 200), tags: (Array.isArray(input.tags) ? input.tags : []).filter(x=>typeof x==='string').slice(0,30).map(x=>x.slice(0,100)),
        framework: input.framework || null, ...licenseInfo(input.license ?? (!invalidatedLicence&&previous?.licenseEvidence?.status==='fetched' ? previous.license : null)),
        licenseEvidence: invalidatedLicence||input.licenseEvidence?.status==='fetched' ? input.licenseEvidence : previous?.licenseEvidence?.status==='fetched' ? previous.licenseEvidence : input.licenseEvidence||previous?.licenseEvidence,
        origin: ['live','seed','sample'].includes(input.origin) ? input.origin : 'live',
        discoveredAt: previous?.discoveredAt || stamp, updatedAt: stamp,
        provenance: {sourceUrl: url, fetchedAt: stamp, ...previous?.provenance, ...input.provenance}
      };
      // Read-time public details must never become a permanent local override
      // when an ordinary source refresh spreads the inspected item back here.
      if(item.detailsPublication||item.sharedPublication){delete item.details;delete item.detailsBasis;delete item.detailsPublication;delete item.detailsCitations;}
      db.prepare('INSERT INTO capabilities (id,url,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,data=excluded.data').run(item.id, url, JSON.stringify(item));
      return {item, added: !previous};
    },
    search({query = '', kind = 'all', openSourceOnly = false} = {}) {
      const terms = searchTerms(query),outcomes=all('outcomes');
      return capabilities().filter(x=>(kind==='all'||x.kind===kind) && (!openSourceOnly || OPEN_LICENSES.has(x.license))).map(item=>{
        const previousOutcomes=outcomes.filter(x=>x.capabilityId===item.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        const fields = {name: item.name.toLowerCase(), tags: item.tags.join(' ').toLowerCase(), description: item.description.toLowerCase(), provider: item.provider.toLowerCase(), kind: item.kind, framework: (item.framework||'').toLowerCase(),outcomes:previousOutcomes.map(x=>`${x.notes} ${JSON.stringify(x.context||{})}`).join(' ').toLowerCase()};
        const matches = terms.filter(term=>Object.values(fields).some(value=>value.includes(term)));
        const score = terms.reduce((sum,term)=>sum+(fields.name.includes(term)?4:0)+(fields.tags.includes(term)?3:0)+(fields.description.includes(term)?1:0),0);
        const outcomeSummary={total:previousOutcomes.length,worked:previousOutcomes.filter(x=>x.result==='worked').length,failed:previousOutcomes.filter(x=>x.result==='failed').length,rejected:previousOutcomes.filter(x=>x.result==='rejected').length,recent:previousOutcomes.slice(0,3),note:'Local observations in their recorded context; not a general compatibility rating.'};
        return {...item,outcomeSummary, _score: score, matchReason: terms.length ? `Text matched: ${matches.join(', ')} (${matches.length}/${terms.length} terms), including recorded local outcome context where present. No semantic or compatibility assessment.` : 'Catalogue entry; no fit assessment requested.', _matches: matches.length};
      }).filter(x=>!terms.length||x._matches>0).sort((a,b)=>b._score-a._score || a.name.localeCompare(b.name)).map(({_score,_matches,sourceFiles,previewFiles,repositoryFiles,previewSource,previewCss,previewProps,...item})=>item);
    },
    counts() {
      const counts=Object.fromEntries([['total',0],...KINDS.map(kind=>[kind,0])]);
      for(const row of countsStatement.all()){counts.total+=row.count;if(KINDS.includes(row.kind))counts[row.kind]=row.count;}
      return counts;
    },
    getSetting(key, fallback) {return parse(db.prepare('SELECT data FROM settings WHERE key=?').get(key)) ?? fallback;},
    setSetting(key, value) {db.prepare('INSERT INTO settings (key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key,JSON.stringify(value));return value;},
    acquireSettingLease(key, lease) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous=parse(db.prepare('SELECT data FROM settings WHERE key=?').get(key));
        if(previous&&(!Number.isFinite(Date.parse(previous.expiresAt))||Date.parse(previous.expiresAt)>Date.now())){db.exec('COMMIT');return false;}
        db.prepare('INSERT INTO settings (key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key,JSON.stringify(lease));
        db.exec('COMMIT');return true;
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    releaseSettingLease(key, id) {db.prepare("DELETE FROM settings WHERE key=? AND json_extract(data,'$.id')=?").run(key,id);},
    saveRun: run=>save('runs',run),
    recoverInterruptedRuns() {
      const interrupted=all('runs').filter(run=>run.status==='running');
      for(const run of interrupted)save('runs',{...run,status:'interrupted',finishedAt:now(),errors:[...(run.errors||[]),'The previous local server stopped before this research run completed. Retained candidate IDs describe only writes recorded before interruption.']});
      return interrupted.length;
    },
    getRun: id=>get('runs',id),
    runs: ({planId,limit=20,offset=0}={})=>all('runs').filter(run=>planId===undefined||run.planId===planId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id)).slice(offset,offset+limit),
    runCount: ({planId}={})=>all('runs').filter(run=>planId===undefined||run.planId===planId).length,
    researchPlans: ()=>all('research_plans').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)),
    getResearchPlan: id=>get('research_plans',id),
    createResearchPlan(input) {
      const fields=validateResearchPlan(input);
      if(all('research_plans').length>=100)throw Object.assign(new Error('At most 100 research plans can be retained'),{status:409});
      const stamp=now();return save('research_plans',{id:randomUUID(),...fields,version:1,createdAt:stamp,updatedAt:stamp});
    },
    updateResearchPlan(id,input) {
      const previous=get('research_plans',id);if(!previous)return null;
      const fields=validateResearchPlan(input,{partial:true});
      if(input.expectedVersion!==undefined&&input.expectedVersion!==previous.version)throw Object.assign(new Error(`Research plan changed since version ${input.expectedVersion}; current version is ${previous.version}. Reload before amending it.`),{status:409});
      return save('research_plans',{...previous,...fields,version:previous.version+1,updatedAt:now()});
    },
    saveSource(source) {
      const previous=get('sources',source.id);
      const history=[...(previous?.history||[]),{status:source.status,checkedAt:source.lastCheckedAt,error:source.error||null,count:source.count||0}].slice(-20);
      return save('sources',{...previous,...source,consecutiveFailures:source.status==='ok'?0:(previous?.consecutiveFailures||0)+1,lastSuccessfulAt:source.status==='ok'?source.lastCheckedAt:previous?.lastSuccessfulAt||null,history});
    },
    sources: ()=>all('sources'),
    outcomes: capabilityId=>all('outcomes').filter(x=>!capabilityId||x.capabilityId===capabilityId),
    recordOutcome({capabilityId,result,notes='',context={}}) {
      const item=capability(capabilityId);if(!item) throw new Error('Capability not found');
      if(!['worked','rejected','failed'].includes(result)) throw new Error('Result must be worked, rejected, or failed');
      if(!context||typeof context!=='object'||Array.isArray(context))throw new Error('Outcome context must be an object');
      const boundedContext=Object.fromEntries(['project','goal','stack','environment','version','workspaceId','evidencePath'].filter(key=>context[key]!==undefined).map(key=>[key,text(context[key],1000)]));
      return save('outcomes',{id:randomUUID(),capabilityId,result,notes:text(notes,4000),context:boundedContext,sourceSnapshot:{sourceHash:item.provenance?.sourceHash||null,revision:item.provenance?.resolvedRevision||item.provenance?.revision||null,license:item.license},createdAt:now(),shared:false});
    },
    workspaces: ()=>all('workspaces').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),
    getWorkspace: id=>get('workspaces',id),
    createWorkspace({title='Untitled study',capabilityId=null,source,css,props,files,entryPath,visualEdits={}}) {
      const cap = capabilityId ? capability(capabilityId) : null;
      if(capabilityId&&!cap) throw new Error('Capability not found');
      // Supplied files define the new app; capability source is only a fallback.
      // Keep the upstream files below as evidence, not as an entry-file override.
      const suppliedFiles = files !== undefined;
      const actualSource = source ?? (suppliedFiles ? undefined : cap?.previewSource);
      if(typeof actualSource!=='string'&&!files?.length) throw new Error('This entry has no preview source. Inspect its origin or supply reviewed TSX; Glasses will not substitute a demo.');
      const workspaceFiles=normalizeFiles({source:actualSource,files:suppliedFiles?files:cap?.previewFiles,entryPath:entryPath??(suppliedFiles?undefined:cap?.previewEntryPath)});
      const stamp=now();
      const originalFiles=cap?.sourceFiles?.length?cap.sourceFiles.map(file=>({path:file.path||file.name,content:file.content})):workspaceFiles.files;
      const attributionFiles=(cap?.attributionFiles||[]).filter(file=>typeof file.path==='string'&&/^[a-zA-Z0-9_.-]+$/.test(file.path)&&!/[.]$/.test(file.path)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.path)&&typeof file.content==='string'&&file.content.length<=50000).slice(0,10);
      return save('workspaces',{id:randomUUID(),title:text(title,200),capabilityId,...workspaceFiles,originalFiles,attributionFiles,visualEdits:normalizeVisualEdits(visualEdits),css:css??cap?.previewCss??'',props:props??cap?.previewProps??{},version:1,createdAt:stamp,updatedAt:stamp,provenance:cap?JSON.parse(JSON.stringify({capabilityId:cap.id,url:cap.url,name:cap.name,license:cap.license,licenseEvidence:cap.licenseEvidence,origin:cap.origin,...cap.provenance,sourceEvidence:cap.sourceEvidence})): {origin:'user',note:'User-supplied source; not independently verified.'}});
    },
    updateWorkspace(id,patch) {
      const previous=get('workspaces',id); if(!previous) return null;
      if(patch.expectedVersion!==undefined&&patch.expectedVersion!==previous.version) throw Object.assign(new Error(`Workspace changed since version ${patch.expectedVersion}; current version is ${previous.version}. Your unsaved draft is preserved. Reload the saved version or merge your changes before saving.`),{status:409});
      const fields=Object.fromEntries(['title','source','css','props','files','entryPath','visualEdits'].filter(key=>patch[key]!==undefined).map(key=>[key,patch[key]]));
      const merged={...previous,...fields};
      // A files-only agent edit is authoritative; source is an alias of its entry.
      const normalized=normalizeFiles({...merged,source:patch.source??(patch.files||patch.entryPath?undefined:previous.source)});
      return save('workspaces',{...merged,...normalized,visualEdits:normalizeVisualEdits(merged.visualEdits),version:previous.version+1,updatedAt:now()});
    },
    exportWorkspace(id) {
      const w=get('workspaces',id);if(!w) return null;
      const normalized=normalizeFiles(w), dependencies=reviewedDependencies();
      const generatedNames=['styles.css','visual-edits.css','props.json','Consumer.tsx','package.json','adaptations.json','provenance.json','original-sources.json','README.md','compiled.css'];
      const collides=normalized.files.some(file=>generatedNames.some(name=>name.toLowerCase()===file.path.toLowerCase()||file.path.toLowerCase().startsWith(name.toLowerCase()+'/'))||file.path.toLowerCase().startsWith('attribution/'));
      let supportDirectory='';
      if(collides){let suffix=0;do{supportDirectory='glasses-export'+(suffix?'-'+suffix:'');suffix++;}while(normalized.files.some(file=>file.path.toLowerCase()===supportDirectory||file.path.toLowerCase().startsWith(supportDirectory+'/')));}
      const supportPath=name=>supportDirectory?supportDirectory+'/'+name:name;
      const sourceHashes=Object.fromEntries(normalized.files.map(file=>[file.path,createHash('sha256').update(file.content).digest('hex')]));
      const originalFiles=w.originalFiles||[];
      const paths=[...new Set([...normalized.files,...originalFiles].map(file=>file.path))];
      const adaptations=paths.map(path=>({path,original:originalFiles.find(file=>file.path===path)?.content??null,current:normalized.files.find(file=>file.path===path)?.content??null})).filter(file=>file.original!==file.current);
      // Original paths are untrusted evidence labels, never export destinations or imports.
      // JSON preserves renamed/deleted originals without introducing executable source files.
      const originalSources=JSON.stringify({format:'glasses-original-sources-v1',note:'Immutable upstream text snapshots. Paths are evidence labels only; do not execute or extract them as trusted filesystem paths.',files:originalFiles.map(file=>({path:file.path,content:file.content,sha256:createHash('sha256').update(file.content).digest('hex'),bytes:Buffer.byteLength(file.content)}))},null,2);
      const manifest={workspaceId:w.id,title:w.title,version:w.version,entryPath:normalized.entryPath,consumerPath:supportPath('Consumer.tsx'),provenancePath:supportPath('provenance.json'),compiledCssPath:supportPath('compiled.css'),originalSourcesPath:supportPath('original-sources.json'),originalSourcesSha256:createHash('sha256').update(originalSources).digest('hex'),exportedAt:now(),exportFormat:'multi-file-react-source',provenance:w.provenance,sourceHashes,dependencies,visualEdits:w.visualEdits||{},assessment:'Catalogue evidence and edited source, not security approval. Review licence and integration before adoption.',consumerRequirements:{runtime:['react','react-dom'],styling:'Use the exported compiled.css from the HTTP/MCP export. It includes generated Tailwind, imported workspace CSS and visual edits.',integration:'Mount Consumer.tsx. It preserves the data-glasses-root wrapper used by visual selectors. Resolve @/ aliases to the matching supplied source root.'},limitations:['Only reviewed preinstalled packages and supplied virtual files compile; candidate packages are not installed automatically','Visual selectors apply to stable DOM structure. Reordered lists, portals, shadow DOM, canvas/WebGL and conditional structure need source edits and reinspection','The opaque-origin browser frame blocks parent access and subresource network; it is not a hardened arbitrary-code container']};
      const filesOut=[{path:'styles.css',content:w.css},{path:'visual-edits.css',content:visualStyles(w.visualEdits)},{path:'props.json',content:JSON.stringify(w.props,null,2)},{path:'Consumer.tsx',content:`import React from 'react';\nimport Candidate from '${supportDirectory?'../':'./'}${normalized.entryPath}';\nimport props from './props.json';\nimport './compiled.css';\nexport default function Consumer(){return <div data-glasses-root><Candidate {...props}/></div>}\n`},{path:'package.json',content:JSON.stringify({private:true,type:'module',dependencies},null,2)},{path:'adaptations.json',content:JSON.stringify({files:adaptations,visualEdits:w.visualEdits||{}},null,2)},{path:'provenance.json',content:JSON.stringify(manifest,null,2)},{path:'README.md',content:'# Glasses reviewed source export\n\nMount Consumer.tsx in a React app, preserving its data-glasses-root wrapper. Install the exact dependencies in package.json through your normal reviewed dependency workflow. No install/build scripts are supplied or run. Configure the bundler for TypeScript/JSX, JSON and the source aliases used by the files. compiled.css contains the preview styling; styles.css and visual-edits.css preserve editable source. Source identity, licence evidence, file hashes and adaptations are in provenance.json and adaptations.json.\n\nVisual editing supports stable rendered HTML elements. DOM reordering or conditional children can change selectors; inspect the result after structural edits.\n'}];
      filesOut.push({path:'original-sources.json',content:originalSources});
      filesOut.find(file=>file.path==='README.md').content+='\nThe manifest originalSourcesPath points to an immutable JSON archive of all original file bodies and hashes, including deleted or renamed paths. The archive is evidence data, not consumer code. adaptations.json records additions, changes and removals; a rename appears as a removal plus an addition unless separately documented.\n';
      for(const file of w.attributionFiles||[]) filesOut.push({path:'attribution/'+file.path,content:file.content});
      return {files:[...normalized.files,...filesOut.map(file=>({...file,path:supportPath(file.path)}))],manifest};
    }
  };
}
