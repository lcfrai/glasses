import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createDiscovery} from '../src/discovery.mjs';
import {createBulkDiscovery,validateBulkPlan,BULK_DEFAULT_LANES} from '../src/bulk-discovery.mjs';
import {createBulkSourceAdapters} from '../src/bulk-sources.mjs';
import {createPublicSourceFetcher} from '../src/public-source-fetcher.mjs';
import {createBulkImporter} from '../src/bulk-import.mjs';
import {bulkScanOptions,runBulkScan} from '../scripts/bulk-scan.mjs';
import {createHash} from 'node:crypto';

const response=(url,body)=>({url,status:200,contentType:'application/json',body:typeof body==='string'?body:JSON.stringify(body)});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'glasses-bulk-')),store=createStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});const ref=store.retainEvidence(response('https://example.org/public-source.json',{testFixture:true}));
 const candidate=(lane,n)=>({url:`https://github.com/fixture/${lane}-${n}`,name:`${lane}-${n}`,sourceKind:'github-repository',requestedResourceType:lane,provenance:{adapter:'github-repositories',sourceUrl:ref.url,evidence:[ref]}});
 const calls=[];const discovery={scouting:false,async importUrl(url,{signal}={}){signal?.throwIfAborted();calls.push(url);return store.upsertCapability({url,name:url.split('/').at(-1),kind:'solution',provider:'Fixture only',description:'Isolated synthetic adapter trial',tags:[],license:'MIT',origin:'live'}).item;}};
 return{dir,store,ref,candidate,calls,discovery};}
const lane=(resourceType='tool',extra={})=>({resourceType,weight:1,limit:20,sources:[{adapter:'github-repositories',query:resourceType}],...extra});
function paged(f,{pages=3,perPage=2}={}){return{'github-repositories':async({lane,cursor})=>{const page=cursor?.page||0;return{candidates:Array.from({length:perPage},(_,i)=>f.candidate(lane,page*perPage+i)),nextCursor:page+1<pages?{page:page+1}:null,exhausted:page+1>=pages,evidence:[f.ref]};}};}

test('defaults expose six bounded lanes and retain no classifier budget mutation',async t=>{
 const f=await fixture(t);f.store.setSetting('intelligence',{dailyBudgetUsd:9,autoClassify:false,maxJobsPerDay:200});const engine=createBulkDiscovery({...f,adapters:paged(f)}),plan=engine.createPlan();
 assert.deepEqual(plan.lanes.map(row=>row.resourceType),['tool','component','skill','agent','collection','reference']);assert.equal(plan.maxCandidates,240);assert.equal(plan.lanes[0].weight,3);assert.equal(plan.lanes[1].weight,2);
 assert.deepEqual(f.store.getSetting('intelligence'),{dailyBudgetUsd:9,autoClassify:false,maxJobsPerDay:200});assert.deepEqual(engine.status().modelCalls,false);
 for(const input of [null,{secret:true},{maxCandidates:2001},{maxPages:151},{pageSize:31},{lanes:[lane(),lane()]},{lanes:[lane('invalid')]},{lanes:[lane('tool',{sources:[{adapter:'public-reference',url:'https://127.0.0.1/private'}]})]}])assert.throws(()=>validateBulkPlan(input));
 assert.equal(BULK_DEFAULT_LANES.length,6);
});

test('bounded batches durably resume exact pending pages across engine instances',async t=>{
 const f=await fixture(t),adapters=paged(f),one=createBulkDiscovery({...f,adapters}),plan=one.createPlan({lanes:[lane()],pageSize:2});
 let result=await one.run(plan.id,{maxSteps:2});assert.equal(result.status,'paused');assert.equal(result.stats.pages,1);assert.equal(result.stats.added,1);assert.equal(result.lanes[0].sources[0].pendingCount,1);
 const two=createBulkDiscovery({...f,adapters});result=await two.run(plan.id,{maxSteps:30});assert.equal(result.status,'completed');assert.equal(result.stats.added,6);assert.equal(new Set(f.calls).size,6);assert.equal(result.stats.pages,3);assert.equal(result.entries.length,6);
 assert.ok(result.entries.every(entry=>entry.provenance.evidence[0].sha256===f.ref.sha256));assert.equal((await two.run(plan.id)).stats.added,6);
});

