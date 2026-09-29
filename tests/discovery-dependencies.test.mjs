import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../src/store.mjs';
import {createDiscovery} from '../src/discovery.mjs';

const itemUrl='https://registry.directory/fixture/ui/example';
const markdownUrl='https://registry.directory/api/markdown/fixture/ui/example';
const component='export default function Example(){return <section>Exact source fixture</section>}\n';
const markdown=metadata=>`# Example\n\n## Metadata\n\n${metadata}\n\n## Files\n\n### components/example.tsx\n\n\`\`\`tsx\n${component}\`\`\`\n`;
async function fixture(t,fetcher){
 const dir=await mkdtemp(join(tmpdir(),'glasses-dependency-metadata-'));const store=createStore(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 return {store,discovery:createDiscovery({store,fetcher})};
}

test('Markdown inspection preserves declared packages, version ranges, registry names and exact linked URLs without fetching dependencies',async t=>{
 const body=markdown('- **NPM Dependencies**: 0@radix-ui, 1@@dnd-kit/core, `motion@^12.0.0`, [recharts](https://recharts.org/en-US/api), radix-ui\n- **Registry Dependencies**: accordion, @animate-ui/hooks-use-is-in-view, [chart](https://ui.example/r/chart.json?variant=a,b), https://ui.example/r/tooltip.json');
 const calls=[];const {store,discovery}=await fixture(t,async url=>{calls.push(url);assert.equal(url,markdownUrl);return {url,body,status:200,contentType:'text/markdown'};});
 const item=await discovery.importUrl(itemUrl);
 assert.deepEqual(item.dependencies,['radix-ui','@dnd-kit/core','motion@^12.0.0','recharts']);
 assert.deepEqual(item.registryDependencies,['accordion','@animate-ui/hooks-use-is-in-view','https://ui.example/r/chart.json?variant=a,b','https://ui.example/r/tooltip.json']);
 assert.deepEqual(item.dependencyMetadata.links,[{kind:'npm',name:'recharts',url:'https://recharts.org/en-US/api'},{kind:'registry',name:'chart',url:'https://ui.example/r/chart.json?variant=a,b'}]);
 assert.match(item.dependencyMetadata.raw.npm,/0@radix-ui/);
 assert.equal(item.dependencyMetadata.sourceUrl,markdownUrl);
 assert.equal(item.dependencyMetadata.evidenceId,item.sourceDocumentEvidence.id);
 assert.equal(store.getEvidence(item.sourceDocumentEvidence.id).body,body);
 assert.equal(item.provenance.sourceHash,createHash('sha256').update(body).digest('hex'));
 assert.equal(item.sourceFiles[0].content,component);
 assert.equal(item.license,null,'Dependency declarations grant no rights');
 assert.deepEqual(calls,[markdownUrl],'No inferred registry or package request');
 const readback=await discovery.inspect(item.id,{fetchSource:false});
 assert.deepEqual(readback.registryDependencies,item.registryDependencies);
});

test('refresh clears stale dependency declarations and ignores declaration-looking text inside source',async t=>{
 let body=markdown('- **NPM Dependencies**: 0@motion\n- **Registry Dependencies**: accordion');
 const {discovery}=await fixture(t,async url=>({url,body,status:200,contentType:'text/markdown'}));
 const before=await discovery.importUrl(itemUrl);
 assert.deepEqual(before.dependencies,['motion']);
 body=markdown('').replace(component,component+'//\n- **NPM Dependencies**: dangerous-looking-source-text\n');
 const after=await discovery.inspect(before.id,{refreshSource:true});
 assert.deepEqual(after.dependencies,[]);assert.deepEqual(after.registryDependencies,[]);
 assert.deepEqual(after.dependencyMetadata.raw,{});
 assert.notEqual(after.sourceDocumentEvidence.id,before.sourceDocumentEvidence.id);
 assert.equal(after.sourceHistory.length,2);
});

test('cached legacy Markdown gains dependency metadata from the retained exact response without a network fetch',async t=>{
 const body=markdown('- **NPM Dependencies**: 0@radix-ui\n- **Registry Dependencies**: accordion');let calls=0;
 const {store,discovery}=await fixture(t,async url=>{calls++;return {url,body,status:200,contentType:'text/markdown'};});
 const original=await discovery.importUrl(itemUrl);
 store.upsertCapability({...original,dependencies:undefined,registryDependencies:undefined,dependencyMetadata:undefined});
 const result=await discovery.inspect(original.id,{fetchSource:true});
 assert.deepEqual(result.dependencies,['radix-ui']);assert.deepEqual(result.registryDependencies,['accordion']);
 assert.equal(calls,1);
 assert.deepEqual(result.sourceFiles,original.sourceFiles);assert.deepEqual(result.sourceState,original.sourceState);
 assert.deepEqual(result.sourceDocumentEvidence,original.sourceDocumentEvidence);assert.deepEqual(result.provenance,original.provenance);
 assert.equal(result.license,original.license);assert.deepEqual(result.sourceHistory,original.sourceHistory);
});

test('cached source without retained Markdown evidence stays unchanged',async t=>{
 const {store,discovery}=await fixture(t,async()=>{throw new Error('No fetch expected');});
 const item=store.upsertCapability({url:'https://github.com/fixture/source',name:'Legacy cached repository',kind:'solution',sourceState:{status:'ok',checkedAt:new Date().toISOString()},repositoryFiles:[{path:'README.md',content:'Legacy metadata'}]}).item;
 const result=await discovery.inspect(item.id,{fetchSource:true});
 assert.equal(result.dependencyMetadata,undefined);assert.deepEqual(result.repositoryFiles,item.repositoryFiles);
});

test('JSON file target and type remain evidence metadata without rewriting source paths or recursive import',async t=>{
 const url='https://ui.example/r/panel.json';let target='components/ui/panel.tsx';const calls=[];
 const {store,discovery}=await fixture(t,async actual=>{calls.push(actual);assert.equal(actual,url);return {url,contentType:'application/json',status:200,body:JSON.stringify({name:'panel',dependencies:['radix-ui'],registryDependencies:['https://ui.example/r/button.json'],files:[{path:'registry/new-york/panel.tsx',target,type:'registry:ui',content:component},{path:'registry/new-york/data.json',target:'app/data.json',type:'registry:file',content:'{"value":42}'}]})};});
 const before=await discovery.importUrl(url);
 assert.deepEqual(before.sourceFileMetadata,[{path:'registry/new-york/panel.tsx',target:'components/ui/panel.tsx',type:'registry:ui'},{path:'registry/new-york/data.json',target:'app/data.json',type:'registry:file'}]);
 assert.equal(before.sourceFiles[0].path,'registry/new-york/panel.tsx');
 assert.equal(before.previewEntryPath,'registry/new-york/panel.tsx');
 assert.equal(before.sourceFiles[1].content,'{"value":42}');
 target='../../outside.tsx';
 const after=await discovery.inspect(before.id,{refreshSource:true});
 assert.equal(after.sourceFileMetadata[0].target,'../../outside.tsx','An untrusted target is retained as metadata, never materialized');
 assert.equal(after.sourceFiles[0].path,'registry/new-york/panel.tsx');
 assert.equal(after.sourceFiles[0].content,component);
 assert.deepEqual(store.getCapability(before.id).sourceFileMetadata,after.sourceFileMetadata);
 assert.deepEqual(calls,[url,url]);
 assert.equal(after.license,null);
});
