import { freezeModelPolicy } from './model-policy.mjs';

/** 受理处唯一封装：只从宿主目录取计划和工作区，不接受 renderer 伪造的解析结果。 */
export async function freezeAcceptedInput({ store, workspaceService, input }) {
  const modelPolicySnapshot = await freezeModelPolicy({ store, modelKey: input.profileId ?? null });
  const selected = workspaceService?.resolve(input.workspaceId ?? 'default');
  if (!selected || selected.status !== 'ok') throw new Error(`工作区不可用：${selected?.message ?? input.workspaceId ?? '默认空间'}`);
  const workspaceSnapshot = { id: selected.id, type: selected.type, name: selected.name, dir: selected.dir,
    ...(selected.host ? { host: selected.host, remoteHome: selected.remoteHome ?? null } : {}) };
  return { modelPolicySnapshot, workspaceSnapshot };
}
