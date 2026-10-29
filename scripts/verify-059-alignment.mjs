// Product-rendered design comparison journey: public UI only; no graph/state injection.
import fs from "node:fs";
import path from "node:path";
export async function captureAlignment({ win, js, evidence }) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (code) => {
    for (let i = 0; i < 120; i++) {
      if (await js(code)) return;
      await pause(100);
    }
    throw Error("alignment wait: " + code);
  };
  const click = async (selector) => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await pause(150);
  };
  const capture = async (name) => {
    await js(
      `(async()=>{const frame=()=>new Promise(r=>requestAnimationFrame(r));for(let i=0;i<3;i++){await frame();await frame();await Promise.all(document.getAnimations().filter(a=>(a.playState==='running'||a.pending)&&Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))}await frame();await frame();})()`,
    );
    await wait(
      `(()=>{document.body.getBoundingClientRect();return !document.getAnimations().some(a=>(a.playState==='running'||a.pending)&&Number.isFinite(a.effect?.getComputedTiming().endTime))})()`,
    );
    const facts = await js(
      `({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,lines:[...document.querySelectorAll('.gedit-flow-activity-edge')].map(e=>({rect:e.getBoundingClientRect().toJSON(),html:e.innerHTML,stroke:getComputedStyle(e.querySelector('path')).stroke,color:getComputedStyle(e.querySelector('stop')).stopColor})),parts:[...document.querySelectorAll('.h24-preview,.h24-preview-strip,.h59-run-preview,.h59-steps,.h59-steps button,.app-topbar,.h59-editor-title,.h59-editor-actions,.h59-editor-actions>button,.h59-editor-actions .h24-model-chip,.h59-sidebar,.h59-sidebar>.h24-sidebar-new,.h59-nav-label,.h59-nav-row,.h59-row,.h59-row-info,.h59-row-actions,.h59-workspace-toolbar,.h59-inspector,.h59-inspector-heading,.h59-inspector-body,.h59-inspector-body>label,.h59-input-sources,.h59-inspector-footer,.h59-node,.h59-detail-heading,.h59-detail-actions,.h59-consumer-section')].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),text:e.textContent,opacity:getComputedStyle(e).opacity,visibility:getComputedStyle(e).visibility,display:getComputedStyle(e).display,color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,font:getComputedStyle(e).font,lineHeight:getComputedStyle(e).lineHeight,padding:getComputedStyle(e).padding}))})`,
    );
    fs.writeFileSync(
      path.join(evidence, name + ".json"),
      JSON.stringify(facts, null, 2),
    );
    const screenshot = await win.webContents.debugger.sendCommand(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          x: 0,
          y: 0,
          width: facts.width,
          height: facts.height,
          scale: 1,
        },
      },
    );
    fs.writeFileSync(
      path.join(evidence, name + ".png"),
      Buffer.from(screenshot.data, "base64"),
    );
    if (facts.overflow) throw Error("page overflow " + name);
    if (facts.parts.some(part=>['h24-preview-strip','h59-run-preview h59-definition-preview selectable'].includes(part.class)&&part.opacity!=='1')) throw Error("preview captured before visible " + name);
  };
  const widths=process.env.HEMI059_ALIGNMENT_WIDTHS?.split(",").map(Number) ?? [1440,768,375];
  await click('button[title="工作流"]');
  for (const width of widths) {
    win.setContentSize(width, 900);
    await win.webContents.debugger.sendCommand(
      "Emulation.setDeviceMetricsOverride",
      { width, height: 900, deviceScaleFactor: 1, mobile: false },
    );
    await pause(250);
    // Sidebar is inside a drawer below 880; direct public navigation still uses its action.
    await click(".h59-sidebar>.h59-nav-row");
    await wait(`!!document.querySelector('[data-testid="workflow-studio"]')`);
    await capture("library-" + width);
    if (width <= 880) {
      await click('[aria-label="打开导航"]');
      await pause(300);
      await capture("drawer-" + width);
      if (
        !(await js(
          `Math.abs(document.querySelector('.h59-sidebar').getBoundingClientRect().width-224)<2`,
        ))
      )
        throw Error("drawer width at " + width);
      await click('.app-topbar [aria-label="关闭导航"]');
    }
    await click(".h59-workflow-name");
    await wait(`!!document.querySelector('[data-testid="workflow-detail"]')`);
    await capture("overview-" + width);
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='仅调整本次').click()`,
    );
    await wait(`!!document.querySelector('.h59-parameters-dialog')`);
    await capture("setup-" + width);
    if (
      !(await js(
        `(()=>{const r=document.querySelector('.h59-parameters-dialog').getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<2&&Math.abs(r.y+r.height/2-innerHeight/2)<2&&r.y>=15&&r.bottom<=innerHeight-15&&!!document.querySelector('.h59-parameters-dialog .h24-model-chip')})()`,
      ))
    )
      throw Error("run settings not centered/bounded with model at " + width);
    await click(".h59-parameters-dialog .h24-model-chip");
    await wait(`!!document.querySelector('[role="menuitemradio"]')`);
    await capture("setup-model-" + width);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait(`!document.querySelector('[role="menuitemradio"]')`);
    if (!(await js(`!!document.querySelector('.h59-parameters-dialog')`)))
      throw Error("model Esc closed settings");
    if (
      !(await js(
        `(()=>{const dates=[...document.querySelectorAll('.h59-date-range input')];return dates.length===2&&dates.every(e=>/^\\d{4}-\\d{2}-\\d{2}$/.test(e.value))})()`,
      ))
    )
      throw Error("relative date range is not displayed");
    await js(
      `[...document.querySelectorAll('.h59-parameters-dialog button')].find(b=>b.textContent.trim()==='取消').click()`,
    );
    await wait(`!document.querySelector('.h59-parameters-dialog')`);
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='预览流程').click()`,
    );
    await wait(
      `document.querySelectorAll('.h24-preview .h59-steps li').length===7`,
    );
    await wait(`[...document.querySelectorAll('.h24-preview .h59-steps button')].every(button=>getComputedStyle(button).display==='flex'&&button.getBoundingClientRect().width>200&&button.querySelector('svg').getBoundingClientRect().width<=16)`);
    await capture("overview-preview-" + width);
    fs.writeFileSync(
      path.join(evidence, "preview-facts-" + width + ".json"),
      JSON.stringify(
        await js(
          `({animations:document.getAnimations().map(a=>({target:a.effect?.target?.className,state:a.playState,pending:a.pending,current:a.currentTime,timing:a.effect?.getComputedTiming()})),bounds:[...document.querySelectorAll('.h24-preview,.h24-preview-strip,.h59-run-preview,.h59-steps')].map(e=>({rect:e.getBoundingClientRect().toJSON(),css:{display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,opacity:getComputedStyle(e).opacity},text:e.textContent})),scroll:[...document.querySelectorAll('.h24-preview *')].filter(e=>e.scrollTop||e.scrollLeft).map(e=>({c:e.className,top:e.scrollTop,left:e.scrollLeft}))})`,
        ),
        null,
        2,
      ),
    );
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait(`!document.querySelector('.h24-preview')`);
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='编辑流程').click()`,
    );
    await wait(`!!document.querySelector('[aria-label="配置分析数据"]')`);
    await pause(150);
    await capture("canvas-initial-" + width);
    if (
      !(await js(
        `(()=>{const paths=[...document.querySelectorAll('.gedit-flow-activity-edge path')];return paths.length===7&&paths.every(p=>p.getAttribute('d')?.length>10)})()`,
      ))
    )
      throw Error("canvas edges are missing at " + width);
    if (
      !(await js(
        `(()=>{const stage=document.querySelector('.h59-stage').getBoundingClientRect();const node=document.querySelector('.hemi-input').getBoundingClientRect();return Math.abs((node.x+node.width/2)-(stage.x+stage.width/2))<2})()`,
      ))
    )
      throw Error(
        "initial canvas is not centered at " +
          width +
          ": " +
          JSON.stringify(
            await js(
              `['.h59-stage','.gedit-playground','.hemi-input'].map(s=>({s,rect:document.querySelector(s)?.getBoundingClientRect().toJSON(),parent:document.querySelector(s)?.parentElement.getAttribute('style')}))`,
            ),
          ),
      );
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加节点').click()`,
    );
    await capture("add-" + width);
    if (
      !(await js(
        `(()=>{const menu=document.querySelector('.h59-add-menu').getBoundingClientRect();const anchor=document.querySelector('[aria-label="添加节点"]')?.getBoundingClientRect()??[...document.querySelectorAll('.h59-workspace-toolbar button')].find(b=>b.textContent.includes('添加节点')).getBoundingClientRect();return menu.y>=anchor.bottom&&menu.x>=0&&menu.right<=innerWidth&&menu.bottom<=innerHeight})()`,
      ))
    )
      throw Error("add menu lost anchor at " + width);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    for (const [scene, label] of [
      ["editor", "分析数据"],
      ["browser-node", "获取经营数据"],
      ["desktop-node", "生成演示文稿"],
      ["agent-node", "生成文字报告"],
      ["condition", "选择交付格式"],
      ["inputs", "输入参数"],
      ["delivery", "交付周报"],
    ]) {
      if (await js(`!!document.querySelector('.h59-inspector')`))
        await click('[aria-label="关闭配置"]');
      await click(`[aria-label="配置${label}"]`);
      await wait(`!!document.querySelector('.h59-inspector')`);
      await capture(scene + "-" + width);
    }
    await click('[aria-label="关闭配置"]');
  }
  await win.webContents.debugger.sendCommand(
    "Emulation.clearDeviceMetricsOverride",
  );
  fs.writeFileSync(
    path.join(evidence, "alignment-result.json"),
    JSON.stringify(
      {
        passed: true,
        widths,
        scope:
          "product-rendered public UI; programmatic clicks; no real node execution",
      },
      null,
      2,
    ),
  );
}
