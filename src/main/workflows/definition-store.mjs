/**
 * 059 工作流定义存储（S1，契约 §2/§6）：草稿、不可变 revision、发布指针。
 *
 * 目录布局（userData/workflows/）：
 *   definitions/<workflowId>/revisions/<revision>.json   不可变定义
 *   definitions/<workflowId>/head.json                   当前发布指针
 *   drafts/<workflowId>.json                             草稿（可残缺，不进可运行集合）
 *
 * 写入纪律（契约 §6）：每个 workflowId 一条异步串行写链；唯一临时文件＋rename 原子替换。
 * 发布先写 revision 再更新 head——崩溃留下孤立 revision 可回收但不改变旧 head。
 * publish 必须过 validateWorkflowDocument 完整业务校验；草稿不受限。
 * 并发检测：saveDraft/publish 带 expectedRevision/expectedDraftRevision，冲突返回
 * revision-conflict，不清用户数据。
 */
import fs from 'node:fs';
import { retryingRename } from "../lib/rename-retry.mjs";
import path from 'node:path';
import crypto from 'node:crypto';

import { validateWorkflowDocument } from '../../shared/workflow.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const DEFINITION_ERRORS = {
  revisionConflict: 'revision-conflict',
  invalidGraph: 'invalid-graph',
  notFound: 'not-found',
  storageFailed: 'storage-failed',
};

export function contentHash(document) {
  return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 32);
}

/**
 * @param {object} options
 * @param {string} options.dir workflows 根目录
 * @param {object} [options.fsOps] 测试注入（mkdir/readFile/writeFile/rename/unlink/rm）
 * @param {{info?: Function, warn?: Function}} [options.log]
 */
