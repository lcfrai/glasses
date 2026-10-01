import test from 'node:test';
import assert from 'node:assert/strict';
import {createCensus,partitionQuery,splitPartition,consumePage,censusSummary,parseGhResponse,backoffUntil,validateRepository,sha256} from '../scripts/lib/github-census.mjs';

const at='2026-10-01T00:00:00Z';
const receipt={evidenceFile:'public-response.json',sha256:'a'.repeat(64),fetchedAt:at};
const repo=(id,stars=70000,extra={})=>({id,private:false,visibility:'public',full_name:`owner/repo${id}`,html_url:`https://github.com/owner/repo${id}`,stargazers_count:stars,fork:false,archived:false,disabled:false,created_at:'2020-01-01T00:00:00Z',...extra});
const response=(items,total=items.length,incomplete=false)=>({items,total_count:total,incomplete_results:incomplete});

test('initial star bands cover every eligible integer exactly once, highest first',()=>{
 const s=createCensus({at});assert.deepEqual(s.partitions.map(x=>[x.low,x.high]),[[70000,null],[10000,69999],[1000,9999]]);
 for(const n of [999,1000,9999,10000,69999,70000,1000000])assert.equal(s.partitions.filter(p=>n>=p.low&&(p.high===null||n<=p.high)).length,n>=1000?1:0);
 assert.equal(partitionQuery(s.partitions[0]),'is:public fork:true stars:>=70000');
});
test('over-ceiling pages are evidence only and split into disjoint smaller queries',()=>{
 const s=createCensus({at}),p=s.partitions[1];const result=consumePage(s,p,response([repo(1,50000)],1500),receipt);
 assert.equal(result.action,'split');assert.equal(Object.keys(s.observations).length,0);
 const children=s.partitions.filter(x=>x.key.startsWith('1.'));assert.equal(children.length,2);assert.equal(children[0].low,children[1].high+1);
});
test('equal-star density splits creation timestamps to seconds, not undocumented ID qualifiers',()=>{
 const p={key:'dense',low:1000,high:1000,createdLow:10,createdHigh:13},parts=splitPartition(p,at);
 assert.deepEqual(parts.map(x=>[x.createdLow,x.createdHigh]),[[10,11],[12,13]]);
 assert.match(partitionQuery(parts[0]),/created:1970-01-01T00:00:10Z\.\.1970-01-01T00:00:11Z/);
 assert.equal(splitPartition({...p,createdHigh:10},at),null);
});
test('incomplete results cannot advance or appear in completed coverage',()=>{
 const s=createCensus({at}),p=s.partitions[0];consumePage(s,p,response([repo(1)],1,true),receipt);
 assert.equal(p.page,1);assert.equal(p.status,'split');assert.equal(censusSummary(s).items.length,0);assert.equal(s.events[0].reason,'incomplete-results');
});
test('resume after first page retains exact cursor and completes one leaf with numeric dedupe',()=>{
 let s=createCensus({at}),p=s.partitions[0];consumePage(s,p,response(Array.from({length:100},(_,i)=>repo(i+1)),101),receipt);
 assert.equal(p.page,2);assert.equal(p.status,'pending');assert.equal(censusSummary(s).items.length,0);
 s=JSON.parse(JSON.stringify(s));p=s.partitions[0];consumePage(s,p,response([repo(101)],101),receipt);
 assert.equal(p.status,'complete');assert.equal(censusSummary(s).items.length,101);
});
test('pagination duplicates and changed totals split and retain unfinished evidence without a false complete',()=>{
 for(const [second,reason] of [[response([repo(1)],101),'pagination-duplicate'],[response([repo(101)],102),'count-drift']]){
  const s=createCensus({at}),p=s.partitions[0];consumePage(s,p,response(Array.from({length:100},(_,i)=>repo(i+1)),101),receipt);consumePage(s,p,second,receipt);
  assert.equal(p.reason,reason);assert.equal(censusSummary(s).items.length,0);assert.equal(p.receipts.length,2);
 }
});
test('boundary drift and a short page cannot silently omit records',()=>{
 const s=createCensus({at}),p=s.partitions[0];consumePage(s,p,response([repo(1,69999)]),receipt);assert.equal(p.reason,'star-boundary-drift');
 const t=createCensus({at}),q=t.partitions[0];consumePage(t,q,response([],1),receipt);assert.equal(q.reason,'page-size-drift');
});
test('numeric canonical identity recognizes transferred repositories and preserves forks/archives',()=>{
 const s=createCensus({at}),p=s.partitions[0];consumePage(s,p,response([repo(1),repo(2,71000,{fork:true}),repo(3,72000,{archived:true}),repo(4,73000,{disabled:true})]),receipt);
 const out=censusSummary(s,[{id:'old',url:'https://github.com/old-owner/old-name',repositoryId:1}]);assert.equal(out.items.find(x=>x.repositoryId===1).publishedId,'old');
 assert.deepEqual(out.thresholds[70000],{enumerated:4,originals:3,forks:1,archived:1,disabled:1,alreadyPublished:1,missing:3,missingActiveOriginals:0});
});
test('public-only record guard rejects private, malformed identity and fractional stars',()=>{
 for(const r of [repo(1,1000,{private:true}),repo(1,1000,{html_url:'https://example.com/o/r'}),repo(1,1000,{html_url:null,full_name:null}),repo(1,1000.5)])assert.throws(()=>validateRepository(r));
 assert.equal(validateRepository(repo(1)).id,1);
});
test('HTTP receipt parser retains exact body bytes and only reviewed response headers',()=>{
 const body='{"total_count":0,"items":[]}\n';const r=parseGhResponse('HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 2\r\nX-Oauth-Scopes: private-value\r\nSet-Cookie: do-not-save\r\nContent-Type: application/json\r\n\r\n'+body);
 assert.equal(r.body,body);assert.deepEqual(r.headers,{'x-ratelimit-remaining':'2','content-type':'application/json'});
});
test('rate-limit headers define backoff and uncertain403 never immediately retries',()=>{
 assert.equal(backoffUntil({status:429,headers:{'retry-after':'12'}},1000),14000);
 assert.equal(backoffUntil({status:200,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'123'}},1000),125000);
 assert.equal(backoffUntil({status:403,headers:{}},1000),61000);
 assert.equal(backoffUntil({status:200,headers:{}},1000),0);
});

