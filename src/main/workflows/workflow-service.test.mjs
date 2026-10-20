import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  initWorkflowService,
  getWorkflowService,
  __resetWorkflowServiceForTests,
} from "./workflow-service.mjs";
import {
  initConversationFlowService,
  __resetConversationFlowServiceForTests,
} from "../services/conversation-flow-service.mjs";
import { createWorkflowNodeAgent } from "../agent/workflow-node-agent.mjs";

const DOC = {
  nodes: [
    {
      id: "in",
      type: "hemi-input",
      meta: { position: { x: 0, y: 0 } },
      data: {
        title: "输入",
        parameters: [{ key: "topic", type: "string", required: true }],
      },
    },
    {
      id: "writer",
      type: "hemi-agent",
      meta: { position: { x: 1, y: 0 } },
      data: {
        title: "起草",
        goal: "按主题起稿",
        inputBindings: [{ kind: "parameter", key: "topic", type: "string" }],
        outputSchema: {
          type: "object",
          properties: { draft: { type: "string" } },
        },
      },
    },
    {
      id: "deliver",
      type: "hemi-deliver",
      meta: { position: { x: 2, y: 0 } },
      data: {
        title: "交付",
        summary: "交稿",
        artifacts: [
          {
            label: "draft",
            binding: {
              kind: "node-output",
              nodeId: "writer",
              key: "draft",
              type: "string",
            },
          },
        ],
      },
    },
  ],
  edges: [
    { sourceNodeID: "in", targetNodeID: "writer" },
    { sourceNodeID: "writer", targetNodeID: "deliver" },
  ],
};

