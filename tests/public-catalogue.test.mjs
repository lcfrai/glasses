import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStore, stableId } from '../src/store.mjs';
import { createIntelligenceStore } from '../src/intelligence-store.mjs';
import { INTELLIGENCE_SCHEMA } from '../src/intelligence.mjs';
import { createPublicCatalogue, validatePublicCatalogue, mergePublicCatalogues } from '../src/public-catalogue.mjs';
import { readPublicCatalogueInputs, admitPublicGithubCandidates } from '../scripts/export-public-catalogue.mjs';
import { startServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const time='2026-09-29T00:00:00.000Z',later='2026-09-30T00:00:00.000Z';
const sha=value=>createHash('sha256').update(value).digest('hex');
function evidence(url,data,observedAt=time){const body=JSON.stringify(data),sha256=sha(body);return {id:stableId(`${url}\n${sha256}`),url,body,sha256,bytes:Buffer.byteLength(body),status:200,contentType:'application/json',firstFetchedAt:observedAt,lastFetchedAt:observedAt};}
function repo(overrides={}) {return {name:'memory',full_name:'public-lab/memory',html_url:'https://github.com/public-lab/memory',description:'Persistent conventions for existing agents.',topics:['memory','agent'],private:false,license:{spdx_id:'MIT'},stargazers_count:1234,archived:false,...overrides};}
function fixture({row=repo(),endpoint='https://api.github.com/repos/public-lab/memory',observedAt=time}={}){
  const snapshot=evidence(endpoint,endpoint.includes('/search/')?{items:[row]}:row,observedAt);
  const capability={id:stableId(row.html_url),url:row.html_url,name:row.full_name,description:row.description,kind:'solution',provider:'GitHub',tags:row.topics,origin:'live',metadataEvidence:{...snapshot,body:undefined},provenance:{sourceUrl:endpoint,revision:'branch:main',note:'PRIVATE_HISTORY_QUOTE',threadId:'PRIVATE_CHAT_ID'},outcomes:[{notes:'PRIVATE_OUTCOME',evidencePath:'F:\\Private\\test.json'}],workspaceId:'PRIVATE_WORKSPACE',privateNotes:'PRIVATE_NOTES'};
  const base={id:capability.id,name:capability.name,url:capability.url,description:capability.description,provider:capability.provider,sourceKind:capability.kind,tags:capability.tags};
  const sourceFingerprint=sha(JSON.stringify({schema:INTELLIGENCE_SCHEMA,...base,evidenceIds:[snapshot.id],revision:'branch:main',sourceHash:null}));
  const assessment={id:capability.id,classification:{artifact:'agent-extension',adoption:'configure-agent',capabilities:['durable recall'],confidence:0.88,evidenceIds:[snapshot.id]},provider:'jev',model:'jev-1.13.0',schemaVersion:INTELLIGENCE_SCHEMA,sourceFingerprint,updatedAt:time,jobId:'PRIVATE_JOB'};
  return {capabilities:[capability],evidence:[snapshot],assessments:[assessment],generatedAt:time};
}

test('projection reconstructs upstream metadata and excludes local/private context and bodies',()=>{
  const input=fixture();input.capabilities[0].github={stars:999999999,starsFetchedAt:later};input.capabilities[0].license='Apache-2.0';
  const {snapshot,report}=createPublicCatalogue(input),item=snapshot.items[0],serialized=JSON.stringify(snapshot);
  assert.equal(report.exported,1);assert.equal(item.github.stars,1234);assert.equal(item.github.starsObservedAt,time);assert.equal(item.license.spdx,'MIT');assert.equal(item.license.basis,'upstream-metadata');
  assert.equal(item.assessment.artifact,'agent-extension');assert.equal(item.assessment.provider,'jev');assert.equal(snapshot.capabilities.portableInferenceCache,false);
  assert.equal(item.citations[0].endpoint,'https://api.github.com/repos/public-lab/memory');assert.equal(item.citations[0].recordUrl,item.url);assert.equal(item.citations[0].sha256,input.evidence[0].sha256);
  for(const privateText of ['PRIVATE_','Private','sourceFingerprint','body','jobId','threadId','outcomes','notes','contentType'])assert.ok(!serialized.includes(privateText),privateText);
  assert.deepEqual(validatePublicCatalogue(JSON.stringify(snapshot)),snapshot);
});

test('queried search metadata is shareable but model text derived from a private query is omitted',()=>{
  const input=fixture({endpoint:'https://api.github.com/search/repositories?q=PRIVATE_RESEARCH_PROMPT'});input.assessments[0].classification.capabilities=['PRIVATE_RESEARCH_PROMPT'];
  const {snapshot,report}=createPublicCatalogue(input);assert.equal(snapshot.items.length,1);assert.equal(snapshot.items[0].assessment,null);assert.equal(report.assessmentOmitted,1);assert.equal(snapshot.items[0].citations[0].endpoint,'https://api.github.com/search/repositories');assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
});

test('publication admission excludes unrelated historical GitHub hits and preserves registry metadata candidates',()=>{
  const input=fixture(),registry={url:'https://registry.directory/public/ui/dialog',origin:'live'};input.capabilities.push({url:'https://github.com/irrelevant/spam',origin:'live'},registry);
  const admitted=admitPublicGithubCandidates(input,['https://github.com/PUBLIC-LAB/MEMORY/']);assert.equal(admitted.omitted,1);assert.equal(admitted.inputs.capabilities.length,2);assert.ok(admitted.inputs.capabilities.includes(registry));assert.equal(input.capabilities.length,3);assert.throws(()=>admitPublicGithubCandidates(input,['https://github.com/public-lab/memory?private=query']));
});

test('official numeric repository redirects and public HTTPS prose survive projection without weakening local-path guards',()=>{
  const input=fixture({row:repo({id:10270250,description:'Public API tooling at https://example.org/ and a web client.'}),endpoint:'https://api.github.com/repositories/10270250'});
  const snapshot=createPublicCatalogue(input).snapshot;assert.equal(snapshot.items.length,1);assert.match(snapshot.items[0].description,/https:\/\/example.org/);assert.equal(snapshot.items[0].citations[0].endpoint,'https://api.github.com/repositories/10270250');assert.ok(snapshot.items[0].assessment);
  const wrong=fixture({row:repo({id:987}),endpoint:'https://api.github.com/repositories/10270250'});assert.equal(createPublicCatalogue(wrong).snapshot.items.length,0);
  const localPath=fixture({row:repo({description:'Local file C:\\Private\\notes.md'})});assert.equal(createPublicCatalogue(localPath).snapshot.items.length,0);
  const casing=fixture({row:repo({html_url:'https://github.com/Public-Lab/Memory'})});casing.capabilities[0].url='https://github.com/public-lab/memory';assert.equal(createPublicCatalogue(casing).snapshot.items.length,1);
});

test('locally changed descriptions, labels and stale or unknown-policy assessments never leak into public inference',()=>{
  for(const mutate of [value=>{value.capabilities[0].description='PRIVATE_DESCRIPTION';},value=>{value.capabilities[0].tags=['PRIVATE_TAG'];},value=>{value.assessments[0].sourceFingerprint='a'.repeat(64);},value=>{value.assessments[0].schemaVersion='unknown-policy';},value=>{value.assessments[0].provider='agent';},value=>{value.assessments[0].model='different-model';},value=>{value.assessments[0].classification.evidenceIds=['invented'];},value=>{value.assessments[0].classification.capabilities=['F:\\Private\\history.md'];}]){
    const input=fixture();mutate(input);const {snapshot,report}=createPublicCatalogue(input);assert.equal(snapshot.items[0].assessment,null);assert.equal(report.assessmentOmitted,1);assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
  }
});

test('registry items and provider cards keep identity, licence scope and no borrowed repository stars',()=>{
  const entries=[{name:'tabs',description:'Tabbed content',type:'registry:ui',categories:['navigation'],registry:{basePath:'/public/ui',name:'Public UI'}},{name:'dialog',description:'Modal content',license:'BUSL-1.1',registry:{basePath:'/public/ui',name:'Public UI'}}];
  const index=evidence('https://registry.directory/items.json',{items:entries}),directory=evidence('https://registry.directory/directory.json',{registries:[{name:'Public UI',url:'https://public-ui.dev/',description:'UI collection',license:'MIT',namespace:'public',github_url:'https://github.com/public/ui'}]});
  const caps=entries.map(row=>({id:stableId(`https://registry.directory/public/ui/${row.name}`),url:`https://registry.directory/public/ui/${row.name}`,origin:'live',metadataEvidence:index,github:{stars:99999},license:'MIT'}));caps.push({url:'https://public-ui.dev/',origin:'live',metadataEvidence:directory});
  const {snapshot}=createPublicCatalogue({capabilities:caps,evidence:[index,directory],generatedAt:time});assert.equal(snapshot.counts.total,3);assert.equal(snapshot.counts.withStars,0);
  const tabs=snapshot.items.find(item=>item.name==='tabs'),dialog=snapshot.items.find(item=>item.name==='dialog'),provider=snapshot.items.find(item=>item.name==='Public UI');
  assert.equal(tabs.license.status,'unknown');assert.equal(dialog.license.status,'restricted');assert.equal(dialog.license.scope,'registry-item');assert.equal(provider.license.scope,'registry-provider');assert.equal(provider.kind,'reference');assert.notEqual(tabs.id,dialog.id);
});

test('source bodies are excluded even when registry item JSON embeds code or a secret-shaped string',()=>{
  const url='https://public-ui.dev/r/button.json',snapshot=evidence(url,{name:'button',description:'A button',license:'MIT',files:[{path:'button.tsx',content:'PRIVATE_SOURCE_BODY sk-1234567890123456789'}]});
  const output=createPublicCatalogue({capabilities:[{url,origin:'live',sourceDocumentEvidence:snapshot}],evidence:[snapshot],generatedAt:time}).snapshot;
  assert.equal(output.items.length,1);assert.ok(!JSON.stringify(output).includes('PRIVATE_SOURCE_BODY'));assert.equal(output.items[0].license.scope,'registry-item');
});

test('corrupt, private, unsupported and credentialled source evidence is excluded without exposing rejection contents',()=>{
  const cases=[input=>{input.evidence[0].body+='tampered';},input=>{input.capabilities[0].origin='seed';},input=>{input.evidence[0].status=404;},input=>{input.capabilities[0].url+='?token=PRIVATE_SECRET';},input=>{input.evidence[0].url='https://user:password@api.github.com/repos/public-lab/memory';},input=>{input.evidence[0].id='forged';}];
  for(const mutate of cases){const input=fixture();mutate(input);const result=createPublicCatalogue(input);assert.equal(result.snapshot.items.length,0);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));}
  const privateRepo=fixture({row:repo({private:true})});assert.equal(createPublicCatalogue(privateRepo).snapshot.items.length,0);
  const missingVisibility=fixture({row:repo({private:undefined})});assert.equal(createPublicCatalogue(missingVisibility).snapshot.items.length,0);
  const unknown=evidence('https://example.org/page',{name:'Private local invented label'});assert.equal(createPublicCatalogue({capabilities:[{url:'https://example.org/page',origin:'live',metadataEvidence:unknown}],evidence:[unknown]}).snapshot.items.length,0);
});

