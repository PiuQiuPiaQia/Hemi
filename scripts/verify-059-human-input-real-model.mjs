// 059 人工输入 · 真实模型链路：用户真实模型配置（拷贝生产 profiles，safeStorage
// 同机可解），定义发布→运行→挂起→提交→续跑完成全链。SSE mock 不参与。
// 覆盖：上游真实输出→挂起（表单冻结）→提交（宿主校验+CAS）→只走选中分支→交付；
// 等待时限真实到期走超时分支；fixtures 场景的表单与只读记录渲染。
// HEMI_SMOKE_TEST=1 npx electron scripts/verify-059-human-input.mjs
import { app, safeStorage, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const temp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "hemi059-hi-")),
);
app.setName("hemi");
app.setPath("userData", path.join(temp, "ud"));

const marker = `HI059-${Date.now()}`;
const results = [];
let win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = null) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? " " + JSON.stringify(detail) : ""}`,
  );
  assert.ok(ok, name);
};
const wait = async (name, fn, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`等待超时：${name}`);
};
const js = (code) => win.webContents.executeJavaScript(code);

// 真实模型：拷贝生产配置（app.setName('hemi') 保证 safeStorage 可解密）
fs.mkdirSync(path.join(temp, "ud"), { recursive: true });
const realUd = path.join(process.env.HOME, "Library/Application Support/hemi");
for (const name of ["text-model-profiles.json", "text-model.json", "onboarding.json"]) {
  const from = path.join(realUd, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(temp, "ud", name));
}

const hiDoc = ({ timeoutMs = null } = {}) => ({
  nodes: [
    {
      id: "in",
      type: "hemi-input",
      meta: { position: { x: 60, y: 100 } },
      data: {
        title: "输入",
        parameters: [{ key: "topic", label: "主题", type: "string", required: true }],
      },
    },
    {
      id: "writer",
      type: "hemi-agent",
      meta: { position: { x: 320, y: 100 } },
      data: {
        title: "起草",
        goal: `按主题起稿（标记 HI059_WRITER）`,
        inputBindings: [{ kind: "parameter", key: "topic", type: "string" }],
        outputSchema: {
          type: "object",
          properties: { draft: { type: "string" } },
        },
      },
    },
    {
      id: "hi",
      type: "hemi-human-input",
      meta: { position: { x: 580, y: 100 } },
      data: {
        title: "确认方向",
        content: "草稿：{{writer.draft}}\n\n请选择后续方案并补充批注。",
        fields: [
          {
            fieldId: "f-plan",
            key: "plan",
            label: "方案",
            type: "choice",
            required: true,
            config: { options: ["方案甲", "方案乙"] },
          },
          {
            fieldId: "f-comment",
            key: "comment",
            label: "批注",
            type: "text",
            config: { prefillText: "默认意见" },
          },
        ],
        actions: [
          { actionId: "approve", label: "通过", primary: true, requiredKeys: ["comment"] },
          ...(timeoutMs ? [] : [{ actionId: "revise", label: "再改一版" }]),
        ],
        wait: timeoutMs ? { mode: "timeout", timeoutMs } : { mode: "forever" },
      },
    },
    {
      id: "fixer",
      type: "hemi-agent",
      meta: { position: { x: 840, y: 180 } },
      data: {
        title: "返工",
        goal: `按批注返工（标记 HI059_FIXER）`,
        inputBindings: [{ kind: "node-output", nodeId: "hi", key: "comment", type: "string" }],
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
      },
    },
    {
      id: "deliver",
      type: "hemi-deliver",
      meta: { position: { x: 1100, y: 100 } },
      data: {
        title: "交付",
        summary: "本次确认结果",
        artifacts: [
          {
            label: "批注",
            binding: { kind: "node-output", nodeId: "hi", key: "comment", type: "string" },
          },
        ],
      },
    },
  ],
  edges: [
    { sourceNodeID: "in", targetNodeID: "writer" },
    { sourceNodeID: "writer", targetNodeID: "hi" },
    { sourceNodeID: "hi", targetNodeID: "deliver", sourcePortID: "approve" },
    { sourceNodeID: "hi", targetNodeID: "fixer", sourcePortID: timeoutMs ? "timeout" : "revise" },
    { sourceNodeID: "fixer", targetNodeID: "deliver" },
  ],
});

app.whenReady().then(async () => {
  let fatal;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      path.join(app.getPath("userData"), "onboarding.json"),
      JSON.stringify({
        version: 1, phase: "complete", step: "done",
        completedAt: Date.now(), updatedAt: Date.now(),
      }),
    );
    const { registerAllIpcHandlers } = await import("../src/main/ipc/index.mjs");
    registerAllIpcHandlers();
    const { createMainWindow } = await import("../src/main/windows/main-window.mjs");
    await createMainWindow();
    win = (await import("../src/main/state.mjs")).state.mainWindow;
    await wait("窗口可执行脚本", () => js("document.readyState === 'complete'"));

    const bridge = (method, ...args) =>
      js(`window.hemiVoice.${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);

    // ── 场景一：提交走选中分支 ──
    await bridge("workflowSaveDraft", "wf-hi", hiDoc(), "人工链路");
    await bridge("workflowPublish", "wf-hi");
    const prepared = await bridge("workflowPrepare", {
      workflowId: "wf-hi", conversationId: "conv-hi-verify", entryMode: "direct",
    });
    await bridge("workflowUpdatePreparation", {
      invocationId: prepared.invocationId, values: { topic: "选题" },
    });
    const started = await bridge("workflowStartPrepared", {
      invocationId: prepared.invocationId, requestId: `hi-start-${marker}`, conversationId: "conv-hi-verify",
    });
    check("受理成功（真实 060 队列）", started.ok, started.code ?? null);

    const suspended = await wait("挂起等待人工输入", async () => {
      const inv = await bridge("workflowGetInvocation", prepared.invocationId);
      return inv?.run?.status === "waiting" && inv?.run?.waiting?.kind === "human-input"
        ? inv : null;
    });
    const interaction = suspended.run.interactions[suspended.run.currentInteractionId];
    check("上游真实输出已代入内容（变量已替换）", !interaction.content.includes("{{") && !interaction.content.includes("【未取到】") && interaction.content.trim().length > 10, interaction.content.slice(0, 120));
    check("动态选项冻结为上游列表", JSON.stringify(interaction.fields.find((f) => f.key === "plan").options) === JSON.stringify(["方案甲", "方案乙"]));
    check("预填冻结", interaction.fields.find((f) => f.key === "comment").prefill === "默认意见");
    // 槽位释放（flow phase idle／activeRunId 清空）由 service 集成单测
    // 「人工输入：上游真实输出后挂起（槽位释放零模型资源）」断言，本脚本不重复。

    const draft = await bridge("workflowSaveInteractionDraft", {
      invocationId: prepared.invocationId, interactionId: interaction.interactionId,
      values: { comment: "先写一半" },
    });
    check("草稿落盘并递增版本", draft.ok && draft.revision >= 2, draft);
    let rejected = null;
    try {
      await bridge("workflowSubmitInteraction", {
        invocationId: prepared.invocationId, interactionId: interaction.interactionId,
        requestId: `hi-bad-${marker}`, actionId: "approve", values: { comment: "", plan: "" },
      });
    } catch (error) {
      rejected = String(error?.message ?? error);
    }
    check("缺项提交被宿主拒绝", /批注|方案/.test(rejected ?? ""), rejected);
    let badOption = null;
    try {
      await bridge("workflowSubmitInteraction", {
        invocationId: prepared.invocationId, interactionId: interaction.interactionId,
        requestId: `hi-badopt-${marker}`, actionId: "approve", values: { comment: "x", plan: "方案丙" },
      });
    } catch (error) {
      badOption = String(error?.message ?? error);
    }
    check("列表外选项拒绝", /选项不在本次列表内/.test(badOption ?? ""), badOption);

    const submitted = await bridge("workflowSubmitInteraction", {
      invocationId: prepared.invocationId, interactionId: interaction.interactionId,
      requestId: `hi-ok-${marker}`, actionId: "approve",
      values: { comment: `可以·${marker}`, plan: "方案乙" },
      expectedRevision: draft.revision,
    });
    check("提交受理（受理与最终结果分离）", submitted.ok !== false, submitted.code ?? null);
    const finished = await wait("续跑完成", async () => {
      const inv = await bridge("workflowGetInvocation", prepared.invocationId);
      return ["completed", "failed"].includes(inv?.run?.status) ? inv : null;
    });
    check("运行完成", finished.run.status === "completed", finished.run.issues ?? null);
    check("人工输入节点走 approve 分支", finished.run.nodes.hi.branch === "approve" && finished.run.nodes.hi.outputs.__action_id === "approve");
    check("提交值进入下游交付", finished.run.nodes.deliver.outputs["批注"] === `可以·${marker}`, finished.run.nodes.deliver.outputs);
    check("未选分支（返工）跳过", finished.run.nodes.fixer.status === "skipped");

    // ── 场景二：真实时钟到期走超时分支 ──
    await bridge("workflowSaveDraft", "wf-hi2", hiDoc({ timeoutMs: 1500 }), "超时链路");
    await bridge("workflowPublish", "wf-hi2");
    const prepared2 = await bridge("workflowPrepare", {
      workflowId: "wf-hi2", conversationId: "conv-hi-verify-2", entryMode: "direct",
    });
    await bridge("workflowUpdatePreparation", { invocationId: prepared2.invocationId, values: { topic: "超时" } });
    await bridge("workflowStartPrepared", {
      invocationId: prepared2.invocationId, requestId: `hi2-start-${marker}`, conversationId: "conv-hi-verify-2",
    });
    const suspended2 = await wait("第二条链路挂起", async () => {
      const inv = await bridge("workflowGetInvocation", prepared2.invocationId);
      return inv?.run?.status === "waiting" && inv?.run?.waiting?.kind === "human-input" ? inv : null;
    });
    const interaction2 = suspended2.run.interactions[suspended2.run.currentInteractionId];
    check("等待期限已持久", Number.isFinite(interaction2.expiresAt) && interaction2.expiresAt > Date.now());
    const finished2 = await wait("真实到期走超时分支完成", async () => {
      const inv = await bridge("workflowGetInvocation", prepared2.invocationId);
      return ["completed", "failed"].includes(inv?.run?.status) ? inv : null;
    }, 30000);
    const record2 = finished2.run.interactions[interaction2.interactionId];
    check("超时不是人工响应", record2.response.source === "timeout" && record2.status === "expired");
    check("超时走独立分支（返工执行）", finished2.run.nodes.hi.branch === "timeout" && finished2.run.nodes.fixer.status === "succeeded", finished2.run.issues ?? null);
    check("超时链路完成", finished2.run.status === "completed");

    // ── 场景三：fixtures 表单与只读记录真实渲染（dev server 由外层提供）──
    if (!process.env.HEMI059_HIRM_FIXTURES_URL) {
      console.log("SKIP fixtures 渲染检查（未提供 HEMI059_HIRM_FIXTURES_URL）");
    } else {
    // fixtures 页不能开在带 preload 的应用窗口（contextBridge 只读冲突），独立裸窗口。
    const fixturesWin = new BrowserWindow({
      show: false, width: 1440, height: 900, useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win = fixturesWin;
    const fixturesUrl = `${process.env.HEMI059_HIRM_FIXTURES_URL}/fixtures.html?scene=workflow-card-human-input`;
    await fixturesWin.loadURL(fixturesUrl);
    await wait("fixtures 场景挂载", () =>
      js(`Boolean(document.querySelector('[data-testid="workflow-interaction"]'))`),
    );
    const form = await js(`({
      open: document.querySelector('[data-hi-status="open"]') !== null,
      fields: [...document.querySelectorAll('[data-hi-status="open"] label')].length,
      buttons: [...document.querySelectorAll('.h59-hi-actions button')].map((b) => b.textContent.trim().replace(/（.*/, '')),
      record: document.querySelector('[data-testid="workflow-interaction-record"]') !== null,
      recordChosen: document.querySelector('[data-testid="workflow-interaction-record"] .h59-hi-chosen strong')?.textContent ?? null,
    })`);
    check("挂起表单渲染（字段＋动作按钮）", form.open && form.fields >= 2 && form.buttons.includes("按此选题继续"), form);
    check("已提交只读记录渲染", form.record && form.recordChosen === "按此选题继续", form);
    }

    console.log(`HEMI059_HIRM_RESULT ${JSON.stringify({ marker, results })}`);
  } catch (error) {
    fatal = error;
    console.error(`HEMI059_HIRM_FAIL ${error?.stack ?? error}`);
  } finally {
    /* 无本地服务 */
  }
  setTimeout(() => {
    if (fatal) process.exit(1);
    const failed = results.filter((r) => !r.ok);
    console.log(
      `HEMI059_HIRM_SUMMARY ${results.length - failed.length}/${results.length}`,
    );
    app.exit(failed.length || fatal ? 1 : 0);
  }, 300);
});
