/**
 * 057：flow part（kind/content/toolCallId…）→ 渲染层 TurnPart 形状（回看与流式
 * 同一形态：思考/正文/工具组，工具与派单归并成组、正文切段收口）。
 */
import type { TurnPart } from '../types/presentation.js';

export function flowPartsToTranscriptParts(
  parts: Array<{ partId: string; kind: string } & Record<string, unknown>> | null | undefined,
  { live = false }: { live?: boolean } = {},
): Array<TurnPart & { partId?: string }> | undefined {
  const mapped: Array<TurnPart & { partId?: string }> = [];
  let tools: { partId: string; type: 'tools'; calls: Array<{ id: string; tool: string; args: Record<string, string | number | boolean>; state: 'running' | 'done' | 'error' | 'stopped' }> } | null = null;
  const flushTools = () => {
    if (tools) {
      mapped.push(tools);
      tools = null;
    }
  };
  for (const part of parts ?? []) {
    if (part.kind === 'thinking') {
      flushTools();
      mapped.push({ partId: part.partId, type: 'thinking', text: String(part.content ?? ''), startedAt: Number(part.startedAt) || 0, endedAt: part.endedAt != null ? Number(part.endedAt) : live ? null : Number(part.startedAt) || 0 });
    } else if (part.kind === 'text') {
      flushTools();
      const text = String(part.content ?? '');
      if (text) mapped.push({ partId: part.partId, type: 'text', text });
    } else if (part.kind === 'deliverable') {
      // 062 会话交付物：对话流紧凑文件入口（跨运行的重复声明由时间线投影层去重）。
      flushTools();
      mapped.push({
        partId: part.partId,
        type: 'file-delivery',
        artifactId: String(part.artifactId ?? ''),
        name: String(part.name ?? '文件'),
        conversationId: typeof part.conversationId === 'string' ? part.conversationId : undefined,
        linkPath: typeof part.linkPath === 'string' ? part.linkPath : undefined,
        contentVersion: typeof part.contentVersion === 'number' ? part.contentVersion : undefined,
        size: typeof part.size === 'number' ? part.size : undefined,
        ...(part.host ? { host: String(part.host) } : {}),
        ...(typeof part.description === 'string' && part.description ? { description: part.description } : {}),
      });
    } else if (part.kind === 'tool' || part.kind === 'delegation') {
      tools ??= { partId: part.partId, type: 'tools', calls: [] };
      tools.calls.push({
        id: String(part.toolCallId ?? part.partId),
        tool: String(part.tool ?? (part.kind === 'delegation' ? 'task' : '')),
        args: (part.args ?? {}) as Record<string, string | number | boolean>,
        state: part.status === 'running' ? 'running' : part.status === 'error' ? 'error' : part.status === 'stopped' ? 'stopped' : 'done',
      });
    } else if (part.kind === 'workflow-card') {
      // 059 执行卡：参数＋进展同卡（契约 §8），独立组件渲染。
      flushTools();
      mapped.push({
        partId: part.partId,
        type: 'workflow-card',
        card: {
          invocationId: String(part.invocationId ?? ''),
          fileOutputs: Array.isArray(part.fileOutputs) ? part.fileOutputs as string[] : [],
          modelLabel: typeof part.modelLabel === 'string' ? part.modelLabel : undefined,
          cardId: typeof part.cardId === 'string' ? part.cardId : undefined,
          workflowId: typeof part.workflowId === 'string' ? part.workflowId : undefined,
          workflowRunId: typeof part.workflowRunId === 'string' ? part.workflowRunId : undefined,
          conversationId: typeof part.conversationId === 'string' ? part.conversationId : undefined,
          draftRevision: typeof part.draftRevision === 'number' ? part.draftRevision : undefined,
          executionModel: part.executionModel as ({mode:'auto'} | {mode:'fixed';modelKey:string}) | null,
          title: String(part.title ?? '工作流'),
          needsReview: Boolean(part.needsReview),
          resourceWaiting: Boolean(part.resourceWaiting),
          waitingReason: typeof part.waitingReason === 'string' ? part.waitingReason : undefined,
          status: String(part.status ?? 'starting'),
          ...(typeof part.completedCount === 'number' ? {completedCount:part.completedCount,totalCount:Number(part.totalCount)} : {}),
          ...(typeof part.currentNodeId === 'string' && part.currentNodeId ? { currentNodeId: part.currentNodeId } : {}),
          ...(part.nodes && typeof part.nodes === 'object' && !Array.isArray(part.nodes) ? { nodes: part.nodes as Extract<TurnPart, {type:'workflow-card'}>['card']['nodes'] } : {}),
          ...(part.values && typeof part.values === 'object' ? { values: part.values as Record<string, unknown> } : {}),
          ...(Array.isArray(part.issues) ? { issues: part.issues as Array<{ code: string; message: string; field?: string }> } : {}),
          ...(typeof part.ready === 'boolean' ? { ready: part.ready } : {}),
          ...(part.outputs && typeof part.outputs === 'object' ? { outputs: part.outputs as Record<string, unknown> } : {}),
          ...(typeof part.error === 'string' && part.error ? { error: part.error } : {}),
          // 059 人工输入：冻结表单／只读记录投影（挂起与提交后同卡渲染）。
          ...(part.interaction && typeof part.interaction === 'object'
            ? { interaction: part.interaction as import('../types/presentation.js').WorkflowInteractionProjection }
            : {}),
        },
      });
    }
  }
  flushTools();
  return mapped.length ? mapped : undefined;
}
