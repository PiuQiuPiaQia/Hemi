// 062 · 会话交付物（主进程侧）：宿主查证登记 + 受控读取/打开/链接解析。
//
// 对话里主 agent／子 agent 的 register_delivery 声明不再直接采信模型给的路径
// 字符串——这里逐文件做与任务登记同一套的宿主解析（家目录 ∪ 会话工作目录、
// realpath 展开、敏感位置拒绝、真实普通文件），核实后才写进 flow.artifacts
// 并在所属运行的助手条目上追加一个 deliverable part（对话流紧凑文件入口）。
//
// 身份口径（R-04）：文件对象按「主机 + 真实路径」识别——同一路径跨运行复用
// 同一 artifactId 与 Tab；生产记录（producers：runId/taskId/generation）随声明
// 追加。撤回按 generation 判定（编辑重发后旧代次不再进菜单），被有效运行引用
// 的文件不因某次撤回消失。文件存在 ≠ 内容正确（010 核验仍负责业务真实性）。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { conversationMedia, VIDEO_MIME } from './media-preview.mjs';

import {
  DELIVERY_IMAGE_EXTENSIONS,
  DELIVERY_IMAGE_MAX_BYTES,
} from '../delivery/delivery.mjs';
import {
  PREVIEW_TEXT_EXTENSIONS,
  normalizeRemotePath,
  remoteDeliveryDenied,
  resolveDeliveryTargetPath,
} from '../delivery/register.mjs';

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;

/** 文件对象身份（R-04）：主机 + 真实路径；同名异目录／不同主机天然不同 key。 */
export function conversationArtifactId({ host = null, target }) {
  const hostLabel = host ? String(host).replace(/[^A-Za-z0-9._-]/g, '_') : 'local';
  const sanitized = String(target).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  return `d-${hostLabel}-${sanitized}`;
}

function extOf(filePath) {
  return path.posix.extname(String(filePath ?? '')).toLowerCase() || path.extname(String(filePath ?? '')).toLowerCase();
}

/** 预览能力判定（读侧单一清单；入口侧渲染层另有同名名单）。 */
export function previewKindOf(filePath) {
  const ext = extOf(filePath);
  if (PREVIEW_TEXT_EXTENSIONS.has(ext)) return 'text';
  if (DELIVERY_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_MIME[ext]) return 'video';
  return 'unsupported';
}

/**
 * 登记一条会话交付声明（单文件）。
 *
 * @param {object} deps
 * @param {object} deps.controller 会话流控制器（applyFact／getSnapshot）
 * @param {string|null} deps.runId 生产运行（主 agent 回合 runId；后台子 agent 无在途
 *   主运行时可为 null——此时只进 flow.artifacts，不往时间线加入口）
 * @param {number|null} [deps.generation] 流代次（缺省用快照当前值）
 * @param {{path: string, description?: string}} deps.file 声明的文件（模型原文路径）
 * @param {string|null} [deps.workspaceDir] 会话绑定工作目录（本机解析基准）
 * @param {string|null} [deps.home] 家目录（注入测试；缺省 os.homedir）
 * @param {{host: string, target: string, size?: number}|null} [deps.remote]
 *   远端查证结果（049 口径：宿主经 SSH 预查证；本机文件系统不接触远端路径）
 * @param {string|null} [deps.taskId] 子 agent 任务身份（生产归属）
 * @param {Function} [deps.applyFact] 事实入口（缺省 controller.applyFact）
 * @param {object} [deps.log]
 * @returns {{ok: boolean, artifactId?: string, dropped?: string, reason?: string}}
 */
