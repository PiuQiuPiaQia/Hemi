// 063 · `/` 首层候选与 `@` 行内引用的候选源（纯逻辑，服务装配在 composer.ipc）。
//
// 纪律（需求 063「身份与执行契约」）：
//  - 技能候选与生产装配同源——复用 agent-runtime 的 collectSkills（Hemi 技能库
//    快照＋项目技能发现、库同名优先），不自行遍历另一套目录；
//  - 候选只描述「有什么可选」，选择/发送/执行另走身份校验（llm.ipc 派发时校验）；
//  - 候选返回晚于切会话/改工作区时由渲染层丢弃（conversationId 随查询携带）。

/** 首层命令目录（063 首批：仅 /model；不在此平铺模型）。 */
export const SLASH_COMMANDS = [
  { id: 'model', name: '/model', description: '切换模型——进入与模型按钮同源的选择器' },
];

/**
 * 技能收集结果 → slash 技能候选（形状稳定：skillId/name/description/source）。
 * @param {Array<{id:string,name:string,description?:string,source?:string}>} skills
 */
export function skillCandidatesOf(skills) {
  const seen = new Set();
  const out = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill?.name || typeof skill.name !== 'string') continue;
    const source = skill.source === 'project' ? 'project' : 'library';
    const skillId = typeof skill.id === 'string' && skill.id ? skill.id : `${source}:${skill.name}`;
    const dedupeKey = `${source}:${skill.name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      skillId,
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description.slice(0, 200) : '',
      source,
    });
  }
  return out.slice(0, 50);
}

/**
 * slash 首层搜索：命令/技能名精确→前缀→包含，说明弱匹配最后；保持
 * 「命令 → 技能」分组次序（名称匹配优先于说明匹配，与需求 R-01 一致）。
 */
export function filterSlashCandidates({ commands = SLASH_COMMANDS, skills = [] }, query = '') {
  const keyword = String(query ?? '').trim().toLowerCase();
  if (!keyword) return { commands, skills };
  const rank = (item) => {
    const name = item.name.toLowerCase();
    if (name === keyword || name === `/${keyword}`) return 0;
    if (name.startsWith(keyword) || (item.id !== undefined && name.startsWith(`/${keyword}`))) return 1;
    if (name.includes(keyword)) return 2;
    if (String(item.description ?? '').toLowerCase().includes(keyword)) return 3;
    return -1;
  };
  const pick = (items) => items
    .map((item) => ({ item, rank: rank(item) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name))
    .map((entry) => entry.item);
  return { commands: pick(commands), skills: pick(skills) };
}

/**
 * 派发时的技能可用性校验（063「身份与执行契约」）：按 skillId＋source 对生产
 * 收集结果核验；不可用＝如实失败，不按显示名换另一技能。
 * @param {Array<{token:string,name:string,source:string,skillId:string}>} selections
 * @param {Array<{id:string,name:string,source?:string}>} available collectSkills 的 items
 * @returns {{ok:boolean, missing:Array<{name:string,reason:string}>}}
 */
export function validateSkillSelections(selections, available, diagnostics = []) {
  const list = (Array.isArray(selections) ? selections : []).filter(Boolean);
  if (!list.length) return { ok: true, missing: [] };
  const index = new Set();
  for (const skill of Array.isArray(available) ? available : []) {
    if (!skill?.name) continue;
    const source = skill.source === 'project' ? 'project' : 'library';
    index.add(`${source}:${skill.id ?? `${source}:${skill.name}`}`);
  }
  const missing = [];
  for (const selection of list) {
    const source = selection.source === 'project' ? 'project' : 'library';
    if (!index.has(`${source}:${selection.skillId}`)) {
      const invalid = diagnostics.find(item => item.skillId === selection.skillId && item.source === source);
      missing.push({ name: selection.name || selection.skillId || '技能', reason: invalid ? `${invalid.message}；${invalid.path}` : '已删除、禁用或不可读' });
    }
  }
  return { ok: missing.length === 0, missing };
}
