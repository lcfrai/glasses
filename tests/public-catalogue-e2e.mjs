import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { stableId } from '../src/store.mjs';
import { createPublicCatalogue } from '../src/public-catalogue.mjs';
import { INTELLIGENCE_SCHEMA } from '../src/intelligence.mjs';
import { CLASSIFICATION_POLICY, classificationFingerprint } from '../src/classification-policy.mjs';

const output=resolve(process.env.GLASSES_EVIDENCE_DIR||'evidence/public-launch-2026-09-29/shared-browser');await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'glasses-shared-browser-')),time='2026-09-29T00:00:00.000Z';
const report={startedAt:new Date().toISOString(),result:'RUNNING',checks:[],scope:'Synthetic isolated public pack, current actual browser bundle. No main data or paid providers.'};
const errors=[];let app,browser,page,externalRequests=0,inferenceCalls=0;
const sha=value=>createHash('sha256').update(value).digest('hex');
function evidence(url,data){const body=JSON.stringify(data),sha256=sha(body);return {id:stableId(`${url}\n${sha256}`),url,body,sha256,status:200,firstFetchedAt:time,lastFetchedAt:time};}
async function check(name,run){try{await run();report.checks.push({name,result:'PASS'});}catch(error){report.checks.push({name,result:'FAIL',error:error.message});throw error;}}
try{
  const repo={private:false,name:'memory',full_name:'public-lab/memory',html_url:'https://github.com/public-lab/memory',description:'Persistent conventions for existing agents.',topics:['memory','agent'],license:{spdx_id:'MIT'},stargazers_count:1234,archived:false};
  const repoEvidence=evidence('https://api.github.com/repos/public-lab/memory',repo),buttonURL='https://widgets.example.org/r/button.json',buttonData={name:'button',description:'A source-backed button',files:[{path:'button.tsx',content:'export default function Button(){return <button>Fetched on demand</button>}'}]},buttonEvidence=evidence(buttonURL,buttonData);
  const item={id:stableId(repo.html_url),url:repo.html_url,name:repo.full_name,description:repo.description,provider:'GitHub',kind:'solution',tags:repo.topics,origin:'live',metadataEvidence:repoEvidence,provenance:{revision:'branch:main'}};
  const base={id:item.id,name:item.name,url:item.url,description:item.description,provider:item.provider,sourceKind:item.kind,tags:item.tags};
  const classification={id:item.id,provider:'jev',model:'jev-1.13.0',schemaVersion:INTELLIGENCE_SCHEMA,policyVersion:CLASSIFICATION_POLICY,sourceFingerprint:classificationFingerprint({base,evidenceIds:[repoEvidence.id],revision:'branch:main',sourceHash:null}),updatedAt:time,classification:{artifact:'agent-extension',adoption:'configure-agent',capabilities:['durable recall'],confidence:0.88,evidenceIds:[repoEvidence.id]}};
  const pack=createPublicCatalogue({capabilities:[item,{url:buttonURL,origin:'live',sourceDocumentEvidence:buttonEvidence}],evidence:[repoEvidence,buttonEvidence],assessments:[classification],generatedAt:time}).snapshot;
  assert.equal(pack.items.find(row=>row.id===item.id).assessment?.provider,'jev','The current-policy fixture must survive strict projection before testing its UI');
  const unexpected=async()=>{inferenceCalls++;throw new Error('Unexpected model request');};
  app=await startServer({port:0,dataDir:directory,seed:false,autoScout:false,providers:{status:async()=>({}),classify:unexpected,plan:unexpected,rank:unexpected},discoveryFetcher:async url=>{externalRequests++;assert.equal(url,buttonURL);return {url,body:JSON.stringify(buttonData),contentType:'application/json',status:200};}});
  const local=app.store.upsertCapability({url:'https://local-example.org/kept',name:'Local record preserved',kind:'reference',origin:'live',description:'Synthetic local annotation'}).item;
  await app.store.importPublicCatalogue(pack);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));await page.goto(app.url);
  await check('Shared origin filter and attributed inference appear without creating local evidence or jobs',async()=>{
    await page.getByLabel('Catalogue origin').selectOption('shared');await page.getByRole('button',{name:'Inspect public-lab/memory',exact:true}).click();
    const observation=page.getByRole('region',{name:'Shared catalogue observation'});await observation.waitFor();assert.match(await observation.innerText(),/Publisher inference via jev \/ jev-1.13.0/);assert.equal(await page.getByRole('button',{name:'Inspect Local record preserved',exact:true}).count(),0);
    assert.equal(app.store.evidence().length,0);assert.equal(app.intelligence.listJobs().total,0);assert.equal(externalRequests,0);assert.equal(inferenceCalls,0);await page.screenshot({path:join(output,'shared-origin-desktop.png'),fullPage:true});
  });
  await check('Shared model labels support search while local classification stays unclassified',async()=>{
    await page.getByRole('searchbox',{name:'Search catalogue'}).fill('durable recall');await page.getByRole('button',{name:'Inspect public-lab/memory',exact:true}).waitFor();assert.equal(app.intelligence.getAssessment(item.id).status,'unclassified');
  });
  await check('Explicit source refresh promotes only the selected shared component to local fetched evidence',async()=>{
    await page.getByRole('searchbox',{name:'Search catalogue'}).fill('');await page.getByRole('button',{name:'Inspect button',exact:true}).click();await page.getByRole('button',{name:'Refresh source evidence',exact:true}).click();
    await page.getByText('Source evidence refreshed.',{exact:true}).waitFor();assert.equal(externalRequests,1);assert.equal(app.store.getCapability(stableId(buttonURL)).origin,'live');assert.equal(app.store.getCapability(stableId(buttonURL)).licenseStatus,'unknown');assert.equal(app.store.getCapability(local.id).description,local.description);
    await page.getByLabel('Catalogue origin').selectOption('live');await page.getByRole('button',{name:'Inspect button',exact:true}).waitFor();assert.equal(await page.getByRole('region',{name:'Shared catalogue observation'}).count(),0);await page.screenshot({path:join(output,'refreshed-local-source.png'),fullPage:true});
  });
  await check('Mobile shared inspection retains attribution and has no horizontal overflow',async()=>{
    await page.setViewportSize({width:390,height:844});await page.getByLabel('Catalogue origin').selectOption('shared');await page.getByRole('button',{name:'Inspect public-lab/memory',exact:true}).click();await page.getByRole('region',{name:'Shared catalogue observation'}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(output,'shared-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);assert.equal(inferenceCalls,0);assert.equal(app.intelligence.listJobs().total,0);
  });
  report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.message;if(page)await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();report.externalFixtureRequests=externalRequests;report.inferenceCalls=inferenceCalls;report.pageErrors=errors;await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');if(browser)await browser.close();if(app)await app.close();await rm(directory,{recursive:true,force:true});}
console.log(JSON.stringify(report));