export function registerConversationDeliverable({
  controller,
  runId = null,
  generation = null,
  file,
  workspaceDir = null,
  home = null,
  remote = null,
  taskId = null,
  applyFact = null,
  log = null,
  at = Date.now(),
}) {
  if (!controller) return { ok: false, reason: '没有会话流' };
  const rawPath = typeof file?.path === 'string' ? file.path : '';
  if (!rawPath.trim()) return { ok: false, reason: '路径为空' };
  const snapshot = controller.getSnapshot();
  const gen = generation ?? snapshot.generation ?? null;

  // R-05：运行已收口后的迟到声明不新增交付（登记侧守卫；归约层 artifact-updated
  // 不带运行校验，这里必须自己拦）。runId=null（后台交付）无在途运行可判，放行。
  if (runId != null) {
    const run = snapshot.runs?.[runId];
    if (!run || run.closedAt) return { ok: false, dropped: 'run-closed' };
  }

  let target = null;
  let size = null;
  if (remote?.error) {
    // 远端预查证失败（049 口径：查证经 SSH；失败如实降级，不落本机路径）。
    log?.warn?.(`[delivery] 会话交付未登记（${path.basename(rawPath)}）：${remote.error}`);
    appendUndeliveredNotice({ controller, runId, generation: gen, name: path.basename(rawPath), reason: remote.error, applyFact, at });
    return { ok: false, reason: remote.error };
  }
  if (remote) {
    target = remote.target;
    size = remote.size ?? null;
  } else {
    const resolved = resolveDeliveryTargetPath(rawPath, {
      ...(home ? { home } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    });
    if (resolved.error) {
      log?.warn?.(`[delivery] 会话交付未登记（${path.basename(rawPath)}）：${resolved.error}`);
      appendUndeliveredNotice({ controller, runId, generation: gen, name: path.basename(rawPath), reason: resolved.error, applyFact, at });
      return { ok: false, reason: resolved.error };
    }
    target = resolved.target;
  }

  const artifactId = conversationArtifactId({ host: remote?.host ?? null, target });
  const previous = snapshot.artifacts?.[artifactId] ?? null;
  const producer = { runId, taskId, generation: gen, at };
  const producers = dedupeProducers([...(previous?.producers ?? []), producer]);
  const description = typeof file.description === 'string' && file.description.trim()
    ? file.description.slice(0, 200)
    : undefined;

  try {
    (applyFact ?? ((fact) => controller.applyFact(fact)))({
      type: 'artifact-updated',
      artifact: {
        artifactId,
        kind: 'file',
        name: path.basename(target),
        path: target,
        ...(remote?.host ? { host: remote.host } : {}),
        ...(description ? { description } : {}),
        previewKind: previewKindOf(target),
        ...(size != null ? { size } : {}),
        producerRunId: runId,
        ...(taskId ? { taskId } : {}),
        producers,
        contentVersion: (previous?.contentVersion ?? 0) + 1,
        registeredAt: at,
      },
      ...(gen == null ? {} : { generation: gen }),
    });
  } catch (error) {
    log?.warn?.(`[delivery] 会话交付登记失败（${artifactId}）：${error?.message}`);
    return { ok: false, reason: '登记失败' };
  }

  // 对话入口（R-01）：核实成功才在所属运行的助手条目上放一个紧凑文件 part；
  // 同一条目上同文件只放一个（子 agent 与主 agent 汇总声明同一成果不重复出卡）。
  if (runId != null && !timelineHasDeliverable(snapshot, runId, artifactId)) {
    try {
      (applyFact ?? ((fact) => controller.applyFact(fact)))({
        type: 'part-appended',
        runId,
        part: {
          partId: `dl-${artifactId}`,
          kind: 'deliverable',
          artifactId,
          name: path.basename(target),
          ...(remote?.host ? { host: remote.host } : {}),
          ...(description ? { description } : {}),
        },
        ...(gen == null ? {} : { generation: gen }),
      });
    } catch (error) {
      // 入口 part 失败不回滚登记事实：＋ 菜单仍可打开（如实降级，不留半成品撤销链）。
      log?.warn?.(`[delivery] 会话交付入口未上屏（${artifactId}）：${error?.message}`);
    }
  }
  return { ok: true, artifactId };
}

function dedupeProducers(producers) {
  const seen = new Set();
  const out = [];
  for (const producer of producers) {
    const key = `${producer.runId ?? 'none'}:${producer.taskId ?? ''}:${producer.generation ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(producer);
  }
  return out.slice(-12);
}

function timelineHasDeliverable(snapshot, runId, artifactId) {
  for (const item of snapshot.timeline ?? []) {
    if (item.kind !== 'assistant' || item.runId !== runId) continue;
    if ((item.parts ?? []).some((part) => part?.kind === 'deliverable' && part.artifactId === artifactId)) return true;
  }
  return false;
}

function appendUndeliveredNotice({ controller, runId, generation, name, reason, applyFact, at }) {
  if (runId == null) return;
  try {
    (applyFact ?? ((fact) => controller.applyFact(fact)))({
      type: 'part-appended',
      runId,
      part: {
        partId: `dlmiss-${runId}-${String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(-40)}-${at}`,
        kind: 'notice',
        level: 'info',
        text: `交付文件未登记（${name}）：${reason}`,
      },
      ...(generation == null ? {} : { generation }),
    });
  } catch {
    /* 归约层按身份丢弃（运行已收口等）——notice 是尽力而为的如实降级 */
  }
}

/**
 * 受控 IO（渲染层预览的消费面）。
 *
 * 寻址纪律与 026/027 的任务侧读取器一致：渲染层不持路径——正式交付按
 * conversationId+artifactId 从 flow 快照解析；Markdown 本地链接（未登记）传
 * linkPath，但主进程按会话工作区重新走同一套受控解析，不信任渲染层路径本身。
 */
export function createConversationDeliverableIo({
  flowService,
  workspaceOf = null,
  remoteIo = null,
  openInBrowser = null,
  openPath = null,
  log = null,
}) {
  function artifactOf(conversationId, artifactId, linkPath = null) {
    const controller = flowService?.has(conversationId) ? flowService.controllerFor(conversationId) : null;
    const snapshot = controller?.getSnapshot() ?? null;
    const artifact = snapshot?.artifacts?.[String(artifactId ?? '')] ?? null;
    if (artifact?.path) {
      if (artifact.host) return { artifact, snapshot };
      const checked = resolveDeliveryTargetPath(artifact.path, { workspaceDir: workspaceOf?.(conversationId)?.dir });
      if (checked.error) return { error: checked.error === '文件不存在' ? '文件不在原位置，可能已被移动或删除' : checked.error };
      return { artifact: { ...artifact, path: checked.target }, snapshot };
    }
    if (!linkPath) return { error: '没有这个交付文件' };
    // 链接对象：重新受控解析（渲染层传来的只是线索，不是通行证）。
    const workspace = workspaceOf?.(conversationId) ?? null;
    if (workspace?.host) {
      const normalized = normalizeRemotePath(linkPath, { home: workspace.home ?? null, dir: workspace.dir ?? null });
      return { artifact: { artifactId: conversationArtifactId({ host: workspace.host, target: normalized }), name: path.posix.basename(normalized), path: normalized, host: workspace.host, link: true } };
    }
    const resolved = resolveDeliveryTargetPath(linkPath, {
      ...(workspace?.dir ? { workspaceDir: workspace.dir } : {}),
    });
    if (resolved.error) return { error: resolved.error === '文件不存在' ? '文件不在原位置，可能已被移动或删除' : resolved.error };
    return { artifact: { artifactId: conversationArtifactId({ target: resolved.target }), name: path.basename(resolved.target), path: resolved.target, link: true } };
  }

  async function readConversationDeliverable(conversationId, artifactId, linkPath = null) {
    const found = artifactOf(conversationId, artifactId, linkPath);
    if (found.error) return { ok: false, message: found.error };
    const artifact = found.artifact;
    const kind = previewKindOf(artifact.path);

    if (kind === 'video') {
      if (artifact.host) return { ok: false, message: '远端视频暂不支持直接播放，请下载到本机后查看' };
      const mediaUrl = conversationMedia.register(() => {
        const current = artifactOf(conversationId, artifactId, linkPath);
        return current.error || current.artifact?.host ? null : { path: current.artifact.path, mime: VIDEO_MIME[extOf(current.artifact.path)] };
      });
      return { ok: true, kind: 'video', mediaUrl, name: artifact.name, path: artifact.path };
    }

    if (artifact.host) {
      if (!remoteIo) return { ok: false, message: `远端文件暂不可读（${artifact.host}）` };
      try {
        const buf = await remoteIo.read({ host: artifact.host, filePath: artifact.path });
        if (!buf) return { ok: false, message: `远端文件读取失败（${artifact.host}），可稍后重试` };
        return decodeBuffer(buf, artifact, kind, buf.length);
      } catch (error) {
        return { ok: false, message: `远端文件读取失败（${artifact.host}）：${error?.message ?? error}` };
      }
    }

    try {
      const stats = statSync(artifact.path);
      if (!stats.isFile()) return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
      return decodeBuffer(stats.size, artifact, kind, stats.size);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
      return { ok: false, message: '文件读取失败，可重试或用系统应用打开' };
    }
  }

  function decodeBuffer(source, artifact, kind, size) {
    if (kind === 'unsupported') {
      // R-03：范围外格式如实给文件信息与可用动作，不冒充预览成功。
      return { ok: true, kind: 'unsupported', name: artifact.name, path: artifact.path, size, message: '这个格式暂不支持应用内预览' };
    }
    const maxBytes = kind === 'text' ? PREVIEW_TEXT_MAX_BYTES : DELIVERY_IMAGE_MAX_BYTES;
    try {
      const data = typeof source === 'number' ? readFileSync(artifact.path) : source;
      if (data.length > maxBytes) return { ok: false, message: '文件太大，不适合应用内预览' };
      if (kind === 'text') {
        return { ok: true, kind: 'text', markdown: extOf(artifact.path) !== '.txt', text: data.toString('utf8'), name: artifact.name, path: artifact.path };
      }
      const ext = extOf(artifact.path);
      return { ok: true, kind: 'image', dataUrl: `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}`, name: artifact.name, path: artifact.path };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
      return { ok: false, message: '文件读取失败，可重试或用系统应用打开' };
    }
  }

  async function openConversationDeliverable(conversationId, artifactId, linkPath = null) {
    const found = artifactOf(conversationId, artifactId, linkPath);
    if (found.error) return { ok: false, message: found.error };
    const artifact = found.artifact;
    if (artifact.host) {
      return { ok: false, message: `这是服务器 ${artifact.host} 上的文件：请在预览栏查看，或下载到本机后再打开` };
    }
    try {
      if (!statSync(artifact.path).isFile()) return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
    } catch {
      return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
    }
    if (['unsupported', 'video'].includes(previewKindOf(artifact.path)) && openPath) {
      return openPath(artifact.path);
    }
    if (!openInBrowser) return { ok: false, message: '打开通道不可用' };
    return openInBrowser(artifact.path);
  }

  /**
   * R-02：显式 Markdown 本地文件链接的受控解析。成功返回可预览对象（含与正式
   * 登记同一身份函数算出的 artifactId——之后若正式声明，Tab 自然去重合并）；
   * 解析成功不写进 flow.artifacts（不冒充正式交付）。网页链接不经过这里。
   */
  async function resolveConversationLink(conversationId, href) {
    const raw = String(href ?? '').trim();
    if (!raw) return { ok: false, message: '链接为空' };
    if (/^(https?|mailto|tel):/i.test(raw)) return { ok: false, message: '网页链接不在这里打开' };
    let candidate = raw;
    if (/^file:\/\//i.test(candidate)) {
      try {
        const url = new URL(candidate);
        let pathname = url.pathname;
        // Windows 盘符两种形态都要还原：规范 file:///C:/x 的 pathname 是 /C:/x（剥前导
        // 斜杠）；手拼 file://C:/x 会把盘符吃进 host。mac 上两支都不触发（host 恒空）。
        if (/^\/[a-zA-Z]:\/?$/.test(pathname) || /^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
        else if (/^[a-zA-Z]:$/.test(url.host)) pathname = `${url.host}${pathname}`;
        candidate = decodeURIComponent(pathname);
      } catch {
        return { ok: false, message: '链接格式不对' };
      }
    }
    const workspace = workspaceOf?.(conversationId) ?? null;
    if (workspace?.host) {
      const normalized = normalizeRemotePath(candidate, { home: workspace.home ?? null, dir: workspace.dir ?? null });
      if (!normalized || remoteDeliveryDenied(normalized, { home: workspace.home ?? null })) {
        return { ok: false, message: '链接指向的位置不能打开' };
      }
      if (remoteIo) {
        try {
          const buf = await remoteIo.read({ host: workspace.host, filePath: normalized });
          if (!buf) return { ok: false, message: `服务器 ${workspace.host} 上找不到这个文件` };
        } catch {
          return { ok: false, message: `服务器 ${workspace.host} 上找不到这个文件` };
        }
      }
      return { ok: true, artifactId: conversationArtifactId({ host: workspace.host, target: normalized }), name: path.posix.basename(normalized), path: normalized, host: workspace.host };
    }
    const resolved = resolveDeliveryTargetPath(candidate, {
      ...(workspace?.dir ? { workspaceDir: workspace.dir } : {}),
    });
    if (resolved.error) {
      return { ok: false, message: resolved.error === '文件不存在' ? '文件不存在，可能已被移动或删除' : `链接打不开：${resolved.error}` };
    }
    return {
      ok: true,
      artifactId: conversationArtifactId({ target: resolved.target }),
      name: path.basename(resolved.target),
      path: resolved.target,
    };
  }

  return { readConversationDeliverable, openConversationDeliverable, resolveConversationLink };
}