test('supplemental source observations recover a moved eligible identity without pretending its leaf completed',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'glasses-census-observations-'));
 try{
  await fs.mkdir(path.join(folder,'responses'));
  const refs=[];
  for(const [i,items] of [[0,[repo(1,1000),repo(2,1000),repo(3,1001)]],[1,[repo(2,1001,{full_name:'new-owner/renamed',html_url:'https://github.com/new-owner/renamed'}),repo(3,999)]]]){
   const body=JSON.stringify(response(items)),fetchedAt=`2026-10-01T00:00:0${i}Z`,url='https://api.github.com/search/repositories?q=is%3Apublic+fork%3Atrue+stars%3A1000&sort=stars&order=desc&per_page=100&page=1';
   const evidenceFile=`responses/${i}.json`,hash=sha256(body);await fs.writeFile(path.join(folder,evidenceFile),JSON.stringify({url,status:200,body,sha256:hash,fetchedAt}));refs.push({url,evidenceFile,sha256:hash,fetchedAt});
  }
  await fs.writeFile(path.join(folder,'state.json'),JSON.stringify({minimumStars:1000,baselineHash:'baseline',partitions:[{key:'drifting',status:'unresolved',receipts:refs}]}));
  await fs.writeFile(path.join(folder,'coverage.json'),JSON.stringify({items:[{repositoryId:1}]}));
  await fs.writeFile(path.join(folder,'baseline-identities-verified.json'),JSON.stringify({items:[{repositoryId:2,id:'published-before-transfer',url:'https://github.com/owner/repo2'}]}));
  await promisify(execFile)(process.execPath,['scripts/github-census-observations.mjs','--out='+folder]);
  const result=JSON.parse(await fs.readFile(path.join(folder,'supplemental-observations.json'),'utf8'));
  assert.equal(result.status,'observed-outside-completed-partitions');assert.equal(result.additionalObserved,1);assert.equal(result.items[0].repositoryId,2);assert.equal(result.items[0].publishedId,'published-before-transfer');assert.equal(result.items[0].evidenceFile,'responses/1.json');assert.equal(result.items[0].observedInPartitionStatus,'unresolved');
  assert.equal(JSON.parse(await fs.readFile(path.join(folder,'state.json'),'utf8')).partitions[0].status,'unresolved');
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});
