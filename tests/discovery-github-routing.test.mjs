import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createDiscovery } from '../src/discovery.mjs';

async function fixture(t, fetcher) {
  const directory=await mkdtemp(join(tmpdir(),'glasses-github-routing-'));
  const store=createStore(directory);
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  return {store,discovery:createDiscovery({store,fetcher})};
}
const page=url=>({url,status:200,contentType:'text/html',body:'<title>Public GitHub reference</title><meta name="description" content="A public discovery page; no reusable source or licence established.">'});
const json=(url,data)=>({url,status:200,contentType:'application/json',body:JSON.stringify(data)});
const repository=(owner,name)=>({full_name:`${owner}/${name}`,name,html_url:`https://github.com/${owner}/${name}`,description:'A reusable local tool',default_branch:'main',license:{spdx_id:'MIT'},topics:['tools']});

test('GitHub topic/search/site routes import as evidence-backed references without repository API probes',async t=>{
  const requests=[];
  const {store,discovery}=await fixture(t,async url=>{requests.push(url);assert.equal(new URL(url).hostname,'github.com','site routes must not fabricate repository API requests');return page(url);});
  for(const url of [
    'https://github.com/topics/react-dashboard',
    'https://github.com/search/advanced?q=react',
    'https://github.com/collections/design-essentials',
    'https://github.com/orgs/openai',
    'https://github.com/features/copilot',
    'https://github.com/marketplace/actions',
    'https://github.com/sponsors/explore',
    'https://github.com/settings/profile',
    'https://github.com/Topics/react-dashboard',
    'https://github.com/%74opics/react-dashboard',
    'https://github.com/search?q=react&type=repositories'
  ]){
    const before=requests.length,item=await discovery.importUrl(url);
    assert.equal(requests.length,before+1);
    assert.equal(requests.at(-1),url);
    assert.equal(item.url,url);
    assert.equal(item.kind,'reference');
    assert.equal(item.licenseStatus,'unknown');
    assert.equal(item.github,undefined);
    const evidence=store.getEvidence(item.metadataEvidence.id);
    assert.equal(evidence.url,url);assert.match(evidence.sha256,/^[a-f0-9]{64}$/);
    await discovery.inspect(item.id,{fetchSource:true});
    assert.equal(requests.length,before+1,'inspecting a reference must not attach repository files');
  }
});

test('real repository roots still use metadata API, canonical URLs and pinned repository evidence',async t=>{
  const requests=[],sha='a'.repeat(40);
  const {store,discovery}=await fixture(t,async url=>{
    requests.push(url);
    const path=new URL(url).pathname;
    if(path==='/repos/openai/codex')return json(url,repository('openai','codex'));
    if(path==='/repos/openai/codex/commits/main')return json(url,{sha});
    if(path==='/repos/openai/codex/license')return json(url,{encoding:'base64',path:'LICENSE',content:Buffer.from('MIT fixture licence text').toString('base64'),license:{spdx_id:'MIT'}});
    if(path==='/repos/openai/codex/readme')return json(url,{encoding:'base64',path:'README.md',content:Buffer.from('Public repository fixture').toString('base64')});
    throw new Error('Unexpected fixture request');
  });
  for(const url of ['https://github.com/openai/codex','https://github.com/openai/codex/','https://github.com/openai/codex.git','https://github.com/openai/codex?tab=readme-ov-file']){
    const item=await discovery.importUrl(url);
    assert.equal(requests.at(-1),'https://api.github.com/repos/openai/codex');
    assert.equal(item.url,'https://github.com/openai/codex');assert.equal(item.kind,'solution');
  }
  const item=store.search().find(item=>item.url==='https://github.com/openai/codex');
  const inspected=await discovery.inspect(item.id,{fetchSource:true});
  assert.equal(inspected.provenance.resolvedRevision,sha);
  assert.equal(inspected.repositoryEvidence.length,3);
  assert.equal(inspected.licenseEvidence.status,'fetched');
  assert.ok(requests.includes(`https://api.github.com/repos/openai/codex/readme?ref=${sha}`));
});

test('blob and tree links preserve exact ref/path as public references rather than collapsing to repository roots',async t=>{
  const requests=[];
  const {discovery}=await fixture(t,async url=>{requests.push(url);assert.equal(new URL(url).hostname,'github.com');return page(url);});
  for(const url of [
    'https://github.com/openai/codex/blob/main/README.md',
    'https://github.com/openai/codex/tree/main/codex-rs',
    'https://github.com/openai/codex/blob/release%2Fnext/docs/README.md',
    'https://github.com/openai/codex/tree/'+'b'.repeat(40)
  ]){
    const item=await discovery.importUrl(url);
    assert.equal(item.kind,'reference');assert.equal(item.url,url);
    assert.equal(item.provenance.sourceUrl,url);
    assert.equal(item.previewSource,undefined);
    assert.equal(requests.at(-1),url);
  }
});

test('reserved words remain valid repository names under real owners; encoded delimiters are never API components',async t=>{
  const requests=[];
  const {discovery}=await fixture(t,async url=>{
    requests.push(url);
    if(url==='https://api.github.com/repos/example-owner/topics')return json(url,repository('example-owner','topics'));
    if(url==='https://api.github.com/repos/github/docs')return json(url,repository('github','docs'));
    return page(url);
  });
  const real=await discovery.importUrl('https://github.com/example-owner/topics');
  assert.equal(real.kind,'solution');assert.equal(requests.at(-1),'https://api.github.com/repos/example-owner/topics');
  const official=await discovery.importUrl('https://github.com/github/docs');
  assert.equal(official.kind,'solution');assert.equal(requests.at(-1),'https://api.github.com/repos/github/docs');
  for(const url of ['https://github.com/openai%2Fextra/codex','https://github.com/openai/codex%2Fextra','https://github.com/%ZZ/codex']){
    const item=await discovery.importUrl(url);
    assert.equal(item.kind,'reference');assert.equal(requests.at(-1),url);
  }
});

test('GitHub routing preserves URL and SSRF rejection before fetching',async t=>{
  let calls=0;
  const {discovery}=await fixture(t,async url=>{calls++;return page(url);});
  for(const url of ['http://github.com/openai/codex','https://user:secret@github.com/topics/react','https://github.com:444/openai/codex','https://127.0.0.1/topics/react','https://github.com.local/openai/codex'])await assert.rejects(discovery.importUrl(url),/HTTPS|blocked|reserved/);
  assert.equal(calls,0);
});