test('weighted scheduling keeps smaller resource lanes progressing despite component abundance',async t=>{
 const f=await fixture(t),order=[],base=paged(f,{pages:10,perPage:2});const adapters={'github-repositories':async request=>{order.push(request.lane);return base['github-repositories'](request);}};
 const engine=createBulkDiscovery({...f,adapters}),plan=engine.createPlan({lanes:[lane('tool',{weight:3}),lane('component',{weight:2}),lane('skill'),lane('agent'),lane('collection'),lane('reference')],pageSize:2});
 await engine.run(plan.id,{maxSteps:18});for(const type of ['tool','component','skill','agent','collection','reference'])assert.ok(order.includes(type));assert.ok(order.filter(x=>x==='component').length<=order.filter(x=>x!=='component').length);
});

test('duplicate URLs and already known records are accounted without repeat acquisition',async t=>{
 const f=await fixture(t);await f.discovery.importUrl(f.candidate('tool',0).url);f.calls.length=0;const adapters={'github-repositories':async()=>({candidates:[f.candidate('tool',0),f.candidate('tool',1),f.candidate('tool',1)],exhausted:true,nextCursor:null,evidence:[f.ref]})};
 const engine=createBulkDiscovery({...f,adapters}),plan=engine.createPlan({lanes:[lane()],pageSize:3}),result=await engine.run(plan.id);
 assert.equal(result.stats.existing,1);assert.equal(result.stats.duplicate,1);assert.equal(result.stats.added,1);assert.equal(f.calls.length,1);assert.equal(f.store.counts().total,2);
});

test('global candidate and source-page caps stop before excess imports and amend resumes without resetting counters',async t=>{
 const f=await fixture(t),engine=createBulkDiscovery({...f,adapters:paged(f,{pages:3,perPage:2})}),plan=engine.createPlan({lanes:[lane()],pageSize:2,maxCandidates:2,maxPages:1});
 let result=await engine.run(plan.id);assert.equal(result.status,'bounded');assert.equal(result.stats.added,2);assert.equal(result.stats.pages,1);
 assert.throws(()=>engine.amendPlan(plan.id,{expectedVersion:1,maxCandidates:6,maxPages:3}),/version/);
 engine.amendPlan(plan.id,{expectedVersion:result.version,maxCandidates:6,maxPages:3});result=await engine.run(plan.id);assert.equal(result.status,'completed');assert.equal(result.stats.added,6);assert.equal(f.calls.length,6);
});

test('a saturated lane reports a bound rather than falsely claiming exhausted sources',async t=>{
 const f=await fixture(t),engine=createBulkDiscovery({...f,adapters:paged(f,{pages:3,perPage:2})}),plan=engine.createPlan({lanes:[lane('tool',{limit:1})],pageSize:2});const result=await engine.run(plan.id);
 assert.equal(result.status,'bounded');assert.equal(result.stats.added,1);assert.equal(result.lanes[0].sources[0].pendingCount,1);
});

test('upstream throttle retains cursor, records the exact failure and resumes at the same source page',async t=>{
 const f=await fixture(t);let fail=true;const adapters={'github-repositories':async()=>{if(fail)throw Error('HTTP 429 rate limit');return{candidates:[f.candidate('tool',0)],exhausted:true,nextCursor:null,evidence:[f.ref]};}};
 const engine=createBulkDiscovery({...f,adapters}),plan=engine.createPlan({lanes:[lane()]});let result=await engine.run(plan.id);assert.equal(result.status,'paused');assert.equal(result.reason,'upstream-rate-limit');assert.equal(result.stats.pages,0);assert.match(result.errors[0].message,/429/);
 fail=false;result=await engine.run(plan.id);assert.equal(result.stats.added,1);assert.equal(result.stats.pages,1);
});

