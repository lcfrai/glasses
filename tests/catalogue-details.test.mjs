import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {enrichCatalogueDetails} from '../src/catalogue-details.mjs';

const at='2026-09-30T00:00:00.000Z',revision='a'.repeat(40);
const hash=value=>createHash('sha256').update(value).digest('hex'),id=value=>hash(value).slice(0,20);
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
function source(url,value,overrides={}){const body=typeof value==='string'?value:JSON.stringify(value),sha256=hash(body);return{url,body,sha256,id:id(url+'\n'+sha256),status:200,lastFetchedAt:at,...overrides};}
function item(url,name,source,kind='solution'){
  const endpoint=new URL(source.url);endpoint.search='';const fields={endpoint:endpoint.href,recordUrl:url,sha256:source.sha256};
  return{id:id(url),url,name,description:'Public description',kind,provider:'Public provider',tags:[],framework:null,license:{spdx:null,status:'unknown',scope:'repository',basis:'upstream-metadata'},github:null,observedAt:at,citations:[{id:id(canonical(fields)),...fields,observedAt:at,kind:'github-repository-metadata'}],assessment:null};
}
function collection(){
  const directory=source('https://registry.directory/directory.json',{registries:[{name:'Friendly UI',url:'https://friendly-ui.example.org',github_url:'https://github.com/public-lab/friendly-ui',registry_url:'https://friendly-ui.example.org/r/registry.json',description:'A source collection with many public components.'}]});
  const index=source('https://registry.directory/items.json',{items:[
    {name:'accordion',description:'An accordion for collapsible answers.',registry:{name:'Friendly UI',basePath:'/public-lab/friendly-ui'}},
    {name:'counter',description:'An animated numeric counter.',registry:{name:'Friendly UI',basePath:'/public-lab/friendly-ui'}},
    {name:'not-admitted',description:'Indexed but absent from this publication.',registry:{name:'Friendly UI',basePath:'/public-lab/friendly-ui'}},
    {name:'foreign',description:'Different owner using the same display name.',registry:{name:'Friendly UI',basePath:'/other-owner/friendly-ui'}},
  ]});
  const parent=item('https://friendly-ui.example.org/','Friendly UI',directory,'reference');
  const child=name=>item(`https://registry.directory/public-lab/friendly-ui/${name}`,name,index,'component');
  return{directory,index,parent,child,items:[parent,child('accordion'),child('counter'),item('https://registry.directory/other-owner/friendly-ui/foreign','foreign',index,'component')]};
}
const readme=(repo,body,overrides={})=>source(`https://api.github.com/repos/${repo}/readme?ref=${revision}`,{encoding:'base64',path:'README.md',content:Buffer.from(body).toString('base64')},overrides);

test('exact retained directory/repository relationship links published children and counts only those members',()=>{
  const data=collection(),before=JSON.stringify(data),result=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index]});
  assert.equal(result[0].details.memberCount,2);assert.equal(result[1].details.parent.id,data.parent.id);assert.equal(result[2].details.parent.url,data.parent.url);
  assert.equal(result[3].details.parent,undefined,'Display-name equality must not invent repository membership');
  assert.equal(result.length,data.items.length,'An unadmitted index member is never silently published');
  assert.equal(JSON.stringify(data),before,'Inputs stay immutable');
  for(const row of result){assert.ok(row.details.citationIds.length<=8);assert.ok(row.details.citationIds.every(ref=>row.citations.some(value=>value.id===ref)));}
});

test('a projected GitHub library is preferred over the related website and nonprojected targets remain absent',()=>{
  const data=collection(),metadata=source('https://api.github.com/repos/public-lab/friendly-ui',{private:false}),repo=item('https://github.com/public-lab/friendly-ui','public-lab/friendly-ui',metadata,'component');
  const result=enrichCatalogueDetails({items:[...data.items,repo],evidence:[data.directory,data.index]});
  assert.equal(result[1].details.parent.id,repo.id);assert.equal(result.at(-1).details.memberCount,2);assert.equal(result[0].details?.memberCount,undefined);
  const absent=enrichCatalogueDetails({items:[data.child('accordion')],evidence:[data.directory,data.index]});assert.equal(absent[0].details.parent,undefined);
});

