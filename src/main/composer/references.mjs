// 028 R-05（第二批）：`@` 精确引用——候选注册与回合解析的纯逻辑。
//
// 设计要点（技术方案「数据契约」）：
//  - 引用是「带身份的引用而非仅有标题的文字」：候选只来自可靠注册表——
//    本会话附件（028 附件库）、任务成果文件（025 登记档案）、008 工作对象；
//    不从显示名反推路径、不收任意文件系统候选。
//  - 发送时按固定对象身份重新解析：artifact＝taskId+artifactId（跨会话核验），
//    attachment＝conversationId+attachmentId，context＝008 对象 id；
//    失效对象降级为说明块（不吞回合），与附件封装同一纪律。
import {
  buildContextEnvelope,
  clampBlocks,
  clampText,
  formatClock,
} from '../context/work-context.mjs';

/**
 * 候选来源快照 → 统一候选列表（最新优先；query 按名称/副题过滤）。
 * 063：新增三组行内引用——工作流（已发布定义）、文件／文件夹（当前工作区）、
 * 对话（当前工作区其他对话）；旧三类（附件/成果/对象）保留在尾部兼容区，
 * 不再作为首层分组。
 */
export function buildReferenceCandidates(
  {
    attachments = [],
    taskArtifacts = [],
    contextObjects = [],
    workflows = [],
    workspaceFiles = [],
    workspaceFolders = [],
    conversations = [],
  },
  query = '',
) {
  const keyword = String(query ?? '').trim().toLowerCase();
  const all = [
    ...workflows.map((item) => ({
      kind: 'workflow',
      key: `workflow:${item.workflowId}`,
      workflowId: item.workflowId,
      workflowRevision: item.revision,
      name: item.name,
      subtitle: `工作流 · v${item.revision}`,
    })),
    ...workspaceFiles.map((item) => ({
      kind: 'file',
      key: `file:${item.refPath}`,
      refPath: item.refPath,
      name: item.name,
      subtitle: `文件 · ${item.refPath}`,
    })),
    ...workspaceFolders.map((item) => ({
      kind: 'folder',
      key: `folder:${item.refPath}`,
      refPath: item.refPath,
      name: item.name,
      subtitle: `文件夹 · ${item.refPath}`,
    })),
    ...conversations.map((item) => ({
      kind: 'conversation',
      key: `conversation:${item.id}`,
      targetConversationId: item.id,
      name: item.title || '未命名对话',
      subtitle: `对话 · ${item.updatedHint ?? ''}`.trim(),
    })),
    // 旧三类：兼容既有 @ 用法（托盘芯片），排在新分组之后。
    ...attachments.map((item) => ({
      kind: 'attachment',
      key: item.attachmentId,
      attachmentId: item.attachmentId,
      name: item.name,
      subtitle: `消息附件 · ${item.source === 'paste' ? '粘贴图片' : '文件'}`,
    })),
    ...taskArtifacts.map((item) => ({
      kind: 'artifact',
      key: `${item.taskId}:${item.artifactId}`,
      taskId: item.taskId,
      artifactId: item.artifactId,
      name: item.name,
      subtitle: `任务成果 · ${item.taskText.slice(0, 18)}`,
    })),
    ...contextObjects.map((item) => ({
      kind: 'context',
      key: item.id,
      contextId: item.id,
      name: item.title,
      subtitle: `当前对象 · ${item.source}`,
    })),
  ];
  if (!keyword) return all.slice(0, 20);
  return all
    .filter((item) => item.name.toLowerCase().includes(keyword) || item.subtitle.toLowerCase().includes(keyword))
    .slice(0, 20);
}

/**
 * 发送时解析：各来源由 provider 提供「读正文」（同步文本或异步）。
 * 失效/不可读＝说明块；与附件一致经统一封装进入末条 user 消息。
 * 063：workflow/file/folder/conversation 四类行内引用同此纪律——按固定身份
 * 解析，失效降级说明块不吞回合；工作流引用只带定义快照，不隐式启动运行。
 */
