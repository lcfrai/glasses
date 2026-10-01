import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCredentialStore} from '../src/credential-store.mjs';

const first='synthetic-key-one',second='synthetic-key-two';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'glasses-credential-cache-')),directory=join(dataDir,'credentials'),file=join(directory,'jev.dpapi.json');await mkdir(directory);
  const state={now:0,protects:0,unprotects:0,active:0,maxActive:0,hold:null,fail:false},keys=new Map();
  const ciphertext=key=>{const value=Buffer.from('opaque-fixture-'+keys.size).toString('base64');keys.set(value,key);return value;};
  const write=async key=>{const value=ciphertext(key);await writeFile(file,JSON.stringify({version:1,storage:'windows-dpapi',ciphertext:value}));return value;};
  const protect=async(action,value)=>{
    if(action==='protect'){state.protects++;return ciphertext(value);}
    state.unprotects++;state.active++;state.maxActive=Math.max(state.maxActive,state.active);
    try{if(state.hold)await state.hold.promise;if(state.fail)throw Error('Synthetic failure');return keys.get(value);}finally{state.active--;}
  };
  const store=createCredentialStore({dataDir,platform:'win32',protect,now:()=>state.now});
  t.after(async()=>{state.hold?.resolve();await store.remove();await rm(dataDir,{recursive:true,force:true});});
  return {dataDir,directory,file,state,store,write,ciphertext};
}
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await delay(5);}throw Error('Fixture did not enter decryption');}

test('warm loads and status calls reuse one decrypt for at most30 seconds without persisting plaintext',async t=>{
  const f=await fixture(t);await f.store.save(first);assert.equal(f.state.protects,1);assert.equal(f.state.unprotects,1);
  const results=await Promise.all(Array.from({length:40},()=>f.store.load()));assert(results.every(key=>key===first));
  await Promise.all(Array.from({length:20},()=>f.store.status({force:true})));assert.equal(f.state.unprotects,1);
  f.state.now=29999;assert.equal(await f.store.load(),first);assert.equal(f.state.unprotects,1);
  f.state.now=30000;assert.equal(await f.store.load(),first);assert.equal(f.state.unprotects,2);
  f.state.now=59999;await f.store.load();assert.equal(f.state.unprotects,2);
  f.state.now=60000;await f.store.load();assert.equal(f.state.unprotects,3);
  assert.deepEqual(await readdir(f.directory),['jev.dpapi.json']);const raw=await readFile(f.file,'utf8');assert(!raw.includes(first));assert(!Buffer.from(JSON.parse(raw).ciphertext,'base64').includes(Buffer.from(first)));
});

test('concurrent cold loads and status coalesce into one bounded decrypt',async t=>{
  const f=await fixture(t);await f.write(first);f.state.hold=deferred();
  const requests=Array.from({length:40},(_,index)=>index%2?f.store.load():f.store.status());
  await waitFor(()=>f.state.unprotects===1);await delay(25);assert.equal(f.state.unprotects,1);f.state.hold.resolve();
  const results=await Promise.all(requests);for(let index=0;index<results.length;index++)assert.deepEqual(results[index],index%2?first:{configured:true,storage:'windows-dpapi'});
  assert.equal(f.state.unprotects,1);assert.equal(f.state.maxActive,1);
});

test('concurrent reads of an absent credential return null without manufactured unlock errors',async t=>{
  const f=await fixture(t);assert.deepEqual(await Promise.all(Array.from({length:40},()=>f.store.load())),Array(40).fill(null));assert.equal(f.state.unprotects,0);
  await f.store.save(first);await rm(f.file);assert.deepEqual(await Promise.all(Array.from({length:40},()=>f.store.load())),Array(40).fill(null));assert.equal(f.state.unprotects,1);
});

test('external replacement, corruption and removal are observed on every load and status',async t=>{
  const f=await fixture(t);await f.store.save(first);await f.write(second);assert.equal(await f.store.load(),second);assert.equal(f.state.unprotects,2);
  const record=JSON.parse(await readFile(f.file,'utf8'));await writeFile(f.file,JSON.stringify({...record,version:2}));
  await assert.rejects(f.store.load(),{code:'CREDENTIAL_STORAGE'});assert.equal((await f.store.status()).configured,false);assert.equal(f.state.unprotects,2);
  await writeFile(f.file,JSON.stringify(record));assert.equal(await f.store.load(),second);assert.equal(f.state.unprotects,3);
  await rm(f.file);assert.deepEqual(await f.store.status(),{configured:false,storage:'windows-dpapi'});assert.equal(await f.store.load(),null);
  await f.write(first);assert.equal(await f.store.load(),first);assert.equal(f.state.unprotects,4);
});

test('an external rotation during decrypt cannot return or cache the old key',async t=>{
  const f=await fixture(t);await f.write(first);f.state.hold=deferred();const pending=f.store.load();await waitFor(()=>f.state.active===1);
  await f.write(second);f.state.hold.resolve();assert.equal(await pending,second);assert.equal(await f.store.load(),second);assert.equal(f.state.unprotects,2);assert.equal(f.state.maxActive,1);
});

test('save and remove invalidate in-flight decryption and no removed key is resurrected',async t=>{
  const f=await fixture(t);await f.write(first);f.state.hold=deferred();const pending=f.store.load();await waitFor(()=>f.state.active===1);
  const saving=f.store.save(second);await waitFor(()=>f.state.protects===1);f.state.hold.resolve();assert.equal(await pending,second);assert.deepEqual(await saving,{configured:true,storage:'windows-dpapi'});
  f.state.now=30000;f.state.hold=deferred();const removingLoad=f.store.load();await waitFor(()=>f.state.active===1);await f.store.remove();f.state.hold.resolve();assert.equal(await removingLoad,null);assert.equal(await f.store.load(),null);assert.equal(f.state.maxActive,1);
});

test('decrypt failures are coalesced but never cached as an unavailable configuration',async t=>{
  const f=await fixture(t);await f.write(first);f.state.hold=deferred();f.state.fail=true;
  const requests=Array.from({length:20},()=>f.store.status());await waitFor(()=>f.state.active===1);await delay(25);f.state.hold.resolve();
  const statuses=await Promise.all(requests);assert(statuses.every(status=>status.configured===false&&status.error));assert.equal(f.state.unprotects,1);
  f.state.fail=false;assert.deepEqual(await f.store.status(),{configured:true,storage:'windows-dpapi'});assert.equal(f.state.unprotects,2);
});

test('clock rollback does not extend cache lifetime and invalid decrypted keys stay generic',async t=>{
  const f=await fixture(t);f.state.now=100;await f.store.save(first);f.state.now=99;await f.store.load();assert.equal(f.state.unprotects,2);
  await f.write('invalid secret with spaces');await assert.rejects(f.store.load(),error=>error.code==='CREDENTIAL_STORAGE'&&!error.message.includes('invalid secret'));
});

test('a synchronously failing protector cannot leave a rejected pending decrypt stuck forever',async t=>{
  const f=await fixture(t);const cipher=await f.write(first);let calls=0;
  const store=createCredentialStore({dataDir:f.dataDir,platform:'win32',protect:()=>{if(++calls===1)throw Error('Synthetic synchronous failure');return first;}});
  await assert.rejects(store.load(),{code:'CREDENTIAL_STORAGE'});assert.equal(await store.load(),first);assert.equal(calls,2);assert.equal(JSON.parse(await readFile(f.file,'utf8')).ciphertext,cipher);await store.remove();
});
