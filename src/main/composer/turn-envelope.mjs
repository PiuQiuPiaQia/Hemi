/**
 * 055 R-12 · 回合输入封装装配（从 llm.ipc 抽出，行为不变）。
 *
 * 008 D-6 工作对象、028 附件与 @ 引用 → 统一封装文本；028 多模图片在所选
 * 模型支持看图时转成 image 块，经 SDK prompt 的 images 与本轮文本一起保存。
 * 解析失败如实降级为
 * 说明块或不带封装，不吞回合。
 * 063：引用新增 workflow/file/folder/conversation 四类行内引用的受控读取；
 * 显式技能选择在此装配为执行指令块（可用性校验在 llm.ipc 派发时完成）。
 */

import { getComposerAttachments } from '../ipc/composer.ipc.mjs';
import { getConversationSession } from '../ipc/conversation.ipc.mjs';
import { getWorkContext } from '../ipc/context.ipc.mjs';
import { getWorkspaceService } from '../ipc/workspace.ipc.mjs';
import { getRemoteService } from '../remote/remote-service.mjs';
import { createWorkspaceReader } from './workspace-reader.mjs';
import { getWorkflowService } from '../workflows/workflow-service.mjs';

import {buildSkillDirectiveBlock} from '../../shared/skill-directives.mjs';
export {buildSkillDirectiveBlock};

export async function assembleTurnEnvelope({
  conversationId,
  userText,
  attachmentIds,
  references,
  skills = [],
  orchestrator = false,
  workspace = null,
  visionCapable,
  readArtifact,
  llmLog,
  turnId = 0,
}) {
  // 008 D-6／028：附件与引用封装（随本轮用户消息写入 Pi 历史）。
  let contextEnvelope = '';
  const workContext = getWorkContext();
  if (workContext?.size) {
    try {
      contextEnvelope = await workContext.resolveEnvelope(userText);
      if (contextEnvelope) llmLog.info(`turn ${turnId} 携带工作对象封装（${workContext.size} 项）`);
    } catch (error) {
      llmLog.warn(`工作对象解析失败，本回合不带封装：${error.message}`);
    }
  }
  const ids = (Array.isArray(attachmentIds) ? attachmentIds : [])
    .map((id) => (typeof id === 'string' ? id : ''))
    .filter(Boolean);
  const directImageAttachments = [];
  if (ids.length) {
    // 028：图片在所选模型支持看图时原图直传（visionCapable 由调用方按所选/
    // 交流候选能力判定后传入）。
    for (const id of ids) {
      const view = getComposerAttachments()?.get?.(conversationId, id);
      if (view?.kind === 'image' && visionCapable) {
        directImageAttachments.push(id);
      }
    }
    const envelopeIds = ids.filter((id) => !directImageAttachments.includes(id));
    try {
      if (envelopeIds.length) {
        const attachmentEnvelope = await getComposerAttachments()?.resolveEnvelopeForTurn({
          conversationId,
          attachmentIds: envelopeIds,
          question: userText,
        });
        if (attachmentEnvelope) {
          contextEnvelope = contextEnvelope
            ? `${contextEnvelope}\n\n${attachmentEnvelope}`
            : attachmentEnvelope;
        }
      }
      getComposerAttachments()?.markSent({ conversationId, attachmentIds: ids });
      if (ids.length) {
        llmLog.info(
          `turn ${turnId} 携带消息附件（${ids.length} 项${directImageAttachments.length ? `，其中 ${directImageAttachments.length} 项图片直传` : ''}）`,
        );
      }
    } catch (error) {
      llmLog.warn(`消息附件解析失败，本回合不带附件封装：${error.message}`);
    }
  }
  // 028 R-05：`@` 引用与附件同一通路（063：四类行内引用经受控 reader 解析）。
  const refs = Array.isArray(references) ? references : [];
  if (refs.length) {
    try {
      const { resolveReferencesEnvelope } = await import('../composer/references.mjs');
      const workContext2 = getWorkContext();
      const workspaceReader = createWorkspaceReader({
        getWorkspaceService: () => getWorkspaceService(),
        getRemoteService: () => getRemoteService(),
      });
      const referenceEnvelope = await resolveReferencesEnvelope({
        references: refs,
        question: userText,
        readAttachment: async (attachmentId) => {
          const view = getComposerAttachments()?.get?.(conversationId, attachmentId);
          if (!view) return { ok: false, name: '附件', message: '已失效或不在本会话' };
          const preview = await getComposerAttachments()?.readPreview?.({ conversationId, attachmentId });
          if (!preview?.ok) return { ok: false, name: view.name, message: preview?.message ?? '读取失败' };
          return {
            ok: true,
            name: view.name,
            scope: view.kind === 'image' ? '图片文件' : '文件',
            text: preview.markdown ? preview.text : preview.text,
          };
        },
        readArtifact: async (taskId, artifactId) => {
          const result = await readArtifact?.(taskId, artifactId);
          if (!result || !result.ok) return result ?? { ok: false, message: '成果已失效' };
          return result;
        },
        readContextObject: async (contextId) => workContext2?.readTextObject?.(contextId) ?? null,
        readWorkflow: async (workflowId, revision) => {
          try {
            const record = await getWorkflowService().getDefinitionRevision(workflowId, revision ?? undefined);
            if (!record) return { ok: false, message: '定义已删除或版本不存在' };
            return {
              ok: true,
              name: record.name || workflowId,
              revision: record.revision,
              text: JSON.stringify(record.document, null, 2),
            };
          } catch (error) {
            return { ok: false, message: error?.message ?? '定义读取失败' };
          }
        },
        readFileReference: (refPath) => workspaceReader.readFileReference({ workspaceId: workspace?.id ?? 'default', refPath }),
        listFolderReference: (refPath) => workspaceReader.listFolderReference({ workspaceId: workspace?.id ?? 'default', refPath }),
        readConversation: (targetConversationId) => workspaceReader.readConversationReference(
          targetConversationId,
          (id) => getConversationSession(id),
        ),
        log: llmLog,
      });
      if (referenceEnvelope) {
        contextEnvelope = contextEnvelope
          ? `${contextEnvelope}\n\n${referenceEnvelope}`
          : referenceEnvelope;
        llmLog.info(`turn ${turnId} 携带引用（${refs.length} 项）`);
      }
    } catch (error) {
      llmLog.warn(`引用解析失败，本回合不带引用封装：${error.message}`);
    }
  }
  // 063：显式技能选择的执行指令块（可用性已在派发前校验；指令随回合上下文注入）。
  const skillDirective = buildSkillDirectiveBlock(skills, { orchestrator });
  if (skillDirective) {
    contextEnvelope = contextEnvelope
      ? `${contextEnvelope}\n\n${skillDirective}`
      : skillDirective;
    llmLog.info(`turn ${turnId} 携带显式技能（${skills.length} 项）`);
  }
  // 028 多模直传：交给 SDK prompt 的 images 规范化并保存，恢复时不重新读取原文件。
  const imageBlocks = [];
  for (const id of directImageAttachments) {
    const preview = getComposerAttachments()?.readPreview?.({ conversationId, attachmentId: id });
    const match = preview?.ok && typeof preview.dataUrl === 'string'
      ? /^data:([^;,]+);base64,(.+)$/s.exec(preview.dataUrl)
      : null;
    if (match) imageBlocks.push({ type: 'image', data: match[2], mimeType: match[1] });
  }
  return { contextEnvelope, imageBlocks };
}
