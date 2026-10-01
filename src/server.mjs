import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore, KINDS, RESOURCE_TYPES, resourceTypeOf } from './store.mjs';
import { seedStore } from './seed.mjs';
import { createDiscovery } from './discovery.mjs';
import { compilePreview } from './preview.mjs';
import { createAdoptionBrief } from './adoption.mjs';
import { createResearch } from './research.mjs';
import { createCatalogueRefresh } from './catalogue-refresh.mjs';
import { createBulkDiscovery, BULK_DEFAULT_LANES } from './bulk-discovery.mjs';
import { createBulkImporter } from './bulk-import.mjs';
import { createPublicSourceFetcher } from './public-source-fetcher.mjs';
import { createProviders } from './providers.mjs';
import { createIntelligence } from './intelligence.mjs';
import { createOnboarding } from './onboarding.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function stringField(value,name,max,optional=true) {
  if(value===undefined&&optional)return;
  if(typeof value!=='string'||value.length>max)throw fail(`${name} must be a string of at most ${max} characters`);
}
function workspaceInput(body,create=false) {
  stringField(body.title,'title',200);stringField(body.source,'source',150000);stringField(body.css,'css',50000);
  stringField(body.entryPath,'entryPath',240);
  if(body.editor!==undefined&&typeof body.editor!=='boolean')throw fail('editor must be boolean');
  if(body.expectedVersion!==undefined&&(!Number.isInteger(body.expectedVersion)||body.expectedVersion<1))throw fail('expectedVersion must be a positive integer');
  if(body.files!==undefined) {
    if(!Array.isArray(body.files)||body.files.length>40)throw fail('files must be an array of at most 40 source files');
    let total=0;
    for(const file of body.files){if(!file||typeof file!=='object')throw fail('Each file requires path and content');stringField(file.path,'file.path',240,false);stringField(file.content,'file.content',150000,false);total+=file.content.length;}
    if(total>350000)throw fail('Source files exceed 350000 characters');
  }
  if(body.visualEdits!==undefined&&(body.visualEdits===null||Array.isArray(body.visualEdits)||typeof body.visualEdits!=='object'||JSON.stringify(body.visualEdits).length>30000))throw fail('visualEdits must be an object of at most 30000 characters');
  if(create&&body.capabilityId!=null)stringField(body.capabilityId,'capabilityId',100,false);
  if(body.props!==undefined&&(body.props===null||Array.isArray(body.props)||typeof body.props!=='object'||JSON.stringify(body.props).length>24000))throw fail('props must be an object of at most 24000 characters');
}
async function bodyJSON(req) {
  const contentType=req.headers['content-type']||'';
  if(!contentType.startsWith('application/json'))throw fail('Content-Type must be application/json',415);
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>500000)throw fail('Request body exceeds 500000 bytes',413);chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail('Invalid JSON');}
  if(body===null||typeof body!=='object'||Array.isArray(body))throw fail('JSON body must be an object');return body;
}
export async function startServer({port=Number(process.env.GLASSES_PORT||4317),dataDir=process.env.GLASSES_DATA_DIR||resolve(root,'.glasses'),autoScout=process.env.GLASSES_SCOUT_ENABLED!=='false',discoveryFetcher,providers:injectedProviders,seed=true,publicDir=resolve(root,'public'),catalogueFetcher}={}) {
  const store=createStore(dataDir);if(seed)seedStore(store);store.recoverInterruptedRuns();
  const discovery=createDiscovery({store,...(discoveryFetcher?{fetcher:discoveryFetcher}:{})});
  const research=createResearch({store,discovery});
  const refresh=createCatalogueRefresh({store,discovery});
  const bulkFetcher=discoveryFetcher||createPublicSourceFetcher();
  const bulk=createBulkDiscovery({store,discovery,fetcher:bulkFetcher,importCandidate:createBulkImporter({store,discovery,fetcher:bulkFetcher})});
  const providers=injectedProviders||createProviders({dataDir:store.directory});
  const intelligence=createIntelligence({store,discovery,providers,dataDir:store.directory});
  const onboarding=createOnboarding({store,...(catalogueFetcher?{fetchImpl:catalogueFetcher}:{})});
  let connectionTest=null;
  const intelligenceStatus=async()=>{const state=await intelligence.status();return {...state,connections:state.providers||await providers.status(),jobs:intelligence.listJobs().items,usage:state.usageToday};};
  const queueAfterDiscovery=run=>{if(closed||!run)return null;try{return intelligence.afterDiscovery(run);}catch(error){run.processingError=error.message;store.saveRun(run);return null;}};
  const token=randomBytes(32).toString('hex'), previewNonce=randomBytes(20).toString('base64');let timer=null,closed=false,backoff=1;
  let schedule=store.getSetting('schedule',{enabled:autoScout,intervalMinutes:360});
  if(!autoScout)schedule={...schedule,enabled:false};
  const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  const scheduleNext=(delay)=>{
    if(timer)clearTimeout(timer);timer=null;
    if(closed||!schedule.enabled)return;
    timer=setTimeout(async()=>{
      if(discovery.scouting||refresh.running||bulk.running){scheduleNext(60000);return;}
      try{const run=await research.runScheduled();queueAfterDiscovery(run);if(!closed)queueAfterDiscovery(await refresh.run({trigger:'scheduled'}));backoff=run.status==='failed'?Math.min(backoff*2,4):1;}catch{backoff=Math.min(backoff*2,4);}
      scheduleNext();
    },delay??Math.min(schedule.intervalMinutes*60000*backoff,86400000));timer.unref();
  };
  const server=http.createServer(async(req,res)=>{
    try {
      const address=server.address();const currentPort=typeof address==='object'?address.port:port;
      const host=req.headers.host||'';
      if(![`127.0.0.1:${currentPort}`,`localhost:${currentPort}`,`[::1]:${currentPort}`].includes(host))throw fail('Only this loopback Host is accepted',403);
      const origin=req.headers.origin;
      if(origin&&origin!==`http://${host}`)throw fail('Foreign origins are blocked',403);
      if(req.headers['sec-fetch-site']==='cross-site')throw fail('Cross-site requests are blocked',403);
      const url=new URL(req.url,`http://${host}`);const path=url.pathname;
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
      if(path==='/api/session'&&req.method==='GET'){send(res,200,{token});return;}
      if(path.startsWith('/api/')) {
        const supplied=String(req.headers['x-glasses-token']||'');
        if(supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))throw fail('Missing or invalid X-Glasses-Token; obtain /api/session on loopback',401);
        if(path==='/api/catalog'&&req.method==='GET') {
          const limitParam=url.searchParams.get('limit'),offsetParam=url.searchParams.get('offset');
          const paged=limitParam!==null||offsetParam!==null,limit=limitParam===null?50:Number(limitParam);let offset=offsetParam===null?0:Number(offsetParam);
          if(paged&&(!/^\d+$/.test(limitParam??'50')||!/^\d+$/.test(offsetParam??'0')||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>100000))throw fail('limit must be 1–100 and offset must be 0–100000');
          const originFilter=url.searchParams.get('origin')||'all',revealId=url.searchParams.get('revealId');
          if(!['all','live','seed','sample','shared'].includes(originFilter))throw fail('Unsupported catalogue origin');
          if(revealId!==null&&!/^[a-f0-9]{20}$/.test(revealId))throw fail('Invalid reveal candidate identity');
          const hasPreview=url.searchParams.get('hasPreview');if(hasPreview!==null&&!['true','false'].includes(hasPreview))throw fail('hasPreview must be true or false');
          const kind=url.searchParams.get('kind')||'all';if(kind!=='all'&&!KINDS.includes(kind))throw fail('Unknown capability kind');
          const query=(url.searchParams.get('q')||'').slice(0,500),runId=url.searchParams.get('runId'),parentId=url.searchParams.get('parentId');const resourceType=url.searchParams.get('resourceType')||'all';if(resourceType!=='all'&&!RESOURCE_TYPES.includes(resourceType))throw fail('Unsupported resourceType');if(parentId&&!store.getCapability(parentId))throw fail('Collection parent not found',404);
          const run=runId?store.getRun(runId):null;if(runId&&!run)throw fail('Research run not found',404);
          const ids=runId?new Set(run.candidateIds||[]):null;
          const jobId=url.searchParams.get('jobId'),job=jobId?intelligence.getJob(jobId):null;if(jobId&&!job)throw fail('Processing job not found',404);
          const jobIds=job?new Set(job.candidateIds||[]):null;
          const assessmentStatus=url.searchParams.get('assessmentStatus')||'all';
          if(!['all','unclassified','classified','needs-review','stale','corrected'].includes(assessmentStatus))throw fail('Unknown assessment status');
          const items=intelligence.decorate(store.search({kind,openSourceOnly:url.searchParams.get('openSourceOnly')==='true'}),{query,artifact:url.searchParams.get('artifact')||'all'}).filter(item=>(hasPreview!=='true'||!!item.details?.preview)&&(originFilter==='all'||item.origin===originFilter)&&(resourceType==='all'||resourceTypeOf(item)===resourceType)&&(!parentId||item.details?.parent?.id===parentId)&&(!ids||ids.has(item.id))&&(!jobIds||jobIds.has(item.id))&&(assessmentStatus==='all'||item.assessment?.status===assessmentStatus));
          if(job?.type==='rank'&&job.result?.rankings){const scores=new Map(job.result.rankings.map(row=>[row.id,row.score]));items.sort((a,b)=>(scores.get(b.id)??-1)-(scores.get(a.id)??-1)||a.name.localeCompare(b.name));}
          if(paged&&revealId){const index=items.findIndex(row=>row.id===revealId);if(index>=0)offset=Math.floor(index/limit)*limit;}
          // Paged consumers already know the filter identity. Do not retransmit a
          // whole scan's membership or model rankings with every bounded page.
          const runInfo=paged&&run?{id:run.id,status:run.status,candidateCount:run.candidateIds?.length||0}:run;
          const jobInfo=paged&&job?{id:job.id,type:job.type,status:job.status,candidateCount:job.candidateIds?.length||0}:job;
          send(res,200,{items:paged?items.slice(offset,offset+limit):items,total:items.length,...(paged?{offset,limit,nextOffset:offset+limit<items.length?offset+limit:null}:{}),...(runInfo?{run:runInfo}:{}),...(jobInfo?{job:jobInfo}:{})});return;
        }
        if(path==='/api/onboarding'&&req.method==='GET'){send(res,200,{onboarding:onboarding.status()});return;}
        if(path==='/api/intelligence'&&req.method==='GET'){send(res,200,await intelligenceStatus());return;}
        if(path==='/api/intelligence/jobs'&&req.method==='GET'){const limit=Number(url.searchParams.get('limit')||50),offset=Number(url.searchParams.get('offset')||0);if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw fail('Invalid job pagination');send(res,200,intelligence.listJobs({limit,offset}));return;}
        const jobMatch=path.match(/^\/api\/intelligence\/jobs\/([a-zA-Z0-9-]+)(\/cancel)?$/);
        if(jobMatch&&!jobMatch[2]&&req.method==='GET'){const job=intelligence.getJob(jobMatch[1]);if(!job)throw fail('Processing job not found',404);send(res,200,{job});return;}
        const assessmentMatch=path.match(/^\/api\/catalog\/([a-zA-Z0-9-]+)\/assessment$/);
        if(assessmentMatch&&req.method==='GET'){if(!store.getCapability(assessmentMatch[1]))throw fail('Capability not found',404);send(res,200,{assessment:intelligence.getAssessment(assessmentMatch[1])});return;}
        if(path==='/api/connections/jev'&&req.method==='DELETE'){if(connectionTest)throw fail('Wait for the current connection test to finish',409);await providers.removeJevKey();send(res,200,{connections:await providers.status({force:true})});return;}
        const capabilityMatch=path.match(/^\/api\/catalog\/([a-zA-Z0-9-]+)$/);
        if(capabilityMatch&&req.method==='GET') {const item=await discovery.inspect(capabilityMatch[1],{fetchSource:url.searchParams.get('fetchSource')==='true',refreshSource:url.searchParams.get('refreshSource')==='true'});if(!item)throw fail('Capability not found',404);send(res,200,{item:{...item,assessment:intelligence.getAssessment(item.id)},...(item.details?.memberCount?{collection:{parentId:item.id,publishedMembers:item.details.memberCount,browse:{tool:'glasses_search',arguments:{query:'',parentId:item.id,limit:20,offset:0}},note:'Published membership may differ from current local records; search returns the current local total.'}}:{})});return;}
        const evidenceMatch=path.match(/^\/api\/evidence\/([a-zA-Z0-9-]+)$/);
        if(evidenceMatch&&req.method==='GET'){const evidence=store.getEvidence(evidenceMatch[1]);if(!evidence)throw fail('Evidence not found',404);send(res,200,{evidence});return;}
        if(path==='/api/status'&&req.method==='GET'){const runs=store.runs();send(res,200,{counts:store.counts(),sources:store.sources(),lastRun:runs[0]||null,runs,scouting:discovery.scouting,schedule:{...schedule,note:'Runs only while the local Glasses server is running; no operating-system scheduler is installed.'}});return;}
        if(path==='/api/research/plans'&&req.method==='GET'){send(res,200,{items:store.researchPlans()});return;}
        if(path==='/api/catalogue-refresh'&&req.method==='GET'){send(res,200,refresh.status());return;}
        if(path==='/api/bulk-scans'&&req.method==='GET'){send(res,200,{...bulk.status(),defaults:BULK_DEFAULT_LANES});return;}
        const bulkMatch=path.match(/^\/api\/bulk-scans\/([a-zA-Z0-9-]+)(\/(?:run|cancel))?$/);
        if(bulkMatch&&!bulkMatch[2]&&req.method==='GET'){send(res,200,{plan:bulk.get(bulkMatch[1],{offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||50)})});return;}
        const researchPlanMatch=path.match(/^\/api\/research\/plans\/([a-zA-Z0-9-]+)(\/run)?$/);
        if(researchPlanMatch&&!researchPlanMatch[2]&&req.method==='GET'){const plan=store.getResearchPlan(researchPlanMatch[1]);if(!plan)throw fail('Research plan not found',404);send(res,200,{plan});return;}
        if(path==='/api/research/runs'&&req.method==='GET'){
          const planId=url.searchParams.get('planId')||undefined;
          if(planId&&!store.getResearchPlan(planId))throw fail('Research plan not found',404);
          const limit=Number(url.searchParams.get('limit')??50),offset=Number(url.searchParams.get('offset')??0);
          if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000)throw fail('limit must be 1–100 and offset must be 0–1000000');
          send(res,200,{items:store.runs({planId,limit,offset}),total:store.runCount({planId})});return;
        }
        const researchRunMatch=path.match(/^\/api\/research\/runs\/([a-zA-Z0-9-]+)$/);
        if(researchRunMatch&&req.method==='GET'){const run=store.getRun(researchRunMatch[1]);if(!run)throw fail('Research run not found',404);send(res,200,{run});return;}
        if(path==='/api/workspaces'&&req.method==='GET'){send(res,200,{items:store.workspaces()});return;}
        if(path==='/api/design-reviews'&&req.method==='GET'){send(res,200,{items:store.designReviews()});return;}
        const designReviewMatch=path.match(/^\/api\/design-reviews\/([a-zA-Z0-9-]+)(\/decision)?$/);
        if(designReviewMatch&&!designReviewMatch[2]&&req.method==='GET'){
          const review=store.getDesignReview(designReviewMatch[1]);if(!review)throw fail('Design review not found',404);
          send(res,200,{review});return;
        }
        const workspaceMatch=path.match(/^\/api\/workspaces\/([a-zA-Z0-9-]+)(\/export)?$/);
        if(workspaceMatch&&req.method==='GET') {
          const workspace=store.getWorkspace(workspaceMatch[1]);if(!workspace)throw fail('Workspace not found',404);
          if(!workspaceMatch[2]){send(res,200,workspace);return;}
          const data=store.exportWorkspace(workspace.id);
          const preview=await compilePreview(workspace);
          data.files.push({path:data.manifest.compiledCssPath||'compiled.css',content:preview.compiledCss});
          data.manifest.compiledPreviewHash=preview.hash;
          const provenanceFile=data.files.find(file=>file.path===(data.manifest.provenancePath||'provenance.json'));
          if(provenanceFile)provenanceFile.content=JSON.stringify(data.manifest,null,2);
          send(res,200,data);return;
        }
        if(['POST','PUT'].includes(req.method)) {
          const body=await bodyJSON(req);
          if(path==='/api/bulk-scans'&&req.method==='POST'){send(res,201,{plan:bulk.createPlan(body)});return;}
          if(bulkMatch&&!bulkMatch[2]&&req.method==='PUT'){send(res,200,{plan:bulk.amendPlan(bulkMatch[1],body)});return;}
          if(bulkMatch&&bulkMatch[2]==='/cancel'&&req.method==='POST'){if(Object.keys(body).length)throw fail('Cancel takes an empty body');send(res,200,{plan:bulk.cancel(bulkMatch[1])});return;}
          if(bulkMatch&&bulkMatch[2]==='/run'&&req.method==='POST'){
            if(Object.keys(body).some(key=>!['maxSteps','retryFailed'].includes(key)))throw fail('Run accepts maxSteps and retryFailed');
            if(body.maxSteps!==undefined&&(!Number.isInteger(body.maxSteps)||body.maxSteps<1||body.maxSteps>200))throw fail('maxSteps must be 1–200');
            if(body.retryFailed!==undefined&&typeof body.retryFailed!=='boolean')throw fail('retryFailed must be boolean');
            if(refresh.running||discovery.scouting||bulk.running)throw fail('Another discovery batch is running; retry when it finishes',409);
            bulk.get(bulkMatch[1]);const pending=bulk.run(bulkMatch[1],body);await Promise.race([pending,new Promise(resolve=>setImmediate(resolve))]);pending.catch(error=>{console.error('Bulk batch ended with an error:',error.message);});
            send(res,202,{plan:bulk.get(bulkMatch[1]),note:'Bounded acquisition started. Poll this plan; classification is a separate explicit job.'});return;
          }
          if(path==='/api/catalogue-refresh'&&req.method==='PUT'){send(res,200,refresh.configure(body));return;}
          if(path==='/api/catalogue-refresh'&&req.method==='POST'){if(bulk.running)throw fail('Bulk discovery is running',409);if(Object.keys(body).some(key=>key!=='ids'))throw fail('Refresh accepts only optional ids');const run=await refresh.run({ids:body.ids});queueAfterDiscovery(run);send(res,200,{run,...refresh.status()});return;}
          if(path==='/api/design-reviews'&&req.method==='POST'){send(res,201,{review:store.createDesignReview(body)});return;}
          if(designReviewMatch&&((!designReviewMatch[2]&&req.method==='PUT')||(designReviewMatch[2]&&req.method==='POST'))){
            const review=designReviewMatch[2]?store.decideDesignReview(designReviewMatch[1],body):store.updateDesignReview(designReviewMatch[1],body);
            if(!review)throw fail('Design review not found',404);send(res,200,{review});return;
          }
          if(path==='/api/onboarding'&&req.method==='POST'){send(res,200,{onboarding:await onboarding.choose(body)});return;}
          if(path==='/api/onboarding/import'&&req.method==='POST'){send(res,200,{onboarding:await onboarding.importLatest(body)});return;}
          if(path==='/api/intelligence/settings'&&req.method==='PUT'){send(res,200,{settings:intelligence.updateSettings(body)});return;}
          if(path==='/api/intelligence/jobs'&&req.method==='POST'){send(res,202,{job:intelligence.enqueue(body)});return;}
          if(jobMatch&&jobMatch[2]&&req.method==='POST'){if(Object.keys(body).length)throw fail('Cancel takes an empty body');const job=intelligence.cancel(jobMatch[1]);if(!job)throw fail('Processing job not found',404);send(res,200,{job});return;}
          if(assessmentMatch&&req.method==='PUT'){send(res,200,{assessment:intelligence.correctAssessment(assessmentMatch[1],body)});return;}
          if(assessmentMatch&&req.method==='POST'){send(res,200,{assessment:intelligence.submitAssessment(assessmentMatch[1],body)});return;}
          if(path==='/api/connections/jev'&&req.method==='POST'){if(Object.keys(body).some(key=>key!=='apiKey'))throw fail('Only apiKey is accepted');stringField(body.apiKey,'apiKey',4096,false);if(connectionTest)throw fail('Wait for the current connection test to finish',409);await providers.saveJevKey(body.apiKey);send(res,200,{connections:await providers.status({force:true})});return;}
          if(path==='/api/connections/codex/refresh'&&req.method==='POST'){if(Object.keys(body).length)throw fail('Refresh takes an empty body');send(res,200,{connections:await providers.status({force:true})});return;}
          const testMatch=path.match(/^\/api\/connections\/(jev|codex)\/test$/);
          if(testMatch&&req.method==='POST'){
            if(Object.keys(body).length)throw fail('Connection test takes an empty body');
            if(connectionTest)throw fail('A connection test is already running',409);
            connectionTest=new AbortController();
            try{send(res,200,{result:await providers.test(testMatch[1],{signal:connectionTest.signal,timeoutMs:60000})});}finally{connectionTest=null;}return;
          }
          if(path==='/api/scout'&&req.method==='POST'){if(refresh.running)throw fail('Catalogue refresh is running; retry after it finishes',409);if(bulk.running)throw fail('Bulk discovery is running; retry after it finishes',409);stringField(body.query,'query',200);const run=await discovery.scout({query:body.query});queueAfterDiscovery(run);scheduleNext();send(res,200,run);return;}
          if(path==='/api/research/plans'&&req.method==='POST'){send(res,201,{plan:store.createResearchPlan(body)});return;}
          if(researchPlanMatch&&!researchPlanMatch[2]&&req.method==='PUT'){const plan=store.updateResearchPlan(researchPlanMatch[1],body);if(!plan)throw fail('Research plan not found',404);send(res,200,{plan});return;}
          if(researchPlanMatch&&researchPlanMatch[2]&&req.method==='POST'){if(refresh.running)throw fail('Catalogue refresh is running; retry after it finishes',409);if(bulk.running)throw fail('Bulk discovery is running; retry after it finishes',409);if(Object.keys(body).length)throw fail('Run uses the saved plan; request body must be empty');const run=await research.runPlan(researchPlanMatch[1]);queueAfterDiscovery(run);scheduleNext();send(res,200,run);return;}
          if(path==='/api/import'&&req.method==='POST'){stringField(body.url,'url',4000,false);const item=await discovery.importUrl(body.url);send(res,200,{item});return;}
          if(path==='/api/settings'&&req.method==='POST') {
            if(typeof body.scoutEnabled!=='boolean'||!Number.isInteger(body.intervalMinutes)||body.intervalMinutes<5||body.intervalMinutes>10080)throw fail('scoutEnabled must be boolean; intervalMinutes must be an integer between 5 and 10080');
            schedule=store.setSetting('schedule',{enabled:body.scoutEnabled,intervalMinutes:body.intervalMinutes});backoff=1;scheduleNext();send(res,200,schedule);return;
          }
          if(path==='/api/outcomes'&&req.method==='POST'){stringField(body.capabilityId,'capabilityId',100,false);stringField(body.notes,'notes',4000);if(body.context!==undefined){if(!body.context||typeof body.context!=='object'||Array.isArray(body.context))throw fail('context must be an object');for(const [key,value] of Object.entries(body.context))stringField(value,`context.${key}`,1000,false);}send(res,200,{outcome:store.recordOutcome(body)});return;}
          if(path==='/api/adoption'&&req.method==='POST') {
            stringField(body.capabilityId,'capabilityId',100,false);
            if(body.requirements!==undefined&&(body.requirements===null||typeof body.requirements!=='object'||Array.isArray(body.requirements)))throw fail('requirements must be an object');
            const item=store.getCapability(body.capabilityId);if(!item)throw fail('Capability not found',404);
            send(res,200,{brief:createAdoptionBrief({...item,outcomes:store.outcomes(item.id)},body.requirements||{})});return;
          }
          if(path==='/api/workspaces'&&req.method==='POST'){workspaceInput(body,true);send(res,201,store.createWorkspace(body));return;}
          if(workspaceMatch&&!workspaceMatch[2]&&req.method==='PUT'){workspaceInput(body);const item=store.updateWorkspace(workspaceMatch[1],body);if(!item)throw fail('Workspace not found',404);send(res,200,item);return;}
          if(path==='/api/preview'&&req.method==='POST'){workspaceInput(body);if(!body.files?.length)stringField(body.source,'source',150000,false);try{const result=await compilePreview({source:body.source,files:body.files,entryPath:body.entryPath,visualEdits:body.visualEdits,editor:body.editor,css:body.css||'',props:body.props||{},nonce:previewNonce});send(res,200,result);}catch(error){throw fail(error.message);}return;}
        }
        throw fail('API route not found',404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw fail('Method not allowed',405);
      const requested=path==='/'?'index.html':decodeURIComponent(path).replace(/^\/+/,'');
      const fullPath=resolve(publicDir,requested);const allowedRoot=resolve(publicDir)+sep;
      if(!fullPath.startsWith(allowedRoot))throw fail('Path blocked',403);
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2'};
      if(!types[extname(fullPath)])throw fail('Not found',404);
      let actual;try{actual=await realpath(fullPath);}catch{throw fail('Not found; run npm run build first',404);}
      if(!actual.startsWith(allowedRoot))throw fail('Path blocked',403);
      const bytes=await readFile(actual);
      res.writeHead(200,{'Content-Type':types[extname(fullPath)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'self'; script-src 'self' 'nonce-${previewNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://lcfr.ai/glasses/previews/; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`});res.end(req.method==='HEAD'?undefined:bytes);
    } catch(error) {if(!res.headersSent)send(res,error.status||400,{error:error.message||'Request failed',...(error.onboarding?{onboarding:error.onboarding}:{})});else res.end();}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.timeout=180000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const actualPort=server.address().port;scheduleNext(1500);
  return {server,store,discovery,research,refresh,bulk,intelligence,providers,onboarding,port:actualPort,url:`http://127.0.0.1:${actualPort}`,async close(){closed=true;if(timer)clearTimeout(timer);connectionTest?.abort();await onboarding.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await bulk.close();await refresh.close();await intelligence.close();await discovery.whenIdle();store.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  startServer().then(app=>{
    process.stdout.write(`Glasses local is running at ${app.url}\nData: ${app.store.directory}\nScouts run only while this process is running. Catalogue listings are not approval.\n`);
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
  }).catch(error=>{process.stderr.write(`Glasses could not start: ${error.message}\n`);process.exitCode=1;});
}
