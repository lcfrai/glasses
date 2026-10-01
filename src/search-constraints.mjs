// Pure, bounded source constraints shared by local search and hosted ranking.
// A source declaration is evidence for discovery, never a runtime test result.
import {detectFramework} from './framework.mjs';
const text=value=>typeof value==='string'?value.normalize('NFKC').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().slice(0,12000):'';
const positive=value=>text(value).replace(/\b(?:without|excluding|except|not|no)\s+([^,;.!?]+)/g,(_all,tail)=>tail.split(/\b(?:but|and|while|with|for|that|which)\b/).slice(1).join(' '));
// A CSS/bento/background grid is not a data table. Require a table/data-grid
// name or data operations, rather than generic layout rows and columns.
const dataTable=/\b(?:data[ -]?(?:tables?|grids?)|tables?)\b|\bgrids?\b.{0,70}\b(?:sorting|sortable|filtering|filterable|pagination|paginated|records|cell editing|row selection)\b|\b(?:sortable|filterable|paginated)\s+(?:data\s+)?grids?\b/;
const withoutDocumentationTables=value=>value.replace(/\btable\s+of\s+contents\b/g,'').replace(/\b(?:(?:addon\s*\/\s*)?framework(?:\s+(?:support|compatibility|comparison))?|(?:browser|dependency|package)\s+compatibility)\s+tables?\b/g,'');
export const isDataTableSource=value=>dataTable.test(withoutDocumentationTables(positive(value)));
const controls=[
 ['combobox',/\bcombo[ -]?box(?:es)?\b/],
 ['date-range',/\bdate[ -]?range(?:[ -]picker)?\b|\brange[ -]?calendar\b/],
 ['date-picker',/\bdate[ -]?picker\b/],
 ['multi-select',/\bmulti[ -]?select(?:ion)?\b/],
 ['split-pane',/\bsplit[ -]?(?:panes?|panels?)\b|\bresiz(?:able|ing)\s+(?:split\s+)?(?:panes?|panels?)\b/],
 ['file-upload',/\bfile[ -]?upload(?:er|ing)?\b|\bupload(?:ing)?\s+files?\b/],
 ['table',dataTable],
 ['tabs',/\btabs?\b/],['tree',/\btree[ -]?(?:view|select)\b/],
 ['tooltip',/\btooltips?\b/],['slider',/\bsliders?\b/],
 ['drawer',/\bdrawers?\b/],['calendar',/\bcalendars?\b/],
 ['chart',/\bcharts?\b/],['menu',/\b(?:dropdown|context)[ -]?menus?\b/],
];
export function searchConstraints(query='') {
 if(/^https?:\/\//i.test(String(query).trim()))return {frameworks:[],control:null};
 const value=positive(String(query).slice(0,1000).replace(/\b(React|Vue|Solid|Svelte)JS\b/gi,(_all,name)=>name.toLowerCase()+'js'));
 // Match only explicit names; a request for a solid table is not sufficient
 // unless Solid is capitalized, written SolidJS/solid-js or names a component.
 const tokens=value.match(/\b(?:react(?:js|\.js)?|vue(?:js|\.js|[23])?|svelte(?:js)?|angular|solid(?:js|\.js|-js)?|preact)\b/g)||[];
 if(/\bweb[ -]?components?\b|\bcustom[ -]elements?\b/.test(value))tokens.push('web-components');
 const frameworks=detectFramework({frameworks:tokens.filter(name=>name!=='solid'||/\bSolid\b|\bsolid(?:js|\.js|-js)\b|\bsolid\s+(?:ui|component)/.test(query))}).frameworks;
 return {frameworks,control:controls.find(([,pattern])=>pattern.test(value))?.[0]||null};
}
export function sourceConstraintFacts(row={}) {
 const details=row.details||{};
 const framework=detectFramework({framework:row.framework,frameworks:typeof row.framework==='string'?row.framework.split(/[/,|]/):[],tags:row.tags,description:row.description,dependencies:details.dependencies});
 const sourceText=withoutDocumentationTables(positive([row.name,row.description,details.overview,...details.features||[],...details.keywords||[],...(details.sections||[]).map(section=>section.title+' '+section.summary)].filter(Boolean).join(' ')));
 return {frameworks:framework.frameworks,frameworkEvidence:framework.evidence,controls:controls.filter(([,pattern])=>pattern.test(sourceText)).map(([name])=>name)};
}
export function constraintFit(request,facts,{component=true}={}) {
 // Native custom elements can be embedded across renderers, but that alone
 // does not prove a framework integration. Keep their source label while
 // treating an unproved React/Vue/etc integration as unknown, not conflicting.
 const framework=!component||!request.frameworks.length?'not-requested':!facts.frameworks.length?'unknown':facts.frameworks.some(name=>request.frameworks.includes(name))?'declared':facts.frameworks.every(name=>name==='Web Components')?'unknown':'different';
 const control=!component||!request.control?'not-requested':facts.controls.includes(request.control)?'source-mentioned':'unknown';
 return {framework,control};
}
export function constraintWeight(fit) {
 // Unknown is lower-confidence discovery, not proof of incompatibility.
 return (fit.framework==='declared'?1.6:fit.framework==='unknown'?.65:1)*(fit.control==='source-mentioned'?2.5:fit.control==='unknown'?.4:1);
}
export function constraintPriority(fit) {
 // Within an explicit framework request, a source-backed requested control
 // precedes an otherwise similar control whose framework is unknown. An
 // unrelated control/library does not gain that priority just from its stack.
 if(fit.framework==='not-requested')return 0;
 if(fit.control==='unknown')return 0;
 return fit.framework==='declared'?2:fit.framework==='unknown'?1:0;
}
const stop=new Set('a an and are as at be by can for from i in is it of on or the to use with my our your need want tool component app library framework'.split(' '));
const words=value=>new Set(text(value).match(/[\p{L}\p{N}]+/gu)?.filter(word=>word.length>2&&!stop.has(word))||[]);
export function sourceHighlights(query,row={}) {
 const details=row.details||{},wanted=words(query),constraints=searchConstraints(query),facts=sourceConstraintFacts(row);
 // Source text is selected, not synthesized. Setup/navigation cannot crowd
 // functional evidence out merely by appearing first in a retained README.
 const entries=[...details.features||[],...(details.sections||[]).map(section=>section.title+': '+section.summary),...details.agentUsage?.triggers||[],details.overview,...details.keywords||[]].filter(value=>typeof value==='string'&&value.trim()).map((value,index)=>{
  const tokens=words(value);let score=[...wanted].filter(word=>tokens.has(word)).length*4;
  if(/\b(?:feature|capabilit|function|use when|behavior|behaviour|props)/i.test(value))score+=1;
  if(/^(?:install(?:ation)?|getting started|quick[ -]?start|development|contribut|licen[cs]e|sponsor|documentation)\b/i.test(value))score-=6;
  return {value,index,score};
 });
 const dependencies=facts.frameworkEvidence.filter(entry=>entry.basis==='dependency'&&(!constraints.frameworks.length||constraints.frameworks.includes(entry.framework))).map(entry=>'Dependency: '+entry.value);
 // Keep exact dependency names when they supply the missing framework fact.
 return [...new Set([...dependencies.slice(0,2),...entries.sort((a,b)=>b.score-a.score||a.index-b.index).map(entry=>entry.value)])].join(' · ');
}
