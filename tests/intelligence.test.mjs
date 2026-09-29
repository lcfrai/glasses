import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createIntelligence, INTELLIGENCE_SCHEMA } from '../src/intelligence.mjs';
import { createIntelligenceStore } from '../src/intelligence-store.mjs';

const directories=[];
after(async()=>{for(const directory of directories)await rm(directory,{recursive:true,force:true});});
async function temporary(){const directory=await mkdtemp(join(tmpdir(),'glasses-intelligence-'));directories.push(directory);return directory;}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function candidate(store,name='Public Memory',kind='solution') {
  const url=`https://public-products.dev/${name.replaceAll(' ','-')}`,metadataEvidence=store.retainEvidence({url:url+'/README',body:`${name} stores conventions for existing agents; CLI, local profiles and export.`});
  return store.upsertCapability({name,url,kind,description:'A publicly documented project capability.',provider:'Public fixture',origin:'live',license:null,metadataEvidence}).item;
}
function fakeProviders(overrides={}) {
  const calls=[],control={model:'codex-fixture-v1'};
  const result=(card)=>({id:card.id,artifact:'agent-extension',adoption:'configure-agent',capabilities:['durable recall','project continuity'],confidence:0.91,evidenceIds:card.evidenceIds});
  return {calls,control,
    status:async()=>({codex:{configured:true,model:control.model},jev:{configured:true,model:'jev-1.13.0'}}),
    classify:async(provider,input)=>{calls.push({operation:'classify',provider,input});return {results:input.cards.map(result),model:provider==='jev'?'jev-1.13.0':control.model,usage:{inputTokens:100,outputTokens:20}};},
    plan:async(input)=>{calls.push({operation:'plan',input});return {queries:['agent memory'],urls:[],model:control.model,usage:{inputTokens:100,outputTokens:20}};},
    rank:async(provider,input)=>{calls.push({operation:'rank',provider,input});return {results:input.cards.map((card,index)=>({id:card.id,score:1-index/Math.max(input.cards.length,1)})),model:provider==='jev'?'jev-1.13.0':control.model,usage:{inputTokens:100,outputTokens:20}};},...overrides};
}
async function setup(t,{providers=fakeProviders(),discovery={}}={}) {
  const directory=await temporary(),store=createStore(directory),engine=createIntelligence({store,discovery,providers,dataDir:directory});
  engine.updateSettings({maxJobsPerDay:100});
  t.after(async()=>{await engine.close();store.close();});return {directory,store,engine,providers};
}
async function done(engine,job){for(let count=0;count<400;count++){const current=engine.getJob(job.id);if(!['queued','running'].includes(current.status))return current;await delay(10);}throw new Error('Job did not settle');}

test('classification sends only bounded public evidence, preserves rights and retrieves inferred capabilities',async t=>{
  const {store,engine,providers}=await setup(t),item=candidate(store);
  store.recordOutcome({capabilityId:item.id,result:'worked',notes:'PRIVATE_PROJECT_CONVENTION',context:{project:'PRIVATE_PROJECT_NAME'}});
  store.createWorkspace({source:'export default function Private(){return <div>PRIVATE_WORKSPACE_SOURCE</div>}'});
  const completed=await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));
  assert.equal(completed.status,'completed');assert.deepEqual(completed.result.assessmentIds,[item.id]);
  const payload=JSON.stringify(providers.calls[0].input.cards);assert.doesNotMatch(payload,/PRIVATE_|outcome|workspace/i);
  assert.match(payload,/stores conventions/);assert.ok(providers.calls[0].input.cards[0].evidenceIds.length);
  assert.equal(store.getCapability(item.id).license,null);assert.equal(store.getCapability(item.id).licenseStatus,'unknown');
  const assessment=engine.getAssessment(item.id);assert.equal(assessment.artifact,'agent-extension');assert.equal(assessment.status,'classified');
  assert.equal(engine.decorate(store.search(),{query:'durable recall',artifact:'agent-extension'})[0].id,item.id);
  assert.throws(()=>engine.submitAssessment(item.id,{...assessment.classification,license:'MIT'}),/Unknown assessment field/);
  assert.throws(()=>engine.submitAssessment(item.id,{...assessment.classification,evidenceIds:['invented']}),/retained public evidence/);
});