test('strict import validation rejects extra nested fields, forged IDs/hashes, rights upgrades and broken citations',()=>{
  const snapshot=createPublicCatalogue(fixture()).snapshot;
  for(const mutate of [pack=>{pack.privateHistory=[];},pack=>{pack.items[0].notes='PRIVATE';},pack=>{pack.items[0].license.localPath='F:\\Private';},pack=>{pack.items[0].id='0'.repeat(20);},pack=>{pack.items[0].citations[0].id='0'.repeat(20);},pack=>{pack.items[0].assessment.citationIds=['0'.repeat(20)];},pack=>{pack.items[0].license.status='unknown';},pack=>{pack.contentHash='0'.repeat(64);},pack=>{pack.items[0].url='https://127.0.0.1/private';},pack=>{pack.items[0].github.starsObservedAt=null;},pack=>{pack.formatVersion=2;}]){
    const tampered=structuredClone(snapshot);mutate(tampered);assert.throws(()=>validatePublicCatalogue(tampered));
  }
  assert.throws(()=>validatePublicCatalogue('{bad JSON'),/Invalid/);
});

test('public-layer merge is zero-network, idempotent and conservative with conflicting observations',()=>{
  const first=createPublicCatalogue(fixture()).snapshot,newer=createPublicCatalogue(fixture({row:repo({stargazers_count:2000}),observedAt:later})).snapshot;
  const before=JSON.stringify(first),merged=mergePublicCatalogues(first,newer,{generatedAt:later});assert.equal(merged.report.updated,1);assert.equal(merged.snapshot.items[0].github.stars,2000);assert.equal(JSON.stringify(first),before);
  const repeated=mergePublicCatalogues(merged.snapshot,newer,{generatedAt:time});assert.equal(repeated.report.unchanged,1);assert.equal(repeated.snapshot.contentHash,merged.snapshot.contentHash);
  const rollback=mergePublicCatalogues(merged.snapshot,first);assert.equal(rollback.report.conflicts,1);assert.equal(rollback.snapshot.items[0].github.stars,2000);
  const other=createPublicCatalogue(fixture({row:repo({name:'other',full_name:'public-lab/other',html_url:'https://github.com/public-lab/other'})})).snapshot;
  assert.equal(mergePublicCatalogues(first,other).snapshot.counts.total,2);
});

