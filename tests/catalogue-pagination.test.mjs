import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.mjs';
import {createIntelligenceStore} from '../src/intelligence-store.mjs';

test('local catalogue paging bounds rows and metadata while preserving filtered order and legacy callers',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'glasses-catalogue-paging-'));
  let app,fixtureStore,calls=0;
  try{
    const deny=async()=>{calls++;throw Error('Unexpected external or inference request');};
    app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,discoveryFetcher:deny,providers:{status:async()=>({codex:{available:false},jev:{configured:false}}),classify:deny,rank:deny,plan:deny}});
    const rows=Array.from({length:140},(_,index)=>app.store.upsertCapability({url:`https://example.org/page/${index}`,name:`Paging fixture ${String(index).padStart(3,'0')}`,description:'Synthetic pagination regression.',kind:'solution',origin:index%2?'seed':'live'}).item);
    const ids=[...rows.map(row=>row.id),...Array.from({length:10000},(_,index)=>index.toString(16).padStart(20,'0'))];
    const run={id:'large-run-fixture',status:'completed',candidateIds:ids,query:'Synthetic source membership',errors:[],startedAt:new Date().toISOString()};app.store.saveRun(run);
    fixtureStore=createIntelligenceStore(directory);
    const job={id:'large-rank-fixture',type:'rank',status:'completed',candidateIds:ids,createdAt:new Date().toISOString(),result:{rankings:ids.map((id,index)=>({id,score:index<140?index/140:0,reason:'Synthetic ranking payload '.repeat(8)}))}};fixtureStore.save('jobs',job);
    const {token}=await(await fetch(app.url+'/api/session')).json();
    async function request(path){const response=await fetch(app.url+path,{headers:{'X-Glasses-Token':token}}),text=await response.text();return {status:response.status,data:JSON.parse(text),bytes:Buffer.byteLength(text)};}
    await t.test('large scan and ranking membership stays compact on each page; legacy metadata remains intact',async()=>{
      for(const [param,id,field,original] of [['runId',run.id,'run',run],['jobId',job.id,'job',job]]){
        const page=await request(`/api/catalog?${param}=${id}&limit=60&offset=60`);
        assert.equal(page.status,200);assert.equal(page.data.items.length,60);assert.equal(page.data.total,140);assert.equal(page.data.offset,60);assert.equal(page.data.nextOffset,120);
        assert.equal(page.data[field].id,id);assert.equal(page.data[field].candidateCount,ids.length);assert.equal(page.data[field].candidateIds,undefined);assert.equal(page.data[field].result,undefined);assert(page.bytes<150000,`Unbounded filtered page: ${page.bytes}`);
        const legacy=await request(`/api/catalog?${param}=${id}`);assert.equal(legacy.data.items.length,140);assert.deepEqual(legacy.data[field],original);
      }
    });
    await t.test('rank order is applied before paging and reveal selects its effective page',async()=>{
      const first=await request(`/api/catalog?jobId=${job.id}&limit=60&offset=0`),second=await request(`/api/catalog?jobId=${job.id}&limit=60&offset=60`);
      assert.deepEqual(first.data.items.map(row=>row.id),rows.slice().reverse().slice(0,60).map(row=>row.id));
      assert.deepEqual(second.data.items.map(row=>row.id),rows.slice().reverse().slice(60,120).map(row=>row.id));
      const revealed=await request(`/api/catalog?jobId=${job.id}&limit=60&offset=0&revealId=${rows[2].id}`);assert.equal(revealed.data.offset,120);assert(revealed.data.items.some(row=>row.id===rows[2].id));
    });
    await t.test('origin is filtered before total and reveal; invalid page controls are rejected',async()=>{
      const page=await request(`/api/catalog?origin=seed&limit=60&offset=0&revealId=${rows[139].id}`);assert.equal(page.data.total,70);assert.equal(page.data.offset,60);assert.equal(page.data.items.length,10);assert(page.data.items.every(row=>row.origin==='seed'));
      for(const query of ['limit=101','limit=0','offset=100001','offset=-1','origin=private','revealId=bad'])assert.equal((await request('/api/catalog?'+query)).status,400,query);
      assert.equal((await request('/api/catalog?limit=100&offset=100000')).status,200);assert.equal(calls,0);
    });
  }finally{fixtureStore?.close();await app?.close();await rm(directory,{recursive:true,force:true});}
});
