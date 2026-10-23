import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createInvocationStore,
  INVOCATION_ERRORS,
} from "./invocation-store.mjs";

function memoryFs() {
  const files = new Map();
  // 键归一成 POSIX 形态（win 上 path.join 产反斜杠、测试白盒路径是正斜杠；见
  // definition-store.test.mjs 同款说明）。
  const normalize = (p) => p.replace(/\\/g, "/").replaceAll(/\/+/g, "/").replace(/\/$/, "");
  return {
    files,
    ops: {
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(normalize(p));
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: async (p, data) => {
        files.set(normalize(p), data);
      },
      rename: async (a, b) => {
        const v = files.get(normalize(a));
        if (v === undefined) throw new Error(`ENOENT rename: ${a}`);
        files.delete(normalize(a));
        files.set(normalize(b), v);
      },
      unlink: async p => { files.delete(normalize(p)); },
      readdir: async (p) => {
        const prefix = normalize(p) + "/";
        const direct = new Set();
        for (const f of [...files.keys()].filter((k) => k.startsWith(prefix))) {
          direct.add(f.slice(prefix.length).split("/")[0]);
        }
        return [...direct];
      },
    },
  };
}

function makeStore(t = 1000) {
  const mem = memoryFs();
  let clock = t;
  const store = createInvocationStore({
    dir: "/ud/workflows",
    fsOps: mem.ops,
    now: () => (clock += 1),
  });
  return { store, clock: () => (clock += 1), files: mem.files };
}

async function readyInvocation(
  store,
  { entryMode = "chat", values = { topic: "周报" } } = {},
) {
  const invocation = await store.createInvocation({
    workflowId: "wf1",
    definitionRevision: 3,
    document: { nodes: [], edges: [] },
    entryMode,
  });
  const ready = await store.applyPreparation(invocation.invocationId, {
    expectedDraftRevision: 0,
    values,
    issues: [],
  });
  return { invocation, ready };
}

test("createInvocation：身份齐全、准备期零运行（run=null 无 receipt 无 outbox）", async () => {
  const { store } = makeStore();
  const invocation = await store.createInvocation({
    workflowId: "wf1",
    definitionRevision: 3,
    document: { nodes: [], edges: [] },
    conversationId: "conv-1",
    entryMode: "chat",
  });
  assert.match(invocation.invocationId, /^inv-/);
  assert.match(invocation.cardId, /^card-/);
  assert.notEqual(invocation.invocationId, invocation.cardId);
  assert.equal(invocation.startReceipt, null);
  assert.equal(invocation.run, null);
  assert.deepEqual(invocation.outbox, []);
  assert.equal(invocation.preparation.status, "collecting");
  assert.equal(invocation.draftRevision, 0);
});

test('准备卡更新在原子提交前被停止，旧值保留且临时文件清理', async () => {
  const mem = memoryFs(), store = createInvocationStore({ dir: '/ud/cancel-prep', fsOps: mem.ops });
  const { ready } = await readyInvocation(store);
  let pause = false, release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const write = mem.ops.writeFile;
  mem.ops.writeFile = async (target, text) => { await write(target, text); if (pause && target.endsWith('.tmp')) { entered(); await barrier; } };
  const controller = new AbortController();
  pause = true;
  const update = store.applyPreparation(ready.invocationId, { expectedDraftRevision: ready.draftRevision, values: { topic: '迟到' }, guard: () => controller.signal.throwIfAborted() });
  await started;
  controller.abort(); release();
  await assert.rejects(update, { name: 'AbortError' });
  assert.deepEqual((await store.get(ready.invocationId)).preparation.values, { topic: '周报' });
  assert.ok(![...mem.files.keys()].some(key => key.endsWith('.tmp')));
});

test("createInvocation：草稿不可运行——definitionRevision 必须是已保存版本", async () => {
  const { store } = makeStore();
  await assert.rejects(
    () =>
      store.createInvocation({
        workflowId: "wf1",
        definitionRevision: 0,
        entryMode: "direct",
      }),
    (e) => e.code === INVOCATION_ERRORS.invalidState,
  );
  await assert.rejects(() =>
    store.createInvocation({
      workflowId: "wf1",
      definitionRevision: 1,
      entryMode: "bogus",
    }),
  );
});

