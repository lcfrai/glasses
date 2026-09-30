// Pure public-source enrichment. No database, network, model, HTML rendering or
// source execution. Call only after the publisher's strict item projection.
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import { rawReadmeDeclaration, rawReadmeIdentity, verifyRawReadme } from './github-readme.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const id=value=>hash(value).slice(0,20);
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
const PUBLIC_KEYS=['id','url','name','description','kind','provider','tags','framework','license','github','observedAt','citations','assessment'];
const forbidden=/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|(?:\b[A-Z]:[\\/]|\\\\)[^\s]+|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function publicURL(value){
  if(typeof value!=='string'||value.length>4000)return null;
  try{const url=new URL(value),host=url.hostname.toLowerCase();return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&host.includes('.')&&!isIP(host)&&!host.includes(':')&&!/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)?url.href:null;}catch{return null;}
}
const repoURL=value=>{const url=publicURL(value);return url&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url)?url.replace(/\/$/,''):null;};
const repoKey=value=>repoURL(value)?.toLowerCase();
const words=value=>String(value||'').trim().split(/\s+/).filter(Boolean);
function bounded(value,maxCharacters,maxWords=Infinity){
  if(typeof value!=='string'||forbidden.test(value))return '';
  let clean=value.replace(/\s+/g,' ').trim();
  if(!clean)return '';
  const parts=words(clean);if(parts.length>maxWords)clean=parts.slice(0,maxWords).join(' ')+'…';
  if(clean.length>maxCharacters){clean=clean.slice(0,maxCharacters-1);const end=clean.lastIndexOf(' ');if(end>maxCharacters/2)clean=clean.slice(0,end);clean+='…';}
  return clean;
}
function prose(value){
  if(typeof value!=='string')return '';
  // Bare documented prop/key names are prose labels. Expressions, command lines
  // and signatures remain excluded rather than publishing implementation code.
  value=value.replace(/`([A-Za-z][\w-]{0,60})`/g,'$1');
  if(forbidden.test(value)||/`|[{}]|=>|<\/?[A-Za-z!]|!\[|^\s*(?:npx|npm|pnpm|yarn|bun|curl|wget|git clone|export |import |const |let |function |\$ |copyright\b|spdx\b|licen[cs]e\s*:|featured sponsor)/i.test(value))return '';
  if((value.match(/\]\(/g)||[]).length>1)return ''; // Navigation/badge rows.
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'').replace(/^[\s>*#-]+/,'').replace(/[*_~]/g,'').replace(/\s+/g,' ').trim();
}
function verified(source){
  if(!source||typeof source.body!=='string'||Buffer.byteLength(source.body)>16*1024*1024||source.status!==200||hash(source.body)!==source.sha256)return null;
  let url;try{url=new URL(source.url);}catch{return null;}
  const withoutQuery=new URL(url);withoutQuery.search='';withoutQuery.hash='';
  if(url.hash||!publicURL(withoutQuery.href)||source.id&&source.id!==id(`${source.url}\n${source.sha256}`))return null;
  const observedAt=date(source.lastFetchedAt||source.fetchedAt||source.firstFetchedAt);if(!observedAt)return null;
  let data=null;try{data=JSON.parse(source.body);}catch{}
  return{url:url.href,sha256:source.sha256,observedAt,body:source.body,data};
}
function reference(source,item,kind){
  const endpoint=new URL(source.url);endpoint.search='';endpoint.hash='';
  const fields={endpoint:endpoint.href,recordUrl:item.url,sha256:source.sha256};
  return{id:id(canonical(fields)),...fields,observedAt:source.observedAt,kind};
}
function packageNames(values,registry=false){
  if(!Array.isArray(values))return undefined;
  return [...new Set(values.filter(value=>typeof value==='string'&&!forbidden.test(value)&&value.length<=(registry?250:150)&&
    (registry&&publicURL(value)||/^(?:@[a-z\d_.-]+\/)?[a-z\d_.-]+(?:@[a-z\d.*+^~><=| :/-]+)?$/i.test(value))))].slice(0,20);
}
function directMetadata(data){
  const result={};if(!data||typeof data!=='object')return result;
  const overview=bounded(prose(data.description),800,100);if(overview)result.overview=overview;
  const keywords=[...new Set([data.tags,data.categories,data.meta?.tags].flatMap(values=>Array.isArray(values)?values:[]).filter(value=>typeof value==='string'&&value.length>0&&value.length<=80&&!forbidden.test(value)&&!/[\r\n`<>]/.test(value)))].slice(0,20);
  if(keywords.length)result.keywords=keywords;
  for(const name of ['dependencies','registryDependencies']){const values=packageNames(data[name],name==='registryDependencies');if(values)result[name]=values;}
  if(Array.isArray(data.files))result.sourceFileCount=data.files.filter(file=>file&&typeof file==='object'&&typeof file.path==='string').length;
  const docs=publicURL(data.documentationUrl||data.documentation_url||data.docs_url);if(docs)result.documentationUrl=docs;
  return result;
}
const excludedHeading=/\b(?:licen[cs]e|sponsor\w*|donat\w*|contribut\w*|acknowledge\w*|credits|changelog|release history|table of contents|security policy|code of conduct|support(?:ing)? (?:us|this|the project)|ambassadors|business inquiries|contact)\b/i;
const purposeHeading=/\b(?:overview|about|introduction|summary|what (?:it|this|is)|why|features?|highlights|capabilities|use cases|functionality|what.+does|feature map)\b/i;
const setupHeading=/\b(?:install\w*|setup|getting started|quick ?start|docker|gitpod|prerequisites|requirements|build from source|development environment)\b/i;
const featureHeading=/\b(?:features?|highlights|capabilities|functionality|what.+does|feature map)\b/i;
function sourceProse(raw){
  // Language/navigation rows and link-only labels are not product explanations.
  if(/^\s*(?:\[[^\]]+\]\([^)]*\)[\s|·•/]*)+$/.test(raw))return '';
  const value=prose(raw);
  if(/^(?:(?:English|简体中文|繁體中文|中文|日本語|한국어|Deutsch|Français|Español|Português)\s*(?:[|·•/]\s*|$))+$/i.test(value))return '';
  if(/^(?:Visit|Read|View|See|Check out|Follow|Join|Support)\s+(?:our|the|us|this)\b.*:\s*$/i.test(value))return '';
  return value;
}
function readmeContent(source){
  const data=source.data;if(data?.encoding!=='base64'||typeof data.content!=='string'||data.content.length>512000||!/^[A-Za-z\d+/=\s]+$/.test(data.content))return null;
  const result=Buffer.from(data.content,'base64').toString('utf8');return Buffer.byteLength(result)<=256000?result:null;
}
function readmeDetails(body){
  const cleaned=body.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
  const paragraphs=[],features=[],sections=[];let current=null,fence=null,excludedLevel=null;
  for(const raw of cleaned.split(/\r?\n/)){
    const mark=raw.match(/^\s*(`{3,}|~{3,})/);if(mark){if(!fence)fence=mark[1][0];else if(fence===mark[1][0])fence=null;continue;}if(fence)continue;
    const heading=raw.match(/^(#{1,6})\s+(.+)/);
    if(heading){
      const level=heading[1].length,title=bounded(prose(heading[2]),100,12);
      if(excludedLevel!==null&&level<=excludedLevel)excludedLevel=null;
      if(excludedHeading.test(title))excludedLevel=excludedLevel===null?level:Math.min(level,excludedLevel);
      current=title&&excludedLevel===null?{title,lines:[],level,order:sections.length}:null;
      if(current&&level>1)sections.push(current);continue;
    }
    if(excludedLevel!==null||/^\s{4}|^\s*[-=]{3,}\s*$/.test(raw))continue;
    if(/^\s*\|/.test(raw)){
      // Only a source's explicitly labelled feature table. Dependency matrices,
      // comparisons and arbitrary tables do not become capability claims.
      if(current&&featureHeading.test(current.title)){
        const cells=raw.trim().replace(/^\||\|$/g,'').split('|').map(cell=>sourceProse(cell.trim()));
        if(cells.length===2&&cells.every(Boolean)&&!cells.some(cell=>/^:?-{2,}:?$/.test(cell))
          &&!(/^(?:feature|capability|function|name)$/i.test(cells[0])&&/^(?:description|details?|purpose)$/i.test(cells[1])))features.push(cells.join(': '));
      }
      continue;
    }
    const value=sourceProse(raw);if(!value)continue;
    if(current){current.lines.push(value);if(current.level===1)paragraphs.push(value);}else paragraphs.push(value);
    if(current&&featureHeading.test(current.title)&&/^\s*(?:[-*+]|[✔✓✅])\s+/.test(raw))features.push(value.replace(/^[✔✓✅]\s*/,''));
  }
  const substantive=paragraphs.filter(line=>words(line).length>=5||line.length>=20);
  const introduction=substantive.length?substantive:sections.find(section=>purposeHeading.test(section.title)&&!featureHeading.test(section.title)&&section.lines.length)?.lines||[];
  const overviewLines=[];for(const line of introduction.slice(0,8)){
    overviewLines.push(line);const joined=overviewLines.join(' ');
    // A short complete purpose statement should not absorb the next navigation
    // or contact label. Wrapped prose can continue until its sentence ends.
    if(/[.!?。！？]$/.test(line)||words(joined).length>=55)break;
  }
  let overview=bounded(overviewLines.join(' '),800,55);
  if(overview&&!/[.!?。！？…]$/.test(overview)&&overviewLines.length<introduction.length)overview+='…';
  let remaining=180-words(overview).length;const output={...(overview?{overview}:{}),features:[],sections:[]};
  let featureWords=Math.min(70,remaining);
  for(const line of [...new Set(features)]){if(output.features.length>=8||featureWords<3)break;const value=bounded(line,180,Math.min(18,featureWords));if(value){output.features.push(value);const count=words(value).length;featureWords-=count;remaining-=count;}}
  // Lead with documented purpose/features, then functional sections, then setup.
  // Stable ordering within groups preserves the source author's organization.
  const rank=section=>purposeHeading.test(section.title)?0:setupHeading.test(section.title)?2:1;
  const functionalSections=sections.filter(section=>!(/^support(?:ing)?\b/i.test(section.title)&&/\b(?:sponsor\w*|donat\w*|funds|funding|patreon|financial support)\b/i.test(section.lines.join(' '))));
  for(const section of functionalSections.sort((a,b)=>rank(a)-rank(b)||a.order-b.order)){
    if(output.sections.length>=8||remaining<4)break;
    const title=bounded(section.title,100,Math.min(8,remaining-2)),summary=bounded(section.lines.slice(0,2).join(' '),280,Math.min(18,remaining-words(title).length));
    if(!title||!summary)continue;output.sections.push({title,summary});remaining-=words(title+' '+summary).length;
  }
  if(!output.features.length)delete output.features;if(!output.sections.length)delete output.sections;
  for(const match of cleaned.matchAll(/\[(documentation|docs|manual|user guide)\]\((https:\/\/[^\s)]+)\)/gi)){const url=publicURL(match[2]);if(url){output.documentationUrl=url;break;}}
  return output;
}
function documentationBlocks(source){
  const result=new Map();let name=null,lines=[];
  const save=()=>{if(name&&!result.has(name))result.set(name,lines);else if(name)result.set(name,null);};
  for(const line of source.body.split(/\r?\n/)){const match=line.match(/^##\s+([a-zA-Z\d_.-]+)\s+\[[^\]]+\]\s*$/);if(match){save();name=match[1];lines=[];}else if(name)lines.push(line);}save();return result;
}
function documentedComponent(lines,indexURL,name){
  if(!lines)return{};
  const origin=new URL(indexURL).origin;
  // The exact install identity connects the prose block to the declared registry.
  const install=lines.find(line=>/^install:\s*/i.test(line));
  if(!install||!(install.match(/https:\/\/[^\s]+/g)||[]).some(value=>publicURL(value)===`${origin}/r/${name}.json`))return{};
  const when=lines.find(line=>/^use when:\s*/i.test(line)),result={sections:[]};
  if(when){const summary=bounded(prose(when.replace(/^use when:\s*/i,'')),280,45);if(summary)result.sections.push({title:'When to use',summary});}
  const props=[];let inProps=false;
  for(const line of lines){
    if(/^props:\s*/i.test(line)){
      inProps=true;const inline=line.replace(/^props:\s*/i,'');
      const names=[...inline.matchAll(/(?:^|[;,]\s*)([A-Za-z_$][\w$]*)\??:/g)].map(match=>match[1]);
      if(names.length)props.push('Declared props: '+names.join(', '));
      const extended=inline.match(/^\(extends ([A-Za-z_$][\w$]*)/);if(extended)props.push('Extends: '+extended[1]);
      continue;
    }if(inProps&&/^[a-z][a-z ]*:/i.test(line))break;
    if(inProps){const match=line.match(/^\s+([A-Za-z_$][\w$]*)\??:\s*.+?\s+\/\/\s+(.+)$/);if(match){const description=bounded(prose(match[2]),120,15);if(description)props.push(`${match[1]}: ${description}`);}}
  }
  if(props.length)result.sections.push({title:'Documented props',summary:bounded(props.slice(0,6).join('; '),280,45)});
  if(!result.sections.length)delete result.sections;return result;
}
function declaredResourceType(overview){
  if(typeof overview!=='string')return null;
  const declaration=overview.replace(/^(?:(?:This (?:project|repository)|[A-Za-z][\w./-]{0,50}) (?:is|provides) |This is )/i,'');
  if(/^(?:an? |the )?(?:curated )?(?:collection|library|catalogue) of (?:[A-Za-z-]+ ){0,4}(?:skills|agents|components)\b/i.test(declaration))return 'collection';
  if(/^(?:an? |the )?(?:(?:curated|awesome|comprehensive|community[ -](?:maintained|driven)) )?(?:list|collection|directory|catalogue|catalog) of\b/i.test(declaration))return 'collection';
  if(/^(?:an? |the )?(?:specification and documentation|documentation|specification|tutorial|guide|reference)\b/i.test(declaration))return 'reference';
  // An explicitly enumerated teaching resource differs from notebook software.
  // Mentioning notebook support or bundling examples never establishes this type.
  if(/^(?:[\w ()/-]{1,80}: )?\d{1,4} (?:runnable|educational|tutorial) Jupyter notebooks (?:covering|teaching|explaining|demonstrating)\b/i.test(declaration)&&!/^.{0,80}\b(?:platform|runtime|editor|server|application|toolkit|library|framework)\b[^:]*:/i.test(declaration))return 'reference';
  // A README saying "skill" or mentioning SKILL.md does not prove that the
  // package contains an actual skill. Explicit skill-source admission is separate.
  // Monitoring, backup and telemetry daemons also call themselves agents.
  // Require an explicit AI/LLM/coding qualifier, not the generic noun alone.
  const agent=declaration.match(/^(?:an? )?((?:(?:autonomous|coding|software|development|AI(?:-powered)?|LLM(?:-powered)?|open-source|self-hosted|general-purpose) ){0,6})agent(?:\s+(?:for|that|to|which)\b|[.!]|$)/i);
  if(agent&&/\b(?:AI|LLM|coding)\b/i.test(agent[1]))return 'agent';
  return null;
}

function documentationRepositoryScope(repo,readme,sources){
  if(!repo||!readme)return null;
  const source=readme.source,url=new URL(source.url),raw=rawReadmeIdentity(source.url),revision=raw?.revision||url.searchParams.get('ref');
  if(!/^[a-f\d]{40}$/.test(revision||''))return null;
  const repository=repo.slice('https://github.com/'.length),endpoint='https://api.github.com/repos/'+repository;
  const body=raw?source.body:readmeContent(source),path=raw?.path||source.data?.path;
  if(typeof body!=='string'||typeof path!=='string'||(raw?raw.repository.toLowerCase()!==repository.toLowerCase():url.origin+url.pathname!==endpoint+'/readme'))return null;
  const gitBlobSha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(body)}\0`),Buffer.from(body)])).digest('hex');
  const commits=sources.filter(value=>{const u=new URL(value.url);return !u.search&&!u.hash&&u.origin==='https://api.github.com'&&u.pathname.toLowerCase().startsWith(new URL(endpoint).pathname.toLowerCase()+'/commits/')&&u.pathname.split('/').length===6&&value.data?.sha===revision&&/^[a-f\d]{40}$/.test(value.data?.commit?.tree?.sha||'');});
  for(const commit of commits){
    const treeSha=commit.data.commit.tree.sha,treeURL=endpoint+'/git/trees/'+treeSha+'?recursive=1';
    const tree=sources.find(value=>value.url.toLowerCase()===treeURL.toLowerCase()&&value.data?.sha===treeSha&&value.data?.truncated===false&&Array.isArray(value.data?.tree));if(!tree)continue;
    const entries=tree.data.tree,paths=new Set(entries.map(entry=>entry?.path));
    if(paths.size!==entries.length||entries.some(entry=>typeof entry?.path!=='string'||entry.path.split('/').some(part=>!part||part==='.'||part==='..')||entry.path.includes('\\')))continue;
    const blobs=entries.filter(entry=>entry.type==='blob'),matches=(name,sha)=>blobs.some(entry=>entry.path===name&&(!sha||entry.sha===sha));
    if(!matches(path,gitBlobSha)||!['mkdocs.yml','mkdocs.yaml'].some(name=>matches(name))||!matches('docs/index.md'))continue;
    // Require an overwhelmingly documentation tree, and no normal SDK/runtime
    // implementation root. A '-docs' suffix or an SDK marketing README is not proof.
    const docs=blobs.filter(entry=>entry.path.startsWith('docs/'));
    if(docs.length<20||docs.length/blobs.length<0.8||entries.some(entry=>/^(?:src|lib|libs|packages|pkg|internal|sdk)(?:\/|$)/i.test(entry.path)))continue;
    return {commit,tree};
  }
  return null;
}

