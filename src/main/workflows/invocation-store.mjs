/**
 * 059 调用（invocation）存储（S1，契约 §3/§5/§6）：一次主动使用的持久聚合——
 * 准备（补参）＋运行快照＋启动回执＋outbox 在同一文件原子提交。
 *
 * 身份（契约 §1）：invocationId＝一次使用；cardId＝展示身份；workflowRunId＝点击开始
 * 后的一次执行（准备阶段为 null）；requestId＝启动请求去重身份。
 *
 * 启动幂等（契约 §6）：start 持久去重——同 requestId 重放返回原 receipt 绝不二次执行；
 * 不同 requestId 打已消费的卡拒 stale-card。冻结快照（定义＋参数＋模型计划）在启动
 * 一次提交内生成，排队和运行不因后续修改漂移。
 *
 * 写入纪律：每个 invocation 一条异步串行写链＋tmp＋rename；requestId→invocation 索引
 * 可重建（启动时从文件恢复），不是第二份权威记录。
 */
import fs from "node:fs";
import { retryingRename } from "../lib/rename-retry.mjs";
import path from "node:path";
import crypto from "node:crypto";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const INVOCATION_ERRORS = {
  revisionConflict: "revision-conflict",
  staleCard: "stale-card",
  missingInputs: "missing-inputs",
  notFound: "not-found",
  invalidState: "invalid-state",
  storageFailed: "storage-failed",
};