test('ambiguous directory-to-website membership is withheld instead of guessed',()=>{
  const data=collection(),extra={name:'Other branded site',url:'https://another-ui.example.org',github_url:'https://github.com/public-lab/friendly-ui'};
  const directory=source(data.directory.url,{registries:[JSON.parse(data.directory.body).registries[0],extra]});
  const result=enrichCatalogueDetails({items:[...data.items,item(extra.url+'/','Other',directory,'reference')],evidence:[directory,data.index]});
  assert.equal(result[1].details.parent,undefined);assert.equal(result[0].details?.memberCount,undefined);
});

test('direct pinned registry source links to its exact projected repository without relying on a provider name',()=>{
  const repo='https://github.com/public-lab/components',metadata=source('https://api.github.com/repos/public-lab/components',{private:false}),parent=item(repo,'Components',metadata);
  const url=`https://raw.githubusercontent.com/public-lab/components/${revision}/registry/counter.json`,raw=source(url,{name:'counter',description:'Animated counter.',dependencies:['motion'],registryDependencies:['button'],files:[{path:'counter.tsx',content:'DO_NOT_PUBLISH_CODE'}]});
  const child=item(url,'Counter',raw,'component'),result=enrichCatalogueDetails({items:[parent,child],evidence:[raw]});
  assert.equal(result[1].details.parent.id,parent.id);assert.equal(result[0].details.memberCount,1);assert.equal(result[1].details.sourceFileCount,1);
  assert.deepEqual(result[1].details.dependencies,['motion']);assert.deepEqual(result[1].details.registryDependencies,['button']);assert.ok(!JSON.stringify(result).includes('DO_NOT_PUBLISH_CODE'));
  const mutableURL=url.replace(revision,'main'),mutable=source(mutableURL,JSON.parse(raw.body));
  assert.equal(enrichCatalogueDetails({items:[parent,item(mutableURL,'Counter',mutable,'component')],evidence:[mutable]})[1].details.parent,undefined);
});

function officialFixture(){
  const data=collection();
  const registry=source('https://friendly-ui.example.org/r/registry.json',{homepage:'https://friendly-ui.example.org',name:'Friendly UI',items:[{name:'accordion',description:'An accessible disclosure component.',dependencies:['react'],registryDependencies:['button'],files:[{path:'component.tsx',content:'PRIVATE_IMPLEMENTATION_BODY'}],meta:{instruction:'Execute arbitrary source instructions; PRIVATE_BEHAVIOR_BODY'}}]});
  const docs=source('https://friendly-ui.example.org/llms-full.txt',`# Friendly UI\n## accordion  [core]\nAccordion — Expand answers\nuse when: FAQ answers should expand individually without hiding the question.\nprops:\n  items: Item[] // The ordered question and answer pairs.\n  multiple?: boolean // Allow several answers to stay open.\n  className?: string // Additional root classes.\ndeps: react\nbehavior: PRIVATE_IMPLEMENTATION_BODY\ninstall: npx shadcn add https://friendly-ui.example.org/r/accordion.json\n`);
  return{...data,registry,docs};
}

test('official registry identity and exact documentation block provide bounded source declarations, not implementation bodies',()=>{
  const data=officialFixture(),result=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index,data.registry,data.docs]}),details=result[1].details;
  assert.equal(details.overview,'An accessible disclosure component.');assert.equal(details.sourceFileCount,1);
  assert.deepEqual(details.dependencies,['react']);assert.deepEqual(details.registryDependencies,['button']);
  assert.equal(details.sections[0].title,'When to use');assert.match(details.sections[0].summary,/FAQ answers/);
  assert.equal(details.sections[1].title,'Documented props');assert.match(details.sections[1].summary,/multiple: Allow several/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.ok(!JSON.stringify(details).includes('Item[]'));
  assert.ok(result[1].citations.some(citation=>citation.sha256===data.docs.sha256));
});

