// 025 → 050 · 交付登记宿主侧（唯一有 IO 的一层）：文件查证与产物绑定。
//
// register_delivery v2 的 payload 经 delivery.mjs 结构校验后到这里落地：
// - files 逐个展开/realpath/查证存在后登记为正式交付产物（deliverables 只含
//   声明的文件——write/edit 的自动登记与报告链接提取已随 050 退役）；
// - 登记范围 = 家目录 ∪ 任务工作目录（033：外接盘项目可正常登记成果），
//   且不在门控禁止清单（.ssh/.env 等；工作目录在家目录外时另查系统根区）——
//   登记不读内容，但开放任意路径会把它变成探测通道，同门控收口；
// - sources 是执行器声明的外部依据：登记器只保形状，宿主在
//   收尾时与访问记录求交标「未访问」（R-05）；
// - 文件存在 ≠ 内容正确：业务真实性仍由 010 核验负责（R-08）。
import { readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DELIVERY_IMAGE_EXTENSIONS,
  DELIVERY_IMAGE_MAX_BYTES,
  DELIVERY_LIMITS,
  validateDelivery,
} from './delivery.mjs';
import { expandTildePath } from '../history/artifacts.mjs';
import { POLICY_PATHS } from '../agent/gate/policy.mjs';

function isInsideHome(target, home) {
  const rel = path.relative(home, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 062：本机交付路径的宿主解析（登记边界＝家目录 ∪ 工作目录，realpath 展开、
 * 敏感位置拒绝、必须是真实普通文件）。从 createDeliveryRegistrar 的闭包提取——
 * 对话侧会话交付物登记（conversation-deliverables.mjs）与任务登记共用同一套
 * 口径，两边对「什么算核实过的交付文件」不出现两套规则。
 * 返回 { target } 或 { error }；不读文件内容。
 */
export function resolveDeliveryTargetPath(rawPath, { home = os.homedir(), workspaceDir = null, extraAllowed = null } = {}) {
  let homeDir = home;
  try {
    homeDir = realpathSync(home);
  } catch {
    /* 家目录不可解析时用原值，让逐文件解析去报错 */
  }
  let root = null;
  if (workspaceDir) {
    try {
      const real = realpathSync(workspaceDir);
      root = statSync(real).isDirectory() ? real : null;
    } catch {
      root = null;
    }
  }
  let target = expandTildePath(rawPath);
  if (!target) return { error: '路径为空' };
  if (!path.isAbsolute(target)) target = path.join(root ?? homeDir, target);
  let resolved;
  try {
    resolved = realpathSync(target); // 符号链接在此展开，绕行即现形
  } catch {
    return { error: '文件不存在' };
  }
  const inHome = isInsideHome(resolved, homeDir);
  const inWorkspace = Boolean(root && isInsideHome(resolved, root));
  const extraHit = Boolean(extraAllowed && extraAllowed.has(resolved));
  if (!inHome && !inWorkspace && !extraHit) return { error: '路径在家目录与工作目录之外' };
  if (hitsDenyPath(resolved, homeDir)) return { error: '路径在禁止登记的敏感位置' };
  try {
    if (!statSync(resolved).isFile()) return { error: '路径不是文件' };
  } catch {
    return { error: '文件不可访问' };
  }
  return { target: resolved };
}

function hitsDenyPath(target, home) {
  const rel = path.relative(home, target);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const firstSegment = rel.split(path.sep)[0];
    if (POLICY_PATHS.denyPathPrefixes.includes(firstSegment)) return true;
  }
  // 033：家目录外（外接盘项目）另查系统根区——/System、/Library 等禁止登记。
  if (rel.startsWith('..')) {
    return POLICY_PATHS.denyPathRoots.some((root) => target === root || target.startsWith(`${root}/`));
  }
  return false;
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// ---- 049 · 远端交付（R-11：路径带主机；查证经 SSH，绝不落到本机文件系统） ----

/**
 * 从交付 payload 收集声明过的文件路径（files + image 块；结构校验前的保守抽取）。
 * 远端任务在建登记器前先把这些路径经 SSH 查证好（异步），登记时同步消费。
 */
export function collectDeliveryPaths(payload) {
  const out = [];
  for (const file of Array.isArray(payload?.files) ? payload.files : []) {
    if (file && typeof file.path === 'string' && file.path.trim()) out.push(file.path);
  }
  for (const block of Array.isArray(payload?.blocks) ? payload.blocks : []) {
    if (block?.type === 'image' && typeof block.path === 'string' && block.path.trim()) out.push(block.path);
  }
  return out;
}

/**
 * 远端路径归一（POSIX）：~ 按远端 $HOME 展开，相对路径按远端工作目录落位。
 * 与本机 expandTildePath＋join 同一口径，登记与预查证共用，避免两套归一对不上。
 */
export function normalizeRemotePath(rawPath, { home = null, dir = null } = {}) {
  let p = String(rawPath ?? '').trim();
  if (!p) return '';
  if (home) {
    if (p === '~') p = home;
    else if (p.startsWith('~/')) p = path.posix.join(home, p.slice(2));
  }
  if (!p.startsWith('/')) p = path.posix.join(dir ?? '/', p);
  return path.posix.normalize(p);
}

/** 远端敏感位置判定（与本机 hitsDenyPath 同规则：远端家内敏感点文件 + Linux 系统根区）。 */
export function remoteDeliveryDenied(target, { home = null } = {}) {
  if (home) {
    const rel = path.posix.relative(home, target);
    if (rel && !rel.startsWith('..') && rel.length > 0) {
      const firstSegment = rel.split('/')[0];
      if (POLICY_PATHS.denyPathPrefixes.includes(firstSegment)) return true;
    }
    if (rel.startsWith('..') || rel === '') {
      return POLICY_PATHS.denyPathRootsRemote.some((root) => target === root || target.startsWith(`${root}/`));
    }
  } else {
    return POLICY_PATHS.denyPathRootsRemote.some((root) => target === root || target.startsWith(`${root}/`));
  }
  return false;
}

/**
 * 025 IPC 侧的图片读取器（只读）：按 taskId+artifactId 从档案解析目标，
 * 不发放产物 ID、不做任何登记——渲染层拿不到越出档案的文件读取通道。
 * 049：artifact 带 host 时经注入的 remoteIo 读（SSH）；remoteIo 缺席＝如实报
 * 「远端文件暂不可读」。async 化对 ipcMain.handle 透明；报告 HTML 导出里的
 * 远端图片按不可嵌处理（降级为占位，不误读本机同名路径）。
 */
export function createDeliveryImageReader({ history, remoteIo = null }) {
  async function readDeliveryImage(taskId, artifactId) {
    if (!history) return { ok: false, message: '任务档案不可用' };
    const record = history.getRecord(String(taskId ?? ''));
    if (!record || record.corrupt) return { ok: false, message: '任务记录不存在' };
    const artifact = (record.deliverables ?? []).find((item) => item?.id === String(artifactId));
    if (!artifact || artifact.kind !== 'file' || !artifact.path) {
      return { ok: false, message: '没有这个文件产物' };
    }
    const ext = path.extname(artifact.path).toLowerCase();
    if (!DELIVERY_IMAGE_EXTENSIONS.has(ext)) {
      return { ok: false, message: '不是可展示的图片类型' };
    }
    if (artifact.host) {
      const buf = remoteIo ? await remoteIo.read({ host: artifact.host, filePath: artifact.path }) : null;
      if (!buf) return { ok: false, message: `远端图片读取失败（${artifact.host}），可稍后重试` };
      if (buf.length > DELIVERY_IMAGE_MAX_BYTES) return { ok: false, message: '图片不可用或超出大小限制' };
      return { ok: true, dataUrl: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}` };
    }
    try {
      const stats = statSync(artifact.path);
      if (!stats.isFile() || stats.size > DELIVERY_IMAGE_MAX_BYTES) {
        return { ok: false, message: '图片不可用或超出大小限制' };
      }
      const data = readFileSync(artifact.path);
      return { ok: true, dataUrl: `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}` };
    } catch {
      return { ok: false, message: '图片读取失败' };
    }
  }
  return { readDeliveryImage };
}

/**
 * 026 R-05/R-06：应用内文件预览的受控读取器（只读）。与图片读取器同一寻址
 * 纪律——按 taskId+artifactId 从档案解析目标，渲染层拿不到任意路径读取通道；
 * 文本（Markdown/纯文本）限 PREVIEW_TEXT_MAX_BYTES，图片限既有交付上限。
 * 失败返回可展示的中文原因（渲染层原位呈现 + 重试），不抛错。
 */
// 062：名单同时供会话交付物读取（conversation-deliverables.mjs）复用——
// 「哪些格式能应用内预览」在任务与对话两侧必须是同一份清单。
export const PREVIEW_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;

export function createArtifactPreviewReader({ history, remoteIo = null }) {
  async function readArtifactPreview(taskId, artifactId) {
    if (!history) return { ok: false, message: '任务档案不可用' };
    const record = history.getRecord(String(taskId ?? ''));
    if (!record || record.corrupt) return { ok: false, message: '任务记录不存在' };
    const artifact = (record.deliverables ?? []).find((item) => item?.id === String(artifactId));
    if (!artifact || artifact.kind !== 'file' || !artifact.path) {
      return { ok: false, message: '没有这个文件产物' };
    }
    const ext = path.extname(artifact.path).toLowerCase();
    const isText = PREVIEW_TEXT_EXTENSIONS.has(ext);
    const isImage = DELIVERY_IMAGE_EXTENSIONS.has(ext);
    if (!isText && !isImage) {
      return { ok: false, message: '这个格式暂不支持应用内预览' };
    }
    const maxBytes = isText ? PREVIEW_TEXT_MAX_BYTES : DELIVERY_IMAGE_MAX_BYTES;
    // 049 R-11：远端产物经 SSH 读（预览栏路径带主机，无「用默认应用打开」）。
    if (artifact.host) {
      const buf = remoteIo ? await remoteIo.read({ host: artifact.host, filePath: artifact.path }) : null;
      if (!buf) return { ok: false, message: `远端文件读取失败（${artifact.host}），可稍后重试` };
      if (buf.length > maxBytes) return { ok: false, message: '文件太大，不适合应用内预览' };
      if (isText) return { ok: true, kind: 'text', markdown: ext !== '.txt', text: buf.toString('utf8') };
      return { ok: true, kind: 'image', dataUrl: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}` };
    }
    try {
      const stats = statSync(artifact.path);
      if (!stats.isFile()) return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
      if (stats.size > maxBytes) return { ok: false, message: '文件太大，不适合应用内预览' };
    } catch (error) {
      // 文件被移走/删除（ENOENT 等）要给出可行动的原因，不是笼统的读取失败。
      if (error?.code === 'ENOENT') return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
      return { ok: false, message: '文件读取失败，可重试或用系统应用打开' };
    }
    try {
      const data = readFileSync(artifact.path);
      if (isText) {
        return { ok: true, kind: 'text', markdown: ext !== '.txt', text: data.toString('utf8') };
      }
      return {
        ok: true,
        kind: 'image',
        dataUrl: `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}`,
      };
    } catch {
      return { ok: false, message: '文件读取失败，可重试或用系统应用打开' };
    }
  }
  return { readArtifactPreview };
}