function makeEnv(t, existingDir = null) {
  const dir =
    existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `hemi-059-svc-${t}-`));
  __resetWorkflowServiceForTests();
  __resetConversationFlowServiceForTests();
  const flowsDir = path.join(dir, "conversations");
  const sessions = [];
  // flowService 先建；runtimeFactory 闭包里引用 service（惰性调用时已赋值）——
  // fake 仿 llm.ipc 的 workflow 分派分支：分派 flowRouter＋自闭合 run-settled/closed。
  let service = null;
  const flowService = initConversationFlowService({
    dir: flowsDir,
    log: null,
    runtimeFactory: (cid) => ({
      async start({ runId, envelope }) {
        if (!envelope?.workflow)
          throw new Error("测试 runtime 只接 workflow 输入");
        const controller = flowService.controllerFor(cid);
        const generation = controller.getSnapshot().generation;
        const outcome = await service.flowRouter.start({
          runId,
          envelope,
          generation,
          applyFact: (f) => controller.applyFact(f),
        });
        controller.applyFact({
          type: "run-settled",
          runId,
          at: Date.now(),
          generation,
        });
        const wfOutcome =
          outcome?.status === "completed" || outcome?.status === "waiting"
            ? "completed"
            : outcome?.status === "stopped"
              ? "stopped"
              : "failed";
        controller.applyFact({
          type: "run-closed",
          runId,
          outcome: wfOutcome,
          at: Date.now(),
          generation,
        });
        return { modelUsed: null, result: outcome, aborted: false };
      },
      async merge() {
        throw new Error("not wired");
      },
      async stop() {
        return { ok: true };
      },
    }),
  });
  service = initWorkflowService({
    dir: path.join(dir, "workflows"),
    conversationFlowService: flowService,
    log: null,
    openAgent: async ({ nodeSpec, executionOwner }) => {
      const session = {
        async prompt(text) {
          sessions.push({ nodeSpec, executionOwner, text });
          const topic = text.match(/- topic = (.*)$/m)?.[1] ?? "";
          return {
            texts: [`完成。\n\`\`\`json\n{"draft": "${topic}·稿"}\n\`\`\``],
            lastText: "",
            usages: [{ input: 1, output: 1 }],
            requests: 1,
            toolNames: [],
          };
        },
        abort() {},
        dispose() {},
      };
      // 用真实 nodeSpec 建 agent（outputSchema 决定输出解析；不丢形状）
      return {
        agent: createWorkflowNodeAgent({ session, nodeSpec, executionOwner }),
        release: () => sessions.push({ released: true }),
      };
    },
  });
  return {
    dir,
    flowService,
    service,
    sessions,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// 最小 agent 构造走真实 createWorkflowNodeAgent（openAgent 内直接建，保 nodeSpec 形状）。

test("service：取消直接运行设置不写入对话；对话内取消仍更新原卡", async (t) => {
  const { service, flowService, sessions, cleanup } = makeEnv("cancel-entry");
  t.after(cleanup);
  await service.definitionStore.saveDraft({
    workflowId: "wf1",
    name: "起稿",
    document: DOC,
  });
  await service.definitionStore.publish({ workflowId: "wf1" });
  for (const entryMode of ["direct", "chat"]) {
    const conversationId = `conv-cancel-${entryMode}`;
    const prepared = await service.prepare({
      workflowId: "wf1",
      conversationId,
      entryMode,
    });
    await service.abandonPreparation({
      conversationId,
      invocationId: prepared.invocationId,
    });
    const rows = flowService
      .controllerFor(conversationId)
      .getSnapshot().timeline;
    assert.equal(rows.length, entryMode === "chat" ? 1 : 0);
    const invocation = await service.getInvocation(prepared.invocationId);
    assert.equal(invocation.preparation.status, "abandoned");
    assert.equal(invocation.run, null);
  }
  assert.equal(sessions.length, 0);
});

test("service：冻结后尚未进入会话即崩溃，重启显示待核对，不滞留队列或自动执行", async (t) => {
  const first = makeEnv("unadmitted");
  t.after(first.cleanup);
  await first.service.definitionStore.saveDraft({
    workflowId: "wf1",
    name: "断点",
    document: DOC,
  });
  await first.service.definitionStore.publish({ workflowId: "wf1" });
  const prep = await first.service.prepare({
    workflowId: "wf1",
    conversationId: "conv-orphan",
    entryMode: "direct",
    values: { topic: "核对" },
  });
  await first.service.invocationStore.applyPreparation(prep.invocationId, {
    values: { topic: "核对" },
    issues: [],
  });
  await first.service.invocationStore.start(prep.invocationId, {
    requestId: "before-admission",
  });
  const second = makeEnv("unadmitted", first.dir);
  const recovered = await second.service.getInvocation(prep.invocationId);
  assert.equal(recovered.run.status, "interrupted");
  assert.equal(recovered.run.issues[0].code, "needs-review");
  assert.equal(second.sessions.length, 0);
});

test("service：prepare 列缺项→updatePreparation 补齐 ready→startPrepared 受理进 057→runner 真跑 completed", async (t) => {
  const { service, flowService, sessions, cleanup } = makeEnv("full");
  t.after(cleanup);
  // 发布定义
  await service.definitionStore.saveDraft({
    workflowId: "wf1",
    name: "起稿",
    document: DOC,
  });
  const published = await service.definitionStore.publish({
    workflowId: "wf1",
  });

  const prep = await service.prepare({
    workflowId: "wf1",
    conversationId: "conv-1",
  });
  assert.equal(prep.workflow.revision, published.revision);
  assert.equal(prep.ready, false, "必填参数缺失未就绪");
  const preparedCard = flowService
    .controllerFor("conv-1")
    .getSnapshot()
    .timeline.flatMap((row) => row.parts ?? [])
    .find((part) => part.kind === "workflow-card");
  assert.equal(preparedCard.totalCount, DOC.nodes.length);
  assert.equal(preparedCard.completedCount, 0);
  assert.ok(prep.issues.some((i) => i.field === "topic"));

  const ready = await service.updatePreparation({
    invocationId: prep.invocationId,
    expectedDraftRevision: prep.draftRevision,
    values: { topic: "周报" },
    issues: [],
  });
  assert.equal(ready.preparation.ready, true);

  const started = await service.startPrepared({
    invocationId: prep.invocationId,
    cardId: prep.cardId,
    expectedDraftRevision: ready.draftRevision,
    requestId: "req-1",
    conversationId: "conv-1",
  });
  assert.equal(started.ok, true);
  assert.match(started.workflowRunId, /^wrun-/);

  // 057 controller 在 runtime start（workflow 分派→runner）后自闭合；轮询 flow 快照
  const controller = flowService.controllerFor("conv-1");
  let snapshot = null;
  for (let i = 0; i < 200; i += 1) {
    snapshot = controller.getSnapshot();
    if (snapshot.phase === "idle") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(snapshot.phase, "idle", "运行自闭合回 idle");
  const cardItem = snapshot.timeline.find(
    (e) =>
      e.kind === "assistant" && e.parts.some((p) => p.kind === "workflow-card"),
  );
  const card = cardItem?.parts?.[0];
  assert.ok(card, "时间线有执行卡");
  assert.equal(card.status, "completed");
  assert.equal(card.invocationId, prep.invocationId);

  const persisted = await service.getInvocation(prep.invocationId);
  assert.equal(persisted.run.status, "completed");
  assert.equal(persisted.run.nodes.writer.outputs.draft, "周报·稿");
  assert.equal(
    sessions.some(
      (s) => s.executionOwner?.workflowRunId === started.workflowRunId,
    ),
    true,
    "节点会话带 owner",
  );

  // 幂等重放：同 requestId 再点不产生第二次执行（卡片已消费拒 stale-card）
  const replay = await service.startPrepared({
    invocationId: prep.invocationId,
    requestId: "req-1",
    conversationId: "conv-1",
  });
  assert.equal(replay.replayed === true || replay.ok === false, true);
});

test("service：startPrepared 未补参（chat 入口缺必填）拒 missing-inputs 且不进 057", async (t) => {
  const { service, flowService, cleanup } = makeEnv("missing");
  t.after(cleanup);
  await service.definitionStore.saveDraft({ workflowId: "wf1", document: DOC });
  await service.definitionStore.publish({ workflowId: "wf1" });
  const prep = await service.prepare({
    workflowId: "wf1",
    conversationId: "conv-2",
  });
  await assert.rejects(
    () =>
      service.startPrepared({
        invocationId: prep.invocationId,
        requestId: "req-2",
        conversationId: "conv-2",
      }),
    (e) => e.code === "missing-inputs",
  );
  const snapshot = flowService.controllerFor("conv-2").getSnapshot();
  assert.equal(snapshot.timeline.length, 1, "只保留准备卡");
  assert.equal(snapshot.activeRunId, null, "缺参没有启动运行");
  assert.equal(snapshot.timeline[0].parts[0].ready, false);
});

test("service：单例守卫（重复 init 返回同实例）", async (t) => {
  const { service, cleanup } = makeEnv("single");
  t.after(cleanup);
  assert.equal(getWorkflowService(), service);
});

test("service：准备卡独立于聊天，工具按身份和版本更新；多卡与跨会话不串台", async t => {
  const { service, flowService, sessions, cleanup } = makeEnv('main-preparation');
  t.after(cleanup);
  await service.definitionStore.saveDraft({ workflowId: 'wf1', name: '周报', document: DOC });
  await service.definitionStore.publish({ workflowId: 'wf1' });
  const first = await service.prepare({ workflowId: 'wf1', conversationId: 'conv-a', entryMode: 'chat' });
  const second = await service.prepare({ workflowId: 'wf1', conversationId: 'conv-a', entryMode: 'chat' });
  const foreign = await service.prepare({ workflowId: 'wf1', conversationId: 'conv-b', entryMode: 'chat' });
  assert.equal(service.handlePreparationTurn, undefined, '没有接管消息的补参钩子');
  const controller = flowService.controllerFor('conv-a');
  const owner = { conversationId: 'conv-a', rootRunId: 'main-turn', generation: controller.getSnapshot().generation };
  controller.applyFact({ type: 'run-preparing', runId: owner.rootRunId, inputIds: [], source: 'user', generation: owner.generation });
  const invoke = args => service.managePreparation({ conversationId: 'conv-a', owner, ...args });
  assert.equal((await invoke({ action: 'list' })).preparations.length, 2);
  await assert.rejects(invoke({ action: 'get', invocationId: foreign.invocationId }), { code: 'not-found' });
  const current = await invoke({ action: 'get', invocationId: first.invocationId });
  const updated = await invoke({ action: 'update', invocationId: first.invocationId, expectedDraftRevision: current.draftRevision, set: { topic: '月报' } });
  assert.equal(updated.ready, true);
  assert.deepEqual(updated.values, { topic: '月报' });
  assert.deepEqual((await service.getInvocation(second.invocationId)).preparation.values, {});
  await assert.rejects(invoke({ action: 'update', invocationId: first.invocationId, expectedDraftRevision: current.draftRevision, set: { topic: '覆盖' } }), { code: 'revision-conflict' });
  await assert.rejects(invoke({ action: 'update', invocationId: first.invocationId, set: { topic: '覆盖' } }), { code: 'revision-conflict' });
  await assert.rejects(invoke({ action: 'update', invocationId: first.invocationId, expectedDraftRevision: updated.draftRevision, set: { topic: {} } }), { code: 'invalid-value' });
  await assert.rejects(invoke({ action: 'update', invocationId: first.invocationId, expectedDraftRevision: updated.draftRevision, set: { ghost: 'x' } }), { code: 'invalid-parameter' });
  const cancelled = await invoke({ action: 'abandon', invocationId: first.invocationId, expectedDraftRevision: updated.draftRevision });
  assert.equal(cancelled.status, 'abandoned');
  await assert.rejects(invoke({ action: 'update', invocationId: first.invocationId, expectedDraftRevision: updated.draftRevision, set: { topic: '复活' } }), { code: 'invalid-state' });
  assert.equal(sessions.length, 0, '参数就绪或取消都不启动节点');
  const signal = AbortSignal.abort();
  await assert.rejects(invoke({ action: 'get', invocationId: second.invocationId, signal }), { name: 'AbortError' });
  controller.applyFact({ type: 'run-stopping', runId: owner.rootRunId, reason: 'stop', generation: owner.generation });
  await assert.rejects(invoke({ action: 'update', invocationId: second.invocationId, expectedDraftRevision: second.draftRevision, set: { topic: '迟到' } }), { name: 'AbortError' });
});

test("service：完成事实跨回合注入——onWorkflowCompleted 收到产物路径（R-26）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-059-svc-notify-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  __resetWorkflowServiceForTests();
  __resetConversationFlowServiceForTests();
  const flowsDir = path.join(dir, "conversations");
  let service = null;
  const flowService = initConversationFlowService({
    dir: flowsDir,
    log: null,
    runtimeFactory: (cid) => ({
      async start({ runId, envelope }) {
        if (!envelope?.workflow)
          throw new Error("测试 runtime 只接 workflow 输入");
        const controller = flowService.controllerFor(cid);
        const g = controller.getSnapshot().generation;
        const outcome = await service.flowRouter.start({
          runId,
          envelope,
          generation: g,
          applyFact: (f) => controller.applyFact(f),
        });
        controller.applyFact({ type: "run-settled", runId, at: Date.now(), g });
        controller.applyFact({
          type: "run-closed",
          runId,
          outcome: outcome?.status === "completed" ? "completed" : "failed",
          at: Date.now(),
          g,
        });
        return { modelUsed: null, result: outcome, aborted: false };
      },
      async merge() {},
      async stop() {
        return { ok: true };
      },
    }),
  });
  __resetWorkflowServiceForTests();
  const notifications = [];
  service = initWorkflowService({
    dir: path.join(dir, "workflows"),
    conversationFlowService: flowService,
    log: null,
    onWorkflowCompleted: async (event) => {
      notifications.push(event);
    },
    openAgent: async ({ nodeSpec, executionOwner }) => {
      const session = {
        async prompt() {
          return {
            texts: ['ok\n```json\n{"draft": "稿"}\n```'],
            lastText: "",
            usages: [],
            requests: 1,
            toolNames: [],
          };
        },
        abort() {},
        dispose() {},
      };
      return {
        agent: createWorkflowNodeAgent({ session, nodeSpec, executionOwner }),
        release: () => {},
      };
    },
  });
  await service.definitionStore.saveDraft({ workflowId: "wfN", document: DOC });
  await service.definitionStore.publish({ workflowId: "wfN" });
  const prep = await service.prepare({
    workflowId: "wfN",
    conversationId: "conv-N",
  });
  await service.updatePreparation({
    invocationId: prep.invocationId,
    expectedDraftRevision: prep.draftRevision,
    values: { topic: "周报" },
    issues: [],
  });
  console.log("DBG pre-start notifs:", notifications.length);
  const n5Started = await service.startPrepared({
    invocationId: prep.invocationId,
    requestId: `req-${Date.now()}`,
    conversationId: "conv-N",
  });
  for (let i = 0; i < 100; i += 1) {
    if (flowService.controllerFor("conv-N").getSnapshot().phase === "idle")
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(
    "DBG post-idle notifs:",
    notifications.length,
    "svcDir:",
    JSON.stringify(notifications[0] ?? null),
  );
  assert.equal(notifications.length, 1, "完成通知恰好一次");
  assert.equal(notifications[0].conversationId, "conv-N");
  assert.equal(notifications[0].status, "completed");
  assert.deepEqual(
    notifications[0].outputs,
    { draft: "稿" },
    "产物事实随通知传递（跨回合引用同一文件的基础）",
  );
});

test("service：入口初始化模型——缺省取应用当前模型、显式选择不被覆盖", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-059-svc-model-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  __resetWorkflowServiceForTests();
  const flowService = initConversationFlowService({
    dir: path.join(dir, "conversations"),
    log: null,
  });
  const service = initWorkflowService({
    dir: path.join(dir, "workflows"),
    conversationFlowService: flowService,
    log: null,
    resolveCurrentModel: async () => ({
      mode: "fixed",
      modelKey: "app-current-model",
    }),
    openAgent: async () => ({
      agent: { run: async () => ({ outputs: {}, text: "", usage: null }) },
      release: () => {},
    }),
  });
  await service.definitionStore.saveDraft({ workflowId: "wfM", document: DOC });
  await service.definitionStore.publish({ workflowId: "wfM" });

  // 直接运行未带模型 → 入口初始化＝应用当前模型，冻结进受理
  const direct = await service.invocationStore.createInvocation({
    workflowId: "wfM",
    definitionRevision: 1,
    document: DOC,
    entryMode: "direct",
    conversationId: "conv-M",
  });
  const directStarted = await service.startPrepared({
    invocationId: direct.invocationId,
    requestId: `req-${Date.now()}a`,
    conversationId: "conv-M",
    values: { topic: "周报" },
  });
  const directPersisted = await service.invocationStore.get(
    direct.invocationId,
  );
  assert.deepEqual(
    directPersisted.executionModel,
    { mode: "fixed", modelKey: "app-current-model" },
    "缺省＝应用当前模型",
  );
  assert.equal(directStarted.replayed, false);

  // 显式选择不被覆盖
  const explicit = await service.invocationStore.createInvocation({
    workflowId: "wfM",
    definitionRevision: 1,
    document: DOC,
    entryMode: "direct",
    conversationId: "conv-M",
    executionModel: { mode: "fixed", modelKey: "user-picked" },
  });
  await service.startPrepared({
    invocationId: explicit.invocationId,
    requestId: `req-${Date.now()}b`,
    conversationId: "conv-M",
    values: { topic: "周报" },
  });
  const explicitPersisted = await service.invocationStore.get(
    explicit.invocationId,
  );
  assert.deepEqual(
    explicitPersisted.executionModel,
    { mode: "fixed", modelKey: "user-picked" },
    "显式选择不覆盖",
  );
});

test("service：等待态（登录）——waiting 不算失败、continue 回放续跑到完成（S5）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-059-svc-wait-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  __resetWorkflowServiceForTests();
  __resetConversationFlowServiceForTests();
  let service;
  const flowService = initConversationFlowService({
    dir: path.join(dir, "conversations"),
    runtimeFactory: (cid) => ({
      async start({ runId, envelope }) {
        const controller = flowService.controllerFor(cid),
          generation = controller.getSnapshot().generation;
        void service.flowRouter
          .start({
            runId,
            envelope,
            generation,
            applyFact: (fact) => controller.applyFact(fact),
          })
          .then(
            (outcome) => {
              controller.applyFact({
                type: "run-closed",
                runId,
                generation,
                outcome: outcome.status,
                at: Date.now(),
              });
            },
            // 不吞错：Windows 死锁排查时曾因缺 rejection 分支静默挂死（2026-10-20）。
            (error) => {
              console.error("[S5 runtime] flowRouter.start 失败：", error);
              controller.applyFact({
                type: "run-closed",
                runId,
                generation,
                outcome: "failed",
                at: Date.now(),
              });
            },
          );
        return {};
      },
      async stop() {
        return { ok: true };
      },
    }),
  });
  let loggedIn = false;
  const agentRuns = [];
  service = initWorkflowService({
    dir: path.join(dir, "workflows"),
    conversationFlowService: flowService,
    log: null,
    openAgent: async ({ nodeSpec, executionOwner }) => {
      const session = {
        async prompt() {
          agentRuns.push(executionOwner.nodeId);
          if (!loggedIn) {
            const error = new Error("需要登录");
            error.code = "waiting";
            throw error;
          }
          return {
            texts: ['ok\n```json\n{"draft": "稿"}\n```'],
            lastText: "",
            usages: [],
            requests: 1,
            toolNames: [],
          };
        },
        abort() {},
        dispose() {},
      };
      return {
        agent: createWorkflowNodeAgent({ session, nodeSpec, executionOwner }),
        release: () => {},
      };
    },
  });
  await service.definitionStore.saveDraft({ workflowId: "wfW", document: DOC });
  await service.definitionStore.publish({ workflowId: "wfW" });
  const direct = await service.invocationStore.createInvocation({
    workflowId: "wfW",
    definitionRevision: 1,
    document: DOC,
    entryMode: "direct",
    conversationId: "conv-W",
  });
  await service.startPrepared({
    invocationId: direct.invocationId,
    requestId: `req-${Date.now()}`,
    conversationId: "conv-W",
    values: { topic: "x" },
    buildRun: (inv) => ({
      workflowRunId: inv.workflowRunId,
      definitionRevision: inv.definitionRevision,
      frozenValues: { topic: "周报" },
      frozenDocument: inv.documentSnapshot,
      status: "queued",
      nodes: {},
    }),
  });
  for (
    let i = 0;
    i < 400 &&
    (await service.invocationStore.get(direct.invocationId)).run.status !==
      "waiting";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  const waitingPersisted = await service.invocationStore.get(
    direct.invocationId,
  );
  assert.equal(waitingPersisted.run.status, "waiting");
  assert.notEqual(
    waitingPersisted.run.nodes.writer.status,
    "failed",
    "waiting 节点不写成失败（挂起事实）",
  );

  // 登录完成后继续：waiting 节点新尝试，已成功节点回放（agentRuns 不含重跑）
  loggedIn = true;
  const agentRunsBeforeContinue = agentRuns.length;
  const secondOutcome = await service.continueWaiting({
    invocationId: direct.invocationId,
    requestId: `req-c-${Date.now()}`,
  });
  assert.equal(secondOutcome.ok, true);
  for (
    let i = 0;
    i < 400 &&
    (await service.invocationStore.get(direct.invocationId)).run.status !==
      "completed";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  const persisted = await service.invocationStore.get(direct.invocationId);
  // 失败时带出节点现场（Windows 死锁排查：光看 status 差分无法定位卡点）。
  assert.equal(
    persisted.run.status,
    "completed",
    JSON.stringify({
      status: persisted.run.status,
      currentNodeId: persisted.run.currentNodeId,
      nodes: Object.fromEntries(
        Object.entries(persisted.run.nodes ?? {}).map(([id, node]) => [
          id,
          `${node.status}${node.externalOutcomeUnknown ? "?" : ""}`,
        ]),
      ),
      issues: persisted.run.issues ?? null,
    }),
  );
  assert.equal(persisted.run.nodes.writer.outputs.draft, "稿");
  assert.equal(
    agentRuns.length - agentRunsBeforeContinue,
    1,
    "continue 只跑 waiting 节点的新尝试",
  );
  assert.equal(agentRuns.at(-1), "writer");
});

// ── 人工输入（HI 通用节点）：挂起释放槽位／提交续跑／超时／停止／恢复 ──

import { PENDING_CAPACITY } from "../../shared/conversation-flow.mjs";

const HI_DOC = {
  nodes: [
    { id: "in", type: "hemi-input", meta: { position: { x: 0, y: 0 } }, data: { title: "输入", parameters: [{ key: "topic", type: "string", required: true }] } },
    { id: "writer", type: "hemi-agent", meta: { position: { x: 1, y: 0 } }, data: { title: "起草", goal: "按主题起稿", inputBindings: [{ kind: "parameter", key: "topic", type: "string" }], outputSchema: { type: "object", properties: { draft: { type: "string" }, ideas: { type: "array" } } } } },
    {
      id: "hi", type: "hemi-human-input", meta: { position: { x: 2, y: 0 } },
      data: {
        title: "确认方向",
        content: "草稿：{{writer.draft}}，请选择后续方案。",
        fields: [
          { fieldId: "f-comment", key: "comment", label: "批注", type: "text", config: { prefillText: "默认意见" } },
          { fieldId: "f-plan", key: "plan", label: "方案", type: "choice", required: true, config: { optionsBinding: { kind: "node-output", nodeId: "writer", key: "ideas", type: "array" } } },
        ],
        actions: [
          { actionId: "approve", label: "通过", primary: true, requiredKeys: ["comment"] },
          { actionId: "revise", label: "再改一版" },
        ],
        wait: { mode: "forever" },
      },
    },
    // 引擎要求恰一个 end：revise 分支经 fixer 汇合回同一交付（approve 时 fixer 跳过）。
    { id: "fixer", type: "hemi-agent", meta: { position: { x: 3, y: 1 } }, data: { title: "返工", goal: "按批注返工", inputBindings: [{ kind: "node-output", nodeId: "hi", key: "comment", type: "string" }], outputSchema: { type: "object", properties: { fixed: { type: "string" } } } } },
    { id: "deliver", type: "hemi-deliver", meta: { position: { x: 4, y: 0 } }, data: { title: "交付", summary: "交付", artifacts: [{ label: "批注", binding: { kind: "node-output", nodeId: "hi", key: "comment", type: "string" } }] } },
  ],
  edges: [
    { sourceNodeID: "in", targetNodeID: "writer" },
    { sourceNodeID: "writer", targetNodeID: "hi" },
    { sourceNodeID: "hi", targetNodeID: "deliver", sourcePortID: "approve" },
    { sourceNodeID: "hi", targetNodeID: "fixer", sourcePortID: "revise" },
    { sourceNodeID: "fixer", targetNodeID: "deliver" },
  ],
};

function hiDocVariant(patchHi, extraEdges = []) {
  const doc = structuredClone(HI_DOC);
  if (patchHi) {
    const hi = doc.nodes.find((n) => n.id === "hi");
    hi.data = { ...hi.data, ...patchHi };
  }
  doc.edges.push(...extraEdges);
  return doc;
}

/** 零字段纯按钮图（HI 最短路径）：ok→交付直连；no（或超时）→返工→同一交付。 */
function buttonsDoc({ withTimeout = false, timeoutMs = 60 } = {}) {
  return {
    nodes: [
      { id: "in", type: "hemi-input", meta: { position: { x: 0, y: 0 } }, data: { parameters: [{ key: "topic", type: "string", required: true }] } },
      { id: "writer", type: "hemi-agent", meta: { position: { x: 1, y: 0 } }, data: { title: "起草", goal: "起稿", outputSchema: { type: "object", properties: { draft: { type: "string" } } } } },
      { id: "hi", type: "hemi-human-input", meta: { position: { x: 2, y: 0 } }, data: { title: "确认", content: "草稿：{{writer.draft}}", fields: [], actions: [{ actionId: "ok", label: "确认", primary: true }], ...(withTimeout ? { wait: { mode: "timeout", timeoutMs } } : { actions: [{ actionId: "ok", label: "确认", primary: true }, { actionId: "no", label: "退回" }], wait: { mode: "forever" } }) } },
      { id: "fixer", type: "hemi-agent", meta: { position: { x: 3, y: 1 } }, data: { title: "返工", goal: "返工", outputSchema: { type: "object", properties: { fixed: { type: "string" } } } } },
      { id: "deliver", type: "hemi-deliver", meta: { position: { x: 4, y: 0 } }, data: { title: "交付", summary: "交付", artifacts: [] } },
    ],
    edges: [
      { sourceNodeID: "in", targetNodeID: "writer" },
      { sourceNodeID: "writer", targetNodeID: "hi" },
      { sourceNodeID: "hi", targetNodeID: "deliver", sourcePortID: "ok" },
      { sourceNodeID: "hi", targetNodeID: "fixer", sourcePortID: withTimeout ? "timeout" : "no" },
      { sourceNodeID: "fixer", targetNodeID: "deliver" },
    ],
  };
}

/** 与 makeEnv 同构，但 writer 输出 draft＋ideas，供人工输入动态选项使用。 */
function makeHiEnv(t, dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `hemi-059-hi-${t.name}-`)))) {
  // realpathSync.native（libuv/GetFinalPathNameByHandle）在 win 会把 CI 的 8.3 短名
  // （RUNNER~1）规范成长名，与产品运行时 fs.promises.realpath 同一实现族；默认
  // realpathSync 是 JS 实现、保留短名，两侧拼写不一致（2026-10-20 win CI 实锤）。
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
  __resetWorkflowServiceForTests();
  __resetConversationFlowServiceForTests();
  let service = null;
  const flowService = initConversationFlowService({
    dir: path.join(dir, "conversations"),
    log: null,
    runtimeFactory: (cid) => ({
      async start({ runId, envelope }) {
        if (!envelope?.workflow) throw new Error("测试 runtime 只接 workflow 输入");
        const controller = flowService.controllerFor(cid);
        const generation = controller.getSnapshot().generation;
        const outcome = await service.flowRouter.start({ runId, envelope, generation, applyFact: (f) => controller.applyFact(f) });
        controller.applyFact({ type: "run-settled", runId, at: Date.now(), generation });
        const wfOutcome = outcome?.status === "completed" || outcome?.status === "waiting" ? "completed" : outcome?.status === "stopped" ? "stopped" : "failed";
        controller.applyFact({ type: "run-closed", runId, outcome: wfOutcome, at: Date.now(), generation });
        return { modelUsed: null, result: outcome, aborted: false };
      },
      async merge() { throw new Error("not wired"); },
      async stop() { return { ok: true }; },
    }),
  });
  const modelCalls = [];
  service = initWorkflowService({
    dir: path.join(dir, "workflows"),
    conversationFlowService: flowService,
    resolveWorkspace: async () => ({ dir: path.join(dir, "workspace") }),
    log: null,
    openAgent: async ({ nodeSpec, executionOwner }) => {
      const session = {
        async prompt(text) {
          modelCalls.push({ nodeId: nodeSpec.nodeId, text });
          return {
            texts: ['完成。\n```json\n{"draft": "唯一草稿·标记", "ideas": ["A方案", "B方案"], "fixed": "返工完成"}\n```'],
            lastText: "", usages: [{ input: 1, output: 1 }], requests: 1, toolNames: [],
          };
        },
        abort() {}, dispose() {},
      };
      return { agent: createWorkflowNodeAgent({ session, nodeSpec, executionOwner }), release: () => {} };
    },
  });
  return { dir, flowService, service, modelCalls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function publishHi(service, doc) {
  await service.definitionStore.saveDraft({ workflowId: "wf-hi", name: "人工链路", document: doc });
  return service.definitionStore.publish({ workflowId: "wf-hi" });
}

async function startAndWaitInteraction(env, conversationId) {
  const prepared = await env.service.prepare({ workflowId: "wf-hi", conversationId, entryMode: "chat" });
  await env.service.updatePreparation({ invocationId: prepared.invocationId, values: { topic: "选题" } });
  const started = await env.service.startPrepared({ invocationId: prepared.invocationId, requestId: `start-${conversationId}`, conversationId });
  if (!started.ok) throw new Error(`startPrepared 失败：${started.code}`);
  const invocationId = prepared.invocationId;
  for (let i = 0; i < 100; i++) {
    const invocation = await env.service.getInvocation(invocationId);
    if (invocation.run?.status === "waiting" && invocation.run.waiting?.kind === "human-input") return { invocationId, invocation };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("未在时限内挂起");
}

async function waitRunStatus(env, invocationId, wanted) {
  for (let i = 0; i < 400; i++) {
    const invocation = await env.service.getInvocation(invocationId);
    if (invocation.run?.status === wanted) return invocation;
    await new Promise((r) => setTimeout(r, 20));
  }
  const final = await env.service.getInvocation(invocationId);
  // 失败现场随异常抛出（win CI 排查：光报状态差分无法定位失败的节点与原因）。
  throw new Error(
    `未到 ${wanted}（当前 ${final.run?.status}）` +
      JSON.stringify({
        nodes: Object.fromEntries(
          Object.entries(final.run?.nodes ?? {}).map(([id, node]) => [
            id,
            `${node.status}${node.externalOutcomeUnknown ? "?" : ""}`,
          ]),
        ),
        issues: final.run?.issues ?? null,
        error: final.run?.error ?? null,
      }),
  );
}

test("人工输入：上游真实输出后挂起（槽位释放零模型资源）→ 提交 → 只走选中分支到交付", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, HI_DOC);
  const conversationId = "conv-hi-full";
  const { invocationId } = await startAndWaitInteraction(env, conversationId);

  const suspended = await env.service.getInvocation(invocationId);
  // 上游先产生本次唯一输出，interaction 冻结其值与动态选项（HI-AC02/03）
  assert.equal(env.modelCalls.length, 1, "挂起前只有 writer 一次模型调用");
  const interaction = suspended.run.interactions[suspended.run.currentInteractionId];
  assert.equal(interaction.status, "open");
  assert.ok(interaction.content.includes("唯一草稿·标记"), interaction.content);
  assert.deepEqual(interaction.fields.find((f) => f.key === "plan").options, ["A方案", "B方案"]);
  assert.equal(interaction.fields.find((f) => f.key === "comment").prefill, "默认意见");
  // 挂起即释放运行槽（HI-R02：不阻塞其他任务）
  const flow = env.flowService.controllerFor(conversationId).getSnapshot();
  assert.equal(flow.phase, "idle");
  assert.equal(flow.activeRunId, null);
  // 卡片事实停在 waiting 且携带表单投影
  const cardItem = flow.timeline.find((row) => row.itemId === `workflow-${invocationId}`);
  assert.equal(cardItem.parts[0].status, "waiting");
  assert.equal(cardItem.parts[0].interaction.interactionId, interaction.interactionId);

  // 提交（approve 需要批注）→ 受理与最终结果分离 → 只走 approve 分支
  const before = env.modelCalls.length;
  const submitted = await env.service.submitInteraction({
    invocationId, interactionId: interaction.interactionId,
    requestId: "submit-1", actionId: "approve",
    values: { comment: "这版可以", plan: "B方案" },
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(env.modelCalls.length, before, "提交受理本身零模型调用");
  const finished = await waitRunStatus(env, invocationId, "completed");
  assert.equal(finished.run.nodes.hi.branch, "approve");
  assert.equal(finished.run.nodes.hi.outputs.comment, "这版可以");
  assert.equal(finished.run.nodes.hi.outputs.plan, "B方案");
  assert.equal(finished.run.nodes.hi.outputs.__action_id, "approve");
  assert.equal(finished.run.nodes.deliver.status, "succeeded", "选中分支到达交付");
  assert.equal(finished.run.nodes.fixer.status, "skipped", "未选分支（revise 的返工步）跳过");
  assert.equal(finished.run.nodes.deliver.outputs.批注 ?? finished.run.nodes.deliver.outputs.comment, "这版可以");
});

test("人工输入：重复／并发提交只产生一份响应；同 requestId 重放补投不重复派发", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, buttonsDoc());
  const conversationId = "conv-hi-dedup";
  const { invocationId } = await startAndWaitInteraction(env, conversationId);
  const interaction = (await env.service.getInvocation(invocationId)).run.currentInteractionId;

  const first = await env.service.submitInteraction({ invocationId, interactionId: interaction, requestId: "sub-1", actionId: "ok", values: {} });
  assert.equal(first.ok, true);
  const finished = await waitRunStatus(env, invocationId, "completed");
  assert.equal(finished.resumeReceipts.length, 1, "只有一份续跑回执");
  // 迟到的并发请求拒收（HI-AC06）
  await assert.rejects(
    env.service.submitInteraction({ invocationId, interactionId: interaction, requestId: "sub-2", actionId: "no", values: {} }),
    (error) => error.code === "interaction-taken",
  );
  // 同 requestId 重放：回执同一受理，不再派发（运行已完成）
  const replay = await env.service.submitInteraction({ invocationId, interactionId: interaction, requestId: "sub-1", actionId: "ok", values: {} });
  assert.equal(replay.replayed, true);
  const after = await env.service.getInvocation(invocationId);
  assert.equal(after.run.status, "completed");
  assert.equal(after.resumeReceipts.length, 1);
});

test("人工输入：按动作必填／选项冻结／表单版本 CAS 的宿主校验", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, HI_DOC);
  const conversationId = "conv-hi-validate";
  const { invocationId } = await startAndWaitInteraction(env, conversationId);
  const interactionId = (await env.service.getInvocation(invocationId)).run.currentInteractionId;

  // approve 额外必填 comment：缺项拒绝且带字段定位
  await assert.rejects(
    env.service.submitInteraction({ invocationId, interactionId, requestId: "v1", actionId: "approve", values: { plan: "A方案" } }),
    (error) => error.code === "missing-inputs" && error.issues.some((i) => i.field === "comment"),
  );
  // 选项必须来自冻结列表（HI-AC03：不能默认选第一项，也不能提交列表外值）
  await assert.rejects(
    env.service.submitInteraction({ invocationId, interactionId, requestId: "v2", actionId: "revise", values: { plan: "C方案" } }),
    (error) => error.code === "missing-inputs",
  );
  // 草稿保存递增 revision；过期表单版本拒绝（HI-R05 旧卡失效）
  const draft = await env.service.saveInteractionDraft({ invocationId, interactionId, values: { comment: "草稿" } });
  assert.equal(draft.revision, 2);
  await assert.rejects(
    env.service.submitInteraction({ invocationId, interactionId, requestId: "v3", actionId: "revise", values: { plan: "A方案" }, expectedRevision: 1 }),
    (error) => error.code === "revision-conflict",
  );
  const ok = await env.service.submitInteraction({ invocationId, interactionId, requestId: "v4", actionId: "revise", values: { plan: "A方案" }, expectedRevision: draft.revision });
  assert.equal(ok.ok, true);
  await waitRunStatus(env, invocationId, "completed");
});

