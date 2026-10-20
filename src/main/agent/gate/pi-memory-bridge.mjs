// 037 Phase B：每会话记忆桥（薄扩展）。
//
// 只做两件事（runtime-and-forgetting §每会话记忆桥）：
//  1. 只注册 memory_read / memory_search 两个读取入口；写入统一由主 agent
//     对话侧 memory_write 承担，遗忘／恢复／便签的底层管理仍归宿主服务。
//     读取经绑定的 MemoryClient 走宿主 store，本扩展不碰磁盘、无模块级状态；
//  2. 每次模型请求前用 context_with_system 投影：末尾追加仅本请求的
//     sections.hemi_memory（探针 M1～M9 钉死该机制），并把已过期的
//     memory_read 结果改写为「请重读」——遗忘后旧视图在工具边界失效。
//
// 钩子抛错会被 SDK 派发器吞掉（探针 M5）：投影失败时显式注入「记忆不可用」
// 段并置降级标记，写类工具在降级期间拒绝（不能拿缓存旧视图当依据）。
// 本扩展绝不返回 before_agent_start.systemPrompt——forced prompt 投影会在
// 钩子后折叠全部 system、丢弃注入段（探针 M9）。
import { createMemoryBridgeCore } from './pi-memory-bridge-core.mjs';

export default function hemiMemoryBridge(pi, { client, log = null }) {
  const core = createMemoryBridgeCore({ client, log });
  for (const tool of Object.values(core.tools)) {
    pi.registerTool(tool);
  }
  pi.on('context_with_system', async (event) => core.projectRequest(event.messages));
}
