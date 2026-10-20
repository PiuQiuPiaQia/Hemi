// 030 草稿与输入复用：按会话的未发送草稿存储（主进程唯一所有者）。
//
// 设计要点（技术方案「草稿存储与提交语义」）：
//  - 一份会话一个记录文件（userData/drafts/<id>.json），内容只有文字与版本
//    号——不含 Key、不含原始附件字节（附件身份由 028 附件库另行持有）。
//  - revision 单调守卫：受理 ACK 乱序/迟到写入不回退——只有更新的 revision
//    才覆盖；「发送只清已提交版本、期间新写的更高版本保留」由它保证。
//  - 原子写（tmp＋rename，0600）；损坏文件跳过（当无草稿处理，不中断编辑）；
//    正文长度上限保护（超限拒绝保存并如实返回）。
//  - 会话删除联动：删除会话时清对应草稿（R-03），不残留可复活数据。
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { noteActivity } from './perf.mjs';

/** 草稿正文长度上限（字符）：超出拒绝保存（多行长文也远够用）。 */
export const DRAFT_TEXT_LIMIT = 100_000;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 063：草稿里的引用/技能身份清洗（与 llm.ipc sanitizeReferenceSelections 同界的存储版）。 */
const DRAFT_REFERENCE_KINDS = new Set(['attachment', 'artifact', 'context', 'workflow', 'file', 'folder', 'conversation']);
function sanitizeDraftReferences(references) {
  if (!Array.isArray(references)) return [];
  const clean = references
    .filter((view) => view && typeof view === 'object' && typeof view.kind === 'string' && DRAFT_REFERENCE_KINDS.has(view.kind))
    .slice(0, 12)
    .map((view) => ({
      kind: view.kind,
      key: String(view.key ?? '').slice(0, 300),
      name: String(view.name ?? '引用').slice(0, 160),
      subtitle: String(view.subtitle ?? '').slice(0, 200),
      ...(typeof view.attachmentId === 'string' ? { attachmentId: view.attachmentId.slice(0, 120) } : {}),
      ...(typeof view.taskId === 'string' ? { taskId: view.taskId.slice(0, 120) } : {}),
      ...(typeof view.artifactId === 'string' ? { artifactId: view.artifactId.slice(0, 120) } : {}),
      ...(typeof view.contextId === 'string' ? { contextId: view.contextId.slice(0, 120) } : {}),
      ...(typeof view.workflowId === 'string' ? { workflowId: view.workflowId.slice(0, 120) } : {}),
      ...(Number.isFinite(view.workflowRevision) ? { workflowRevision: Number(view.workflowRevision) } : {}),
      ...(typeof view.refPath === 'string' ? { refPath: view.refPath.slice(0, 400) } : {}),
      ...(typeof view.targetConversationId === 'string' ? { targetConversationId: view.targetConversationId.slice(0, 120) } : {}),
    }));
  return clean;
}

function sanitizeDraftSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((view) => view && typeof view === 'object' && typeof view.name === 'string' && view.name.trim())
    .slice(0, 6)
    .map((view) => ({
      token: String(view.token ?? view.name).slice(0, 120),
      name: String(view.name).slice(0, 120),
      source: view.source === 'project' ? 'project' : 'library',
      skillId: String(view.skillId ?? '').slice(0, 300),
      ...(typeof view.description === 'string' && view.description ? { description: view.description.slice(0, 200) } : {}),
    }));
}

