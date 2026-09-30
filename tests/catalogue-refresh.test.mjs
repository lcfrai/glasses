import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createStore} from '../src/store.mjs';
import {createDiscovery} from '../src/discovery.mjs';
import {createCatalogueRefresh,REFRESH_DEFAULTS,validateRefreshSettings} from '../src/catalogue-refresh.mjs';
import {startServer} from '../src/server.mjs';

const now=Date.parse('2030-01-10T00:00:00.000Z'),old='2030-01-01T00:00:00.000Z';
const repoURL=name=>`https://github.com/refresh-fixture/${name}`;
const endpoint=name=>`https://api.github.com/repos/refresh-fixture/${name}`;
const response=(url,data)=>({url,status:200,contentType:'application/json',body:JSON.stringify(data)});
const metadata=(name,overrides={})=>({name,full_name:`refresh-fixture/${name}`,html_url:repoURL(name),description:'A deployable document editing application.',topics:['documents'],private:false,fork:false,disabled:false,archived:false,stargazers_count:1500,default_branch:'main',license:{spdx_id:'MIT'},...overrides});
const source=(resource,content)=>({path:resource==='license'?'LICENSE':'README.md',encoding:'base64',content:Buffer.from(content).toString('base64'),...(resource==='license'?{license:{spdx_id:'MIT'}}:{})});
function responder({calls=[],overrides={},revision='a'.repeat(40),fail}={}){
  return async url=>{
    calls.push(url);if(fail)await fail(url);
    const match=url.match(/^https:\/\/api.github.com\/repos\/refresh-fixture\/([^/?]+)(.*)$/);assert.ok(match,`Unexpected fixture request ${url}`);
    const [,name,suffix]=match;
    if(!suffix)return response(url,metadata(name,overrides));
    if(suffix==='/commits/main')return response(url,{sha:revision});
    for(const resource of ['license','readme'])if(suffix===`/${resource}?ref=${revision}`)return response(url,source(resource,resource==='license'?'MIT fixture licence':`# ${name}\nA document editor at revision ${revision}.`));
    throw new Error(`Unexpected fixture request ${url}`);
  };
}
async function fixture(t,fetcher){
  const directory=await mkdtemp(join(tmpdir(),'glasses-refresh-')),store=createStore(directory);
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const discovery=createDiscovery({store,fetcher:fetcher||responder()});
  return{directory,store,discovery,refresh:createCatalogueRefresh({store,discovery,clock:()=>now})};
}
function insert(store,name,overrides={}){
  return store.upsertCapability({url:repoURL(name),name,kind:'solution',provider:'GitHub',origin:'live',description:'Old description',tags:['old'],github:{stars:1000,defaultBranch:'main',fork:false,disabled:false,starsFetchedAt:old},metadataEvidence:{lastFetchedAt:old},...overrides}).item;
}

test('refresh settings are bounded, partial configuration persists, and unrelated local settings survive',async t=>{
  const {store,refresh}=await fixture(t);store.setSetting('intelligence',{dailyBudgetUsd:9,autoClassify:false});
  assert.deepEqual(refresh.status().settings,REFRESH_DEFAULTS);
  refresh.configure({batchSize:3});refresh.configure({enabled:false,minAgeHours:96});
  assert.deepEqual(createCatalogueRefresh({store,discovery:{},clock:()=>now}).status().settings,{enabled:false,minAgeHours:96,batchSize:3});
  for(const input of [null,[],{unknown:true},{enabled:1},{batchSize:0},{batchSize:31},{batchSize:1.5},{minAgeHours:23},{minAgeHours:2161}])assert.throws(()=>validateRefreshSettings(input),error=>error.status===400);
  assert.deepEqual(store.getSetting('intelligence'),{dailyBudgetUsd:9,autoClassify:false});
  const item=insert(store,'manual');assert.equal(await refresh.run({trigger:'scheduled'}),null);
  assert.equal((await refresh.run({ids:[item.id]})).updated,1,'Pausing scheduled refresh does not prevent an explicit manual refresh');
});

test('oldest due repositories are selected first, with stars breaking ties and fresh/non-live sources excluded',async t=>{
  const {store}=await fixture(t),calls=[];
  const oldest=insert(store,'oldest',{metadataEvidence:{lastFetchedAt:'2029-12-01T00:00:00.000Z'},github:{stars:1001}});
  const popular=insert(store,'popular',{github:{stars:50000}}),lessPopular=insert(store,'ordinary',{github:{stars:1002}});
  insert(store,'fresh',{sourceState:{checkedAt:'2030-01-09T00:00:00.000Z'}});
  insert(store,'previously-checked',{refreshState:{checkedAt:'2030-01-09T00:00:00.000Z'}});
  insert(store,'sample',{origin:'sample'});insert(store,'registry',{url:'https://registry.directory/sample/ui/item'});
  const refresh=createCatalogueRefresh({store,clock:()=>now,discovery:{scouting:false,inspect:async(id,options)=>{calls.push({id,options});return{...store.getCapability(id),sourceState:{status:'ok'}};}}});
  refresh.configure({batchSize:2});assert.equal(refresh.status().due,3);
  const run=await refresh.run({trigger:'scheduled'});
  assert.deepEqual(run.candidateIds,[oldest.id,popular.id]);assert.deepEqual(calls.map(x=>x.options),[{refreshSource:true},{refreshSource:true}]);
  assert.equal(run.updated,2);assert.equal(run.added,0);assert.equal(refresh.status().due,1);
  assert.equal((await refresh.run()).candidateIds[0],lessPopular.id);
});

