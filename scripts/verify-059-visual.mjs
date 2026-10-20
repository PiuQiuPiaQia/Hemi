// 059 视觉 fixture 检查：真实 Electron renderer 离屏截图，不替代解锁后的原生窗口交互验收。
// 先 npm run dev:renderer，再 npx electron scripts/verify-059-visual.mjs。
import { app, BrowserWindow, nativeTheme } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hemi059-visual-"));
app.setName("hemi");
app.setPath("userData", temp);
const evidence = path.resolve(
  ".visual/workflow/vision/059-visual-review-2026-10-17/fixtures",
);
fs.mkdirSync(evidence, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const errors = [],
    checks = [];
  let win;
  try {
    nativeTheme.themeSource = "light";
    win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    const states = [
      "preparing",
      "queued",
      "running",
      "waiting",
      "failed",
      "interrupted",
      "completed",
      "stopped",
    ];
    for (const width of [1440, 768, 375])
      for (const state of width === 1440
        ? states
        : ["preparing", "waiting", "interrupted", "completed"]) {
        win.setContentSize(width, 900);
        await win.loadURL(
          `http://127.0.0.1:5173/fixtures.html?scene=workflow-card-visual&state=${state}`,
        );
        for (let i = 0; i < 100; i++) {
          if (
            await win.webContents.executeJavaScript(
              `!!document.querySelector('[data-testid="workflow-card"]')`,
            )
          )
            break;
          await sleep(50);
        }
        await sleep(200);
        const facts = await win.webContents.executeJavaScript(`(()=>{
        const card=document.querySelector('[data-testid="workflow-card"]');if(!card)throw Error('执行卡不可见');
        const primary=card.querySelector('.h37-btn-primary'),button=primary?getComputedStyle(primary):null;
        const box=card.getBoundingClientRect();
        return {width:innerWidth,status:card.dataset.status,overflow:document.documentElement.scrollWidth>innerWidth,cardWidth:box.width,
          primary:primary?{background:button.backgroundColor,color:button.color,border:button.borderTopWidth}:null,
          body:card.innerText,closedFileLocation:!!card.querySelector('.h59-file details:not([open])')};
      })()`);
        assert.equal(facts.width, width);
        assert.equal(facts.status, state);
        assert.equal(facts.overflow, false);
        assert.ok(facts.cardWidth <= 720);
        if (facts.primary) {
          assert.notEqual(facts.primary.background, facts.primary.color);
          assert.equal(facts.primary.border, "0px");
        }
        if (state === "completed") {
          assert.ok(facts.body.includes("经营周报.md"));
          assert.ok(!facts.body.includes("/Users/demo"));
          assert.equal(facts.closedFileLocation, true);
        }
        fs.writeFileSync(
          path.join(evidence, `card-${state}-${width}.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
        checks.push({ state, width, passed: true, facts });
      }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(evidence, "result.json"),
      JSON.stringify(
        {
          passed: true,
          evidenceLevel:
            "offscreen Electron fixtures; native interaction pending unlock",
          checks,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      `HEMI059_VISUAL_FIXTURE_RESULT=${JSON.stringify({ passed: true, checks: checks.length, errors })}`,
    );
    win.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, "result.json"),
      JSON.stringify(
        { passed: false, checks, errors, error: error.stack },
        null,
        2,
      ),
    );
    console.error(error);
    win?.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(1);
  }
});
