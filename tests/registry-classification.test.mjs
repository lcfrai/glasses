import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStore} from '../src/store.mjs';
import {createIntelligence} from '../src/intelligence.mjs';
import {createIntelligenceStore} from '../src/intelligence-store.mjs';
import {createProviders,JEV_MODEL} from '../src/providers.mjs';
import {createPublicCatalogue} from '../src/public-catalogue.mjs';
import {CLASSIFICATION_SCHEMA,CLASSIFICATION_POLICY,classificationFingerprint,registryComponentIdentity,registryIndexItemURL} from '../src/classification-policy.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const oldFingerprint=({base,evidenceIds,revision=null,sourceHash=null})=>sha({schema:CLASSIFICATION_SCHEMA,policy:CLASSIFICATION_POLICY,...base,evidenceIds,revision,sourceHash});
const baseFor=item=>({id:item.id,name:item.name,url:item.url,description:item.description,provider:item.provider,sourceKind:item.kind,tags:item.tags});
const foreign={name:'action-button',description:'FOREIGN_PROVIDER_ONLY opens an unrelated remote admin console.',type:'registry:ui',registry:{name:'Provider A',basePath:'/team-a/widgets'}};
const target={name:'action-button',description:'TARGET_PROVIDER_ONLY shows a selectable action control.',type:'registry:ui',registry:{name:'Provider B',basePath:'/team-b/widgets'}};
async function fixture(t,{items=[foreign,target],body}={}){
  const directory=await mkdtemp(join(tmpdir(),'glasses-registry-identity-')),store=createStore(directory),payloads=[];
  const evidence=store.retainEvidence({url:'https://registry.directory/items.json',status:200,contentType:'application/json',body:body??JSON.stringify({items})});
  const item=store.upsertCapability({url:registryIndexItemURL(target),name:target.name,description:target.description,kind:'component',provider:target.registry.name,tags:['registry:ui'],framework:null,origin:'live',metadataEvidence:evidence}).item;
  const runner=async()=>{throw Error('No Codex call expected');};runner.status=async()=>({configured:false});
  const providers=createProviders({credentialStore:{load:async()=>'fixture-only',status:async()=>({configured:true})},codexRunner:runner,fetchImpl:async(url,init)=>{const payload=JSON.parse(init.body);payloads.push(payload);return new Response(JSON.stringify({model:JEV_MODEL,usage:{input_tokens:100,output_tokens:20},answers:Object.fromEntries(Object.entries(payload.questions).map(([id,question])=>question.type==='noul'?[id,{type:'noul',noul:.1}]:[id,{type:'choice',choice:id.startsWith('a')?'component':'embed-package',confidence:.9,probabilities:Object.fromEntries(Object.keys(question.criteria).map(key=>[key,key===(id.startsWith('a')?'component':'embed-package')?1:0]))}]))}),{status:200});}});
  const engine=createIntelligence({store,discovery:{},providers,dataDir:directory});engine.updateSettings({provider:'jev',maxJobsPerDay:10,jevDailyBudgetUsd:.02});
  t.after(async()=>{await engine.close();store.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const classify=async()=>{const job=engine.enqueue({type:'classify',candidateIds:[item.id],provider:'jev'});for(let i=0;i<200;i++){const result=engine.getJob(job.id);if(!['queued','running'].includes(result.status)){assert.equal(result.status,'completed',JSON.stringify(result.errors));return result;}await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Synthetic provider job did not finish');};
  return{directory,store,item,evidence,engine,payloads,classify};
}

test('actual Jev request selects the exact registry namespace when two providers share a name',async t=>{
  const f=await fixture(t);await f.classify();assert.equal(f.payloads.length,1);const card=f.payloads[0].state.cards[0];assert.equal(card.url,f.item.url);assert.equal(card.evidence.length,1);assert.deepEqual(JSON.parse(card.evidence[0].excerpt),target);assert.doesNotMatch(JSON.stringify(f.payloads[0]),/FOREIGN_PROVIDER_ONLY/);assert.match(JSON.stringify(f.payloads[0]),/TARGET_PROVIDER_ONLY/);
});

test('missing, duplicate and malformed exact registry sources never fall back to another row or the full index',async t=>{
  for(const [name,options] of [['missing',{items:[foreign]}],['duplicate',{items:[foreign,target,{...target,description:'DUPLICATE_PROVIDER_VARIANT'}]}],['malformed',{body:'{"items":[FOREIGN_PROVIDER_ONLY invalid JSON'}]])await t.test(name,async child=>{const f=await fixture(child,options);await f.classify();const card=f.payloads[0].state.cards[0];assert.equal(card.evidence[0].excerpt,'');assert.doesNotMatch(JSON.stringify(f.payloads[0]),/FOREIGN_PROVIDER_ONLY|DUPLICATE_PROVIDER_VARIANT/);});
});

test('source-selection fingerprint changes canonical registry children only, preserving GitHub and collection cache keys',()=>{
  const common={evidenceIds:['proof'],revision:'a'.repeat(40),sourceHash:'b'.repeat(64)},base={id:'id',name:'Example',url:'https://github.com/team/tool',description:'Tool',provider:'GitHub',sourceKind:'solution',tags:['tool']};
  for(const url of ['https://github.com/team/tool','https://registry.directory/team/library','https://example.org/component','https://registry.directory/team/library/button?mode=private','https://registry.directory/team/library/button#state','http://registry.directory/team/library/button','https://registry.directory/team/library/%62utton']){const input={...common,base:{...base,url}};assert.equal(classificationFingerprint(input),oldFingerprint(input),url);assert.equal(registryComponentIdentity(url),null);}
  for(const name of ['action-button','a button','café','group/button']){const url=registryIndexItemURL({name,registry:{basePath:'/team/library'}}),input={...common,base:{...base,url,sourceKind:'component'}};assert.notEqual(classificationFingerprint(input),oldFingerprint(input));assert.equal(registryComponentIdentity(url).name,name);}
  assert.equal(registryIndexItemURL({name:'button',registry:{basePath:'/other/../bad'}}),null);
});

test('pre-fix registry assessments and caches become stale while the corrected assessment survives strict public projection',async t=>{
  const f=await fixture(t);await f.classify();const db=createIntelligenceStore(f.directory),current=db.get('assessments',f.item.id),base=baseFor(f.item),legacy=oldFingerprint({base,evidenceIds:[f.evidence.id]});
  const input={capabilities:[f.item],evidence:[f.store.getEvidence(f.evidence.id)],assessments:[current]};assert.ok(createPublicCatalogue(input).snapshot.items[0].assessment,'Current exact-selection assessment is publishable');
  const old={...current,sourceFingerprint:legacy};const omitted=createPublicCatalogue({...input,assessments:[old]});assert.equal(omitted.snapshot.items[0].assessment,null);assert.equal(omitted.report.assessmentOmitted,1);
  db.save('assessments',old);db.save('cache',{id:sha({operation:'classify',schema:CLASSIFICATION_SCHEMA,policy:CLASSIFICATION_POLICY,provider:'jev',model:JEV_MODEL,fingerprint:legacy}),classification:current.classification,model:JEV_MODEL,policyVersion:CLASSIFICATION_POLICY,createdAt:new Date().toISOString()});db.close();
  const sqlite=new DatabaseSync(join(f.directory,'intelligence.sqlite'));sqlite.prepare('DELETE FROM cache WHERE id=?').run(sha({operation:'classify',schema:CLASSIFICATION_SCHEMA,policy:CLASSIFICATION_POLICY,provider:'jev',model:JEV_MODEL,fingerprint:current.sourceFingerprint}));sqlite.close();
  assert.equal(f.engine.getAssessment(f.item.id).stale,true);const settings=f.engine.getSettings(),job=await f.classify();assert.equal(job.result.cacheHits,0);assert.equal(f.payloads.length,2);assert.equal(f.engine.getAssessment(f.item.id).stale,false);assert.deepEqual(f.engine.getSettings(),settings);
  await f.classify();assert.equal(f.payloads.length,2,'The corrected cache remains reusable');
});

test('strict public assessment projection rejects duplicate exact index identities even with a current fingerprint',async t=>{
  const f=await fixture(t,{items:[foreign,target,{...target}]});await f.classify();const db=createIntelligenceStore(f.directory);try{const result=createPublicCatalogue({capabilities:[f.item],evidence:[f.store.getEvidence(f.evidence.id)],assessments:[db.get('assessments',f.item.id)]});assert.equal(result.snapshot.items[0].assessment,null);assert.equal(result.report.assessmentOmitted,1);}finally{db.close();}
});
