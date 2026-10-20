// 028 输入资料与上下文：本条消息附件的登记、受控读取与回合解析。
//
// 设计要点（技术方案「数据契约与受理边界」）：
//  - 附件身份 = attachmentId（主进程登记），绑定 conversationId；渲染层只持元数据
//    视图，不持原始 File／data URL——草稿与历史都不落原始字节。
//  - 读取只按 {conversationId, attachmentId} 受控寻址：跨会话、未登记、源文件失效
//    都返回结构化错误码与可读文案，不把展示名或路径当身份（027 R-07 同款纪律）。
//  - 文件类附件不复制内容：登记时校验可读性与预算，预览／回合封包时按路径受控
//    重读；粘贴图片例外——字节只在渲染进程里，必须落受控暂存区才有稳定身份。
//  - 回合解析与 008 工作对象同一形态：文本块进统一封装（buildContextEnvelope），
//    图片经注入的视觉客户端按用户问题解读成可追溯文字（技术方案：图片首批走
//    视觉解读链路，不原图直传）。
//  - 纯函数（data URL 解析／视图构造／格式化）与 IO 分离，node --test 直接覆盖。
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  IMAGE_FILE_BYTE_LIMIT,
  TEXT_FILE_BYTE_LIMIT,
  buildContextEnvelope,
  clampBlocks,
  clampText,
  formatClock,
} from '../context/work-context.mjs';

/** 单条消息的附件数上限（技术方案候选值；超限在登记时拒绝）。 */
export const MAX_ATTACHMENTS_PER_TURN = 3;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const IMAGE_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const PASTE_NAME_PREFIX = '粘贴图片';

/** 按文件名判断附件种类：'text' | 'image' | null（null＝首批不收的格式）。 */
export function guessAttachmentKind(filename) {
  const ext = path.extname(String(filename ?? '')).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

/** data URL → { mime, base64, bytes }；不是合法 data URL 返回 null。 */
export function parseDataUrl(dataUrl) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    String(dataUrl ?? '').trim(),
  );
  if (!match) return null;
  const base64 = match[2].replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) return null;
  return { mime: match[1].toLowerCase(), base64, bytes };
}

/** 人读的体积文案（预览卡与拒绝理由共用）。 */
export function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 登记记录 → 渲染层视图（不含路径以外的原始内容；路径只作来源信息展示）。 */
export function attachmentView(record) {
  return {
    attachmentId: record.attachmentId,
    conversationId: record.conversationId,
    name: record.name,
    kind: record.kind,
    sizeBytes: record.sizeBytes,
    status: record.status,
    message: record.message ?? '',
    source: record.source,
    originPath: record.source === 'paste' ? '' : record.originPath,
    registeredAt: record.registeredAt,
    // 小缩略图随视图走：草稿托盘、历史气泡与入档冻结共用同一份（跨重启仍可显示）。
    ...(record.thumbnailUrl ? { thumbnailUrl: record.thumbnailUrl } : {}),
    // 粘贴图片的暂存路径：重启后登记表为空时，预览读取按它做受控回退（只认暂存区内）。
    ...(record.source === 'paste' && record.originPath ? { stagedPath: record.originPath } : {}),
  };
}

function failureCodeMessage(record, error) {
  if (error?.code === 'ENOENT') {
    return { code: 'source-missing', message: '原文件不在登记时的位置，可能已被移动或删除' };
  }
  return { code: 'read-failed', message: '文件现在读不了，稍后再试' };
}

/**
 * 附件库。注入项：
 *  - stagingDir：粘贴图片的受控暂存目录（userData 下；目录不存在会建）
 *  - makeThumbnail({ buffer, mime }): string | null —— 图片缩略图生成（Electron
 *    nativeImage 实现；纯 Node 测试注入桩或省略＝不带缩略图）。2026-10-18 起
 *    图片登记不再前置要求视觉模型（用户裁决）：登记与展示先行，回合封包时按
 *    会话模型能力走直传或视觉解读，两者都不可用则如实降级为说明块。
 *  - resolveImageAnswer({ question, imageData, mimeType, header }): Promise<string>
 *  - openInBrowser(fileUrl): Promise<{ ok, message? }> —— 工具栏路径点击的受控打开
 *  - log
 */
