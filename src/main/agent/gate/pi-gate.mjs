// Hemi 门控扩展 —— 042 起为四值判定（access-policy）：deny / request_grant /
// confirm_action / allow。033 内置化（InlineExtension 在主进程注册）不变。
//
// 042 语义（用户裁决链）：
//  - 三档模式（confirm/review/full）与「本会话/永远允许」白名单整体退役；
//    授权卡三选一＝本任务允许 / 持续允许 / 拒绝；危险操作独立确认两钮。
//  - 能力二值 access/edit（编辑含访问）；对象两类 应用/目录；应用范围跟随应用。
//  - verify/收尾阶段缺授权自动拒（不弹卡扩大权限）。
//
// 052（低打扰权限策略）：
//  - R-04：风险确认按「任务 × 主机 × 风险类别」合并——本闭包（＝一个执行器会话
//    ＝一个任务）持 Map；「本任务允许」后同类直接放行、「拒绝」后同类直接拒，
//    不跨任务（Q2 裁决），随会话销毁自然清理。
//  - R-05：确认超时不再 terminate——本次操作视为跳过，模型收到「继续做不依赖
//    它的部分」的指引；用户点拒绝的语义不变（仍 terminate）。
//  - Q4：cp/mv/tee/sed -i/重定向目标落在系统目录时按「目标是否已存在」分派——
//    覆盖已存在文件 → 风险确认；新建（如 .bak 备份）→ 放行。存在性经注入的
//    pathExists 探测（本机 fs / 远端 test -e），探测失败按已存在保守处理。
//
// 命令 hardline/dangerous 仍走 policy.mjs＋detect.mjs（hardline 拒、dangerous
// 独立确认）；文件/桌面资源判定走 access-policy＋注入的 access 上下文。
import os from 'node:os';
import path from 'node:path';

import { detectDangerous, detectHardline } from './detect.mjs';
import { judgeAccess } from './access-policy.mjs';
import { POLICY_PATHS, SYSTEM_WRITE_ROOTS, SYSTEM_WRITE_ROOTS_REMOTE } from './policy.mjs';
import { classifyCommand, detectRemoteSecretRead, systemConfigOverwriteTargets } from './command-class.mjs';
import { fmtMs } from '../../lib/perf.mjs';

export const GRANT_TASK = '本任务允许';
export const GRANT_PERSISTENT = '持续允许';
export const GRANT_DENY = '拒绝';
export const GRANT_OPTIONS = [GRANT_TASK, GRANT_PERSISTENT, GRANT_DENY];
/** 052 R-04：风险卡两钮——「本任务允许」（本任务内同类操作不再询问）／拒绝。 */
export const ACTION_TASK = GRANT_TASK;
export const ACTION_OPTIONS = [ACTION_TASK, GRANT_DENY];
/** 旧文案兼容（自驱动应答等旧调用方）：放行本次，不记忆同类合并。 */
const ACTION_ONCE_COMPAT = '允许这次';
/**
 * Hemi 侧 30 秒主计时（005 裁决）；扩展侧超时只是兜底（undefined → 扩展按跳过处理），
 * 必须大于宿主的 30s（技术方案 D-7）。052 Q3 裁决：保持 35s，超时语义改跳过（R-05）。
 */
const CONFIRM_TIMEOUT_MS = 35000;

/** 命中禁止路径：家目录下的敏感点文件，或系统根区。 */
export function hitsDenyPath(target, home, roots = POLICY_PATHS.denyPathRoots) {
  return hitsDenyPrefix(target, home) || hitsDenyRoots(target, roots);
}

/** 家目录下的敏感点文件（.ssh/.env 等）按家内首段判；个人数据库（邮件/信息/Cookie…）按多段前缀判。 */
export function hitsDenyPrefix(target, home) {
  if (!home || !target) return false; // 远端 home 未探测到时只按系统根区判
  const rel = path.relative(home, target);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const firstSegment = rel.split(path.sep)[0];
    if (POLICY_PATHS.denyPathPrefixes.includes(firstSegment)) return true;
    // 子路径清单按 POSIX 写（本机 mac 与远端 Linux 通用）；Windows 的 rel 是反斜杠，
    // 比对前先归一成 '/'，否则 ~/Library/Mail 一族在 win 全部漏判（2026-10-20 win CI 实锤）。
    const lowered = rel.toLowerCase().split(path.sep).join('/');
    if (POLICY_PATHS.denyHomeSubpaths.some((sub) => {
      const prefix = sub.toLowerCase();
      return lowered === prefix || lowered.startsWith(`${prefix}/`);
    })) return true;
  }
  return false;
}