export function createDefinitionStore({ dir, fsOps = null, log = null } = {}) {
  if (!dir) throw new Error('definition-store 缺少存储目录');
  const io = fsOps ?? {
    mkdir: (p) => fs.promises.mkdir(p, { recursive: true }),
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
    writeFile: (p, data) => fs.promises.writeFile(p, data, 'utf8'),
    rename: retryingRename((a, b) => fs.promises.rename(a, b)),
    unlink: (p) => fs.promises.unlink(p).catch(() => {}),
    readdir: (p) => fs.promises.readdir(p),
  };
  const warn = (...args) => log?.warn?.(...args);

  const chains = new Map();
  const chain = (key, job) => {
    const tail = (chains.get(key) ?? Promise.resolve()).then(job, job);
    chains.set(key, tail.catch(() => {}));
    return tail;
  };

  const draftPath = (id) => path.join(dir, 'drafts', `${id}.json`);
  const revisionsDir = (id) => path.join(dir, 'definitions', id, 'revisions');
  const headPath = (id) => path.join(dir, 'definitions', id, 'head.json');

  function assertId(id) {
    if (!ID_RE.test(String(id ?? ''))) throw workflowError(DEFINITION_ERRORS.invalidGraph, `非法 workflowId：${id}`);
  }

  async function readJson(file) {
    try {
      return JSON.parse(await io.readFile(file));
    } catch {
      return null;
    }
  }

  async function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await io.writeFile(tmp, JSON.stringify(value, null, 1));
    await io.rename(tmp, file);
  }

  async function latestRevision(id) {
    const head = await readJson(headPath(id));
    if (head) return head;
    // head 丢失时从 revision 文件恢复指针（索引可重建原则）
    try {
      const files = await io.readdir(revisionsDir(id));
      const revisions = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => Number(path.basename(f, '.json')))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => b - a);
      if (revisions.length > 0) return { workflowId: id, revision: revisions[0], recovered: true };
    } catch {
      // 目录不存在 → 无 revision
    }
    return null;
  }

  /**
   * 保存草稿（创建或覆盖）。document 不做可运行校验（草稿可残缺），只要求是对象。
   * @returns {Promise<{workflowId: string, draftRevision: number, updatedAt: number}>}
   */
  function saveDraft({ workflowId, name, description, document, expectedDraftRevision }) {
    assertId(workflowId);
    if (!document || typeof document !== 'object' || !Array.isArray(document.nodes)) {
      return Promise.reject(workflowError(DEFINITION_ERRORS.invalidGraph, '草稿必须有 nodes 数组'));
    }
    return chain(`draft:${workflowId}`, async () => {
      const existing = await readJson(draftPath(workflowId));
      if (existing && expectedDraftRevision != null && existing.draftRevision !== expectedDraftRevision) {
        throw workflowError(DEFINITION_ERRORS.revisionConflict, `草稿版本冲突：当前 ${existing.draftRevision}，期望 ${expectedDraftRevision}`);
      }
      const draft = {
        schemaVersion: 1,
        workflowId,
        name: name ?? existing?.name ?? '未命名工作流',
        description: description ?? existing?.description ?? '',
        document,
        draftRevision: (existing?.draftRevision ?? 0) + 1,
        updatedAt: Date.now(),
      };
      await io.mkdir(path.dirname(draftPath(workflowId)));
      await writeJsonAtomic(draftPath(workflowId), draft);
      return { workflowId, draftRevision: draft.draftRevision, updatedAt: draft.updatedAt };
    });
  }

  /**
   * 发布当前草稿为不可变 revision。校验失败带定位错误；成功后草稿保留（继续迭代用）。
   * @returns {Promise<{workflowId: string, revision: number, contentHash: string, issues?: Array}>}
   */
  function publish({ workflowId, expectedDraftRevision, expectedRevision } = {}) {
    assertId(workflowId);
    return chain(`publish:${workflowId}`, async () => {
      const draft = await readJson(draftPath(workflowId));
      if (!draft) throw workflowError(DEFINITION_ERRORS.notFound, `工作流 ${workflowId} 没有草稿`);
      if (expectedDraftRevision != null && draft.draftRevision !== expectedDraftRevision) {
        throw workflowError(DEFINITION_ERRORS.revisionConflict, `草稿版本冲突：当前 ${draft.draftRevision}，期望 ${expectedDraftRevision}`);
      }
      const head = await latestRevision(workflowId);
      if (expectedRevision != null && (head?.revision ?? 0) !== expectedRevision) {
        throw workflowError(DEFINITION_ERRORS.revisionConflict, `发布版本冲突：当前 ${head?.revision ?? 0}，期望 ${expectedRevision}`);
      }
      const validation = validateWorkflowDocument(draft.document);
      if (!validation.valid) {
        const error = workflowError(DEFINITION_ERRORS.invalidGraph, `图校验失败（${validation.errors.length} 项）`);
        error.issues = validation.errors;
        throw error;
      }
      const revision = (head?.revision ?? 0) + 1;
      const record = {
        schemaVersion: 1,
        workflowId,
        revision,
        name: draft.name,
        description: draft.description,
        document: draft.document,
        contentHash: contentHash(draft.document),
        createdAt: Date.now(),
      };
      await io.mkdir(revisionsDir(workflowId));
      await writeJsonAtomic(path.join(revisionsDir(workflowId), `${revision}.json`), record);
      // 写序：revision 落盘成功后才更新 head；崩溃留孤立 revision，head 仍指旧版
      await writeJsonAtomic(headPath(workflowId), { workflowId, revision, contentHash: record.contentHash, publishedAt: record.createdAt });
      return { workflowId, revision, contentHash: record.contentHash };
    });
  }

  async function getDraft(workflowId) {
    assertId(workflowId);
    return readJson(draftPath(workflowId));
  }

  async function getRevision(workflowId, revision) {
    assertId(workflowId);
    return readJson(path.join(revisionsDir(workflowId), `${Number(revision)}.json`));
  }

  async function getHead(workflowId) {
    assertId(workflowId);
    return latestRevision(workflowId);
  }

  /** 列表：各 workflow 的 head 摘要＋是否有草稿。目录即真相，无独立索引。 */
  async function list() {
    const out = [];
    const ids = new Set();
    for (const entry of ['definitions', 'drafts']) {
      try {
        for (const name of await io.readdir(path.join(dir, entry))) {
          // definitions/<id>/ 是目录；drafts/<id>.json 是文件
          const id = name.endsWith('.json') ? path.basename(name, '.json') : name;
          if (ID_RE.test(id)) ids.add(id);
        }
      } catch {
        // 子目录不存在
      }
    }
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const head = await latestRevision(id);
      const draft = await readJson(draftPath(id));
      if (!head && !draft) continue;
      let published = null;
      let graph = draft?.document;
      if (head) {
        const record = head.recovered ? null : await readJson(path.join(revisionsDir(id), `${head.revision}.json`));
        graph = record?.document ?? graph;
        published = {
          revision: head.revision,
          name: record?.name ?? draft?.name ?? id,
          description: record?.description ?? draft?.description ?? '',
          contentHash: record?.contentHash ?? null,
          createdAt: record?.createdAt ?? null,
          parameters: record?.document?.nodes?.find(node=>node.type==='hemi-input')?.data?.parameters ?? [],
        };
      }
      out.push({
        workflowId: id,
        name: published?.name ?? draft?.name ?? id,
        description: published?.description ?? draft?.description ?? '',
        published,
        parameters:published?.parameters??[],
        nodeTypes:[...new Set(graph?.nodes?.map(node=>node.type) ?? [])],
        inputTypes:[...new Set(graph?.nodes?.find(node=>node.type==='hemi-input')?.data?.parameters?.map(parameter=>parameter.type) ?? [])],
        hasDraft: Boolean(draft),
        draftRevision: draft?.draftRevision ?? null,
        updatedAt: Math.max(draft?.updatedAt ?? 0, published?.createdAt ?? 0),
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /** 删除工作流（草稿＋全部 revision＋head）。 */
  async function remove(workflowId) {
    assertId(workflowId);
    return chain(`publish:${workflowId}`, async () => {
      for (const file of [draftPath(workflowId), headPath(workflowId)]) {
        await io.unlink(file).catch(() => {});
      }
      try {
        const files = await io.readdir(revisionsDir(workflowId));
        for (const f of files) await io.unlink(path.join(revisionsDir(workflowId), f));
      } catch {
        // 没有 revision 目录
      }
      return { removed: true };
    });
  }

  return { saveDraft, publish, getDraft, getRevision, getHead, list, remove };
}

function workflowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
