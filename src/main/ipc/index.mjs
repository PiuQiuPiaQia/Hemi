import { setAuxiliaryTransportObserver } from '../agent-runtime/auxiliary-transport.mjs';
import { registerAppIpc } from './app.ipc.mjs';
import { registerAppearanceIpc } from './appearance.ipc.mjs';
import { registerAsrIpc } from './asr.ipc.mjs';
import { registerAudioIpc } from './audio.ipc.mjs';
import { registerComposerIpc } from './composer.ipc.mjs';
import { registerContextIpc } from './context.ipc.mjs';
import { registerConversationIpc } from './conversation.ipc.mjs';
import { registerExecutorIpc } from './executor.ipc.mjs';
import { registerFloatingIpc } from './floating.ipc.mjs';
import { registerFlowIpc } from './flow.ipc.mjs';
import { initConversationFlowService } from '../services/conversation-flow-service.mjs';
import { createTurnNotifier } from '../services/turn-notifier.mjs';
import { notifyViaAppleScript } from '../services/system-notification.mjs';
import { showMainWindow } from '../windows/main-window.mjs';
import { app, BrowserWindow, dialog, Notification } from 'electron';
import { initializeRuntimeStorage, acknowledgeLegacyBranch, runtimeDataDir } from '../agent-runtime/storage-migration.mjs';
import {resolveCapabilities} from '../agent-runtime/index.mjs';
import { findInstalledApplication } from '../services/installed-apps.mjs';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import { state, isSmokeTest, BRAND_NAME } from '../state.mjs';
import { registerLlmIpc } from './llm.ipc.mjs';
import { registerMemoryIpc } from './memory.ipc.mjs';
import { registerOnboardingIpc } from './onboarding.ipc.mjs';
import { registerPermissionsIpc } from './permissions.ipc.mjs';
import { registerPlatformIpc } from './platform.ipc.mjs';
import { registerProviderImportIpc } from './provider-import.ipc.mjs';
import { registerSystemIpc } from './system.ipc.mjs';
import { registerTaskIpc } from './task.ipc.mjs';
import { registerAccessIpc } from './access.ipc.mjs';
import { registerTtsIpc } from './tts.ipc.mjs';
import { registerUiIpc } from './ui.ipc.mjs';
import { registerUpdaterIpc } from './updater.ipc.mjs';
import { registerWorkflowIpc } from './workflow.ipc.mjs';
import { setWorkflowFlowRouter, getAgentRuntime } from './llm.ipc.mjs';
import { getBrowserBridgeService } from '../services/browser-bridge-service.mjs';
import { browserBridgeStatePathFor } from '../agent/permission-state.mjs';
import { getInteractiveResourceCoordinator } from '../workflows/interactive-resource-coordinator.mjs';
import { initWorkflowService } from '../workflows/workflow-service.mjs';
import { getConversationFlowService } from '../services/conversation-flow-service.mjs';
import { getProfiles } from '../lib/profiles-holder.mjs';
import { freezeWorkflowModel } from '../workflows/workflow-model-plan.mjs';
import { loadRoles } from '../agent/agent-roles.mjs';
import { ensureConversationArchive, getConversationMetadata, getConversationTaskHistory } from './conversation.ipc.mjs';
import { createLogger } from '../lib/logger.mjs';
import { registerWorkspaceIpc, getWorkspaceService } from './workspace.ipc.mjs';
import { registerSkillsIpc, getSkillService } from './skills.ipc.mjs';

