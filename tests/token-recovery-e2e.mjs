import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../src/server.mjs';

const directory=await mkdtemp(join(tmpdir(),'glasses-token-recovery-'));
const evidence=resolve(process.env.GLASSES_EVIDENCE_DIR||'evidence/component-reuse-trials-2026-09-29/token-recovery');
await mkdir(evidence,{recursive:true});
const report={startedAt:new Date().toISOString(),result:'RUNNING',checks:[],limitations:['Actual isolated backend/database restarts and a real browser/MCP client; no main service restart, paid providers or live data changes.','Session token values and request headers are never retained in evidence.']};
let app,browser,page,client,token,workspace;
const pageErrors=[],requests=[],browserSessions=[],browserAuthFailures=[];
const options={dataDir:directory,autoScout:false,seed:false};
const fixtureSource='export default function Fixture(){return <h1>Token recovery fixture</h1>}';
async function start(port=0){app=await startServer({...options,port});app.server.on('request',(req,res)=>res.once('finish',()=>requests.push({method:req.method,path:new URL(req.url,app.url).pathname,status:res.statusCode})));return app;}
async function session(){token=(await(await fetch(app.url+'/api/session',{cache:'no-store'})).json()).token;}
async function api(path,method='GET',body){const response=await fetch(app.url+path,{method,headers:{'Content-Type':'application/json','X-Glasses-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
async function until(fn){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(50)}throw new Error('Expected state did not arrive');}
async function check(name,fn){const began=Date.now();try{await fn();report.checks.push({name,result:'PASS',ms:Date.now()-began});console.log('PASS '+name)}catch(error){report.checks.push({name,result:'FAIL',error:error.message});throw error;}}
try{
  await start();await session();workspace=await api('/api/workspaces','POST',{title:'Saved before restart',source:fixtureSource});
  client=new Client({name:'glasses-token-recovery-test',version:'0.1.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.mjs')],env:{...process.env,GLASSES_URL:app.url},stderr:'pipe'}));
  assert.ok(!(await client.callTool({name:'glasses_status',arguments:{}})).isError);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1000}});report.browserVersion=browser.version();
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('response',response=>{const path=new URL(response.url()).pathname;if(path==='/api/session')browserSessions.push(response.status());if(response.status()===401)browserAuthFailures.push(path);});
  await page.goto(app.url+'/#workbench/'+workspace.id);
  await page.frameLocator('iframe[title="Isolated component preview"]').getByRole('heading',{name:'Token recovery fixture'}).waitFor();
  await page.evaluate(()=>{window.__tokenRecoveryDocument='same-mounted-page';});
  await check('A mounted browser recovers after an actual restart and saves its unsaved draft once',async()=>{
    await page.getByRole('textbox',{name:'Workspace name',exact:true}).fill('Draft survives token rotation');
    const draftSource='export default function Fixture(){return <h1>Unsaved source survives restart</h1>}';
    await page.getByRole('button',{name:'TSX',exact:true}).click();await page.getByRole('textbox',{name:'Component TSX source',exact:true}).fill(draftSource);
    await page.getByRole('button',{name:'Canvas',exact:true}).click();await page.frameLocator('iframe[title="Isolated component preview"]').getByRole('heading',{name:'Unsaved source survives restart'}).waitFor();
    assert.equal(browserSessions.length,1,'Initial concurrent UI reads share one session fetch');
    const oldToken=token,port=app.port;await app.close();app=null;await start(port);await session();assert.notEqual(token,oldToken);
    const rejected=await fetch(app.url+'/api/status',{headers:{'X-Glasses-Token':oldToken}});assert.equal(rejected.status,401,'Server still rejects the old token');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('button',{name:'All changes saved',exact:true}).waitFor();
    const saved=await api('/api/workspaces/'+workspace.id);assert.equal(saved.title,'Draft survives token rotation');assert.equal(saved.source,draftSource);assert.equal(saved.version,2,'Rejected mutation did not execute before retry');
    assert.equal(await page.evaluate(()=>window.__tokenRecoveryDocument),'same-mounted-page');assert.equal(browserSessions.length,2);assert.ok(browserAuthFailures.length>=1);
    assert.equal(await page.getByRole('textbox',{name:'Workspace name',exact:true}).inputValue(),saved.title);assert.equal(await page.getByRole('alert').count(),0);
    await page.screenshot({path:join(evidence,'draft-saved-after-restart.png'),fullPage:true});
  });
  await check('The same MCP client recovers its cached session after restart without reconnecting',async()=>{
    const before=requests.filter(item=>item.path==='/api/session').length;
    const result=await client.callTool({name:'glasses_get_workspace',arguments:{id:workspace.id}});assert.ok(!result.isError,result.content[0].text);
    const saved=JSON.parse(result.content[0].text);assert.equal(saved.version,2);assert.equal(saved.title,'Draft survives token rotation');
    assert.equal(requests.filter(item=>item.path==='/api/session').length-before,1);
    const calls=requests.filter(item=>item.path==='/api/workspaces/'+workspace.id&&item.method==='GET');assert.ok(calls.some(item=>item.status===401));
  });
  await check('A concurrent agent edit still yields conflict after token recovery and preserves the browser draft',async()=>{
    await page.getByRole('textbox',{name:'Workspace name',exact:true}).fill('Keep this conflicting local draft');
    const port=app.port;await app.close();app=null;await start(port);await session();
    const remote=await api('/api/workspaces/'+workspace.id,'PUT',{title:'Changed by agent',expectedVersion:2});assert.equal(remote.version,3);
    await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('button',{name:'Download my draft',exact:true}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'Workspace name',exact:true}).inputValue(),'Keep this conflicting local draft');
    const saved=await api('/api/workspaces/'+workspace.id);assert.equal(saved.version,3);assert.equal(saved.title,'Changed by agent');
    assert.equal(await page.evaluate(()=>window.__tokenRecoveryDocument),'same-mounted-page');assert.equal(browserSessions.length,3);
    const foreign=await fetch(app.url+'/api/status',{headers:{'X-Glasses-Token':token,Origin:'https://foreign.example.org'}});assert.equal(foreign.status,403);
    assert.deepEqual(pageErrors,[]);assert.deepEqual(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)})),{local:[],session:[]});
    await page.screenshot({path:join(evidence,'conflict-draft-preserved.png'),fullPage:true});
  });
  report.result='PASS';report.browserSessions=browserSessions.length;report.browserAuthRejections=browserAuthFailures.length;report.requests=requests;
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});}
finally{report.finishedAt=new Date().toISOString();await client?.close();await browser?.close();await app?.close();await rm(directory,{recursive:true,force:true});await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');}
