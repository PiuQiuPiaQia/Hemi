/**
 * IPC 通道名的唯一事实来源：主进程（ipc/ 与 windows/）从这里引用，
 * 渲染层经 preload 桥间接使用。
 *
 * 已知的例外：src/preload/index.cjs 运行在沙箱渲染进程里，只能内联字符串、
 * 无法 import 本文件——由 src/main/ipc/channels-parity.test.mjs 保证两侧
 * 不漂移。新增通道时：先加到这里，再写 preload 与主进程两侧。
 */
export const IPC = {
  bot: {state:'bot:state',connect:'bot:connect',initialize:'bot:initialize',models:'bot:models',directory:'bot:directory',command:'bot:command',upload:'bot:upload',download:'bot:download',environment:'bot:environment',changed:'bot:changed'},
  appearance: {
    bootstrap:'appearance:bootstrap',get:'appearance:get',set:'appearance:set',changed:'appearance:changed',
    applied:'appearance:applied',visualReady:'appearance:visual-ready',activity:'appearance:activity',
  },
  skills: {
    state: 'skills:state',
    refresh: 'skills:refresh',
    importLocal: 'skills:import-local',
    install: 'skills:install',
    setEnabled: 'skills:set-enabled',
    remove: 'skills:remove',
    read: 'skills:read',
    reveal: 'skills:reveal',
    /** 034 SkillsMP：只读搜索（失败回执带缓存与时间）。 */
    mpSearch: 'skills:mp-search',
    /** 034 SkillsMP：条目详情 + GitHub 固定提交快照预览（不落状态）。 */
    mpPreview: 'skills:mp-preview',
    /** 034 SkillsMP：按预览钉住的 commit+摘要重取并确认安装。 */
    mpInstall: 'skills:mp-install',
    /** 034 SkillsMP：已装 skillsmp 项手动检查更新（只报告，不自动装）。 */
    mpCheckUpdate: 'skills:mp-check-update',
  },
  system: {
    openExternal: 'system:open-external',
    /** 056：对话内容链接（任意 http/https，默认浏览器）。 */
    openLink: 'system:open-link',
    /**
     * 2026-10-05：主进程写剪贴板。navigator.clipboard.writeText 在带权限
     * 处理器的会话里按 clipboard-read 审（本版 Electron 连只写也走读权限），
     * 放行等于让渲染层可读剪贴板——复制一律走主进程，无权限/无焦点要求。
     */
    copyText: 'system:copy-text',
    /** 系统「键盘导航」开关（mac AppleKeyboardUIMode）：决定 Tab 是否走遍所有控件。 */
    keyboardNavigation: 'system:keyboard-navigation',
  },
  composer: {
    /** 028：本条消息附件——文件登记（选择窗/拖入共用，路径由渲染层受控取得）。 */
    attachFile: 'composer:attach-file',
    readDocument: 'composer:read-document',
    /** 028：粘贴图片登记（data URL 落受控暂存区取得稳定身份）。 */
    attachPaste: 'composer:attach-paste',
    /** 028：移除未发送附件（撤销登记，粘贴暂存字节一并清理）。 */
    removeAttachment: 'composer:remove-attachment',
    /** 028：按会话列附件（草稿区与历史入口的元数据来源）。 */
    listAttachments: 'composer:list-attachments',
    /** 028：受控预览读取（结果形状与 027 成果预览一致）。 */
    readPreview: 'composer:read-preview',
    /** 028：工具栏路径点击的受控打开（粘贴图片没有原文件）。 */
    openSource: 'composer:open-source',
    /** 028 二批：`@` 引用候选（附件＋任务成果＋008 对象＋063 工作流/文件/对话；按会话过滤）。 */
    listReferences: 'composer:list-references',
    /** 063：`/` 首层候选（命令＋当前会话生产可用技能）。 */
    listSlashCandidates: 'composer:list-slash-candidates',
  },
  queue: {
    /** 029 P2：运行中投递——入队 / 列表 / 行内编辑 / 撤回 / 继续发送 / 阶段交接。 */
    enqueue: 'queue:enqueue',
    list: 'queue:list',
    update: 'queue:update',
    withdraw: 'queue:withdraw',
    resume: 'queue:resume',
    /** 060 R-21：显式插队——让该条目优先：保存优先关系后停止旧目标，确认后优先派发。 */
    promote: 'queue:promote',
    /** main → renderer：队列状态与派发/结果事件（单通道带 type）。 */
    push: 'queue:push',
  },
  flow: {
    /** 057：对话流统一状态——命令受理 / 快照获取 / 补丁推送（契约 §3/§7）。 */
    command: 'flow:command',
    getSnapshot: 'flow:get-snapshot',
    changed: 'flow:changed',
    /** S3-2d：编辑回卷——档案剪除（cutKeys＋主 agent 作废）＋flow 时间线裁剪。 */
    rewind: 'flow:rewind',
    /** S3-2d：元数据轻保存（profile/workspace；不动 turns——空表不再是权威整表）。 */
    saveMetadata: 'flow:save-metadata',
  },
  /** 059：工作流（列表／定义只读＋两入口受理；契约 §5 候选 IPC 的首期子集）。 */
  workflow: {
    applications: 'workflow:applications',
    abandon: 'workflow:abandon',
    continue: 'workflow:continue',
    submitInteraction: 'workflow:submit-interaction',
    saveInteractionDraft: 'workflow:save-interaction-draft',
    remove: 'workflow:remove',
    openArtifact: 'workflow:open-artifact',
    list: 'workflow:list',
    listInvocations: 'workflow:list-invocations',
    getRevision: 'workflow:get-revision',
    /** 草稿读写（编辑画布保存；publish 单独走，保存草稿不做可运行校验）。 */
    saveDraft: 'workflow:save-draft',
    getDraft: 'workflow:get-draft',
    publish: 'workflow:publish',
    prepare: 'workflow:prepare',
    updatePreparation: 'workflow:update-preparation',
    startPrepared: 'workflow:start-prepared',
    stop: 'workflow:stop',
    getInvocation: 'workflow:get-invocation',
  },
  drafts: {
    /** 030：按会话保存未发送草稿（revision 单调守卫在主进程）。 */
    save: 'drafts:save',
    /** 030：读会话草稿（损坏/缺失都按无草稿返回）。 */
    get: 'drafts:get',
    /** 030：删会话草稿（会话删除联动，幂等）。 */
    remove: 'drafts:remove',
  },
  asr: {
    getConfig: 'asr:get-config',
    saveConfig: 'asr:save-config',
    start: 'asr:start',
    audio: 'asr:audio',
    stop: 'asr:stop',
    /** main → renderer：识别事件流。 */
    event: 'asr:event',
  },
  onboarding: {
    /** 032：引导快照（phase/step/permissionChoice + 两项配置实时满足情况）。 */
    getState: 'onboarding:get-state',
    /** 032：前进/后退一步（主进程按步骤校验硬门槛）。 */
    advance: 'onboarding:advance',
    /** 032：完成屏「开始使用」——复核双配置后写完成版本。 */
    complete: 'onboarding:complete',
  },
  permissions: {
    microphone: 'permissions:microphone',
    microphoneStatus: 'permissions:microphone-status',
    openMicSettings: 'permissions:open-mic-settings',
  },
  /**
   * 043：平台能力快照（B1 共享底座）。主进程是能力状态的唯一事实来源，
   * 渲染层先订阅（state-changed）再取初始快照（get-state），按
   * {sessionId, revision} 去重；performAction 只接受快照里登记过的固定动作。
   */
  platform: {
    getState: 'platform:get-state',
    recheck: 'platform:recheck',
    performAction: 'platform:perform-action',
    /** main → renderer：能力快照广播（全量，revision 单调递增）。 */
    stateChanged: 'platform:state-changed',
  },
  llm: {
    getConfig: 'llm:get-config',
    saveConfig: 'llm:save-config',
    chat: 'llm:chat',
    submit: 'llm:submit',
    cancel: 'llm:cancel',
    /** 会话所属最后一轮状态：导航重接/后台完成。 */
    getTurnState: 'llm:get-turn-state',
    turnState: 'llm:turn-state',
    /** 设置页「测试连通性」：最小请求探活文本模型（表单值可覆盖存储值）。 */
    testModel: 'llm:test-model',
    /** 031：思考强度快捷拨盘（只写档位，下一轮对话即生效）。 */
    setThinkingLevel: 'llm:set-thinking-level',
    /** 031 多组模型配置：目录列表 / 保存（新建或更新）/ 删除 / 默认组 / 逐组测试。 */
    listModelProfiles: 'llm:list-model-profiles',
    saveModelProfile: 'llm:save-model-profile',
    removeModelProfile: 'llm:remove-model-profile',
    setDefaultModelProfile: 'llm:set-default-model-profile',
    /** 2026-10-08：记上次主脑模型选择（模型键或 'auto'；新建对话优先恢复）。 */
    setLastConversationModel: 'llm:set-last-conversation-model',
    /** 056：全局看图模型（单独配置）。 */
    setVisionModel: 'llm:set-vision-model',
    testModelProfile: 'llm:test-model-profile',
    /** 041 拉取模型列表：GET {baseUrl}/models（供应商详情用已存 Key，添加流程用未保存的 Key）。 */
    listRemoteModels: 'llm:list-remote-models',
    /** 038 自动模型路由：角色逐项即时保存（一个 patch 一个字段，主进程合并落盘）。 */
    /** 056：角色模型槽位（四个子 agent 角色＋备用）的视图与逐项保存。 */
    getRoleModels: 'llm:get-role-models',
    saveRoleModel: 'llm:save-role-model',
    /** main → renderer：流式增量分片。 */
    delta: 'llm:delta',
  },
  oauth: {
    start: 'oauth:start',
    getState: 'oauth:get-state',
    answer: 'oauth:answer',
    cancel: 'oauth:cancel',
    logout: 'oauth:logout',
  },
  usage: {
    /** 048：会话用量账本（对话侧记录＋任务执行汇总合并）。 */
    getLedger: 'usage:get-ledger',
    /** main → renderer：账本有新记录（对话轮结束、任务每次模型调用完成）。 */
    changed: 'usage:changed',
  },
  contextUsage: {
    /** 上下文容量快照（主 agent 会话当前占用＋分类估算）。 */
    getSnapshot: 'context-usage:get-snapshot',
    /** main → renderer：轮末上下文占用可能变化（重取快照）。 */
    changed: 'context-usage:changed',
  },
  tts: {
    getConfig: 'tts:get-config',
    saveConfig: 'tts:save-config',
    speak: 'tts:speak',
    cancel: 'tts:cancel',
    /** main → renderer：音频分片。 */
    audio: 'tts:audio',
    /** main → renderer：合成收尾/失败。 */
    state: 'tts:state',
  },
  duplex: {
    /** 019：拉起原生双工后端（失败返回 reason，渲染层回退浏览器链路）。 */
    start: 'duplex:start',
    /** 019：会话结束关停。 */
    stop: 'duplex:stop',
    /** 019：打断停播（清播放队列）。 */
    stopPlay: 'duplex:stop-play',
    /** 019：播放增益（duck/恢复，duplexd 内 20ms 子块渐变）。 */
    volume: 'duplex:volume',
    /** main → renderer：处理后采集帧（16k 单声道 i16，消回声后）。 */
    cap: 'duplex:cap',
    /** main → renderer：播放队列自然排空。 */
    drained: 'duplex:drained',
    /** main → renderer：播放断流。 */
    underrun: 'duplex:underrun',
    /** main → renderer：后端状态（running/restarting/fault/failed）。 */
    state: 'duplex:state',
  },
  app: {
    log: 'app:log',
    /** 在 Finder 中定位 hemi.log。 */
    revealLog: 'app:reveal-log',
  },
  /** 044：应用内更新（electron-updater + 公开 Release 下载）。 */
  updater: {
    getState: 'updater:get-state',
    check: 'updater:check',
    download: 'updater:download',
    install: 'updater:install',
    /** main → renderer：状态广播（全量）。 */
    changed: 'updater:changed',
  },
  ui: {
    getPreferences: 'ui:get-preferences',
    setFloatingOrbEnabled: 'ui:set-floating-orb-enabled',
    /** 013：仅响应首位说话人开关。 */
    setPrimarySpeakerEnabled: 'ui:set-primary-speaker-enabled',
    /** 022：全局长按 Option 对话开关（macOS）。 */
    setGlobalPushToTalkEnabled: 'ui:set-global-push-to-talk-enabled',
    /**
     * 043：长按键配置统一入口（enabled 与 key 可只给其一）。
     * 旧 setGlobalPushToTalkEnabled 语义映射到这里；key 只接受当前平台
     * 已验证的键（mac=option；Windows 候选键等 WP-04 探针后才开放）。
     */
    setPushToTalkConfig: 'ui:set-push-to-talk-config',
    /** 022：弹辅助功能授权引导框（用户手势触发）。 */
    requestAccessibilityTrust: 'ui:request-accessibility-trust',
    /** 022：直达「输入监控」面板（键盘事件 tap 在部分系统只认它）。 */
    openInputMonitoringPane: 'ui:open-input-monitoring-pane',
    setMainExpanded: 'ui:set-main-expanded',
    hideMain: 'ui:hide-main',
    publishState: 'ui:publish-state',
    getState: 'ui:get-state',
    /** 065 dev 只读窗口活动；backgroundThrottling=false 时 DOM 可见性不可靠。 */
    getDevWindowActivity: 'ui:get-dev-window-activity',
    devWindowActivity: 'ui:dev-window-activity',
    /** main → renderer：广播 UI 状态。 */
    state: 'ui:state',
  },
  floating: {
    getCaptionLayout: 'floating:get-caption-layout',
    /** renderer → main：悬浮球/任务菜单的悬停状态（显示/隐藏任务菜单）。 */
    taskHover: 'floating:task-hover',
    /** main → renderer：字幕布局更新。 */
    captionLayout: 'floating:caption-layout',
    showMain: 'floating:show-main',
    holdStart: 'floating:hold-start',
    holdEnd: 'floating:hold-end',
    holdCancel: 'floating:hold-cancel',
    dragStart: 'floating:drag-start',
    dragMove: 'floating:drag-move',
    dragEnd: 'floating:drag-end',
    /** main → renderer：拖动已被识别为移动（区别于长按）。 */
    dragDetected: 'floating:drag-detected',
    /** main → renderer：长按命令转发给主窗口。 */
    command: 'floating:command',
    /**
     * main → renderer：悬浮窗隐藏/重现。Chromium 在窗口 hide() 时不发
     * mouseleave，:hover 会冻结在旧值——渲染层据此重置悬停态。
     */
    visibilityChanged: 'floating:visibility-changed',
  },
  task: {
    getState: 'task:get-state',
    /** renderer → main：任务动作（stop / decide / retry-summary / check-result / new-task）。 */
    action: 'task:action',
    /** 011：继续执行中断任务（同一 taskId 新尝试）。 */
    resume: 'task:resume',
    /** main → renderer：任务状态快照广播（全量，seq 单调递增）。 */
    state: 'task:state',
  },
  executor: {
    /** 006：computer use 配置（开关 + 视觉模型）与 macOS 权限检测/引导。 */
    getComputerUse: 'executor:get-computer-use',
    setComputerUse: 'executor:set-computer-use',
    getVisionPermissions: 'executor:get-vision-permissions',
    openPermissionPane: 'executor:open-permission-pane',
    /** 014：浏览器操控（扩展桥）开关、桥运行态与扩展目录定位。 */
    getBrowserControl: 'executor:get-browser-control',
    setBrowserControl: 'executor:set-browser-control',
    getBrowserBridge: 'executor:get-browser-bridge',
    exportBrowserExtension: 'executor:export-browser-extension',
    /** web 检索：开关 + provider key（key 只写不读，回执只带 hasApiKey）。 */
    getWebSearch: 'executor:get-web-search',
    setWebSearch: 'executor:set-web-search',
    /** 020：browser_act（Jev 步进）开关与端点配置。 */
    getBrowserAct: 'executor:get-browser-act',
    setBrowserAct: 'executor:set-browser-act',
    /** 设置页「测试连通性」：最小 systemone 请求探活 Jev 决策端。 */
    testBrowserAct: 'executor:test-browser-act',
    /** 2026-09-26：执行器终端命令走系统代理（输入工具行快捷开关，默认关）。 */
    getShellProxy: 'executor:get-shell-proxy',
    setShellProxy: 'executor:set-shell-proxy',
  },
  /** 042：应用级授权（access-grants.json 事实源，contracts §4）。 */
  access: {
    getState: 'access:get-state',
    listApplications: 'access:list-applications',
    addApplication: 'access:add-application',
    setUiEnabled: 'access:set-ui-enabled',
    removeGrant: 'access:remove-grant',
    revokeResource: 'access:revoke-resource',
    /** 保存失败后重试：内存现状（含已生效的失败撤销）整体重新落盘，成功即解锁。 */
    retrySave: 'access:retry-save',
    changed: 'access:changed',
  },
  context: {
    /** 008：读工作对象列表（来源条初始化）。 */
    getState: 'context:get-state',
    /** 008：附加当前对象（kind ∈ web / file / screenshot；file＝访达选中优先、浏览窗兜底）。 */
    attach: 'context:attach',
    /** 008：重采集指定对象。 */
    refresh: 'context:refresh',
    /** 008：移除指定对象。 */
    remove: 'context:remove',
    /** main → renderer：工作对象状态广播（全量）。 */
    state: 'context:state',
  },
  agentEnvironment: {
    inspect: 'agent-environment:inspect',
    readFile: 'agent-environment:read-file',
  },
  history: {
    /** 009：任务历史列表（含 corrupt 条目与 storageError）。 */
    list: 'history:list',
    /** 009：按 taskId 读完整记录（事件/转向/报告）。 */
    getRecord: 'history:get-record',
    /** 009：删除任务记录文件。 */
    remove: 'history:remove',
    /** 009：对存档报告重新总结（不触执行器）。 */
    resummarize: 'history:resummarize',
  },
  /**
   * 047：New API 站点登录导入（受保护 IPC——仅主窗口受信任顶层 frame）。
   * 状态机/秘密全在主进程；renderer 只消费安全 DTO（无 Key/JWT/Cookie/DOM）。
   */
  providerImport: {
    start: 'provider-import:start',
    getState: 'provider-import:get-state',
    listPending: 'provider-import:list-pending',
    /** 恢复崩溃/退出遗留的待处理导入（先读目录回执再读 journal）。 */
    resumePending: 'provider-import:resume-pending',
    /** 「我已登录，继续」：同会话 self 核验＋本人组发现；中途失效时从断点续跑。 */
    checkLogin: 'provider-import:check-login',
    /** 分组/型号/协议/预算/期限/首次默认选择；revision 单调守卫。 */
    setSelection: 'provider-import:set-selection',
    /** 「创建 Key 并导入」：唯一远端写入起点（再 preflight 后创建/验证/保存）。 */
    submit: 'provider-import:submit',
    retry: 'provider-import:retry',
    pause: 'provider-import:pause',
    resume: 'provider-import:resume',
    /** 取消：先结算提交事实，已创建则精确撤销本次令牌。 */
    cancel: 'provider-import:cancel',
    /** 渲染层占位 div 的 DIP bounds/显隐（不加载 URL）。 */
    setViewport: 'provider-import:set-viewport',
    /** main → renderer：安全状态事件（revision 递增；getState 可补掉帧）。 */
    state: 'provider-import:state',
  },
  artifact: {
    /** 012：按 taskId+artifactId 打开/定位产物（主进程解析目标，R-07）。 */
    open: 'artifact:open',
    /** 049 R-11：远端产物下载到本机（系统保存面板默认「下载」；经 SSH 流式读）。 */
    download: 'artifact:download',
  },
  fileChanges: {
    /** 050 R-06：打开/定位改动文件（主进程按档案 fileChanges 校验路径后执行）。 */
    open: 'file-changes:open',
  },
  delivery: {
    /** 025：保存报告 HTML（系统保存面板；内容来自档案里的已校验交付）。 */
    saveReport: 'delivery:save-report',
    /** 050：保存交付正文 .md（系统保存面板；内容来自档案 resultText）。 */
    saveBody: 'delivery:save-body',
    /** 050 R-22：读文件改动的本任务 Diff（档案 fileDiffs；按 taskId+path 寻址）。 */
    readFileDiff: 'delivery:read-file-diff',
    /** 025：受控打开来源链接（只认档案 delivery.sources 里的 https 条目）。 */
    openSource: 'delivery:open-source',
    /** 025：读取报告图片（只认档案登记过的图片文件产物，转 data URL）。 */
    readImage: 'delivery:read-image',
    /** 026：应用内文件预览的受控读取（Markdown/纯文本/图片；按档案寻址）。 */
    readPreview: 'delivery:read-preview',
    /** 027：预览面板路径点击——受控在浏览器打开已登记文件（主进程寻址）。 */
    openPreviewFile: 'delivery:open-preview-file',
    /** 062：会话交付物受控读取（按 conversationId+artifactId 从 flow 解析；link＝Markdown 本地链接线索，主进程重新受控解析）。 */
    readConversationDeliverable: 'delivery:read-conversation-deliverable',
    /** 062：会话交付物受控打开（预览栏路径点击；范围外格式走系统应用）。 */
    openConversationDeliverable: 'delivery:open-conversation-deliverable',
    listConversationDeliverableApplications: 'delivery:list-conversation-deliverable-applications',
    /** 062：对话正文 Markdown 本地文件链接的受控解析（成功返回可预览对象，不冒充正式交付）。 */
    resolveConversationLink: 'delivery:resolve-conversation-link',
  },
  workspace: {
    /** 033：工作区状态（默认工作区 + 项目列表，含实时可用性）。 */
    getState: 'workspace:get-state',
    /** 033：系统目录选择器添加项目目录（realpath 去重；取消返回 cancelled）。 */
    addFolder: 'workspace:add-folder',
    /** 033：移除项目列表项（不删磁盘文件）。 */
    remove: 'workspace:remove',
    /** 049 R-01：添加服务器上的文件夹（SSH 目标＋远端路径；probe 通过才登记）。 */
    addRemote: 'workspace:add-remote',
    /** 049 R-09：重试连接（重新探测登记的远端项目并更新状态）。 */
    probeRemote: 'workspace:probe-remote',
    /** 066：顶栏打开工作区目录（按登记 id 解析＋远端/失效拒绝；target=finder/terminal/vscode）。 */
    openDir: 'workspace:open-dir',
    /** 066：打开方式偏好（顶栏主按钮图标与菜单勾选的默认 target）。 */
    getOpenTarget: 'workspace:get-open-target',
    setOpenTarget: 'workspace:set-open-target',
  },
  conversation: {
    /** 015：最近会话全文（启动继续上次对话；无则 null）。 */
    last: 'conversation:last',
    /** 015：全量保存（渲染层防抖触发；upsert 语义）。 */
    save: 'conversation:save',
    /** 015：会话列表（不带全文）。 */
    list: 'conversation:list',
    /** 015：按 id 读会话全文（历史列表点开载入）。 */
    open: 'conversation:open',
    /** 060：按实际看见的未读版本清除标记。 */
    markRead: 'conversation:mark-read',
    /** 015：删除会话。 */
    remove: 'conversation:remove',
    /** 024：双击重命名（空标题＝回退派生标题；不动 updatedAt）。 */
    rename: 'conversation:rename',
    /** 024：侧栏拖拽排序（全量 id 序落 order-index.json）。 */
    reorder: 'conversation:reorder',
    /** 档案落盘/改名/删除/排序后向所有窗口广播（侧栏列表及时对齐）。 */
    changed: 'conversation:changed',
  },
};