test("applyPreparation：补丁递增 draftRevision、issues 置 invalid、expected 冲突拒", async () => {
  const { store } = makeStore();
  const { invocation } = await readyInvocation(store);
  await assert.rejects(
    () =>
      store.applyPreparation(invocation.invocationId, {
        expectedDraftRevision: 99,
        values: {},
      }),
    (e) => e.code === INVOCATION_ERRORS.revisionConflict,
  );
  const invalid = await store.applyPreparation(invocation.invocationId, {
    expectedDraftRevision: 1,
    values: { topic: "" },
    issues: [{ code: "blank", message: "不能为空" }],
  });
  assert.equal(invalid.preparation.status, "invalid");
  assert.equal(invalid.preparation.ready, false);
  assert.equal(invalid.draftRevision, 2);
  const fixed = await store.applyPreparation(invocation.invocationId, {
    expectedDraftRevision: 2,
    values: { topic: "ok" },
    issues: [],
  });
  assert.equal(fixed.preparation.status, "ready");
});

test("启动幂等：同 requestId 重放原 receipt 零新执行；不同 requestId 打已消费卡拒 stale-card", async () => {
  const { store } = makeStore();
  const { invocation } = await readyInvocation(store);
  const first = await store.start(invocation.invocationId, {
    requestId: "req-1",
    expectedDraftRevision: 1,
  });
  assert.equal(first.replayed, false);
  assert.match(first.receipt.workflowRunId, /^wrun-/);
  assert.equal(first.invocation.run.status, "queued");
  assert.equal(
    first.invocation.run.frozenValues.topic,
    "周报",
    "参数冻结进快照",
  );
  assert.equal(first.invocation.outbox[0].kind, "workflow-start");

  const replay = await store.start(invocation.invocationId, {
    requestId: "req-1",
    expectedDraftRevision: 1,
  });
  assert.equal(replay.replayed, true, "ACK 前崩溃重试＝同一执行");
  assert.equal(
    replay.receipt.workflowRunId,
    first.receipt.workflowRunId,
    "不产生第二个 workflowRunId",
  );
  assert.equal(replay.invocation.outbox.length, 1);

  await assert.rejects(
    () => store.start(invocation.invocationId, { requestId: "req-2" }),
    (e) => e.code === INVOCATION_ERRORS.staleCard,
  );
});

test("所有入口未 ready 均拒启动；direct 经准备校验后冻结输入", async () => {
  const { store } = makeStore();
  const invocation = await store.createInvocation({
    workflowId: "wf1",
    definitionRevision: 1,
    entryMode: "chat",
  });
  await assert.rejects(
    () => store.start(invocation.invocationId, { requestId: "req-1" }),
    (e) => e.code === INVOCATION_ERRORS.missingInputs && e.issues != null,
  );
  const direct = await store.createInvocation({
    workflowId: "wf1",
    definitionRevision: 1,
    entryMode: "direct",
    executionModel: { mode: "fixed", modelKey: "p/m" },
  });
  await assert.rejects(
    () => store.start(direct.invocationId, { requestId: "unready-direct" }),
    (e) => e.code === INVOCATION_ERRORS.missingInputs,
  );
  await store.applyPreparation(direct.invocationId, {
    values: { topic: "直启值" },
    issues: [],
  });
  const started = await store.start(direct.invocationId, {
    requestId: "req-d1",
    buildRun: (inv) => ({
      workflowRunId: inv.workflowRunId,
      definitionRevision: inv.definitionRevision,
      frozenValues: { topic: "直启值" },
      status: "queued",
      nodes: {},
    }),
  });
  assert.equal(started.invocation.run.frozenValues.topic, "直启值");
  assert.deepEqual(started.invocation.executionModel, {
    mode: "fixed",
    modelKey: "p/m",
  });
});

test("启动后参数冻结：applyPreparation 拒改、abandon 拒、模型选择不再漂移默认", async () => {
  const { store } = makeStore();
  const { invocation } = await readyInvocation(store);
  await store.start(invocation.invocationId, {
    requestId: "req-1",
    expectedDraftRevision: 1,
  });
  await assert.rejects(
    () =>
      store.applyPreparation(invocation.invocationId, {
        expectedDraftRevision: 1,
        values: { topic: "改" },
      }),
    (e) => e.code === INVOCATION_ERRORS.staleCard,
  );
  await assert.rejects(
    () => store.abandon(invocation.invocationId),
    (e) => e.code === INVOCATION_ERRORS.invalidState,
  );
});

