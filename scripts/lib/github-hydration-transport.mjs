import fs from 'node:fs/promises';
import path from 'node:path';

/** Small cross-process coordinator: at most the caller's two workers use this. */
export function createHydrationTransport(directory){
 const file=path.join(directory,'transport.json'),lockFile=path.join(directory,'transport.lock');
 async function transaction(update){await fs.mkdir(directory,{recursive:true});let lock;const deadline=Date.now()+10000;while(!lock){try{lock=await fs.open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>=deadline)throw Error('Shared hydration transport lock is busy; inspect owner before recovery');await new Promise(r=>setTimeout(r,50));}}
  try{let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={requests:0,starts:0,notBefore:0,lastRequestAt:0};}if(!Number.isFinite(state.notBefore)||!Number.isFinite(state.lastRequestAt))throw Error('Invalid shared source transport state');const result=update(state);const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n');await fs.rename(temp,file);return{state,result};}finally{await lock.close();await fs.unlink(lockFile);}
 }
 return{
  async reserve({spacing,now=Date.now()}){return transaction(state=>{if(state.notBefore>now)return{blocked:true,at:state.notBefore};const at=Math.max(now,state.lastRequestAt+spacing);state.lastRequestAt=at;state.starts=(state.starts||0)+1;return{blocked:false,at};});},
  async observed({notBefore=0,remaining=null,resetAt=null,count=true}){return transaction(state=>{if(count)state.requests++;state.notBefore=Math.max(state.notBefore,notBefore);if(Number.isSafeInteger(remaining)){state.remaining=remaining;state.resetAt=resetAt;}return null;});},
 };
}
