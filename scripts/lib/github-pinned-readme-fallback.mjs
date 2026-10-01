import {createHash} from 'node:crypto';
import {verifyGraphqlSource} from '../../src/github-graphql-source.mjs';
import {base64ReadmeVerified,rawReadmeIdentity,verifyRawReadme,pinnedNonUtf8Readme} from '../../src/github-readme.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

// Reuse the already observed immutable commit, never a guessed README path or
// a branch name. The complete original GraphQL request/response is revalidated.
export function pinnedFallbackIdentity(snapshot,row){
 const record=verifyGraphqlSource(snapshot).records.find(value=>value.repositoryId===row.repositoryId);
 if(!record||!same(record.repository,row.repository)||!same(row.url,'https://github.com/'+record.repository)||!/^([a-f0-9]{40})$/.test(record.revision||''))throw Error('No exact public GraphQL commit for pinned fallback');
 if(record.status!=='no-supported-readme')throw Error('Pinned fallback requires an unavailable original README');
 return{repository:record.repository,repositoryId:record.repositoryId,revision:record.revision,alias:record.alias,url:'https://api.github.com/repos/'+record.repository+'/readme?ref='+record.revision};
}

// Synchronous proof validation and save: unrelated local fields are read at the
// last moment and retained. No request, licence fetch or provider call occurs.
export function retainPinnedReadmeFallback({store,row,commitSnapshot,response,rawResponse,rawBytes}){
 const identity=pinnedFallbackIdentity(commitSnapshot,row),item=store.getCapability(row.id);
 if(!item||!same(item.url,row.url)||item.metadataEvidence?.sha256!==row.metadataSourceHash)throw Error('Pinned fallback metadata binding changed');
 const meta=store.getEvidence(item.metadataEvidence.id);
 if(!meta||hash(meta.body)!==meta.sha256)throw Error('Pinned fallback metadata evidence integrity mismatch');
 const data=JSON.parse(meta.body),repo=(Array.isArray(data.items)?data.items:[data]).find(value=>value.id===row.repositoryId);
 if(repo?.private!==false||!same(repo.html_url,row.url))throw Error('Pinned fallback public numeric identity mismatch');
 if(response?.url!==identity.url||![200,404,410].includes(response.status)||typeof response.body!=='string'||hash(response.body)!==response.sha256)throw Error('Pinned fallback response identity/status/hash mismatch');
 let source=null,path=null,blobOid=null,body=null,unsupported=null;
 if(response.status===200){
  const declared=JSON.parse(response.body);
  const fileIdentity=rawReadmeIdentity('https://raw.githubusercontent.com/'+identity.repository+'/'+identity.revision+'/'+String(declared.path||'').split('/').map(encodeURIComponent).join('/'));
  if(!fileIdentity)throw Error('Pinned fallback returned an unsupported README path');
  if(base64ReadmeVerified(declared)){if(rawResponse||rawBytes)throw Error('Unexpected raw source for a complete inline README');body=Buffer.from(declared.content,'base64').toString('utf8');source=response;path=declared.path;blobOid=declared.sha;}
  else if((unsupported=pinnedNonUtf8Readme(response,identity,rawBytes))){if(rawResponse)throw Error('Unexpected raw text for proven unsupported encoding');}
  else{const verified=verifyRawReadme(rawResponse,response,identity);body=rawResponse.body;source=rawResponse;path=verified.path;blobOid=verified.gitBlobSha;}
 }else if(rawResponse||rawBytes)throw Error('Unexpected raw source for an absent README');
 const at=response.fetchedAt||new Date().toISOString();
 // All validation precedes writes, including the original query binding.
 const commitRef=store.retainEvidence(commitSnapshot),apiRef=store.retainEvidence(response),rawRef=rawResponse?store.retainEvidence(rawResponse):null;
 const commitProof={kind:'retained-graphql-commit',evidenceId:commitRef.id,sha256:commitRef.sha256,alias:identity.alias,repositoryId:identity.repositoryId,repository:identity.repository,revision:identity.revision};
 const priorFiles=(item.repositoryFiles||[]).filter(file=>!/^readme(?:[._-]|$)/i.test(file.path?.split('/').at(-1)||''));
 const invalidated=item.licenseEvidence?.status==='fetched'&&item.licenseEvidence.revision!==identity.revision;
 const error=source?null:unsupported?'Verified pinned README is not lossless UTF-8':'HTTP '+response.status+' from api.github.com';
 const state={status:source?(invalidated?'partial':'ok'):'partial',checkedAt:at,method:'pinned-graphql-commit-rest-readme',errors:source?[]:[{resource:'readme',url:identity.url,error,status:unsupported?'unsupported':'removed'}],previousEvidenceIds:(item.repositoryEvidence||[]).map(ref=>ref.id),...(item.graphqlReadmeProof?{previousGraphqlReadmeProof:item.graphqlReadmeProof}:{}),note:'README queried at the previously verified public GraphQL commit. No fresh branch, metadata or licence query was made.'};
 const refs=[apiRef,...(rawRef?[rawRef]:[])];
 const updated=store.upsertCapability({...item,graphqlReadmeProof:null,repositoryCommitProof:commitProof,repositoryReadmeProof:rawRef?{apiEvidence:apiRef,rawEvidence:rawRef,revision:identity.revision,path,bytes:Buffer.byteLength(body),gitBlobSha:blobOid}:null,repositoryFiles:[...priorFiles,...(source?[{path,content:body}]:[])],repositoryEvidence:refs,...(invalidated?{license:null,licenseEvidence:{status:'unverified-current-source',scope:'repository',revision:identity.revision,previous:item.licenseEvidence,note:'Retained licence text was not verified at this README revision.'}}:{}),sourceState:state,sourceError:error,sourceHistory:[...(item.sourceHistory||[]),state].slice(-20),provenance:{...item.provenance,resolvedRevision:identity.revision,repositoryFetchedAt:at}}).item;
 if(!source)return{item:updated,readmePinned:false,revision:identity.revision,commitProof,error,...(unsupported?{unsupportedReadme:{...unsupported,declaration:apiRef}}:{})};
 const ref=rawRef||apiRef,proof={id:ref.id,url:ref.url,sha256:ref.sha256,path,blobOid,bytes:Buffer.byteLength(body),bodySha256:hash(body)};
 return{item:updated,readmePinned:true,revision:identity.revision,path,blobOid,bytes:proof.bytes,sha256:proof.bodySha256,commitProof,proof:{kind:'retained-rest-readme',revision:identity.revision,evidence:[proof]}};
}