test('recoverable source failures do not starve other lanes and explicit retry handles terminal failures',async t=>{
 const f=await fixture(t);let fail=true;const base=paged(f,{pages:1,perPage:1}),adapters={'github-repositories':async request=>{if(request.lane==='tool'&&fail)throw Error('temporarily unavailable');return base['github-repositories'](request);}};
 const engine=createBulkDiscovery({...f,adapters}),plan=engine.createPlan({lanes:[lane('tool'),lane('reference')]}),first=await engine.run(plan.id);assert.equal(first.status,'partial');assert.equal(first.stats.added,1);assert.equal(first.lanes[0].sources[0].failed,true);
 fail=false;const result=await engine.run(plan.id,{retryFailed:true});assert.equal(result.stats.added,2);assert.equal(result.lanes[0].sources[0].failed,false);
});

test('failed candidate proposals are retained and retry remains within cumulative caps',async t=>{
 const f=await fixture(t);let fail=true;const engine=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1}),importCandidate:async(candidate,{signal})=>{if(fail)throw Error('source fetch failed');return{item:await f.discovery.importUrl(candidate.url,{signal}),added:true};}}),plan=engine.createPlan({lanes:[lane()]});
 let result=await engine.run(plan.id);assert.equal(result.stats.failed,1);assert.equal(result.entries[0].proposal.url,f.candidate('tool',0).url);fail=false;result=await engine.run(plan.id,{retryFailed:true});assert.equal(result.stats.added,1);assert.equal(result.stats.attempted,2);assert.equal(result.stats.failed,1);
});

test('guidance without a configured source importer stays review-required and is not fabricated as live',async t=>{
 const f=await fixture(t),candidate={...f.candidate('skill',0),sourceKind:'github-guidance'},adapters={'github-repositories':async()=>({candidates:[candidate],exhausted:true,nextCursor:null,evidence:[f.ref]})};const engine=createBulkDiscovery({...f,adapters}),plan=engine.createPlan({lanes:[lane('skill')]});const result=await engine.run(plan.id);
 assert.equal(result.stats.reviewRequired,1);assert.equal(result.stats.added,0);assert.equal(f.store.counts().total,0);assert.equal(result.entries[0].proposal.sourceKind,'github-guidance');
});

test('typed importer reviewRequired and related admitted parents are preserved',async t=>{
 const f=await fixture(t);const parent=await f.discovery.importUrl('https://github.com/fixture/collection'),engine=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:2}),importCandidate:async candidate=>candidate.url.endsWith('-0')?{reviewRequired:true,reason:'Scoped licence missing'}:{item:await f.discovery.importUrl(candidate.url),added:true,relatedIds:[parent.id,'missing']}}),plan=engine.createPlan({lanes:[lane()],pageSize:2}),result=await engine.run(plan.id);
 assert.equal(result.stats.reviewRequired,1);assert.equal(result.stats.added,1);assert.deepEqual(result.entries[1].relatedIds,[parent.id]);
});

test('cancellation aborts in-flight reads, leaves work pending, and permits a later resume',async t=>{
 const f=await fixture(t);let entered,blocked=true;const started=new Promise(resolve=>entered=resolve);const engine=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1}),importCandidate:async(candidate,{signal})=>{entered();if(blocked)await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return{item:await f.discovery.importUrl(candidate.url,{signal})};}}),plan=engine.createPlan({lanes:[lane()]});
 const pending=engine.run(plan.id);await started;engine.cancel(plan.id);let result=await pending;assert.equal(result.status,'cancelled');assert.equal(result.stats.attempted,0);assert.equal(result.lanes[0].sources[0].pendingCount,1);
 blocked=false;result=await engine.run(plan.id);assert.equal(result.stats.added,1);assert.equal(result.status,'completed');
});

