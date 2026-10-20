/**
 * 037 Phase A：分域记忆的 Markdown 管理块格式（纯函数，不 import 任何 IO/Electron）。
 *
 * 权威正文只存在 Markdown：条目用带 id/version/来源的管理块包裹，未包裹的旧文本
 * 保留为「待整理」片段（原样保存，不猜测归属）。列表/索引由解析重建，不存第二份正文。
 *
 * 格式（storage-and-contracts.md §作用域与正文）：
 *   <!-- hemi-entry {"id":"mem-…","version":2,"kind":"feedback",…} -->
 *   ## 标题
 *   正文……
 *   <!-- /hemi-entry -->
 *
 * 渲染纪律：条目块按元数据规范重排；loose 片段的正文逐字保留（不修复、不重写），
 * 首次结构化写入只会规范块间空白，这是允许的唯一格式变化。
 */

export const ENTRY_KINDS = ['profile', 'fact', 'feedback', 'experience', 'reference'];
/** 单条容量（Unicode 码点）：写前拒绝超限，原文不变。 */
export const ENTRY_LIMITS = { title: 200, body: 2000 };
/** 单个长期集合的读取保护：超过此字节数暂停注入并提示整理。 */
export const COLLECTION_READ_MAX_BYTES = 128 * 1024;

const OPEN_PREFIX = '<!-- hemi-entry ';
const OPEN_SUFFIX = ' -->';
const CLOSE_MARKER = '<!-- /hemi-entry -->';
const META_KEYS = ['id', 'version', 'kind', 'sourceRefs', 'relatedEntryIds', 'createdAt', 'updatedAt'];

// ---------------------------------------------------------------- 工作记录块
// 037：任务工作记录（daily/便签）也按小块保存——recordId、类型、时间、
// 来源与条目关联。一个块承载一个可定位的事实/待办，遗忘按关联处理。
const RECORD_OPEN_PREFIX = '<!-- hemi-record ';
const RECORD_CLOSE_MARKER = '<!-- /hemi-record -->';
const RECORD_META_KEYS = ['recordId', 'type', 'done', 'sourceRefs', 'derivedFromEntryIds', 'createdAt'];

/** 单条工作记录容量（Unicode 码点）。 */
export const RECORD_TEXT_LIMIT = 2000;
/** 读取预算：每日 daily 与便签各自最多注入的码点数，超出按整块省略并计数。 */
export const DAILY_READ_BUDGET = 3000;
export const SCRATCHPAD_READ_BUDGET = 2000;

/**
 * 解析一份工作记录集合（daily/SCRATCHPAD 专用，与条目集合分开解析）。
 * 格式异常与条目集合同策略：整块降级为 loose 原文保留，不丢字、不修复。
 */
export function parseRecordDocument(text) {
  const source = String(text ?? '');
  const records = [];
  const issues = [];
  const looseTexts = [];
  const lines = source.split('\n');
  let index = 0;
  let buffer = [];
  const flushLoose = () => {
    let start = 0;
    let end = buffer.length;
    while (start < end && buffer[start].trim().length === 0) start += 1;
    while (end > start && buffer[end - 1].trim().length === 0) end -= 1;
    const raw = buffer.slice(start, end).join('\n');
    if (raw.trim().length > 0) looseTexts.push(raw);
    buffer = [];
  };
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith(RECORD_OPEN_PREFIX) && trimmed.endsWith(OPEN_SUFFIX)) {
      let closeIndex = -1;
      for (let j = index + 1; j < lines.length; j++) {
        if (lines[j].trim() === RECORD_CLOSE_MARKER) {
          closeIndex = j;
          break;
        }
      }
      if (closeIndex === -1) {
        issues.push({ line: index + 1, reason: 'unterminated_record_block' });
        buffer.push(...lines.slice(index));
        index = lines.length;
        break;
      }
      flushLoose();
      const metaRaw = trimmed.slice(RECORD_OPEN_PREFIX.length, trimmed.length - OPEN_SUFFIX.length).trim();
      const content = stripEdgeBlankLines(lines.slice(index + 1, closeIndex));
      const record = buildRecordFromBlock(metaRaw, content, index + 1, issues);
      if (record) records.push(record);
      else buffer.push(...lines.slice(index, closeIndex + 1));
      index = closeIndex + 1;
      continue;
    }
    buffer.push(lines[index]);
    index += 1;
  }
  flushLoose();
  return { records, looseTexts, issues };
}

function buildRecordFromBlock(metaRaw, content, startLine, issues) {
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    issues.push({ line: startLine, reason: 'invalid_record_meta' });
    return null;
  }
  if (!meta || typeof meta !== 'object' || !isValidId(meta.recordId)) {
    issues.push({ line: startLine, reason: 'invalid_record_id' });
    return null;
  }
  if (meta.type !== 'note' && meta.type !== 'todo') {
    issues.push({ line: startLine, reason: 'invalid_record_type' });
    return null;
  }
  return {
    recordId: meta.recordId,
    type: meta.type,
    done: meta.done === true,
    text: content,
    sourceRefs: isStringArray(meta.sourceRefs) ? meta.sourceRefs : [],
    derivedFromEntryIds: isStringArray(meta.derivedFromEntryIds) ? meta.derivedFromEntryIds : [],
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
  };
}