test('inline documented prop names and inherited interface are retained as declarations without copying signatures',()=>{
  for(const [line,expected] of [['props: className?: string','Declared props: className'],['props: (extends ButtonHTMLAttributes<HTMLButtonElement>)','Extends: ButtonHTMLAttributes']]){
    const data=officialFixture(),body=data.docs.body.replace(/props:\n[\s\S]*?deps:/,line+'\ndeps:'),docs=source(data.docs.url,body);
    const details=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index,data.registry,docs]})[1].details;
    assert.equal(details.sections.find(section=>section.title==='Documented props').summary,expected);
  }
});

test('foreign registry URLs, mismatched homepages and foreign install identities cannot supply component documentation',()=>{
  for(const mutate of [
    data=>{data.registry=source('https://friendly-ui.example.org/unrelated.json',JSON.parse(data.registry.body));},
    data=>{data.registry=source(data.registry.url,{...JSON.parse(data.registry.body),homepage:'https://other.example.org'});},
    data=>{data.docs=source(data.docs.url,data.docs.body.replace('/r/accordion.json','/r/accordion.json.evil'));},
    data=>{data.docs=source('https://other.example.org/llms-full.txt',data.docs.body);},
  ]){
    const data=officialFixture();mutate(data);const details=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index,data.registry,data.docs]})[1].details;
    assert.equal(details.sections,undefined);
  }
});

