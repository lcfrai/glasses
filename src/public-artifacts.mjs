// Source-backed skill/profile projection. No filesystem, network, inference,
// installation or execution. Manifests are proposals, not trusted source text.
import {createHash} from 'node:crypto';

const sha=(value,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const stableId=value=>sha(value).slice(0,20);
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
const revisionPattern=/^[a-f\d]{40}$/;
const digestPattern=/^[a-f\d]{64}$/;
const unsafe=/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|(?:\b[A-Z]:[\\/]|\\\\)[^\s]+|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const fault=code=>{throw Object.assign(new Error(code),{projectionCode:code});};
function date(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))fault('invalid-evidence-date');return new Date(value).toISOString();}
function repoURL(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&/^\/[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+\/?$/.test(url.pathname)?url.href.replace(/\/$/,''):null;}catch{return null;}}
function safePath(value){return typeof value==='string'&&value.length>0&&value.length<=500&&!unsafe.test(value)&&!/[\\\u0000?#%:]/.test(value)&&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');}
const encodedPath=value=>value.split('/').map(encodeURIComponent).join('/');
const dirname=value=>value.includes('/')?value.slice(0,value.lastIndexOf('/')):'';
function rawURL(repository,revision,path){return`https://raw.githubusercontent.com/${repository}/${revision}/${encodedPath(path)}`;}
function normalURL(value){try{return new URL(value).href;}catch{return null;}}
function text(value,max=800,wordLimit=Infinity){
  if(typeof value!=='string'||unsafe.test(value))return '';
  let result=value.replace(/`([A-Za-z][\w-]{0,60})`/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_]/g,'').replace(/\s+/g,' ').trim();
  if(/`|[{}]|=>|<\/?[A-Za-z!]/.test(result))return '';
  const words=result.split(/\s+/);if(words.length>wordLimit)result=words.slice(0,wordLimit).join(' ')+'…';
  if(result.length>max){result=result.slice(0,max-1);const end=result.lastIndexOf(' ');if(end>max/2)result=result.slice(0,end);result+='…';}
  return result;
}
function scalar(value){
  const input=value.trim();if(/^[!&*[{]/.test(input))return '';
  if(input.startsWith('"')){try{return JSON.parse(input);}catch{return '';}}
  if(input.startsWith("'"))return input.endsWith("'")?input.slice(1,-1).replace(/''/g,"'"):'';
  return input.replace(/\s+#.*$/,'').trim();
}
function descriptionText(value,max=1200,wordLimit=110){
  if(typeof value!=='string'||unsafe.test(value))return '';
  return text(value.split(/(?<=[.!?])\s+/).map(sentence=>text(sentence,max,wordLimit)).filter(Boolean).join(' '),max,wordLimit);
}
function frontmatter(body){
  const match=body.replace(/^\uFEFF/,'').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);if(!match)fault('missing-frontmatter');
  const result={},lines=match[1].split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const entry=lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);if(!entry)continue;const [,key,value]=entry;
    if(!['name','description','license','compatibility'].includes(key))continue;
    if(Object.hasOwn(result,key))fault('duplicate-frontmatter-field');
    if(/^[>|][+-]?$/.test(value.trim())){const block=[];while(i+1<lines.length&&(/^[ \t]+/.test(lines[i+1])||!lines[i+1].trim()))block.push(lines[++i].trim());result[key]=block.join(' ');}
    else result[key]=scalar(value);
  }
  return{fields:result,body:body.slice(match[0].length)};
}
function proseLines(body){
  const output=[];let fenced=false;
  const safe=body.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  for(const raw of safe.split(/\r?\n/)){
    if(/^\s*(?:```|~~~)/.test(raw)){fenced=!fenced;continue;}if(fenced||/^ {4}|^\s*\||!\[/.test(raw))continue;
    const line=raw.trim();if(!line||/^(?:npx|npm|pnpm|yarn|bun|curl|wget|git |export |import |const |let |function |\$ )/i.test(line))continue;
    output.push(line);
  }return output;
}
function usageDetails(body,fields){
  const usage={},sections=[];let heading='',current=null;
  const kind=title=>/^(?:when to (?:use|apply)|use (?:this )?when|triggers?)$/i.test(title)?'triggers':/^(?:inputs?|required inputs?)$/i.test(title)?'inputs':/^(?:outputs?|expected outputs?|deliverables)$/i.test(title)?'outputs':/^(?:compatibility|supported (?:agents|clients|platforms))$/i.test(title)?'compatibility':null;
  for(const raw of proseLines(body)){
    const match=raw.match(/^#{1,3}\s+(.+)/);
    if(match){heading=text(match[1],100,12);current=heading&&!/licen[cs]e|sponsor|contribut|install|getting started|quick start/i.test(heading)?{title:heading,lines:[]}:null;if(current&&raw.startsWith('##'))sections.push(current);continue;}
    const value=text(raw.replace(/^[-*+]\s+|^\d+\.\s+/,''),kind(heading)==='compatibility'?150:200,35);if(!value)continue;
    if(current)current.lines.push(value);const key=kind(heading);
    if(key){usage[key]??=[];if(usage[key].length<(key==='compatibility'?8:6)&&!usage[key].includes(value))usage[key].push(value);}
  }
  if(!usage.triggers){const sentence=String(fields.description||'').split(/(?<=[.!?])\s+/).find(value=>/\b(?:use when|used when|triggers? on|when the user)\b/i.test(value)),value=text(sentence,200,35);if(value)usage.triggers=[value];}
  const compatibility=text(fields.compatibility,150,25);if(compatibility)usage.compatibility=[...new Set([compatibility,...usage.compatibility||[]])].slice(0,8);
  return{...(Object.keys(usage).length?{agentUsage:usage}:{}),sections:sections.filter(section=>section.lines.length).slice(0,6).map(section=>({title:section.title,summary:text(section.lines.slice(0,2).join(' '),280,40)}))};
}
function evidenceReader(evidence){
  const sources=new Map();for(const value of evidence){if(value&&typeof value.url==='string'&&digestPattern.test(value.sha256||''))sources.set(value.url+'\n'+value.sha256,value);}
  return descriptor=>{
    if(!descriptor||!digestPattern.test(descriptor.sha256||''))fault('missing-evidence-reference');
    const source=sources.get(descriptor.url+'\n'+descriptor.sha256);if(!source||source.status!==200)fault('missing-successful-evidence');
    let bytes;if(typeof source.body==='string')bytes=Buffer.from(source.body,'utf8');else if(source.encoding==='base64'&&typeof source.bodyBase64==='string'&&/^[A-Za-z\d+/=\s]+$/.test(source.bodyBase64))bytes=Buffer.from(source.bodyBase64,'base64');else fault('unsupported-evidence-body');
    if(bytes.length>16*1024*1024||sha(bytes)!==source.sha256)fault('evidence-integrity');
    if(source.id&&source.id!==stableId(source.url+'\n'+source.sha256))fault('evidence-identity');
    return{url:source.url,sha256:source.sha256,observedAt:date(source.lastFetchedAt||source.fetchedAt||source.firstFetchedAt),bytes,body:typeof source.body==='string'?source.body:null};
  };
}
function json(source){try{return JSON.parse(source.body);}catch{fault('invalid-source-json');}}
function repositoryProof(proposal,read){
  const repo=repoURL(proposal.url);if(!repo||proposal.repository!==repo.slice('https://github.com/'.length)||!revisionPattern.test(proposal.revision||''))fault('invalid-repository-identity');
  const metadata=read(proposal.metadataEvidence),data=json(metadata);
  if(metadata.url!==`https://api.github.com/repos/${proposal.repository}`||data.private!==false||repoURL(data.html_url)?.toLowerCase()!==repo.toLowerCase()||data.archived===true||data.disabled===true)fault('repository-not-public-active');
  const branch=data.default_branch;if(!safePath(branch)||proposal.defaultBranch&&proposal.defaultBranch!==branch)fault('invalid-default-branch');
  const commit=read(proposal.commitEvidence),commitData=json(commit),commitURL=new URL(commit.url);
  if(commitURL.origin!=='https://api.github.com'||decodeURIComponent(commitURL.pathname)!==`/repos/${proposal.repository}/commits/${branch}`||commitURL.search||commitData.sha!==proposal.revision||!revisionPattern.test(commitData.commit?.tree?.sha||''))fault('commit-identity');
  const tree=read(proposal.treeEvidence),treeData=json(tree),treeURL=new URL(tree.url);
  if(treeURL.origin!=='https://api.github.com'||treeURL.pathname!==`/repos/${proposal.repository}/git/trees/${commitData.commit.tree.sha}`||treeURL.searchParams.get('recursive')!=='1'||[...treeURL.searchParams].some(([key,value])=>key!=='recursive'||value!=='1')||treeData.truncated!==false||treeData.sha!==commitData.commit.tree.sha||!Array.isArray(treeData.tree))fault('incomplete-source-tree');
  const files=new Map();for(const file of treeData.tree){if(file?.type!=='blob'||!safePath(file.path))continue;if(files.has(file.path))fault('duplicate-tree-path');files.set(file.path,file);}
  return{repo,repository:proposal.repository,revision:proposal.revision,branch,metadata,commit,tree,files};
}
function fileProof(descriptor,repository,read){
  if(!descriptor||!safePath(descriptor.path)||descriptor.encoding&&descriptor.encoding!=='utf8'&&descriptor.encoding!=='base64')fault('invalid-artifact-path');
  const expected=rawURL(repository.repository,repository.revision,descriptor.path);
  if(normalURL(descriptor.url)!==expected)fault('unpinned-or-foreign-source');
  const file=repository.files.get(descriptor.path);if(!file||!['100644','100755'].includes(file.mode)||!revisionPattern.test(file.sha||''))fault('source-not-regular-tree-file');
  const source=read(descriptor),blob=sha(Buffer.concat([Buffer.from(`blob ${source.bytes.length}\0`),source.bytes]),'sha1');
  if(blob!==file.sha||descriptor.gitBlobSha!==file.sha||descriptor.bytes!==source.bytes.length||Number.isSafeInteger(file.size)&&file.size!==source.bytes.length)fault('source-blob-mismatch');
  return source;
}
function licenceProof(entry,repository,read,fields){
  const claim=entry.license;if(!claim||!['MIT','Apache-2.0'].includes(claim.spdx)||claim.redistribution!=='scoped-licence-observed'||!['repository','directory'].includes(claim.scope))fault('unsupported-redistribution-licence');
  const scope=claim.scopePath||'';if(scope&&!safePath(scope)||claim.scope==='repository'&&scope||claim.scope==='directory'&&!scope)fault('invalid-licence-scope');
  if(scope&&!(entry.sourcePath===scope||entry.sourcePath.startsWith(scope+'/')))fault('licence-outside-artifact-scope');
  const file=claim.sourceDocument;if(!file||dirname(file.path)!==scope||!/^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(file.path.split('/').at(-1)))fault('licence-path-mismatch');
  const ancestors=[...repository.files.keys()].filter(path=>/^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(path.split('/').at(-1))&&(!dirname(path)||entry.sourcePath.startsWith(dirname(path)+'/'))).sort((a,b)=>dirname(b).length-dirname(a).length||a.localeCompare(b));
  if(!ancestors.length||ancestors[0]!==file.path||ancestors[1]&&dirname(ancestors[1]).length===dirname(file.path).length)fault('closer-or-ambiguous-licence');
  const source=fileProof(file,repository,read);if(!source.body)fault('unreadable-licence');
  const terms=source.body.toLowerCase().replace(/[“”]/g,'"').replace(/\s+/g,' ');
  if(/commons clause|non-commercial|noncommercial|no commercial use|not permitted to redistribute|redistribution is prohibited/.test(terms))fault('restricted-licence-supplement');
  const grant=claim.spdx==='MIT'?terms.includes('permission is hereby granted, free of charge')&&terms.includes('copies or substantial portions')&&terms.includes('software is provided "as is"'):terms.includes('apache license')&&terms.includes('version 2.0, january 2004')&&terms.includes('grant of copyright license')&&terms.includes('perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable');
  if(!grant)fault('licence-grant-not-proved');
  if(fields.license&&fields.license!==claim.spdx&&!/^(?:(?:see|complete|full|terms|in|the|file|for|details)\s+)*LICEN[CS]E(?:\.(?:txt|md))?\.?$/i.test(fields.license))fault('conflicting-document-licence');
  return source;
}
function citation(source,url,kind){const endpoint=new URL(source.url);endpoint.search='';endpoint.hash='';const fields={endpoint:endpoint.href,recordUrl:url,sha256:source.sha256};return{id:stableId(canonical(fields)),...fields,observedAt:source.observedAt,kind};}

/** Project reviewed, pinned source documents; return omissions with fixed codes. */
export function projectPublicArtifacts({manifest,evidence,parents=[]}){
  if(manifest?.schemaVersion!==1||!Array.isArray(manifest.sources)||!Array.isArray(manifest.items)||manifest.items.length>1000||!Array.isArray(evidence)||!Array.isArray(parents))throw new Error('Invalid public artifact projection inputs');
  const read=evidenceReader(evidence),parentByURL=new Map(parents.filter(parent=>repoURL(parent.url)&&parent.id===stableId(parent.url)).map(parent=>[repoURL(parent.url).toLowerCase(),parent]));
  const sourceByKey=new Map(),proofs=new Map();for(const source of manifest.sources){const key=source.repository+'\n'+source.revision;if(sourceByKey.has(key))fault('duplicate-repository-source');sourceByKey.set(key,source);}
  const items=[],seen=new Set(),excluded=[];
  for(const [index,entry] of manifest.items.entries()){
    try{
      if(!['agent-skill','agent-profile'].includes(entry.artifact)||!safePath(entry.sourcePath)||!revisionPattern.test(entry.revision||''))fault('invalid-artifact-kind-or-path');
      if(entry.artifact==='agent-skill'&&!/(?:^|\/)SKILL\.md$/.test(entry.sourcePath)||entry.artifact==='agent-profile'&&!/\.agent\.md$/.test(entry.sourcePath))fault('not-an-actual-skill-or-profile');
      const key=entry.parent?.repository+'\n'+entry.revision,proposal=sourceByKey.get(key);if(!proposal)fault('missing-repository-source');
      if(!proofs.has(key))proofs.set(key,repositoryProof(proposal,read));const repository=proofs.get(key);
      const parent=parentByURL.get(repository.repo.toLowerCase());if(!parent||repoURL(entry.parent.url)?.toLowerCase()!==repository.repo.toLowerCase())fault('missing-projected-parent');
      if(entry.sourceDocument?.path!==entry.sourcePath)fault('entry-document-path-mismatch');
      const document=fileProof(entry.sourceDocument,repository,read);if(!document.body||document.bytes.length>256000)fault('unreadable-or-oversized-artifact');
      const parsed=frontmatter(document.body),fields=parsed.fields,name=text(fields.name||proseLines(parsed.body).find(line=>/^#\s+/.test(line))?.replace(/^#\s+/,'')||entry.sourcePath.split('/').at(-1).replace(/\.agent\.md$/,''),200,25),description=descriptionText(fields.description);
      if(!name||!description||entry.artifact==='agent-skill'&&!fields.name)fault('missing-safe-source-description');
      const licence=licenceProof(entry,repository,read,fields);
      const files=new Map([[entry.sourcePath,entry.sourceDocument]]);
      for(const descriptor of [...entry.acquisition?.files||[],...entry.acquisition?.supportingFiles||[]]){if(files.has(descriptor.path)&&files.get(descriptor.path).sha256!==descriptor.sha256)fault('conflicting-package-file');files.set(descriptor.path,descriptor);}
      if(files.size>1000)fault('oversized-artifact-package');let totalBytes=0;
      for(const descriptor of files.values()){if(entry.license.scopePath&&!descriptor.path.startsWith(entry.license.scopePath+'/'))fault('package-file-outside-licence-scope');const source=fileProof(descriptor,repository,read);totalBytes+=source.bytes.length;if(totalBytes>32*1024*1024)fault('oversized-artifact-package');}
      const url=`${repository.repo}/blob/${encodedPath(repository.branch)}/${encodedPath(entry.sourcePath)}`,sourceUrl=`${repository.repo}/blob/${repository.revision}/${encodedPath(entry.sourcePath)}`;
      if(seen.has(url))fault('duplicate-artifact-identity');seen.add(url);
      const citations=[citation(document,url,'github-artifact-document'),citation(repository.metadata,url,'github-repository-metadata'),citation(repository.commit,url,'github-source-evidence'),citation(licence,url,'github-source-evidence')];
      const usage=usageDetails(parsed.body,fields),overview=descriptionText(fields.description,800,75);let remaining=180-overview.split(/\s+/).length;
      usage.sections=usage.sections.flatMap(section=>{if(remaining<5)return[];const summary=text(section.summary,280,remaining);remaining-=summary.split(/\s+/).length;return summary?[{title:section.title,summary}]:[];});
      const details={resourceType:entry.artifact==='agent-skill'?'skill':'agent',overview,parent:{id:parent.id,url:parent.url,name:parent.name},sourceUrl,sourceFileCount:files.size,citationIds:citations.map(value=>value.id),...usage};if(!details.sections.length)delete details.sections;
      items.push({id:stableId(url),url,name,description,kind:'pattern',provider:'GitHub',tags:[details.resourceType,entry.artifact],framework:null,license:{spdx:entry.license.spdx,status:'known',scope:'source-artifact',basis:'source-declaration'},github:null,observedAt:document.observedAt,citations,assessment:null,details});
    }catch(error){excluded.push({index,reason:error.projectionCode||'invalid-artifact-evidence'});}
  }
  return{items,report:{examined:manifest.items.length,projected:items.length,excluded}};
}
