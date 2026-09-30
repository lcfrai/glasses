import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowUpRight, Check, Download, LoaderCircle, RefreshCw, X} from 'lucide-react';

export function SharedCatalogueSetup({request, open, onOpenChange, onImported}) {
  const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const importedRef=useRef(onImported);
  importedRef.current=onImported;
  const load=useCallback(async()=>{const result=await request('/api/onboarding');setState(result.onboarding);return result.onboarding;},[request]);
  useEffect(()=>{let active=true;request('/api/onboarding').then(result=>{if(!active)return;setState(result.onboarding);if(['pending','failed','importing'].includes(result.onboarding.status))onOpenChange(true);}).catch(reason=>{if(active)setError(reason.message);});return()=>{active=false;};},[request,onOpenChange]);
  useEffect(()=>{if(state?.status!=='importing'||busy)return;let active=true;const timer=setInterval(()=>request('/api/onboarding').then(result=>{if(!active)return;setState(result.onboarding);if(result.onboarding.status==='ready')importedRef.current?.();}).catch(reason=>{if(active)setError(reason.message);}),1500);return()=>{active=false;clearInterval(timer);};},[state?.status,busy,request]);
  async function choose(choice){
    setBusy(true);setError('');
    try{
      const refresh=choice==='import'&&state?.choice!=='pending';
      const result=await request(refresh?'/api/onboarding/import':'/api/onboarding',{method:'POST',body:JSON.stringify(refresh?{approved:true}:{choice})});
      setState(result.onboarding);
      if(choice==='decline')onOpenChange(false);
      else if(result.onboarding.status==='ready')await importedRef.current?.();
    }catch(reason){setError(reason.message);await load().catch(()=>{});}
    finally{setBusy(false);}
  }
  if(!open)return null;
  const importing=busy||state?.status==='importing';
  const success=state?.lastSuccess;
  const title=state?.status==='ready'?'Your shared catalogue is ready.':state?.status==='declined'?'Add the shared catalogue whenever you like.':state?.status==='failed'?'The shared catalogue could not be imported.':'Start with the shared catalogue?';
  return <section className="shared-catalogue-setup" aria-labelledby="shared-catalogue-title" aria-busy={importing}>
    <div className="shared-catalogue-copy"><h2 id="shared-catalogue-title">{importing?'Importing the shared catalogue…':title}</h2>
      <p>Choose whether to fetch the latest public catalogue from <a href="https://lcfr.ai/glasses/catalogue.json" target="_blank" rel="noreferrer">lcfr.ai <ArrowUpRight size={12} aria-hidden="true"/></a>. It adds source metadata and shared assessments to this workspace. Your local notes and work stay yours.</p>
      <p className="shared-catalogue-detail">No model calls, source-code downloads or automatic updates. You can skip this and research your own sources.</p>
      {success&&<p className="shared-catalogue-receipt"><Check size={14} aria-hidden="true"/>{Number(success.snapshot?.counts?.total||0).toLocaleString()} shared records · Snapshot {success.snapshot?.generatedAt?new Date(success.snapshot.generatedAt).toLocaleDateString(): 'recorded'} · Imported {success.completedAt?new Date(success.completedAt).toLocaleString():'successfully'}</p>}
      {(error||state?.status==='failed')&&<p className="shared-catalogue-error" role="alert">{error||state.lastAttempt?.error||'The import did not finish. Your existing catalogue is available.'}</p>}
    </div>
    <div className="shared-catalogue-actions">
      {!state?<button className="button" disabled={busy} onClick={()=>{setError('');load().catch(reason=>setError(reason.message));}}><RefreshCw size={14} aria-hidden="true"/>Retry setup status</button>:<>
        <button className="button primary" disabled={importing} onClick={()=>choose('import')}>{importing?<LoaderCircle size={15} className="spin" aria-hidden="true"/>:<Download size={15} aria-hidden="true"/>}{importing?'Importing…':state.status==='pending'?'Yes, import catalogue':state.status==='failed'?'Retry catalogue import':'Import latest catalogue'}</button>
        {state.status==='pending'&&<button className="button" disabled={importing} onClick={()=>choose('decline')}>No thanks, start my own</button>}
      </>}
      {state?.status!=='pending'&&<button className="button subtle" onClick={()=>onOpenChange(false)}><X size={14} aria-hidden="true"/>Close catalogue setup</button>}
    </div>
  </section>;
}