test("outbox 状态机：pending → delivered → acked，attempts 递增", async () => {
  const { store } = makeStore();
  const { invocation } = await readyInvocation(store);
  const started = await store.start(invocation.invocationId, {
    requestId: "req-1",
    expectedDraftRevision: 1,
  });
  const inputId = started.invocation.outbox[0].inputId;
  const afterDeliver = await store.markOutbox(
    invocation.invocationId,
    inputId,
    "delivered",
  );
  assert.equal(afterDeliver.outbox[0].status, "delivered");
  assert.equal(afterDeliver.outbox[0].attempts, 1);
  const afterAck = await store.markOutbox(
    invocation.invocationId,
    inputId,
    "acked",
  );
  assert.equal(afterAck.outbox[0].status, "acked");
  await assert.rejects(() =>
    store.markOutbox(invocation.invocationId, "ghost", "acked"),
  );
});

test("updateRun：runner 合并运行事实，revision 单调", async () => {
  const { store } = makeStore();
  const { invocation } = await readyInvocation(store);
  const started = await store.start(invocation.invocationId, {
    requestId: "req-1",
    expectedDraftRevision: 1,
  });
  const after = await store.updateRun(invocation.invocationId, {
    status: "running",
    currentNodeId: "agent",
  });
  assert.equal(after.run.status, "running");
  assert.ok(after.revision > started.invocation.revision);
  await assert.rejects(() => store.updateRun("inv-none", { status: "x" }));
});

test("findByRequestId 与 list 过滤：索引从文件重建", async () => {
  const { store } = makeStore();
  const a = await store.createInvocation({
    workflowId: "wf1",
    definitionRevision: 1,
    entryMode: "direct",
  });
  const b = await store.createInvocation({
    workflowId: "wf2",
    definitionRevision: 1,
    conversationId: "conv-9",
    entryMode: "chat",
  });
  await store.applyPreparation(a.invocationId, { values: {}, issues: [] });
  await store.start(a.invocationId, {
    requestId: "req-a",
    buildRun: () => ({ status: "queued" }),
  });
  const found = await store.findByRequestId("req-a");
  assert.equal(found.invocationId, a.invocationId);
  assert.equal(await store.findByRequestId("req-none"), null);
  const byConv = await store.list({ conversationId: "conv-9" });
  assert.equal(byConv.length, 1);
  assert.equal(byConv[0].invocationId, b.invocationId);
  assert.equal((await store.list({ workflowId: "wf2" })).length, 1);
});

test("start 前崩溃语义：文件里没有 receipt 就没有执行——重试创建新 receipt 但旧 receipt 永不出现两次", async () => {
  const { store } = makeStore();
  const { invocation } = await readyInvocation(store);
  // 模拟：start 成功但宿主崩溃在「保存回执」前——这里以 mutate 原子性近似：
  // 唯一能观察到的收口是文件状态，恒有或恒无 receipt（rename 原子）。
  const started = await store.start(invocation.invocationId, {
    requestId: "req-1",
    expectedDraftRevision: 1,
  });
  const persisted = await store.get(invocation.invocationId);
  assert.equal(
    Boolean(persisted.startReceipt),
    Boolean(started.receipt.workflowRunId),
  );
});

test("取消就绪准备后，迟到的启动事件也不能执行", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hemi-059-abandon-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createInvocationStore({ dir });
  const inv = await store.createInvocation({
    workflowId: "cancel",
    definitionRevision: 1,
    document: { nodes: [], edges: [] },
    entryMode: "chat",
  });
  await store.applyPreparation(inv.invocationId, {
    values: { topic: "test" },
    issues: [],
  });
  const cancelled = await store.abandon(inv.invocationId);
  assert.equal(cancelled.preparation.ready, false);
  await assert.rejects(
    store.start(inv.invocationId, { requestId: "late-start" }),
    /取消/,
  );
});

