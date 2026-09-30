import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

const input = () => ({ title:'Background directions', brief:'Compare actual alternatives before choosing the visual direction.', options:[
  {id:'terrain',label:'Geographic',description:'Contour proposal, not an approved direction.',previewUrl:'http://127.0.0.1:4333/backgrounds?effect=terrain',parameters:{scale:1,intensity:0.15,theme:'light',motion:true},sourceRefs:[{url:'https://example.org/terrain.svg',sha256:'a'.repeat(64),label:'Original artwork'}]},
  {id:'dots',label:'Dot field',parameters:{scale:1,intensity:0.2,theme:'light',motion:false},sourceRefs:[{url:'https://example.org/dots',sha256:'b'.repeat(64)}]}
]});
const providers = {status:async()=>({}),classify:async()=>{throw Error('UNEXPECTED INFERENCE');},plan:async()=>{throw Error('UNEXPECTED INFERENCE');},rank:async()=>{throw Error('UNEXPECTED INFERENCE');}};
const directories=[];
after(async()=>{for(const directory of directories)await rm(directory,{recursive:true,force:true});});
async function temporary() {const directory=await mkdtemp(join(tmpdir(),'glasses-design-reviews-'));directories.push(directory);return directory;}
async function request(app,path,method='GET',body,headers={}) {
  const {token}=await(await fetch(app.url+'/api/session')).json();
  const response=await fetch(app.url+path,{method,headers:{'X-Glasses-Token':token,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
async function start(dataDir) {return startServer({port:0,dataDir,seed:false,autoScout:false,providers,discoveryFetcher:async()=>{throw Error('UNEXPECTED NETWORK');}});}

test('actual HTTP choices and exact reviewed snapshots survive restart without workspace or provider changes',async t=>{
  const dir=await temporary(t);let app=await start(dir);t.after(async()=>{if(app)await app.close();});
  const created=await request(app,'/api/design-reviews','POST',input());assert.equal(created.status,201);
  const board=created.data.review;assert.equal(board.status,'open');assert.equal(board.decision,null);assert.equal(board.version,1);
  const picked=await request(app,`/api/design-reviews/${board.id}/decision`,'POST',{expectedVersion:1,optionId:'terrain',parameters:{scale:0.8,intensity:0.09},notes:'Keep the original geography; softer.'});
  assert.equal(picked.status,200);const selected=picked.data.review;
  assert.equal(selected.version,2);assert.equal(selected.status,'decided');assert.equal(selected.decision.reviewVersion,1);
  assert.deepEqual(selected.decision.parameters,{scale:0.8,intensity:0.09,theme:'light',motion:true});
  assert.equal(selected.decision.optionSnapshot.sourceRefs[0].sha256,'a'.repeat(64));
  assert.equal(selected.decision.briefSnapshot,board.brief);assert.equal(selected.decision.contentHash,board.contentHash);
  assert.equal(app.store.workspaces().length,0);assert.equal(app.store.outcomes().length,0);assert.equal(app.store.runs().length,0);
  await app.close();app=null;app=await start(dir);
  assert.deepEqual((await request(app,`/api/design-reviews/${board.id}`)).data.review,selected);
  assert.equal((await request(app,'/api/design-reviews')).data.items[0].id,board.id);
  assert.equal(app.store.getSetting('private-review-leak',null),null);
});

test('optimistic decision/edit conflicts preserve current choice across independent store connections',async t=>{
  const dir=await temporary(t),a=createStore(dir),b=createStore(dir);t.after(()=>{a.close();b.close();});
  const board=a.createDesignReview(input());
  const first=a.decideDesignReview(board.id,{expectedVersion:1,optionId:'terrain'});
  assert.throws(()=>b.decideDesignReview(board.id,{expectedVersion:1,optionId:'dots'}),error=>error.status===409);
  assert.throws(()=>b.updateDesignReview(board.id,{expectedVersion:1,brief:'Stale edit'}),error=>error.status===409);
  assert.deepEqual(b.getDesignReview(board.id),first);
  assert.throws(()=>a.updateDesignReview(board.id,{title:'Missing version'}),/expectedVersion/);
  assert.throws(()=>a.decideDesignReview(board.id,{optionId:'dots'}),/expectedVersion/);
  assert.equal(a.decideDesignReview(board.id,{expectedVersion:2,optionId:'dots'}).version,3);
});

test('meaningful content edits reopen review and retain the exact old decision while harmless edits do not',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  let board=store.createDesignReview(input());board=store.decideDesignReview(board.id,{expectedVersion:1,optionId:'terrain',notes:'PRIVATE_DESIGN_REASON'});
  const decision=board.decision;
  board=store.updateDesignReview(board.id,{expectedVersion:2,title:'Refined board name'});assert.equal(board.status,'decided');assert.deepEqual(board.decision,decision);
  const noOp=store.updateDesignReview(board.id,{expectedVersion:3,options:JSON.parse(JSON.stringify(board.options))});assert.equal(noOp.version,3);assert.deepEqual(noOp.decision,decision);
  const changed=structuredClone(board.options);changed[0].sourceRefs[0].sha256='c'.repeat(64);
  board=store.updateDesignReview(board.id,{expectedVersion:3,options:changed});assert.equal(board.version,4);assert.equal(board.status,'open');assert.equal(board.decision,null);
  assert.equal(board.decisionHistory.length,1);assert.equal(board.decisionHistory[0].action,'invalidated');assert.deepEqual(board.decisionHistory[0].decision,decision);
  assert.equal(board.decisionHistory[0].decision.optionSnapshot.sourceRefs[0].sha256,'a'.repeat(64));assert.notEqual(board.contentHash,decision.contentHash);
  board=store.decideDesignReview(board.id,{expectedVersion:4,optionId:'dots'});
  board=store.updateDesignReview(board.id,{expectedVersion:5,brief:'New brief changes what the choice means.'});assert.equal(board.status,'open');assert.equal(board.decisionHistory.length,2);
});

test('explicit choice replacement and clearing retain prior selected parameters and notes',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  let board=store.createDesignReview(input());board=store.decideDesignReview(board.id,{expectedVersion:1,optionId:'terrain',parameters:{scale:0.7},notes:'First choice'});
  board=store.decideDesignReview(board.id,{expectedVersion:2,optionId:'dots',parameters:{intensity:0.1},notes:'Prefer this alternative'});
  assert.equal(board.decisionHistory[0].action,'replaced');assert.equal(board.decisionHistory[0].decision.parameters.scale,0.7);assert.equal(board.decisionHistory[0].decision.notes,'First choice');
  board=store.decideDesignReview(board.id,{expectedVersion:3,optionId:null,notes:'Need a new comparison'});assert.equal(board.status,'open');assert.equal(board.decision,null);assert.equal(board.decisionHistory[1].action,'cleared');assert.equal(board.decisionHistory[1].decision.notes,'Prefer this alternative');assert.equal(board.decisionHistory[1].notes,'Need a new comparison');
  assert.equal(store.decideDesignReview(board.id,{expectedVersion:4,optionId:null}).version,4,'clearing an already open board is a no-op');
});

test('strict board validation rejects executable URLs, forged decisions, source mutations and unbounded data',async t=>{
  const store=createStore(await temporary(t));t.after(()=>store.close());
  const mutations=[
    x=>{x.decision={optionId:'terrain'};},x=>{x.status='decided';},x=>{x.options[0].previewUrl='javascript:alert(1)';},x=>{x.options[0].previewUrl='file:///private';},
    x=>{x.options[0].sourceRefs[0].url='https://user:password@example.org/source';},x=>{x.options[0].sourceRefs[0].sha256='not-a-hash';},
    x=>{x.options[1].id='terrain';},x=>{x.options.push(...Array.from({length:11},(_,i)=>({id:'more'+i,label:'Too many'})));},
    x=>{x.options[0].parameters={nested:{value:1}};},x=>{x.options[0].parameters={x:Infinity};},x=>{x.options[0].parameters={x:'x'.repeat(501)};},
    x=>{x.options[0].parameters=JSON.parse('{"__proto__":"polluted"}');},x=>{x.brief='x'.repeat(8001);},x=>{x.options[0].sourceRefs[0].body='Raw code not accepted';}
  ];
  for(const mutate of mutations){const value=input();mutate(value);assert.throws(()=>store.createDesignReview(value));}
  assert.equal(store.designReviews().length,0);assert.equal({}.polluted,undefined);
  const board=store.createDesignReview(input());
  for(const body of [{optionId:'missing'},{optionId:'terrain',parameters:{unknown:1}},{optionId:'terrain',parameters:{scale:'big'}},{optionId:'terrain',parameters:{scale:1e10}},{optionId:null,parameters:{scale:1}},{optionId:'terrain',actor:'user'}]) assert.throws(()=>store.decideDesignReview(board.id,{expectedVersion:1,...body}));
  assert.equal(store.getDesignReview(board.id).version,1);
});

test('design routes retain loopback origin/session policy and useful status codes',async t=>{
  const app=await start(await temporary(t));t.after(()=>app.close());
  assert.equal((await fetch(app.url+'/api/design-reviews')).status,401);
  assert.equal((await request(app,'/api/design-reviews','POST',input(),{Origin:'https://foreign.example'})).status,403);
  assert.equal((await request(app,'/api/design-reviews/missing')).status,404);
  assert.equal((await request(app,'/api/design-reviews','POST',{...input(),options:[]})).status,400);
  const board=(await request(app,'/api/design-reviews','POST',input())).data.review;
  assert.equal((await request(app,`/api/design-reviews/${board.id}/decision`,'POST',{expectedVersion:1,optionId:'dots'})).status,200);
  assert.equal((await request(app,`/api/design-reviews/${board.id}`,'PUT',{expectedVersion:1,brief:'Stale'})).status,409);
});

test('official local MCP creates/reads/revises a board and reads HTTP user choice without a decision tool',async t=>{
  const app=await start(await temporary(t));let client,transport;t.after(async()=>{if(client)await client.close();else if(transport)await transport.close();await app.close();});
  transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{...process.env,GLASSES_URL:app.url},stderr:'pipe'});
  client=new Client({name:'design-review-contract-test',version:'1'});await client.connect(transport);
  const inventory=(await client.listTools()).tools, names=inventory.map(tool=>tool.name);
  assert.deepEqual(names.filter(name=>name.includes('design_review')).sort(),['glasses_create_design_review','glasses_get_design_review','glasses_list_design_reviews','glasses_update_design_review'].sort());
  assert.match(inventory.find(tool=>tool.name==='glasses_create_design_review').description,/before committing/);
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,result.content[0].text);return JSON.parse(result.content[0].text);};
  const created=await call('glasses_create_design_review',input());assert.equal(created.review.status,'open');assert.equal(created.reviewUrl,`${app.url}/#reviews/${created.review.id}`);
  assert.equal((await call('glasses_list_design_reviews')).items[0].optionCount,2);
  const chosen=await request(app,`/api/design-reviews/${created.review.id}/decision`,'POST',{expectedVersion:1,optionId:'terrain',parameters:{intensity:0.08},notes:'Actual API selection'});assert.equal(chosen.status,200);
  const read=await call('glasses_get_design_review',{id:created.review.id});assert.equal(read.review.decision.parameters.intensity,0.08);
  const revised=await call('glasses_update_design_review',{id:created.review.id,expectedVersion:2,brief:'Reconsider with smaller cells.'});assert.equal(revised.review.status,'open');assert.equal(revised.review.decisionHistory[0].decision.notes,'Actual API selection');
  const forged=await client.callTool({name:'glasses_decide_design_review',arguments:{id:created.review.id,optionId:'dots'}});assert.equal(forged.isError,true);
  assert.equal(app.store.workspaces().length,0);assert.equal(app.store.runs().length,0);
});
