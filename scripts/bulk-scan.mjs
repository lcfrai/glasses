import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const usage=`Glasses public discovery — no model classification or publication.
  node scripts/bulk-scan.mjs --status
  node scripts/bulk-scan.mjs --plan=plan.json
  node scripts/bulk-scan.mjs --run [--plan=plan.json] [--wait] [--batches=3]
  node scripts/bulk-scan.mjs --resume=PLAN_ID [--wait] [--retry-failed]
  node scripts/bulk-scan.mjs --status=PLAN_ID | --cancel=PLAN_ID
Options: --url=http://127.0.0.1:4317 --max-steps=30 --timeout=180
Plans and cursors persist in the local service. Each run is capped; --batches
only continues normal batch-limit pauses, never rate limits or configured caps.`;
export function bulkScanOptions(args){
 const value={action:'status',wait:false,batches:1,maxSteps:30,timeout:180};let actions=0;
 for(const arg of args){
  if(arg==='--help'||arg==='-h')value.help=true;
  else if(arg==='--run'){value.action='run';actions++;}
  else if(arg==='--wait')value.wait=true;
  else if(arg==='--retry-failed')value.retryFailed=true;
  else if(arg==='--status'){value.action='status';actions++;}
  else if(arg.startsWith('--resume=')){value.action='resume';value.id=arg.slice(9);actions++;}
  else if(arg.startsWith('--cancel=')){value.action='cancel';value.id=arg.slice(9);actions++;}
  else if(arg.startsWith('--status=')){value.action='status';value.id=arg.slice(9);actions++;}
  else if(arg.startsWith('--plan=')){if(!arg.slice(7))throw Error('--plan requires a JSON file');value.plan=resolve(arg.slice(7));}
  else if(arg.startsWith('--url='))value.url=arg.slice(6);
  else if(arg.startsWith('--batches='))value.batches=Number(arg.slice(10));
  else if(arg.startsWith('--max-steps='))value.maxSteps=Number(arg.slice(12));
  else if(arg.startsWith('--timeout='))value.timeout=Number(arg.slice(10));
  else throw Error('Unknown option. Use --help.');
 }
 if(actions>1)throw Error('Choose one bulk scan action');
 if(value.id!==undefined&&!/^[a-zA-Z0-9-]{1,100}$/.test(value.id))throw Error('Invalid plan ID');
 for(const [field,min,max] of [['batches',1,20],['maxSteps',1,200],['timeout',1,1800]])if(!Number.isInteger(value[field])||value[field]<min||value[field]>max)throw Error(`${field} must be between ${min} and ${max}`);
 if(value.plan&&actions===0)value.action='create';
 if(value.plan&&!['run','create'].includes(value.action))throw Error('--plan is only used when creating a new scan');
 if(value.batches>1){if(!['run','resume'].includes(value.action))throw Error('--batches requires --run or --resume');value.wait=true;}
 return value;
}
export async function runBulkScan({options={},fetchImpl=fetch,output=process.stdout,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}){
 if(options.help){output.write(usage+'\n');return null;}
 const config={action:'status',wait:false,batches:1,maxSteps:30,timeout:180,...options},base=new URL(config.url||process.env.GLASSES_URL||'http://127.0.0.1:4317');
 if(!['http:','https:'].includes(base.protocol)||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('Bulk CLI connects only to a loopback Glasses service root URL');
 let token;async function api(path,{method='GET',body}={}){
  if(!token){const response=await fetchImpl(new URL('/api/session',base),{signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw Error('Could not obtain the local Glasses session');const session=await response.json();token=session.token;if(typeof token!=='string'||!token)throw Error('Local Glasses returned no session token');}
  const response=await fetchImpl(new URL(path,base),{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{...(token?{'X-Glasses-Token':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json().catch(()=>null);if(!response.ok)throw Error(value?.error||`Local service returned HTTP ${response.status}`);return value;
 }
 const show=value=>{output.write(JSON.stringify(value)+'\n');return value;};
 if(config.action==='status')return show(await api(config.id?'/api/bulk-scans/'+config.id:'/api/bulk-scans'));
 if(config.action==='cancel')return show(await api('/api/bulk-scans/'+config.id+'/cancel',{method:'POST',body:{}}));
 let id=config.id;
 if(['run','create'].includes(config.action)){
  let plan={};if(config.plan){if((await stat(config.plan)).size>256000)throw Error('Plan JSON exceeds 256 KB');plan=JSON.parse(await readFile(config.plan,'utf8'));}
  const created=await api('/api/bulk-scans',{method:'POST',body:plan});id=created.plan?.id;if(!id)throw Error('Service did not create a plan');show({created:created.plan});if(config.action==='create')return created;
 }
 const deadline=now()+config.timeout*1000;
 for(let batch=0;batch<config.batches;batch++){
  const started=await api('/api/bulk-scans/'+id+'/run',{method:'POST',body:{maxSteps:config.maxSteps,...config.retryFailed?{retryFailed:true}:{}}});show({batch:batch+1,...started});
  if(!config.wait)return started;
  let plan;while(now()<deadline){const response=await api('/api/bulk-scans/'+id);plan=response.plan;if(!plan)throw Error('Plan status unavailable');if(plan.status!=='running')break;await sleep(1000);}
  show({plan,resumeCommand:`node scripts/bulk-scan.mjs --resume=${id} --wait`});
  if(!plan||plan.status==='running'){show({note:'The wait deadline elapsed. The local scan may still be running; use --status or --cancel.',id});return{plan,timedOut:true};}
  if(plan.status!=='paused'||plan.reason!=='batch-limit'||now()>=deadline)return{plan};
 }
 return{plan:(await api('/api/bulk-scans/'+id)).plan};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)Promise.resolve().then(()=>runBulkScan({options:bulkScanOptions(process.argv.slice(2))})).catch(error=>{process.stderr.write('Bulk scan: '+error.message+'\n');process.exitCode=1;});