test('database export reads only public-input tables and leaves original state untouched; CLI validates and merges offline',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-public-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=createStore(directory),raw=fixture({endpoint:'https://api.github.com/repos/public-lab/memory'}),snapshot=raw.evidence[0];
  const retained=store.retainEvidence({url:snapshot.url,body:snapshot.body,status:200,fetchedAt:time});store.upsertCapability({...raw.capabilities[0],metadataEvidence:retained});
  store.createWorkspace({title:'PRIVATE_WORKSPACE',source:'export default ()=>null'});store.recordOutcome({capabilityId:raw.capabilities[0].id,result:'worked',notes:'PRIVATE_OUTCOME'});store.setSetting('PRIVATE_SETTING',{key:'PRIVATE_KEY'});store.close();
  const intelligence=createIntelligenceStore(directory);intelligence.save('assessments',raw.assessments[0]);intelligence.save('jobs',{id:'PRIVATE_JOB',query:'PRIVATE_RESEARCH'});intelligence.save('corrections',{id:raw.capabilities[0].id,patch:{notes:'PRIVATE_CORRECTION'}});intelligence.close();
  const dbBefore=sha(await readFile(join(directory,'glasses.sqlite'))),inputs=readPublicCatalogueInputs(directory),result=createPublicCatalogue(inputs);assert.equal(result.snapshot.items.length,1);assert.ok(!JSON.stringify(result.snapshot).includes('PRIVATE_'));assert.equal(sha(await readFile(join(directory,'glasses.sqlite'))),dbBefore);
  await writeFile(join(directory,'jev-credentials.json'),'PRIVATE_CREDENTIAL_FILE_MUST_NOT_BE_READ');
  const output=join(directory,'public.json'),schema=join(directory,'schema.json');
  const run=spawnSync(process.execPath,['scripts/export-public-catalogue.mjs','--data-dir',directory,'--out',output,'--schema-out',schema],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.equal(validatePublicCatalogue(await readFile(output,'utf8')).counts.total,1);assert.ok(!run.stdout.includes('PRIVATE_'));
  const validate=spawnSync(process.execPath,['scripts/export-public-catalogue.mjs','--validate',output],{encoding:'utf8'});assert.equal(validate.status,0,validate.stderr);
  const merge=spawnSync(process.execPath,['scripts/export-public-catalogue.mjs','--merge',output,'--input',output,'--out',join(directory,'merged.json')],{encoding:'utf8'});assert.equal(merge.status,0,merge.stderr);assert.equal(JSON.parse(merge.stdout).report.unchanged,1);assert.equal(sha(await readFile(join(directory,'glasses.sqlite'))),dbBefore);
});

