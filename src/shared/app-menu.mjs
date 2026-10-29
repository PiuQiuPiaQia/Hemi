/** Windows titlebar entries; Electron owns native submenu behavior and edit roles. */
export const APP_MENU_GROUPS = [
  { id: 'file', label: '文件', accessKey: 'f', items: [
    { command: 'new-conversation', label: '新建对话', accelerator: 'Ctrl+N' },
    { command: 'open-workspace', label: '打开工作区文件夹…' },
    { type: 'separator' },
    { command: 'settings', label: '设置…' },
    { type: 'separator' },
    { role: 'close', label: '关闭窗口' },
    { role: 'quit', label: '退出 Hemi' },
  ] },
  { id: 'edit', label: '编辑', accessKey: 'e', items: [
    { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
    { type: 'separator' },
    { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
    { type: 'separator' }, { role: 'selectAll', label: '全选' },
  ] },
  { id: 'view', label: '视图', accessKey: 'v', items: [
    { command: 'home', label: '对话' }, { command: 'bot', label: 'Bot' },
    { type: 'separator' },
    { command: 'skills', label: '技能中心' }, { command: 'workflows', label: '工作流' },
    { command: 'usage', label: '使用记录' },
  ] },
  { id: 'help', label: '帮助', accessKey: 'h', items: [
    { command: 'logs', label: '查看日志文件' },
    { type: 'separator' }, { role: 'about', label: '关于 Hemi' },
  ] },
];
