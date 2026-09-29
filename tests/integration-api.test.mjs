import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../src/server.mjs';

const source='export default function Candidate(){return <div className="p-4">Original supplied component</div>}';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function appFor(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'glasses-api-review-'));
  const app=await startServer({port:0,dataDir:dir,autoScout:false,seed:false,...options});
  const clients=[];
  t.after(async()=>{for(const client of clients)await client.close();await app.close();await rm(dir,{recursive:true,force:true});});
  const {token}=await (await fetch(app.url+'/api/session')).json();
  const api=async(path,method='GET',body)=>{const response=await fetch(app.url+path,{method,headers:{'X-Glasses-Token':token,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  const mcp=async()=>{const client=new Client({name:'glasses-independent-review',version:'0.2.0'});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{...process.env,GLASSES_URL:app.url},stderr:'pipe'}));return client;};
  return {app,api,mcp};
}

test('HTTP export namespaces generated files without changing source and returns a consistent compiled manifest',async t=>{
  const {api}=await appFor(t),css='.original { color: rgb(12, 34, 56); }';
  const created=await api('/api/workspaces','POST',{title:'Reserved filename export',entryPath:'Consumer.tsx',files:[{path:'Consumer.tsx',content:source},{path:'styles.css',content:css}]});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const exported=await api(`/api/workspaces/${created.data.id}/export`);assert.equal(exported.status,200,JSON.stringify(exported.data));
  const {files,manifest}=exported.data;
  assert.equal(files.find(x=>x.path==='Consumer.tsx').content,source);
  assert.equal(files.find(x=>x.path==='styles.css').content,css);
  assert.notEqual(manifest.consumerPath,'Consumer.tsx');assert.match(manifest.consumerPath,/^glasses-export\//);
  assert.ok(files.some(x=>x.path===manifest.compiledCssPath&&x.content.length>100));
  assert.match(manifest.compiledPreviewHash,/^[a-f0-9]{64}$/);
  const provenance=files.find(x=>x.path===manifest.provenancePath);assert.ok(provenance,'Manifest declares the exported provenance file');
  assert.deepEqual(JSON.parse(provenance.content),manifest,'HTTP manifest and saved provenance.json are identical after compilation');
  assert.equal(new Set(files.map(x=>x.path.toLowerCase())).size,files.length,'No Windows case-insensitive collisions');
  for(const [path,hash] of Object.entries(manifest.sourceHashes))assert.equal(digest(files.find(x=>x.path===path).content),hash);
  const packagePath=manifest.consumerPath.replace(/Consumer\.tsx$/,'package.json');
  assert.deepEqual(JSON.parse(files.find(x=>x.path===packagePath).content).dependencies,manifest.dependencies);
});

test('HTTP rejects malformed source files, selectors, style values and outcome contexts without saving partial work',async t=>{
  const {api,app}=await appFor(t);
  const invalidWorkspaces=[
    {source,files:'not an array'},
    {source,files:[null]},
    {entryPath:'../escape.tsx',source},
    {entryPath:'source.tsx',files:[{path:'source.tsx',content:source},{path:'SOURCE.tsx',content:source}]},
    {source,visualEdits:[]},
    {source,visualEdits:{'body':{padding:'10px'}}},
    {source,visualEdits:{'[data-glasses-root] > :nth-child(1)':{position:'fixed'}}},
    {source,visualEdits:{'[data-glasses-root] > :nth-child(1)':{color:'red; background: url(https://bad.example.org)'}}},
    {source,expectedVersion:0},
  ];
  for(const payload of invalidWorkspaces){const result=await api('/api/workspaces','POST',payload);assert.equal(result.status,400,JSON.stringify(payload));assert.ok(result.data.error);}
  assert.deepEqual((await api('/api/workspaces')).data.items,[]);
  const item=app.store.upsertCapability({url:'https://synthetic.example.org/review',name:'Review fixture',kind:'component',license:null}).item;
  for(const context of [null,[],42,{version:24},{project:'x'.repeat(1001)}]){
    const result=await api('/api/outcomes','POST',{capabilityId:item.id,result:'failed',notes:'Invalid context must not persist',context});assert.equal(result.status,400,JSON.stringify(context));
  }
  assert.deepEqual(app.store.outcomes(item.id),[]);
});

test('HTTP and MCP stale version edits return explicit conflict without overwriting another writer',async t=>{
  const {api,mcp}=await appFor(t);const client=await mcp();
  const {data:workspace}=await api('/api/workspaces','POST',{source,title:'Concurrent workspace'});
  const first=await api(`/api/workspaces/${workspace.id}`,'PUT',{title:'Human edit',expectedVersion:workspace.version});assert.equal(first.status,200);
  const conflict=await api(`/api/workspaces/${workspace.id}`,'PUT',{title:'Stale HTTP writer',expectedVersion:workspace.version});assert.equal(conflict.status,409);assert.match(conflict.data.error,/current version is 2/);
  const mcpConflict=await client.callTool({name:'glasses_update_workspace',arguments:{id:workspace.id,title:'Stale agent writer',expectedVersion:workspace.version}});assert.equal(mcpConflict.isError,true);assert.match(mcpConflict.content[0].text,/current version is 2/);
  const current=(await api(`/api/workspaces/${workspace.id}`)).data;assert.equal(current.title,'Human edit');assert.equal(current.version,2);
  const merged=await client.callTool({name:'glasses_update_workspace',arguments:{id:workspace.id,title:'Reviewed merged edit',expectedVersion:current.version}});assert.ok(!merged.isError);assert.equal(JSON.parse(merged.content[0].text).version,3);
});

test('MCP reports unsupported modules and unknown tools as errors with no substituted source',async t=>{
  const {mcp}=await appFor(t),client=await mcp();
  const result=await client.callTool({name:'glasses_preview',arguments:{source:'import secret from "node:fs"; export default function Bad(){return <div>{secret}</div>}'}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/Unsupported preview import "node:fs"/);
  const unknown=await client.callTool({name:'glasses_nonexistent',arguments:{}});assert.equal(unknown.isError,true);assert.match(unknown.content[0].text,/Unknown tool/);
});

test('HTTP and MCP compile a files-only preview with its real entry and local helper',async t=>{
  const {api,mcp}=await appFor(t),client=await mcp();
  const input={entryPath:'components/actual.tsx',files:[{path:'components/actual.tsx',content:'import {label} from "./label";export default function Actual(){return <div>{label}</div>}'},{path:'components/label.ts',content:'export const label="Real local helper";'}]};
  const preview=await api('/api/preview','POST',input);assert.equal(preview.status,200,JSON.stringify(preview.data));assert.ok(preview.data.imports.includes('./label'));
  const response=await client.callTool({name:'glasses_preview',arguments:input});assert.ok(!response.isError,response.content[0].text);
  const viaMCP=JSON.parse(response.content[0].text);assert.equal(viaMCP.hash,preview.data.hash);assert.equal(viaMCP.compiledCss,preview.data.compiledCss);
  assert.ok(viaMCP.html.includes('Real local helper'));
});

test('MCP backend-unavailable response tells the caller to start the actual backend',async t=>{
  const reserved=http.createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));
  const client=new Client({name:'glasses-offline-review',version:'0.2.0'});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{...process.env,GLASSES_URL:`http://127.0.0.1:${port}`},stderr:'pipe'}));
  const result=await client.callTool({name:'glasses_search',arguments:{query:'no backend'}});assert.equal(result.isError,true);assert.match(result.content[0].text,/Cannot reach Glasses/);assert.match(result.content[0].text,/Run npm start/);
});

