/**
 * 原生键盘口径——把 Chromium 的网页键盘行为收成桌面应用的样子（无第三方包）。
 * 各窗口入口（main.tsx / fixtures-main.tsx）模块加载时调用一次；主进程侧
 * （菜单去重载/DevTools/缩放、拦页内导航、读系统键盘导航开关）在
 * main/windows/native-shell.mjs。
 *
 * 1. 输入模态（WICG focus-visible polyfill 口径的等价实现）：Tab / 方向键 →
 *    html 加 .kb-nav（native.css 放行 :focus-visible 环）；任何指针按下 → 移除。
 *    原生 :focus-visible 启发式有「键盘模态粘滞」：键盘活动过后，点击按钮、
 *    弹窗关闭时程序化 focus() 还原触发按钮都会亮环且不再熄灭，语音应用键盘
 *    输入常态化（作曲家 Enter 发送），天天踩中。文本输入里的方向键是移动光标
 *    不是巡航焦点，不切键盘模态。
 * 2. Tab 跟随系统「键盘导航」开关：mac 默认关——Tab 只在文本输入与列表间切换，
 *    按住 Option 才走遍所有控件；开着（或 Windows）走浏览器默认的全控件巡航。
 *    在冒泡阶段处理：组件自己吃掉的 Tab（作曲家 @ 提及选中、菜单收起）已
 *    preventDefault，这里跳过；有打开的模态框时只在框内切换。
 * 3. 点过的控件不吃 Enter/空格：Chromium 点击按钮会把焦点给它，之后 Enter/空格
 *    会再触发一次（空格还会翻滚动区）。macOS 原生按钮点击不拿焦点，键盘激活
 *    只属于键盘巡航——所以非 .kb-nav 时、焦点不在文本输入里，截掉二者的默认
 *    动作。只 preventDefault 不拦传播：组件自己的 Enter 处理（都挂在文本输入上）
 *    与窗口级快捷键照常收到。
 * 4. ⌘A / Ctrl+A 不全选界面：焦点不在文本输入里时截掉（菜单的「全选」加速键
 *    也随之不触发——渲染层未处理的按键才会转给应用菜单）。
 */

/** 方向键算「焦点巡航」（Tab 另行处理）；Enter/空格/Esc 是激活与关闭，不算。 */
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** 不承载文字编辑的 input 类型（其余类型都按文本输入对待）。 */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** 键盘导航关着时 Tab 仍可达的列表类控件（mac 原生列表/表格在 Tab 环里）。 */
const LIST_ROLES = new Set(['listbox', 'grid', 'tree']);

const TABBABLE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

export function isTextEditing(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  return (
    target.tagName === 'INPUT' &&
    !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)
  );
}

export type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'
>;

/**
 * 捕获阶段的原生口径判定：'nav' 进入键盘巡航模态；'suppress' 截掉默认动作；
 * null 放行。Tab 不在此判定（冒泡阶段 tabScope）。纯函数，node --test 直接覆盖。
 */
export function classifyKeydown(
  event: KeyLike,
  context: { textEditing: boolean; kbNav: boolean },
): 'nav' | 'suppress' | null {
  if (context.textEditing || event.isComposing) return null;
  if (ARROW_KEYS.has(event.key)) return 'nav';

  const command = event.metaKey || event.ctrlKey;
  if (command && !event.altKey && event.key.toLowerCase() === 'a') return 'suppress';

  const activation = event.key === 'Enter' || event.key === ' ';
  if (activation && !command && !event.altKey && !context.kbNav) return 'suppress';

  return null;
}

/**
 * Tab 的巡航范围：'browser' 交浏览器默认（全控件）；'all' 自行巡航全部控件
 * （键盘导航关着时按住 Option）；'text' 只在文本输入与列表间切换；null 不管
 * （非 Tab、组件已处理、带 ⌘/Ctrl、输入法组字中）。纯函数。
 */
