/**
 * 042 · 任务访问上下文：把权限服务翻译成门控/工具用的同步查询与授权动作。
 * 每个执行器会话一份（pi-session 创建）——任务工作区自动授权（edit，任务级）、
 * 桌面目标解析（驱动 bundleId＋短 TTL 缓存）、路径→授权范围、授权卡应答落库、
 * 沙箱范围汇总。权限服务的并发/落盘语义见 permission-service.mjs。
 */
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';

import { isWithin, resolveTarget } from './safe-path.mjs';
import { findInstalledApplication } from '../../services/installed-apps.mjs';
import { appResourceId } from '../../services/permission-service.mjs';
import { hitsDenyPrefix } from './pi-gate.mjs';
import { SYSTEM_WRITE_ROOTS } from './policy.mjs';

const APP_LIST_TTL_MS = 3000;

/** 宿主 .app 包根（process.execPath 形如 …/X.app/Contents/MacOS/X）；开发态无包则 null。 */
function hostAppBundle() {
  const m = /^(.*?\.app)\//.exec(process.execPath);
  return m ? m[1] : null;
}


/** 056：按授权范围共享的在途授权卡（同一对话的主/子 agent 并行请求同一资源只出一张卡）。 */
const inflightByScope = new Map();

export function createAccessContext({
  service, taskId, grantScopeId = null, home = os.homedir(), workspaceDir = null, cwd = null, listAppWindows,
  controlRoots = null,
  skillRoots = null,
  findApplication = findInstalledApplication,
  log = null,
}) {
  const execCwd = cwd ?? workspaceDir ?? home;
  // 家目录真实路径（家目录在软链卷上时，真实落点按它判硬拒）。
  let realHome = home;
  try { realHome = realpathSync(home); } catch { /* 家目录读不到时按原值 */ }
  // 056：授权卡「本任务允许」落在对话级范围（主 agent 与它派出的全部子 agent 共用一份，
  // 用户点一次、这个对话里谁再访问都不再问）；没有对话范围时退回任务自身。
  const cardScopeId = grantScopeId ?? taskId;
  const scopeIds = cardScopeId === taskId ? taskId : [taskId, cardScopeId];
  let lastDesktopTarget = null;
  let appListCache = { at: 0, apps: [] };

  // 控制面（模型工具硬拒）：授权库所在目录（userData：授权库/配置/记忆底稿）＋宿主 .app 包。
  // userData/workspace 是任务工作区根（033：默认工作区在 workspace/default），不属控制面
  // ——2026-10-08 会话审计：这里原先写成复数 workspaces（磁盘上不存在的死路径），
  // 默认工作区整棵落进控制面，ls/read 相对路径全被「Hemi 自身的控制文件」硬拒，
  // 工作区自动 edit 授权也被 scopeForPath 的控制面前置检查作废（042 起，真机实录：
  // 天气任务只读核实读不回交付文件，靠浏览器重核兜底）。
  const storeDir = service.storeDir ?? null;
  const controls = (controlRoots ?? [storeDir, hostAppBundle()]).filter(Boolean);
  const controlExempt = storeDir ? [path.join(storeDir, 'workspace')] : [];
  // 034 Skill 只读租约：任务受理时冻结的本任务 Skill 版本目录。SKILL.md 的相对资源
  // （references/scripts）按提示词约定从该文件夹读取，但目录在 userData 控制面内——
  // 2026-10-10 会话审计：八字 skill 的全部资源被「控制文件」硬拒＋沙箱 readDirs 不含它，
  // 执行器只能违反 skill 契约自行口算。只豁免租约内的目录（未租约的同级版本照拒），
  // 且只开读面：写面由 controls 继续覆盖（scopeForPath 对租约早返回 access 档，
  // 授权卡无法把它升成 edit）。
  const skillLeaseRoots = [...new Set((skillRoots ?? []).filter(Boolean).map((p) => path.resolve(p)))];
  const skillRootFor = (real) =>
    skillLeaseRoots.find((root) => isWithin(root, real)) ?? null;

  // 2026-10-15 文件夹授权退役：工作区不再落一条「任务级 edit 授权」——文件读写本就完全访问；
  // 默认工作区在 userData 控制面内，靠 controlExempt（判定）（仅文件工具）开回。

  async function apps({ fresh = false } = {}) {
    if (typeof listAppWindows !== 'function') return [];
    const now = Date.now();
    if (fresh || now - appListCache.at > APP_LIST_TTL_MS) {
      try {
        appListCache = { at: now, apps: await listAppWindows() };
      } catch (error) {
        log?.debug?.(`访问范围应用清单刷新失败：${error?.message ?? error}`);
        return appListCache.apps;
      }
    }
    return appListCache.apps;
  }

  const ctx = {
    taskId,
    home,

    /**
     * 同一授权范围内对同一资源的并行授权请求合并成一张卡：已有在途的就等它的选项。
     * 只在落对话级范围时合并（没有对话范围的单任务会话照旧各问各的）。
     */
    sharedGrantPrompt(key, ask) {
      if (cardScopeId === taskId) return ask();
      let table = inflightByScope.get(cardScopeId);
      if (!table) { table = new Map(); inflightByScope.set(cardScopeId, table); }
      const pending = table.get(key);
      if (pending) return pending;
      const run = Promise.resolve().then(ask).finally(() => {
        table.delete(key);
        if (!table.size) inflightByScope.delete(cardScopeId);
      });
      table.set(key, run);
      return run;
    },
    workspaceDir,
    cwd: execCwd,

    /** 2026-10-15 用户裁决：本机文件读写完全访问（只有应用操作要授权）；执行层只复核硬拒。 */
    fullFileAccess: true,
    /** 真实落点命中硬拒（家内敏感点文件/个人数据库）——软链进出都按真实路径判。 */
    deniedRealPath: (real) => hitsDenyPrefix(real, home) || (realHome !== home && hitsDenyPrefix(real, realHome)),
    /** 系统目录不可写（读放行：/usr/bin 等工具与系统文件要能读；win 用 SystemRoot/Program* 根表）。 */
    // Windows 文件系统不区分大小写：SystemRoot 常见为 C:\WINDOWS，盘上实际 C:\Windows——
    // 大小写敏感比较会让系统目录拦截被真实落点绕过（2026-10-22 win 真机实锤，写入成功）。
    systemWriteRoot: (real) => {
      const fold = process.platform === 'win32';
      const normalize = (value) => (fold ? value.toLowerCase() : value);
      return SYSTEM_WRITE_ROOTS.some((root) => {
        const candidate = normalize(real), base = normalize(root);
        return candidate === base || candidate.startsWith(`${base}${path.sep}`);
      });
    },

  /** ui_tree/ui_act 后记录当前桌面目标（pi-ax 调），供 ui_act 等无目标调用归属。 */
    recordDesktopTarget(target) {
      if (target?.bundleId || target?.pid) lastDesktopTarget = target;
    },

    /**
     * 解析桌面调用的目标应用。显式目标（target.pid / app）解析不到即 null（拒绝），
     * 绝不退回「最近快照」——否则对未知 pid 的动作会按上一个已授权应用放行。
     * 无显式目标：ui_tree 读前台应用（与 pi-ax 执行口径一致）；ui_act 用本任务快照。
     */
    async appBundleFor(input, tool = null) {
      // app_open：目标是「已安装应用」而非运行中窗口，按安装清单精确解析。
      if (tool === 'app_open') {
        const hit = await findApplication(input?.app);
        return hit ? { bundleId: hit.bundleId, name: hit.name } : null;
      }
      const pick = (hit) => (hit?.bundleId ? { bundleId: hit.bundleId, name: hit.name, pid: hit.pid } : null);
      const target = input?.target;
      const appName = typeof input?.app === 'string' && input.app.trim() ? input.app.trim() : null;
      const find = (list) => {
        if (target?.pid != null) return list.find((a) => a.pid === Number(target.pid));
        if (appName) return list.find((a) => a.name === appName || a.bundleId === appName);
        if (tool === 'ui_tree') return list.find((a) => a.frontmost);
        return undefined;
      };
      if (target?.pid != null || appName || tool === 'ui_tree') {
        // 缓存未命中（新开的应用/前台刚切换）强刷一次再判定。
        return pick(find(await apps())) ?? pick(find(await apps({ fresh: true })));
      }
      if (tool === 'ui_act' && lastDesktopTarget?.bundleId) return lastDesktopTarget;
      return null;
    },

    /** 控制面判定（授权库/宿主代码）：真实路径落在控制根内即是（租约 Skill 目录除外）。 */
    isControlPath(real) {
      if (!real) return false;
      if (controlExempt.some((root) => isWithin(root, real))) return false;
      if (skillLeaseRoots.length && skillRootFor(real)) return false;
      return controls.some((root) => isWithin(root, real));
    },

    /** 路径归一（gate 的 resolvePath 注入）：显示路径用 ~ 缩短。 */
    async resolvePath(raw) {
      // 相对路径按执行器真实 cwd 解析（与 SDK/沙箱同一基准）；授权与否另由 scopeForPath 判，
      // 未绑定工作区的任务 cwd 有值但 workspaceDir 为 null——两者不能混用。
      const t = await resolveTarget(raw, { home, base: execCwd });
      const display = t.real.startsWith(home) ? `~${t.real.slice(home.length)}` : t.real;
      return { ...t, display };
    },

    /** 路径 → 覆盖它的授权范围：取全部覆盖 grant 中能力最强的（持久 access 不能遮住任务 edit）。 */
    scopeForPath(real) {
      // Skill 租约早返回：只读 access 档，后续 grant 扫描不参与——用户/卡片授权
      // 不得把受控 Skill 版本目录升成可写。
      if (skillLeaseRoots.length && skillRootFor(real)) {
        return { kind: 'skill-lease', capability: 'access' };
      }
      if (ctx.isControlPath(real)) return null;
      if (workspaceDir && isWithin(workspaceDir, real)) {
        return { kind: 'workspace', capability: 'edit' };
      }
      // 2026-10-15 文件夹授权退役：其余路径不再按授权范围判（文件读写完全访问）。
      return null;
    },

    /** 能力检查（service 的并集/任务可见性语义）。 */
    check(resourceId, capability = 'access') {
      return service.checkAccess({ taskId: scopeIds, resourceId, capability });
    },

    /** 授权卡「本任务允许」：落任务级应用授权（2026-10-15 起只有应用授权卡）。 */
    grantFromCard({ target }) {
      service.noteResource({ type: 'app', identityKey: target.bundleId, displayName: target.name, ownedRoots: [] });
      return service.grantTaskScope({ taskId: cardScopeId, resourceId: appResourceId(target.bundleId), capability: 'access' });
    },

    /** 授权卡「持续允许」：持久化应用授权；失败保底任务级并如实返回。 */
    async grantPersistentFromCard({ target }) {
      const out = await service.upsertCardGrant({
        type: 'app', identityKey: target.bundleId, displayName: target.name, capability: 'access',
      });
      if (!out?.ok) ctx.grantFromCard({ target });
      return out;
    },

  };
  return ctx;
}
