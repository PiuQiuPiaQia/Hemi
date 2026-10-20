/** 064：角色直接使用各自模型槽位，运行计划在受理时冻结。 */
import { freezeModelPolicy, resolveModelPlan, hydrateModelPlan } from '../agent-runtime/model-policy.mjs';
export const ROLE_MODEL_FIELDS = ['main', 'explorer', 'oracle', 'fixer', 'designer', 'fallback'];
export async function resolveRoutingMain(store) {
  try {
    const policySnapshot = await freezeModelPolicy({ store, modelKey: 'auto' });
    const plan = await hydrateModelPlan(resolveModelPlan(policySnapshot), store);
    return { ok: true, config: plan.primary, policySnapshot, modelPlan: plan };
  } catch (error) { return { ok: false, message: error.message }; }
}
export async function resolveRoleModel({ role, store, mainConfig, routed = false, snapshot = null, requirements = {} }) {
  try {
    const frozen = snapshot ?? await freezeModelPolicy({ store, modelKey: routed ? 'auto' : mainConfig?.modelKey, ...(!routed ? { fixedConfig: mainConfig } : {}) });
    const modelPlan = await hydrateModelPlan(resolveModelPlan(frozen, { role: role.name, requirements }), store);
    return { ok: true, config: modelPlan.primary, modelPlan, source: routed ? 'role' : 'main' };
  } catch (error) { return { ok: false, message: error.message }; }
}
export async function resolveFallbackModel(store) {
  const main = await resolveRoutingMain(store);
  return main.ok ? { config: main.modelPlan.allowedFallbacks[0] ?? null, configs: main.modelPlan.allowedFallbacks, message: null } : { config: null, message: main.message };
}
export function roleModelsView(directory, roles) {
  const manual = directory?.roleModels ?? {};
  const models = (directory?.providers ?? []).filter(p => p.hasApiKey).flatMap(p => p.models ?? []);
  const slot = key => ({ modelKey: key ?? null, needsVision: false, ready: !key || models.some(m => m.modelKey === key), reason: key && !models.some(m => m.modelKey === key) ? 'missing' : null });
  const slots = { main: slot(manual.main), fallback: slot(manual.fallback) };
  for (const role of roles.values()) slots[role.name] = slot(manual[role.name]);
  return { slots, ready: Boolean(manual.main) && Object.values(slots).every(value => value.ready) && !directory?.envOverride };
}