test('MCP and website share research plan versions, preserved run queries and exact findings',async t=>{
  const discoveryFetcher=async url=>({url,body:JSON.stringify(url.includes('directory.json')?{registries:[]}:url.includes('api.github.com')?{items:[{html_url:'https://github.com/synthetic/research-memory',full_name:'synthetic/research-memory',name:'research-memory',description:'Synthetic memory candidate for integration test',license:{spdx_id:'MIT'}}]}:{items:[]})});
  const {api,mcp}=await appFor(t,{discoveryFetcher});const client=await mcp();
  async function call(name,args={}){const response=await client.callTool({name,arguments:args});assert.ok(!response.isError,response.content[0].text);return JSON.parse(response.content[0].text)}
  const {plan}=await call('glasses_save_research_plan',{name:'Memory tools',query:'agent memory',enabled:false});
  assert.equal((await api('/api/research/plans')).data.items[0].id,plan.id);
  const edited=await api('/api/research/plans/'+plan.id,'PUT',{query:'local memory',expectedVersion:plan.version});assert.equal(edited.status,200);
  const conflict=await client.callTool({name:'glasses_save_research_plan',arguments:{id:plan.id,name:'Stale name',expectedVersion:plan.version}});assert.equal(conflict.isError,true);
  const listed=await call('glasses_research_plans');assert.equal(listed.items[0].query,'local memory');
  const run=await call('glasses_run_research_plan',{id:plan.id});assert.equal(run.planSnapshot.query,'local memory');assert.equal(run.planSnapshot.enabled,false);
  await call('glasses_save_research_plan',{id:plan.id,query:'deployment tools',expectedVersion:edited.data.plan.version});
  const history=await call('glasses_research_runs',{planId:plan.id});assert.equal(history.items[0].id,run.id);
  const detail=await call('glasses_research_runs',{id:run.id});assert.equal(detail.run.query,'local memory');assert.deepEqual(detail.findings.items.map(item=>item.id).sort(),run.candidateIds.slice().sort());assert.equal(detail.findings.items.length,1);
  assert.deepEqual((await api('/api/catalog?runId='+run.id)).data.items.map(item=>item.id),run.candidateIds);
});
