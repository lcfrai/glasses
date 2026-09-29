import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,stableId} from '../src/store.mjs';
import {createDiscovery,backfillGitHubMetadata,githubSearchQuery} from '../src/discovery.mjs';

const json=(url,data)=>({url,status:200,contentType:'application/json',body:JSON.stringify(data)});
const repo=(name,stars=100)=>({name,full_name:`fixture/${name}`,html_url:`https://github.com/fixture/${name}`,description:'A memory tool',topics:['memory'],default_branch:'main',stargazers_count:stars,archived:false,fork:false,disabled:false});
async function fixture(t,search){
  const directory=await mkdtemp(join(tmpdir(),'glasses-discovery-priority-'));
  let store=createStore(directory);const requests=[];
  const fetcher=async url=>{requests.push(url);const u=new URL(url);
    if(u.hostname==='registry.directory')return json(url,u.pathname==='/directory.json'?{registries:[]}:{items:[]});
    return json(url,await search(u));
  };
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  return {get store(){return store;},requests,discovery:createDiscovery({store,fetcher}),restart(){store.close();store=createStore(directory);return createDiscovery({store,fetcher});}};
}

test('GitHub scout keeps saved qualifiers, asks for popular results and retains observed metrics without clearing rights',async t=>{
  const f=await fixture(t,u=>{assert.equal(u.searchParams.get('sort'),'stars');assert.equal(u.searchParams.get('order'),'desc');return {total_count:2,items:[repo('established',42000),{...repo('unknown'),stargazers_count:undefined,fork:undefined,disabled:undefined}]};});
  const plan={id:'saved-plan',version:3,query:'agent memory stars:>100 language:TypeScript'};
  const run=await f.discovery.scout({query:plan.query,planSnapshot:plan});
  assert.equal(run.githubQuery,plan.query);
  assert.equal(run.githubEffectiveQuery,plan.query+' archived:false fork:false');
  assert.deepEqual(run.githubSearch,{query:run.githubEffectiveQuery,sort:'stars',order:'desc',perPage:20,page:1,headRefresh:false,maximumSearchResults:1000,totalCount:2,incompleteResults:false});
  const known=f.store.search().find(x=>x.name==='fixture/established'),unknown=f.store.search().find(x=>x.name==='fixture/unknown');
  assert.equal(known.github.stars,42000);assert.equal(known.github.starsFetchedAt,known.metadataEvidence.lastFetchedAt);
  assert.equal(known.github.fork,false);assert.equal(known.github.disabled,false);
  assert.equal(unknown.github.stars,null);assert.equal(unknown.github.starsFetchedAt,null);assert.equal(unknown.github.fork,null);assert.equal(unknown.github.disabled,null);
  assert.equal(known.license,null);assert.equal(known.licenseStatus,'unknown');
  assert.equal(JSON.parse(f.store.getEvidence(known.metadataEvidence.id).body).items[0].stargazers_count,42000);
});

test('explicit archive/fork overrides survive both plan and direct scouts, while quoted words are not qualifiers',async t=>{
  const f=await fixture(t,()=>({total_count:0,items:[]}));
  for(const query of ['memory archived:true fork:only','memory -archived:true fork:true']){
    const run=await f.discovery.scout({query});assert.equal(run.githubQuery,query);assert.equal(run.githubEffectiveQuery,query);
  }
  assert.equal(githubSearchQuery('"archived:true" memory'),'"archived:true" memory archived:false fork:false');
  assert.equal(githubSearchQuery('topic:memory archived:false'),'topic:memory archived:false fork:false');
});

test('per-query pagination persists over restart, advances only on success and wraps at GitHub 1000-result boundary',async t=>{
  let reject=false;
  const f=await fixture(t,u=>{if(reject)throw new Error('Synthetic repository request failure');const page=Number(u.searchParams.get('page'));return {total_count:90000,items:Array.from({length:20},(_,i)=>repo(`page-${page}-${i}`))};});
  const first=await f.discovery.scout({query:'memory'});assert.equal(first.githubSearch.page,1);
  const discovery=f.restart();const second=await discovery.scout({query:'memory'});assert.equal(second.githubSearch.page,2);
  reject=true;const failed=await discovery.scout({query:'memory'});assert.equal(failed.githubSearch.page,3);assert.equal(failed.status,'failed');
  reject=false;const retry=await discovery.scout({query:'memory'});assert.equal(retry.githubSearch.page,3);
  const key=stableId(retry.githubEffectiveQuery),state=f.store.getSetting('githubSearchCursors');state[key].nextPage=50;f.store.setSetting('githubSearchCursors',state);
  assert.equal((await discovery.scout({query:'memory'})).githubSearch.page,50);
  assert.equal((await discovery.scout({query:'memory'})).githubSearch.page,1);
  assert.equal((await discovery.scout({query:'deployment'})).githubSearch.page,1,'Different effective queries retain independent cursors');
});

