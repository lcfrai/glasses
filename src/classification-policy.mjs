import { createHash } from 'node:crypto';

// Wire shape stays compatible. Policy versions describe the evidence semantics.
export const CLASSIFICATION_SCHEMA = 'glasses-evidence-v2';
export const LEGACY_CLASSIFICATION_POLICY = 'glasses-evidence-v2';
export const CLASSIFICATION_POLICY = 'glasses-purpose-v3';

// Shared by local assessment freshness and strict public projection. Callers
// supply the same bounded public base and ordered evidence IDs, never private
// outcomes/corrections. Legacy assessments keep their original hash algorithm.
export function classificationFingerprint({ base, evidenceIds, revision = null, sourceHash = null, policy = CLASSIFICATION_POLICY }) {
  if (![LEGACY_CLASSIFICATION_POLICY, CLASSIFICATION_POLICY].includes(policy)) throw new Error('Unknown classification policy');
  const input = { schema: CLASSIFICATION_SCHEMA, ...(policy === LEGACY_CLASSIFICATION_POLICY ? {} : { policy }), ...base, evidenceIds, revision, sourceHash };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