/** Return a fresh public item array; all relationship targets must already exist. */
export function enrichCatalogueDetails({items,evidence}){
  if(!Array.isArray(items)||!Array.isArray(evidence))throw new Error('Public items and retained evidence arrays are required');
  const rows=items.map(item=>Object.fromEntries(PUBLIC_KEYS.filter(key=>Object.hasOwn(item,key)).map(key=>[key,structuredClone(item[key])])));
  const targets=new Map(rows.filter(row=>row.id===id(row.url)&&publicURL(row.url)).map(row=>[repoKey(row.url)||row.url.toLowerCase(),row]));
  const sources=evidence.map(verified).filter(Boolean).sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.sha256.localeCompare(b.sha256));
  const scopeSources=sources.filter(source=>/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(?:commits\/[^/?]+|git\/trees\/[a-f\d]{40}\?recursive=1)$/i.test(source.url));
  const byURL=new Map();for(const source of sources)if(!byURL.has(source.url))byURL.set(source.url,source);
  const directories=sources.filter(source=>source.url==='https://registry.directory/directory.json'&&Array.isArray(source.data?.registries));
  const collections=[],seenCollections=new Set();
  for(const document of directories)for(const row of document.data.registries){
    const repo=repoURL(row?.github_url),site=publicURL(row?.url),registry=publicURL(row?.registry_url);if(!repo||!site)continue;
    const key=repo.toLowerCase()+'\n'+site;if(seenCollections.has(key))continue;seenCollections.add(key);
    const target=targets.get(repo.toLowerCase())||targets.get(site.toLowerCase());if(!target)continue;
    const index=registry?byURL.get(registry):null;
    const official=index&&Array.isArray(index.data?.items)&&(!index.data.homepage||publicURL(index.data.homepage)===site)?index:null;
    const componentMap=new Map();if(official)for(const component of official.data.items){if(typeof component?.name==='string'){if(componentMap.has(component.name))componentMap.set(component.name,null);else componentMap.set(component.name,component);}}
    const docs=official?sources.filter(source=>new URL(source.url).origin===new URL(site).origin&&/^\/llms(?:-full)?\.txt$/.test(new URL(source.url).pathname)&&!new URL(source.url).search).sort((a,b)=>Number(b.url.endsWith('/llms-full.txt'))-Number(a.url.endsWith('/llms-full.txt')))[0]:null;
    collections.push({repo,site,target,document,row,official,componentMap,docs,blocks:docs?documentationBlocks(docs):null});
  }
  const indexes=sources.filter(source=>source.url==='https://registry.directory/items.json'&&Array.isArray(source.data?.items));
  const indexed=new Map();for(const source of indexes)for(const row of source.data.items){
    if(typeof row?.name!=='string'||!/^\/[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/.test(row.registry?.basePath||''))continue;
    const url=`https://registry.directory${row.registry.basePath}/${encodeURIComponent(row.name)}`;if(!indexed.has(url))indexed.set(url,{source,row});
  }
  const readmes=new Map();for(const source of sources){
    const url=new URL(source.url),match=url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/readme$/i);
    if(url.hostname!=='api.github.com'||!match||[...url.searchParams.keys()].some(key=>key!=='ref')||!/^\w{40}$/.test(url.searchParams.get('ref')||'')||!/^[a-f\d]{40}$/i.test(url.searchParams.get('ref')))continue;
    const key=`https://github.com/${match[1]}/${match[2]}`.toLowerCase();if(!readmes.has(key)){
      const body=readmeContent(source);if(body!==null)readmes.set(key,{source,body});
      else if(source.data?.encoding==='none'){
        try{
          const identity={repository:match[1]+'/'+match[2],revision:url.searchParams.get('ref')},declared=rawReadmeDeclaration({...source,status:200},identity),raw=byURL.get(declared.url);
          verifyRawReadme(raw&&{...raw,status:200},{...source,status:200},identity);
          // Full bytes/hash/blob are verified before a bounded prose-only parse.
          // Keep complete lines and the existing 180-word published output cap.
          const prefix=Buffer.from(raw.body).subarray(0,256000).toString('utf8'),boundedPrefix=Buffer.byteLength(raw.body)>256000?prefix.slice(0,prefix.lastIndexOf('\n')+1):prefix;
          readmes.set(key,{source:raw,body:boundedPrefix});
        }catch{/* Retain metadata-only details when source proof is incomplete. */}
      }
    }
  }
  const linkProofs=new Map();
  const add=(row,details,source,kind)=>{
    const ref=reference(source,row,kind),existing=row.citations.find(value=>value.id===ref.id);
    if(!existing&&row.citations.length>=21)return false;
    const citationIds=details.citationIds||[];if(!citationIds.includes(ref.id)&&citationIds.length>=8)return false;
    if(!existing)row.citations.push(ref);details.citationIds=[...new Set([...citationIds,ref.id])];return true;
  };
  for(const row of rows){
    const details={resourceType:row.kind==='component'?'component':row.kind==='solution'?'tool':'reference',citationIds:row.citations[0]?[row.citations[0].id]:[]},ownSource=sources.find(source=>source.url===row.url&&source.data&&Array.isArray(source.data.files)),indexedItem=indexed.get(row.url);
    const declared=declaredResourceType(row.description);if(declared)details.resourceType=declared;
    let collection=null;
    if(indexedItem){
      if(add(row,details,indexedItem.source,'registry-item-index'))Object.assign(details,directMetadata(indexedItem.row));
      const expected=('https://github.com'+indexedItem.row.registry.basePath).toLowerCase(),matches=collections.filter(value=>value.repo.toLowerCase()===expected);
      if(matches.length===1)collection=matches[0];
    }else if(ownSource){
      if(add(row,details,ownSource,'registry-item-document'))Object.assign(details,directMetadata(ownSource.data));
      const parsed=new URL(row.url),match=parsed.hostname==='raw.githubusercontent.com'&&parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/[a-f\d]{40}\//i);
      if(match){const key=`https://github.com/${match[1]}/${match[2]}`.toLowerCase(),matches=collections.filter(value=>value.repo.toLowerCase()===key);if(matches.length===1)collection=matches[0];else if(!matches.length&&targets.has(key))collection={target:targets.get(key),document:ownSource};}
    }
    if(collection&&collection.target.id!==row.id){
      if(add(row,details,collection.document,collection.row?'registry-directory':'registry-item-document')){
        details.parent={id:collection.target.id,url:collection.target.url,name:collection.target.name};
        const proof=linkProofs.get(collection.target.id)||[];proof.push({source:indexedItem?.source||ownSource,kind:indexedItem?'registry-item-index':'registry-item-document'});linkProofs.set(collection.target.id,proof);
      }
      const component=collection.componentMap?.get(indexedItem?.row.name||ownSource?.data.name);
      if(component&&add(row,details,collection.official,'registry-item-index')){
        Object.assign(details,directMetadata(component));
        if(collection.docs){const extra=documentedComponent(collection.blocks.get(component.name),collection.official.url,component.name);if(extra.sections&&add(row,details,collection.docs,'registry-item-document'))Object.assign(details,extra);}
      }
    }
    const parentCollection=collections.find(collection=>collection.target.id===row.id);
    if(parentCollection&&add(row,details,parentCollection.document,'registry-directory'))Object.assign(details,directMetadata(parentCollection.row),{resourceType:'collection'});
    const readme=readmes.get(repoKey(row.url));
    if(readme){const extracted=readmeDetails(readme.body);if(Object.keys(extracted).length&&add(row,details,readme.source,'github-source-evidence')){Object.assign(details,extracted);const declared=declaredResourceType(extracted.overview);if(declared)details.resourceType=declared;}}
    const documentationScope=documentationRepositoryScope(repoURL(row.url),readme,scopeSources);
    if(documentationScope&&add(row,details,documentationScope.commit,'github-source-evidence')&&add(row,details,documentationScope.tree,'github-source-evidence'))details.resourceType='reference';
    if(details.citationIds?.length&&Object.keys(details).some(key=>key!=='citationIds'))row.details=details;
  }
  for(const row of rows){const proofs=linkProofs.get(row.id);if(!proofs?.length)continue;const details=row.details||{};for(const proof of proofs)add(row,details,proof.source,proof.kind);details.memberCount=proofs.length;details.resourceType='collection';row.details=details;}
  return rows;
}
