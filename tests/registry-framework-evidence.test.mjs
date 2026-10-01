import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,stableId} from '../src/store.mjs';
import {createDiscovery} from '../src/discovery.mjs';
import {createPublicCatalogue,publicCatalogueEvidenceIds} from '../src/public-catalogue.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),time='2026-10-01T00:00:00.000Z';
function evidence(url,data){const body=JSON.stringify(data),sha256=sha(body);return{id:stableId(`${url}\n${sha256}`),url,body,sha256,status:200,contentType:'application/json',firstFetchedAt:time,lastFetchedAt:time};}
const itemUrl='https://registry.directory/fixture/ui/choice',registryUrl='https://components.example.org/r/registry.json',sourceUrl='https://components.example.org/r/choice.json';
const sourceFile={path:'registry/core/choice/component.tsx',type:'registry:ui',target:'components/ui/choice.tsx'};
function fixture(change={}){
 const index=evidence('https://registry.directory/items.json',{items:change.items||[{name:'choice',type:'registry:ui',description:'An indexed choice control.',registry:{basePath:'/fixture/ui',name:'Fixture'},categories:['choice']}]});
 const directory=evidence('https://registry.directory/directory.json',{registries:change.providers||[{github_url:'https://github.com/fixture/ui',registry_url:registryUrl,url:'https://components.example.org',description:'A React provider claim is not component proof.'}]});
 const entry={name:'choice',type:'registry:ui',files:[sourceFile],...change.entry};
 const registry=evidence(change.registryUrl||registryUrl,{items:change.entries||[entry]});
 const source=evidence(change.sourceUrl||sourceUrl,{name:'choice',type:'registry:ui',files:[{...sourceFile,content:'import {useState} from "react"; export function Choice(){return <button/>;}'}],...change.source});
 const cap={id:stableId(itemUrl),url:itemUrl,origin:'live',kind:'component',provider:'Fixture',name:'choice',metadataEvidence:index,sourceDocumentEvidence:source,framework:'Vue',sourceItemUrl:sourceUrl,registrySourceProof:{directory,registry},...change.cap};
 const docs=[index,directory,registry,source];
 return {index,directory,registry,source,cap,docs,project:()=>createPublicCatalogue({capabilities:[cap],evidence:docs}).snapshot.items[0]};
}
test('official JSON source joins through exact directory namespace, registry entry and file inventory',()=>{
 const f=fixture(),row=f.project();assert.equal(row.framework,'React');assert.deepEqual(row.tags,['choice','registry:ui']);assert.equal(row.description,'An indexed choice control.');assert.equal(row.license.spdx,null);assert.equal(row.license.scope,'registry-item');assert.equal(row.citations.length,4);assert.equal(row.citations[3].sha256,f.source.sha256);assert.equal(row.citations[3].endpoint,sourceUrl);assert.doesNotMatch(JSON.stringify(row),/useState|component\.tsx|provider claim/);
 const ids=publicCatalogueEvidenceIds([f.cap]);for(const doc of f.docs)assert.ok(ids.includes(doc.id));
});
test('official registry namespace, duplicate names, changed inventory and endpoint substitutions fail closed',()=>{
 const cases=[
  {providers:[{github_url:'https://github.com/other/ui',registry_url:registryUrl}]},
  {providers:[{github_url:'https://github.com/fixture/ui',registry_url:registryUrl},{github_url:'https://github.com/fixture/ui',registry_url:registryUrl}]},
  {entry:{files:[{...sourceFile,path:'other/component.tsx'}]}},
  {entry:{files:[sourceFile,sourceFile]}},
  {source:{name:'other'}},{source:{type:'registry:block'}},
  {sourceUrl:'https://other.example.org/r/choice.json'},
  {sourceUrl:sourceUrl+'?private=1'},
  {entry:{url:'http://127.0.0.1/choice.json'}},
  {source:{files:[{...sourceFile,path:'../choice.tsx',content:'import React from "react";'}]}},
 ];
 for(const change of cases){const row=fixture(change).project();assert.equal(row.framework,null,JSON.stringify(change));assert.equal(row.citations.length,1);}
 const duplicate=fixture();const entry=JSON.parse(duplicate.registry.body).items[0];assert.equal(fixture({entries:[entry,entry]}).project().framework,null);
 const f=fixture();f.source.body+=' ';assert.equal(f.project().framework,null);const g=fixture();g.cap.registrySourceProof.registry={...g.registry,sha256:'0'.repeat(64)};assert.equal(g.project().framework,null);
});
test('provider prose and generic TSX never establish framework; conflicting exact evidence remains mixed',()=>{
 assert.equal(fixture({source:{files:[{...sourceFile,content:'export function Choice(){return <LocalChoice/>;}'}]}}).project().framework,null);
 assert.equal(fixture({entry:{framework:'Vue'}}).project().framework,null);
});
test('ordinary source hydration retains the explicit proof refs for normal export without body leakage',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'glasses-official-framework-')),store=createStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const f=fixture(),ref=store.retainEvidence(f.index);let requests=[];
 const cap=store.upsertCapability({name:'choice',url:itemUrl,kind:'component',provider:'Fixture',origin:'live',metadataEvidence:ref,sourceItemUrl:sourceUrl,framework:null,tags:['choice']}).item;
 const discovery=createDiscovery({store,fetcher:async url=>{requests.push(url);const doc=f.docs.find(doc=>doc.url===url);assert.ok(doc,'Unexpected source '+url);return doc;}});
 const hydrated=await discovery.inspect(cap.id,{refreshSource:true});assert.equal(hydrated.framework,'React');assert.ok(hydrated.registrySourceProof.registry.id);assert.equal(hydrated.registrySourceProof.registry.body,undefined);
 const refs=publicCatalogueEvidenceIds([hydrated]),pack=createPublicCatalogue({capabilities:[hydrated],evidence:refs.map(id=>store.getEvidence(id))}).snapshot;assert.equal(pack.items[0].framework,'React');assert.equal(pack.items[0].citations.length,4);
 await discovery.inspect(cap.id,{refreshSource:true});assert.equal(requests.filter(url=>url===sourceUrl).length,2);assert.equal(requests.filter(url=>url===registryUrl).length,1);assert.equal(requests.filter(url=>url==='https://registry.directory/directory.json').length,1);
});
test('a failed official-index read preserves fetched source but cannot publish an unbound framework',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'glasses-official-framework-failure-')),store=createStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const f=fixture(),ref=store.retainEvidence(f.index),cap=store.upsertCapability({name:'choice',url:itemUrl,kind:'component',provider:'Fixture',origin:'live',metadataEvidence:ref,sourceItemUrl:sourceUrl,framework:null}).item;
 const discovery=createDiscovery({store,fetcher:async url=>{if(url===sourceUrl)return f.source;throw Error('Synthetic offline source');}}),row=await discovery.inspect(cap.id,{refreshSource:true});
 assert.equal(row.framework,'React');assert.equal(row.registrySourceProof,null);assert.equal(row.registrySourceProofState.status,'unverified');assert.equal(createPublicCatalogue({capabilities:[row],evidence:publicCatalogueEvidenceIds([row]).map(id=>store.getEvidence(id))}).snapshot.items[0].framework,null);
});
