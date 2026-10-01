// Source-backed framework labels, not runtime-compatibility claims. JSX/TSX
// syntax and generic registry membership do not identify a framework.
const names=['React','Vue','Svelte','Angular','Solid','Preact','Web Components'];
const declarations=new Map([['react','React'],['reactjs','React'],['react.js','React'],['vue','Vue'],['vuejs','Vue'],['vue.js','Vue'],['vue2','Vue'],['vue3','Vue'],['svelte','Svelte'],['sveltejs','Svelte'],['angular','Angular'],['solid','Solid'],['solidjs','Solid'],['solid.js','Solid'],['solid-js','Solid'],['preact','Preact']]);
for(const value of ['web components','web-components','webcomponents','custom-elements'])declarations.set(value,'Web Components');
function declared(value){return typeof value==='string'?declarations.get(value.trim().toLowerCase())||null:null;}
function dependencyName(value){
 if(typeof value!=='string')return null;
 return value.trim().match(/^(@[a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+)(?:@[^\s]+)?$/i)?.[1]||null;
}
function packageFramework(value){
 if(/^(?:react|react-dom|react-native)(?:\/|$)/.test(value))return 'React';
 if(/^(?:vue(?:\/|$)|@vue\/(?:runtime-core|runtime-dom|compiler-sfc|reactivity)(?:\/|$))/.test(value))return 'Vue';
 if(/^svelte(?:\/|$)/.test(value))return 'Svelte';
 if(/^@angular\/core(?:\/|$)/.test(value))return 'Angular';
 if(/^solid-js(?:\/|$)/.test(value))return 'Solid';
 if(/^preact(?:\/|$)/.test(value))return 'Preact';
 // Framework-exclusive packages are evidence; generic utilities (Motion,
 // Tailwind, Vite, JSX tooling) and local aliases are deliberately not.
 if(/^(?:@radix-ui\/react-[a-z0-9-]+|@base-ui\/react|@headlessui\/react|@tabler\/icons-react|lucide-react|radix-ui|@lit\/react)(?:\/|$)/.test(value))return 'React';
 if(/^(?:reka-ui|radix-vue|primevue|@headlessui\/vue|@vueuse\/core|@vueuse\/components|lucide-vue-next)(?:\/|$)/.test(value))return 'Vue';
 if(/^(?:@sveltejs\/kit|bits-ui|svelte-sonner|lucide-svelte)(?:\/|$)/.test(value))return 'Svelte';
 if(/^@angular\/(?:common|forms|router|platform-browser)(?:\/|$)/.test(value))return 'Angular';
 if(/^@kobalte\/core(?:\/|$)/.test(value))return 'Solid';
 if(/^(?:lit|lit-element|@lit\/reactive-element)(?:\/|$)/.test(value))return 'Web Components';
 return null;
}
function sourceTokens(source){
 const tokens=[];
 const pattern=/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
 for(const [token] of source.matchAll(pattern)){
  if(token.startsWith('//')||token.startsWith('/*')||token.startsWith('`'))continue;
  tokens.push({value:/^["']/.test(token)?token.slice(1,-1):token,string:/^["']/.test(token)});
 }
 return tokens;
}
function importedPackages(tokens){
 const result=[];
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];if(token.string||!['import','export','require'].includes(token.value)||['.','/'].includes(tokens[i-1]?.value))continue;
  if(['import','require'].includes(token.value)&&tokens[i+1]?.value==='('&&tokens[i+2]?.string&&tokens[i+3]?.value===')'){result.push(tokens[i+2].value);continue;}
  if(token.value==='require')continue;
  if(token.value==='import'&&tokens[i+1]?.string){result.push(tokens[i+1].value);continue;}
  if(token.value==='export'&&!['{','*','type'].includes(tokens[i+1]?.value))continue;
  for(let j=i+1;j<Math.min(tokens.length,i+256)&&tokens[j].value!==';';j++)if(!tokens[j].string&&tokens[j].value==='from'&&tokens[j+1]?.string){result.push(tokens[j+1].value);break;}
 }
 return result;
}
function descriptionDeclarations(description,add){
 // Evaluate each sentence separately so a later migration guide cannot erase
 // an independent product declaration. Comparisons/migrations describe other
 // stacks; their framework names are not declarations about this source.
 for(const sentence of description.split(/(?<=[.!?;])\s+/)){
  if(/\b(?:compar(?:e|es|ed|ing|ison|isons)|migrat(?:e|es|ed|ing|ion|ions)|porting|versus|vs\.?)\b/i.test(sentence))continue;
  for(const start of sentence.matchAll(/\b(?:built|written|powered)\s+(?:with|in|by)\s+/gi)){
   let remaining=sentence.slice(start.index+start[0].length),consumed='',count=0;
   const found=[];
   // A bounded explicit technology list can include non-UI languages/servers.
   // Recognize every supported framework, not just the first one. Do not scan
   // arbitrary later prose after the list (e.g. "React to replace Angular").
   while(count++<20){
    const token=/^(Web Components|React(?:\.js|JS)?|Vue(?:\.js|\s*[23])?|Svelte(?:JS)?|Angular|Solid(?:JS|\.js|-js)?|Preact|[A-Za-z][A-Za-z\d_.-]*)(?:\s+v?\d+(?:\.\d+)*)?(?=$|[\s,/&;.!?])/i.exec(remaining);
    if(!token)break;
    const value=token[1].replace(/\s+(?=[23]$)/,'');
    const framework=declared(value);if(framework)found.push(framework);
    consumed+=token[0];remaining=remaining.slice(token[0].length);
    const separator=/^\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+|&\s*|\/\s*)/i.exec(remaining);
    if(!separator)break;consumed+=separator[0];remaining=remaining.slice(separator[0].length);
   }
   for(const framework of found)add(framework,'description-declaration',start[0]+consumed);
  }
  for(const name of names){
   const label=name==='Vue'?'Vue(?:\\.js|\\s*[23])?':name==='Solid'?'Solid(?:JS|\\.js)?':name==='React'?'React(?:\\.js|JS)?':name;
   const pattern=new RegExp(`(?:\\b${label}\\s+(?:UI\\s+)?(?:component(?:s|\\s+library)?|library|framework|application|app|dashboard)\\b|\\b(?:components?|UI\\s+library)\\s+for\\s+${label}\\b)`,'i');
   const match=sentence.match(pattern);if(match)add(name,'description-declaration',match[0]);
  }
 }
}
export function detectFramework(input={}){
 const evidence=[];
 const add=(framework,basis,value,path)=>{if(framework&&!evidence.some(e=>e.framework===framework&&e.basis===basis&&e.value===value&&e.path===path))evidence.push({framework,basis,value,...(path?{path}:{})});};
 for(const value of [input.framework,...(Array.isArray(input.frameworks)?input.frameworks:[])])add(declared(value),'declaration',value);
 for(const value of [...(Array.isArray(input.topics)?input.topics:[]),...(Array.isArray(input.tags)?input.tags:[])])add(declared(value),'topic',value);
 // Exact framework names in an explicit description declaration are useful;
 // incidental substrings ("reactive") or comparisons are not declarations.
 const description=typeof input.description==='string'?input.description:'';
 descriptionDeclarations(description,add);
 const dependencies=(value,path)=>{
  const values=Array.isArray(value)?value:value&&typeof value==='object'?Object.keys(value):[];
  for(const value of values){const name=dependencyName(value);if(name)add(packageFramework(name),'dependency',name,path);}
 };
 for(const key of ['dependencies','peerDependencies','devDependencies'])dependencies(input[key]);
 for(const file of Array.isArray(input.files)?input.files:[]){
  const path=file?.path||file?.name||'',content=file?.content;
  // An exact source-file declaration is enough for these unambiguous formats;
  // a provider name or a generic .tsx inventory is not.
  if(/\.vue$/i.test(path))add('Vue','file-convention','.vue',path);
  if(/\.svelte$/i.test(path))add('Svelte','file-convention','.svelte',path);
  if(typeof content!=='string')continue;
  if(/(?:^|\/)package\.json$/i.test(path)){try{const pkg=JSON.parse(content);for(const key of ['dependencies','peerDependencies','devDependencies'])dependencies(pkg[key],path);}catch{}continue;}
  if(!/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(path))continue;
  // Static imports/exports, literal dynamic imports and require calls only.
  // Do not treat comments or ordinary strings mentioning a framework as imports.
  const tokens=sourceTokens(content);
  for(const name of importedPackages(tokens))add(packageFramework(name),'import',name,path);
  const code=tokens.map(token=>token.string?'__STRING__':token.value).join(' ');
  if(/\bclass\s+[\w$]+\s+extends\s+(?:(?:window|globalThis)\s+\.\s+)?HTMLElement\b/.test(code)&&/\bcustomElements\s+\.\s+define\s*\(/.test(code))add('Web Components','custom-element-definition','HTMLElement + customElements.define',path);
 }
 const frameworks=names.filter(name=>evidence.some(item=>item.framework===name));
 return {framework:frameworks.length===1?frameworks[0]:null,frameworks,evidence};
}
export function frameworkTags(input){const framework=detectFramework(input).framework;return framework?[framework.toLowerCase()]:[];}
