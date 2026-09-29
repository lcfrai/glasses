import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../public/api-client.mjs';

const rejected='Missing or invalid X-Glasses-Token; obtain /api/session on loopback';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});

test('concurrent first requests and stale rejections share session refresh, including late old responses',async()=>{
  let sessions=0,current='before',releaseLate;
  const late=new Promise(resolve=>{releaseLate=resolve});
  const api=createApiClient({fetchImpl:async(path,options)=>{
    if(path==='/api/session'){sessions++;await Promise.resolve();assert.equal(options.cache,'no-store');return json({token:current});}
    assert.equal(options.redirect,'error');
    const used=options.headers.get('X-Glasses-Token');
    if(used!==current){if(path==='/api/late')await late;return json({error:rejected},401);}
    return json({path,tokenWasCurrent:true});
  }});
  await Promise.all([api('/api/first'),api('/api/second')]);assert.equal(sessions,1);
  current='after';
  const delayed=api('/api/late');
  const results=await Promise.all([api('/api/a'),api('/api/b')]);
  assert.equal(sessions,2);assert.ok(results.every(result=>result.tokenWasCurrent));
  releaseLate();assert.equal((await delayed).tokenWasCurrent,true);assert.equal(sessions,2,'Late old rejection reuses the already refreshed session');
});

test('a stale mutation is retried once with the exact body and only one accepted side effect',async()=>{
  let sessions=0,attempts=0,commits=0,current='before';const bodies=[];
  const api=createApiClient({fetchImpl:async(path,options)=>{
    if(path==='/api/session'){sessions++;return json({token:current});}
    if(path==='/api/status')return json({ok:true});
    attempts++;bodies.push(options.body);
    if(options.headers.get('X-Glasses-Token')!==current)return json({error:rejected},401);
    commits++;return json({version:2});
  }});
  await api('/api/status');current='after';
  const body=JSON.stringify({title:'Unsaved draft',expectedVersion:1});
  assert.equal((await api('/api/workspaces/id',{method:'PUT',body})).version,2);
  assert.deepEqual(bodies,[body,body]);assert.equal(attempts,2);assert.equal(commits,1);assert.equal(sessions,2);
});

test('persistent token rejection stops after one refresh and one retry',async()=>{
  let sessions=0,attempts=0;
  const api=createApiClient({fetchImpl:async path=>path==='/api/session'?(sessions++,json({token:'token-'+sessions})):(attempts++,json({error:rejected},401))});
  await assert.rejects(api('/api/status'),error=>error.status===401&&error.message===rejected);
  assert.equal(sessions,2);assert.equal(attempts,2);
});

test('provider auth, origin, conflict, server and network errors never replay mutations',async()=>{
  for(const [status,message] of [[401,'Provider key was rejected'],[403,'Foreign origins are blocked'],[409,'Workspace changed'],[500,'Unexpected server failure']]){
    let sessions=0,attempts=0;
    const api=createApiClient({fetchImpl:async path=>path==='/api/session'?(sessions++,json({token:'current'})):(attempts++,json({error:message},status))});
    await assert.rejects(api('/api/action',{method:'POST',body:'{}'}),error=>error.status===status&&error.message===message);
    assert.equal(attempts,1);assert.equal(sessions,1);
  }
  let attempts=0;
  const api=createApiClient({fetchImpl:async path=>{if(path==='/api/session')return json({token:'current'});attempts++;throw new TypeError('fetch failed after possible commit');}});
  await assert.rejects(api('/api/action',{method:'POST',body:'{}'}),/possible commit/);assert.equal(attempts,1);
});

test('failed session refresh and malformed sessions never issue an unauthenticated replay',async()=>{
  let sessions=0,attempts=0;
  const api=createApiClient({fetchImpl:async path=>{
    if(path==='/api/session')return ++sessions===1?json({token:'old'}):json({error:'Restart still in progress'},503);
    attempts++;return json({error:rejected},401);
  }});
  await assert.rejects(api('/api/action',{method:'POST',body:'{}'}),error=>error.status===503);assert.equal(attempts,1);assert.equal(sessions,2);
  const invalid=createApiClient({fetchImpl:async()=>json({token:null})});
  await assert.rejects(invalid('/api/status'),/invalid session/);
  await assert.rejects(api('https://foreign.example.org/api/status'),/local \/api\/ routes/);
});
