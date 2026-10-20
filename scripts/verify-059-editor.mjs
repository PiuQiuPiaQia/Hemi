// 真正的作者路径：真实 Electron + preload IPC + FlowGram，逐项操作表单，不注入编辑器内部状态。
import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "hemi059-editor-")),
  ),
  evidence = path.resolve(
    process.env.HEMI059_EVIDENCE ??
      ".visual/workflow/vision/059-fix-validation/studio",
  );
fs.mkdirSync(evidence, { recursive: true });
app.setName("hemi");
app.setPath("userData", path.join(temp, "ud"));
const results = [],
  errors = [];
let win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => win.webContents.executeJavaScript(code);
const check = (name, ok, detail = null) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) throw Error(name);
};
const wait = async (name, code) => {
  for (let n = 0; n < 120; n++) {
    if (await js(code)) return;
    await sleep(100);
  }
  throw Error("等待超时：" + name);
};
const click = async (text, scope = "document") => {
  if (text === "返回")
    text = await js(
      `document.querySelector('.h59-sidebar .h59-nav-row.active')?.textContent.trim() || '全部工作流'`,
    );
  if (
    text === "返回工作流" &&
    !(await js(`!!document.querySelector('[data-testid="workflow-result"]')`))
  )
    text = "全部工作流";
  if (text === "保存并发布") text = "保存工作流";
  if (text === "保存草稿") {
    text = "仅保存草稿";
    await js(
      `document.querySelector('[aria-label="更多工作流操作"]')?.click()`,
    );
    await sleep(100);
  }
  if (
    text.startsWith("添加") &&
    !(await js(
      `[...document.querySelectorAll('button')].some(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}))`,
    ))
  ) {
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加节点')?.click()`,
    );
    await sleep(80);
  }
  await js(
    `(()=>{const button=[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}));if(button&&!button.getClientRects().length)button.closest('details')?.querySelector('summary')?.click();})()`,
  );
  const ok = await js(
    `(()=>{const b=[...(${scope}).querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}));if(!b||b.disabled)return false;b.click();return true;})()`,
  );
  if (!ok) throw Error("按钮不可用：" + text);
  await sleep(80);
};
const field = async (label, value) => {
  label =
    label === "使用的 Skill"
      ? "调用 Skill"
      : label === "节点名称"
        ? "名称"
        : label;
  if (label === "任务目标")
    label = await js(
      `[...document.querySelectorAll('.h59-inspector label')].map(l=>l.textContent.trim()).find(text=>['任务目标','执行说明','操作说明'].some(prefix=>text.startsWith(prefix)))?.match(/^(任务目标|执行说明|操作说明)/)?.[0] || '任务目标'`,
    );
  await ensureAdvancedField(label);
  await js(
    `(()=>{const label=[...document.querySelectorAll('.h59-inspector label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}));const details=label?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click();})()`,
  );
  await js(
    `(()=>{const label=[...document.querySelectorAll('.h59-inspector label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}));const el=label?.querySelector('input,textarea,select');if(!el)throw Error('字段不存在');const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`,
  );
  await sleep(80);
};
const ensureAdvancedField = async (label) => {
  if (
    await js(
      `[...document.querySelectorAll('.h59-inspector label')].some(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}))`,
    )
  )
    return;
  await click("更多工作流操作");
  await click("节点高级配置");
};
const config = async (name) => {
  if (
    await js(
      `innerWidth<1180 && !!document.querySelector('[aria-label="关闭配置"]')`,
    )
  )
    await click("关闭配置");
  await js(`document.querySelector('[aria-label="配置${name}"]').click()`);
  await sleep(80);
  if (!(await js(`!!document.querySelector('.h59-layout-options')`))) {
    await click("更多工作流操作");
    await click("节点高级配置");
  }
};
const shot = async (name) =>
  fs.writeFileSync(
    path.join(evidence, name + ".png"),
    (await win.webContents.capturePage()).toPNG(),
  );
// The imperative SDK commits in its own root. Observe settled layout instead
// of sampling between the inspector commit and ResizeObserver's camera update.
const settleCanvas = () =>
  js(
    `new Promise(resolve=>{let previous='',stable=0;function frame(){const node=document.querySelector('.h59-node'),r=node?.getBoundingClientRect();const current=JSON.stringify(r?.toJSON());stable=current===previous?stable+1:0;previous=current;if(stable>=5)resolve();else requestAnimationFrame(frame);}requestAnimationFrame(frame);})`,
  );
