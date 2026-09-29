import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createDiscovery } from '../src/discovery.mjs';

const itemURL='https://registry.directory/tailark/blocks/memory-usage';
const sourceURL='https://registry.directory/api/markdown/tailark/blocks/memory-usage';
const source='export default function MemoryUsage(){ return <div>Memory usage illustration</div>; }';
const json=(url,data)=>({url,status:200,contentType:'application/json',body:JSON.stringify(data)});
async function fixture(t,fetcher){
  const directory=await mkdtemp(join(tmpdir(),'glasses-source-status-')),store=createStore(directory);
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  return {store,discovery:createDiscovery({store,fetcher})};
}

test('indexed item remains present when the Markdown aggregator reports 404; exact failure and attempted URL are retained',async t=>{
  const calls=[];
  const fetcher=async url=>{
    calls.push(url);
    if(url==='https://registry.directory/directory.json')return json(url,{registries:[{name:'Tailark',url:'https://tailark.com/',description:'Public UI illustrations'}]});
    if(url==='https://registry.directory/items.json')return json(url,{items:[{name:'memory-usage',description:'Tailark memory-usage illustration',registry:{name:'Tailark',basePath:'/tailark/blocks'}}]});
    if(url.startsWith('https://api.github.com/search/repositories?'))return json(url,{items:[]});
    if(url===itemURL)return {url,status:200,contentType:'text/html',body:'<title>memory-usage — Tailark</title>'};
    if(url===sourceURL)throw new Error('HTTP 404 from registry.directory');
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  const {store,discovery}=await fixture(t,fetcher);
  const run=await discovery.scout({query:'memory'}),item=store.search().find(item=>item.url===itemURL);
  assert.ok(item);assert.equal(run.status,'partial');
  assert.deepEqual(run.errors,['memory-usage source: HTTP 404 from registry.directory']);
  assert.equal((await fetcher(itemURL)).status,200,'The public item page still exists despite the source API failure');
  assert.match(store.getEvidence(item.metadataEvidence.id).body,/memory-usage/);
  assert.equal(item.sourceState.status,'error');assert.equal(item.sourceError,'HTTP 404 from registry.directory');
  assert.equal(item.sourceState.attemptedUrl,sourceURL);
  assert.equal(item.sourceHistory.at(-1).attemptedUrl,sourceURL);
  const status=store.sources().find(entry=>entry.url===sourceURL);
  assert.equal(status.status,'error');assert.equal(status.error,'HTTP 404 from registry.directory');
  assert.ok(!store.sources().some(entry=>entry.url===itemURL&&entry.status==='removed'));
  assert.equal(calls.filter(url=>url===sourceURL).length,1);
});

test('aggregator 404 preserves previous source and historical failures without suppressing explicit refresh',async t=>{
  let missing=false,calls=0;
  const {store,discovery}=await fixture(t,async url=>{
    assert.equal(url,sourceURL);calls++;
    if(missing)throw new Error('HTTP 404 from registry.directory');
    return {url,status:200,contentType:'text/markdown',body:'# Memory usage\n\n```tsx\n'+source+'\n```'};
  });
  const original=await discovery.importUrl(itemURL);
  const priorFailure={status:'removed',checkedAt:'2026-09-27T00:00:00.000Z',error:'HTTP 404 from registry.directory',retainedPreviousSource:true};
  store.upsertCapability({...original,sourceHistory:[...original.sourceHistory,priorFailure]});
  missing=true;
  const current=await discovery.inspect(original.id,{refreshSource:true});
  assert.equal(current.sourceState.status,'error');assert.equal(current.sourceState.retainedPreviousSource,true);
  assert.equal(current.sourceFiles[0].content,original.sourceFiles[0].content);
  assert.equal(current.sourceDocumentEvidence.id,original.sourceDocumentEvidence.id);
  assert.deepEqual(current.sourceHistory.map(entry=>entry.status),['ok','removed','error']);
  assert.deepEqual(current.sourceHistory[1],priorFailure);
  await discovery.inspect(original.id,{refreshSource:true});assert.equal(calls,3,'No retry/backoff behavior was introduced');
});

test('original source 404/410 remain removed and 401 remains an error with the exact source URL',async t=>{
  const origin='https://public-components.dev/r/memory-usage.json';let status=200;
  const {store,discovery}=await fixture(t,async url=>{
    assert.equal(url,origin);
    if(status!==200)throw new Error(`HTTP ${status} from public-components.dev`);
    return json(url,{name:'Memory usage',files:[{path:'memory.tsx',content:source}]});
  });
  const original=await discovery.importUrl(origin);
  for(const code of [404,410,401]){
    status=code;const current=await discovery.inspect(original.id,{refreshSource:true});
    assert.equal(current.sourceState.status,code===401?'error':'removed');
    assert.equal(current.sourceState.attemptedUrl,origin);
    assert.equal(current.sourceError,`HTTP ${code} from public-components.dev`);
    assert.equal(current.sourceState.retainedPreviousSource,true);
    assert.equal(store.sources().find(entry=>entry.url===origin).status,code===401?'error':'removed');
  }
});
