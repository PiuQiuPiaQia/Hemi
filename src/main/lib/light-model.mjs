/**
 * 055 R-01（Q5 裁决）· 轻量调用的统一选模：口（语音摘要）与会话标题共用。
 *
 * 规则：会话指定了模型 → 该模型；自动（角色路由）→ 路由的主 agent 模型（未配/失效不调用）；没选 → 默认模型。
 *
 * 返回 ResolvedConfig（profiles.resolve 的产物形状）；解析不出任何可用配置时
 * 返回 null（调用方如实降级，不猜）。
 */
export async function resolveLightModel({ getProfiles, profileId = null } = {}) {
  if (!getProfiles) return null;
  if (profileId && profileId !== 'auto') {
    const result = await getProfiles().resolveStrict(profileId);
    return result.ok ? result.config : null;
  }
  if (profileId === 'auto') {
    const directory = await getProfiles().list();
    const mainKey = directory.roleModels?.main ?? null;
    if (!mainKey || directory.envOverride) return null;
    const result = await getProfiles().resolveStrict(mainKey);
    return result.ok ? result.config : null;
  }
  return getProfiles().resolve({});
}
