import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrationBatchTarget, hydrationStartSpacing } from '../scripts/lib/github-hydration-tuning.mjs';
test('task-local batch target preserves default and can only reduce original request bounds', () => {
  assert.equal(hydrationBatchTarget(50, null), 50);
  assert.equal(hydrationBatchTarget(50, { schemaVersion: 1, batchSize: 40, reason: 'measured upstream timeout' }), 40);
  for (const batchSize of [0, -1, 51, 2.5, '40']) assert.throws(() => hydrationBatchTarget(50, { schemaVersion: 1, batchSize }));
  assert.equal(hydrationBatchTarget(5, { schemaVersion: 1, batchSize: 40 }), 5);
  assert.throws(() => hydrationBatchTarget(50, { schemaVersion: 1, batchSize: 40, concurrency: 10 }));
});
test('explicit task spacing stays bounded while absence preserves the conservative default', () => {
  assert.equal(hydrationStartSpacing(2200,null),2200);
  assert.equal(hydrationStartSpacing(2200,{schemaVersion:1,spacingMs:1500}),1500);
  assert.equal(hydrationStartSpacing(3000,{schemaVersion:1,spacingMs:5000}),5000);
  for(const spacingMs of [0,1499,60001,1500.5,'1500'])assert.throws(()=>hydrationStartSpacing(2200,{schemaVersion:1,spacingMs}));
  assert.throws(()=>hydrationStartSpacing(1000,null));
  assert.throws(()=>hydrationStartSpacing(2200,{schemaVersion:1,spacingMs:1500,concurrency:4}));
});