test("人工输入：真实时钟到期走超时分支（不伪造人工响应），迟到提交拒收", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, buttonsDoc({ withTimeout: true, timeoutMs: 60 }));
  const conversationId = "conv-hi-timeout";
  const { invocationId } = await startAndWaitInteraction(env, conversationId);
  const suspended = await env.service.getInvocation(invocationId);
  const interactionId = suspended.run.currentInteractionId;
  assert.ok(suspended.run.interactions[interactionId].expiresAt > Date.now());

  const finished = await waitRunStatus(env, invocationId, "completed");
  const interaction = finished.run.interactions[interactionId];
  assert.equal(interaction.status, "expired");
  assert.equal(interaction.response.source, "timeout", "超时不是人工响应");
  assert.equal(finished.run.nodes.hi.branch, "timeout");
  assert.equal(finished.run.nodes.hi.status, "succeeded");
  assert.equal(finished.run.nodes.fixer.status, "succeeded", "超时走独立分支（返工步执行）");
  // 超时后的迟到人工提交失效（HI-R05）
  await assert.rejects(
    env.service.submitInteraction({ invocationId, interactionId, requestId: "late", actionId: "ok", values: {} }),
    (error) => /超时/.test(error.message),
  );
});

test("人工输入：停止挂起运行→请求取消；迟到提交不再推进任何节点", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, HI_DOC);
  const conversationId = "conv-hi-stop";
  const { invocationId } = await startAndWaitInteraction(env, conversationId);
  const invocation = await env.service.getInvocation(invocationId);
  const interactionId = invocation.run.currentInteractionId;

  const stopped = await env.service.stop({ workflowRunId: invocation.startReceipt.workflowRunId });
  assert.equal(stopped.stopped, true);
  const after = await env.service.getInvocation(invocationId);
  assert.equal(after.run.status, "stopped");
  assert.equal(after.run.interactions[interactionId].status, "cancelled");
  await assert.rejects(
    env.service.submitInteraction({ invocationId, interactionId, requestId: "late-stop", actionId: "approve", values: { comment: "x", plan: "A方案" } }),
    (error) => /取消/.test(error.message),
  );
  // 卡片事实更新为 stopped
  const card = env.flowService.controllerFor(conversationId).getSnapshot().timeline.find((row) => row.itemId === `workflow-${invocationId}`);
  assert.equal(card.parts[0].status, "stopped");
});

