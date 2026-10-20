/**
 * 022 全局长按 Option 的按键状态机（纯逻辑，不依赖 Electron，可单测）。
 *
 * 输入 uiohook-napi 的 keydown/keyup 键码流，输出 hold-start / hold-end /
 * hold-cancel 三个决策（与悬浮球长按同一条命令语义）。组合键安全规则见
 * requirements/022-global-push-to-talk/technical-plan/README.md：
 * 干净按下才触发、按住中出现其他键即作废、组合键尾巴不触发。
 */

/** uiohook 键码：56 = 左 Option（Alt），3640 = 右 Option（AltRight）。 */
export const OPTION_KEYCODES = new Set([56, 3640]);

/** 单次按住超过此时长视为 keyup 丢失（事件 tap 漏事件），兜底作废不提交。 */
const MAX_HOLD_MS = 120_000;

/** held 集合里的键超过此时长没有 keyup 视为泄漏，触发判定时清理。 */
const HELD_TTL_MS = 60_000;

export function isOptionKeycode(keycode) {
  return OPTION_KEYCODES.has(keycode);
}

/**
 * @param {object} handlers 决策回调：start() / end() / cancel()
 * @param {() => number} [now] 时间源（测试可注入）
 */
export function createOptionHoldDetector({ start, end, cancel, now = Date.now }) {
  /** keycode -> 本次按下的时间戳；漏 keyup 的条目靠 TTL 清理。 */
  const held = new Map();
  let holding = false;
  let holdingSince = 0;

  const pruneStale = () => {
    const cutoff = now() - HELD_TTL_MS;
    for (const [keycode, since] of held) {
      if (since < cutoff) held.delete(keycode);
    }
  };

  const abortHold = () => {
    holding = false;
    cancel();
  };

  return {
    isHolding: () => holding,
    keydown(keycode) {
      pruneStale();
      // 按住的兜底只能靠后续按键事件检查：tap 完全静默时无从得知。
      if (holding && now() - holdingSince > MAX_HOLD_MS) abortHold();
      if (held.has(keycode)) return;

      if (isOptionKeycode(keycode)) {
        held.set(keycode, now());
        // 已在按住中（重复 Option 事件）不重复触发。
        if (holding) return;
        // Option 以外的键还按着＝这是组合键的尾巴，不触发。
        let othersHeld = false;
        for (const key of held.keys()) {
          if (!isOptionKeycode(key)) {
            othersHeld = true;
            break;
          }
        }
        if (othersHeld) return;
        holding = true;
        holdingSince = now();
        start();
        return;
      }

      held.set(keycode, now());
      // 按住期间出现任何其他键（Option+Tab、Option+方向键…）＝组合键，
      // 整句作废不提交，回到 idle（Option 的 keyup 之后不再产生 end）。
      if (holding) abortHold();
    },
    keyup(keycode) {
      held.delete(keycode);
      if (!isOptionKeycode(keycode) || !holding) return;
      // 双 Option 同时按住时，松开其中一个不算结束。
      let optionStillHeld = false;
      for (const key of held.keys()) {
        if (isOptionKeycode(key)) {
          optionStillHeld = true;
          break;
        }
      }
      if (optionStillHeld) return;
      holding = false;
      end();
    },
  };
}