/** 单份草稿归一化（读档与保存共用）。 */
export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const conversationId = typeof raw.conversationId === 'string' ? raw.conversationId : '';
  if (!ID_RE.test(conversationId)) return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.length > DRAFT_TEXT_LIMIT) return null;
  // 063 v2：随草稿保存行内标签身份（只有文字的 v1 旧档照常读回）。
  const references = sanitizeDraftReferences(raw.references);
  const skills = sanitizeDraftSkills(raw.skills);
  return {
    version: 2,
    conversationId,
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    text,
    ...(references.length ? { references } : {}),
    ...(skills.length ? { skills } : {}),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

/**
 * 草稿存储工厂（依赖注入，离线可测）。
 * @param {object} deps
 * @param {string} deps.dir 存储目录
 * @param {Function} deps.readFile/writeFile/rename/unlink/mkdir
 */
export function createDraftStore({
  dir,
  readFile: readFileImpl = readFile,
  writeFile: writeFileImpl = writeFile,
  rename: renameImpl = rename,
  unlink: unlinkImpl = unlink,
  mkdir: mkdirImpl = mkdir,
  log = null,
} = {}) {
  function filePath(conversationId) {
    return path.join(dir, `${conversationId}.json`);
  }

  // 2026-10-01 会话审计：同一会话的保存串行化。启动时「冲刷旧草稿」与
  // 「载入触发的清空」会并发保存同一键（实测 ENOENT）：共享 tmp 被先到的
  // rename 消费后，第二个 rename 报 ENOENT 且报文吓人（「重启后可能无法
  // 恢复」）；串行化后读-判-写不再交错，revision 单调守卫也因此闭环。
  const saveChains = new Map();

  function performSave(draft) {
    noteActivity('draft-save');
    return (async () => {
      // 空草稿：直接清文件（等价于无草稿），同样过单调守卫。
      const existing = await get(draft.conversationId);
      if (existing && existing.revision > draft.revision) {
        return { ok: true, stale: true, revision: existing.revision };
      }
      try {
        await mkdirImpl(dir, { recursive: true });
        const target = filePath(draft.conversationId);
        // 唯一 tmp 名是纵深（对齐 skill-store）：即便未来绕过串行化也不互相消费。
        const temp = `${target}.${randomUUID()}.tmp`;
        await writeFileImpl(temp, `${JSON.stringify(draft, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await renameImpl(temp, target);
        if (!draft.text) {
          // 空内容落盘即「无草稿」语义——清文件最干净。
          try {
            await unlinkImpl(target);
          } catch {
            /* 清不掉不影响语义（下次读取按空处理） */
          }
        }
        return { ok: true, revision: draft.revision };
      } catch (error) {
        log?.warn(`草稿保存失败（${draft.conversationId}）：${error.message}`);
        return {
          ok: false,
          code: 'write-failed',
          message: '草稿暂时存不上：本次可以继续编辑，重启后可能无法恢复',
        };
      }
    })();
  }

  /**
   * 保存：revision 单调守卫（旧于已存的写入拒绝并如实返回）；同一会话的
   * 并发保存按键串行（入队序＝执行序），跨会话互不影响。
   * 063：skills/references（行内标签身份）与正文同批保存/清空。
   */
  function save({ conversationId, revision = 0, text = '', skills = [], references = [] }) {
    const draft = normalizeDraft({ conversationId, revision, text, skills, references, updatedAt: Date.now() });
    if (!draft) {
      return Promise.resolve({ ok: false, code: 'invalid', message: '草稿身份或正文不合法' });
    }
    const previous = saveChains.get(draft.conversationId) ?? Promise.resolve();
    const run = previous.then(() => performSave(draft));
    const done = run.then(
      () => {},
      () => {},
    ); // 链尾吞错：单次失败不断链
    saveChains.set(draft.conversationId, done);
    void done.then(() => {
      if (saveChains.get(draft.conversationId) === done) saveChains.delete(draft.conversationId);
    });
    return run;
  }

  /** 读取：损坏/缺失都按「无草稿」返回（不中断编辑）。 */
  async function get(conversationId) {
    const id = String(conversationId ?? '');
    if (!ID_RE.test(id)) return null;
    try {
      const raw = JSON.parse(await readFileImpl(filePath(id), 'utf8'));
      const draft = normalizeDraft({ ...raw, conversationId: id });
      return draft && draft.text ? draft : null;
    } catch {
      return null;
    }
  }

  /** 删除（会话删除联动；幂等）。 */
  async function remove(conversationId) {
    const id = String(conversationId ?? '');
    if (!ID_RE.test(id)) return false;
    try {
      await unlinkImpl(filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  return { save, get, remove };
}
