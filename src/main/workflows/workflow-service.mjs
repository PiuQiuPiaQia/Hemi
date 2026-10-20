/**
 * 059 工作流服务（S3b）：主进程装配单例——定义存储＋调用存储＋runner＋flow 分派器。
 *
 * 职责（契约 §5）：入口方法（prepare／updatePreparation／startPrepared／stop）与查询；
 * startPrepared 幂等受理后把 workflow-start 结构化输入送进 057 受理（commandSend），
 * 占运行槽、忙时排队都由 controller 既有契约承担；flow 分派器（setWorkflowFlowRouter）
 * 在运行槽内推进 runner，卡片事实回 flow。渲染层只经 IPC 读投影，不碰 store。
 *
 */
import path from "node:path";
import { PENDING_CAPACITY } from "../../shared/conversation-flow.mjs";
import { resolveParameterDefaults } from "../../shared/workflow-parameter-defaults.mjs";
import { verifyWorkflowArtifact } from "./workflow-artifacts.mjs";
import crypto from "node:crypto";

import {
  createNodeAgentExecutor,
  parseNodeOutputs,
} from "../agent/workflow-node-agent.mjs";
import { createDefinitionStore } from "./definition-store.mjs";
import {
  createInvocationStore,
  workflowError,
  INVOCATION_ERRORS,
} from "./invocation-store.mjs";
import { createWorkflowRunner } from "./workflow-runner.mjs";
import { createWorkflowFlowRouter } from "./flow-router.mjs";
import {
  validateExtraction,
} from "./preparation-service.mjs";
import { acquireSkillLease } from "./skill-executor.mjs";
import {
  acquireBrowserLease,
  acquireDesktopLease,
  resolveBrowserTarget,
} from "./browser-desktop-executor.mjs";
import { createHumanInputExecutor } from "./human-input-executor.mjs";
import { createInteractiveResourceCoordinator } from "./interactive-resource-coordinator.mjs";
import { validateWorkflowDocument } from "../../shared/workflow.mjs";

let instance = null;

