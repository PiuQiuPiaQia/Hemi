// 027 桌面 AX 快车道 · 036 起后端切换 cua-driver（get_window_state 的元素
// 表 + element_token），agent-desktop 二进制退役。
//
// 分工不变：
//  - AX 友好应用（TextEdit/计算器/标准 AppKit/多数 Electron）走本扩展：
//    ui_tree 出带 token 的元素表 → ui_act 顺序无头操作元素（AX 语义动作/
//    窗口路由事件，不动鼠标、不抢焦点）；
//  - AX 盲应用（微信：几乎不暴露元素）由 ui_tree 的降级信号引导回
//    screen_view + ui_click 视觉坐标路线（006 + 036）。
//
// token 是驱动签发的不透明串（绑定快照，界面变化即过期）：树输出用短别名
// （t1/t2…）省 token 预算，ui_act 同时收别名与原始 token；过期报
// stale/invalid element_token，翻译文案引导重新 ui_tree。
import { execFile } from 'node:child_process';

import { cua as defaultCua, describeAction, describeToolResult } from './cua-client.mjs';
import { findInstalledApplication } from '../../services/installed-apps.mjs';

/** 单次 ui_act 最多动作数：批处理语义是「短序列」，不是程序。 */
export const AX_MAX_ACTIONS = 10;
/** 元素表行数上限：超了截断（模型可用 query 收窄）。 */
export const AX_TREE_LINE_CAP = 60;
/** 可操作元素数低于此值视为 AX 盲（微信实测全树仅 6 节点）：引导视觉路线。 */
export const AX_BARE_REF_THRESHOLD = 8;

/**
 * 042：快照改会话闭包作用域（此前模块级 lastSnapshot 会被并行任务互相覆盖——
 * 评审 V-02 实证 A 任务点到 B 任务窗口）。快照锚记录进 config.access（若有），
 * 供门控对 ui_act 这类无目标调用做应用归属判定。
 */

/**
 * ui_act 动作序列校验/归一（纯函数，单测覆盖）。ref 收别名（t3）或原始
 * token；op 同旧版（toggle 映射为 click——驱动的 AXPress 天然覆盖勾选语义）。
 */
export function buildUiActions(actions) {
  if (!Array.isArray(actions) || !actions.length) throw new Error('actions 至少要一项');
  if (actions.length > AX_MAX_ACTIONS) {
    throw new Error(`一次最多 ${AX_MAX_ACTIONS} 个动作（短序列批处理，不是程序）；超长流程分多次调用`);
  }
  return actions.map((action, index) => {
    const op = String(action?.op ?? action?.action ?? '').toLowerCase();
    const ref = String(action?.ref ?? '').trim();
    if (!ref && op !== 'press') throw new Error(`第 ${index + 1} 项缺少 ref（press 之外都要 ref）`);
    switch (op) {
      case 'click':
      case 'toggle':
        return { op: 'click', ref };
      case 'type': {
        const text = String(action?.text ?? '');
        if (!text) throw new Error(`第 ${index + 1} 项 type 缺少 text`);
        return { op: 'type', ref, text };
      }
      case 'set_value': {
        if (action?.value == null && action?.text == null) throw new Error(`第 ${index + 1} 项 set_value 缺少 value`);
        const value = String(action?.value ?? action?.text ?? '');
        return { op: 'set_value', ref, value };
      }
      case 'press': {
        const combo = String(action?.combo ?? '');
        if (!combo) throw new Error(`第 ${index + 1} 项 press 缺少 combo`);
        return { op: 'press', combo, ...(ref ? {ref} : {}) };
      }
      case 'scroll': {
        const direction = ['up', 'down'].includes(action?.direction) ? action.direction : 'down';
        return { op: 'scroll', ref, direction, amount: Number(action?.amount ?? 3) || 3 };
      }
      default:
        throw new Error(`第 ${index + 1} 项 op 不支持「${op}」（可用：click/type/set_value/press/toggle/scroll）`);
    }
  });
}

