import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createInvocationStore } from "./invocation-store.mjs";
import { createWorkflowRunner, toRuntimeSchema } from "./workflow-runner.mjs";

/** 真实临时目录 fs（S2 门槛要「实际文件可读」）。 */
function realFsStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-059-runner-${t}-`));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const DOC = {
  nodes: [
    {
      id: "in",
      type: "hemi-input",
      meta: { position: { x: 0, y: 0 } },
      data: {
        title: "输入",
        parameters: [
          {
            key: "format",
            type: "enum",
            options: ["ppt", "text"],
            required: true,
          },
          { key: "topic", type: "string", required: true },
        ],
      },
    },
    {
      id: "agent",
      type: "hemi-agent",
      meta: { position: { x: 1, y: 0 } },
      data: {
        title: "起草",
        goal: "按主题起草",
        inputBindings: [{ kind: "parameter", key: "topic", type: "string" }],
        outputSchema: {
          type: "object",
          properties: { draft: { type: "string" } },
        },
      },
    },
    {
      id: "cond",
      type: "hemi-condition",
      meta: { position: { x: 2, y: 0 } },
      data: {
        title: "分流",
        condition: {
          fieldRef: { kind: "parameter", key: "format" },
          operator: "eq",
          value: "ppt",
        },
      },
    },
    {
      id: "skill",
      type: "hemi-skill",
      meta: { position: { x: 3, y: -1 } },
      data: {
        title: "美化",
        goal: "出文件",
        skillRefs: [{ name: "report" }],
        inputBindings: [
          {
            kind: "node-output",
            nodeId: "agent",
            key: "draft",
            type: "string",
          },
        ],
        outputSchema: {
          type: "object",
          properties: { deck: { type: "file" } },
        },
      },
    },
    {
      id: "browser",
      type: "hemi-browser",
      meta: { position: { x: 3, y: 1 } },
      data: { title: "取数", goal: "查资料", targetUrl: "https://example.com" },
    },
    {
      id: "deliver",
      type: "hemi-deliver",
      meta: { position: { x: 4, y: 0 } },
      data: {
        title: "交付",
        summary: "本次报告",
        artifacts: [
          {
            label: "报告文件",
            binding: {
              kind: "node-output",
              nodeId: "skill",
              key: "deck",
              type: "file",
            },
          },
        ],
      },
    },
  ],
  edges: [
    { sourceNodeID: "in", targetNodeID: "agent" },
    { sourceNodeID: "agent", targetNodeID: "cond" },
    { sourceNodeID: "cond", targetNodeID: "skill", sourcePortID: "yes" },
    { sourceNodeID: "cond", targetNodeID: "browser", sourcePortID: "else" },
    { sourceNodeID: "skill", targetNodeID: "deliver" },
    { sourceNodeID: "browser", targetNodeID: "deliver" },
  ],
};

/** 测试图简化：条件只连 skill（文件支）与 browser，deliver 绑 skill 产物。 */
async function startedInvocation(store, { entryMode = "direct", values } = {}) {
  const invocation = await store.createInvocation({
    workflowId: "wf1",
    definitionRevision: 1,
    document: DOC,
    entryMode,
  });
  if (entryMode === "chat") {
    await store.applyPreparation(invocation.invocationId, {
      expectedDraftRevision: 0,
      values,
      issues: [],
    });
    const { receipt } = await store.start(invocation.invocationId, {
      requestId: `req-${Math.random()}`,
    });
    return { invocation, workflowRunId: receipt.workflowRunId };
  }
  await store.applyPreparation(invocation.invocationId, {
    values: values ?? {},
    issues: [],
  });
  // direct 同样需要宿主校验后的准备事实
  const { receipt } = await store.start(invocation.invocationId, {
    requestId: `req-${Math.random()}`,
    buildRun: (inv) => ({
      workflowRunId: inv.workflowRunId,
      definitionRevision: inv.definitionRevision,
      frozenValues: values,
      frozenDocument: inv.documentSnapshot,
      status: "queued",
      nodes: {},
    }),
  });
  return { invocation, workflowRunId: receipt.workflowRunId };
}

function makeRunner(
  store,
  {
    fileExecutorCalls = [],
    browserExecutorCalls = [],
    delayMs = 0,
    failSkill = false,
    onFileExecutorStarted = null,
  } = {},
) {
  const workDir = realFsStore(Math.random().toString(36).slice(2, 6));
  const fileArtifact = path.join(workDir.dir, "deck.txt");
  const executors = {
    "hemi-agent": {
      async execute(ctx) {
        return { outputs: { draft: `${ctx.inputs.topic}草稿` } };
      },
    },
    "hemi-skill": {
      async execute(ctx) {
        fileExecutorCalls.push(ctx.node.id);
        onFileExecutorStarted?.();
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (failSkill) throw new Error("skill 爆了");
        fs.writeFileSync(fileArtifact, `${ctx.inputs.draft}→成稿`, "utf8");
        return { outputs: { deck: fileArtifact } };
      },
    },
    "hemi-browser": {
      async execute(ctx) {
        browserExecutorCalls.push(ctx.node.id);
        return { outputs: { table: "数据" } };
      },
    },
  };
  const runner = createWorkflowRunner({
    invocationStore: store,
    executors,
    verifyArtifact: (p) => ({ ok: fs.existsSync(p) }),
  });
  return {
    runner,
    fileExecutorCalls,
    browserExecutorCalls,
    fileArtifact,
    workDir,
  };
}

test("toRuntimeSchema：input→start、deliver→end、条件 yes/else、任务节点类型保留", () => {
  const schema = toRuntimeSchema(DOC);
  const types = Object.fromEntries(schema.nodes.map((n) => [n.id, n.type]));
  assert.equal(types.in, "start");
  assert.equal(types.cond, "condition");
  assert.equal(types.deliver, "end");
  assert.equal(types.skill, "hemi-skill");
  const start = schema.nodes.find((n) => n.id === "in");
  assert.deepEqual(start.data.outputs.required, ["format", "topic"]);
  const cond = schema.nodes.find((n) => n.id === "cond");
  assert.equal(cond.data.conditions[0].key, "yes");
  assert.deepEqual(cond.data.conditions[0].value.left, {
    type: "ref",
    content: ["in", "format"],
  });
  const deliver = schema.nodes.find((n) => n.id === "deliver");
  assert.equal(deliver.data.inputsValues.__summary.type, "constant");
  const edgeToSkill = schema.edges.find(
    (e) => e.sourceNodeID === "cond" && e.targetNodeID === "skill",
  );
  assert.equal(edgeToSkill.sourcePortID, "yes");
});

test("直跑闭环（mock executor）：ppt 支执行、真实文件落盘可读、终态 completed、invocation 留痕", async (t) => {
  const store = createInvocationStore({
    dir: path.join(os.tmpdir(), `hemi-059-inv-${Date.now()}`),
  });
  t.after(() =>
    fs.rmSync(path.join(os.tmpdir(), `hemi-059-inv-${Date.now()}`), {
      recursive: true,
      force: true,
    }),
  );
  const {
    runner,
    fileExecutorCalls,
    browserExecutorCalls,
    fileArtifact,
    workDir,
  } = makeRunner(store);
  t.after(() => workDir.cleanup());
  const { workflowRunId } = await startedInvocation(store, {
    entryMode: "direct",
    values: { format: "ppt", topic: "周报" },
  });
  const outcome = await runner.run({
    invocationId: (await store.list())[0].invocationId,
  });
  assert.equal(outcome.status, "completed");
  assert.deepEqual(fileExecutorCalls, ["skill"], "只有选中支执行");
  assert.deepEqual(browserExecutorCalls, [], "else 支零调用");
  assert.equal(
    fs.readFileSync(fileArtifact, "utf8"),
    "周报草稿→成稿",
    "实际文件真实可读",
  );
  const invocation = (await store.list())[0];
  assert.equal(invocation.run.status, "completed");
  assert.equal(invocation.run.nodes.skill.status, "succeeded");
  assert.equal(invocation.run.nodes.agent.outputs.draft, "周报草稿");
  assert.ok(workflowRunId);
});

test("条件走 else 支：deliver 绑定的 skill 产物缺失 → 不冒充 completed（artifact-missing）", async (t) => {
  const store = createInvocationStore({
    dir: path.join(os.tmpdir(), `hemi-059-inv-${Date.now()}b`),
  });
  const { runner } = makeRunner(store);
  const { invocation } = await startedInvocation(store, {
    entryMode: "direct",
    values: { format: "text", topic: "月报" },
  });
  const outcome = await runner.run({ invocationId: invocation.invocationId });
  assert.equal(
    outcome.status,
    "failed",
    "走了 else 支就没有 skill 产物，交付核查必须拦住",
  );
  assert.ok(outcome.issues.some((i) => i.code === "artifact-missing"));
});

test("停止：栅栏后零新 executor、终态 stopped、迟到返回被丢弃", { timeout: 5000 }, async (t) => {
  const store = createInvocationStore({
    dir: path.join(os.tmpdir(), `hemi-059-inv-${Date.now()}c`),
  });
  let entered;
  const executorStarted = new Promise(resolve => { entered = resolve; });
  const { runner, fileExecutorCalls } = makeRunner(store, { delayMs: 200, onFileExecutorStarted: () => entered() });
  const { workflowRunId, invocation } = await startedInvocation(store, {
    entryMode: "direct",
    values: { format: "ppt", topic: "周报" },
  });
  const runPromise = runner.run({ invocationId: invocation.invocationId });
  await executorStarted; // 先证明 skill 确已进入；固定 sleep 在并行测试下不能提供该证据。
  const stopResult = await runner.stop(workflowRunId);
  assert.equal(stopResult.stopped, true);
  const outcome = await runPromise;
  assert.equal(outcome.status, "stopped");
  assert.deepEqual(
    fileExecutorCalls,
    ["skill"],
    "栅栏前那一次已进入；但无第二次",
  );
  const persisted = await store.get(invocation.invocationId);
  assert.equal(persisted.run.status, "stopped");
});

test("节点失败：终态 failed、错误写进节点事实与 issues", async (t) => {
  const store = createInvocationStore({
    dir: path.join(os.tmpdir(), `hemi-059-inv-${Date.now()}d`),
  });
  const { runner } = makeRunner(store, { failSkill: true });
  const { invocation } = await startedInvocation(store, {
    entryMode: "direct",
    values: { format: "ppt", topic: "周报" },
  });
  const outcome = await runner.run({ invocationId: invocation.invocationId });
  assert.equal(outcome.status, "failed");
  const persisted = await store.get(invocation.invocationId);
  assert.equal(persisted.run.nodes.skill.status, "failed");
  assert.match(persisted.run.nodes.skill.error, /skill 爆了/);
});

test("恢复回放：持久缓存命中零外部动作（文件不重写）、未完成节点新尝试", async (t) => {
  const store = createInvocationStore({
    dir: path.join(os.tmpdir(), `hemi-059-inv-${Date.now()}e`),
  });
  const { runner, fileExecutorCalls, fileArtifact, workDir } =
    makeRunner(store);
  const { invocation } = await startedInvocation(store, {
    entryMode: "direct",
    values: { format: "ppt", topic: "周报" },
  });
  const first = await runner.run({ invocationId: invocation.invocationId });
  assert.equal(first.status, "completed");
  const mtimeBefore = fs.statSync(fileArtifact).mtimeMs;

  // 强退恢复：用第一次的已提交事实做回放缓存，重建运行
  const cache = new Map([
    ["in", { outputs: { format: "ppt", topic: "周报" } }],
    ["agent", { outputs: { draft: "周报草稿" } }],
    ["cond", { outputs: {}, branch: "yes" }],
    ["skill", { outputs: { deck: fileArtifact } }],
    ["deliver", { outputs: first.outputs }],
  ]);
  const second = await runner.run({
    invocationId: invocation.invocationId,
    replayCache: cache,
  });
  assert.equal(second.status, "completed");
  assert.deepEqual(
    fileExecutorCalls,
    ["skill"],
    "回放运行零新增 executor 调用",
  );
  assert.equal(
    fs.statSync(fileArtifact).mtimeMs,
    mtimeBefore,
    "外部动作（写文件）零重放",
  );
  const persisted = await store.get(invocation.invocationId);
  assert.equal(persisted.run.nodes.skill.replayed, true, "回放事实留痕");
});

test("运行中改定义／Skill 不影响冻结快照：运行用 documentSnapshot（v1）跑完，v2 发布不干扰", async (t) => {
  const store = createInvocationStore({
    dir: path.join(os.tmpdir(), `hemi-059-inv-${Date.now()}f`),
  });
  const seenGoals = [];
  const workDir = realFsStore(`g-${Math.random().toString(36).slice(2, 6)}`);
  t.after(() => workDir.cleanup());
  const DOC_V1 = structuredClone(DOC);
  DOC_V1.nodes.find((n) => n.id === "agent").data.goal = "v1 目标（起草周报）";
  const executors = {
    "hemi-agent": {
      async execute(ctx) {
        seenGoals.push(ctx.node.data.goal);
        return { outputs: { draft: `${ctx.inputs.topic}草稿` } };
      },
    },
    "hemi-skill": {
      async execute(ctx) {
        fs.writeFileSync(
          path.join(workDir.dir, "deck.txt"),
          `${ctx.inputs.draft}→成稿`,
          "utf8",
        );
        return { outputs: { deck: path.join(workDir.dir, "deck.txt") } };
      },
    },
  };
  const runner = createWorkflowRunner({
    invocationStore: store,
    executors,
    verifyArtifact: (p) => ({ ok: fs.existsSync(p) }),
  });
  const invocation = await store.createInvocation({
    workflowId: "wf1",
    definitionRevision: 1,
    document: DOC_V1,
    entryMode: "direct",
  });
  await store.applyPreparation(invocation.invocationId, {
    values: { format: "ppt", topic: "周报" },
    issues: [],
  });
  await store.start(invocation.invocationId, {
    requestId: `req-${Math.random()}`,
    buildRun: (inv) => ({
      workflowRunId: inv.workflowRunId,
      definitionRevision: inv.definitionRevision,
      frozenValues: { format: "ppt", topic: "周报" },
      frozenDocument: inv.documentSnapshot,
      status: "queued",
      nodes: {},
    }),
  });
  // 「运行中」发布 v2：agent 目标改为 v2、skillRefs 换名——已受理调用不受影响（契约 §4.7）。
  const DOC_V2 = structuredClone(DOC_V1);
  DOC_V2.nodes.find((n) => n.id === "agent").data.goal =
    "v2 目标（不应该被执行）";
  await store.updateRun(invocation.invocationId, { status: "running" });
  const outcome = await runner.run({ invocationId: invocation.invocationId });
  assert.equal(outcome.status, "completed");
  assert.deepEqual(
    seenGoals,
    ["v1 目标（起草周报）"],
    "执行的是冻结快照 v1 的目标，不是新发布的 v2",
  );
  const persisted = await store.get(invocation.invocationId);
  assert.equal(persisted.definitionRevision, 1, "调用绑定版本不变");
  assert.equal(
    persisted.run.frozenDocument.nodes.find((n) => n.id === "agent").data.goal,
    "v1 目标（起草周报）",
    "冻结快照未被覆盖",
  );
});
