/**
 * 027 R-05／028／056：预览 Tab 队列的纯逻辑（组件外置，供单测覆盖）。
 *
 * Tab 身份是可辨识联合：成果/报告走 {kind:'artifact', taskId, artifactId}
 * （artifactId=null＝该任务的可阅读结果，即 025 报告视图，不是磁盘文件）；
 * 028 消息附件走 {kind:'attachment', conversationId, attachmentId}；056 起子
 * agent 的执行过程也是一页 Tab（{kind:'process', taskId}，对话流角色行点击
 * 打开）。去重与激活都按真实身份，不按显示名称——同名文件、报告与附件之间
 * 的区分全落在这层。
 */

import type { TaskArtifact } from '@/shared/types';

export type PreviewTabId =
  | { kind: 'artifact'; taskId: string; artifactId: string | null }
  | { kind: 'attachment'; conversationId: string; attachmentId: string }
  | { kind: 'process'; taskId: string }
  /** 059：工作流定义预览（只读步骤结构；契约 §8 预览 Tab 身份之一）。 */
  | { kind: 'workflow-definition'; workflowId: string; revision: number }
  | { kind: 'workflow-run'; invocationId: string }
  /**
   * 062：会话交付物（主/子 agent 的正式文件交付与本地链接对象）。不依赖 taskId
   * ——寻址走 conversationId+artifactId（主进程按 flow 快照受控解析）；linkPath/
   * linkName 只在链接对象（未正式登记）时作为线索随 Tab 携带，主进程会重新受控解析。
   */
  | { kind: 'deliverable'; conversationId: string; artifactId: string; linkPath?: string; linkName?: string };

export type PreviewTabsState = {
  tabs: PreviewTabId[];
  activeKey: string | null;
};

export const EMPTY_PREVIEW_TABS: PreviewTabsState = { tabs: [], activeKey: null };

/** 带 kind 前缀的元组序列化（避免成果与附件的裸字符串拼接碰撞）。 */
export function previewTabKey(tab: PreviewTabId): string {
  if (tab.kind === 'attachment') return `attachment:${tab.conversationId}:${tab.attachmentId}`;
  if (tab.kind === 'process') return `process:${tab.taskId}`;
  if (tab.kind === 'workflow-run') return `workflow-run:${tab.invocationId}`;
  if (tab.kind === 'workflow-definition') return `workflow-definition:${tab.workflowId}:${tab.revision}`;
  if (tab.kind === 'deliverable') return `deliverable:${tab.conversationId}:${tab.artifactId}`;
  return `artifact:${tab.taskId}:${tab.artifactId ?? 'report'}`;
}

/** 本期支持应用内预览的扩展名（主进程读取侧同名单把关；这里只做入口门槛）。 */
export const PREVIEWABLE_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
]);

export function isPreviewableArtifact(artifact: TaskArtifact): boolean {
  if (artifact.kind !== 'file' || !artifact.name) return false;
  const ext = artifact.name.split('.').pop()?.toLowerCase() ?? '';
  return PREVIEWABLE_EXTENSIONS.has(ext);
}

/** 打开或激活一个 Tab：已打开只激活（不重复创建），新对象追加到队尾并激活。 */
export function openPreviewTab(state: PreviewTabsState, tab: PreviewTabId): PreviewTabsState {
  const key = previewTabKey(tab);
  if (state.tabs.some((existing) => previewTabKey(existing) === key)) {
    return state.activeKey === key ? state : { ...state, activeKey: key };
  }
  return { tabs: [...state.tabs, tab], activeKey: key };
}

/**
 * 关闭一个 Tab：非当前项只移除、当前正文不变；关闭当前项激活右侧相邻、
 * 没有右侧则左侧（FLOW 规则）；最后一个关闭后队列为空、activeKey 归 null
 * （渲染层据此收起面板）。
 */
export function closePreviewTab(state: PreviewTabsState, key: string): PreviewTabsState {
  const index = state.tabs.findIndex((tab) => previewTabKey(tab) === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  if (state.activeKey !== key) return { ...state, tabs };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeKey: next ? previewTabKey(next) : null };
}
