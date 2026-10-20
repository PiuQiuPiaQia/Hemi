/**
 * 059 工作流运行器（S2，契约 §7、运行接线 §1/§8/§9）：宿主持有的最小执行闭环。
 *
 * 职责：冻结快照（invocation.documentSnapshot）→ schema 转换 → vendored 引擎执行 →
 * 节点尝试事实写回 invocation（先持久后推进）→ 交付核查 → 终态。
 * 不维护第二份「下一节点」队列——图推进只属于引擎（vendoring 方案）。
 *
 * 停止（§9）：stop() 先建内存栅栏（epoch 前进＋stopped 标志）再 engine task.cancel()；
 * 栅栏后 executor 拒绝新进入，迟到返回不写事实不推进后继（引擎 terminated 守卫＋宿主
 * 双层）。真实 Pi/工具中止由 executor 实现方（S2 后半 workflow-node-agent）配合 owner
 * 信号完成；本层保证「栅栏后零新 executor 进入」。
 *
 * 交付（§7）：deliver 声明的 file/files 产物经 verifyArtifact 核查真实可读；核查不过
 * 不标 completed（停在 failed 带 issue），「引擎成功」不冒充业务完成。
 *
 * 恢复（§8）：宿主持久缓存（已提交成功节点的 outputs＋branch）经 replayCache 注入——
 * 回放 executor 命中缓存直接返回，不做外部动作；无缓存的节点按新尝试真执行。
 */
import {
  createWorkflowEngine,
  ConditionExecutor,
  StartExecutor,
  EndExecutor,
  WorkflowVariableType,
} from "./vendor/flowgram-engine/index.mjs";
import crypto from "node:crypto";
import { CONDITION_PORTS, parseHumanInputContentVars } from "../../shared/workflow.mjs";

const PARAM_TYPE_TO_RUNTIME = {
  string: "string",
  text: "string",
  enum: "string",
  number: "number",
  boolean: "boolean",
  date: "string",
  file: "string",
  files: "array",
  directory: "string",
};

const SCHEMA_TYPE_OF_OUTPUT = new Set([
  "string",
  "number",
  "boolean",
  "array",
  "object",
]);

/**
 * hemi 业务文档 → FlowGram Runtime schema（转换器有版本，见契约 §2）。
 * hemi-input→start、hemi-deliver→end；条件 'yes'/'else' 端口映射 Runtime
 * conditions[0].key='yes'／缺省 else 分支；任务节点保留类型名由宿主 executor 分派。
 */
