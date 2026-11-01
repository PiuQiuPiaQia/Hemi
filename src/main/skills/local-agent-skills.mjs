/**
 * 本地 Agent 技能扫描与批量导入（「导入本地技能支持扫描已有本地 agent skills」）。
 *
 * 扫描范围（有意收窄，不做全盘扫描）：
 * - 用户级常见目录：~/.agents/skills ~/.claude/skills ~/.codex/skills ~/.cursor/skills
 *   ~/.gemini/skills ~/.config/opencode/skills；
 * - 已登记的本机工作区（workspace-store：host 为空且 status ok，含默认空间）下的
 *   .agents/skills 与 .claude/skills——与项目技能发现（project-skills.mjs）同一口径，
 *   不猜测项目目录。
 *
 * 形态只收「目录 + SKILL.md」，最多两层（root/<name>/SKILL.md，或 root/<组>/<name>/SKILL.md
 * 且组目录自身没有 SKILL.md 才下钻）；软链按 realpath 归一（失效软链跳过），候选按
 * realpath 去重、发现点聚合进 sources。只读每个候选的 SKILL.md 元数据（stat 类型检查
 * ＋大小/超时双界），不读凭据、不读其他文件。
 *
 * 主机导入默认由 skill-store 创建受管软链，显式 copy 才走复制/载荷限制；
 * Bot 仍只读文件远传。本模块只做：候选身份校验（仅接受最近一次
 * 扫描返回的 path，接口不能变成任意路径读取器）、逐项失败聚合、结果形状组装。
 *
 * 不依赖 electron：主进程 IPC（skills.ipc.mjs）与 Bot 命令桥拦截（bot.ipc.mjs）
 * 共用同一实现，测试可直接对真实 createSkillStore 跑。
 */
import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

import { parseSkillMetadata } from './skill-definition.mjs';

/** 用户级候选根（相对 home；顺序即候选排序顺序）。 */
export const USER_LEVEL_SKILL_ROOTS = [
  ['.agents', 'skills'],
  ['.claude', 'skills'],
  ['.codex', 'skills'],
  ['.cursor', 'skills'],
  ['.gemini', 'skills'],
  ['.config', 'opencode', 'skills'],
];

/** 本机工作区下的项目级根（与 project-skills.mjs 的 PROJECT_SKILL_DIRS 一致）。 */
export const PROJECT_LEVEL_SKILL_ROOTS = [
  ['.agents', 'skills'],
  ['.claude', 'skills'],
];

const MAX_WORKSPACE_ROOTS = 12;
const MAX_CANDIDATES = 100;
const MAX_WARNINGS = 20;
const MAX_BATCH = 50;
const MAX_METADATA_BYTES = 128 * 1024;
const READ_TIMEOUT_MS = 3000;
/** Windows 文件系统大小写不敏感，比较键统一折叠；其余平台保持原样。 */
const caseKey = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const reasonOf = (error) => String(error?.code ?? error?.message ?? error).split('\n')[0];

/**
 * 收集一层根下的技能目录：直接子目录带 SKILL.md 即候选；子目录本身没有 SKILL.md
 * 才下钻一层找「组/技能」形态。深度有界（≤2），数量有界。
 * @returns {Promise<{found:Array<{real:string;discoveredAt:string}>;warnings:string[]}>}
 */
async function collectSkillDirs(root) {
  const found = [];
  const warnings = [];
  const seen = new Set();
  let names;
  try {
    names = (await readdir(root))
      .filter((name) => !name.startsWith('.') && !name.startsWith('._'))
      .sort();
  } catch (error) {
    // 根不存在是常态（用户没装对应 agent），只有存在但读不了才值得报。
    if (error.code !== 'ENOENT') warnings.push(`无法读取 ${root}（${reasonOf(error)}）`);
    return { found, warnings };
  }
  const consider = async (dir, discoveredAt) => {
    if (found.length >= MAX_CANDIDATES || seen.has(caseKey(dir))) return null;
    seen.add(caseKey(dir));
    try {
      if (!(await lstat(dir)).isDirectory()) return null; // 普通文件不是候选也不刷 warning。
    } catch (error) {
      warnings.push(`无法读取 ${discoveredAt}（${reasonOf(error)}）`);
      return null;
    }
    let entries;
    try {
      entries = await readdir(dir);
    } catch (error) {
      warnings.push(`无法读取 ${discoveredAt}（${reasonOf(error)}）`);
      return null;
    }
    if (!entries.includes('SKILL.md')) return entries;
    found.push({ real: dir, discoveredAt });
    return null;
  };
  for (const name of names) {
    const discoveredAt = path.join(root, name);
    let real;
    try {
      real = await realpath(discoveredAt);
    } catch {
      warnings.push(`跳过失效软链 ${discoveredAt}`);
      continue;
    }
    const childEntries = await consider(real, discoveredAt);
    if (!childEntries) continue; // 已是候选或读不了（consider 内已记 warning）。
    // 组形态：本层无 SKILL.md 才下钻一层。
    for (const child of childEntries.filter((item) => !item.startsWith('.') && !item.startsWith('._')).sort()) {
      const childDiscoveredAt = path.join(discoveredAt, child);
      let childReal;
      try {
        childReal = await realpath(childDiscoveredAt);
      } catch {
        continue;
      }
      await consider(childReal, childDiscoveredAt);
    }
    if (found.length >= MAX_CANDIDATES) break;
  }
  return { found, warnings, hitCap: found.length >= MAX_CANDIDATES };
}

