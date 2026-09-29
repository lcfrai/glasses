export const SAMPLE_SOURCE = `import React, { useState } from 'react';
export default function Signal({label = 'Thinking clearly', accent = '#c3ff65', radius = 18, speed = 1, dark = true}) {
  const [active, setActive] = useState(true);
  return <div style={{minHeight: '100vh', display:'grid', placeItems:'center', background:dark?'#111514':'#f4f5ef', color:dark?'#f5f6ee':'#19221b', fontFamily:'system-ui'}}>
    <div style={{width:300, padding:32, border:'1px solid '+(dark?'#313b33':'#ccd5c9'), borderRadius:radius, background:dark?'#19201b':'#ffffff'}}>
      <div style={{display:'flex',gap:8,marginBottom:28}}>{Array.from({length:5},(_,i)=><span key={i} style={{width:10,height:10,borderRadius:'50%',background:accent,animation:active?'pulse '+(1.4/Math.max(.1,Number(speed)))+'s ease-in-out infinite':'none',animationDelay:i*.14+'s'}} />)}</div>
      <h2 style={{fontSize:23,fontWeight:500,margin:'0 0 9px'}}>{label}</h2>
      <p style={{fontSize:13,opacity:.55,lineHeight:1.6}}>An original Glasses sample. Adjust the properties, edit the source, and export your study.</p>
      <button onClick={()=>setActive(!active)} style={{marginTop:12,background:'transparent',color:'inherit',border:'1px solid currentColor',borderRadius:7,padding:'8px 14px',cursor:'pointer'}}>{active?'Pause motion':'Resume motion'}</button>
    </div>
  </div>;
}`;
export const SAMPLE_CSS = `* { box-sizing: border-box; } body { margin: 0; } @keyframes pulse { 0%, 100% { opacity: .25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-6px); } } @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`;

export function seedStore(store) {
  if (store.getSetting('seedVersion',0)>=1) return;
  // A downloaded shared pack or an earlier real import must outrank placeholders.
  // Keep this module browser-safe: SAMPLE_SOURCE is also imported by the UI.
  const existing=new Set(store.search().map(item=>item.url));
  const records=[
    ['React Bits','https://reactbits.dev/','Animated React components and micro interactions. Starting reference; no source or licence fetched.','component',['react','animation','micro interactions']],
    ['Evil Charts','https://evilcharts.com/','Chart components and visualisation inspiration. Starting reference; not a verified component.','component',['react','charts','data']],
    ['Obsidian UI','https://www.obsidianui.dev/','Interface components and design inspiration. Starting reference; needs live inspection.','component',['react','ui','design']],
    ['registry.directory','https://registry.directory/','Public discovery directory; the scout follows its current registry and component indexes.','reference',['registry','discovery','shadcn']],
    ['Shoogle','https://shoogle.dev/mcp','Existing MCP discovery tool for shadcn registries; comparison candidate.','solution',['mcp','components','discovery']],
    ['21st','https://21st.dev/mcp','Existing component search and preview service; comparison candidate.','solution',['react','mcp','components']],
    ['Paper','https://paper.design/','Existing editable design canvas; comparison candidate, service licence not assessed.','solution',['canvas','design','workbench']],
    ['IndieStack','https://github.com/Pattyboi101/indiestack','Candidate developer-tool catalogue. Prior research claim requires a live source check.','solution',['mcp','discovery','catalogue']],
    ['Coolify','https://github.com/coollabsio/coolify','Self-hosted application deployment platform; evaluate whole-solution fit before implementing a deployment system.','solution',['deployment','self-hosted','vercel','local']],
    ['Microsoft identity samples','https://github.com/Azure-Samples/ms-identity-javascript-react-tutorial','Starting reference for React authentication implementation examples. Confirm applicability and current upstream guidance.','pattern',['entra','identity','authentication','react']]
  ];
  for(const [name,url,description,kind,tags] of records) if(!existing.has(url))store.upsertCapability({name,url,description,kind,tags,provider:new URL(url).hostname,license:null,framework:tags.includes('react')?'React':null,origin:'seed',provenance:{sourceUrl:url,fetchedAt:null,note:'Curated starting reference; not fetched or validated by this installation.'}});
  if(!existing.has('glasses:sample/signal'))store.upsertCapability({name:'Signal — original workbench sample',url:'glasses:sample/signal',description:'Editable black-and-white thinking indicator with animated dots. Original sample for testing the workbench, not an externally discovered asset.',kind:'component',provider:'Glasses sample',tags:['sample','dots','thinking','loading','black','white','react'],license:'MIT',framework:'React',origin:'sample',provenance:{sourceUrl:'glasses:sample/signal',fetchedAt:null,note:'Original Glasses demonstration source. External source discovery is separate.'},previewSource:SAMPLE_SOURCE,previewCss:SAMPLE_CSS,previewProps:{label:'Thinking clearly',accent:'#c3ff65',radius:18,speed:1,dark:true}});
  store.setSetting('seedVersion',1);
}
