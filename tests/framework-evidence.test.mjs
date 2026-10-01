import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectFramework} from '../src/framework.mjs';
import {createStore,stableId} from '../src/store.mjs';
import {createDiscovery,markdownDependencies,markdownSourceFiles} from '../src/discovery.mjs';
import {createPublicCatalogue} from '../src/public-catalogue.mjs';

const cases=[
 ['React primitive dependency',{dependencies:['@radix-ui/react-select@^2']},'React'],
 ['React source subpath',{files:[{path:'choice.tsx',content:'import {Combobox} from "@base-ui/react/combobox"; export {Combobox};'}]},'React'],
 ['Vue exact package',{dependencies:['reka-ui']},'Vue'],
 ['Vue composable import',{files:[{path:'choice.ts',content:'export { useFocus } from "@vueuse/core";'}]},'Vue'],
 ['Vue source inventory',{files:[{path:'Select.vue',type:'registry:ui'}]},'Vue'],
 ['Svelte source inventory',{files:[{path:'Select.svelte'}]},'Svelte'],
 ['Svelte package manifest',{files:[{path:'package.json',content:'{"peerDependencies":{"svelte":"^5"},"dependencies":{"bits-ui":"^2"}}'}]},'Svelte'],
 ['Angular application import',{files:[{path:'select.ts',content:'import {ReactiveFormsModule} from "@angular/forms";'}]},'Angular'],
 ['Angular peer dependency',{peerDependencies:{'@angular/core':'^20'}},'Angular'],
 ['Lit component',{files:[{path:'my-select.js',content:'import {LitElement, html} from "lit"; export class Select extends LitElement {}'}]},'Web Components'],
 ['Native custom element',{files:[{path:'select.js',content:'class Select extends HTMLElement {}\ncustomElements.define("my-select", Select);'}]},'Web Components'],
 ['Solid package source',{files:[{path:'select.tsx',content:'import { Select } from "@kobalte/core/select";'}]},'Solid'],
 ['Preact import',{files:[{path:'select.tsx',content:'import { useState } from "preact/hooks";'}]},'Preact'],
];
test('independent representative fixture families have explicit auditable framework evidence',()=>{
 for(const [label,input,expected] of cases){const result=detectFramework(input);assert.equal(result.framework,expected,label);assert.ok(result.evidence.length,label);}
});
test('unknown, cross-framework, demo names, lookalike packages and noncode strings remain conservative',()=>{
 for(const input of [
  {files:[{path:'Select.tsx',content:'"use client"; const frameworks=["Vue", "React"]; export default ()=><LocalSelect/>;'}]},
  {dependencies:['@radix-ui/themes-fake','reka-ui-helpers','vue-helper','lit-html','vite','motion','tailwindcss']},
  {files:[{path:'readme.md',content:'```js\nimport {LitElement} from "lit"\n```'}]},
  {files:[{path:'fake.js',content:'const text="class Select extends HTMLElement {};customElements.define()"; // import "react"\nconst x=`import x from "vue"`;'}]},
  {files:[{path:'object.js',content:'other.require("react"); obj.import("vue");'}]},
  {files:[{path:'template.html',content:'<my-select></my-select>'}]},
 ])assert.equal(detectFramework(input).framework,null,JSON.stringify(input));
 const mixed=detectFramework({files:[{path:'package.json',content:'{"dependencies":{"react":"^19","vue":"^3"}}'},{path:'widget.svelte'}]});
 assert.equal(mixed.framework,null);assert.deepEqual(mixed.frameworks,['React','Vue','Svelte']);
 const wrapper=detectFramework({files:[{path:'wrapper.ts',content:'import {createComponent} from "@lit/react";import {LitElement} from "lit";'}]});
 assert.equal(wrapper.framework,null);assert.deepEqual(wrapper.frameworks,['React','Web Components']);
});
test('explicit multi-stack declarations retain every framework while non-framework technology names stay unlabelled',()=>{
 for(const [description,expected] of [
  ['Exemplary fullstack applications powered by React, Angular, Node, Django, and many more.',['React','Angular']],
  ['A workbench built with React and Vue.',['React','Vue']],
  ['Examples written in Svelte, SolidJS & Preact.',['Svelte','Solid','Preact']],
  ['Controls built with Solid.js and Vue.js.',['Vue','Solid']],
  ['A frontend built with Vue 3 / React.js alongside a Node server.',['React','Vue']],
  ['An editor powered by Node, Django, React, and Angular.',['React','Angular']],
  ['Custom controls built with Web Components.',['Web Components']],
 ]){
  const result=detectFramework({description});assert.deepEqual(result.frameworks,expected,description);
  assert.equal(result.framework,expected.length===1?expected[0]:null,description);
  assert.ok(result.evidence.every(row=>row.basis==='description-declaration'));
 }
});
test('comparisons and migration prose do not declare the frameworks being discussed',()=>{
 for(const description of [
  'Compare applications built with React, Angular and Vue.',
  'A migration guide for apps built with React and Angular.',
  'Migrating React components to Vue components.',
  'A comparison of React UI components versus Angular components.',
  'Powered by Reactivity and Vuepress, with no component runtime.',
 ])assert.deepEqual(detectFramework({description}).frameworks,[],description);
 assert.equal(detectFramework({description:'A Vue component library. Includes a migration guide from React components.'}).framework,'Vue');
 assert.equal(detectFramework({description:'Migrate React components to Vue.',dependencies:['svelte']}).framework,'Svelte');
});
const hash=body=>createHash('sha256').update(body).digest('hex');
const time='2026-10-01T00:00:00.000Z';
function evidence(url,body,type='application/json'){body=typeof body==='string'?body:JSON.stringify(body);const sha256=hash(body);return{id:stableId(`${url}\n${sha256}`),url,body,sha256,status:200,contentType:type,firstFetchedAt:time,lastFetchedAt:time};}
const itemURL='https://registry.directory/fixture/ui/select';
const sourceURL='https://registry.directory/api/markdown/fixture/ui/select';
const sourceBody='## Metadata\n- **NPM Dependencies**: 0@reka-ui, 1@@vueuse/core\n## Files\n### Select.vue\n```vue\n<template><button>Choose</button></template>\n```';
function sample(indexOverrides={},sourceOverrides={},capOverrides={}){
 const index=evidence('https://registry.directory/items.json',{items:[{name:'select',registry:{basePath:'/fixture/ui',name:'Fixture'},categories:['select'],...indexOverrides}]});
 const source={...evidence(sourceURL,sourceBody,'text/markdown'),...sourceOverrides};
 const cap={id:stableId(itemURL),url:itemURL,origin:'live',metadataEvidence:index,sourceDocumentEvidence:source,framework:'React',tags:['react'],sourceFiles:[{path:'PRIVATE.tsx',content:'import React from "react"'}],...capOverrides};
 return{index,source,cap,project:()=>createPublicCatalogue({capabilities:[cap],evidence:[index,source]}).snapshot.items[0]};
}
test('strict public registry projection joins only exact hash-bound source, preserving licence and index fields',()=>{
 const {source,project}=sample();const row=project();assert.equal(row.framework,'Vue');assert.deepEqual(row.tags,['select']);assert.equal(row.license.spdx,null);assert.equal(row.license.scope,'registry-item');assert.equal(row.citations.length,2);assert.equal(row.citations[1].endpoint,sourceURL);assert.equal(row.citations[1].sha256,source.sha256);assert.ok(!JSON.stringify(row).includes('PRIVATE'));
 const deps=markdownDependencies(sourceBody,{url:sourceURL,evidence:source});assert.deepEqual(deps.dependencies,['reka-ui','@vueuse/core']);assert.equal(detectFramework({...deps,files:markdownSourceFiles(sourceBody)}).framework,'Vue');
});
test('foreign provider, query-bearing endpoint, altered body/hash and missing refs cannot prove framework',()=>{
 const bad=[
  evidence('https://registry.directory/api/markdown/other/ui/select',sourceBody,'text/markdown'),
  evidence(sourceURL+'?source=private',sourceBody,'text/markdown'),
  evidence(sourceURL+'/suffix',sourceBody,'text/markdown'),
  {body:sourceBody+'tampered'},
  {sha256:'0'.repeat(64)},
 ];
 for(const override of bad)assert.equal(sample({},override).project().framework,null,JSON.stringify(override));
 assert.equal(sample({}, {},{sourceDocumentEvidence:null}).project().framework,null);
 const f=sample();f.cap.sourceDocumentEvidence={...f.source,sha256:'0'.repeat(64)};assert.equal(f.project().framework,null);
});
test('contradictory index and source frameworks stay mixed rather than manufacturing compatibility',()=>{
 assert.equal(sample({framework:'React'}).project().framework,null);
 assert.equal(sample({frameworks:['React','Vue']}).project().framework,null);
});
test('duplicate index identities cannot establish a new source-framework binding',()=>{
 const f=sample();const index=evidence(f.index.url,{items:[...JSON.parse(f.index.body).items,...JSON.parse(f.index.body).items]});
 const result=createPublicCatalogue({capabilities:[{...f.cap,metadataEvidence:index}],evidence:[index,f.source]});
 assert.equal(result.snapshot.items[0].framework,null);assert.equal(result.snapshot.items[0].citations.length,1);
});
test('actual discovery retains source evidence and mixed state without a React preview or main store writes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'glasses-framework-join-'));const store=createStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const {index}=sample({framework:'React'});const ref=store.retainEvidence(index);
 const before=store.upsertCapability({name:'select',url:itemURL,provider:'Fixture',origin:'live',kind:'component',framework:'React',tags:['react'],license:null,metadataEvidence:ref}).item;
 const discovery=createDiscovery({store,fetcher:async url=>{assert.equal(url,sourceURL);return{url,body:sourceBody,status:200,contentType:'text/markdown'};}});
 const after=await discovery.inspect(before.id,{refreshSource:true});assert.equal(after.framework,null);assert.ok(after.frameworkEvidence.some(e=>e.framework==='React'));assert.ok(after.frameworkEvidence.some(e=>e.framework==='Vue'));assert.equal(after.previewSource,null);assert.equal(after.sourceState.status,'unsupported');assert.equal(store.getEvidence(after.sourceDocumentEvidence.id).body,sourceBody);
 const pub=createPublicCatalogue({capabilities:[after],evidence:[store.getEvidence(ref.id),store.getEvidence(after.sourceDocumentEvidence.id)]}).snapshot.items[0];assert.equal(pub.framework,null);assert.equal(pub.citations.length,2);
 const reverseIndex=store.retainEvidence(evidence(index.url,{items:[{name:'select',framework:'Vue',registry:{basePath:'/fixture/ui',name:'Fixture'}}]}));
 store.upsertCapability({...after,metadataEvidence:reverseIndex});
 const reactDiscovery=createDiscovery({store,fetcher:async url=>({url,body:'## Files\n### Select.tsx\n```tsx\nimport React from "react"; export default function Select(){return <button/>}\n```',status:200,contentType:'text/markdown'})});
 const reverse=await reactDiscovery.inspect(after.id,{refreshSource:true});assert.equal(reverse.framework,null);assert.equal(reverse.previewSource,null);
});
