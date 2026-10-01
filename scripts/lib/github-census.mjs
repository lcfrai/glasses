import {createHash} from 'node:crypto';

export const CENSUS_VERSION=1;
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const canonicalRepository=url=>typeof url==='string'&&/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/?$/.test(url)?url.toLowerCase().replace(/\/$/,''):null;
export function validateRepository(repo) {
 if(repo?.private!==false||repo.visibility&&repo.visibility!=='public'||!Number.isSafeInteger(repo.id)||repo.id<=0||!Number.isSafeInteger(repo.stargazers_count)||repo.stargazers_count<0||!canonicalRepository(repo.html_url)||canonicalRepository(repo.html_url)!==canonicalRepository('https://github.com/'+repo.full_name)||typeof repo.fork!=='boolean'||typeof repo.archived!=='boolean')throw Error('Invalid public repository identity or flags');
 return repo;
}
export function partitionQuery(p) {
 if(!Number.isSafeInteger(p.low)||p.low<1||p.high!==null&&(!Number.isSafeInteger(p.high)||p.high<p.low))throw Error('Invalid star partition');
 const stars=p.high===null?'>='+p.low:p.low===p.high?String(p.low):`${p.low}..${p.high}`;
 let query=`is:public fork:true stars:${stars}`;
 if(p.createdLow!==undefined){if(!Number.isSafeInteger(p.createdLow)||!Number.isSafeInteger(p.createdHigh)||p.createdLow>p.createdHigh)throw Error('Invalid creation partition');query+=` created:${iso(p.createdLow)}..${iso(p.createdHigh)}`;}
 return query;
}
const iso=seconds=>new Date(seconds*1000).toISOString().replace('.000Z','Z');
export function splitPartition(p, frozenAt) {
 let bounds;
 if(p.high===null){const mid=p.low*2-1;bounds=[{low:mid+1,high:null},{low:p.low,high:mid}];}
 else if(p.high>p.low){const mid=Math.floor((p.low+p.high)/2);bounds=[{low:mid+1,high:p.high},{low:p.low,high:mid}];}
 else {const low=p.createdLow??0,high=p.createdHigh??Math.floor(Date.parse(frozenAt)/1000);if(low>=high)return null;const mid=Math.floor((low+high)/2);bounds=[{low:p.low,high:p.high,createdLow:low,createdHigh:mid},{low:p.low,high:p.high,createdLow:mid+1,createdHigh:high}];}
 return bounds.map((x,i)=>({...x,key:`${p.key}.${i}`,status:'pending',page:1,receipts:[],ids:[]}));
}
export function createCensus({minimumStars=1000,at=new Date().toISOString(),baselineHash=null}={}) {
 if(!Number.isSafeInteger(minimumStars)||minimumStars<1)throw Error('Invalid minimum stars');
 const cuts=[70000,10000,minimumStars].filter(x=>x>=minimumStars).filter((x,i,a)=>a.indexOf(x)===i).sort((a,b)=>b-a);
 return {schemaVersion:CENSUS_VERSION,createdAt:at,baselineHash,minimumStars,leafLimit:900,status:'pending',requests:0,partitions:cuts.map((low,i)=>({key:String(i),low,high:i===0?null:cuts[i-1]-1,status:'pending',page:1,receipts:[],ids:[]})),observations:{},events:[]};
}
export function nextPartition(state){return state.partitions.find(p=>p.status==='pending');}
export function consumePage(state,p,data,receipt) {
 if(!data||!Array.isArray(data.items)||data.items.length>100||!Number.isSafeInteger(data.total_count)||data.total_count<0||typeof data.incomplete_results!=='boolean')throw Error('Invalid search response');
 data.items.forEach(validateRepository);
 p.receipts.push(receipt);state.requests++;
 const split=reason=>{const children=splitPartition(p,state.createdAt);p.status=children?'split':'unresolved';p.reason=reason;state.events.push({partition:p.key,reason,receipt});if(children)state.partitions.splice(state.partitions.indexOf(p)+1,0,...children);return {action:p.status,reason};};
 if(data.incomplete_results)return split('incomplete-results');
 if(data.total_count>state.leafLimit)return split('search-ceiling');
 if(p.expected!==undefined&&p.expected!==data.total_count)return split('count-drift');
 p.expected=data.total_count;
 const seen=new Set(p.ids);
 for(const repo of data.items){if(seen.has(repo.id))return split('pagination-duplicate');seen.add(repo.id);}
 const required=Math.min(100,Math.max(0,p.expected-(p.page-1)*100));
 if(data.items.length!==required)return split('page-size-drift');
 for(const repo of data.items){
  if(repo.stargazers_count<p.low||p.high!==null&&repo.stargazers_count>p.high)return split('star-boundary-drift');
  if(p.createdLow!==undefined){const created=Date.parse(repo.created_at)/1000;if(!Number.isFinite(created)||created<p.createdLow||created>p.createdHigh)return split('created-boundary-drift');}
 }
 for(const repo of data.items){p.ids.push(repo.id);const old=state.observations[repo.id];state.observations[repo.id]={repositoryId:repo.id,repository:repo.full_name,url:repo.html_url,stars:repo.stargazers_count,private:false,fork:repo.fork,archived:repo.archived,disabled:typeof repo.disabled==='boolean'?repo.disabled:null,description:repo.description||'',license:repo.license||null,createdAt:repo.created_at,updatedAt:repo.updated_at,defaultBranch:repo.default_branch,evidenceFile:receipt.evidenceFile,sourceHash:receipt.sha256,observedAt:receipt.fetchedAt,partitions:[...new Set([...(old?.partitions||[]),p.key])],urls:[...new Set([...(old?.urls||[]),repo.html_url])]};}
 if(p.ids.length===p.expected)p.status='complete';else p.page++;
 if(p.page>10&&p.status!=='complete')return split('search-page-ceiling');
 return {action:p.status,count:p.ids.length,expected:p.expected};
}
export function censusSummary(state,baseline=[]) {
 const urlMap=new Map(baseline.map(x=>[canonicalRepository(x.url),x])),idMap=new Map(baseline.filter(x=>Number.isSafeInteger(x.repositoryId)).map(x=>[x.repositoryId,x]));
 const complete=state.partitions.filter(p=>p.status==='complete'),validIds=new Set(complete.flatMap(p=>p.ids));
 const rows=Object.values(state.observations).filter(x=>validIds.has(x.repositoryId)).sort((a,b)=>b.stars-a.stars||a.repositoryId-b.repositoryId).map(x=>({...x,publishedId:idMap.get(x.repositoryId)?.id||x.urls.map(url=>urlMap.get(canonicalRepository(url))?.id).find(Boolean)||null}));
 const counts=minimum=>{const all=rows.filter(x=>x.stars>=minimum);return{enumerated:all.length,originals:all.filter(x=>!x.fork).length,forks:all.filter(x=>x.fork).length,archived:all.filter(x=>x.archived).length,disabled:all.filter(x=>x.disabled===true).length,alreadyPublished:all.filter(x=>x.publishedId).length,missing:all.filter(x=>!x.publishedId).length,missingActiveOriginals:all.filter(x=>!x.publishedId&&!x.fork&&!x.archived&&x.disabled===false).length};};
 return {schemaVersion:1,createdAt:state.createdAt,updatedAt:new Date().toISOString(),status:state.partitions.some(p=>p.status==='pending')?'partial':state.partitions.some(p=>p.status==='unresolved')?'unresolved':'enumerated',baselineHash:state.baselineHash,requests:state.requests,completedPartitions:complete.length,pendingPartitions:state.partitions.filter(p=>p.status==='pending').length,unresolvedPartitions:state.partitions.filter(p=>p.status==='unresolved'),thresholds:Object.fromEntries([70000,10000,1000].filter(x=>x>=state.minimumStars).map(x=>[x,counts(x)])),items:rows,limitations:['Search-index observations, not an atomic GitHub snapshot; stars and repository status can change during pagination.','All public repository types, forks and archives are retained. Catalogue suitability/licence/source review is a separate decision.','Only fully enumerated partitions contribute to coverage; incomplete, drifting or unresolved partitions remain explicit.']};
}
export function parseGhResponse(stdout) {
 const match=/^HTTP\/\S+\s+(\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(stdout);
 if(!match)throw Error('GitHub CLI response missing HTTP envelope');
 const headers={};for(const line of match[2].split(/\r?\n/)){const i=line.indexOf(':');if(i<0)continue;const key=line.slice(0,i).toLowerCase();if(/^(content-type|date|retry-after|x-ratelimit-(limit|remaining|reset|resource|used)|x-github-request-id|link)$/.test(key))headers[key]=line.slice(i+1).trim();}
 return {status:Number(match[1]),headers,body:match[3]};
}
export function backoffUntil(response,now=Date.now()) {
 const h=response.headers||{},retry=Number(h['retry-after']);
 if(Number.isFinite(retry)&&retry>0)return now+retry*1000+1000;
 if(h['x-ratelimit-remaining']==='0'&&Number(h['x-ratelimit-reset'])>0)return Number(h['x-ratelimit-reset'])*1000+2000;
 if(response.status===403||response.status===429)return now+60000;
 return 0;
}