test('a second worker cannot concurrently run while the durable lease is held',async t=>{
 const f=await fixture(t);let entered,release;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);const adapters={'github-repositories':async()=>{entered();await held;return{candidates:[],nextCursor:null,exhausted:true,evidence:[f.ref]};}};
 const a=createBulkDiscovery({...f,adapters}),b=createBulkDiscovery({...f,adapters}),plan=a.createPlan({lanes:[lane()]});const run=a.run(plan.id);await started;await assert.rejects(b.run(plan.id),error=>error.status===409);release();await run;assert.equal(b.running,false);
});

test('an interrupted running marker without a live lease resumes committed pending work',async t=>{
 const f=await fixture(t),a=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1})}),plan=a.createPlan({lanes:[lane()]});await a.run(plan.id,{maxSteps:1});const stored=f.store.getSetting('bulkDiscoveryPlan:'+plan.id);stored.status='running';f.store.setSetting('bulkDiscoveryPlan:'+plan.id,stored);
 const b=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1})}),result=await b.run(plan.id);assert.equal(result.stats.added,1);assert.equal(result.stats.pages,1);
});

test('unproven adapter output is rejected without imports',async t=>{
 const f=await fixture(t),adapters={'github-repositories':async()=>({candidates:[{...f.candidate('tool',0),provenance:null}],nextCursor:null,exhausted:true})},engine=createBulkDiscovery({...f,adapters}),plan=engine.createPlan({lanes:[lane()]});const result=await engine.run(plan.id);assert.equal(result.stats.added,0);assert.equal(f.calls.length,0);assert.equal(result.status,'partial');
});

test('actual default GitHub source adapter and existing discovery import retain real fixture responses without model hooks',async t=>{
 const f=await fixture(t),calls=[];const repository={html_url:'https://github.com/fixture/app',full_name:'fixture/app',name:'app',description:'A runnable application fixture.',private:false,fork:false,archived:false,disabled:false,default_branch:'main',stargazers_count:1200,topics:['self-hosted'],license:{spdx_id:'MIT'}};
 const fetcher=async url=>{calls.push(url);if(url.startsWith('https://api.github.com/search/repositories?')){assert.match(url,/sort=stars&order=desc/);return response(url,{items:[repository],total_count:1,incomplete_results:false});}assert.equal(url,'https://api.github.com/repos/fixture/app');return response(url,repository);};
 const discovery=createDiscovery({store:f.store,fetcher}),engine=createBulkDiscovery({store:f.store,discovery,fetcher}),plan=engine.createPlan({lanes:[lane('tool',{sources:[{adapter:'github-repositories',query:'topic:self-hosted stars:>=1000'}]})]});const result=await engine.run(plan.id);
 assert.equal(result.stats.added,1);assert.equal(calls.length,2);assert.equal(f.store.getCapability(result.entries[0].candidateId).github.stars,1200);assert.equal(f.store.evidence().length,3);
});

test('registry components interleave providers and reject changed index cursors after restart',async t=>{
 const f=await fixture(t);let changed=false;const fetcher=async url=>response(url,{items:[...Array.from({length:5},(_,i)=>({name:'a'+i,registry:{basePath:'/team/a'}})),{name:'b0',registry:{basePath:'/team/b'}},...changed?[{name:'new',registry:{basePath:'/team/b'}}]:[]]});let adapters=createBulkSourceAdapters({store:f.store,fetcher});const request={source:{adapter:'registry-components'},lane:'component',limit:2,scanId:'one'};
 const first=await adapters['registry-components'](request);assert.deepEqual(first.candidates.map(x=>x.name),['a0','b0']);changed=true;adapters=createBulkSourceAdapters({store:f.store,fetcher});await assert.rejects(adapters['registry-components']({...request,cursor:first.nextCursor}),/changed/);
});

