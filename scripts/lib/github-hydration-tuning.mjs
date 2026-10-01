// A task-local tuning receipt may only reduce the CLI request bound. Workers
// read it once on startup; current shards and all proof/rate guards stay fixed.
export function hydrationBatchTarget(maximum, tuning) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 50) throw Error('Invalid GraphQL batch maximum');
  if (tuning === null) return maximum;
  if (!tuning || tuning.schemaVersion !== 1 || Object.keys(tuning).some(key => !['schemaVersion', 'batchSize', 'reason', 'at'].includes(key)) || !Number.isInteger(tuning.batchSize) || tuning.batchSize < 1 || tuning.batchSize > 50) throw Error('Worker tuning must be within the original bounded GraphQL protocol');
  return Math.min(maximum, tuning.batchSize);
}

// Optional operator receipt. It changes start spacing only, never concurrency,
// proof checks, primary quota checks or upstream Retry-After/backoff state.
export function hydrationStartSpacing(defaultSpacing, tuning) {
  if (!Number.isFinite(defaultSpacing) || defaultSpacing < 2200) throw Error('Invalid default source spacing');
  if (tuning === null) return defaultSpacing;
  if (!tuning || tuning.schemaVersion !== 1 || Object.keys(tuning).some(key => !['schemaVersion', 'spacingMs', 'reason', 'at'].includes(key)) || !Number.isInteger(tuning.spacingMs) || tuning.spacingMs < 1500 || tuning.spacingMs > 60000) throw Error('Task source spacing must be1500..60000ms');
  return tuning.spacingMs;
}
