import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fetchPublic,validatePublicURL} from './discovery.mjs';

// Reuse an already signed-in gh client for bounded PUBLIC GET requests only.
// Credentials stay inside gh; missing CLI/auth falls back to ordinary HTTPS.
export function createPublicSourceFetcher({direct=fetchPublic,execute=promisify(execFile),useGithubCli=true}={}){
  let available=useGithubCli?null:false;const cache=new Map();
  async function cli(url,{signal}={}){
    signal?.throwIfAborted();
    if(available===null){try{await execute('gh',['--version'],{windowsHide:true,timeout:5000,maxBuffer:8192});available=true;}catch(error){if(error.code!=='ENOENT')throw new Error('GitHub CLI availability check failed');available=false;}}
    if(!available)return direct(url.href,{signal});
    try{
      const {stdout}=await execute('gh',['api','--hostname','github.com','--method','GET',url.pathname+url.search],{windowsHide:true,timeout:30000,maxBuffer:16*1024*1024,signal,env:{...process.env,GH_DEBUG:''}});
      return{url:url.href,body:stdout,contentType:'application/json',status:200,transport:'authenticated-gh-public-get',fetchedAt:new Date().toISOString()};
    }catch(error){
      signal?.throwIfAborted();const message=String(error.stderr||error.message||'');
      if(/not logged|gh auth login|GH_TOKEN environment/i.test(message)){available=false;return direct(url.href,{signal});}
      const status=message.match(/HTTP (\d{3})/)?.[1];throw new Error(status?`HTTP ${status} from api.github.com`:'Public GitHub source request failed');
    }
  }
  async function repository(repo,options){
    const key=repo.toLowerCase(),hit=cache.get(key);if(hit&&Date.now()-hit.at<600000)return hit.doc;
    const doc=await cli(new URL('https://api.github.com/repos/'+repo),options),data=JSON.parse(doc.body);
    if(data.private!==false||String(data.full_name).toLowerCase()!==key)throw new Error('Bulk discovery requires matching public repository metadata');
    if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(key,{at:Date.now(),doc});return doc;
  }
  return async(value,options={})=>{
    const url=validatePublicURL(value);if(url.hostname!=='api.github.com')return direct(url.href,options);
    if(url.pathname==='/search/repositories'){
      if([...url.searchParams.keys()].some(key=>!['q','sort','order','per_page','page'].includes(key))||/is:private|visibility:private/i.test(url.searchParams.get('q')||''))throw new Error('Only bounded public repository searches are supported');
      const q=url.searchParams.get('q')||'';if(!/\bis:public\b/.test(q))url.searchParams.set('q',q+' is:public');
      if(!q.trim()||q.length>500)throw new Error('Public repository query must contain 1–500 characters');
      for(const [key,min,max] of [['per_page',1,100],['page',1,100]]){const value=url.searchParams.get(key);if(value!==null&&(!/^\d+$/.test(value)||Number(value)<min||Number(value)>max))throw new Error('Public repository pagination is outside its bound');}
      if(url.searchParams.has('sort')&&!['stars','forks','help-wanted-issues','updated'].includes(url.searchParams.get('sort'))||url.searchParams.has('order')&&!['asc','desc'].includes(url.searchParams.get('order')))throw new Error('Unsupported public repository ordering');
      const doc=await cli(url,options),data=JSON.parse(doc.body);if(!Array.isArray(data.items)||data.items.some(item=>item.private!==false))throw new Error('Search returned non-public repository metadata');return doc;
    }
    const match=url.pathname.match(/^\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(\/(?:commits\/[^/]+|git\/trees\/[a-f0-9]{40}|readme|license))?$/);
    if(!match||[...url.searchParams.keys()].some(key=>!['ref','recursive'].includes(key)))throw new Error('Unsupported GitHub bulk-source endpoint');
    const metadata=await repository(match[1],options);return match[2]?cli(url,options):metadata;
  };
}
