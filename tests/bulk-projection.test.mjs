import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,stableId} from '../src/store.mjs';
import {createBulkImporter} from '../src/bulk-import.mjs';
import {createPublicCatalogue,enrichPublicCatalogue,publicCatalogueEvidenceIds} from '../src/public-catalogue.mjs';
const sha=(value,a='sha256')=>createHash(a).update(value).digest('hex'),at='2026-09-30T06:00:00.000Z',repo='verified/source-guidance',parentURL='https://github.com/'+repo,rev='a'.repeat(40),tree='b'.repeat(40);
const MIT='MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software. The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.';
function evidence(url,value,contentType='application/json'){const body=typeof value==='string'?value:JSON.stringify(value),sha256=sha(body);return{id:stableId(url+'\n'+sha256),url,body,sha256,status:200,contentType,firstFetchedAt:at,lastFetchedAt:at};}
async function setup(t){const path=await mkdtemp(join(tmpdir(),'glasses-bulk-projection-')),store=createStore(path);t.after(async()=>{store.close();await rm(path,{recursive:true,force:true});});return store;}
function fixture({document='---\nname: Review evidence\ndescription: Review a proposed change.\n---\n# Review\n## Inputs\n- Public code changes\n## Outputs\n- Concrete findings\n',privateRepo=false,license=MIT}={}){
 const sourcePath='skills/review/SKILL.md',files=[{path:sourcePath,body:document},{path:'LICENSE',body:license}].map(f=>({...f,type:'blob',mode:'100644',size:Buffer.byteLength(f.body),sha:sha(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(f.body)}\0`),Buffer.from(f.body)]),'sha1')}));
 const metadata=evidence('https://api.github.com/repos/'+repo,{name:'source-guidance',full_name:repo,html_url:parentURL,private:privateRepo,archived:false,disabled:false,default_branch:'main',description:'A collection of source guidance skills.',topics:['skills'],stargazers_count:1234,license:{spdx_id:'MIT'}}),commit=evidence(`https://api.github.com/repos/${repo}/commits/main`,{sha:rev,commit:{tree:{sha:tree}}}),treeEvidence=evidence(`https://api.github.com/repos/${repo}/git/trees/${tree}?recursive=1`,{sha:tree,truncated:false,tree:files.map(({body,...f})=>f)});
 const docs=files.map(f=>evidence(`https://raw.githubusercontent.com/${repo}/${rev}/${f.path}`,f.body,'text/plain'));
 return{metadata,commit,treeEvidence,docs,candidate:{url:parentURL+'/blob/main/'+sourcePath,sourceKind:'github-guidance',requestedResourceType:'skill',guidance:{repository:repo,defaultBranch:'main',revision:rev,sourcePath,metadataEvidence:metadata,commitEvidence:commit,treeEvidence}}};
}
function inputs(store){const capabilities=store.search({}),ids=publicCatalogueEvidenceIds(capabilities);return{capabilities,evidence:ids.map(id=>store.getEvidence(id))};}
test('bulk source acquisition reprojects exact public bytes and preserves skill identity and parent membership',async t=>{
 const store=await setup(t),f=fixture();for(const e of [f.metadata,f.commit,f.treeEvidence])store.retainEvidence(e);
 const requests=[],importer=createBulkImporter({store,discovery:{},fetcher:async url=>{requests.push(url);return f.docs.find(d=>d.url===url);}}),result=await importer(f.candidate);
 assert.equal(result.reviewRequired,false);assert.equal(result.item.id,stableId(f.candidate.url));assert.equal(requests.length,2);assert.ok(requests.every(url=>url.includes(rev)));
 const raw=store.getCapability(result.item.id);assert.equal(raw.details.resourceType,'skill');raw.privateNotes='PRIVATE_OVERLAY';raw.details.overview='PRIVATE_OVERRIDE';
 const pack=createPublicCatalogue({...inputs(store),capabilities:inputs(store).capabilities.map(row=>row.id===raw.id?raw:row)}).snapshot,child=pack.items.find(row=>row.id===result.item.id);
 assert.equal(child.details.parent.id,stableId(parentURL));assert.equal(child.details.resourceType,'skill');assert.equal(child.license.scope,'source-artifact');assert.ok(!JSON.stringify(pack).includes('PRIVATE_'));
 const enriched=enrichPublicCatalogue(pack,{evidence:inputs(store).evidence});assert.equal(enriched.items.find(row=>row.id===child.id).details.resourceType,'skill');assert.equal(enriched.items.find(row=>row.url===parentURL).details.memberCount,1);
});
test('requested skill/agent lane cannot turn an incompatible file path into a valid source type',async t=>{
 const store=await setup(t),f=fixture();for(const e of [f.metadata,f.commit,f.treeEvidence])store.retainEvidence(e);
 f.candidate.requestedResourceType='agent';const importer=createBulkImporter({store,discovery:{},fetcher:async url=>f.docs.find(d=>d.url===url)}),result=await importer(f.candidate);
 assert.equal(result.reviewRequired,true);assert.match(result.reason,/not-an-actual-skill-or-profile/);assert.equal(store.search({}).length,0);
});
test('private parents and mismatched immutable document bytes never enter the catalogue',async t=>{
 for(const options of [{privateRepo:true},{}]){const store=await setup(t),f=fixture(options);for(const e of [f.metadata,f.commit,f.treeEvidence])store.retainEvidence(e);if(!options.privateRepo)f.docs[0]=evidence(f.docs[0].url,f.docs[0].body+'TAMPERED','text/plain');const importer=createBulkImporter({store,discovery:{},fetcher:async url=>f.docs.find(d=>d.url===url)}),result=await importer(f.candidate);assert.equal(result.reviewRequired,true);assert.equal(store.search({}).length,0);}
});
test('public HTML metadata gets unknown page rights and ignores requested lane, local overlays and script bodies',async t=>{
 const store=await setup(t),url='https://docs.example.org/guide',doc=evidence(url,'<title>Official documentation</title><meta name="description" content="A guide to public APIs."><script>PRIVATE_SCRIPT_BODY</script>','text/html');store.retainEvidence(doc);
 const importer=createBulkImporter({store,discovery:{},fetcher:async()=>{throw Error('Unexpected fetch');}}),result=await importer({url,sourceKind:'public-page',requestedResourceType:'skill',provenance:{evidence:[doc]}});
 assert.equal(result.item.kind,'reference');const p=createPublicCatalogue(inputs(store)).snapshot.items[0];assert.deepEqual(p.license,{spdx:null,status:'unknown',scope:'public-page',basis:'upstream-metadata'});assert.equal(p.citations[0].kind,'public-page-metadata');assert.ok(!JSON.stringify(p).includes('PRIVATE_'));
});
test('HTML claims require exact page evidence URL/hash and do not silently accept sign-in/challenge pages',()=>{
 for(const value of [{url:'https://other.example.org/guide',body:'<title>Real docs</title>'},{url:'https://docs.example.org/guide',body:'<title>Sign in to continue</title>'},{url:'https://docs.example.org/guide',body:'<title>Just a moment...</title>'}]){const d=evidence(value.url,value.body,'text/html'),cap={url:'https://docs.example.org/guide',origin:'live',metadataEvidence:d};assert.equal(createPublicCatalogue({capabilities:[cap],evidence:[d]}).snapshot.items.length,0);}
 const d=evidence('https://docs.example.org/guide','<title>Real docs</title>','text/html');d.body+='tamper';assert.equal(createPublicCatalogue({capabilities:[{url:d.url,origin:'live',metadataEvidence:d}],evidence:[d]}).snapshot.items.length,0);
});
test('malformed persisted artifact proposal is omitted without crashing unrelated public-page export',()=>{
 const d=evidence('https://docs.example.org/guide','<title>Public docs</title>','text/html'),valid={url:d.url,origin:'live',metadataEvidence:d};
 for(const artifactManifest of [{schemaVersion:1,items:[null],sources:[null]},{schemaVersion:1,items:'x',sources:[{}]},{schemaVersion:1,items:[{}],sources:[null]}]){
  const result=createPublicCatalogue({capabilities:[valid,{origin:'live',artifactManifest}],evidence:[d]});assert.equal(result.snapshot.items.length,1);assert.ok(result.report.excluded.unsupportedEvidence>=1);
 }
});
