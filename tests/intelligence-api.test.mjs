import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../src/server.mjs';

function fixtureProviders(){
  let key=null,calls=0;const payloads=[];
  return {payloads,get calls(){return calls;},
    async status(){return {codex:{configured:true,available:true,authenticated:true,model:'fixture-codex-v1'},jev:{configured:!!key,model:'jev-1.13.0',storage:'synthetic-memory'}};},
    async saveJevKey(value){key=value;},async removeJevKey(){key=null;},async test(provider){return {ok:true,provider,inference:false,message:'Synthetic authentication check'};},
    async classify(provider,{cards,signal}){signal?.throwIfAborted();calls++;payloads.push(cards);return {model:provider==='jev'?'jev-1.13.0':'fixture-codex-v1',usage:{inputTokens:100,outputTokens:20,costUsd:0.0000042},results:cards.map(card=>({id:card.id,artifact:'agent-extension',adoption:'configure-agent',capabilities:['longterm-conventions'],confidence:0.93,evidenceIds:card.evidenceIds}))};},
    async plan(){return {queries:['agent memory'],urls:[],model:'fixture-codex-v1',usage:{inputTokens:10,outputTokens:10}};},
    async rank(provider,{cards}){return {results:cards.map((card,index)=>({id:card.id,score:1-index/100})),model:provider==='jev'?'jev-1.13.0':'fixture-codex-v1',usage:{inputTokens:10,outputTokens:10}};}
  };
}
async function request(app,path,method='GET',body){const {token}=await (await fetch(app.url+'/api/session')).json();const response=await fetch(app.url+path,{method,headers:{'X-Glasses-Token':token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
async function settled(app,id){for(let n=0;n<100;n++){const job=(await request(app,'/api/intelligence/jobs/'+id)).data.job;if(!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Synthetic job did not settle');}
function publicCandidate(app){const evidence=app.store.retainEvidence({url:'https://example.org/public-memory',body:'Public fixture: an agent extension captures project conventions and supports deletion.'});return {evidence,item:app.store.upsertCapability({url:'https://example.org/public-memory',name:'Public memory fixture',description:'A memory extension',kind:'solution',origin:'live',tags:['memory'],metadataEvidence:evidence}).item};}

test('connections, async classification, cache, corrections and evidence remain aligned through HTTP and restart',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'glasses-intelligence-api-')),providers=fixtureProviders();let app;
  try{
    app=await startServer({port:0,dataDir,seed:false,autoScout:false,providers});const {item}=publicCandidate(app);
    app.store.recordOutcome({capabilityId:item.id,result:'worked',notes:'PRIVATE_OUTCOME_MUST_STAY_LOCAL'});
    assert.equal((await request(app,'/api/connections/jev','POST',{apiKey:'SYNTHETIC_SECRET_NEVER_ECHO'})).status,200);
    const state=(await request(app,'/api/intelligence')).data;assert.equal(state.connections.jev.configured,true);assert.doesNotMatch(JSON.stringify(state),/SYNTHETIC_SECRET/);
    assert.equal((await request(app,'/api/connections/jev/test','POST',{})).data.result.inference,false);
    await request(app,'/api/intelligence/settings','PUT',{provider:'jev',maxJobsPerDay:10});
    const started=await request(app,'/api/intelligence/jobs','POST',{type:'classify',candidateIds:[item.id]});assert.equal(started.status,202);
    const first=await settled(app,started.data.job.id);assert.equal(first.status,'completed',JSON.stringify(first));assert.equal(providers.calls,1);
    assert.doesNotMatch(JSON.stringify(providers.payloads),/PRIVATE_OUTCOME|SYNTHETIC_SECRET/);
    assert.equal((await request(app,`/api/catalog/${item.id}`)).data.item.licenseStatus,'unknown');
    const again=await request(app,'/api/intelligence/jobs','POST',{type:'classify',candidateIds:[item.id]});await settled(app,again.data.job.id);assert.equal(providers.calls,1,'unchanged evidence costs no additional inference');
    const inferred=await request(app,'/api/catalog?q=longterm-conventions&artifact=agent-extension');assert.equal(inferred.data.items[0].id,item.id);
    assert.equal((await request(app,'/api/catalog?assessmentStatus=classified')).data.total,1);
    assert.equal((await request(app,'/api/catalog?assessmentStatus=unclassified')).data.total,0);
    assert.equal((await request(app,'/api/catalog?assessmentStatus=unsupported')).status,400);
    const correction=await request(app,`/api/catalog/${item.id}/assessment`,'PUT',{artifact:'whole-product',notes:'Synthetic user correction'});assert.equal(correction.data.assessment.humanCorrected,true);
    assert.equal((await request(app,'/api/catalog?assessmentStatus=corrected')).data.items[0].id,item.id);
    assert.equal((await request(app,`/api/catalog/${item.id}/assessment`,'PUT',{license:'MIT'})).status,400);
    const snapshot=app.store.retainEvidence({url:item.url,body:'Changed upstream fixture now includes an export workflow.'});app.store.upsertCapability({...app.store.getCapability(item.id),metadataEvidence:snapshot});
    const stale=(await request(app,`/api/catalog/${item.id}/assessment`)).data.assessment;assert.equal(stale.stale,true);assert.equal(stale.artifact,'whole-product');
    assert.equal((await request(app,'/api/catalog?assessmentStatus=stale')).data.items[0].id,item.id);
    assert.equal((await request(app,'/api/catalog?assessmentStatus=corrected')).data.total,0);
    await app.close();app=null;app=await startServer({port:0,dataDir,seed:false,autoScout:false,providers});
    assert.equal((await request(app,`/api/catalog/${item.id}/assessment`)).data.assessment.correction.notes,'Synthetic user correction');
    assert.equal((await request(app,'/api/intelligence/jobs')).data.total,2);
    const removed=await request(app,'/api/connections/jev','DELETE');assert.equal(removed.data.connections.jev.configured,false);
    assert.equal((await request(app,'/api/intelligence/settings','PUT',{apiKey:'not-a-setting'})).status,400);
  }finally{if(app)await app.close();await rm(dataDir,{recursive:true,force:true});}
});

test('MCP can submit evidence-grounded assessment and start/read real processing jobs without exposing key management',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'glasses-intelligence-mcp-'));let app,client,transport;
  try{
    app=await startServer({port:0,dataDir,seed:false,autoScout:false,providers:fixtureProviders()});const {item,evidence}=publicCandidate(app);
    transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{...process.env,GLASSES_URL:app.url},stderr:'pipe'});client=new Client({name:'processing-contract-test',version:'1'});await client.connect(transport);
    const names=(await client.listTools()).tools.map(x=>x.name);assert.ok(names.includes('glasses_start_processing'));assert.ok(!names.some(x=>/key|secret/.test(x)));
    const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
    const assessed=await call('glasses_assessment',{id:item.id,assessment:{artifact:'agent-extension',adoption:'configure-agent',capabilities:['recall'],confidence:0.8,evidenceIds:[evidence.id]}});assert.equal(assessed.assessment.provider,'agent');
    assert.equal((await call('glasses_search',{query:'',assessmentStatus:'classified'})).items[0].id,item.id);
    assert.equal((await call('glasses_search',{query:'',assessmentStatus:'needs-review'})).total,0);
    const started=await call('glasses_start_processing',{type:'rank',query:'agent memory',candidateIds:[item.id]});await settled(app,started.job.id);
    const job=(await call('glasses_processing_job',{id:started.job.id})).job;assert.equal(job.status,'completed');assert.equal(job.result.rankings[0].id,item.id);
    const status=await call('glasses_processing_status');assert.equal(status.connections.codex.authenticated,true);
  }finally{if(client)await client.close();else if(transport)await transport.close();if(app)await app.close();await rm(dataDir,{recursive:true,force:true});}
});
