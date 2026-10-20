import { runtimeDataDir } from '../agent-runtime/storage-migration.mjs';
// 028 输入资料与上下文：消息附件 IPC。
//
// 渲染层只送 {conversationId, attachmentId}／受控取得的路径或粘贴 data URL；
// 登记、校验、暂存与读取都在主进程（attachments.mjs）。llm.ipc 经
// getComposerAttachments() 拿同一实例做回合解析（与 008 工作对象同型注入）。
import { app, ipcMain, nativeImage, shell } from 'electron';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createAttachmentStore } from '../composer/attachments.mjs';
import { SLASH_COMMANDS, skillCandidatesOf } from '../composer/capability-catalog.mjs';
import { createWorkspaceFileIndex, walkWorkspaceEntries } from '../composer/workspace-file-index.mjs';
import { createBrowserFileOpener } from '../delivery/browser-open.mjs';
import { resolveVisionModelConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { getRemoteService } from '../remote/remote-service.mjs';
import { answerAboutImage } from '../services/vision-model.mjs';
import { state } from '../state.mjs';
import { collectSkills } from '../agent-runtime/index.mjs';
import { getConversationMetadata, getConversationTaskHistory, listConversationSessions } from './conversation.ipc.mjs';
import { getWorkContext } from './context.ipc.mjs';
import { getSkillService } from './skills.ipc.mjs';
import { getWorkspaceService } from './workspace.ipc.mjs';
import { getWorkflowService } from '../workflows/workflow-service.mjs';

const log = createLogger('composer');

let attachments = null;

/** llm.ipc 回合解析用（028 R-04）。 */
export function getComposerAttachments() {
  return attachments;
}

// ---- 063：`/` 与 `@` 候选的来源装配 ----

/** 会话 → 工作区视图（payload 显式携带优先；否则读会话档案；缺省 default）。 */
async function resolveConversationWorkspace(payload) {
  const conversationId = String(payload?.conversationId ?? '');
  const explicit = typeof payload?.workspaceId === 'string' && payload.workspaceId ? payload.workspaceId : null;
  const workspaceId = explicit ?? getConversationMetadata(conversationId)?.workspaceId ?? 'default';
  const view = getWorkspaceService()?.resolve(workspaceId) ?? null;
  if (!view || view.status !== 'ok') return null;
  // collectSkills 消费的工作区形状：{ host?, dir }（host 存在＝远端，跳过项目技能）。
  return { id: view.id, type: view.type, name: view.name, dir: view.dir, ...(view.host ? { host: view.host, remoteHome: view.remoteHome ?? null } : {}) };
}

/** 已发布工作流候选（引用绑定保存版本；只有草稿的定义没有稳定版本，不列）。 */
async function listWorkflowCandidates() {
  try {
    const definitions = await getWorkflowService().listDefinitions();
    return (Array.isArray(definitions) ? definitions : [])
      .filter((item) => item?.workflowId && item.published?.revision != null)
      .slice(0, 20)
      .map((item) => ({ workflowId: item.workflowId, name: item.name || '未命名工作流', revision: item.published.revision }));
  } catch {
    return [];
  }
}

/** 当前工作区的其他对话（按稳定 id 引用；不切换当前会话）。 */
function listConversationCandidates(workspace, currentConversationId) {
  try {
    const workspaceKey = workspace?.id ?? 'default';
    const listing = listConversationSessions();
    return (Array.isArray(listing) ? listing : listing?.sessions ?? [])
      .filter((session) => session.id !== currentConversationId)
      .filter((session) => (session.workspaceId ?? 'default') === workspaceKey)
      .slice(0, 8)
      .map((session) => ({
        id: session.id,
        title: session.title || '未命名对话',
        updatedHint: formatReferenceClock(session.updatedAt),
      }));
  } catch {
    return [];
  }
}

function formatReferenceClock(at) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const pad = (value) => String(value).padStart(2, '0');
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 工作区文件/文件夹索引：项目工作区才有（默认＝家目录不深扫）；本机走有界
 * BFS，远端复用 remoteFs 的 walkFiles（文件夹从文件路径派生）。TTL 缓存。
 */
const fileIndex = createWorkspaceFileIndex({
  collect: async (workspaceId) => {
    const view = getWorkspaceService()?.resolve(workspaceId) ?? null;
    if (!view || view.status !== 'ok' || view.type !== 'project' || !view.dir) return null;
    if (view.host) {
      const remoteFs = getRemoteService()?.remoteFsFor?.({ host: view.host, dir: view.dir, remoteHome: view.remoteHome ?? null });
      if (!remoteFs) return null;
      const result = await remoteFs.walkFiles(view.dir, { maxDepth: 6, limit: 1200 }).catch(() => null);
      if (!result?.ok) return null;
      const prefix = `${String(view.dir).replace(/\/+$/, '')}/`;
      const files = [];
      const folderPaths = new Set();
      for (const file of result.files ?? []) {
        const rel = String(file).startsWith(prefix) ? String(file).slice(prefix.length) : String(file);
        if (!rel || rel.includes('/..')) continue;
        files.push({ refPath: rel, name: rel.split('/').pop() });
        const parent = rel.split('/').slice(0, -1).join('/');
        if (parent) folderPaths.add(parent);
      }
      files.sort((a, b) => a.refPath.localeCompare(b.refPath));
      const folders = [...folderPaths].sort().map((refPath) => ({ refPath, name: refPath.split('/').pop() }));
      return { files, folders, truncated: Boolean(result.truncated) };
    }
    return walkWorkspaceEntries(view.dir);
  },
});

function getSkillServiceForCandidates() {
  return getSkillService();
}

/** 缩略图长边像素（48px chip × 3x 视网膜余量）。 */
const THUMBNAIL_MAX = 144;

/**
 * 图片缩略图（data URL）：nativeImage 解码＋等比缩小。JPEG 源走 JPEG 编码控体积，
 * 其余（含透明通道）保持 PNG；解码不了（如部分 webp/gif）返回 null——渲染层回退
 * 到图标 chip，不拦登记。
 */
function makeNativeThumbnail({ buffer, mime }) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(THUMBNAIL_MAX / Math.max(width, height, 1), 1);
  const resized =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        })
      : image;
  const url =
    mime === 'image/jpeg'
      ? `data:image/jpeg;base64,${resized.toJPEG(78).toString('base64')}`
      : resized.toDataURL();
  return url.length <= 300_000 ? url : null;
}