const genId = (prefix) =>
  `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function workflowError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * @param {object} options
 * @param {string} options.dir workflows 根目录（invocations/ 在其下）
 * @param {object} [options.fsOps] 测试注入
 * @param {number} [options.now] 测试时钟
 */
export function createInvocationStore({
  dir,
  fsOps = null,
  now = () => Date.now(),
} = {}) {
  if (!dir) throw new Error("invocation-store 缺少存储目录");
  const io = fsOps ?? {
    mkdir: (p) => fs.promises.mkdir(p, { recursive: true }),
    readFile: (p) => fs.promises.readFile(p, "utf8"),
    writeFile: (p, data) => fs.promises.writeFile(p, data, "utf8"),
    rename: retryingRename((a, b) => fs.promises.rename(a, b)),
    unlink: (p) => fs.promises.unlink(p),
    readdir: (p) => fs.promises.readdir(p),
  };

  const chains = new Map();
  const chain = (key, job) => {
    const tail = (chains.get(key) ?? Promise.resolve()).then(job, job);
    chains.set(
      key,
      tail.catch(() => {}),
    );
    return tail;
  };

  const fileOf = (invocationId) =>
    path.join(dir, "invocations", `${invocationId}.json`);

  async function readJson(file) {
    try {
      return JSON.parse(await io.readFile(file));
    } catch {
      return null;
    }
  }

  async function writeAtomic(file, value, guard = null) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      guard?.();
      await io.writeFile(tmp, JSON.stringify(value, null, 1));
      guard?.();
      await io.rename(tmp, file);
    } catch (error) {
      if (io.unlink) await io.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  function mutate(invocationId, job, { guard = null } = {}) {
    if (!ID_RE.test(String(invocationId ?? ""))) {
      return Promise.reject(
        workflowError(
          INVOCATION_ERRORS.notFound,
          `非法 invocationId：${invocationId}`,
        ),
      );
    }
    return chain(`inv:${invocationId}`, async () => {
      const current = await readJson(fileOf(invocationId));
      if (!current)
        throw workflowError(
          INVOCATION_ERRORS.notFound,
          `invocation 不存在：${invocationId}`,
        );
      guard?.();
      const next = await job(current);
      next.revision = (current.revision ?? 0) + 1;
      next.updatedAt = now();
      await writeAtomic(fileOf(invocationId), next, guard);
      return next;
    });
  }

  /**
   * 创建调用（两个入口共用）。entryMode：'chat'（去对话）｜'direct'（直接运行）｜'editor-test'。
   * definitionRevision 必须指向已保存版本；草稿不可运行由调用方（IPC 层）拒绝。
   */
  async function createInvocation({
    workflowId,
    name = null,
    definitionRevision,
    document,
    conversationId = null,
    entryMode,
    executionModel = null,
    modelSelectionSource = "user",
  }) {
    if (!ID_RE.test(String(workflowId ?? "")))
      throw workflowError(
        INVOCATION_ERRORS.invalidState,
        `非法 workflowId：${workflowId}`,
      );
    if (!["chat", "direct", "editor-test"].includes(entryMode)) {
      throw workflowError(
        INVOCATION_ERRORS.invalidState,
        `非法 entryMode：${entryMode}`,
      );
    }
    if (!Number.isInteger(definitionRevision) || definitionRevision < 1) {
      throw workflowError(
        INVOCATION_ERRORS.invalidState,
        `调用必须绑定已保存 definitionRevision，得到：${definitionRevision}`,
      );
    }
    const invocation = {
      schemaVersion: 1,
      invocationId: genId("inv"),
      cardId: genId("card"),
      workflowId,
      name,
      definitionRevision,
      /** 定义快照：运行与恢复只看这份，后续保存新版本不影响（契约 §4.7）。 */
      documentSnapshot: document ?? null,
      conversationId,
      conversationGeneration: null,
      entryMode,
      draftRevision: 0,
      executionModel,
      modelSelectionSource,
      preparation: {
        status: "collecting",
        values: {},
        sources: {},
        issues: [],
        ready: false,
        resolvedAt: null,
      },
      startReceipt: null,
      run: null,
      outbox: [],
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await io.mkdir(path.join(dir, "invocations"));
    await writeAtomic(fileOf(invocation.invocationId), invocation);
    return invocation;
  }

  /**
   * 应用参数补丁（对话补参或表单修改）。expectedDraftRevision 乐观并发；每次有效修改
   * 递增 draftRevision、重算 ready。宿主已验证过的 values 才许进来（本 store 不做业务校验）。
   */
  function applyPreparation(
    invocationId,
    {
      expectedDraftRevision,
      values,
      issues = [],
      modelSelection = null,
      sources = null,
      resolvedAt = null,
      guard = null,
    },
  ) {
    return mutate(invocationId, (current) => {
      if (current.startReceipt) {
        throw workflowError(
          INVOCATION_ERRORS.staleCard,
          "调用已启动，参数冻结不可修改",
        );
      }
      if (current.preparation.status === "abandoned") {
        throw workflowError(INVOCATION_ERRORS.invalidState, "准备已放弃");
      }
      if (
        expectedDraftRevision != null &&
        current.draftRevision !== expectedDraftRevision
      ) {
        throw workflowError(
          INVOCATION_ERRORS.revisionConflict,
          `准备版本冲突：当前 ${current.draftRevision}，期望 ${expectedDraftRevision}`,
        );
      }
      const next = structuredClone(current);
      if (values != null) {
        next.preparation.values = values;
        next.draftRevision += 1;
      }
      if (sources)
        next.preparation.sources = { ...next.preparation.sources, ...sources };
      if (resolvedAt != null) next.preparation.resolvedAt = resolvedAt;
      next.preparation.issues = issues;
      next.preparation.ready = issues.length === 0 && values != null;
      if (next.preparation.ready) next.preparation.status = "ready";
      else if (issues.length > 0) next.preparation.status = "invalid";
      else next.preparation.status = "collecting";
      if (modelSelection) {
        next.executionModel = modelSelection.executionModel;
        next.modelSelectionSource = modelSelection.source ?? "user";
      }
      return next;
    }, { guard });
  }

  /**
   * 启动受理：冻结快照＋startReceipt＋outbox 一次原子提交。
   * @param {object} params
   * @param {string} params.requestId 渲染层生成并保留的请求身份（重试复用）
   * @param {Function} [params.buildRun] 宿主钩子：(invocation) → run 快照；缺省生成最小快照
   * @returns {Promise<{invocation, receipt, replayed: boolean}>}
   */
  function start(
    invocationId,
    {
      requestId,
      cardId,
      expectedDraftRevision,
      executionModel = null,
      buildRun,
    } = {},
  ) {
    if (!requestId || typeof requestId !== "string") {
      return Promise.reject(
        workflowError(INVOCATION_ERRORS.invalidState, "start 需要 requestId"),
      );
    }
    return mutate(invocationId, (current) => {
      // 幂等：同 request 重放返回原 receipt（ACK 前崩溃重试的路径）
      if (current.startReceipt) {
        if (current.startReceipt.requestId === requestId) {
          current.__replayed = true;
          return current;
        }
        throw workflowError(
          INVOCATION_ERRORS.staleCard,
          "该卡片已被另一次请求消费",
        );
      }
      if (cardId != null && current.cardId !== cardId) {
        throw workflowError(
          INVOCATION_ERRORS.staleCard,
          `卡片身份不符：期望 ${current.cardId}`,
        );
      }
      if (current.preparation.status === "abandoned")
        throw workflowError(
          INVOCATION_ERRORS.invalidState,
          "准备已取消，不能启动",
        );
      if (!current.preparation.ready) {
        throw workflowError(
          INVOCATION_ERRORS.missingInputs,
          "参数未就绪，不能启动",
          {
            issues: current.preparation.issues,
          },
        );
      }
      if (
        expectedDraftRevision != null &&
        current.draftRevision !== expectedDraftRevision
      ) {
        throw workflowError(
          INVOCATION_ERRORS.revisionConflict,
          `准备版本冲突：当前 ${current.draftRevision}，期望 ${expectedDraftRevision}`,
        );
      }
      const workflowRunId = genId("wrun");
      const next = structuredClone(current);
      if (executionModel) next.executionModel = executionModel;
      next.startReceipt = {
        requestId,
        workflowRunId,
        startedAt: now(),
        inputId: genId("input"),
      };
      next.run = (buildRun ?? defaultBuildRun)({ ...next, workflowRunId });
      next.outbox = [
        {
          inputId: next.startReceipt.inputId,
          kind: "workflow-start",
          status: "pending",
          attempts: 0,
          createdAt: now(),
        },
      ];
      return next;
    }).then((invocation) => {
      const replayed = Boolean(invocation.__replayed);
      delete invocation.__replayed;
      return { invocation, receipt: invocation.startReceipt, replayed };
    });
  }

  function defaultBuildRun(invocation) {
    return {
      workflowRunId: invocation.workflowRunId,
      definitionRevision: invocation.definitionRevision,
      frozenValues: structuredClone(invocation.preparation.values),
      frozenDocument: invocation.documentSnapshot,
      executionModel: invocation.executionModel,
      status: "queued",
      nodes: {},
      startedAt: now(),
    };
  }

  /** 运行事实更新（runner 写）：顶层浅合并；nodes 按节点 id 逐个合并（attempt 事实不互踩）。 */
  function updateRun(invocationId, runPatch) {
    return mutate(invocationId, (current) => {
      if (!current.run)
        throw workflowError(INVOCATION_ERRORS.invalidState, "run 未创建");
      const next = structuredClone(current);
      const { nodes, ...rest } = runPatch;
      Object.assign(next.run, rest);
      if (nodes) {
        next.run.nodes = next.run.nodes ?? {};
        for (const [nodeId, patch] of Object.entries(nodes)) {
          const previous = next.run.nodes[nodeId] ?? {};
          const attempts = previous.attempts ?? [];
          if (
            patch.attemptId &&
            previous.attemptId &&
            patch.attemptId !== previous.attemptId
          ) {
            const { attempts: _history, ...fact } = previous;
            attempts.push(fact);
            next.run.nodes[nodeId] = { ...patch, attempts };
          } else next.run.nodes[nodeId] = { ...previous, ...patch };
        }
      }
      return next;
    });
  }

  // 仅用于控制器明确拒绝（队列已满）；无任何输入受理/外部动作时恢复准备卡。
  function rejectUnacceptedStart(invocationId, inputId) {
    return mutate(invocationId, (current) => {
      if (
        current.startReceipt?.inputId !== inputId ||
        current.outbox.some((item) => item.status === "sent")
      )
        throw workflowError("invalid-state", "已受理的运行不能退回准备");
      const next = structuredClone(current);
      next.startReceipt = null;
      next.run = null;
      next.outbox = [];
      next.draftRevision += 1;
      return next;
    });
  }

  // ── 人工输入（hemi-human-input）挂起／响应 ─────────────────────────────
  // interaction＝一次人工输入请求的持久事实：到达节点时创建（冻结 schema／内容／
  // 期限），提交／超时经 CAS 只产生一份响应，响应＋节点成功事实＋续跑回执＋outbox
  // 在同一次原子写入内落盘，之后才返回受理（HI 运行契约：保存响应与续跑事件后
  // 才返回受理；同 requestId 重放同回执）。

  /** 到达人工输入节点：创建 interaction 并挂起该节点尝试；同节点旧 open 请求作废。 */
  function openInteraction(invocationId, interaction) {
    const required = ["interactionId", "nodeId", "nodeAttemptId", "title", "content", "fields", "actions"];
    for (const key of required)
      if (interaction?.[key] == null)
        throw workflowError("invalid-state", `interaction 缺少 ${key}`);
    return mutate(invocationId, (current) => {
      if (!current.run)
        throw workflowError("invalid-state", "run 未创建");
      const next = structuredClone(current);
      next.run.interactions ??= {};
      for (const prior of Object.values(next.run.interactions))
        if (prior.nodeId === interaction.nodeId && prior.status === "open")
          prior.status = "cancelled";
      if (next.run.interactions[interaction.interactionId])
        throw workflowError("invalid-state", `interaction 已存在：${interaction.interactionId}`);
      next.run.interactions[interaction.interactionId] = {
        status: "open",
        revision: 1,
        createdAt: now(),
        expiresAt:
          Number.isFinite(interaction.expiresAt) && interaction.expiresAt > 0
            ? interaction.expiresAt
            : null,
        upstreamFileManifests: interaction.upstreamFileManifests ?? {},
        draft: null,
        response: null,
        workflowRunId: current.startReceipt?.workflowRunId ?? null,
        ...interaction,
      };
      next.run.currentInteractionId = interaction.interactionId;
      next.run.nodes[interaction.nodeId] = {
        ...(next.run.nodes[interaction.nodeId] ?? {}),
        status: "waiting",
        waitingKind: "human-input",
        interactionId: interaction.interactionId,
      };
      return next;
    });
  }

  /** 草稿（跨重启恢复用，HI-R08）：只许写 open 请求；每次保存递增 revision 供提交 CAS。 */
  function saveInteractionDraft(invocationId, { interactionId, values }) {
    return mutate(invocationId, (current) => {
      const interaction = current.run?.interactions?.[interactionId];
      if (!interaction)
        throw workflowError("not-found", `interaction 不存在：${interactionId}`);
      if (interaction.status !== "open")
        throw workflowError(
          "invalid-state",
          `请求已${interaction.status === "responded" ? "提交" : interaction.status === "expired" ? "超时" : "取消"}，草稿不再修改`,
        );
      const next = structuredClone(current);
      next.run.interactions[interactionId] = {
        ...interaction,
        draft: { values: values ?? {}, savedAt: now() },
        revision: interaction.revision + 1,
      };
      return next;
    });
  }

  /**
   * 响应裁决（提交／超时共用，CAS）：同 requestId 幂等重放原回执；已响应后其他请求
   * 拒 interaction-taken；用户提交撞上期限拒 interaction-expired（过期关闭由超时
   * 来源完成）。原子提交＝response＋节点成功事实（outputs＝字段值＋__action_id／
   * __action_value，branch＝动作端口）＋续跑回执＋outbox（workflow-resume）。
   */
  function respondInteraction(
    invocationId,
    { interactionId, requestId, actionId, values = {}, source = "user", fileManifests = {} },
  ) {
    if (!requestId || typeof requestId !== "string")
      throw workflowError("invalid-state", "提交需要 requestId");
    return mutate(invocationId, (current) => {
      const interaction = current.run?.interactions?.[interactionId];
      if (!interaction)
        throw workflowError("not-found", `interaction 不存在：${interactionId}`);
      if (interaction.response) {
        if (interaction.response.requestId === requestId) {
          current.__respondReplayed = true;
          return current;
        }
        throw workflowError(
          "interaction-taken",
          "该请求已被另一份响应消费，只有第一份有效",
        );
      }
      if (interaction.status !== "open")
        throw workflowError(
          "invalid-state",
          `请求已${interaction.status === "cancelled" ? "取消" : "关闭"}，不能再提交`,
        );
      const expired =
        interaction.expiresAt != null && now() >= interaction.expiresAt;
      if (source === "user" && expired)
        throw workflowError("interaction-expired", "等待已超时，本次提交不再受理");
      if (source === "timeout" && !expired)
        throw workflowError("invalid-state", "尚未到达等待期限，不能按超时关闭");
      const action =
        source === "timeout" ? null : (interaction.actions ?? []).find((a) => a.actionId === actionId);
      if (source === "user" && !action)
        throw workflowError("invalid-state", `操作不存在：${actionId}`);
      const next = structuredClone(current);
      const record = next.run.interactions[interactionId];
      const effectiveActionId = source === "timeout" ? "timeout" : actionId;
      record.response = {
        requestId,
        source,
        actionId: effectiveActionId,
        actionLabel: source === "timeout" ? "等待超时" : (action?.label ?? actionId),
        values: structuredClone(values),
        submittedAt: now(),
      };
      record.status = source === "timeout" ? "expired" : "responded";
      const outputs = {
        ...structuredClone(values),
        __action_id: effectiveActionId,
        __action_value: source === "timeout" ? "等待超时" : (action?.label ?? actionId),
      };
      next.run.nodes[interaction.nodeId] = {
        ...(next.run.nodes[interaction.nodeId] ?? {}),
        status: "succeeded",
        finishedAt: now(),
        outputs,
        branch: effectiveActionId,
        fileManifests: {
          ...(next.run.nodes[interaction.nodeId]?.fileManifests ?? {}),
          ...fileManifests,
        },
      };
      next.resumeReceipts ??= [];
      if (!next.resumeReceipts.some((r) => r.requestId === requestId))
        next.resumeReceipts.push({ requestId, inputId: genId("resume"), at: now() });
      const receipt = next.resumeReceipts.find((r) => r.requestId === requestId);
      if (!next.outbox.some((o) => o.inputId === receipt.inputId))
        next.outbox.push({
          inputId: receipt.inputId,
          kind: "workflow-resume",
          status: "pending",
          attempts: 0,
          createdAt: now(),
        });
      return next;
    }).then((invocation) => {
      const replayed = Boolean(invocation.__respondReplayed);
      delete invocation.__respondReplayed;
      const interaction = invocation.run?.interactions?.[interactionId];
      const receipt = invocation.resumeReceipts?.find(
        (r) => r.requestId === requestId,
      );
      return { invocation, interaction, receipt, replayed };
    });
  }

  /** 显式取消（停止／被新尝试取代）：open → cancelled，不产生响应与回执。 */
  function cancelInteraction(invocationId, { interactionId, reason }) {
    return mutate(invocationId, (current) => {
      const interaction = current.run?.interactions?.[interactionId];
      if (!interaction)
        throw workflowError("not-found", `interaction 不存在：${interactionId}`);
      if (interaction.status !== "open") return current;
      const next = structuredClone(current);
      next.run.interactions[interactionId].status = "cancelled";
      next.run.interactions[interactionId].cancelReason = String(reason ?? "stop");
      return next;
    });
  }

  /** outbox 标记已投递（ACK 前崩溃重投不产生第二次执行——receipt 幂等兜底）。 */
  function resume(invocationId, requestId) {
    if (!requestId)
      throw workflowError("invalid-state", "继续运行需要请求身份");
    return mutate(invocationId, (current) => {
      const next = structuredClone(current);
      next.resumeReceipts ??= [];
      if (
        next.resumeReceipts.some((receipt) => receipt.requestId === requestId)
      )
        return next;
      if (
        !["waiting", "failed", "running", "interrupted"].includes(
          current.run?.status,
        )
      )
        throw workflowError("invalid-state", "当前运行不能继续");
      next.resumeReceipts.push({
        requestId,
        inputId: genId("resume"),
        at: now(),
      });
      return next;
    });
  }

  function recordTrace(invocationId, nodeId, event) {
    return mutate(invocationId, (current) => {
      const next = structuredClone(current),
        fact = next.run.nodes[nodeId];
      if (fact.attemptId !== event.attemptId) return next;
      fact.log = [...(fact.log ?? []), event].slice(-300);
      if (event.externalOutcomeUnknown) fact.externalOutcomeUnknown = true;
      return next;
    });
  }

  function recordUsage(invocationId, call) {
    return mutate(invocationId, (current) => {
      const next = structuredClone(current);
      next.usageCalls ??= [];
      if (!next.usageCalls.some((item) => item.id === call.id))
        next.usageCalls.push(call);
      return next;
    });
  }

  function markOutbox(invocationId, inputId, status) {
    return mutate(invocationId, (current) => {
      const next = structuredClone(current);
      const item = next.outbox.find((o) => o.inputId === inputId);
      if (!item)
        throw workflowError(
          INVOCATION_ERRORS.invalidState,
          `outbox 条目不存在：${inputId}`,
        );
      item.status = status;
      item.attempts += 1;
      return next;
    });
  }

  function abandon(invocationId, { expectedDraftRevision, guard = null } = {}) {
    return mutate(invocationId, (current) => {
      if (expectedDraftRevision != null && current.draftRevision !== expectedDraftRevision)
        throw workflowError(INVOCATION_ERRORS.revisionConflict, '准备版本已变化，请重新读取');
      if (current.startReceipt)
        throw workflowError(
          INVOCATION_ERRORS.invalidState,
          "已启动的调用不能放弃",
        );
      const next = structuredClone(current);
      next.preparation.status = "abandoned";
      next.preparation.ready = false;
      return next;
    }, { guard });
  }

  async function get(invocationId) {
    if (!ID_RE.test(String(invocationId ?? ""))) return null;
    return readJson(fileOf(invocationId));
  }

  /** requestId → invocation（启动去重查询用；扫描小目录，索引可重建）。 */
  async function findByRequestId(requestId) {
    for (const invocationId of await listIds()) {
      const invocation = await readJson(fileOf(invocationId));
      if (invocation?.startReceipt?.requestId === requestId) return invocation;
    }
    return null;
  }

  async function listIds() {
    try {
      return (await io.readdir(path.join(dir, "invocations")))
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.basename(f, ".json"))
        .filter((id) => ID_RE.test(id));
    } catch {
      return [];
    }
  }

  async function list({ workflowId = null, conversationId = null } = {}) {
    const out = [];
    for (const id of await listIds()) {
      const invocation = await readJson(fileOf(id));
      if (!invocation) continue;
      if (workflowId && invocation.workflowId !== workflowId) continue;
      if (conversationId && invocation.conversationId !== conversationId)
        continue;
      out.push(invocation);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  return {
    createInvocation,
    applyPreparation,
    start,
    rejectUnacceptedStart,
    updateRun,
    resume,
    recordUsage,
    recordTrace,
    markOutbox,
    abandon,
    openInteraction,
    saveInteractionDraft,
    respondInteraction,
    cancelInteraction,
    get,
    list,
    listIds,
    findByRequestId,
  };
}
