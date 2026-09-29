import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../src/store.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'glasses-export-provenance-'));
  let store=createStore(directory);
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  return {get store(){return store;},restart(){store.close();store=createStore(directory);}};
}
function archive(bundle) {
  const file=bundle.files.find(file=>file.path===bundle.manifest.originalSourcesPath);
  assert.ok(file,'Manifest points to a supplied evidence archive');
  assert.equal(sha(file.content),bundle.manifest.originalSourcesSha256);
  const result=JSON.parse(file.content);
  for(const original of result.files){assert.equal(sha(original.content),original.sha256);assert.equal(Buffer.byteLength(original.content),original.bytes);}
  return result.files.map(({path,content})=>({path,content}));
}
function adaptations(bundle) {
  const path=bundle.manifest.provenancePath.replace(/provenance\.json$/,'adaptations.json');
  return JSON.parse(bundle.files.find(file=>file.path===path).content).files;
}

test('export retains renamed, deleted, changed and unchanged upstream files after restart',async t=>{
  const f=await fixture(t);
  const originals=[
    {path:'upstream/Page.tsx',content:'export default ()=> <main>Original</main>'},
    {path:'upstream/search-form.tsx',content:'export const SearchForm=()=> <input aria-label="Search"/>'},
    {path:'upstream/deleted.ts',content:'throw new Error("Original evidence must not execute");'},
    {path:'shared.ts',content:'export const title="Original";'},
    {path:'unchanged.ts',content:'export const unchanged="évidence";'}
  ];
  const cap=f.store.upsertCapability({url:'https://fixture.example/export-originals',kind:'component',name:'Original source fixture',sourceFiles:originals,provenance:{sourceHash:'fixture-source-hash'}}).item;
  const current=[{path:'App.tsx',content:'export default ()=> <main>Adapted</main>'},{path:'components/SearchForm.tsx',content:'export const SearchForm=()=> <input type="search"/>'},{path:'shared.ts',content:'export const title="Adapted";'},originals[4]];
  const workspace=f.store.createWorkspace({capabilityId:cap.id,files:current,entryPath:'App.tsx'});
  // A later catalogue refresh must not rewrite this workspace's immutable originals.
  f.store.upsertCapability({...cap,sourceFiles:[{path:'replacement.ts',content:'export const unrelated=true;'}]});
  f.restart();
  const bundle=f.store.exportWorkspace(workspace.id);
  assert.deepEqual(archive(bundle),originals);
  const changes=adaptations(bundle);
  assert.deepEqual(changes.find(file=>file.path==='upstream/search-form.tsx'),{path:'upstream/search-form.tsx',original:originals[1].content,current:null});
  assert.deepEqual(changes.find(file=>file.path==='components/SearchForm.tsx'),{path:'components/SearchForm.tsx',original:null,current:current[1].content});
  assert.deepEqual(changes.find(file=>file.path==='upstream/deleted.ts'),{path:'upstream/deleted.ts',original:originals[2].content,current:null});
  assert.deepEqual(changes.find(file=>file.path==='shared.ts'),{path:'shared.ts',original:originals[3].content,current:current[2].content});
  assert.ok(!changes.some(file=>file.path==='unchanged.ts'));
  assert.ok(!bundle.files.some(file=>file.path.startsWith('upstream/')),'Originals stay data, not runnable export files');
  assert.deepEqual(bundle.manifest.sourceHashes,Object.fromEntries(current.map(file=>[file.path,sha(file.content)])));
  assert.equal(f.store.getWorkspace(workspace.id).version,workspace.version,'Export is read-only');
});

test('original evidence archive avoids case-insensitive source and namespace collisions',async t=>{
  const {store}=await fixture(t);
  const files=[{path:'App.tsx',content:'export default ()=> <main>Collision fixture</main>'},{path:'ORIGINAL-SOURCES.json',content:'{"userOwned":true}'},{path:'GLASSES-EXPORT/helper.ts',content:'export const keep=true;'}];
  const workspace=store.createWorkspace({files,entryPath:'App.tsx'});
  const bundle=store.exportWorkspace(workspace.id);
  assert.equal(bundle.manifest.originalSourcesPath,'glasses-export-1/original-sources.json');
  assert.equal(bundle.manifest.consumerPath,'glasses-export-1/Consumer.tsx');
  assert.equal(bundle.files.find(file=>file.path==='ORIGINAL-SOURCES.json').content,files[1].content);
  assert.equal(new Set(bundle.files.map(file=>file.path.toLowerCase())).size,bundle.files.length);
  assert.deepEqual(archive(bundle),files);
  const prefix=store.createWorkspace({files:[files[0],{path:'original-sources.json/helper.ts',content:'export const directory=true;'}],entryPath:'App.tsx'});
  assert.equal(store.exportWorkspace(prefix.id).manifest.originalSourcesPath,'glasses-export/original-sources.json','Generated file cannot replace an existing source directory');
});

test('unsafe and duplicate upstream labels are preserved only as inert archive data',async t=>{
  const {store}=await fixture(t);
  const originals=[{path:'../../outside.ts',content:'export const external=1;'},{path:'C:/outside.ts',content:'export const external=2;'},{path:'../../outside.ts',content:'export const distinctSnapshot=3;'}];
  const cap=store.upsertCapability({url:'https://fixture.example/unsafe-evidence-labels',kind:'component',name:'Untrusted names fixture',sourceFiles:originals}).item;
  const workspace=store.createWorkspace({capabilityId:cap.id,source:'export default ()=> <main>Safe current file</main>'});
  const bundle=store.exportWorkspace(workspace.id);
  assert.deepEqual(archive(bundle),originals,'Do not silently lose duplicate or unusual original snapshots');
  assert.ok(bundle.files.every(file=>!file.path.includes('..')&&!file.path.includes(':')),'Evidence labels never become materialized paths');
  assert.ok(!bundle.files.find(file=>file.path===bundle.manifest.consumerPath).content.includes('original-sources'));
});
