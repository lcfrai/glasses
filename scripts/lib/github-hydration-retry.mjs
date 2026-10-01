// Only source reads with explicit transient responses are retried. Invalid
// evidence, rate limits and authorization errors always require inspection.
export function hydrationRetry(response, attempt, batchSize) {
  let truncated=false;
  if(response?.status===200&&typeof response.body==='string')try{JSON.parse(response.body);}catch(error){truncated=/Unterminated string|Unexpected end of JSON/.test(error.message);}
  const transient = truncated || [502,503,504].includes(response?.status) ||
    response?.status===200 && typeof response.body==='string' && !response.body.trim();
  if (!transient || !Number.isInteger(attempt) || attempt<0 || attempt>=2) return null;
  return {attempt:attempt+1,delayMs:15000*(attempt+1),batchSize:Math.max(1,Math.min(batchSize,25))};
}
