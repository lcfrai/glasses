import React,{useCallback,useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';

export function CatalogueRefresh({request,active,onChanged}) {
  const [state,setState]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const sequence=useRef(0),mutating=useRef(false);
  const load=useCallback(async()=>{
    if(mutating.current)return;
    const current=++sequence.current;
    try{const value=await request('/api/catalogue-refresh');if(current===sequence.current){setState(value);setError('');}}
    catch(e){if(current===sequence.current)setError(e.message);}
  },[request]);
  useEffect(()=>{
    if(!active)return;
    load();const timer=setInterval(load,5000);
    return()=>{sequence.current++;clearInterval(timer);};
  },[active,load]);
  async function act(method,body){
    if(mutating.current)return;
    mutating.current=true;sequence.current++;setBusy(method);setError('');setNotice('');
    try{
      const value=await request('/api/catalogue-refresh',{method,body:JSON.stringify(body)});
      setState(value);
      if(method==='POST'){
        setNotice(value.run?`${value.run.updated} sources refreshed; ${value.run.errors?.length||0} reported issues. See run history for evidence.`:'No sources are due for refresh.');
        await onChanged?.();
      }else setNotice('Catalogue refresh settings saved.');
    }catch(e){setError(e.message);}
    finally{mutating.current=false;setBusy('');}
  }
  const disabled=!!busy||!!state?.running;
  const ages=[...new Set([24,72,168,720,state?.settings?.minAgeHours].filter(Number.isFinite))].sort((a,b)=>a-b);
  return <section className="ai-research-panel" aria-label="Catalogue freshness" aria-busy={!!busy}>
    <div className="section-heading"><h3>Keep the catalogue current</h3></div>
    <p>Refresh existing GitHub stars, descriptions and source evidence. Changed evidence can be reclassified within your AI settings; human corrections stay separate.</p>
    {error&&<div className="intelligence-error" role="alert"><p>{error}</p><button className="button" type="button" disabled={!!busy} onClick={load}>Check refresh status</button></div>}
    {notice&&<p role="status">{notice}</p>}
    {!state&&!error&&<p className="small-copy" role="status">Loading catalogue freshness…</p>}
    {state&&<>
      <p>{state.due} sources due. Last batch: {state.lastRun?`${state.lastRun.updated} updated, ${state.lastRun.status}`:'Not run yet'}.</p>
      {state.running&&<p role="status">A source refresh is running. Its progress is retained in run history.</p>}
      <div className="plan-actions">
        <label className="field">Scheduled refresh<select aria-label="Scheduled catalogue refresh" disabled={disabled} value={state.settings.enabled?'enabled':'paused'} onChange={event=>act('PUT',{enabled:event.target.value==='enabled'})}><option value="enabled">Enabled</option><option value="paused">Paused</option></select></label>
        <label className="field">Recheck after<select aria-label="Catalogue refresh age" disabled={disabled} value={state.settings.minAgeHours} onChange={event=>act('PUT',{minAgeHours:Number(event.target.value)})}>{ages.map(hours=><option key={hours} value={hours}>{hours%24===0?`${hours/24} ${hours===24?'day':'days'}`:`${hours} hours`}</option>)}</select></label>
        <button className="button" disabled={disabled||!state.due} onClick={()=>act('POST',{})}><RefreshCw size={15} className={busy==='POST'?'spin':''}/>{busy==='POST'?'Refreshing sources…':`Refresh next ${state.settings.batchSize}`}</button>
      </div>
      {state.lastRun?.errors?.length>0&&<details><summary>Last refresh issues ({state.lastRun.errors.length})</summary><ul className="job-errors">{state.lastRun.errors.map((message,index)=><li key={index}>{String(message)}</li>)}</ul></details>}
      <p className="small-copy">Oldest due sources run in batches of {state.settings.batchSize} alongside the local discovery schedule, while Glasses is open. Pausing the schedule still allows a manual refresh. Public catalogue updates go through a separate reviewed publication.</p>
    </>}
  </section>;
}