export function toRuntimeSchema(document) {
  const inputNode = document.nodes.find((n) => n.type === "hemi-input");
  const properties = {};
  const required = [];
  for (const p of inputNode?.data?.parameters ?? []) {
    properties[p.key] = { type: PARAM_TYPE_TO_RUNTIME[p.type] ?? "string" };
    if (p.required) required.push(p.key);
  }

  const refValue = (binding) => {
    if (!binding) return null;
    if (binding.kind === "parameter") {
      return { type: "ref", content: [inputNode.id, binding.key] };
    }
    return { type: "ref", content: [binding.nodeId, binding.key] };
  };
  const constValue = (v) => ({ type: "constant", content: v });

  const nodes = [];
  for (const node of document.nodes) {
    const data = node.data ?? {};
    if (node.type === "hemi-input") {
      nodes.push({
        id: node.id,
        type: "start",
        meta: { position: node.meta?.position ?? { x: 0, y: 0 } },
        data: {
          title: data.title ?? "输入",
          outputs: { type: "object", properties, required },
        },
      });
      continue;
    }
    if (node.type === "hemi-condition") {
      const cond = data.condition ?? {};
      nodes.push({
        id: node.id,
        type: "condition",
        meta: { position: node.meta?.position ?? { x: 0, y: 0 } },
        data: {
          title: data.title ?? "条件",
          conditions: [
            {
              key: "yes",
              value: {
                left: refValue(cond.fieldRef),
                operator: cond.operator ?? "eq",
                right: cond.value !== undefined ? constValue(cond.value) : null,
              },
            },
          ],
        },
      });
      continue;
    }
    if (node.type === "hemi-deliver") {
      const inputs = { type: "object", properties: {} };
      const inputsValues = {};
      for (const [i, artifact] of (data.artifacts ?? []).entries()) {
        const key = artifact.label || `artifact_${i}`;
        const upstream = bindingOutputType(document, artifact.binding);
        inputs.properties[key] = { type: upstream ?? "string" };
        inputsValues[key] = refValue(artifact.binding);
      }
      inputs.properties.__summary = { type: "string" };
      inputsValues.__summary = constValue(data.summary ?? "");
      nodes.push({
        id: node.id,
        type: "end",
        meta: { position: node.meta?.position ?? { x: 0, y: 0 } },
        data: { title: data.title ?? "交付", inputs, inputsValues },
      });
      continue;
    }
    if (node.type === "hemi-human-input") {
      // 人工输入：输入由内容变量／动态选项／预填绑定自动派生（与 executor 同一套
      // 确定性命名）；输出＝字段值＋保留 __action_id／__action_value，branch＝动作端口。
      const inputs = { type: "object", properties: {} };
      const inputsValues = {};
      for (const [i, ref] of parseHumanInputContentVars(data.content).entries()) {
        const name = `__hi_c${i}`;
        inputs.properties[name] = { type: "string" };
        inputsValues[name] =
          ref.nodeId === inputNode?.id
            ? { type: "ref", content: [inputNode.id, ref.key] }
            : { type: "ref", content: [ref.nodeId, ref.key] };
      }
      for (const field of data.fields ?? []) {
        const config = field.config ?? {};
        if (config.optionsBinding) {
          const name = `__hi_opts_${field.fieldId ?? field.key}`;
          inputs.properties[name] = { type: "array" };
          inputsValues[name] = refValue(config.optionsBinding);
        }
        if (field.type === "text" && config.prefillBinding) {
          const name = `__hi_pre_${field.fieldId ?? field.key}`;
          inputs.properties[name] = { type: "string" };
          inputsValues[name] = refValue(config.prefillBinding);
        }
      }
      const outputs = { type: "object", properties: {} };
      for (const field of data.fields ?? [])
        outputs.properties[field.key] = { type: field.type === "files" ? "array" : "string" };
      outputs.properties.__action_id = { type: "string" };
      outputs.properties.__action_value = { type: "string" };
      nodes.push({
        id: node.id,
        type: node.type,
        meta: { position: node.meta?.position ?? { x: 0, y: 0 } },
        data: { ...data, inputs, inputsValues, outputs },
      });
      continue;
    }
    // hemi-agent / hemi-skill / hemi-browser / hemi-desktop：类型保留，宿主 executor 分派
    const inputs = { type: "object", properties: {} };
    const inputsValues = {};
    const nodeBindings = [...(data.inputBindings ?? [])];
    if (
      node.type === "hemi-browser" &&
      data.targetBinding &&
      !nodeBindings.some(
        (b) =>
          (b.as ?? b.key) === (data.targetBinding.as ?? data.targetBinding.key),
      )
    )
      nodeBindings.push(data.targetBinding);
    for (const binding of nodeBindings) {
      const key = binding.as ?? binding.key;
      inputs.properties[key] = { type: bindingTypeToRuntime(binding) };
      inputsValues[key] = refValue(binding);
    }
    const outputs = { type: "object", properties: {} };
    for (const [key, schema] of Object.entries(
      data.outputSchema?.properties ?? {},
    )) {
      outputs.properties[key] = {
        type:
          schema.type === "files"
            ? "array"
            : SCHEMA_TYPE_OF_OUTPUT.has(schema.type)
              ? schema.type
              : "string",
      };
    }
    nodes.push({
      id: node.id,
      type: node.type,
      meta: { position: node.meta?.position ?? { x: 0, y: 0 } },
      data: { ...data, inputs, inputsValues, outputs },
    });
  }

  const edges = document.edges.map((edge) => ({
    sourceNodeID: edge.sourceNodeID,
    targetNodeID: edge.targetNodeID,
    ...(edge.sourcePortID ? { sourcePortID: edge.sourcePortID } : {}),
  }));
  return { nodes, edges };
}

