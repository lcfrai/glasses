import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createDiscovery, fetchPublic } from '../src/discovery.mjs';

test('cancelling a scout aborts its active fetch and prevents all subsequent fetches', async () => {
  const directory=await mkdtemp(join(tmpdir(),'glasses-abort-')),store=createStore(directory),controller=new AbortController();
  let enter;const entered=new Promise(resolve=>{enter=resolve;});let requests=0;
  const discovery=createDiscovery({store,fetcher:async(url,{signal})=>{requests++;enter();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  try{
    const pending=discovery.scout({query:'agent memory',signal:controller.signal});await entered;controller.abort(new Error('Cancelled by user'));
    const run=await pending;assert.equal(requests,1);assert.equal(run.status,'failed');assert.equal(discovery.scouting,false);assert.match(run.errors.join(' '),/Cancelled by user/);assert.equal(store.evidence().length,0);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('aborted public fetch never reaches DNS or network',async()=>{
  let lookedUp=false;const controller=new AbortController();controller.abort(new Error('No longer needed'));
  await assert.rejects(fetchPublic('https://example.org/data',{signal:controller.signal,resolver:async()=>{lookedUp=true;return [];}}),/No longer needed/);
  assert.equal(lookedUp,false);
});
