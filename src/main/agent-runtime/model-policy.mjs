import { createHash } from 'node:crypto';

export const ROLE_MODEL_NAMES = Object.freeze(['explorer', 'oracle', 'fixer', 'designer']);
export const DEFAULT_BUDGETS = Object.freeze({ maxRequestsPerRun: 60, maxParallelTasks: 5, maxRetryDelayMs: 10000, outputChars: 8000, connectionTimeoutMs: 60000, firstOutputTimeoutMs: 300000, streamIdleTimeoutMs: 300000 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const clean = value => {
  const { apiKey, encryptedApiKey, ...rest } = value ?? {};
  return structuredClone(rest);
};

/** 将现有角色槽位编译为内部执行计划；未配置的角色跟随 main，共用一个备用。 */
export function compileRolePolicy(roleModels) {
  if (!roleModels?.main) return null;
  const chain = primary => [...new Set([primary, roleModels.fallback].filter(Boolean))];
  return { main: chain(roleModels.main), roles: Object.fromEntries(ROLE_MODEL_NAMES.map(role => [role, chain(roleModels[role] ?? roleModels.main)])) };
}

/** 受理时冻结完整公开配置，不把 Key 写入队列或运行档案。 */
export async function freezeModelPolicy({ store, modelKey = null, fixedConfig = null, budgets = DEFAULT_BUDGETS }) {
  const directory = await store.list();
  const routed = modelKey === 'auto';
  if (routed && directory.envOverride) fail('环境变量正在覆盖模型配置，自动路由不可用；移除覆盖后重试');
  const policy = routed ? compileRolePolicy(directory.roleModels) : null;
  if (routed && !policy) fail('角色路由还没配主 agent 模型');
  const keys = routed ? [...new Set([...policy.main, ...Object.values(policy.roles).flat()])] : [modelKey ?? directory.defaultModelId];
  const candidates = {};
  for (const key of keys) {
    const resolved = fixedConfig && keys.length === 1 ? { ok: true, config: fixedConfig } : await store.resolveStrict(key);
    if (!resolved.ok) fail(resolved.message ?? `模型不可用：${key}`);
    const config = clean(resolved.config);
    candidates[key] = { ...config, credentialRef: config.providerId ?? String(key).split('/')[0], configRevision: digest(config) };
  }
  // 旧策略的 SDK 单候选次数字段不再参与调度；新计划只冻结宿主实际执行的限制。
  const { maxAttemptsPerCandidate: _legacyAttempts, ...limits } = { ...DEFAULT_BUDGETS, ...budgets };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) fail(`运行上限 ${name} 必须是正整数`);
  const payload = { version: 2, mode: routed ? 'routed' : 'fixed', policy, fixedKey: routed ? null : keys[0], candidates, budgets: limits };
  return { ...payload, id: `policy-${digest(payload)}` };
}

/** 角色配置与模态要求取交集；本函数不读取全局配置，不按型号名猜能力。 */
export function resolveModelPlan(snapshot, { role = 'main', requirements = {} } = {}) {
  if (snapshot?.version !== 2 || !snapshot.candidates) fail('缺少有效的冻结模型策略');
  if (role !== 'main' && !ROLE_MODEL_NAMES.includes(role)) fail(`未知角色：${role}`);
  if (snapshot.mode === 'routed' && !snapshot.policy?.roles) fail('执行计划已失效，请重新提交以使用角色模型配置');
  const keys = snapshot.mode === 'fixed' ? [snapshot.fixedKey]
    : role === 'main' ? snapshot.policy.main : snapshot.policy.roles[role];
  const exclusions = [], allowed = [];
  for (const key of keys) {
    const config = snapshot.candidates[key];
    if (!config) fail(`冻结策略缺少候选 ${key}`);
    let reason = null;
    if (requirements.imageInput && config.supportsVision !== true) reason = '不支持图像输入';
    if (requirements.minContextTokens && (!config.contextWindow || config.contextWindow < requirements.minContextTokens)) reason = '上下文容量不足或未知';
    if (requirements.toolCalling && config.supportsTools === false) reason = '不支持工具调用';
    if (reason) exclusions.push({ modelKey: key, reason }); else allowed.push(config);
  }
  if (!allowed.length) fail(`没有满足任务能力的已配置模型：${exclusions.map(x => `${x.modelKey} ${x.reason}`).join('；')}`);
  const plan = { policySnapshotId: snapshot.id, role, requirements: structuredClone(requirements), primary: allowed[0], allowedFallbacks: allowed.slice(1), exclusions };
  return { ...plan, id: `plan-${digest(plan)}` };
}

/** 每次请求刷新同一凭据身份的 secret，端点／模型仍使用冻结版本；删除即失败。 */
export async function hydrateCandidate(candidate, store) {
  const resolved = await store.resolveStrict(candidate.modelKey);
  if (!resolved.ok) fail(`冻结模型的凭据已不可用：${resolved.message}`);
  const current = resolved.config;
  if (candidate.credentialRef !== (current.providerId ?? String(current.modelKey).split('/')[0])) fail('冻结模型的凭据身份已变化');
  return { ...candidate, apiKey: current.apiKey };
}

export async function hydrateModelPlan(plan, store) {
  return { ...plan, primary: await hydrateCandidate(plan.primary, store), allowedFallbacks: await Promise.all(plan.allowedFallbacks.map(config => hydrateCandidate(config, store))) };
}

export function sessionCompatibility({ previous, next, workspace, previousWorkspace, roleRevision, previousRoleRevision }) {
  if (JSON.stringify(workspace ?? null) !== JSON.stringify(previousWorkspace ?? null)) return '工作区不兼容';
  if (roleRevision !== previousRoleRevision) return '角色／工具／提示词版本不兼容';
  const identity = plan => ({ primary: clean(plan?.primary ?? plan?.config), fallbacks: (plan?.allowedFallbacks ?? []).map(clean), requirements: plan?.requirements ?? {} });
  if (digest(identity(previous)) !== digest(identity(next))) return '模型计划不兼容，需要新会话';
  return null;
}
