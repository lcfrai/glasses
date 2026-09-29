import test from 'node:test';
import assert from 'node:assert/strict';
import {themeTokens} from '../src/theme-tokens.mjs';
import {compile} from '@tailwindcss/node';
import {fileURLToPath} from 'node:url';
import {compilePreview} from '../src/preview.mjs';

test('Retained semantic theme tokens compile the actual component utilities',async()=>{
  const css='@import "tailwindcss"; @theme inline { --color-primary: var(--primary); --color-background: var(--background); --font-display: Georgia, "Times New Roman", serif; } :root { --primary: #f17b68; }';
  const retained=themeTokens(css);assert.equal(retained.includes('@import'),false);
  const compiler=await compile('@import "tailwindcss" source(none);\n'+retained,{base:fileURLToPath(new URL('../',import.meta.url)),onDependency(){}});
  const result=compiler.build(['bg-primary','bg-background','text-primary','font-display']);
  for(const name of ['.bg-primary','.bg-background','.text-primary','.font-display'])assert.ok(result.includes(name),name);
  assert.ok(result.includes('var(--primary)'));
});

test('Candidate imports/plugins/sources and theme comments never enter the trusted stylesheet',()=>{
  const retained=themeTokens('@plugin "./evil.js"; @source "C:/private"; @import "https://bad.example"; /* @theme { --color-evil: red; } */ @theme { --color-good: #abcdef; }');
  assert.equal(retained,'@theme {\n--color-good: #abcdef;\n}');
  for(const value of ['url(https://bad.example)','expression(alert(1))','red @plugin "evil"','\\75rl(bad)'])assert.throws(()=>themeTokens('@theme { --color-x: '+value+'; }'),/Unsupported value/);
  assert.throws(()=>themeTokens('@theme { color: red; }'),/custom-property/);
  assert.throws(()=>themeTokens('@theme { --animate-turn: turn 1s; @keyframes turn { to { opacity: 0; } } }'),/flat custom-property/);
  assert.throws(()=>themeTokens('@theme reference { --color-brand: red; }'),/flat custom-property/);
});

test('Preview passes theme tokens from workspace CSS and supplied CSS files, without loading candidate plugins',async()=>{
  const result=await compilePreview({entryPath:'App.tsx',files:[{path:'App.tsx',content:'import "./tokens.css"; export default ()=> <p className="text-brand bg-surface">Semantic tokens</p>'},{path:'tokens.css',content:'@theme inline { --color-brand: var(--brand); } :root { --brand: #ff0000; }'}],css:'@plugin "./not-a-real-host-plugin.js"; @theme inline { --color-surface: var(--surface); } :root { --surface: #222222; }'});
  assert.ok(result.compiledCss.includes('.text-brand'));
  assert.ok(result.compiledCss.includes('.bg-surface'));
});