export async function registerAllIpcHandlers() {
  await registerAppearanceIpc();
  // 在任何目录实例创建前原子激活；旧版本分叉只能由用户明确选择。
  const storage = await initializeRuntimeStorage({ userDataDir: app.getPath('userData') });
  if (storage.conflict) {
    const { response } = await dialog.showMessageBox({ type: 'warning', title: '检测到旧版本数据变化', message: '旧版本在升级后修改了会话或模型配置。', detail: '继续使用新版会保留两份数据，不会自动合并；旧文件仍可供恢复。', buttons: ['退出', '继续使用新版数据'], defaultId: 0, cancelId: 0 });
    if (response !== 1) { app.quit(); throw new Error('用户未选择继续新版数据'); }
    await acknowledgeLegacyBranch({ userDataDir: app.getPath('userData'), sourceStats: storage.sourceStats });
  }
  setAuxiliaryTransportObserver(spec => getAgentRuntime().observeTransport(spec));
  registerSystemIpc();
  registerAsrIpc();
  registerAudioIpc();
  registerPermissionsIpc();
  // 043：平台能力快照（先注册，随后 permissions/ui 等都从同一实例投影）。
  registerPlatformIpc();
  // 042：应用级授权管理面（access-grants.json 事实源）。
  registerAccessIpc();
  // 033：工作区登记先于 task/conversation 注册（两者运行期共享同一实例）。
  registerWorkspaceIpc();
  registerSkillsIpc();
  registerContextIpc();
  registerComposerIpc();
  registerMemoryIpc();
  // 057：对话流服务（单注册表）先建，llm.ipc 注册时挂真实 runtime 适配。
  // 任务完成通知（2026-10-21）：用户不在主窗口前时，收口结果发一条系统横幅；
  // 点击回到应用。冒烟/自驱动实例不弹真实通知（自动化不该打扰桌面）。
  const turnNotifier = createTurnNotifier({
    getWindow: () => state.mainWindow,
    showWindow: () => showMainWindow(),
    brandName: BRAND_NAME,
    enabled: !isSmokeTest && Notification.isSupported(),
    log: createLogger('notify'),
    showNotification: ({ title, body, onClick }) => {
      const notification = new Notification({ title, body });
      notification.on('click', onClick);
      // macOS 未打包实例/未授通知权限时不显示横幅（实测 UNErrorDomain 1）：记日志并让
      // dock 图标弹跳；开发态再补一条 AppleScript 通知，否则 dev 里根本验证不了这个功能。
      notification.on('failed', (_event, error) => {
        const notifyLog = createLogger('notify');
        notifyLog.warn(`系统通知未能显示：${error?.message ?? error ?? '未知原因'}`);
        if (process.platform === 'darwin') {
          app.dock?.bounce?.('informational');
          if (!app.isPackaged) void notifyViaAppleScript({ title, body, log: notifyLog });
        }
      });
      notification.show();
    },
  });
  initConversationFlowService({
    dir: path.join(runtimeDataDir(app.getPath('userData')), 'conversations'),
    log: createLogger('flow'),
    workspaceOf: id => getWorkspaceService()?.resolve(id ?? 'default'),
    onUnreadChanged: (id, completion) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.conversation.changed, { kind: 'unread', id });
      }
      if (!completion) return;
      turnNotifier.notifyCompletion({
        conversationId: id,
        conversationTitle: getConversationMetadata(id)?.title ?? null,
        ...completion,
      });
    },
    broadcast: (conversationId, change) => {
      if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
      state.mainWindow.webContents.send(IPC.flow.changed, { conversationId, change });
    },
  });
  registerLlmIpc();
  // 工作流只组装业务生命周期；节点执行复用对话运行时的模型、门控与角色能力。
  const workflowLog = createLogger('workflow');
  const userDataDir = app.getPath('userData');
  const currentSelection = async ({conversationId, entryMode} = {}) => {
    const directory = await getProfiles().list();
    const key = entryMode === 'chat' ? getConversationMetadata(conversationId)?.profileId ?? directory.defaultModelId : directory.defaultModelId;
    return key === 'auto' ? {mode: 'auto'} : {mode: 'fixed', modelKey: key};
  };
  const resolvePlan = selection => freezeWorkflowModel({selection, store: getProfiles(), roles: loadRoles()});
  const service = initWorkflowService({
    dir: path.join(runtimeDataDir(userDataDir), 'workflows'), conversationFlowService: getConversationFlowService(), log: workflowLog,
    skillService: getSkillService(), interactiveCoordinator:getInteractiveResourceCoordinator(), resolveCurrentModel: currentSelection, resolveExecutionPlan: resolvePlan,
    ensureConversation: async params => {
      if (getConversationMetadata(params.id)) return;
      const result = ensureConversationArchive({ ...params, workspaceId: params.workspaceId ?? 'default' });
      if (!result.ok) throw new Error(result.storageError ?? '无法创建关联对话');
    },
    resolveApplication: process.platform==='darwin'?findInstalledApplication:null,
    validateCapabilities: async document=>{
      if(!document?.nodes.some(node=>node.type==='hemi-browser'))return;
      const caps=await resolveCapabilities();if(!caps.browserOn)throw new Error('请先在设置中启用浏览器控制');
      const bridge=getBrowserBridgeService({statePath:browserBridgeStatePathFor(userDataDir),log:workflowLog});await bridge.start();if(!bridge.connected)throw new Error('浏览器扩展未连接，请连接后重新检查');
    },
    resolveWorkspace: conversationId => {
      const workspace = getWorkspaceService()?.resolve(getConversationMetadata(conversationId)?.workspaceId ?? 'default');
      if (!workspace || workspace.status !== 'ok') throw new Error(workspace?.message ?? '工作区不可用');
      return workspace;
    },
    browserBridgeFactory: ({taskId, taskLabel}) => getBrowserBridgeService({statePath: browserBridgeStatePathFor(userDataDir), log: workflowLog}).createClient({taskId, taskLabel}),
    openAgent: spec => getAgentRuntime().openWorkflowNode(spec),
    onWorkflowStopped: ({conversationId, workflowRunId}) => getAgentRuntime().completeConversation(conversationId, 'stopped', null, workflowRunId),

  });
  setWorkflowFlowRouter(service.flowRouter);
  registerWorkflowIpc();
  // 047：New API 站点登录导入（状态机/秘密在主进程协调器）。
  registerProviderImportIpc();
  registerOnboardingIpc();
  registerTtsIpc();
  registerAppIpc();
  // 044：应用内更新（未打包实例服务为只读 unsupported 状态面）。
  registerUpdaterIpc();
  registerUiIpc();
  registerFloatingIpc();
  registerTaskIpc();
  registerExecutorIpc();
  registerConversationIpc();
  registerFlowIpc();
}