/**
 * 扫描本地 agent 技能。
 * @param {object} deps
 * @param {() => string} deps.home 用户主目录（注入以便测试）
 * @param {() => Array<{dir:string;name:string}>} [deps.listWorkspaceDirs] 本机工作区（现有工作区服务投影）
 * @param {() => Array<{name:string;sourcePath:(string|null)}>} [deps.getInstalled]
 *   技能库安装列表（installed 语义：metadata 同名——技能库全局唯一，同名再导入必被拒；
 *   或本地来源 sourcePath realpath 相同）。支持同步数组或 Promise。
 * @returns {{ok:true;candidates:Array;warnings:string[];acceptedPaths:Set<string>} | {ok:false;reason:string}}
 */
export async function scanLocalAgentSkills({ home, listWorkspaceDirs, getInstalled }) {
  const homeDir = path.resolve(String(home()));
  if (!path.isAbsolute(homeDir)) return { ok: false, reason: '无法确定用户主目录' };
  const warnings = [];
  const roots = [];
  for (const parts of USER_LEVEL_SKILL_ROOTS) {
    roots.push({ root: path.join(homeDir, ...parts), labelPrefix: '~', base: homeDir });
  }
  const workspaces = (listWorkspaceDirs?.() ?? [])
    .filter((item) => item && typeof item.dir === 'string' && path.isAbsolute(item.dir))
    .slice(0, MAX_WORKSPACE_ROOTS);
  for (const workspace of workspaces) {
    for (const parts of PROJECT_LEVEL_SKILL_ROOTS) {
      roots.push({ root: path.join(workspace.dir, ...parts), labelPrefix: workspace.name, base: workspace.dir });
    }
  }
  const byReal = new Map();
  for (const { root, labelPrefix, base } of roots) {
    const { found, warnings: rootWarnings, hitCap } = await collectSkillDirs(root);
    warnings.push(...rootWarnings);
    if (hitCap) warnings.push(`${root} 候选超过 ${MAX_CANDIDATES} 个，已截断（请缩小扫描范围）`);
    for (const { real, discoveredAt } of found) {
      const relative = path.relative(base, discoveredAt).split(path.sep).join('/');
      const label = `${labelPrefix}/${relative}`;
      const key = caseKey(real);
      if (byReal.has(key)) byReal.get(key).sources.push(label);
      else byReal.set(key, { real, sources: [label] });
    }
  }
  let installedNames = new Set();
  let installedSourcePaths = new Set();
  try {
    const installed = (await getInstalled?.()) ?? [];
    installedNames = new Set(installed.map((item) => String(item?.name ?? '').toLowerCase()).filter(Boolean));
    for (const item of installed) {
      if (!item?.sourcePath) continue;
      try {
        installedSourcePaths.add(caseKey(await realpath(item.sourcePath)));
      } catch {
        installedSourcePaths.add(caseKey(path.resolve(item.sourcePath)));
      }
    }
  } catch {
    // 安装列表读不到只影响 installed 标记，不阻塞扫描。
  }
  const candidates = [];
  const acceptedPaths = new Set();
  for (const { real, sources } of byReal.values()) {
    if (candidates.length >= MAX_CANDIDATES) {
      warnings.push(`候选超过 ${MAX_CANDIDATES} 个，已截断（请缩小扫描范围）`);
      break;
    }
    try {
      const file = path.join(real, 'SKILL.md');
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw Object.assign(new Error('SKILL.md 是软链（导入不支持）'), { code: 'skip' });
      if (!info.isFile()) throw Object.assign(new Error('SKILL.md 不是普通文件'), { code: 'skip' });
      if (info.size > MAX_METADATA_BYTES) throw Object.assign(new Error(`SKILL.md 超过 ${Math.round(MAX_METADATA_BYTES / 1024)} KiB`), { code: 'skip' });
      const bytes = (await readFile(file, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })).subarray(0, MAX_METADATA_BYTES);
      const metadata = parseSkillMetadata(bytes.toString('utf8'));
      candidates.push({
        path: real,
        name: metadata.name,
        description: metadata.description,
        sources,
        installed: installedNames.has(metadata.name.toLowerCase()) || installedSourcePaths.has(caseKey(real)),
      });
      acceptedPaths.add(real);
    } catch (error) {
      warnings.push(`跳过 ${real}（${reasonOf(error)}）`);
    }
  }
  if (warnings.length > MAX_WARNINGS) {
    const dropped = warnings.length - MAX_WARNINGS;
    warnings.splice(MAX_WARNINGS, dropped, `……其余 ${dropped} 条省略`);
  }
  return { ok: true, candidates, warnings, acceptedPaths };
}

