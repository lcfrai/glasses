import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStore, stableId } from '../src/store.mjs';
import { createDiscovery, fetchPublic, validatePublicURL, isPublicAddress, normalizeScoutQuery, extractPreviewSource } from '../src/discovery.mjs';
import { seedStore } from '../src/seed.mjs';
import { startServer } from '../src/server.mjs';

const fixtureSource='import React from "react"; export default function FreshDots({label="Fresh find"}) { return <button>{label}</button>; }';
const fixtureRepo={full_name:'independent-lab/project-memory',name:'project-memory',html_url:'https://github.com/independent-lab/project-memory',description:'Memory storage for coding agents, with examples and a local mode.',topics:['memory','agent'],license:{spdx_id:'Apache-2.0'},default_branch:'main',pushed_at:'2026-09-20T00:00:00Z'};
function fixtureFetcher(log=[]) {
  return async url=>{
    log.push(url);let payload;
    if(url==='https://registry.directory/directory.json')payload={registries:[{name:'Previously Unknown Widgets',url:'https://unfamiliar-widgets.dev/',registry_url:'https://unfamiliar-widgets.dev/registry.json',github_url:'https://github.com/independent-lab/widgets',description:'Freshly indexed widgets'}]};
    else if(url==='https://registry.directory/items.json')payload={items:[{name:'fresh-dots',description:'Thinking indicator with monochrome dots',type:'registry:component',categories:['loading','dots'],registry:{name:'Previously Unknown Widgets',basePath:'/independent-lab/widgets'}}]};
    else if(url==='https://unfamiliar-widgets.dev/registry.json')payload={items:[{name:'fresh-dots',description:'An external component',files:[{path:'fresh-dots.tsx',content:fixtureSource}]}]};
    else if(url.startsWith('https://api.github.com/search/repositories?'))payload={items:[fixtureRepo]};
    else if(url==='https://api.github.com/repos/independent-lab/project-memory')payload=fixtureRepo;
    else if(url==='https://unfamiliar-widgets.dev/r/fresh-dots.json')payload={name:'fresh-dots',license:'MIT',files:[{path:'fresh-dots.tsx',content:fixtureSource}]};
    else if(url==='https://registry.directory/api/markdown/independent-lab/widgets/fresh-dots')return {url,body:'# Fresh dots\n\n```tsx\n'+fixtureSource+'\n```',contentType:'text/markdown',status:200};
    else throw new Error(`Fixture has no response for ${url}`);
    return {url,body:JSON.stringify(payload),contentType:'application/json',status:200};
  };
}
// Module teardown runs after per-test store/server cleanup. Windows cannot remove
// SQLite WAL/SHM files while their database handle is still open.
const temporaryDirectories=[];
after(async()=>{for(const dir of temporaryDirectories)await rm(dir,{recursive:true,force:true});});
async function temporary(t) {const dir=await mkdtemp(join(tmpdir(),'glasses-backend-'));temporaryDirectories.push(dir);return dir;}
async function request(app,path,method='GET',body,headers={}) {
  const token=(await (await fetch(`${app.url}/api/session`)).json()).token;
  const response=await fetch(app.url+path,{method,headers:{'X-Glasses-Token':token,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),response};
}

test('capabilities, edits, provenance and outcomes persist across an actual database restart',async t=>{
  const dir=await temporary(t);let store=createStore(dir);seedStore(store);
  const cap=store.search({query:'original workbench sample'}).find(x=>x.origin==='sample');
  assert.ok(cap);assert.equal(cap.previewSource,undefined,'search returns compact evidence rather than TSX payloads');
  const workspace=store.createWorkspace({title:'Persistent study',capabilityId:cap.id});
  store.updateWorkspace(workspace.id,{props:{label:'Changed and saved'},css:'body { background: white; }'});
  store.recordOutcome({capabilityId:cap.id,result:'worked',notes:'Checked the button interaction'});store.close();
  store=createStore(dir);t.after(()=>store.close());
  const restored=store.getWorkspace(workspace.id);assert.equal(restored.version,2);assert.equal(restored.props.label,'Changed and saved');
  const exported=store.exportWorkspace(workspace.id);assert.equal(exported.files.find(x=>x.path==='source.tsx').content,restored.source);assert.match(exported.files.find(x=>x.path==='props.json').content,/Changed and saved/);assert.equal(exported.manifest.provenance.origin,'sample');
  assert.equal(store.outcomes(cap.id)[0].shared,false);
});

test('scout discovers an unfamiliar provider, retrieves original source, and updates duplicates',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());const log=[];const discovery=createDiscovery({store,fetcher:fixtureFetcher(log)});
  const first=await discovery.scout({query:'thinking dots'});assert.equal(first.status,'completed');assert.equal(first.added,3,'Targeted research keeps matching items and query-directed repositories; unrelated directory metadata is excluded');assert.ok(log.includes('https://unfamiliar-widgets.dev/registry.json'),'new provider URL came from live directory fixture');
  const item=store.getCapability(stableId('https://registry.directory/independent-lab/widgets/fresh-dots'));
  assert.equal(item.origin,'live');assert.equal(item.previewSource,fixtureSource+'\n');assert.equal(item.licenseStatus,'unknown');assert.match(item.provenance.sourceHash,/^[a-f0-9]{64}$/);
  const count=store.counts().total;const second=await discovery.scout({query:'thinking dots'});assert.equal(second.added,0);assert.equal(store.counts().total,count);assert.equal(second.updated,3);
  assert.deepEqual(store.search({query:'impossible-zzyzz-never-matches'}),[]);
});

