/**
 * 043 · 长按键白名单（纯逻辑）。键的启用门槛＝对应平台真机探针（WP-04）
 * 通过后由本清单放开；未验证的键一律拒绝，不允许配置进死状态。
 * 显示标签在 renderer 的 platform-format.ts（运行时优先用快照
 * shortcuts.pushToTalk.label，本文件不承担 UI 文案）。
 */

export const PUSH_TO_TALK_ALLOWED_KEYS = {
  darwin: ['option'],
  win32: [], // WP-04 未过：无可用键（右 Alt 候选待 AltGr/IME 冲突实测）
};

export function isAllowedPushToTalkKey(platform, key) {
  const allowed = PUSH_TO_TALK_ALLOWED_KEYS[platform] ?? [];
  return allowed.includes(String(key));
}
