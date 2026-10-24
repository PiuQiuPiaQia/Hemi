/** 模型菜单与 /model 共用角色配置的就绪口径。 */
export function modelPolicyView(directory) {
  const roles = directory?.roleModels ?? {}, mainKey = roles.main ?? null;
  const available = new Map((directory?.providers ?? []).filter(provider => provider.hasApiKey).flatMap(provider => provider.models.filter(model => !model.unavailableReason).map(model => [model.modelKey, model.model])));
  const keys = ['main', 'explorer', 'oracle', 'fixer', 'designer', 'fallback'].map(slot => roles[slot]).filter(Boolean);
  const valid = Boolean(mainKey) && keys.every(key => available.has(key));
  const hint = directory?.envOverride ? '环境变量覆盖中，自动暂不生效' : !mainKey ? '未配置' : !valid ? '角色模型已失效' : `主 agent ${available.get(mainKey)}`;
  return { mainKey, mainName: available.get(mainKey) ?? null, ready: valid && !directory?.envOverride, hint };
}
