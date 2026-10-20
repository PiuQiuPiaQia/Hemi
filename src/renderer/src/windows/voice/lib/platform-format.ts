/**
 * 043 B2a · 平台展示格式化（纯函数，node --test 直接覆盖）。
 * 只做展示：不生成授权资源键，也不替代主进程路径校验（contracts §快捷键与路径）。
 */

export type Platform = 'darwin' | 'win32';

/** 新建对话快捷键：mac ⌘N，Windows Ctrl+N（键盘处理继续 metaKey||ctrlKey 既有语义）。 */
export function newConversationShortcut(platform: string): {
  label: string;
  ariaKeyshortcuts: string;
} {
  return platform === 'win32'
    ? { label: 'Ctrl+N', ariaKeyshortcuts: 'Control+N' }
    : { label: '⌘N', ariaKeyshortcuts: 'Meta+N' };
}

/** 系统文件管理器名称：mac 访达，Windows 资源管理器（R-17 文案平台化）。 */
export function fileManagerName(platform: string): string {
  return platform === 'win32' ? '资源管理器' : '访达';
}

/**
 * 展示用路径整理：识别 / 与 \、盘符根和 UNC；保持原始大小写，不全局转小写。
 * home 缩写只按平台分隔符匹配自身路径风格。
 */
export function displayPath(
  inputPath: string,
  options: { platform?: string; home?: string } = {},
): string {
  const raw = String(inputPath ?? '').trim();
  if (!raw) return '';
  const home = options.home ?? '';
  let out = raw;
  if (home) {
    if (options.platform === 'win32') {
      const homeNorm = home.replace(/[\\/]+$/, '');
      const lower = out.toLowerCase();
      const homeLower = homeNorm.toLowerCase();
      // 前缀必须带分隔符边界：C:\Users\Zhang2 不能缩写成 ~2。
      if (
        homeLower &&
        (lower === homeLower ||
          lower.startsWith(`${homeLower}\\`) ||
          lower.startsWith(`${homeLower}/`))
      ) {
        const rest = out.slice(homeNorm.length).replace(/^[\\/]+/, '');
        out = rest ? `~\\${rest}` : '~';
      }
    } else if (out === home || out.startsWith(`${home}/`)) {
      out = out === home ? '~' : `~${out.slice(home.length)}`;
    }
  }
  // 尾部分隔符只在展示层收敛（保留根的语义：C:\ 和 \\srv\share 不变空）。
  if (out.length > 1) out = out.replace(/[\\/]+$/, '') || out;
  return out;
}

/** 展示用基名：兼容两种分隔符；盘符根/UNC 共享根返回自身。 */
export function platformBasename(inputPath: string): string {
  const raw = String(inputPath ?? '').trim();
  if (!raw) return '';
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) return raw; // 纯分隔符（如 "/"）
  if (/^[a-zA-Z]:$/.test(trimmed)) return trimmed; // 盘符根 C:\
  // UNC 共享根（\\server\share）本身就是「基名」层，不再往下拆。
  if (/^\\\\[^\\]+\\[^\\]+$/.test(trimmed)) return trimmed;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

/**
 * 长按键显示标签（快照 shortcuts.pushToTalk 没给出时的本地回退）。
 * 白名单与键的启用门槛在 src/main/platform/hold-keys.mjs——两边是
 * 「展示」与「校验」分工，标签文案与键名约定保持一致。
 */
export function holdKeyLabel(key: string | null | undefined, platform: string): string {
  switch (key) {
    case 'option':
      return 'Option';
    case 'right-alt':
      return '右 Alt';
    case 'f8':
      return 'F8';
    case 'f9':
      return 'F9';
    default:
      // 空值/未定案：按平台给默认叫法（仅展示用，不代表可用）。
      return platform === 'win32' ? '长按键' : 'Option';
  }
}