export function registerComposerIpc() {
  const openInBrowser = createBrowserFileOpener({
    openExternal: shell.openExternal,
    openPath: shell.openPath,
    log,
  });
  attachments = createAttachmentStore({
    stagingDir: path.join(runtimeDataDir(app.getPath('userData')), 'attachments'),
    // 2026-10-18 用户裁决：粘贴登记不再前置要求视觉模型——缩略图与预览先行，
    // 回合封包时按会话模型能力走直传或视觉解读，都不可用则如实降级为说明块。
    makeThumbnail: makeNativeThumbnail,
    resolveImageAnswer: async ({ question, imageData, mimeType, header }) => {
      const vision = await resolveVisionModelConfig();
      return answerAboutImage({
        baseUrl: vision.baseUrl,
        apiKey: vision.apiKey,
        model: vision.model,
        question,
        imageData,
        mimeType,
        header,
      });
    },
    openInBrowser,
    log,
  });

  /** 可读错误透传渲染层（附件托盘内联展示，不打断文字草稿）。 */
  const wrap = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      log.warn(`${label}失败：${error.message}`);
      throw error;
    }
  };

  ipcMain.handle(IPC.composer.attachFile, (_event, payload) =>
    wrap('附件登记', () =>
      attachments.attachFile({
        conversationId: payload?.conversationId,
        filePath: payload?.filePath,
        source: payload?.source === 'drop' ? 'drop' : 'picker',
      }),
    ),
  );

  ipcMain.handle(IPC.composer.attachPaste, (_event, payload) =>
    wrap('粘贴登记', () =>
      attachments.attachPasteImage({
        conversationId: payload?.conversationId,
        dataUrl: payload?.dataUrl,
      }),
    ),
  );

  ipcMain.handle(IPC.composer.removeAttachment, (_event, payload) =>
    wrap('附件移除', () =>
      attachments.remove({
        conversationId: payload?.conversationId,
        attachmentId: payload?.attachmentId,
      }),
    ),
  );

  ipcMain.handle(IPC.composer.listAttachments, (_event, payload) => ({
    attachments: attachments.list(payload?.conversationId),
  }));

  ipcMain.handle(IPC.composer.readPreview, (_event, payload) =>
    wrap('附件预览', () =>
      attachments.readPreview({
        conversationId: payload?.conversationId,
        attachmentId: payload?.attachmentId,
        stagedPath: payload?.stagedPath,
      }),
    ),
  );

  ipcMain.handle(IPC.composer.openSource, (_event, payload) =>
    wrap('附件打开', () =>
      attachments.openSource({
        conversationId: payload?.conversationId,
        attachmentId: payload?.attachmentId,
      }),
    ),
  );

  // 028 @ 引用候选（055 大重构从 llm.ipc 误删后候选永远为空，2026-10-15 找回并
  // 落到 composer.ipc）：候选＝本会话附件（含已发送）＋任务成果文件＋008 文本对象。
  // 063：新增三组行内引用——工作流（已发布定义）＋当前工作区文件/文件夹＋当前
  // 工作区其他对话；旧三类保留在尾部兼容区。技能不在此（`/` 首层，另一通道）。
  ipcMain.handle(IPC.composer.listReferences, async (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    const { buildReferenceCandidates } = await import('../composer/references.mjs');
    let taskArtifacts = [];
    try {
      taskArtifacts = (getConversationTaskHistory()?.listByConversation?.(conversationId) ?? []).flatMap((record) =>
        (record?.deliverables ?? [])
          .filter((item) => item?.id && item?.kind === 'file' && item?.path)
          .map((item) => ({
            taskId: record.taskId,
            artifactId: item.id,
            name: item.name ?? String(item.path).split('/').pop() ?? '成果文件',
            taskText: String(record.taskText ?? ''),
          })),
      );
    } catch {
      taskArtifacts = [];
    }
    const attachmentItems = (attachments.listAll?.(conversationId) ?? []).map((item) => ({
      attachmentId: item.attachmentId,
      name: item.name,
      source: item.source,
      kind: item.kind,
    }));
    const workspace = await resolveConversationWorkspace(payload);
    const [workflows, workspaceEntries, conversations] = await Promise.all([
      listWorkflowCandidates(),
      workspace ? fileIndex.entriesOf(workspace.id).catch(() => null) : Promise.resolve(null),
      listConversationCandidates(workspace, conversationId),
    ]);
    return {
      candidates: buildReferenceCandidates(
        {
          attachments: attachmentItems,
          taskArtifacts,
          contextObjects: getWorkContext()?.textObjects?.() ?? [],
          workflows,
          workspaceFiles: workspaceEntries?.files ?? [],
          workspaceFolders: workspaceEntries?.folders ?? [],
          conversations,
        },
        payload?.query,
      ),
    };
  });

  // 063：`/` 首层候选——命令（/model）＋生产可用技能（collectSkills 同源）。
  ipcMain.handle(IPC.composer.listSlashCandidates, async (_event, payload) => {
    const workspace = await resolveConversationWorkspace(payload);
    try {
      const collected = collectSkills({ skillService: getSkillServiceForCandidates(), workspace });
      try {
        return {
          commands: SLASH_COMMANDS,
          skills: skillCandidatesOf(collected.items),
        };
      } finally {
        collected.release?.();
      }
    } catch (error) {
      log.warn(`slash 候选读取失败：${error?.message ?? error}`);
      return { commands: SLASH_COMMANDS, skills: [], skillsError: '技能暂时没加载出来，可重试；命令仍可用' };
    }
  });
}