test("人工输入：队列满时受理保留，同 requestId 重试补投后完成（受理／最终分离）", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, buttonsDoc());
  const conversationId = "conv-hi-queuefull";
  const { invocationId } = await startAndWaitInteraction(env, conversationId);
  const interactionId = (await env.service.getInvocation(invocationId)).run.currentInteractionId;

  // 填满待发送队列（不经 command，直接落 accepted 事实）
  const controller = env.flowService.controllerFor(conversationId);
  for (let i = 0; i < PENDING_CAPACITY; i++)
    controller.applyFact({ type: "input-accepted", input: { inputId: `filler-${i}`, text: `占位${i}` }, at: Date.now() });
  const queued = await env.service.submitInteraction({ invocationId, interactionId, requestId: "qf-1", actionId: "ok", values: {} });
  assert.equal(queued.ok, false);
  assert.equal(queued.code, "queue-full");
  // 响应已持久（受理不丢）
  const persisted = await env.service.getInvocation(invocationId);
  assert.equal(persisted.run.interactions[interactionId].status, "responded");
  // 腾出队列后同 requestId 重放 → 补投完成
  for (let i = 0; i < PENDING_CAPACITY; i++)
    controller.applyFact({ type: "input-withdrawn", inputId: `filler-${i}`, at: Date.now() });
  const retried = await env.service.submitInteraction({ invocationId, interactionId, requestId: "qf-1", actionId: "ok", values: {} });
  assert.equal(retried.replayed, true);
  await waitRunStatus(env, invocationId, "completed");
});