export function tabScope(
  event: KeyLike & { defaultPrevented: boolean },
  fullKeyboardAccess: boolean,
): 'browser' | 'all' | 'text' | null {
  if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey) return null;
  if (fullKeyboardAccess) return 'browser';
  return event.altKey ? 'all' : 'text';
}

/** 在候选序列里按方向取下一个（循环）；当前不在序列里时从头/尾进入。纯函数。 */
export function nextIndex(length: number, current: number, direction: 1 | -1): number {
  if (length === 0) return -1;
  if (current < 0) return direction > 0 ? 0 : length - 1;
  return (current + direction + length) % length;
}

/** 真正可见：排除 display:none 祖先与 visibility:hidden（如收起的侧栏抽屉仍占布局）。 */
function isRendered(element: HTMLElement): boolean {
  return element.checkVisibility({ visibilityProperty: true });
}

function isTabbable(element: HTMLElement, scope: 'all' | 'text'): boolean {
  if (element.tabIndex < 0 || (element as HTMLButtonElement).disabled) return false;
  if (element.closest('[inert]') || !isRendered(element)) return false;
  if (scope === 'all') return true;
  return isTextEditing(element) || LIST_ROLES.has(element.getAttribute('role') ?? '');
}

/** 有打开的模态框时只在最上层（文档序最后）那个里巡航，与各弹窗的焦点圈套一致。 */
function tabRoot(): ParentNode {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
  ).filter(isRendered);
  return modals.at(-1) ?? document;
}

function moveFocus(scope: 'all' | 'text', direction: 1 | -1): void {
  const candidates = Array.from(
    tabRoot().querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter((element) => isTabbable(element, scope));
  const current = candidates.indexOf(document.activeElement as HTMLElement);
  const target = candidates[nextIndex(candidates.length, current, direction)];
  if (!target || target === document.activeElement) return;
  target.focus();
  if (target instanceof HTMLInputElement && isTextEditing(target)) target.select();
}

let installed = false;
/** 系统设置回报的键盘导航开关；未回报前按平台默认（mac 关、Windows 开）。 */
let reportedFullKeyboardAccess: boolean | null = null;

function isMac(): boolean {
  // fixtures 等无桥环境按 UA 推断；真实窗口 preload 先于页面脚本注入桥。
  const platform = window.hemiVoice?.platform;
  return platform ? platform === 'darwin' : navigator.userAgent.includes('Mac');
}

function fullKeyboardAccess(): boolean {
  return reportedFullKeyboardAccess ?? !isMac();
}

/** 窗口每次获得焦点重读（用户可能刚在系统设置里改过）。 */
function refreshKeyboardNavigation(): void {
  void window.hemiVoice
    ?.getKeyboardNavigation?.()
    .then((state) => {
      reportedFullKeyboardAccess = state.fullKeyboardAccess;
    })
    .catch(() => {});
}

export function installNativeInput(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const root = document.documentElement;

  refreshKeyboardNavigation();
  window.addEventListener('focus', refreshKeyboardNavigation);

  window.addEventListener(
    'keydown',
    (event) => {
      const verdict = classifyKeydown(event, {
        textEditing: isTextEditing(event.target),
        kbNav: root.classList.contains('kb-nav'),
      });
      if (verdict === 'nav') root.classList.add('kb-nav');
      else if (verdict === 'suppress') event.preventDefault();
    },
    true,
  );

  // 冒泡阶段：React 的组件处理（挂在根容器上）先跑完，吃掉的 Tab 已 preventDefault。
  window.addEventListener('keydown', (event) => {
    const scope = tabScope(event, fullKeyboardAccess());
    if (!scope) return;
    root.classList.add('kb-nav');
    if (scope === 'browser') return;
    event.preventDefault();
    moveFocus(scope, event.shiftKey ? -1 : 1);
  });

  window.addEventListener(
    'pointerdown',
    () => {
      root.classList.remove('kb-nav');
    },
    true,
  );
}
