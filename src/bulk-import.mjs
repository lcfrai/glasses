import {createHash} from 'node:crypto';
import {fetchPublic,validatePublicURL} from './discovery.mjs';
import {createPublicCatalogue,enrichPublicCatalogue} from './public-catalogue.mjs';
import {projectPublicArtifacts} from './public-artifacts.mjs';
import {stableId} from './store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const directory=path=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
const encoded=path=>path.split('/').map(encodeURIComponent).join('/');
const safePath=path=>typeof path==='string'&&path.length<=500&&!/[\\\x00?#%:]/.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');
const review=reason=>({reviewRequired:true,reason});
const reference=({id,url,sha256,status,contentType,firstFetchedAt,lastFetchedAt})=>({id,url,sha256,status,contentType,firstFetchedAt,lastFetchedAt});

/** Acquisition only: retained public bytes are re-projected before local admission.
 * A requested lane never establishes a resource type, licence or compatibility. */
export function createBulkImporter({store,discovery,fetcher=fetchPublic}){
  async function retain(url,signal){
    signal?.throwIfAborted();const doc=await fetcher(validatePublicURL(url).href,{signal,maxBytes:16*1024*1024});signal?.throwIfAborted();
    if(doc.status!==200||typeof doc.body!=='string')throw new Error('Public source acquisition did not return a successful document');
    const evidence=store.retainEvidence({...doc,url:doc.url||url});return store.getEvidence(evidence.id);
  }
  function existing(reference){const source=store.getEvidence(reference?.id);if(!source||source.sha256!==reference.sha256||hash(source.body)!==source.sha256||source.status!==200)throw new Error('Bulk proposal evidence no longer matches retained source');return source;}
  function save(row,metadata,extra={}){return store.upsertCapability({...row,license:row.license.spdx,metadataEvidence:reference(metadata),origin:'live',details:row.details,detailsCitations:row.citations,detailsPublication:null,sharedPublication:null,provenance:{sourceUrl:metadata.url,sourceEvidenceId:metadata.id,sourceHash:metadata.sha256,fetchedAt:metadata.lastFetchedAt,note:'Verified public source acquisition; no installation or execution.'},...extra});}
  function project(url,metadata,extra=[]){const result=createPublicCatalogue({capabilities:[{url,id:stableId(url),origin:'live',metadataEvidence:metadata}],evidence:[metadata,...extra]});return enrichPublicCatalogue(result.snapshot,{evidence:[metadata,...extra]}).items[0];}
  return async(candidate,{signal}={})=>{
    const url=validatePublicURL(candidate.url).href;
    if(candidate.sourceKind!=='github-guidance'){
      let metadata=(candidate.provenance?.evidence||[]).map(existing)[0];
      if(candidate.sourceKind==='github-repository')metadata=await retain('https://api.github.com/repos/'+new URL(url).pathname.slice(1),signal);
      const row=project(url,metadata);
      if(!row)return review('Source metadata does not support a public catalogue record.');
      const repo=candidate.sourceKind==='github-repository'?JSON.parse(metadata.body):null;
      return save(row,metadata,repo?{github:{...row.github,defaultBranch:typeof repo.default_branch==='string'?repo.default_branch:'HEAD',pushedAt:repo.pushed_at||null,disabled:repo.disabled===true,fork:repo.fork===true}}:{});
    }
    const proposal=candidate.guidance;
    if(!proposal||!/^\w[\w.-]*\/[\w.-]+$/.test(proposal.repository)||!safePath(proposal.sourcePath)||!safePath(proposal.defaultBranch)||!/^[a-f0-9]{40}$/.test(proposal.revision))return review('Guidance proposal has an invalid pinned source identity.');
    const metadata=existing(proposal.metadataEvidence),commit=existing(proposal.commitEvidence),tree=existing(proposal.treeEvidence);
    const repo=JSON.parse(metadata.body),treeData=JSON.parse(tree.body),parentURL='https://github.com/'+proposal.repository;
    const parent=project(parentURL,metadata);if(!parent||repo.private!==false||!Array.isArray(treeData.tree))return review('Guidance parent metadata is not verified.');
    const files=treeData.tree.filter(file=>file.type==='blob'&&safePath(file.path)&&['100644','100755'].includes(file.mode));
    const licences=files.filter(file=>/^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(file.path.split('/').at(-1))&&(!directory(file.path)||proposal.sourcePath.startsWith(directory(file.path)+'/'))).sort((a,b)=>directory(b.path).length-directory(a.path).length||a.path.localeCompare(b.path));
    if(!licences.length)return review('No scoped licence file was found for this source document.');
    const proof=[metadata,commit,tree];
    async function file(path){const entry=files.find(value=>value.path===path);if(!entry)throw new Error('Guidance file is absent from the pinned repository tree');const source=await retain(`https://raw.githubusercontent.com/${proposal.repository}/${proposal.revision}/${encoded(path)}`,signal);proof.push(source);return{path,url:source.url,sha256:source.sha256,gitBlobSha:entry.sha,bytes:Buffer.byteLength(source.body)};}
    const document=await file(proposal.sourcePath),licence=await file(licences[0].path),terms=proof.at(-1).body;
    const spdx=/permission is hereby granted, free of charge/i.test(terms)?'MIT':/Apache License[\s\S]*Version 2\.0, January 2004/i.test(terms)?'Apache-2.0':null;
    if(!spdx)return review('The scoped licence is not supported for verified skill/profile redistribution.');
    const scopePath=directory(licence.path),source={repository:proposal.repository,url:parentURL,revision:proposal.revision,defaultBranch:proposal.defaultBranch,metadataEvidence:proposal.metadataEvidence,commitEvidence:proposal.commitEvidence,treeEvidence:proposal.treeEvidence};
    const entry={artifact:candidate.requestedResourceType==='skill'?'agent-skill':'agent-profile',sourcePath:proposal.sourcePath,revision:proposal.revision,parent:{repository:proposal.repository,url:parentURL},sourceDocument:document,license:{spdx,redistribution:'scoped-licence-observed',scope:scopePath?'directory':'repository',scopePath,sourceDocument:licence},acquisition:{files:[document],supportingFiles:[]}};
    const manifest={schemaVersion:1,sources:[source],items:[entry]},projected=projectPublicArtifacts({manifest,evidence:proof,parents:[parent]});
    if(!projected.items.length)return review('Guidance source needs review: '+projected.report.excluded.map(row=>row.reason).join(', '));
    if(projected.items[0].url!==url)return review('Guidance canonical identity differs from the discovered URL.');
    save(parent,metadata);const result=save(projected.items[0],proof[3],{sourceDocumentEvidence:reference(proof[3]),artifactManifest:manifest,artifactEvidence:proof.map(reference)});
    return{...result,relatedIds:[parent.id],reviewRequired:false};
  };
}
