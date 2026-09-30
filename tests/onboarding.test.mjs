import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, stableId } from '../src/store.mjs';
import { createPublicCatalogue } from '../src/public-catalogue.mjs';
import { createOnboarding, SHARED_CATALOGUE_URL } from '../src/onboarding.mjs';
import { startServer } from '../src/server.mjs';
import { runCatalogueSetup, catalogueOptions } from '../scripts/catalogue-setup.mjs';

function pack() {
  const url='https://public-ui.example/r/button.json',body=JSON.stringify({name:'public-button',description:'Synthetic public button',license:'MIT',files:[{path:'button.tsx',content:'export default ()=>null'}]}),sha256=createHash('sha256').update(body).digest('hex');
  const evidence={id:stableId(`${url}\n${sha256}`),url,body,sha256,status:200,firstFetchedAt:'2026-09-29T00:00:00.000Z'};
  return createPublicCatalogue({capabilities:[{url,origin:'live',sourceDocumentEvidence:evidence}],evidence:[evidence],generatedAt:'2026-09-29T00:00:00.000Z'}).snapshot;
}
async function fixture(fn) {
  const directory=await mkdtemp(join(tmpdir(),'glasses-onboarding-')),store=createStore(directory);let engine;
  try { await fn({directory,store,create:options=>(engine=createOnboarding({store,...options}))}); }
  finally { await engine?.close();store.close();await rm(directory,{recursive:true,force:true}); }
}
const providerStub={status:async()=>({}),classify:async()=>{throw Error('No inference allowed');},plan:async()=>{throw Error('No inference allowed');},rank:async()=>{throw Error('No inference allowed');}};

test('pending, decline, restart and status make no shared request; later explicit approval imports',async()=>{
  await fixture(async({store,create})=>{
    let requests=0;const engine=create({fetchImpl:async(url,options)=>{requests++;assert.equal(url,SHARED_CATALOGUE_URL);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return new Response(JSON.stringify(pack()));}});
    assert.equal(engine.status().choice,'pending');assert.equal(requests,0);
    await assert.rejects(engine.importLatest({approved:false}));await assert.rejects(engine.choose({choice:'import',url:'https://other.example'}));
    assert.equal((await engine.choose({choice:'decline'})).status,'declined');assert.equal(requests,0);await engine.close();
    const restarted=createOnboarding({store,fetchImpl:async()=>{requests++;return new Response(JSON.stringify(pack()));}});
    try { assert.equal(restarted.status().choice,'decline');assert.equal(requests,0);const done=await restarted.importLatest({approved:true});assert.equal(done.status,'ready');assert.equal(done.lastSuccess.report.added,1);assert.equal(requests,1);assert.equal(store.getCapability(pack().items[0].id).origin,'shared'); }
    finally { await restarted.close(); }
  });
});

test('repeat imports are idempotent and preserve source, local outcomes, workspaces and settings',async()=>{
  await fixture(async({store,create})=>{
    const snapshot=pack(),entry=snapshot.items[0];
    const local=store.upsertCapability({url:entry.url,name:'Local source label',kind:'component',origin:'live',sourceFiles:[{path:'local.tsx',content:'export default ()=>null'}]}).item;
    store.recordOutcome({capabilityId:local.id,result:'worked',notes:'Local observation'});
    const workspace=store.createWorkspace({capabilityId:local.id,source:'export default ()=>null'});store.setSetting('schedule',{enabled:false,intervalMinutes:120});
    const before=JSON.stringify({item:store.getCapability(local.id),outcomes:store.outcomes(local.id),workspace:store.getWorkspace(workspace.id),schedule:store.getSetting('schedule')});
    const engine=create({fetchImpl:async()=>new Response(JSON.stringify(snapshot))});const first=await engine.choose({choice:'import'}),repeat=await engine.importLatest({approved:true});
    assert.equal(first.lastSuccess.report.localOverrides,1);assert.equal(repeat.lastSuccess.report.unchanged,1);assert.equal(store.counts().total,1);
    assert.equal(JSON.stringify({item:store.getCapability(local.id),outcomes:store.outcomes(local.id),workspace:store.getWorkspace(workspace.id),schedule:store.getSetting('schedule')}),before);
  });
});

