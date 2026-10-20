import { freezeModelPolicy, resolveModelPlan, hydrateModelPlan } from '../agent-runtime/model-policy.mjs';
const publicConfig = ({ apiKey, ...config }) => structuredClone(config);
export async function freezeWorkflowModel({ selection, store, roles }) {
  const policySnapshot = await freezeModelPolicy({ store, modelKey: selection?.mode === 'auto' ? 'auto' : selection?.modelKey });
  const modelPlan = resolveModelPlan(policySnapshot);
  const roleModels = {};
  for (const [name] of roles) {
    try { roleModels[name] = publicConfig(resolveModelPlan(policySnapshot, { role: name }).primary); } catch { /* 不可用角色不进入路由卡 */ }
  }
  return { version: 2, policySnapshot, modelPlan, routed: policySnapshot.mode === 'routed', config: publicConfig(modelPlan.primary), fallback: modelPlan.allowedFallbacks[0] ?? null, roleModels };
}
export async function hydrateWorkflowModel(plan, store) {
  if (plan?.version !== 2 || !plan.policySnapshot) throw new Error('该执行计划需要重新确认模型配置；历史结果仍可查看，不会自动重跑');
  const modelPlan = await hydrateModelPlan(resolveModelPlan(plan.policySnapshot), store);
  const roleModels = {};
  for (const name of Object.keys(plan.roleModels ?? {})) roleModels[name] = (await hydrateModelPlan(resolveModelPlan(plan.policySnapshot, { role: name }), store)).primary;
  return { ...plan, modelPlan, config: modelPlan.primary, fallback: modelPlan.allowedFallbacks[0] ?? null, roleModels };
}