test('README excerpts retain purpose and documentation headings while excluding code, navigation, licence and private local inputs',()=>{
  const metadata=source('https://api.github.com/repos/public-lab/writer',{private:false}),row=item('https://github.com/public-lab/writer','Writer',metadata);
  row.privateNotes='PRIVATE_LOCAL_NOTE';row.workspace={source:'PRIVATE_LOCAL_CODE'};
  const body='# Writer\nA collaborative document editor for distributed teams.\n\n[Docs](https://docs.example.org/writer)\n## Features\n- Collaborative documents and offline editing.\n- Search notes by title and content.\n```js\nconst SECRET_SOURCE = "PRIVATE_CODE";\n```\n<script>\nPRIVATE_SCRIPT_BODY\n</script>\n<!-- PRIVATE_COMMENT -->\n## Administration\nManage roles and review activity.\n## Licence\nPRIVATE_LICENCE_TEXT\n## Sponsors\nPRIVATE_SPONSOR_TEXT\n';
  const result=enrichCatalogueDetails({items:[row],evidence:[metadata,readme('public-lab/writer',body)]})[0];
  assert.match(result.details.overview,/collaborative document editor/);assert.equal(result.details.documentationUrl,'https://docs.example.org/writer');
  assert.ok(result.details.features.some(value=>/Search notes/.test(value)));assert.ok(result.details.sections.some(value=>value.title==='Administration'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(result.description,row.description,'Source excerpts never overwrite established metadata or model labels');
});

test('README synopsis stays within a total180 words and per-field bounds without publishing every symbol',()=>{
  const metadata=source('https://api.github.com/repos/public-lab/large',{private:false}),row=item('https://github.com/public-lab/large','Large',metadata);
  const body='# Large\n'+('A useful published product description. '.repeat(80))+'\n## Features\n'+Array.from({length:30},(_,i)=>'- Feature '+i+' '+('public source detail '.repeat(30))).join('\n')+'\n'+Array.from({length:40},(_,i)=>'## Section '+i+'\n'+('More public documentation. '.repeat(40))).join('\n');
  const result=enrichCatalogueDetails({items:[row],evidence:[readme('public-lab/large',body)]})[0].details;
  const all=[result.overview,...(result.features||[]),...(result.sections||[]).flatMap(section=>[section.title,section.summary])].filter(Boolean).join(' ');
  assert.ok(all.split(/\s+/).length<=180);assert.ok(result.overview.length<=800);assert.ok((result.features||[]).length<=8);assert.ok((result.sections||[]).length<=8);
  assert.ok((result.features||[]).every(value=>value.length<=180));assert.ok((result.sections||[]).every(section=>section.title.length<=100&&section.summary.length<=280));
});

test('invalid, mutable, foreign and credentialled source evidence contributes no README detail',()=>{
  const metadata=source('https://api.github.com/repos/public-lab/writer',{private:false}),row=item('https://github.com/public-lab/writer','Writer',metadata),valid=readme('public-lab/writer','# Writer\nPublic source explanation.');
  for(const candidate of [
    {...valid,body:valid.body+'tampered'},{...valid,status:403},{...valid,lastFetchedAt:'not-a-date'},{...valid,id:'0'.repeat(20)},
    readme('foreign/writer','# Writer\nForeign source.'),source(valid.url.replace(revision,'main'),JSON.parse(valid.body)),
    source(valid.url+'&private=query',JSON.parse(valid.body)),source(valid.url.replace('api.github.com','user:password@api.github.com'),JSON.parse(valid.body)),
  ])assert.deepEqual(enrichCatalogueDetails({items:[row],evidence:[candidate]})[0].details,{resourceType:'tool',citationIds:[row.citations[0].id]});
});

test('external wrappers with only fetchedAt still require exact body hashes and bound dependency arrays',()=>{
  const url=`https://raw.githubusercontent.com/public-lab/ui/${revision}/r/example.json`,body={name:'example',description:'Example',dependencies:[...Array.from({length:25},(_,i)=>'package-'+i),'react','react','npm install exploit','sk-1234567890123456'],registryDependencies:['button','https://public.example.org/r/card.json','https://user:pass@public.example.org/r/card.json','https://public.example.org/r/card.json?secret=x'],files:[{path:'component.tsx',content:'PRIVATE_CODE'}]};
  const retained=source(url,body);delete retained.id;delete retained.lastFetchedAt;retained.fetchedAt=at;
  const result=enrichCatalogueDetails({items:[item(url,'Example',retained,'component')],evidence:[retained]})[0].details;
  assert.equal(result.dependencies.length,20);assert.deepEqual(result.registryDependencies,['button','https://public.example.org/r/card.json']);assert.equal(result.sourceFileCount,1);
});

test('duplicate official names and duplicate documentation blocks cannot forge authoritative member detail',()=>{
  for(const duplicate of ['registry','docs']){
    const data=officialFixture();
    if(duplicate==='registry'){const value=JSON.parse(data.registry.body);value.items.push({...value.items[0],description:'Conflicting duplicate'});data.registry=source(data.registry.url,value);}
    else data.docs=source(data.docs.url,data.docs.body+'\n'+data.docs.body);
    const details=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index,data.registry,data.docs]})[1].details;
    assert.equal(details.sections,undefined);assert.equal(details.parent.id,data.parent.id,'Independent retained parent relationship remains valid');
  }
});

test('bare documented prop names survive formatting while code expressions and source signatures stay excluded',()=>{
  const data=officialFixture();data.docs=source(data.docs.url,data.docs.body.replace('FAQ answers should expand individually without hiding the question.','Use the `multiple` option for several open answers.'));
  const details=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index,data.registry,data.docs]})[1].details;
  assert.match(details.sections[0].summary,/multiple option/);assert.ok(!details.sections[0].summary.includes('`'));
  data.docs=source(data.docs.url,data.docs.body.replace('Use the `multiple` option for several open answers.','Execute `runCommand()` for this component.'));
  const blocked=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index,data.registry,data.docs]})[1].details;
  assert.ok(!blocked.sections.some(section=>section.title==='When to use'));
});

