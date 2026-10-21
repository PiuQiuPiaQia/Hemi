import { app, Menu, nativeImage, powerMonitor, protocol, session } from 'electron';
import path from 'node:path';

import { appIconPath, devAppIconPath } from './paths.mjs';

import { registerAllIpcHandlers } from './ipc/index.mjs';
import { initializeStableSafeStorageIdentity } from './lib/config-store.mjs';
import { openExternalIfAllowed } from './lib/external-links.mjs';
import {
  startGlobalPushToTalk,
  stopGlobalPushToTalk,
} from './lib/global-push-to-talk.mjs';
import { createLogger, logSessionEnd, logSessionStart } from './lib/logger.mjs';
import { fmtMs, startEventLoopLagMonitor } from './lib/perf.mjs';
import { cleanupLegacyExecutorInstall } from './agent/permission-state.mjs';
import { shutdownBrowserBridgeService } from './services/browser-bridge-service.mjs';
import { runSmokeTest } from './smoke-test.mjs';
import { BRAND_NAME, isSmokeTest, state } from './state.mjs';
import {
  MAIN_WINDOW_COMPACT,
  MAIN_WINDOW_EXPANDED,
  createMainWindow,
  setMainWindowExpanded,
  showMainWindow,
} from './windows/main-window.mjs';
import {
  FLOATING_ORB_SIZE,
  createFloatingSurface,
  finishFloatingDrag,
  setFloatingDragState,
  showFloatingOrbIfNeeded,
  startVisibilityPolling,
  stopVisibilityPolling,
  updateFloatingDragPosition,
} from './windows/floating-surface.mjs';
import { installNativeShell } from './windows/native-shell.mjs';
import { stopActiveAsrSession } from './ipc/asr.ipc.mjs';
import { stopDuplexHost } from './ipc/audio.ipc.mjs';
import { abortActiveTextModelTurn } from './ipc/llm.ipc.mjs';
import {
  ensureOnboardingInitialized,
  setOnboardingCompletedHook,
} from './ipc/onboarding.ipc.mjs';
import { disposeTaskManager } from './ipc/task.ipc.mjs';
import { scheduleStartupUpdaterCheck } from './ipc/updater.ipc.mjs';
import { disposeCuaDriver } from './agent/gate/cua-client.mjs';
import { closeActiveTtsPlayback } from './ipc/tts.ipc.mjs';
import { publishUiState } from './ipc/ui.ipc.mjs';
import { getProviderImportService } from './ipc/provider-import.ipc.mjs';
import { getRemoteService } from './remote/remote-service.mjs';
import { conversationMedia } from './services/media-preview.mjs';

protocol.registerSchemesAsPrivileged([
  { scheme: 'hemi-media', privileges: { standard: true, secure: true, stream: true } },
]);

// 开发启动包仍必须是未打包实例；在设置/读取生产存储之前拒绝错误的运行时身份。
if (process.env.HEMI_DEV_RUNTIME === '1' && app.isPackaged) {
  throw new Error('开发运行时被误判为正式安装包，已停止启动以保护生产数据。');
}

const STABLE_STORAGE_NAME = 'hemi';
// 本地调试实例（未打包的 electron .）默认与生产安装包隔离存储：共用同名
// userData 会共享单实例锁与全部状态文件——dev 与安装包互踢、互相覆盖配置
// 与会话记录（2026-09-24 用户要求隔离）。HEMI_USER_DATA_DIR 仍是最高优先级
// 覆盖，自驱动/冒烟 harness 全走它，不受影响。首次使用 dev 目录需按
// AGENTS.md 从生产目录拷一次配置。
// 注意：app.name 不能跟着分支——macOS safeStorage 的 Keychain 身份跟它走，
// dev 改名会换掉加密钥匙，生产目录拷来的密文配置（API Key 等）全部解不开
// （2026-09-24 真机实测：改名后「模型未配置／ASR 未配置」）。隔离只动
// userData 路径，单实例锁与日志随路径自然分家。
const DEV_STORAGE_NAME = 'hemi-dev';
app.setName(STABLE_STORAGE_NAME);
const stableUserDataPath = process.env.HEMI_USER_DATA_DIR
  ? path.resolve(process.env.HEMI_USER_DATA_DIR)
  : path.join(
      app.getPath('appData'),
      app.isPackaged ? STABLE_STORAGE_NAME : DEV_STORAGE_NAME,
    );
app.setPath('userData', stableUserDataPath);

// 自动化真机验证用：强制把渲染层可访问性树暴露给系统 AX API，
// 供辅助工具读取与操作界面。正常启动不设 HEMI_FORCE_AX，零开销。
const isForcedAx = process.env.HEMI_FORCE_AX === '1';
if (isForcedAx) {
  app.commandLine.appendSwitch('force-renderer-accessibility');
}

