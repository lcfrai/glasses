import {randomUUID} from 'node:crypto';
import {validatePublicURL} from './discovery.mjs';
import {BULK_DEFAULT_LANES,BULK_RESOURCE_TYPES,createBulkSourceAdapters,validateBulkSource} from './bulk-sources.mjs';

export {BULK_DEFAULT_LANES,BULK_RESOURCE_TYPES};
const INDEX='bulkDiscoveryPlans',LOCK='bulkDiscoveryLease',key=id=>'bulkDiscoveryPlan:'+id,cancelKey=id=>'bulkDiscoveryCancel:'+id;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const clone=value=>JSON.parse(JSON.stringify(value));
const integer=(value,fallback,min,max,name)=>{const result=value??fallback;if(!Number.isInteger(result)||result<min||result>max)throw fail(`${name} must be an integer between ${min} and ${max}`);return result;};
const safeError=error=>String(error?.message||error).replace(/Bearer\s+\S+|\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/gi,'[redacted]').slice(0,600);
function urlKey(value){const url=validatePublicURL(value);url.hash='';if(url.hostname==='github.com'){const parts=url.pathname.split('/');if(parts.length>=3){parts[1]=parts[1].toLowerCase();parts[2]=parts[2].toLowerCase();url.pathname=parts.join('/');}}return url.href.replace(/\/$/,'');}
function candidateValue(candidate,lane){
  if(!candidate||typeof candidate!=='object'||typeof candidate.url!=='string'||typeof candidate.sourceKind!=='string'||candidate.sourceKind.length>80)throw fail('Source adapter returned an invalid candidate',502);
  const result=clone(candidate);result.url=validatePublicURL(result.url).href;
  if(result.requestedResourceType!==lane||!result.provenance||!Array.isArray(result.provenance.evidence)||!result.provenance.evidence.length||result.provenance.evidence.length>8)throw fail('Candidate lacks lane and retained source provenance',502);
  for(const reference of result.provenance.evidence)if(!/^[a-f0-9]{20}$/.test(reference.id||'')||!/^[a-f0-9]{64}$/.test(reference.sha256||''))throw fail('Candidate evidence reference is invalid',502);
  if(Buffer.byteLength(JSON.stringify(result))>20000||Object.hasOwn(result,'body')||Object.hasOwn(result,'content'))throw fail('Source candidate exceeds its bounded metadata contract',502);
  return result;
}
export function validateBulkPlan(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['name','lanes','maxCandidates','pageSize','maxPages','refreshExisting'].includes(k)))throw fail('Invalid bulk plan fields');
  const name=input.name??'Balanced public catalogue scan';if(typeof name!=='string'||!name.trim()||name.length>100)throw fail('Bulk plan name must contain 1–100 characters');
  const raw=input.lanes??BULK_DEFAULT_LANES;if(!Array.isArray(raw)||!raw.length||raw.length>6)throw fail('Choose one to six resource lanes');
  const seen=new Set(),lanes=raw.map(lane=>{
    if(!lane||Object.keys(lane).some(k=>!['resourceType','weight','limit','sources'].includes(k))||!BULK_RESOURCE_TYPES.includes(lane.resourceType)||seen.has(lane.resourceType))throw fail('Bulk lanes must have unique supported resource types');seen.add(lane.resourceType);
    if(!Array.isArray(lane.sources)||!lane.sources.length||lane.sources.length>8)throw fail('Each lane requires one to eight public sources');
    return{resourceType:lane.resourceType,weight:integer(lane.weight,1,1,4,'Lane weight'),limit:integer(lane.limit,40,1,500,'Lane limit'),sources:lane.sources.map(validateBulkSource)};
  });
  if(input.refreshExisting!==undefined&&typeof input.refreshExisting!=='boolean')throw fail('refreshExisting must be boolean');
  return{name:name.trim(),lanes,maxCandidates:integer(input.maxCandidates,240,1,2000,'maxCandidates'),pageSize:integer(input.pageSize,20,1,30,'pageSize'),maxPages:integer(input.maxPages,60,1,150,'maxPages'),refreshExisting:input.refreshExisting??false};
}

/** A bounded durable discovery queue. It discovers/imports public evidence only;
 * classification, installation and publication remain separate existing jobs. */
