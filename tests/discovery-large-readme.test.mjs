import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createDiscovery} from '../src/discovery.mjs';
import {createIntelligence} from '../src/intelligence.mjs';
import {createIntelligenceStore} from '../src/intelligence-store.mjs';
import {createPublicCatalogue,publicCatalogueEvidenceIds} from '../src/public-catalogue.mjs';
import {enrichCatalogueDetails} from '../src/catalogue-details.mjs';
import {MAX_RAW_README_BYTES,rawReadmeIdentity,rawReadmeDeclaration,verifyRawReadme,repositoryReadmeRefs} from '../src/github-readme.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const blob=value=>createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(value)}\0`),Buffer.from(value)])).digest('hex');
const revision='a'.repeat(40),repository='public-lab/large-tool',endpoint=`https://api.github.com/repos/${repository}`,rawUrl=`https://raw.githubusercontent.com/${repository}/${revision}/README.md`;
const largeBody='# Large Tool\n\nA public document search application with local indexing and export.\n\n## Features\n\nSearch documents and preserve your index.\n\n'+('<!-- retained padding, not published prose -->\n'.repeat(25000))+'\nTAIL_SENTINEL_MUST_NOT_PUBLISH\n';
function document(url,body,contentType='application/json'){return {url,body,sha256:hash(body),status:200,contentType,fetchedAt:'2026-09-30T00:00:00.000Z'};}
function fixtureDocuments(body=largeBody){
  const api={encoding:'none',path:'README.md',size:Buffer.byteLength(body),sha:blob(body),download_url:rawUrl};
  return new Map([
    [endpoint,document(endpoint,JSON.stringify({name:'large-tool',full_name:repository,html_url:`https://github.com/${repository}`,private:false,fork:false,archived:false,disabled:false,description:'A public document search application.',default_branch:'main',topics:['search'],license:{spdx_id:'MIT'},stargazers_count:1234}))],
    [`${endpoint}/commits/main`,document(`${endpoint}/commits/main`,JSON.stringify({sha:revision}))],
    [`${endpoint}/license?ref=${revision}`,document(`${endpoint}/license?ref=${revision}`,JSON.stringify({encoding:'base64',path:'LICENSE',content:Buffer.from('MIT fixture licence retained separately.').toString('base64'),license:{spdx_id:'MIT'}}))],
    [`${endpoint}/readme?ref=${revision}`,document(`${endpoint}/readme?ref=${revision}`,JSON.stringify(api))],
    [rawUrl,document(rawUrl,body,'text/plain; charset=utf-8')]
  ]);
}
async function fixture(t,mutate){
  const directory=await mkdtemp(join(tmpdir(),'glasses-large-readme-')),store=createStore(directory),documents=fixtureDocuments(),requests=[];
  mutate?.(documents);
  const discovery=createDiscovery({store,fetcher:async(url,options)=>{requests.push({url,options});const doc=documents.get(url);assert.ok(doc,`Unexpected fixture URL ${url}`);return structuredClone(doc);}});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const imported=await discovery.importUrl(`https://github.com/${repository}`);
  return {directory,store,discovery,documents,requests,imported};
}

test('large encoding:none README follows only declared pinned raw bytes and preserves both exact originals',async t=>{
  const {store,discovery,imported,documents,requests}=await fixture(t),item=await discovery.inspect(imported.id,{fetchSource:true});
  assert.equal(item.sourceState.status,'ok');assert.equal(item.provenance.resolvedRevision,revision);
  assert.equal(item.repositoryFiles.find(x=>x.path==='README.md').content,largeBody);
  const proof=item.repositoryReadmeProof;
  assert.equal(proof.bytes,Buffer.byteLength(largeBody));assert.equal(proof.gitBlobSha,blob(largeBody));
  assert.equal(store.getEvidence(proof.rawEvidence.id).body,largeBody);
  assert.equal(store.getEvidence(proof.rawEvidence.id).sha256,hash(largeBody));
  assert.equal(store.getEvidence(proof.apiEvidence.id).body,documents.get(`${endpoint}/readme?ref=${revision}`).body);
  assert.equal(JSON.parse(store.getEvidence(proof.apiEvidence.id).body).encoding,'none');
  assert.equal(requests.at(-1).options.maxBytes,MAX_RAW_README_BYTES);assert.equal(requests.at(-1).options.redirects,0);
  assert.deepEqual(repositoryReadmeRefs(item),[proof.rawEvidence.id]);
  assert.ok(publicCatalogueEvidenceIds([item]).includes(proof.apiEvidence.id),'original API declaration stays in public verification inputs');
});

test('raw declaration rejects foreign hosts/repositories, moving refs, traversal, queries and oversized declarations before download',async t=>{
  const bad=[
    {download_url:rawUrl.replace('raw.githubusercontent.com','example.org')},
    {download_url:rawUrl.replace(repository,'other/project')},
    {download_url:rawUrl.replace(revision,'main')},
    {download_url:rawUrl+'?token=secret'},
    {download_url:rawUrl.replace('README.md','folder/../README.md'),path:'folder/../README.md'},
    {size:MAX_RAW_README_BYTES+1}
  ];
  for(const mutation of bad){
    const data=await fixture(t,documents=>{const url=`${endpoint}/readme?ref=${revision}`,old=documents.get(url);documents.set(url,document(url,JSON.stringify({...JSON.parse(old.body),...mutation})));});
    const item=await data.discovery.inspect(data.imported.id,{fetchSource:true});
    assert.equal(item.sourceState.status,'partial');assert.equal(item.repositoryReadmeProof,null);
    assert.ok(!item.repositoryFiles.some(x=>x.path==='README.md'));
    assert.equal(data.requests.length,4,'no raw request after invalid declaration');
  }
  assert.equal(rawReadmeIdentity(rawUrl.replace(revision,'main')),null);
});

