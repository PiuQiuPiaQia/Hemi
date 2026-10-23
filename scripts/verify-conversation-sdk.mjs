// Built standalone UI, no app globals, no server, no Bot/model credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
const html = path.resolve(
  process.env.HEMI_SDK_STANDALONE_PATH ??
    "examples/conversation-flow/dist/standalone.html",
);
const evidence = path.resolve(
  ".visual/workflow/vision/conversation-sdk/standalone",
);
fs.mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.HEMI_CHROME_EXECUTABLE ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const report = { checks: [], errors: [], requests: [], screenshots: [] };
const check = (name) => {
  report.checks.push(name);
  console.log("PASS " + name);
};
const open = async (options = {}, query = "") => {
  const page = await browser.newPage(options);
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (request) => {
    if (!/^(file:|data:|blob:)/.test(request.url()))
      report.requests.push(request.url());
  });
  await page.goto(pathToFileURL(html).href + query);
  await page.locator("[data-hemi-conversation-flow]").first().waitFor();
  return page;
};
try {
  const page = await open({ viewport: { width: 1440, height: 900 } });
  assert.equal(await page.evaluate(() => typeof window.hemiVoice), "undefined");
  for (const width of [320, 375, 390, 768, 1180, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "定位表单", exact: true }).click();
    await page
      .getByRole("textbox", { name: "反馈意见", exact: true })
      .waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const name = `layout-${width}.png`;
    await page.screenshot({ path: path.join(evidence, name) });
    report.screenshots.push(name);
  }
  check("320/375/390/768/1180/1440 独立页面无横溢，无应用全局或外部请求");
  await page
    .locator('[data-slot="scroll-area-viewport"]')
    .evaluate((el) => el.scrollTo({ top: 0 }));
  await page.getByRole("button", { name: "编辑这条消息", exact: true }).click();
  await page
    .getByRole("textbox", { name: "编辑消息", exact: true })
    .fill("离线编辑已经交给宿主处理。");
  await page.getByRole("button", { name: "重新发送", exact: true }).click();
  await page.getByText("离线编辑已经交给宿主处理。", { exact: true }).waitFor();
  check("原位编辑通过 action 回调更新受控消息");
  await page
    .getByRole("button", { name: "前插 150 条历史", exact: true })
    .click();
  assert.equal(
    await page
      .locator("[data-virtual-total]")
      .getAttribute("data-virtual-total"),
    "154",
  );
  assert.ok((await page.locator("[data-virtual-row]").count()) < 50);
  await page.getByRole("button", { name: "定位表单", exact: true }).click();
  await page.getByRole("textbox", { name: "反馈意见", exact: true }).waitFor();
  check("150 条历史仍使用虚拟列表并能定位已加载表单");
  await page.close();

  const delayed = await open(
    { viewport: { width: 768, height: 900 } },
    "?delay=1200",
  );
  const field = delayed.getByRole("textbox", { name: "反馈意见", exact: true });
  await field.fill("第一份意见");
  // Let the real debounce start saving, then change values and submit while that save is in flight.
  await delayed.waitForFunction(
    () =>
      document.querySelector("[data-demo-status]")?.textContent ===
      "宿主收到：workflow.save-draft",
  );
  await field.fill("最后确认的意见");
  await delayed.locator(".h59-hi-actions button").first().click();
  await delayed
    .getByTestId("workflow-interaction-record")
    .getByText("最后确认的意见", { exact: true })
    .waitFor();
  assert.equal(
    await delayed.getByTestId("workflow-interaction-record").count(),
    1,
  );
  check("自动保存进行中再次修改并提交，使用最新值和串行确认的 revision");
  await delayed.close();

  const mobile = await open({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await mobile
    .locator('[data-slot="scroll-area-viewport"]')
    .evaluate((el) => el.scrollTo({ top: 0 }));
  const copy = mobile.getByRole("button", {
    name: "复制这条消息",
    exact: true,
  });
  await copy.waitFor();
  await mobile.waitForFunction(() => {
    const el=document.querySelector('[aria-label="复制这条消息"]');
    return el && getComputedStyle(el.parentElement).opacity === '1' && el.getBoundingClientRect().height >= 44;
  });
  await copy.click();
  await mobile.locator(".h37-toast").waitFor();
  assert.equal(
    await mobile
      .locator("[data-hemi-conversation-flow] .hcf-portals .h37-toast")
      .count(),
    1,
  );
  const image = mobile.locator(".h62-deliverable-thumbnail img").first();
  await image.scrollIntoViewIfNeeded();
  await mobile.waitForFunction(() => {
    const img = document.querySelector(".h62-deliverable-thumbnail img");
    return img?.complete && img.naturalWidth > 0;
  });
  const stable = await image.elementHandle();
  await mobile.waitForTimeout(1100);
  assert.equal(await stable.evaluate((el) => el.isConnected), true);
  const more = mobile.getByRole("button", {
    name: "更多操作：结果预览.png",
    exact: true,
  });
  await more.click();
  await mobile.getByRole("menuitem", { name: "保存文件", exact: true }).click();
  await mobile.waitForFunction(
    () =>
      document.querySelector("[data-demo-status]")?.textContent ===
      "宿主收到文件操作：save",
  );
  check(
    "触屏操作无需 hover、目标至少 44px，文件菜单与复制反馈在实例 portal 内；计时不重挂静态图片",
  );
  await mobile.close();

  const pair = await open(
    { viewport: { width: 1440, height: 900 } },
    "?instances=2",
  );
  const hosts = pair.locator("main");
  assert.equal(await hosts.count(), 2);
  await hosts
    .nth(0)
    .getByRole("button", { name: "定位表单", exact: true })
    .click();
  await hosts
    .nth(1)
    .getByRole("button", { name: "定位表单", exact: true })
    .click();
  await hosts
    .nth(0)
    .getByRole("textbox", { name: "反馈意见", exact: true })
    .fill("本机意见");
  assert.equal(
    await hosts
      .nth(1)
      .getByRole("textbox", { name: "反馈意见", exact: true })
      .inputValue(),
    "",
  );
  await hosts
    .nth(0)
    .getByRole("radio", { name: "方案 A", exact: true })
    .check();
  await hosts
    .nth(1)
    .getByRole("radio", { name: "方案 B", exact: true })
    .check();
  assert.equal(
    await hosts
      .nth(0)
      .getByRole("radio", { name: "方案 A", exact: true })
      .isChecked(),
    true,
  );
  await hosts
    .nth(0)
    .getByRole("button", { name: "切换代次", exact: true })
    .click();
  assert.equal(
    await hosts
      .nth(0)
      .getByRole("textbox", { name: "反馈意见", exact: true })
      .inputValue(),
    "",
  );
  check("两个环境共享消息 ID 时表单状态隔离；切换代次清理局部状态");
  await pair.close();
  const permission = await open(
    { viewport: { width: 390, height: 844 } },
    "?permission=active",
  );
  await permission
    .getByRole("button", { name: "允许这次", exact: true })
    .click();
  await permission
    .getByRole("dialog", { name: "操作授权请求", exact: true })
    .waitFor({ state: "hidden" });
  await permission.close();
  const expired = await open(
    { viewport: { width: 390, height: 844 } },
    "?permission=expired",
  );
  assert.equal(
    await expired
      .getByRole("button", { name: "允许这次", exact: true })
      .isDisabled(),
    true,
  );
  await expired.close();
  const readonly = await open(
    { viewport: { width: 768, height: 900 } },
    "?readonly=1",
  );
  assert.equal(
    await readonly
      .getByRole("textbox", { name: "反馈意见", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await readonly
      .getByRole("button", { name: "复制这条消息", exact: true })
      .isDisabled(),
    true,
  );
  await readonly.close();
  check("确认卡经 action 回传后撤下；超时确认和只读表单明确禁用");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.requests, []);
  check("全部过程没有浏览器报错或意外网络请求");
} finally {
  fs.writeFileSync(
    path.join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
