// 033 · 工作区登记（主进程唯一权威）：默认工作区 + 用户项目目录列表。
//
// 职责与边界：
// - 默认工作区是固定身份（id='default'）的真实本地目录，按需创建，不落登记表；
//   每次新建对话先绑定它（R-01），此前的项目选择不改变下一次新建的默认。
// - 项目目录只登记身份（稳定 id、显示名、规范化路径、最近使用），由用户经
//   系统目录选择器主动添加（R-02）——不扫描磁盘；移除列表项不删磁盘文件；
//   同一路径（含符号链接别名）按 realpath 去重。
// - 目录失效（删除/卸载/拒绝访问）只如实标 missing，不猜测替代目录（R-07）。
// - 回合受理时从这里取快照冻结（llm.ipc → 主 agent／子 agent），执行 cwd、门控边界、成果
//   登记共用同一份身份。
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认工作区的稳定身份（会话绑定与快照都用它；不是登记表 id 空间）。 */
export const DEFAULT_WORKSPACE_ID = 'default';
/** 登记表版本（读取层按字段兼容旧档，不走迁移）。 */
export const WORKSPACE_REGISTRY_VERSION = 1;
/** 登记表项目数量上限：列表是导航入口不是收藏夹，超限裁最旧。 */
export const MAX_PROJECTS = 20;

const PROJECT_ID_RE = /^ws-[a-z0-9]+$/;

/**
 * 默认工作区磁盘位置（033；2026-10-01 用户裁决：对齐 ZCode 口径——应用数据
 * 根下的 `workspace/default`，共享一个目录、随实例隔离（ZCode 为
 * `~/.zcode/workspace/default`，Hemi 的数据根是 userData：生产
 * `~/Library/Application Support/hemi`、dev 随 hemi-dev、自驱动随注入目录）。
 * dataRoot 注入以便测试。
 */
export function defaultWorkspaceDir(dataRoot) {
  return path.join(String(dataRoot ?? os.homedir()), 'workspace', 'default');
}

