// 两次真实 Electron 进程，生产 IPC/Pi/文件工具。只有模型端点受控；SIGKILL 后由生产继续协议明确确认继续。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!process.env.HEMI059_RESTART_MODE) {
  const temp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "hemi059-restart-")),
    ),
    file = path.join(temp, "ud/workspace/default/report.txt"),
    requests = [];
  let held = false;
  const evidence = path.resolve(
    process.env.HEMI059_EVIDENCE ?? ".visual/workflow/vision/059-fix-validation",
    process.env.HEMI059_RESTART_REPLACE
      ? "restart-replaced"
      : process.env.HEMI059_RESTART_ACCEPT
        ? "restart-verified"
        : "restart",
  );
  fs.mkdirSync(evidence, { recursive: true });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw),
        text = JSON.stringify(body.messages),
        hasTool = body.messages.some((m) => m.role === "tool");
      requests.push({
        at: Date.now(),
        first: text.includes("FIRST_NODE"),
        model: body.model,
      });
      if (text.includes("SECOND_NODE") && !held) {
        held = true;
        console.log("MODEL_HELD");
        return;
      }
      const tool =
        text.includes("FIRST_NODE") && !hasTool
          ? {
              name: "write",
              arguments: { path: file, content: "重启前已完成的产物" },
            }
          : null;
      const content =
        "```json\n" +
        JSON.stringify({
          result: text.includes("FIRST_NODE") ? file : "恢复后完成",
        }) +
        "\n```";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta, reason = null) =>
        res.write(
          "data: " +
            JSON.stringify({
              id: "restart",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: reason }],
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
                  id: "tool-restart",
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
  const launch = (mode) =>
    spawn(require("electron"), [fileURLToPath(import.meta.url)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEMI_SMOKE_TEST: "1",
        HEMI059_RESTART_MODE: mode,
        HEMI059_RESTART_TEMP: temp,
        HEMI059_RESTART_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let first,
    second,
    fatal,
    output = "";
  try {
    first = launch("start");
    first.stdout.on("data", (c) => (output += c));
    first.stderr.on("data", (c) => (output += c));
    const deadline = Date.now() + 20000;
    while (!held && Date.now() < deadline) await sleep(50);
    if (!held) throw Error("首进程没有进入第二节点：" + output.slice(-1500));
    const original = fs.statSync(file).mtimeMs;
    first.kill("SIGKILL");
    await new Promise((r) => first.once("exit", r));
    if (process.env.HEMI059_RESTART_REPLACE)
      fs.writeFileSync(file, "外部替换后的内容");
    second = launch("resume");
    let resumed = "";
    second.stdout.on("data", (c) => (resumed += c));
    second.stderr.on("data", (c) => (resumed += c));
    const exit = await new Promise((r) => {
      const timer = setTimeout(() => {
        second.kill("SIGKILL");
        r(-1);
      }, 25000);
      second.once("exit", (code) => {
        clearTimeout(timer);
        r(code);
      });
    });
    output += resumed;
    if (exit !== 0) throw Error("恢复进程失败：" + resumed.slice(-3000));
    const result = {
      passed: true,
      resolution: process.env.HEMI059_RESTART_ACCEPT ? "accept" : "retry",
      firstNodeRequests: requests.filter((r) => r.first).length,
      firstFileNotRewritten: fs.statSync(file).mtimeMs === original,
      requests,
    };
    if (
      result.firstFileNotRewritten ===
        Boolean(process.env.HEMI059_RESTART_REPLACE) ||
      result.firstNodeRequests !==
        (process.env.HEMI059_RESTART_REPLACE ? 4 : 2) ||
      requests.length !==
        (process.env.HEMI059_RESTART_REPLACE
          ? 6
          : process.env.HEMI059_RESTART_ACCEPT
            ? 3
            : 4)
    )
      throw Error("已完成节点被重新执行");
    fs.writeFileSync(
      path.join(evidence, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log("HEMI059_RESTART_RESULT=" + JSON.stringify(result));
  } catch (error) {
    fatal = error.stack;
    fs.writeFileSync(
      path.join(evidence, "result.json"),
      JSON.stringify(
        { passed: false, fatal, output: output.slice(-8000) },
        null,
        2,
      ),
    );
    console.error(fatal);
  } finally {
    first?.kill();
    second?.kill();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
    process.exit(fatal ? 1 : 0);
  }
} else {
  const { app, safeStorage } = await import("electron");
  const temp = process.env.HEMI059_RESTART_TEMP;
  app.setName("hemi");
  app.setPath("userData", path.join(temp, "ud"));
  app.whenReady().then(async () => {
    try {
      if (process.env.HEMI059_RESTART_MODE === "start") {
        fs.mkdirSync(app.getPath("userData"), { recursive: true });
        fs.writeFileSync(
          path.join(app.getPath("userData"), "text-model-profiles.json"),
          JSON.stringify({
            version: 3,
            defaultModelId: "test/a",
            providers: [
              {
                id: "test",
                name: "重启测试",
                baseUrl: process.env.HEMI059_RESTART_ENDPOINT,
                encryptedApiKey: safeStorage
                  .encryptString("test")
                  .toString("base64"),
                models: [{ id: "a", model: "restart-model" }],
              },
            ],
          }),
        );
        fs.writeFileSync(
          path.join(app.getPath("userData"), "onboarding.json"),
          JSON.stringify({
            version: 1,
            phase: "complete",
            step: "done",
            completedAt: Date.now(),
          }),
        );
      }
      await (await import("../src/main/ipc/index.mjs")).registerAllIpcHandlers();
      await (
        await import("../src/main/windows/main-window.mjs")
      ).createMainWindow();
      const win = (await import("../src/main/state.mjs")).state.mainWindow,
        js = (code) => win.webContents.executeJavaScript(code);
      const wait = async (name, fn) => {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
          if (await fn()) return;
          await sleep(60);
        }
        throw Error("等待超时：" + name);
      };
      await wait("渲染入口", () =>
        js(`Boolean(window.hemiVoice&&document.querySelector('textarea'))`),
      );
      const service = (
        await import("../src/main/workflows/workflow-service.mjs")
      ).getWorkflowService();
      if (process.env.HEMI059_RESTART_MODE === "start") {
        const document = {
          nodes: [
            {
              id: "in",
              type: "hemi-input",
              meta: { position: { x: 0, y: 100 } },
              data: { parameters: [{ key: "topic", type: "string" }] },
            },
            {
              id: "first",
              type: "hemi-agent",
              meta: { position: { x: 260, y: 100 } },
              data: {
                goal: "FIRST_NODE 写出实际文件",
                outputSchema: {
                  type: "object",
                  properties: { result: { type: "file" } },
                },
              },
            },
            {
              id: "second",
              type: "hemi-agent",
              meta: { position: { x: 520, y: 100 } },
              data: {
                goal: "SECOND_NODE 等待结果",
                inputBindings: [
                  {
                    kind: "node-output",
                    nodeId: "first",
                    key: "result",
                    type: "file",
                  },
                ],
                outputSchema: {
                  type: "object",
                  properties: { result: { type: "string" } },
                },
              },
            },
            {
              id: "end",
              type: "hemi-deliver",
              meta: { position: { x: 780, y: 100 } },
              data: {
                summary: "结果",
                artifacts: [
                  {
                    label: "原文件",
                    binding: {
                      kind: "node-output",
                      nodeId: "first",
                      key: "result",
                      type: "file",
                    },
                  },
                  {
                    label: "摘要",
                    binding: {
                      kind: "node-output",
                      nodeId: "second",
                      key: "result",
                      type: "string",
                    },
                  },
                ],
              },
            },
          ],
          edges: [
            { sourceNodeID: "in", targetNodeID: "first" },
            { sourceNodeID: "first", targetNodeID: "second" },
            { sourceNodeID: "second", targetNodeID: "end" },
          ],
        };
        const prep = await js(
          `(async()=>{const d=await window.hemiVoice.workflowSaveDraft('restart-flow',${JSON.stringify(document)},'重启恢复验证');await window.hemiVoice.workflowPublish('restart-flow',d.draftRevision);const p=await window.hemiVoice.workflowPrepare({workflowId:'restart-flow',entryMode:'direct'});await window.hemiVoice.workflowStartPrepared({...p,expectedDraftRevision:p.draftRevision,requestId:'restart-start'});return p;})()`,
        );
        fs.writeFileSync(
          path.join(temp, "identity.json"),
          JSON.stringify(prep),
        );
        await new Promise(() => {});
      } else {
        const identity = JSON.parse(
          fs.readFileSync(path.join(temp, "identity.json"), "utf8"),
        );
        let inv = await service.getInvocation(identity.invocationId);
        if (inv.run.status !== "interrupted") throw Error("没有显示中断状态");
        await js(`document.querySelector('button[title="工作流"]').click()`);
        await wait("工作流列表", () =>
          js(`Boolean(document.querySelector('[data-testid="workflow-row"]'))`),
        );
        await js(
          `[...document.querySelectorAll('[data-testid="workflow-row"] button')].find(b=>b.textContent.trim()==='重启恢复验证').click()`,
        );
        await wait("运行记录", () =>
          js(
            `Boolean(document.querySelector('[aria-label="运行记录"] button'))`,
          ),
        );
        await js(
          `[...document.querySelectorAll('[aria-label="运行记录"] button')].find(b=>b.textContent==='关联对话').click()`,
        );
        await wait("中断卡片", () =>
          js(
            `Boolean(document.querySelector('[data-testid="workflow-card"][data-status="interrupted"]'))`,
          ),
        );
        await sleep(500);
        let rejected = false;
        try {
          await js(
            `window.hemiVoice.workflowContinue({invocationId:${JSON.stringify(identity.invocationId)},requestId:'resume-unconfirmed'})`,
          );
        } catch {
          rejected = true;
        }
        if (!rejected) throw Error("中断后未确认也允许继续");
        if (
          !(await js(
            `[...document.querySelectorAll('[data-testid="workflow-card"] button')].find(b=>b.textContent==='继续运行').disabled`,
          ))
        )
          throw Error("UI 未核对时也可继续");
        const evidence = path.resolve(
          process.env.HEMI059_EVIDENCE ?? ".visual/workflow/vision/059-fix-validation",
          process.env.HEMI059_RESTART_REPLACE
            ? "restart-replaced"
            : process.env.HEMI059_RESTART_ACCEPT
              ? "restart-verified"
              : "restart",
        );
        fs.writeFileSync(
          path.join(evidence, "interrupted.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        const before = inv.run.nodes.first.attemptId;
        if (process.env.HEMI059_RESTART_ACCEPT) {
          await js(
            `(()=>{const select=document.querySelector('select[aria-label="核对后的处理方式"]');select.value='accept';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
          );
          await wait("核对结果字段", () =>
            js(`Boolean(document.querySelector('.h59-resolve input'))`),
          );
          await js(
            `(()=>{const input=document.querySelector('.h59-resolve input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'外部结果已确认完成');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
          );
        }
        await js(
          `document.querySelector('[data-testid="workflow-card"] input[type=checkbox]').click()`,
        );
        await sleep(100);
        await js(
          `[...document.querySelectorAll('[data-testid="workflow-card"] button')].find(b=>b.textContent==='继续运行').click()`,
        );
        await wait("继续完成", async () => {
          inv = await service.getInvocation(identity.invocationId);
          return inv.run.status === "completed";
        });
        if (
          (inv.run.nodes.first.attemptId === before) ===
          Boolean(process.env.HEMI059_RESTART_REPLACE)
        )
          throw Error("前驱复用／重算不符合文件有效性");
        fs.writeFileSync(
          path.join(evidence, "restored.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        console.log(
          `RESTART_CHILD_PASS 中断确认、同一运行继续、${process.env.HEMI059_RESTART_REPLACE ? "文件变化后重算前驱" : "未变化前驱不重跑"}`,
        );
        app.exit(0);
      }
    } catch (error) {
      console.error(error.stack);
      app.exit(1);
    }
  });
}