test('cache binds evidence/model versions and human corrections survive refresh and restart',async()=>{
  const directory=await temporary();let store=createStore(directory);const providers=fakeProviders();let engine=createIntelligence({store,discovery:{},providers,dataDir:directory});engine.updateSettings({maxJobsPerDay:100});
  try {
    let item=candidate(store);
    await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));
    const second=await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));assert.equal(second.result.cacheHits,1);assert.equal(providers.calls.length,1);
    engine.correctAssessment(item.id,{artifact:'whole-product',capabilities:['offline lifecycle'],notes:'Reviewed by the user'});
    providers.control.model='codex-fixture-v2';await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));assert.equal(providers.calls.length,2);assert.equal(engine.getAssessment(item.id).artifact,'whole-product');
    const newer=store.retainEvidence({url:item.url+'/README',body:'New product version with changed import/export support.'});item=store.upsertCapability({...item,metadataEvidence:newer}).item;
    assert.equal(engine.getAssessment(item.id).stale,true);
    await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));assert.equal(providers.calls.length,3);assert.equal(engine.getAssessment(item.id).stale,false);
    assert.equal(engine.getAssessment(item.id).humanCorrected,true);assert.equal(engine.getAssessment(item.id).artifact,'whole-product');
    await engine.close();store.close();store=createStore(directory);engine=createIntelligence({store,discovery:{},providers,dataDir:directory});
    assert.equal(engine.getAssessment(item.id).correction.notes,'Reviewed by the user');assert.equal(engine.getSettings().maxJobsPerDay,100);
    assert.equal(engine.decorate(store.search(),{query:'offline lifecycle'})[0].id,item.id);
  }finally{await engine.close();store.close();}
});

test('catalogue decoration checks hashes without reading evidence bodies and batch evidence is loaded once',async t=>{
  const {store,engine}=await setup(t);
  const evidence=store.retainEvidence({url:'https://public-products.dev/index.json',body:JSON.stringify({items:Array.from({length:50},(_,i)=>({name:'Card'+i,description:'x'.repeat(5000)}))})});
  const ids=[];for(let i=0;i<50;i++)ids.push(store.upsertCapability({name:'Card'+i,url:`https://public-products.dev/card${i}`,kind:'component',origin:'live',metadataEvidence:evidence}).item.id);
  let reads=0;const original=store.getEvidence;store.getEvidence=id=>{reads++;return original(id);};
  const decorated=engine.decorate(store.search(),{query:'Card'});assert.equal(decorated.length,50);assert.equal(reads,0);
  await done(engine,engine.enqueue({type:'classify',candidateIds:ids.slice(0,10)}));assert.equal(reads,1,'One shared registry snapshot is read once per classification batch');
});

test('queue serializes work, cancellation prevents queued calls, and deadlines settle an unresponsive provider',async t=>{
  const entered=deferred(),release=deferred();let active=0,maxActive=0,calls=0;
  const providers=fakeProviders({classify:async(provider,{cards,signal})=>{calls++;active++;maxActive=Math.max(maxActive,active);entered.resolve();await release.promise;active--;if(signal.aborted)throw signal.reason;return {results:cards.map(card=>({id:card.id,artifact:'component',adoption:'adapt-source',capabilities:[],confidence:0.8,evidenceIds:card.evidenceIds})),model:'codex-fixture-v1',usage:{}};}});
  const {store,engine}=await setup(t,{providers});const one=candidate(store,'One'),two=candidate(store,'Two');
  const first=engine.enqueue({type:'classify',candidateIds:[one.id]});await entered.promise;
  const queued=engine.enqueue({type:'classify',candidateIds:[two.id]});engine.cancel(queued.id);engine.cancel(first.id);release.resolve();
  assert.equal((await done(engine,first)).status,'cancelled');assert.equal(engine.getJob(queued.id).status,'cancelled');await delay(30);assert.equal(calls,1);assert.equal(maxActive,1);
  providers.classify=()=>new Promise(()=>{});engine.updateSettings({timeoutSeconds:1});
  const timeout=await done(engine,engine.enqueue({type:'classify',candidateIds:[two.id]}));assert.equal(timeout.status,'failed');assert.match(timeout.errors.join(' '),/deadline/);
});

