import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stableId} from '../src/store.mjs';
import {githubReadmeQuery,README_PATHS,GRAPHQL_SOURCE_URL,verifyGraphqlSource} from '../src/github-graphql-source.mjs';
import {createPublicCatalogue,enrichPublicCatalogue} from '../src/public-catalogue.mjs';

const hash=(value,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const at='2026-10-01T00:00:00.000Z',alphaURL='https://github.com/example/alpha',alphaId=stableId(alphaURL);
function source(url,data,query){
  const body=JSON.stringify(data),sha256=hash(body),request=query?{method:'POST',body:JSON.stringify({query})}:undefined;
  return {id:stableId(url+'\n'+sha256),url,body,sha256,status:200,contentType:'application/json',lastFetchedAt:at,...(request?{request,requestSha256:hash(request.body)}:{})};
}
function graphql(rows){
  const data={};for(const [index,row] of rows.entries()){
    const bytes=Buffer.from(row.text),oid=hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1');
    data['r'+index]={databaseId:row.id,nameWithOwner:row.repository,isPrivate:false,defaultBranchRef:{target:{oid:row.revision,...Object.fromEntries(README_PATHS.map((_,i)=>['f'+i,null])),f0:{path:'README.md',oid,object:{oid,byteSize:bytes.length,isBinary:false,isTruncated:false,text:row.text}}}}};
  }
  data.rateLimit={cost:1,remaining:4998,resetAt:at};return source(GRAPHQL_SOURCE_URL,{data},githubReadmeQuery(rows.map(row=>row.repository)));
}
function fixture(){
  const sibling=graphql([{id:2,repository:'example/beta',revision:'b'.repeat(40),text:'# Beta\n\nBeta is a tool for rendering diagrams.'},{id:1,repository:'example/alpha',revision:'a'.repeat(40),text:'# Alpha\n\nAlpha is a library for OLD ALPHA diagram editing.'}]);
  sibling.lastFetchedAt='2026-10-01T00:01:00.000Z';
  const selected=graphql([{id:1,repository:'example/alpha',revision:'c'.repeat(40),text:'# Alpha\n\nAlpha is a platform for NEW ALPHA deployment management.'}]);
  const metadata=source('https://api.github.com/search/repositories',{items:[['example/alpha',1],['example/beta',2]].map(([repository,id])=>({id,html_url:'https://github.com/'+repository,full_name:repository,description:'Public source product metadata',private:false,topics:[],license:null}))});
  function capability(repository,snapshot){
    const record=verifyGraphqlSource(snapshot).records.find(row=>row.repository===repository),file=record.files[0],url='https://github.com/'+repository;
    return {id:stableId(url),url,origin:'live',metadataEvidence:{id:metadata.id,sha256:metadata.sha256},provenance:{resolvedRevision:record.revision},graphqlReadmeProof:{evidenceId:snapshot.id,sha256:snapshot.sha256,alias:record.alias,repositoryId:record.repositoryId,repository,revision:record.revision,path:file.path,blobOid:file.blobOid},repositoryEvidence:[{id:snapshot.id,url:snapshot.url,sha256:snapshot.sha256}]};
  }
  const capabilities=[capability('example/beta',sibling),capability('example/alpha',selected)],evidence=[metadata,sibling,selected];
  const pack=createPublicCatalogue({capabilities,evidence,generatedAt:at}).snapshot;
  const binding={sha256:selected.sha256,revision:capabilities[1].provenance.resolvedRevision,repositoryId:1};
  return {sibling,selected,metadata,capabilities,evidence,pack,binding};
}
const alpha=pack=>pack.items.find(row=>row.id===alphaId);

test('a later sibling GraphQL batch cannot replace a row’s selected source version',()=>{
  const f=fixture(),readmeBindings=new Map([[alphaId,f.binding]]);
  const result=alpha(enrichPublicCatalogue(f.pack,{evidence:f.evidence,readmeBindings,generatedAt:at}));
  assert.match(result.details.overview,/NEW ALPHA/);assert.doesNotMatch(JSON.stringify(result),/OLD ALPHA/);
  const sourceCitations=result.citations.filter(ref=>ref.kind==='github-source-evidence');
  assert.deepEqual(sourceCitations.map(ref=>ref.sha256),[f.selected.sha256]);
  assert.equal(result.assessment,null,'Source selection does not manufacture an assessment');
});

test('baseline public details remain bound to their own old citations when a newer source is supplied',()=>{
  const f=fixture(),readmeBindings=new Map([[alphaId,{sha256:f.sibling.sha256,revision:'a'.repeat(40),repositoryId:1}]]);
  const old=enrichPublicCatalogue(f.pack,{evidence:f.evidence,readmeBindings,generatedAt:at});
  f.selected.lastFetchedAt='2026-10-02T00:00:00.000Z';
  const refreshed=alpha(enrichPublicCatalogue(old,{evidence:f.evidence,generatedAt:at}));
  assert.match(refreshed.details.overview,/OLD ALPHA/);assert.equal(refreshed.citations.some(ref=>ref.sha256===f.selected.sha256),false);
  const missing=alpha(enrichPublicCatalogue(old,{evidence:[f.metadata,f.selected],generatedAt:at}));
  assert.equal(missing.details.overview,undefined,'Missing own evidence never falls back to another revision');
});

test('legacy unbound enrichment admits a unique version but refuses ambiguous versions and explicit absence',()=>{
  const f=fixture();
  assert.match(alpha(enrichPublicCatalogue(f.pack,{evidence:[f.metadata,f.selected]})).details.overview,/NEW ALPHA/);
  assert.equal(alpha(enrichPublicCatalogue(f.pack,{evidence:f.evidence})).details.overview,undefined);
  assert.equal(alpha(enrichPublicCatalogue(f.pack,{evidence:[f.metadata,f.selected],readmeBindings:new Map([[alphaId,null]])})).details.overview,undefined);
});

test('bound hash, immutable revision and GraphQL numeric identity must all match',()=>{
  const f=fixture();for(const change of [{sha256:'0'.repeat(64)},{revision:'d'.repeat(40)},{repositoryId:2},{revision:'main'}]){
    assert.throws(()=>enrichPublicCatalogue(f.pack,{evidence:f.evidence,readmeBindings:new Map([[alphaId,{...f.binding,...change}]])}),/README source/);
  }
  const broken={...f.selected,body:f.selected.body+' '};
  assert.throws(()=>enrichPublicCatalogue(f.pack,{evidence:[f.metadata,broken,f.sibling],readmeBindings:new Map([[alphaId,f.binding]])}),/README source/);
});

test('REST revision and exact source bytes remain disambiguated when public endpoints omit queries',()=>{
  const f=fixture(),readme=(revision,text)=>source('https://api.github.com/repos/example/alpha/readme?ref='+revision,{path:'README.md',encoding:'base64',content:Buffer.from(text).toString('base64')});
  const old=readme('a'.repeat(40),'# Alpha\n\nAlpha is a library for archived document editing.'),current=readme('c'.repeat(40),'# Alpha\n\nAlpha is a platform for current document workflows.');
  current.lastFetchedAt='2026-10-02T00:00:00.000Z';
  const baseline=enrichPublicCatalogue(f.pack,{evidence:[f.metadata,old]});
  const result=alpha(enrichPublicCatalogue(baseline,{evidence:[f.metadata,current,old]}));
  assert.match(result.details.overview,/archived document/);assert.equal(result.citations.some(ref=>ref.sha256===current.sha256),false);
  const selected=alpha(enrichPublicCatalogue(f.pack,{evidence:[f.metadata,current,old],readmeBindings:new Map([[alphaId,{sha256:current.sha256,revision:'c'.repeat(40),repositoryId:1}]])}));
  assert.match(selected.details.overview,/current document/);
});

test('complete large inline blobs and verified truncated-base64 raw recovery share the bounded prose path',()=>{
  const f=fixture(),revision='c'.repeat(40),body='# Alpha\n\nAlpha is a platform for bounded source inspection.\n\n'+('Public source supporting documentation.\n'.repeat(9000))+'\n## Outside extraction budget\nDo not publish TAILSENTINEL.\n';
  const bytes=Buffer.from(body),blob=hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1'),rawURL=`https://raw.githubusercontent.com/example/alpha/${revision}/README.md`;
  const data={path:'README.md',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:blob,download_url:rawURL};
  const apiURL=`https://api.github.com/repos/example/alpha/readme?ref=${revision}`,inline=source(apiURL,data);
  const binding=sha256=>new Map([[alphaId,{sha256,revision,repositoryId:1}]]);
  const complete=alpha(enrichPublicCatalogue(f.pack,{evidence:[f.metadata,inline],readmeBindings:binding(inline.sha256)}));
  assert.match(complete.details.overview,/bounded source inspection/);assert.doesNotMatch(JSON.stringify(complete.details),/TAILSENTINEL/);
  const truncated=source(apiURL,{...data,content:bytes.subarray(0,100000).toString('base64')});
  const raw={id:stableId(rawURL+'\n'+hash(body)),url:rawURL,sha256:hash(body),body,status:200,lastFetchedAt:at};
  assert.throws(()=>enrichPublicCatalogue(f.pack,{evidence:[f.metadata,truncated],readmeBindings:binding(truncated.sha256)}),/README source/);
  const recovered=alpha(enrichPublicCatalogue(f.pack,{evidence:[f.metadata,truncated,raw],readmeBindings:binding(raw.sha256)}));
  assert.match(recovered.details.overview,/bounded source inspection/);assert.doesNotMatch(JSON.stringify(recovered.details),/TAILSENTINEL/);
  assert.equal(recovered.citations.some(ref=>ref.sha256===raw.sha256&&ref.endpoint===rawURL),true);
  const corrupt={...raw,body:body+'x',sha256:hash(body+'x'),id:stableId(rawURL+'\n'+hash(body+'x'))};
  assert.throws(()=>enrichPublicCatalogue(f.pack,{evidence:[f.metadata,truncated,corrupt],readmeBindings:binding(corrupt.sha256)}),/README source/);
  const overBudget=source(apiURL,{...data,size:4*1024*1024+1});
  assert.throws(()=>enrichPublicCatalogue(f.pack,{evidence:[f.metadata,overBudget,raw],readmeBindings:binding(raw.sha256)}),/README source/);
});
