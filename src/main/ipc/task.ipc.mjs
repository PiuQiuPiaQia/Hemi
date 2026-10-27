import { runtimeDataDir } from '../agent-runtime/storage-migration.mjs';
import { ipcMain, app, shell } from 'electron';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createArtifactPreviewOpener, createArtifactPreviewReader, createDeliveryImageReader } from '../delivery/register.mjs';
import { createBrowserFileOpener } from '../delivery/browser-open.mjs';
import { createTaskHistory } from '../history/task-history.mjs';
import { readStoredConfig, resolveTextModelConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { fmtMs } from '../lib/perf.mjs';
import { syncExecutorProxy } from '../lib/shell-proxy.mjs';
import { setDriverTimingSink } from '../agent/gate/cua-client.mjs';
import { chatTurn } from '../services/text-model.mjs';
import { state } from '../state.mjs';
import { registerHistoryIpc } from './history.ipc.mjs';
import { getAgentRuntime, setAgentRuntimeDeps } from './llm.ipc.mjs';
import { broadcastUsageChanged, setConversationTaskHistory, setUsageTaskProvider, persistConversationTask } from './conversation.ipc.mjs';
import { getRemoteService } from '../remote/remote-service.mjs';

const log = createLogger('task');

/**
 * 056 · 任务面 IPC：子 agent 的任务卡快照与动作（停止/确认）、任务档案、交付读取、
 * 用量账本。子 agent 的运行时在 agent-runtime（经 llm.ipc 的 getAgentRuntime 取）；
 * 主 agent 的确认卡也经同一快照（agentPermissions）下发。
 */
let manager = null;
/** 028 引用读取：登记文件同步读文本（512KiB 预算内；超限标注截断）。 */
function readReferenceFileText(filePath) {
  try {
    const buffer = readFileSync(filePath);
    const text = buffer.subarray(0, 512 * 1024).toString('utf8');
    return buffer.length > 512 * 1024 ? `${text}\n（文件超出读取上限，仅保留前段内容）` : text;
  } catch (error) {
    return `（文件读取失败：${error.message}）`;
  }
}

/** 快照广播到各窗口：主窗口任务卡、悬浮字幕行、悬浮任务菜单共用同一状态源。 */
function broadcast(snapshot) {
  for (const task of snapshot?.tasks ?? []) persistConversationTask(task);
  const windows = [
    state.mainWindow,
    state.floatingWindow,
    state.floatingCaptionWindow,
    state.taskPopoverWindow,
  ];
  const recipients = windows.filter((window) => window && !window.isDestroyed());
  log.debug(
    `状态广播转发 v${snapshot?.stateSeq ?? '?'}：${recipients.length} 个窗口，任务 ${(snapshot?.tasks ?? [])
      .map((task) => `${task.key ?? '?'}=${task.phase}`)
      .join(',') || 'idle'}`,
  );
  for (const window of recipients) {
    window.webContents.send(IPC.task.state, snapshot);
  }
}

function handleAction(payload) {
  const action = String(payload?.action || '');
  const taskKey = payload?.taskId ? String(payload.taskId) : (payload?.taskKey ? String(payload.taskKey) : null);
  switch (action) {
    case 'stop':
      return manager.stop(taskKey);
    case 'decide': {
      const choice = payload?.choice;
      if (!['task', 'persistent', 'once', 'deny'].includes(choice)) {
        return { ok: false, errorCode: 'INVALID_CHOICE' };
      }
      return manager.decide(choice, { taskKey });
    }
    default:
      // 056：重试总结/检查结果/重新发起随回炉与只读核实一起退役——要重做就让主 agent 再派。
      log.warn(`未知或已退役的任务动作：${action}`);
      return { ok: false, errorCode: 'UNSUPPORTED_ACTION' };
  }
}

export function registerTaskIpc() {
  // 2026-09-26：启动即按存储配置落一次执行器代理 env（开关打开且能读到系统
  // 代理才注入；bash 子进程 spawn 时继承，见 shell-proxy.mjs）。
  void readStoredConfig()
    .then((stored) => stored.executorProxyEnabled === true && syncExecutorProxy(true, { log }))
    .catch(() => {});

  // 009：任务档案（每任务一个 JSON 文件，userData/task-history/）。
  const historyStore = createTaskHistory({
    dir: path.join(runtimeDataDir(app.getPath('userData')), 'task-history'),
    log,
  });

  // 埋点：cua-driver 调用耗时 → hemi.log（perf 域）。036 起原语清零，
  // 全部走驱动（含旧 agent-desktop 路径此前缺失的埋点）。
  const perfLog = createLogger('perf');
  setDriverTimingSink(({ command, ms, ok }) => {
    if (!ok) perfLog.warn(`视觉原语失败：${command} ${fmtMs(ms)}`);
    else if (ms >= 1000) perfLog.info(`视觉原语慢：${command} ${fmtMs(ms)}`);
    else perfLog.debug(`视觉原语 ${command} ${fmtMs(ms)}`);
  });

  /**
   * 025：交付通道的只读图片读取器（渲染层报告视图用）。与 task-manager 内部的
   * 登记器各建各的——这边只读档案，不发放产物 ID；档案是两边的一致性锚点。
   * 026：另挂文件预览读取器（Markdown/纯文本/图片），同一档案寻址纪律；
   * 027：再挂路径点击的受控浏览器打开器（默认浏览器解析见 browser-open.mjs）。
   */
  // 049 R-11：远端产物的读取通道（预览/图片）——经 SSH 流式读，不落本机同名路径。
  const remoteIo = {
    read: async ({ host, filePath }) => {
      const remoteService = getRemoteService();
      if (!remoteService) return null;
      const rfs = remoteService.remoteFsFor({ host, dir: path.posix.dirname(String(filePath)) });
      const info = await rfs.stat(String(filePath));
      if (!info.ok || !info.isFile) return null;
      const read = await rfs.readBytes(String(filePath), 8 * 1024 * 1024);
      return read.ok ? read.buf : null;
    },
  };
  const deliveryReader = {
    ...createDeliveryImageReader({ history: historyStore, remoteIo }),
    ...createArtifactPreviewReader({ history: historyStore, remoteIo }),
    ...createArtifactPreviewOpener({
      history: historyStore,
      openInBrowser: createBrowserFileOpener({
        openExternal: (url) => shell.openExternal(url),
        openPath: (filePath) => shell.openPath(filePath),
        log,
      }),
    }),
  };

  /** 017：遗留档案错挂修复的「找真身」——唯一同文本且创建时间贴近的记录。 */
  function findRecordCandidate({ text, createdAt, exclude = [] }) {
    const wanted = String(text ?? '').trim();
    if (!wanted) return null;
    const { tasks } = historyStore.listTasks();
    const hits = tasks.filter(
      (view) =>
        !view.corrupt
        && !exclude.includes(view.taskId)
        && view.taskText === wanted
        && Math.abs((view.createdAt ?? 0) - (createdAt ?? 0)) <= 5000,
    );
    return hits.length === 1 ? hits[0].taskId : null;
  }

  // 056：运行时依赖注入（档案、快照广播、用量、提炼、@ 引用读取）后取子 agent 管理器。
  setAgentRuntimeDeps({
    history: historyStore,
    onTaskState: broadcast,
    onModelUsage: (task) => {
      if (task?.conversationId) broadcastUsageChanged(task.conversationId);
    },
    readArtifact: (taskId, artifactId) => readArtifactReference(taskId, artifactId),
  });
  manager = getAgentRuntime().subagents;

  // 028 @ 引用：按身份读取任务成果文件（025/027 登记档案；未登记/非文件一律拒绝）。
  async function readArtifactReference(taskId, artifactId) {
      try {
        const record = historyStore.getRecord(String(taskId ?? ''));
        if (!record || record.corrupt) return { ok: false, message: '任务档案不存在' };
        const artifact = (record.deliverables ?? []).find((item) => item?.id === String(artifactId));
        if (!artifact || artifact.kind !== 'file' || !artifact.path) {
          return { ok: false, message: '没有这个文件成果' };
        }
        // 049：远端产物经 SSH 读引用文本（本地同名路径是另一台机器的，不碰）。
        if (artifact.host) {
          const remoteService = getRemoteService();
          if (!remoteService) return { ok: false, message: '远端服务不可用，稍后重试' };
          const rfs = remoteService.remoteFsFor({ host: artifact.host, dir: path.posix.dirname(artifact.path) });
          const info = await rfs.stat(artifact.path);
          if (!info.ok || !info.isFile) return { ok: false, message: info.kind === 'conn' ? `连不上 ${artifact.host}，稍后重试` : '文件在服务器上已不在' };
          const read = await rfs.readBytes(artifact.path, 512 * 1024);
          if (!read.ok) return { ok: false, message: '读取失败，可重试' };
          return { ok: true, name: artifact.name, scope: `登记文件（${artifact.host}）`, text: read.buf.toString('utf8').slice(0, 512 * 1024) };
        }
        return { ok: true, name: artifact.name, scope: '登记文件', text: readReferenceFileText(artifact.path) };
      } catch (error) {
        return { ok: false, message: `读取失败：${error.message}` };
      }
  }
  // 018：会话存档修复拿档案查询。
  setConversationTaskHistory({
    getRecord: (taskId) => historyStore.getRecord(taskId),
    findRecordCandidate,
    listByConversation: (conversationId) => historyStore.listTasks().tasks
      .filter((view) => !view.corrupt && view.conversationId === conversationId)
      .map((view) => historyStore.getRecord(view.taskId)),
  });
  // 048 D7：任务执行用量提供方——终态任务的档案聚合（usageByModel）＋
  // 在途任务（manager 内存聚合），getLedger 合并成 source='task' 行。
  setUsageTaskProvider((conversationId) => {
    const rows = [];
    const { tasks: views } = historyStore.listTasks();
    for (const view of views) {
      if (view?.corrupt || view.conversationId !== conversationId) continue;
      const record = historyStore.getRecord(view.taskId);
      for (const [modelId, bucket] of Object.entries(record?.usageByModel ?? {})) {
        rows.push({
          source: 'task',
          modelKey: bucket.modelKey ?? modelId,
          modelName: bucket.modelName ?? '',
          input: bucket.input ?? 0,
          output: bucket.output ?? 0,
          cacheRead: bucket.cacheRead ?? 0,
          cacheWrite: bucket.cacheWrite ?? 0,
          genMs: bucket.genMs ?? 0,
          at: record.updatedAt ?? 0,
          calls: bucket.calls ?? 0,
          missing: bucket.missing ?? 0,
          taskId: view.taskId,
        });
      }
    }
    return [...rows, ...manager.usageByConversation(conversationId)];
  });
  // 009：历史通道 + 启动恢复扫描（补标中断，不续跑；损坏/裁剪在存储层处理）。
  // 025：交付图片读取器一并接入（保存/阅读共用档案寻址）；026 预览同源。
  registerHistoryIpc({ history: historyStore, delivery: deliveryReader });
  try {
    historyStore.recoverOnBoot();
  } catch (error) {
    log.warn(`任务历史恢复扫描失败：${error.message}`);
  }

  ipcMain.handle(IPC.task.getState, () => manager.snapshot());
  ipcMain.handle(IPC.task.action, (_event, payload) => handleAction(payload));
  // 056：中断任务的「继续执行」随旧任务模型退役（要接着做就让主 agent 再派）。
  ipcMain.handle(IPC.task.resume, () => ({ ok: false, message: '这个任务已结束；需要继续的话直接在对话里说，Hemi 会接着做' }));

  // 042：三档模式与白名单通道退役（用户裁决：旧规则升级即作废，不迁移）。
  // permission-state.json 原样留在磁盘仅作诊断；新事实源＝access-grants.json
  // （permission-instance 单例，经 access.ipc 暴露）。
}

/** before-quit 收尾：子 agent 随运行时一起收（llm.ipc abortActiveTextModelTurn）；保留入口给自驱动脚本。 */
export function disposeTaskManager() {
  manager?.disposeAll();
}
