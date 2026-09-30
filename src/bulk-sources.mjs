import {fetchPublic,validatePublicURL} from './discovery.mjs';

export const BULK_RESOURCE_TYPES=Object.freeze(['tool','component','skill','agent','collection','reference']);
export const BULK_DEFAULT_LANES=Object.freeze([
  {resourceType:'tool',weight:3,limit:100,sources:[{adapter:'github-repositories',query:'topic:self-hosted stars:>=1000'},{adapter:'github-repositories',query:'topic:developer-tools stars:>=1000'},{adapter:'github-repositories',query:'topic:agent-memory stars:>=100'}]},
  {resourceType:'component',weight:2,limit:60,sources:[{adapter:'registry-components'},{adapter:'github-repositories',query:'topic:react-components stars:>=1000'}]},
  {resourceType:'skill',weight:1,limit:40,sources:[{adapter:'github-guidance',repository:'mattpocock/skills'},{adapter:'github-guidance',repository:'anthropics/skills'},{adapter:'github-guidance',repository:'openai/plugins'}]},
  {resourceType:'agent',weight:1,limit:40,sources:[{adapter:'github-guidance',repository:'github/awesome-copilot'},{adapter:'github-guidance',repository:'openai/plugins'}]},
  {resourceType:'collection',weight:1,limit:40,sources:[{adapter:'registry-collections'},{adapter:'github-repositories',query:'agent skills collection stars:>=1000'}]},
  {resourceType:'reference',weight:1,limit:20,sources:[{adapter:'public-reference',url:'https://selfh.st/apps/'},{adapter:'public-reference',url:'https://openalternative.co/'},{adapter:'public-reference',url:'https://awesome-selfhosted.net/'},{adapter:'public-reference',url:'https://modelcontextprotocol.io/docs/getting-started/intro'}]}
]);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const repoPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,shaPattern=/^[a-f0-9]{40}$/;
const pathSafe=value=>typeof value==='string'&&value.length<=500&&!/[\\\x00?#%:]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const encoded=value=>value.split('/').map(encodeURIComponent).join('/');
function publicURL(value){if(typeof value!=='string'||new URL(value).hash)throw fail('Source URLs must not contain query parameters or fragments');const url=validatePublicURL(value);if(url.search)throw fail('Source URLs must not contain query parameters or fragments');return url.href;}
export function validateBulkSource(source){
  if(!source||typeof source!=='object'||Array.isArray(source))throw fail('Bulk source must be an object');
  const allowed=['adapter','query','repository','url'];if(Object.keys(source).some(key=>!allowed.includes(key)))throw fail('Unknown bulk source field');
  if(!['github-repositories','registry-components','registry-collections','github-guidance','public-reference'].includes(source.adapter))throw fail('Unsupported bulk source adapter');
  const out={adapter:source.adapter};
  if(source.adapter==='github-repositories'){if(typeof source.query!=='string'||!source.query.trim()||source.query.length>200||/[\x00-\x1f]/.test(source.query))throw fail('GitHub query must contain 1–200 printable characters');out.query=source.query.trim();}
  if(source.adapter==='github-guidance'){if(!repoPattern.test(source.repository||''))throw fail('Guidance source requires owner/repository');out.repository=source.repository;}
  if(source.adapter==='public-reference')out.url=publicURL(source.url);
  return out;
}

/** Public read-only pages. Individual guidance acquisition remains a separately
 * verified importer responsibility; filename discovery does not prove rights. */
export function createBulkSourceAdapters({store,fetcher=fetchPublic}={}){
  if(!store?.retainEvidence)throw fail('Bulk sources require retained evidence');
  const cache=new Map();let cacheBytes=0;
  async function read(url,signal){signal?.throwIfAborted();const doc=await fetcher(url,{signal,maxBytes:16*1024*1024});signal?.throwIfAborted();if(doc.status!==200||typeof doc.body!=='string'||Buffer.byteLength(doc.body)>16*1024*1024)throw fail('Public source response is not a bounded successful document',502);return{...doc,evidence:store.retainEvidence({...doc,url:doc.url||url})};}
  function json(doc){try{return JSON.parse(doc.body);}catch{throw fail('Public source returned invalid JSON',502);}}
  function proof(source,adapter,extra={}){return{adapter,sourceUrl:source.url,evidence:[source.evidence],...extra};}
  function page(values,{cursor,limit,fingerprint}){if(cursor&&(cursor.fingerprint!==fingerprint||!Number.isInteger(cursor.offset)||cursor.offset<0||cursor.offset>values.length))throw fail('Source index changed or cursor is invalid; start a new plan for this source',409);const offset=cursor?.offset||0,end=Math.min(values.length,offset+limit);return{candidates:values.slice(offset,end),nextCursor:end<values.length?{offset:end,fingerprint}:null,exhausted:end>=values.length,total:values.length};}
  // These are response/parsed-index hints only, never durable scan authority.
  // A new plan or evicted/resumed page rechecks the exact source fingerprint.
  function cached(key){return cache.get(key)?.value;}
  function retainCache(key,value){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>32*1024*1024)return value;while(cache.size>=16||cacheBytes+bytes>32*1024*1024){const oldest=cache.keys().next().value;cacheBytes-=cache.get(oldest).bytes;cache.delete(oldest);}cache.set(key,{value,bytes});cacheBytes+=bytes;return value;}
  async function index(url,signal,scanId){const key=(scanId||'standalone')+':'+url;return cached(key)||retainCache(key,await read(url,signal));}
  const adapters={
    'github-repositories':async({source,lane,cursor,limit,signal})=>{
      const number=cursor?.page||1;if(!Number.isInteger(number)||number<1||number>50)throw fail('GitHub page exceeds the 1,000-result search boundary');
      const query=[source.query,...['archived','fork'].filter(key=>!new RegExp(`(?:^|\\s)-?${key}:`,'i').test(source.query)).map(key=>`${key}:false`)].join(' ');
      const url=`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}&page=${number}`,doc=await read(url,signal),data=json(doc);
      if(!Array.isArray(data.items)||data.items.length>100)throw fail('GitHub repository search schema unavailable',502);
      if(data.incomplete_results)throw fail('GitHub search reported incomplete results; this page remains pending',503);
      const candidates=data.items.slice(0,limit).filter(repo=>repo.private===false&&!repo.archived&&!repo.disabled&&!repo.fork&&typeof repo.html_url==='string').map((repo,rank)=>({url:publicURL(repo.html_url),name:String(repo.full_name||repo.name||'').slice(0,200),sourceKind:'github-repository',requestedResourceType:lane,provenance:proof(doc,source.adapter,{query,rank:(number-1)*limit+rank+1,stars:Number.isSafeInteger(repo.stargazers_count)?repo.stargazers_count:null})}));
      const exhausted=data.items.length<limit||number*limit>=Math.min(1000,Number.isFinite(data.total_count)?data.total_count:1000);
      return{candidates,nextCursor:exhausted?null:{page:number+1},exhausted,evidence:[doc.evidence],total:data.total_count??null};
    },
    'registry-components':async({source,lane,cursor,limit,signal,scanId})=>{
      const doc=await index('https://registry.directory/items.json',signal,scanId),data=json(doc);if(!Array.isArray(data.items)||data.items.length>100000)throw fail('Registry item index is invalid or exceeds its entry bound',502);
      const seen=new Set(),groups=new Map();
      for(const row of data.items){const base=row.registry?.basePath;if(!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(base||'')||typeof row.name!=='string'||!row.name||row.name.length>200)continue;const url=`https://registry.directory${base}/${encodeURIComponent(row.name)}`;if(seen.has(url))continue;seen.add(url);if(!groups.has(base))groups.set(base,[]);groups.get(base).push({url,name:row.name,sourceKind:'registry-component',requestedResourceType:lane,provenance:proof(doc,source.adapter,{registry:base})});}
      // Interleave providers before paging so one large registry cannot take a lane.
      const providers=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([,rows])=>rows.sort((a,b)=>a.url.localeCompare(b.url))),values=[];for(let n=0;values.length<seen.size;n++)for(const rows of providers)if(rows[n])values.push(rows[n]);
      return{...page(values,{cursor,limit,fingerprint:doc.evidence.sha256}),evidence:[doc.evidence]};
    },
    'registry-collections':async({source,lane,cursor,limit,signal,scanId})=>{
      const doc=await index('https://registry.directory/directory.json',signal,scanId),data=json(doc);if(!Array.isArray(data.registries)||data.registries.length>10000)throw fail('Registry directory is invalid or oversized',502);
      const values=[];for(const row of data.registries){try{values.push({url:publicURL(row.url),name:String(row.name||'').slice(0,200),sourceKind:'registry-collection',requestedResourceType:lane,collection:{registryUrl:row.registry_url?publicURL(row.registry_url):null,githubUrl:row.github_url?publicURL(row.github_url):null},provenance:proof(doc,source.adapter)});}catch{}}
      return{...page(values.sort((a,b)=>a.url.localeCompare(b.url)),{cursor,limit,fingerprint:doc.evidence.sha256}),evidence:[doc.evidence]};
    },
    'github-guidance':async({source,lane,cursor,limit,signal,scanId})=>{
      if(!['skill','agent'].includes(lane))throw fail('Guidance trees require a skill or agent lane');
      const key=(scanId||'standalone')+':tree:'+source.repository;let bundle=cached(key);
      if(!bundle){
        const metadata=await read(`https://api.github.com/repos/${source.repository}`,signal),repo=json(metadata);
        if(repo.private!==false||repo.archived||repo.disabled||repo.html_url?.toLowerCase()!==`https://github.com/${source.repository}`.toLowerCase()||!pathSafe(repo.default_branch))throw fail('Guidance repository must have matching public active metadata',422);
        const commit=await read(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(repo.default_branch)}`,signal),revision=json(commit);if(!shaPattern.test(revision.sha||'')||!shaPattern.test(revision.commit?.tree?.sha||''))throw fail('Guidance commit has no complete source tree',502);
        const tree=await read(`https://api.github.com/repos/${source.repository}/git/trees/${revision.commit.tree.sha}?recursive=1`,signal),contents=json(tree);
        if(contents.truncated!==false||contents.sha!==revision.commit.tree.sha||!Array.isArray(contents.tree)||contents.tree.length>10000)throw fail('Guidance source tree is incomplete or exceeds 10,000 paths',422);
        bundle={metadata,repo,commit,revision,tree,contents};retainCache(key,bundle);
      }
      const {metadata,repo,commit,revision,tree,contents}=bundle;
      const values=contents.tree.filter(file=>file.type==='blob'&&['100644','100755'].includes(file.mode)&&pathSafe(file.path)&&shaPattern.test(file.sha||'')&&(lane==='skill'?/(?:^|\/)SKILL\.md$/.test(file.path):/\.agent\.md$/.test(file.path))).sort((a,b)=>a.path.localeCompare(b.path)).map(file=>({url:`https://github.com/${source.repository}/blob/${encoded(repo.default_branch)}/${encoded(file.path)}`,name:file.path.split('/').slice(-2).join('/'),sourceKind:'github-guidance',requestedResourceType:lane,guidance:{repository:source.repository,defaultBranch:repo.default_branch,revision:revision.sha,sourcePath:file.path,gitBlobSha:file.sha,bytes:Number.isSafeInteger(file.size)?file.size:null,sourceUrl:`https://raw.githubusercontent.com/${source.repository}/${revision.sha}/${encoded(file.path)}`,metadataEvidence:metadata.evidence,commitEvidence:commit.evidence,treeEvidence:tree.evidence},provenance:{adapter:source.adapter,sourceUrl:tree.url,evidence:[metadata.evidence,commit.evidence,tree.evidence],declaredArtifact:lane==='skill'?'SKILL.md':'.agent.md',rightsVerified:false}}));
      return{...page(values,{cursor,limit,fingerprint:tree.evidence.sha256}),evidence:[metadata.evidence,commit.evidence,tree.evidence]};
    },
    'public-reference':async({source,lane,cursor,signal})=>{
      if(cursor)throw fail('Reference sources have a single page');const doc=await read(source.url,signal);return{candidates:[{url:source.url,name:new URL(source.url).hostname,sourceKind:'public-reference',requestedResourceType:lane,provenance:proof(doc,source.adapter)}],nextCursor:null,exhausted:true,evidence:[doc.evidence]};
    }
  };
  return adapters;
}
