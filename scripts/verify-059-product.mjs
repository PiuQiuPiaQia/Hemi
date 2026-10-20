// 059 合并后产品回归：生产 IPC / 装配 / Pi / 实际命令，只有外部 provider 为本地可控端点。
// HEMI_SMOKE_TEST=1 npx electron scripts/verify-059-product.mjs
import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const temp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "hemi059-product-")),
);
if (process.env.HEMI059_DPR1 === "1")
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setName("hemi");
app.setPath("userData", path.join(temp, "ud"));
const evidence = path.resolve(
  process.env.HEMI059_EVIDENCE ??
    ".visual/workflow/vision/059-fix-validation/product",
);
// 人工真机走查模式只准备生产环境／可控 provider 并录屏；所有界面动作由原生工具完成。
const designSample =
  process.env.HEMI059_DESIGN === "1" || process.env.HEMI059_ALIGNMENT === "1";
const manual =
  process.env.HEMI059_MANUAL === "1" || process.env.HEMI059_ALIGNMENT === "1";
fs.mkdirSync(evidence, { recursive: true });
const marker = `HEMI059-${Date.now()}`,
  file = path.join(temp, "ud/workspace/default/result.txt"),
  started = path.join(temp, "started"),
  late = path.join(temp, "late"),
  phase = path.join(temp, "phase"),
  queueStarted = path.join(temp, "queue-started"),
  queueDone = path.join(temp, "queue-done"),
  resourceStarted = path.join(temp, "resource-started");
const results = [],
  wire = [],
  errors = [];
let waitOffered = false;
let sourceTaskId, skillPath;
const formatSourceA = path.join(temp, "ud/workspace/default/source-A.txt"),
  formatSourceB = path.join(temp, "ud/workspace/default/source-B.txt");