test('daily quota and Jev reservation fail closed, while explicit retry can recover a provider failure',async t=>{
  let paidCalls=0;const providers=fakeProviders({classify:async()=>{paidCalls++;throw new Error('Synthetic provider outage');}});
  const {store,engine}=await setup(t,{providers}),item=candidate(store);
  engine.updateSettings({provider:'jev',jevDailyBudgetUsd:0});
  assert.match((await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}))).errors.join(' '),/budget/);assert.equal(paidCalls,0);
  engine.updateSettings({jevDailyBudgetUsd:0.003});
  assert.equal((await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}))).status,'failed');assert.equal(paidCalls,1);
  assert.match((await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}))).errors.join(' '),/budget/);assert.equal(paidCalls,1,'Failed or unknown billing retains the reservation');
  const usage=(await engine.status()).usageToday;assert.equal(usage.jevReservedUsd,0.002688);
  providers.classify=fakeProviders().classify;engine.updateSettings({provider:'codex'});
  assert.equal((await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}))).status,'completed');
  engine.updateSettings({maxJobsPerDay:4});assert.throws(()=>engine.enqueue({type:'classify',candidateIds:[item.id]}),/Daily.*limit/);
});

test('ranking is cached independently and invalidated by evidence and correction changes without leaking correction notes',async t=>{
  const {store,engine,providers}=await setup(t);let item=candidate(store);
  const request=()=>engine.enqueue({type:'rank',query:'public agent memory',candidateIds:[item.id]});
  const first=await done(engine,request());assert.equal(first.status,'completed');assert.deepEqual(first.result.rankings,[{id:item.id,score:1}]);
  assert.equal((await done(engine,request())).result.cacheHits,1);
  engine.correctAssessment(item.id,{artifact:'memory-engine',notes:'PRIVATE_CORRECTION_NOTE',capabilities:['PRIVATE_CAPABILITY_NOTE']});
  await done(engine,request());assert.equal(providers.calls.filter(x=>x.operation==='rank').length,2);assert.doesNotMatch(JSON.stringify(providers.calls.at(-1).input),/PRIVATE_/);
  const evidence=store.retainEvidence({url:item.url+'/new-source',body:'Different public facts'});item=store.upsertCapability({...item,metadataEvidence:evidence}).item;
  await done(engine,request());assert.equal(providers.calls.filter(x=>x.operation==='rank').length,3);
});

test('research retains saved-plan snapshots, bounded discoveries, whole-product selection and partial failures',async t=>{
  let storeRef;const discovery={scout:async({query,planSnapshot,signal})=>{assert.ok(signal);const ids=[];for(let i=0;i<20;i++)ids.push(candidate(storeRef,'Interface '+i,'component').id);for(let i=0;i<4;i++)ids.push(candidate(storeRef,'Memory product '+i,'solution').id);return {id:'actual-scout-run',query,planSnapshot,candidateIds:ids,errors:['Synthetic upstream 404']};},importUrl:async()=>{throw new Error('not used');}};
  const {store,engine,providers}=await setup(t,{discovery});storeRef=store;const plan=store.createResearchPlan({name:'Memory research',query:'agent memory'});
  const job=engine.enqueue({type:'research',planId:plan.id});store.updateResearchPlan(plan.id,{query:'Changed later',enabled:false});
  const result=await done(engine,job);assert.equal(result.status,'partial');assert.equal(result.planSnapshot.query,'agent memory');assert.deepEqual(result.runIds,['actual-scout-run']);
  assert.equal(result.candidateIds.length,24);assert.equal(result.result.assessmentIds.length,10);
  assert.ok(providers.calls.find(x=>x.operation==='classify').input.cards.some(card=>card.sourceKind==='solution'),'The first bounded batch includes whole products even when registry components were discovered first');
  engine.updateSettings({autoResearch:true,autoClassify:true});assert.equal(engine.afterDiscovery({trigger:'intelligence',candidateIds:result.candidateIds}),null);
  assert.throws(()=>engine.enqueue({type:'research',planId:plan.id,trigger:'scheduled'}),/paused/);
  const noAutoResearch=engine.afterDiscovery({trigger:'scheduled',planId:plan.id,candidateIds:[]});assert.equal(noAutoResearch,null);
});

