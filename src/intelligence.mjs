import { createHash, randomUUID } from 'node:crypto';
import { createIntelligenceStore } from './intelligence-store.mjs';
import { searchTerms } from './store.mjs';
import { validatePublicURL } from './discovery.mjs';
import { measureJevClassificationBatch, isDefinitelyUnsentProviderError, ARTIFACTS, ADOPTIONS } from './providers.mjs';
import { CLASSIFICATION_SCHEMA, CLASSIFICATION_POLICY, LEGACY_CLASSIFICATION_POLICY, classificationFingerprint, registryComponentIdentity, registryIndexItemURL } from './classification-policy.mjs';
import { repositoryReadmeRefs } from './github-readme.mjs';
import { GRAPHQL_SOURCE_URL, graphqlReadme } from './github-graphql-source.mjs';
import {PUBLIC_SOURCE_EXCERPT_VERSION,selectPublicSourceExcerpt} from './public-source-excerpt.mjs';
import { purposeAnchor, purposeEvidence } from './purpose-matching.mjs';
import {searchConstraints,sourceConstraintFacts,constraintFit,constraintWeight,constraintPriority} from './search-constraints.mjs';

export { ARTIFACTS, ADOPTIONS } from './providers.mjs';
export const INTELLIGENCE_SCHEMA=CLASSIFICATION_SCHEMA;
export const INTELLIGENCE_POLICY=CLASSIFICATION_POLICY;
export const DEFAULT_INTELLIGENCE_SETTINGS={provider:'codex',autoClassify:false,autoResearch:false,maxCandidates:10,maxJobsPerDay:4,timeoutSeconds:180,jevDailyBudgetUsd:0.10,jevConcurrency:1,confidenceThreshold:0.65};
const now=()=>new Date().toISOString(), hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const unique=values=>[...new Set(values)];
const MAX_QUEUE=20, JEV_MAX_CALL_USD=64000*0.042/1000000;
const text=(value,max=2000)=>typeof value==='string'?value.slice(0,max):'';
const boundedText=(value,name,max)=>{if(typeof value!=='string'||value.length>max)throw fail(`${name} must be a string of at most ${max} characters`);return value;};
// Popularity breaks equal relevance scores; it never establishes source quality
// or licence clearance. Unknown stars remain unknown, including registry items.
function comparePopularity(a,b) {
  const unavailable=item=>item.github?.archived===true||item.github?.disabled===true?1:0;
  const stars=item=>Number.isSafeInteger(item.github?.stars)&&item.github.stars>=0?item.github.stars:-1;
  return unavailable(a)-unavailable(b)||stars(b)-stars(a)||a.name.localeCompare(b.name);
}
function stringArray(value,name,maxItems=20,maxLength=100){if(!Array.isArray(value)||value.length>maxItems||value.some(x=>typeof x!=='string'||!x.trim()||x.length>maxLength))throw fail(`${name} must contain at most ${maxItems} non-empty strings of at most ${maxLength} characters`);return unique(value.map(x=>x.trim()));}
function publicURL(value){try{return validatePublicURL(value).href;}catch{return null;}}
function excerpt(snapshot,item,parsedCache){
  const selected=value=>{try{return selectPublicSourceExcerpt(value).text;}catch{return '';}};
  if(snapshot.url===GRAPHQL_SOURCE_URL){try{const source=graphqlReadme(snapshot,item.graphqlReadmeProof);return item.url.toLowerCase()===`https://github.com/${source.repository}`.toLowerCase()&&item.provenance?.resolvedRevision===source.revision?selected(source.text):'';}catch{return '';}}
  let value=snapshot.body;const registryIndex=snapshot.url==='https://registry.directory/items.json';
  try {
    let data=parsedCache.get(snapshot.id);if(data===undefined){data=JSON.parse(value);parsedCache.set(snapshot.id,data);}
    if(registryIndex){
      if(!registryComponentIdentity(item.url)||!Array.isArray(data.items))return '';
      const matches=data.items.filter(entry=>registryIndexItemURL(entry)===item.url);
      // Missing or duplicate identities are not licence to use a different
      // provider, nor to expose the beginning of the full shared index.
      return matches.length===1?text(JSON.stringify(matches[0]),2000):'';
    }
    if(data.encoding==='base64'&&typeof data.content==='string')value=Buffer.from(data.content,'base64').toString('utf8');
    else {
      const entries=Array.isArray(data)?data:data.items||data.registries;
      const selected=Array.isArray(entries)?entries.find(entry=>entry&&(entry.html_url===item.url||entry.url===item.url||entry.full_name===item.name||entry.name===item.name||entry.title===item.name)):null;
      value=selected?JSON.stringify(selected):value;
    }
  }catch{if(registryIndex)return '';}
  return repositoryReadmeRefs(item).includes(snapshot.id)?selected(value):text(value,2000);
}