let win,
  debuggerSession,
  frames = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = null) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? " " + JSON.stringify(detail) : ""}`,
  );
  assert.ok(ok, name);
};
const wait = async (name, fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(60);
  }
  throw new Error(`等待超时：${name}`);
};
const js = (code) => win.webContents.executeJavaScript(code);
const click = async (text, scope = "document") => {
  if (text === "保存并发布") text = "保存工作流";
  return js(
    `(()=>{const root=${scope};const b=[...root.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}||n.getAttribute('aria-label')===${JSON.stringify(text)});if(!b||b.disabled)return false;b.focus();b.click();return true;})()`,
  );
};
const row = (name, label) =>
  click(
    label,
    `[...document.querySelectorAll('[data-testid="workflow-row"]')].find(n=>n.querySelector('strong')?.textContent===${JSON.stringify(name)})`,
  );
const setInput = (selector, value) =>
  js(
    `(()=>{const t=document.querySelector(${JSON.stringify(selector)});if(!t)throw Error('input missing');Object.getOwnPropertyDescriptor(t instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(t,${JSON.stringify(value)});t.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
  );
const chat = async (text) => {
  await setInput("textarea[placeholder]", text);
  await js(
    `document.querySelector('textarea[placeholder]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
  );
};
const settleAnimations = () =>
  js(
    `(async()=>{const frame=()=>new Promise(r=>requestAnimationFrame(r));for(let i=0;i<3;i++){await frame();await frame();await Promise.all(document.getAnimations().filter(a=>(a.playState==='running'||a.pending)&&Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))}await frame();await frame();})()`,
  );
const shot = async (name) => {
  await settleAnimations();
  fs.writeFileSync(
    path.join(evidence, `${name}.png`),
    (await win.webContents.capturePage()).toPNG(),
  );
};
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw),
      turnMessages = body.messages.slice(Math.max(0, body.messages.findLastIndex(message => message.role === "user"))),
      text = JSON.stringify(turnMessages),
      hasTool = turnMessages.some((m) => m.role === "tool");
    const nodeText = turnMessages
      .flatMap((m) =>
        m.role === "user"
          ? typeof m.content === "string"
            ? [m.content]
            : (m.content ?? []).map((c) => c.text ?? "")
          : [],
      )
      .join("\n");
    const currentText = nodeText.includes('［工作流节点执行') ? nodeText : nodeText.split('\n\n')[0];
    const formatDate = nodeText.match(/- date = ([^\n]+)/)?.[1],
      formatSource = nodeText.match(/- source = ([^\n]+)/)?.[1];
    const formatOutput = path.join(
      temp,
      "ud/workspace/default",
      `report-${formatDate}.txt`,
    );
    wire.push({
      toolResults: body.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content),
      model: body.model,
      resourceWaiter: currentText.includes("059_RESOURCE_WAITER"),
      fallbackStage: currentText.includes("059_FALLBACK"),
      afterFallback: currentText.includes("059_AFTER_FALLBACK"),
      resumeNote: currentText.includes("用户继续时补充 = 登录已完成，使用验证结果"),
      auto: currentText.includes("059_AUTO") && currentText.includes("工作流节点执行"),
      node: currentText.includes("工作流节点执行"),
      at: Date.now(),
      tools: (body.tools ?? []).map((t) => t.function?.name),
    });
    let content = "新任务已完成",
      tool;
    if (currentText.includes("059_FALLBACK") && body.model === "model-A") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "controlled temporary provider failure" },
        }),
      );
      return;
    }
    const latestUser = [...body.messages].reverse().find(message => message.role === 'user');
    const latestText = typeof latestUser?.content === 'string' ? latestUser.content : (latestUser?.content ?? []).map(block => block.text ?? '').join('\n');
    const instruction = latestText.split('\n\n')[0];
    const preparingId = [...latestText.matchAll(/"invocationId":"([^"\n]+)"/g)].at(-1)?.[1];
    const preparationChange = !latestText.includes('［工作流节点执行') && (instruction.includes('主题') || instruction.includes('改成文字版')) && preparingId;
    if (preparationChange) {
      const last = body.messages.at(-1);
      const functionCall = [...body.messages].reverse().find(message => message.tool_calls?.length)?.tool_calls.at(-1)?.function;
      const args = functionCall?.arguments ? JSON.parse(functionCall.arguments) : {};
      if (last?.role !== 'tool') tool = { name: 'workflow_preparation', arguments: { action: 'get', invocationId: preparingId } };
      else if (args.action === 'get') {
        const record = JSON.parse(last.content);
        tool = { name: 'workflow_preparation', arguments: { action: 'update', invocationId: record.invocationId, expectedDraftRevision: record.draftRevision, set: instruction.includes('改成文字版') ? { format: 'text' } : { topic: marker } } };
      } else content = '参数已更新，请点击卡片开始运行';
    }
    else if (currentText.includes("059_FORMAT") && !hasTool)
      tool = { name: "read", arguments: { path: formatSource } };
    else if (
      currentText.includes("059_FORMAT") &&
      turnMessages.filter((m) => m.role === "tool").length === 1
    )
      tool = {
        name: "write",
        arguments: {
          path: formatOutput,
          content: `${formatDate} ${JSON.stringify(body.messages.find((m) => m.role === "tool").content)}`,
        },
      };
    else if (currentText.includes("059_FORMAT"))
      content =
        "```json\n" + JSON.stringify({ result: formatOutput }) + "\n```";
    else if (currentText.includes("QUEUE_BLOCK") && !hasTool)
      tool = {
        name: "bash",
        arguments: {
          command: `printf started > '${queueStarted}'; sleep 2; printf done > '${queueDone}'`,
        },
      };
    else if (currentText.includes("059_AUTO") && !hasTool)
      tool = {
        name: "task",
        arguments: {
          agent: "fixer",
          description: "完成节点路由验证",
          prompt: "059_ROLE_CHILD 请只输出 JSON 围栏，result 为路由完成",
        },
      };
    else if (currentText.includes("059_ROLE_CHILD"))
      content = "```json\n" + JSON.stringify({ result: "路由完成" }) + "\n```";
    else if (currentText.includes("059_RESOURCE_HOLDER") && !hasTool)
      tool = { name: "app_open", arguments: { app: "com.apple.calculator" } };
    else if (
      currentText.includes("059_RESOURCE_HOLDER") &&
      turnMessages.filter((m) => m.role === "tool").length === 1
    )
      tool = {
        name: "bash",
        arguments: { command: `printf held > '${resourceStarted}'; sleep 2` },
      };
    else if (currentText.includes("059_RESOURCE_WAITER") && !hasTool)
      tool = { name: "app_open", arguments: { app: "com.apple.calculator" } };
    else if (currentText.includes("059_SKILL") && !hasTool)
      tool = { name: "read", arguments: { path: skillPath } };
    else if (currentText.includes("059_DESKTOP") && !hasTool)
      tool = { name: "app_open", arguments: { app: "com.apple.calculator" } };
    else if (currentText.includes("059_FILE") && !hasTool)
      tool = { name: "write", arguments: { path: file, content: marker } };
    else if (currentText.includes("059_STOP") && !hasTool)
      tool = {
        name: "bash",
        arguments: {
          command: `printf started > '${started}'; sleep 4; printf late > '${late}'`,
        },
      };
    else if (currentText.includes("059_HANDOFF") && !hasTool)
      tool = {
        name: "bash",
        arguments: {
          command: `printf started > '${started}'; sleep 1; printf stage > '${phase}'`,
        },
      };
    else if (currentText.includes("059_WAIT") && !hasTool && !waitOffered) {
      waitOffered = true;
      tool = {
        name: "workflow_wait",
        arguments: { message: "请完成登录后点击继续" },
      };
    } else if (currentText.includes("059_DENY") && !hasTool)
      tool = { name: "app_open", arguments: { app: "com.apple.calculator" } };
    else if (currentText.includes("059_MISSING"))
      content =
        "```json\n" +
        JSON.stringify({
          result: path.join(temp, "ud/workspace/default/never-created.txt"),
        }) +
        "\n```";
    else if (currentText.includes("工作流节点执行"))
      content =
        "```json\n" +
        JSON.stringify({ result: currentText.includes("059_FILE") ? file : "完成" }) +
        "\n```";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "059-call",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    send({
      role: "assistant",
      ...(tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-059",
                type: "function",
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.arguments),
                },
              },
            ],
          }
        : { content }),
    });
    send({}, tool ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const doc = (goal, { required = false, fileOutput = false } = {}) => ({
  nodes: [
    {
      id: "in",
      type: "hemi-input",
      meta: { position: { x: 60, y: 100 } },
      data: {
        title: "输入",
        parameters: [{ key: "topic", label: "主题", type: "string", required }],
      },
    },
    {
      id: "execute",
      type: "hemi-agent",
      meta: { position: { x: 320, y: 100 } },
      data: {
        title: "执行步骤",
        goal,
        inputBindings: [{ kind: "parameter", key: "topic", type: "string" }],
        outputSchema: {
          type: "object",
          properties: { result: { type: fileOutput ? "file" : "string" } },
        },
      },
    },
    {
      id: "deliver",
      type: "hemi-deliver",
      meta: { position: { x: 580, y: 100 } },
      data: {
        title: "交付",
        summary: "本次结果",
        artifacts: [
          {
            label: "结果",
            binding: {
              kind: "node-output",
              nodeId: "execute",
              key: "result",
              type: fileOutput ? "file" : "string",
            },
          },
        ],
      },
    },
  ],
  edges: [
    { sourceNodeID: "in", targetNodeID: "execute" },
    { sourceNodeID: "execute", targetNodeID: "deliver" },
  ],
});
app.whenReady().then(async () => {
  let fatal;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
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
    fs.writeFileSync(
      path.join(app.getPath("userData"), "text-model-profiles.json"),
      JSON.stringify({
        version: 3,
        defaultModelId: "review/a",
        roleModels: {
          main: "review/a",
          fixer: "review/b",
          fallback: "review/b",
        },
        providers: [
          {
            id: "review",
            name: "本地回归",
            baseUrl,
            encryptedApiKey: safeStorage
              .encryptString("local-test")
              .toString("base64"),
            models: [
              {
                id: "a",
                model: designSample ? "deepseek-chat" : "model-A",
                supportsVision: false,
              },
              { id: "b", model: "model-B", supportsVision: false },
            ],
          },
        ],
      }),
    );
    const fixtureHistory = (
      await import("../src/main/history/task-history.mjs")
    ).createTaskHistory({
      dir: path.join(app.getPath("userData"), "task-history"),
    });
    const sourceTask = fixtureHistory.createRecord({
      taskText: "空白创建前已有的成功任务",
      inputSource: "text",
    });
    fixtureHistory.finishRecord(sourceTask.taskId, {
      outcome: "complete",
      resultText: "已按主题整理为摘要",
    });
    sourceTaskId = sourceTask.taskId;
    const originalTask = fs.readFileSync(
      path.join(
        app.getPath("userData"),
        "task-history",
        sourceTaskId + ".json",
      ),
      "utf8",
    );
    const { registerAllIpcHandlers } =
      await import("../src/main/ipc/index.mjs");
    await registerAllIpcHandlers();
    const { createMainWindow } =
      await import("../src/main/windows/main-window.mjs");
    await createMainWindow();
    win = (await import("../src/main/state.mjs")).state.mainWindow;
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    await wait("主界面", () =>
      js(`Boolean(document.querySelector('textarea'))`),
    );
    debuggerSession = win.webContents.debugger;
    debuggerSession.attach("1.3");
    await debuggerSession.sendCommand("Page.enable");
    const screencastOptions = { format: "jpeg", quality: 75, everyNthFrame: 2 };
    debuggerSession.on("message", (_e, method, params) => {
      if (method === "Page.loadEventFired")
        void debuggerSession
          .sendCommand("Page.startScreencast", screencastOptions)
          .catch(() => {});
      if (method !== "Page.screencastFrame") return;
      void debuggerSession.sendCommand("Page.screencastFrameAck", {
        sessionId: params.sessionId,
      });
      const name = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
      fs.mkdirSync(path.join(evidence, "frames"), { recursive: true });
      fs.writeFileSync(
        path.join(evidence, "frames", name),
        Buffer.from(params.data, "base64"),
      );
      frames.push({ name, at: Date.now() });
    });
    await debuggerSession.sendCommand(
      "Page.startScreencast",
      screencastOptions,
    );
    const flows = (
      await import("../src/main/services/conversation-flow-service.mjs")
    ).getConversationFlowService();
    const service = (
      await import("../src/main/workflows/workflow-service.mjs")
    ).getWorkflowService();
    const publish = async (id, document) =>
      js(
        `(async()=>{const draft=await window.hemiVoice.workflowSaveDraft(${JSON.stringify(id)},${JSON.stringify(document)},${JSON.stringify(id)});return window.hemiVoice.workflowPublish(${JSON.stringify(id)},draft.draftRevision)})()`,
      );
    await publish(
      "file-flow",
      doc("059_FILE 写出本次文件", { required: true, fileOutput: true }),
    );
    await publish(
      "direct-file-flow",
      doc("059_FILE 直接交付本次文件", { fileOutput: true }),
    );
    await publish("stop-flow", doc("059_STOP 在途命令"));
    await publish(
      "missing-flow",
      doc("059_MISSING 声明缺失文件", { fileOutput: true }),
    );
    await publish("handoff-flow", doc("059_HANDOFF 在阶段结束后交接"));
    await publish("wait-flow", doc("059_WAIT 需要用户登录时等待"));
    await publish("deny-flow", doc("059_DENY 请求打开计算器测试授权"));
    await publish("auto-flow", doc("059_AUTO 编排主模型派给 fixer"));
    const fallbackGraph = doc("059_FALLBACK 验证失败后备用接管");
    fallbackGraph.nodes.splice(2, 0, {
      id: "after",
      type: "hemi-agent",
      meta: { position: { x: 500, y: 100 } },
      data: {
        goal: "059_AFTER_FALLBACK 后续节点回到主模型",
        outputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
        },
      },
    });
    fallbackGraph.edges = [
      { sourceNodeID: "in", targetNodeID: "execute" },
      { sourceNodeID: "execute", targetNodeID: "after" },
      { sourceNodeID: "after", targetNodeID: "deliver" },
    ];
    fallbackGraph.nodes.at(-1).data.artifacts[0].binding.nodeId = "after";
    await publish("fallback-flow", fallbackGraph);
    fs.mkdirSync(path.dirname(formatSourceA), { recursive: true });
    fs.writeFileSync(formatSourceA, "SOURCE_A_UNIQUE");
    fs.writeFileSync(formatSourceB, "SOURCE_B_UNIQUE");
    const formatGraph = doc(
      "059_FORMAT 按绑定日期、格式和来源文件交付文字报告",
      { fileOutput: true },
    );
    formatGraph.nodes[0].data.parameters = [
      {
        key: "date",
        label: "日期",
        type: "date",
        required: true,
        defaultValue: "2026-10-17",
      },
      {
        key: "format",
        label: "格式",
        type: "enum",
        required: true,
        options: ["ppt", "text"],
        defaultValue: "ppt",
      },
      {
        key: "source",
        label: "来源文件",
        type: "file",
        required: true,
        defaultValue: formatSourceA,
      },
    ];
    formatGraph.nodes[1].data.inputBindings =
      formatGraph.nodes[0].data.parameters.map((p) => ({
        kind: "parameter",
        key: p.key,
        type: p.type,
      }));
    await publish("format-flow", formatGraph);
    const skillDir = path.join(temp, "fixture-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: workflow-fixture\ntitle: ${designSample ? "数据分析" : "workflow-fixture"}\ndescription: 059 独立验证技能\n---\nHEMI_SKILL_MARKER：按主题整理摘要。\n`,
    );
    const skills = (
      await import("../src/main/ipc/skills.ipc.mjs")
    ).getSkillService();
    await skills.importDirectory(skillDir);
    const lease = skills.snapshot();
    skillPath = path.join(
      lease.items.find((s) => s.name === "workflow-fixture").path,
      "SKILL.md",
    );
    lease.release();
    const mixed = doc("059_SKILL 先读取挂载的 Skill 方法");
    mixed.nodes[1].type = "hemi-skill";
    mixed.nodes[1].data.skillRefs = [{ name: "workflow-fixture" }];
    mixed.nodes.splice(
      2,
      0,
      {
        id: "normal",
        type: "hemi-agent",
        meta: { position: { x: 500, y: 100 } },
        data: {
          goal: "普通执行整理摘要",
          inputBindings: [
            {
              kind: "node-output",
              nodeId: "execute",
              key: "result",
              type: "string",
            },
          ],
          outputSchema: {
            type: "object",
            properties: { result: { type: "string" } },
          },
        },
      },
      {
        id: "desktop",
        type: "hemi-desktop",
        meta: { position: { x: 740, y: 100 } },
        data: {
          goal: "059_DESKTOP 打开计算器，成功后按输出 schema 回答",
          applicationRef: "com.apple.calculator",
          outputSchema: {
            type: "object",
            properties: { result: { type: "string" } },
          },
        },
      },
    );
    mixed.edges = [
      { sourceNodeID: "in", targetNodeID: "execute" },
      { sourceNodeID: "execute", targetNodeID: "normal" },
      { sourceNodeID: "normal", targetNodeID: "desktop" },
      { sourceNodeID: "desktop", targetNodeID: "deliver" },
    ];
    mixed.nodes.at(-1).data.artifacts[0].binding.nodeId = "desktop";
    await publish("mixed-flow", mixed);
    for (const [id, goal] of [
      ["resource-holder", "059_RESOURCE_HOLDER 保持桌面资源至当前阶段结束"],
      ["resource-waiter", "059_RESOURCE_WAITER 验证等待资源时停止"],
    ]) {
      const graph = doc(goal);
      graph.nodes[1].type = "hemi-desktop";
      graph.nodes[1].data.applicationRef = "com.apple.calculator";
      await publish(id, graph);
    }

    if (manual) {
      if (
        process.env.HEMI059_DESIGN === "1" ||
        process.env.HEMI059_ALIGNMENT === "1"
      )
        await (
          await import("./verify-059-design-sample.mjs")
        ).prepareDesignSample(service);
      win.setMinimumSize(320, 400);
      win.setContentSize(Number(process.env.HEMI059_WIDTH ?? 1440), 900);
      win.show();
      win.focus();
      if (process.env.HEMI059_ALIGNMENT === "1") {
        await (
          await import("./verify-059-alignment.mjs")
        ).captureAlignment({ win, js, evidence });
        return;
      }
      console.log("HEMI059_MANUAL_READY=" + JSON.stringify({ evidence, temp }));
      while (!fs.existsSync(path.join(evidence, "stop"))) {
        if (win.isDestroyed()) throw Error("原生走查窗口被关闭");
        const captureRequest = path.join(evidence, "capture.json");
        if (fs.existsSync(captureRequest)) {
          const { name } = JSON.parse(fs.readFileSync(captureRequest, "utf8"));
          fs.rmSync(captureRequest);
          if (!/^[a-z0-9-]+$/.test(name)) throw Error("无效截图名");
          const [width] = win.getContentSize();
          fs.writeFileSync(
            path.join(evidence, name + ".png"),
            (await win.webContents.capturePage()).resize({ width }).toPNG(),
          );
          const facts = await js(
            `({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,body:document.body.innerText,menus:[...document.querySelectorAll('[role=menu]')].map(e=>({rect:e.getBoundingClientRect().toJSON(),opacity:getComputedStyle(e).opacity,bg:getComputedStyle(e).backgroundColor,z:getComputedStyle(e).zIndex,ancestors:[e.parentElement,e.parentElement?.parentElement].filter(Boolean).map(p=>({class:p.className,opacity:getComputedStyle(p).opacity,transform:getComputedStyle(p).transform}))})),geometry:[...document.querySelectorAll('.h59-sidebar,.h59-sidebar>.h24-sidebar-new,.h59-nav-label,.h59-nav-row,.h59-row,.h59-row-actions')].map(node=>({class:node.className,rect:node.getBoundingClientRect().toJSON(),font:getComputedStyle(node).font,padding:getComputedStyle(node).padding,gap:getComputedStyle(node).gap}))})`,
          );
          fs.writeFileSync(
            path.join(evidence, name + ".json"),
            JSON.stringify(facts, null, 2),
          );
        }
        await sleep(500);
      }
      return;
    }

    await js(`document.querySelector('button[title="工作流"]').click()`);
    await wait("列表", () =>
      js(`document.querySelectorAll('[data-testid="workflow-row"]').length>=6`),
    );
    check("无会话也可进入对话准备", await row("file-flow", "去对话运行"));
    await wait("准备卡", () =>
      js(
        `document.querySelector('[data-testid="workflow-card"][data-status="preparing"]')`,
      ),
    );
    let invocation = (
        await service.listInvocations({ workflowId: "file-flow" })
      )[0],
      cid = invocation.conversationId;
    check(
      "缺参不执行且卡片可见",
      !invocation.startReceipt && wire.length === 0,
    );
    check(
      "缺参开始按钮不可用",
      await js(
        `document.querySelector('[data-testid="workflow-card"] button')?.disabled===false && [...document.querySelectorAll('[data-testid="workflow-card"] button')].find(b=>b.textContent==='开始运行').disabled`,
      ),
    );
    await chat(`主题是 ${marker}`);
    await wait("补参就绪", async () => {
      invocation = await service.getInvocation(invocation.invocationId);
      return (
        invocation.preparation.ready &&
        flows.controllerFor(cid).getSnapshot().phase === "idle"
      );
    });
    check(
      "补参后仍零执行",
      !invocation.startReceipt && wire.every((w) => !w.node),
    );
    check(
      "准备卡显示真实步骤与零进度",
      await js(
        `(()=>{const p=document.querySelector('[data-testid="workflow-card"] [role="progressbar"]');return p?.getAttribute('aria-valuemax')==='3'&&p.getAttribute('aria-valuenow')==='0'})()`,
      ),
    );
    await wait("就绪卡开始按钮可用", () =>
      js(
        `[...document.querySelectorAll('[data-testid="workflow-card"] button')].some(b=>b.textContent==='开始运行'&&!b.disabled)`,
      ),
    );
    check("补齐后开始按钮可用", true);
    await settleAnimations();
    fs.writeFileSync(
      path.join(evidence, "ready-card-facts.json"),
      JSON.stringify(
        await js(
          `[...document.querySelectorAll('[data-testid="workflow-card"] button')].map(b=>({text:b.textContent,disabled:b.disabled,background:getComputedStyle(b).backgroundColor,opacity:getComputedStyle(b).opacity}))`,
        ),
        null,
        2,
      ),
    );
    await shot("01-ready-card");
    await js(
      `document.querySelector('[data-testid="workflow-card"] .h24-model-chip').click()`,
    );
    await wait("选模菜单", () =>
      js(
        `[...document.querySelectorAll('[role="menuitemradio"]')].some(x=>x.textContent.includes('model-B'))`,
      ),
    );
    await js(
      `[...document.querySelectorAll('[role="menuitemradio"]')].find(x=>x.textContent.includes('model-B')).click()`,
    );
    await wait("模型B已持久", async () => {
      invocation = await service.getInvocation(invocation.invocationId);
      return invocation.executionModel?.modelKey === "review/b";
    });
    const staleRevision = invocation.draftRevision;
    await chat(`主题改为 ${marker}`);
    await wait("改参后就绪", async () => {
      invocation = await service.getInvocation(invocation.invocationId);
      return (
        invocation.draftRevision > staleRevision &&
        flows.controllerFor(cid).getSnapshot().phase === "idle"
      );
    });
    check(
      "补参使用对话模型，执行选择仍为 B",
      wire.at(-1).model === "model-A" &&
        invocation.executionModel.modelKey === "review/b",
    );
    let staleRejected = false;
    try {
      await js(
        `window.hemiVoice.workflowStartPrepared({invocationId:${JSON.stringify(invocation.invocationId)},cardId:${JSON.stringify(invocation.cardId)},conversationId:${JSON.stringify(cid)},expectedDraftRevision:${staleRevision},requestId:'stale-request'})`,
      );
    } catch {
      staleRejected = true;
    }
    check(
      "过期参数版本不能启动",
      staleRejected &&
        !(await service.getInvocation(invocation.invocationId)).startReceipt,
    );
    check(
      "卡片启动",
      await click(
        "开始运行",
        `document.querySelector('[data-testid="workflow-card"]')`,
      ),
    );
    await wait("文件交付", async () => {
      invocation = await service.getInvocation(invocation.invocationId);
      return ["completed", "failed"].includes(invocation.run?.status);
    });
    check(
      "真实文件和标记正确",
      invocation.run.status === "completed" &&
        fs.existsSync(file) &&
        fs.readFileSync(file, "utf8") === marker,
      { status: invocation.run.status, issues: invocation.run.issues },
    );
    check(
      "所选模型进入真实节点请求",
      wire.filter((w) => w.node).every((w) => w.model === "model-B"),
      wire
        .filter((w) => w.node)
        .map((w) => ({ model: w.model, toolResults: w.toolResults })),
    );
    const before = wire.length;
    const duplicate = await js(
      `Promise.all([1,2].map(()=>window.hemiVoice.workflowStartPrepared({invocationId:${JSON.stringify(invocation.invocationId)},requestId:${JSON.stringify(`workflow-start-${invocation.invocationId}`)},conversationId:${JSON.stringify(cid)}})))`,
    );
    check(
      "重复请求不重跑",
      duplicate.every((r) => r.ok) && wire.length === before,
      duplicate,
    );
    const cardId = await js(
      `document.querySelector('[data-testid="workflow-card"]').closest('[data-flow-row]')?.getAttribute('data-flow-row')`,
    );
    check(
      "稳定卡片身份",
      flows
        .controllerFor(cid)
        .getSnapshot()
        .timeline.filter((x) =>
          x.parts?.some((p) => p.invocationId === invocation.invocationId),
        )
        .every((x) => Boolean(x.itemId)),
    );
    await shot("02-completed-file");
    await js(
      `window.__workflowPreviewTrigger=[...document.querySelectorAll('[data-testid="workflow-card"] button')].find(button=>button.textContent==='查看过程')`,
    );
    await click(
      "查看过程",
      `document.querySelector('[data-testid="workflow-card"]')`,
    );
    await wait("右侧过程", () =>
      js(
        `Boolean(document.querySelector('[data-testid="workflow-run-preview"]'))`,
      ),
    );
    check(
      "过程在右侧，不离开对话",
      await js(`Boolean(document.querySelector('textarea[placeholder]'))`),
    );
    await shot("03-run-preview");
    await click("查看运行画布");
    await wait("只读运行图", () =>
      js(`document.querySelectorAll('.h59-run-graph .h59-node').length===3`),
    );
    check(
      "运行画布使用同一节点状态",
      await js(
        `[...document.querySelectorAll('.h59-run-graph .h59-node')].every(node=>node.textContent.includes('已完成'))`,
      ),
    );
    await click("收起运行画布");
    win.setMinimumSize(320, 400);
    for (const width of [1440, 1180, 1179, 881, 880, 768, 600, 375]) {
      win.setContentSize(width, 900);
      await sleep(350);
      const layout = await js(
        `(()=>{const p=document.querySelector('.h24-preview'),b=p.getBoundingClientRect();const main=document.querySelector('.h24-main');return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,position:getComputedStyle(p).position,left:b.left,right:b.right,mainWidth:main.getBoundingClientRect().width,modal:p.getAttribute('aria-modal')};})()`,
      );
      check(
        `预览 ${width} 布局与覆盖语义`,
        layout.width === width &&
          !layout.overflow &&
          layout.right <= width + 1 &&
          (width >= 1180
            ? layout.position === "relative" && layout.mainWidth >= 540
            : layout.position === "absolute" && layout.modal === "true"),
        layout,
      );
      if (width === 375 || width === 1440) await shot(`preview-${width}`);
    }
    await js(`document.querySelector('.h24-preview button').focus()`);
    for (let i = 0; i < 15; i++) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
      await sleep(10);
    }
    check(
      "窄窗预览 Tab 焦点不逃逸",
      await js(`Boolean(document.activeElement.closest('.h24-preview'))`),
    );
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait("Esc 收起预览", () =>
      js(`!document.querySelector('.h24-preview')`),
    );
    check(
      "Esc 恢复触发按钮焦点",
      await js(`document.activeElement===window.__workflowPreviewTrigger`),
    );
    check(
      "Esc 后原卡片仍在",
      await js(
        `Boolean(document.querySelector('[data-testid="workflow-card"][data-status="completed"]'))`,
      ),
    );
    win.setContentSize(1440, 900);

    const openStudio = async () => {
      if (
        await js(`!!document.querySelector('[data-testid="workflow-result"]')`)
      )
        await click("返回工作流");
      await js(`document.querySelector('button[title="工作流"]').click()`);
      if (
        await js(`!!document.querySelector('[data-testid="workflow-detail"]')`)
      )
        await click(
          "全部工作流",
          `document.querySelector('[data-testid="workflow-detail"]')`,
        );
      await wait("列表加载", () =>
        js(
          `document.querySelectorAll('[data-testid="workflow-row"]').length>=6`,
        ),
      );
    };
    await openStudio();
    await row("stop-flow", "直接运行");
    await wait("独立运行结果页", () =>
      js(`!!document.querySelector('[data-testid="workflow-result"]')`),
    );
    check(
      "直接运行保留独立结果页",
      await js(`!!document.querySelector('[data-testid="workflow-result"]')`),
    );
    await wait("真实工具已开始", () => fs.existsSync(started));
    let slow = (await service.listInvocations({ workflowId: "stop-flow" }))[0];
    await wait("停止按钮", () =>
      js(
        `[...document.querySelectorAll('[data-testid="workflow-card"][data-status="running"] button')].some(b=>b.textContent==='停止')`,
      ),
    );
    await click(
      "停止",
      `document.querySelector('[data-testid="workflow-card"][data-status="running"]')`,
    );
    await wait("真实停止完成", async () => {
      slow = await service.getInvocation(slow.invocationId);
      return (
        slow.run.status === "stopped" &&
        flows.controllerFor(cid).getSnapshot().phase === "idle"
      );
    });
    await sleep(4200);
    check("停止后无迟到写入", !fs.existsSync(late));
    await shot("04-stopped");
    // 真停止会暂停普通队列；新一次显式运行照正常入口受理。
    await js(
      `window.hemiVoice.flowCommand(${JSON.stringify(cid)},{type:'resumeQueue'})`,
    );
    fs.rmSync(started, { force: true });
    await openStudio();
    await row("handoff-flow", "直接运行");
    await wait("交接工具已开始", () => fs.existsSync(started));
    await click(
      "关联对话",
      `document.querySelector('[data-testid="workflow-result"]')`,
    );
    await wait("切回关联对话", () =>
      js(`!document.querySelector('[data-testid="workflow-result"]')`),
    );
    await chat("QUEUE_NEXT 新任务");
    await wait(
      "普通文字排队",
      () => flows.controllerFor(cid).getSnapshot().pending.length === 1,
    );
    check(
      "忙时普通文字留在待发送",
      !flows
        .controllerFor(cid)
        .getSnapshot()
        .timeline.some(
          (x) => x.kind === "user" && x.text.includes("QUEUE_NEXT"),
        ),
    );
    const pending = flows.controllerFor(cid).getSnapshot().pending[0];
    await js(
      `window.hemiVoice.flowCommand(${JSON.stringify(cid)},{type:'promoteInput',inputId:${JSON.stringify(pending.inputId)}})`,
    );
    await wait(
      "阶段交接和新任务收口",
      () =>
        flows.controllerFor(cid).getSnapshot().phase === "idle" &&
        flows.controllerFor(cid).getSnapshot().pending.length === 0,
    );
    check("交接等待当前工具阶段结束", fs.existsSync(phase));
    const handoff = (
      await service.listInvocations({ workflowId: "handoff-flow" })
    )[0];
    check(
      "旧工作流停止而不恢复",
      handoff.run.status === "stopped",
      handoff.run.status,
    );
    await shot("05-handoff-order");
    await openStudio();
    await row("missing-flow", "直接运行");
    const missing = await wait("缺失文件调用", async () => {
      const inv = (
        await service.listInvocations({ workflowId: "missing-flow" })
      )[0];
      return ["failed", "completed"].includes(inv?.run?.status) ? inv : null;
    });
    check(
      "缺失文件明确失败",
      missing.run.status === "failed" && missing.run.issues.length > 0,
      missing.run.issues,
    );
    await wait("失败结果页更新", () =>
      js(
        `!!document.querySelector('[data-testid="workflow-result"] [data-status="failed"]')`,
      ),
    );
    await click(
      "查看过程",
      `document.querySelector('[data-testid="workflow-result"]')`,
    );
    await wait("结果页过程预览", () =>
      js(`!!document.querySelector('[data-testid="workflow-run-preview"]')`),
    );
    check(
      "结果页查看过程保留运行页",
      await js(`!!document.querySelector('[data-testid="workflow-result"]')`),
    );
    await wait("运行预览标签带真实名称", () =>
      js(
        `[...document.querySelectorAll('.h24-preview [role="tab"]')].some(tab=>tab.textContent.includes('missing-flow'))`,
      ),
    );
    check(
      "运行预览标签可区分不同调用",
      await js(
        `[...document.querySelectorAll('.h24-preview [role="tab"]')].every(tab=>!['工作流','运行过程'].includes(tab.textContent.trim()))`,
      ),
    );
    check(
      "当前步骤错误不重复展示",
      await js(
        `(()=>{const errors=[...document.querySelectorAll('[data-testid="workflow-run-preview"] .h59-error')].map(e=>e.textContent.trim());return new Set(errors).size===errors.length})()`,
      ),
    );
    for (const width of [1440, 1180, 1179, 881, 880, 768, 600, 375]) {
      win.setContentSize(width, 900);
      await sleep(200);
      await js(
        `Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))`,
      );
      const layout = await js(`(()=>{
        const result=document.querySelector('[data-testid="workflow-result"]').getBoundingClientRect();
        const panel=document.querySelector('.h24-preview'), preview=panel.getBoundingClientRect();
        return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
          adjacent:Math.abs(result.right-preview.left)<=1&&Math.abs(result.top-preview.top)<=1,
          resultWidth:result.width,position:getComputedStyle(panel).position,
          left:preview.left,right:preview.right,modal:panel.getAttribute('aria-modal')};
      })()`);
      check(
        `结果页预览 ${width} 实际并排或覆盖主区`,
        layout.width === width &&
          !layout.overflow &&
          layout.right <= width + 1 &&
          (width >= 1180
            ? layout.adjacent && layout.resultWidth >= 540
            : layout.position === "absolute" &&
              Math.abs(layout.left - (width > 880 ? 272 : 48)) <= 1 &&
              layout.modal === "true"),
        layout,
      );
      if (width === 1440) await shot("result-preview-1440");
    }
    win.setContentSize(375, 900);
    await sleep(300);
    check(
      "结果页窄窗无横溢出",
      await js(
        `innerWidth===375 && document.documentElement.scrollWidth<=innerWidth`,
      ),
    );
    await shot("result-preview-375");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait("结果页 Esc 回原卡", () =>
      js(`!document.querySelector('.h24-preview')`),
    );
    await shot("result-375");
    win.setContentSize(1440, 900);
    await sleep(150);
    await openStudio();
    await row("wait-flow", "直接运行");
    const waiting = await wait("真实等待状态", async () => {
      const inv = (
        await service.listInvocations({ workflowId: "wait-flow" })
      )[0];
      return inv?.run?.status === "waiting" ? inv : null;
    });
    check(
      "等待时运行槽仍被同一工作流占有",
      flows.controllerFor(cid).getSnapshot().activeRunId !== null,
    );
    await wait("继续按钮", () =>
      js(
        `[...document.querySelectorAll('[data-testid="workflow-card"][data-status="waiting"] button')].some(b=>b.textContent==='继续运行')`,
      ),
    );
    await shot("06-waiting");
    await setInput(
      'textarea[aria-label="继续时补充信息"]',
      "登录已完成，使用验证结果",
    );
    await click(
      "继续运行",
      `document.querySelector('[data-testid="workflow-card"][data-status="waiting"]')`,
    );
    await wait("等待后继续完成", async () => {
      const inv = await service.getInvocation(waiting.invocationId);
      return inv?.run?.status === "completed";
    });
    check(
      "等待时补充信息进入相关节点请求",
      wire.some((call) => call.resumeNote),
    );
    check(
      "继续沿用原卡片身份",
      flows
        .controllerFor(cid)
        .getSnapshot()
        .timeline.filter((row) =>
          row.parts?.some((part) => part.invocationId === waiting.invocationId),
        ).length === 1,
    );
    await openStudio();
    await row("deny-flow", "直接运行");
    const permission = await wait("应用授权卡", async () => {
      const snapshot = await js("window.hemiVoice.getTaskState()");
      return snapshot.agentPermissions?.find((p) => p.conversationId === cid);
    });
    await sleep(300);
    check(
      "授权没有被自动批准",
      (await js("window.hemiVoice.getTaskState()")).agentPermissions.some(
        (p) => p.key === permission.key,
      ),
    );
    await shot("07-permission");
    const denied = await js(
      `(()=>{const buttons=[...document.querySelectorAll('button')].filter(b=>!b.disabled);const button=buttons.find(b=>b.textContent.trim()==='拒绝'||b.textContent.trim()==='不允许');if(!button)return false;button.click();return true;})()`,
    );
    check("用户可拒绝工作流授权", denied);
    await wait(
      "授权回合收口",
      () => flows.controllerFor(cid).getSnapshot().phase === "idle",
    );
    await click(
      "关联对话",
      `document.querySelector('[data-testid="workflow-result"]')`,
    );
    await wait("回到对话追加消息", () =>
      js(`!document.querySelector('[data-testid="workflow-result"]')`),
    );
    await chat("QUEUE_BLOCK 验证普通主任务忙时工作流排队");
    await wait("普通任务工具已开始", () => fs.existsSync(queueStarted));
    const queued = await js(
      `(async()=>{const p=await window.hemiVoice.workflowPrepare({workflowId:'auto-flow',conversationId:${JSON.stringify(cid)},entryMode:'direct',executionModel:{mode:'auto'}});const r=await window.hemiVoice.workflowStartPrepared({...p,expectedDraftRevision:p.draftRevision,requestId:'auto-queued'});return {p,r};})()`,
    );
    check(
      "普通任务忙时工作流正常排队",
      queued.r.disposition === "queued" &&
        flows
          .controllerFor(cid)
          .getSnapshot()
          .pending.some(
            (p) => p.workflow?.invocationId === queued.p.invocationId,
          ),
    );
    check(
      "排队工作流仅在待发送区，不提前插入正式流",
      !flows
        .controllerFor(cid)
        .getSnapshot()
        .timeline.some((row) =>
          row.parts?.some(
            (part) => part.invocationId === queued.p.invocationId,
          ),
        ),
    );
    const cancelled = await js(
      `(async()=>{const p=await window.hemiVoice.workflowPrepare({workflowId:'stop-flow',conversationId:${JSON.stringify(cid)},entryMode:'direct'});const r=await window.hemiVoice.workflowStartPrepared({...p,expectedDraftRevision:p.draftRevision,requestId:'cancel-queued'});return {p,r};})()`,
    );
    await wait("排队工作流撤回入口", () =>
      js(
        `Boolean(document.querySelector('[data-queue-item-id="${cancelled.r.inputId}"]'))`,
      ),
    );
    check(
      "已受理工作流的冻结参数不能被普通文字编辑覆盖",
      await js(
        `document.querySelector('[data-queue-item-id="${cancelled.r.inputId}"] [aria-label="编辑这条"]').disabled`,
      ),
    );
    await js(
      `document.querySelector('[data-queue-item-id="${cancelled.r.inputId}"] [aria-label="撤回这条"]').click()`,
    );
    await wait("撤回运行终态", async () => {
      const inv = await service.getInvocation(cancelled.p.invocationId);
      return inv.run.status === "stopped";
    });
    check(
      "托盘撤回同步停止工作流且未执行节点",
      Object.keys(
        (await service.getInvocation(cancelled.p.invocationId)).run.nodes,
      ).length === 0,
    );
    await js(`window.hemiVoice.saveRoleModel({fixer:'review/a'})`);
    await js(`window.hemiVoice.setDefaultModelProfile('review/b')`);
    await wait("自动路由工作流完成", async () => {
      const inv = await service.getInvocation(queued.p.invocationId);
      return ["failed", "completed"].includes(inv.run?.status);
    });
    const routed = await service.getInvocation(queued.p.invocationId);
    check(
      "排队后修改路由不改变冻结的角色模型",
      routed.run.status === "completed" &&
        routed.usageCalls.some(
          (c) => c.role === "fixer" && c.model === "model-B",
        ),
      {
        status: routed.run.status,
        calls: routed.usageCalls,
        issues: routed.run.issues,
      },
    );
    check("普通任务未被工作流抢断", fs.existsSync(queueDone));
    const routeRequests = wire.filter((w) => w.auto);
    check(
      "自动路由节点保留执行和派单工具，不持对话准备卡工具",
      routeRequests.length > 0 &&
        routeRequests.every(
          (w) => ['write', 'bash', 'task'].every(name => w.tools.includes(name)) && !w.tools.includes('workflow_preparation'),
        ),
    );
    await js(`window.hemiVoice.saveRoleModel({fixer:'review/b'})`);
    await js(`window.hemiVoice.setDefaultModelProfile('review/a')`);
    await openStudio();
    await row("mixed-flow", "直接运行");
    await wait("混合流程应用授权", async () => {
      const state = await js("window.hemiVoice.getTaskState()");
      return state.agentPermissions?.some((p) => p.conversationId === cid);
    });
    await click("本任务允许");
    const mixedRun = await wait("混合具体节点完成", async () => {
      const inv = (
        await service.listInvocations({ workflowId: "mixed-flow" })
      )[0];
      return ["completed", "failed"].includes(inv?.run?.status) ? inv : null;
    });
    check(
      "Skill、普通执行、桌面实际按图执行",
      mixedRun.run.status === "completed" &&
        ["execute", "normal", "desktop"].every(
          (id) => mixedRun.run.nodes[id].status === "succeeded",
        ),
      mixedRun.run.issues,
    );
    check(
      "Skill 读取真实受控版本",
      wire.some((w) =>
        w.toolResults.some(
          (text) =>
            typeof text === "string" && text.includes("HEMI_SKILL_MARKER"),
        ),
      ),
    );
    check(
      "桌面租约运行后释放",
      !service.interactiveCoordinator.snapshot("interactive:local").holder,
    );
    await wait(
      "运行槽空闲",
      () => flows.controllerFor(cid).getSnapshot().phase === "idle",
    );
    const holder = await js(
      `(async()=>{const p=await window.hemiVoice.workflowPrepare({workflowId:'resource-holder',conversationId:${JSON.stringify(cid)},entryMode:'direct'});const r=await window.hemiVoice.workflowStartPrepared({...p,expectedDraftRevision:p.draftRevision,requestId:'resource-holder'});return {p,r};})()`,
    );
    await wait("实际桌面资源持有", async () => {
      const state = await js("window.hemiVoice.getTaskState()");
      if (state.agentPermissions?.some((p) => p.conversationId === cid))
        await click("本任务允许");
      return fs.existsSync(resourceStarted);
    });
    const waiter = await js(
      `(async()=>{const p=await window.hemiVoice.workflowPrepare({workflowId:'resource-waiter',entryMode:'direct'});const r=await window.hemiVoice.workflowStartPrepared({...p,expectedDraftRevision:p.draftRevision,requestId:'resource-waiter'});return {p,r};})()`,
    );
    await wait("资源等待可观测", async () =>
      Boolean(
        (await service.getInvocation(waiter.p.invocationId)).run.nodes.execute
          ?.resourceWaiting,
      ),
    );
    check(
      "不同运行共用真实桌面资源且未抢焦点",
      service.interactiveCoordinator.snapshot("interactive:local").holder
        .owner === holder.r.workflowRunId &&
        !wire.some((call) => call.resourceWaiter),
    );
    const cancelledWait = await js(
      `window.hemiVoice.workflowStop(${JSON.stringify(waiter.r.workflowRunId)})`,
    );
    check(
      "资源等待可停止且不启动节点模型",
      cancelledWait.stopped && !wire.some((call) => call.resourceWaiter),
    );
    await wait(
      "持有者正常完成",
      async () =>
        (await service.getInvocation(holder.p.invocationId)).run.status ===
        "completed",
    );
    check(
      "资源取消后无租约残留",
      !service.interactiveCoordinator.snapshot("interactive:local").holder &&
        service.interactiveCoordinator.snapshot("interactive:local")
          .queueLength === 0,
    );

    await js(`window.hemiVoice.saveRoleModel({fallback:'review/b'})`);
    const fallbackRun = await js(
      `(async()=>{const p=await window.hemiVoice.workflowPrepare({workflowId:'fallback-flow',conversationId:${JSON.stringify(cid)},entryMode:'direct',executionModel:{mode:'auto'}});return {p,r:await window.hemiVoice.workflowStartPrepared({invocationId:p.invocationId,cardId:p.cardId,expectedDraftRevision:p.draftRevision,requestId:'fallback-product'})};})()`,
    );
    const fallbackDone = await wait(
      "备用接管并完成后继",
      async () => {
        const inv = await service.getInvocation(fallbackRun.p.invocationId);
        return ["completed", "failed"].includes(inv.run?.status) ? inv : null;
      },
      45000,
    );
    check(
      "生产备用接管且下一节点回到主模型",
      fallbackDone.run.status === "completed" &&
        wire.some((call) => call.fallbackStage && call.model === "model-A") &&
        wire.some((call) => call.fallbackStage && call.model === "model-B") &&
        wire
          .filter((call) => call.afterFallback)
          .every((call) => call.model === "model-A"),
      fallbackDone.run.issues,
    );
    await openStudio();
    await row("direct-file-flow", "直接运行");
    const directFile = await wait("单击直接文件交付", async () => {
      const inv = (
        await service.listInvocations({ workflowId: "direct-file-flow" })
      )[0];
      return inv?.run?.status === "completed" ? inv : null;
    });
    await wait("直接结果含文件操作", () =>
      js(
        `!!document.querySelector('[data-testid="workflow-result"] [data-status="completed"]')`,
      ),
    );
    check(
      "完整默认值直接运行无需参数弹窗，结果可读真实文件",
      directFile.preparation.ready &&
        fs.readFileSync(file, "utf8") === marker &&
        (await js(
          `[...document.querySelectorAll('[data-testid="workflow-result"] button')].some(button=>button.textContent==='打开文件')`,
        )),
    );
    await shot("direct-file-result");
    await openStudio();
    await row("format-flow", "去对话运行");
    const fmt1 = await wait("格式准备卡", async () => {
      const inv = (
        await service.listInvocations({ workflowId: "format-flow" })
      )[0];
      return inv?.preparation.ready ? inv : null;
    });
    const beforeFormatCalls = wire.filter((call) => call.node).length;
    await chat("开始吧");
    await wait(
      "开始文字补参收口",
      () => flows.controllerFor(cid).getSnapshot().phase === "idle",
    );
    check(
      "说开始吧仍不替代卡片点击",
      !(await service.getInvocation(fmt1.invocationId)).run &&
        wire.filter((call) => call.node).length === beforeFormatCalls,
    );
    await chat("改成文字版");
    await wait(
      "格式覆盖为文字",
      async () =>
        (await service.getInvocation(fmt1.invocationId)).preparation.values
          .format === "text",
    );
    const fmtReady = await service.getInvocation(fmt1.invocationId);
    check(
      "格式覆盖保留日期和来源，不修改定义默认",
      fmtReady.preparation.values.date === "2026-10-17" &&
        fmtReady.preparation.values.source === formatSourceA &&
        (await service.getDefinitionRevision("format-flow")).document.nodes[0]
          .data.parameters[1].defaultValue === "ppt",
    );
    await wait("最新格式卡出现", () =>
      js(
        `document.querySelector('[data-testid="workflow-card"][data-status="preparing"]').textContent.includes('text')`,
      ),
    );
    await click(
      "开始运行",
      `document.querySelector('[data-testid="workflow-card"][data-status="preparing"]')`,
    );
    await wait(
      "文字报告完成",
      async () =>
        (await service.getInvocation(fmt1.invocationId)).run?.status ===
        "completed",
    );
    const fmt2 = await js(
      `(async()=>{const p=await window.hemiVoice.workflowPrepare({workflowId:'format-flow',conversationId:${JSON.stringify(cid)},entryMode:'direct'});const changed=await window.hemiVoice.workflowUpdatePreparation({invocationId:p.invocationId,expectedDraftRevision:p.draftRevision,values:{date:'2026-10-18',format:'text',source:${JSON.stringify(formatSourceB)}}});return {p,r:await window.hemiVoice.workflowStartPrepared({invocationId:p.invocationId,cardId:p.cardId,conversationId:p.conversationId,expectedDraftRevision:changed.draftRevision,requestId:'format-second'})};})()`,
    );
    await wait(
      "第二组输入完成",
      async () =>
        (await service.getInvocation(fmt2.p.invocationId)).run?.status ===
        "completed",
    );
    const firstReport = fs.readFileSync(
        path.join(path.dirname(formatSourceA), "report-2026-10-17.txt"),
        "utf8",
      ),
      secondReport = fs.readFileSync(
        path.join(path.dirname(formatSourceA), "report-2026-10-18.txt"),
        "utf8",
      );
    check(
      "两组日期文件分别交付不串用",
      firstReport.includes("SOURCE_A_UNIQUE") &&
        !firstReport.includes("SOURCE_B_UNIQUE") &&
        secondReport.includes("SOURCE_B_UNIQUE") &&
        !secondReport.includes("SOURCE_A_UNIQUE"),
    );
    check(
      "工作流双入口共用定义且各一次",
      (await service.listInvocations({ workflowId: "format-flow" })).filter(
        (inv) => inv.run,
      ).length === 2 && fmt2.r.ok,
    );
    const badInput = await js(
      `(async()=>{const p=await window.hemiVoice.workflowPrepare({workflowId:'format-flow',conversationId:${JSON.stringify(cid)},entryMode:'direct'});return window.hemiVoice.workflowUpdatePreparation({invocationId:p.invocationId,expectedDraftRevision:p.draftRevision,values:{date:'2026-10-18',format:'text',source:${JSON.stringify(formatSourceB + "-missing")}}});})()`,
    );
    check(
      "缺失输入文件在运行前阻止启动",
      !badInput.preparation.ready &&
        badInput.preparation.issues.some(
          (issue) => issue.code === "input-unavailable",
        ),
    );
    const badModel = await js(
      `window.hemiVoice.workflowPrepare({workflowId:'format-flow',conversationId:${JSON.stringify(cid)},entryMode:'direct',executionModel:{mode:'fixed',modelKey:'review/deleted'}})`,
    );
    check(
      "失效模型在运行前阻止启动",
      !badModel.ready && badModel.issues.length > 0,
    );
    const cancelledPreparation = await js(
      `window.hemiVoice.workflowPrepare({workflowId:'format-flow',conversationId:${JSON.stringify(cid)},entryMode:'chat'})`,
    );
    await js(
      `window.hemiVoice.workflowAbandon({invocationId:${JSON.stringify(cancelledPreparation.invocationId)},conversationId:${JSON.stringify(cid)}})`,
    );
    const beforeMention = (await service.listInvocations()).filter(
      (inv) => inv.run,
    ).length;
    await js(
      `window.hemiVoice.chatTextModel({conversationId:${JSON.stringify(cid)},inputSource:'text',messages:[{role:'user',content:'运行 format-flow /format-flow'}]})`,
    );
    check(
      "取消准备不运行，普通文字不发现或启动流程",
      !(await service.getInvocation(cancelledPreparation.invocationId)).run &&
        (await service.listInvocations()).filter((inv) => inv.run).length ===
          beforeMention,
    );
    await shot("format-two-runs");
    await openStudio();
    await row("format-flow", "format-flow");
    await wait("默认值详情", () =>
      js(`!!document.querySelector('[data-testid="workflow-detail"]')`),
    );
    const beforeRunSettings = wire.length;
    await click("仅调整本次");
    await wait("本次参数弹窗", () =>
      js(`!!document.querySelector('.h59-parameters-dialog')`),
    );
    check("本次设置打开不执行模型或节点", wire.length === beforeRunSettings);
    const initialSettingsModel = await js(
      `document.querySelector('.h59-parameters-dialog .h24-model-chip').textContent`,
    );
    await js(
      `document.querySelector('.h59-parameters-dialog .h24-model-chip').click()`,
    );
    await wait("本次模型菜单", () =>
      js(
        `[...document.querySelectorAll('[role="menuitemradio"]')].some(x=>x.textContent.includes('model-B'))`,
      ),
    );
    await js(
      `[...document.querySelectorAll('[role="menuitemradio"]')].find(x=>x.textContent.includes('model-B')).click()`,
    );
    check(
      "本次模型选择可见且不执行",
      (await js(
        `document.querySelector('.h59-parameters-dialog .h24-model-chip').textContent.includes('model-B')`,
      )) && wire.length === beforeRunSettings,
    );
    const cancelledSettings = (
      await service.listInvocations({ workflowId: "format-flow" })
    )[0];
    await click("取消", `document.querySelector('.h59-parameters-dialog')`);
    await wait("本次设置取消", () =>
      js(`!document.querySelector('.h59-parameters-dialog')`),
    );
    check(
      "取消本次设置终止准备且不启动",
      !(await service.getInvocation(cancelledSettings.invocationId)).run &&
        wire.length === beforeRunSettings,
    );
    check(
      "取消本次设置不发送对话消息",
      !flows
        .controllerFor(cid)
        .getSnapshot()
        .timeline.some((row) =>
          row.parts?.some(
            (part) => part.invocationId === cancelledSettings.invocationId,
          ),
        ),
    );
    await click("仅调整本次");
    await wait("重开本次参数", () =>
      js(`!!document.querySelector('.h59-parameters-dialog')`),
    );
    check(
      "取消模型覆盖不修改下次默认",
      (await js(
        `document.querySelector('.h59-parameters-dialog .h24-model-chip').textContent`,
      )) === initialSettingsModel,
    );
    await js(
      `document.querySelector('.h59-parameters-dialog .h24-model-chip').click()`,
    );
    await wait("本次模型菜单再次打开", () =>
      js(
        `[...document.querySelectorAll('[role="menuitemradio"]')].some(x=>x.textContent.includes('model-B'))`,
      ),
    );
    await js(
      `[...document.querySelectorAll('[role="menuitemradio"]')].find(x=>x.textContent.includes('model-B')).click()`,
    );
    const editedSettings = (
      await service.listInvocations({ workflowId: "format-flow" })
    )[0];
    await setInput('.h59-parameters-dialog input[type="date"]', "2026-10-19");
    await js(
      `(()=>{const select=document.querySelector('.h59-parameters-dialog select');select.value='text';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await setInput('.h59-parameters-dialog input[type="text"]', formatSourceB);
    await click(
      "补充并运行",
      `document.querySelector('.h59-parameters-dialog')`,
    );
    await wait("覆盖参数真实完成", async () =>
      ["completed", "failed"].includes(
        (await service.getInvocation(editedSettings.invocationId)).run?.status,
      ),
    );
    const editedRun = await service.getInvocation(editedSettings.invocationId);
    const editedDefault = (
      await service.definitionStore.getRevision("format-flow", 1)
    ).document.nodes.find((node) => node.type === "hemi-input").data.parameters;
    check(
      "本次参数覆盖交付真实文件且默认值不变",
      editedRun.run.status === "completed" &&
        fs
          .readFileSync(
            path.join(path.dirname(formatSourceA), "report-2026-10-19.txt"),
            "utf8",
          )
          .includes("SOURCE_B_UNIQUE") &&
        editedDefault.find((p) => p.key === "format").defaultValue === "ppt" &&
        editedDefault.find((p) => p.key === "source").defaultValue ===
          formatSourceA,
    );
    check(
      "本次模型覆盖进入真实节点请求",
      wire.slice(beforeRunSettings).filter((call) => call.node).length > 0 &&
        wire
          .slice(beforeRunSettings)
          .filter((call) => call.node)
          .every((call) => call.model === "model-B"),
    );
    await shot("run-settings-result");
    await openStudio();
    const beforeCreation = wire.length;
    await click("新建工作流");
    await wait("直接打开空白编辑器", () =>
      js(`document.querySelectorAll('.h59-node').length===2`),
    );
    const blankRows = await service.listDefinitions();
    const blank = blankRows.find((row) => row.name === "未命名工作流");
    const blankDraft = await service.definitionStore.getDraft(blank.workflowId);
    check(
      "新建直接进入空白画布且不调用模型",
      wire.length === beforeCreation &&
        (await js(
          `!document.querySelector('.h59-create-dialog') && typeof window.hemiVoice.workflowGenerate==='undefined'`,
        )) &&
        !blank.published &&
        blankDraft.document.nodes.length === 2 &&
        blankDraft.document.nodes.every((node) =>
          ["hemi-input", "hemi-deliver"].includes(node.type),
        ),
    );
    await shot("08-blank-workflow");
    check(
      "空白创建不改写历史任务",
      fs.readFileSync(
        path.join(
          app.getPath("userData"),
          "task-history",
          sourceTaskId + ".json",
        ),
        "utf8",
      ) === originalTask,
    );
    const count = wire.length;
    await win.webContents.reloadIgnoringCache();
    await wait("重载页面", () =>
      js(`Boolean(document.querySelector('textarea'))`),
    );
    await sleep(500);
    check("重载不重跑", wire.length === count);
    await shot("06-reloaded");
    check("渲染层无运行错误", errors.length === 0, errors);
  } catch (error) {
    fatal = error.stack;
    console.error("HEMI059_PRODUCT_ERROR", fatal);
    if (win && !win.isDestroyed()) await shot("failure");
  } finally {
    if (debuggerSession?.isAttached()) {
      await debuggerSession.sendCommand("Page.stopScreencast").catch(() => {});
      debuggerSession.detach();
    }
    fs.writeFileSync(
      path.join(evidence, "result.json"),
      JSON.stringify(
        {
          passed: manual ? null : !fatal,
          mode: manual ? "native-manual" : "regression",
          results,
          wire,
          errors,
          fatal,
          marker,
          temp,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(evidence, "screencast-frames.json"),
      JSON.stringify(frames, null, 2),
    );
    if (frames.length)
      fs.writeFileSync(
        path.join(evidence, "frames/frames.txt"),
        frames
          .map(
            (f, i) =>
              `file '${f.name}'\nduration ${Math.max(0.02, ((frames[i + 1]?.at ?? f.at + 500) - f.at) / 1000).toFixed(3)}\n`,
          )
          .join(""),
      );
    console.log(
      "HEMI059_PRODUCT_RESULT=" +
        JSON.stringify({ passed: manual ? null : !fatal, manual, results }),
    );
    server.close();
    if (!process.env.HEMI_KEEP_TEST_DATA)
      fs.rmSync(temp, { recursive: true, force: true });
    app.exit(fatal ? 1 : 0);
  }
});
