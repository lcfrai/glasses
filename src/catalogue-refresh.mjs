import {randomUUID} from 'node:crypto';

export const REFRESH_DEFAULTS=Object.freeze({enabled:true,minAgeHours:72,batchSize:10});
const invalid=message=>Object.assign(new Error(message),{status:400});
export function validateRefreshSettings(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('Refresh settings must be an object');
  for(const key of Object.keys(input))if(!Object.hasOwn(REFRESH_DEFAULTS,key))throw invalid('Unknown refresh setting: '+key);
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw invalid('enabled must be boolean');
  if(input.minAgeHours!==undefined&&(!Number.isInteger(input.minAgeHours)||input.minAgeHours<24||input.minAgeHours>2160))throw invalid('minAgeHours must be between24 and2160');
  if(input.batchSize!==undefined&&(!Number.isInteger(input.batchSize)||input.batchSize<1||input.batchSize>30))throw invalid('batchSize must be between1 and30');
  return input;
}
const github=item=>item.origin==='live'&&/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/?$/.test(item.url);
const checked=item=>Math.max(0,...[item.refreshState?.checkedAt,item.metadataEvidence?.lastFetchedAt,item.sourceState?.checkedAt,item.provenance?.repositoryFetchedAt].map(value=>Date.parse(value)||0));
export function createCatalogueRefresh({store,discovery,clock=()=>Date.now()}){
  let active=false,closed=false;const idleWaiters=new Set();
  const settings=()=>({...REFRESH_DEFAULTS,...store.getSetting('catalogueRefresh',{})});
  function pending(){const config=settings(),cutoff=clock()-config.minAgeHours*3600000;return store.search().filter(github).map(item=>store.getCapability(item.id)).filter(item=>checked(item)<=cutoff).sort((a,b)=>checked(a)-checked(b)||(b.github?.stars||0)-(a.github?.stars||0)||a.id.localeCompare(b.id));}
  const api={
    get running(){return active;},
    async close(){closed=true;if(active)await new Promise(resolve=>idleWaiters.add(resolve));},
    status(){return{settings:settings(),running:active,due:pending().length,lastRun:store.getSetting('catalogueRefreshLastRun',null),note:'Oldest due public GitHub repositories refresh in bounded batches while the local discovery schedule runs. Registry metadata is renewed by normal scouts. Source inspection does not install code. Shared publication is a separate reviewed export.'};},
    configure(input){const value={...settings(),...validateRefreshSettings(input)};store.setSetting('catalogueRefresh',value);return api.status();},
    async run({ids,trigger='manual'}={}){
      if(closed||active||discovery.scouting)throw Object.assign(new Error('Discovery or catalogue refresh is already running or closing'),{status:409});
      if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>30||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!github(store.getCapability(id)||{}))))throw invalid('Supply at most30 distinct existing public GitHub catalogue IDs');
      const config=settings();if(trigger==='scheduled'&&!config.enabled)return null;
      const selected=ids||pending().slice(0,config.batchSize).map(item=>item.id);if(!selected.length)return null;
      active=true;
      const stamp=()=>new Date(clock()).toISOString(),run={id:randomUUID(),status:'running',researchMode:'refresh',trigger,query:'Refresh existing source metadata and purpose evidence',startedAt:stamp(),finishedAt:null,candidateIds:selected,addedCandidateIds:[],updatedCandidateIds:[],added:0,updated:0,errors:[],entries:[],resultNote:'Metadata, star counts and pinned source evidence refreshed in place. Changed evidence is eligible for classification under the configured provider and budget. No code installation or public publication.'};
      try{
        store.saveRun(run);
        for(const id of selected){
          if(closed){run.errors.push('Refresh interrupted by service shutdown; remaining IDs are still due.');break;}
          const before=store.getCapability(id),start=stamp();
          try{
            const item=await discovery.inspect(id,{refreshSource:true});
            const failed=item.sourceState?.status==='error'||item.sourceState?.status==='removed';
            const state={checkedAt:stamp(),status:failed?'failed':item.sourceState?.status==='partial'?'partial':'refreshed',metadataHash:item.metadataEvidence?.sha256||null,resolvedRevision:item.provenance?.resolvedRevision||null};
            store.upsertCapability({...item,refreshState:state});
            const entry={id,url:item.url,startedAt:start,...state,previousStars:before.github?.stars??null,stars:item.github?.stars??null,metadataChanged:before.metadataEvidence?.sha256!==item.metadataEvidence?.sha256,sourceChanged:before.provenance?.resolvedRevision!==item.provenance?.resolvedRevision,errors:item.sourceError?[item.sourceError]:[]};
            run.entries.push(entry);if(failed||state.status==='partial')run.errors.push(item.name+': '+(item.sourceError||'Source refresh incomplete'));if(!failed){run.updatedCandidateIds.push(id);run.updated++;}
          }catch(error){
            const message=String(error.message).slice(0,600);store.upsertCapability({...store.getCapability(id),refreshState:{checkedAt:stamp(),status:'failed'}});run.entries.push({id,url:before.url,startedAt:start,status:'failed',errors:[message]});run.errors.push(before.name+': '+message);
          }
          store.saveRun(run);
          if(run.errors.some(message=>/HTTP (?:403|429)|rate.limit/i.test(message))){run.errors.push('Refresh stopped after upstream throttling; remaining IDs are still due.');break;}
        }
        run.status=run.errors.length?'partial':'completed';run.finishedAt=stamp();store.saveRun(run);store.setSetting('catalogueRefreshLastRun',{id:run.id,status:run.status,finishedAt:run.finishedAt,requested:selected.length,processed:run.entries.length,updated:run.updated,errors:run.errors});return run;
      }finally{active=false;for(const resolve of idleWaiters)resolve();idleWaiters.clear();}
    }
  };return api;
}
