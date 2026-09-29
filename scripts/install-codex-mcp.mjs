// Explicit user-scope installation only; not run by app startup or dependency install.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexRPC } from './codex-rpc.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const entry=fileURLToPath(new URL('../src/mcp.mjs',import.meta.url));
const client=codexRPC(root);
try{
  await client.request('initialize',{clientInfo:{name:'glasses-mcp-installer',version:'0.2.0'},capabilities:{experimentalApi:true}});client.notify('initialized');
  let configuration=await client.request('config/read',{cwd:root,includeLayers:true});
  const userLayer=()=>configuration.layers?.find(layer=>layer.name?.type==='user'&&!layer.name.profile);
  const server=userLayer()?.config?.mcp_servers?.glasses_local;
  // Effective config may contain a project-only entry. Inspect the actual user
  // layer before deciding the user-scope installation already exists.
  if(server){
    if(server.command!==process.execPath||server.args?.[0]!==entry)throw new Error('The user-level glasses_local entry refers to another or incomplete installation. Review it before replacing it.');
    console.log('Existing user-level Glasses registration matches; preserving its settings.');
  }else{
    const added=spawnSync('codex',['mcp','add','glasses_local','--env','GLASSES_URL=http://127.0.0.1:4317','--',process.execPath,entry],{cwd:root,encoding:'utf8',windowsHide:true});
    if(added.error)throw added.error;if(added.status!==0)throw new Error(added.stderr);console.log(added.stdout.trim());
    configuration=await client.request('config/read',{cwd:root,includeLayers:true});
  }
  if(!userLayer()?.version)throw new Error('Cannot verify the user configuration version; refusing an unguarded configuration update.');
  await client.request('config/batchWrite',{expectedVersion:userLayer().version,edits:[
    {keyPath:'mcp_servers.glasses_local.startup_timeout_sec',value:20,mergeStrategy:'upsert'},
    {keyPath:'mcp_servers.glasses_local.tool_timeout_sec',value:180,mergeStrategy:'upsert'}
  ]});
  const checked=spawnSync('codex',['mcp','get','glasses_local','--json'],{cwd:root,encoding:'utf8',windowsHide:true});
  if(checked.status!==0)throw new Error(checked.stderr);console.log(checked.stdout.trim());
  console.log('Glasses is registered in the user Codex MCP configuration. Keep the Glasses app running. An already-open desktop chat may need Codex to be reopened to load the new tools. Project trust and approval settings were not changed.');
}finally{client.close()}