export function initWorkflowService({
  dir,
  openAgent,
  conversationFlowService,
  skillService = null,
  browserBridgeFactory = null,
  onWorkflowCompleted = null,
  onWorkflowStopped = null,
  resolveCurrentModel = null,
  resolveExecutionPlan = null,
  ensureConversation = null,
  resolveWorkspace = null,
  resolveApplication = null,
  validateCapabilities = null,
  interactiveCoordinator = createInteractiveResourceCoordinator({}),
  log = null,
}) {
  if (instance) return instance;
  const definitionStore = createDefinitionStore({ dir, log });
  const invocationStore = createInvocationStore({ dir });
  const runSkills = new Map();
  const waiting = new Map(),
    resumeCaches = new Map();
  const resumeDispatches = new Map();
  /** 人工输入等待期限定时器：`${invocationId}:${interactionId}` → timer（重启按持久期限重裁）。 */
  const interactionTimers = new Map();
  /** GUI 交互租约（S5）：同主机桌面／共享浏览器互斥，节点边界获取、结束释放。 */
  const guiLease = async (executionOwner, signal) => {
    const cancel = () =>
      interactiveCoordinator.cancelWait(
        "interactive:local",
        executionOwner.workflowRunId,
      );
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await interactiveCoordinator.acquire(
        "interactive:local",
        executionOwner.workflowRunId,
        { timeoutMs: 10 * 60 * 1000 },
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
  /** Skill 节点：引用校验＋受控租约，再交共享节点 worker（openAgent 收 skills 参数）。 */
  const skillWorkerOpenAgent = async (spec) => {
    const { nodeSpec, executionOwner, signal } = spec;
    const frozen = spec.invocation?.run?.skillSnapshot;
    const lease = frozen
      ? {
          items: frozen.filter((item) =>
            (nodeSpec.nodeData?.skillRefs ?? []).some(
              (ref) => ref.name === item.name,
            ),
          ),
          release: () => {},
        }
      : acquireSkillLease({ refs: nodeSpec.nodeData?.skillRefs, skillService });
    try {
      const inner = await openAgent({ ...spec, skills: lease.items });
      return {
        agent: inner.agent,
        release: async () => {
          try {
            await inner.release?.();
          } finally {
            lease.release();
          }
        },
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  };
  /** 浏览器节点：目标解析＋扩展桥可用性校验，再交共享 worker（openAgent 收 bridge client）。 */
  const browserWorkerOpenAgent = async (spec) => {
    const { nodeSpec, executionOwner, inputs, signal } = spec;
    const lease = acquireBrowserLease({
      nodeData: nodeSpec.nodeData,
      inputs,
      browserBridgeFactory,
      accessId: `wf-${executionOwner.workflowRunId}`,
    });
    let gui;
    try {
      await spec.onResourceWait?.(
        Boolean(interactiveCoordinator.snapshot("interactive:local").holder),
      );
      gui = await guiLease(executionOwner, signal);
      await spec.onResourceWait?.(false);
      const inner = await openAgent({
        ...spec,
        bridge: lease.client,
        bridgeUrl: lease.url,
      });
      return {
        agent: inner.agent,
        release: async () => {
          try {
            await inner.release?.();
          } finally {
            gui?.release();
            lease.release();
          }
        },
      };
    } catch (error) {
      gui?.release();
      lease.release();
      throw error;
    }
  };
  /** 桌面节点：应用身份校验＋GUI 租约（桌面焦点互斥，S5），再交共享 worker。 */
  const desktopWorkerOpenAgent = async (spec) => {
    const { nodeSpec, executionOwner, signal } = spec;
    const lease = acquireDesktopLease({ nodeData: nodeSpec.nodeData });
    let gui;
    try {
      await spec.onResourceWait?.(
        Boolean(interactiveCoordinator.snapshot("interactive:local").holder),
      );
      gui = await guiLease(executionOwner, signal);
      await spec.onResourceWait?.(false);
      const inner = await openAgent({
        ...spec,
        applicationRef: lease.applicationRef,
      });
      return {
        agent: inner.agent,
        release: async () => {
          try {
            await inner.release?.();
          } finally {
            gui?.release();
            lease.release();
          }
        },
      };
    } catch (error) {
      gui?.release();
      lease.release();
      throw error;
    }
  };
  // 文件交付必须可读，不能将模型输出的路径文本当成交付事实（runner 交付核查与
  // 人工输入上游复核共用同一核查器）。
  const runnerVerifyArtifact = async (value, { invocationId, signal }) => {
    const invocation = await invocationStore.get(invocationId);
    return verifyWorkflowArtifact(value, {
      workspace: invocation?.run?.workspace,
      controlRoot: path.dirname(dir),
      signal,
    });
  };
  const runner = createWorkflowRunner({
    invocationStore,
    executors: {
      // ctx.workflowRunId/invocationId 由 runner 包装层注入（owner 归属）。
      // 四类任务节点共用同一节点 worker（运行接线 §6）；差异只在各 executor 的
      // 依赖校验（Skill 引用／浏览器桥＋URL／应用身份）与会话装配参数。
      "hemi-agent": createNodeAgentExecutor({ openAgent, log }),
      "hemi-skill": createNodeAgentExecutor({
        openAgent: skillWorkerOpenAgent,
        log,
      }),
      "hemi-browser": createNodeAgentExecutor({
        openAgent: browserWorkerOpenAgent,
        log,
      }),
      "hemi-desktop": createNodeAgentExecutor({
        openAgent: desktopWorkerOpenAgent,
        log,
      }),
      // 人工输入（HI 通用节点）：到达即准备挂起，抛 code=human-input 交 runner 持久化；
      // 挂起期间零模型／工具／桌面资源。
      "hemi-human-input": createHumanInputExecutor({
        verifyArtifact: runnerVerifyArtifact,
        log,
      }),
    },
    verifyArtifact: runnerVerifyArtifact,
    log,
  });
  async function withdrawInvocation({ invocationId }) {
    const inv = await invocationStore.get(invocationId);
    if (!inv?.run || inv.run.status === "stopped") return;
    // 撤销已排队但未派发的续跑输入时，挂起中的人工输入一并停止。
    if (inv.run.status === "waiting" && inv.run.waiting?.kind === "human-input") {
      await stopWaitingHumanInput(inv, "withdraw");
      return;
    }
    if (inv.run.status !== "queued")
      throw workflowError("invalid-state", "工作流已派发，请停止当前运行");
    await invocationStore.updateRun(invocationId, {
      status: "stopped",
      finishedAt: Date.now(),
    });
    runSkills.get(invocationId)?.release();
    runSkills.delete(invocationId);
    if (inv.entryMode === "chat")
      await publishCard(await invocationStore.get(invocationId));
  }
  const flowRouter = createWorkflowFlowRouter({
    withdrawInvocation,
    stopInvocation: async ({ invocationId, workflowRunId, reason }) => {
      if (waiting.has(invocationId)) {
        waiting.get(invocationId)("stop");
        return { stopped: true };
      }
      return runner.stop(workflowRunId, { reason });
    },
    runInvocation: async ({ invocationId, onProgress }) => {
      try {
        let replayCache = resumeCaches.get(invocationId) ?? null;
        resumeCaches.delete(invocationId);
        // 入队后、执行前重启会丢失内存缓存；按已保存的响应与成功节点重建，避免重跑上游。
        if (!replayCache) {
          const current = await invocationStore.get(invocationId);
          if (current?.run?.status === "waiting" &&
              current.run.interactions?.[current.run.currentInteractionId]?.response)
            ({ replayCache } = await prepareReplayCache(current));
        }
        let outcome = await runner.run({
          invocationId,
          onProgress,
          replayCache,
        });
        // 人工输入挂起（HI 通用节点）：不进在槽等待循环——运行槽随 flow 运行闭合
        // 释放（HI-R02：长期业务等待不阻塞其他任务），提交／超时经 outbox 以新
        // 执行片段续跑（HI-R06：与普通输入同一 060 队列语义）。
        if (outcome.status === "waiting" && outcome.kind === "human-input") {
          const current = await invocationStore.get(invocationId);
          const interaction = interactionCardProjection(current);
          armInteractionTimer(current);
          onProgress?.({
            status: "waiting",
            patch: {
              currentNodeId: outcome.waitingNodeId,
              waitingReason: outcome.reason ?? "等待人工输入",
              interaction,
            },
          });
          return {
            status: "waiting",
            kind: "human-input",
            interactionId: outcome.interactionId,
            interaction,
            outputs: {},
            issues: [],
          };
        }
        while (outcome.status === "waiting") {
          const decision = await new Promise((resolve) => {
            waiting.set(invocationId, resolve);
            onProgress?.({
              status: "waiting",
              patch: {
                currentNodeId: outcome.waitingNodeId,
                waitingReason: outcome.reason,
                needsReview: outcome.needsReview,
              },
            });
          });
          waiting.delete(invocationId);
          if (decision === "stop") {
            await invocationStore.updateRun(invocationId, {
              status: "stopped",
              finishedAt: Date.now(),
            });
            outcome = { status: "stopped", outputs: {}, issues: [] };
            break;
          }
          outcome = await runner.run({
            invocationId,
            onProgress,
            replayCache: decision,
          });
        }
        // 完成事实跨回合注入（R-26「结果继续使用」）：产物路径通知对话主 agent，
        // 后续「把这份报告改成文字版」引用的是同一实际文件（同 hemi_subagent_result 机制）。
        if (typeof onWorkflowCompleted === "function") {
          try {
            const invocation = await invocationStore.get(invocationId);
            const { __summary, ...artifactOutputs } = outcome.outputs ?? {}; // __summary＝deliver 内部字段，不进对话
            await onWorkflowCompleted({
              invocationId,
              workflowId: invocation?.workflowId ?? null,
              conversationId: invocation?.conversationId ?? null,
              status: outcome.status,
              outputs: artifactOutputs,
              issues: outcome.issues ?? [],
            });
          } catch (error) {
            log?.warn?.(`[workflow] 完成通知失败：${error?.message ?? error}`);
          }
        }
        const invocation = await invocationStore.get(invocationId);
        const artifacts = [],
          fileOutputs = [];
        if (outcome.status === "completed")
          for (const node of invocation.documentSnapshot.nodes.filter(
            (n) => n.type === "hemi-deliver",
          )) {
            for (const [i, item] of (node.data.artifacts ?? []).entries()) {
              if (!["file", "files"].includes(item.binding.type)) continue;
              fileOutputs.push(item.label || `artifact_${i}`);
              const value = outcome.outputs?.[item.label || `artifact_${i}`];
              for (const file of Array.isArray(value) ? value : [value])
                if (typeof file === "string")
                  artifacts.push({
                    artifactId: `wf-${invocationId}-${artifacts.length}`,
                    kind: "file",
                    name: path.basename(file),
                    path: file,
                  });
            }
          }
        return {
          status: outcome.status,
          issues: outcome.issues,
          outputs: outcome.outputs,
          artifacts,
          fileOutputs,
        };
      } finally {
        runSkills.get(invocationId)?.release();
        runSkills.delete(invocationId);
      }
    },
    log,
  });

  async function loadPublishedDefinition({ workflowId, revision }) {
    const head = await definitionStore.getHead(workflowId);
    const wanted = revision ?? head?.revision ?? null;
    if (!wanted)
      throw workflowError("not-found", `工作流 ${workflowId} 没有已保存版本`);
    const record = await definitionStore.getRevision(workflowId, wanted);
    if (!record)
      throw workflowError(
        "not-found",
        `工作流 ${workflowId} 版本 ${wanted} 不存在`,
      );
    return record;
  }

  /** 去对话准备：冻结定义快照创建 invocation（collecting），列出输入 schema 与缺项。 */
  async function prepare({
    workflowId,
    revision = null,
    conversationId,
    entryMode = "chat",
    executionModel = null,
    profileId = null,
    workspaceId = null,
  }) {
    await startup;
    const record = await loadPublishedDefinition({ workflowId, revision });
    const validation = validateWorkflowDocument(record.document);
    if (!validation.valid) {
      throw workflowError(
        "invalid-graph",
        `定义 ${workflowId}@${record.revision} 未通过运行校验`,
      );
    }
    const inputNode = record.document.nodes.find(
      (n) => n.type === "hemi-input",
    );
    const parameters = inputNode?.data?.parameters ?? [];
    conversationId ||= `conv-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await ensureConversation?.({ id: conversationId, profileId, workspaceId });
    executionModel ??= await resolveCurrentModel?.({
      conversationId,
      entryMode,
    });
    let invocation = await invocationStore.createInvocation({
      workflowId,
      name: record.name,
      definitionRevision: record.revision,
      document: record.document,
      conversationId: conversationId ?? null,
      entryMode,
      executionModel,
    });
    const resolvedAt = Date.now(),
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const defaults = resolveParameterDefaults(parameters, {
      now: resolvedAt,
      timeZone,
    });
    const initial = validateExtraction({
      parameters,
      current: {},
      extracted: { set: defaults.values },
      now: resolvedAt,
      timeZone,
    });
    invocation = await invocationStore.applyPreparation(
      invocation.invocationId,
      {
        values: initial.values,
        issues: await preparationIssues(
          [...initial.issues, ...defaults.issues],
          executionModel,
          { documentSnapshot: record.document, conversationId },
          initial.values,
        ),
        sources: defaults.sources,
        resolvedAt,
      },
    );
    if (entryMode === "chat") await publishCard(invocation, record.name);
    return {
      invocationId: invocation.invocationId,
      cardId: invocation.cardId,
      draftRevision: invocation.draftRevision,
      workflow: { workflowId, revision: record.revision, name: record.name },
      parameters,
      conversationId,
      entryMode,
      executionModel,
      values: invocation.preparation.values,
      issues: invocation.preparation.issues,
      ready: invocation.preparation.ready,
    };
  }

  async function preparationIssues(issues, selection, invocation, values = {}) {
    const result = [...issues];
    if (validateCapabilities)
      try {
        await validateCapabilities(invocation?.documentSnapshot);
      } catch (error) {
        result.push({ code: "dependency-unavailable", message: error.message });
      }
    if (resolveExecutionPlan)
      try {
        await resolveExecutionPlan(selection);
      } catch (error) {
        result.push({ code: "model-unavailable", message: error.message });
      }
    let workspace;
    try {
      workspace = await resolveWorkspace?.(invocation?.conversationId);
      if (workspace?.host)
        result.push({
          code: "workspace-unavailable",
          message: "当前工作流只支持本机工作区，请选择本机工作区后重新准备。",
        });
    } catch (error) {
      result.push({ code: "workspace-unavailable", message: error.message });
    }
    for (const node of invocation?.documentSnapshot?.nodes ?? []) {
      try {
        if (node.type === "hemi-input")
          for (const param of node.data.parameters ?? []) {
            if (
              !["file", "files"].includes(param.type) ||
              values[param.key] == null
            )
              continue;
            const checked = await verifyWorkflowArtifact(values[param.key], {
              workspace,
              controlRoot: path.dirname(dir),
            });
            if (!checked.ok)
              result.push({
                code: "input-unavailable",
                field: param.key,
                message: `${param.label || param.key}：${checked.reason}`,
              });
          }
        if (node.type === "hemi-skill") {
          const lease = acquireSkillLease({
            refs: node.data.skillRefs,
            skillService,
          });
          lease.release();
        }
        if (node.type === "hemi-browser") {
          const binding = node.data.targetBinding;
          if (node.data.targetUrl || binding?.kind === "parameter") {
            if (binding?.kind === "parameter" && values[binding.key] == null)
              continue;
            const target = resolveBrowserTarget({
              nodeData: node.data,
              inputs: binding
                ? { [binding.as ?? binding.key]: values[binding.key] }
                : {},
            });
            if (!target.ok) throw new Error(target.reason);
          }
        }
        if (
          node.type === "hemi-desktop" &&
          resolveApplication &&
          !(await resolveApplication(node.data.applicationRef))
        )
          throw new Error(`目标应用不可用：${node.data.applicationRef}`);
      } catch (error) {
        result.push({
          code: "dependency-unavailable",
          nodeId: node.id,
          message: `${node.data.title || node.id}：${error.message}`,
        });
      }
    }
    return result;
  }

  async function publishCard(invocation, title = null) {
    if (!invocation) return; // 调用已被删除时，丢弃迟到的展示更新。
    const controller = conversationFlowService.controllerFor(
      invocation.conversationId,
    );
    if (!controller.applyFact) return;
    const card = {
      invocationId: invocation.invocationId,
      cardId: invocation.cardId,
      workflowId: invocation.workflowId,
      workflowRunId: invocation.startReceipt?.workflowRunId ?? null,
      conversationId: invocation.conversationId,
      title:
        title ??
        invocation.name ??
        "工作流",
      draftRevision: invocation.draftRevision,
      status:
        invocation.run?.status ??
        (invocation.preparation?.status === "abandoned"
          ? "abandoned"
          : "preparing"),
      ready: invocation.preparation.ready,
      values: invocation.preparation.values,
      issues: invocation.preparation.issues,
      executionModel: invocation.executionModel,
      waitingReason: invocation.run?.waiting?.reason,
      needsReview: Object.values(invocation.run?.nodes ?? {}).some(
        (node) => node.externalOutcomeUnknown,
      ),
      currentNodeId: invocation.run?.currentNodeId,
      nodes: invocation.run?.nodes,
      ...(interactionCardProjection(invocation)
        ? { interaction: interactionCardProjection(invocation) }
        : {}),
      totalCount: invocation.documentSnapshot.nodes.length,
      completedCount: Object.values(invocation.run?.nodes ?? {}).filter(
        (node) => ["succeeded", "skipped"].includes(node.status),
      ).length,
    };
    controller.applyFact({
      type: "workflow-card-upserted",
      card,
      at: Date.now(),
    });
    await conversationFlowService.store?.update(
      invocation.conversationId,
      (record) => ({ ...record, flow: controller.getSnapshot() }),
    );
  }

  async function updatePreparation({
    invocationId,
    expectedDraftRevision,
    values,
    executionModel,
    guard = null,
  }) {
    const current = await invocationStore.get(invocationId);
    if (!current) throw workflowError("not-found", "调用不存在");
    const parameters =
      current.documentSnapshot.nodes.find((n) => n.type === "hemi-input")?.data
        .parameters ?? [];
    const checked = validateExtraction({
      parameters,
      current: {},
      extracted: { set: values ?? current.preparation.values },
    });
    const selection =
      executionModel?.executionModel ??
      executionModel ??
      current.executionModel;
    const updated = await invocationStore.applyPreparation(invocationId, {
      guard,
      expectedDraftRevision,
      values: checked.values,
      issues: await preparationIssues(
        checked.issues,
        selection,
        current,
        checked.values,
      ),
      ...(executionModel ? { modelSelection: { executionModel: selection, source: "user" } } : {}),
    });
    if (updated.entryMode === "chat") await publishCard(updated);
    return updated;
  }

  function abandonPreparation({ conversationId, invocationId, expectedDraftRevision, guard = null }) {
    return invocationStore.abandon(invocationId, { expectedDraftRevision, guard }).then(async (inv) => {
      // Only the chat entry owns a visible preparation card. Cancelling the
      // direct-run parameter dialog must not publish an unsolicited message.
      if (inv.entryMode === "chat") await publishCard(inv);
      return inv;
    });
  }

  /** 主 agent 操作已存在的准备卡；不发现定义、不创建调用、不启动执行。 */
  async function managePreparation({ conversationId, owner, action, invocationId, expectedDraftRevision, set, unset, signal }) {
    await startup;
    const controller = conversationFlowService.controllerFor(conversationId);
    const guard = () => {
      signal?.throwIfAborted();
      const flow = controller.getSnapshot();
      const run = flow.runs[owner?.rootRunId];
      if (owner?.conversationId !== conversationId || owner?.generation !== flow.generation
        || flow.activeRunId !== owner?.rootRunId || !run || run.closedAt || run.stopRequested)
        throw new DOMException('主目标已停止或变更，不能操作准备卡', 'AbortError');
    };
    guard();
    const visible = new Set(controller.getSnapshot().timeline.flatMap(item => (item.parts ?? [])
      .filter(part => part.kind === 'workflow-card').map(part => part.invocationId)));
    const view = invocation => ({
      invocationId: invocation.invocationId, workflowId: invocation.workflowId, title: invocation.name,
      definitionRevision: invocation.definitionRevision, draftRevision: invocation.draftRevision,
      status: invocation.startReceipt ? 'started' : invocation.preparation.status,
      parameters: invocation.documentSnapshot.nodes.find(node => node.type === 'hemi-input')?.data.parameters ?? [],
      values: invocation.preparation.values, ready: invocation.preparation.ready, issues: invocation.preparation.issues,
      executionModel: invocation.executionModel,
      guidance: '只更新本次参数；可自动生成的内容由执行节点生成。执行仍需用户点击开始运行。',
    });
    if (action === 'list') {
      const invocations = await invocationStore.list({ conversationId });
      guard();
      return { preparations: invocations.filter(inv => visible.has(inv.invocationId) && inv.entryMode === 'chat'
        && !inv.startReceipt && inv.preparation.status !== 'abandoned').map(view) };
    }
    const invocation = await invocationStore.get(invocationId);
    guard();
    if (!invocation || invocation.conversationId !== conversationId || invocation.entryMode !== 'chat' || !visible.has(invocationId))
      throw workflowError('not-found', '本对话没有这张准备卡');
    if (action === 'get') return view(invocation);
    if (!['update', 'abandon'].includes(action)) throw workflowError('invalid-action', '不支持的准备卡操作');
    if (!Number.isSafeInteger(expectedDraftRevision) || expectedDraftRevision < 1)
      throw workflowError('revision-conflict', '修改准备卡必须提供读取到的参数版本');
    if (action === 'abandon') return view(await abandonPreparation({ conversationId, invocationId, expectedDraftRevision, guard }));
    const parameters = invocation.documentSnapshot.nodes.find(node => node.type === 'hemi-input')?.data.parameters ?? [];
    const checked = validateExtraction({ parameters, current: invocation.preparation.values, extracted: { set, unset } });
    if (checked.rejected.length) throw workflowError('invalid-parameter', `未声明的参数：${checked.rejected.join('、')}`);
    const invalid = checked.issues.filter(issue => issue.code === 'invalid-value');
    if (invalid.length) throw workflowError('invalid-value', invalid.map(issue => issue.message).join('；'));
    const updated = await updatePreparation({ invocationId, expectedDraftRevision, values: checked.values, guard });
    return view(updated);
  }

  /**
   * 卡片启动／直接运行共用：幂等受理 → workflow-start 输入进 057。
   * start 失败（stale-card/missing-inputs）保留数据如实报错；受理成功后 commandSend
   * 的队列语义由 controller 承担（忙时排队，不抢话）。chat 入口受理后解除补参绑定。
   */
  async function startPrepared({
    invocationId,
    cardId = null,
    expectedDraftRevision = null,
    requestId,
    conversationId,
    values = null,
    buildRun = null,
  }) {
    await startup;
    let invocation = await invocationStore.get(invocationId);
    if (!invocation)
      throw workflowError(
        INVOCATION_ERRORS.notFound,
        `invocation 不存在：${invocationId}`,
      );
    if (conversationId && invocation.conversationId !== conversationId)
      throw workflowError("invalid-state", "调用不属于该对话");
    conversationId = invocation.conversationId;
    if (!invocation.startReceipt && values != null) {
      invocation = await updatePreparation({
        invocationId,
        expectedDraftRevision,
        values,
      });
      expectedDraftRevision = invocation.draftRevision;
    }
    if (!invocation.executionModel && resolveCurrentModel) {
      invocation = await updatePreparation({
        invocationId,
        values: invocation.preparation.values,
        executionModel: await resolveCurrentModel({
          conversationId,
          entryMode: invocation.entryMode,
        }),
      });
      expectedDraftRevision = invocation.draftRevision;
    }
    if (!invocation.startReceipt) {
      const issues = await preparationIssues(
        invocation.preparation.issues ?? [],
        invocation.executionModel,
        invocation,
        invocation.preparation.values,
      );
      if (issues.length)
        throw workflowError(
          "missing-inputs",
          issues.map((i) => i.message).join("；"),
        );
    }
    const flowState = conversationFlowService
      .controllerFor(conversationId)
      .getSnapshot();
    if (
      !invocation.startReceipt &&
      flowState.pending.length >= PENDING_CAPACITY
    )
      return {
        ok: false,
        code: "queue-full",
        message: "待发送队列已满，稍后可从原卡重试。",
      };
    const modelPlan = invocation.startReceipt
      ? invocation.run?.modelPlan
      : await resolveExecutionPlan?.(invocation.executionModel);
    const workspace = invocation.startReceipt
      ? invocation.run?.workspace
      : await resolveWorkspace?.(conversationId);
    if (!invocation.startReceipt && !runSkills.has(invocationId)) {
      const refs = invocation.documentSnapshot.nodes
        .filter((n) => n.type === "hemi-skill")
        .flatMap((n) => n.data.skillRefs ?? []);
      if (refs.length)
        runSkills.set(invocationId, acquireSkillLease({ refs, skillService }));
    }
    const { receipt, replayed } = await invocationStore
      .start(invocationId, {
        requestId,
        cardId,
        expectedDraftRevision,
        executionModel: invocation.executionModel ?? null,
        buildRun: (frozen) => ({
          workflowRunId: frozen.workflowRunId,
          definitionRevision: frozen.definitionRevision,
          frozenValues: structuredClone(frozen.preparation.values),
          frozenDocument: frozen.documentSnapshot,
          executionModel: frozen.executionModel,
          modelPlan,
          workspace,
          skillSnapshot: runSkills.get(invocationId)?.items ?? null,
          status: "queued",
          nodes: {},
          startedAt: Date.now(),
          ...(buildRun ? buildRun(frozen) : {}),
        }),
      })
      .catch(async (error) => {
        const durable = await invocationStore.get(invocationId);
        if (!durable?.startReceipt) {
          runSkills.get(invocationId)?.release();
          runSkills.delete(invocationId);
        }
        throw error;
      });
    const current = await invocationStore.get(invocationId);
    if (invocation.entryMode === "chat" && !replayed)
      await publishCard(current);
    if (
      current.outbox.some(
        (item) => item.inputId === receipt.inputId && item.status === "sent",
      )
    )
      return {
        ok: true,
        disposition: "already-accepted",
        inputId: receipt.inputId,
        workflowRunId: receipt.workflowRunId,
        cardId: invocation.cardId,
        replayed: true,
      };
    const send = await conversationFlowService
      .controllerFor(conversationId)
      .command({
        type: "send",
        input: {
          text: invocation.name ?? "工作流",
          inputId: receipt.inputId,
          workflow: {
            invocationId,
            workflowId: invocation.workflowId,
            workflowRunId: receipt.workflowRunId,
            title: invocation.name ?? "工作流",
            modelLabel:
              modelPlan?.config?.model ?? invocation.executionModel?.modelKey,
            values: invocation.preparation.values,
            executionModel: invocation.executionModel,
          },
        },
      });
    if (!send.ok && send.code === "queue-full") {
      const reset = await invocationStore.rejectUnacceptedStart(
        invocationId,
        receipt.inputId,
      );
      runSkills.get(invocationId)?.release();
      runSkills.delete(invocationId);
      if (invocation.entryMode === "chat") {
        await publishCard(reset);
      }
    }
    if (send.ok)
      await invocationStore.markOutbox(invocationId, receipt.inputId, "sent");
    return {
      ...send,
      workflowRunId: receipt.workflowRunId,
      cardId: invocation.cardId,
      replayed,
    };
  }

  async function stop({ workflowRunId, reason = "stop" }) {
    const invocations = await invocationStore.list();
    const invocation = invocations.find(
      (inv) => inv.startReceipt?.workflowRunId === workflowRunId,
    );
    if (invocation) {
      const controller = conversationFlowService.controllerFor(
        invocation.conversationId,
      );
      const snapshot = controller.getSnapshot();
      const item = snapshot.timeline.find((row) =>
        row.parts?.some((part) => part.workflowRunId === workflowRunId),
      );
      if (item?.runId === snapshot.activeRunId) {
        const result = await controller.command({ type: "stop", reason });
        return { stopped: result.ok };
      }
      const pending = snapshot.pending.find(
        (row) => row.workflow?.workflowRunId === workflowRunId,
      );
      if (pending) {
        const withdrawn = await controller.command({
          type: "withdrawInput",
          inputId: pending.inputId,
        });
        if (!withdrawn.ok)
          return {
            stopped: false,
            reason: withdrawn.message ?? withdrawn.code,
          };
        await withdrawInvocation({ invocationId: invocation.invocationId });
        return { stopped: true };
      }
      // 挂起等待人工输入（运行槽已释放）：取消请求并落 stopped（HI-AC09）。
      if (
        invocation.run?.status === "waiting" &&
        invocation.run.waiting?.kind === "human-input"
      ) {
        await stopWaitingHumanInput(invocation, reason);
        return { stopped: true };
      }
    }
    return runner.stop(workflowRunId, { reason });
  }

  /**
   * 继续等待中的运行（S5 等待态）：用户完成登录／授权后调用——从 invocation 的
   * 持久节点事实构造回放缓存（已成功节点零重执行），waiting 节点新尝试。
   */
  async function continueWaiting({
    invocationId,
    requestId,
    confirmed = false,
    verifiedOutputs = null,
    resumeMessage = "",
  }) {
    await startup;
    let invocation = await invocationStore.get(invocationId);
    if (!invocation?.run)
      throw workflowError("invalid-state", "没有可继续的运行");
    if (runner.activeRuns().some((run) => run.invocationId === invocationId))
      throw workflowError("invalid-state", "运行仍在执行");
    if (invocation.run.status === "waiting" && invocation.run.waiting?.kind === "human-input") {
      const interaction = invocation.run.interactions?.[invocation.run.currentInteractionId];
      if (!interaction?.response)
        throw workflowError("invalid-state", "请先提交本次人工输入");
      const receipt = invocation.resumeReceipts?.find(
        (item) => item.requestId === interaction.response.requestId,
      );
      return dispatchResume({ invocation, receipt });
    }
    if (
      (["running", "interrupted"].includes(invocation.run.status) ||
        Object.values(invocation.run.nodes ?? {}).some(
          (node) => node.externalOutcomeUnknown,
        )) &&
      !confirmed
    )
      throw workflowError(
        "needs-review",
        "上次执行结果不明，请先核对外部状态再确认继续",
      );
    if (resumeMessage.trim())
      invocation = await invocationStore.updateRun(invocationId, {
        resumeInfo: {
          nodeId:
            invocation.run.waiting?.nodeId ?? invocation.run.currentNodeId,
          message: resumeMessage.trim().slice(0, 4000),
        },
      });
    if (verifiedOutputs !== null) {
      if (!confirmed)
        throw workflowError("needs-review", "核对结果必须由用户确认");
      const nodeId =
        invocation.run.waiting?.nodeId ?? invocation.run.currentNodeId;
      const node = invocation.documentSnapshot.nodes.find(
        (n) => n.id === nodeId,
      );
      if (
        !node ||
        !["waiting", "failed", "interrupted"].includes(invocation.run.status)
      )
        throw workflowError("invalid-state", "当前没有可登记核对结果的步骤");
      const { outputs } = parseNodeOutputs({
        text: JSON.stringify(verifiedOutputs),
        outputSchema: node.data.outputSchema,
      });
      const fileManifests = {};
      for (const [key, prop] of Object.entries(
        node.data.outputSchema?.properties ?? {},
      ))
        if (["file", "files"].includes(prop.type)) {
          const verdict = await verifyWorkflowArtifact(outputs[key], {
            workspace: invocation.run.workspace,
            controlRoot: path.dirname(dir),
          });
          if (!verdict.ok)
            throw workflowError("artifact-unavailable", verdict.reason);
          fileManifests[key] = verdict.manifests;
        }
      invocation = await invocationStore.updateRun(invocationId, {
        nodes: {
          [nodeId]: {
            status: "succeeded",
            outputs,
            fileManifests,
            externalOutcomeUnknown: false,
            externallyVerified: true,
            finishedAt: Date.now(),
          },
        },
      });
    }
    const { replayCache } = await prepareReplayCache(invocation);
    const accepted = await invocationStore.resume(invocationId, requestId);
    const receipt = accepted.resumeReceipts.find(
      (item) => item.requestId === requestId,
    );
    if (waiting.has(invocationId)) {
      waiting.get(invocationId)(replayCache);
      return { ok: true, resuming: true };
    }
    return dispatchResume({ invocation: accepted, receipt });
  }

  // ── 人工输入（HI 通用节点）：投影／提交／草稿／超时／续跑派发 ──────────

  /** 当前人工输入请求的卡片投影（表单渲染与只读记录共用同一形状）。 */
  function interactionCardProjection(invocation) {
    const interactions = invocation?.run?.interactions ?? {};
    const id = invocation?.run?.currentInteractionId;
    const interaction = id ? interactions[id] : null;
    if (!interaction) return null;
    return {
      interactionId: interaction.interactionId,
      nodeId: interaction.nodeId,
      title: interaction.title,
      status: interaction.status,
      content: interaction.content,
      contentIssues: interaction.contentIssues ?? [],
      fields: interaction.fields ?? [],
      actions: interaction.actions ?? [],
      timeoutNextTitle: interaction.timeoutNextTitle ?? null,
      hasTimeout: Boolean(interaction.hasTimeout),
      expiresAt: interaction.expiresAt ?? null,
      revision: interaction.revision ?? 1,
      draft: interaction.draft ?? null,
      response: interaction.response
        ? {
            actionId: interaction.response.actionId,
            actionLabel: interaction.response.actionLabel,
            values: interaction.response.values,
            submittedAt: interaction.response.submittedAt,
            source: interaction.response.source,
          }
        : null,
      resumePending: Boolean(
        interaction.response &&
        invocation.run.status === "waiting" &&
        invocation.outbox?.some((item) =>
          item.kind === "workflow-resume" && item.status === "pending" &&
          invocation.resumeReceipts?.some((receipt) =>
            receipt.inputId === item.inputId && receipt.requestId === interaction.response.requestId,
          ),
        ),
      ),
    };
  }

  function armInteractionTimer(invocation) {
    const interaction = interactionCardProjection(invocation);
    if (!interaction || interaction.status !== "open" || !interaction.expiresAt)
      return;
    const key = `${invocation.invocationId}:${interaction.interactionId}`;
    if (interactionTimers.has(key)) return;
    const timer = setTimeout(
      () => {
        interactionTimers.delete(key);
        void fireInteractionTimeout(
          invocation.invocationId,
          interaction.interactionId,
        ).catch((error) => log?.warn?.(`[workflow] 超时续跑未完成：${error?.message ?? error}`));
      },
      Math.max(0, interaction.expiresAt - Date.now()),
    );
    timer.unref?.();
    interactionTimers.set(key, timer);
  }

  function clearInteractionTimer(invocationId, interactionId) {
    const key = `${invocationId}:${interactionId}`;
    const timer = interactionTimers.get(key);
    if (timer) clearTimeout(timer);
    interactionTimers.delete(key);
  }

  /** 期限到期：按超时来源走独立分支（不伪造人工响应）；重启后按持久期限重裁。 */
  async function fireInteractionTimeout(invocationId, interactionId) {
    try {
      const requestId = `timeout-${interactionId}`;
      const result = await invocationStore.respondInteraction(invocationId, {
        interactionId,
        requestId,
        source: "timeout",
      });
      log?.info?.(
        `[workflow] 人工输入等待超时：${interactionId}（走超时分支续跑）`,
      );
      const dispatched = await dispatchResume({
        invocation: result.invocation,
        receipt: result.receipt,
      });
      if (dispatched.ok)
        await publishCard(await invocationStore.get(invocationId));
      return dispatched;
    } catch (error) {
      if (["invalid-state", "not-found", "interaction-taken"].includes(error?.code))
        return { ok: false, code: error.code, message: error.message };
      log?.warn?.(
        `[workflow] 人工输入超时处理失败：${error?.message ?? error}`,
      );
      throw error;
    }
  }

  /** 从持久成功节点事实构造回放缓存；文件产物复核失配沿边失效下游并如实记 issues。 */
  async function prepareReplayCache(invocation, { republish = true } = {}) {
    const replayCache = new Map();
    const invalid = new Set();
    for (const [nodeId, fact] of Object.entries(invocation.run?.nodes ?? {})) {
      if (fact.status !== "succeeded") continue;
      const node = invocation.documentSnapshot.nodes.find(
        (n) => n.id === nodeId,
      );
      for (const [key, prop] of Object.entries(
        node?.data?.outputSchema?.properties ?? {},
      )) {
        if (["file", "files"].includes(prop.type)) {
          const verdict = await verifyWorkflowArtifact(fact.outputs?.[key], {
            workspace: invocation.run.workspace,
            controlRoot: path.dirname(dir),
          });
          const original = fact.fileManifests?.[key];
          if (
            !verdict.ok ||
            (original &&
              JSON.stringify(original) !== JSON.stringify(verdict.manifests))
          )
            invalid.add(nodeId);
        }
      }
      // 人工输入节点输出 schema 不在文档 data 上（字段即输出），文件字段单独复核。
      if (node?.type === "hemi-human-input") {
        for (const field of node.data.fields ?? []) {
          if (!["file", "files"].includes(field.type)) continue;
          // 可选字段未填写、或超时分支没有人工输入，不等于已经交付的文件失效。
          if (!Object.hasOwn(fact.outputs ?? {}, field.key) &&
              !Object.hasOwn(fact.fileManifests ?? {}, field.key)) continue;
          const verdict = await verifyWorkflowArtifact(
            fact.outputs?.[field.key],
            {
              workspace: invocation.run.workspace,
              controlRoot: path.dirname(dir),
            },
          );
          const original = fact.fileManifests?.[field.key];
          // 兼容早期 files 提交保存的逐文件嵌套清单，不改写已保存的响应。
          const normalized = Array.isArray(original) ? original.flat() : original;
          if (
            !verdict.ok ||
            (normalized &&
              JSON.stringify(normalized) !== JSON.stringify(verdict.manifests))
          )
            invalid.add(nodeId);
        }
      }
      replayCache.set(nodeId, {
        outputs: fact.outputs ?? {},
        branch: fact.branch ?? undefined,
      });
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of invocation.documentSnapshot.edges)
        if (invalid.has(edge.sourceNodeID) && !invalid.has(edge.targetNodeID)) {
          invalid.add(edge.targetNodeID);
          changed = true;
        }
    }
    for (const nodeId of invalid) replayCache.delete(nodeId);
    if (invalid.size && republish) {
      const updated = await invocationStore.updateRun(invocation.invocationId, {
        issues: [...invalid].map((nodeId) => ({
          code: "upstream-changed",
          nodeId,
          message: `步骤「${invocation.documentSnapshot.nodes.find((node) => node.id === nodeId)?.data.title ?? nodeId}」的上游产物缺失或变化，将重新核查并执行。`,
        })),
      });
      await publishCard(updated);
      return { replayCache, invocation: updated };
    }
    return { replayCache, invocation };
  }

  /**
   * 以新执行片段续跑（提交／超时／继续共用）：受理事实已持久（回执＋outbox），
   * 这里只负责把续跑输入送进 060 队列；队列满时受理保留、同 requestId 重试补投。
   */
  function dispatchResume({ invocation, receipt }) {
    if (!receipt)
      return Promise.resolve({ ok: false, code: "invalid-state", message: "缺少续跑回执" });
    const key = receipt.inputId;
    if (resumeDispatches.has(key)) return resumeDispatches.get(key);
    const job = dispatchResumeOnce({ invocation, receipt }).finally(() => resumeDispatches.delete(key));
    resumeDispatches.set(key, job);
    return job;
  }

  async function dispatchResumeOnce({ invocation, receipt }) {
    const invocationId = invocation.invocationId;
    invocation = await invocationStore.get(invocationId);
    const flow = conversationFlowService.controllerFor(invocation.conversationId);
    const snapshot = flow.getSnapshot();
    if (snapshot.pending.some((input) => input.inputId === receipt.inputId) ||
        Object.values(snapshot.runs).some((run) => run.inputIds?.includes(receipt.inputId))) {
      if (invocation.outbox?.some((item) => item.inputId === receipt.inputId && item.status === "pending"))
        invocation = await invocationStore.markOutbox(invocationId, receipt.inputId, "sent");
      await publishCard(invocation);
      return { ok: true, disposition: "already-accepted", inputId: receipt.inputId };
    }
    if (invocation.run?.status !== "waiting") {
      // 停止后的迟到响应：受理事实保留，不再推进任何新节点（HI-R05）。
      return {
        ok: false,
        code: "invalid-state",
        message: "运行已停止或已续跑，本次响应保留不再派发",
      };
    }
    if (flow.getSnapshot().pending.length >= PENDING_CAPACITY) {
      return {
        ok: false,
        code: "queue-full",
        message: "待发送队列已满；受理已保留，稍后重试同一提交即可续跑。",
      };
    }
    const { replayCache } = await prepareReplayCache(invocation);
    if ((await invocationStore.get(invocationId)).run?.status !== "waiting")
      return { ok: false, code: "invalid-state", message: "运行已停止或已续跑" };
    resumeCaches.set(invocationId, replayCache);
    const send = await flow.command({
      type: "send",
      input: {
        inputId: receipt.inputId,
        text: invocation.name ?? "继续工作流",
        workflow: {
          invocationId,
          workflowId: invocation.workflowId,
          workflowRunId: invocation.startReceipt.workflowRunId,
        },
      },
    });
    if (send.ok) {
      // continueWaiting 的回执（resume()）不带 outbox 条目，只有提交／超时回执有。
      if (invocation.outbox?.some((o) => o.inputId === receipt.inputId))
        await invocationStore.markOutbox(invocationId, receipt.inputId, "sent");
    } else resumeCaches.delete(invocationId);
    await publishCard(await invocationStore.get(invocationId));
    return send;
  }

  /** 停止等待人工输入的运行：取消 open 请求、落 stopped、卡片更新、清定时器。 */
  async function stopWaitingHumanInput(invocation, reason) {
    const interactionId = invocation.run?.currentInteractionId;
    if (interactionId) {
      await invocationStore.cancelInteraction(invocation.invocationId, {
        interactionId,
        reason,
      });
      clearInteractionTimer(invocation.invocationId, interactionId);
    }
    await onWorkflowStopped?.({
      conversationId: invocation.conversationId,
      workflowRunId: invocation.startReceipt.workflowRunId,
    });
    await invocationStore.updateRun(invocation.invocationId, {
      status: "stopped",
      finishedAt: Date.now(),
    });
    await publishCard(await invocationStore.get(invocation.invocationId));
  }

  /** 保存草稿（跨重启恢复，HI-R08）：只透传 store 的 open 校验，返回新 revision。 */
  async function saveInteractionDraft({ invocationId, interactionId, values }) {
    const updated = await invocationStore.saveInteractionDraft(invocationId, {
      interactionId,
      values,
    });
    return {
      ok: true,
      revision: updated.run.interactions[interactionId].revision,
    };
  }

  /**
   * 提交人工输入（HI-R04/R05）：宿主按冻结 schema 严格校验（未声明拒、必填、
   * 枚举归一、文件真实可读），上游文件复核失配拒绝旧请求核准新内容（HI-AC10）；
   * 受理与最终结果分离——persist 回执后派发新执行片段，返回受理不代表下游完成。
   */
  async function submitInteraction({
    invocationId,
    interactionId,
    requestId,
    actionId,
    values = {},
    expectedRevision = null,
  }) {
    await startup;
    if (!requestId || typeof requestId !== "string")
      throw workflowError("invalid-state", "提交需要 requestId");
    let invocation = await invocationStore.get(invocationId);
    if (!invocation) throw workflowError("not-found", "调用不存在");
    const interaction = invocation.run?.interactions?.[interactionId];
    if (!interaction)
      throw workflowError("not-found", `请求不存在：${interactionId}`);
    if (interaction.response) {
      // 同 requestId 重放：回执受理事实并补投未派发的续跑。
      if (interaction.response.requestId === requestId) {
        const receipt = invocation.resumeReceipts.find(
          (r) => r.requestId === requestId,
        );
        const dispatched = await dispatchResume({ invocation, receipt });
        return { ...dispatched, replayed: true };
      }
      if (interaction.response.source === "timeout")
        throw workflowError(
          "interaction-expired",
          "等待已超时，本次提交不再受理",
        );
      throw workflowError(
        "interaction-taken",
        "该请求已被另一份响应消费，只有第一份有效",
      );
    }
    if (interaction.status !== "open")
      throw workflowError(
        "invalid-state",
        `请求已${interaction.status === "cancelled" ? "取消" : "超时"}，不能再提交`,
      );
    if (
      expectedRevision != null &&
      interaction.revision !== expectedRevision
    ) {
      throw workflowError(
        "revision-conflict",
        `表单版本冲突：当前 ${interaction.revision}，期望 ${expectedRevision}，请刷新后重试`,
      );
    }
    const action = interaction.actions.find((a) => a.actionId === actionId);
    if (!action)
      throw workflowError("invalid-state", `操作不存在：${actionId}`);
    const requiredFor = new Set(action.requiredKeys ?? []);
    const accepted = {};
    const fileManifests = {};
    const issues = [];
    const workspace = invocation.run?.workspace;
    for (const field of interaction.fields ?? []) {
      const value = values[field.key];
      const need = Boolean(field.required) || requiredFor.has(field.key);
      if (field.optionsError && need) {
        issues.push({ field: field.key, message: field.optionsError });
        continue;
      }
      if (field.type === "text") {
        if (need && (typeof value !== "string" || !value.trim())) {
          issues.push({ field: field.key, message: `请填写「${field.label}」` });
          continue;
        }
        if (value != null) {
          if (typeof value !== "string") {
            issues.push({
              field: field.key,
              message: `「${field.label}」需要文本`,
            });
            continue;
          }
          accepted[field.key] = value;
        }
      } else if (field.type === "choice") {
        if (value == null || value === "") {
          if (need)
            issues.push({
              field: field.key,
              message: `请选择「${field.label}」`,
            });
          continue;
        }
        if (typeof value !== "string" || !field.options.includes(value)) {
          issues.push({
            field: field.key,
            message: `「${field.label}」的选项不在本次列表内：${String(value)}`,
          });
          continue;
        }
        accepted[field.key] = value;
      } else if (field.type === "file") {
        if (typeof value !== "string" || !value.trim()) {
          if (need)
            issues.push({
              field: field.key,
              message: `请提供「${field.label}」的文件`,
            });
          continue;
        }
        const verdict = await verifyWorkflowArtifact(value, {
          workspace,
          controlRoot: path.dirname(dir),
        });
        if (!verdict.ok) {
          issues.push({
            field: field.key,
            message: `「${field.label}」文件不可用：${verdict.reason}`,
          });
          continue;
        }
        accepted[field.key] = value;
        fileManifests[field.key] = verdict.manifests ?? null;
      } else if (field.type === "files") {
        const list = Array.isArray(value) ? value : value == null ? [] : [value];
        if (list.length === 0) {
          if (need)
            issues.push({
              field: field.key,
              message: `请提供「${field.label}」的文件`,
            });
          continue;
        }
        const verified = [];
        const manifests = [];
        let bad = null;
        for (const item of list) {
          if (typeof item !== "string" || !item.trim()) {
            bad = `「${field.label}」包含非法文件项`;
            break;
          }
          const verdict = await verifyWorkflowArtifact(item, {
            workspace,
            controlRoot: path.dirname(dir),
          });
          if (!verdict.ok) {
            bad = `「${field.label}」文件不可用：${verdict.reason}`;
            break;
          }
          verified.push(item);
          manifests.push(...(verdict.manifests ?? []));
        }
        if (bad) {
          issues.push({ field: field.key, message: bad });
          continue;
        }
        accepted[field.key] = verified;
        fileManifests[field.key] = manifests;
      }
    }
    if (issues.length) {
      throw workflowError(
        "missing-inputs",
        issues.map((i) => i.message).join("；"),
        { issues },
      );
    }
    // 上游文件复核（HI-AC10）：挂起时展示并核验过的上游产物被替换／删除时，
    // 旧请求不能核准新内容——如实拒绝，重新核对（重新挂起）后再提交。
    for (const [ref, original] of Object.entries(
      interaction.upstreamFileManifests ?? {},
    )) {
      if (original == null) continue;
      const filePath = interaction.upstreamFiles?.[ref];
      const verdict = await verifyWorkflowArtifact(filePath, {
        workspace,
        controlRoot: path.dirname(dir),
      });
      if (
        !verdict.ok ||
        JSON.stringify(original) !== JSON.stringify(verdict.manifests)
      ) {
        throw workflowError(
          "artifact-changed",
          `待确认内容引用的上游文件已变化（${ref}），请停止后重新运行`,
        );
      }
    }
    const result = await invocationStore.respondInteraction(invocationId, {
      interactionId,
      requestId,
      actionId,
      values: accepted,
      fileManifests,
    });
    clearInteractionTimer(invocationId, interactionId);
    const dispatched = await dispatchResume({
      invocation: result.invocation,
      receipt: result.receipt,
    });
    await publishCard(await invocationStore.get(invocationId));
    return { ...dispatched, replayed: false };
  }

  const startup = (async () => {
    for (const invocation of await invocationStore.list()) {
      const queuedWithoutAdmission =
        invocation.run?.status === "queued" &&
        (() => {
          const flow = conversationFlowService
            .controllerFor(invocation.conversationId)
            .getSnapshot();
          const inputId = invocation.startReceipt?.inputId;
          return (
            !flow.pending.some((input) => input.inputId === inputId) &&
            !Object.values(flow.runs).some((run) =>
              run.inputIds?.includes(inputId),
            )
          );
        })();
      if (
        invocation.run?.status === "running" ||
        invocation.run?.status === "stopping" ||
        queuedWithoutAdmission
      ) {
        await invocationStore.updateRun(invocation.invocationId, {
          status: "interrupted",
          issues: [
            {
              code: "needs-review",
              message: queuedWithoutAdmission
                ? "上次启动的受理结果未能确认，请核对后继续；不会自动重新执行。"
                : "上次执行被中断，请先核对未完成步骤的外部状态。",
            },
          ],
        });
        await publishCard(await invocationStore.get(invocation.invocationId));
      }
    }
    // 人工输入恢复（HI-R08）：waiting＝合法持久状态，不转 interrupted——
    // 过期按持久期限裁决（不从重启时间重新计时），未到期重挂定时器并重发卡片
    // 让表单重新可见；挂起事实之外的 open 请求如实作废。
    for (const invocation of await invocationStore.list()) {
      const run = invocation.run;
      if (!run?.interactions) continue;
      for (const interaction of Object.values(run.interactions)) {
        if (interaction.status !== "open") {
          // 已受理但尚未派发的响应仍须可见；重试复用持久回执，不自动重跑副作用。
          if (interaction.response && run.status === "waiting" &&
              run.currentInteractionId === interaction.interactionId)
            await publishCard(invocation);
          continue;
        }
        const suspended =
          run.status === "waiting" && run.waiting?.kind === "human-input";
        if (!suspended) {
          await invocationStore
            .cancelInteraction(invocation.invocationId, {
              interactionId: interaction.interactionId,
              reason: "startup-stale",
            })
            .catch(() => {});
          continue;
        }
        if (interaction.expiresAt && Date.now() >= interaction.expiresAt) {
          await fireInteractionTimeout(
            invocation.invocationId,
            interaction.interactionId,
          ).catch((error) =>
            log?.warn?.(
              `[workflow] 恢复期超时裁决失败 ${interaction.interactionId}：${error?.message ?? error}`,
            ),
          );
        } else {
          armInteractionTimer(invocation);
          await publishCard(invocation);
        }
      }
    }
  })();
  void startup.catch((error) =>
    log?.error?.(`工作流恢复失败：${error.message}`),
  );

  instance = {
    definitionStore,
    invocationStore,
    runner,
    flowRouter,
    prepare,
    updatePreparation,
    startPrepared,
    stop,
    continueWaiting,
    submitInteraction,
    saveInteractionDraft,
    abandonPreparation,
    managePreparation,
    interactiveCoordinator,
    listDefinitions: async () => {
      await startup;
      return definitionStore.list();
    },
    getDefinitionHead: (workflowId) => definitionStore.getHead(workflowId),
    getDefinitionRevision: async (workflowId, revision) => {
      const selected =
        revision ?? (await definitionStore.getHead(workflowId))?.revision;
      return selected
        ? definitionStore.getRevision(workflowId, selected)
        : null;
    },
    getInvocation: async (invocationId) => {
      await startup;
      return invocationStore.get(invocationId);
    },
    listInvocations: async (filter) => {
      await startup;
      return invocationStore.list(filter);
    },
  };
  return instance;
}

export function getWorkflowService() {
  return instance;
}

/** 测试专用：单例复位（生产进程内服务永不重建）。 */
export function __resetWorkflowServiceForTests() {
  instance = null;
}