test('weekly head refresh preserves the deeper cursor and short result sets wrap without empty-page churn',async t=>{
  let total=200;
  const f=await fixture(t,u=>({total_count:total,items:Array.from({length:20},(_,i)=>repo(`entry-${i}`))}));
  const first=await f.discovery.scout({query:'memory'}),key=stableId(first.githubEffectiveQuery);
  f.store.setSetting('githubSearchCursors',{[key]:{nextPage:6,lastHeadAt:'2020-01-01T00:00:00.000Z',lastUsedAt:'2020-01-01T00:00:00.000Z'}});
  const refresh=await f.discovery.scout({query:'memory'});assert.equal(refresh.githubSearch.page,1);assert.equal(refresh.githubSearch.headRefresh,true);
  assert.equal((await f.discovery.scout({query:'memory'})).githubSearch.page,6);
  total=22;const shortened=await f.discovery.scout({query:'memory'});assert.equal(shortened.githubSearch.page,7);
  assert.equal((await f.discovery.scout({query:'memory'})).githubSearch.page,1);
});

test('incomplete GitHub results retain candidates and warning but do not skip the unfinished page',async t=>{
  let incomplete=false;
  const f=await fixture(t,u=>({total_count:100,incomplete_results:incomplete,items:[repo('page-'+u.searchParams.get('page'))]}));
  await f.discovery.scout({query:'memory'});incomplete=true;
  const partial=await f.discovery.scout({query:'memory'});
  assert.equal(partial.githubSearch.page,2);assert.equal(partial.githubSearch.incompleteResults,true);assert.equal(partial.status,'partial');
  assert.equal(partial.candidateIds.length,1);assert.match(partial.errors.join('\n'),/incomplete results.*cursor was not advanced/);
  const source=f.store.sources().find(x=>x.url.includes('api.github.com/search/repositories')&&new URL(x.url).searchParams.get('page')==='2');
  assert.equal(source.status,'error');assert.match(source.error,/incomplete results/);
  incomplete=false;
  const completed=await f.discovery.scout({query:'memory'});assert.equal(completed.githubSearch.page,2);assert.equal(completed.status,'completed');
  assert.equal((await f.discovery.scout({query:'memory'})).githubSearch.page,3);
});

test('retained metadata backfill is exact-identity, hash-checked, cached and leaves source/licence/evidence unchanged',async t=>{
  const f=await fixture(t,()=>{throw new Error('Backfill must not fetch');});
  const fetchedAt='2026-09-01T02:03:04.000Z',response={items:[repo('one',12345),{...repo('two',0),fork:true,disabled:true},repo('bad',-4),repo('tampered',900)]};
  const evidence=f.store.retainEvidence({...json('https://api.github.com/search/repositories?q=memory',response),fetchedAt});
  const add=(name,extra={})=>f.store.upsertCapability({name,url:`https://github.com/fixture/${name}`,kind:'solution',origin:'live',provider:'GitHub',tags:[],license:null,metadataEvidence:evidence,github:{defaultBranch:'main',archived:false},sourceFiles:[{path:'src.ts',content:'exact source'}],provenance:{sourceUrl:'https://github.com/fixture/'+name,sourceHash:'original'},...extra}).item;
  const a=add('one'),b=add('two'),bad=add('bad'),wrong=add('not-in-response'),tampered=add('tampered',{metadataEvidence:{...evidence,sha256:'0'.repeat(64)}});
  const before=f.store.getEvidence(evidence.id);let reads=0;const read=f.store.getEvidence;f.store.getEvidence=id=>{reads++;return read(id);};
  const result=backfillGitHubMetadata(f.store);assert.equal(reads,1);assert.equal(result.updated,3);
  const fresh=f.store.getCapability(a.id);assert.equal(fresh.github.stars,12345);assert.equal(fresh.github.starsFetchedAt,fetchedAt);
  assert.equal(f.store.getCapability(b.id).github.stars,0);assert.equal(f.store.getCapability(b.id).github.fork,true);assert.equal(f.store.getCapability(b.id).github.disabled,true);
  assert.equal(f.store.getCapability(bad.id).github.stars,null);
  assert.equal(f.store.getCapability(wrong.id).github.stars,undefined);assert.equal(f.store.getCapability(tampered.id).github.stars,undefined);
  assert.deepEqual(fresh.sourceFiles,a.sourceFiles);assert.deepEqual(fresh.licenseEvidence,a.licenseEvidence);assert.deepEqual(fresh.provenance,a.provenance);assert.deepEqual(read(evidence.id),before);assert.equal(f.requests.length,0);
  assert.equal(backfillGitHubMetadata(f.store).updated,0,'Idempotent metadata-only migration');
});

test('startup and read-only source inspection hydrate old GitHub fields without fetching repository source',async t=>{
  const f=await fixture(t,()=>{throw new Error('Unexpected network');});
  const add=name=>{const evidence=f.store.retainEvidence(json(`https://api.github.com/repos/fixture/${name}`,repo(name,999)));return f.store.upsertCapability({name,url:`https://github.com/fixture/${name}`,kind:'solution',origin:'live',provider:'GitHub',metadataEvidence:evidence,github:{defaultBranch:'main'}}).item;};
  const initial=add('startup'),discovery=f.restart();assert.equal(f.store.getCapability(initial.id).github.stars,999);
  const later=add('inspect'),item=await discovery.inspect(later.id);assert.equal(item.github.stars,999);assert.equal(item.sourceFiles,undefined);assert.equal(f.requests.length,0);
});