test('real discovery refresh replaces public metadata/stars and pinned source while preserving identity and local work',async t=>{
  let revision='a'.repeat(40),stars=1500;const calls=[];
  const {store,discovery,refresh}=await fixture(t,async url=>responder({calls,revision,overrides:{stargazers_count:stars,description:`Document editor ${stars}`,topics:['document-editing','collaboration']}})(url));
  const original=await discovery.importUrl(repoURL('writer'));
  store.upsertCapability({...original,privateNotes:'Keep this local note'});
  store.recordOutcome({capabilityId:original.id,result:'worked',notes:'Local verification remains private'});
  const outcomes=store.outcomes(original.id),beforeEvidence=original.metadataEvidence.id;
  const workspace=store.createWorkspace({title:'Private work',capabilityId:original.id,source:'export default ()=> <div>Private work</div>'});
  revision='b'.repeat(40);stars=1900;calls.length=0;
  const run=await refresh.run({ids:[original.id]}),item=store.getCapability(original.id);
  assert.equal(run.status,'completed');assert.equal(run.entries[0].previousStars,1500);assert.equal(run.entries[0].stars,1900);
  assert.equal(run.entries[0].metadataChanged,true);assert.equal(run.entries[0].sourceChanged,true);
  assert.equal(item.id,original.id);assert.equal(item.kind,original.kind);assert.equal(item.github.stars,1900);assert.equal(item.description,'Document editor 1900');
  assert.deepEqual(item.tags,['document-editing','collaboration']);assert.notEqual(item.metadataEvidence.id,beforeEvidence);
  assert.equal(JSON.parse(store.getEvidence(item.metadataEvidence.id).body).stargazers_count,1900);
  assert.equal(item.provenance.resolvedRevision,revision);assert.equal(item.licenseEvidence.revision,revision);
  assert.deepEqual(calls,[endpoint('writer'),endpoint('writer')+'/commits/main',endpoint('writer')+`/license?ref=${revision}`,endpoint('writer')+`/readme?ref=${revision}`]);
  assert.equal(item.privateNotes,'Keep this local note');assert.deepEqual(store.outcomes(original.id),outcomes);assert.deepEqual(store.getWorkspace(workspace.id),workspace);
  assert.equal(store.counts().total,1);assert.equal(store.getSetting('catalogueRefreshLastRun').processed,1);
});

test('metadata throttling stops the bounded batch, retains old source, and leaves unprocessed entries due',async t=>{
  const calls=[],{store,refresh}=await fixture(t,responder({calls,fail:async()=>{throw new Error('HTTP 429 from api.github.com');}}));
  const first=insert(store,'one',{repositoryFiles:[{path:'README.md',content:'Retained old source'}]}),second=insert(store,'two');
  const run=await refresh.run({ids:[first.id,second.id]});
  assert.equal(run.status,'partial');assert.equal(run.updated,0);assert.equal(run.entries.length,1);assert.match(run.errors.join(' '),/throttling/);
  assert.deepEqual(calls,[endpoint('one')]);assert.equal(store.getCapability(first.id).repositoryFiles[0].content,'Retained old source');
  assert.equal(store.getCapability(second.id).refreshState,undefined);assert.equal(refresh.status().due,1);assert.equal(refresh.running,false);
});

test('partial pinned README throttling is a partial run and prevents starting the next repository',async t=>{
  const calls=[],{store,refresh}=await fixture(t,responder({calls,fail:async url=>{if(url.includes('/readme?'))throw new Error('HTTP 429 from api.github.com');}}));
  const first=insert(store,'one'),second=insert(store,'two');
  const run=await refresh.run({ids:[first.id,second.id]});
  assert.equal(run.entries[0].status,'partial');assert.equal(run.status,'partial');assert.equal(run.entries.length,1);
  assert.match(run.errors.join(' '),/HTTP 429/);assert.ok(!calls.includes(endpoint('two')));
  assert.equal(store.getCapability(second.id).refreshState,undefined);assert.equal(refresh.status().due,1);
});

test('a changed or non-public metadata identity is rejected without replacing the existing repository facts',async t=>{
  for(const overrides of [{private:true},{html_url:repoURL('renamed')}]){
    const calls=[],{store,refresh}=await fixture(t,responder({calls,overrides}));const original=insert(store,'writer');
    const run=await refresh.run({ids:[original.id]}),item=store.getCapability(original.id);
    assert.equal(run.status,'partial');assert.equal(item.github.stars,original.github.stars);assert.equal(item.url,original.url);
    assert.equal(item.description,original.description);assert.deepEqual(calls,[endpoint('writer')]);assert.match(item.sourceError,/matching public metadata/);
  }
});