test('startup recovers interrupted jobs and low-confidence output remains reviewable without changing catalogue facts',async t=>{
  const directory=await temporary(),store=createStore(directory),item=candidate(store);
  const raw=createIntelligenceStore(directory);raw.save('jobs',{id:'orphan',status:'running',createdAt:new Date().toISOString(),errors:[]});raw.close();
  const providers=fakeProviders({classify:async(provider,{cards})=>({results:cards.map(card=>({id:card.id,artifact:'unknown',adoption:'unknown',capabilities:[],confidence:0.2,evidenceIds:card.evidenceIds})),model:'codex-fixture-v1',usage:{}})});
  const engine=createIntelligence({store,discovery:{},providers,dataDir:directory});t.after(async()=>{await engine.close();store.close();});
  assert.equal(engine.getJob('orphan').status,'interrupted');
  const result=await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));assert.equal(result.status,'completed');assert.equal(engine.getAssessment(item.id).status,'needs-review');
  assert.equal(store.getCapability(item.id).kind,'solution');assert.equal(engine.getAssessment(item.id).schemaVersion,INTELLIGENCE_SCHEMA);
  assert.throws(()=>engine.updateSettings({provider:'made-up'}),/provider/);assert.throws(()=>engine.updateSettings({timeoutSeconds:0}),/timeoutSeconds/);assert.throws(()=>engine.updateSettings({autoClassify:'yes'}),/boolean/);
});

test('research enriches at most three whole products and prioritizes exact README evidence over commit/licence metadata',async t=>{
  let storeRef,inspections=0;const discovery={
    scout:async()=>({id:'enrichment-run',candidateIds:storeRef.search().map(item=>item.id),errors:[]}),
    inspect:async(id,{fetchSource,signal})=>{
      assert.equal(fetchSource,true);assert.ok(signal);inspections++;
      const item=storeRef.getCapability(id),base=`https://api.github.com/repos/fixture/${id}`;
      const docs=['commits/main','license','readme'].map(resource=>storeRef.retainEvidence({url:base+'/'+resource,body:JSON.stringify({encoding:'base64',content:Buffer.from(resource==='readme'?'README_FUNCTIONALITY: durable scoped recall and export.':resource).toString('base64')})}));
      return storeRef.upsertCapability({...item,repositoryEvidence:docs,sourceState:{status:'ok'}}).item;
    },importUrl:async()=>{throw new Error('not used');}
  };
  const {store,engine,providers}=await setup(t,{discovery});storeRef=store;
  for(let i=0;i<6;i++){const evidence=store.retainEvidence({url:`https://api.github.com/repos/fixture/memory-${i}`,body:`Repository metadata for memory ${i}`});store.upsertCapability({name:'Memory '+i,url:`https://github.com/fixture/memory-${i}`,kind:'solution',origin:'live',metadataEvidence:evidence});}
  const job=await done(engine,engine.enqueue({type:'research',query:'memory'}));
  assert.equal(job.status,'completed');assert.equal(inspections,3);assert.equal(job.result.enrichedCandidateIds.length,3);
  const cards=providers.calls.find(call=>call.operation==='classify').input.cards;
  for(const id of job.result.enrichedCandidateIds){const card=cards.find(card=>card.id===id);assert.match(card.evidence[0].url,/readme$/);assert.match(card.evidence[0].excerpt,/README_FUNCTIONALITY/);}
});