test('strict licence filter excludes unknown and restricted records; prose stopwords do not match everything',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  for(const [name,license] of [['Known','MIT'],['Unknown',null],['Restricted','BUSL-1.1']])store.upsertCapability({name,url:`https://test-provider.dev/${name}`,kind:'component',description:'loading spinner',provider:'test',license,origin:'live'});
  assert.deepEqual(store.search({query:'I want a loading spinner',openSourceOnly:true}).map(x=>x.name),['Known']);
  assert.equal(store.search({query:'I want a superspecificabsentfeature'}).length,0);
});

test('failed network scouts report failure without converting seeds into live evidence',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());seedStore(store);const before=store.counts().total;
  const discovery=createDiscovery({store,fetcher:async()=>{throw new Error('Blocked network fixture');}});
  const run=await discovery.scout({query:'nonexistent'});assert.equal(run.status,'failed');assert.equal(run.added,0);assert.ok(run.errors.length>=3);assert.equal(store.counts().total,before);assert.equal(store.search().filter(x=>x.origin==='live').length,0);
});

test('URL guard blocks local, credentialled, reserved, metadata and non-HTTPS destinations',async()=>{
  for(const url of ['http://github.com/x/y','https://localhost/','https://127.0.0.1/','https://127.1/','https://2130706433/','https://10.0.0.1/','https://169.254.169.254/','https://[::1]/','https://[::ffff:127.0.0.1]/','https://[2001:0db8::1]/','https://[2002:7f00:1::]/','https://user:pass@github.com/a/b','https://example.com:444/','file:///tmp/private'])assert.throws(()=>validatePublicURL(url),/blocked|HTTPS|Invalid|reserved/);
  assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  await assert.rejects(fetchPublic('https://unfamiliar-widgets.dev/',{resolver:async()=>[{address:'10.0.0.1',family:4}],allowFixedProxy:true}),/blocked/);
});