for (const type of ["file", "files"]) {
  test(`人工输入：可选 ${type} 留空后沿已选分支完成，不重新要求确认`, async (t) => {
    const env = makeHiEnv(t);
    t.after(env.cleanup);
    const doc = buttonsDoc();
    doc.nodes.find((node) => node.id === "hi").data.fields = [
      { fieldId: "proof", key: "proof", label: "材料", type, required: false },
    ];
    await publishHi(env.service, doc);
    const { invocationId, invocation } = await startAndWaitInteraction(env, `conv-empty-${type}`);
    const interactionId = invocation.run.currentInteractionId;
    const result = await env.service.submitInteraction({ invocationId, interactionId, requestId: `empty-${type}`, actionId: "ok", values: {} });
    assert.equal(result.ok, true);
    const final = await env.service.getInvocation(invocationId);
    assert.equal(final.run.status, "completed");
    assert.equal(final.run.currentInteractionId, interactionId);
    assert.equal(final.run.nodes.hi.outputs.__action_id, "ok");
    assert.equal(env.modelCalls.length, 1, "成功的上游不重跑、未选分支不运行");
  });
}

test("人工输入：真实多文件提交续跑到下游，清单与内容保持一致", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  const files = ["one", "two"].map((marker) => {
    const file = path.join(env.dir, "workspace", `${marker}.txt`);
    fs.writeFileSync(file, `本次文件-${marker}`);
    return file;
  });
  const doc = buttonsDoc();
  doc.nodes.find((node) => node.id === "hi").data.fields = [
    { fieldId: "proofs", key: "proofs", label: "材料", type: "files", required: true },
  ];
  doc.nodes.find((node) => node.id === "deliver").data.artifacts = [
    { label: "材料", binding: { kind: "node-output", nodeId: "hi", key: "proofs", type: "files" } },
  ];
  await publishHi(env.service, doc);
  const { invocationId, invocation } = await startAndWaitInteraction(env, "conv-files");
  const interactionId = invocation.run.currentInteractionId;
  await env.service.submitInteraction({ invocationId, interactionId, requestId: "files", actionId: "ok", values: { proofs: files } });
  const final = await env.service.getInvocation(invocationId);
  assert.equal(final.run.status, "completed", JSON.stringify(final.run.issues));
  assert.equal(final.run.currentInteractionId, interactionId);
  assert.deepEqual(final.run.engineReport.outputs["材料"], files);
  assert.deepEqual(final.run.nodes.hi.fileManifests.proofs.map((item) => item.path), files);
  assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), ["本次文件-one", "本次文件-two"]);
});

