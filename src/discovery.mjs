import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { licenseInfo, stableId, searchTerms } from './store.mjs';
import { githubRepositoryKind } from './github-kind.mjs';
import { MAX_RAW_README_BYTES, rawReadmeDeclaration, verifyRawReadme } from './github-readme.mjs';

const stamp = () => new Date().toISOString();
const small = (s,n=4000) => typeof s==='string'?s.slice(0,n):'';
const errorMessage = error => small(error.message || String(error),600);
export function isPublicAddress(address) {
  if(isIP(address)===4) {
    const [a,b,c]=address.split('.').map(Number);
    if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127) return false;
    if(a===192&&b===0 || a===192&&b===88&&c===99 || a===198&&(b===18||b===19) || a===198&&b===51&&c===100 || a===203&&b===0&&c===113) return false;
    return true;
  }
  if(isIP(address)===6) {
    const s=address.toLowerCase();const [first,second]=s.split(':').map(x=>parseInt(x||'0',16));
    // Allow global unicast only. Exclude mapped, transition, documentation and special-use blocks.
    return /^[23]/.test(s)&&!(first===0x2001&&(second<0x200||second===0xdb8))&&first!==0x2002&&first!==0x3fff;
  }
  return false;
}
export function validatePublicURL(value) {
  let url; try {url=new URL(value);} catch {throw new Error('Invalid URL');}
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(url.protocol!=='https:' || url.username || url.password || url.port && url.port!=='443') throw new Error('Only public HTTPS URLs on port 443 without credentials are allowed');
  if(!host.includes('.')&&!isIP(host) || host.endsWith('.localhost') || host==='localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid')) throw new Error('Local or reserved hostnames are blocked');
  if(isIP(host)&&!isPublicAddress(host)) throw new Error('Private, local and reserved IP addresses are blocked');
  url.hash=''; return url;
}
export function isFixedConnectorURL(url) {
  return url.hostname==='registry.directory'&&(/^\/(directory|items)\.json$/.test(url.pathname)||/^\/api\/markdown\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)) || url.hostname==='api.github.com'&&(/^\/search\/repositories$/.test(url.pathname)||/^\/repos\/[^/]+\/[^/]+(?:\/(?:commits\/[^/]+|license|readme))?$/.test(url.pathname));
}
async function fetchFixedConnector(url,{maxBytes,timeoutMs,redirects,proxyFetch=fetch,signal}) {
  if(!isFixedConnectorURL(url))throw new Error('Proxy fallback is restricted to fixed public catalogue connector endpoints');
  const response=await proxyFetch(url.href,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{'User-Agent':'Glasses-Local/0.1','Accept':'application/json,text/plain'}});
  if([301,302,303,307,308].includes(response.status)) {
    await response.body?.cancel();if(redirects<=0)throw new Error('Too many redirects');
    const next=validatePublicURL(new URL(response.headers.get('location'),url).href);
    if(!isFixedConnectorURL(next))throw new Error('Fixed connector redirect left the permitted endpoint set');
    return fetchFixedConnector(next,{maxBytes,timeoutMs,redirects:redirects-1,proxyFetch,signal});
  }
  if(!response.ok){await response.body?.cancel();throw new Error(`HTTP ${response.status} from ${url.hostname}`);}
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new Error(`Response exceeds ${maxBytes} bytes`);chunks.push(chunk);}
  return {url:url.href,body:Buffer.concat(chunks).toString('utf8'),contentType:response.headers.get('content-type')||'',status:response.status,transport:'environment-proxy-fixed-connector'};
}
export async function fetchPublic(value,{maxBytes=16*1024*1024,timeoutMs=20000,redirects=3,resolver=lookup,proxyFetch=fetch,signal,allowFixedProxy=process.env.NODE_USE_ENV_PROXY==='1'&&Boolean(process.env.HTTPS_PROXY||process.env.https_proxy)}={}) {
  signal?.throwIfAborted();
  const url=validatePublicURL(value);
  const host=url.hostname.replace(/^\[|\]$/g,'');
  let addresses;
  try{addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host,{all:true,verbatim:true});}
  catch(error){
    signal?.throwIfAborted();
    if(allowFixedProxy&&isFixedConnectorURL(url)&&['EAI_AGAIN','ENOTFOUND'].includes(error.code))return fetchFixedConnector(url,{maxBytes,timeoutMs,redirects,proxyFetch,signal});
    throw error;
  }
  signal?.throwIfAborted();
  if(!addresses.length||addresses.some(x=>!isPublicAddress(x.address))) throw new Error('DNS resolved to a blocked or private address');
  const selected=addresses.find(x=>x.family===4)||addresses[0];
  const result=await new Promise((resolve,reject)=>{
    const request=https.get(url,{
      agent:new https.Agent({proxyEnv:{},keepAlive:false}),signal,
      headers:{'User-Agent':'Glasses-Local/0.1 (+local discovery; no execution)','Accept':'application/json,text/html,text/plain;q=0.9','Accept-Encoding':'identity'},
      lookup:(_hostname,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family)
    },response=>{
      if([301,302,303,307,308].includes(response.statusCode)) {response.resume();resolve({redirect:response.headers.location});return;}
      if(response.statusCode<200||response.statusCode>=300) {response.resume();reject(new Error(`HTTP ${response.statusCode} from ${url.hostname}`));return;}
      const parts=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){request.destroy(new Error(`Response exceeds ${maxBytes} bytes`));return;}parts.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>resolve({url:url.href,body:Buffer.concat(parts).toString('utf8'),contentType:response.headers['content-type']||'',status:response.statusCode}));
    });
    const deadline=setTimeout(()=>request.destroy(new Error(`Fetch timeout after ${timeoutMs}ms`)),timeoutMs);
    request.on('close',()=>clearTimeout(deadline));request.on('error',reject);
  });
  if(result.redirect){if(redirects<=0)throw new Error('Too many redirects');return fetchPublic(new URL(result.redirect,url).href,{maxBytes,timeoutMs,redirects:redirects-1,resolver,proxyFetch,allowFixedProxy,signal});}
  return result;
}
const asJSON = doc => {try{return JSON.parse(doc.body);}catch{throw new Error('Source returned invalid JSON');}};
const publicHref = value => {try{return validatePublicURL(value).href;}catch{return null;}};
// GitHub's public site routes are not repository owners. In particular,
// /topics/react-dashboard must remain a retained reference page rather than
// becoming a request for the nonexistent repository topics/react-dashboard.
const githubSiteRoutes=new Set([
  'about','account','apps','blog','business','codespaces','collections','contact',
  'copilot','customer-stories','customers','dashboard','discussions','education',
  'enterprise','events','explore','features','issues','join','login',
  'logout','marketplace','new','notifications','orgs','organizations','pricing',
  'pulls','readme','search','security','sessions','settings','site','solutions',
  'sponsors','stars','team','topics','trending','users'
]);
const repoParts = value => {
  try {
    const url=new URL(value);
    if(url.hostname!=='github.com')return null;
    const match=url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if(!match)return null; // Preserve exact blob/tree and other deep links as references.
    const owner=decodeURIComponent(match[1]),repo=decodeURIComponent(match[2]).replace(/\.git$/i,'');
    if(githubSiteRoutes.has(owner.toLowerCase()))return null;
    // Decoding before validation prevents encoded route names or delimiters
    // from being mistaken for API path components. No new URL trust is granted.
    // Existing GitHub accounts can end in a hyphen (for example mjl-).
    // Keep the alphanumeric start, bounded length and delimiter exclusion.
    if(!/^[a-z\d][a-z\d-]*$/i.test(owner)||owner.length>39||!repo||repo.length>100||!/^[-\w.]+$/.test(repo))return null;
    return [owner,repo];
  } catch {return null;}
};
const validStars=value=>Number.isSafeInteger(value)&&value>=0;
function githubMetrics(repo,fetchedAt) {
  const stars=validStars(repo.stargazers_count)?repo.stargazers_count:null;
  return {stars,starsFetchedAt:stars===null?null:fetchedAt||null,fork:typeof repo.fork==='boolean'?repo.fork:null,disabled:typeof repo.disabled==='boolean'?repo.disabled:null};
}
function githubRecord(repo,sourceUrl,fetchedAt) {
  const words=`${repo.name||''} ${repo.description||''} ${(repo.topics||[]).join(' ')}`.toLowerCase();
  const kind=githubRepositoryKind(repo);
  return {name:repo.full_name||repo.name,url:repo.html_url,description:repo.description||'Public repository; inspect upstream for applicability.',kind,provider:'GitHub',tags:(repo.topics||[]).slice(0,25),...licenseInfo(repo.license),licenseEvidence:{status:'metadata-only',sourceUrl:repo.license?.url||sourceUrl,spdx:repo.license?.spdx_id||null,scope:'repository'},github:{defaultBranch:repo.default_branch||'HEAD',archived:!!repo.archived,pushedAt:repo.pushed_at||null,...githubMetrics(repo,fetchedAt)},framework:/react/.test(words)?'React':null,origin:'live',provenance:{sourceUrl,fetchedAt:stamp(),revision:repo.default_branch?`branch:${repo.default_branch}; pushed:${repo.pushed_at||'unknown'}`:undefined,note:'GitHub repository metadata. Stars are an observed popularity signal, not licence, security or suitability approval. Classification is a keyword heuristic.'}};
}

