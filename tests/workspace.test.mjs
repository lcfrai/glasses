import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';

async function sourceWorkspaceFixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'glasses-workspace-source-'));
 const store=createStore(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const source="import {label} from './helper';export default ()=> <h1>{label}</h1>";
 const sourceFiles=[{path:'upstream/Page.tsx',content:source},{path:'upstream/helper.ts',content:"export const label='Upstream';"}];
 const cap=store.upsertCapability({url:'https://fixture.example.org/source-precedence',name:'Source precedence fixture',kind:'component',origin:'live',license:null,previewSource:source,previewEntryPath:'upstream/Page.tsx',previewFiles:sourceFiles,sourceFiles,previewCss:'h1 {color:navy}',previewProps:{label:'Upstream prop'},provenance:{sourceHash:'retained-upstream-hash'}}).item;
 return {store,cap,source,sourceFiles};
}

test('workspace creation preserves supplied files with a capability and exports their actual entry',async t=>{
 const {store,cap,sourceFiles}=await sourceWorkspaceFixture(t);
 const files=[{path:'App.tsx',content:"import {label} from './data';export default ()=> <main>{label}</main>"},{path:'data.ts',content:"export const label='Adapted app';"}];
 const workspace=store.createWorkspace({capabilityId:cap.id,files,entryPath:'App.tsx'});
 assert.equal(workspace.source,files[0].content);
 assert.deepEqual(workspace.files,files);
 assert.deepEqual(store.getWorkspace(workspace.id).files,files,'Saved entry must equal the caller files on first readback');
 assert.deepEqual(workspace.originalFiles,sourceFiles,'Original evidence remains independent of the adapted source');
 assert.equal(workspace.provenance.capabilityId,cap.id);
 assert.deepEqual(store.getCapability(cap.id).sourceFiles,sourceFiles);
 const exported=store.exportWorkspace(workspace.id);
 assert.equal(exported.files.find(file=>file.path==='App.tsx').content,files[0].content);
 assert.equal(exported.manifest.entryPath,'App.tsx');
 const defaultEntry=store.createWorkspace({capabilityId:cap.id,files:[{path:'source.tsx',content:files[0].content}]});
 assert.equal(defaultEntry.entryPath,'source.tsx','Caller files use their own default entry, not the capability entry path');
 assert.throws(()=>store.createWorkspace({capabilityId:cap.id,files:[]}),/no preview source/,'Empty supplied files must not resurrect upstream source');
 assert.throws(()=>store.createWorkspace({capabilityId:cap.id,files,entryPath:'missing.tsx'}),/entry file is missing/);
});

test('capability-only workspace creation keeps the original source, helper files and defaults',async t=>{
 const {store,cap,source,sourceFiles}=await sourceWorkspaceFixture(t);
 const workspace=store.createWorkspace({capabilityId:cap.id});
 assert.equal(workspace.source,source);
 assert.equal(workspace.entryPath,'upstream/Page.tsx');
 assert.deepEqual(workspace.files,sourceFiles);
 assert.deepEqual(workspace.originalFiles,sourceFiles);
 assert.equal(workspace.css,cap.previewCss);
 assert.deepEqual(workspace.props,cap.previewProps);
});

test('an explicit source remains authoritative over caller files and capability fallback',async t=>{
 const {store,cap,sourceFiles}=await sourceWorkspaceFixture(t);
 const source='export default ()=> <main>Explicit source</main>';
 const files=[{path:'App.tsx',content:'export default ()=> <main>File entry</main>'},{path:'data.ts',content:'export const value=42;'}];
 const workspace=store.createWorkspace({capabilityId:cap.id,source,files,entryPath:'App.tsx'});
 assert.equal(workspace.source,source);
 assert.equal(workspace.files.find(file=>file.path==='App.tsx').content,source);
 assert.equal(workspace.files.find(file=>file.path==='data.ts').content,files[1].content);
 assert.deepEqual(workspace.originalFiles,sourceFiles);
 assert.match(files[0].content,/File entry/,'Normalization does not mutate the caller input');
 const sourceOnly=store.createWorkspace({capabilityId:cap.id,source});
 assert.equal(sourceOnly.source,source);
 assert.equal(sourceOnly.entryPath,cap.previewEntryPath);
 assert.equal(sourceOnly.files.find(file=>file.path==='upstream/helper.ts').content,sourceFiles[1].content);
});

