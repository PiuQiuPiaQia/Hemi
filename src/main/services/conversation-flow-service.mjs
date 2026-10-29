/**
 * 057 会话流服务（S2）：每会话一个 ConversationController 的唯一注册表＋flow 快照
 * 写入器。flow.ipc（命令/快照/订阅桥）与 llm.ipc（真实 runtime 适配）共用同一份
 * 控制器——不出现第二个可写调度器（rollout：不维护两套「同步一下」的调度器）。
 *
 * 初始化顺序：index.mjs 先 initConversationFlowService（目录/广播）；llm.ipc 注册时
 * setRuntimeFactory 挂真实适配；在此之前创建的控制器用不可执行占位（命令如实
 * unsupported）。控制器懒建（首次命令/快照请求），Pi 会话驻留与控制器存续解耦。
 */
import { createConversationController } from './conversation-controller.mjs';
import {createConversationOperationJournal} from './conversation-operation-journal.mjs';
import { createFlowStore } from './flow-store.mjs';
import { bootstrapFlowFromTurns, restoreFlowSnapshot } from './flow-bootstrap.mjs';
import { newSettledRuns, conversationStatus, withConversationUnread } from '../../shared/conversation-status.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { recoverConversationFlow } from './conversation-recovery.mjs';
import { repairConversationFlowHistory } from './conversation-migration.mjs';

let instance = null;

