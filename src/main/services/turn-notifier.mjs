/**
 * 任务完成通知（2026-10-21）：主回合真正收口、而用户不在界面前时，发一条系统通知。
 *
 * 承担两件事：判定「要不要打扰」和「短时间多条怎么合并」。Electron 的
 * Notification 由调用方注入（主进程装配真实横幅，单测记录调用），模块自身
 * 不依赖 electron，可在 node 测试里直接跑。
 *
 * 口径与未读标记一致：只有 completed／partial／failed 的 user／queue／event 回合
 * 才通知（见 shared/conversation-status.mjs 的 newSettledRuns）；停止、中断、
 * 恢复的旧档都不打扰。
 */

/** 同一批收口（队列连续派发、并行子任务）合并成一条，避免通知刷屏。 */
export const NOTIFY_MERGE_MS = 300;
const PREVIEW_LIMIT = 80;
const TITLE_LIMIT = 60;

const OUTCOME_LABEL = {
  completed: '任务已完成',
  partial: '任务部分完成',
  failed: '任务未完成',
  blocked: '任务受阻',
  'awaiting-user':'等待你的回复',
  'awaiting-background':'任务已转入后台',
};

/**
 * 主窗口可见、未最小化且聚焦＝用户正看着，不打扰；隐藏、最小化、在别的应用上都算后台。
 */
export function shouldNotifyForCompletion({ enabled = true, visible = false, minimized = false, focused = false } = {}) {
  if (!enabled) return false;
  return !(visible && !minimized && focused);
}

function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

/** 通知标题：会话标题优先（截断），没有就品牌名——macOS 横幅本身已带应用名。 */
export function completionTitle({ conversationTitle, brandName = 'Hemi' } = {}) {
  return truncate(conversationTitle, TITLE_LIMIT) || brandName;
}

/** 通知正文：结果口径＋这次任务的输入摘要；多条合并时只报条数。 */
export function completionBody({ outcome, preview, count = 1 } = {}) {
  if (count > 1) return `${count} 个任务已结束`;
  const label = OUTCOME_LABEL[outcome] ?? '任务已结束';
  const text = truncate(preview, PREVIEW_LIMIT);
  return text ? `${label}：${text}` : label;
}

function windowState(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    return { visible: false, minimized: false, focused: false };
  }
  return {
    visible: Boolean(win.isVisible?.()),
    minimized: Boolean(win.isMinimized?.()),
    focused: Boolean(win.isFocused?.()),
  };
}

/**
 * @param {object} options
 * @param {() => object|null} [options.getWindow] 取主窗口（每次判定时调用，窗口会重建）
 * @param {() => void} [options.showWindow] 点击通知后回到应用
 * @param {(payload: { title: string, body: string, onClick: () => void }) => void} [options.showNotification]
 * @param {boolean} [options.enabled] 冒烟/自驱动实例关掉（自动化不该弹真实横幅）
 * @param {string} [options.brandName]
 * @param {number} [options.mergeMs]
 * @param {object|null} [options.log]
 */
export function createTurnNotifier({
  getWindow = () => null,
  showWindow = null,
  showNotification = null,
  enabled = true,
  brandName = 'Hemi',
  mergeMs = NOTIFY_MERGE_MS,
  log = null,
} = {}) {
  let timer = null;
  let batch = [];
  let disposed = false;

  function focusApp() {
    try { showWindow?.(); }
    catch (error) { log?.warn?.(`任务完成通知聚焦窗口失败：${error?.message ?? error}`); }
  }

  function flush() {
    timer = null;
    const items = batch;
    batch = [];
    if (!items.length || disposed) return;
    if (!shouldNotifyForCompletion({ enabled, ...windowState(getWindow()) })) return;
    const latest = items[items.length - 1];
    const title = completionTitle({ conversationTitle: latest.conversationTitle, brandName });
    const body = completionBody({ outcome: latest.outcome, preview: latest.preview, count: items.length });
    if (typeof showNotification !== 'function') {
      log?.warn?.('任务完成通知未接线，跳过系统横幅');
      return;
    }
    try { showNotification({ title, body, onClick: focusApp }); }
    catch (error) { log?.warn?.(`任务完成通知发送失败：${error?.message ?? error}`); }
  }

  return {
    /**
     * 受理一条完成事实（不立即弹窗，mergeMs 内合并）。是否真的打扰在落定时再判一次：
     * 用户在这几百毫秒里切回前台就不再弹。
     * @param {{ conversationId?: string, conversationTitle?: string|null, outcome?: string|null, preview?: string|null }} info
     */
    notifyCompletion(info) {
      if (!info || disposed || !enabled) return false;
      batch.push(info);
      if (!timer) {
        timer = setTimeout(flush, mergeMs);
        timer.unref?.();
      }
      return true;
    },
    /** 测试/退出用：立刻落定待发批次（正常路径只由计时器触发）。 */
    flush,
    dispose() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      batch = [];
    },
  };
}