test('multi-file workspace and agent visual changes survive restart and export with source identity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'glasses-workspace-'));
 let store=createStore(directory);
 try {
  const cap=store.upsertCapability({url:'https://example.test/real-source',name:'External fixture',description:'Synthetic fixture for source identity testing',kind:'component',origin:'live',license:'MIT',provenance:{revision:'revision-fixture'},previewSource:"import {label} from './helper';export default ()=> <h1>{label}</h1>",previewEntryPath:'ui/App.tsx',previewFiles:[{path:'ui/helper.ts',content:"export const label='External source';"}]}).item;
  let workspace=store.createWorkspace({capabilityId:cap.id});
  assert.equal(workspace.files.length,2);assert.equal(workspace.entryPath,'ui/App.tsx');
  const selector='[data-glasses-root] > :nth-child(1)';
  workspace=store.updateWorkspace(workspace.id,{files:workspace.files.map(file=>file.path==='ui/helper.ts'?{...file,content:"export const label='Adapted source';"}:file),visualEdits:{[selector]:{color:'#135724',padding:'24px'}}});
  const id=workspace.id;store.close();store=createStore(directory);workspace=store.getWorkspace(id);
  assert.equal(workspace.visualEdits[selector].padding,'24px');assert.equal(workspace.provenance.capabilityId,cap.id);
  const bundle=store.exportWorkspace(id);assert.equal(bundle.manifest.entryPath,'ui/App.tsx');assert.equal(bundle.manifest.provenance.revision,'revision-fixture');
  assert.match(bundle.files.find(file=>file.path==='ui/helper.ts').content,/Adapted source/);
  assert.match(bundle.files.find(file=>file.path==='visual-edits.css').content,/24px !important/);
  assert.match(bundle.files.find(file=>file.path==='Consumer.tsx').content,/data-glasses-root/);
  const changes=JSON.parse(bundle.files.find(file=>file.path==='adaptations.json').content);
  assert.equal(changes.files[0].path,'ui/helper.ts');assert.match(changes.files[0].original,/External source/);
  assert.match(bundle.manifest.dependencies.react,/^\d+\.\d+\.\d+/);
  const updated=store.updateWorkspace(id,{source:'export default ()=> <h1>Agent source edit</h1>'});
  assert.equal(updated.files.find(file=>file.path===updated.entryPath).content,updated.source);
  assert.throws(()=>store.updateWorkspace(id,{expectedVersion:updated.version-1,source:'export default ()=> <h1>Stale edit</h1>'}),error=>error.status===409);
  assert.equal(store.getWorkspace(id).source,updated.source);
  assert.equal(store.updateWorkspace(id,{expectedVersion:updated.version,title:'Current version edit'}).title,'Current version edit');
  const collision=store.createWorkspace({entryPath:'Consumer.tsx',source:'export default ()=> <h1>Original Consumer</h1>',files:[{path:'styles.css',content:'h1 {color:red}'},{path:'props.json',content:'{"original":true}'}]});
  const collisionExport=store.exportWorkspace(collision.id);
  assert.equal(collisionExport.files.find(file=>file.path==='Consumer.tsx').content,collision.source);
  assert.equal(collisionExport.files.find(file=>file.path==='props.json').content,'{"original":true}');
  assert.equal(collisionExport.manifest.consumerPath,'glasses-export/Consumer.tsx');
  assert.equal(collisionExport.manifest.compiledCssPath,'glasses-export/compiled.css');
  assert.match(collisionExport.files.find(file=>file.path==='glasses-export/Consumer.tsx').content,/import Candidate from '\.\.\/Consumer.tsx'/);
  const caseCollision=store.createWorkspace({entryPath:'consumer.tsx',source:'export default ()=> <h1>Windows safe</h1>',files:[{path:'GLASSES-EXPORT/helper.ts',content:'export const fixture=true'}]});
  assert.equal(store.exportWorkspace(caseCollision.id).manifest.consumerPath,'glasses-export-1/Consumer.tsx');
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