test('raw acceptance requires full SHA256, Git blob, declared size and absolute body limit',()=>{
  const docs=fixtureDocuments(),api=docs.get(`${endpoint}/readme?ref=${revision}`),raw=docs.get(rawUrl),identity={repository,revision};
  assert.equal(verifyRawReadme(raw,api,identity).gitBlobSha,blob(largeBody));
  assert.throws(()=>rawReadmeDeclaration({...api,sha256:'0'.repeat(64)},identity),/integrity/);
  assert.throws(()=>verifyRawReadme({...raw,sha256:'0'.repeat(64)},api,identity),/bytes/);
  const changed=largeBody.replace('public document','private documen');
  assert.equal(Buffer.byteLength(changed),Buffer.byteLength(largeBody));
  assert.throws(()=>verifyRawReadme(document(rawUrl,changed,'text/plain'),api,identity),/bytes/,'SHA256-valid tamper still fails Git blob');
  assert.throws(()=>verifyRawReadme(document(rawUrl,largeBody+'x'),api,identity),/bytes/);
  const oversized='x'.repeat(MAX_RAW_README_BYTES+1),largeApi=document(api.url,JSON.stringify({...JSON.parse(api.body),size:Buffer.byteLength(oversized),sha:blob(oversized)}));
  assert.throws(()=>verifyRawReadme(document(rawUrl,oversized),largeApi,identity),/unbounded/);
});

test('ordinary base64 README keeps its original reference ordering and no raw request',async t=>{
  const data=await fixture(t,documents=>{const url=`${endpoint}/readme?ref=${revision}`;documents.set(url,document(url,JSON.stringify({encoding:'base64',path:'README.md',content:Buffer.from('Ordinary README').toString('base64')})));});
  const item=await data.discovery.inspect(data.imported.id,{fetchSource:true});
  assert.equal(item.sourceState.status,'ok');assert.equal(item.repositoryReadmeProof,null);assert.equal(data.requests.length,4);
  assert.deepEqual(repositoryReadmeRefs(item),item.repositoryEvidence.filter(ref=>/\/readme(?:\?|$)/i.test(ref.url||'')).map(ref=>ref.id));
});

test('classifier consumes raw prose; strict public labels and bounded details cite the original full-body hash',async t=>{
  const {directory,store,discovery,imported}=await fixture(t),item=await discovery.inspect(imported.id,{fetchSource:true}),calls=[];
  const providers={status:async()=>({jev:{configured:true,model:'jev-1.13.0'}}),plan:async()=>{},rank:async()=>{},classify:async(provider,{cards})=>{calls.push(cards);return {model:'jev-1.13.0',usage:{inputTokens:100,outputTokens:10},results:cards.map(card=>({id:card.id,artifact:'whole-product',adoption:'deploy-service',capabilities:['document search'],confidence:0.8,evidenceIds:card.evidenceIds}))};}};
  const engine=createIntelligence({store,discovery,providers,dataDir:directory});
  try{
    const job=engine.enqueue({type:'classify',candidateIds:[item.id],provider:'jev'});let completed;
    for(let i=0;i<400;i++){completed=engine.getJob(job.id);if(!['queued','running'].includes(completed.status))break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(completed.status,'completed',JSON.stringify(completed.errors));
    assert.equal(calls.length,1);assert.equal(calls[0][0].evidence[0].url,rawUrl);
    assert.match(calls[0][0].evidence[0].excerpt,/public document search application/);assert.ok(calls[0][0].evidence[0].excerpt.length<=2000);
    assert.doesNotMatch(calls[0][0].evidence[0].excerpt,/encoding.*none|TAIL_SENTINEL/);
  }finally{await engine.close();}
  const intelligence=createIntelligenceStore(directory);let assessment;try{assessment=intelligence.get('assessments',item.id);}finally{intelligence.close();}
  const evidence=publicCatalogueEvidenceIds([item]).map(id=>store.getEvidence(id)),input={capabilities:[item],evidence,assessments:[assessment]};
  const result=createPublicCatalogue(input);assert.equal(result.snapshot.items.length,1);assert.ok(result.snapshot.items[0].assessment);
  const enriched=enrichCatalogueDetails({items:result.snapshot.items,evidence})[0];
  const prose=JSON.stringify(enriched.details);assert.match(prose,/public document search application/);assert.doesNotMatch(prose,/TAIL_SENTINEL/);
  const rawCitation=enriched.citations.find(x=>x.endpoint===rawUrl);assert.equal(rawCitation.sha256,hash(largeBody));assert.equal(rawCitation.kind,'github-source-evidence');
  assert.ok(enriched.details.overview.split(/\s+/).length<=180);
  for(const edit of [
    value=>{value.capabilities[0].repositoryReadmeProof=null;},
    value=>{value.evidence=value.evidence.filter(x=>x.id!==item.repositoryReadmeProof.apiEvidence.id);},
    value=>{const raw=value.evidence.find(x=>x.url===rawUrl);raw.body+='tamper';},
    value=>{const api=value.evidence.find(x=>x.id===item.repositoryReadmeProof.apiEvidence.id);api.body=api.body.replace(blob(largeBody),'0'.repeat(40));api.sha256=hash(api.body);}
  ]){const broken=structuredClone(input);edit(broken);assert.equal(createPublicCatalogue(broken).snapshot.items[0].assessment,null);}
  const noProof=evidence.filter(x=>x.id!==item.repositoryReadmeProof.apiEvidence.id);
  assert.doesNotMatch(JSON.stringify(enrichCatalogueDetails({items:result.snapshot.items,evidence:noProof})[0].details),/public document search application/);
});
