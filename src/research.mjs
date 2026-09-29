const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

export function validateResearchPlan(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Research plan must be an object');
  const allowed = ['name', 'query', 'enabled', 'expectedVersion'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw invalid(`Unknown research plan field: ${key}`);
  const fields = {};
  for (const [key, max] of [['name', 100], ['query', 200]]) {
    if (partial && input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) throw invalid(`${key} must be a non-empty string of at most ${max} characters`);
    fields[key] = input[key].trim();
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw invalid('enabled must be boolean');
  if (input.enabled !== undefined || !partial) fields.enabled = input.enabled ?? true;
  if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)) throw invalid('expectedVersion must be a positive integer');
  if (partial && !Object.keys(fields).length) throw invalid('Provide name, query or enabled to amend a research plan');
  return fields;
}

// The built-in broad pass is independent of user plans. Narrow briefs cannot
// replace ongoing unfamiliar-provider and whole-solution discovery.
export function createResearch({ store, discovery }) {
  const runPlan = async (id, { trigger = 'manual' } = {}) => {
    const plan = store.getResearchPlan(id);
    if (!plan) throw invalid('Research plan not found', 404);
    if (trigger === 'scheduled' && !plan.enabled) throw invalid('Research plan is paused', 409);
    return discovery.scout({ query: plan.query, planSnapshot: plan, trigger });
  };
  return {
    runPlan,
    async runScheduled() {
      if (discovery.scouting) throw invalid('A scout is already running', 409);
      const plans = store.researchPlans().filter(plan => plan.enabled);
      const rotation = store.getSetting('researchRotation', { next: 'broad', planCursor: 0 });
      if (rotation.next === 'plan' && plans.length) {
        const cursor = Number.isSafeInteger(rotation.planCursor) && rotation.planCursor >= 0 ? rotation.planCursor : 0;
        const plan = plans[cursor % plans.length];
        store.setSetting('researchRotation', { next: 'broad', planCursor: cursor + 1 });
        return runPlan(plan.id, { trigger: 'scheduled' });
      }
      store.setSetting('researchRotation', { next: 'plan', planCursor: rotation.planCursor || 0 });
      return discovery.scout({ query: '', trigger: 'scheduled' });
    }
  };
}
