import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePreview,runCompilerProcess} from '../src/preview.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('React TSX builds with restrictive browser policy and content hash',async()=>{
 const a=await compilePreview({source:'export default function Demo({label}:{label:string}){return <button>{label}</button>}',props:{label:'Review'}});
 assert.match(a.html,/connect-src 'none'/); assert.match(a.html,/frame-src 'none'/); assert.equal(a.hash.length,64);
 assert.equal(a.isolation.hostExecution,false); assert.equal(a.isolation.hardenedContainer,false);
 const b=await compilePreview({source:'export default function Demo(){return <div>Edited</div>}'});
 assert.notEqual(a.hash,b.hash);
});
test('rejects filesystem, network module and unknown package imports',async()=>{
 for(const name of ['node:fs','https://evil.invalid/a.js','some-unreviewed-package','./secrets']){
  await assert.rejects(compilePreview({source:`import thing from '${name}';export default function Demo(){return <div>{thing}</div>}`}),/Unsupported preview import/);
 }
});
test('does not execute candidate JavaScript during compilation',async()=>{
 const result=await compilePreview({source:'throw new Error("DO NOT EXECUTE ON HOST");export default function Demo(){return <div/>}'});
 assert.match(result.html,/DO NOT EXECUTE ON HOST/);
});
test('compiles actual Tailwind utilities and supported class composition helpers',async()=>{
 const result=await compilePreview({source:"import clsx from 'clsx';import {twMerge} from 'tailwind-merge';export default function Demo(){return <div className={twMerge(clsx('flex p-4 bg-blue-500 rounded-lg'))}>Styled</div>}"});
 assert.match(result.html,/\.p-4/);assert.match(result.html,/\.bg-blue-500/);assert.ok(result.imports.includes('clsx'));
});
test('escapes script breakout and rejects oversize or invalid inputs',async()=>{
 const result=await compilePreview({source:'export default function Demo({label}){return <div>{label}</div>}',props:{label:'</script><script>evil()</script>'},css:'/* </style><script>evil()</script> */'});
 assert.equal((result.html.match(/<script /g)||[]).length,1);
 await assert.rejects(compilePreview({source:'x'.repeat(100001)}),/100 KB/);
 await assert.rejects(compilePreview({source:'invalid syntax !!!!!'}));
 await assert.rejects(compilePreview({source:'export default ()=>null',props:[]}),/JSON object/);
});

test('multi-file relative imports, aliases, CSS and reviewed lucide dependency compile together',async()=>{
 const input={entryPath:'src/App.tsx',files:[
  {path:'src/App.tsx',content:"import {Check} from 'lucide-react';import {label} from './label';import {cn} from '@/lib/utils';import './theme.css';export default function App(){return <h1 className={cn('p-7')}><Check/>{label}</h1>}"},
  {path:'src/label.ts',content:"export const label='Multiple real files';"},
  {path:'src/lib/utils.ts',content:"import {clsx} from 'clsx';export const cn=(...values)=>clsx(values);"},
  {path:'src/theme.css',content:'h1 { color: rebeccapurple; }'},
 ]};
 const result=await compilePreview(input);
 assert.match(result.html,/Multiple real files/);assert.match(result.compiledCss,/h1\{color:#639\}/);assert.match(result.compiledCss,/\.p-7/);
 assert.ok(result.imports.includes('lucide-react'));assert.match(result.dependencies['lucide-react'],/^\d+\.\d+\.\d+/);
 const other=await compilePreview({...input,files:input.files.map(file=>file.path==='src/label.ts'?{...file,content:"export const label='Another file changed';"}:file)});
 assert.notEqual(result.hash,other.hash);
});

test('nested modules cannot escape workspace or import unreviewed dependencies',async()=>{
 for(const name of ['node:fs','../../package.json','unreviewed-nested-package','https://evil.invalid/module.js']){
  await assert.rejects(compilePreview({source:"import {value} from './helper';export default ()=> <div>{value}</div>",files:[{path:'helper.ts',content:`import data from '${name}';export const value=data;`}]}),/Unsupported preview import/);
 }
 await assert.rejects(compilePreview({source:"import './unsafe.css';export default ()=> <div/>",files:[{path:'unsafe.css',content:'@import "../../package.json";'}]}),/Workspace CSS cannot import/);
 await assert.rejects(compilePreview({entryPath:'../secrets.tsx',source:'export default ()=>null'}),/entryPath/);
 for(const entryPath of ['CON.tsx','components/AUX/App.tsx','components./App.tsx']) await assert.rejects(compilePreview({entryPath,source:'export default ()=>null'}),/entryPath/);
 await assert.rejects(compilePreview({source:'export default ()=>null',files:[{path:'x.ts',content:''},{path:'X.ts',content:''}]}),/Duplicate/);
 await assert.rejects(compilePreview({entryPath:'source.tsx',source:'export default ()=>null',files:[{path:'Source.tsx',content:'export default ()=>null'}]}),/Duplicate/);
 await assert.rejects(compilePreview({source:'export default ()=>null',files:Array.from({length:40},(_,i)=>({path:`file${i}.ts`,content:'export const fixture=true'}))}),/at most 40/);
});

test('compiler subprocess crashes and timeouts reject explicitly without taking down the service process',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'glasses-compiler-'));
 try{
  const crash=join(directory,'crash.mjs'),timeout=join(directory,'timeout.mjs'),empty=join(directory,'empty.mjs');
  await writeFile(crash,"process.once('message',()=>process.exit(17));");
  await writeFile(timeout,"process.once('message',()=>setInterval(()=>{},1000));");
  await writeFile(empty,"process.once('message',()=>process.exit(0));");
  await assert.rejects(runCompilerProcess({},{compilerPath:crash}),/exited unexpectedly \(17\)/);
  await assert.rejects(runCompilerProcess({},{compilerPath:timeout,timeoutMs:200}),/exceeded 0.2 seconds/);
  await assert.rejects(runCompilerProcess({},{compilerPath:empty}),/without a result/);
  const recovered=await compilePreview({source:'export default ()=> <h1>Compiler service recovered</h1>'});assert.match(recovered.html,/Compiler service recovered/);
 }finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+ '\\')||resolve(directory).startsWith(resolve(tmpdir())+'/'));await rm(directory,{recursive:true,force:true});}
});

test('visual styles enter preview and hash while unsafe selectors and CSS values fail',async()=>{
 const source='export default ()=> <div><h1>Editable</h1></div>',selector='[data-glasses-root] > :nth-child(1) > :nth-child(1)';
 const plain=await compilePreview({source});
 const result=await compilePreview({source,editor:true,visualEdits:{[selector]:{fontSize:'42px',color:'#125544',padding:'18px'}}});
 assert.match(result.compiledCss,/font-size: 42px !important/);assert.match(result.html,/data-glasses-root/);assert.match(result.html,/glasses:selection/);assert.notEqual(result.hash,plain.hash);
 await assert.rejects(compilePreview({source,visualEdits:{body:{color:'red'}}}),/supported canvas/);
 await assert.rejects(compilePreview({source,visualEdits:{[selector]:{color:'red; } body {'}}}),/Unsupported visual/);
 await assert.rejects(compilePreview({source,visualEdits:{[selector]:{backgroundColor:'url(https://evil.invalid)'}}}),/Unsupported visual/);
});