test('refresh excludes overlapping work, rejects invalid IDs, and shutdown waits for an active source request',async t=>{
  const {store}=await fixture(t);const one=insert(store,'one'),two=insert(store,'two');
  let unblock,started;const blocked=new Promise(resolve=>{unblock=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const discovery={scouting:false,inspect:async id=>{started();await blocked;return{...store.getCapability(id),sourceState:{status:'ok'}};}};
  const refresh=createCatalogueRefresh({store,discovery,clock:()=>now});
  for(const ids of [[],[one.id,one.id],['missing'],Array(31).fill(one.id)])await assert.rejects(refresh.run({ids}),error=>error.status===400);
  discovery.scouting=true;await assert.rejects(refresh.run(),error=>error.status===409);discovery.scouting=false;
  const running=refresh.run({ids:[one.id,two.id]});await entered;assert.equal(refresh.running,true);
  await assert.rejects(refresh.run(),error=>error.status===409);let closed=false;const closing=refresh.close().then(()=>{closed=true;});
  await Promise.resolve();assert.equal(closed,false);unblock();const result=await running;await closing;
  assert.equal(result.entries.length,1);assert.equal(result.status,'partial');assert.equal(refresh.running,false);assert.equal(closed,true);
  assert.equal(store.getCapability(two.id).refreshState,undefined);await assert.rejects(refresh.run(),error=>error.status===409);
});

test('failure of the initial run write releases the refresh guard so a recoverable storage failure can be retried',async t=>{
  const {store,discovery}=await fixture(t);const item=insert(store,'writer');let fail=true;
  const wrapped={...store,saveRun:run=>{if(fail){fail=false;throw new Error('Synthetic disk write failure');}return store.saveRun(run);}};
  const refresh=createCatalogueRefresh({store:wrapped,discovery,clock:()=>now});
  await assert.rejects(refresh.run({ids:[item.id]}),/Synthetic disk write failure/);assert.equal(refresh.running,false);
  assert.equal((await refresh.run({ids:[item.id]})).status,'completed');
});

test('actual local MCP refresh actions enforce settings/ID boundaries and execute the source refresh without inference',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-refresh-mcp-'));let app,client,transport,inferenceCalls=0;const calls=[];
  const forbidden=async()=>{inferenceCalls++;throw new Error('Unexpected inference');};
  try{
    app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,discoveryFetcher:responder({calls}),providers:{status:async()=>({}),classify:forbidden,plan:forbidden,rank:forbidden}});
    app.intelligence.updateSettings({autoClassify:false});const item=insert(app.store,'writer');
    transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{GLASSES_URL:app.url,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stderr:'pipe'});
    client=new Client({name:'refresh-contract',version:'1'});await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool=>tool.name==='glasses_refresh_catalogue'));
    const call=async args=>{const result=await client.callTool({name:'glasses_refresh_catalogue',arguments:args});assert.notEqual(result.isError,true,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
    assert.deepEqual((await call({action:'configure',settings:{enabled:false,batchSize:2}})).settings,{enabled:false,minAgeHours:72,batchSize:2});
    assert.equal((await call({action:'status'})).running,false);
    for(const args of [{action:'status',ids:[item.id]},{action:'run',settings:{}},{action:'configure',settings:{batchSize:31}},{action:'run',ids:['missing']}]){
      const result=await client.callTool({name:'glasses_refresh_catalogue',arguments:args});assert.equal(result.isError,true,JSON.stringify(args));
    }
    const result=await call({action:'run',ids:[item.id]});assert.equal(result.run.updated,1);assert.equal(result.run.status,'completed');
    assert.equal(app.store.getCapability(item.id).github.stars,1500);assert.equal(calls.length,4);assert.equal(inferenceCalls,0);assert.equal(app.intelligence.listJobs().total,0);
  }finally{if(client)await client.close();else if(transport)await transport.close();if(app)await app.close();await rm(directory,{recursive:true,force:true});}
});

test('authenticated manual scout and saved-plan routes reject overlap with an active refresh before fetching',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-refresh-overlap-'));let app,release,notify;
  const barrier=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{notify=resolve;}),calls=[];
  try{
    const forbidden=async()=>{throw new Error('Unexpected inference');};
    app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,providers:{status:async()=>({}),classify:forbidden,plan:forbidden,rank:forbidden},discoveryFetcher:responder({calls,fail:async url=>{if(url===endpoint('writer')){notify();await barrier;}}})});
    const item=insert(app.store,'writer'),active=app.refresh.run({ids:[item.id]});await entered;
    const token=(await(await fetch(app.url+'/api/session')).json()).token;
    const post=async(path,body)=>fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Glasses-Token':token},body:JSON.stringify(body)});
    for(const [path,body] of [['/api/scout',{query:'document editor'}],['/api/research/plans/missing/run',{}]]){
      const result=await post(path,body);assert.equal(result.status,409,path);assert.match((await result.json()).error,/refresh is running/);
    }
    assert.deepEqual(calls,[endpoint('writer')]);release();assert.equal((await active).status,'completed');
  }finally{release?.();if(app)await app.close();await rm(directory,{recursive:true,force:true,maxRetries:6,retryDelay:50});}
});