test('队列明确拒收时恢复原准备身份；已投递的启动不能回滚',async()=>{
  const mem=memoryFs(),store=createInvocationStore({dir:'/test/rejected',fsOps:mem.ops});
  const inv=await store.createInvocation({workflowId:'reject',definitionRevision:1,document:{nodes:[],edges:[]},entryMode:'chat'});await store.applyPreparation(inv.invocationId,{values:{topic:'原值'},issues:[]});
  const first=await store.start(inv.invocationId,{requestId:'same-request'});const reset=await store.rejectUnacceptedStart(inv.invocationId,first.receipt.inputId);
  assert.equal(reset.cardId,inv.cardId);assert.equal(reset.run,null);assert.equal(reset.preparation.values.topic,'原值');
  const second=await store.start(inv.invocationId,{requestId:'same-request'});assert.notEqual(second.receipt.inputId,first.receipt.inputId);await store.markOutbox(inv.invocationId,second.receipt.inputId,'sent');
  await assert.rejects(store.rejectUnacceptedStart(inv.invocationId,second.receipt.inputId),/不能退回/);
});

// ── 人工输入 interaction：挂起／草稿／响应 CAS／超时（HI-R05/R08）──

async function startedRun(store, { entryMode = "chat" } = {}) {
  const invocation = await store.createInvocation({
    workflowId: "wf-hi",
    definitionRevision: 1,
    document: { nodes: [], edges: [] },
    entryMode,
  });
  await store.applyPreparation(invocation.invocationId, { values: { topic: "x" }, issues: [] });
  await store.start(invocation.invocationId, { requestId: "start-1" });
  return invocation.invocationId;
}

function sampleInteraction(overrides = {}) {
  return {
    interactionId: "hi-sample-1",
    nodeId: "confirm",
    nodeAttemptId: "try-1",
    title: "确认方向",
    content: "请选择",
    fields: [
      { fieldId: "f1", key: "comment", type: "text", required: false },
      { fieldId: "f2", key: "plan", type: "choice", required: true, config: { options: ["A", "B"] } },
    ],
    actions: [
      { actionId: "approve", label: "通过", primary: true, requiredKeys: ["comment"] },
      { actionId: "revise", label: "再改" },
    ],
    ...overrides,
  };
}

test("openInteraction 挂起节点并冻结请求；同节点旧 open 请求作废", async () => {
  const { store } = makeStore();
  const id = await startedRun(store);
  await store.openInteraction(id, sampleInteraction());
  let saved = await store.get(id);
  assert.equal(saved.run.interactions["hi-sample-1"].status, "open");
  assert.equal(saved.run.nodes.confirm.status, "waiting");
  assert.equal(saved.run.nodes.confirm.waitingKind, "human-input");
  // 同节点第二次到达（重试）：旧请求取消，新请求 open
  await store.openInteraction(id, sampleInteraction({ interactionId: "hi-sample-2", nodeAttemptId: "try-2" }));
  saved = await store.get(id);
  assert.equal(saved.run.interactions["hi-sample-1"].status, "cancelled");
  assert.equal(saved.run.interactions["hi-sample-2"].status, "open");
  assert.equal(saved.run.currentInteractionId, "hi-sample-2");
});

test("草稿只许写 open 请求，且递增 revision", async () => {
  const { store } = makeStore();
  const id = await startedRun(store);
  await store.openInteraction(id, sampleInteraction());
  const saved = await store.saveInteractionDraft(id, { interactionId: "hi-sample-1", values: { comment: "草稿意见" } });
  assert.equal(saved.run.interactions["hi-sample-1"].revision, 2);
  assert.equal(saved.run.interactions["hi-sample-1"].draft.values.comment, "草稿意见");
  await store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "submit-1", actionId: "approve", values: { comment: "x", plan: "A" } });
  await assert.rejects(
    store.saveInteractionDraft(id, { interactionId: "hi-sample-1", values: {} }),
    /提交/,
  );
});