test('invalid, oversized and failed responses preserve previous success with an explicit retry',async()=>{
  await fixture(async({store,create})=>{
    let mode='good',requests=0;const snapshot=pack(),engine=create({maxBytes:10000,fetchImpl:async()=>{requests++;if(mode==='good')return new Response(JSON.stringify(snapshot));if(mode==='http')return new Response('not JSON',{status:503});if(mode==='large')return new Response('x'.repeat(10001));return new Response(JSON.stringify({...snapshot,contentHash:'0'.repeat(64)}));}});
    const imported=await engine.choose({choice:'import'});const original=JSON.stringify(store.getCapability(snapshot.items[0].id));
    for(const next of ['http','invalid','large']) {mode=next;await assert.rejects(engine.importLatest({approved:true}),error=>error.status===502&&error.onboarding.status==='failed');assert.equal(engine.status().lastSuccess.sha256,imported.lastSuccess.sha256);assert.equal(JSON.stringify(store.getCapability(snapshot.items[0].id)),original);}
    assert.equal(requests,4);engine.status();assert.equal(requests,4);mode='good';assert.equal((await engine.importLatest({approved:true})).status,'ready');
  });
});

test('deadline bounds a stalled download and close cancels an active import',async()=>{
  await fixture(async({create})=>{
    const engine=create({timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
    const keepAlive=setInterval(()=>{},1000);
    try {await assert.rejects(engine.choose({choice:'import'}),error=>error.status===502&&/cancelled|30 seconds/.test(error.message));assert.equal(engine.status().lastAttempt.status,'failed');}
    finally {clearInterval(keepAlive);}
    const pending=engine.importLatest({approved:true});await new Promise(resolve=>setTimeout(resolve,5));await engine.close();await assert.rejects(pending);assert.equal(engine.status().status,'failed');
  });
});

test('redirected URLs, declared oversized bodies and malformed schema never enter the catalogue',async()=>{
  await fixture(async({store,create})=>{
    let mode='redirect',requests=0,cancelled=0;
    const engine=create({maxBytes:10000,fetchImpl:async()=>{
      requests++;
      if(mode==='redirect'){const response=new Response(JSON.stringify(pack()));Object.defineProperty(response,'url',{value:'https://different.example/catalogue.json'});return response;}
      if(mode==='length')return new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-length':'10001'}});
      return new Response('{bad JSON');
    }});
    for(const next of ['redirect','length','invalid']){mode=next;await assert.rejects(engine.choose({choice:'import'}),error=>error.status===502);assert.equal(store.counts().total,0);}
    assert.equal(cancelled,1);assert.equal(requests,3);assert.equal(engine.status().choice,'import');assert.equal(engine.status().lastSuccess,null);
  });
});

test('independent clients share an atomic lease; expired interrupted attempt is visible and recoverable',async()=>{
  await fixture(async({directory,store,create})=>{
    let complete;const engine=create({fetchImpl:async()=>new Promise(resolve=>{complete=resolve;})});const pending=engine.choose({choice:'import'});
    await new Promise(resolve=>setImmediate(resolve));const otherStore=createStore(directory),other=createOnboarding({store:otherStore,fetchImpl:async()=>new Response(JSON.stringify(pack()))});
    try {assert.equal(other.status().importing,true);await assert.rejects(other.importLatest({approved:true}),error=>error.status===409);await assert.rejects(other.choose({choice:'decline'}),error=>error.status===409);complete(new Response(JSON.stringify(pack())));await pending;
      store.setSetting('catalogueImportLeaseV1',{id:'interrupted',expiresAt:'2020-01-01T00:00:00.000Z'});
      store.setSetting('catalogueOnboardingV1',{...engine.status(),lastAttempt:{id:'interrupted',status:'fetching',expiresAt:'2020-01-01T00:00:00.000Z'}});
      assert.equal(other.status().lastAttempt.status,'interrupted');assert.equal((await other.importLatest({approved:true})).status,'ready');
    }finally {await other.close();otherStore.close();}
  });
});

test('non-interactive setup never consents implicitly; explicit decline and fresh CLI readback persist',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-cli-'));let output='',requests=0;
  try {
    const result=await runCatalogueSetup({options:{dataDir:directory},input:{isTTY:false},output:{isTTY:false,write:value=>{output+=value;}},fetchImpl:async()=>{requests++;throw Error('Forbidden request');}});
    assert.equal(result.choice,'pending');assert.equal(requests,0);assert.match(output,/No interactive terminal/);
    const decline=spawnSync(process.execPath,['scripts/catalogue-setup.mjs','--catalogue=decline','--data-dir',directory],{encoding:'utf8'});assert.equal(decline.status,0,decline.stderr);
    const state=spawnSync(process.execPath,['scripts/catalogue-setup.mjs','--status','--data-dir',directory],{encoding:'utf8'});assert.equal(state.status,0,state.stderr);assert.equal(JSON.parse(state.stdout).onboarding.choice,'decline');
    assert.throws(()=>catalogueOptions(['--retry','--catalogue=decline']));assert.throws(()=>catalogueOptions(['--catalogue=maybe']));
  }finally {await rm(directory,{recursive:true,force:true});}
});

test('repository bootstrap runs from another working directory with decline and rejects conflicting actions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-bootstrap-'));
  try {
    const script=fileURLToPath(new URL('../scripts/setup.mjs',import.meta.url));
    const run=spawnSync(process.execPath,[script,'--no-build','--catalogue=decline','--data-dir',directory],{cwd:tmpdir(),encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/No agent configuration was changed/);
    const reopened=createStore(directory);assert.equal(reopened.getSetting('catalogueOnboardingV1').choice,'decline');assert.equal(reopened.counts().total,0);reopened.close();
    const bad=spawnSync(process.execPath,[script,'--no-build','--status','--retry'],{cwd:tmpdir(),encoding:'utf8'});
    assert.equal(bad.status,1);assert.match(bad.stderr,/only one catalogue action/);assert.doesNotMatch(bad.stdout,/Installing/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('authenticated API enforces explicit choice, exposes failed retry and imports without inference',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-setup-api-'));let app,requests=0,fail=false;
  try {
    app=await startServer({port:0,dataDir:directory,autoScout:false,seed:false,providers:providerStub,catalogueFetcher:async()=>{requests++;return fail?new Response('unavailable',{status:503}):new Response(JSON.stringify(pack()));}});
    const token=(await(await fetch(app.url+'/api/session')).json()).token;
    const request=async(path,body)=>{const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{'X-Glasses-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};};
    assert.equal((await request('/api/onboarding')).onboarding.status,'pending');assert.equal(requests,0);
    assert.equal((await fetch(app.url+'/api/onboarding')).status,401);assert.equal((await request('/api/onboarding/import',{})).status,400);assert.equal(requests,0);
    assert.equal((await request('/api/onboarding',{choice:'decline'})).onboarding.choice,'decline');assert.equal(requests,0);
    assert.equal((await request('/api/onboarding/import',{approved:true})).onboarding.lastSuccess.snapshot.counts.total,1);
    fail=true;const failed=await request('/api/onboarding/import',{approved:true});assert.equal(failed.status,502);assert.equal(failed.onboarding.status,'failed');assert.equal(failed.onboarding.lastSuccess.snapshot.counts.total,1);
    assert.equal(app.intelligence.listJobs().total,0);assert.equal(app.store.counts().total,1);assert.equal(requests,2);
  }finally {if(app)await app.close();await rm(directory,{recursive:true,force:true});}
});