test('automatic research hook retains its parent run, respects a later pause and rejects all-invalid model results',async t=>{
  const {store,engine,providers}=await setup(t),item=candidate(store),plan=store.createResearchPlan({name:'Automatic memory',query:'memory'});
  engine.updateSettings({autoResearch:true});
  const job=engine.afterDiscovery({id:'parent-source-run',trigger:'scheduled',planId:plan.id,candidateIds:[item.id]});
  assert.deepEqual(job.runIds,['parent-source-run']);store.updateResearchPlan(plan.id,{enabled:false});
  assert.equal((await done(engine,job)).status,'cancelled');assert.equal(providers.calls.length,0);
  providers.classify=async()=>({results:[{id:'invented',artifact:'whole-product'}],model:'codex-fixture-v1',usage:{}});
  const bad=await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));assert.equal(bad.status,'failed');assert.deepEqual(bad.result.assessmentIds,[]);
});

test('successive queued automatic batches advance fairly without repeating their initial cached prefix',async t=>{
  const {store,engine,providers}=await setup(t);
  const ids=[];
  for(let i=0;i<6;i++)ids.push(candidate(store,`A solution ${i}`,'solution').id);
  for(let i=0;i<3;i++)ids.push(candidate(store,`B component ${i}`,'component').id);
  for(let i=0;i<3;i++)ids.push(candidate(store,`C reference ${i}`,'reference').id);
  engine.updateSettings({maxCandidates:4});
  const queued=Array.from({length:3},()=>engine.enqueue({type:'classify'}));
  assert.deepEqual(queued[0].initialCandidateIds,queued[1].initialCandidateIds,'Queued selection is provisional until preceding work completes');
  const finished=[];for(const job of queued)finished.push(await done(engine,job));
  const selected=finished.flatMap(job=>job.result.classificationCandidateIds);
  assert.equal(selected.length,12);assert.equal(new Set(selected).size,12);assert.deepEqual(new Set(selected),new Set(ids));
  for(const job of finished){
    assert.equal(job.status,'completed');assert.equal(job.selectionMode,'automatic');
    assert.deepEqual(job.candidateIds,job.result.classificationCandidateIds);
    const kinds=job.candidateIds.map(id=>store.getCapability(id).kind);
    assert.equal(kinds.filter(kind=>kind==='solution').length,2);assert.ok(kinds.includes('component'));assert.ok(kinds.includes('reference'));
  }
  assert.equal(providers.calls.length,3);
  const noPending=await done(engine,engine.enqueue({type:'classify'}));
  assert.equal(noPending.result.noPendingWork,true);assert.equal(providers.calls.length,3);
});

