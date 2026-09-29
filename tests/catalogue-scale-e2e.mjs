import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {startServer} from '../src/server.mjs';

const directory=await mkdtemp(join(tmpdir(),'glasses-scale-ui-'));
const evidence=resolve(process.env.GLASSES_EVIDENCE_DIR||'evidence/catalogue-growth-2026-09-28/browser-scale');await mkdir(evidence,{recursive:true});
const report={startedAt:new Date().toISOString(),result:'RUNNING',checks:[],limitations:['150 synthetic public candidates exercise real HTTP, SQLite, assessment filtering and browser rendering in an isolated server.','No real provider requests, credentials, main application data or settings are used.']};
let app,browser,page,token;const errors=[];
const providers={plan:async()=>{throw new Error('Unexpected scale-test planning')},rank:async()=>{throw new Error('Unexpected scale-test ranking')},status:async()=>({codex:{available:true,authenticated:true,model:'scale-fixture'},jev:{configured:false,model:'jev-1.13.0'}}),classify:async(provider,{cards})=>({model:'scale-fixture',results:cards.map(card=>({id:card.id,artifact:'tool-library',adoption:'embed-package',capabilities:['synthetic scale'],confidence:.9,evidenceIds:card.evidenceIds})),usage:{inputTokens:1,outputTokens:1}})};
async function api(path,method='GET',body){const response=await fetch(app.url+path,{method,headers:{'X-Glasses-Token':token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();assert.ok(response.ok,path+' '+response.status+' '+JSON.stringify(data));return data;}
async function until(fn){const end=Date.now()+15000;while(Date.now()<end){const result=await fn();if(result)return result;await delay(50)}throw new Error('Expected state did not appear');}
async function check(name,fn){const start=Date.now();try{await fn();report.checks.push({name,result:'PASS',ms:Date.now()-start});console.log('PASS '+name)}catch(error){report.checks.push({name,result:'FAIL',error:error.message});throw error}}
const nav=()=>page.getByRole('navigation',{name:'Site navigation'}),cards=()=>page.locator('button.capability-card'),statusFilter=()=>page.getByRole('combobox',{name:'Catalogue assessment status'});
const names=()=>cards().locator('strong').allTextContents();
const next=()=>page.getByRole('button',{name:'Next results',exact:true});
const previous=()=>page.getByRole('button',{name:'Previous results',exact:true});
const search=()=>page.getByRole('searchbox',{name:'Search catalogue'});
async function settled(){await until(async()=>await page.locator('.catalogue-list').getAttribute('aria-busy')==='false')}
async function chooseStatus(value){const response=page.waitForResponse(response=>response.url().includes('/api/catalog?')&&new URL(response.url()).searchParams.get('assessmentStatus')===value);await statusFilter().selectOption(value);await response;await settled();}
try{
  app=await startServer({port:0,dataDir:directory,autoScout:false,providers,discoveryFetcher:async url=>({url,status:200,contentType:'text/html',body:'<!doctype html><title>ZZZ Imported scale source</title><meta name="description" content="Synthetic unknown-licence source">'})});({token}=await(await fetch(app.url+'/api/session')).json());
  const candidates=[];
  for(let index=0;index<150;index++){
    const name='Scale fixture '+String(index).padStart(3,'0'),url='https://example.org/scale/'+index,metadataEvidence=app.store.retainEvidence({url,body:name+' is public synthetic evidence for scale review.'});
    let item=app.store.upsertCapability({name,url,kind:index%2?'component':'solution',origin:'live',description:'Synthetic catalogue pagination and review source.',license:null,metadataEvidence}).item;
    if(index<25)app.intelligence.submitAssessment(item.id,{artifact:'tool-library',adoption:'embed-package',capabilities:['scale-review'],confidence:index>=10&&index<15?.4:.9,evidenceIds:[metadataEvidence.id]});
    if(index>=15&&index<20)item=app.store.upsertCapability({...item,description:'Changed public description after the retained classification.'}).item;
    if(index>=20&&index<25)app.intelligence.correctAssessment(item.id,{artifact:'agent-extension',notes:'Synthetic human correction'});
    candidates.push(item);
  }
  const run={id:'scale-run-fixture',status:'completed',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),query:'Scale findings',candidateIds:candidates.slice(125,129).map(item=>item.id),added:4,updated:0,errors:[]};app.store.saveRun(run);
  const job=app.intelligence.enqueue({type:'classify',candidateIds:[candidates[149].id]});await until(()=>app.intelligence.getJob(job.id).status==='completed');
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});report.browserVersion=browser.version();page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));await page.goto(app.url+'/#catalogue');
  await check('A large catalogue renders 60 cards per page and visits every result exactly once',async()=>{
    const all=await api('/api/catalog');report.total=all.total;await until(async()=>await cards().count()===60);const seen=[];
    for(let index=0;index<Math.ceil(all.total/60);index++){await settled();seen.push(...await names());if(index+1<Math.ceil(all.total/60)){const first=(await names())[0];await next().click();await until(async()=>(await names())[0]!==first)}}
    assert.equal(await next().isDisabled(),true);assert.deepEqual([...seen].sort(),all.items.map(item=>item.name).sort());assert.equal(new Set(seen).size,seen.length);assert.match(await page.locator('.results-heading').innerText(),new RegExp(all.total+' results'));
    await page.screenshot({path:join(evidence,'last-page.png'),fullPage:true,animations:'disabled'});
  });
  await check('Page changes preserve inspection and search resets to its first page',async()=>{
    const selected=(await names())[0];await page.getByRole('button',{name:'Inspect '+selected,exact:true}).click();await previous().click();assert.equal(await page.locator('.detail-name').textContent(),selected);
    await search().fill('001');await until(async()=>await cards().count()===1);assert.deepEqual(await names(),['Scale fixture 001']);assert.equal(await next().count(),0);
    await search().fill('');await until(async()=>await cards().count()===60);assert.equal(await previous().isDisabled(),true);
  });
  await check('Every assessment status filters correctly and low-confidence inference does not grant licence rights',async()=>{
    for(const status of ['unclassified','classified','needs-review','stale','corrected']){const expected=await api('/api/catalog?assessmentStatus='+status);await chooseStatus(status);assert.equal(await cards().count(),Math.min(60,expected.total));assert.deepEqual(await names(),expected.items.slice(0,60).map(item=>item.name));assert.match(await page.locator('.results-heading').innerText(),new RegExp(expected.total+' results'));}
    await chooseStatus('needs-review');await page.getByRole('button',{name:'Inspect Scale fixture 010',exact:true}).click();await page.getByText('40%',{exact:true}).waitFor();assert.match(await page.getByRole('region',{name:'Candidate assessment'}).innerText(),/Low confidence/);
    await page.getByRole('checkbox',{name:'Known OSS licence',exact:true}).check();await page.getByRole('heading',{name:'No matching capabilities.'}).waitFor();assert.equal((await api('/api/catalog/'+candidates[10].id)).item.licenseStatus,'unknown');await page.getByRole('checkbox',{name:'Known OSS licence',exact:true}).uncheck();
    await page.screenshot({path:join(evidence,'needs-review.png'),fullPage:true,animations:'disabled'});
  });
  await check('Research and AI findings clear incompatible assessment filters',async()=>{
    await chooseStatus('stale');await nav().getByRole('button',{name:'Research',exact:true}).click();await page.locator('.research-run').getByRole('button',{name:'View findings',exact:true}).click();await until(async()=>await cards().count()===4);assert.equal(await statusFilter().inputValue(),'all');assert.deepEqual(await names(),candidates.slice(125,129).map(item=>item.name));
    await chooseStatus('stale');await nav().getByRole('button',{name:'Research',exact:true}).click();await page.locator('[data-job-id="'+job.id+'"]').getByRole('button',{name:'View AI findings',exact:true}).click();await until(async()=>await cards().count()===1);assert.equal(await statusFilter().inputValue(),'all');assert.deepEqual(await names(),[candidates[149].name]);
  });
  await check('Import clears incompatible filters and reveals an unknown-licence source beyond page one',async()=>{
    await chooseStatus('stale');await page.getByRole('checkbox',{name:'Known OSS licence',exact:true}).check();await page.getByRole('button',{name:'Add source',exact:true}).click();await page.getByRole('textbox',{name:'Public HTTPS URL',exact:true}).fill('https://example.org/new-scale-source');await page.getByRole('button',{name:'Add to catalogue',exact:true}).click();await page.getByRole('button',{name:'Inspect ZZZ Imported scale source',exact:true}).waitFor();assert.equal(await statusFilter().inputValue(),'all');assert.equal(await page.getByRole('checkbox',{name:'Known OSS licence',exact:true}).isChecked(),false);assert.equal(await page.getByRole('button',{name:'Clear AI findings',exact:true}).count(),0);assert.equal(await previous().isEnabled(),true);
    const item=(await api('/api/catalog?q=ZZZ')).items[0];assert.equal(item.licenseStatus,'unknown');assert.equal(item.assessment.status,'unclassified');await page.screenshot({path:join(evidence,'import-last-page.png'),fullPage:true,animations:'disabled'});
  });
  await check('Paging and assessment filtering preserve an unsaved shared-canvas draft',async()=>{
    const workspace=await api('/api/workspaces','POST',{title:'Scale draft fixture',source:'export default ()=> <h1>Scale canvas fixture</h1>'});await page.goto(app.url+'/#workbench/'+workspace.id);await page.getByRole('button',{name:'Properties',exact:true}).click();await page.getByRole('textbox',{name:'Workspace name',exact:true}).fill('Unsaved scale draft');await nav().getByRole('button',{name:'Catalogue',exact:true}).click();await chooseStatus('unclassified');await next().click();await chooseStatus('classified');await nav().getByRole('button',{name:/^Workbench/}).click();assert.equal(await page.getByRole('textbox',{name:'Workspace name',exact:true}).inputValue(),'Unsaved scale draft');assert.equal((await api('/api/workspaces/'+workspace.id)).title,'Scale draft fixture');
  });
  await check('Cold narrow and short desktop catalogues expose readable cards and usable review controls',async()=>{
    for(const viewport of [{width:390,height:844},{width:1280,height:720}]){
      const responsive=await browser.newPage({viewport});responsive.on('pageerror',error=>errors.push(error.message));await responsive.goto(app.url+'/#catalogue');await responsive.getByRole('searchbox',{name:'Search catalogue'}).waitFor();await until(async()=>await responsive.locator('button.capability-card').count()===60);assert.equal(await responsive.getByRole('combobox',{name:'Catalogue assessment status'}).isVisible(),true);await responsive.getByRole('button',{name:'Next results',exact:true}).click();const suffix=viewport.width<800?'mobile':'short-desktop';await responsive.screenshot({path:join(evidence,'catalogue-'+suffix+'.png'),fullPage:true,animations:'disabled'});await responsive.locator('button.capability-card').first().scrollIntoViewIfNeeded();const cardBox=await responsive.locator('button.capability-card').first().boundingBox();assert.ok(cardBox&&cardBox.height>100&&cardBox.y>=(viewport.width<800?140:70)&&cardBox.y+cardBox.height<=viewport.height-24,JSON.stringify(cardBox));await responsive.screenshot({path:join(evidence,'catalogue-'+suffix+'-cards.png'),fullPage:true,animations:'disabled'});const size=await responsive.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(size.width<=size.viewport+2,JSON.stringify(size));await responsive.close();
    }
    assert.deepEqual(errors,[]);
  });
  report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;}finally{report.finishedAt=new Date().toISOString();await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2));await browser?.close();await app?.close();await rm(directory,{recursive:true,force:true});}
