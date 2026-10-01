import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../src/server.mjs';
import {createPublicCatalogue,publicCatalogueEvidenceIds} from '../src/public-catalogue.mjs';

test('real local MCP creates and resumes a typed bulk plan; source bytes stay behind explicit evidence and discovery consumes no inference',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-bulk-api-'));let app,client;let calls=0;
  try{
    const providers={status:async()=>({codex:{available:false},jev:{configured:false}}),classify:async()=>{calls++;throw Error('Unexpected model call');},plan:async()=>{throw Error('Unexpected plan');},rank:async()=>{throw Error('Unexpected rank');}};
    app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,providers,discoveryFetcher:async url=>({url,status:200,contentType:'text/html',body:'<title>Source guide</title><meta name="description" content="Documentation for adopting existing tools."><body>RAW_BODY_ONLY_IN_EVIDENCE</body>'})});
    client=new Client({name:'bulk-fixture',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp.mjs'],env:{...process.env,GLASSES_URL:app.url},stderr:'pipe'}));
    const call=async(name,args)=>{const response=await client.callTool({name,arguments:args});assert.ok(!response.isError,response.content[0].text);return JSON.parse(response.content[0].text);};
    const created=await call('glasses_bulk_scan',{action:'create',plan:{name:'Reference fixture',lanes:[{resourceType:'reference',limit:2,sources:[{adapter:'public-reference',url:'https://example.org/guide'}]}],maxCandidates:2}});
    await call('glasses_bulk_scan',{action:'run',id:created.plan.id,maxSteps:1});
    const settle=async()=>{for(let count=0;count<100;count++){const {plan}=await call('glasses_bulk_scan',{action:'status',id:created.plan.id});if(plan.status!=='running')return plan;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Batch did not settle');};
    assert.equal((await settle()).status,'paused');await call('glasses_bulk_scan',{action:'run',id:created.plan.id,maxSteps:5});const done=await settle();assert.equal(done.status,'completed');assert.equal(done.stats.added,1);assert.equal(calls,0);
    const search=await call('glasses_search',{query:'',resourceType:'reference'});assert.equal(search.total,1);assert.doesNotMatch(JSON.stringify(search),/RAW_BODY_ONLY_IN_EVIDENCE/);assert.equal(search.items[0].details.resourceType,'reference');
    const empty=await call('glasses_search',{query:'',hasPreview:true});assert.equal(empty.total,0);
    const capabilities=app.store.search(),evidence=publicCatalogueEvidenceIds(capabilities).map(id=>app.store.getEvidence(id)),pack=createPublicCatalogue({capabilities,evidence}).snapshot;
    assert.equal(pack.items[0].license.status,'unknown');assert.equal(pack.items[0].citations[0].kind,'public-page-metadata');assert.doesNotMatch(JSON.stringify(pack),/RAW_BODY_ONLY_IN_EVIDENCE/);
    const {token}=await (await fetch(app.url+'/api/session')).json();const request=(path,method,body)=>fetch(app.url+path,{method,headers:{'X-Glasses-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal((await fetch(app.url+'/api/bulk-scans')).status,401);
    assert.equal((await request('/api/catalog?hasPreview=maybe','GET')).status,400);
    const settings=await (await request('/api/intelligence/settings','PUT',{maxJobsPerDay:200,jevDailyBudgetUsd:0})).json();assert.equal(settings.settings.maxJobsPerDay,200);assert.equal(settings.settings.jevDailyBudgetUsd,0);
    const upper=await (await request('/api/intelligence/settings','PUT',{maxJobsPerDay:5000})).json();assert.equal(upper.settings.maxJobsPerDay,5000);assert.equal(upper.settings.jevDailyBudgetUsd,0);
    assert.equal((await request('/api/intelligence/settings','PUT',{maxJobsPerDay:5001})).status,400);
    const page=await fetch(app.url+'/');assert.match(page.headers.get('content-security-policy'),/img-src 'self' data: https:\/\/lcfr\.ai\/glasses\/previews\//);assert.doesNotMatch(page.headers.get('content-security-policy'),/img-src[^;]*https:;/);
  }finally{await client?.close();await app?.close();await rm(directory,{recursive:true,force:true});}
});

test('bulk API returns a durable-lease rejection before 202 and the real CLI authenticates read-only status',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-bulk-start-'));let app,calls=0;
  try{
    const providers={status:async()=>({codex:{available:false},jev:{configured:false}}),classify:async()=>{calls++;throw Error('Unexpected model call');},plan:async()=>{throw Error('Unexpected plan');},rank:async()=>{throw Error('Unexpected rank');}};
    app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,providers,discoveryFetcher:async()=>{calls++;throw Error('Unexpected source fetch');}});
    const {token}=await (await fetch(app.url+'/api/session')).json(),request=(path,body)=>fetch(app.url+path,{method:'POST',headers:{'X-Glasses-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const created=await request('/api/bulk-scans',{name:'Blocked fixture',maxCandidates:1,lanes:[{resourceType:'reference',sources:[{adapter:'public-reference',url:'https://example.org/guide'}]}]});assert.equal(created.status,201);const {plan}=await created.json();
    assert.equal(app.store.acquireSettingLease('bulkDiscoveryLease',{id:'test-other-worker',expiresAt:new Date(Date.now()+30000).toISOString()}),true);
    const blocked=await request('/api/bulk-scans/'+plan.id+'/run',{maxSteps:1});assert.equal(blocked.status,409);assert.match((await blocked.json()).error,/durable lease/);assert.equal(app.store.getSetting('bulkDiscoveryPlan:'+plan.id).status,'ready');app.store.releaseSettingLease('bulkDiscoveryLease','test-other-worker');
    assert.equal((await request('/api/bulk-scans/'+plan.id+'/run',{maxSteps:201})).status,400);
    const {stdout,stderr}=await promisify(execFile)(process.execPath,['scripts/bulk-scan.mjs','--status','--url='+app.url],{windowsHide:true,timeout:15000,maxBuffer:1024*1024}),status=JSON.parse(stdout);assert.equal(status.plans.length,1);assert.equal(status.plans[0].id,plan.id);assert.equal(status.modelCalls,false);assert.equal(status.publication,false);assert.ok(!stdout.includes(token));assert.equal(stderr,'');assert.equal(calls,0);
  }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});