test('automatic pending priority handles source changes, provider switches and model changes while explicit refresh keeps cache behavior',async t=>{
  const {store,engine,providers}=await setup(t);
  let first=candidate(store,'A cached solution');const second=candidate(store,'B cached solution'),last=candidate(store,'Z unclassified solution');
  engine.updateSettings({maxCandidates:1});
  for(const item of [first,second])await done(engine,engine.enqueue({type:'classify',candidateIds:[item.id]}));
  const explicit=await done(engine,engine.enqueue({type:'classify',candidateIds:[first.id],query:'Z unclassified'}));
  assert.deepEqual(explicit.candidateIds,[first.id]);assert.deepEqual(explicit.result.assessmentIds,[first.id]);assert.equal(explicit.result.cacheHits,1);assert.equal(providers.calls.length,2);
  assert.deepEqual((await done(engine,engine.enqueue({type:'classify'}))).result.assessmentIds,[last.id]);
  const evidence=store.retainEvidence({url:first.url+'/README',body:'Changed public version and deployment lifecycle.'});first=store.upsertCapability({...first,metadataEvidence:evidence}).item;
  assert.equal(engine.getAssessment(first.id).stale,true);
  assert.deepEqual((await done(engine,engine.enqueue({type:'classify'}))).result.assessmentIds,[first.id]);assert.equal(engine.getAssessment(first.id).stale,false);
  engine.updateSettings({provider:'jev'});
  const jev=[];for(let i=0;i<3;i++)jev.push(await done(engine,engine.enqueue({type:'classify'})));
  assert.equal(new Set(jev.flatMap(job=>job.result.assessmentIds)).size,3);
  for(const item of [first,second,last])assert.equal(engine.getAssessment(item.id).provider,'jev');
  const before=providers.calls.length;engine.updateSettings({provider:'codex'});
  for(let i=0;i<3;i++)assert.equal((await done(engine,engine.enqueue({type:'classify'}))).result.cacheHits,1);
  assert.equal(providers.calls.length,before,'Switching back applies exact current-source caches instead of repeating inference');
  providers.control.model='codex-fixture-v2';
  for(let i=0;i<3;i++)await done(engine,engine.enqueue({type:'classify'}));
  assert.equal(providers.calls.length,before+3);
  for(const item of [first,second,last])assert.equal(engine.getAssessment(item.id).model,'codex-fixture-v2');
});

test('scheduled classification skips cached or unavailable evidence and preserves discovery scope across queued work',async t=>{
  const {store,engine,providers}=await setup(t),cached=candidate(store,'A cached');
  await done(engine,engine.enqueue({type:'classify',candidateIds:[cached.id]}));
  const noEvidence=store.upsertCapability({name:'No evidence',url:'https://public-products.dev/no-evidence',kind:'solution',origin:'live'}).item;
  const missing=store.upsertCapability({name:'Missing evidence',url:'https://public-products.dev/missing-evidence',kind:'solution',origin:'live',metadataEvidence:{id:'absent-snapshot'}}).item;
  const privateEvidence=store.retainEvidence({url:'https://127.0.0.1/private',body:'Not public'});
  const nonPublic=store.upsertCapability({name:'Private evidence URL',url:'https://public-products.dev/private-evidence',kind:'solution',origin:'live',metadataEvidence:privateEvidence}).item;
  engine.updateSettings({autoClassify:true,maxCandidates:2});
  const priorJobs=engine.listJobs().total;
  const rejected=[cached.id,noEvidence.id,missing.id,nonPublic.id];
  assert.equal(engine.afterDiscovery({id:'no-work-run',trigger:'scheduled',candidateIds:rejected}),null);
  assert.equal(engine.listJobs().total,priorJobs);assert.equal(providers.calls.length,1);
  const scoped=Array.from({length:4},(_,i)=>candidate(store,`Discovered ${i}`)),outside=candidate(store,'A outside discovery scope');
  const scope=[...rejected,...scoped.map(item=>item.id)];
  const first=engine.afterDiscovery({id:'source-run',trigger:'scheduled',candidateIds:scope});
  const second=engine.afterDiscovery({id:'source-run-again',trigger:'scheduled',candidateIds:scope});
  const completed=[await done(engine,first),await done(engine,second)];
  assert.equal(new Set(completed.flatMap(job=>job.candidateIds)).size,4);
  for(const job of completed){assert.deepEqual(job.selectionScopeIds,scope);assert.ok(!job.candidateIds.includes(outside.id));assert.equal(job.selectionMode,'discovery');}
  assert.equal(engine.getAssessment(outside.id).status,'unclassified');
  assert.equal(engine.afterDiscovery({id:'now-cached-run',trigger:'scheduled',candidateIds:scope}),null);
  providers.control.model='codex-fixture-v2';await engine.status();
  assert.ok(engine.afterDiscovery({id:'changed-model-run',trigger:'scheduled',candidateIds:[cached.id]}),'Observed model changes make the old cache pending');
});

