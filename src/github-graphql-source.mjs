import {createHash} from 'node:crypto';

export const GRAPHQL_SOURCE_URL='https://api.github.com/graphql';
export const README_PATHS=['README.md','readme.md','README.rst','README','README.markdown','.github/README.md','docs/README.md'];
export const GRAPHQL_BATCH_MAX=50;
const hash=(value,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const repositoryPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
// A small value-bound cache avoids rehashing a whole batch for every item.
// Never trust object identity alone: callers can mutate snapshots between reads.
const verifiedCache=new Map();
function frozen(value){if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}

// This fixed, read-only query is also the acceptance grammar for retained
// request receipts. No arbitrary GraphQL operation or caller field is accepted.
export function githubReadmeQuery(repositories){
 if(!Array.isArray(repositories)||!repositories.length||repositories.length>GRAPHQL_BATCH_MAX||repositories.some(x=>typeof x!=='string'||!repositoryPattern.test(x))||new Set(repositories.map(x=>x.toLowerCase())).size!==repositories.length)throw Error('Invalid bounded public repository batch');
 const files=README_PATHS.map((path,i)=>`f${i}:file(path:${JSON.stringify(path)}){path oid object{...on Blob{oid byteSize isBinary isTruncated text}}}`).join(' ');
 return `query GlassesPublicReadmes{${repositories.map((repo,i)=>{const [owner,name]=repo.split('/');return `r${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){databaseId nameWithOwner isPrivate defaultBranchRef{target{...on Commit{oid ${files}}}}}`;}).join(' ')} rateLimit{cost remaining resetAt}}`;
}
function requestRepositories(request){
 if(request?.method!=='POST'||typeof request.body!=='string'||Buffer.byteLength(request.body)>100000)throw Error('Missing bounded GraphQL request receipt');
 let data;try{data=JSON.parse(request.body);}catch{throw Error('Invalid GraphQL request JSON');}
 if(Object.keys(data).length!==1||typeof data.query!=='string')throw Error('Unsupported GraphQL request fields');
 const repositories=[...data.query.matchAll(/r\d+:repository\(owner:"([A-Za-z0-9_.-]+)",name:"([A-Za-z0-9_.-]+)"\)/g)].map(x=>x[1]+'/'+x[2]);
 if(githubReadmeQuery(repositories)!==data.query)throw Error('GraphQL request does not match the reviewed read-only query');
 return repositories;
}
export function verifyGraphqlSource(snapshot){
 const binding=[snapshot?.url,snapshot?.status,snapshot?.id,snapshot?.body,snapshot?.sha256,snapshot?.request?.method,snapshot?.request?.body,snapshot?.requestSha256];
 const cached=verifiedCache.get(snapshot?.sha256);if(cached&&cached.binding.every((value,index)=>value===binding[index]))return cached.value;
 if(snapshot?.url!==GRAPHQL_SOURCE_URL||snapshot.status!==200||typeof snapshot.body!=='string'||Buffer.byteLength(snapshot.body)>16*1024*1024||hash(snapshot.body)!==snapshot.sha256||snapshot.id&&snapshot.id!==hash(`${snapshot.url}\n${snapshot.sha256}`).slice(0,20))throw Error('GraphQL response evidence integrity mismatch');
 const repositories=requestRepositories(snapshot.request);
 if(snapshot.requestSha256!==hash(snapshot.request.body))throw Error('GraphQL request receipt hash mismatch');
 const response=JSON.parse(snapshot.body);
 if(!response.data||typeof response.data!=='object')throw Error('GraphQL response contains errors');
 // Commit.file reports a missing optional path as a field error plus null.
 // Accept only that exact reviewed field/path; all other partial errors fail.
 if(response.errors!==undefined&&!Array.isArray(response.errors))throw Error('Invalid GraphQL errors');
 for(const error of response.errors||[]){const p=error.path,alias=p?.[0],field=p?.[3],index=typeof field==='string'&&/^f\d+$/.test(field)?Number(field.slice(1)):-1;
  if(error.type!=='NOT_FOUND'||!Array.isArray(p)||p.length!==4||!repositories.some((_,i)=>alias==='r'+i)||p[1]!=='defaultBranchRef'||p[2]!=='target'||index<0||index>=README_PATHS.length||error.message!==`Could not resolve file for path '${README_PATHS[index]}'.`||response.data[alias]?.defaultBranchRef?.target?.[field]!==null)throw Error('GraphQL response contains unsupported errors');
 }
 const expected=new Set([...repositories.map((_,i)=>'r'+i),'rateLimit']);
 if(Object.keys(response.data).some(key=>!expected.has(key)))throw Error('Unexpected GraphQL response alias');
 const ids=new Set(),records=[];
 for(const [index,requested] of repositories.entries()){
  const alias='r'+index,repo=response.data[alias];
  if(repo===null){records.push({alias,repository:requested,status:'unavailable'});continue;}
  if(!repo||repo.isPrivate!==false||!Number.isSafeInteger(repo.databaseId)||repo.databaseId<=0||typeof repo.nameWithOwner!=='string'||repo.nameWithOwner.toLowerCase()!==requested.toLowerCase()||ids.has(repo.databaseId))throw Error('GraphQL public repository identity mismatch');
  ids.add(repo.databaseId);
  const target=repo.defaultBranchRef?.target;
  if(!target){records.push({alias,repository:repo.nameWithOwner,repositoryId:repo.databaseId,status:'no-default-commit'});continue;}
  if(!oid(target.oid))throw Error('GraphQL default branch is not an immutable commit');
  const files=[],rejected=[];
  for(const [i,path] of README_PATHS.entries()){
   const file=target['f'+i];if(file===null)continue;
   if(!file||file.path!==path||!oid(file.oid)||!file.object||typeof file.object!=='object')throw Error('GraphQL commit/file identity mismatch');
   if(Object.keys(file.object).length===0){rejected.push({path,reason:'Commit path is not a Blob; no text was requested or admitted'});continue;}
   if(file.oid!==file.object.oid)throw Error('GraphQL commit/file identity mismatch');
   const blob=file.object;
   if(blob.isBinary!==false||blob.isTruncated!==false||typeof blob.text!=='string'||!Number.isSafeInteger(blob.byteSize)||blob.byteSize<1||blob.byteSize>4*1024*1024){rejected.push({path,reason:'binary, truncated, empty or oversized blob'});continue;}
   const bytes=Buffer.from(blob.text,'utf8');
   if(bytes.length!==blob.byteSize||hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1')!==blob.oid){rejected.push({path,reason:'Returned text does not match declared UTF-8 bytes/Git blob; a separate pinned raw-source proof is required'});continue;}
   files.push({path,blobOid:blob.oid,bytes:blob.byteSize,sha256:hash(bytes),text:blob.text});
  }
  records.push({alias,repository:repo.nameWithOwner,repositoryId:repo.databaseId,revision:target.oid,status:files.length?'ok':'no-supported-readme',files,rejected});
 }
 const value=frozen({records,rateLimit:response.data.rateLimit});verifiedCache.set(snapshot.sha256,{binding,value});if(verifiedCache.size>8)verifiedCache.delete(verifiedCache.keys().next().value);return value;
}
export function graphqlReadme(snapshot,proof){
 const batch=verifyGraphqlSource(snapshot);
 if(!proof||proof.evidenceId!==snapshot.id||proof.sha256!==snapshot.sha256)throw Error('Missing item-bound GraphQL proof');
 const row=batch.records.find(row=>row.alias===proof.alias);
 if(!row||row.status!=='ok'||row.repositoryId!==proof.repositoryId||row.repository.toLowerCase()!==String(proof.repository).toLowerCase()||row.revision!==proof.revision)throw Error('GraphQL proof selects a different repository or commit');
 const file=row.files.find(file=>file.path===proof.path&&file.blobOid===proof.blobOid);if(!file)throw Error('GraphQL proof selects an unavailable README');
 return{...file,repository:row.repository,repositoryId:row.repositoryId,revision:row.revision,sourceUrl:`https://github.com/${row.repository}/blob/${row.revision}/${file.path}`};
}

// Census queries contain only public flags and numeric/date partition bounds.
// Other search strings remain unsuitable as public classifier provenance.
export function isPublicCensusSearch(value){
 try{const url=new URL(value);if(url.origin!=='https://api.github.com'||url.pathname!=='/search/repositories'||url.hash||url.username||url.password)return false;
  const params=url.searchParams;if([...params.keys()].some(key=>!['q','sort','order','per_page','page'].includes(key))||[...params.keys()].some(key=>params.getAll(key).length!==1))return false;
  if(params.get('sort')!=='stars'||params.get('order')!=='desc'||params.get('per_page')!=='100'||!/^([1-9]|10)$/.test(params.get('page')||''))return false;
  return /^is:public fork:true stars:(?:>=[1-9]\d*|[1-9]\d*(?:\.\.[1-9]\d*)?)(?: created:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\.\.\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)?$/.test(params.get('q')||'');
 }catch{return false;}
}
