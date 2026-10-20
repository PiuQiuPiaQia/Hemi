// 006 computer use 扩展（036 起后端全量切换 cua-driver，原语自建清零）。
//
// 职责不变：给执行模型注册桌面操控工具（D-4 工具集），系统触点全部委托
// ./cua-client.mjs（进程内 cua-driver 运行时：截图/AX/事件投递）。
//
// 环境输入：023 起开关经显式 config.enabled 注入。端点无视觉能力或用户关闭时
// 宿主不挂本扩展，回到 005 的工具面（降级路径）。
//
// 036 语义变化（相对 JXA 原语时代）：
//  - 靶向单位 pid + windowId（windowId 是 CGWindowID 字符串），不再靠窗口
//    几何锚＋漂移校验——驱动按窗口路由事件；
//  - 动作默认后台投递（不动真实指针、不抢焦点、无需恢复前台），确认卡抢
//    焦点不再威胁靶向正确性；target 仍然必填（路由需要）；
//  - 坐标即「该窗口最近一次 screen_view 截图的像素坐标」（窗口局部），
//    驱动自行换算，不再有像素→屏幕点的运行时映射；
//  - 中文键入走驱动的 AX Unicode 直插（spike 真机验证），无输入法依赖；
//  - details.actionState 语义沿用（executed | not-executed），来源映射见
//    cua-client 的 describeAction/describeToolResult。
import { cua, describeAction, describeToolResult, firstImage } from './cua-client.mjs';

import { VISION_ACT_TOOLS } from './policy.mjs';

export { VISION_ACT_TOOLS };

function checkAborted(signal) {
  if (signal?.aborted) throw new Error('操作已被中断，未执行后续动作');
}

function targetSchema() {
  return {
    type: 'object',
    description: '动作目标（来自 ui_list）：pid + windowId。驱动按窗口路由事件，后台投递不依赖焦点',
    properties: {
      pid: { type: 'number', description: '目标应用 PID' },
      windowId: { type: 'string', description: 'ui_list 里该窗口的 windowId（CGWindowID 字符串）' },
      bundleId: { type: 'string', description: '目标应用 bundle id（描述用）' },
      processName: { type: 'string', description: '目标应用名（确认卡摘要显示用）' },
      windowTitle: { type: 'string', description: '窗口标题（确认卡摘要显示用）' },
    },
    required: ['pid', 'windowId'],
  };
}

/** 动作缺窗口锚时的拒绝文案（带路由原因，不改用异常以便模型自愈）。 */
function missingTarget() {
  return '动作缺少目标窗口（pid + windowId，来自 ui_list）：驱动按窗口路由事件，缺了无法投递。本次动作未执行';
}

/**
 * 动作后截图（view:true / ui_type 默认）：拍目标窗口并附回。截图失败不推翻
 * 已执行的动作（006 既定语义）。
 */
async function finishWithScreenshot(prefix, executed, target, signal) {
  try {
    const state = await cua.windowState({
      pid: target.pid, windowId: target.windowId, includeScreenshot: true, signal,
    });
    const img = firstImage(state);
    if (!img) throw new Error('驱动未返回截图');
    return {
      content: [
        { type: 'text', text: `${prefix}（已附目标窗口截图 ${state.screenshotWidth}×${state.screenshotHeight}，坐标以这张图为准）` },
        { type: 'image', data: img.data, mimeType: img.mimeType },
      ],
      details: { actionState: executed ? 'executed' : 'not-executed' },
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `${prefix}。但后续截图失败：${error.message}——请用 screen_view 补一张再继续` }],
      details: { actionState: executed ? 'executed' : 'not-executed', screenshotError: error.message },
    };
  }
}

/** 动作不带 view 时的轻量回执：只报动作状态，尾注兼任批处理教学。 */
function finishWithoutScreenshot(prefix, executed, note = '') {
  const extra = note ? `（${note}）` : '';
  return {
    content: [
      { type: 'text', text: `${prefix}${extra}。未截图。后续连贯动作可在同一次回复里连续调用、不必每步核验；需要看结果时再 screen_view（或给动作传 view:true）` },
    ],
    details: { actionState: executed ? 'executed' : 'not-executed' },
  };
}

/** 动作失败（驱动拒绝/异常翻译后）：原因 + 新截图供重新定位（006 语义）。 */
async function notExecuted(reason, signal) {
  let shot = null;
  try {
    shot = firstImage(await cua.desktopState({ signal }));
  } catch { /* 尽力附图 */ }
  const content = [{ type: 'text', text: `${reason}。${shot ? '已附当前屏幕截图，请据此重新定位。' : ''}` }];
  if (shot) content.push({ type: 'image', data: shot.data, mimeType: shot.mimeType });
  return { content, details: { actionState: 'not-executed' } };
}