test('fixed connector proxy fallback cannot be used by arbitrary URLs or redirects into private destinations',async()=>{
  const noDNS=async()=>{throw Object.assign(new Error('DNS restricted fixture'),{code:'EAI_AGAIN'});};let calls=0;
  const proxyFetch=async()=>{calls++;return new Response('{"items":[]}',{headers:{'content-type':'application/json'}});};
  const doc=await fetchPublic('https://registry.directory/items.json',{resolver:noDNS,allowFixedProxy:true,proxyFetch});assert.equal(doc.transport,'environment-proxy-fixed-connector');assert.equal(calls,1);
  await assert.rejects(fetchPublic('https://unknown-provider.dev/',{resolver:noDNS,allowFixedProxy:true,proxyFetch}),/DNS restricted/);assert.equal(calls,1);
  await assert.rejects(fetchPublic('https://registry.directory/items.json',{resolver:noDNS,allowFixedProxy:true,proxyFetch:async()=>new Response('',{status:302,headers:{location:'https://127.0.0.1/secrets'}})}),/blocked/);
  await assert.rejects(fetchPublic('https://registry.directory/items.json',{resolver:noDNS,allowFixedProxy:true,proxyFetch:async()=>new Response('',{status:302,headers:{location:'https://other-public.dev/path'}})}),/permitted endpoint/);
});

test('real HTTP server enforces token, origin, host, input bounds and saved source/export',async t=>{
  const app=await startServer({port:0,dataDir:await temporary(t),autoScout:false,discoveryFetcher:fixtureFetcher()});t.after(()=>app.close());
  assert.equal((await fetch(app.url+'/api/catalog')).status,401);
  assert.equal((await fetch(app.url+'/api/session',{headers:{Origin:'https://evil.dev'}})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const r=http.get(app.url+'/api/session',{headers:{Host:'evil.dev'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);});assert.equal(badHost,403);
  assert.equal((await request(app,'/api/settings','POST',{scoutEnabled:true,intervalMinutes:0})).status,400);
  assert.equal((await request(app,'/api/workspaces','POST',{source:'a'.repeat(150001)})).status,400);
  const imported=await request(app,'/api/import','POST',{url:'https://unfamiliar-widgets.dev/r/fresh-dots.json'});assert.equal(imported.status,200);assert.equal(imported.data.item.previewSource,fixtureSource);
  const created=await request(app,'/api/workspaces','POST',{title:'External source',capabilityId:imported.data.item.id});assert.equal(created.status,201);
  const changed=await request(app,`/api/workspaces/${created.data.id}`,'PUT',{props:{label:'Edited source survived'}});assert.equal(changed.data.version,2);
  const exported=await request(app,`/api/workspaces/${created.data.id}/export`);assert.equal(exported.data.manifest.provenance.origin,'live');assert.equal(exported.data.files.find(x=>x.path===exported.data.manifest.entryPath).content,fixtureSource);
  const status=await request(app,'/api/status');assert.equal(status.data.schedule.enabled,false);assert.match(status.data.schedule.note,/while.*running/);
  const solution=await request(app,'/api/import','POST',{url:'https://github.com/independent-lab/project-memory'});assert.equal(solution.data.item.kind,'solution','examples in product prose must not reclassify the complete product');
  const adoption=await request(app,'/api/adoption','POST',{capabilityId:solution.data.item.id,requirements:{goal:'My agent forgets project conventions',agent:'Codex'}});assert.equal(adoption.data.brief.fitConfirmed,false);assert.equal(adoption.data.brief.execution.installed,false);assert.ok(adoption.data.brief.verification.some(x=>/fresh agent session/i.test(x)));
});

test('natural whole-solution requests produce explicit keyword queries without claiming fit',()=>{
  assert.equal(normalizeScoutQuery('my agent forgets small things across projects'),'agent memory');
  assert.equal(normalizeScoutQuery('open source self hosted deployment'),'self-hosted deployment');
});

test('source hydration preserves named-export file evidence and records the default adapter',async t=>{
  const original='import React from "react"; function Skeleton() { return <div />; } export { Skeleton };';
  const extraction=extractPreviewSource([{path:'components/ui/skeleton.tsx',content:original}]);
  assert.equal(extraction.sourceEvidence.path,'components/ui/skeleton.tsx');assert.ok(extraction.previewSource.startsWith(original));assert.match(extraction.previewSource,/export default Skeleton/);assert.match(extraction.sourceEvidence.note,/default-export adapter/);
  const store=createStore(await temporary(t));t.after(()=>store.close());
  const discovery=createDiscovery({store,fetcher:async url=>({url,body:'## Files\n\n### components/ui/skeleton.tsx\n\n```tsx\n'+original+'\n```',contentType:'text/markdown'})});
  const imported=await discovery.importUrl('https://registry.directory/independent-lab/widgets/skeleton');
  assert.equal(imported.sourceFiles[0].content,original+'\n');assert.equal(imported.sourceFiles[0].path,'components/ui/skeleton.tsx');
  const sourceFetchedAt=imported.provenance.sourceFetchedAt;
  store.upsertCapability({...imported,provenance:{sourceUrl:'https://registry.directory/items.json',fetchedAt:new Date().toISOString()}});
  assert.equal(store.getCapability(imported.id).provenance.sourceFetchedAt,sourceFetchedAt,'later index refresh retains separate original source timestamp');
  assert.equal(store.getCapability(imported.id).sourceFiles[0].content,original+'\n');
});

test('official MCP stdio handshake shares actual backend search, edits, export and adoption state',async t=>{
  const app=await startServer({port:0,dataDir:await temporary(t),autoScout:false,discoveryFetcher:fixtureFetcher()});t.after(()=>app.close());
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{...process.env,GLASSES_URL:app.url},stderr:'pipe'});
  const client=new Client({name:'glasses-test',version:'1.0.0'});t.after(()=>client.close());await client.connect(transport);
  const listed=await client.listTools();assert.ok(listed.tools.some(x=>x.name==='glasses_scout'));assert.ok(listed.tools.some(x=>x.name==='glasses_adoption_brief'));
  const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
  const search=await call('glasses_search',{query:'original workbench sample'});const cap=search.items.find(x=>x.origin==='sample');assert.ok(cap);assert.equal(cap.previewSource,undefined);
  const workspace=await call('glasses_create_workspace',{title:'MCP proof',capabilityId:cap.id});assert.ok(workspace.workbenchUrl.includes(workspace.id));
  await call('glasses_update_workspace',{id:workspace.id,props:{label:'Written over stdio'}});
  const exported=await call('glasses_export',{id:workspace.id});assert.match(exported.files.find(x=>x.path==='props.json').content,/Written over stdio/);
  const viaHTTP=await request(app,`/api/workspaces/${workspace.id}`);assert.equal(viaHTTP.data.props.label,'Written over stdio');
  const imported=await call('glasses_import',{url:'https://github.com/independent-lab/project-memory'});
  const evidence=await call('glasses_evidence',{id:imported.item.metadataEvidence.id});assert.equal(JSON.parse(evidence.evidence.body).full_name,fixtureRepo.full_name);
  await call('glasses_record_outcome',{capabilityId:imported.item.id,result:'failed',notes:'Synthetic integration requires a supported bridge',context:{project:'synthetic-mcp-consumer',environment:'Windows test',version:'fixture-v1'}});
  const remembered=await call('glasses_search',{query:'synthetic-mcp-consumer'});assert.equal(remembered.items[0].outcomeSummary.failed,1);assert.equal(remembered.items[0].outcomeSummary.recent[0].context.version,'fixture-v1');
  const brief=await call('glasses_adoption_brief',{capabilityId:imported.item.id,requirements:{goal:'Recall project conventions'}});assert.equal(brief.brief.fitConfirmed,false);
});

