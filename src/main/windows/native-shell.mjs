/**
 * 原生壳——把 Electron 默认的「浏览器」行为收成桌面应用口径，所有窗口共用。
 *
 * - 应用菜单：不设菜单时 Electron 挂默认菜单，安装包里 ⌘R 重载页面、⌥⌘I 开
 *   DevTools、⌘+/- 缩放整页。这里只保留应用/编辑/窗口三组（编辑组保证输入框
 *   里拷贝粘贴撤销可用）；重载、DevTools、缩放只在开发实例出现。非 mac 的
 *   安装包不挂菜单（Windows 菜单挂在窗口上会多出一条菜单栏）。
 * - 页内导航：拖文件进窗口、点普通 <a href> 都会把整窗导航走（file:// 预览
 *   或外站），一律拦下；https 链接按外链白名单交给系统浏览器，与
 *   setWindowOpenHandler 同口径。
 * - 键盘导航开关：readFullKeyboardAccess 读系统设置，经 IPC 交渲染层决定 Tab 口径。
 *
 * 渲染层的对应部分（Tab 口径、Enter/空格不激活鼠标点过的按钮、⌘A 不全选界面）在
 * renderer/src/lib/native-input.ts。electron 依赖由调用方注入，便于单测。
 */

/**
 * @param {{ platform: string, appName: string, devTools: boolean }} options
 * @returns {object[] | null} 菜单模板；null＝不挂菜单
 */
export function buildAppMenuTemplate({ platform, appName, devTools }) {
  const isMac = platform === 'darwin';
  if (!isMac && !devTools) return null;

  const template = [];
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}` },
      ],
    });
  }
  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '拷贝' },
      { role: 'paste', label: '粘贴' },
      // ⌘A 在文本输入之外由渲染层截住（native-input.ts），这里只服务输入框。
      { role: 'selectAll', label: '全选' },
    ],
  });
  if (devTools) {
    template.push({
      label: '开发',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    });
  }
  template.push({
    label: '窗口',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      { type: 'separator' },
      { role: 'close', label: '关闭窗口' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] : []),
    ],
  });
  return template;
}

/**
 * 047：导航策略注册表——默认「全拦」不变；导入浏览器这类受控 webContents
 * 先登记决策函数（返回 true＝允许本次导航）。决策在 guardNavigation 的
 * will-navigate 里同步调用，不追加第二个监听器去覆盖已执行的 preventDefault。
 */
const navigationPolicies = new Map();

export function setNavigationPolicy(contentsId, decide) {
  if (typeof decide === 'function') navigationPolicies.set(contentsId, decide);
  else navigationPolicies.delete(contentsId);
}

export function clearNavigationPolicy(contentsId) {
  navigationPolicies.delete(contentsId);
}

/**
 * 页内导航守卫：窗口内容只经 loadURL/loadFile 进来（不触发 will-navigate），
 * 任何页内导航都不是应用本意——除非该 contents 登记了允许策略（047 导入浏览器）。
 */
export function guardNavigation(contents, { openExternal }) {
  contents.on('will-navigate', (event, url) => {
    const decide = navigationPolicies.get(contents.id);
    if (typeof decide === 'function' && decide(url) === true) return;
    event.preventDefault();
    if (typeof url === 'string' && url.startsWith('https:')) void openExternal(url);
  });
}

/**
 * 系统「键盘导航」开关：mac 的 AppleKeyboardUIMode 第 2 位（系统设置 → 键盘 →
 * 键盘导航；未设置＝关）。关着时 Tab 只在文本输入与列表间切换，这是 mac 默认。
 * Windows 原生对话框 Tab 本就走遍所有控件，恒为 true。
 */
export function readFullKeyboardAccess({ platform, systemPreferences }) {
  if (platform !== 'darwin') return true;
  try {
    const mode = systemPreferences.getUserDefault('AppleKeyboardUIMode', 'integer');
    return (Number(mode) & 2) !== 0;
  } catch {
    return false;
  }
}

/**
 * whenReady 后、建任何窗口前调用一次。
 * @param {{ app: any, Menu: any, platform: string, appName: string, devTools: boolean, openExternal: (url: string) => Promise<unknown> }} deps
 */
export function installNativeShell({ app, Menu, platform, appName, devTools, openExternal }) {
  const template = buildAppMenuTemplate({ platform, appName, devTools });
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
  app.on('web-contents-created', (_event, contents) => {
    guardNavigation(contents, { openExternal });
  });
}