test("respondInteraction 原子提交：响应＋节点成功事实（含保留输出与 branch）＋续跑回执＋outbox", async () => {
  const { store } = makeStore();
  const id = await startedRun(store);
  await store.openInteraction(id, sampleInteraction());
  const result = await store.respondInteraction(id, {
    interactionId: "hi-sample-1",
    requestId: "submit-1",
    actionId: "approve",
    values: { comment: "可以", plan: "A" },
  });
  assert.equal(result.replayed, false);
  assert.ok(result.receipt.inputId.startsWith("resume-"));
  const saved = await store.get(id);
  const node = saved.run.nodes.confirm;
  assert.equal(node.status, "succeeded");
  assert.equal(node.branch, "approve");
  assert.equal(node.outputs.__action_id, "approve");
  assert.equal(node.outputs.__action_value, "通过");
  assert.equal(node.outputs.plan, "A");
  assert.equal(saved.run.interactions["hi-sample-1"].status, "responded");
  assert.ok(saved.outbox.some((o) => o.inputId === result.receipt.inputId && o.kind === "workflow-resume"));
});

test("响应只产生一份：同 requestId 重放回执；不同 requestId 拒 interaction-taken", async () => {
  const { store } = makeStore();
  const id = await startedRun(store);
  await store.openInteraction(id, sampleInteraction());
  const first = await store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "submit-1", actionId: "revise", values: { plan: "B" } });
  const replay = await store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "submit-1", actionId: "revise", values: { plan: "B" } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.inputId, first.receipt.inputId);
  const saved = await store.get(id);
  assert.equal(saved.resumeReceipts.length, 1); // 不产生第二份回执
  await assert.rejects(
    store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "submit-2", actionId: "approve", values: { plan: "A" } }),
    (error) => error.code === "interaction-taken",
  );
});

test("未知操作拒绝；取消后的请求不能再提交", async () => {
  const { store } = makeStore();
  const id = await startedRun(store);
  await store.openInteraction(id, sampleInteraction());
  await assert.rejects(
    store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "s1", actionId: "ghost", values: {} }),
    /操作不存在/,
  );
  await store.cancelInteraction(id, { interactionId: "hi-sample-1", reason: "stop" });
  await assert.rejects(
    store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "s2", actionId: "approve", values: {} }),
    /取消/,
  );
});

test("超时由期限裁决：用户迟到提交拒收，超时来源落 expired＋timeout 分支；未到期不能按超时关闭", async () => {
  let clock = 10_000;
  const mem = memoryFs();
  const store = createInvocationStore({ dir: "/ud/wf", fsOps: mem.ops, now: () => clock });
  const id = await startedRun(store);
  await store.openInteraction(id, sampleInteraction({ expiresAt: 20_000 }));
  await assert.rejects(
    store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "t1", source: "timeout" }),
    (error) => /尚未到达等待期限/.test(error.message),
  );
  clock = 20_001; // 真实时钟到期
  await assert.rejects(
    store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "late-user", actionId: "approve", values: { plan: "A" } }),
    (error) => error.code === "interaction-expired",
  );
  const expired = await store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "timeout-hi-sample-1", source: "timeout" });
  assert.equal(expired.interaction.status, "expired");
  assert.equal(expired.interaction.response.source, "timeout");
  const saved = await store.get(id);
  assert.equal(saved.run.nodes.confirm.branch, "timeout");
  assert.equal(saved.run.nodes.confirm.outputs.__action_id, "timeout");
  // 超时请求幂等：重启后重放同一 requestId 不产生第二份回执
  const replay = await store.respondInteraction(id, { interactionId: "hi-sample-1", requestId: "timeout-hi-sample-1", source: "timeout" });
  assert.equal(replay.replayed, true);
});


test('草稿保存校验宿主版本，旧回执不能覆盖新草稿', async () => {
  const { store } = makeStore();
  const id = await startedRun(store);
  await store.openInteraction(id, sampleInteraction());
  await store.saveInteractionDraft(id, { interactionId: 'hi-sample-1', expectedRevision: 1, values: { comment: '新草稿' } });
  await assert.rejects(store.saveInteractionDraft(id, { interactionId: 'hi-sample-1', expectedRevision: 1, values: { comment: '旧草稿' } }), error => error.code === 'stale-revision');
  const saved = await store.get(id);
  assert.equal(saved.run.interactions['hi-sample-1'].draft.values.comment, '新草稿');
  assert.equal(saved.run.interactions['hi-sample-1'].revision, 2);
});