/**
 * 027 R-02：预览面板路径点击的受控浏览器打开（与读取器同一寻址纪律——
 * taskId+artifactId 档案寻址，渲染层不传路径）。文件存在性与预览同一扩展名
 * 清单把关；实际「开到浏览器」交给注入的 openInBrowser（见 browser-open.mjs）。
 */
export function createArtifactPreviewOpener({ history, openInBrowser }) {
  async function openArtifactPreviewFile(taskId, artifactId) {
    if (!history) return { ok: false, message: '任务档案不可用' };
    const record = history.getRecord(String(taskId ?? ''));
    if (!record || record.corrupt) return { ok: false, message: '任务记录不存在' };
    const artifact = (record.deliverables ?? []).find((item) => item?.id === String(artifactId));
    if (!artifact || artifact.kind !== 'file' || !artifact.path) {
      return { ok: false, message: '没有这个文件产物' };
    }
    // 049 R-11：远端文件不交给本机浏览器/应用打开（同名字样本机路径是另一台机器的）。
    if (artifact.host) {
      return { ok: false, message: `这是服务器 ${artifact.host} 上的文件：请在预览栏查看，或下载到本机后再打开` };
    }
    const ext = path.extname(artifact.path).toLowerCase();
    if (!PREVIEW_TEXT_EXTENSIONS.has(ext) && !DELIVERY_IMAGE_EXTENSIONS.has(ext)) {
      return { ok: false, message: '这个格式不支持在浏览器打开' };
    }
    try {
      const stats = statSync(artifact.path);
      if (!stats.isFile()) return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
    } catch {
      return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
    }
    return openInBrowser(artifact.path);
  }
  return { openArtifactPreviewFile };
}