test("人工输入：受理后未派发重启保留重试入口，继续复用原回执且只执行一次", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, buttonsDoc());
  const conversationId = "conv-durable-response";
  const { invocationId, invocation } = await startAndWaitInteraction(env, conversationId);
  const interactionId = invocation.run.currentInteractionId;
  const controller = env.flowService.controllerFor(conversationId);
  for (let i = 0; i < PENDING_CAPACITY; i++)
    controller.applyFact({ type: "input-accepted", input: { inputId: `filler-${i}`, text: `占位${i}` }, at: Date.now() });
  const result = await env.service.submitInteraction({ invocationId, interactionId, requestId: "saved-response", actionId: "no", values: {} });
  assert.equal(result.code, "queue-full");
  const accepted = await env.service.getInvocation(invocationId);
  const receipt = accepted.resumeReceipts[0];
  for (let i = 0; i < PENDING_CAPACITY; i++)
    controller.applyFact({ type: "input-withdrawn", inputId: `filler-${i}`, at: Date.now() });
  await env.flowService.store.saveFlow(conversationId, controller.getSnapshot());
  await env.flowService.store.flush(conversationId);

  const restored = makeHiEnv(t, env.dir);
  const recovered = await restored.service.getInvocation(invocationId);
  assert.equal(recovered.run.status, "waiting", "恢复只展示事实，不自动重复外部动作");
  const card = restored.flowService.controllerFor(conversationId).getSnapshot().timeline.find((row) => row.itemId === `workflow-${invocationId}`).parts[0];
  assert.equal(card.interaction.resumePending, true, "重启后的只读记录仍提供重试入口");
  assert.equal(restored.modelCalls.length, 0);
  const retries = await Promise.all([
    restored.service.continueWaiting({ invocationId, requestId: "ui-retry-1" }),
    restored.service.continueWaiting({ invocationId, requestId: "ui-retry-2" }),
  ]);
  assert.ok(retries.every((retry) => retry.ok));
  const final = await waitRunStatus(restored, invocationId, "completed");
  assert.deepEqual(final.resumeReceipts, [receipt], "重试不能创建新的续跑身份");
  assert.equal(final.outbox.find((item) => item.inputId === receipt.inputId).status, "sent");
  assert.equal(final.run.currentInteractionId, interactionId);
  assert.deepEqual(restored.modelCalls.map((call) => call.nodeId), ["fixer"]);
  assert.equal(Object.values(restored.flowService.controllerFor(conversationId).getSnapshot().runs).filter((run) => run.inputIds?.includes(receipt.inputId)).length, 1);
  const replayed = await restored.service.submitInteraction({ invocationId, interactionId, requestId: "saved-response", actionId: "no", values: {} });
  assert.equal(replayed.ok, true, "完成后重放同一提交仍返回已受理");
});

