// Source text only. No DOM construction or execution of fetched markup.
export function publicPageMetadata(body){
  if(typeof body!=='string')return null;
  const clean=value=>String(value||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(?:quot|#34);/gi,'"').replace(/&(?:apos|#39);/gi,"'").replace(/&amp;/gi,'&').replace(/&(?:nbsp|#160);/gi,' ').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim();
  const metas=new Map();for(const tag of body.match(/<meta\b[^>]*>/gi)||[]){const attrs=new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),m[2]??m[3]]));const name=(attrs.get('name')||attrs.get('property')||'').toLowerCase();if(name&&!metas.has(name))metas.set(name,attrs.get('content'));}
  const name=clean(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||metas.get('og:title')).slice(0,200);
  const description=clean(metas.get('description')||metas.get('og:description')).slice(0,1200);
  if(!name||/^(?:just a moment|access denied|attention required|sign in|page not found|404(?:\s|$))/i.test(name)||/[<>]/.test(name+description))return null;
  return{name,description:description||'Public documentation or reference page. Inspect the original source; no reusable-code licence is established.'};
}