test('source refresh retains exact historical documents and visible aggregator/unsupported failures, then recovers',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  let response='## Files\n### spinner.tsx\n```tsx\nexport default function Spinner(){return <div>First source</div>}\n```',failure;
  const discovery=createDiscovery({store,fetcher:async url=>{if(failure)throw new Error(failure);return {url,body:response,contentType:'text/markdown',status:200};}});
  let item=await discovery.importUrl('https://registry.directory/testing/widgets/spinner');
  const originalId=item.sourceDocumentEvidence.id,originalBody=response,originalSource=item.sourceFiles[0].content;
  failure='HTTP 404 from registry.directory';item=await discovery.inspect(item.id,{refreshSource:true});
  assert.equal(item.sourceState.status,'error');assert.equal(item.sourceState.attemptedUrl,'https://registry.directory/api/markdown/testing/widgets/spinner');assert.equal(item.sourceState.retainedPreviousSource,true);assert.equal(item.sourceFiles[0].content,originalSource);
  failure=null;response='This source is now an unsupported format';item=await discovery.inspect(item.id,{refreshSource:true});
  assert.equal(item.sourceState.status,'unsupported');assert.equal(store.evidence().length,2,'failed format body remains inspectable');
  response='## Files\n### spinner.tsx\n```tsx\nexport default function Spinner(){return <div>New source</div>}\n```';
  item=await discovery.inspect(item.id,{refreshSource:true});
  assert.equal(item.sourceState.status,'ok');assert.equal(item.sourceError,null);assert.match(item.previewSource,/New source/);
  assert.equal(store.getEvidence(originalId).body,originalBody,'refresh never replaces retained historical raw text');
  assert.notEqual(item.sourceDocumentEvidence.id,originalId);assert.equal(store.counts().total,1);
  assert.deepEqual(item.sourceHistory.map(x=>x.status),['ok','error','unsupported','ok']);
  assert.ok(store.sources().some(x=>x.history.some(h=>h.status==='error')&&x.lastSuccessfulAt));
  await discovery.inspect(item.id,{refreshSource:true});assert.equal(store.evidence().length,3,'identical content is deduplicated');
  const compact=store.search()[0];assert.equal(compact.previewFiles,undefined);assert.equal(compact.sourceFiles,undefined);
});