/** 元素表 → 行清单（纯函数，单测覆盖）。aliasOf 签发/复用短别名。 */
export function formatTreeElements(elements, aliasOf, cap = AX_TREE_LINE_CAP) {
  const lines = [];
  for (const el of elements ?? []) {
    if (!el.elementToken) continue;
    const role = String(el.role ?? '?');
    const name = String(el.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const actions = (el.actions ?? []).filter((a) => a !== 'SetFocus' && a !== 'Focus');
    const value = el.value == null ? '' : ` 值:${JSON.stringify(String(el.value).slice(0, 180))}`;
    lines.push(`[${aliasOf(el.elementToken)}] ${role}${name ? `「${name}」` : ''}${value}${el.enabled === false ? '（禁用）' : ''}${actions.length ? `可:${actions.join('/')}` : ''}`);
  }
  return { lines: lines.slice(0, cap), total: lines.length, truncated: lines.length > cap };
}

function checkAborted(signal) {
  if (signal?.aborted) throw new Error('操作已被中断，未执行后续动作');
}

/** 驱动错误/ToolResult → 可行动指引（模型能据此自愈，不用整任务失败）。 */
function explainAxError(error) {
  const code = String(error?.errorCode ?? error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  // AXTextArea 等不支持 AXPress（-25206）：元素级 click 打在文本区上的高频失败
  // （端到端验收实录），直接给出替代路线比让模型试错快。
  if (/AXPress|25206/i.test(`${code} ${message}`)) {
    return `该元素不支持按压动作（文本区常见）：改用 set_value 直接设值，或 ui_click 坐标点击后再 ui_type。`;
  }
  if (/app|window|pid/i.test(`${code} ${message}`) && /not|found|gone|invalid|closed/i.test(`${code} ${message}`)) {
    return `目标应用/窗口不可用（${message}）：可先 ui_list 查 pid/windowId；应用没开就用 app_open({app:"<应用名>"}) 后台打开，再 ui_tree({app:"<应用名>"})；不要为读取界面切换前台。`;
  }
  return message || code || '未知错误';
}

/**
 * 036：由 pi-session 无条件注册（AX 树纯文本，不依赖视觉模型——与 027 的
 * hemi-desktop-ax 挂载语义一致）。
 */
export default function hemiAx(pi, { config = {} } = {}) {
  if (config.enabled === false) return;
  const cua = config.driver ?? defaultCua;
  const findApplication = config.findApplication ?? findInstalledApplication;

  /** 本会话（＝本任务）的最近一次 ui_tree 快照：别名表＋窗口锚。 */
  let lastSnapshot = null;
  const access = config.access ?? null;

  pi.registerTool({
    name: 'ui_tree',
    label: '界面树',
    description: '读取应用的界面元素树（Accessibility，只读）：返回元素清单，每项带角色/名称/可用动作和 ref 别名（t1/t2…）。把返回的 ref 用于 ui_act 即可精确操作元素（比截图坐标快数倍、不动鼠标）。app 传系统的本地化显示名（中文系统如「计算器」「微信」）；不传取前台应用；query 可按文字过滤元素。',
    promptSnippet: 'ui_tree：读界面元素树（AX 快车道，桌面操控优先用它）',
    promptGuidelines: [
      '浏览器/网页内容（含 Web 应用、本地 HTML）不要用 ui_tree/ui_act——一律走 browser_* 工具（后台任务窗口，不碰用户屏幕）；本工具只面向浏览器之外的桌面应用。',
      '桌面操控优先走 ui_tree + ui_act 快车道：先 ui_tree 拿元素 ref，再 ui_act 批量操作——不截图、不动鼠标、不抢焦点，比视觉路线快数倍。app 用本地化显示名（如「计算器」），不传取前台应用；元素太多时用 query 过滤。',
      '读取后台应用时显式传 app，不需要先 activate。应用未运行时用 app_open({app:"<应用名>"}) 后台启动，再 ui_tree({app:"<应用名>"})；不要为了读取或截图把应用置前。',
      'ui_tree 返回元素太少（AX 盲，如微信）会明确提示：此时改用 screen_view + ui_click 视觉路线，不要反复重试 ui_tree。',
      '视觉路线（screen_view/ui_click）与 AX 快车道可以混用：看不清界面语义时 screen_view，操作走 ui_act。',
    ],
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '目标应用显示名（本地化，如「计算器」）；缺省取前台应用' },
        target: {type: 'object', properties: {pid: {type: 'number'}, windowId: {type: 'string'}}, required: ['pid', 'windowId'], description: 'ui_list 的精确窗口；同一应用有多个窗口时使用'},
        query: { type: 'string', description: '按 label/value 子串过滤元素（元素多时收窄）' },
      },
      required: [],
    },
    async execute(_id, params, signal) {
      checkAborted(signal);
      lastSnapshot = null;
      access?.recordDesktopTarget?.(null);
      let appName = String(params?.app ?? '').trim();
      let apps;
      try {
        apps = await cua.listAppWindows({ signal });
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `ui_tree 失败：${explainAxError(error)}` }] };
      }
      const entry = params?.target?.pid != null ? apps.find(a => a.pid === Number(params.target.pid) && (!appName || a.name === appName || a.bundleId === appName)) : appName
        ? apps.find((a) => a.name === appName || a.bundleId === appName)
        : apps.find((a) => a.frontmost);
      if (!entry) {
        return { isError: true, content: [{ type: 'text', text: `应用「${appName || '(前台)'}」没找到可用窗口：app 参数要用系统的本地化显示名（中文系统如「计算器」），且应用需在运行。可先 ui_list 查应用名；应用没开就用 app_open({app:"<应用名>"}) 后台打开，再显式传 app 重读，不需要切换前台。` }] };
      }
      const win = params?.target?.windowId ? entry.windows.find(window => window.windowId === String(params.target.windowId)) : entry.windows[0];
      if (!win) return {isError: true, content: [{type: 'text', text: '目标窗口不存在，请重新 ui_list 选择窗口。'}]};
      let state;
      try {
        state = await cua.windowState({
          pid: entry.pid, windowId: win.windowId, includeTree: true, includeScreenshot: config.captureGeometry === true,
          ...(params?.query ? { query: String(params.query) } : {}), timeoutMs: 2500, signal,
        });
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `ui_tree 失败：${explainAxError(error)}` }] };
      }
      const elements = state.elements ?? [];
      const actionable = elements.filter((el) => el.elementToken);
      if (actionable.length < (config.bareRefThreshold ?? AX_BARE_REF_THRESHOLD)) {
        return {
          content: [{
            type: 'text',
            text: `应用「${entry.name}」几乎不暴露界面元素（${actionable.length} 个可操作元素，AX 盲——微信等自绘应用）。请改用 screen_view + ui_click 视觉坐标路线，不要重试 ui_tree。`,
          }],
        };
      }
      const aliasToToken = new Map();
      let seq = 0;
      const aliasOf = (token) => {
        for (const [alias, t] of aliasToToken) if (t === token) return alias;
        const alias = `t${++seq}`;
        aliasToToken.set(alias, token);
        return alias;
      };
      const { lines, total, truncated } = formatTreeElements(elements, aliasOf);
      // 快照锚：ui_act 的 ref 解析与窗口路由都靠它（token 与快照绑定）。
      lastSnapshot = { aliasToToken, pid: entry.pid, windowId: win.windowId, appName: entry.name,
        pixelFrames: config.captureGeometry === true && Boolean(state.images?.length),
        frames: new Map(elements.filter(element => element.frame).map(element => [element.elementToken, element.frame])),
        width: state.screenshotWidth, height: state.screenshotHeight };
      access?.recordDesktopTarget?.({ pid: entry.pid, windowId: win.windowId, name: entry.name, bundleId: entry.bundleId ?? null });
      const header = `应用「${entry.name}」元素树（窗口「${state.windowTitle ?? win.title ?? ''}」，可操作元素 ${actionable.length} 个）：`;
      const usage = '用 ui_act 操作：{actions:[{op:"click", ref:"t12"}…]}；ref 见下表（可 click/type/set_value/press/toggle/scroll）。';
      const body = truncated ? `${lines.join('\n')}\n…（共 ${total} 项，已截断到 ${AX_TREE_LINE_CAP}；可用 query 参数过滤）` : lines.join('\n');
      return { content: [{ type: 'text', text: `${header}\n${usage}\n${body}` }] };
    },
  });

  pi.registerTool({
    name: 'ui_act',
    label: '元素操作',
    description: '按 ref 批量操作界面元素，默认后台执行。delivery="foreground" 允许驱动短暂置前目标窗口。actions 每项 {op, ref}，op ∈ click/type/set_value/press/toggle/scroll（type 带 text、press 带 combo、scroll 可带 direction/amount）。ref 来自最近一次 ui_tree。顺序执行、首个失败即停；执行后用 ui_tree 或 screen_view 核验。',
    promptSnippet: 'ui_act：按 ref 批量操作元素（AX 快车道）',
    promptGuidelines: [
      'ui_act 的 ref 必须来自最近一次 ui_tree（界面变了 ref 会过期，报过期就重新 ui_tree）；一次给一串连贯动作（如点输入框→键入→回车），比逐个调用快得多。',
      'ui_act 是无头执行：结果标注「未核验」表示已投递未逐项确认——重要结果用 ui_tree 重查元素状态或 screen_view 抽查。',
      'ui_act 失败提示 AX 盲时，改走 screen_view + ui_click 视觉路线。',
      '操作结束后，适当关闭本任务明确打开且已无用途的临时页面／对话框；先用新 ui_tree 核对，再定向操作。用户原有窗口、交付成果页、未保存内容要保留；不确定归属或出现保存提示就留下，不批量关闭应用。',
    ],
    parameters: {
      type: 'object',
      properties: {
        delivery: {type: 'string', enum: ['background', 'foreground'], description: '默认后台。foreground 允许驱动短暂置前目标窗口；用于已授权且后台不能正确投递的动作。'},
        actions: {
          type: 'array',
          description: '动作序列（≤10 项，顺序执行、首败即停）',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', description: 'click | type | set_value | press | toggle | scroll' },
              ref: { type: 'string', description: '元素 ref（ui_tree 的 t 别名，如 t12）' },
              text: { type: 'string', description: 'type/set_value 的内容' },
              value: {type: 'string', description: 'set_value 的完整值，空字符串用于清空'},
              combo: { type: 'string', description: 'press 的组合键（如 return、cmd+a）' },
              direction: { type: 'string', description: 'scroll 方向 up/down' },
              amount: { type: 'number', description: 'scroll 量' },
            },
            required: ['op'],
          },
        },
      },
      required: ['actions'],
    },
    async execute(_id, params, signal) {
      checkAborted(signal);
      let batch;
      try {
        batch = buildUiActions(params?.actions);
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `参数无效：${error.message}` }] };
      }
      const snap = lastSnapshot;
      if (!snap) {
        return { isError: true, content: [{ type: 'text', text: '还没有 ui_tree 快照：先对目标应用 ui_tree 拿 ref，再 ui_act。' }] };
      }
      const resolve = (ref) => snap.aliasToToken.get(ref) ?? (/^t\d+$/.test(ref) ? null : ref);
      const parts = [];
      for (let i = 0; i < batch.length; i++) {
        checkAborted(signal);
        const action = batch[i];
        const label = `${action.op}${action.ref ? ` ${action.ref}` : ''}`;
        let note = '';
        try {
          const token = action.ref ? resolve(action.ref) : null;
          if (action.ref && !token) throw new Error(`ref「${action.ref}」不在最近一次 ui_tree 里（界面变了或别名过期）：重新 ui_tree`);
          let result;
          if (action.op === 'click') {
            result = await cua.click({
              pid: snap.pid, windowId: snap.windowId, elementToken: token, delivery: params.delivery, signal,
            });
            note = describeAction(result).note;
          } else if (action.op === 'type') {
            result = await cua.typeText({
              text: action.text, elementToken: token, pid: snap.pid, windowId: snap.windowId, delivery: params.delivery, signal,
            });
            note = describeToolResult(result).note;
          } else if (action.op === 'set_value') {
            result = await cua.setValue({
              elementToken: token, value: action.value, pid: snap.pid, windowId: snap.windowId, signal,
            });
            note = describeToolResult(result).note;
          } else if (action.op === 'press') {
            result = await cua.key({
              combo: action.combo, elementToken: token, pid: snap.pid, windowId: snap.windowId, delivery: params.delivery, signal,
            });
            note = describeToolResult(result).note;
          } else if (action.op === 'scroll') {
            let point = {};
            if (config.captureGeometry === true) {
              const frame = snap.frames.get(token), x = Number(frame?.x) + Number(frame?.w) / 2, y = Number(frame?.y) + Number(frame?.h) / 2;
              if (!snap.pixelFrames || !frame || !(frame.w > 0 && frame.h > 0) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= snap.width || y >= snap.height) throw new Error('元素没有可用的窗口内截图坐标，请恢复窗口后重新 ui_tree；不要重试旧 ref');
              point = {x, y};
            }
            result = await cua.scroll({
              ...point,
              deltaY: action.direction === 'up' ? action.amount : -action.amount,
              delivery: params.delivery,
              pid: snap.pid, windowId: snap.windowId, signal,
            });
            note = describeToolResult(result).note;
          }
          const outcome = action.op === 'click' ? describeAction(result) : describeToolResult(result);
          if (outcome.actionState !== 'executed') throw new Error(outcome.note || '驱动未执行该动作');
        } catch (error) {
          parts.push(`✗ ${label}：${explainAxError(error)}`);
          break; // 首败即停
        }
        parts.push(`✓ ${label}${note ? `（${note}）` : ''}`);
      }
      const allOk = parts.length === batch.length && parts.every((p) => p.startsWith('✓'));
      return {
        isError: !allOk,
        content: [{
          type: 'text',
          text: `${parts.join('\n')}\n${allOk ? '全部已投递（未逐项核验；重要结果用 ui_tree 重查或 screen_view 抽查）。' : '序列在首个失败处停止，之后的动作未执行。'}`,
        }],
      };
    },
  });

  // 042：后台启动应用由宿主执行（沙箱内 /usr/bin/open 拿不到 LaunchServices，实测
  // 必败）。只接受已安装应用的显示名/bundleId，按 bundleId 打开、-g 不置前；
  // 门控按目标应用的「访问」授权判定（与 ui_tree 同一张授权卡），未授权不启动。
  pi.registerTool({
    name: 'app_open',
    label: '打开应用',
    description: '启动一个已安装的应用。app 传系统显示名或应用身份。应用已在运行时直接返回。macOS 在后台启动；Windows 应用可能切到前台。启动后用 ui_tree({app}) 读取界面。',
    promptSnippet: 'app_open：后台启动已安装应用（不置前）',
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: '应用显示名（本地化，如「计算器」）或 bundleId' } },
      required: ['app'],
    },
    async execute(_id, params, signal) {
      checkAborted(signal);
      const target = await findApplication(params?.app);
      if (!target) {
        return { isError: true, content: [{ type: 'text', text: `没找到名为「${String(params?.app ?? '')}」的已安装应用：请用系统里显示的应用名（如「计算器」），或先 ui_list 看正在运行的应用。` }] };
      }
      const running = await cua.listAppWindows({ signal });
      if (running.some((a) => a.bundleId === target.bundleId)) {
        return { content: [{ type: 'text', text: `「${target.name}」已在运行，可直接 ui_tree({app:"${target.name}"})。` }] };
      }
      if (config.openApplication) {
        await config.openApplication(target, signal);
        return {content: [{type: 'text', text: `已请求打开「${target.name}」。窗口出现后用 ui_list / ui_tree 读取并确认。`}]};
      }
      const failure = await new Promise((resolve) => {
        execFile('/usr/bin/open', ['-g', '-b', target.bundleId], { timeout: 15_000 }, (err, _out, stderr) => {
          resolve(err ? String(stderr || err.message).trim() : null);
        });
      });
      if (failure) return { content: [{ type: 'text', text: `打开「${target.name}」失败：${failure}` }] };
      return { content: [{ type: 'text', text: `已在后台打开「${target.name}」（没有切换前台）。窗口出现可能需要一两秒；接着用 ui_tree({app:"${target.name}"}) 读取。` }] };
    },
  });
}