/**
 * 系统根区（/System、/Library 等）——只按**原始指定路径**判。macOS 的
 * firmlink/cryptex 会把良性路径解析进系统卷（/Applications/Safari.app →
 * /System/Volumes/Preboot/Cryptexes/…），按实路径判会把正常访问误杀成拒绝。
 * 049 R-07：远端（Linux 服务器）用 denyPathRootsRemote 清单（/opt、/srv、
 * /var/lib 等），由调用方注入。
 */
export function hitsDenyRoots(target, roots = POLICY_PATHS.denyPathRoots) {
  return roots.some((root) => target === root || target.startsWith(`${root}/`));
}

/** 判定前需异步解析目标应用的桌面工具（与 access-policy 的 DESKTOP_TOOLS 一致）。 */
const DESKTOP_GATED_TOOLS = new Set(['app_open', 'ui_tree', 'ui_click', 'ui_type', 'ui_key', 'ui_scroll', 'ui_act', 'screen_view']);

/**
 * 042 门控工厂：四值判定＋两种卡片（授权卡/风险卡）。
 * config 形状：
 *   taskMode/taskMode()  'run' | 'verify'（只读复核）
 *   taskText             任务原文（卡片归属显示）
 *   workspaceDir         033 任务工作目录
 *   access               任务访问上下文（access-context.mjs；缺省时桌面/文件
 *                        资源判定退化为拒绝——测试与旧调用方显式注入）
 *   boundary             052 R-07 任务边界：'readonly' | 'writable' | null（缺省）
 *   pathExists           052 Q4 存在性探测 (p) => Promise<boolean|null>（缺省本机 fs）
 *   log                  可选 logger
 */