test('repository inspection pins README and licence evidence to one exact commit without fabricating clearance',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());const revision='a'.repeat(40),fetched=[];
  const discovery=createDiscovery({store,fetcher:async url=>{
    fetched.push(url);let data;
    if(url.endsWith('/commits/main'))data={sha:revision};
    else if(url.includes('/license?ref='))data={path:'LICENSE',encoding:'base64',content:Buffer.from('MIT License\nCopyright Synthetic Fixture').toString('base64'),license:{spdx_id:'MIT'}};
    else if(url.includes('/readme?ref='))data={path:'README.md',encoding:'base64',content:Buffer.from('Synthetic agent memory fixture documentation').toString('base64')};
    else data=fixtureRepo;
    return {url,body:JSON.stringify(data),contentType:'application/json',status:200};
  }});
  let item=await discovery.importUrl(fixtureRepo.html_url);assert.equal(item.licenseEvidence.status,'metadata-only');
  item=await discovery.inspect(item.id,{fetchSource:true});
  assert.equal(item.provenance.resolvedRevision,revision);assert.equal(item.licenseEvidence.status,'fetched');assert.equal(item.license,'MIT');
  assert.equal(item.repositoryFiles.length,2);assert.match(item.licenseEvidence.sha256,/^[a-f0-9]{64}$/);
  assert.ok(fetched.filter(x=>/license\?|readme\?/.test(x)).every(x=>x.endsWith(`ref=${revision}`)));
  assert.ok(store.getEvidence(item.licenseEvidence.evidenceId).body.includes('base64'));
  assert.equal(store.search()[0].repositoryFiles,undefined,'source document bodies do not expand search payload');
  store.upsertCapability({...item,license:null,licenseEvidence:{status:'metadata-only'},provenance:{sourceUrl:'https://api.github.com/search/repositories'}});
  assert.equal(store.getCapability(item.id).licenseEvidence.status,'fetched','later index metadata does not discard source licence evidence');
  assert.equal(store.getCapability(item.id).license,'MIT');
});

test('multi-file source import keeps exact files, dependency declarations, and distinct preview adaptation',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  const files=[{path:'components/spinner.tsx',content:'import {dot} from "./dot"; export function Spinner(){return <div>{dot}</div>}'},{path:'components/dot.ts',content:'export const dot=".";'}];
  const payload={name:'spinner',dependencies:['react','lucide-react'],registryDependencies:['utils'],files};
  const discovery=createDiscovery({store,fetcher:async url=>({url,body:JSON.stringify(payload),contentType:'application/json',status:200})});
  const item=await discovery.importUrl('https://unfamiliar-widgets.dev/r/spinner.json');
  assert.deepEqual(item.sourceFiles,files);assert.equal(item.previewEntryPath,files[0].path);assert.equal(item.previewFiles.length,2);
  assert.match(item.previewFiles[0].content,/export default Spinner/);assert.ok(!item.sourceFiles[0].content.includes('export default Spinner'));
  assert.deepEqual(item.dependencies,['react','lucide-react']);assert.equal(item.sourceEvidence.files.length,2);
  assert.equal(item.licenseStatus,'unknown');assert.equal(item.licenseEvidence.spdx,null);
});