export function renderRecordDocument(records) {
  const parts = [];
  for (const record of records) {
    const meta = {};
    for (const key of RECORD_META_KEYS) {
      if (record[key] === undefined) continue;
      meta[key] = record[key];
    }
    parts.push(`${RECORD_OPEN_PREFIX}${JSON.stringify(meta)}${OPEN_SUFFIX}\n${record.text ?? ''}\n${RECORD_CLOSE_MARKER}`);
  }
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n`;
}

/** 工作记录读取预算：按整块累积，超出预算的整块省略并计数（不从中间截断）。 */
export function applyRecordBudget(records, budgetCodepoints) {
  const kept = [];
  let used = 0;
  let omitted = 0;
  for (const record of records) {
    const size = countCodePoints(record.text) + 40; // 40＝管理块元数据的大致开销
    if (used + size > budgetCodepoints) {
      omitted += 1;
      continue;
    }
    used += size;
    kept.push(record);
  }
  return { kept, omitted };
}

/**
 * 自然语言内容 → 条目标题/正文（对话 memory_write 与执行器记忆桥共用）：
 * 首行为标题（截 120 码点内防撞条目预算），其余为正文；完整内容不丢。
 */
export function deriveTitleAndBody(content) {
  const trimmed = String(content ?? '').trim();
  const lines = trimmed.split('\n');
  const firstLine = (lines[0] ?? '').trim();
  const title = Array.from(firstLine).slice(0, 120).join('');
  const body = lines.slice(1).join('\n').trim();
  return { title: title || '未命名条目', body };
}

export function countCodePoints(text) {
  return Array.from(String(text ?? '')).length;
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

/**
 * 解析一份集合原文。返回有序 segments（entry / loose 交错，保留原文顺序）、
 * 条目数组与问题列表。格式异常（未闭合、JSON 无效、字段非法）按契约「原文保留并
 * 进入待整理」处理：整个块降级为 loose，不丢字、不修复。
 */
export function parseManagedDocument(text) {
  const source = String(text ?? '');
  const segments = [];
  const issues = [];
  const lines = source.split('\n');
  let index = 0;
  let buffer = [];
  let bufferStartLine = 0;

  const flushLoose = () => {
    if (buffer.length === 0) return;
    // 只裁首尾空白行（块间空白允许规范）；中间内容逐字保留。
    let start = 0;
    let end = buffer.length;
    while (start < end && buffer[start].trim().length === 0) start += 1;
    while (end > start && buffer[end - 1].trim().length === 0) end -= 1;
    const raw = buffer.slice(start, end).join('\n');
    if (raw.trim().length > 0) segments.push({ type: 'loose', text: raw });
    buffer = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith(OPEN_PREFIX) && trimmed.endsWith(OPEN_SUFFIX)) {
      // 找闭合标记；找不到则整块降级 loose。
      let closeIndex = -1;
      for (let j = index + 1; j < lines.length; j++) {
        if (lines[j].trim() === CLOSE_MARKER) {
          closeIndex = j;
          break;
        }
      }
      const openStartLine = index + 1;
      if (closeIndex === -1) {
        issues.push({ line: openStartLine, reason: 'unterminated_entry_block' });
        buffer.push(...lines.slice(index));
        index = lines.length;
        break;
      }
      flushLoose();
      const metaRaw = trimmed.slice(OPEN_PREFIX.length, trimmed.length - OPEN_SUFFIX.length).trim();
      const contentLines = lines.slice(index + 1, closeIndex);
      const parsedBlock = buildEntryFromBlock(metaRaw, contentLines, openStartLine, issues);
      if (parsedBlock) segments.push(parsedBlock);
      else buffer.push(...lines.slice(index, closeIndex + 1));
      index = closeIndex + 1;
      continue;
    }
    if (buffer.length === 0) bufferStartLine = index + 1;
    buffer.push(line);
    index += 1;
  }
  flushLoose();
  void bufferStartLine;

  const entries = segments.filter((s) => s.type === 'entry').map((s) => s.entry);
  return {
    segments,
    entries,
    looseSegments: segments.filter((s) => s.type === 'loose'),
    issues,
  };
}

function buildEntryFromBlock(metaRaw, contentLines, startLine, issues) {
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    issues.push({ line: startLine, reason: 'invalid_meta_json' });
    return null;
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    issues.push({ line: startLine, reason: 'invalid_meta_json' });
    return null;
  }
  if (!isValidId(meta.id)) {
    issues.push({ line: startLine, reason: 'invalid_entry_id' });
    return null;
  }
  if (!Number.isInteger(meta.version) || meta.version < 1) {
    issues.push({ line: startLine, reason: 'invalid_entry_version' });
    return null;
  }
  if (meta.kind !== undefined && !ENTRY_KINDS.includes(meta.kind)) {
    issues.push({ line: startLine, reason: 'invalid_entry_kind' });
    return null;
  }
  if (meta.sourceRefs !== undefined && !isStringArray(meta.sourceRefs)) {
    issues.push({ line: startLine, reason: 'invalid_source_refs' });
    return null;
  }
  if (meta.relatedEntryIds !== undefined && !isStringArray(meta.relatedEntryIds)) {
    issues.push({ line: startLine, reason: 'invalid_related_entry_ids' });
    return null;
  }
  const extra = {};
  for (const key of Object.keys(meta)) {
    if (!META_KEYS.includes(key)) extra[key] = meta[key];
  }
  if (Object.keys(extra).length > 0) issues.push({ line: startLine, reason: 'unknown_meta_keys_preserved' });

  // 内容：首个「## 」标题行作为 title，其余为 body；无标题则整体为 body。
  let title = '';
  let bodyLines = contentLines;
  const firstMeaningful = contentLines.findIndex((l) => l.trim().length > 0);
  if (firstMeaningful >= 0 && contentLines[firstMeaningful].startsWith('## ')) {
    title = contentLines[firstMeaningful].slice(3).trim();
    bodyLines = [
      ...contentLines.slice(0, firstMeaningful),
      ...contentLines.slice(firstMeaningful + 1),
    ];
  }
  const entry = {
    id: meta.id,
    version: meta.version,
    kind: meta.kind ?? 'fact',
    title,
    body: stripEdgeBlankLines(bodyLines),
    sourceRefs: meta.sourceRefs ?? [],
    relatedEntryIds: meta.relatedEntryIds ?? [],
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
    updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  return { type: 'entry', entry };
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function stripEdgeBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end).join('\n');
}

function renderEntryBlock(entry) {
  const meta = {};
  for (const key of META_KEYS) {
    if (entry[key] === undefined) continue;
    meta[key] = entry[key];
  }
  for (const [key, value] of Object.entries(entry.extra ?? {})) meta[key] = value;
  const metaJson = JSON.stringify(meta);
  const heading = entry.title ? `## ${entry.title}` : '';
  const body = entry.body ?? '';
  const inner = [heading, body].filter((part) => part.length > 0).join('\n');
  return `${OPEN_PREFIX}${metaJson}${OPEN_SUFFIX}\n${inner}\n${CLOSE_MARKER}`;
}