test("人工输入：续跑已入队后重启，显式恢复队列只执行后继，不重跑上游", async (t) => {
  const env = makeHiEnv(t);
  t.after(env.cleanup);
  await publishHi(env.service, buttonsDoc());
  const conversationId = "conv-queued-restart";
  const { invocationId, invocation } = await startAndWaitInteraction(env, conversationId);
  const controller = env.flowService.controllerFor(conversationId);
  controller.applyFact({ type: "queue-paused" });
  controller.applyFact({ type: "input-accepted", input: { inputId: "filler", text: "占位" } });
  const queued = await env.service.submitInteraction({ invocationId, interactionId: invocation.run.currentInteractionId, requestId: "queued-response", actionId: "no", values: {} });
  assert.equal(queued.disposition, "queued");
  await controller.command({ type: "withdrawInput", inputId: "filler" });
  await env.flowService.store.saveFlow(conversationId, controller.getSnapshot());
  await env.flowService.store.flush(conversationId);
  const restored = makeHiEnv(t, env.dir);
  await restored.service.getInvocation(invocationId);
  assert.equal(restored.modelCalls.length, 0);
  await restored.flowService.controllerFor(conversationId).command({ type: "resumeQueue" });
  const final = await waitRunStatus(restored, invocationId, "completed");
  assert.deepEqual(restored.modelCalls.map((call) => call.nodeId), ["fixer"]);
  assert.equal(final.run.currentInteractionId, invocation.run.currentInteractionId);
});

