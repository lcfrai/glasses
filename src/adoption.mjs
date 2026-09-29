/** A decision scaffold, not a compatibility claim or authority to install. */
export function createAdoptionBrief(item, requirements = {}) {
  if (!item || item.kind !== 'solution') throw new Error('Choose a whole-solution candidate.');
  const goal = String(requirements.goal || '').slice(0,2000);
  const memory = /memor|forget|remember|recall/i.test(goal + ' ' + item.name + ' ' + item.description + ' ' + (item.tags||[]).join(' '));
  const supplied = Object.fromEntries(['goal','agent','os','deployment','privacy','migrationSources'].filter(key=>requirements[key]).map(key=>[key,String(requirements[key]).slice(0,2000)]));
  const required = ['goal','agent','os','deployment','privacy'];
  return {
    candidate: { id:item.id,name:item.name,url:item.url,license:item.license,licenseStatus:item.licenseStatus,origin:item.origin,provenance:item.provenance },
    requirements:supplied,
    state:'needs-assessment',
    fitConfirmed:false,
    missingContext:required.filter(key=>!supplied[key]),
    findings:[
      {criterion:'Exists',status:item.origin==='live'?'source-fetched':'unverified-reference',evidence:item.provenance?.sourceUrl||item.url},
      {criterion:'Open-source licence',status:item.licenseStatus==='known'?(item.licenseEvidence?.status==='fetched'?'versioned-source-evidence':'publisher-metadata-only'):'not-established',evidence:item.licenseEvidence||item.license||'Unknown; inspect exact version licence'},
      {criterion:'Works with this agent and environment',status:'not-tested'},
      {criterion:'Installation, import and rollback',status:'not-tested'},
    ],
    assessmentTasks: memory ? [
      'Identify the actual agent and which persistent instruction/retrieval interfaces it supports. A memory database alone does not prove the agent will use it.',
      'Distinguish memory storage/retrieval from a full replacement agent. Check whether adopting the candidate requires changing the user’s agent.',
      'Confirm memory scope: project facts, user preferences, task history, or shared team knowledge; record conflicts and precedence.',
      'Check local/cloud storage, indexing/embedding requirements, cost, deletion/export, credentials and permitted data access.',
      'Inspect importer/exporter formats and source permissions. Do not upload conversations or private code automatically.',
    ] : [
      'Compare the whole product with the requested outcome before designing a custom replacement.',
      'Inspect exact version, licence, environment support, dependencies, operating cost and maintained installation guidance.',
      'Document fit gaps and the smallest configuration or code change. Compare adoption, adaptation and custom work.',
    ],
    nextDecision:'Present candidate fit, gaps, proposed changes and an installation/import plan to the user. Obtain their choice before modifying their environment.',
    verification: memory ? [
      'Use synthetic facts in an isolated test namespace; do not import real personal history for the initial trial.',
      'Remember a small project convention; start a fresh agent session; confirm correct retrieval without repeating it.',
      'Update a fact and verify obsolete content is superseded with provenance.',
      'Ask from another project and confirm private project facts do not leak across the configured scope.',
      'Delete the fact and verify retrieval stops; test export and rollback.',
      'Only after the user selects the candidate, import authorized real data and verify record counts, failures and retrieval.',
    ] : [
      'Run the documented setup in an explicitly authorized test target.',
      'Verify the requested task end to end, including health/read-back and a failure case.',
      'Record exact versions, configuration, remaining gaps, maintenance owner and rollback procedure.',
    ],
    execution:{installed:false,imported:false,deployed:false,requiresUserChoice:true},
    localOutcomes:(item.outcomes||[]).slice(-10).map(({result,notes,context,sourceSnapshot,createdAt})=>({result,notes,context,sourceSnapshot,createdAt})),
    outcomeLimit:'Retained local outcomes may describe isolated synthetic trials. They do not establish live agent adoption or transfer compatibility to another version/environment.',
  };
}
