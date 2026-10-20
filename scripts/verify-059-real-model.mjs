// 真实模型＋生产 IPC＋真实文件交付。只复制指定提供方的加密配置，退出即清理隔离数据。
// HEMI_SMOKE_TEST=1 HEMI_059_PROVIDER_ID=mp-legacy npx electron scripts/verify-059-real-model.mjs
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const temp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "hemi059-real-product-")),
);
app.setName("hemi");
app.setPath("userData", path.join(temp, "ud"));
fs.mkdirSync(app.getPath("userData"), { recursive: true });
const evidence = path.resolve(
  process.env.HEMI059_EVIDENCE ?? ".visual/workflow/vision/059-fix-validation/real-model",
);
fs.mkdirSync(evidence, { recursive: true });
const cfg = JSON.parse(
  fs.readFileSync(
    path.join(
      os.homedir(),
      "Library/Application Support/hemi-dev/text-model-profiles.json",
    ),
    "utf8",
  ),
);
const provider = cfg.providers.find(
  (p) => p.id === (process.env.HEMI_059_PROVIDER_ID ?? "mp-legacy"),
);
if (!provider) throw new Error("指定提供方不存在");
const model = provider.models[0],
  modelKey = `${provider.id}/${model.id}`;
fs.writeFileSync(
  path.join(app.getPath("userData"), "text-model-profiles.json"),
  JSON.stringify({
    version: 3,
    defaultModelId: modelKey,
    providers: [{ ...provider, models: [model] }],
  }),
);
fs.writeFileSync(
  path.join(app.getPath("userData"), "onboarding.json"),
  JSON.stringify({
    version: 1,
    phase: "complete",
    step: "done",
    completedAt: Date.now(),
    updatedAt: Date.now(),
  }),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const result = { model: model.model, modelKey };
  let win;
  try {
    await (await import("../src/main/ipc/index.mjs")).registerAllIpcHandlers();
    await (
      await import("../src/main/windows/main-window.mjs")
    ).createMainWindow();
    win = (await import("../src/main/state.mjs")).state.mainWindow;
    const js = (code) => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 100 && !(await js("Boolean(window.hemiVoice)")); i++)
      await sleep(50);
    const file = path.join(temp, "ud/workspace/default/real-report.md"),
      marker = `059真实链路-${Date.now()}`;
    const document = {
      nodes: [
        {
          id: "in",
          type: "hemi-input",
          meta: { position: { x: 60, y: 80 } },
          data: {
            title: "输入",
            parameters: [
              {
                key: "topic",
                label: "主题",
                type: "string",
                required: true,
                defaultValue: marker,
              },
            ],
          },
        },
        {
          id: "a",
          type: "hemi-agent",
          meta: { position: { x: 320, y: 80 } },
          data: {
            title: "生成验收文件",
            goal: `用 write 工具创建 ${file}。文件正文原样写入绑定输入 topic 的值。创建后用 read 工具核对。不要省略实际工具调用。最终输出 JSON 的 file 字段为这个绝对路径。`,
            inputBindings: [
              { kind: "parameter", key: "topic", type: "string" },
            ],
            outputSchema: {
              type: "object",
              properties: { file: { type: "file" } },
            },
          },
        },
        {
          id: "end",
          type: "hemi-deliver",
          meta: { position: { x: 580, y: 80 } },
          data: {
            title: "交付",
            summary: "真实文件验收",
            artifacts: [
              {
                label: "file",
                binding: {
                  kind: "node-output",
                  nodeId: "a",
                  key: "file",
                  type: "file",
                },
              },
            ],
          },
        },
      ],
      edges: [
        { sourceNodeID: "in", targetNodeID: "a" },
        { sourceNodeID: "a", targetNodeID: "end" },
      ],
    };
    const prep = await js(
      `(async()=>{const draft=await window.hemiVoice.workflowSaveDraft('wf-real-model',${JSON.stringify(document)},'真实模型验收');await window.hemiVoice.workflowPublish('wf-real-model',draft.draftRevision);return window.hemiVoice.workflowPrepare({workflowId:'wf-real-model',entryMode:'direct'})})()`,
    );
    assert.equal(prep.ready, true);
    const start = Date.now();
    result.receipt = await js(
      `window.hemiVoice.workflowStartPrepared({invocationId:${JSON.stringify(prep.invocationId)},cardId:${JSON.stringify(prep.cardId)},expectedDraftRevision:${prep.draftRevision},conversationId:${JSON.stringify(prep.conversationId)},requestId:'real-model-product'})`,
    );
    result.ackMs = Date.now() - start;
    assert.equal(result.receipt.ok, true);
    const service = (
      await import("../src/main/workflows/workflow-service.mjs")
    ).getWorkflowService();
    let invocation;
    for (let i = 0; i < 1800; i++) {
      invocation = await service.getInvocation(prep.invocationId);
      if (["completed", "failed"].includes(invocation.run?.status)) break;
      await sleep(50);
    }
    result.status = invocation.run.status;
    result.issues = invocation.run.issues;
    result.actualFileExists = fs.existsSync(file);
    result.markerMatches =
      result.actualFileExists && fs.readFileSync(file, "utf8").includes(marker);
    result.usageCalls = invocation.usageCalls;
    if (result.actualFileExists)
      fs.copyFileSync(file, path.join(evidence, "delivered-report.md"));
    assert.equal(result.status, "completed");
    assert.equal(result.markerMatches, true);
    assert.ok(result.usageCalls.length >= 1);
    const flows = (
      await import("../src/main/services/conversation-flow-service.mjs")
    ).getConversationFlowService();
    result.artifactCount = Object.values(
      flows.controllerFor(prep.conversationId).getSnapshot().artifacts,
    ).length;
    assert.equal(result.artifactCount, 1);
    for (
      let i = 0;
      i < 100 &&
      flows.controllerFor(prep.conversationId).getSnapshot().phase !== "idle";
      i++
    )
      await sleep(50);
    const followUp = await js(
      `window.hemiVoice.chatTextModel({conversationId:${JSON.stringify(prep.conversationId)},inputSource:'text',messages:[{role:'user',content:'读取刚才工作流实际交付的文件，只回复文件原文。请实际使用 read 工具，不重新运行流程。'}]})`,
    );
    result.followUp = followUp;
    assert.ok(
      JSON.stringify(followUp).includes(marker),
      "后续普通对话可读取工作流真实文件且回答原文标记",
    );
    result.invocationCount = (
      await service.listInvocations({ workflowId: "wf-real-model" })
    ).length;
    assert.equal(result.invocationCount, 1);
    result.passed = true;
    fs.writeFileSync(
      path.join(evidence, "completed.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
  } catch (error) {
    result.passed = false;
    result.error = error.stack;
  } finally {
    fs.writeFileSync(
      path.join(evidence, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log("HEMI059_REAL_MODEL_RESULT=" + JSON.stringify(result));
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(result.passed ? 0 : 1);
  }
});