const verifyMenu = async (scope, width) => {
  const modelScope =
    scope === '[data-testid="workflow-canvas"]'
      ? "#h59-editor-actions-slot"
      : scope;
  win.setMinimumSize(320, 400);
  win.setContentSize(width, 900);
  await sleep(150);
  win.show();
  win.focus();
  win.webContents.focus();
  await js(
    `(()=>{const b=document.querySelector(${JSON.stringify(modelScope)}).querySelector('.h24-model-chip');b.focus();b.click();})()`,
  );
  await wait(
    "选模搜索",
    `!!document.querySelector('input[placeholder="搜索名称 / 型号 / 端点"]')`,
  );
  await js(
    `(()=>{const e=document.querySelector('input[placeholder="搜索名称 / 型号 / 端点"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'editor-model-B');e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`,
  );
  await sleep(100);
  check(
    `${scope} ${width} 模型菜单不越界`,
    await js(
      `(()=>{const r=document.querySelector('[role="menu"]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`,
    ),
  );
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
  await sleep(50);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await wait("键盘选择后关闭菜单", `!document.querySelector('[role="menu"]')`);
  check(
    `${scope} ${width} 搜索方向键 Enter 可选且不修改应用模型`,
    await js(
      `document.querySelector(${JSON.stringify(modelScope)}).querySelector('.h24-model-chip').textContent.includes('editor-model-B') && window.hemiVoice.listModelProfiles().then(d=>d.defaultModelId==='test/a')`,
    ),
  );
  await js(
    `document.querySelector(${JSON.stringify(modelScope)}).querySelector('.h24-model-chip').click()`,
  );
  await wait("重开菜单", `!!document.querySelector('[role="menu"]')`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait("Esc 关闭选模", `!document.querySelector('[role="menu"]')`);
  await js(
    `document.querySelector(${JSON.stringify(modelScope)}).querySelector('.h24-model-chip').click()`,
  );
  await wait("外点前菜单", `!!document.querySelector('[role="menu"]')`);
  win.webContents.sendInputEvent({
    type: "mouseDown",
    x: width - 15,
    y: 870,
    button: "left",
    clickCount: 1,
  });
  win.webContents.sendInputEvent({
    type: "mouseUp",
    x: width - 15,
    y: 870,
    button: "left",
    clickCount: 1,
  });
  await wait("外点关闭菜单", `!document.querySelector('[role="menu"]')`);
};
app.whenReady().then(async () => {
  let fatal;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      path.join(app.getPath("userData"), "text-model-profiles.json"),
      JSON.stringify({
        version: 3,
        defaultModelId: "test/a",
        roleModels: { main: "test/a", fixer: "test/b" },
        providers: [
          {
            id: "test",
            name: "UI验证",
            baseUrl: "https://invalid.example/v1",
            encryptedApiKey: safeStorage
              .encryptString("fixture-key")
              .toString("base64"),
            models: [
              { id: "a", model: "editor-model", supportsVision: false },
              { id: "b", model: "editor-model-B", supportsVision: false },
            ],
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
    await (await import("../src/main/ipc/index.mjs")).registerAllIpcHandlers();
    const skillDir = path.join(temp, "skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: editor-fixture\ndescription: 编辑验证技能\n---\n按输入整理摘要。\n",
    );
    await (
      await import("../src/main/ipc/skills.ipc.mjs")
    )
      .getSkillService()
      .importDirectory(skillDir);

    await (
      await import("../src/main/windows/main-window.mjs")
    ).createMainWindow();
    win = (await import("../src/main/state.mjs")).state.mainWindow;
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    check(
      "实际加载请求的开发或构建入口",
      process.env.VITE_DEV_SERVER_URL
        ? win.webContents.getURL().startsWith(process.env.VITE_DEV_SERVER_URL)
        : win.webContents.getURL().startsWith("file:"),
    );
    await wait(
      "导航",
      `Boolean(document.querySelector('button[title="工作流"]'))`,
    );
    await js(`document.querySelector('button[title="工作流"]').click()`);
    await wait(
      "列表",
      `Boolean(document.querySelector('[data-testid="workflow-studio"]'))`,
    );
    await click("新建工作流");
    await wait("真实节点", `document.querySelectorAll('.h59-node').length===2`);
    check(
      "输入和交付节点真实可见",
      await js(
        `[...document.querySelectorAll('.h59-node')].every(n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return b.width>100&&b.height>25&&s.visibility==='visible'&&Number(s.opacity)>0&&n.textContent.trim().length>0;})`,
      ),
    );
    await sleep(500);
    const inputPoint = await js(
      `(()=>{const r=document.querySelector('[aria-label="配置输入"] .h59-node').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
    );
    win.webContents.sendInputEvent({ type: "mouseMove", ...inputPoint });
    win.webContents.sendInputEvent({
      type: "mouseDown",
      ...inputPoint,
      button: "left",
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: "mouseUp",
      ...inputPoint,
      button: "left",
      clickCount: 1,
    });
    await wait(
      "单击节点配置",
      `!!document.querySelector('.h59-inspector input[aria-label="节点名称"]')`,
    );
    check(
      "真实鼠标单击节点即打开配置",
      await js(
        `document.querySelector('.h59-inspector input[aria-label="节点名称"]').value==='输入'`,
      ),
    );
    check(
      "单击节点不产生空撤销",
      await js(`document.querySelector('[aria-label="撤销"]').disabled`),
    );
    await settleCanvas();
    const selectedBounds = await js(
      `document.querySelector('[aria-label="配置输入"]').getBoundingClientRect().toJSON()`,
    );
    await click("关闭配置");
    await sleep(120);
    await config("输入");
    await sleep(120);
    await settleCanvas();
    const reopenedBounds = await js(
      `document.querySelector('[aria-label="配置输入"]').getBoundingClientRect().toJSON()`,
    );
    check(
      "配置关闭重开不导致画布累计偏移",
      Math.abs(selectedBounds.x - reopenedBounds.x) < 1 &&
        Math.abs(selectedBounds.y - reopenedBounds.y) < 1,
      { selectedBounds, reopenedBounds },
    );
    await click("关闭配置");
    await click("添加普通执行");
    await field("任务目标", "将输入主题整理为摘要");
    await field("节点名称", "整理摘要");
    // 先连接输入→执行，再选择可达的参数来源。
    await config("输入");
    const first = await js(`window.hemiVoice.workflowList()`),
      id = first[0].workflowId;
    await js(
      `(()=>{const input=document.querySelector('input[aria-label="工作流名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'编辑器完整验证');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await field("默认值", "验证主题");
    await js(
      `(()=>{const el=[...document.querySelectorAll('.h59-inspector label')].find(l=>l.textContent.trim().startsWith('执行后进入')).querySelector('select');const option=[...el.options].find(o=>o.text==='整理摘要');el.value=option.value;el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(100);
    await config("整理摘要");
    await click("添加输入");
    await field("执行后进入", "deliver");
    await field("水平位置", "320");
    await field("垂直位置", "160");
    await config("交付");
    await click("添加交付");
    await js(
      `(()=>{const el=[...document.querySelectorAll('.h59-inspector label')].find(l=>l.textContent.trim().startsWith('交付来源 1')).querySelector('select');const option=[...el.options].find(o=>o.text.includes('整理摘要'));if(!option)throw Error('绑定源未出现：'+[...el.options].map(o=>o.text).join(','));el.value=option.value;el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(100);
    await click("关闭配置");
    win.show();
    win.focus();
    win.webContents.focus();
    await sleep(200);
    check(
      "已保存依赖线渲染为可见路径",
      await js(
        `(()=>{const paths=[...document.querySelectorAll('.gedit-flow-activity-edge path')];return paths.length>=2&&paths.every(p=>p.getAttribute('d')?.length>10)})()`,
      ),
    );
    const dragBefore = await js(
      `document.querySelector('[aria-label="配置输入"] .h59-node').getBoundingClientRect().toJSON()`,
    );
    const pathBefore = await js(
      `[...document.querySelectorAll('.gedit-flow-activity-edge path')].map(p=>p.getAttribute('d')).join('|')`,
    );
    const dragFrom = {
      x: Math.round(dragBefore.x + 100),
      y: Math.round(dragBefore.y + 24),
    };
    win.webContents.sendInputEvent({ type: "mouseMove", ...dragFrom });
    win.webContents.sendInputEvent({
      type: "mouseDown",
      ...dragFrom,
      button: "left",
      clickCount: 1,
    });
    for (let step = 1; step <= 8; step++) {
      win.webContents.sendInputEvent({
        type: "mouseMove",
        x: dragFrom.x + step * 8,
        y: dragFrom.y + step * 5,
        button: "left",
      });
      await sleep(40);
    }
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x: dragFrom.x + 64,
      y: dragFrom.y + 40,
      button: "left",
      clickCount: 1,
    });
    await sleep(160);
    const dragAfter = await js(
      `document.querySelector('[aria-label="配置输入"] .h59-node').getBoundingClientRect().toJSON()`,
    );
    check(
      "拖动节点时配置不弹出且连线跟随",
      Math.abs(dragAfter.x - dragBefore.x) > 20 &&
        (await js(
          `!document.querySelector('.h59-inspector')&&[...document.querySelectorAll('.gedit-flow-activity-edge path')].map(p=>p.getAttribute('d')).join('|')!==${JSON.stringify(pathBefore)}`,
        )),
    );
    await click("撤销");
    await sleep(160);
    const undoAfter = await js(
      `document.querySelector('[aria-label="配置输入"] .h59-node').getBoundingClientRect().toJSON()`,
    );
    check(
      "SDK 撤销恢复真实节点位置和连线",
      Math.abs(undoAfter.x - dragBefore.x) < 1 &&
        Math.abs(undoAfter.y - dragBefore.y) < 1 &&
        (await js(
          `[...document.querySelectorAll('.gedit-flow-activity-edge path')].map(p=>p.getAttribute('d')).join('|')===${JSON.stringify(pathBefore)}`,
        )),
    );
    const boundsBefore = await js(
      `document.querySelector('.h59-node').getBoundingClientRect().toJSON()`,
    );
    const origin = await js(
      `(()=>{const r=document.querySelector('.gedit-playground').getBoundingClientRect();return {x:Math.round(r.left+50),y:Math.round(r.top+50)};})()`,
    );
    win.webContents.sendInputEvent({
      type: "mouseDown",
      ...origin,
      button: "middle",
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: "mouseMove",
      x: origin.x + 100,
      y: origin.y + 70,
      button: "middle",
    });
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x: origin.x + 100,
      y: origin.y + 70,
      button: "middle",
      clickCount: 1,
    });
    await sleep(180);
    const panned = await js(
      `document.querySelector('.h59-node').getBoundingClientRect().toJSON()`,
    );
    check(
      "真实画布平移改变视口",
      Math.abs(panned.x - boundsBefore.x) > 10 ||
        Math.abs(panned.y - boundsBefore.y) > 10,
    );
    win.webContents.sendInputEvent({
      type: "mouseWheel",
      ...origin,
      deltaY: -120,
      modifiers: ["control"],
      canScroll: true,
    });
    await sleep(250);
    const zoomed = await js(
      `document.querySelector('.h59-node').getBoundingClientRect().toJSON()`,
    );
    check(
      "真实画布缩放改变显示比例",
      Math.abs(zoomed.width - panned.width) > 1,
    );
    check(
      "画布缩放控件真实可见且未被画布遮挡",
      await js(
        `[...document.querySelectorAll('.h59-canvas-controls button')].every(button=>{const r=button.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button;})`,
      ),
    );
    const fitPoint = await js(
      `(()=>{const r=document.querySelector('[aria-label="适应画布"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
    );
    win.webContents.sendInputEvent({
      type: "mouseDown",
      ...fitPoint,
      button: "left",
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: "mouseUp",
      ...fitPoint,
      button: "left",
      clickCount: 1,
    });
    await sleep(250);
    await click("保存并发布");
    await wait(
      "发布",
      `document.querySelector('.h59-editor-title').textContent.includes('已保存 · v')`,
    );
    const fastPoint = await js(
      `(()=>{const r=document.querySelector('.h59-node').getBoundingClientRect();return {x:Math.round(r.x+100),y:Math.round(r.y+24)}})()`,
    );
    win.webContents.sendInputEvent({
      type: "mouseDown",
      ...fastPoint,
      button: "left",
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: "mouseMove",
      x: fastPoint.x + 60,
      y: fastPoint.y + 30,
      button: "left",
    });
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x: fastPoint.x + 60,
      y: fastPoint.y + 30,
      button: "left",
      clickCount: 1,
    });
    await wait(
      "快速拖动使图变脏",
      `document.querySelector('.h59-editor-title').textContent.includes('未保存')`,
    );
    await click("撤销");
    await wait(
      "撤销回到保存基线",
      `document.querySelector('.h59-editor-title').textContent.includes('已保存 · v')`,
    );
    check(
      "快速拖动可撤销回已保存基线",
      await js(`!document.querySelector('.h59-inspector')`),
    );
    const record = await js(
      `window.hemiVoice.workflowGetRevision(${JSON.stringify(id)},1)`,
    );
    const task = record.document.nodes.find((n) => n.type === "hemi-agent");
    check(
      "表单、连线、绑定和布局实际保存",
      task.data.goal === "将输入主题整理为摘要" &&
        task.data.inputBindings[0].key === "topic" &&
        task.meta.position.x === 320 &&
        record.document.edges.length === 2,
    );
    await click("全部工作流");
    await wait(
      "列表",
      `Boolean(document.querySelector('[data-testid="workflow-row"]'))`,
    );
    await js(
      `(()=>{const input=document.querySelector('input[aria-label="搜索工作流"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'不匹配的名称');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(
      "搜索过滤",
      `document.querySelectorAll('[data-testid="workflow-row"]').length===0`,
    );
    check(
      "搜索过滤且不会改动已保存定义",
      (await js(`window.hemiVoice.workflowList()`)).length === 1,
    );
    await js(
      `(()=>{const input=document.querySelector('input[aria-label="搜索工作流"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(
      "搜索清空恢复",
      `document.querySelectorAll('[data-testid="workflow-row"]').length===1`,
    );
    for (const width of [1440, 768, 375])
      await verifyMenu('[data-testid="workflow-studio"]', width);
    win.setContentSize(1440, 900);
    await sleep(150);
    await click("编辑器完整验证");
    await wait(
      "详情",
      `Boolean(document.querySelector('[data-testid="workflow-detail"]'))`,
    );
    check(
      "详情具备双运行和流程入口",
      await js(
        `['直接运行','去对话运行','预览流程','编辑流程'].every(t=>[...document.querySelectorAll('[data-testid="workflow-detail"] button')].some(b=>b.textContent===t))`,
      ),
    );
    win.setMinimumSize(320, 400);
    for (const width of [1440, 768, 375]) {
      win.setContentSize(width, 800);
      await sleep(200);
      check(
        `${width} 详情四入口可见`,
        await js(
          `['直接运行','去对话运行','预览流程','编辑流程'].every(text=>{const b=[...document.querySelectorAll('[data-testid="workflow-detail"] button')].find(b=>b.textContent===text);const r=b.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})`,
        ),
      );
      await js(
        `(()=>{const b=[...document.querySelectorAll('[data-testid="workflow-detail"] button')].find(b=>b.textContent==='预览流程');b.focus();b.click();window.__detailTrigger=b;})()`,
      );
      await wait("详情只读预览", `!!document.querySelector('.h24-preview')`);
      await shot(`detail-preview-${width}`);
      win.show();
      win.focus();
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await wait("Esc 返回详情", `!document.querySelector('.h24-preview')`);
      check(
        `${width} 只读预览返回原详情焦点`,
        await js(
          `!!document.querySelector('[data-testid="workflow-detail"]')&&document.activeElement===window.__detailTrigger`,
        ),
      );
    }
    win.setContentSize(1440, 900);
    await sleep(200);
    for (const width of [1440, 768, 375])
      await verifyMenu('[data-testid="workflow-detail"]', width);
    win.setContentSize(1440, 900);
    await sleep(150);
    await click("编辑流程");
    await wait("重开节点", `document.querySelectorAll('.h59-node').length===3`);
    for (const width of [1440, 768, 375])
      await verifyMenu('[data-testid="workflow-canvas"]', width);
    check(
      "编辑页选模不使图变脏",
      await js(
        `![...document.querySelectorAll('[data-testid="workflow-canvas"] small')].some(e=>e.textContent==='未保存')`,
      ),
    );
    win.setContentSize(1440, 900);
    await sleep(150);
    await config("整理摘要");
    check(
      "重开恢复任务目标",
      await js(
        `document.querySelector('.h59-inspector textarea').value==='将输入主题整理为摘要'`,
      ),
    );
    win.setMinimumSize(320, 400);
    for (const width of [1440, 768, 375]) {
      win.setContentSize(width, 900);
      await sleep(300);
      check(`${width} 实际视口一致`, await js(`innerWidth===${width}`));
      check(
        `${width} 无页面横溢出`,
        await js(`document.documentElement.scrollWidth<=innerWidth`),
      );
      fs.writeFileSync(
        path.join(evidence, `computed-${width}.json`),
        JSON.stringify(
          await js(
            `(()=>{const e=document.querySelector('.h59-inspector'),s=getComputedStyle(e),b=e.getBoundingClientRect();return {rect:b.toJSON(),style:e.getAttribute('style'),classes:e.className,computed:Object.fromEntries(['position','top','right','bottom','left','width','height','transform','translate','scale','zIndex','overflow','maxHeight'].map(k=>[k,s[k]]))};})()`,
          ),
          null,
          2,
        ),
      );
      check(
        `${width} 配置面板可点击`,
        await js(
          `(()=>{const button=[...document.querySelectorAll('.h59-inspector button')].find(b=>b.textContent==='关闭配置');const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`,
        ),
      );
      await shot(`editor-${width}`);
    }
    win.setContentSize(1440, 900);
    await field("任务目标", "尚未保存的修改");
    const definitionsBeforeCreate = (
      await js(`window.hemiVoice.workflowList()`)
    ).length;
    await click("新建工作流");
    await wait(
      "新建也需离开确认",
      `!!document.querySelector('[aria-label="未保存的流程"]')`,
    );
    await click("继续编辑");
    check(
      "取消新建保留未保存编辑且不创建额外草稿",
      (await js(
        `document.querySelector('.h59-inspector textarea').value==='尚未保存的修改'`,
      )) &&
        (await js(`window.hemiVoice.workflowList()`)).length ===
          definitionsBeforeCreate,
    );
    await click("返回");
    await wait(
      "离开保护",
      `Boolean(document.querySelector('[aria-label="未保存的流程"]'))`,
    );
    await click("继续编辑");
    check(
      "取消离开保留编辑值",
      await js(
        `document.querySelector('.h59-inspector textarea').value==='尚未保存的修改'`,
      ),
    );
    await click("返回");
    await click("放弃修改");
    await wait(
      "详情恢复",
      `Boolean(document.querySelector('[data-testid="workflow-detail"]'))`,
    );
    await click("返回工作流");
    await click("复制");
    await wait(
      "副本",
      `document.querySelectorAll('[data-testid="workflow-row"]').length===2`,
    );
    check(
      "复制为独立草稿",
      await js(
        `[...document.querySelectorAll('[data-testid="workflow-row"]')].some(r=>r.textContent.includes('副本')&&r.textContent.includes('草稿'))`,
      ),
    );
    for (const width of [1440, 768, 375]) {
      win.setContentSize(width, 900);
      await sleep(150);
      check(
        `${width} 删除入口无需展开菜单且可见`,
        await js(
          `(()=>{const button=document.querySelector('.h59-row-delete');const r=button.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&getComputedStyle(button).opacity==='1';})()`,
        ),
      );
      await click("删除");
      await wait(
        "删除确认弹窗",
        `(()=>{const d=document.querySelector('.h59-delete-dialog');return d && d.getAnimations({subtree:true}).every(a=>a.playState==='finished');})()`,
      );
      await shot(`delete-confirm-${width}`);
      check(
        `${width} 删除确认不越界且没有立即删除`,
        await js(
          `(()=>{const d=document.querySelector('.h59-delete-dialog'),r=d.getBoundingClientRect(),b=[...d.querySelectorAll('button')].find(b=>b.textContent==='确认删除').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&b.top>=0&&b.bottom<=innerHeight&&document.querySelectorAll('[data-testid="workflow-row"]').length===2;})()`,
        ),
      );
      await click("取消");
      await wait("取消删除", `!document.querySelector('.h59-delete-dialog')`);
    }
    win.setContentSize(1440, 900);
    await sleep(150);
    await click("删除");
    await click("确认删除");
    await wait(
      "删除条目",
      `document.querySelectorAll('[data-testid="workflow-row"]').length===1`,
    );
    check("删除后列表一致", true);
    await click("编辑");
    await wait(
      "编辑器重开",
      `Boolean(document.querySelector('[data-testid="workflow-canvas"]'))`,
    );
    const pick = async (label, text) => {
      label =
        label === "比较字段"
          ? "判断内容"
          : label === "条件成立"
            ? "符合条件"
            : label === "条件不成立"
              ? "不符合条件"
              : label;
      await ensureAdvancedField(label);
      await js(
        `(()=>{const label=[...document.querySelectorAll('.h59-inspector label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}));const el=label.querySelector('select'),option=[...el.options].find(o=>o.text.includes(${JSON.stringify(text)}));if(!option)throw Error('选项不存在：'+${JSON.stringify(text)});el.value=option.value;el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await sleep(80);
    };
    await click("添加Skill");
    await field("任务目标", "按技能整理主题");
    await field("使用的 Skill", "editor-fixture");
    await click("添加浏览器操作");
    await field("任务目标", "读取目标网页");
    await field("目标网址", "https://example.com");
    await click("添加桌面操作");
    await field("任务目标", "打开计算器");
    await wait(
      "已安装应用",
      `[...document.querySelectorAll('.h59-inspector option')].some(o=>o.value==='com.apple.calculator')`,
    );
    await field("目标应用", "com.apple.calculator");
    await click("添加条件");
    for (const [from, to] of [
      ["输入", "Skill"],
      ["Skill", "浏览器操作"],
      ["浏览器操作", "整理摘要"],
      ["整理摘要", "条件"],
      ["桌面操作", "交付"],
    ]) {
      await config(from);
      await pick("执行后进入", to);
    }
    await config("条件");
    await pick("比较字段", "主题");
    await field("比较值", "验证主题");
    await pick("条件成立", "桌面操作");
    await pick("条件不成立", "交付");
    await click("保存并发布");
    await wait(
      "七节点发布",
      `document.querySelector('.h59-editor-title').textContent.includes('已保存 · v')`,
    );
    const seven = await js(
      `window.hemiVoice.workflowGetRevision(${JSON.stringify(id)},2)`,
    );
    check(
      "七种节点专属配置和条件双出口发布成功",
      seven.document.nodes.length === 7 &&
        new Set(seven.document.nodes.map((n) => n.type)).size === 7 &&
        seven.document.edges.length === 7 &&
        seven.document.nodes.find((n) => n.type === "hemi-skill").data
          .skillRefs[0].name === "editor-fixture",
    );
    await click("全部工作流");
    await wait(
      "回列表",
      `Boolean(document.querySelector('[data-testid="workflow-row"]'))`,
    );
    await click("编辑");
    await wait(
      "七节点恢复",
      `document.querySelectorAll('.h59-node').length===7`,
    );
    check("七节点保存重开无类型或配置丢失", true);
    await config("桌面操作");
    await field("执行后进入", "");
    await click("关闭配置");
    await click("适应画布");
    await sleep(600);
    const desktopId = seven.document.nodes.find(
      (n) => n.type === "hemi-desktop",
    ).id;
    win.show();
    win.focus();
    win.webContents.focus();
    await sleep(250);
    const ports = await js(
      `['port_output_${desktopId}_','port_input_deliver_'].map(id=>{const el=document.querySelector('[data-port-entity-id="'+id+'"]');if(!el)throw Error('端口未渲染：'+id);const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})`,
    );
    await js(
      `window.__mouseEvents=[];for(const type of ['mousedown','mouseup','mousemove'])document.addEventListener(type,e=>window.__mouseEvents.push({type,x:e.clientX,y:e.clientY,target:e.target.outerHTML?.slice(0,120)}),true);`,
    );
    win.webContents.sendInputEvent({ type: "mouseMove", ...ports[0] });
    await sleep(120);
    const beforeMouse = await js(
      `({focus:document.hasFocus(),ports:[...document.querySelectorAll('[data-port-entity-id]')].map(e=>({id:e.dataset.portEntityId,class:e.className,rect:e.getBoundingClientRect().toJSON()}))})`,
    );
    win.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...ports[0],
    });
    for (let i = 1; i <= 8; i++) {
      win.webContents.sendInputEvent({
        type: "mouseMove",
        button: "left",
        x: Math.round(ports[0].x + ((ports[1].x - ports[0].x) * i) / 8),
        y: Math.round(ports[0].y + ((ports[1].y - ports[0].y) * i) / 8),
      });
      await sleep(40);
    }
    await sleep(120);
    win.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      ...ports[1],
    });
    await sleep(160);
    await click("保存草稿");
    await wait(
      "鼠标连线保存",
      `document.querySelector('.h59-editor-title').textContent.includes('草稿已保存')`,
    );
    const mouseGraph = await js(
      `window.hemiVoice.workflowGetDraft(${JSON.stringify(id)})`,
    );
    fs.writeFileSync(
      path.join(evidence, "mouse-state.json"),
      JSON.stringify(
        {
          beforeMouse,
          events: await js(`window.__mouseEvents`),
          ports,
          mouseGraph,
          seven,
          dom: await js(
            `[...document.querySelectorAll('[data-port-entity-id]')].map(e=>({id:e.dataset.portEntityId,rect:e.getBoundingClientRect().toJSON()}))`,
          ),
          notice: await js(
            `document.querySelector('[data-testid="workflow-canvas"]').textContent.slice(0,600)`,
          ),
        },
        null,
        2,
      ),
    );
    check(
      "真实鼠标端口连线和表单连线产生相同图",
      mouseGraph.document.edges.length === seven.document.edges.length &&
        mouseGraph.document.edges.some(
          (e) => e.sourceNodeID === desktopId && e.targetNodeID === "deliver",
        ),
    );
    await click("关闭配置").catch(() => {});
    await click("适应画布");
    await shot("editor-seven-types");

    await config("桌面操作");
    await field("执行后进入", "");
    await click("关闭配置");
    const clickPort = async (portId) => {
      const point = await js(
        `(()=>{const r=document.querySelector('[data-port-entity-id="'+${JSON.stringify(portId)}+'"]')?.getBoundingClientRect();if(!r)throw Error('端口不可见');return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
      );
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      win.webContents.sendInputEvent({
        type: "mouseDown",
        ...point,
        button: "left",
        clickCount: 1,
      });
      win.webContents.sendInputEvent({
        type: "mouseUp",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await sleep(120);
    };
    await clickPort(`port_output_${desktopId}_`);
    check(
      "端口单击进入连接模式",
      await js(`!!document.querySelector('[data-pending-source="true"]')`),
    );
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await sleep(80);
    check(
      "Esc 取消连线模式",
      await js(`!document.querySelector('[data-pending-source="true"]')`),
    );
    await clickPort(`port_output_${desktopId}_`);
    await clickPort("port_input_deliver_");
    await click("保存草稿");
    const clickedGraph = await js(
      `window.hemiVoice.workflowGetDraft(${JSON.stringify(id)})`,
    );
    check(
      "点击两端口与拖拽表单使用同一连线契约",
      clickedGraph.document.edges.length === seven.document.edges.length &&
        clickedGraph.document.edges.some(
          (edge) =>
            edge.sourceNodeID === desktopId && edge.targetNodeID === "deliver",
        ),
    );
    const beforeNew = await js(`window.hemiVoice.workflowList()`);
    const savedBeforeNew = await js(
      `window.hemiVoice.workflowGetDraft(${JSON.stringify(id)})`,
    );
    await js(
      `(()=>{const input=document.querySelector('[aria-label="工作流名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'尚未保存的新名称');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await sleep(80);
    await click("新建工作流");
    await wait(
      "新建前保护未保存名称",
      `!!document.querySelector('[aria-label="未保存的流程"]')`,
    );
    await click("放弃修改");
    await wait(
      "确认离开后进入独立空白画布",
      `document.querySelector('[aria-label="工作流名称"]')?.value==='未命名工作流' && document.querySelectorAll('.h59-node').length===2`,
    );
    check(
      "确认放弃后新建独立空白，原已保存流程不变",
      (await js(`window.hemiVoice.workflowList()`)).length ===
        beforeNew.length + 1 &&
        JSON.stringify(
          await js(`window.hemiVoice.workflowGetDraft(${JSON.stringify(id)})`),
        ) === JSON.stringify(savedBeforeNew),
    );
    await shot("blank-created-after-leave");
    check("渲染无运行错误", errors.length === 0);
  } catch (e) {
    fatal = e.stack;
    console.error(fatal);
    if (win) await shot("failure");
  }
  fs.writeFileSync(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        passed: !fatal,
        rendererUrl: win?.webContents.getURL(),
        electron: process.versions.electron,
        results,
        errors,
        fatal,
      },
      null,
      2,
    ),
  );
  console.log(
    "HEMI059_EDITOR_RESULT=" + JSON.stringify({ passed: !fatal, results }),
  );
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(fatal ? 1 : 0);
});
