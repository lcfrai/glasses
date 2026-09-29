import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(join(tmpdir(),'glasses-catalogue-review-'));
const evidence=resolve(root,process.env.GLASSES_EVIDENCE_DIR||'evidence/local-2026-09-28/catalogue-review');
await mkdir(evidence,{recursive:true});
const report={startedAt:new Date().toISOString(),result:'RUNNING',checks:[],limitations:['Deterministic synthetic provider responses prove UI/API behavior; these are not live external discoveries.','The test owns an isolated database and ephemeral loopback port; the delivered application on 4317 is untouched.']};
const pageErrors=[];
let app,browser,page,token,plan,firstRun;
const response=(url,payload)=>({url,body:JSON.stringify(payload),contentType:'application/json',status:200});
async function fixtureFetcher(url){
 if(url==='https://review-source.example.org/catalogue-note')return {url,body:'<!doctype html><title>Imported research note</title><meta name="description" content="A synthetic public source, with no reusable-source licence established.">',contentType:'text/html',status:200};
 if(url==='https://registry.directory/directory.json')return response(url,{registries:[]});
 if(url==='https://registry.directory/items.json')return response(url,{items:[{name:'memory-indicator',description:'Agent memory activity indicator',type:'registry:component',categories:['memory'],registry:{name:'Review widgets',basePath:'/fixture-lab/widgets'}}]});
 if(url.startsWith('https://api.github.com/search/repositories?')){
  const deployment=new URL(url).searchParams.get('q').includes('deployment');
  const name=deployment?'local-deployer':'remember-notes';
  return response(url,{items:[{full_name:`fixture-lab/${name}`,name,html_url:`https://github.com/fixture-lab/${name}`,description:deployment?'A synthetic local deployment solution.':'A synthetic coding agent memory solution.',topics:deployment?['deployment']:['memory','agent'],license:{spdx_id:'MIT'},default_branch:'main',pushed_at:'2026-09-27T00:00:00Z'}]});
 }
 throw new Error('HTTP 404 synthetic provider source removed');
}
async function api(path,method='GET',body){
 const res=await fetch(app.url+path,{method,headers:{'X-Glasses-Token':token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await res.json();assert.ok(res.ok,`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);return data;
}
async function check(name,fn){const began=Date.now();try{await fn();report.checks.push({name,result:'PASS',ms:Date.now()-began});console.log('PASS '+name);}catch(error){report.checks.push({name,result:'FAIL',error:error.message});throw error;}}
async function until(fn){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await fn())return;await delay(100);}throw new Error('Expected state did not appear within 15 seconds');}
const nav=()=>page.getByRole('navigation',{name:'Site navigation'});

try{
 app=await startServer({port:0,dataDir:directory,autoScout:false,discoveryFetcher:fixtureFetcher});
 ({token}=await(await fetch(app.url+'/api/session')).json());
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 report.browserVersion=browser.version();
 page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto(app.url);
 await check('Catalogue is the initial destination and creates no sample workspace',async()=>{
  await page.getByRole('searchbox',{name:'Search catalogue'}).waitFor();
  await nav().getByRole('button',{name:'Catalogue',exact:true}).waitFor();
  assert.equal((await api('/api/workspaces')).items.length,0);
  assert.equal(await page.locator('iframe[title="Isolated component preview"]').count(),0);
  await page.getByRole('button',{name:'Inspect Coolify',exact:true}).waitFor();
  await page.screenshot({path:join(evidence,'catalogue-desktop.png'),fullPage:true});
 });
 await check('Catalogue search exposes a real empty state and source details',async()=>{
  const search=page.getByRole('searchbox',{name:'Search catalogue'});
  await search.fill('absent-review-record-499aa1');
  await page.getByRole('heading',{name:'No matching capabilities.'}).waitFor();
  assert.equal((await api('/api/catalog?q=absent-review-record-499aa1')).total,0);
  await search.fill('Coolify');
  await page.getByRole('button',{name:'Inspect Coolify',exact:true}).click();
  await page.getByRole('link',{name:'Inspect original source'}).waitFor();
  assert.match(await page.getByRole('link',{name:'Inspect original source'}).getAttribute('href'),/github\.com\/coollabsio\/coolify/);
  await search.fill('');
 });
 await check('A user creates a research plan and it survives reload',async()=>{
  await nav().getByRole('button',{name:'Research',exact:true}).click();
  await page.getByRole('button',{name:'New research plan',exact:true}).click();
  await page.getByRole('textbox',{name:'Plan name',exact:true}).fill('Agent memory review');
  await page.getByRole('textbox',{name:'Research query',exact:true}).fill('agent memory');
  await page.getByRole('button',{name:'Create plan',exact:true}).click();
  await page.getByRole('button',{name:'Run Agent memory review',exact:true}).waitFor();
  plan=(await api('/api/research/plans')).items.find(item=>item.name==='Agent memory review');
  assert.ok(plan);assert.equal(plan.version,1);assert.equal(plan.enabled,true);
  await page.reload();
  await nav().getByRole('button',{name:'Research',exact:true}).click();
  await page.getByRole('button',{name:'Run Agent memory review',exact:true}).waitFor();
 });
 await check('A plan run retains partial failures, exact findings and its original brief',async()=>{
  await page.getByRole('button',{name:'Run Agent memory review',exact:true}).click();
  await until(async()=>{const runs=(await api('/api/research/runs?planId='+plan.id)).items;firstRun=runs.find(run=>run.finishedAt);return !!firstRun;});
  assert.equal(firstRun.status,'partial');assert.equal(firstRun.planSnapshot.query,'agent memory');assert.equal(firstRun.planSnapshot.version,1);
  assert.ok(firstRun.errors.some(error=>error.includes('HTTP 404 synthetic provider source removed')));
  const matches=await api('/api/catalog?runId='+firstRun.id);
  assert.deepEqual(matches.items.map(item=>item.id).sort(),[...firstRun.candidateIds].sort());
  assert.ok(matches.items.some(item=>item.name==='fixture-lab/remember-notes'));
  await page.getByText(/HTTP 404 synthetic provider source removed/).first().waitFor();
  await page.screenshot({path:join(evidence,'research-partial-run.png'),fullPage:true});
 });
 await check('Run findings open only that run’s candidates and the filter can be cleared',async()=>{
  await page.locator('.research-run').first().getByRole('button',{name:'View findings',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search catalogue'}).waitFor();
  await page.getByRole('button',{name:'Clear research filter',exact:true}).waitFor();
  await page.getByRole('button',{name:'Inspect fixture-lab/remember-notes',exact:true}).waitFor();
  await until(async()=>await page.getByRole('button',{name:'Inspect Coolify',exact:true}).count()===0);
  await until(async()=>await page.getByRole('button',{name:/^Inspect /}).count()===firstRun.candidateIds.length);
  await page.screenshot({path:join(evidence,'catalogue-run-findings.png'),fullPage:true});
  await page.getByRole('button',{name:'Clear research filter',exact:true}).click();
  await page.getByRole('button',{name:'Inspect Coolify',exact:true}).waitFor();
  await nav().getByRole('button',{name:'Research',exact:true}).click();
 });
 await check('Origin filters distinguish discovered records from reference seeds and original samples',async()=>{
  await nav().getByRole('button',{name:'Catalogue',exact:true}).click();
  const origin=page.getByRole('combobox',{name:'Catalogue origin',exact:true});
  const items=(await api('/api/catalog')).items;
  for(const value of ['live','seed','sample']){
   await origin.selectOption(value);
   const expected=items.filter(item=>item.origin===value);
   await until(async()=>await page.getByRole('button',{name:/^Inspect /}).count()===expected.length);
   for(const item of expected)await page.getByRole('button',{name:'Inspect '+item.name,exact:true}).waitFor();
  }
  assert.equal((await api('/api/workspaces')).items.length,0,'Browsing original sample metadata does not open a workbench');
  await origin.selectOption('all');
  await page.getByRole('button',{name:'Inspect Coolify',exact:true}).waitFor();
  await nav().getByRole('button',{name:'Research',exact:true}).click();
 });
 await check('Import opens the real source and clears incompatible catalogue filters without granting reuse rights',async()=>{
  await page.locator('.research-run').first().getByRole('button',{name:'View findings',exact:true}).click();
  await page.getByRole('button',{name:'Clear research filter',exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'Search catalogue'}).fill('unrelated narrowed search');
  await page.getByRole('button',{name:'Solutions',exact:true}).click();
  await page.getByRole('combobox',{name:'Catalogue origin',exact:true}).selectOption('seed');
  await page.getByRole('checkbox',{name:'Known OSS licence',exact:true}).check();
  await page.getByRole('button',{name:'Add source',exact:true}).click();
  await page.getByRole('textbox',{name:'Public HTTPS URL',exact:true}).fill('https://review-source.example.org/catalogue-note');
  await page.getByRole('button',{name:'Add to catalogue',exact:true}).click();
  await page.locator('.detail-name').filter({hasText:'Imported research note'}).waitFor();
  assert.equal(await page.getByRole('searchbox',{name:'Search catalogue'}).inputValue(),'');
  assert.equal(await page.getByRole('combobox',{name:'Catalogue origin',exact:true}).inputValue(),'all');
  assert.equal(await page.getByRole('checkbox',{name:'Known OSS licence',exact:true}).isChecked(),false);
  assert.equal(await page.getByRole('button',{name:'Clear research filter',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'All',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Inspect Imported research note',exact:true}).waitFor();
  const item=(await api('/api/catalog?q=Imported%20research%20note')).items.find(item=>item.name==='Imported research note');
  assert.equal(item.licenseStatus,'unknown');assert.equal(item.origin,'live');assert.match(item.metadataEvidence.sha256,/^[a-f0-9]{64}$/);
  assert.equal(await page.getByRole('link',{name:'Inspect original source'}).getAttribute('href'),'https://review-source.example.org/catalogue-note');
  await page.screenshot({path:join(evidence,'catalogue-imported-source.png'),fullPage:true});
  await nav().getByRole('button',{name:'Research',exact:true}).click();
 });
 await check('Editing a plan preserves the previous run snapshot',async()=>{
  await page.getByRole('button',{name:'Edit Agent memory review',exact:true}).click();
  await page.getByRole('textbox',{name:'Research query',exact:true}).fill('self-hosted deployment');
  await page.getByRole('button',{name:'Save plan changes',exact:true}).click();
  await until(async()=>{plan=(await api('/api/research/plans/'+plan.id)).plan;return plan.version===2;});
  assert.equal(plan.query,'self-hosted deployment');
  const retained=(await api('/api/research/runs/'+firstRun.id)).run;
  assert.equal(retained.planSnapshot.query,'agent memory');assert.equal(retained.planSnapshot.version,1);
 });
 await check('Paused plans can still be run deliberately and record the edited brief',async()=>{
  await page.getByRole('button',{name:'Pause Agent memory review',exact:true}).click();
  await page.getByRole('button',{name:'Resume Agent memory review',exact:true}).waitFor();
  assert.equal((await api('/api/research/plans/'+plan.id)).plan.enabled,false);
  await page.getByRole('button',{name:'Run Agent memory review',exact:true}).click();
  await until(async()=>{const runs=(await api('/api/research/runs?planId='+plan.id)).items;return runs.some(run=>run.id!==firstRun.id&&run.finishedAt);});
  const newer=(await api('/api/research/runs?planId='+plan.id)).items.find(run=>run.id!==firstRun.id);
  assert.equal(newer.planSnapshot.query,'self-hosted deployment');assert.equal(newer.planSnapshot.enabled,false);assert.equal(newer.trigger,'manual');
 });
 await check('Concurrent plan edits show a conflict and preserve the unsaved draft',async()=>{
  await page.getByRole('button',{name:'Edit Agent memory review',exact:true}).click();
  await page.getByRole('textbox',{name:'Research query',exact:true}).fill('my unsaved memory research');
  const current=(await api('/api/research/plans/'+plan.id)).plan;
  await api('/api/research/plans/'+plan.id,'PUT',{query:'agent updated saved query',expectedVersion:current.version});
  await page.getByRole('button',{name:'Save plan changes',exact:true}).click();
  await page.getByText(/Research plan changed since version/).first().waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Research query',exact:true}).inputValue(),'my unsaved memory research');
  assert.equal((await api('/api/research/plans/'+plan.id)).plan.query,'agent updated saved query');
  await page.screenshot({path:join(evidence,'research-conflict.png'),fullPage:true});
  await page.getByRole('button',{name:'Reload saved plan',exact:true}).click();
  await until(async()=>await page.getByRole('textbox',{name:'Research query',exact:true}).inputValue()==='agent updated saved query');
  await page.getByRole('textbox',{name:'Research query',exact:true}).fill('agent updated saved query with reviewed amendment');
  await page.getByRole('button',{name:'Save plan changes',exact:true}).click();
  await until(async()=>(await api('/api/research/plans/'+plan.id)).plan.query==='agent updated saved query with reviewed amendment');
  await page.reload();
 });
 await check('Research interval changes retain pause state and survive reload',async()=>{
  await nav().getByRole('button',{name:'Research',exact:true}).click();
  await page.getByRole('button',{name:'Schedule settings',exact:true}).click();
  const input=page.getByRole('spinbutton',{name:'Research interval (minutes)',exact:true});
  await input.fill('45');
  await page.getByRole('button',{name:'Save interval',exact:true}).click();
  await until(async()=>(await api('/api/status')).schedule.intervalMinutes===45);
  assert.equal((await api('/api/status')).schedule.enabled,false,'Changing cadence must not enable paused scouting');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.reload();
  await nav().getByRole('button',{name:'Research',exact:true}).click();
  await page.getByRole('button',{name:'Schedule settings',exact:true}).click();
  await until(async()=>await input.inputValue()==='45');
  assert.equal(await page.getByRole('switch',{name:'Autonomous scouting',exact:true}).getAttribute('aria-checked'),'false');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 });
 await check('Research state and history survive an actual server/database restart',async()=>{
  await app.close();app=await startServer({port:0,dataDir:directory,autoScout:false,discoveryFetcher:fixtureFetcher});
  ({token}=await(await fetch(app.url+'/api/session')).json());
  assert.equal((await api('/api/research/plans/'+plan.id)).plan.query,'agent updated saved query with reviewed amendment');
  assert.equal((await api('/api/status')).schedule.intervalMinutes,45);
  assert.equal((await api('/api/status')).schedule.enabled,false);
  const history=await api('/api/research/runs?planId='+plan.id+'&limit=1&offset=1');
  assert.equal(history.total,2);assert.equal(history.items.length,1);assert.equal(history.items[0].id,firstRun.id);
  await page.goto(app.url);
  await nav().getByRole('button',{name:'Research',exact:true}).click();
  await page.getByRole('button',{name:'Run Agent memory review',exact:true}).waitFor();
 });
 await check('Narrow catalogue and research pages remain usable with no browser exceptions',async()=>{
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(evidence,'research-mobile.png'),fullPage:true});
  let size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(size.width<=size.viewport+2,JSON.stringify(size));
  await nav().getByRole('button',{name:'Catalogue',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search catalogue'}).waitFor();
  await page.screenshot({path:join(evidence,'catalogue-mobile.png'),fullPage:true});
  size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(size.width<=size.viewport+2,JSON.stringify(size));
  assert.deepEqual(pageErrors,[]);
 });
 report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);if(page)await page.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await browser?.close();await app?.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+ '\\')||target.startsWith(resolve(tmpdir())+'/'),'Only delete the owned temporary test directory');await rm(target,{recursive:true,force:true});await writeFile(join(evidence,'catalogue-e2e.json'),JSON.stringify(report,null,2));}
