// 059 人工输入强退子进程：run＝挂起等待（写 marker 后保活等被 SIGKILL）；
// reopen＝新服务同盘恢复（只读断言→草稿在→提交续跑完成）。由
// verify-059-human-input-crash.mjs 以 CRASH_* 环境变量驱动。
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
const dir = process.env.CRASH_DIR;
const marker = process.env.CRASH_MARKER;
const done = process.env.CRASH_DONE;

const { __resetWorkflowServiceForTests, initWorkflowService } = await import(
  "../src/main/workflows/workflow-service.mjs"
);
const {
  initConversationFlowService,
  __resetConversationFlowServiceForTests,
} = await import("../src/main/services/conversation-flow-service.mjs");
const { createWorkflowNodeAgent } = await import(
  "../src/main/agent/workflow-node-agent.mjs"
);

function buildService() {
  __resetWorkflowServiceForTests();
  __resetConversationFlowServiceForTests();
  let service = null;
  const modelCalls = [];
  const flowService = initConversationFlowService({
    dir: path.join(dir, "conversations"),
    log: null,
    runtimeFactory: (cid) => ({
      async start({ runId, envelope }) {
        const controller = flowService.controllerFor(cid);
        const generation = controller.getSnapshot().generation;
        const outcome = await service.flowRouter.start({
          runId, envelope, generation,
          applyFact: (f) => controller.applyFact(f),
        });
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
            modelCalls.push(nodeSpec.id);
            return {
              texts: ['完成。\n```json\n{"draft": "强退前草稿", "result": "返工完成"}\n```'],
              lastText: "", usages: [], requests: 1, toolNames: [],
            };
          },
          abort() {}, dispose() {},
        },
        nodeSpec, executionOwner,
      }),
      release: () => {},
    }),
  });
  return { service, modelCalls };
}

const HI_DOC = {
  nodes: [
    { id: "in", type: "hemi-input", meta: { position: { x: 0, y: 0 } }, data: { parameters: [{ key: "topic", type: "string", required: true }] } },
    { id: "writer", type: "hemi-agent", meta: { position: { x: 1, y: 0 } }, data: { title: "起草", goal: "起稿", outputSchema: { type: "object", properties: { draft: { type: "string" } } } } },
    { id: "hi", type: "hemi-human-input", meta: { position: { x: 2, y: 0 } }, data: {
      title: "确认", content: "草稿：{{writer.draft}}",
      fields: [
        { fieldId: "f-plan", key: "plan", label: "方案", type: "choice", required: true, config: { options: ["方案甲", "方案乙"] } },
        { fieldId: "f-comment", key: "comment", label: "批注", type: "text" },
      ],
      actions: [{ actionId: "approve", label: "通过", primary: true, requiredKeys: ["comment"] }],
      wait: { mode: "timeout", timeoutMs: 10 * 60 * 1000 },
    } },
    { id: "fixer", type: "hemi-agent", meta: { position: { x: 3, y: 1 } }, data: { title: "返工", goal: "返工", outputSchema: { type: "object", properties: { result: { type: "string" } } } } },
    { id: "deliver", type: "hemi-deliver", meta: { position: { x: 4, y: 0 } }, data: { title: "交付", summary: "交付", artifacts: [{ label: "批注", binding: { kind: "node-output", nodeId: "hi", key: "comment", type: "string" } }] } },
  ],
  edges: [
    { sourceNodeID: "in", targetNodeID: "writer" },
    { sourceNodeID: "writer", targetNodeID: "hi" },
    { sourceNodeID: "hi", targetNodeID: "deliver", sourcePortID: "approve" },
    { sourceNodeID: "hi", targetNodeID: "fixer", sourcePortID: "timeout" },
    { sourceNodeID: "fixer", targetNodeID: "deliver" },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === "run") {
  const { service } = buildService();
  await service.definitionStore.saveDraft({ workflowId: "wf-crash", name: "强退链路", document: HI_DOC });
  await service.definitionStore.publish({ workflowId: "wf-crash" });
  const prepared = await service.prepare({ workflowId: "wf-crash", conversationId: "conv-crash", entryMode: "direct" });
  await service.updatePreparation({ invocationId: prepared.invocationId, values: { topic: "强退" } });
  const started = await service.startPrepared({ invocationId: prepared.invocationId, requestId: "crash-start", conversationId: "conv-crash" });
  if (!started.ok) throw new Error("startPrepared 失败：" + started.code);
  for (let i = 0; i < 200; i++) {
    const inv = await service.getInvocation(prepared.invocationId);
    if (inv.run?.status === "waiting" && inv.run.waiting?.kind === "human-input") {
      // 挂起后落一份草稿再让父进程杀
      await service.saveInteractionDraft({
        invocationId: prepared.invocationId,
        interactionId: inv.run.currentInteractionId,
        values: { comment: "强退前草稿内容" },
      });
      fs.writeFileSync(marker, JSON.stringify({ invocationId: prepared.invocationId, interactionId: inv.run.currentInteractionId, expiresAt: inv.run.interactions[inv.run.currentInteractionId].expiresAt }), "utf8");
      break;
    }
    await sleep(50);
  }
  if (!fs.existsSync(marker)) throw new Error("未进入挂起");
  setInterval(() => {}, 60000); // 保活等 SIGKILL
}

if (mode === "reopen") {
  const { service, modelCalls } = buildService();
  const state = JSON.parse(fs.readFileSync(marker, "utf8"));
  const sleep2 = sleep;
  // 启动恢复是异步的；等它完成（getInvocation 内部 await startup）
  const invocation = await service.getInvocation(state.invocationId);
  const checks = [];
  checks.push(["waiting 保留（不转 interrupted）", invocation.run.status === "waiting"]);
  const interaction = invocation.run.interactions[state.interactionId];
  checks.push(["interaction 仍 open", interaction.status === "open"]);
  checks.push(["草稿跨进程恢复", interaction.draft?.values?.comment === "强退前草稿内容"]);
  checks.push(["期限未从重启重计", interaction.expiresAt === state.expiresAt]);
  await sleep2(200);
  checks.push(["恢复期零模型调用", modelCalls.length === 0]);
  checks.push(["未自动续跑（无 resume 回执）", (invocation.resumeReceipts ?? []).length === 0]);
  // 显式提交 → 续跑完成
  const submitted = await service.submitInteraction({
    invocationId: state.invocationId,
    interactionId: state.interactionId,
    requestId: "crash-submit",
    actionId: "approve",
    values: { plan: "方案乙", comment: "强退后提交" },
  });
  let final = invocation;
  for (let i = 0; i < 200; i++) {
    final = await service.getInvocation(state.invocationId);
    if (["completed", "failed"].includes(final.run?.status)) break;
    await sleep2(50);
  }
  checks.push(["提交续跑完成", final.run.status === "completed"]);
  checks.push(["节点走 approve 分支", final.run.nodes.hi.branch === "approve"]);
  checks.push(["交付含提交值", final.run.nodes.deliver.outputs["批注"] === "强退后提交"]);
  fs.writeFileSync(done, JSON.stringify(checks.map(([name, ok]) => ({ name, ok: Boolean(ok) }))), "utf8");
}