test('classification pending priority does not change ranking relevance or admit candidates outside explicit query scope',async t=>{
  const {store,engine,providers}=await setup(t);
  const unrelated=candidate(store,'A alphabetically first other solution'),relevant=candidate(store,'Z target-query solution'),reference=candidate(store,'Z target-query reference','reference');
  engine.updateSettings({maxCandidates:1});
  const classified=await done(engine,engine.enqueue({type:'classify',query:'target-query'}));
  assert.deepEqual(classified.result.assessmentIds,[relevant.id]);
  await done(engine,engine.enqueue({type:'rank',query:'target-query',candidateIds:[reference.id,relevant.id]}));
  const rankCall=providers.calls.find(call=>call.operation==='rank');
  assert.deepEqual(rankCall.input.cards.map(card=>card.id),[reference.id,relevant.id]);assert.ok(!rankCall.input.cards.some(card=>card.id===unrelated.id));
  const explicit=await done(engine,engine.enqueue({type:'classify',query:'target-query',candidateIds:[unrelated.id]}));
  assert.deepEqual(explicit.result.assessmentIds,[unrelated.id]);
});

test('popularity orders equal-relevance pending work without overriding fit, cache progress or whole-solution coverage',async t=>{
  const {store,engine}=await setup(t);
  const add=(name,stars,kind='solution',extra={})=>{const item=candidate(store,name,kind);return store.upsertCapability({...item,github:{stars,...extra}}).item;};
  const low=add('A precise service',10),high=add('Z service',50000),archived=add('Archived service',90000,'solution',{archived:true});
  const component=add('Widget',1000000,'component'),reference=add('Reference',null,'reference');
  engine.updateSettings({maxCandidates:4});
  const first=await done(engine,engine.enqueue({type:'classify'}));
  assert.deepEqual(first.result.classificationCandidateIds,[high.id,low.id,component.id,reference.id]);
  const second=await done(engine,engine.enqueue({type:'classify'}));
  assert.deepEqual(second.result.classificationCandidateIds,[archived.id],'Remaining explicit catalogue entries stay discoverable');
  assert.equal(engine.decorate(store.search(),{query:'precise service'})[0].id,low.id,'Stronger text relevance precedes popularity');
  const unstarred=add('Known zero',0),unknown=add('A unknown',null);
  const results=engine.decorate(store.search());
  assert.ok(results.findIndex(item=>item.id===unstarred.id)<results.findIndex(item=>item.id===unknown.id));
  const explicit=await done(engine,engine.enqueue({type:'classify',candidateIds:[low.id]}));
  assert.deepEqual(explicit.result.assessmentIds,[low.id]);assert.equal(explicit.result.cacheHits,1);
});

test('search matches actual outcome context, including older records, without matching explanatory boilerplate',async t=>{
  const {store,engine}=await setup(t),item=candidate(store,'Useful widget','component');
  assert.deepEqual(engine.decorate(store.search(),{query:'local'}),[]);
  assert.deepEqual(engine.decorate(store.search(),{query:'observations'}),[]);
  store.recordOutcome({capabilityId:item.id,result:'worked',notes:'specialneedle',context:{project:'Synthetic local editor',workspaceId:'fixture-workspace'}});
  for(let i=0;i<4;i++)store.recordOutcome({capabilityId:item.id,result:'worked',notes:'Later trial'});
  assert.deepEqual(engine.decorate(store.search(),{query:'specialneedle'}).map(item=>item.id),[item.id]);
  assert.deepEqual(engine.decorate(store.search(),{query:'local'}).map(item=>item.id),[item.id]);
  assert.deepEqual(engine.decorate(store.search(),{query:'workspaceId'}),[],'Object field names are not evidence of relevance');
  assert.deepEqual(engine.decorate(store.search(),{query:'failed'}),[],'Zero-count summary fields are not actual failures');
  store.recordOutcome({capabilityId:item.id,result:'failed'});
  assert.deepEqual(engine.decorate(store.search(),{query:'failed'}).map(item=>item.id),[item.id]);
});

