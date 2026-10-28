/**
 * 042 · access-policy：四值判定核心（deny / request_grant / confirm_action / allow）。
 * 纯函数＋注入查询（service 侧能力检查由宿主以 check/scopeFor/appScope 注入，
 * 桌面目标解析以 resolveAppBundle 注入）——本模块不 import 服务与驱动，单测直驱。
 *
 * 判定顺序（判定矩阵「判定结果及优先级」的代码化）：
 *   硬拒绝（hardline/控制面/未知工具/verify 写）→ 风险确认（dangerous）→
 *   资源能力（缺→request_grant；身份不明→deny）→ allow。
 * 能力二值：access/edit（编辑含访问）；对象二类：应用/目录。
 * 应用范围跟随应用：app grant 覆盖其 ownedRoots 的读取。
 */

import { DELIVERY_TOOL_NAME } from './pi-delivery.mjs';

export const VERDICT = {
  deny: 'deny',
  requestGrant: 'request_grant',
  confirmAction: 'confirm_action',
  allow: 'allow',
};

/**
 * 无需授权的宿主结构化/记忆工具（沿用 025/032 的免问口径）。056：主 agent 的派单族与
 * 宿主诊断也免问——它们本身无副作用，子 agent 的每一步仍各自过门控。
 */
// 引用读取的对话／派发范围和来源权限由 context-extension/context-store 复核。
const ALWAYS_ALLOWED_TOOLS = new Set(['job_list','job_output','job_kill','task', 'task_status', 'task_message', 'task_cancel', 'context_read', 'task_read', 'conversation_read', 'get_runtime_diagnostics', 'workflow_wait', 'memory_read', 'memory_write', 'memory_forget', 'memory_restore', 'scratchpad']);
/** 桌面只发现：最小身份，不返回内容（矩阵 ui_list 行）。 */
const DISCOVERY_TOOLS = new Set(['ui_list']);
/** 文件类工具（read/write/edit 走 path 参数；ls/grep/glob 走 path 或 cwd）。 */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'glob']);
/** 桌面动作类：需要目标应用 access。 */
const DESKTOP_TOOLS = new Set(['app_open', 'ui_tree', 'ui_click', 'ui_type', 'ui_key', 'ui_scroll', 'ui_act', 'screen_view']);
/** 浏览器/联网：由功能开关（features）前置把关，矩阵行按本任务上下文执行。 */
const FEATURE_TOOLS = new Set(['browser_tabs', 'browser_navigate', 'browser_extract', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_act', 'web_search', 'web_extract']);
/** verify/收尾只放读取：桌面只留 ui_tree/screen_view，浏览器拒操作类（矩阵 verify 列）。 */
const DESKTOP_READ_TOOLS = new Set(['ui_tree', 'screen_view']);
const BROWSER_ACTION_TOOLS = new Set(['browser_click', 'browser_type', 'browser_act']);

const deny = (reasonCode, message) => ({ verdict: VERDICT.deny, reasonCode, message });
const allow = () => ({ verdict: VERDICT.allow });

/**
 * @param {object} q 注入查询：
 *   hardline(command) → {hit, description} | null       命令灾难级（detect.mjs）
 *   dangerous(command) → {hit, description, category} | null 命令危险级（detect.mjs＋Q4 覆盖写）
 *   secretRead(command) → {hit, description} | null      凭据类路径读取（052 R-06；054 R-04 起本机同拦）
 *   classifyCommand(command) → 'read'|'write'|'unknown'  命令分级（052 R-02/R-07）
 *   deniedPath(realPath, rawPath, home) → string | null  路径硬拒绝原因（.ssh/系统根）
 *   scopeForPath(realPath) → { kind, capability } | null 路径所在范围（只用于识别 Skill 租约）
 *   systemWriteRoot(realPath) → boolean                  系统目录（不可写）
 *   appScope(bundleId) → { ok } | { ok:false, reasonCode }（注入宿主的 checkAccess）
 *   resolveAppBundle(input) → { bundleId, name } | null  桌面目标归属（驱动+plist）
 *   isControlPath(realPath) → boolean                    控制面（授权库/宿主代码）
 * @param {string|null} boundary 052 R-07 任务边界：'readonly'＝只读任务（非只读
 *   bash/写文件/界面动作直接拒，不弹卡）；null/'writable'＝缺省（今天的行为＋R-03）。
 */
export function judgeAccess({ tool, input, phase = 'run', workspaceDir = null, remoteHost = null, boundary = null, q }) {
  const args = input || {};
  const readonly = phase === 'verify' || phase === 'closure';

  // —— 宿主结构化/记忆工具：沿用既有免问口径（verify 写类拒）。
  // 056：只读边界（explorer/oracle 以 run＋boundary readonly 建会话）与 verify 阶段同样拒写记忆、
  // 拒登记交付——角色白名单之外再兜一层。
  const noWrites = readonly || boundary === 'readonly';
  const noWriteCode = readonly ? 'READ_ONLY_PHASE' : 'BOUNDARY_READONLY';
  if (tool === DELIVERY_TOOL_NAME) {
    return noWrites ? deny(noWriteCode, '只读任务：不登记交付') : allow();
  }
  if (tool === 'workflow_preparation') {
    return noWrites && !['list', 'get'].includes(args.action)
      ? deny(noWriteCode, '只读任务：不修改工作流准备卡') : allow();
  }
  if (ALWAYS_ALLOWED_TOOLS.has(tool)) {
    if (noWrites && /write|forget|restore|scratchpad/.test(tool)) {
      return deny(noWriteCode, '只读任务：不写记忆');
    }
    return allow();
  }

  // —— 命令：verify 拒 → hardline 拒 → 远端敏感读取拒（052 R-06）→ 只读边界拒
  //    （052 R-07）→ 危险级独立确认（R-03 类别随行）→ 本机直接执行／远端执行。
  if (tool === 'bash') {
    // 矩阵 Bash 行 verify 列：deny，读取核验改用结构化工具（任意 shell 不能当受限只读通道）。
    if (readonly) return deny('READ_ONLY_PHASE', '只读核实模式：不执行命令，请用 read/ls/grep 核对');
    const command = String(args.command ?? '');
    const hardline = q.hardline?.(command);
    if (hardline?.hit) return deny('HARDLINE', `禁止执行（${hardline.description}）；请改用不涉及该操作的替代命令`);
    // 052 R-06／054 R-04：凭据类路径的读取直接拒（硬拒不弹卡）——内容会进模型
    // 上下文。054 放开 ~/.ssh 只读后本机同样拦截（ssh/git 进程自读密钥不受影响，
    // 规则只看命令文本）。
    const secret = q.secretRead?.(command);
    if (secret?.hit) {
      return deny('SECRET_READ', `不读取敏感文件（${secret.description}${remoteHost ? `，目标在 ${remoteHost} 上` : ''}）；检查存在性或有效期请改用 stat、openssl x509 -noout -enddate 这类不读内容的方式`);
    }
    // 052 R-07：只读边界任务里，任何非只读命令直接拒（不弹卡）。
    if (boundary === 'readonly') {
      const cls = q.classifyCommand?.(command) ?? 'unknown';
      if (cls !== 'read') {
        return deny('BOUNDARY_READONLY', '本任务是只读任务：不执行任何写操作或状态修改；请只用查询类命令，把发现的结论写进报告');
      }
    }
    const dangerous = q.dangerous?.(command);
    if (dangerous?.hit) {
      return {
        verdict: VERDICT.confirmAction,
        summary: `${remoteHost ? `在 ${remoteHost} 上` : ''}执行命令：${command.split('\n')[0].slice(0, 120)}`,
        reason: dangerous.description,
        digest: command,
        // 052 R-04：风险类别（任务内同类确认合并的键）。
        category: dangerous.category ?? 'dangerous',
      };
    }
    // 054 R-02：联网不再按命令文本拦截（直接命令可联网；「联网搜索」开关只管
    // web_search/web_extract 工具注册，与命令无关）。
    return allow(); // 文件工具策略不构成任意 shell／脚本的 OS 级隔离。
  }

  // —— 文件工具：路径解析 → 控制面/硬拒绝 → 授权范围（access/edit）。
  if (FILE_TOOLS.has(tool)) {
    // ls/grep/glob 缺省 path＝任务工作目录（与工具执行口径一致）；read/write/edit 必填。
    const raw = typeof args.path === 'string' && args.path ? args.path
      : typeof args.cwd === 'string' && args.cwd ? args.cwd
        : (!['read', 'write', 'edit'].includes(tool) ? '.' : null);
    if (!raw) return deny('IDENTITY_UNKNOWN', '缺少路径参数');
    const needEdit = tool === 'write' || tool === 'edit';
    // resolveTarget 在宿主侧先做（异步）；这里收 { real, raw, abs } 注入。
    const target = q.resolvePath ? q.resolvePath(raw) : { real: raw, raw };
    const hardDeny = q.deniedPath?.(target.real, target.raw);
    if (hardDeny) return deny('HARDLINE', `路径在禁止清单内：${target.raw}（凭据与个人数据位置，Hemi 一律不访问，没有可打开的设置）`);
    if (q.isControlPath?.(target.real)) return deny('HARDLINE', '该路径属于 Hemi 自身的控制文件，不能访问');
    // 052 R-07：只读边界任务不修改任何文件（不弹卡）。
    if (boundary === 'readonly' && needEdit) {
      return deny('BOUNDARY_READONLY', '本任务是只读任务：不修改任何文件；只允许读取与检查');
    }
    if (readonly && needEdit) return deny('READ_ONLY_PHASE', '只读核实模式：只允许读取与检查');
    const scope = q.scopeForPath?.(target.real) ?? null;
    // 034 Skill 租约（只读）：isControlPath 已按租约豁免，读走 allow；写不进
    // 编辑卡流程（受控版本目录不能被授权升级成可写）。
    if (scope?.kind === 'skill-lease' && needEdit) {
      return deny('HARDLINE', 'Skill 目录是 Hemi 管的受控版本（只读），不能修改');
    }
    // 2026-10-15 用户裁决「只保留应用级授权」：文件读写默认完全访问（本机与远端一致），不再有
    // 文件夹授权卡——守住的只剩上面的硬拒（家目录敏感点文件、系统根、个人数据库、Hemi 控制面、
    // Skill 租约只读）与只读角色不写；本机 bash 按用户权限直接执行，
    // 远端 bash 本就不按目录拦（危险命令卡＋凭据硬拒）。系统目录不可写（读放行）。
    if (needEdit && q.systemWriteRoot?.(target.real)) {
      return deny('HARDLINE', `不能修改系统目录：${target.raw}`);
    }
    return allow();
  }

  // —— 桌面工具：目标应用归属 → app access。
  if (DESKTOP_TOOLS.has(tool)) {
    if (readonly && !DESKTOP_READ_TOOLS.has(tool)) {
      return deny('READ_ONLY_PHASE', '只读核实模式：不操作桌面应用，只允许读取界面');
    }
    // 052 R-07：只读边界任务不操控界面（点击/键入都改状态），只允许读取界面。
    if (boundary === 'readonly' && !DESKTOP_READ_TOOLS.has(tool)) {
      return deny('BOUNDARY_READONLY', '本任务是只读任务：不操控界面，只允许查看与读取');
    }
    if (tool === 'screen_view' && !args.target) {
      return deny('IDENTITY_UNKNOWN', '缺少目标窗口：先用 ui_list 选择目标应用的窗口，整屏截图不再默认提供');
    }
    const app = q.resolveAppBundle?.(args) ?? null;
    if (!app) return deny('IDENTITY_UNKNOWN', '没能确认目标窗口属于哪个应用：先 ui_list 查目标，一次只授权一个应用');
    const check = q.appScope?.(app.bundleId) ?? { ok: false, reasonCode: 'UNAUTHORIZED' };
    if (check.ok) return allow();
    if (readonly) return deny('READ_ONLY_PHASE', '只读核实模式：该操作需要授权，已自动拒绝');
    return {
      verdict: VERDICT.requestGrant,
      kind: 'app',
      capability: 'access',
      label: app.name || app.bundleId,
      app: { bundleId: app.bundleId, name: app.name || app.bundleId },
      summary: `允许 Hemi 访问「${app.name || app.bundleId}」？`,
      detail: ['访问窗口（界面文字与截图会发给主脑模型）'],
    };
  }

  // —— 发现类（最小身份）：放行。
  if (DISCOVERY_TOOLS.has(tool)) return allow();

  // —— 浏览器/联网：功能开关由挂载方控制（features 关了根本不注册），此处放行。
  if (FEATURE_TOOLS.has(tool)) {
    if (BROWSER_ACTION_TOOLS.has(tool) && (readonly || boundary === 'readonly')) {
      return deny(readonly ? 'READ_ONLY_PHASE' : 'BOUNDARY_READONLY', '本任务不操作网页（只读），只允许浏览与读取');
    }
    return allow();
  }

  // —— 未知工具：保守拒绝（矩阵「未知工具 deny」行）。
  return deny('UNSUPPORTED_CHANNEL', `未知工具 ${tool}：Hemi 尚未为它定义访问边界`);
}
