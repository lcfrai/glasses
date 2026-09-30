import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectFramework} from '../src/framework.mjs';
import {createDiscovery,extractPreviewSource,markdownSourceFiles} from '../src/discovery.mjs';
import {createStore,stableId} from '../src/store.mjs';
import {createPublicCatalogue} from '../src/public-catalogue.mjs';

const vue='<script setup lang="ts">import { ref } from "vue"; const open=ref(false)</script>\n<template><button @click="open=!open">{{open}}</button></template>';
const react='import React from "react"; export default function Button(){return <button>Open</button>}';
async function fixture(t,fetcher){const dir=await mkdtemp(join(tmpdir(),'glasses-framework-')),store=createStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return{store,discovery:createDiscovery({store,fetcher})};}
const json=(url,data)=>({url,body:JSON.stringify(data),contentType:'application/json',status:200});

test('frameworks require exact declarations, dependencies, imports or distinctive file conventions',()=>{
 for(const [input,expected] of [
  [{files:[{path:'Button.vue',content:vue}]},'Vue'],
  [{files:[{path:'Button.svelte',content:'<button>Hello</button>'}]},'Svelte'],
  [{files:[{path:'view.tsx',content:'import {\n createSignal\n} from "solid-js"; export function View(){return <div/>}'}]},'Solid'],
  [{files:[{path:'view.tsx',content:'import { h } from "preact"; export function View(){return <div/>}'}]},'Preact'],
  [{files:[{path:'view.ts',content:'import {Component} from "@angular/core"; @Component({}) export class View {}'}]},'Angular'],
  [{files:[{path:'view.tsx',content:react}]},'React'],
  [{dependencies:['vue@^3.5.0']},'Vue'],
  [{peerDependencies:{'@angular/core':'^20'}},'Angular'],
  [{files:[{path:'package.json',content:JSON.stringify({peerDependencies:{svelte:'^5'}})}]},'Svelte'],
  [{framework:'Vue'},'Vue'],[{topics:['preact']},'Preact'],[{description:'A Vue 3 component library.'},'Vue'],
 ])assert.equal(detectFramework(input).framework,expected,JSON.stringify(input));
});

test('generic TSX, reactive words, package substrings, comments and quoted examples stay unknown',()=>{
 for(const input of [
  {files:[{path:'component.tsx',content:'export function Box(){return <div/>}'}]},
  {name:'reactive-service',description:'A reactive data platform',topics:['reaction']},
  {dependencies:['not-react','@lab/reactor']},
  {files:[{path:'notes.ts',content:'// import React from "react"\n/* import x from "vue" */\nconst example=\'import x from "solid-js"\';'}]},
  {framework:'registry',tags:['registry','ui']},
 ])assert.equal(detectFramework(input).framework,null);
 const mixed=detectFramework({dependencies:['vue','react']});assert.equal(mixed.framework,null);assert.deepEqual(mixed.frameworks,['React','Vue']);
});

test('non-React TSX and mixed-framework bundles never acquire a React preview adapter',()=>{
 const solid=[{path:'Counter.tsx',content:'import {createSignal} from "solid-js"; export function Counter(){return <div/>}'}];
 assert.deepEqual(extractPreviewSource(solid),{});
 assert.deepEqual(extractPreviewSource([{path:'Button.tsx',content:react}],{dependencies:['vue']}),{});
 assert.ok(extractPreviewSource([{path:'Button.tsx',content:react}]).previewSource);
});