function newProjectId(now = Date.now()) {
  return `ws-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 目录现状检查：返回 { status: 'ok' | 'missing', realDir, message? }。 */
function inspectDir(dir) {
  try {
    const real = realpathSync(dir);
    const stats = statSync(real);
    if (!stats.isDirectory()) {
      return { status: 'missing', realDir: dir, message: '路径不是文件夹' };
    }
    return { status: 'ok', realDir: real, message: null };
  } catch (error) {
    const hint = error?.code === 'ENOENT' ? '目录不存在或已移走' : `无法访问（${error?.code ?? '权限或挂载异常'}）`;
    return { status: 'missing', realDir: dir, message: hint };
  }
}

/**
 * 登记视图（渲染层与任务快照共用形状）：
 *   { id, type: 'default' | 'project', name, dir, status: 'ok' | 'missing', message?,
 *     host?, remoteHome? }
 * dir 恒为绝对路径（远端＝服务器上的真实 POSIX 路径）。本机项目 status 实时探测
 * （外接盘随时可能卸载）；远端项目 status 来自探测缓存（选中/发送前/重试时更新，
 * 不在每次读取时探测——太慢，技术方案 R-04/13），无缓存按 ok 起步。
 */
function viewOf(entry, { type }) {
  if (entry.host) {
    const cached = remoteStatusCache.get(entry.id);
    return {
      id: entry.id,
      type,
      name: entry.name,
      dir: entry.dir,
      host: entry.host,
      ...(entry.remoteHome ? { remoteHome: entry.remoteHome } : {}),
      status: cached?.status ?? 'ok',
      ...(cached?.message ? { message: cached.message } : {}),
    };
  }
  const inspected = inspectDir(entry.dir);
  return {
    id: entry.id,
    type,
    name: entry.name,
    dir: inspected.status === 'ok' ? inspected.realDir : entry.dir,
    status: inspected.status,
    ...(inspected.message ? { message: inspected.message } : {}),
  };
}

/** 远端工作区连接状态缓存（进程内；addRemote/probe 时更新，R-09）。 */
const remoteStatusCache = new Map();

/**
 * 工作区登记工厂。
 * @param {object} deps
 * @param {string} deps.filePath 登记表 JSON 路径（生产 userData/workspaces.json）
 * @param {string} [deps.dataRoot] 应用数据根（默认工作区定位 userData；注入以便测试）
 * @param {Function} [deps.log]
 */
export function createWorkspaceStore({ filePath, dataRoot = os.homedir(), log = null }) {
  if (!filePath) throw new Error('workspace-store 缺少登记表路径');
  let registry = { version: WORKSPACE_REGISTRY_VERSION, projects: [] };
  let corrupt = false;

  function load() {
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return; // 首次使用：空表起步
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('结构不完整');
      const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
      registry = { version: WORKSPACE_REGISTRY_VERSION, projects: [] };
      for (const item of projects) {
        if (!item || typeof item.id !== 'string' || !PROJECT_ID_RE.test(item.id)) continue;
        if (typeof item.dir !== 'string' || !path.isAbsolute(item.dir)) continue;
        // 049：远端条目带 host（SSH 目标）与 remoteHome（登记时探测的 $HOME）；
        // 旧档无 host 字段＝本机项目，行为不变（specs R-04）。
        const host = typeof item.host === 'string' && item.host.trim() && item.host.trim() !== 'local'
          ? item.host.trim()
          : null;
        registry.projects.push({
          id: item.id,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 48) : path.basename(item.dir) || item.dir,
          // 远端条目的 dir 是服务器上的 POSIX 路径，不按本机平台语义归一
          // （win 的 path.normalize 会把 /srv/app 打成反斜杠，重启后与登记对不上）。
          dir: host ? path.posix.normalize(item.dir) : path.normalize(item.dir),
          ...(host ? { host, ...(typeof item.remoteHome === 'string' && item.remoteHome ? { remoteHome: item.remoteHome } : {}) } : {}),
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
          lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : 0,
        });
      }
    } catch (error) {
      // 损坏：不致命——空表起步并如实标注（界面可提示重新添加），不伪造条目。
      corrupt = true;
      registry = { version: WORKSPACE_REGISTRY_VERSION, projects: [] };
      log?.warn(`[workspace] 登记表损坏，按空表起步：${error.message}`);
    }
  }

  function persist() {
    const tmp = `${filePath}.tmp-${process.pid}`;
    const parent = path.dirname(filePath);
    mkdirSync(parent, { recursive: true });
    writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
    renameSync(tmp, filePath); // 同目录 rename：原子替换（对齐 009/015）
  }

  load();

  /** 默认工作区视图（固定身份；目录不存在时标 missing，由 ensure 处理）。 */
  function defaultView() {
    return viewOf(
      { id: DEFAULT_WORKSPACE_ID, name: '默认空间', dir: defaultWorkspaceDir(dataRoot) },
      { type: 'default' },
    );
  }

  /** 按需创建默认工作区目录（新建对话绑定前调用；失败如实返回，不回退别处）。 */
  function ensureDefault() {
    const dir = defaultWorkspaceDir(dataRoot);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      log?.warn(`[workspace] 默认工作区创建失败：${error.message}`);
      return { ok: false, reason: `默认工作区创建失败：${error.message}` };
    }
    return { ok: true };
  }

  /** 完整状态（渲染层上下文栏与侧栏项目区）。 */
  function getState() {
    const projects = [...registry.projects]
      .sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0))
      .map((entry) => viewOf(entry, { type: 'project' }));
    return { default: defaultView(), projects, ...(corrupt ? { corrupt: true } : {}) };
  }

  /** 按身份解析（任务受理快照来源）；'default' 或项目 id；未知返回 null。 */
  function resolve(id) {
    const wanted = String(id ?? '');
    if (wanted === DEFAULT_WORKSPACE_ID) return defaultView();
    const entry = registry.projects.find((item) => item.id === wanted);
    return entry ? viewOf(entry, { type: 'project' }) : null;
  }

  /** 会话绑定项目时刷新最近使用（列表排序依据；默认工作区不需要）。 */
  function touch(id, { at = Date.now() } = {}) {
    if (String(id ?? '') === DEFAULT_WORKSPACE_ID) return { ok: true };
    const entry = registry.projects.find((item) => item.id === String(id ?? ''));
    if (!entry) return { ok: false };
    entry.lastUsedAt = at;
    try {
      persist();
      return { ok: true };
    } catch (error) {
      log?.warn(`[workspace] 最近使用落盘失败：${error.message}`);
      return { ok: false };
    }
  }

  /**
   * 添加项目目录（系统目录选择器选定的绝对路径）。
   * realpath 去重：同一路径或其符号链接别名已登记时返回既有身份（ok:true）。
   * 允许家目录内外的任意用户目录（含嵌套/家目录本身——展示真实路径，门控
   * 以任务绑定目录判定，见 specs 待明确事项 4 的首批口径）。
   */
  function addProject(rawDir, { at = Date.now() } = {}) {
    const dir = path.normalize(String(rawDir ?? ''));
    if (!dir || !path.isAbsolute(dir)) return { ok: false, reason: '路径必须是绝对路径' };
    let real;
    try {
      real = realpathSync(dir);
      if (!statSync(real).isDirectory()) return { ok: false, reason: '路径不是文件夹' };
    } catch {
      return { ok: false, reason: '目录不存在或无法访问' };
    }
    const existing = registry.projects.find((item) => {
      if (item.host) return false; // 049 R-04：远端条目与本机路径不互为别名
      if (item.dir === real) return true;
      try {
        return realpathSync(item.dir) === real;
      } catch {
        return false;
      }
    });
    if (existing) {
      existing.lastUsedAt = at;
      try {
        persist();
      } catch (error) {
        log?.warn(`[workspace] 登记表落盘失败：${error.message}`);
      }
      return { ok: true, workspace: viewOf(existing, { type: 'project' }), deduped: true };
    }
    const entry = {
      id: newProjectId(at),
      name: path.basename(real) || real,
      dir: real,
      createdAt: at,
      lastUsedAt: at,
    };
    registry.projects.push(entry);
    // 容量裁剪：按最近使用留最新 MAX_PROJECTS 个（新加的必留）。
    if (registry.projects.length > MAX_PROJECTS) {
      registry.projects.sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
      registry.projects = registry.projects.slice(0, MAX_PROJECTS);
    }
    try {
      persist();
    } catch (error) {
      registry.projects = registry.projects.filter((item) => item.id !== entry.id);
      return { ok: false, reason: `登记失败：${error.message}` };
    }
    return { ok: true, workspace: viewOf(entry, { type: 'project' }) };
  }

  /**
   * 049 · 添加远端项目（probe 通过后由 IPC 层调用——登记的都已是服务器上验证过的
   * 真实路径）。身份＝主机＋远端真实路径（R-04：同名路径在不同主机不算同一项目）。
   */
  function addRemote({ host, dir, remoteHome = null, at = Date.now() } = {}) {
    const cleanHost = String(host ?? '').trim();
    // dir 是服务器上的 POSIX 路径：归一必须走 posix（win 的 path.normalize
    // 会把 /home/u/... 打成反斜杠，startsWith('/') 即拒，远端功能整个不可用）。
    const cleanDir = path.posix.normalize(String(dir ?? ''));
    if (!cleanHost || !cleanDir || !cleanDir.startsWith('/')) {
      return { ok: false, reason: '远端登记必须是主机名与服务器上的绝对路径' };
    }
    const existing = registry.projects.find((item) => item.host === cleanHost && item.dir === cleanDir);
    if (existing) {
      existing.lastUsedAt = at;
      if (remoteHome) existing.remoteHome = remoteHome;
      remoteStatusCache.set(existing.id, { status: 'ok' });
      try {
        persist();
      } catch (error) {
        log?.warn(`[workspace] 登记表落盘失败：${error.message}`);
      }
      return { ok: true, workspace: viewOf(existing, { type: 'project' }), deduped: true };
    }
    const entry = {
      id: newProjectId(at),
      name: path.posix.basename(cleanDir) || cleanHost,
      dir: cleanDir,
      host: cleanHost,
      ...(remoteHome ? { remoteHome } : {}),
      createdAt: at,
      lastUsedAt: at,
    };
    registry.projects.push(entry);
    remoteStatusCache.set(entry.id, { status: 'ok' });
    // 容量裁剪：按最近使用留最新 MAX_PROJECTS 个（新加的必留）。
    if (registry.projects.length > MAX_PROJECTS) {
      registry.projects.sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
      registry.projects = registry.projects.slice(0, MAX_PROJECTS);
    }
    try {
      persist();
    } catch (error) {
      registry.projects = registry.projects.filter((item) => item.id !== entry.id);
      return { ok: false, reason: `登记失败：${error.message}` };
    }
    return { ok: true, workspace: viewOf(entry, { type: 'project' }) };
  }

  /**
   * 049 · 远端连接状态缓存（选中/发送前/重试探测后由 IPC 层写入；getState/resolve
   * 读取）。仅内存——重启后按 ok 起步，首次发送前的探测会纠正。
   */
  function setRemoteStatus(id, status) {
    if (!status || !['ok', 'missing'].includes(status.status)) return;
    remoteStatusCache.set(String(id ?? ''), status);
  }

  /** 移除列表项（不删磁盘文件，远端条目也不动服务器；解绑会话由渲染层在下次绑定时改写）。 */
  function removeProject(id) {
    const before = registry.projects.length;
    registry.projects = registry.projects.filter((item) => item.id !== String(id ?? ''));
    remoteStatusCache.delete(String(id ?? ''));
    if (registry.projects.length === before) return { ok: false, reason: '没有这个项目' };
    try {
      persist();
    } catch (error) {
      return { ok: false, reason: `移除失败：${error.message}` };
    }
    return { ok: true };
  }

  return { getState, resolve, touch, addProject, addRemote, setRemoteStatus, removeProject, ensureDefault };
}
