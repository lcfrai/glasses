import React,{useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,Check,FileCheck2,Layers2,LoaderCircle,RefreshCw} from 'lucide-react';

const reviewId=()=>window.location.hash.match(/^#reviews\/([a-zA-Z0-9-]{1,100})$/)?.[1]||'';
function externalUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
function date(value){return value?new Date(value).toLocaleString():'Not recorded';}
function SourceLinks({option}){
 return <div className="design-review-sources"><strong>Source evidence</strong>{option.sourceRefs?.length?<ul>{option.sourceRefs.map((source,index)=><li key={source.url+index}>{externalUrl(source.url)?<a href={externalUrl(source.url)} target="_blank" rel="noopener noreferrer">{source.label||source.url}<ArrowUpRight size={12} aria-hidden="true"/></a>:<span>Unsupported source URL</span>}{source.sha256&&<code>SHA-256 {source.sha256}</code>}</li>)}</ul>:<p>No source evidence attached.</p>}{option.capabilityIds?.length>0&&<p>Glasses candidates: {option.capabilityIds.map(id=><code key={id}>{id} </code>)}</p>}</div>;
}
export function DesignReviews({request}){
 const [id,setId]=useState(reviewId),[items,setItems]=useState([]),[review,setReview]=useState(null),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0);
 const [selectedId,setSelectedId]=useState(''),[parameters,setParameters]=useState({}),[notes,setNotes]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[conflict,setConflict]=useState(false);
 const currentId=useRef(id);currentId.current=id;
 const accept=useCallback(value=>{setReview(value);setSelectedId(value.decision?.optionId||'');setNotes(value.decision?.notes||'');const selected=value.options.find(option=>option.id===value.decision?.optionId);setParameters({...selected?.parameters,...value.decision?.parameters});setConflict(false);},[]);
 useEffect(()=>{const changed=()=>setId(reviewId());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 useEffect(()=>{
  const controller=new AbortController();let live=true;setLoading(true);setError('');setNotice('');setConflict(false);setReview(null);
  request(id?'/api/design-reviews/'+encodeURIComponent(id):'/api/design-reviews',{signal:controller.signal}).then(result=>{if(!live)return;if(id)accept(result.review);else setItems(result.items||[]);}).catch(reason=>{if(live&&reason.name!=='AbortError')setError(reason.message);}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;controller.abort();};
 },[id,attempt,request,accept]);
 const selected=review?.options.find(option=>option.id===selectedId);
 function prepare(option){setSelectedId(option.id);setParameters({...option.parameters,...(review.decision?.optionId===option.id?review.decision.parameters:{})});setNotes(review.decision?.optionId===option.id?review.decision.notes||'':'');setNotice('');}
 async function save(event,clear=false){
  event?.preventDefault();if(busy||conflict||!review||(!clear&&!selected))return;
  setError('');setNotice('');const values={};
  for(const [key,initial] of Object.entries(clear?{}:selected?.parameters||{})){
   const value=parameters[key]??initial;
   if(typeof initial==='number'){
    if(value===''||!Number.isFinite(Number(value))||Math.abs(Number(value))>1e9){setError('Enter a finite number between -1000000000 and 1000000000 for '+key+'.');return;}
    values[key]=Number(value);
   }else values[key]=value;
  }
  setBusy(true);
  try{const result=await request('/api/design-reviews/'+encodeURIComponent(review.id)+'/decision',{method:'POST',body:JSON.stringify({expectedVersion:review.version,optionId:clear?null:selected.id,...(clear?{}:{parameters:values,notes})})});if(currentId.current!==review.id)return;accept(result.review);setNotice(clear?'Choice cleared. The review is open again.':'Choice saved. Your agent can read this decision and its settings.');}
  catch(reason){if(currentId.current!==review.id)return;setError(reason.status===409?'This review changed elsewhere. Reload the latest review before choosing again. Your unsaved notes remain below until you reload.':reason.message);setConflict(reason.status===409);}
  finally{setBusy(false);}
 }
 return <main className="design-reviews-page" aria-label="Design reviews">
  <div className="page-heading"><div><h1>Design reviews</h1><p>Compare saved options, inspect their sources, then record an explicit choice for your agent.</p></div><button className="button" disabled={busy||loading} onClick={()=>setAttempt(value=>value+1)}><RefreshCw size={15} aria-hidden="true"/>{conflict?'Reload latest review':'Refresh reviews'}</button></div>
  {id&&<a className="design-review-back" href="#reviews"><ArrowLeft size={15} aria-hidden="true"/>All reviews</a>}
  {error&&<div className="design-review-alert" role="alert"><p>{error}</p>{!conflict&&<button className="button" disabled={busy||loading} onClick={()=>setAttempt(value=>value+1)}>Retry loading</button>}</div>}
  {notice&&<p className="design-review-notice" role="status"><Check size={15} aria-hidden="true"/>{notice}</p>}
  {loading?<div className="design-review-loading" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true"/>Loading reviews…</div>:!id?<>
   {!items.length&&!error?<div className="design-review-empty"><FileCheck2 size={30} aria-hidden="true"/><h2>No saved design reviews yet.</h2><p>Your agent or a connected comparison gallery can add a brief and options here. Viewing a preview never records a choice automatically.</p></div>:<ul className="design-review-list">{items.map(item=><li key={item.id}><a href={'#reviews/'+encodeURIComponent(item.id)}><div><h2>{item.title}</h2><span className={'design-review-state '+(item.status==='decided'?'is-decided':'')}>{item.status==='decided'?'Choice recorded':'Awaiting your choice'}</span></div><p>{item.brief}</p><small>{item.options?.length??item.optionCount??0} options · Updated {date(item.updatedAt)}</small><span className="design-review-open">Review options <ArrowUpRight size={14} aria-hidden="true"/></span></a></li>)}</ul>}
  </>:review&&<>
   <section className="design-review-brief" aria-labelledby="design-review-title"><div><h2 id="design-review-title">{review.title}</h2><span className="design-review-state">{review.status==='decided'?'Choice recorded':'Awaiting your choice'} · Version {review.version}</span></div><p>{review.brief}</p><small>Preview links open separately. Selecting an option below prepares a draft; only the Choose button saves it.</small></section>
   {review.decision&&<section className="design-review-decision" aria-label="Recorded decision"><h3><Check size={18} aria-hidden="true"/>Recorded choice: {review.decision.optionSnapshot?.label||review.options.find(option=>option.id===review.decision.optionId)?.label||review.decision.optionId}</h3><p>{review.decision.notes||'No decision notes.'}</p><dl>{Object.entries(review.decision.parameters||{}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl><small>Saved {date(review.decision.decidedAt)} against version {review.decision.reviewVersion}</small><button type="button" className="button" disabled={busy||conflict} onClick={event=>save(event,true)}>Clear recorded choice</button></section>}
   <div className="design-review-options">{review.options.map(option=><article key={option.id} className={'design-review-option '+(selectedId===option.id?'is-selected':'')} aria-label={option.label}>
    <h3>{option.label}</h3>{option.description&&<p>{option.description}</p>}<div className="design-review-links">{externalUrl(option.previewUrl)&&<a className="button" href={externalUrl(option.previewUrl)} target="_blank" rel="noopener noreferrer">Open preview <ArrowUpRight size={14} aria-hidden="true"/></a>}{option.workspaceId&&<a className="button" href={'#workbench/'+encodeURIComponent(option.workspaceId)}><Layers2 size={14} aria-hidden="true"/>Open workspace</a>}</div><SourceLinks option={option}/>
    <button type="button" className="button" aria-pressed={selectedId===option.id} disabled={busy||conflict} onClick={()=>prepare(option)}>{selectedId===option.id?'Editing this option':'Review this option'}{selectedId===option.id&&<Check size={14} aria-hidden="true"/>}</button>
   </article>)}</div>
   {selected&&<form className="design-review-form" onSubmit={save} aria-label="Record design choice"><h3>Choose {selected.label}</h3><p>Adjust the proposed settings and explain your choice. Saving records a decision; it does not deploy or edit source.</p><div className="design-review-parameters">{Object.entries(selected.parameters||{}).map(([key,initial])=><label className="field" key={key}>{key}{typeof initial==='boolean'?<input type="checkbox" checked={Boolean(parameters[key])} onChange={event=>setParameters(previous=>({...previous,[key]:event.target.checked}))} disabled={busy||conflict}/>:initial===null?<span className="design-review-null">Not set</span>:<input type={typeof initial==='number'?'number':'text'} step={typeof initial==='number'?'any':undefined} maxLength={typeof initial==='string'?500:undefined} value={parameters[key]??''} onChange={event=>setParameters(previous=>({...previous,[key]:event.target.value}))} disabled={busy||conflict}/>}</label>)}</div><label className="field">Decision notes<textarea aria-label="Decision notes" rows={4} maxLength={4000} value={notes} onChange={event=>setNotes(event.target.value)} disabled={busy} placeholder="What works, what to preserve, or what needs refinement…"/></label><button className="button primary" type="submit" disabled={busy||conflict}>{busy?<LoaderCircle size={15} className="spin" aria-hidden="true"/>:<Check size={15} aria-hidden="true"/>}Choose {selected.label}</button></form>}
   {review.decisionHistory?.length>0&&<details className="design-review-history"><summary>Decision history ({review.decisionHistory.length})</summary><ol>{review.decisionHistory.slice().reverse().map((entry,index)=><li key={index}><strong>{entry.decision?.optionSnapshot?.label||entry.decision?.optionId||'Previous choice'}</strong><span>{entry.action} · {date(entry.at)}</span>{entry.decision?.notes&&<p>{entry.decision.notes}</p>}</li>)}</ol></details>}
  </>}
 </main>;
}
