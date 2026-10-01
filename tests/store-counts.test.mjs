import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createStore,KINDS,stableId} from '../src/store.mjs';
import {createPublicCatalogue,withPublicCatalogueItems} from '../src/public-catalogue.mjs';

async function setup(t,beforeOpen=()=>{}){
 const directory=await mkdtemp(join(tmpdir(),'glasses-counts-'));await beforeOpen(directory);
 const store=createStore(directory),stores=[store];
 t.after(async()=>{for(const handle of stores)handle.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('glasses-counts-'));await rm(directory,{recursive:true,force:true});});
 return {directory,store,stores};
}
function publicPack(kinds){
 const time='2026-10-01T00:00:00.000Z',items=kinds.map((kind,index)=>({id:100+index,private:false,name:'source-'+index,full_name:'count-fixture/source-'+index,html_url:'https://github.com/count-fixture/source-'+index,description:'A public source fixture.',topics:[],license:{spdx_id:'MIT'}}));
 const url='https://api.github.com/search/repositories',body=JSON.stringify({items}),sha256=createHash('sha256').update(body).digest('hex'),evidence={id:stableId(url+'\n'+sha256),url,body,sha256,status:200,contentType:'application/json',lastFetchedAt:time};
 const capabilities=items.map(row=>({id:stableId(row.html_url),url:row.html_url,origin:'live',kind:'solution',metadataEvidence:{id:evidence.id,sha256}}));
 const pack=createPublicCatalogue({capabilities,evidence:[evidence],generatedAt:time}).snapshot;
 return withPublicCatalogueItems(pack,pack.items.map(item=>({...item,kind:kinds[Number(item.url.split('-').at(-1))]})),{generatedAt:time});
}
function parity(store){
 const items=store.search(),expected=Object.fromEntries([['total',items.length],...KINDS.map(kind=>[kind,items.filter(item=>item.kind===kind).length])]);
 assert.deepEqual(store.counts(),expected);assert.deepEqual(Object.keys(store.counts()),['total',...KINDS]);return expected;
}
test('empty catalogue returns all kind keys and zero total',async t=>{const {store}=await setup(t);assert.deepEqual(store.counts(),{total:0,solution:0,component:0,pattern:0,reference:0});parity(store);});
test('shared-only publications count all four kinds with no local materialization',async t=>{const {store}=await setup(t),pack=publicPack(KINDS);await store.importPublicCatalogue(pack);assert.deepEqual(parity(store),{total:4,solution:1,component:1,pattern:1,reference:1});});
test('local overlaps override shared kinds exactly once while unique sources remain',async t=>{
 const {store}=await setup(t),pack=publicPack(['component','reference','solution']);await store.importPublicCatalogue(pack);
 store.upsertCapability({url:'https://github.com/count-fixture/source-0',kind:'pattern',name:'Local correction'});
 store.upsertCapability({url:'https://github.com/count-fixture/source-1',kind:'reference',name:'Same-kind local record'});
 store.upsertCapability({url:'https://github.com/count-fixture/local-only',kind:'solution',name:'Local only'});
 assert.deepEqual(parity(store),{total:4,solution:2,component:0,pattern:1,reference:1});
});
test('repeated counts observe independent inserts, kind changes, shared imports and local removal',async t=>{
 const {directory,store,stores}=await setup(t),other=createStore(directory);stores.push(other);
 const url='https://github.com/count-fixture/source-0';assert.equal(store.counts().total,0);
 other.upsertCapability({url,kind:'solution',name:'Independent insert'});assert.deepEqual(parity(store),{total:1,solution:1,component:0,pattern:0,reference:0});
 other.upsertCapability({url,kind:'component',name:'Independent change'});assert.deepEqual(parity(store),{total:1,solution:0,component:1,pattern:0,reference:0});
 await other.importPublicCatalogue(publicPack(['pattern','reference']));assert.deepEqual(parity(store),{total:2,solution:0,component:1,pattern:0,reference:1});
 const db=new DatabaseSync(join(directory,'glasses.sqlite'));try{db.prepare('DELETE FROM capabilities WHERE id=?').run(stableId(url));}finally{db.close();}
 assert.deepEqual(parity(store),{total:2,solution:0,component:0,pattern:1,reference:1});
});
test('existing JSON records gain covering count indexes without changing their data',async t=>{
 const url='https://github.com/count-fixture/existing',item={id:stableId(url),url,name:'Existing source',kind:'solution',provider:'GitHub',description:'Legacy record',tags:[],sourceFiles:[{path:'source.js',content:'x'.repeat(64000)}]},original=JSON.stringify(item);
 const {directory,store}=await setup(t,directory=>{
  const db=new DatabaseSync(join(directory,'glasses.sqlite'));
  try{db.exec('CREATE TABLE capabilities(id TEXT PRIMARY KEY,url TEXT UNIQUE NOT NULL,data TEXT NOT NULL); CREATE TABLE shared_capabilities(id TEXT PRIMARY KEY,data TEXT NOT NULL);');db.prepare('INSERT INTO capabilities(id,url,data) VALUES(?,?,?)').run(item.id,url,original);}finally{db.close();}
 });
 assert.deepEqual(parity(store),{total:1,solution:1,component:0,pattern:0,reference:0});
 const db=new DatabaseSync(join(directory,'glasses.sqlite'),{readOnly:true});
 try{
  assert.equal(db.prepare('SELECT data FROM capabilities WHERE id=?').get(item.id).data,original);
  const source=await readFile(new URL('../src/store.mjs',import.meta.url),'utf8'),sql=source.match(/const countsSQL = `([\s\S]*?)`;/)?.[1];assert.ok(sql);
  const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(row=>row.detail);
  assert.ok(plan.some(row=>/USING COVERING INDEX capabilities_kind_counts/.test(row)),plan.join('\n'));
  assert.ok(plan.some(row=>/USING COVERING INDEX shared_capabilities_kind_counts/.test(row)),plan.join('\n'));
  assert.ok(plan.some(row=>/SEARCH local USING COVERING INDEX .* \(id=\?\)/.test(row)),plan.join('\n'));
 }finally{db.close();}
});