test('guidance tree discovery binds public metadata to the explicit commit tree and actual document paths',async t=>{
 const f=await fixture(t),revision='a'.repeat(40),tree='b'.repeat(40),blob='c'.repeat(40),urls=[];const fetcher=async url=>{urls.push(url);if(url.endsWith('/repos/team/guide'))return response(url,{private:false,html_url:'https://github.com/team/guide',default_branch:'main'});if(url.endsWith('/commits/main'))return response(url,{sha:revision,commit:{tree:{sha:tree}}});assert.ok(url.endsWith('/git/trees/'+tree+'?recursive=1'));return response(url,{sha:tree,truncated:false,tree:[{type:'blob',mode:'100644',path:'skills/review/SKILL.md',sha:blob,size:100},{type:'blob',mode:'100644',path:'agents/plan.agent.md',sha:blob,size:80},{type:'blob',mode:'120000',path:'skills/link/SKILL.md',sha:blob,size:5},{type:'blob',mode:'100644',path:'README.md',sha:blob,size:90}]});};
 const adapters=createBulkSourceAdapters({store:f.store,fetcher}),request={source:{adapter:'github-guidance',repository:'team/guide'},limit:2,scanId:'one'};const skills=await adapters['github-guidance']({...request,lane:'skill'}),agents=await adapters['github-guidance']({...request,lane:'agent'});
 assert.equal(skills.candidates.length,1);assert.equal(agents.candidates.length,1);assert.equal(urls.length,3);assert.equal(skills.candidates[0].guidance.revision,revision);assert.equal(skills.candidates[0].guidance.gitBlobSha,blob);assert.equal(skills.candidates[0].provenance.rightsVerified,false);assert.match(skills.candidates[0].url,/blob\/main\/skills\/review\/SKILL.md$/);
});

test('collection and reference adapters retain observed sources without converting a requested lane into a verified skill',async t=>{
 const f=await fixture(t),fetcher=async url=>response(url,url.endsWith('directory.json')?{registries:[{name:'UI collection',url:'https://ui.example.org/',registry_url:'https://ui.example.org/r/registry.json',github_url:'https://github.com/team/ui'}]}:'<html><title>Public reference</title></html>');const adapters=createBulkSourceAdapters({store:f.store,fetcher});
 const collection=await adapters['registry-collections']({source:{adapter:'registry-collections'},lane:'collection',limit:20,scanId:'one'});assert.equal(collection.candidates[0].sourceKind,'registry-collection');assert.equal(collection.candidates[0].collection.registryUrl,'https://ui.example.org/r/registry.json');
 const ref=await adapters['public-reference']({source:{adapter:'public-reference',url:'https://reference.example.org/'},lane:'reference'});assert.equal(ref.candidates[0].sourceKind,'public-reference');assert.equal(ref.candidates[0].resourceType,undefined);assert.ok(f.store.getEvidence(ref.evidence[0].id).body.includes('<html>'));
});

test('initial persistence failure releases the active worker and durable lease',async t=>{
 const f=await fixture(t),engine=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1})}),plan=engine.createPlan({lanes:[lane()]});const original=f.store.setSetting;let fail=true;f.store.setSetting=(key,value)=>{if(fail&&key==='bulkDiscoveryPlan:'+plan.id){fail=false;throw Error('Synthetic disk failure');}return original(key,value);};
 await assert.rejects(engine.run(plan.id),/disk failure/);assert.equal(engine.running,false);assert.equal(f.store.getSetting('bulkDiscoveryLease',null),null);assert.equal(engine.get(plan.id).status,'paused');assert.equal(engine.get(plan.id).reason,'run-error');assert.equal((await engine.run(plan.id)).stats.added,1);
});

