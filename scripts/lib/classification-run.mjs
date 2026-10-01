import {createHash} from 'node:crypto';
import {PUBLIC_SOURCE_EXCERPT_VERSION} from '../../src/public-source-excerpt.mjs';
import {CLASSIFICATION_POLICY} from '../../src/classification-policy.mjs';

export const MAX_CALL_USD=64000*0.042/1000000;
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function mergePlans(plans) {
  const rows=new Map(),repositories=new Map();
  for(const plan of plans){
    if(plan.schemaVersion!==1||!Array.isArray(plan.items))throw Error('Invalid source acquisition plan');
    for(const item of plan.items){
      if(typeof item.id!=='string'||!item.id||!Number.isSafeInteger(item.repositoryId)||item.repositoryId<=0||!/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/?$/i.test(item.url)||!Number.isSafeInteger(item.stars)||item.stars<0)throw Error('Invalid acquired repository identity');
      if(item.metadataSourceHash!==undefined&&!/^[a-f0-9]{64}$/.test(item.metadataSourceHash))throw Error('Invalid metadata source hash');
      const binding={id:item.id,repositoryId:item.repositoryId,url:item.url.toLowerCase().replace(/\/$/,''),revision:item.revision??null,proof:item.proof??null,readmePinned:!!item.readmePinned,metadataSourceHash:item.metadataSourceHash??null,selectionVersion:PUBLIC_SOURCE_EXCERPT_VERSION,classificationPolicy:CLASSIFICATION_POLICY};
      if(rows.has(item.id)&&hash(rows.get(item.id).binding)!==hash(binding))throw Error('Acquisition binding changed for '+item.id);
      if(repositories.has(item.repositoryId)&&repositories.get(item.repositoryId)!==item.id)throw Error('Duplicate numeric repository identity');
      repositories.set(item.repositoryId,item.id);rows.set(item.id,{...item,binding});
    }
  }
  return [...rows.values()].sort((a,b)=>b.stars-a.stars||a.id.localeCompare(b.id));
}
export function usageTotal(jobs){
  const receipts=new Map();
  for(const job of jobs)for(const row of job.usage||[]){if(receipts.has(row.id)&&JSON.stringify(receipts.get(row.id))!==JSON.stringify(row))throw Error('Conflicting usage receipt');receipts.set(row.id,row);}
  return [...receipts.values()].reduce((sum,row)=>{
    if(row.provider!=='jev')return sum;
    const reserved=row.chargedOrReservedUsd??row.costUsd??MAX_CALL_USD;
    if(!Number.isFinite(reserved)||reserved<0)throw Error('Invalid usage cost');
    return {calls:sum.calls+Number(row.requestSent!==false),inputTokens:sum.inputTokens+(row.inputTokens||0),outputTokens:sum.outputTokens+(row.outputTokens||0),reportedCostUsd:sum.reportedCostUsd+(row.costUsd||0),chargedOrReservedUsd:sum.chargedOrReservedUsd+reserved,unknownCostCalls:sum.unknownCostCalls+Number(row.costUsd==null)};
  },{calls:0,inputTokens:0,outputTokens:0,reportedCostUsd:0,chargedOrReservedUsd:0,unknownCostCalls:0});
}
export function permittedBatchCount(usage,budget,maximum=30){
  if(!Number.isFinite(budget)||budget<=0||budget>39)throw Error('Run budget must be within the authorized US$39 local allocation');
  return Math.max(0,Math.min(maximum,Math.floor((budget-usage.chargedOrReservedUsd+1e-12)/MAX_CALL_USD)));
}
