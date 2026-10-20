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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

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
  let text = '';
  try {
    text = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8').slice(0, 8192);
  } catch { return ''; }
  // 056 审查：复用 SDK parseFrontmatter（与 skill-store/agent-roles 同一解析器）。
  const { frontmatter } = parseFrontmatter(text);
  return frontmatter?.description ? String(frontmatter.description).slice(0, 200).trim() : '';
}

/** 从工作区目录逐级向上（到 git 根或文件系统根）收集项目 Skill 目录。 */
export function discoverProjectSkills(workspaceDir) {
  if (!workspaceDir || !path.isAbsolute(workspaceDir)) return [];
  const found = [];
  const seen = new Set();
  let dir = workspaceDir;
  for (let depth = 0; depth < 12; depth += 1) {
    for (const parts of PROJECT_SKILL_DIRS) {
      for (const skillDir of skillDirsIn(path.join(dir, ...parts))) {
        const name = path.basename(skillDir);
        if (seen.has(name)) continue; // 近处优先（子目录覆盖祖先同名）
        seen.add(name);
        found.push({ id: `project:${name}`, name, path: skillDir, source: 'project', description: skillDescriptionOf(skillDir) });
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