test('the existing real discovery wrapper forwards abort to importUrl fetches',async t=>{
 const f=await fixture(t);let sawSignal=false;const discovery=createDiscovery({store:f.store,fetcher:async(url,{signal})=>{sawSignal=!!signal;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Abort was not delivered')),200);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});}});
 const engine=createBulkDiscovery({store:f.store,discovery,adapters:paged(f,{pages:1,perPage:1}),stepTimeoutMs:20}),plan=engine.createPlan({lanes:[lane()]});const result=await engine.run(plan.id);assert.equal(sawSignal,true);assert.equal(result.stats.failed,1);assert.equal(f.store.counts().total,0);assert.equal(engine.running,false);
});

test('authenticated public fetching refuses private repository trees before secondary fetches',async()=>{
 const calls=[],fetcher=createPublicSourceFetcher({execute:async(command,args)=>{calls.push(args);if(args[0]==='--version')return{stdout:'gh fixture'};return{stdout:JSON.stringify({private:true,full_name:'team/private'})};},direct:async()=>{throw Error('Unexpected fallback');}});
 await assert.rejects(fetcher('https://api.github.com/repos/team/private/git/trees/'+'a'.repeat(40)+'?recursive=1'),/public repository/);assert.equal(calls.filter(args=>args[0]==='api').length,1);assert.equal(calls.at(-1).at(-1),'/repos/team/private');
});

test('authenticated public search forces public scope and rejects any private response or unsupported endpoint',async()=>{
 const calls=[],fetcher=createPublicSourceFetcher({execute:async(command,args)=>{calls.push(args);return args[0]==='--version'?{stdout:'gh fixture'}:{stdout:JSON.stringify({items:[{private:true}]})};},direct:async()=>{throw Error('Unexpected fallback');}});
 await assert.rejects(fetcher('https://api.github.com/search/repositories?q=agent&sort=stars&order=desc&per_page=20&page=1'),/non-public/);assert.ok(decodeURIComponent(calls.at(-1).at(-1)).replaceAll('+',' ').includes('is:public'));
 const count=calls.length;for(const url of ['https://api.github.com/user/repos','https://api.github.com/repos/team/public/issues','https://api.github.com/search/repositories?q=is%3Aprivate','https://api.github.com/search/repositories?q=tool&per_page=101','https://api.github.com/search/repositories?q=tool&page=0','https://api.github.com/search/repositories?q=tool&sort=unbounded','https://api.github.com/search/repositories?q='+('a'.repeat(501))])await assert.rejects(fetcher(url));assert.equal(calls.length,count);
});

test('missing gh falls back to public direct reads without exposing a CLI credential',async()=>{
 const calls=[],fetcher=createPublicSourceFetcher({execute:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});},direct:async url=>{calls.push(url);return response(url,{private:false,full_name:'team/public'});}});
 const result=await fetcher('https://api.github.com/repos/team/public');assert.equal(JSON.parse(result.body).private,false);assert.deepEqual(calls,['https://api.github.com/repos/team/public']);
});

