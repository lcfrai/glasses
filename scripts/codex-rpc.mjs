import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Uses the installed Codex protocol. No model turns, policy overrides or approval responses.
export function codexRPC(cwd) {
  const child=spawn('codex',['app-server','--stdio'],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let sequence=0;const pending=new Map();const diagnostics=[];
  const rejectAll=error=>{for(const value of pending.values()){clearTimeout(value.timer);value.reject(error)}pending.clear()};
  child.on('error',rejectAll);child.on('exit',code=>rejectAll(new Error('Codex app-server exited: '+code)));
  child.stderr.on('data',()=>{});
  createInterface({input:child.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line)}catch{return}
    if(message.id&&message.method){
      diagnostics.push({method:message.method,note:'Server request not automatically approved by diagnostic.'});
      child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Diagnostic does not answer approval or user-input requests'}})+'\n');return;
    }
    if(message.id&&pending.has(message.id)){const value=pending.get(message.id);pending.delete(message.id);clearTimeout(value.timer);message.error?value.reject(new Error(JSON.stringify(message.error))):value.resolve(message.result)}
  });
  return {
    diagnostics,
    request(method,params={},timeout=60000){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex request timed out: '+method))},timeout);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n')})},
    notify(method,params){child.stdin.write(JSON.stringify({method,...(params?{params}:{})})+'\n')},
    close(){rejectAll(new Error('Diagnostic closed'));child.stdin.end();child.kill()}
  };
}
