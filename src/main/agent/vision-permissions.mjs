// 006 R-02：macOS 系统权限检测（屏幕录制 / 辅助功能）。
//
// 检测走「与生产同一调用链」——spawn osascript 由本进程发起，TCC 归属跟父
// 进程（实验 1 结论），测到的就是 Hemi 自己的授权状态：
//  - 辅助功能：System Events 数进程（能枚举＝已授权；报 assistive access＝未授权）。
//  - 屏幕录制：CGDisplayCreateImage 未授权时返回 NULL（标准探测；不用
//    CGWindowList——其 CFArray 桥接在 JXA 下实测段错误，见 2026-09-19 实验记录）。
// 返回 null＝探测本身失败（不误报，UI 显示「未知」）。
import { spawnSync } from 'node:child_process';

function run(command, args, timeoutMs = 8000) {
  const result = spawnSync(command, args, { timeout: timeoutMs, encoding: 'utf8' });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 辅助功能（操控/AX 读取的前提）。 */
export function detectAccessibility() {
  // Windows 无 macOS TCC；真实桌面状态由平台 cua 探针与每次动作核验。
  if (process.platform !== 'darwin') return null;
  const out = run('osascript', ['-e', 'tell application "System Events" to count of application processes']);
  if (out.ok) return true;
  if (/assistive access|辅助功能/i.test(out.stderr)) return false;
  return null;
}

/** 屏幕录制（截屏的前提）。 */
export function detectScreenRecording() {
  if (process.platform !== 'darwin') return null;
  const out = run('osascript', [
    '-l', 'JavaScript',
    '-e',
    'ObjC.import("CoreGraphics"); const img = $.CGDisplayCreateImage($.CGMainDisplayID()); img ? "granted" : "denied";',
  ]);
  if (!out.ok) return null;
  const text = out.stdout.trim();
  if (text === 'granted') return true;
  if (text === 'denied') return false;
  return null;
}

/** 两项一起测（设置页展示用）。 */
export function detectVisionPermissions() {
  return {
    screenRecording: detectScreenRecording(),
    accessibility: detectAccessibility(),
  };
}

const PANES = {
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

/** 打开系统设置对应的授权面板（R-02 引导）。 */
export function openPermissionPane(kind) {
  const pane = PANES[kind];
  if (!pane) return false;
  return run('open', [pane]).ok;
}
