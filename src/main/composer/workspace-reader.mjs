// 063 · `@` 文件／文件夹引用的受控读取（本机与远端统一）。
//
// 读取按「工作区身份＋相对路径」解析：本机路径做包含校验（resolve 后必须
// 仍在工作区目录内，../ 逃逸直接拒）；远端走 remoteFs（realpath 复核同一
// 包含规则）。二进制/超大文件如实说明，不吞引用块。
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';

const MAX_READ_BYTES = 64 * 1024;
const MAX_FOLDER_ENTRIES = 200;
const MAX_CONVERSATION_CHARS = 6000;

/** 相对路径规范化：剥 ./、拒绝对路径与 .. 逃逸（POSIX 形态，本机/远端通用）。 */
export function normalizeRefPath(refPath) {
  const raw = String(refPath ?? '').trim();
  if (!raw || raw.startsWith('/') || raw.includes('\\')) return null;
  const parts = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    parts.push(segment);
  }
  return parts.length ? parts.join('/') : null;
}

function withinDir(base, target) {
  const rel = path.relative(base, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {object} deps
 * @param {() => object|null} deps.getWorkspaceService
 * @param {() => object|null} deps.getRemoteService  059/049 远端服务（remoteFsFor）
 */
export function createWorkspaceReader({ getWorkspaceService, getRemoteService, fs = { realpath, readFile } } = {}) {
  async function resolveWorkspace(workspaceId) {
    const view = getWorkspaceService()?.resolve(workspaceId ?? 'default') ?? null;
    if (!view || view.status !== 'ok') return { error: view?.host ? `连不上 ${view.host}` : '工作区当前不可用' };
    return { view };
  }

  /** 文件读取（文本有界；二进制/超限如实说明）。 */
  async function readFileReference({ workspaceId, refPath }) {
    const normalized = normalizeRefPath(refPath);
    if (!normalized) return { ok: false, message: '路径不合法' };
    const resolved = await resolveWorkspace(workspaceId);
    if (resolved.error) return { ok: false, message: resolved.error };
    const { view } = resolved;
    const name = normalized.split('/').pop();
    if (view.host) {
      const remoteFs = getRemoteService()?.remoteFsFor?.({ host: view.host, dir: view.dir, remoteHome: view.remoteHome ?? null });
      if (!remoteFs) return { ok: false, message: '远端不可用' };
      const bytes = await remoteFs.readBytes(path.posix.join(view.dir, normalized), MAX_READ_BYTES + 1).catch(() => null);
      if (!bytes?.ok) return { ok: false, name, message: '文件读取失败或不存在' };
      return decodeBuffer(Buffer.from(bytes.data ?? []), name);
    }
    const base = await fs.realpath(view.dir).catch(() => view.dir);
    const target = path.resolve(base, normalized);
    if (!withinDir(base, target)) return { ok: false, name, message: '路径不在工作区内' };
    const real = await fs.realpath(target).catch(() => null);
    if (!real || !withinDir(base, real)) return { ok: false, name, message: '文件不存在' };
    const buffer = await fs.readFile(real).catch(() => null);
    if (!buffer) return { ok: false, name, message: '文件不存在或不可读' };
    return decodeBuffer(buffer, name);
  }

  /** 目录列举（单层有界；目录类型在候选/标签中保留）。 */
  async function listFolderReference({ workspaceId, refPath }) {
    const normalized = normalizeRefPath(refPath);
    if (!normalized) return { ok: false, message: '路径不合法' };
    const resolved = await resolveWorkspace(workspaceId);
    if (resolved.error) return { ok: false, message: resolved.error };
    const { view } = resolved;
    const name = normalized.split('/').pop();
    if (view.host) {
      const remoteFs = getRemoteService()?.remoteFsFor?.({ host: view.host, dir: view.dir, remoteHome: view.remoteHome ?? null });
      if (!remoteFs) return { ok: false, message: '远端不可用' };
      const entries = await remoteFs.lsEntries(path.posix.join(view.dir, normalized)).catch(() => null);
      if (!entries?.ok) return { ok: false, name, message: '目录读取失败或不存在' };
      return {
        ok: true,
        name,
        text: entries.names
          .filter((entry) => !entry.startsWith('._'))
          .slice(0, MAX_FOLDER_ENTRIES)
          .map((entry) => (entry.endsWith('/') ? `📁 ${entry.slice(0, -1)}/` : entry))
          .join('\n') || '（空目录）',
      };
    }
    const base = await fs.realpath(view.dir).catch(() => view.dir);
    const target = path.resolve(base, normalized);
    if (!withinDir(base, target)) return { ok: false, name, message: '路径不在工作区内' };
    const real = await fs.realpath(target).catch(() => null);
    if (!real || !withinDir(base, real)) return { ok: false, name, message: '目录不存在' };
    const { readdir } = await import('node:fs/promises');
    const dirents = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (!dirents) return { ok: false, name, message: '目录不可读' };
    return {
      ok: true,
      name,
      text: dirents
        .filter((entry) => !entry.name.startsWith('._'))
        .slice(0, MAX_FOLDER_ENTRIES)
        .map((entry) => (entry.isDirectory() ? `📁 ${entry.name}/` : entry.name))
        .join('\n') || '（空目录）',
    };
  }

  /** 对话引用读取（标题＋最近若干轮的有界摘录；不递归展开引用链）。 */
  function readConversationReference(targetConversationId, loadConversation) {
    const session = loadConversation?.(targetConversationId);
    if (!session || session.corrupt) return { ok: false, message: '对话不存在或已损坏' };
    const turns = Array.isArray(session.turns) ? session.turns : [];
    const recent = turns
      .filter((turn) => !turn.withdrawn && typeof turn.text === 'string' && turn.text.trim())
      .slice(-12);
    let used = 0;
    const lines = [];
    for (const turn of recent) {
      const line = `${turn.author === 'user' ? '用户' : 'Hemi'}：${turn.text.replace(/\s+/g, ' ').slice(0, 400)}`;
      if (used + line.length > MAX_CONVERSATION_CHARS) {
        lines.push('（更早内容已截断）');
        break;
      }
      used += line.length;
      lines.push(line);
    }
    return {
      ok: true,
      name: session.title || targetConversationId,
      text: lines.join('\n') || '（这段对话没有正文内容）',
    };
  }

  return { readFileReference, listFolderReference, readConversationReference };
}

function decodeBuffer(buffer, name) {
  if (buffer.length > MAX_READ_BYTES) {
    return { ok: true, name, text: `（文件 ${(buffer.length / 1024).toFixed(1)} KB，超过 ${MAX_READ_BYTES / 1024} KB 读取上限，内容未读取）` };
  }
  // NUL 字节视作二进制（UTF-8 文本不会包含 NUL）。
  if (buffer.includes(0)) return { ok: true, name, text: `（二进制文件，${buffer.length} 字节，内容未读取）` };
  return { ok: true, name, text: buffer.toString('utf8') };
}