test('contextual outcomes survive restart and reappear in compact search with source identity',async t=>{
  const directory=await temporary(t);let store=createStore(directory);
  const {item}=store.upsertCapability({url:'https://components.example.org/spinner',name:'Spinner',kind:'component',origin:'live',license:'MIT',provenance:{sourceHash:'b'.repeat(64),resolvedRevision:'c'.repeat(40)}});
  store.recordOutcome({capabilityId:item.id,result:'failed',notes:'Pointer selection unsupported in virtual portal',context:{project:'synthetic-consumer',stack:'React 19',environment:'Windows Chromium',version:'24.14.0',evidencePath:'evidence/synthetic-failure.json'}});
  store.close();store=createStore(directory);t.after(()=>store.close());
  const results=store.search({query:'virtual portal Windows'});assert.equal(results.length,1);
  assert.equal(results[0].outcomeSummary.failed,1);assert.equal(results[0].outcomeSummary.recent[0].context.project,'synthetic-consumer');
  assert.equal(results[0].outcomeSummary.recent[0].sourceSnapshot.revision,'c'.repeat(40));
  assert.equal(results[0].outcomeSummary.recent[0].shared,false);assert.match(results[0].matchReason,/outcome context/);
});

test('refreshing pinned files invalidates their licence scope when a different source is fetched',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  const source='export default function Spinner(){return <div>changed upstream</div>}';
  const discovery=createDiscovery({store,fetcher:async url=>({url,body:`## Files\n### spinner.tsx\n\`\`\`tsx\n${source}\n\`\`\``,contentType:'text/markdown',status:200})});
  const {item}=store.upsertCapability({url:'https://registry.directory/testing/widgets/spinner',name:'Spinner',kind:'component',license:'MIT',licenseEvidence:{status:'fetched',scope:'exact-repository-files',revision:'d'.repeat(40)},provenance:{sourceHash:'e'.repeat(64)}});
  const refreshed=await discovery.inspect(item.id,{refreshSource:true});
  assert.equal(refreshed.licenseStatus,'unknown');assert.equal(refreshed.license,null);
  assert.equal(refreshed.licenseEvidence.status,'unverified-current-source');assert.equal(refreshed.licenseEvidence.previous.revision,'d'.repeat(40));
  assert.equal(store.search({openSourceOnly:true}).length,0,'old pinned licence cannot clear a different source');
});

test('reimport never presents an old preview or pinned licence as evidence for replacement source',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  const url='https://widgets.example.org/r/spinner.json';let files=[{path:'spinner.tsx',content:'export default function Spinner(){return <div>Original</div>}'}];
  const discovery=createDiscovery({store,fetcher:async url=>({url,body:JSON.stringify({name:'spinner',files}),contentType:'application/json',status:200})});
  let item=await discovery.importUrl(url);
  item=store.upsertCapability({...item,license:'MIT',licenseEvidence:{status:'fetched',scope:'exact-repository-files',revision:'f'.repeat(40)}}).item;
  files=[{path:'styles.css',content:'.replacement { color: red; }'}];item=await discovery.importUrl(url);
  assert.equal(item.licenseStatus,'unknown');assert.equal(item.licenseEvidence.status,'unverified-current-source');
  assert.equal(item.previewSource,null);assert.deepEqual(item.previewFiles,[]);assert.equal(item.sourceState.status,'unsupported');
  assert.equal(item.sourceFiles[0].content,files[0].content);assert.match(item.sourceError,/no supported exported React component/);
  assert.throws(()=>store.createWorkspace({capabilityId:item.id}),/no preview source/);
});