/**
 * 023 内置化后由 pi-session 注册；开关来自显式 config（R-06）：
 * config.enabled = true 才注册工具。
 */
export default function hemiVision(pi, { config = {} } = {}) {
  if (config.enabled !== true) return;

  pi.registerTool({
    name: 'screen_view',
    label: '截屏',
    description: '截取屏幕并返回图片（只读）。推荐传 target（ui_list 的 pid/windowId）：按目标窗口截，token 更省、小元素更清晰；都不传截主显示器。坐标原点在图片左上角，单位是图片像素；后续动作的 x/y 用这张图的像素坐标。',
    promptSnippet: 'screen_view：截屏（优先按目标窗口裁剪）',
    promptGuidelines: ['浏览器/网页内容（含 Web 应用、本地 HTML）一律用 browser_* 工具——它们在后台任务窗口执行、不碰用户屏幕；屏幕工具只用于浏览器之外的桌面应用，或网页的 DOM 与 AX 都拿不到时的最后手段。用户要"看页面"时也先在后台改完再说明，不因此切换到屏幕操作。', 'screen_view 是只读的：任何需要"看一眼屏幕"的场景（描述界面、找按钮、核对结果）都直接用它；要看某个应用就传 target（ui_list 的 pid/windowId）。不要用 bash 的 screencapture——那是写文件，会弹确认卡还绕过截图预算。', '连贯动作序列只在检查点看屏：序列末尾 screen_view 一次核验全部结果，比每步看一次快得多。'],
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          description: '可选：只截这个窗口（ui_list 的 pid/windowId）',
          properties: {
            pid: { type: 'number', description: '目标应用 PID' },
            windowId: { type: 'string', description: 'ui_list 里该窗口的 windowId' },
          },
          required: ['pid', 'windowId'],
        },
      },
      required: [],
    },
    async execute(_id, params, signal) {
      checkAborted(signal);
      if (params?.target && Number.isFinite(Number(params.target.pid)) && params.target.windowId) {
        const state = await cua.windowState({
          pid: Number(params.target.pid),
          windowId: String(params.target.windowId),
          includeScreenshot: true,
          signal,
        });
        const img = firstImage(state);
        if (!img) throw new Error('驱动未返回截图');
        return {
          content: [
            { type: 'text', text: `窗口「${state.windowTitle ?? ''}」截图（${state.screenshotWidth}×${state.screenshotHeight} 像素）。后续该窗口 ui_click/ui_scroll 的坐标用这张图的像素坐标（窗口局部，左上原点）。` },
            { type: 'image', data: img.data, mimeType: img.mimeType },
          ],
          details: { imageW: state.screenshotWidth, imageH: state.screenshotHeight },
        };
      }
      const desk = await cua.desktopState({ signal });
      const img = firstImage(desk);
      if (!img) throw new Error('驱动未返回截图');
      return {
        content: [
          { type: 'text', text: `主显示器截图。后续动作用这张图的像素坐标（左上原点）；要精确操控某个应用，请先 ui_list 拿 pid/windowId 再按窗口截图。` },
          { type: 'image', data: img.data, mimeType: img.mimeType },
        ],
      };
    },
  });

  pi.registerTool({
    name: 'ui_list',
    label: '窗口列表',
    description: '列出可见应用及其窗口（名称、PID、windowId、位置尺寸、是否前台）。操控前调用一次，把 pid/windowId 填进动作的 target 参数。',
    promptSnippet: 'ui_list：列出可见应用与窗口几何（只读）',
    promptGuidelines: ['ui_list 是只读的：操控前先 ui_list 拿目标应用的 pid 与 windowId，填进动作的 target 参数（screen_view/ui_click/ui_type/ui_key/ui_scroll 都要）。'],
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id, _params, signal) {
      checkAborted(signal);
      const apps = await cua.listAppWindows({ signal });
      const lines = apps.map((app) => {
        const wins = app.windows
          .map((w, i) => `    窗口[${i}] windowId=${w.windowId} ${w.title ? `「${w.title}」` : '(无标题)'} @(${w.x},${w.y}) ${w.w}×${w.h}`)
          .join('\n');
        return `${app.frontmost ? '▶' : ' '} ${app.name}（pid=${app.pid}${app.bundleId ? `, ${app.bundleId}` : ''}）\n${wins}`;
      });
      return {
        content: [{ type: 'text', text: `可见应用 ${apps.length} 个（▶=前台）。位置为屏幕点坐标：\n${lines.join('\n')}` }],
        details: { apps },
      };
    },
  });

  pi.registerTool({
    name: 'ui_click',
    label: '点击',
    description: '点击目标窗口。x/y 用该窗口最近一次 screen_view 截图的像素坐标（左上原点）；必须带 ui_list 返回的 target（pid/windowId），事件按窗口后台路由（不动真实指针、不抢焦点）。view:true 时附带操作后截图，默认不截图。',
    promptSnippet: 'ui_click：点击窗口坐标（需先 screen_view + ui_list；默认不附截图）',
    promptGuidelines: ['浏览器/网页内容（含 Web 应用、本地 HTML）一律用 browser_* 工具——它们在后台任务窗口执行、不碰用户屏幕；屏幕工具只用于浏览器之外的桌面应用，或网页的 DOM 与 AX 都拿不到时的最后手段。', '每个 ui_click 都必须带目标窗口的 target（pid/windowId）；缺 target 时动作会被拒绝。', 'ui_click 前先 screen_view 拿该窗口最新截图，坐标用截图的像素坐标；不要用过时截图当坐标基准。', '连贯动作序列（如点开菜单→点菜单项、点输入框→键入→回车）在一次回复里连续调用即可，中间步默认不带截图；在序列结束或需要确认结果时再用 screen_view（或给动作传 view:true）核验。', '文件、代码、命令行任务优先用 bash/read/write/edit 等既有工具，不要用屏幕工具。'],
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '截图像素 X' },
        y: { type: 'number', description: '截图像素 Y' },
        target: targetSchema(),
        view: { type: 'boolean', description: 'true＝附操作后截图（目标窗口）；默认 false（不截图，序列中间步用）' },
      },
      required: ['x', 'y', 'target'],
    },
    async execute(_id, params, signal, onUpdate) {
      checkAborted(signal);
      const target = params?.target;
      if (!target || !Number.isFinite(Number(target.pid)) || !target.windowId) {
        return notExecuted(missingTarget(), signal);
      }
      let result;
      try {
        result = await cua.click({
          pid: Number(target.pid), windowId: String(target.windowId),
          x: params.x, y: params.y, signal,
        });
      } catch (error) {
        return notExecuted(error.message, signal);
      }
      const { actionState, note } = describeAction(result);
      const executed = actionState === 'executed';
      const prefix = `已点击 (${Math.round(Number(params.x))},${Math.round(Number(params.y))}${note ? `，${note}` : ''})`;
      onUpdate?.({ content: [{ type: 'text', text: prefix }], details: { actionState } });
      if (params.view !== true) return finishWithoutScreenshot(prefix, executed);
      return finishWithScreenshot(prefix, executed, target, signal);
    },
  });

  pi.registerTool({
    name: 'ui_type',
    label: '键入',
    description: '向目标窗口键入文本（驱动的 AX 直插，中文/Emoji 直接键入不乱码、不经输入法）。先用 ui_click 点进输入框再键入。必须带 ui_list 返回的 target。默认附目标窗口截图核验文字落位（view:false 省略）。',
    promptSnippet: 'ui_type：向目标窗口键入文本（中文直插不乱码）',
    promptGuidelines: ['ui_type 必须带目标窗口 target（pid/windowId）。先 ui_click 点进输入框，再 ui_type，并在返回截图中确认文字落在正确输入框。', '中文/Emoji 直接用 ui_type 键入——运行时自动绕过输入法，不需要改用剪贴板。', '不要用 bash/pbcopy 绕过 ui_type：这会覆盖用户剪贴板且无法恢复。', '文件、代码、命令行任务优先用 bash/read/write/edit 等既有工具，不要用屏幕工具。'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        target: targetSchema(),
        view: { type: 'boolean', description: 'false＝不附截图（连贯序列的中间步）；默认附目标窗口截图核验文字落位' },
      },
      required: ['text', 'target'],
    },
    async execute(_id, params, signal, onUpdate) {
      const text = String(params.text ?? '');
      if (!text) throw new Error('text 不能为空');
      checkAborted(signal);
      const target = params?.target;
      if (!target || !Number.isFinite(Number(target.pid)) || !target.windowId) {
        return notExecuted(missingTarget(), signal);
      }
      let result;
      try {
        result = await cua.typeText({
          text, pid: Number(target.pid), windowId: String(target.windowId), signal,
        });
      } catch (error) {
        return notExecuted(error.message, signal);
      }
      const { actionState, note } = describeToolResult(result);
      const executed = actionState === 'executed';
      const prefix = `已键入 ${Array.from(text).length} 字${note ? `，${note}` : ''}`;
      onUpdate?.({ content: [{ type: 'text', text: prefix }], details: { actionState } });
      // 键入默认附图核验（view:false 才省掉）：文字落错位/落错框是高风险错误。
      if (params.view === false) return finishWithoutScreenshot(prefix, executed);
      return finishWithScreenshot(prefix, executed, target, signal);
    },
  });

  pi.registerTool({
    name: 'ui_key',
    label: '按键',
    description: '按组合键，如 "cmd+a"、"enter"、"shift+tab"、"esc"。必须带 ui_list 返回的 target。',
    promptSnippet: 'ui_key：按组合键（cmd+a / enter / esc…）',
    promptGuidelines: ['ui_key 必须带目标窗口 target（pid/windowId）；组合键写法如 cmd+a、enter、shift+tab、esc。每次按键后重新看返回截图再决定下一步。', '结束操作前回收本任务明确打开且已无用途的临时页面／对话框，先用新截图核对目标，再定向关闭；用户原有窗口、交付成果页、未保存内容及归属不明的窗口保留，不使用全局关闭或退出应用来清理。'],
    parameters: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: '组合键，如 cmd+a、enter、shift+tab' },
        target: targetSchema(),
        view: { type: 'boolean', description: 'true＝附操作后截图（目标窗口）；默认 false（不截图）' },
      },
      required: ['combo', 'target'],
    },
    async execute(_id, params, signal, onUpdate) {
      checkAborted(signal);
      const target = params?.target;
      if (!target || !Number.isFinite(Number(target.pid)) || !target.windowId) {
        return notExecuted(missingTarget(), signal);
      }
      let result;
      try {
        result = await cua.key({
          combo: params.combo, pid: Number(target.pid), windowId: String(target.windowId), signal,
        });
      } catch (error) {
        return notExecuted(error.message, signal);
      }
      const { actionState, note } = describeToolResult(result);
      const executed = actionState === 'executed';
      const prefix = `已按 ${params.combo}${note ? `，${note}` : ''}`;
      onUpdate?.({ content: [{ type: 'text', text: prefix }], details: { actionState } });
      if (params.view !== true) return finishWithoutScreenshot(prefix, executed);
      return finishWithScreenshot(prefix, executed, target, signal);
    },
  });

  pi.registerTool({
    name: 'ui_scroll',
    label: '滚动',
    description: '滚动目标窗口。deltaY 正数向上、负数向下（约每单位一行）；x/y 可选（该窗口截图像素坐标），缺省在窗口左上区域滚动。必须带 ui_list 返回的 target。后台滚动不可用时自动改前台执行一次（结果里会说明）。',
    promptSnippet: 'ui_scroll：滚动目标窗口',
    promptGuidelines: ['ui_scroll 必须带目标窗口 target（pid/windowId）；deltaY 正数向上、负数向下；x/y 可选（截图像素坐标）。'],
    parameters: {
      type: 'object',
      properties: {
        deltaY: { type: 'number', description: '正=向上，负=向下' },
        x: { type: 'number', description: '截图像素 X（可选）' },
        y: { type: 'number', description: '截图像素 Y（可选）' },
        target: targetSchema(),
        view: { type: 'boolean', description: 'true＝附操作后截图（目标窗口）；默认 false（不截图）' },
      },
      required: ['deltaY', 'target'],
    },
    async execute(_id, params, signal, onUpdate) {
      checkAborted(signal);
      const target = params?.target;
      if (!target || !Number.isFinite(Number(target.pid)) || !target.windowId) {
        return notExecuted(missingTarget(), signal);
      }
      let result;
      try {
        result = await cua.scroll({
          deltaY: params.deltaY,
          x: Number.isFinite(Number(params.x)) ? Number(params.x) : undefined,
          y: Number.isFinite(Number(params.y)) ? Number(params.y) : undefined,
          pid: Number(target.pid), windowId: String(target.windowId), signal,
        });
      } catch (error) {
        return notExecuted(error.message, signal);
      }
      const escalated = Boolean(result?.hemiEscalatedForeground);
      const { actionState, note } = describeToolResult(result);
      const executed = actionState === 'executed';
      const prefix = `已滚动 deltaY=${Number(params.deltaY)}${escalated ? '（后台不可用，已改前台执行）' : ''}${note ? `，${note}` : ''}`;
      onUpdate?.({ content: [{ type: 'text', text: prefix }], details: { actionState } });
      if (params.view !== true) return finishWithoutScreenshot(prefix, executed);
      return finishWithScreenshot(prefix, executed, target, signal);
    },
  });

}