export function initConversationFlowService({ dir, broadcast = null, onUnreadChanged = null, log = null, runtimeFactory: initialFactory = null, workspaceOf = () => null } = {}) {
  if (instance) return instance;
  const store = createFlowStore({ dir, log });
  const controllers = new Map();
  const statusReaders = new Map();
  let runtimeFactory = typeof initialFactory === 'function' ? initialFactory : null;

  instance = {
    store,
    operations:createConversationOperationJournal({dir:path.join(dir,'..','conversation-operations')}),
    submitChat:null,

    /** llm.ipc 注册真实 runtime 适配工厂（先于首个控制器创建）。 */
    setRuntimeFactory(factory) {
      runtimeFactory = typeof factory === 'function' ? factory : null;
    },

    controllerFor(conversationId) {
      const key = String(conversationId ?? '');
      if (!key) throw new Error('缺少 conversationId');
      let controller = controllers.get(key);
      if (!controller) {
        const runtime = runtimeFactory
          ? runtimeFactory(key)
          : {
            async start() { throw unsupportedRuntime(); },
            async stop() { return { ok: true }; },
          };
        controller = createConversationController({
          conversationId: key,
          effects: {
            runtime,
            store: {
              update: (id) => {
                let unreadChanged = false;
                let completion = null;
                return store.update(id, record => {
                  const snapshot = controller.getSnapshot();
                  const next = withConversationUnread(record, snapshot);
                  unreadChanged = next.unreadAt !== record.unreadAt;
                  if (unreadChanged) completion = completedRunInfo(record, snapshot);
                  return next;
                }).then(() => {
                  if (!unreadChanged) return;
                  try { onUnreadChanged?.(id, completion); }
                  catch (error) { log?.warn?.(`未读广播失败（${id}）：${error?.message ?? error}`); }
                });
              },
              flush: (id) => store.flush(id),
            },
          },
        });
        // 旧会话引导：原始档案直读（保留 kind/taskSnap 等迁移字段，不经 sanitize）——
        // 持久 flow 优先（遗留运行按中断恢复）；否则从 turns 现场投影。
        try {
          let record = store.readRecord(key);
          if (record?.flow && typeof record.flow.revision === 'number' && (record.flow.schemaVersion ?? 1) <= 1) {
            // 控制器尚未发布、尚无在途执行时统一历史；之后所有读写只沿一份 flow。
            const repaired = repairConversationFlowHistory(dir, record);
            record = repaired.record;
            if (repaired.changed) log?.info?.(`flow 历史迁移（${key}）：补齐 ${repaired.missingInputIds.length} 个输入身份，源记录备份 ${path.basename(repaired.backup)}`);
            const recovered = recoverConversationFlow(restoreFlowSnapshot(record.flow), {
              workspaceDir: workspaceOf(record.workspaceId)?.dir ?? null,
              readTaskRecord: id => {
                if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
                try { return JSON.parse(fs.readFileSync(path.join(dir, '..', 'task-history', `${id}.json`), 'utf8')); }
                catch { return null; }
              },
            });
            controller.restore(recovered.snapshot);
            // 恢复修复不是新结果：不增加未读、不变更排序时间、不重跑模型。
            if (recovered.changed || JSON.stringify(record.flow) !== JSON.stringify(recovered.snapshot)) void store.saveFlow(key, recovered.snapshot).catch(error => log?.warn?.(`flow 恢复写入失败：${error.message}`));
          } else if (record?.turns?.length) {
            const bootstrapped = bootstrapFlowFromTurns(record.turns, { conversationId: key });
            if (bootstrapped) controller.restore(bootstrapped);
          }
        } catch (error) {
          log?.warn?.(`flow 恢复失败（${key}）：${error?.message ?? error}`);
          // 备份／迁移失败不能以空时间线接收新任务，避免覆盖尚未保全的历史。
          throw error;
        }
        // 恢复的后台快照只是历史；收到本进程的新任务事实后才算仍在工作。
        const restoredTasks = new WeakSet(Object.values(controller.getSnapshot().tasks ?? {}).filter(task => task && typeof task === 'object'));
        const readStatus = () => conversationStatus(controller.getSnapshot(), {
          live: true, isTaskLive: task => !restoredTasks.has(task),
        });
        statusReaders.set(key, readStatus);
        controller.subscribe((change) => {
          try {
            broadcast?.(key, { ...change, conversationStatus: readStatus() });
          } catch (error) {
            log?.warn?.(`flow:changed 广播失败（${key}）：${error?.message ?? error}`);
          }
        });
        controllers.set(key, controller);
      }
      return controller;
    },

    has(conversationId) {
      return controllers.has(String(conversationId ?? ''));
    },

    /** 侧栏只读查询；没有驻留控制器时留给持久档案投影，不因列表读取启动恢复。 */
    getStatus(conversationId) {
      return statusReaders.get(String(conversationId ?? ''))?.();
    },

    /** 会话删除/淘汰：控制器收口＋写链排空（迟到写入不复活）。 */
    async drop(conversationId) {
      const key = String(conversationId ?? '');
      const controller = controllers.get(key);
      if (!controller) return;
      await controller.close().catch(() => {});
      await store.drop(key).catch(() => {});
      controllers.delete(key);
      statusReaders.delete(key);
    },

    async dropAll() {
      for (const key of [...controllers.keys()]) await this.drop(key);
    },
  };
  return instance;
}

export function getConversationFlowService() {
  if (!instance) throw new Error('conversation-flow 服务未初始化（先 initConversationFlowService）');
  return instance;
}

/** 测试专用：单例复位（生产进程内服务永不重建）。 */
export function __resetConversationFlowServiceForTests() {
  instance = null;
}

function unsupportedRuntime() {
  const error = new Error('flow runtime 未接线：命令受理但不可执行');
  error.code = 'unsupported';
  return error;
}

/**
 * 新收口主回合的通知素材（与未读同一口径）：取最近一次结果与它的输入摘要。
 * 输入文本来自 flow 时间线的用户项——队列派发/事件回合可能没有用户项，正文就只留结果口径。
 */
function completedRunInfo(record, snapshot) {
  const fresh = newSettledRuns(record, snapshot);
  if (!fresh.length) return null;
  const run = fresh[fresh.length - 1];
  const inputId = Array.isArray(run.inputIds) ? run.inputIds[0] : null;
  const input = inputId
    ? (snapshot.timeline ?? []).findLast?.(item => item.kind === 'user' && item.id === inputId) ?? null
    : null;
  return {
    outcome: run.outcome ?? null,
    source: run.source ?? null,
    preview: typeof input?.text === 'string' ? input.text : '',
  };
}