test('CLI import is immediately searchable through real MCP, idempotent and private overlays remain unchanged',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-shared-mcp-'));let app,client,transport,networkCalls=0,inferenceCalls=0;
  const providers={status:async()=>({codex:{configured:false,model:'gpt-6-luna'},jev:{configured:false,model:'jev-1.13.0'}}),classify:async()=>{inferenceCalls++;throw new Error('Unexpected inference');},plan:async()=>{inferenceCalls++;throw new Error('Unexpected inference');},rank:async()=>{inferenceCalls++;throw new Error('Unexpected inference');}};
  try{
    app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,providers,discoveryFetcher:async()=>{networkCalls++;throw new Error('Unexpected external request');}});
    const publicPack=createPublicCatalogue(fixture()).snapshot,localPack=createPublicCatalogue(fixture({row:repo({name:'other',full_name:'public-lab/other',html_url:'https://github.com/public-lab/other'}),endpoint:'https://api.github.com/repos/public-lab/other'})).snapshot;
    const merged=mergePublicCatalogues(publicPack,localPack).snapshot,local=app.store.upsertCapability({url:localPack.items[0].url,name:'PRIVATE_LOCAL_NAME',description:'PRIVATE_LOCAL_DESCRIPTION',kind:'solution',origin:'live'}).item;
    app.store.recordOutcome({capabilityId:local.id,result:'worked',notes:'PRIVATE_OUTCOME'});app.intelligence.correctAssessment(local.id,{artifact:'tool-library',notes:'PRIVATE_CORRECTION'});
    const workspace=app.store.createWorkspace({capabilityId:local.id,source:'export default ()=> <div>PRIVATE_WORKSPACE</div>'});
    const before={item:JSON.stringify(app.store.getCapability(local.id)),outcomes:JSON.stringify(app.store.outcomes()),workspace:JSON.stringify(app.store.getWorkspace(workspace.id)),correction:JSON.stringify(app.intelligence.getAssessment(local.id))};
    const path=join(directory,'pack.json');await writeFile(path,JSON.stringify(merged));
    const invoke=()=>spawnSync(process.execPath,['scripts/export-public-catalogue.mjs','--import',path,'--data-dir',directory],{encoding:'utf8'});
    const first=invoke();assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).report.added,2);assert.equal(JSON.parse(first.stdout).report.localOverrides,1);
    const repeat=invoke();assert.equal(repeat.status,0,repeat.stderr);assert.equal(JSON.parse(repeat.stdout).report.unchanged,2);assert.equal(app.store.counts().total,2);
    assert.equal(JSON.stringify(app.store.getCapability(local.id)),before.item);assert.equal(JSON.stringify(app.store.outcomes()),before.outcomes);assert.equal(JSON.stringify(app.store.getWorkspace(workspace.id)),before.workspace);assert.equal(JSON.stringify(app.intelligence.getAssessment(local.id)),before.correction);
    transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{GLASSES_URL:app.url,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stderr:'pipe'});client=new Client({name:'shared-catalogue-contract',version:'1'});await client.connect(transport);
    const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
    const search=await call('glasses_search',{query:'durable recall'});assert.equal(search.items.length,1);const shared=search.items[0];assert.equal(shared.origin,'shared');assert.equal(shared.sharedPublication.contentHash,merged.contentHash);assert.equal(shared.assessment.status,'unclassified');assert.equal(shared.sharedAssessment.artifact,'agent-extension');assert.match(shared.matchReason,/shared labels are not locally verified/);
    const detail=(await call('glasses_inspect',{id:shared.id,fetchSource:false})).item;assert.equal(detail.sourceFiles,undefined);assert.equal(detail.metadataEvidence,undefined);assert.equal(detail.licenseEvidence.status,'metadata-only');assert.equal(detail.sharedCitations.length,1);
    assert.equal(app.intelligence.listJobs().total,0);assert.equal(app.store.evidence().length,0);assert.equal(networkCalls,0);assert.equal(inferenceCalls,0);
    app.intelligence.updateSettings({autoClassify:true});assert.equal(app.intelligence.afterDiscovery({id:'synthetic',trigger:'scheduled',candidateIds:[shared.id]}),null);assert.equal(app.intelligence.listJobs().total,0,'Shared imported inference is not silently scheduled as local work');
    app.store.recordOutcome({capabilityId:shared.id,result:'rejected',notes:'PRIVATE_SHARED_OUTCOME'});assert.equal(app.store.outcomes(shared.id).length,1);
    const malformed=structuredClone(merged);malformed.items[0].name='changed without new hash';await assert.rejects(app.store.importPublicCatalogue(malformed));assert.equal(app.store.counts().total,2);assert.equal(app.store.getCapability(shared.id).name,shared.name);
    await client.close();client=null;await app.close();app=null;
    const reopened=createStore(directory);assert.equal(reopened.getCapability(shared.id).origin,'shared');assert.equal(reopened.outcomes(shared.id)[0].notes,'PRIVATE_SHARED_OUTCOME');reopened.close();
  }finally{if(client)await client.close();else if(transport)await transport.close();if(app)await app.close();await rm(directory,{recursive:true,force:true});}
});