// 019 阶段 B 实验开关（真机 A/B 用，默认关闭、正常启动零行为变化）：
// HEMI_AEC_ENFORCE=1 时启用 Chromium 的系统回声消除（macOS 走 Apple
// VoiceProcessingIO，参考信号来自默认输出设备；要求单/双声道输入、非聚合
// 设备）。生效与否不以此开关为准——以接通后的「音频环境」诊断与 Chromium
// 媒体日志（--enable-logging 下有 voice processing 取舍记录）对照判定。
const isAecEnforced = process.env.HEMI_AEC_ENFORCE === '1';
if (isAecEnforced) {
  app.commandLine.appendSwitch('enable-features', 'EnforceSystemEchoCancellation');
}

/**
 * 单实例锁：同一份 userData（同机同应用身份，含本仓库的不同代码副本）
 * 只允许一个实例。两份副本同时跑会叠出两套置顶悬浮球/字幕条、还互相
 * 覆盖配置文件，用户看到的是「一个实例的旧字幕 + 另一个实例的状态」。
 * smoke 用独立实例，跳过锁，避免与正在开发的实例互相阻塞。
 */
const hasSingleInstanceLock =
  isSmokeTest || app.requestSingleInstanceLock();

/** 埋点：事件循环阻塞监控句柄（whenReady 内启动，before-quit 收尾）。 */
let eventLoopMonitor = null;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次启动时把已有实例的主窗口带到前台，而不是新开一个。
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      showMainWindow();
    }
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  protocol.handle('hemi-media', request => conversationMedia.respond(request));

  if (isForcedAx) app.setAccessibilitySupportEnabled(true);
  logSessionStart();
  // 埋点：主进程事件循环阻塞监控——「整个应用间歇卡死」的直接指标。阻塞期间
  // UI 转发、IPC、定时器全部停摆（典型根因：视觉原语 spawnSync、同步文件 IO）；
  // 与任务侧的耗时统计（task 域）配合定位是「任务慢」还是「主进程卡」。
  const perfLog = createLogger('perf');
  eventLoopMonitor = startEventLoopLagMonitor({
    onWarn: ({ lagMs, activities }) => perfLog.warn(
      `主进程事件循环阻塞 ${fmtMs(lagMs)}：期间 UI/音频/任务事件全部停摆（常见根因：视觉原语子进程、同步文件 IO）` +
        (activities.length > 0
          ? `；窗口内活动：${activities.join('、')}`
          : '；窗口内无已登记活动（指向进程外停摆：系统级 IO/换页）'),
    ),
    onSleep: ({ lagMs, source }) =>
      perfLog.info(
        source === 'power'
          ? `系统睡眠唤醒（powerMonitor 证实）：探针停摆 ${fmtMs(lagMs)}，不计事件循环阻塞`
          : `定时器冻结 ${fmtMs(lagMs)} 后恢复：疑似系统睡眠/挂起，不计事件循环阻塞` +
              `（真阻塞到分钟级＝进程死锁，非睡眠时段反复出现需单独排查）`,
      ),
    onSummary: (windowStats) => perfLog.info(
      `事件循环近 10 分钟：阻塞 ${windowStats.events} 次 · 累计 ${fmtMs(windowStats.totalMs)} · 最长 ${fmtMs(windowStats.maxMs)}`,
    ),
  });
  // 2026-10-06 审计 F1：短睡眠（合盖小睡/Power Nap，1-3 分钟）低于冻结阈值，
  // 此前全被误报成「分钟级阻塞」——用 powerMonitor 显式睡眠窗口判定，不再看时长。
  powerMonitor.on('suspend', () => eventLoopMonitor?.markSuspend());
  powerMonitor.on('resume', () => eventLoopMonitor?.markResume());
  // 019 R-08：AEC 实验状态进会话日志，与渲染层「音频环境」诊断对照。
  createLogger('audio').info(
    `系统 AEC（EnforceSystemEchoCancellation）：${isAecEnforced ? '已请求启用（macOS VoiceProcessingIO，实际生效以接通后诊断与媒体日志为准）' : '未请求（默认链路）'}`,
  );
  initializeStableSafeStorageIdentity();
  app.setName(BRAND_NAME);
  // 「关于」面板对齐品牌。Dock 悬停名和原生菜单名来自 bundle 的 Info.plist；
  // dev:electron 在启动前同步品牌元数据，打包实例由 electron-builder 写入。
  // dev 运行态补设 Dock 图标；打包后图标来自 bundle，不再运行时覆盖。
  app.setAboutPanelOptions({
    applicationName: BRAND_NAME,
    applicationVersion: app.getVersion(),
    iconPath: appIconPath,
  });
  // 原生壳：去掉默认菜单的重载/DevTools/缩放（开发实例保留）、拦截页内导航。
  // 须在建任何窗口前装上，web-contents-created 才能覆盖到全部窗口。
  installNativeShell({
    app,
    Menu,
    platform: process.platform,
    appName: BRAND_NAME,
    devTools: !app.isPackaged,
    openExternal: openExternalIfAllowed,
  });
  if (process.platform === 'darwin' && app.dock) {
    // 常驻 Dock（用户 2026-09-20：收起/隐藏主窗口后也要能从 Dock 找回应用）。
    // 启动先拉回常规应用；真正的隐患是悬浮窗的 setVisibleOnAllWorkspaces(
    // { visibleOnFullScreen }) 会把应用翻回辅助应用（Dock 图标消失），那边在
    // showOnAllWorkspacesKeepingDock 里各自重申，这里只管启动时刻。dev 随后换成
    // dev 专用图标（打包后图标来自 bundle 本身，且 dev bundle 也指 icon-dev）。
    await app.dock.show();
    if (!app.isPackaged) {
      const icon = nativeImage.createFromPath(devAppIconPath);
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }
  }
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === 'media',
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => callback(permission === 'media'),
  );

  // 023 R-12：Pi 已内置，升级启动清掉旧 RPC 形态的安装残留（失败只记日志）。
  void cleanupLegacyExecutorInstall({
    userDataDir: app.getPath('userData'),
    log: createLogger('task'),
  });
  await registerAllIpcHandlers();
  // 032：建窗口前完成引导首次判定（写入进行中）——渲染层首帧即知
  // 首启/主界面，不闪屏；完成后的语音入口恢复由完成钩子承接。
  await ensureOnboardingInitialized();
  setOnboardingCompletedHook(async () => {
    void startGlobalPushToTalk();
    reconcileFloatingVisibility();
  });
  // 024 文字自驱动：窗口加载前完成权限/计数整形（须在 IPC 注册后、窗口创建前）。
  if (process.env.HEMI_SELF_RUN_TEXT || process.env.HEMI_SELF_RUN_TEXT_SCENARIOS) {
    const { prepareTextSelfRun } = await import('./self-run-text-input.mjs');
    await prepareTextSelfRun();
  }
  if (process.env.HEMI_SELF_RUN_TEXT_SCENARIOS) {
    const { prepareTextScenarios } = await import('./self-run-text-scenarios.mjs');
    await prepareTextScenarios();
  }
  await createMainWindow();
  // 022：全局长按 Option 对话（内部自管开关/权限/smoke 跳过，失败只落日志）。
  void startGlobalPushToTalk();
  // 044：启动后静默检查更新（打包实例才排；只亮状态不下载，失败只落日志）。
  if (!isSmokeTest) scheduleStartupUpdaterCheck();

  if (isSmokeTest && !process.env.HEMI_SELF_RUN_TEXT && !process.env.HEMI_SELF_RUN_TEXT_SCENARIOS) {
    await runSmokeTest({
      mainWindow: state.mainWindow,
      brandName: BRAND_NAME,
      windowSizes: {
        compact: MAIN_WINDOW_COMPACT,
        expanded: MAIN_WINDOW_EXPANDED,
      },
      orbSize: FLOATING_ORB_SIZE,
      setMainWindowExpanded,
      createFloatingSurface,
      showFloatingOrbIfNeeded,
      publishUiState,
      readCaptionLayout: () => state.lastCaptionLayout,
      // 拖动状态机在 floating-surface 里，测试直接驱动它，避免复制一套拖动逻辑。
      dragState: {
        set: setFloatingDragState,
        update: updateFloatingDragPosition,
        finish: finishFloatingDrag,
      },
    });
  }

  if (!isSmokeTest) {
    startVisibilityPolling();
  }

  // 024 文字自驱动：真实 renderer composer 注入 → 任务链 → 零 TTS 证据。
  if (process.env.HEMI_SELF_RUN_TEXT) {
    const { runTextSelfRun } = await import('./self-run-text-input.mjs');
    await runTextSelfRun({ mainWindow: state.mainWindow });
  }
  if (process.env.HEMI_SELF_RUN_TEXT_SCENARIOS) {
    const { runTextScenarios } = await import('./self-run-text-scenarios.mjs');
    await runTextScenarios({ mainWindow: state.mainWindow });
  }

  app.on('activate', async () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) {
      await createMainWindow();
    } else {
      showMainWindow();
    }
  });
});