export function createIntelligence({store,discovery,providers,dataDir=store.directory}) {
  if(!providers?.classify||!providers?.plan||!providers?.rank)throw new Error('Intelligence providers must implement classify, plan and rank');
  const db=createIntelligenceStore(dataDir);
  let settings={...DEFAULT_INTELLIGENCE_SETTINGS,...(db.get('settings','current')?.value||{})};
  let closed=false,running=null,pumpPromise=null,nextJevRequestAt=0;
  // Synchronous discovery hooks can use models already observed by this engine
  // without spawning a status probe or changing their public return contract.
  const observedModels=Object.assign({},...db.all('jobs').sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')).map(job=>job.providerModels||{}));
  for(const job of db.all('jobs'))if(['queued','running'].includes(job.status))db.save('jobs',{...job,status:'interrupted',stage:'interrupted',finishedAt:now(),errors:[...(job.errors||[]),'The local intelligence engine stopped before this job completed. Retry explicitly; previous inference may have consumed usage.']});
  const saveJob=job=>db.save('jobs',job);
  const checkAbort=signal=>{if(signal?.aborted)throw signal.reason||new Error('Job cancelled');};
  const getSettings=()=>({...settings});
  const usageToday=()=>{
    const day=now().slice(0,10);
    return {day,timeZone:'UTC',...db.usageSummary(day),note:'Codex subscription usage is not converted to API prices. Unreported Jev costs retain a conservative per-call reservation; verified local rejections consume no inference budget.'};
  };
  function cardFor(id,{hydrate=true,snapshots=new Map(),parsed=new Map(),item:knownItem}={}) {
    const item=knownItem??store.getCapabilitySummary(id);if(!item)return null;
    if(item.origin!=='live'||!publicURL(item.url))return null;
    const repositoryEvidence=item.repositoryEvidence||[];
    const refs=unique([...repositoryReadmeRefs(item),item.sourceDocumentEvidence?.id,item.metadataEvidence?.id,item.registryDocumentEvidence?.id,item.provenance?.sourceEvidenceId,item.licenseEvidence?.evidenceId,...repositoryEvidence.map(x=>x.id)].filter(Boolean));
    const base={id:item.id,name:text(item.name,200),url:item.url,description:text(item.description,1200),provider:text(item.provider,100),sourceKind:item.kind,tags:(item.tags||[]).filter(x=>typeof x==='string').slice(0,15)};
    // Evidence IDs already bind URL + content hash. Catalogue staleness checks
    // must never parse the original multi-megabyte registry body per record.
    const repositorySourceSelection=repositoryReadmeRefs(item).length?PUBLIC_SOURCE_EXCERPT_VERSION:null;
    const sourceFingerprint=classificationFingerprint({base,evidenceIds:refs,revision:item.provenance?.resolvedRevision||item.provenance?.revision||null,sourceHash:item.provenance?.sourceHash||null,repositorySourceSelection});
    if(!hydrate)return {...base,evidenceIds:refs,sourceFingerprint,repositorySourceSelection};
    const evidence=refs.slice(0,3).map(id=>{if(!snapshots.has(id))snapshots.set(id,store.getEvidence(id));return snapshots.get(id);}).filter(snapshot=>snapshot&&publicURL(snapshot.url)).map(snapshot=>({id:snapshot.id,sha256:snapshot.sha256,url:snapshot.url,excerpt:excerpt(snapshot,item,parsed)}));
    return {...base,evidenceIds:evidence.map(x=>x.id),evidence,sourceFingerprint,repositorySourceSelection};
  }
  function validateAssessment(input,card,{partial=false}={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Assessment must be an object');
    const allowed=partial?['artifact','adoption','capabilities','notes']:['id','artifact','adoption','capabilities','confidence','evidenceIds'];
    for(const key of Object.keys(input))if(!allowed.includes(key))throw fail(`Unknown assessment field: ${key}`);
    const result={};
    for(const [key,options] of [['artifact',ARTIFACTS],['adoption',ADOPTIONS]]){if(partial&&input[key]===undefined)continue;if(!options.includes(input[key]))throw fail(`Invalid ${key}`);result[key]=input[key];}
    if(!partial||input.capabilities!==undefined)result.capabilities=stringArray(input.capabilities,'capabilities');
    if(partial){if(input.notes!==undefined)result.notes=boundedText(input.notes,'notes',1000);if(!Object.keys(result).length)throw fail('Provide artifact, adoption, capabilities or notes');}
    else {
      if(input.id!==undefined&&input.id!==card.id)throw fail('Assessment candidate identity does not match');
      if(typeof input.confidence!=='number'||!Number.isFinite(input.confidence)||input.confidence<0||input.confidence>1)throw fail('confidence must be between 0 and 1');
      result.confidence=input.confidence;result.evidenceIds=stringArray(input.evidenceIds,'evidenceIds',20,200);
      if(!result.evidenceIds.length||result.evidenceIds.some(id=>!card.evidenceIds.includes(id)))throw fail('Assessment must cite retained public evidence from this candidate');
    }
    return result;
  }
  function assessment(id,knownItem,records) {
    const item=knownItem??store.getCapabilitySummary(id);if(!item)return null;
    const classified=records?records.assessments.get(id):db.get('assessments',id),correction=records?records.corrections.get(id):db.get('corrections',id),card=cardFor(id,{hydrate:false,item});
    const stale=!!classified&&(classified.policyVersion!==INTELLIGENCE_POLICY||classified.sourceFingerprint!==card?.sourceFingerprint);
    const values={artifact:'unknown',adoption:'unknown',capabilities:[],confidence:null,evidenceIds:[],...(classified?.classification||{}),...(correction?.patch||{})};
    return {capabilityId:id,...values,status:stale?'stale':correction?'corrected':!classified?'unclassified':values.confidence>=settings.confidenceThreshold&&values.artifact!=='unknown'?'classified':'needs-review',stale,humanCorrected:!!correction,provider:classified?.provider||null,model:classified?.model||null,updatedAt:correction?.updatedAt||classified?.updatedAt||null,classification:classified?.classification||null,correction:correction?.patch||null,sourceFingerprint:classified?.sourceFingerprint||null,currentFingerprint:card?.sourceFingerprint||null,schemaVersion:INTELLIGENCE_SCHEMA,policyVersion:classified?(classified.policyVersion||LEGACY_CLASSIFICATION_POLICY):null,currentPolicyVersion:INTELLIGENCE_POLICY};
  }
  function persistAssessment(card,classification,{provider,model,jobId=null}) {
    const validated=validateAssessment(classification,card);
    const previous=db.get('assessments',card.id);
    if(previous?.provider===provider&&previous?.model===model&&previous?.policyVersion===INTELLIGENCE_POLICY&&previous?.sourceFingerprint===card.sourceFingerprint&&JSON.stringify(previous.classification)===JSON.stringify(validated))return assessment(card.id);
    db.save('assessments',{id:card.id,classification:validated,provider,model,jobId,sourceFingerprint:card.sourceFingerprint,repositorySourceSelection:card.repositorySourceSelection,schemaVersion:INTELLIGENCE_SCHEMA,policyVersion:INTELLIGENCE_POLICY,updatedAt:now()});
    return assessment(card.id);
  }
  function decorate(items,{query='',artifact}={}) {
    boundedText(query,'query',500);if(artifact&&artifact!=='all'&&!ARTIFACTS.includes(artifact))throw fail('Invalid artifact filter');
    // Each catalogue request gets fresh model/correction rows in two reads,
    // rather than two prepared primary-key lookups for every candidate. Keep
    // this request-scoped so commits from other local processes remain visible.
    const records=items.length?{assessments:new Map(db.all('assessments').map(row=>[row.id,row])),corrections:new Map(db.all('corrections').map(row=>[row.id,row]))}:null;
    const terms=searchTerms(query),anchor=purposeAnchor(query),exactQuery=query.normalize('NFKC').trim().toLowerCase();
    const constraints=searchConstraints(query);
    const outcomeText=new Map();
    if(terms.length)for(const outcome of store.outcomes())outcomeText.set(outcome.capabilityId,`${outcomeText.get(outcome.capabilityId)||''} ${outcome.result||''} ${outcome.notes||''} ${Object.values(outcome.context||{}).join(' ')}`.toLowerCase());
    return items.map(item=>{
      // Search already supplied the current capability. Reuse that snapshot
      // rather than reparsing the same database JSON twice for every result.
      const info=assessment(item.id,item,records),inferred=[info?.artifact,info?.adoption,...(info?.capabilities||[])].join(' ').toLowerCase();
      const shared=item.origin==='shared'&&item.sharedAssessment?[item.sharedAssessment.artifact,item.sharedAssessment.adoption,...(item.sharedAssessment.capabilities||[])].join(' ').toLowerCase():'';
      const fields={name:text(item.name).toLowerCase(),tags:(item.tags||[]).join(' ').toLowerCase(),description:text(item.description,4000).toLowerCase(),provider:text(item.provider).toLowerCase(),kind:item.kind,framework:text(item.framework).toLowerCase(),outcomes:outcomeText.get(item.id)||'',inferred,sharedInferred:shared,sourceDetails:[item.details?.overview,...item.details?.features||[],...item.details?.keywords||[],...(item.details?.sections||[]).map(section=>section.title+' '+section.summary)].filter(Boolean).join(' ').toLowerCase()};
      const matches=terms.filter(term=>Object.values(fields).some(value=>String(value).includes(term)));
      let score=terms.reduce((sum,term)=>sum+(fields.name.includes(term)?4:0)+(fields.tags.includes(term)?3:0)+(fields.framework.includes(term)?3:0)+(fields.description.includes(term)?1:0)+(inferred.includes(term)?3:0)+(shared.includes(term)?2:0)+(fields.sourceDetails.includes(term)?1:0),0);
      // Repeated mentions of one easy term should not outrank evidence for the
      // complete request. Retain partial candidates rather than treating missing
      // metadata as a hard incompatibility; exact identities still win below.
      const coverage=terms.length?matches.length/terms.length:1;
      score*=0.3+0.7*coverage*coverage;
      const exact=exactQuery&&(fields.name===exactQuery||text(item.url,4000).toLowerCase()===exactQuery||item.id===exactQuery),purpose=purposeEvidence(anchor,fields);
      if(anchor&&!exact)score=score*purpose.weight+purpose.bonus;
      let frameworkExcluded=false,constraintRank=0;
      if(item.kind==='component'&&!exact){
        // Only declared/source facts identify a framework. Inferred labels and
        // JSX syntax do not, and whole tools retain their existing behaviour.
        const fit=constraintFit(constraints,sourceConstraintFacts(item));
        frameworkExcluded=fit.framework==='different';
        score*=constraintWeight(fit);
        constraintRank=constraintPriority(fit);
      }
      if(exact)score+=500;
      return {...item,assessment:info,matchReason:terms.length?`Text matched: ${matches.join(', ')} (${matches.length}/${terms.length} terms), including inferred labels and local outcome context${matches.some(term=>shared.includes(term))?'; attributed shared labels are not locally verified':''}${anchor?`; ${anchor} purpose: ${purpose.level}`:''}. Classification is not verified compatibility.`:item.matchReason,_matches:frameworkExcluded?0:matches.length||Number(purpose.matched)||Number(exact),_score:score,_constraintRank:constraintRank,_exact:Number(Boolean(exact))};
    }).filter(item=>(!terms.length||item._matches)&&(!artifact||artifact==='all'||item.assessment?.artifact===artifact)).sort((a,b)=>b._exact-a._exact||b._constraintRank-a._constraintRank||b._score-a._score||comparePopularity(a,b)).map(({_matches,_score,_constraintRank,_exact,...item})=>item);
  }
  async function providerState(){const state=await providers.status?.()||{};for(const provider of ['codex','jev'])if(state[provider]?.model)observedModels[provider]=state[provider].model;return state;}
  function needsClassification(card,provider,model) {
    const previous=db.get('assessments',card.id);
    return !previous||previous.schemaVersion!==INTELLIGENCE_SCHEMA||previous.policyVersion!==INTELLIGENCE_POLICY||previous.sourceFingerprint!==card.sourceFingerprint||previous.provider!==provider||!!model&&previous.model!==model;
  }
  function selectCandidates(ids,query,limit,{classification=false,provider=settings.provider,model=observedModels[provider],pendingOnly=false,cardCache={snapshots:new Map(),parsed:new Map()}}={}) {
    const scope=ids?new Set(ids):null;
    // An explicit bounded MCP batch must not parse and decorate the entire
    // catalogue. Keep the same eligibility and ordering within its membership.
    const eligible=(scope?[...scope].map(id=>store.getCapabilitySummary(id)).filter(Boolean):store.search({query:''})).filter(item=>item.origin==='live');
    const matching=decorate(eligible,{query});
    const matchedIds=new Set(matching.map(item=>item.id)),remaining=eligible.filter(item=>!matchedIds.has(item.id)).sort(comparePopularity);
    const groups=classification?[[],[],[],[]]:[matching,remaining];
    if(classification)for(const item of [...matching,...remaining]){
      const card=cardFor(item.id,{hydrate:false});
      if(!card?.evidenceIds.length)continue;
      const pending=needsClassification(card,provider,model);
      if(pendingOnly&&!pending)continue;
      groups[(pending?0:2)+(matchedIds.has(item.id)?0:1)].push(item);
    }
    const selected=[];
    for(const items of groups){
      const solutions=[],components=[],other=[];
      for(const item of items){const artifact=item.assessment?.artifact;(['whole-product','agent-extension','memory-engine','replacement-agent','tool-library'].includes(artifact)||item.kind==='solution'?solutions:item.kind==='component'?components:other).push(item.id);}
      while(selected.length<limit&&(solutions.length||components.length||other.length))for(const bucket of [solutions,solutions,components,other]){
        if(!bucket.length||selected.length>=limit)continue;
        const id=bucket.shift();
        // Check retained public evidence only for shortlisted candidates. Shared
        // snapshots are loaded once and reused by subsequent card hydration.
        if(classification&&!cardFor(id,cardCache)?.evidenceIds.length)continue;
        selected.push(id);
      }
      if(selected.length>=limit)break;
    }
    return selected;
  }
  async function withAbort(promise,signal){
    checkAbort(signal);let rejectAbort;
    const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(signal.reason||new Error('Job cancelled'));signal.addEventListener('abort',rejectAbort,{once:true});});
    try{return await Promise.race([promise,aborted]);}finally{signal.removeEventListener('abort',rejectAbort);}
  }
  async function callProvider(job,provider,operation,payload,signal) {
    checkAbort(signal);
    const state=await providerState();checkAbort(signal);
    if(state[provider]?.configured===false)throw new Error(`${provider} is not configured; connect it before running intelligence`);
    // One engine owns all reservations. Pace starts even when classification
    // uses several in-flight requests; a cancelled wait has sent no request.
    if(provider==='jev'&&job.settingsSnapshot.jevConcurrency>1){
      const at=Math.max(Date.now(),nextJevRequestAt);nextJevRequestAt=at+400;
      if(at>Date.now())await withAbort(new Promise(resolve=>setTimeout(resolve,at-Date.now())),signal);
      checkAbort(signal);
    }
    const usage=usageToday();
    if(provider==='jev'&&state.jev?.model!=='jev-1.13.0')throw new Error('Jev budget requires the reviewed pinned model jev-1.13.0');
    if(provider==='jev'&&usage.jevReservedUsd+JEV_MAX_CALL_USD>Math.min(settings.jevDailyBudgetUsd,job.settingsSnapshot.jevDailyBudgetUsd)+1e-12)throw fail('Jev daily budget would be exceeded; adjust the cap or wait for the next UTC day',429);
    const receipt={id:randomUUID(),jobId:job.id,provider,operation,createdAt:now(),status:'running',costUsd:null,chargedOrReservedUsd:provider==='jev'?JEV_MAX_CALL_USD:0};
    if(provider==='jev'&&operation==='classify')receipt.request={candidateIds:payload.cards.map(card=>card.id),...measureJevClassificationBatch(payload.cards)};
    db.save('usage',receipt);
    let response;
    try {
      const promise=operation==='plan'?providers.plan({...payload,signal,timeoutMs:job.settingsSnapshot.timeoutSeconds*1000}):providers[operation](provider,{...payload,signal,timeoutMs:job.settingsSnapshot.timeoutSeconds*1000,model:job.providerModels?.[provider]||state[provider]?.model});
      response=await withAbort(promise,signal);checkAbort(signal);
      if(!response||typeof response!=='object'||typeof response.model!=='string'||!response.model.trim())throw new Error('Provider response is missing its actual model version');
      const data=response.usage||{};
      receipt.status='completed';receipt.model=response.model;
      for(const key of ['inputTokens','outputTokens'])if(Number.isFinite(data[key])&&data[key]>=0)receipt[key]=data[key];
      if(provider==='jev')receipt.costUsd=Number.isFinite(data.costUsd)&&data.costUsd>=0?data.costUsd:Number.isFinite(data.inputTokens)?data.inputTokens*0.042/1000000:null;
      else receipt.costUsd=null;
      if(receipt.costUsd!==null)receipt.chargedOrReservedUsd=receipt.costUsd;
      return response;
    }catch(error){
      receipt.status=signal.aborted?'cancelled':'failed';receipt.error=text(error.message,1000);
      // Public diagnostics distinguish an explicit HTTP rejection from an
      // uncertain transport failure. Both keep their conservative reservation.
      if(/^JEV_HTTP_[1-5]\d\d$/.test(error.code||''))receipt.providerHttpStatus=Number(error.code.slice(-3));
      if(['question-limit','context-limit','account-quota','text-encoding','request-validation','unrecognized-response'].includes(error.diagnostics?.reason))receipt.providerReason=error.diagnostics.reason;
      if(Number.isFinite(error.retryAfterSeconds)&&error.retryAfterSeconds>=0&&error.retryAfterSeconds<=3600)receipt.retryAfterSeconds=error.retryAfterSeconds;
      if(isDefinitelyUnsentProviderError(error))Object.assign(receipt,{requestSent:false,costUsd:0,chargedOrReservedUsd:0,inputTokens:0,outputTokens:0});
      throw error;
    }
    finally{receipt.finishedAt=now();db.save('usage',receipt);job.usage.push(receipt);saveJob(job);}
  }
  async function classify(job,signal) {
    const automatic=job.type==='research'||['automatic','discovery'].includes(job.selectionMode);
    const scope=job.selectionMode==='automatic'?null:job.selectionMode==='discovery'?job.selectionScopeIds:job.candidateIds;
    const cards=[],cardCache={snapshots:new Map(),parsed:new Map()};
    const state=await providerState();checkAbort(signal);
    const model=job.providerModels?.[job.provider]||state[job.provider]?.model;
    const ids=selectCandidates(scope,job.query,job.settingsSnapshot.maxCandidates,{classification:automatic,provider:job.provider,model,pendingOnly:automatic&&job.type!=='research',cardCache});
    // Explicit caller and research-discovery membership remain intact. For an
    // automatic job, candidateIds describes the actual execution-time choice;
    // its earlier provisional selection is retained separately for provenance.
    if(['automatic','discovery'].includes(job.selectionMode))job.candidateIds=[...ids];
    job.result.classificationCandidateIds=ids;
    if(automatic&&!ids.length)job.result.noPendingWork=true;
    saveJob(job);
    if(job.type==='research'&&discovery.inspect){
      const enrich=ids.map(id=>store.getCapability(id)).filter(item=>item?.kind==='solution'&&/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(item.url)&&!repositoryReadmeRefs(item).length).slice(0,3);
      job.result.enrichedCandidateIds=[];
      for(const item of enrich){
        checkAbort(signal);job.stage='enriching-source';saveJob(job);
        try{const inspected=await discovery.inspect(item.id,{fetchSource:true,signal});checkAbort(signal);if(inspected?.sourceError)job.errors.push(`${item.id}: source enrichment: ${inspected.sourceError}`);if(repositoryReadmeRefs(inspected||{}).length)job.result.enrichedCandidateIds.push(item.id);}
        catch(error){checkAbort(signal);job.errors.push(`${item.id}: source enrichment: ${error.message}`);}
      }
    }
    for(const id of ids){const card=cardFor(id,cardCache);if(!card?.evidenceIds.length){job.errors.push(`${id}: no retained public source evidence to classify`);continue;}cards.push(card);}
    checkAbort(signal);
    const misses=[];job.result.assessmentIds=[];job.result.cacheHits=0;
    for(const card of cards){
      const key=model?hash({operation:'classify',schema:INTELLIGENCE_SCHEMA,policy:INTELLIGENCE_POLICY,provider:job.provider,model,fingerprint:card.sourceFingerprint}):null;
      const cached=key?db.get('cache',key):null;
      if(cached){persistAssessment(card,cached.classification,{provider:job.provider,model:cached.model,jobId:job.id});job.result.assessmentIds.push(card.id);job.result.cacheHits++;}
      else misses.push(card);
    }
    const batchSize=job.provider==='jev'?3:10,batches=[];let nextBatch=[];
    const fitsBatch=batch=>{
      if(job.provider!=='jev')return Buffer.byteLength(JSON.stringify(batch))<=55000;
      try{return measureJevClassificationBatch(batch).fits;}
      catch(error){if(isDefinitelyUnsentProviderError(error)&&error.code==='INVALID_CARDS')return false;throw error;}
    };
    for(const card of misses){
      if(!fitsBatch([card])){job.errors.push(`${card.id}: public source card exceeds the provider context bound; no request sent`);continue;}
      if(nextBatch.length&&(nextBatch.length>=batchSize||!fitsBatch([...nextBatch,card]))){batches.push(nextBatch);nextBatch=[];}
      nextBatch.push(card);
    }
    if(nextBatch.length)batches.push(nextBatch);
    let nextBatchIndex=0,workerFailure=null;
    async function classifyWorker(){while(nextBatchIndex<batches.length&&!workerFailure){
      const batch=batches[nextBatchIndex++];
      try{
      checkAbort(signal);job.stage='classifying';saveJob(job);
      const response=await callProvider(job,job.provider,'classify',{cards:batch},signal);
      if(!Array.isArray(response.results))throw new Error('Classifier did not return a results array');
      const seen=new Set();
      for(const result of response.results){
        const card=batch.find(card=>card.id===result?.id);
        if(!card||seen.has(result.id)){job.errors.push('Classifier returned an unknown or duplicate candidate identity');continue;}
        seen.add(card.id);
        try{
          const validated=validateAssessment(result,card);persistAssessment(card,validated,{provider:job.provider,model:response.model,jobId:job.id});
          db.save('cache',{id:hash({operation:'classify',schema:INTELLIGENCE_SCHEMA,policy:INTELLIGENCE_POLICY,provider:job.provider,model:response.model,fingerprint:card.sourceFingerprint}),classification:validated,model:response.model,policyVersion:INTELLIGENCE_POLICY,createdAt:now()});
          job.result.assessmentIds.push(card.id);
        }catch(error){job.errors.push(`${card.id}: ${error.message}`);}
      }
      for(const card of batch)if(!seen.has(card.id))job.errors.push(`${card.id}: classifier omitted this candidate`);
      saveJob(job);
      }catch(error){workerFailure ||= error;}
    }}
    const concurrency=job.provider==='jev'?Math.min(settings.jevConcurrency,job.settingsSnapshot.jevConcurrency||1):1;
    // Await every already-started request so failed/aborted jobs retain complete
    // usage before reporting terminal state. Never retry uncertain paid calls.
    await Promise.all(Array.from({length:Math.min(concurrency,batches.length)},classifyWorker));
    if(workerFailure)throw workerFailure;
    job.result.assessmentIds=unique(job.result.assessmentIds);
  }
  async function rank(job,signal) {
    const cardCache={snapshots:new Map(),parsed:new Map()};
    const cards=job.candidateIds.slice(0,30).map(id=>cardFor(id,cardCache)).filter(card=>card?.evidenceIds.length).map(card=>{const info=assessment(card.id);return {...card,description:text(card.description,400),evidence:card.evidence.slice(0,1).map(evidence=>({...evidence,excerpt:text(evidence.excerpt,300)})),assessment:{artifact:info?.artifact,adoption:info?.adoption}};});
    if(!cards.length){job.errors.push('No public evidence candidates available to rank');return;}
    const state=await providerState(),model=job.providerModels?.[job.provider]||state[job.provider]?.model;
    const assessmentRevisions=cards.map(card=>({id:card.id,updatedAt:assessment(card.id)?.updatedAt||null}));
    const cacheKey=resolvedModel=>hash({operation:'rank',schema:INTELLIGENCE_SCHEMA,policy:INTELLIGENCE_POLICY,provider:job.provider,model:resolvedModel,query:job.query,cards,assessmentRevisions});
    const cached=model?db.get('cache',cacheKey(model)):null;
    if(cached){job.result.rankings=cached.results;job.result.cacheHits=1;return;}
    job.stage='ranking';saveJob(job);
    const response=await callProvider(job,job.provider,'rank',{query:job.query,cards},signal);
    if(!Array.isArray(response.results))throw new Error('Ranker did not return a results array');
    const seen=new Set(),results=[];
    for(const item of response.results){if(!cards.some(card=>card.id===item?.id)||seen.has(item?.id)||!Number.isFinite(item?.score)||item.score<0||item.score>1){job.errors.push('Ranker returned invalid identity or score');continue;}seen.add(item.id);results.push({id:item.id,score:item.score});}
    for(const card of cards)if(!seen.has(card.id))job.errors.push(`${card.id}: ranker omitted this candidate`);
    job.result.rankings=results.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));job.result.cacheHits=0;
    if(!job.errors.length)db.save('cache',{id:cacheKey(response.model),results:job.result.rankings,model:response.model,createdAt:now()});
  }
  async function research(job,signal) {
    job.stage='planning';saveJob(job);
    const plan=await callProvider(job,'codex','plan',{query:job.query},signal);
    const queries=stringArray(plan.queries||[],'queries',2,200),urls=stringArray(plan.urls||[],'urls',2,4000);
    if(!queries.length&&!urls.length)throw new Error('Research planner returned no queries or public URLs');
    job.result.plan={queries,urls,model:plan.model};saveJob(job);
    for(const query of queries){
      checkAbort(signal);job.stage='discovering';saveJob(job);
      try{
        const run=await discovery.scout({query,planSnapshot:job.planSnapshot,trigger:'intelligence',signal});
        job.runIds.push(run.id);job.candidateIds=unique([...job.candidateIds,...(run.candidateIds||[])]);job.errors.push(...(run.errors||[]).map(error=>`Discovery ${run.id}: ${error}`));saveJob(job);
      }catch(error){checkAbort(signal);job.errors.push(`Discovery query ${query}: ${error.message}`);}
    }
    for(const url of urls){
      checkAbort(signal);
      try{validatePublicURL(url);const item=await discovery.importUrl(url,{signal});job.candidateIds=unique([...job.candidateIds,item.id]);saveJob(job);}catch(error){checkAbort(signal);job.errors.push(`Import ${url}: ${error.message}`);}
    }
    checkAbort(signal);await classify(job,signal);
  }
  async function runJob(job) {
    const controller=new AbortController();running={job,controller};
    job.status='running';job.startedAt=now();job.stage='starting';saveJob(job);
    const timer=setTimeout(()=>controller.abort(Object.assign(new Error(`Job deadline exceeded after ${job.settingsSnapshot.timeoutSeconds} seconds`),{deadline:true})),job.settingsSnapshot.timeoutSeconds*1000);timer.unref?.();
    try {
      if(job.trigger==='scheduled'&&job.planId&&!store.getResearchPlan(job.planId)?.enabled){controller.abort(new Error('Research plan was paused before this queued job started'));checkAbort(controller.signal);}
      const state=await providerState();job.providerModels=Object.fromEntries(['codex','jev'].map(provider=>[provider,state[provider]?.model||null]));saveJob(job);
      if(job.type==='research')await research(job,controller.signal);else if(job.type==='rank')await rank(job,controller.signal);else await classify(job,controller.signal);
      checkAbort(controller.signal);
      const hasResults=job.type==='rank'?job.result.rankings?.length:job.result.assessmentIds?.length;
      job.status=job.errors.length?(hasResults||job.type==='research'&&job.candidateIds.length?'partial':'failed'):'completed';
    }catch(error){const hasResults=job.result.assessmentIds?.length||job.result.rankings?.length||job.type==='research'&&job.candidateIds.length;job.status=controller.signal.aborted&&!controller.signal.reason?.deadline?'cancelled':hasResults?'partial':'failed';job.errors.push(text(error.message||String(error),1500));}
    finally{clearTimeout(timer);job.stage=job.status;job.finishedAt=now();saveJob(job);running=null;}
  }
  function pump(){
    if(closed||pumpPromise)return;
    pumpPromise=Promise.resolve().then(async()=>{while(!closed){const job=db.nextQueuedJob();if(!job)break;await runJob(job);}}).finally(()=>{pumpPromise=null;});
  }
  function enqueue(input={},selection={}) {
    if(closed)throw fail('Intelligence engine is closed',503);
    if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Job request must be an object');
    for(const key of Object.keys(input))if(!['type','planId','query','candidateIds','provider','trigger'].includes(key))throw fail(`Unknown job field: ${key}`);
    if(!['classify','research','rank'].includes(input.type))throw fail('type must be classify, research or rank');
    const provider=input.provider??settings.provider;if(!['codex','jev'].includes(provider))throw fail('provider must be codex or jev');
    const trigger=input.trigger||'manual';if(!['manual','scheduled','agent'].includes(trigger))throw fail('Invalid job trigger');
    const plan=input.planId?store.getResearchPlan(input.planId):null;if(input.planId&&!plan)throw fail('Research plan not found',404);
    if(trigger==='scheduled'&&plan&&!plan.enabled)throw fail('Research plan is paused',409);
    const query=input.query??plan?.query??'';boundedText(query,'query',500);
    if(input.type==='research'&&(!query.trim()||query.length>200))throw fail('Research requires a non-empty query of at most 200 characters');
    if(input.type==='rank'&&!query.trim())throw fail('Ranking requires a public query');
    const selectionMode=input.type==='classify'?(selection.mode|| (input.candidateIds===undefined?'automatic':'explicit')):'explicit';
    let candidateIds=input.candidateIds===undefined?null:stringArray(input.candidateIds,'candidateIds',30,100);
    if(candidateIds)for(const id of candidateIds)if(!store.getCapability(id))throw fail(`Capability not found: ${id}`,404);
    if(!candidateIds)candidateIds=input.type==='research'?[]:selectCandidates(null,query,input.type==='rank'?30:settings.maxCandidates,{classification:input.type==='classify',provider});
    if(input.type!=='research'&&!candidateIds.length)throw fail('No catalogue candidates available for this job');
    const counts=db.jobCounts();if(counts.queued+counts.running>=MAX_QUEUE)throw fail('Intelligence queue is full',429);
    if(usageToday().jobs>=settings.maxJobsPerDay)throw fail('Daily intelligence job limit reached; adjust the cap or wait for the next UTC day',429);
    const job={id:randomUUID(),type:input.type,status:'queued',provider,query,planId:plan?.id||null,planSnapshot:plan?structuredClone(plan):null,trigger,createdAt:now(),startedAt:null,finishedAt:null,stage:'queued',candidateIds,selectionMode,...(selectionMode!=='explicit'?{initialCandidateIds:[...candidateIds]}:{}),...(selection.scopeIds?{selectionScopeIds:[...selection.scopeIds]}:{}),runIds:[],errors:[],usage:[],result:{},settingsSnapshot:getSettings()};
    const saved=saveJob(job);pump();return saved;
  }
  return {
    getSettings,
    updateSettings(patch){
      if(!patch||typeof patch!=='object'||Array.isArray(patch))throw fail('Intelligence settings must be an object');
      for(const key of Object.keys(patch))if(!(key in DEFAULT_INTELLIGENCE_SETTINGS))throw fail(`Unknown intelligence setting: ${key}`);
      const next={...settings,...patch};if(!['codex','jev'].includes(next.provider))throw fail('provider must be codex or jev');
      for(const key of ['autoClassify','autoResearch'])if(typeof next[key]!=='boolean')throw fail(`${key} must be boolean`);
      for(const [key,min,max] of [['maxCandidates',1,30],['maxJobsPerDay',1,5000],['timeoutSeconds',1,600],['jevConcurrency',1,4]])if(!Number.isInteger(next[key])||next[key]<min||next[key]>max)throw fail(`${key} must be an integer between ${min} and ${max}`);
      for(const [key,max] of [['jevDailyBudgetUsd',100],['confidenceThreshold',1]])if(!Number.isFinite(next[key])||next[key]<0||next[key]>max)throw fail(`${key} must be between 0 and ${max}`);
      settings=next;db.save('settings',{id:'current',value:settings});return getSettings();
    },
    async status(){return {settings:getSettings(),providers:await providerState(),runningJobId:running?.job.id||null,counts:db.jobCounts(),usageToday:usageToday(),limits:{maxQueue:MAX_QUEUE,concurrency:1,jevRequestConcurrency:settings.jevConcurrency,jevMaximumCallReservationUsd:JEV_MAX_CALL_USD}};},
    listJobs({limit=50,offset=0}={}){if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw fail('Invalid job pagination');return db.listJobs({limit,offset});},
    getJob:id=>db.get('jobs',id),enqueue,
    cancel(id){const job=db.get('jobs',id);if(!job)return null;if(['queued','running'].includes(job.status)){job.status='cancelled';job.stage='cancelled';job.finishedAt=now();job.errors.push('Cancelled by user');saveJob(job);if(running?.job.id===id){running.job.errors.push('Cancelled by user');running.controller.abort(new Error('Cancelled by user'));}}return db.get('jobs',id);},
    afterDiscovery(run){
      if(!run||run.trigger==='intelligence')return null;
      if(run.planId&&!store.getResearchPlan(run.planId)?.enabled)return null;
      const associate=job=>saveJob({...job,runIds:run.id?[run.id]:[]});
      if(settings.autoResearch&&run.trigger==='scheduled'&&run.planId)return associate(enqueue({type:'research',planId:run.planId,trigger:'scheduled'}));
      if(!settings.autoClassify||!run.candidateIds?.length)return null;
      const ids=selectCandidates(run.candidateIds,run.query||'',settings.maxCandidates,{classification:true,pendingOnly:true});
      if(!ids.length)return null;
      return associate(enqueue({type:'classify',query:run.query||'',candidateIds:ids,trigger:'scheduled'},{mode:'discovery',scopeIds:run.candidateIds}));
    },
    decorate,getAssessment:id=>assessment(id),
    correctAssessment(id,patch){if(!store.getCapability(id))throw fail('Capability not found',404);const fields=validateAssessment(patch,null,{partial:true}),previous=db.get('corrections',id);db.save('corrections',{id,patch:{...(previous?.patch||{}),...fields},createdAt:previous?.createdAt||now(),updatedAt:now()});return assessment(id);},
    submitAssessment(id,input){const card=cardFor(id);if(!card)throw fail('Public capability not found',404);return persistAssessment(card,input,{provider:'agent',model:'calling-agent'});},
    async close(){closed=true;if(running)running.controller.abort(new Error('Intelligence engine is closing'));if(pumpPromise)await pumpPromise;db.close();}
  };
}
