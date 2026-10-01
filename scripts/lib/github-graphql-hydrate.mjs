import {GRAPHQL_SOURCE_URL,verifyGraphqlSource} from '../../src/github-graphql-source.mjs';

/** Apply only verified per-repository README slices; never execute source. */
export function retainGraphqlReadmes({store,snapshot,expected}){
 const verified=verifyGraphqlSource(snapshot); // before retaining any response
 const byName=new Map(expected.map(row=>[row.repository.toLowerCase(),row]));
 for(const record of verified.records){const row=byName.get(record.repository.toLowerCase());if(!row||record.repositoryId&&row.repositoryId!==record.repositoryId)throw Error('GraphQL batch differs from admitted repository identities');}
 const ref=store.retainEvidence({...snapshot,url:GRAPHQL_SOURCE_URL}),items=[];
 for(const record of verified.records){
  const row=byName.get(record.repository.toLowerCase()),item=store.getCapability(row.id);
  if(!item||item.url.toLowerCase()!==`https://github.com/${record.repository}`.toLowerCase())throw Error('Local repository changed before GraphQL hydration');
  const at=snapshot.fetchedAt||new Date().toISOString();
  if(record.status!=='ok'){
   items.push({id:item.id,url:item.url,repository:record.repository,repositoryId:row.repositoryId,status:record.status,readmePinned:false,proof:null,rejected:record.rejected||[]});continue;
  }
  const file=record.files[0],proof={evidenceId:ref.id,sha256:ref.sha256,alias:record.alias,repositoryId:record.repositoryId,repository:record.repository,revision:record.revision,path:file.path,blobOid:file.blobOid};
  if(JSON.stringify(item.graphqlReadmeProof)===JSON.stringify(proof)){
   items.push({id:item.id,url:item.url,repository:record.repository,repositoryId:record.repositoryId,status:item.sourceState?.status||'ok',readmePinned:true,revision:record.revision,path:file.path,blobOid:file.blobOid,bytes:file.bytes,sha256:file.sha256,proof,rejected:record.rejected,license:item.license,reused:true});continue;
  }
  const previousFiles=(item.repositoryFiles||[]).filter(x=>!/^readme(?:[._-]|$)/i.test(x.path?.split('/').at(-1)||''));
  const oldLicence=item.licenseEvidence,invalidated=oldLicence?.status==='fetched'&&oldLicence.revision!==record.revision;
  const state={status:invalidated?'partial':'ok',checkedAt:at,method:'graphql-commit-file',previousEvidenceIds:(item.repositoryEvidence||[]).map(x=>x.id),...(item.graphqlReadmeProof?{previousGraphqlReadmeProof:item.graphqlReadmeProof}:{}),note:'README bytes verified against an immutable commit/file/blob response. Licence text was not fetched by this batch.'};
  const updated=store.upsertCapability({...item,graphqlReadmeProof:proof,repositoryReadmeProof:null,repositoryFiles:[...previousFiles,{path:file.path,content:file.text}],repositoryEvidence:[ref],...(invalidated?{license:null,licenseEvidence:{status:'unverified-current-source',scope:'repository',revision:record.revision,previous:oldLicence,note:'A newer README commit was observed; retained prior licence text was not verified at this revision.'}}:{}),sourceState:state,sourceError:null,sourceHistory:[...(item.sourceHistory||[]),state].slice(-20),provenance:{...item.provenance,resolvedRevision:record.revision,repositoryFetchedAt:at}}).item;
  items.push({id:updated.id,url:updated.url,repository:record.repository,repositoryId:record.repositoryId,status:state.status,readmePinned:true,revision:record.revision,path:file.path,blobOid:file.blobOid,bytes:file.bytes,sha256:file.sha256,proof,rejected:record.rejected,license:updated.license});
 }
 return{items,evidence:{id:ref.id,url:ref.url,sha256:ref.sha256,requestSha256:ref.requestSha256},rateLimit:verified.rateLimit};
}
