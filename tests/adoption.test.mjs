import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdoptionBrief} from '../src/adoption.mjs';

test('memory request produces an adoption assessment, never a fictitious successful installation',()=>{
 const item={id:'external-memory',name:'Unfamiliar memory project',kind:'solution',url:'https://example.org/memory',description:'Persistent retrieval for agents',tags:['memory'],license:'MIT',licenseStatus:'known',origin:'live',provenance:{sourceUrl:'https://example.org/memory',fetchedAt:'2026-09-27'}};
 const plan=createAdoptionBrief(item,{goal:'My agent forgets conventions across projects',agent:'User selected agent'});
 assert.equal(plan.fitConfirmed,false); assert.equal(plan.execution.installed,false);assert.equal(plan.execution.imported,false);
 assert.ok(plan.missingContext.includes('privacy'));assert.ok(plan.verification.some(v=>v.includes('fresh agent session')));
 assert.ok(plan.verification.some(v=>v.includes('Delete')));assert.ok(plan.assessmentTasks.some(v=>v.includes('replacement agent')));
 assert.equal(plan.candidate.name,item.name);
});
test('whole-solution assessment does not force a component-building path',()=>{
 const plan=createAdoptionBrief({id:'deploy',name:'Deployment product',kind:'solution',description:'Self hosted deployment',licenseStatus:'unknown',origin:'seed',url:'https://example.org'}, {goal:'Deploy locally'});
 assert.match(plan.assessmentTasks[0],/whole product/);assert.equal(plan.findings[0].status,'unverified-reference');
 assert.equal(plan.findings[1].status,'not-established');
 assert.throws(()=>createAdoptionBrief({kind:'component'}),/whole-solution/);
});