test('real guidance discovery and typed acquisition roundtrip retain provenance but keep raw instructions out of normal catalogue cards',async t=>{
 const f=await fixture(t),revision='a'.repeat(40),tree='b'.repeat(40),repo='team/guide';
 const contents={'skills/review/SKILL.md':'---\nname: review\ndescription: Review a proposed source change.\n---\n# Review\nRAW_GUIDANCE_BODY_NOT_FOR_CATALOGUE\n','LICENSE':'MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software. The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.'};
 const files=Object.entries(contents).map(([path,body])=>({path,type:'blob',mode:'100644',size:Buffer.byteLength(body),sha:createHash('sha1').update(Buffer.concat([Buffer.from('blob '+Buffer.byteLength(body)+'\0'),Buffer.from(body)])).digest('hex')}));
 const fetcher=async url=>{if(url==='https://api.github.com/repos/'+repo)return response(url,{html_url:'https://github.com/'+repo,full_name:repo,name:'guide',private:false,archived:false,disabled:false,fork:false,default_branch:'main',description:'Source guidance collection.',topics:['skills'],license:{spdx_id:'MIT'},stargazers_count:1234});if(url.endsWith('/commits/main'))return response(url,{sha:revision,commit:{tree:{sha:tree}}});if(url.includes('/git/trees/'))return response(url,{sha:tree,truncated:false,tree:files});const path=url.split('/'+revision+'/')[1];assert.ok(Object.hasOwn(contents,path));return response(url,contents[path]);};
 const discovery=createDiscovery({store:f.store,fetcher}),importCandidate=createBulkImporter({store:f.store,discovery,fetcher}),engine=createBulkDiscovery({store:f.store,discovery,fetcher,importCandidate}),plan=engine.createPlan({lanes:[lane('skill',{sources:[{adapter:'github-guidance',repository:repo}]})]});const result=await engine.run(plan.id);assert.equal(result.stats.added,1);assert.equal(result.stats.reviewRequired,0);const entry=result.entries[0],item=f.store.getCapability(entry.candidateId);assert.equal(item.details.resourceType,'skill');assert.equal(item.details.parent.id,entry.relatedIds[0]);assert.ok(item.artifactManifest);assert.equal(item.metadataEvidence.body,undefined);assert.equal(item.sourceDocumentEvidence.body,undefined);assert.ok(!JSON.stringify(f.store.search()).includes('RAW_GUIDANCE_BODY_NOT_FOR_CATALOGUE'));
 const inspected=await discovery.inspect(item.id,{fetchSource:true});assert.ok(inspected.guidanceSource.content.includes('RAW_GUIDANCE_BODY_NOT_FOR_CATALOGUE'));assert.equal(f.store.workspaces().length,0);
 const original=JSON.stringify(item),licence=contents.LICENSE,createReviewPlan=()=>engine.createPlan({refreshExisting:true,lanes:[lane('skill',{sources:[{adapter:'github-guidance',repository:repo}]})]});
 contents.LICENSE='Proprietary. All rights reserved.';let rejected=await engine.run(createReviewPlan().id);assert.equal(rejected.stats.reviewRequired,1);assert.equal(rejected.stats.added,0);assert.match(rejected.entries[0].reason,/licence/);assert.equal(JSON.stringify(f.store.getCapability(item.id)),original);
 contents.LICENSE=licence;contents['skills/review/SKILL.md']+='Unexpected bytes outside the pinned blob.';rejected=await engine.run(createReviewPlan().id);assert.equal(rejected.stats.reviewRequired,1);assert.equal(rejected.stats.added,0);assert.equal(JSON.stringify(f.store.getCapability(item.id)),original);
});

test('CLI defaults to read-only status and supports explicit bounded plan runs without model endpoints',async()=>{
 assert.equal(bulkScanOptions([]).action,'status');assert.equal(bulkScanOptions(['--plan=plan.json']).action,'create');assert.equal(bulkScanOptions(['--resume=abc','--batches=2']).wait,true);for(const args of [['--run','--status'],['--batches=21'],['--resume=../../bad'],['--resume='],['--plan='],['--max-steps=201']])assert.throws(()=>bulkScanOptions(args));
 const requests=[],output=[];let tick=0,polls=0;const fetchImpl=async(url,options={})=>{requests.push({url:String(url),method:options.method||'GET',body:options.body});const path=new URL(url).pathname;const value=path==='/api/session'?{token:'LOCAL_SESSION_TOKEN'}:path==='/api/bulk-scans'?{plan:{id:'scan'}}:path.endsWith('/run')?{plan:{id:'scan',status:'running'}}:{plan:{id:'scan',status:++polls===1?'running':'paused',reason:'upstream-rate-limit'}};return{ok:true,json:async()=>value};};
 const result=await runBulkScan({options:{action:'run',wait:true,batches:3},fetchImpl,output:{write:value=>output.push(value)},sleep:async()=>{tick+=1000;},now:()=>tick});assert.equal(result.plan.reason,'upstream-rate-limit');assert.equal(requests.filter(row=>row.url.endsWith('/run')).length,1);assert.ok(!output.join('').includes('LOCAL_SESSION_TOKEN'));assert.ok(requests.every(row=>!row.url.includes('/relevance')&&!row.url.includes('/intelligence')));
 await assert.rejects(runBulkScan({options:{url:'https://example.org/'},fetchImpl,output:{write(){}}}),/loopback/);
});