export async function resolveReferencesEnvelope({
  references,
  question = '',
  readAttachment,
  readArtifact,
  readContextObject,
  readWorkflow,
  readFileReference,
  listFolderReference,
  readConversation,
  log = null,
}) {
  const list = (Array.isArray(references) ? references : []).filter(Boolean);
  if (!list.length) return '';
  const blocks = [];
  for (const reference of list) {
    try {
      if (reference.kind === 'attachment') {
        const result = await readAttachment?.(reference.attachmentId);
        if (!result || !result.ok) {
          blocks.push({ header: `来源：引用「${result?.name ?? '附件'}」—— ${result?.message ?? '已失效'}`, text: '' });
          continue;
        }
        blocks.push({
          header: `来源：引用附件「${result.name}」（${result.scope ?? ''}）`,
          text: result.text ?? '',
        });
        continue;
      }
      if (reference.kind === 'artifact') {
        const result = await readArtifact?.(reference.taskId, reference.artifactId);
        if (!result || !result.ok) {
          blocks.push({ header: `来源：引用「${result?.name ?? '成果文件'}」—— ${result?.message ?? '已失效'}`, text: '' });
          continue;
        }
        blocks.push({
          header: `来源：引用任务成果「${result.name}」（任务 ${reference.taskId}，${result.scope ?? ''}）`,
          text: result.text ?? '',
        });
        continue;
      }
      if (reference.kind === 'context') {
        const result = await readContextObject?.(reference.contextId);
        if (!result || !result.ok) {
          blocks.push({ header: `来源：引用「${result?.name ?? '当前对象'}」—— ${result?.message ?? '已失效'}`, text: '' });
          continue;
        }
        blocks.push({
          header: `来源：引用当前对象「${result.name}」（${result.scope ?? ''}，采集于 ${result.capturedAt ? formatClock(result.capturedAt) : ''}）`,
          text: result.text ?? '',
        });
        continue;
      }
      if (reference.kind === 'workflow') {
        const result = await readWorkflow?.(reference.workflowId, reference.workflowRevision);
        if (!result || !result.ok) {
          blocks.push({ header: `来源：引用工作流「${result?.name ?? reference.workflowId ?? '工作流'}」—— ${result?.message ?? '定义已失效'}`, text: '' });
          continue;
        }
        blocks.push({
          header: `来源：引用工作流「${result.name}」（v${result.revision} 的已保存定义；这里只是引用定义供讨论，不代表已运行）`,
          text: result.text ?? '',
        });
        continue;
      }
      if (reference.kind === 'file') {
        const result = await readFileReference?.(reference.refPath);
        if (!result || !result.ok) {
          blocks.push({ header: `来源：引用文件「${result?.name ?? reference.refPath ?? '文件'}」—— ${result?.message ?? '已失效'}`, text: '' });
          continue;
        }
        blocks.push({
          header: `来源：引用文件「${result.name}」（工作区相对路径 ${reference.refPath}）`,
          text: result.text ?? '',
        });
        continue;
      }
      if (reference.kind === 'folder') {
        const result = await listFolderReference?.(reference.refPath);
        if (!result || !result.ok) {
          blocks.push({ header: `来源：引用文件夹「${result?.name ?? reference.refPath ?? '目录'}」—— ${result?.message ?? '已失效'}`, text: '' });
          continue;
        }
        blocks.push({
          header: `来源：引用文件夹「${result.name}」的目录清单（工作区相对路径 ${reference.refPath}；按需读取，不上传整包）`,
          text: result.text ?? '',
        });
        continue;
      }
      if (reference.kind === 'conversation') {
        const result = await readConversation?.(reference.targetConversationId);
        if (!result || !result.ok) {
          blocks.push({ header: `来源：引用对话「${result?.name ?? '对话'}」—— ${result?.message ?? '已失效'}`, text: '' });
          continue;
        }
        blocks.push({
          header: `来源：引用对话「${result.name}」（会话 ${reference.targetConversationId} 的最近内容摘录）`,
          text: result.text ?? '',
        });
        continue;
      }
      blocks.push({ header: '来源：引用（未知类型，已忽略）', text: '' });
    } catch (error) {
      log?.warn?.(`引用解析失败（${reference?.kind}）：${error.message}`);
      blocks.push({ header: `来源：引用 —— 解析失败：${error.message}`, text: '' });
    }
  }
  void question;
  void clampText;
  return buildContextEnvelope(clampBlocks(blocks));
}
