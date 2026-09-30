import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {purposeAnchor,purposeEvidence} from '../src/purpose-matching.mjs';
import {createStore} from '../src/store.mjs';
import {createIntelligence} from '../src/intelligence.mjs';

test('bounded task anchors do not confuse arbitrary model requests or negated tasks',()=>{
 assert.equal(purposeAnchor('Review a spreadsheet workbook'),'spreadsheet');
 assert.equal(purposeAnchor('Threat-model a web application'),'threat-model');
 assert.equal(purposeAnchor('Prioritise attack paths'),'threat-model');
 assert.equal(purposeAnchor('Host a language model in a browser'),null);
 assert.equal(purposeAnchor('A document editor, not a spreadsheet'),null);
 assert.equal(purposeAnchor('https://example.org/spreadsheet'),null);
 const missing=purposeEvidence('spreadsheet',{name:'Browser editor'});assert.equal(missing.matched,false);assert.ok(missing.weight>0&&missing.weight<1);
 assert.equal(purposeEvidence('threat-model',{name:'Generic model',inferred:'threat-model security'}).matched,false,'Inferred labels cannot establish the source-purpose anchor');
 assert.equal(purposeEvidence('spreadsheet',{sourceDetails:'Excel at creating detailed implementation plans.'}).matched,false,'The verb excel is not spreadsheet purpose');
 assert.equal(purposeEvidence('spreadsheet',{description:'Validate Excel files and formulas'}).matched,true);
});

test('actual local decoration applies the same purpose preference without inference or hard exclusions',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'glasses-purpose-'));assert.ok(directory.startsWith(tmpdir()));
 let store,engine;t.after(async()=>{await engine?.close();store?.close();await rm(directory,{recursive:true,force:true});});
 const noInference=()=>assert.fail('No inference is permitted in this ranking test');
 store=createStore(directory);engine=createIntelligence({store,discovery:{},providers:{status:async()=>({}),classify:noInference,plan:noInference,rank:noInference},dataDir:directory});
 const add=(name,description,kind='solution',tags=[])=>store.upsertCapability({name,description,kind,tags,url:'https://purpose-fixture.example/'+encodeURIComponent(name),provider:'Synthetic test only',origin:'live'}).item;
 const translation=add('Browser translator','Let teammates edit web translations in a browser','solution',['browser','edit','teammates']),sheet=add('Sheet desk','A collaborative spreadsheet editor for sharing workbooks online'),unknown=add('Browser editor','An editor with undocumented storage behaviour');
 const sheetResult=engine.decorate([translation,sheet,unknown],{query:'Let two teammates edit the same spreadsheet in a browser'});
 assert.equal(sheetResult[0].id,sheet.id);assert.ok(sheetResult.some(item=>item.id===unknown.id));assert.match(sheetResult[0].matchReason,/spreadsheet purpose: direct-source-purpose/);
 const noisy=add('Application Model Builder','Web application and language model assistant','pattern',['application','model','web']),security=add('Risk reviewer','Security review and vulnerability assessment for teams','pattern'),threat=add('Threat plan','Threat modelling with prioritised attack paths','pattern');
 const result=engine.decorate([noisy,security,threat],{query:'Threat model a web application and prioritise attack paths'});
 assert.equal(result[0].id,threat.id);assert.ok(result.findIndex(item=>item.id===security.id)<result.findIndex(item=>item.id===noisy.id));
 assert.equal(engine.decorate([noisy,security,threat],{query:noisy.name})[0].id,noisy.id);
 assert.equal(engine.decorate([translation,sheet],{query:translation.url})[0].id,translation.id);
 const status=await engine.status();assert.equal(status.usageToday.calls,0);
});