test('shared direct-registry item fetches upstream only when explicitly inspected',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-shared-source-'));let app,requests=0;
  const url='https://public-ui.dev/r/button.json',body=JSON.stringify({name:'button',description:'Button',files:[{path:'button.tsx',content:'export default function Button(){return <button>Source fetched now</button>}'}]});
  const snapshot=evidence(url,JSON.parse(body)),pack=createPublicCatalogue({capabilities:[{url,origin:'live',sourceDocumentEvidence:snapshot}],evidence:[snapshot]}).snapshot;
  try{
    app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,providers:{status:async()=>({}),classify:async()=>{throw new Error('Unexpected inference');},plan:async()=>{throw new Error('Unexpected inference');},rank:async()=>{throw new Error('Unexpected inference');}},discoveryFetcher:async requested=>{requests++;assert.equal(requested,url);return {url,body,status:200,contentType:'application/json'};}});
    await app.store.importPublicCatalogue(pack);assert.equal(requests,0);assert.equal(app.store.getCapability(pack.items[0].id).origin,'shared');assert.equal(app.store.getCapability(pack.items[0].id).licenseStatus,'unknown');
    const inspected=await app.discovery.inspect(pack.items[0].id,{fetchSource:true});assert.equal(requests,1);assert.equal(inspected.origin,'live');assert.match(inspected.sourceFiles[0].content,/Source fetched now/);assert.equal(inspected.licenseStatus,'unknown');assert.equal(app.intelligence.listJobs().total,0);
  }finally{if(app)await app.close();await rm(directory,{recursive:true,force:true});}
});

test('first normal startup preserves an imported Coolify record rather than shadowing it with a seed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-shared-seed-'));let app;
  try{
    const pack=createPublicCatalogue(fixture({row:repo({name:'coolify',full_name:'coollabsio/coolify',html_url:'https://github.com/coollabsio/coolify',description:'Synthetic public deployment metadata',stargazers_count:43210}),endpoint:'https://api.github.com/repos/coollabsio/coolify'})).snapshot;
    const store=createStore(directory);await store.importPublicCatalogue(pack);const before=JSON.stringify(store.getCapability(pack.items[0].id));store.close();
    app=await startServer({port:0,dataDir:directory,autoScout:false,providers:{status:async()=>({}),classify:async()=>{},plan:async()=>{},rank:async()=>{}}});
    const item=app.store.getCapability(pack.items[0].id);assert.equal(item.origin,'shared');assert.equal(item.github.stars,43210);assert.equal(JSON.stringify(item),before);assert.equal(app.store.search().filter(row=>row.url===item.url).length,1);assert.equal(app.store.getSetting('seedVersion'),1);assert.ok(app.store.search().some(row=>row.origin==='sample'));
  }finally{if(app)await app.close();await rm(directory,{recursive:true,force:true});}
});
