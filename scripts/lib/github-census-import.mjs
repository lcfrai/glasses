import {createHash} from 'node:crypto';
import {createPublicCatalogue} from '../../src/public-catalogue.mjs';
import {stableId} from '../../src/store.mjs';
import {isPublicCensusSearch} from '../../src/github-graphql-source.mjs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const key=url=>url.toLowerCase().replace(/\/$/,'');
/** Zero-network admission of exact public search observations, preserving local overlays. */
export function createCensusImporter({store}){
 const documents=new Map(),existing=new Map(),db=new DatabaseSync(join(store.directory,'glasses.sqlite'),{readOnly:true});
 try{for(const row of db.prepare("SELECT id,json_extract(data,'$.item.url') AS url FROM shared_capabilities").all())existing.set(key(row.url),row.id);for(const row of db.prepare('SELECT id,url FROM capabilities').all())existing.set(key(row.url),row.id);}finally{db.close();}
 return function admit(row,snapshot){
  if(!row||!Number.isSafeInteger(row.repositoryId)||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.url||''))throw Error('Invalid census candidate identity');
  if(snapshot?.status!==200||!isPublicCensusSearch(snapshot.url)||typeof snapshot.body!=='string'||snapshot.sha256!==row.sourceHash||hash(snapshot.body)!==snapshot.sha256)throw Error('Census metadata response integrity mismatch');
  let document=documents.get(snapshot.sha256);
  if(!document){const data=JSON.parse(snapshot.body);if(!Array.isArray(data.items)||data.items.some(repo=>repo.private!==false)||data.items.length>100||data.incomplete_results!==false)throw Error('Census response must be a complete public page');document={data,ref:store.retainEvidence(snapshot)};documents.set(snapshot.sha256,document);}
  const matches=document.data.items.filter(repo=>repo.id===row.repositoryId);
  if(matches.length!==1)throw Error('Census repository numeric identity is missing or ambiguous');
  const repo=matches[0];
  if(key(repo.html_url||'')!==key(row.url)||String(repo.full_name).toLowerCase()!==String(row.repository).toLowerCase()||repo.stargazers_count!==row.stars||typeof repo.fork!=='boolean'||typeof repo.archived!=='boolean')throw Error('Census selected row differs from retained source');
  const oldId=existing.get(key(row.url)),old=oldId?store.getCapability(oldId):null;
  if(old&&old.origin!=='live'&&old.url!==row.url)throw Error('Canonical repository casing changed without retained local numeric proof');
  const projected=createPublicCatalogue({capabilities:[{url:row.url,id:stableId(row.url),origin:'live',metadataEvidence:document.ref}],evidence:[store.getEvidence(document.ref.id)]}).snapshot.items[0];
  if(!projected)throw Error('Strict public projection rejected census metadata');
  if(old?.origin==='live'){
   const previousSource=old.metadataEvidence?.id&&store.getEvidence(old.metadataEvidence.id);let previousRepo;
   if(previousSource?.status===200&&typeof previousSource.body==='string'&&hash(previousSource.body)===previousSource.sha256){const data=JSON.parse(previousSource.body);previousRepo=(Array.isArray(data.items)?data.items:[data]).find(value=>key(value?.html_url||'')===key(row.url));}
   if(previousRepo?.private!==false||previousRepo.id!==repo.id)throw Error('Existing local source has no matching public numeric repository identity');
   const previous=createPublicCatalogue({capabilities:[{...old,metadataEvidence:{id:previousSource.id,sha256:previousSource.sha256}}],evidence:[previousSource]}).snapshot.items[0];
   if(!previous)throw Error('Existing source projection is unavailable for conservative metadata refresh');
   const derived={};for(const field of ['name','description','kind','provider','tags','framework'])if(JSON.stringify(old[field])===JSON.stringify(previous[field]))derived[field]=projected[field];
   const metadataOnly=!old.licenseEvidence||old.licenseEvidence.status==='metadata-only';
   const item=store.upsertCapability({...old,...derived,metadataEvidence:document.ref,github:{...old.github,...projected.github,starsFetchedAt:projected.github.starsObservedAt,repositoryId:repo.id,defaultBranch:repo.default_branch,pushedAt:repo.pushed_at,disabled:repo.disabled??null,fork:repo.fork},...(metadataOnly?{license:projected.license.spdx,licenseEvidence:{status:'metadata-only',scope:'repository',spdx:projected.license.spdx,sourceUrl:snapshot.url,evidenceId:document.ref.id}}:{}),provenance:{...old.provenance,sourceUrl:snapshot.url,sourceEvidenceId:document.ref.id,sourceHash:document.ref.sha256,fetchedAt:snapshot.fetchedAt}}).item;
   return{item,added:false,preservedExisting:true,refreshedMetadata:true,derivedFields:Object.keys(derived),evidence:document.ref};
  }
  const item=store.upsertCapability({...old,...projected,license:projected.license.spdx,origin:'live',metadataEvidence:document.ref,licenseEvidence:{status:'metadata-only',scope:'repository',spdx:projected.license.spdx,sourceUrl:snapshot.url,evidenceId:document.ref.id},github:{...projected.github,starsFetchedAt:projected.github.starsObservedAt,repositoryId:repo.id,defaultBranch:repo.default_branch,pushedAt:repo.pushed_at,disabled:repo.disabled??null,fork:repo.fork},provenance:{...old?.provenance,sourceUrl:snapshot.url,sourceEvidenceId:document.ref.id,sourceHash:document.ref.sha256,fetchedAt:snapshot.fetchedAt,note:'Exact public GitHub census metadata. Popularity and metadata are not licence clearance or compatibility approval.'}}).item;
  existing.set(key(row.url),item.id);return{item,added:true,preservedExisting:false,evidence:document.ref};
 };
}