test('local component framework requests respect six declared frameworks, cross-framework and unknown metadata, plus exact identity',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'glasses-purpose-'));assert.ok(directory.startsWith(tmpdir()));let store,engine;
 t.after(async()=>{await engine?.close();store?.close();await rm(directory,{recursive:true,force:true});});
 const noInference=()=>assert.fail('No inference is permitted in this ranking test');store=createStore(directory);engine=createIntelligence({store,discovery:{},providers:{status:async()=>({}),classify:noInference,plan:noInference,rank:noInference},dataDir:directory});
 const add=(name,framework,kind='component',tags=[])=>store.upsertCapability({name,framework,kind,tags,description:'Accessible combobox with multiple selection',url:'https://framework-fixture.example/'+encodeURIComponent(name),provider:'Synthetic test only',origin:'live'}).item;
 for(const framework of ['React','Vue','Svelte','Angular','Solid','Preact']){
  const other=framework==='React'?'Vue':'React',matching=add(framework+' control',framework),wrong=add(framework+' wrong control',other),unknown=add(framework+' undisclosed control',null),cross=add(framework+' cross control',other+' / '+framework),whole=add(framework+' complete app',other,'solution');
  const result=engine.decorate([wrong,unknown,matching,cross,whole],{query:framework+' accessible combobox multiple selection'});
  assert.ok(!result.some(item=>item.id===wrong.id),framework+' wrong framework excluded');assert.ok(result.some(item=>item.id===unknown.id),'Unknown remains eligible');assert.ok(result.some(item=>item.id===cross.id),'Cross-framework remains eligible');assert.ok(result.some(item=>item.id===whole.id),'Only components receive this framework exclusion');
  assert.ok(result.findIndex(item=>item.id===matching.id)<result.findIndex(item=>item.id===unknown.id),'Declared framework receives score weight');
  assert.equal(engine.decorate([wrong,matching],{query:wrong.name})[0].id,wrong.id,'Exact names bypass framework exclusion');
  assert.equal(engine.decorate([wrong,matching],{query:wrong.url})[0].id,wrong.id,'Exact URLs bypass framework exclusion');
  assert.equal(engine.decorate([wrong,matching],{query:wrong.id})[0].id,wrong.id,'Exact IDs remain retrievable');
 }
 const fact=add('Explicit source declaration',null,'component',['vue']),unknown=add('Undocumented profile',null);
 assert.equal(engine.decorate([unknown,fact],{query:'Vue combobox'})[0].id,fact.id);
 assert.ok(engine.decorate([fact],{query:'Combobox without React for Vue'}).some(item=>item.id===fact.id));
 const status=await engine.status();assert.equal(status.usageToday.calls,0);
});

test('local query coverage prefers task plus framework over repeated framework alone while preserving partial and exact matches',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'glasses-purpose-'));let store,engine;
 t.after(async()=>{await engine?.close();store?.close();await rm(directory,{recursive:true,force:true});});
 const noInference=()=>assert.fail('No inference is permitted in this ranking test');store=createStore(directory);engine=createIntelligence({store,discovery:{},providers:{status:async()=>({}),classify:noInference,plan:noInference,rank:noInference},dataDir:directory});
 const add=(name,description,framework,kind='component',tags=[])=>store.upsertCapability({name,description,framework,kind,tags,url:'https://coverage-fixture.example/'+encodeURIComponent(name),provider:'Synthetic test only',origin:'live'}).item;
 for(const framework of ['React','Vue','Svelte','Angular','Solid','Preact']){
  const generic=add(framework+' UI library',framework+' components for '+framework,framework,'component',[framework.toLowerCase()]);
  const control=add('Combobox '+framework+' specimen','A combobox for selecting one option.',framework);
  const partial=add('Undocumented '+framework+' specimen','Available UI source.',null);
  const result=engine.decorate([generic,partial,control],{query:framework+' combobox'});
  assert.equal(result[0].id,control.id,framework+' task and framework match should outrank framework alone');
  assert.ok(result.some(item=>item.id===partial.id),'Partial source metadata stays discoverable');
  assert.equal(engine.decorate([control,generic],{query:generic.name})[0].id,generic.id);
 }
 const repeated=add('Database operations','Database administration platform',null,'solution',['database']);
 const complete=add('Backup service','Database backup service',null,'solution');
 assert.equal(engine.decorate([repeated,complete],{query:'database backup'})[0].id,complete.id,'Coverage is a general rule, not a component or framework-name boost');
 assert.equal((await engine.status()).usageToday.calls,0);
});
