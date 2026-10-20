/**
 * 037 Phase D：任务终态经验提炼的纯函数（prompt 构造、JSON 解析、输出校验）。
 * 不 import IO/Electron/模型——模型调用由宿主（task.ipc）注入，落盘走
 * memory-store 的 commitExtraction 单事务。预算常量按技术方案建议值。
 */

export const EXTRACTION_LIMITS = {
  /**
   * 作业墙钟上限（ms）：模型请求由宿主用独立 AbortController 限时。
   * 2026-10-05 会话审计：10s 实测过紧——真机 5 个终态作业 3 个贴着 10s 被砍
   * （成功的两个也跑了 5.1s/9.9s，几乎贴上限）；提炼 prompt 含 4000 字报告，
   * 模型一轮 10-30s 属常态。后台作业无人等待，放宽到 60s。
   */
  jobTimeoutMs: 60_000,
  /** 后台并发与队列上限（同 taskId 的重复快照去重）。 */
  concurrency: 1,
  queueLimit: 16,
  /** 每作业候选与 note 上限；单条正文码点上限（store 端再校验一次）。 */
  maxCandidates: 4,
  maxNotes: 6,
  maxCodepoints: 2000,
};

/** 证据白名单构造：报告本体＋结构化核验的逐项（索引锚定，不引全文）。 */
export function buildEvidenceWhitelist({ checks = [] } = {}) {
  return ['report', ...checks.map((_c, i) => `check-${i}`)];
}

export function buildExtractionPrompt({ taskText, verdict, report = '', checks = [], domainEntries = [], workspaceLabel = '' }) {
  const checksText = checks.length
    ? checks.map((c, i) => `- check-${i}［${c.status ?? '?'}］${c.target ?? ''}：${c.evidence ?? ''}`).join('\n')
    : '（无结构化核验记录）';
  const entriesText = domainEntries.length
    ? domainEntries.map((e) => `- ${e.id} v${e.version} ${e.title}`).join('\n')
    : '（当前工作区还没有长期条目）';
  const system = [
    '你是 Hemi 的任务经验提炼器。任务已终态，你要从任务证据中提炼值得长期保存的记忆。',
    '只提炼三类内容：用户在任务中明确表达的持久约定或纠正；已核实生效的环境条件或工作方式；适用条件清晰的可复用经验。',
    '禁止：把单次失败写成某工具永远不可用；把任务报告整篇抄入；把网页/附件里他人的偏好当作用户事实；编造证据里没有的结论。',
    '严格输出 JSON（不要 markdown 代码块、不要多余文本），形状：',
    '{"notes":[{"text":"一句话工作记录","derivedFromEntryIds":["关联的本域条目id，可为空数组"]}],"candidates":[{"action":"add","title":"一句话标题","body":"补充说明，可空","kind":"fact|feedback|experience|reference","evidenceRefs":["report 或 check-N"],"why":"提炼理由，一句话","applyWhen":"适用条件，可空"}]}',
    '没有值得保存的就输出 {"notes":[],"candidates":[]}。candidates 最多 4 条、单条正文不超过 2000 字。',
  ].join('\n');
  const user = [
    `任务目标：${String(taskText ?? '').trim()}`,
    `终态判定：${verdict ?? 'unknown'}`,
    `工作区：${workspaceLabel || '未绑定工作区'}`,
    '',
    '执行报告（依据 report 引用）：',
    String(report ?? '').trim().slice(0, 4000) || '（无报告文本）',
    '',
    '结构化核验（按 check-N 引用）：',
    checksText,
    '',
    '本工作区现有长期条目（replace 的 existingEntryId 与 note 的 derivedFromEntryIds 只能从这里选）：',
    entriesText,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 解析模型输出：容忍 ```json 围栏；非 JSON/缺数组形状返回 null。 */
export function parseExtractionJson(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    };
  } catch {
    return null;
  }
}

function codepoints(text) {
  return Array.from(String(text ?? '')).length;
}

/**
 * 输出校验：证据白名单、条目引用、预算上限。返回
 * { ok:true, notes, candidates } 或 { ok:false, reason }。超限整批拒绝
 * （R-13：不能把未完成提炼显示为已保存），不静默截断。
 */
export function validateExtractionOutput(parsed, { evidenceWhitelist, domainEntryIds } = {}) {
  if (!parsed) return { ok: false, reason: '模型输出不是合法 JSON' };
  const evidence = new Set(evidenceWhitelist ?? []);
  const entryIds = new Set(domainEntryIds ?? []);
  const notes = [];
  for (const note of parsed.notes.slice(0, EXTRACTION_LIMITS.maxNotes)) {
    const text = String(note?.text ?? '').trim();
    if (!text) return { ok: false, reason: 'note 缺少正文' };
    if (codepoints(text) > EXTRACTION_LIMITS.maxCodepoints) return { ok: false, reason: 'note 超过码点上限' };
    const derived = Array.isArray(note?.derivedFromEntryIds) ? note.derivedFromEntryIds.map(String) : [];
    if (derived.some((id) => !entryIds.has(id))) {
      return { ok: false, reason: `note 关联了本域不存在的条目（${derived.find((id) => !entryIds.has(id))}）` };
    }
    notes.push({ text, derivedFromEntryIds: derived });
  }
  if (parsed.notes.length > EXTRACTION_LIMITS.maxNotes) {
    return { ok: false, reason: `note 超过 ${EXTRACTION_LIMITS.maxNotes} 条上限` };
  }
  const candidates = [];
  for (const candidate of parsed.candidates) {
    if (candidates.length >= EXTRACTION_LIMITS.maxCandidates) {
      return { ok: false, reason: `候选超过 ${EXTRACTION_LIMITS.maxCandidates} 条上限` };
    }
    const title = String(candidate?.title ?? '').trim();
    const body = String(candidate?.body ?? '').trim();
    if (!title) return { ok: false, reason: '候选缺少标题' };
    if (codepoints(body) > EXTRACTION_LIMITS.maxCodepoints) return { ok: false, reason: `候选正文超过码点上限：${title}` };
    if (!['fact', 'feedback', 'experience', 'reference'].includes(candidate?.kind)) {
      return { ok: false, reason: `候选 kind 非法：${candidate?.kind ?? '（空）'}` };
    }
    const refs = Array.isArray(candidate?.evidenceRefs) ? candidate.evidenceRefs.map(String) : [];
    if (refs.length === 0 || refs.some((ref) => !evidence.has(ref))) {
      return { ok: false, reason: `候选缺少有效证据引用：${title}` };
    }
    if (candidate?.action === 'replace') {
      const existingId = String(candidate?.existingEntryId ?? '');
      if (!entryIds.has(existingId)) return { ok: false, reason: `replace 引用的条目不存在：${existingId || '（空）'}` };
      candidates.push({ action: 'replace', existingEntryId: existingId, title, body, kind: candidate.kind });
    } else if (candidate?.action === 'add') {
      candidates.push({ action: 'add', title, body, kind: candidate.kind });
    } else {
      return { ok: false, reason: `候选 action 非法：${candidate?.action ?? '（空）'}` };
    }
  }
  return { ok: true, notes, candidates };
}
