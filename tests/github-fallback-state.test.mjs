import test from 'node:test';import assert from 'node:assert/strict';
import {fallbackSourceFailure} from '../scripts/lib/github-fallback-state.mjs';
test('rate or authorization failures halt fallback even when another source was retained',()=>{
  for(const code of [401,403,429])for(const sourceState of [{status:'error',error:`HTTP ${code} from api.github.com`},{status:'partial',errors:[{resource:'readme',error:`HTTP ${code} from api.github.com`}]}]){
    const result=fallbackSourceFailure({sourceState,repositoryFiles:[{path:'README.md',content:'old'}]});assert.equal(result.blocked,true);assert.deepEqual(result.httpStatuses,[code]);
  }
});
test('missing optional licence and unsupported source do not pretend to be a rate failure',()=>{
  assert.equal(fallbackSourceFailure({sourceState:{status:'partial',errors:[{error:'HTTP 404 from api.github.com'}]}}).blocked,false);
  assert.equal(fallbackSourceFailure({sourceState:{status:'error',error:'No supported source'}}).blocked,false);
});
