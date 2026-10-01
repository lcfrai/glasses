import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,validateRepository,canonicalRepository} from './lib/github-census.mjs';

// Retained response observations can be useful even when an inconsistent leaf
// cannot prove enumeration. Keep that evidence separate from completed coverage.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const opt=key=>process.argv.find(x=>x.startsWith('--'+key+'='))?.slice(key.length+3);
const folder=path.resolve(opt('out')||path.join(root,'evidence/github-coverage-ranking-2026-10-01/discovery'));
const read=async name=>JSON.parse(await fs.readFile(path.join(folder,name),'utf8'));
const state=await read('state.json'),coverage=await read('coverage.json'),baseline=await read('baseline-identities-verified.json');
if(state.partitions.some(p=>p.status==='pending'))throw Error('Finish the census frontier before emitting final supplemental observations');
const existing=new Set(coverage.items.map(x=>x.repositoryId)),byId=new Map(baseline.items.map(x=>[x.repositoryId,x])),byUrl=new Map(baseline.items.map(x=>[canonicalRepository(x.url),x]));
const observed=new Map(),refs=state.partitions.flatMap(p=>p.receipts.map(ref=>({...ref,partition:p.key,partitionStatus:p.status}))).sort((a,b)=>a.fetchedAt.localeCompare(b.fetchedAt));
let verifiedResponses=0;
for(const ref of refs){
 if(!/^responses\/[a-zA-Z0-9_.-]+\.json$/.test(ref.evidenceFile))throw Error('Unsafe source receipt path');
 const doc=await read(ref.evidenceFile);
 if(doc.status!==200||doc.sha256!==ref.sha256||sha256(doc.body)!==ref.sha256||doc.url!==ref.url||doc.fetchedAt!==ref.fetchedAt)throw Error('Source receipt integrity mismatch');
 const data=JSON.parse(doc.body);if(!Array.isArray(data.items))throw Error('Missing source search membership');
 for(const repo of data.items){validateRepository(repo);const old=observed.get(repo.id);observed.set(repo.id,{repositoryId:repo.id,repository:repo.full_name,url:repo.html_url,stars:repo.stargazers_count,private:false,fork:repo.fork,archived:repo.archived,disabled:typeof repo.disabled==='boolean'?repo.disabled:null,description:repo.description||'',license:repo.license||null,createdAt:repo.created_at,updatedAt:repo.updated_at,defaultBranch:repo.default_branch,evidenceFile:ref.evidenceFile,sourceHash:ref.sha256,observedAt:ref.fetchedAt,partitions:[...new Set([...(old?.partitions||[]),ref.partition])],urls:[...new Set([...(old?.urls||[]),repo.html_url])],observedInPartitionStatus:ref.partitionStatus,publishedId:byId.get(repo.id)?.id||byUrl.get(canonicalRepository(repo.html_url))?.id||null});}
 verifiedResponses++;
}
const eligible=[...observed.values()].filter(x=>x.stars>=state.minimumStars);
const items=eligible.filter(x=>!existing.has(x.repositoryId)).sort((a,b)=>b.stars-a.stars||a.repositoryId-b.repositoryId);
const report={schemaVersion:1,at:new Date().toISOString(),status:'observed-outside-completed-partitions',baselineHash:state.baselineHash,verifiedResponses,minimumStars:state.minimumStars,allObservedUnique:observed.size,latestObservedEligible:eligible.length,completedCoverage:existing.size,additionalObserved:items.length,items,note:'Each item is a real hash-verified public search response record whose numeric identity is absent from completed-leaf coverage. This recovers index-boundary movement without declaring any unresolved partition complete. Catalogue suitability and atomic current coverage are not asserted.'};
await fs.writeFile(path.join(folder,'supplemental-observations.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...report,items:items.map(x=>({repositoryId:x.repositoryId,repository:x.repository,stars:x.stars}))}));