export function hemiGate(pi, { config = {} } = {}) {
  // 049：远端任务的 home/禁根按服务器身份（Linux 根区清单）；本机缺省不变。
  const home = typeof config.home === 'string' && config.home ? config.home : os.homedir();
  const remoteHost = typeof config.remoteHost === 'string' && config.remoteHost ? config.remoteHost : null;
  const denyRoots = remoteHost ? POLICY_PATHS.denyPathRootsRemote : POLICY_PATHS.denyPathRoots;
  const workspaceDir = typeof config.workspaceDir === 'string' && config.workspaceDir ? config.workspaceDir : null;
  // 052 R-07：任务边界（053 派单字段经 pi-session 注入；缺省 null＝今天的行为）。
  const boundary = config.boundary === 'readonly' ? 'readonly' : null;
  const currentMode = () => {
    const value = typeof config.taskMode === 'function' ? config.taskMode() : config.taskMode;
    return value === 'verify' || value === 'closure' ? value : 'run';
  };
  const access = config.access ?? null;

  // 052 R-04：任务内同类确认记忆（Map<主机|类别, allow|deny>）。闭包＝任务级：
  // 会话销毁即清理，不落盘、不跨任务（Q2 裁决）。
  const taskConfirmations = new Map();
  const confirmationKey = (category) => `${remoteHost ?? 'local'}|${category ?? 'dangerous'}`;

  // 052 Q4：目标存在性探测。注入的 pathExists 优先（远端 test -e）；缺省本机 fs。
  // 返回三值：true 存在 / false 不存在 / null 探测失败（按存在保守处理）。
  const localPathExists = async (p) => {
    try {
      const { statSync } = await import('node:fs');
      statSync(p);
      return true;
    } catch (error) {
      return error?.code === 'ENOENT' ? false : null;
    }
  };
  const pathExists = typeof config.pathExists === 'function' ? config.pathExists : localPathExists;

  pi.on('tool_call', async (event, ctx) => {
    const mode = currentMode();
    const gateStartedAt = Date.now();

    // 052 Q4：系统目录覆盖写探测（cp/mv/tee/sed -i/重定向）。静态 dangerous 规则
    // 覆盖不到「目标是否已存在」的语义，这里先探测、结果经 q.dangerous 并入判定。
    let overwriteConfirmed = null;
    if (event.toolName === 'bash' && mode === 'run') {
      const command = String(event.input?.command ?? '');
      const roots = remoteHost ? SYSTEM_WRITE_ROOTS_REMOTE : SYSTEM_WRITE_ROOTS;
      const targets = systemConfigOverwriteTargets(command, roots, workspaceDir);
      if (targets.length) {
        const results = await Promise.all(targets.slice(0, 8).map((target) => pathExists(target)));
        // 任一目标已存在＝覆盖 → 确认；探测失败（null）按已存在保守处理。
        overwriteConfirmed = results.some((exists) => exists !== false)
          ? { hit: true, description: '改写系统配置（覆盖已存在的目标）', category: 'system-config' }
          : null;
      }
    }

    // 判定注入：hardline/dangerous 沿用 detect；路径/应用解析经 access 上下文。
    const q = {
      hardline: (c) => {
        const hit = detectHardline(c);
        return hit?.hit ? hit : null;
      },
      dangerous: (c) => {
        const hit = detectDangerous(c);
        if (hit?.hit) return hit;
        return overwriteConfirmed;
      },
      // 054 R-04：本机与远端同样拦命令文本直读凭据（沙箱已放开 ~/.ssh 只读）。
      secretRead: (c) => {
        const hit = detectRemoteSecretRead(c);
        return hit?.hit ? hit : null;
      },
      classifyCommand: (c) => classifyCommand(c),
      deniedPath: (real, raw) => (hitsDenyPath(real, home, denyRoots) || hitsDenyRoots(raw, denyRoots)
        ? '路径在禁止清单内' : null),
      isControlPath: access?.isControlPath?.bind(access) ?? (() => false),
      scopeForPath: access ? (real) => access.scopeForPath(real) : () => null,
      // 2026-10-15：文件夹授权退役后系统目录不可写由此兜（本机/远端各自的系统根清单）。
      // 家目录内一律不算系统目录（服务器的家可能就在 /var、/opt 之下）。
      systemWriteRoot: (real) => {
        const value = String(real);
        if (home && (value === home || value.startsWith(`${home}/`))) return false;
        return (remoteHost ? SYSTEM_WRITE_ROOTS_REMOTE : SYSTEM_WRITE_ROOTS)
          .some((root) => value === root || value.startsWith(`${root}/`));
      },
      appScope: access ? (bundleId) => access.check(`app:${bundleId}`, 'access') : () => ({ ok: false, reasonCode: 'UNAUTHORIZED' }),
      resolveAppBundle: () => null, // 异步：桌面工具在判定前先解析（见下）
      resolvePath: null, // 异步：在判定前先解析（见下）
    };

    // 文件类调用先把路径归一（safe-path），把结果塞进 q 供纯函数判定。
    // ls/grep/glob 缺省 path 与工具执行口径一致：任务工作目录。
    const fileDefault = ['ls', 'grep', 'glob'].includes(event.toolName) ? '.' : null;
    const rawPath = event.input?.path || event.input?.cwd || fileDefault;
    let resolvedTarget = null;
    if (typeof rawPath === 'string' && rawPath) {
      resolvedTarget = access ? { raw: rawPath, ...(await access.resolvePath(rawPath)) } : { raw: rawPath, real: rawPath, abs: rawPath };
      q.resolvePath = () => resolvedTarget;
    }
    // 桌面调用的目标应用解析是异步的（驱动查窗口），同样先解析再交给纯函数。
    if (access && DESKTOP_GATED_TOOLS.has(event.toolName)) {
      const app = await access.appBundleFor(event.input ?? {}, event.toolName).catch(() => null);
      q.resolveAppBundle = () => app;
    }

    const verdict = judgeAccess({
      tool: event.toolName,
      input: event.input,
      phase: mode === 'run' ? 'run' : mode,
      workspaceDir,
      remoteHost,
      boundary,
      q,
    });

    const gateMs = Date.now() - gateStartedAt;
    if (gateMs >= 300) config.log?.debug?.(`门控判定 ${fmtMs(gateMs)} · ${event.toolName} → ${verdict.verdict}`);

    if (verdict.verdict === 'deny') {
      // 规则拒绝只拦这一次调用（不 terminate）：模型可换合规路线（005 真机教训保留）。
      return { block: true, reason: `${verdict.message}；请改用不涉及该操作的替代方式继续` };
    }
    if (verdict.verdict === 'allow') return;

    if (verdict.verdict === 'confirm_action') {
      // 052 R-04：任务内同类合并——判定前查表，命中直接放行/拒绝（不弹卡）。
      // 类别缺省 'dangerous'（未标类别的既有规则）；键含主机（本地/远端不互认）。
      const category = verdict.category ?? 'dangerous';
      const mergeKey = confirmationKey(category);
      const remembered = taskConfirmations.get(mergeKey);
      if (remembered === 'allow') {
        config.log?.info?.(`门控合并放行（${mergeKey}）：本任务内已允许同类操作`);
        return;
      }
      if (remembered === 'deny') {
        config.log?.info?.(`门控合并拒绝（${mergeKey}）：本任务内已拒绝同类操作`);
        return {
          block: true,
          reason: `本任务内该类操作（${verdict.reason}）已被拒绝；请改用别的做法或跳过`,
        };
      }
      // 独立风险确认：两钮；「本任务允许」后同类不再问（Q1 裁决），不产生任何 grant。
      const title = JSON.stringify({
        kind: 'action',
        summary: verdict.summary,
        note: `危险操作：${verdict.reason}。本任务内同类操作不再询问。`,
        tool: event.toolName,
        args: event.input ?? {},
        options: ACTION_OPTIONS,
        category,
      });
      const choice = await ctx.ui.select(title, ACTION_OPTIONS, { timeout: CONFIRM_TIMEOUT_MS });
      if (choice === ACTION_TASK) {
        taskConfirmations.set(mergeKey, 'allow');
        return;
      }
      if (choice === ACTION_ONCE_COMPAT) return; // 旧值：只放行本次，不记忆
      if (choice === GRANT_DENY) {
        taskConfirmations.set(mergeKey, 'deny');
        return { block: true, reason: '用户拒绝了这一步', terminate: true };
      }
      // 052 R-05：确认超时不再失败——本次操作按跳过处理（不 terminate），
      // 指引模型继续做不依赖它的部分、在终态正文交代跳过了什么。
      return {
        block: true,
        reason: '这一步未获确认，已跳过。继续完成不依赖它的部分，并在最终总结里说明这一步被跳过及原因',
      };
    }

    // request_grant：只剩应用授权卡（2026-10-15 文件夹授权退役）。落库经 access 上下文。
    const target = { bundleId: verdict.app?.bundleId ?? '', name: verdict.app?.name ?? verdict.label };
    // 目标身份缺失（如 ui_tree 前台应用解析失败）时不应发卡——identity_unknown 已在
    // 判定层拦；此处防御：app 卡无 bundleId 直接按拒绝处理（不写半空资源）。
    if (!target.bundleId) {
      config.log?.warn?.('桌面目标 bundleId 缺失，本次调用拒绝（不产生空授权）');
      return { block: true, reason: '没能确认目标窗口属于哪个应用：先 ui_list 查目标，一次只授权一个应用' };
    }
    const detail = verdict.detail ?? []; // 能力说明由 access-policy 的卡面 detail 统一给出
    const title = JSON.stringify({
      kind: 'grant',
      summary: verdict.summary,
      note: detail.join('；'),
      tool: event.toolName,
      args: event.input ?? {},
      options: GRANT_OPTIONS,
    });
    // 056：同一对话里并行的子 agent 同时请求同一个应用的授权时只出一张卡——先到的发卡，
    // 后到的等它的结果（access 上下文按对话级授权范围共享在途表）。
    const askCard = () => ctx.ui.select(title, GRANT_OPTIONS, { timeout: CONFIRM_TIMEOUT_MS });
    const choice = access?.sharedGrantPrompt
      ? await access.sharedGrantPrompt(`app:${target.bundleId}`, askCard)
      : await askCard();
    if (choice === GRANT_TASK) {
      access?.grantFromCard({ kind: verdict.kind, capability: verdict.capability, target });
      return;
    }
    if (choice === GRANT_PERSISTENT) {
      const out = access
        ? await access.grantPersistentFromCard({ kind: verdict.kind, capability: verdict.capability, target })
        : { ok: false };
      if (!out?.ok) {
        config.log?.warn?.('持续授权保存失败：已按本任务范围放行（保存失败如实记录）');
      }
      return;
    }
    return {
      block: true,
      reason: choice === GRANT_DENY ? '用户拒绝了这一步' : '确认超时，未获允许',
      terminate: true,
    };
  });
}

export default hemiGate;