test('nonpublic legacy catalogue identities do not stop an otherwise valid public scan',async t=>{
 const f=await fixture(t),search=f.store.search;f.store.search=(...args)=>[...search(...args),{id:'legacy',url:'local-only:workspace'}];
 const engine=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1})}),plan=engine.createPlan({lanes:[lane()]});assert.equal((await engine.run(plan.id)).stats.added,1);
});

test('source caches have an entry ceiling and evicted plans re-read source bytes',async t=>{
 const f=await fixture(t);let reads=0;const adapters=createBulkSourceAdapters({store:f.store,fetcher:async url=>{reads++;return response(url,{items:[{name:'one',registry:{basePath:'/team/ui'}}]});}}),request={source:{adapter:'registry-components'},lane:'component',limit:1};
 await adapters['registry-components']({...request,scanId:'first'});await adapters['registry-components']({...request,scanId:'first'});assert.equal(reads,1);
 for(let i=0;i<16;i++)await adapters['registry-components']({...request,scanId:'later-'+i});assert.equal(reads,17);await adapters['registry-components']({...request,scanId:'first'});assert.equal(reads,18);
});

test('independent SQLite connections enforce the same durable active lease',async t=>{
 const f=await fixture(t),other=createStore(f.dir);let entered,release;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve),adapters={'github-repositories':async()=>{entered();await held;return{candidates:[],exhausted:true,nextCursor:null};}};
 try{const a=createBulkDiscovery({...f,adapters}),b=createBulkDiscovery({store:other,discovery:f.discovery,adapters}),plan=a.createPlan({lanes:[lane()]});const pending=a.run(plan.id);await started;await assert.rejects(b.run(plan.id),error=>error.status===409);release();await pending;}finally{release?.();other.close();}
});

test('import failures retain actionable messages without bearer or common API token values',async t=>{
 const f=await fixture(t),engine=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1}),importCandidate:async()=>{throw Error('Synthetic provider failure Bearer private-bearer ghp_privateToken sk-privateKey');}}),plan=engine.createPlan({lanes:[lane()]});const result=await engine.run(plan.id),serialized=JSON.stringify(result);
 assert.equal(result.stats.failed,1);assert.match(serialized,/Synthetic provider failure/);assert.ok(!/private-bearer|privateToken|privateKey/.test(serialized));
});

test('CLI surfaces service start rejection instead of reporting a running scan',async()=>{
 const output=[];const fetchImpl=async url=>new URL(url).pathname==='/api/session'?{ok:true,json:async()=>({token:'LOCAL_TOKEN'})}:{ok:false,status:409,json:async()=>({error:'Another bulk discovery worker owns the durable lease'})};
 await assert.rejects(runBulkScan({options:{action:'resume',id:'scan',wait:true},fetchImpl,output:{write:value=>output.push(value)}}),/durable lease/);assert.deepEqual(output,[]);
});

test('unexpected startup failures checkpoint paused run-error and retain pending work for recovery',async t=>{
 const f=await fixture(t),engine=createBulkDiscovery({...f,adapters:paged(f,{pages:1,perPage:1})}),plan=engine.createPlan({lanes:[lane()]});await engine.run(plan.id,{maxSteps:1});const search=f.store.search;f.store.search=()=>{throw Error('Synthetic catalogue read failure');};
 await assert.rejects(engine.run(plan.id),/catalogue read failure/);const failed=engine.get(plan.id);assert.equal(failed.status,'paused');assert.equal(failed.reason,'run-error');assert.equal(failed.lanes[0].sources[0].pendingCount,1);assert.equal(failed.errors.at(-1).action,'run');assert.equal(engine.running,false);assert.equal(f.store.getSetting('bulkDiscoveryLease',null),null);
 f.store.search=search;const resumed=await engine.run(plan.id);assert.equal(resumed.stats.added,1);assert.equal(resumed.stats.pages,1);
});
