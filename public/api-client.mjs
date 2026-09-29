const TOKEN_REJECTION = 'Missing or invalid X-Glasses-Token; obtain /api/session on loopback';

// A backend restart rotates its session token. Recover that specific rejection
// in place: no navigation, browser storage, or replay of other failed actions.
export function createApiClient({baseUrl,fetchImpl=globalThis.fetch,sessionTimeoutMs=5000,requestTimeoutMs}={}) {
  let token,sessionRequest;
  const endpoint=path=>{
    if(typeof path!=='string'||!path.startsWith('/api/'))throw new Error('Glasses API paths must be local /api/ routes.');
    return baseUrl?new URL(path,baseUrl).href:path;
  };
  const signalFor=(signal,timeoutMs)=>timeoutMs?signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs):signal;
  async function readJson(response,fallback) {
    let data;
    try{data=await response.json();}catch{throw Object.assign(new Error(fallback),{status:response.status});}
    return data;
  }
  async function session(rejectedToken) {
    if(token&&token!==rejectedToken)return token;
    // Concurrent stale requests share one refresh. A late rejection of the old
    // token reuses the newer token rather than invalidating it again.
    if(!sessionRequest)sessionRequest=(async()=>{
      const response=await fetchImpl(endpoint('/api/session'),{cache:'no-store',credentials:'same-origin',redirect:'error',signal:signalFor(undefined,sessionTimeoutMs)});
      const data=await readJson(response,'Cannot obtain a session from the local Glasses server.');
      if(!response.ok)throw Object.assign(new Error(typeof data?.error==='string'?data.error:'Cannot obtain a session from the local Glasses server.'),{status:response.status});
      if(typeof data?.token!=='string'||!data.token)throw new Error('The local Glasses server returned an invalid session.');
      token=data.token;return token;
    })().finally(()=>{sessionRequest=undefined;});
    return sessionRequest;
  }
  return async function api(path,options={}) {
    const target=endpoint(path);
    let requestToken=await session();
    for(let attempt=0;attempt<2;attempt++) {
      const headers=new Headers(options.headers);
      if(!headers.has('Content-Type'))headers.set('Content-Type','application/json');
      headers.set('X-Glasses-Token',requestToken);
      const response=await fetchImpl(target,{...options,headers,credentials:'same-origin',redirect:'error',signal:signalFor(options.signal,requestTimeoutMs)});
      const data=await readJson(response,`The Glasses request returned an invalid response (HTTP ${response.status}).`);
      // The server rejects this token before routing or parsing the mutation.
      // Provider authentication failures, conflicts and network errors cannot
      // establish that guarantee and must never trigger an automatic replay.
      if(attempt===0&&response.status===401&&data?.error===TOKEN_REJECTION) {
        requestToken=await session(requestToken);
        continue;
      }
      if(!response.ok)throw Object.assign(new Error(typeof data?.error==='string'?data.error:'The request could not be completed.'),{status:response.status});
      return data;
    }
  };
}
