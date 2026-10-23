const { contextBridge, ipcRenderer, webUtils } = require('electron');

let appearanceBootstrap = null;
const appearanceListeners = new Set();
const appearanceActivityListeners = new Set();
ipcRenderer.on('appearance:changed', (_event, snapshot) => {
  if (appearanceBootstrap) appearanceBootstrap = { ...appearanceBootstrap, snapshot };
  for (const listener of appearanceListeners) listener(snapshot);
});
ipcRenderer.on('appearance:activity', (_event, activity) => {
  if (appearanceBootstrap) appearanceBootstrap = { ...appearanceBootstrap, activity };
  for (const listener of appearanceActivityListeners) listener(activity);
});
try { appearanceBootstrap = ipcRenderer.sendSync('appearance:bootstrap'); } catch {}

async function botInvoke(channel, payload) { const value = await ipcRenderer.invoke(channel, payload); if (!value.ok) { const error = new Error(value.message); error.code = value.code; throw error; } return value.result; }

contextBridge.exposeInMainWorld('hemiVoice', {
  bot: {
    getState: () => botInvoke('bot:state'),
    connect: (payload) => botInvoke('bot:connect', payload),
    initialize: (payload) => botInvoke('bot:initialize', payload),
    models: () => botInvoke('bot:models'),
    directory: (candidateId, path) => botInvoke('bot:directory', { candidateId, path }),
    command: (method, params) => botInvoke('bot:command', { method, params }),
    upload: (payload) => botInvoke('bot:upload', payload),
    download: (id, artifactId) => botInvoke('bot:download', { id, artifactId }),
    environment: (environment) => botInvoke('bot:environment', { environment }),
    onChanged: (callback) => { const fn = (_event, value) => callback(value); ipcRenderer.on('bot:changed', fn); return () => ipcRenderer.removeListener('bot:changed', fn); },
  },

  getAppearanceBootstrap: () => appearanceBootstrap,
  getAppearance: () => ipcRenderer.invoke('appearance:get'),
  setAppearance: (request) => ipcRenderer.invoke('appearance:set', request),
  onAppearanceChanged: (callback) => { appearanceListeners.add(callback); return () => appearanceListeners.delete(callback); },
  onAppearanceActivity: (callback) => { appearanceActivityListeners.add(callback); return () => appearanceActivityListeners.delete(callback); },
  reportAppearanceApplied: (value) => ipcRenderer.send('appearance:applied', value),
  reportAppearanceVisualReady: (value) => ipcRenderer.send('appearance:visual-ready', value),
  platform: process.platform,
  getSkillState: () => ipcRenderer.invoke('skills:state'),
  refreshSkillCatalog: () => ipcRenderer.invoke('skills:refresh'),
  importLocalSkill: () => ipcRenderer.invoke('skills:import-local'),
  installMarketSkill: (id) => ipcRenderer.invoke('skills:install', { id }),
  setSkillEnabled: (id, enabled) => ipcRenderer.invoke('skills:set-enabled', { id, enabled }),
  removeSkill: (id) => ipcRenderer.invoke('skills:remove', { id }),
  readSkill: (id) => ipcRenderer.invoke('skills:read', { id }),
  revealSkill: (id) => ipcRenderer.invoke('skills:reveal', { id }),
  // 034 SkillsMP：默认市场只读搜索 + 固定提交预览/确认安装 + 手动检查更新。
  searchSkillsMp: (payload) => ipcRenderer.invoke('skills:mp-search', payload ?? {}),
  previewSkillsMp: (id) => ipcRenderer.invoke('skills:mp-preview', { id }),
  installSkillsMp: (payload) => ipcRenderer.invoke('skills:mp-install', payload ?? {}),
  checkSkillsMpUpdate: (id) => ipcRenderer.invoke('skills:mp-check-update', { id }),
  // 028：拖入文件的受控路径（沙箱渲染层拿不到 File.path，webUtils 是官方通路）。
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  openLink: (url) => ipcRenderer.invoke('system:open-link', url),
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text),
  getKeyboardNavigation: () => ipcRenderer.invoke('system:keyboard-navigation'),
  getConfig: () => ipcRenderer.invoke('asr:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('asr:save-config', config),
  requestMicrophonePermission: () => ipcRenderer.invoke('permissions:microphone'),
  getMicrophonePermissionStatus: () =>
    ipcRenderer.invoke('permissions:microphone-status'),
  openMicrophoneSettings: () =>
    ipcRenderer.invoke('permissions:open-mic-settings'),
  // 043 平台能力快照：先订阅再取初始快照（按 {sessionId, revision} 去重）。
  platformGetState: () => ipcRenderer.invoke('platform:get-state'),
  platformRecheck: (capability) => ipcRenderer.invoke('platform:recheck', { capability }),
  platformPerformAction: (capability, action) =>
    ipcRenderer.invoke('platform:perform-action', { capability, action }),
  onPlatformStateChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('platform:state-changed', listener);
    return () => ipcRenderer.removeListener('platform:state-changed', listener);
  },
  startAsr: (mode) => ipcRenderer.invoke('asr:start', mode),
  sendAudio: (audio) => ipcRenderer.send('asr:audio', audio),
  stopAsr: () => ipcRenderer.invoke('asr:stop'),
  // 032 冷启动引导：快照 / 前进 / 完成（主进程权威，错误回执不带 Key）。
  getOnboardingState: () => ipcRenderer.invoke('onboarding:get-state'),
  advanceOnboarding: (payload) => ipcRenderer.invoke('onboarding:advance', payload),
  completeOnboarding: () => ipcRenderer.invoke('onboarding:complete'),
  getTextModelConfig: () => ipcRenderer.invoke('llm:get-config'),
  saveTextModelConfig: (config) => ipcRenderer.invoke('llm:save-config', config),
  // 031 多组模型配置：目录 CRUD／默认组／逐组测试。
  listModelProfiles: () => ipcRenderer.invoke('llm:list-model-profiles'),
  startOAuthLogin: (provider) => ipcRenderer.invoke('oauth:start', { provider }),
  getOAuthLoginState: () => ipcRenderer.invoke('oauth:get-state'),
  answerOAuthLogin: (payload) => ipcRenderer.invoke('oauth:answer', payload),
  cancelOAuthLogin: (id) => ipcRenderer.invoke('oauth:cancel', { id }),
  logoutOAuth: (provider) => ipcRenderer.invoke('oauth:logout', { provider }),
  saveModelProfile: (profile) => ipcRenderer.invoke('llm:save-model-profile', profile),
  removeModelProfile: (payload) => ipcRenderer.invoke('llm:remove-model-profile', payload),
  // 041 修复：主进程读 payload.modelKey——此前发 { profileId} 自 033 起永远 undefined，
  // 设默认三条入口（主脑模型下拉/设为主脑模型/首添加自动设默认）必抛「没有这个模型」。
  setDefaultModelProfile: (modelKey) => ipcRenderer.invoke('llm:set-default-model-profile', { modelKey }),
  // 2026-10-08：记上次主脑模型选择（模型键或 'auto'），新建对话优先恢复。
  setLastConversationModel: (modelKey) => ipcRenderer.invoke('llm:set-last-conversation-model', { modelKey }),
  setVisionModel: (modelKey) => ipcRenderer.invoke('llm:set-vision-model', { modelKey }),
  testModelProfile: (payload) => ipcRenderer.invoke('llm:test-model-profile', payload),
  // 041 拉取模型列表：payload = { providerId } 或 { baseUrl, apiKey? }。
  listRemoteModels: (payload) => ipcRenderer.invoke('llm:list-remote-models', payload),
  // 038 自动模型路由：角色逐项即时保存（patch＝{ chatModelKey|executionModelKey|fallbackModelKey: modelKey|null }）。
  getRoleModels: () => ipcRenderer.invoke('llm:get-role-models'),
  saveRoleModel: (patch) => ipcRenderer.invoke('llm:save-role-model', { patch }),
  // 033 思考强度快捷拨盘：只写档位、下一轮对话即生效；031 起可带 profileId 只改该组。
  setThinkingLevel: (level, profileId) =>
    ipcRenderer.invoke('llm:set-thinking-level', profileId ? { level, profileId } : level),
  testTextModel: (overrides) => ipcRenderer.invoke('llm:test-model', overrides),
  // 047 New API 站点登录导入：状态机在主进程，这里只有命令与安全状态订阅。
  startProviderImport: (payload) => ipcRenderer.invoke('provider-import:start', payload ?? {}),
  getProviderImportState: (operationId) =>
    ipcRenderer.invoke('provider-import:get-state', { operationId: operationId ?? null }),
  listPendingProviderImports: () => ipcRenderer.invoke('provider-import:list-pending'),
  resumePendingProviderImport: (operationId) =>
    ipcRenderer.invoke('provider-import:resume-pending', { operationId }),
  checkProviderImportLogin: (payload) => ipcRenderer.invoke('provider-import:check-login', payload ?? {}),
  setProviderImportSelection: (payload) => ipcRenderer.invoke('provider-import:set-selection', payload ?? {}),
  submitProviderImport: (payload) => ipcRenderer.invoke('provider-import:submit', payload ?? {}),
  retryProviderImport: (payload) => ipcRenderer.invoke('provider-import:retry', payload ?? {}),
  pauseProviderImport: (payload) => ipcRenderer.invoke('provider-import:pause', payload ?? {}),
  resumeProviderImport: (payload) => ipcRenderer.invoke('provider-import:resume', payload ?? {}),
  cancelProviderImport: (payload) => ipcRenderer.invoke('provider-import:cancel', payload ?? {}),
  setProviderImportViewport: (payload) => ipcRenderer.invoke('provider-import:set-viewport', payload ?? {}),
  onProviderImportState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('provider-import:state', listener);
    return () => ipcRenderer.removeListener('provider-import:state', listener);
  },
  submitChatTurn: (payload) => ipcRenderer.invoke('llm:submit', payload),
  chatTextModel: (payload) => ipcRenderer.invoke('llm:chat', payload),
  cancelTextModel: (target) => ipcRenderer.send('llm:cancel', target),
  getConversationTurn: (conversationId) => ipcRenderer.invoke('llm:get-turn-state', conversationId),
  onConversationTurn: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('llm:turn-state', listener);
    return () => ipcRenderer.removeListener('llm:turn-state', listener);
  },
  getTtsConfig: () => ipcRenderer.invoke('tts:get-config'),
  saveTtsConfig: (config) => ipcRenderer.invoke('tts:save-config', config),
  speakTts: (payload) => ipcRenderer.invoke('tts:speak', payload),
  cancelTts: (turnId) => ipcRenderer.send('tts:cancel', turnId),
  // 渲染层的排查日志经主进程落到 userData/hemi.log 与终端。
  logLine: (line) => ipcRenderer.send('app:log', String(line ?? '').slice(0, 400)),
  revealLogFile: () => ipcRenderer.invoke('app:reveal-log'),
  // 044 应用内更新：状态/检查/下载/安装 + 状态订阅。
  updaterGetState: () => ipcRenderer.invoke('updater:get-state'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  onUpdaterChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:changed', listener);
    return () => ipcRenderer.removeListener('updater:changed', listener);
  },
  getUiPreferences: () => ipcRenderer.invoke('ui:get-preferences'),
  setFloatingOrbEnabled: (enabled) =>
    ipcRenderer.invoke('ui:set-floating-orb-enabled', enabled),
  setPrimarySpeakerEnabled: (enabled) =>
    ipcRenderer.invoke('ui:set-primary-speaker-enabled', enabled),
  // 022：全局长按 Option 对话（macOS）；授权引导弹系统框。
  setGlobalPushToTalkEnabled: (enabled) =>
    ipcRenderer.invoke('ui:set-global-push-to-talk-enabled', enabled),
  // 043：长按键配置统一入口（enabled/key 可只给其一）。
  setPushToTalkConfig: (payload) =>
    ipcRenderer.invoke('ui:set-push-to-talk-config', payload ?? {}),
  requestAccessibilityTrust: () =>
    ipcRenderer.invoke('ui:request-accessibility-trust'),
  openInputMonitoringPane: () =>
    ipcRenderer.invoke('ui:open-input-monitoring-pane'),
  setMainWindowExpanded: (expanded) =>
    ipcRenderer.send('ui:set-main-expanded', expanded),
  hideMainWindow: () => ipcRenderer.send('ui:hide-main'),
  publishUiState: (state) => ipcRenderer.send('ui:publish-state', state),
  getUiState: () => ipcRenderer.invoke('ui:get-state'),
  getDevWindowActivity: () => ipcRenderer.invoke('ui:get-dev-window-activity'),
  onDevWindowActivity: (callback) => {
    const listener = (_event, activity) => callback(activity);
    ipcRenderer.on('ui:dev-window-activity', listener);
    return () => ipcRenderer.removeListener('ui:dev-window-activity', listener);
  },
  showMainWindow: () => ipcRenderer.send('floating:show-main'),
  floatingHoldStart: () => ipcRenderer.send('floating:hold-start'),
  floatingHoldEnd: () => ipcRenderer.send('floating:hold-end'),
  floatingHoldCancel: () => ipcRenderer.send('floating:hold-cancel'),
  floatingDragStart: (point) => ipcRenderer.send('floating:drag-start', point),
  floatingDragMove: (point) => ipcRenderer.send('floating:drag-move', point),
  floatingDragEnd: () => ipcRenderer.send('floating:drag-end'),
  floatingTaskHover: (hovered) =>
    ipcRenderer.send('floating:task-hover', Boolean(hovered)),
  getFloatingCaptionLayout: () =>
    ipcRenderer.invoke('floating:get-caption-layout'),
  onFloatingCaptionLayout: (callback) => {
    const listener = (_event, layout) => callback(layout);
    ipcRenderer.on('floating:caption-layout', listener);
    return () =>
      ipcRenderer.removeListener('floating:caption-layout', listener);
  },
  onFloatingDragDetected: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('floating:drag-detected', listener);
    return () => ipcRenderer.removeListener('floating:drag-detected', listener);
  },
  onFloatingVisibilityChanged: (callback) => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on('floating:visibility-changed', listener);
    return () =>
      ipcRenderer.removeListener('floating:visibility-changed', listener);
  },
  onAsrEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('asr:event', listener);
    return () => ipcRenderer.removeListener('asr:event', listener);
  },
  onLlmDelta: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('llm:delta', listener);
    return () => ipcRenderer.removeListener('llm:delta', listener);
  },
  onTtsAudio: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tts:audio', listener);
    return () => ipcRenderer.removeListener('tts:audio', listener);
  },
  onTtsState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tts:state', listener);
    return () => ipcRenderer.removeListener('tts:state', listener);
  },
  onUiState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ui:state', listener);
    return () => ipcRenderer.removeListener('ui:state', listener);
  },
  onFloatingOrbCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('floating:command', listener);
    return () => ipcRenderer.removeListener('floating:command', listener);
  },
  // 004 任务面：快照订阅 + 动作上抛 + 执行器安装。
  getTaskState: () => ipcRenderer.invoke('task:get-state'),
  taskAction: (action, payload) =>
    ipcRenderer.invoke('task:action', { action, ...payload }),
  onTaskState: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('task:state', listener);
    return () => ipcRenderer.removeListener('task:state', listener);
  },
  // 042 应用级授权（access-grants.json 事实源）。旧三档通道已退役。
  accessGetState: (taskId) => ipcRenderer.invoke('access:get-state', { taskId: taskId ?? null }),
  accessListApplications: () => ipcRenderer.invoke('access:list-applications'),
  accessAddApplication: (payload) => ipcRenderer.invoke('access:add-application', payload),
  accessSetUiEnabled: (payload) => ipcRenderer.invoke('access:set-ui-enabled', payload),
  accessRemoveGrant: (payload) => ipcRenderer.invoke('access:remove-grant', payload),
  accessRevokeResource: (payload) => ipcRenderer.invoke('access:revoke-resource', payload),
  accessRetrySave: () => ipcRenderer.invoke('access:retry-save'),
  onAccessChanged: (listener) => {
    const wrapped = (_e, payload) => listener(payload);
    ipcRenderer.on('access:changed', wrapped);
    return () => ipcRenderer.removeListener('access:changed', wrapped);
  },
  getComputerUse: () => ipcRenderer.invoke('executor:get-computer-use'),
  setComputerUse: (next) => ipcRenderer.invoke('executor:set-computer-use', next),
  getVisionPermissions: () => ipcRenderer.invoke('executor:get-vision-permissions'),
  openVisionPermissionPane: (kind) =>
    ipcRenderer.invoke('executor:open-permission-pane', kind),
  // 014 浏览器操控（扩展桥）：开关、桥运行态、扩展目录定位（安装引导用）。
  getBrowserControl: () => ipcRenderer.invoke('executor:get-browser-control'),
  setBrowserControl: (next) => ipcRenderer.invoke('executor:set-browser-control', next),
  getBrowserBridge: () => ipcRenderer.invoke('executor:get-browser-bridge'),
  exportBrowserExtension: () => ipcRenderer.invoke('executor:export-browser-extension'),
  // web 检索：开关与 key（key 只写不读，回执只带 hasApiKey）。
  getWebSearch: () => ipcRenderer.invoke('executor:get-web-search'),
  setWebSearch: (next) => ipcRenderer.invoke('executor:set-web-search', next),
  // 020 browser_act（Jev 步进）：开关与端点（key 只写不读）。
  getBrowserAct: () => ipcRenderer.invoke('executor:get-browser-act'),
  setBrowserAct: (next) => ipcRenderer.invoke('executor:set-browser-act', next),
  testBrowserAct: (overrides) => ipcRenderer.invoke('executor:test-browser-act', overrides),
  // 执行器终端命令代理开关（输入工具行快捷拨杆，默认关）。
  getShellProxy: () => ipcRenderer.invoke('executor:get-shell-proxy'),
  setShellProxy: (enabled) => ipcRenderer.invoke('executor:set-shell-proxy', enabled),
  // 008 当前工作上下文：来源条状态与附加/刷新/移除。
  getContextState: () => ipcRenderer.invoke('context:get-state'),
  attachContext: (kind) => ipcRenderer.invoke('context:attach', { kind }),
  refreshContext: (id) => ipcRenderer.invoke('context:refresh', { id }),
  removeContext: (id) => ipcRenderer.invoke('context:remove', { id }),
  getMemoryState: () => ipcRenderer.invoke('memory:get-state'),
  saveMemoryDocument: (payload) => ipcRenderer.invoke('memory:save-document', payload),
  openMemoryDirectory: () => ipcRenderer.invoke('memory:open-directory'),
  // 032：记忆运行状态与收尾摘要开关。
  getMemoryStatus: () => ipcRenderer.invoke('memory:get-status'),
  setMemoryExitSummary: (next) => ipcRenderer.invoke('memory:set-exit-summary', next),
  // 037：分域条目管理（设置页记忆区使用；结果含 ok/code，失败如实带回）。
  listMemoryEntries: (payload) => ipcRenderer.invoke('memory:list-entries', payload),
  mutateMemoryEntry: (payload) => ipcRenderer.invoke('memory:mutate-entry', payload),
  moveMemoryEntry: (payload) => ipcRenderer.invoke('memory:move-entry', payload),
  forgetMemoryEntry: (payload) => ipcRenderer.invoke('memory:forget-entry', payload),
  clearMemoryScope: (payload) => ipcRenderer.invoke('memory:clear-scope', payload),
  undoMemoryMutation: (payload) => ipcRenderer.invoke('memory:undo', payload),
  onMemoryChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('memory:changed', listener);
    return () => ipcRenderer.removeListener('memory:changed', listener);
  },
  onContextState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('context:state', listener);
    return () => ipcRenderer.removeListener('context:state', listener);
  },
  // 009 任务历史：列表 / 详情 / 删除 / 重新总结。
  getTaskHistory: () => ipcRenderer.invoke('history:list'),
  getTaskHistoryRecord: (taskId) => ipcRenderer.invoke('history:get-record', { taskId }),
  deleteTaskHistory: (taskId) => ipcRenderer.invoke('history:remove', { taskId }),
  resummarizeTaskHistory: (taskId) => ipcRenderer.invoke('history:resummarize', { taskId }),
  // 011：继续执行中断任务。
  resumeTask: (taskId) => ipcRenderer.invoke('task:resume', { taskId }),
  // 012：打开/定位任务产物。
  openArtifact: (taskId, artifactId, intent) =>
    ipcRenderer.invoke('artifact:open', { taskId, artifactId, intent }),
  // 049 R-11：远端产物下载到本机（按档案寻址；经 SSH 读，系统保存面板）。
  downloadArtifact: (taskId, artifactId) =>
    ipcRenderer.invoke('artifact:download', { taskId, artifactId }),
  openFileChange: (taskId, filePath, intent) =>
    ipcRenderer.invoke('file-changes:open', { taskId, filePath, intent }),
  // 025：交付通道——保存报告 HTML / 受控打开来源 / 读取报告图片。
  saveDeliveryReport: (taskId) => ipcRenderer.invoke('delivery:save-report', { taskId }),
  saveTaskBodyMarkdown: (taskId) => ipcRenderer.invoke('delivery:save-body', { taskId }),
  readFileDiff: (taskId, filePath) => ipcRenderer.invoke('delivery:read-file-diff', { taskId, filePath }),
  openDeliverySource: (taskId, sourceId) =>
    ipcRenderer.invoke('delivery:open-source', { taskId, sourceId }),
  readDeliveryImage: (taskId, artifactId) =>
    ipcRenderer.invoke('delivery:read-image', { taskId, artifactId }),
  // 026：应用内文件预览的受控读取（Markdown/纯文本/图片；按档案寻址）。
  readArtifactPreview: (taskId, artifactId) =>
    ipcRenderer.invoke('delivery:read-preview', { taskId, artifactId }),
  // 027：预览面板路径点击——受控在浏览器打开已登记文件（主进程寻址）。
  openArtifactPreviewFile: (taskId, artifactId) =>
    ipcRenderer.invoke('delivery:open-preview-file', { taskId, artifactId }),
  // 062：会话交付物受控读取/打开＋Markdown 本地链接受控解析（渲染层不持路径）。
  readConversationDeliverable: (conversationId, artifactId, linkPath = null) =>
    ipcRenderer.invoke('delivery:read-conversation-deliverable', { conversationId, artifactId, linkPath }),
  openConversationDeliverable: (conversationId, artifactId, linkPath = null, intent = 'preview-file', applicationId = null) =>
    ipcRenderer.invoke('delivery:open-conversation-deliverable', { conversationId, artifactId, linkPath, intent, applicationId }),
  listConversationDeliverableApplications: (conversationId, artifactId, linkPath = null) =>
    ipcRenderer.invoke('delivery:list-conversation-deliverable-applications', { conversationId, artifactId, linkPath }),
  resolveConversationLink: (conversationId, href) =>
    ipcRenderer.invoke('delivery:resolve-conversation-link', { conversationId, href }),
  // 028 本条消息附件：登记（文件/拖入/选择窗/粘贴）/ 移除 / 列表 / 受控预览 / 受控打开来源。
  attachFile: (payload) => ipcRenderer.invoke('composer:attach-file', payload),
  attachPasteImage: (payload) => ipcRenderer.invoke('composer:attach-paste', payload),
  removeAttachment: (payload) => ipcRenderer.invoke('composer:remove-attachment', payload),
  listAttachments: (conversationId) =>
    ipcRenderer.invoke('composer:list-attachments', { conversationId }),
  listReferences: (conversationId, query, workspaceId = undefined) =>
    ipcRenderer.invoke('composer:list-references', { conversationId, query, workspaceId }),
  // 063：`/` 首层候选（命令＋生产可用技能）。
  listSlashCandidates: (conversationId) =>
    ipcRenderer.invoke('composer:list-slash-candidates', { conversationId }),
  readAttachmentPreview: (conversationId, attachmentId, stagedPath) =>
    ipcRenderer.invoke('composer:read-preview', { conversationId, attachmentId, stagedPath }),
  readAttachmentDocument: (conversationId, attachmentId) =>
    ipcRenderer.invoke('composer:read-document', { conversationId, attachmentId }),
  openAttachmentSource: (conversationId, attachmentId) =>
    ipcRenderer.invoke('composer:open-source', { conversationId, attachmentId }),
  // 029 P2：运行中投递——队列 CRUD／继续发送／阶段交接 + 推送订阅。
  enqueueTurn: (payload) => ipcRenderer.invoke('queue:enqueue', payload),
  listTurnQueue: (conversationId) => ipcRenderer.invoke('queue:list', { conversationId }),
  updateTurnQueueItem: (payload) => ipcRenderer.invoke('queue:update', payload),
  withdrawTurnQueueItem: (payload) => ipcRenderer.invoke('queue:withdraw', payload),
  resumeTurnQueue: (conversationId) => ipcRenderer.invoke('queue:resume', { conversationId }),
  promoteTurnQueueItem: (payload) => ipcRenderer.invoke('queue:promote', payload),
  onQueuePush: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('queue:push', listener);
    return () => ipcRenderer.removeListener('queue:push', listener);
  },
  // 057 对话流：命令受理 / 快照获取 / 补丁订阅（契约 §3/§7；先订阅再取快照）。
  flowCommand: (conversationId, command) =>
    ipcRenderer.invoke('flow:command', { conversationId, command }),
  flowGetSnapshot: (conversationId) =>
    ipcRenderer.invoke('flow:get-snapshot', { conversationId }),
  flowRewind: (payload) => ipcRenderer.invoke('flow:rewind', payload),
  flowSaveMetadata: (payload) => ipcRenderer.invoke('flow:save-metadata', payload),
  onFlowChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('flow:changed', listener);
    return () => ipcRenderer.removeListener('flow:changed', listener);
  },
  // 059 工作流：列表／定义只读＋两入口受理（契约 §5 首期子集）。
  workflowApplications: () => ipcRenderer.invoke('workflow:applications'),
  workflowRemove: (workflowId) => ipcRenderer.invoke('workflow:remove',{workflowId}),
  workflowOpenArtifact: (invocationId,path) => ipcRenderer.invoke('workflow:open-artifact',{invocationId,path}),
  workflowListInvocations: workflowId => ipcRenderer.invoke('workflow:list-invocations',{workflowId}),
  workflowList: () => ipcRenderer.invoke('workflow:list'),
  workflowGetRevision: (workflowId, revision) =>
    ipcRenderer.invoke('workflow:get-revision', { workflowId, revision }),
  workflowSaveDraft: (workflowId, document, name, expectedDraftRevision) =>
    ipcRenderer.invoke('workflow:save-draft', { workflowId, document, name, expectedDraftRevision }),
  workflowGetDraft: (workflowId) => ipcRenderer.invoke('workflow:get-draft', { workflowId }),
  workflowPublish: (workflowId, expectedDraftRevision, expectedRevision) =>
    ipcRenderer.invoke('workflow:publish', { workflowId, expectedDraftRevision, expectedRevision }),
  workflowPrepare: (payload) => ipcRenderer.invoke('workflow:prepare', payload),
  workflowUpdatePreparation: (payload) => ipcRenderer.invoke('workflow:update-preparation', payload),
  workflowStartPrepared: (payload) => ipcRenderer.invoke('workflow:start-prepared', payload),
  workflowAbandon: payload => ipcRenderer.invoke('workflow:abandon',payload),
  workflowContinue: (payload) => ipcRenderer.invoke('workflow:continue',payload),
  workflowSubmitInteraction: (payload) => ipcRenderer.invoke('workflow:submit-interaction', payload),
  workflowSaveInteractionDraft: (payload) => ipcRenderer.invoke('workflow:save-interaction-draft', payload),
  workflowStop: (workflowRunId) => ipcRenderer.invoke('workflow:stop', { workflowRunId }),
  workflowGetInvocation: (invocationId) =>
    ipcRenderer.invoke('workflow:get-invocation', { invocationId }),
  // 030 会话草稿：保存（revision 单调）/ 读取 / 删除。
  saveDraft: (payload) => ipcRenderer.invoke('drafts:save', payload),
  getDraft: (conversationId) => ipcRenderer.invoke('drafts:get', { conversationId }),
  removeDraft: (conversationId) => ipcRenderer.invoke('drafts:remove', { conversationId }),
  // 015 会话：最近 / 保存（防抖全量）/ 列表 / 打开 / 删除。
  getLastConversation: () => ipcRenderer.invoke('conversation:last'),
  saveConversation: (payload) => ipcRenderer.invoke('conversation:save', payload),
  listConversations: () => ipcRenderer.invoke('conversation:list'),
  // 018 原版契约：open/remove 的载荷是 { id } 对象（曾一度漂移成裸字符串，
  // 主进程取 payload.id 得 undefined → 所有会话「找不到」，2026-09-21 实录）。
  openConversation: (id) => ipcRenderer.invoke('conversation:open', { id }),
  markConversationRead: (id, expectedUnreadAt) => ipcRenderer.invoke('conversation:mark-read', { id, expectedUnreadAt }),
  removeConversation: (id) => ipcRenderer.invoke('conversation:remove', { id }),
  // 024 侧栏：双击重命名（空标题回退派生）与拖拽排序（全量 id 序）。
  renameConversation: (id, title) => ipcRenderer.invoke('conversation:rename', { id, title }),
  reorderConversations: (ids) => ipcRenderer.invoke('conversation:reorder', { ids }),
  // 档案落盘/改名/删除/排序后的变更广播（侧栏重读列表对齐；载荷仅诊断）。
  onConversationsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('conversation:changed', listener);
    return () => ipcRenderer.removeListener('conversation:changed', listener);
  },
  // 048 会话用量账本：聚合查询 + 有新记录时的变更广播（重取聚合）。
  getUsageLedger: (conversationId) => ipcRenderer.invoke('usage:get-ledger', { conversationId }),
  onUsageChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('usage:changed', listener);
    return () => ipcRenderer.removeListener('usage:changed', listener);
  },
  // 033 工作区：状态（默认 + 项目列表）/ 目录选择器添加项目 / 移除列表项。
  getWorkspaceState: () => ipcRenderer.invoke('workspace:get-state'),
  addWorkspaceFolder: () => ipcRenderer.invoke('workspace:add-folder'),
  removeWorkspace: (id) => ipcRenderer.invoke('workspace:remove', { id }),
  // 049：添加服务器上的文件夹（SSH 目标＋远端路径；probe 通过才登记）。
  addRemoteWorkspace: (host, dir, password, remember) =>
    ipcRenderer.invoke('workspace:add-remote', {
      host, dir,
      ...(password ? { password } : {}),
      ...(remember === false ? { remember: false } : {}),
    }),
  // 049：重试连接（重新探测登记的远端项目并更新状态缓存；认证失败可带密码重试）。
  probeRemoteWorkspace: (id, password, remember) =>
    ipcRenderer.invoke('workspace:probe-remote', {
      id,
      ...(password ? { password } : {}),
      ...(remember === false ? { remember: false } : {}),
    }),
  // 066：顶栏打开工作区目录（访达/资源管理器、终端、VS Code）＋默认方式偏好。
  openWorkspaceDir: (id, target) => ipcRenderer.invoke('workspace:open-dir', { id, target }),
  getWorkspaceOpenTarget: () => ipcRenderer.invoke('workspace:get-open-target'),
  setWorkspaceOpenTarget: (target) => ipcRenderer.invoke('workspace:set-open-target', { target }),
  // 019 原生双工后端：启停/打断/增益 + 事件订阅（cap/drained/underrun/state）。
  startDuplex: () => ipcRenderer.invoke('duplex:start'),
  stopDuplex: () => ipcRenderer.invoke('duplex:stop'),
  duplexStopPlay: () => ipcRenderer.invoke('duplex:stop-play'),
  duplexVolume: (gain) => ipcRenderer.invoke('duplex:volume', gain),
  onDuplexCap: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('duplex:cap', listener);
    return () => ipcRenderer.removeListener('duplex:cap', listener);
  },
  onDuplexDrained: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('duplex:drained', listener);
    return () => ipcRenderer.removeListener('duplex:drained', listener);
  },
  onDuplexUnderrun: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('duplex:underrun', listener);
    return () => ipcRenderer.removeListener('duplex:underrun', listener);
  },
  onDuplexState: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('duplex:state', listener);
    return () => ipcRenderer.removeListener('duplex:state', listener);
  },
});
