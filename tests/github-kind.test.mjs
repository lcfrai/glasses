import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubRepositoryKind } from '../src/github-kind.mjs';
import { createDiscovery } from '../src/discovery.mjs';
import { createStore } from '../src/store.mjs';
import { createPublicCatalogue } from '../src/public-catalogue.mjs';

// Source-metadata fixtures cover the observed whole-product false positives and
// several real UI-library signals. No network or model calls are involved.
const cases = [
  { name:'zabbix', description:'Real-time monitoring of IT components and services, such as networks, servers, VMs, applications and the cloud.', topics:['monitoring'], kind:'solution' },
  { name:'bentopdf', description:'A Privacy First PDF Toolkit', topics:['pdf','pdf-editor','pdf-viewer-component'], kind:'solution' },
  { name:'cypress', description:'Fast, easy and reliable testing for anything that runs in a browser.', topics:['component-testing','testing-tool'], kind:'solution' },
  { name:'keda', description:'A Kubernetes-based Event Driven Autoscaling component.', topics:['kubernetes'], kind:'solution' },
  { name:'material-ui', description:'Material UI: Comprehensive React component library that implements Google\'s Material Design.', topics:['react'], kind:'component' },
  { name:'headlessui', description:'Completely unstyled, fully accessible UI components, designed to integrate beautifully with Tailwind CSS.', topics:['components'], kind:'component' },
  { name:'react-spectrum', description:'A collection of libraries and tools for adaptive, accessible user experiences.', topics:['react-components','ui-components'], kind:'component' },
  { name:'naive-ui', description:'A Vue 3 Component Library. Fairly Complete.', topics:[], kind:'component' },
  { name:'ui-examples', description:'A UI component library tutorial collection.', topics:['component-library'], kind:'pattern' },
];

test('whole products are not treated as UI libraries just for incidental component words/topics',()=>{
  for(const row of cases)assert.equal(githubRepositoryKind(row),row.kind,row.name);
  assert.equal(githubRepositoryKind({name:'business-app',topics:['components','ui-library-management','pdf-viewer-component']}),'solution');
  assert.equal(githubRepositoryKind({name:'ui-collection',topics:['UI-LIBRARY']}),'component');
});

test('discovery and strict publication share source-derived kinds without trusting a local kind override',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-github-kind-')),store=createStore(directory);
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const rows=cases.map(({kind,...row})=>({...row,full_name:`fixture/${row.name}`,html_url:`https://github.com/fixture/${row.name}`,private:false,default_branch:'main',license:{spdx_id:'MIT'},stargazers_count:1000}));
  const discovery=createDiscovery({store,fetcher:async url=>{
    const row=rows.find(item=>url===`https://api.github.com/repos/${item.full_name}`);assert.ok(row,url);
    return {url,status:200,contentType:'application/json',body:JSON.stringify(row)};
  }});
  const capabilities=[];
  for(let i=0;i<rows.length;i++){
    const item=await discovery.importUrl(rows[i].html_url);assert.equal(item.kind,cases[i].kind,rows[i].name);
    capabilities.push({...item,kind:item.kind==='solution'?'component':'solution'});
  }
  const evidence=store.evidence().map(ref=>store.getEvidence(ref.id));
  const {snapshot}=createPublicCatalogue({capabilities,evidence});
  assert.equal(snapshot.items.length,cases.length);
  for(const row of cases)assert.equal(snapshot.items.find(item=>item.name===`fixture/${row.name}`).kind,row.kind,row.name);
});
