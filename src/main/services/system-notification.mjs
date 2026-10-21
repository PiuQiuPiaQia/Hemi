/**
 * macOS 开发态通知兜底（2026-10-21）：未打包的 Electron 实例没有通知权限
 * （实测 Notification 直接 failed：UNErrorDomain 错误 1＝notificationsNotAllowed，
 * 系统通知列表里也看不到 Electron），开发时验证「任务完成提醒」会一无所获。
 *
 * 这里用 osascript 的 display notification 发一条系统通知：系统允许 AppleScript
 * 发起通知（署名「脚本编辑器」），点击不会回到 Hemi、只作开发期兜底。
 * 打包实例走 Electron Notification 真横幅，不经过这里。
 */
import { execFile } from 'node:child_process';

const MAX_TITLE = 60;
const MAX_BODY = 200;

function clean(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * @param {{ title?: string, body?: string, log?: object|null, run?: typeof execFile }} options
 *   run 仅供测试注入（避免真的弹通知）。
 */
export function notifyViaAppleScript({ title, body, log = null, run = execFile } = {}) {
  const safeTitle = clean(title, MAX_TITLE) || 'Hemi';
  const safeBody = clean(body, MAX_BODY);
  // 文本走 argv 传给 AppleScript 的 run handler：用户输入里的引号/反斜杠不会拼进脚本。
  const script = [
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    'end run',
  ];
  const args = [...script.flatMap(line => ['-e', line]), safeTitle, safeBody];
  return new Promise(resolve => {
    run('osascript', args, { timeout: 5000 }, error => {
      if (error) {
        log?.warn?.(`开发态兜底通知失败：${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}
