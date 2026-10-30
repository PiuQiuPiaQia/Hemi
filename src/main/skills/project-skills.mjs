/**
 * 056 · 项目级 Skill 发现（R-05）：工作区里给 agent 用的 Skill 也要能读到。
 *
 * 位置口径对齐 Pi（docs/skills.md：`.agents/skills/` 从工作目录逐级向上找、到仓库
 * 根为止）与 Claude Code（`<项目>/.claude/skills/`）。项目 Skill 视为工作区内容：
 * 信任随会话绑定该项目而来，不走 034 的受控版本/sha 校验（那只管 Hemi 技能库）。
 *
 * 只收「目录 + SKILL.md」形态；软链目录照收（常见软链到 ~/.claude/skills）。
 * 有界：最多 MAX_PROJECT_SKILLS 个，exFAT 的 `._*` 垃圾一律跳过。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { prepareSkills } from './skill-definition.mjs';

export const PROJECT_SKILL_DIRS = [['.claude', 'skills'], ['.agents', 'skills']];
const MAX_PROJECT_SKILLS = 40;

function skillDirsIn(root) {
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.startsWith('._')) continue;
    const dir = path.join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue; // statSync 跟随软链
      if (!statSync(path.join(dir, 'SKILL.md')).isFile()) continue;
    } catch {
      continue;
    }
    out.push(dir);
  }
  return out;
}

/** SKILL.md frontmatter 的 description（单行或块标量；读不到给空串，不影响发现）。 */
export function skillDescriptionOf(skillDir) {
  return prepareSkills([{ path: skillDir, source: 'project' }]).items[0]?.description ?? '';
}

/** 从工作区目录逐级向上（到 git 根或文件系统根）收集项目 Skill 目录。 */
export function discoverProjectSkills(workspaceDir, { diagnostics = [] } = {}) {
  if (!workspaceDir || !path.isAbsolute(workspaceDir)) return [];
  const found = [];
  const seen = new Set();
  let dir = workspaceDir;
  for (let depth = 0; depth < 12; depth += 1) {
    for (const parts of PROJECT_SKILL_DIRS) {
      for (const skillDir of skillDirsIn(path.join(dir, ...parts))) {
        const directoryName = path.basename(skillDir);
        const skill = prepareSkills([{ id: `project:${directoryName}`, name: directoryName, path: skillDir, source: 'project' }], { diagnostics }).items[0];
        if (!skill || seen.has(skill.name)) continue; // 无效项不遮住其他来源，名称使用已校验元数据。
        seen.add(skill.name);
        found.push(skill);
        if (found.length >= MAX_PROJECT_SKILLS) return found;
      }
    }
    if (existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