// Backfill only missing popularity fields from the record's existing, exact
// GitHub metadata response. No network request, source-body or rights mutation.
export function backfillGitHubMetadata(store,{ids}={}) {
  const items=ids?ids.map(id=>store.getCapability(id)).filter(Boolean):store.search();
  const parsed=new Map(),report={examined:0,updated:0,evidenceReads:0,unavailable:0};
  for(const summary of items){
    if(summary.origin!=='live'||!repoParts(summary.url))continue;
    if(validStars(summary.github?.stars)&&summary.github?.starsFetchedAt&&typeof summary.github?.fork==='boolean'&&typeof summary.github?.disabled==='boolean')continue;
    report.examined++;
    const ref=summary.metadataEvidence;
    if(!ref?.id){report.unavailable++;continue;}
    if(!parsed.has(ref.id)){
      const snapshot=store.getEvidence(ref.id);report.evidenceReads++;
      let value=null;
      try{
        const url=new URL(snapshot.url);
        if(url.hostname==='api.github.com'&&(/^\/repos\/[^/]+\/[^/]+\/?$/.test(url.pathname)||url.pathname==='/search/repositories')&&createHash('sha256').update(snapshot.body).digest('hex')===snapshot.sha256){
          const data=JSON.parse(snapshot.body),rows=Array.isArray(data.items)?data.items:[data];
          value={snapshot,repositories:new Map(rows.filter(repo=>repoParts(repo?.html_url)).map(repo=>[repoParts(repo.html_url).join('/').toLowerCase(),repo]))};
        }
      }catch{}
      parsed.set(ref.id,value);
    }
    const cached=parsed.get(ref.id),repo=cached?.repositories.get(repoParts(summary.url).join('/').toLowerCase());
    if(!repo||ref.sha256!==cached.snapshot.sha256){report.unavailable++;continue;}
    const item=store.getCapability(summary.id),metrics=githubMetrics(repo,cached.snapshot.lastFetchedAt||cached.snapshot.firstFetchedAt),previous=item.github||{};
    const github={...previous,stars:validStars(previous.stars)?previous.stars:metrics.stars,starsFetchedAt:validStars(previous.stars)?previous.starsFetchedAt||(previous.stars===metrics.stars?metrics.starsFetchedAt:null):metrics.starsFetchedAt,fork:typeof previous.fork==='boolean'?previous.fork:metrics.fork,disabled:typeof previous.disabled==='boolean'?previous.disabled:metrics.disabled};
    if(JSON.stringify(github)!==JSON.stringify(previous)){store.upsertCapability({...item,github});report.updated++;}
  }
  return report;
}

