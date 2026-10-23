// 059 人工输入 UI 走查（HI-AC01/02/04 对话部分）：真实编辑器逐项配置（含动态端口、
// 超时出口缺连线的校验拦截、保存发布、重开 round-trip）＋真实对话内卡片表单操作
// （选择／填写／真实文件提交→只读记录→完成）。双入口：默认构建产物；设
// VITE_DEV_SERVER_URL 走开发入口（StrictMode）。模型端点为本地 SSE mock。
// HEMI_SMOKE_TEST=1 npx electron scripts/verify-059-human-input-ui.mjs
import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { PENDING_CAPACITY } from "../src/shared/conversation-flow.mjs";

const temp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "hemi059-hiui-")),
);
app.setName("hemi");
app.setPath("userData", path.join(temp, "ud"));
const entry = process.env.VITE_DEV_SERVER_URL ? "dev" : "build";
const marker = `HIUI-${Date.now()}`;
const results = [];
let win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => win.webContents.executeJavaScript(code);
const check = (name, ok, detail = null) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " " + JSON.stringify(detail) : ""}`);
  assert.ok(ok, name);
};
const wait = async (name, code, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await js(code)) return;
    await sleep(100);
  }
  throw new Error("等待超时：" + name);
};
const click = async (text, scope = "document") => {
  if (
    text.startsWith("添加") &&
    !(await js(
      `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})`,
    ))
  ) {
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加节点')?.click()`,
    );
    await sleep(120);
  }
  const ok = await js(
    `(()=>{const b=[...(${scope}).querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}));if(!b||b.disabled)return false;b.click();return true;})()`,
  );
  if (!ok) throw new Error("按钮不可用：" + text);
  await sleep(120);
};
/** 按 label 文本找 inspector 控件（展开所在 details）并取值。 */
const fieldByLabel = async (startsWith, value) => {
  await js(
    `(()=>{const label=[...document.querySelectorAll('.h59-inspector label, .h59-node-form label, [data-testid="workflow-canvas"] label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(startsWith)}));const details=label?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click();})()`,
  );
  await sleep(60);
  const done = await js(
    `(()=>{const label=[...document.querySelectorAll('.h59-inspector label, .h59-node-form label, [data-testid="workflow-canvas"] label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(startsWith)}));const el=label?.querySelector('input,textarea,select');if(!el)return false;const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true;})()`,
  );
  if (!done) throw new Error("字段不存在：" + startsWith);
  await sleep(80);
};
/** 按 aria-label 定位（人工输入表单的控件全部带唯一 aria-label）。 */
const byAria = async (label, value) => {
  const done = await js(
    `(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');if(!el)return false;const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true;})()`,
  );
  if (!done) throw new Error("控件不存在：" + label);
  await sleep(80);
};
/** select 按选项文本选择（下一步去向等选项 value 是节点 id）。 */
const selectByOptionText = async (labelStarts, optionText) => {
  await js(
    `(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(labelStarts)}));const details=label?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click();})()`,
  );
  await sleep(60);
  const done = await js(
    `(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(labelStarts)}));const el=label?.querySelector('select');if(!el)return false;const opt=[...el.options].find(o=>o.textContent.trim()===${JSON.stringify(optionText)});if(!opt)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,opt.value);el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
  );
  if (!done) throw new Error("选项不可选：" + labelStarts + " → " + optionText);
  await sleep(120);
};
const config = async (name, { advanced = false } = {}) => {
  await js(`document.querySelector('[aria-label="配置${name}"]')?.click()`);
  await sleep(150);
  if (advanced) {
    await click("更多工作流操作");
    await click("节点高级配置");
  }
};

const portGeometry = () => js(`(()=>{const node=document.querySelector('.hemi-human-input');const shell=node.parentElement;const r=node.getBoundingClientRect();return {bottom:r.bottom,ports:[...shell.querySelectorAll('[data-port-entity-type="output"]')].map(el=>{const p=el.getBoundingClientRect();return {id:el.dataset.portEntityId,x:p.x+p.width/2,y:p.y+p.height/2};})};})()`);
const clickPort = async (title, portId, type) => {
  const point = await js(`(()=>{const shell=[...document.querySelectorAll('[data-workflow-node-id]')].find(el=>el.querySelector('.h59-node-copy strong')?.textContent===${JSON.stringify(title)});const el=[...(shell?.querySelectorAll('[data-port-entity-id]')??[])].find(el=>el.dataset.portEntityType===${JSON.stringify(type)}&&el.dataset.portEntityId.endsWith(${JSON.stringify("_" + portId)}));if(!el)return null;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:document.elementFromPoint(x,y)?.closest('[data-port-entity-id]')===el};})()`);
  assert.ok(point?.hit, `端口可命中：${title}/${portId}/${type}`);
  win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
  await sleep(150);
};
const evidence = path.resolve(".visual/workflow/vision/059-human-input-fix");
fs.mkdirSync(evidence, { recursive: true });
let releaseBusy, busyRequestStarted = false;

// 本地 SSE mock（OpenAI 兼容）：节点 agent 输出固定 JSON。
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    const userText = (body.messages ?? [])
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : (m.content ?? []).map((c) => c?.text ?? ""),
      )
      .join("\n");
    if (userText.includes("HIUI_BUSY") && !busyRequestStarted) {
      busyRequestStarted = true;
      await new Promise((resolve) => { releaseBusy = resolve; });
      if (res.destroyed) return;
    }
    const latest = [...body.messages].reverse().find(message => message.role === 'user');
    const latestText = typeof latest?.content === 'string' ? latest.content : (latest?.content ?? []).map(block => block.text ?? '').join('\n');
    const invocationId = [...latestText.matchAll(/"invocationId":"([^"\n]+)"/g)].at(-1)?.[1];
    let tool;
    if (!latestText.includes('［工作流节点执行') && latestText.split('\n\n')[0].includes('主题') && invocationId) {
      const last = body.messages.at(-1);
      const previousCall = [...body.messages].reverse().find(message => message.tool_calls?.length)?.tool_calls.at(-1)?.function;
      const args = previousCall?.arguments ? JSON.parse(previousCall.arguments) : {};
      if (last?.role !== 'tool') tool = { name: 'workflow_preparation', arguments: { action: 'get', invocationId } };
      else if (args.action === 'get') {
        const record = JSON.parse(last.content);
        tool = { name: 'workflow_preparation', arguments: { action: 'update', invocationId, expectedDraftRevision: record.draftRevision, set: { topic: `走查主题·${marker}` } } };
      }
    }
    const content = "```json\n" + JSON.stringify({ result: `唯一结果·${marker}` }) + "\n```";
    const send = (delta, finish_reason = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "hiui-call", object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model: body.model ?? "model-A",
            choices: [{ index: 0, delta, finish_reason }],
          }) + "\n\n",
      );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    send({ role: "assistant", ...(tool ? { tool_calls: [{ index: 0, id: `prep-${Date.now()}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content }) });
    send({}, tool ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

app.whenReady().then(async () => {
  let fatal;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      path.join(app.getPath("userData"), "onboarding.json"),
      JSON.stringify({ version: 1, phase: "complete", step: "done", completedAt: Date.now(), updatedAt: Date.now() }),
    );
    fs.writeFileSync(
      path.join(app.getPath("userData"), "text-model-profiles.json"),
      JSON.stringify({
        version: 3, defaultModelId: "review/a",
        roleModels: { main: "review/a", fixer: "review/a", fallback: "review/a" },
        providers: [{
          id: "review", name: "本地回归", baseUrl,
          encryptedApiKey: safeStorage.encryptString("local-test").toString("base64"),
          models: [{ id: "a", model: "model-A", supportsVision: false }],
        }],
      }),
    );
    // 真实文件字段用的材料（工作区内，verifyWorkflowArtifact 可读）
    const workspaceDir = path.join(app.getPath("userData"), "workspace/default");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const proofFile = path.join(workspaceDir, `证明材料-${marker}.txt`);
    fs.writeFileSync(proofFile, `人工输入提交的真实文件·${marker}`);
    const proofFile2 = path.join(workspaceDir, `第二份材料-${marker}.txt`);
    fs.writeFileSync(proofFile2, `人工输入提交的第二份文件·${marker}`);

    const { registerAllIpcHandlers } = await import("../src/main/ipc/index.mjs");
    registerAllIpcHandlers();
    const { createMainWindow } = await import("../src/main/windows/main-window.mjs");
    await createMainWindow();
    win = (await import("../src/main/state.mjs")).state.mainWindow;
    await wait("窗口就绪", `document.readyState === 'complete'`);
    await wait("应用挂载", `!!document.querySelector('button[title="工作流"]')`, 60000);

    // Configure the controlled endpoint through the current production profile/secret API.
    await js(`window.hemiVoice.saveModelProfile(${JSON.stringify({id:'review',name:'本地回归',api:'openai-completions',baseUrl,apiKey:'local-test',models:[{id:'a',model:'model-A',thinkingLevel:'default',supportsVision:false}],makeDefault:true})})`);
    const reloaded = new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('配置模型后重载超时')),45000);
      win.webContents.once('dom-ready',()=>{clearTimeout(timer);resolve();});
    });
    win.reload(); await reloaded;
    await wait('模型配置后应用挂载',`!!document.querySelector('button[title="工作流"]')`,60000);

    // ── 编辑器走查 ──
    await js(`document.querySelector('button[title="工作流"]').click()`);
    await wait("工作室页", `!!document.querySelector('[data-testid="workflow-row"], .h59-empty') || document.body.textContent.includes('工作流')`);
    await click("新建工作流");
    await wait("画布挂载", `!!document.querySelector('[data-testid="workflow-canvas"]')`);

    await click("添加普通执行");
    await config("普通执行");
    await fieldByLabel("名称", "起草");
    await fieldByLabel("任务目标", "按主题起稿");
    await click("添加人工输入");
    await click("添加普通执行");
    await config("普通执行");
    await fieldByLabel("名称", "返工");
    await fieldByLabel("任务目标", "按批注返工");
    // 连主线：输入→起草→人工输入（变量菜单才有上游可插）
    await config("输入", { advanced: true });
    await selectByOptionText("执行后进入", "起草");
    await config("起草", { advanced: true });
    await selectByOptionText("执行后进入", "人工输入");

    await config("人工输入");
    await fieldByLabel("展示内容", `上一步结果如下，请选择后续处理：`);
    await js(
      `[...document.querySelectorAll('.h59-hi-vars button')].find(b=>b.textContent.includes('result')&&b.textContent.includes('起草'))?.click()`,
    );
    await sleep(80);
    check("变量插入进内容", await js(
      `(()=>{const el=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith('展示内容'))?.querySelector('textarea');return el?.value.includes('{{') && el?.value.includes('result');})()`,
    ));
    await click("添加字段");
    await byAria("字段 field_1 类型", "choice");
    await byAria("字段 field_1 名称", "方案");
    await byAria("字段 field_1 选项", "方案甲\n方案乙");
    await byAria("字段 field_1 输出变量", "plan");
    await click("添加字段");
    await byAria("字段 field_2 类型", "file");
    await byAria("字段 field_2 名称", "补充材料");
    await byAria("字段 field_2 输出变量", "proof");
    await click("添加字段");
    await byAria("字段 field_3 名称", "批注");
    await byAria("字段 field_3 预填文本", "默认意见");
    await byAria("字段 field_3 输出变量", "comment");
    await click("添加字段");
    await byAria("字段 field_4 类型", "files");
    await byAria("字段 field_4 名称", "材料列表");
    await byAria("字段 field_4 输出变量", "proofs");
    await byAria("操作 confirm 按钮文案", "通过");
    await js(`document.querySelector('[aria-label="确认 必填 plan"]')?.click()`);
    await click("添加操作");
    await byAria("操作 action_2 按钮文案", "再改一版");
    // 等待策略：设超时但出口未连线 → 发布应被校验拦下
    await byAria("等待方式", "timeout");
    await click("保存工作流");
    await wait("出口缺连线被拦", `document.body.textContent.includes('还没有后续连线') || document.body.textContent.includes('还没有连线')`);
    check("缺出口连线阻止发布", true);
    const geometry = await portGeometry();
    check("三个真实出口及时出现、互不重叠且位于卡片底边",
      geometry.ports.length === 3 && new Set(geometry.ports.map((p) => p.x)).size === 3 && geometry.ports.every((p) => Math.abs(p.y - geometry.bottom) < 1), geometry);
    // 连线：通过→交付；再改一版→返工；超时→返工；返工→交付
    for (const [port, target] of [["confirm", "交付"], ["action_2", "返工"], ["timeout", "返工"]]) {
      await clickPort("人工输入", port, "output");
      await clickPort(target, "", "input");
    }
    check("三个操作出口均可实际点击连线", true);
    await config("返工", { advanced: true });
    await selectByOptionText("执行后进入", "交付");
    fs.writeFileSync(path.join(evidence, `${entry}-ports.png`), (await win.webContents.capturePage()).toPNG());
    const nodeClip = await js(`(()=>{const r=document.querySelector('.hemi-human-input').getBoundingClientRect();return {x:Math.floor(r.x-12),y:Math.floor(r.y-12),width:Math.ceil(r.width+24),height:Math.ceil(r.height+48)};})()`);
    fs.writeFileSync(path.join(evidence, `${entry}-node.png`), (await win.webContents.capturePage(nodeClip)).toPNG());
    await click("保存工作流");
    try {
      await wait("发布成功", `document.body.textContent.includes('已保存 · v1')`, 15000);
    } catch {
      const notice = await js(`document.querySelector('.h59-notice, [class*="notice"], [role="alert"]')?.textContent ?? document.body.textContent.slice(0, 500)`);
      throw new Error("发布未成功，notice=" + String(notice).slice(0, 400));
    }
    check("保存并发布通过（v1）", true);
    // 重开 round-trip：schema 保留
    await click("全部工作流");
    await wait("列表行出现", `!!document.querySelector('[data-testid="workflow-row"]')`);
    await js(`document.querySelector('[data-testid="workflow-row"]').click()`);
    await wait("详情页", `document.body.textContent.includes('预览')`);
    await click("编辑");
    await wait("画布重开", `!!document.querySelector('[data-testid="workflow-canvas"]')`);
    await config("人工输入");
    const roundTrip = await js(`(()=>{const get=(label)=>[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith(label))?.querySelector('input,textarea,select')?.value ?? null;return {
      content: get('展示内容'),
      planOptions: document.querySelector('[aria-label="字段 plan 选项"]')?.value ?? null,
      fieldCount: [...document.querySelectorAll('[aria-label^="字段 "]')].filter(el=>el.getAttribute('aria-label').endsWith(' 类型')).length,
      actionLabels: [...document.querySelectorAll('[aria-label$="按钮文案"]')].map(el=>el.value),
      waitMode: document.querySelector('[aria-label="等待方式"]')?.value ?? null,
    };})()`);
    check("重开保留 schema（内容/选项/字段数/动作/等待）",
      roundTrip.content?.includes("{{") && roundTrip.planOptions === "方案甲\n方案乙" &&
      roundTrip.fieldCount === 4 && roundTrip.actionLabels.join(",") === "通过,再改一版" && roundTrip.waitMode === "timeout",
      roundTrip);
    await sleep(700); // 等重开后的视口定位与检查器有限动效结束。
    const reopenedGeometry = await portGeometry();
    check("重开后真实端口保持位置与身份", reopenedGeometry.ports.length === 3 && reopenedGeometry.ports.every((p) => Math.abs(p.y - reopenedGeometry.bottom) < 1), reopenedGeometry);

    // ── 对话内走查：去对话运行 → 卡片表单 → 提交（含真实文件）──
    await click("全部工作流");
    await wait("列表行出现", `!!document.querySelector('[data-testid="workflow-row"]')`);
    await click("去对话运行");
    await wait("对话内出现准备卡", `!!document.querySelector('[data-testid="workflow-card"]')`);
    // chat 入口由主 agent 用真实准备卡工具保存参数：在对话输入框发主题
    await js(
      `(()=>{const t=document.querySelector('textarea[placeholder]');if(!t)throw Error('composer missing');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(`主题是：走查主题·${marker}`)});t.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
    await js(
      `document.querySelector('textarea[placeholder]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
    );
    await wait(
      "主 agent 工具更新就绪（开始运行可点）",
      `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='开始运行'&&!b.disabled)`,
      30000,
    );
    // Smoke mode starts hidden; interactive SDK popovers intentionally close while inactive.
    win.show();win.focus();
    await wait('SDK 展示实例活跃',`!!document.querySelector('[data-hemi-conversation-flow]:not([data-hcf-part]):not([data-hcf-active="false"])')`);
    await js(`document.querySelector('[data-testid="workflow-card"] .h24-model-chip').click()`);
    await wait('SDK 模型菜单打开',`!!document.querySelector('[aria-label="配置模型路由"]')`);
    await js(`document.querySelector('[aria-label="配置模型路由"]').click()`);
    await wait('宿主模型路由弹窗打开',`!!document.querySelector('.h64-route-dialog')`);
    check('SDK 模型设置动作打开原有宿主弹窗',true);
    await js(`document.querySelector('.h64-route-dialog [aria-label="关闭"]').click()`);
    await wait('宿主模型路由弹窗关闭',`!document.querySelector('.h64-route-dialog')`);
    await click("开始运行");
    try {
      await wait("挂起表单出现", `!!document.querySelector('[data-testid="workflow-interaction"]')`, 60000);
    } catch {
      const dump = await js(`(()=>{const card=document.querySelector('[data-testid="workflow-card"]');return {status:card?.dataset.status, hasInteraction:!!card?.querySelector('.h59-hi'), text:card?.textContent.slice(0,300)};})()`);
      throw new Error("挂起表单未出现：" + JSON.stringify(dump));
    }
    const formState = await js(`(()=>{const card=document.querySelector('[data-testid="workflow-card"]');return {
      content: document.querySelector('.h59-hi-content')?.textContent ?? '',
      options: [...document.querySelectorAll('.h59-hi-option span')].map(o=>o.textContent.trim()),
      buttons: [...document.querySelectorAll('.h59-hi-actions button')].map(b=>b.textContent.trim().replace(/（.*/,'')),
      prefill: document.querySelector('.h59-hi-form textarea')?.value ?? null,
    };})()`);
    check("上游真实输出代入表单内容", formState.content.includes(`唯一结果·${marker}`), formState.content);
    check("选项冻结为配置列表", JSON.stringify(formState.options) === JSON.stringify(["方案甲","方案乙"]), formState.options);
    check("动作按钮按配置渲染（含去向）", formState.buttons.join(",").startsWith("通过") && formState.buttons.join(",").includes("再改一版"), formState.buttons);
    const staleDraft = await js(`(async()=>{const list=await window.hemiVoice.workflowListInvocations();const inv=await window.hemiVoice.workflowGetInvocation(list[list.length-1].invocationId);const id=inv.run.currentInteractionId;const revision=inv.run.interactions[id].revision;return window.hemiVoice.workflowSaveInteractionDraft({invocationId:inv.invocationId,interactionId:id,expectedRevision:revision-1,values:{comment:'旧草稿不得写入'}});})()`);
    check('真实 IPC 将旧草稿版本拒绝为 conflict',staleDraft.ok===false&&staleDraft.code==='conflict');
    // 填写：方案乙（radio 组点选）＋批注＋真实文件路径
    await js(`(()=>{const label=[...document.querySelectorAll('.h59-hi-option')].find(o=>o.textContent.trim()==='方案乙');if(!label)return false;label.querySelector('input[type="radio"]').click();return true;})()`) || (await js(`(()=>{throw Error('方案乙 radio 不存在')})()`));
    await sleep(60);
    const textarea = await js(`(()=>{const el=[...document.querySelectorAll('.h59-hi-form textarea')].find(a=>a.getAttribute('aria-label')==='批注');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(`走查批注·${marker}`)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    if (!textarea) {
      const dump = await js(`[...document.querySelectorAll('.h59-hi-form label, .h59-hi textarea, .h59-hi input, .h59-hi select')].map(el=>el.tagName+':'+(el.getAttribute('aria-label')??el.textContent.slice(0,12))).join(' | ')`);
      throw new Error("批注输入框不存在：" + String(dump));
    }
    // 单文件可选项留空；多文件填写两份真实材料，两者都必须顺利续跑。
    const fileInput = await js(`(()=>{const el=document.querySelector('.h59-hi-form textarea[aria-label="材料列表"]');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(proofFile + "\n" + proofFile2)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    if (!fileInput) throw new Error("文件输入框不存在");
    await sleep(300); // 草稿防抖
    const beforeSubmit = await js(`window.hemiVoice.workflowListInvocations().then(list=>list[list.length-1])`);
    const cid = beforeSubmit.conversationId;
    // 正常 IPC 启动一个真实在途对话，provider 边界延迟返回，再经队列命令填满。
    await js(`void window.hemiVoice.flowCommand(${JSON.stringify(cid)}, {type:'send',input:{inputId:'busy-'+${JSON.stringify(marker)},text:'HIUI_BUSY 请等待本次回归端点返回'}});true`);
    for (let i = 0; i < 100 && !busyRequestStarted; i++) await sleep(50);
    assert.ok(busyRequestStarted, "忙时场景先证明 provider 请求已在途");
    for (let i = 0; i < PENDING_CAPACITY; i++) {
      const queued = await js(`window.hemiVoice.flowCommand(${JSON.stringify(cid)}, {type:'send',input:{inputId:'filler-${i}',text:'排队${i}'}})`);
      assert.ok(queued.ok);
    }
    await click("通过：交付");
    await wait("提交后只读记录", `!!document.querySelector('[data-testid="workflow-interaction-record"]')`, 30000);
    const record = await js(`document.querySelector('[data-testid="workflow-interaction-record"] .h59-hi-chosen strong')?.textContent`);
    check("只读记录显示选中操作", record === "通过", record);
    await wait("已保存响应可显式重试", `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='重试继续运行')`);
    check("队列满后响应保留并提供重试入口", true);
    const originalSize = win.getSize();
    const originalMinimum = win.getMinimumSize();
    win.setMinimumSize(320, 600);
    for (const width of [1440, 768, 375]) {
      win.setContentSize(width, 950);
      await sleep(400);
      check(`${width} 重试按钮可滚动到达且无横向溢出`, await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='重试继续运行');b?.scrollIntoView({block:'center'});const r=b?.getBoundingClientRect();return innerWidth===${width}&&!!r&&r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth;})()`));
      await sleep(100);
      fs.writeFileSync(path.join(evidence, `${entry}-retry-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setMinimumSize(...originalMinimum);
    win.setSize(...originalSize);
    for (let i = 0; i < PENDING_CAPACITY; i++)
      await js(`window.hemiVoice.flowCommand(${JSON.stringify(cid)}, {type:'withdrawInput',inputId:'filler-${i}'})`);
    await js(`window.hemiVoice.flowCommand(${JSON.stringify(cid)}, {type:'stop'})`);
    releaseBusy?.();
    await click("重试继续运行");
    await wait("运行完成", `document.querySelector('[data-testid="workflow-card"]')?.dataset.status === 'completed'`, 60000);
    check("对话内卡片完成", true);
    // 落盘事实：文件 manifest 已登记
    const invocation = await js(`window.hemiVoice.workflowListInvocations().then(list=>list[list.length-1]).then(inv=>window.hemiVoice.workflowGetInvocation(inv.invocationId))`);
    const hiFact = invocation.run?.nodes?.[Object.keys(invocation.run.nodes).find((id) => invocation.run.nodes[id].waitingKind === 'human-input' || invocation.run.nodes[id].outputs?.__action_id)] ?? null;
    check("提交值与文件 manifest 落盘",
      hiFact?.outputs?.plan === "方案乙" && hiFact?.outputs?.__action_id === "confirm" && !hiFact?.outputs?.proof && hiFact?.fileManifests?.proofs?.length === 2 && hiFact?.fileManifests?.proofs.every((item) => item.path && item.sha256),
      { outputs: hiFact?.outputs, manifests: Object.keys(hiFact?.fileManifests ?? {}) });

    console.log(`HEMI059_HIUI_RESULT ${JSON.stringify({ entry, marker, results })}`);
  } catch (error) {
    fatal = error;
    console.error(`HEMI059_HIUI_FAIL ${error?.stack ?? error}`);
  } finally {
    releaseBusy?.();
    try { server.close(); } catch { /* 即将退出 */ }
  }
  setTimeout(() => {
    if (fatal) process.exit(1);
    const failed = results.filter((r) => !r.ok);
    console.log(`HEMI059_HIUI_SUMMARY ${entry} ${results.length - failed.length}/${results.length}`);
    app.exit(failed.length ? 1 : 0);
  }, 300);
});