export function createAttachmentStore({
  stagingDir,
  makeThumbnail = null,
  resolveImageAnswer = null,
  openInBrowser = null,
  log = null,
} = {}) {
  let seq = 0;
  /** attachmentId → record；插入序即列表序。内存存储，退出即清（与 008 一致）。 */
  const records = new Map();

  /** 草稿视图：只列未发送的（发送过的继续可按身份预览，但不再出现在准备区）。 */
  function list(conversationId) {
    const scope = String(conversationId ?? '');
    return [...records.values()]
      .filter((record) => record.conversationId === scope && !record.sent)
      .map(attachmentView);
  }

  /** 全量视图（含已发送）——预览 Tab 元数据按 attachmentId 查询用。 */
  function get(conversationId, attachmentId) {
    const owned = ownedRecord(conversationId, attachmentId);
    return owned.error ? null : attachmentView(owned.record);
  }

  /** 028 @ 引用候选：本会话全部附件（含已发送，最新在前）。 */
  function listAll(conversationId) {
    const scope = String(conversationId ?? '');
    return [...records.values()]
      .filter((record) => record.conversationId === scope)
      .reverse()
      .map(attachmentView);
  }

  function assertConversation(conversationId) {
    const scope = String(conversationId ?? '').trim();
    if (!scope) throw new Error('附件需要先确定会话身份');
    return scope;
  }

  function assertCapacity(conversationId) {
    const used = list(conversationId).length;
    if (used >= MAX_ATTACHMENTS_PER_TURN) {
      throw new Error(`一条消息最多带 ${MAX_ATTACHMENTS_PER_TURN} 个附件，先移除一个再试`);
    }
  }

  function addRecord(conversationId, partial) {
    seq += 1;
    const record = {
      attachmentId: `att-${seq}`,
      conversationId,
      status: 'ready',
      registeredAt: Date.now(),
      ...partial,
    };
    records.set(record.attachmentId, record);
    log?.info(
      `登记附件 ${record.attachmentId}：${record.source}「${record.name}」（${record.kind}，${formatBytes(record.sizeBytes)}）`,
    );
    return record;
  }

  /** 缩略图生成失败不拦登记（渲染层回退到图标 chip），只在日志留痕。 */
  function thumbnailOf(buffer, mime) {
    if (typeof makeThumbnail !== 'function') return null;
    try {
      const url = makeThumbnail({ buffer, mime });
      return typeof url === 'string' && url.startsWith('data:') ? url : null;
    } catch (error) {
      log?.warn(`附件缩略图生成失败：${error.message}`);
      return null;
    }
  }

  /** 文件类附件（选择窗／拖入共用）：realpath 解析后校验类型与预算，内容不复制。 */
  function attachFile({ conversationId, filePath, source }) {
    const scope = assertConversation(conversationId);
    assertCapacity(scope);
    const kindAllowed = source === 'drop' || source === 'picker';
    if (!kindAllowed) throw new Error('未知的附件来源');
    const cleanPath = String(filePath ?? '').trim();
    if (!cleanPath) throw new Error('没有拿到文件路径');
    let resolved;
    try {
      resolved = realpathSync(cleanPath);
    } catch {
      throw new Error('文件读不到：可能已被移动或删除');
    }
    let stats;
    try {
      stats = statSync(resolved);
    } catch {
      throw new Error('文件读不到：可能已被移动或删除');
    }
    if (stats.isDirectory()) throw new Error('选中的是文件夹，本期只支持单个文件');
    const kind = guessAttachmentKind(resolved);
    if (!kind) {
      throw new Error('暂不支持这种格式：首版支持 txt/md 与图片（jpg/png/webp/gif）');
    }
    if (kind === 'text' && stats.size > TEXT_FILE_BYTE_LIMIT * 4) {
      throw new Error(`文件太大（${formatBytes(stats.size)}），文本附件支持 2MB 内`);
    }
    if (kind === 'image' && stats.size > IMAGE_FILE_BYTE_LIMIT) {
      throw new Error(`图片太大（${formatBytes(stats.size)}），支持 8MB 内`);
    }
    const thumbnailUrl =
      kind === 'image'
        ? thumbnailOf(readFileSync(resolved), MIME_BY_EXT[path.extname(resolved).toLowerCase()] ?? 'image/png')
        : null;
    const record = addRecord(scope, {
      kind,
      source,
      name: path.basename(resolved),
      originPath: resolved,
      sizeBytes: stats.size,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    });
    return { ok: true, attachment: attachmentView(record), attachments: list(scope) };
  }

  /** 粘贴图片：字节来自渲染进程，必须落受控暂存区才有稳定身份与重读能力。 */
  async function attachPasteImage({ conversationId, dataUrl }) {
    const scope = assertConversation(conversationId);
    assertCapacity(scope);
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw new Error('粘贴的内容不是可用的图片');
    const ext = IMAGE_MIME[parsed.mime];
    if (!ext) throw new Error(`暂不支持的图片类型：${parsed.mime}`);
    if (parsed.bytes.length > IMAGE_FILE_BYTE_LIMIT) {
      throw new Error(`图片太大（${formatBytes(parsed.bytes.length)}），支持 8MB 内`);
    }
    if (!stagingDir) throw new Error('当前环境不支持粘贴附件');
    mkdirSync(stagingDir, { recursive: true });
    const attachmentId = `att-${seq + 1}`;
    const staged = path.join(stagingDir, `${attachmentId}${ext}`);
    writeFileSync(staged, parsed.bytes);
    const thumbnailUrl = thumbnailOf(parsed.bytes, parsed.mime);
    const record = addRecord(scope, {
      kind: 'image',
      source: 'paste',
      name: `${PASTE_NAME_PREFIX} ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(Date.now())}`,
      originPath: staged,
      sizeBytes: parsed.bytes.length,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    });
    return { ok: true, attachment: attachmentView(record), attachments: list(scope) };
  }

  /** 移除未发送附件：撤销登记；粘贴图片的暂存字节一并清理。 */
  function remove({ conversationId, attachmentId }) {
    const scope = assertConversation(conversationId);
    const record = records.get(String(attachmentId ?? ''));
    if (!record || record.conversationId !== scope) {
      return { ok: false, code: 'unknown', attachments: list(scope) };
    }
    records.delete(record.attachmentId);
    if (record.source === 'paste') {
      try {
        unlinkSync(record.originPath);
      } catch {
        /* 暂存文件清不掉不影响功能 */
      }
    }
    log?.info(`移除附件 ${record.attachmentId}「${record.name}」`);
    return { ok: true, attachments: list(scope) };
  }

  function ownedRecord(conversationId, attachmentId) {
    const scope = String(conversationId ?? '');
    const record = records.get(String(attachmentId ?? ''));
    if (!record) {
      return { error: { ok: false, code: 'unknown', message: '附件不存在或已被移除' } };
    }
    if (record.conversationId !== scope) {
      return { error: { ok: false, code: 'cross-conversation', message: '附件属于另一个会话' } };
    }
    return { record };
  }

  /**
   * 重启后的登记表为空：粘贴图片按档案冻结的暂存路径受控回退。只认暂存目录内、
   * 图片扩展名的文件——路径来自本机会话档案，但校验边界不依赖档案可信（不把
   * 回退通道变成任意路径读取）。文件类附件不回退（原路径跨重启本就可能失效，
   * 失败按既有错误码如实返回）。
   */
  function stagedFallbackRecord(stagedPath) {
    const clean = String(stagedPath ?? '').trim();
    if (!clean || !stagingDir) return null;
    let resolved;
    let root;
    try {
      resolved = realpathSync(clean);
      root = realpathSync(stagingDir);
    } catch {
      return null;
    }
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return null;
    try {
      statSync(resolved);
    } catch {
      return null;
    }
    return {
      attachmentId: '',
      conversationId: '',
      status: 'ready',
      registeredAt: 0,
      kind: 'image',
      source: 'paste',
      name: path.basename(resolved),
      originPath: resolved,
      sizeBytes: 0,
    };
  }

  /**
   * 受控预览读取：与 027 成果预览同一结果形状（{ok, kind, markdown?, text?,
   * dataUrl?, message?}），渲染层复用现有文本／图片渲染器。
   */
  function readPreview({ conversationId, attachmentId, stagedPath }) {
    const owned = ownedRecord(conversationId, attachmentId);
    const record =
      owned.record ??
      (owned.error?.code === 'unknown' ? stagedFallbackRecord(stagedPath) : null);
    if (!record) return owned.error;
    try {
      const buffer = readFileSync(record.originPath);
      if (record.kind === 'image') {
        const mime = MIME_BY_EXT[path.extname(record.originPath).toLowerCase()] ?? 'image/png';
        return { ok: true, kind: 'image', dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
      }
      const truncatedBytes = buffer.length > TEXT_FILE_BYTE_LIMIT;
      const text = buffer.subarray(0, TEXT_FILE_BYTE_LIMIT).toString('utf8');
      const clamped = clampText(text);
      return {
        ok: true,
        kind: 'text',
        markdown: /\.(md|markdown)$/i.test(record.originPath),
        text: truncatedBytes
          ? `${clamped.text}\n（文件超出读取上限，仅保留前段内容）`
          : clamped.text,
      };
    } catch (error) {
      const { code, message } = failureCodeMessage(record, error);
      return { ok: false, code, message };
    }
  }

  /** 工具栏路径点击：受控打开原文件（粘贴图片没有原文件，明确说明）。 */
  async function openSource({ conversationId, attachmentId }) {
    const owned = ownedRecord(conversationId, attachmentId);
    if (owned.error) return owned.error;
    const record = owned.record;
    if (record.source === 'paste') {
      return { ok: false, code: 'no-source', message: '粘贴的图片没有原文件路径' };
    }
    try {
      statSync(record.originPath);
    } catch {
      return { ok: false, code: 'source-missing', message: '原文件不在登记时的位置，无法打开' };
    }
    if (typeof openInBrowser !== 'function') {
      return { ok: false, code: 'unsupported', message: '当前环境不支持打开原文件' };
    }
    return openInBrowser(record.originPath);
  }

  /**
   * 回合解析（028 R-04）：把本轮附件解析成统一文本封装，追加到最后一条 user
   * 消息——与 008 工作对象同一通路（llm.ipc 合并调用）。文本按读取预算直读；
   * 图片经视觉客户端按用户问题解读，失败降级为说明块（不吞回合）。
   */
  async function resolveEnvelopeForTurn({ conversationId, attachmentIds, question }) {
    const ids = (Array.isArray(attachmentIds) ? attachmentIds : [])
      .map((id) => String(id ?? ''))
      .filter(Boolean);
    if (!ids.length) return '';
    const scope = String(conversationId ?? '');
    const ask = String(question ?? '').trim() || '请描述这份资料里的内容';
    const blocks = [];
    for (const id of ids) {
      const owned = ownedRecord(scope, id);
      if (owned.error) {
        blocks.push({ header: `来源：附件（${owned.error.message}）`, text: '' });
        continue;
      }
      const record = owned.record;
      const captured = `登记于 ${formatClock(record.registeredAt)}`;
      if (record.kind === 'image') {
        const header = `来源：消息附件「${record.name}」（${formatBytes(record.sizeBytes)} 图片，${captured}）`;
        if (typeof resolveImageAnswer !== 'function') {
          blocks.push({ header: `${header} —— 视觉解读不可用`, text: '' });
          continue;
        }
        try {
          const buffer = readFileSync(record.originPath);
          const ext = path.extname(record.originPath).toLowerCase();
          const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] ?? 'image/png';
          const answer = await resolveImageAnswer({
            question: ask,
            imageData: buffer.toString('base64'),
            mimeType: mime,
            header,
          });
          blocks.push({ header, text: answer });
        } catch (error) {
          log?.warn(`附件图片解读失败（${record.attachmentId}）：${error.message}`);
          blocks.push({ header: `${header} —— 图片解读失败：${error.message}`, text: '' });
        }
        continue;
      }
      try {
        const buffer = readFileSync(record.originPath);
        const text = buffer.subarray(0, TEXT_FILE_BYTE_LIMIT).toString('utf8');
        const clamped = clampText(text);
        blocks.push({
          header: `来源：消息附件「${record.name}」（${formatBytes(record.sizeBytes)} 文件，全文 ${clamped.originalLength} 字，${captured}）`,
          text: clamped.text,
        });
      } catch (error) {
        const { message } = failureCodeMessage(record, error);
        blocks.push({ header: `来源：消息附件「${record.name}」—— ${message}`, text: '' });
      }
    }
    return buildContextEnvelope(clampBlocks(blocks));
  }

  /** 回合受理成功后冻结归属：附件转为「已发送」，草稿区不再列出（重试仍可按身份解析）。 */
  function markSent({ conversationId, attachmentIds }) {
    const scope = String(conversationId ?? '');
    let marked = 0;
    for (const id of Array.isArray(attachmentIds) ? attachmentIds : []) {
      const record = records.get(String(id ?? ''));
      if (record && record.conversationId === scope && !record.sent) {
        record.sent = true;
        marked += 1;
      }
    }
    if (marked) log?.info(`附件随消息冻结归属（${marked} 项）`);
    return marked;
  }

  return {
    attachFile,
    attachPasteImage,
    remove,
    list,
    listAll,
    get,
    markSent,
    readPreview,
    openSource,
    resolveEnvelopeForTurn,
  };
}