function bindingTypeToRuntime(binding) {
  const t = binding.type ?? binding.acceptType;
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "files" || t === "array") return "array";
  if (t === "object") return "object";
  return "string";
}

function bindingOutputType(document, binding) {
  if (!binding) return null;
  if (binding.kind === "parameter") {
    const input = document.nodes.find((n) => n.type === "hemi-input");
    const p = (input?.data?.parameters ?? []).find(
      (x) => x.key === binding.key,
    );
    return p ? (PARAM_TYPE_TO_RUNTIME[p.type] ?? "string") : null;
  }
  const upstream = document.nodes.find((n) => n.id === binding.nodeId);
  if (upstream?.type === "hemi-human-input") {
    const field = upstream.data.fields?.find((item) => item.key === binding.key);
    return field?.type === "files" ? "array" : "string";
  }
  const t = upstream?.data?.outputSchema?.properties?.[binding.key]?.type;
  return t === "files" ? "array" : SCHEMA_TYPE_OF_OUTPUT.has(t) ? t : "string";
}

export function createWorkflowRunner({
  invocationStore,
  /** Map<nodeType, executor>——宿主任务执行器（hemi-agent/hemi-skill/hemi-browser/hemi-desktop） */
  executors,
  /** (artifact, { invocationId, nodeId }) → Promise<{ok, reason?}> 交付产物核查（真实可读） */
  verifyArtifact,
  log = null,
} = {}) {
  if (!invocationStore) throw new Error("workflow-runner 缺少 invocationStore");
  const runs = new Map(); // workflowRunId → { engineTask, epoch, stopped, invocationId }
  let epochCounter = 0;

  const baseExecutors = () => [
    new StartExecutor(),
    new ConditionExecutor(),
    new EndExecutor(),
  ];

  /** executor 包装：宿主栅栏＋尝试事实。栅栏后拒绝新进入；迟到返回丢弃。 */
  function wrapExecutor(type, raw, entry) {
    return {
      type,
      async execute(ctx) {
        if (entry && entry.stopped) {
          throw new Error("run-stopping：停止栅栏后拒绝新的节点执行");
        }
        const seq = (entry?.attemptSeq ?? 0) + 1;
        if (entry) entry.attemptSeq = seq;
        const attemptId = `try-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
        entry?.pending.add(attemptId);
        await invocationStore.updateRun(entry.invocationId, {
          status: "running",
          currentNodeId: ctx.node.id,
          nodes: {
            [ctx.node.id]: {
              attemptId,
              status: "running",
              startedAt: Date.now(),
            },
          },
        });
        entry.onProgress?.({
          status: "running",
          patch: {
            needsReview: false,
            waitingReason: null,
            currentNodeId: ctx.node.id,
            completedCount: entry.completed.size,
            totalCount: entry.total,
          },
        });
        try {
          entry.abort.signal.throwIfAborted();
          const result = await raw.execute({
            ...ctx,
            workflowRunId: entry.workflowRunId,
            invocationId: entry.invocationId,
            attemptId,
            signal: entry.abort.signal,
            onModelCall: (call) =>
              invocationStore.recordUsage(entry.invocationId, {
                ...call,
                stage: "execution",
                nodeId: ctx.node.id,
                attemptId,
              }),
            onResourceWait: async (waiting) => {
              await invocationStore.updateRun(entry.invocationId, {
                nodes: { [ctx.node.id]: { resourceWaiting: waiting } },
              });
              entry.onProgress?.({
                status: "running",
                patch: { resourceWaiting: waiting },
              });
            },
            onTrace: (trace) =>
              invocationStore.recordTrace(entry.invocationId, ctx.node.id, {
                ...trace,
                attemptId,
              }),
            registerHandoff: (callback) => {
              entry.handoff = callback;
              return () => {
                entry.handoff = null;
              };
            },
            invocation: entry.invocation,
          });
          if (entry && entry.stopped) {
            entry.pending.delete(attemptId);
            return { outputs: {} }; // 迟到返回：宿主丢弃事实；引擎侧 terminated 守卫丢弃推进
          }
          entry?.pending.delete(attemptId);
          const fileManifests = {};
          for (const [key, prop] of Object.entries(
            ctx.node.data.outputSchema?.properties ?? {},
          )) {
            if (!["file", "files"].includes(prop.type) || !verifyArtifact)
              continue;
            const verdict = await verifyArtifact(result.outputs?.[key], {
              invocationId: entry.invocationId,
              nodeId: ctx.node.id,
              key,
              signal: entry.abort.signal,
            });
            if (!verdict?.ok)
              throw new Error(
                `节点产物「${key}」不可用：${verdict?.reason ?? "不可读"}`,
              );
            fileManifests[key] = verdict.manifests ?? null;
          }
          await invocationStore.updateRun(entry.invocationId, {
            nodes: {
              [ctx.node.id]: {
                attemptId,
                status: "succeeded",
                finishedAt: Date.now(),
                outputs: result.outputs,
                fileManifests,
                branch: result.branch ?? null,
              },
            },
          });
          entry.completed.add(ctx.node.id);
          entry.onProgress?.({
            status: "running",
            patch: {
              currentNodeId: ctx.node.id,
              completedNodeId: ctx.node.id,
              completedCount: entry.completed.size,
              totalCount: entry.total,
            },
          });
          return result;
        } catch (error) {
          entry?.pending.delete(attemptId);
          // 人工输入（HI 通用节点）：持久创建 interaction 后挂起——后继不启动，
          // 引擎任务取消；run 收口为 waiting（kind=human-input），由 service 释放
          // 运行槽（不占 057 槽、零保留资源），提交／超时后以新执行片段续跑。
          if (error?.code === "human-input" && error.interaction) {
            await invocationStore.openInteraction(entry.invocationId, error.interaction);
            entry.humanInput = {
              nodeId: ctx.node.id,
              interactionId: error.interaction.interactionId,
              reason: String(error.message ?? "等待人工输入"),
            };
            entry.engineTask?.cancel();
            return { outputs: {} };
          }
          // 等待人工操作（登录／授权）：节点挂起而非失败——取消引擎推进，run 转 waiting，
          // continue 时从持久事实回放续跑（不忙循环请求模型）。
          if (error?.code === "waiting") {
            await invocationStore.updateRun(entry.invocationId, {
              nodes: {
                [ctx.node.id]: {
                  attemptId,
                  status: "waiting",
                  error: error.message,
                  externalOutcomeUnknown: Boolean(error.externalOutcomeUnknown),
                },
              },
            });
            entry.waiting = {
              nodeId: ctx.node.id,
              reason: String(error.message ?? "等待人工操作"),
              needsReview: Boolean(error.externalOutcomeUnknown),
            };
            entry.engineTask?.cancel();
            return { outputs: {} };
          }
          if (entry?.stopped) {
            await invocationStore.updateRun(entry.invocationId, {
              nodes: {
                [ctx.node.id]: {
                  attemptId,
                  status: "stopped",
                  finishedAt: Date.now(),
                },
              },
            });
            return { outputs: {} };
          }
          await invocationStore.updateRun(entry.invocationId, {
            nodes: {
              [ctx.node.id]: {
                attemptId,
                status: "failed",
                error: String(error?.message ?? error),
                externalOutcomeUnknown:
                  error?.code === "external-outcome-unknown",
              },
            },
          });
          throw error;
        }
      },
    };
  }

  /**
   * 执行一次调用（冻结快照）。resolve 于终态：completed/failed/stopped。
   * @param {object} params
   * @param {Map<string, {outputs: object, branch?: string}>} [params.replayCache] 恢复回放缓存
   */
  async function run({
    invocationId,
    replayCache = null,
    onProgress = null,
  } = {}) {
    const invocation = await invocationStore.get(invocationId);
    if (!invocation) throw new Error(`invocation 不存在：${invocationId}`);
    if (!invocation.startReceipt?.workflowRunId)
      throw new Error("调用尚未受理（无 startReceipt）");
    const workflowRunId = invocation.startReceipt.workflowRunId;
    if (runs.has(workflowRunId)) throw new Error("工作流已在运行");
    if (
      ["completed", "stopped"].includes(invocation.run?.status) &&
      !replayCache
    )
      throw new Error("工作流已结束，不能重复执行");
    const epoch = ++epochCounter;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const entry = {
      invocationId,
      workflowRunId,
      epoch,
      invocation,
      onProgress,
      abort: new AbortController(),
      done,
      stopped: false,
      pending: new Set(),
      attemptSeq: 0,
      completed: new Set(replayCache?.keys() ?? []),
      total: invocation.documentSnapshot.nodes.length,
      waiting: null,
      humanInput: null,
    };
    runs.set(workflowRunId, entry);
    try {
      const document =
        invocation.documentSnapshot ?? invocation.run?.frozenDocument;
      const schema = toRuntimeSchema(document);

      // 回放 executor：命中宿主持久缓存直接返回（零外部动作）；否则查真 executor
      const realByType = new Map();
      for (const [type, raw] of Object.entries(executors ?? {})) {
        realByType.set(type, wrapExecutor(type, raw, entry));
      }
      const replayExecutor = {
        type: "__replay",
        async execute(ctx) {
          const cached = replayCache?.get(ctx.node.id);
          if (cached) {
            await invocationStore.updateRun(invocationId, {
              nodes: {
                [ctx.node.id]: {
                  status: "succeeded",
                  replayed: true,
                  outputs: cached.outputs,
                },
              },
            });
            return { outputs: cached.outputs, branch: cached.branch };
          }
          const real = realByType.get(ctx.node.type);
          if (!real)
            throw new Error(`No executor found for node type ${ctx.node.type}`);
          return real.execute(ctx);
        },
      };
      // 任务节点全部先经回放层分流
      const taskTypes = [
        "hemi-agent",
        "hemi-skill",
        "hemi-browser",
        "hemi-desktop",
        "hemi-human-input",
      ];
      const engineExecutors = [
        ...baseExecutors().map((raw) => wrapExecutor(raw.type, raw, entry)),
        ...[...realByType.values()].map((r) => ({
          type: r.type,
          execute: (ctx) => replayAndDispatch(r, ctx),
        })),
      ];
      async function replayAndDispatch(real, ctx) {
        if (!taskTypes.includes(ctx.node.type)) return real.execute(ctx);
        return replayExecutor.execute(ctx);
      }

      await invocationStore.updateRun(invocationId, {
        status: "running",
        workflowRunId,
      });
      entry.abort.signal.throwIfAborted();
      const engine = createWorkflowEngine({ executors: engineExecutors });
      const engineTask = engine.invoke({
        schema,
        inputs:
          invocation.run?.frozenValues ?? invocation.preparation?.values ?? {},
      });
      entry.engineTask = engineTask;

      const outcome = await engineTask.processing;
      const report = engineTask.context.reporter.export();

      // 人工输入挂起：interaction 已持久（openInteraction），run 转 waiting 并以
      // kind=human-input 收口——与登录等待不同，这里由 service 立即释放运行槽，
      // 提交／超时经 outbox 以新执行片段续跑（HI-R02/R06）。
      if (entry.humanInput && !entry.stopped) {
        await invocationStore.updateRun(invocationId, {
          status: "waiting",
          waiting: {
            nodeId: entry.humanInput.nodeId,
            reason: entry.humanInput.reason,
            kind: "human-input",
            interactionId: entry.humanInput.interactionId,
          },
          finishedAt: null,
        });
        return {
          status: "waiting",
          kind: "human-input",
          interactionId: entry.humanInput.interactionId,
          reason: entry.humanInput.reason,
          waitingNodeId: entry.humanInput.nodeId,
          needsReview: false,
          outputs: {},
          issues: [],
          report,
        };
      }

      // 等待人工操作：引擎任务已取消（复用停止栅栏），run 转 waiting——
      // 已成功节点的事实留在 invocation，continue 时回放续跑（§7 等待不关闭运行槽语义）。
      if (entry.waiting && !entry.stopped) {
        await invocationStore.updateRun(invocationId, {
          status: "waiting",
          waiting: {
            nodeId: entry.waiting.nodeId,
            reason: entry.waiting.reason,
          },
          finishedAt: null,
        });
        return {
          status: "waiting",
          reason: entry.waiting.reason,
          waitingNodeId: entry.waiting.nodeId,
          needsReview: entry.waiting.needsReview,
          outputs: {},
          issues: [],
          report,
        };
      }

      let finalStatus;
      let issues = [];
      if (entry.stopped) {
        finalStatus = "stopped";
      } else if (report.workflowStatus.status === "succeeded") {
        // 交付核查：deliver 声明的 file 产物必须真实可读（§7）
        issues = await checkDeliverables(
          document,
          outcome,
          verifyArtifact,
          invocationId,
          entry.abort.signal,
        );
        finalStatus = issues.length === 0 ? "completed" : "failed";
      } else if (report.workflowStatus.status === "canceled") {
        finalStatus = "stopped";
      } else {
        finalStatus = "failed";
        issues = (report.messages?.error ?? []).map((m) => ({
          code: "node-error",
          message: m.message,
        }));
      }

      if (finalStatus === "completed") {
        const persisted = await invocationStore.get(invocationId);
        const nodes = Object.fromEntries(
          document.nodes
            .filter((node) => !persisted.run.nodes[node.id])
            .map((node) => [node.id, { status: "skipped" }]),
        );
        if (Object.keys(nodes).length)
          await invocationStore.updateRun(invocationId, { nodes });
      }
      if (entry.stopped) {
        finalStatus = "stopped";
        issues = [];
      }
      entry.settling = true;
      await invocationStore.updateRun(invocationId, {
        status: finalStatus,
        issues,
        finishedAt: Date.now(),
        engineReport: {
          status: report.workflowStatus.status,
          outputs: outcome ?? {},
        },
      });

      return { status: finalStatus, outputs: outcome ?? {}, issues, report };
    } finally {
      runs.delete(workflowRunId);
      resolveDone();
    }
  }

  async function checkDeliverables(
    document,
    outputs,
    verify,
    invocationId,
    signal,
  ) {
    const issues = [];
    for (const node of document.nodes) {
      if (node.type !== "hemi-deliver") continue;
      for (const [i, artifact] of (node.data?.artifacts ?? []).entries()) {
        if (
          !["file", "files"].includes(
            artifact.binding.type ?? artifact.binding.acceptType ?? "file",
          )
        )
          continue;
        const key = artifact.label || `artifact_${i}`;
        const path = outputs?.[key];
        if (!path) {
          issues.push({
            code: "artifact-missing",
            message: `交付产物「${key}」没有值`,
            nodeId: node.id,
          });
          continue;
        }
        if (verify) {
          const verdict = await verify(path, {
            invocationId,
            nodeId: node.id,
            key,
            signal,
          });
          if (!verdict?.ok) {
            issues.push({
              code: "artifact-unreadable",
              message: `交付产物「${key}」核查未过：${verdict?.reason ?? "不可读"}`,
              nodeId: node.id,
            });
          }
        }
      }
    }
    return issues;
  }

  /**
   * 停止：先立栅栏（拒绝新 executor 进入）再取消引擎；迟到返回被丢弃。
   * 即使 invocation 写失败也继续中止真实工作（§9：如实报告状态未保存由调用方兜底）。
   */
  async function stop(workflowRunId, { reason = "stop" } = {}) {
    const entry = runs.get(workflowRunId);
    if (!entry) return { stopped: false, reason: "no-active-run" };
    if (entry.settling) {
      await entry.done;
      return { stopped: false, reason: "already-settled" };
    }
    entry.stopped = true;
    if (reason === "promote") await entry.handoff?.();
    entry.abort.abort(new DOMException("工作流已停止", "AbortError"));
    entry.engineTask?.cancel();
    await invocationStore
      .updateRun(entry.invocationId, { status: "stopping" })
      .catch(() => {});
    await entry.done;
    return { stopped: true, pending: entry.pending.size };
  }

  function activeRuns() {
    return [...runs.values()].map((e) => ({
      workflowRunId: e.workflowRunId,
      invocationId: e.invocationId,
      stopped: e.stopped,
      pending: e.pending.size,
    }));
  }

  return { run, stop, activeRuns, toRuntimeSchema };
}