test("人工输入：重启后 waiting 合法保留（表单重发可见）；期限已过按持久期限裁决续跑", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hemi-059-hi-restart-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const openEnv = (doc) => {
    __resetWorkflowServiceForTests();
    __resetConversationFlowServiceForTests();
    let service = null;
    const flowService = initConversationFlowService({
      dir: path.join(dir, "conversations"),
      log: null,
      runtimeFactory: (cid) => ({
        async start({ runId, envelope }) {
          const controller = flowService.controllerFor(cid);
          const generation = controller.getSnapshot().generation;
          const outcome = await service.flowRouter.start({ runId, envelope, generation, applyFact: (f) => controller.applyFact(f) });
          controller.applyFact({ type: "run-settled", runId, at: Date.now(), generation });
          controller.applyFact({ type: "run-closed", runId, outcome: "completed", at: Date.now(), generation });
          return { modelUsed: null, result: outcome, aborted: false };
        },
        async merge() { throw new Error("not wired"); },
        async stop() { return { ok: true }; },
      }),
    });
    service = initWorkflowService({
      dir: path.join(dir, "workflows"),
      conversationFlowService: flowService,
      log: null,
      openAgent: async ({ nodeSpec, executionOwner }) => ({
        agent: createWorkflowNodeAgent({
          session: {
            async prompt() {
              return { texts: ['完成。\n```json\n{"draft": "重启稿", "ideas": ["A方案", "B方案"], "fixed": "返工完成"}\n```'], lastText: "", usages: [], requests: 1, toolNames: [] };
            },
            abort() {}, dispose() {},
          },
          nodeSpec, executionOwner,
        }),
        release: () => {},
      }),
    });
    return { flowService, service };
  };
  const futureDoc = buttonsDoc({ withTimeout: true, timeoutMs: 60_000 });
  const first = openEnv(futureDoc);
  await publishHi(first.service, futureDoc);
  const { invocationId } = await startAndWaitInteraction(first, "conv-hi-restart");
  const interactionId = (await first.service.getInvocation(invocationId)).run.currentInteractionId;

  // 重启（新服务实例、同一磁盘）：waiting 保留、表单卡片重发、期限不重新计时
  const second = openEnv(futureDoc);
  await new Promise((r) => setTimeout(r, 50));
  const recovered = await second.service.getInvocation(invocationId);
  assert.equal(recovered.run.status, "waiting", "waiting 是合法持久状态，不转 interrupted");
  assert.equal(recovered.run.interactions[interactionId].status, "open");
  const card = second.flowService.controllerFor("conv-hi-restart").getSnapshot().timeline.find((row) => row.itemId === `workflow-${invocationId}`);
  assert.equal(card.parts[0].status, "waiting");
  assert.ok(card.parts[0].interaction, "重启后表单投影可见");

  // 期限已过的重启：挂起用长期限（本进程定时器不触发），盘上把期限改为过去，
  // 重启后由启动恢复按持久期限裁决走超时分支（不从重启时间重新计时）。
  const expiredDoc = buttonsDoc({ withTimeout: true, timeoutMs: 10_000 });
  const thirdEnv = openEnv(expiredDoc);
  await publishHi(thirdEnv.service, expiredDoc);
  const started3 = await startAndWaitInteraction(thirdEnv, "conv-hi-expired-restart");
  const file = path.join(dir, "workflows", "invocations", `${started3.invocationId}.json`);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  const iid3 = onDisk.run.currentInteractionId;
  onDisk.run.interactions[iid3].expiresAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(onDisk));
  const fourth = openEnv(expiredDoc);
  for (let i = 0; i < 100; i++) {
    const invocation = await fourth.service.getInvocation(started3.invocationId);
    if (invocation.run.status === "completed") {
      assert.equal(invocation.run.nodes.hi.branch, "timeout", "按持久期限裁决超时");
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("重启后未按过期期限完成超时续跑");
});