test('classification splits large batches by card count and bytes, including a final incomplete batch',async t=>{
  const {store,engine,providers}=await setup(t);
  const ids=[];
  for(let i=0;i<23;i++){
    const item=candidate(store,`Large card ${String(i).padStart(2,'0')}`);
    const docs=Array.from({length:3},(_,j)=>store.retainEvidence({url:`${item.url}/evidence-${j}`,body:`Public evidence ${i}/${j}. `+'x'.repeat(2200)}));
    ids.push(store.upsertCapability({...item,description:'d'.repeat(1200),metadataEvidence:docs[0],sourceDocumentEvidence:docs[1],registryDocumentEvidence:docs[2]}).item.id);
  }
  engine.updateSettings({maxCandidates:30});
  const codex=await done(engine,engine.enqueue({type:'classify',candidateIds:ids}));
  assert.equal(codex.status,'completed');assert.equal(new Set(codex.result.assessmentIds).size,23);
  const calls=providers.calls.filter(call=>call.operation==='classify');
  assert.ok(calls.length>3,'Byte bounds split these cards before the ten-card count limit');
  assert.equal(new Set(calls.flatMap(call=>call.input.cards.map(card=>card.id))).size,23);
  for(const call of calls){assert.ok(call.input.cards.length<=10);assert.ok(Buffer.byteLength(JSON.stringify(call.input.cards))<=55000);}
  const before=providers.calls.length;
  const jev=await done(engine,engine.enqueue({type:'classify',provider:'jev',candidateIds:ids.slice(0,10)}));
  assert.equal(jev.status,'completed');assert.equal(jev.result.assessmentIds.length,10);
  const jevCalls=providers.calls.slice(before);assert.equal(jevCalls.at(-1).input.cards.length,1);
  for(const call of jevCalls){assert.ok(call.input.cards.length<=3);assert.ok(Buffer.byteLength(JSON.stringify(call.input.cards))<=25000);}
});

test('automatic rank shortlist fills with query matches before unrelated whole solutions',async t=>{
  const {store,engine,providers}=await setup(t);
  const irrelevant=candidate(store,'A unrelated solution');
  const relevant=Array.from({length:30},(_,i)=>candidate(store,`Targetneedle widget ${i}`,'component'));
  const completed=await done(engine,engine.enqueue({type:'rank',query:'targetneedle'}));
  assert.equal(completed.status,'completed');
  const ids=providers.calls.find(call=>call.operation==='rank').input.cards.map(card=>card.id);
  assert.equal(ids.length,30);assert.ok(!ids.includes(irrelevant.id));
  assert.deepEqual(new Set(ids),new Set(relevant.map(item=>item.id)));
});

test('a later batch failure preserves a partial result and the next automatic job advances past its completed cards',async t=>{
  const providers=fakeProviders(),normal=providers.classify;let attempt=0;
  providers.classify=async(...args)=>{attempt++;if(attempt===2)throw new Error('Synthetic second batch failure');return normal(...args);};
  const {store,engine}=await setup(t,{providers});
  const ids=Array.from({length:25},(_,i)=>candidate(store,`Batch ${String(i).padStart(2,'0')}`).id);
  engine.updateSettings({maxCandidates:30});
  const partial=await done(engine,engine.enqueue({type:'classify',candidateIds:ids}));
  assert.equal(partial.status,'partial');assert.equal(partial.result.assessmentIds.length,10);assert.match(partial.errors.join(' '),/second batch failure/);
  assert.equal(partial.usage.length,2);assert.equal(partial.usage[0].status,'completed');assert.equal(partial.usage[1].status,'failed');
  providers.classify=normal;
  const finished=await done(engine,engine.enqueue({type:'classify'}));
  assert.equal(finished.status,'completed');assert.equal(finished.result.assessmentIds.length,15);
  assert.ok(finished.result.assessmentIds.every(id=>!partial.result.assessmentIds.includes(id)));
  assert.equal(new Set([...partial.result.assessmentIds,...finished.result.assessmentIds]).size,25);
});
