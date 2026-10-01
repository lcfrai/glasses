import test from 'node:test';
import assert from 'node:assert/strict';
import {hydrationRetry} from '../scripts/lib/github-hydration-retry.mjs';

test('empty successful and transient gateway reads allow only two spaced smaller retries',()=>{
  for(const response of [{status:200,body:''},{status:200,body:'  '},{status:200,body:'{"data":{"r0":{"text":"interrupted'},{status:502},{status:503},{status:504}]){
    assert.deepEqual(hydrationRetry(response,0,50),{attempt:1,delayMs:15000,batchSize:25});
    assert.deepEqual(hydrationRetry(response,1,20),{attempt:2,delayMs:30000,batchSize:20});
    assert.equal(hydrationRetry(response,2,50),null);
  }
});
test('authorization, rate limits, missing sources and nonempty invalid evidence are never retried',()=>{
  for(const response of [{status:401},{status:403},{status:429},{status:404},{status:200,body:'broken JSON'},{status:200,body:'{"errors":[]}'}])assert.equal(hydrationRetry(response,0,50),null);
});