export function createBulkDiscovery({store,discovery,adapters,fetcher,importCandidate,clock=()=>Date.now(),stepTimeoutMs=30000,runTimeoutMs=120000}={}){
  if(!store?.getSetting||!store?.acquireSettingLease||!discovery?.importUrl)throw fail('Bulk discovery requires a durable store and discovery importer');
  stepTimeoutMs=integer(stepTimeoutMs,30000,10,90000,'stepTimeoutMs');runTimeoutMs=integer(runTimeoutMs,120000,10,600000,'runTimeoutMs');
  const sources=adapters||createBulkSourceAdapters({store,fetcher});let active=null,closed=false;const waiters=new Set();
  const stamp=()=>new Date(clock()).toISOString();
  const read=id=>{const value=store.getSetting(key(id),null);if(!value)throw fail('Bulk plan not found',404);return value;};
  const save=plan=>{plan.updatedAt=stamp();plan.version++;store.setSetting(key(plan.id),plan);return clone(plan);};
  const summary=plan=>{const {entries,lanes,...base}=plan;return{...base,lanes:lanes.map(({sources,...lane})=>({...lane,sources:sources.map(({pending,...source})=>({...source,pendingCount:pending.length}))})),entryCount:entries.length,cancelRequested:!!store.getSetting(cancelKey(plan.id),null)};};
  const defaultImport=async(candidate,{signal})=>candidate.sourceKind==='github-guidance'?{status:'review-required',reason:'Exact source and scoped licence acquisition is required before admitting this guidance artifact.'}:{item:await discovery.importUrl(candidate.url,{signal})};
  const importer=importCandidate||defaultImport;
  function statusFor(plan){
    const anyPending=plan.lanes.some(lane=>lane.sources.some(source=>source.pending.length||!source.exhausted&&!source.failed));
    const pending=plan.lanes.some(lane=>lane.attempted<lane.limit&&lane.sources.some(source=>source.pending.length||!source.exhausted&&!source.failed));
    if(!pending)return anyPending?'bounded':plan.errors.length?'partial':'completed';
    if(plan.stats.attempted>=plan.maxCandidates)return'bounded';
    if(plan.stats.pages>=plan.maxPages&&!plan.lanes.some(lane=>lane.attempted<lane.limit&&lane.sources.some(source=>source.pending.length)))return'bounded';
    return'paused';
  }
  function next(plan){
    const rotation=plan.lanes.flatMap((lane,index)=>Array(lane.weight).fill(index));
    for(let checked=0;checked<rotation.length;checked++){
      const lane=plan.lanes[rotation[plan.rotation++%rotation.length]];if(lane.attempted>=lane.limit)continue;
      for(let tries=0;tries<lane.sources.length;tries++){
        const source=lane.sources[lane.rotation++%lane.sources.length];
        if(source.pending.length)return{lane,source,action:'import'};
        if(!source.exhausted&&!source.failed&&plan.stats.pages<plan.maxPages)return{lane,source,action:'page'};
      }
    }return null;
  }
  const api={
    get running(){return!!active;},
    createPlan(input={}){
      if(closed)throw fail('Bulk discovery is closing',409);const validated=validateBulkPlan(input),lease=randomUUID();
      if(!store.acquireSettingLease(INDEX+':lock',{id:lease,expiresAt:new Date(Date.now()+5000).toISOString()}))throw fail('Bulk plan list is being updated',409);
      try{const ids=store.getSetting(INDEX,[]);if(ids.length>=50)throw fail('At most 50 bulk plans can be retained',409);const plan={...validated,id:randomUUID(),version:1,status:'ready',reason:null,createdAt:stamp(),updatedAt:stamp(),finishedAt:null,rotation:0,stats:{pages:0,discovered:0,attempted:0,added:0,updated:0,existing:0,duplicate:0,reviewRequired:0,failed:0},entries:[],errors:[],lanes:validated.lanes.map(lane=>({...lane,attempted:0,rotation:0,sources:lane.sources.map(definition=>({definition,cursor:null,pending:[],pages:0,exhausted:false,failed:false,failures:0,evidence:[]}))})),note:'Requested lanes organize discovery; they are not verified resource classifications. Source acquisition never executes code, calls a classifier or publishes the shared catalogue.'};store.setSetting(key(plan.id),plan);store.setSetting(INDEX,[...ids,plan.id]);return summary(plan);}finally{store.releaseSettingLease(INDEX+':lock',lease);}
    },
    list(){return store.getSetting(INDEX,[]).map(id=>summary(read(id))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));},
    get(id,{offset=0,limit=50}={}){offset=integer(offset,0,0,10000,'offset');limit=integer(limit,50,1,100,'limit');const plan=read(id);return{...summary(plan),entries:plan.entries.slice(offset,offset+limit),nextOffset:offset+limit<plan.entries.length?offset+limit:null};},
    status(){return{running:!!active,activePlanId:active?.id||null,plans:api.list(),modelCalls:false,publication:false};},
    amendPlan(id,input){
      if(!input||Object.keys(input).some(k=>!['expectedVersion','maxCandidates','maxPages'].includes(k)))throw fail('Only bulk limits may be amended; source changes require a new plan');
      const plan=read(id);if(plan.status==='running'||active?.id===id)throw fail('Cancel or wait for the running batch before amending limits',409);if(input.expectedVersion!==plan.version)throw fail('Bulk plan version changed; reload before amending',409);
      for(const field of ['maxCandidates','maxPages'])if(input[field]!==undefined){const max=field==='maxPages'?150:2000;plan[field]=integer(input[field],plan[field],plan[field],max,field);}
      plan.status=statusFor(plan);plan.finishedAt=null;plan.reason=null;return summary(save(plan));
    },
    cancel(id){const plan=read(id);store.setSetting(cancelKey(id),{requestedAt:stamp()});if(active?.id===id)active.controller.abort();else if(plan.status!=='running'){plan.status='cancelled';plan.reason='cancel-requested';save(plan);}return api.get(id);},
    async close(){closed=true;active?.controller.abort();if(active)await new Promise(resolve=>waiters.add(resolve));},
    async run(id,{maxSteps=30,signal,retryFailed=false}={}){
      maxSteps=integer(maxSteps,30,1,200,'maxSteps');if(closed||active||discovery.scouting)throw fail('Discovery is running or closing',409);
      if(typeof retryFailed!=='boolean')throw fail('retryFailed must be boolean');
      let plan=read(id);if(plan.status==='completed'||plan.status==='partial'&&!retryFailed)return api.get(id);if(plan.status==='bounded'&&statusFor(plan)==='bounded')return api.get(id);
      const lease=randomUUID();if(!store.acquireSettingLease(LOCK,{id:lease,planId:id,expiresAt:new Date(Date.now()+runTimeoutMs+stepTimeoutMs+30000).toISOString()}))throw fail('Another bulk discovery worker owns the durable lease',409);
      const controller=new AbortController();active={id,controller};let cancellationTimer;
      try{
        // A prior running marker with no live lease is resumable. Its pending
        // candidate was committed before work; URL imports are idempotent.
        plan=read(id);store.setSetting(cancelKey(id),null);
        if(retryFailed){for(const lane of plan.lanes)for(const source of lane.sources){source.failed=false;source.failures=0;}for(const entry of plan.entries.filter(entry=>entry.status==='failed'&&!entry.retryQueuedAt&&entry.proposal)){const lane=plan.lanes.find(lane=>lane.resourceType===entry.lane),source=lane.sources.find(source=>JSON.stringify(source.definition)===JSON.stringify(entry.source));if(source&&!source.pending.some(candidate=>urlKey(candidate.url)===urlKey(entry.url))){source.pending.push(entry.proposal);entry.retryQueuedAt=stamp();}}}
        plan.status='running';plan.reason=null;plan.finishedAt=null;plan.lastStartedAt=stamp();save(plan);
        const known=new Map();for(const item of store.search()){try{known.set(urlKey(item.url),item);}catch{/* Legacy/local-only records are not public discovery identities. */}}
        const seen=new Set(plan.entries.filter(entry=>!entry.retryQueuedAt).map(entry=>urlKey(entry.url)));
        const deadline=Date.now()+runTimeoutMs;let steps=0;
        cancellationTimer=setInterval(()=>{if(store.getSetting(cancelKey(id),null))controller.abort();},200);cancellationTimer.unref?.();
        while(steps<maxSteps&&Date.now()<deadline&&plan.stats.attempted<plan.maxCandidates){
          if(controller.signal.aborted||signal?.aborted||closed){plan.status='cancelled';plan.reason='cancel-requested';break;}
          const selection=next(plan);if(!selection)break;const {lane,source,action}=selection;steps++;
          const operationSignal=AbortSignal.any([controller.signal,...signal?[signal]:[],AbortSignal.timeout(Math.max(1,Math.min(stepTimeoutMs,deadline-Date.now())))]);
          try{
            if(action==='page'){
              const adapter=sources[source.definition.adapter];if(typeof adapter!=='function')throw fail('Configured source adapter is unavailable',422);
              const page=await adapter({source:source.definition,lane:lane.resourceType,cursor:source.cursor,limit:plan.pageSize,signal:operationSignal,scanId:plan.id});operationSignal.throwIfAborted();
              if(!page||!Array.isArray(page.candidates)||page.candidates.length>plan.pageSize||typeof page.exhausted!=='boolean'||!page.exhausted&&!page.nextCursor||Buffer.byteLength(JSON.stringify(page.nextCursor??null))>4000)throw fail('Source adapter returned an invalid bounded page',502);
              const candidates=page.candidates.map(candidate=>candidateValue(candidate,lane.resourceType));
              for(const candidate of candidates)for(const reference of candidate.provenance.evidence){const retained=store.getEvidence(reference.id);if(!retained||retained.sha256!==reference.sha256||retained.url!==reference.url)throw fail('Candidate provenance is not retained in this local store',502);}
              source.pending=candidates;source.cursor=page.nextCursor??null;source.exhausted=page.exhausted;source.pages++;source.failures=0;source.evidence=(page.evidence||[]).slice(0,8);plan.stats.pages++;plan.stats.discovered+=candidates.length;
            }else{
              const candidate=source.pending[0],identity=urlKey(candidate.url),entry={url:candidate.url,lane:lane.resourceType,sourceKind:candidate.sourceKind,at:stamp(),provenance:candidate.provenance};
              if(seen.has(identity)){entry.status='duplicate';plan.stats.duplicate++;}
              else if(known.has(identity)&&!plan.refreshExisting){entry.status='existing';entry.candidateId=known.get(identity).id;plan.stats.existing++;}
              else{
                // Preserve attempted intent before the fallible operation. A
                // cancelled attempt stays pending and is retried on resume.
                source.inFlight={url:candidate.url,at:stamp()};save(plan);
                const result=await importer(candidate,{lane:lane.resourceType,signal:operationSignal,store,discovery});operationSignal.throwIfAborted();
                if(result?.status==='review-required'||result?.reviewRequired===true){entry.status='review-required';entry.reason=safeError(result.reason||result.error||'Source requires review');entry.proposal=candidate;plan.stats.reviewRequired++;}
                else{const item=result?.item||result;if(!item?.id||!item?.url||!store.getCapability(item.id))throw fail('Importer did not return an admitted local catalogue record',502);entry.status=typeof result.added==='boolean'?(result.added?'added':'updated'):known.has(urlKey(item.url))?'updated':'added';entry.candidateId=item.id;entry.relatedIds=Array.isArray(result.relatedIds)?result.relatedIds.filter(id=>typeof id==='string'&&store.getCapability(id)).slice(0,20):[];entry.observedResourceType=item.details?.resourceType||null;known.set(urlKey(item.url),item);plan.stats[entry.status]++;}
                source.inFlight=null;plan.stats.attempted++;lane.attempted++;
              }
              source.inFlight=null;seen.add(identity);source.pending.shift();plan.entries.push(entry);
            }
          }catch(error){
            if(controller.signal.aborted||signal?.aborted||closed){plan.status='cancelled';plan.reason='cancel-requested';save(plan);break;}
            const message=safeError(error);plan.errors.push({at:stamp(),lane:lane.resourceType,source:source.definition,action,message});plan.errors=plan.errors.slice(-100);
            if(/HTTP (?:403|429)|rate.limit/i.test(message)){plan.status='paused';plan.reason='upstream-rate-limit';save(plan);break;}
            if(action==='page'){source.failures++;if(source.failures>=2||[400,409,422].includes(error.status))source.failed=true;}
            else{const candidate=source.pending.shift();source.inFlight=null;seen.add(urlKey(candidate.url));plan.entries.push({url:candidate.url,lane:lane.resourceType,sourceKind:candidate.sourceKind,source:source.definition,proposal:candidate,at:stamp(),status:'failed',error:message,provenance:candidate.provenance});plan.stats.failed++;plan.stats.attempted++;lane.attempted++;}
          }
          save(plan);
        }
        if(plan.status==='running'){plan.status=statusFor(plan);plan.reason=plan.status==='bounded'?'configured-cap':plan.status==='paused'?'batch-limit':null;}
        if(['completed','partial','bounded'].includes(plan.status))plan.finishedAt=stamp();save(plan);return api.get(id);
      }catch(error){
        // Re-read the last committed checkpoint: a failed write must not cause
        // an uncommitted cursor/import result to be reported as durable success.
        try{const committed=read(id);committed.status='paused';committed.reason='run-error';committed.errors.push({at:stamp(),action:'run',message:safeError(error)});committed.errors=committed.errors.slice(-100);save(committed);}catch{/* Preserve the original error if storage itself is unavailable. */}
        throw error;
      }finally{clearInterval(cancellationTimer);try{store.releaseSettingLease(LOCK,lease);}finally{active=null;for(const resolve of waiters)resolve();waiters.clear();}}
    }
  };return api;
}
