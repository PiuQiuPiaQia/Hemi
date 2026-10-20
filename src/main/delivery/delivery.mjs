// 025 → 050 交付契约 · 数据校验与旧档案投影（纯函数层，无 IO）。
//
// 050（2026-10-10 用户裁决：Agent 交付契约）起 register_delivery 收敛为
// 「正式交付文件声明」：files[]（路径＋一句说明）＋ sources[]（外部依据）。
// 正文不再走结构块——执行器最后一条消息就是用户正文；文件改动由宿主统计。
// 工具侧用它给模型反馈（有界修正），宿主侧用它决定存不存（同一份函数，
// 两处判定不会分叉）。
//
// v1 的 card/report/file＋blocks 形态只保留读取投影（projectDelivery）：已发布
// 版本的旧档案按确定性规则投影成 Markdown 正文回看（AC-11），不调模型、不重跑。
//
// 边界沿用 025：来源 URL 只认 https；本地成果不是来源；大小/数量超限明确拒绝；
// taskId/会话归属由宿主绑定，模型侧没有归属字段可填。

export const DELIVERY_SCHEMA_VERSION = 2;

/** 数量与大小上限（050 收敛后保留的有效面）。 */
export const DELIVERY_LIMITS = {
  files: 10,
  fileDescription: 200,
  sources: 12,
  sourceTitle: 120,
  sourceNote: 200,
  /** 同一任务允许的登记次数（含失败重试），超出后不再受理。 */
  attempts: 5,
};

/** 图片展示的扩展名约束（宿主侧文件查证沿用；图片块已随 v1 退役，读取器仍用）。 */
export const DELIVERY_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
export const DELIVERY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function cleanText(value, maxChars) {
  const raw = String(value ?? '')
    // 控制字符去掉（模型偶发输出 \u0000 类杂质），保留换行。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
  const chars = Array.from(raw);
  return chars.length <= maxChars ? raw : chars.slice(0, maxChars).join('');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** https 且能被 URL 解析的链接才算来源链接；其余来源降级为纯标题条目。 */
export function cleanSourceUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 指向本地文件/目录的「来源」条目识别（025 真机反馈沿用：任务把本次生成的
 * 成果文件登记成了「来源」，来源区出现一条永远点不开的本地路径）。
 * 050 契约（R-04/05）本就要求「source 与 deliverable 分开」——本地成果走 files，
 * source 只收外部依据。只认明确的路径/措辞特征，不做通用语义猜测。
 */
export function looksLikeLocalReference(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (/^(~|\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|\/var\/folders\/)/.test(raw)) return true;
  if (/同目录|同一目录|工作目录|本地文件|已保存到|完整成果文件/.test(raw)) return true;
  return false;
}

function safeHostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * register_delivery v2 的完整校验/归一化。
 * 入参：{ files: [{ path, description? }], sources?: [{ title, url }] }。
 * 返回 { ok: true, value } 或 { ok: false, reason }（reason 面向执行器，可直接
 * 回给模型修正）。files 的路径查证在宿主侧（register.mjs），这里只保形状。
 */
export function validateDelivery(input) {
  if (!isPlainObject(input)) {
    return { ok: false, reason: '登记内容必须是 JSON 对象' };
  }
  const rawFiles = Array.isArray(input.files) ? input.files : [];
  const rawSources = Array.isArray(input.sources) ? input.sources : [];
  if (!rawFiles.length && !rawSources.length) {
    return { ok: false, reason: '没有要声明的内容：交付文件（files）与来源（sources）至少占其一。答案与结论写在最后一条消息里，不要为留档生成同内容文件；纯调研任务可只声明来源' };
  }
  if (rawFiles.length > DELIVERY_LIMITS.files) {
    return { ok: false, reason: `交付文件超出 ${DELIVERY_LIMITS.files} 个上限` };
  }
  const files = [];
  for (const file of rawFiles) {
    if (!isPlainObject(file)) continue;
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (!path) {
      return { ok: false, reason: 'files 里每一项都要有 path' };
    }
    const description = cleanText(file.description, DELIVERY_LIMITS.fileDescription);
    files.push({ path, ...(description ? { description } : {}) });
  }
  if (rawSources.length > DELIVERY_LIMITS.sources) {
    return { ok: false, reason: `来源声明超出 ${DELIVERY_LIMITS.sources} 条上限` };
  }
  const sources = [];
  for (const source of rawSources) {
    if (!isPlainObject(source)) continue;
    const title = cleanText(source.title, DELIVERY_LIMITS.sourceTitle);
    const url = cleanSourceUrl(source.url);
    if (!url && (looksLikeLocalReference(title) || looksLikeLocalReference(String(source.url ?? '')))) {
      return { ok: false, reason: '本地文件不是来源：成果文件写进 files，sources 只收外部依据（https 链接）' };
    }
    // 标题缺失时用域名兜底（可读标题是 R-05 的展示底线）。
    const fallbackTitle = title || (url ? safeHostOf(url) : '');
    if (!fallbackTitle) continue;
    sources.push({ title: fallbackTitle, ...(url ? { url } : {}) });
  }

  return {
    ok: true,
    value: {
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      files,
      sources,
    },
  };
}

const cellText = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

/**
 * v1 交付 → Markdown 的确定性投影（旧档案回看用，不调模型；S0 探针 48/48 成功）。
 * 形状来自 025 的 TaskDelivery：summary、blocks（p/metrics/table/checklist/
 * section/image）、partial、sources。投影失败（未知块类型等）抛错，由调用方
 * 降级为旧 resultText。
 */
export function projectDelivery(d) {
  const out = [];
  if (d.summary) out.push(String(d.summary).trim());
  const walk = (blocks, depth) => {
    for (const b of blocks ?? []) {
      if (b.type === 'p') out.push(String(b.text ?? '').trim());
      else if (b.type === 'metrics') out.push((b.items ?? []).map((m) => `- **${m.label}**：${m.value}${m.unit ?? ''}${m.note ? `（${m.note}）` : ''}`).join('\n'));
      else if (b.type === 'table') {
        const cols = b.columns ?? [];
        if (!cols.length) throw new Error('table 无 columns');
        const rows = (b.rows ?? []).map((r) => `| ${cols.map((_, i) => cellText(r[i])).join(' | ')} |`);
        out.push([b.caption ? `*${cellText(b.caption)}*` : '', `| ${cols.map(cellText).join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows].filter(Boolean).join('\n'));
      } else if (b.type === 'checklist') {
        for (const g of b.groups ?? []) out.push([g.title ? `**${g.title}**` : '', ...(g.items ?? []).map((it) => `- ${it.text}${it.note ? `（${it.note}）` : ''}`)].filter(Boolean).join('\n'));
      } else if (b.type === 'section') {
        out.push(`${'#'.repeat(Math.min(3 + depth, 4))} ${b.title}`);
        walk(b.blocks, depth + 1);
      } else if (b.type === 'image') out.push(`![${b.caption ?? ''}](${b.path})`);
      else throw new Error(`未知块类型 ${b.type}`);
    }
  };
  walk(d.blocks, 0);
  if (d.partial?.missing?.length) out.push(`**未完成**：${d.partial.missing.join('；')}`);
  if (d.sources?.length) out.push(`**来源**\n${d.sources.map((s) => `- ${s.url ? `[${s.title}](${s.url})` : s.title}${s.note ? `（${s.note}）` : ''}`).join('\n')}`);
  return out.filter(Boolean).join('\n\n');
}