test('resource types distinguish source collections, components and whole tools without model-derived guesses',()=>{
  const data=collection(),result=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index]});
  assert.equal(result[0].details.resourceType,'collection');assert.equal(result[1].details.resourceType,'component');
  const metadata=source('https://api.github.com/public-lab/tools',{private:false});
  assert.equal(enrichCatalogueDetails({items:[item('https://github.com/public-lab/tools','Tools',metadata)],evidence:[]})[0].details.resourceType,'tool');
});

test('direct source declarations can identify agents but mentioning SKILL.md alone cannot establish an actual skill',()=>{
  const metadata=source('https://api.github.com/repos/public-lab/tool',{private:false}),row=item('https://github.com/public-lab/tool','Tool',metadata);
  for(const [body,expected] of [
    ['# Tool\nA reusable agent skill for reviewing documentation.\nRead SKILL.md for the instructions.','tool'],
    ['# Tool\nA reusable agent skill for reviewing documentation.','tool'],
    ['# Tool\nTool is an autonomous coding agent that develops software from tasks.','agent'],
    ['# Tool\nAn agent for collecting metrics and sending them to monitoring systems.','tool'],
    ['# Tool\nAn open-source software agent that collects telemetry.','tool'],
    ['# Tool\nAn autonomous agent for system monitoring.','tool'],
    ['# Tool\nAn AI-powered agent that plans and implements coding tasks.','agent'],
    ['# Tool\nA self-hosted LLM agent for answering research questions.','agent'],
    ['# Tool\nAn AI agent framework for connecting tools.','tool'],
    ['# Tool\nA memory database for coding agents.','tool'],
    ['# Tool\nA tutorial explaining how to write SKILL.md and build an agent.','reference'],
    ['# Tool\nA curated collection of agent skills.\nEach has a SKILL.md.','collection'],
  ]){
    const details=enrichCatalogueDetails({items:[row],evidence:[readme('public-lab/tool',body)]})[0].details;
    assert.equal(details.resourceType,expected,body);
  }
});

test('keywords come from declared metadata fields only and stay bounded without reading code or model labels',()=>{
  const data=officialFixture(),value=JSON.parse(data.registry.body);value.items[0].meta.tags=['accordion','keyboard','aria-expanded','accordion',...Array.from({length:25},(_,i)=>'tag-'+i)];
  value.items[0].categories=['disclosure'];value.items[0].tags=['faq'];value.items[0].files[0].content='PRIVATE_CODE_KEYWORD';
  data.registry=source(data.registry.url,value);
  const row=enrichCatalogueDetails({items:data.items,evidence:[data.directory,data.index,data.registry,data.docs]})[1];
  assert.deepEqual(row.details.keywords.slice(0,5),['faq','disclosure','accordion','keyboard','aria-expanded']);assert.equal(row.details.keywords.length,20);
  assert.ok(!JSON.stringify(row.details).includes('PRIVATE_CODE_KEYWORD'));
});

test('explicit community lists and enumerated teaching notebooks are typed without relabelling notebook applications',()=>{
  const metadata=source('https://api.github.com/repos/public-lab/resource',{private:false}),row=item('https://github.com/public-lab/resource','Resource',metadata);
  for(const [description,body,expected] of [
    ['Database resources','# Resources\n> Community driven list of database tools\n','collection'],
    ['Community-maintained directory of software.','# Resources\nA useful set of links.','collection'],
    ['Agent memory for LLMs: 30 runnable Jupyter notebooks covering conversation buffers and production patterns.','# Resources\nLearn every agent memory technique.','reference'],
    ['A notebook server with 30 runnable Jupyter notebooks covering examples.','# Tool\nA notebook server for teams.','tool'],
    ['A platform: 30 runnable Jupyter notebooks covering examples.','# Tool\nA collaborative computing platform.','tool'],
    ['A framework for executing Jupyter notebooks.','# Tool\nIncludes educational notebooks and tutorials.','tool']
  ])assert.equal(enrichCatalogueDetails({items:[{...row,description}],evidence:[readme('public-lab/resource',body)]})[0].details.resourceType,expected,description);
});

