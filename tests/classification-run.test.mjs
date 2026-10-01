import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePlans,usageTotal,permittedBatchCount,MAX_CALL_USD} from '../scripts/lib/classification-run.mjs';
const item=(id,stars=1000)=>({id:String(id),repositoryId:id,url:'https://github.com/example/repo'+id,stars,revision:'abc',readmePinned:true,proof:{sha256:'source'}});
test('progressive acquisition is identity deduplicated and ordered by observed stars',()=>{
  const first={schemaVersion:1,items:[item(1),item(2,70000)]},second={schemaVersion:1,items:[item(1),item(3,4000)]};
  assert.deepEqual(mergePlans([first,second]).map(row=>row.id),['2','3','1']);
  assert.throws(()=>mergePlans([first,{schemaVersion:1,items:[{...item(1),revision:'changed'}]}]),/binding changed/);
  assert.throws(()=>mergePlans([first,{schemaVersion:1,items:[{...item(1),id:'other'}]}]),/numeric repository/);
});
test('total run cap spans UTC and conservatively accounts uncertain sent requests',()=>{
  const jobs=[{usage:[{id:'a',provider:'jev',createdAt:'2026-09-30T23:59:00Z',costUsd:0.001,chargedOrReservedUsd:0.001,inputTokens:100}]},{usage:[{id:'b',provider:'jev',createdAt:'2026-10-01T00:01:00Z',costUsd:null},{id:'c',provider:'jev',requestSent:false,costUsd:0,chargedOrReservedUsd:0}]}];
  const usage=usageTotal(jobs);assert.equal(usage.calls,2);assert.equal(usage.unknownCostCalls,1);assert.equal(usage.chargedOrReservedUsd,0.001+MAX_CALL_USD);
  assert.equal(permittedBatchCount(usage,usage.chargedOrReservedUsd+MAX_CALL_USD),1);
  assert.equal(permittedBatchCount(usage,usage.chargedOrReservedUsd),0);
  assert.equal(permittedBatchCount(usage,39),30);assert.throws(()=>permittedBatchCount(usage,40),/authorized/);
  assert.throws(()=>usageTotal([...jobs,{usage:[{...jobs[0].usage[0],costUsd:0.002}]}]),/Conflicting/);
});