// 冒烟测试里断言失败是抛异常：必须立刻退出，否则 Electron 会带着窗口挂着不返回，
// 跑 `npm run smoke` 的人只能干等超时。
process.on('unhandledRejection', (error) => {
  console.error('[hemi] unhandled rejection:', error);
  if (isSmokeTest) app.exit(1);
});

app.on('before-quit', () => {
  state.isQuitting = true;
  logSessionEnd();
  eventLoopMonitor?.stop();
  stopVisibilityPolling();
  stopGlobalPushToTalk();
  // 023 R-15：hub 与应用同生命周期——退出统一关桥（任务侧早已解耦）。
  void shutdownBrowserBridgeService();
  // 036：cua-driver 进程内运行时收尾（shutdown + 原生句柄释放）。
  void disposeCuaDriver();
  finishFloatingDrag(false);
  abortActiveTextModelTurn();
  disposeTaskManager();
  closeActiveTtsPlayback();
  void stopDuplexHost();
  void stopActiveAsrSession();
  // 047：导入操作只停止/回收浏览器（journal 已在各边界 durable，不依赖退出补写）。
  void getProviderImportService()?.disposeForQuit?.();
  // 049：退出时关闭 SSH 主连接（ssh -O exit；不留主连接进程，AC-03）。
  getRemoteService()?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