/**
 * 批量导入（逐项失败不中断）。
 * @param {object} deps
 * @param {(dir:string) => Promise<{ok:true;skill:unknown;state?:unknown}>} deps.importOne
 *   单项导入：主窗口传 store.importDirectory；Bot 桥传「本地读文件 + skills.import 远传」。
 * @param {() => unknown} [deps.state] 导入后的状态来源（importOne 不带 state 时兜底）。
 * @param {string[]} deps.paths 渲染层勾选的候选 path（必须来自最近一次 scan）。
 * @param {Set<string>} deps.acceptedPaths 最近一次扫描接受的候选集合。
 * @returns {{ok:boolean;imported:number;failed:Array<{path:string;reason:string}>;state?:unknown;reason?:string}}
 *   ok＝failed 为空（全部成功）；部分/全部失败时 ok=false，imported 仍为成功数。
 */
export async function importLocalAgentSkills({ importOne, state, paths, acceptedPaths, options }) {
  const requested = [...new Set((Array.isArray(paths) ? paths : []).map((item) => String(item ?? '')))].filter(Boolean);
  const finish = (result) => {
    const resolved = { ok: true, imported: 0, failed: [], ...result };
    if (resolved.state == null && state) {
      try { resolved.state = state(); } catch { /* 状态读不到不掩盖导入结果 */ }
    }
    if (!resolved.ok && !resolved.reason) {
      resolved.reason = resolved.imported > 0
        ? `已导入 ${resolved.imported} 个，${resolved.failed.length} 个失败`
        : (resolved.failed[0]?.reason ?? '导入失败');
    }
    return resolved;
  };
  if (requested.length > MAX_BATCH) {
    return finish({ ok: false, reason: `一次最多导入 ${MAX_BATCH} 个技能，请分批勾选` });
  }
  const allowed = new Set([...(acceptedPaths ?? [])].map((item) => caseKey(path.resolve(item))));
  const failed = [];
  let imported = 0;
  let lastState;
  for (const item of requested) {
    const normalized = path.resolve(item);
    if (!allowed.has(caseKey(normalized))) {
      failed.push({ path: item, reason: '路径不在扫描结果中，请重新扫描后再导入' });
      continue;
    }
    try {
      const result = await importOne(normalized, options);
      if (result?.ok === false) throw new Error(result.reason ?? '导入失败');
      imported += 1;
      if (result?.state) lastState = result.state;
    } catch (error) {
      failed.push({ path: item, reason: reasonOf(error) });
    }
  }
  return finish({
    ok: failed.length === 0,
    imported,
    failed,
    ...(lastState ? { state: lastState } : {}),
  });
}

/**
 * 扫描/导入网关：绑定扫描来源与导入通道，记住最近一次扫描接受的候选集合。
 * 主窗口（skills.ipc）与 Bot 命令桥拦截（bot.ipc）各持一个实例。
 */
export function createLocalSkillScanner({ home, listWorkspaceDirs, getInstalled, importOne, state }) {
  let acceptedPaths = new Set();
  return {
    async scan() {
      const result = await scanLocalAgentSkills({ home, listWorkspaceDirs, getInstalled });
      if (result.ok) acceptedPaths = result.acceptedPaths;
      // acceptedPaths 是主进程内部事实，不跨桥外发。
      const { acceptedPaths: _internal, ...visible } = result;
      return visible;
    },
    async import(paths, options) {
      return importLocalAgentSkills({ importOne, state, paths, acceptedPaths, options });
    },
  };
}
