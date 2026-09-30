import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createPublicCatalogue,withPublicCatalogueItems} from '../src/public-catalogue.mjs';
import {startServer} from '../src/server.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),id=v=>sha(v).slice(0,20),at='2026-09-30T00:00:00.000Z';
const revision='a'.repeat(40),url='https://github.com/example/skills/blob/main/plan/SKILL.md',raw=`https://raw.githubusercontent.com/example/skills/${revision}/plan/SKILL.md`,body='---\nname: plan\ndescription: Plan a bounded implementation.\n---\n# Plan\nThis fixture is untrusted instructions, not executed.\n';
function pack(sourceHash=sha(body),sourceUrl=`https://github.com/example/skills/blob/${revision}/plan/SKILL.md`){const fields={endpoint:raw,recordUrl:url,sha256:sourceHash},ref={id:id(JSON.stringify(fields)),...fields,observedAt:at,kind:'github-artifact-document'};const row={id:id(url),url,name:'plan',description:'Plan a bounded implementation.',kind:'pattern',provider:'example/skills',tags:['planning'],framework:null,license:{spdx:'MIT',status:'known',scope:'source-artifact',basis:'source-declaration'},github:null,observedAt:at,citations:[ref],assessment:null,details:{resourceType:'skill',sourceUrl,citationIds:[ref.id]}};return withPublicCatalogueItems(createPublicCatalogue({capabilities:[],evidence:[]}).snapshot,[row]);}

test('actual local MCP reads exact pinned skill bytes only when requested, without execution or model calls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'glasses-guidance-'));let app,client;const calls=[];
 try{app=await startServer({port:0,dataDir:dir,seed:false,autoScout:false,discoveryFetcher:async endpoint=>{calls.push(endpoint);assert.equal(endpoint,raw);return{url:endpoint,body,status:200,contentType:'text/markdown',fetchedAt:at};}});await app.store.importPublicCatalogue(pack());
 client=new Client({name:'guidance-source-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp.mjs'],cwd:resolve('.'),env:{...process.env,GLASSES_URL:app.url},stderr:'pipe'}));
 const invoke=async arguments_=>{const r=await client.callTool({name:'glasses_inspect',arguments:arguments_});assert.notEqual(r.isError,true);return JSON.parse(r.content[0].text);};
 assert.equal((await invoke({id:id(url),fetchSource:false})).item.guidanceSource,undefined);assert.equal(calls.length,0);
 const source=(await invoke({id:id(url),fetchSource:true})).item;assert.equal(source.guidanceSource.content,body);assert.equal(source.guidanceSource.sha256,sha(body));assert.match(source.guidanceNotice,/No instructions were executed/);assert.deepEqual(calls,[raw]);assert.equal(app.store.workspaces().length,0);assert.equal(app.intelligence.listJobs().total,0);
 }finally{await client?.close();await app?.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('unpinned guidance is refused before fetch and changed bytes fail hash verification',async()=>{
 for(const bad of ['unpinned','hash']){const dir=await mkdtemp(join(tmpdir(),'glasses-guidance-bad-'));let app;let calls=0;try{app=await startServer({port:0,dataDir:dir,seed:false,autoScout:false,discoveryFetcher:async endpoint=>{calls++;return{url:endpoint,body,status:200,fetchedAt:at};}});await app.store.importPublicCatalogue(pack(bad==='hash'?'0'.repeat(64):sha(body),bad==='unpinned'?url:undefined));const result=await app.discovery.inspect(id(url),{fetchSource:true});assert.equal(result.guidanceSource,undefined);assert.match(result.sourceError,bad==='hash'?/differ.*hash/:/pinned/);assert.equal(calls,bad==='hash'?1:0);}finally{await app?.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}}
});
