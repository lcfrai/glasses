import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {startServer} from '../src/server.mjs';
import {createHash} from 'node:crypto';
const evidence=resolve(process.env.GLASSES_EVIDENCE_DIR||'evidence/local-2026-09-28');await mkdir(evidence,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'glasses-canvas-'));
const report={startedAt:new Date().toISOString(),fixture:'Synthetic multi-file React fixture; genuine external source trial is separate.',checks:[],result:'RUNNING'};
let app,browser,page;
async function check(name,fn){try{await fn();report.checks.push({name,result:'PASS'});console.log('PASS '+name)}catch(error){report.checks.push({name,result:'FAIL',error:error.message});throw error}}
async function until(fn){const deadline=Date.now()+15000;let value;while(Date.now()<deadline){try{value=await fn();if(value)return value}catch{}await delay(100)}throw new Error('Timed out waiting for rendered state')}
try{
 app=await startServer({port:0,dataDir:directory,autoScout:false,discoveryFetcher:async()=>{throw new Error('HTTP 404 synthetic upstream removed')}});
 const token=(await (await fetch(app.url+'/api/session')).json()).token;
 const api=async(route,method='GET',body)=>{const response=await fetch(app.url+route,{method,headers:{'Content-Type':'application/json','X-Glasses-Token':token},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
 let workspace=await api('/api/workspaces','POST',{title:'Synthetic multi-file canvas proof',entryPath:'src/App.tsx',source:"import {label} from './label';import {Check} from 'lucide-react';export default function Demo(){return <section style={{padding:36}}><h1>{label}</h1><p>Choose an element, then make it yours.</p><Check aria-label='Reviewed icon'/></section>}",files:[{path:'src/label.ts',content:"export const label='Shared canvas proof';"}],css:'h1 {font-size:28px;color:#242424;padding:0;}'});
 const otherWorkspace=await api('/api/workspaces','POST',{title:'Other linked workspace',source:'export default ()=> <h1>Another workspace</h1>'});
 const retainedSource='export default ()=> <h1>Retained source fixture</h1>',pinnedRevision='a'.repeat(40),sourceHash=createHash('sha256').update(retainedSource).digest('hex');
 const snapshot=app.store.retainEvidence({url:'https://registry.directory/synthetic/widgets/removed-source',body:retainedSource,contentType:'text/plain'});
 const sourceFixture=app.store.upsertCapability({url:'https://registry.directory/synthetic/widgets/removed-source',name:'Source evidence fixture',description:'Synthetic source-state browser fixture',kind:'component',origin:'sample',license:'MIT',sourceFiles:[{path:'source.tsx',content:retainedSource}],previewSource:retainedSource,outcomes:[],sourceState:{status:'ok',checkedAt:new Date().toISOString()},provenance:{sourceCodeUrl:snapshot.url,sourceHash,sourceEvidenceId:snapshot.id,resolvedRevision:pinnedRevision},licenseEvidence:{status:'fetched',scope:'synthetic-test-fixture',note:'Synthetic licence metadata for UI regression only.'}}).item;
 app.store.recordOutcome({capabilityId:sourceFixture.id,result:'failed',notes:'Synthetic consumer outcome remains inspectable.',context:{project:'Source evidence synthetic consumer',environment:'Windows fixture',version:pinnedRevision}});
 const linkedWorkspace=await api('/api/workspaces','POST',{title:'Linked source workspace',capabilityId:sourceFixture.id});
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});report.browser=browser.version();
 page=await browser.newPage({viewport:{width:1600,height:1100}});const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(app.url+'/#workbench/'+workspace.id);
 const frame=page.frameLocator('iframe[title="Isolated component preview"]');
 await check('Multi-file React candidate renders with reviewed dependency',async()=>{await frame.getByRole('heading',{name:'Shared canvas proof'}).waitFor();assert.equal(await frame.locator('svg').count(),1);assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts')});
 await check('Direct element selection changes typography, spacing and colour',async()=>{
  await page.getByRole('button',{name:'Select canvas element',exact:true}).click();
  await frame.getByRole('heading',{name:'Shared canvas proof'}).click();
  await page.getByRole('textbox',{name:'Element text colour',exact:true}).fill('#126447');
  await page.getByRole('textbox',{name:'Element font size',exact:true}).fill('42px');
  await page.getByRole('textbox',{name:'Element padding',exact:true}).fill('18px');
  await page.getByRole('button',{name:'Apply element styles',exact:true}).click();
  await until(async()=>await frame.locator('h1').evaluate(element=>getComputedStyle(element).fontSize)==='42px');
  assert.equal(await frame.locator('h1').evaluate(element=>getComputedStyle(element).color),'rgb(18, 100, 71)');
  assert.equal(await frame.locator('h1').evaluate(element=>getComputedStyle(element).padding),'18px');
  await page.screenshot({path:join(evidence,'canvas-selected-edited.png'),fullPage:true});
 });
 await check('Undo and redo restore actual rendered element styles',async()=>{
  await page.getByRole('button',{name:'Undo edit',exact:true}).click();await until(async()=>await frame.locator('h1').evaluate(element=>getComputedStyle(element).fontSize)==='28px');
  await page.getByRole('button',{name:'Redo edit',exact:true}).click();await until(async()=>await frame.locator('h1').evaluate(element=>getComputedStyle(element).fontSize)==='42px');
 });
 await check('Source module edit participates in undo redo and updates preview',async()=>{
  await page.getByRole('button',{name:'TSX',exact:true}).click();await page.getByRole('combobox',{name:'Workspace source file'}).selectOption('src/label.ts');
  await page.getByRole('textbox',{name:'Component TSX source'}).fill("export const label='Shared multi-file edit';");await page.getByRole('button',{name:'Canvas',exact:true}).click();await frame.getByRole('heading',{name:'Shared multi-file edit'}).waitFor();
 });
 await check('Save reload and export preserve exact module and visual edits',async()=>{
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('button',{name:'All changes saved',exact:true}).waitFor();workspace=await api('/api/workspaces/'+workspace.id);
  assert.equal(Object.values(workspace.visualEdits)[0].padding,'18px');await page.reload();await frame.getByRole('heading',{name:'Shared multi-file edit'}).waitFor();assert.equal(await frame.locator('h1').evaluate(element=>getComputedStyle(element).fontSize),'42px');
  const exported=await api('/api/workspaces/'+workspace.id+'/export');assert.match(exported.files.find(file=>file.path==='compiled.css').content,/42px !important/);assert.match(exported.files.find(file=>file.path==='src/label.ts').content,/Shared multi-file edit/);report.workspaceId=workspace.id;report.exportedPaths=exported.files.map(file=>file.path);await writeFile(join(evidence,'canvas-fixture-export.json'),JSON.stringify(exported,null,2));
 });
 await check('Agent visual update syncs into same open canvas',async()=>{
  const selector=Object.keys(workspace.visualEdits)[0];await api('/api/workspaces/'+workspace.id,'PUT',{visualEdits:{[selector]:{color:'#663399',fontSize:'36px',padding:'12px'}}});await until(async()=>await frame.locator('h1').evaluate(element=>getComputedStyle(element).fontSize)==='36px');
 });
 await check('Catalogue and research navigation retain the draft and concurrent agent saves cannot overwrite it',async()=>{
  await page.getByRole('textbox',{name:'Workspace name'}).fill('My unsaved local draft');
  const navigation=page.getByRole('navigation',{name:'Site navigation'});await navigation.getByRole('button',{name:'Catalogue',exact:true}).click();await page.getByRole('searchbox',{name:'Search catalogue'}).waitFor();await navigation.getByRole('button',{name:'Research',exact:true}).click();await page.getByRole('heading',{name:'Research',exact:true}).waitFor();await navigation.getByRole('button',{name:/^Workbench/}).click();assert.equal(await page.getByRole('textbox',{name:'Workspace name'}).inputValue(),'My unsaved local draft');assert.ok(page.url().endsWith('#workbench/'+workspace.id));
  const before=await api('/api/workspaces/'+workspace.id);await api('/api/workspaces/'+workspace.id,'PUT',{expectedVersion:before.version,title:'Saved by the agent'});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('button',{name:'Download my draft',exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Workspace name'}).inputValue(),'My unsaved local draft');assert.equal((await api('/api/workspaces/'+workspace.id)).title,'Saved by the agent');
  await page.screenshot({path:join(evidence,'canvas-conflict-preserved.png'),fullPage:true});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Load saved version',exact:true}).click();await until(async()=>await page.getByRole('textbox',{name:'Workspace name'}).inputValue()==='Saved by the agent');
 });
 await check('Shared workspace links select the exact study on startup and same-page navigation',async()=>{
  assert.ok(page.url().endsWith('#workbench/'+workspace.id));await page.evaluate(id=>location.hash='workbench/'+id,otherWorkspace.id);await frame.getByRole('heading',{name:'Another workspace'}).waitFor();
  await page.evaluate(id=>location.hash='workbench/'+id,workspace.id);await frame.getByRole('heading',{name:'Shared multi-file edit'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Workspace name'}).inputValue(),'Saved by the agent');
  await page.goto(app.url+'/#workbench/'+linkedWorkspace.id);await frame.getByRole('heading',{name:'Retained source fixture'}).waitFor();await page.getByRole('button',{name:'Source details',exact:true}).click();
  await page.locator('.detail-name').filter({hasText:'Source evidence fixture'}).waitFor();assert.equal(await page.getByTestId('source-revision').textContent(),pinnedRevision);await page.screenshot({path:join(evidence,'workspace-linked-source-details.png'),fullPage:true});
  await page.getByRole('button',{name:'Inspect Coolify',exact:true}).click();await api('/api/workspaces/'+linkedWorkspace.id,'PUT',{title:'Linked workspace updated'});
  await until(async()=>await page.getByRole('combobox',{name:'Select workspace'}).locator('option:checked').textContent()==='Linked workspace updated');assert.equal(await page.locator('.detail-name').textContent(),'Coolify');
  await page.goto(app.url+'/#workbench/'+workspace.id);await frame.getByRole('heading',{name:'Shared multi-file edit'}).waitFor();
 });
 await check('Failed refresh exposes retained source warning, exact revision, evidence hash and previous outcome context',async()=>{
  await page.getByRole('button',{name:'Inspect Source evidence fixture',exact:true}).click();
  await page.getByText('Previous local outcomes (1)',{exact:true}).click();await page.getByText('Source evidence synthetic consumer',{exact:true}).waitFor();await page.getByText('Previous local outcomes (1)',{exact:true}).click();
  await page.getByRole('button',{name:'Refresh source evidence',exact:true}).click();
  await page.getByText('Source error',{exact:true}).waitFor();assert.match(await page.locator('.source-warning').textContent(),/HTTP 404 synthetic upstream removed/);assert.match(await page.locator('.source-warning').textContent(),/Previously fetched source is retained/);
  assert.equal(await page.getByTestId('source-revision').textContent(),pinnedRevision);await page.getByText('Retained source evidence',{exact:true}).click();assert.equal(await page.getByTestId('source-hash').textContent(),sourceHash);
  await page.getByText('Previous local outcomes (1)',{exact:true}).click();await page.getByText('Source evidence synthetic consumer',{exact:true}).waitFor();assert.match(await page.locator('.outcome-history').textContent(),/Synthetic consumer outcome remains inspectable/);
  await page.locator('.source-warning').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'source-refresh-warning.png'),fullPage:true});
  await page.getByTestId('source-hash').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'source-evidence-details.png'),fullPage:true});
  await page.getByRole('button',{name:'Open retained source',exact:true}).click();await frame.getByRole('heading',{name:'Retained source fixture'}).waitFor();assert.match(await page.locator('.canvas-source-warning').textContent(),/Retained source preview/);
 });
 await check('UI outcomes persist the matching workspace reference without assigning unrelated catalogue feedback',async()=>{
  const activeWorkspaceId=await page.getByRole('combobox',{name:'Select workspace'}).inputValue();
  assert.equal((await api('/api/workspaces/'+activeWorkspaceId)).capabilityId,sourceFixture.id);
  await page.getByRole('button',{name:'Source details',exact:true}).click();
  const matchingNote='UI matching-workspace outcome context proof';
  await page.getByRole('textbox',{name:'Outcome notes',exact:true}).fill(matchingNote);
  await page.getByRole('button',{name:'Worked',exact:true}).click();
  const matching=await until(async()=>(await api('/api/catalog/'+sourceFixture.id)).item.outcomes.find(outcome=>outcome.notes===matchingNote));
  assert.equal(matching.result,'worked');assert.deepEqual(matching.context,{workspaceId:activeWorkspaceId});assert.equal(matching.sourceSnapshot.revision,pinnedRevision);
  await page.reload();await frame.getByRole('heading',{name:'Retained source fixture'}).waitFor();await page.getByRole('button',{name:'Source details',exact:true}).click();
  await page.getByText('Previous local outcomes (2)',{exact:true}).click();await page.getByText(matchingNote,{exact:true}).waitFor();await page.getByText(activeWorkspaceId,{exact:true}).waitFor();
  await page.locator('.outcome-history').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'outcome-workspace-context.png'),fullPage:true});
  await page.getByRole('navigation',{name:'Site navigation'}).getByRole('button',{name:'Catalogue',exact:true}).click();await page.getByRole('button',{name:'Inspect Coolify',exact:true}).click();
  const unrelated=(await api('/api/catalog?q=Coolify')).items.find(item=>item.name==='Coolify'),unrelatedNote='UI unrelated catalogue outcome context proof';
  await page.getByRole('textbox',{name:'Outcome notes',exact:true}).fill(unrelatedNote);await page.getByRole('button',{name:'Not a fit',exact:true}).click();
  const withoutWorkspace=await until(async()=>(await api('/api/catalog/'+unrelated.id)).item.outcomes.find(outcome=>outcome.notes===unrelatedNote));
  assert.equal(withoutWorkspace.result,'rejected');assert.deepEqual(withoutWorkspace.context,{});
  assert.equal((await api('/api/catalog?q='+encodeURIComponent(matchingNote))).items.some(item=>item.id===sourceFixture.id),true);
  await writeFile(join(evidence,'ui-outcome-context.json'),JSON.stringify({activeWorkspaceId,matching,unrelated:withoutWorkspace},null,2));
  await page.getByRole('navigation',{name:'Site navigation'}).getByRole('button',{name:'Workbench',exact:true}).click();
 });
 await check('Candidate cannot reuse script nonce to load external JavaScript',async()=>{
  const requests=[];await page.route('https://glasses-csp-probe.example.org/**',route=>{requests.push(route.request().url());return route.abort()});
  const source=`import {useEffect,useState} from 'react';export default function Probe(){const [state,setState]=useState('pending');useEffect(()=>{const handler=e=>{if(e.blockedURI.includes('glasses-csp-probe'))setState('blocked')};document.addEventListener('securitypolicyviolation',handler);const script=document.createElement('script');script.nonce=document.querySelector('script').nonce;script.src='https://glasses-csp-probe.example.org/nonce-script';document.body.append(script);return ()=>document.removeEventListener('securitypolicyviolation',handler)},[]);return <pre>{state}</pre>}`;
  const compiled=await api('/api/preview','POST',{source});
  await page.evaluate(html=>{const probe=document.createElement('iframe');probe.id='nonce-probe';probe.setAttribute('sandbox','allow-scripts');probe.srcdoc=html;document.body.append(probe)},compiled.html);
  await page.frameLocator('#nonce-probe').getByText('blocked',{exact:true}).waitFor();assert.deepEqual(requests,[]);await page.evaluate(()=>document.getElementById('nonce-probe').remove());
 });
 await check('Narrow viewport remains usable without overflow or browser exceptions',async()=>{
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(evidence,'canvas-mobile.png'),fullPage:true});const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(size.width<=size.viewport+2,JSON.stringify(size));assert.deepEqual(pageErrors,[]);
 });
 report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);if(page)await page.screenshot({path:join(evidence,'canvas-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1}
finally{report.finishedAt=new Date().toISOString();await browser?.close();await app?.close();await rm(directory,{recursive:true,force:true});await writeFile(join(evidence,'canvas-e2e.json'),JSON.stringify(report,null,2));}