function docsScopeFixture(){
  const repo='public-lab/manual',treeSha='b'.repeat(40),body='# SDK\nA flexible framework for building applications.\n',metadata=source('https://api.github.com/repos/'+repo,{private:false}),row=item('https://github.com/'+repo,'SDK',metadata);
  const readmeSource=readme(repo,body),blob=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(body)}\0`),Buffer.from(body)])).digest('hex');
  const commit=source(`https://api.github.com/repos/${repo}/commits/main`,{sha:revision,commit:{tree:{sha:treeSha}}});
  const entries=[{path:'README.md',type:'blob',sha:blob},{path:'mkdocs.yml',type:'blob',sha:'c'.repeat(40)},{path:'docs/index.md',type:'blob',sha:'d'.repeat(40)},...Array.from({length:22},(_,i)=>({path:`docs/guide-${i}.md`,type:'blob',sha:'e'.repeat(40)}))];
  const tree=source(`https://api.github.com/repos/${repo}/git/trees/${treeSha}?recursive=1`,{sha:treeSha,truncated:false,tree:entries});
  return {row,readmeSource,commit,tree};
}
test('documentation scope requires exact README blob, pinned commit/tree linkage and overwhelming docs without implementation root',()=>{
  const input=docsScopeFixture(),output=enrichCatalogueDetails({items:[input.row],evidence:[input.readmeSource,input.commit,input.tree]})[0];
  assert.equal(output.details.resourceType,'reference');assert.ok(output.citations.some(ref=>ref.sha256===input.tree.sha256));
  assert.equal(input.row.details,undefined,'pure enrichment cannot mutate original source records');
  for(const mutate of [
    data=>{data.commit=source(data.commit.url,{...JSON.parse(data.commit.body),sha:'f'.repeat(40)});},
    data=>{data.tree=source(data.tree.url.replace('public-lab/manual','other/manual'),JSON.parse(data.tree.body));},
    data=>{data.tree=source(data.tree.url,{...JSON.parse(data.tree.body),truncated:true});},
    data=>{const body=JSON.parse(data.tree.body);body.tree[0].sha='0'.repeat(40);data.tree=source(data.tree.url,body);},
    data=>{const body=JSON.parse(data.tree.body);body.tree.push({path:'src/runtime.ts',type:'blob',sha:'c'.repeat(40)});data.tree=source(data.tree.url,body);},
    data=>{const body=JSON.parse(data.tree.body);body.tree=body.tree.filter(entry=>entry.path!=='mkdocs.yml');data.tree=source(data.tree.url,body);},
    data=>{const body=JSON.parse(data.tree.body);body.tree=body.tree.filter(entry=>entry.path!=='docs/index.md');data.tree=source(data.tree.url,body);},
    data=>{const body=JSON.parse(data.tree.body);body.tree.push(...Array.from({length:40},(_,i)=>({path:`examples/app-${i}.ts`,type:'blob',sha:'f'.repeat(40)})));data.tree=source(data.tree.url,body);},
    data=>{data.tree={...data.tree,sha256:'0'.repeat(64)};},
    data=>{data.tree=source(data.tree.url,{...JSON.parse(data.tree.body),sha:'f'.repeat(40)});}
  ]){const broken=docsScopeFixture();mutate(broken);assert.equal(enrichCatalogueDetails({items:[broken.row],evidence:[broken.readmeSource,broken.commit,broken.tree]})[0].details.resourceType,'tool');}
  const noProof={...input.row,url:'https://github.com/public-lab/example-docs'};noProof.id=id(noProof.url);
  assert.equal(enrichCatalogueDetails({items:[noProof],evidence:[]})[0].details.resourceType,'tool','name-only docs inference is forbidden');
});