test('Vue registry JSON preserves exact source and dependency evidence, but cannot create a React canvas',async t=>{
 const url='https://official-vue.example.org/r/button.json',files=[{path:'components/Button.vue',content:vue}];
 const {store,discovery}=await fixture(t,async request=>json(request,{name:'button',dependencies:['vue'],files}));
 const item=await discovery.importUrl(url);
 assert.equal(item.framework,'Vue');assert.deepEqual(item.sourceFiles,files);assert.equal(item.sourceState.status,'unsupported');assert.equal(item.previewSource,null);
 assert.match(item.sourceError,/supported exported React component/);assert.ok(item.frameworkEvidence.some(value=>value.basis==='file-convention'));
 assert.throws(()=>store.createWorkspace({capabilityId:item.id}),/no preview source/);
 const inspected=await discovery.inspect(item.id);assert.equal(inspected.sourceFiles[0].content,vue);
 const snapshot=store.getEvidence(item.sourceDocumentEvidence.id);assert.ok(snapshot.body.includes('Button.vue'));
 const published=createPublicCatalogue({capabilities:[item],evidence:[snapshot]}).snapshot.items[0];
 assert.equal(published.framework,'Vue');assert.ok(!published.tags.includes('react'));assert.equal(published.citations[0].sha256,snapshot.sha256);assert.ok(!JSON.stringify(published).includes('<script'));
});

test('Markdown Vue/Svelte/Angular templates retain paths and never promote an unrelated utility export to React',async t=>{
 const body='## Files\n### components/Button.vue\n```vue\n'+vue+'\n```\n### lib/helper.ts\n```typescript\nexport const Helper = 1;\n```\n### template.html\n```html\n<button>Action</button>\n```';
 const files=markdownSourceFiles(body);assert.equal(files.length,3);assert.equal(files[0].path,'components/Button.vue');assert.equal(markdownSourceFiles('```svelte\n<button/>\n```')[0].path,'source-0.svelte');
 const {discovery}=await fixture(t,async url=>({url,body,contentType:'text/markdown',status:200}));
 const item=await discovery.importUrl('https://registry.directory/test/vue/button');
 assert.equal(item.framework,'Vue');assert.equal(item.sourceFiles.length,3);assert.equal(item.previewSource,null);assert.equal(item.sourceState.status,'unsupported');
});

test('refresh React to Vue clears prior runnable preview without losing retained source history',async t=>{
 const url='https://source.example.org/r/button.json';let files=[{path:'Button.tsx',content:react}];
 const {discovery}=await fixture(t,async request=>json(request,{name:'button',files}));
 const first=await discovery.importUrl(url);assert.equal(first.framework,'React');assert.ok(first.previewSource);
 files=[{path:'Button.vue',content:vue}];const refreshed=await discovery.inspect(first.id,{refreshSource:true});
 assert.equal(refreshed.framework,'Vue');assert.ok(!refreshed.tags.includes('react'));assert.ok(refreshed.tags.includes('vue'));assert.equal(refreshed.previewSource,null);assert.deepEqual(refreshed.previewFiles,[]);assert.equal(refreshed.sourceHistory.length,2);assert.equal(refreshed.sourceFiles[0].content,vue);
});

test('scout and GitHub import use framework evidence without borrowing a provider framework for generic children',async t=>{
 const provider={name:'Vue Source',url:'https://vue-source.example.org/',registry_url:'https://vue-source.example.org/registry.json',framework:'Vue'};
 const fetcher=async url=>{
  if(url.endsWith('/directory.json'))return json(url,{registries:[provider]});
  if(url.endsWith('/items.json'))return json(url,{items:[{name:'untagged',registry:{name:provider.name,basePath:'/lab/vue'}}]});
  if(url===provider.registry_url)return json(url,{items:[{name:'Button',files:[{path:'Button.vue',content:vue}]}]});
  if(url.includes('/api/markdown/'))return{url,body:'No source blocks',contentType:'text/markdown',status:200};
  const repo={name:'reactive-store',full_name:'lab/reactive-store',html_url:'https://github.com/lab/reactive-store',private:false,description:'A reactive data store',topics:['database']};
  return json(url,url.includes('/search/repositories')?{items:[repo]}:repo);
 };
 const {store,discovery}=await fixture(t,fetcher);await discovery.scout();
 assert.equal(store.getCapability(stableId(provider.url)).framework,'Vue');
 assert.equal(store.getCapability(stableId('https://registry.directory/lab/vue/untagged')).framework,null);
 const child=store.search().find(item=>item.name==='Button');assert.equal(child.framework,'Vue');assert.equal(child.sourceState.status,'unsupported');assert.equal(store.getCapability(child.id).previewSource,null);
 assert.equal((await discovery.importUrl('https://github.com/lab/reactive-store')).framework,null);
});