export function githubSearchQuery(query) {
  // Quoted literals are not qualifier overrides. Preserve the actual user text.
  const qualifiers=query.replace(/"(?:\\.|[^"\\])*"/g,' ');
  return [query.trim(),...['archived','fork'].filter(key=>!new RegExp(`(?:^|\\s)-?${key}:`,'i').test(qualifiers)).map(key=>`${key}:false`)].filter(Boolean).join(' ');
}
const GITHUB_PAGE_SIZE=20,GITHUB_MAX_PAGES=50,GITHUB_HEAD_REFRESH_MS=7*24*60*60*1000;
function githubSearchPage(store,query) {
  const saved=store.getSetting('githubSearchCursors',{}),key=stableId(query),previous=saved[key];
  const next=Number.isInteger(previous?.nextPage)&&previous.nextPage>=1&&previous.nextPage<=GITHUB_MAX_PAGES?previous.nextPage:1;
  const headRefresh=next!==1&&(!previous?.lastHeadAt||Date.now()-Date.parse(previous.lastHeadAt)>=GITHUB_HEAD_REFRESH_MS);
  return {saved,key,previous,next,page:headRefresh?1:next,headRefresh};
}
function advanceGitHubPage(store,cursor,data) {
  const knownTotal=Number.isFinite(data.total_count)&&data.total_count>=0;
  const pages=knownTotal?Math.max(1,Math.min(GITHUB_MAX_PAGES,Math.ceil(data.total_count/GITHUB_PAGE_SIZE))):data.items.length<GITHUB_PAGE_SIZE?cursor.page:Math.min(GITHUB_MAX_PAGES,cursor.page+1);
  const nextPage=cursor.headRefresh?Math.min(cursor.next,pages):cursor.page>=pages?1:cursor.page+1;
  const updated={...cursor.saved,[cursor.key]:{nextPage,lastUsedAt:stamp(),lastHeadAt:cursor.page===1?stamp():cursor.previous?.lastHeadAt||null}};
  const bounded=Object.fromEntries(Object.entries(updated).sort((a,b)=>(b[1].lastUsedAt||'').localeCompare(a[1].lastUsedAt||'')).slice(0,100));
  store.setSetting('githubSearchCursors',bounded);
}
export function extractPreviewSource(files) {
  const scripts=files.filter(f=>/\.[jt]sx?$/.test(f.path||f.name||'')&&typeof f.content==='string');
  const exportedComponent=source=>{
    const direct=source.match(/export\s+(?:function|const|class)\s+([A-Z][A-Za-z0-9_]*)/)?.[1];if(direct)return direct;
    for(const block of source.matchAll(/export\s*\{([^}]+)\}/g))for(const entry of block[1].split(',')){
      const name=entry.trim().match(/^([A-Z][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z0-9_]+)?$/)?.[1];
      if(name&&new RegExp(`\\b(?:function|const|class)\\s+${name}\\b`).test(source))return name;
    }
    return null;
  };
  const first=scripts.find(f=>/export\s+default\b/.test(f.content)||exportedComponent(f.content));
  if(!first) return {};
  let source=first.content, note='Original fetched source; imports are checked when preview is compiled.';
  if(!/export\s+default\b/.test(source)) {const name=exportedComponent(source);if(!name)return {};source+=`\n// Glasses preview adapter: expose the fetched named export.\nexport default ${name};\n`;note=`Original source plus a default-export adapter for ${name}.`;}
  const css=files.filter(f=>/\.css$/.test(f.path||f.name||'')).map(f=>f.content||'').join('\n');
  const entryPath=first.path||first.name;
  return {previewSource:source,previewCss:css,previewProps:{},previewEntryPath:entryPath,previewFiles:files.map(file=>({path:file.path||file.name,content:(file.path||file.name)===entryPath?source:file.content})),sourceEvidence:{path:entryPath,sha256:createHash('sha256').update(first.content).digest('hex'),note,files:files.map(file=>({path:file.path||file.name,sha256:createHash('sha256').update(file.content).digest('hex'),bytes:Buffer.byteLength(file.content)}))}};
}
export function normalizeScoutQuery(query) {
  if(/(?:^|\s)-?[a-z][\w-]*:/i.test(query.replace(/"(?:\\.|[^"\\])*"/g,' ')))return query.trim();
  if(/\b(memory|memories|forget\w*|remember\w*|recall)\b/i.test(query))return 'agent memory';
  if(/\b(deploy\w*|vercel)\b/i.test(query))return /\b(local|self.host\w*)\b/i.test(query)?'self-hosted deployment':'deployment';
  return searchTerms(query).slice(0,5).join(' ')||'topic:developer-tools archived:false';
}

function registrySourceFiles(data,limit) {
  const selected=Array.isArray(data.files)?data.files.filter(file=>file&&typeof file.content==='string'&&file.content.length<=150000).slice(0,limit):[];
  return {files:selected.map(file=>({path:small(file.path||file.name,300),content:file.content})),sourceFileMetadata:selected.map(file=>({path:small(file.path||file.name,300),...(typeof file.target==='string'?{target:small(file.target,1000)}:{}),...(typeof file.type==='string'?{type:small(file.type,100)}:{})}))};
}

function markdownDependencies(body,source) {
  // Dependency declarations are evidence only. Never derive or fetch child URLs here.
  const metadata=body.includes('## Files')?body.slice(0,body.indexOf('## Files')):body.split(/^```/m)[0];
  const links=[],raw={};
  const readList=(label,kind)=>{
    const value=metadata.match(new RegExp(`^\\s*[-*]\\s*\\*\\*${label}\\*\\*:\\s*([^\\r\\n]*)$`,'mi'))?.[1];
    if(value===undefined)return [];
    raw[kind]=small(value,12000);
    const quoted=[];
    const protectedValue=value.replace(/\[([^\]\r\n]*)\]\(([^)\r\n]+)\)|`([^`\r\n]+)`/g,(_,name,url,code)=>{
      quoted.push(url===undefined?{value:code}:{value:kind==='registry'?url.trim():name.trim(),link:{kind,name:name.trim(),url:url.trim()}});
      return `\u0000${quoted.length-1}\u0000`;
    });
    return [...new Set(protectedValue.split(',').map(token=>{
      const protectedToken=token.trim().match(/^\u0000(\d+)\u0000$/);
      if(protectedToken){const entry=quoted[Number(protectedToken[1])];if(entry.link)links.push(entry.link);return entry.value;}
      // registry.directory serializes array dependencies as "0@package, 1@@scope/package".
      return token.trim().replace(/^\d+@(?=[@a-zA-Z])/,'');
    }).filter(value=>value&&!/^(?:none|n\/a)$/i.test(value)).map(value=>small(value,1000)))].slice(0,100);
  };
  const dependencies=readList('NPM Dependencies','npm'),registryDependencies=readList('Registry Dependencies','registry');
  return {dependencies,registryDependencies,dependencyMetadata:{sourceUrl:source.url,evidenceId:source.evidence.id,raw,links:links.slice(0,100),note:'Declarations retained from the source response; registry.directory numeric NPM list prefixes are normalized. No child source was fetched, installed or compatibility-approved.'}};
}

export function createDiscovery({store,fetcher=fetchPublic}={}) {
  backfillGitHubMetadata(store);
  let scouting=false;
  const requestContext=new AsyncLocalStorage();
  const idleWaiters=new Set();
  const read=async(url,options={})=>{
    const signal=requestContext.getStore();signal?.throwIfAborted();validatePublicURL(url);
    let doc;try{doc=await fetcher(url,{...options,signal});}catch(error){if(error&&typeof error==='object')error.sourceUrl=url;throw error;}
    signal?.throwIfAborted();return {...doc,evidence:store.retainEvidence({...doc,url:doc.url||url})};
  };
  const failureState=error=>{
    // This aggregator turns any failed origin source fetch (including HTTP 401)
    // into HTTP 404. That does not establish that the indexed item was removed.
    if(/HTTP 404\b/.test(errorMessage(error))&&/^https:\/\/registry\.directory\/api\/markdown\//.test(error.sourceUrl||''))return 'error';
    return /HTTP (404|410)\b/.test(errorMessage(error))?'removed':/supported source|no supported exported|schema|no registry items|content encoding/i.test(errorMessage(error))?'unsupported':'error';
  };
  const sourceStatus=(name,url,error,count=0)=>store.saveSource({id:stableId(url),name,url,status:error?failureState(error):'ok',lastCheckedAt:stamp(),count,error:error?errorMessage(error):null});
  const rememberFailure=(item,error)=>{
    const attemptedUrl=error.sourceUrl||item.provenance?.sourceCodeUrl||item.sourceItemUrl||item.url;
    const state={status:failureState(error),checkedAt:stamp(),error:errorMessage(error),attemptedUrl,retainedPreviousSource:!!item.sourceFiles?.length};
    sourceStatus(`${item.name} source`,attemptedUrl,error);
    return store.upsertCapability({...item,sourceError:state.error,sourceState:state,sourceHistory:[...(item.sourceHistory||[]),state].slice(-20)}).item;
  };
  const saveSource=(item,doc,files,extra={})=>{
    const extraction=extractPreviewSource(files);
    const state={status:extraction.previewSource?'ok':'unsupported',checkedAt:stamp(),error:extraction.previewSource?null:'Fetched source files have no supported exported React component.',retainedPreviousSource:false};
    sourceStatus(`${item.name} source`,doc.url||item.url,state.error?new Error(state.error):null,files.length);
    const previous=store.getCapability(stableId(item.url));
    const pinned=item.licenseEvidence?.scope==='exact-repository-files'?item:previous;
    const changedPinnedSource=pinned?.licenseEvidence?.scope==='exact-repository-files'&&doc.evidence.sha256!==pinned.provenance?.sourceHash;
    const licence=changedPinnedSource?{license:null,licenseEvidence:{status:'unverified-current-source',scope:'current-source',previous:pinned.licenseEvidence,note:'Current fetched source differs from the previously pinned repository source. Previous licence evidence is retained but does not establish the new source rights.'}}:{};
    const preview=extraction.previewSource?extraction:{previewSource:null,previewFiles:[],previewCss:'',previewProps:{},previewEntryPath:null,sourceEvidence:{files:files.map(file=>({path:file.path||file.name,sha256:createHash('sha256').update(file.content).digest('hex'),bytes:Buffer.byteLength(file.content)})),note:state.error}};
    return store.upsertCapability({...item,...extra,...licence,...preview,sourceFiles:files,sourceError:state.error,sourceState:state,sourceHistory:[...(item.sourceHistory||previous?.sourceHistory||[]),state].slice(-20),sourceDocumentEvidence:doc.evidence,provenance:{...item.provenance,...(changedPinnedSource?{resolvedRevision:null,previousPinnedRevision:pinned.provenance?.resolvedRevision,previousPinnedFileEvidence:pinned.provenance?.pinnedFileEvidence,pinnedFileEvidence:null}:{}),sourceCodeUrl:doc.url||item.url,sourceFetchedAt:stamp(),sourceHash:doc.evidence.sha256,sourceEvidenceId:doc.evidence.id}}).item;
  };
  const attachRepository=async(item)=>{
    const parts=repoParts(item.url);if(!parts)return item;
    const endpoint=`https://api.github.com/repos/${parts.map(encodeURIComponent).join('/')}`;
    const commitDoc=await read(`${endpoint}/commits/${encodeURIComponent(item.github?.defaultBranch||'HEAD')}`),commit=asJSON(commitDoc);
    if(!/^[a-f0-9]{40}$/.test(commit.sha||''))throw new Error('GitHub commit schema missing exact revision');
    const files=[],evidence=[],errors=[];let licence=item.licenseEvidence,repositoryReadmeProof=null;
    for(const resource of ['license','readme']) {
      const url=`${endpoint}/${resource}?ref=${commit.sha}`;
      try {
        const doc=await read(url),data=asJSON(doc);
        let content;
        if(resource==='readme'&&data.encoding==='none'){
          const identity={repository:parts.join('/'),revision:commit.sha},declared=rawReadmeDeclaration(doc,identity);
          const raw=await read(declared.url,{maxBytes:MAX_RAW_README_BYTES,redirects:0});verifyRawReadme(raw,doc,identity);
          content=raw.body;evidence.push(doc.evidence,raw.evidence);
          repositoryReadmeProof={apiEvidence:doc.evidence,rawEvidence:raw.evidence,revision:commit.sha,path:declared.path,bytes:declared.bytes,gitBlobSha:declared.gitBlobSha};
        }else{
          if(data.encoding!=='base64'||typeof data.content!=='string')throw new Error('Unsupported repository content encoding');
          content=Buffer.from(data.content,'base64').toString('utf8');evidence.push(doc.evidence);
        }
        files.push({path:data.path||resource.toUpperCase(),content});
        if(resource==='license')licence={status:'fetched',scope:'repository',sourceUrl:url,revision:commit.sha,spdx:data.license?.spdx_id||null,path:data.path,sha256:createHash('sha256').update(content).digest('hex'),evidenceId:doc.evidence.id,note:'Exact repository licence text retained. This is licence evidence, not legal or security approval.'};
        sourceStatus(`${item.name} ${resource}`,url,null,1);
      }catch(error){
        sourceStatus(`${item.name} ${resource}`,url,error);errors.push({resource,url,error:errorMessage(error),status:failureState(error)});
        if(resource==='license'&&licence?.status==='fetched'&&licence.revision!==commit.sha)licence={status:'unverified-current-source',scope:'repository',previous:licence,revision:commit.sha,note:'Licence retrieval failed for this new revision. Prior licence evidence is retained but has not been verified for the current revision.'};
      }
    }
    const state={status:errors.length?'partial':'ok',checkedAt:stamp(),errors};
    return store.upsertCapability({...item,license:licence?.status==='unverified-current-source'?null:licence?.status==='fetched'?licence.spdx:item.license,licenseEvidence:licence,repositoryFiles:files,repositoryEvidence:[commitDoc.evidence,...evidence],repositoryReadmeProof,sourceState:state,sourceError:errors.length?errors.map(x=>`${x.resource}: ${x.error}`).join('; '):null,sourceHistory:[...(item.sourceHistory||[]),state].slice(-20),provenance:{...item.provenance,resolvedRevision:commit.sha,repositoryFetchedAt:stamp(),commitEvidenceId:commitDoc.evidence.id}}).item;
  };
  const attachSource=async(item,{force=false}={})=>{
    let doc,files;
    if(['skill','agent'].includes(item.details?.resourceType)&&item.details?.sourceUrl){
      const match=item.details.sourceUrl.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/([a-f0-9]{40})\/(.+)$/);
      if(!match||match[4].split('/').some(part=>{try{return !part||['.','..'].includes(decodeURIComponent(part))||/[\\\x00]/.test(decodeURIComponent(part));}catch{return true;}}))throw new Error('Agent guidance requires a pinned public source file');
      const sourceUrl=`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
      const reference=(item.detailsCitations||item.sharedCitations||[]).find(ref=>ref.kind==='github-artifact-document'&&ref.endpoint===sourceUrl&&ref.recordUrl===item.url);
      if(!reference)throw new Error('Agent guidance has no matching published source hash; inspect its source link');
      doc=await read(sourceUrl);
      if(doc.evidence.sha256!==reference.sha256)throw new Error('Agent guidance bytes differ from the published source hash');
      if(doc.body.length>150000)throw new Error('Agent guidance exceeds the inline source limit; use the reviewed download bundle');
      return {...item,guidanceSource:{url:sourceUrl,revision:match[3],path:match[4],sha256:doc.evidence.sha256,content:doc.body},guidanceNotice:'Untrusted upstream agent instructions, returned as data. No instructions were executed, installed or added to your agent. Review supporting files and permissions before adoption.'};
    }
    if(!force&&item.sourceState?.status==='ok'&&Date.now()-Date.parse(item.sourceState.checkedAt)<24*60*60*1000){
      // Make older retained Markdown useful without refetching or changing source identity.
      if(!item.dependencyMetadata){
        const evidenceId=item.sourceDocumentEvidence?.id||item.provenance?.sourceEvidenceId;
        const retained=evidenceId?store.getEvidence(evidenceId):null;
        if(retained&&/markdown/i.test(retained.contentType)&&retained.sha256===item.provenance?.sourceHash)return store.upsertCapability({...item,...markdownDependencies(retained.body,{...retained,evidence:retained})}).item;
      }
      return item;
    }
    if(repoParts(item.url))return attachRepository(item);
    if(item.sourceItemUrl) {
      doc=await read(item.sourceItemUrl);const data=asJSON(doc);
      const extracted=registrySourceFiles(data,30);files=extracted.files;
      if(!files.length)throw new Error('Source document has no supported source files; inspect the upstream item.');
      return saveSource(item,doc,files,{sourceFileMetadata:extracted.sourceFileMetadata,dependencies:data.dependencies||[],registryDependencies:data.registryDependencies||[],...(data.license?{...licenseInfo(data.license),licenseEvidence:{status:'metadata-only',scope:'registry-item',sourceUrl:doc.url||item.sourceItemUrl,spdx:data.license,evidenceId:doc.evidence.id}}:{})});
    }
    const match=item.url.match(/^https:\/\/registry\.directory\/([^/]+)\/([^/]+)\/([^/?#]+)\/?$/);
    if(match) {
      const sourceUrl=`https://registry.directory/api/markdown/${match[1]}/${match[2]}/${match[3]}`;
      doc=await read(sourceUrl);
      files=[];
      const fileSection=doc.body.includes('## Files')?doc.body.slice(doc.body.indexOf('## Files')):doc.body;
      for(const [_,path,lang,content] of fileSection.matchAll(/###\s+([^\n]+)\n+```(tsx|jsx|typescript|javascript|css)[^\n]*\n([\s\S]*?)```/g))files.push({path:small(path.trim(),300),content});
      if(!files.length)for(const [_,lang,content] of fileSection.matchAll(/```(tsx|jsx|typescript|javascript|css)[^\n]*\n([\s\S]*?)```/g))files.push({path:`source-${files.length}.${lang==='css'?'css':lang==='jsx'?'jsx':'tsx'}`,content});
      if(!files.length) throw new Error('Source document has no supported source blocks; inspect the upstream item.');
      return saveSource(item,doc,files,markdownDependencies(doc.body,doc));
    }
    return item;
  };
  const api={
    get scouting(){return scouting;},
    whenIdle(){return scouting?new Promise(resolve=>idleWaiters.add(resolve)):Promise.resolve();},
    async inspect(id,{fetchSource=false,refreshSource=false}={}) {
      backfillGitHubMetadata(store,{ids:[id]});
      let item=store.getCapability(id); if(!item)return null;
      if(fetchSource||refreshSource) {
        try{
          if(refreshSource&&repoParts(item.url)){
            const endpoint=`https://api.github.com/repos/${repoParts(item.url).map(encodeURIComponent).join('/')}`;
            const doc=await read(endpoint),repo=asJSON(doc);
            if(repo.private!==false||!repo.html_url||repo.html_url.toLowerCase()!==item.url.replace(/\/$/,'').toLowerCase())throw new Error('Repository refresh requires matching public metadata; inspect an upstream rename before replacing the catalogue identity.');
            const refreshed=githubRecord(repo,endpoint,doc.evidence.lastFetchedAt);
            item=store.upsertCapability({...item,...refreshed,url:item.url,kind:item.kind,metadataEvidence:doc.evidence,provenance:{...item.provenance,...refreshed.provenance}}).item;
          }
          item=await attachSource(item,{force:refreshSource});
        }catch(error){item=rememberFailure(item,error);}
      }
      return {...item,outcomes:store.outcomes(id)};
    },
    async importUrl(raw) {
      const url=validatePublicURL(raw).href;const parts=repoParts(url);
      if(parts){const endpoint=`https://api.github.com/repos/${parts.map(encodeURIComponent).join('/')}`;const doc=await read(endpoint),repo=asJSON(doc);if(!repo.html_url)throw new Error('GitHub did not return repository metadata');return store.upsertCapability({...githubRecord(repo,endpoint,doc.evidence.lastFetchedAt),metadataEvidence:doc.evidence}).item;}
      const registryItem=url.match(/^https:\/\/registry\.directory\/([^/]+)\/([^/]+)\/([^/?#]+)\/?$/);
      if(registryItem) {
        const provisional={name:decodeURIComponent(registryItem[3]),url,description:'Registry component requested for source inspection. Licence and suitability require review.',kind:'component',provider:`${registryItem[1]}/${registryItem[2]}`,tags:['registry','react'],license:null,framework:'React',origin:'live',provenance:{sourceUrl:url,fetchedAt:stamp(),note:'Requested registry item; original source and default-export adaptation are recorded separately.'}};
        // Persist only after a real source fetch succeeds; a failed URL is not live evidence.
        return attachSource(provisional);
      }
      const doc=await read(url);
      if(/json/.test(doc.contentType)||doc.body.trim().startsWith('{')) {
        const data=asJSON(doc);
        if(Array.isArray(data.files)) {
          const {files,sourceFileMetadata}=registrySourceFiles(data,20);
          return saveSource({name:data.title||data.name||new URL(url).hostname,url,sourceItemUrl:url,description:small(data.description)||'Registry component source imported for inspection.',kind:'component',provider:new URL(url).hostname,tags:['registry','imported','react'],...licenseInfo(data.license),licenseEvidence:{status:'metadata-only',scope:'registry-item',sourceUrl:url,spdx:data.license||null,evidenceId:doc.evidence.id},framework:'React',origin:'live',dependencies:data.dependencies||[],registryDependencies:data.registryDependencies||[],sourceFileMetadata,provenance:{sourceUrl:doc.url||url,fetchedAt:stamp(),revision:doc.evidence.sha256,note:'Registry source fetched as data. Not installed or approved; unsupported dependencies must be reviewed.'}},doc,files);
        }
      }
      const clean=s=>small((s||'').replace(/<[^>]+>/g,' ').replace(/&(?:quot|#34);/g,'"').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim());
      const title=clean(doc.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])||new URL(url).hostname;
      const description=clean(doc.body.match(/<meta[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)/i)?.[1]);
      let item=store.upsertCapability({name:title,url,description:description||'Imported public reference. No reusable-source or licence evidence established.',kind:'reference',provider:new URL(url).hostname,tags:['imported','reference'],license:null,framework:null,origin:'live',metadataEvidence:doc.evidence,provenance:{sourceUrl:doc.url||url,fetchedAt:stamp(),revision:doc.evidence.sha256,note:'Public page metadata only; website appearance does not grant reuse rights.'}}).item;
      if(/^https:\/\/registry\.directory\/[^/]+\/[^/]+\/[^/]+\/?$/.test(url)) {
        item=store.upsertCapability({...item,kind:'component',framework:'React'}).item;
        try{item=await attachSource(item);}catch(error){item=store.upsertCapability({...item,sourceError:errorMessage(error)}).item;}
      }
      return item;
    },
    async scout({query='',planSnapshot=null,trigger='manual'}={}) {
      if(scouting) throw Object.assign(new Error('A scout is already running'),{status:409});
      if(typeof query!=='string'||query.length>200)throw new Error('query must be a string of at most 200 characters');
      scouting=true;const snapshot=planSnapshot?JSON.parse(JSON.stringify(planSnapshot)):null;
      const terms=searchTerms(query),matchesBrief=(...values)=>!terms.length||terms.some(term=>values.flat().filter(value=>typeof value==='string').join(' ').toLowerCase().includes(term));
      const run={id:randomUUID(),status:'running',query,planId:snapshot?.id||null,planSnapshot:snapshot,trigger,researchMode:snapshot?'plan':query.trim()?'query':'broad',candidateIds:[],addedCandidateIds:[],updatedCandidateIds:[],resultNote:terms.length?'Candidate IDs link actual added or refreshed entries. Registry providers and items match at least one query term; repository results come from the recorded GitHub query. Text matches are not a semantic relevance or compatibility assessment.':'Candidate IDs link every entry added or refreshed during broad unfamiliar-provider and whole-solution exploration; no fit assessment is claimed.',added:0,updated:0,errors:[],startedAt:stamp(),finishedAt:null};store.saveRun(run);
      const save=input=>{
        const result=store.upsertCapability(input),id=result.item.id;
        if(!run.candidateIds.includes(id))run.candidateIds.push(id);
        const ids=result.added?run.addedCandidateIds:run.updatedCandidateIds;
        if(!ids.includes(id)&&!run.addedCandidateIds.includes(id))ids.push(id);
        run.added=run.addedCandidateIds.length;run.updated=run.updatedCandidateIds.length;
        store.saveRun(run);
        return result.item;
      };
      const attempt=async(name,url,operation)=>{try{const count=await operation();sourceStatus(name,url,null,count);}catch(error){run.errors.push(`${name}: ${errorMessage(error)}`);sourceStatus(name,url,error);}finally{store.saveRun(run);}};
      try {
        let registries=[];
        await attempt('Registry directory','https://registry.directory/directory.json',async()=>{
          const doc=await read('https://registry.directory/directory.json'),data=asJSON(doc);registries=Array.isArray(data.registries)?data.registries:[];
          if(!Array.isArray(data.registries))throw new Error('Unrecognised directory schema');
          for(const registry of registries.slice(0,200)) {
            const url=publicHref(registry.url);if(!url)continue;
            if(!matchesBrief(registry.name,registry.description,registry.namespace,registry.url,registry.tags))continue;
            save({name:registry.name,url,description:registry.description,kind:'reference',provider:'registry.directory',tags:['registry','react',...(registry.namespace?[registry.namespace]:[])],...licenseInfo(registry.license),framework:'React',origin:'live',registryUrl:publicHref(registry.registry_url),githubUrl:publicHref(registry.github_url),metadataEvidence:doc.evidence,provenance:{sourceUrl:'https://registry.directory/directory.json',fetchedAt:stamp(),note:'Discovered provider metadata. Provider listing is not a licence or security assessment.'}});
          }
          return registries.length;
        });
        let selected=[];
        await attempt('Cross-registry components','https://registry.directory/items.json',async()=>{
          const doc=await read('https://registry.directory/items.json'),data=asJSON(doc);if(!Array.isArray(data.items))throw new Error('Unrecognised item index schema');
          let candidates=data.items.filter(item=>item.name&&item.registry?.basePath&&(!terms.length||terms.some(term=>`${item.name} ${item.description||''} ${(item.categories||[]).join(' ')} ${item.registry.name}`.toLowerCase().includes(term))));
          const offset=store.getSetting('itemOffset',0);
          if(!terms.length){candidates.sort((a,b)=>stableId(a.registry.basePath+a.name).localeCompare(stableId(b.registry.basePath+b.name)));const cursor=offset%Math.max(candidates.length,1);candidates=[...candidates.slice(cursor),...candidates.slice(0,cursor)];}
          const providers=new Map();selected=candidates.filter(item=>{const count=providers.get(item.registry.name)||0;if(count>=10)return false;providers.set(item.registry.name,count+1);return true;}).slice(0,160);
          for(const entry of selected) {
            const base=String(entry.registry.basePath);if(!/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(base))continue;
            const url=`https://registry.directory${base}/${encodeURIComponent(entry.name)}`;
            const provider=registries.find(x=>x.name===entry.registry.name);
            save({name:entry.name,url,description:entry.description||'Component indexed by registry.directory. Inspect source before use.',kind:'component',provider:entry.registry.name,tags:['react',...(entry.categories||[]),...(entry.type?[entry.type]:[])],...licenseInfo(entry.license),framework:'React',origin:'live',githubUrl:publicHref(provider?.github_url),metadataEvidence:doc.evidence,provenance:{sourceUrl:'https://registry.directory/items.json',fetchedAt:stamp(),note:'Index metadata only. Licence is unknown unless explicitly supplied; no compatibility or security approval.'}});
          }
          store.setSetting('itemOffset',offset+160);return selected.length;
        });
        // Fetch a bounded subset of current provider registries, rotating between runs.
        const providersWithMatchingItems=new Set(selected.map(entry=>entry.registry.name));
        const available=registries.filter(x=>publicHref(x.registry_url)&&(!terms.length||matchesBrief(x.name,x.description,x.namespace,x.url,x.tags)||providersWithMatchingItems.has(x.name)));const cursor=store.getSetting('providerOffset',0);
        const chosen=available.length?[available[cursor%available.length],available[(cursor+1)%available.length]]:[];
        store.setSetting('providerOffset',cursor+2);
        for(const provider of [...new Map(chosen.map(x=>[x.registry_url,x])).values()]) await attempt(provider.name,provider.registry_url,async()=>{
          const doc=await read(provider.registry_url),data=asJSON(doc);if(!Array.isArray(data.items))throw new Error('Provider has no registry items');
          const entries=data.items.filter(entry=>matchesBrief(entry.name,entry.title,entry.description,entry.categories,entry.tags,provider.name)).slice(0,20);
          for(const entry of entries) {
            const url=publicHref(entry.url)||`${provider.url.replace(/\/$/,'')}/#glasses-item-${encodeURIComponent(entry.name||'unnamed')}`;
            const files=Array.isArray(entry.files)?entry.files.filter(f=>typeof f.content==='string'&&f.content.length<150000).slice(0,10):[];
            const sourceItemUrl=/\/registry\.json(?:\?.*)?$/.test(provider.registry_url)?publicHref(provider.registry_url.replace(/registry\.json(?:\?.*)?$/,`${encodeURIComponent(entry.name)}.json`)):null;
            save({name:entry.title||entry.name,url,sourceItemUrl,githubUrl:publicHref(provider.github_url),description:entry.description||'Provider registry metadata; source may require upstream retrieval.',kind:'component',provider:provider.name,tags:['react','registry'],...licenseInfo(entry.license),framework:'React',origin:'live',metadataEvidence:doc.evidence,...(files.length?{sourceFiles:files,...extractPreviewSource(files)}:{}),provenance:{sourceUrl:provider.registry_url,fetchedAt:stamp(),note:'Fetched provider registry. Missing licence evidence is retained as unknown.'}});
          }
          return entries.length;
        });
        run.githubQuery=snapshot?query.trim():normalizeScoutQuery(query);
        run.githubEffectiveQuery=githubSearchQuery(run.githubQuery);
        run.queryNote=(snapshot?'The saved research query and explicit qualifiers are preserved.':'GitHub query uses documented keyword rules for memory and deployment.')+' Missing archived/fork qualifiers default to false. Stars order repositories within the query; popularity is not a fit or rights assessment. Registry matching uses any explicit query term.';
        const githubCursor=githubSearchPage(store,run.githubEffectiveQuery);
        run.githubSearch={query:run.githubEffectiveQuery,sort:'stars',order:'desc',perPage:GITHUB_PAGE_SIZE,page:githubCursor.page,headRefresh:githubCursor.headRefresh,maximumSearchResults:1000};
        const githubURL=`https://api.github.com/search/repositories?q=${encodeURIComponent(run.githubEffectiveQuery)}&sort=stars&order=desc&per_page=${GITHUB_PAGE_SIZE}&page=${githubCursor.page}`;
        await attempt('GitHub public repositories',githubURL,async()=>{
          const doc=await read(githubURL),data=asJSON(doc);if(!Array.isArray(data.items))throw new Error('GitHub search schema unavailable');
          run.githubSearch.totalCount=Number.isFinite(data.total_count)&&data.total_count>=0?data.total_count:null;
          run.githubSearch.incompleteResults=data.incomplete_results===true;
          for(const repo of data.items.slice(0,GITHUB_PAGE_SIZE))if(publicHref(repo.html_url))save({...githubRecord(repo,githubURL,doc.evidence.lastFetchedAt),metadataEvidence:doc.evidence});
          if(run.githubSearch.incompleteResults)throw new Error('GitHub search returned incomplete results. Received candidates were retained; the page cursor was not advanced. Retry this query to complete the page.');
          advanceGitHubPage(store,githubCursor,data);
          return data.items.length;
        });
        // At most six source probes to tolerate stale index entries; stop after three source documents.
        let sourceSuccesses=0;
        for(const entry of selected.slice(0,6)) {
          const id=stableId(`https://registry.directory${entry.registry.basePath}/${encodeURIComponent(entry.name)}`);const item=store.getCapability(id);if(!item)continue;
          try {await attachSource(item);sourceSuccesses++;if(sourceSuccesses>=3)break;}catch(error){rememberFailure(item,error);run.errors.push(`${entry.name} source: ${errorMessage(error)}`);}
        }
        run.status=run.errors.length?(run.added+run.updated?'partial':'failed'):'completed';
      }catch(error){run.errors.push(errorMessage(error));run.status='failed';}
      finally {run.finishedAt=stamp();try{store.saveRun(run);}finally{scouting=false;for(const resolve of idleWaiters)resolve();idleWaiters.clear();}}
      return run;
    }
  };
  for(const name of ['scout','inspect','importUrl']){
    const operation=api[name];
    api[name]=function(...args){const options=name==='scout'?args[0]:args[1];return requestContext.run(options?.signal,()=>operation.apply(api,args));};
  }
  return api;
}