/**
 * 交付登记器工厂。
 * @param {object} deps
 * @param {object|null} deps.history 任务档案（null＝无档案能力，登记直接拒绝）
 * @param {Function} deps.nextArtifactId 产物 ID 发放（宿主持有全局序列）
 * @param {string} [deps.home] 家目录（注入以便离线测试）
 * @param {Function} [deps.log]
 */
export function createDeliveryRegistrar({ history, nextArtifactId, home = os.homedir(), log = null }) {
  // 家目录先 realpath：macOS 的 /var → /private/var 之类符号链接不归一会把
  // 家内文件误判成越界（TMPDIR 注入的测试环境必现）。
  let homeDir = home;
  try {
    homeDir = realpathSync(home);
  } catch {
    /* 家目录本身不存在时退回原值，让后续逐文件解析去报错 */
  }

  /**
   * 033：任务工作目录（realpath 归一）。相对路径与登记边界都按它扩展；
   * null＝旧任务（家目录语义，行为与 033 前一致）。062 起本机解析统一走
   * resolveDeliveryTargetPath（同一套边界口径）；这里的包装只保留远端分叉。
   */
  function resolveFileTarget(rawPath, { workspaceDir = null, remote = null, extraAllowed = null } = {}) {
    // 049 远端：预查证映射（宿主在登记前经 SSH 逐路径查好）；归一与查证
    // 共用 normalizeRemotePath，这里只消费结果——本机文件系统绝不接触远端路径。
    if (remote) {
      const normalized = normalizeRemotePath(rawPath, { home: remote.home, dir: remote.dir });
      if (!normalized) return { error: '路径为空' };
      const entry = remote.verified?.get(normalized);
      if (!entry) return { error: '文件没能在服务器上通过查证（连接断开或路径无效）' };
      if (!entry.ok) return { error: entry.error ?? '文件未登记' };
      return { target: entry.target, size: entry.size ?? null };
    }
    return resolveDeliveryTargetPath(rawPath, { home: homeDir, workspaceDir, extraAllowed });
  }

  /**
   * 落一条 v2 交付声明：结构校验 → 文件查证登记 → 来源形状透传。
   * 033：workspaceDir＝任务冻结的工作目录（相对路径解析与登记边界）；
   * 缺省＝旧任务家目录语义。返回 { ok: true, delivery: { files, sources } }
   * 或 { ok: false, reason }。files 全部解析失败时整体不成立（R-04——
   * 声明了交付却拿不出文件，不能算交付成功）。
   * 049 R-11：remote＝{ host, home, dir, verified }——远端任务的文件经预查证映射
   * 登记，产物带 host（渲染与打开链路按主机分叉，不落本机）。
   */
  function registerDelivery(task, payload, { at = Date.now(), workspaceDir = null, remote = null, extraAllowed = null } = {}) {
    if (!task) return { ok: false, reason: '没有正在进行的任务' };
    if (!history || !task.historyId) return { ok: false, reason: '任务档案不可用' };
    const attempt = (task.deliveryAttempts ?? 0) + 1;
    if (attempt > DELIVERY_LIMITS.attempts) {
      return { ok: false, reason: `登记次数已达上限（${DELIVERY_LIMITS.attempts}）` };
    }
    task.deliveryAttempts = attempt;

    const verdict = validateDelivery(payload);
    if (!verdict.ok) return verdict;
    const value = verdict.value;

    const degraded = [];
    const resolvedFiles = [];
    const record = history.getRecord(task.historyId);
    const existingFiles = (record && !record.corrupt ? record.deliverables : []).filter(
      (item) => item?.kind === 'file',
    );
    for (const file of value.files) {
      const resolved = resolveFileTarget(file.path, { workspaceDir, remote, extraAllowed });
      if (resolved.error) {
        degraded.push(`文件未登记（${path.basename(String(file.path))}）：${resolved.error}`);
        continue;
      }
      const duplicate = existingFiles.find((item) => item.path === resolved.target
        && (item.host ?? null) === (remote?.host ?? null));
      let id;
      if (duplicate) {
        id = duplicate.id;
        try {
          history.mergeDeliverableMeta(task.historyId, id, {
            ...(file.description ? { description: file.description } : {}),
          });
        } catch (error) {
          log?.warn(`[delivery] 产物信息合并失败：${error.message}`);
        }
      } else {
        id = nextArtifactId();
        const artifact = {
          id,
          kind: 'file',
          path: resolved.target,
          name: path.basename(resolved.target),
          ...(remote ? { host: remote.host } : {}),
          ...(file.description ? { description: file.description } : {}),
          registeredAt: at,
        };
        try {
          history.appendDeliverable(task.historyId, artifact);
        } catch (error) {
          log?.warn(`[delivery] 产物登记失败：${error.message}`);
          degraded.push(`文件登记失败：${path.basename(resolved.target)}`);
          continue;
        }
        existingFiles.push(artifact);
        task.artifacts = [...(task.artifacts ?? []), artifact];
      }
      resolvedFiles.push({ ...file, path: resolved.target, id });
    }

    // 声明了文件但全部解析失败＝整体不成立（R-04）；纯来源声明（调研任务）不受影响。
    if (!resolvedFiles.length && value.files.length) {
      return { ok: false, reason: `文件都不可用（${degraded[0] ?? '路径无法解析'}）；请核对路径后重试` };
    }

    return {
      ok: true,
      delivery: {
        schemaVersion: 2,
        files: resolvedFiles,
        sources: value.sources,
        degraded,
        registeredAt: at,
      },
    };
  }

  return { registerDelivery, resolveFileTarget };
}