/**
 * 渲染集合原文。条目按当前字段规范输出；loose 正文逐字保留。
 * 空集合渲染为空字符串（clearScope 之后文件保持存在、内容为空）。
 */
export function renderManagedDocument(segments) {
  const parts = [];
  for (const segment of segments) {
    if (segment.type === 'entry') parts.push(renderEntryBlock(segment.entry));
    else parts.push(segment.text);
  }
  if (parts.length === 0) return '';
  return `${parts.map((p) => p.replace(/\s+$/, '')).join('\n\n')}\n`;
}

/** 条目内容预算校验：返回错误文案或 null（超限拒绝写入，原文不变）。 */
export function validateEntryContent({ title, body, kind }) {
  const titleText = String(title ?? '');
  const bodyText = String(body ?? '');
  if (!titleText.trim()) return 'title 不能为空';
  if (countCodePoints(titleText) > ENTRY_LIMITS.title) {
    return `title 超过 ${ENTRY_LIMITS.title} 码点上限`;
  }
  if (countCodePoints(bodyText) > ENTRY_LIMITS.body) {
    return `body 超过 ${ENTRY_LIMITS.body} 码点上限`;
  }
  if (kind !== undefined && !ENTRY_KINDS.includes(kind)) {
    return `kind 只能是 ${ENTRY_KINDS.join(' / ')}`;
  }
  return null;
}

function entryContentSignature(entry) {
  return JSON.stringify([entry.title, entry.body, entry.kind, entry.sourceRefs, entry.relatedEntryIds]);
}

/**
 * 外部编辑 diff：同一集合两次解析结果按 id 对比。version/时间戳是宿主簿记，
 * 不算内容变化；变化判定只看标题、正文与语义元数据。返回的结构供存储层执行
 * 「id 保留则递增版本；新增未包裹内容进待整理；直接删除触发与 UI 删除相同的代次」。
 */
export function diffExternalDocument(prev, next) {
  const prevById = new Map(prev.entries.map((e) => [e.id, e]));
  const nextById = new Map(next.entries.map((e) => [e.id, e]));
  const changedEntries = [];
  for (const [id, nextEntry] of nextById) {
    const prevEntry = prevById.get(id);
    if (!prevEntry) {
      changedEntries.push({ id, change: 'added' });
      continue;
    }
    if (entryContentSignature(prevEntry) !== entryContentSignature(nextEntry)) {
      changedEntries.push({ id, change: 'modified', prevVersion: prevEntry.version });
    }
  }
  const removedEntryIds = [...prevById.keys()].filter((id) => !nextById.has(id));
  const looseChanged = !looseSignatureEqual(prev.looseSegments, next.looseSegments);
  return { changedEntries, removedEntryIds, looseChanged };
}

function looseSignatureEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text) return false;
  }
  return true;
}
